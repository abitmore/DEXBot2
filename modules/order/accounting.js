/**
 * modules/order/accounting.js
 *
 * Specialized engine for financial state and fund tracking.
 * Responsible for calculating available funds, committed capital,
 * and managing BTS blockchain fees.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../constants');
const {
    computeChainFundTotals,
    calculateAvailableFundsValue,
    getAssetFees,
    blockchainToFloat
} = require('./utils');
const Format = require('./format');

/**
 * Accountant engine - Specialized handler for fund tracking and calculations
 * @typedef {Object} Accountant
 */
class Accountant {
    /**
     * Create a new Accountant instance
     *
     * @param {Object} manager - OrderManager instance
     * @param {Map<string, Object>} manager.orders - Orders map
     * @param {Object} manager.accountTotals - Blockchain account balances
     * @param {Object} manager.funds - Fund tracking structure
     * @param {Logger} manager.logger - Logger instance
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Initialize the funds structure with zeroed values.
     *
     * @returns {void}
     */
    resetFunds() {
        const mgr = this.manager;
        mgr.accountTotals = mgr.accountTotals || (mgr.config.accountTotals ? { ...mgr.config.accountTotals } : { buy: null, sell: null, buyFree: null, sellFree: null });

        mgr.funds = {
            available: { buy: 0, sell: 0 },
            total: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            virtual: { buy: 0, sell: 0 },
            committed: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            cacheFunds: { buy: 0, sell: 0 },       // Surplus from rotation + fill proceeds
            btsFeesOwed: 0                         // Unpaid BTS fees (deducted from cache)
        };
    }

    /**
     * Recalculate all fund values based on current order states.
     * This is THE MASTER FUND CALCULATION and must be called after any state change.
     * Called automatically by _updateOrder(), but can be manually triggered to verify consistency.
     *
     * @returns {void}
     */
    recalculateFunds() {
        const mgr = this.manager;
        if (!mgr.funds) this.resetFunds();

        let gridBuy = 0, gridSell = 0;
        let chainBuy = 0, chainSell = 0;
        let virtualBuy = 0, virtualSell = 0;

        // AUTO-SYNC SPREAD COUNT
        mgr.currentSpreadCount = mgr._ordersByType[ORDER_TYPES.SPREAD]?.size || 0;

        for (const order of Array.from(mgr.orders.values())) {
            const isActive = (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL);
            const isVirtual = (order.state === ORDER_STATES.VIRTUAL);
            const size = Number(order.size) || 0;
            if (size <= 0) continue;

            const hasOrderId = !!order.orderId;

            if (order.type === ORDER_TYPES.BUY) {
                gridBuy += size;
                if (isActive && hasOrderId) chainBuy += size;
                if (isVirtual || (isActive && !hasOrderId)) virtualBuy += size;
            } else if (order.type === ORDER_TYPES.SELL) {
                gridSell += size;
                if (isActive && hasOrderId) chainSell += size;
                if (isVirtual || (isActive && !hasOrderId)) virtualSell += size;
            }
        }

        const chainFreeBuy = mgr.accountTotals?.buyFree || 0;
        const chainFreeSell = mgr.accountTotals?.sellFree || 0;

        mgr.funds.committed.grid = { buy: gridBuy, sell: gridSell };
        mgr.funds.committed.chain = { buy: chainBuy, sell: chainSell };
        mgr.funds.virtual = { buy: virtualBuy, sell: virtualSell };

        const chainTotalBuy = chainFreeBuy + chainBuy;
        const chainTotalSell = chainFreeSell + chainSell;

        mgr.funds.total.chain = { buy: chainTotalBuy, sell: chainTotalSell };
        mgr.funds.total.grid = { buy: gridBuy + virtualBuy, sell: gridSell + virtualSell };

        mgr.funds.available.buy = calculateAvailableFundsValue('buy', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
        mgr.funds.available.sell = calculateAvailableFundsValue('sell', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);

        if (mgr.logger && mgr.logger.level === 'debug' && mgr._pauseFundRecalcDepth === 0 && (mgr._recalcLoggingDepth === 0 || mgr._recalcLoggingDepth === undefined)) {
            mgr.logger.log(`[RECALC] BUY: Total=${Format.formatAmount8(chainTotalBuy)} (Free=${Format.formatAmount8(chainFreeBuy)}, Grid=${Format.formatAmount8(gridBuy)})`, 'debug');
            mgr.logger.log(`[RECALC] SELL: Total=${Format.formatAmount8(chainTotalSell)} (Free=${Format.formatAmount8(chainFreeSell)}, Grid=${Format.formatAmount8(gridSell)})`, 'debug');
        }

        if (mgr._pauseFundRecalcDepth === 0 && !mgr.isBootstrapping) {
            this._verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell);
        }
    }

    /**
     * Verify critical fund tracking invariants.
     */
    _verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell) {
        const buyPrecision = mgr.assets?.assetB?.precision || 8;
        const sellPrecision = mgr.assets?.assetA?.precision || 8;
        const precisionSlackBuy = 2 * Math.pow(10, -buyPrecision);
        const precisionSlackSell = 2 * Math.pow(10, -sellPrecision);
        const PERCENT_TOLERANCE = (GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE || 0.1) / 100;

        // INVARIANT 1: Drift detection
        const expectedBuy = chainFreeBuy + chainBuy;
        const actualBuy = mgr.accountTotals?.buy ?? expectedBuy;
        const diffBuy = Math.abs(actualBuy - expectedBuy);
        const allowedBuyTolerance = Math.max(precisionSlackBuy, actualBuy * PERCENT_TOLERANCE);

        if (diffBuy > allowedBuyTolerance && mgr.accountTotals?.buy !== null) {
            mgr.logger?.log?.(`WARNING: Fund invariant violation (BUY): blockchainTotal (${Format.formatAmount8(actualBuy)}) != trackedTotal (${Format.formatAmount8(expectedBuy)}) (diff: ${Format.formatAmount8(diffBuy)}, allowed: ${Format.formatAmount8(allowedBuyTolerance)})`, 'warn');
        }

        const expectedSell = chainFreeSell + chainSell;
        const actualSell = mgr.accountTotals?.sell ?? expectedSell;
        const diffSell = Math.abs(actualSell - expectedSell);
        const allowedSellTolerance = Math.max(precisionSlackSell, actualSell * PERCENT_TOLERANCE);

        if (diffSell > allowedSellTolerance && mgr.accountTotals?.sell !== null) {
            mgr.logger?.log?.(`WARNING: Fund invariant violation (SELL): blockchainTotal (${Format.formatAmount8(actualSell)}) != trackedTotal (${Format.formatAmount8(expectedSell)}) (diff: ${Format.formatAmount8(diffSell)}, allowed: ${Format.formatAmount8(allowedSellTolerance)})`, 'warn');
        }

        // INVARIANT 2: Surplus check
        const cacheBuy = mgr.funds?.cacheFunds?.buy || 0;
        const cacheSell = mgr.funds?.cacheFunds?.sell || 0;
        if (cacheBuy > chainFreeBuy + allowedBuyTolerance) {
            mgr.logger?.log?.(`WARNING: Surplus over-estimation (BUY): cacheFunds (${Format.formatAmount8(cacheBuy)}) > chainFree (${Format.formatAmount8(chainFreeBuy)})`, 'warn');
        }
        if (cacheSell > chainFreeSell + allowedSellTolerance) {
            mgr.logger?.log?.(`WARNING: Surplus over-estimation (SELL): cacheFunds (${Format.formatAmount8(cacheSell)}) > chainFree (${Format.formatAmount8(chainFreeSell)})`, 'warn');
        }
    }

    /**
     * Check if sufficient funds exist AND atomically deduct (FREE portion only).
     */
    tryDeductFromChainFree(orderType, size, operation = 'move') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) return false;

        const current = Number(mgr.accountTotals[key]) || 0;
        if (current < size) {
            mgr.logger.log(`[chainFree] ${orderType} ${operation}: INSUFFICIENT FUNDS (have ${Format.formatAmount8(current)}, need ${Format.formatAmount8(size)})`, 'warn');
            return false;
        }

        const oldValue = mgr.accountTotals[key];
        mgr.accountTotals[key] = Math.max(0, current - size);

        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[ACCOUNTING] ${key} -${Format.formatAmount8(size)} (${operation}) -> ${Format.formatAmount8(mgr.accountTotals[key])} (was ${Format.formatAmount8(oldValue)})`, 'debug');
        }
        return true;
    }

    /**
     * Add an amount back to the optimistic chainFree balance (FREE portion only).
     */
    addToChainFree(orderType, size, operation = 'release') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) return false;

        const oldFree = Number(mgr.accountTotals[key]) || 0;
        mgr.accountTotals[key] = oldFree + size;

        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[ACCOUNTING] ${key} +${Format.formatAmount8(size)} (${operation}) -> ${Format.formatAmount8(mgr.accountTotals[key])} (was ${Format.formatAmount8(oldFree)})`, 'debug');
        }
        return true;
    }

    /**
     * Adjust both total and free balances (for fills, fees, deposits).
     */
    adjustTotalBalance(orderType, delta, operation) {
        const mgr = this.manager;
        const isBuy = (orderType === ORDER_TYPES.BUY);
        const freeKey = isBuy ? 'buyFree' : 'sellFree';
        const totalKey = isBuy ? 'buy' : 'sell';

        if (!mgr.accountTotals) return;

        const oldFree = Number(mgr.accountTotals[freeKey]) || 0;
        mgr.accountTotals[freeKey] = Math.max(0, oldFree + delta);

        if (mgr.accountTotals[totalKey] !== undefined && mgr.accountTotals[totalKey] !== null) {
            const oldTotal = Number(mgr.accountTotals[totalKey]) || 0;
            mgr.accountTotals[totalKey] = Math.max(0, oldTotal + delta);
        }

        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[ACCOUNTING] ${totalKey} ${delta >= 0 ? '+' : ''}${Format.formatAmount8(delta)} (${operation}) -> Total: ${Format.formatAmount8(mgr.accountTotals[totalKey])}, Free: ${Format.formatAmount8(mgr.accountTotals[freeKey])}`, 'debug');
        }
    }

    /**
     * Update optimistic balance during transitions.
     * CRITICAL: Use isActive state (ACTIVE/PARTIAL) to determine COMMITMENT, NOT orderId.
     * Using orderId for commitment causes double-deduction when an order is placed on-chain (receives orderId).
     *
     * HOWEVER: Fee deduction MUST use orderId check to prevent double-deduction.
     * Fees should only be charged when order is PLACED on-chain (receives orderId).
     */
    updateOptimisticFreeBalance(oldOrder, newOrder, context, fee = 0) {
        const mgr = this.manager;
        if (!oldOrder || !newOrder) return;

        const oldIsActive = (oldOrder.state === ORDER_STATES.ACTIVE || oldOrder.state === ORDER_STATES.PARTIAL);
        const newIsActive = (newOrder.state === ORDER_STATES.ACTIVE || newOrder.state === ORDER_STATES.PARTIAL);
        const oldSize = Number(oldOrder.size) || 0;
        const newSize = Number(newOrder.size) || 0;

        // For COMMITMENT: Use GRID state (isActive), not blockchain ID
        const oldGridCommitted = oldIsActive ? oldSize : 0;
        const newGridCommitted = newIsActive ? newSize : 0;
        const commitmentDelta = newGridCommitted - oldGridCommitted;

        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[ACCOUNTING] updateOptimisticFreeBalance: id=${newOrder.id}, type=${newOrder.type}, state=${oldOrder.state}->${newOrder.state}, size=${oldSize}->${newSize}, delta=${Format.formatAmount8(commitmentDelta)}, context=${context}`, 'debug');
        }

        // For FEE deduction: Must check if order is being PLACED on-chain (receives orderId)
        const oldOnChain = oldIsActive && !!oldOrder.orderId;
        const newOnChain = newIsActive && !!newOrder.orderId;
        const isBecomingOnChain = newOnChain && !oldOnChain;

        const btsSide = (mgr.config?.assetA === 'BTS') ? 'sell' : (mgr.config?.assetB === 'BTS') ? 'buy' : null;

        // 1. Handle Capital Commitment (Moves between FREE and LOCKED)
        if (commitmentDelta > 0) {
            this.tryDeductFromChainFree(newOrder.type, commitmentDelta, `${context}`);
        } else if (commitmentDelta < 0) {
            this.addToChainFree(oldOrder.type, Math.abs(commitmentDelta), `${context}`);
        }

        // 2. Handle Blockchain Fees (Physical reduction of TOTAL balance)
        // Deduct whenever a fee is provided, assuming caller only passes it for actual chain operations.
        if (fee > 0 && btsSide) {
            const btsOrderType = (btsSide === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
            this.adjustTotalBalance(btsOrderType, -fee, `${context}-fee`);
        }
    }

    /**
     * Deduct BTS fees using adjustTotalBalance.
     *
     * Strategy: Accumulate fees in btsFeesOwed, then settle when sufficient funds available.
     * - Fees are part of chainFree (not separate capital)
     * - Full fee amount must reduce chainFree
     * - Cache is drawn down first, then base capital
     * - Defers settlement if insufficient funds (will retry when funds become available)
     */
    async deductBtsFees(requestedSide = null) {
        const mgr = this.manager;

        // Early returns for no work needed
        if (!mgr.funds || !mgr.funds.btsFeesOwed || mgr.funds.btsFeesOwed <= 0) return;
        if (!mgr.accountTotals) return;

        const btsSide = (mgr.config.assetA === 'BTS') ? 'sell' : (mgr.config.assetB === 'BTS') ? 'buy' : null;
        const side = requestedSide || btsSide;

        if (!side) return;

        const fees = mgr.funds.btsFeesOwed;
        const orderType = (side === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        const freeKey = (side === 'buy') ? 'buyFree' : 'sellFree';
        const chainFree = mgr.accountTotals[freeKey] || 0;

        // SUFFICIENCY CHECK: Defer if insufficient funds
        if (chainFree < fees) {
            if (mgr.logger && mgr.logger.level === 'debug') {
                mgr.logger.log(`[BTS-FEE] Deferring settlement: need ${Format.formatAmount8(fees)}, have ${Format.formatAmount8(chainFree)}`, 'debug');
            }
            return;
        }

        // SETTLEMENT: Deduct from cache first, then base capital
        const cache = mgr.funds.cacheFunds?.[side] || 0;
        const cacheDeduction = Math.min(fees, cache);

        if (cacheDeduction > 0) {
            await this.modifyCacheFunds(side, -cacheDeduction, 'bts-fee-settlement');
        }

        // FULL DEDUCTION from chainFree (cache is part of chainFree, so always deduct full amount)
        this.adjustTotalBalance(orderType, -fees, 'bts-fee-settlement');

        if (mgr.logger && mgr.logger.level === 'debug') {
            const baseCapitalDeduction = fees - cacheDeduction;
            mgr.logger.log(`[BTS-FEE] Settled: ${Format.formatAmount8(fees)} BTS (${Format.formatAmount8(cacheDeduction)} from cache, ${Format.formatAmount8(baseCapitalDeduction)} from base capital)`, 'debug');
        }

        // Reset fees after successful settlement
        mgr.funds.btsFeesOwed = 0;
    }

    async modifyCacheFunds(side, delta, operation = 'update') {
        const mgr = this.manager;
        if (!mgr.funds.cacheFunds) mgr.funds.cacheFunds = { buy: 0, sell: 0 };
        const oldValue = mgr.funds.cacheFunds[side] || 0;
        const newValue = Math.max(0, oldValue + delta);
        mgr.funds.cacheFunds[side] = newValue;
        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[CACHEFUNDS] ${side} ${delta >= 0 ? '+' : ''}${Format.formatAmount8(delta)} (${operation}) -> ${Format.formatAmount8(newValue)}`, 'debug');
        }
        return newValue;
    }

    /**
     * Process the fund impact of an order fill.
     * Atomically updates accountTotals to keep internal state in sync with blockchain.
     */
    processFillAccounting(fillOp) {
        const mgr = this.manager;
        const pays = fillOp.pays;
        const receives = fillOp.receives;

        const assetAId = mgr.assets?.assetA?.id;
        const assetBId = mgr.assets?.assetB?.id;

        const assetAPrecision = mgr.assets?.assetA?.precision;
        const assetBPrecision = mgr.assets?.assetB?.precision;

        if (assetAPrecision === undefined || assetBPrecision === undefined) return;

        // 1. Deduct PAYS amount from both TOTAL and FREE
        // Free balance adjustment is temporary; _updateOrder will release it 
        // back to Free once the order transitions to VIRTUAL/SPREAD.
        if (pays.asset_id === assetAId) {
            const amount = blockchainToFloat(pays.amount, assetAPrecision, true);
            this.adjustTotalBalance(ORDER_TYPES.SELL, -amount, 'fill-pays');
        } else if (pays.asset_id === assetBId) {
            const amount = blockchainToFloat(pays.amount, assetBPrecision, true);
            this.adjustTotalBalance(ORDER_TYPES.BUY, -amount, 'fill-pays');
        }

        // 2. Add RECEIVES amount to both TOTAL and FREE
        // Also add to cacheFunds for the rebalancer to use
        if (receives.asset_id === assetAId) {
            const amount = blockchainToFloat(receives.amount, assetAPrecision, true);
            this.adjustTotalBalance(ORDER_TYPES.SELL, amount, 'fill-receives');
            this.modifyCacheFunds('sell', amount, 'fill-proceeds');
        } else if (receives.asset_id === assetBId) {
            const amount = blockchainToFloat(receives.amount, assetBPrecision, true);
            this.adjustTotalBalance(ORDER_TYPES.BUY, amount, 'fill-receives');
            this.modifyCacheFunds('buy', amount, 'fill-proceeds');
        }
    }
}

module.exports = Accountant;
