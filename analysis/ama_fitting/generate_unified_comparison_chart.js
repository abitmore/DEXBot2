const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

/**
 * UNIFIED COMPARISON CHART GENERATOR
 *
 * ⚠️  DATA: 4-HOUR CANDLES ONLY
 *
 * Shows four AMA strategies on the same candlestick chart.
 * Strategies are loaded automatically from the optimizer results JSON when
 * using --data, with linear and capped winners:
 *   1. MAX AREA/MAXDIST                (orange, solid)
 *   2. MAX PROD/MAXDIST                (blue, dash)
 *   3. MAX AREA/MAXDIST (capped band)  (green, longdash)
 *   4. MAX PROD/MAXDIST (capped band)  (red, longdashdot)
 *
 * Falls back to hardcoded MEXC defaults when no results file is found.
 *
 * Usage:
 *   node optimizer_high_resolution.js --data ../../market_adapter/data/lp_pool_133_4h.json
 *   node generate_unified_comparison_chart.js --data ../../market_adapter/data/lp_pool_133_4h.json
 *   node generate_unified_comparison_chart.js
 */

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(__dirname, 'chart_4h_UNIFIED_COMPARISON.html');

// Fallback strategies used when no optimizer results file exists
const FALLBACK_STRATEGIES = [
    { name: 'FAST',     erPeriod: 15,  fastPeriod: 5, slowPeriod: 30, color: '#26a69a', dash: 'dot'   },
    { name: 'MEDIUM',   erPeriod: 50,  fastPeriod: 5, slowPeriod: 30, color: '#fb8c00', dash: 'solid' },
    { name: 'SLOW',     erPeriod: 100, fastPeriod: 2, slowPeriod: 30, color: '#9E9E9E', dash: 'dash'  },
];

/**
 * Load representative strategies from an optimizer results JSON.
 *
 * Returns null if the file doesn't exist or has no results.
 */
function strategiesFromResults(resultsPath) {
    if (!fs.existsSync(resultsPath)) return null;
    const json = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    const meta = json.meta;
    if (!meta) return null;

    const strategies = [];

    function add(key, label, color, dash) {
        const r = meta[key];
        if (!r) return;
        strategies.push({ name: label, erPeriod: r.er, fastPeriod: r.fast, slowPeriod: r.slow, color, dash });
    }

    const areaCap = Number.isFinite(meta.areaCapPct) ? meta.areaCapPct : null;
    const prodCap = Number.isFinite(meta.prodCapPct) ? meta.prodCapPct : null;
    add('bestAreaMaxDist', 'MAX AREA/MAXDIST', '#fb8c00', 'solid'); // orange
    add('bestProdMaxDist', 'MAX PROD/MAXDIST', '#42a5f5', 'dash');  // blue
    add(
        'bestAreaMaxDistCapped',
        areaCap === null ? 'MAX AREA/MAXDIST (BAND CAP)' : `MAX AREA/MAXDIST (<=${areaCap.toFixed(1)}%)`,
        '#2e7d32',
        'longdash'
    ); // green
    add(
        'bestProdMaxDistCapped',
        prodCap === null ? 'MAX PROD/MAXDIST (BAND CAP)' : `MAX PROD/MAXDIST (<=${prodCap.toFixed(1)}%)`,
        '#ef5350',
        'longdashdot'
    ); // red

    return strategies.length ? strategies : null;
}

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

// Load Kibana LP candle export { meta, candles: [[ts,o,h,l,c,vol],...] }
function loadLpData(filePath) {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const candles = json.candles ?? json;
    return { candles: candles.map(c => ({
        timestamp: c[0],
        open:      c[1],
        high:      c[2],
        low:       c[3],
        close:     c[4],
        volume:    c[5]
    })), meta: json.meta ?? null };
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

function buildLegendHTML(strategies) {
    return strategies.map(s => `
            <div class="legend-item">
                <div class="legend-line" style="background: ${s.color}; border-top: 2px ${s.dash === 'dot' ? 'dotted' : s.dash === 'dash' ? 'dashed' : 'solid'} ${s.color};"></div>
                <span style="color: ${s.color};">${s.name} (ER=${s.erPeriod})</span>
            </div>`).join('\n');
}

function createChart(strategiesWithMetrics, candles, dataLabel = 'XRP/BTS (MEXC)', outFile = OUT_FILE) {
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

    const legendHTML = buildLegendHTML(strategiesWithMetrics);
    const stratCount = strategiesWithMetrics.length;

    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>${dataLabel} - AMA Comparison (${stratCount} strategies)</title>
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
        <p><strong>${stratCount} AMA Strategies Overlaid:</strong></p>
        <div class="legend-info" style="flex-direction: column; gap: 8px;">
            ${legendHTML}
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
                text: '${dataLabel} — ${stratCount} AMA Strategies Comparison',
                font: { size: 16, color: '#fb8c00' }
            }
        };

        Plotly.newPlot('chart', traces, layout, {responsive: true});
    </script>
</body>
</html>
    `;

    fs.writeFileSync(outFile, html);
    return outFile;
}

function run() {
    // --data PATH  → use LP candle JSON instead of MEXC synthetic pair
    const dataArgIdx = process.argv.indexOf('--data');
    const dataFile   = dataArgIdx !== -1 ? process.argv[dataArgIdx + 1] : null;

    console.log("================================================================================");
    console.log("GENERATING UNIFIED COMPARISON CHART");
    console.log("================================================================================\n");

    let candles, dataLabel, outFile, STRATEGIES;
    if (dataFile) {
        try {
            const loaded = loadLpData(path.resolve(dataFile));
            candles   = loaded.candles;
            const m   = loaded.meta;
            dataLabel = m ? `LP Pool ${m.pool} · ${m.assetA?.symbol}/${m.assetB?.symbol} · ${m.intervalSeconds / 3600}h` : path.basename(dataFile);
            outFile   = path.join(__dirname, `chart_lp_${path.basename(dataFile, '.json')}.html`);

            // Load 4 best-in-class strategies from the optimizer results file
            const resultsFile = path.join(__dirname, `optimization_results_${path.basename(dataFile, '.json')}.json`);
            const fromResults = strategiesFromResults(resultsFile);
            STRATEGIES = fromResults ?? FALLBACK_STRATEGIES;
            if (fromResults) {
                console.log(`Strategies:  loaded from ${path.basename(resultsFile)}`);
                fromResults.forEach(s => console.log(`  ${s.name.padEnd(14)} ER=${s.erPeriod}  Fast=${s.fastPeriod}  Slow=${s.slowPeriod}`));
            } else {
                console.log(`Strategies:  results file not found — using fallback`);
            }
        } catch (e) {
            console.error("Error loading LP data:", e.message);
            return;
        }
    } else {
        let btsData, xrpData;
        try {
            btsData = loadData('BTS_USDT.json');
            xrpData = loadData('XRP_USDT.json');
        } catch (e) {
            console.error("Error loading data:", e.message);
            return;
        }
        candles    = generateSyntheticPair(btsData, xrpData);
        dataLabel  = 'XRP/BTS (MEXC)';
        outFile    = OUT_FILE;
        STRATEGIES = [...FALLBACK_STRATEGIES];
    }

    const closes = candles.map(c => c.close);

    console.log(`Data source: ${dataLabel}`);
    console.log(`Loaded ${candles.length} candles\n`);

    // Calculate all strategies
    const strategiesWithMetrics = [];

    for (const strategy of STRATEGIES) {
        console.log(`Calculating ${strategy.name}`);
        const amaValues = calculateAMA(closes, {
            erPeriod: strategy.erPeriod,
            fastPeriod: strategy.fastPeriod,
            slowPeriod: strategy.slowPeriod
        });
        const metrics = calculateMetrics(amaValues, candles);

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
    console.log(`Generating unified chart with ${strategiesWithMetrics.length} strategies...\n`);
    const file = createChart(strategiesWithMetrics, candles, dataLabel, outFile);

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
    console.log(`UNIFIED CHART GENERATED:\n`);
    console.log(`  ${path.basename(file)}`);
    console.log(`\n  Strategies:`);
    for (const s of strategiesWithMetrics) {
        console.log(`  ├─ ${s.name.padEnd(30)} ER=${String(s.erPeriod).padStart(3)}  Fast=${s.fastPeriod}  Slow=${s.slowPeriod}`);
    }
    console.log(`\n  Features: candlesticks + ${strategiesWithMetrics.length} AMA lines + grid bands · interactive · hover for values\n`);
}

run();
