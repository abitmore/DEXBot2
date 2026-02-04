/**
 * modules/order/manager.js - OrderManager Engine
 *
 * Core grid-based order management system for DEXBot2.
 * Exports a single OrderManager class that orchestrates all order operations.
 *
 * Responsibilities:
 * - Maintain virtual order grid state (Map of orders + type/state indices)
 * - Coordinate specialized engines:
 *   - Accountant: Fund tracking and fee management
 *   - StrategyEngine: Grid rebalancing and anchoring
 *   - SyncEngine: Blockchain reconciliation
 * - Manage order lifecycle (create, update, fill, cancel)
 * - Track fund availability and committed capital
 * - Synchronize with blockchain state
 * - Persist grid snapshots for crash recovery
 *
 * ===============================================================================
 * TABLE OF CONTENTS - OrderManager Class (40+ methods)
 * ===============================================================================
 *
 * INITIALIZATION & LIFECYCLE (4 methods)
 *   1. constructor(config) - Create new OrderManager with engines and indices
 *   2. startBootstrap() - Mark bootstrap phase start
 *   3. finishBootstrap() - Mark bootstrap phase complete
 *   4. resetFunds() - Reset funds structure to zeroed values
 *
 * FUND MANAGEMENT (9 methods)
 *   5. recalculateFunds() - Master recalculation of all fund values
 *   6. _deductFromChainFree(orderType, size, operation) - Deduct from free balance (internal)
 *   7. _addToChainFree(orderType, size, operation) - Add to free balance (internal)
 *   8. _getCacheFunds(side) - Get cache funds for side
 *   9. _getGridTotal(side) - Get total grid allocation
 *   10. getChainFundsSnapshot() - Get snapshot of fund state
 *   11. applyBotFundsAllocation() - Apply fund allocation percentages
 *   12. setAccountTotals(totals) - Set blockchain account totals
 *   13. getMetrics() - Get performance metrics
 *
 * BLOCKCHAIN SYNCHRONIZATION (6 methods - async)
 *   14. fetchAccountTotals(accountId) - Fetch account balances from blockchain
 *   15. waitForAccountTotals(timeoutMs) - Wait for account totals to be set
 *   16. syncFromOpenOrders(orders, info) - Sync grid from open orders (delegate)
 *   17. syncFromFillHistory(fill) - Sync from fill event (delegate)
 *   18. synchronizeWithChain(data, src) - Full chain synchronization (delegate, async)
 *   19. _initializeAssets() - Initialize asset metadata (internal, async, delegate)
 *
 * BROADCASTING & TIMING (2 methods)
 *   20. startBroadcasting() - Start order broadcast operations
 *   21. stopBroadcasting() - Stop order broadcast operations
 *
 * ORDER MANAGEMENT (8 methods)
 *   22. _updateOrder(order, context, skipAccounting, fee) - Update order state internally
 *   23. getOrdersByTypeAndState(type, state) - Query orders by type and state
 *   24. getInitialOrdersToActivate() - Get orders ready for activation
 *   25. getPartialOrdersOnSide(type) - Get partial orders on side
 *   26. processFilledOrders(orders, excl) - Process filled orders (delegate, async)
 *   27. completeOrderRotation(oldInfo) - Complete order rotation (delegate)
 *   28. isPipelineEmpty(incomingFillQueueLength) - Check if operation pipeline is empty
 *   29. _logAvailable(label) - Log available funds (internal)
 *
 * ORDER LOCKING (4 methods)
 *   30. lockOrders(orderIds) - Lock orders to prevent concurrent modification
 *   31. unlockOrders(orderIds) - Unlock orders
 *   32. isOrderLocked(id) - Check if order is locked
 *   33. _cleanExpiredLocks() - Clean expired lock entries (internal)
 *
 * INDEX MANAGEMENT (3 methods)
 *   34. validateIndices() - Validate index consistency with orders
 *   35. assertIndexConsistency() - Assert indices match orders (throws on mismatch)
 *   36. _repairIndices() - Repair corrupted indices (internal)
 *
 * CONFIGURATION & RESOLUTION (3 methods)
 *   37. _resolveConfigValue(value, total) - Resolve config value with defaults
 *   38. _triggerAccountTotalsFetchIfNeeded() - Fetch totals if stale
 *   39. applyBotFundsAllocation() - Apply fund allocation logic
 *
 * FUND RECALC CONTROL (4 methods)
 *   40. pauseFundRecalc() - Pause automatic fund recalculation
 *   41. resumeFundRecalc() - Resume fund recalculation
 *   42. pauseRecalcLogging() - Pause recalculation logging
 *   43. resumeRecalcLogging() - Resume recalculation logging
 *
 * GRID HEALTH & SPREAD (4 methods)
 *   44. checkSpreadCondition(BitShares, batchCb) - Check spread condition (async)
 *   45. checkGridHealth(batchCb) - Check grid health (async)
 *   46. calculateCurrentSpread() - Calculate current bid-ask spread
 *   47. validateGridStateForPersistence() - Validate grid before persistence
 *
 * PERSISTENCE (2 methods - async)
 *   48. persistGrid() - Persist grid snapshot to storage
 *   49. _persistWithRetry(persistFn, dataType, dataValue, maxAttempts) - Retry persistence (internal)
 *
 * ===============================================================================
 *
 * CORE DATA STRUCTURES:
 * - orders: Map<orderId, Order> - All orders by ID
 * - _ordersByState: { VIRTUAL, ACTIVE, PARTIAL } - Set indices by state
 * - _ordersByType: { BUY, SELL, SPREAD } - Set indices by type
 * - funds: { available, committed, total, virtual, cacheFunds, btsFeesOwed }
 * - accountTotals: { buy, sell, buyFree, sellFree }
 * - config: Bot configuration (market, assets, grid params, funds)
 *
 * SPECIALIZED ENGINES:
 * - accountant: Accountant instance for fund accounting
 * - strategy: StrategyEngine instance for grid rebalancing
 * - sync: SyncEngine instance for blockchain reconciliation
 * - logger: Logger instance for output
 *
 * KEY INVARIANTS:
 * - Orders are either VIRTUAL (not on blockchain) or ACTIVE (on blockchain with orderId)
 * - Committed funds = sum of ACTIVE order sizes
 * - Available funds = chainFree - virtual - applicable fees
 * - Grid always maintains price order (ascending or descending)
 * - Boundary is fixed at market start price (determines BUY/SELL sides)
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL, PIPELINE_TIMING } = require('../constants');
const {
    calculateAvailableFundsValue,
    getMinAbsoluteOrderSize,
    getAssetFees,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValue,
    floatToBlockchainInt,
    getPrecisionSlack
} = require('./utils/math');
const {
    calculatePriceTolerance,
    findMatchingGridOrderByOpenOrder,
    isOrderOnChain,
    isPhantomOrder
} = require('./utils/order');
const { persistGridSnapshot } = require('./utils/system');
const Logger = require('./logger');
const AsyncLock = require('./async_lock');
const Accountant = require('./accounting');
const StrategyEngine = require('./strategy');
const SyncEngine = require('./sync_engine');
const Grid = require('./grid');
const Format = require('./format');

class OrderManager {
    /**
     * Create a new OrderManager instance
     *
     * @param {Object} [config={}] - Configuration object
     * @param {string} [config.market] - Market identifier (e.g., "BTS/USDT")
     * @param {string} [config.assetA] - Base asset symbol
     * @param {string} [config.assetB] - Quote asset symbol
     * @param {number} [config.startPrice] - Initial market price
     * @param {number} [config.minPrice] - Minimum price for grid
     * @param {number} [config.maxPrice] - Maximum price for grid
     * @param {number} [config.incrementPercent] - Price step percentage between orders
     * @param {number} [config.targetSpreadPercent] - Spread zone width around market
     * @param {Object} [config.botFunds] - Fund allocation limits
     * @param {string|number} [config.botFunds.buy] - Buy fund limit (number or "50%")
     * @param {string|number} [config.botFunds.sell] - Sell fund limit
     * @param {Object} [config.activeOrders] - Active order count targets
     * @param {number} [config.activeOrders.buy] - Target active buy orders
     * @param {number} [config.activeOrders.sell] - Target active sell orders
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
        this.buySideIsDoubled = false;
        this.sellSideIsDoubled = false;
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = 0;
        this.assets = null;
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        this.ordersNeedingPriceCorrection = [];
        this.ordersPendingCancellation = [];
        this.shadowOrderIds = new Map();
        this._correctionsLock = new AsyncLock();
        this._syncLock = new AsyncLock();  // Prevents concurrent full-sync operations (defense-in-depth)
        this._fillProcessingLock = new AsyncLock();  // Prevents concurrent fill processing
        this._divergenceLock = new AsyncLock();  // Prevents concurrent divergence correction
        this._accountTotalsLock = new AsyncLock();  // Prevents race condition in waitForAccountTotals
        this._gridLock = new AsyncLock();  // Prevents concurrent grid mutations
        this._fundsSemaphore = new AsyncLock();  // Prevents concurrent fund updates
        this._spreadCountLock = new AsyncLock();  // Prevents concurrent spread count updates
        this._recentlyRotatedOrderIds = new Set();

        this._gridSidesUpdated = new Set();
        this._pauseFundRecalcDepth = 0;
        this._recalcLoggingDepth = 0;
        this._persistenceWarning = null;
        this._isBroadcasting = false;
        this._pipelineBlockedSince = null;  // Tracks when pipeline became blocked for timeout detection

        // Metrics for observability
        this._metrics = {
            fundRecalcCount: 0,
            invariantViolations: { buy: 0, sell: 0 },
            lockAcquisitions: 0,
            lockContentionSkips: 0,
            lastSyncDurationMs: 0,
            metricsStartTime: Date.now()
        };

        // Bootstrap flag to suppress warnings during initial grid build
        this.isBootstrapping = true;

        // Clean up any stale locks from previous process crash on startup
        this._cleanExpiredLocks();
    }

    /**
     * Start the bootstrap phase to suppress invariant warnings during complex transitions.
     */
    startBootstrap() {
        this.isBootstrapping = true;
        this.logger.log("Entering bootstrap phase. Invariant checks suppressed.", "info");
    }

    /**
     * Finish the bootstrap phase and activate grid health monitoring.
     * Validates fund state at transition point - if drift exists here, it's not transient.
     * @returns {Object} { hadDrift: boolean, driftInfo: Object|null }
     */
    finishBootstrap() {
        const result = { hadDrift: false, driftInfo: null };

        if (this.isBootstrapping) {
            this.isBootstrapping = false;

            // Validate fund state at bootstrap completion - if drift exists here,
            // it's not transient (grid is now stable) and indicates a potential bug
            const driftCheck = this.checkFundDriftAfterFills();
            if (!driftCheck.isValid) {
                result.hadDrift = true;
                result.driftInfo = driftCheck;
                this.logger.log(
                    `[BOOTSTRAP-END] Fund drift detected after bootstrap: ${driftCheck.reason}. ` +
                    `This may indicate a bug in grid initialization.`,
                    'warn'
                );
            }

            this.logger.log("Bootstrap phase complete. Grid health monitoring and fund invariants active.", "info");
        }

        return result;
    }

    // --- Accounting Delegation ---

    /**
     * Resets the funds structure to zero.
     * @returns {void}
     */
    resetFunds() { return this.accountant.resetFunds(); }

    /**
     * Deduct an amount from the optimistic chainFree balance.
     * Proxy for accountant.tryDeductFromChainFree used by dexbot_class.js.
     */
    _deductFromChainFree(orderType, size, operation) {
        return this.accountant.tryDeductFromChainFree(orderType, size, operation);
    }

    /**
     * Add an amount back to the optimistic chainFree balance.
     * Proxy for accountant.addToChainFree used by dexbot_class.js.
     */
    _addToChainFree(orderType, size, operation) {
        return this.accountant.addToChainFree(orderType, size, operation);
    }

    /**
     * Safe access to cache funds for a specific side.
     */
    _getCacheFunds(side) {
        return this.funds?.cacheFunds?.[side] || 0;
    }

    /**
     * Safe access to grid totals for a specific side.
     */
    _getGridTotal(side) {
        return (this.funds?.committed?.grid?.[side] || 0) + (this.funds?.virtual?.[side] || 0);
    }

    /**
     * Safely modify cache funds using semaphore protection.
     * @param {string} side - 'buy' or 'sell'
     * @param {number} delta - Amount to add/subtract
     * @param {string} op - Operation name
     */
    async modifyCacheFunds(side, delta, op) {
        return await this.accountant.modifyCacheFunds(side, delta, op);
    }

    /**
     * Recalculates all fund values based on current order states.
     * @returns {void}
     */
    recalculateFunds() {
        this._metrics.fundRecalcCount++;
        return this.accountant.recalculateFunds();
    }

    /**
     * Sets the broadcasting flag to suppress transient invariant warnings.
     * Call this before broadcasting active orders to prevent false-positive warnings
     * during the update window when funds are in transit.
     * @returns {void}
     */
    startBroadcasting() {
        this._isBroadcasting = true;
    }

    /**
     * Clears the broadcasting flag and resumes normal invariant validation.
     * Call this after broadcasting is complete.
     * @returns {void}
     */
    stopBroadcasting() {
        this._isBroadcasting = false;
    }

    /**
     * Get metrics for observability and monitoring.
     * @returns {Object} Metrics object.
     */
    getMetrics() {
        const now = Date.now();
        const uptime = now - this._metrics.metricsStartTime;
        return {
            ...this._metrics,
            timestamp: now,
            uptimeMs: uptime,
            fundRecalcPerMinute: Format.formatMetric2(this._metrics.fundRecalcCount / (uptime / 60000))
        };
    }

    // --- Strategy Delegation ---

    /**
     * Processes filled orders and calculates rebalancing actions.
     * @param {Array<Object>} orders - Array of filled order objects.
     * @param {Set<string>} excl - Set of order IDs to exclude from rebalancing.
     * @returns {Promise<Object>} Rebalance result.
     */
    async processFilledOrders(orders, excl) { return await this.strategy.processFilledOrders(orders, excl); }

    /**
     * Completes an order rotation by updating internal state.
     * @param {Object} oldInfo - The old order information.
     */
    completeOrderRotation(oldInfo) { return this.strategy.completeOrderRotation(oldInfo); }

    // --- Sync Delegation ---

    /**
     * Synchronizes internal state with open orders from the blockchain.
     * @param {Array<Object>} [orders] - Array of raw chain orders.
     * @param {Object} [info] - Optional metadata.
     * @returns {Object} Sync result.
     */
    syncFromOpenOrders(orders, info) { return this.sync.syncFromOpenOrders(orders, info); }

    /**
     * Synchronizes internal state from a single fill history record.
     * @param {Object} fill - The fill operation object.
     * @returns {Object} Sync result.
     */
    syncFromFillHistory(fill) { return this.sync.syncFromFillHistory(fill); }

    /**
     * Synchronizes internal state with provided blockchain data.
     * @param {Object|Array} data - Blockchain data (orders or fill).
     * @param {string} src - Source identifier for logging.
     * @returns {Promise<Object>} Sync result.
     */
    async synchronizeWithChain(data, src) { return await this.sync.synchronizeWithChain(data, src); }

    /**
     * Fetches current account balances and updates totals.
     * @returns {Promise<void>}
     * @private
     */
    async _fetchAccountBalancesAndSetTotals() { return await this.sync.fetchAccountBalancesAndSetTotals(); }

    /**
     * Initializes asset metadata (ids, symbols, precisions).
     * @returns {Promise<void>}
     * @private
     */
    async _initializeAssets() { return await this.sync.initializeAssets(); }

    // --- Controller Logic ---

    /**
     * Resolve a configuration value (absolute or percentage-based).
     * SIDE EFFECT: If value is a percentage but total is unavailable,
     * this method triggers an async fetch of account totals for future calls.
     * Use _resolveConfigValueWithAccountFetch() to handle the fetch explicitly.
     */
    _resolveConfigValue(value, total) {
        const resolved = resolveConfigValue(value, total);
        // If percentage-based but no total available, trigger background fetch
        if (resolved === 0 && typeof value === 'string' && value.trim().endsWith('%')) {
            if (total === null || total === undefined) {
                this._triggerAccountTotalsFetchIfNeeded();
            }
        }
        return resolved;
    }

    /**
     * Trigger background fetch of account totals if not already fetching.
     * Used by _resolveConfigValue() when percentage-based allocation is requested.
     * @private
     */
    _triggerAccountTotalsFetchIfNeeded() {
        if (!this._isFetchingTotals) {
            this._isFetchingTotals = true;
            this._fetchAccountBalancesAndSetTotals().finally(() => {
                this._isFetchingTotals = false;
            });
        }
    }

    /**
     * Get a snapshot of current on-chain funds.
     * @returns {Object} Fund snapshot { chainTotalBuy, chainTotalSell, allocatedBuy, allocatedSell, ... }.
     */
    getChainFundsSnapshot() {
        const totals = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = Number.isFinite(Number(this.funds?.allocated?.buy)) ? Number(this.funds.allocated.buy) : totals.chainTotalBuy;
        const allocatedSell = Number.isFinite(Number(this.funds?.allocated?.sell)) ? Number(this.funds.allocated.sell) : totals.chainTotalSell;
        return { ...totals, allocatedBuy, allocatedSell };
    }

    /**
     * Lock orders to prevent concurrent modifications during async operations.
     * Locking is a critical race condition prevention mechanism.
     *
     * WHY LOCKING IS NEEDED:
     * ========================================================================
     * The bot processes orders asynchronously from multiple sources:
     * 1. Blockchain syncs (detecting fills, price changes)
     * 2. Strategy engine (rebalancing, rotations)
     * 3. User actions (manual adjustments)
     *
     * Without locking, this sequence can occur (BAD):
     *   - Strategy: "Partial P1 looks good for rotation" → calculates rotation
     *   - Blockchain: "P1 just filled completely" → converts P1 to SPREAD
     *   - Strategy: Tries to rotate P1 (now SPREAD) → data corruption
     *
     * With locking (GOOD):
     *   - Blockchain locks P1: isOrderLocked(P1) = true
     *   - Strategy: Checks if P1 locked → skips it
     *   - Blockchain finishes P1 fill → unlocks P1
     *   - Strategy: Now can safely process P1 in next cycle
     *
     * LOCK LIFETIME:
     * Locks are temporary (default 5-10 seconds) to prevent stale locks from
     * permanently blocking orders if a process crashes. This self-healing
     * mechanism prevents deadlocks while still protecting against races.
     *
     * USAGE:
     * - Lock orders: mgr.lockOrders([orderId1, orderId2])
     * - Check if locked: mgr.isOrderLocked(orderId)
     * - Unlock: mgr.unlockOrders([orderId1, orderId2])
     *
     * BEST PRACTICE:
     * Always use try/finally to ensure unlocking happens even if error occurs:
     *   mgr.lockOrders([id]);
     *   try {
     *     // expensive operation on order
     *   } finally {
     *     mgr.unlockOrders([id]);
     *   }
     */
    lockOrders(orderIds) {
        if (!orderIds) return;
        const now = Date.now();
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, now);
        this._cleanExpiredLocks();
    }

    /**
     * Explicitly unlock orders. Locks are also automatically released after
     * LOCK_TIMEOUT_MS milliseconds (self-healing mechanism).
     */
    unlockOrders(orderIds) {
        if (!orderIds) return;
        for (const id of orderIds) if (id) this.shadowOrderIds.delete(id);
        this._cleanExpiredLocks();
    }

    /**
     * Clean up expired locks. Called after lock/unlock to remove stale locks
     * that exceeded LOCK_TIMEOUT_MS. This prevents stale locks from permanently
     * blocking orders if a process crashed while holding the lock.
     *
     * SELF-HEALING MECHANISM:
     * Even if unlockOrders() is never called (e.g., process crash), the lock
     * will automatically expire after LOCK_TIMEOUT_MS. This ensures orders
     * are never permanently blocked and trading can resume.
     */
    _cleanExpiredLocks() {
        const now = Date.now();
        for (const [id, timestamp] of this.shadowOrderIds) {
            if (now - timestamp > TIMING.LOCK_TIMEOUT_MS) this.shadowOrderIds.delete(id);
        }
    }

    /**
     * Check if an order is currently locked.
     * Also auto-expires locks that have exceeded the timeout.
     *
     * @param {string} id - Order ID to check
     * @returns {boolean} true if order is locked and within timeout window
     */
    isOrderLocked(id) {
        if (!id || !this.shadowOrderIds.has(id)) return false;
        if (Date.now() - this.shadowOrderIds.get(id) > TIMING.LOCK_TIMEOUT_MS) {
            this.shadowOrderIds.delete(id);
            return false;
        }
        return true;
    }

    /**
     * Apply bot funds allocation limits based on configuration.
     * Controls how much of total account funds the bot is allowed to use.
     *
     * ALLOCATION STRATEGY:
     * ========================================================================
     * The bot can be configured with fund limits in several ways:
     *
     * 1. ABSOLUTE amounts: botFunds.buy = 1000 (always use max 1000 units)
     * 2. PERCENTAGES: botFunds.buy = "50%" (use max 50% of account balance)
     * 3. NOT SET: No limit, use all available funds
     *
     * WHY ALLOCATION MATTERS:
     * - Prevents bot from using 100% of account, leaving room for manual trading
     * - Allows multiple bots to trade from same account with separate budgets
     * - Provides risk control: Limit losses to allocated portion if bot fails
     *
     * FUND FORMULA AFTER ALLOCATION:
     * If config.botFunds.buy = "30%" and account has 10000 total:
     *   - allocatedBuy = 3000 (30% of 10000)
     *   - funds.available.buy = min(calculated_available, 3000)
     *   - Bot can never spend more than 3000 in buy orders
     *
     * PERCENTAGE RESOLUTION:
     * Uses _resolveConfigValue() to convert percentages to absolute amounts.
     * For percentages, uses current chainTotal (account balance on blockchain)
     * as the base for calculation.
     */
    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;
        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = this._resolveConfigValue(this.config.botFunds.buy, chainTotalBuy);
        const allocatedSell = this._resolveConfigValue(this.config.botFunds.sell, chainTotalSell);
        this.funds.allocated = { buy: allocatedBuy, sell: allocatedSell };
        if (allocatedBuy > 0) this.funds.available.buy = Math.min(this.funds.available.buy, allocatedBuy);
        if (allocatedSell > 0) this.funds.available.sell = Math.min(this.funds.available.sell, allocatedSell);
    }

    /**
     * Set account totals and update fund state.
     * @param {Object} totals - Account balances.
     */
    setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        this.accountTotals = { ...this.accountTotals, ...totals };
        if (!this.funds) this.resetFunds();
        this.recalculateFunds();
        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try {
                this._accountTotalsResolve();
            } catch (e) {
                this.logger?.log?.(`Error resolving account totals promise: ${e.message}`, 'warn');
            }
            this._accountTotalsPromise = null;
            this._accountTotalsResolve = null;
        }
    }

    /**
     * Wait for account totals to be fetched from the blockchain.
     * @param {number} [timeoutMs=TIMING.ACCOUNT_TOTALS_TIMEOUT_MS] - Timeout in milliseconds.
     * @returns {Promise<void>}
     */
    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, false)) return;
        // CRITICAL: Await inside lock to prevent race where promise is created inside lock
        // but awaited outside (allowing overwrites between check and wait)
        await this._accountTotalsLock.acquire(async () => {
            // Double-check after acquiring lock
            if (hasValidAccountTotals(this.accountTotals, false)) return;
            if (!this._accountTotalsPromise) {
                this._accountTotalsPromise = new Promise((resolve) => { this._accountTotalsResolve = resolve; });
            }
            // Await inside lock to ensure atomic creation and wait (prevents promise overwrite race)
            await Promise.race([this._accountTotalsPromise, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
        });
    }

    /**
     * Fetch account totals from the blockchain.
     * @param {string} [accountId] - Account ID to fetch for.
     * @returns {Promise<void>}
     */
    async fetchAccountTotals(accountId) {
        if (accountId) this.accountId = accountId;
        await this._fetchAccountBalancesAndSetTotals();
    }

    /**
     * Update or insert an order into the manager's state, maintaining all indices.
     * This is the CENTRAL STATE TRANSITION mechanism for the order system.
     * 
     * STATE TRANSITIONS (the valid flows):
     * =========================================================================
     * VIRTUAL: The initial state for all orders. No on-chain existence.
     *   → ACTIVE: Order is activated for on-chain placement. Funds become locked.
     *   → SPREAD: After a fill, order becomes a placeholder for future rebalancing.
     * 
     * ACTIVE: Order is on-chain with an orderId. Funds are locked/committed.
     *   → PARTIAL: Order fills partially. Remaining size is tracked for rebalancing.
     *   → VIRTUAL: Order is cancelled/rotated. Becomes eligible for re-use.
     *   → SPREAD: Order is cancelled/rotated after being filled. Becomes placeholder.
     * 
     * PARTIAL: Order has partially filled and is waiting for consolidation or rotation.
     *   → ACTIVE: Upgraded by multi-partial consolidation (if size >= 100% of ideal).
     *   → VIRTUAL: Consolidated and moved. Returns to virtual pool.
     *   → SPREAD: Order absorbed or consolidated, converted to placeholder.
     * 
     * CRITICAL RULE - Size determines ACTIVE vs PARTIAL:
     * When an order size < 100% of its slot's ideal size (determined by grid geometry),
     * it MUST be in PARTIAL state, not ACTIVE. This prevents orders from being stuck
     * in the wrong state after partial fills.
     * 
     * FUND DEDUCTION RULES (fund tracking via state change):
     * - VIRTUAL → ACTIVE: Funds are deducted from chainFree (become locked)
     * - ACTIVE → VIRTUAL: Funds are added back to chainFree (become free)
     * - ACTIVE → PARTIAL: Partial fills reduce chainFree based on filled amount
     * - PARTIAL → ACTIVE: Consolidation may lock additional funds if upgrading
     * 
     * INDEX MAINTENANCE:
     * This method maintains three critical indices for O(1) lookups:
     * 1. _ordersByState: Groups orders by state (VIRTUAL, ACTIVE, PARTIAL)
     * 2. _ordersByType: Groups orders by type (BUY, SELL, SPREAD)
     * 3. orders: Central Map storing the order object data
     * 
     * IMPORTANT: Always call this method instead of directly modifying this.orders
     * to ensure indices remain consistent. Inconsistent indices can cause:
     * - Missed orders during rebalancing
     * - Incorrect fund calculations
     * - Stuck orders in wrong states
     * 
     * @param {Object} order - Updated order object (must contain id)
     * @param {string} [context='updateOrder'] - Source of the update for logging
     * @param {boolean} [skipAccounting=false] - If true, do not update optimistic balances
     * @param {number} [fee=0] - Blockchain fee to record if this is a placement/update
     * @returns {void}
     */
    _updateOrder(order, context = 'updateOrder', skipAccounting = false, fee = 0) {
        if (!order || !order.id) {
            this.logger.log('Refusing to update order: missing ID', 'error');
            return;
        }

        const id = order.id;
        const oldOrder = this.orders.get(id);

        // Validation: Prevent SPREAD orders from becoming ACTIVE/PARTIAL
        if (order.type === ORDER_TYPES.SPREAD && isOrderOnChain(order)) {
            this.logger.log(`ILLEGAL STATE: Refusing to move SPREAD order ${id} to ${order.state}. SPREAD orders must remain VIRTUAL.`, 'error');
            return;
        }

        // CRITICAL VALIDATION: Prevent phantom orders (ACTIVE/PARTIAL without orderId)
        // This is a defense-in-depth check to catch bugs in any module that might try to
        // create an ACTIVE or PARTIAL order without a corresponding blockchain order ID.
        if (isPhantomOrder(order)) {
            this.logger.log(
                `ILLEGAL STATE: Refusing to set order ${id} to ${order.state} without orderId. ` +
                `Context: ${context}. This would create a phantom order that doubles fund tracking. ` +
                `Downgrading to VIRTUAL instead.`,
                'error'
            );
            // Auto-correct to VIRTUAL to prevent fund tracking corruption
            // NOTE: Keep the size - VIRTUAL orders can have non-zero sizes (planned placements)
            // Only SPREAD orders should have size 0
            order.state = ORDER_STATES.VIRTUAL;
        }

        // 1. Update optimistic balance (atomic update of tracked funds)
        if (this.accountant) {
            this.accountant.updateOptimisticFreeBalance(oldOrder, order, context, fee, skipAccounting);
        }

        // 2. Clone the order to prevent external modification races
        const updatedOrder = { ...order };

        // 3. Robust index maintenance
        Object.values(this._ordersByState).forEach(set => set.delete(id));
        Object.values(this._ordersByType).forEach(set => set.delete(id));

        if (this._ordersByState[updatedOrder.state]) {
            this._ordersByState[updatedOrder.state].add(id);
        }
        if (this._ordersByType[updatedOrder.type]) {
            this._ordersByType[updatedOrder.type].add(id);
        }

        this.orders.set(id, updatedOrder);

        // 4. Recalculate funds if not in a batch pause
        if (this._pauseFundRecalcDepth === 0) {
            this.recalculateFunds();
        }
    }

    /**
     * Log current available and cache funds.
 * @param {string} [label=''] - Label for the log message.
 * @private
 */
    _logAvailable(label = '') {
        const avail = this.funds?.available || { buy: 0, sell: 0 };
        const cache = this.funds?.cacheFunds || { buy: 0, sell: 0 };
        this.logger.log(`Available [${label}]: buy=${Format.formatAmount8(avail.buy || 0)}, sell=${Format.formatAmount8(avail.sell || 0)}, cacheFunds buy=${Format.formatAmount8(cache.buy || 0)}, sell=${Format.formatAmount8(cache.sell || 0)}`, 'info');
    }

    /**
     * Pause fund recalculation during batch order updates.
     * Uses a depth counter to safely support nested pauses.
     * Use with resumeFundRecalc() to optimize multi-order operations.
     *
     * NESTING EXAMPLE:
     *   pauseFundRecalc();      // depth = 1
     *   pauseFundRecalc();      // depth = 2
     *   resumeFundRecalc();     // depth = 1 (recalc NOT called)
     *   resumeFundRecalc();     // depth = 0 (recalc IS called)
     */
    pauseFundRecalc() {
        this._pauseFundRecalcDepth++;
    }

    /**
     * Resume fund recalculation after batch updates.
     * Recalculate only happens when depth reaches 0 (all pauses resolved).
     * All orders updated during pause are now reflected in fund calculations.
     */
    resumeFundRecalc() {
        if (this._pauseFundRecalcDepth > 0) {
            this._pauseFundRecalcDepth--;
        }
        if (this._pauseFundRecalcDepth === 0) {
            this.recalculateFunds();
        }
    }

    /**
     * Pause recalculation logging during high-frequency operations.
     * Uses a depth counter to safely support nested pauses.
     * Use with resumeRecalcLogging() to optimize grid initialization.
     */
    pauseRecalcLogging() {
        this._recalcLoggingDepth++;
    }

    /**
     * Resume recalculation logging after high-frequency operations.
     */
    resumeRecalcLogging() {
        if (this._recalcLoggingDepth > 0) {
            this._recalcLoggingDepth--;
        }
    }

    /**
     * Proxy for accountant._verifyFundInvariants.
     */
    _verifyFundInvariants(chainFreeBuy, chainFreeSell, chainBuy, chainSell) {
        return this.accountant._verifyFundInvariants(this, chainFreeBuy, chainFreeSell, chainBuy, chainSell);
    }

    /**
     * Identifies which virtual orders should be activated on-chain initially.

     * @returns {Array<Object>} Array of orders to activate.
     */
    getInitialOrdersToActivate() {
        const sellCountRaw = Math.max(0, Number(this.config.activeOrders?.sell || 1));
        const buyCountRaw = Math.max(0, Number(this.config.activeOrders?.buy || 1));

        const sellCount = this.sellSideIsDoubled ? Math.max(1, sellCountRaw - 1) : sellCountRaw;
        const buyCount = this.buySideIsDoubled ? Math.max(1, buyCountRaw - 1) : buyCountRaw;

        const minSellSize = getMinAbsoluteOrderSize(ORDER_TYPES.SELL, this.assets);
        const minBuySize = getMinAbsoluteOrderSize(ORDER_TYPES.BUY, this.assets);

        // Use integer arithmetic for size comparisons to match blockchain behavior
        const sellPrecision = this.assets?.assetA?.precision;
        const buyPrecision = this.assets?.assetB?.precision;
        const minSellSizeInt = floatToBlockchainInt(minSellSize, sellPrecision);
        const minBuySizeInt = floatToBlockchainInt(minBuySize, buyPrecision);

        const vSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL).sort((a, b) => a.price - b.price).slice(0, sellCount);
        const validSells = vSells.filter(o => floatToBlockchainInt(o.size, sellPrecision) >= minSellSizeInt).sort((a, b) => b.price - a.price);

        const vBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL).sort((a, b) => b.price - a.price).slice(0, buyCount);
        const validBuys = vBuys.filter(o => floatToBlockchainInt(o.size, buyPrecision) >= minBuySizeInt).sort((a, b) => a.price - b.price);

        return [...validSells, ...validBuys];
    }

    /**
     * Retrieves orders filtered by type and/or state.
     * @param {string|null} type - ORDER_TYPES value or null for all types.
     * @param {string|null} state - ORDER_STATES value or null for all states.
     * @returns {Array<Object>} Filtered array of orders.
     */
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

    /**
     * Validate that all order indices are consistent with the orders Map.
     * Use this for debugging if index corruption is suspected.
     * @returns {boolean} true if all indices are valid, false if corruption detected
     */
    validateIndices() {
        for (const [id, order] of this.orders) {
            if (!order) {
                this.logger.log(`Index corruption: ${id} exists in orders Map but is null/undefined`, 'error');
                return false;
            }
            if (!order.state) {
                this.logger.log(`Index corruption: ${id} has no state`, 'error');
                return false;
            }
            if (!order.type) {
                this.logger.log(`Index corruption: ${id} has no type`, 'error');
                return false;
            }
            if (!this._ordersByState[order.state]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByState[${order.state}]`, 'error');
                return false;
            }
            if (!this._ordersByType[order.type]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByType[${order.type}]`, 'error');
                return false;
            }
        }

        // Also check that indices don't reference orders that don't exist
        for (const [state, orderIds] of Object.entries(this._ordersByState)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByState[${state}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        for (const [type, orderIds] of Object.entries(this._ordersByType)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByType[${type}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Perform a defensive index consistency check and repair if possible.
     * Call this after critical operations or periodically as a safety measure.
     * THREAD-SAFE: Does not modify orders, only validates/logs
     * @returns {boolean} true if indices are valid, false if corruption found
     */
    assertIndexConsistency() {
        if (!this.validateIndices()) {
            this.logger.log('CRITICAL: Index corruption detected! Attempting repair...', 'error');
            return this._repairIndices();
        }
        return true;
    }

    /**
     * Repair indices by rebuilding them from the orders Map.
     * ONLY call this if corruption is detected - rebuilds both index sets.
     * @returns {boolean} true if repair succeeded, false if structure is damaged
     */
    _repairIndices() {
        try {
            // Clear and rebuild all indices
            for (const set of Object.values(this._ordersByState)) set.clear();
            for (const set of Object.values(this._ordersByType)) set.clear();

            // Rebuild from orders Map
            for (const [id, order] of this.orders) {
                if (order && order.state && order.type) {
                    this._ordersByState[order.state]?.add(id);
                    this._ordersByType[order.type]?.add(id);
                } else {
                    this.logger.log(`Skipping corrupted order ${id} during index repair`, 'warn');
                }
            }

            // Verify repair worked
            if (this.validateIndices()) {
                this.logger.log('✓ Index repair successful', 'info');
                return true;
            } else {
                this.logger.log('✗ Index repair failed - structure is damaged', 'error');
                return false;
            }
        } catch (e) {
            this.logger.log(`Index repair failed with exception: ${e.message}`, 'error');
            return false;
        }
    }

    /**
     * Get all PARTIAL orders of a given type that are NOT locked.
     */
    getPartialOrdersOnSide(type) {
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter(o => !this.isOrderLocked(o.id) && !this.isOrderLocked(o.orderId));
    }

    async checkSpreadCondition(BitShares, batchCb) {
        return await Grid.checkSpreadCondition(this, BitShares, batchCb);
    }

    async checkGridHealth(batchCb) {
        return await Grid.checkGridHealth(this, batchCb);
    }

    /**
     * Check if the processing pipeline is empty (no pending fills, corrections, or grid updates).
     * Pure query method - does not modify state. Use clearStalePipelineOperations() to handle timeouts.
     * @param {number} [incomingFillQueueLength=0] - Length of incoming fill queue (from dexbot)
     * @returns {Object} { isEmpty: boolean, reasons: string[] }
     */
    isPipelineEmpty(incomingFillQueueLength = 0) {
        const reasons = [];

        if (incomingFillQueueLength > 0) {
            reasons.push(`${incomingFillQueueLength} fills queued`);
        }

        if (this.ordersNeedingPriceCorrection.length > 0) {
            reasons.push(`${this.ordersNeedingPriceCorrection.length} corrections pending`);
        }

        if (this._gridSidesUpdated && this._gridSidesUpdated.size > 0) {
            reasons.push('grid divergence corrections pending');
        }

        // Update blocked timestamp tracking
        if (reasons.length > 0 && !this._pipelineBlockedSince) {
            this._pipelineBlockedSince = Date.now();
        } else if (reasons.length === 0) {
            this._pipelineBlockedSince = null;
        }

        return {
            isEmpty: reasons.length === 0,
            reasons
        };
    }

    /**
     * Clear stale pipeline operations that have been blocked beyond the timeout threshold.
     * Call this before maintenance operations to prevent indefinite blocking from stuck operations.
     *
     * IMPORTANT: This clears pending corrections/flags without retrying them. Only use when
     * the pipeline has been blocked long enough that the operations are presumed stuck.
     *
     * @returns {boolean} True if any stale operations were cleared
     */
    clearStalePipelineOperations() {
        if (!this._pipelineBlockedSince) {
            return false;  // Pipeline not blocked, nothing to clear
        }

        const age = Date.now() - this._pipelineBlockedSince;
        if (age < PIPELINE_TIMING.TIMEOUT_MS) {
            return false;  // Not yet timed out
        }

        let cleared = false;

        if (this.ordersNeedingPriceCorrection.length > 0) {
            this.logger?.log?.(
                `⚠️  PIPELINE TIMEOUT: Corrections stuck for ${Math.round(age/1000)}s. ` +
                `Clearing ${this.ordersNeedingPriceCorrection.length} pending corrections.`,
                'warn'
            );
            this.ordersNeedingPriceCorrection = [];
            cleared = true;
        }

        if (this._gridSidesUpdated && this._gridSidesUpdated.size > 0) {
            this.logger?.log?.(
                `⚠️  PIPELINE TIMEOUT: Grid flags stuck for ${Math.round(age/1000)}s. ` +
                `Clearing flags for sides: ${Array.from(this._gridSidesUpdated).join(', ')}`,
                'warn'
            );
            this._gridSidesUpdated.clear();
            cleared = true;
        }

        if (cleared) {
            this._pipelineBlockedSince = null;  // Reset after clearing
        }

        return cleared;
    }

    /**
     * Get pipeline health diagnostics for monitoring and troubleshooting.
     * Pure query method - provides timing information about pending operations.
     * @returns {Object} Pipeline status with diagnostic details
     */
    getPipelineHealth() {
        const correctionsPending = this.ordersNeedingPriceCorrection.length;
        const gridSidesUpdated = this._gridSidesUpdated ? Array.from(this._gridSidesUpdated) : [];
        const blockedDuration = this._pipelineBlockedSince ? Date.now() - this._pipelineBlockedSince : 0;

        const reasons = [];
        if (correctionsPending > 0) reasons.push(`${correctionsPending} corrections pending`);
        if (gridSidesUpdated.length > 0) reasons.push('grid divergence corrections pending');

        return {
            isEmpty: reasons.length === 0,
            reasons,
            blockedSince: this._pipelineBlockedSince,
            blockedDurationMs: blockedDuration,
            blockedDurationHuman: blockedDuration > 0 ? `${Math.round(blockedDuration/1000)}s` : 'N/A',
            correctionsPending,
            gridSidesUpdated
        };
    }

    calculateCurrentSpread() {
        return Grid.calculateCurrentSpread(this);
    }

    /**
     * Layer 2: Stabilization gate - Check if fund invariants are satisfied after fill processing.
     * This prevents cascade corruption from spreading to rebalancing operations.
     *
     * Compares expected funds (grid + free from blockchain) vs actual blockchain totals,
     * using the same logic as accounting._verifyFundInvariants() but returns result instead of logging.
     *
     * @returns {Object} { isValid: boolean, driftBuy: number, driftSell: number, reason: string }
     */
    checkFundDriftAfterFills() {
        const { GRID_LIMITS } = require('../constants');
        const Format = require('./format');

        // Get grid allocation and free balance from blockchain
        let gridBuy = 0, gridSell = 0;
        for (const order of Array.from(this.orders.values())) {
            const size = Number(order.size) || 0;
            if (size <= 0 || !isOrderOnChain(order)) continue;

            if (order.type === 'buy') gridBuy += size;
            else if (order.type === 'sell') gridSell += size;
        }

        const chainFreeBuy = this.accountTotals?.buyFree || 0;
        const chainFreeSell = this.accountTotals?.sellFree || 0;
        const actualBuy = this.accountTotals?.buy || 0;
        const actualSell = this.accountTotals?.sell || 0;

        // Calculate expected totals based on current grid state
        const expectedBuy = chainFreeBuy + gridBuy;
        const expectedSell = chainFreeSell + gridSell;

        // Compute drift
        const driftBuy = Math.abs(actualBuy - expectedBuy);
        const driftSell = Math.abs(actualSell - expectedSell);

        // Calculate precision tolerances
        const buyPrecision = this.assets?.assetB?.precision || 8;
        const sellPrecision = this.assets?.assetA?.precision || 8;
        const precisionSlackBuy = getPrecisionSlack(buyPrecision);
        const precisionSlackSell = getPrecisionSlack(sellPrecision);
        const percentTolerance = (GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE || 0.1) / 100;

        const allowedDriftBuy = Math.max(precisionSlackBuy, actualBuy * percentTolerance);
        const allowedDriftSell = Math.max(precisionSlackSell, actualSell * percentTolerance);

        const buyOk = driftBuy <= allowedDriftBuy;
        const sellOk = driftSell <= allowedDriftSell;

        return {
            isValid: buyOk && sellOk,
            driftBuy,
            driftSell,
            allowedDriftBuy,
            allowedDriftSell,
            reason: !buyOk ? `BUY drift ${Format.formatAmount8(driftBuy)} > ${Format.formatAmount8(allowedDriftBuy)}` :
                    !sellOk ? `SELL drift ${Format.formatAmount8(driftSell)} > ${Format.formatAmount8(allowedDriftSell)}` : null
        };
    }

    /**
     * Validates grid state before persistence.
     * Single validation gate that prevents corrupted state from being saved.
     *
     * @returns {Object} { isValid: boolean, reason: string|null }
     */
    validateGridStateForPersistence() {
        const mgr = this;

        // Check 1: Fund drift validation (existing Layer 2 logic)
        const driftCheck = this.checkFundDriftAfterFills();
        if (!driftCheck.isValid) {
            if (this.isBootstrapping) {
                // Log for observability but don't block - temporary drift expected during bootstrap
                this.logger.log(
                    `[BOOTSTRAP] Transient fund drift (expected): ${driftCheck.reason}`,
                    'debug'
                );
            } else {
                return {
                    isValid: false,
                    reason: `Fund invariant violated: ${driftCheck.reason}`
                };
            }
        }

        // Check 2: Phantom order detection
        for (const order of mgr.orders.values()) {
            if (isPhantomOrder(order)) {
                return {
                    isValid: false,
                    reason: `Phantom order detected: order ${order.id} is ${order.state} but has no orderId`
                };
            }
        }

        // Check 3: Account totals initialized
        if (!hasValidAccountTotals(mgr.accountTotals)) {
            return {
                isValid: false,
                reason: 'Account totals not initialized'
            };
        }

        return { isValid: true, reason: null };
    }

    /**
     * Generic retry wrapper for persistence operations.
     * Handles transient failures gracefully without crashing.
     */
    async _persistWithRetry(persistFn, dataType, dataValue, maxAttempts = 3) {
        if (!this.config || !this.config.botKey || !this.accountOrders) {
            return true;  // Can't persist, but that's ok (e.g., dry run)
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await persistFn();  // Execute the persistence function
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
                    this._persistenceWarning = { dataType, error: e.message, timestamp: Date.now() };
                    return false;
                } else {
                    // Retry with exponential backoff (capped at TIMING.ACCOUNT_TOTALS_TIMEOUT_MS)
                    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), TIMING.ACCOUNT_TOTALS_TIMEOUT_MS);
                    this.logger.log(`Attempt ${attempt}/${maxAttempts} to persist ${dataType} failed: ${e.message}. Retrying in ${delayMs}ms...`, 'warn');
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }
        return false;
    }

        /**
         * Unified persistence for grid state and fund metadata.
         * Delegates to OrderUtils.persistGridSnapshot for centralized handling.
         */
        async persistGrid() {
        // CRITICAL: Validate grid state before persistence
        const validation = this.validateGridStateForPersistence();
        if (!validation.isValid) {
            this.logger.log(
                `[PERSISTENCE-GATE] Skipping persistence of corrupted state: ${validation.reason}`,
                'warn'
            );
            return validation; // Return validation result for caller to handle
        }

        await persistGridSnapshot(this, this.accountOrders, this.config.botKey);
        return validation; // Return successful validation
    }
}

module.exports = { OrderManager };
