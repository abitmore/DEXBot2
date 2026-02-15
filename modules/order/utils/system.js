/**
 * modules/order/utils/system.js - System and I/O Utilities
 * 
 * Price derivation, persistence, grid correction, and UI/interactive utilities.
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
 * @private Lookup asset by symbol from BitShares blockchain.
 * Tries cached assets first, then falls back to lookup API methods.
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} s - Asset symbol to lookup
 * @returns {Promise<Object>} Asset metadata with id, symbol, precision
 * @throws {Error} If asset cannot be found on blockchain
 */
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

/**
 * Derive price from BitShares DEX order book.
 * Returns price in B/A format (units of asset B per 1 unit of asset A).
 * Uses best bid and ask from order book, with fallback to ticker.
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol
 * @param {string} symB - Second asset symbol
 * @returns {Promise<number|null>} Derived market price or null if unavailable
 */
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

        // Return B/A orientation to match market price format
        const finalPrice = (mid !== null && mid !== 0) ? 1 / mid : null;
        if (finalPrice) {
            console.log(`[DIAGNOSTIC] deriveMarketPrice: ${symA}/${symB} rawMid=${mid?.toFixed(8)} -> finalPrice(B/A)=${finalPrice.toFixed(8)}`);
        }
        return finalPrice;
    } catch (err) {
        console.warn(`[DIAGNOSTIC] deriveMarketPrice failed for ${symA}/${symB}:`, err.message);
        return null;
    }
};

/**
 * Derive price from BitShares Liquidity Pool (AMM).
 * Returns price in B/A format (units of asset B per 1 unit of asset A).
 * Handles internal BitShares ID-based asset ordering (asset_a/asset_b).
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol
 * @param {string} symB - Second asset symbol
 * @returns {Promise<number|null>} Derived pool price or null if unavailable
 */
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
                    let startId = '1.19.0';
                    const PAGE_SIZE = 100;
                    const allMatches = [];

                    while (true) {
                        const pools = await listFn(PAGE_SIZE, startId);
                        if (!pools || pools.length === 0) break;

                        // BitShares list_liquidity_pools is inclusive of startId.
                        // Skip the first pool in subsequent pages to avoid duplicate processing.
                        const effectivePools = (startId === '1.19.0') ? pools : pools.slice(1);
                        if (effectivePools.length === 0) break;

                        const matches = effectivePools.filter(p => {
                            const ids = (p.asset_ids || [p.asset_a, p.asset_b]).map(String);
                            return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                        });

                        if (matches.length) {
                            allMatches.push(...matches);
                        }

                        if (pools.length < PAGE_SIZE) {
                            break;
                        } else {
                            startId = pools[pools.length - 1].id;
                        }
                    }

                    if (allMatches.length) {
                        // Select pool with highest balance for our assetA
                        chosen = allMatches.sort((a, b) => {
                            const getBal = p => Number(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
                            return getBal(b) - getBal(a);
                        })[0];
                        poolIdCache.set(cacheKey, chosen.id);
                    }
                } catch (e) {
                    console.warn('derivePoolPrice: pool pagination failed:', e.message || e);
                }
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

        const floatA = MathUtils.blockchainToFloat(amtA, aMeta.precision);
        const floatB = MathUtils.blockchainToFloat(amtB, bMeta.precision);

        // Return B/A orientation to match market price format
        const finalPrice = floatB > 0 ? floatB / floatA : null;
        if (finalPrice) {
            console.log(`[DIAGNOSTIC] derivePoolPrice: ${symA}/${symB} pool=${chosen.id} amtA=${amtA}(prec=${aMeta.precision}) amtB=${amtB}(prec=${bMeta.precision}) -> finalPrice(B/A)=${finalPrice.toFixed(8)}`);
        }
        return finalPrice;
    } catch (err) {
        console.warn(`[DIAGNOSTIC] derivePoolPrice failed for ${symA}/${symB}:`, err.message);
        return null;
    }
};

/**
 * Derive price from blockchain using specified mode.
 * Attempts pool or market derivation based on mode, with fallback chain.
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol
 * @param {string} symB - Second asset symbol
 * @param {string} [mode='auto'] - Derivation mode: "pool", "market", or "auto" (pool → market)
 * @returns {Promise<number|null>} Derived price or null if all methods fail
 */
const derivePrice = async (BitShares, symA, symB, mode = 'auto') => {
    mode = String(mode).toLowerCase();
    const validModes = new Set(['pool', 'market', 'auto']);

    if (!validModes.has(mode)) {
        return null;
    }

    if (mode === 'pool') {
        return await derivePoolPrice(BitShares, symA, symB).catch(() => null);
    }

    if (mode === 'market') {
        return await deriveMarketPrice(BitShares, symA, symB).catch(() => null);
    }

    // mode === 'auto': pool preferred, market fallback
    let poolP = null;
    poolP = await derivePoolPrice(BitShares, symA, symB).catch(() => null);
    if (poolP > 0) return poolP;

    const m = await deriveMarketPrice(BitShares, symA, symB).catch(() => null);
    if (m > 0) return m;

    return null;
};

// ================================================================================
// SECTION 6: FEE MANAGEMENT (INIT)
// ================================================================================

/**
 * Initialize fee cache from blockchain.
 * Fetches BTS operation fees and asset market fees for all unique assets in config.
 * Populates internal fee cache used by math.js::getAssetFees.
 * 
 * @param {Array<Object>} botsConfig - Array of bot configurations
 * @param {Object} BitShares - BitShares client instance
 * @returns {Promise<Object>} Fee cache object keyed by asset symbol
 */
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
                        bts: MathUtils.blockchainToFloat(feeNum, 5)
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
                        float: MathUtils.blockchainToFloat(options.max_market_fee || 0, fullAsset.precision)
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

/**
 * Persist current grid state to storage.
 * Saves all orders, cache funds, fees, boundary index, and asset info.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders data accessor
 * @param {string} botKey - Bot identifier for storage
 * @returns {Promise<boolean>} True if persistence succeeded, false on error
 */
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

/**
 * Retry grid persistence if previous attempt failed.
 * Clears persistence warning flag if successful.
 * 
 * @param {Object} manager - OrderManager instance
 * @returns {Promise<boolean>} True if persisted successfully or no warning, false on error
 */
async function retryPersistenceIfNeeded(manager) {
    if (!manager || !manager._persistenceWarning) return true;
    const warning = manager._persistenceWarning;
    try {
        const success = typeof manager.persistGrid === 'function' ? await manager.persistGrid() : true;
        if (success) delete manager._persistenceWarning;
        return success;
    } catch (e) { return false; }
}

/**
 * Apply grid corrections for divergence between calculated and active orders.
 * Synchronizes grid with blockchain, adjusts boundary, and corrects prices if needed.
 * Executes rotations, placements, and cancellations atomically.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders data accessor
 * @param {string} botKey - Bot identifier for persistence
 * @param {Function} updateOrdersOnChainBatchFn - Batch update function for blockchain operations
 * @returns {Promise<void>}
 */
async function applyGridDivergenceCorrections(manager, accountOrders, botKey, updateOrdersOnChainBatchFn) {
    if (!manager._gridLock) return;
    const Grid = require('../grid');

    // Phase 1: Pre-lock grid resizing (needs _updateOrder which acquires _gridLock)
    if (manager._gridSidesUpdated && manager._gridSidesUpdated.size > 0) {
        if (manager.outOfSpread > 0) {
            if (syncBoundaryToFunds(manager)) {
                await Grid.updateGridFromBlockchainSnapshot(manager, 'both', true);
            }
        }
    }

    // Phase 2: Lock-protected correction planning
    let corrections = null;
    await manager._gridLock.acquire(async () => {
        if (!manager._gridSidesUpdated || manager._gridSidesUpdated.size === 0) return;

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
                        manager.logger.log(`[DIVERGENCE] Marking surplus for cancellation: slot ${active.id} (chain id ${active.orderId}) has size 0.`, 'info');
                        manager.ordersNeedingPriceCorrection.push({ gridOrder: { ...active }, chainOrderId: active.orderId, isSurplus: true, sideUpdated: sideName });
                    }
                } else {
                    manager.logger.log(`[DIVERGENCE] Marking surplus for cancellation: slot ${active.id} (chain id ${active.orderId}) is outside target count.`, 'info');
                    manager.ordersNeedingPriceCorrection.push({ gridOrder: { ...active }, chainOrderId: active.orderId, isSurplus: true, sideUpdated: sideName });
                }
            }

            for (const slot of desiredSlots) {
                if (!activeBySlotId.has(slot.id) && slot.size > 0) {
                    manager.ordersNeedingPriceCorrection.push({ gridOrder: { ...slot }, chainOrderId: null, expectedPrice: slot.price, size: slot.size, type: slot.type, sideUpdated: sideName, isNewPlacement: true });
                }
            }
        }

        // Extract corrections to execute outside the lock
        if (manager.ordersNeedingPriceCorrection.length > 0) {
            corrections = {
                ordersToRotate: manager.ordersNeedingPriceCorrection.filter(c => !c.isNewPlacement && !c.isSurplus).map(c => ({
                    oldOrder: { orderId: c.chainOrderId, id: c.gridOrder.id },
                    newPrice: c.expectedPrice,
                    newSize: c.size,
                    type: c.type,
                    newGridId: c.newGridId
                })),
                ordersToPlace: manager.ordersNeedingPriceCorrection.filter(c => c.isNewPlacement).map(c => ({
                    id: c.gridOrder.id,
                    price: c.expectedPrice,
                    size: c.size,
                    type: c.type
                })),
                ordersToCancel: manager.ordersNeedingPriceCorrection.filter(c => c.isSurplus).map(c => ({
                    orderId: c.chainOrderId,
                    id: c.gridOrder.id
                }))
            };
        }
    });

    // Phase 3: Execute corrections outside the lock (updateOrdersOnChainBatchFn acquires its own locks)
    if (corrections) {
        try {
            const result = await updateOrdersOnChainBatchFn({ ...corrections, partialMoves: [] });
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
}

/**
 * Synchronize grid boundary position based on available funds.
 * Recalculates boundary index to match fund ratio and reassigns grid roles if changed.
 * 
 * @param {Object} manager - OrderManager instance
 * @returns {boolean} True if boundary changed, false otherwise
 */
function syncBoundaryToFunds(manager) {
    const availA = (manager.funds?.available?.sell || 0);
    const availB = (manager.funds?.available?.buy || 0);
    const allSlots = Array.from(manager.orders.values()).sort((a, b) => a.price - b.price);
    const Grid = require('../grid');
    const gapSlots = Grid.calculateGapSlots(manager.config.incrementPercent, manager.config.targetSpreadPercent);
    const newIdx = OrderUtils.calculateFundDrivenBoundary(allSlots, availA, availB, manager.config.startPrice, gapSlots);
    if (newIdx !== manager.boundaryIdx) {
        manager.boundaryIdx = newIdx;
        OrderUtils.assignGridRoles(allSlots, newIdx, gapSlots, ORDER_TYPES, ORDER_STATES, {
            assignOnChain: false,
            getCurrentSlot: (id) => manager.orders.get(id)
        });
        return true;
    }
    return false;
}

// ================================================================================
// SECTION 11: UI & INTERACTIVE UTILITIES
// ================================================================================

/**
 * Ensure profiles directory exists, creating if necessary.
 * 
 * @param {string} profilesDir - Path to profiles directory
 * @returns {boolean} True if directory was created, false if it already existed
 */
function ensureProfilesDirectory(profilesDir) {
    if (!fs.existsSync(profilesDir)) { fs.mkdirSync(profilesDir, { recursive: true }); return true; }
    return false;
}

/**
 * Pause execution for a specified duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read user input from stdin with optional masking.
 * Handles raw terminal mode for interactive prompts.
 * Supports password masking and backspace handling.
 * 
 * @param {string} prompt - Prompt text to display
 * @param {Object} [options={}] - Input options
 * @param {boolean} [options.hideEchoBack=false] - Hide input echo (for passwords)
 * @param {string} [options.mask=''] - Character to display instead of input
 * @returns {Promise<string>} Trimmed user input
 */
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

/**
 * Read password input from user with masked echo.
 * 
 * @param {string} prompt - Prompt text to display
 * @returns {Promise<string>} User-entered password
 */
async function readPassword(prompt) { return readInput(prompt, { mask: '*', hideEchoBack: false }); }

/**
 * Execute async function with exponential backoff retry logic.
 * Retries on failure with increasing delays up to maxDelayMs.
 * 
 * @param {Function} fn - Async function to retry
 * @param {Object} [options={}] - Retry options
 * @param {number} [options.maxAttempts=3] - Maximum retry attempts (default 3)
 * @param {number} [options.baseDelayMs=1000] - Base delay in milliseconds (default 1000)
 * @param {number} [options.maxDelayMs=10000] - Maximum delay in milliseconds (default 10000)
 * @param {Object} [options.logger=null] - Optional logger for retry messages
 * @param {string} [options.operationName='operation'] - Name for log messages (default 'operation')
 * @returns {Promise<*>} Result of function execution
 * @throws {Error} If all attempts fail, throws the final error
 */
async function withRetry(fn, options = {}) {
    const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 10000, logger = null, operationName = 'operation' } = options;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try { return await fn(); } catch (err) {
            if (attempt === maxAttempts) throw err;
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            logger?.log?.(`${operationName} attempt ${attempt} failed. Retrying in ${delay}ms...`, 'warn');
            await sleep(delay);
        }
    }
}

/**
 * Resolve the best account reference for blockchain reads.
 * Prefer account ID when available, fall back to account name.
 * Used by recovery and startup paths where implicit account context may be unavailable.
 * @param {Object} manager - OrderManager instance (optional)
 * @param {string} account - Account name (optional)
 * @returns {string|null} Resolved account reference or null
 */
function resolveAccountRef(manager, account) {
    if (manager && typeof manager.accountId === 'string' && manager.accountId) {
        return manager.accountId;
    }
    if (manager && typeof manager.account === 'string' && manager.account) {
        return manager.account;
    }
    if (typeof account === 'string' && account) {
        return account;
    }
    return null;
}

/**
 * Recursively freezes an object to ensure immutability.
 * @param {Object} obj 
 * @returns {Object}
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    Object.getOwnPropertyNames(obj).forEach(prop => {
        if (Object.prototype.hasOwnProperty.call(obj, prop) &&
            obj[prop] !== null &&
            (typeof obj[prop] === 'object' || typeof obj[prop] === 'function') &&
            !Object.isFrozen(obj[prop])) {
            deepFreeze(obj[prop]);
        }
    });
    return obj;
}

/**
 * Creates a shallow clone of a Map.
 * @param {Map} map 
 * @returns {Map}
 */
function cloneMap(map) {
    return new Map(map);
}

module.exports = {
    lookupAsset,
    deriveMarketPrice,
    derivePoolPrice,
    derivePrice,
    initializeFeeCache,
    persistGridSnapshot,
    retryPersistenceIfNeeded,
    applyGridDivergenceCorrections,
    syncBoundaryToFunds,
    ensureProfilesDirectory,
    sleep,
    readInput,
    readPassword,
    withRetry,
    resolveAccountRef,
    deepFreeze,
    cloneMap
};
