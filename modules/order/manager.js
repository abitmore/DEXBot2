/**
 * OrderManager - Core grid-based order management system for DEXBot2
 * 
 * This module is responsible for:
 * - Maintaining the virtual order grid state (Map of orders + indices)
 * - Coordinating between specialized engines:
 *   - Accountant (accounting.js): Fund tracking and fee management
 *   - StrategyEngine (strategy.js): Grid rebalancing and anchoring
 *   - SyncEngine (sync_engine.js): Blockchain reconciliation
 */

const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL } = require('../constants');
const { 
    calculatePriceTolerance, 
    findMatchingGridOrderByOpenOrder, 
    calculateAvailableFundsValue, 
    getMinOrderSize,
    getAssetFees,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValue
} = require('./utils');
const Logger = require('./logger');
const AsyncLock = require('./async_lock');
const Accountant = require('./accounting');
const StrategyEngine = require('./strategy');
const SyncEngine = require('./sync_engine');

class OrderManager {
    /**
     * Create a new OrderManager instance
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        this.logger = new Logger(LOG_LEVEL);
        this.logger.marketName = this.marketName;
        this.orders = new Map();
        
        // Specialized Engines
        this.accountant = new Accountant(this);
        this.strategy = new StrategyEngine(this);
        this.sync = new SyncEngine(this);

        // Indices for fast lookup
        this._ordersByState = {
            [ORDER_STATES.VIRTUAL]: new Set(),
            [ORDER_STATES.ACTIVE]: new Set(),
            [ORDER_STATES.PARTIAL]: new Set()
        };
        this._ordersByType = {
            [ORDER_TYPES.BUY]: new Set(),
            [ORDER_TYPES.SELL]: new Set(),
            [ORDER_TYPES.SPREAD]: new Set()
        };
        this.resetFunds();
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = false;
        this.assets = null;
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        this.ordersNeedingPriceCorrection = [];
        this.ordersPendingCancellation = [];
        this.shadowOrderIds = new Map();
        this._correctionsLock = new AsyncLock();
        this._recentlyRotatedOrderIds = new Set();
        this._gridSidesUpdated = [];
    }

    // --- Accounting Delegation ---
    resetFunds() { return this.accountant.resetFunds(); }
    recalculateFunds() { return this.accountant.recalculateFunds(); }
    _deductFromChainFree(type, size, op) { return this.accountant.deductFromChainFree(type, size, op); }
    _addToChainFree(type, size, op) { return this.accountant.addToChainFree(type, size, op); }
    _updateOptimisticFreeBalance(oldO, newO, ctx, fee) { return this.accountant.updateOptimisticFreeBalance(oldO, newO, ctx, fee); }
    async deductBtsFees(side) { return await this.accountant.deductBtsFees(side); }
    _adjustFunds(order, delta) { return this.accountant.adjustFunds(order, delta); }

    // --- Strategy Delegation ---
    async rebalanceOrders(fCounts, extra, excl) { return await this.strategy.rebalanceOrders(fCounts, extra, excl); }
    async _rebalanceSideAfterFill(fType, oType, fCount, extra, excl) { return await this.strategy.rebalanceSideAfterFill(fType, oType, fCount, extra, excl); }
    async processFilledOrders(orders, excl) { return await this.strategy.processFilledOrders(orders, excl); }
    async activateClosestVirtualOrdersForPlacement(type, count, excl) { return await this.strategy.activateClosestVirtualOrdersForPlacement(type, count, excl); }
    async prepareFurthestOrdersForRotation(type, count, excl, fCount, opt) { return await this.strategy.prepareFurthestOrdersForRotation(type, count, excl, fCount, opt); }
    completeOrderRotation(oldInfo) { return this.strategy.completeOrderRotation(oldInfo); }
    _evaluatePartialOrderAnchor(p, move) { return this.strategy.evaluatePartialOrderAnchor(p, move); }
    preparePartialOrderMove(p, dist, excl) { return this.strategy.preparePartialOrderMove(p, dist, excl); }
    completePartialOrderMove(move) { return this.strategy.completePartialOrderMove(move); }
    async activateSpreadOrders(type, count) { return await this.strategy.activateSpreadOrders(type, count); }

    // --- Sync Delegation ---
    syncFromOpenOrders(orders, info) { return this.sync.syncFromOpenOrders(orders, info); }
    syncFromFillHistory(op) { return this.sync.syncFromFillHistory(op); }
    async synchronizeWithChain(data, src) { return await this.sync.synchronizeWithChain(data, src); }
    async _fetchAccountBalancesAndSetTotals() { return await this.sync.fetchAccountBalancesAndSetTotals(); }
    async _initializeAssets() { return await this.sync.initializeAssets(); }

    // --- Controller Logic ---

    _resolveConfigValue(value, total) {
        const resolved = resolveConfigValue(value, total);
        if (resolved === 0 && typeof value === 'string' && value.trim().endsWith('%')) {
            if (total === null || total === undefined) {
                if (!this._isFetchingTotals) {
                    this._isFetchingTotals = true;
                    this._fetchAccountBalancesAndSetTotals().finally(() => { this._isFetchingTotals = false; });
                }
            }
        }
        return resolved;
    }

    getChainFundsSnapshot() {
        const totals = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = Number.isFinite(Number(this.funds?.allocated?.buy)) ? Number(this.funds.allocated.buy) : totals.chainTotalBuy;
        const allocatedSell = Number.isFinite(Number(this.funds?.allocated?.sell)) ? Number(this.funds.allocated.sell) : totals.chainTotalSell;
        return { ...totals, allocatedBuy, allocatedSell };
    }

    lockOrders(orderIds) {
        if (!orderIds) return;
        const now = Date.now();
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, now);
        this._cleanExpiredLocks();
    }

    unlockOrders(orderIds) {
        if (!orderIds) return;
        for (const id of orderIds) if (id) this.shadowOrderIds.delete(id);
        this._cleanExpiredLocks();
    }

    _cleanExpiredLocks() {
        const now = Date.now();
        for (const [id, timestamp] of this.shadowOrderIds) {
            if (now - timestamp > TIMING.LOCK_TIMEOUT_MS) this.shadowOrderIds.delete(id);
        }
    }

    isOrderLocked(id) {
        if (!id || !this.shadowOrderIds.has(id)) return false;
        if (Date.now() - this.shadowOrderIds.get(id) > TIMING.LOCK_TIMEOUT_MS) {
            this.shadowOrderIds.delete(id);
            return false;
        }
        return true;
    }

    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;
        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = this._resolveConfigValue(this.config.botFunds.buy, chainTotalBuy);
        const allocatedSell = this._resolveConfigValue(this.config.botFunds.sell, chainTotalSell);
        this.funds.allocated = { buy: allocatedBuy, sell: allocatedSell };
        if (allocatedBuy > 0) this.funds.available.buy = Math.min(this.funds.available.buy, allocatedBuy);
        if (allocatedSell > 0) this.funds.available.sell = Math.min(this.funds.available.sell, allocatedSell);
    }

    setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        this.accountTotals = { ...this.accountTotals, ...totals };
        if (!this.funds) this.resetFunds();
        this.recalculateFunds();
        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try { this._accountTotalsResolve(); } catch (e) { }
            this._accountTotalsPromise = null; this._accountTotalsResolve = null;
        }
    }

    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, false)) return;
        if (!this._accountTotalsPromise) this._accountTotalsPromise = new Promise((resolve) => { this._accountTotalsResolve = resolve; });
        await Promise.race([this._accountTotalsPromise, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
    }

    async fetchAccountTotals(accountId) {
        if (accountId) this.accountId = accountId;
        await this._fetchAccountBalancesAndSetTotals();
    }

    _updateOrder(order) {
        if (order.id === undefined || order.id === null) return;
        const existing = this.orders.get(order.id);
        if (existing) {
            this._ordersByState[existing.state]?.delete(order.id);
            this._ordersByType[existing.type]?.delete(order.id);
        }
        this._ordersByState[order.state]?.add(order.id);
        this._ordersByType[order.type]?.add(order.id);
        this.orders.set(order.id, order);
        this.recalculateFunds();
    }

    _logAvailable(label = '') {
        const avail = this.funds?.available || { buy: 0, sell: 0 };
        const cache = this.funds?.cacheFunds || { buy: 0, sell: 0 };
        this.logger.log(`Available [\${label}]: buy=\${(avail.buy || 0).toFixed(8)}, sell=\${(avail.sell || 0).toFixed(8)}, cacheFunds buy=\${(cache.buy || 0).toFixed(8)}, sell=\${(cache.sell || 0).toFixed(8)}`, 'info');
    }

    getInitialOrdersToActivate() {
        const sellCount = Math.max(0, Number(this.config.activeOrders?.sell || 1));
        const buyCount = Math.max(0, Number(this.config.activeOrders?.buy || 1));
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        const vSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL).sort((a, b) => a.price - b.price).slice(0, sellCount);
        const validSells = vSells.filter(o => o.size >= minSellSize).sort((a, b) => b.price - a.price);

        const vBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL).sort((a, b) => b.price - a.price).slice(0, buyCount);
        const validBuys = vBuys.filter(o => o.size >= minBuySize).sort((a, b) => a.price - b.price);

        return [...validSells, ...validBuys];
    }

    getOrdersByTypeAndState(type, state) {
        if (state !== null && type !== null) {
            const stateIds = this._ordersByState[state] || new Set();
            const typeIds = this._ordersByType[type] || new Set();
            return [...stateIds].filter(id => typeIds.has(id)).map(id => this.orders.get(id)).filter(Boolean);
        } else if (state !== null) {
            return [...(this._ordersByState[state] || [])].map(id => this.orders.get(id)).filter(Boolean);
        } else if (type !== null) {
            return [...(this._ordersByType[type] || [])].map(id => this.orders.get(id)).filter(Boolean);
        }
        return Array.from(this.orders.values());
    }

    getPartialOrdersOnSide(type) {
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter(o => !this.isOrderLocked(o.id) && !this.isOrderLocked(o.orderId));
    }

    async fetchOrderUpdates(options = { calculate: false }) {
        try {
            const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
            if (activeOrders.length === 0 || (options && options.calculate)) {
                const { remaining, filled } = await this.calculateOrderUpdates();
                remaining.forEach(o => this.orders.set(o.id, o));
                if (filled.length > 0) await this.processFilledOrders(filled);
                return { remaining, filled };
            }
            return { remaining: activeOrders, filled: [] };
        } catch (e) {
            this.logger.log(`Error fetching order updates: \${e.message}`, 'error');
            return { remaining: [], filled: [] };
        }
    }

    async calculateOrderUpdates() {
        const active = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
        const start = this.config.startPrice;
        const sells = active.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => Math.abs(a.price - start) - Math.abs(b.price - start));
        const buys = active.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => Math.abs(a.price - start) - Math.abs(b.price - start));
        const filled = [];
        if (sells.length > 0) filled.push({ ...sells[0] });
        else if (buys.length > 0) filled.push({ ...buys[0] });
        return { remaining: active.filter(o => !filled.some(f => f.id === o.id)), filled };
    }

    async checkSpreadCondition(BitShares, batchCb) {
        const Grid = require('./grid');
        return await Grid.checkSpreadCondition(this, BitShares, batchCb);
    }

    async checkGridHealth(batchCb) {
        const Grid = require('./grid');
        return await Grid.checkGridHealth(this, batchCb);
    }

    calculateCurrentSpread() {
        const Grid = require('./grid');
        return Grid.calculateCurrentSpread(this);
    }

    async _persistCacheFunds() {
        return await this._persistWithRetry(() => this.accountOrders.updateCacheFunds(this.config.botKey, this.funds.cacheFunds), `cacheFunds`, { ...this.funds.cacheFunds });
    }

    async _persistBtsFeesOwed() {
        return await this._persistWithRetry(() => this.accountOrders.updateBtsFeesOwed(this.config.botKey, this.funds.btsFeesOwed), `BTS fees owed`, this.funds.btsFeesOwed);
    }
}

module.exports = { OrderManager };