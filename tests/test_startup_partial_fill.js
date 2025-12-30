const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { floatToBlockchainInt } = require('../modules/order/utils');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

console.log('Running offline partial-fill unit test (syncing startup orders)...');

// Create manager with a minimal config and mocked assets
const cfg = {
    assetA: 'ASSTA', assetB: 'ASSTB', marketPrice: 2,
    activeOrders: { buy: 1, sell: 1 },
    botFunds: { buy: 1000, sell: 1000 }
};
const mgr = new OrderManager(cfg);

// Mock asset metadata (ids and precisions) so conversions work
mgr.assets = {
    assetA: { id: '1.3.100', precision: 3 },
    assetB: { id: '1.3.101', precision: 3 }
};

// 1. Setup: Create a grid order that is VIRTUAL (or ACTIVE with missing ID)
const gridId = 'grid-1';
const initialSize = 10;
const price = 2;
// We start with it being VIRTUAL in our internal state (simulating a grid that was just loaded or an order that lost its ID)
const gridOrder = { id: gridId, orderId: null, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: initialSize, price };
mgr.orders.set(gridId, gridOrder);
mgr._ordersByState[ORDER_STATES.VIRTUAL].add(gridId);
mgr._ordersByType[ORDER_TYPES.SELL].add(gridId);

mgr.resetFunds();
mgr.setAccountTotals({ buy: 0, sell: initialSize, buyFree: 0, sellFree: 0 });
mgr.recalculateFunds();

// 2. Action: Simulate finding this order on chain during startup, but PARTIALLY FILLED
const partialFilledHuman = 4.0;
const remainingHuman = initialSize - partialFilledHuman;
const chainOrderId = '1.7.new';

const chainOrders = [{
    id: chainOrderId,
    sell_price: {
        base: { asset_id: mgr.assets.assetA.id, amount: Math.round(initialSize * Math.pow(10, mgr.assets.assetA.precision)) },
        quote: { asset_id: mgr.assets.assetB.id, amount: Math.round(initialSize * price * Math.pow(10, mgr.assets.assetB.precision)) }
    },
    for_sale: Math.round(remainingHuman * Math.pow(10, mgr.assets.assetA.precision))
}];

(async () => {
    try {
        console.log(`Initial state: ${mgr.orders.get(gridId).state}, size: ${mgr.orders.get(gridId).size}`);

        // Call synchronizeWithChain simulating startup sync
        const result = await mgr.synchronizeWithChain(chainOrders, 'readOpenOrders');

        const updated = mgr.orders.get(gridId);
        console.log(`Updated state: ${updated.state}, size: ${updated.size}, orderId: ${updated.orderId}`);

        // ASSERTIONS
        assert.strictEqual(updated.orderId, chainOrderId, 'Should have updated orderId');
        assert.strictEqual(updated.state, ORDER_STATES.PARTIAL, 'Should have transitioned to PARTIAL state');
        assert.strictEqual(updated.size, remainingHuman, 'Should have updated size to remaining amount');

        // Verify funds reflect the partial fill
        // committed.grid.sell should be 'remainingHuman'
        assert.strictEqual(mgr.funds.committed.grid.sell, remainingHuman, 'Committed grid funds should be updated');

        console.log('Offline partial-fill test passed.');
        process.exit(0);
    } catch (err) {
        console.error('Offline partial-fill test failed:', err);
        process.exit(1);
    }
})();
