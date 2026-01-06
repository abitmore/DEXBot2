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
        spreadSlots.forEach(s => { if (s.type !== ORDER_TYPES.SPREAD) mgr._updateOrder({ ...s, type: ORDER_TYPES.SPREAD }); });

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
        // We do NOT use chainTotal directly because it might include funds locked by OTHER bots or manual orders.
        // Using chainTotal in that case would cause us to treat foreign locked funds as "surplus/cacheFunds",
        // leading to massive over-allocation attempts.
        const realityBuy = (snap.chainFreeBuy || 0) + (snap.committedChainBuy || 0);
        const realitySell = (snap.chainFreeSell || 0) + (snap.committedChainSell || 0);

        if (mgr.logger.level === 'debug') {
            mgr.logger.log(`[BUDGET] Reality Check: Buy=(Free:${snap.chainFreeBuy?.toFixed(5)} + Cmtd:${snap.committedChainBuy?.toFixed(5)} = ${realityBuy.toFixed(5)}), Sell=(Free:${snap.chainFreeSell?.toFixed(5)} + Cmtd:${snap.committedChainSell?.toFixed(5)} = ${realitySell.toFixed(5)})`, 'debug');
            if (snap.chainTotalBuy > realityBuy + 1) mgr.logger.log(`[BUDGET] WARN: ChainTotalBuy (${snap.chainTotalBuy}) > RealityBuy (${realityBuy}). Foreign locks detected!`, 'warn');
        }

        // Final Sizing Budget: Cap target by reality to prevent overdraft
        const budgetBuy = Math.min(targetBuy, realityBuy);
        const budgetSell = Math.min(targetSell, realitySell);

        // Available Pool: Liquid funds for net capital increases
        // = available (chainFree - virtual - fees) + cacheFunds (fill proceeds)
        // This is the "fuel" for growing order sizes or placing new orders
        const availablePoolBuy = (mgr.funds.available?.buy || 0) + (mgr.funds.cacheFunds?.buy || 0);
        const availablePoolSell = (mgr.funds.available?.sell || 0) + (mgr.funds.cacheFunds?.sell || 0);

        // Reaction Cap: Limit how many orders we rotate per cycle
        // Prevents excessive churn; scales with number of fills
        const reactionCap = Math.max(1, fills.length);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: SIDE REBALANCING (Independent Buy and Sell)
        // ════════════════════════════════════════════════════════════════════════════════
        // Rebalance each side independently using the Greedy Crawl algorithm.
        // See rebalanceSideRobust() for detailed algorithm documentation.

        const buyResult = await this.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, -1, budgetBuy, availablePoolBuy, excludeIds, reactionCap);
        const sellResult = await this.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, 1, budgetSell, availablePoolSell, excludeIds, reactionCap);

        // Apply all state updates to manager
        const allUpdates = [...buyResult.stateUpdates, ...sellResult.stateUpdates];
        allUpdates.forEach(upd => {
            const existing = mgr.orders.get(upd.id);
            if (existing) {
                // IMPORTANT: Optimistically update chainFree usage.
                // If we are growing an ACTIVE order, we must deduce from chainFree immediately
                // so that 'available' funds reflects this commitment.
                mgr.accountant.updateOptimisticFreeBalance(existing, upd, 'rebalance-apply');
            }
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
     * 2. Applies Global Side Capping to prevent overdraft
     * 3. Identifies shortages (empty slots) and surpluses (orders to rotate)
     * 4. Greedily rotates orders from furthest positions to closest shortages
     * 
     * KEY FEATURES:
     * - Fund-neutral rotations: Can rotate even with 0 available balance
     * - Global Side Capping: Scales ALL increases proportionally when funds are tight
     * - Greedy Crawl: Moves furthest orders to closest shortages for maximum efficiency
     * - Surplus consumption: Unused capital stays in cacheFunds for future cycles
     * 
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Array} allSlots - All grid slots (Master Rail)
     * @param {Array} sideSlots - Slots assigned to this side
     * @param {number} direction - Price direction (-1 for BUY, 1 for SELL)
     * @param {number} totalSideBudget - Total capital to allocate to this side
     * @param {number} availablePool - Liquid funds for net capital increases
     * @param {Set} excludeIds - Order IDs to skip (locked)
     * @param {number} reactionCap - Max orders to rotate per cycle
     * @returns {Object} Rebalancing actions (place, rotate, update, cancel, stateUpdates)
     */
    async rebalanceSideRobust(type, allSlots, sideSlots, direction, totalSideBudget, availablePool, excludeIds, reactionCap) {
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

        const currentGridAllocation = sideSlots
            .filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL))
            .reduce((sum, o) => sum + (Number(o.size) || 0), 0);

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
        // STEP 3: GLOBAL SIDE CAPPING (The "Perfect Budget" Logic)
        // ════════════════════════════════════════════════════════════════════════════════
        // PROBLEM: If we naively try to grow all orders to their ideal sizes, we might
        // need more capital than we have available (overdraft).
        // 
        // SOLUTION: Calculate the TOTAL net capital increase needed across ALL slots.
        // If total increase > availablePool, scale down ALL increases proportionally.
        // 
        // BENEFITS:
        // - Fund-neutral rotations: Can rotate orders even with 0 available balance
        //   (rotation releases capital from old order, uses it for new order)
        // - Proportional scaling: All orders shrink equally when funds are tight
        // - No overdraft: Never attempt to allocate more than we have
        // 
        // FORMULA:
        // - For each slot: delta = max(0, idealSize - currentSize)
        // - totalGrowth = sum(delta)
        // - scaleFactor = min(1.0, availablePool / totalGrowth)
        // - finalSize = currentSize + (delta * scaleFactor)

        let totalSideGrowthNeeded = 0;
        const idealSizes = new Array(allSlots.length).fill(0);

        // Calculate total growth needed across entire side
        sideSlots.forEach((slot, i) => {
            const globalIdx = allSlots.findIndex(s => s.id === slot.id);
            const targetIdealSize = sideIdealSizes[i] || 0;
            idealSizes[globalIdx] = targetIdealSize;

            const oldReservedSize = Number(allSlots[globalIdx].size) || 0;
            if (targetIdealSize > oldReservedSize) {
                // This slot needs to grow
                totalSideGrowthNeeded += (targetIdealSize - oldReservedSize);
            }
        });

        // Calculate scale factor: How much of the requested growth can we afford?
        // - If totalGrowth <= availablePool: scale = 1.0 (no scaling needed)
        // - If totalGrowth > availablePool: scale < 1.0 (proportional reduction)
        const sideScale = (totalSideGrowthNeeded > availablePool) ? (availablePool / totalSideGrowthNeeded) : 1.0;

        // Apply scale factor to all slots
        // - Growing orders: Scale the increase
        // - Shrinking orders: No scaling (releases capital immediately)
        const finalIdealSizes = new Array(allSlots.length).fill(0);
        sideSlots.forEach((slot) => {
            const globalIdx = allSlots.findIndex(s => s.id === slot.id);
            const targetIdealSize = idealSizes[globalIdx];
            const oldReservedSize = Number(allSlots[globalIdx].size) || 0;

            if (targetIdealSize > oldReservedSize) {
                // Growing: Apply scale factor
                finalIdealSizes[globalIdx] = oldReservedSize + (targetIdealSize - oldReservedSize) * sideScale;
            } else {
                // Shrinking or same: No scaling (instant capital release)
                finalIdealSizes[globalIdx] = targetIdealSize;
            }

            // Quantize to blockchain precision
            const size = blockchainToFloat(floatToBlockchainInt(finalIdealSizes[globalIdx], precision), precision);
            stateUpdates.push({ ...slot, size: size });
        });

        if (totalSideGrowthNeeded > 0) {
            mgr.logger.log(`[CAPPING] ${side.toUpperCase()} Side Growth (Pool=${availablePool.toFixed(precision)}, Needed=${totalSideGrowthNeeded.toFixed(precision)}, Scale=${sideScale.toFixed(4)})`, "info");
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 4: IDENTIFY SHORTAGES AND SURPLUSES
        // ════════════════════════════════════════════════════════════════════════════════
        // SHORTAGES: Empty slots in the target window (closest N to market)
        // SURPLUSES: Orders that can be rotated to fill shortages
        // 
        // TWO TYPES OF SURPLUSES:
        // 1. Hard Surpluses: Orders OUTSIDE the target window (beyond N closest)
        // 2. Crawl Candidates: Orders INSIDE the window but furthest from market
        // 
        // GREEDY CRAWL STRATEGY:
        // - If we have a shortage closer to market than a crawl candidate,
        //   rotate the candidate to the shortage (moves capital toward market)
        // - This creates a "crawling" effect where orders follow price movement

        const activeOnChain = allSlots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !excludeIds.has(s.id));
        const activeThisSide = activeOnChain.filter(s => s.type === type);

        // Shortages: Target slots without on-chain orders
        const shortages = targetIndices.filter(idx => (!allSlots[idx].orderId || excludeIds.has(allSlots[idx].id)) && idealSizes[idx] > 0);
        const effectiveCap = (activeThisSide.length > 0) ? reactionCap : targetCount;

        // Sort shortages: Closest to market first
        // - BUY: Highest price first (descending)
        // - SELL: Lowest price first (ascending)
        shortages.sort((a, b) => {
            if (type === ORDER_TYPES.BUY) return allSlots[b].price - allSlots[a].price;
            return allSlots[a].price - allSlots[b].price;
        });

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: GREEDY CRAWL (Identify Rotation Candidates)
        // ════════════════════════════════════════════════════════════════════════════════

        // 1. Hard Surpluses: Orders outside the target window
        const hardSurpluses = activeThisSide.filter(s => !targetSet.has(allSlots.findIndex(o => o.id === s.id)));

        // 2. Crawl Candidates: Furthest orders INSIDE the window
        // These can be rotated to closer shortages for better market positioning
        let surpluses = [...hardSurpluses];
        const activeInsideWindow = activeThisSide
            .filter(s => targetSet.has(allSlots.findIndex(o => o.id === s.id)))
            .sort((a, b) => type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price); // Furthest first

        // Identify crawl opportunities: Move furthest orders to closest shortages
        const shortagesToFill = shortages.length;
        const crawlCapacity = Math.max(0, (activeThisSide.length > 0 ? reactionCap : targetCount) - surpluses.length);

        for (let i = 0; i < Math.min(crawlCapacity, shortagesToFill, activeInsideWindow.length); i++) {
            const furthest = activeInsideWindow[i];
            const furthestIdx = allSlots.findIndex(o => o.id === furthest.id);
            const bestShortageIdx = shortages[i];

            // Only crawl if it's a price improvement (closer to market)
            // - BUY: Higher index = closer to market (higher price)
            // - SELL: Lower index = closer to market (lower price)
            const isCloser = type === ORDER_TYPES.BUY ? (bestShortageIdx > furthestIdx) : (bestShortageIdx < furthestIdx);
            if (isCloser) {
                surpluses.push(furthest);
            }
        }

        // Sort surpluses: Furthest from market first (for rotation efficiency)
        surpluses.sort((a, b) => type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 6: EXECUTE ROTATIONS
        // ════════════════════════════════════════════════════════════════════════════════
        // Pair surpluses with shortages and create rotation actions.
        // Rotation = Cancel old order + Place new order at shortage price

        const pairCount = Math.min(surpluses.length, shortages.length, effectiveCap);
        for (let i = 0; i < pairCount; i++) {
            const surplus = surpluses[i];
            const shortageIdx = shortages[i];
            const shortageSlot = allSlots[shortageIdx];
            const size = blockchainToFloat(floatToBlockchainInt(finalIdealSizes[shortageIdx], precision), precision);

            ordersToRotate.push({ oldOrder: { ...surplus }, newPrice: shortageSlot.price, newSize: size, newGridId: shortageSlot.id, type: type });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL });
            stateUpdates.push({ ...shortageSlot, type: type, size: size, state: ORDER_STATES.ACTIVE });
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 7: PLACE NEW ORDERS (Remaining shortages)
        // ════════════════════════════════════════════════════════════════════════════════
        // If we have shortages left after rotations, place new orders (if funds available)

        const remainingCap = Math.max(0, effectiveCap - pairCount);
        const placementShortages = shortages.slice(pairCount, pairCount + remainingCap);

        for (const idx of placementShortages) {
            const slot = allSlots[idx];
            const size = blockchainToFloat(floatToBlockchainInt(finalIdealSizes[idx], precision), precision);

            if (size > 0) {
                ordersToPlace.push({ ...slot, type: type, size: size, state: ORDER_STATES.ACTIVE });
                stateUpdates.push({ ...slot, type: type, size: size, state: ORDER_STATES.ACTIVE });
            }
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 8: CANCEL EXCESS SURPLUSES
        // ════════════════════════════════════════════════════════════════════════════════
        // Surpluses beyond rotation capacity are cancelled

        for (let i = pairCount; i < surpluses.length; i++) {
            const surplus = surpluses[i];
            ordersToCancel.push({ ...surplus });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL, orderId: null });
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 9: SURPLUS CONSUMPTION (Update cacheFunds)
        // ════════════════════════════════════════════════════════════════════════════════
        // Calculate how much of the budget was actually allocated to grid slots.
        // Unallocated capital remains in cacheFunds for future cycles.
        // 
        // This enables gradual capital deployment as funds become available.

        const finalStateMap = new Map();
        stateUpdates.forEach(s => finalStateMap.set(s.id, s));

        // Correctly calculate total allocated capital:
        // Sum sizes of ALL orders on this side, using the NEW size (if updated) or EXISTING size (if unchanged)
        const totalAllocated = sideSlots.reduce((sum, slot) => {
            const updated = finalStateMap.get(slot.id);
            const size = updated ? (Number(updated.size) || 0) : (Number(slot.size) || 0);
            return sum + size;
        }, 0);

        // Update cacheFunds: Budget minus what we allocated, AND minus the fee reservation.
        // The fee reservation (btsFees) is capital we MUST keep free (in chainFree) for fees, 
        // it cannot be considered "surplus" (cacheFunds) to be re-injected into grid size.
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
                    mgr._updateOrder({ ...filledOrder, state: ORDER_STATES.VIRTUAL, orderId: null });

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