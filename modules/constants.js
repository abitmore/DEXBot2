/**
 * modules/constants.js - Configuration and Constants
 *
 * Global configuration, constants, and defaults for DEXBot2.
 * All constants are frozen to prevent accidental runtime modifications.
 * Local overrides can be loaded from ~/.claude/dexbot_settings.json
 *
 * ===============================================================================
 * EXPORTED CONSTANTS (14 configuration objects)
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
 *      SYNC_DELAY_MS, ACCOUNT_TOTALS_TIMEOUT_MS, MILLISECONDS_PER_SECOND
 *      BLOCKCHAIN_FETCH_INTERVAL_MIN, FILL_DEDUPE_WINDOW_MS
 *      FILL_CLEANUP_INTERVAL_MS, FILL_RECORD_RETENTION_MS
 *      LOCK_TIMEOUT_MS, SYNC_LOCK_TIMEOUT_MS
 *      CONNECTION_TIMEOUT_MS, DAEMON_STARTUP_TIMEOUT_MS
 *      RUN_LOOP_DEFAULT_MS, OPEN_ORDERS_SYNC_LOOP_ENABLED, CHECK_INTERVAL_MS
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
 *   11. NODE_MANAGEMENT - Multi-node health checking and failover configuration
 *       DEFAULT_NODES: List of BitShares nodes for redundancy
 *       HEALTH_CHECK_INTERVAL_MS, HEALTH_CHECK_TIMEOUT_MS, MAX_PING_MS
 *       BLACKLIST_THRESHOLD: Failures before node is blacklisted
 *       EXPECTED_CHAIN_ID: BitShares mainnet chain ID validation
 *       SELECTION_STRATEGY: Node selection algorithm (latency-based)
 *
 *   12. UPDATER - Version checking and update notification
 *       CHECK_INTERVAL_MS, REPO_URL, NOTIFICATION_MIN_LEVEL
 *
 * LOGGING CONFIGURATION:
 *   13. LOGGING_CONFIG - Structured logging configuration
 *       changeTracking: Smart change detection
 *       display.colors: TTY color support
 *       display.fundStatus, display.statusSummary, display.gridDiagnostics
 *       Categories for enabling/disabling log types
 *
 *   14. LOG_LEVEL - Current logging verbosity level
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

const { readGeneralSettings } = require('./general_settings');

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

// Rebalance lifecycle states used by COW planning/broadcast/commit pipeline.
const REBALANCE_STATES = Object.freeze({
    NORMAL: 'NORMAL',
    REBALANCING: 'REBALANCING',
    BROADCASTING: 'BROADCASTING'
});

// Canonical action labels used by grid reconciliation and batch broadcasting.
const COW_ACTIONS = Object.freeze({
    CREATE: 'create',
    CANCEL: 'cancel',
    UPDATE: 'update'
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
    // Conversion factor: milliseconds per second
    MILLISECONDS_PER_SECOND: 1000,
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
    LOCK_TIMEOUT_MS: 10000,  // 10 seconds - balances transaction latency with lock starvation prevention

    // Sync lock acquisition timeout - prevents indefinite lock hangs
    // Uses Promise.race() to enforce timeout on lock acquisition attempts
    SYNC_LOCK_TIMEOUT_MS: 20000,  // 20 seconds - prevents deadlocks while allowing slow operations

    // Connection and initialization timeouts
    CONNECTION_TIMEOUT_MS: 30000,  // 30 seconds - BitShares client connection establishment timeout
    DAEMON_STARTUP_TIMEOUT_MS: 60000,  // 60 seconds - Private key daemon startup timeout

    // Main loop and polling defaults
    RUN_LOOP_DEFAULT_MS: 5000,  // 5 seconds - default open-orders sync cycle delay (env override: OPEN_ORDERS_SYNC_LOOP_MS)
    OPEN_ORDERS_SYNC_LOOP_ENABLED: false,  // Preferred flag: continuous open-order watchdog sync loop
    CHECK_INTERVAL_MS: 100,  // 100 milliseconds - polling interval for connection/daemon readiness checks

    // LOCK_REFRESH_MIN_MS: Minimum interval for refreshing order lock leases during long operations.
    // Prevents lock expiration during extended reconciliations or batch operations.
    // Default: 250ms (4 refreshes per second minimum during long operations).
    LOCK_REFRESH_MIN_MS: 250
};

// Grid limits and scaling constants
let GRID_LIMITS = {
    // MIN_SPREAD_FACTOR: Ensures spread is at least (incrementPercent × MIN_SPREAD_FACTOR) slots wide.
    // Rationale: Spread must be sufficiently wide to:
    //   1. Avoid order collision (orders too close get rejected by blockchain)
    //   2. Allow bid-ask arbitrage room (market makers profit from the spread)
    //   3. Scale proportionally to grid spacing (tighter increments need tighter spread buffer)
    //
    // Example Calculation (incrementPercent = 0.5%, targetSpread = 2%):
    //   - MIN_SPREAD_FACTOR = 2.1 → minSpread = 0.5% × 2.1 = 1.05%
    //   - But target is 2%, so final spread = max(1.05%, 2%) = 2% (target wins)
    //   - This ensures spread is at least (0.5% × 2.1) but respects user's targetSpread
    //
    // Default: 2.1 ensures 3-slot minimum gap even with tight increment (see grid.js::SPREAD_GAP_FORMULA)
    MIN_SPREAD_FACTOR: 2.1,

    // MIN_ORDER_SIZE_FACTOR: Minimum order size = blockchain_minimum × this factor.
    // Rationale: Orders smaller than blockchain minimum are rejected.
    //   - Blockchain minimum ≈ 1 satoshi (10^-8 per unit)
    //   - Float arithmetic and fee deductions can round amounts down
    //   - Safety factor = 50× ensures orders survive rounding
    // Example: If blockchainMin = 1 BTS, then minSize = 50 BTS (very conservative for mainnet)
    // This trades off efficiency (larger minimum) for reliability (never hits rounding floor)
    MIN_ORDER_SIZE_FACTOR: 50,

    // GRID_REGENERATION_PERCENTAGE: Trigger threshold for automatic grid size recalculation.
    // Formula: IF (cacheFunds / total.grid) × 100 ≥ threshold → regenerate
    // Rationale: After fills, proceeds accumulate in cacheFunds (surplus capital).
    //   - 3% = regen triggered when cache represents ≥3% of committed grid size
    //   - This allows gradual accumulation while preventing lag during high-fill periods
    //   - If threshold too low: constant regeneration (churn, fees)
    //   - If threshold too high: capital trapped in cache, grid undersized
    // Example: 20 active orders × 100 BTS each = 2000 BTS grid
    //   - cacheFunds ≥ 60 BTS → (60/2000 = 3%) triggers regeneration
    //   - Allows ~3 fill-proceeds before resize (reduces churn)
    // Checked independently per side, allowing asymmetric fill patterns.
    GRID_REGENERATION_PERCENTAGE: 3,

    // PARTIAL_ACTIVE_RESTORE_RATIO: Minimum size ratio required to restore PARTIAL -> ACTIVE.
    // Formula: chainSize / idealSize >= ratio.
    PARTIAL_ACTIVE_RESTORE_RATIO: 0.95,

    // PARTIAL_DUST_THRESHOLD_PERCENTAGE: Threshold for treating partially-filled orders as "dust".
    // Formula: IF (actualSize / idealSize) × 100 < threshold → dust
    // Rationale: Partially-filled orders become progressively smaller.
    //   - 5% = orders below 5% of ideal size are rotated (to restore grid symmetry)
    //   - Dust orders waste grid slots (they should be closed or brought back to ideal size)
    //   - Rotation replaces dust order with a fresh one at proper size
    //   - Detects both accidental low fills and normal fill-chain truncation
    // Example: idealSize = 100 BTS, but actual = 3 BTS → (3/100 = 3%) < 5% → dust
    //   - This order would be rotated to free the slot
    PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5,

    // FUND_INVARIANT_PERCENT_TOLERANCE: Allowed percentage drift in fund tracking before triggering recovery.
    // Formula: tolerance = max(precisionSlack, balance × percentTolerance)
    // Rationale: Fund tracking can drift due to:
    //   1. Float arithmetic rounding (resolved by precisionSlack, ~10^-precision)
    //   2. In-flight blockchain transactions (resolved by percentTolerance)
    //   3. Fee accumulation from multiple operations
    // Default: 0.1% (0.1%) means for 1000 BTS balance, drift up to 1 BTS is tolerated
    //   - Accounts for ~5 fill-fee events before recovery triggered
    //   - Too low: false positives (recoveries on healthy operations)
    //   - Too high: undetected drift (fund leaks)
    // Drifts larger than this tolerance trigger immediate recovery (re-sync from blockchain).
    FUND_INVARIANT_PERCENT_TOLERANCE: 0.1,

    // MIN_SPREAD_ORDERS: Minimum number of empty slots in spread zone (between best buy and best sell).
    // Rationale: Spread must be sufficiently wide to:
    //   1. Prevent order collision (blockchain rejects orders with identical price)
    //   2. Ensure market makers profit from the bid-ask difference
    //   3. Allow price movement without orders crossing each other
    // Default: 2 (at least 2 empty slots between buy and sell sides)
    // Example: Buy @ 99.9, empty, empty, Sell @ 100.1 → 2-slot spread (acceptable)
    //         Buy @ 99.9, empty, Sell @ 100.0 → 1-slot spread (too tight, rebalance triggered)
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
        // Set to 0 to completely disable RMS divergence checks
        //
        // RMS Threshold Reference Table (for 5% distribution: 5% outliers, 95% perfect):
        // ┌────────────────────────────────────────────────────────┐
        // │ RMS %       │ Avg Error │ Description                 │
        // ├────────────────────────────────────────────────────────┤
        // │ 0           │ N/A       │ Disabled (no checks)        │
        // │ 4.5%        │ ~1.0%     │ Very strict                 │
        // │ 9.8%        │ ~2.2%     │ Strict                      │
        // │ 14.3%       │ ~3.2%     │ Default (balanced)          │
        // │ 20.1%       │ ~4.5%     │ Lenient                     │
        // │ 31.7%       │ ~7.1%     │ Very lenient                │
        // │ 44.7%       │ ~10%      │ Extremely lenient           │
        // └────────────────────────────────────────────────────────┘
        RMS_PERCENTAGE: 14.3
    },

    // SATOSHI_CONVERSION_FACTOR: Multiplier to convert decimal amounts to integer satoshis.
    // Used for fee event deduplication to avoid float precision issues.
    // Formula: decimalAmount × SATOSHI_CONVERSION_FACTOR = integerSatoshis
    // Default: 100,000,000 (10^8) for 8 decimal places (standard blockchain precision).
    SATOSHI_CONVERSION_FACTOR: 1e8,

    // STATE_CHANGE_HISTORY_MAX: Maximum number of state changes to retain in circular buffer.
    // Used by StateChangeLogger for tracking recent grid/fund mutations.
    // Default: 100 entries (balances memory usage with debugging utility).
    STATE_CHANGE_HISTORY_MAX: 100
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
    // BTS_RESERVATION_MULTIPLIER: Factor applied to totalTargetOrders to reserve BTS fee budget.
    // Formula: BTS reserved = totalTargetOrders × BTS_RESERVATION_MULTIPLIER
    // Rationale: Each order can be updated/cancelled during rebalancing, and each operation incurs a fee.
    //   - Conservative estimate: each order may be touched ~5 times during its lifetime
    //   - Orders get: created (1 fee), rotated (2 fees: cancel + place), updated (1 fee), cancelled (1 fee)
    //   - So ~5 fees per order is safe buffer to prevent fee starvation
    // Example: 20 active orders → 20 × 5 = 100 BTS reserved for fee operations
    // Set to 0 to disable fee reservation (not recommended for production).
    BTS_RESERVATION_MULTIPLIER: 5,
    
    // Fallback BTS fee (satoshis) when dynamic fee calculation fails.
    // Rationale: During startup or when fee API is unavailable, use this conservative estimate.
    //   - 100 satoshis = 0.00000100 BTS (typical limit order fee is 1-2 BTS on mainnet)
    //   - Using satoshi precision prevents integer division errors
    //   - Actual fees are calculated and deducted once fee API responds
    BTS_FALLBACK_FEE: 100,
    
    // MAKER_FEE_PERCENT: Percentage of base fee charged for maker orders (orders that rest in book).
    // Rationale: BitShares incentivizes providing liquidity (making orders) with lower fees.
    //   - 0.1 = 10% of the base order creation fee
    //   - Typical: 2 BTS base fee × 0.1 = 0.2 BTS charged (maker)
    //   - vs. 2 BTS for taker orders (taker: 100% of base fee)
    //   - This 10× discount encourages grid bots (primarily makers) to place orders
    MAKER_FEE_PERCENT: 0.1,
    
    // MAKER_REFUND_PERCENT: Percentage of maker fee refunded after order execution/cancellation.
    // Rationale: BitShares refunds unused maker fees when order is cancelled or fills.
    //   - 0.9 = 90% refund of the maker fee paid
    //   - Typical: Paid 0.2 BTS, get 0.18 BTS refund, net cost 0.02 BTS
    //   - Refund arrives in a separate transaction after cancellation
    //   - This incentive structure encourages taker participation (market efficiency)
    MAKER_REFUND_PERCENT: 0.9,
    
    // TAKER_FEE_PERCENT: Percentage of base fee charged for taker orders (orders that cross spread).
    // Rationale: Takers (who immediately fill) pay full fee; they consume liquidity.
    //   - 1.0 = 100% of the base order creation fee
    //   - Typical: 2 BTS base fee × 1.0 = 2 BTS charged (no refund)
    //   - Full fee covers order broadcast and execution costs
    TAKER_FEE_PERCENT: 1.0
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
    TAKER_INDICATOR: 0,

    // Adaptive batch sizing for fill processing under stress.
    // Instead of processing fills one-at-a-time (each requiring a separate broadcast),
    // multiple fills are grouped into a single processFilledOrders + broadcast cycle.
    // The batch size scales with queue depth:
    //   queueDepth 1-2  -> batch of 1 (normal operation)
    //   queueDepth 3-5  -> batch of 2
    //   queueDepth 6-14 -> batch of 3
    //   queueDepth 15+  -> batch of MAX_FILL_BATCH_SIZE
    // Set to 1 to disable batching (legacy sequential behavior).
    MAX_FILL_BATCH_SIZE: 4,

    // Queue depth thresholds for adaptive batch sizing.
    // Array of [minQueueDepth, batchSize] pairs, evaluated in order.
    // The first matching threshold determines the batch size.
    BATCH_STRESS_TIERS: [
        [15, 4],  // 15+ fills queued -> batch of 4
        [6,  3],  // 6-14 fills queued -> batch of 3
        [3,  2],  // 3-5 fills queued  -> batch of 2
        [0,  1]   // 0-2 fills queued  -> sequential (1-at-a-time)
    ]
};

// Cleanup and maintenance parameters
let MAINTENANCE = {
    // Probability of running cleanup operation on any cycle (0.1 = 10%)
    CLEANUP_PROBABILITY: 0.1
};

// Node management and health checking configuration
let NODE_MANAGEMENT = {
    // Default node list (used if no config file)
    DEFAULT_NODES: [
        'wss://dex.iobanker.com/ws',
        'wss://api.bts.mobi/ws',
        'wss://eu.nodes.bitshares.ws/ws',
        'wss://cloud.xbts.io/ws',
        'wss://node.xbts.io/ws',
        'wss://public.xbts.io/ws',
        'wss://btsws.roelandp.nl/ws',
        'wss://singapore.bitshares.im/ws'
    ],

    // Health check defaults
    HEALTH_CHECK_INTERVAL_MS: 60000,    // 1 minute
    HEALTH_CHECK_TIMEOUT_MS: 5000,      // 5 seconds per check
    MAX_PING_MS: 3000,                  // Max acceptable latency
    BLACKLIST_THRESHOLD: 3,             // Failures before blacklist

    // Expected chain ID (BitShares mainnet)
    EXPECTED_CHAIN_ID: '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8',

    // Selection strategy
    SELECTION_STRATEGY: 'latency'       // latency-based selection
};

// Pipeline timeout configuration
let PIPELINE_TIMING = {
    // TIMEOUT_MS: Maximum duration for pipeline operations before forcing maintenance.
    // Rationale: If pipeline hangs (stuck in lock, slow blockchain, etc), force a maintenance cycle.
    //   - 300000 ms = 5 minutes
    //   - Prevents infinite hangs; ensures bot recovers or logs the problem
    //   - Typical pipeline cycle completes in <100ms (unless blockchain is slow)
    //   - 5 minute timeout allows for slow network periods while still being responsive
    // When timeout is exceeded, pipeline triggers maintenance (logs, cleanup, state check).
    TIMEOUT_MS: 300000,

    // RECOVERY_RETRY_INTERVAL_MS: Minimum cooldown time between fund invariant recovery attempts.
    // Rationale: When a fund tracking invariant violation is detected:
    //   - First attempt: immediate (no wait) — try to fix quickly
    //   - Subsequent attempts: wait at least this duration — prevent tight retry loops
    //   - Prevents blockchain query spam while allowing eventual convergence
    //
    // Backoff Timeline Example (defaults):
    //   - T=0s: Violation detected → immediate recovery attempt #1
    //   - T=45s: Next violation check → still in cooldown, skip retry
    //   - T=65s: Next violation check → cooldown expired, attempt #2
    //   - T=125s: Attempt #3 (another 60s)
    //   - T=180s: Attempt #4
    //   - T=240s: Attempt #5 (max reached)
    //   - T=300s: Fill arrives → counter resets, ready for new recovery episode
    //
    // Default: 60000 ms (60 seconds) balances responsiveness with resource efficiency.
    //   - Too low (e.g., 5s): constant recovery attempts, high blockchain load
    //   - Too high (e.g., 600s): slow detection of new invariant drift, bad UX
    RECOVERY_RETRY_INTERVAL_MS: 60000,

    // MAX_RECOVERY_ATTEMPTS: Maximum recovery retry attempts before giving up.
    // Rationale: Limit total recovery effort to prevent runaway loop.
    //   - After N failed attempts, bot stops recovery until next fill/sync
    //   - This allows bot to stabilize when recovery is impossible
    //   - Example: if funds are impossible to recover, don't keep trying indefinitely
    //
    // Retry Lifecycle (defaults, MAX = 5):
    //   - Attempts 1-5: Each spaced RECOVERY_RETRY_INTERVAL_MS apart (~60s each)
    //   - Attempt 5 fails: stop retrying
    //   - Next fill or blockchain fetch (after ~1 minute): counter resets, new episode starts
    //   - Total time blocked per episode: ~5 × 60s = 5 minutes before giving up
    //
    // Special Cases:
    //   - Set to 0: unlimited retries (not recommended; can cause infinite recovery loops)
    //   - Set to 1: one-shot only (minimal recovery effort; original patch15 behavior)
    //   - Set to 5: balanced (typical value; ~5 min of effort)
    MAX_RECOVERY_ATTEMPTS: 5,

    // FEE_EVENT_DEDUP_TTL_MS: How long to remember settled fee events for deduplication.
    // Prevents the same fill from being fee-settled multiple times when
    // re-detected across sync cycles or reconnections.
    // Default: 6 hours (21600000 ms).
    FEE_EVENT_DEDUP_TTL_MS: 6 * 60 * 60 * 1000,

    // MAX_FEE_EVENT_CACHE_SIZE: Maximum number of fee events to keep in deduplication cache.
    // Prevents unbounded memory growth during extended operation with many fills.
    // When exceeded, oldest entries are evicted to 75% capacity.
    // Default: 10000 entries (~60MB worst case with long event IDs).
    MAX_FEE_EVENT_CACHE_SIZE: 10000,

    // CACHE_EVICTION_RETENTION_RATIO: Target ratio of entries to keep during cache eviction.
    // When cache exceeds max size, evict down to (maxSize × ratio) entries.
    // Default: 0.75 (75%) - evicts oldest 25% to get back to 75% capacity.
    CACHE_EVICTION_RETENTION_RATIO: 0.75,

    // RECOVERY_DECAY_FALLBACK_MS: Default decay window for recovery attempt counter (milliseconds).
    // Used when RECOVERY_RETRY_INTERVAL_MS is not configured.
    // After this idle time, recovery attempt count resets to prevent permanent exhaustion.
    // Default: 3 minutes (180000 ms).
    RECOVERY_DECAY_FALLBACK_MS: 3 * 60 * 1000
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

// Copy-on-Write (COW) Grid performance thresholds
let COW_PERFORMANCE = {
    MAX_REBALANCE_PLANNING_MS: 100,
    MAX_COMMIT_MS: 50,
    MAX_MEMORY_MB: 50,
    INDEX_REBUILD_THRESHOLD: 10000,
    GRID_MEMORY_WARNING: 5000,
    GRID_MEMORY_CRITICAL: 10000,

    // WORKING_GRID_BYTES_PER_ORDER: Estimated memory usage per order in working grid (bytes).
    // Used for memory profiling and warning thresholds.
    // Default: 500 bytes (includes order object, metadata, and overhead).
    WORKING_GRID_BYTES_PER_ORDER: 500
};

// --- LOCAL SETTINGS OVERRIDES ---
// Load user-defined settings from profiles/general.settings.json if it exists.
// This allows preserving settings during updates without git stashing.
const settings = readGeneralSettings({
    fallback: null,
    onError: (err, filePath) => {
        console.warn(`[WARN] Failed to load local settings from ${filePath}: ${err.message}`);
    }
});

if (settings) {
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
    if (settings.FILL_PROCESSING) {
        const fillSettings = Object.fromEntries(
            Object.entries(settings.FILL_PROCESSING).filter(([key]) => !key.startsWith('_'))
        );
        FILL_PROCESSING = { ...FILL_PROCESSING, ...fillSettings };
    }

    if (settings.PIPELINE_TIMING) {
        const pipelineSettings = Object.fromEntries(
            Object.entries(settings.PIPELINE_TIMING).filter(([key]) => !key.startsWith('_'))
        );
        PIPELINE_TIMING = { ...PIPELINE_TIMING, ...pipelineSettings };
    }

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
}

// Freeze objects to prevent accidental runtime modifications
Object.freeze(ORDER_TYPES);
Object.freeze(ORDER_STATES);
Object.freeze(REBALANCE_STATES);
Object.freeze(COW_ACTIONS);
Object.freeze(TIMING);
Object.freeze(GRID_LIMITS);
Object.freeze(GRID_LIMITS.GRID_COMPARISON);
Object.freeze(INCREMENT_BOUNDS);
Object.freeze(FEE_PARAMETERS);
Object.freeze(API_LIMITS);
Object.freeze(FILL_PROCESSING);
Object.freeze(FILL_PROCESSING.BATCH_STRESS_TIERS);
Object.freeze(MAINTENANCE);
Object.freeze(NODE_MANAGEMENT);
Object.freeze(PIPELINE_TIMING);
Object.freeze(UPDATER);
Object.freeze(COW_PERFORMANCE);
Object.freeze(LOGGING_CONFIG);

module.exports = { ORDER_TYPES, ORDER_STATES, REBALANCE_STATES, COW_ACTIONS, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL, LOGGING_CONFIG, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, FILL_PROCESSING, MAINTENANCE, NODE_MANAGEMENT, PIPELINE_TIMING, UPDATER, COW_PERFORMANCE };
