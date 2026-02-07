/**
 * modules/order/sync_engine.js - SyncEngine
 *
 * Blockchain synchronization and reconciliation engine.
 * Exports a single SyncEngine class handling all blockchain state matching.
 *
 * Responsibilities:
 * - Match blockchain open orders to grid orders
 * - Detect and handle partial fills
 * - Process fill history events
 * - Update fund state based on blockchain
 * - Fetch and cache account balances
 * - Initialize asset metadata
 *
 * Uses AsyncLock to prevent concurrent sync operations (defense-in-depth locking).
 *
 * ===============================================================================
 * TABLE OF CONTENTS - SyncEngine Class (8 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor(manager) - Create new SyncEngine with manager reference
 *
 * BLOCKCHAIN SYNCHRONIZATION (3 methods - async)
 *   2. syncFromOpenOrders(chainOrders, options) - Main sync entry point (async)
 *      Reconciles grid against fresh blockchain snapshot
 *      Uses AsyncLock to ensure only one sync at a time (defense-in-depth)
 *      Performs two-pass reconciliation (grid→chain, then chain→grid)
 *
 *   3. _doSyncFromOpenOrders(chainOrders, options) - Execute sync with locking (async, internal)
 *      Acquires _syncLock, validates chain orders, calls _performSyncFromOpenOrders
 *
 *   4. _performSyncFromOpenOrders(mgr, precA, precB, parsedChain, rawChain, options) - Core sync logic (internal)
 *      Performs actual two-pass reconciliation without locking
 *      Pass 1: Match grid orders to chain (known grid → chain)
 *      Pass 2: Add missing chain orders (unknown chain → grid)
 *      Pass 3: Mark orphaned grid orders as VIRTUAL
 *
 * FILL PROCESSING (1 method)
 *   5. syncFromFillHistory(fill) - Process fill event synchronously
 *      Updates grid order state based on fill data
 *      Updates fund state and accounting
 *      Handles both maker and taker fills
 *
 * FULL SYNCHRONIZATION (1 method - async)
 *   6. synchronizeWithChain(chainData, source) - Full sync (fetch + sync) (async)
 *      Fetches fresh account balances
 *      Calls syncFromOpenOrders() with chain data
 *      Source: event type that triggered sync (fill, poll, broadcast, etc.)
 *
 * ACCOUNT STATE (2 methods - async)
 *   7. fetchAccountBalancesAndSetTotals(accountId) - Fetch account totals (async)
 *      Retrieves BUY/SELL totals and free balances from blockchain
 *      Sets manager.accountTotals
 *      Triggers fund recalculation
 *
 *   8. initializeAssets() - Initialize asset metadata (async)
 *      Fetches asset precision and other metadata
 *      Sets manager.assets
 *      Called once at bot startup
 *
 * ===============================================================================
 *
 * LOCK HIERARCHY:
 * 1. _syncLock (AsyncLock): Ensures only one full-sync at a time
 * 2. Per-order locks (shadowOrderIds): Protect specific orders during sync
 * 3. Lock refresh mechanism: Prevents timeout during long reconciliation
 *
 * TWO-PASS RECONCILIATION:
 * PASS 1: Grid → Chain
 * - For each grid order with orderId, find matching chain order
 * - Detect partial fills (chain size < grid size)
 * - Update sizes and mark as filled if needed
 * - Downgrade to VIRTUAL if not found on-chain
 *
 * PASS 2: Chain → Grid
 * - For each chain order not matched to grid order
 * - Create new grid order for unexpected chain order
 * - Mark as ACTIVE with blockchain orderId
 *
 * PASS 3: Cleanup
 * - Mark orphaned grid orders as VIRTUAL
 * - Update accounting for all changes
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../constants');
const {
    blockchainToFloat,
    floatToBlockchainInt,
    hasValidAccountTotals,
    calculatePriceTolerance
} = require('./utils/math');
const {
    findMatchingGridOrderByOpenOrder,
    applyChainSizeToGridOrder,
    convertToSpreadPlaceholder,
    virtualizeOrder,
    isOrderVirtual,
    hasOnChainId
} = require('./utils/order');
const { lookupAsset } = require('./utils/system');

class SyncEngine {
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Reconcile grid orders against fresh blockchain open orders snapshot.
     * This is the MAIN SYNCHRONIZATION MECHANISM that corrects the grid state when
     * the blockchain state diverges from our local expectations.
     *
     * CRITICAL: This method uses AsyncLock (defense-in-depth) to ensure only one
     * full-sync operation runs at a time. WITHIN that lock, per-order locks prevent
     * concurrent createOrder/cancelOrder races.
     *
     * LOCK HIERARCHY:
     * 1. _syncLock (AsyncLock): Ensures only one full-sync at a time
     * 2. Per-order locks (shadowOrderIds): Protect specific orders during sync
     * 3. Lock refresh mechanism: Prevents timeout during long reconciliation
     *
     * RECONCILIATION FLOW:
     * ========================================================================
     * This method performs a two-pass reconciliation:
     *
     * PASS 1: Match grid orders to chain orders (known grid → chain lookup)
     * - For each grid order with an orderId, find the matching chain order
     * - Detect partial fills: if chain size < grid size, downgrade to PARTIAL state
     * - Detect full fills: if order no longer exists on chain, convert to SPREAD
     * - Detect price slippage: flag orders for price correction if needed
     * - Update grid order sizes to match chain reality
     *
     * PASS 2: Orphan chain orders (chain → grid lookup)
     * - For chain orders not matched in Pass 1, find best grid slot match
     * - This handles cases where an order was placed but grid lost track (race condition)
     * - Uses price tolerance and geometric proximity to find the best match
     * - Once matched, retroactively assign orderId and synchronize state
     *
     * CRITICAL RULES:
     * 1. ACTIVE orders can only stay ACTIVE if size matches chain exactly
     *    If chain size < grid size → must transition to PARTIAL
     * 2. If an ACTIVE order is not found on chain → it filled → convert to SPREAD
     * 3. Precision matters: Use blockchain integer arithmetic to compare sizes
     *    Floating point comparisons can give false positives for partial fills
     * 4. Size updates are applied via applyChainSizeToGridOrder() which handles
     *    precision conversion and may adjust sizes slightly for blockchain granularity
     *
      * PRICE TOLERANCE CALCULATION:
      * calculatePriceTolerance() can return null in these cases:
      *   1. assets parameter is null/missing
      *   2. gridPrice is 0 or null (invalid price)
      *   3. orderSize is 0 or null (invalid size - orders should not sync with 0 size)
      *   4. assetA or assetB precision is undefined (asset metadata not loaded)
      * When tolerance is null, we treat it as 0 (strict: any price difference flagged).
      * This is safe because null signals a configuration/data issue, not a real order.
      *
      * RETURNS: { filledOrders, updatedOrders, ordersNeedingCorrection }
      * - filledOrders: Orders that completed (now SPREAD placeholders)
      * - updatedOrders: All orders modified during sync (state changes, size updates)
      * - ordersNeedingCorrection: Orders with price slippage requiring correction
     *
     * EDGE CASES HANDLED:
     * - Orphan chain orders (placed but grid lost track due to race condition)
     * - Partial fills (size reduced on chain)
     * - Full fills (order removed from chain completely)
     * - Price tolerance (small slippage acceptable, large slippage flagged)
     * - Precision mismatches (blockchain integer precision vs float grid)
     * - Double spending prevention (each chain order matched to at most one grid order)
     */
    /**
     * Synchronize grid orders with blockchain open orders snapshot.
     * @param {Array|null} chainOrders - Array of blockchain order objects
     * @param {Object} [options={}] - Sync options (e.g., { skipAccounting: true })
     * @returns {Promise<Object>} Result with filledOrders, updatedOrders, ordersNeedingCorrection
     */
    async syncFromOpenOrders(chainOrders, options = {}) {
        const mgr = this.manager;

        if (!mgr) {
            throw new Error('manager required for syncFromOpenOrders');
        }
        if (!mgr._syncLock) {
            mgr.logger?.log?.('Error: syncLock not initialized', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        // Defense-in-depth: Use AsyncLock to ensure only one full-sync at a time
        // Add timeout to prevent indefinite lock acquisition hangs
        const timeoutMs = TIMING.SYNC_LOCK_TIMEOUT_MS; // Deadlock prevention timeout
        const cancelToken = { isCancelled: false };

        try {
            return await Promise.race([
                mgr._syncLock.acquire(async () => {
                    // Check if cancelled immediately after acquiring lock
                    if (cancelToken.isCancelled) {
                        throw new Error('Sync operation cancelled due to lock acquisition timeout');
                    }
                    return this._doSyncFromOpenOrders(chainOrders, options);
                }, { cancelToken }),
                new Promise((_, reject) =>
                    setTimeout(() => {
                        cancelToken.isCancelled = true;
                        reject(new Error(`Sync lock timeout after ${timeoutMs}ms`));
                    }, timeoutMs)
                )
            ]);
        } catch (err) {
            mgr.logger?.log?.(`Sync lock error: ${err.message}`, 'error');
            throw err;
        }
    }

    /**
     * Internal method that performs the actual sync logic.
     * Called within _syncLock to guarantee exclusive execution.
     * @param {Array|null} chainOrders - Array of blockchain order objects
     * @param {Object} options - Sync options
     * @returns {Promise<Object>} Sync result
     * @private
     */
    async _doSyncFromOpenOrders(chainOrders, options) {
        const mgr = this.manager;

        // Validate inputs
        if (!mgr) {
            throw new Error('manager required');
        }

        if (!chainOrders || !Array.isArray(chainOrders)) {
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }
        if (!mgr.orders || !(mgr.orders instanceof Map)) {
            mgr.logger?.log?.('Error: manager.orders is not initialized as a Map', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }
        if (mgr.assets?.assetA?.precision === undefined || mgr.assets?.assetB?.precision === undefined) {
            mgr.logger?.log?.('Error: manager.assets precision missing', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        const assetAPrecision = mgr.assets.assetA.precision;
        const assetBPrecision = mgr.assets.assetB.precision;
        const assetAId = mgr.assets.assetA.id;
        const assetBId = mgr.assets.assetB.id;

        if (!assetAId || !assetBId) {
            mgr.logger?.log?.('Error: manager.assets asset IDs missing', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        // Use separate maps: parsed (floats) and raw (blockchain integers)
        // This eliminates type confusion - each map has a single, clear purpose
        const parsedChainOrders = new Map();
        const rawChainOrders = new Map();

        for (const order of chainOrders) {
            // Validate order structure before processing
            if (!order || !order.id || !order.sell_price || order.for_sale === undefined || order.for_sale === null) {
                mgr.logger?.log?.(`Warning: Skipping malformed chain order missing required fields`, 'warn');
                continue;
            }

            try {
                const sellAssetId = order.sell_price.base?.asset_id;
                const receiveAssetId = order.sell_price.quote?.asset_id;

                if (!sellAssetId || !receiveAssetId) {
                    mgr.logger?.log?.(`Warning: Chain order ${order.id} missing asset IDs`, 'warn');
                    continue;
                }

                const isSellPair = sellAssetId === assetAId && receiveAssetId === assetBId;
                const isBuyPair = sellAssetId === assetBId && receiveAssetId === assetAId;
                if (!isSellPair && !isBuyPair) {
                    mgr.logger?.log?.(`Skipping non-grid pair order ${order.id} (${sellAssetId} -> ${receiveAssetId})`, 'debug');
                    continue;
                }

                const baseAmount = Number(order.sell_price.base?.amount);
                const quoteAmount = Number(order.sell_price.quote?.amount);
                if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) {
                    mgr.logger?.log?.(`Warning: Chain order ${order.id} has invalid sell_price amounts`, 'warn');
                    continue;
                }

                const type = isSellPair ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
                const precision = (type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const size = blockchainToFloat(order.for_sale, precision);
                const price = (type === ORDER_TYPES.SELL)
                    ? (quoteAmount / baseAmount) * Math.pow(10, assetAPrecision - assetBPrecision)
                    : (baseAmount / quoteAmount) * Math.pow(10, assetAPrecision - assetBPrecision);

                // Store parsed (converted) data in parsedChainOrders
                parsedChainOrders.set(order.id, { id: order.id, type, size, price });
                // Store raw blockchain data in separate map - clean separation of concerns
                rawChainOrders.set(order.id, order);
            } catch (e) {
                mgr.logger?.log?.(`Warning: Error parsing chain order ${order.id}: ${e.message}`, 'warn');
                continue;
            }
        }

        // Collect all order IDs that might be modified during reconciliation
        // Lock them to prevent concurrent modifications from createOrder/cancelOrder
        const orderIdsToLock = new Set();
        for (const gridOrder of mgr.orders.values()) {
            // Lock any order with a chain orderId (already on-chain)
            if (gridOrder.orderId) {
                orderIdsToLock.add(gridOrder.id);
                orderIdsToLock.add(gridOrder.orderId);
            }
            // Also lock ACTIVE/PARTIAL orders that might transition to/from SPREAD
            if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                orderIdsToLock.add(gridOrder.id);
            }
        }

        const chainOrderIdsOnGrid = new Set();
        const matchedGridOrderIds = new Set();
        const filledOrders = [];
        const updatedOrders = [];
        const ordersNeedingCorrection = [];

        // Lock orders before reconciliation
        mgr.lockOrders([...orderIdsToLock]);

        // Set up lock refresh mechanism to prevent timeout during long reconciliation
        // Refreshes every LOCK_TIMEOUT_MS/2 to keep locks alive
        //
        // DESIGN NOTE: The refresh mechanism ensures that long-running reconciliations
        // don't lose their locks mid-operation. If reconciliation completes normally,
        // clearInterval() in the finally block stops the refresh. If the process crashes
        // before finally executes, the locks will eventually expire after LOCK_TIMEOUT_MS,
        // allowing orders to be unlocked and traded again in the next bot instance.
        //
        // RACE WINDOW: There is a small theoretical race between clearing the interval
        // and unlocking (if another thread reads shadowOrderIds in that window). This is
        // acceptable because: (1) it's microseconds-long, (2) worst case is a lock held
        // slightly too long (safe), not released too early (unsafe), and (3) only matters
        // on path to process crash which already breaks invariants.
        const lockRefreshInterval = setInterval(() => {
            const now = Date.now();
            for (const id of orderIdsToLock) {
                mgr.shadowOrderIds.set(id, now);
            }
            mgr.logger?.log?.(`Refreshed locks for ${orderIdsToLock.size} orders to prevent timeout expiry`, 'debug');
        }, TIMING.LOCK_TIMEOUT_MS / 2);

        try {
            mgr.pauseFundRecalc();
            // Reconciliation logic moved below in the try block
            this._performSyncFromOpenOrders(mgr, assetAPrecision, assetBPrecision, parsedChainOrders, rawChainOrders,
                chainOrderIdsOnGrid, matchedGridOrderIds, filledOrders, updatedOrders, ordersNeedingCorrection, options);
        } finally {
            mgr.resumeFundRecalc();
            // Stop refresh interval first
            clearInterval(lockRefreshInterval);
            // Unlock after reconciliation completes
            mgr.unlockOrders([...orderIdsToLock]);
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection };
    }

    /**
     * Internal helper that performs the actual reconciliation logic.
     * Called with locks held to prevent concurrent modifications.
     * 
     * Uses two separate maps:
     * - parsedChainOrders: Converted values (floats) - use for logic
     * - rawChainOrders: Raw blockchain data - keep for reference
     */
    _performSyncFromOpenOrders(mgr, assetAPrecision, assetBPrecision, parsedChainOrders, rawChainOrders,
        chainOrderIdsOnGrid, matchedGridOrderIds, filledOrders, updatedOrders, ordersNeedingCorrection, options) {

        const queueCorrection = (entry) => {
            ordersNeedingCorrection.push(entry);
            if (!Array.isArray(mgr.ordersNeedingPriceCorrection)) return;

            const existingIndex = mgr.ordersNeedingPriceCorrection.findIndex((queued) =>
                queued?.chainOrderId === entry.chainOrderId && Boolean(queued?.isSurplus) === Boolean(entry.isSurplus)
            );

            if (existingIndex >= 0) {
                mgr.ordersNeedingPriceCorrection[existingIndex] = {
                    ...mgr.ordersNeedingPriceCorrection[existingIndex],
                    ...entry
                };
            } else {
                mgr.ordersNeedingPriceCorrection.push({ ...entry });
            }
        };

        for (const gridOrder of mgr.orders.values()) {

            if (gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) {
                const chainOrder = parsedChainOrders.get(gridOrder.orderId);
                const updatedOrder = { ...gridOrder };
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                // Store raw blockchain data in grid slot for later update calculation
                updatedOrder.rawOnChain = rawChainOrders.get(gridOrder.orderId);

                // Type mismatch: grid slot was reassigned (e.g., sell→buy) but on-chain order retains original type.
                // Treat as surplus requiring cancellation — push directly to manager correction queue
                // so the divergence correction system will cancel this stale chain order.
                if (gridOrder.type !== chainOrder.type) {
                    mgr.logger?.log?.(
                        `Type mismatch for ${gridOrder.id}: grid=${gridOrder.type}, chain=${chainOrder.type}. ` +
                        `Queuing stale chain order for cancellation.`,
                        'warn'
                    );
                    queueCorrection({
                        gridOrder: { ...gridOrder },
                        chainOrderId: gridOrder.orderId,
                        expectedPrice: gridOrder.price,
                        actualPrice: chainOrder.price,
                        size: chainOrder.size,
                        type: chainOrder.type,
                        typeMismatch: true,
                        isSurplus: true,
                        sideUpdated: chainOrder.type
                    });
                    // Do NOT sync size/state for mismatched side; wait for cancellation correction.
                    continue;
                } else {
                    // Calculate price tolerance for comparison (skip type-mismatched orders — handled above)
                    // CRITICAL FIX: Skip orders where tolerance is null (e.g., size=0, which happens for SPREAD placeholders)
                    const priceTolerance = calculatePriceTolerance(gridOrder.price, gridOrder.size, gridOrder.type, mgr.assets);

                    // Skip price correction for orders with null tolerance (zero-sized slots, SPREADs, etc)
                    if (priceTolerance !== null && Math.abs(chainOrder.price - gridOrder.price) > priceTolerance) {
                        queueCorrection({
                            gridOrder: { ...gridOrder },
                            chainOrderId: gridOrder.orderId,
                            expectedPrice: gridOrder.price,
                            actualPrice: chainOrder.price,
                            size: chainOrder.size,
                            type: gridOrder.type
                        });
                    }
                }

                // Use chain order type for precision: the chain order's type is ground truth for which asset for_sale represents
                const precision = (chainOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const currentSizeInt = floatToBlockchainInt(gridOrder.size, precision);
                const chainSizeInt = floatToBlockchainInt(chainOrder.size, precision);

                if (currentSizeInt !== chainSizeInt) {
                    const newSize = blockchainToFloat(chainSizeInt, precision, true);
                    const newInt = floatToBlockchainInt(newSize, precision);

                    if (newInt > 0) {
                        applyChainSizeToGridOrder(mgr, updatedOrder, newSize, options?.skipAccounting);
                        if (updatedOrder.state === ORDER_STATES.ACTIVE) {
                            updatedOrder.state = ORDER_STATES.PARTIAL;
                        }
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                        mgr._updateOrder(spreadOrder, 'sync-pass1-filled', options?.skipAccounting || false, 0);
                        filledOrders.push(spreadOrder);
                        updatedOrders.push(spreadOrder);
                        continue;
                    }
                }
                mgr._updateOrder(updatedOrder, 'sync-pass1-partial', options?.skipAccounting || false, 0);
                updatedOrders.push(updatedOrder);
            } else if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                const currentGridOrder = mgr.orders.get(gridOrder.id);
                // CRITICAL FIX: If order has no ID OR its ID is not on chain, it's a phantom/filled order
                // The previous check only caught orders WITH IDs that were no longer on chain.
                if (!currentGridOrder?.orderId || !parsedChainOrders.has(currentGridOrder.orderId)) {
                    const spreadOrder = convertToSpreadPlaceholder(currentGridOrder);
                    mgr._updateOrder(spreadOrder, 'sync-cleanup-phantom', options?.skipAccounting || false, 0);

                    // Only trigger fill processing for GENUINE fills (had orderId but no longer on chain)
                    // Phantoms (never had orderId) should NOT trigger rotations/rebalancing
                    if (currentGridOrder?.orderId) {
                        filledOrders.push({ ...currentGridOrder });
                    }
                }
            }
        }

        for (const [chainOrderId, chainOrder] of parsedChainOrders) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue;

            let match = findMatchingGridOrderByOpenOrder(
                { orderId: chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size },
                {
                    orders: mgr.orders,
                    assets: mgr.assets,
                    calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets),
                    logger: mgr.logger,
                    allowSmallerChainSize: true
                }
            );

            // Fallback: If strict match failed, try lax matching for orphans
            // Helps recover orders that "drifted" slightly or were missed by strict tolerance
            if (!match) {
                const candidates = [];
                for (const gridOrder of mgr.orders.values()) {
                    if (!gridOrder || gridOrder.type !== chainOrder.type) continue;
                    // Candidate must be VIRTUAL and NOT have an orderId (if it has one, it should have matched in Pass 1)
                    if (gridOrder.state !== ORDER_STATES.VIRTUAL || gridOrder.orderId) continue;

                    const priceDiffPercent = Math.abs(gridOrder.price - chainOrder.price) / gridOrder.price * 100;
                    // Use a lax tolerance (e.g., 2x increment or minimum 2%)
                    const laxTolerance = Math.max((mgr.config?.incrementPercent || 0.5) * 2, 2);

                    if (priceDiffPercent <= laxTolerance) {
                        candidates.push({ gridOrder, priceDiffPercent });
                    }
                }

                if (candidates.length > 0) {
                    candidates.sort((a, b) => a.priceDiffPercent - b.priceDiffPercent);
                    match = candidates[0].gridOrder;
                    mgr.logger?.log?.(`[orphan-fallback] Matched chain order ${chainOrderId} using lax tolerance`, 'warn');
                }
            }

            // CRITICAL: Check matchedGridOrderIds BEFORE assigning to prevent double-processing
            // If another chain order already claimed this grid order, skip silently but log
            if (match && !matchedGridOrderIds.has(match.id)) {
                const bestMatch = { ...match }; // CLONE HERE
                const wasVirtual = match.state === ORDER_STATES.VIRTUAL; // Track original state
                bestMatch.orderId = chainOrderId;
                bestMatch.state = ORDER_STATES.ACTIVE;
                bestMatch.rawOnChain = rawChainOrders.get(chainOrderId);
                matchedGridOrderIds.add(bestMatch.id);

                const precision = (bestMatch.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                if (floatToBlockchainInt(bestMatch.size, precision) !== floatToBlockchainInt(chainOrder.size, precision)) {
                    applyChainSizeToGridOrder(mgr, bestMatch, chainOrder.size, options?.skipAccounting);
                    if (floatToBlockchainInt(chainOrder.size, precision) > 0) {
                        // FIX: Only mark as PARTIAL if this was already an ACTIVE/PARTIAL order
                        // that had its size reduced (genuine partial fill).
                        // Orphan matches to VIRTUAL slots are fresh matches - size differences
                        // are due to precision, not partial fills. Keep them as ACTIVE.
                        if (!wasVirtual && bestMatch.state === ORDER_STATES.ACTIVE) {
                            bestMatch.state = ORDER_STATES.PARTIAL;
                        }
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(bestMatch);
                        filledOrders.push({ ...bestMatch });
                        // bestMatch should not be updated further if it became a spread
                        mgr._updateOrder(spreadOrder, 'sync-pass2-filled', options?.skipAccounting || false, 0);
                        updatedOrders.push(spreadOrder);
                        chainOrderIdsOnGrid.add(chainOrderId);
                        continue;
                    }
                }
                mgr._updateOrder(bestMatch, 'sync-pass2-orphan', options?.skipAccounting || false, 0);
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            } else if (match) {
                // Chain order found a grid match, but another chain order already claimed it
                // This indicates potential data corruption or race condition in blockchain state
                mgr.logger?.log?.(
                    `Warning: Orphan chain order ${chainOrderId} matched grid order ${match.id}, ` +
                    `but grid order was already matched to another chain order. Skipping to prevent double-assignment.`,
                    'warn'
                );
            }
        }
    }

    /**
     * Process a single fill history operation (incremental update).
     * This is called for individual fills detected in blockchain history, as opposed to
     * the snapshot approach used by syncFromOpenOrders().
     *
     * FILL PROCESSING:
     * ========================================================================
     * When an order fills on-chain, we need to:
     * 1. Find the grid order matching this fill's orderId
     * 2. Calculate how much of the order was filled (based on asset paid)
     * 3. Update grid size: newSize = currentSize - filledAmount
      * 4. Determine if fill is complete or partial
      * 5. For doubled sides, reset flag and trigger double replacement rotations
      *
      * PRECISION HANDLING:
     * Fill amounts must be converted using the same blockchain precision as the order.
     * For SELL orders: check paysAsset == assetA (what we sold)
     * For BUY orders: check paysAsset == assetB (what we paid)
     * Use floatToBlockchainInt/blockchainToFloat to ensure consistency.
     *
      * DOUBLE-SIDE STRATEGY:
      * When a side is marked as "doubled" (e.g. after a dust merge), the next
      * full fill on that side triggers a double replacement rotation to 
      * account for the combined capital.
      *
      * COMPLETE vs PARTIAL FILL:
     * - Complete: newSize <= 0 → convert to SPREAD placeholder
     * - Partial: newSize > 0 → stay in PARTIAL state, track remaining
     *
     * RETURNS: { filledOrders, updatedOrders, partialFill }
     * - filledOrders: The filled portion (what was sold/paid)
     * - updatedOrders: The updated grid order (remaining portion)
     * - partialFill: true if fill was partial (order still on chain), false if complete
     */
    syncFromFillHistory(fill) {
        const mgr = this.manager;
        if (!fill || !fill.op || !fill.op[1]) return { filledOrders: [], updatedOrders: [], partialFill: false };

        const fillOp = fill.op[1];
        const blockNum = fill.block_num;
        const historyId = fill.id;
        const isMaker = fillOp.is_maker !== false;  // Default missing flag to maker for consistency with accounting
        const orderId = fillOp.order_id;

        // Optimistically update account totals to reflect the fill
        // This prevents fund invariant violations during the window between fill detection and next blockchain fetch
        mgr.accountant.processFillAccounting(fillOp);

        // Lock the order to prevent concurrent modifications from createOrder/cancelOrder/sync
        // This is critical to prevent TOCTOU races where fill processing updates a stale order
        const orderIdsToLock = new Set([orderId]);
        mgr.lockOrders([...orderIdsToLock]);

        try {
            mgr.pauseFundRecalc();
            try {
                const paysAmount = fillOp.pays ? Number(fillOp.pays.amount) : 0;
                const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;

                const assetAPrecision = mgr.assets?.assetA?.precision;
                const assetBPrecision = mgr.assets?.assetB?.precision;

                if (assetAPrecision === undefined || assetBPrecision === undefined) {
                    mgr.logger?.log?.('Error: manager.assets precision missing in syncFromFillHistory', 'error');
                    return { filledOrders: [], updatedOrders: [], partialFill: false };
                }

                let matchedGridOrder = null;
                for (const gridOrder of mgr.orders.values()) {
                    if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                        matchedGridOrder = gridOrder;
                        break;
                    }
                }

                if (!matchedGridOrder) return { filledOrders: [], updatedOrders: [], partialFill: false };

                const orderType = matchedGridOrder.type;
                const currentSize = Number(matchedGridOrder.size || 0);
                
                // CRITICAL: Sells are sized in AssetA, Buys are sized in AssetB
                const precision = (orderType === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                
                let filledAmount = 0;
                if (orderType === ORDER_TYPES.SELL) {
                    if (paysAssetId === mgr.assets.assetA.id) filledAmount = blockchainToFloat(paysAmount, precision, true);
                } else {
                    if (paysAssetId === mgr.assets.assetB.id) filledAmount = blockchainToFloat(paysAmount, precision, true);
                }

                const currentSizeInt = floatToBlockchainInt(currentSize, precision);
                const filledAmountInt = floatToBlockchainInt(filledAmount, precision);
                const newSizeInt = Math.max(0, currentSizeInt - filledAmountInt);
                const newSize = blockchainToFloat(newSizeInt, precision, true); // needed for partial fills

                // CRITICAL (v0.5.1 Robustness): We must detect if an order is "effectively" full.
                // An order is full if its size asset reaches 0 OR if the OTHER side reaches 0.
                // If it's closed on chain but we see a tiny remainder here, it's a Ghost Order.
                let isEffectivelyFull = (newSizeInt <= 0);

                if (!isEffectivelyFull) {
                    // Check the "other" side's precision. If the remaining amount to receive/pay 
                    // rounds to 0 on the blockchain, the order will be closed regardless of newSizeInt.
                    const otherPrecision = (orderType === ORDER_TYPES.SELL) ? assetBPrecision : assetAPrecision;
                    const price = matchedGridOrder.price;
                    const otherSize = (orderType === ORDER_TYPES.SELL) ? (currentSize - filledAmount) * price : (currentSize - filledAmount) / price;
                    
                    if (floatToBlockchainInt(otherSize, otherPrecision) <= 0) {
                        mgr.logger.log(`[SYNC] Order ${orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. Treating as full fill to trigger rotation.`, 'info');
                        isEffectivelyFull = true;
                    }
                }

                const filledOrders = [];
                const updatedOrders = [];
                if (isEffectivelyFull) {
                    const filledOrder = {
                        ...matchedGridOrder,
                        blockNum: blockNum,
                        historyId: historyId,
                        isMaker: isMaker  // Preserve maker/taker flag for accurate fee calculation
                    };

                    // NEW: Simplified Double-Side Strategy (Full Fill)
                    const side = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
                    const isDoubled = side === 'buy' ? mgr.buySideIsDoubled : mgr.sellSideIsDoubled;
                    if (isDoubled) {
                        mgr.logger.log(`[SYNC] Full fill on doubled side (${side}). Resetting flag and triggering double replacement.`, 'info');
                        if (side === 'buy') mgr.buySideIsDoubled = false;
                        else mgr.sellSideIsDoubled = false;
                        filledOrder.isDoubleReplacementTrigger = true;
                    }

                    const spreadOrder = convertToSpreadPlaceholder(matchedGridOrder);
                    mgr._updateOrder(spreadOrder, 'handle-fill-full', false, 0);
                    filledOrders.push(filledOrder);
                    return { filledOrders, updatedOrders, partialFill: false };
                } else {
                    const filledPortion = {
                        ...matchedGridOrder,
                        size: filledAmount,
                        isPartial: true,
                        blockNum: blockNum,
                        historyId: historyId,
                        isMaker: isMaker  // Preserve maker/taker flag for accurate fee calculation
                    };
                    const updatedOrder = { ...matchedGridOrder };
                    updatedOrder.state = ORDER_STATES.PARTIAL;

                    // Update cached raw order integer instead of deleting it
                    if (updatedOrder.rawOnChain && updatedOrder.rawOnChain.for_sale !== undefined) {
                        const currentForSale = Number(updatedOrder.rawOnChain.for_sale);
                        updatedOrder.rawOnChain.for_sale = String(Math.max(0, currentForSale - filledAmountInt));
                    }

                    applyChainSizeToGridOrder(mgr, updatedOrder, newSize);

                    // NEW: Simplified Double-Side Strategy (Partial Fill)
                    const side = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
                    const isDoubled = side === 'buy' ? mgr.buySideIsDoubled : mgr.sellSideIsDoubled;

                    if (isDoubled) {
                        mgr.logger.log(`[SYNC] Partial fill on doubled side (${side}). Resetting flag.`, 'info');
                        if (side === 'buy') mgr.buySideIsDoubled = false;
                        else mgr.sellSideIsDoubled = false;
                        // Note: partial fill on doubled side does NOT trigger double replacement
                    }

                    mgr._updateOrder(updatedOrder, 'handle-fill-partial', false, 0);
                    updatedOrders.push(updatedOrder);
                    filledOrders.push(filledPortion);
                    return { filledOrders, updatedOrders, partialFill: true };
                }
            } finally {
                mgr.resumeFundRecalc();
            }
        } finally {
            mgr.unlockOrders([...orderIdsToLock]);
        }
    }

    /**
     * High-level dispatcher for different blockchain synchronization sources.
     * Routes to the appropriate sync strategy based on the data source.
     *
     * SOURCES AND STRATEGIES:
     * ========================================================================
     * source: 'createOrder'
     *   Purpose: Grid order was successfully placed on-chain
     *   Data: { gridOrderId, chainOrderId, isPartialPlacement, fee }
     *   Action:
     *     1. Look up grid order by gridOrderId
     *     2. Assign the returned chainOrderId (so we can find it later)
     *     3. Transition state based on isPartialPlacement:
     *        - false → ACTIVE (full order placed)
     *        - true → PARTIAL (placed as partial, likely due to insufficient funds)
     *     4. Update optimistic chainFree balance (deduct fees if BTS pair)
     *   Fund Impact: Funds transition from free → locked/committed
     *
     * source: 'cancelOrder'
     *   Purpose: Grid order was successfully cancelled on-chain
     *   Data: The chainOrderId to cancel
     *   Action:
     *     1. Find grid order by orderId (reverse lookup)
     *     2. Transition to VIRTUAL (order no longer on-chain)
     *     3. Clear orderId so it can be re-used
     *     4. Update optimistic chainFree balance (add funds back as free)
     *   Fund Impact: Funds transition from locked → free
     *   Note: This is used for direct cancellations (not rotation/consolidation)
     *
     * source: 'readOpenOrders' or 'periodicBlockchainFetch'
     *   Purpose: Full snapshot sync of all open orders from blockchain
     *   Data: Array of chain orders from blockchain API
     *   Action: Delegates to syncFromOpenOrders() for full reconciliation
     *   Use Case: Periodic health check or startup initialization
     *
     * FUND TRACKING:
     * Both 'createOrder' and 'cancelOrder' call updateOptimisticFreeBalance() to
     * keep the optimistic chainFree balance in sync with actual on-chain state.
     * This prevents fund leaks where placed orders weren't deducted or cancelled
     * orders weren't released.
     *
     * RETURNS: { newOrders, ordersNeedingCorrection }
     * Most callers use ordersNeedingCorrection to flag price corrections needed.
     * Only syncFromOpenOrders() populates ordersNeedingCorrection.
     */
    async synchronizeWithChain(chainData, source) {
        const mgr = this.manager;
        if (!mgr.assets) return { newOrders: [], ordersNeedingCorrection: [] };

        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId, isPartialPlacement, fee } = chainData;
                // Lock order to prevent concurrent modifications during state transition
                mgr.lockOrders([gridOrderId]);
                try {
                    const gridOrder = mgr.orders.get(gridOrderId);
                    if (gridOrder) {
                        // Check if this chain order already exists on grid (rotation case)
                        // If so, fee was already paid when original order was placed - don't deduct again
                        // CRITICAL: Look for ANY order with this orderId, even if it's been transitioned to VIRTUAL
                        const existingOrder = Array.from(mgr.orders.values()).find(
                            o => o.orderId === chainOrderId && o.id !== gridOrderId
                        );
                        const isRotation = !!existingOrder;

                        // For rotation: transition the old order to VIRTUAL, freeing its capital
                        if (isRotation && existingOrder) {
                            if (!isOrderVirtual(existingOrder)) {
                                const oldVirtualOrder = { ...virtualizeOrder(existingOrder), size: 0 };
                                mgr._updateOrder(oldVirtualOrder, 'rotation-cleanup', chainData.skipAccounting || false, 0);
                            } else if (hasOnChainId(existingOrder)) {
                                // Already VIRTUAL but still has orderId (from rebalance)
                                // Just clear the orderId to reflect blockchain state
                                const clearedOrder = { ...virtualizeOrder(existingOrder), size: 0 };
                                mgr._updateOrder(clearedOrder, 'fill-cleanup', chainData.skipAccounting || false, 0);
                            }
                        }

                        const newState = isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                        const updatedOrder = { ...gridOrder, state: newState, orderId: chainOrderId };
                        // Deduced fee (createFee or updateFee) must always be applied to reflect blockchain cost
                        const actualFee = fee;
                        mgr._updateOrder(updatedOrder, 'fill-place', chainData.skipAccounting || false, actualFee);
                    }
                } finally {
                    mgr.unlockOrders([gridOrderId]);
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: mgr.orders, assets: mgr.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets), logger: mgr.logger });
                if (gridOrder) {
                    // Lock both chain orderId and grid order ID to prevent concurrent modifications
                    const orderIds = [orderId, gridOrder.id].filter(Boolean);
                    mgr.lockOrders(orderIds);
                    try {
                        // Re-fetch to ensure we have latest state after acquiring lock
                        const currentGridOrder = mgr.orders.get(gridOrder.id);
                        if (currentGridOrder && currentGridOrder.orderId === orderId) {
                            mgr._updateOrder(virtualizeOrder(currentGridOrder), 'cancel-order', false, 0);
                        }
                    } finally {
                        mgr.unlockOrders(orderIds);
                    }
                }
                break;
            }
            case 'readOpenOrders':
            case 'periodicBlockchainFetch': {
                // Must update accounting when blockchain state has changed (fills detected)
                // Using skipAccounting: true leaves phantom funds in system, causing invariant violations
                return this.syncFromOpenOrders(chainData, { skipAccounting: false });
            }
        }
        return { newOrders: [], ordersNeedingCorrection: [] };
    }

    /**
     * Fetch account balances from blockchain and update optimistic fund totals.
     * This is a critical method for financial accuracy and must be called periodically.
     *
     * BALANCE FETCHING:
     * ========================================================================
     * This method queries the blockchain for the actual account balances in both
     * assetA and assetB. It retrieves:
     *   - total: Total balance (including locked amounts)
     *   - free: Available balance (not locked in orders)
     *
     * These are stored in mgr.accountTotals as:
     *   - sell: assetA total (what we can sell)
     *   - sellFree: assetA available
     *   - buy: assetB total (what we can buy with)
     *   - buyFree: assetB available
     *
     * IMPORTANCE FOR FUND TRACKING:
     * The grid maintains an "optimistic" free balance that tracks fund deductions
     * as orders transition states. However, the blockchain is the source of truth.
     * Periodically fetching actual balances allows us to:
     *
     * 1. RECONCILE: Detect if optimistic state diverged from reality
     *    Example: If we think buyFree=1000 but blockchain says 950,
     *    something was deducted (fee, slippage, etc.) that we didn't track.
     *
     * 2. RECOVER: Identify "orphaned" funds that got stuck somewhere
     *    If actual > optimistic, we can reabsorb the extra into available pool.
     *
     * 3. PREVENT OVERSPEND: Use actual totals as the hard ceiling
     *    Even if optimistic calc says we have X funds, we never exceed actual total.
     *
     * FUND FORMULA:
     * At any time, this should hold:
     *   chainTotal = chainFree + chainCommitted
     * Where:
     *   chainTotal = actual on-chain total from blockchain
     *   chainFree = free balance (unallocated)
     *   chainCommitted = sum of all ACTIVE/PARTIAL order sizes on-chain
     *
     * ASSET INITIALIZATION:
     * First calls initializeAssets() to ensure assetA and assetB metadata is loaded.
     * Without this, we can't convert between blockchain precision and float values.
     *
     * ERROR HANDLING:
     * Gracefully handles lookup failures. If blockchain fetch fails, we don't crash
     * but instead log a warning. The system continues with last-known balances.
     */
    async fetchAccountBalancesAndSetTotals() {
        const mgr = this.manager;
        try {
            const { BitShares } = require('../bitshares_client');
            if (!BitShares || !BitShares.db) return;
            const accountIdOrName = mgr.accountId || mgr.account || null;
            if (!accountIdOrName) return;

            try { await this.initializeAssets(); } catch (err) { }
            const assetAId = mgr.assets?.assetA?.id;
            const assetBId = mgr.assets?.assetB?.id;
            if (!assetAId || !assetBId) return;

            const { getOnChainAssetBalances } = require('../chain_orders');
            const lookup = await getOnChainAssetBalances(accountIdOrName, [assetAId, assetBId]);
            const aInfo = lookup?.[assetAId] || lookup?.[mgr.config.assetA];
            const bInfo = lookup?.[assetBId] || lookup?.[mgr.config.assetB];

            if (aInfo && bInfo) {
                mgr.setAccountTotals({ sell: aInfo.total, sellFree: aInfo.free, buy: bInfo.total, buyFree: bInfo.free });
            }
        } catch (err) {
            mgr.logger.log(`Failed to fetch on-chain balances: ${err.message}`, 'warn');
        }
    }

    /**
     * Initialize asset metadata for assetA and assetB.
     * This must be called before any blockchain operations, as asset metadata
     * (ID, precision) is required for all conversions and lookups.
     *
     * WHY ASSET METADATA MATTERS:
     * ========================================================================
     * The blockchain and grid use different representations for amounts:
     *
     * Blockchain: Uses integers (atomic units based on asset precision)
     *   - BTS: precision 5 → 1 BTS = 100000 satoshis
     *   - USDT: precision 6 → 1 USDT = 1000000 satoshis
     *   Storage on-chain is always integer to prevent floating-point errors
     *
     * Grid: Uses floats for all calculations
     *   - Easier to work with for price/size calculations
     *   - Must round-trip correctly through blockchain precision
     *
     * Asset Metadata Needed:
     * 1. asset_id: Required to match orders on-chain
     *    When we see an order selling assetA for assetB, we identify it by comparing
     *    the asset_ids in the sell_price object.
     *
     * 2. precision: Required for float ↔ integer conversions
     *    floatToBlockchainInt(1.5, precision=5) = 150000
     *    blockchainToFloat(150000, precision=5) = 1.5
     *
     * Without precision, we can't:
     * - Compare order sizes (float vs blockchain int)
     * - Calculate fills (precision matters at extreme sizes)
     * - Match chain orders to grid orders (need correct ID)
     * - Convert fill amounts to grid sizes
     *
     * INITIALIZATION STRATEGY:
     * Assets are looked up asynchronously via the BitShares API.
     * The lookup is idempotent: if assets are already initialized, returns immediately.
     * This allows safe calls from multiple places without redundant lookups.
     *
     * ERROR HANDLING:
     * If asset lookup fails (asset doesn't exist, API error, etc.), the error
     * is propagated (not caught). This is intentional - a missing asset is a
     * configuration error that must be fixed before the bot can operate.
     */
    async initializeAssets() {
        const mgr = this.manager;
        if (mgr.assets) return;

        const { BitShares } = require('../bitshares_client');
        const fetchAssetWithFallback = async (symbol, side) => {
            try {
                return await lookupAsset(BitShares, symbol);
            } catch (err) {
                // If blockchain lookup fails, check for persisted fallback
                if (mgr.accountOrders) {
                    const persistedAssets = mgr.accountOrders.loadPersistedAssets(mgr.config.botKey);
                    const assetData = (side === 'A') ? persistedAssets?.assetA : persistedAssets?.assetB;

                    if (assetData && assetData.symbol === symbol && typeof assetData.precision === 'number') {
                        mgr.logger.log(`Blockchain lookup failed for ${symbol}: ${err.message}. Using persisted fallback: id=${assetData.id}, precision=${assetData.precision}`, 'warn');
                        return assetData;
                    }
                }
                throw err;
            }
        };

        try {
            mgr.assets = {
                assetA: await fetchAssetWithFallback(mgr.config.assetA, 'A'),
                assetB: await fetchAssetWithFallback(mgr.config.assetB, 'B')
            };
        } catch (err) {
            mgr.logger.log(`Asset metadata lookup failed: ${err.message}`, 'error');
            throw err;
        }
    }
}

module.exports = SyncEngine;
