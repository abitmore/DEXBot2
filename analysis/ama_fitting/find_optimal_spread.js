const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

// --- Configuration ---
const DATA_DIR = path.join(__dirname, 'data');
const BEST_PARAMS = { erPeriod: 5, fastPeriod: 2, slowPeriod: 20 };

// Grid Configuration
const FIXED_INCREMENT = 1.05; // 5% increment (e.g., 1.05)
// OR
const FIXED_INCREMENT_PERCENT = 0.05; // 5% as a decimal

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
            const high = xrp.high / bts.low;
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

/**
 * Calculates the effectiveness of a grid strategy with a specific spread (gap) and increment.
 * Goal: Maximize "capturing" volatility without being stopped out or under-utilizing capital.
 * 
 * Simple heuristic for "Optimal Spread":
 * - Too narrow: Price constantly jumps over orders (slippage risk, fee churn).
 * - Too wide: Price moves inside the gap without triggering trades (opportunity cost).
 * 
 * Metric: "Coverage Efficiency"
 * Count how many candles have High-Low ranges that fully bridge a spread gap.
 */
function analyzeSpreadEfficiency(candles, amaValues) {
    const FEE_INCREMENT = 0.004; // 0.4% cost/increment
    console.log(`\n--- Spread Efficiency Analysis (Cost/Increment: ${(FEE_INCREMENT * 100).toFixed(1)}%) ---`);
    console.log(`(Net Profit = Spread - Cost)`);
    console.log(`(Score = Net Profit * Coverage_Probability)`);
    
    // Test a granular range of spreads starting from the cost basis
    const spreadScenarios = [
        0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 
        0.01, 0.011, 0.012, 0.013, 0.014, 0.015,
        0.02, 0.025, 0.03
    ];

    let results = [];

    for (const spreadPct of spreadScenarios) {
        let triggers = 0;
        let totalCandles = 0;

        // Skip stabilization
        for (let i = 20; i < candles.length; i++) {
            const price = candles[i].close; 
            
            // Define a virtual grid gap size at this price point
            const gapSize = price * spreadPct;

            // Check if the candle's High-Low range is large enough to cross a gap of this size
            const candleRange = candles[i].high - candles[i].low;
            
            if (candleRange >= gapSize) {
                triggers++;
            }

            totalCandles++;
        }

        const coverage = (triggers / totalCandles); // 0.0 to 1.0
        const netProfit = spreadPct - FEE_INCREMENT;
        
        // Expected Yield per candle (in percent terms relative to price)
        // If net profit is negative/zero, score is 0.
        const score = (netProfit > 0) ? (netProfit * coverage) * 100 : 0; 

        results.push({ 
            spread: spreadPct, 
            coverage: coverage * 100, 
            netProfit: netProfit * 100,
            score: score
        });
    }

    // Output Results
    console.log(`Spread % | Net Pft % | Coverage % | Score (Exp. Yield)`);
    console.log(`-------|-----------|------------|---------------------`);
    results.forEach(r => {
        console.log(
            `${(r.spread * 100).toFixed(2).padEnd(6)}% | ` +
            `${r.netProfit.toFixed(2).padEnd(9)}% | ` +
            `${r.coverage.toFixed(2).padEnd(10)}% | ` +
            `${r.score.toFixed(4)}`
        );
    });

    // Find Best Score
    const optimal = results.reduce((prev, current) => (prev.score > current.score) ? prev : current);
    
    console.log(`\nSuggestion: The optimal spread is ${(optimal.spread * 100).toFixed(2)}%.`);
    console.log(`Reasoning: It balances fill probability (${optimal.coverage.toFixed(1)}%) with net profit per trade (${optimal.netProfit.toFixed(2)}%).`);
}

function run() {
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
    const amaValues = calculateAMA(closes, BEST_PARAMS);

    analyzeSpreadEfficiency(synthetic, amaValues);
}

run();
