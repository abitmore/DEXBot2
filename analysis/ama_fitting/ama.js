/**
 * Kaufman's Adaptive Moving Average (KAMA)
 */
class AMA {
    constructor(erPeriod = 10, fastPeriod = 2, slowPeriod = 30) {
        this.erPeriod = erPeriod;
        this.fastSC = 2 / (fastPeriod + 1);
        this.slowSC = 2 / (slowPeriod + 1);
        this.prevAMA = null;
        this.history = []; // Keep track of closing prices for ER calc
    }

    /**
     * Calculate AMA for a new price point
     * @param {number} price - Current closing price
     * @returns {number} Current AMA value
     */
    update(price) {
        this.history.push(price);

        // Maintain history buffer
        if (this.history.length > this.erPeriod + 1) {
            this.history.shift();
        }

        // Need enough history to calculate ER
        if (this.history.length <= this.erPeriod) {
            this.prevAMA = price; // Initialize with price until we have enough data
            return price;
        }

        // 1. Efficiency Ratio (ER)
        // Direction = |Price - Price(n-ago)|
        const direction = Math.abs(price - this.history[0]);
        
        // Volatility = Sum( |Price(i) - Price(i-1)| )
        let volatility = 0;
        for (let i = 1; i < this.history.length; i++) {
            volatility += Math.abs(this.history[i] - this.history[i-1]);
        }

        const er = volatility === 0 ? 0 : direction / volatility;

        // 2. Smoothing Constant (SC)
        // sc = [ER * (fast - slow) + slow]^2
        const smooth = Math.pow(er * (this.fastSC - this.slowSC) + this.slowSC, 2);

        // 3. AMA Calculation
        // AMA = PriorAMA + SC * (Price - PriorAMA)
        const ama = this.prevAMA + smooth * (price - this.prevAMA);
        
        this.prevAMA = ama;
        return ama;
    }
}

/**
 * Batch process a list of candles
 * @param {Array} closes - Array of closing prices
 * @param {Object} params - { erPeriod, fastPeriod, slowPeriod }
 * @returns {Array} Array of AMA values corresponding to the inputs
 */
function calculateAMA(closes, params) {
    const indicator = new AMA(params.erPeriod, params.fastPeriod, params.slowPeriod);
    return closes.map(price => indicator.update(price));
}

module.exports = { AMA, calculateAMA };
