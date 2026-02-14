/**
 * modules/order/utils/strategy_logic.js - Pure Strategy Calculations
 * 
 * Side-effect-free logic for grid boundary and budgeting.
 */

const { ORDER_TYPES, ORDER_STATES } = require('../../constants');
const MathUtils = require('./math');
const { calculateIdealBoundary } = require('./order');

/**
 * Determine new boundary based on fills and current state.
 * 
 * @param {Array} fills - Recent fill events
 * @param {number|null} currentBoundaryIdx - Current boundary index
 * @param {Array} allSlots - All grid slots sorted by price
 * @param {Object} config - Bot configuration
 * @param {number} gapSlots - Number of spread gap slots
 * @returns {number} New boundary index
 */
function deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots) {
    let newBoundaryIdx = currentBoundaryIdx;
    
    // Initial recovery if boundary is undefined
    if (newBoundaryIdx === undefined || newBoundaryIdx === null) {
         const referencePrice = config.startPrice;
         newBoundaryIdx = calculateIdealBoundary(allSlots, referencePrice, gapSlots);
    }

    // Apply shift from fills
    for (const fill of fills) {
        if (fill.isPartial) continue;
        if (fill.type === ORDER_TYPES.SELL) newBoundaryIdx++;
        else if (fill.type === ORDER_TYPES.BUY) newBoundaryIdx--;
    }
    
    // Clamp boundary
    return Math.max(0, Math.min(allSlots.length - 1, newBoundaryIdx));
}

/**
 * Calculate side budget after BTS fee deduction.
 * 
 * @param {string} side - 'buy' or 'sell'
 * @param {Object} funds - Snapshot of allocated funds
 * @param {Object} config - Bot configuration
 * @param {number} totalTarget - Total target order count (for fee calculation)
 * @returns {number} Available budget for the side
 */
function getSideBudget(side, funds, config, totalTarget) {
    const isBuy = side === 'buy';
    const allocated = isBuy ? (funds.allocatedBuy || 0) : (funds.allocatedSell || 0);
    
    const isBtsSide = (isBuy && config.assetB === 'BTS') || (!isBuy && config.assetA === 'BTS');
    if (isBtsSide && allocated > 0) {
        const btsFees = MathUtils.calculateOrderCreationFees(
            config.assetA, config.assetB, totalTarget, 
            require('../../constants').FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER
        );
        return Math.max(0, allocated - btsFees);
    }
    return allocated;
}

/**
 * Calculate sizes for all slots on a side using weighted distribution.
 * 
 * @param {Array} slots - Array of slots for the side
 * @param {string} side - 'buy' or 'sell'
 * @param {number} budget - Total budget for the side
 * @param {number} weightDist - Weight distribution factor
 * @param {number} incrementPercent - Grid increment percentage
 * @param {Object} assets - Asset metadata for precision
 * @returns {Array} Array of calculated sizes
 */
function calculateBudgetedSizes(slots, side, budget, weightDist, incrementPercent, assets) {
    const isBuy = side === 'buy';
    
    // Attempt to get actual precisions, fallback to 8 for lightweight tests
    let precision = 8;
    if (assets?.assetA && assets?.assetB) {
        try {
            const { A: precA, B: precB } = MathUtils.getPrecisionsForManager(assets);
            precision = isBuy ? precB : precA;
        } catch (e) {
            // Keep default precision 8 if manager asset structure is incomplete
        }
    }

    const incrementFactor = incrementPercent / 100;
    
    return MathUtils.allocateFundsByWeights(
        budget, 
        slots.length, 
        weightDist || 0.5, 
        incrementFactor, 
        isBuy, // Reverse for BUY (Market-Close is last in array)
        0, 
        precision
    );
}

module.exports = {
    deriveTargetBoundary,
    getSideBudget,
    calculateBudgetedSizes
};
