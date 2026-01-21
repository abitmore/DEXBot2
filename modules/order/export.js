/**
 * modules/order/export.js
 *
 * QTradeX Export Module
 * Parses PM2 log files to extract trading history and exports to CSV format.
 * Generates standardized output compatible with QTradeX backtesting system.
 *
 * USAGE:
 *   const exporter = require('./order/export');
 *   await exporter.exportBotTrades(botKey, outputDir);
 */

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const Format = require('./format');

/**
 * Parse a fill line from PM2 log file
 * Expected format: [2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS
 */
function parseFillLine(line) {
    const fillMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\].*\[FILL\]\s+(\w+)\s+fill:\s+size=([\d.]+),\s+price=([\d.]+),\s+proceeds=([\d.]+)/);

    if (!fillMatch) return null;

    return {
        timestamp: new Date(fillMatch[1]).getTime() / 1000,  // Unix timestamp in seconds
        side: fillMatch[2],                                   // 'buy' or 'sell'
        amount: parseFloat(fillMatch[3]),                     // Size in base asset
        price: parseFloat(fillMatch[4]),                      // Execution price
        proceeds: parseFloat(fillMatch[5])                    // Proceeds/cost
    };
}

/**
 * Parse fee information from log line
 * Expected format: [2026-01-15T15:29:06.185Z] [INFO] [FEES] BTS fees calculated: 1 maker fills @ 0.04826000 BTS = 0.04826000 BTS
 */
function parseFeeLine(line) {
    const feeMatch = line.match(/\[FEES\].*?(\d+)\s+maker\s+fills\s+@\s+([\d.]+)\s+(\w+)\s*=\s*([\d.]+)\s+\w+/);

    if (!feeMatch) return null;

    return {
        count: parseInt(feeMatch[1]),
        fee_per_fill: parseFloat(feeMatch[2]),
        fee_asset: feeMatch[3],
        total_fee: parseFloat(feeMatch[4])
    };
}

/**
 * Link fill with its corresponding fee information
 */
function linkFillWithFee(fills, fees) {
    // Match most recent fill with most recent fee
    if (fills.length > 0 && fees.length > 0) {
        const lastFill = fills[fills.length - 1];
        const lastFee = fees[fees.length - 1];

        // Only link if they're close in time (within 5 seconds)
        if (Math.abs(lastFill.timestamp - lastFee.timestamp) < 5) {
            lastFill.fee_asset = lastFee.fee_asset;
            lastFill.fee_amount = lastFee.total_fee;
        }
    }
}

/**
 * Parse PM2 log file to extract trades
 * @param {string} logFilePath - Path to PM2 log file
 * @returns {Promise<Array>} Array of trade objects
 */
async function parseLogFile(logFilePath) {
    const trades = [];
    const fills = [];
    const fees = [];

    try {
        const fileStream = fs.createReadStream(logFilePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            // Parse fill lines
            const fill = parseFillLine(line);
            if (fill) {
                fill.fee_asset = 'BTS';  // Default, will be overwritten if found
                fill.fee_amount = 0;
                fills.push(fill);
                continue;
            }

            // Parse fee lines
            const fee = parseFeeLine(line);
            if (fee) {
                fee.timestamp = Date.now() / 1000;  // Approximate timestamp
                fees.push(fee);
                linkFillWithFee(fills, fees);
                continue;
            }
        }

        // Link any remaining fills with fees
        for (const fill of fills) {
            if (fill.fee_amount === 0 && fees.length > 0) {
                const relevantFee = fees.find(f => Math.abs(f.timestamp - fill.timestamp) < 5);
                if (relevantFee) {
                    fill.fee_asset = relevantFee.fee_asset;
                    fill.fee_amount = relevantFee.total_fee;
                }
            }
        }

        return fills;
    } catch (err) {
        console.error(`[EXPORT] Failed to parse log file ${logFilePath}: ${err.message}`);
        return [];
    }
}

/**
 * Write trades to CSV file in QTradeX format
 * @param {Array} trades - Array of trade objects
 * @param {string} outputPath - Path to output CSV file
 */
async function writeTradesCSV(trades, outputPath) {
    try {
        // CSV header
        const headers = ['unix', 'price', 'amount', 'side', 'fee_asset', 'fee_amount', 'order_id'];

        // CSV rows
        const rows = trades.map(trade => [
            trade.timestamp.toFixed(1),
            Format.formatPrice8(trade.price),
            Format.formatAmount8(trade.amount),
            trade.side,
            trade.fee_asset || 'BTS',
            Format.formatAmount8(trade.fee_amount || 0),
            trade.order_id || ''
        ]);

        // Combine and write
        const csv = [headers, ...rows]
            .map(row => row.map(val => {
                // Escape quotes and wrap in quotes if contains comma
                if (typeof val === 'string' && val.includes(',')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            }).join(','))
            .join('\n');

        await fs.writeFile(outputPath, csv + '\n', 'utf8');
        console.log(`✓ Exported ${trades.length} trades to ${outputPath}`);

        return { success: true, count: trades.length };
    } catch (err) {
        console.error(`[EXPORT] Failed to write CSV: ${err.message}`);
        return { success: false, error: err.message };
    }
}

/**
 * Write sanitized bot settings to JSON file
 * Excludes private keys and sensitive data
 * @param {Object} botConfig - Bot configuration object
 * @param {string} botName - Bot name
 * @param {string} outputPath - Path to output JSON file
 */
async function writeSettingsJSON(botConfig, botName, outputPath) {
    try {
        const sanitized = {
            bot_name: botName,
            strategy: botConfig.strategy || 'grid_trading',
            market: botConfig.market || `${botConfig.assetA}/${botConfig.assetB}`,
            parameters: {
                start_price: botConfig.startPrice || 'pool',
                min_price: botConfig.minPrice || '3x',
                max_price: botConfig.maxPrice || '3x',
                increment_percent: botConfig.incrementPercent || 0.5,
                target_spread_percent: botConfig.targetSpreadPercent || 2,
                active_orders: botConfig.activeOrders || { buy: 20, sell: 20 },
                bot_funds: botConfig.botFunds || { buy: '100%', sell: '100%' },
                weight_distribution: botConfig.weightDistribution || { sell: 0.5, buy: 0.5 },
                dry_run: botConfig.dryRun || false,
                active: botConfig.active !== false
            },
            assets: {
                base: botConfig.assetA,
                quote: botConfig.assetB
            },
            exported_at: new Date().toISOString()
        };

        await fs.writeFile(outputPath, JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
        console.log(`✓ Exported settings to ${outputPath}`);

        return { success: true };
    } catch (err) {
        console.error(`[EXPORT] Failed to write settings JSON: ${err.message}`);
        return { success: false, error: err.message };
    }
}

/**
 * Export bot trades from PM2 log file to CSV
 * @param {string} botKey - Bot identifier (e.g., 'xrp-bts-0')
 * @param {Object} botConfig - Bot configuration object
 * @param {string} outputDir - Output directory for exports (default: './exports')
 * @returns {Promise<Object>} Export result status
 */
async function exportBotTrades(botKey, botConfig, outputDir = './exports') {
    try {
        // Ensure output directory exists
        await fs.mkdir(outputDir, { recursive: true });

        // Find log file (PM2 format: {botKey}-error.log or {botKey}.log)
        const logsDir = path.join(__dirname, '..', '..', 'profiles', 'logs');
        let logFilePath = null;

        try {
            const logFiles = await fs.readdir(logsDir);
            const matchingLog = logFiles.find(f =>
                f.includes(botKey) && f.endsWith('.log') && !f.includes('error')
            );

            if (matchingLog) {
                logFilePath = path.join(logsDir, matchingLog);
            }
        } catch (err) {
            console.warn(`[EXPORT] Could not read logs directory: ${err.message}`);
        }

        // Parse trades from log file
        const trades = logFilePath ? await parseLogFile(logFilePath) : [];

        if (trades.length === 0) {
            console.warn(`[EXPORT] No trades found in log file for ${botKey}`);
        }

        // Write trades CSV
        const csvPath = path.join(outputDir, `${botKey}_trades.csv`);
        const csvResult = await writeTradesCSV(trades, csvPath);

        // Write settings JSON
        const settingsPath = path.join(outputDir, `${botKey}_settings.json`);
        const settingsResult = await writeSettingsJSON(botConfig, botKey, settingsPath);

        return {
            success: csvResult.success && settingsResult.success,
            trades_exported: trades.length,
            csv_path: csvPath,
            settings_path: settingsPath,
            output_dir: outputDir,
            timestamp: new Date().toISOString()
        };
    } catch (err) {
        console.error(`[EXPORT] Export failed for ${botKey}: ${err.message}`);
        return {
            success: false,
            error: err.message,
            bot_key: botKey
        };
    }
}

module.exports = {
    exportBotTrades,
    parseLogFile,
    writeTradesCSV,
    writeSettingsJSON
};
