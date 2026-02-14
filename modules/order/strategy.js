/**
 * modules/order/strategy.js - StrategyEngine
 *
 * Grid rebalancing and order placement strategy.
 * Exports a single StrategyEngine class implementing boundary-crawl pivot strategy.
 *
 * Strategy Approach:
 * - Simple & Robust Pivot Strategy (Boundary-Crawl Version)
 * - Maintains contiguous physical rails using a master boundary anchor
 * - Boundary fixed at market start price determines BUY/SELL/SPREAD zones
 * - Dynamically rebalances orders as grid prices change
 * - Handles partial fills and order consolidation
 *
 * ===============================================================================
 * TABLE OF CONTENTS - StrategyEngine Class (5 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor(manager) - Create new StrategyEngine with manager reference
 *
 * REBALANCING (1 method)
 *   2. calculateTargetGrid(params) - UNIFIED PURE TARGET CALCULATION
 *      Calculates the "Ideal State" based on current fills and market conditions.
 *      Returns: { targetGrid: Map, boundaryIdx: number }
 *      No side effects.
 *
 * ORDER PROCESSING (2 methods)
 *   3. processFillsOnly(filledOrders, excludeOrderIds) - Process filled orders (async)
 *      Handles order fill events, fee accounting, and grid updates
 *      Consolidates partial fills, updates fund state. Does NOT trigger rebalancing.
 *
 *   4. processFilledOrders(filledOrders, excludeOrderIds, options) - Legacy entry point (async)
 *      Now delegates to processFillsOnly and returns empty actions.
 *      The manager is responsible for calling performSafeRebalance().
 *
 * HEALTH CHECK (1 method)
 *   5. hasAnyDust(partials, side) - Check for dust (unhealthy) partial orders
 *      Detects partial orders below minimum size threshold
 *      Returns true if dust detected on side
 *
 * ===============================================================================
 *
 * BOUNDARY-CRAWL ALGORITHM:
 * 1. Find reference price (from fills or market)
 * 2. Calculate gap slots for spread zone
 * 3. Determine split index (boundary location in sorted price array)
 * 4. Assign roles:
 *    - BUY slots: below boundary (price < reference)
 *    - SPREAD slots: within gap
 *    - SELL slots: above boundary (price >= reference)
 * 5. Calculate order sizes based on budgeting
 * 6. Handle fills and consolidate partials
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES } = require("../constants");
const {
    getAssetFees,
    _getFeeCache
} = require("./utils/math");
const {
    virtualizeOrder,
    hasOnChainId,
    isOrderPlaced,
    convertToSpreadPlaceholder
} = require("./utils/order");
const Grid = require('./grid');

class StrategyEngine {
    constructor(manager) {
        this.manager = manager;
        this._settledFeeEvents = new Map();
        this._feeEventTtlMs = 6 * 60 * 60 * 1000;
    }

    _pruneSettledFeeEvents(now) {
        for (const [eventId, ts] of this._settledFeeEvents) {
            if (now - ts > this._feeEventTtlMs) {
                this._settledFeeEvents.delete(eventId);
            }
        }
    }

    _buildFeeEventId(filledOrder) {
        return filledOrder.historyId || [
            filledOrder.orderId || filledOrder.id,
            filledOrder.blockNum || 'na',
            Number(filledOrder.size || 0),
            filledOrder.isMaker === false ? 'taker' : 'maker'
        ].join(':');
    }

    /**
     * Process filled orders: handle fills and consolidate partials.
     * Does NOT trigger rebalancing (now decoupled from rebalance logic).
     * 
     * This method handles the accounting side of fills without modifying
     * the grid structure. It is called by processFilledOrders() as the first
     * phase of the two-phase fill processing pipeline.
     *
     * OPERATIONS PERFORMED:
     * 1. Validates and filters filled orders
     * 2. Virtualizes fully-filled slots (converts ACTIVE/PARTIAL to VIRTUAL)
     * 3. Calculates and deducts BTS fees (if BTS pair)
     * 4. Triggers fund recalculation
     *
     * FEE CALCULATION:
     * - For BTS trading pairs, calculates fees based on maker/taker status
     * - Maker fills: Lower fee rate
     * - Taker fills: Higher fee rate
     * - Fees are accumulated and deducted from available funds
     *
     * @param {Array<Object>} filledOrders - Array of filled order objects from blockchain
     *   - id {string}: Order slot ID
     *   - orderId {string}: Blockchain order ID
     *   - type {string}: 'BUY' or 'SELL'
     *   - price {number}: Order price
     *   - size {number}: Filled size
     *   - isPartial {boolean}: Whether this is a partial fill
     *   - isMaker {boolean}: Whether fill was maker (true) or taker (false)
     *   - isDelayedRotationTrigger {boolean}: Whether this triggers delayed rotation
     * @param {Set<string>} [excludeOrderIds=new Set()] - Order IDs to skip
     * @returns {Promise<boolean>} True if processing completed successfully
     * @async
     */
    async processFillsOnly(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!Array.isArray(filledOrders) || filledOrders.length === 0) return true;

        mgr.logger.log(`[STRATEGY] Processing batch of ${filledOrders.length} filled orders...`, 'info');

        const now = Date.now();
        this._pruneSettledFeeEvents(now);

        let fillsToSettle = 0;
        let makerFillCount = 0;
        let takerFillCount = 0;

        for (const filledOrder of filledOrders) {
            if (excludeOrderIds?.has?.(filledOrder.id)) {
                mgr.logger.log(`[STRATEGY] Skipping excluded fill for order ${filledOrder.id}`, 'debug');
                continue;
            }

            const isPartial = filledOrder.isPartial === true;
            mgr.logger.log(`[STRATEGY] Processing fill: id=${filledOrder.id}, type=${filledOrder.type}, price=${filledOrder.price}, size=${filledOrder.size}, partial=${isPartial}`, 'debug');

            if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                const feeEventId = this._buildFeeEventId(filledOrder);

                if (!this._settledFeeEvents.has(feeEventId)) {
                    this._settledFeeEvents.set(feeEventId, now);
                    fillsToSettle++;
                    if (filledOrder.isMaker !== false) makerFillCount++;
                    else takerFillCount++;
                } else {
                    mgr.logger.log(`[STRATEGY] Skipping duplicate fee settlement event ${feeEventId}`, 'debug');
                }

                const currentSlot = mgr.orders.get(filledOrder.id);
                const slotReused = currentSlot && hasOnChainId(currentSlot) && filledOrder.orderId && currentSlot.orderId !== filledOrder.orderId;

                if (currentSlot && !slotReused && isOrderPlaced(currentSlot)) {
                    mgr.logger.log(`[STRATEGY] Virtualizing filled slot ${filledOrder.id}`, 'debug');
                    await mgr._updateOrder({ ...virtualizeOrder(currentSlot), size: 0 }, 'fill', false, 0);
                }
            }
        }

        const hasBtsPair = (mgr.config?.assetA === 'BTS' || mgr.config?.assetB === 'BTS');
        const feeCache = _getFeeCache();
        if (hasBtsPair && fillsToSettle > 0 && feeCache?.BTS) {
            const btsFeeDataMaker = getAssetFees('BTS', null, true);
            const btsFeeDataTaker = getAssetFees('BTS', null, false);
            const makerFeesOwed = makerFillCount * btsFeeDataMaker.netFee;
            const takerFeesOwed = takerFillCount * btsFeeDataTaker.netFee;
            mgr.logger.log(`[STRATEGY] Calculated fees: makerOwed=${makerFeesOwed} (${makerFillCount} fills), takerOwed=${takerFeesOwed} (${takerFillCount} fills)`, 'debug');
            mgr.funds.btsFeesOwed += makerFeesOwed + takerFeesOwed;
            await mgr.accountant.deductBtsFees();
        }

        await mgr.recalculateFunds();
        mgr.logger.log(`[STRATEGY] Batch fill processing complete. Fills settled: ${fillsToSettle}`, 'info');
        return true;
    }

    /**
     * UNIFIED PURE TARGET CALCULATION
     * Calculates the "Ideal State" grid based on current fills and market conditions.
     * 
     * This is a PURE FUNCTION with no side effects. It takes the current state and
     * calculates what the grid SHOULD look like after rebalancing, without modifying
     * any actual state.
     *
     * ALGORITHM:
     * 1. Derive new boundary index based on fills (boundary crawl)
     * 2. Assign grid roles (BUY/SELL/SPREAD) based on boundary position
     * 3. Calculate budget allocation for each side
     * 4. Apply window discipline (activeOrders count limits)
     * 5. Calculate ideal order sizes based on budgets and weights
     * 6. Build target grid map representing desired state
     *
     * BOUNDARY CRAWL:
     * - BUY fills shift boundary LEFT (market moved down)
     * - SELL fills shift boundary RIGHT (market moved up)
     * - Spread gap is maintained between buy and sell zones
     *
     * WINDOW DISCIPLINE:
     * - Only targetCountBuy buy orders kept (closest to boundary)
     * - Only targetCountSell sell orders kept (closest to boundary)
     * - Excess orders are virtualized (size = 0)
     *
     * @param {Object} params - Calculation parameters
     * @param {Map} params.frozenMasterGrid - Immutable copy of current grid orders
     * @param {Object} params.config - Bot configuration
     *   - targetSpreadPercent {number}: Width of spread zone
     *   - incrementPercent {number}: Price step between orders
     *   - activeOrders {Object}: Target active order counts
     *   - weightDistribution {Object}: Size weighting for each side
     * @param {Object} params.accountAssets - Asset metadata (precision, IDs)
     * @param {Object} params.funds - Current fund state
     *   - available {Object}: Available funds per side
     *   - committed {Object}: Committed funds per side
     * @param {Array<Object>} params.fills - Recent fills that triggered calculation
     * @param {number} params.currentBoundaryIdx - Current boundary index
     * @param {boolean} [params.buySideIsDoubled=false] - Whether buy side has doubled orders
     * @param {boolean} [params.sellSideIsDoubled=false] - Whether sell side has doubled orders
     * @returns {Object} Target grid state:
     *   - targetGrid {Map}: Map of slotId -> target order state
     *     - id {string}: Slot ID
     *     - price {number}: Order price
     *     - type {string}: 'BUY', 'SELL', or 'SPREAD'
     *     - size {number}: Target size (0 for virtualized orders)
     *     - state {string}: 'ACTIVE' or 'VIRTUAL'
     *   - boundaryIdx {number}: New boundary index
     */
    calculateTargetGrid(params) {
        // Core params needed for calculation
        const { 
            frozenMasterGrid, 
            config, 
            accountAssets, 
            funds, 
            fills,
            currentBoundaryIdx 
        } = params;

        const { deriveTargetBoundary, getSideBudget, calculateBudgetedSizes } = require('./utils/strategy_logic');
        const { assignGridRoles } = require('./utils/order');

        // Clone grid for local simulation (Target Grid)
        // We work with "slots" which are the potential order locations
        const allSlots = Array.from(frozenMasterGrid.values())
            .filter(o => o.price != null)
            .sort((a, b) => a.price - b.price)
            .map(o => ({ ...o })); // Shallow clone for simulation

        if (allSlots.length === 0) return { targetGrid: new Map(), boundaryIdx: currentBoundaryIdx };

        // 1. Determine new boundary based on fills (Boundary Crawl)
        const effectiveTargetSpread = (params.buySideIsDoubled || params.sellSideIsDoubled) 
            ? config.targetSpreadPercent + config.incrementPercent 
            : config.targetSpreadPercent;
            
        const gapSlots = Grid.calculateGapSlots(config.incrementPercent, effectiveTargetSpread);
        const newBoundaryIdx = deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots);

        // 2. Assign Roles (Buy/Sell/Spread)
        assignGridRoles(allSlots, newBoundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });

        this.manager.logger.log(`[DEBUG] calculateTargetGrid: boundary=${newBoundaryIdx}, gap=${gapSlots}, allSlots=${allSlots.length}`, 'debug');
        allSlots.forEach((s, i) => this.manager.logger.log(`  Slot ${i}: id=${s.id}, price=${s.price}, type=${s.type}`, 'debug'));

        // 3. Calculate Ideal Sizes (Budgeting)
        const totalTarget = Math.max(0, config.activeOrders?.buy || 1) + Math.max(0, config.activeOrders?.sell || 1);
        const budgetBuy = getSideBudget('buy', funds, config, totalTarget);
        const budgetSell = getSideBudget('sell', funds, config, totalTarget);
        
        // Filter slots into BUY/SELL
        const allBuySlots = allSlots.filter(o => o.type === ORDER_TYPES.BUY);
        const allSellSlots = allSlots.filter(o => o.type === ORDER_TYPES.SELL);

        // Apply Window Discipline (activeOrders count)
        const targetCountBuy = Math.max(1, config.activeOrders?.buy || 1);
        const targetCountSell = Math.max(1, config.activeOrders?.sell || 1);

        // Sort Closest-First for windowing
        const buySlots = allBuySlots
            .sort((a, b) => b.price - a.price)
            .slice(0, targetCountBuy);
        
        const sellSlots = allSellSlots
            .sort((a, b) => a.price - b.price)
            .slice(0, targetCountSell);
        
        const buySizes = calculateBudgetedSizes(buySlots, 'buy', budgetBuy, config.weightDistribution?.buy, config.incrementPercent, accountAssets);
        const sellSizes = calculateBudgetedSizes(sellSlots, 'sell', budgetSell, config.weightDistribution?.sell, config.incrementPercent, accountAssets);

        // Apply sizes to target grid map
        const targetGrid = new Map();
        
        const applySizes = (slots, sizes) => {
            slots.forEach((slot, i) => {
                const size = sizes[i] || 0;
                targetGrid.set(slot.id, {
                    id: slot.id,
                    price: slot.price,
                    type: slot.type,
                    size: size,
                    idealSize: size,
                    // If size > 0, we WANT it active. If size 0, we want it VIRTUAL/SPREAD
                    state: size > 0 ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    committedSide: slot.committedSide // Preserve metadata
                });
            });
        };

        applySizes(buySlots, buySizes);
        applySizes(sellSlots, sellSizes);
        
        // Handle slots outside the window (ensure they are zeroed/virtualized)
        const windowIds = new Set([...buySlots, ...sellSlots].map(s => s.id));
        allSlots.forEach(slot => {
            if (!windowIds.has(slot.id)) {
                targetGrid.set(slot.id, {
                    id: slot.id,
                    price: slot.price,
                    type: slot.type, // Keep current type
                    size: 0,
                    idealSize: 0,
                    state: ORDER_STATES.VIRTUAL
                });
            }
        });

        return { 
            targetGrid: targetGrid,
            boundaryIdx: newBoundaryIdx 
        }; 
    }

    /**
     * Check for dust (unhealthy) partial orders on a side.
     *
     * A "dust" order is a partial fill that has remaining size below the minimum
     * viable order size for the asset. These orders are problematic because:
     * - They cannot be rotated (new order would be below minimum)
     * - They tie up small amounts of capital inefficiently
     * - They may indicate grid misconfiguration
     *
     * DETECTION LOGIC:
     * - Compares remaining size against asset-specific minimums
     * - Uses doubled thresholds when side has doubled orders
     * - Considers both absolute and relative minimums
     *
     * @param {Array<Object>} partials - Array of partial order objects
     *   - id {string}: Order slot ID
     *   - orderId {string}: Blockchain order ID
     *   - type {string}: 'BUY' or 'SELL'
     *   - price {number}: Order price
     *   - size {number}: Current remaining size
     *   - state {string}: Should be 'PARTIAL'
     * @param {string} side - Side to check ('buy' or 'sell')
     * @returns {boolean} True if any partial on the side is below minimum viable size
     */
    hasAnyDust(partials, side) {
        const mgr = this.manager;
        return Grid.hasAnyDust(mgr, partials, side);
    }

    /**
     * LEGACY ENTRY POINT: Process filled orders (now decoupled from rebalancing).
     *
     * This method is maintained for backward compatibility but now follows a
     * decoupled architecture where fill processing and rebalancing are separate phases.
     *
     * NEW ARCHITECTURE:
     * 1. This method ONLY processes fills (accounting, virtualization)
     * 2. It delegates to processFillsOnly() for actual fill handling
     * 3. It NO LONGER triggers rebalancing directly
     * 4. The caller (OrderManager) is responsible for calling performSafeRebalance()
     *
     * RETURN VALUE:
     * Always returns empty actions/stateUpdates because rebalancing happens separately.
     * The manager calls this method, then decides whether to rebalance based on results.
     *
     * @param {Array<Object>} filledOrders - Array of filled order objects from blockchain
     *   - id {string}: Order slot ID
     *   - orderId {string}: Blockchain order ID
     *   - type {string}: 'BUY' or 'SELL'
     *   - price {number}: Order price
     *   - size {number}: Filled size
     *   - isPartial {boolean}: Whether this is a partial fill
     *   - isMaker {boolean}: Whether fill was maker or taker
     * @param {Set<string>} [excludeOrderIds=new Set()] - Order IDs to skip during processing
     * @param {Object} [_options={}] - Legacy processing options (now ignored)
     * @returns {Promise<Object>} Empty result object for compatibility:
     *   - actions {Array}: Always empty []
     *   - stateUpdates {Array}: Always empty []
     *   - hadRotation {boolean}: Always false
     * @async
     * @deprecated Use processFillsOnly() for fill processing. Rebalancing is now handled
     *   separately by OrderManager.performSafeRebalance().
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set(), _options = {}) {
        const mgr = this.manager;
        if (!filledOrders || filledOrders.length === 0) return { actions: [], stateUpdates: [], hadRotation: false };

        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders`, "info");

        // Use the new decoupled fill processor
        await this.processFillsOnly(filledOrders, excludeOrderIds);

        // --- NEW ARCHITECTURE: DECOUPLED REBALANCE ---
        // Instead of calling this.rebalance() directly, we return empty results.
        // The manager is now responsible for calling performSafeRebalance() 
        // immediately after this method returns.
        return { 
            actions: [], 
            stateUpdates: [], 
            hadRotation: false 
        };
    }
}

module.exports = StrategyEngine;
