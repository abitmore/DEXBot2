/**
 * Grid - Order grid creation, synchronization, and health management
 *
 * This module manages the complete lifecycle of the order grid:
 * - Creates geometric price grids with configurable spacing
 * - Synchronizes grid state with blockchain and fund changes
 * - Monitors grid health and handles spread corrections
 */

const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, GRID_LIMITS, TIMING, INCREMENT_BOUNDS, FEE_PARAMETERS } = require('../constants');
const { GRID_COMPARISON } = GRID_LIMITS;
const Format = require('./format');

// FIX: Extract magic numbers to named constants for maintainability
const GRID_CONSTANTS = {
    PERCENT_BOUNDS_MIN: 0,
    PERCENT_BOUNDS_MAX: 100,
    RMS_PERCENTAGE_SCALE: 100,  // Convert RMS percentage threshold from percent to decimal
};

const {
    floatToBlockchainInt,
    blockchainToFloat,
    filterOrdersByType,
    filterOrdersByTypeAndState,
    sumOrderSizes,
    getPrecisionByOrderType,
    getPrecisionForSide,
    getPrecisionsForManager,
    checkSizesBeforeMinimum,
    checkSizeThreshold,
    calculateOrderCreationFees,
    deductOrderFeesFromFunds,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateGridSideDivergenceMetric,
    resolveConfiguredPriceBound,
    getMinOrderSize,
    calculateAvailableFundsValue,
    calculateSpreadFromOrders,
    countOrdersByType,
    shouldFlagOutOfSpread,
    derivePrice
} = require('./utils');

class Grid {
    /**
     * RACE CONDITION FIXES: Synchronization primitives
     * These helpers assume manager has async-lock or similar primitives
     */
    
    /**
     * Safely ensure cacheFunds is initialized (fixes RC-9)
     * RC-9: Prevents concurrent initialization races
     * @private
     */
    static _ensureCacheFundsInitialized(manager) {
        if (!manager.funds.cacheFunds) {
            manager.funds.cacheFunds = { buy: 0, sell: 0 };
        }
    }

    /**
     * Safely update cacheFunds with synchronization (fixes RC-1)
     * RC-1: TOCTOU protection - wraps modifications in atomic operation
     * @private
     */
    static async _updateCacheFundsAtomic(manager, sideName, newValue) {
        // If manager has fund semaphore, use it; otherwise execute directly
        if (manager._fundsSemaphore?.acquire) {
            return await manager._fundsSemaphore.acquire(() => {
                Grid._ensureCacheFundsInitialized(manager);
                manager.funds.cacheFunds[sideName] = newValue;
            });
        } else {
            Grid._ensureCacheFundsInitialized(manager);
            manager.funds.cacheFunds[sideName] = newValue;
        }
    }

    /**
     * Create the initial order grid structure based on configuration.
     * 
     * ALGORITHM: Geometric Grid Creation with Fixed Spread Gap
     * =========================================================
     * This method generates a unified "Master Rail" of price levels with geometric spacing.
     * The grid is centered around startPrice with a fixed-size spread gap.
     * 
     * KEY CONCEPTS:
     * - Geometric Spacing: Each price level is incrementPercent% away from neighbors
     * - Master Rail: Single unified array (not separate buy/sell rails)
     * - Spread Gap: Fixed-size buffer between best buy and best sell
     * - Role Assignment: BUY / SPREAD / SELL based on position relative to startPrice
     * 
     * SPREAD GAP FORMULA:
     * ===================
     * The spread gap size is calculated to match the target spread percentage:
     * 
     * 1. Step Factor (s): s = 1 + (incrementPercent / 100)
     *    Example: If incrementPercent = 0.5%, then s = 1.005
     * 
     * 2. Minimum Spread: minSpread = incrementPercent × MIN_SPREAD_FACTOR
     *    This ensures spread is at least 2× the increment (prevents too-narrow spread)
     * 
     * 3. Target Steps (n): Number of price levels needed to achieve target spread
     *    Formula: n = ceil(ln(1 + targetSpread/100) / ln(s))
     *    
     *    Derivation: If we want price to grow by targetSpread% over n steps:
     *    - Final price = startPrice × s^n
     *    - Growth factor = (1 + targetSpread/100)
     *    - Therefore: s^n = (1 + targetSpread/100)
     *    - Taking ln: n × ln(s) = ln(1 + targetSpread/100)
     *    - Solving: n = ln(1 + targetSpread/100) / ln(s)
     * 
     * 4. Gap Slots (G): G = max(MIN_SPREAD_ORDERS, n)
     *    Ensures at least MIN_SPREAD_ORDERS slots even if target spread is small
     * 
     * EXAMPLE:
     * --------
     * incrementPercent = 0.5%, targetSpread = 2%
     * - s = 1.005
     * - minSpread = 0.5% × 2 = 1%
     * - targetSpread = max(2%, 1%) = 2%
     * - n = ceil(ln(1.02) / ln(1.005)) = ceil(3.98) = 4 steps
     * - G = max(2, 4) = 4 slots
     * 
     * @param {Object} config - Grid configuration
     * @param {number} config.startPrice - Market price (grid center)
     * @param {number} config.minPrice - Minimum price bound
     * @param {number} config.maxPrice - Maximum price bound
     * @param {number} config.incrementPercent - Price step percentage (e.g., 0.5 for 0.5%)
     * @param {number} config.targetSpreadPercent - Target spread width (e.g., 2 for 2%)
     * @returns {Object} { orders: Array, boundaryIdx: number, initialSpreadCount: {buy, sell} }
     */
    static createOrderGrid(config) {
        const { startPrice, minPrice, maxPrice, incrementPercent } = config;

        // FIX: Add comprehensive input validation to prevent silent grid creation failures
        if (!Number.isFinite(startPrice)) {
            throw new Error(`Invalid startPrice: ${startPrice}. Must be a finite number.`);
        }
        if (!Number.isFinite(minPrice)) {
            throw new Error(`Invalid minPrice: ${minPrice}. Must be a finite number.`);
        }
        if (!Number.isFinite(maxPrice)) {
            throw new Error(`Invalid maxPrice: ${maxPrice}. Must be a finite number.`);
        }
        if (minPrice >= maxPrice) {
            throw new Error(`Invalid price bounds: minPrice (${minPrice}) must be < maxPrice (${maxPrice}).`);
        }
        if (!(minPrice <= startPrice && startPrice <= maxPrice)) {
            throw new Error(`startPrice (${startPrice}) must be within bounds [${minPrice}, ${maxPrice}].`);
        }
        if (maxPrice <= 0) {
            throw new Error(`maxPrice (${maxPrice}) must be positive.`);
        }

        if (incrementPercent <= GRID_CONSTANTS.PERCENT_BOUNDS_MIN || incrementPercent >= GRID_CONSTANTS.PERCENT_BOUNDS_MAX) {
            throw new Error(`Invalid incrementPercent: ${incrementPercent}. Must be between ${INCREMENT_BOUNDS.MIN_PERCENT} and ${INCREMENT_BOUNDS.MAX_PERCENT}.`);
        }

        const stepUp = 1 + (incrementPercent / 100);
        const stepDown = 1 - (incrementPercent / 100);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 1: GENERATE PRICE LEVELS (Geometric progression)
        // ════════════════════════════════════════════════════════════════════════════════
        // Create a geometric series of prices from minPrice to maxPrice.
        // Each level is incrementPercent% away from its neighbors.
        // 
        // We start from startPrice and expand outward in both directions to ensure
        // the grid is centered around the market price.

        const priceLevels = [];

        // Generate levels upwards from startPrice (higher prices for SELL orders)
        // Start from sqrt(stepUp) × startPrice to center the grid
        let upPrice = startPrice * Math.sqrt(stepUp);
        while (upPrice <= maxPrice) {
            priceLevels.push(upPrice);
            upPrice *= stepUp;
        }

        // Generate levels downwards from startPrice (lower prices for BUY orders)
        // Start from sqrt(stepDown) × startPrice to center the grid
        let downPrice = startPrice * Math.sqrt(stepDown);
        while (downPrice >= minPrice) {
            priceLevels.push(downPrice);
            downPrice *= stepDown;
        }

        // Sort all levels from lowest to highest (Master Rail order)
        priceLevels.sort((a, b) => a - b);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 2: FIND SPLIT INDEX (First slot at or above startPrice)
        // ════════════════════════════════════════════════════════════════════════════════
        // The split index is used to center the spread gap around market price.
        // Pivot concept (slot closest to startPrice) was previously used but is now
        // calculated separately in strategy.js as part of role assignment logic.

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 3: CALCULATE SPREAD GAP SIZE
        // ════════════════════════════════════════════════════════════════════════════════
        // Determine how many slots should be in the spread zone.
        // See formula documentation in JSDoc above.

        // Enforce minimum spread (prevents spread from being too narrow)
        const minSpreadPercent = incrementPercent * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2);
        const targetSpreadPercent = Math.max(config.targetSpreadPercent || 0, minSpreadPercent);

        // Calculate number of steps needed to achieve target spread
        // Formula: n = ceil(ln(1 + targetSpread/100) / ln(stepFactor))
        // Reuse stepUp from line 99 instead of redundant 'step' variable
        const requiredSteps = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(stepUp));

        // Final gap size: At least MIN_SPREAD_ORDERS, or more if needed for target spread
        const gapSlots = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps);

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 4: ROLE ASSIGNMENT (BUY / SPREAD / SELL)
        // ════════════════════════════════════════════════════════════════════════════════
        // Assign each price level to a role based on its position relative to startPrice.
        // 
        // STRATEGY: Center the spread gap around startPrice
        // - Find the first slot >= startPrice (splitIdx)
        // - Place half the gap below splitIdx (buySpread)
        // - Place remaining gap above splitIdx (sellSpread)
        // 
        // RESULT:
        // [0 ... buyEndIdx] = BUY zone (prices < spread)
        // [buyEndIdx+1 ... sellStartIdx-1] = SPREAD zone (empty buffer)
        // [sellStartIdx ... N] = SELL zone (prices > spread)

        // Find the first slot at or above startPrice
        let splitIdx = priceLevels.findIndex(p => p >= startPrice);
        if (splitIdx === -1) splitIdx = priceLevels.length;

        // Distribute gap slots: Half below startPrice, half above
        const buySpread = Math.floor(gapSlots / 2);
        const sellSpread = gapSlots - buySpread;

        // Calculate zone boundaries
        // FIX: Document subtle boundary calculation to prevent off-by-one errors
        // buyEndIdx is the last index where buy orders exist (exclude spread zone)
        // sellStartIdx is the first index where sell orders exist (exclude spread zone)
        // Spread zone is [buyEndIdx + 1, sellStartIdx - 1] (empty buffer around market)
        // Example: splitIdx=5, buySpread=2 => buyEndIdx=2, sellStartIdx=7
        //   BUY: [0,1,2], SPREAD: [3,4,5,6], SELL: [7,8,...]
        const buyEndIdx = splitIdx - buySpread - 1;
        const sellStartIdx = splitIdx + sellSpread;

        // ════════════════════════════════════════════════════════════════════════════════
        // STEP 5: CREATE ORDER OBJECTS
        // ════════════════════════════════════════════════════════════════════════════════
        // Convert price levels to order objects with assigned roles.

        const orders = priceLevels.map((price, i) => {
            // Determine order type based on position relative to spread zone
            let type;
            if (i <= buyEndIdx) {
                type = ORDER_TYPES.BUY;
            } else if (i >= sellStartIdx) {
                type = ORDER_TYPES.SELL;
            } else {
                type = ORDER_TYPES.SPREAD;
            }

            return {
                id: `slot-${i}`,
                price,
                type,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            };
        });

        const initialSpreadCount = {
            buy: buySpread,
            sell: sellSpread
        };

        return { orders, boundaryIdx: buyEndIdx, initialSpreadCount };
    }

    /**
     * Internal utility to clear all order-related manager caches.
     * Prevents stale references during grid reinitialization.
     * RC-2: Synchronized to prevent concurrent modifications during clear
     * @private
     */
    static async _clearOrderCachesAtomic(manager) {
        // FIX: Extract common cache clearing logic to reduce code duplication
        // Used by both loadGrid() and initializeGrid()
        // RC-2: Use grid lock if available to serialize with _updateOrder() calls
        if (manager._gridLock?.acquire) {
            return await manager._gridLock.acquire(() => {
                manager.orders?.clear?.();
                if (manager._ordersByState) Object.values(manager._ordersByState).forEach(set => set?.clear?.());
                if (manager._ordersByType) Object.values(manager._ordersByType).forEach(set => set?.clear?.());
            });
        } else {
            manager.orders?.clear?.();
            if (manager._ordersByState) Object.values(manager._ordersByState).forEach(set => set?.clear?.());
            if (manager._ordersByType) Object.values(manager._ordersByType).forEach(set => set?.clear?.());
        }
    }
    
    /**
     * Synchronize all _updateOrder() calls through grid lock (fixes RC-2)
     * RC-2: Prevents concurrent modifications to manager.orders and fund state
     * @private
     */
    static async _updateOrderAtomic(manager, order) {
        if (manager._gridLock?.acquire) {
            return await manager._gridLock.acquire(() => {
                manager._updateOrder(order);
            });
        } else {
            manager._updateOrder(order);
        }
    }

    /**
     * Restore a persisted grid snapshot onto a manager instance.
     */
    static async loadGrid(manager, grid, boundaryIdx = null) {
        if (!Array.isArray(grid)) return;
        try {
            await manager._initializeAssets();
        } catch (e) {
            manager.logger?.log?.(`Asset initialization failed during grid load: ${e.message}`, 'warn');
        }

        // RC-2: Use atomic clear to prevent concurrent modifications
        await Grid._clearOrderCachesAtomic(manager);

        const savedCacheFunds = { ...manager.funds.cacheFunds };
        const savedBtsFeesOwed = manager.funds.btsFeesOwed;

        manager.resetFunds();
        manager.funds.cacheFunds = savedCacheFunds;
        manager.funds.btsFeesOwed = savedBtsFeesOwed;

        // Restore boundary index for StrategyEngine
        if (typeof boundaryIdx === 'number') {
            manager.boundaryIdx = boundaryIdx;
            // FIX: Use consistent optional chaining pattern for logger calls
            manager.logger?.log?.(`Restored boundary index: ${boundaryIdx}`, 'info');
        }

        // RC-2: Use atomic order updates to prevent concurrent state corruption
        for (const order of grid) {
            await Grid._updateOrderAtomic(manager, order);
        }
        // FIX: Use consistent optional chaining pattern for logger calls
        manager.logger?.log?.(`Loaded ${manager.orders.size} orders from persisted grid.`, 'info');
    }

    /**
     * Initialize the order grid with blockchain-aware sizing.
     */
    static async initializeGrid(manager) {
        if (!manager) throw new Error('initializeGrid requires a manager instance');
        await manager._initializeAssets();
        
        // FIX: Add explicit state validation to prevent cryptic errors later
        if (!manager.assets || !manager.assets.assetA || !manager.assets.assetB) {
            throw new Error('Asset initialization did not complete properly - assetA or assetB undefined');
        }
        if (!manager.config) {
            throw new Error('Manager config not initialized before grid initialization');
        }

        const mpRaw = manager.config.startPrice;

        // Auto-derive price if requested
        if (!Number.isFinite(Number(mpRaw)) || typeof mpRaw === 'string') {
            try {
                const { BitShares } = require('../bitshares_client');
                const derived = await derivePrice(BitShares, manager.config.assetA, manager.config.assetB, manager.config.priceMode || 'auto');
                if (derived) manager.config.startPrice = derived;
            } catch (err) {
                // FIX: Use logger instead of console.warn (Issue #5)
                manager.logger?.log?.(`Failed to derive market price: ${err.message}`, 'warn');
            }
        }

        const mp = Number(manager.config.startPrice);
        const minP = resolveConfiguredPriceBound(manager.config.minPrice, DEFAULT_CONFIG.minPrice, mp, 'min');
        const maxP = resolveConfiguredPriceBound(manager.config.maxPrice, DEFAULT_CONFIG.maxPrice, mp, 'max');

        manager.config.minPrice = minP;
        manager.config.maxPrice = maxP;

        // Ensure percentage-based funds are resolved before sizing
        try {
            if (manager.accountId && !manager.accountTotals) {
                await manager.waitForAccountTotals(TIMING.ACCOUNT_TOTALS_TIMEOUT_MS);
            }
        } catch (e) {
            manager.logger?.log?.(`Failed to load account totals: ${e.message}`, 'warn');
            // FIX: Add error handling - cannot proceed with grid initialization without account totals
            // Continuing would create grid with 0 fund allocation, rendering it non-functional
            throw new Error(`Cannot initialize grid without account totals: ${e.message}`);
        }

        const { orders, boundaryIdx, initialSpreadCount } = Grid.createOrderGrid(manager.config);

        // RC-8: Update boundary with notification to dependent systems
        // Persist master boundary for StrategyEngine
        if (manager.boundaryIdx !== boundaryIdx) {
            manager.boundaryIdx = boundaryIdx;
            // RC-8: Notify StrategyEngine of boundary change (if method exists)
            if (typeof manager.notifyBoundaryUpdate === 'function') {
                try {
                    manager.notifyBoundaryUpdate(boundaryIdx);
                } catch (err) {
                    manager.logger?.log?.(`Error notifying boundary update: ${err.message}`, 'warn');
                }
            }
        }

        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        if (manager.applyBotFundsAllocation) manager.applyBotFundsAllocation();

        // RC-5: Take fund snapshot with lock to prevent torn reads from concurrent account updates
        let snapshot;
        if (manager._accountLock?.acquire) {
            snapshot = await manager._accountLock.acquire(() => {
                return manager.getChainFundsSnapshot();
            });
        } else {
            snapshot = manager.getChainFundsSnapshot();
        }

        const btsFees = calculateOrderCreationFees(manager.config.assetA, manager.config.assetB, (manager.config.activeOrders.buy + manager.config.activeOrders.sell), FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER);
        const { buyFunds, sellFunds } = deductOrderFeesFromFunds(snapshot.allocatedBuy, snapshot.allocatedSell, btsFees, manager.config);

        const { A: precA, B: precB } = getPrecisionsForManager(manager.assets);
        let sizedOrders = calculateOrderSizes(orders, manager.config, sellFunds, buyFunds, minSellSize, minBuySize, precA, precB);

         // Verification of sizes
         const sells = filterOrdersByType(sizedOrders, ORDER_TYPES.SELL).map(o => Number(o.size || 0));
         const buys = filterOrdersByType(sizedOrders, ORDER_TYPES.BUY).map(o => Number(o.size || 0));
        if (checkSizesBeforeMinimum(sells, minSellSize, precA) || checkSizesBeforeMinimum(buys, minBuySize, precB)) {
            throw new Error('Calculated orders fall below minimum allowable size.');
        }

         // Check for warning if orders are near minimal size (regression fix) 
         const warningSellSize = minSellSize > 0 ? getMinOrderSize(ORDER_TYPES.SELL, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR * 2) : 0;
         const warningBuySize = minBuySize > 0 ? getMinOrderSize(ORDER_TYPES.BUY, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR * 2) : 0;
         if (checkSizeThreshold(sells, warningSellSize, precA, false) || checkSizeThreshold(buys, warningBuySize, precB, false)) {
             manager.logger?.log?.("WARNING: Order grid contains orders near minimum size. To ensure the bot runs properly, consider increasing the funds of your bot.", "warn");
         }

         // RC-2: Use atomic clear to prevent concurrent modifications
         await Grid._clearOrderCachesAtomic(manager);
         manager.resetFunds();

        // RC-2: Use atomic order updates to prevent concurrent state corruption
        for (const order of sizedOrders) {
            await Grid._updateOrderAtomic(manager, order);
        }

        // RC-6: Wrap spread count updates in atomic operation to prevent races
        if (manager._spreadCountLock?.acquire) {
            await manager._spreadCountLock.acquire(() => {
                manager.targetSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell;
                manager.currentSpreadCount = manager.targetSpreadCount;
            });
        } else {
            manager.targetSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell;
            manager.currentSpreadCount = manager.targetSpreadCount;
        }

        // FIX: Use consistent optional chaining pattern for all logger calls
        manager.logger?.log?.(`Initialized grid with ${orders.length} orders.`, 'info');
        manager.logger?.logFundsStatus?.(manager);
        manager.logger?.logOrderGrid?.(Array.from(manager.orders.values()), manager.config.startPrice);
        manager.finishBootstrap();
    }

    /**
     * Full grid resynchronization from blockchain state.
     */
    static async recalculateGrid(manager, opts) {
        const { readOpenOrdersFn, chainOrders, account, privateKey } = opts;
        // FIX: Use consistent optional chaining pattern for logger calls
        manager.logger?.log?.('Starting full resync...', 'info');

        await manager._initializeAssets();
        await manager.fetchAccountTotals();

        const chainOpenOrders = await readOpenOrdersFn();
        if (!Array.isArray(chainOpenOrders)) return;

        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
        manager.resetFunds();
        manager.funds.cacheFunds = { buy: 0, sell: 0 };

        await manager.persistGrid();
        await Grid.initializeGrid(manager);

        const { reconcileStartupOrders } = require('./startup_reconcile');
        
        // FIX: Add error context for debugging grid recalculation issues
        try {
            await reconcileStartupOrders({ manager, config: manager.config, account, privateKey, chainOrders, chainOpenOrders, syncResult: { unmatchedChainOrders: chainOpenOrders } });
        } catch (err) {
            manager.logger?.log?.(`Error during startup order reconciliation: ${err.message}`, 'error');
            throw new Error(`Grid recalculation failed during order reconciliation: ${err.message}`);
        }
        
        // FIX: Use consistent optional chaining pattern for logger calls
        manager.logger?.log?.('Full resync complete.', 'info');
    }

    /**
     * Check for grid divergence and trigger update if threshold is met.
     * FIX: Complete JSDoc with parameter types and return value documentation
     * 
     * @param {OrderManager} manager - Manager instance with order state
     * @param {Object} cacheFunds - Current cache funds state
     * @param {number} cacheFunds.buy - Buy side cache funds available
     * @param {number} cacheFunds.sell - Sell side cache funds available
     * @returns {Object} Update status for each side
     * @returns {boolean} returns.buyUpdated - Buy side exceeded regeneration threshold
     * @returns {boolean} returns.sellUpdated - Sell side exceeded regeneration threshold
     */
    static checkAndUpdateGridIfNeeded(manager, cacheFunds = { buy: 0, sell: 0 }) {
        const threshold = GRID_LIMITS.GRID_REGENERATION_PERCENTAGE || 1;
        const snap = Grid._getFundSnapshot(manager);
        const result = { buyUpdated: false, sellUpdated: false };

        const sides = [
            { name: 'buy', grid: snap.gridBuy, cache: cacheFunds.buy || snap.cacheBuy, orderType: ORDER_TYPES.BUY },
            { name: 'sell', grid: snap.gridSell, cache: cacheFunds.sell || snap.cacheSell, orderType: ORDER_TYPES.SELL }
        ];

        for (const s of sides) {
            if (s.grid <= 0) continue;
            const avail = calculateAvailableFundsValue(s.name, manager.accountTotals, manager.funds, manager.config.assetA, manager.config.assetB, manager.config.activeOrders);
            const totalPending = s.cache + avail;
            const allocated = s.name === 'buy' ? snap.allocatedBuy : snap.allocatedSell;
            const denominator = (allocated > 0) ? allocated : (s.grid + totalPending);
            const ratio = (denominator > 0) ? (totalPending / denominator) * 100 : 0;

            if (ratio >= threshold) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(s.orderType);
                if (s.name === 'buy') result.buyUpdated = true; else result.sellUpdated = true;
            }
        }
        return result;
    }

     /**
      * Standardize grid sizes using blockchain total context.
      * RC-1: Made async to support atomic cacheFunds updates
      * @private
      */
     static async _recalculateGridOrderSizesFromBlockchain(manager, orderType) {
        if (!manager.assets) return;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const sideName = isBuy ? 'buy' : 'sell';
        const snap = manager.getChainFundsSnapshot ? manager.getChainFundsSnapshot() : {};
        const allocatedFunds = isBuy ? snap.chainTotalBuy : snap.chainTotalSell;

        const orders = Array.from(manager.orders.values())
            .filter(o => o.type === orderType)
            .sort((a, b) => a.price - b.price); // Must be sorted ASC for calculateRotationOrderSizes
        if (orders.length === 0) return;

        const precision = getPrecisionByOrderType(manager.assets, orderType);
        let fundsForSizing = allocatedFunds;

        if ((isBuy && manager.config.assetB === 'BTS') || (!isBuy && manager.config.assetA === 'BTS')) {
            const targetCount = Math.max(1, manager.config.activeOrders[sideName]);
            const btsFees = calculateOrderCreationFees(manager.config.assetA, manager.config.assetB, targetCount, FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER);
            fundsForSizing = Math.max(0, allocatedFunds - btsFees);
        }

        const newSizes = calculateRotationOrderSizes(fundsForSizing, 0, orders.length, orderType, manager.config, 0, precision);
        Grid._updateOrdersForSide(manager, orderType, newSizes, orders);
        manager.recalculateFunds();

         // Calculate remaining cache for this side only (independent per side)
         const totalInputInt = floatToBlockchainInt(allocatedFunds, precision);
         let totalAllocatedInt = 0;
         newSizes.forEach(s => totalAllocatedInt += floatToBlockchainInt(s, precision));

         // RC-1: Update cacheFunds atomically to prevent TOCTOU races
         const newCacheValue = blockchainToFloat(totalInputInt - totalAllocatedInt, precision);
         await Grid._updateCacheFundsAtomic(manager, sideName, newCacheValue);
    }

    /**
     * High-level entry for resizing grid from snapshot.
     * FIX: Complete JSDoc with parameter types and return value documentation
     * 
     * @param {OrderManager} manager - Manager instance
     * @param {string} orderType - 'buy', 'sell', or 'both' - which sides to update
     * @param {boolean} fromBlockchainTimer - If true, skip refetch of account totals (already current)
     * @returns {Promise<void>}
     */
    static async updateGridFromBlockchainSnapshot(manager, orderType = 'both', fromBlockchainTimer = false) {
        if (!fromBlockchainTimer && manager.config?.accountId) {
            await manager.fetchAccountTotals(manager.config.accountId);
        }
        // RC-1: Await async cacheFunds updates
        if (orderType === ORDER_TYPES.BUY || orderType === 'both') await Grid._recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY);
        if (orderType === ORDER_TYPES.SELL || orderType === 'both') await Grid._recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.SELL);
    }

    /**
     * Compare ideal grid vs persisted grid to detect divergence.
     * INDEPENDENT SIDE CHECKING: Buy and sell sides are evaluated independently.
     * Each side's RMS divergence is compared against its own threshold.
     * Only sides exceeding the threshold are marked for update.
     *
     * PURPOSE: Detect if the calculated in-memory grid has diverged significantly from the
     * persisted grid state. High divergence indicates that order fills/rotations have caused
     * size distributions to deviate, potentially requiring grid size recalculation.
     *
     * METRIC: RMS (Root Mean Square) percentage of relative size differences
     * Formula: RMS% = sqrt(mean((calculated - persisted) / persisted)²) × 100
     * This measures the typical relative error across all orders on each side.
     *
     * SIDE INDEPENDENCE:
     * - Buy side RMS is checked against GRID_COMPARISON.RMS_PERCENTAGE independently
     * - Sell side RMS is checked against GRID_COMPARISON.RMS_PERCENTAGE independently
     * - One side can diverge while the other remains stable (no update for stable side)
     * - CacheFunds are updated only for sides being recalculated
     *
     * RC-4: Atomic snapshot taking prevents stale data from concurrent fill operations
     *   - Grids are snapshotted atomically before comparison
     *   - Prevents mixing old and new grid state
     *   - Ensures consistent RMS metrics across both sides
     *
     * @returns {Object} { buy: {metric, updated}, sell: {metric, updated} }
     *   - metric: RMS% divergence (higher = more divergent)
     *   - updated: true if metric exceeds GRID_COMPARISON.RMS_PERCENTAGE threshold for that side
     */
    static async compareGrids(calculatedGrid, persistedGrid, manager = null, cacheFunds = null) {
        if (!Array.isArray(calculatedGrid) || !Array.isArray(persistedGrid)) {
            return { buy: { metric: 0, updated: false }, sell: { metric: 0, updated: false } };
        }

        // RC-4: Take snapshots atomically to prevent concurrent modification races
        // If manager has grid lock, use it to get consistent snapshots
        let calculatedSnap = calculatedGrid;
        let persistedSnap = persistedGrid;
        
        if (manager?._gridLock?.acquire) {
            const snapshotResult = await manager._gridLock.acquire(() => {
                return {
                    calculated: Array.from(calculatedGrid),
                    persisted: Array.from(persistedGrid)
                };
            });
            calculatedSnap = snapshotResult.calculated;
            persistedSnap = snapshotResult.persisted;
        }

        // Filter to PARTIAL orders only (excludes ACTIVE/SPREAD which have exact sizes)
        // PARTIAL orders are where divergence matters most (they indicate partial fills)
        // Must be sorted ASC for calculateRotationOrderSizes to match geometric weight distribution
        // RC-4: Use snapshot grids instead of live references to prevent concurrent modification
        // FIX: Guard against null/undefined return from filterOrdersByTypeAndState
        const filterForRms = (orders, type) => {
            const filtered = filterOrdersByTypeAndState(orders, type, ORDER_STATES.PARTIAL);
            if (!Array.isArray(filtered)) return [];
            return filtered
                .filter(o => !o.isDoubleOrder)
                // FIX: Use null-safe price comparison to prevent NaN in sort
                .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
        };
        
        const calculatedBuys = filterForRms(calculatedSnap, ORDER_TYPES.BUY);
        const calculatedSells = filterForRms(calculatedSnap, ORDER_TYPES.SELL);
        const persistedBuys = filterForRms(persistedSnap, ORDER_TYPES.BUY);
        const persistedSells = filterForRms(persistedSnap, ORDER_TYPES.SELL);

        // Calculate ideal sizes for each order based on current available budget
        // RC-7: Re-snapshot funds immediately before calculation to prevent staleness
        const getIdeals = (orders, type) => {
            if (!manager || orders.length === 0 || !manager.assets) return orders;
            const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';

            // RC-7: Re-take fund snapshot immediately before calculation to use fresh data
            // Prevents using stale data from 30+ lines of prior calculation
            const currentCacheValue = cacheFunds?.[side] || (manager.funds?.cacheFunds?.[side] || 0);
            const currentGridValue = manager.funds?.total?.grid?.[side] || 0;
            const total = currentCacheValue + currentGridValue;

            // Safety Gate: If total is 0 or very small during startup, don't try to size
            if (total <= 0) return orders;

            // Subtract existing partial sizes to get residual budget for ideal sizing
            const partials = sumOrderSizes(calculatedSnap.filter(o => o && o.type === type && o.state === ORDER_STATES.PARTIAL));
            const budget = Math.max(0, total - partials);

            // Calculate geometric ideal sizes based on remaining budget
            const precision = getPrecisionByOrderType(manager.assets, type);
            try {
                const idealSizes = calculateRotationOrderSizes(budget, 0, orders.length, type, manager.config, 0, precision);
                return orders.map((o, i) => ({ ...o, size: idealSizes[i] }));
            } catch (e) { return orders; }
        };

        // Calculate RMS divergence metric for each side
        const buyMetric = calculateGridSideDivergenceMetric(getIdeals(calculatedBuys, ORDER_TYPES.BUY), persistedBuys, 'buy');
        const sellMetric = calculateGridSideDivergenceMetric(getIdeals(calculatedSells, ORDER_TYPES.SELL), persistedSells, 'sell');

        // Check if metrics exceed threshold and flag sides for regeneration
        let buyUpdated = false, sellUpdated = false;
        if (manager) {
            const limit = GRID_COMPARISON.RMS_PERCENTAGE / GRID_CONSTANTS.RMS_PERCENTAGE_SCALE;  // Convert percentage threshold to decimal

            if (buyMetric > limit) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(ORDER_TYPES.BUY);
                buyUpdated = true;
            }
            if (sellMetric > limit) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(ORDER_TYPES.SELL);
                sellUpdated = true;
            }
        }

        return {
            buy: { metric: buyMetric, updated: buyUpdated },
            sell: { metric: sellMetric, updated: sellUpdated }
            // FIX: Removed unused totalMetric field - no caller depends on it
            // If re-adding for monitoring/alerting, document intended use case
        };
    }

    /**
     * Calculate current market spread using on-chain orders.
     */
    static calculateCurrentSpread(manager) {
        const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        const partialBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL);
        const partialSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.PARTIAL);

        const onChainBuys = [...activeBuys, ...partialBuys];
        const onChainSells = [...activeSells, ...partialSells];

        return calculateSpreadFromOrders(onChainBuys, onChainSells);
    }

    /**
     * Proactive spread correction check.
     * 
     * CRITICAL: Uses AsyncLock to prevent race conditions with fill processing.
     * Without the lock, a TOCTOU (Time-Of-Check-To-Use) vulnerability exists where:
     * - Fund snapshot is taken (check phase)
     * - Fill processor modifies funds in another thread
     * - Order is placed based on stale funds (use phase)
     * Result: Orders placed beyond available liquidity, fund accounting errors
     * 
     * DESIGN DECISION: Lock is released before blockchain operations for performance
     * - Lock held: Fund verification and correction decision (synchronized)
     * - Lock released: Blockchain submission (async, potentially slow)
     * - RACE CONDITION WINDOW: Between lock release and blockchain submission
     * - MITIGATION: Pre-flight fund verification before submission; comprehensive error handling
     * 
     * See RACE_CONDITION_ANALYSIS.md for detailed vulnerability documentation.
     */
    static async checkSpreadCondition(manager, BitShares, updateOrdersOnChainBatch = null) {
        // CRITICAL: Acquire corrections lock to serialize spread correction operations
        // This prevents concurrent fill processing from modifying funds while we're making decisions
        let correction = null;
        let shouldApplyCorrection = false;
        
        // FIX: Derive market price OUTSIDE the lock to reduce lock contention
        // derivePrice queries the blockchain and can be slow
        let marketPrice = manager.config.startPrice;
        if (BitShares) {
            try {
                const derived = await derivePrice(BitShares, manager.assets?.assetA?.symbol, manager.assets?.assetB?.symbol, 'pool');
                if (derived) marketPrice = derived;
            } catch (err) {
                manager.logger?.log?.(`Failed to derive market price: ${err.message}`, 'warn');
            }
        }
        
        // FIX: Use optional chaining for lock - if no lock exists, execute synchronously
        const executeSpreadCheck = () => {
            const currentSpread = Grid.calculateCurrentSpread(manager);
            // Base target widens spread beyond nominal value to account for order density and price movement
            const baseTarget = manager.config.targetSpreadPercent + (manager.config.incrementPercent * GRID_LIMITS.SPREAD_WIDENING_MULTIPLIER);
            // If double orders exist (fills causing overlaps), add extra spread tolerance to prevent over-correction
            const targetSpread = baseTarget + (Array.from(manager.orders.values()).some(o => o.isDoubleOrder) ? manager.config.incrementPercent : 0);

            const buyCount = countOrdersByType(ORDER_TYPES.BUY, manager.orders);
            const sellCount = countOrdersByType(ORDER_TYPES.SELL, manager.orders);

            manager.outOfSpread = shouldFlagOutOfSpread(currentSpread, targetSpread, buyCount, sellCount);
            if (!manager.outOfSpread) return false;

            manager.logger?.log?.(`Spread too wide (${currentSpread.toFixed(2)}%), correcting...`, 'warn');

            const decision = Grid.determineOrderSideByFunds(manager, marketPrice);
            if (!decision.side) return false;

            correction = Grid.prepareSpreadCorrectionOrders(manager, decision.side);
            return correction && correction.ordersToPlace.length > 0;
        };

        try {
            if (manager._correctionsLock?.acquire) {
                shouldApplyCorrection = await manager._correctionsLock.acquire(executeSpreadCheck);
            } else {
                shouldApplyCorrection = executeSpreadCheck();
            }
        } catch (err) {
            manager.logger?.log?.(`Error checking spread condition: ${err.message}`, 'warn');
            return { ordersPlaced: 0, partialsMoved: 0 };
        }

        // FIX: Apply blockchain operations OUTSIDE the lock to reduce lock contention
        // The lock is only needed for fund verification; order placement doesn't need it
        if (shouldApplyCorrection && updateOrdersOnChainBatch && correction) {
            try {
                await updateOrdersOnChainBatch(correction);
                manager.recalculateFunds();
                return { ordersPlaced: correction.ordersToPlace.length, partialsMoved: 0 };
            } catch (err) {
                manager.logger?.log?.(`Error applying spread correction on-chain: ${err.message}`, 'warn');
                return { ordersPlaced: 0, partialsMoved: 0 };
            }
        }
        return { ordersPlaced: 0, partialsMoved: 0 };
    }

    /**
     * Grid health check for structural violations.
     */
    static async checkGridHealth(manager, updateOrdersOnChainBatch = null) {
        if (!manager) return;
        
        // Skip health checks during bootstrap to prevent spamming warnings while grid is building
        if (manager.isBootstrapping) return { buyDust: false, sellDust: false };

        const allOrders = Array.from(manager.orders.values());
        const sells = allOrders.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => a.price - b.price);
        const buys = allOrders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => b.price - a.price);

        const logViolations = (orders, label) => {
            let seenVirtual = false;
            const hasOppositePending = allOrders.some(o => o.type !== label && o.pendingRotation);
            for (const o of orders) {
                if (o.state === ORDER_STATES.VIRTUAL) seenVirtual = true;
                if ((o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) && seenVirtual && !hasOppositePending) {
                    // FIX: Use consistent optional chaining pattern for logger calls
                    manager.logger?.log?.(`Health violation (${label}): ${o.id} is further than VIRTUAL slot.`, 'warn');
                }
            }
        };
        logViolations(sells, 'SELL');
        logViolations(buys, 'BUY');
        return { buyDust: false, sellDust: false };
    }

    /**
     * Utility to decide which side can support an extra order.
     */
    static determineOrderSideByFunds(manager, currentMarketPrice) {
        const reqBuy = Grid.calculateGeometricSizeForSpreadCorrection(manager, ORDER_TYPES.BUY);
        const reqSell = Grid.calculateGeometricSizeForSpreadCorrection(manager, ORDER_TYPES.SELL);
        
        // Use available + cacheFunds to allow checking against total liquid capital
        // FIX: Use optional chaining for consistent null safety
        const buyAvailable = (manager.funds?.available?.buy || 0) + (manager.funds?.cacheFunds?.buy || 0);
        const sellAvailable = (manager.funds?.available?.sell || 0) + (manager.funds?.cacheFunds?.sell || 0);

        const buyRatio = reqBuy ? (buyAvailable / reqBuy) : 0;
        const sellRatio = reqSell ? (sellAvailable / reqSell) : 0;

        let side = null;
        if (buyRatio >= 1 && sellRatio >= 1) side = buyRatio > sellRatio ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        else if (buyRatio >= 1) side = ORDER_TYPES.BUY;
        else if (sellRatio >= 1) side = ORDER_TYPES.SELL;

        if (!side) {
            // FIX: Use consistent optional chaining pattern for logger calls
            manager.logger?.log?.(`Spread correction skipped: insufficient funds for either side (buy ratio: ${Format.formatPercent2(buyRatio)}, sell ratio: ${Format.formatPercent2(sellRatio)}). Required: buy=${reqBuy ? Format.formatAmount8(reqBuy) : 'N/A'}, sell=${reqSell ? Format.formatAmount8(reqSell) : 'N/A'}`, 'warn');
        }

        return { side, reason: side ? `Choosing ${side}` : 'Insufficient funds' };
    }

    /**
     * Calculate simulated size for spread correction order.
     */
    static calculateGeometricSizeForSpreadCorrection(manager, targetType) {
        const side = targetType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const slotsCount = Array.from(manager.orders.values()).filter(o => o.type === targetType).length + 1;
        // FIX: Safely access funds.virtual (may not be initialized)
        const availableFunds = manager.funds?.available?.[side] || 0;
        const virtualFunds = manager.funds?.virtual?.[side] || 0;
        const total = availableFunds + virtualFunds;
        if (total <= 0 || slotsCount <= 1) return null;

        const precision = getPrecisionForSide(manager.assets, side);
        // FIX: Create new object for each array element to prevent shared reference mutations
        // Array(n).fill(obj) creates array with same object reference, causing mutation issues
        const dummy = Array.from({ length: slotsCount }, () => ({ type: targetType }));
        try {
            const sized = calculateOrderSizes(dummy, manager.config, side === 'sell' ? total : 0, side === 'buy' ? total : 0, 0, 0, precision, precision);
            if (!Array.isArray(sized) || sized.length === 0) {
                manager.logger?.log?.(`calculateOrderSizes returned invalid result for spread correction`, 'warn');
                return null;
            }
            return side === 'sell' ? sized[sized.length - 1].size : sized[0].size;
        } catch (e) { 
            manager.logger?.log?.(`Error calculating geometric size for spread correction: ${e.message}`, 'warn');
            return null; 
        }
    }

    static prepareSpreadCorrectionOrders(manager, preferredSide) {
        // FIX: Validate preferredSide parameter to prevent silent logic errors
        if (preferredSide !== ORDER_TYPES.BUY && preferredSide !== ORDER_TYPES.SELL) {
            throw new Error(`Invalid preferredSide: ${preferredSide}. Must be '${ORDER_TYPES.BUY}' or '${ORDER_TYPES.SELL}'.`);
        }
        
        const ordersToPlace = [];
        const railType = preferredSide;

        // Find all virtual slots that could potentially take this role
        const candidateSlots = Array.from(manager.orders.values())
            .filter(o => o.state === ORDER_STATES.VIRTUAL && !o.orderId)
            .sort((a, b) => railType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        // Find the slot closest to market that isn't currently active
        const candidate = candidateSlots[0];

        if (candidate) {
            const size = Grid.calculateGeometricSizeForSpreadCorrection(manager, railType);
            const sideName = railType === ORDER_TYPES.BUY ? 'buy' : 'sell';
            // Include cacheFunds in availability check
            // FIX: Use optional chaining for consistent null safety
            const availableFund = (manager.funds?.available?.[sideName] || 0) + (manager.funds?.cacheFunds?.[sideName] || 0);

            if (size && size <= availableFund) {
                // Check if available funds would create a dust-sized order (below dust threshold of ideal size)
                const dustThresholdPercent = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE;
                const orderSizeRatio = (availableFund / size) * 100;

                if (orderSizeRatio < dustThresholdPercent) {
                    manager.logger?.log?.(`Spread correction order skipped: available funds would create dust order (${Format.formatPercent2(orderSizeRatio)}% of ideal size ${Format.formatAmount8(size)}, below ${dustThresholdPercent}% threshold)`, 'warn');
                } else {
                    const activated = { ...candidate, type: railType, size, state: ORDER_STATES.VIRTUAL };
                    ordersToPlace.push(activated);
                    // FIX: Removed unnecessary pause/resume for single update
                    // Single _updateOrder calls automatically recalculate funds (no batching needed)
                    // Additionally, pauseFundRecalc inside the async lock creates unnecessary overhead
                    manager._updateOrder(activated);
                }
            } else if (size) {
                manager.logger?.log?.(`Spread correction order skipped: calculated size (${Format.formatAmount8(size)}) exceeds available funds (${Format.formatAmount8(availableFund)})`, 'warn');
            }
        }
        return { ordersToPlace, partialMoves: [] };
    }

    /**
     * Internal utility to update orders with new geometric sizes.
     * @private
     */
    static _updateOrdersForSide(manager, orderType, newSizes, orders = null) {
        const ords = Array.isArray(orders) ? orders : Array.from(manager.orders.values()).filter(o => o.type === orderType);
        if (ords.length === 0 || newSizes.length !== ords.length) return;
        ords.forEach((order, i) => {
            const newSize = newSizes[i] || 0;
            if (order.size === undefined || Math.abs(order.size - newSize) > 1e-8) {
                try {
                    manager._updateOrder({ ...order, size: newSize });
                } catch (err) {
                    manager.logger?.log?.(`Error updating order ${order.id} size: ${err.message}`, 'warn');
                }
            }
        });
    }

    static _getFundSnapshot(manager) {
        const snap = manager.getChainFundsSnapshot();
        return { ...snap, gridBuy: Number(manager.funds?.total?.grid?.buy || 0), gridSell: Number(manager.funds?.total?.grid?.sell || 0), cacheBuy: Number(manager.funds?.cacheFunds?.buy || 0), cacheSell: Number(manager.funds?.cacheFunds?.sell || 0) };
    }
}

module.exports = Grid;