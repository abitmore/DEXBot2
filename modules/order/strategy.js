/**
 * modules/order/strategy.js
 *
 * Simple & Robust Pivot Strategy (Boundary-Crawl Version)
 * Maintains contiguous physical rails using a master boundary anchor.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, FEE_PARAMETERS, PRECISION_DEFAULTS } = require("../constants");
const {
    getPrecisionForSide,
    getAssetFees,
    allocateFundsByWeights,
    calculateOrderCreationFees,
    floatToBlockchainInt,
    blockchainToFloat,
    calculateAvailableFundsValue,
    getMinOrderSize
} = require("./utils");

class StrategyEngine {
    constructor(manager) {
        this.manager = manager;
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

        // Sort all grid slots by index (Master Rail order)
        const allSlots = Array.from(mgr.orders.values())
            .sort((a, b) => {
                const idxA = parseInt(a.id.split('-')[1]);
                const idxB = parseInt(b.id.split('-')[1]);
                return idxA - idxB;
            });

        if (allSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], hadRotation: false, partialMoves: [] };

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 1: BOUNDARY DETERMINATION (Initial or Recovery)
        // ════════════════════════════════════════════════════════════════════════════════
        // If boundary is undefined (first run or after restart), calculate initial position
        // based on startPrice. This centers the spread zone around the market price.

        if (mgr.boundaryIdx === undefined) {
            const referencePrice = mgr.config.startPrice;
            const step = 1 + (mgr.config.incrementPercent / 100);

            // Calculate spread gap size (same formula as Grid.js)
            // Enforce MIN_SPREAD_FACTOR to prevent spread from being too narrow
            const minSpreadPercent = (mgr.config.incrementPercent || 0.5) * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2);
            const targetSpreadPercent = Math.max(mgr.config.targetSpreadPercent || 0, minSpreadPercent);
            const requiredSteps = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(step));
            const gapSlots = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps);

            // Find the first slot at or above startPrice (this becomes the spread zone)
            let splitIdx = allSlots.findIndex(s => s.price >= referencePrice);
            if (splitIdx === -1) splitIdx = allSlots.length;

            // Position boundary so spread gap is centered around startPrice
            const buySpread = Math.floor(gapSlots / 2);
            mgr.boundaryIdx = splitIdx - buySpread - 1;
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
            if (fill.type === ORDER_TYPES.SELL) mgr.boundaryIdx++;
            else if (fill.type === ORDER_TYPES.BUY) mgr.boundaryIdx--;
        }

        // Clamp boundary to valid range
        mgr.boundaryIdx = Math.max(0, Math.min(allSlots.length - 1, mgr.boundaryIdx));
        const boundaryIdx = mgr.boundaryIdx;

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 3: ROLE ASSIGNMENT (BUY / SPREAD / SELL)
        // ════════════════════════════════════════════════════════════════════════════════
        // Assign each slot to a role based on its position relative to the boundary:
        // 
        // [0 ... boundaryIdx] = BUY zone
        // [boundaryIdx+1 ... boundaryIdx+gapSlots] = SPREAD zone (empty buffer)
        // [boundaryIdx+gapSlots+1 ... N] = SELL zone

        const step = 1 + (mgr.config.incrementPercent / 100);
        const minSpreadPercent = (mgr.config.incrementPercent || 0.5) * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2);
        const targetSpreadPercent = Math.max(mgr.config.targetSpreadPercent || 0, minSpreadPercent);
        const requiredSteps = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(step));
        const gapSlots = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps);

        const buyEndIdx = boundaryIdx;
        const sellStartIdx = boundaryIdx + gapSlots + 1;

        // Partition slots into role-based arrays
        const buySlots = allSlots.slice(0, buyEndIdx + 1);
        const sellSlots = allSlots.slice(sellStartIdx);
        const spreadSlots = allSlots.slice(buyEndIdx + 1, sellStartIdx);

        // Update slot types (triggers state transitions if role changed)
        buySlots.forEach(s => { if (s.type !== ORDER_TYPES.BUY) mgr._updateOrder({ ...s, type: ORDER_TYPES.BUY }); });
        sellSlots.forEach(s => { if (s.type !== ORDER_TYPES.SELL) mgr._updateOrder({ ...s, type: ORDER_TYPES.SELL }); });
        spreadSlots.forEach(s => { 
            // Only convert to SPREAD if it doesn't have an active order!
            // This allows side rebalancers to see these orders as surpluses for rotation.
            if (s.type !== ORDER_TYPES.SPREAD && !s.orderId) {
                mgr._updateOrder({ ...s, type: ORDER_TYPES.SPREAD }); 
            }
        });

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 4: BUDGET CALCULATION (Target vs Reality)
        // ════════════════════════════════════════════════════════════════════════════════
        // Calculate how much capital to allocate to each side of the grid.
        // 
        // TWO BUDGET SOURCES:
        // 1. Target Budget: What the config says we should use (botFunds allocation)
        // 2. Reality Budget: What we actually have on-chain (total wallet balance)
        // 
        // We use the MINIMUM of these to prevent over-allocation.
        // cacheFunds (fill proceeds) are added to target to enable reinvestment.

        const snap = mgr.getChainFundsSnapshot();

        // Target Budget: Config allocation + fill proceeds available for reinvestment
        const targetBuy = snap.allocatedBuy + (mgr.funds.cacheFunds?.buy || 0);
        const targetSell = snap.allocatedSell + (mgr.funds.cacheFunds?.sell || 0);

        // Reality Budget: Total on-chain balance (free + committed)
        // CRITICAL: We strictly define "Reality" as (Available Free Balance + Our Committed Funds).
        const realityBuy = (snap.chainFreeBuy || 0) + (snap.committedChainBuy || 0);
        const realitySell = (snap.chainFreeSell || 0) + (snap.committedChainSell || 0);

        // Final Sizing Budget: Cap target by reality to prevent overdraft
        const budgetBuy = Math.min(targetBuy, realityBuy);
        const budgetSell = Math.min(targetSell, realitySell);

        // Available Pool: Liquid funds for net capital increases
        // = available (chainFree - virtual - fees) + cacheFunds (fill proceeds)
        const availablePoolBuy = (mgr.funds.available?.buy || 0) + (mgr.funds.cacheFunds?.buy || 0);
        const availablePoolSell = (mgr.funds.available?.sell || 0) + (mgr.funds.cacheFunds?.sell || 0);

        // Reaction Cap: Limit how many orders we rotate/place per cycle.
        // In sequential mode, fills.length is 1, so we allow 1 action per side.
        const reactionCap = Math.max(1, fills.length);
 
        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: SIDE REBALANCING (Independent Buy and Sell)
        // ════════════════════════════════════════════════════════════════════════════════
        // Rebalance each side independently using the Greedy Crawl algorithm.
        // See rebalanceSideRobust() for detailed algorithm documentation.
 
        const buyResult = await this.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, -1, budgetBuy, availablePoolBuy, excludeIds, reactionCap, fills);
        const sellResult = await this.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, 1, budgetSell, availablePoolSell, excludeIds, reactionCap, fills);

        // Apply all state updates to manager
        const allUpdates = [...buyResult.stateUpdates, ...sellResult.stateUpdates];
        allUpdates.forEach(upd => {
            // Fix: If order doesn't exist yet (new slot), treat as VIRTUAL/Empty for transition logic
            const existing = mgr.orders.get(upd.id) || { state: ORDER_STATES.VIRTUAL, size: 0, type: upd.type };

            // Allow optimistic update even if 'existing' was mock
            mgr.accountant.updateOptimisticFreeBalance(existing, upd, 'rebalance-apply');

            mgr._updateOrder(upd);
        });

        // Combine results from both sides
        const result = {
            ordersToPlace: [...buyResult.ordersToPlace, ...sellResult.ordersToPlace],
            ordersToRotate: [...buyResult.ordersToRotate, ...sellResult.ordersToRotate],
            ordersToUpdate: [...buyResult.ordersToUpdate, ...sellResult.ordersToUpdate],
            ordersToCancel: [...buyResult.ordersToCancel, ...sellResult.ordersToCancel],
            hadRotation: (buyResult.ordersToRotate.length > 0 || sellResult.ordersToRotate.length > 0),
            partialMoves: []
        };

        mgr.logger.log(`[BOUNDARY] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate. Gap size: ${gapSlots} slots.`, "info");

        return result;
    }

    /**
     * Rebalance a single side (BUY or SELL) using the Greedy Crawl algorithm.
     * 
     * ALGORITHM: Greedy Crawl with Global Side Capping
     * =================================================
     * This method implements a sophisticated order rotation strategy that:
     * 1. Calculates ideal geometric sizes for all slots
     * 2. Identifies shortages (empty slots) and surpluses (orders to rotate)
     * 3. FORCES placements for gaps created by actual fills (Refill)
     * 4. Greedily rotates orders for maintenance gaps (Crawl)
     * 
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Array} allSlots - All grid slots (Master Rail)
     * @param {Array} sideSlots - Slots assigned to this side
     * @param {number} direction - Price direction (-1 for BUY, 1 for SELL)
     * @param {number} totalSideBudget - Total capital to allocate to this side
     * @param {number} availablePool - Liquid funds for net capital increases
     * @param {Set} excludeIds - Order IDs to skip (locked)
     * @param {number} reactionCap - Max orders to rotate per cycle
     * @param {Array} fills - Actual fills being processed (to prioritize refills)
     * @returns {Object} Rebalancing actions (place, rotate, update, cancel, stateUpdates)
     */
    async rebalanceSideRobust(type, allSlots, sideSlots, direction, totalSideBudget, availablePool, excludeIds, reactionCap, fills = []) {
        if (sideSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };

        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
        const stateUpdates = [];
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToCancel = [];
        const ordersToUpdate = [];

        // Target active order count from config (how many orders closest to market)
        const targetCount = (mgr.config.activeOrders && Number.isFinite(mgr.config.activeOrders[side])) ? Math.max(1, mgr.config.activeOrders[side]) : sideSlots.length;

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 1: IDENTIFY TARGET WINDOW (Closest N orders to market)
        // ════════════════════════════════════════════════════════════════════════════════
        // Sort slots by distance from market:
        // - BUY: Highest price is closest (descending sort)
        // - SELL: Lowest price is closest (ascending sort)

        const sortedSideSlots = [...sideSlots].sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        // Target indices: The N slots closest to market (active window)
        const targetIndices = [];
        for (let i = 0; i < Math.min(targetCount, sortedSideSlots.length); i++) {
            targetIndices.push(allSlots.findIndex(s => s.id === sortedSideSlots[i].id));
        }
        const targetSet = new Set(targetIndices);

        const sideWeight = mgr.config.weightDistribution[side];
        const precision = getPrecisionForSide(mgr.assets, side);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 2: CALCULATE IDEAL SIZES (Geometric distribution)
        // ════════════════════════════════════════════════════════════════════════════════
        // Calculate ideal size for each slot using geometric weighting.
        // BTS fees are reserved from the budget to ensure we can always cancel/update orders.

        const hasBtsSide = (mgr.config.assetA === "BTS" || mgr.config.assetB === "BTS");
        const isBtsSide = (type === ORDER_TYPES.BUY && mgr.config.assetB === "BTS") || (type === ORDER_TYPES.SELL && mgr.config.assetA === "BTS");

        const btsFees = (hasBtsSide && isBtsSide)
            ? calculateOrderCreationFees(mgr.config.assetA, mgr.config.assetB, targetCount, FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER)
            : 0;

        const effectiveTotalSideBudget = Math.max(0, totalSideBudget - btsFees);

        const reverse = (type === ORDER_TYPES.BUY);
        const sideIdealSizes = allocateFundsByWeights(effectiveTotalSideBudget, sideSlots.length, sideWeight, mgr.config.incrementPercent / 100, reverse, 0, precision);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 3: APPLY IDEAL SIZES
        // ════════════════════════════════════════════════════════════════════════════════
        // Use the calculated geometric sizes for all slots. Since the total side budget
        // is already capped by the bot's actual on-chain reality (Free + Committed),
        // we can apply these sizes directly.

        const finalIdealSizes = new Array(allSlots.length).fill(0);
        sideSlots.forEach((slot, i) => {
            const targetIdealSize = sideIdealSizes[i] || 0;
            const globalIdx = allSlots.findIndex(s => s.id === slot.id);
            
            // Quantize to blockchain precision
            const size = blockchainToFloat(floatToBlockchainInt(targetIdealSize, precision), precision);
            finalIdealSizes[globalIdx] = size;
            stateUpdates.push({ ...slot, size: size });
        });

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 4: IDENTIFY SHORTAGES AND SURPLUSES
        // ════════════════════════════════════════════════════════════════════════════════
        
        const activeOnChain = allSlots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !excludeIds.has(s.id));
        const activeThisSide = activeOnChain.filter(s => s.type === type);

        // Shortages: Target slots without on-chain orders.
        // CRITICAL for sequential processing: If an order is in excludeIds, it means it is
        // pending its own turn in the sequential loop. We must NOT treat it as a shortage
        // yet, otherwise the first fill's rebalance will try to fill the second fill's gap.
        const shortages = targetIndices.filter(idx => {
            const slot = allSlots[idx];
            const isExcluded = excludeIds.has(slot.id) || (slot.orderId && excludeIds.has(slot.orderId));
            return !slot.orderId && !isExcluded && finalIdealSizes[idx] > 0;
        });

        const effectiveCap = (activeThisSide.length > 0) ? reactionCap : targetCount;

        // Sort all shortages: Closest to market first.
        // This ensures inner gaps (fills) are prioritized for handling.
        shortages.sort((a, b) => type === ORDER_TYPES.BUY ? allSlots[b].price - allSlots[a].price : allSlots[a].price - allSlots[b].price);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: IDENTIFY ROTATION CANDIDATES (Greedy Crawl)
        // ════════════════════════════════════════════════════════════════════════════════

        // 1. Hard Surpluses: Orders outside the target window
        const hardSurpluses = activeThisSide.filter(s => !targetSet.has(allSlots.findIndex(o => o.id === s.id)));

        // 2. Crawl Candidates: Furthest orders INSIDE the window
        let surpluses = [...hardSurpluses];
        const activeInsideWindow = activeThisSide
            .filter(s => targetSet.has(allSlots.findIndex(o => o.id === s.id)))
            .sort((a, b) => type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price); // Furthest first

        const crawlCapacity = Math.max(0, effectiveCap - surpluses.length);

        for (let i = 0; i < Math.min(crawlCapacity, shortages.length, activeInsideWindow.length); i++) {
            const furthest = activeInsideWindow[i];
            const furthestIdx = allSlots.findIndex(o => o.id === furthest.id);
            const bestShortageIdx = shortages[i];

            const isCloser = type === ORDER_TYPES.BUY ? (bestShortageIdx > furthestIdx) : (bestShortageIdx < furthestIdx);
            if (isCloser) surpluses.push(furthest);
        }

        surpluses.sort((a, b) => type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 6: EXECUTE ROTATIONS FOR BEST SHORTAGES
        // ════════════════════════════════════════════════════════════════════════════════
        // Pair furthest surpluses with closest shortages.
        // This handles inner gaps (fills) by moving existing capital inward.

        const pairCount = Math.min(surpluses.length, shortages.length, effectiveCap);
        for (let i = 0; i < pairCount; i++) {
            const surplus = surpluses[i];
            const shortageIdx = shortages[i];
            const shortageSlot = allSlots[shortageIdx];
            const size = finalIdealSizes[shortageIdx];

            ordersToRotate.push({ oldOrder: { ...surplus }, newPrice: shortageSlot.price, newSize: size, newGridId: shortageSlot.id, type: type });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL });
            stateUpdates.push({ ...shortageSlot, type: type, size: size, state: ORDER_STATES.ACTIVE });
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 7: PLACE NEW ORDERS FOR REMAINING SHORTAGES
        // ════════════════════════════════════════════════════════════════════════════════
        // Any shortages that couldn't be filled by rotations (likely the furthest ones)
        // are handled via new order placements.

        const remainingCap = Math.max(0, effectiveCap - pairCount);
        const placementShortages = shortages.slice(pairCount, pairCount + remainingCap);

        for (const idx of placementShortages) {
            const slot = allSlots[idx];
            const size = finalIdealSizes[idx];
            if (size > 0) {
                ordersToPlace.push({ ...slot, type: type, size: size, state: ORDER_STATES.ACTIVE });
                stateUpdates.push({ ...slot, type: type, size: size, state: ORDER_STATES.ACTIVE });
            }
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 8: CANCEL EXCESS SURPLUSES
        // ════════════════════════════════════════════════════════════════════════════════

        for (let i = pairCount; i < surpluses.length; i++) {
            const surplus = surpluses[i];
            ordersToCancel.push({ ...surplus });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL, orderId: null });
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 10: SURPLUS CONSUMPTION (Update cacheFunds)
        // ════════════════════════════════════════════════════════════════════════════════

        const finalStateMap = new Map();
        stateUpdates.forEach(s => finalStateMap.set(s.id, s));

        const totalAllocated = sideSlots.reduce((sum, slot) => {
            const updated = finalStateMap.get(slot.id);
            const size = updated ? (Number(updated.size) || 0) : (Number(slot.size) || 0);
            return sum + size;
        }, 0);

        mgr.funds.cacheFunds[side] = Math.max(0, totalSideBudget - totalAllocated - btsFees);

        if (mgr.logger.level === 'debug' && mgr.funds.cacheFunds[side] > 0) {
            mgr.logger.log(`[FUNDS] calc cacheFunds.${side}: Budget(${totalSideBudget.toFixed(5)}) - Alloc(${totalAllocated.toFixed(5)}) - Fees(${btsFees.toFixed(5)}) = ${mgr.funds.cacheFunds[side].toFixed(5)}`, 'debug');
        }

        return { ordersToPlace, ordersToRotate, ordersToUpdate, ordersToCancel, stateUpdates };
    }

    completeOrderRotation(oldOrderInfo) {
        const mgr = this.manager;
        const oldGridOrder = mgr.orders.get(oldOrderInfo.id);
        if (oldGridOrder && oldGridOrder.orderId === oldOrderInfo.orderId) {
            const size = oldGridOrder.size || 0;
            mgr.accountant.addToChainFree(oldGridOrder.type, size, 'rotation');

            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr._updateOrder(updatedOld);
            mgr.logger.log(`Rotated order ${oldOrderInfo.id} -> VIRTUAL (capital preserved).`, "info");
        }
    }

    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!mgr || !Array.isArray(filledOrders)) return;

        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders`, "info");
        mgr.pauseFundRecalc();

        try {
            const hasBtsPair = (mgr.config?.assetA === "BTS" || mgr.config?.assetB === "BTS");
            let fillsToSettle = 0;

            for (const filledOrder of filledOrders) {
                if (excludeOrderIds?.has?.(filledOrder.id)) continue;

                const isPartial = filledOrder.isPartial === true;
                if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                    fillsToSettle++;

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
                // Normalize type to ensure case-insensitive matching
                const orderType = String(filledOrder.type).toLowerCase();

                if (orderType === ORDER_TYPES.SELL) {
                    rawProceeds = filledOrder.size * filledOrder.price;
                    assetForFee = mgr.config.assetB;
                } else {
                    rawProceeds = filledOrder.size / filledOrder.price;
                    assetForFee = mgr.config.assetA;
                }

                let netProceeds = rawProceeds;
                if (assetForFee !== "BTS") {
                    try {
                        const feeInfo = getAssetFees(assetForFee, rawProceeds);
                        netProceeds = (typeof feeInfo === 'object') ? feeInfo.total : feeInfo; // Handle both object and number returns
                        // If utils.js returns full amount minus fee, use that. 
                        // Note: getAssetFees implementation returns (amount - fee) for non-BTS, or object for BTS.
                        // Let's verify utils.js: "return assetAmount - marketFeeAmount;" for non-BTS. 
                        // So netProceeds is already correct.
                    } catch (e) {
                        mgr.logger.log(`Warning: Could not calculate market fees for ${assetForFee}: ${e.message}`, "warn");
                    }
                }

                mgr.logger.log(`[FILL] ${orderType.toUpperCase()} fill: size=${filledOrder.size}, price=${filledOrder.price}, proceeds=${netProceeds.toFixed(8)} ${assetForFee}`, "debug");

                if (orderType === ORDER_TYPES.SELL) {
                    const oldCache = mgr.funds.cacheFunds.buy || 0;
                    mgr.funds.cacheFunds.buy = oldCache + netProceeds;
                    mgr.logger.log(`[FUNDS] cacheFunds.buy updated: ${oldCache.toFixed(5)} -> ${mgr.funds.cacheFunds.buy.toFixed(5)}`, "debug");
                    // Optimistic update to wallet balances
                    mgr.accountant.addToChainFree(ORDER_TYPES.BUY, netProceeds, 'fill-proceeds');
                    if (mgr.accountTotals) {
                        mgr.accountTotals.buy = (mgr.accountTotals.buy || 0) + netProceeds;
                        mgr.accountTotals.sell = (mgr.accountTotals.sell || 0) - filledOrder.size;
                    }
                } else {
                    const oldCache = mgr.funds.cacheFunds.sell || 0;
                    mgr.funds.cacheFunds.sell = oldCache + netProceeds;
                    mgr.logger.log(`[FUNDS] cacheFunds.sell updated: ${oldCache.toFixed(5)} -> ${mgr.funds.cacheFunds.sell.toFixed(5)}`, "debug");
                    // Optimistic update to wallet balances
                    mgr.accountant.addToChainFree(ORDER_TYPES.SELL, netProceeds, 'fill-proceeds');
                    if (mgr.accountTotals) {
                        mgr.accountTotals.sell = (mgr.accountTotals.sell || 0) + netProceeds;
                        mgr.accountTotals.buy = (mgr.accountTotals.buy || 0) - filledOrder.size;
                    }
                }
            }

            if (hasBtsPair && fillsToSettle > 0) {
                const btsFeeData = getAssetFees("BTS", 0);
                mgr.funds.btsFeesOwed += fillsToSettle * btsFeeData.total;
                await mgr.accountant.deductBtsFees();
            }

            mgr.recalculateFunds();
            await mgr.persistGrid();

            let shouldRebalance = (fillsToSettle > 0);

            if (!shouldRebalance) {
                const allOrders = Array.from(mgr.orders.values());
                const buyPartials = allOrders.filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL);
                const sellPartials = allOrders.filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL);

                if (buyPartials.length > 0 && sellPartials.length > 0) {
                    const snap = mgr.getChainFundsSnapshot ? mgr.getChainFundsSnapshot() : {};
                    const budgetBuy = snap.allocatedBuy + (mgr.funds.cacheFunds?.buy || 0);
                    const budgetSell = snap.allocatedSell + (mgr.funds.cacheFunds?.sell || 0);

                    const getIsDust = (partials, side, budget) => {
                        const slots = allOrders.filter(o => o.type === (side === "buy" ? ORDER_TYPES.BUY : ORDER_TYPES.SELL));
                        if (slots.length === 0) return false;
                        const precision = getPrecisionForSide(mgr.assets, side);
                        const sideWeight = mgr.config.weightDistribution[side];
                        const idealSizes = allocateFundsByWeights(budget, slots.length, sideWeight, mgr.config.incrementPercent / 100, side === "sell", 0, precision);

                        return partials.some(p => {
                            const idx = slots.findIndex(s => s.id === p.id);
                            if (idx === -1) return false;
                            const dustThreshold = idealSizes[idx] * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
                            return p.size < dustThreshold;
                        });
                    };

                    const buyHasDust = getIsDust(buyPartials, "buy", budgetBuy);
                    const sellHasDust = getIsDust(sellPartials, "sell", budgetSell);

                    if (buyHasDust && sellHasDust) {
                        mgr.logger.log("[BOUNDARY] Dual-side dust partials detected. Triggering rebalance.", "info");
                        shouldRebalance = true;
                    }
                }
            }

            if (!shouldRebalance) {
                mgr.logger.log("[BOUNDARY] Skipping rebalance: No full fills and no dual-side dust partials.", "info");
                return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], partialMoves: [] };
            }

            // Log detailed fund state before entering rebalance
            if (mgr.logger.level === 'debug') {
                mgr.logger.log(`[PRE-REBALANCE] Available: buy=${mgr.funds.available.buy.toFixed(5)}, sell=${mgr.funds.available.sell.toFixed(5)}`, 'debug');
                mgr.logger.log(`[PRE-REBALANCE] CacheFunds: buy=${mgr.funds.cacheFunds.buy.toFixed(5)}, sell=${mgr.funds.cacheFunds.sell.toFixed(5)}`, 'debug');
                mgr.logger.log(`[PRE-REBALANCE] ChainFree: buy=${mgr.accountTotals.buyFree.toFixed(5)}, sell=${mgr.accountTotals.sellFree.toFixed(5)}`, 'debug');
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

    preparePartialOrderMove(partialOrder, gridSlotsToMove, reservedGridIds = new Set()) {
        const mgr = this.manager;
        if (!partialOrder || gridSlotsToMove < 0) return null;
        if (!partialOrder.orderId) return null;

        const allSlots = Array.from(mgr.orders.values())
            .filter(o => o.price != null)
            .sort((a, b) => b.price - a.price);

        const currentIndex = allSlots.findIndex(o => o.id === partialOrder.id);
        if (currentIndex === -1) return null;

        const direction = partialOrder.type === ORDER_TYPES.SELL ? 1 : -1;
        const targetIndex = currentIndex + (direction * gridSlotsToMove);

        if (targetIndex < 0 || targetIndex >= allSlots.length) return null;

        const targetGridOrder = allSlots[targetIndex];
        const newGridId = targetGridOrder.id;

        if (reservedGridIds.has(newGridId)) return null;
        if (gridSlotsToMove > 0 && targetGridOrder.state !== ORDER_STATES.VIRTUAL) return null;

        const newPrice = targetGridOrder.price;
        let newMinToReceive;

        if (partialOrder.type === ORDER_TYPES.SELL) {
            const rawMin = partialOrder.size * newPrice;
            const prec = mgr.assets?.assetB?.precision || 8;
            newMinToReceive = blockchainToFloat(floatToBlockchainInt(rawMin, prec), prec);
        } else {
            const rawMin = partialOrder.size / newPrice;
            const prec = mgr.assets?.assetA?.precision || 8;
            newMinToReceive = blockchainToFloat(floatToBlockchainInt(rawMin, prec), prec);
        }

        return {
            partialOrder: { id: partialOrder.id, orderId: partialOrder.orderId, type: partialOrder.type, price: partialOrder.price, size: partialOrder.size, state: partialOrder.state },
            newGridId, newPrice, newMinToReceive, targetGridOrder,
            vacatedGridId: gridSlotsToMove > 0 ? partialOrder.id : null,
            vacatedPrice: gridSlotsToMove > 0 ? partialOrder.price : null
        };
    }

    completePartialOrderMove(moveInfo) {
        const mgr = this.manager;
        const { partialOrder, newGridId, newPrice } = moveInfo;

        const oldGridOrder = mgr.orders.get(partialOrder.id);
        if (oldGridOrder && (!oldGridOrder.orderId || oldGridOrder.orderId === partialOrder.orderId)) {
            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr.accountant.updateOptimisticFreeBalance(oldGridOrder, updatedOld, "move-vacate", 0);
            mgr._updateOrder(updatedOld);
        }

        const targetGridOrder = mgr.orders.get(newGridId);
        if (targetGridOrder) {
            const precision = (partialOrder.type === ORDER_TYPES.SELL)
                ? mgr.assets?.assetA?.precision
                : mgr.assets?.assetB?.precision;
            const partialInt = floatToBlockchainInt(partialOrder.size, precision);
            const idealInt = floatToBlockchainInt(targetGridOrder.size || 0, precision);
            const newState = partialInt >= idealInt ? ORDER_STATES.ACTIVE : ORDER_STATES.PARTIAL;

            const updatedNew = {
                ...targetGridOrder, ...partialOrder, type: partialOrder.type,
                state: newState, orderId: partialOrder.orderId, size: partialOrder.size, price: newPrice
            };
            mgr.accountant.updateOptimisticFreeBalance(targetGridOrder, updatedNew, "move-occupy", 0);
            mgr._updateOrder(updatedNew);
        }
    }
}

module.exports = StrategyEngine;