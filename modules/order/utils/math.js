/**
 * modules/order/utils/math.js - Mathematical and Numeric Utilities
 * 
 * Pure numeric calculations, blockchain conversions, fee math, and fund allocation.
 */

const { ORDER_TYPES, FEE_PARAMETERS } = require('../../constants');
const Format = require('../format');
const { isValidNumber, toFiniteNumber } = Format;

const MAX_INT64 = 9223372036854775807;
const MIN_INT64 = -9223372036854775808;

// ================================================================================
// SECTION 1: PARSING & VALIDATION
// ================================================================================

function isNumeric(val) {
    return typeof val === 'number' || (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val)));
}

function isPercentageString(v) {
    return typeof v === 'string' && v.trim().endsWith('%');
}

function parsePercentageString(v) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    return Number.isNaN(num) ? null : num / 100.0;
}

function resolveRelativePrice(value, startPrice, mode = 'min') {
    if (typeof value === 'string') {
        if (/^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value)) {
            const multiplier = parseFloat(value.trim().toLowerCase().slice(0, -1));
            if (!Number.isNaN(multiplier) && Number.isFinite(startPrice) && multiplier !== 0) {
                return mode === 'min' ? startPrice / multiplier : startPrice * multiplier;
            }
        }
    }
    return null;
}

// ================================================================================
// SECTION 2: FUND CALCULATIONS
// ================================================================================

function computeChainFundTotals(accountTotals, committedChain) {
    const chainFreeBuy = toFiniteNumber(accountTotals?.buyFree);
    const chainFreeSell = toFiniteNumber(accountTotals?.sellFree);
    const committedChainBuy = toFiniteNumber(committedChain?.buy);
    const committedChainSell = toFiniteNumber(committedChain?.sell);

    const freePlusLockedBuy = chainFreeBuy + committedChainBuy;
    const freePlusLockedSell = chainFreeSell + committedChainSell;

    const chainTotalBuy = isValidNumber(accountTotals?.buy)
        ? Math.max(Number(accountTotals.buy), freePlusLockedBuy)
        : freePlusLockedBuy;
    const chainTotalSell = isValidNumber(accountTotals?.sell)
        ? Math.max(Number(accountTotals.sell), freePlusLockedSell)
        : freePlusLockedSell;

    return {
        chainFreeBuy,
        chainFreeSell,
        committedChainBuy,
        committedChainSell,
        freePlusLockedBuy,
        freePlusLockedSell,
        chainTotalBuy,
        chainTotalSell
    };
}

// ================================================================================
// SECTION 2A: PRECISION QUANTIZATION
// ================================================================================

/**
 * Quantize a float value by round-tripping through blockchain integer representation.
 * Converts float → blockchain int (satoshi-level precision) → float.
 * Eliminates floating-point accumulation errors.
 *
 * @param {number} value - Float value to quantize
 * @param {number} precision - Asset precision (satoshis)
 * @returns {number} Quantized float value
 */
function quantizeFloat(value, precision) {
    return blockchainToFloat(floatToBlockchainInt(value, precision), precision);
}

/**
 * Normalize an integer value by round-tripping through float representation.
 * Converts int → float (readable format) → blockchain int.
 * Ensures the integer aligns with precision boundaries.
 * Used for precision-aware comparisons.
 *
 * @param {number} value - Integer value to normalize
 * @param {number} precision - Asset precision (satoshis)
 * @returns {number} Normalized integer value
 */
function normalizeInt(value, precision) {
    return floatToBlockchainInt(blockchainToFloat(value, precision), precision);
}

/**
 * Fee cache local to math.js for getAssetFees.
 * Will be populated by system.js::initializeFeeCache.
 */
let feeCache = {};

function _setFeeCache(cache) { feeCache = cache; }
function _getFeeCache() { return feeCache; }

function getAssetFees(assetSymbol, assetAmount = null, isMaker = true) {
    const cachedFees = feeCache[assetSymbol];
    if (!cachedFees) {
        throw new Error(`Fees not cached for ${assetSymbol}. Call initializeFeeCache first.`);
    }

    if (assetSymbol === 'BTS') {
        const orderCreationFee = cachedFees.limitOrderCreate.bts;
        const orderUpdateFee = cachedFees.limitOrderUpdate.bts;
        const makerNetFee = orderCreationFee * FEE_PARAMETERS.MAKER_FEE_PERCENT;
        const takerNetFee = orderCreationFee * FEE_PARAMETERS.TAKER_FEE_PERCENT;
        const netFee = isMaker ? makerNetFee : takerNetFee;

        if (assetAmount !== null && assetAmount !== undefined) {
            const amount = Number(assetAmount);
            const refund = isMaker ? (orderCreationFee * FEE_PARAMETERS.MAKER_REFUND_PERCENT) : 0;
            const netProceeds = amount + refund;
            return {
                netProceeds: netProceeds,
                total: netProceeds,
                refund: refund,
                isMaker: isMaker
            };
        }

        return {
            total: netFee + orderUpdateFee,
            createFee: orderCreationFee,
            updateFee: orderUpdateFee,
            makerNetFee: makerNetFee,
            takerNetFee: takerNetFee,
            netFee: netFee,
            isMaker: isMaker
        };
    }

    const feePercent = isMaker
        ? (cachedFees.marketFee?.percent || 0)
        : (cachedFees.takerFee?.percent || cachedFees.marketFee?.percent || 0);

    if (assetAmount !== null && assetAmount !== undefined) {
        const amount = Number(assetAmount);
        const feeAmount = (amount * feePercent) / 100;
        const netProceeds = amount - feeAmount;
        return {
            netProceeds: netProceeds,
            total: netProceeds,
            feeAmount: feeAmount,
            feePercent: feePercent,
            isMaker: isMaker
        };
    }

    return {
        marketFee: cachedFees.marketFee?.percent || 0,
        takerFee: cachedFees.takerFee?.percent || 0,
        percent: feePercent
    };
}

function calculateAvailableFundsValue(side, accountTotals, funds, assetA, assetB, activeOrders = null) {
    if (side !== 'buy' && side !== 'sell') return 0;

    const chainFree = toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree);
    const virtualReservation = toFiniteNumber(side === 'buy' ? funds.virtual?.buy : funds.virtual?.sell);
    const btsFeesOwed = toFiniteNumber(funds.btsFeesOwed);
    const btsSide = (assetA === 'BTS') ? 'sell' : (assetB === 'BTS') ? 'buy' : null;

    let btsFeesReservation = 0;
    if (btsSide === side && activeOrders) {
        try {
            const targetBuy = Math.max(0, toFiniteNumber(activeOrders?.buy, 1));
            const targetSell = Math.max(0, toFiniteNumber(activeOrders?.sell, 1));
            const totalTargetOrders = targetBuy + targetSell;

            if (totalTargetOrders > 0) {
                const btsFeeData = getAssetFees('BTS');
                btsFeesReservation = btsFeeData.createFee * totalTargetOrders * FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;
            }
        } catch (err) {
            btsFeesReservation = FEE_PARAMETERS.BTS_FALLBACK_FEE;
        }
    }

    const currentFeesOwed = (btsSide === side) ? btsFeesOwed : 0;
    return Math.max(0, chainFree - virtualReservation - currentFeesOwed - btsFeesReservation);
}

function calculateSpreadFromOrders(activeBuys, activeSells) {
    const bestBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : null;
    const bestSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : null;

    if (bestBuy === null || bestSell === null || bestBuy === 0) return 0;
    return ((bestSell / bestBuy) - 1) * 100;
}

function resolveConfigValue(value, total) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const p = parsePercentageString(value);
        if (p !== null) {
            if (total === null || total === undefined) return 0;
            return total * p;
        }
        const n = parseFloat(value);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

function hasValidAccountTotals(accountTotals, checkFree = true) {
    if (!accountTotals) return false;
    const buyKey = checkFree ? 'buyFree' : 'buy';
    const sellKey = checkFree ? 'sellFree' : 'sell';
    return isValidNumber(accountTotals[buyKey]) && isValidNumber(accountTotals[sellKey]);
}

// ================================================================================
// SECTION 3: BLOCKCHAIN CONVERSIONS & PRECISION
// ================================================================================

function blockchainToFloat(intValue, precision) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for blockchainToFloat: ${precision}`);
    }
    return toFiniteNumber(intValue) / Math.pow(10, Number(precision));
}

function floatToBlockchainInt(floatValue, precision) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for floatToBlockchainInt: ${precision}`);
    }
    const p = Number(precision);
    const v = toFiniteNumber(floatValue);
    const scaled = Math.round(v * Math.pow(10, p));

    if (scaled > MAX_INT64 || scaled < MIN_INT64) {
        console.warn(`[floatToBlockchainInt] Overflow detected: ${floatValue} with precision ${p} resulted in ${scaled}. Clamping to safe limits.`);
        return scaled > 0 ? MAX_INT64 : MIN_INT64;
    }

    return scaled;
}

function getPrecisionByOrderType(assets, orderType) {
    const asset = orderType === ORDER_TYPES.SELL ? assets?.assetA : assets?.assetB;
    const side = orderType === ORDER_TYPES.SELL ? 'SELL' : 'BUY';

    if (typeof asset?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for ${side} orders. Asset: ${asset?.symbol || '(unknown)'}. Cannot determine blockchain precision.`;
        console.error(`[getPrecisionByOrderType] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    return asset.precision;
}

function getPrecisionForSide(assets, side) {
    const asset = side === 'buy' ? assets?.assetB : assets?.assetA;
    const sideUpper = side === 'buy' ? 'BUY' : 'SELL';

    if (typeof asset?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for ${sideUpper} side. Asset: ${asset?.symbol || '(unknown)'}. Cannot determine blockchain precision.`;
        console.error(`[getPrecisionForSide] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    return asset.precision;
}

function getPrecisionsForManager(assets) {
    if (typeof assets?.assetA?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for assetA (${assets?.assetA?.symbol || '(unknown)'}). Cannot determine blockchain precision.`;
        console.error(`[getPrecisionsForManager] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    if (typeof assets?.assetB?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for assetB (${assets?.assetB?.symbol || '(unknown)'}). Cannot determine blockchain precision.`;
        console.error(`[getPrecisionsForManager] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    return {
        A: assets.assetA.precision,
        B: assets.assetB.precision
    };
}

function getPrecisionSlack(precision, factor = 2) {
    return factor * Math.pow(10, -precision);
}

// ================================================================================
// SECTION 4: PRICE OPERATIONS (PART 1 - Tolerance)
// ================================================================================

function calculatePriceTolerance(gridPrice, orderSize, orderType, assets = null) {
    if (!isValidNumber(gridPrice) || !isValidNumber(orderSize)) return null;
    if (!assets) throw new Error("CRITICAL: Assets object required for calculatePriceTolerance");

    const precisionA = assets.assetA?.precision;
    const precisionB = assets.assetB?.precision;

    if (typeof precisionA !== 'number' || typeof precisionB !== 'number') {
        throw new Error(`CRITICAL: Missing precision for price tolerance (A=${precisionA}, B=${precisionB})`);
    }

    if (!orderSize || orderSize <= 0) return null;

    let orderSizeA, orderSizeB;
    if (orderType === 'sell' || orderType === 'SELL' || orderType === 'Sell') {
        orderSizeA = orderSize;
        orderSizeB = orderSize * gridPrice;
    } else {
        orderSizeB = orderSize;
        orderSizeA = orderSize / gridPrice;
    }

    const termA = 1 / (orderSizeA * Math.pow(10, precisionA));
    const termB = 1 / (orderSizeB * Math.pow(10, precisionB));
    return (termA + termB) * gridPrice;
}

function validateOrderAmountsWithinLimits(amountToSell, minToReceive, sellPrecision, receivePrecision) {
    const sellPrecFloat = Math.pow(10, toFiniteNumber(sellPrecision));
    const receivePrecFloat = Math.pow(10, toFiniteNumber(receivePrecision));

    const sellInt = Math.round(toFiniteNumber(amountToSell) * sellPrecFloat);
    const receiveInt = Math.round(toFiniteNumber(minToReceive) * receivePrecFloat);

    const withinLimits = sellInt <= MAX_INT64 && receiveInt <= MAX_INT64 && sellInt > 0 && receiveInt > 0;

    if (!withinLimits) {
        console.warn(`[validateOrderAmountsWithinLimits] Order amounts exceed safe limits or are invalid. Sell: ${amountToSell} = ${sellInt}, Receive: ${minToReceive} = ${receiveInt}. Max allowed: ${MAX_INT64}`);
    }

    return withinLimits;
}

// ================================================================================
// SECTION 5: DUST THRESHOLD & SIZE VALIDATION
// ================================================================================

function getMinOrderSize(orderType, assets, factor = 50) {
    const f = Number(factor);
    if (!f || !Number.isFinite(f) || f <= 0) return 0;

    let precision = null;
    if (assets) {
        if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
        else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
    }

    if (typeof precision !== 'number') {
        throw new Error(`CRITICAL: Cannot determine minimum order size for ${orderType} - missing precision`);
    }

    return Number(f) * Math.pow(10, -precision);
}

function getDustThresholdFactor(dustThresholdPercent = 5) {
    return (dustThresholdPercent / 100) || 0.05;
}

function getSingleDustThreshold(idealSize, dustThresholdPercent = 5) {
    if (!idealSize || idealSize <= 0) return 0;
    return idealSize * getDustThresholdFactor(dustThresholdPercent);
}

function getDoubleDustThreshold(idealSize, dustThresholdPercent = 5) {
    if (!idealSize || idealSize <= 0) return 0;
    return idealSize * getDustThresholdFactor(dustThresholdPercent) * 2;
}

function getMinAbsoluteOrderSize(orderType, assets, minFactor = 50) {
    return getMinOrderSize(orderType, assets, minFactor || 50);
}

function validateOrderSize(orderSize, orderType, assets, minFactor = 50, idealSize = null, dustThresholdPercent = 5) {
     const orderSizeFloat = toFiniteNumber(orderSize);
     const minAbsoluteSize = getMinAbsoluteOrderSize(orderType, assets, minFactor);
     
     let precision = null;
     if (assets) {
         if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
         else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
     }
     // Fallback to 8 if precision not found
     const displayPrecision = precision || 8;
     
     if (orderSizeFloat < minAbsoluteSize) {
         return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below absolute minimum (${Format.formatAmountByPrecision(minAbsoluteSize, displayPrecision)})`, minAbsoluteSize, minDustSize: null };
     }

     if (idealSize !== null && idealSize !== undefined && idealSize > 0) {
         const minDustSize = getDoubleDustThreshold(idealSize, dustThresholdPercent);
         if (orderSizeFloat < minDustSize) {
             return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below double-dust threshold (${Format.formatAmountByPrecision(minDustSize, displayPrecision)})`, minAbsoluteSize, minDustSize };
         }
     }

    if (typeof precision === 'number') {
        if (floatToBlockchainInt(orderSizeFloat, precision) <= 0) {
            return { isValid: false, reason: `Order size (${orderSizeFloat}) rounds to 0 on blockchain`, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null };
        }
    }

    return { isValid: true, reason: null, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null };
}

// ================================================================================
// SECTION 9: ORDER SIZING & ALLOCATION
// ================================================================================

function allocateFundsByWeights(totalFunds, n, weight, incrementFactor, reverse = false, minSize = 0, precision = null) {
    if (n <= 0) return [];
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

    const base = 1 - incrementFactor;
    const rawWeights = new Array(n);
    for (let i = 0; i < n; i++) {
        const idx = reverse ? (n - 1 - i) : i;
        rawWeights[i] = Math.pow(base, idx * weight);
    }

    const sizes = new Array(n).fill(0);
    const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;

    if (precision !== null && precision !== undefined) {
        const totalUnits = floatToBlockchainInt(totalFunds, precision);
        let unitsSummary = 0;
        const units = new Array(n);

        for (let i = 0; i < n; i++) {
            units[i] = Math.round((rawWeights[i] / totalWeight) * totalUnits);
            unitsSummary += units[i];
        }

        const diff = totalUnits - unitsSummary;
        if (diff !== 0 && n > 0) {
            let largestIdx = 0;
            for (let j = 1; j < n; j++) if (units[j] > units[largestIdx]) largestIdx = j;
            units[largestIdx] = Math.max(0, units[largestIdx] + diff);
        }
        for (let i = 0; i < n; i++) sizes[i] = blockchainToFloat(units[i], precision);
    } else {
        for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
    }

    return sizes;
}

function calculateOrderSizes(orders, config, sellFunds, buyFunds, minSellSize = 0, minBuySize = 0, precisionA = null, precisionB = null) {
    const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
    const incrementFactor = incrementPercent / 100;

    const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
    const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

    const sellSizes = allocateFundsByWeights(sellFunds, sellOrders.length, sellWeight, incrementFactor, false, minSellSize, precisionA);
    const buySizes = allocateFundsByWeights(buyFunds, buyOrders.length, buyWeight, incrementFactor, true, minBuySize, precisionB);

    const sellState = { sizes: sellSizes, index: 0 };
    const buyState = { sizes: buySizes, index: 0 };

    return orders.map(order => {
        let size = 0;
        if (order.type === ORDER_TYPES.SELL) size = sellState.sizes[sellState.index++] || 0;
        else if (order.type === ORDER_TYPES.BUY) size = buyState.sizes[buyState.index++] || 0;
        return { ...order, size };
    });
}

function calculateRotationOrderSizes(availableFunds, totalGridAllocation, orderCount, orderType, config, minSize = 0, precision = null) {
    if (orderCount <= 0) return [];
    const totalFunds = availableFunds + totalGridAllocation;
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(orderCount).fill(0);

    const { incrementPercent, weightDistribution } = config;
    const incrementFactor = incrementPercent / 100;
    const weight = (orderType === ORDER_TYPES.SELL) ? weightDistribution.sell : weightDistribution.buy;
    const reverse = (orderType === ORDER_TYPES.BUY);

    return allocateFundsByWeights(totalFunds, orderCount, weight, incrementFactor, reverse, minSize, precision);
}

function calculateGridSideDivergenceMetric(calculatedOrders, persistedOrders, sideName = 'unknown') {
    if (!Array.isArray(calculatedOrders) || !Array.isArray(persistedOrders)) return 0;
    if (calculatedOrders.length === 0 && persistedOrders.length === 0) return 0;

    const persistedMap = new Map(persistedOrders.filter(o => o.id).map(o => [o.id, o]));
    let sumSquaredDiff = 0;
    let matchCount = 0;
    let unmatchedCount = 0;

    for (const calcOrder of calculatedOrders) {
        const persOrder = persistedMap.get(calcOrder.id);
        if (persOrder) {
            const currentSize = toFiniteNumber(persOrder.size);
            const idealSize = toFiniteNumber(calcOrder.size);
            if (idealSize > 0) {
                const relativeDiff = (currentSize - idealSize) / idealSize;
                sumSquaredDiff += relativeDiff * relativeDiff;
                matchCount++;
            } else if (currentSize > 0) {
                sumSquaredDiff += 1.0;
                matchCount++;
            } else matchCount++;
        } else {
            sumSquaredDiff += 1.0;
            unmatchedCount++;
        }
    }

    for (const persOrder of persistedOrders) {
        if (!calculatedOrders.some(c => c.id === persOrder.id)) {
            sumSquaredDiff += 1.0;
            unmatchedCount++;
        }
    }

    const totalOrders = matchCount + unmatchedCount;
    return totalOrders > 0 ? Math.sqrt(sumSquaredDiff / totalOrders) : 0;
}

// ================================================================================
// SECTION 10: VALIDATION HELPERS
// ================================================================================

function calculateOrderCreationFees(assetA, assetB, totalOrders, feeMultiplier = FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER) {
    if (assetA !== 'BTS' && assetB !== 'BTS') return 0;
    try {
        if (totalOrders > 0) {
            const btsFeeData = getAssetFees('BTS');
            return btsFeeData.createFee * totalOrders * feeMultiplier;
        }
    } catch (err) { return FEE_PARAMETERS.BTS_FALLBACK_FEE; }
    return 0;
}

function deductOrderFeesFromFunds(buyFunds, sellFunds, fees, config, logger = null) {
    let finalBuy = buyFunds;
    let finalSell = sellFunds;
    if (fees > 0) {
        if (config?.assetB === 'BTS') {
            finalBuy = Math.max(0, buyFunds - fees);
            logger?.log?.(`Reduced available BTS (buy) funds by ${Format.formatAmount8(fees)}`, 'info');
        } else if (config?.assetA === 'BTS') {
            finalSell = Math.max(0, sellFunds - fees);
            logger?.log?.(`Reduced available BTS (sell) funds by ${Format.formatAmount8(fees)}`, 'info');
        }
    }
    return { buyFunds: finalBuy, sellFunds: finalSell };
}

module.exports = {
    isNumeric,
    isPercentageString,
    parsePercentageString,
    resolveRelativePrice,
    computeChainFundTotals,
    calculateAvailableFundsValue,
    calculateSpreadFromOrders,
    resolveConfigValue,
    hasValidAccountTotals,
    blockchainToFloat,
    floatToBlockchainInt,
    quantizeFloat,
    normalizeInt,
    getPrecisionByOrderType,
    getPrecisionForSide,
    getPrecisionsForManager,
    getPrecisionSlack,
    calculatePriceTolerance,
    validateOrderAmountsWithinLimits,
    getMinOrderSize,
    getDustThresholdFactor,
    getSingleDustThreshold,
    getDoubleDustThreshold,
    getMinAbsoluteOrderSize,
    validateOrderSize,
    getAssetFees,
    allocateFundsByWeights,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateGridSideDivergenceMetric,
    calculateOrderCreationFees,
    deductOrderFeesFromFunds,
    _setFeeCache,
    _getFeeCache
};
