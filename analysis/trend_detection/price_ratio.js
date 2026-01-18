/**
 * Price Ratio Analysis
 * Analyzes price position relative to AMA center and min/max range
 * Simple metrics for understanding price action in context of trend
 */

class PriceRatio {
    /**
     * Initialize price ratio analyzer
     * @param {number} lookbackBars - Number of bars to analyze (default: 20)
     */
    constructor(lookbackBars = 20) {
        this.lookbackBars = lookbackBars;
        this.priceHistory = [];
        this.amaHistory = []; // Slow AMA (center price)
    }

    /**
     * Update with current price and center AMA
     * @param {number} price - Current price
     * @param {number} centerAMA - Slow AMA (center reference)
     */
    update(price, centerAMA) {
        this.priceHistory.push(price);
        this.amaHistory.push(centerAMA);

        // Keep only lookback + 1 bars
        if (this.priceHistory.length > this.lookbackBars + 1) {
            this.priceHistory.shift();
            this.amaHistory.shift();
        }
    }

    /**
     * Get min/max price in lookback window
     * @returns {Object} {min, max, range}
     */
    getPriceRange() {
        if (this.priceHistory.length === 0) {
            return { min: 0, max: 0, range: 0 };
        }

        const min = Math.min(...this.priceHistory);
        const max = Math.max(...this.priceHistory);

        return {
            min,
            max,
            range: max - min,
        };
    }

    /**
     * Get current price position within min/max range (0-1)
     * 0 = at minimum, 1 = at maximum, 0.5 = middle
     * @returns {number} Position 0-1
     */
    getPricePositionInRange() {
        if (this.priceHistory.length === 0) return 0.5;

        const currentPrice = this.priceHistory[this.priceHistory.length - 1];
        const range = this.getPriceRange();

        if (range.range === 0) return 0.5;

        return (currentPrice - range.min) / range.range;
    }

    /**
     * Get min/max AMA values in lookback window
     * @returns {Object} {min, max, range}
     */
    getAMARange() {
        if (this.amaHistory.length === 0) {
            return { min: 0, max: 0, range: 0 };
        }

        const min = Math.min(...this.amaHistory);
        const max = Math.max(...this.amaHistory);

        return {
            min,
            max,
            range: max - min,
        };
    }

    /**
     * Get ratio: (min_to_max_price_range) / (center_AMA)
     * Indicates how much price oscillates relative to the AMA level
     * Low ratio = tight range relative to AMA (good for grid)
     * High ratio = wide range relative to AMA (choppy market)
     * @returns {number} Ratio as percentage
     */
    getOscillationRatio() {
        if (this.amaHistory.length === 0) return 0;

        const centerAMA = this.amaHistory[this.amaHistory.length - 1];
        const priceRange = this.getPriceRange();

        if (Math.abs(centerAMA) === 0) return 0;

        return (priceRange.range / Math.abs(centerAMA)) * 100;
    }

    /**
     * Get price position relative to center AMA
     * Positive = above AMA, Negative = below AMA
     * @returns {Object} {distance, percentFromAMA, isAboveAMA}
     */
    getPriceVsAMA() {
        if (this.priceHistory.length === 0 || this.amaHistory.length === 0) {
            return {
                distance: 0,
                percentFromAMA: 0,
                isAboveAMA: false,
            };
        }

        const currentPrice = this.priceHistory[this.priceHistory.length - 1];
        const centerAMA = this.amaHistory[this.amaHistory.length - 1];
        const distance = currentPrice - centerAMA;
        const percentFromAMA = Math.abs(centerAMA) > 0
            ? (distance / Math.abs(centerAMA)) * 100
            : 0;

        return {
            distance: Math.round(distance * 1000000) / 1000000,
            percentFromAMA: Math.round(percentFromAMA * 100) / 100,
            isAboveAMA: distance > 0,
        };
    }

    /**
     * Analyze price direction relative to AMA
     * @returns {Object} {direction, isMovingTowardAMA}
     */
    getPriceDirection() {
        if (this.priceHistory.length < 2 || this.amaHistory.length < 2) {
            return {
                direction: 'UNKNOWN',
                isMovingTowardAMA: false,
                priceChange: 0,
                amaChange: 0,
            };
        }

        const current = this.priceHistory[this.priceHistory.length - 1];
        const prev = this.priceHistory[this.priceHistory.length - 2];
        const priceChange = current - prev;

        const currentAMA = this.amaHistory[this.amaHistory.length - 1];
        const prevAMA = this.amaHistory[this.amaHistory.length - 2];
        const amaChange = currentAMA - prevAMA;

        // Determine if price is moving toward or away from AMA
        const currentDistance = current - currentAMA;
        const prevDistance = prev - prevAMA;

        const isMovingTowardAMA = Math.abs(currentDistance) < Math.abs(prevDistance);

        const direction = priceChange > 0 ? 'UP' : priceChange < 0 ? 'DOWN' : 'FLAT';

        return {
            direction,
            isMovingTowardAMA,
            priceChange: Math.round(priceChange * 1000000) / 1000000,
            amaChange: Math.round(amaChange * 1000000) / 1000000,
        };
    }

    /**
     * Get comprehensive ratio analysis
     * @returns {Object} Full analysis snapshot
     */
    getSnapshot() {
        if (this.priceHistory.length === 0) return null;

        return {
            priceRange: this.getPriceRange(),
            pricePosition: {
                inRange: Math.round(this.getPricePositionInRange() * 10000) / 100, // 0-100%
            },
            amaRange: this.getAMARange(),
            oscillationRatio: Math.round(this.getOscillationRatio() * 100) / 100,
            priceVsAMA: this.getPriceVsAMA(),
            priceDirection: this.getPriceDirection(),
            lookbackBars: this.lookbackBars,
        };
    }

    /**
     * Reset the analyzer
     */
    reset() {
        this.priceHistory = [];
        this.amaHistory = [];
    }
}

module.exports = { PriceRatio };
