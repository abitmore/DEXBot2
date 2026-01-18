const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

// --- Configuration ---
const DATA_DIR = path.join(__dirname, 'data');
const PENALTY_FACTOR = 2.0; 

// Optimization Ranges
const PARAMS_GRID = {
    erPeriod: [5, 8, 10, 15, 20, 30, 40],
    fastPeriod: [2, 3, 4, 5],
    slowPeriod: [20, 30, 45, 60, 90, 120]
};

// --- Helper Functions ---

function loadData(filename) {
    const raw = fs.readFileSync(path.join(DATA_DIR, filename));
    const json = JSON.parse(raw);
    // ccxt structure: [timestamp, open, high, low, close, volume]
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
    // Create map for easier lookup by timestamp
    const xrpMap = new Map();
    xrpData.forEach(c => xrpMap.set(c.timestamp, c));

    const synthetic = [];

    btsData.forEach(bts => {
        const xrp = xrpMap.get(bts.timestamp);
        if (xrp) {
            // Synthetic BTS/XRP calculation
            // Max Price possible in this window = Max Num / Min Denom
            const high = bts.high / xrp.low;
            // Min Price possible in this window = Min Num / Max Denom
            const low = bts.low / xrp.high;
            const close = bts.close / xrp.close;
            const open = bts.open / xrp.open;
            
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

function calculateError(amaValues, candles) {
    let totalError = 0;
    let count = 0;
    const skip = 50; 

    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const mid = candles[i].mid;
        
        // 1. Tracking Error
        const trackingError = Math.abs(ama - mid);
        
        // 2. Movement Error
        let movementError = 0;
        if (i > 0) {
            movementError = Math.abs(amaValues[i] - amaValues[i-1]);
        }

        totalError += trackingError + (PENALTY_FACTOR * movementError);
        count++;
    }

    return count === 0 ? Infinity : totalError / count;
}

function runOptimization() {
    console.log("Loading data...");
    
    let btsData, xrpData;
    try {
        btsData = loadData('BTS_USDT.json');
        xrpData = loadData('XRP_USDT.json');
    } catch (e) {
        console.error("Error loading files. Ensure BTS_USDT.json and XRP_USDT.json exist in /data.");
        return;
    }

    console.log(`Loaded ${btsData.length} BTS candles and ${xrpData.length} XRP candles.`);
    
    const syntheticCandles = generateSyntheticPair(btsData, xrpData);
    console.log(`Generated ${syntheticCandles.length} synthetic BTS/XRP candles.`);

    if (syntheticCandles.length === 0) return;

    console.log(`\n--- Optimizing for Synthetic BTS/XRP ---`);
    
    const closes = syntheticCandles.map(c => c.close);
    let results = [];

    // Brute Force Grid Search
    for (const er of PARAMS_GRID.erPeriod) {
        for (const fast of PARAMS_GRID.fastPeriod) {
            for (const slow of PARAMS_GRID.slowPeriod) {
                if (fast >= slow) continue; 

                const params = { erPeriod: er, fastPeriod: fast, slowPeriod: slow };
                const amaValues = calculateAMA(closes, params);
                const error = calculateError(amaValues, syntheticCandles);

                results.push({ params, error });
            }
        }
    }

    // Sort by lowest error
    results.sort((a, b) => a.error - b.error);

    console.log("Top 5 Parameters for BTS/XRP:");
    results.slice(0, 5).forEach((res, index) => {
        console.log(`#${index + 1}: Error=${res.error.toFixed(8)} | ER=${res.params.erPeriod}, Fast=${res.params.fastPeriod}, Slow=${res.params.slowPeriod}`);
    });
}

runOptimization();

