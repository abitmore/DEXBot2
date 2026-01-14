const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testSimplifiedMergeStrategy() {
    console.log('Running test: Simplified Merge Strategy');

    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1, targetSpreadPercent: 1
    });

    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    // 1. Setup Grid with a dust partial on BUY side
    // Ideal size for 2 orders with 1000 budget is ~500 each.
    mgr._updateOrder({
        id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL,
        price: 0.99, size: 5, orderId: 'chain-buy-0'
    });
    mgr._updateOrder({
        id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE,
        price: 0.98, size: 500, orderId: 'chain-buy-1'
    });
    mgr._updateOrder({
        id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE,
        price: 1.01, size: 500, orderId: 'chain-sell-0'
    });
    mgr._updateOrder({
        id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE,
        price: 1.02, size: 500, orderId: 'chain-sell-1'
    });

    console.log('  Scenario 1: Rebalance with dust partial');
    const result1 = await mgr.strategy.rebalance();
    
    // Check if buy side is marked as doubled
    assert.strictEqual(mgr.buySideIsDoubled, true, 'Buy side should be marked as doubled after merging dust');
    
    // Check if the order was updated to ideal size (approx 500)
    const update = result1.ordersToUpdate.find(u => u.partialOrder.orderId === 'chain-buy-0');
    assert(update, 'Dust order should be in ordersToUpdate');
    assert(update.newSize > 400 && update.newSize < 600, `New size should be around 500, got ${update.newSize}`);
    console.log('  ✓ Side marked as doubled and order updated to ideal size');

    // 2. Simulate a partial fill on the doubled side
    console.log('  Scenario 2: Partial fill on doubled side');
    const fill1 = {
        op: [1, {
            order_id: 'chain-buy-0',
            pays: { amount: 100000, asset_id: '1.3.2' }, // paying QUOTE
            is_maker: true
        }],
        block_num: 123,
        id: '1.11.1'
    };

    const syncResult1 = mgr.syncFromFillHistory(fill1);
    assert.strictEqual(mgr.buySideIsDoubled, false, 'Doubled flag should be reset after any fill');
    assert(!syncResult1.filledOrders[0].isDoubleReplacementTrigger, 'Partial fill should NOT trigger double replacement');
    console.log('  ✓ Doubled flag reset after partial fill');

    // 3. Setup again and simulate a full fill on doubled side
    mgr.buySideIsDoubled = true;
    console.log('  Scenario 3: Full fill on doubled side');
    const fill2 = {
        op: [1, {
            order_id: 'chain-buy-0',
            pays: { amount: 50125629, asset_id: '1.3.2' }, // paying ~501 QUOTE (full fill)
            is_maker: true
        }],
        block_num: 124,
        id: '1.11.2'
    };

    const syncResult2 = mgr.syncFromFillHistory(fill2);
    assert.strictEqual(mgr.buySideIsDoubled, false, 'Doubled flag should be reset after full fill');
    assert.strictEqual(syncResult2.filledOrders[0].isDoubleReplacementTrigger, true, 'Full fill on doubled side SHOULD trigger double replacement');
    console.log('  ✓ Full fill on doubled side triggers double replacement');

    // 4. Verify rebalance honors the double replacement trigger
    console.log('  Scenario 4: Rebalance with double replacement trigger');
    
    // Setup budget to allow placements
    mgr.accountTotals.sellFree = 2000;
    mgr.recalculateFunds();

    // Add virtual slots for SELL side so we have shortages to fill
    mgr._updateOrder({ id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.03, size: 0 });
    mgr._updateOrder({ id: 'sell-3', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.04, size: 0 });
    mgr.config.activeOrders.sell = 4; // Increase target so we have shortages

    const result2 = await mgr.strategy.rebalance(syncResult2.filledOrders);
    
    // A full BUY fill triggers SELL replacements.
    // Reaction cap for SELL should be 2.
    // In this simple test, we have 2 target SELLs. 
    // If one filled, and we have double trigger, we should see 2 SELL placements/rotations if budget allowed.
    // Since we only filled ONE buy order, and it was a double trigger, we expect 2 actions on the SELL side.
    
    const sellActions = result2.ordersToPlace.filter(o => o.type === ORDER_TYPES.SELL).length + 
                        result2.ordersToRotate.filter(o => o.type === ORDER_TYPES.SELL).length;
    
    assert.strictEqual(sellActions, 2, `Expected 2 actions on SELL side, got ${sellActions}`);
    console.log('  ✓ Rebalance performs 2 actions on opposite side');

    console.log('✓ Simplified Merge Strategy test PASSED\n');
}

testSimplifiedMergeStrategy().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
