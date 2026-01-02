/**
 * modules/order/sync_engine.js
 *
 * Specialized engine for blockchain synchronization.
 * Responsible for matching chain orders to the grid and processing fill history.
 */

const { ORDER_TYPES, ORDER_STATES } = require('../constants');
const { 
    blockchainToFloat, 
    floatToBlockchainInt, 
    calculatePriceTolerance, 
    findMatchingGridOrderByOpenOrder, 
    applyChainSizeToGridOrder, 
    convertToSpreadPlaceholder,
    hasValidAccountTotals,
    formatOrderSize
} = require('./utils');

class SyncEngine {
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Sync grid orders from fresh blockchain open orders.
     */
    syncFromOpenOrders(chainOrders, fillInfo = null) {
        const mgr = this.manager;
        if (!chainOrders || !Array.isArray(chainOrders)) {
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        const assetAPrecision = mgr.assets?.assetA?.precision || 5;
        const assetBPrecision = mgr.assets?.assetB?.precision || 5;

        const parsedChainOrders = new Map();
        for (const order of chainOrders) {
            const sellAssetId = order.sell_price.base.asset_id;
            const receiveAssetId = order.sell_price.quote.asset_id;
            const type = (sellAssetId === mgr.assets.assetA.id) ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
            const precision = (type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
            const size = blockchainToFloat(order.for_sale, precision);
            const price = (type === ORDER_TYPES.SELL) 
                ? (Number(order.sell_price.quote.amount) / Number(order.sell_price.base.amount)) * Math.pow(10, assetBPrecision - assetAPrecision)
                : (Number(order.sell_price.base.amount) / Number(order.sell_price.quote.amount)) * Math.pow(10, assetBPrecision - assetAPrecision);
            parsedChainOrders.set(order.id, { id: order.id, type, size, price, raw: order });
        }

        const chainOrderIdsOnGrid = new Set();
        const matchedGridOrderIds = new Set();
        const filledOrders = [];
        const updatedOrders = [];
        const ordersNeedingCorrection = [];

        for (const gridOrder of mgr.orders.values()) {
            if (gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) {
                const chainOrder = parsedChainOrders.get(gridOrder.orderId);
                const updatedOrder = { ...gridOrder };
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                matchedGridOrderIds.add(gridOrder.id);

                const priceTolerance = calculatePriceTolerance(gridOrder.price, gridOrder.size, gridOrder.type, mgr.assets);
                if (Math.abs(chainOrder.price - gridOrder.price) > priceTolerance) {
                    ordersNeedingCorrection.push({ gridOrder: { ...gridOrder }, chainOrderId: gridOrder.orderId, expectedPrice: gridOrder.price, actualPrice: chainOrder.price, size: chainOrder.size, type: gridOrder.type });
                }

                const precision = (gridOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const currentSizeInt = floatToBlockchainInt(gridOrder.size, precision);
                const chainSizeInt = floatToBlockchainInt(chainOrder.size, precision);

                if (currentSizeInt !== chainSizeInt) {
                    const newSize = blockchainToFloat(chainSizeInt, precision);
                    const newInt = floatToBlockchainInt(newSize, precision);

                    if (newInt > 0) {
                        applyChainSizeToGridOrder(mgr, updatedOrder, newSize);
                        if (updatedOrder.state === ORDER_STATES.ACTIVE) {
                            updatedOrder.state = ORDER_STATES.PARTIAL;
                        }
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                        mgr._updateOrder(spreadOrder);
                        filledOrders.push({ ...gridOrder });
                        updatedOrders.push(spreadOrder);
                        continue;
                    }
                }
                mgr._updateOrder(updatedOrder);
                updatedOrders.push(updatedOrder);
            } else if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                if (gridOrder.orderId && !parsedChainOrders.has(gridOrder.orderId)) {
                    const filledOrder = { ...gridOrder };
                    const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                    mgr._updateOrder(spreadOrder);
                    filledOrders.push(filledOrder);
                }
            }
        }

        for (const [chainOrderId, chainOrder] of parsedChainOrders) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue;
            let bestMatch = findMatchingGridOrderByOpenOrder({ orderId: chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size }, { orders: mgr.orders, ordersByState: mgr._ordersByState, assets: mgr.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets), logger: mgr.logger });

            if (bestMatch && !matchedGridOrderIds.has(bestMatch.id)) {
                bestMatch.orderId = chainOrderId;
                bestMatch.state = ORDER_STATES.ACTIVE;
                matchedGridOrderIds.add(bestMatch.id);

                const precision = (bestMatch.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                if (floatToBlockchainInt(bestMatch.size, precision) !== floatToBlockchainInt(chainOrder.size, precision)) {
                    applyChainSizeToGridOrder(mgr, bestMatch, chainOrder.size);
                    if (floatToBlockchainInt(chainOrder.size, precision) > 0) {
                        if (bestMatch.state === ORDER_STATES.ACTIVE) bestMatch.state = ORDER_STATES.PARTIAL;
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(bestMatch);
                        filledOrders.push({ ...bestMatch });
                        bestMatch = spreadOrder;
                    }
                }
                mgr._updateOrder(bestMatch);
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            }
        }
        return { filledOrders, updatedOrders, ordersNeedingCorrection };
    }

    /**
     * Sync from a single fill history operation.
     */
    syncFromFillHistory(fillOp) {
        const mgr = this.manager;
        if (!fillOp || !fillOp.order_id) return { filledOrders: [], updatedOrders: [], partialFill: false };

        const orderId = fillOp.order_id;
        const paysAmount = fillOp.pays ? Number(fillOp.pays.amount) : 0;
        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;

        const assetAPrecision = mgr.assets?.assetA?.precision || 5;
        const assetBPrecision = mgr.assets?.assetB?.precision || 5;

        let matchedGridOrder = null;
        for (const gridOrder of mgr.orders.values()) {
            if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                matchedGridOrder = gridOrder;
                break;
            }
        }

        if (!matchedGridOrder) return { filledOrders: [], updatedOrders: [], partialFill: false };

        const orderType = matchedGridOrder.type;
        const currentSize = Number(matchedGridOrder.size || 0);
        let filledAmount = 0;
        if (orderType === ORDER_TYPES.SELL) {
            if (paysAssetId === mgr.assets.assetA.id) filledAmount = blockchainToFloat(paysAmount, assetAPrecision);
        } else {
            if (paysAssetId === mgr.assets.assetB.id) filledAmount = blockchainToFloat(paysAmount, assetBPrecision);
        }

        const precision = (orderType === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
        const currentSizeInt = floatToBlockchainInt(currentSize, precision);
        const filledAmountInt = floatToBlockchainInt(filledAmount, precision);
        const newSizeInt = Math.max(0, currentSizeInt - filledAmountInt);
        const newSize = blockchainToFloat(newSizeInt, precision);

        const filledOrders = [];
        const updatedOrders = [];
        if (newSizeInt <= 0) {
            const filledOrder = { ...matchedGridOrder };
            const spreadOrder = convertToSpreadPlaceholder(matchedGridOrder);
            mgr._updateOrder(spreadOrder);
            filledOrders.push(filledOrder);
            return { filledOrders, updatedOrders, partialFill: false };
        } else {
            const filledPortion = { ...matchedGridOrder, size: filledAmount, isPartial: true };
            const updatedOrder = { ...matchedGridOrder };
            updatedOrder.state = ORDER_STATES.PARTIAL;
            applyChainSizeToGridOrder(mgr, updatedOrder, newSize);

            if (updatedOrder.isDoubleOrder && updatedOrder.mergedDustSize) {
                updatedOrder.filledSinceRefill = (Number(updatedOrder.filledSinceRefill) || 0) + filledAmount;
                const mergedDustSize = Number(updatedOrder.mergedDustSize);
                if (updatedOrder.filledSinceRefill >= mergedDustSize) {
                    filledPortion.isDelayedRotationTrigger = true;
                    updatedOrder.state = ORDER_STATES.ACTIVE;
                    updatedOrder.isDoubleOrder = false;
                    updatedOrder.pendingRotation = false;
                    updatedOrder.filledSinceRefill = 0;
                } else {
                    updatedOrder.state = ORDER_STATES.ACTIVE;
                }
            }
            mgr._updateOrder(updatedOrder);
            updatedOrders.push(updatedOrder);
            filledOrders.push(filledPortion);
            return { filledOrders, updatedOrders, partialFill: true };
        }
    }

    /**
     * High-level synchronization with blockchain data.
     */
    async synchronizeWithChain(chainData, source) {
        const mgr = this.manager;
        if (!mgr.assets) return { newOrders: [], ordersNeedingCorrection: [] };

        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId, isPartialPlacement, fee } = chainData;
                const gridOrder = mgr.orders.get(gridOrderId);
                if (gridOrder) {
                    const newState = isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                    const updatedOrder = { ...gridOrder, state: newState, orderId: chainOrderId };
                    mgr.accountant.updateOptimisticFreeBalance(gridOrder, updatedOrder, 'createOrder', fee);
                    mgr._updateOrder(updatedOrder);
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: mgr.orders, ordersByState: mgr._ordersByState, assets: mgr.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets), logger: mgr.logger });
                if (gridOrder) {
                    const updatedOrder = { ...gridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
                    mgr.accountant.updateOptimisticFreeBalance(gridOrder, updatedOrder, 'cancelOrder');
                    mgr._updateOrder(updatedOrder);
                }
                break;
            }
            case 'readOpenOrders':
            case 'periodicBlockchainFetch': {
                return this.syncFromOpenOrders(chainData);
            }
        }
        return { newOrders: [], ordersNeedingCorrection: [] };
    }

    /**
     * Fetch account balances and update totals.
     */
    async fetchAccountBalancesAndSetTotals() {
        const mgr = this.manager;
        try {
            const { BitShares } = require('../bitshares_client');
            if (!BitShares || !BitShares.db) return;
            const accountIdOrName = mgr.accountId || mgr.account || null;
            if (!accountIdOrName) return;

            try { await this.initializeAssets(); } catch (err) { }
            const assetAId = mgr.assets?.assetA?.id;
            const assetBId = mgr.assets?.assetB?.id;
            if (!assetAId || !assetBId) return;

            const { getOnChainAssetBalances } = require('../chain_orders');
            const lookup = await getOnChainAssetBalances(accountIdOrName, [assetAId, assetBId]);
            const aInfo = lookup?.[assetAId] || lookup?.[mgr.config.assetA];
            const bInfo = lookup?.[assetBId] || lookup?.[mgr.config.assetB];

            if (aInfo && bInfo) {
                mgr.setAccountTotals({ sell: aInfo.total, sellFree: aInfo.free, buy: bInfo.total, buyFree: bInfo.free });
            }
        } catch (err) {
            mgr.logger.log(`Failed to fetch on-chain balances: ${err.message}`, 'warn');
        }
    }

    /**
     * Initialize asset metadata.
     */
    async initializeAssets() {
        const mgr = this.manager;
        if (mgr.assets) return;
        try {
            const { lookupAsset } = require('./utils');
            const { BitShares } = require('../bitshares_client');
            mgr.assets = {
                assetA: await lookupAsset(BitShares, mgr.config.assetA),
                assetB: await lookupAsset(BitShares, mgr.config.assetB)
            };
        } catch (err) {
            mgr.logger.log(`Asset metadata lookup failed: ${err.message}`, 'error');
            throw err;
        }
    }
}

module.exports = SyncEngine;
