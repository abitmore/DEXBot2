/**
 * modules/order/fund_snapshot_persistence.js
 *
 * Fund Snapshot Persistence and Analysis
 * =====================================
 * Handles saving, loading, and analyzing fund snapshots for auditing purposes.
 *
 * USAGE:
 *   // Save snapshots to disk
 *   await FundSnapshotPersistence.saveSnapshots(botKey, snapshotHistory);
 *
 *   // Load and analyze
 *   const analysis = await FundSnapshotPersistence.analyzeSnapshots(botKey);
 *   console.log(analysis.report);
 */

const fs = require('fs').promises;
const path = require('path');
const { FundSnapshot, FundSnapshotHistory } = require('./fund_snapshot');

const SNAPSHOTS_DIR = path.join(__dirname, '..', '..', '.snapshots');

/**
 * FundSnapshotPersistence class - Handles saving, loading, and analyzing fund snapshots.
 * @class
 */
class FundSnapshotPersistence {
    /**
     * Get the snapshot file path for a specific bot.
     * @param {string} botKey - Bot identifier.
     * @returns {string} The file path.
     */
    static getSnapshotPath(botKey) {
        return path.join(SNAPSHOTS_DIR, `${botKey}.snapshots.jsonl`);
    }

    /**
     * Ensure snapshots directory exists.
     * @returns {Promise<void>}
     */
    static async ensureDirectory() {
        try {
            await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
    }

    /**
     * Save snapshot history to disk (JSONL format for streaming)
     * @param {string} botKey - Bot identifier
     * @param {FundSnapshotHistory} history - Snapshot history to save
     * @param {Object} options - Save options
     * @param {boolean} options.append - Append to existing file (default: true)
     * @param {number} options.maxLines - Max lines to keep in file (default: 10000)
     */
    static async saveSnapshots(botKey, history, options = {}) {
        const { append = true, maxLines = 10000 } = options;

        try {
            await this.ensureDirectory();
            const filePath = this.getSnapshotPath(botKey);

            // Collect snapshots to save
            const snapshotsToSave = history.snapshots
                .filter(s => s) // Skip nulls
                .map(s => JSON.stringify(s.toJSON()));

            if (snapshotsToSave.length === 0) return;

            let fileContent = '';
            let existingLines = [];

            // Load existing file if appending
            if (append) {
                try {
                    const existing = await fs.readFile(filePath, 'utf8');
                    existingLines = existing
                        .trim()
                        .split('\n')
                        .filter(line => line.length > 0);
                } catch (err) {
                    if (err.code !== 'ENOENT') throw err;
                    // File doesn't exist yet, that's okay
                }
            }

            // Combine and prune to maxLines
            const allLines = [...existingLines, ...snapshotsToSave];
            const prunedLines = allLines.slice(-maxLines);
            fileContent = prunedLines.join('\n') + '\n';

            // Write atomically
            const tempPath = filePath + '.tmp';
            await fs.writeFile(tempPath, fileContent, 'utf8');
            await fs.rename(tempPath, filePath);

            return { saved: snapshotsToSave.length, total: prunedLines.length };
        } catch (err) {
            console.error(`[SNAPSHOT] Failed to save snapshots for ${botKey}: ${err.message}`);
            return { saved: 0, total: 0, error: err.message };
        }
    }

    /**
     * Load snapshots from disk
     * @param {string} botKey - Bot identifier
     * @param {Object} options - Load options
     * @param {number} options.limit - Max snapshots to load (default: 1000)
     * @param {string} options.eventType - Filter by event type (optional)
     */
    static async loadSnapshots(botKey, options = {}) {
        const { limit = 1000, eventType = null } = options;

        try {
            await this.ensureDirectory();
            const filePath = this.getSnapshotPath(botKey);

            let content = '';
            try {
                content = await fs.readFile(filePath, 'utf8');
            } catch (err) {
                if (err.code === 'ENOENT') {
                    // File doesn't exist
                    return new FundSnapshotHistory(limit);
                }
                throw err;
            }

            // Parse JSONL format
            const lines = content.trim().split('\n').filter(line => line.length > 0);
            const history = new FundSnapshotHistory(limit);

            for (const line of lines.slice(-limit)) {
                try {
                    const data = JSON.parse(line);

                    // Filter by event type if specified
                    if (eventType && data.eventType !== eventType) continue;

                    // Reconstruct snapshot (data is already JSON-compatible)
                    const snapshot = new FundSnapshot(
                        data.timestamp,
                        data.eventType,
                        data.context,
                        {
                            funds: data.funds,
                            accountTotals: data.accountTotals,
                            _ordersByState: {},
                            _snapshotHistory: null,
                            logger: null
                        }
                    );

                    // Override with persisted data (avoid recalculation)
                    snapshot.funds = data.funds;
                    snapshot.accountTotals = data.accountTotals;
                    snapshot.gridState = data.gridState;
                    snapshot.metrics = data.metrics;

                    history.snapshots.push(snapshot);
                } catch (parseErr) {
                    console.warn(`[SNAPSHOT] Failed to parse snapshot line: ${parseErr.message}`);
                    continue;
                }
            }

            return history;
        } catch (err) {
            console.error(`[SNAPSHOT] Failed to load snapshots for ${botKey}: ${err.message}`);
            return new FundSnapshotHistory(limit);
        }
    }

    /**
     * Analyze snapshots and generate report.
     * @param {string} botKey - Bot identifier.
     * @returns {Promise<Object>} The analysis report.
     */
    static async analyzeSnapshots(botKey) {
        try {
            const history = await this.loadSnapshots(botKey, { limit: 5000 });

            if (history.snapshots.length === 0) {
                return {
                    botKey,
                    status: 'no_data',
                    message: 'No snapshots found for this bot'
                };
            }

            const report = history.generateReport();
            const anomalies = history.detectAnomalies();

            // Calculate statistics
            const stats = this._calculateStatistics(history);

            return {
                botKey,
                status: 'success',
                summary: {
                    totalSnapshots: history.snapshots.length,
                    timeSpanMs: report.timeSpanMs,
                    timeSpanMinutes: Math.round(report.timeSpanMs / 60000),
                    anomaliesDetected: anomalies.length,
                    hasViolations: anomalies.some(a => a.violations)
                },
                statistics: stats,
                anomalies: anomalies.slice(0, 20), // Top 20 anomalies
                eventTypeDistribution: this._getEventTypeDistribution(history),
                fundTrend: this._calculateFundTrend(history),
                firstSnapshot: history.snapshots[0],
                lastSnapshot: history.snapshots[history.snapshots.length - 1]
            };
        } catch (err) {
            return {
                botKey,
                status: 'error',
                message: err.message
            };
        }
    }

    /**
     * Calculate statistics from snapshot history.
     * @param {FundSnapshotHistory} history - Snapshot history.
     * @returns {Object} The calculated statistics.
     * @private
     */
    static _calculateStatistics(history) {
        const snapshots = history.snapshots;
        if (snapshots.length === 0) return {};

        const buyAvailable = snapshots.map(s => s.funds.available.buy);
        const sellAvailable = snapshots.map(s => s.funds.available.sell);

        return {
            available: {
                buy: {
                    min: Math.min(...buyAvailable),
                    max: Math.max(...buyAvailable),
                    avg: buyAvailable.reduce((a, b) => a + b, 0) / buyAvailable.length,
                    latest: buyAvailable[buyAvailable.length - 1]
                },
                sell: {
                    min: Math.min(...sellAvailable),
                    max: Math.max(...sellAvailable),
                    avg: sellAvailable.reduce((a, b) => a + b, 0) / sellAvailable.length,
                    latest: sellAvailable[sellAvailable.length - 1]
                }
            }
        };
    }

    /**
     * Get distribution of event types.
     * @param {FundSnapshotHistory} history - Snapshot history.
     * @returns {Object} Mapping of event type to count.
     * @private
     */
    static _getEventTypeDistribution(history) {
        const dist = {};
        for (const snapshot of history.snapshots) {
            dist[snapshot.eventType] = (dist[snapshot.eventType] || 0) + 1;
        }
        return dist;
    }

    /**
     * Calculate fund trend (increasing/decreasing/stable).
     * @param {FundSnapshotHistory} history - Snapshot history.
     * @returns {Object} Trend information for buy and sell sides.
     * @private
     */
    static _calculateFundTrend(history) {
        if (history.snapshots.length < 2) return { trend: 'unknown', reason: 'insufficient_data' };

        const first = history.snapshots[0];
        const last = history.snapshots[history.snapshots.length - 1];

        const buyChange = last.funds.available.buy - first.funds.available.buy;
        const sellChange = last.funds.available.sell - first.funds.available.sell;

        const threshold = 0.00001;

        return {
            buy: {
                change: buyChange,
                trend: Math.abs(buyChange) < threshold ? 'stable' : (buyChange > 0 ? 'increasing' : 'decreasing')
            },
            sell: {
                change: sellChange,
                trend: Math.abs(sellChange) < threshold ? 'stable' : (sellChange > 0 ? 'increasing' : 'decreasing')
            }
        };
    }

    /**
     * Compare two bot's snapshots to find divergence.
     * @param {string} botKey1 - First bot identifier.
     * @param {string} botKey2 - Second bot identifier.
     * @returns {Promise<Object>} Comparison result.
     */
    static async compareBots(botKey1, botKey2) {
        try {
            const hist1 = await this.loadSnapshots(botKey1);
            const hist2 = await this.loadSnapshots(botKey2);

            if (hist1.snapshots.length === 0 || hist2.snapshots.length === 0) {
                return {
                    status: 'insufficient_data',
                    message: 'One or both bots have no snapshot data'
                };
            }

            // Compare latest snapshots
            const last1 = hist1.snapshots[hist1.snapshots.length - 1];
            const last2 = hist2.snapshots[hist2.snapshots.length - 1];

            return {
                status: 'success',
                bot1: {
                    key: botKey1,
                    availableBuy: last1.funds.available.buy,
                    availableSell: last1.funds.available.sell,
                    chainTotal: last1.funds.total.chain
                },
                bot2: {
                    key: botKey2,
                    availableBuy: last2.funds.available.buy,
                    availableSell: last2.funds.available.sell,
                    chainTotal: last2.funds.total.chain
                },
                difference: {
                    availableBuy: Math.abs(last2.funds.available.buy - last1.funds.available.buy),
                    availableSell: Math.abs(last2.funds.available.sell - last1.funds.available.sell),
                    chainTotalBuy: Math.abs(last2.funds.total.chain.buy - last1.funds.total.chain.buy),
                    chainTotalSell: Math.abs(last2.funds.total.chain.sell - last1.funds.total.chain.sell)
                }
            };
        } catch (err) {
            return {
                status: 'error',
                message: err.message
            };
        }
    }

    /**
     * Export snapshots to CSV for external analysis.
     * @param {string} botKey - Bot identifier.
     * @param {string|null} [outputPath=null] - Custom output path.
     * @returns {Promise<Object>} Status and path.
     */
    static async exportToCSV(botKey, outputPath = null) {
        try {
            const history = await this.loadSnapshots(botKey, { limit: 10000 });

            if (history.snapshots.length === 0) {
                return { status: 'no_data' };
            }

            // Build CSV header and rows
            const headers = [
                'timestamp',
                'eventType',
                'available_buy',
                'available_sell',
                'chain_total_buy',
                'chain_total_sell',
                'chain_committed_buy',
                'chain_committed_sell',
                'cache_buy',
                'cache_sell',
                'bts_fees_owed',
                'grid_active',
                'grid_partial',
                'grid_virtual'
            ];

            const rows = history.snapshots.map(s => [
                new Date(s.timestamp).toISOString(),
                s.eventType,
                s.funds.available.buy,
                s.funds.available.sell,
                s.funds.total.chain.buy,
                s.funds.total.chain.sell,
                s.funds.committed.chain.buy,
                s.funds.committed.chain.sell,
                s.funds.cacheFunds.buy,
                s.funds.cacheFunds.sell,
                s.funds.btsFeesOwed,
                s.gridState.activeCount,
                s.gridState.partialCount,
                s.gridState.virtualCount
            ]);

            const csv = [headers, ...rows].map(row =>
                row.map(val => {
                    if (typeof val === 'number') return val.toString();
                    if (typeof val === 'string') return `"${val}"`;
                    return '';
                }).join(',')
            ).join('\n');

            const finalPath = outputPath || path.join(SNAPSHOTS_DIR, `${botKey}.snapshots.csv`);
            await fs.writeFile(finalPath, csv, 'utf8');

            return {
                status: 'success',
                path: finalPath,
                rows: rows.length
            };
        } catch (err) {
            return {
                status: 'error',
                message: err.message
            };
        }
    }
}

module.exports = FundSnapshotPersistence;
