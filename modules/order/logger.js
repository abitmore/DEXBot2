/**
 * modules/order/logger.js - Logger Engine
 *
 * Color-coded console logger for OrderManager with structured output.
 * Exports a single Logger class that manages all logging operations.
 *
 * Provides:
 * - Log levels: debug, info, warn, error with color coding
 * - Color coding for order types (buy=green, sell=red, spread=yellow, partial=blue)
 * - Color coding for order states (virtual=gray, active=green)
 * - Formatted order grid display (sample with sell/spread/buy sections)
 * - Fund status display with smart change detection
 * - Configuration-driven output (enable/disable categories)
 * - Comprehensive status summaries and grid diagnostics
 *
 * Configuration (LOGGING_CONFIG in constants.js):
 * - changeTracking: Smart detection of changes (only log what changed)
 * - display.colors.enabled: Force colors on/off (null = auto-detect TTY)
 * - display.fundStatus: Enable/disable fund status display
 * - display.statusSummary: Enable/disable comprehensive status summaries
 * - display.gridDiagnostics: Enable/disable detailed grid diagnostics
 *
 * Fund Structure Display:
 * - available: Free funds for new orders (chainFree - virtual - fees - reservations)
 * - cacheFunds: Fill proceeds and rotation surplus
 * - total.chain: chainFree + committed.chain (on-chain balance)
 * - total.grid: committed.grid + virtual (grid allocation)
 * - virtual: VIRTUAL order sizes (reserved for future placement)
 * - committed.grid: ACTIVE order sizes (internal tracking)
 * - committed.chain: ACTIVE orders with orderId (confirmed on-chain)
 *
 * ===============================================================================
 * TABLE OF CONTENTS - Logger Class (8 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor(level, configOverride) - Create new Logger instance with TTY color detection
 *
 * BASIC LOGGING (1 method)
 *   2. log(message, level) - Log message with timestamp, level color, and level filtering
 *
 * ORDER GRID DISPLAY (2 methods)
 *   3. logOrderGrid(orders, startPrice) - Display formatted order grid sample (sell/spread/buy)
 *   4. _logOrderRow(order) - Internal: Format and log single order row with colors
 *
 * FUND STATUS DISPLAY (2 methods)
 *   5. logFundsStatus(manager, context, forceDetailed) - Print fund status summary with change detection
 *      Supports one-liner mode and optional detailed breakdown on critical events
 *   6. _logDetailedFunds(manager, headerContext) - Internal: Log complete fund structure breakdown
 *      Shows available, chain balances, grid allocations, virtual, committed, cache, fees
 *
 * COMPREHENSIVE DIAGNOSTICS (2 methods)
 *   7. displayStatus(manager, forceOutput) - Print comprehensive status summary (market, funds, order counts, spread)
 *   8. logGridDiagnostics(manager, context, forceOutput) - Log detailed grid diagnostics (active/spread/partial/virtual)
 *      Separates by type and state, shows boundary markers for virtual orders
 *
 * ===============================================================================
 *
 * COLOR SCHEME:
 * - buy: Green (#32)    - BUY orders/side
 * - sell: Red (#31)     - SELL orders/side
 * - spread: Yellow (#33) - SPREAD orders
 * - debug: Cyan (#36)   - Debug output
 * - info: White (#37)   - Info messages
 * - warn: Yellow (#33)  - Warning messages
 * - error: Red (#31)    - Error messages
 * - active: Green (#32) - ACTIVE state
 * - partial: Blue (#34) - PARTIAL state
 * - virtual: Gray (#90) - VIRTUAL state
 *
 * ===============================================================================
 *
 * @class
 */

const Format = require('./format');
const LoggerState = require('./logger_state');
const { LOGGING_CONFIG, ORDER_STATES } = require('../constants');

class Logger {
    /**
     * Create a new Logger instance.
     * @param {string} level - Minimum log level to display ('debug', 'info', 'warn', 'error')
     * @param {Object} configOverride - Optional config override (uses LOGGING_CONFIG from constants if not provided)
     */
    constructor(level = 'info', configOverride = null) {
        this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
        this.level = level;

        // Load configuration (with override support)
        this.config = configOverride || LOGGING_CONFIG;

        // Initialize change tracking
        this.state = new LoggerState();

        // Only use colors if stdout is a TTY (terminal), not when piped to files
        // Can be overridden via config
        let useColors = process.stdout.isTTY;
        if (this.config.display.colors.enabled === false) {
            useColors = false;
        } else if (this.config.display.colors.enabled === true) {
            useColors = true;
        }
        // else: use auto-detection (current behavior)

        this.colors = useColors ? {
            reset: '\x1b[0m',
            buy: '\x1b[32m', sell: '\x1b[31m', spread: '\x1b[33m',
            debug: '\x1b[36m', info: '\x1b[37m', warn: '\x1b[33m', error: '\x1b[31m',
            virtual: '\x1b[90m', active: '\x1b[32m', partial: '\x1b[34m'
        } : {
            reset: '', buy: '', sell: '', spread: '',
            debug: '', info: '', warn: '', error: '',
            virtual: '', active: '', partial: ''
        };

        this.marketName = null;
    }

    _getSidePrecision(manager, side) {
        return side === 'buy'
            ? manager?.assets?.assetB?.precision
            : manager?.assets?.assetA?.precision;
    }

    _formatAmountStrict(value, precision) {
        if (!Number.isFinite(Number(value)) || !Number.isFinite(precision)) return 'N/A';
        return Format.formatAmountByPrecision(value, precision);
    }

    /**
     * Log a message with timestamp and level.
     * @param {string} message - The message to log.
     * @param {string} [level='info'] - The log level ('debug', 'info', 'warn', 'error').
     */
    log(message, level = 'info') {
        if (this.levels[level] >= this.levels[this.level]) {
            const color = this.colors[level] || '';
            console.log(`${color}[${level.toUpperCase()}] ${message}${this.colors.reset}`);
        }
    }

    /**
     * Log a sample of the order grid.
     * @param {Array<Object>} orders - The list of orders.
     * @param {number} startPrice - The market start price.
     */
    logOrderGrid(orders, startPrice) {
        console.log('\n===== ORDER GRID (SAMPLE) =====');
        if (this.marketName) console.log(`Market: ${this.marketName} @ ${startPrice}`);
        console.log('Price       Slot      Type      State       Size');
        console.log('----------------------------------------------------');

        const sorted = [...orders].sort((a, b) => b.price - a.price);

        // Separate by type
        const allSells = sorted.filter(o => o.type === 'sell');
        const allSpreads = sorted.filter(o => o.type === 'spread');
        const allBuys = sorted.filter(o => o.type === 'buy');

        // SELL: top 3 (highest prices, edge) + last 3 (lowest prices, next to spread)
        const sellEdge = allSells.slice(0, 3);
        const sellNearSpread = allSells.slice(-3);
        sellEdge.forEach(order => this._logOrderRow(order));
        console.log('');
        console.log('');
        sellNearSpread.forEach(order => this._logOrderRow(order));

        // SPREAD: high, middle, low with gap indicators
        if (allSpreads.length > 0) {
            const highIdx = 0;
            const midIdx = Math.floor(allSpreads.length / 2);
            const lowIdx = allSpreads.length - 1;

            const high = allSpreads[highIdx];
            const mid = (allSpreads.length > 2) ? allSpreads[midIdx] : null;
            const low = allSpreads[lowIdx];

            this._logOrderRow(high);

            if (mid) {
                if (midIdx > highIdx + 1) console.log(''); // Gap between high and mid
                this._logOrderRow(mid);
                if (lowIdx > midIdx + 1) console.log('');  // Gap between mid and low
            } else if (lowIdx > highIdx + 1) {
                console.log(''); // Gap between high and low (when only 2 total)
            }

            if (low.id !== high.id) {
                this._logOrderRow(low);
            }
        }

        // BUY: top 3 (highest prices, next to spread) + last 3 (lowest prices, edge)
        const buyNearSpread = allBuys.slice(0, 3);
        const buyEdge = allBuys.slice(-3);
        buyNearSpread.forEach(order => this._logOrderRow(order));
        console.log('');
        console.log('');
        buyEdge.forEach(order => this._logOrderRow(order));

        console.log('===============================================\n');
    }

    /**
     * Log a single order row.
     * @param {Object} order - The order to log.
     * @private
     */
    _logOrderRow(order) {
        const typeColor = this.colors[order.type] || '';
        const stateColor = this.colors[order.state] || '';
         const price = Format.formatPrice4(order.price).padEnd(12);
         const id = (order.id || '').padEnd(10);
         const type = order.type.padEnd(10);
         const state = order.state.padEnd(12);
         const size = Format.formatAmount8(order.size);
        console.log(
            `${price}${id}${typeColor}${type}${this.colors.reset}${stateColor}${state}${this.colors.reset}${size}`
        );
    }

    /**
     * Print a summary of fund status for diagnostics with optional context.
     *
     * BEHAVIOR:
     * - Respects config setting: display.fundStatus.enabled
     * - Uses change detection: only logs if funds changed
     * - In debug + critical events: Can show detailed breakdown (if config enabled)
     *
     * Critical events (trigger detailed output):
     * - 'order_filled', 'order_created', 'anomaly', 'violation'
     * - Explicit detailed flag
     *
     * @param {OrderManager} manager - OrderManager instance to read funds from
     * @param {string} context - Optional context string (e.g., "AFTER fill", "BEFORE rotation")
     * @param {boolean} forceDetailed - Force detailed output even for non-critical events
     */
    logFundsStatus(manager, context = '', forceDetailed = false) {
        if (!manager) return;

        // Check if fund logging is enabled in config
        if (!this.config.display.fundStatus.enabled && !forceDetailed) return;

        const isDebugMode = this.level === 'debug';
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        const headerContext = context ? ` [${context}]` : '';

        // Extract fund state for change detection
        const fundState = {
            availableBuy: manager.funds?.available?.buy,
            availableSell: manager.funds?.available?.sell,
            cacheFundsBuy: manager.funds?.cacheFunds?.buy,
            cacheFundsSell: manager.funds?.cacheFunds?.sell,
            btsFeesOwed: manager.funds?.btsFeesOwed
        };

        // Check if this is a critical event requiring detailed output
        const isCriticalEvent = forceDetailed ||
            context.includes('fill') ||
            context.includes('order_created') ||
            context.includes('order_cancelled') ||
            context.includes('anomaly') ||
            context.includes('violation') ||
            context.includes('ERROR');

        // Use change detection: only log if funds changed
        if (this.config.changeTracking.enabled) {
            const { isNew, changes } = this.state.detectChanges('funds', fundState);

            // Skip if not critical and no changes
            if (!isNew && !Object.keys(changes).length && !isCriticalEvent) {
                return;
            }
        }

        const buyPrecision = this._getSidePrecision(manager, 'buy');
        const sellPrecision = this._getSidePrecision(manager, 'sell');
        const availableBuy = this._formatAmountStrict(manager.funds?.available?.buy, buyPrecision);
        const availableSell = this._formatAmountStrict(manager.funds?.available?.sell, sellPrecision);

        const c = this.colors;
        const buy = c.buy;
        const sell = c.sell;
        const reset = c.reset;

        // Show simple one-liner (if enabled or forced)
        this.log(`Funds${headerContext}: ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`, 'info');

        // Only show detailed breakdown in debug mode on critical events
        if (isDebugMode && isCriticalEvent && this.config.display.fundStatus.showDetailed) {
            this._logDetailedFunds(manager, headerContext);
        }
    }

    /**
     * Log detailed fund breakdown (called only on critical events in debug mode).
     * Shows complete fund structure:
     * - available: Free funds for new orders
     * - total.chain: Total on-chain balance
     * - total.grid: Total grid allocation
     * - virtual: VIRTUAL order sizes (reserved)
     * - committed.grid: ACTIVE order sizes
     * - committed.chain: ACTIVE orders on blockchain
     * - cacheFunds: Fill proceeds and rotation surplus
     * - btsFeesOwed: Pending BTS transaction fees
     *
     * @private
     */
    _logDetailedFunds(manager, headerContext = '') {
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        const buyPrecision = this._getSidePrecision(manager, 'buy');
        const sellPrecision = this._getSidePrecision(manager, 'sell');
        const c = this.colors;
        const debug = c.debug;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        const availableBuy = this._formatAmountStrict(manager.funds?.available?.buy, buyPrecision);
        const availableSell = this._formatAmountStrict(manager.funds?.available?.sell, sellPrecision);

        // Chain balances
        const chainFreeBuy = manager.accountTotals?.buyFree ?? 0;
        const chainFreeSell = manager.accountTotals?.sellFree ?? 0;
        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;

        // Grid allocations
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;

        // Cache & Committed
        const cacheBuy = manager.funds?.cacheFunds?.buy ?? 0;
        const cacheSell = manager.funds?.cacheFunds?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;
        const btsFeesOwed = manager.funds?.btsFeesOwed ?? 0;

        console.log(`\n${debug}=== DETAILED FUNDS STATUS${headerContext} ===${reset}`);

        console.log(`${debug}AVAILABLE:${reset}`);
        console.log(`  ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`);

        console.log(`\n${debug}CHAIN BALANCES:${reset}`);
        console.log(`  chainFree: ${buy}Buy ${this._formatAmountStrict(chainFreeBuy, buyPrecision)}${reset} | ${sell}Sell ${this._formatAmountStrict(chainFreeSell, sellPrecision)}${reset}`);
        console.log(`  total.chain: ${buy}Buy ${this._formatAmountStrict(totalChainBuy, buyPrecision)}${reset} | ${sell}Sell ${this._formatAmountStrict(totalChainSell, sellPrecision)}${reset}`);

        console.log(`\n${debug}GRID ALLOCATIONS:${reset}`);
        console.log(`  total.grid: ${buy}Buy ${this._formatAmountStrict(totalGridBuy, buyPrecision)}${reset} | ${sell}Sell ${this._formatAmountStrict(totalGridSell, sellPrecision)}${reset}`);
        console.log(`  committed.grid: ${buy}Buy ${this._formatAmountStrict(committedGridBuy, buyPrecision)}${reset} | ${sell}Sell ${this._formatAmountStrict(committedGridSell, sellPrecision)}${reset}`);
        console.log(`  virtual (reserved): ${buy}Buy ${this._formatAmountStrict(virtualBuy, buyPrecision)}${reset} | ${sell}Sell ${this._formatAmountStrict(virtualSell, sellPrecision)}${reset}`);

        console.log(`\n${debug}COMMITTED ON-CHAIN:${reset}`);
        console.log(`  ${buy}Buy ${this._formatAmountStrict(committedChainBuy, buyPrecision)}${reset} | ${sell}Sell ${this._formatAmountStrict(committedChainSell, sellPrecision)}${reset}`);

        console.log(`\n${debug}DEDUCTIONS & PENDING:${reset}`);
        console.log(`  cacheFunds: ${buy}Buy ${this._formatAmountStrict(cacheBuy, buyPrecision)}${reset} | ${sell}Sell ${this._formatAmountStrict(cacheSell, sellPrecision)}${reset}`);
        console.log(`  btsFeesOwed: ${Format.formatAmount8(btsFeesOwed)} BTS${reset}\n`);
    }

    /**
     * Print a comprehensive status summary using manager state.
     * Respects config: display.statusSummary.enabled
     *
     * @param {OrderManager} manager - The manager instance.
     * @param {boolean} forceOutput - Force output even if disabled in config
     */
    displayStatus(manager, forceOutput = false) {
        if (!manager) return;

        // Check if status summary is enabled (unless forced)
        if (!this.config.display.statusSummary.enabled && !forceOutput) return;
        const market = manager.marketName || manager.config?.market || 'unknown';
        const activeOrders = manager.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
        const partialOrders = manager.getOrdersByTypeAndState(null, ORDER_STATES.PARTIAL);
        const virtualOrders = manager.getOrdersByTypeAndState(null, ORDER_STATES.VIRTUAL);
        console.log('\n===== STATUS =====');
        console.log(`Market: ${market}`);
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        const buyPrecision = this._getSidePrecision(manager, 'buy');
        const sellPrecision = this._getSidePrecision(manager, 'sell');

        const gridBuy = this._formatAmountStrict(manager.funds?.available?.buy, buyPrecision);
        const gridSell = this._formatAmountStrict(manager.funds?.available?.sell, sellPrecision);
        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;
        const cacheBuy = manager.funds?.cacheFunds?.buy ?? 0;
        const cacheSell = manager.funds?.cacheFunds?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;

        const c = this.colors;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        console.log(`funds.available: ${buy}Buy ${gridBuy}${reset} ${buyName} | ${sell}Sell ${gridSell}${reset} ${sellName}`);
        console.log(`total.chain: ${buy}Buy ${this._formatAmountStrict(totalChainBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${this._formatAmountStrict(totalChainSell, sellPrecision)}${reset} ${sellName}`);
        console.log(`total.grid: ${buy}Buy ${this._formatAmountStrict(totalGridBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${this._formatAmountStrict(totalGridSell, sellPrecision)}${reset} ${sellName}`);
        console.log(`virtual.grid: ${buy}Buy ${this._formatAmountStrict(virtualBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${this._formatAmountStrict(virtualSell, sellPrecision)}${reset} ${sellName}`);
        console.log(`cacheFunds: ${buy}Buy ${this._formatAmountStrict(cacheBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${this._formatAmountStrict(cacheSell, sellPrecision)}${reset} ${sellName}`);
        console.log(`committed.grid: ${buy}Buy ${this._formatAmountStrict(committedGridBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${this._formatAmountStrict(committedGridSell, sellPrecision)}${reset} ${sellName}`);
        console.log(`committed.chain: ${buy}Buy ${this._formatAmountStrict(committedChainBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${this._formatAmountStrict(committedChainSell, sellPrecision)}${reset} ${sellName}`);
        console.log(`Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Partial ${partialOrders.length}`);
        console.log(`Spreads: ${manager.currentSpreadCount}/${manager.targetSpreadCount}`);
        const spread = typeof manager.calculateCurrentSpread === 'function' ? manager.calculateCurrentSpread() : 0;
        console.log(`Current Spread: ${Format.formatPercent2(spread)}%`);
        console.log(`Spread Condition: ${manager.outOfSpread > 0 ? 'TOO WIDE (' + manager.outOfSpread + ')' : 'Normal'}`);
    }

    /**
     * Log detailed grid diagnostic: ACTIVE, SPREAD, PARTIAL orders and first VIRTUAL on boundary
     * Used to trace grid mutations during fill/rotation/spread-correction cycles
     *
     * Respects config: display.gridDiagnostics.enabled
     * Can be called explicitly even if disabled (for on-demand diagnostics)
     */
    logGridDiagnostics(manager, context = '', forceOutput = false) {
        if (!manager) return;

        // Check if grid diagnostics is enabled (unless forced)
        if (!this.config.display.gridDiagnostics.enabled && !forceOutput) return;

        const { ORDER_TYPES, ORDER_STATES } = require('../constants');
        const c = this.colors;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;
        const active = c.active;
        const spread = c.spread;
        const partial = c.partial;
        const virtual = c.virtual;

        // Get all orders sorted by price (descending)
        const allOrders = Array.from(manager.orders.values()).sort((a, b) => b.price - a.price);

        // Separate by type and state
        const activeOrders = allOrders.filter(o => o.state === ORDER_STATES.ACTIVE);
        const activeBuys = activeOrders.filter(o => o.type === ORDER_TYPES.BUY);
        const activeSells = activeOrders.filter(o => o.type === ORDER_TYPES.SELL);

        const spreadOrders = allOrders.filter(o => o.type === ORDER_TYPES.SPREAD && o.state === ORDER_STATES.VIRTUAL);
        const partialOrders = allOrders.filter(o => o.state === ORDER_STATES.PARTIAL);

        // Find first VIRTUAL order on each boundary
        const virtualOrders = allOrders.filter(o => o.state === ORDER_STATES.VIRTUAL && o.type !== ORDER_TYPES.SPREAD);
        const firstVirtualSell = virtualOrders.find(o => o.type === ORDER_TYPES.SELL);
        const firstVirtualBuy = virtualOrders.find(o => o.type === ORDER_TYPES.BUY);

        const ctxStr = context ? ` [${context}]` : '';
        console.log(`\n${spread}=== GRID DIAGNOSTICS${ctxStr} ===${reset}`);

        // Active orders summary
        console.log(`\n${active}ACTIVE ORDERS${reset}: ${buy}Buy=${activeBuys.length}${reset}, ${sell}Sell=${activeSells.length}${reset}`);
        if (activeBuys.length > 0) {
             console.log(`  ${buy}BUY:${reset}  ${activeBuys.map(o => `${o.id}@${Format.formatPrice4(o.price)}`).join(', ')}`);
        }
        if (activeSells.length > 0) {
             console.log(`  ${sell}SELL:${reset} ${activeSells.map(o => `${o.id}@${Format.formatPrice4(o.price)}`).join(', ')}`);
        }

        // SPREAD orders
        console.log(`\n${spread}SPREAD PLACEHOLDERS${reset}: ${spreadOrders.length}`);
        if (spreadOrders.length > 0) {
            for (const order of spreadOrders) {
                const isBoundary = (order === firstVirtualBuy || order === firstVirtualSell);
                const boundaryMarker = isBoundary ? ' ← BOUNDARY' : '';
                 console.log(`  ${spread}${order.id}@${Format.formatPrice4(order.price)}${boundaryMarker}${reset}`);
            }
        }

        // PARTIAL orders
        console.log(`\n${partial}PARTIAL ORDERS${reset}: ${partialOrders.length}`);
        if (partialOrders.length > 0) {
            for (const order of partialOrders) {
                console.log(`  ${partial}${order.id}@${Format.formatPrice4(order.price)} size=${Format.formatSizeByOrderType(order.size, order.type, manager.assets)}${reset}`);
            }
        }

        // First VIRTUAL on boundary
        console.log(`\n${virtual}FIRST VIRTUAL ON BOUNDARY${reset}:`);
        if (firstVirtualSell) {
             console.log(`  ${virtual}SELL: ${firstVirtualSell.id}@${Format.formatPrice4(firstVirtualSell.price)}${reset}`);
        } else {
            console.log(`  ${virtual}SELL: (none)${reset}`);
        }
        if (firstVirtualBuy) {
             console.log(`  ${virtual}BUY:  ${firstVirtualBuy.id}@${Format.formatPrice4(firstVirtualBuy.price)}${reset}`);
        } else {
            console.log(`  ${virtual}BUY:  (none)${reset}`);
        }
    }

}

module.exports = Logger;
