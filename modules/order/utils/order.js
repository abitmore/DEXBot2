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

/**
 * Parse blockchain order into standard grid order format.
 * Extracts price, type (BUY/SELL), and size from blockchain order structure.
 * Handles precision scaling between assets.
 * 
 * @param {Object} chainOrder - Order from blockchain with sell_price and for_sale
 * @param {Object} assets - Asset metadata with assetA, assetB, and precisions
 * @returns {Object|null} Parsed order {orderId, price, type, size} or null if invalid
 */
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

/**
 * Find grid order matching a blockchain order.
 * First tries exact orderId match, then falls back to price/size matching within tolerance.
 * Used during synchronization to link blockchain orders to grid slots.
 * 
 * @param {Object} parsedChainOrder - Parsed blockchain order {orderId, price, type, size}
 * @param {Object} [opts={}] - Options object
 * @param {Map} [opts.orders] - Grid orders map to search
 * @param {Object} [opts.assets] - Asset metadata for precision
 * @param {Function} [opts.calcToleranceFn] - Function to calculate price tolerance
 * @param {Object} [opts.logger] - Optional logger
 * @param {boolean} [opts.skipSizeMatch=false] - Skip size matching check
 * @param {boolean} [opts.allowSmallerChainSize=false] - Allow chain order to be smaller
 * @returns {Object|null} Matching grid order or null if no match found
 */
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

/**
 * Update grid order size based on blockchain state.
 * Detects partial fills and updates accounting if size changed.
 * Skips dust refills (prevents unnecessary sync when size decreases).
 * 
 * Returns the updated order object or null if no update needed.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} gridOrder - Grid order to update
 * @param {number} chainSize - Size from blockchain
 * @returns {Promise<Object|null>} Updated order object or null
 * @throws {Error} If chainSize suspicious (possible data corruption)
 */
async function applyChainSizeToGridOrder(manager, gridOrder, chainSize) {
    if (!manager || !gridOrder) return null;
    if (gridOrder.state !== ORDER_STATES.ACTIVE && gridOrder.state !== ORDER_STATES.PARTIAL) return null;

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

    if (gridOrder.isDustRefill && newSize < oldSize) {
        const oldInt = floatToBlockchainInt(oldSize, precision);
        const newInt = floatToBlockchainInt(newSize, precision);
        const deltaInt = Math.max(0, oldInt - newInt);

        // Ignore only negligible one-unit quantization noise on dust refill orders.
        // Real decreases must still be synchronized to avoid stuck PARTIAL states.
        if (deltaInt <= 1) return null;
    }

    if (floatToBlockchainInt(oldSize, precision) === floatToBlockchainInt(newSize, precision)) { 
        return null; 
    }

    const updatedOrder = { ...gridOrder, size: newSize };

    const delta = newSize - oldSize;
    if (delta < 0 && manager.logger) {
        if (typeof manager.logger.logFundsStatus === 'function') manager.logger.logFundsStatus(manager);
    }
    return updatedOrder;
}

/**
 * Correct a single order's price on blockchain.
 * Cancels surplus orders; updates price for others.
 * Removes from correction queue after processing.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} correctionInfo - Correction details {gridOrder, chainOrderId, expectedPrice, size, type, isSurplus}
 * @param {string} accountName - Account name for blockchain transaction
 * @param {string} privateKey - Private key for signing
 * @param {Object} accountOrders - AccountOrders accessor for blockchain ops
 * @returns {Promise<Object>} Result {success, cancelled, skipped, error, orderGone}
 */
async function correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders) {
    const { gridOrder, chainOrderId, expectedPrice, size, type, isSurplus } = correctionInfo;
    const stillNeeded = manager.ordersNeedingPriceCorrection?.some(c => c.chainOrderId === chainOrderId);
    if (!stillNeeded) return { success: true, skipped: true };

    // Surplus/type-mismatch entries need cancellation, not a price update
    if (isSurplus) {
        try {
            const sideLabel = type === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
            manager.logger?.log?.(`[CORRECTION] Cancelling surplus/mismatched ${sideLabel} order ${chainOrderId} for slot ${gridOrder?.id || 'unknown'}`, 'info');
            await accountOrders.cancelOrder(accountName, privateKey, chainOrderId);
            manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);
            if (gridOrder && manager._applyOrderUpdate) {
                const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                await manager._applyOrderUpdate(spreadOrder, 'surplus-type-mismatch-cancel', false, 0);
            }
            return { success: true, cancelled: true };
        } catch (error) {
            manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);
            return { success: false, error: error.message, orderGone: error.message?.includes('not found') };
        }
    }

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

/**
 * Correct all pending price mismatches atomically.
 * Processes corrections sequentially with sync delays between operations.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {string} accountName - Account name for blockchain transactions
 * @param {string} privateKey - Private key for signing
 * @param {Object} accountOrders - AccountOrders accessor for blockchain ops
 * @returns {Promise<Object>} Summary {corrected, failed, results}
 */
async function correctAllPriceMismatches(manager, accountName, privateKey, accountOrders) {
    if (!manager || !manager._gridLock) return { corrected: 0, failed: 0, results: [] };

    return await manager._gridLock.acquire(async () => {
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
            const { sleep } = require('./system');
            await sleep(TIMING.SYNC_DELAY_MS);
        }
        return { corrected, failed, results };
    });
}

// ================================================================================
// SECTION 8: ORDER UTILITIES
// ================================================================================

/**
 * Build blockchain order arguments from grid order.
 * Converts grid order data to blockchain-compatible amounts and asset IDs.
 * Handles both BUY and SELL order types.
 * 
 * @param {Object} order - Grid order with type, size, price
 * @param {Object} assetA - Asset metadata with id and precision
 * @param {Object} assetB - Asset metadata with id and precision
 * @returns {Object} Blockchain args {amountToSell, sellAssetId, minToReceive, receiveAssetId}
 * @throws {Error} If asset precision missing
 */
function buildCreateOrderArgs(order, assetA, assetB) {
    let precision = (order.type === 'sell') ? assetA?.precision : assetB?.precision;
    if (typeof precision !== 'number') throw new Error("Asset precision missing");

    // IMPORTANT: create args must always come from target grid size.
    // Never reuse rawOnChain.for_sale here because stale metadata from a prior
    // slot role can inflate create amounts (e.g., SPREAD->BUY activation).
    const quantizedSize = quantizeFloat(order.size, precision);

    if (order.type === 'sell') {
        return { amountToSell: quantizedSize, sellAssetId: assetA.id, minToReceive: quantizedSize * order.price, receiveAssetId: assetB.id };
    } else {
        return { amountToSell: quantizedSize, sellAssetId: assetB.id, minToReceive: quantizedSize / order.price, receiveAssetId: assetA.id };
    }
}

/**
 * Determine which order sides were updated based on update flags.
 * 
 * @param {boolean} buyUpdated - Whether buy side was updated
 * @param {boolean} sellUpdated - Whether sell side was updated
 * @returns {string} "buy", "sell", or "both"
 */
function getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated) {
    return (buyUpdated && sellUpdated) ? 'both' : (buyUpdated ? 'buy' : 'sell');
}

/**
 * Resolve configured price bound (minPrice/maxPrice) to numeric value.
 * Supports relative expressions like "2x" and fallback defaults.
 * 
 * @param {*} value - Configured value (number, percentage, relative, or empty)
 * @param {number} fallback - Fallback value if configured value is empty
 * @param {number} startPrice - Reference price for relative expressions
 * @param {string} mode - "min" or "max" for relative calculation mode
 * @returns {number} Resolved numeric price
 * @throws {Error} If value is invalid and cannot be interpreted
 */
function resolveConfiguredPriceBound(value, fallback, startPrice, mode) {
    const configuredValue = (value === null || value === undefined || value === '') ? fallback : value;

    const relative = MathUtils.resolveRelativePrice(configuredValue, startPrice, mode);
    if (Number.isFinite(relative)) {
        return relative;
    }

    const numeric = Number(configuredValue);
    if (!Number.isFinite(numeric)) {
        const boundName = mode === 'min' ? 'minPrice' : mode === 'max' ? 'maxPrice' : 'price bound';
        throw new Error(`Invalid ${boundName}: ${String(configuredValue)}. Expected a numeric value or multiplier like 3x.`);
    }

    return numeric;
}

/**
 * Convert order to virtual state.
 * Clears on-chain ID and raw blockchain data, marks as VIRTUAL.
 * 
 * @param {Object} order - Order to virtualize
 * @returns {Object} Virtualized order (VIRTUAL state, no orderId)
 */
function virtualizeOrder(order) {
    if (!order) return order;
    return { ...order, state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null };
}

/**
 * Convert order to spread placeholder (virtual, zero-sized spread order).
 * Used when clearing order slots during rotations or rebalancing.
 * 
 * @param {Object} order - Order to convert
 * @returns {Object} Spread placeholder order (VIRTUAL, SPREAD type, zero size)
 */
function convertToSpreadPlaceholder(order) {
    return { ...virtualizeOrder(order), type: ORDER_TYPES.SPREAD, size: 0 };
}

// ================================================================================
// SECTION 10: FILTERING & ANALYSIS
// ================================================================================

/**
 * Filter orders array by type.
 * 
 * @param {Array<Object>} orders - Orders to filter
 * @param {string} orderType - Order type to match (BUY, SELL, SPREAD)
 * @returns {Array<Object>} Filtered orders of specified type
 */
function filterOrdersByType(orders, orderType) {
    return Array.isArray(orders) ? orders.filter(o => o && o.type === orderType) : [];
}

/**
 * Get partial orders grouped by type.
 * Extracts orders in PARTIAL state, organized by BUY/SELL.
 * 
 * @param {Array<Object>} orders - Orders to filter
 * @returns {Object} Object with buy and sell partial order arrays
 */
function getPartialsByType(orders) {
    if (!Array.isArray(orders)) return { buy: [], sell: [] };
    return {
        buy: orders.filter(o => o && o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL),
        sell: orders.filter(o => o && o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL)
    };
}

/**
 * Count on-chain orders of a specific type.
 * Counts only ACTIVE and PARTIAL orders (excludes VIRTUAL).
 * 
 * @param {string} orderType - Order type to count (BUY, SELL, SPREAD)
 * @param {Map} ordersMap - Orders map from manager.orders
 * @returns {number} Count of on-chain orders of type
 */
function countOrdersByType(orderType, ordersMap) {
    if (!ordersMap?.size) return 0;
    let count = 0;
    for (const order of ordersMap.values()) {
        if (order.type === orderType && [ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL].includes(order.state)) count++;
    }
    return count;
}

/**
 * Check if order is on blockchain (ACTIVE or PARTIAL state).
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order has on-chain state
 */
function isOrderOnChain(order) { return order?.state === ORDER_STATES.ACTIVE || order?.state === ORDER_STATES.PARTIAL; }

/**
 * Check if order is virtual (not on blockchain yet).
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order in VIRTUAL state
 */
function isOrderVirtual(order) { return order?.state === ORDER_STATES.VIRTUAL; }

/**
 * Check if order has on-chain ID.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order has orderId
 */
function hasOnChainId(order) { return !!order?.orderId; }

/**
 * Check if order is placed and confirmed on blockchain.
 * Must be on-chain (ACTIVE/PARTIAL) with orderId.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order is confirmed placed
 */
function isOrderPlaced(order) { return isOrderOnChain(order) && hasOnChainId(order); }

/**
 * Check if order is phantom (on-chain but missing orderId).
 * Indicates a sync error or ghost order state.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order appears on-chain but has no ID
 */
function isPhantomOrder(order) { return isOrderOnChain(order) && !hasOnChainId(order); }

/**
 * Check if slot is available for new order placement.
 * Slot must be VIRTUAL (not on-chain) and have no orderId.
 * 
 * @param {Object} order - Order/slot to check
 * @returns {boolean} True if slot available
 */
function isSlotAvailable(order) { return isOrderVirtual(order) && !hasOnChainId(order); }

/**
 * Check if order size meets health thresholds.
 * Must be above absolute minimum and double-dust threshold.
 * 
 * @param {number} size - Order size to check
 * @param {string} type - Order type (BUY/SELL)
 * @param {Object} assets - Asset metadata with precisions
 * @param {number} idealSize - Ideal grid size for dust calculation
 * @returns {boolean} True if order is healthy
 */
function isOrderHealthy(size, type, assets, idealSize) {
    if (!size || size <= 0) return false;
    const minAbsolute = MathUtils.getMinAbsoluteOrderSize(type, assets);
    const minHealthy = MathUtils.getDoubleDustThreshold(idealSize);
    return size >= minAbsolute && size >= minHealthy;
}

/**
 * Check if any size in array falls below threshold.
 * Used for validation before order placement.
 * 
 * @param {Array<number>} sizes - Sizes to check
 * @param {number} threshold - Minimum threshold value
 * @param {number} precision - Asset precision for quantization check
 * @param {boolean} [includeNonFinite=false] - Treat non-finite values as below threshold
 * @returns {boolean} True if any size is below threshold
 */
function checkSizeThreshold(sizes, threshold, precision, includeNonFinite = false) {
    if (threshold <= 0 || !Array.isArray(sizes) || sizes.length === 0) return false;
    return sizes.some(sz => {
        if (!Number.isFinite(sz)) return includeNonFinite;
        if (sz <= 0) return false;
        if (isValidNumber(precision)) return floatToBlockchainInt(sz, precision) < floatToBlockchainInt(threshold, precision);
        return sz < (threshold - 1e-8);
    });
}

/**
 * Check if any sizes are below minimum (including non-finite values).
 * Wrapper for checkSizeThreshold with includeNonFinite=true.
 * 
 * @param {Array<number>} sizes - Sizes to check
 * @param {number} minSize - Minimum size threshold
 * @param {number} precision - Asset precision
 * @returns {boolean} True if any size is below minimum
 */
function checkSizesBeforeMinimum(sizes, minSize, precision) {
    return checkSizeThreshold(sizes, minSize, precision, true);
}

/**
 * Calculate ideal grid boundary based on reference price.
 * Places boundary near reference price with gap spacing in mind.
 * 
 * @param {Array<Object>} allSlots - All grid slots sorted by price
 * @param {number} referencePrice - Reference/anchor price
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @returns {number} Ideal boundary index or -1 if slots empty
 */
function calculateIdealBoundary(allSlots, referencePrice, gapSlots) {
    if (!allSlots || allSlots.length === 0) return -1;
    let splitIdx = allSlots.findIndex(s => s.price >= referencePrice);
    if (splitIdx === -1) splitIdx = allSlots.length;
    const buySpread = Math.floor(gapSlots / 2);
    return Math.max(0, Math.min(allSlots.length - 1, splitIdx - buySpread - 1));
}

/**
 * Calculate grid boundary based on available funds ratio.
 * Distributes buy/sell slots proportional to fund values.
 * 
 * @param {Array<Object>} allSlots - All grid slots sorted by price
 * @param {number} availA - Available assetA (sell-side capital)
 * @param {number} availB - Available assetB (buy-side capital)
 * @param {number} price - Current reference price for valuation
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @returns {number} Fund-driven boundary index
 */
function calculateFundDrivenBoundary(allSlots, availA, availB, price, gapSlots) {
    const valA = toFiniteNumber(availA) * toFiniteNumber(price);
    const valB = toFiniteNumber(availB);
    const totalVal = valA + valB;
    if (totalVal <= 0) return Math.floor((allSlots.length - gapSlots) / 2);
    const targetBuySlots = Math.round((allSlots.length - gapSlots) * (valB / totalVal));
    return Math.max(0, Math.min(allSlots.length - gapSlots - 1, targetBuySlots - 1));
}

/**
 * Assign BUY/SELL/SPREAD roles to grid slots based on boundary.
 * Slots below boundary are BUY, above boundary are SELL, between are SPREAD.
 * Can optionally override even on-chain orders.
 * 
 * @param {Array<Object>} allSlots - All grid slots to assign
 * @param {number} boundaryIdx - Boundary index
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @param {Object} ORDER_TYPES - ORDER_TYPES constants
 * @param {Object} ORDER_STATES - ORDER_STATES constants
 * @param {Object} [options={}] - Options
 * @param {boolean} [options.assignOnChain=false] - Override on-chain orders if true
 * @returns {Array<Object>} Slots with updated type assignments
 */
function assignGridRoles(allSlots, boundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, options = {}) {
    const assignOnChain = options.assignOnChain === true;
    const getCurrentSlot = (typeof options.getCurrentSlot === 'function') ? options.getCurrentSlot : null;
    const buyEndIdx = boundaryIdx;
    const sellStartIdx = boundaryIdx + gapSlots + 1;
    allSlots.forEach((slot, i) => {
        const liveSlot = getCurrentSlot ? (getCurrentSlot(slot.id) || slot) : slot;
        const canAssign = assignOnChain || !isOrderOnChain(liveSlot);
        if (canAssign) {
            if (i <= buyEndIdx) slot.type = ORDER_TYPES.BUY;
            else if (i >= sellStartIdx) slot.type = ORDER_TYPES.SELL;
            else slot.type = ORDER_TYPES.SPREAD;
        }
    });
    return allSlots;
}

/**
 * Determine if grid is out of spread and by how many steps.
 * Compares current spread against nominal with tolerance.
 * Returns number of excess steps (0 = in-spread).
 * 
 * @param {number} currentSpread - Current bid-ask spread percentage
 * @param {number} nominalSpread - Nominal spread percentage
 * @param {number} toleranceSteps - Tolerance in increment steps
 * @param {number} buyCount - Number of active buy orders
 * @param {number} sellCount - Number of active sell orders
 * @param {number} [incrementPercent=0.5] - Grid increment percentage
 * @returns {number} Excess steps (0 if in-spread, >0 if out-of-spread)
 */
function shouldFlagOutOfSpread(currentSpread, nominalSpread, toleranceSteps, buyCount, sellCount, incrementPercent = 0.5) {
    if (buyCount === 0 || sellCount === 0) return 0;
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
