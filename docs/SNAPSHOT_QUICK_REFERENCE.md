# Fund Snapshot System - Quick Reference

## Enable Snapshots
```json
// In profiles/bots.json
{
  "logLevel": "debug"  // Snapshots auto-capture in debug mode
}
```

## Analyze Snapshots
```bash
# Analyze single bot
node scripts/analyze_fund_snapshots.js --bot=botname

# Compare two bots
node scripts/analyze_fund_snapshots.js --bot=bot1 --compare=bot2

# Export to CSV
node scripts/analyze_fund_snapshots.js --bot=botname --export
```

## From Your Code
```javascript
// Manual snapshot capture
const snapshot = logger.captureSnapshot(manager, 'event_type', eventId, {
    extraData: 'value'
});

// Access history
const recent = manager._snapshotHistory.getLast(10);
const fills = manager._snapshotHistory.getByEventType('order_filled');

// Print summary
manager._snapshotHistory.printSummary();

// Detect anomalies
const anomalies = manager._snapshotHistory.detectAnomalies();
```

## Programmatic Analysis
```javascript
const FundSnapshotPersistence = require('./modules/order/fund_snapshot_persistence');

// Analyze snapshots on disk
const analysis = await FundSnapshotPersistence.analyzeSnapshots(botKey);
console.log(analysis.summary);  // Count, anomalies, violations
console.log(analysis.anomalies);  // List of issues
console.log(analysis.statistics);  // Min/max/avg funds

// Load for custom analysis
const history = await FundSnapshotPersistence.loadSnapshots(botKey);
const fills = history.getByEventType('order_filled');

// Compare bots
const comparison = await FundSnapshotPersistence.compareBots('bot1', 'bot2');
console.log(comparison.difference);  // Fund differences
```

## Fund Data in Snapshot
```
snapshot.funds = {
  available.buy/sell      → Liquid funds for new orders
  total.chain.buy/sell    → Total on-chain balance
  total.grid.buy/sell     → Total grid allocation
  committed.chain.buy/sell → Locked in on-chain orders
  committed.grid.buy/sell  → Locked in grid orders
  virtual.buy/sell        → Reserved for future placement
  cacheFunds.buy/sell     → Fill proceeds and rotation surplus
  btsFeesOwed             → Pending BTS transaction fees
}
```

## Fund Invariants (Verified Automatically)
```
INVARIANT 1: chainTotal = chainFree + chainCommitted
  ✓ Total balance = free balance + locked in orders

INVARIANT 2: available ≤ chainFree
  ✓ Liquid funds ≤ free balance

INVARIANT 3: gridCommitted ≤ chainTotal
  ✓ Grid allocation ≤ total balance
```

## Snapshot Events
| Event | When | Context |
|-------|------|---------|
| `fund_recalc_complete` | Fund recalculation done | Grid size, active count |
| `order_filled` | Order completely filled (sync) | OrderId, gridId, type, size |
| `order_filled_history` | Order filled via history | BlockNum, historyId, amount |
| `order_created` | New order placed & activated | GridId, type, size, price, fee |

## Storage
```
Location:      .snapshots/
Format:        JSONL (one JSON per line)
File naming:   .snapshots/botkey.snapshots.jsonl
Max file size: 10000 lines (auto-prunes)
Space per bot: 10-20 MB typical
```

## Performance
```
Memory:  2-3 MB for 1000 snapshots
CPU:     < 1ms per capture
Disk:    1-2 KB per snapshot
Overhead: Zero in production (only in debug mode)
```

## Common Commands
```bash
# Check bot health
node scripts/analyze_fund_snapshots.js --bot=my-bot

# Find when anomaly occurred
node scripts/analyze_fund_snapshots.js --bot=problematic-bot | grep -A 5 "Anomalies"

# Export for Excel analysis
node scripts/analyze_fund_snapshots.js --bot=my-bot --export
# Creates: .snapshots/my-bot.snapshots.csv

# Compare production instances
node scripts/analyze_fund_snapshots.js --bot=prod-1 --compare=prod-2

# Clear old snapshots
rm .snapshots/old-bot.snapshots.jsonl
```

## Troubleshooting
```
No snapshots? → Set logLevel: "debug"
False positives? → Most "anomalies" are fee deductions (check context)
Disk full? → Delete old .snapshots/botkey.snapshots.jsonl files
Export blank? → Run bot for a minute to generate snapshots
```

## Files
```
Core:           modules/order/fund_snapshot.js
Persistence:    modules/order/fund_snapshot_persistence.js
CLI Tool:       scripts/analyze_fund_snapshots.js
Full Guide:     FUND_SNAPSHOT_GUIDE.md
Implementation: SNAPSHOT_IMPLEMENTATION_SUMMARY.md
```

## What Gets Captured
✓ Timestamp (milliseconds)
✓ Event type (fill, created, recalc, etc.)
✓ Fund state (all 8 fund categories)
✓ Account totals (on-chain balances)
✓ Grid state (order counts, boundary)
✓ Invariant violations (if any)
✓ Event context (orderId, size, fee, etc.)

## Zero-Configuration Usage
```bash
1. Set logLevel: "debug" in config
2. Run bot normally
3. Snapshots auto-capture
4. Analyze anytime: node scripts/analyze_fund_snapshots.js --bot=botname
```

## Cost-Benefit
**Cost:** 10-20 MB disk per bot, < 1ms CPU
**Benefit:** Complete fund audit trail, anomaly detection, compliance record, debugging aid

## Remember
- ✅ Safe: Only captures, never modifies
- ✅ Transparent: See exactly what happens
- ✅ Automatic: Zero manual work needed
- ✅ Recoverable: Permanent record on disk
- ✅ Queryable: CLI + programmatic access
