/**
 * DEXBot - Core trading bot class
 * Shared implementation used by both bot.js (single bot) and dexbot.js (multi-bot orchestration)
 *
 * This class handles:
 * - Bot initialization and account setup
 * - Order placement and batch operations
 * - Fill processing and synchronization
 * - Grid rebalancing and rotation
 * - Divergence detection and correction
 */

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./bitshares_client');
const chainKeys = require('./chain_keys');
const chainOrders = require('./chain_orders');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./order');
const { retryPersistenceIfNeeded, buildCreateOrderArgs, getOrderTypeFromUpdatedFlags, blockchainToFloat, isSignificantSizeChange } = OrderUtils;
const { ORDER_STATES, ORDER_TYPES, TIMING, MAINTENANCE, GRID_LIMITS } = require('./constants');
const { attemptResumePersistedGridByPriceMatch, decideStartupGridAction, reconcileStartupOrders } = require('./order/startup_reconcile');
const { AccountOrders, createBotKey } = require('./account_orders');
const { parseJsonWithComments } = require('./account_bots');
const Format = require('./order/format');

const PROFILES_BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

// ════════════════════════════════════════════════════════════════════════════════
// Shared utility functions used by bot.js and dexbot.js
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Authenticate with BitShares chain keys (core logic without error handling variants)
 * @returns {Promise<string>} Master password
 * @throws {Error} If authentication fails
 */
async function authenticateWithChainKeys() {
    return await chainKeys.authenticate();
}

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
    }

    /**
     * Log a message to the console with the bot's prefix.
     * @param {string} msg - The message to log.
     * @private
     */
    _log(msg) {
        if (this.logPrefix) {
            console.log(`${this.logPrefix} ${msg}`);
        } else {
            console.log(msg);
        }
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
     * Create the fill callback for listenForFills.
     * Separated from start() to allow deferred activation after startup completes.
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @returns {Function} Async callback for processing fills
     * @private
     */
    _createFillCallback(chainOrders) {
        return async (fills) => {
            if (this.manager && !this.config.dryRun) {
                // PUSH to queue immediately (non-blocking)
                this._incomingFillQueue.push(...fills);

                // Trigger consumer (fire-and-forget: it will acquire lock if needed)
                this._consumeFillQueue(chainOrders);
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

         // Don't process fills during bootstrap phase
         if (this.manager.isBootstrapping) {
             return;
         }

         try {
             // Non-blocking check: if lock already has waiters, don't add more
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
                                this.manager.logger.log(`Skipping fill for unknown order ${fillOp.order_id} (not in grid)`, 'debug');
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
                            const resultOpenOrders = await this.manager.syncFromOpenOrders(chainOpenOrders, fillsToSync[0].op[1]);
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
                            const correctionResult = await OrderUtils.correctAllPriceMismatches(
                                this.manager, this.account, this.privateKey, chainOrders
                            );
                            if (correctionResult.failed > 0) this.manager.logger.log(`${correctionResult.failed} corrections failed`, 'error');
                        }

                    } finally {
                        this.manager.recalculateFunds();
                        this.manager.resumeFundRecalc();
                    }

                    // 5. Sequential Rebalance Loop (Interruptible)
                    if (allFilledOrders.length > 0) {
                        this.manager.logger.log(`Processing ${allFilledOrders.length} filled orders sequentially...`, 'info');

                        let anyRotations = false;

                        let i = 0;
                        while (i < allFilledOrders.length) {
                            const filledOrder = allFilledOrders[i];
                            i++;

                            this.manager.logger.log(`>>> Processing sequential fill for order ${filledOrder.id} (${i}/${allFilledOrders.length})`, 'info');

                            // Create an exclusion set from OTHER pending fills in the worklist
                            // to prevent the rebalancer from picking an order that is about to be processed.
                            // CRITICAL: Do NOT exclude the current order we are processing!
                            const fullExcludeSet = new Set();
                            for (const other of allFilledOrders) {
                                // Skip the current fill - we WANT to process it
                                if (other === filledOrder) continue;

                                if (other.orderId) fullExcludeSet.add(other.orderId);
                                if (other.id) fullExcludeSet.add(other.id);
                            }

                            // Log funding state before processing this fill
                            this.manager.logger.logFundsStatus(this.manager, `BEFORE processing fill ${filledOrder.id}`);

                            const rebalanceResult = await this.manager.processFilledOrders([filledOrder], fullExcludeSet);

                            // Log funding state after rebalance calculation (before actual placement)
                            this.manager.logger.logFundsStatus(this.manager, `AFTER rebalanceOrders calculated for ${filledOrder.id} (planned: ${rebalanceResult.ordersToPlace?.length || 0} new, ${rebalanceResult.ordersToRotate?.length || 0} rotations)`);

                            const batchResult = await this.updateOrdersOnChainBatch(rebalanceResult);

                            if (batchResult.hadRotation) {
                                anyRotations = true;
                                // Log funding state after rotation completes
                                this.manager.logger.logFundsStatus(this.manager, `AFTER rotation completed for ${filledOrder.id}`);
                            }
                            await this.manager.persistGrid();

                            // NOTE: Interrupt logic removed to prevent stale chain state race conditions.
                            // New fills accumulating in _incomingFillQueue will be processed in the next consumer cycle.
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
                                 this.manager.logger.log(`Deferring grid health check: ${pipelineStatus.reasons.join(', ')}`, 'debug');
                             }
                         }

                        // Only run divergence checks if rotation was completed
                        if (anyRotations) {
                            await this.manager._divergenceLock.acquire(async () => {
                                await OrderUtils.runGridComparisons(this.manager, this.accountOrders, this.config.botKey);
                                if (this.manager._gridSidesUpdated && this.manager._gridSidesUpdated.size > 0) {
                                    const orderType = getOrderTypeFromUpdatedFlags(
                                        this.manager._gridSidesUpdated.has(ORDER_TYPES.BUY),
                                        this.manager._gridSidesUpdated.has(ORDER_TYPES.SELL)
                                    );
                                    await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, false);
                                    await this.manager.persistGrid();
                                }
                                await OrderUtils.applyGridDivergenceCorrections(
                                    this.manager, this.accountOrders, this.config.botKey, this.updateOrdersOnChainBatch.bind(this)
                                );
                            });
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
                            this.manager?.logger?.log(`Warning: Failed to persist processed fills: ${err.message}`, 'warn');
                        }
                    }

         // Periodically clean up old fill records (deterministic: every N fills processed)
                     // Track cleanup counter locally to avoid race conditions on shared state
                     if (!this._fillCleanupCounter) this._fillCleanupCounter = 0;
                     this._fillCleanupCounter += validFills.length;
                     
                     const cleanupThreshold = MAINTENANCE.CLEANUP_PROBABILITY > 0 && MAINTENANCE.CLEANUP_PROBABILITY < 1
                         ? Math.floor(1 / MAINTENANCE.CLEANUP_PROBABILITY)
                         : 100; // Default: every 100 fills
                     
                     if (this._fillCleanupCounter >= cleanupThreshold) {
                         try {
                             await this.accountOrders.cleanOldProcessedFills(this.config.botKey, TIMING.FILL_RECORD_RETENTION_MS);
                             this._fillCleanupCounter = 0;
                         } catch (err) {
                             this.manager?.logger?.log(`Warning: Fill cleanup failed: ${err.message}`, 'warn');
                         }
                     }

                    // Update metrics
                    this._metrics.fillsProcessed += validFills.length;
                    this._metrics.fillProcessingTimeMs += Date.now() - batchStartTime;

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
         if (this._incomingFillQueue.length > 0) {
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
     * Initialize the bot by connecting to BitShares and setting up the account.
     * @param {string} [masterPassword=null] - The master password for authentication.
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails or preferredAccount is missing.
     */
    async initialize(masterPassword = null) {
        await waitForConnected(30000);
        let accountData = null;
        if (this.config && this.config.preferredAccount) {
            try {
                const pwd = masterPassword || await chainKeys.authenticate();
                const privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, pwd);
                let accId = null;
                try {
                    const full = await BitShares.db.get_full_accounts([this.config.preferredAccount], false);
                    if (full && full[0]) {
                        const maybe = full[0][0];
                        if (maybe && String(maybe).startsWith('1.2.')) accId = maybe;
                        else if (full[0][1] && full[0][1].account && full[0][1].account.id) accId = full[0][1].account.id;
                    }
                } catch (e) { /* best-effort */ }

                if (accId) chainOrders.setPreferredAccount(accId, this.config.preferredAccount);
                accountData = { accountName: this.config.preferredAccount, privateKey, id: accId };
            } catch (err) {
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                // dexbot.js has fallback to selectAccount, bot.js throws
                if (typeof chainOrders.selectAccount === 'function') {
                    accountData = await chainOrders.selectAccount();
                } else {
                    throw err;
                }
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
        this.account = accountData.accountName;
        this.accountId = accountData.id || null;
        this.privateKey = accountData.privateKey;
        this._log(`Initialized DEXBot for account: ${this.account}`);
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

        const { assetA, assetB } = this.manager.assets;
        const btsFeeData = OrderUtils.getAssetFees('BTS', 1);

        const createAndSyncOrder = async (order) => {
            this.manager.logger.log(`Placing ${order.type} order: size=${order.size}, price=${order.price}`, 'debug');
            const args = buildCreateOrderArgs(order, assetA, assetB);

            // CRITICAL: Update order size in manager if buildCreateOrderArgs quantized it
            // This ensures the order object matches what was actually placed on blockchain
            if (args.amountToSell !== order.size) {
                const gridOrder = this.manager.orders.get(order.id);
                if (gridOrder) {
                    gridOrder.size = args.amountToSell;
                    this.manager._updateOrder(gridOrder);
                    this.manager.logger.log(
                        `Order ${order.id} size quantized: ${order.size} -> ${args.amountToSell}`,
                        'debug'
                    );
                }
            }

            const result = await chainOrders.createOrder(
                this.account, this.privateKey, args.amountToSell, args.sellAssetId,
                args.minToReceive, args.receiveAssetId, null, false
            );
            const chainOrderId = result && result[0] && result[0].trx && result[0].trx.operation_results && result[0].trx.operation_results[0] && result[0].trx.operation_results[0][1];
            if (!chainOrderId) {
                throw new Error('Order creation response missing order_id');
            }
            await this.manager.synchronizeWithChain({
                gridOrderId: order.id,
                chainOrderId,
                fee: btsFeeData.createFee
            }, 'createOrder');
        };

        const placeOrderGroup = async (ordersGroup) => {
            const settled = await Promise.allSettled(ordersGroup.map(order => createAndSyncOrder(order)));
            settled.forEach((result, index) => {
                if (result.status === 'rejected') {
                    const order = ordersGroup[index];
                    const reason = result.reason;
                    const errMsg = reason && reason.message ? reason.message : `${reason}`;
                    this.manager.logger.log(`Failed to place ${order.type} order ${order.id}: ${errMsg}`, 'error');
                }
            });
        };

        const orderGroups = [];
        for (let i = 0; i < interleavedOrders.length;) {
            const current = interleavedOrders[i];
            const next = interleavedOrders[i + 1];
            if (next && current.type === 'sell' && next.type === 'buy') {
                orderGroups.push([current, next]);
                i += 2;
            } else {
                orderGroups.push([current]);
                i += 1;
            }
        }

        for (const group of orderGroups) {
            await placeOrderGroup(group);
        }
        await this.manager.persistGrid();
    }

    /**
     * Get the maximum allowed order size based on the largest grid order.
     * Max size = biggest order × 1.1 (allows 10% buffer above largest order)
     * @returns {number} Maximum allowed order size in float amount
     * @private
     */
    _getMaxOrderSize() {
        const { GRID_LIMITS } = require('./constants');
        const dustThresholdPercent = (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE || 5) / 100;
        const maxMultiplier = 1 + (2 * dustThresholdPercent); // 1 + 2*5% = 1.1

        // Get all orders and find the biggest by size
        const allOrders = Array.from(this.manager.orders.values());
        if (allOrders.length === 0) {
            return Infinity; // No orders yet, no constraint
        }

        const biggestOrder = allOrders.reduce((max, order) =>
            (order.size > max.size) ? order : max
        );

        return biggestOrder.size * maxMultiplier;
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

        const { blockchainToFloat, floatToBlockchainInt } = require('./order/utils');
        const snap = this.manager.getChainFundsSnapshot();
        const maxOrderSize = this._getMaxOrderSize();

        const availableFunds = {
            [assetA.id]: snap.chainFreeSell || 0,
            [assetB.id]: snap.chainFreeBuy || 0
        };

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

            if (sellAssetId && sellAmountInt) {
                const precision = (sellAssetId === assetA.id) ? assetA.precision : assetB.precision;
                const assetSymbol = (sellAssetId === assetA.id) ? assetA.symbol : assetB.symbol;

                // CRITICAL SAFETY CHECK: Use integer comparison for max size
                // Converts float maxOrderSize to blockchain int to avoid float issues
                if (Number.isFinite(maxOrderSize)) {
                    const maxOrderSizeInt = floatToBlockchainInt(maxOrderSize, precision);
                    // Compare raw integer from operation vs computed max integer
                    // This catches cases where input was 1000000 (int) treated as float -> 1000000 * 10^precision
                    if (Number(sellAmountInt) > maxOrderSizeInt) {
                        orderSizeViolations.push({
                            asset: assetSymbol,
                            sizeInt: sellAmountInt,
                            maxInt: maxOrderSizeInt,
                            sizeFloat: blockchainToFloat(sellAmountInt, precision)
                        });
                    }
                }

                // Accumulate required funds (using float for summation logic)
                const floatAmount = blockchainToFloat(sellAmountInt, precision);
                
                // For updates, we only deduct the DELTA (increase in commitment)
                if (op.op_name === 'limit_order_update') {
                    const deltaAssetId = op.op_data.delta_amount_to_sell?.asset_id;
                    const deltaSellInt = op.op_data.delta_amount_to_sell?.amount;
                    if (deltaAssetId === sellAssetId && deltaSellInt > 0) {
                        const floatDelta = blockchainToFloat(deltaSellInt, precision);
                        requiredFunds[sellAssetId] = (requiredFunds[sellAssetId] || 0) + floatDelta;
                    }
                } else {
                    // For creates, we deduct the full amount
                    requiredFunds[sellAssetId] = (requiredFunds[sellAssetId] || 0) + floatAmount;
                }
            }
        }

        // Check for order size violations
        if (orderSizeViolations.length > 0) {
            let summary = `[VALIDATION] CRITICAL: Order size limit FAILED (Absurd Size Check):\n`;
            for (const v of orderSizeViolations) {
                 summary += `  ${v.asset}: sizeInt=${v.sizeInt}, maxInt=${v.maxInt} (approx ${Format.formatAmount8(v.sizeFloat)})\n`;
            }
            return { isValid: false, summary: summary.trim(), violations: orderSizeViolations };
        }

        // Check for fund violations
        const fundViolations = [];
        for (const assetId in requiredFunds) {
            const required = requiredFunds[assetId];
            const available = availableFunds[assetId] || 0;

            if (required > available) {
                fundViolations.push({
                    asset: assetId === assetA.id ? assetA.symbol : assetB.symbol,
                    required, available, deficit: required - available
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

             // Create function to compute virtual state snapshot for rotation ops
             // This applies pending size updates to current open orders to prevent false "unmet" rotations
             // Virtual state is recomputed on each rotation attempt to avoid staleness
             const computeVirtualOpenOrders = async () => {
                 if (!ordersToUpdate || ordersToUpdate.length === 0) {
                     return null;
                 }
                 const currentOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                 const virtual = currentOpenOrders.map(order => {
                     const update = ordersToUpdate.find(u => u.partialOrder.orderId === order.id);
                     if (update) {
                         return { ...order, size: update.newSize };
                     }
                     return order;
                 });
                 return virtual;
             };

             // Compute virtual state snapshot for rotation ops
             // This applies pending size updates to current open orders to prevent false "unmet" rotations
             const virtualOpenOrders = await computeVirtualOpenOrders();
             if (virtualOpenOrders) {
                 this.manager.logger.log(`[ROTATION] Using virtual state with ${ordersToUpdate.length} pending size update(s)`, 'debug');
             }

             // Build rotation ops and capture any unmet rotations (orders that don't exist on-chain)
             const unmetRotations = await this._buildRotationOps(ordersToRotate, assetA, assetB, operations, opContexts, virtualOpenOrders);

            // Convert unmet rotations to placements so we still fill the grid gaps
            if (unmetRotations.length > 0) {
                this.manager.logger.log(`Converting ${unmetRotations.length} unmet rotations to new placements`, 'info');
                const fallbackPlacements = unmetRotations.map(r => ({
                    id: r.newGridId,
                    price: r.newPrice,
                    size: r.newSize,
                    type: r.type,
                    state: ORDER_STATES.ACTIVE
                }));
                await this._buildCreateOps(fallbackPlacements, assetA, assetB, operations, opContexts);
            }

            if (operations.length === 0) return { executed: false, hadRotation: false };

            // 2. Validate Funds Before Broadcasting
            const validation = this._validateOperationFunds(operations, assetA, assetB);
            this.manager.logger.log(validation.summary, validation.isValid ? 'info' : 'warn');

            if (!validation.isValid) {
                this.manager.logger.log(`Skipping batch broadcast: ${validation.violations.length} fund violation(s) detected`, 'warn');
                return { executed: false, hadRotation: false };
            }

            // 3. Execute Batch
            this.manager.logger.log(`Broadcasting batch with ${operations.length} operations...`, 'info');
            const result = await chainOrders.executeBatch(this.account, this.privateKey, operations);

            // 4. Process Results
            const batchResult = await this._processBatchResults(result, opContexts, ordersToPlace, ordersToRotate);

            this.manager.recalculateFunds();
            this.manager.logger.logFundsStatus(this.manager, `AFTER updateOrdersOnChainBatch (placed=${ordersToPlace?.length || 0}, rotated=${ordersToRotate?.length || 0})`);

            this._metrics.batchesExecuted++;
            return batchResult;

        } catch (err) {
            this.manager.logger.log(`Batch transaction failed: ${err.message}`, 'error');
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
        for (const order of ordersToPlace) {
            try {
                const args = buildCreateOrderArgs(order, assetA, assetB);
                const op = await chainOrders.buildCreateOrderOp(
                    this.account, args.amountToSell, args.sellAssetId,
                    args.minToReceive, args.receiveAssetId, null
                );
                operations.push(op);
                opContexts.push({ kind: 'create', order });
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
        
        const openOrders = await chainOrders.readOpenOrders(this.accountId);
        for (const updateInfo of ordersToUpdate) {
            try {
                const { partialOrder, newSize } = updateInfo;
                if (!partialOrder.orderId) continue;
                const chainOrder = openOrders.find(o => o.id === partialOrder.orderId);
                
                if (!chainOrder) {
                    this.manager.logger.log(`[SPLIT UPDATE] Skipping: Order ${partialOrder.orderId} missing on-chain`, 'warn');
                    continue;
                }

                const op = await chainOrders.buildUpdateOrderOp(
                    this.account, partialOrder.orderId,
                    { amountToSell: newSize, orderType: partialOrder.type }
                );

                if (op) {
                    operations.push(op);
                    opContexts.push({ kind: 'size-update', updateInfo });
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
    async _buildRotationOps(ordersToRotate, assetA, assetB, operations, opContexts, virtualOpenOrders = null) {
        if (!ordersToRotate || ordersToRotate.length === 0) return [];

        const seenOrderIds = new Set();
        // Use virtual state if provided (reflects pending size updates), otherwise read current state from chain
        const openOrders = virtualOpenOrders || await chainOrders.readOpenOrders(this.accountId);
        const unmetRotations = [];  // Track rotations that couldn't be executed

        for (const rotation of ordersToRotate) {
            const { oldOrder, newPrice, newSize, type, newGridId } = rotation;
            if (!oldOrder.orderId || seenOrderIds.has(oldOrder.orderId)) continue;
            seenOrderIds.add(oldOrder.orderId);

            const chainOrder = openOrders.find(o => o.id === oldOrder.orderId);
            if (!chainOrder) {
                this.manager.logger.log(`Rotation fallback to creation: Order ${oldOrder.orderId} missing on-chain (was filled or cancelled)`, 'warn');
                // Track this as an unmet rotation so we can create the new order as a placement instead
                unmetRotations.push({ newGridId, newPrice, newSize, type });
                continue;
            }

            try {
                const { amountToSell, minToReceive } = buildCreateOrderArgs({ type, size: newSize, price: newPrice }, assetA, assetB);
                const op = await chainOrders.buildUpdateOrderOp(
                    this.account, oldOrder.orderId,
                    { amountToSell, minToReceive, newPrice, orderType: type }
                );

                if (op) {
                    operations.push(op);
                    opContexts.push({ kind: 'rotation', rotation });
                } else {
                    this.manager.logger.log(`Skipping rotation of ${oldOrder.orderId}: no blockchain change needed`, 'debug');
                }
            } catch (err) {
                this.manager.logger.log(`Failed to prepare rotation op: ${err.message}`, 'error');
            }
        }

        return unmetRotations;
    }

    /**
     * Process results from batch transaction execution.
     * Updates order state, synchronizes with chain, and deducts BTS fees.
     * @param {Object} result - Transaction result from executeBatch
     * @param {Array} opContexts - Operation context array with operation metadata
     * @param {Array} ordersToPlace - Original placement orders (for context)
     * @param {Array} ordersToRotate - Original rotation orders (for context)
     * @returns {Object} Result with { executed: boolean, hadRotation: boolean }
     * @private
     */
    async _processBatchResults(result, opContexts, ordersToPlace, ordersToRotate) {
        const results = (result && result[0] && result[0].trx && result[0].trx.operation_results) || [];
        const { getAssetFees } = require('./order/utils');
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
                if (ord) this.manager._updateOrder({ ...ord, size: ctx.updateInfo.newSize });
                this.manager.logger.log(`Size update complete: ${ctx.updateInfo.partialOrder.orderId}`, 'info');
                updateOperationCount++;
            }
            else if (ctx.kind === 'create') {
                const chainOrderId = res && res[1];
                if (chainOrderId) {
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
                    if (ord) this.manager._updateOrder({ ...ord, size: newSize });
                    
                    if (this.manager.config.assetA === 'BTS' || this.manager.config.assetB === 'BTS') {
                        const btsSide = (this.manager.config.assetA === 'BTS') ? 'sell' : 'buy';
                        const orderType = (btsSide === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
                        this.manager._deductFromChainFree(orderType, btsFeeData.updateFee, 'resize-fee');
                    }
                    updateOperationCount++;
                    continue;
                }

                // Full rotation
                const slot = this.manager.orders.get(newGridId) || { id: newGridId, type, price: newPrice, size: 0, state: ORDER_STATES.VIRTUAL };
                const isPartialPlacement = slot.size > 0 && newSize < slot.size;

                const updatedSlot = { ...slot, id: newGridId, type, size: newSize, price: newPrice, state: ORDER_STATES.VIRTUAL, orderId: null };
                this.manager._updateOrder(updatedSlot);

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

        if (updateOperationCount > 0 && (this.manager.config.assetA === 'BTS' || this.manager.config.assetB === 'BTS')) {
            const feePerUpdate = Number(btsFeeData.updateFee) || 0;
            this.manager.funds.btsFeesOwed += feePerUpdate * updateOperationCount;
        }

        return { executed: true, hadRotation };
    }


    /**
     * Starts the bot's operation.
     * @param {string} [masterPassword=null] - The master password.
     * @returns {Promise<void>}
     */
    async start(masterPassword = null) {
        await this.initialize(masterPassword);

        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });

        // Load persisted processed fills to prevent reprocessing after restart
        // This prevents double-deduction of fees if fills are reprocessed
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
             .filter(b => b.active !== false)
             .map((b, idx) => normalizeBotEntry(b, idx));

        await this.accountOrders.ensureBotEntries(allActiveBots);

        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }

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
             await OrderUtils.initializeFeeCache([this.config || {}], BitShares);
         } catch (err) {
             this._warn(`Fee cache initialization failed: ${err.message}`);
         }

         // NOTE: Fill listener activation deferred to after startup reconciliation completes
         // This prevents fills from arriving during grid initialization/syncing

         const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey);
         
         // CRITICAL REPAIR: Strip fake orderIds where orderId === id (e.g. "slot-0")
         // These were caused by a bug in AccountOrders serialization and block rebalancing.
         if (persistedGrid && persistedGrid.length > 0) {
             let repairCount = 0;
             for (const order of persistedGrid) {
                 if (order && order.orderId && order.orderId === order.id) {
                     order.orderId = '';
                     // If it was marked ACTIVE/PARTIAL because of the fake ID, revert to VIRTUAL
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

        // CRITICAL: Set bootstrap flag to defer fill processing until startup completes
        // This prevents TOCTOU races during cacheFunds restore, fill listener activation, and grid operations
        // Fills arriving during startup are queued in _incomingFillQueue but not processed until isBootstrapping=false
        this.manager.isBootstrapping = true;
        try {
           const persistedCacheFunds = this.accountOrders.loadCacheFunds(this.config.botKey);
           const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed(this.config.botKey);
           const persistedBoundaryIdx = this.accountOrders.loadBoundaryIdx(this.config.botKey);
           const persistedDoubleSideFlags = this.accountOrders.loadDoubleSideFlags(this.config.botKey);

           // Restore and consolidate cacheFunds
           // SAFE: Done during startup before fill listener activates, so no concurrent access yet
           this.manager.resetFunds();
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
               this._log(`ℹ Grid regenerating - resetting cacheFunds and BTS fees to clean state`);
               this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
               this.manager.funds.btsFeesOwed = 0;
           }

           // CRITICAL: Activate fill listener BEFORE any grid operations or order placement
           // This ensures we capture fills that occur during startup (initial placement, syncing, corrections)
           // The divergence lock at startup grid checks prevents races with concurrent fill processing
           await chainOrders.listenForFills(this.account || undefined, this._createFillCallback(chainOrders));
           this._log('Fill listener activated (ready to process fills during startup)');

           if (shouldRegenerate) {
               await this.manager._initializeAssets();

               // If there are existing on-chain orders, reconcile them with the new grid
               if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                   this._log('Generating new grid and syncing with existing on-chain orders...');
                   await Grid.initializeGrid(this.manager);
                   const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                   const rebalanceResult = await reconcileStartupOrders({
                       manager: this.manager,
                       config: this.config,
                       account: this.account,
                       privateKey: this.privateKey,
                       chainOrders,
                       chainOpenOrders,
                       syncResult,
                   });

                   if (rebalanceResult) {
                       await this.updateOrdersOnChainBatch(rebalanceResult);
                   }
               } else {
                   // No existing orders: place initial orders on-chain
                   // placeInitialOrders() handles both Grid.initializeGrid() and broadcast
                   this._log('Generating new grid and placing initial orders on-chain...');
                   await this.placeInitialOrders();
               }
               await this.manager.persistGrid();
           } else {
               this._log('Found active session. Loading and syncing existing grid.');
               await Grid.loadGrid(this.manager, persistedGrid, persistedBoundaryIdx);
               const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

               // Process fills discovered during startup sync (happened while bot was offline)
               if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                   this._log(`Startup sync: ${syncResult.filledOrders.length} grid order(s) found filled. Processing proceeds.`, 'info');
                   // CRITICAL: Set skipAccountTotalsUpdate=true because accountTotals were just fetched from chain
                   // and already reflect these fills. Adding them again would cause fund inflation.
                   await this.manager.processFilledOrders(syncResult.filledOrders, new Set(), { skipAccountTotalsUpdate: true });
               }

               // Reconcile existing on-chain orders to the configured target counts.
               // This ensures activeOrders changes in bots.json are applied on restart:
               // - If user increased activeOrders (e.g., 10→20), new virtual orders activate
               // - If user decreased activeOrders (e.g., 20→10), excess orders are cancelled
               const rebalanceResult = await reconcileStartupOrders({
                   manager: this.manager,
                   config: this.config,
                   account: this.account,
                   privateKey: this.privateKey,
                   chainOrders,
                   chainOpenOrders,
                   syncResult,
               });

               if (rebalanceResult) {
                   await this.updateOrdersOnChainBatch(rebalanceResult);
               }

                await this.manager.persistGrid();
             }

            // Check if newly fetched blockchain funds or divergence trigger a grid update at startup
            // Note: Grid checks only run if no fills are being processed
            // Fill listener is now active, so fills could arrive during checks - use locks appropriately

           // Step 1: Threshold check (available funds)
           try {
               // Only run grid checks if no fills are being processed
                if (this.manager && this.manager.orders && this.manager.orders.size > 0) {
                    // CRITICAL: Use divergence lock to prevent race with fill processing
                    // Even though fill listener is just being set up, fills could arrive immediately
                    // We must serialize grid updates with fund modifications to prevent TOCTOU races
                    // NOTE: This consolidates grid sync logic - same lock used for both startup and periodic checks
                    await this.manager._divergenceLock.acquire(async () => {
                        const gridCheckResult = Grid.checkAndUpdateGridIfNeeded(this.manager, this.manager.funds.cacheFunds);
                    
                       // Step 1: Threshold check result
                       if (gridCheckResult.buyUpdated || gridCheckResult.sellUpdated) {
                           this._log(`Grid updated at startup due to available funds (buy: ${gridCheckResult.buyUpdated}, sell: ${gridCheckResult.sellUpdated})`);

                           // CRITICAL: First recalculate grid sizes with chain totals
                           // This updates order sizes in memory to include newly deposited funds
                           const orderType = getOrderTypeFromUpdatedFlags(gridCheckResult.buyUpdated, gridCheckResult.sellUpdated);
                           await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);

                           await this.manager.persistGrid();

                           // Apply grid corrections on-chain immediately to use new funds
                           try {
                               await OrderUtils.applyGridDivergenceCorrections(
                                   this.manager,
                                   this.accountOrders,
                                   this.config.botKey,
                                   this.updateOrdersOnChainBatch.bind(this)
                               );
                               this._log(`Grid corrections applied on-chain at startup`);
                           } catch (err) {
                               this._warn(`Error applying grid corrections at startup: ${err.message}`);
                           }
                       } else {
                            // Step 2: Divergence check (only if threshold didn't trigger)
                            // Detects structural mismatch between calculated and persisted grid
                             try {
                                 const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey, true) || [];
                                 const calculatedGrid = Array.from(this.manager.orders.values());
                                 const comparisonResult = await Grid.compareGrids(calculatedGrid, persistedGrid, this.manager, this.manager.funds.cacheFunds);
 
                                // Safety check: ensure comparisonResult has valid structure before accessing properties
                                if (comparisonResult?.buy?.updated !== undefined && comparisonResult?.sell?.updated !== undefined) {
                                    if (comparisonResult.buy.updated || comparisonResult.sell.updated) {
                                        this._log(`Grid divergence detected at startup: buy=${Format.formatPrice6(comparisonResult.buy.metric)}, sell=${Format.formatPrice6(comparisonResult.sell.metric)}`);
 
                                        // Update grid with blockchain snapshot already fresh from initialization
                                        // fromBlockchainTimer=true because blockchain was just fetched at startup (line 499)
                                        const orderType = getOrderTypeFromUpdatedFlags(comparisonResult.buy.updated, comparisonResult.sell.updated);
                                        await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);
 
                                        await this.manager.persistGrid();
 
                                        // Apply grid corrections on-chain immediately
                                        try {
                                            await OrderUtils.applyGridDivergenceCorrections(
                                                this.manager,
                                                this.accountOrders,
                                                this.config.botKey,
                                                this.updateOrdersOnChainBatch.bind(this)
                                            );
                                            this._log(`Grid divergence corrections applied on-chain at startup`);
                                        } catch (err) {
                                            this._warn(`Error applying divergence corrections at startup: ${err.message}`);
                                        }
                                    }
                                } else {
                                    this._warn(`Warning: Grid comparison returned invalid structure at startup: ${JSON.stringify(comparisonResult)}`);
                                }
                            } catch (err) {
                                this._warn(`Error running divergence check at startup: ${err.message}`);
                            }
                       }
                   });
               }
           } catch (err) {
               this._warn(`Error checking grid at startup: ${err.message}`);
           }

           // Check spread condition at startup (after grid operations complete)
           // Protected by _fillProcessingLock to respect AsyncLock pattern and prevent races with early fills
           // PROACTIVE: immediately corrects spread if needed, no waiting for next fill
           try {
                await this.manager._fillProcessingLock.acquire(async () => {
                    // CRITICAL: Recalculate funds before spread correction to ensure accurate available values
                    // During startup, funds may be in inconsistent state until recalculated
                    // SAFE: Protected by _fillProcessingLock.acquire()
                    this.manager.recalculateFunds();

                   // spreadResult: { ordersPlaced: number, didCorrect: boolean }
                   // Returned by checkSpreadCondition with count of orders placed during spread correction
                   const spreadResult = await this.manager.checkSpreadCondition(
                       BitShares,
                       this.updateOrdersOnChainBatch.bind(this)
                   );
                   if (spreadResult && spreadResult.ordersPlaced > 0) {
                       this._log(`✓ Spread correction at startup: ${spreadResult.ordersPlaced} order(s) placed`);
                       await this.manager.persistGrid();
                   }

                   // Check grid health at startup only if pipeline is empty
                   const pipelineStatus = this.manager.isPipelineEmpty(this._incomingFillQueue.length);
                   if (pipelineStatus.isEmpty) {
                       const healthResult = await this.manager.checkGridHealth(
                           this.updateOrdersOnChainBatch.bind(this)
                       );
                       if (healthResult.buyDust && healthResult.sellDust) {
                           await this.manager.persistGrid();
                       }
                   } else {
                       this._log(`Startup grid health check deferred: ${pipelineStatus.reasons.join(', ')}`, 'debug');
                   }
               });
           } catch (err) {
               this._warn(`Error checking spread condition at startup: ${err.message}`);
           }

        } finally {
            // CRITICAL: Mark bootstrap complete - allow fill processing to resume
            this.manager.isBootstrapping = false;
            this._log('Bootstrap phase complete - fill processing resumed', 'info');
        }
        /**
         * Perform a full grid resync: cancel orphan orders and regenerate grid.
         * Triggered by the presence of a `recalculate.<botKey>.trigger` file.
         * Uses AsyncLock to prevent concurrent resync/fill processing.
         */
        const performResync = async () => {
            // Use fill lock to prevent concurrent modifications during resync
            await this.manager._fillProcessingLock.acquire(async () => {
                this._log('Grid regeneration triggered. Performing full grid resync...');
                try {
                    // 1. Reload configuration from disk to pick up any changes
                    try {
                        const { parseJsonWithComments } = require('./account_bots');
                        const { createBotKey } = require('./account_orders');
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
                     // SAFE: Protected by _fillProcessingLock held by performResync caller
                     this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
                     this.manager.funds.btsFeesOwed = 0;
                     await this.manager.persistGrid();

                    if (fs.existsSync(this.triggerFile)) {
                        fs.unlinkSync(this.triggerFile);
                        this._log('Removed trigger file.');
                    }
                } catch (err) {
                    this._log(`Error during triggered resync: ${err.message}`);
                }
            });
        };

        if (fs.existsSync(this.triggerFile)) {
            await performResync();
        }

        // Debounced watcher to avoid duplicate rapid triggers on some platforms
        let _triggerDebounce = null;
        try {
            fs.watch(PROFILES_DIR, (eventType, filename) => {
                try {
                    if (filename === path.basename(this.triggerFile)) {
                        if ((eventType === 'rename' || eventType === 'change') && fs.existsSync(this.triggerFile)) {
                            if (_triggerDebounce) clearTimeout(_triggerDebounce);
                            _triggerDebounce = setTimeout(() => {
                                _triggerDebounce = null;
                                performResync();
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

        // Start periodic blockchain fetch to keep blockchain variables updated
        this._setupBlockchainFetchInterval();

         // Main loop
         const loopDelayMs = Number(process.env.RUN_LOOP_MS || 5000);
         this._log(`DEXBot started. Running loop every ${loopDelayMs}ms (dryRun=${!!this.config.dryRun})`);

         (async () => {
             while (true) {
                 try {
                     if (this.manager && !this.config.dryRun) {
                         // OPTIMIZATION: Reduce lock thrashing by checking if lock is already held
                         // Only acquire if we actually need to do work AND lock is available
                         // This prevents busy-looping that continuously acquires/releases the lock
                         if (!this.manager._fillProcessingLock.isLocked() && 
                             this.manager._fillProcessingLock.getQueueLength() === 0) {
                             await this.manager._fillProcessingLock.acquire(async () => {
                                 await this.manager.syncFromOpenOrders();
                             });
                         } else {
                             // Lock is busy with fill processing, skip this iteration
                             this.manager.logger.log('Sync deferred: fill processing in progress', 'debug');
                         }
                     }
                 } catch (err) { console.error('Order manager loop error:', err.message); }
                 await new Promise(resolve => setTimeout(resolve, loopDelayMs));
             }
         })();

        console.log('DEXBot started. OrderManager running (dryRun=' + !!this.config.dryRun + ')');
    }

     /**
      * Perform periodic grid checks: fund thresholds, spread condition, grid health.
      * Called by the periodic blockchain fetch interval to check if grid needs updates.
      * Uses _divergenceLock for synchronization (consolidated from _correctionsLock).
      * @private
      */
      async _performPeriodicGridChecks() {
          try {
              // Check if newly fetched blockchain funds trigger a grid update
              if (!this.manager || !this.manager.orders || this.manager.orders.size === 0) return;

              // SAFE: Called inside _fillProcessingLock.acquire() from periodic fetch interval
              // cacheFunds access is synchronized via lock
              const gridCheckResult = Grid.checkAndUpdateGridIfNeeded(this.manager, this.manager.funds.cacheFunds);
             if (gridCheckResult.buyUpdated || gridCheckResult.sellUpdated) {
                 this._log(`Cache ratio threshold triggered grid update (buy: ${gridCheckResult.buyUpdated}, sell: ${gridCheckResult.sellUpdated})`);

                 // Divergence lock for grid updates (nested inside fill lock)
                 // CONSOLIDATED: Uses _divergenceLock for all grid sync operations (startup + periodic)
                 await this.manager._divergenceLock.acquire(async () => {
                    // Update grid with fresh blockchain snapshot from 4-hour timer
                    const orderType = getOrderTypeFromUpdatedFlags(gridCheckResult.buyUpdated, gridCheckResult.sellUpdated);
                    await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);

                    await this.manager.persistGrid();

                    // Apply grid corrections on-chain to use new funds
                    await OrderUtils.applyGridDivergenceCorrections(
                        this.manager,
                        this.accountOrders,
                        this.config.botKey,
                        this.updateOrdersOnChainBatch.bind(this)
                    );
                    this._log(`Grid corrections applied on-chain from periodic blockchain fetch`);
                });
            }

             // Check spread condition after periodic blockchain fetch
             // Protected by outer _fillProcessingLock - respects AsyncLock pattern
             // PROACTIVE: immediately corrects spread if needed, no waiting for fills
             // CRITICAL: Recalculate funds before spread correction to ensure accurate state
             // SAFE: Called inside _fillProcessingLock.acquire(), no concurrent fund modifications
             this.manager.recalculateFunds();

            // spreadResult: { ordersPlaced: number, didCorrect: boolean }
            // Returned by checkSpreadCondition with count of orders placed during spread correction
            const spreadResult = await this.manager.checkSpreadCondition(
                BitShares,
                this.updateOrdersOnChainBatch.bind(this)
            );
            if (spreadResult && spreadResult.ordersPlaced > 0) {
                this._log(`✓ Spread correction at 4h fetch: ${spreadResult.ordersPlaced} order(s) placed`);
                await this.manager.persistGrid();
            }

            // Check grid health after periodic blockchain fetch only if pipeline is empty
            const pipelineStatus = this.manager.isPipelineEmpty(this._incomingFillQueue.length);
            if (pipelineStatus.isEmpty) {
                const healthResult = await this.manager.checkGridHealth(
                    this.updateOrdersOnChainBatch.bind(this)
                );
                if (healthResult.buyDust && healthResult.sellDust) {
                    await this.manager.persistGrid();
                }
            } else {
                this._log(`Deferring periodic grid health check: ${pipelineStatus.reasons.join(', ')}`, 'debug');
            }
        } catch (err) {
            this._warn(`Error during periodic grid checks: ${err && err.message ? err.message : err}`);
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

                                // Process these fills through the strategy to place replacement orders
                                await this.manager.processFilledOrders(syncResult.filledOrders);
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
            fillProcessingLockActive: this.manager._fillProcessingLock?.isLocked() || false,
            divergenceLockActive: this.manager._divergenceLock?.isLocked() || false,
            shadowLocksActive: this.manager?.shadowOrderIds?.size || 0,
            recentFillsTracked: this._recentlyProcessedFills.size
        };
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

        // Wait for current fill processing to complete
        try {
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
module.exports.authenticateWithChainKeys = authenticateWithChainKeys;
module.exports.normalizeBotEntry = normalizeBotEntry;
