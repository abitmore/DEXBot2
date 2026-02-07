/**
 * modules/order/grid.js - Grid Engine
 *
 * Order grid creation, synchronization, and health management.
 * Exports a single Grid class with static methods for grid operations.
 *
 * Manages the complete lifecycle of the order grid:
 * - Creates geometric price grids with configurable spacing (increments)
 * - Synchronizes grid state with blockchain and fund changes
 * - Monitors grid health and handles spread corrections
 * - Calculates order sizes and allocations based on funds
 * - Detects and flags out-of-spread conditions
 *
 * ===============================================================================
 * TABLE OF CONTENTS - Grid Class (20 static methods)
 * ===============================================================================
 *
 * GRID SIZING & CONTEXT (2 methods)
 *   1. _getSizingContext(manager, side) - Get budget and sizing parameters (internal, static)
 *      Determines budget from allocated funds, deducts BTS fees if needed
 *   2. _ensureCacheFundsInitialized(manager) - Ensure cache funds structure exists (internal, static)
 *
 * CACHE FUND MANAGEMENT (1 method)
 *   3. _updateCacheFundsAtomic(manager, sideName, newValue) - Update cache funds atomically (async, internal, static)
 *
 * GRID CREATION (1 method)
 *   4. createOrderGrid(config) - Create geometric price grid (static)
 *      Returns price levels from minPrice to maxPrice with increment spacing
 *
 * ORDER CACHE MANAGEMENT (2 methods - async, internal)
 *   5. _clearOrderCachesAtomic(manager) - Clear order caches (_ordersByType, _ordersByState)
 *   6. _updateOrderAtomic(manager, order, context, skipAccounting, fee) - Update order atomically with caches
 *
 * GRID LOADING & INITIALIZATION (2 methods - async)
 *   7. loadGrid(manager, grid, boundaryIdx) - Load grid into manager orders
 *   8. initializeGrid(manager) - Full grid initialization from config
 *
 * GRID RECALCULATION (1 method - async)
 *   9. recalculateGrid(manager, opts) - Recalculate grid based on current state
 *
 * GRID STATE CHECKING (1 method)
 *   10. checkAndUpdateGridIfNeeded(manager) - Check if grid needs update
 *
 * BLOCKCHAIN SYNCHRONIZATION (2 methods - async)
 *   11. _recalculateGridOrderSizesFromBlockchain(manager, orderType) - Recalculate sizes from blockchain
 *   12. updateGridFromBlockchainSnapshot(manager, orderType, fromBlockchainTimer) - Update grid from blockchain
 *
 * GRID COMPARISON (1 method - async)
 *   13. compareGrids(calculatedGrid, persistedGrid, manager) - Compare two grids
 *       Validates grid structure and reports divergence metrics
 *
 * SPREAD MANAGEMENT (2 methods - async)
 *   14. calculateCurrentSpread(manager) - Calculate current bid-ask spread
 *   15. checkSpreadCondition(manager, BitShares, updateOrdersOnChainBatch) - Check and flag spread condition
 *
 * GRID HEALTH MONITORING (3 methods)
 *   16. checkGridHealth(manager, updateOrdersOnChainBatch) - Monitor grid health (async)
 *   17. _hasAnyDust(manager, partials, type) - Check for dust orders (internal, static)
 *   18. determineOrderSideByFunds(manager, currentMarketPrice) - Determine priority side
 *
 * SPREAD CORRECTION (2 methods)
 *   19. calculateGeometricSizeForSpreadCorrection(manager, targetType) - Calculate correction size
 *   20. prepareSpreadCorrectionOrders(manager, preferredSide) - Prepare correction orders
 *
 * ===============================================================================
 *
 * GRID STRUCTURE:
 * Grid = Array of slots with:
 * - id: Order ID (null for virtual)
 * - price: Price level
 * - size: Grid allocation
 * - grid: In-grid size (ACTIVE + PARTIAL orders)
 * - blockchain: On-blockchain size
 * - type: BUY, SELL, or SPREAD
 * - state: VIRTUAL, ACTIVE, PARTIAL
 *
 * GRID LIFECYCLE:
 * 1. createOrderGrid(config) - Generate price levels
 * 2. assignGridRoles() - Assign BUY/SELL/SPREAD roles based on boundary
 * 3. calculateOrderSizes() - Allocate funds to slots
 * 4. loadGrid() - Create grid Order objects in manager
 * 5. syncFromOpenOrders() - Load blockchain state
 * 6. recalculateGrid() - Keep in sync as market/funds change
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, GRID_LIMITS, TIMING, INCREMENT_BOUNDS, FEE_PARAMETERS } = require('../constants');
const { GRID_COMPARISON } = GRID_LIMITS;
const Format = require('./format');

// FIX: Extract magic numbers to named constants for maintainability
const GRID_CONSTANTS = {
    RMS_PERCENTAGE_SCALE: 100,  // Convert RMS percentage threshold from percent to decimal
};

const {
    floatToBlockchainInt,
    blockchainToFloat,
    getPrecisionByOrderType,
    getPrecisionsForManager,
    calculateOrderCreationFees,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateGridSideDivergenceMetric,
    getMinAbsoluteOrderSize,
    getSingleDustThreshold,
    getDoubleDustThreshold,
    calculateAvailableFundsValue,
    calculateSpreadFromOrders,
    allocateFundsByWeights
} = require('./utils/math');
const {
    filterOrdersByType,
    checkSizesBeforeMinimum,
    checkSizeThreshold,
    resolveConfiguredPriceBound,
    countOrdersByType,
    shouldFlagOutOfSpread,
    isOrderHealthy,
    isPhantomOrder,
    isSlotAvailable,
    getPartialsByType
} = require('./utils/order');
const { derivePrice } = require('./utils/system');

class Grid {
    /**
     * Calculate the spread gap size (number of empty slots between BUY and SELL rails).
     * Shared by grid creation and strategy rebalancing to keep spread math consistent.
     *
     * @param {number} incrementPercent
     * @param {number} targetSpreadPercent
     * @returns {number}
     */
    static calculateGapSlots(incrementPercent, targetSpreadPercent) {
        const fallbackIncrement = Number(DEFAULT_CONFIG.incrementPercent) || 0.5;
        const safeIncrement = (Number.isFinite(incrementPercent) && incrementPercent > 0) ? incrementPercent : fallbackIncrement;
        const step = 1 + (safeIncrement / 100);
        const minSpreadPercent = safeIncrement * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2.1);
        const effectiveTargetSpread = Math.max(targetSpreadPercent || 0, minSpreadPercent);
        const requiredSteps = Math.ceil(Math.log(1 + (effectiveTargetSpread / 100)) / Math.log(step));
        return Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps - 1);
    }

    /**
     * Public wrapper for side sizing context.
     * Keeps StrategyEngine decoupled from Grid private internals.
     *
     * @param {Object} manager
     * @param {'buy'|'sell'} side
     * @returns {Object|null}
     */
    static getSizingContext(manager, side) {
        return Grid._getSizingContext(manager, side);
    }

    /**
     * Unifies budget calculation and fee deduction for all grid sizing scenarios.
     * Ensures consistent fund context (Allocated vs Total) across the bot.
     *
     * @param {Object} manager - OrderManager instance
     * @param {string} side - 'buy' or 'sell'
     * @returns {Object} { budget, precision, config }
     * @private
     */
    static _getSizingContext(manager, side) {
        if (!manager || !manager.assets) return null;

        // 1. Ensure fund state is fresh before sizing
        manager.recalculateFunds();

        const snap = manager.getChainFundsSnapshot ? manager.getChainFundsSnapshot() : {};
        const isBuy = side === 'buy';
        const type = isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;

        // 2. Determine base budget: Always use ALLOCATED funds (respects botFunds %)
        // This ensures the bot only "thinks" about the capital it is allowed to use.
        let budget = isBuy ? (snap.allocatedBuy || 0) : (snap.allocatedSell || 0);

        // 3. Standardize BTS Fee Deduction (Issue #15 consistency)
        // If this side is the BTS-holding side, it must reserve fees for the WHOLE grid.
        const isBtsSide = (isBuy && manager.config.assetB === 'BTS') || (!isBuy && manager.config.assetA === 'BTS');
        if (isBtsSide && budget > 0) {
            const targetBuy = Math.max(0, manager.config.activeOrders?.buy || 1);
            const targetSell = Math.max(0, manager.config.activeOrders?.sell || 1);
            const totalTarget = targetBuy + targetSell;

            const btsFees = calculateOrderCreationFees(
                manager.config.assetA,
                manager.config.assetB,
                totalTarget,
                FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER
            );
            budget = Math.max(0, budget - btsFees);
        }

        return {
            budget,
            precision: getPrecisionByOrderType(manager.assets, type),
            config: manager.config
        };
    }

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
        const current = manager.funds?.cacheFunds?.[sideName] || 0;
        const delta = newValue - current;
        return await manager.modifyCacheFunds(sideName, delta, 'recalculate-remainder');
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
        if (minPrice <= 0) {
            throw new Error(`Invalid minPrice: ${minPrice}. Must be positive.`);
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

        if (!Number.isFinite(incrementPercent)) {
            throw new Error(`Invalid incrementPercent: ${incrementPercent}. Must be a finite number.`);
        }
        if (incrementPercent < INCREMENT_BOUNDS.MIN_PERCENT || incrementPercent > INCREMENT_BOUNDS.MAX_PERCENT) {
            throw new Error(
                `Invalid incrementPercent: ${incrementPercent}. Must be between ` +
                `${INCREMENT_BOUNDS.MIN_PERCENT} and ${INCREMENT_BOUNDS.MAX_PERCENT} (inclusive).`
            );
        }

        const stepUp = 1 + (incrementPercent / 100);
        const stepDown = 1 - (incrementPercent / 100);

        // ================================================================================
        // STEP 1: GENERATE PRICE LEVELS (Geometric progression)
        // ================================================================================
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

        if (priceLevels.length === 0) {
            throw new Error(
                `Grid generation produced no price levels for startPrice=${startPrice}, ` +
                `bounds=[${minPrice}, ${maxPrice}], incrementPercent=${incrementPercent}. ` +
                `Widen bounds or reduce incrementPercent.`
            );
        }

        // ================================================================================
        // STEP 2: FIND SPLIT INDEX (First slot at or above startPrice)
        // ================================================================================
        // The split index is used to center the spread gap around market price.
        // Pivot concept (slot closest to startPrice) was previously used but is now
        // calculated separately in strategy.js as part of role assignment logic.

        // ================================================================================
        // STEP 3: CALCULATE SPREAD GAP SIZE
        // ================================================================================
        // Determine how many slots should be in the spread zone.
        // See formula documentation in JSDoc above.

        const gapSlots = Grid.calculateGapSlots(incrementPercent, config.targetSpreadPercent);

        // ================================================================================
        // STEP 4: ROLE ASSIGNMENT (BUY / SPREAD / SELL)
        // ================================================================================
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

        // ================================================================================
        // STEP 5: CREATE ORDER OBJECTS
        // ================================================================================
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

            const order = {
                id: `slot-${i}`,
                price,
                type,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            };

            return order;
        });

        const buyCount = orders.filter(o => o.type === ORDER_TYPES.BUY).length;
        const sellCount = orders.filter(o => o.type === ORDER_TYPES.SELL).length;
        if (buyCount === 0 || sellCount === 0) {
            throw new Error(
                `Grid generation produced an imbalanced rail (buy=${buyCount}, sell=${sellCount}) for ` +
                `startPrice=${startPrice}, bounds=[${minPrice}, ${maxPrice}], incrementPercent=${incrementPercent}, ` +
                `targetSpreadPercent=${config.targetSpreadPercent}. Widen bounds or reduce target spread.`
            );
        }

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
    static async _updateOrderAtomic(manager, order, context = 'grid-load', skipAccounting = false, fee = 0) {
        if (manager._gridLock?.acquire) {
            return await manager._gridLock.acquire(() => {
                manager._updateOrder(order, context, skipAccounting, fee);
            });
        } else {
            manager._updateOrder(order, context, skipAccounting, fee);
        }
    }

    /**
     * Restore a persisted grid snapshot onto a manager instance.
     * @param {OrderManager} manager - The manager instance.
     * @param {Array<Object>} grid - The persisted grid array.
     * @param {number|null} [boundaryIdx=null] - The master boundary index.
     * @returns {Promise<void>}
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

        manager.pauseRecalcLogging();
        manager.pauseFundRecalc();
        try {
            // RC-2: Use atomic order updates to prevent concurrent state corruption
            for (const order of grid) {
                // SANITY CHECK: If order is phantom (ACTIVE/PARTIAL without orderId), downgrade to VIRTUAL
                // This fixes "Wrong active order" bugs where state gets corrupted
                if (isPhantomOrder(order)) {
                    manager.logger?.log?.(`Sanitizing corrupted order ${order.id}: ACTIVE/PARTIAL without orderId -> VIRTUAL`, 'warn');
                    order.state = ORDER_STATES.VIRTUAL;
                    // Keep size as-is for debug context, _updateOrder handles state transitions correctly
                }
                await Grid._updateOrderAtomic(manager, order, 'grid-load', true);
            }
            
            // RC-FIX: Restore targetSpreadCount from loaded grid
            // Without this, targetSpreadCount defaults to 0, causing false positive "Spread too wide" detections
            const spreadCount = grid.filter(o => o.type === ORDER_TYPES.SPREAD).length;
            manager.targetSpreadCount = spreadCount;
            manager.currentSpreadCount = spreadCount;

        } finally {
            manager.resumeFundRecalc();
            manager.resumeRecalcLogging();
        }
        // FIX: Use consistent optional chaining pattern for logger calls
        manager.logger?.log?.(`Loaded ${manager.orders.size} orders from persisted grid.`, 'info');
    }

    /**
     * Initialize the order grid with blockchain-aware sizing.
     * @param {OrderManager} manager - The manager instance.
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails or account totals are missing.
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

        // Auto-derive price if not a fixed numeric value (e.g. "pool", "market", or undefined)
        if (typeof mpRaw !== 'number' || isNaN(mpRaw)) {
            try {
                const { BitShares } = require('../bitshares_client');
                const derived = await derivePrice(BitShares, manager.config.assetA, manager.config.assetB, manager.config.priceMode || 'auto');
                if (derived) {
                    manager.config.startPrice = Number(derived);
                } else {
                    throw new Error(`Price derivation returned no result for ${manager.config.assetA}/${manager.config.assetB}`);
                }
            } catch (err) {
                // FIX: Use logger instead of console.warn (Issue #5)
                manager.logger?.log?.(`Failed to derive market price: ${err.message}`, 'warn');
                throw err; // Re-throw to prevent "pool" string reaching numeric math
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

        const minSellSize = getMinAbsoluteOrderSize(ORDER_TYPES.SELL, manager.assets);
        const minBuySize = getMinAbsoluteOrderSize(ORDER_TYPES.BUY, manager.assets);

        const { A: precA, B: precB } = getPrecisionsForManager(manager.assets);

        // Use centralized sizing context for both sides
        const sellCtx = Grid._getSizingContext(manager, 'sell');
        const buyCtx = Grid._getSizingContext(manager, 'buy');

        if (!sellCtx || !buyCtx) throw new Error('Failed to retrieve sizing context for grid initialization');

        let sizedOrders = calculateOrderSizes(
            orders,
            manager.config,
            sellCtx.budget,
            buyCtx.budget,
            minSellSize,
            minBuySize,
            precA,
            precB
        );

        // Verification of sizes
        const sells = filterOrdersByType(sizedOrders, ORDER_TYPES.SELL).map(o => Number(o.size || 0));
        const buys = filterOrdersByType(sizedOrders, ORDER_TYPES.BUY).map(o => Number(o.size || 0));
        if (checkSizesBeforeMinimum(sells, minSellSize, precA) || checkSizesBeforeMinimum(buys, minBuySize, precB)) {
            throw new Error('Calculated orders fall below minimum allowable size.');
        }

        // Check for warning if orders are near minimal size (regression fix)
        const warningSellSize = minSellSize > 0 ? getMinAbsoluteOrderSize(ORDER_TYPES.SELL, manager.assets, 100) : 0;
        const warningBuySize = minBuySize > 0 ? getMinAbsoluteOrderSize(ORDER_TYPES.BUY, manager.assets, 100) : 0;
        if (checkSizeThreshold(sells, warningSellSize, precA, false) || checkSizeThreshold(buys, warningBuySize, precB, false)) {
            manager.logger?.log?.("WARNING: Order grid contains orders near minimum size. To ensure the bot runs properly, consider increasing the funds of your bot.", "warn");
        }

        // RC-2: Use atomic clear to prevent concurrent modifications
        await Grid._clearOrderCachesAtomic(manager);
        manager.resetFunds();

        manager.pauseRecalcLogging();
        manager.pauseFundRecalc();
        try {
            // RC-2: Use atomic order updates to prevent concurrent state corruption
            for (const order of sizedOrders) {
                await Grid._updateOrderAtomic(manager, order, 'grid-init', true);
            }
        } finally {
            manager.resumeFundRecalc();
            manager.resumeRecalcLogging();
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
    }

    /**
     * Full grid resynchronization from blockchain state.
     * @param {OrderManager} manager - The manager instance.
     * @param {Object} opts - Options for resynchronization.
     * @param {Function} opts.readOpenOrdersFn - Function to read open orders.
     * @param {Object} opts.chainOrders - Chain orders module.
     * @param {string} opts.account - Account name.
     * @param {string} opts.privateKey - Private key.
     * @returns {Promise<void>}
     */
    static async recalculateGrid(manager, opts) {
        const { readOpenOrdersFn, chainOrders, account, privateKey } = opts;

        // Suppress invariant warnings during full resync
        if (typeof manager.startBootstrap === 'function') {
            manager.startBootstrap();
        } else {
            manager.isBootstrapping = true;
        }

        // FIX: Use consistent optional chaining pattern for logger calls
        manager.logger?.log?.('Starting full resync...', 'info');

        await manager._initializeAssets();
        await manager.fetchAccountTotals();

        const chainOpenOrders = await readOpenOrdersFn();
        if (!Array.isArray(chainOpenOrders)) return;

        // CRITICAL: Filter out PARTIAL orders before synchronizing - they're from old grid
        // and shouldn't be part of the fresh regenerated grid structure
        const activeOrders = chainOpenOrders.filter(o => o.state !== ORDER_STATES.PARTIAL);

        await manager.synchronizeWithChain(activeOrders, 'readOpenOrders');
        manager.resetFunds();

        await manager.persistGrid();
        await Grid.initializeGrid(manager);

        const { reconcileStartupOrders } = require('./startup_reconcile');

        // FIX: Add error context for debugging grid recalculation issues
        try {
            await reconcileStartupOrders({ manager, config: manager.config, account, privateKey, chainOrders, chainOpenOrders });
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
     * @returns {Object} Update status for each side
     * @returns {boolean} returns.buyUpdated - Buy side exceeded regeneration threshold
     * @returns {boolean} returns.sellUpdated - Sell side exceeded regeneration threshold
     */
    static checkAndUpdateGridIfNeeded(manager) {
        const threshold = GRID_LIMITS.GRID_REGENERATION_PERCENTAGE || 1;
        const chainSnap = manager.getChainFundsSnapshot();
        const gridBuy = Number(manager.funds?.total?.grid?.buy || 0);
        const gridSell = Number(manager.funds?.total?.grid?.sell || 0);
        const result = { buyUpdated: false, sellUpdated: false };

        const sides = [
            { name: 'buy', grid: gridBuy, orderType: ORDER_TYPES.BUY },
            { name: 'sell', grid: gridSell, orderType: ORDER_TYPES.SELL }
        ];

        for (const s of sides) {
            if (s.grid <= 0) continue;
            const avail = calculateAvailableFundsValue(s.name, manager.accountTotals, manager.funds, manager.config.assetA, manager.config.assetB, manager.config.activeOrders);
            const totalPending = avail;
            // Denominator: bot's total funds for this side (respects botFunds % allocation).
            // Primary: allocated (botFunds-adjusted). Fallback: chainTotal (free + locked).
            // Previous fallback (grid + pending) caused false-positive triggers when the
            // grid allocation was small relative to total funds.
            const allocated = s.name === 'buy' ? chainSnap.allocatedBuy : chainSnap.allocatedSell;
            const chainTotal = s.name === 'buy' ? chainSnap.chainTotalBuy : chainSnap.chainTotalSell;
            const denominator = (allocated > 0) ? allocated : chainTotal;
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

        // Use centralized sizing context (respects botFunds % allocation)
        const ctx = Grid._getSizingContext(manager, sideName);
        if (!ctx) return;

        // Get ALL slots for this side, sorted for calculateRotationOrderSizes
        // SELL: sorted ASC (Market to Edge)
        // BUY: sorted ASC (Edge to Market)
        const allSideSlots = Array.from(manager.orders.values())
            .filter(o => o.type === orderType)
            .sort((a, b) => a.price - b.price);

        if (allSideSlots.length === 0) return;

        // Calculate geometric sizes for the ENTIRE rail
        const newSizes = calculateRotationOrderSizes(
            ctx.budget,
            0,
            allSideSlots.length,
            orderType,
            manager.config,
            0,
            ctx.precision
        );

        manager.pauseRecalcLogging();
        try {
            // Apply new sizes to all slots on the side
            allSideSlots.forEach((slot, i) => {
                const newSize = newSizes[i] || 0;
                
                // Use integer comparison to avoid redundant updates from float noise
                const currentSizeInt = floatToBlockchainInt(slot.size || 0, ctx.precision);
                const newSizeInt = floatToBlockchainInt(newSize, ctx.precision);

                // Update size but preserve existing state and orderId
                if (slot.size === undefined || currentSizeInt !== newSizeInt) {
                    // CRITICAL: Set skipAccounting=false to ensure delta is consumed/released from ChainFree
                    manager._updateOrder({ ...slot, size: newSize }, 'grid-resize', false, 0);
                }
            });

            manager.recalculateFunds();
        } finally {
            manager.resumeRecalcLogging();
        }

        // Calculate remaining cache for this side only
        const totalInputInt = floatToBlockchainInt(ctx.budget, ctx.precision);
        let totalAllocatedInt = 0;
        newSizes.forEach(s => totalAllocatedInt += floatToBlockchainInt(s, ctx.precision));

        const newCacheValue = blockchainToFloat(totalInputInt - totalAllocatedInt, ctx.precision);
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
    static async compareGrids(calculatedGrid, persistedGrid, manager = null) {
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

        // Filter to ACTIVE orders only (excludes PARTIAL/VIRTUAL/SPREAD)
        // Partial orders are excluded from divergence calculation as they are expected to deviate;
        // they are instead handled by the simple cacheFunds ratio check or the follow-up correction.
        // Must be sorted ASC for calculateRotationOrderSizes to match geometric weight distribution
        const filterForRms = (orders, type) => {
            const result = Array.isArray(orders) ? orders.filter(o => o && o.type === type && o.state === ORDER_STATES.ACTIVE) : [];
            return result
                .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
        };

        const calculatedBuys = filterForRms(calculatedSnap, ORDER_TYPES.BUY);
        const calculatedSells = filterForRms(calculatedSnap, ORDER_TYPES.SELL);
        const persistedBuys = filterForRms(persistedSnap, ORDER_TYPES.BUY);
        const persistedSells = filterForRms(persistedSnap, ORDER_TYPES.SELL);

        // Calculate ideal sizes for each order based on current available budget
        const getIdeals = (activeOrders, type) => {
            if (!manager || activeOrders.length === 0 || !manager.assets) return activeOrders;
            const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';

            // 1. Get centralized sizing context (respects botFunds % allocation)
            const ctx = Grid._getSizingContext(manager, side);
            if (!ctx || ctx.budget <= 0) return activeOrders;

            // 2. Identify ALL slots currently assigned to this side
            // Ideal sizing must use the full slot count to determine geometric share per slot
            const sideSlots = Array.from(manager.orders.values())
                .filter(o => o.type === type)
                .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

            if (sideSlots.length === 0) return activeOrders;

            // 3. Calculate geometric ideals for the ENTIRE side (all slots)
            try {
                const allIdealSizes = calculateRotationOrderSizes(
                    ctx.budget,
                    0,
                    sideSlots.length,
                    type,
                    manager.config,
                    0,
                    ctx.precision
                );

                // Map Ideal sizes to IDs for quick lookup
                const idealMap = new Map();
                sideSlots.forEach((slot, i) => idealMap.set(slot.id, allIdealSizes[i]));

                // Return the activeOrders subset with their true geometric ideal sizes
                return activeOrders.map(o => ({ ...o, size: idealMap.get(o.id) ?? 0 }));
            } catch (e) {
                return activeOrders;
            }
        };

        // Calculate RMS divergence metric for each side
        const buyMetric = calculateGridSideDivergenceMetric(getIdeals(calculatedBuys, ORDER_TYPES.BUY), persistedBuys, 'buy');
        const sellMetric = calculateGridSideDivergenceMetric(getIdeals(calculatedSells, ORDER_TYPES.SELL), persistedSells, 'sell');

        // Check if metrics exceed threshold and flag sides for regeneration
        // Set RMS_PERCENTAGE to 0 to disable RMS divergence checks
        let buyUpdated = false, sellUpdated = false;
        if (manager && GRID_COMPARISON.RMS_PERCENTAGE > 0) {
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
            sell: { metric: sellMetric, updated: sellUpdated },
            totalMetric: (buyMetric + sellMetric) / 2
        };
    }

    /**
     * Calculate current market spread using on-chain orders.
     * @param {OrderManager} manager - The manager instance.
     * @returns {number} The calculated spread percentage.
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

        // Market price is only used for valuation during side-selection decision.
        // We rely on config.startPrice (which is updated periodically) to avoid redundant blockchain calls.
        const startPrice = manager.config.startPrice;

        // FIX: Use optional chaining for lock - if no lock exists, execute synchronously
        const executeSpreadCheck = () => {
            const currentSpread = Grid.calculateCurrentSpread(manager);

            // Nominal spread is the configured target spread percentage
            // When a side is doubled, increase target spread by one increment to naturally widen the gap
            let nominalSpread = manager.config.targetSpreadPercent || 2.0;
            if (manager.buySideIsDoubled || manager.sellSideIsDoubled) {
                nominalSpread += manager.config.incrementPercent;
            }

            // Tolerance allows some "floating" before correction (fixed 1 step + doubled state)
            const toleranceSteps = 1 + (manager.buySideIsDoubled ? 1 : 0) + (manager.sellSideIsDoubled ? 1 : 0);

            const buyCount = countOrdersByType(ORDER_TYPES.BUY, manager.orders);
            const sellCount = countOrdersByType(ORDER_TYPES.SELL, manager.orders);

            manager.outOfSpread = shouldFlagOutOfSpread(currentSpread, nominalSpread, toleranceSteps, buyCount, sellCount, manager.config.incrementPercent);
            if (manager.outOfSpread === 0) return false;

            // Limit spread = nominal + increment per tolerance step (1, 2, or 3 increments based on doubled state)
            const limitSpread = nominalSpread + (manager.config.incrementPercent * toleranceSteps);
            manager.logger?.log?.(`Spread too wide (${Format.formatPercent(currentSpread)} > ${Format.formatPercent(limitSpread)}), correcting with ${manager.outOfSpread} extra slot(s)...`, 'warn');

            const decision = Grid.determineOrderSideByFunds(manager, startPrice);
            if (!decision.side) return false;

            // Perform spread correction by placing orders on the side with more available funds
            correction = Grid.prepareSpreadCorrectionOrders(manager, decision.side);
            if (!correction) return false;
            const placeCount = correction.ordersToPlace?.length || 0;
            const updateCount = correction.ordersToUpdate?.length || 0;
            return (placeCount + updateCount) > 0;
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
                const batchResult = await updateOrdersOnChainBatch(correction);
                if (!batchResult || batchResult.executed !== true) {
                    manager.logger?.log?.(`Spread correction batch was prepared but not executed. Keeping local state unchanged.`, 'warn');
                    return { ordersPlaced: 0, partialsMoved: 0 };
                }
                manager.recalculateFunds();
                const placed = correction.ordersToPlace?.length || 0;
                const updated = correction.ordersToUpdate?.length || 0;
                return { ordersPlaced: placed + updated, partialsMoved: updated };
            } catch (err) {
                manager.logger?.log?.(`Error applying spread correction on-chain: ${err.message}`, 'warn');
                return { ordersPlaced: 0, partialsMoved: 0 };
            }
        }
        return { ordersPlaced: 0, partialsMoved: 0 };
    }

    /**
     * Grid health check for structural violations.
     * Monitors for "Dust Partials" that are too small to be traded on-chain.
     *
     * NOTE: Internal gaps (virtual slots between active ones) are no longer
     * flagged as violations. The "Edge-First" placement strategy intentionally
     * creates these gaps to maximize grid coverage during fund expansion.
     *
     * @param {OrderManager} manager - The manager instance.
     * @param {Function|null} [updateOrdersOnChainBatch=null] - Optional batch update function.
     * @returns {Promise<Object>} Health status { buyDust, sellDust }.
     */
    static async checkGridHealth(manager, updateOrdersOnChainBatch = null) {
        if (!manager) return { buyDust: false, sellDust: false };

        // Skip health checks during bootstrap to prevent spamming warnings
        if (manager.isBootstrapping) return { buyDust: false, sellDust: false };

        const allOrders = Array.from(manager.orders.values());
        const { buy: buyPartials, sell: sellPartials } = getPartialsByType(allOrders);

        const buyDust = buyPartials.length > 0 && Grid._hasAnyDust(manager, buyPartials, ORDER_TYPES.BUY);
        const sellDust = sellPartials.length > 0 && Grid._hasAnyDust(manager, sellPartials, ORDER_TYPES.SELL);

        return { buyDust, sellDust };
    }

    /**
     * Internal helper to check for dust partials on a specific side.
     * @private
     */
    static _hasAnyDust(manager, partials, type) {
        if (!partials || partials.length === 0) return false;

        const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const ctx = Grid._getSizingContext(manager, side);
        if (!ctx || ctx.budget <= 0) return false;

        const sideSlots = Array.from(manager.orders.values())
            .filter(o => o.type === type)
            .sort((a, b) => a.price - b.price);

        if (sideSlots.length === 0) return false;

        const idealSizes = allocateFundsByWeights(
            ctx.budget,
            sideSlots.length,
            manager.config.weightDistribution[side],
            manager.config.incrementPercent / 100,
            type === ORDER_TYPES.BUY,
            0,
            ctx.precision
        );

        return partials.some(p => {
            const idx = sideSlots.findIndex(s => s.id === p.id);
            if (idx === -1) return false;
            const threshold = getSingleDustThreshold(idealSizes[idx]);
            return p.size < threshold;
        });
    }

    /**
     * Public dust helper shared by StrategyEngine and Grid health checks.
     * @param {OrderManager} manager
     * @param {Array<Object>} partials
     * @param {'buy'|'sell'} side
     * @returns {boolean}
     */
    static hasAnyDust(manager, partials, side) {
        const type = side === 'buy' ? ORDER_TYPES.BUY : side === 'sell' ? ORDER_TYPES.SELL : null;
        if (!type) return false;
        return Grid._hasAnyDust(manager, partials, type);
    }

    /**
     * Utility to decide which side can support an extra order.
     * @param {OrderManager} manager - The manager instance.
     * @param {number} currentMarketPrice - The current market price.
     * @returns {Object} Side decision { side, reason }.
     */
    static determineOrderSideByFunds(manager, currentMarketPrice) {
        const reqBuy = Grid.calculateGeometricSizeForSpreadCorrection(manager, ORDER_TYPES.BUY);
        const reqSell = Grid.calculateGeometricSizeForSpreadCorrection(manager, ORDER_TYPES.SELL);

        // Available funds already include fill proceeds (cacheFunds is part of chainFree)
        const buyAvailable = (manager.funds?.available?.buy || 0);
        const sellAvailable = (manager.funds?.available?.sell || 0);

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
     * Calculates the ideal size for a spread correction order using geometric weighting.
     * @param {Object} manager - The OrderManager instance.
     * @param {string} targetType - The type of order (BUY/SELL).
     * @returns {number|null} The calculated size or null if failed.
     */
    static calculateGeometricSizeForSpreadCorrection(manager, targetType) {
        const side = targetType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const slotsCount = Array.from(manager.orders.values()).filter(o => o.type === targetType).length + 1;

        // Use centralized sizing context (respects botFunds % allocation)
        const ctx = Grid._getSizingContext(manager, side);
        if (!ctx || ctx.budget <= 0 || slotsCount < 1) return null;

        // ALLOW slotsCount === 1 to enable spread correction even if a side is completely missing
        const dummy = Array.from({ length: slotsCount }, () => ({ type: targetType }));
        try {
            const sized = calculateOrderSizes(
                dummy,
                manager.config,
                side === 'sell' ? ctx.budget : 0,
                side === 'buy' ? ctx.budget : 0,
                0,
                0,
                ctx.precision,
                ctx.precision
            );
            if (!Array.isArray(sized) || sized.length === 0) {
                manager.logger?.log?.(`calculateOrderSizes returned invalid result for spread correction`, 'warn');
                return null;
            }
            return side === 'sell' ? sized[0].size : sized[sized.length - 1].size;
        } catch (e) {
            manager.logger?.log?.(`Error calculating geometric size for spread correction: ${e.message}`, 'warn');
            return null;
        }
    }

    /**
     * Prepares one or more orders to correct a wide spread.
     * @param {Object} manager - The OrderManager instance.
     * @param {string} preferredSide - The side to place the correction on (ORDER_TYPES.BUY/SELL).
     * @returns {Object} Correction result { ordersToPlace }.
     * @throws {Error} If preferredSide is invalid.
     */
    static prepareSpreadCorrectionOrders(manager, preferredSide) {
        // FIX: Validate preferredSide parameter to prevent silent logic errors
        if (preferredSide !== ORDER_TYPES.BUY && preferredSide !== ORDER_TYPES.SELL) {
            throw new Error(`Invalid preferredSide: ${preferredSide}. Must be '${ORDER_TYPES.BUY}' or '${ORDER_TYPES.SELL}'.`);
        }

        const ordersToPlace = [];
        const ordersToUpdate = [];
        const railType = preferredSide;
        const sideName = railType === ORDER_TYPES.BUY ? 'buy' : 'sell';

        // STRATEGY: Edge-Based Correction (Safe Bridging)
        // Instead of calculating a "mid-price" (which can be dangerous in wide gaps),
        // we strictly target the orders closest to the spread gap.
        // 1. Priority: Update existing PARTIAL orders at the edge (Highest Buy / Lowest Sell).
        // 2. Fallback: Activate SPREAD slots at the edge (Lowest Spread for Buy / Highest Spread for Sell).

        const allOrders = Array.from(manager.orders.values());
        let candidate = null;

        // 1. Look for PARTIAL orders on the preferred side
        const partials = allOrders.filter(o => o.type === railType && o.state === ORDER_STATES.PARTIAL);

        if (partials.length > 0) {
            // Sort to find the one closest to the gap
            // BUY: Highest price (descending)
            // SELL: Lowest price (ascending)
            partials.sort((a, b) => railType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);
            candidate = partials[0];
            manager.logger?.log?.(`[SPREAD-CORRECTION] Identified partial order at ${candidate.price} for update`, 'debug');
        }

        // 2. If no partials, look for SPREAD slots to activate
        if (!candidate) {
            const spreads = allOrders.filter(o => o.type === ORDER_TYPES.SPREAD && isSlotAvailable(o));

            if (spreads.length > 0) {
                // Sort to find the one closest to our existing wall
                // BUY: We want to extend UPWARDS, so pick the LOWEST price spread slot (closest to Buys)
                // SELL: We want to extend DOWNWARDS, so pick the HIGHEST price spread slot (closest to Sells)
                spreads.sort((a, b) => railType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);
                candidate = spreads[0];
                manager.logger?.log?.(`[SPREAD-CORRECTION] Identified spread slot at ${candidate.price} for activation`, 'debug');
            }
        }

        if (!candidate) {
            manager.logger?.log?.(`[SPREAD-CORRECTION] No suitable partials or spread slots found. Skipping.`, 'warn');
            return { ordersToPlace: [], ordersToUpdate: [] };
        }

        // Process the selected candidate
        const idealSize = Grid.calculateGeometricSizeForSpreadCorrection(manager, railType);
        const availableFund = (manager.funds?.available?.[sideName] || 0);

        if (idealSize) {
            // For partials, we only need to fund the difference, but the system treats "size" as the target total size.
            // The scaling logic below handles the "Total Target Size" vs "Available Funds" check.
            // Note: recalculateFunds will handle the delta logic for partials.

            // Scale down to available funds if necessary
            // For a new order (SPREAD), full size comes from funds.
            // For a PARTIAL, the "cost" is (idealSize - currentSize), but here we perform a simplified check
            // assuming we might need to fund the whole amount if it was very small.
            // More accurately: size = currentSize + min(idealSize - currentSize, available)
            
            let targetSize = idealSize;
            const currentSize = candidate.size || 0;

            if (candidate.state === ORDER_STATES.PARTIAL) {
                 const needed = Math.max(0, idealSize - currentSize);
                 const affordable = Math.min(needed, availableFund);
                 targetSize = currentSize + affordable;
            } else {
                 targetSize = Math.min(idealSize, availableFund);
            }

            if (isOrderHealthy(targetSize, railType, manager.assets, idealSize)) {
                // Use ACTIVE for partials (they are already on chain), VIRTUAL for new spreads
                const newState = candidate.state === ORDER_STATES.PARTIAL ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
                
                const activated = { ...candidate, type: railType, size: targetSize, state: newState };

                // Log if we are scaling down
                if (targetSize < idealSize) {
                    manager.logger?.log?.(`Scaling down spread correction order at ${candidate.id}: ideal ${Format.formatAmount8(idealSize)} -> target ${Format.formatAmount8(targetSize)} (ratio: ${Format.formatPercent2((targetSize/idealSize)*100)})`, 'info');
                }

                if (candidate.state === ORDER_STATES.PARTIAL && candidate.orderId) {
                    ordersToUpdate.push({
                        partialOrder: { ...candidate },
                        newSize: targetSize
                    });
                } else {
                    ordersToPlace.push(activated);
                }
            } else {
                const dustPercentage = (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE || 5);
                const minHealthy = getDoubleDustThreshold(idealSize);
                manager.logger?.log?.(
                    `Spread correction skipped at slot ${candidate.id}: ` +
                    `size=${Format.formatAmount8(targetSize)} < threshold=${Format.formatAmount8(minHealthy)} ` +
                    `(dust threshold: ${dustPercentage}% × 2 of ideal=${Format.formatAmount8(idealSize)}). ` +
                    `Available funds: ${Format.formatAmount8(availableFund)}`,
                    'debug'
                );
            }
        }

        return { ordersToPlace, ordersToUpdate };
    }


}

module.exports = Grid;
