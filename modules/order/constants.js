/* Constants and default configuration for OrderManager */
// Order categories used by the OrderManager when classifying grid entries.
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

// Life-cycle states assigned to generated or active orders.
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',
    ACTIVE: 'active',
    FILLED: 'filled'
});

// Defaults applied when instantiating an OrderManager with minimal configuration.
const DEFAULT_CONFIG = {
    marketPrice: "pool",
    minPrice: "5x",
    maxPrice: "5x",
    incrementPercent: 1,
    targetSpreadPercent: 5,
    active: true,
    dryRun: false,
    assetA: null,
    assetB: null,
    weightDistribution: { sell: 1, buy: 1 },
    botFunds: { buy: "100%", sell: "100%" },
    activeOrders: { buy: 24, sell: 24 },
    // Factor to multiply the smallest representable unit (based on asset precision)
    // to determine the minimum order size. E.g., factor=50 with precision=4 => minSize=0.005
    // Set to 0 or null to disable dynamic minimum (returns 0 when disabled)
    minOrderSizeFactor: 50,
    // Minimum spread factor to multiply the configured incrementPercent when
    // automatically adjusting `targetSpreadPercent`. For example, a factor of 2
    // means targetSpreadPercent will be at least `2 * incrementPercent`.
    minSpreadFactor: 2,
};

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG };

