/**
 * modules/order/strategy.js
 *
 * Simple & Robust Pivot Strategy (Slot-Crawl Version)
 * Maintains contiguous physical rails using strict outlier-to-hole rotation.
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
     * Implements minimalist "one fill = one move" logic.
     */
    async rebalance(fills = [], excludeIds = new Set()) {
        const mgr = this.manager;
        mgr.logger.log("[PIVOT-ROBUST] Starting minimalist rebalance.", "info");
        
        const allSlots = Array.from(mgr.orders.values())
            .sort((a, b) => {
                const idxA = parseInt(a.id.split('-')[1]);
                const idxB = parseInt(b.id.split('-')[1]);
                return idxA - idxB;
            });

        if (allSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], hadRotation: false, partialMoves: [] };

        // 1. Initial Pivot Determination (if not already set)
        if (mgr.currentPivotIdx === undefined) {
            let referencePrice = mgr.config.startPrice;
            let minDiff = Infinity;
            allSlots.forEach((slot, i) => {
                const diff = Math.abs(slot.price - referencePrice);
                if (diff < minDiff) {
                    minDiff = diff;
                    mgr.currentPivotIdx = i;
                }
            });
        }

        // 2. Incremental Pivot Shift based on Fills
        // Sell fills move pivot UP (+1), Buy fills move pivot DOWN (-1)
        for (const fill of fills) {
            if (fill.type === ORDER_TYPES.SELL) mgr.currentPivotIdx++;
            else if (fill.type === ORDER_TYPES.BUY) mgr.currentPivotIdx--;
        }
        
        mgr.currentPivotIdx = Math.max(0, Math.min(allSlots.length - 1, mgr.currentPivotIdx));
        const pivotIdx = mgr.currentPivotIdx;

        // 3. Define Roles and Safety Gap
        const step = 1 + (mgr.config.incrementPercent / 100);
        const requiredSteps = Math.ceil(Math.log(1 + (mgr.config.targetSpreadPercent / 100)) / Math.log(step));
        const gapSlots = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps);
        
        const halfGap = Math.floor(gapSlots / 2);
        const buyEndIdx = pivotIdx - halfGap;
        const sellStartIdx = buyEndIdx + gapSlots + 1;

        // Partition slots into Roles
        const buySlots = allSlots.slice(0, buyEndIdx + 1);
        const sellSlots = allSlots.slice(sellStartIdx);
        const spreadSlots = allSlots.slice(buyEndIdx + 1, sellStartIdx);

        // Update Slot Types
        buySlots.forEach(s => { if (s.type !== ORDER_TYPES.BUY) mgr._updateOrder({ ...s, type: ORDER_TYPES.BUY }); });
        sellSlots.forEach(s => { if (s.type !== ORDER_TYPES.SELL) mgr._updateOrder({ ...s, type: ORDER_TYPES.SELL }); });
        spreadSlots.forEach(s => { if (s.type !== ORDER_TYPES.SPREAD) mgr._updateOrder({ ...s, type: ORDER_TYPES.SPREAD }); });

        // 4. Budget Calculation (On-Chain Total + Proceeds)
        const snap = mgr.getChainFundsSnapshot();
        const budgetBuy = snap.allocatedBuy + (mgr.funds.cacheFunds?.buy || 0);
        const budgetSell = snap.allocatedSell + (mgr.funds.cacheFunds?.sell || 0);

        // 5. Minimalist Side Rebalancing
        const buyResult = await this.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, -1, budgetBuy, excludeIds);
        const sellResult = await this.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, 1, budgetSell, excludeIds);
        
        const allUpdates = [...buyResult.stateUpdates, ...sellResult.stateUpdates]; 
        allUpdates.forEach(upd => mgr._updateOrder(upd)); 

        const result = {
            ordersToPlace: [...buyResult.ordersToPlace, ...sellResult.ordersToPlace],
            ordersToRotate: [...buyResult.ordersToRotate, ...sellResult.ordersToRotate],
            ordersToUpdate: [...buyResult.ordersToUpdate, ...sellResult.ordersToUpdate],
            ordersToCancel: [...buyResult.ordersToCancel, ...sellResult.ordersToCancel],
            hadRotation: (buyResult.ordersToRotate.length > 0 || sellResult.ordersToRotate.length > 0),
            partialMoves: []
        };
        
        mgr.logger.log(`[PIVOT-ROBUST] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate. Gap size: ${gapSlots} slots.`, "info");
        
        return result;
    }

    /**
     * Robust side maintenance.
     * Implements strict "outlier to market hole" rotation.
     */
    async rebalanceSideRobust(type, allSlots, sideSlots, direction, totalSideBudget, excludeIds) {
        if (sideSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };

        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
        const stateUpdates = [];
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToCancel = [];
        const ordersToUpdate = [];

        // 1. Identify Target active window
        const targetCount = (mgr.config.activeOrders && Number.isFinite(mgr.config.activeOrders[side])) ? Math.max(1, mgr.config.activeOrders[side]) : sideSlots.length;
        const sortedSideSlots = [...sideSlots].sort((a, b) => direction === 1 ? a.price - b.price : b.price - a.price);
        
        const targetIndices = [];
        for (let i = 0; i < Math.min(targetCount, sortedSideSlots.length); i++) {
            targetIndices.push(allSlots.findIndex(s => s.id === sortedSideSlots[i].id));
        }
        const targetSet = new Set(targetIndices);

        // 2. Identify Outliers and Holes
        const activeOnChain = allSlots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !excludeIds.has(s.id));
        const activeThisSide = activeOnChain.filter(s => s.type === type);
        
        // Outliers: active orders outside the target indices
        const surpluses = activeThisSide.filter(s => !targetSet.has(allSlots.findIndex(o => o.id === s.id)));
        // Holes: target indices without an order
        const shortages = targetIndices.filter(idx => !allSlots[idx].orderId || excludeIds.has(allSlots[idx].id));

        // 3. Sizing
        const sideWeight = mgr.config.weightDistribution[side];
        const precision = getPrecisionForSide(mgr.assets, side);
        
        // Calculate total side budget (Free + Locked) to ensure idealSizes are non-zero for rotation
        const currentGridAllocation = sideSlots
            .filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL))
            .reduce((sum, o) => sum + (Number(o.size) || 0), 0);
        
        const totalBudget = totalSideBudget + currentGridAllocation;
        const sideIdealSizes = allocateFundsByWeights(totalBudget, sideSlots.length, sideWeight, mgr.config.incrementPercent / 100, type === ORDER_TYPES.SELL, 0, precision);
        
        const idealSizes = new Array(allSlots.length).fill(0);
        sortedSideSlots.forEach((slot, i) => {
            const globalIdx = allSlots.findIndex(s => s.id === slot.id);
            idealSizes[globalIdx] = sideIdealSizes[i];
        });

        // 4. Strict Rotation: Furthest Surplus -> Closest Shortage
        surpluses.sort((a, b) => direction === 1 ? b.price - a.price : a.price - b.price); // Outliers first
        shortages.sort((a, b) => direction === 1 ? allSlots[a].price - allSlots[b].price : allSlots[b].price - allSlots[a].price); // Holes first

        const pairCount = Math.min(surpluses.length, shortages.length);
        for (let i = 0; i < pairCount; i++) {
            const surplus = surpluses[i];
            const shortageIdx = shortages[i];
            const shortageSlot = allSlots[shortageIdx];
            const idealSize = idealSizes[shortageIdx];

            ordersToRotate.push({ oldOrder: { ...surplus }, newPrice: shortageSlot.price, newSize: idealSize, newGridId: shortageSlot.id, type: type });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL });
            stateUpdates.push({ ...shortageSlot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
        }

        // 5. New Placements (if funds allow and holes remain)
        for (let i = pairCount; i < shortages.length; i++) {
            const idx = shortages[i];
            const slot = allSlots[idx];
            const idealSize = idealSizes[idx];
            if (idealSize > 0) {
                ordersToPlace.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
                stateUpdates.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
            }
        }

        // 6. Excess Cancellation
        for (let i = pairCount; i < surpluses.length; i++) {
            const surplus = surpluses[i];
            ordersToCancel.push({ ...surplus });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL, orderId: null });
        }

        return { ordersToPlace, ordersToRotate, ordersToUpdate, ordersToCancel, stateUpdates };
    }

    completeOrderRotation(oldOrderInfo) {
        const mgr = this.manager;
        const oldGridOrder = mgr.orders.get(oldOrderInfo.id);
        if (oldGridOrder && oldGridOrder.orderId === oldOrderInfo.orderId) {
            const size = oldGridOrder.size || 0;
            if (oldGridOrder.type === ORDER_TYPES.BUY) mgr.accountTotals.buyFree = (mgr.accountTotals.buyFree || 0) + size;
            else if (oldGridOrder.type === ORDER_TYPES.SELL) mgr.accountTotals.sellFree = (mgr.accountTotals.sellFree || 0) + size;

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
                        netProceeds = getAssetFees(assetForFee, rawProceeds);
                    } catch (e) {
                        mgr.logger.log(`Warning: Could not calculate market fees for ${assetForFee}: ${e.message}`, "warn");
                    }
                }

                if (filledOrder.type === ORDER_TYPES.SELL) {
                    mgr.funds.cacheFunds.buy = (mgr.funds.cacheFunds.buy || 0) + netProceeds;
                } else {
                    mgr.funds.cacheFunds.sell = (mgr.funds.cacheFunds.sell || 0) + netProceeds;
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
                        mgr.logger.log("[PIVOT-ROBUST] Dual-side dust partials detected. Triggering rebalance.", "info");
                        shouldRebalance = true;
                    }
                }
            }

            if (!shouldRebalance) {
                mgr.logger.log("[PIVOT-ROBUST] Skipping rebalance: No full fills and no dual-side dust partials.", "info");
                return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], partialMoves: [] };
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