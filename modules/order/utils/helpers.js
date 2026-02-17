/**
 * modules/order/utils/helpers.js
 *
 * Pure functions for order validation, grid reconciliation, and immutable mutations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS
 * ===============================================================================
 *
 * SECTION 1: EXTERNAL DEPENDENCIES
 *
 * SECTION 2: VALIDATION
 *   - validateOrder()
 *   - validateGridForPersistence()
 *   - calculateRequiredFunds()
 *   - validateWorkingGridFunds()
 *   - checkFundDrift()
 *
 * SECTION 3: GRID RECONCILIATION (COW Pipeline)
 *   - reconcileGrid()
 *   - summarizeActions()
 *   - projectTargetToWorkingGrid()
 *   - buildStateUpdates()
 *   - buildAbortedResult()
 *   - buildSuccessResult()
 *   - evaluateCommit()
 *
 * SECTION 4: GRID MUTATIONS (Immutable Operations)
 *   - applyOrderUpdate()
 *   - applyOrderUpdatesBatch()
 *   - buildIndices()
 *   - swapMasterGrid()
 *
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: EXTERNAL DEPENDENCIES
// ===============================================================================

const {
    ORDER_STATES,
    ORDER_TYPES,
    COW_ACTIONS,
    GRID_LIMITS
} = require('../../constants');
const {
    floatToBlockchainInt,
    getPrecisionSlack
} = require('./math');
const {
    isOrderOnChain,
    isPhantomOrder,
    hasOnChainId,
    convertToSpreadPlaceholder
} = require('./order');
const Format = require('../format');
const { deepFreeze, cloneMap } = require('./system');

// Pre-computed valid sets
const VALID_ORDER_STATES = new Set(Object.values(ORDER_STATES));
const VALID_ORDER_TYPES = new Set(Object.values(ORDER_TYPES));

// ===============================================================================
// SECTION 2: VALIDATION
// ===============================================================================

/**
 * Validate a complete order object
 * @param {Object} order - Order to validate
 * @param {Object} oldOrder - Previous order state (for context)
 * @param {string} context - Operation context for error messages
 * @returns {Object} Validation result
 */
function validateOrder(order, oldOrder = null, context = 'validate') {
    const errors = [];
    const warnings = [];
    let normalizedOrder = { ...(oldOrder || {}), ...order };

    if (!order || !order.id) {
        errors.push({ code: 'MISSING_ID', message: 'Refusing to update order: missing ID' });
        return { isValid: false, errors, warnings, normalizedOrder: null };
    }

    if (!normalizedOrder.type && normalizedOrder.state === ORDER_STATES.VIRTUAL) {
        const placeholderSize = Number(normalizedOrder.size || 0);
        if (placeholderSize === 0) {
            normalizedOrder.type = ORDER_TYPES.SPREAD;
        }
    }

    if (!VALID_ORDER_STATES.has(normalizedOrder.state)) {
        errors.push({
            code: 'INVALID_STATE',
            message: `Refusing to update order ${order.id}: invalid state '${normalizedOrder.state}' (context: ${context})`
        });
    }

    if (!VALID_ORDER_TYPES.has(normalizedOrder.type)) {
        errors.push({
            code: 'INVALID_TYPE',
            message: `Refusing to update order ${order.id}: invalid type '${normalizedOrder.type}' (context: ${context})`
        });
    }

    if (normalizedOrder.type === ORDER_TYPES.SPREAD && Number(normalizedOrder.size || 0) !== 0) {
        warnings.push({
            code: 'SPREAD_SIZE_NORMALIZED',
            message: `[INVARIANT] Normalizing SPREAD order ${order.id} size ${normalizedOrder.size} -> 0 (context: ${context})`
        });
        normalizedOrder.size = 0;
    }

    if (normalizedOrder.type === ORDER_TYPES.SPREAD && isOrderOnChain(normalizedOrder)) {
        errors.push({
            code: 'ILLEGAL_SPREAD_STATE',
            message: `ILLEGAL STATE: Refusing to move SPREAD order ${order.id} to ${normalizedOrder.state}. SPREAD orders must remain VIRTUAL.`,
            isFatal: true
        });
    }

    if (isPhantomOrder(normalizedOrder)) {
        errors.push({
            code: 'PHANTOM_ORDER',
            message: `ILLEGAL STATE: Refusing to set order ${order.id} to ${normalizedOrder.state} without orderId. Context: ${context}. This would create a phantom order that doubles fund tracking.`,
            autoCorrect: {
                state: ORDER_STATES.VIRTUAL,
                orderId: null,
                rawOnChain: null,
                size: 0
            }
        });
    }

    if (normalizedOrder.type === ORDER_TYPES.BUY || normalizedOrder.type === ORDER_TYPES.SELL) {
        normalizedOrder.committedSide = normalizedOrder.type;
    } else if (!normalizedOrder.committedSide && oldOrder) {
        if (oldOrder.committedSide) {
            normalizedOrder.committedSide = oldOrder.committedSide;
        } else if (oldOrder.type === ORDER_TYPES.BUY || oldOrder.type === ORDER_TYPES.SELL) {
            normalizedOrder.committedSide = oldOrder.type;
        }
    }

    return {
        isValid: errors.length === 0 || !errors.some(e => e.isFatal),
        errors,
        warnings,
        normalizedOrder
    };
}

/**
 * Validate grid state for persistence
 * @param {Map} orders - Master grid orders
 * @param {Object} accountTotals - Current account totals
 * @returns {Object} Validation result
 */
function validateGridForPersistence(orders, accountTotals) {
    for (const order of orders.values()) {
        if (isPhantomOrder(order)) {
            return {
                isValid: false,
                reason: `Phantom order detected: order ${order.id} is ${order.state} but has no orderId`
            };
        }
    }

    if (!accountTotals || !Number.isFinite(accountTotals.buy) || !Number.isFinite(accountTotals.sell)) {
        return {
            isValid: false,
            reason: 'Account totals not initialized'
        };
    }

    return { isValid: true, reason: null };
}

/**
 * Calculate required funds from a grid
 * @param {Map|WorkingGrid} grid - Grid to analyze
 * @param {Object} precisions - Precision config
 * @returns {Object} Required funds { buyInt, sellInt, buy, sell }
 */
function calculateRequiredFunds(grid, precisions = {}) {
    const buyPrecision = Number.isFinite(Number(precisions.buyPrecision)) 
        ? Number(precisions.buyPrecision) 
        : 8;
    const sellPrecision = Number.isFinite(Number(precisions.sellPrecision)) 
        ? Number(precisions.sellPrecision) 
        : 8;

    let buyRequiredInt = 0;
    let sellRequiredInt = 0;

    for (const order of grid.values()) {
        const size = Number.isFinite(Number(order.size))
            ? Math.max(0, Number(order.size))
            : Number(order.amount || 0);

        const state = order.state;
        const isActive = state === 'active' || state === 'partial';

        if (isActive && isOrderOnChain(order)) {
            if (order.type === 'buy') {
                buyRequiredInt += floatToBlockchainInt(size, buyPrecision);
            } else if (order.type === 'sell') {
                sellRequiredInt += floatToBlockchainInt(size, sellPrecision);
            }
        }
    }

    return {
        buyInt: buyRequiredInt,
        sellInt: sellRequiredInt,
        buy: buyRequiredInt / Math.pow(10, buyPrecision),
        sell: sellRequiredInt / Math.pow(10, sellPrecision)
    };
}

/**
 * Validate working grid against available funds
 * @param {WorkingGrid} workingGrid - Grid to validate
 * @param {Object} projectedFunds - Available funds
 * @param {Object} precisions - Asset precisions
 * @param {Object} assets - Asset metadata
 * @returns {Object} Validation result
 */
function validateWorkingGridFunds(workingGrid, projectedFunds, precisions = {}, assets = null) {
    const buyPrecision = Number.isFinite(Number(precisions.buyPrecision))
        ? Number(precisions.buyPrecision)
        : (assets?.assetB?.precision || 8);
    const sellPrecision = Number.isFinite(Number(precisions.sellPrecision))
        ? Number(precisions.sellPrecision)
        : (assets?.assetA?.precision || 8);

    const intToFloat = (value, precision) => Number(value || 0) / Math.pow(10, precision);
    
    const required = calculateRequiredFunds(workingGrid, { buyPrecision, sellPrecision });
    
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

    const availableBuyInt = floatToBlockchainInt(availableBuy, buyPrecision);
    const availableSellInt = floatToBlockchainInt(availableSell, sellPrecision);

    if (required.buyInt > availableBuyInt) {
        const requiredBuyFloat = intToFloat(required.buyInt, buyPrecision);
        const availableBuyFloat = intToFloat(availableBuyInt, buyPrecision);
        shortfalls.push({
            asset: assets?.assetB?.symbol || 'buyAsset',
            required: requiredBuyFloat,
            available: availableBuyFloat,
            deficit: intToFloat(required.buyInt - availableBuyInt, buyPrecision)
        });
    }

    if (required.sellInt > availableSellInt) {
        const requiredSellFloat = intToFloat(required.sellInt, sellPrecision);
        const availableSellFloat = intToFloat(availableSellInt, sellPrecision);
        shortfalls.push({
            asset: assets?.assetA?.symbol || 'sellAsset',
            required: requiredSellFloat,
            available: availableSellFloat,
            deficit: intToFloat(required.sellInt - availableSellInt, sellPrecision)
        });
    }

    return {
        isValid: shortfalls.length === 0,
        reason: shortfalls.length > 0 ? `Fund shortfall: ${JSON.stringify(shortfalls)}` : null,
        shortfalls,
        required,
        available: { buy: availableBuy, sell: availableSell }
    };
}

/**
 * Check fund drift against blockchain totals
 * @param {Map} orders - Current orders
 * @param {Object} accountTotals - Blockchain account totals
 * @param {Object} assets - Asset metadata
 * @returns {Object} Drift check result
 */
function checkFundDrift(orders, accountTotals, assets = null) {
    let gridBuy = 0, gridSell = 0;
    for (const order of Array.from(orders.values())) {
        const size = Number(order.size) || 0;
        if (size <= 0 || !isOrderOnChain(order)) continue;

        if (order.type === 'buy') gridBuy += size;
        else if (order.type === 'sell') gridSell += size;
    }

    const chainFreeBuy = accountTotals?.buyFree || 0;
    const chainFreeSell = accountTotals?.sellFree || 0;
    const actualBuy = accountTotals?.buy || 0;
    const actualSell = accountTotals?.sell || 0;

    const expectedBuy = chainFreeBuy + gridBuy;
    const expectedSell = chainFreeSell + gridSell;

    const driftBuy = Math.abs(actualBuy - expectedBuy);
    const driftSell = Math.abs(actualSell - expectedSell);

    const buyPrecision = assets?.assetB?.precision;
    const sellPrecision = assets?.assetA?.precision;
    
    if (!Number.isFinite(buyPrecision) || !Number.isFinite(sellPrecision)) {
        return { isValid: true, reason: 'Skipped: precision not available', driftBuy, driftSell };
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
        reason: !buyOk 
            ? `BUY drift ${Format.formatAmountByPrecision(driftBuy, buyPrecision)} > ${Format.formatAmountByPrecision(allowedDriftBuy, buyPrecision)}`
            : !sellOk 
                ? `SELL drift ${Format.formatAmountByPrecision(driftSell, sellPrecision)} > ${Format.formatAmountByPrecision(allowedDriftSell, sellPrecision)}`
                : null
    };
}

// ===============================================================================
// SECTION 3: GRID RECONCILIATION (COW Pipeline)
// ===============================================================================

/**
 * Reconcile target grid against master state
 * @param {Map} masterGrid - Current master grid
 * @param {Map} targetGrid - Target state from strategy
 * @param {number} targetBoundary - Target boundary index
 * @param {Object} options - Options
 * @returns {Object} Reconciliation result with actions
 */
function reconcileGrid(masterGrid, targetGrid, targetBoundary, options = {}) {
    const { logger = null } = options;
    const actions = [];

    let validatedBoundary = targetBoundary;
    if (targetBoundary !== null) {
        const maxIdx = Math.max(0, masterGrid.size - 1);
        if (targetBoundary < 0 || targetBoundary > maxIdx) {
            const clamped = Math.max(0, Math.min(maxIdx, targetBoundary));
            if (logger) {
                logger(`[RECONCILE] Clamping target boundary ${targetBoundary} -> ${clamped} (max ${maxIdx}).`, 'warn');
            }
            validatedBoundary = clamped;
        }
    }

    for (const [id, targetOrder] of targetGrid) {
        const masterOrder = masterGrid.get(id);

        if (!masterOrder || masterOrder.state === ORDER_STATES.VIRTUAL) {
            if (targetOrder.size > 0) {
                actions.push({ type: COW_ACTIONS.CREATE, id, order: targetOrder });
            }
            continue;
        }

        if (masterOrder.type !== targetOrder.type) {
            actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId });
            if (targetOrder.size > 0) {
                actions.push({ type: COW_ACTIONS.CREATE, id, order: targetOrder });
            }
            continue;
        }

        if (masterOrder.size !== targetOrder.size) {
            if (targetOrder.size === 0) {
                actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId });
            } else {
                actions.push({ 
                    type: COW_ACTIONS.UPDATE, 
                    id, 
                    orderId: masterOrder.orderId, 
                    newSize: targetOrder.size, 
                    order: targetOrder 
                });
            }
        }
    }

    for (const [id, masterOrder] of masterGrid) {
        if (!targetGrid.has(id) && isOrderOnChain(masterOrder)) {
            actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId });
        }
    }

    return { 
        actions, 
        aborted: false,
        boundaryIdx: validatedBoundary,
        summary: summarizeActions(actions)
    };
}

/**
 * Summarize actions for logging/debugging
 * @param {Array} actions - Action list
 * @returns {Object} Summary counts
 */
function summarizeActions(actions) {
    return {
        total: actions.length,
        creates: actions.filter(a => a.type === COW_ACTIONS.CREATE).length,
        cancels: actions.filter(a => a.type === COW_ACTIONS.CANCEL).length,
        updates: actions.filter(a => a.type === COW_ACTIONS.UPDATE).length
    };
}

/**
 * Project target grid into working grid
 * @param {WorkingGrid} workingGrid - Working grid to modify
 * @param {Map} targetGrid - Target state
 */
function projectTargetToWorkingGrid(workingGrid, targetGrid) {
    const targetIds = new Set();

    for (const [id, targetOrder] of targetGrid.entries()) {
        targetIds.add(id);

        const current = workingGrid.get(id);
        const targetSize = Number.isFinite(Number(targetOrder?.size)) ? Number(targetOrder.size) : 0;

        if (!current) {
            // New orders start as VIRTUAL - transition to ACTIVE happens in synchronizeWithChain
            // after blockchain confirms placement. This ensures accounting deduction occurs.
            workingGrid.set(id, {
                ...targetOrder,
                size: Math.max(0, targetSize),
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            });
            continue;
        }

        if (targetSize > 0) {
            const keepOrderId = isOrderOnChain(current) && hasOnChainId(current) && current.type === targetOrder.type;
            // Orders without on-chain ID remain VIRTUAL until synchronizeWithChain
            // confirms blockchain placement and triggers accounting deduction.
            workingGrid.set(id, {
                ...current,
                ...targetOrder,
                size: targetSize,
                state: keepOrderId ? current.state : ORDER_STATES.VIRTUAL,
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
 * Build optimistic state updates from rebalance actions
 * @param {Array<Object>} actions - Array of rebalance action objects
 * @param {Map} masterGrid - Master grid Map containing current order states
 * @returns {Array<Object>} State update objects for optimistic rendering
 */
function buildStateUpdates(actions, masterGrid) {
    const stateUpdates = [];

    for (const action of actions) {
        if (action.type === COW_ACTIONS.CREATE) {
            stateUpdates.push({ 
                ...action.order, 
                state: ORDER_STATES.VIRTUAL, 
                orderId: null 
            });
        } else if (action.type === COW_ACTIONS.CANCEL) {
            const masterOrder = masterGrid.get(action.id);
            if (masterOrder) {
                stateUpdates.push(convertToSpreadPlaceholder(masterOrder));
            }
        } else if (action.type === COW_ACTIONS.UPDATE) {
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
 * Build an aborted COW result
 * @param {string} reason - Abort reason
 * @returns {Object} Aborted result object
 */
function buildAbortedResult(reason) {
    return {
        actions: [],
        stateUpdates: [],
        hadRotation: false,
        workingGrid: null,
        workingIndexes: null,
        workingBoundary: null,
        planningDuration: 0,
        aborted: true,
        reason
    };
}

/**
 * Build successful COW result
 * @param {Object} params - Result parameters
 * @returns {Object} Success result object
 */
function buildSuccessResult({
    actions,
    stateUpdates,
    workingGrid,
    workingBoundary,
    planningDuration
}) {
    return {
        actions,
        stateUpdates,
        hadRotation: actions.some(a => a.type === COW_ACTIONS.CREATE || a.type === COW_ACTIONS.UPDATE),
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary,
        planningDuration,
        aborted: false
    };
}

/**
 * Evaluate if a working grid can be committed
 * @param {WorkingGrid} workingGrid - Grid to evaluate
 * @param {Object} options - Evaluation options
 * @returns {Object} Evaluation result
 */
function evaluateCommit(workingGrid, options = {}) {
    const hasLock = typeof options === 'boolean' ? options : !!options?.hasLock;
    const currentVersion = typeof options === 'object' && Number.isFinite(Number(options.currentVersion))
        ? Number(options.currentVersion)
        : null;
    const masterGrid = typeof options === 'object' ? options.masterGrid : null;

    if (!workingGrid) {
        return {
            canCommit: false,
            reason: 'No working grid to commit',
            level: 'error'
        };
    }

    if (workingGrid.isStale()) {
        return {
            canCommit: false,
            reason: `Refusing stale working grid commit${hasLock ? ' (under lock)' : ''}: ${workingGrid.getStaleReason() || 'Master grid changed during planning'}`,
            level: 'warn'
        };
    }

    const baseVersion = (typeof workingGrid.getBaseVersion === 'function')
        ? workingGrid.getBaseVersion()
        : workingGrid.baseVersion;

    if (baseVersion === null || baseVersion === undefined) {
        return {
            canCommit: false,
            reason: 'Working grid has no base version',
            level: 'error'
        };
    }

    if (currentVersion !== null && Number.isFinite(Number(baseVersion)) && Number(baseVersion) !== currentVersion) {
        return {
            canCommit: false,
            reason: `Refusing working grid commit: base version ${Number(baseVersion)} != current ${currentVersion}`,
            level: 'warn'
        };
    }

    if (masterGrid && typeof workingGrid.buildDelta === 'function') {
        const delta = workingGrid.buildDelta(masterGrid);
        if (Array.isArray(delta) && delta.length === 0) {
            return {
                canCommit: false,
                reason: 'Delta empty at commit - nothing to commit',
                level: 'debug'
            };
        }
    }

    if (hasLock) {
        const stats = workingGrid.getMemoryStats();
        if (stats.size === 0) {
            return {
                canCommit: false,
                reason: 'Working grid is empty',
                level: 'warn'
            };
        }
    }

    return { canCommit: true };
}

// ===============================================================================
// SECTION 4: GRID MUTATIONS (Immutable Operations)
// ===============================================================================

/**
 * Apply an order update immutably
 * @param {Map} masterGrid - Current master grid
 * @param {Object} orderUpdate - Order update to apply
 * @param {Object} indices - Current indices object
 * @returns {Object} { newGrid, newIndices, updatedOrder }
 */
function applyOrderUpdate(masterGrid, orderUpdate, indices) {
    const id = orderUpdate.id;
    const oldOrder = masterGrid.get(id);
    const nextOrder = { ...(oldOrder || {}), ...orderUpdate };

    const updatedOrder = deepFreeze({ ...nextOrder });

    const newIndices = {
        byState: {},
        byType: {}
    };

    for (const [state, set] of Object.entries(indices.byState || {})) {
        newIndices.byState[state] = new Set(set);
    }
    for (const [type, set] of Object.entries(indices.byType || {})) {
        newIndices.byType[type] = new Set(set);
    }

    if (oldOrder) {
        for (const set of Object.values(newIndices.byState)) {
            set.delete(id);
        }
        for (const set of Object.values(newIndices.byType)) {
            set.delete(id);
        }
    }

    if (newIndices.byState[updatedOrder.state]) {
        newIndices.byState[updatedOrder.state].add(id);
    }
    if (newIndices.byType[updatedOrder.type]) {
        newIndices.byType[updatedOrder.type].add(id);
    }

    const newGrid = cloneMap(masterGrid);
    newGrid.set(id, updatedOrder);

    return {
        newGrid: Object.freeze(newGrid),
        newIndices,
        updatedOrder
    };
}

/**
 * Apply multiple order updates as a batch
 * @param {Map} masterGrid - Current master grid
 * @param {Array<Object>} updates - Array of order updates
 * @param {Object} indices - Current indices
 * @returns {Object} { newGrid, newIndices, updatedOrders }
 */
function applyOrderUpdatesBatch(masterGrid, updates, indices) {
    const newGrid = cloneMap(masterGrid);
    const newIndices = {
        byState: {},
        byType: {}
    };
    const updatedOrders = [];

    for (const [state, set] of Object.entries(indices.byState || {})) {
        newIndices.byState[state] = new Set(set);
    }
    for (const [type, set] of Object.entries(indices.byType || {})) {
        newIndices.byType[type] = new Set(set);
    }

    for (const update of updates) {
        const id = update.id;
        const oldOrder = newGrid.get(id);
        const nextOrder = { ...(oldOrder || {}), ...update };
        const updatedOrder = deepFreeze({ ...nextOrder });

        if (oldOrder) {
            for (const set of Object.values(newIndices.byState)) {
                set.delete(id);
            }
            for (const set of Object.values(newIndices.byType)) {
                set.delete(id);
            }
        }

        if (newIndices.byState[updatedOrder.state]) {
            newIndices.byState[updatedOrder.state].add(id);
        }
        if (newIndices.byType[updatedOrder.type]) {
            newIndices.byType[updatedOrder.type].add(id);
        }

        newGrid.set(id, updatedOrder);
        updatedOrders.push(updatedOrder);
    }

    return {
        newGrid: Object.freeze(newGrid),
        newIndices,
        updatedOrders
    };
}

/**
 * Build indices from a grid
 * @param {Map} grid - Grid to index
 * @param {Array<string>} states - Valid states
 * @param {Array<string>} types - Valid types
 * @returns {Object} { byState, byType }
 */
function buildIndices(grid, states, types) {
    const byState = {};
    const byType = {};

    for (const state of states) {
        byState[state] = new Set();
    }
    for (const type of types) {
        byType[type] = new Set();
    }

    for (const [id, order] of grid) {
        if (byState[order.state]) {
            byState[order.state].add(id);
        }
        if (byType[order.type]) {
            byType[order.type].add(id);
        }
    }

    return { byState, byType };
}

/**
 * Swap master grid atomically
 * @param {Map} newGrid - New grid to swap in
 * @param {Object} indices - New indices
 * @returns {Object} { grid, ordersByState, ordersByType }
 */
function swapMasterGrid(newGrid, indices) {
    return {
        grid: Object.freeze(newGrid),
        ordersByState: indices.byState,
        ordersByType: indices.byType
    };
}

// ===============================================================================
// EXPORTS
// ===============================================================================

module.exports = {
    // Validation
    validateOrder,
    validateGridForPersistence,
    calculateRequiredFunds,
    validateWorkingGridFunds,
    checkFundDrift,
    VALID_ORDER_STATES,
    VALID_ORDER_TYPES,

    // Grid reconciliation (COW pipeline)
    reconcileGrid,
    summarizeActions,
    projectTargetToWorkingGrid,
    buildStateUpdates,
    buildAbortedResult,
    buildSuccessResult,
    evaluateCommit,

    // Grid mutations (immutable)
    applyOrderUpdate,
    applyOrderUpdatesBatch,
    buildIndices,
    swapMasterGrid
};
