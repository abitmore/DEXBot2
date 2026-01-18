# Trend Detection System

High-precision trend detection using dual AMA (Adaptive Moving Average) system optimized to be **right, not fast**.

## Overview

The system detects up/downtrends with high confidence by comparing two AMAs operating at different speeds:
- **Fast AMA**: Quick response to price changes (ER=40, Fast=5, Slow=15)
- **Slow AMA**: Longer-term trend confirmation (ER=20, Fast=2, Slow=30)

A confirmed trend requires:
1. Fast AMA crosses slow AMA
2. Minimum 1% separation between AMAs (high precision requirement)
3. Sustained for 3+ consecutive bars (confirmation requirement)

## Architecture

```
analysis/trend_detection/
├── dual_ama.js           # Fast + Slow AMA comparison engine
├── price_ratio.js        # Price position/oscillation analysis
├── trend_analyzer.js     # Main interface (use this!)
├── README.md
└── tests/
    └── test_trend_analyzer.js
```

## Quick Start

### Basic Usage

```javascript
const { TrendAnalyzer } = require('./analysis/trend_detection/trend_analyzer');

// Create analyzer
const analyzer = new TrendAnalyzer({
    lookbackBars: 20,  // For price ratio analysis
});

// Feed price data
for (const price of prices) {
    const analysis = analyzer.update(price);

    // Simple trend check
    if (analyzer.isUptrend()) {
        console.log('Confirmed uptrend, confidence:', analysis.confidence);
    }
    if (analyzer.isDowntrend()) {
        console.log('Confirmed downtrend, confidence:', analysis.confidence);
    }
}
```

### Available Methods

#### Simple Status Checks
```javascript
analyzer.isUptrend()    // boolean - confirmed uptrend
analyzer.isDowntrend()  // boolean - confirmed downtrend
analyzer.isNeutral()    // boolean - no confirmed trend
```

#### Trend Analysis
```javascript
const analysis = analyzer.getAnalysis();
// Returns: {
//   trend: 'UP' | 'DOWN' | 'NEUTRAL',
//   confidence: 0-100,
//   isConfirmed: boolean,
//   rawTrend: direction before confirmation,
//   barsInTrend: number of bars in current trend,
//   amaSeparation: { percent: number },
//   priceAnalysis: { distance, percentFromAMA, isAboveAMA },
//   oscillation: { ratio, description }
// }

// Or simpler version
const simple = analyzer.getSimpleTrend();
// Returns: { trend, confidence, isReady }
```

#### Detailed Analysis
```javascript
const snapshot = analyzer.getFullSnapshot();
// Complete state including:
// - Exact AMA values
// - Price range analysis
// - Oscillation metrics
// - Configuration used
```

## Key Concepts

### Trend Confirmation
A trend is **confirmed** only when:
1. **Crossover**: Fast AMA crosses slow AMA
2. **Separation**: At least 1% distance between fast and slow AMA
3. **Sustainability**: Trend held for 3+ consecutive bars

This conservative approach ensures high accuracy.

### Confidence Score (0-100)
Based on AMA separation percentage:
- 1% separation = 20% confidence
- 5% separation = 100% confidence
- Linear interpolation between

Higher separation = stronger trend = higher confidence.

### Oscillation Ratio
Ratio of price range to AMA center value:
- `< 1%`: Very tight (ideal for grid trading)
- `< 3%`: Tight (good for grid trading)
- `< 5%`: Normal (moderate range)
- `< 10%`: Wide (choppy market)
- `> 10%`: Very wide (highly volatile)

Useful for determining grid width and safety margins.

### Price Analysis
- **Distance from AMA**: How far current price is from slow AMA
- **Position in range**: Where price sits between min/max of lookback window
- **Moving toward AMA**: Whether price is converging to or diverging from AMA

## Configuration

### Default Configuration
```javascript
new TrendAnalyzer({
    lookbackBars: 20,  // Bars for price ratio analysis

    dualAMAConfig: {
        // Fast AMA (quick response)
        fastErPeriod: 40,      // ER lookback
        fastFastPeriod: 5,     // Fast smoothing
        fastSlowPeriod: 15,    // Slow smoothing

        // Slow AMA (trend confirmation)
        slowErPeriod: 20,      // ER lookback
        slowFastPeriod: 2,     // Fast smoothing
        slowSlowPeriod: 30,    // Slow smoothing
    }
})
```

### Customization
Adjust parameters to balance responsiveness vs. accuracy:
- Higher `erPeriod` = more stable, less noise
- Lower `fastPeriod` = quicker adaptation to trends
- Higher `slowPeriod` = slower, more reliable trend confirmation

## Performance Notes

### Warmup Period
System requires **50 candles** to warm up before providing reliable signals. During warmup, `isReady: false`.

### Precision
All price values stored with 6 decimal places for precision.

## Testing

Run the test to see system in action:

```bash
node analysis/trend_detection/tests/test_trend_analyzer.js
```

Tests simulate uptrend and downtrend scenarios with full output.

## Integration with Bot

The trend analyzer can be integrated into the main bot to:
1. Detect market direction (uptrend vs downtrend)
2. Adjust strategy based on trend (different grids for different trends)
3. Skip trades in neutral conditions
4. Monitor trend changes for rebalancing

Example integration:
```javascript
const trendAnalyzer = new TrendAnalyzer();

// In main trading loop
function onNewCandle(price) {
    const trend = trendAnalyzer.update(price);

    if (trend.isReady) {
        if (analyzer.isUptrend()) {
            // Use uptrend strategy
        } else if (analyzer.isDowntrend()) {
            // Use downtrend strategy
        } else {
            // Neutral - hold or reduced trading
        }
    }
}
```

## Future Refinements

Once core system is validated and working:
- Add weight fitting for multi-signal combination
- Implement momentum indicators
- Add volume-based confirmation
- Optimize parameters per trading pair
- Add trend strength scoring

## Backtest Trend Detection

Validate the trend detection system by backtesting on historical data:

```bash
node backtest_trend_detection.js
```

**Output:** `backtest_report_trend_1day.txt` + `backtest_results_trend_1day.json`

**What You Get:**
- Trade-by-trade simulation of trend signals
- Win rate, profit factor, total return
- Top winning and losing trades
- Trade duration statistics
- Detailed performance metrics

**Example Results:**
```
Total Trades: 6
Win Rate: 50%
Profit Factor: 10.12
Total Return: 431.56%
Avg Win: 159.63%
Avg Loss: -15.78%
```

**Interpretation:**
- **Profit Factor > 2**: System is profitable (this shows 10.12 - excellent!)
- **Win Rate**: % of profitable trades (50% is acceptable with high profit factor)
- **Total Return**: Cumulative profit over backtest period
- **Avg Win/Loss**: Asymmetry shows risk/reward quality

---

## Interactive Chart Export

Generate an interactive HTML chart to visualize the best dual AMA configuration:

```bash
node generate_trend_chart.js
```

**Output:** `chart_trend_1day_best.html`

**What You See:**
- Price candlesticks (green = up, red = down)
- **Yellow line**: Slow AMA (center/confirmation - thick)
- **Cyan line**: Fast AMA (responsive - thin dotted)
- **Colored regions**: Uptrend (green) / Downtrend (red) / Neutral (gray)
- **Left panel**: Configuration details and parameters
- **Right panel**: Detection statistics and results

**Features:**
- Hover over candlesticks for exact price values
- Hover over AMAs for their values
- Zoom by dragging, pan by shift-dragging
- Click legend items to toggle visibility
- Responsive design - works on any screen size

**How to Use:**
1. Open `chart_trend_1day_best.html` in your web browser
2. Review how the AMAs tracked the price
3. Check if trend signals match visual market behavior
4. Verify confidence levels make sense
5. If satisfied, deploy the configuration

---

## Optimization Workflow

### Step 1: Fetch 1-Day Candles
Fetch fresh market data for parameter optimization:

```bash
node analysis/trend_detection/fetch_1day_candles.js
```

Output:
- `data/XRP_USDT_1day.json` - 500 XRP/USDT 1-day candles
- `data/BTS_USDT_1day.json` - 500 BTS/USDT 1-day candles
- `data/XRP_BTS_SYNTHETIC_1day.json` - Synthetic XRP/BTS pair

### Step 2: Run Trend Detection Optimizer
Test different AMA parameter combinations to find optimal settings:

```bash
node analysis/trend_detection/optimizer_trend_detection.js
```

Tests all combinations of:
- Fast AMA: ER=[10-50], Fast=[2-5], Slow=[10-30]
- Slow AMA: ER=[10-30], Fast=[2-3], Slow=[20-30]

Output: `optimization_results_trend_1day.json`
- Ranked by accuracy score
- Shows top 10 configurations
- Metrics: accuracy, confirmed accuracy, signal count

### Step 3: Review Results
Top configurations are printed to console:
```
#1 - Score: 85.34/100
    Fast AMA: ER=40, Fast=5, Slow=15
    Slow AMA: ER=20, Fast=2, Slow=30
    Accuracy: 85.34% (Confirmed: 88.21%)
```

### Step 3.5: Export Interactive Chart
Visualize the best configuration on your market data:

```bash
node generate_trend_chart.js
```

Output: `chart_trend_1day_best.html`
- Open in web browser
- Shows price + fast AMA + slow AMA
- Highlights uptrend/downtrend regions
- Interactive zoom and hover details

### Step 4: Deploy Best Configuration
Once you identify the best configuration, update `trend_analyzer.js`:

```javascript
new TrendAnalyzer({
    lookbackBars: 20,
    dualAMAConfig: {
        // Use best Fast AMA from optimization
        fastErPeriod: 40,
        fastFastPeriod: 5,
        fastSlowPeriod: 15,
        // Use best Slow AMA from optimization
        slowErPeriod: 20,
        slowFastPeriod: 2,
        slowSlowPeriod: 30,
    }
});
```

### Monthly Reoptimization
For continuous improvement, rerun optimization monthly:

```bash
# 1. Fetch fresh data
node fetch_1day_candles.js

# 2. Run optimizer
node optimizer_trend_detection.js

# 3. Generate chart to visualize the best configuration
node generate_trend_chart.js

# 4. Open chart_trend_1day_best.html in browser to review

# 5. Backtest the configuration on historical data
node backtest_trend_detection.js

# 6. Check backtest_report_trend_1day.txt for performance metrics

# 7. Review top results and deploy if improved
```

## Files in This Directory

### Core Modules
- `dual_ama.js` - Fast & Slow AMA engine
- `price_ratio.js` - Price position analysis
- `trend_analyzer.js` - Main interface (use this!)

### Tools
- `fetch_1day_candles.js` - Fetch market data (1-day candles)
- `optimizer_trend_detection.js` - Parameter optimization engine
- `generate_trend_chart.js` - Generate interactive visualization of best configuration
- `backtest_trend_detection.js` - Backtest configuration on historical data

### Data (in `/data`)
- `XRP_USDT_1day.json` - 500 1-day XRP/USDT candles
- `BTS_USDT_1day.json` - 500 1-day BTS/USDT candles
- `XRP_BTS_SYNTHETIC_1day.json` - Synthetic pair (500 days ~1.4 years)

### Results
- `optimization_results_trend_1day.json` - All tested configurations ranked
- `chart_trend_1day_best.html` - Interactive visualization of best configuration (generated)
- `backtest_report_trend_1day.txt` - Backtest performance report (generated)
- `backtest_results_trend_1day.json` - Detailed backtest data (generated)

### Tests
- `tests/test_trend_analyzer.js` - Usage examples and testing

## Related Files

- `analysis/ama_fitting/` - Center price AMA optimization (4-hour candles)
- `modules/order/strategy.js` - Current trading strategy
- `modules/order/grid.js` - Grid generation (could use trend data)
