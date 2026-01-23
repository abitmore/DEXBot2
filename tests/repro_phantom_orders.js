/**
 * tests/repro_phantom_orders.js
 * 
 * Reproduction test for "phantom" active orders causing doubled funds.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');
const Grid = require('../modules/order/grid.js');

async function runRepro() {
    console.log('Running Phantom Orders Reproduction...');

    const mgr = new OrderManager({
        market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS'
    });
    mgr.assets = {
        assetA: { id: '1.3.0', symbol: 'TEST', precision: 8 },
        assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 }
    };
    mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });

    console.log(' - Step 1: Create a phantom order (ACTIVE with no ID)');
    mgr._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE, // Phantom active
        size: 10,
        price: 1.0,
        orderId: '' // No ID
    });

    mgr.recalculateFunds();
    const initialTracked = mgr.funds.committed.grid.sell;
    console.log(`   Tracked SELL total: ${initialTracked}`);
    assert.strictEqual(initialTracked, 10, 'Tracked total should include the phantom order');

    console.log(' - Step 2: Run sync with empty chain orders');
    // Current bug: SyncEngine skips ACTIVE orders with no ID, so it won't clean this up.
    await mgr.sync.syncFromOpenOrders([]);

    mgr.recalculateFunds();
    const afterSyncTracked = mgr.funds.committed.grid.sell;
    console.log(`   Tracked SELL total after sync: ${afterSyncTracked}`);

    if (afterSyncTracked === 10) {
        console.log('   RESULT: BUG REPRODUCED - Phantom order survived sync!');
    } else if (afterSyncTracked === 0) {
        console.log('   RESULT: Phantom order was cleaned up.');
    }

    console.log(' - Step 3: Verify fix for Grid._updateOrdersForSide');
    // This is the other part of the bug: resizing creates phantoms
    const dummyOrders = [{ id: 'slot-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 }];
    mgr.orders.set('slot-2', dummyOrders[0]);

    console.log('   Running Grid._updateOrdersForSide with new size...');
    Grid._updateOrdersForSide(mgr, ORDER_TYPES.SELL, [20], dummyOrders);

    const resizedOrder = mgr.orders.get('slot-2');
    console.log(`   Resized order state: ${resizedOrder.state}, size: ${resizedOrder.size}`);

    if (resizedOrder.state === ORDER_STATES.ACTIVE && !resizedOrder.orderId) {
        console.log('   RESULT: BUG REPRODUCED - Resize created a phantom active order!');
    }

    process.exit(afterSyncTracked === 10 || resizedOrder.state === ORDER_STATES.ACTIVE ? 1 : 0);
}

runRepro().catch(err => {
    console.error('Repro failed with error:', err);
    process.exit(1);
});
