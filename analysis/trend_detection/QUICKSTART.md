# Trend Detection - Quick Start Guide

## Overview
This system detects uptrends and downtrends using a dual AMA (Adaptive Moving Average) approach optimized for **high precision**.

## 5-Step Setup

### 1️⃣ Fetch 1-Day Market Data
```bash
cd analysis/trend_detection
node fetch_1day_candles.js
```

**Output:**
- Downloads 500 1-day candles (~1.4 years of data)
- Creates `data/XRP_BTS_SYNTHETIC_1day.json` for testing

**Duration:** ~5 seconds

---

### 2️⃣ Find Optimal AMA Parameters
```bash
node optimizer_trend_detection.js
```

**What it does:**
- Tests 450 different AMA parameter combinations
- Scores each based on accuracy: how well it detects real trends
- Prints top 10 results

**Output:** `optimization_results_trend_1day.json` + console summary

**Duration:** ~2-3 minutes

**Example output:**
```
=== TOP 10 CONFIGURATIONS ===

#1 - Score: 85.34/100
    Fast AMA: ER=40, Fast=5, Slow=15
    Slow AMA: ER=20, Fast=2, Slow=30
    Accuracy: 85.34% (Confirmed: 88.21%)
    Confirmed Signals: 187 bars
```

---

### 3️⃣ Export Interactive Chart (Optional)
```bash
node generate_trend_chart.js
```

**Output:** `chart_trend_1day_best.html`
- Open in web browser
- Visualizes price, fast AMA, and slow AMA
- Shows uptrend/downtrend regions
- Interactive zoom and hover

**Duration:** ~10 seconds

---

### 4️⃣ Backtest on Historical Data (Optional)
```bash
node backtest_trend_detection.js
```

**Output:** `backtest_report_trend_1day.txt`
- Simulates trades based on detected trends
- Shows win rate, profit factor, total return
- Lists top winning/losing trades
- Validates strategy before deployment

**Duration:** ~5 seconds

---

### 5️⃣ Deploy Best Configuration
Copy the top-ranked configuration into your bot:

```javascript
const { TrendAnalyzer } = require('./analysis/trend_detection/trend_analyzer');

const analyzer = new TrendAnalyzer({
    lookbackBars: 20,
    dualAMAConfig: {
        // From optimizer result #1
        fastErPeriod: 40,
        fastFastPeriod: 5,
        fastSlowPeriod: 15,
        slowErPeriod: 20,
        slowFastPeriod: 2,
        slowSlowPeriod: 30,
    }
});
```

---

## Usage in Your Bot

### Simple Trend Check
```javascript
// Feed new price
const analysis = analyzer.update(price);

// Check trend
if (analyzer.isUptrend()) {
    console.log('Confirmed uptrend, confidence:', analysis.confidence);
    // Execute uptrend strategy
}

if (analyzer.isDowntrend()) {
    console.log('Confirmed downtrend, confidence:', analysis.confidence);
    // Execute downtrend strategy
}

if (analyzer.isNeutral()) {
    console.log('Neutral - no confirmed trend');
    // Hold or use neutral strategy
}
```

### Detailed Analysis
```javascript
const analysis = analyzer.getAnalysis();
// Returns: {
//   trend: 'UP' | 'DOWN' | 'NEUTRAL',
//   confidence: 0-100,
//   isConfirmed: boolean,
//   barsInTrend: number,
//   amaSeparation: { percent: number },
//   priceAnalysis: { distance, percentFromAMA },
//   oscillation: { ratio, description }
// }
```

---

## Key Concepts

### Trend Confirmation
A trend is confirmed only when:
1. ✅ Fast AMA crosses slow AMA
2. ✅ At least 1% separation between AMAs
3. ✅ Sustained for 3+ consecutive bars

**Result:** High precision, fewer false signals

### Confidence Score (0-100)
Based on AMA separation:
- 1% separation → 20% confidence
- 5% separation → 100% confidence

**Usage:** Higher confidence = stronger trend signal

### Oscillation Ratio
Tells you about market conditions:
- `< 1%`: Very tight (ideal for grid)
- `< 5%`: Normal trading range
- `> 10%`: Highly volatile

---

## Directory Structure

```
analysis/trend_detection/
├── dual_ama.js                      # Core trend engine
├── price_ratio.js                   # Price analysis
├── trend_analyzer.js                # Main interface (use this!)
├── fetch_1day_candles.js            # Data fetcher
├── optimizer_trend_detection.js     # Parameter optimizer
├── README.md                        # Full documentation
├── QUICKSTART.md                    # This file
├── data/
│   ├── XRP_USDT_1day.json
│   ├── BTS_USDT_1day.json
│   └── XRP_BTS_SYNTHETIC_1day.json
├── optimization_results_trend_1day.json  # Optimizer results
└── tests/
    └── test_trend_analyzer.js       # Test examples
```

---

## Testing

Run the included test to see the system in action:

```bash
node tests/test_trend_analyzer.js
```

Simulates uptrend and downtrend scenarios with full output.

---

## Optimization Results Explained

### Field Meanings
- **Score**: Overall accuracy (0-100), higher is better
- **Accuracy**: % of correct trend detections
- **Confirmed Accuracy**: Accuracy for confirmed signals only
- **Confirmed Signals**: Number of bars with confirmed trend
- **Trend Changes**: How many times trend switched

### Choosing Between Results
- **Highest Score**: Most accurate overall
- **Highest Confirmed Accuracy**: Best for confirmed signals
- **Most Confirmed Signals**: Most trading opportunities

**Recommendation:** Start with highest overall score (#1), then test in your bot.

---

## When to Reoptimize

Rerun optimization when:
- ✅ Market behavior changes significantly
- ✅ You want to test new trading pairs
- ✅ Monthly maintenance routine

```bash
node fetch_1day_candles.js
node optimizer_trend_detection.js
```

---

## Troubleshooting

### "Data file not found"
Run: `node fetch_1day_candles.js`

### Optimizer takes too long
- Normal: 2-3 minutes for 450 combinations
- If longer, check your system resources

### Trend keeps switching rapidly
- Reduce fast AMA responsiveness (increase fastErPeriod)
- Increase minimum bars for confirmation (modify dual_ama.js)

### Not detecting trends
- Check optimizer results - might need different parameters
- Verify data is loading correctly
- Ensure analyzer has warmed up (50+ candles)

---

## Advanced: Custom Parameters

To test specific parameters without running full optimization:

```javascript
const { TrendAnalyzer } = require('./trend_analyzer');

const custom = new TrendAnalyzer({
    dualAMAConfig: {
        fastErPeriod: 30,    // Your custom values
        fastFastPeriod: 4,
        fastSlowPeriod: 12,
        slowErPeriod: 15,
        slowFastPeriod: 2,
        slowSlowPeriod: 25,
    }
});

// Test with your data
for (const price of prices) {
    const analysis = custom.update(price);
    if (analysis.isReady) {
        console.log(analysis.trend);
    }
}
```

---

## Next Steps

1. ✅ Run `fetch_1day_candles.js` to get data
2. ✅ Run `optimizer_trend_detection.js` to find best parameters
3. ✅ Run `generate_trend_chart.js` to visualize the dual AMAs
4. ✅ Open `chart_trend_1day_best.html` in your browser to review
5. ✅ Run `backtest_trend_detection.js` to validate on historical data
6. ✅ Review `backtest_report_trend_1day.txt` for performance metrics
7. ✅ Note the #1 configuration parameters
8. ✅ Update your bot with those parameters
9. ✅ Test the bot in live trading
10. ✅ Reoptimize monthly for improvements

---

## Support

- Check `README.md` for full documentation
- See `tests/test_trend_analyzer.js` for usage examples
- Review `optimization_results_trend_1day.json` for detailed results
