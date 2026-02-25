const assert = require('assert');
const utils = require('../modules/order/utils/math');

// Mock getAssetFees to ensure test can run without blockchain connection
utils.getAssetFees = (asset, amount, isMaker = true) => {
    if (asset === 'BTS') {
        const createFee = 0.01;
        const updateFee = 0.0001;
        const makerNetFee = createFee * 0.1;
        const takerNetFee = createFee;
        const netFee = isMaker ? makerNetFee : takerNetFee;
        return {
            total: netFee + updateFee,
            createFee: createFee,
            updateFee: updateFee,
            makerNetFee: makerNetFee,
            takerNetFee: takerNetFee,
            netFee: netFee,
            netProceeds: amount + (isMaker ? createFee * 0.9 : 0),
            isMaker: isMaker
        };
    }
    return amount;
};

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testSimplifiedMergeStrategy() {
    console.log('Running test: Simplified Merge Strategy (COW)');

    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1, targetSpreadPercent: 1
    });

    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    // Set account totals
    await mgr.setAccountTotals({
        buy: 1000, sell: 1000,
        buyFree: 1000, sellFree: 1000
    });

    // 1. Setup Grid with a dust partial on BUY side
    await mgr._updateOrder({
        id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL,
        price: 0.99, size: 5, orderId: 'chain-buy-0'
    });
    await mgr._updateOrder({
        id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE,
        price: 0.98, size: 500, orderId: 'chain-buy-1'
    });

    mgr.finishBootstrap();

    console.log('  Scenario 1: Health check with dust partial');
    const collectedPlan = { ordersToUpdate: [], ordersToPlace: [] };
    await mgr.checkGridHealth(async (plan) => {
        if (plan.ordersToUpdate) collectedPlan.ordersToUpdate.push(...plan.ordersToUpdate);
        if (plan.ordersToPlace) collectedPlan.ordersToPlace.push(...plan.ordersToPlace);
    });

    const updateEntry = collectedPlan.ordersToUpdate.find(u => {
        const id = u.partialOrder?.id || u.id;
        return id === 'buy-0';
    });
    assert(updateEntry, 'Dust order should be queued for update in health check');
    assert(updateEntry.newSize > 400, `New size should be increased, got ${updateEntry.newSize}`);
    assert.strictEqual(mgr.buySideIsDoubled, true, 'Buy side should be marked as doubled after merging dust');
    console.log('  ✓ Side marked as doubled and order planned for update');

    // 2. Simulate a partial fill on the doubled side
    console.log('  Scenario 2: Partial fill on doubled side');
    const fill1 = {
        op: [4, {
            order_id: 'chain-buy-0',
            pays: { amount: 100000, asset_id: '1.3.2' }, 
            receives: { amount: 100000, asset_id: '1.3.1' }, 
            is_maker: true
        }],
        block_num: 123,
        id: '1.11.1'
    };

    const syncResult1 = await mgr.syncFromFillHistory(fill1);
    assert.strictEqual(mgr.buySideIsDoubled, false, 'Doubled flag should be reset after any fill');
    assert.strictEqual(syncResult1.filledOrders[0].isDoubleReplacementTrigger, true, 'Partial fill on doubled side SHOULD trigger double replacement');
    assert.strictEqual(syncResult1.filledOrders[0].isPartial, true, 'Partial fill on doubled side should preserve isPartial so slot remains open');
    assert.strictEqual(syncResult1.partialFill, true, 'Return value should still indicate partial fill');
    assert.strictEqual(syncResult1.filledOrders.length, 1, 'Partial fill on doubled side should produce exactly 1 fill entry (1 boundary shift)');
    console.log('  ✓ Partial fill on doubled side escalated: triggers rebalance with 1 boundary shift');

    // 3. Setup again and simulate a full fill on doubled side
    mgr.buySideIsDoubled = true;
    console.log('  Scenario 3: Full fill on doubled side');
    const fill2 = {
        op: [4, {
            order_id: 'chain-buy-0',
            pays: { amount: 50125629, asset_id: '1.3.2' }, 
            receives: { amount: 50125629, asset_id: '1.3.1' }, 
            is_maker: true
        }],
        block_num: 124,
        id: '1.11.2'
    };

    const syncResult2 = await mgr.syncFromFillHistory(fill2);
    assert.strictEqual(mgr.buySideIsDoubled, false, 'Doubled flag should be reset after full fill');
    assert.strictEqual(syncResult2.filledOrders.length, 2, 'Full fill on doubled side should produce 2 fill entries (2 boundary shifts)');
    assert.strictEqual(syncResult2.filledOrders[0].isDoubleReplacementTrigger, true, 'First fill entry should trigger double replacement');
    assert.strictEqual(syncResult2.filledOrders[1].isSyntheticDoubleFill, true, 'Second fill entry should be synthetic double fill');
    assert.strictEqual(syncResult2.filledOrders[1].isPartial, undefined, 'Synthetic fill should not have isPartial');
    console.log('  ✓ Full fill on doubled side produces 2 boundary shifts');

    // 4. Verify rebalance performs actions
    console.log('  Scenario 4: Rebalance after fill');
    
    mgr.accountTotals.sellFree = 2000;
    await mgr.recalculateFunds();

    await mgr._updateOrder({ id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.03, size: 0 });
    await mgr._updateOrder({ id: 'sell-3', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.04, size: 0 });
    mgr.config.activeOrders.sell = 4; 

    const result2 = await mgr.performSafeRebalance(syncResult2.filledOrders);
    
    assert(result2.actions.length > 0, 'Rebalance should produce actions');
    console.log('  ✓ Rebalance performs actions');

    console.log('✓ Simplified Merge Strategy test PASSED\n');
}

testSimplifiedMergeStrategy().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
