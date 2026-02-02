/**
 * modules/constants.js - Configuration and Constants
 *
 * Global configuration, constants, and defaults for DEXBot2.
 * All constants are frozen to prevent accidental runtime modifications.
 * Local overrides can be loaded from ~/.claude/dexbot_settings.json
 *
 * ===============================================================================
 * EXPORTED CONSTANTS (13 configuration objects)
 * ===============================================================================
 *
 * ENUM DEFINITIONS:
 *   1. ORDER_TYPES - Grid entry categories
 *      { SELL: 'sell', BUY: 'buy', SPREAD: 'spread' }
 *      - SELL: Orders above market price, size in base asset (assetA)
 *      - BUY: Orders below market price, size in quote asset (assetB)
 *      - SPREAD: Placeholder orders in spread zone around market price
 *
 *   2. ORDER_STATES - Order lifecycle states (affects fund tracking)
 *      { VIRTUAL: 'virtual', ACTIVE: 'active', PARTIAL: 'partial' }
 *      - VIRTUAL: Not yet on-chain, size in funds.virtual (reserved)
 *                 Also used for filled orders converted to SPREAD placeholders
 *      - ACTIVE: Placed on-chain, size in funds.committed
 *      - PARTIAL: Partially filled on-chain, mixed state
 *
 * DEFAULT CONFIGURATION (applied when not explicitly set):
 *   3. DEFAULT_CONFIG - Bot configuration defaults
 *      Price: startPrice, minPrice, maxPrice, incrementPercent, targetSpreadPercent
 *      Control: active, dryRun
 *      Trading pair: assetA, assetB
 *      Allocation: weightDistribution, botFunds, activeOrders
 *
 * TIMING PARAMETERS:
 *   4. TIMING - Operational timing constants
 *      SYNC_DELAY_MS, ACCOUNT_TOTALS_TIMEOUT_MS
 *      BLOCKCHAIN_FETCH_INTERVAL_MIN, FILL_DEDUPE_WINDOW_MS
 *      FILL_CLEANUP_INTERVAL_MS, FILL_RECORD_RETENTION_MS
 *      LOCK_TIMEOUT_MS
 *
 * GRID & ORDER LIMITS:
 *   5. GRID_LIMITS - Grid sizing and scaling constraints
 *      MIN_SPREAD_FACTOR, MIN_SPREAD_ORDERS, MIN_ORDER_COUNT
 *      MAX_GRID_PRICES, MAX_ORDER_IDS_PER_BATCH, MAX_ROTATION_SIZE
 *      FUND_INVARIANT_PERCENT_TOLERANCE
 *      Includes GRID_COMPARISON sub-object for grid divergence metrics
 *
 *   6. INCREMENT_BOUNDS - Price increment percentage validation
 *      MIN_INCREMENT_PERCENT, MAX_INCREMENT_PERCENT
 *
 * FEE CONFIGURATION:
 *   7. FEE_PARAMETERS - Fee calculation and reservation parameters
 *      BTS_RESERVATION_MULTIPLIER, MARKET_FEE_PERCENT, TAKER_FEE_PERCENT
 *      TAKER_PERCENT_OVERRIDE, BTS_TAKER_OVERRIDE
 *
 * API & BLOCKCHAIN:
 *   8. API_LIMITS - Blockchain API call constraints
 *      MAX_ORDERS_PER_CALL, API_TIMEOUT_MS, API_RETRY_DELAY_MS
 *      MAX_API_RETRIES, HISTORICAL_SYNC_BATCH_SIZE
 *
 * FILL PROCESSING:
 *   9. FILL_PROCESSING - Fill event handling configuration
 *      FILL_ACK_WAIT_MS, FILL_TIMEOUT_MS, FILL_RETRY_ATTEMPTS
 *      Includes BATCH_LIMITS sub-object
 *
 * MAINTENANCE & MONITORING:
 *   10. MAINTENANCE - Background maintenance task configuration
 *       HEALTH_CHECK_INTERVAL_MS, PERSISTENCE_CHECK_INTERVAL_MS
 *       LOCK_CLEANUP_INTERVAL_MS, FILL_CLEANUP_INTERVAL_MS
 *
 *   11. UPDATER - Version checking and update notification
 *       CHECK_INTERVAL_MS, REPO_URL, NOTIFICATION_MIN_LEVEL
 *
 * LOGGING CONFIGURATION:
 *   12. LOGGING_CONFIG - Structured logging configuration
 *       changeTracking: Smart change detection
 *       display.colors: TTY color support
 *       display.fundStatus, display.statusSummary, display.gridDiagnostics
 *       Categories for enabling/disabling log types
 *
 *   13. LOG_LEVEL - Current logging verbosity level
 *       Affects which messages are displayed: 'debug', 'info', 'warn', 'error'
 *
 * ===============================================================================
 *
 * LOCAL SETTINGS OVERRIDE:
 * Read from ~/.claude/dexbot_settings.json if it exists.
 * Supports overriding any exported constant with custom values.
 * Useful for development, testing, and performance tuning.
 *
 * FREEZING:
 * All exported objects are frozen at module load to prevent accidental runtime modifications.
 * This ensures constants remain truly constant throughout bot lifetime.
 *
 * ===============================================================================
 */

const fs = require('fs');
const path = require('path');

// Order categories used by the OrderManager when classifying grid entries.
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

// Life-cycle states assigned to generated or active orders.
// State transitions affect fund calculations in manager.recalculateFunds()
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',   // Not on-chain, size in funds.virtual; also used for fully filled orders converted to SPREAD
    ACTIVE: 'active',     // On-chain, size in funds.committed.grid (and .chain if has orderId)
    PARTIAL: 'partial'    // On-chain, partially filled order, size in funds.committed.grid (and .chain if has orderId)
});

// Defaults applied when instantiating an OrderManager with minimal configuration.
// These values are used when a parameter is not explicitly provided in the bot config.
let DEFAULT_CONFIG = {
    // Price configuration
    startPrice: "pool",          // Market price source: "pool" (liquidity pool), "orderbook", or numeric value
    minPrice: "3x",               // Lower price bound: "Nx" = N times below startPrice, or numeric value
    maxPrice: "3x",               // Upper price bound: "Nx" = N times above startPrice, or numeric value
    incrementPercent: 0.5,        // Price step between grid levels (0.5 = 0.5% geometric spacing)
    targetSpreadPercent: 2,       // Target spread width between best buy and best sell (2 = 2%)

    // Bot control
    active: true,                 // Whether bot should actively place/manage orders
    dryRun: false,                // If true, simulate operations without blockchain transactions

    // Trading pair
    assetA: null,                 // Base asset symbol (e.g., "BTS")
    assetB: null,                 // Quote asset symbol (e.g., "USD")

    // Fund allocation
    weightDistribution: { sell: 0.5, buy: 0.5 },  // Geometric weight for order sizing (0.5 = linear, >0.5 = more weight to market-close orders)
    botFunds: { sell: "100%", buy: "100%" },      // Percentage of wallet balance to allocate ("100%" or numeric value)
    activeOrders: { sell: 20, buy: 20 },          // Number of orders to maintain closest to market on each side
};

// Timing constants used by OrderManager and helpers
let TIMING = {
    SYNC_DELAY_MS: 500,
    ACCOUNT_TOTALS_TIMEOUT_MS: 10000,
    // Blockchain fetch interval: how often to refresh blockchain account values (in minutes)
    // Default: 240 minutes (4 hours). Set to 0 or non-number to disable periodic fetches.
    BLOCKCHAIN_FETCH_INTERVAL_MIN: 240,

    // Fill processing timing
    FILL_DEDUPE_WINDOW_MS: 5000,    // 5 seconds - window for deduplicating same fill events
    FILL_CLEANUP_INTERVAL_MS: 10000, // 10 seconds - clean old fill records (2x dedup window)
    FILL_RECORD_RETENTION_MS: 3600000, // 1 hour - how long to keep persisted fill records

    // Order locking timing
    // Reduced from 30s to 10s to prevent lock-based starvation under high fill rates.
    // Locks that exceed this timeout are auto-expired by _cleanExpiredLocks() to ensure
    // orders are never permanently blocked if a process crashes while holding the lock.
    // This self-healing mechanism prevents deadlocks while still protecting against races.
    LOCK_TIMEOUT_MS: 10000  // 10 seconds - balances transaction latency with lock starvation prevention
};

// Grid limits and scaling constants
let GRID_LIMITS = {
    // Minimum spread factor: Ensures spread is at least (incrementPercent × MIN_SPREAD_FACTOR)
    // Prevents spread from being too narrow relative to grid spacing
    // Default: 2.1 (ensures 3-gap minimum stays below Target + Increment limit)
    MIN_SPREAD_FACTOR: 2.1,

    // Minimum order size safety factor: Multiplied by blockchain minimum to ensure orders are well above limits
    // Prevents orders from being rejected due to rounding or fee deductions
    // Default: 50 (orders must be 50× the blockchain minimum)
    MIN_ORDER_SIZE_FACTOR: 50,

    // Grid regeneration threshold (percentage)
    // When (cacheFunds / total.grid) * 100 >= this percentage on one side, trigger Grid.updateGridOrderSizes() for that side
    // Checked independently for buy and sell sides
    // Default: 3% (was 2%) — more conservative by default to reduce unnecessary churn
    // Example: If cacheFunds.buy = 100 and total.grid.buy = 1000, ratio = 10%
    // If threshold = 5%, then 10% >= 5% triggers update for buy side only
    GRID_REGENERATION_PERCENTAGE: 3,

    // Threshold for considering a partial order as "dust" relative to ideal size
    // If (partial.size / idealSize) * 100 < PARTIAL_DUST_THRESHOLD_PERCENTAGE, it may trigger rebalancing
    // Default: 5 (5% - partials below 5% of ideal size are considered dust)
    PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5,

    // Tolerance for fund invariant checks (percentage)
    // Discrepancies below this threshold will not trigger a warning
    // Accounts for rounding errors and blockchain precision limits
    // Default: 0.1 (0.1%)
    FUND_INVARIANT_PERCENT_TOLERANCE: 0.1,

    // Minimum number of spread slots to maintain proper spread zone
    // Ensures at least this many empty slots between best buy and best sell
    // Default: 2 (minimum 2 slots in spread zone)
    MIN_SPREAD_ORDERS: 2,

    // Grid comparison metrics
    // Detects significant divergence between calculated (in-memory) and persisted grid state
    // after order fills and rotations
    GRID_COMPARISON: {
        // Metric calculation: RMS (Root Mean Square) of relative order size differences
        // Formula: RMS = √(mean of ((calculated - persisted) / persisted)²)
        // Represents the quadratic mean of relative size errors
        SUMMED_RELATIVE_SQUARED_DIFFERENCE: 'summedRelativeSquaredDiff',

        // Divergence threshold for automatic grid regeneration (RMS as percentage)
        // When compareGrids() metric exceeds this threshold, updateGridOrderSizes will be triggered
        //
        // RMS Threshold Reference Table (for 5% distribution: 5% outliers, 95% perfect):
        // ┌────────────────────────────────────────────────────────┐
        // │ RMS %       │ Avg Error │ Description                 │
        // ├────────────────────────────────────────────────────────┤
        // │ 4.5%        │ ~1.0%     │ Very strict                 │
        // │ 9.8%        │ ~2.2%     │ Strict                      │
        // │ 14.3%       │ ~3.2%     │ Default (balanced)          │
        // │ 20.1%       │ ~4.5%     │ Lenient                     │
        // │ 31.7%       │ ~7.1%     │ Very lenient                │
        // │ 44.7%       │ ~10%      │ Extremely lenient           │
        // └────────────────────────────────────────────────────────┘
        RMS_PERCENTAGE: 14.3
    }
};

// Increment percentage bounds for grid configuration
let INCREMENT_BOUNDS = {
    // Minimum increment percentage allowed (0.01%)
    MIN_PERCENT: 0.01,
    // Maximum increment percentage allowed (10%)
    MAX_PERCENT: 10,
    // Minimum increment as decimal factor (0.01% = 0.0001)
    MIN_FACTOR: 0.0001,
    // Maximum increment as decimal factor (10% = 0.10)
    MAX_FACTOR: 0.10
};

// Fee-related parameters for order operations
let FEE_PARAMETERS = {
    // Multiplier for BTS fee reservation (multiplied by totalTargetOrders)
    BTS_RESERVATION_MULTIPLIER: 5,
    // Fallback BTS fee when fee data calculation fails
    BTS_FALLBACK_FEE: 100,
    // Ratio of creation fee refunded for maker orders (10% = 0.1)
    MAKER_REFUND_RATIO: 0.1
};

// API request limits and batch sizes for blockchain operations
let API_LIMITS = {
    // Maximum number of liquidity pools per batch request
    POOL_BATCH_SIZE: 100,
    // Maximum number of batch iterations for pool scanning (~10k total pools)
    MAX_POOL_SCAN_BATCHES: 100,
    // Depth of order book to fetch for market price derivation
    ORDERBOOK_DEPTH: 5,
    // Maximum number of limit orders per batch request
    LIMIT_ORDERS_BATCH: 100
};

// Fill processing configuration
let FILL_PROCESSING = {
    // Mode for fill processing: 'history' reads from historical fills
    MODE: 'history',
    // Operation type for fill_order blockchain operations
    OPERATION_TYPE: 4,
    // Indicator for taker (non-maker) fills
    TAKER_INDICATOR: 0
};

// Cleanup and maintenance parameters
let MAINTENANCE = {
    // Probability of running cleanup operation on any cycle (0.1 = 10%)
    CLEANUP_PROBABILITY: 0.1
};

// Logging Level Configuration
// Options:
// - 'debug': Verbose output including calculation details, API calls, and flow tracing.
// - 'info':  Standard production output. State changes (Active/Filled), keys confirmations, and errors.
// - 'warn':  Warnings (non-critical issues) and errors only.
// - 'error': Critical errors only.
let LOG_LEVEL = 'info';

// Fine-grained Logging Configuration
// Controls what gets logged at each level and which categories are enabled
// Can be overridden in profiles/general.settings.json via LOGGING_CONFIG
let LOGGING_CONFIG = {
    changeTracking: {
        enabled: true,
        ignoreMinor: {
            fundPrecision: 8,      // Ignore fund changes smaller than 0.00000001
            pricePrecision: 4      // Ignore price changes smaller than 0.0001
        }
    },
    categories: {
        fundChanges: {
            enabled: true,
            level: "debug",
            options: {
                onlyChanges: true,
                aggregateSmall: true,
                hideComponentBreakdown: true
            }
        },
        orderStateChanges: {
            enabled: true,
            level: "info",
            options: {
                onlyChanges: true,
                compactFormat: true
            }
        },
        fillEvents: {
            enabled: true,
            level: "info",
            options: {
                onlyChanges: true,
                aggregateFees: true
            }
        },
        boundaryEvents: {
            enabled: true,
            level: "info",
            options: {
                onlyChanges: true
            }
        },
        errorWarnings: {
            enabled: true,
            level: "warn",
            options: {
                alwaysLog: true
            }
        },
        edgeCases: {
            enabled: true,
            level: "warn",
            options: {
                alwaysLog: true
            }
        }
    },
    display: {
        gridDiagnostics: {
            enabled: false,
            showOnDemandOnly: true
        },
        fundStatus: {
            enabled: false,
            showDetailed: false,
            compactFormat: true
        },
        statusSummary: {
            enabled: false
        },
        colors: {
            enabled: "auto"
        }
    }
};

// Updater Configuration
let UPDATER = {
    // Whether the automated updater is enabled
    ACTIVE: true,
    // Hardcoded repository URL
    REPOSITORY_URL: "https://github.com/froooze/DEXBot2.git",
    // Default branch policy: 'auto' (track current), 'main', 'dev', 'test'
    BRANCH: "auto",
    // Automated update schedule using Cron format:
    // ┌────────────── minute (0 - 59)
    // │ ┌──────────── hour (0 - 23)
    // │ │ ┌────────── day of month (1 - 31)
    // │ │ │ ┌──────── month (1 - 12)
    // │ │ │ │ ┌────── day of week (0 - 6) (0 is Sunday)
    // │ │ │ │ │
    // 0 0 * * *  (Default: Daily at midnight)
    SCHEDULE: "0 0 * * *"
};

// --- LOCAL SETTINGS OVERRIDES ---
// Load user-defined settings from profiles/general.settings.json if it exists.
// This allows preserving settings during updates without git stashing.
const SETTINGS_FILE = path.join(__dirname, '..', 'profiles', 'general.settings.json');

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(raw);

        if (settings.LOG_LEVEL) LOG_LEVEL = settings.LOG_LEVEL;

        if (settings.TIMING) {
            // Filter out comment fields (keys starting with _) before merging
            const timingSettings = Object.fromEntries(
                Object.entries(settings.TIMING).filter(([key]) => !key.startsWith('_'))
            );
            TIMING = { ...TIMING, ...timingSettings };
        }

        if (settings.GRID_LIMITS) {
            const gridSettings = settings.GRID_LIMITS;
            // Filter out comment fields before merging
            const cleanGridSettings = Object.fromEntries(
                Object.entries(gridSettings).filter(([key]) => !key.startsWith('_'))
            );
            GRID_LIMITS = {
                ...GRID_LIMITS,
                ...cleanGridSettings,
                GRID_COMPARISON: { ...GRID_LIMITS.GRID_COMPARISON, ...(cleanGridSettings.GRID_COMPARISON || {}) }
            };
        }

        // Load expert settings (for advanced troubleshooting)
        if (settings.EXPERT) {
            if (settings.EXPERT.GRID_LIMITS) {
                const expertGridSettings = Object.fromEntries(
                    Object.entries(settings.EXPERT.GRID_LIMITS).filter(([key]) => !key.startsWith('_'))
                );
                GRID_LIMITS = { ...GRID_LIMITS, ...expertGridSettings };
            }
            if (settings.EXPERT.TIMING) {
                const expertTimingSettings = Object.fromEntries(
                    Object.entries(settings.EXPERT.TIMING).filter(([key]) => !key.startsWith('_'))
                );
                TIMING = { ...TIMING, ...expertTimingSettings };
            }
        }

        if (settings.DEFAULT_CONFIG) {
            DEFAULT_CONFIG = { ...DEFAULT_CONFIG, ...settings.DEFAULT_CONFIG };
        }

        if (settings.UPDATER) {
            UPDATER = { ...UPDATER, ...settings.UPDATER };
        }

        if (settings.LOGGING_CONFIG) {
            // Deep merge logging config to preserve defaults not specified in settings
            const mergeConfig = (target, source) => {
                for (const key in source) {
                    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                        target[key] = { ...target[key], ...source[key] };
                        mergeConfig(target[key], source[key]);
                    } else {
                        target[key] = source[key];
                    }
                }
                return target;
            };
            LOGGING_CONFIG = mergeConfig({ ...LOGGING_CONFIG }, settings.LOGGING_CONFIG);
        }
    } catch (err) {
        console.warn(`[WARN] Failed to load local settings from ${SETTINGS_FILE}: ${err.message}`);
    }
}

// Freeze objects to prevent accidental runtime modifications
Object.freeze(ORDER_TYPES);
Object.freeze(ORDER_STATES);
Object.freeze(TIMING);
Object.freeze(GRID_LIMITS);
Object.freeze(GRID_LIMITS.GRID_COMPARISON);
Object.freeze(INCREMENT_BOUNDS);
Object.freeze(FEE_PARAMETERS);
Object.freeze(API_LIMITS);
Object.freeze(FILL_PROCESSING);
Object.freeze(MAINTENANCE);
Object.freeze(UPDATER);
Object.freeze(LOGGING_CONFIG);

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL, LOGGING_CONFIG, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, FILL_PROCESSING, MAINTENANCE, UPDATER };
