/**
 * modules/order/utils/system.js - System and I/O Utilities
 * 
 * Price derivation, persistence, grid comparisons, and UI/interactive utilities.
 */

const fs = require('fs');
const path = require('path');
const { API_LIMITS, TIMING, ORDER_TYPES, ORDER_STATES } = require('../../constants');
const Format = require('../format');
const { toFiniteNumber, isValidNumber } = Format;
const MathUtils = require('./math');
const OrderUtils = require('./order');

// ================================================================================
// SECTION 4: PRICE DERIVATION
// ================================================================================

const poolIdCache = new Map();

/**
 * Enhanced blockchainToFloat that allows precision 0
 */
function safeBlockchainToFloat(amount, precision) {
    const p = (typeof precision === 'number') ? precision : 0;
    return Number(amount) / Math.pow(10, p);
}

const lookupAsset = async (BitShares, s) => {
    if (!BitShares) return null;
    const sym = s.toLowerCase();
    let cached = BitShares.assets ? BitShares.assets[sym] : null;

    if (cached?.id && typeof cached.precision === 'number') {
        return cached;
    }

    const methods = [
        () => BitShares.db.lookup_asset_symbols([s]),
        () => BitShares.db.get_assets([s])
    ];

    for (const method of methods) {
        try {
            if (typeof method !== 'function') continue;
            const r = await method();
            if (r?.[0]?.id && typeof r[0].precision === 'number') {
                return { ...(cached || {}), ...r[0] };
            }
        } catch (e) {}
    }

    throw new Error(`CRITICAL: Cannot fetch asset precision for '${s}'`);
};

const deriveMarketPrice = async (BitShares, symA, symB) => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        const baseId = aMeta.id;
        const quoteId = bMeta.id;
        let mid = null;

        if (typeof BitShares.db?.get_order_book === 'function') {
            try {
                const ob = await BitShares.db.get_order_book(baseId, quoteId, API_LIMITS.ORDERBOOK_DEPTH);
                const bestBid = isValidNumber(ob.bids?.[0]?.price) ? Number(ob.bids[0].price) : null;
                const bestAsk = isValidNumber(ob.asks?.[0]?.price) ? Number(ob.asks[0].price) : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            } catch (e) {}
        }

        if (mid === null && typeof BitShares.db?.get_ticker === 'function') {
            try {
                const t = await BitShares.db.get_ticker(baseId, quoteId);
                mid = isValidNumber(t?.latest) ? Number(t.latest) : (isValidNumber(t?.latest_price) ? Number(t.latest_price) : null);
            } catch (err) {}
        }

        // BitShares get_order_book(A, B) returns prices in A/B format (base/quote).
        // We want B/A orientation (how much B per 1 A), so invert.
        return (mid !== null && mid !== 0) ? 1 / mid : null;
    } catch (err) {
        return null;
    }
};

const derivePoolPrice = async (BitShares, symA, symB) => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        let chosen = null;
        const cacheKey = [aMeta.id, bMeta.id].sort().join(':');
        const cachedPoolId = poolIdCache.get(cacheKey);

        if (typeof BitShares.db?.get_liquidity_pool_by_asset_ids === 'function') {
            try {
                chosen = await BitShares.db.get_liquidity_pool_by_asset_ids(aMeta.id, bMeta.id);
                if (chosen) poolIdCache.set(cacheKey, chosen.id);
            } catch (e) {}
        }

        if (!chosen && cachedPoolId && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [pool] = await BitShares.db.get_objects([cachedPoolId]);
                if (pool) chosen = pool;
            } catch (e) {
                poolIdCache.delete(cacheKey);
            }
        }

        if (!chosen) {
            const listFn = BitShares.db?.list_liquidity_pools || BitShares.db?.get_liquidity_pools;
            if (typeof listFn === 'function') {
                try {
                    const pools = await listFn(100, '1.19.0');
                    chosen = pools.find(p => {
                        const ids = (p.asset_ids || [p.asset_a, p.asset_b]).map(String);
                        return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                    });
                    if (chosen) {
                        poolIdCache.set(cacheKey, chosen.id);
                    } else {
                        // [DIAG] Pool not found in initial batch
                    }
                } catch (e) {}
            }
        }

        if (!chosen) return null;

        if (!chosen.reserves && !isValidNumber(chosen.balance_a) && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [full] = await BitShares.db.get_objects([chosen.id]);
                if (full) chosen = full;
            } catch (e) {}
        }

        let amtA = null, amtB = null;
        if (isValidNumber(chosen.balance_a) && isValidNumber(chosen.balance_b)) {
            // Pools store assets ordered by ID: lower ID is always first (asset_a)
            const aIdNum = Number(String(aMeta.id).split('.')[2]);
            const bIdNum = Number(String(bMeta.id).split('.')[2]);
            const aIsFirst = aIdNum < bIdNum;

            // If config's assetA has lower ID, it's the pool's first asset (asset_a)
            // Otherwise, our assetA corresponds to pool's second asset (asset_b)
            if (aIsFirst) {
                amtA = Number(chosen.balance_a);
                amtB = Number(chosen.balance_b);
            } else {
                amtA = Number(chosen.balance_b);
                amtB = Number(chosen.balance_a);
            }
        } else if (Array.isArray(chosen.reserves)) {
            const resA = chosen.reserves.find(r => String(r.asset_id) === String(aMeta.id));
            const resB = chosen.reserves.find(r => String(r.asset_id) === String(bMeta.id));
            if (resA && resB) {
                amtA = resA.amount;
                amtB = resB.amount;
            }
        }

        if (!isValidNumber(amtA) || !isValidNumber(amtB) || Number(amtB) === 0) return null;

        const floatA = safeBlockchainToFloat(amtA, aMeta.precision);
        const floatB = safeBlockchainToFloat(amtB, bMeta.precision);

        // Return B/A orientation to match market price format
        return floatB > 0 ? floatB / floatA : null;
    } catch (err) {
        return null;
    }
};

const derivePrice = async (BitShares, symA, symB, mode = 'auto') => {
    mode = String(mode).toLowerCase();
    
    let poolP = null;
    if (mode === 'pool' || mode === 'auto') {
        poolP = await derivePoolPrice(BitShares, symA, symB).catch(() => null);
        if (poolP > 0) return poolP;
    }
    
    if (mode === 'market' || mode === 'auto' || mode === 'pool') {
        const m = await deriveMarketPrice(BitShares, symA, symB).catch(() => null);
        if (m > 0) return m;
    }
    
    return null;
};

// ================================================================================
// SECTION 6: FEE MANAGEMENT (INIT)
// ================================================================================

async function initializeFeeCache(botsConfig, BitShares) {
    const uniqueAssets = new Set(['BTS']);
    for (const bot of botsConfig) {
        if (bot.assetA) uniqueAssets.add(bot.assetA);
        if (bot.assetB) uniqueAssets.add(bot.assetB);
    }

    const cache = {};
    for (const assetSymbol of uniqueAssets) {
        try {
            if (assetSymbol === 'BTS') {
                const globalProps = await BitShares.db.getGlobalProperties();
                const currentFees = globalProps.parameters.current_fees.parameters;
                const findFee = (opCode) => {
                    const param = currentFees.find(p => p[0] === opCode);
                    const fee = param?.[1]?.fee;
                    const feeNum = toFiniteNumber(fee);
                    return {
                        raw: feeNum,
                        satoshis: feeNum,
                        bts: safeBlockchainToFloat(feeNum, 5)
                    };
                };
                cache.BTS = {
                    limitOrderCreate: findFee(1),
                    limitOrderCancel: findFee(2),
                    limitOrderUpdate: findFee(77)
                };
            } else {
                const fullAsset = await lookupAsset(BitShares, assetSymbol);
                const options = fullAsset.options || {};
                cache[assetSymbol] = {
                    assetId: fullAsset.id,
                    symbol: assetSymbol,
                    precision: fullAsset.precision,
                    marketFee: { percent: (options.market_fee_percent || 0) / 100 },
                    takerFee: options.taker_fee_percent ? { percent: options.taker_fee_percent / 100 } : null,
                    maxMarketFee: {
                        raw: options.max_market_fee || 0,
                        float: safeBlockchainToFloat(options.max_market_fee || 0, fullAsset.precision)
                    }
                };
            }
        } catch (error) {}
    }

    MathUtils._setFeeCache(cache);
    return cache;
}

// ================================================================================
// SECTION 7: GRID STATE MANAGEMENT
// ================================================================================

async function persistGridSnapshot(manager, accountOrders, botKey) {
    if (!manager || !accountOrders || !botKey) return false;
    try {
        await accountOrders.storeMasterGrid(
            botKey,
            Array.from(manager.orders.values()),
            manager.funds.cacheFunds,
            manager.funds.btsFeesOwed,
            manager.boundaryIdx,
            manager.assets || null,
            { buySideIsDoubled: !!manager.buySideIsDoubled, sellSideIsDoubled: !!manager.sellSideIsDoubled }
        );
        return true;
    } catch (e) {
        return false;
    }
}

async function retryPersistenceIfNeeded(manager) {
    if (!manager || !manager._persistenceWarning) return true;
    const warning = manager._persistenceWarning;
    try {
        const success = typeof manager.persistGrid === 'function' ? await manager.persistGrid() : true;
        if (success) delete manager._persistenceWarning;
        return success;
    } catch (e) { return false; }
}

async function runGridComparisons(manager, accountOrders, botKey) {
    if (!manager || !accountOrders) return;
    try {
        const Grid = require('../grid');
        const persistedGrid = accountOrders.loadBotGrid(botKey, true) || [];
        const simpleCheckResult = Grid.checkAndUpdateGridIfNeeded(manager, manager.funds.cacheFunds);
        if (!simpleCheckResult.buyUpdated && !simpleCheckResult.sellUpdated) {
            await Grid.compareGrids(Array.from(manager.orders.values()), persistedGrid, manager, manager.funds.cacheFunds);
        }
    } catch (e) {}
}

async function applyGridDivergenceCorrections(manager, accountOrders, botKey, updateOrdersOnChainBatchFn) {
    if (!manager._correctionsLock) return;
    const Grid = require('../grid');

    await manager._correctionsLock.acquire(async () => {
        if (!manager._gridSidesUpdated || manager._gridSidesUpdated.size === 0) return;

        if (manager.outOfSpread > 0) {
            if (syncBoundaryToFunds(manager)) {
                await Grid.updateGridFromBlockchainSnapshot(manager, 'both', true);
            }
        }

        for (const orderType of manager._gridSidesUpdated) {
            const sideName = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
            const currentActiveOrders = Array.from(manager.orders.values())
                .filter(o => o.type === orderType && o.orderId && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL));

            const allSideSlots = Array.from(manager.orders.values())
                .filter(o => o.type === orderType)
                .sort((a, b) => sideName === 'buy' ? b.price - a.price : a.price - b.price);

            const baseTargetCount = (manager.config.activeOrders && Number.isFinite(manager.config.activeOrders[sideName]))
                ? Math.max(1, manager.config.activeOrders[sideName])
                : currentActiveOrders.length;

            const isDoubledSide = orderType === ORDER_TYPES.BUY ? manager.buySideIsDoubled : manager.sellSideIsDoubled;
            const targetCount = isDoubledSide ? Math.max(1, baseTargetCount - 1) : baseTargetCount;
            const desiredSlots = allSideSlots.slice(0, targetCount);
            const desiredSlotIds = new Set(desiredSlots.map(s => s.id));
            const activeBySlotId = new Map(currentActiveOrders.map(a => [a.id, a]));

            for (const active of currentActiveOrders) {
                if (desiredSlotIds.has(active.id)) {
                    const slot = desiredSlots.find(s => s.id === active.id);
                    if (slot.size > 0) {
                        manager.ordersNeedingPriceCorrection.push({
                            gridOrder: { ...slot },
                            chainOrderId: active.orderId,
                            expectedPrice: slot.price,
                            size: slot.size,
                            type: slot.type,
                            sideUpdated: sideName,
                            newGridId: (active.id !== slot.id) ? slot.id : null
                        });
                    } else {
                        manager.ordersNeedingPriceCorrection.push({ gridOrder: { ...active }, chainOrderId: active.orderId, isSurplus: true, sideUpdated: sideName });
                    }
                } else {
                    manager.ordersNeedingPriceCorrection.push({ gridOrder: { ...active }, chainOrderId: active.orderId, isSurplus: true, sideUpdated: sideName });
                }
            }

            for (const slot of desiredSlots) {
                if (!activeBySlotId.has(slot.id) && slot.size > 0) {
                    manager.ordersNeedingPriceCorrection.push({ gridOrder: { ...slot }, chainOrderId: null, expectedPrice: slot.price, size: slot.size, type: slot.type, sideUpdated: sideName, isNewPlacement: true });
                }
            }
        }

        if (manager.ordersNeedingPriceCorrection.length > 0) {
            const ordersToRotate = manager.ordersNeedingPriceCorrection.filter(c => !c.isNewPlacement && !c.isSurplus).map(c => ({
                oldOrder: { orderId: c.chainOrderId, id: c.gridOrder.id },
                newPrice: c.expectedPrice,
                newSize: c.size,
                type: c.type,
                newGridId: c.newGridId
            }));

            const ordersToPlace = manager.ordersNeedingPriceCorrection.filter(c => c.isNewPlacement).map(c => ({
                id: c.gridOrder.id,
                price: c.expectedPrice,
                size: c.size,
                type: c.type
            }));

            const ordersToCancel = manager.ordersNeedingPriceCorrection.filter(c => c.isSurplus).map(c => ({
                orderId: c.chainOrderId,
                id: c.gridOrder.id
            }));

            try {
                const result = await updateOrdersOnChainBatchFn({ ordersToPlace, ordersToRotate, ordersToCancel, partialMoves: [] });
                manager.ordersNeedingPriceCorrection = [];
                if (result && result.executed) {
                    manager.outOfSpread = 0;
                    for (const type of manager._gridSidesUpdated) {
                        if (type === ORDER_TYPES.BUY) manager.buySideIsDoubled = false;
                        if (type === ORDER_TYPES.SELL) manager.sellSideIsDoubled = false;
                    }
                    manager._gridSidesUpdated.clear();
                    await persistGridSnapshot(manager, accountOrders, botKey);
                } else {
                    manager._gridSidesUpdated.clear();
                }
            } catch (err) {
                manager.ordersNeedingPriceCorrection = [];
                manager._gridSidesUpdated.clear();
            }
        }
    });
}

function syncBoundaryToFunds(manager) {
    const availA = (manager.funds?.available?.sell || 0);
    const availB = (manager.funds?.available?.buy || 0);
    const allSlots = Array.from(manager.orders.values()).sort((a, b) => a.price - b.price);
    const gapSlots = (typeof manager.calculateGapSlots === 'function') ? manager.calculateGapSlots(manager.config.incrementPercent, manager.config.targetSpreadPercent) : (manager.targetSpreadCount || 2);
    const newIdx = OrderUtils.calculateFundDrivenBoundary(allSlots, availA, availB, manager.config.startPrice, gapSlots);
    if (newIdx !== manager.boundaryIdx) {
        manager.boundaryIdx = newIdx;
        OrderUtils.assignGridRoles(allSlots, newIdx, gapSlots, ORDER_TYPES, ORDER_STATES);
        return true;
    }
    return false;
}

// ================================================================================
// SECTION 11: UI & INTERACTIVE UTILITIES
// ================================================================================

function ensureProfilesDirectory(profilesDir) {
    if (!fs.existsSync(profilesDir)) { fs.mkdirSync(profilesDir, { recursive: true }); return true; }
    return false;
}

function readInput(prompt, options = {}) {
    return new Promise((resolve) => {
        const stdin = process.stdin; const stdout = process.stdout;
        let input = ''; stdout.write(prompt);
        const isRaw = stdin.isRaw; if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume(); stdin.setEncoding('utf8');
        const onData = (chunk) => {
            const s = String(chunk);
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (ch === '\x1b') { if (s.length === 1) { cleanup(); stdout.write('\n'); return resolve('\x1b'); } continue; }
                if (ch === '\r' || ch === '\n' || ch === '\u0004') { cleanup(); stdout.write('\n'); return resolve(input.trim()); }
                if (ch === '\u0003') { cleanup(); process.exit(); }
                if (ch === '\u007f' || ch === '\u0008') { if (input.length > 0) { input = input.slice(0, -1); stdout.write('\b \b'); } continue; }
                if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126) { input += ch; if (!options.hideEchoBack) stdout.write(options.mask || ch); }
            }
        };
        const cleanup = () => { stdin.removeListener('data', onData); if (stdin.isTTY) stdin.setRawMode(isRaw); };
        stdin.on('data', onData);
    });
}

async function readPassword(prompt) { return readInput(prompt, { mask: '*', hideEchoBack: false }); }

async function withRetry(fn, options = {}) {
    const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 10000, logger = null, operationName = 'operation' } = options;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try { return await fn(); } catch (err) {
            if (attempt === maxAttempts) throw err;
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            logger?.log?.(`${operationName} attempt ${attempt} failed. Retrying in ${delay}ms...`, 'warn');
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

module.exports = {
    lookupAsset,
    deriveMarketPrice,
    derivePoolPrice,
    derivePrice,
    initializeFeeCache,
    persistGridSnapshot,
    retryPersistenceIfNeeded,
    runGridComparisons,
    applyGridDivergenceCorrections,
    syncBoundaryToFunds,
    ensureProfilesDirectory,
    readInput,
    readPassword,
    withRetry
};