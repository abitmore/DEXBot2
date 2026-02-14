/**
 * Grid index building and management utilities
 */

const { ORDER_STATES, ORDER_TYPES } = require('../../constants');

/**
 * Build complete index set from grid
 * @param {Map} grid - Order grid
 * @returns {Object} - Index object with state and type indexes
 */
function buildIndexes(grid) {
    const indexes = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set(),
        [ORDER_STATES.FILLED]: new Set(),
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    for (const order of grid.values()) {
        if (indexes[order.state]) indexes[order.state].add(order.id);
        if (indexes[order.type]) indexes[order.type].add(order.id);
    }

    return indexes;
}

/**
 * Build indexes incrementally (for Phase 2 optimization)
 * @param {Map} grid - Order grid
 * @param {Object} existingIndexes - Existing indexes to update
 * @param {Array} changes - Array of {type, order, oldOrder} change records
 * @returns {Object} - Updated indexes
 */
function updateIndexesIncrementally(grid, existingIndexes, changes) {
    const indexes = { ...existingIndexes };
    
    for (const change of changes) {
        const { type, order, oldOrder } = change;
        
        if (oldOrder) {
            if (indexes[oldOrder.state]) {
                indexes[oldOrder.state].delete(oldOrder.id);
            }
            if (indexes[oldOrder.type]) {
                indexes[oldOrder.type].delete(oldOrder.id);
            }
        }
        
        if (order && type !== 'cancel') {
            if (!indexes[order.state]) {
                indexes[order.state] = new Set();
            }
            indexes[order.state].add(order.id);
            
            if (!indexes[order.type]) {
                indexes[order.type] = new Set();
            }
            indexes[order.type].add(order.id);
        }
    }
    
    return indexes;
}

/**
 * Validate index consistency (for testing/debugging)
 * @param {Map} grid - Order grid
 * @param {Object} indexes - Index object
 * @returns {Object} - Validation result
 */
function validateIndexes(grid, indexes) {
    const errors = [];
    
    for (const [id, order] of grid.entries()) {
        const stateIndex = indexes[order.state];
        const typeIndex = indexes[order.type];
        
        if (!stateIndex || !stateIndex.has(id)) {
            errors.push(`Order ${id} missing from state index ${order.state}`);
        }
        if (!typeIndex || !typeIndex.has(id)) {
            errors.push(`Order ${id} missing from type index ${order.type}`);
        }
    }
    
    for (const [key, indexSet] of Object.entries(indexes)) {
        for (const id of indexSet) {
            if (!grid.has(id)) {
                errors.push(`Orphaned index entry: ${key} has ${id} but not in grid`);
            }
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    buildIndexes,
    updateIndexesIncrementally,
    validateIndexes
};
