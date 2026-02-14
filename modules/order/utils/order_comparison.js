/**
 * Order comparison utilities with epsilon-based float handling
 * Replaces fragile JSON.stringify comparisons
 */

const EPSILON = 1e-6;

function getOrderSize(order) {
    const size = Number(order?.size);
    if (Number.isFinite(size)) return size;
    const amount = Number(order?.amount);
    return Number.isFinite(amount) ? amount : 0;
}

/**
 * Compare two orders for equality
 * @param {Object} a - First order
 * @param {Object} b - Second order
 * @returns {boolean} - True if orders are equivalent
 */
function ordersEqual(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    
    return a.id === b.id &&
           a.type === b.type &&
           a.state === b.state &&
           Math.abs(a.price - b.price) < EPSILON &&
           Math.abs(getOrderSize(a) - getOrderSize(b)) < EPSILON &&
           a.orderId === b.orderId &&
           a.gridIndex === b.gridIndex;
}

/**
 * Build delta actions between master and working grid
 * @param {Map} masterGrid - Source of truth grid
 * @param {Map} workingGrid - Modified working copy
 * @returns {Array} - Array of action objects
 */
function buildDelta(masterGrid, workingGrid) {
    const actions = [];
    
    for (const [id, workingOrder] of workingGrid.entries()) {
        const masterOrder = masterGrid.get(id);
        
        if (!masterOrder) {
            actions.push({ 
                type: 'create', 
                id, 
                order: workingOrder 
            });
        } else if (!ordersEqual(workingOrder, masterOrder)) {
            actions.push({ 
                type: 'update', 
                id, 
                order: workingOrder, 
                prevOrder: masterOrder,
                orderId: masterOrder.orderId
            });
        }
    }
    
    for (const [id, masterOrder] of masterGrid.entries()) {
        if (!workingGrid.has(id)) {
            actions.push({ 
                type: 'cancel', 
                id, 
                orderId: masterOrder.orderId 
            });
        }
    }
    
    return actions;
}

/**
 * Calculate hash for quick change detection (optional optimization)
 * @param {Object} order - Order to hash
 * @returns {string} - Hash string
 */
function orderHash(order) {
    return `${order.id}:${order.type}:${order.state}:${order.price.toFixed(8)}:${getOrderSize(order).toFixed(8)}`;
}

module.exports = { 
    ordersEqual, 
    buildDelta,
    orderHash,
    EPSILON 
};
