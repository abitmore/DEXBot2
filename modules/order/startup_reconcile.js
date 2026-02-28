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
 * INTERNAL HELPERS:
 *   4. _countActiveOnGrid(manager, type) - Count active/partial orders by type
 *   5. _pickVirtualSlotsToActivate(manager, type, count) - Pick virtual slots for activation
 *   6. _isGridEdgeFullyActive(manager, orderType, updateCount) - Check if grid edge is fully active on one side
 *   7. _findLargestOrder(unmatchedOrders, updateCount) - Find the largest unmatched chain order
 *   8. _cancelLargestOrder({...}) - Cancel the largest unmatched chain order (async)
 *   9. _createOrderFromGrid({...}) - Create a new on-chain order from a grid slot (async)
 *   10. _cancelChainOrder({...}) - Cancel a specific on-chain order (async)
 *   11. _recoverStartupSyncFailure({...}) - Handle sync failure recovery at startup (async)
 *   12. _executeStartupUpdateBatch({...}) - Execute startup updates in one batch (async)
 *   13. _executeStartupSingleUpdate({...}) - Execute one startup update (async)
 *   14. _executeStartupSequentialUpdateFallback({...}) - Sequential backup after batch retries (async)
 *   15. _reconcileStartupSide({...}) - Reconcile one side (buy/sell) against chain at startup (async)
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

const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../constants');
const { getMinAbsoluteOrderSize, getAssetFees } = require('./utils/math');
const { isOrderPlaced, parseChainOrder, buildCreateOrderArgs, isOrderOnChain, getPartialsByType, buildOutsideInPairGroups, extractBatchOperationResults } = require('./utils/order');
const { resolveAccountRef } = require('./utils/system');
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

function _getStartupSideComparators(orderType, assets) {
    const isSell = orderType === ORDER_TYPES.SELL;

    const sortUpdateComparator = isSell
        ? (a, b) => (parseChainOrder(a, assets)?.price || 0) - (parseChainOrder(b, assets)?.price || 0)
        : (a, b) => (parseChainOrder(b, assets)?.price || 0) - (parseChainOrder(a, assets)?.price || 0);

    const sortExcessCancelComparator = isSell
        ? (a, b) => (b.parsed.price || 0) - (a.parsed.price || 0)
        : (a, b) => (a.parsed.price || 0) - (b.parsed.price || 0);

    const sortMatchedCancelComparator = isSell
        ? (a, b) => (b.price || 0) - (a.price || 0)
        : (a, b) => (a.price || 0) - (b.price || 0);

    return {
        sortUpdateComparator,
        sortExcessCancelComparator,
        sortMatchedCancelComparator,
    };
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
    // Empty array check prevents vacuous truth: every([]) returns true
    if (edgeOrders.length === 0) return false;
    const allEdgeActive = edgeOrders.every(o => isOrderPlaced(o));

    return allEdgeActive;
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
        // Cancel the largest order on blockchain and release untracked funds.
        await _cancelChainOrder({
            chainOrders,
            account,
            privateKey,
            manager,
            chainOrderId: orderId,
            chainOrderObj: largestOrder,
            releaseUntrackedFunds: true,
            dryRun,
        });
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

    if (result && result.skipped) {
        const logger = manager && manager.logger;
        logger?.log?.(`[_createOrderFromGrid] Skipped slot ${gridOrder.id}: order amounts too small to place on-chain`, 'warn');
        return;
    }

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
        // CRITICAL: Use _applySync (lock-free) since caller holds _gridLock
        await manager._applySync({
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
            const freshChainOrders = await chainOrders.readOpenOrders(
                resolveAccountRef(manager, account),
                TIMING.CONNECTION_TIMEOUT_MS
            );
            // CRITICAL FIX: Use skipAccounting: false - order discovery must update accounting
            // Orphan order requires fund deduction to prevent phantom capital
            await manager.syncFromOpenOrders(freshChainOrders, {
                skipAccounting: false,
                source: 'chainOrderIdExtractionFailure',
                gridLockAlreadyHeld: true
            });
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
 * @param {Object} [params.chainOrderObj] - Raw chain order object (needed for fund release).
 * @param {boolean} [params.releaseUntrackedFunds=false] - If true, release the cancelled order's
 *   committed funds via addToChainFree. Use only for unmatched chain orders that have no
 *   corresponding ACTIVE/PARTIAL grid slot (where synchronizeWithChain cannot release them).
 * @returns {Promise<void>}
 * @private
 */
async function _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId, dryRun, chainOrderObj, releaseUntrackedFunds = false }) {
    if (dryRun) return;

    await chainOrders.cancelOrder(account, privateKey, chainOrderId);
    // CRITICAL: Use _applySync (lock-free) since caller holds _gridLock
    await manager._applySync(chainOrderId, 'cancelOrder');

    // Unmatched chain orders are not represented as ACTIVE/PARTIAL grid slots, so
    // synchronizeWithChain('cancelOrder') cannot release their commitment.
    if (releaseUntrackedFunds && manager.accountant && chainOrderObj) {
        const parsed = parseChainOrder(chainOrderObj, manager.assets);
        if (parsed && parsed.size > 0) {
            await manager.accountant.addToChainFree(parsed.type, parsed.size, 'startup-cancel-unmatched');
        }
    }
}

async function _recoverStartupSyncFailure({ chainOrders, manager, account, logger, triggerMessage, source }) {
    try {
        logger?.log?.(triggerMessage, 'warn');
        const freshChainOrders = await chainOrders.readOpenOrders(
            resolveAccountRef(manager, account),
            TIMING.CONNECTION_TIMEOUT_MS
        );
        await manager.syncFromOpenOrders(freshChainOrders, {
            skipAccounting: false,
            source,
            gridLockAlreadyHeld: true
        });
        return freshChainOrders;
    } catch (syncErr) {
        logger?.log?.(`Startup: Recovery sync failed: ${syncErr.message}`, 'error');
        return null;
    }
}

function _refreshStartupUpdatePlans(updatePlans, chainOpenOrders) {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0) return [];
    const chainById = new Map(
        (Array.isArray(chainOpenOrders) ? chainOpenOrders : [])
            .filter(o => o && o.id)
            .map(o => [o.id, o])
    );

    const refreshed = [];
    for (const plan of updatePlans) {
        if (!plan?.chainOrderId || !plan?.gridOrder?.id) continue;
        const freshChainOrder = chainById.get(plan.chainOrderId);
        if (!freshChainOrder) continue;
        refreshed.push({
            ...plan,
            chainOrderObj: freshChainOrder,
        });
    }
    return refreshed;
}

function _prepareStartupUpdatePlan(plan, manager, logger) {
    const chainOrderId = plan?.chainOrderId;
    const gridOrder = plan?.gridOrder;
    if (!chainOrderId || !gridOrder?.id) return null;

    const currentSlot = manager.orders.get(gridOrder.id);
    if (!currentSlot || (currentSlot.orderId && currentSlot.orderId !== chainOrderId)) {
        logger?.log?.(`Startup: Skip update ${chainOrderId} -> ${gridOrder.id}; slot already mapped (${currentSlot?.orderId || 'none'})`, 'warn');
        return null;
    }
    if (currentSlot.orderId === chainOrderId) {
        logger?.log?.(`Startup: Skip update ${chainOrderId} -> ${gridOrder.id}; slot already matched`, 'debug');
        return null;
    }

    const { amountToSell, minToReceive } = buildCreateOrderArgs(
        gridOrder,
        manager.assets.assetA,
        manager.assets.assetB
    );

    return {
        plan,
        chainOrderId,
        gridOrder,
        parsedChain: parseChainOrder(plan.chainOrderObj, manager.assets),
        updateParams: {
            newPrice: gridOrder.price,
            amountToSell,
            minToReceive,
            orderType: gridOrder.type,
        }
    };
}

async function _finalizeStartupUpdate({ manager, preparedUpdate }) {
    const { plan, parsedChain } = preparedUpdate;
    if (parsedChain && parsedChain.size > 0 && manager.accountant) {
        await manager.accountant.addToChainFree(plan.gridOrder.type, parsedChain.size, 'startup-align');
    }

    const btsFeeData = getAssetFees('BTS');
    await manager._applySync({
        gridOrderId: plan.gridOrder.id,
        chainOrderId: plan.chainOrderId,
        isPartialPlacement: false,
        fee: btsFeeData.updateFee,
        skipAccounting: false
    }, 'createOrder');
}

async function _executeStartupUpdateBatch({
    updatePlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}) {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0 || dryRun) {
        return { executed: false, prepared: 0, skipped: true };
    }

    if (typeof chainOrders?.buildUpdateOrderOp !== 'function' || typeof chainOrders?.executeBatch !== 'function') {
        throw new Error('chainOrders does not support batch update operations');
    }

    const logger = manager?.logger;
    const prepared = [];

    for (const plan of updatePlans) {
        const preparedPlan = _prepareStartupUpdatePlan(plan, manager, logger);
        if (!preparedPlan) continue;

        const buildResult = await chainOrders.buildUpdateOrderOp(
            account,
            preparedPlan.chainOrderId,
            preparedPlan.updateParams,
            plan.chainOrderObj || null
        );

        if (!buildResult) {
            logger?.log?.(`Startup: Skip update ${preparedPlan.chainOrderId} -> ${preparedPlan.gridOrder.id}; no blockchain delta`, 'debug');
            continue;
        }

        prepared.push({
            ...preparedPlan,
            op: buildResult.op,
        });
    }

    if (prepared.length === 0) {
        return { executed: false, prepared: 0, skipped: true };
    }

    logger?.log?.(`Startup: Broadcasting update batch (${prepared.length} op${prepared.length > 1 ? 's' : ''})`, 'info');
    await chainOrders.executeBatch(account, privateKey, prepared.map(p => p.op));

    for (const entry of prepared) {
        await _finalizeStartupUpdate({ manager, preparedUpdate: entry });
    }

    return { executed: true, prepared: prepared.length, skipped: false };
}

async function _executeStartupSingleUpdate({
    plan,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}) {
    if (dryRun) return { executed: false, skipped: true };
    if (typeof chainOrders?.updateOrder !== 'function') {
        throw new Error('chainOrders.updateOrder is required for sequential update fallback');
    }

    const logger = manager?.logger;
    const prepared = _prepareStartupUpdatePlan(plan, manager, logger);
    if (!prepared) return { executed: false, skipped: true };

    const result = await chainOrders.updateOrder(
        account,
        privateKey,
        prepared.chainOrderId,
        prepared.updateParams
    );

    if (!result) {
        logger?.log?.(`Startup: Skip update ${prepared.chainOrderId} -> ${prepared.gridOrder.id}; no blockchain delta`, 'debug');
        return { executed: false, skipped: true };
    }

    await _finalizeStartupUpdate({ manager, preparedUpdate: prepared });
    return { executed: true, skipped: false };
}

async function _executeStartupSequentialUpdateFallback({
    updatePlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}) {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0 || dryRun) {
        return { executed: 0, skipped: 0, failed: 0 };
    }

    const logger = manager?.logger;
    let queue = updatePlans.slice(0);
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    logger?.log?.(`Startup: Falling back to sequential updates for ${queue.length} pending order(s)`, 'warn');

    while (queue.length > 0) {
        const plan = queue.shift();
        if (!plan) continue;

        try {
            const result = await _executeStartupSingleUpdate({
                plan,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
            });

            if (result.executed) executed++;
            else skipped++;
        } catch (err) {
            failed++;
            logger?.log?.(`Startup: Sequential update failed for ${plan.chainOrderId} -> ${plan.gridOrderId || plan.gridOrder?.id}: ${err.message}`, 'error');

            const refreshedChainOrders = await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger,
                triggerMessage: `Startup: Triggering recovery sync after sequential update failure for ${plan.chainOrderId}`,
                source: 'startupReconcileSequentialUpdateFailure',
            });

            queue = _refreshStartupUpdatePlans(queue, refreshedChainOrders);
        }
    }

    return { executed, skipped, failed };
}

async function _createStartupOrderWithHandling({
    chainOrders,
    account,
    privateKey,
    manager,
    gridOrder,
    orderLabel,
    dryRun,
    recovery
}) {
    try {
        await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
    } catch (err) {
        manager?.logger?.log?.(`Startup: Failed to create ${orderLabel}: ${err.message}`, 'error');

        if (recovery && recovery.triggerMessage && recovery.source) {
            await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger: manager?.logger,
                triggerMessage: recovery.triggerMessage,
                source: recovery.source,
            });
        }
    }
}

// _extractBatchOperationResults — thin wrapper over shared utility,
// returns empty array (not null) for callers that iterate directly.
function _extractBatchOperationResults(result) {
    return extractBatchOperationResults(result) || [];
}

function _resolveGroupRecovery(group, fallbackMessage, fallbackSource) {
    for (const plan of group || []) {
        if (plan?.recovery?.triggerMessage && plan?.recovery?.source) {
            return { triggerMessage: plan.recovery.triggerMessage, source: plan.recovery.source };
        }
    }
    return { triggerMessage: fallbackMessage, source: fallbackSource };
}

async function _executeStartupCreateGroupBatch({
    group,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
    groupIndex,
    totalGroups,
}) {
    if (!Array.isArray(group) || group.length === 0 || dryRun) return;
    if (typeof chainOrders?.buildCreateOrderOp !== 'function' || typeof chainOrders?.executeBatch !== 'function') {
        throw new Error('chainOrders does not support batch create operations');
    }

    const logger = manager?.logger;
    const prepared = [];

    for (const plan of group) {
        const gridOrder = plan?.gridOrder;
        if (!gridOrder || !gridOrder.id) continue;

        const currentSlot = manager.orders.get(gridOrder.id);
        if (currentSlot?.orderId) {
            logger?.log?.(`Startup: Skip create ${plan.orderLabel} - slot ${gridOrder.id} already has orderId ${currentSlot.orderId}`, 'warn');
            continue;
        }

        const { amountToSell, sellAssetId, minToReceive, receiveAssetId } = buildCreateOrderArgs(
            gridOrder,
            manager.assets.assetA,
            manager.assets.assetB
        );

        const buildResult = await chainOrders.buildCreateOrderOp(
            account,
            amountToSell,
            sellAssetId,
            minToReceive,
            receiveAssetId,
            null
        );

        if (!buildResult) {
            logger?.log?.(`Startup: Skip create ${plan.orderLabel} - order amounts too small to place on-chain`, 'warn');
            continue;
        }

        prepared.push({ plan, op: buildResult.op });
    }

    if (prepared.length === 0) return;

    const recovery = _resolveGroupRecovery(
        group,
        `Startup: Triggering recovery sync after create group ${groupIndex + 1}/${totalGroups} failure`,
        'startupCreateGroupFailure'
    );

    try {
        logger?.log?.(
            `Startup: Broadcasting create group ${groupIndex + 1}/${totalGroups} in single batch (${prepared.length} op${prepared.length > 1 ? 's' : ''})`,
            'info'
        );

        const batchResult = await chainOrders.executeBatch(account, privateKey, prepared.map(p => p.op));
        const opResults = _extractBatchOperationResults(batchResult);
        const btsFeeData = getAssetFees('BTS');

        let missingChainOrderId = false;
        for (let i = 0; i < prepared.length; i++) {
            const chainOrderId = opResults[i] && opResults[i][1];
            const plan = prepared[i].plan;
            if (!chainOrderId) {
                logger?.log?.(`Startup: create result missing chainOrderId for ${plan.orderLabel}`, 'error');
                missingChainOrderId = true;
                continue;
            }

            await manager._applySync({
                gridOrderId: plan.gridOrder.id,
                chainOrderId,
                isPartialPlacement: false,
                fee: btsFeeData.createFee
            }, 'createOrder');
        }

        if (missingChainOrderId) {
            await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger,
                triggerMessage: recovery.triggerMessage,
                source: recovery.source,
            });
        }
    } catch (err) {
        logger?.log?.(`Startup: Failed to create group ${groupIndex + 1}/${totalGroups}: ${err.message}`, 'error');
        await _recoverStartupSyncFailure({
            chainOrders,
            manager,
            account,
            logger,
            triggerMessage: recovery.triggerMessage,
            source: recovery.source,
        });
    }
}

function _buildOutsideInCreateGroups(createPlans) {
    return buildOutsideInPairGroups(createPlans, {
        isValid: p => Boolean(p?.gridOrder),
        getType: p => p.orderType,
        getPrice: p => p.gridOrder?.price,
    });
}

async function _executePlannedStartupCreates({
    createPlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}) {
    const logger = manager?.logger;
    const groups = _buildOutsideInCreateGroups(createPlans);
    if (groups.length === 0) return;

    logger?.log?.(`Startup: Executing ${createPlans.length} planned create(s) in ${groups.length} outside->center group(s)`, 'info');

    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const labels = group.map(p => `${p.orderType.toUpperCase()}:${p.gridOrder?.id}`).join(', ');
        logger?.log?.(`Startup: Create group ${i + 1}/${groups.length} (${labels})`, 'info');

        const canBatchCreate = typeof chainOrders?.buildCreateOrderOp === 'function' && typeof chainOrders?.executeBatch === 'function';
        if (group.length > 1 && canBatchCreate) {
            await _executeStartupCreateGroupBatch({
                group,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
                groupIndex: i,
                totalGroups: groups.length,
            });
            continue;
        }

        if (group.length > 1 && !canBatchCreate) {
            logger?.log?.('Startup: Batch create helpers unavailable; falling back to sequential creates for this group', 'warn');
        }

        for (const plan of group) {
            await _createStartupOrderWithHandling({
                chainOrders,
                account,
                privateKey,
                manager,
                gridOrder: plan.gridOrder,
                orderLabel: plan.orderLabel,
                dryRun,
                recovery: plan.recovery,
            });
        }
    }
}

async function _reconcileStartupSide({
    orderType,
    targetCount,
    chainSideOrders,
    unmatchedSideOrders,
    manager,
    chainOrders,
    account,
    privateKey,
    dryRun,
    plannedCreates,
    plannedUpdates,
}) {
    const logger = manager?.logger;
    const sideUpper = orderType === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
    const balanceKey = orderType === ORDER_TYPES.SELL ? 'sellFree' : 'buyFree';
    const balanceSymbol = orderType === ORDER_TYPES.SELL ? manager.assets.assetA.symbol : manager.assets.assetB.symbol;
    const {
        sortUpdateComparator,
        sortExcessCancelComparator,
        sortMatchedCancelComparator,
    } = _getStartupSideComparators(orderType, manager.assets);

    const matchedOnGrid = _countActiveOnGrid(manager, orderType);
    const neededSlots = Math.max(0, targetCount - matchedOnGrid);
    const desiredSlots = _pickVirtualSlotsToActivate(manager, orderType, neededSlots);

    const sortedUnmatched = unmatchedSideOrders.slice(0).sort(sortUpdateComparator);
    const updateCount = Math.min(sortedUnmatched.length, desiredSlots.length);
    let cancelledIndex = null;
    let projectedSideBalance = Number(manager.accountTotals?.[balanceKey] || 0);

    logger?.log?.(
        `Startup ${sideUpper}: matchedOnGrid=${matchedOnGrid}, needSlots=${neededSlots}, unmatched=${sortedUnmatched.length}, updates=${updateCount}`,
        'info'
    );

    if (updateCount > 0 && _isGridEdgeFullyActive(manager, orderType, updateCount)) {
        logger?.log?.(`Startup: ${sideUpper} grid edge is fully active, cancelling largest order to free funds`, 'info');
        const cancelInfo = await _cancelLargestOrder({
            chainOrders,
            account,
            privateKey,
            manager,
            unmatchedOrders: sortedUnmatched,
            updateCount,
            orderType,
            dryRun,
        });
        if (cancelInfo) cancelledIndex = cancelInfo.index;
    }

    for (let i = 0; i < updateCount; i++) {
        if (cancelledIndex !== null && i === cancelledIndex) continue;

        const chainOrder = sortedUnmatched[i];
        const gridOrder = desiredSlots[i];
        const gridSize = Number(gridOrder.size) || 0;
        const parsedChain = parseChainOrder(chainOrder, manager.assets);
        const currentSize = parsedChain ? parsedChain.size : 0;
        const sizeIncrease = Math.max(0, gridSize - currentSize);
        const currentAssetBalance = projectedSideBalance;

        if (sizeIncrease > currentAssetBalance) {
            logger?.log?.(
                `Startup: Skipping ${sideUpper} update ${chainOrder.id} - insufficient balance for increase (need +${Format.formatSizeByOrderType(sizeIncrease, orderType, manager.assets)} ${balanceSymbol}, have ${Format.formatSizeByOrderType(currentAssetBalance, orderType, manager.assets)} ${balanceSymbol})`,
                'warn'
            );
            continue;
        }

        logger?.log?.(
            `Startup: Updating chain ${sideUpper} ${chainOrder.id} -> grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatSizeByOrderType(gridOrder.size, orderType, manager.assets)})`,
            'info'
        );

        plannedUpdates.push({
            orderType,
            chainOrderId: chainOrder.id,
            chainOrderObj: chainOrder,
            gridOrderId: gridOrder.id,
            gridOrder: { ...gridOrder },
        });

        projectedSideBalance += (currentSize - gridSize);
    }

    if (cancelledIndex !== null && !dryRun) {
        const targetGridOrder = desiredSlots[cancelledIndex];
        if (targetGridOrder) {
            logger?.log?.(
                `Startup: Creating new ${sideUpper} for cancelled slot at grid ${targetGridOrder.id} (price=${Format.formatPrice6(targetGridOrder.price)}, size=${Format.formatSizeByOrderType(targetGridOrder.size, orderType, manager.assets)})`,
                'info'
            );
            plannedCreates.push({
                orderType,
                gridOrder: targetGridOrder,
                orderLabel: `${sideUpper} for cancelled slot`,
                recovery: {
                    triggerMessage: `Startup: Triggering recovery sync after ${sideUpper} creation failure`,
                    source: 'phase3CreationFailure',
                },
            });
        }
    }

    const processedUnmatched = sortedUnmatched.slice(updateCount);
    const chainCount = chainSideOrders.length;
    const createCount = Math.max(0, targetCount - chainCount);
    const remainingSlots = desiredSlots.slice(updateCount);

    for (let i = 0; i < Math.min(createCount, remainingSlots.length); i++) {
        const gridOrder = remainingSlots[i];
        logger?.log?.(
            `Startup: Creating ${sideUpper} for grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatSizeByOrderType(gridOrder.size, orderType, manager.assets)})`,
            'info'
        );
        plannedCreates.push({
            orderType,
            gridOrder,
            orderLabel: sideUpper,
            // Intentionally no recovery metadata here.
            // This preserves legacy behavior: regular virtual-slot creates only log failures,
            // while cancelled-slot replacement creates trigger a startup recovery sync.
        });
    }

    let cancelCount = Math.max(0, chainCount - targetCount);
    if (cancelCount > 0) {
        const parsedUnmatched = processedUnmatched
            .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort(sortExcessCancelComparator);

        for (const x of parsedUnmatched) {
            if (cancelCount <= 0) break;
            logger?.log?.(`Startup: Cancelling excess ${sideUpper} chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({
                    chainOrders,
                    account,
                    privateKey,
                    manager,
                    chainOrderId: x.chain.id,
                    chainOrderObj: x.chain,
                    releaseUntrackedFunds: true,
                    dryRun,
                });
                logger?.log?.(`Startup: Successfully cancelled excess ${sideUpper} order ${x.chain.id}`, 'info');
                cancelCount--;
            } catch (err) {
                logger?.log?.(`Startup: Failed to cancel ${sideUpper} ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (cancelCount > 0) {
            const activeOrders = manager.getOrdersByTypeAndState(orderType, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort(sortMatchedCancelComparator);

            for (const o of activeOrders) {
                if (cancelCount <= 0) break;
                logger?.log?.(`Startup: Cancelling excess matched ${sideUpper} ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun });
                    logger?.log?.(`Startup: Successfully cancelled excess matched ${sideUpper} order ${o.orderId} (grid ${o.id})`, 'info');
                    cancelCount--;
                } catch (err) {
                    logger?.log?.(`Startup: Failed to cancel matched ${sideUpper} ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    return {
        chainCount,
    };
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
            await storeGrid(Array.from(manager.orders.values()));
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
    if (!chainOrders || typeof chainOrders.cancelOrder !== 'function' || typeof chainOrders.createOrder !== 'function') {
        throw new Error('reconcileStartupOrders: chainOrders must provide cancelOrder and createOrder methods');
    }
    if (typeof chainOrders.readOpenOrders !== 'function') {
        throw new Error('reconcileStartupOrders: chainOrders.readOpenOrders is required for recovery sync');
    }
    const supportsBatchUpdate = typeof chainOrders.buildUpdateOrderOp === 'function' && typeof chainOrders.executeBatch === 'function';
    const supportsSequentialUpdate = typeof chainOrders.updateOrder === 'function';
    if (!supportsBatchUpdate && !supportsSequentialUpdate) {
        throw new Error('reconcileStartupOrders: chainOrders must provide updateOrder or (buildUpdateOrderOp + executeBatch) for startup updates');
    }

    const logger = manager && manager.logger;
    const dryRun = !!(config && config.dryRun);

    const parsedChain = (chainOpenOrders || [])
        .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    const activeCfg = (config && config.activeOrders) ? config.activeOrders : {};
    let targetBuy = Math.max(0, Number.isFinite(Number(activeCfg.buy)) ? Number(activeCfg.buy) : 1);
    let targetSell = Math.max(0, Number.isFinite(Number(activeCfg.sell)) ? Number(activeCfg.sell) : 1);

    const chainBuys = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    const chainSells = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    // Sanitize phantom on-chain claims under a single grid lock.
    return await manager._gridLock.acquire(async () => {
        // Use unlocked updater directly -- we already hold _gridLock.
        // _updateOrder must NOT be used here: it re-acquires _gridLock and would deadlock.
        if (typeof manager._applyOrderUpdate !== 'function') {
            throw new Error('manager._applyOrderUpdate is required for startup reconciliation');
        }
        const applyUpdate = manager._applyOrderUpdate.bind(manager);

        const chainIds = new Set((Array.isArray(chainOpenOrders) ? chainOpenOrders : []).map(o => o && o.id).filter(Boolean));
        for (const order of manager.orders.values()) {
            if (isOrderPlaced(order)) {
                if (!chainIds.has(order.orderId)) {
                    logger?.log?.(`Startup: Found phantom order ${order.id} (ID ${order.orderId}) not on chain. Resetting to VIRTUAL.`, 'warn');

                    await applyUpdate({
                        ...order,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: "",
                        rawOnChain: null
                    }, 'startup-phantom', false, 0);
                }
            }
        }

        // Determine unmatched chain orders after phantom cleanup.
        const matchedChainOrderIds = new Set();
        for (const gridOrder of manager.orders.values()) {
            if (gridOrder && gridOrder.orderId) {
                matchedChainOrderIds.add(gridOrder.orderId);
            }
        }

        const unmatchedChain = (Array.isArray(chainOpenOrders) ? chainOpenOrders : []).filter(co => co && !matchedChainOrderIds.has(co.id));
        const unmatchedParsed = unmatchedChain
            .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed);

        let unmatchedBuys = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
        let unmatchedSells = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);
        const plannedCreates = [];
        const plannedUpdates = [];

        logger && logger.log && logger.log(
            `Startup reconcile starting: unmatched(sell=${unmatchedSells.length}, buy=${unmatchedBuys.length}), target(sell=${targetSell}, buy=${targetBuy})`,
            'info'
        );

        const sellResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.SELL,
            targetCount: targetSell,
            chainSideOrders: chainSells,
            unmatchedSideOrders: unmatchedSells,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
        });
        const chainSellCount = sellResult.chainCount;

        const buyResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY,
            targetCount: targetBuy,
            chainSideOrders: chainBuys,
            unmatchedSideOrders: unmatchedBuys,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
        });
        const chainBuyCount = buyResult.chainCount;

        if (!dryRun && plannedUpdates.length > 0) {
            let updatePlans = plannedUpdates;
            const maxBatchAttempts = 3;
            let batchCompleted = false;

            if (supportsBatchUpdate) {
                for (let attempt = 1; attempt <= maxBatchAttempts; attempt++) {
                    try {
                        const batchResult = await _executeStartupUpdateBatch({
                            updatePlans,
                            chainOrders,
                            account,
                            privateKey,
                            manager,
                            dryRun,
                        });

                        if (batchResult.executed) {
                            logger?.log?.(`Startup: Update batch complete (${batchResult.prepared} updated)`, 'info');
                        }
                        batchCompleted = true;
                        break;
                    } catch (err) {
                        logger?.log?.(`Startup: Update batch attempt ${attempt}/${maxBatchAttempts} failed: ${err.message}`, 'error');

                        const refreshedChainOrders = await _recoverStartupSyncFailure({
                            chainOrders,
                            manager,
                            account,
                            logger,
                            triggerMessage: `Startup: Triggering recovery sync after update batch failure (attempt ${attempt}/${maxBatchAttempts})`,
                            source: 'startupReconcileUpdateBatchFailure',
                        });

                        updatePlans = _refreshStartupUpdatePlans(updatePlans, refreshedChainOrders);
                        if (updatePlans.length === 0) {
                            logger?.log?.('Startup: No update plans remain after recovery sync; skipping further update attempts', 'warn');
                            batchCompleted = true;
                            break;
                        }

                        if (attempt >= maxBatchAttempts) {
                            logger?.log?.('Startup: Update batch retries exhausted; switching to sequential fallback', 'warn');
                            break;
                        }
                    }
                }
            } else {
                logger?.log?.('Startup: Batch update helpers unavailable; using sequential fallback updates', 'warn');
            }

            if (!batchCompleted && updatePlans.length > 0) {
                try {
                    const fallbackResult = await _executeStartupSequentialUpdateFallback({
                        updatePlans,
                        chainOrders,
                        account,
                        privateKey,
                        manager,
                        dryRun,
                    });

                    if (fallbackResult.executed > 0 || fallbackResult.skipped > 0 || fallbackResult.failed > 0) {
                        logger?.log?.(
                            `Startup: Sequential fallback complete (updated=${fallbackResult.executed}, skipped=${fallbackResult.skipped}, failed=${fallbackResult.failed})`,
                            fallbackResult.failed > 0 ? 'warn' : 'info'
                        );
                    }
                } catch (err) {
                    logger?.log?.(`Startup: Sequential fallback failed unexpectedly: ${err.message}`, 'error');
                }
            }
        }

        await _executePlannedStartupCreates({
            createPlans: plannedCreates,
            chainOrders,
            account,
            privateKey,
            manager,
            dryRun,
        });

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
            const buyHasDust = await manager.strategy.hasAnyDust(buyPartials, 'buy');
            const sellHasDust = await manager.strategy.hasAnyDust(sellPartials, 'sell');

            if (buyHasDust && sellHasDust) {
                logger && logger.log && logger.log('[STARTUP] Dual-side dust partials detected. Triggering full rebalance.', 'info');
                return await manager._applySafeRebalanceCOW();
            }
        }

        return null;
    });
}

module.exports = {
    reconcileStartupOrders,
    attemptResumePersistedGridByPriceMatch,
    decideStartupGridAction,
};
