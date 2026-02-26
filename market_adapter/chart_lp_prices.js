/**
 * CHART LP PRICE DATA
 *
 * Reads the exported LP candle data and generates an interactive Plotly HTML chart.
 * Opens in your default browser automatically.
 *
 * Usage:
 *   node market_adapter/chart_lp_prices.js
 *   node market_adapter/chart_lp_prices.js --file market_adapter/data/lp_prices_BTS_XBTSX_XRP.json
 *   node market_adapter/chart_lp_prices.js --no-open   (generate HTML without opening browser)
 *
 * Chart shows:
 *   - Price line (VWAP per bucket)
 *   - AMA (Adaptive Moving Average) overlay
 *   - AMA deviation % (bottom subplot)
 *   - Volume bars (middle subplot)
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const { exec } = require('child_process');

// AMA from existing analysis module
const { calculateAMA } = require('../analysis/ama_fitting/ama');

// ─── AMA Config ───────────────────────────────────────────────────────────────
// Same params used in generate_unified_comparison_chart.js and market_monitor.js
const AMA_PARAMS = { erPeriod: 10, fastPeriod: 2, slowPeriod: 30 };

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs() {
    const args   = process.argv.slice(2);
    let dataFile = null;
    let noOpen   = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--file' && args[i + 1]) {
            dataFile = path.resolve(args[i + 1]);
            i++;
        } else if (args[i] === '--no-open') {
            noOpen = true;
        } else if (!args[i].startsWith('--')) {
            dataFile = path.resolve(args[i]);
        }
    }

    return { dataFile, noOpen };
}

// ─── Find Latest Data File ────────────────────────────────────────────────────

function findDataFile() {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) return null;

    const files = fs.readdirSync(dataDir)
        .filter(f => (f.startsWith('lp_pool_') || f.startsWith('lp_prices_')) && f.endsWith('.json'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dataDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);  // newest first

    return files.length > 0 ? path.join(dataDir, files[0].name) : null;
}

// ─── Open in Browser ──────────────────────────────────────────────────────────

function openInBrowser(filePath) {
    const url = `file://${filePath}`;
    // Linux: xdg-open, macOS: open, Windows: start
    const cmd = process.platform === 'darwin' ? `open "${url}"` :
                process.platform === 'win32'  ? `start "" "${url}"` :
                                                `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.warn(`  Could not auto-open browser: ${err.message}`);
    });
}

// ─── HTML / Chart Generation ──────────────────────────────────────────────────

function generateHTML(meta, candles, amaValues) {
    const { assetA, assetB, intervalSeconds, source, fetchedAt, pool } = meta;
    const poolLabel = pool ? `Pool ${String(pool).replace('1.19.', '')}` : `${assetA.symbol}/${assetB.symbol}`;
    const intervalLabel = intervalSeconds >= 86400 ? `${intervalSeconds / 86400}d` :
                          intervalSeconds >= 3600  ? `${intervalSeconds / 3600}h`  :
                          intervalSeconds >= 60    ? `${intervalSeconds / 60}m`    : `${intervalSeconds}s`;

    const dates   = candles.map(c => new Date(c[0]).toISOString());
    const closes  = candles.map(c => c[4]);
    const volumes = candles.map(c => c[5]);

    // Deviation of price from AMA (%)
    const deviations = closes.map((p, i) => ((p - amaValues[i]) / amaValues[i]) * 100);

    // Compute price range stats for info box
    const validClosesWithAMA = closes.slice(AMA_PARAMS.erPeriod);
    const validAMA           = amaValues.slice(AMA_PARAMS.erPeriod);
    const maxDev = Math.max(...validClosesWithAMA.map((p, i) =>
        Math.abs((p - validAMA[i]) / validAMA[i]) * 100
    ));
    const lastPrice    = closes[closes.length - 1];
    const lastAMA      = amaValues[amaValues.length - 1];
    const lastDeviation = ((lastPrice - lastAMA) / lastAMA) * 100;

    // Color-code deviation bar: red if far from AMA, green if close
    const devColors = deviations.map(d => {
        const abs = Math.abs(d);
        if (abs > 2)  return 'rgba(239, 83, 80, 0.7)';   // red — high divergence
        if (abs > 1)  return 'rgba(251, 140, 0, 0.7)';   // orange — moderate
        return             'rgba(38, 166, 154, 0.6)';    // teal — close to AMA
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${poolLabel} LP Price · ${intervalLabel}</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0e1117; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; }

        #header {
            position: fixed; top: 0; left: 0; right: 0; z-index: 100;
            background: rgba(14,17,23,0.92); backdrop-filter: blur(4px);
            border-bottom: 1px solid #2a2e3e;
            padding: 10px 20px;
            display: flex; align-items: baseline; gap: 20px;
        }
        #header h1 { font-size: 18px; font-weight: 600; color: #fff; }
        #header .sub { font-size: 12px; color: #888; }

        #stats {
            position: fixed; top: 50px; right: 12px; z-index: 100;
            background: rgba(20,24,32,0.88); backdrop-filter: blur(4px);
            border: 1px solid #2a2e3e; border-radius: 6px;
            padding: 10px 14px; font-size: 12px; line-height: 1.7;
            min-width: 200px;
        }
        #stats .label { color: #888; }
        #stats .val   { color: #e0e0e0; font-weight: 600; }
        #stats .pos   { color: #26a69a; }
        #stats .neg   { color: #ef5350; }

        #charts { padding-top: 44px; display: flex; flex-direction: column; height: 100vh; }
        #price-chart  { flex: 3; }
        #vol-chart    { flex: 1; }
        #dev-chart    { flex: 1; }
    </style>
</head>
<body>

<div id="header">
    <h1><span style="color:#fb8c00">${poolLabel}</span> &nbsp; LP Swap Price</h1>
    <span class="sub">BitShares DEX · ${intervalLabel} buckets · AMA(${AMA_PARAMS.erPeriod},${AMA_PARAMS.fastPeriod},${AMA_PARAMS.slowPeriod})</span>
    <span class="sub" style="margin-left:auto">Fetched: ${new Date(fetchedAt).toLocaleString()}</span>
</div>

<div id="stats">
    <div><span class="label">Last Price  </span><span class="val">${lastPrice.toFixed(6)}</span></div>
    <div><span class="label">Last AMA    </span><span class="val">${lastAMA.toFixed(6)}</span></div>
    <div><span class="label">Deviation   </span><span class="${lastDeviation >= 0 ? 'pos' : 'neg'}">${lastDeviation >= 0 ? '+' : ''}${lastDeviation.toFixed(3)}%</span></div>
    <div style="margin-top:6px"><span class="label">Max |dev|   </span><span class="val">${maxDev.toFixed(3)}%</span></div>
    <div><span class="label">Candles     </span><span class="val">${candles.length}</span></div>
    <div><span class="label">Source      </span><span class="label" style="font-size:10px">Kibana LP (op_type 63)</span></div>
</div>

<div id="charts">
    <div id="price-chart"></div>
    <div id="vol-chart"></div>
    <div id="dev-chart"></div>
</div>

<script>
const dates      = ${JSON.stringify(dates)};
const closes     = ${JSON.stringify(closes)};
const volumes    = ${JSON.stringify(volumes)};
const ama        = ${JSON.stringify(amaValues)};
const deviations = ${JSON.stringify(deviations)};
const devColors  = ${JSON.stringify(devColors)};

const DARK = {
    plot_bgcolor:  '#0e1117',
    paper_bgcolor: '#0e1117',
    font:          { color: '#ccc', size: 11 },
};

const AXIS = {
    gridcolor:     '#1e2330',
    linecolor:     '#2a2e3e',
    zerolinecolor: '#2a2e3e',
    tickfont:      { size: 10 },
};

// ── Price + AMA chart ──────────────────────────────────────────────────────
const tracePrice = {
    x: dates, y: closes,
    type: 'scatter', mode: 'lines',
    line: { color: '#5c9ee6', width: 1.5 },
    name: '${assetA.symbol}/${assetB.symbol} VWAP',
    hovertemplate: '<b>%{x|%Y-%m-%d %H:%M}</b><br>Price: %{y:.8f}<extra></extra>',
};

const traceAMA = {
    x: dates, y: ama,
    type: 'scatter', mode: 'lines',
    line: { color: '#fb8c00', width: 2 },
    name: 'AMA',
    hovertemplate: 'AMA: %{y:.8f}<extra></extra>',
};

// Band: ±1.5× max deviation shaded region (visual reference only)
const maxDev = ${maxDev.toFixed(6)};
const upperBand = ama.map(v => v * (1 + maxDev / 100));
const lowerBand = ama.map(v => v * (1 - maxDev / 100));

const traceUpper = {
    x: dates, y: upperBand,
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(251,140,0,0.35)', width: 1, dash: 'dot' },
    name: '+MaxDev band', showlegend: false,
    hoverinfo: 'skip',
};

const traceLower = {
    x: dates, y: lowerBand,
    fill: 'tonexty',
    fillcolor: 'rgba(251,140,0,0.05)',
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(251,140,0,0.35)', width: 1, dash: 'dot' },
    name: '±MaxDev band', showlegend: true,
    hoverinfo: 'skip',
};

Plotly.newPlot('price-chart',
    [traceUpper, traceLower, tracePrice, traceAMA],
    {
        ...DARK,
        margin: { l: 70, r: 160, t: 10, b: 10 },
        showlegend: true,
        legend: { x: 0.01, y: 0.98, bgcolor: 'rgba(14,17,23,0.8)', bordercolor: '#2a2e3e', borderwidth: 1 },
        xaxis: { ...AXIS, type: 'date', showticklabels: false, rangeslider: { visible: false } },
        yaxis: { ...AXIS, title: { text: '${assetB.symbol} per ${assetA.symbol}', standoff: 8 }, tickformat: '.6f' },
    },
    { responsive: true }
);

// ── Volume chart ───────────────────────────────────────────────────────────
const traceVol = {
    x: dates, y: volumes,
    type: 'bar',
    marker: { color: 'rgba(92,158,230,0.5)', line: { width: 0 } },
    name: 'Volume (${assetA.symbol})',
    hovertemplate: 'Vol: %{y:.4f}<extra></extra>',
};

Plotly.newPlot('vol-chart',
    [traceVol],
    {
        ...DARK,
        margin: { l: 70, r: 160, t: 4, b: 10 },
        showlegend: false,
        xaxis: { ...AXIS, type: 'date', showticklabels: false },
        yaxis: { ...AXIS, title: { text: 'Volume', standoff: 8 } },
    },
    { responsive: true }
);

// ── Deviation chart ────────────────────────────────────────────────────────
const traceDev = {
    x: dates, y: deviations,
    type: 'bar',
    marker: { color: devColors, line: { width: 0 } },
    name: 'AMA Deviation %',
    hovertemplate: 'Dev: %{y:.3f}%<extra></extra>',
};

const traceZero = {
    x: [dates[0], dates[dates.length - 1]], y: [0, 0],
    type: 'scatter', mode: 'lines',
    line: { color: '#fb8c00', width: 1, dash: 'dot' },
    name: 'Zero', showlegend: false, hoverinfo: 'skip',
};

Plotly.newPlot('dev-chart',
    [traceDev, traceZero],
    {
        ...DARK,
        margin: { l: 70, r: 160, t: 4, b: 30 },
        showlegend: false,
        xaxis: { ...AXIS, type: 'date' },
        yaxis: { ...AXIS, title: { text: 'Dev %', standoff: 8 }, ticksuffix: '%',
                 zeroline: true, zerolinecolor: '#fb8c00', zerolinewidth: 1 },
    },
    { responsive: true }
);

// ── Link x-axes for synchronized zoom/pan ──────────────────────────────────
function syncAxes(sourceDiv, targetDivs) {
    sourceDiv.on('plotly_relayout', (e) => {
        if (e['xaxis.range[0]'] !== undefined) {
            const update = {
                'xaxis.range[0]': e['xaxis.range[0]'],
                'xaxis.range[1]': e['xaxis.range[1]'],
            };
            targetDivs.forEach(d => Plotly.relayout(d, update));
        } else if (e['xaxis.autorange']) {
            targetDivs.forEach(d => Plotly.relayout(d, { 'xaxis.autorange': true }));
        }
    });
}

const pc = document.getElementById('price-chart');
const vc = document.getElementById('vol-chart');
const dc = document.getElementById('dev-chart');
syncAxes(pc, [vc, dc]);
syncAxes(vc, [pc, dc]);
syncAxes(dc, [pc, vc]);
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run() {
    const { dataFile: argFile, noOpen } = parseArgs();

    // Locate data file
    const dataFile = argFile ?? findDataFile();
    if (!dataFile) {
        console.error('No data file found. Run fetch first:');
        console.error('  node market_adapter/fetch_lp_data.js');
        process.exit(1);
    }
    if (!fs.existsSync(dataFile)) {
        console.error(`File not found: ${dataFile}`);
        process.exit(1);
    }

    console.log(`Reading: ${path.relative(process.cwd(), dataFile)}`);

    const raw    = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const { meta, candles } = raw;

    if (!candles || candles.length === 0) {
        console.error('No candles in data file.');
        process.exit(1);
    }

    const poolLabel = meta.pool ? `pool ${meta.pool}` : `${meta.assetA.symbol}/${meta.assetB.symbol}`;
    console.log(`  ${candles.length} candles · ${poolLabel}`);

    // Calculate AMA on close prices
    const closes    = candles.map(c => c[4]);
    const amaValues = calculateAMA(closes, AMA_PARAMS);

    const lastClose = closes[closes.length - 1];
    const lastAMA   = amaValues[amaValues.length - 1];
    const deviation = ((lastClose - lastAMA) / lastAMA) * 100;
    console.log(`  Last price:  ${lastClose.toFixed(8)}`);
    console.log(`  Last AMA:    ${lastAMA.toFixed(8)}`);
    console.log(`  Deviation:   ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}%`);

    // Generate HTML
    const html    = generateHTML(meta, candles, amaValues);
    const suffix  = meta.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${meta.assetA.symbol}_${meta.assetB.symbol}`;
    const outFile = path.join(__dirname, `lp_chart_${suffix}.html`).replace(/\./g, '_').replace('_html', '.html');
    fs.writeFileSync(outFile, html);

    console.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);

    if (!noOpen) {
        console.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        console.log(`Open manually: file://${outFile}`);
    }
}

run();
