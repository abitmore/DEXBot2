/**
 * modules/order/strategy.js
 *
 * Specialized engine for grid rebalancing and rotation strategies.
 * Implements Unified Rebalancing with explicit Physical Shift and Surplus Management.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, FEE_PARAMETERS, PRECISION_DEFAULTS } = require('../constants');
const {
    getPrecisionForSide,
    getAssetFees,
    allocateFundsByWeights,
    calculateOrderCreationFees
} = require('./utils');

class StrategyEngine {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Unified rebalancing entry point.
     * FORMULA: Side Budget = chainTotal (Allocated Total)
     */
    async rebalance(fills = [], excludeIds = new Set()) {
        const mgr = this.manager;
        mgr.logger.log(`[UNIFIED] Starting rebalance sequence.`, 'info');
        
        const allOrders = Array.from(mgr.orders.values());
        
        // 1. Partition Slots by fixed ID prefixes (Physical Side Isolation)
        // BUY: Inward (Market-facing) first = Highest Price first
        const buySlots = allOrders.filter(o => o.id && String(o.id).startsWith('buy-')).sort((a, b) => b.price - a.price);
        // SELL: Inward (Market-facing) first = Lowest Price first
        const sellSlots = allOrders.filter(o => o.id && String(o.id).startsWith('sell-')).sort((a, b) => a.price - b.price);
        // SPREAD: Intermediate placeholders (Sorted Highest Price First)
        const spreadSlots = allOrders.filter(o => o.id && (String(o.id).startsWith('spread-') || o.type === ORDER_TYPES.SPREAD)).sort((a, b) => b.price - a.price);

        // 2. Identify Fill Context
        const filledSide = (fills.length > 0) ? fills[0].type : null;

        // 3. Identify Side Budgets
        const snap = mgr.getChainFundsSnapshot ? mgr.getChainFundsSnapshot() : {};
        
        // 4. Process Sides
        const buyResult = await this.rebalanceSideLogic(ORDER_TYPES.BUY, buySlots, spreadSlots, snap.chainTotalBuy, excludeIds, filledSide === ORDER_TYPES.BUY, filledSide != null);
        const sellResult = await this.rebalanceSideLogic(ORDER_TYPES.SELL, sellSlots, spreadSlots, snap.chainTotalSell, excludeIds, filledSide === ORDER_TYPES.SELL, filledSide != null);
        
        const result = {
            ordersToPlace: [...buyResult.ordersToPlace, ...sellResult.ordersToPlace],
            ordersToRotate: [...buyResult.ordersToRotate, ...sellResult.ordersToRotate],
            ordersToUpdate: [...buyResult.ordersToUpdate, ...sellResult.ordersToUpdate],
            ordersToCancel: [...buyResult.ordersToCancel, ...sellResult.ordersToCancel],
            hadRotation: (buyResult.ordersToRotate.length > 0 || sellResult.ordersToRotate.length > 0),
            partialMoves: []
        };
        
        mgr.logger.log(`[UNIFIED] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate, ${result.ordersToUpdate.length} update, ${result.ordersToCancel.length} cancel.`, 'info');
        
        return result;
    }

    /**
     * Side-specific rebalancing logic.
     * Implements explicit Physical Shift: Expansion on fill-side, Rotation on opposite-side.
     */
    async rebalanceSideLogic(type, slots, spreadSlots, sideBudget, excludeIds, wasFilledSide, anyFillOccurred) {
        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';
        
        if (slots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [] };

        // 1. Budget & Geometric Scale
        let btsFeesReservation = 0;
        if ((mgr.config.assetA === 'BTS' && side === 'sell') || (mgr.config.assetB === 'BTS' && side === 'buy')) {
            const targetOrders = Math.max(1, mgr.config.activeOrders?.[side] || 1);
            btsFeesReservation = calculateOrderCreationFees(mgr.config.assetA, mgr.config.assetB, targetOrders, 5);
        }
        const availableBudget = Math.max(0, sideBudget - btsFeesReservation);

        const precision = getPrecisionForSide(mgr.assets, side);
        const weight = mgr.config.weightDistribution[side];
        const idealSizes = allocateFundsByWeights(
            availableBudget,
            slots.length,
            weight,
            mgr.config.incrementPercent / 100,
            false, // Market-facing index 0
            0,
            precision
        );

        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToUpdate = [];
        const ordersToCancel = [];

        // 2. State Analysis
        const targetCount = Math.max(1, mgr.config.activeOrders?.[side] || 1);
        const activeOrders = slots.filter(s => (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && s.orderId && !excludeIds.has(s.id));
        const currentActiveCount = activeOrders.length;

        // 3. Maintenance Policy: Expand, Rotate, or Surplus Cleanup
        if (wasFilledSide) {
            // Side that filled: Expansion (New Placement)
            if (currentActiveCount < targetCount) {
                // Find physical edge: last active slot index + 1
                const allActiveIndices = slots.map((s, i) => (s.orderId || s.state === ORDER_STATES.PARTIAL) ? i : -1).filter(i => i !== -1);
                const edgeIdx = allActiveIndices.length > 0 ? Math.max(...allActiveIndices) : -1;
                const idxToActivate = edgeIdx + 1;
                const slotToActivate = slots[idxToActivate];

                if (slotToActivate && slotToActivate.state === ORDER_STATES.VIRTUAL) {
                    const idealSize = idealSizes[idxToActivate];
                    ordersToPlace.push({ ...slotToActivate, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
                    mgr._updateOrder({ ...slotToActivate, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
                    mgr.logger.log(`[UNIFIED] Expansion: Placing ${type} order at edge index ${idxToActivate} (${slotToActivate.id}).`, 'info');
                }
            }
        } else if (anyFillOccurred && activeOrders.length > 0) {
            // Opposite side or general maintenance: Physical Rotation
            // We rotate the furthest order to the spread center to follow the market move.
            const sortedActive = activeOrders.sort((a, b) => b.price - a.price); // FURTHEST first (Highest price for both sides)
            const furthestActive = sortedActive[0];
            const nearPrice = spreadSlots.length > 0 ? spreadSlots[0].price : null;

            if (furthestActive && nearPrice) {
                const nearSlot = slots.find(s => s.state === ORDER_STATES.VIRTUAL && !s.orderId && !excludeIds.has(s.id));
                if (nearSlot) {
                    const idx = slots.findIndex(s => s.id === nearSlot.id);
                    const idealSize = idealSizes[idx];

                    ordersToRotate.push({
                        oldOrder: { ...furthestActive },
                        newPrice: nearPrice,
                        newSize: idealSize,
                        newGridId: nearSlot.id,
                        type: type
                    });
                    mgr._updateOrder({ ...furthestActive, state: ORDER_STATES.VIRTUAL });
                    mgr._updateOrder({ ...nearSlot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE, price: nearPrice });
                    mgr.logger.log(`[UNIFIED] Rotation: Shifting furthest ${type} ${furthestActive.id} -> near price ${nearPrice.toFixed(4)}.`, 'info');
                }
            }
        }

        // 4. Surplus Management (Count Correction)
        // If still over target (e.g. after multiple fills), cancel furthest.
        const updatedActiveCount = slots.filter(s => (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && s.orderId).length;
        if (updatedActiveCount > targetCount) {
            const surplusCount = updatedActiveCount - targetCount;
            // FURTHEST from spread: BUY = lowest price (sort a-b), SELL = highest price (sort b-a)
            const toCancelCandidates = slots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL));
            const sortedForSurplus = toCancelCandidates.sort((a, b) => type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);
            const toCancel = sortedForSurplus.slice(0, surplusCount);

            for (const order of toCancel) {
                if (ordersToRotate.some(r => r.oldOrder.id === order.id)) continue; // Don't cancel what we're rotating
                ordersToCancel.push({ ...order });
                mgr._updateOrder({ ...order, state: ORDER_STATES.VIRTUAL, orderId: null });
                mgr.logger.log(`[UNIFIED] Surplus: Cancelling furthest ${type} order ${order.id} to restore target count.`, 'info');
            }
        }

        // 5. Standardization (Resize & Merge)
        const currentOnChain = slots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL));
        for (const slot of currentOnChain) {
            if (ordersToRotate.some(r => r.oldOrder.id === slot.id) || ordersToCancel.some(c => c.id === slot.id)) continue;
            
            const idx = slots.findIndex(s => s.id === slot.id);
            const idealSize = idealSizes[idx];

            if (slot.state === ORDER_STATES.PARTIAL) {
                const dustThreshold = idealSize * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
                if (slot.size < dustThreshold) {
                    const mergedSize = idealSize + slot.size;
                    ordersToUpdate.push({ partialOrder: { ...slot }, newSize: mergedSize, isSplitUpdate: true, newState: ORDER_STATES.ACTIVE });
                    mgr._updateOrder({ ...slot, size: mergedSize, state: ORDER_STATES.ACTIVE });
                    mgr.logger.log(`[UNIFIED] Merge: Dust partial ${slot.id} refilled to ${mergedSize.toFixed(precision)}.`, 'info');
                } else {
                    ordersToUpdate.push({ partialOrder: { ...slot }, newSize: idealSize, isSplitUpdate: true, newState: ORDER_STATES.ACTIVE });
                    mgr._updateOrder({ ...slot, size: idealSize, state: ORDER_STATES.ACTIVE });
                    mgr.logger.log(`[UNIFIED] Anchor: Substantial partial ${slot.id} resized to ideal.`, 'info');
                }
            } else if (Math.abs(slot.size - idealSize) > 1e-8) {
                ordersToUpdate.push({ partialOrder: { ...slot }, newSize: idealSize, isSplitUpdate: true, newState: ORDER_STATES.ACTIVE });
                mgr._updateOrder({ ...slot, size: idealSize });
                mgr.logger.log(`[UNIFIED] Resize: Standardizing active ${slot.id} to ${idealSize.toFixed(precision)}.`, 'info');
            }
        }

        return { ordersToPlace, ordersToRotate, ordersToUpdate, ordersToCancel };
    }

    /**
     * Complete an order rotation after blockchain confirmation.
     */
    completeOrderRotation(oldOrderInfo) {
        const mgr = this.manager;
        const oldGridOrder = mgr.orders.get(oldOrderInfo.id);
        if (oldGridOrder && oldGridOrder.orderId === oldOrderInfo.orderId) {
            const size = oldGridOrder.size || 0;
            if (oldGridOrder.type === ORDER_TYPES.BUY) mgr.accountTotals.buyFree = (mgr.accountTotals.buyFree || 0) + size;
            else if (oldGridOrder.type === ORDER_TYPES.SELL) mgr.accountTotals.sellFree = (mgr.accountTotals.sellFree || 0) + size;

            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr._updateOrder(updatedOld);
            mgr.logger.log(`Rotated order ${oldOrderInfo.id} -> VIRTUAL (capital preserved).`, 'info');
        }
    }

    /**
     * Process filled orders and trigger rebalance.
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!mgr || !Array.isArray(filledOrders)) return;

        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders`, 'info');
        mgr.pauseFundRecalc();

        try {
            const hasBtsPair = (mgr.config?.assetA === 'BTS' || mgr.config?.assetB === 'BTS');
            let fillsToSettle = 0;

            for (const filledOrder of filledOrders) {
                if (excludeOrderIds?.has?.(filledOrder.id)) continue;
                
                const isPartial = filledOrder.isPartial === true;
                if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                    fillsToSettle++;
                    // Release capital immediately
                    mgr._updateOrder({ ...filledOrder, state: ORDER_STATES.VIRTUAL, orderId: null });
                }

                // Balance Accounting
                if (filledOrder.type === ORDER_TYPES.SELL) {
                    mgr.funds.cacheFunds.buy = (mgr.funds.cacheFunds.buy || 0) + (filledOrder.size * filledOrder.price);
                } else {
                    mgr.funds.cacheFunds.sell = (mgr.funds.cacheFunds.sell || 0) + (filledOrder.size / filledOrder.price);
                }
            }

            if (hasBtsPair && fillsToSettle > 0) {
                const btsFeeData = getAssetFees('BTS', 0);
                mgr.funds.btsFeesOwed += fillsToSettle * btsFeeData.total;
                await mgr.accountant.deductBtsFees();
            }

            mgr.recalculateFunds();
            await mgr._persistCacheFunds();

            const result = await this.rebalance(filledOrders, excludeOrderIds);

            if (hasBtsPair && (result.ordersToRotate.length > 0 || result.ordersToUpdate.length > 0)) {
                const btsFeeData = getAssetFees('BTS', 0);
                const updateCount = result.ordersToRotate.length + result.ordersToUpdate.length;
                mgr.funds.btsFeesOwed += updateCount * btsFeeData.updateFee;
            }

            mgr.recalculateFunds();
            mgr.logger.logFundsStatus(mgr, `AFTER processFilledOrders`);

            return result;
        } finally {
            mgr.resumeFundRecalc();
        }
    }
}

module.exports = StrategyEngine;
