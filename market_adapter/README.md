# Market Adapter

## Overview

The **Market Adapter** is the real-time decision engine that continuously monitors current market activity and automatically adjusts bot configurations in `bots.json` to optimize performance under changing market conditions.

**Core Purpose**: Bridge the gap between historical analysis (in `/analysis`) and live trading—translating market insights into actionable bot parameter updates.

---

## Architecture

### Relationship to Other Components

```
analysis/                    market_adapter/              bot execution
─────────────────           ──────────────────           ────────────
ama_fitting/      ──┐
(history tools)   ──├─→ [Market Analysis] ──→ [Decision Engine] ──→ bots.json ──→ dexbot.js
sensitivity/      ──┤    (current market)     (real-time rules)
spread_analysis/  ──┘
```

**Data Flow**:
1. **analysis/** generates optimal parameter ranges based on historical backtest data
2. **market_adapter/** monitors live market conditions (volatility, trending, range-bound)
3. **market_adapter/** applies decision rules to select appropriate parameters from analysis results
4. **market_adapter/** updates `profiles/bots.json` when parameters should change
5. **dexbot.js** reads the updated configuration and applies changes to running bots

---

## Scope

### Responsibilities

#### ✅ In Scope
- **Real-time Market Monitoring**: Track current volatility, price action, and market regime
- **Condition Detection**: Identify trending, ranging, volatile, or stable market conditions
- **Parameter Selection**: Choose appropriate AMA/grid settings based on current conditions
- **Configuration Updates**: Safely modify `bots.json` when market conditions warrant it
- **Change Logging**: Track which parameters changed, when, and why
- **State Management**: Maintain history of adaptations for analysis and rollback

#### ❌ Out of Scope
- Historical backtest optimization (that's `/analysis`)
- Direct order placement or execution (that's `dexbot.js`)
- Bot lifecycle management (start/stop/restart)
- Long-term strategy design or rule creation

---

## Configuration Structure

### Market Adaptation Rules

The adapter uses rules defined in configuration files to determine when/how to adapt:

```javascript
{
  "marketConditions": [
    {
      "name": "trending",
      "volatilityRange": [0.5, 100],      // % price change vs MA
      "emaSlope": "positive",             // trend direction
      "gridSpacing": 0.9,                 // recommended spacing
      "erPeriod": 12,
      "fastSmoothing": 2,
      "slowSmoothing": 18
    },
    {
      "name": "ranging",
      "volatilityRange": [0.1, 0.5],
      "emaSlope": "flat",
      "gridSpacing": 0.7,
      "erPeriod": 8,
      "fastSmoothing": 2,
      "slowSmoothing": 12
    },
    {
      "name": "volatile",
      "volatilityRange": [0.7, 100],
      "emaSlope": "any",
      "gridSpacing": 0.95,
      "erPeriod": 15,
      "fastSmoothing": 2,
      "slowSmoothing": 20
    }
  ],
  "changeThresholds": {
    "minTimeBetweenUpdates": 3600000,     // 1 hour in ms
    "confidenceRequired": 0.75,           // 75% confidence before changing
    "maxChangesPerDay": 4                 // safety limit
  }
}
```

---

## Module Structure

```
market_adapter/
├── README.md                    (this file)
├── market_monitor.js           # Real-time market data collection
├── condition_detector.js        # Identify current market regime
├── parameter_selector.js        # Choose parameters based on conditions
├── config_updater.js            # Safely update bots.json
├── change_logger.js             # Log all adaptations for audit trail
├── config/
│   ├── adaptation_rules.json   # Market condition → parameter mapping
│   └── safety_limits.json      # Update frequency, max changes, etc.
├── history/                     # Archive of past adaptations
│   └── adaptations.log         # Timestamped log of all changes
└── tests/
    ├── market_monitor.test.js
    ├── condition_detector.test.js
    └── integration.test.js
```

---

## How It Works

### 1. Market Monitoring (Every X seconds/minutes)

```javascript
const marketData = await marketMonitor.fetchCurrent();
// Returns: { price, volatility, volumeProfile, trendStrength, ... }
```

**Collects**:
- Current price and price history (last N candles)
- Trading volume
- Bid/ask spreads
- Price momentum (EMA slope)

### 2. Condition Detection

```javascript
const condition = conditionDetector.analyze(marketData);
// Returns: { regime: "trending|ranging|volatile", confidence: 0.75, reason: "..." }
```

**Determines**:
- Market regime (trending, ranging, volatile, or calm)
- Confidence level based on multiple indicators
- Relevant factors driving the detection

### 3. Parameter Selection

```javascript
const params = parameterSelector.getParameters(condition);
// Returns: { gridSpacing: 0.8, erPeriod: 10, fastSmoothing: 2, slowSmoothing: 15 }
```

**Queries**:
- Adaptation rules to find appropriate parameters
- Cross-references with `analysis/` findings
- Returns parameters with highest expected profitability

### 4. Configuration Update (If Needed)

```javascript
const updated = await configUpdater.updateBots(currentParams, newParams);
// Returns: { updated: true, changes: [...], timestamp: "2026-01-17T..." }
```

**Safety Checks**:
- Verifies file integrity
- Checks rate limits (don't update too frequently)
- Validates new parameters against limits
- Creates backup before writing
- Acquires file lock to prevent concurrent writes

### 5. Logging & Audit Trail

```javascript
changeLogger.record({
  timestamp: Date.now(),
  reason: "Detected trending market (EMA slope +2.1%)",
  previousParams: {...},
  newParams: {...},
  confidence: 0.78,
  expectedImpact: "+0.15% profit per trade"
});
```

---

## Integration Points

### Input: Market Data Sources
- **Current price data**: From BitShares blockchain API
- **Candle history**: From `/data` or real-time calculation
- **Order book**: For spread analysis
- **Recent trades**: For volume profile

### Input: Analysis Results
- **Optimal parameter sets**: From `analysis/ama_fitting/OPTIMIZATION_RESULTS.md`
- **Sensitivity data**: From `analysis/ama_fitting/SENSITIVITY_REPORT.md`
- **Regime-specific tuning**: From `analysis/ama_fitting/QUICK_REFERENCE.md`

### Output: Bot Configuration
- **Updates to `profiles/bots.json`**: Parameter changes written here
- **Change log**: `market_adapter/history/adaptations.log`
- **Metrics**: Exported for monitoring dashboards

### Integration with dexbot.js
- dexbot reads updated `bots.json` on next initialization
- Optional: Hot-reload capability for immediate application (if implemented)

---

## Decision Rules

### When to Adapt

An adaptation is triggered when:
1. **Confidence threshold met** (usually 75%+)
2. **Minimum time elapsed** since last update (default: 1 hour)
3. **Safety limits respected** (e.g., max 4 changes per day)
4. **Expected benefit > overhead** (cost of updating must justify gains)

### What NOT to Change

- **Always avoid**: Completely turning bots on/off (that's manual territory)
- **Preserve**: Bot names, account assignments, active/inactive status
- **Review manually**: Major regime shifts (trending → calm)

### Rollback Mechanism

If a parameter change underperforms:
```javascript
adapter.rollback({
  adaptation: adaptationId,
  reason: "Profit decreased by 15% in last 4 hours"
});
// Restores previous bot.json and logs the issue
```

---

## Configuration Files

### `config/adaptation_rules.json`

Defines the mapping between market conditions and recommended parameters:
- **Input**: Market condition (detected in real-time)
- **Output**: Parameter set (gridSpacing, EMA settings, etc.)
- **Source**: Results from `/analysis/ama_fitting/OPTIMIZATION_RESULTS.md`

**Example Rule**:
```json
{
  "condition": "trending",
  "trigger": {
    "volatility": { "min": 0.5, "max": 100 },
    "emaSlope": { "min": 0.01 }
  },
  "parameters": {
    "gridSpacing": 0.9,
    "erPeriod": 12,
    "targetSpreadPercent": 1.2
  },
  "expectedBenefit": "0.15% higher profit per trade",
  "notes": "Wider grid during strong trends"
}
```

### `config/safety_limits.json`

Protection rules to prevent aggressive over-adaptation:
```json
{
  "minTimeBetweenUpdates": 3600000,
  "maxChangesPerDay": 4,
  "maxParameterChangePercent": 25,
  "confidenceThreshold": 0.75,
  "rollbackIfUnderperforming": true,
  "underperformanceThreshold": -0.10
}
```

---

## Usage

### Manual Invocation

Run the adapter manually to test or force an update:

```bash
# Check current market conditions without updating
node market_adapter/market_monitor.js

# Analyze and propose changes (dry-run)
node market_adapter/condition_detector.js --dry-run

# Actually update bot config
node market_adapter/index.js --update

# View adaptation history
cat market_adapter/history/adaptations.log | tail -20
```

### Automated Execution

Schedule via PM2 or cron to run continuously:

```bash
# In pm2.js, add:
{
  name: "market-adapter",
  script: "market_adapter/index.js",
  instances: 1,
  exec_mode: "fork",
  cron_restart: "0 * * * *"  // Every hour
}
```

### Integration with dexbot

The adapter runs independently; dexbot picks up changes by:
1. Reloading `profiles/bots.json` on next initialization cycle
2. Optional: Emit events for hot-reload

---

## Monitoring & Alerts

### Key Metrics to Track

```
adaptations_total        - Total number of parameter updates
adaptations_per_condition - Updates broken down by detected regime
avg_confidence           - Average confidence of adaptations
failed_updates           - Updates that couldn't be applied
rollbacks                - How often we had to revert
```

### Alert Conditions

- ⚠️ **Rapid oscillation**: Switching parameters too frequently → increase `minTimeBetweenUpdates`
- ⚠️ **Low confidence**: Many updates below 60% → review condition detection logic
- 🔴 **Repeated rollbacks**: If same adaptation keeps failing → disable that rule
- 🔴 **Failed locks**: Can't update bots.json → check permissions and file access

---

## Example Workflow

### Scenario: Volatile Market Detected

```
[09:00] Market Monitor detects high volatility (price swinging ±2% per hour)
[09:05] Condition Detector identifies: "volatile" regime (confidence: 0.82)
[09:10] Parameter Selector recommends: gridSpacing 0.95 (vs current 0.8)
[09:15] Safety checks pass:
        - Last update: 4 hours ago ✓
        - Only 1 change today ✓
        - Confidence > 75% ✓
[09:16] Config Updater applies change to bots.json
[09:17] Change Logger records adaptation
[09:20] dexbot reloads config on next cycle
[09:21] Bots now operating with 0.95% grid spacing
[10:00] Monitor continues... market calms down
[11:00] Condition Detector identifies: "ranging" regime
        (Repeat process, revert to 0.7% spacing if appropriate)
```

---

## File Format: bots.json Changes

The adapter only modifies these fields per bot:

```json
{
  "name": "XRP-BTS",
  "active": true,  // ← NEVER changed by adapter
  "dryRun": false, // ← NEVER changed by adapter

  "incrementPercent": 0.4,          // ← CAN change
  "targetSpreadPercent": 0.8,       // ← CAN change
  "gridSpacing": 0.8,               // ← CAN change (if added)
  "erPeriod": 10,                   // ← CAN change (if added)
  "fastSmoothing": 2,               // ← CAN change (if added)
  "slowSmoothing": 15,              // ← CAN change (if added)

  "botFunds": {...},                // ← NEVER changed by adapter
  "activeOrders": {...},            // ← NEVER changed by adapter
  "preferredAccount": "..."         // ← NEVER changed by adapter
}
```

---

## Future Enhancements

### Phase 1 (MVP)
- [x] Detect market conditions (trending/ranging/volatile)
- [x] Select parameters based on conditions
- [x] Safely update bots.json
- [x] Log all changes with reasoning

### Phase 2 (Extended)
- [ ] Machine learning-based regime detection (vs rules-based)
- [ ] Multi-pair correlation analysis
- [ ] Predictive parameter selection (forecast next regime)
- [ ] A/B testing framework (test new rules safely)
- [ ] Hot-reload support (zero-downtime parameter updates)

### Phase 3 (Advanced)
- [ ] Portfolio-level optimization (balance risk across all bots)
- [ ] Cross-asset feedback loops (BTS volatility → adjust XRP parameters)
- [ ] Seasonal pattern recognition
- [ ] Integration with external news/sentiment data

---

## Troubleshooting

### Parameters not updating
1. Check `minTimeBetweenUpdates` – might be in cooldown
2. Verify `confidenceThreshold` – market signal might be weak
3. Check file lock issues: `cat market_adapter/history/adaptations.log`

### Oscillating between regimes
1. Increase `minTimeBetweenUpdates` to be more conservative
2. Review market detection logic for false positives
3. Increase `confidenceThreshold` requirement

### Changes don't take effect
1. Confirm dexbot reloaded bots.json
2. Check bot logs for initialization errors
3. Verify no permissions issues on bots.json

---

## References

- **Historical Analysis**: See `/analysis/ama_fitting/README.md` for parameter optimization details
- **Bot Configuration**: See `profiles/bots.json` for current settings
- **DEXBot Architecture**: See root `README.md` for overall bot design
- **Security**: Adaptation rules should be reviewed before deployment

---

## Contact / Contributing

For issues, enhancements, or questions about market adaptation rules, open an issue or PR with:
1. Current market conditions (volatility, regime)
2. Proposed rule or fix
3. Expected impact and testing results
