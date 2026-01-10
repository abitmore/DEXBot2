# Fund Snapshot Logging System - Complete Guide

## Quick Reference

**Enable snapshots in config:**
```json
{ "logLevel": "debug" }
```

**Analyze snapshots:**
```bash
node scripts/analyze_fund_snapshots.js --bot=botname
node scripts/analyze_fund_snapshots.js --bot=bot1 --compare=bot2
node scripts/analyze_fund_snapshots.js --bot=botname --export  # CSV
```

**From code:**
```javascript
const snapshot = manager.logger.captureSnapshot(manager, 'event_type', eventId, {extraData});
const recent = manager._snapshotHistory.getLast(10);
const anomalies = manager._snapshotHistory.detectAnomalies();
```

---

## Overview

The Fund Snapshot System provides detailed, timestamped snapshots of your trading bot's fund state at critical points during operation. This enables post-mortem analysis of fund discrepancies, detection of accounting anomalies, and verification of fund invariants.

**Key Features:**
- ✅ Automatic snapshot capture at fund recalculation, order creation, and order fills
- ✅ In-memory history (last 1000 snapshots) for real-time analysis
- ✅ Persistent storage (JSONL format) for historical audit trails
- ✅ Anomaly detection with automated invariant violation flagging
- ✅ CSV export for external analysis
- ✅ Bot-to-bot comparison for detecting divergence
- ✅ Minimal performance overhead (only in debug mode)

---

## Quick Start

### 1. Enable Snapshot Logging

Set your bot to debug log level in `profiles/bots.json`:

```json
{
  "bots": [
    {
      "account": "my-account",
      "logLevel": "debug",  // ← Enable snapshots
      ...
    }
  ]
}
```

### 2. Run Your Bot

Snapshots are automatically captured during operation. In debug mode, they're logged after fund recalculation completes.

### 3. Analyze Snapshots

Use the CLI analysis tool:

```bash
# Analyze a single bot
node scripts/analyze_fund_snapshots.js --bot=my-account

# Compare two bots
node scripts/analyze_fund_snapshots.js --bot=my-account --compare=other-account

# Export to CSV
node scripts/analyze_fund_snapshots.js --bot=my-account --export
```

---

## Architecture

### 1. FundSnapshot (fund_snapshot.js)

Represents an immutable snapshot of fund state at a point in time.

**Data Captured:**
- Timestamp (milliseconds since epoch)
- Event type (fill_detected, order_created, fund_recalc_complete, etc.)
- Event context (orderId, size, price, fees, etc.)
- Fund state:
  - `available.buy/sell` - Liquid funds available for new orders
  - `total.chain.buy/sell` - Total on-chain balance
  - `total.grid.buy/sell` - Total allocated in grid
  - `committed.chain.buy/sell` - Locked in active on-chain orders
  - `committed.grid.buy/sell` - Locked in active grid orders (including VIRTUAL)
  - `virtual.buy/sell` - Reserved in VIRTUAL orders
  - `cacheFunds.buy/sell` - Surplus from fills and rotations
  - `btsFeesOwed` - Pending BTS transaction fees
- Account totals (buy/sell total and free from blockchain)
- Grid state (active/partial/virtual/spread order counts, boundary index)
- Calculated metrics (invariant violations, consistency checks)

**Key Methods:**
```javascript
// Capture current state
const snapshot = FundSnapshot.capture(manager, 'order_created', orderId, {
    type: order.type,
    size: order.size,
    fee: btsFeeData.createFee
});

// Check for invariant violations
if (snapshot.hasViolations()) {
    console.log("Fund invariant violated!");
}

// Format for logging
console.log(snapshot.toString(detailed = true));
```

### 2. FundSnapshotHistory (fund_snapshot.js)

Maintains a time-series history of snapshots with analysis capabilities.

**Key Methods:**
```javascript
// Add snapshot to history
history.add(snapshot);

// Query snapshots
const fills = history.getByEventType('order_filled');
const recent = history.getLast(10);
const ranged = history.getByTimeRange(startMs, endMs);

// Detect anomalies
const anomalies = history.detectAnomalies(tolerancePercent = 0.1);

// Generate report
const report = history.generateReport(limit = null);

// Print summary
history.printSummary();

// Compare two snapshots
const diff = FundSnapshotHistory.getDifference(snapshot1, snapshot2);
console.log(`Available buy changed: ${diff.availableChange.buy}`);
```

### 3. FundSnapshotPersistence (fund_snapshot_persistence.js)

Handles saving, loading, and analyzing snapshots on disk.

**Storage Location:** `.snapshots/` directory (created automatically)

**File Format:** JSONL (one JSON object per line) for streaming and easy querying

**Key Methods:**
```javascript
// Save history to disk
const result = await FundSnapshotPersistence.saveSnapshots(botKey, history, {
    append: true,          // Append to existing file
    maxLines: 10000        // Keep only last 10000 lines
});

// Load history from disk
const history = await FundSnapshotPersistence.loadSnapshots(botKey, {
    limit: 1000,           // Load last 1000 snapshots
    eventType: 'order_filled'  // Optional: filter by event type
});

// Analyze snapshots and generate report
const analysis = await FundSnapshotPersistence.analyzeSnapshots(botKey);
// Returns: summary, statistics, anomalies, event distribution, fund trend, first/last snapshots

// Compare two bots
const comparison = await FundSnapshotPersistence.compareBots(botKey1, botKey2);

// Export to CSV for Excel/Tableau analysis
const result = await FundSnapshotPersistence.exportToCSV(botKey, outputPath);
```

### 4. Logger Extensions (logger.js)

The Logger class adds snapshot methods for easy in-application logging.

**Key Methods:**
```javascript
// Capture a snapshot
const snapshot = logger.captureSnapshot(manager, 'event_type', eventId, {
    extraContext: 'value'
});

// Log a snapshot
logger.logSnapshot(snapshot, detailed = false);

// Compare two snapshots
logger.logSnapshotComparison(snapshot1, snapshot2);
```

### 5. CLI Analysis Tool (scripts/analyze_fund_snapshots.js)

Command-line utility for comprehensive snapshot analysis.

**Usage:**
```bash
# Analyze single bot
node scripts/analyze_fund_snapshots.js --bot=botkey

# Compare two bots
node scripts/analyze_fund_snapshots.js --bot=bot1 --compare=bot2

# Export to CSV
node scripts/analyze_fund_snapshots.js --bot=botkey --export
```

**Output Includes:**
- Total snapshots and time span
- Anomalies detected and violations
- Fund statistics (min/max/avg/current)
- Event type distribution
- Fund trend (increasing/decreasing/stable)
- Anomaly details
- First and last snapshot comparison

---

## Fund Snapshot Events

### Automatic Capture Points

The system automatically captures snapshots at these points (in debug mode):

| Event Type | Location | Trigger |
|---|---|---|
| `fund_recalc_complete` | accounting.js:185 | After fund recalculation completes (batch end) |
| `order_filled` | sync_engine.js:254 | Order detected as completely filled (sync) |
| `order_filled_history` | sync_engine.js:417 | Order filled via fill history |
| `order_created` | sync_engine.js:542 | New order placed on blockchain and activated |

### Manual Capture

You can also manually capture snapshots:

```javascript
// In any code with access to manager
const snapshot = manager.logger.captureSnapshot(manager, 'custom_event', customId, {
    description: 'My custom event',
    details: { ... }
});
```

---

## Invariant Verification

The snapshot system automatically checks three critical fund invariants:

### INVARIANT 1: Conservation of Capital
```
chainTotal = chainFree + chainCommitted
```
**Meaning:** Total on-chain balance = Free balance + Balance locked in orders
**Checked:** Every fund recalculation

### INVARIANT 2: Available Bounds
```
available ≤ chainFree
```
**Meaning:** Liquid funds can't exceed free balance
**Checked:** Every fund recalculation

### INVARIANT 3: Grid Commitment Bounds
```
gridCommitted ≤ chainTotal
```
**Meaning:** Grid-allocated capital can't exceed total on-chain
**Checked:** Every fund recalculation

### Violation Detection

Violations are detected with configurable tolerance:
- **Precision tolerance:** 2 units (accounts for blockchain precision)
- **Percentage tolerance:** 0.1% (accounts for fees and rounding)

Violations trigger:
1. Warning log in console
2. Anomaly flag in snapshot
3. Counter in `_metrics.invariantViolations`

---

## Anomaly Detection

The system automatically detects and flags anomalies:

### Invariant Violations
Any snapshot that fails fund invariant checks (above tolerance).

### Unexplained Fund Increases
When `available.buy` or `available.sell` increases without a fill event triggering it. This indicates either:
- Funds appearing from nowhere (leak in opposite direction)
- External deposit (expected)
- Fee refund or settlement

### Unexpected Fund Decreases
When `chainTotal` decreases unexpectedly (not explained by fees or withdrawals).

---

## Usage Examples

### Example 1: Quick Bot Health Check

```bash
node scripts/analyze_fund_snapshots.js --bot=trading-bot
```

**Output shows:**
- ✅ No anomalies detected
- 500+ snapshots over 2 hours
- Fund trend: stable
- No invariant violations

### Example 2: Investigate Fund Discrepancy

```bash
node scripts/analyze_fund_snapshots.js --bot=problematic-bot
```

**Output shows:**
- ❌ 3 anomalies detected
- Invariant violation: `INVARIANT 1 (BUY): chainTotal != chainFree + chainCommitted`
- Unexplained increase in available.buy at 14:32:01

**Action:** Check logs at that time, look for fee deductions or order cancellations

### Example 3: Compare Two Bot Instances

```bash
node scripts/analyze_fund_snapshots.js --bot=bot-prod --compare=bot-staging
```

**Output shows:**
- Bot-prod available buy: 1000.00000000
- Bot-staging available buy: 999.50000000
- Difference: 0.50000000 BTS

**Insight:** Staging bot has 0.5 BTS less (possibly different fee structure or transaction)

### Example 4: Export for External Analysis

```bash
node scripts/analyze_fund_snapshots.js --bot=my-bot --export
```

Creates: `.snapshots/my-bot.snapshots.csv`

CSV columns:
- timestamp
- eventType
- available_buy, available_sell
- chain_total_buy, chain_total_sell
- chain_committed_buy, chain_committed_sell
- cache_buy, cache_sell
- bts_fees_owed
- grid_active, grid_partial, grid_virtual

**Use cases:**
- Create visualizations in Tableau/Power BI
- Run custom statistical analysis
- Compare against blockchain data
- Generate audit reports

---

## Programmatic Access

### In Your Bot Code

```javascript
// Access snapshot history
const history = this.manager._snapshotHistory;

// Get latest snapshots
const recent = history.getLast(10);

// Print summary to console
history.printSummary();

// Detect anomalies
const anomalies = history.detectAnomalies();
if (anomalies.length > 0) {
    this.manager.logger.log(`⚠️  ${anomalies.length} anomalies detected`, 'warn');
}
```

### In Post-Processing Scripts

```javascript
const FundSnapshotPersistence = require('./modules/order/fund_snapshot_persistence');

async function analyzeBot(botKey) {
    const analysis = await FundSnapshotPersistence.analyzeSnapshots(botKey);

    if (analysis.summary.hasViolations) {
        console.log(`❌ Found invariant violations in ${botKey}`);
        console.log(analysis.anomalies);
    }

    return analysis;
}

analyzeBot('my-bot');
```

---

## Performance Considerations

### Memory Overhead
- **Per snapshot:** ~2-3 KB
- **Max in memory:** 1000 snapshots = 2-3 MB
- **Automatic pruning:** Old snapshots removed when limit reached

### Disk Overhead
- **Per line in JSONL:** ~1-2 KB
- **Default max file:** 10000 lines = 10-20 MB
- **Automatic rotation:** Old lines removed when file grows too large

### CPU Overhead
- **Snapshot capture:** < 1ms (copy and JSON serialization)
- **Anomaly detection:** < 5ms for 1000 snapshots
- **Only in debug mode:** Zero overhead in production (info/warn/error levels)

### Recommendations

**Production Bot (info/warn/error level):**
- No snapshot overhead
- Enable if investigating fund issues
- Only costs disk space

**Debug Mode (debug level):**
- Minimal CPU overhead (< 1% in typical scenarios)
- Keep enabled during development
- Disable in high-frequency trading scenarios if needed

---

## Troubleshooting

### Snapshots Not Being Created

**Issue:** No `.snapshots/` directory created

**Solution:**
1. Ensure log level is set to `debug`
2. Restart bot with `logLevel: "debug"` in config
3. Wait for at least one fund recalculation

**Issue:** `Cannot find module './fund_snapshot'`

**Solution:**
Make sure you're running from the project root directory

### Anomalies Detected But Funds Are Correct

**Issue:** False positives in anomaly detection

**Solution:**
- Check tolerance settings (0.1% by default)
- Review the anomaly details - most false positives are:
  - Fee deductions (expected)
  - Rounding at blockchain precision boundaries (< 0.00000001 for most assets)
  - External deposits/withdrawals (outside grid's knowledge)

### Cannot Load Historical Snapshots

**Issue:** `ENOENT: no such file or directory '.snapshots/bot.snapshots.jsonl'`

**Solution:**
- Bot has no snapshot history yet
- Run bot in debug mode to generate snapshots
- Wait for first fund recalculation

---

## Integration with Existing Code

### OrderManager Constructor

Already integrated:
```javascript
const { FundSnapshotHistory } = require('./fund_snapshot');
this._snapshotHistory = new FundSnapshotHistory(1000);
```

### Logger Methods

Already integrated:
- `captureSnapshot(manager, eventType, eventId, extraContext)`
- `logSnapshot(snapshot, detailed)`
- `logSnapshotComparison(snapshot1, snapshot2)`

### Accounting.js

Snapshot capture on fund recalculation complete:
```javascript
mgr.logger?.captureSnapshot(mgr, 'fund_recalc_complete', null, {
    gridSize: mgr.orders?.size || 0,
    activeCount: mgr._ordersByState?.[ORDER_STATES.ACTIVE]?.size || 0
});
```

### Sync Engine

Snapshot capture on key events:
- Order filled (open orders sync)
- Order filled (fill history)
- Order created and activated

---

## Best Practices

### 1. Enable in Debug Mode During Development

```json
{
  "logLevel": "debug",
  "botName": "dev-bot"
}
```

### 2. Periodically Export and Archive

```bash
# Weekly analysis
node scripts/analyze_fund_snapshots.js --bot=my-bot --export

# Archive snapshots
mv .snapshots/my-bot.snapshots.csv .archives/my-bot-week-$(date +%Y%m%d).csv
```

### 3. Set Up Alerts for Anomalies

```javascript
// In your bot startup
const history = manager._snapshotHistory;
setInterval(async () => {
    const anomalies = history.detectAnomalies();
    if (anomalies.length > previous_count) {
        sendAlert(`New anomalies detected: ${anomalies.length}`);
    }
}, 60000); // Check every minute
```

### 4. Compare Multi-Bot Deployments

```bash
# Ensure two bots are diverging identically
node scripts/analyze_fund_snapshots.js \
  --bot=prod-bot-1 \
  --compare=prod-bot-2
```

### 5. Include Snapshots in Incident Reports

When reporting fund discrepancies:
```bash
node scripts/analyze_fund_snapshots.js --bot=affected-bot --export

# Attach the CSV and analysis output to incident report
```

---

## API Reference

### FundSnapshot

```javascript
// Constructor (use FundSnapshot.capture instead)
new FundSnapshot(timestamp, eventType, context, manager)

// Static method
FundSnapshot.capture(manager, eventType, eventId, extraContext) → FundSnapshot

// Instance methods
snapshot.hasViolations(tolerancePercent = 0.1) → boolean
snapshot.toString(detailed = false) → string
snapshot.toJSON() → Object

// Instance properties
snapshot.timestamp → milliseconds
snapshot.eventType → string
snapshot.context → Object
snapshot.funds → { available, total, committed, virtual, cacheFunds, btsFeesOwed }
snapshot.accountTotals → { buy, buyFree, sell, sellFree }
snapshot.gridState → { totalOrders, activeCount, partialCount, virtualCount, spreadCount, boundaryIdx }
snapshot.metrics → { invariant1Buy, invariant1Sell, invariant2Buy, invariant2Sell, invariant3Buy, invariant3Sell }
```

### FundSnapshotHistory

```javascript
// Constructor
new FundSnapshotHistory(maxSnapshots = 1000)

// Instance methods
history.add(snapshot) → void
history.getByTimeRange(startTime, endTime) → FundSnapshot[]
history.getByEventType(eventType) → FundSnapshot[]
history.getLast(count = 10) → FundSnapshot[]
history.detectAnomalies(tolerancePercent = 0.1) → Object[]
history.generateReport(limit = null) → Object
history.printSummary() → void

// Static methods
FundSnapshotHistory.getDifference(snapshot1, snapshot2) → Object
```

### FundSnapshotPersistence

```javascript
// Static methods (all async)
FundSnapshotPersistence.getSnapshotPath(botKey) → string
FundSnapshotPersistence.ensureDirectory() → Promise<void>
FundSnapshotPersistence.saveSnapshots(botKey, history, options) → Promise<{saved, total, [error]}>
FundSnapshotPersistence.loadSnapshots(botKey, options) → Promise<FundSnapshotHistory>
FundSnapshotPersistence.analyzeSnapshots(botKey) → Promise<Object>
FundSnapshotPersistence.compareBots(botKey1, botKey2) → Promise<Object>
FundSnapshotPersistence.exportToCSV(botKey, outputPath) → Promise<{status, [path, rows, error]}>
```

---

## FAQ

**Q: How much disk space will snapshots use?**
A: ~1-2 KB per snapshot. Default 10000 limit = 10-20 MB per bot.

**Q: Can I disable snapshots in production?**
A: Yes - set `logLevel` to `info`, `warn`, or `error` (anything but `debug`).

**Q: How do I clear old snapshots?**
A: Delete the file: `rm .snapshots/botkey.snapshots.jsonl`

**Q: Can I snapshot multiple bots?**
A: Yes - each bot gets its own file in `.snapshots/botkey.snapshots.jsonl`

**Q: What's the maximum history size?**
A: 1000 snapshots in memory by default (configurable), 10000 on disk.

**Q: Do snapshots slow down the bot?**
A: No impact unless in debug mode (< 1ms per recalculation).

**Q: Can I integrate snapshots with monitoring/alerting?**
A: Yes - access `manager._snapshotHistory` or load from disk in separate process.

---

## Version History

- **v1.0** (2026-01-08): Initial implementation with core snapshot capture, persistence, and analysis

---

## Support

For issues or questions about the snapshot system:
1. Check logs for snapshot capture errors (grep `[SNAPSHOT]`)
2. Run analysis tool to verify data integrity
3. Review FUND_ACCOUNTING_ANALYSIS.md for background
