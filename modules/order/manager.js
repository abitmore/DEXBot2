/**
 * OrderManager - Core grid-based order management system for DEXBot2
 * 
 * This module is responsible for:
 * - Creating and maintaining a virtual order grid across a price range
 * - Tracking order states (VIRTUAL -> ACTIVE -> back to VIRTUAL/SPREAD when filled)
 * - Synchronizing grid state with on-chain orders
 * - Managing funds allocation and commitment tracking
 * - Processing fills and rebalancing the grid
 * 
 * The order grid spans from minPrice to maxPrice with orders placed at
 * regular incrementPercent intervals. Orders near the market price form
 * the "spread" zone. When orders are filled, new orders are created on
 * the opposite side to maintain grid coverage.
 * 
 * FUND CALCULATION MODEL:
 * The manager tracks funds using a dual-source model (chain + grid):
 * 
 * Source data:
 * - chainFree (accountTotals.buyFree/sellFree): Free balance on chain (not locked in orders)
 * - virtuel: Sum of VIRTUAL order sizes (grid positions not yet placed on-chain)
 * - committed.grid: Sum of ACTIVE order sizes (internal grid tracking)
 * - committed.chain: Sum of ACTIVE orders that have an orderId (confirmed on-chain)
 * - cacheFunds: Unallocated funds waiting for rotation (includes fill proceeds)
 * 
 * Calculated values:
 * - available = max(0, chainFree - virtuel - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)
 * - total.chain = chainFree + committed.chain
 * - total.grid = committed.grid + virtuel
 * 
 * Fund flow lifecycle:
 * 1. Startup: chainFree fetched from chain, virtuel = sum of grid VIRTUAL orders
 * 2. Order placement (VIRTUAL → ACTIVE): virtuel decreases, committed increases
 * 3. Order fill: proceeds added directly to cacheFunds
 * 4. After rotation: cacheFunds updated to reflect leftovers (surplus)
 */
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL } = require('../constants');
const { parsePercentageString, blockchainToFloat, floatToBlockchainInt, resolveRelativePrice, calculatePriceTolerance, checkPriceWithinTolerance, parseChainOrder, findMatchingGridOrderByOpenOrder, findMatchingGridOrderByHistory, applyChainSizeToGridOrder, correctOrderPriceOnChain, getMinOrderSize, getAssetFees, computeChainFundTotals, calculateAvailableFundsValue, calculateSpreadFromOrders, resolveConfigValue, compareBlockchainSizes, filterOrdersByType, countOrdersByType, getPrecisionByOrderType, getPrecisionForSide, getPrecisionsForManager, calculateOrderSizes, formatOrderSize, convertToSpreadPlaceholder, getCacheFundsValue, getGridTotalValue, getTotalGridFundsAvailable, hasValidAccountTotals, getChainFreeKey } = require('./utils');
const Logger = require('./logger');
const AsyncLock = require('./async_lock');
const Accountant = require('./accounting');
const StrategyEngine = require('./strategy');

/**
 * OrderManager class - manages grid-based trading strategy
 * 
 * Key concepts:
 * - Virtual orders: Grid positions not yet placed on-chain (reserved in virtuel)
 * - Active orders: Orders placed on blockchain (tracked in committed.grid/chain)
 * - Filled orders: Orders that have been fully executed (converted to VIRTUAL/SPREAD placeholders)
 * - Spread orders: Placeholder orders in the zone around market price
 * 
 * Funds structure (this.funds):
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ available    = max(0, chainFree - virtuel - cacheFunds                │
 * │                     - applicableBtsFeesOwed - btsFeesReservation)      │
 * │               Free funds that can be used for new orders or rotations  │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ total.chain  = chainFree + committed.chain                             │
 * │               Total on-chain balance (free + locked in orders)         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ total.grid   = committed.grid + virtuel                                │
 * │               Total grid allocation (active + virtual orders)          │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ virtuel      = Sum of VIRTUAL order sizes                              │
 * │               Reserved funds for grid positions not yet on-chain       │
 * │               (alias: reserved for backwards compatibility)            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ committed.grid  = Sum of ACTIVE order sizes (internal tracking)        │
 * │ committed.chain = Sum of ACTIVE orders with orderId (on-chain)         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ cacheFunds   = Unallocated funds waiting for rotation (fill proceeds +  │
 * │               rounding surplus). Persisted per-bot.                    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ btsFeesOwed  = BTS blockchain fees from filled orders                  │
 * │               Only tracked if BTS is in the trading pair               │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * Fund lifecycle:
 * 1. Startup: chainFree from chain, virtuel from grid VIRTUAL orders
 * 2. Order placement (VIRTUAL → ACTIVE): virtuel↓, committed↑
 * 3. Order fill: proceeds added directly to cacheFunds
 * 4. Rotation complete: cacheFunds updated with any surplus
 * 
 * Price tolerance:
 * - Chain orders may have slightly different prices due to integer rounding
 * - Tolerance is calculated based on asset precisions and order sizes
 * - Orders within tolerance are considered matching
 * 
 * @class
 */
class OrderManager {
    /**
     * Create a new OrderManager instance
     * @param {Object} config - Bot configuration
     * @param {string|number} config.startPrice - Center price or 'pool'/'market' for auto-derive
     * @param {string|number} config.minPrice - Lower bound (number or '5x' relative)
     * @param {string|number} config.maxPrice - Upper bound (number or '5x' relative)
     * @param {number} config.incrementPercent - Price step between orders (e.g., 1 for 1%)
     * @param {number} config.targetSpreadPercent - Target spread width percentage
     * @param {Object} config.botFunds - Funds allocation { buy: amount/'%', sell: amount/'%' }
     * @param {Object} config.activeOrders - Max active orders { buy: n, sell: n }
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

        // Indices for fast lookup by state and type (optimization)
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
        this.assets = null; // To be populated in initializeGrid
        // Promise that resolves when accountTotals (both buy & sell) are populated.
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        // Orders that need price correction on blockchain (orderId matched but price outside tolerance)
        this.ordersNeedingPriceCorrection = [];
        // Orders marked for cancellation (surplus or outside grid range)
        this.ordersPendingCancellation = [];
        // Shadow map: tracks orderIds -> timestamp that are currently 'in-flight'.
        // This implements Optimistic Locking with Auto-Expiration.
        this.shadowOrderIds = new Map();
        // AsyncLock to prevent concurrent mutations to ordersNeedingPriceCorrection
        this._correctionsLock = new AsyncLock();
        // Track recently rotated orderIds to prevent double-rotation (cleared after successful rotation)
        this._recentlyRotatedOrderIds = new Set();
        // Track which order sides had their sizes updated by grid triggers
        this._gridSidesUpdated = [];
    }

    // Helper: Resolve config value (percentage, number, or string)
    // Handles async fetching of account totals if needed
    _resolveConfigValue(value, total) {
        const resolved = resolveConfigValue(value, total);

        // If resolution returned 0 and value was a percentage string, attempt async fetch
        if (resolved === 0 && typeof value === 'string' && value.trim().endsWith('%')) {
            if (total === null || total === undefined) {
                this.logger?.log(`Cannot resolve percentage-based botFunds '${value}' because account total is not set. Attempting on-chain lookup (will default to 0 while fetching).`, 'warn');
                // Kick off an async fetch of account balances if possible; do not block here.
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
        return {
            ...totals,
            allocatedBuy,
            allocatedSell
        };
    }

    // -------------------------------------------------------------------------
    // Helper Methods - Precision, Funds, ChainFree
    // -------------------------------------------------------------------------

    /**
     * Internal helper to deduct an amount from the optimistic chainFree balance.
     */
    _deductFromChainFree(orderType, size, operation = 'move') {
        return this.accountant.deductFromChainFree(orderType, size, operation);
    }

    // -------------------------------------------------------------------------
    // Order Locking (Shadowing) Methods
    // -------------------------------------------------------------------------

    /**
     * Lock a set of orders (by grid ID or chain ID) to prevent concurrent modification.
     * Locks automatically expire after 30 seconds if not explicitly unlocked.
     * @param {Set|Array} orderIds - Set or Array of IDs to lock
     */
    lockOrders(orderIds) {
        if (!orderIds) return;
        let count = 0;
        const now = Date.now();
        for (const id of orderIds) {
            if (id) {
                this.shadowOrderIds.set(id, now);
                count++;
            }
        }
        if (count > 0) this.logger.log(`Shadow locked ${count} orders. Total locked: ${this.shadowOrderIds.size}`, 'debug');

        // Opportunistically clean expired locks while setting new ones
        this._cleanExpiredLocks();
    }

    /**
     * Unlock a set of orders.
     * Also performs opportunistic cleanup of expired locks.
     * @param {Set|Array} orderIds - Set or Array of IDs to unlock
     */
    unlockOrders(orderIds) {
        if (!orderIds) return;
        let count = 0;
        for (const id of orderIds) {
            if (id && this.shadowOrderIds.has(id)) {
                this.shadowOrderIds.delete(id);
                count++;
            }
        }
        // Cleanup expired locks opportunistically
        this._cleanExpiredLocks();

        if (count > 0) this.logger.log(`Shadow unlocked ${count} orders. Total locked: ${this.shadowOrderIds.size}`, 'debug');
    }

    /**
     * Internal helper to clean up expired locks.
     * Locks expire after TIMING.LOCK_TIMEOUT_MS to handle long-running blockchain transactions.
     * @private
     */
    _cleanExpiredLocks() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [id, timestamp] of this.shadowOrderIds) {
            if (now - timestamp > TIMING.LOCK_TIMEOUT_MS) {
                this.shadowOrderIds.delete(id);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            // Use warn level if many locks expired (potential issue), otherwise debug
            const logLevel = cleanedCount > 5 ? 'warn' : 'debug';
            this.logger.log(`Expired ${cleanedCount} lock(s) after ${TIMING.LOCK_TIMEOUT_MS}ms. Remaining: ${this.shadowOrderIds.size}`, logLevel);
        }
    }

    /**
     * Check if an order is currently locked (shadowed).
     * Locks expire automatically after TIMING.LOCK_TIMEOUT_MS to handle long-running blockchain transactions.
     * @param {string} id - Grid ID or Chain Order ID
     * @returns {boolean} True if locked and valid (not expired)
     */
    isOrderLocked(id) {
        if (!id || !this.shadowOrderIds.has(id)) return false;

        const timestamp = this.shadowOrderIds.get(id);
        if (Date.now() - timestamp > TIMING.LOCK_TIMEOUT_MS) {
            // Expired lock - clean it up
            this.shadowOrderIds.delete(id);
            return false;
        }
        return true;
    }

    /**
     * Internal helper to add an amount back to the optimistic chainFree balance.
     */
    _addToChainFree(orderType, size, operation = 'release') {
        return this.accountant.addToChainFree(orderType, size, operation);
    }

    /**
     * Update optimistic free balance during order state transitions.
     */
    _updateOptimisticFreeBalance(oldOrder, newOrder, context, fee = 0) {
        return this.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, context, fee);
    }

    /**
     * Apply botFunds allocation constraints to available funds.
     * Called at grid initialization to respect percentage-based botFunds when multiple bots share an account.
     *
     * This ensures:
     * - Bot1 with botFunds.buy="90%" gets 90% of chainFree (what's free on-chain)
     * - Bot2 with botFunds.buy="10%" gets 10% of remaining chainFree
     *
     * During trading, available funds are recalculated normally without this constraint
     * (available = chainFree - virtuel - cacheFunds - btsFeesOwed)
     */
    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;

        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);

        const allocatedBuy = this._resolveConfigValue(this.config.botFunds.buy, chainTotalBuy);
        const allocatedSell = this._resolveConfigValue(this.config.botFunds.sell, chainTotalSell);

        // Deduct BTS creation fees if BTS is in the trading pair
        let btsFeesForCreation = 0;
        const assetA = this.config.assetA;
        const assetB = this.config.assetB;
        const hasBtsPair = (assetA === 'BTS' || assetB === 'BTS');

        if (hasBtsPair) {
            try {
                const { getAssetFees } = require('./utils');
                const targetBuy = Math.max(0, Number.isFinite(Number(this.config.activeOrders?.buy)) ? Number(this.config.activeOrders.buy) : 1);
                const targetSell = Math.max(0, Number.isFinite(Number(this.config.activeOrders?.sell)) ? Number(this.config.activeOrders.sell) : 1);
                const totalOrdersToCreate = targetBuy + targetSell;

                if (totalOrdersToCreate > 0) {
                    const btsFeeData = getAssetFees('BTS', 1);
                    btsFeesForCreation = btsFeeData.createFee * totalOrdersToCreate;
                }
            } catch (err) {
                this.logger?.log?.(`Warning: Could not calculate BTS creation fees in applyBotFundsAllocation: ${err.message}`, 'warn');
            }
        }

        // Note: BTS fee deduction happens in Grid.updateGridOrderSizesForSide() during actual sizing
        // Do not deduct fees here to avoid double-counting
        let finalAllocatedBuy = allocatedBuy;
        let finalAllocatedSell = allocatedSell;

        // Expose allocation for grid sizing (and diagnostics)
        this.funds.allocated = { buy: finalAllocatedBuy, sell: finalAllocatedSell };

        // Cap available to not exceed allocation
        if (finalAllocatedBuy > 0) {
            this.funds.available.buy = Math.min(this.funds.available.buy, finalAllocatedBuy);
        }
        if (finalAllocatedSell > 0) {
            this.funds.available.sell = Math.min(this.funds.available.sell, finalAllocatedSell);
        }

        this.logger?.log(
            `Applied botFunds allocation (based on total): buy=${finalAllocatedBuy.toFixed(8)} (total=${chainTotalBuy.toFixed(8)}, available=${this.funds.available.buy.toFixed(8)}), ` +
            `sell=${finalAllocatedSell.toFixed(8)} (total=${chainTotalSell.toFixed(8)}, available=${this.funds.available.sell.toFixed(8)})`,
            'info'
        );
    }

    /**
     * Central calculation for available funds (pure calculation, no side effects).
     * Formula: available = max(0, chainFree - virtuel - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)
     *
     * The btsFeesReservation uses 4x multiplier and ensures sufficient BTS is reserved for:
     * - 1x: current operation fees
     * - 3x: buffer for multiple rotation cycles
     *
     * NOTE: This is a PURE calculation function - it does NOT modify any state.
     */
    /**
     * Accumulate and deduct BTS blockchain fees from cache funds.
     */
    async deductBtsFees(requestedSide = null) {
        return await this.accountant.deductBtsFees(requestedSide);
    }

    /**
     * Generic persistence wrapper with retry logic and exponential backoff.
     * Attempts to persist data up to maxAttempts times with exponential backoff.
     * On final failure, logs critical error but does NOT throw - allows processing to continue.
     * Flags persistenceWarning so bot can retry persistence later.
     *
     * @param {Function} persistFn - Function that performs the persistence (should throw on failure)
     * @param {string} dataType - Human-readable name of data type (e.g., 'cacheFunds', 'btsFeesOwed')
     * @param {*} dataValue - The value being persisted (for logging and warning flag)
     * @param {number} maxAttempts - Maximum retry attempts (default: 3)
     * @returns {Promise<boolean>} true if persistence succeeded, false if failed
     */
    async _persistWithRetry(persistFn, dataType, dataValue, maxAttempts = 3) {
        if (!this.config || !this.config.botKey || !this.accountOrders) {
            return true;  // Can't persist, but that's ok (e.g., dry run)
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await persistFn();  // Execute the async persistence function
                this.logger.log(`✓ Persisted ${dataType}`, 'debug');

                // Clear any previous persistence warning flag
                if (this._persistenceWarning) {
                    delete this._persistenceWarning;
                }
                return true;  // Success
            } catch (e) {
                if (attempt === maxAttempts) {
                    // All retries failed - don't throw, just flag the issue
                    this.logger.log(`CRITICAL: Failed to persist ${dataType} after ${attempt} attempts: ${e.message}. Data held in memory. Will retry on next cycle.`, 'error');

                    // Flag this issue so caller can know persistence is degraded
                    this._persistenceWarning = {
                        type: dataType,
                        error: e.message,
                        timestamp: Date.now(),
                        data: dataValue
                    };
                    return false;  // Signal failure to caller
                } else {
                    this.logger.log(`Failed to persist ${dataType} (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying...`, 'warn');
                    // Exponential backoff: 100ms, 200ms, 300ms for 3 attempts
                    const waitMs = attempt * 100;
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
            }
        }
    }

    /**
     * Persist cache funds to disk with retry logic.
     * Retries up to 3 times with exponential backoff on transient failures.
     * @returns {Promise<boolean>} true if persistence succeeded, false if failed
     */
    async _persistCacheFunds() {
        return await this._persistWithRetry(
            () => this.accountOrders.updateCacheFunds(this.config.botKey, this.funds.cacheFunds),
            `cacheFunds: Buy ${(this.funds.cacheFunds.buy || 0).toFixed(8)}, Sell ${(this.funds.cacheFunds.sell || 0).toFixed(8)}`,
            { ...this.funds.cacheFunds }
        );
    }

    /**
     * Persist BTS blockchain fees owed to disk with retry logic.
     * BTS fees accumulate during fill processing and must be persisted to prevent fund loss
     * if the bot crashes before rotation consumes the proceeds and fees.
     * Uses same retry pattern as _persistPendingProceeds with exponential backoff.
     * On final failure, logs critical error but does NOT throw - allows processing to continue.
     *
     * @returns {Promise<boolean>} true if persistence succeeded, false if failed
     */
    async _persistBtsFeesOwed() {
        return await this._persistWithRetry(
            () => this.accountOrders.updateBtsFeesOwed(this.config.botKey, this.funds.btsFeesOwed),
            `BTS fees owed: ${(this.funds.btsFeesOwed || 0).toFixed(8)} BTS`,
            this.funds.btsFeesOwed
        );
    }


    /**
     * Check if bot has any persistence warnings that need attention.
     * Can be used by monitoring/alerting systems.
     *
     * @returns {Object|null} Persistence warning info or null if none
     */
    getPersistenceWarning() {
        return this._persistenceWarning || null;
    }

    /**
     * Recalculate all fund values based on current order states.
     *
     * This method iterates all orders and computes:
     * - committed.grid: Sum of ACTIVE order sizes (internal tracking)
     * - committed.chain: Sum of ACTIVE orders with orderId (confirmed on-chain)
     * - virtuel: Sum of VIRTUAL order sizes (reserved for future placement)
     *
     * Then calculates derived values:
     * - available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed)
     * - total.chain = chainFree + committed.chain
     * - total.grid = committed.grid + virtuel
     *
     * Called automatically by _updateOrder() whenever order state changes.
     */
    /**
     * Recalculate all fund values based on current order states.
     */
    recalculateFunds() {
        return this.accountant.recalculateFunds();
    }

    _updateOrder(order) {
        // CRITICAL: Reject orders with null/undefined id to prevent grid corruption
        // This guards against bugs that create synthetic orders with invalid ids
        if (order.id === undefined || order.id === null) {
            this.logger?.log?.(
                `WARNING: Rejecting order update with invalid id (${order.id}). ` +
                `type=${order.type}, price=${order.price}, size=${order.size}, state=${order.state}`,
                'warn'
            );
            return;
        }

        const existing = this.orders.get(order.id);
        if (existing) {
            this._ordersByState[existing.state]?.delete(order.id);
            this._ordersByType[existing.type]?.delete(order.id);
        }
        this._ordersByState[order.state]?.add(order.id);
        this._ordersByType[order.type]?.add(order.id);
        this.orders.set(order.id, order);
        this.recalculateFunds(); // Sync funds whenever order state/size changes
    }

    _logAvailable(label = '') {
        if (!this.logger) return;
        const avail = this.funds?.available || { buy: 0, sell: 0 };
        const cache = this.funds?.cacheFunds || { buy: 0, sell: 0 };
        this.logger.log(
            `Available${label ? ' [' + label + ']' : ''}: buy=${(avail.buy || 0).toFixed(8)}, sell=${(avail.sell || 0).toFixed(8)}, cacheFunds buy=${(cache.buy || 0).toFixed(8)}, sell=${(cache.sell || 0).toFixed(8)}`,
            'info'
        );
    }

    // Adjust funds for partial fills detected via size deltas (applied before _updateOrder recalc)
    _adjustFunds(gridOrder, deltaSize) {
        return this.accountant.adjustFunds(gridOrder, deltaSize);
    }

    // Note: findBestMatchByPrice is available from utils; callers should pass
    // a tolerance function that includes the manager's assets, for example:
    // utils.findBestMatchByPrice(chainOrder, candidates, this.orders, (p,s,t) => calculatePriceTolerance(p,s,t,this.assets))

    // NOTE: _calcTolerance shim removed — callers should call
    // calculatePriceTolerance(gridPrice, orderSize, orderType, this.assets)

    /**
     * Initialize the funds structure with zeroed values.
     */
    resetFunds() {
        return this.accountant.resetFunds();
    }

    /**
     * Update on-chain balance information and recalculate funds.
     * Called when fetching balances from blockchain or after order changes.
     * 
     * @param {Object} totals - Balance information from chain
     * @param {number|null} totals.buy - Total buy asset balance (free + locked)
     * @param {number|null} totals.sell - Total sell asset balance (free + locked)
     * @param {number|null} totals.buyFree - Free buy asset balance (not in orders)
     * @param {number|null} totals.sellFree - Free sell asset balance (not in orders)
     */
    setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        this.accountTotals = { ...this.accountTotals, ...totals };

        if (!this.funds) this.resetFunds();

        // Recalculate with new chain data
        this.recalculateFunds();

        // If someone is waiting for account totals, resolve the waiter once both values are available.
        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try { this._accountTotalsResolve(); } catch (e) { /* ignore */ }
            this._accountTotalsPromise = null; this._accountTotalsResolve = null;
        }
    }

    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, false)) return; // already satisfied

        if (!this._accountTotalsPromise) {
            this._accountTotalsPromise = new Promise((resolve) => { this._accountTotalsResolve = resolve; });
        }

        await Promise.race([
            this._accountTotalsPromise,
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
    }

    /**
     * Public method to fetch and update account balances from the blockchain.
     * Called periodically by the blockchain fetch interval to keep funds up-to-date.
     *
     * @param {string|number} accountId - Optional account ID to fetch balances for.
     *                                     If provided, temporarily sets this.accountId.
     * @returns {Promise<void>}
     */
    async fetchAccountTotals(accountId) {
        if (accountId) {
            this.accountId = accountId;
        }
        await this._fetchAccountBalancesAndSetTotals();
    }

    async _fetchAccountBalancesAndSetTotals() {
        // Attempt to read balances from the chain for configured account.
        try {
            const { BitShares } = require('../bitshares_client');
            if (!BitShares || !BitShares.db) return;

            // We need an account id or name to query
            const accountIdOrName = this.accountId || this.account || null;
            if (!accountIdOrName) return;

            // Ensure assets are initialized so we have ids/precisions
            try { await this._initializeAssets(); } catch (err) { /* best-effort */ }
            const assetAId = this.assets && this.assets.assetA && this.assets.assetA.id;
            const assetBId = this.assets && this.assets.assetB && this.assets.assetB.id;
            const precisionA = this.assets && this.assets.assetA && this.assets.assetA.precision;
            const precisionB = this.assets && this.assets.assetB && this.assets.assetB.precision;

            if (!assetAId || !assetBId) return;

            // Use centralized helper to fetch on-chain balances for the two configured assets
            try {
                const { getOnChainAssetBalances } = require('../chain_orders');
                const lookup = await getOnChainAssetBalances(accountIdOrName, [assetAId, assetBId]);
                const aInfo = lookup && (lookup[assetAId] || lookup[this.config.assetA]);
                const bInfo = lookup && (lookup[assetBId] || lookup[this.config.assetB]);
                // Total = free + locked (in orders)
                const sellTotal = aInfo && typeof aInfo.total === 'number' ? aInfo.total : null;
                const buyTotal = bInfo && typeof bInfo.total === 'number' ? bInfo.total : null;
                // Free = available balance not in orders
                const sellFree = aInfo && typeof aInfo.free === 'number' ? aInfo.free : sellTotal;
                const buyFree = bInfo && typeof bInfo.free === 'number' ? bInfo.free : buyTotal;
                this.logger && this.logger.log && this.logger.log('Fetched on-chain balances for accountTotals (via helper)', 'info');
                this.setAccountTotals({ buy: buyTotal, sell: sellTotal, buyFree, sellFree });
            } catch (err) {
                // fall back to raw chain query in the unlikely event helper fails
                const full = await BitShares.db.get_full_accounts([accountIdOrName], false);
                if (!full || !Array.isArray(full) || !full[0]) return;
                const accountData = full[0][1];
                const balances = accountData && accountData.balances ? accountData.balances : [];

                const findBalanceInt = (assetId) => {
                    const b = balances.find(x => x.asset_type === assetId || x.asset_type === assetId.toString());
                    return b ? Number(b.balance || b.amount || 0) : 0;
                };

                const rawSell = findBalanceInt(assetAId);
                const rawBuy = findBalanceInt(assetBId);

                const buyTotal = Number.isFinite(Number(rawBuy)) ? blockchainToFloat(rawBuy, precisionB !== undefined ? precisionB : 8) : null;
                const sellTotal = Number.isFinite(Number(rawSell)) ? blockchainToFloat(rawSell, precisionA !== undefined ? precisionA : 8) : null;

                // In fallback mode, balance IS the free amount (no order breakdown available)
                this.logger && this.logger.log && this.logger.log('Fetched on-chain balances for accountTotals (fallback raw)', 'info');
                this.setAccountTotals({ buy: buyTotal, sell: sellTotal, buyFree: buyTotal, sellFree: sellTotal });
            }
        } catch (err) {
            this.logger && this.logger.log && this.logger.log(`Failed to fetch on-chain balances: ${err && err.message ? err.message : err}`, 'warn');
        }
    }

    async _initializeAssets() {
        if (this.assets) return; // Already initialized
        try {
            const { lookupAsset } = require('./utils');
            const { BitShares } = require('../bitshares_client');
            this.assets = {
                assetA: await lookupAsset(BitShares, this.config.assetA),
                assetB: await lookupAsset(BitShares, this.config.assetB)
            };
            if (!this.assets.assetA || !this.assets.assetB) {
                throw new Error(`Could not resolve assets ${this.config.assetA}/${this.config.assetB}`);
            }
        } catch (err) {
            this.logger.log(`Asset metadata lookup failed: ${err.message}`, 'error');
            throw err;
        }
    }

    /**
     * Sync grid orders from fresh blockchain open orders after a fill event.
     * This is the preferred way to handle fills:
     * 1. Fetch current open orders from blockchain
     * 2. Match grid orders to chain orders by orderId
     * 3. Check if price difference is within tolerance (based on asset precision)
     * 4. If orderId matches but price outside tolerance, flag for correction
     * 5. If orderId not found but price matches, update orderId (never update price)
     * 6. Update sizes from blockchain for_sale values
     * 7. Convert to VIRTUAL/SPREAD if they no longer exist on chain (filled)
     * 
     * @param {Array} chainOrders - Array of open orders from blockchain
     * @param {Object} fillInfo - Optional fill event info for logging (pays/receives amounts)
     * @returns {Object} - { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] }
     */
    syncFromOpenOrders(chainOrders, fillInfo = null) {
        if (!Array.isArray(chainOrders) || chainOrders.length === 0) {
            this.logger.log('syncFromOpenOrders: No valid chain orders provided', 'debug');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        this.logger.log(`syncFromOpenOrders: Processing ${chainOrders.length} open orders from blockchain`, 'debug');

        // DEBUG: Check assets
        if (this.assets) {
            this.logger.log(`DEBUG: Assets loaded: A=${this.assets.assetA?.symbol}(${this.assets.assetA?.id}), B=${this.assets.assetB?.symbol}(${this.assets.assetB?.id})`, 'debug');
        } else {
            this.logger.log(`DEBUG: ERROR - this.assets is missing!`, 'error');
        }

        // Cache asset precisions for hot paths
        const assetAPrecision = this.assets?.assetA?.precision;
        const assetBPrecision = this.assets?.assetB?.precision;

        // Parse all chain orders
        const parsedChainOrders = new Map();
        const rawChainOrders = new Map(); // Keep raw orders for correction
        let debugLogged = false;
        for (const chainOrder of chainOrders) {
            if (!debugLogged) {
                this.logger.log(`DEBUG: First chain order raw: ${JSON.stringify(chainOrder)}`, 'info');
                debugLogged = true;
            }
            const parsed = parseChainOrder(chainOrder, this.assets);
            if (parsed) {
                parsedChainOrders.set(parsed.orderId, parsed);
                rawChainOrders.set(parsed.orderId, chainOrder);
            } else {
                this.logger.log(`DEBUG: Failed to parse chain order ${chainOrder.id}`, 'warn');
            }
        }
        this.logger.log(`DEBUG: Parsed ${parsedChainOrders.size} valid chain orders.`, 'debug');

        const filledOrders = [];
        const updatedOrders = [];
        const ordersNeedingCorrection = [];
        const chainOrderIdsOnGrid = new Set();
        const matchedGridOrderIds = new Set();  // Track grid slots already matched to prevent reassignment

        // Clear previous correction and cancellation lists
        this.ordersNeedingPriceCorrection = [];
        this.ordersPendingCancellation = [];

        // First pass: Match by orderId and check price tolerance
        for (const gridOrder of this.orders.values()) {
            // allow matching virtual orders if they have an ID (e.g. loaded from persistence)
            if (!gridOrder.orderId) continue;

            const chainOrder = parsedChainOrders.get(gridOrder.orderId);

            if (chainOrder) {
                // Order still exists on chain - check price tolerance
                // Mark as ACTIVE now that we confirmed it's on chain
                gridOrder.state = ORDER_STATES.ACTIVE;
                matchedGridOrderIds.add(gridOrder.id);  // This grid slot is now claimed by this chain order

                const toleranceCheck = checkPriceWithinTolerance(gridOrder, chainOrder, this.assets);

                if (!toleranceCheck.isWithinTolerance) {
                    // Price difference exceeds tolerance - need to correct order on blockchain
                    this.logger.log(
                        `Order ${gridOrder.id} (${gridOrder.orderId}): PRICE MISMATCH - ` +
                        `grid=${toleranceCheck.gridPrice.toFixed(8)}, chain=${toleranceCheck.chainPrice.toFixed(8)}, ` +
                        `diff=${toleranceCheck.priceDiff.toFixed(8)}, tolerance=${toleranceCheck.tolerance.toFixed(8)}. ` +
                        `Flagging for correction.`,
                        'warn'
                    );

                    const correctionInfo = {
                        gridOrder: { ...gridOrder },
                        chainOrderId: gridOrder.orderId,
                        rawChainOrder: rawChainOrders.get(gridOrder.orderId),
                        expectedPrice: gridOrder.price,
                        actualPrice: chainOrder.price,
                        size: chainOrder.size || gridOrder.size,
                        type: gridOrder.type
                    };
                    ordersNeedingCorrection.push(correctionInfo);
                    this.ordersNeedingPriceCorrection.push(correctionInfo);
                    chainOrderIdsOnGrid.add(gridOrder.orderId);
                    // Don't update size yet - will be updated after correction
                    continue;
                }

                // Price within tolerance - update size if different
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                const oldSize = Number(gridOrder.size || 0);
                const newSize = Number(chainOrder.size || 0);

                // Compare using asset precision so we only treat on-chain-significant
                // size changes as different. Use the order-type to pick precision.
                const precision = getPrecisionByOrderType(this.assets, gridOrder.type);
                // Use integer equality to detect chain-significant size changes
                if (compareBlockchainSizes(oldSize, newSize, precision) !== 0) {
                    const fillAmount = oldSize - newSize;
                    this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}): size changed ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (filled: ${fillAmount.toFixed(8)})`, 'info');

                    // Create copy for update
                    const updatedOrder = { ...gridOrder };

                    // Convert new size to blockchain integer for comparison
                    const newInt = floatToBlockchainInt(newSize, precision);

                    if (newInt > 0) {
                        // Partially filled - has remainder, transition to PARTIAL state
                        applyChainSizeToGridOrder(this, updatedOrder, newSize);
                        if (updatedOrder.state === ORDER_STATES.ACTIVE) {
                            updatedOrder.state = ORDER_STATES.PARTIAL;
                        }
                        this.logger.log(`Order ${gridOrder.id}: transitioned to PARTIAL with remaining size ${newSize.toFixed(8)}`, 'debug');
                    } else {
                        // Fully filled (newSize = 0) - convert to SPREAD placeholder
                        const updatedOrder = convertToSpreadPlaceholder(gridOrder);
                        this.logger.log(`Order ${gridOrder.id}: fully filled, converted to SPREAD placeholder`, 'debug');
                        filledOrders.push({ ...gridOrder });
                        this._updateOrder(updatedOrder);
                        updatedOrders.push(updatedOrder);
                    }
                } else {
                    this._updateOrder(gridOrder);
                }
            } else {
                // Order no longer exists on chain - it was fully filled
                // Only treat as filled if it was previously ACTIVE or PARTIAL. If it was VIRTUAL and not on chain, it's just a virtual order.
                if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                    this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}) no longer on chain - marking as VIRTUAL (fully filled)`, 'info');
                    const filledOrder = { ...gridOrder };

                    // Convert to SPREAD placeholder
                    const updatedOrder = convertToSpreadPlaceholder(gridOrder);

                    this._updateOrder(updatedOrder);
                    filledOrders.push(filledOrder);
                }
            }
        }

        // Second pass: Check for chain orders that don't match any grid orderId but match by price
        // This handles cases where orders were recreated with new IDs OR picking up existing orders for virtual spots
        for (const [chainOrderId, chainOrder] of parsedChainOrders) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue; // Already matched

            // Find a grid order that matches by type and price but has a stale/missing orderId
            // Use calculatePriceTolerance(...) which computes tolerance based on asset precisions and order sizes
            let bestMatch = null;
            let bestPriceDiff = Infinity;

            for (const gridOrder of this.orders.values()) {
                // MUST match type first, but allow SPREAD slots to match either side
                if (gridOrder.type !== chainOrder.type && gridOrder.type !== ORDER_TYPES.SPREAD) continue;

                // SKIP if this grid slot is already matched to another chain order (ONE-TO-ONE mapping)
                if (matchedGridOrderIds.has(gridOrder.id)) continue;

                // Skip if already confirmed active on another ID
                if ((gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) && gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) continue;

                const priceDiff = Math.abs(gridOrder.price - chainOrder.price);

                // Prefer using the chain-reported size when available for a more accurate tolerance
                const orderSize = (chainOrder.size && Number.isFinite(Number(chainOrder.size))) ? Number(chainOrder.size) : (gridOrder.size && Number.isFinite(Number(gridOrder.size)) ? Number(gridOrder.size) : null);

                // Compute tolerance using the same formula used elsewhere in the manager
                let tolerance = null;
                try {
                    if (orderSize !== null && orderSize > 0) {
                        tolerance = calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type, this.assets);
                    }
                } catch (e) {
                    tolerance = null;
                }

                // Ensure we have a usable tolerance from calculatePriceTolerance (it provides a fallback)
                if (!tolerance || !Number.isFinite(tolerance)) {
                    tolerance = calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type, this.assets);
                }

                if (priceDiff <= tolerance && priceDiff < bestPriceDiff) {
                    bestMatch = gridOrder;
                    bestPriceDiff = priceDiff;
                }
            }

            if (bestMatch) {
                this.logger.log(`Order ${bestMatch.id}: Found matching open order ${chainOrderId} (diff=${bestPriceDiff.toFixed(8)}). Syncing...`, 'info');
                bestMatch.orderId = chainOrderId;
                bestMatch.state = ORDER_STATES.ACTIVE;
                matchedGridOrderIds.add(bestMatch.id);  // Mark this grid slot as matched (ONE-TO-ONE mapping)

                // Update size from chain but NEVER update price
                const oldSize = Number(bestMatch.size || 0);
                const newSize = Number(chainOrder.size || 0);
                // Determine precision from the matching grid order (if available)
                const precision = (bestMatch && bestMatch.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const oldInt = floatToBlockchainInt(oldSize, precision);
                const newInt = floatToBlockchainInt(newSize, precision);
                if (oldInt !== newInt) {
                    applyChainSizeToGridOrder(this, bestMatch, newSize);
                    // Transition to PARTIAL if size changed and has remainder
                    if (newInt > 0) {
                        if (bestMatch.state === ORDER_STATES.ACTIVE) {
                            bestMatch.state = ORDER_STATES.PARTIAL;
                            this.logger.log(`Order ${bestMatch.id}: transitioned to PARTIAL with remaining size ${newSize.toFixed(8)}`, 'debug');
                        }
                    } else {
                        // Fully filled - convert to SPREAD placeholder
                        const updatedOrder = convertToSpreadPlaceholder(bestMatch);
                        filledOrders.push({ ...bestMatch });
                        this.logger.log(`Order ${bestMatch.id}: fully filled during sync, converted to SPREAD placeholder`, 'debug');
                        bestMatch = updatedOrder; // Ensure the updated object is what gets saved next
                    }
                }
                this._updateOrder(bestMatch);
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            } else {
                this.logger.log(`Chain order ${chainOrderId} (type=${chainOrder.type}, price=${chainOrder.price.toFixed(4)}) has no matching grid order`, 'warn');
            }
        }

        // Log fill info if provided
        if (fillInfo && fillInfo.pays && fillInfo.receives) {
            this.logger.log(`Fill event: pays ${fillInfo.pays.amount} (${fillInfo.pays.asset_id}), receives ${fillInfo.receives.amount} (${fillInfo.receives.asset_id})`, 'debug');
        }

        // Log summary of orders needing correction
        if (ordersNeedingCorrection.length > 0) {
            this.logger.log(`${ordersNeedingCorrection.length} order(s) need price correction on blockchain`, 'warn');
        }

        // === POST-SYNC: Handle surplus orders and target matching ===

        // Count matched active orders by type
        const matchedBuyOrders = Array.from(matchedGridOrderIds)
            .map(id => this.orders.get(id))
            .filter(o => o && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) && o.type === ORDER_TYPES.BUY);
        const matchedSellOrders = Array.from(matchedGridOrderIds)
            .map(id => this.orders.get(id))
            .filter(o => o && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) && o.type === ORDER_TYPES.SELL);

        const targetBuy = this.config.activeOrders?.buy || 0;
        const targetSell = this.config.activeOrders?.sell || 0;

        this.logger.log(
            `Post-sync counts: BUY ${matchedBuyOrders.length}/${targetBuy}, SELL ${matchedSellOrders.length}/${targetSell}. ` +
            `Matched grid slots: ${matchedGridOrderIds.size}, Unmatched chain orders: ${parsedChainOrders.size - chainOrderIdsOnGrid.size}`,
            'info'
        );

        // Find unmatched chain orders (those without matching grid slots)
        const unmatchedChainOrders = Array.from(parsedChainOrders.values())
            .filter(co => !chainOrderIdsOnGrid.has(co.orderId));

        // === Handle BUY side ===
        if (matchedBuyOrders.length < targetBuy && unmatchedChainOrders.length > 0) {
            // Below target: match unmatched orders to HIGHEST virtual BUY slot (premium position)
            const highestVirtualBuy = Array.from(this.orders.values())
                .filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.VIRTUAL && !matchedGridOrderIds.has(o.id))
                .sort((a, b) => b.price - a.price)[0];  // Highest price = best bid

            if (highestVirtualBuy) {
                // Match unmatched BUY orders to this premium slot
                const buyOrdersToMatch = unmatchedChainOrders.filter(co => co.type === ORDER_TYPES.BUY);
                if (buyOrdersToMatch.length > 0 && matchedBuyOrders.length < targetBuy) {
                    const chainBuy = buyOrdersToMatch[0];
                    this.logger.log(
                        `Below target for BUY (${matchedBuyOrders.length}/${targetBuy}): ` +
                        `Matching chain order ${chainBuy.orderId} to premium grid slot ${highestVirtualBuy.id}`,
                        'info'
                    );
                    highestVirtualBuy.orderId = chainBuy.orderId;
                    highestVirtualBuy.state = ORDER_STATES.ACTIVE;
                    highestVirtualBuy.size = chainBuy.size;
                    matchedGridOrderIds.add(highestVirtualBuy.id);
                    chainOrderIdsOnGrid.add(chainBuy.orderId);
                    this._updateOrder(highestVirtualBuy);
                    updatedOrders.push(highestVirtualBuy);
                }
            }
        } else if (matchedBuyOrders.length > targetBuy) {
            // Above target: mark worst BUY matches for cancellation
            const buyOrdersByPriceDiff = matchedBuyOrders
                .map(o => ({
                    order: o,
                    priceDiff: Math.abs(o.price - parsedChainOrders.get(o.orderId)?.price || 0)
                }))
                .sort((a, b) => b.priceDiff - a.priceDiff);  // Worst first (highest diff)

            const surplusBuyCount = matchedBuyOrders.length - targetBuy;
            for (let i = 0; i < surplusBuyCount && i < buyOrdersByPriceDiff.length; i++) {
                const buyOrder = buyOrdersByPriceDiff[i].order;
                this.logger.log(
                    `Surplus BUY order: ${buyOrder.orderId} (diff=${buyOrdersByPriceDiff[i].priceDiff.toFixed(8)}). ` +
                    `Marking for cancellation (${i + 1}/${surplusBuyCount}).`,
                    'warn'
                );
                this.ordersPendingCancellation.push({
                    orderId: buyOrder.orderId,
                    gridOrderId: buyOrder.id,
                    type: ORDER_TYPES.BUY,
                    reason: 'surplus',
                    priceDiff: buyOrdersByPriceDiff[i].priceDiff
                });
            }
        }

        // === Handle SELL side ===
        if (matchedSellOrders.length < targetSell && unmatchedChainOrders.length > 0) {
            // Below target: match unmatched orders to LOWEST virtual SELL slot (premium position)
            const lowestVirtualSell = Array.from(this.orders.values())
                .filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.VIRTUAL && !matchedGridOrderIds.has(o.id))
                .sort((a, b) => a.price - b.price)[0];  // Lowest price = best ask

            if (lowestVirtualSell) {
                // Match unmatched SELL orders to this premium slot
                const sellOrdersToMatch = unmatchedChainOrders.filter(co => co.type === ORDER_TYPES.SELL);
                if (sellOrdersToMatch.length > 0 && matchedSellOrders.length < targetSell) {
                    const chainSell = sellOrdersToMatch[0];
                    this.logger.log(
                        `Below target for SELL (${matchedSellOrders.length}/${targetSell}): ` +
                        `Matching chain order ${chainSell.orderId} to premium grid slot ${lowestVirtualSell.id}`,
                        'info'
                    );
                    lowestVirtualSell.orderId = chainSell.orderId;
                    lowestVirtualSell.state = ORDER_STATES.ACTIVE;
                    lowestVirtualSell.size = chainSell.size;
                    matchedGridOrderIds.add(lowestVirtualSell.id);
                    chainOrderIdsOnGrid.add(chainSell.orderId);
                    this._updateOrder(lowestVirtualSell);
                    updatedOrders.push(lowestVirtualSell);
                }
            }
        } else if (matchedSellOrders.length > targetSell) {
            // Above target: mark worst SELL matches for cancellation
            const sellOrdersByPriceDiff = matchedSellOrders
                .map(o => ({
                    order: o,
                    priceDiff: Math.abs(o.price - parsedChainOrders.get(o.orderId)?.price || 0)
                }))
                .sort((a, b) => b.priceDiff - a.priceDiff);  // Worst first (highest diff)

            const surplusSellCount = matchedSellOrders.length - targetSell;
            for (let i = 0; i < surplusSellCount && i < sellOrdersByPriceDiff.length; i++) {
                const sellOrder = sellOrdersByPriceDiff[i].order;
                this.logger.log(
                    `Surplus SELL order: ${sellOrder.orderId} (diff=${sellOrdersByPriceDiff[i].priceDiff.toFixed(8)}). ` +
                    `Marking for cancellation (${i + 1}/${surplusSellCount}).`,
                    'warn'
                );
                this.ordersPendingCancellation.push({
                    orderId: sellOrder.orderId,
                    gridOrderId: sellOrder.id,
                    type: ORDER_TYPES.SELL,
                    reason: 'surplus',
                    priceDiff: sellOrdersByPriceDiff[i].priceDiff
                });
            }
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection };
    }

    /**
     * Process a fill event directly from history/subscription data.
     * Uses order_id from the fill event to match with orders in the grid.
     * This is the preferred method (faster, no extra API calls).
     * 
     * The fill event contains:
     * - order_id: The chain order ID that was filled (e.g., '1.7.12345')
     * - pays: { amount, asset_id } - What the maker paid out
     * - receives: { amount, asset_id } - What the maker received
     * - is_maker: boolean - Whether this account was the maker
     * 
     * @param {Object} fillOp - Fill operation data (fillEvent.op[1])
     * @returns {Object} - { filledOrders: [], updatedOrders: [], partialFill: boolean }
     */
    syncFromFillHistory(fillOp) {
        if (!fillOp || !fillOp.order_id) {
            this.logger.log('syncFromFillHistory: No valid fill operation provided', 'debug');
            return { filledOrders: [], updatedOrders: [], partialFill: false };
        }

        const orderId = fillOp.order_id;
        const paysAmount = fillOp.pays ? Number(fillOp.pays.amount) : 0;
        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
        const receivesAmount = fillOp.receives ? Number(fillOp.receives.amount) : 0;
        const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;

        this.logger.log(`syncFromFillHistory: Processing fill for order_id=${orderId}`, 'debug');
        this.logger.log(`  Pays: ${paysAmount} (${paysAssetId}), Receives: ${receivesAmount} (${receivesAssetId})`, 'debug');

        // DEBUG: Log asset precision being used
        const assetAPrecision = this.assets?.assetA?.precision || 5;
        const assetBPrecision = this.assets?.assetB?.precision || 5;
        this.logger.log(`  Asset precisions: assetA=${assetAPrecision}, assetB=${assetBPrecision} (using defaults if missing)`, 'debug');

        const filledOrders = [];
        const updatedOrders = [];
        let partialFill = false;

        // Find the grid order by orderId
        let matchedGridOrder = null;
        for (const gridOrder of this.orders.values()) {
            if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                matchedGridOrder = gridOrder;
                break;
            }
        }

        if (!matchedGridOrder) {
            this.logger.log(`syncFromFillHistory: No matching grid order found for order_id=${orderId}`, 'warn');
            return { filledOrders, updatedOrders, partialFill };
        }

        this.logger.log(`syncFromFillHistory: Matched order_id=${orderId} to grid order ${matchedGridOrder.id} (type=${matchedGridOrder.type})`, 'debug');

        // Determine the fill amount based on order type and which asset was paid
        // For SELL orders: pays is assetA (what we're selling)
        // For BUY orders: pays is assetB (what we're selling to buy assetA)
        const orderType = matchedGridOrder.type;
        const currentSize = Number(matchedGridOrder.size || 0);

        // Get asset IDs (precisions already declared above)
        const assetAId = this.assets?.assetA?.id;
        const assetBId = this.assets?.assetB?.id;

        // Calculate the filled amount in human-readable units
        let filledAmount = 0;
        if (orderType === ORDER_TYPES.SELL) {
            // SELL order: size is in assetA, pays is assetA
            if (paysAssetId === assetAId) {
                filledAmount = blockchainToFloat(paysAmount, assetAPrecision);
            }
        } else {
            // BUY order: size is in assetB, pays is assetB
            if (paysAssetId === assetBId) {
                filledAmount = blockchainToFloat(paysAmount, assetBPrecision);
            }
        }

        // Check if fully filled or partially filled
        // Use blockchain integer comparison for precision
        const precision = (orderType === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;

        // CRITICAL FIX: Use integer-based subtraction of blockchain units to avoid floating point noise
        // This prevents small floats (like 1e-18) from keeping an order in PARTIAL state when it's actually finished.
        const currentSizeInt = floatToBlockchainInt(currentSize, precision);
        const filledAmountInt = floatToBlockchainInt(filledAmount, precision);
        const newSizeInt = Math.max(0, currentSizeInt - filledAmountInt);

        // Convert back to float for the rest of the logic
        const newSize = blockchainToFloat(newSizeInt, precision);

        if (newSizeInt <= 0) {
            // Fully filled
            this.logger.log(`Order ${matchedGridOrder.id} (${orderId}) FULLY FILLED (filled ${formatOrderSize(filledAmount)}), cacheFunds: Buy ${formatOrderSize(this.funds.cacheFunds.buy || 0)} | Sell ${formatOrderSize(this.funds.cacheFunds.sell || 0)}`, 'info');
            const filledOrder = { ...matchedGridOrder };

            // Convert to SPREAD placeholder
            const updatedOrder = convertToSpreadPlaceholder(matchedGridOrder);

            this._updateOrder(updatedOrder);
            filledOrders.push(filledOrder);
        } else {
            // Partially filled - transition to PARTIAL state
            this.logger.log(`Order ${matchedGridOrder.id} (${orderId}) PARTIALLY FILLED: ${formatOrderSize(filledAmount)} filled, remaining ${formatOrderSize(newSize)}, cacheFunds: Buy ${formatOrderSize(this.funds.cacheFunds.buy || 0)} | Sell ${formatOrderSize(this.funds.cacheFunds.sell || 0)}`, 'info');

            // Create a "virtual" filled order with just the filled amount for proceeds calculation
            // Mark as partial so processFilledOrders knows NOT to trigger rebalancing by default
            const filledPortion = { ...matchedGridOrder, size: filledAmount, isPartial: true };

            // Create copy for update with remaining size
            const updatedOrder = { ...matchedGridOrder };

            // Update state to PARTIAL first to ensure correct index updates
            // applyChainSizeToGridOrder will call _updateOrder internally to sync to orders Map
            updatedOrder.state = ORDER_STATES.PARTIAL;

            applyChainSizeToGridOrder(this, updatedOrder, newSize);

            // Sanity check: ensure orderId is still there
            if (!updatedOrder.orderId) {
                this.logger.log(`CRITICAL: orderId lost in syncFromFillHistory for ${updatedOrder.id}! Restoring from param ${orderId}`, 'error');
                updatedOrder.orderId = orderId;
            }

            // ANCHOR & REFILL: Handle delayed rotation for Case A (Dust Refill)
            // When this order is marked as isDoubleOrder (dust refilled), check if fill threshold is met
            if (updatedOrder.isDoubleOrder && updatedOrder.mergedDustSize) {
                // Accumulate fill amount across multiple events
                updatedOrder.filledSinceRefill = (Number(updatedOrder.filledSinceRefill) || 0) + filledAmount;
                
                const mergedDustSize = Number(updatedOrder.mergedDustSize);
                const totalFilled = updatedOrder.filledSinceRefill;

                // Check if we've filled enough to justify rotating the opposite side
                if (totalFilled >= mergedDustSize) {
                    this.logger.log(
                        `[DELAYED ROTATION TRIGGERED] Order ${updatedOrder.id}: totalFilled=${formatOrderSize(totalFilled)} >= mergedDustSize=${formatOrderSize(mergedDustSize)}. ` +
                        `Stripping isDoubleOrder flag and enabling rotation on opposite side.`,
                        'info'
                    );

                    // Signal to processFilledOrders that we should trigger a rotation now
                    filledPortion.isDelayedRotationTrigger = true;
                    
                    // Recover to ACTIVE state: the dust debt is paid and size is now exactly Ideal
                    updatedOrder.state = ORDER_STATES.ACTIVE;

                    // Strip the double order marker to allow future rotations to proceed normally
                    updatedOrder.isDoubleOrder = false;
                    updatedOrder.pendingRotation = false;
                    updatedOrder.filledSinceRefill = 0; // Reset accumulation
                    // Note: mergedDustSize is kept for divergence calculations
                } else {
                    // Still clearing the dust portion: keep state as ACTIVE
                    // This ensures the order appears green/full until it drops below 100%
                    updatedOrder.state = ORDER_STATES.ACTIVE;

                    this.logger.log(
                        `[DELAYED ROTATION PENDING] Order ${updatedOrder.id}: totalFilled=${formatOrderSize(totalFilled)} < mergedDustSize=${formatOrderSize(mergedDustSize)}. ` +
                        `Rotation still pending. ${formatOrderSize(mergedDustSize - totalFilled)} more needed.`,
                        'debug'
                    );
                }
            }

            updatedOrders.push(updatedOrder);
            filledOrders.push(filledPortion);
            partialFill = true;
        }

        return { filledOrders, updatedOrders, partialFill };
    }

    async synchronizeWithChain(chainData, source) {
        if (!this.assets) {
            this.logger.log('Asset metadata not available, cannot synchronize.', 'warn');
            return { newOrders: [], ordersNeedingCorrection: [] };
        }
        this.logger.log(`Syncing from ${source}`, 'debug');
        // Cache asset precisions for hot paths
        const assetAPrecision = this.assets?.assetA?.precision;
        const assetBPrecision = this.assets?.assetB?.precision;
        let newOrders = [];
        // Reset the instance-level correction list for readOpenOrders case
        if (source === 'readOpenOrders') {
            this.ordersNeedingPriceCorrection = [];
        }
        this.logger.log(`DEBUG: synchronizeWithChain entering switch, source=${source}, chainData.length=${Array.isArray(chainData) ? chainData.length : 'N/A'}`, 'debug');
        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId, isPartialPlacement, fee } = chainData;
                const gridOrder = this.orders.get(gridOrderId);
                if (gridOrder) {
                    // Create a new object with updated state to avoid mutation bugs in _updateOrder
                    // (if we mutate in place, _updateOrder can't find the old state index to remove from)
                    // Transition to ACTIVE unless explicitly placed as a partial (isPartialPlacement)
                    const newState = isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                    const updatedOrder = { ...gridOrder, state: newState, orderId: chainOrderId };

                    // Centralized fund tracking: Deduct order size (and optional fee) from chainFree 
                    this._updateOptimisticFreeBalance(gridOrder, updatedOrder, 'createOrder', fee);

                    this._updateOrder(updatedOrder);
                    this.logger.log(`Order ${updatedOrder.id} synced with on-chain ID ${updatedOrder.orderId} (state=${newState})`, 'info');
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                this.logger.log(`[CANCEL_DEBUG] Received cancelOrder event for chain orderId: ${orderId}`, 'debug');
                const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: this.orders, ordersByState: this._ordersByState, assets: this.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, this.assets), logger: this.logger });
                if (gridOrder) {
                    this.logger.log(`[CANCEL_DEBUG] Found matching grid order: gridId=${gridOrder.id}, state=${gridOrder.state}, size=${gridOrder.size}, type=${gridOrder.type}`, 'debug');

                    // Create a new object to avoid mutation bug
                    // Cancelled surplus orders: preserve original type (BUY/SELL) and size for grid history
                    // Only FILLED orders become VIRTUAL SPREAD with size: 0 - cancelled orders preserve allocation
                    const updatedOrder = { ...gridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };

                    // Centralized fund tracking: Restore order size to chainFree when moving from ACTIVE/PARTIAL to VIRTUAL
                    this._updateOptimisticFreeBalance(gridOrder, updatedOrder, 'cancelOrder');

                    this._updateOrder(updatedOrder);
                    this.logger.log(`Order ${updatedOrder.id} (${orderId}) cancelled and reverted to VIRTUAL ${gridOrder.type.toUpperCase()} (size preserved: ${gridOrder.size?.toFixed(8) || 0})`, 'info');
                } else {
                    this.logger.log(`[CANCEL_DEBUG] WARNING: No matching grid order found for cancelled chain orderId: ${orderId}. Grid has ${this.orders.size} orders. Possible reasons: order already processed, or grid lookup failed.`, 'warn');
                }
                break;
            }
            case 'readOpenOrders': {
                const matchedChainOrders = new Set();  // chainOrderIds that matched a grid order
                const seenOnChain = new Set();         // all chain orderIds seen during this sync
                const relevantChainOrders = [];        // only chain orders in THIS market pair
                this.logger.log(`DEBUG: readOpenOrders: ${chainData.length} chain orders to process, ${this.orders.size} grid orders loaded.`, 'debug');
                let parsedCount = 0;

                // Step 1: Match chain orders to grid orders
                for (const chainOrder of chainData) {
                    const parsedOrder = parseChainOrder(chainOrder, this.assets);
                    if (!parsedOrder) {
                        this.logger.log(`ERROR: Could not parse chain order ${chainOrder.id}. Skipping (will retry on next sync).`, 'error');
                        continue;
                    }
                    relevantChainOrders.push(chainOrder);
                    seenOnChain.add(parsedOrder.orderId);
                    parsedCount++;
                    this.logger.log(`DEBUG: Parsed chain order ${parsedOrder.orderId}: type=${parsedOrder.type}, price=${parsedOrder.price?.toFixed(6)}, size=${parsedOrder.size?.toFixed(8)}`, 'info');

                    const gridOrder = findMatchingGridOrderByOpenOrder(parsedOrder, { orders: this.orders, ordersByState: this._ordersByState, assets: this.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, this.assets), logger: this.logger, skipSizeMatch: true });
                    if (gridOrder) {
                        matchedChainOrders.add(parsedOrder.orderId);

                        // IMPORTANT: do NOT mutate the existing order object in-place.
                        // _updateOrder uses the previously stored object's state/type to update indices.
                        // If we mutate first, old indices won't be cleaned up.

                        // Detect partial fills: if chain size is less than our current tracked size
                        const currentSize = Number(gridOrder.size || 0);
                        const chainSize = Number(parsedOrder.size || 0);
                        const precision = (gridOrder.type === ORDER_TYPES.SELL)
                            ? (this.assets?.assetA?.precision ?? 8)
                            : (this.assets?.assetB?.precision ?? 8);

                        // Use integer comparison to avoid floating point noise
                        const currentSizeInt = floatToBlockchainInt(currentSize, precision);
                        const chainSizeInt = floatToBlockchainInt(chainSize, precision);

                        let newState = gridOrder.state;

                        if (chainSizeInt < currentSizeInt && chainSizeInt > 0) {
                            // Size reduced but not zero -> transition to PARTIAL
                            newState = ORDER_STATES.PARTIAL;
                            this.logger.log(`Grid ${gridOrder.id} detected partial fill offline: ${currentSize.toFixed(8)} -> ${chainSize.toFixed(8)}`, 'info');
                        } else if (gridOrder.state !== ORDER_STATES.PARTIAL) {
                            // Otherwise ensure it's ACTIVE if it was VIRTUAL or newly matched
                            newState = ORDER_STATES.ACTIVE;
                        }

                        const updatedOrder = {
                            ...gridOrder,
                            orderId: parsedOrder.orderId,
                            state: newState
                        };
                        this.logger.log(`Grid ${updatedOrder.id} now ${newState.toUpperCase()} with orderId ${parsedOrder.orderId}`, 'info');

                        // Apply chain size to updated order (reconcile sizes)
                        if (parsedOrder.size !== null && parsedOrder.size !== undefined && Number.isFinite(Number(parsedOrder.size))) {
                            try {
                                applyChainSizeToGridOrder(this, updatedOrder, parsedOrder.size);
                            } catch (e) {
                                this.logger.log(`Error applying chain size: ${e.message}`, 'warn');
                            }
                        }

                        this._updateOrder(updatedOrder);
                    } else {
                        this.logger.log(`No grid match for chain ${parsedOrder.orderId} (type=${parsedOrder.type}, price=${parsedOrder.price.toFixed(4)}, size=${parsedOrder.size?.toFixed(8)})`, 'warn');
                    }
                }

                // Step 2: Find grid orders not on-chain (treat as filled)
                const unmatchedGridOrders = [];
                for (const gridOrder of this.orders.values()) {
                    // A grid order is missing only if its orderId is NOT present on chain.
                    if ((gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) && gridOrder.orderId && !seenOnChain.has(gridOrder.orderId)) {
                        this.logger.log(`Grid order ${gridOrder.id} (${gridOrder.orderId}) not found on-chain - treating as FILLED`, 'info');
                        unmatchedGridOrders.push(gridOrder);
                    }
                }

                // Step 3: Find chain orders that don't match any grid order
                // IMPORTANT: only consider orders in this market pair.
                const unmatchedChainOrders = relevantChainOrders.filter(co => !matchedChainOrders.has(co.id));

                // Summary
                this.logger.log(`Sync summary: ${parsedCount} chain orders, ${this.orders.size} grid orders, matched=${matchedChainOrders.size}, unmatched_chain=${unmatchedChainOrders.length}, unmatched_grid=${unmatchedGridOrders.length}`, 'debug');

                // Process unmatched grid orders as fills
                let rebalanceResult = { ordersToPlace: [], ordersToRotate: [] };
                if (unmatchedGridOrders.length > 0) {
                    rebalanceResult = await this.processFilledOrders(unmatchedGridOrders, new Set(this.ordersNeedingPriceCorrection.map(c => c.chainOrderId)));
                }

                // Return results
                return {
                    newOrders,
                    ordersNeedingCorrection: this.ordersNeedingPriceCorrection,
                    rebalanceResult,
                    unmatchedChainOrders,  // Chain orders that don't match any grid (candidates for cancel or reuse)
                    unmatchedGridOrders    // Grid orders not on-chain (treated as filled, trigger rebalancing)
                };
            }
        }

        return { newOrders, ordersNeedingCorrection: this.ordersNeedingPriceCorrection };
    }

    /**
     * Get the initial set of orders to place on-chain.
     * Selects the closest virtual orders to market price,
     * respecting the configured activeOrders limits and
     * filtering out orders below minimum size.
     * 
     * Orders are sorted from outside-in for optimal placement:
     * - Sells: highest price first
     * - Buys: lowest price first
     * 
     * @returns {Array} Array of order objects to activate
     */
    getInitialOrdersToActivate() {
        const sellCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.sell ? this.config.activeOrders.sell : 1));
        const buyCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.buy ? this.config.activeOrders.buy : 1));

        // Get minimum order sizes for each type
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        // --- Sells ---
        const allVirtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualSells.sort((a, b) => a.price - b.price);
        // Take the block of orders that will become active
        const futureActiveSells = allVirtualSells.slice(0, sellCount);
        // Filter out orders below minimum size and log warnings
        const validSells = futureActiveSells.filter(order => {
            if (order.size < minSellSize) {
                this.logger.log(`Skipping sell order ${order.id}: size ${order.size.toFixed(8)} < minOrderSize ${minSellSize.toFixed(8)}`, 'warn');
                return false;
            }
            return true;
        });
        // Sort that block from the outside-in
        validSells.sort((a, b) => b.price - a.price);

        // --- Buys ---
        const allVirtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualBuys.sort((a, b) => b.price - a.price);
        // Take the block of orders that will become active
        const futureActiveBuys = allVirtualBuys.slice(0, buyCount);
        // Filter out orders below minimum size and log warnings
        const validBuys = futureActiveBuys.filter(order => {
            if (order.size < minBuySize) {
                this.logger.log(`Skipping buy order ${order.id}: size ${order.size.toFixed(8)} < minOrderSize ${minBuySize.toFixed(8)}`, 'warn');
                return false;
            }
            return true;
        });
        // Sort that block from the outside-in
        validBuys.sort((a, b) => a.price - b.price);

        if (validSells.length < futureActiveSells.length || validBuys.length < futureActiveBuys.length) {
            this.logger.log(`Filtered ${futureActiveSells.length - validSells.length} sell and ${futureActiveBuys.length - validBuys.length} buy orders below minimum size threshold`, 'debug');
        }

        return [...validSells, ...validBuys];
    }

    /**
     * Filter tracked orders by type and/or state using optimized indices.
     * @param {string|null} type - ORDER_TYPES.BUY, SELL, or SPREAD (null for all)
     * @param {string|null} state - ORDER_STATES.VIRTUAL or ACTIVE (null for all)
     * @returns {Array} Filtered array of order objects
     */
    getOrdersByTypeAndState(type, state) {
        let candidateIds;

        // Use indices for faster lookup when possible
        if (state !== null && type !== null) {
            // Intersection of both state and type indices
            const stateIds = this._ordersByState[state] || new Set();
            const typeIds = this._ordersByType[type] || new Set();
            candidateIds = [...stateIds].filter(id => typeIds.has(id));
            return candidateIds.map(id => this.orders.get(id)).filter(Boolean);
        } else if (state !== null) {
            // Use state index only
            candidateIds = this._ordersByState[state] || new Set();
            return [...candidateIds].map(id => this.orders.get(id)).filter(Boolean);
        } else if (type !== null) {
            // Use type index only
            candidateIds = this._ordersByType[type] || new Set();
            return [...candidateIds].map(id => this.orders.get(id)).filter(Boolean);
        } else {
            // No filtering, return all orders
            return Array.from(this.orders.values());
        }
    }

    /**
     * Get all PARTIAL orders of a specific type.
     * @param {string} type - ORDER_TYPES.BUY or SELL
     * @returns {Array} Array of partial order objects
     */
    getPartialOrdersOnSide(type) {
        // Filter out any orders that are currently shadowed (locked in pending transactions)
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL)
            .filter(o => !this.isOrderLocked(o.id) && !this.isOrderLocked(o.orderId));
    }

    // Periodically poll for fills and recalculate orders on demand.
    async fetchOrderUpdates(options = { calculate: false }) {
        try {
            const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
            let remaining = activeOrders;
            let filled = [];

            if (activeOrders.length === 0 || (options && options.calculate)) {
                const result = await this.calculateOrderUpdates();
                remaining = result.remaining;
                filled = result.filled;
                remaining.forEach(order => this.orders.set(order.id, order));
                if (filled.length > 0) await this.processFilledOrders(filled);
            }

            return { remaining, filled };
        } catch (error) {
            this.logger.log(`Error fetching order updates: ${error.message}`, 'error');
            return { remaining: [], filled: [] };
        }
    }

    // Simulate fills by identifying the closest active order (will be converted to VIRTUAL/SPREAD by processFilledOrders).
    async calculateOrderUpdates() { const startPrice = this.config.startPrice; const spreadRange = startPrice * (this.config.targetSpreadPercent / 100); const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE); const activeSells = activeOrders.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => Math.abs(a.price - this.config.startPrice) - Math.abs(b.price - this.config.startPrice)); const activeBuys = activeOrders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => Math.abs(a.price - this.config.startPrice) - Math.abs(b.price - this.config.startPrice)); const filledOrders = []; if (activeSells.length > 0) filledOrders.push({ ...activeSells[0] }); else if (activeBuys.length > 0) filledOrders.push({ ...activeBuys[0] }); const remaining = activeOrders.filter(o => !filledOrders.some(f => f.id === o.id)); return { remaining, filled: filledOrders }; }

    // Flag whether the spread has widened beyond configured limits so we can rebalance.
    // Fetches current market price for fair fund comparison if BitShares API provided.
    async checkSpreadCondition(BitShares, updateOrdersOnChainBatch = null) {
        const Grid = require('./grid');
        return await Grid.checkSpreadCondition(this, BitShares, updateOrdersOnChainBatch);
    }

    /**
     * Check structural health of the grid and perform dust recovery.
     * @param {Function} updateOrdersOnChainBatch - Optional callback for broadcasting updates
     */
    async checkGridHealth(updateOrdersOnChainBatch = null) {
        const Grid = require('./grid');
        return await Grid.checkGridHealth(this, updateOrdersOnChainBatch);
    }

    /**
     * Process filled orders and trigger rebalancing.
     * For each filled order:
     * 1. Converts directly to VIRTUAL/SPREAD placeholder (single step)
     * 2. Updates funds (transfers proceeds to available pool)
     * 3. Triggers creation of new orders on the opposite side
     * 
     * @param {Array} filledOrders - Array of orders that were filled
     * @param {Set} excludeOrderIds - Set of chain orderIds to exclude from rotation (e.g., just corrected)
     * @returns {Array} Newly activated orders that need on-chain placement
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        this.logger.log(`>>> processFilledOrders() called with ${filledOrders.length} filled orders`, 'info');

        /**
         * FILL PROCESSING STRATEGY:
         * ========================
         * When orders fill, we need to:
         * 1. Calculate proceeds (amount received when order filled)
         * 2. Update on-chain account balances optimistically (without waiting for chain refresh)
         * 3. Track full vs partial fills
         * 4. Convert full fills to SPREAD placeholders
         * 5. Accumulate blockchain fees
         * 6. Prepare new orders for rotation
         *
         * Key Insight - Proceeds Calculation:
         * -----------------------------------
         * SELL orders: We SELL assetA (base) and RECEIVE assetB (quote)
         *   proceeds = size * price (converts base asset to quote)
         *   Added to: proceedsBuy (because we received quote asset)
         *
         * BUY orders: We BUY assetA (base) and SPEND assetB (quote)
         *   proceeds = size / price (converts spent quote to base received)
         *   Added to: proceedsSell (because we received base asset)
         *
         * These proceeds become "available" for placing new orders without waiting
         * for a blockchain confirmation.
         */
        const filledCounts = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };
        const partialFillCount = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };

        // Collect proceeds to add AFTER all fill conversions
        // We don't add them immediately because _updateOrder() calls recalculateFunds()
        // which would overwrite our accumulated proceeds
        let proceedsBuy = 0;
        let proceedsSell = 0;

        // Track balance deltas for optimistic account total updates
        // These allow us to reflect fills immediately without waiting for a fresh chain query
        let deltaBuyFree = 0;
        let deltaSellFree = 0;
        let deltaBuyTotal = 0;
        let deltaSellTotal = 0;

        // Check if BTS is in the trading pair (only track blockchain fees if it is)
        const hasBtsPair = this.config.assetA === 'BTS' || this.config.assetB === 'BTS';

        for (const filledOrder of filledOrders) {
            // Track if this is a partial fill (remaining amount still locked on-chain)
            const isPartial = filledOrder.isPartial === true;
            if (isPartial) {
                partialFillCount[filledOrder.type]++;
                
                // ANCHOR & REFILL: If this partial fill cleared the dust debt, trigger rotation
                if (filledOrder.isDelayedRotationTrigger) {
                    filledCounts[filledOrder.type]++;
                    this.logger.log(`Delayed rotation trigger detected for ${filledOrder.type} order ${filledOrder.id}`, 'debug');
                }
            } else {
                filledCounts[filledOrder.type]++;
            }

            // Calculate proceeds before converting to SPREAD
            if (filledOrder.type === ORDER_TYPES.SELL) {
                const rawProceeds = filledOrder.size * filledOrder.price;
                // Deduct market fee from quote asset (assetB) that we're receiving
                // (Skip fee for BTS - blockchain fees are handled separately)
                let netProceeds = rawProceeds;
                let feeInfo = '';
                if (this.config.assetB !== 'BTS') {
                    try {
                        const feeResult = getAssetFees(this.config.assetB, rawProceeds);
                        netProceeds = typeof feeResult === 'number' ? feeResult : rawProceeds;
                        if (netProceeds !== rawProceeds) {
                            feeInfo = ` (net after market fee: ${netProceeds.toFixed(8)})`;
                        }
                    } catch (e) {
                        this.logger.log(`WARNING: Could not get fees for ${this.config.assetB}: ${e.message}. Using raw proceeds.`, 'warn');
                    }
                }
                proceedsBuy += netProceeds;  // Collect in cacheFunds only, NOT in chainFree
                // SELL means we receive quote asset (buy side) and give up base asset (sell side)
                // Reflect received funds in local Free balance (optimistic)
                deltaBuyFree += netProceeds;
                deltaBuyTotal += netProceeds;  // But DO update total (free + committed) with net amount after market fee
                // sellFree was reduced at order creation; the locked size is now sold, so only the total decreases
                deltaSellTotal -= filledOrder.size;
                const quoteName = this.config.assetB || 'quote';
                const baseName = this.config.assetA || 'base';
                this.logger.log(`Sell filled: +${rawProceeds.toFixed(8)} ${quoteName}${feeInfo}, -${filledOrder.size.toFixed(8)} ${baseName} committed (orderId=${filledOrder.id}, size=${filledOrder.size.toFixed(8)}, price=${filledOrder.price}, isPartial=${filledOrder.isPartial})`, 'info');
            } else {
                const rawProceeds = filledOrder.size / filledOrder.price;
                // Deduct market fee from base asset (assetA) that we're receiving
                // (Skip fee for BTS - blockchain fees are handled separately)
                let netProceeds = rawProceeds;
                let feeInfo = '';
                if (this.config.assetA !== 'BTS') {
                    try {
                        const feeResult = getAssetFees(this.config.assetA, rawProceeds);
                        netProceeds = typeof feeResult === 'number' ? feeResult : rawProceeds;
                        if (netProceeds !== rawProceeds) {
                            feeInfo = ` (net after market fee: ${netProceeds.toFixed(8)})`;
                        }
                    } catch (e) {
                        this.logger.log(`WARNING: Could not get fees for ${this.config.assetA}: ${e.message}. Using raw proceeds.`, 'warn');
                    }
                }
                proceedsSell += netProceeds;  // Collect in cacheFunds only, NOT in chainFree
                // BUY means we receive base asset (assetA, sell side) and spend quote asset (assetB, buy side)
                // Reflect received funds in local Free balance (optimistic)
                deltaSellFree += netProceeds;
                deltaSellTotal += netProceeds;  // But DO update total (free + committed) with net amount after market fee
                // buyFree was reduced at order creation; only total decreases to reflect the spend
                deltaBuyTotal -= filledOrder.size;
                const quoteName = this.config.assetB || 'quote';
                const baseName = this.config.assetA || 'base';
                this.logger.log(`Buy filled: +${rawProceeds.toFixed(8)} ${baseName}${feeInfo}, -${filledOrder.size.toFixed(8)} ${quoteName} committed (orderId=${filledOrder.id}, size=${filledOrder.size.toFixed(8)}, price=${filledOrder.price}, isPartial=${filledOrder.isPartial})`, 'info');
            }

            // Only convert to SPREAD if this is a FULLY filled order, not a partial
            if (!isPartial) {
                // Convert to SPREAD placeholder (one step: ACTIVE -> VIRTUAL/SPREAD)
                const updatedOrder = convertToSpreadPlaceholder(filledOrder);
                this._updateOrder(updatedOrder);

                this.currentSpreadCount++;
                this.logger.log(`Converted order ${filledOrder.id} to SPREAD`, 'debug');
            } else {
                // Partial fill: order already updated to PARTIAL state by syncFromFillHistory
                // Just log for clarity
                this.logger.log(`Partial fill processed: order ${filledOrder.id} remains PARTIAL with ${formatOrderSize(filledOrder.size)} filled`, 'debug');
            }
        }

        // Accumulate BTS fees based on number of FULL fills (partially filled orders do not incur the maker net fee)
        if (hasBtsPair && filledOrders.length > 0) {
            try {
                const btsFeeData = getAssetFees('BTS', 0);
                const fullFillCount = filledCounts[ORDER_TYPES.BUY] + filledCounts[ORDER_TYPES.SELL];
                const btsFeesForFills = fullFillCount * btsFeeData.total;
                this.funds.btsFeesOwed += btsFeesForFills;
                this.logger.log(`BTS fees for ${fullFillCount} full fill(s) (ignoring ${filledOrders.length - fullFillCount} partial): ${btsFeesForFills.toFixed(8)} BTS (total owed: ${this.funds.btsFeesOwed.toFixed(8)} BTS)`, 'debug');
            } catch (err) {
                this.logger?.log?.(`Warning: Could not calculate BTS fees for fills: ${err.message}`, 'warn');
                // Fall back to simple 100 BTS if fee calculation fails
                this.funds.btsFeesOwed += 100;
                this.logger?.log?.(`Using fallback: 100 BTS added to fees owed (total: ${this.funds.btsFeesOwed.toFixed(8)} BTS)`, 'warn');
            }
        }

        // Apply proceeds directly to accountTotals so availability reflects fills immediately (no waiting for a chain refresh)
        if (!this.accountTotals) {
            this.accountTotals = { buy: 0, sell: 0, buyFree: 0, sellFree: 0 };
        }

        const bumpTotal = (key, delta) => {
            if (this.accountTotals[key] === null || this.accountTotals[key] === undefined) this.accountTotals[key] = 0;
            const next = (Number(this.accountTotals[key]) || 0) + delta;
            this.accountTotals[key] = next < 0 ? 0 : next;
        };

        bumpTotal('buyFree', deltaBuyFree);
        bumpTotal('sellFree', deltaSellFree);
        bumpTotal('buy', deltaBuyTotal);
        bumpTotal('sell', deltaSellTotal);

        // Hold proceeds in cacheFunds so availability reflects them through rotation
        const proceedsBefore = { buy: this.funds.cacheFunds.buy || 0, sell: this.funds.cacheFunds.sell || 0 };
        this.funds.cacheFunds.buy = (this.funds.cacheFunds.buy || 0) + proceedsBuy;
        this.funds.cacheFunds.sell = (this.funds.cacheFunds.sell || 0) + proceedsSell;

        this.logger.log(`Proceeds added to cacheFunds: ` +
            `Before Buy ${proceedsBefore.buy.toFixed(8)} + fill ${proceedsBuy.toFixed(8)} = After ${(this.funds.cacheFunds.buy || 0).toFixed(8)} | ` +
            `Before Sell ${proceedsBefore.sell.toFixed(8)} + fill ${proceedsSell.toFixed(8)} = After ${(this.funds.cacheFunds.sell || 0).toFixed(8)}`, 'info');

        // Note: deductBtsFees() automatically determines which side has BTS and deducts from there
        if (hasBtsPair && this.funds.btsFeesOwed > 0) {
            await this.deductBtsFees();
        }

        // CRITICAL: Update internal state from the new accountTotals and cacheFunds
        this.recalculateFunds();

        // CRITICAL: Persist pending proceeds and BTS fees so they survive bot restart
        const proceedsPersistedOk = await this._persistCacheFunds();
        if (!proceedsPersistedOk) {
            this.logger.log(`⚠ Pending proceeds not persisted - will be held in memory and retried`, 'warn');
        }
        if (this.funds.btsFeesOwed > 0) {
            const feesPersistedOk = await this._persistBtsFeesOwed();
            if (!feesPersistedOk) {
                this.logger.log(`⚠ BTS fees not persisted - will be held in memory and retried`, 'warn');
            }
        }

        if (this.logger.level === 'debug') this._logAvailable('after proceeds apply');

        // Log actual available funds after all adjustments
        this.logger.log(`Available funds before rotation: Buy ${this.funds.available.buy.toFixed(8)} | Sell ${this.funds.available.sell.toFixed(8)}`, 'info');
        this._logAvailable('before rotation');

        // CRITICAL: Only rebalance if there are ACTUAL fully-filled orders, not just partial fills
        // Partial fills don't need rotations - the remaining amount stays locked and the order continues
        const hasFullFills = filledCounts[ORDER_TYPES.BUY] > 0 || filledCounts[ORDER_TYPES.SELL] > 0;
        const onlyPartialFills = !hasFullFills && (partialFillCount[ORDER_TYPES.BUY] > 0 || partialFillCount[ORDER_TYPES.SELL] > 0);

        if (onlyPartialFills) {
            this.logger.log(`Only partial fills detected (no rotations needed). Skipping rebalance.`, 'info');
            return { ordersToPlace: [], ordersToRotate: [], partialMoves: [] };
        }

        // NOTE: Spread correction is now PROACTIVE - handled immediately by checkSpreadCondition()
        // when spread is detected as too wide (at startup, after rotations, at 4h fetch)
        // No reactive extraOrderCount logic needed here

        // Ensure all currently filled orders are excluded from being moved or rotated by other fills in this batch
        if (!excludeOrderIds) excludeOrderIds = new Set();
        for (const f of filledOrders) {
            if (f.orderId) excludeOrderIds.add(f.orderId);
            if (f.id) excludeOrderIds.add(f.id);
        }

        const newOrders = await this.rebalanceOrders(filledCounts, 0, excludeOrderIds);

        // Add updateFee to BTS fees if partial orders were moved during rotation
        // Partial fills require an update operation on the blockchain, incurring an additional updateFee
        if (hasBtsPair && newOrders.partialMoves && newOrders.partialMoves.length > 0) {
            try {
                const btsFeeData = getAssetFees('BTS', 0); // Get updateFee from cached fees
                const updateFeePerPartial = btsFeeData.updateFee;
                const totalUpdateFee = updateFeePerPartial * newOrders.partialMoves.length;

                this.funds.btsFeesOwed += totalUpdateFee;
                this.logger.log(`Added updateFee for ${newOrders.partialMoves.length} partial move(s): +${totalUpdateFee.toFixed(8)} BTS (total fees owed: ${this.funds.btsFeesOwed.toFixed(8)} BTS)`, 'info');
            } catch (err) {
                this.logger?.log?.(`Warning: Could not calculate BTS updateFee for partial moves: ${err.message}`, 'warn');
                // Fall back to simple 100 BTS if fee calculation fails
                this.funds.btsFeesOwed += 100;
                this.logger?.log?.(`Using fallback: 100 BTS added for partial moves (total: ${this.funds.btsFeesOwed.toFixed(8)} BTS)`, 'warn');
            }
        }

        this.recalculateFunds();

        // PERSISTENCE: Since cacheFunds now includes proceeds, ensure it is persisted
        await this._persistCacheFunds();
        // No longer clearing cacheFunds, so no proceedsCleared check needed here.

        this._logAvailable('after rotation clear');

        // After rotation, mark any on-chain orders that had their sizes updated by grid triggers for correction
        // This ensures their on-chain sizes match the new grid sizes
        if (this._gridSidesUpdated && this._gridSidesUpdated.length > 0) {
            for (const orderType of this._gridSidesUpdated) {
                const ordersOnSide = Array.from(this.orders.values())
                    .filter(o => o.type === orderType && o.orderId && o.state === ORDER_STATES.ACTIVE);

                for (const order of ordersOnSide) {
                    const correctionInfo = {
                        gridOrder: { ...order },
                        chainOrderId: order.orderId,
                        rawChainOrder: null,
                        expectedPrice: order.price,
                        actualPrice: order.price,
                        expectedSize: order.size,
                        size: order.size,
                        type: order.type,
                        sizeChanged: true
                    };
                    this.ordersNeedingPriceCorrection.push(correctionInfo);
                }
            }
            if (this.ordersNeedingPriceCorrection.length > 0) {
                this.logger.log(
                    `Marked ${this.ordersNeedingPriceCorrection.length} on-chain orders for size correction after grid update`,
                    'info'
                );
            }
            // Clear the tracking flag
            this._gridSidesUpdated = [];
        }

        this.logger && this.logger.logFundsStatus && this.logger.logFundsStatus(this);
        return newOrders;
    }

    // Note: Filled orders are now converted directly to SPREAD in processFilledOrders, syncFromOpenOrders, and syncFromFillHistory

    /**
     * Rebalance orders after fills using count-based creation vs rotation strategy.
     *
     * Decision logic is symmetric: After one side fills, we rebalance the opposite side.
     * - If opposite side count < target: Create new orders to rebuild coverage
     * - If opposite side count >= target: Rotate furthest orders to optimize prices
     *
     * Returns { ordersToPlace, ordersToRotate, partialMoves } for blockchain operations.
     *
     * @param {Object} filledCounts - Count of filled orders by type { buy: n, sell: n }
     * @param {number} extraOrderCount - Extra orders to create (for spread widening)
     * @param {Set} excludeOrderIds - Set of chain orderIds to exclude from rotation
     * @returns {Object} { ordersToPlace: [], ordersToRotate: [], partialMoves: [] }
     */
    /**
     * Rebalance orders after fills using count-based creation vs rotation strategy.
     */
    async rebalanceOrders(filledCounts, extraOrderCount = 0, excludeOrderIds = new Set()) {
        return await this.strategy.rebalanceOrders(filledCounts, extraOrderCount, excludeOrderIds);
    }

    /**
     * Rebalance one side after the opposite side fills.
     */
    async _rebalanceSideAfterFill(filledType, oppositeType, filledCount, extraOrderCount, excludeOrderIds) {
        return await this.strategy.rebalanceSideAfterFill(filledType, oppositeType, filledCount, extraOrderCount, excludeOrderIds);
    }

    /**
     * Activate the closest VIRTUAL orders for on-chain placement.
     */
    async activateClosestVirtualOrdersForPlacement(targetType, count, excludeOrderIds = new Set()) {
        return await this.strategy.activateClosestVirtualOrdersForPlacement(targetType, count, excludeOrderIds);
    }

    /**
     * Prepare the furthest ACTIVE orders for rotation to new prices.
     */
    async prepareFurthestOrdersForRotation(targetType, count, excludeOrderIds = new Set(), filledCount = 0, options = {}) {
        return await this.strategy.prepareFurthestOrdersForRotation(targetType, count, excludeOrderIds, filledCount, options);
    }

    /**
     * Complete an order rotation after blockchain confirmation.
     */
    completeOrderRotation(oldOrderInfo) {
        return this.strategy.completeOrderRotation(oldOrderInfo);
    }

    /**
     * Evaluate whether a partial order should be treated as "Dust" or "Substantial".
     */
    _evaluatePartialOrderAnchor(partialOrder, moveInfo) {
        return this.strategy.evaluatePartialOrderAnchor(partialOrder, moveInfo);
    }

    /**
     * Prepare a partial order to move toward market/spread.
     */
    preparePartialOrderMove(partialOrder, gridSlotsToMove, reservedGridIds = new Set()) {
        return this.strategy.preparePartialOrderMove(partialOrder, gridSlotsToMove, reservedGridIds);
    }

    /**
     * Complete the partial order move after blockchain confirmation.
     */
    completePartialOrderMove(moveInfo) {
        return this.strategy.completePartialOrderMove(moveInfo);
    }

    /**
     * Activate spread placeholder orders as buy/sell orders.
     */
    async activateSpreadOrders(targetType, count) {
        return await this.strategy.activateSpreadOrders(targetType, count);
    }

    /**
     * Calculate the current percentage spread between best bid and ask.
     * Uses active orders if available, falls back to virtual orders.
     * @returns {number} Spread percentage (e.g., 5.0 for 5%)
     */
    calculateCurrentSpread() {
        const Grid = require('./grid');
        return Grid.calculateCurrentSpread(this);
    }

    /**
     * Log a comprehensive status summary to the console.
     * Displays: market, funds, order counts, spread info.
     */
    // Full status display moved to Logger; use this.logger.displayStatus(this)
}

module.exports = { OrderManager };
