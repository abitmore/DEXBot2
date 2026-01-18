/**
 * Trend Analyzer
 * Main module combining DualAMA and PriceRatio for high-precision trend detection
 * Optimized to be right, not fast
 */

const { DualAMA } = require('./dual_ama');
const { PriceRatio } = require('./price_ratio');

class TrendAnalyzer {
    /**
     * Initialize trend analyzer
     * @param {Object} config - Configuration
     * @param {number} config.lookbackBars - Price ratio lookback bars (default: 20)
     * @param {Object} config.dualAMAConfig - DualAMA configuration
     */
    constructor(config = {}) {
        this.dualAMA = new DualAMA(config.dualAMAConfig || {});
        this.priceRatio = new PriceRatio(config.lookbackBars || 20);

        // State tracking
        this.updateCount = 0;
    }

    /**
     * Update analyzer with new candle
     * @param {number} price - Closing price
     * @returns {Object} Analysis result
     */
    update(price) {
        // Update both components
        this.dualAMA.update(price);

        // Get AMAs for price ratio update
        const fastAMA = this.dualAMA.fastHistory[this.dualAMA.fastHistory.length - 1];
        const slowAMA = this.dualAMA.slowHistory[this.dualAMA.slowHistory.length - 1];

        // Update price ratio with slow AMA as center reference
        this.priceRatio.update(price, slowAMA);

        this.updateCount++;

        return this.getAnalysis();
    }

    /**
     * Get current trend analysis (HIGH PRECISION)
     * @returns {Object} Complete trend analysis
     */
    getAnalysis() {
        if (this.updateCount < 50) {
            return {
                isReady: false,
                reason: `Warming up: ${this.updateCount}/50 candles`,
                trend: 'NEUTRAL',
                confidence: 0,
            };
        }

        const confirmed = this.dualAMA.getConfirmedTrend();
        const priceRatioData = this.priceRatio.getSnapshot();

        return {
            isReady: true,
            trend: confirmed.trend,
            confidence: confirmed.confidence,
            isConfirmed: confirmed.isConfirmed,
            rawTrend: confirmed.rawTrend,
            barsInTrend: confirmed.barsInTrend,
            amaSeparation: {
                percent: confirmed.separation,
            },
            priceAnalysis: priceRatioData.priceVsAMA,
            oscillation: {
                ratio: priceRatioData.oscillationRatio,
                description: this._getOscillationDescription(priceRatioData.oscillationRatio),
            },
            updateCount: this.updateCount,
        };
    }

    /**
     * Get simple trend output (just the essentials)
     * @returns {Object} {trend: 'UP'|'DOWN'|'NEUTRAL', confidence: 0-100}
     */
    getSimpleTrend() {
        const analysis = this.getAnalysis();
        return {
            trend: analysis.trend,
            confidence: analysis.confidence,
            isReady: analysis.isReady,
        };
    }

    /**
     * Check if we're in a confirmed uptrend
     * @returns {boolean}
     */
    isUptrend() {
        const analysis = this.getAnalysis();
        return analysis.trend === 'UP' && analysis.isConfirmed;
    }

    /**
     * Check if we're in a confirmed downtrend
     * @returns {boolean}
     */
    isDowntrend() {
        const analysis = this.getAnalysis();
        return analysis.trend === 'DOWN' && analysis.isConfirmed;
    }

    /**
     * Check if trend is neutral/uncertain
     * @returns {boolean}
     */
    isNeutral() {
        const analysis = this.getAnalysis();
        return analysis.trend === 'NEUTRAL';
    }

    /**
     * Get all available data for analysis/debugging
     * @returns {Object} Complete snapshot
     */
    getFullSnapshot() {
        if (this.updateCount < 50) {
            return {
                isReady: false,
                message: `Warming up: ${this.updateCount}/50 candles`,
            };
        }

        const dualAMASnapshot = this.dualAMA.getSnapshot();
        const priceRatioSnapshot = this.priceRatio.getSnapshot();
        const confirmed = this.dualAMA.getConfirmedTrend();

        return {
            timestamp: new Date().toISOString(),
            updateCount: this.updateCount,

            trend: {
                confirmed: confirmed.trend,
                raw: confirmed.rawTrend,
                confidence: confirmed.confidence,
                isConfirmed: confirmed.isConfirmed,
                barsInTrend: confirmed.barsInTrend,
                minBarsForConfirmation: this.dualAMA.minBarsForConfirmation,
            },

            ama: {
                fast: dualAMASnapshot.fastAMA,
                slow: dualAMASnapshot.slowAMA,
                separation: dualAMASnapshot.amaSeparation,
            },

            price: {
                current: dualAMASnapshot.price,
                distanceFromSlowAMA: dualAMASnapshot.priceDistance,
                range: dualAMASnapshot.priceRange,
                positionInRange: {
                    value: Math.round(this.priceRatio.getPricePositionInRange() * 10000) / 100,
                    unit: '%',
                },
            },

            oscillation: {
                ratio: priceRatioSnapshot.oscillationRatio,
                priceRange: priceRatioSnapshot.priceRange,
                amaRange: priceRatioSnapshot.amaRange,
                description: this._getOscillationDescription(priceRatioSnapshot.oscillationRatio),
            },

            priceDirection: priceRatioSnapshot.priceDirection,

            config: {
                dualAMA: {
                    fast: {
                        erPeriod: this.dualAMA.fastAMA.erPeriod,
                        fastPeriod: Math.round(2 / this.dualAMA.fastAMA.fastSC - 1),
                        slowPeriod: Math.round(2 / this.dualAMA.fastAMA.slowSC - 1),
                    },
                    slow: {
                        erPeriod: this.dualAMA.slowAMA.erPeriod,
                        fastPeriod: Math.round(2 / this.dualAMA.slowAMA.fastSC - 1),
                        slowPeriod: Math.round(2 / this.dualAMA.slowAMA.slowSC - 1),
                    },
                },
                priceRatio: {
                    lookbackBars: this.priceRatio.lookbackBars,
                },
            },
        };
    }

    /**
     * Describe oscillation ratio in human terms
     * @private
     */
    _getOscillationDescription(ratio) {
        if (ratio < 1) return 'Very tight - Ideal for grid trading';
        if (ratio < 3) return 'Tight - Good for grid trading';
        if (ratio < 5) return 'Normal - Moderate trading range';
        if (ratio < 10) return 'Wide - Choppy market';
        return 'Very wide - Highly volatile';
    }

    /**
     * Reset the analyzer
     */
    reset() {
        this.dualAMA.reset();
        this.priceRatio.reset();
        this.updateCount = 0;
    }

    /**
     * Get current update count (for testing/monitoring)
     * @returns {number}
     */
    getUpdateCount() {
        return this.updateCount;
    }
}

module.exports = { TrendAnalyzer };
