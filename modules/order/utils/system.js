/**
 * modules/order/utils/system.js - System and I/O Utilities
 * 
 * Price derivation, persistence, grid correction, and UI/interactive utilities.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (16 exported functions)
 * ===============================================================================
 *
 * SECTION 1: PRICE DERIVATION (4 functions)
 *   - lookupAsset(BitShares, symbol) - Lookup asset metadata from blockchain
 *   - deriveMarketPrice(BitShares, symA, symB) - Derive price from order book
 *   - derivePoolPrice(BitShares, symA, symB) - Derive price from liquidity pool
 *   - derivePrice(BitShares, symA, symB, mode) - Derive price with fallback chain
 *
 * SECTION 2: FEE MANAGEMENT (1 function)
 *   - initializeFeeCache(botsConfig, BitShares) - Initialize fee cache from blockchain
 *
 * SECTION 3: GRID STATE MANAGEMENT (3 functions)
 *   - persistGridSnapshot(manager, accountOrders, botKey) - Persist grid to storage
 *   - retryPersistenceIfNeeded(manager) - Retry persistence if previous failed
 *   - applyGridDivergenceCorrections(manager, ...) - Apply grid divergence corrections
 *
 * SECTION 4: GRID UTILITIES (1 function)
 *   - syncBoundaryToFunds(manager) - Sync boundary position to available funds
 *
 * SECTION 5: UI & INTERACTIVE UTILITIES (5 functions)
 *   - ensureProfilesDirectory(profilesDir) - Ensure profiles directory exists
 *   - sleep(ms) - Pause execution for specified duration
 *   - readInput(prompt, options) - Read user input from stdin
 *   - readPassword(prompt) - Read password with masked echo
 *   - withRetry(fn, options) - Execute async function with exponential backoff
 *
 * SECTION 6: GENERAL UTILITIES (2 functions)
 *   - resolveAccountRef(manager, account) - Resolve best account reference
 *   - deepFreeze(obj) - Recursively freeze object for immutability
 *   - cloneMap(map) - Create shallow clone of Map
 *
 * ===============================================================================
 */

const fs = require('fs');
const path = require('path');
const { API_LIMITS, TIMING, ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../../constants');
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
                const bestBid = isValidNumber(ob.bids?.[0]?.price) ? toFiniteNumber(ob.bids[0].price) : null;
                const bestAsk = isValidNumber(ob.asks?.[0]?.price) ? toFiniteNumber(ob.asks[0].price) : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            } catch (e) {}
        }

        if (mid === null && typeof BitShares.db?.get_ticker === 'function') {
            try {
                const t = await BitShares.db.get_ticker(baseId, quoteId);
                mid = isValidNumber(t?.latest) ? toFiniteNumber(t.latest) : (isValidNumber(t?.latest_price) ? toFiniteNumber(t.latest_price) : null);
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
                            const getBal = p => toFiniteNumber(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
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
            const aIdNum = toFiniteNumber(String(aMeta.id).split('.')[2]);
            const bIdNum = toFiniteNumber(String(bMeta.id).split('.')[2]);
            const aIsFirst = aIdNum < bIdNum;

            // If config's assetA has lower ID, it's the pool's first asset (asset_a)
            // Otherwise, our assetA corresponds to pool's second asset (asset_b)
            if (aIsFirst) {
                amtA = toFiniteNumber(chosen.balance_a);
                amtB = toFiniteNumber(chosen.balance_b);
            } else {
                amtA = toFiniteNumber(chosen.balance_b);
                amtB = toFiniteNumber(chosen.balance_a);
            }
        } else if (Array.isArray(chosen.reserves)) {
            const resA = chosen.reserves.find(r => String(r.asset_id) === String(aMeta.id));
            const resB = chosen.reserves.find(r => String(r.asset_id) === String(bMeta.id));
            if (resA && resB) {
                amtA = resA.amount;
                amtB = resB.amount;
            }
        }

        if (!isValidNumber(amtA) || !isValidNumber(amtB) || toFiniteNumber(amtB) === 0) return null;

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
 * Uses COW (Copy-on-Write): builds a working grid, plans updates/cancels/creates,
 * executes blockchain operations, and commits working grid only on success.
 *
 * Surplus on-chain orders are cancelled (not resized to zero).
 * Size updates are emitted only for committed ACTIVE/PARTIAL orders.
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
    const { WorkingGrid } = require('../working_grid');
    const { hasActionForOrder, removeActionsForOrder } = require('./helpers');

    // Phase 1: Pre-lock grid resizing using COW
    // This calculates new sizes from blockchain state but DOES NOT modify master.
    let resizeCowResult = null;
    if (manager._gridSidesUpdated && manager._gridSidesUpdated.size > 0) {
        const hasBuy = manager._gridSidesUpdated.has(ORDER_TYPES.BUY);
        const hasSell = manager._gridSidesUpdated.has(ORDER_TYPES.SELL);
        let resizeOrderType = hasBuy && hasSell
            ? 'both'
            : hasBuy
                ? ORDER_TYPES.BUY
                : ORDER_TYPES.SELL;

        // If out-of-spread correction moves boundary, recompute both sides.
        const boundarySync = syncBoundaryToFunds(manager);
        if (manager.outOfSpread > 0 && boundarySync.changed) {
            manager.boundaryIdx = boundarySync.newIdx;
            if (boundarySync.updatedSlots?.length > 0) {
                await manager.applyGridUpdateBatch(boundarySync.updatedSlots, 'boundary-sync', true);
            }
            resizeOrderType = 'both';
            manager._gridSidesUpdated.add(ORDER_TYPES.BUY);
            manager._gridSidesUpdated.add(ORDER_TYPES.SELL);
        }

        resizeCowResult = await Grid.updateGridFromBlockchainSnapshot(manager, resizeOrderType, true);
    }

    // Phase 2: Create working grid for divergence corrections
    // Use the resize working grid as starting point if available
    let cowResult = null;
    await manager._gridLock.acquire(async () => {
        if (!manager._gridSidesUpdated || manager._gridSidesUpdated.size === 0) return;

        // Start from resize result if available, otherwise create fresh working grid
        const workingGrid = resizeCowResult?.workingGrid 
            ? resizeCowResult.workingGrid 
            : new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        
        const actions = resizeCowResult?.actions ? [...resizeCowResult.actions] : [];

        for (const orderType of manager._gridSidesUpdated) {
            const sideName = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
            const sidePrecision = MathUtils.getPrecisionByOrderType(manager.assets, orderType);
            
            // Get current on-chain orders for this side (from master, not working)
            const currentOnChainOrders = Array.from(manager.orders.values())
                .filter(o => o.type === orderType && OrderUtils.isOrderPlaced(o));

            // Get all slots for this side from working grid
            const allSideSlots = Array.from(workingGrid.values())
                .filter(o => o.type === orderType)
                .sort((a, b) => sideName === 'buy' ? b.price - a.price : a.price - b.price);

            // Calculate target count
            const baseTargetCount = (manager.config.activeOrders && Number.isFinite(manager.config.activeOrders[sideName]))
                ? Math.max(1, manager.config.activeOrders[sideName])
                : currentOnChainOrders.length;
            const isDoubledSide = orderType === ORDER_TYPES.BUY ? manager.buySideIsDoubled : manager.sellSideIsDoubled;
            const targetCount = isDoubledSide ? Math.max(1, baseTargetCount - 1) : baseTargetCount;
            
            // Determine desired slots (closest to market)
            const desiredSlots = allSideSlots.slice(0, targetCount);
            const desiredSlotIds = new Set(desiredSlots.map(s => s.id));
            const onChainBySlotId = new Map(currentOnChainOrders.map(o => [o.id, o]));

            // Process on-chain orders:
            // - In desired window: keep/update committed size (if not already queued by Phase 1)
            // - Outside desired window: cancel surplus order
            for (const onChainOrder of currentOnChainOrders) {
                // Get current slot from working grid (may have been updated in Phase 1)
                const slot = workingGrid.get(onChainOrder.id);
                const isDesired = desiredSlotIds.has(onChainOrder.id);

                if (!isDesired || !slot || !(toFiniteNumber(slot.size) > 0)) {
                    removeActionsForOrder(actions, COW_ACTIONS.UPDATE, onChainOrder);
                    const hasQueuedCancel = hasActionForOrder(actions, COW_ACTIONS.CANCEL, onChainOrder);

                    if (!hasQueuedCancel) {
                        manager.logger.log(`[DIVERGENCE-COW] Queueing cancel for surplus ${onChainOrder.id} (chain id ${onChainOrder.orderId})`, 'info');
                        actions.push({
                            type: COW_ACTIONS.CANCEL,
                            id: onChainOrder.id,
                            orderId: onChainOrder.orderId
                        });
                    }

                    const current = slot || onChainOrder;
                    workingGrid.set(onChainOrder.id, OrderUtils.convertToSpreadPlaceholder(current));
                    continue;
                }

                // Phase 1 already queued committed size updates. Avoid duplicate UPDATEs.
                const hasQueuedUpdate = hasActionForOrder(actions, COW_ACTIONS.UPDATE, onChainOrder);
                const hasQueuedCancel = hasActionForOrder(actions, COW_ACTIONS.CANCEL, onChainOrder);

                if (hasQueuedUpdate || hasQueuedCancel) {
                    continue;
                }

                const newSize = toFiniteNumber(slot.size);
                const currentSize = toFiniteNumber(onChainOrder.size);
                const sizeChanged = Number.isFinite(sidePrecision)
                    ? MathUtils.floatToBlockchainInt(newSize, sidePrecision) !== MathUtils.floatToBlockchainInt(currentSize, sidePrecision)
                    : newSize !== currentSize;

                if (sizeChanged) {
                    manager.logger.log(`[DIVERGENCE-COW] Queueing size update for ${onChainOrder.id}: ${currentSize} -> ${newSize}`, 'info');
                    actions.push({
                        type: COW_ACTIONS.UPDATE,
                        id: onChainOrder.id,
                        orderId: onChainOrder.orderId,
                        newGridId: onChainOrder.id,
                        newSize,
                        newPrice: slot.price,
                        order: {
                            id: onChainOrder.id,
                            type: onChainOrder.type,
                            price: slot.price,
                            size: newSize
                        }
                    });
                }
            }

            // Process holes: CREATE new orders for empty desired slots
            for (const slot of desiredSlots) {
                const hasCreate = hasActionForOrder(actions, COW_ACTIONS.CREATE, slot);
                if (!onChainBySlotId.has(slot.id) && slot.size > 0 && !hasCreate) {
                    manager.logger.log(`[DIVERGENCE-COW] Queueing new placement for slot ${slot.id}`, 'info');
                    actions.push({
                        type: COW_ACTIONS.CREATE,
                        id: slot.id,
                        order: {
                            id: slot.id,
                            price: slot.price,
                            size: slot.size,
                            type: slot.type
                        }
                    });
                }
            }
        }

        // Build COW result with all actions
        if (actions.length > 0) {
            cowResult = {
                actions,
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: manager.boundaryIdx,
                aborted: false
            };
        } else if (resizeCowResult?.hasWorkingChanges) {
            // No on-chain operations required, but working grid changed (typically virtual sizing).
            // Commit locally to keep master in sync with latest sizing context.
            cowResult = {
                actions: [],
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: manager.boundaryIdx,
                localOnly: true,
                aborted: false
            };
        }
    });

    // Phase 3: Execute corrections via COW batch
    if (cowResult && !cowResult.aborted) {
        try {
            let result = null;

            if (cowResult.localOnly) {
                await manager._commitWorkingGrid(cowResult.workingGrid, cowResult.workingIndexes, cowResult.workingBoundary);
                if (typeof manager.persistGrid === 'function') {
                    await manager.persistGrid();
                } else {
                    await persistGridSnapshot(manager, accountOrders, botKey);
                }
                result = { executed: true, localOnly: true };
                manager.logger.log(`[DIVERGENCE-COW] Applied local-only sizing updates (no blockchain ops)`, 'info');
            } else {
                result = await updateOrdersOnChainBatchFn(cowResult);
            }
            
            if (result && result.executed) {
                manager.logger.log(`[DIVERGENCE-COW] Successfully applied divergence corrections`, 'info');
                manager.outOfSpread = 0;
                for (const type of manager._gridSidesUpdated) {
                    if (type === ORDER_TYPES.BUY) manager.buySideIsDoubled = false;
                    if (type === ORDER_TYPES.SELL) manager.sellSideIsDoubled = false;
                }
                manager._gridSidesUpdated.clear();
                // Grid already persisted via _commitWorkingGrid in updateOrdersOnChainBatch
            } else {
                manager.logger.log(`[DIVERGENCE-COW] Divergence corrections not executed (working grid discarded)`, 'warn');
                manager._gridSidesUpdated.clear();
            }
        } catch (err) {
            manager.logger.log(`[DIVERGENCE-COW] Error executing divergence corrections: ${err.message}`, 'error');
            manager._gridSidesUpdated.clear();
        }
    } else {
        // No actions needed or aborted
        manager._gridSidesUpdated.clear();
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
        const updatedSlots = OrderUtils.assignGridRoles(allSlots, newIdx, gapSlots, ORDER_TYPES, ORDER_STATES, {
            assignOnChain: false,
            getCurrentSlot: (id) => manager.orders.get(id)
        });
        // Filter to only changed slots to minimize batch size.
        // assignGridRoles returns the original frozen reference when unchanged,
        // so object identity reliably distinguishes cloned (changed) slots.
        const changedSlots = updatedSlots.filter(s => s !== manager.orders.get(s.id));
        return { changed: true, newIdx, updatedSlots: changedSlots };
    }
    return { changed: false };
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
