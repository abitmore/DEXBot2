const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

/**
 * HIGH-RESOLUTION COMBINED METRICS OPTIMIZER
 *
 * ⚠️  DATA: 4-HOUR CANDLES ONLY
 * Input: 500 4h candles from MEXC (XRP/USDT + BTS/USDT)
 * Output: Optimal ER, Fast, Slow parameters
 *
 * Tests FRACTIONAL parameter values for finer optimization:
 * - ER: 0.5 step increments (2, 2.5, 3, 3.5, ..., 150)
 * - Fast: 0.5 step increments (2, 2.5, 3, 3.5, 4, 4.5, 5)
 * - Slow: 2.5 step increments (10, 12.5, 15, 17.5, ..., 30)
 *
 * Result: 18,711 combinations for maximum optimization
 * Previous: 252 combinations (integer-only, coarse resolution)
 * Improvement: 74x more combinations = better accuracy
 *
 * Metrics:
 * - Oscillation Area: Total space price oscillates from AMA
 * - Fill Efficiency: Percentage of orders that match (target: 50%)
 * - Combined Score: Normalized average of both metrics
 */

const DATA_DIR = path.join(__dirname, 'data');
const gridSpacing = 0.008;  // 0.80%

// Parameter ranges with FINER resolution
function generateRange(min, max, step) {
    const result = [];
    for (let i = min; i <= max; i += step) {
        result.push(parseFloat(i.toFixed(1)));
    }
    return [...new Set(result)];  // Remove duplicates
}

const ER_VALUES = generateRange(2, 150, 0.5);
const FAST_VALUES = generateRange(2, 5, 0.5);
const SLOW_VALUES = generateRange(10, 30, 2.5);

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

// Calculate Area Above/Below AMA
function calculateAreaMetrics(amaValues, candles) {
    let areaAbove = 0;
    let areaBelow = 0;
    let maxDriftUp = 0;
    let maxDriftDown = 0;

    const skip = Math.max(20, Math.floor(candles.length * 0.1));

    for (let i = skip; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const ama = amaValues[i];

        const driftUpAmount = (high - ama) / ama;
        const driftDownAmount = (ama - low) / ama;

        if (driftUpAmount > maxDriftUp) maxDriftUp = driftUpAmount;
        if (driftDownAmount > maxDriftDown) maxDriftDown = driftDownAmount;

        if (high > ama) areaAbove += driftUpAmount;
        if (low < ama) areaBelow += driftDownAmount;
    }

    return {
        areaAbove,
        areaBelow,
        totalArea: areaAbove + areaBelow,
        maxDriftUp,
        maxDriftDown,
        maxDistance: Math.max(maxDriftUp, maxDriftDown)
    };
}

// Calculate Fill Efficiency (Order Matching)
function calculateFillEfficiency(amaValues, candles) {
    const gridLevels = [0.008, 0.016, 0.024, 0.032, 0.040];  // 0.8%, 1.6%, 2.4%, 3.2%, 4.0%
    let buyOrdersOpen = new Map();
    let sellOrdersOpen = new Map();
    let matchedCount = 0;
    let totalOrders = 0;

    for (let i = 1; i < candles.length; i++) {
        const ama = amaValues[i];
        const high = candles[i].high;
        const low = candles[i].low;

        // Check each grid level
        for (const level of gridLevels) {
            const buyLevel = ama * (1 - level);
            const sellLevel = ama * (1 + level);
            const levelKey = level.toFixed(4);

            // BUY order: if price touches buy level
            if (low <= buyLevel) {
                if (!buyOrdersOpen.has(levelKey)) {
                    buyOrdersOpen.set(levelKey, true);
                    totalOrders++;

                    // Check if matching SELL order exists
                    if (sellOrdersOpen.has(levelKey)) {
                        matchedCount++;
                        buyOrdersOpen.delete(levelKey);
                        sellOrdersOpen.delete(levelKey);
                    }
                }
            }

            // SELL order: if price touches sell level
            if (high >= sellLevel) {
                if (!sellOrdersOpen.has(levelKey)) {
                    sellOrdersOpen.set(levelKey, true);
                    totalOrders++;

                    // Check if matching BUY order exists
                    if (buyOrdersOpen.has(levelKey)) {
                        matchedCount++;
                        buyOrdersOpen.delete(levelKey);
                        sellOrdersOpen.delete(levelKey);
                    }
                }
            }
        }
    }

    const fillEfficiency = totalOrders > 0 ? matchedCount / totalOrders : 0;
    return {
        fillEfficiency: fillEfficiency * 100,  // Convert to percentage
        matchedCount,
        totalOrders
    };
}

function normalizeMetric(value, min, max) {
    if (max === min) return 50;
    return ((value - min) / (max - min)) * 100;
}

function run() {
    console.log("================================================================================");
    console.log("HIGH-RESOLUTION COMBINED METRICS OPTIMIZER");
    console.log("================================================================================");
    console.log(`\nTesting FRACTIONAL parameter values for finer optimization:\n`);

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
    console.log(`ER Values: ${ER_VALUES.length} options (step 0.5)`);
    console.log(`Fast Values: ${FAST_VALUES.length} options (step 0.5)`);
    console.log(`Slow Values: ${SLOW_VALUES.length} options (step 2.5)`);
    console.log(`Total combinations: ${ER_VALUES.length * FAST_VALUES.length * SLOW_VALUES.length}\n`);

    const results = [];
    let count = 0;
    const total = ER_VALUES.length * FAST_VALUES.length * SLOW_VALUES.length;

    // Test all combinations
    for (const er of ER_VALUES) {
        for (const fast of FAST_VALUES) {
            for (const slow of SLOW_VALUES) {
                const params = { erPeriod: er, fastPeriod: fast, slowPeriod: slow };
                const amaValues = calculateAMA(closes, params);

                const areaMetrics = calculateAreaMetrics(amaValues, synthetic);
                const fillMetrics = calculateFillEfficiency(amaValues, synthetic);

                results.push({
                    er,
                    fast,
                    slow,
                    ...areaMetrics,
                    ...fillMetrics
                });

                count++;
                if (count % 500 === 0) {
                    process.stdout.write(`\rProgress: ${count}/${total} (${(count/total*100).toFixed(1)}%)`);
                }
            }
        }
    }
    console.log(`\rProgress: ${total}/${total} (100%)\n`);

    // Find min/max for normalization
    const areas = results.map(r => r.totalArea);
    const efficiencies = results.map(r => r.fillEfficiency);

    const minArea = Math.min(...areas);
    const maxArea = Math.max(...areas);
    const minEfficiency = Math.min(...efficiencies);
    const maxEfficiency = Math.max(...efficiencies);

    // Calculate combined scores
    for (const result of results) {
        const normalizedArea = normalizeMetric(result.totalArea, minArea, maxArea);
        const normalizedEfficiency = normalizeMetric(result.fillEfficiency, minEfficiency, maxEfficiency);
        result.normalizedArea = normalizedArea;
        result.normalizedEfficiency = normalizedEfficiency;
        result.combinedScore = (normalizedArea + normalizedEfficiency) / 2;
    }

    // Sort by combined score
    results.sort((a, b) => b.combinedScore - a.combinedScore);

    console.log("================================================================================");
    console.log("TOP 30 CONFIGURATIONS - COMBINED METRICS (HIGH RESOLUTION)");
    console.log("================================================================================\n");
    console.log("Rank |  ER  | Fast | Slow | Area   | Fill%  | Norm A | Norm F | Combined");
    console.log("─────┼──────┼──────┼──────┼────────┼────────┼────────┼────────┼──────────");

    for (let i = 0; i < Math.min(30, results.length); i++) {
        const r = results[i];
        console.log(
            `${(i + 1).toString().padStart(4)} | ` +
            `${r.er.toFixed(1).padStart(5)} | ` +
            `${r.fast.toFixed(1).padStart(4)} | ` +
            `${r.slow.toFixed(1).padStart(4)} | ` +
            `${r.totalArea.toFixed(2).padStart(6)} | ` +
            `${r.fillEfficiency.toFixed(1).padStart(6)} | ` +
            `${r.normalizedArea.toFixed(1).padStart(6)} | ` +
            `${r.normalizedEfficiency.toFixed(1).padStart(6)} | ` +
            `${r.combinedScore.toFixed(1).padStart(8)}`
        );
    }

    // Detailed analysis of top 5
    console.log("\n================================================================================");
    console.log("DETAILED ANALYSIS - TOP 5 CONFIGURATIONS");
    console.log("================================================================================\n");

    for (let i = 0; i < Math.min(5, results.length); i++) {
        const r = results[i];
        console.log(`🏆 RANK #${i + 1}:`);
        console.log(`   Parameters: ER=${r.er.toFixed(1)}, Fast=${r.fast.toFixed(1)}, Slow=${r.slow.toFixed(1)}`);
        console.log(`\n   METRIC 1 - OSCILLATION AREA (Opportunity):`);
        console.log(`   ├─ Total Area: ${r.totalArea.toFixed(2)}%`);
        console.log(`   ├─ Area Above: ${r.areaAbove.toFixed(2)}%`);
        console.log(`   ├─ Area Below: ${r.areaBelow.toFixed(2)}%`);
        console.log(`   ├─ Max Distance UP: ${(r.maxDriftUp * 100).toFixed(2)}%`);
        console.log(`   ├─ Max Distance DOWN: ${(r.maxDriftDown * 100).toFixed(2)}%`);
        console.log(`   └─ NORMALIZED SCORE: ${r.normalizedArea.toFixed(1)}/100`);
        console.log(`\n   METRIC 2 - FILL EFFICIENCY (Profitability):`);
        console.log(`   ├─ Order Fill Rate: ${r.fillEfficiency.toFixed(1)}%`);
        console.log(`   ├─ Matched Orders: ${r.matchedCount}`);
        console.log(`   ├─ Total Orders: ${r.totalOrders}`);
        console.log(`   └─ NORMALIZED SCORE: ${r.normalizedEfficiency.toFixed(1)}/100`);
        console.log(`\n   COMBINED SCORE: ${r.combinedScore.toFixed(1)}/100`);
        console.log(`   └─ Average of Area (${r.normalizedArea.toFixed(1)}) + Efficiency (${r.normalizedEfficiency.toFixed(1)})\n`);
    }

    // Comparison with integer-only optimization
    console.log("================================================================================");
    console.log("COMPARISON: Integer vs High-Resolution Optimization");
    console.log("================================================================================\n");

    const topHR = results[0];
    console.log("HIGH-RESOLUTION (This Run):");
    console.log(`  ER=${topHR.er.toFixed(1)}, Fast=${topHR.fast.toFixed(1)}, Slow=${topHR.slow.toFixed(1)}`);
    console.log(`  ├─ Area: ${topHR.totalArea.toFixed(2)}%`);
    console.log(`  ├─ Fill: ${topHR.fillEfficiency.toFixed(1)}%`);
    console.log(`  └─ Combined: ${topHR.combinedScore.toFixed(1)}/100 ✓\n`);

    console.log("Previous INTEGER-ONLY Best (ER=100, Fast=2, Slow=30):");
    console.log(`  ├─ Area: 37.12%`);
    console.log(`  ├─ Fill: 50.0%`);
    console.log(`  └─ Combined: 78.2/100\n`);

    const improvement = ((topHR.combinedScore - 78.2) / 78.2 * 100).toFixed(1);
    if (topHR.combinedScore > 78.2) {
        console.log(`✅ IMPROVEMENT: +${improvement}% better combined score!\n`);
    } else {
        console.log(`ℹ️  Similar performance: ${improvement}% difference\n`);
    }

    // Save results
    const outputFile = path.join(__dirname, 'optimization_results_high_resolution.json');
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

    console.log("================================================================================");
    console.log(`✅ Full results saved to: optimization_results_high_resolution.json`);
    console.log(`   Total entries: ${results.length}\n`);
}

run();
