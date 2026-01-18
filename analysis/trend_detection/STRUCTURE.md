# Trend Detection Directory Structure

## Core Modules (Production Ready)
```
dual_ama.js              # Fast + Slow AMA comparison engine
price_ratio.js           # Price position/oscillation analysis
trend_analyzer.js        # Main interface - USE THIS!
```

## Tools (Run these in order)
```
1. fetch_1day_candles.js          # Fetch 1-day market data from MEXC
   Output: data/XRP_USDT_1day.json, data/BTS_USDT_1day.json, data/XRP_BTS_SYNTHETIC_1day.json

2. optimizer_trend_detection.js   # Test 6240 parameter combinations
   Output: optimization_results_trend_1day.json

3. validator_median_trend.js      # Validate against median-based trends
   (Optional - for detailed analysis)

4. generate_trend_chart.js        # Visualize best configuration
   Output: chart_trend_1day_best.html (open in browser!)

5. backtest_trend_detection.js    # Backtest on historical data
   Output: backtest_report_trend_1day.txt, backtest_results_trend_1day.json
```

## Documentation
```
README.md                # Full documentation and API reference
QUICKSTART.md            # 5-step quick start guide
STRUCTURE.md             # This file
package.json             # NPM configuration with scripts
```

## Testing
```
tests/test_trend_analyzer.js  # Usage examples and tests
```

## Generated Files (Git Ignored - Regenerate When Needed)
```
data/
├── XRP_USDT_1day.json              (regenerate: node fetch_1day_candles.js)
├── BTS_USDT_1day.json              (regenerate: node fetch_1day_candles.js)
└── XRP_BTS_SYNTHETIC_1day.json     (regenerate: node fetch_1day_candles.js)

optimization_results_trend_1day.json (regenerate: node optimizer_trend_detection.js)
chart_trend_1day_best.html          (regenerate: node generate_trend_chart.js)
backtest_report_trend_1day.txt      (regenerate: node backtest_trend_detection.js)
backtest_results_trend_1day.json    (regenerate: node backtest_trend_detection.js)
```

## Quick Commands

### One-Time Setup
```bash
npm run fetch      # Download 1-day candle data
```

### Optimization & Testing
```bash
npm run optimize   # Test all parameter combinations
npm run chart      # Generate visualization
npm run backtest   # Run backtest simulation
```

### Full Workflow
```bash
npm run fetch && npm run optimize && npm run chart && npm run backtest
```

### Development
```bash
npm test           # Run test examples
```

## Clean Up

To regenerate everything from scratch:
```bash
rm -rf data/ *.json *.html *.txt  # Remove generated files
npm run fetch                      # Regenerate data
npm run optimize                   # Regenerate optimization results
npm run chart                      # Regenerate chart
npm run backtest                   # Regenerate backtest report
```

## File Sizes

- Core modules: ~15 KB (dual_ama.js, price_ratio.js, trend_analyzer.js)
- Tools: ~30 KB (fetch, optimizer, chart, backtest scripts)
- Documentation: ~20 KB (README, QUICKSTART, this file)
- Data: ~200 KB (generated, git ignored)
- Results: ~50 KB (generated, git ignored)
- Chart: ~100 KB (generated HTML, git ignored)

**Repository footprint:** ~65 KB (excluding generated files)

## What Gets Committed to Git

✅ Core modules (production code)
✅ Tools (reproducible scripts)
✅ Documentation (guides)
✅ Tests (examples)
✅ Configuration (package.json)
✅ .gitignore (prevents data commit)

❌ Generated data files (regenerable)
❌ Optimization results (regenerable)
❌ Charts (regenerable)
❌ Backtest reports (regenerable)

## Workflow for Continuous Improvement

Monthly:
```bash
# 1. Get fresh data
npm run fetch

# 2. Find new optimal parameters
npm run optimize

# 3. Visualize results
npm run chart
# Open chart_trend_1day_best.html in browser

# 4. Validate performance
npm run backtest
# Review backtest_report_trend_1day.txt

# 5. If improved, deploy new configuration
```
