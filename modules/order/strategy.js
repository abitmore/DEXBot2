/**
 * modules/order/strategy.js
 *
 * Simple & Robust Pivot Strategy (Boundary-Crawl Version)
 * Maintains contiguous physical rails using a master boundary anchor.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, FEE_PARAMETERS } = require("../constants");
const {
    getPrecisionForSide,
    getAssetFees,
    allocateFundsByWeights,
    floatToBlockchainInt,
    blockchainToFloat,
    calculateSpreadFromOrders,
    countOrdersByType,
    shouldFlagOutOfSpread
} = require("./utils");
const Format = require('./format');

class StrategyEngine {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Calculate the spread gap size (number of empty slots between BUY and SELL zones).
     * Used during boundary initialization and role assignment.
     */
    calculateGapSlots(incrementPercent, targetSpreadPercent) {
        const safeIncrement = incrementPercent || 0.5;
        const step = 1 + (safeIncrement / 100);
        const minSpreadPercent = safeIncrement * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2);
        const effectiveTargetSpread = Math.max(targetSpreadPercent || 0, minSpreadPercent);
        const requiredSteps = Math.ceil(Math.log(1 + (effectiveTargetSpread / 100)) / Math.log(step));
        return Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps);
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

        const stateUpdates = [];

        // Sort all grid slots by price (Master Rail order)
        const allSlots = Array.from(mgr.orders.values())
            .filter(o => o.price != null)
            .sort((a, b) => a.price - b.price);

        if (allSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };

        // Calculate gap slots once for use throughout the rebalance
        const gapSlots = this.calculateGapSlots(mgr.config.incrementPercent, mgr.config.targetSpreadPercent);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 0: SPREAD CONDITION CHECK (Pre-rebalance)
        // ════════════════════════════════════════════════════════════════════════════════
        // Determine if spread is too wide before rebalancing. This affects targetCount
        // in rebalanceSideRobust, allowing an extra slot to narrow the spread.
        // CRITICAL: Only perform this check if NOT processing a fill. Fills naturally 
        // widen the spread; we should let the replacement rotation close the gap
        // using base spreadSlots first. (Fix: Issue #17)
        if (fills.length === 0) {
            const currentSpread = mgr.calculateCurrentSpread();
            const baseTarget = mgr.config.targetSpreadPercent + (mgr.config.incrementPercent * GRID_LIMITS.SPREAD_WIDENING_MULTIPLIER);
            const doubledSideCount = (mgr.buySideIsDoubled ? 1 : 0) + (mgr.sellSideIsDoubled ? 1 : 0);
            const targetSpread = baseTarget + (doubledSideCount * mgr.config.incrementPercent);
            const buyCount = countOrdersByType(ORDER_TYPES.BUY, mgr.orders);
            const sellCount = countOrdersByType(ORDER_TYPES.SELL, mgr.orders);
            mgr.outOfSpread = shouldFlagOutOfSpread(currentSpread, targetSpread, buyCount, sellCount);

            if (mgr.outOfSpread) {
                mgr.logger.log(`[STRATEGY] Spread too wide (${currentSpread.toFixed(2)}% > ${targetSpread.toFixed(2)}%). Extra orderslot enabled for this cycle.`, "info");
            }
        } else {
            mgr.outOfSpread = false;
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 1: BOUNDARY DETERMINATION (Initial or Recovery)
        // ════════════════════════════════════════════════════════════════════════════════
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
                 mgr.logger.log(`[BOUNDARY] Recovered boundaryIdx ${mgr.boundaryIdx} from market-closest BUY order (distance=${Format.formatAmount8(bestBuyDistance)} from startPrice).`, "info");
            } else {
                // 2. Fallback to startPrice-based initialization (Initial or Recovery)
                mgr.logger.log(`[BOUNDARY] Initializing boundaryIdx from startPrice: ${referencePrice}`, "info");

                // Find the first slot at or above startPrice (this becomes the spread zone)
                let splitIdx = allSlots.findIndex(s => s.price >= referencePrice);
                if (splitIdx === -1) splitIdx = allSlots.length;

                // Position boundary so spread gap is centered around startPrice
                const buySpread = Math.floor(gapSlots / 2);
                mgr.boundaryIdx = splitIdx - buySpread - 1;
            }
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 2: BOUNDARY SHIFT (Based on Fills)
        // ════════════════════════════════════════════════════════════════════════════════
        // The boundary shifts incrementally as orders fill:
        // - BUY fill: Market moved down → shift boundary LEFT (boundaryIdx--)
        // - SELL fill: Market moved up → shift boundary RIGHT (boundaryIdx++)
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

        // Clamp boundary to valid range
        mgr.boundaryIdx = Math.max(0, Math.min(allSlots.length - 1, mgr.boundaryIdx));
        const boundaryIdx = mgr.boundaryIdx;

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 3: ROLE ASSIGNMENT (BUY / SPREAD / SELL)
        // ════════════════════════════════════════════════════════════════════════════════
        // Assign each slot to a role based on its position relative to the boundary:
        // [0 ... boundaryIdx] = BUY zone
        // [boundaryIdx+1 ... boundaryIdx+gapSlots] = SPREAD zone (empty buffer)
        // [boundaryIdx+gapSlots+1 ... N] = SELL zone

        const buyEndIdx = boundaryIdx;
        const sellStartIdx = boundaryIdx + gapSlots + 1;

        // Partition slots into role-based arrays
        const buySlots = allSlots.slice(0, buyEndIdx + 1);
        const sellSlots = allSlots.slice(sellStartIdx);
        const spreadSlots = allSlots.slice(buyEndIdx + 1, sellStartIdx);

        // Update slot types (triggers state transitions if role changed)
        buySlots.forEach(s => { if (s.type !== ORDER_TYPES.BUY) stateUpdates.push({ ...s, type: ORDER_TYPES.BUY }); });
        sellSlots.forEach(s => { if (s.type !== ORDER_TYPES.SELL) stateUpdates.push({ ...s, type: ORDER_TYPES.SELL }); });
        spreadSlots.forEach(s => {
            // Only convert to SPREAD if it doesn't have an active on-chain order!
            // FIX: Check state (ACTIVE/PARTIAL means on-chain order exists) rather than just orderId
            // This prevents converting slots that have real orders to SPREAD prematurely
            const hasOnChainOrder = s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL);
            if (s.type !== ORDER_TYPES.SPREAD && !hasOnChainOrder) {
                stateUpdates.push({ ...s, type: ORDER_TYPES.SPREAD, size: 0, orderId: null });
            }
        });

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 4: BUDGET CALCULATION (Total Capital with BTS Fee Deduction)
        // ════════════════════════════════════════════════════════════════════════════════
        // Total Side Budget = (ChainFree + Committed) - BTS_Fees (if asset is BTS)
        // Available = funds.available (already includes fill proceeds via chainFree)

        const Grid = require('./grid');
        const buyCtx = Grid._getSizingContext(mgr, 'buy');
        const sellCtx = Grid._getSizingContext(mgr, 'sell');

        if (!buyCtx || !sellCtx) {
            mgr.logger.log("[BUDGET] Failed to retrieve unified sizing context. Aborting rebalance.", "error");
            return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };
        }

        const budgetBuy = buyCtx.budget;
        const budgetSell = sellCtx.budget;

        // Ensure funds are calculated with current allocations (respects botFunds %)
        if (mgr.applyBotFundsAllocation) mgr.applyBotFundsAllocation();

        // Available funds for net capital increases (e.g., placing new orders)
        // This unified metric already accounts for reservations, fees, and in-flight capital.
        const availBuy = (mgr.funds?.available?.buy ?? mgr.accountTotals?.buyFree ?? 0);
        const availSell = (mgr.funds?.available?.sell ?? mgr.accountTotals?.sellFree ?? 0);

        if (mgr.logger.level === 'debug') {
            mgr.logger.log(`[BUDGET] Unified Sizing: Buy=${Format.formatAmount8(budgetBuy)}, Sell=${Format.formatAmount8(budgetSell)} (Respects botFunds % and Fees)`, 'debug');
        }

        // Reaction Cap: Limit how many orders we rotate/place per cycle.
        // NOTE: Only count FULL fills - partial fills don't spend capital, so they shouldn't count toward budget.
        // NEW: Handle double replacement triggers by increasing reaction cap.
        let reactionCapBuy = 0;
        let reactionCapSell = 0;

        for (const fill of fills) {
            // isDoubleReplacementTrigger is only set for full fills in sync_engine
            if (fill.isPartial && !fill.isDelayedRotationTrigger && !fill.isDoubleReplacementTrigger) continue;
            
            const count = fill.isDoubleReplacementTrigger ? 2 : 1;
            // A SELL fill triggers a BUY replacement
            if (fill.type === ORDER_TYPES.SELL) reactionCapBuy += count;
            else reactionCapSell += count;
        }

        // Always allow at least 1 action per side if processing any fill
        // CRITICAL: In boundary-crawl, both sides MUST crawl whenever the boundary shifts.
        // Restricting one side causes it to fall out of the target window.
        if (fills.length > 0) {
            reactionCapBuy = Math.max(reactionCapBuy, 1);
            reactionCapSell = Math.max(reactionCapSell, 1);
        } else {
            // Periodic rebalance (no fills) - allow 1 action per side
            reactionCapBuy = 1;
            reactionCapSell = 1;
        }
 
        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: SIDE REBALANCING (Independent Buy and Sell)
        // ════════════════════════════════════════════════════════════════════════════════
 
        const buyResult = await this.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, -1, budgetBuy, availBuy, excludeIds, reactionCapBuy, fills);
        const sellResult = await this.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, 1, budgetSell, availSell, excludeIds, reactionCapSell, fills);

        // Apply all state updates to manager with batched fund recalculation
        mgr.pauseFundRecalc();
        const allUpdates = [...stateUpdates, ...buyResult.stateUpdates, ...sellResult.stateUpdates];
        allUpdates.forEach(upd => {
            mgr._updateOrder(upd);
        });

        // Deduct cacheFunds AFTER state updates are applied (atomic with state transitions)
        // CRITICAL: Only deduct from cacheFunds for the side that USES the fill proceeds
        // - proceeds from SELL fills populate cacheFunds.buy → used for BUY placements
        // - proceeds from BUY fills populate cacheFunds.sell → used for SELL placements

        // BUY placements: Deduct from cacheFunds.buy
        if (buyResult.totalNewPlacementSize > 0) {
            await mgr.modifyCacheFunds('buy', -buyResult.totalNewPlacementSize, 'new-placements');
        }
        // SELL placements: Deduct from cacheFunds.sell
        if (sellResult.totalNewPlacementSize > 0) {
            await mgr.modifyCacheFunds('sell', -sellResult.totalNewPlacementSize, 'new-placements');
        }

        mgr.recalculateFunds();
        mgr.resumeFundRecalc();

        // Combine results from both sides
        const result = {
            ordersToPlace: [...buyResult.ordersToPlace, ...sellResult.ordersToPlace],
            ordersToRotate: [...buyResult.ordersToRotate, ...sellResult.ordersToRotate],
            ordersToUpdate: [...buyResult.ordersToUpdate, ...sellResult.ordersToUpdate],
            ordersToCancel: [...buyResult.ordersToCancel, ...sellResult.ordersToCancel],
            stateUpdates: allUpdates,
            hadRotation: (buyResult.ordersToRotate.length > 0 || sellResult.ordersToRotate.length > 0)
        };

        mgr.logger.log(`[BOUNDARY] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate. Gap size: ${gapSlots} slots.`, "info");

        // Reset outOfSpread flag after rebalance completes
        mgr.outOfSpread = false;

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
    async rebalanceSideRobust(type, allSlots, sideSlots, direction, totalSideBudget, availSide, excludeIds, reactionCap, fills = []) {
        if (sideSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };

        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
        const stateUpdates = [];
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToCancel = [];
        const ordersToUpdate = [];

        const targetCount = (mgr.config.activeOrders && Number.isFinite(mgr.config.activeOrders[side])) ? Math.max(1, mgr.config.activeOrders[side]) : sideSlots.length;
        
        // Consider an extra order slot when out of spread
        const finalTargetCount = mgr.outOfSpread ? targetCount + 1 : targetCount;

        // ════════════════════════════════════════════════════════════════════════════════
        // BUILD SLOT INDEX MAP FOR O(1) LOOKUPS (FIX: O(n²) → O(n) complexity)
        // ════════════════════════════════════════════════════════════════════════════════
        const slotIndexMap = new Map();
        for (let idx = 0; idx < allSlots.length; idx++) {
            slotIndexMap.set(allSlots[idx].id, idx);
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 1: CALCULATE IDEAL STATE
        // ════════════════════════════════════════════════════════════════════════════════
        const sortedSideSlots = [...sideSlots].sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);
        const targetIndices = [];
        for (let i = 0; i < Math.min(finalTargetCount, sortedSideSlots.length); i++) {
            const idx = slotIndexMap.get(sortedSideSlots[i].id);
            if (idx !== undefined) targetIndices.push(idx);
        }
        const targetSet = new Set(targetIndices);
        const sideWeight = mgr.config.weightDistribution[side];
        const precision = getPrecisionForSide(mgr.assets, side);

        // NOTE: BTS fees are already deducted from totalSideBudget in rebalance().
        // Do NOT subtract them again here - that was causing double fee deduction.

        // CRITICAL: Sort order differs between sides:
        // - BUY (line 295): descending (b.price - a.price) = highest first = EDGE to MARKET (reversed)
        // - SELL (line 295): ascending (a.price - b.price) = lowest first = MARKET to EDGE (normal)
        // Use reverse=true for BUY to flip weight distribution so market (index n-1) gets max weight.
        // Use reverse=false for SELL so market (index 0) gets max weight.
        const reverse = (type === ORDER_TYPES.BUY);
        const sideIdealSizes = allocateFundsByWeights(totalSideBudget, sideSlots.length, sideWeight, mgr.config.incrementPercent / 100, reverse, 0, precision);

        const finalIdealSizes = new Array(allSlots.length).fill(0);
        sideSlots.forEach((slot, i) => {
            const size = blockchainToFloat(floatToBlockchainInt(sideIdealSizes[i] || 0, precision), precision);
            const slotIdx = slotIndexMap.get(slot.id);
            if (slotIdx !== undefined) finalIdealSizes[slotIdx] = size;
        });

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 2: IDENTIFY SHORTAGES AND SURPLUSES
        // ════════════════════════════════════════════════════════════════════════════════
         const activeOnChain = allSlots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !(excludeIds.has(s.id) || (s.orderId && excludeIds.has(s.orderId))));
        const activeThisSide = activeOnChain.filter(s => s.type === type);

         const shortages = targetIndices.filter(idx => {
             const slot = allSlots[idx];
             if (excludeIds.has(slot.id) || (slot.orderId && excludeIds.has(slot.orderId))) return false;
            if (!slot.orderId && finalIdealSizes[idx] > 0) return true;

            // Dust detection: Treat slot as shortage if it has a dust order
            // This allows the strategy to "refill" it (either by rotation or update)
            if (slot.orderId && finalIdealSizes[idx] > 0) {
                const threshold = finalIdealSizes[idx] * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
                if (slot.size < threshold) return true;
            }
            return false;
        });

        // SURPLUSES include TWO categories:
        // 1. Hard Surpluses: Orders outside the target window (need to be cancelled or rotated)
        // 2. Dust Surpluses: Orders inside window but with dust-sized positions (need to be updated or rotated)
        // NOTE: After STEP 2.5, PARTIAL orders in-window are handled separately and filtered out
        // so they don't get rotated away. See filteredSurpluses below.
        const surpluses = activeThisSide.filter(s => {
            const idx = slotIndexMap.get(s.id);
            if (idx === undefined) return false;
            // Hard Surplus: Outside window
            if (!targetSet.has(idx)) return true;

            // Dust Surplus: Inside window but dust (needs to be moved/updated)
            const idealSize = finalIdealSizes[idx];
            const threshold = idealSize * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
            if (s.size < threshold) return true;

            return false;
        });
        
        // Prioritize PARTIAL orders for rotation, then sort by distance (furthest first)
        // Prioritize PARTIAL orders for rotation, then sort by distance (INNER FIRST)
        // This ensures OUTER surpluses are left over for cancellation
        surpluses.sort((a, b) => {
            if (a.state === ORDER_STATES.PARTIAL && b.state !== ORDER_STATES.PARTIAL) return -1;
            if (a.state !== ORDER_STATES.PARTIAL && b.state === ORDER_STATES.PARTIAL) return 1;
            // Market-Closest first (Inner-to-Edge)
            return type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price;
        });

        let budgetRemaining = reactionCap;

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 2.5: PARTIAL ORDER HANDLING (Update In-Place Before Rotations/Placements)
        // ════════════════════════════════════════════════════════════════════════════════
        // Handle PARTIAL orders in target window before rotations/placements to prevent grid gaps.
        // - Dust partial: Update to full target size
        // - Non-dust partial: Update to ideal size for proper grid alignment
        // These are then filtered from surpluses to prevent unwanted rotation.
        const handledPartialIds = new Set();
        const partialOrdersInWindow = allSlots.filter(s =>
            s.type === type &&
            s.state === ORDER_STATES.PARTIAL &&
            targetSet.has(slotIndexMap.get(s.id)) &&
            !(excludeIds.has(s.id) || (s.orderId && excludeIds.has(s.orderId)))
        );

        let remainingAvail = availSide;
        let totalNewPlacementSize = 0;

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

            const threshold = idealSize * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
            const isDust = partial.size < threshold;

            if (isDust) {
                // Dust partial: Set side doubled flag and update to ideal size
                // CRITICAL: Cap increase to respect available funds
                const currentSize = partial.size || 0;
                const sizeIncrease = Math.max(0, idealSize - currentSize);
                const cappedIncrease = Math.min(sizeIncrease, remainingAvail);
                const finalSize = currentSize + cappedIncrease;

                if (finalSize > 0) {
                    mgr.logger.log(`[PARTIAL] Dust partial at ${partial.id} (size=${Format.formatAmount8(partial.size)}, target=${Format.formatAmount8(idealSize)}). Updating to ${Format.formatAmount8(finalSize)} and flagging side as doubled.`, 'info');
                    
                    if (type === ORDER_TYPES.BUY) mgr.buySideIsDoubled = true;
                    else mgr.sellSideIsDoubled = true;

                    ordersToUpdate.push({ partialOrder: { ...partial }, newSize: finalSize });
                    stateUpdates.push({ ...partial, size: finalSize, state: ORDER_STATES.ACTIVE });
                    
                    totalNewPlacementSize += cappedIncrease;
                    remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                    handledPartialIds.add(partial.id);
                    budgetRemaining--;
                }
            } else {
                // Non-dust partial: Update to ideal size and place new order with old partial size
                const oldSize = partial.size;

                // Place new order with old partial size at next available slot
                const nextSlotIdx = partialIdx + (type === ORDER_TYPES.BUY ? -1 : 1);

                // FIX: Validate nextSlot BEFORE committing to the operation (Issue #2 + capital leak fix)
                if (nextSlotIdx < 0 || nextSlotIdx >= allSlots.length) {
                    mgr.logger.log(`[PARTIAL] Skipping non-dust partial at ${partial.id}: no adjacent slot available (idx=${nextSlotIdx} out of bounds)`, "warn");
                    continue;
                }

                const nextSlot = allSlots[nextSlotIdx];
                const currentNextSlot = mgr.orders.get(nextSlot.id);
                if (!currentNextSlot || currentNextSlot.orderId || currentNextSlot.state !== ORDER_STATES.VIRTUAL) {
                    mgr.logger.log(`[PARTIAL] Skipping non-dust partial at ${partial.id}: target slot ${nextSlot.id} not available (state=${currentNextSlot?.state}, orderId=${currentNextSlot?.orderId})`, "warn");
                    continue;
                }

                // CRITICAL: Update increase must be capped by available funds
                const sizeIncrease = Math.max(0, idealSize - oldSize);
                const cappedIncrease = Math.min(sizeIncrease, remainingAvail);
                const finalSize = oldSize + cappedIncrease;

                if (finalSize > 0) {
                    mgr.logger.log(`[PARTIAL] Non-dust partial at ${partial.id} (size=${Format.formatAmount8(oldSize)}, target=${Format.formatAmount8(idealSize)}). Updating to ${Format.formatAmount8(finalSize)} and placing split order.`, 'info');
                    ordersToUpdate.push({ partialOrder: { ...partial }, newSize: finalSize });
                    stateUpdates.push({ ...partial, size: finalSize, state: ORDER_STATES.ACTIVE });

                    ordersToPlace.push({ ...nextSlot, type: type, size: oldSize, state: ORDER_STATES.ACTIVE });
                    stateUpdates.push({ ...nextSlot, type: type, size: oldSize, state: ORDER_STATES.ACTIVE });

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

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 4: ROTATIONS (Refill Inner Gaps)
        // ════════════════════════════════════════════════════════════════════════════════
        // Move furthest active orders to fill inner gaps (closest to market).
        // Note: shortages is derived from sortedSideSlots, so it is already sorted Closest First.
        // FIX: Use separate indices to prevent skipping shortages when surplus is invalid
        let surplusIdx = 0;
        let shortageIdx = 0;
        let rotationsPerformed = 0;

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
                (surplus.orderId && currentSurplus.orderId !== surplus.orderId)) {
                mgr.logger.log(`[ROTATION] Skipping surplus ${surplus.id}: no longer valid`, "warn");
                surplusIdx++;
                continue;
            }

            // CRITICAL: Rotations that INCREASE size must be capped by available funds
            // NOTE: Use DESTINATION slot size (shortageSlot), not source order size (currentSurplus)
            // This ensures we cap the FULL grid difference (grid impact), not just the blockchain update
            const destinationSize = shortageSlot.size || 0;
            const gridDifference = Math.max(0, idealSize - destinationSize);
            const cappedIncrease = Math.min(gridDifference, remainingAvail);
            const finalSize = destinationSize + cappedIncrease;

            if (finalSize > 0) {
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
                // sync_engine will see it's already VIRTUAL and just clear the orderId if needed
                stateUpdates.push({ ...currentSurplus, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null });

                // New rotated order must stay VIRTUAL until blockchain confirms (synchronizeWithChain will activate it)
                stateUpdates.push({ ...shortageSlot, type: type, size: finalSize, state: ORDER_STATES.VIRTUAL, orderId: null });

                mgr.logger.log(`[ROTATION] Atomic rotation: ${currentSurplus.id} (${Format.formatAmount8(currentSurplus.size)}) → ${shortageSlot.id} (${Format.formatAmount8(finalSize)})`, 'debug');

                totalNewPlacementSize += cappedIncrease;
                remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                surplusIdx++;
                shortageIdx++;
                rotationsPerformed++;
                budgetRemaining--;
            } else {
                // Should not happen if idealSize > 0 or destinationSize > 0
                surplusIdx++;
                continue;
            }
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: PLACEMENTS (Activate Outer Edges)
        // ════════════════════════════════════════════════════════════════════════════════
        // Use remaining budget to place new orders at the edge of the grid window.
        // CRITICAL: Cap placement sizes to respect available funds.
        if (budgetRemaining > 0) {
            const outerShortages = filteredShortages.slice(shortageIdx).reverse();
            const placeCount = Math.min(outerShortages.length, budgetRemaining);

            for (let i = 0; i < placeCount; i++) {
                const idx = outerShortages[i];
                const slot = allSlots[idx];
                const idealSize = finalIdealSizes[idx];

                if (!slot || !slot.id || !slot.price) continue;
                if (idealSize <= 0) continue;

                const currentSize = slot.size || 0;
                const sizeIncrease = Math.max(0, idealSize - currentSize);

                if (sizeIncrease > 0) {
                    const remainingOrders = placeCount - i;
                    const cappedIncrease = Math.min(sizeIncrease, remainingAvail / remainingOrders);
                    const finalSize = currentSize + cappedIncrease;

                    if (finalSize > 0) {
                        ordersToPlace.push({ ...slot, type: type, size: finalSize, state: ORDER_STATES.ACTIVE });
                        stateUpdates.push({ ...slot, type: type, size: finalSize, state: ORDER_STATES.ACTIVE });
                        totalNewPlacementSize += cappedIncrease;
                        remainingAvail = Math.max(0, remainingAvail - cappedIncrease);
                        budgetRemaining--;
                    }
                } else if (idealSize > 0) {
                    ordersToPlace.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
                    stateUpdates.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
                    budgetRemaining--;
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: CANCEL REMAINING SURPLUSES
        // ════════════════════════════════════════════════════════════════════════════════
        // Cancel surpluses from the outside in (lowest buy/highest sell first)
        const rotatedOldIds = new Set(ordersToRotate.map(r => r.oldOrder.id));
        for (let i = filteredSurpluses.length - 1; i >= 0; i--) {
            const surplus = filteredSurpluses[i];
            if (!rotatedOldIds.has(surplus.id)) {
                ordersToCancel.push({ ...surplus });
                stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL, orderId: null });
            }
        }
        // Handled partials are NOT cancelled - they're updated in-place (STEP 2.5)

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 6: DEFER CACHEFUNDS DEDUCTION (Track Surplus Allocation)
        // ════════════════════════════════════════════════════════════════════════════════
        // CacheFunds deduction is DEFERRED until after state updates are applied.
        // This ensures fund invariants are maintained atomically with state transitions.
        // Return totalNewPlacementSize so rebalance() can apply deduction after state updates.

        return { ordersToPlace, ordersToRotate, ordersToUpdate, ordersToCancel, stateUpdates, totalNewPlacementSize };
    }

    /**
     * Checks if any of the provided partial orders are below the dust threshold.
     * @param {Array<Object>} partials - Array of partial orders.
     * @param {string} side - 'buy' or 'sell'.
     * @returns {boolean} True if any dust partials are found.
     */
    hasAnyDust(partials, side) {
        const mgr = this.manager;
        const Grid = require('./grid');
        const type = side === "buy" ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        
        // 1. Get centralized sizing context (respects botFunds % allocation and fees)
        const ctx = Grid._getSizingContext(mgr, side);
        if (!ctx || ctx.budget <= 0) return false;

        const allOrders = Array.from(mgr.orders.values());
        
        // 2. Slots must be sorted Market-to-Edge to match geometric weight distribution
        const slots = allOrders.filter(o => o.type === type)
            .sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        if (slots.length === 0) return false;

        // 3. Calculate geometric ideals for the ENTIRE side (all slots)
        // This ensures the dust threshold matches the exact target size for each slot.
        const idealSizes = allocateFundsByWeights(
            ctx.budget, 
            slots.length, 
            mgr.config.weightDistribution[side], 
            mgr.config.incrementPercent / 100, 
            type === ORDER_TYPES.BUY, 
            0, 
            ctx.precision
        );

        return partials.some(p => {
            const idx = slots.findIndex(s => s.id === p.id);
            if (idx === -1) return false;
            const dustThreshold = idealSizes[idx] * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
            return p.size < dustThreshold;
        });
    }

    /**
     * Process multiple filled orders and trigger rebalancing.
     * @param {Array<Object>} filledOrders - Array of filled order objects.
     * @param {Set<string>} [excludeOrderIds=new Set()] - IDs to exclude from processing.
     * @param {Object} [options={}] - Processing options.
     * @param {boolean} [options.skipAccountTotalsUpdate=false] - If true, do not update manager.accountTotals (used during startup sync).
     * @returns {Promise<Object|void>} Rebalance result or void if no rebalance triggered.
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set(), options = {}) {
        const mgr = this.manager;
        if (!mgr || !Array.isArray(filledOrders)) return;

        const skipAccountTotals = options.skipAccountTotalsUpdate === true;
        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders${skipAccountTotals ? ' (skipping accountTotals update)' : ''}`, "info");
        mgr.pauseFundRecalc();

        try {
            const hasBtsPair = (mgr.config?.assetA === "BTS" || mgr.config?.assetB === "BTS");

            let fillsToSettle = 0;
            let makerFillCount = 0;
            let takerFillCount = 0;

            for (const filledOrder of filledOrders) {
                if (excludeOrderIds?.has?.(filledOrder.id)) continue;

                const isPartial = filledOrder.isPartial === true;
                if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                    fillsToSettle++;
                    // Track maker vs taker fills for accurate blockchain fee calculation
                    if (filledOrder.isMaker !== false) {
                        makerFillCount++;
                    } else {
                        takerFillCount++;
                    }

                    // CRITICAL FIX: Only update slot to VIRTUAL if it hasn't been reused!
                    // In sequential processing, a previous fill's rebalance might have rotated 
                    // a new order into this slot (treated as empty because it was about to fill).
                    const currentSlot = mgr.orders.get(filledOrder.id);
                    const slotReused = currentSlot && currentSlot.orderId && currentSlot.orderId !== filledOrder.orderId;

                    if (!slotReused) {
                        mgr._updateOrder({ ...filledOrder, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null });
                    } else {
                        mgr.logger.log(`[RACE] Slot ${filledOrder.id} reused (curr=${currentSlot.orderId} != fill=${filledOrder.orderId}). Skipping VIRTUAL update.`, 'info');
                    }
                }

                let rawProceeds = 0;
                let assetForFee = null;
                if (filledOrder.type === ORDER_TYPES.SELL) {
                    rawProceeds = filledOrder.size * filledOrder.price;
                    assetForFee = mgr.config.assetB;
                } else {
                    rawProceeds = filledOrder.size / filledOrder.price;
                    assetForFee = mgr.config.assetA;
                }

                let netProceeds = rawProceeds;
                if (assetForFee !== "BTS") {
                    try {
                        // Pass isMaker flag to apply correct fee (market fee for makers, taker fee for takers)
                        const isMaker = filledOrder.isMaker !== false;  // Default to maker if not specified
                        const feeInfo = getAssetFees(assetForFee, rawProceeds, isMaker);
                        netProceeds = (typeof feeInfo === 'object') ? feeInfo.total : feeInfo; // Handle both object and number returns
                        const feeType = isMaker ? 'market' : 'taker';
                        mgr.logger.log(`[FILL-FEE] ${filledOrder.type} fill: applied ${feeType} fee for ${assetForFee}`, 'debug');
                    } catch (e) {
                        // FIX: Consolidated fee calculation failure logging (Issue #8)
                        mgr.logger.log(
                            `[FILL-FEE-ERROR] ${filledOrder.type} fill ${filledOrder.id}: fee calc failed for ${assetForFee} (${e.message}). ` +
                            `Using raw proceeds=${Format.formatAmount8(rawProceeds)} - manual verification recommended.`,
                            "warn"
                        );
                    }
                }

                 mgr.logger.log(`[FILL] ${filledOrder.type} fill: size=${filledOrder.size}, price=${filledOrder.price}, proceeds=${Format.formatAmount8(netProceeds)} ${assetForFee}`, "debug");

                // SELL fills → proceeds go to buy side; BUY fills → proceeds go to sell side
                const isSell = filledOrder.type === ORDER_TYPES.SELL;
                const receiveSide = isSell ? 'buy' : 'sell';
                const spendSide = isSell ? 'sell' : 'buy';
                const receiveType = isSell ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;

                await mgr.modifyCacheFunds(receiveSide, netProceeds, 'fill-proceeds');

                // Record the physical arrival of proceeds and the physical departure of the filled asset.
                // This updates both 'free' and 'total' balances to maintain account invariants.
                mgr.accountant.adjustTotalBalance(receiveType, netProceeds, 'fill-proceeds');
                mgr.accountant.adjustTotalBalance(filledOrder.type, -filledOrder.size, 'fill-consumption');
            }

            if (hasBtsPair && fillsToSettle > 0) {
                // Apply correct blockchain fees based on maker vs taker fills
                // Maker fills: get 90% refund (pay makerNetFee = 10% of creation fee)
                // Taker fills: no refund (pay full creation fee)
                const btsFeeDataMaker = getAssetFees("BTS", 0, true);
                const btsFeeDataTaker = getAssetFees("BTS", 0, false);
                const makerFeesOwed = makerFillCount * btsFeeDataMaker.netFee;
                const takerFeesOwed = takerFillCount * btsFeeDataTaker.netFee;
                mgr.funds.btsFeesOwed += makerFeesOwed + takerFeesOwed;
                if (makerFillCount > 0 || takerFillCount > 0) {
                    mgr.logger.log(
                        `[FEES] BTS fees calculated: ${makerFillCount} maker fills @ ${Format.formatAmount8(btsFeeDataMaker.netFee)} BTS = ${Format.formatAmount8(makerFeesOwed)} BTS, ` +
                        `${takerFillCount} taker fills @ ${Format.formatAmount8(btsFeeDataTaker.netFee)} BTS = ${Format.formatAmount8(takerFeesOwed)} BTS (total owed: ${Format.formatAmount8(mgr.funds.btsFeesOwed)} BTS)`,
                        'info'
                    );
                }
                await mgr.accountant.deductBtsFees();
            }

            mgr.recalculateFunds();
            await mgr.persistGrid();

            let shouldRebalance = (fillsToSettle > 0);

            if (!shouldRebalance) {
                const allOrders = Array.from(mgr.orders.values());
                const buyPartials = allOrders.filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL);
                const sellPartials = allOrders.filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL);

                if (buyPartials.length > 0 || sellPartials.length > 0) {
                    const buyHasDust = buyPartials.length > 0 && this.hasAnyDust(buyPartials, "buy");
                    const sellHasDust = sellPartials.length > 0 && this.hasAnyDust(sellPartials, "sell");

                    if (buyHasDust && sellHasDust) {
                        mgr.logger.log("[BOUNDARY] Dual-side dust partials detected. Triggering rebalance.", "info");
                        shouldRebalance = true;
                    }
                }
            }

            if (!shouldRebalance) {
                mgr.logger.log("[BOUNDARY] Skipping rebalance: No full fills and no dual-side dust partials.", "info");
                return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };
            }

            // Log detailed fund state before entering rebalance
            if (mgr.logger.level === 'debug') {
                 mgr.logger.log(`[PRE-REBALANCE] Available: buy=${Format.formatMetric5(mgr.funds.available.buy)}, sell=${Format.formatMetric5(mgr.funds.available.sell)}`, 'debug');
                 mgr.logger.log(`[PRE-REBALANCE] CacheFunds: buy=${Format.formatMetric5(mgr.funds.cacheFunds.buy)}, sell=${Format.formatMetric5(mgr.funds.cacheFunds.sell)}`, 'debug');
                 mgr.logger.log(`[PRE-REBALANCE] ChainFree: buy=${Format.formatMetric5(mgr.accountTotals.buyFree)}, sell=${Format.formatMetric5(mgr.accountTotals.sellFree)}`, 'debug');
            }

            const result = await this.rebalance(filledOrders, excludeOrderIds);

            if (hasBtsPair && (result.ordersToRotate.length > 0 || result.ordersToUpdate.length > 0)) {
                const btsFeeData = getAssetFees("BTS", 0);
                const updateCount = result.ordersToRotate.length + result.ordersToUpdate.length;
                mgr.funds.btsFeesOwed += updateCount * btsFeeData.updateFee;
            }

            mgr.recalculateFunds();
            return result;
        } finally {
            mgr.resumeFundRecalc();
        }
    }

    /**
     * Callback when a rotation transaction completes successfully.
     * @param {Object} oldInfo - The old order information.
     */
    completeOrderRotation(oldInfo) {
        if (this.manager.logger.level === 'debug') {
            this.manager.logger.log(`[STRATEGY] Rotation completed for ${oldInfo.id || 'unknown'}`, 'debug');
        }
        // No specific state change needed here as rebalance() already handles
        // the atomic transition to VIRTUAL/ACTIVE.
    }

}

module.exports = StrategyEngine;