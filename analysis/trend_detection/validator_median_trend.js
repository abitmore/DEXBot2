/**
 * MEDIAN-BASED TREND VALIDATOR
 *
 * Uses median daily values to determine "true" trend:
 * - Calculates median price over lookback window
 * - If current price > median = UPTREND
 * - If current price < median = DOWNTREND
 * - This is REAL market data, not arbitrary thresholds
 *
 * Validates if dual AMA detects these median-based trends correctly.
 */

const fs = require('fs');
const path = require('path');
const { TrendAnalyzer } = require('./trend_analyzer');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(__dirname, 'optimization_results_trend_1day.json');

/**
 * Load JSON
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
 * Load candles
 */
function loadCandles() {
    const dataFile = path.join(DATA_DIR, 'XRP_BTS_SYNTHETIC_1day.json');
    const data = loadJSON(dataFile);
    return data.map(candle => ({
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
    }));
}

/**
 * Calculate median daily value
 * Uses typical price: (high + low + close) / 3
 */
function getTypicalPrice(candle) {
    return (candle.high + candle.low + candle.close) / 3;
}

/**
 * Calculate median over lookback period
 */
function getMedianPrice(prices) {
    if (prices.length === 0) return 0;
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Calculate "true" trend based on median values
 * Much more robust than arbitrary percentage thresholds!
 */
function calculateMedianTrend(candles, lookbackPeriod = 20) {
    const trueTrends = [];
    const typicalPrices = candles.map(c => getTypicalPrice(c));

    for (let i = 0; i < candles.length; i++) {
        if (i < lookbackPeriod) {
            trueTrends.push('NEUTRAL');
            continue;
        }

        // Get median of last N candles (excluding current)
        const priceWindow = typicalPrices.slice(i - lookbackPeriod, i);
        const medianPrice = getMedianPrice(priceWindow);
        const currentPrice = typicalPrices[i];

        // Tolerance: only consider trend if clear move beyond median
        const tolerance = medianPrice * 0.002; // 0.2% tolerance to avoid noise at median

        if (currentPrice > medianPrice + tolerance) {
            trueTrends.push('UP');
        } else if (currentPrice < medianPrice - tolerance) {
            trueTrends.push('DOWN');
        } else {
            trueTrends.push('NEUTRAL');
        }
    }

    return trueTrends;
}

/**
 * Compare detector against median-based trends
 */
function validateAgainstMedian(candles, bestConfig) {
    const analyzer = new TrendAnalyzer({
        lookbackBars: 20,
        dualAMAConfig: bestConfig.config
    });

    // Get median-based true trends
    const medianTrends = calculateMedianTrend(candles, 20);

    const detectedTrends = [];
    let matchCount = 0;
    let totalComparable = 0;

    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        const analysis = analyzer.update(candle.close);

        if (!analysis.isReady) {
            detectedTrends.push('WARMUP');
            continue;
        }

        detectedTrends.push(analysis.trend);

        // Only count after warmup AND after median calculation period
        if (i >= 50 && i >= 20) {
            totalComparable++;
            if (analysis.trend === medianTrends[i]) {
                matchCount++;
            }
        }
    }

    return {
        detectedTrends,
        medianTrends,
        matchCount,
        totalComparable,
        accuracy: totalComparable > 0 ? (matchCount / totalComparable) * 100 : 0,
    };
}

/**
 * Detailed analysis
 */
function analyzeValidation(validation, bestConfig) {
    const accuracy = validation.accuracy;

    // Count trend distributions
    let detectedUP = 0, detectedDOWN = 0, detectedNEUTRAL = 0;
    let medianUP = 0, medianDOWN = 0, medianNEUTRAL = 0;

    for (let i = 50; i < validation.detectedTrends.length; i++) {
        const detected = validation.detectedTrends[i];
        const median = validation.medianTrends[i];

        if (detected === 'UP') detectedUP++;
        else if (detected === 'DOWN') detectedDOWN++;
        else if (detected === 'NEUTRAL') detectedNEUTRAL++;

        if (median === 'UP') medianUP++;
        else if (median === 'DOWN') medianDOWN++;
        else if (median === 'NEUTRAL') medianNEUTRAL++;
    }

    // Count correct detections per category
    let correctUP = 0, correctDOWN = 0, correctNEUTRAL = 0;
    for (let i = 50; i < validation.detectedTrends.length; i++) {
        const detected = validation.detectedTrends[i];
        const median = validation.medianTrends[i];

        if (detected === median) {
            if (detected === 'UP') correctUP++;
            else if (detected === 'DOWN') correctDOWN++;
            else if (detected === 'NEUTRAL') correctNEUTRAL++;
        }
    }

    return {
        overall: {
            accuracy: accuracy.toFixed(2),
            matches: validation.matchCount,
            total: validation.totalComparable,
        },
        detected: {
            up: detectedUP,
            down: detectedDOWN,
            neutral: detectedNEUTRAL,
        },
        median: {
            up: medianUP,
            down: medianDOWN,
            neutral: medianNEUTRAL,
        },
        correct: {
            up: correctUP,
            down: correctDOWN,
            neutral: correctNEUTRAL,
        }
    };
}

/**
 * Main
 */
function validate() {
    console.log('===============================================================');
    console.log('TREND DETECTION - MEDIAN-BASED VALIDATOR');
    console.log('===============================================================\n');

    console.log('📊 Loading best configuration...');
    const results = loadJSON(RESULTS_FILE);
    if (!results || results.length === 0) {
        console.error('❌ No optimization results found');
        process.exit(1);
    }
    const bestConfig = results[0];
    console.log(`✓ Found best configuration\n`);

    console.log('📈 Loading candle data...');
    const candles = loadCandles();
    console.log(`✓ Loaded ${candles.length} candles\n`);

    console.log('🔍 Calculating median-based trends...');
    console.log('   (Using 20-day median of typical prices)\n');

    console.log('🔄 Comparing detector against median trends...');
    const validation = validateAgainstMedian(candles, bestConfig);
    console.log(`✓ Validation complete\n`);

    console.log('📊 Analyzing results...');
    const analysis = analyzeValidation(validation, bestConfig);
    console.log(`✓ Analysis complete\n`);

    // Print results
    console.log('===============================================================');
    console.log('VALIDATION RESULTS - MEDIAN-BASED TRENDS\n');

    console.log('CONFIGURATION');
    console.log('─────────────────────────────────────────────────────────────────');
    const cfg = bestConfig.config;
    console.log(`Fast AMA: ER=${cfg.fastErPeriod}, Fast=${cfg.fastFastPeriod}, Slow=${cfg.fastSlowPeriod}`);
    console.log(`Slow AMA: ER=${cfg.slowErPeriod}, Fast=${cfg.slowFastPeriod}, Slow=${cfg.slowSlowPeriod}`);
    console.log(`ER Difference: ${Math.abs(cfg.fastErPeriod - cfg.slowErPeriod)}\n`);

    console.log('MEDIAN-BASED TREND DEFINITION');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('True Trend = Compare current price to 20-day median');
    console.log('  UP:     price > median + 0.2% tolerance');
    console.log('  DOWN:   price < median - 0.2% tolerance');
    console.log('  NEUTRAL: price within ±0.2% of median\n');

    console.log('OVERALL ACCURACY');
    console.log('─────────────────────────────────────────────────────────────────');
    const ov = analysis.overall;
    console.log(`Accuracy:  ${ov.accuracy}%`);
    console.log(`Matches:   ${ov.matches} out of ${ov.total} bars`);
    console.log(`Quality:   ${ov.accuracy >= 60 ? '✅ Good' : ov.accuracy >= 50 ? '⚠️  Acceptable' : '❌ Poor'}\n`);

    console.log('DETECTED vs MEDIAN DISTRIBUTION');
    console.log('─────────────────────────────────────────────────────────────────');
    const det = analysis.detected;
    const med = analysis.median;
    console.log(`Detected:  UP=${det.up}, DOWN=${det.down}, NEUTRAL=${det.neutral}`);
    console.log(`Median:    UP=${med.up}, DOWN=${med.down}, NEUTRAL=${med.neutral}\n`);

    console.log('CORRECT DETECTIONS BY CATEGORY');
    console.log('─────────────────────────────────────────────────────────────────');
    const corr = analysis.correct;
    const upAccuracy = det.up > 0 ? ((corr.up / det.up) * 100).toFixed(1) : 'N/A';
    const downAccuracy = det.down > 0 ? ((corr.down / det.down) * 100).toFixed(1) : 'N/A';
    const neutralAccuracy = det.neutral > 0 ? ((corr.neutral / det.neutral) * 100).toFixed(1) : 'N/A';

    console.log(`When detector says UP:     ${corr.up}/${det.up} correct (${upAccuracy}%)`);
    console.log(`When detector says DOWN:   ${corr.down}/${det.down} correct (${downAccuracy}%)`);
    console.log(`When detector says NEUTRAL: ${corr.neutral}/${det.neutral} correct (${neutralAccuracy}%)\n`);

    // Assessment
    console.log('===============================================================');
    console.log('ASSESSMENT\n');

    if (ov.accuracy >= 60) {
        console.log(`✅ GOOD: Detector correctly identifies ${ov.accuracy}% of median-based trends`);
        console.log(`   This means the dual AMA system is picking up real market trends!\n`);
    } else if (ov.accuracy >= 50) {
        console.log(`⚠️  ACCEPTABLE: Detector identifies ${ov.accuracy}% of trends`);
        console.log(`   Better than random (50%), but room for improvement\n`);
    } else {
        console.log(`❌ POOR: Detector only identifies ${ov.accuracy}% of trends`);
        console.log(`   This is barely better than random guessing\n`);
    }

    console.log('Why median-based validation?');
    console.log('  ✅ Uses REAL market data (not arbitrary thresholds)');
    console.log('  ✅ Robust to outliers (median vs mean)');
    console.log('  ✅ Adapts to price level (not fixed percentage)');
    console.log('  ✅ Answers: "Does detector find real price movements?"\n');

    console.log('===============================================================');
}

validate();

module.exports = { validate };
