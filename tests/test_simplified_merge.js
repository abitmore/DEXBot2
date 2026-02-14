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

    console.log('  Scenario 1: Rebalance with dust partial');
    const result1 = await mgr.performSafeRebalance();
    
    // Check if the order was updated to ideal size
    const update = result1.actions.find(a => a.id === 'buy-0' && a.type === 'update');
    assert(update, 'Dust order should be in actions as update');
    assert(update.newSize > 400, `New size should be increased, got ${update.newSize}`);
    
    // In COW, sideIsDoubled is flagged during planning if it's a dust partial update
    // But calculateTargetGrid might not set it on the manager instance directly yet?
    // Actually, it should because it's a side effect in current implementation.
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
    assert(!syncResult1.filledOrders[0].isDoubleReplacementTrigger, 'Partial fill should NOT trigger double replacement');
    console.log('  ✓ Doubled flag reset after partial fill');

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
    assert.strictEqual(syncResult2.filledOrders[0].isDoubleReplacementTrigger, true, 'Full fill on doubled side SHOULD trigger double replacement');
    console.log('  ✓ Full fill on doubled side triggers double replacement');

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
