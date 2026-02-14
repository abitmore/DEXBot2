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
 * TABLE OF CONTENTS - StrategyEngine Class (7 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor(manager) - Create new StrategyEngine with manager reference
 *
 * CONFIGURATION (0 methods)
 *
 * REBALANCING (2 methods - async)
 *   3. rebalance(fills, excludeIds) - Main rebalancing entry point
 *      Unified entry for all grid rebalancing operations
 *      Manages boundary crawl, role assignment, and order placement
 *      Handles partial order consolidation and dust detection
 *      Returns rebalance result or null
 *
 *   4. rebalanceSideRobust(type, allSlots, sideSlots, budget, available, excludeIds, reactionCap) - Rebalance one side (async)
 *      Robust side-specific rebalancing with budget constraints
 *      Places new orders up to target count
 *      Returns { totalNewPlacementSize, ordersToPlace, result }
 *
 * ORDER PROCESSING (2 methods)
 *   5. processFilledOrders(filledOrders, excludeOrderIds, options) - Process filled orders (async)
 *      Handles order fill events, fee accounting, and grid updates
 *      Consolidates partial fills, updates fund state
 *      Returns result of processing
 *
 *   6. completeOrderRotation(oldInfo) - Complete order rotation operation
 *      Finalizes rotation by virtualizing old order and activating new ones
 *
 * HEALTH CHECK (1 method)
 *   7. hasAnyDust(partials, side) - Check for dust (unhealthy) partial orders
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
 * 5. Calculate order sizes and place/update orders
 * 6. Handle fills and consolidate partials
 *
 * REBALANCING TRIGGERS:
 * - Market price movement (crawls boundary to follow)
 * - Order fills (updates sizes and fund state)
 * - Partial order consolidation
 * - Fund reallocation
 * - Dust detection (partials below minimum)
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES } = require("../constants");
const {
    getMinAbsoluteOrderSize,
    getSingleDustThreshold,
    getDoubleDustThreshold,
    getAssetFees,
    _getFeeCache,
    allocateFundsByWeights,
    quantizeFloat,
    getPrecision
} = require("./utils/math");
const {
    virtualizeOrder,
    isOrderHealthy,
    convertToSpreadPlaceholder,
    hasOnChainId,
    isOrderPlaced,
    getPartialsByType,
    calculateIdealBoundary,
    assignGridRoles
} = require("./utils/order");
const Format = require('./format');
const Grid = require('./grid');

class StrategyEngine {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Process filled orders: handle fills and consolidate partials.
     * Does NOT trigger rebalancing (now decoupled).
     */
    async processFillsOnly(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!Array.isArray(filledOrders) || filledOrders.length === 0) return true;

        let fillsToSettle = 0;
        let makerFillCount = 0;
        let takerFillCount = 0;

        for (const filledOrder of filledOrders) {
            if (excludeOrderIds?.has?.(filledOrder.id)) continue;

            const isPartial = filledOrder.isPartial === true;
            if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                fillsToSettle++;
                if (filledOrder.isMaker !== false) makerFillCount++;
                else takerFillCount++;

                const currentSlot = mgr.orders.get(filledOrder.id);
                const slotReused = currentSlot && hasOnChainId(currentSlot) && filledOrder.orderId && currentSlot.orderId !== filledOrder.orderId;

                if (currentSlot && !slotReused && isOrderPlaced(currentSlot)) {
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
            mgr.funds.btsFeesOwed += makerFeesOwed + takerFeesOwed;
            await mgr.accountant.deductBtsFees();
        }

        await mgr.recalculateFunds();
        return true;
    }

    /**
     * UNIFIED PURE TARGET CALCULATION
     * Calculates the "Ideal State" based on current fills and market conditions.
     * Returns: { targetGrid: Map, boundaryIdx: number }
     * No side effects.
     */
    calculateTargetGrid(params) {
        // Core params needed for calculation
        const { 
            frozenMasterGrid, 
            config, 
            accountAssets, 
            funds, 
            excludeIds, 
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
     * Unified rebalancing entry point.
     *
     * ALGORITHM: Boundary-Crawl Rebalancing
     * =====================================
     * This method implements a dynamic grid rebalancing strategy that maintains a "boundary"
     * separating BUY and SELL zones with a fixed-size SPREAD gap between them.
     *
     * KEY CONCEPTS:
     * - Master Rail: Single unified array of price levels (not separate buy/sell rails)
     * - Boundary Index: Pivot point that shifts left/right as fills occur
     * - Spread Gap: Fixed-size buffer of empty slots between best buy and best sell
     * - Crawl Mechanism: Orders "crawl" toward market as boundary shifts
     *
     * FLOW:
     * 1. Determine/recover boundary index
     * 2. Shift boundary based on fills (buy fill = shift left, sell fill = shift right)
     * 3. Assign roles (BUY/SPREAD/SELL) based on boundary position
     * 4. Calculate budgets (target vs reality, with cacheFunds)
     * 5. Rebalance each side independently
     *
     * @param {Array} fills - Recently filled orders (triggers boundary shift)
     * @param {Set} excludeIds - Order IDs to skip (locked or recently processed)
     * @returns {Object} Rebalancing actions (place, rotate, update, cancel)
     */
    async rebalance(fills = [], excludeIds = new Set()) {
        const mgr = this.manager;
        mgr.logger.log("[BOUNDARY] Starting robust boundary-crawl rebalance.", "info");

        // Sort all grid slots by price (Master Rail order)
        const allSlots = Array.from(mgr.orders.values())
            .filter(o => o.price != null)
            .sort((a, b) => a.price - b.price)
            .map(o => ({ ...o }));

        if (allSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };

        // Calculate gap slots once for use throughout the rebalance
        // When a side is doubled, increase target spread to naturally widen the boundary and compensate for fewer orders
        let effectiveTargetSpread = mgr.config.targetSpreadPercent;
        if (mgr.buySideIsDoubled || mgr.sellSideIsDoubled) {
            effectiveTargetSpread += mgr.config.incrementPercent;
        }
        const gapSlots = Grid.calculateGapSlots(mgr.config.incrementPercent, effectiveTargetSpread);

        // ================================================================================
        // STEP 1: BOUNDARY DETERMINATION (Initial or Recovery)
        // ================================================================================
        // If boundary is undefined (first run or after restart), calculate initial position
        // based on startPrice. This centers the spread zone around the market price.

        if (mgr.boundaryIdx === undefined) {
            // 1. Try to recover boundary index from existing grid roles (if any)
            // This prevents jumps if startPrice derived from chain is far from the old grid
            // FIX: Find market-closest BUY order, not just any BUY (Issue #9)
            let bestBuyIdx = -1;
            let bestBuyDistance = Infinity;
            const referencePrice = mgr.config.startPrice;

            for (let i = 0; i < allSlots.length; i++) {
                if (allSlots[i].type === ORDER_TYPES.BUY) {
                    const distance = Math.abs(allSlots[i].price - referencePrice);
                    if (distance < bestBuyDistance) {
                        bestBuyDistance = distance;
                        bestBuyIdx = i;
                    }
                }
            }

             if (bestBuyIdx !== -1) {
                 mgr.boundaryIdx = bestBuyIdx;
                 mgr.logger.log(`[BOUNDARY] Recovered boundaryIdx ${mgr.boundaryIdx} from market-closest BUY order (distance=${Format.formatPrice(bestBuyDistance)} from startPrice).`, "info");
            } else {
                // 2. Fallback to startPrice-based initialization (Initial or Recovery)
                mgr.logger.log(`[BOUNDARY] Initializing boundaryIdx from startPrice: ${referencePrice}`, "info");
                mgr.boundaryIdx = calculateIdealBoundary(allSlots, referencePrice, gapSlots);
            }
        }

        // ================================================================================
        // STEP 2: BOUNDARY SHIFT (Based on Fills)
        // ================================================================================
        // The boundary shifts incrementally as orders fill:
        // - BUY fill: Market moved down -> shift boundary LEFT (boundaryIdx--)
        // - SELL fill: Market moved up -> shift boundary RIGHT (boundaryIdx++)
        //
        // This creates the "crawl" effect where orders follow price movement.

        for (const fill of fills) {
            if (fill.isPartial) continue;

            // Validate fill.type is present and valid
            if (!fill.type) {
                mgr.logger.log(`[BOUNDARY] Skipping invalid fill: missing type. Fill: ${JSON.stringify(fill)}`, "warn");
                continue;
            }

            if (fill.type === ORDER_TYPES.SELL) mgr.boundaryIdx++;
            else if (fill.type === ORDER_TYPES.BUY) mgr.boundaryIdx--;
            else {
                mgr.logger.log(`[BOUNDARY] Skipping fill with unknown type: ${fill.type}. Expected BUY or SELL.`, "warn");
            }
        }

        // Validate boundary index before clamping
        if (!Number.isFinite(mgr.boundaryIdx)) {
            mgr.logger.log(`[BOUNDARY] Invalid boundary index detected (NaN/Infinity). Resetting to center.`, 'warn');
            mgr.boundaryIdx = Math.floor(allSlots.length / 2);
        }

        // Clamp boundary to valid range
        mgr.boundaryIdx = Math.max(0, Math.min(allSlots.length - 1, mgr.boundaryIdx));
        const boundaryIdx = mgr.boundaryIdx;

        // ================================================================================
        // STEP 3: ROLE ASSIGNMENT (BUY / SPREAD / SELL)
        // ================================================================================
        // Assign each slot to a role based on its position relative to the boundary:
        // [0 ... boundaryIdx] = BUY zone
        // [boundaryIdx+1 ... boundaryIdx+gapSlots] = SPREAD zone (empty buffer)
        // [boundaryIdx+gapSlots+1 ... N] = SELL zone

        // PHASE 1: Apply type changes immediately (before rebalancing logic runs)
        // This ensures rebalanceSideRobust sees updated types, not old types
        // Fund accounting is safe because no-op changes (same size, same state) don't move funds
        mgr.pauseFundRecalc();

        assignGridRoles(allSlots, boundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });

        // Partition slots into role-based arrays for rebalancing logic
        const buyEndIdx = boundaryIdx;
        const sellStartIdx = boundaryIdx + gapSlots + 1;
        const buySlots = allSlots.slice(0, buyEndIdx + 1);
        const sellSlots = allSlots.slice(sellStartIdx);
        const spreadSlots = allSlots.slice(buyEndIdx + 1, sellStartIdx);

        // Notify manager of actual updates for synchronization
        for (const slot of allSlots) {
            const original = mgr.orders.get(slot.id);
            if (original && original.type !== slot.type) {
                if (slot.type === ORDER_TYPES.SPREAD && isOrderPlaced(original)) {
                    if (mgr?._metrics) {
                        mgr._metrics.spreadRoleConversionBlocked = (mgr._metrics.spreadRoleConversionBlocked || 0) + 1;
                    }
                    mgr.logger.log(
                        `[ROLE-ASSIGNMENT] BLOCKED SPREAD conversion for ${slot.id}: type=${original.type}, state=${original.state}, orderId=${original.orderId || 'none'}`,
                        'warn'
                    );
                    // Revert type if blocked
                    slot.type = original.type;
                    continue;
                }

                const nextOrder = { ...original, type: slot.type };
                if (nextOrder.type === ORDER_TYPES.SPREAD) {
                    await mgr._updateOrder(convertToSpreadPlaceholder(nextOrder), 'role-assignment', false, 0);
                } else {
                    await mgr._updateOrder(nextOrder, 'role-assignment', false, 0);
                }
            }
        }

        await mgr.resumeFundRecalc();
        mgr.logger.log('[ROLE-ASSIGNMENT] Type updates applied. All slots assigned to correct zones.', 'debug');

        // ================================================================================
        // STEP 4: BUDGET CALCULATION (Total Capital with BTS Fee Deduction)
        // ================================================================================
        // Total Side Budget = (ChainFree + Committed) - BTS_Fees (if asset is BTS)
        // Available = funds.available (already includes fill proceeds via chainFree)

        const buyCtx = await Grid.getSizingContext(mgr, 'buy');
        const sellCtx = await Grid.getSizingContext(mgr, 'sell');

        if (!buyCtx || !sellCtx) {
            mgr.logger.log("[BUDGET] Failed to retrieve unified sizing context. Aborting rebalance.", "error");
            return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };
        }

        const budgetBuy = buyCtx.budget;
        const budgetSell = sellCtx.budget;

        // Available funds for net capital increases (e.g., placing new orders)
        // Note: buyCtx/sellCtx already triggered recalculateFunds()
        const availBuy = (mgr.funds?.available?.buy ?? mgr.accountTotals?.buyFree ?? 0);
        const availSell = (mgr.funds?.available?.sell ?? mgr.accountTotals?.sellFree ?? 0);

        if (mgr.logger.level === 'debug') {
            const buyPrecision = mgr.assets?.assetB?.precision;
            const sellPrecision = mgr.assets?.assetA?.precision;
            if (Number.isFinite(buyPrecision) && Number.isFinite(sellPrecision)) {
                mgr.logger.log(`[BUDGET] Unified Sizing: Buy=${Format.formatAmountByPrecision(budgetBuy, buyPrecision)}, Sell=${Format.formatAmountByPrecision(budgetSell, sellPrecision)} (Respects botFunds % and Fees)`, 'debug');
            }
        }

        // Reaction Cap: Limit how many orders we rotate/place per cycle.
        // NOTE: Only count FULL fills - partial fills don't spend capital, so they shouldn't count toward budget.
        // NEW: Handle double replacement triggers by increasing reaction cap.
        let reactionCapBuy = 0;
        let reactionCapSell = 0;
        let boundaryShiftCount = 0;

        for (const fill of fills) {
            // isDoubleReplacementTrigger is only set for full fills in sync_engine
            if (fill.isPartial && !fill.isDelayedRotationTrigger && !fill.isDoubleReplacementTrigger) continue;

            if (!fill.type) {
                mgr.logger.log('[REACTION-CAP] Skipping fill with missing type.', 'warn');
                continue;
            }

            const count = fill.isDoubleReplacementTrigger ? 2 : 1;
            // A SELL fill triggers a BUY replacement
            if (fill.type === ORDER_TYPES.SELL) {
                reactionCapBuy += count;
                boundaryShiftCount += count;
            } else if (fill.type === ORDER_TYPES.BUY) {
                reactionCapSell += count;
                boundaryShiftCount += count;
            } else {
                mgr.logger.log(`[REACTION-CAP] Skipping fill with unknown type: ${fill.type}. Expected BUY or SELL.`, 'warn');
            }
        }

        // In boundary-crawl, each full fill shifts the boundary and requires crawl budget
        // on BOTH sides. Keep opposite-side replacement pressure (above), but floor both
        // sides by total boundary shifts seen in this cycle.
        if (fills.length > 0) {
            const minimumCrawlCap = Math.max(1, boundaryShiftCount);
            reactionCapBuy = Math.max(reactionCapBuy, minimumCrawlCap);
            reactionCapSell = Math.max(reactionCapSell, minimumCrawlCap);
        } else {
            // Periodic rebalance (no fills) - allow 1 action per side
            reactionCapBuy = 1;
            reactionCapSell = 1;
        }

        // ================================================================================
        // STEP 5: SIDE REBALANCING (Independent Buy and Sell)
        // ================================================================================

        const buyResult = await this.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, budgetBuy, availBuy, excludeIds, reactionCapBuy);
        const sellResult = await this.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, budgetSell, availSell, excludeIds, reactionCapSell);

        // Apply state updates to manager with batched fund recalculation
        // ATOMIC BLOCK: All fund changes happen before recalculation and resume
        mgr.pauseFundRecalc();

        // Type changes already applied in STEP 3 after boundary assignment
        // This batch contains ONLY state changes (cancellations/virtualizations)
        // No collision possible - type and state changes happen in separate phases
        const stateOnlyUpdates = [...buyResult.stateUpdates, ...sellResult.stateUpdates];

        // Step 1: Apply state transitions (reduces chainFree via updateOptimisticFreeBalance)
        for (const upd of stateOnlyUpdates) {
            await mgr._updateOrder(upd, 'rebalance-batch', false, 0);
        }

        // Step 2: Deduct cacheFunds (while still paused)
        // CRITICAL: Only deduct from cacheFunds for the side that USES the fill proceeds
        // - proceeds from SELL fills populate cacheFunds.buy -> used for BUY placements
        // - proceeds from BUY fills populate cacheFunds.sell -> used for SELL placements
        // BUY placements: Deduct from cacheFunds.buy
        if (buyResult.totalNewPlacementSize > 0) {
            await mgr.modifyCacheFunds('buy', -buyResult.totalNewPlacementSize, 'new-placements');
        }
        // SELL placements: Deduct from cacheFunds.sell
        if (sellResult.totalNewPlacementSize > 0) {
            await mgr.modifyCacheFunds('sell', -sellResult.totalNewPlacementSize, 'new-placements');
        }

        // Step 3: Resume fund recalculation (internally triggers recalculateFunds once)
        await mgr.resumeFundRecalc();

        // Combine results from both sides
        const result = {
            ordersToPlace: [...buyResult.ordersToPlace, ...sellResult.ordersToPlace],
            ordersToRotate: [...buyResult.ordersToRotate, ...sellResult.ordersToRotate],
            ordersToUpdate: [...buyResult.ordersToUpdate, ...sellResult.ordersToUpdate],
            ordersToCancel: [...buyResult.ordersToCancel, ...sellResult.ordersToCancel],
            stateUpdates: stateOnlyUpdates,  // Only state changes; types already updated in STEP 3
            hadRotation: (buyResult.ordersToRotate.length > 0 || sellResult.ordersToRotate.length > 0)
        };

        // ================================================================================
        // STEP 6: POST-REBALANCE COMPLETION
        // ================================================================================
        // Spread condition check removed - runs in maintenance cycle instead.
        // This prevents premature logging on stale pre-broadcast state.

        mgr.logger.log(`[BOUNDARY] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate. Gap size: ${gapSlots} slots.`, "info");

        return result;
    }

    /**
     * Rebalance a single side (BUY or SELL) using pure grid-based logic.
     *
     * ALGORITHM: Grid-State Pivot (Crawl & Activate)
     * ===============================================
     * 1. Rotations (Updates): Move the furthest surplus order to the CLOSEST inner gap.
     * 2. Placements (Creations): Place new orders in the FURTHEST outer gaps (edges).
     * 3. Naturally results in 'Refill at Spread' and 'Activate at Edge' reactions.
     */
    async rebalanceSideRobust(type, allSlots, sideSlots, totalSideBudget, availSide, excludeIds, reactionCap) {
        if (sideSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };

        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
        const stateUpdates = [];
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToCancel = [];
        const ordersToUpdate = [];

        // Hybrid/asymmetric targeting:
        // - Stable side (enough active on-chain orders): keep window discipline.
        // - Depleted side (active count below window target): relax to whole side so
        //   refill can use best available free slots without window starvation.
        const targetCount = (mgr.config.activeOrders && Number.isFinite(mgr.config.activeOrders[side]))
            ? Math.max(1, mgr.config.activeOrders[side])
            : sideSlots.length;

        const isDoubled = type === ORDER_TYPES.BUY ? mgr.buySideIsDoubled : mgr.sellSideIsDoubled;
        const stableWindowTargetCount = isDoubled ? Math.max(1, targetCount - 1) : targetCount;

        const activeOnChainSideCount = allSlots.filter(s =>
            s.type === type && isOrderPlaced(s) &&
            !(excludeIds.has(s.id) || (hasOnChainId(s) && excludeIds.has(s.orderId)))
        ).length;
        const finalTargetCount = stableWindowTargetCount;

        if (mgr.logger.level === 'debug') {
            mgr.logger.log(
                `[TARGETING] ${side.toUpperCase()} side: active=${activeOnChainSideCount}, ` +
                `window=${stableWindowTargetCount}, mode=window`,
                'debug'
            );
        }

        // ================================================================================
        // BUILD SLOT INDEX MAP FOR O(1) LOOKUPS (FIX: O(n²) -> O(n) complexity)
        // ================================================================================
        const slotIndexMap = new Map();
        for (let idx = 0; idx < allSlots.length; idx++) {
            slotIndexMap.set(allSlots[idx].id, idx);
        }

         // ================================================================================
         // STEP 1: CALCULATE IDEAL STATE
         // ================================================================================
         // SORTING FOR TARGET WINDOW SELECTION:
         // Sort all side slots by price to identify the "closest to market" orders.
         // These closest orders form the target window where we want to maintain liquidity.
         // - BUY side: descending (highest first) = closest to market at top
         // - SELL side: ascending (lowest first) = closest to market at top
         // This enables picking the top finalTargetCount slots as our active window.
         const sortedSideSlots = [...sideSlots].sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);
         
         // SELECT TARGET INDICES:
         // Pick the market-closest N slots (where N = finalTargetCount = activeOrders config).
         // These slots define our "maintained window" - orders here should be active,
         // orders outside should be rotated away or cancelled.
         const targetIndices = [];
         for (let i = 0; i < Math.min(finalTargetCount, sortedSideSlots.length); i++) {
             const idx = slotIndexMap.get(sortedSideSlots[i].id);
             if (idx !== undefined) targetIndices.push(idx);
         }
         const targetSet = new Set(targetIndices);  // Fast O(1) lookup: "is this slot in target window?"
         
         // WEIGHT DISTRIBUTION & SIZING:
         // Weight distribution determines how funds are allocated across the grid.
         // 0.5 = linear (same amount per slot)
         // > 0.5 = more weight to market-close slots (exponential growth outward)
         const weightDist = mgr.config.weightDistribution || { sell: 0.5, buy: 0.5 };
         const sideWeight = weightDist[side];
         const precision = getPrecision(mgr.assets, { side });

         // NOTE: BTS fees are already deducted from totalSideBudget in rebalance().
         // Do NOT subtract them again here - that was causing double fee deduction.

         // CRITICAL SORT ORDER EXPLANATION:
         // The sort order passed to allocateFundsByWeights must match the fund allocation direction.
         // - For sorted slots [closest, ..., furthest], we calculate sizes [s0, s1, ..., sn]
         // - Weight distribution applies exponentially from index 0 onwards
         // - Result: If weight > 0.5, s0 > s1 > ... > sn (exponential decay outward)
         //
         // However, grid.js stores orders internally as [lowest price, ..., highest price] (always ASC).
         // So we need to account for this inversion:
         // - BUY: closest-to-market is highest price (index n-1 in grid array)
         //   -> reverse=true flips weight distribution so grid[n-1] gets max weight
         // - SELL: closest-to-market is lowest price (index 0 in grid array)
         //   -> reverse=false keeps normal order, grid[0] gets max weight
         const reverse = (type === ORDER_TYPES.BUY);
         const sideIdealSizes = allocateFundsByWeights(totalSideBudget, sideSlots.length, sideWeight, mgr.config.incrementPercent / 100, reverse, 0, precision);

        const finalIdealSizes = new Array(allSlots.length).fill(0);
        sideSlots.forEach((slot, i) => {
            const size = quantizeFloat(sideIdealSizes[i] || 0, precision);
            const slotIdx = slotIndexMap.get(slot.id);
            if (slotIdx !== undefined) finalIdealSizes[slotIdx] = size;
        });

         // ================================================================================
         // STEP 2: IDENTIFY SHORTAGES AND SURPLUSES
         // ================================================================================
         // FILTER 1: ACTIVE ON-CHAIN ORDERS
         // Select only orders that are placed on blockchain (have orderId).
         // Exclude orders that are explicitly blocked (in excludeIds set).
         const activeOnChain = allSlots.filter(s => 
             isOrderPlaced(s) && 
             !(excludeIds.has(s.id) || (hasOnChainId(s) && excludeIds.has(s.orderId)))
         );
         
         // FILTER 2: ACTIVE THIS SIDE
         // From on-chain orders, keep only those on the current side (BUY or SELL).
         // Excludes SPREAD orders (which can be either side but are handled separately).
         const activeThisSide = activeOnChain.filter(s => s.type === type);

         // SHORTAGE DETECTION:
         // A slot is a shortage if it's in the target window but lacks an active order.
         // Two subcases:
         // 1. No on-chain order (VIRTUAL or unplaced): needs to be filled
         // 2. Has tiny order (dust): needs to be refilled/updated to proper size
         // Shortages will be addressed by:
         //   - Creating new orders (placements) for empty slots
         //   - Rotating dust orders (cancel + place larger replacement)
         const shortages = targetIndices.filter(idx => {
             const slot = allSlots[idx];
             if (excludeIds.has(slot.id) || (hasOnChainId(slot) && excludeIds.has(slot.orderId))) return false;
             
             // Case 1: No on-chain order = definitely a shortage
             if (!hasOnChainId(slot) && finalIdealSizes[idx] > 0) return true;

             // Case 2: Dust detection
             // Even if an order exists on-chain, if it's too small relative to ideal size,
             // treat it as a shortage (rotate to proper size)
             if (hasOnChainId(slot) && finalIdealSizes[idx] > 0) {
                 const threshold = getSingleDustThreshold(finalIdealSizes[idx]);
                 if (slot.size < threshold) return true;
             }
             return false;
         });

         // SURPLUS DETECTION:
         // A surplus is an order that shouldn't be there (outside target window) or is
         // undersized within the window. Two mechanisms handle surpluses:
         // 1. ROTATION: Move surplus to better price (if funds available and opportunity exists)
         // 2. CANCELLATION: Cancel if rotation not possible
         //
         // Surpluses include TWO categories:
         // 1. Hard Surpluses: Orders outside the target window
         //    -> These are far from market and should be rotated to closer slots
         // 2. Dust Surpluses: Orders inside target window but undersized
         //    -> These are in the right location but too small; rotate or update
         // 
         // NOTE: PARTIAL orders in-window are handled separately (see STEP 3) and
         // filtered from surpluses to prevent unwanted rotation during updates.
         const surpluses = activeThisSide.filter(s => {
             const idx = slotIndexMap.get(s.id);
             if (idx === undefined) return false;
             
             // Case 1: Hard Surplus - Outside target window
             // These orders are beyond our maintained spread and should be rotated to better prices.
             if (!targetSet.has(idx)) return true;

             // Case 2: Dust Surplus - Inside window but undersized
             // Order is in right location but too small; rotate/update to ideal size.
             const idealSize = finalIdealSizes[idx];
             const threshold = getSingleDustThreshold(idealSize);
             if (s.size < threshold) return true;

             return false;
         });

         // SURPLUS SORTING STRATEGY:
         // Determines which surpluses to rotate first when budget is limited.
         // 1. State Priority: PARTIAL orders first (they may be filling soon, worth waiting for)
         // 2. Distance Priority (Edge-First): After state, sort by distance from market
         //    -> Rotate far orders first (outer grid orders are more stable, less locking conflicts)
         //    -> Leave inner orders for cancellation (inner orders have best fill potential)
         //
         // Rationale:
         // - PARTIAL orders: Prioritize for rotation because they're in mid-fill state
         //   and waiting for them to complete uses less capital than placing new orders
         // - Edge-First: Outer grid orders are more stable (price less likely to move through them),
         //   so they're safer for rotation operations. Inner orders get cancelled only if
         //   space is needed, maximizing fill opportunities.
         surpluses.sort((a, b) => {
             // TIEBREAKER 1: PARTIAL state (partial orders move first)
             if (a.state === ORDER_STATES.PARTIAL && b.state !== ORDER_STATES.PARTIAL) return -1;
             if (a.state !== ORDER_STATES.PARTIAL && b.state === ORDER_STATES.PARTIAL) return 1;
             
             // TIEBREAKER 2: Distance from market (Edge-First = further from market comes first)
             // BUY: lower prices first (edge direction)
             // SELL: higher prices first (edge direction)
             return type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price;
         });

         let budgetRemaining = reactionCap;
         const reservedPlacementIds = new Set();

         // PLACEMENT PRIORITY SLOTS:
         // Identify slots closest to market (in target window, not yet placed).
         // These are the slots where we want to place new orders when budget allows.
         // Ordering: Market-nearest first (same as target window selection above)
         // - BUY: highest price first (closest to spread/market)
         // - SELL: lowest price first (closest to spread/market)
         // 
         // We maintain sidePrioritySlots as a pre-sorted list and pickPriorityFreeSlot()
         // walks through it in order, reserving slots as they're committed to placements.
         const sidePrioritySlots = [...sideSlots].sort((a, b) =>
             type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price
         );

         // ADVANCING POINTER OPTIMIZATION:
         // Since reservedPlacementIds only grows during this cycle,
         // prior entries are either already reserved or non-free.
         // Instead of rescanning from index 0, we advance the pointer past already-checked slots.
         // This is O(n) total across all pickPriorityFreeSlot() calls instead of O(n^2).
         let _priorityScanStart = 0;

        const pickPriorityFreeSlot = (excludeSlotId = null) => {
            for (let i = _priorityScanStart; i < sidePrioritySlots.length; i++) {
                const candidate = sidePrioritySlots[i];
                if (!candidate || !candidate.id) continue;
                if (reservedPlacementIds.has(candidate.id)) continue;
                if (candidate.id === excludeSlotId) continue;
                const current = mgr.orders.get(candidate.id);
                if (!current) continue;
                if (excludeIds.has(current.id) || (hasOnChainId(current) && excludeIds.has(current.orderId))) continue;
                if (current.state === ORDER_STATES.VIRTUAL && !hasOnChainId(current)) {
                    _priorityScanStart = i + 1; // resume from next slot on next call
                    return current;
                }
            }
            return null;
        };

        // ================================================================================
        // STEP 3: PARTIAL ORDER HANDLING (Update In-Place Before Rotations/Placements)
        // ================================================================================
        // Handle PARTIAL orders in target window before rotations/placements to prevent grid gaps.
        // - Dust partial: Update to full target size
        // - Non-dust partial: Update to ideal size for proper grid alignment
        // These are then filtered from surpluses to prevent unwanted rotation.
        const handledPartialIds = new Set();
        const partialOrdersInWindow = allSlots.filter(s =>
            s.type === type &&
            s.state === ORDER_STATES.PARTIAL &&
            targetSet.has(slotIndexMap.get(s.id)) &&
            !(excludeIds.has(s.id) || (hasOnChainId(s) && excludeIds.has(s.orderId)))
        );

        let remainingAvail = availSide;
        let totalNewPlacementSize = 0;

        // Dust resize fallback budget: use cacheFunds (fill proceeds earmarked for grid ops)
        // when normal available funds (after virtual deductions) are insufficient.
        // cacheFunds is not yet consumed during rebalance (deducted after at lines 366-372),
        // so it's safely available here for correcting existing on-chain dust orders.
        const cacheFundsFallback = type === ORDER_TYPES.BUY
            ? (mgr.funds?.cacheFunds?.buy ?? 0)
            : (mgr.funds?.cacheFunds?.sell ?? 0);
        let dustResizeBudget = Math.max(0, cacheFundsFallback);

        for (const partial of partialOrdersInWindow) {
            // FIX: Check budget BEFORE processing to respect reactionCap (Issue #4 enhancement)
            if (budgetRemaining <= 0) {
                mgr.logger.log(`[PARTIAL] Budget exhausted, deferring remaining ${partialOrdersInWindow.length - handledPartialIds.size} partial(s) to next cycle`, 'debug');
                break;
            }

            const partialIdx = slotIndexMap.get(partial.id);
            if (partialIdx === undefined) continue;
            const idealSize = finalIdealSizes[partialIdx];

            if (idealSize <= 0) {
                mgr.logger.log(`[PARTIAL] Slot ${partial.id} has no target size, skipping`, 'debug');
                continue;
            }

            const threshold = getSingleDustThreshold(idealSize);
            const isDust = partial.size < threshold;

            if (isDust) {
                // Dust partial: Set side doubled flag and update to ideal size
                // CRITICAL: Cap increase to respect available funds
                const currentSize = partial.size || 0;
                const sizeIncrease = Math.max(0, idealSize - currentSize);
                let cappedIncrease = Math.min(sizeIncrease, remainingAvail);
                let finalSize = currentSize + cappedIncrease;
                let usedDustFallback = false;

                const minAbsoluteSize = getMinAbsoluteOrderSize(type, mgr.assets);

                // Dust resize fallback: when normal available funds (after virtual deductions)
                // are insufficient, use chain free balance for on-chain orders.
                // This corrects an existing order - not new capital deployment.
                if (finalSize < minAbsoluteSize && hasOnChainId(partial) && dustResizeBudget > 0) {
                    cappedIncrease = Math.min(sizeIncrease, dustResizeBudget);
                    finalSize = currentSize + cappedIncrease;
                    usedDustFallback = true;
                    mgr.logger.log(`[PARTIAL] Dust resize using cache funds (${Format.formatSizeByOrderType(dustResizeBudget, type, mgr.assets)}) for ${partial.id}`, 'debug');
                }

                if (idealSize >= minAbsoluteSize && finalSize >= minAbsoluteSize && cappedIncrease > 0) {
                    mgr.logger.log(`[PARTIAL] Dust partial at ${partial.id} (size=${Format.formatSizeByOrderType(partial.size, type, mgr.assets)}, target=${Format.formatSizeByOrderType(idealSize, type, mgr.assets)}). Updating to ${Format.formatSizeByOrderType(finalSize, type, mgr.assets)} and flagging side as doubled.`, 'info');

                    if (type === ORDER_TYPES.BUY) mgr.buySideIsDoubled = true;
                    else mgr.sellSideIsDoubled = true;

                    ordersToUpdate.push({ partialOrder: { ...partial }, newSize: finalSize });
                    // CRITICAL: Only upgrade to ACTIVE if order has valid orderId to prevent phantom orders
                    const newState = hasOnChainId(partial) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
                    stateUpdates.push({ ...partial, size: finalSize, state: newState });

                    totalNewPlacementSize += cappedIncrease;
                    if (usedDustFallback) {
                        dustResizeBudget = Math.max(0, dustResizeBudget - cappedIncrease);
                    } else {
                        remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                    }
                    handledPartialIds.add(partial.id);
                    budgetRemaining--;
                }
            } else {
                // Non-dust partial: Update to ideal size and place new order with old partial size
                const oldSize = partial.size;

                // Place split order on the extreme free slot of the same side.
                const currentNextSlot = pickPriorityFreeSlot(partial.id);
                if (!currentNextSlot) {
                    mgr.logger.log(`[PARTIAL] Skipping non-dust partial at ${partial.id}: no priority free slot available`, "warn");
                    continue;
                }

                // CRITICAL: Update increase must be capped by available funds
                const sizeIncrease = Math.max(0, idealSize - oldSize);
                const cappedIncrease = Math.min(sizeIncrease, remainingAvail);
                const finalSize = oldSize + cappedIncrease;

                const minAbsoluteSize = getMinAbsoluteOrderSize(type, mgr.assets);

                if (idealSize >= minAbsoluteSize && finalSize >= minAbsoluteSize) {
                    mgr.logger.log(`[PARTIAL] Non-dust partial at ${partial.id} (size=${Format.formatSizeByOrderType(oldSize, type, mgr.assets)}, target=${Format.formatSizeByOrderType(idealSize, type, mgr.assets)}). Updating to ${Format.formatSizeByOrderType(finalSize, type, mgr.assets)} and placing split order.`, 'info');
                    ordersToUpdate.push({ partialOrder: { ...partial }, newSize: finalSize });
                    // CRITICAL: Only upgrade to ACTIVE if order has valid orderId to prevent phantom orders
                    const newState = hasOnChainId(partial) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
                    stateUpdates.push({ ...partial, size: finalSize, state: newState });

                    // NEW: Set new split order to VIRTUAL until confirmed on-chain
                    ordersToPlace.push({ ...currentNextSlot, type: type, size: oldSize, state: ORDER_STATES.VIRTUAL });
                    stateUpdates.push({ ...currentNextSlot, type: type, size: oldSize, state: ORDER_STATES.VIRTUAL });
                    reservedPlacementIds.add(currentNextSlot.id);

                    totalNewPlacementSize += cappedIncrease;
                    remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                    handledPartialIds.add(partial.id);
                    budgetRemaining--;
                }
            }
        }

        // Remove handled partials from surpluses so they aren't rotated to other slots
        const filteredSurpluses = surpluses.filter(s => !handledPartialIds.has(s.id));

        // Remove handled partial slots from shortages so they aren't targeted for rotation or placement
        const filteredShortages = shortages.filter(idx => !handledPartialIds.has(allSlots[idx].id));
        const inPlaceUpdatedIds = new Set();

        // ================================================================================
        // STEP 4: ROTATIONS (Refill Inner Gaps)
        // ================================================================================
        // Move furthest active orders to fill inner gaps (closest to market).
        // Note: shortages is derived from sortedSideSlots, so it is already sorted Closest First.
        // FIX: Use separate indices to prevent skipping shortages when surplus is invalid
        let surplusIdx = 0;
        let shortageIdx = 0;
        let rotationsPerformed = 0;

        if (mgr.logger.level === 'debug') {
            const precision = side === ORDER_TYPES.BUY ? mgr.assets?.assetB?.precision : mgr.assets?.assetA?.precision;
            mgr.logger.log(`[REBALANCE] ${side.toUpperCase()} planning: ${filteredShortages.length} shortages, ${filteredSurpluses.length} surpluses, budget=${budgetRemaining}, avail=${Format.formatAmountStrict(remainingAvail, precision)}`, 'debug');
        }

        while (surplusIdx < filteredSurpluses.length &&
            shortageIdx < filteredShortages.length &&
            budgetRemaining > 0) {

            const surplus = filteredSurpluses[surplusIdx];
            const shortageSlotIdx = filteredShortages[shortageIdx];
            const shortageSlot = allSlots[shortageSlotIdx];
            const idealSize = finalIdealSizes[shortageSlotIdx];

            // Validate shortage slot exists
            if (!shortageSlot || !shortageSlot.id || !shortageSlot.price) {
                mgr.logger.log(`[ROTATION] Skipping shortage: invalid slot at index ${shortageSlotIdx}`, "warn");
                shortageIdx++;
                continue;
            }

            const currentSurplus = mgr.orders.get(surplus.id);
            if (!currentSurplus ||
                currentSurplus.state === ORDER_STATES.VIRTUAL ||
                (hasOnChainId(surplus) && currentSurplus.orderId !== surplus.orderId)) {
                mgr.logger.log(`[ROTATION] Skipping surplus ${surplus.id}: no longer valid`, "warn");
                surplusIdx++;
                continue;
            }

            // CRITICAL: Rotations cap against available funds, not against source order size.
            // Available funds ALREADY include fill proceeds via cacheFunds.
            // Only use DESTINATION slot size (shortageSlot), not source order size (currentSurplus).
            // This ensures we cap the FULL grid difference (grid impact), not just the blockchain update.
            // The source order's release is handled separately via fill accounting (cacheFunds).
            const destinationSize = shortageSlot.size || 0; // Usually 0 for a new slot
            const gridDifference = Math.max(0, idealSize - destinationSize);
            const cappedIncrease = Math.min(gridDifference, remainingAvail);
            const finalSize = destinationSize + cappedIncrease;

            // Prevent self-rotation churn: when the same dust order is both shortage and surplus,
            // convert to an in-place size update instead of issuing a no-op rotation on the same slot.
            if (currentSurplus.id === shortageSlot.id) {
                const minHealthySize = getDoubleDustThreshold(idealSize);
                if (isOrderHealthy(finalSize, type, mgr.assets, idealSize)) {
                    ordersToUpdate.push({ partialOrder: { ...currentSurplus }, newSize: finalSize });
                    stateUpdates.push({ ...currentSurplus, size: finalSize, state: ORDER_STATES.ACTIVE });
                    inPlaceUpdatedIds.add(currentSurplus.id);
                    totalNewPlacementSize += cappedIncrease;
                    remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                    budgetRemaining--;
                     mgr.logger.log(`[ROTATION] Converted self-rotation at ${currentSurplus.id} to in-place update (${Format.formatSizeByOrderType(currentSurplus.size, currentSurplus.type, mgr.assets)} -> ${Format.formatSizeByOrderType(finalSize, currentSurplus.type, mgr.assets)})`, 'info');
                } else {
                     mgr.logger.log(`[ROTATION] Skipping self-rotation at ${currentSurplus.id}: resulting size ${Format.formatSizeByOrderType(finalSize, currentSurplus.type, mgr.assets)} below double-dust threshold ${Format.formatSizeByOrderType(minHealthySize, currentSurplus.type, mgr.assets)}`, 'debug');
                }
                surplusIdx++;
                shortageIdx++;
                continue;
            }

            // Logic:
            // 1. If the ideal target is too small (dust), skip it.
            // 2. If available funds cap the order below the healthy threshold, skip it.
            const minHealthySize = getDoubleDustThreshold(idealSize);
            if (isOrderHealthy(finalSize, type, mgr.assets, idealSize)) {
                ordersToRotate.push({
                    oldOrder: { ...currentSurplus },
                    newPrice: shortageSlot.price,
                    newSize: finalSize,
                    newGridId: shortageSlot.id,
                    type: type,
                    from: { ...currentSurplus },
                    to: { ...shortageSlot, size: finalSize }
                });

                // Transition old order to VIRTUAL with size 0 (it's being replaced by the new order)
                stateUpdates.push({ ...virtualizeOrder(currentSurplus), size: 0 });

                // If the destination slot had an existing order (dust), we must cancel it
                // because it's being replaced by this rotation.
                if (hasOnChainId(shortageSlot)) {
                    ordersToCancel.push({ ...shortageSlot });
                    mgr.logger.log(`[ROTATION] Adding victim dust order ${shortageSlot.id} to cancel list (replaced by ${currentSurplus.id})`, 'info');
                }

                // New rotated order must stay VIRTUAL until blockchain confirms
                stateUpdates.push({ ...shortageSlot, type: type, size: finalSize, state: ORDER_STATES.VIRTUAL, orderId: null });

                 mgr.logger.log(`[ROTATION] Atomic rotation: ${currentSurplus.id} (${Format.formatSizeByOrderType(currentSurplus.size, type, mgr.assets)}) -> ${shortageSlot.id} (${Format.formatSizeByOrderType(finalSize, type, mgr.assets)})`, 'info');

                totalNewPlacementSize += cappedIncrease;
                remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                surplusIdx++;
                shortageIdx++;
                rotationsPerformed++;
                budgetRemaining--;
            } else {
                 mgr.logger.log(`[ROTATION] Skipping rotation: resulting size ${Format.formatSizeByOrderType(finalSize, type, mgr.assets)} below double-dust threshold ${Format.formatSizeByOrderType(minHealthySize, type, mgr.assets)}`, 'debug');
                surplusIdx++;
                continue;
            }
        }

        // ================================================================================
        // STEP 5: PLACEMENTS (Activate Outer Edges)
        // ================================================================================
        // Use remaining budget to place new orders at the edge of the grid window.
        // CRITICAL: Cap placement sizes to respect available funds.
        if (budgetRemaining > 0) {
            const pickPlacementShortageSlot = () => {
                for (let i = shortageIdx; i < filteredShortages.length; i++) {
                    const idx = filteredShortages[i];
                    const candidate = allSlots[idx];
                    if (!candidate || !candidate.id) continue;
                    if (reservedPlacementIds.has(candidate.id)) continue;

                    const current = mgr.orders.get(candidate.id) || candidate;
                    if (excludeIds.has(current.id) || (hasOnChainId(current) && excludeIds.has(current.orderId))) continue;
                    if (hasOnChainId(current) || current.state !== ORDER_STATES.VIRTUAL) continue;

                    return { slot: current, idx };
                }
                return null;
            };

            while (budgetRemaining > 0) {
                const placementTarget = pickPlacementShortageSlot();
                if (!placementTarget) break;

                const { slot, idx } = placementTarget;
                reservedPlacementIds.add(slot.id);
                const idealSize = finalIdealSizes[idx];
                if (idealSize <= 0) continue;

                const currentSize = slot.size || 0;
                const sizeIncrease = Math.max(0, idealSize - currentSize);

                const remainingOrders = Math.max(1, budgetRemaining);
                const cappedIncrease = Math.min(sizeIncrease, remainingAvail / remainingOrders);
                const finalSize = currentSize + cappedIncrease;

                const minHealthySize = getDoubleDustThreshold(idealSize);
                if (isOrderHealthy(finalSize, type, mgr.assets, idealSize)) {
                    // NEW: Set new placement to VIRTUAL until confirmed on-chain
                    ordersToPlace.push({ ...slot, type: type, size: finalSize, state: ORDER_STATES.VIRTUAL });
                    stateUpdates.push({ ...slot, type: type, size: finalSize, state: ORDER_STATES.VIRTUAL });
                    totalNewPlacementSize += cappedIncrease;
                    remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                    budgetRemaining--;
                } else {
                     mgr.logger.log(`[PLACEMENT] Skipping placement: resulting size ${Format.formatSizeByOrderType(finalSize, type, mgr.assets)} below double-dust threshold ${Format.formatSizeByOrderType(minHealthySize, type, mgr.assets)}`, 'debug');
                }
            }
        }

        // ================================================================================
        // STEP 6: CANCEL REMAINING SURPLUSES
        // ================================================================================
        // Cancel only hard surpluses (outside target set), from the outside in.
        // Dust surpluses inside the target set are left for update/rotation in later cycles.
        const rotatedOldIds = new Set(ordersToRotate.map(r => r.oldOrder.id));
        for (let i = filteredSurpluses.length - 1; i >= 0; i--) {
            const surplus = filteredSurpluses[i];
            const surplusIdx = slotIndexMap.get(surplus.id);
            const isHardSurplus = surplusIdx !== undefined && !targetSet.has(surplusIdx);
            if (isHardSurplus && !rotatedOldIds.has(surplus.id) && !inPlaceUpdatedIds.has(surplus.id)) {
                mgr.logger.log(`[CANCEL] Hard surplus at ${surplus.id} (idx=${surplusIdx}, price=${Format.formatPrice6(surplus.price)}) is outside target window. Queuing for cancellation.`, 'info');
                ordersToCancel.push({ ...surplus });
                stateUpdates.push(virtualizeOrder(surplus));
            } else if (!isHardSurplus && !rotatedOldIds.has(surplus.id) && !inPlaceUpdatedIds.has(surplus.id)) {
                mgr.logger.log(
                    `[CANCEL-SKIP] Soft surplus ${surplus.id} (idx=${surplusIdx}, price=${Format.formatPrice6(surplus.price)}) inside target set; deferring to later cycle`,
                    'debug'
                );
            }
        }

        return {
            totalNewPlacementSize,
            ordersToPlace,
            ordersToRotate,
            ordersToUpdate,
            ordersToCancel,
            stateUpdates
        };
    }

    /**
     * Check for dust (unhealthy) partial orders on a side.
     * @param {Array<Object>} partials - Array of partial orders.
     * @param {string} side - 'buy' or 'sell'.
     * @returns {boolean} True if any partial is dust.
     */
    hasAnyDust(partials, side) {
        const mgr = this.manager;
        return Grid.hasAnyDust(mgr, partials, side);
    }

    /**
     * Process multiple filled orders and trigger rebalancing.
     * @param {Array<Object>} filledOrders - Array of filled order objects.
     * @param {Set<string>} [excludeOrderIds=new Set()] - IDs to exclude from processing.
     * @param {Object} [options={}] - Processing options.
     * @returns {Promise<Object|void>} Rebalance result or void if no rebalance triggered.
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set(), _options = {}) {
        const mgr = this.manager;
        if (!filledOrders || filledOrders.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };

        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders`, "info");

        // Use the new decoupled fill processor
        await this.processFillsOnly(filledOrders, excludeOrderIds);

        // --- NEW ARCHITECTURE: DECOUPLED REBALANCE ---
        // Instead of calling this.rebalance() directly, we return empty results.
        // The manager is now responsible for calling performSafeRebalance() 
        // immediately after this method returns.
        return { 
            ordersToPlace: [], 
            ordersToRotate: [], 
            ordersToUpdate: [], 
            ordersToCancel: [], 
            stateUpdates: [], 
            hadRotation: false 
        };
    }
}

module.exports = StrategyEngine;
