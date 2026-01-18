const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

// --- Configuration ---
const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(__dirname, 'chart_4h.html');

// Best Params found
const BEST_PARAMS = { erPeriod: 5, fastPeriod: 2, slowPeriod: 20 };

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
            // XRP/BTS Calculation
            // Max Price = Max Numerator (XRP) / Min Denominator (BTS)
            const high = xrp.high / bts.low;
            // Min Price = Min Numerator (XRP) / Max Denominator (BTS)
            const low = xrp.low / bts.high;
            const close = xrp.close / bts.close;
            const open = xrp.open / bts.open;
            
            synthetic.push({
                timestamp: bts.timestamp,
                open: open,
                high: high,
                low: low,
                close: close,
                mid: (high + low) / 2
            });
        }
    });

    return synthetic.sort((a, b) => a.timestamp - b.timestamp);
}

function createHTML(candles, amaValues, rangeStats) {
    // Prepare data arrays for Plotly
    const dates = candles.map(c => new Date(c.timestamp).toISOString());
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    const upperBand = amaValues.map(v => v * (1 + rangeStats.optimalFactor));
    const lowerBand = amaValues.map(v => v * (1 - rangeStats.optimalFactor));

    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>XRP/BTS Synthetic 4h Chart + AMA</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        body { margin: 0; padding: 0; background: #111; color: #eee; font-family: sans-serif; }
        #chart { width: 100vw; height: 100vh; }
        .info { position: absolute; top: 10px; left: 60px; z-index: 100; background: rgba(0,0,0,0.7); padding: 10px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="info">
        <h3>XRP/BTS (Synthetic) - 4h</h3>
        <p>AMA Settings: ER=${BEST_PARAMS.erPeriod}, Fast=${BEST_PARAMS.fastPeriod}, Slow=${BEST_PARAMS.slowPeriod}</p>
        <p><strong>Max Deviation:</strong> ${(rangeStats.maxDeltaPercent * 100).toFixed(4)}%</p>
        <p><strong>Optimal Factor (x2):</strong> ${(rangeStats.optimalFactor * 100).toFixed(4)}%</p>
    </div>
    <div id="chart"></div>

    <script>
        const dates = ${JSON.stringify(dates)};
        const opens = ${JSON.stringify(opens)};
        const highs = ${JSON.stringify(highs)};
        const lows = ${JSON.stringify(lows)};
        const closes = ${JSON.stringify(closes)};
        const ama = ${JSON.stringify(amaValues)};
        const upper = ${JSON.stringify(upperBand)};
        const lower = ${JSON.stringify(lowerBand)};

        const traceCandle = {
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
            name: 'Price'
        };

        const traceAMA = {
            x: dates,
            y: ama,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#fb8c00', width: 2 },
            name: 'AMA'
        };

        const traceUpper = {
            x: dates,
            y: upper,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#fb8c00', width: 1, dash: 'dash' },
            name: 'Upper Band (+${(rangeStats.optimalFactor * 100).toFixed(2)}%)',
            opacity: 0.5
        };

        const traceLower = {
            x: dates,
            y: lower,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#fb8c00', width: 1, dash: 'dash' },
            name: 'Lower Band (-${(rangeStats.optimalFactor * 100).toFixed(2)}%)',
            opacity: 0.5
        };

        const layout = {
            dragmode: 'zoom', 
            margin: {r: 10, t: 25, b: 40, l: 60}, 
            showlegend: true, 
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
            font: { color: '#ccc' }
        };

        Plotly.newPlot('chart', [traceCandle, traceAMA, traceUpper, traceLower], layout);
    </script>
</body>
</html>
    `;
    return html;
}

function calculateRangeStats(candles, amaValues) {
    let maxDeltaRatio = 0;
    
    // Skip initialization period
    const skip = 20; 

    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const high = candles[i].high;
        const low = candles[i].low;

        // Calculate relative deviation
        const highDev = (high - ama) / ama;
        const lowDev = (ama - low) / ama;

        maxDeltaRatio = Math.max(maxDeltaRatio, highDev, lowDev);
    }

    const SECURITY_FACTOR = 2.0;
    return {
        maxDeltaPercent: maxDeltaRatio,
        optimalFactor: maxDeltaRatio * SECURITY_FACTOR
    };
}

function run() {
    console.log("Generating Chart...");
    
    let btsData, xrpData;
    try {
        btsData = loadData('BTS_USDT.json');
        xrpData = loadData('XRP_USDT.json');
    } catch (e) {
        console.error("Error loading files.");
        return;
    }

    const synthetic = generateSyntheticPair(btsData, xrpData);
    const closes = synthetic.map(c => c.close);
    
    // Calculate AMA with best params
    const amaValues = calculateAMA(closes, BEST_PARAMS);
    
    // Calculate Stats
    const stats = calculateRangeStats(synthetic, amaValues);
    console.log(`Max Deviation: ${(stats.maxDeltaPercent * 100).toFixed(4)}%`);
    console.log(`Optimal Factor (Safety 2.0): ${(stats.optimalFactor * 100).toFixed(4)}%`);

    const htmlContent = createHTML(synthetic, amaValues, stats);
    fs.writeFileSync(OUT_FILE, htmlContent);
    
    console.log(`Chart generated successfully at: ${OUT_FILE}`);
}

run();
