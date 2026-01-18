/**
 * TREND DETECTION OPTIMIZER
 *
 * Tests different AMA parameter combinations to find the best settings
 * for detecting uptrends and downtrends with high precision.
 *
 * Scoring based on:
 * - Accuracy: % of candles where detected trend matches actual trend
 * - Signal Quality: Fewer false signals, sustained trend detection
 * - Trend Changes: Clean, clear trend change detection
 *
 * Output: optimization_results_trend_1day.json (all results ranked)
 */

const fs = require('fs');
const path = require('path');
const { TrendAnalyzer } = require('./trend_analyzer');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(__dirname, 'optimization_results_trend_1day.json');

/**
 * Load candle data
 */
function loadData() {
    const dataFile = path.join(DATA_DIR, 'XRP_BTS_SYNTHETIC_1day.json');

    if (!fs.existsSync(dataFile)) {
        console.error(`❌ Data file not found: ${dataFile}`);
        console.error('Run: node fetch_1day_candles.js');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    console.log(`✓ Loaded ${data.length} 1-day candles`);

    // Return full candle structure: [timestamp, open, high, low, close, volume]
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
 * Calculate "true" trend using MEDIAN PRICE LEVELS
 * True trend = compare current price to 20-day median
 * This is based on REAL market data, not arbitrary thresholds
 */
function calculateTrueTrend(candles, lookbackPeriod = 20) {
    const trueTrends = [];

    for (let i = 0; i < candles.length; i++) {
        if (i < lookbackPeriod) {
            trueTrends.push('NEUTRAL');
            continue;
        }

        // Get median of last N closes (excluding current)
        const priceWindow = candles.slice(i - lookbackPeriod, i).map(c => c.close);
        const sorted = [...priceWindow].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianPrice = sorted.length % 2
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;

        const currentPrice = candles[i].close;

        // Tolerance: 0.2% to avoid noise at median
        const tolerance = medianPrice * 0.002;

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
 * Test a single parameter combination
 */
function testConfiguration(candles, config, usePriceActionFilter = false) {
    try {
        const analyzer = new TrendAnalyzer({
            lookbackBars: 20,
            dualAMAConfig: config.dualAMAConfig,
            usePriceActionFilter: usePriceActionFilter,
        });

        const detectedTrends = [];
        let confirmedTrendsCount = 0;
        let trendChangeCount = 0;
        let lastTrend = 'NEUTRAL';

        // Feed all candles with high/low data
        for (const candle of candles) {
            analyzer.update(candle.close, candle.high, candle.low);
            const analysis = analyzer.getAnalysis();

            if (analysis.isReady) {
                detectedTrends.push(analysis.trend);

                if (analysis.trend !== lastTrend) {
                    trendChangeCount++;
                }
                if (analysis.isConfirmed) {
                    confirmedTrendsCount++;
                }
                lastTrend = analysis.trend;
            }
        }

        return {
            detectedTrends,
            confirmedTrendsCount,
            trendChangeCount,
            readyAfter: 50, // warmup period
        };
    } catch (e) {
        return null;
    }
}

/**
 * Calculate accuracy score
 */
function calculateScore(detectedTrends, trueTrends, config) {
    // Only compare from where detector is ready
    const readyAfter = 50;
    const slice = detectedTrends.slice(readyAfter - 1);
    const truthSlice = trueTrends.slice(readyAfter - 1);

    if (slice.length === 0) return 0;

    // Accuracy: % of correct trend detections
    let correctCount = 0;
    for (let i = 0; i < slice.length; i++) {
        if (slice[i] === truthSlice[i]) {
            correctCount++;
        }
    }
    const accuracy = (correctCount / slice.length) * 100;

    // Count confirmed signals only (higher quality)
    let confirmedMatches = 0;
    let confirmedCount = 0;
    for (let i = readyAfter - 1; i < detectedTrends.length; i++) {
        // Simplified: count as confirmed if we detect sustained trend
        if (detectedTrends[i] !== 'NEUTRAL') {
            confirmedCount++;
            if (detectedTrends[i] === trueTrends[i]) {
                confirmedMatches++;
            }
        }
    }

    const confirmedAccuracy = confirmedCount > 0
        ? (confirmedMatches / confirmedCount) * 100
        : 0;

    // Combined score: 60% accuracy + 40% confirmed accuracy (prefer confirmed signals)
    const combinedScore = accuracy * 0.6 + confirmedAccuracy * 0.4;

    return {
        accuracy: Math.round(accuracy * 100) / 100,
        confirmedAccuracy: Math.round(confirmedAccuracy * 100) / 100,
        score: Math.round(combinedScore * 100) / 100,
        confirmedSignals: confirmedCount,
    };
}

/**
 * Generate parameter combinations to test
 * WITH DIVERSITY CONSTRAINT: Fast and Slow AMAs must be significantly different
 * EXPANDED RANGES and HIGHER RESOLUTION for more thorough optimization
 */
function generateConfigurations() {
    const configs = [];

    // Fast AMA parameters - should be HIGH ER (responsive)
    // EXPANDED: Now testing 8 values instead of 6
    const fastErPeriods = [50, 60, 70, 80, 90, 100, 110, 120];
    const fastFastPeriods = [2, 3, 4, 5];  // EXPANDED: Added 4, 5
    const fastSlowPeriods = [10, 15, 20, 25, 30];  // EXPANDED: Added 25, 30

    // Slow AMA parameters - should be LOW ER (conservative)
    // EXPANDED: Now testing more values
    const slowErPeriods = [5, 10, 15, 20, 25];  // EXPANDED: Added 25
    const slowFastPeriods = [2, 3];
    const slowSlowPeriods = [20, 25, 30, 35];  // EXPANDED: Added 20

    // Generate combinations WITH DIVERSITY CONSTRAINT
    for (const fastEr of fastErPeriods) {
        for (const fastFast of fastFastPeriods) {
            for (const fastSlow of fastSlowPeriods) {
                for (const slowEr of slowErPeriods) {
                    // CONSTRAINT: ER difference must be >= 30 for good divergence
                    const erDiff = Math.abs(fastEr - slowEr);
                    if (erDiff < 30) continue;  // Skip if AMAs too similar

                    for (const slowFast of slowFastPeriods) {
                        for (const slowSlow of slowSlowPeriods) {
                            configs.push({
                                dualAMAConfig: {
                                    fastErPeriod: fastEr,
                                    fastFastPeriod: fastFast,
                                    fastSlowPeriod: fastSlow,
                                    slowErPeriod: slowEr,
                                    slowFastPeriod: slowFast,
                                    slowSlowPeriod: slowSlow,
                                }
                            });
                        }
                    }
                }
            }
        }
    }

    return configs;
}

/**
 * Run optimization
 */
async function optimize() {
    console.log('=== TREND DETECTION OPTIMIZER ===\n');

    // Load data
    console.log('Loading data...');
    const candles = loadData();

    // Calculate true trends for scoring
    console.log('Calculating reference trends...');
    const trueTrends = calculateTrueTrend(candles, 10);

    // Generate configurations
    console.log('\nGenerating parameter combinations...');
    const configs = generateConfigurations();
    console.log(`Testing ${configs.length} configurations...\n`);

    // Test each configuration
    const results = [];
    let tested = 0;

    for (let i = 0; i < configs.length; i++) {
        const config = configs[i];

        // Test configuration WITHOUT price action filter (baseline)
        const testResult = testConfiguration(candles, config, false);

        if (testResult) {
            // Calculate score
            const score = calculateScore(testResult.detectedTrends, trueTrends, config);

            results.push({
                rank: 0, // Will be assigned after sorting
                config: config.dualAMAConfig,
                metrics: {
                    accuracy: score.accuracy,
                    confirmedAccuracy: score.confirmedAccuracy,
                    confirmedSignals: score.confirmedSignals,
                    score: score.score,
                },
                detection: {
                    trendChanges: testResult.trendChangeCount,
                    confirmedTrends: testResult.confirmedTrendsCount,
                }
            });

            tested++;

            // Progress indicator
            if ((i + 1) % 50 === 0) {
                console.log(`  Tested ${i + 1}/${configs.length}...`);
            }
        }
    }

    // Sort by score (descending)
    results.sort((a, b) => b.metrics.score - a.metrics.score);

    // Assign ranks
    results.forEach((r, i) => {
        r.rank = i + 1;
    });

    // Save results
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

    console.log(`\n✅ Tested ${tested} configurations`);
    console.log(`📊 Results saved to: ${path.basename(RESULTS_FILE)}`);

    // Show top 10
    console.log('\n=== TOP 10 CONFIGURATIONS ===\n');
    console.log('⚠️  These scores are used for RANKING only.');
    console.log('For REAL performance metrics, run: node backtest_trend_detection.js\n');
    for (let i = 0; i < Math.min(10, results.length); i++) {
        const r = results[i];
        const cfg = r.config;
        const erDiff = Math.abs(cfg.fastErPeriod - cfg.slowErPeriod);
        console.log(`#${r.rank} - Score: ${r.metrics.score}/100`);
        console.log(`    Fast AMA: ER=${cfg.fastErPeriod}, Fast=${cfg.fastFastPeriod}, Slow=${cfg.fastSlowPeriod}`);
        console.log(`    Slow AMA: ER=${cfg.slowErPeriod}, Fast=${cfg.slowFastPeriod}, Slow=${cfg.slowSlowPeriod}`);
        console.log(`    ER Difference: ${erDiff} (>30 = good divergence)`);
        console.log('');
    }

    // Show statistics
    console.log('=== OPTIMIZATION STATISTICS ===');
    const scores = results.map(r => r.metrics.score);
    console.log(`  Tested: ${tested} configurations`);
    console.log(`  Best Score: ${Math.max(...scores).toFixed(2)}/100`);
    console.log(`  Avg Score: ${(scores.reduce((a, b) => a + b) / scores.length).toFixed(2)}/100`);
    console.log(`  Worst Score: ${Math.min(...scores).toFixed(2)}/100`);

    return results;
}

// Run
optimize().catch(console.error);

module.exports = { optimize };
