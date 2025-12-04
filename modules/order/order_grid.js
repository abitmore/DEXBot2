const { ORDER_TYPES, DEFAULT_CONFIG } = require('./constants');

// Build the foundational grid of virtual orders based on increments, spread, and funds.
class OrderGridGenerator {
    static createOrderGrid(config) {
        // Compute helper arrays of buy/sell price levels relative to the market price.
        const { marketPrice, minPrice, maxPrice, incrementPercent } = config;
        // Use explicit step multipliers for clarity:
        const stepUp = 1 + (incrementPercent / 100);    // e.g. 1.02 for +2%
        const stepDown = 1 - (incrementPercent / 100);  // e.g. 0.98 for -2%
        
        // Ensure targetSpreadPercent is at least `minSpreadFactor * incrementPercent` to guarantee spread orders.
        // This implementation uses the global default `DEFAULT_CONFIG.minSpreadFactor` (no per-bot overrides).
        const spreadFactor = Number(DEFAULT_CONFIG.minSpreadFactor);
        const minSpreadPercent = incrementPercent * spreadFactor;
        const targetSpreadPercent = Math.max(config.targetSpreadPercent, minSpreadPercent);
        if (config.targetSpreadPercent < minSpreadPercent) {
            console.log(`[WARN] targetSpreadPercent (${config.targetSpreadPercent}%) is less than ${spreadFactor}*incrementPercent (${minSpreadPercent.toFixed(2)}%). ` +
                        `Auto-adjusting to ${minSpreadPercent.toFixed(2)}% to ensure spread orders are created.`);
        }
        
        // Calculate number of spread orders based on target spread vs increment
        // Ensure at least 2 spread orders (1 buy, 1 sell) to maintain a proper spread zone
        // Number of increments needed to cover the target spread using stepUp^n >= (1 + targetSpread)
        const calculatedNOrders = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(stepUp));
        const nOrders = Math.max(2, calculatedNOrders); // Minimum 2 spread orders

        const calculateLevels = (start, min) => {
            const levels = [];
            for (let current = start; current >= min; current *= stepDown) {
                levels.push(current);
            }
            return levels;
        };

        const sellLevels = calculateLevels(maxPrice, marketPrice);
        // Start the buy side one step below the last sell level (or marketPrice) using stepDown
        const buyStart = (sellLevels[sellLevels.length - 1] || marketPrice) * stepDown;
        const buyLevels = calculateLevels(buyStart, minPrice);

        const buySpread = Math.floor(nOrders / 2);
        const sellSpread = nOrders - buySpread;
        const initialSpreadCount = { buy: 0, sell: 0 };

        const sellOrders = sellLevels.map((price, i) => ({
            price,
            type: i >= sellLevels.length - sellSpread ? (initialSpreadCount.sell++, ORDER_TYPES.SPREAD) : ORDER_TYPES.SELL,
            id: `sell-${i}`,
            state: 'virtual'
        }));

        const buyOrders = buyLevels.map((price, i) => ({
            price,
            type: i < buySpread ? (initialSpreadCount.buy++, ORDER_TYPES.SPREAD) : ORDER_TYPES.BUY,
            id: `buy-${i}`,
            state: 'virtual'
        }));

        return { orders: [...sellOrders, ...buyOrders], initialSpreadCount };
    }

    // Distribute funds across the grid respecting weights and increment guidance.
    static calculateOrderSizes(orders, config, sellFunds, buyFunds) {
        const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
        const incrementFactor = incrementPercent / 100;

        const calculateSizes = (orders, weight, totalFunds) => {
            if (orders.length === 0 || totalFunds <= 0) return new Array(orders.length).fill(0);

            const weights = orders.map((_, i) => Math.pow(1 - incrementFactor, (weight === sellWeight ? orders.length - 1 - i : i) * weight));
            const totalWeight = weights.reduce((sum, w) => sum + w, 0);
            return weights.map(w => w * (totalFunds / totalWeight));
        };

        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

        const sellSizes = calculateSizes(sellOrders, sellWeight, sellFunds);
        const buySizes = calculateSizes(buyOrders, buyWeight, buyFunds);

        const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
        return orders.map(order => ({
            ...order,
            size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
        }));
    }
}

module.exports = OrderGridGenerator;

