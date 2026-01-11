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
    blockchainToFloat
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
     * Calculate BTS fee reservations for BUY and SELL sides (if asset is BTS).
     * Returns object with btsFeeReservationBuy and btsFeeReservationSell.
     */
    calculateBtsFeeReservations(hasBtsPair, config) {
        let btsFeeReservationBuy = 0;
        let btsFeeReservationSell = 0;

        if (hasBtsPair && config.activeOrders) {
            const targetBuy = Math.max(0, config.activeOrders.buy || 0);
            const targetSell = Math.max(0, config.activeOrders.sell || 0);
            const totalTargetOrders = targetBuy + targetSell;

            if (totalTargetOrders > 0) {
                const btsFeeData = getAssetFees('BTS', 1);
                const totalBtsReservation = btsFeeData.createFee * totalTargetOrders * FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;

                if (config.assetB === "BTS") {
                    btsFeeReservationBuy = totalBtsReservation;
                } else if (config.assetA === "BTS") {
                    btsFeeReservationSell = totalBtsReservation;
                }
            }
        }

        return { btsFeeReservationBuy, btsFeeReservationSell };
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
        // Available Pool = funds.available + cacheFunds

        const snap = mgr.getChainFundsSnapshot();
        const hasBtsPair = (mgr.config.assetA === "BTS" || mgr.config.assetB === "BTS");
        const { btsFeeReservationBuy, btsFeeReservationSell } = this.calculateBtsFeeReservations(hasBtsPair, mgr.config);

        // Total Side Budget: (Free + Committed) with BTS fees deducted
        const budgetBuy = Math.max(0, (snap.chainFreeBuy || 0) + (snap.committedChainBuy || 0) - btsFeeReservationBuy);
        const budgetSell = Math.max(0, (snap.chainFreeSell || 0) + (snap.committedChainSell || 0) - btsFeeReservationSell);

        // Available Pool: Liquid funds for net capital increases
        // funds.available already has BTS fees and other reserves subtracted
        const availablePoolBuy = (mgr.funds.available?.buy || 0) + (mgr.funds.cacheFunds?.buy || 0);
        const availablePoolSell = (mgr.funds.available?.sell || 0) + (mgr.funds.cacheFunds?.sell || 0);

        if (mgr.logger.level === 'debug') {
            mgr.logger.log(`[BUDGET] Buy: total=${Format.formatAmount8(budgetBuy)}, available=${Format.formatAmount8(availablePoolBuy)}, btsFeeReserved=${Format.formatAmount8(btsFeeReservationBuy)}`, 'debug');
            mgr.logger.log(`[BUDGET] Sell: total=${Format.formatAmount8(budgetSell)}, available=${Format.formatAmount8(availablePoolSell)}, btsFeeReserved=${Format.formatAmount8(btsFeeReservationSell)}`, 'debug');
        }

        // Reaction Cap: Limit how many orders we rotate/place per cycle.
        // NOTE: Only count FULL fills - partial fills don't spend capital, so they shouldn't count toward budget.
        const fullFills = fills.filter(f => !f.isPartial).length;
        const reactionCap = Math.max(1, fullFills);
 
        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: SIDE REBALANCING (Independent Buy and Sell)
        // ════════════════════════════════════════════════════════════════════════════════
 
        const buyResult = await this.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, -1, budgetBuy, availablePoolBuy, excludeIds, reactionCap, fills);
        const sellResult = await this.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, 1, budgetSell, availablePoolSell, excludeIds, reactionCap, fills);

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
            const oldCache = mgr.funds.cacheFunds.buy || 0;
            mgr.funds.cacheFunds.buy = Math.max(0, oldCache - buyResult.totalNewPlacementSize);
             mgr.logger.log(`[CACHEFUNDS] buy: ${Format.formatAmount8(oldCache)} - ${Format.formatAmount8(buyResult.totalNewPlacementSize)} (new-placements) = ${Format.formatAmount8(mgr.funds.cacheFunds.buy)}`, 'debug');
        }
        // SELL placements: Deduct from cacheFunds.sell
        if (sellResult.totalNewPlacementSize > 0) {
            const oldCache = mgr.funds.cacheFunds.sell || 0;
            mgr.funds.cacheFunds.sell = Math.max(0, oldCache - sellResult.totalNewPlacementSize);
             mgr.logger.log(`[CACHEFUNDS] sell: ${Format.formatAmount8(oldCache)} - ${Format.formatAmount8(sellResult.totalNewPlacementSize)} (new-placements) = ${Format.formatAmount8(mgr.funds.cacheFunds.sell)}`, 'debug');
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
    async rebalanceSideRobust(type, allSlots, sideSlots, direction, totalSideBudget, availablePool, excludeIds, reactionCap, fills = []) {
        if (sideSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], hadRotation: false };

        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
        const stateUpdates = [];
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToCancel = [];
        const ordersToUpdate = [];

        const targetCount = (mgr.config.activeOrders && Number.isFinite(mgr.config.activeOrders[side])) ? Math.max(1, mgr.config.activeOrders[side]) : sideSlots.length;

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
        for (let i = 0; i < Math.min(targetCount, sortedSideSlots.length); i++) {
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
        surpluses.sort((a, b) => {
            if (a.state === ORDER_STATES.PARTIAL && b.state !== ORDER_STATES.PARTIAL) return -1;
            if (a.state !== ORDER_STATES.PARTIAL && b.state === ORDER_STATES.PARTIAL) return 1;
            return type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price;
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

        for (const partial of partialOrdersInWindow) {
            // FIX: Check budget BEFORE processing to respect reactionCap (Issue #4 enhancement)
            if (budgetRemaining <= 0) {
                mgr.logger.log(`[PARTIAL] Budget exhausted, deferring remaining ${partialOrdersInWindow.length - handledPartialIds.size} partial(s) to next cycle`, 'debug');
                break;
            }

            const partialIdx = slotIndexMap.get(partial.id);
            if (partialIdx === undefined) continue;
            const targetSize = finalIdealSizes[partialIdx];

            if (targetSize <= 0) {
                mgr.logger.log(`[PARTIAL] Slot ${partial.id} has no target size, skipping`, 'debug');
                continue;
            }

            const threshold = targetSize * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
            const isDust = partial.size < threshold;

            if (isDust) {
                // Dust partial: Consolidate by updating to ideal size + dust size
                const consolidatedSize = targetSize + partial.size;
                 mgr.logger.log(`[PARTIAL] Dust partial at ${partial.id} (size=${Format.formatAmount8(partial.size)}, target=${Format.formatAmount8(targetSize)}). Updating to merge: ${Format.formatAmount8(consolidatedSize)}.`, 'info');
                ordersToUpdate.push({ partialOrder: { ...partial }, newSize: consolidatedSize });
                stateUpdates.push({ ...partial, size: consolidatedSize, state: ORDER_STATES.ACTIVE });
                handledPartialIds.add(partial.id);
                budgetRemaining--;
            } else {
                // Non-dust partial: Update to ideal size and place new order with old partial size
                const oldSize = partial.size;

                // Place new order with old partial size at next available slot
                const nextSlotIdx = partialIdx + (type === ORDER_TYPES.BUY ? -1 : 1);

                // FIX: Validate nextSlot BEFORE committing to the operation (Issue #2 + capital leak fix)
                // If we can't place the split order, skip the entire operation to prevent capital leak
                if (nextSlotIdx < 0 || nextSlotIdx >= allSlots.length) {
                    mgr.logger.log(`[PARTIAL] Skipping non-dust partial at ${partial.id}: no adjacent slot available (idx=${nextSlotIdx} out of bounds)`, "warn");
                    continue;
                }

                const nextSlot = allSlots[nextSlotIdx];
                // Re-fetch current state from manager to avoid stale snapshot
                const currentNextSlot = mgr.orders.get(nextSlot.id);
                if (!currentNextSlot || currentNextSlot.orderId || currentNextSlot.state !== ORDER_STATES.VIRTUAL) {
                    mgr.logger.log(`[PARTIAL] Skipping non-dust partial at ${partial.id}: target slot ${nextSlot.id} not available (state=${currentNextSlot?.state}, orderId=${currentNextSlot?.orderId})`, "warn");
                    continue;
                }

                // Now safe to proceed with both operations atomically
                 mgr.logger.log(`[PARTIAL] Non-dust partial at ${partial.id} (size=${Format.formatAmount8(oldSize)}, target=${Format.formatAmount8(targetSize)}). Updating to rebalance and placing new order.`, 'info');
                ordersToUpdate.push({ partialOrder: { ...partial }, newSize: targetSize });
                stateUpdates.push({ ...partial, size: targetSize, state: ORDER_STATES.ACTIVE });

                ordersToPlace.push({ ...nextSlot, type: type, size: oldSize, state: ORDER_STATES.ACTIVE });
                stateUpdates.push({ ...nextSlot, type: type, size: oldSize, state: ORDER_STATES.ACTIVE });

                handledPartialIds.add(partial.id);
                budgetRemaining--;
            }
        }

        // Remove handled partials from surpluses so they aren't rotated to other slots
        const filteredSurpluses = surpluses.filter(s => !handledPartialIds.has(s.id));

        // Remove handled partial slots from shortages so they aren't targeted for rotation or placement
        // (they're already being updated in-place via ordersToUpdate)
        const filteredShortages = shortages.filter(idx => !handledPartialIds.has(allSlots[idx].id));

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 3: ROTATIONS (Refill Inner Gaps)
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
            const size = finalIdealSizes[shortageSlotIdx];

            // Validate shortage slot exists and has required fields
            if (!shortageSlot || !shortageSlot.id || !shortageSlot.price) {
                mgr.logger.log(`[ROTATION] Skipping shortage: invalid slot at index ${shortageSlotIdx}: ${JSON.stringify(shortageSlot)}`, "warn");
                shortageIdx++;  // Skip this shortage, try next
                continue;
            }

            // RE-VALIDATE SURPLUS TO PREVENT RACE CONDITION (Issue #3)
            // STEP 2.5 may have changed surplus state (e.g., ACTIVE→VIRTUAL, or converted to SPREAD).
            // Check current state before queuing rotation to avoid stale order references.
            // Also verify orderId matches to detect slot reuse (Issue #5 enhancement)
            const currentSurplus = mgr.orders.get(surplus.id);
            if (!currentSurplus ||
                currentSurplus.state === ORDER_STATES.VIRTUAL ||
                (surplus.orderId && currentSurplus.orderId !== surplus.orderId)) {
                mgr.logger.log(`[ROTATION] Skipping surplus ${surplus.id}: no longer valid (state: ${currentSurplus?.state}, orderId mismatch: ${surplus.orderId} vs ${currentSurplus?.orderId})`, "warn");
                surplusIdx++;  // Skip this surplus, try next (shortage stays for next valid surplus)
                continue;
            }

            // ATOMIC ROTATION: Both old→VIRTUAL and new→ACTIVE are pushed to stateUpdates,
            // ensuring they are applied together within pauseFundRecalc block in rebalance().
            // This prevents crash window between marking old as VIRTUAL and new as ACTIVE.
            ordersToRotate.push({ oldOrder: { ...currentSurplus }, newPrice: shortageSlot.price, newSize: size, newGridId: shortageSlot.id, type: type });
            const vacatedUpdate = { ...currentSurplus, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null };
            stateUpdates.push(vacatedUpdate);
            stateUpdates.push({ ...shortageSlot, type: type, size: size, state: ORDER_STATES.ACTIVE });
            mgr.logger.log(`[ROTATION] Atomic rotation: ${currentSurplus.id} (${currentSurplus.price}) → VIRTUAL, ${shortageSlot.id} (${shortageSlot.price}) → ACTIVE`, 'debug');

            surplusIdx++;
            shortageIdx++;
            rotationsPerformed++;
            budgetRemaining--;
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 4: PLACEMENTS (Activate Outer Edges)
        // ════════════════════════════════════════════════════════════════════════════════
        // Use remaining budget to place new orders at the edge of the grid window.
        // CRITICAL: Cap placement sizes to respect availablePool (liquid funds only).
        // Ideal sizes are calculated from totalSideBudget (distributed across all slots),
        // but actual placements can only use available liquid funds.
        let totalNewPlacementSize = 0;
        if (budgetRemaining > 0) {
            // Remaining shortages are those not covered by rotations.
            // Reverse them to target Furthest First (Outer Edges).
            // Use shortageIdx since it tracks how many shortages were consumed/skipped in rotation phase
            const outerShortages = filteredShortages.slice(shortageIdx).reverse();

            // Track remaining available funds for placements (only needed if increasing size)
            let remainingAvailable = availablePool;

            const placeCount = Math.min(outerShortages.length, budgetRemaining);
            for (let i = 0; i < placeCount; i++) {
                const idx = outerShortages[i];
                const slot = allSlots[idx];
                const idealSize = finalIdealSizes[idx];

                // Validate slot exists and has required fields
                if (!slot || !slot.id || !slot.price) {
                    mgr.logger.log(`[PLACEMENT] Skipping invalid slot at index ${idx}: ${JSON.stringify(slot)}`, "warn");
                    continue;
                }

                if (idealSize <= 0) continue;

                // CRITICAL: VIRTUAL orders already have capital allocated in idealSize.
                // Only cap if we're INCREASING the size beyond what was allocated.
                // If slot has no size (truly empty), it needs capital from availablePool.
                // If slot already has size allocated (VIRTUAL), use the full idealSize.
                const currentSize = slot.size || 0;
                const sizeIncrease = Math.max(0, idealSize - currentSize);

                if (sizeIncrease > 0) {
                    // Only cap the INCREASE, not the full order
                    const remainingOrders = placeCount - i;
                    const cappedIncrease = Math.min(sizeIncrease, remainingAvailable / remainingOrders);
                    const finalSize = currentSize + cappedIncrease;

                    if (finalSize > 0) {
                        ordersToPlace.push({ ...slot, type: type, size: finalSize, state: ORDER_STATES.ACTIVE });
                        stateUpdates.push({ ...slot, type: type, size: finalSize, state: ORDER_STATES.ACTIVE });
                        totalNewPlacementSize += cappedIncrease;  // Track capital allocated to new placements
                        // FIX: Ensure remainingAvailable stays non-negative (Issue #7)
                        remainingAvailable = Math.max(0, remainingAvailable - cappedIncrease);
                        budgetRemaining--;
                    }
                } else {
                    // No size increase needed, just activate at current size
                    if (idealSize > 0) {
                        ordersToPlace.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
                        stateUpdates.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
                        budgetRemaining--;
                    }
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: CANCEL REMAINING SURPLUSES
        // ════════════════════════════════════════════════════════════════════════════════
        const rotatedOldIds = new Set(ordersToRotate.map(r => r.oldOrder.id));
        for (const surplus of filteredSurpluses) {
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

    hasAnyDust(partials, side, budget) {
        const mgr = this.manager;
        const type = side === "buy" ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        const allOrders = Array.from(mgr.orders.values());
        
        // CRITICAL: Slots must be sorted Market-to-Edge to match allocateFundsByWeights assumption
        // This sorting ensures index 0 always points to the market-closest order
        const slots = allOrders.filter(o => o.type === type)
            .sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        if (slots.length === 0) return false;
        const precision = getPrecisionForSide(mgr.assets, side);
        const sideWeight = mgr.config.weightDistribution[side];

        // Slots are pre-sorted Market-to-Edge, so allocateFundsByWeights puts maximum weight at index 0
        const idealSizes = allocateFundsByWeights(budget, slots.length, sideWeight, mgr.config.incrementPercent / 100, false, 0, precision);

        return partials.some(p => {
            const idx = slots.findIndex(s => s.id === p.id);
            if (idx === -1) return false;
            const dustThreshold = idealSizes[idx] * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
            return p.size < dustThreshold;
        });
    }

    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!mgr || !Array.isArray(filledOrders)) return;

        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders`, "info");
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
                        mgr._updateOrder({ ...filledOrder, state: ORDER_STATES.VIRTUAL, orderId: null });
                    } else {
                        mgr.logger.log(`[RACE] Slot ${filledOrder.id} reused (curr=${currentSlot.orderId} != fill=${filledOrder.orderId}). Skipping VIRTUAL update.`, 'info');
                    }

                    // CRITICAL: _updateOrder(VIRTUAL) treats this as a cancellation and refunds chainFree.
                    // Since this is a FILL, the funds were spent. We must re-deduct them immediately.
                    mgr.accountant.tryDeductFromChainFree(filledOrder.type, filledOrder.size, 'fill-consumption');
                    mgr.logger.log(`[FUNDS] Consumed refunded capital for fill ${filledOrder.id}: ${filledOrder.size}`, 'debug');
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

                const oldCache = mgr.funds.cacheFunds[receiveSide] || 0;
                mgr.funds.cacheFunds[receiveSide] = oldCache + netProceeds;
                 mgr.logger.log(`[FUNDS] cacheFunds.${receiveSide} updated: ${Format.formatMetric5(oldCache)} -> ${Format.formatMetric5(mgr.funds.cacheFunds[receiveSide])}`, "debug");

                mgr.accountant.addToChainFree(receiveType, netProceeds, 'fill-proceeds');
                if (mgr.accountTotals) {
                    mgr.accountTotals[receiveSide] = (mgr.accountTotals[receiveSide] || 0) + netProceeds;
                    mgr.accountTotals[spendSide] = (mgr.accountTotals[spendSide] || 0) - filledOrder.size;
                }
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
                    const snap = mgr.getChainFundsSnapshot ? mgr.getChainFundsSnapshot() : {};

                    let btsFeeReservationBuy = 0;
                    let btsFeeReservationSell = 0;
                    try {
                        const reservations = this.calculateBtsFeeReservations(hasBtsPair, mgr.config);
                        btsFeeReservationBuy = reservations.btsFeeReservationBuy;
                        btsFeeReservationSell = reservations.btsFeeReservationSell;
                    } catch (err) {
                        mgr.logger.log(`Warning: Could not calculate BTS fees for dust detection: ${err.message}`, "warn");
                    }

                    // Use same budget calculation as rebalance() (chainFree + committed - btsFeeReservation)
                    const budgetBuy = Math.max(0, (snap.chainFreeBuy || 0) + (snap.committedChainBuy || 0) - btsFeeReservationBuy);
                    const budgetSell = Math.max(0, (snap.chainFreeSell || 0) + (snap.committedChainSell || 0) - btsFeeReservationSell);

                    const buyHasDust = buyPartials.length > 0 && this.hasAnyDust(buyPartials, "buy", budgetBuy);
                    const sellHasDust = sellPartials.length > 0 && this.hasAnyDust(sellPartials, "sell", budgetSell);

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
     * Used to finalize state or trigger follow-up actions.
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