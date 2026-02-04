/**
 * modules/order/startup_reconcile.js - Startup Reconciliation Module
 *
 * Grid reconciliation and recovery on bot startup.
 * Handles resuming from persisted grids and resolving blockchain discrepancies.
 *
 * Purpose:
 * - Resume previously persisted grids from storage
 * - Match persisted grids with current blockchain state
 * - Reconcile VIRTUAL orders with actual open orders
 * - Activate appropriate orders based on blockchain state
 * - Detect and handle partial order dust
 * - Trigger rebalancing when needed
 *
 * ===============================================================================
 * EXPORTS (3 functions)
 * ===============================================================================
 *
 * PUBLIC FUNCTIONS:
 *   1. reconcileStartupOrders(manager, logger) - Main reconciliation function (async)
 *      Reconciles blockchain orders with persisted grid, activates as needed
 *      Handles partial orders and triggers rebalancing if dust detected
 *      Returns null or rebalance result
 *
 *   2. attemptResumePersistedGridByPriceMatch(manager, persistedGrid) - Resume from storage (async)
 *      Matches persisted grid to current market state using price proximity
 *      Validates grid structure, locks/activates orders as appropriate
 *      Returns { success, reason, activatedIds } or { success: false, reason }
 *
 *   3. decideStartupGridAction(manager, chainOrders, persistedGrid) - Determine startup action
 *      Decides whether to resume persisted grid, create new grid, or abort
 *      Returns { action, reason } where action is 'resume', 'create_new', or 'abort'
 *
 * INTERNAL HELPERS (2 functions):
 *   4. _countActiveOnGrid(manager, type) - Count active/partial orders by type (internal)
 *   5. _pickVirtualSlotsToActivate(manager, type, count) - Pick virtual slots for activation (internal)
 *
 * ===============================================================================
 *
 * STARTUP FLOW:
 * 1. Load persisted grid from storage (if exists)
 * 2. Call decideStartupGridAction() to determine action
 * 3. If resume: attemptResumePersistedGridByPriceMatch()
 * 4. Call reconcileStartupOrders() to sync with blockchain
 * 5. Activate appropriate orders
 * 6. Check for dust partials and trigger rebalancing if needed
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../constants');
const { getMinAbsoluteOrderSize, getAssetFees, hasValidAccountTotals } = require('./utils/math');
const { isOrderPlaced, parseChainOrder, buildCreateOrderArgs, isOrderOnChain, getPartialsByType } = require('./utils/order');
const Format = require('./format');

/**
 * Count active orders on the grid for a given type.
 * @param {Object} manager - OrderManager instance.
 * @param {string} type - ORDER_TYPES value.
 * @returns {number} Count of active and partial orders with orderId.
 * @private
 */
function _countActiveOnGrid(manager, type) {
    const active = manager.getOrdersByTypeAndState(type, ORDER_STATES.ACTIVE).filter(o => o && o.orderId);
    const partial = manager.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter(o => o && o.orderId);
    return active.length + partial.length;
}

/**
 * Pick virtual slots to activate based on type and count.
 * @param {Object} manager - OrderManager instance.
 * @param {string} type - ORDER_TYPES value.
 * @param {number} count - Number of slots to pick.
 * @returns {Array<Object>} Array of picked virtual slots.
 * @private
 */
function _pickVirtualSlotsToActivate(manager, type, count) {
    if (count <= 0) return [];

    // CRITICAL FIX: Filter by type BEFORE sorting
    // Only get slots of the requested type (SELL or BUY), not a mix
    const slotsOfType = Array.from(manager.orders.values())
        .filter(slot => slot && slot.type === type)
        .sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

    let effectiveMin = 0;
    try {
        effectiveMin = getMinAbsoluteOrderSize(type, manager.assets);
    } catch (e) { effectiveMin = 0; }

    const valid = [];
    for (const slot of slotsOfType) {
        if (valid.length >= count) break;
        if (!slot.orderId && slot.state === ORDER_STATES.VIRTUAL) {
            // Role invariant: Only pick slots that make sense for this type based on current market pivot
            // (Strategy will enforce this strictly, but we filter here for cleaner activation)
            if (slot.id && (Number(slot.size) || 0) >= effectiveMin) {
                valid.push(slot);
            }
        }
    }

    return valid;
}
/**
 * Detect if grid edge is fully occupied with active orders.
 * When all outermost (furthest from market) orders are ACTIVE with orderId,
 * we're at grid edge and all balance is committed to those orders.
 *
 * @param {Object} manager - OrderManager instance
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} updateCount - Number of orders being updated
 * @returns {boolean} true if edge orders are all active
 * @private
 */
function _isGridEdgeFullyActive(manager, orderType, updateCount) {
    if (!manager || updateCount <= 0) return false;

    // Get all orders of this type
    const allOrders = Array.from(manager.orders.values()).filter(o => o.type === orderType);
    if (allOrders.length === 0) return false;

    // Sort: for BUY (highest to lowest price), for SELL (lowest to highest)
    // This puts market edge first, grid edge (furthest) last
    const sorted = orderType === ORDER_TYPES.BUY
        ? allOrders.sort((a, b) => (b.price || 0) - (a.price || 0))  // Buy: high to low price
        : allOrders.sort((a, b) => (a.price || 0) - (b.price || 0));  // Sell: low to high price

    // Get the outermost orders (last N in sorted = furthest from market)
    const outerEdgeCount = Math.min(updateCount, sorted.length);
    const edgeOrders = sorted.slice(-outerEdgeCount);

    // Check if ALL edge orders are ACTIVE (placed on blockchain)
    const allEdgeActive = edgeOrders.every(o => isOrderPlaced(o));

    return allEdgeActive;
}

/**
 * Update an existing chain order to match a grid slot.
 * @param {Object} params - Update parameters.
 * @param {Object} params.chainOrders - Chain orders module.
 * @param {string} params.account - Account name.
 * @param {string} params.privateKey - Private key.
 * @param {Object} params.manager - OrderManager instance.
 * @param {string} params.chainOrderId - ID of the chain order to update.
 * @param {Object} params.gridOrder - Grid order object.
 * @param {boolean} params.dryRun - Whether to simulate.
 * @returns {Promise<void>}
 * @private
 */
async function _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId, gridOrder, dryRun, chainOrderObj }) {
    if (dryRun) return;

    // ATOMIC RE-VERIFICATION: Ensure slot hasn't been matched or changed since reconciliation started
    const currentSlot = manager.orders.get(gridOrder.id);
    if (!currentSlot || (currentSlot.orderId && currentSlot.orderId !== chainOrderId)) {
        manager.logger?.log?.(`[_updateChainOrderToGrid] SKIP: Slot ${gridOrder.id} already updated/matched (expected ${chainOrderId}, got ${currentSlot?.orderId})`, 'warn');
        return;
    }

    // CRITICAL ACCOUNTING ALIGNMENT:
    // This order already exists on chain. To track its funds correctly:
    // 1. Add its CURRENT size to our optimistic Free balance (bring external funds into tracking)
    // 2. synchronizeWithChain will then deduct the NEW grid size from Free
    // Result: Free balance is adjusted by the delta (Released funds or extra Commitment)
    if (chainOrderObj && manager.accountant) {
        const parsed = parseChainOrder(chainOrderObj, manager.assets);
        if (parsed && parsed.size > 0) {
            manager.accountant.addToChainFree(gridOrder.type, parsed.size, 'startup-align');
        }
    }

    const { amountToSell, minToReceive } = buildCreateOrderArgs(gridOrder, manager.assets.assetA, manager.assets.assetB);

    const logger = manager && manager.logger;
    logger?.log?.(
        `[_updateChainOrderToGrid] BEFORE updateOrder: chainOrderId=${chainOrderId}, gridOrder.type=${gridOrder.type}, gridOrder.size=${gridOrder.size}, gridOrder.price=${gridOrder.price}, amountToSell=${amountToSell}, minToReceive=${minToReceive}`,
        'info'
    );

    await chainOrders.updateOrder(account, privateKey, chainOrderId, {
        newPrice: gridOrder.price,
        amountToSell,
        minToReceive,
        orderType: gridOrder.type,
    });

    const btsFeeData = getAssetFees('BTS');

    // skipAccounting: false ensures the NEW size is deducted from our (now increased) Free balance
    await manager.synchronizeWithChain({
        gridOrderId: gridOrder.id,
        chainOrderId,
        isPartialPlacement: false,
        fee: btsFeeData.updateFee,
        skipAccounting: false
    }, 'createOrder');
}

/**
 * Find the largest order among those being updated.
 * Returns both the order and its index in unmatchedOrders for pairing with gridOrders.
 * @private
 */
function _findLargestOrder(unmatchedOrders, updateCount) {
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const ordersToCheck = unmatchedOrders.slice(0, updateCount);
    let largestOrder = null;
    let largestIndex = -1;
    let largestSize = 0;

    for (let i = 0; i < ordersToCheck.length; i++) {
        const order = ordersToCheck[i];
        const size = Number(order.for_sale) || 0;
        if (size > largestSize) {
            largestSize = size;
            largestOrder = order;
            largestIndex = i;
        }
    }

    return largestIndex >= 0 ? { order: largestOrder, index: largestIndex } : null;
}

/**
 * Cancel the largest unmatched order to free up maximum funds.
 * This is more efficient than reducing to size 1 and then updating twice.
 * Returns the grid slot index and grid order that needs to be filled.
 * @private
 */
async function _cancelLargestOrder({ chainOrders, account, privateKey, manager, unmatchedOrders, updateCount, orderType, dryRun }) {
    if (dryRun) return null;
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const logger = manager && manager.logger;

    // Find the largest order among those being updated
    const largestInfo = _findLargestOrder(unmatchedOrders, updateCount);
    if (!largestInfo) return null;

    const { order: largestOrder, index: largestIndex } = largestInfo;
    const originalSize = Number(largestOrder.for_sale) || 0;
    const orderId = largestOrder.id;

    logger?.log?.(
        `Grid edge detected: cancelling largest order ${orderId} (size ${originalSize}) to free up funds`,
        'info'
    );

    try {
        // Cancel the largest order on blockchain
        await chainOrders.cancelOrder(account, privateKey, orderId);
        logger?.log?.(`Cancelled largest order ${orderId}`, 'info');

        // Mark for removal from unmatched list (handled by caller)
        // Return info needed to create this order fresh later
        return { index: largestIndex, orderType };
    } catch (err) {
        logger?.log?.(`Warning: Could not cancel largest order ${orderId}: ${err.message}`, 'warn');
        return null;
    }
}

/**
 * Create a new chain order from a grid slot.
 * @param {Object} params - Creation parameters.
 * @param {Object} params.chainOrders - Chain orders module.
 * @param {string} params.account - Account name.
 * @param {string} params.privateKey - Private key.
 * @param {Object} params.manager - OrderManager instance.
 * @param {Object} params.gridOrder - Grid order object.
 * @param {boolean} params.dryRun - Whether to simulate.
 * @returns {Promise<void>}
 * @private
 */
async function _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun }) {
    if (dryRun) return;

    // ATOMIC RE-VERIFICATION: Ensure slot is still virtual and hasn't been filled by recovery sync
    const currentSlot = manager.orders.get(gridOrder.id);
    if (currentSlot && currentSlot.orderId) {
        manager.logger?.log?.(`[_createOrderFromGrid] SKIP: Slot ${gridOrder.id} already has orderId ${currentSlot.orderId}`, 'warn');
        return;
    }

    const { amountToSell, sellAssetId, minToReceive, receiveAssetId } = buildCreateOrderArgs(
        gridOrder,
        manager.assets.assetA,
        manager.assets.assetB
    );

    const result = await chainOrders.createOrder(
        account,
        privateKey,
        amountToSell,
        sellAssetId,
        minToReceive,
        receiveAssetId,
        null,
        false
    );

    const chainOrderId =
        result &&
        result[0] &&
        result[0].trx &&
        result[0].trx.operation_results &&
        result[0].trx.operation_results[0] &&
        result[0].trx.operation_results[0][1];

    if (chainOrderId) {
        const btsFeeData = getAssetFees('BTS');

        // Centralized Fund Tracking: Use manager's sync core to handle state transition and fund deduction
        // This keeps accountBalances accurate during startup by using the same logic as synchronizeWithChain
        await manager.synchronizeWithChain({
            gridOrderId: gridOrder.id,
            chainOrderId,
            isPartialPlacement: false,
            fee: btsFeeData.createFee
        }, 'createOrder');
    } else {
        // CRITICAL FIX: Recovery sync if order extraction fails
        const logger = manager && manager.logger;
        logger?.log?.(`[_createOrderFromGrid] CRITICAL: createOrder succeeded but chainOrderId extraction failed`, 'error');
        try {
            const freshChainOrders = await chainOrders.readOpenOrders(null, 30000);
            // CRITICAL FIX: Use skipAccounting: false - order discovery must update accounting
            // Orphan order requires fund deduction to prevent phantom capital
            await manager.syncFromOpenOrders(freshChainOrders, { skipAccounting: false, source: 'chainOrderIdExtractionFailure' });
        } catch (syncErr) {
            logger?.log?.(`[_createOrderFromGrid] Recovery sync failed: ${syncErr.message}`, 'error');
        }
    }
}

/**
 * Cancel a chain order and sync with manager.
 * @param {Object} params - Cancellation parameters.
 * @param {Object} params.chainOrders - Chain orders module.
 * @param {string} params.account - Account name.
 * @param {string} params.privateKey - Private key.
 * @param {Object} params.manager - OrderManager instance.
 * @param {string} params.chainOrderId - ID of the chain order to cancel.
 * @param {boolean} params.dryRun - Whether to simulate.
 * @returns {Promise<void>}
 * @private
 */
async function _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId, dryRun }) {
    if (dryRun) return;

    await chainOrders.cancelOrder(account, privateKey, chainOrderId);
    await manager.synchronizeWithChain(chainOrderId, 'cancelOrder');
}

/**
 * Attempt to resume a persisted grid when orderIds don't match (e.g. orders.json out of sync),
 * by matching existing on-chain open orders to grid orders using price+size matching.
 *
 * Returns { resumed: boolean, matchedCount: number }.
 */
async function attemptResumePersistedGridByPriceMatch({
    manager,
    persistedGrid,
    chainOpenOrders,
    logger,
    storeGrid,
}) {
    if (!Array.isArray(persistedGrid) || persistedGrid.length === 0) return { resumed: false, matchedCount: 0 };
    if (!Array.isArray(chainOpenOrders) || chainOpenOrders.length === 0) return { resumed: false, matchedCount: 0 };
    if (!manager || typeof manager.synchronizeWithChain !== 'function') return { resumed: false, matchedCount: 0 };

    try {
        logger && logger.log && logger.log('No matching active order IDs found. Attempting to match by price...', 'info');
        const Grid = require('./grid');
        await Grid.loadGrid(manager, persistedGrid);
        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

        const matchedOrderIds = new Set(
            Array.from(manager.orders.values())
                .filter(o => o && isOrderOnChain(o))
                .map(o => o.orderId)
                .filter(Boolean)
        );

        if (matchedOrderIds.size === 0) {
            logger && logger.log && logger.log('Price-based matching found no matches. Generating new grid.', 'info');
            return { resumed: false, matchedCount: 0 };
        }

        logger && logger.log && logger.log(`Successfully matched ${matchedOrderIds.size} orders by price. Resuming with existing grid.`, 'info');
        if (typeof storeGrid === 'function') {
            storeGrid(Array.from(manager.orders.values()));
        }
        return { resumed: true, matchedCount: matchedOrderIds.size };
    } catch (err) {
        logger && logger.log && logger.log(`Price-based resume attempt failed: ${err && err.message ? err.message : err}`, 'warn');
        return { resumed: false, matchedCount: 0 };
    }
}

/**
 * Decide whether a startup should regenerate the grid or resume a persisted grid.
 *
 * Resulting behavior matches the existing startup policy:
 * - If no persisted grid -> regenerate
 * - If any persisted ACTIVE orderId exists on-chain -> resume
 * - Else if there are on-chain orders -> attempt price-based matching; resume if it matches any
 * - Else -> regenerate
 */
async function decideStartupGridAction({
    persistedGrid,
    chainOpenOrders,
    manager,
    logger,
    storeGrid,
    attemptResumeFn = attemptResumePersistedGridByPriceMatch,
}) {
    const persisted = Array.isArray(persistedGrid) ? persistedGrid : [];
    const chain = Array.isArray(chainOpenOrders) ? chainOpenOrders : [];

    if (persisted.length === 0) {
        return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
    }

    const chainOrderIds = new Set(chain.map(o => o && o.id).filter(Boolean));
    const hasActiveMatch = persisted.some(order => order && order.state === ORDER_STATES.ACTIVE && order.orderId && chainOrderIds.has(order.orderId));
    if (hasActiveMatch) {
        return { shouldRegenerate: false, hasActiveMatch: true, resumedByPrice: false, matchedCount: 0 };
    }

    if (chain.length > 0) {
        const resume = await attemptResumeFn({ manager, persistedGrid: persisted, chainOpenOrders: chain, logger, storeGrid });
        return { shouldRegenerate: !resume.resumed, hasActiveMatch: false, resumedByPrice: !!resume.resumed, matchedCount: resume.matchedCount || 0 };
    }

    return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
}

/**
 * Reconcile existing on-chain orders to a newly generated grid.
 *
 * Policy (per side):
 * - Prefer updating existing unmatched chain orders to match the target grid slots.
 * - Then create missing orders if chain has fewer than target.
 * - Then cancel excess orders if chain has more than target.
 *
 * Targets are derived from config.activeOrders.{buy,sell} and chain counts are computed
 * from current on-chain open orders.
 */
async function reconcileStartupOrders({
    manager,
    config,
    account,
    privateKey,
    chainOrders,
    chainOpenOrders,
}) {
    // Parameter validation
    if (!manager || typeof manager.synchronizeWithChain !== 'function') {
        throw new Error('reconcileStartupOrders: manager must be provided with synchronizeWithChain method');
    }
    if (typeof manager.getOrdersByTypeAndState !== 'function') {
        throw new Error('reconcileStartupOrders: manager.getOrdersByTypeAndState method not found');
    }
    if (!account || !privateKey) {
        throw new Error('reconcileStartupOrders: account and privateKey are required');
    }
    if (!chainOrders || typeof chainOrders.updateOrder !== 'function' || typeof chainOrders.cancelOrder !== 'function' || typeof chainOrders.createOrder !== 'function') {
        throw new Error('reconcileStartupOrders: chainOrders must provide updateOrder, cancelOrder, and createOrder methods');
    }

    const logger = manager && manager.logger;
    const dryRun = !!(config && config.dryRun);

    const parsedChain = (chainOpenOrders || [])
        .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    const activeCfg = (config && config.activeOrders) ? config.activeOrders : {};
    let targetBuy = Math.max(0, Number.isFinite(Number(activeCfg.buy)) ? Number(activeCfg.buy) : 1);
    let targetSell = Math.max(0, Number.isFinite(Number(activeCfg.sell)) ? Number(activeCfg.sell) : 1);

    if (manager.buySideIsDoubled) targetBuy = Math.max(1, targetBuy - 1);
    if (manager.sellSideIsDoubled) targetSell = Math.max(1, targetSell - 1);

    const chainBuys = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    const chainSells = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    // CRITICAL FIX: Sanitize phantom orders - grid orders that claim to be active with an ID,
    // but that ID is missing from the chain. Downgrade to VIRTUAL so they don't block
    // new orders or cause balance invariants.
    const chainIds = new Set(chainOpenOrders.map(o => o.id));
    for (const order of manager.orders.values()) {
        if (isOrderPlaced(order)) {
            if (!chainIds.has(order.orderId)) {
                logger?.log?.(`Startup: Found phantom order ${order.id} (ID ${order.orderId}) not on chain. Resetting to VIRTUAL.`, 'warn');

                // CRITICAL: Clean up rawOnChain cache for phantoms - it is now invalid
                if (order.rawOnChain) {
                    logger?.log?.(`Startup: Clearing invalid rawOnChain cache for phantom ${order.id}`, 'debug');
                }

                // Use manager._updateOrder to maintain indices
                // CRITICAL FIX: Use skipAccounting: false so fund accounting is properly updated
                // When converting from ACTIVE/PARTIAL to VIRTUAL, funds must be recalculated
                // skipAccounting: true was causing fund invariants to remain violated
                manager._updateOrder({
                    ...order,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: "",
                    rawOnChain: null
                }, 'startup-phantom', false, 0);
            }
        }
    }

    // CRITICAL FIX: Compute unmatched orders by finding which chain orders do NOT match the grid
    // The sync result doesn't tell us which orders didn't match - we need to compute this ourselves.
    // An order is unmatched if:
    // 1. It exists on-chain (in chainOpenOrders)
    // 2. It was NOT matched to a grid order (no matching orderId in grid)
    const matchedChainOrderIds = new Set();
    for (const gridOrder of manager.orders.values()) {
        if (gridOrder && gridOrder.orderId) {
            matchedChainOrderIds.add(gridOrder.orderId);
        }
    }

    const unmatchedChain = chainOpenOrders.filter(co => !matchedChainOrderIds.has(co.id));
    const unmatchedParsed = unmatchedChain
        .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    let unmatchedBuys = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    let unmatchedSells = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    logger && logger.log && logger.log(
        `Startup reconcile starting: unmatched(sell=${unmatchedSells.length}, buy=${unmatchedBuys.length}), target(sell=${targetSell}, buy=${targetBuy})`,
        'info'
    );

    // ---- SELL SIDE ----
    const matchedSell = _countActiveOnGrid(manager, ORDER_TYPES.SELL);
    const needSellSlots = Math.max(0, targetSell - matchedSell);
    const desiredSellSlots = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.SELL, needSellSlots);

    // Sort unmatched SELL orders by price (low to high) to pair with desiredSellSlots
    // which are already sorted by price (closest to market first)
    const sortedUnmatchedSells = unmatchedSells
        .slice(0)  // Create copy to avoid mutating original
        .sort((a, b) => {
            const priceA = parseChainOrder(a, manager.assets)?.price || 0;
            const priceB = parseChainOrder(b, manager.assets)?.price || 0;
            return priceA - priceB;  // Low to high (market to edge)
        });

    const sellUpdates = Math.min(sortedUnmatchedSells.length, desiredSellSlots.length);
    let cancelledSellIndex = null;

    logger && logger.log && logger.log(
        `Startup SELL: matchedOnGrid=${matchedSell}, needSlots=${needSellSlots}, unmatched=${sortedUnmatchedSells.length}, updates=${sellUpdates}`,
        'info'
    );

    // PHASE 1: Cancel largest order if grid edge is fully active (frees maximum funds)
    if (sellUpdates > 0 && _isGridEdgeFullyActive(manager, ORDER_TYPES.SELL, sellUpdates)) {
        logger && logger.log && logger.log(`Startup: SELL grid edge is fully active, cancelling largest order to free funds`, 'info');
        const cancelInfo = await _cancelLargestOrder({
            chainOrders, account, privateKey, manager,
            unmatchedOrders: sortedUnmatchedSells,
            updateCount: sellUpdates,
            orderType: ORDER_TYPES.SELL,
            dryRun
        });
        if (cancelInfo) {
            cancelledSellIndex = cancelInfo.index;
            // Don't splice - keep index alignment with desiredSellSlots
        }
    }

    // PHASE 2: Update remaining unmatched orders to their target sizes
    for (let i = 0; i < sellUpdates; i++) {
        // Skip the cancelled order's slot - will be handled in Phase 3
        if (cancelledSellIndex !== null && i === cancelledSellIndex) {
            continue;
        }
        const chainOrder = sortedUnmatchedSells[i];
        const gridOrder = desiredSellSlots[i];

        // Check if update is feasible: SELL orders need to sell assetA
        // If account doesn't have enough free assetA, skip this update (keep old order as-is)
        const gridSize = Number(gridOrder.size) || 0;
        const parsedChain = parseChainOrder(chainOrder, manager.assets);
        const currentSize = parsedChain ? parsedChain.size : 0;
        const sizeIncrease = Math.max(0, gridSize - currentSize);
        const currentSellAssetBalance = (manager.accountTotals?.sellFree) || 0;

        if (sizeIncrease > currentSellAssetBalance) {
            logger && logger.log && logger.log(
                `Startup: Skipping SELL update ${chainOrder.id} - insufficient balance for increase (need +${Format.formatAmount8(sizeIncrease)} ${manager.assets.assetA.symbol}, have ${Format.formatAmount8(currentSellAssetBalance)} ${manager.assets.assetA.symbol})`,
                'warn'
            );
            continue;
        }

        try {
            await _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId: chainOrder.id, gridOrder, dryRun, chainOrderObj: chainOrder });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to update SELL ${chainOrder.id}: ${err.message}`, 'error');
            // CRITICAL: On update failure, resync from blockchain to catch order-not-found or other state mismatches
            // This prevents grid/chain desync where grid expects update succeeded but chain order still exists/differs
            try {
                logger && logger.log && logger.log(`Startup: Triggering recovery sync after SELL update failure`, 'warn');
                const freshChainOrders = await chainOrders.readOpenOrders(null, 30000);
                // CRITICAL FIX: Use skipAccounting: false - update failure recovery must update accounting
                // Pre-adjustment happened but post-deduction didn't; sync must correct fund tracking
                await manager.syncFromOpenOrders(freshChainOrders, { skipAccounting: false, source: 'startupReconcileFailure' });
            } catch (syncErr) {
                logger && logger.log && logger.log(`Startup: Recovery sync failed: ${syncErr.message}`, 'error');
            }
        }
    }

    // PHASE 3: Create new order for the grid slot that had the cancelled order
    if (cancelledSellIndex !== null && !dryRun) {
        const targetGridOrder = desiredSellSlots[cancelledSellIndex];
        if (targetGridOrder) {
            logger && logger.log && logger.log(
                `Startup: Creating new SELL for cancelled slot at grid ${targetGridOrder.id} (price=${Format.formatPrice6(targetGridOrder.price)}, size=${Format.formatAmount8(targetGridOrder.size)})`,
                'info'
            );
            try {
                await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder: targetGridOrder, dryRun });
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to create SELL for cancelled slot: ${err.message}`, 'error');
                // CRITICAL FIX: Recovery sync
                try {
                    logger && logger.log && logger.log(`Startup: Triggering recovery sync after SELL creation failure`, 'warn');
                    const freshChainOrders = await chainOrders.readOpenOrders(null, 30000);
                    // CRITICAL FIX: Use skipAccounting: false - order discovery must update accounting
                    // Orphan order requires fund deduction to prevent phantom capital (same pattern as line 279)
                    await manager.syncFromOpenOrders(freshChainOrders, { skipAccounting: false, source: 'phase3CreationFailure' });
                } catch (syncErr) {
                    logger && logger.log && logger.log(`Startup: Recovery sync failed: ${syncErr.message}`, 'error');
                }
            }
        }
    }

    // Remove processed orders from the unmatched list
    // NOTE: cancelledSellIndex is already within the sellUpdates range, don't add 1
    const sellProcessedCount = sellUpdates;
    unmatchedSells = sortedUnmatchedSells.slice(sellProcessedCount);

    const chainSellCount = chainSells.length;
    const sellCreateCount = Math.max(0, targetSell - chainSellCount);
    const remainingSellSlots = desiredSellSlots.slice(sellUpdates);
    for (let i = 0; i < Math.min(sellCreateCount, remainingSellSlots.length); i++) {
        const gridOrder = remainingSellSlots[i];
        logger && logger.log && logger.log(
            `Startup: Creating SELL for grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatAmount8(gridOrder.size)})`,
            'info'
        );
        try {
            await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to create SELL: ${err.message}`, 'error');
        }
    }

    let sellCancelCount = Math.max(0, chainSellCount - targetSell);
    if (sellCancelCount > 0) {
        const parsedUnmatchedSells = unmatchedSells
            .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort((a, b) => (b.parsed.price || 0) - (a.parsed.price || 0));  // Sort HIGH to LOW: cancel worst (edge) orders first

        for (const x of parsedUnmatchedSells) {
            if (sellCancelCount <= 0) break;
            logger && logger.log && logger.log(`Startup: Cancelling excess SELL chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: x.chain.id, dryRun });
                logger && logger.log && logger.log(`Startup: Successfully cancelled excess SELL order ${x.chain.id}`, 'info');
                sellCancelCount--;
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to cancel SELL ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (sellCancelCount > 0) {
            const activeSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort((a, b) => (b.price || 0) - (a.price || 0));  // Sort HIGH to LOW: cancel worst (edge) orders first

            for (const o of activeSells) {
                if (sellCancelCount <= 0) break;
                logger && logger.log && logger.log(`Startup: Cancelling excess matched SELL ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun });
                    logger && logger.log && logger.log(`Startup: Successfully cancelled excess matched SELL order ${o.orderId} (grid ${o.id})`, 'info');
                    sellCancelCount--;
                } catch (err) {
                    logger && logger.log && logger.log(`Startup: Failed to cancel matched SELL ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    // ---- BUY SIDE ----
    const matchedBuy = _countActiveOnGrid(manager, ORDER_TYPES.BUY);
    const needBuySlots = Math.max(0, targetBuy - matchedBuy);
    const desiredBuySlots = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.BUY, needBuySlots);

    // Sort unmatched BUY orders by price (high to low) to pair with desiredBuySlots
    // which are already sorted by price (closest to market first = highest to lowest)
    const sortedUnmatchedBuys = unmatchedBuys
        .slice(0)  // Create copy to avoid mutating original
        .sort((a, b) => {
            const priceA = parseChainOrder(a, manager.assets)?.price || 0;
            const priceB = parseChainOrder(b, manager.assets)?.price || 0;
            return priceB - priceA;  // High to low (market to edge)
        });

    const buyUpdates = Math.min(sortedUnmatchedBuys.length, desiredBuySlots.length);
    let cancelledBuyIndex = null;

    logger && logger.log && logger.log(
        `Startup BUY: matchedOnGrid=${matchedBuy}, needSlots=${needBuySlots}, unmatched=${sortedUnmatchedBuys.length}, updates=${buyUpdates}`,
        'info'
    );

    // PHASE 1: Cancel largest order if grid edge is fully active (frees maximum funds)
    if (buyUpdates > 0 && _isGridEdgeFullyActive(manager, ORDER_TYPES.BUY, buyUpdates)) {
        logger && logger.log && logger.log(`Startup: BUY grid edge is fully active, cancelling largest order to free funds`, 'info');
        const cancelInfo = await _cancelLargestOrder({
            chainOrders, account, privateKey, manager,
            unmatchedOrders: sortedUnmatchedBuys,
            updateCount: buyUpdates,
            orderType: ORDER_TYPES.BUY,
            dryRun
        });
        if (cancelInfo) {
            cancelledBuyIndex = cancelInfo.index;
            // Don't splice - keep index alignment with desiredBuySlots
        }
    }

    // PHASE 2: Update remaining unmatched orders to their target sizes
    for (let i = 0; i < buyUpdates; i++) {
        // Skip the cancelled order's slot - will be handled in Phase 3
        if (cancelledBuyIndex !== null && i === cancelledBuyIndex) {
            continue;
        }
        const chainOrder = sortedUnmatchedBuys[i];
        const gridOrder = desiredBuySlots[i];

        // Check if update is feasible: BUY orders need to sell assetB
        // If account doesn't have enough free assetB, skip this update (keep old order as-is)
        // NOTE: gridOrder.size for BUY orders is already in assetB units
        const gridSize = Number(gridOrder.size) || 0;
        const parsedChain = parseChainOrder(chainOrder, manager.assets);
        const currentSize = parsedChain ? parsedChain.size : 0;
        const sizeIncrease = Math.max(0, gridSize - currentSize);
        const currentBuyAssetBalance = (manager.accountTotals?.buyFree) || 0;

        if (sizeIncrease > currentBuyAssetBalance) {
            logger && logger.log && logger.log(
                `Startup: Skipping BUY update ${chainOrder.id} - insufficient balance for increase (need +${Format.formatAmount8(sizeIncrease)} ${manager.assets.assetB.symbol}, have ${Format.formatAmount8(currentBuyAssetBalance)} ${manager.assets.assetB.symbol})`,
                'warn'
            );
            continue;
        }

        logger && logger.log && logger.log(
            `Startup: Updating chain BUY ${chainOrder.id} -> grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatAmount8(gridOrder.size)})`,
            'info'
        );
        try {
            await _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId: chainOrder.id, gridOrder, dryRun, chainOrderObj: chainOrder });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to update BUY ${chainOrder.id}: ${err.message}`, 'error');
            // CRITICAL: On update failure, resync from blockchain to catch order-not-found or other state mismatches
            // This prevents grid/chain desync where grid expects update succeeded but chain order still exists/differs
            try {
                logger && logger.log && logger.log(`Startup: Triggering recovery sync after BUY update failure`, 'warn');
                const freshChainOrders = await chainOrders.readOpenOrders(null, 30000);
                // CRITICAL FIX: Use skipAccounting: false - update failure recovery must update accounting
                // Pre-adjustment happened but post-deduction didn't; sync must correct fund tracking
                await manager.syncFromOpenOrders(freshChainOrders, { skipAccounting: false, source: 'startupReconcileFailure' });
            } catch (syncErr) {
                logger && logger.log && logger.log(`Startup: Recovery sync failed: ${syncErr.message}`, 'error');
            }
        }
    }

    // PHASE 3: Create new order for the grid slot that had the cancelled order
    if (cancelledBuyIndex !== null && !dryRun) {
        const targetGridOrder = desiredBuySlots[cancelledBuyIndex];
        if (targetGridOrder) {
            logger && logger.log && logger.log(
                `Startup: Creating new BUY for cancelled slot at grid ${targetGridOrder.id} (price=${Format.formatPrice6(targetGridOrder.price)}, size=${Format.formatAmount8(targetGridOrder.size)})`,
                'info'
            );
            try {
                await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder: targetGridOrder, dryRun });
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to create BUY for cancelled slot: ${err.message}`, 'error');
                // CRITICAL FIX: Recovery sync
                try {
                    logger && logger.log && logger.log(`Startup: Triggering recovery sync after BUY creation failure`, 'warn');
                    const freshChainOrders = await chainOrders.readOpenOrders(null, 30000);
                    // CRITICAL FIX: Use skipAccounting: false - order discovery must update accounting
                    // Orphan order requires fund deduction to prevent phantom capital (same pattern as line 588)
                    await manager.syncFromOpenOrders(freshChainOrders, { skipAccounting: false, source: 'phase3CreationFailure' });
                } catch (syncErr) {
                    logger && logger.log && logger.log(`Startup: Recovery sync failed: ${syncErr.message}`, 'error');
                }
            }
        }
    }

    // Remove processed orders from the unmatched list
    // NOTE: cancelledBuyIndex is already within the buyUpdates range, don't add 1
    const buyProcessedCount = buyUpdates;
    unmatchedBuys = sortedUnmatchedBuys.slice(buyProcessedCount);

    const chainBuyCount = chainBuys.length;
    const buyCreateCount = Math.max(0, targetBuy - chainBuyCount);
    const remainingBuySlots = desiredBuySlots.slice(buyUpdates);
    for (let i = 0; i < Math.min(buyCreateCount, remainingBuySlots.length); i++) {
        const gridOrder = remainingBuySlots[i];
        logger && logger.log && logger.log(
            `Startup: Creating BUY for grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatAmount8(gridOrder.size)})`,
            'info'
        );
        try {
            await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to create BUY: ${err.message}`, 'error');
        }
    }

    let buyCancelCount = Math.max(0, chainBuyCount - targetBuy);
    if (buyCancelCount > 0) {
        const parsedUnmatchedBuys = unmatchedBuys
            .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort((a, b) => (a.parsed.price || 0) - (b.parsed.price || 0));  // Sort LOW to HIGH: cancel worst (edge) orders first

        for (const x of parsedUnmatchedBuys) {
            if (buyCancelCount <= 0) break;
            logger && logger.log && logger.log(`Startup: Cancelling excess BUY chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: x.chain.id, dryRun });
                logger && logger.log && logger.log(`Startup: Successfully cancelled excess BUY order ${x.chain.id}`, 'info');
                buyCancelCount--;
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to cancel BUY ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (buyCancelCount > 0) {
            const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort((a, b) => (a.price || 0) - (b.price || 0));  // Sort LOW to HIGH: cancel worst (edge) orders first

            for (const o of activeBuys) {
                if (buyCancelCount <= 0) break;
                logger && logger.log && logger.log(`Startup: Cancelling excess matched BUY ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun });
                    logger && logger.log && logger.log(`Startup: Successfully cancelled excess matched BUY order ${o.orderId} (grid ${o.id})`, 'info');
                    buyCancelCount--;
                } catch (err) {
                    logger && logger.log && logger.log(`Startup: Failed to cancel matched BUY ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    logger && logger.log && logger.log(
        `Startup reconcile complete: target(sell=${targetSell}, buy=${targetBuy}), chain(sell=${chainSellCount}, buy=${chainBuyCount}), ` +
        `gridActive(sell=${_countActiveOnGrid(manager, ORDER_TYPES.SELL)}, buy=${_countActiveOnGrid(manager, ORDER_TYPES.BUY)})`,
        'info'
    );

    // DUST CHECK: If startup reconcile resulted in partials on either side,
    // trigger a full rebalance to consolidate them.
    const allOrders = Array.from(manager.orders.values());
    const { buy: buyPartials, sell: sellPartials } = getPartialsByType(allOrders);

    if (buyPartials.length > 0 && sellPartials.length > 0) {
        const buyHasDust = manager.strategy.hasAnyDust(buyPartials, "buy");
        const sellHasDust = manager.strategy.hasAnyDust(sellPartials, "sell");

        if (buyHasDust && sellHasDust) {
            logger && logger.log && logger.log("[STARTUP] Dual-side dust partials detected. Triggering full rebalance.", "info");
            return await manager.strategy.rebalance();
        }
    }

    return null;
}

module.exports = {
    reconcileStartupOrders,
    attemptResumePersistedGridByPriceMatch,
    decideStartupGridAction,
};
