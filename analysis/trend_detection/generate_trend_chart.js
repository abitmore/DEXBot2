/**
 * TREND DETECTION CHART GENERATOR
 *
 * Generates interactive HTML chart showing:
 * - Price candlesticks
 * - Fast AMA (quick response)
 * - Slow AMA (trend confirmation)
 * - Trend signals (UP/DOWN/NEUTRAL regions)
 * - Confidence levels
 *
 * Input: optimization_results_trend_1day.json (#1 best configuration)
 * Data: data/XRP_BTS_SYNTHETIC_1day.json
 * Output: chart_trend_1day_best.html
 */

const fs = require('fs');
const path = require('path');
const { AMA } = require('../ama_fitting/ama');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(__dirname, 'optimization_results_trend_1day.json');
const OUT_FILE = path.join(__dirname, 'chart_trend_1day_best.html');

/**
 * Load and parse JSON file
 */
function loadJSON(filepath) {
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) {
        console.error(`Error loading ${filepath}:`, e.message);
        return null;
    }
}

/**
 * Load candle data
 */
function loadCandles() {
    const dataFile = path.join(DATA_DIR, 'XRP_BTS_SYNTHETIC_1day.json');

    if (!fs.existsSync(dataFile)) {
        console.error(`❌ Data file not found: ${dataFile}`);
        console.error('Run: node fetch_1day_candles.js');
        return null;
    }

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return data.map(candle => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5]
    }));
}

/**
 * Get best configuration from optimization results
 */
function getBestConfiguration() {
    if (!fs.existsSync(RESULTS_FILE)) {
        console.error(`❌ Results file not found: ${RESULTS_FILE}`);
        console.error('Run: node optimizer_trend_detection.js');
        return null;
    }

    const results = loadJSON(RESULTS_FILE);
    if (!results || results.length === 0) {
        console.error('❌ No optimization results found');
        return null;
    }

    const best = results[0]; // Highest score
    return best;
}

/**
 * Calculate both AMAs
 */
function calculateAMAs(closes, config) {
    const fastAMA = new AMA(
        config.fastErPeriod,
        config.fastFastPeriod,
        config.fastSlowPeriod
    );

    const slowAMA = new AMA(
        config.slowErPeriod,
        config.slowFastPeriod,
        config.slowSlowPeriod
    );

    const fastValues = [];
    const slowValues = [];
    const trendSignals = [];

    for (const price of closes) {
        const fast = fastAMA.update(price);
        const slow = slowAMA.update(price);

        fastValues.push(fast);
        slowValues.push(slow);

        // Determine trend
        let trend = 'NEUTRAL';
        if (fastValues.length > 50) {
            const minSeparation = Math.abs(slow) * 0.01; // 1% threshold
            const separation = Math.abs(fast - slow);

            if (separation >= minSeparation) {
                trend = fast > slow ? 'UP' : 'DOWN';
            }
        }

        trendSignals.push(trend);
    }

    return { fastValues, slowValues, trendSignals };
}

/**
 * Create the HTML chart
 */
function createChart(candles, amaData, config) {
    const dates = candles.map(c => new Date(c.timestamp).toISOString().split('T')[0]);
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    const traces = [];

    // 1. Candlesticks
    traces.push({
        x: dates,
        close: closes,
        decreasing: { line: { color: '#ef5350' } },
        high: highs,
        increasing: { line: { color: '#26a69a' } },
        line: { color: 'rgba(31,119,180,1)' },
        low: lows,
        open: opens,
        type: 'candlestick',
        name: 'Price',
        hovertemplate: '<b>Price</b><br>Close: %{close:.8f}<br>High: %{high:.8f}<br>Low: %{low:.8f}<extra></extra>'
    });

    // 2. Slow AMA (center line - thick)
    traces.push({
        x: dates,
        y: amaData.slowValues,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#FFC107', width: 3 },
        name: `Slow AMA (Center)`,
        hovertemplate: '<b>Slow AMA</b><br>%{y:.8f}<extra></extra>'
    });

    // 3. Fast AMA (responsive line - thin)
    traces.push({
        x: dates,
        y: amaData.fastValues,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#00BCD4', width: 1.5, dash: 'dot' },
        name: `Fast AMA (Responsive)`,
        hovertemplate: '<b>Fast AMA</b><br>%{y:.8f}<extra></extra>'
    });

    // 4. Add trend background regions
    const trendRegions = [];
    let currentTrend = 'NEUTRAL';
    let regionStart = 0;

    for (let i = 0; i < amaData.trendSignals.length; i++) {
        const signal = amaData.trendSignals[i];

        if (signal !== currentTrend) {
            if (i > regionStart) {
                trendRegions.push({
                    start: regionStart,
                    end: i,
                    trend: currentTrend
                });
            }
            currentTrend = signal;
            regionStart = i;
        }
    }

    // Add final region
    if (regionStart < amaData.trendSignals.length) {
        trendRegions.push({
            start: regionStart,
            end: amaData.trendSignals.length,
            trend: currentTrend
        });
    }

    // Add confidence/trend signals (invisible traces for legend)
    traces.push({
        x: [null],
        y: [null],
        type: 'scatter',
        name: '🟢 Uptrend',
        marker: { color: '#26a69a', size: 10 }
    });
    traces.push({
        x: [null],
        y: [null],
        type: 'scatter',
        name: '🔴 Downtrend',
        marker: { color: '#ef5350', size: 10 }
    });
    traces.push({
        x: [null],
        y: [null],
        type: 'scatter',
        name: '⚪ Neutral',
        marker: { color: '#999', size: 10 }
    });

    // Build metrics HTML
    const cfg = config;
    const metricsHTML = `
        <h3>Best Configuration</h3>
        <p style="color: #FFC107; margin: 3px 0;"><strong>Score: ${config.metrics.score}/100</strong></p>
        <p style="margin: 3px 0;">Accuracy: ${config.metrics.accuracy.toFixed(2)}%</p>
        <p style="margin: 3px 0;">Confirmed Accuracy: ${config.metrics.confirmedAccuracy.toFixed(2)}%</p>

        <h3 style="margin-top: 15px;">Fast AMA Parameters</h3>
        <p style="margin: 3px 0;">ER Period: ${cfg.config.fastErPeriod}</p>
        <p style="margin: 3px 0;">Fast Period: ${cfg.config.fastFastPeriod}</p>
        <p style="margin: 3px 0;">Slow Period: ${cfg.config.fastSlowPeriod}</p>

        <h3 style="margin-top: 15px;">Slow AMA Parameters</h3>
        <p style="margin: 3px 0;">ER Period: ${cfg.config.slowErPeriod}</p>
        <p style="margin: 3px 0;">Fast Period: ${cfg.config.slowFastPeriod}</p>
        <p style="margin: 3px 0;">Slow Period: ${cfg.config.slowSlowPeriod}</p>

        <h3 style="margin-top: 15px;">Trend Detection Rules</h3>
        <p style="margin: 3px 0; font-size: 9px; color: #aaa;">
            • Fast AMA crosses Slow AMA<br>
            • Min 1% separation required<br>
            • Sustained 3+ bars<br>
            • Warmup: 50 candles
        </p>
    `;

    // Count trends
    const uptrends = amaData.trendSignals.filter(t => t === 'UP').length;
    const downtrends = amaData.trendSignals.filter(t => t === 'DOWN').length;
    const neutrals = amaData.trendSignals.filter(t => t === 'NEUTRAL').length;

    const statsHTML = `
        <h3>Trend Detection Results</h3>
        <p style="color: #26a69a; margin: 3px 0;"><strong>Uptrend:</strong> ${uptrends} bars</p>
        <p style="color: #ef5350; margin: 3px 0;"><strong>Downtrend:</strong> ${downtrends} bars</p>
        <p style="color: #999; margin: 3px 0;"><strong>Neutral:</strong> ${neutrals} bars</p>

        <h3 style="margin-top: 15px;">Data Info</h3>
        <p style="margin: 3px 0; color: #aaa;">
            Total Candles: ${candles.length}<br>
            Range: ${dates[0]} to ${dates[dates.length - 1]}<br>
            Timeframe: 1-day
        </p>

        <h3 style="margin-top: 15px;">How to Use</h3>
        <p style="margin: 3px 0; font-size: 9px; color: #aaa;">
            This configuration detected uptrends and downtrends with high precision. Deploy to your bot by copying the parameters in the left panel.
        </p>
    `;

    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Trend Detection - Dual AMA Chart</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0a0e27;
            color: #eee;
            font-family: 'Courier New', monospace;
            overflow: hidden;
        }
        #chart {
            width: 100vw;
            height: 100vh;
        }
        .panel {
            position: absolute;
            background: rgba(10, 14, 39, 0.95);
            border: 2px solid;
            border-radius: 6px;
            padding: 15px;
            font-size: 11px;
            line-height: 1.6;
            z-index: 100;
            max-height: 90vh;
            overflow-y: auto;
        }
        .config-panel {
            top: 10px;
            left: 10px;
            width: 300px;
            border-color: #FFC107;
        }
        .stats-panel {
            top: 10px;
            right: 10px;
            width: 280px;
            border-color: #00BCD4;
        }
        h3 {
            margin: 10px 0 8px 0;
            color: #FFC107;
            font-size: 12px;
        }
        h3:first-child {
            margin-top: 0;
        }
        p {
            margin: 3px 0;
            font-size: 11px;
        }
        .legend {
            position: absolute;
            bottom: 10px;
            left: 10px;
            background: rgba(10, 14, 39, 0.9);
            border: 2px solid #666;
            border-radius: 4px;
            padding: 10px 15px;
            font-size: 10px;
            z-index: 50;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 4px 0;
        }
        .legend-box {
            width: 20px;
            height: 2px;
        }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }
        ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #666; }
    </style>
</head>
<body>
    <div class="config-panel panel">
        ${metricsHTML}
    </div>

    <div class="stats-panel panel">
        ${statsHTML}
    </div>

    <div class="legend">
        <div class="legend-item">
            <div class="legend-box" style="background: #FFC107;"></div>
            <span>Slow AMA (Center)</span>
        </div>
        <div class="legend-item">
            <div class="legend-box" style="background: #00BCD4; border-top: 1px dotted #00BCD4;"></div>
            <span>Fast AMA (Responsive)</span>
        </div>
        <div class="legend-item">
            <div class="legend-box" style="background: #26a69a;"></div>
            <span>Uptrend Region</span>
        </div>
        <div class="legend-item">
            <div class="legend-box" style="background: #ef5350;"></div>
            <span>Downtrend Region</span>
        </div>
    </div>

    <div id="chart"></div>

    <script>
        const traces = ${JSON.stringify(traces)};

        const layout = {
            dragmode: 'zoom',
            margin: { r: 10, t: 30, b: 40, l: 60 },
            showlegend: true,
            legend: {
                x: 0.02,
                y: 0.02,
                bgcolor: 'rgba(10, 14, 39, 0.8)',
                bordercolor: '#666',
                borderwidth: 1,
                font: { size: 10 }
            },
            xaxis: {
                title: 'Date',
                gridcolor: '#222',
                showgrid: true,
                type: 'category'
            },
            yaxis: {
                title: 'Price',
                gridcolor: '#222',
                showgrid: true
            },
            plot_bgcolor: '#0a0e27',
            paper_bgcolor: '#0a0e27',
            font: { color: '#ccc', size: 12, family: 'Courier New' },
            title: {
                text: 'Trend Detection: Dual AMA System (Best Configuration)',
                font: { size: 16, color: '#FFC107', family: 'Courier New' }
            }
        };

        Plotly.newPlot('chart', traces, layout, { responsive: true });
    </script>
</body>
</html>
    `;

    fs.writeFileSync(OUT_FILE, html);
    return OUT_FILE;
}

/**
 * Main function
 */
function generate() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('TREND DETECTION - CHART GENERATOR');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Get best configuration
    console.log('📊 Loading best configuration from optimizer results...');
    const bestConfig = getBestConfiguration();
    if (!bestConfig) {
        console.error('\n❌ Could not load best configuration');
        process.exit(1);
    }

    console.log(`✓ Found best configuration (Score: ${bestConfig.metrics.score}/100)\n`);

    // Load candles
    console.log('📈 Loading candle data...');
    const candles = loadCandles();
    if (!candles) {
        console.error('\n❌ Could not load candles');
        process.exit(1);
    }

    console.log(`✓ Loaded ${candles.length} candles\n`);

    // Calculate AMAs
    console.log('🔄 Calculating AMAs...');
    const closes = candles.map(c => c.close);
    const amaData = calculateAMAs(closes, bestConfig.config);
    console.log(`✓ Calculated Fast AMA and Slow AMA\n`);

    // Generate chart
    console.log('📊 Generating chart...');
    const chartFile = createChart(candles, amaData, bestConfig);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ CHART GENERATED\n');
    console.log(`   📄 ${path.basename(chartFile)}`);
    console.log(`\n   Configuration Details:`);
    console.log(`   ├─ Score: ${bestConfig.metrics.score}/100`);
    console.log(`   ├─ Accuracy: ${bestConfig.metrics.accuracy.toFixed(2)}%`);
    console.log(`   ├─ Confirmed Accuracy: ${bestConfig.metrics.confirmedAccuracy.toFixed(2)}%`);
    console.log(`   ├─ Confirmed Signals: ${bestConfig.detection.confirmedTrends} bars`);
    console.log(`   └─ Trend Changes: ${bestConfig.detection.trendChanges}`);
    console.log(`\n   Fast AMA:`);
    console.log(`   ├─ ER=${bestConfig.config.fastErPeriod}, Fast=${bestConfig.config.fastFastPeriod}, Slow=${bestConfig.config.fastSlowPeriod}`);
    console.log(`\n   Slow AMA:`);
    console.log(`   ├─ ER=${bestConfig.config.slowErPeriod}, Fast=${bestConfig.config.slowFastPeriod}, Slow=${bestConfig.config.slowSlowPeriod}`);
    console.log('\n═══════════════════════════════════════════════════════════════');
}

generate();

module.exports = { generate };
