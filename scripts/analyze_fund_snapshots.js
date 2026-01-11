#!/usr/bin/env node

/**
 * scripts/analyze_fund_snapshots.js
 *
 * CLI Tool for Fund Snapshot Analysis
 * ==================================
 * Analyzes saved fund snapshots to detect anomalies, leaks, and fund discrepancies.
 *
 * USAGE:
 *   node analyze_fund_snapshots.js --bot=BOTKEY                 # Analyze a single bot
 *   node analyze_fund_snapshots.js --bot=BOT1 --compare=BOT2   # Compare two bots
 *   node analyze_fund_snapshots.js --bot=BOTKEY --export        # Export to CSV
 *   node analyze_fund_snapshots.js --bot=BOTKEY --anomalies     # Show top anomalies
 */

const FundSnapshotPersistence = require('../modules/order/fund_snapshot_persistence');
const path = require('path');
const Format = require('../modules/order/format');

// Color codes for output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

function log(msg, color = 'reset') {
    const c = colors[color] || '';
    console.log(`${c}${msg}${colors.reset}`);
}

function heading(title) {
    log('\n' + '='.repeat(80), 'bright');
    log(title, 'bright');
    log('='.repeat(80) + '\n', 'bright');
}

function subheading(title) {
    log(`\n${title}`, 'cyan');
    log('-'.repeat(40) + '\n', 'cyan');
}

async function analyzeSingleBot(botKey) {
    log(`Analyzing snapshots for bot: ${botKey}`, 'cyan');

    const analysis = await FundSnapshotPersistence.analyzeSnapshots(botKey);

    if (analysis.status === 'error') {
        log(`❌ Error: ${analysis.message}`, 'red');
        return;
    }

    if (analysis.status === 'no_data') {
        log(`⚠️  No snapshots found for bot ${botKey}`, 'yellow');
        return;
    }

    heading(`FUND SNAPSHOT ANALYSIS: ${botKey}`);

    // Summary
    subheading('Summary');
    log(`Total Snapshots: ${analysis.summary.totalSnapshots}`, 'green');
    log(`Time Span: ${analysis.summary.timeSpanMinutes} minutes`);
    log(`Anomalies Detected: ${analysis.summary.anomaliesDetected}`);
    if (analysis.summary.hasViolations) {
        log(`⚠️  Invariant Violations Found!`, 'red');
    } else {
        log(`✅ No invariant violations`, 'green');
    }

    // Statistics
     subheading('Fund Statistics');
     if (analysis.statistics.available) {
         const { available } = analysis.statistics;
         log(`Available Buy: ${Format.formatAmount8(available.buy.latest)} (avg: ${Format.formatAmount8(available.buy.avg)}, min: ${Format.formatAmount8(available.buy.min)}, max: ${Format.formatAmount8(available.buy.max)})`, 'green');
         log(`Available Sell: ${Format.formatAmount8(available.sell.latest)} (avg: ${Format.formatAmount8(available.sell.avg)}, min: ${Format.formatAmount8(available.sell.min)}, max: ${Format.formatAmount8(available.sell.max)})`, 'green');
     }

    // Event distribution
    subheading('Event Type Distribution');
    const dist = analysis.eventTypeDistribution;
    for (const [eventType, count] of Object.entries(dist)) {
        const pct = ((count / analysis.summary.totalSnapshots) * 100).toFixed(1);
        log(`  ${eventType}: ${count} (${pct}%)`, 'gray');
    }

     // Fund trend
     subheading('Fund Trend');
     const { fundTrend } = analysis;
     log(`Buy: ${fundTrend.buy.trend} (${fundTrend.buy.change >= 0 ? '+' : ''}${Format.formatAmount8(fundTrend.buy.change)})`);
     log(`Sell: ${fundTrend.sell.trend} (${fundTrend.sell.change >= 0 ? '+' : ''}${Format.formatAmount8(fundTrend.sell.change)})`);

    // Anomalies
    if (analysis.anomalies.length > 0) {
        subheading(`Anomalies (Top ${analysis.anomalies.length})`);
        for (let i = 0; i < Math.min(5, analysis.anomalies.length); i++) {
            const anom = analysis.anomalies[i];
            if (anom.type === 'invariant_violation') {
                log(`  ❌ [${new Date(anom.timestamp).toISOString()}] Invariant violation: ${anom.eventType}`, 'red');
            } else {
                log(`  ⚠️  [${new Date(anom.timestamp).toISOString()}] ${anom.message}`, 'yellow');
            }
        }
        if (analysis.anomalies.length > 5) {
            log(`  ... and ${analysis.anomalies.length - 5} more anomalies`, 'gray');
        }
    } else {
        log('✅ No anomalies detected', 'green');
    }

     // First and last snapshots
     subheading('Snapshot Timeline');
     if (analysis.firstSnapshot) {
         log(`First: ${new Date(analysis.firstSnapshot.timestamp).toISOString()}`, 'gray');
         log(`  Event: ${analysis.firstSnapshot.eventType}`);
         log(`  Available: buy=${Format.formatAmount8(analysis.firstSnapshot.funds.available.buy)}, sell=${Format.formatAmount8(analysis.firstSnapshot.funds.available.sell)}`);
     }
     if (analysis.lastSnapshot) {
         log(`Last: ${new Date(analysis.lastSnapshot.timestamp).toISOString()}`, 'gray');
         log(`  Event: ${analysis.lastSnapshot.eventType}`);
         log(`  Available: buy=${Format.formatAmount8(analysis.lastSnapshot.funds.available.buy)}, sell=${Format.formatAmount8(analysis.lastSnapshot.funds.available.sell)}`);
     }

    heading('END ANALYSIS');
}

async function compareBots(botKey1, botKey2) {
    log(`Comparing snapshots: ${botKey1} vs ${botKey2}`, 'cyan');

    const comparison = await FundSnapshotPersistence.compareBots(botKey1, botKey2);

    if (comparison.status === 'error') {
        log(`❌ Error: ${comparison.message}`, 'red');
        return;
    }

    if (comparison.status === 'insufficient_data') {
        log(`⚠️  ${comparison.message}`, 'yellow');
        return;
    }

    heading(`BOT COMPARISON: ${botKey1} vs ${botKey2}`);

     subheading('Bot 1: ' + botKey1);
     log(`Available Buy: ${Format.formatAmount8(comparison.bot1.availableBuy)}`);
     log(`Available Sell: ${Format.formatAmount8(comparison.bot1.availableSell)}`);

     subheading('Bot 2: ' + botKey2);
     log(`Available Buy: ${Format.formatAmount8(comparison.bot2.availableBuy)}`);
     log(`Available Sell: ${Format.formatAmount8(comparison.bot2.availableSell)}`);

     subheading('Differences');
     const { difference } = comparison;
     if (difference.availableBuy > 0.00001) {
         log(`⚠️  Available Buy differs by: ${Format.formatAmount8(difference.availableBuy)}`, 'yellow');
     } else {
         log(`✅ Available Buy: Match`, 'green');
     }

     if (difference.availableSell > 0.00001) {
         log(`⚠️  Available Sell differs by: ${Format.formatAmount8(difference.availableSell)}`, 'yellow');
     } else {
         log(`✅ Available Sell: Match`, 'green');
     }

    heading('END COMPARISON');
}

async function exportToCSV(botKey) {
    log(`Exporting snapshots for ${botKey} to CSV...`, 'cyan');

    const result = await FundSnapshotPersistence.exportToCSV(botKey);

    if (result.status === 'error') {
        log(`❌ Error: ${result.message}`, 'red');
        return;
    }

    if (result.status === 'no_data') {
        log(`⚠️  No snapshots found`, 'yellow');
        return;
    }

    log(`✅ Exported ${result.rows} snapshots to:`, 'green');
    log(`   ${result.path}`, 'cyan');
}

// Parse command line arguments
const args = process.argv.slice(2);
const params = {};

for (const arg of args) {
    const [key, value] = arg.split('=');
    params[key.replace('--', '')] = value || true;
}

async function main() {
    if (!params.bot) {
        log('Usage: node analyze_fund_snapshots.js --bot=BOTKEY [OPTIONS]', 'yellow');
        log('\nOptions:', 'cyan');
        log('  --compare=BOT2         Compare with another bot');
        log('  --export               Export to CSV');
        log('  --anomalies            Show anomalies only');
        process.exit(1);
    }

    try {
        if (params.compare) {
            await compareBots(params.bot, params.compare);
        } else if (params.export) {
            await exportToCSV(params.bot);
        } else {
            await analyzeSingleBot(params.bot);
        }
    } catch (err) {
        log(`Fatal error: ${err.message}`, 'red');
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
}

main();
