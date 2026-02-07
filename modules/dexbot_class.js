/**
 * modules/dexbot_class.js - DEXBot Core Engine
 *
 * Core trading bot implementation shared by bot.js (single) and dexbot.js (multi-bot).
 * Implements complete grid trading bot lifecycle.
 *
 * Responsibilities:
 * - Bot initialization and account setup
 * - Order placement and batch operations
 * - Fill processing and synchronization
 * - Grid rebalancing and order rotation
 * - Divergence detection and correction
 * - State persistence and recovery
 * - Market monitoring and health checks
 *
 * ===============================================================================
 * CORE CLASS: DEXBot
 * ===============================================================================
 *
 * LIFECYCLE METHODS:
 *   - constructor(config) - Initialize bot with configuration
 *   - run() - Start bot operation loop
 *   - shutdown() - Graceful shutdown
 *   - pause() - Pause bot operations
 *   - resume() - Resume bot operations
 *
 * CONFIGURATION:
 *   - loadBotConfig() - Load bot configuration from files
 *   - validateConfig() - Validate configuration values
 *
 * INITIALIZATION:
 *   - initialize() - Set up blockchain connection and grid
 *   - setupAccount() - Authenticate and load account
 *   - initializeOrderManager() - Create and initialize OrderManager
 *
 * ORDER OPERATIONS:
 *   - placeOrders() - Create and place new orders
 *   - updateOrders() - Modify existing orders
 *   - cancelOrders() - Cancel orders
 *   - processBatch() - Execute batch operations
 *
 * FILL PROCESSING:
 *   - processFills() - Handle order fill events
 *   - updateFromFill() - Update internal state from fill
 *   - processFilledOrders() - Comprehensive fill processing
 *
 * SYNCHRONIZATION:
 *   - syncFromBlockchain() - Sync grid state with blockchain
 *   - reconcileGrid() - Reconcile discrepancies
 *   - checkGridHealth() - Verify grid integrity
 *
 * REBALANCING:
 *   - rebalanceGrid() - Trigger grid rebalancing
 *   - rotateOrders() - Perform order rotation
 *   - checkSpreadCondition() - Verify spread limits
 *
 * MONITORING:
 *   - getMetrics() - Retrieve performance metrics
 *   - monitorHealth() - Check bot health status
 *   - detectDivergence() - Detect grid-blockchain divergence
 *
 * ===============================================================================
 *
 * HELPER FUNCTIONS (module-level):
 *   - normalizeBotEntry() - Normalize bot configuration object
 *   - validateBotConfig() - Validate configuration values
 *   - applyDefaults() - Apply default configuration values
 *
 * ===============================================================================
 *
 * STATE MANAGEMENT:
 * - Internal OrderManager maintains all state
 * - Persists grid snapshots to profiles/orders/{botKey}.json
 * - Recovers from persisted state on startup
 * - Real-time synchronization with blockchain
 *
 * ERROR HANDLING:
 * - Graceful error recovery
 * - Automatic reconnection on connection loss
 * - Anomaly detection and correction
 * - Detailed logging for debugging
 *
 * ===============================================================================
 */

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./bitshares_client');
const chainKeys = require('./chain_keys');
const chainOrders = require('./chain_orders');
const { OrderManager, grid: Grid } = require('./order');
const {
    retryPersistenceIfNeeded,
    initializeFeeCache,
    applyGridDivergenceCorrections
} = require('./order/utils/system');
const {
    buildCreateOrderArgs,
    getOrderTypeFromUpdatedFlags,
    virtualizeOrder,
    correctAllPriceMismatches,
    convertToSpreadPlaceholder
} = require('./order/utils/order');
const { validateOrderSize } = require('./order/utils/math');
const { ORDER_STATES, ORDER_TYPES, TIMING, MAINTENANCE, GRID_LIMITS } = require('./constants');
const { attemptResumePersistedGridByPriceMatch, decideStartupGridAction, reconcileStartupOrders } = require('./order/startup_reconcile');
const { AccountOrders, createBotKey } = require('./account_orders');
const { parseJsonWithComments } = require('./account_bots');
const Format = require('./order/format');

const PROFILES_BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

// ================================================================================
// Shared utility functions used by bot.js and dexbot.js
// ================================================================================

/**
 * Normalize bot entry with metadata (active flag and botKey)
 * @param {Object} entry - Bot configuration entry from bots.json
 * @param {number} index - Index in bots array
 * @returns {Object} Normalized entry with active, botIndex, and botKey fields
 */
function normalizeBotEntry(entry, index = 0) {
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
    return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
}

class DEXBot {
    /**
     * Create a new DEXBot instance
     * @param {Object} config - Bot configuration from profiles/bots.json
     * @param {Object} options - Optional settings
     * @param {string} options.logPrefix - Prefix for console logs (e.g., "[bot.js]")
     */
    constructor(config, options = {}) {
        // Validate critical config values before initialization
        this._validateStartupConfig(config);

        this.config = config;
        this.account = null;
        this.privateKey = null;
        this.manager = null;
        this.accountOrders = null;  // Will be initialized in start()
        this.triggerFile = path.join(PROFILES_DIR, `recalculate.${config.botKey}.trigger`);
        this._recentlyProcessedFills = new Map();
        this._fillCleanupCounter = 0;  // Deterministic cleanup tracking

        // Time-based configuration for fill processing (from constants.TIMING)
        this._fillDedupeWindowMs = TIMING.FILL_DEDUPE_WINDOW_MS;      // Window for deduplicating same fill events
        this._fillCleanupIntervalMs = TIMING.FILL_CLEANUP_INTERVAL_MS;  // Clean old fill records periodically

        this._incomingFillQueue = [];
        this.logPrefix = options.logPrefix || '';

        // Track order IDs whose grid slots were already freed by stale-order batch cleanup.
        // When a batch fails because an order no longer exists on-chain (filled between our
        // last sync and broadcast), the stale-cleanup converts the slot to VIRTUAL/SPREAD,
        // releasing committed funds back to chainFree. If a fill event later arrives for
        // that same order (orphan-fill), we must NOT credit the proceeds again — the capital
        // was already freed. Track IDs with timestamps and retain them for a cooldown window
        // to handle delayed history/RPC delivery of orphan fills.
        this._staleCleanedOrderIds = new Map();
        this._staleCleanupRetentionMs = Math.max(this._fillDedupeWindowMs || 0, 5 * 60 * 1000);

        // Metrics for monitoring lock contention and fill processing
        this._metrics = {
            fillsProcessed: 0,
            fillProcessingTimeMs: 0,
            batchesExecuted: 0,
            lockContentionEvents: 0,
            maxQueueDepth: 0
        };

        // Shutdown state
        this._shuttingDown = false;

        // Runtime handles for graceful lifecycle management
        this._blockchainFetchInterval = null;
        this._fillsUnsubscribe = null;
        this._triggerWatcher = null;
        this._triggerDebounceTimer = null;
        this._mainLoopActive = false;
        this._mainLoopPromise = null;
    }

    /**
     * Validate startup configuration to catch errors early.
     * Ensures critical values are valid before bot starts.
     * @param {Object} config - Configuration object to validate
     * @throws {Error} If critical validation fails
     * @private
     */
    _validateStartupConfig(config) {
        const errors = [];

        // Validate startPrice is numeric or valid string mode
        const startPrice = config.startPrice;
        const validPriceModes = ['pool', 'market', 'orderbook'];
        const isPriceNumeric = typeof startPrice === 'number' && Number.isFinite(startPrice) && startPrice > 0;
        const isPriceMode = typeof startPrice === 'string' && validPriceModes.includes(startPrice.toLowerCase());
        if (!isPriceNumeric && !isPriceMode) {
            errors.push(`startPrice must be a positive number or valid mode (${validPriceModes.join('/')}), got: ${startPrice}`);
        }

        // Validate assetA and assetB are present
        if (!config.assetA || typeof config.assetA !== 'string') {
            errors.push(`assetA must be a non-empty string, got: ${config.assetA}`);
        }
        if (!config.assetB || typeof config.assetB !== 'string') {
            errors.push(`assetB must be a non-empty string, got: ${config.assetB}`);
        }

        // Validate incrementPercent
        const increment = config.incrementPercent;
        if (!Number.isFinite(increment) || increment <= 0 || increment > 100) {
            errors.push(`incrementPercent must be between 0 and 100, got: ${increment}`);
        }

        // Throw all validation errors at once
        if (errors.length > 0) {
            throw new Error(`Config validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
        }
    }

    /**
     * Log a message to the console with the bot's prefix.
     * @param {string} msg - The message to log.
     * @private
     */
    _log(msg, level = 'info') {
        if (level === 'warn') {
            this._warn(msg);
            return;
        }

        const line = this.logPrefix ? `${this.logPrefix} ${msg}` : msg;
        if (level === 'error') {
            console.error(line);
            return;
        }

        console.log(line);
    }

    /**
     * Log a warning message to the console with the bot's prefix.
     * @param {string} msg - The message to log.
     * @private
     */
    _warn(msg) {
        if (this.logPrefix) {
            console.warn(`${this.logPrefix} ${msg}`);
        } else {
            console.warn(msg);
        }
    }

    /**
     * Persist the grid and trigger immediate recovery if validation fails.
     * Used during startup to ensure bot begins in a stable state.
     * @private
     */
    async _persistAndRecoverIfNeeded() {
        const validation = await this.manager.persistGrid();
        if (!validation.isValid) {
            this._warn(`Startup validation failed: ${validation.reason}. Triggering immediate recovery...`);
            // Trigger centralized recovery (Hard Reset)
            const recoveryValidation = await this.manager.accountant._performStateRecovery(this.manager);
            if (recoveryValidation.isValid) {
                this._log(`✓ Startup recovery successful. Persistent state restored.`);
                await this.manager.persistGrid();
            } else {
                this._warn(`Startup recovery failed: ${recoveryValidation.reason}. Bot proceeding with caution.`);
            }
        }
    }

    /**
     * Initialize bot state from storage and blockchain.
     * Consolidates common initialization logic for start() and startWithPrivateKey().
     * @private
     */
    async _initializeStartupState() {
        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });

        // Load persisted processed fills to prevent reprocessing after restart
        const persistedFills = this.accountOrders.loadProcessedFills(this.config.botKey);
        for (const [fillKey, timestamp] of persistedFills) {
            this._recentlyProcessedFills.set(fillKey, timestamp);
        }
        if (persistedFills.size > 0) {
            this._log(`Loaded ${persistedFills.size} persisted fill records to prevent reprocessing`);
        }

        // Ensure bot metadata is properly initialized in storage BEFORE any Grid operations
        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        const allActiveBots = allBotsConfig
            .map((b, originalIdx) => b.active !== false ? normalizeBotEntry(b, originalIdx) : null)
            .filter(b => b !== null);

        await this.accountOrders.ensureBotEntries(allActiveBots);

        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }
        this.manager.isBootstrapping = true;

        // Fetch account totals from blockchain at startup to initialize funds
        try {
            if (this.accountId && this.config.assetA && this.config.assetB) {
                await this.manager._initializeAssets();
                await this.manager.fetchAccountTotals(this.accountId);
                this._log('Fetched blockchain account balances at startup');
            }
        } catch (err) {
            this._warn(`Failed to fetch account totals at startup: ${err.message}`);
        }

        // Ensure fee cache is initialized before any fill processing that calls getAssetFees().
        try {
            await initializeFeeCache([this.config || {}], BitShares);
        } catch (err) {
            this._warn(`Fee cache initialization failed: ${err.message}`);
        }

        const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey);

        // CRITICAL REPAIR: Strip fake orderIds where orderId === id (e.g. "slot-0")
        if (persistedGrid && persistedGrid.length > 0) {
            let repairCount = 0;
            for (const order of persistedGrid) {
                if (order && order.orderId && order.orderId === order.id) {
                    order.orderId = '';
                    if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) {
                        order.state = ORDER_STATES.VIRTUAL;
                    }
                    repairCount++;
                }
            }
            if (repairCount > 0) {
                this._log(`[REPAIR] Stripped ${repairCount} fake orderId(s) from persisted grid to restore rebalancing logic.`);
            }
        }

        const persistedCacheFunds = this.accountOrders.loadCacheFunds(this.config.botKey);
        const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed(this.config.botKey);
        const persistedBoundaryIdx = this.accountOrders.loadBoundaryIdx(this.config.botKey);
        const persistedDoubleSideFlags = this.accountOrders.loadDoubleSideFlags(this.config.botKey);

        return {
            persistedGrid,
            persistedCacheFunds,
            persistedBtsFeesOwed,
            persistedBoundaryIdx,
            persistedDoubleSideFlags
        };
    }

    /**
     * Finalize the bot startup after account and initial grid sync are complete.
     * Consolidates common logic for start() and startWithPrivateKey().
     * @private
     */
    async _finishStartupSequence(startupState) {
        let {
            persistedGrid,
            persistedCacheFunds,
            persistedBtsFeesOwed,
            persistedBoundaryIdx,
            persistedDoubleSideFlags
        } = startupState;

        try {
            // CRITICAL: Activate fill listener EARLY - before ANY operations that place orders
            // This ensures fills during trigger reset and grid initialization are captured
            if (typeof this._fillsUnsubscribe === 'function') {
                await this._fillsUnsubscribe().catch(() => { });
            }
            this._fillsUnsubscribe = await chainOrders.listenForFills(this.account || undefined, this._createFillCallback(chainOrders));
            if (typeof this._fillsUnsubscribe !== 'function') {
                this._warn('Fill listener did not provide an unsubscribe handler. Shutdown cleanup may be incomplete.');
                this._fillsUnsubscribe = null;
            }
            this._log('Fill listener activated (ready to process fills during startup)');

            // CRITICAL: Handle any pending trigger file reset FIRST before any other startup operations
            const hadTriggerReset = await this._handlePendingTriggerReset();

            // CRITICAL: After trigger reset, skip normal startup - grid is already fully initialized
            // The trigger reset already did: grid init, order placement, sync, and persistence
            if (hadTriggerReset) {
                this._log('Trigger reset completed. Skipping normal startup grid initialization.');

                // Post-bootstrap validation and fill processing
                await this.manager._fillProcessingLock.acquire(async () => {
                    // STEP 1: Check for fills that occurred during trigger reset
                    // These are orders that got filled while Grid.recalculateGrid() was running.
                    // The filled slots need new orders placed on them.
                    if (this._incomingFillQueue.length > 0) {
                        this._log(`[POST-RESET] ${this._incomingFillQueue.length} fill(s) detected during trigger reset. Processing...`);

                        // Process fills - this will place new orders on the filled slots
                        // Use normal fill processing since bootstrap is complete
                        const fills = this._incomingFillQueue.splice(0);
                        for (const fill of fills) {
                            if (!fill || fill.op?.[0] !== 4) continue;

                            const fillOp = fill.op[1];
                            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                                Array.from(this.manager.orders.values()).find(o => o.orderId === fillOp.order_id);

                            if (!gridOrder) {
                                // CRITICAL FIX: Even if order not in grid, we must still credit the fill proceeds
                                // This can happen when fills arrive after an order was marked VIRTUAL during sequential processing
                                this._log(`[POST-RESET] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                                try {
                                    this.manager.accountant.processFillAccounting(fillOp);
                                } catch (accErr) {
                                    this._log(`[POST-RESET] Failed to process accounting for ${fillOp.order_id}: ${accErr.message}`, 'error');
                                }
                                continue;
                            }

                            this._log(`[POST-RESET] Processing fill for ${gridOrder.type} order ${gridOrder.id} at price ${gridOrder.price}`);

                            try {
                                this.manager.accountant.processFillAccounting(fillOp);
                            } catch (accErr) {
                                this._log(`[POST-RESET] Failed to process accounting for ${fillOp.order_id}: ${accErr.message}`, 'error');
                            }

                            // Process this fill through the full rebalance pipeline
                            // This will shift the boundary and place a new order on the filled slot
                            const rebalanceResult = await this.manager.processFilledOrders([gridOrder], new Set());

                            if (rebalanceResult) {
                                // Place the orders identified by rebalance
                                const allOrders = [
                                    ...(rebalanceResult.ordersToPlace || []),
                                    ...(rebalanceResult.ordersToRotate || []),
                                    ...(rebalanceResult.ordersToUpdate || [])
                                ];

                                if (allOrders.length > 0) {
                                    this._log(`[POST-RESET] Placing ${allOrders.length} order(s) for filled slot`);
                                    await this.updateOrdersOnChainBatch(rebalanceResult);
                                }
                            }
                        }
                        await this.manager.persistGrid();
                    }

                    // STEP 2: Spread check AFTER fills are processed
                    this.manager.recalculateFunds();
                    const spreadResult = await this.manager.checkSpreadCondition(
                        BitShares,
                        this.updateOrdersOnChainBatch.bind(this)
                    );
                    if (spreadResult && spreadResult.ordersPlaced > 0) {
                        this._log(`✓ Spread correction after trigger reset: ${spreadResult.ordersPlaced} order(s) placed`);
                        await this._persistAndRecoverIfNeeded();
                    }
                    this._log('Bootstrap phase complete - fill processing resumed', 'info');
                });

                await this._setupTriggerFileDetection();
                this._setupBlockchainFetchInterval();

                if (this._isOpenOrdersSyncLoopEnabled()) {
                    this._startOpenOrdersSyncLoop();
                } else {
                    this._log('Open-orders sync loop disabled by configuration (TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED=false)');
                }
                this._log(`DEXBot started. OrderManager running (dryRun=${!!this.config.dryRun})`);
                return; // Skip normal startup path
            }

            // Restore and consolidate cacheFunds and BTS fees
            // SAFE: Done at startup before orders are created, and within fill lock when needed
            this.manager.resetFunds();
            // CRITICAL FIX: Restore BTS fees owed from persistence
            if (persistedBtsFeesOwed && persistedBtsFeesOwed > 0) {
                this.manager.funds.btsFeesOwed = Number(persistedBtsFeesOwed);
            }
            if (persistedCacheFunds) {
                await this.manager.modifyCacheFunds('buy', Number(persistedCacheFunds.buy || 0), 'startup-restore');
                await this.manager.modifyCacheFunds('sell', Number(persistedCacheFunds.sell || 0), 'startup-restore');
            }

            // Restore doubled side flags
            if (persistedDoubleSideFlags) {
                this.manager.buySideIsDoubled = !!persistedDoubleSideFlags.buySideIsDoubled;
                this.manager.sellSideIsDoubled = !!persistedDoubleSideFlags.sellSideIsDoubled;
                if (this.manager.buySideIsDoubled || this.manager.sellSideIsDoubled) {
                    this.manager.logger.log(`✓ Restored double side flags: buy=${this.manager.buySideIsDoubled}, sell=${this.manager.sellSideIsDoubled}`, 'info');
                }
            }

            if (!this.config.dryRun && !this.accountId) {
                throw new Error('Cannot start bot without a resolved account ID');
            }

            // Use this.accountId which was set during initialize()
            const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

            let shouldRegenerate = false;
            if (!persistedGrid || persistedGrid.length === 0) {
                shouldRegenerate = true;
                this._log('No persisted grid found. Generating new grid.');
            } else {
                await this.manager._initializeAssets();
                const decision = await decideStartupGridAction({
                    persistedGrid,
                    chainOpenOrders,
                    manager: this.manager,
                    logger: { log: (msg) => this._log(msg) },
                    storeGrid: async (orders) => {
                        // Temporarily replace manager.orders to persist the specific orders
                        const originalOrders = this.manager.orders;
                        this.manager.orders = new Map(orders.map(o => [o.id, o]));
                        await this.manager.persistGrid();
                        this.manager.orders = originalOrders;
                    },
                    attemptResumeFn: attemptResumePersistedGridByPriceMatch,
                });
                shouldRegenerate = decision.shouldRegenerate;

                if (shouldRegenerate && chainOpenOrders.length === 0) {
                    this._log('Persisted grid found, but no matching active orders on-chain. Generating new grid.');
                }
            }

            // Restore BTS fees owed ONLY if we're NOT regenerating the grid
            if (!shouldRegenerate) {
                // CRITICAL: Restore BTS fees owed from blockchain operations
                if (persistedBtsFeesOwed > 0) {
                    this.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
                    this._log(`✓ Restored BTS fees owed: ${Format.formatAmount8(persistedBtsFeesOwed)} BTS`);
                }
            } else {
                this._log(`ℹ Grid regenerating - resetting cacheFunds, BTS fees and doubled flags to clean state`);
                this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
                this.manager.funds.btsFeesOwed = 0;
                this.manager.buySideIsDoubled = false;
                this.manager.sellSideIsDoubled = false;
            }

            // CRITICAL: Use fill lock during ENTIRE startup synchronization to prevent races.
            // This includes grid init, finishBootstrap, and maintenance - all in one atomic block.
            // Lock order: _fillProcessingLock → _divergenceLock (canonical order, same as _consumeFillQueue)
            await this.manager._fillProcessingLock.acquire(async () => {
                try {
                    if (shouldRegenerate) {
                        await this.manager._initializeAssets();

                        if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                            this._log('Generating new grid and syncing with existing on-chain orders...');
                            await Grid.initializeGrid(this.manager);
                            await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                            const rebalanceResult = await reconcileStartupOrders({
                                manager: this.manager,
                                config: this.config,
                                account: this.account,
                                privateKey: this.privateKey,
                                chainOrders,
                                chainOpenOrders,
                            });

                            if (rebalanceResult) {
                                await this.updateOrdersOnChainBatch(rebalanceResult);
                            }
                        } else {
                            this._log('Generating new grid and placing initial orders on-chain...');
                            await this.placeInitialOrders();
                        }
                        await this._persistAndRecoverIfNeeded();
                    } else {
                        this._log('Found active session. Loading and syncing existing grid.');
                        await Grid.loadGrid(this.manager, persistedGrid, persistedBoundaryIdx);
                        const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

                        if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                            this._log(`Startup sync: ${syncResult.filledOrders.length} grid order(s) found filled. Processing proceeds.`, 'info');
                            await this.manager.processFilledOrders(syncResult.filledOrders, new Set(), { skipAccountTotalsUpdate: true });
                        }

                        const rebalanceResult = await reconcileStartupOrders({
                            manager: this.manager,
                            config: this.config,
                            account: this.account,
                            privateKey: this.privateKey,
                            chainOrders,
                            chainOpenOrders,
                        });

                        if (rebalanceResult) {
                            await this.updateOrdersOnChainBatch(rebalanceResult);
                        }

                        await this._persistAndRecoverIfNeeded();
                    }

                    this.manager.finishBootstrap();

                    // Perform initial grid maintenance (thresholds, divergence, spread, health)
                    // Consolidated into shared logic to ensure consistent behavior at boot and runtime.
                    // CRITICAL: Pass lockAlreadyHeld=true since we're inside _fillProcessingLock.acquire()
                    await this._runGridMaintenance('startup', true);

                    this._log('Bootstrap phase complete - fill processing resumed', 'info');
                } finally {
                    // CRITICAL: Always clear bootstrap flag, even on error
                    this.manager.isBootstrapping = false;
                }
            });

            await this._setupTriggerFileDetection();
            this._setupBlockchainFetchInterval();

            if (this._isOpenOrdersSyncLoopEnabled()) {
                this._startOpenOrdersSyncLoop();
            } else {
                this._log('Open-orders sync loop disabled by configuration (TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED=false)');
            }
            this._log(`DEXBot started. OrderManager running (dryRun=${!!this.config.dryRun})`);

        } catch (err) {
            this._warn(`Error during grid initialization: ${err.message}`);
            await this.shutdown();
            throw err;
        }
    }

    /**
     * Create the fill callback for listenForFills.
     * Separated from start() to allow deferred activation after startup completes.
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @returns {Function} Async callback for processing fills
     * @private
     */
    _createFillCallback(chainOrders) {
        return async (fills) => {
            if (this._shuttingDown) {
                return;
            }

            if (this.manager && !this.config.dryRun && Array.isArray(fills) && fills.length > 0) {
                // PUSH to queue immediately (non-blocking)
                this._incomingFillQueue.push(...fills);

                // Trigger consumer (fire-and-forget: it will acquire lock if needed)
                this._consumeFillQueue(chainOrders).catch(err => {
                    this._warn(`Fill queue consume failed: ${err.message}`);
                });
                return;
            }
        };
    }

    /**
     * Consume and process the fill queue with deduplication and sequential rebalancing.
     * Protected by AsyncLock to ensure single consumer.
     *
     * FLOW:
     * 1. Deduplicates fills using fillKey tracking and time window
     * 2. Syncs filled orders from history or open orders mode
     * 3. Handles price mismatches via correctAllPriceMismatches
     * 4. Processes fills sequentially with interruptible rebalancing (merges new work between fills)
     * 5. Periodically cleans old fill records to prevent memory leaks
     *
     * Atomic lock behavior: If already processing or has waiters, returns immediately (no double-queuing)
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @private
     */
    async _consumeFillQueue(chainOrders) {
        // ATOMIC: Only attempt lock acquisition if queue has work
        // This prevents unnecessary lock contention on empty queues
        if (this._incomingFillQueue.length === 0) {
            return;
        }

        // Check shutdown state
        if (this._shuttingDown) {
            this._warn('Fill processing skipped: shutdown in progress');
            return;
        }

        try {
            // BOOTSTRAP OPTIMIZATION: During bootstrap, prioritize fill processing over grid-wide checks
            // Process fills immediately with side-only rebalancing (no expensive full grid recalculations)
            if (this.manager.isBootstrapping) {
                // During bootstrap: skip lock contention checks, process fills directly
                await this.manager._fillProcessingLock.acquire(async () => {
                    if (!this.manager.isBootstrapping) return; // bootstrap finished while waiting for lock
                    await this._processFillsWithBootstrapMode(chainOrders);
                });
                return;
            }

            // NORMAL MODE: Non-blocking check if lock already has waiters
            // This prevents unbounded queue growth while still ensuring processing
            // Note: We DO proceed if lock is held but has no waiters - we'll wait our turn
            if (this.manager._fillProcessingLock.getQueueLength() > 0) {
                this._metrics.lockContentionEvents++;
                return;
            }

            await this.manager._fillProcessingLock.acquire(async () => {
                while (this._incomingFillQueue.length > 0) {
                    const batchStartTime = Date.now();

                    // Track max queue depth
                    this._metrics.maxQueueDepth = Math.max(this._metrics.maxQueueDepth, this._incomingFillQueue.length);

                    // 1. Take snapshot of current work (ATOMIC: splice removes and returns fills atomically)
                    const allFills = this._incomingFillQueue.splice(0);  // Atomically clear and get all fills

                    const validFills = [];
                    const processedFillKeys = new Set();

                    // 2. Filter and Deduplicate (Standard Logic)
                    for (const fill of allFills) {
                        if (fill && fill.op && fill.op[0] === 4) {
                            const fillOp = fill.op[1];

                            // ACCOUNT VALIDATION: Verify the filled order belongs to this bot's account/grid
                            // Only process fills for orders we actually manage
                            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                                Array.from(this.manager.orders.values()).find(o => o.orderId === fillOp.order_id);
                            if (!gridOrder) {
                                // Check if this order was already freed by stale-order batch cleanup.
                                // When a batch fails due to a stale order reference, the cleanup converts the
                                // slot to VIRTUAL/SPREAD, releasing committed funds to chainFree. If we also
                                // credit the fill proceeds here, we double-count the capital.
                                const staleMarkedAt = this._staleCleanedOrderIds.get(fillOp.order_id);
                                const staleAgeMs = Date.now() - staleMarkedAt;
                                if (Number.isFinite(staleMarkedAt) && staleAgeMs <= this._staleCleanupRetentionMs) {
                                    this.manager.logger.log(
                                        `[ORPHAN-FILL] Skipping double-credit for stale-cleaned order ${fillOp.order_id} ` +
                                        `(funds already freed by batch cleanup, age=${staleAgeMs}ms)`,
                                        'warn'
                                    );
                                    continue;
                                }

                                // Entry exists but expired: remove and process as normal orphan fill.
                                if (this._staleCleanedOrderIds.has(fillOp.order_id)) {
                                    this._staleCleanedOrderIds.delete(fillOp.order_id);
                                }

                                // Legitimate orphan fill: order was virtualized during sequential processing
                                // but a fill arrived afterward. Credit proceeds to maintain fund tracking.
                                this.manager.logger.log(`[ORPHAN-FILL] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                                try {
                                    this.manager.accountant.processFillAccounting(fillOp);
                                } catch (accErr) {
                                    this.manager.logger.log(`[ORPHAN-FILL] Failed to process accounting for ${fillOp.order_id}: ${accErr.message}`, 'error');
                                }
                                // Don't add to validFills - we can't do rebalancing without a grid slot
                                // But the funds are now credited, preventing fund invariant violation
                                continue;
                            }

                            // Process both maker and taker fills for our grid orders
                            // Grid validation ensures we only process fills belonging to our account
                            // Taker fills are included because the bot may execute market orders or act as taker
                            const roleStr = fillOp.is_maker ? 'maker' : 'taker';
                            this.manager.logger.log(`Processing ${roleStr} fill for order ${fillOp.order_id}`, 'debug');

                            const fillKey = `${fillOp.order_id}:${fill.block_num}:${fill.id || ''}`;
                            const now = Date.now();
                            if (this._recentlyProcessedFills.has(fillKey)) {
                                const lastProcessed = this._recentlyProcessedFills.get(fillKey);
                                if (now - lastProcessed < this._fillDedupeWindowMs) {
                                    this.manager.logger.log(`Skipping duplicate fill for ${fillOp.order_id} (processed ${now - lastProcessed}ms ago)`, 'debug');
                                    continue;
                                }
                            }

                            if (processedFillKeys.has(fillKey)) continue;

                            processedFillKeys.add(fillKey);
                            this._recentlyProcessedFills.set(fillKey, now);
                            validFills.push(fill);

                            // Log info
                            const paysAmount = fillOp.pays ? fillOp.pays.amount : '?';
                            const receivesAmount = fillOp.receives ? fillOp.receives.amount : '?';
                            console.log(`\n===== FILL DETECTED =====`);
                            console.log(`Order ID: ${fillOp.order_id}`);
                            console.log(`Pays: ${paysAmount}, Receives: ${receivesAmount}`);
                            console.log(`Block: ${fill.block_num} (History ID: ${fill.id || 'N/A'})`);
                            console.log(`=========================\n`);
                        }
                    }

                    // Clean up dedupe cache (periodically remove old entries)
                    // Entries older than FILL_CLEANUP_INTERVAL_MS are removed to prevent memory leak
                    const cleanupTimestamp = Date.now();
                    let cleanedCount = 0;
                    for (const [key, timestamp] of this._recentlyProcessedFills) {
                        if (cleanupTimestamp - timestamp > this._fillCleanupIntervalMs) {
                            this._recentlyProcessedFills.delete(key);
                            cleanedCount++;
                        }
                    }
                    if (cleanedCount > 0) {
                        this.manager.logger.log(`Cleaned ${cleanedCount} old fill records. Remaining: ${this._recentlyProcessedFills.size}`, 'debug');
                    }

                    if (validFills.length === 0) continue; // Loop back for more

                    // 3. Sync and Collect Filled Orders
                    let allFilledOrders = [];
                    let ordersNeedingCorrection = [];
                    const fillMode = chainOrders.getFillProcessingMode();

                    const processValidFills = async (fillsToSync) => {
                        let resolvedOrders = [];
                        if (fillMode === 'history') {
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (history mode)`, 'info');
                            for (const fill of fillsToSync) {
                                const resultHistory = this.manager.syncFromFillHistory(fill);
                                if (resultHistory.filledOrders) resolvedOrders.push(...resultHistory.filledOrders);
                            }
                        } else {
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (open orders mode)`, 'info');
                            const chainOpenOrders = await chainOrders.readOpenOrders(this.account);
                            const resultOpenOrders = await this.manager.syncFromOpenOrders(chainOpenOrders);
                            if (resultOpenOrders.filledOrders) resolvedOrders.push(...resultOpenOrders.filledOrders);
                            if (resultOpenOrders.ordersNeedingCorrection) ordersNeedingCorrection.push(...resultOpenOrders.ordersNeedingCorrection);
                        }
                        return resolvedOrders;
                    };

                    this.manager.pauseFundRecalc();
                    try {
                        allFilledOrders = await processValidFills(validFills);

                        // 4. Handle Price Corrections
                        if (ordersNeedingCorrection.length > 0) {
                            const correctionResult = await correctAllPriceMismatches(
                                this.manager, this.account, this.privateKey, chainOrders
                            );
                            if (correctionResult.failed > 0) this.manager.logger.log(`${correctionResult.failed} corrections failed`, 'error');
                        }

                    } finally {
                        this.manager.recalculateFunds();
                        this.manager.resumeFundRecalc();
                    }

                    // 5. Adaptive Batch Rebalance Loop
                    // Instead of processing fills one-at-a-time (each requiring a separate broadcast),
                    // group multiple fills into batches. The batch size scales with queue depth (stress):
                    //   low stress (1-2 fills)  → process 1 at a time (normal sequential)
                    //   moderate (3-5 fills)     → batch of 2
                    //   high (6-14 fills)        → batch of 3
                    //   extreme (15+ fills)      → batch of MAX_FILL_BATCH_SIZE (default 4)
                    //
                    // This is safe because processFilledOrders() already supports multiple fills:
                    // it virtualizes each fill, shifts the boundary for each, computes a single
                    // unified rebalance, and returns one set of operations to broadcast.
                    if (allFilledOrders.length > 0) {
                        const { FILL_PROCESSING: FP } = require('./constants');
                        const stressTiers = FP.BATCH_STRESS_TIERS || [[0, 1]];
                        const maxBatch = FP.MAX_FILL_BATCH_SIZE || 1;

                        // Determine batch size from stress tiers based on total fill count
                        let batchSize = 1;
                        for (const [minDepth, size] of stressTiers) {
                            if (allFilledOrders.length >= minDepth) {
                                batchSize = Math.min(size, maxBatch);
                                break;
                            }
                        }

                        this.manager.logger.log(
                            `Processing ${allFilledOrders.length} filled orders in batches of ${batchSize}...`,
                            'info'
                        );

                        let anyRotations = false;

                        this.manager.pauseFundRecalc();
                        try {
                            let i = 0;
                            while (i < allFilledOrders.length) {
                                // Slice the next batch of fills
                                const batchEnd = Math.min(i + batchSize, allFilledOrders.length);
                                const fillBatch = allFilledOrders.slice(i, batchEnd);
                                i = batchEnd;

                                const batchIds = fillBatch.map(f => f.id).join(', ');
                                this.manager.logger.log(
                                    `>>> Processing fill batch [${batchIds}] (${i}/${allFilledOrders.length})`,
                                    'info'
                                );

                                // Create an exclusion set from fills NOT in this batch
                                // to prevent the rebalancer from picking orders about to be processed.
                                const batchIdSet = new Set(fillBatch.map(f => f.id));
                                const fullExcludeSet = new Set();
                                for (const other of allFilledOrders) {
                                    if (batchIdSet.has(other.id)) continue;
                                    if (other.orderId) fullExcludeSet.add(other.orderId);
                                    if (other.id) fullExcludeSet.add(other.id);
                                }

                                // Log funding state before processing this batch
                                this.manager.logger.logFundsStatus(this.manager, `BEFORE processing fill batch [${batchIds}]`);

                                const rebalanceResult = await this.manager.processFilledOrders(fillBatch, fullExcludeSet);

                                // Log funding state after rebalance calculation (before actual placement)
                                this.manager.logger.logFundsStatus(this.manager, `AFTER rebalanceOrders calculated for batch [${batchIds}] (planned: ${rebalanceResult.ordersToPlace?.length || 0} new, ${rebalanceResult.ordersToRotate?.length || 0} rotations)`);

                                const batchResult = await this.updateOrdersOnChainBatch(rebalanceResult);

                                if (batchResult.hadRotation) {
                                    anyRotations = true;
                                    this.manager.logger.logFundsStatus(this.manager, `AFTER rotation completed for batch [${batchIds}]`);
                                }
                                await this.manager.persistGrid();
                            }
                        } finally {
                            this.manager.resumeFundRecalc();
                        }

                        // 6. Rebalance Recovery Loop (Sequential Extensions)
                        // DISABLED FOR SEQUENTIAL: Each sequential fill already triggers a full rebalance with proper
                        // boundary shift. An additional recovery loop with EMPTY fills causes the boundary to remain
                        // at the last fill's position, leading to wrong operation types (updates instead of rotations)
                        // and operations on the wrong side.
                        //
                        // In the future, recovery loop can be re-enabled for single fills if needed, but ONLY
                        // if it passes the actual fills to processFilledOrders so the boundary shifts correctly.
                        // For now: Each fill = full rebalance with boundary shift = complete correction in one pass.
                        // CRITICAL: Do NOT run spread correction here during sequential fill processing.
                        // The rebalance from each fill should maintain spread naturally. Running spread correction
                        // immediately after creates new orders that may get filled by market before next cycle,
                        // causing cascading fills and potentially SPREAD slots becoming PARTIAL (error condition).
                        // Spread correction runs in the main loop instead.
                        if (anyRotations || allFilledOrders.length > 0) {
                            // SAFE: Called inside _fillProcessingLock.acquire(), no concurrent fund modifications
                            this.manager.recalculateFunds();

                            // Check grid health only if pipeline is empty (no pending fills, no pending operations)
                            const pipelineStatus = this.manager.isPipelineEmpty(this._incomingFillQueue.length);
                            if (pipelineStatus.isEmpty) {
                                const healthResult = await this.manager.checkGridHealth(
                                    this.updateOrdersOnChainBatch.bind(this)
                                );
                                if (healthResult.buyDust && healthResult.sellDust) {
                                    await this.manager.persistGrid();
                                }
                            } else {
                                // Pipeline not empty - defer grid health check to prevent premature modifications
                                // This is NORMAL and EXPECTED during high-activity periods
                                const health = this.manager.getPipelineHealth();
                                this.manager.logger.log(
                                    `Deferring grid health check: ${pipelineStatus.reasons.join(', ')}. ` +
                                    `Blocked for: ${health.blockedDurationHuman}`,
                                    'debug'
                                );
                            }
                        }

                        // Run grid maintenance after fills to rebuild degraded grid.
                        // CRITICAL FIX (commit a946c33): Replaced inline divergence checks with centralized
                        // _runGridMaintenance call to ensure pipeline protection applies consistently.
                        // Before: Divergence checks ran immediately after fills, causing race-to-resize
                        // After: Grid maintenance waits for isPipelineEmpty() before structural changes
                        // Also run when rotations failed (allFilledOrders > 0) so divergence/spread correction
                        // can attempt grid recovery even when fill-triggered rotations didn't complete.
                        if (anyRotations || allFilledOrders.length > 0) {
                            await this._runGridMaintenance('post-fill', true);
                        }
                    }

                    // Save processed fills
                    await retryPersistenceIfNeeded(this.manager);
                    if (validFills.length > 0 && this.accountOrders) {
                        try {
                            const fillsToSave = {};
                            for (const fillKey of processedFillKeys) {
                                fillsToSave[fillKey] = this._recentlyProcessedFills.get(fillKey) || Date.now();
                            }
                            await this.accountOrders.updateProcessedFillsBatch(this.config.botKey, fillsToSave);
                            this.manager.logger.log(`Persisted ${processedFillKeys.size} fill records to prevent reprocessing`, 'debug');
                        } catch (err) {
                            this.manager?.logger?.log(`Warning: Failed to persist processed fills - may be reprocessed on next run: ${err.message}`, 'warn');
                        }
                    }

                    // Periodically clean up old fill records after processing N fills.
                    // Counter is protected by _fillProcessingLock during fill consumption.
                    this._fillCleanupCounter += validFills.length;

                    const cleanupThreshold = MAINTENANCE.CLEANUP_PROBABILITY > 0 && MAINTENANCE.CLEANUP_PROBABILITY < 1
                        ? Math.floor(1 / MAINTENANCE.CLEANUP_PROBABILITY)
                        : 100; // Default: every 100 fills

                    if (this._fillCleanupCounter >= cleanupThreshold) {
                        try {
                            await this.accountOrders.cleanOldProcessedFills(this.config.botKey, TIMING.FILL_RECORD_RETENTION_MS);
                            this._fillCleanupCounter = 0;  // Reset counter after cleanup (success or retry on next batch if failed)
                        } catch (err) {
                            this.manager?.logger?.log(`Warning: Fill cleanup failed (will retry): ${err.message}`, 'warn');
                        }
                    }

                    // Update metrics
                    this._metrics.fillsProcessed += validFills.length;
                    this._metrics.fillProcessingTimeMs += Date.now() - batchStartTime;

                    // Prune expired stale-cleaned order IDs after each processing cycle.
                    // Keep entries for a retention window to protect against delayed orphan-fill delivery.
                    if (this._staleCleanedOrderIds.size > 0) {
                        const now = Date.now();
                        let prunedCount = 0;
                        for (const [orderId, markedAt] of this._staleCleanedOrderIds) {
                            if (!Number.isFinite(markedAt) || now - markedAt > this._staleCleanupRetentionMs) {
                                this._staleCleanedOrderIds.delete(orderId);
                                prunedCount++;
                            }
                        }
                        if (prunedCount > 0) {
                            this.manager.logger.log(
                                `[STALE-CLEANUP] Pruned ${prunedCount} expired stale-cleaned order IDs ` +
                                `(retention=${this._staleCleanupRetentionMs}ms, remaining=${this._staleCleanedOrderIds.size})`,
                                'debug'
                            );
                        }
                    }

                } // End while(_incomingFillQueue)

            });
        } catch (err) {
            this._log(`Error processing fills: ${err.message}`);
            if (this.manager && this.manager.logger) {
                this.manager.logger.log(`Error processing fills: ${err.message}`, 'error');
                if (err.stack) this.manager.logger.log(err.stack, 'error');
            } else {
                console.error('CRITICAL: Error processing fills (logger unavailable):', err);
            }
        }

        // Post-processing: If new fills arrived while processing, schedule another cycle
        // SAFE: Done outside lock context, no async work in finally block
        if (!this._shuttingDown && this._incomingFillQueue.length > 0) {
            // Schedule consumer restart asynchronously (not in finally block)
            setImmediate(() => this._consumeFillQueue(chainOrders).catch(err => {
                this._log(`Error in deferred consumer restart: ${err.message}`);
                if (this.manager && this.manager.logger) {
                    this.manager.logger.log(`Deferred consumer restart failed: ${err.message}`, 'error');
                }
            }));
        }
    }

    /**
     * Process fills during bootstrap phase using simple rotation.
     *
     * BOOTSTRAP MODE STRATEGY:
     * - Use pre-calculated grid sizes (no new math)
     * - When fill occurs: rotate opposite-side capital to cover the gap
     * - When BUY fills → rotate highest active BUY to next SELL slot
     * - When SELL fills → rotate highest active SELL to next BUY slot
     * - Maintain grid coverage with original slot sizes
     * - No rebalancing, no resizing - just rotation
     *
     * This ensures:
     * - Opposite-side reaction immediate (inventory balance)
     * - Grid sizes stay consistent with startup calculation
     * - Fast response during bootstrap without expensive calculations
     *
     * @param {Object} chainOrders - Chain orders instance for broadcasting
     * @returns {Promise<void>}
     */
    async _processFillsWithBootstrapMode(chainOrders) {
        if (this._incomingFillQueue.length === 0) return;

        const startTime = Date.now();
        const fills = this._incomingFillQueue.splice(0);
        const validFills = [];
        const processedFillKeys = new Set();
        const ORDER_TYPES = require('./constants').ORDER_TYPES;

        // 1. Validate and deduplicate fills
        for (const fill of fills) {
            if (!fill || fill.op?.[0] !== 4) continue;

            const fillOp = fill.op[1];
            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                Array.from(this.manager.orders.values()).find(o => o.orderId === fillOp.order_id);

            if (!gridOrder) {
                // CRITICAL FIX: Even if order not in grid, we must still credit the fill proceeds
                // This can happen when fills arrive after an order was marked VIRTUAL during sequential processing
                this.manager.logger.log(`[BOOTSTRAP] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                try {
                    this.manager.accountant.processFillAccounting(fillOp);
                } catch (accErr) {
                    this.manager.logger.log(`[BOOTSTRAP] Failed to process accounting for ${fillOp.order_id}: ${accErr.message}`, 'error');
                }
                continue;
            }

            const fillKey = `${fillOp.order_id}:${fill.block_num}:${fill.id || ''}`;
            if (processedFillKeys.has(fillKey)) continue;

            processedFillKeys.add(fillKey);
            validFills.push({ ...fill, gridOrder });

            const fillType = gridOrder.type === ORDER_TYPES.BUY ? 'BUY' : 'SELL';
            this._log(`[BOOTSTRAP] Fill detected: ${fillType} order (${fillOp.is_maker ? 'maker' : 'taker'})`);

            // Optimistically update account totals for bootstrap fills
            this.manager.accountant.processFillAccounting(fillOp);
        }

        if (validFills.length === 0) return;

        // 2. Process fills with simple rotation (use pre-calculated sizes)
        try {
            this._log(`[BOOTSTRAP] Processing ${validFills.length} fill(s) with simple rotation`, 'info');

            const ordersToPlace = [];

            for (const fill of validFills) {
                const filledOrder = fill.gridOrder;
                const filledType = filledOrder.type;
                const oppositeType = filledType === ORDER_TYPES.BUY ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;

                // Mark filled slot as VIRTUAL (released)
                this.manager._updateOrder({ ...virtualizeOrder(filledOrder), size: 0 }, 'bootstrap-fill', false, 0);

                // Find highest active order on opposite side (closest to market)
                const allOrders = Array.from(this.manager.orders.values());
                const activeOpposite = allOrders.filter(o =>
                    o.type === oppositeType &&
                    o.orderId &&
                    o.state === ORDER_STATES.ACTIVE
                );

                if (activeOpposite.length === 0) {
                    this._log(`[BOOTSTRAP] No active ${oppositeType} orders to rotate`, 'debug');
                    continue;
                }

                // Sort to find market-closest (highest price for SELL, lowest price for BUY)
                activeOpposite.sort((a, b) =>
                    oppositeType === ORDER_TYPES.SELL ? a.price - b.price : b.price - a.price
                );

                const surplusOrder = activeOpposite[0];

                // Find empty slot on opposite side (VIRTUAL with no orderId)
                const emptySlotsOpposite = allOrders.filter(o =>
                    o.type === oppositeType &&
                    !o.orderId &&
                    o.state === ORDER_STATES.VIRTUAL
                );

                if (emptySlotsOpposite.length === 0) {
                    this._log(`[BOOTSTRAP] No empty ${oppositeType} slots to rotate into`, 'debug');
                    continue;
                }

                // Sort to find best slot (closest to market)
                emptySlotsOpposite.sort((a, b) =>
                    oppositeType === ORDER_TYPES.SELL ? a.price - b.price : b.price - a.price
                );

                const targetSlot = emptySlotsOpposite[0];

                // Use the pre-calculated size from the grid
                const rotationSize = targetSlot.size;

                this._log(`[BOOTSTRAP] Rotating ${surplusOrder.id} → ${targetSlot.id} (${oppositeType} ${Format.formatAmount8(rotationSize)})`, 'info');

                // Mark surplus as released
                this.manager._updateOrder({ ...virtualizeOrder(surplusOrder), size: 0 }, 'bootstrap-rotate', false, 0);

                // Create rotation order with pre-calculated size
                ordersToPlace.push({
                    id: targetSlot.id,
                    type: oppositeType,
                    price: targetSlot.price,
                    size: rotationSize
                });
            }

            // Broadcast rotation orders
            if (ordersToPlace.length > 0) {
                const sizes = ordersToPlace.map(o => `${o.type}:${Format.formatAmount8(o.size)}`).join(' ');
                this._log(`[BOOTSTRAP] Broadcasting ${ordersToPlace.length} rotation order(s) - sizes: ${sizes}`, 'info');
                await this.updateOrdersOnChainBatch(ordersToPlace);
            }

            this._metrics.fillsProcessed += validFills.length;
            this._metrics.fillProcessingTimeMs += Date.now() - startTime;

        } catch (err) {
            this._warn(`[BOOTSTRAP] Error processing fills: ${err.message}`);
            this.manager.logger.log(`[BOOTSTRAP] Fill error: ${err.message}`, 'error');
        }
    }

    /**
     * Set up account identifier and configure global context.
     * @param {string} accountName - The name of the account to set up
     * @private
     */
    async _setupAccountContext(accountName) {
        const accId = await chainOrders.resolveAccountId(accountName);

        if (!accId) {
            throw new Error(`Unable to resolve account id for '${accountName}'`);
        }

        await chainOrders.setPreferredAccount(accId, accountName);
        this.account = accountName;
        this.accountId = accId;
        this._log(`Initialized DEXBot for account: ${this.account}`);
    }

    /**
     * Initialize the bot by connecting to BitShares and setting up the account.
     * @param {string} [masterPassword=null] - The master password for authentication.
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails or preferredAccount is missing.
     */
    async initialize(masterPassword = null) {
        await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);
        if (this.config && this.config.preferredAccount) {
            try {
                let privateKey = null;

                if (masterPassword) {
                    privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, masterPassword);
                } else if (chainKeys.isDaemonReady()) {
                    try {
                        privateKey = await chainKeys.getPrivateKeyFromDaemon(this.config.preferredAccount);
                    } catch (daemonErr) {
                        this._warn(`Credential daemon request failed: ${daemonErr.message}. Falling back to interactive authentication.`);
                    }
                }

                if (!privateKey) {
                    const pwd = await chainKeys.authenticate();
                    privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, pwd);
                }

                this.privateKey = privateKey;
                await this._setupAccountContext(this.config.preferredAccount);
            } catch (err) {
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                // dexbot.js has fallback to selectAccount, bot.js throws
                if (typeof chainOrders.selectAccount === 'function') {
                    const accountData = await chainOrders.selectAccount();
                    this.privateKey = accountData.privateKey;
                    await this._setupAccountContext(accountData.accountName);
                } else {
                    throw err;
                }
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
    }

    /**
     * Places initial orders on the blockchain.
     * @returns {Promise<void>}
     */
    async placeInitialOrders() {
        if (!this.manager) {
            this.manager = new OrderManager(this.config);
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }
        try {
            const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await this.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch) {
            this._warn(`Could not fetch account totals before initializing grid: ${errFetch && errFetch.message ? errFetch.message : errFetch}`);
        }

        await Grid.initializeGrid(this.manager);

        if (this.config.dryRun) {
            this.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            await this.manager.persistGrid();
            return;
        }

        this.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = this.manager.getInitialOrdersToActivate();

        const sellOrders = ordersToActivate.filter(o => o.type === 'sell');
        const buyOrders = ordersToActivate.filter(o => o.type === 'buy');
        const interleavedOrders = [];
        const maxLen = Math.max(sellOrders.length, buyOrders.length);
        for (let i = 0; i < maxLen; i++) {
            if (i < sellOrders.length) interleavedOrders.push(sellOrders[i]);
            if (i < buyOrders.length) interleavedOrders.push(buyOrders[i]);
        }

        // Refactored to use the batch logic while maintaining sequential execution in small groups.
        // This prevents hitting blockchain transaction size limits and provides incremental feedback.
        const orderGroups = [];
        for (let i = 0; i < interleavedOrders.length;) {
            const current = interleavedOrders[i];
            const next = interleavedOrders[i + 1];
            // Prefer grouping sell+buy pairs to balance side-specific limits
            if (next && current.type === 'sell' && next.type === 'buy') {
                orderGroups.push([current, next]);
                i += 2;
            } else {
                orderGroups.push([current]);
                i += 1;
            }
        }

        for (const group of orderGroups) {
            await this.updateOrdersOnChainBatch({ ordersToPlace: group });
        }

        await this.manager.persistGrid();
        this.manager.finishBootstrap();
    }

    /**
     * Get the maximum allowed order size based on the largest grid order.
     * Max size = biggest order × 1.1 (allows 10% buffer above largest order)
     * @returns {number} Maximum allowed order size in float amount
     * @private
     */
    _getMaxOrderSize() {
        const { GRID_LIMITS } = require('./constants');

        // Get all orders and find the biggest by size
        const allOrders = Array.from(this.manager.orders.values());
        if (allOrders.length === 0) {
            return Infinity; // No orders yet, no constraint
        }

        const biggestOrder = allOrders.reduce((max, order) =>
            (order.size > max.size) ? order : max
        );

        // Maximum order size = largest order × MAX_ORDER_FACTOR
        // Prevents creating oversized orders during validation and grid expansion
        // Ensures gradual grid expansion when funds increase
        // Fallback to 1.1 if constant is not defined
        return biggestOrder.size * (GRID_LIMITS.MAX_ORDER_FACTOR || 1.1);
    }

    /**
     * Validate that operations can be executed with available funds before broadcasting.
     * Checks: (1) sufficient available funds, (2) individual orders don't exceed max size limit
     * @param {Array} operations - Operations to validate
     * @param {Object} assetA - Asset A metadata (id, precision, symbol)
     * @param {Object} assetB - Asset B metadata (id, precision, symbol)
     * @returns {Object} { isValid: boolean, summary: string }
     * @private
     */
    _validateOperationFunds(operations, assetA, assetB) {
        if (!operations || operations.length === 0) {
            return { isValid: true, summary: 'No operations to validate' };
        }

        const { blockchainToFloat, floatToBlockchainInt, quantizeFloat } = require('./order/utils/math');
        const snap = this.manager.getChainFundsSnapshot();
        const maxOrderSize = this._getMaxOrderSize();
        const requiredFunds = { [assetA.id]: 0, [assetB.id]: 0 };
        const orderSizeViolations = [];

        // Sum amounts and check individual order sizes
        for (const op of operations) {
            if (!op?.op_data) continue;

            let sellAssetId = null;
            let sellAmountInt = 0;

            if (op.op_name === 'limit_order_create') {
                sellAssetId = op.op_data.amount_to_sell?.asset_id;
                sellAmountInt = op.op_data.amount_to_sell?.amount;
            } else if (op.op_name === 'limit_order_update') {
                // In limit_order_update, new_price.base is the amount to sell
                sellAssetId = op.op_data.new_price?.base?.asset_id;
                sellAmountInt = op.op_data.new_price?.base?.amount;
            }

            if (sellAssetId && (sellAmountInt !== undefined && sellAmountInt !== null)) {
                const precision = (sellAssetId === assetA.id) ? assetA.precision : assetB.precision;
                const assetSymbol = (sellAssetId === assetA.id) ? assetA.symbol : assetB.symbol;

                // CRITICAL SAFETY CHECK: Ensure amount is greater than zero
                if (Number(sellAmountInt) <= 0) {
                    return {
                        isValid: false,
                        summary: `[VALIDATION] CRITICAL: Zero amount order detected for ${assetSymbol} (assetId=${sellAssetId})`,
                        violations: [{ asset: assetSymbol, sizeInt: sellAmountInt, reason: 'Zero amount' }]
                    };
                }

                // CRITICAL SAFETY CHECK: Use integer comparison for max size
                if (Number.isFinite(maxOrderSize)) {
                    const maxOrderSizeInt = floatToBlockchainInt(maxOrderSize, precision);
                    if (Number(sellAmountInt) > maxOrderSizeInt) {
                        orderSizeViolations.push({
                            asset: assetSymbol,
                            sizeInt: sellAmountInt,
                            maxInt: maxOrderSizeInt,
                            sizeFloat: blockchainToFloat(sellAmountInt, precision)
                        });
                    }
                }

                // Accumulate required funds using quantized sums to match blockchain math
                const floatAmount = blockchainToFloat(sellAmountInt, precision);

                // For updates, we only deduct the DELTA (increase in commitment)
                if (op.op_name === 'limit_order_update') {
                    const deltaAssetId = op.op_data.delta_amount_to_sell?.asset_id;
                    const deltaSellInt = op.op_data.delta_amount_to_sell?.amount;
                    if (deltaAssetId === sellAssetId && deltaSellInt > 0) {
                        const floatDelta = blockchainToFloat(deltaSellInt, precision);
                        requiredFunds[sellAssetId] = quantizeFloat((requiredFunds[sellAssetId] || 0) + floatDelta, precision);
                    }
                } else {
                    // For creates, we deduct the full amount
                    requiredFunds[sellAssetId] = quantizeFloat((requiredFunds[sellAssetId] || 0) + floatAmount, precision);
                }
            }
        }

        // Calculate available funds - CRITICAL FIX: Check against FREE balance, not free+required
        // Bug: Previous logic added requiredFunds to available, making validation meaningless
        // Correct logic: available = chainFree (current free balance)
        // If required > available, batch will fail on execution
        const availableFunds = {
            [assetA.id]: quantizeFloat(snap.chainFreeSell || 0, assetA.precision),
            [assetB.id]: quantizeFloat(snap.chainFreeBuy || 0, assetB.precision)
        };

        // Check for order size violations
        if (orderSizeViolations.length > 0) {
            let summary = `[VALIDATION] CRITICAL: Order size limit FAILED (Absurd Size Check):\n`;
            for (const v of orderSizeViolations) {
                summary += `  ${v.asset}: sizeInt=${v.sizeInt}, maxInt=${v.maxInt} (approx ${Format.formatAmount8(v.sizeFloat)})\n`;
            }
            return { isValid: false, summary: summary.trim(), violations: orderSizeViolations };
        }

        // Check for fund violations using quantized comparison
        const fundViolations = [];
        for (const assetId in requiredFunds) {
            const required = requiredFunds[assetId];
            const available = availableFunds[assetId] || 0;

            // Use precision-aware comparison
            const prec = (assetId === assetA.id) ? assetA.precision : assetB.precision;
            if (floatToBlockchainInt(required, prec) > floatToBlockchainInt(available, prec)) {
                fundViolations.push({
                    asset: assetId === assetA.id ? assetA.symbol : assetB.symbol,
                    required, available, deficit: quantizeFloat(required - available, prec)
                });
            }
        }

        if (fundViolations.length > 0) {
            let summary = `[VALIDATION] Fund validation FAILED:\n`;
            for (const v of fundViolations) {
                summary += `  ${v.asset}: required=${Format.formatAmount8(v.required)}, available=${Format.formatAmount8(v.available)}, deficit=${Format.formatAmount8(v.deficit)}\n`;
            }
            return { isValid: false, summary: summary.trim(), violations: fundViolations };
        }

        const summary = `[VALIDATION] PASSED: ${operations.length} operations, max order=${Format.formatAmount8(maxOrderSize)}`;
        return { isValid: true, summary };
    }

    /**
     * Executes a batch of order operations on the blockchain.
     * @param {Object} rebalanceResult - The result of a rebalance operation.
     * @returns {Promise<Object>} The batch result.
     */
    async updateOrdersOnChainBatch(rebalanceResult) {
        let { ordersToPlace, ordersToRotate = [], ordersToUpdate = [], ordersToCancel = [] } = rebalanceResult;

        if (this.config.dryRun) {
            if (ordersToCancel && ordersToCancel.length > 0) this.manager.logger.log(`Dry run: would cancel ${ordersToCancel.length} orders`, 'info');
            if (ordersToPlace && ordersToPlace.length > 0) this.manager.logger.log(`Dry run: would place ${ordersToPlace.length} new orders`, 'info');
            if (ordersToRotate && ordersToRotate.length > 0) this.manager.logger.log(`Dry run: would update ${ordersToRotate.length} orders`, 'info');
            if (ordersToUpdate && ordersToUpdate.length > 0) this.manager.logger.log(`Dry run: would update size of ${ordersToUpdate.length} orders`, 'info');
            return { executed: true, hadRotation: false };
        }

        const { assetA, assetB } = this.manager.assets;
        const operations = [];
        const opContexts = [];

        // Collect IDs to lock (shadow lock: prevents these orders from being selected for rebalancing)
        // NOTE: Shadow locks are cooperative - they work only if rebalancing logic checks exclusion sets.
        // See line 281-288 where fillExcludeSet prevents selecting orders in flight.
        const idsToLock = new Set();

        // Add cancellation order IDs
        if (ordersToCancel && Array.isArray(ordersToCancel)) {
            ordersToCancel.forEach(o => {
                if (o && o.orderId) idsToLock.add(o.orderId);
                if (o && o.id) idsToLock.add(o.id);
            });
        }

        // Add placement order IDs (new virtual orders being placed)
        if (ordersToPlace && Array.isArray(ordersToPlace)) {
            ordersToPlace.forEach(o => {
                if (o && o.id) idsToLock.add(o.id);
            });
        }

        // Add rotation order IDs (both old chain IDs and new grid IDs)
        if (ordersToRotate && Array.isArray(ordersToRotate)) {
            ordersToRotate.forEach(r => {
                if (r && r.oldOrder && r.oldOrder.orderId) idsToLock.add(r.oldOrder.orderId);
                if (r && r.newGridId) idsToLock.add(r.newGridId);
            });
        }

        // Add update order IDs (orders being size-updated)
        if (ordersToUpdate && Array.isArray(ordersToUpdate)) {
            ordersToUpdate.forEach(u => {
                if (u && u.partialOrder && u.partialOrder.orderId) idsToLock.add(u.partialOrder.orderId);
            });
        }

        // Apply shadow locks to prevent concurrent selection of these orders
        // IMPORTANT: This is cooperative locking - rebalancing must respect these locks via exclusion sets
        this.manager.lockOrders(idsToLock);

        try {
            // 1. Build Operations
            // Priority 1: Cancellations (Outside-In surpluses)
            await this._buildCancelOps(ordersToCancel, operations, opContexts);

            // Priority 2: Placements and Updates
            await this._buildCreateOps(ordersToPlace, assetA, assetB, operations, opContexts);
            await this._buildSizeUpdateOps(ordersToUpdate, operations, opContexts);

            // Build rotation ops and capture any unmet rotations (orders that don't exist on-chain)
            const unmetRotations = await this._buildRotationOps(ordersToRotate, assetA, assetB, operations, opContexts);

            // Convert unmet rotations to placements so we still fill the grid gaps
            if (unmetRotations.length > 0) {
                this.manager.logger.log(`Converting ${unmetRotations.length} unmet rotations to new placements`, 'info');
                // CRITICAL: Use VIRTUAL state for fallback placements - they only become ACTIVE
                // after blockchain confirmation via synchronizeWithChain('createOrder')
                const fallbackPlacements = unmetRotations.map(r => ({
                    id: r.newGridId,
                    price: r.newPrice,
                    size: r.newSize,
                    type: r.type,
                    state: ORDER_STATES.VIRTUAL
                }));
                await this._buildCreateOps(fallbackPlacements, assetA, assetB, operations, opContexts);
            }

            if (operations.length === 0) return { executed: false, hadRotation: false };

            // 2. Validate Funds Before Broadcasting
            const validation = this._validateOperationFunds(operations, assetA, assetB);
            this.manager.logger.log(validation.summary, validation.isValid ? 'info' : 'warn');

            if (!validation.isValid) {
                this.manager.logger.log(`Skipping batch broadcast: ${validation.violations.length} fund violation(s) detected`, 'warn');

                // Trigger sync to revert optimistic state on validation failure
                try {
                    this.manager.logger.log('Triggering state recovery sync...', 'info');
                    // FETCH FRESH BALANCES FIRST to reset optimistic drift
                    await this.manager.fetchAccountTotals(this.accountId);
                    const openOrders = await chainOrders.readOpenOrders(this.accountId);
                    await this.manager.syncFromOpenOrders(openOrders, { skipAccounting: false });
                } catch (syncErr) {
                    this.manager.logger.log(`Recovery sync failed: ${syncErr.message}`, 'error');
                }

                return { executed: false, hadRotation: false };
            }

            // 3. Execute Batch
            this.manager.logger.log(`Broadcasting batch with ${operations.length} operations...`, 'info');
            const result = await chainOrders.executeBatch(this.account, this.privateKey, operations);

            // 4. Process Results
            this.manager.pauseFundRecalc();
            try {
                const batchResult = await this._processBatchResults(result, opContexts);
                this._metrics.batchesExecuted++;
                return batchResult;
            } finally {
                this.manager.resumeFundRecalc();
                this.manager.logger.logFundsStatus(this.manager, `AFTER updateOrdersOnChainBatch (placed=${ordersToPlace?.length || 0}, rotated=${ordersToRotate?.length || 0})`);
            }

        } catch (err) {
            this.manager.logger.log(`Batch transaction failed: ${err.message}`, 'error');

            // Check if failure is due to stale (non-existent) order references.
            // Match all stale order IDs — multiple formats possible across BitShares node versions.
            const staleOrderIds = new Set();
            const patterns = [
                /Limit order (1\.7\.\d+) does not exist/g,
                /Unable to find Object (1\.7\.\d+)/g,
                /object (1\.7\.\d+) (?:does not exist|not found)/gi
            ];
            for (const pattern of patterns) {
                let m;
                while ((m = pattern.exec(err.message)) !== null) {
                    staleOrderIds.add(m[1]);
                }
            }

            if (staleOrderIds.size > 0 && operations.length > 1) {
                this.manager.logger.log(`Stale order(s) ${[...staleOrderIds].join(', ')} detected in failed batch. Cleaning up and retrying.`, 'warn');

                // Clean up grid slot(s) referencing stale orderIds.
                // CRITICAL: Track these IDs so orphan-fill handler won't double-credit proceeds.
                // When the slot is converted to SPREAD/VIRTUAL, committed funds are released to
                // chainFree. If a fill event later arrives for this order, the orphan-fill handler
                // must skip crediting to avoid double-counting.
                for (const gridOrder of this.manager.orders.values()) {
                    if (staleOrderIds.has(gridOrder.orderId)) {
                        this.manager.logger.log(`Cleaning stale reference from grid slot ${gridOrder.id} (orderId=${gridOrder.orderId})`, 'warn');
                        this._staleCleanedOrderIds.set(gridOrder.orderId, Date.now());
                        const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                        this.manager._updateOrder(spreadOrder, 'batch-stale-cleanup', false, 0);
                    }
                }

                // Filter out operations referencing any stale orderId
                const filteredOps = [];
                const filteredCtxs = [];
                for (let i = 0; i < operations.length; i++) {
                    const opData = operations[i].op_data;
                    const refersToStale =
                        staleOrderIds.has(opData.order) ||               // limit_order_cancel
                        staleOrderIds.has(opData.order_id);              // limit_order_update
                    if (!refersToStale) {
                        filteredOps.push(operations[i]);
                        filteredCtxs.push(opContexts[i]);
                    }
                }

                // Retry once with remaining operations
                if (filteredOps.length > 0) {
                    try {
                        this.manager.logger.log(`Retrying batch with ${filteredOps.length} operation(s) (excluded ${staleOrderIds.size} stale ref(s))...`, 'info');
                        const retryResult = await chainOrders.executeBatch(this.account, this.privateKey, filteredOps);

                        this.manager.pauseFundRecalc();
                        try {
                            const batchResult = await this._processBatchResults(retryResult, filteredCtxs);
                            this._metrics.batchesExecuted++;
                            return batchResult;
                        } finally {
                            this.manager.resumeFundRecalc();
                        }
                    } catch (retryErr) {
                        this.manager.logger.log(`Retry batch also failed: ${retryErr.message}`, 'error');
                        // Fall through to recovery sync below
                    }
                }
            }

            // Trigger sync to revert optimistic state on execution failure
            try {
                this.manager.logger.log('Triggering state recovery sync...', 'info');
                // FETCH FRESH BALANCES FIRST to reset optimistic drift
                await this.manager.fetchAccountTotals(this.accountId);
                const openOrders = await chainOrders.readOpenOrders(this.accountId);
                await this.manager.syncFromOpenOrders(openOrders, { skipAccounting: false });
            } catch (syncErr) {
                this.manager.logger.log(`Recovery sync failed: ${syncErr.message}`, 'error');
            }

            return { executed: false, hadRotation: false };
        } finally {
            this.manager.unlockOrders(idsToLock);
        }
    }

    /**
     * Build create order operations for new placements.
     * @param {Array} ordersToPlace - Grid orders to place
     * @param {Object} assetA - Asset A metadata
     * @param {Object} assetB - Asset B metadata
     * @param {Array} operations - Operations array to append to
     * @param {Array} opContexts - Operation contexts array to append to
     * @private
     */
    /**
     * Build cancellation operations for surplus orders.
     * @param {Array} ordersToCancel - Grid orders to cancel
     * @param {Array} operations - Operations array to append to
     * @param {Array} opContexts - Operation contexts array to append to
     * @private
     */
    async _buildCancelOps(ordersToCancel, operations, opContexts) {
        if (!ordersToCancel || ordersToCancel.length === 0) return;
        for (const order of ordersToCancel) {
            if (!order.orderId) continue;
            try {
                const op = await chainOrders.buildCancelOrderOp(this.account, order.orderId);
                operations.push(op);
                opContexts.push({ kind: 'cancel', order });
            } catch (err) {
                this.manager.logger.log(`Failed to prepare cancel op for order ${order.id} (${order.orderId}): ${err.message}`, 'error');
            }
        }
    }

    async _buildCreateOps(ordersToPlace, assetA, assetB, operations, opContexts) {
        if (!ordersToPlace || ordersToPlace.length === 0) return;

        // Pre-check: Verify available funds before attempting to build operations
        // IMPORTANT: Separate BUY and SELL orders - they use different asset budgets!
        const buyOrders = ordersToPlace.filter(o => o.type === 'buy');
        const sellOrders = ordersToPlace.filter(o => o.type === 'sell');

        // Check BUY orders against buyFree (assetB funds)
        if (buyOrders.length > 0) {
            const buyTotalSize = buyOrders.reduce((sum, o) => sum + o.size, 0);
            const buyFund = this.manager.accountTotals?.buyFree ?? 0;
            if (buyTotalSize > buyFund) {
                const buyPrecision = this.manager.assets?.assetB?.precision;
                const buyTotalText = Number.isFinite(buyPrecision)
                    ? Format.formatAmountByPrecision(buyTotalSize, buyPrecision)
                    : String(buyTotalSize);
                const buyFundText = Number.isFinite(buyPrecision)
                    ? Format.formatAmountByPrecision(buyFund, buyPrecision)
                    : String(buyFund);
                this.manager.logger.log(
                    `Warning: total order size (${buyTotalText}) exceeds available funds (${buyFundText}) for buy. ` +
                    `Some orders may be skipped or placed at reduced size.`,
                    'warn'
                );
            }
        }

        // Check SELL orders against sellFree (assetA funds)
        if (sellOrders.length > 0) {
            const sellTotalSize = sellOrders.reduce((sum, o) => sum + o.size, 0);
            const sellFund = this.manager.accountTotals?.sellFree ?? 0;
            if (sellTotalSize > sellFund) {
                const sellPrecision = this.manager.assets?.assetA?.precision;
                const sellTotalText = Number.isFinite(sellPrecision)
                    ? Format.formatAmountByPrecision(sellTotalSize, sellPrecision)
                    : String(sellTotalSize);
                const sellFundText = Number.isFinite(sellPrecision)
                    ? Format.formatAmountByPrecision(sellFund, sellPrecision)
                    : String(sellFund);
                this.manager.logger.log(
                    `Warning: total order size (${sellTotalText}) exceeds available funds (${sellFundText}) for sell. ` +
                    `Some orders may be skipped or placed at reduced size.`,
                    'warn'
                );
            }
        }

        for (const order of ordersToPlace) {
            // Determine order type for validation (not just first order)
            const sideOfOrders = order.type || 'unknown';
            try {
                // Comprehensive order size validation (absolute minimum + double-dust threshold)
                const sizeValidation = validateOrderSize(
                    order.size,
                    sideOfOrders,
                    this.manager.assets,
                    GRID_LIMITS.MIN_ORDER_SIZE_FACTOR || 50,
                    null,  // No ideal size here; threshold checks already done in grid/strategy
                    GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE || 5
                );

                if (!sizeValidation.isValid) {
                    this.manager.logger.log(
                        `Skipping placement: ${sizeValidation.reason}. Order: ${order.id}`,
                        'warn'
                    );
                    continue;
                }

                const args = buildCreateOrderArgs(order, assetA, assetB);

                // Build the operation - returns null if amounts would round to 0 on blockchain
                const result = await chainOrders.buildCreateOrderOp(
                    this.account, args.amountToSell, args.sellAssetId,
                    args.minToReceive, args.receiveAssetId, null
                );

                // Skip if order amounts are invalid (would round to 0)
                if (!result) {
                    this.manager.logger.log(
                        `Skipping placement: amounts would round to 0 on blockchain. ` +
                        `Order: ${order.type} ${order.id} size=${Format.formatSizeByOrderType(order.size, order.type, this.manager.assets)} @ price=${Format.formatPrice(order.price)}`,
                        'warn'
                    );
                    continue;
                }

                const { op, finalInts } = result;
                operations.push(op);
                opContexts.push({ kind: 'create', order, args, finalInts });
            } catch (err) {
                this.manager.logger.log(`Failed to prepare create op for ${order.type} order ${order.id}: ${err.message}`, 'error');
            }
        }
    }

    /**
     * Build size update operations for partial order consolidation.
     * Used when dust partials need to be updated to their target size.
     * @param {Array} ordersToUpdate - Partial orders needing size updates
     * @param {Array} operations - Operations array to append to
     * @param {Array} opContexts - Operation contexts array to append to
     * @private
     */
    async _buildSizeUpdateOps(ordersToUpdate, operations, opContexts) {
        if (!ordersToUpdate || ordersToUpdate.length === 0) return;
        this.manager.logger.log(`[SPLIT UPDATE] Processing ${ordersToUpdate.length} size update(s)`, 'info');

        for (const updateInfo of ordersToUpdate) {
            try {
                const { partialOrder, newSize } = updateInfo;
                if (!partialOrder.orderId) continue;

                const buildResult = await chainOrders.buildUpdateOrderOp(
                    this.account, partialOrder.orderId,
                    { amountToSell: newSize, orderType: partialOrder.type },
                    partialOrder.rawOnChain // Use cached raw order to avoid redundant fetch
                );

                if (buildResult) {
                    const { op, finalInts } = buildResult;
                    operations.push(op);
                    opContexts.push({ kind: 'size-update', updateInfo, finalInts });
                }
            } catch (err) {
                this.manager.logger.log(`[SPLIT UPDATE] Failed to prepare size update op: ${err.message}`, 'error');
            }
        }
    }


    /**
     * Build rotation operations for moving orders to new prices.
     * Tracks unmet rotations (orders missing on-chain) for fallback to creation.
     * @param {Array} ordersToRotate - Orders with rotation targets
     * @param {Object} assetA - Asset A metadata
     * @param {Object} assetB - Asset B metadata
     * @param {Array} operations - Operations array to append to
     * @param {Array} opContexts - Operation contexts array to append to
     * @param {Array} virtualOpenOrders - Optional: virtual state of open orders (with pending updates applied)
     * @returns {Array} Unmet rotations (fallback to placements)
     * @private
     */
    async _buildRotationOps(ordersToRotate, assetA, assetB, operations, opContexts) {
        if (!ordersToRotate || ordersToRotate.length === 0) return [];

        const seenOrderIds = new Set();
        const unmetRotations = [];  // Track rotations that couldn't be executed

        for (const rotation of ordersToRotate) {
            const { oldOrder, newPrice, newSize, type, newGridId } = rotation;
            if (!oldOrder.orderId || seenOrderIds.has(oldOrder.orderId)) continue;
            seenOrderIds.add(oldOrder.orderId);

            // Trust internal grid state: if orderId exists and no rawOnChain cache,
            // it's likely a newly placed order. buildUpdateOrderOp will handle
            // the fetch if cache is missing.
            try {
                const { amountToSell, minToReceive } = buildCreateOrderArgs({ type, size: newSize, price: newPrice }, assetA, assetB);
                const buildResult = await chainOrders.buildUpdateOrderOp(
                    this.account, oldOrder.orderId,
                    { amountToSell, minToReceive, newPrice, orderType: type },
                    oldOrder.rawOnChain // Use cached raw order to avoid redundant fetch
                );

                if (buildResult) {
                    const { op, finalInts } = buildResult;
                    operations.push(op);
                    opContexts.push({ kind: 'rotation', rotation, finalInts });
                } else {
                    this.manager.logger.log(`Skipping rotation of ${oldOrder.orderId}: no blockchain change needed`, 'debug');
                }
            } catch (err) {
                // If the error indicates the order is missing, re-check open orders once
                // before converting rotation to placement. This reduces false fallback
                // conversions caused by transient API/index lag.
                if (/not found|does not exist|unable to find object/i.test(String(err?.message || ''))) {
                    let confirmedMissing = false;
                    try {
                        const accountRef = this.accountId || this.account;
                        const freshOpenOrders = await chainOrders.readOpenOrders(accountRef);
                        const stillExists = Array.isArray(freshOpenOrders)
                            && freshOpenOrders.some(o => String(o?.id) === String(oldOrder.orderId));

                        if (stillExists) {
                            this.manager.logger.log(
                                `Rotation recheck found order ${oldOrder.orderId} still on-chain. Skipping create fallback for this cycle.`,
                                'warn'
                            );
                        } else {
                            confirmedMissing = true;
                        }
                    } catch (recheckErr) {
                        this.manager.logger.log(
                            `Rotation missing-order recheck failed for ${oldOrder.orderId}: ${recheckErr.message}. Deferring fallback to avoid duplicate exposure.`,
                            'warn'
                        );
                    }

                    if (confirmedMissing) {
                        this.manager.logger.log(`Rotation fallback to creation: Order ${oldOrder.orderId} not found after recheck`, 'warn');
                        unmetRotations.push({ newGridId, newPrice, newSize, type });
                    }
                } else {
                    this.manager.logger.log(`Failed to prepare rotation op: ${err.message}`, 'error');
                }
            }
        }

        return unmetRotations;
    }

    /**
     * Process results from batch transaction execution.
     * Updates order state, synchronizes with chain, and deducts BTS fees.
     * @param {Object} result - Transaction result from executeBatch
     * @param {Array} opContexts - Operation context array with operation metadata (must be 1:1 with result.operation_results)
     * @returns {Object} Result with { executed: boolean, hadRotation: boolean }
     * @private
     */
    async _processBatchResults(result, opContexts) {
        const results = (result && result[0] && result[0].trx && result[0].trx.operation_results) || [];
        const { getAssetFees } = require('./order/utils/math');
        const btsFeeData = getAssetFees('BTS', 1);
        let hadRotation = false;
        let updateOperationCount = 0;

        for (let i = 0; i < opContexts.length; i++) {
            const ctx = opContexts[i];
            const res = results[i];

            if (ctx.kind === 'cancel') {
                this.manager.logger.log(`Cancelled surplus order ${ctx.order.id} (${ctx.order.orderId})`, 'info');
                // Synchronization handled by rebalance result stateUpdates applied in caller
            }
            else if (ctx.kind === 'size-update') {
                const ord = this.manager.orders.get(ctx.updateInfo.partialOrder.id);
                if (ord) {
                    const updatedSlot = { ...ord, size: ctx.updateInfo.newSize };
                    // Update rawOnChain cache with new integers
                    if (ctx.finalInts) {
                        updatedSlot.rawOnChain = {
                            id: ord.orderId,
                            for_sale: String(ctx.finalInts.sell),
                            sell_price: {
                                base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                            }
                        };
                    }
                    this.manager._updateOrder(updatedSlot, 'order-update', false, btsFeeData.updateFee);
                }
                this.manager.logger.log(`Size update complete: ${ctx.updateInfo.partialOrder.orderId}`, 'info');
                updateOperationCount++;
            }
            else if (ctx.kind === 'create') {
                const chainOrderId = res && res[1];
                if (chainOrderId) {
                    const gridOrder = this.manager.orders.get(ctx.order.id);
                    if (gridOrder) {
                        const updatedOrder = { ...gridOrder };
                        // Populate rawOnChain cache for newly created order with blockchain integers
                        if (ctx.finalInts) {
                            updatedOrder.rawOnChain = {
                                id: chainOrderId,
                                for_sale: String(ctx.finalInts.sell),
                                sell_price: {
                                    base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                    quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                                }
                            };
                        }
                        this.manager._updateOrder(updatedOrder, 'post-placement', false, 0);
                    }

                    await this.manager.synchronizeWithChain({
                        gridOrderId: ctx.order.id, chainOrderId, fee: btsFeeData.createFee
                    }, 'createOrder');
                    this.manager.logger.log(`Placed ${ctx.order.type} order ${ctx.order.id} -> ${chainOrderId}`, 'info');
                }
            }
            else if (ctx.kind === 'rotation') {
                // Rotation processing: divergence corrections are already synchronized via _divergenceLock
                // during fill processing, so no additional lock needed here
                hadRotation = true;
                const { rotation } = ctx;
                const { oldOrder, newPrice, newGridId, newSize, type } = rotation;

                if (!newGridId) {
                    // Size correction only
                    const ord = this.manager.orders.get(oldOrder.id || rotation.id);
                    if (ord) {
                        const updatedSlot = { ...ord, size: newSize };
                        // Update rawOnChain cache with new integers
                        if (ctx.finalInts) {
                            updatedSlot.rawOnChain = {
                                id: ord.orderId,
                                for_sale: String(ctx.finalInts.sell),
                                sell_price: {
                                    base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                    quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                                }
                            };
                        }
                        this.manager._updateOrder(updatedSlot, 'order-update', false, btsFeeData.updateFee);
                    }

                    updateOperationCount++;
                    continue;
                }

                // Full rotation
                const slot = this.manager.orders.get(newGridId) || { id: newGridId, type, price: newPrice, size: 0, state: ORDER_STATES.VIRTUAL };
                const isPartialPlacement = slot.size > 0 && newSize < slot.size;

                const updatedSlot = { ...slot, id: newGridId, type, size: newSize, price: newPrice, state: ORDER_STATES.VIRTUAL, orderId: null };

                // Update rawOnChain cache for the rotated order
                if (ctx.finalInts) {
                    updatedSlot.rawOnChain = {
                        id: oldOrder.orderId,
                        for_sale: String(ctx.finalInts.sell),
                        sell_price: {
                            base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                            quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                        }
                    };
                }

                this.manager._updateOrder(updatedSlot, 'rotation-prepare', false, 0);

                this.manager.completeOrderRotation(oldOrder);

                try {
                    await this.manager.synchronizeWithChain({
                        gridOrderId: newGridId, chainOrderId: oldOrder.orderId, isPartialPlacement, fee: btsFeeData.updateFee
                    }, 'createOrder');
                    updateOperationCount++;
                } catch (err) {
                    this.manager.logger.log(`ERROR: Sync failed for rotation ${oldOrder.orderId} -> ${newGridId}`, 'error');
                }
            }
        }

        return { executed: true, hadRotation };
    }

    /**
     * Perform grid recalculation triggered by trigger file.
     * Reloads config from disk, recalculates grid, resets funds, and removes trigger file.
     * Must be called with _fillProcessingLock already held.
     * @returns {Promise<boolean>} True if resync succeeded
     * @private
     */
    async _performGridResync() {
        let success = false;
        this.manager.startBootstrap();
        this._log('Grid regeneration triggered. Performing full grid resync...');
        try {
            // 1. Reload configuration from disk to pick up any changes
            try {
                const { parseJsonWithComments } = require('./account_bots');
                const content = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
                const allBotsConfig = parseJsonWithComments(content).bots || [];

                // Find this bot by name or fallback to index if name changed?
                // Better: find by current name.
                const myName = this.config.name;
                const updatedBot = allBotsConfig.find(b => b.name === myName);

                if (updatedBot) {
                    this._log(`Reloaded configuration for bot '${myName}'`);
                    // Keep botKey and index if they were set
                    const oldKey = this.config.botKey;
                    const oldIndex = this.config.botIndex;
                    this.config = { ...updatedBot, botKey: oldKey, botIndex: oldIndex };
                    this.manager.config = { ...this.manager.config, ...this.config };
                }
            } catch (e) {
                this._warn(`Failed to reload config during resync (using current settings): ${e.message}`);
            }

            // 2. Perform the actual grid recalculation
            const readFn = () => chainOrders.readOpenOrders(this.accountId);
            await Grid.recalculateGrid(this.manager, {
                readOpenOrdersFn: readFn,
                chainOrders,
                account: this.account,
                privateKey: this.privateKey,
                config: this.config,
            });

            // Reset cacheFunds when grid is regenerated (already handled inside recalculateGrid, but ensure local match)
            // SAFE: Protected by _fillProcessingLock held by caller
            this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
            this.manager.funds.btsFeesOwed = 0;
            await this.manager.persistGrid();
            success = true;

            if (fs.existsSync(this.triggerFile)) {
                fs.unlinkSync(this.triggerFile);
                this._log('Removed trigger file.');
            }
        } catch (err) {
            this._log(`Error during triggered resync: ${err.message}`, 'error');
        } finally {
            this.manager.finishBootstrap();
        }

        return success;
    }

    /**
     * Handle any pending trigger file reset at startup.
     * This is called FIRST during startup before any grid operations.
     * @returns {Promise<boolean>} True if trigger reset completed successfully, false otherwise
     * @private
     */
    async _handlePendingTriggerReset() {
        if (!fs.existsSync(this.triggerFile)) {
            return false; // No pending reset
        }

        this._log('Pending trigger file detected. Processing reset before startup...');

        // Use fill lock to prevent concurrent modifications during resync
        let resetSucceeded = false;
        await this.manager._fillProcessingLock.acquire(async () => {
            resetSucceeded = await this._performGridResync();
        });

        if (!resetSucceeded) {
            this._warn('Pending trigger reset failed. Continuing with normal startup path.');
        }

        return resetSucceeded;
    }

    /**
     * Setup trigger file detection for grid reset.
     * Monitors the trigger file and performs grid resync when it's created.
     * @private
     */
    async _setupTriggerFileDetection() {
        // NOTE: Startup trigger file check is now handled in _handlePendingTriggerReset()
        // This method now only sets up the runtime file watcher for trigger detection.

        // Debounced watcher to avoid duplicate rapid triggers on some platforms
        if (this._triggerWatcher && typeof this._triggerWatcher.close === 'function') {
            this._triggerWatcher.close();
            this._triggerWatcher = null;
        }

        if (this._triggerDebounceTimer) {
            clearTimeout(this._triggerDebounceTimer);
            this._triggerDebounceTimer = null;
        }

        try {
            this._triggerWatcher = fs.watch(PROFILES_DIR, (eventType, filename) => {
                try {
                    if (this._shuttingDown) return;

                    if (filename === path.basename(this.triggerFile)) {
                        if ((eventType === 'rename' || eventType === 'change') && fs.existsSync(this.triggerFile)) {
                            if (this._triggerDebounceTimer) clearTimeout(this._triggerDebounceTimer);
                            this._triggerDebounceTimer = setTimeout(() => {
                                this._triggerDebounceTimer = null;
                                // Use fill lock to prevent concurrent modifications during resync
                                this.manager._fillProcessingLock.acquire(async () => {
                                    const ok = await this._performGridResync();
                                    if (!ok) {
                                        this._warn('Runtime trigger reset failed; retaining existing grid state.');
                                    }
                                }).catch(err => {
                                    this._warn(`Trigger reset lock error: ${err.message}`);
                                });
                            }, 200);
                        }
                    }
                } catch (err) {
                    this._warn(`fs.watch handler error: ${err && err.message ? err.message : err}`);
                }
            });
        } catch (err) {
            this._warn(`Failed to setup file watcher: ${err.message}`);
        }
    }

    /**
     * Starts the bot's operation.
     * @param {string} [masterPassword=null] - The master password.
     * @returns {Promise<void>}
     */
    async start(masterPassword = null) {
        await this.initialize(masterPassword);
        await this._runStartupSequence();
    }

    /**
     * Start bot with a pre-decrypted private key.
     * Alternative to start(masterPassword) when key is already decrypted.
     * @param {string} privateKey - Pre-decrypted private key
     * @returns {Promise<void>}
     */
    async startWithPrivateKey(privateKey) {
        // Initialize account data with provided private key
        await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);

        if (this.config && this.config.preferredAccount) {
            try {
                this.privateKey = privateKey;
                await this._setupAccountContext(this.config.preferredAccount);
            } catch (err) {
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                throw err;
            }
        } else {
            throw new Error('No preferredAccount configured');
        }

        await this._runStartupSequence();
    }

    /**
     * Common startup sequence logic shared between start() and startWithPrivateKey().
     * @private
     */
    async _runStartupSequence() {
        try {
            const startupState = await this._initializeStartupState();
            await this._finishStartupSequence(startupState);
        } catch (err) {
            this._warn(`Error during grid initialization: ${err.message}`);
            await this.shutdown();
            throw err;
        }
    }

    /**
     * Perform periodic grid checks: fund thresholds, spread condition, grid health.
     * Called by the periodic blockchain fetch interval to check if grid needs updates.
     *
     * IMPORTANT: This method MUST only be called from within _fillProcessingLock.acquire()
     * (specifically from _setupBlockchainFetchInterval). It passes fillLockAlreadyHeld=true
     * to avoid deadlock with _consumeFillQueue which uses the same lock ordering.
     *
     * @private
     */
    async _performPeriodicGridChecks() {
        // CRITICAL: Caller (_setupBlockchainFetchInterval) already holds _fillProcessingLock
        await this._runGridMaintenance('periodic', true);
    }

    _isOpenOrdersSyncLoopEnabled() {
        return !!TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED;
    }

    /**
     * Start the open-orders watchdog sync loop.
     * Uses fill lock contention checks to avoid competing with fill processing.
     * @private
     */
    _startOpenOrdersSyncLoop() {
        if (this._mainLoopPromise) {
            return;
        }

        const hasPreferredEnvLoopDelay = Object.prototype.hasOwnProperty.call(process.env, 'OPEN_ORDERS_SYNC_LOOP_MS');
        const loopDelayRaw = hasPreferredEnvLoopDelay
            ? process.env.OPEN_ORDERS_SYNC_LOOP_MS
            : undefined;
        const hasEnvLoopDelay = loopDelayRaw !== undefined;
        const configuredLoopDelayMs = hasEnvLoopDelay
            ? Number(loopDelayRaw)
            : Number(TIMING.RUN_LOOP_DEFAULT_MS);
        const loopDelayMs = Number.isFinite(configuredLoopDelayMs) && configuredLoopDelayMs > 0
            ? configuredLoopDelayMs
            : Number(TIMING.RUN_LOOP_DEFAULT_MS);

        if (hasEnvLoopDelay && loopDelayMs !== configuredLoopDelayMs) {
            this._warn(
                `Invalid OPEN_ORDERS_SYNC_LOOP_MS='${loopDelayRaw}'. Falling back to default ${TIMING.RUN_LOOP_DEFAULT_MS}ms.`
            );
        }

        this._mainLoopActive = true;
        this._log(`Open-orders sync loop started (every ${loopDelayMs}ms, dryRun=${!!this.config.dryRun})`);

        this._mainLoopPromise = (async () => {
            while (this._mainLoopActive && !this._shuttingDown) {
                try {
                    if (this.manager && this.accountId && !this.config.dryRun) {
                        if (!this.manager._fillProcessingLock.isLocked() &&
                            this.manager._fillProcessingLock.getQueueLength() === 0) {
                            await this.manager._fillProcessingLock.acquire(async () => {
                                const chainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

                                if (syncResult?.filledOrders && syncResult.filledOrders.length > 0) {
                                    this._log(`Open-orders sync loop: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                    const rebalanceResult = await this.manager.processFilledOrders(syncResult.filledOrders, new Set());
                                    if (rebalanceResult) {
                                        await this.updateOrdersOnChainBatch(rebalanceResult);
                                        await this.manager.persistGrid();
                                    }
                                }
                            });
                        }
                    }
                } catch (err) {
                    this._warn(`Order manager loop error: ${err.message}`);
                }

                await new Promise(resolve => setTimeout(resolve, loopDelayMs));
            }
        })().finally(() => {
            this._mainLoopPromise = null;
        });
    }

    /**
     * Stop the open-orders watchdog sync loop.
     * @private
     */
    async _stopOpenOrdersSyncLoop() {
        this._mainLoopActive = false;
        if (this._mainLoopPromise) {
            await this._mainLoopPromise;
        }
    }

    /**
     * Set up periodic blockchain account balance fetch interval.
     * Fetches available funds at regular intervals to keep blockchain variables up-to-date.
     * @private
     */
    _setupBlockchainFetchInterval() {
        const { TIMING } = require('./constants');
        const intervalMin = TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN;

        if (this._blockchainFetchInterval !== null && this._blockchainFetchInterval !== undefined) {
            this._stopBlockchainFetchInterval();
        }

        // Validate the interval setting
        if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
            this._log(`Blockchain fetch interval disabled (value: ${intervalMin}). Periodic blockchain updates will not run.`);
            return;
        }

        // Validate manager and account ID
        if (!this.manager || typeof this.manager.fetchAccountTotals !== 'function') {
            this._warn('Cannot start blockchain fetch interval: manager or fetchAccountTotals method missing');
            return;
        }

        if (!this.accountId) {
            this._warn('Cannot start blockchain fetch interval: account ID not available');
            return;
        }

        // Convert minutes to milliseconds
        const intervalMs = intervalMin * 60 * 1000;

        // Set up the periodic fetch
        // Entire callback wrapped in fill lock to prevent race with fill processing
        this._blockchainFetchInterval = setInterval(async () => {
            try {
                await this.manager._fillProcessingLock.acquire(async () => {
                    // Reset recovery state each periodic cycle so accounting recovery can be re-attempted
                    // even when no fills occur (processFilledOrders also resets this, but only runs on fills).
                    // Fallback keeps compatibility with lightweight test stubs that may not attach accountant.
                    if (this.manager.accountant && typeof this.manager.accountant.resetRecoveryState === 'function') {
                        this.manager.accountant.resetRecoveryState();
                    } else {
                        this.manager._recoveryAttempted = false;
                    }
                    this._log(`Fetching blockchain account values (interval: every ${intervalMin}min)`);
                    await this.manager.fetchAccountTotals(this.accountId);

                    // Sync with current on-chain orders to detect divergence
                    let chainOpenOrders = [];
                    if (!this.config.dryRun) {
                        try {
                            chainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                            const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'periodicBlockchainFetch');

                            // Log and process fills discovered during periodic sync
                            if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                                this._log(`Periodic sync: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');

                                // Process these fills through the full strategy + batch pipeline
                                // so periodic detection behaves consistently with fill listener processing.
                                const rebalanceResult = await this.manager.processFilledOrders(syncResult.filledOrders, new Set());
                                if (rebalanceResult) {
                                    await this.updateOrdersOnChainBatch(rebalanceResult);
                                    await this.manager.persistGrid();
                                }
                            }

                            if (syncResult.unmatchedChainOrders && syncResult.unmatchedChainOrders.length > 0) {
                                this._log(`Periodic sync: ${syncResult.unmatchedChainOrders.length} chain order(s) not in grid (surplus/divergence)`, 'warn');
                            }
                        } catch (err) {
                            this._warn(`Error reading open orders during periodic fetch: ${err.message}`);
                        }
                    }

                    // Perform periodic grid checks (fund thresholds, spread, health)
                    await this._performPeriodicGridChecks();
                });
            } catch (err) {
                this._warn(`Error during periodic blockchain fetch: ${err && err.message ? err.message : err}`);
            }
        }, intervalMs);

        this._log(`Started periodic blockchain fetch interval: every ${intervalMin} minute(s)`);
    }

    /**
     * Stop the periodic blockchain fetch interval.
     * @private
     */
    _stopBlockchainFetchInterval() {
        if (this._blockchainFetchInterval !== null && this._blockchainFetchInterval !== undefined) {
            clearInterval(this._blockchainFetchInterval);
            this._blockchainFetchInterval = null;
            this._log('Stopped periodic blockchain fetch interval');
        }
    }

    /**
     * Get current metrics for monitoring and debugging.
     * @returns {Object} Metrics snapshot
     */
    getMetrics() {
        return {
            ...this._metrics,
            queueDepth: this._incomingFillQueue.length,
            fillProcessingLockActive: this.manager?._fillProcessingLock?.isLocked() || false,
            divergenceLockActive: this.manager?._divergenceLock?.isLocked() || false,
            shadowLocksActive: this.manager?.shadowOrderIds?.size || 0,
            recentFillsTracked: this._recentlyProcessedFills.size
        };
    }

    /**
     * Execute grid maintenance checks in strict order with pipeline consensus.
     *
     * CRITICAL DESIGN: All structural grid modifications are deferred until the pipeline
     * is empty to prevent "race-to-resize" conditions where the bot attempts to reallocate
     * temporary fund surpluses from filled orders before their counter-orders/rotations
     * are placed.
     *
     * MAINTENANCE SEQUENCE:
     * 1. Fund Recalculation (ALWAYS) - Updates internal fund metrics
     * 2. Pipeline Check (GATE) - Verifies no pending operations
     * 3. Spread Correction (IF IDLE) - Corrects wide spreads before divergence
     * 4. Health Check (IF IDLE) - Detects and cleans dust orders
     * 5. Divergence Detection (IF IDLE) - Identifies structural mismatches
     * 6. Grid Resizing (IF IDLE) - Applies size corrections on-chain
     *
     * WHY PIPELINE CONSENSUS MATTERS:
     * - After a fill, funds temporarily show a "surplus" from the filled order
     * - If grid maintenance runs immediately, it sees the surplus and triggers a resize
     * - The resize attempts to allocate funds that will be consumed by pending counter-orders
     * - This causes cascading trades, fund accounting errors, and grid instability
     * - Solution: Wait for pipeline to empty (all rotations placed) before resizing
     *
     * TIMEOUT SAFETY:
     * - clearStalePipelineOperations() clears stuck operations after 5-minute timeout
     * - Called before pipeline check to prevent indefinite blocking
     * - See manager.clearStalePipelineOperations() for details
     *
     * @param {string} context - Maintenance context for logging ('startup', 'periodic', 'post-fill')
     * @private
     */
    async _executeMaintenanceLogic(context) {
        this.manager.recalculateFunds();

        // Clear any operations that have been stuck beyond timeout threshold
        this.manager.clearStalePipelineOperations();

        const pipelineStatus = this.manager.isPipelineEmpty(this._incomingFillQueue.length);
        if (pipelineStatus.isEmpty) {
            // ================================================================================
            // STEP 1: SPREAD AND HEALTH CHECKS
            // ================================================================================
            // Run spread check FIRST to correct wide spreads before divergence detection.
            // This ensures divergence calculation sees corrected spread state.
            // Only performed when pipeline is empty to prevent cascading trades.

            const spreadResult = await this.manager.checkSpreadCondition(
                BitShares,
                this.updateOrdersOnChainBatch.bind(this)
            );
            if (spreadResult && spreadResult.ordersPlaced > 0) {
                this._log(`✓ Spread correction during ${context}: ${spreadResult.ordersPlaced} order(s) placed`);
                await this._persistAndRecoverIfNeeded();
            }

            const healthResult = await this.manager.checkGridHealth(
                this.updateOrdersOnChainBatch.bind(this)
            );
            if (healthResult.buyDust && healthResult.sellDust) {
                await this._persistAndRecoverIfNeeded();
            }

            // ================================================================================
            // STEP 2: THRESHOLD AND DIVERGENCE CHECKS
            // ================================================================================
            // Run divergence check AFTER spread correction to detect structural issues
            // on the corrected grid state.
            // Only performed when pipeline is empty to prevent premature resizing from temporary surplus.

            const gridCheckResult = Grid.checkAndUpdateGridIfNeeded(this.manager);

            if (gridCheckResult.buyUpdated || gridCheckResult.sellUpdated) {
                this._log(`Grid updated during ${context} due to funds (buy: ${gridCheckResult.buyUpdated}, sell: ${gridCheckResult.sellUpdated})`);
                const orderType = getOrderTypeFromUpdatedFlags(gridCheckResult.buyUpdated, gridCheckResult.sellUpdated);
                await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);
                await this._persistAndRecoverIfNeeded();

                try {
                    await applyGridDivergenceCorrections(
                        this.manager,
                        this.accountOrders,
                        this.config.botKey,
                        this.updateOrdersOnChainBatch.bind(this)
                    );
                    this._log(`Grid corrections applied on-chain during ${context}`);
                } catch (err) {
                    this._warn(`Error applying grid corrections during ${context}: ${err.message}`);
                }
            } else {
                // Detect structural mismatch between calculated and persisted grid
                try {
                    const persistedGridData = this.accountOrders.loadBotGrid(this.config.botKey, true) || [];
                    const calculatedGrid = Array.from(this.manager.orders.values());
                    const comparisonResult = await Grid.compareGrids(calculatedGrid, persistedGridData, this.manager);

                    if (comparisonResult?.buy?.updated || comparisonResult?.sell?.updated) {
                        this._log(`Grid divergence detected during ${context}: buy=${Format.formatPrice6(comparisonResult.buy.metric)}, sell=${Format.formatPrice6(comparisonResult.sell.metric)}`);
                        const orderType = getOrderTypeFromUpdatedFlags(comparisonResult.buy.updated, comparisonResult.sell.updated);
                        await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);
                        await this._persistAndRecoverIfNeeded();

                        try {
                            await applyGridDivergenceCorrections(
                                this.manager,
                                this.accountOrders,
                                this.config.botKey,
                                this.updateOrdersOnChainBatch.bind(this)
                            );
                            this._log(`Grid divergence corrections applied during ${context}`);
                        } catch (err) {
                            this._warn(`Error applying divergence corrections during ${context}: ${err.message}`);
                        }
                    }
                } catch (err) {
                    this._warn(`Error running divergence check during ${context}: ${err.message}`);
                }
            }
        }
    }

    /**
     * Perform grid maintenance: fund thresholds, spread condition, grid health, divergence.
     * Consolidates maintenance checks used during startup, periodic updates, and post-fill.
     *
     * ENTRY POINTS:
     * 1. Startup (line ~530): After grid initialization, ensures grid is healthy
     * 2. Periodic (line ~1982): Every BLOCKCHAIN_SYNC_INTERVAL_MS (default 30s)
     * 3. Post-Fill (line ~850): After order fills are rotated (NEW in commit a946c33)
     *
     * PIPELINE PROTECTION:
     * All maintenance operations inside _executeMaintenanceLogic respect isPipelineEmpty().
     * This prevents grid modifications while fills/rotations/corrections are pending.
     * See _executeMaintenanceLogic documentation for detailed rationale.
     *
     * LOCK ORDERING:
     * - Canonical order: _fillProcessingLock → _divergenceLock
     * - This function handles lock acquisition based on fillLockAlreadyHeld parameter
     * - When called from post-fill context, fill lock is already held
     * - When called from periodic context, both locks must be acquired
     * - Matches the order used in _consumeFillQueue to prevent deadlocks
     *
     * @param {string} context - Maintenance context for logging (e.g. 'startup', 'periodic', 'post-fill')
     * @param {boolean} fillLockAlreadyHeld - If true, caller already holds _fillProcessingLock
     * @private
     */
    async _runGridMaintenance(context = 'periodic', fillLockAlreadyHeld = false) {
        try {
            if (!this.manager || !this.manager.orders || this.manager.orders.size === 0) return;

            // Core maintenance logic wrapped in divergence lock
            const runWithDivergenceLock = async () => {
                await this.manager._divergenceLock.acquire(async () => {
                    await this._executeMaintenanceLogic(context);
                });
            };

            // CANONICAL LOCK ORDER: _fillProcessingLock → _divergenceLock
            // This prevents deadlocks with _consumeFillQueue which uses the same order.
            if (fillLockAlreadyHeld) {
                // Caller guarantees they hold _fillProcessingLock - just acquire inner lock
                await runWithDivergenceLock();
            } else {
                // Acquire outer lock first, then inner lock
                await this.manager._fillProcessingLock.acquire(async () => {
                    await runWithDivergenceLock();
                });
            }

        } catch (err) {
            this._warn(`Error during ${context} grid maintenance: ${err.message}`);
        }
    }

    /**
     * Gracefully shutdown the bot.
     * Waits for current fill processing to complete, persists state, and stops intervals.
     * @returns {Promise<void>}
     */
    async shutdown() {
        this._log('Initiating graceful shutdown...');
        this._shuttingDown = true;

        // Stop accepting new work
        this._stopBlockchainFetchInterval();

        if (this._triggerDebounceTimer) {
            clearTimeout(this._triggerDebounceTimer);
            this._triggerDebounceTimer = null;
        }

        if (this._triggerWatcher && typeof this._triggerWatcher.close === 'function') {
            try {
                this._triggerWatcher.close();
            } catch (err) {
                this._warn(`Failed to close trigger watcher: ${err.message}`);
            } finally {
                this._triggerWatcher = null;
            }
        }

        if (typeof this._fillsUnsubscribe === 'function') {
            try {
                await this._fillsUnsubscribe();
            } catch (err) {
                this._warn(`Failed to unsubscribe fill listener: ${err.message}`);
            } finally {
                this._fillsUnsubscribe = null;
            }
        }

        try {
            await this._stopOpenOrdersSyncLoop();
        } catch (err) {
            this._warn(`Error while stopping open-orders sync loop: ${err.message}`);
        }

        // Wait for current fill processing to complete
        try {
            if (!this.manager?._fillProcessingLock) {
                this._warn('Shutdown lock skipped: manager or fillProcessingLock unavailable');
            } else {
                await this.manager._fillProcessingLock.acquire(async () => {
                    this._log('Fill processing lock acquired for shutdown');

                    // Log any remaining queued fills
                    if (this._incomingFillQueue.length > 0) {
                        this._warn(`${this._incomingFillQueue.length} fills queued but not processed at shutdown`);
                    }

                    // Persist final state
                    if (this.manager && this.accountOrders && this.config?.botKey) {
                        try {
                            await this.manager.persistGrid();
                            this._log('Final grid snapshot persisted');
                        } catch (err) {
                            this._warn(`Failed to persist final state: ${err.message}`);
                        }
                    }
                });
            }
        } catch (err) {
            this._warn(`Error during shutdown lock acquisition: ${err.message}`);
        }

        // Log final metrics
        const metrics = this.getMetrics();
        this._log(`Shutdown complete. Final metrics: fills=${metrics.fillsProcessed}, batches=${metrics.batchesExecuted}, ` +
            `avgProcessingTime=${metrics.fillsProcessed > 0 ? Format.formatMetric2(metrics.fillProcessingTimeMs / metrics.fillsProcessed) : 0}ms, ` +
            `lockContentions=${metrics.lockContentionEvents}, maxQueueDepth=${metrics.maxQueueDepth}`);
    }
}

module.exports = DEXBot;
module.exports.normalizeBotEntry = normalizeBotEntry;
