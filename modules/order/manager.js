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
 * TABLE OF CONTENTS - OrderManager Class (55 methods)
 * ===============================================================================
 *
 * INITIALIZATION & LIFECYCLE (4 methods)
 *   1. constructor(config) - Create new OrderManager with engines and indices
 *   2. startBootstrap() - Mark bootstrap phase start
 *   3. finishBootstrap() - Mark bootstrap phase complete
 *   4. resetFunds() - Reset funds structure to zeroed values
 *
 * FUND MANAGEMENT (10 methods)
 *   5. _deductFromChainFree(orderType, size, operation) - Deduct from free balance (internal)
 *   6. _addToChainFree(orderType, size, operation) - Add to free balance (internal)
 *   7. _getCacheFunds(side) - Get cache funds for side
 *   8. _getGridTotal(side) - Get total grid allocation
 *   9. modifyCacheFunds(side, delta, op) - Modify cache funds (async)
 *   10. recalculateFunds() - Master recalculation of all fund values
 *   11. getChainFundsSnapshot() - Get snapshot of fund state
 *   12. applyBotFundsAllocation() - Apply fund allocation percentages
 *   13. setAccountTotals(totals) - Set blockchain account totals
 *   14. getMetrics() - Get performance metrics
 *
 * ACCOUNT TOTALS & SYNCHRONIZATION (6 methods - async)
 *   15. waitForAccountTotals(timeoutMs) - Wait for account totals to be set (async)
 *   16. fetchAccountTotals(accountId) - Fetch account balances from blockchain (async)
 *   17. syncFromOpenOrders(orders, info) - Sync grid from open orders (delegate)
 *   18. syncFromFillHistory(fill) - Sync from fill event (delegate)
 *   19. synchronizeWithChain(data, src) - Full chain synchronization (delegate, async)
 *   20. _fetchAccountBalancesAndSetTotals() - Fetch totals and trigger recalc (internal, async)
 *
 * BLOCKCHAIN SETUP (1 method - async)
 *   21. _initializeAssets() - Initialize asset metadata (internal, async)
 *
 * BROADCASTING (2 methods)
 *   22. startBroadcasting() - Start order broadcast operations
 *   23. stopBroadcasting() - Stop order broadcast operations
 *
 * ORDER OPERATIONS (2 methods)
 *   24. _updateOrder(order, context, skipAccounting, fee) - Update order state internally (async)
 *   25. performSafeRebalance(fills, excludeIds) - Safe rebalance pipeline (async)
 *
 * STRATEGY DELEGATION (3 methods)
 *   27. processFilledOrders(orders, excl, options) - Process filled orders (delegate, async)
 *   28. completeOrderRotation(oldInfo) - Complete order rotation (delegate)
 *   29. _verifyFundInvariants(chainFreeBuy, chainFreeSell, chainBuy, chainSell) - Verify fund invariants
 *
 * ORDER QUERIES (3 methods)
 *   29. getInitialOrdersToActivate() - Get orders ready for activation
 *   30. getOrdersByTypeAndState(type, state) - Query orders by type and state
 *   31. getPartialOrdersOnSide(type) - Get partial orders on side
 *
 * ORDER LOCKING (4 methods)
 *   32. lockOrders(orderIds) - Lock orders to prevent concurrent modification
 *   33. unlockOrders(orderIds) - Unlock orders
 *   34. isOrderLocked(id) - Check if order is locked
 *   35. _cleanExpiredLocks() - Clean expired lock entries (internal)
 *
 * INDEX MANAGEMENT (3 methods)
 *   36. validateIndices() - Validate index consistency with orders
 *   37. assertIndexConsistency() - Assert indices match orders (throws on mismatch)
 *   38. _repairIndices() - Repair corrupted indices (internal)
 *
 * CONFIGURATION & RESOLUTION (1 method)
 *   39. _triggerAccountTotalsFetchIfNeeded() - Fetch totals if stale
 *
 * RECALC CONTROL (4 methods)
 *   41. pauseFundRecalc() - Pause automatic fund recalculation
 *   42. resumeFundRecalc() - Resume fund recalculation
 *   43. pauseRecalcLogging() - Pause recalculation logging
 *   44. resumeRecalcLogging() - Resume recalculation logging
 *
 * SIGNAL HANDLING (2 methods)
 *   45. consumeIllegalStateSignal() - Consume and reset illegal state signal
 *   46. consumeAccountingFailureSignal() - Consume and reset accounting failure signal
 *
 * GRID HEALTH & DIAGNOSTICS (4 methods - async)
 *   47. checkSpreadCondition(BitShares, batchCb) - Check and flag spread condition (async)
 *   48. checkGridHealth(batchCb) - Monitor grid health (async)
 *   49. calculateCurrentSpread() - Calculate current bid-ask spread
 *   50. checkFundDriftAfterFills() - Check fund drift tracking
 *
 * PIPELINE MANAGEMENT (3 methods)
 *   51. isPipelineEmpty(incomingFillQueueLength) - Check if operation pipeline is empty
 *   52. clearStalePipelineOperations() - Clear stale pipeline operations
 *   53. getPipelineHealth() - Get pipeline health metrics
 *
 * PERSISTENCE & VALIDATION (2 methods - async)
 *   54. validateGridStateForPersistence() - Validate grid before persistence
 *   55. persistGrid() - Persist grid snapshot to storage (async)
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
    getMinAbsoluteOrderSize,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValue,
    isExplicitZeroAllocation,
    floatToBlockchainInt,
    getPrecisionSlack
} = require('./utils/math');
const {
    isOrderOnChain,
    isPhantomOrder,
    hasOnChainId,
    convertToSpreadPlaceholder
} = require('./utils/order');
const { persistGridSnapshot, deepFreeze, cloneMap } = require('./utils/system');
const { WorkingGrid } = require('./working_grid');
const Logger = require('./logger');
const AsyncLock = require('./async_lock');
const Accountant = require('./accounting');
const StrategyEngine = require('./strategy');
const SyncEngine = require('./sync_engine');
const Grid = require('./grid');
const Format = require('./format');

const VALID_ORDER_STATES = new Set(Object.values(ORDER_STATES));
const VALID_ORDER_TYPES = new Set(Object.values(ORDER_TYPES));
const SYNC_SOURCES_MANAGE_OWN_GRID_LOCK = new Set(['readOpenOrders', 'periodicBlockchainFetch']);

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
        this.orders = Object.freeze(new Map()); // Immutable Master Grid
        this.boundaryIdx = null;
        this.targetGrid = null; // Desired state from strategy

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
        // Map<orderId, expiresAtMs> shadow locks for concurrent-operation shielding.
        this.shadowOrderIds = new Map();
        this._syncLock = new AsyncLock();  // Prevents concurrent full-sync operations
        this._fillProcessingLock = new AsyncLock(); // Prevents concurrent fill processing
        this._divergenceLock = new AsyncLock(); // Prevents concurrent divergence correction
        this._gridLock = new AsyncLock();  // Prevents concurrent grid mutations
        this._fundLock = new AsyncLock({ timeout: 30000 });  // Prevents concurrent fund updates
        this._recentlyRotatedOrderIds = new Set();

        this._gridSidesUpdated = new Set();
        this._pauseFundRecalc = false;
        this._pauseRecalcLogging = false;
        this._isBroadcasting = false;
        // SCOPE CONSTRAINT: _throwOnIllegalState must only be set to true inside the
        // _fillProcessingLock critical section (i.e. within updateOrdersOnChainBatch and
        // its retry path). Setting it outside that lock risks unexpected throws from
        // concurrent async contexts (e.g. syncFromOpenOrders called by fill listeners).
        this._throwOnIllegalState = false;
        this._lastIllegalState = null;
        this._lastAccountingFailure = null;
        this._pipelineBlockedSince = null;  // Tracks when pipeline became blocked for timeout detection
        this._recoveryAttempted = false;    // Tracks if recovery has been attempted in the current cycle
        this._recoveryState = {
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0
        };
        this._gridVersion = 0;
        this._gridRegenState = {
            buy: { armed: true, lastTriggeredAt: 0 },
            sell: { armed: true, lastTriggeredAt: 0 }
        };

        // Metrics for observability
        this._metrics = {
            fundRecalcCount: 0,
            invariantViolations: { buy: 0, sell: 0 },
            lockAcquisitions: 0,
            lockContentionSkips: 0,
            spreadRoleConversionBlocked: 0,
            lastSyncDurationMs: 0,
            metricsStartTime: Date.now()
        };

        // Bootstrap flag to suppress warnings during initial grid build
        this.isBootstrapping = true;

        // Copy-on-Write (COW) infrastructure
        this._rebalanceState = 'NORMAL'; // NORMAL | REBALANCING | BROADCASTING
        this._currentWorkingGrid = null; // Track working grid during rebalance for fill sync

        // Clean up any stale locks from previous process crash on startup
        this._cleanExpiredLocks();
    }

    /**
     * Clear working grid reference and reset rebalance state.
     * Centralized cleanup for error paths and successful commits.
     * @private
     */
    _clearWorkingGridRef() {
        this._currentWorkingGrid = null;
        this._setRebalanceState('NORMAL');
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
     * CRITICAL: Now async - must be awaited by callers.
     */
    async _deductFromChainFree(orderType, size, operation) {
         return await this.accountant.tryDeductFromChainFree(orderType, size, operation);
    }

    /**
     * Add an amount back to the optimistic chainFree balance.
     * Proxy for accountant.addToChainFree used by dexbot_class.js.
     * CRITICAL: Now async - must be awaited by callers.
     */
    async _addToChainFree(orderType, size, operation) {
         return await this.accountant.addToChainFree(orderType, size, operation);
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
     * Atomically set cache funds for one side.
     * @param {string} side - 'buy' or 'sell'
     * @param {number} value - Absolute cache value
     * @param {string} op - Operation label for logging
     * @returns {Promise<number>} New cache value
     */
    async setCacheFundsAbsolute(side, value, op = 'set-absolute') {
        return await this.accountant.setCacheFundsAbsolute(side, value, op);
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
     * Process filled orders using the new safe rebalance pipeline.
     * 
     * This method implements a two-phase approach:
     * 1. Process fills (Accountant update, logging, fund recalculation)
     * 2. Conditionally perform Safe Rebalance (Calc -> Validate -> Execute)
     *
     * Rebalancing is triggered when:
     * - Non-partial fills occur (actual order completions)
     * - Dual-side dust partials are detected (unhealthy state on both sides)
     *
     * @param {Array<Object>} orders - Array of filled order objects with fill metadata
     * @param {Set<string>} excl - Set of order IDs to exclude from processing
     * @param {Object} [options] - Optional processing flags passed to StrategyEngine
     * @param {boolean} [options.skipRebalance] - If true, skip rebalance even if fills occur
     * @returns {Promise<Object>} Rebalance result containing:
     *   - actions {Array}: List of actions to execute (create, update, cancel)
     *   - stateUpdates {Array}: Predicted state changes for optimistic UI updates
     *   - hadRotation {boolean}: Whether any orders were rotated/placed/updated
     * @async
     */
    async processFilledOrders(orders, excl, options) { 
        // Step 1: Handle Fills (Accounting & State Updates)
        await this.strategy.processFilledOrders(orders, excl, options);
        
        // Step 2: Trigger Safe Rebalance
        // Criteria for rebalance:
        // 1. We have actual fills (non-partial)
        // 2. We have dual-side dust (unhealthy partials on both sides)
        const triggerFills = orders.filter(f => !f.isPartial || f.isDelayedRotationTrigger || f.isDoubleReplacementTrigger);
        let shouldRebalance = triggerFills.length > 0;

        if (!shouldRebalance) {
            const allOrders = Array.from(this.orders.values());
            const { getPartialsByType } = require('./utils/order');
            const { buy: buyPartials, sell: sellPartials } = getPartialsByType(allOrders);

            if (buyPartials.length > 0 && sellPartials.length > 0) {
                const buyHasDust = this.strategy.hasAnyDust(buyPartials, "buy");
                const sellHasDust = this.strategy.hasAnyDust(sellPartials, "sell");

                if (buyHasDust && sellHasDust) {
                    this.logger.log("[BOUNDARY] Dual-side dust partials detected. Triggering rebalance.", "info");
                    shouldRebalance = true;
                }
            }
        }

        if (shouldRebalance) {
            const rebalanceResult = await this.performSafeRebalance(orders, excl);
            return rebalanceResult;
        }

        return { actions: [], stateUpdates: [], hadRotation: false };
    }

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
     * PUBLIC API: Acquires _gridLock before delegating to sync engine.
     * NOTE: readOpenOrders/periodicBlockchainFetch manage _gridLock inside SyncEngine
     * to avoid nested non-reentrant lock acquisition.
     * 
     * @param {Object|Array} data - Blockchain data (orders or fill).
     * @param {string} src - Source identifier for logging.
     * @returns {Promise<Object>} Sync result.
     */
    async synchronizeWithChain(data, src) {
        if (SYNC_SOURCES_MANAGE_OWN_GRID_LOCK.has(src)) {
            return await this._applySync(data, src);
        }
        return await this._gridLock.acquire(async () => {
            return await this._applySync(data, src);
        });
    }

    /**
     * Internal logic for synchronization.
     * PRIVATE: Must be called while holding _gridLock.
     */
    async _applySync(data, src) {
        return await this.sync.synchronizeWithChain(data, src);
    }

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
     * Trigger background fetch of account totals if not already fetching.
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
        const expiresAt = Date.now() + TIMING.LOCK_TIMEOUT_MS;
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, expiresAt);
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
     * Clean up expired locks and pending actions. Called after lock/unlock to remove stale entries
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
        for (const [id, expiresAt] of this.shadowOrderIds) {
            if (now > expiresAt) this.shadowOrderIds.delete(id);
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
        if (Date.now() > this.shadowOrderIds.get(id)) {
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
     * Uses resolveConfigValue() to convert percentages to absolute amounts.
     * For percentages, uses current chainTotal (account balance on blockchain)
     * as the base for calculation.
     */
    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;
        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        
        const allocatedBuy = resolveConfigValue(this.config.botFunds.buy, chainTotalBuy);
        const allocatedSell = resolveConfigValue(this.config.botFunds.sell, chainTotalSell);

        // If percentage-based but no total available, trigger background fetch
        if (allocatedBuy === 0 && typeof this.config.botFunds.buy === 'string' && this.config.botFunds.buy.trim().endsWith('%')) {
            if (chainTotalBuy === 0) this._triggerAccountTotalsFetchIfNeeded();
        }
        if (allocatedSell === 0 && typeof this.config.botFunds.sell === 'string' && this.config.botFunds.sell.trim().endsWith('%')) {
            if (chainTotalSell === 0) this._triggerAccountTotalsFetchIfNeeded();
        }

        this.funds.allocated = { buy: allocatedBuy, sell: allocatedSell };

        // Keep legacy behavior for non-positive dynamic resolutions, while allowing explicit 0 to disable a side.
        const shouldCapBuy = allocatedBuy > 0 || isExplicitZeroAllocation(this.config.botFunds.buy);
        const shouldCapSell = allocatedSell > 0 || isExplicitZeroAllocation(this.config.botFunds.sell);

        if (shouldCapBuy) this.funds.available.buy = Math.min(this.funds.available.buy, Math.max(0, allocatedBuy));
        if (shouldCapSell) this.funds.available.sell = Math.min(this.funds.available.sell, Math.max(0, allocatedSell));
    }

     /**
      * Set account totals and update fund state.
      * PUBLIC API: Acquires _fundLock.
      * @param {Object} totals - Account balances.
      */
     async setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
         return await this._fundLock.acquire(async () => {
             return await this._setAccountTotals(totals);
         });
     }

     /**
      * Internal logic for setting account totals.
      * PRIVATE: Must be called while holding _fundLock.
      */
     async _setAccountTotals(totals) {
         // CRITICAL: Use Object.assign for in-place mutation (Race Condition #2)
         if (!this.accountTotals) {
             this.accountTotals = { ...totals };
         } else {
             Object.assign(this.accountTotals, totals);
         }
         if (!this.funds) this.resetFunds();
         
         // Call private recalculate logic
         await this._recalculateFunds();

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
      * Recalculate bot available/allocated funds based on current orders.
      * PUBLIC API: Acquires _fundLock.
      */
     async recalculateFunds() {
         return await this._fundLock.acquire(async () => {
             return await this._recalculateFunds();
         });
     }

     /**
      * Internal logic for fund recalculation.
      * PRIVATE: Must be called while holding _fundLock.
      */
     async _recalculateFunds() {
         if (this.accountant) {
             await this.accountant.recalculateFunds();
         }
     }

    /**
     * Wait for account free balances to be fetched from the blockchain.
     * Requires buyFree/sellFree readiness because allocation and available-funds
     * calculations depend on free balances, not just total balances.
     * @param {number} [timeoutMs=TIMING.ACCOUNT_TOTALS_TIMEOUT_MS] - Timeout in milliseconds.
     * @returns {Promise<void>}
     */
    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, true)) return;

        let waitPromise = null;

        // Protect waiter creation, but do not hold lock while waiting.
        await this._fundLock.acquire(async () => {
            if (hasValidAccountTotals(this.accountTotals, true)) return;
            if (!this._accountTotalsPromise) {
                this._accountTotalsPromise = new Promise((resolve) => { this._accountTotalsResolve = resolve; });
            }
            waitPromise = this._accountTotalsPromise;
        });

        if (!waitPromise) return;
        await Promise.race([waitPromise, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
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
     * @returns {Promise<boolean>}
     */
    async _updateOrder(order, context = 'updateOrder', skipAccounting = false, fee = 0) {
        if (!order || !order.id) {
            this.logger.log('Refusing to update order: missing ID', 'error');
            return false;
        }

        return await this._gridLock.acquire(async () => {
            return await this._applyOrderUpdate(order, context, skipAccounting, fee);
        });
    }

    consumeIllegalStateSignal() {
        const signal = this._lastIllegalState;
        this._lastIllegalState = null;
        return signal;
    }

    consumeAccountingFailureSignal() {
        const signal = this._lastAccountingFailure;
        this._lastAccountingFailure = null;
        return signal;
    }

    /**
     * Pause fund recalculation during batch order updates.
     * Use with resumeFundRecalc() to optimize multi-order operations.
     */
    pauseFundRecalc() {
        this._pauseFundRecalc = true;
    }

     /**
      * Resume fund recalculation after batch updates.
      * All orders updated during pause are now reflected in fund calculations.
      */
     async resumeFundRecalc() {
         this._pauseFundRecalc = false;
         await this.recalculateFunds();
     }

    /**
     * Pause recalculation logging during high-frequency operations.
     * Use with resumeRecalcLogging() to optimize grid initialization.
     */
    pauseRecalcLogging() {
        this._pauseRecalcLogging = true;
    }

    /**
     * Resume recalculation logging after high-frequency operations.
     */
    resumeRecalcLogging() {
        this._pauseRecalcLogging = false;
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
            // Build new index sets first, then atomically swap references.
            // This avoids exposing partially rebuilt indices to concurrent readers.
            const rebuiltByState = {
                [ORDER_STATES.VIRTUAL]: new Set(),
                [ORDER_STATES.ACTIVE]: new Set(),
                [ORDER_STATES.PARTIAL]: new Set()
            };
            const rebuiltByType = {
                [ORDER_TYPES.BUY]: new Set(),
                [ORDER_TYPES.SELL]: new Set(),
                [ORDER_TYPES.SPREAD]: new Set()
            };

            // Rebuild from orders Map
            for (const [id, order] of this.orders) {
                if (order && order.state && order.type) {
                    rebuiltByState[order.state]?.add(id);
                    rebuiltByType[order.type]?.add(id);
                } else {
                    this.logger.log(`Skipping corrupted order ${id} during index repair`, 'warn');
                }
            }

            this._ordersByState = rebuiltByState;
            this._ordersByType = rebuiltByType;

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
     * Apply a batch of order updates to the grid.
     * PUBLIC API: Acquires _gridLock once and performs all updates efficiently.
     * 
     * @param {Array<Object>} updates - List of order updates to apply
     * @param {string} context - Context for logging
     * @param {boolean} skipAccounting - Whether to skip optimistic accounting
     * @returns {Promise<boolean>}
     */
    async applyGridUpdateBatch(updates, context = 'batch-update', skipAccounting = false) {
        if (!Array.isArray(updates) || updates.length === 0) return true;

        return await this._gridLock.acquire(async () => {
            this.pauseFundRecalc();
            try {
                for (const update of updates) {
                    await this._applyOrderUpdate(update, context, skipAccounting);
                }
            } finally {
                await this.resumeFundRecalc();
            }
            return true;
        });
    }

    /**
     * Internal logic for updating an order.
     * PRIVATE: Must be called while holding _gridLock.
     * 
     * Invariants maintained:
     * - VIRTUAL: Order exists in memory but not on-chain.
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
     * @returns {Promise<boolean>}
     */
    async _applyOrderUpdate(order, context = 'updateOrder', skipAccounting = false, fee = 0) {
        if (!order || !order.id) {
            this.logger.log('Refusing to update order: missing ID', 'error');
            return false;
        }

        const id = order.id;
        const oldOrder = this.orders.get(id);
        const nextOrder = { ...(oldOrder || {}), ...order };

        // Backward-compat: allow initializing empty virtual placeholders without an explicit type.
        if (!nextOrder.type && nextOrder.state === ORDER_STATES.VIRTUAL) {
            const placeholderSize = Number(nextOrder.size || 0);
            if (placeholderSize === 0) {
                nextOrder.type = ORDER_TYPES.SPREAD;
            }
        }

        if (!VALID_ORDER_STATES.has(nextOrder.state)) {
            this.logger.log(`Refusing to update order ${id}: invalid state '${nextOrder.state}' (context: ${context})`, 'error');
            return false;
        }

        if (!VALID_ORDER_TYPES.has(nextOrder.type)) {
            this.logger.log(`Refusing to update order ${id}: invalid type '${nextOrder.type}' (context: ${context})`, 'error');
            return false;
        }

        // Invariant: SPREAD placeholders are always size 0.
        if (nextOrder.type === ORDER_TYPES.SPREAD && Number(nextOrder.size || 0) !== 0) {
            this.logger.log(
                `[INVARIANT] Normalizing SPREAD order ${id} size ${nextOrder.size} -> 0 (context: ${context})`,
                'warn'
            );
            nextOrder.size = 0;
        }

        // Validation: Prevent SPREAD orders from becoming ACTIVE/PARTIAL
        if (nextOrder.type === ORDER_TYPES.SPREAD && isOrderOnChain(nextOrder)) {
            const message = `ILLEGAL STATE: Refusing to move SPREAD order ${id} to ${nextOrder.state}. SPREAD orders must remain VIRTUAL.`;
            this.logger.log(message, 'error');
            this._lastIllegalState = { id, context, message, at: Date.now() };
            if (this._throwOnIllegalState) {
                const err = new Error(message);
                err.code = 'ILLEGAL_ORDER_STATE';
                throw err;
            }
            return false;
        }

        // Preserve side intent across transitions that temporarily use SPREAD placeholders.
        if (nextOrder.type === ORDER_TYPES.BUY || nextOrder.type === ORDER_TYPES.SELL) {
            nextOrder.committedSide = nextOrder.type;
        } else if (!nextOrder.committedSide) {
            if (oldOrder?.committedSide) {
                nextOrder.committedSide = oldOrder.committedSide;
            } else if (oldOrder?.type === ORDER_TYPES.BUY || oldOrder?.type === ORDER_TYPES.SELL) {
                nextOrder.committedSide = oldOrder.type;
            }
        }

        // CRITICAL VALIDATION: Prevent phantom orders (ACTIVE/PARTIAL without orderId)
        // This is a defense-in-depth check to catch bugs in any module that might try to
        // create an ACTIVE or PARTIAL order without a corresponding blockchain order ID.
        if (isPhantomOrder(nextOrder)) {
            this.logger.log(
                `ILLEGAL STATE: Refusing to set order ${id} to ${nextOrder.state} without orderId. ` +
                `Context: ${context}. This would create a phantom order that doubles fund tracking. ` +
                `Downgrading to VIRTUAL instead.`,
                'error'
            );
            // Auto-correct to VIRTUAL to prevent fund tracking corruption.
            // Clear identity fields and reset size unconditionally so we don't
            // carry a stale committed amount into virtual accounting.
            nextOrder.state = ORDER_STATES.VIRTUAL;
            nextOrder.orderId = null;
            nextOrder.rawOnChain = null;
            nextOrder.size = 0;
        }

        // 1. Update optimistic balance (atomic update of tracked funds)
        if (this.accountant) {
            await this.accountant.updateOptimisticFreeBalance(oldOrder, nextOrder, context, fee, skipAccounting);
        }

        // 2. Clone and freeze the order to prevent external modification races
        const updatedOrder = deepFreeze({ ...nextOrder });

        // 3. Robust index maintenance
        Object.values(this._ordersByState).forEach(set => set.delete(id));
        Object.values(this._ordersByType).forEach(set => set.delete(id));

        if (this._ordersByState[updatedOrder.state]) {
            this._ordersByState[updatedOrder.state].add(id);
        }
        if (this._ordersByType[updatedOrder.type]) {
            this._ordersByType[updatedOrder.type].add(id);
        }

        // --- IMMUTABLE SWAP ---
        // Create a new Map, update the specific order, and replace the frozen master reference.
        const newMap = cloneMap(this.orders);
        newMap.set(id, updatedOrder);
        this.orders = Object.freeze(newMap);
        this._gridVersion += 1;

        // --- COW WORKING GRID SYNC ---
        // If we're in the middle of a rebalance or broadcast, also update the working grid
        // to keep it in sync with the master grid.
        // During REBALANCING: marks stale so planning aborts, but syncs data for future use.
        // During BROADCASTING: marks stale so commit is rejected, syncs data so the next
        //   rebalance cycle starts from a correct baseline.
        if (this._currentWorkingGrid && (this._rebalanceState === 'REBALANCING' || this._rebalanceState === 'BROADCASTING')) {
            try {
                this._currentWorkingGrid.markStale(`master mutation during ${this._rebalanceState.toLowerCase()} (${context})`);
                this._currentWorkingGrid.syncFromMaster(this.orders, id, this._gridVersion);
            } catch (syncErr) {
                this._currentWorkingGrid.markStale(`working-grid sync failure: ${syncErr.message}`);
                this.logger.log(`[COW] Failed to sync working grid for order ${id}: ${syncErr.message}`, 'warn');
            }
        }
        // ----------------------

        // 4. Recalculate funds if not in a batch pause
        if (!this._pauseFundRecalc) {
            await this.recalculateFunds();
        }

        return true;
    }

    async checkSpreadCondition(BitShares, batchCb) {
        return await Grid.checkSpreadCondition(this, BitShares, batchCb);
    }

    async checkGridHealth(batchCb) {
        return await Grid.checkGridHealth(this, batchCb);
    }

    /**
     * Check if the processing pipeline is empty (no pending fills, corrections, or grid updates).
     * Note: Has a minor side-effect — calls _cleanExpiredLocks() to garbage-collect stale shadow locks
     * before evaluating pipeline status. Use clearStalePipelineOperations() for timeout handling.
     * @param {number|Object} [pipelineSignals=0] - Queue length or pipeline signal object from dexbot
     * @returns {Object} { isEmpty: boolean, reasons: string[] }
     */
    isPipelineEmpty(pipelineSignals = 0) {
        const normalizedSignals = (typeof pipelineSignals === 'number')
            ? { incomingFillQueueLength: pipelineSignals }
            : (pipelineSignals || {});

        const incomingFillQueueLength = Number(normalizedSignals.incomingFillQueueLength) || 0;
        const shadowLocks = Number(normalizedSignals.shadowLocks) || 0;
        const batchInFlight = !!normalizedSignals.batchInFlight;
        const retryInFlight = !!normalizedSignals.retryInFlight;
        const recoveryInFlight = !!normalizedSignals.recoveryInFlight;
        const broadcasting = !!normalizedSignals.broadcasting;

        this._cleanExpiredLocks();
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

        if (shadowLocks > 0) {
            reasons.push(`${shadowLocks} shadow lock(s) active`);
        }

        if (batchInFlight) {
            reasons.push('batch broadcast in-flight');
        }

        if (retryInFlight) {
            reasons.push('batch retry in-flight');
        }

        if (recoveryInFlight) {
            reasons.push('recovery sync in-flight');
        }

        if (broadcasting || this._isBroadcasting) {
            reasons.push('broadcasting active orders');
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
        const buyPrecision = this.assets?.assetB?.precision;
        const sellPrecision = this.assets?.assetA?.precision;
        if (!Number.isFinite(buyPrecision) || !Number.isFinite(sellPrecision)) {
            return { isValid: true, reason: 'Skipped: precision not available' };
        }
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
            reason: !buyOk ? `BUY drift ${Format.formatAmountByPrecision(driftBuy, buyPrecision)} > ${Format.formatAmountByPrecision(allowedDriftBuy, buyPrecision)}` :
                    !sellOk ? `SELL drift ${Format.formatAmountByPrecision(driftSell, sellPrecision)} > ${Format.formatAmountByPrecision(allowedDriftSell, sellPrecision)}` : null
        };
    }

    /**
     * --- NEW DELTA RECONCILER ---
     * Compares Frozen Master Grid vs Calculated Target Grid.
     * Generates a list of actions to transition Master -> Target.
     * Enforces Side Invariance.
     */
    reconcileGrid(targetGrid, targetBoundary) {
        const actions = [];
        const master = this.orders;
        const currentBoundary = this.boundaryIdx;

        // 1. Boundary Validation
        if (targetBoundary !== null) {
            const maxIdx = Math.max(0, this.orders.size - 1);
            if (targetBoundary < 0 || targetBoundary > maxIdx) {
                const clamped = Math.max(0, Math.min(maxIdx, targetBoundary));
                this.logger.log(
                    `[RECONCILE] Clamping target boundary ${targetBoundary} -> ${clamped} (max ${maxIdx}).`,
                    'warn'
                );
                targetBoundary = clamped;
            }
        }

        // 2. Diffing: Iterate Target Grid (The "Ideal" State)
        for (const [id, targetOrder] of targetGrid) {
            const masterOrder = master.get(id);

            // A. New Placement (Slot unused in Master)
            if (!masterOrder || masterOrder.state === ORDER_STATES.VIRTUAL) {
                if (targetOrder.size > 0) { // Only place if size > 0
                    actions.push({ type: 'create', id, order: targetOrder });
                }
                continue;
            }

            // B. Existing Order logic
            // Side Invariance: If side changes, MUST Cancel + Place
            if (masterOrder.type !== targetOrder.type) {
                actions.push({ type: 'cancel', id, orderId: masterOrder.orderId }); // Cancel old
                if (targetOrder.size > 0) {
                    actions.push({ type: 'create', id, order: targetOrder }); // Place new
                }
                continue;
            }

            // C. Size Update (Same Side)
            // Use native update_order if only size changes
            if (masterOrder.size !== targetOrder.size) {
                if (targetOrder.size === 0) {
                    actions.push({ type: 'cancel', id, orderId: masterOrder.orderId });
                } else {
                    actions.push({ type: 'update', id, orderId: masterOrder.orderId, newSize: targetOrder.size, order: targetOrder });
                }
            }
        }

        // 3. Diffing: Cleanup Surpluses (In Master but not in Target)
        // Note: targetGrid should contain ALL valid slots. If a slot is missing from target,
        // it means the strategy dropped it (e.g. grid shrink).
        for (const [id, masterOrder] of master) {
            if (!targetGrid.has(id) && isOrderOnChain(masterOrder)) {
                actions.push({ type: 'cancel', id, orderId: masterOrder.orderId });
            }
        }

        return { actions, aborted: false };
    }

    /**
     * UNIFIED SAFE REBALANCE ENTRY POINT
     * 
     * Performs a complete grid rebalancing using the Copy-on-Write (COW) pattern.
     * This is the primary public API for rebalancing operations.
     * 
     * PROCESS:
     * 1. Acquires exclusive _gridLock to prevent concurrent modifications
     * 2. Creates a working copy of the grid (WorkingGrid)
     * 3. Calculates target grid state using StrategyEngine
     * 4. Reconciles current state with target state
     * 5. Validates fund constraints
     * 6. Returns action plan for execution
     * 
     * SAFETY FEATURES:
     * - Lock-based concurrency control prevents race conditions
     * - Copy-on-Write pattern ensures master grid is never modified until confirmed
     * - Fund validation ensures actions won't exceed available capital
     * - Comprehensive logging for observability
     *
     * @param {Array<Object>} [fills=[]] - Recently filled orders that triggered the rebalance
     * @param {Set<string>} [excludeIds=new Set()] - Order IDs to exclude from rebalancing (e.g., locked orders)
     * @returns {Promise<Object>} Rebalance plan containing:
     *   - actions {Array}: Action objects {type, id, order, newSize, orderId}
     *   - stateUpdates {Array}: Optimistic state predictions for UI
     *   - hadRotation {boolean}: Whether grid structure changed
     *   - workingGrid {WorkingGrid}: The working grid copy (COW pattern)
     *   - workingIndexes {Object}: Index state of working grid
     *   - workingBoundary {number}: New boundary index
     *   - planningDuration {number}: Time spent planning in milliseconds
     *   - aborted {boolean}: Whether planning was aborted
     *   - reason {string}: Reason for abortion (if aborted)
     * @async
     */
    async performSafeRebalance(fills = [], excludeIds = new Set()) {
        this.logger.log("[SAFE-REBALANCE] Starting with COW...", "info");
        return await this._gridLock.acquire(async () => {
            return await this._applySafeRebalanceCOW(fills, excludeIds);
        });
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

    /**
     * Set rebalance state for COW operations
     * @param {string} state - New state (NORMAL | REBALANCING | BROADCASTING)
     */
    _setRebalanceState(state) {
        this._rebalanceState = state;
        this.logger.log(`[COW] Rebalance state: ${state}`, 'debug');
    }

    /**
     * Validate that working grid funds are sufficient
     * @param {WorkingGrid} workingGrid - Working grid to validate
     * @param {Object} projectedFunds - Projected fund state
     * @returns {Object} - Validation result
     */
    _validateWorkingGridFunds(workingGrid, projectedFunds) {
        const required = this._calculateRequiredFundsFromGrid(workingGrid);
        const availableBuy = Number.isFinite(Number(projectedFunds?.allocatedBuy))
            ? Number(projectedFunds.allocatedBuy)
            : Number.isFinite(Number(projectedFunds?.chainTotalBuy))
                ? Number(projectedFunds.chainTotalBuy)
                : Number(projectedFunds?.freeBuy || projectedFunds?.chainFreeBuy || 0);
        const availableSell = Number.isFinite(Number(projectedFunds?.allocatedSell))
            ? Number(projectedFunds.allocatedSell)
            : Number.isFinite(Number(projectedFunds?.chainTotalSell))
                ? Number(projectedFunds.chainTotalSell)
                : Number(projectedFunds?.freeSell || projectedFunds?.chainFreeSell || 0);
        
        const shortfalls = [];
        
        if (required.buy > availableBuy) {
            shortfalls.push({
                asset: this.config.buyAsset,
                required: required.buy,
                available: availableBuy,
                deficit: required.buy - availableBuy
            });
        }
        
        if (required.sell > availableSell) {
            shortfalls.push({
                asset: this.config.sellAsset,
                required: required.sell,
                available: availableSell,
                deficit: required.sell - availableSell
            });
        }
        
        return {
            isValid: shortfalls.length === 0,
            reason: shortfalls.length > 0 ? `Fund shortfall: ${JSON.stringify(shortfalls)}` : null,
            shortfalls
        };
    }

    /**
     * Calculate required funds from grid orders
     * @param {WorkingGrid} workingGrid - Working grid
     * @returns {Object} - Required buy and sell amounts
     */
    _calculateRequiredFundsFromGrid(workingGrid) {
        let buyRequired = 0;
        let sellRequired = 0;
        
        for (const order of workingGrid.values()) {
            const size = Number.isFinite(Number(order.size))
                ? Number(order.size)
                : Number(order.amount || 0);

            if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) {
                if (order.type === ORDER_TYPES.BUY) {
                    buyRequired += size;
                } else if (order.type === ORDER_TYPES.SELL) {
                    sellRequired += size;
                }
            }
        }

        return { buy: buyRequired, sell: sellRequired };
    }

    /**
     * Reconcile target grid against master using working copy
     * Only modifies workingGrid, never touches master
     * @param {Map} targetGrid - Target state from strategy
     * @param {number} targetBoundary - Target boundary index
     * @param {WorkingGrid} workingGrid - Working copy (starts as master clone)
     * @returns {Object} - Actions and status
     */
    _reconcileGridCOW(targetGrid, targetBoundary, workingGrid) {
        const result = this.reconcileGrid(targetGrid, targetBoundary);
        if (result.aborted) return result;

        this._projectTargetToWorkingGrid(workingGrid, targetGrid);

        const actions = result.actions || [];
        return {
            ...result,
            ordersCreated: actions.filter(a => a.type === 'create').length,
            ordersUpdated: actions.filter(a => a.type === 'update').length,
            ordersCancelled: actions.filter(a => a.type === 'cancel').length
        };
    }

    /**
     * Project target grid state into working copy while preserving on-chain IDs
     * for same-side orders that remain on chain.
     */
    _projectTargetToWorkingGrid(workingGrid, targetGrid) {
        const targetIds = new Set();

        for (const [id, targetOrder] of targetGrid.entries()) {
            targetIds.add(id);

            const current = workingGrid.get(id);
            const targetSize = Number.isFinite(Number(targetOrder?.size)) ? Number(targetOrder.size) : 0;

            if (!current) {
                workingGrid.set(id, {
                    ...targetOrder,
                    size: Math.max(0, targetSize),
                    state: targetSize > 0 ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: null
                });
                continue;
            }

            if (targetSize > 0) {
                const keepOrderId = isOrderOnChain(current) && hasOnChainId(current) && current.type === targetOrder.type;
                workingGrid.set(id, {
                    ...current,
                    ...targetOrder,
                    size: targetSize,
                    state: keepOrderId ? current.state : ORDER_STATES.ACTIVE,
                    orderId: keepOrderId ? current.orderId : null
                });
            } else {
                workingGrid.set(id, {
                    ...current,
                    ...targetOrder,
                    size: 0,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null
                });
            }
        }

        for (const [id, current] of workingGrid.entries()) {
            if (targetIds.has(id)) continue;
            if (isOrderOnChain(current)) {
                workingGrid.set(id, convertToSpreadPlaceholder(current));
            }
        }
    }

    /**
     * Apply safe rebalance using Copy-on-Write pattern
     * Master grid is NEVER modified until blockchain confirmation
     * @param {Array} fills - Array of fill events
     * @param {Set} excludeIds - IDs to exclude from rebalance
     * @returns {Promise<Object>} - Rebalance result with working grid (master unchanged)
     *   - actions {Array}: Planned actions (create, update, cancel)
     *   - stateUpdates {Array}: Optimistic state updates
     *   - hadRotation {boolean}: Whether grid had structural changes
     *   - workingGrid {WorkingGrid}: The COW working grid copy
     *   - workingIndexes {Object}: Index snapshot of working grid
     *   - workingBoundary {number}: New boundary index
     *   - planningDuration {number}: Planning time in ms
     *   - aborted {boolean}: Whether planning was aborted
     *   - reason {string}: Abort reason (if aborted)
     * @async
     * @private
     */
    async _applySafeRebalanceCOW(fills = [], excludeIds = new Set()) {
        const startTime = Date.now();
        
        this._setRebalanceState('REBALANCING');

        const workingGrid = new WorkingGrid(this.orders, { baseVersion: this._gridVersion });
        this._currentWorkingGrid = workingGrid; // Track for fill synchronization
        const workingFunds = this.getChainFundsSnapshot();
        
        const strategyParams = {
            frozenMasterGrid: this.orders,
            config: this.config,
            accountAssets: this.assets,
            funds: this.getChainFundsSnapshot(),
            excludeIds,
            fills,
            currentBoundaryIdx: this.boundaryIdx,
            buySideIsDoubled: this.buySideIsDoubled,
            sellSideIsDoubled: this.sellSideIsDoubled
        };

        const { targetGrid, boundaryIdx } = this.strategy.calculateTargetGrid(strategyParams);

        const { actions, aborted, reason } = this._reconcileGridCOW(
            targetGrid,
            boundaryIdx,
            workingGrid
        );

        if (aborted) {
            this.logger.log(`[COW] Rebalance aborted: ${reason}`, 'warn');
            this._clearWorkingGridRef();
            return { aborted: true, reason, ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };
        }

        const fundCheck = this._validateWorkingGridFunds(workingGrid, workingFunds);
        if (!fundCheck.isValid) {
            this.logger.log(`[COW] Fund validation failed: ${fundCheck.reason}`, 'warn');
            this._clearWorkingGridRef();
            return { aborted: true, reason: fundCheck.reason, ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };
        }

        const duration = Date.now() - startTime;
        if (duration > 100) {
            this.logger.log(`[COW] Rebalance planning took ${duration}ms`, 'warn');
        }

        const stateUpdates = this._buildStateUpdates(actions, this.orders);

        if (workingGrid.isStale()) {
            const reasonStale = workingGrid.getStaleReason() || 'Master grid changed during planning';
            this.logger.log(`[COW] Rebalance plan invalidated: ${reasonStale}`, 'warn');
            this._clearWorkingGridRef();
            return { aborted: true, reason: reasonStale, ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };
        }

        this.logger.log(`[COW] Plan: Actions=${actions.length}, StateUpdates=${stateUpdates.length}`, 'info');

        return {
            actions,
            stateUpdates,
            hadRotation: actions.some(a => a.type === 'create' || a.type === 'update'),
            // COW-specific fields for _updateOrdersOnChainBatchCOW
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: boundaryIdx,
            planningDuration: duration
        };
    }

    /**
     * Build optimistic state updates from rebalance actions.
     * 
     * This method generates predicted state changes that can be applied
     * optimistically to the UI before blockchain confirmation. It converts
     * action objects into state update objects that represent the expected
     * final state of affected orders.
     *
     * ACTION TYPES:
     * - 'create': New order placement -> VIRTUAL state, no orderId
     * - 'cancel': Order cancellation -> SPREAD placeholder
     * - 'update': Order size update -> Modified size, same state
     *
     * @param {Array<Object>} actions - Array of rebalance action objects from _reconcileGridCOW
     *   - type {string}: Action type ('create', 'cancel', 'update')
     *   - id {string}: Order slot ID
     *   - order {Object}: Order data (for create actions)
     *   - newSize {number}: New size (for update actions)
     *   - orderId {string}: Blockchain order ID (for cancel actions)
     * @param {Map} masterGrid - Master grid Map containing current order states
     * @returns {Array<Object>} State update objects for optimistic rendering:
     *   - For creates: {id, price, type, size, state: VIRTUAL, orderId: null}
     *   - For cancels: SPREAD placeholder {id, price, type: SPREAD, size: 0, state: VIRTUAL}
     *   - For updates: {id, price, type, size: newSize, state, orderId}
     * @private
     */
    _buildStateUpdates(actions, masterGrid) {
        const stateUpdates = [];

        for (const action of actions) {
            if (action.type === 'create') {
                stateUpdates.push({ ...action.order, state: ORDER_STATES.VIRTUAL, orderId: null });
            } else if (action.type === 'cancel') {
                const masterOrder = masterGrid.get(action.id);
                if (masterOrder) {
                    stateUpdates.push(convertToSpreadPlaceholder(masterOrder));
                }
            } else if (action.type === 'update') {
                const masterOrder = masterGrid.get(action.id);
                if (masterOrder) {
                    const newSize = Number.isFinite(Number(action.newSize))
                        ? Number(action.newSize)
                        : Number(action.order?.size || 0);
                    stateUpdates.push({ ...masterOrder, size: newSize });
                }
            }
        }

        return stateUpdates;
    }

    /**
     * Commit working grid to master (atomic swap)
     * ONLY call after successful blockchain confirmation
     * @param {WorkingGrid} workingGrid - Working grid to commit
     * @param {Object} workingIndexes - Indexes from working grid
     * @param {number} workingBoundary - Boundary index
     */
    async _commitWorkingGrid(workingGrid, workingIndexes, workingBoundary) {
        const startTime = Date.now();
        const stats = workingGrid.getMemoryStats();
        let didCommit = false;

        // Pre-lock staleness checks (safe to read -- these are only set by the
        // current rebalance owner and concurrent fills mark the grid stale).
        if (workingGrid?.isStale?.()) {
            this.logger.log(`[COW] Refusing stale working grid commit: ${workingGrid.getStaleReason() || 'stale'}`, 'warn');
            this._clearWorkingGridRef();
            return;
        }

        // Acquire _gridLock for the actual atomic swap to prevent concurrent
        // _applyOrderUpdate calls from reading partially-committed state.
        await this._gridLock.acquire(async () => {
            // Re-check staleness under the lock -- a fill may have arrived
            // between the pre-check above and lock acquisition.
            if (workingGrid?.isStale?.()) {
                this.logger.log(`[COW] Refusing stale working grid commit (under lock): ${workingGrid.getStaleReason() || 'stale'}`, 'warn');
                this._clearWorkingGridRef();
                return;
            }

            // Reject stale working snapshots that were planned against an older
            // master version. This protects against lost updates when fills land
            // while a batch is broadcasting.
            if (Number.isFinite(Number(workingGrid?.baseVersion)) && workingGrid.baseVersion !== this._gridVersion) {
                this.logger.log(
                    `[COW] Refusing working grid commit: base version ${workingGrid.baseVersion} != current ${this._gridVersion}`,
                    'warn'
                );
                this._clearWorkingGridRef();
                return;
            }

            this.logger.log(
                `[COW] Committing working grid: ${stats.size} orders, ${stats.modified} modified`,
                'debug'
            );

            // Validate delta before commit - ensure actions are still valid
            const delta = workingGrid.buildDelta(this.orders);
            if (delta.length === 0) {
                this.logger.log('[COW] Delta empty at commit - nothing to commit', 'debug');
                this._clearWorkingGridRef();
                return;
            }

            this.orders = Object.freeze(workingGrid.toMap());
            this.boundaryIdx = workingBoundary;
            this._gridVersion += 1;

            // Recompute indexes from the working grid's current state rather than
            // using the pre-computed workingIndexes, which may be stale if
            // syncFromMaster updated the working grid during broadcast.
            const freshIndexes = workingGrid.getIndexes();

            this._ordersByState = {
                [ORDER_STATES.VIRTUAL]: freshIndexes[ORDER_STATES.VIRTUAL] || new Set(),
                [ORDER_STATES.ACTIVE]: freshIndexes[ORDER_STATES.ACTIVE] || new Set(),
                [ORDER_STATES.PARTIAL]: freshIndexes[ORDER_STATES.PARTIAL] || new Set()
            };

            this._ordersByType = {
                [ORDER_TYPES.BUY]: freshIndexes[ORDER_TYPES.BUY] || new Set(),
                [ORDER_TYPES.SELL]: freshIndexes[ORDER_TYPES.SELL] || new Set(),
                [ORDER_TYPES.SPREAD]: freshIndexes[ORDER_TYPES.SPREAD] || new Set()
            };

            didCommit = true;
        });

        if (!didCommit) {
            return;
        }

        // Wrap post-commit cleanup in try-finally to ensure state is always reset
        // even if fund recalculation throws.
        try {
            await this.recalculateFunds();

            const duration = Date.now() - startTime;
            this.logger.log(`[COW] Grid committed in ${duration}ms`, 'debug');

            const { COW_PERFORMANCE } = require('../constants');
            if (stats.size > COW_PERFORMANCE.GRID_MEMORY_WARNING) {
                this.logger.log(
                    `[COW] Warning: Large grid size (${stats.size} orders). Peak memory: ~${Math.round(stats.estimatedBytes / 1024)}KB`,
                    'warn'
                );
            }
        } catch (recalcErr) {
            this.logger.log(`[COW] Fund recalculation failed post-commit: ${recalcErr.message}`, 'error');
            // Continue to cleanup - grid is committed, just funds may be stale
        } finally {
            // Clear working grid reference after commit (success or recalc failure)
            this._clearWorkingGridRef();
        }
    }
}

module.exports = { OrderManager };
