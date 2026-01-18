/**
 * Dual AMA Trend Detection System
 * Optimized for HIGH PRECISION over speed
 * Uses fast and slow AMAs to detect uptrends/downtrends with high confidence
 */

const { AMA } = require('../ama_fitting/ama');

class DualAMA {
    /**
     * Initialize dual AMA system for trend detection
     * @param {Object} config - Configuration
     * @param {number} config.fastErPeriod - ER period for fast AMA (default: 40)
     * @param {number} config.fastFastPeriod - Fast period for fast AMA (default: 5)
     * @param {number} config.fastSlowPeriod - Slow period for fast AMA (default: 15)
     * @param {number} config.slowErPeriod - ER period for slow AMA (default: 20)
     * @param {number} config.slowFastPeriod - Fast period for slow AMA (default: 2)
     * @param {number} config.slowSlowPeriod - Slow period for slow AMA (default: 30)
     */
    constructor(config = {}) {
        // Fast AMA - quicker response (but not too quick to avoid noise)
        this.fastAMA = new AMA(
            config.fastErPeriod || 40,
            config.fastFastPeriod || 5,
            config.fastSlowPeriod || 15
        );

        // Slow AMA - trend confirmation (longer period)
        this.slowAMA = new AMA(
            config.slowErPeriod || 20,
            config.slowFastPeriod || 2,
            config.slowSlowPeriod || 30
        );

        // History for analysis
        this.priceHistory = [];
        this.highHistory = [];
        this.lowHistory = [];
        this.fastHistory = [];
        this.slowHistory = [];
        this.maxHistoryLength = 500; // Keep last 500 candles for ratio analysis

        // State tracking
        this.prevTrendState = null; // Track previous trend for change detection
        this.trendChangeCount = 0;  // Count consecutive bars in current trend
        this.minBarsForConfirmation = 3; // Require 3+ bars before confirming trend change
    }

    /**
     * Update both AMAs with new price (and high/low for price action)
     * @param {number} price - Current closing price
     * @param {number} high - Current high price (for price action filter)
     * @param {number} low - Current low price (for price action filter)
     * @returns {Object} Current state {fastAMA, slowAMA, price}
     */
    update(price, high = price, low = price) {
        const fastAMA = this.fastAMA.update(price);
        const slowAMA = this.slowAMA.update(price);

        this.priceHistory.push(price);
        this.highHistory.push(high);
        this.lowHistory.push(low);
        this.fastHistory.push(fastAMA);
        this.slowHistory.push(slowAMA);

        // Maintain history buffer
        if (this.priceHistory.length > this.maxHistoryLength) {
            this.priceHistory.shift();
            this.highHistory.shift();
            this.lowHistory.shift();
            this.fastHistory.shift();
            this.slowHistory.shift();
        }

        return {
            price,
            high,
            low,
            fastAMA,
            slowAMA,
        };
    }

    /**
     * Get current AMA separation (distance between fast and slow)
     * @returns {number} Absolute distance between fast and slow AMA
     */
    getAMASeparation() {
        if (this.fastHistory.length === 0) return 0;
        const fastAMA = this.fastHistory[this.fastHistory.length - 1];
        const slowAMA = this.slowHistory[this.slowHistory.length - 1];
        return Math.abs(fastAMA - slowAMA);
    }

    /**
     * Get AMA separation percentage relative to slow AMA
     * @returns {number} Separation as percentage of slow AMA (0-100)
     */
    getAMASeparationPercent() {
        if (this.slowHistory.length === 0) return 0;
        const separation = this.getAMASeparation();
        const slowAMA = this.slowHistory[this.slowHistory.length - 1];
        if (slowAMA === 0) return 0;
        return (separation / Math.abs(slowAMA)) * 100;
    }

    /**
     * Get raw trend direction (before confirmation)
     * UP: fast > slow, DOWN: fast < slow, NEUTRAL: equal
     * @returns {string} 'UP' | 'DOWN' | 'NEUTRAL'
     */
    getRawTrendDirection() {
        if (this.fastHistory.length === 0) return 'NEUTRAL';
        const fastAMA = this.fastHistory[this.fastHistory.length - 1];
        const slowAMA = this.slowHistory[this.slowHistory.length - 1];

        const tolerance = Math.abs(slowAMA) * 0.001; // 0.1% tolerance
        if (Math.abs(fastAMA - slowAMA) < tolerance) return 'NEUTRAL';

        return fastAMA > slowAMA ? 'UP' : 'DOWN';
    }

    /**
     * Get confirmed trend with strict requirements
     * Conservative approach: requires sustained trend + minimum separation
     * @returns {Object} {
     *   trend: 'UP' | 'DOWN' | 'NEUTRAL',
     *   isConfirmed: boolean,
     *   confidence: 0-100,
     *   barsInTrend: number
     * }
     */
    getConfirmedTrend() {
        const rawTrend = this.getRawTrendDirection();
        const separation = this.getAMASeparationPercent();

        // Update trend state tracking
        if (rawTrend !== this.prevTrendState) {
            this.prevTrendState = rawTrend;
            this.trendChangeCount = 1;
        } else {
            this.trendChangeCount++;
        }

        // Minimum separation threshold for high precision (requires 1%+ difference)
        const minSeparation = 1.0;
        const isSeparationValid = separation >= minSeparation;

        // Require minimum bars to confirm trend change
        const isConfirmed =
            rawTrend !== 'NEUTRAL' &&
            isSeparationValid &&
            this.trendChangeCount >= this.minBarsForConfirmation;

        // Calculate confidence based on separation (0-100)
        let confidence = 0;
        if (rawTrend !== 'NEUTRAL') {
            // Map separation to confidence: 1% = 20%, 5% = 100%
            confidence = Math.min(100, (separation / 5) * 100);
        }

        return {
            trend: isConfirmed ? rawTrend : 'NEUTRAL',
            isConfirmed,
            rawTrend,
            confidence: Math.round(confidence),
            separation: Math.round(separation * 100) / 100,
            barsInTrend: this.trendChangeCount,
        };
    }

    /**
     * Get efficiency ratios for both AMAs (trend strength indicator)
     * @returns {Object} {fastER, slowER} - Values from 0-1 (higher = stronger trend)
     */
    getEfficiencyRatios() {
        const fastER = this.fastAMA.getER?.() || this._calculateER(this.fastAMA);
        const slowER = this.slowAMA.getER?.() || this._calculateER(this.slowAMA);
        return { fastER, slowER };
    }

    /**
     * Calculate efficiency ratio for an AMA instance
     * @private
     */
    _calculateER(ama) {
        if (ama.history.length <= ama.erPeriod) return 0;

        const direction = Math.abs(ama.history[ama.history.length - 1] - ama.history[0]);
        let volatility = 0;
        for (let i = 1; i < ama.history.length; i++) {
            volatility += Math.abs(ama.history[i] - ama.history[i-1]);
        }

        return volatility === 0 ? 0 : direction / volatility;
    }

    /**
     * Get min and max prices from history
     * @param {number} bars - Number of bars to look back (default: 20)
     * @returns {Object} {min, max}
     */
    getPriceRange(bars = 20) {
        const lookback = Math.min(bars, this.priceHistory.length);
        const recent = this.priceHistory.slice(-lookback);

        if (recent.length === 0) return { min: 0, max: 0 };

        return {
            min: Math.min(...recent),
            max: Math.max(...recent),
        };
    }

    /**
     * Get price distance from center AMA (slow AMA)
     * @returns {Object} {distanceFromSlow, percentFromCenter}
     */
    getPriceDistanceFromCenter() {
        if (this.slowHistory.length === 0 || this.priceHistory.length === 0) {
            return { distanceFromSlow: 0, percentFromCenter: 0 };
        }

        const currentPrice = this.priceHistory[this.priceHistory.length - 1];
        const centerAMA = this.slowHistory[this.slowHistory.length - 1];
        const distance = currentPrice - centerAMA;
        const percentFromCenter = Math.abs(centerAMA) > 0
            ? (distance / centerAMA) * 100
            : 0;

        return {
            distanceFromSlow: Math.round(distance * 1000000) / 1000000, // 6 decimals
            percentFromCenter: Math.round(percentFromCenter * 100) / 100,
            isAboveCenter: distance > 0,
        };
    }

    /**
     * Get complete analysis snapshot
     * @returns {Object} Full state for analysis
     */
    getSnapshot() {
        if (this.priceHistory.length === 0) {
            return null;
        }

        const currentPrice = this.priceHistory[this.priceHistory.length - 1];
        const fastAMA = this.fastHistory[this.fastHistory.length - 1];
        const slowAMA = this.slowHistory[this.slowHistory.length - 1];
        const confirmed = this.getConfirmedTrend();
        const priceDistance = this.getPriceDistanceFromCenter();
        const priceRange = this.getPriceRange(20);

        return {
            price: currentPrice,
            fastAMA: Math.round(fastAMA * 1000000) / 1000000,
            slowAMA: Math.round(slowAMA * 1000000) / 1000000,
            amaSeparation: {
                absolute: Math.round(this.getAMASeparation() * 1000000) / 1000000,
                percent: Math.round(this.getAMASeparationPercent() * 100) / 100,
            },
            trend: confirmed,
            priceDistance,
            priceRange: {
                min: Math.round(priceRange.min * 1000000) / 1000000,
                max: Math.round(priceRange.max * 1000000) / 1000000,
            },
            historyLength: this.priceHistory.length,
        };
    }

    /**
     * Check price action confirmation (higher highs/lower lows)
     * @returns {Object} {isUptrend, isDowntrend, confirmsUp, confirmsDown}
     */
    getPriceActionConfirmation() {
        if (this.highHistory.length < 2) {
            return {
                isUptrend: false,
                isDowntrend: false,
                confirmsUp: false,
                confirmsDown: false,
            };
        }

        const currentHigh = this.highHistory[this.highHistory.length - 1];
        const previousHigh = this.highHistory[this.highHistory.length - 2];
        const currentLow = this.lowHistory[this.lowHistory.length - 1];
        const previousLow = this.lowHistory[this.lowHistory.length - 2];

        return {
            isUptrend: currentHigh > previousHigh && currentLow > previousLow,  // Higher highs AND higher lows
            isDowntrend: currentHigh < previousHigh && currentLow < previousLow,  // Lower highs AND lower lows
            confirmsUp: currentHigh > previousHigh,  // Just new high
            confirmsDown: currentLow < previousLow,  // Just new low
        };
    }

    /**
     * Reset the indicator
     */
    reset() {
        this.fastAMA = new AMA(40, 5, 15);
        this.slowAMA = new AMA(20, 2, 30);
        this.priceHistory = [];
        this.highHistory = [];
        this.lowHistory = [];
        this.fastHistory = [];
        this.slowHistory = [];
        this.prevTrendState = null;
        this.trendChangeCount = 0;
    }
}

module.exports = { DualAMA };
