/**
 * modules/order/utils/order.js - Order Domain Utilities
 * 
 * Business rules for orders, state predicates, filtering, and reconciliation.
 */

const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../../constants');
const Format = require('../format');
const { isValidNumber, toFiniteNumber } = Format;
const MathUtils = require('./math');
const { blockchainToFloat, floatToBlockchainInt, quantizeFloat } = MathUtils;

// ================================================================================
// SECTION 5: CHAIN ORDER MATCHING & RECONCILIATION
// ================================================================================

function parseChainOrder(chainOrder, assets) {
    if (!chainOrder || !chainOrder.sell_price || !assets) return null;
    const { base, quote } = chainOrder.sell_price;
    if (!base || !quote || !base.asset_id || !quote.asset_id || base.amount === 0) return null;
    
    let price; let type;
    const precisionDelta = assets.assetA.precision - assets.assetB.precision;
    const scaleFactor = precisionDelta >= 0
        ? Math.pow(10, precisionDelta)
        : Math.pow(10, Math.abs(precisionDelta));

    if (base.asset_id === assets.assetA.id && quote.asset_id === assets.assetB.id) {
        price = precisionDelta >= 0
            ? (quote.amount / base.amount) * scaleFactor
            : (quote.amount / base.amount) / scaleFactor;
        type = ORDER_TYPES.SELL;
    } else if (base.asset_id === assets.assetB.id && quote.asset_id === assets.assetA.id) {
        price = precisionDelta >= 0
            ? (base.amount / quote.amount) * scaleFactor
            : (base.amount / quote.amount) / scaleFactor;
        type = ORDER_TYPES.BUY;
    } else return null;

    let size;
    try {
        if (chainOrder.for_sale !== undefined && chainOrder.for_sale !== null) {
            const prec = (type === ORDER_TYPES.SELL) ? assets.assetA.precision : assets.assetB.precision;
            size = blockchainToFloat(Number(chainOrder.for_sale), prec);
        }
    } catch (e) { return null; }

    return { orderId: chainOrder.id, price, type, size };
}

function findMatchingGridOrderByOpenOrder(parsedChainOrder, opts) {
    const { orders, assets, calcToleranceFn, logger } = opts || {};
    if (!parsedChainOrder || !orders) return null;

    if (parsedChainOrder.orderId) {
        for (const gridOrder of orders.values()) {
            if (gridOrder?.orderId === parsedChainOrder.orderId) return gridOrder;
        }
    }

    const chainSize = toFiniteNumber(parsedChainOrder.size);
    const chainPrice = toFiniteNumber(parsedChainOrder.price);
    const isSell = parsedChainOrder.type === ORDER_TYPES.SELL;
    const precision = isSell ? assets?.assetA?.precision : assets?.assetB?.precision;

    if (typeof precision !== 'number') return null;

    const chainInt = floatToBlockchainInt(chainSize, precision);
    let bestMatch = null;
    let bestPriceDiff = Infinity;

    for (const gridOrder of orders.values()) {
        if (!gridOrder || gridOrder.type !== parsedChainOrder.type) continue;
        if (![ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL, ORDER_STATES.VIRTUAL].includes(gridOrder.state)) continue;

        const priceDiff = Math.abs(gridOrder.price - chainPrice);
        const priceTolerance = calcToleranceFn?.(gridOrder.price, gridOrder.size, gridOrder.type) || 0;
        if (priceDiff > priceTolerance) continue;

        const gridInt = floatToBlockchainInt(gridOrder.size, precision);
        const sizeMismatch = opts?.allowSmallerChainSize ? (chainInt > gridInt + 1) : (Math.abs(gridInt - chainInt) > 1);

        if (!opts?.skipSizeMatch && sizeMismatch) continue;

        if (priceDiff < bestPriceDiff) {
            bestPriceDiff = priceDiff;
            bestMatch = gridOrder;
        }
    }

    return bestMatch;
}

function applyChainSizeToGridOrder(manager, gridOrder, chainSize, skipAccounting = false) {
    if (!manager || !gridOrder) return;
    if (gridOrder.state !== ORDER_STATES.ACTIVE && gridOrder.state !== ORDER_STATES.PARTIAL) return;

    const precision = (gridOrder.type === ORDER_TYPES.SELL) ? manager.assets?.assetA?.precision : manager.assets?.assetB?.precision;

    if (Number.isFinite(precision) && Number.isFinite(Number(chainSize))) {
        const SUSPICIOUS_SATOSHI_LIMIT = 1e15;
        const suspiciousThreshold = SUSPICIOUS_SATOSHI_LIMIT / Math.pow(10, precision);
        if (Math.abs(Number(chainSize)) > suspiciousThreshold) {
            const msg = `CRITICAL: suspicious chainSize=${chainSize} exceeds limit ${suspiciousThreshold}. Possible blockchain sync error or data corruption.`;
            manager.logger?.log?.(msg, 'error');
            throw new Error(msg);
        }
    }

    const oldSize = Number(gridOrder.size || 0);
    const newSize = Number.isFinite(Number(chainSize)) ? Number(chainSize) : oldSize;

    if (gridOrder.isDustRefill && newSize < oldSize) return;

    const delta = newSize - oldSize;
    if (floatToBlockchainInt(oldSize, precision) === floatToBlockchainInt(newSize, precision)) { 
        gridOrder.size = newSize; 
        return; 
    }
    
    gridOrder.size = newSize;
    try { manager._updateOrder(gridOrder, 'size-adjust', skipAccounting, 0); } catch (e) { }

    if (delta < 0 && manager.logger) {
        if (typeof manager.logger.logFundsStatus === 'function') manager.logger.logFundsStatus(manager);
    }
}

async function correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders) {
    const { gridOrder, chainOrderId, expectedPrice, size, type } = correctionInfo;
    const stillNeeded = manager.ordersNeedingPriceCorrection?.some(c => c.chainOrderId === chainOrderId);
    if (!stillNeeded) return { success: true, skipped: true };

    let amountToSell, minToReceive;
    if (type === ORDER_TYPES.SELL) {
        amountToSell = size;
        minToReceive = size * expectedPrice;
    } else {
        amountToSell = size;
        minToReceive = size / expectedPrice;
    }

    try {
        const updateResult = await accountOrders.updateOrder(accountName, privateKey, chainOrderId, { amountToSell, minToReceive });
        if (updateResult === null) return { success: false, error: 'skipped' };
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);
        return { success: true };
    } catch (error) {
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);
        return { success: false, error: error.message, orderGone: error.message?.includes('not found') };
    }
}

async function correctAllPriceMismatches(manager, accountName, privateKey, accountOrders) {
    if (!manager || !manager._correctionsLock) return { corrected: 0, failed: 0, results: [] };

    return await manager._correctionsLock.acquire(async () => {
        const results = [];
        let corrected = 0; let failed = 0;
        const seen = new Set();
        const ordersToCorrect = (manager.ordersNeedingPriceCorrection || []).filter(c => {
            if (!c.chainOrderId || seen.has(c.chainOrderId)) return false;
            seen.add(c.chainOrderId);
            return true;
        });

        for (const correctionInfo of ordersToCorrect) {
            const result = await correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders);
            results.push({ ...correctionInfo, result });
            if (result && result.success) corrected++; else failed++;
            await new Promise(resolve => setTimeout(resolve, TIMING.SYNC_DELAY_MS));
        }
        return { corrected, failed, results };
    });
}

// ================================================================================
// SECTION 8: ORDER UTILITIES
// ================================================================================

function buildCreateOrderArgs(order, assetA, assetB) {
    let precision = (order.type === 'sell') ? assetA?.precision : assetB?.precision;
    if (typeof precision !== 'number') throw new Error("Asset precision missing");

    let quantizedSize;
    if (order.rawOnChain?.for_sale) {
        quantizedSize = blockchainToFloat(order.rawOnChain.for_sale, precision);
    } else {
        quantizedSize = quantizeFloat(order.size, precision);
    }

    if (order.type === 'sell') {
        return { amountToSell: quantizedSize, sellAssetId: assetA.id, minToReceive: quantizedSize * order.price, receiveAssetId: assetB.id };
    } else {
        return { amountToSell: quantizedSize, sellAssetId: assetB.id, minToReceive: quantizedSize / order.price, receiveAssetId: assetA.id };
    }
}

function getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated) {
    return (buyUpdated && sellUpdated) ? 'both' : (buyUpdated ? 'buy' : 'sell');
}

function resolveConfiguredPriceBound(value, fallback, startPrice, mode) {
    const relative = MathUtils.resolveRelativePrice(value, startPrice, mode);
    if (Number.isFinite(relative)) return relative;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function virtualizeOrder(order) {
    if (!order) return order;
    return { ...order, state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null };
}

function convertToSpreadPlaceholder(order) {
    return { ...virtualizeOrder(order), type: ORDER_TYPES.SPREAD, size: 0 };
}

// ================================================================================
// SECTION 10: FILTERING & ANALYSIS
// ================================================================================

function filterOrdersByType(orders, orderType) {
    return Array.isArray(orders) ? orders.filter(o => o && o.type === orderType) : [];
}

function filterOrdersByTypeAndState(orders, orderType, excludeState = null) {
    return Array.isArray(orders) ? orders.filter(o => o && o.type === orderType && (!excludeState || o.state !== excludeState)) : [];
}

function sumOrderSizes(orders) {
    return Array.isArray(orders) ? orders.reduce((sum, o) => sum + toFiniteNumber(o.size), 0) : 0;
}

function getPartialsByType(orders) {
    if (!Array.isArray(orders)) return { buy: [], sell: [] };
    return {
        buy: orders.filter(o => o && o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL),
        sell: orders.filter(o => o && o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL)
    };
}

function countOrdersByType(orderType, ordersMap) {
    if (!ordersMap?.size) return 0;
    let count = 0;
    for (const order of ordersMap.values()) {
        if (order.type === orderType && [ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL].includes(order.state)) count++;
    }
    return count;
}

function isOrderOnChain(order) { return order?.state === ORDER_STATES.ACTIVE || order?.state === ORDER_STATES.PARTIAL; }
function isOrderVirtual(order) { return order?.state === ORDER_STATES.VIRTUAL; }
function hasOnChainId(order) { return !!order?.orderId; }
function isOrderPlaced(order) { return isOrderOnChain(order) && hasOnChainId(order); }
function isPhantomOrder(order) { return isOrderOnChain(order) && !hasOnChainId(order); }
function isSlotAvailable(order) { return isOrderVirtual(order) && !hasOnChainId(order); }

function isOrderHealthy(size, type, assets, idealSize) {
    if (!size || size <= 0) return false;
    const minAbsolute = MathUtils.getMinAbsoluteOrderSize(type, assets);
    const minHealthy = MathUtils.getDoubleDustThreshold(idealSize);
    return size >= minAbsolute && size >= minHealthy;
}

function checkSizeThreshold(sizes, threshold, precision, includeNonFinite = false) {
    if (threshold <= 0 || !Array.isArray(sizes) || sizes.length === 0) return false;
    return sizes.some(sz => {
        if (!Number.isFinite(sz)) return includeNonFinite;
        if (sz <= 0) return false;
        if (isValidNumber(precision)) return floatToBlockchainInt(sz, precision) < floatToBlockchainInt(threshold, precision);
        return sz < (threshold - 1e-8);
    });
}

function checkSizesBeforeMinimum(sizes, minSize, precision) {
    return checkSizeThreshold(sizes, minSize, precision, true);
}

// Logic helpers
function calculateIdealBoundary(allSlots, referencePrice, gapSlots) {
    if (!allSlots || allSlots.length === 0) return -1;
    let splitIdx = allSlots.findIndex(s => s.price >= referencePrice);
    if (splitIdx === -1) splitIdx = allSlots.length;
    const buySpread = Math.floor(gapSlots / 2);
    return Math.max(0, Math.min(allSlots.length - 1, splitIdx - buySpread - 1));
}

function calculateFundDrivenBoundary(allSlots, availA, availB, price, gapSlots) {
    const valA = toFiniteNumber(availA) * toFiniteNumber(price);
    const valB = toFiniteNumber(availB);
    const totalVal = valA + valB;
    if (totalVal <= 0) return Math.floor((allSlots.length - gapSlots) / 2);
    const targetBuySlots = Math.round((allSlots.length - gapSlots) * (valB / totalVal));
    return Math.max(0, Math.min(allSlots.length - gapSlots - 1, targetBuySlots - 1));
}

function assignGridRoles(allSlots, boundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES) {
    const buyEndIdx = boundaryIdx;
    const sellStartIdx = boundaryIdx + gapSlots + 1;
    allSlots.forEach((slot, i) => {
        if (slot.state !== ORDER_STATES.ACTIVE && slot.state !== ORDER_STATES.PARTIAL) {
            if (i <= buyEndIdx) slot.type = ORDER_TYPES.BUY;
            else if (i >= sellStartIdx) slot.type = ORDER_TYPES.SELL;
            else slot.type = ORDER_TYPES.SPREAD;
        }
    });
    return allSlots;
}

function shouldFlagOutOfSpread(currentSpread, nominalSpread, toleranceSteps, buyCount, sellCount, incrementPercent = 0.5) {
    if (buyCount === 0 || sellCount === 0) return 1;
    const step = 1 + (incrementPercent / 100);
    const currentSteps = Math.log(1 + (currentSpread / 100)) / Math.log(step);
    const limitSteps = (Math.log(1 + (nominalSpread / 100)) / Math.log(step)) + toleranceSteps;
    if (currentSteps <= limitSteps) return 0;
    return Math.max(1, Math.ceil(currentSteps - limitSteps));
}

module.exports = {
    parseChainOrder,
    findMatchingGridOrderByOpenOrder,
    applyChainSizeToGridOrder,
    correctOrderPriceOnChain,
    correctAllPriceMismatches,
    buildCreateOrderArgs,
    getOrderTypeFromUpdatedFlags,
    resolveConfiguredPriceBound,
    virtualizeOrder,
    convertToSpreadPlaceholder,
    filterOrdersByType,
    filterOrdersByTypeAndState,
    sumOrderSizes,
    getPartialsByType,
    countOrdersByType,
    isOrderOnChain,
    isOrderVirtual,
    hasOnChainId,
    isOrderPlaced,
    isPhantomOrder,
    isSlotAvailable,
    isOrderHealthy,
    checkSizeThreshold,
    checkSizesBeforeMinimum,
    calculateIdealBoundary,
    calculateFundDrivenBoundary,
    assignGridRoles,
    shouldFlagOutOfSpread
};
