const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

console.log('Running full-fill fund logic verification test...');

const cfg = {
    assetA: 'IOB.XRP', assetB: 'BTS', marketPrice: 1920,
    activeOrders: { buy: 1, sell: 1 },
    botFunds: { buy: 1000, sell: 1000 }
};
const mgr = new OrderManager(cfg);

mgr.assets = {
    assetA: { id: '1.3.100', symbol: 'IOB.XRP', precision: 5 },
    assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
};

// 1. Setup: Create an ACTIVE grid order
const gridId = 'grid-1';
const initialSize = 10;
const price = 1920;
const gridOrder = { id: gridId, orderId: '1.7.123', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: initialSize, price };
mgr.orders.set(gridId, gridOrder);
mgr._ordersByState[ORDER_STATES.ACTIVE].add(gridId);
mgr._ordersByType[ORDER_TYPES.SELL].add(gridId);

// Initialize funds
mgr.resetFunds();
// Start with 1000 BTS free and 10 XRP free
mgr.setAccountTotals({ buy: 1000, sell: 20, buyFree: 1000, sellFree: 10 });
mgr.recalculateFunds();

const initialAvailableBuy = mgr.funds.available.buy;
console.log(`Initial available buy: ${initialAvailableBuy.toFixed(8)} BTS`);

// 2. Action: Call processFilledOrders for a FULL fill (simulating sync missing order)
const filledOrders = [gridOrder];

(async () => {
    try {
        console.log('Processing full fill...');
        const result = await mgr.processFilledOrders(filledOrders);

        console.log(`Final cacheFunds.buy: ${mgr.funds.cacheFunds.buy.toFixed(8)} BTS`);

        const expectedProceeds = initialSize * price;
        console.log(`Expected proceeds: ${expectedProceeds.toFixed(8)} BTS`);

        // Expected total in cacheFunds should be: initialAvailable + proceeds - fees
        // Fallback fee in test is 100 BTS
        const expectedTotal = initialAvailableBuy + expectedProceeds - 100;

        console.log(`Expected total in cacheFunds (after 100 BTS fee): ${expectedTotal.toFixed(8)}`);

        if (Math.abs(mgr.funds.cacheFunds.buy - expectedTotal) < 0.000001) {
            console.log('SUCCESS: No double-counting detected.');
        } else if (Math.abs(mgr.funds.cacheFunds.buy - (expectedTotal + expectedProceeds)) < 0.000001) {
            console.error('FAILURE: DOUBLE-COUNTING DETECTED!');
            console.error(`Actual: ${mgr.funds.cacheFunds.buy.toFixed(8)}`);
            process.exit(1);
        } else {
            console.error(`FAILURE: Unexpected result. Actual: ${mgr.funds.cacheFunds.buy.toFixed(8)}`);
            process.exit(1);
        }

        const updated = mgr.orders.get(gridId);
        assert.strictEqual(updated.type, ORDER_TYPES.SPREAD, 'Should be updated to SPREAD');
        assert.strictEqual(updated.state, ORDER_STATES.VIRTUAL, 'Should be updated to VIRTUAL');
        assert.strictEqual(updated.size, 0, 'Size should be 0');

        console.log('Full-fill fund logic test passed (state & funds verified).');
        process.exit(0);
    } catch (err) {
        console.error('Test error:', err);
        process.exit(1);
    }
})();
