/**
 * TREND DETECTION BACKTEST
 *
 * Backtests the best dual-AMA trend detection configuration on historical data.
 * Simulates trades based on trend signals and calculates performance metrics.
 *
 * Input: Best configuration from optimizer + 1-day candle data
 * Output: Backtest report with statistics and metrics
 */

const fs = require('fs');
const path = require('path');
const { TrendAnalyzer } = require('./trend_analyzer');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(__dirname, 'optimization_results_trend_1day.json');
const BACKTEST_OUTPUT = path.join(__dirname, 'backtest_results_trend_1day.json');
const REPORT_OUTPUT = path.join(__dirname, 'backtest_report_trend_1day.txt');

/**
 * Load JSON file
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
        return null;
    }

    const data = loadJSON(dataFile);
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
 * Get best configuration
 */
function getBestConfiguration() {
    if (!fs.existsSync(RESULTS_FILE)) {
        console.error(`❌ Results file not found: ${RESULTS_FILE}`);
        return null;
    }

    const results = loadJSON(RESULTS_FILE);
    return results && results.length > 0 ? results[0] : null;
}

/**
 * Run backtest
 */
function runBacktest(candles, bestConfig, usePriceActionFilter = false) {
    const analyzer = new TrendAnalyzer({
        lookbackBars: 20,
        dualAMAConfig: bestConfig.config,
        usePriceActionFilter: usePriceActionFilter
    });

    const trades = [];
    let currentPosition = null; // { entry_index, entry_price, entry_trend }
    let lastTrend = 'NEUTRAL';

    const stats = {
        totalCandles: candles.length,
        trades: [],
        wins: 0,
        losses: 0,
        breakeven: 0,
        totalProfit: 0,
        totalLoss: 0,
        maxWin: 0,
        maxLoss: 0,
        uptrends: 0,
        downtrends: 0,
        neutrals: 0,
        trendChanges: 0,
    };

    // Backtest loop
    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        const analysis = analyzer.update(candle.close, candle.high, candle.low);

        if (!analysis.isReady) continue;

        const trend = analysis.trend;

        // Count trends
        if (trend === 'UP') stats.uptrends++;
        else if (trend === 'DOWN') stats.downtrends++;
        else stats.neutrals++;

        // Track trend changes
        if (trend !== lastTrend && lastTrend !== 'NEUTRAL') {
            stats.trendChanges++;
        }

        // Generate signals on trend changes
        if (trend !== lastTrend) {
            // Exit current position if any
            if (currentPosition) {
                const exit = {
                    entry_index: currentPosition.entry_index,
                    exit_index: i,
                    entry_price: currentPosition.entry_price,
                    exit_price: candle.close,
                    entry_date: new Date(candles[currentPosition.entry_index].timestamp).toISOString().split('T')[0],
                    exit_date: new Date(candle.timestamp).toISOString().split('T')[0],
                    days_held: i - currentPosition.entry_index,
                    pnl_percent: ((candle.close - currentPosition.entry_price) / currentPosition.entry_price) * 100,
                    pnl_absolute: candle.close - currentPosition.entry_price,
                };

                exit.pnl = exit.pnl_percent > 0 ? 'WIN' : exit.pnl_percent < 0 ? 'LOSS' : 'BREAKEVEN';

                if (exit.pnl === 'WIN') {
                    stats.wins++;
                    stats.totalProfit += exit.pnl_percent;
                    stats.maxWin = Math.max(stats.maxWin, exit.pnl_percent);
                } else if (exit.pnl === 'LOSS') {
                    stats.losses++;
                    stats.totalLoss += exit.pnl_percent;
                    stats.maxLoss = Math.min(stats.maxLoss, exit.pnl_percent);
                } else {
                    stats.breakeven++;
                }

                stats.trades.push(exit);
                currentPosition = null;
            }

            // Enter new position
            if (trend === 'UP' || trend === 'DOWN') {
                currentPosition = {
                    entry_index: i,
                    entry_price: candle.close,
                    entry_trend: trend,
                };
            }

            lastTrend = trend;
        }
    }

    // Close final position at end
    if (currentPosition) {
        const lastCandle = candles[candles.length - 1];
        const exit = {
            entry_index: currentPosition.entry_index,
            exit_index: candles.length - 1,
            entry_price: currentPosition.entry_price,
            exit_price: lastCandle.close,
            entry_date: new Date(candles[currentPosition.entry_index].timestamp).toISOString().split('T')[0],
            exit_date: new Date(lastCandle.timestamp).toISOString().split('T')[0],
            days_held: candles.length - 1 - currentPosition.entry_index,
            pnl_percent: ((lastCandle.close - currentPosition.entry_price) / currentPosition.entry_price) * 100,
            pnl_absolute: lastCandle.close - currentPosition.entry_price,
        };

        exit.pnl = exit.pnl_percent > 0 ? 'WIN' : exit.pnl_percent < 0 ? 'LOSS' : 'BREAKEVEN';

        if (exit.pnl === 'WIN') {
            stats.wins++;
            stats.totalProfit += exit.pnl_percent;
            stats.maxWin = Math.max(stats.maxWin, exit.pnl_percent);
        } else if (exit.pnl === 'LOSS') {
            stats.losses++;
            stats.totalLoss += exit.pnl_percent;
            stats.maxLoss = Math.min(stats.maxLoss, exit.pnl_percent);
        } else {
            stats.breakeven++;
        }

        stats.trades.push(exit);
    }

    return {
        config: bestConfig.config,
        score: bestConfig.metrics.score,
        accuracy: bestConfig.metrics.accuracy,
        confirmed_accuracy: bestConfig.metrics.confirmedAccuracy,
        stats,
        trades: stats.trades
    };
}

/**
 * Calculate additional metrics
 */
function calculateMetrics(backtest) {
    const s = backtest.stats;
    const trades = s.trades;

    const metrics = {
        totalTrades: trades.length,
        winRate: trades.length > 0 ? (s.wins / trades.length * 100).toFixed(2) : 0,
        lossRate: trades.length > 0 ? (s.losses / trades.length * 100).toFixed(2) : 0,
        breakevenRate: trades.length > 0 ? (s.breakeven / trades.length * 100).toFixed(2) : 0,
        avgWinPercent: s.wins > 0 ? (s.totalProfit / s.wins).toFixed(3) : 0,
        avgLossPercent: s.losses > 0 ? (s.totalLoss / s.losses).toFixed(3) : 0,
        totalReturnPercent: (s.totalProfit + s.totalLoss).toFixed(2),
        maxWinPercent: s.maxWin.toFixed(3),
        maxLossPercent: s.maxLoss.toFixed(3),
        profitFactor: s.losses === 0 ? 'Inf' : (Math.abs(s.totalProfit) / Math.abs(s.totalLoss)).toFixed(2),
        avgTradeLength: trades.length > 0 ? (trades.reduce((sum, t) => sum + t.days_held, 0) / trades.length).toFixed(1) : 0,
        medianTradeLength: trades.length > 0 ? calculateMedian(trades.map(t => t.days_held)) : 0,
    };

    return metrics;
}

/**
 * Calculate median
 */
function calculateMedian(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1);
}

/**
 * Format and print report
 */
function generateReport(backtest, metrics) {
    const s = backtest.stats;
    const cfg = backtest.config;

    let report = '';
    report += '═════════════════════════════════════════════════════════════════\n';
    report += 'TREND DETECTION - BACKTEST REPORT (REAL VALIDATION)\n';
    report += '═════════════════════════════════════════════════════════════════\n\n';

    // Configuration
    report += 'CONFIGURATION\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    report += `Optimizer Score:           ${backtest.score}/100 (ranking only)\n`;
    report += `Fast AMA:  ER=${cfg.fastErPeriod}, Fast=${cfg.fastFastPeriod}, Slow=${cfg.fastSlowPeriod}\n`;
    report += `Slow AMA:  ER=${cfg.slowErPeriod}, Fast=${cfg.slowFastPeriod}, Slow=${cfg.slowSlowPeriod}\n\n`;

    // Backtest Period
    report += 'BACKTEST PERIOD\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    report += `Total Candles:             ${s.totalCandles}\n`;
    report += `Uptrend Bars:              ${s.uptrends} (${(s.uptrends/s.totalCandles*100).toFixed(1)}%)\n`;
    report += `Downtrend Bars:            ${s.downtrends} (${(s.downtrends/s.totalCandles*100).toFixed(1)}%)\n`;
    report += `Neutral Bars:              ${s.neutrals} (${(s.neutrals/s.totalCandles*100).toFixed(1)}%)\n`;
    report += `Trend Changes:             ${s.trendChanges}\n\n`;

    // Trade Statistics
    report += 'TRADE STATISTICS\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    report += `Total Trades:              ${metrics.totalTrades}\n`;
    report += `Wins:                      ${s.wins}\n`;
    report += `Losses:                    ${s.losses}\n`;
    report += `Breakeven:                 ${s.breakeven}\n`;
    report += `Win Rate:                  ${metrics.winRate}%\n`;
    report += `Loss Rate:                 ${metrics.lossRate}%\n`;
    report += `Breakeven Rate:            ${metrics.breakevenRate}%\n\n`;

    // Performance Metrics
    report += 'PERFORMANCE METRICS\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    report += `Total Return:              ${metrics.totalReturnPercent}%\n`;
    report += `Avg Win:                   ${metrics.avgWinPercent}%\n`;
    report += `Avg Loss:                  ${metrics.avgLossPercent}%\n`;
    report += `Max Win:                   ${metrics.maxWinPercent}%\n`;
    report += `Max Loss:                  ${metrics.maxLossPercent}%\n`;
    report += `Profit Factor:             ${metrics.profitFactor}\n\n`;

    // Trade Duration
    report += 'TRADE DURATION\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    report += `Avg Days Per Trade:        ${metrics.avgTradeLength} days\n`;
    report += `Median Days Per Trade:     ${metrics.medianTradeLength} days\n\n`;

    // Top Trades
    report += 'TOP 5 WINNING TRADES\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    const topWins = s.trades
        .filter(t => t.pnl === 'WIN')
        .sort((a, b) => b.pnl_percent - a.pnl_percent)
        .slice(0, 5);

    if (topWins.length > 0) {
        topWins.forEach((trade, i) => {
            report += `${i + 1}. ${trade.entry_date} → ${trade.exit_date}: +${trade.pnl_percent.toFixed(2)}% (${trade.days_held}d)\n`;
        });
    } else {
        report += 'No winning trades\n';
    }
    report += '\n';

    // Top Losses
    report += 'TOP 5 LOSING TRADES\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    const topLosses = s.trades
        .filter(t => t.pnl === 'LOSS')
        .sort((a, b) => a.pnl_percent - b.pnl_percent)
        .slice(0, 5);

    if (topLosses.length > 0) {
        topLosses.forEach((trade, i) => {
            report += `${i + 1}. ${trade.entry_date} → ${trade.exit_date}: ${trade.pnl_percent.toFixed(2)}% (${trade.days_held}d)\n`;
        });
    } else {
        report += 'No losing trades\n';
    }
    report += '\n';

    // Real Metrics Explanation
    report += 'METRICS EXPLAINED\n';
    report += '─────────────────────────────────────────────────────────────────\n';
    report += 'Win Rate: % of trades that were profitable\n';
    report += 'Profit Factor: Total profit / Total loss (>2.0 is good, >10 is excellent)\n';
    report += 'Total Return: Sum of all trade returns\n';
    report += 'These are the REAL metrics that matter for trading!\n\n';

    // Summary
    report += '═════════════════════════════════════════════════════════════════\n';
    report += 'SUMMARY\n';
    report += '═════════════════════════════════════════════════════════════════\n';
    if (metrics.totalTrades === 0) {
        report += 'No trades executed (no confirmed trends detected)\n';
    } else {
        report += `Executed ${metrics.totalTrades} trades with ${metrics.winRate}% win rate\n`;
        report += `Total return: ${metrics.totalReturnPercent}% over ${s.totalCandles} days\n`;
        if (metrics.totalReturnPercent > 0) {
            report += `✅ PROFITABLE: Configuration generated positive returns\n`;
        } else if (metrics.totalReturnPercent < 0) {
            report += `❌ UNPROFITABLE: Configuration generated losses\n`;
        } else {
            report += `⚪ BREAKEVEN: No net profit or loss\n`;
        }
    }
    report += '\n';

    return report;
}

/**
 * Main function
 */
function backtest() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('TREND DETECTION - BACKTEST');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Get best configuration
    console.log('📊 Loading best configuration...');
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

    // Run backtest WITHOUT price action filter (baseline)
    console.log('🔄 Running backtest (BASELINE - no price action filter)...');
    const backtest_result = runBacktest(candles, bestConfig, false);
    console.log(`✓ Backtest complete\n`);

    // Run backtest WITH price action filter
    console.log('🔄 Running backtest (WITH PRICE ACTION FILTER)...');
    const backtest_result_paf = runBacktest(candles, bestConfig, true);
    console.log(`✓ Backtest with price action filter complete\n`);

    // Calculate metrics for both versions
    console.log('📊 Calculating metrics...');
    const metrics_baseline = calculateMetrics(backtest_result);
    const metrics_paf = calculateMetrics(backtest_result_paf);
    console.log(`✓ Metrics calculated\n`);

    // Generate reports
    console.log('📝 Generating reports...');
    const report_baseline = generateReport(backtest_result, metrics_baseline);
    const report_paf = generateReport(backtest_result_paf, metrics_paf);

    // Create comparison report
    let comparison_report = '';
    comparison_report += '═══════════════════════════════════════════════════════════════\n';
    comparison_report += 'PRICE ACTION FILTER - COMPARISON REPORT\n';
    comparison_report += '═══════════════════════════════════════════════════════════════\n\n';

    comparison_report += 'BASELINE (No Price Action Filter)\n';
    comparison_report += '─────────────────────────────────────────────────────────────────\n';
    comparison_report += `Total Trades:        ${metrics_baseline.totalTrades}\n`;
    comparison_report += `Win Rate:            ${metrics_baseline.winRate}%\n`;
    comparison_report += `Total Return:        ${metrics_baseline.totalReturnPercent}%\n`;
    comparison_report += `Profit Factor:       ${metrics_baseline.profitFactor}\n\n`;

    comparison_report += 'WITH PRICE ACTION FILTER\n';
    comparison_report += '─────────────────────────────────────────────────────────────────\n';
    comparison_report += `Total Trades:        ${metrics_paf.totalTrades}\n`;
    comparison_report += `Win Rate:            ${metrics_paf.winRate}%\n`;
    comparison_report += `Total Return:        ${metrics_paf.totalReturnPercent}%\n`;
    comparison_report += `Profit Factor:       ${metrics_paf.profitFactor}\n\n`;

    comparison_report += 'IMPROVEMENT\n';
    comparison_report += '─────────────────────────────────────────────────────────────────\n';
    const returnDiff = parseFloat(metrics_paf.totalReturnPercent) - parseFloat(metrics_baseline.totalReturnPercent);
    const tradeDiff = metrics_paf.totalTrades - metrics_baseline.totalTrades;
    const pfDiff = (metrics_paf.profitFactor !== 'Inf' && metrics_baseline.profitFactor !== 'Inf')
        ? parseFloat(metrics_paf.profitFactor) - parseFloat(metrics_baseline.profitFactor)
        : 0;

    comparison_report += `Return Change:      ${returnDiff > 0 ? '+' : ''}${returnDiff.toFixed(2)}%\n`;
    comparison_report += `Trade Count Change:  ${tradeDiff > 0 ? '+' : ''}${tradeDiff}\n`;
    comparison_report += `Profit Factor Change: ${pfDiff > 0 ? '+' : ''}${pfDiff.toFixed(2)}\n\n`;

    comparison_report += '═══════════════════════════════════════════════════════════════\n\n';

    // Save results
    fs.writeFileSync(BACKTEST_OUTPUT, JSON.stringify({
        baseline: backtest_result,
        with_price_action_filter: backtest_result_paf
    }, null, 2));
    fs.writeFileSync(REPORT_OUTPUT, comparison_report + '\n\n' + report_baseline + '\n\n' + report_paf);

    // Print comparison
    console.log(comparison_report);
    console.log(report_baseline);

    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('✅ BACKTEST COMPLETE\n');
    console.log(`   📄 Report: ${path.basename(REPORT_OUTPUT)}`);
    console.log(`   📊 Data:   ${path.basename(BACKTEST_OUTPUT)}`);
    console.log('\n═══════════════════════════════════════════════════════════════');
}

backtest();

module.exports = { backtest };
