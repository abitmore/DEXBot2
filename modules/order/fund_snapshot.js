/**
 * modules/order/fund_snapshot.js
 *
 * Fund Snapshot Logging System
 * =============================
 * Captures detailed fund state at critical points in the trading cycle.
 * Enables post-mortem analysis of fund discrepancies and leak detection.
 *
 * USAGE:
 *   const snapshot = FundSnapshot.capture(manager, 'fill_detected', fillId, { fillAmount: 100 });
 *   console.log(snapshot);
 *
 *   // Later, analyze history
 *   const anomalies = FundSnapshot.detectAnomalies(snapshotHistory);
 */

const { ORDER_TYPES, ORDER_STATES } = require('../constants');

/**
 * FundSnapshot class - Captures immutable fund state at a point in time
 */
class FundSnapshot {
    constructor(timestamp, eventType, context, manager) {
        this.timestamp = timestamp;
        this.eventType = eventType;  // 'fill_detected', 'order_created', 'order_cancelled', 'recalc', etc.
        this.context = context;      // Event-specific metadata

        // Fund state snapshot (immutable at capture time)
        this.funds = {
            available: { ...manager.funds?.available } || { buy: 0, sell: 0 },
            total: {
                chain: { ...manager.funds?.total?.chain } || { buy: 0, sell: 0 },
                grid: { ...manager.funds?.total?.grid } || { buy: 0, sell: 0 }
            },
            committed: {
                chain: { ...manager.funds?.committed?.chain } || { buy: 0, sell: 0 },
                grid: { ...manager.funds?.committed?.grid } || { buy: 0, sell: 0 }
            },
            virtual: { ...manager.funds?.virtual } || { buy: 0, sell: 0 },
            cacheFunds: { ...manager.funds?.cacheFunds } || { buy: 0, sell: 0 },
            btsFeesOwed: manager.funds?.btsFeesOwed || 0
        };

        // Account totals snapshot
        this.accountTotals = manager.accountTotals ? {
            buy: manager.accountTotals.buy,
            buyFree: manager.accountTotals.buyFree,
            sell: manager.accountTotals.sell,
            sellFree: manager.accountTotals.sellFree
        } : null;

        // Grid state snapshot
        this.gridState = {
            totalOrders: manager.orders?.size || 0,
            activeCount: manager._ordersByState?.[ORDER_STATES.ACTIVE]?.size || 0,
            partialCount: manager._ordersByState?.[ORDER_STATES.PARTIAL]?.size || 0,
            virtualCount: manager._ordersByState?.[ORDER_STATES.VIRTUAL]?.size || 0,
            spreadCount: manager._ordersByState?.[ORDER_TYPES.SPREAD]?.size || 0,
            boundaryIdx: manager.boundaryIdx
        };

        // Derived metrics (computed at capture time for consistency)
        this.metrics = this._calculateMetrics();
    }

    /**
     * Calculate consistency metrics
     */
    _calculateMetrics() {
        const metrics = {};

        // INVARIANT 1: chainTotal = chainFree + chainCommitted (buy side)
        const chainTotalBuy = this.funds.total.chain.buy;
        const chainFreeBuy = this.accountTotals?.buyFree || 0;
        const chainCommittedBuy = this.funds.committed.chain.buy;
        metrics.invariant1Buy = {
            chainTotal: chainTotalBuy,
            expected: chainFreeBuy + chainCommittedBuy,
            violation: Math.abs(chainTotalBuy - (chainFreeBuy + chainCommittedBuy))
        };

        // INVARIANT 1: chainTotal = chainFree + chainCommitted (sell side)
        const chainTotalSell = this.funds.total.chain.sell;
        const chainFreeSell = this.accountTotals?.sellFree || 0;
        const chainCommittedSell = this.funds.committed.chain.sell;
        metrics.invariant1Sell = {
            chainTotal: chainTotalSell,
            expected: chainFreeSell + chainCommittedSell,
            violation: Math.abs(chainTotalSell - (chainFreeSell + chainCommittedSell))
        };

        // INVARIANT 2: Available <= chainFree
        metrics.invariant2Buy = {
            available: this.funds.available.buy,
            chainFree: chainFreeBuy,
            violation: Math.max(0, this.funds.available.buy - chainFreeBuy)
        };
        metrics.invariant2Sell = {
            available: this.funds.available.sell,
            chainFreeSell: chainFreeSell,
            violation: Math.max(0, this.funds.available.sell - chainFreeSell)
        };

        // INVARIANT 3: gridCommitted <= chainTotal
        metrics.invariant3Buy = {
            gridCommitted: this.funds.committed.grid.buy,
            chainTotal: chainTotalBuy,
            violation: Math.max(0, this.funds.committed.grid.buy - chainTotalBuy)
        };
        metrics.invariant3Sell = {
            gridCommitted: this.funds.committed.grid.sell,
            chainTotal: chainTotalSell,
            violation: Math.max(0, this.funds.committed.grid.sell - chainTotalSell)
        };

        return metrics;
    }

    /**
     * Check if any invariant is violated (with tolerance)
     */
    hasViolations(tolerancePercent = 0.1) {
        const tolerance = (val) => Math.abs(val) < tolerancePercent / 100;

        return !tolerance(this.metrics.invariant1Buy.violation) ||
               !tolerance(this.metrics.invariant1Sell.violation) ||
               this.metrics.invariant2Buy.violation > 0 ||
               this.metrics.invariant2Sell.violation > 0 ||
               this.metrics.invariant3Buy.violation > 0 ||
               this.metrics.invariant3Sell.violation > 0;
    }

    /**
     * Format snapshot for logging
     */
    toString(detailed = false) {
        const ts = new Date(this.timestamp).toISOString();
        const lines = [
            `[FUND SNAPSHOT] ${ts} | ${this.eventType}`,
            `  Context: ${JSON.stringify(this.context)}`
        ];

        if (detailed) {
            lines.push(
                `  Available: buy=${this.funds.available.buy.toFixed(8)}, sell=${this.funds.available.sell.toFixed(8)}`,
                `  ChainTotal: buy=${this.funds.total.chain.buy.toFixed(8)}, sell=${this.funds.total.chain.sell.toFixed(8)}`,
                `  ChainCommitted: buy=${this.funds.committed.chain.buy.toFixed(8)}, sell=${this.funds.committed.chain.sell.toFixed(8)}`,
                `  ChainFree: buy=${(this.accountTotals?.buyFree || 0).toFixed(8)}, sell=${(this.accountTotals?.sellFree || 0).toFixed(8)}`,
                `  CacheFunds: buy=${this.funds.cacheFunds.buy.toFixed(8)}, sell=${this.funds.cacheFunds.sell.toFixed(8)}`,
                `  BtsFeesOwed: ${this.funds.btsFeesOwed.toFixed(8)}`,
                `  Grid: ${this.gridState.activeCount} active, ${this.gridState.partialCount} partial, ${this.gridState.virtualCount} virtual`,
                `  Invariants: I1Buy=${this.metrics.invariant1Buy.violation.toFixed(8)}, I1Sell=${this.metrics.invariant1Sell.violation.toFixed(8)}`
            );
        } else {
            lines.push(
                `  Available: buy=${this.funds.available.buy.toFixed(8)}, sell=${this.funds.available.sell.toFixed(8)}`,
                `  ChainTotal: buy=${this.funds.total.chain.buy.toFixed(8)}, sell=${this.funds.total.chain.sell.toFixed(8)}`
            );
        }

        return lines.join('\n');
    }

    /**
     * Export as JSON for storage
     */
    toJSON() {
        return {
            timestamp: this.timestamp,
            eventType: this.eventType,
            context: this.context,
            funds: this.funds,
            accountTotals: this.accountTotals,
            gridState: this.gridState,
            metrics: this.metrics
        };
    }

    /**
     * Static factory method to capture current state
     */
    static capture(manager, eventType, eventId = null, extraContext = {}) {
        const context = {
            eventId: eventId,
            ...extraContext,
            processPid: process.pid,
            memoryUsageMb: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)
        };

        return new FundSnapshot(Date.now(), eventType, context, manager);
    }
}

/**
 * FundSnapshotHistory - Manages a time-series history of fund snapshots
 */
class FundSnapshotHistory {
    constructor(maxSnapshots = 1000) {
        this.snapshots = [];
        this.maxSnapshots = maxSnapshots;
        this.startTime = Date.now();
    }

    /**
     * Add a snapshot to history (with automatic pruning if max reached)
     */
    add(snapshot) {
        this.snapshots.push(snapshot);

        // Keep only most recent snapshots
        if (this.snapshots.length > this.maxSnapshots) {
            this.snapshots = this.snapshots.slice(-this.maxSnapshots);
        }
    }

    /**
     * Get snapshots in a time range
     */
    getByTimeRange(startTime, endTime) {
        return this.snapshots.filter(s => s.timestamp >= startTime && s.timestamp <= endTime);
    }

    /**
     * Get snapshots by event type
     */
    getByEventType(eventType) {
        return this.snapshots.filter(s => s.eventType === eventType);
    }

    /**
     * Get the last N snapshots
     */
    getLast(count = 10) {
        return this.snapshots.slice(-count);
    }

    /**
     * Find fund changes between two snapshots
     */
    static getDifference(snapshot1, snapshot2) {
        return {
            timestamp1: snapshot1.timestamp,
            timestamp2: snapshot2.timestamp,
            timeDeltaMs: snapshot2.timestamp - snapshot1.timestamp,
            availableChange: {
                buy: snapshot2.funds.available.buy - snapshot1.funds.available.buy,
                sell: snapshot2.funds.available.sell - snapshot1.funds.available.sell
            },
            chainTotalChange: {
                buy: snapshot2.funds.total.chain.buy - snapshot1.funds.total.chain.buy,
                sell: snapshot2.funds.total.chain.sell - snapshot1.funds.total.chain.sell
            },
            chainCommittedChange: {
                buy: snapshot2.funds.committed.chain.buy - snapshot1.funds.committed.chain.buy,
                sell: snapshot2.funds.committed.chain.sell - snapshot1.funds.committed.chain.sell
            },
            cacheFundsChange: {
                buy: snapshot2.funds.cacheFunds.buy - snapshot1.funds.cacheFunds.buy,
                sell: snapshot2.funds.cacheFunds.sell - snapshot1.funds.cacheFunds.sell
            }
        };
    }

    /**
     * Detect anomalies in snapshot history
     */
    detectAnomalies(tolerancePercent = 0.1) {
        const anomalies = [];

        // Check each snapshot for invariant violations
        for (let i = 0; i < this.snapshots.length; i++) {
            const snapshot = this.snapshots[i];
            if (snapshot.hasViolations(tolerancePercent)) {
                anomalies.push({
                    index: i,
                    timestamp: snapshot.timestamp,
                    eventType: snapshot.eventType,
                    context: snapshot.context,
                    violations: {
                        invariant1Buy: snapshot.metrics.invariant1Buy.violation,
                        invariant1Sell: snapshot.metrics.invariant1Sell.violation,
                        invariant2Buy: snapshot.metrics.invariant2Buy.violation,
                        invariant2Sell: snapshot.metrics.invariant2Sell.violation,
                        invariant3Buy: snapshot.metrics.invariant3Buy.violation,
                        invariant3Sell: snapshot.metrics.invariant3Sell.violation
                    }
                });
            }
        }

        // Check for suspicious fund movements
        for (let i = 1; i < this.snapshots.length; i++) {
            const prev = this.snapshots[i - 1];
            const curr = this.snapshots[i];
            const diff = FundSnapshotHistory.getDifference(prev, curr);

            // Flag unexplained fund increases (money appearing from nowhere)
            if (diff.availableChange.buy > 0 && prev.eventType !== 'fill_detected') {
                anomalies.push({
                    type: 'unexplained_increase',
                    index: i,
                    timestamp: curr.timestamp,
                    from: prev.eventType,
                    to: curr.eventType,
                    amountBuy: diff.availableChange.buy,
                    message: `Available buy funds increased by ${diff.availableChange.buy.toFixed(8)} without fill`
                });
            }
            if (diff.availableChange.sell > 0 && prev.eventType !== 'fill_detected') {
                anomalies.push({
                    type: 'unexplained_increase',
                    index: i,
                    timestamp: curr.timestamp,
                    from: prev.eventType,
                    to: curr.eventType,
                    amountSell: diff.availableChange.sell,
                    message: `Available sell funds increased by ${diff.availableChange.sell.toFixed(8)} without fill`
                });
            }

            // Flag fund decreases that exceed committed amounts
            if (diff.chainTotalChange.buy < -0.00001) {
                anomalies.push({
                    type: 'unexpected_decrease',
                    index: i,
                    timestamp: curr.timestamp,
                    from: prev.eventType,
                    to: curr.eventType,
                    amountBuy: diff.chainTotalChange.buy,
                    message: `Chain total buy decreased by ${Math.abs(diff.chainTotalChange.buy).toFixed(8)} (possible fee or external withdrawal)`
                });
            }
        }

        return anomalies;
    }

    /**
     * Generate detailed report of fund history
     */
    generateReport(limit = null) {
        const relevantSnapshots = limit ? this.snapshots.slice(-limit) : this.snapshots;

        const report = {
            totalSnapshots: this.snapshots.length,
            timeSpanMs: Date.now() - this.startTime,
            snapshots: relevantSnapshots.map(s => ({
                timestamp: new Date(s.timestamp).toISOString(),
                eventType: s.eventType,
                context: s.context,
                funds: {
                    available: s.funds.available,
                    chainTotal: s.funds.total.chain,
                    chainCommitted: s.funds.committed.chain,
                    cacheFunds: s.funds.cacheFunds,
                    btsFeesOwed: s.funds.btsFeesOwed
                },
                gridState: s.gridState,
                hasViolations: s.hasViolations()
            })),
            anomalies: this.detectAnomalies()
        };

        return report;
    }

    /**
     * Print summary to console
     */
    printSummary() {
        console.log('\n' + '='.repeat(80));
        console.log('FUND SNAPSHOT HISTORY SUMMARY');
        console.log('='.repeat(80));
        console.log(`Total snapshots: ${this.snapshots.length}`);
        console.log(`Time span: ${Math.round((Date.now() - this.startTime) / 1000)}s`);

        const eventTypeCounts = {};
        for (const snapshot of this.snapshots) {
            eventTypeCounts[snapshot.eventType] = (eventTypeCounts[snapshot.eventType] || 0) + 1;
        }
        console.log('\nEvent type distribution:');
        for (const [eventType, count] of Object.entries(eventTypeCounts)) {
            console.log(`  ${eventType}: ${count}`);
        }

        const anomalies = this.detectAnomalies();
        if (anomalies.length > 0) {
            console.log(`\n⚠️  Found ${anomalies.length} anomalies:`);
            for (const anomaly of anomalies.slice(0, 5)) {
                console.log(`  - ${anomaly.type}: ${anomaly.message || JSON.stringify(anomaly)}`);
            }
            if (anomalies.length > 5) {
                console.log(`  ... and ${anomalies.length - 5} more`);
            }
        } else {
            console.log('\n✅ No anomalies detected');
        }

        const lastSnapshot = this.snapshots[this.snapshots.length - 1];
        if (lastSnapshot) {
            console.log('\nLatest snapshot:');
            console.log(`  Timestamp: ${new Date(lastSnapshot.timestamp).toISOString()}`);
            console.log(`  Available: buy=${lastSnapshot.funds.available.buy.toFixed(8)}, sell=${lastSnapshot.funds.available.sell.toFixed(8)}`);
            console.log(`  ChainTotal: buy=${lastSnapshot.funds.total.chain.buy.toFixed(8)}, sell=${lastSnapshot.funds.total.chain.sell.toFixed(8)}`);
        }
        console.log('='.repeat(80) + '\n');
    }
}

module.exports = {
    FundSnapshot,
    FundSnapshotHistory
};
