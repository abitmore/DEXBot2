const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

/**
 * UNIFIED COMPARISON CHART GENERATOR
 *
 * ⚠️  DATA: 4-HOUR CANDLES ONLY
 * Input: 500 4h candles from MEXC (XRP/USDT + BTS/USDT)
 * Output: chart_4h_UNIFIED_COMPARISON.html
 *
 * Generates ONE comprehensive chart showing all three optimization strategies:
 * 1. ER=40 (MAX AREA) - Orange solid line
 *    └─ 47.10% oscillation area (maximum opportunities)
 *
 * 2. ER=15 (MAX EFFICIENCY) - Green dotted line
 *    └─ 40.79% oscillation area, 50% fill efficiency (reliable matching)
 *
 * 3. ER=107 (BALANCED) - Blue dashed line
 *    └─ 38.85% oscillation area, 50% fill efficiency, 78.8/100 score (best balance)
 *
 * All three AMAs overlaid on same candlesticks for direct comparison
 * Includes grid bands (±max distance) for each strategy
 */

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(__dirname, 'chart_4h_UNIFIED_COMPARISON.html');

// Three optimization strategies
const STRATEGIES = [
    { name: 'MAX AREA', erPeriod: 40, fastPeriod: 5, slowPeriod: 30, color: '#fb8c00', dash: 'solid' },
    { name: 'MAX EFFICIENCY', erPeriod: 15, fastPeriod: 5, slowPeriod: 30, color: '#26a69a', dash: 'dot' },
    { name: 'BALANCED', erPeriod: 107, fastPeriod: 2, slowPeriod: 30, color: '#2196F3', dash: 'dash' }
];

// --- Helper Functions ---

function loadData(filename) {
    const raw = fs.readFileSync(path.join(DATA_DIR, filename));
    const json = JSON.parse(raw);
    return json.map(candle => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5]
    }));
}

function generateSyntheticPair(btsData, xrpData) {
    const xrpMap = new Map();
    xrpData.forEach(c => xrpMap.set(c.timestamp, c));

    const synthetic = [];
    btsData.forEach(bts => {
        const xrp = xrpMap.get(bts.timestamp);
        if (xrp) {
            const high = bts.high / xrp.low;
            const low = bts.low / xrp.high;
            const close = bts.close / xrp.close;
            const open = bts.open / xrp.open;

            synthetic.push({
                timestamp: bts.timestamp,
                open: open,
                high: high,
                low: low,
                close: close
            });
        }
    });

    return synthetic.sort((a, b) => a.timestamp - b.timestamp);
}

function calculateMetrics(amaValues, candles) {
    let maxDriftUp = 0;
    let maxDriftDown = 0;
    let areaAbove = 0;
    let areaBelow = 0;

    const skip = Math.max(20, Math.floor(candles.length * 0.1));

    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const high = candles[i].high;
        const low = candles[i].low;

        const driftUp = (high - ama) / ama;
        const driftDown = (ama - low) / ama;

        if (driftUp > maxDriftUp) maxDriftUp = driftUp;
        if (driftDown > maxDriftDown) maxDriftDown = driftDown;

        if (high > ama) areaAbove += driftUp;
        if (low < ama) areaBelow += driftDown;
    }

    return {
        maxDriftUp,
        maxDriftDown,
        areaAbove,
        areaBelow,
        totalArea: areaAbove + areaBelow,
        maxDistance: Math.max(maxDriftUp, maxDriftDown)
    };
}

function createChart(strategiesWithMetrics, candles) {
    const dates = candles.map(c => new Date(c.timestamp).toISOString());
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    // Build traces array
    const traces = [];

    // Candlesticks
    traces.push({
        x: dates,
        close: closes,
        decreasing: {line: {color: '#ef5350'}},
        high: highs,
        increasing: {line: {color: '#26a69a'}},
        line: {color: 'rgba(31,119,180,1)'},
        low: lows,
        open: opens,
        type: 'candlestick',
        xaxis: 'x',
        yaxis: 'y',
        name: 'Price',
        hovertemplate: '<b>Price</b><br>High: %{high:.8f}<br>Low: %{low:.8f}<extra></extra>'
    });

    // Add each strategy's AMA and bands
    for (const strategy of strategiesWithMetrics) {
        const bandFactor = strategy.metrics.maxDistance * 2;
        const upperBand = strategy.amaValues.map(v => v * (1 + bandFactor));
        const lowerBand = strategy.amaValues.map(v => v * (1 - bandFactor));

        // Main AMA line
        traces.push({
            x: dates,
            y: strategy.amaValues,
            type: 'scatter',
            mode: 'lines',
            line: { color: strategy.color, width: 2.5, dash: strategy.dash },
            name: `${strategy.name} (ER=${strategy.erPeriod})`,
            hovertemplate: `<b>${strategy.name}</b><br>%{y:.8f}<extra></extra>`
        });

        // Upper band
        traces.push({
            x: dates,
            y: upperBand,
            type: 'scatter',
            mode: 'lines',
            line: { color: strategy.color, width: 0.5, dash: 'dot' },
            name: `${strategy.name} Upper Band`,
            opacity: 0.3,
            showlegend: false,
            hovertemplate: `<b>${strategy.name} Upper</b><br>%{y:.8f}<extra></extra>`
        });

        // Lower band
        traces.push({
            x: dates,
            y: lowerBand,
            type: 'scatter',
            mode: 'lines',
            line: { color: strategy.color, width: 0.5, dash: 'dot' },
            name: `${strategy.name} Lower Band`,
            opacity: 0.3,
            showlegend: false,
            hovertemplate: `<b>${strategy.name} Lower</b><br>%{y:.8f}<extra></extra>`
        });
    }

    // Build metrics HTML
    let metricsHTML = '<h3>Comparison Metrics</h3>';
    for (const strategy of strategiesWithMetrics) {
        const m = strategy.metrics;
        metricsHTML += `
        <div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #333;">
            <p style="color: ${strategy.color}; font-weight: bold; margin: 5px 0;">
                ${strategy.name} (ER=${strategy.erPeriod})
            </p>
            <p style="margin: 3px 0;"><span class="metric-label">Area:</span> ${m.totalArea.toFixed(2)}%</p>
            <p style="margin: 3px 0;"><span class="metric-label">Max UP:</span> ${(m.maxDriftUp * 100).toFixed(2)}%</p>
            <p style="margin: 3px 0;"><span class="metric-label">Max DOWN:</span> ${(m.maxDriftDown * 100).toFixed(2)}%</p>
            <p style="margin: 3px 0;"><span class="metric-label">Band Factor:</span> ${(m.maxDistance * 200).toFixed(2)}%</p>
        </div>
        `;
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>XRP/BTS AMA - Unified Comparison (All 3 Strategies)</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        body { margin: 0; padding: 0; background: #111; color: #eee; font-family: monospace; }
        #chart { width: 100vw; height: 75vh; }
        .info {
            position: absolute;
            top: 10px;
            left: 10px;
            z-index: 100;
            background: rgba(0,0,0,0.85);
            padding: 15px;
            border-radius: 4px;
            border: 2px solid #fb8c00;
            max-width: 350px;
            font-size: 11px;
            line-height: 1.5;
        }
        .metrics {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 100;
            background: rgba(0,0,0,0.85);
            padding: 15px;
            border-radius: 4px;
            border: 2px solid #26a69a;
            font-size: 11px;
            line-height: 1.6;
            max-width: 300px;
            max-height: 80vh;
            overflow-y: auto;
        }
        .metric-label { color: #aaa; }
        .metric-value { color: #fff; font-weight: bold; }
        .positive { color: #26a69a; }
        .negative { color: #ef5350; }
        h3 { margin: 0 0 10px 0; color: #fb8c00; }
        .legend-info {
            display: flex;
            gap: 15px;
            margin-top: 10px;
            font-size: 10px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .legend-line {
            width: 25px;
            height: 2px;
        }
    </style>
</head>
<body>
    <div class="info">
        <h3>UNIFIED COMPARISON</h3>
        <p><strong>Three AMA Strategies Overlaid:</strong></p>
        <div class="legend-info">
            <div class="legend-item">
                <div class="legend-line" style="background: #fb8c00; border-top: 2px solid #fb8c00;"></div>
                <span>MAX AREA (ER=40)</span>
            </div>
            <div class="legend-item">
                <div class="legend-line" style="background: #26a69a; border-top: 2px dotted #26a69a;"></div>
                <span>MAX EFF (ER=15)</span>
            </div>
            <div class="legend-item">
                <div class="legend-line" style="background: #2196F3; border-top: 2px dashed #2196F3;"></div>
                <span>BALANCED (ER=107)</span>
            </div>
        </div>
        <p style="margin-top: 10px; color: #aaa;"><em>Dashed lines = grid bands (±max distance)</em></p>
    </div>

    <div class="metrics">
        ${metricsHTML}
    </div>

    <div id="chart"></div>

    <script>
        const traces = ${JSON.stringify(traces)};

        const layout = {
            dragmode: 'zoom',
            margin: {r: 10, t: 25, b: 40, l: 60},
            showlegend: true,
            legend: {
                x: 0.02,
                y: 0.98,
                bgcolor: 'rgba(0,0,0,0.5)',
                bordercolor: '#666',
                borderwidth: 1
            },
            xaxis: {
                autorange: true,
                title: 'Date',
                type: 'date',
                gridcolor: '#333'
            },
            yaxis: {
                autorange: true,
                type: 'linear',
                gridcolor: '#333'
            },
            plot_bgcolor: '#111',
            paper_bgcolor: '#111',
            font: { color: '#ccc', size: 12 },
            title: {
                text: 'XRP/BTS (MEXC) - All 3 Optimization Strategies',
                font: { size: 16, color: '#fb8c00' }
            }
        };

        Plotly.newPlot('chart', traces, layout, {responsive: true});
    </script>
</body>
</html>
    `;

    fs.writeFileSync(OUT_FILE, html);
    return OUT_FILE;
}

function run() {
    console.log("================================================================================");
    console.log("GENERATING UNIFIED COMPARISON CHART");
    console.log("================================================================================\n");

    let btsData, xrpData;
    try {
        btsData = loadData('BTS_USDT.json');
        xrpData = loadData('XRP_USDT.json');
    } catch (e) {
        console.error("Error loading data:", e.message);
        return;
    }

    const synthetic = generateSyntheticPair(btsData, xrpData);
    const closes = synthetic.map(c => c.close);

    console.log(`Loaded ${synthetic.length} candles\n`);

    // Calculate all three strategies
    const strategiesWithMetrics = [];

    for (const strategy of STRATEGIES) {
        console.log(`📊 Calculating ${strategy.name} (ER=${strategy.erPeriod})`);
        const amaValues = calculateAMA(closes, {
            erPeriod: strategy.erPeriod,
            fastPeriod: strategy.fastPeriod,
            slowPeriod: strategy.slowPeriod
        });
        const metrics = calculateMetrics(amaValues, synthetic);

        strategiesWithMetrics.push({
            ...strategy,
            amaValues,
            metrics
        });

        console.log(`   ├─ Total Area: ${metrics.totalArea.toFixed(2)}%`);
        console.log(`   ├─ Max Distance UP: ${(metrics.maxDriftUp * 100).toFixed(2)}%`);
        console.log(`   ├─ Max Distance DOWN: ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        console.log(`   └─ Max Total Distance: ${(metrics.maxDistance * 100).toFixed(2)}%\n`);
    }

    // Create unified chart
    console.log("📊 Generating unified chart with all three strategies...\n");
    const file = createChart(strategiesWithMetrics, synthetic);

    console.log("================================================================================");
    console.log("COMPARISON SUMMARY\n");

    console.log("Strategy              | Area   | Max UP | Max DOWN | Band Factor");
    console.log("─────────────────────┼────────┼────────┼──────────┼─────────────");
    for (const s of strategiesWithMetrics) {
        const m = s.metrics;
        console.log(
            `${s.name.padEnd(21)} | ` +
            `${m.totalArea.toFixed(2).padStart(6)}% | ` +
            `${(m.maxDriftUp * 100).toFixed(2).padStart(5)}% | ` +
            `${(m.maxDriftDown * 100).toFixed(2).padStart(7)}% | ` +
            `${(m.maxDistance * 200).toFixed(2).padStart(10)}%`
        );
    }

    console.log("\n================================================================================");
    console.log("✅ UNIFIED CHART GENERATED:\n");
    console.log(`   📄 ${path.basename(file)}`);
    console.log(`\n   Features:`);
    console.log(`   ├─ All three AMA strategies overlaid`);
    console.log(`   ├─ Different colors for each strategy`);
    console.log(`   ├─ Grid bands shown for each (dashed lines)`);
    console.log(`   ├─ Interactive legend (click to toggle)`);
    console.log(`   ├─ Hover for exact values`);
    console.log(`   └─ Zoom and pan capabilities\n`);

    console.log("Legend:");
    console.log("  🟠 Orange (solid) = MAX AREA (ER=40, Fast=5, Slow=30)");
    console.log("  🟢 Green (dotted) = MAX EFFICIENCY (ER=15, Fast=5, Slow=30)");
    console.log("  🔵 Blue (dashed) = BALANCED OPTIMAL (ER=107, Fast=2, Slow=30)\n");
}

run();
