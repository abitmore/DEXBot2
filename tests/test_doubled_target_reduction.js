const assert = require('assert');
const utils = require('../modules/order/utils/math');

// Mock getAssetFees
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

async function testDoubledTargetReduction() {
    console.log('Running test: Doubled Target Reduction (COW)');

    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1, targetSpreadPercent: 1
    });

    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    await mgr.setAccountTotals({
        buy: 1000, sell: 1000,
        buyFree: 1000, sellFree: 1000
    });

    // 1. Initial setup
    console.log('  Scenario 1: Initial setup (5 orders per side)');
    for(let i=0; i<20; i++) {
        const type = i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        const price = i < 10 ? 0.95 - (i * 0.01) : 1.05 + ((i-10) * 0.01);
        await mgr._updateOrder({ id: `slot-${i}`, type, state: ORDER_STATES.VIRTUAL, price, size: 0 });
    }
    mgr.boundaryIdx = 9; 

    // Initial rebalance to setup grid
    const setupRes = await mgr.performSafeRebalance();
    const placements = setupRes.actions.filter(a => a.type === 'create');
    
    // Manually set orders to ACTIVE
    for (const action of placements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `chain-${action.id}` });
    }
    await mgr.recalculateFunds();
    
    const buyCount1 = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL)).length;
    assert.strictEqual(buyCount1, 5, `Expected 5 buy orders, got ${buyCount1}`);
    console.log('  ✓ Initial setup complete with 5 orders');

    // 2. Set buySideIsDoubled = true and rebalance
    console.log('  Scenario 2: Set buySideIsDoubled = true');
    mgr.buySideIsDoubled = true;
    const result2 = await mgr.performSafeRebalance();
    
    // In COW result, we should see one 'cancel' action for a buy order
    const cancels = result2.actions.filter(a => a.type === 'cancel');
    // Apply cancels to grid
    for (const action of cancels) {
        const order = mgr.orders.get(action.id);
        if (order.type === ORDER_TYPES.BUY) {
            await mgr._updateOrder({ ...order, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null });
        }
    }
    
    const buyOrders2 = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL));
    assert.strictEqual(buyOrders2.length, 4, `Expected 4 buy orders when doubled, got ${buyOrders2.length}`);
    console.log('  ✓ Buy side target count reduced to 4');

    // 3. Reset buySideIsDoubled = false and rebalance
    console.log('  Scenario 3: Reset buySideIsDoubled = false');
    mgr.buySideIsDoubled = false;
    const result3 = await mgr.performSafeRebalance();
    
    // Should see one 'create' for buy side
    const placements3 = result3.actions.filter(a => a.type === 'create' && a.order.type === ORDER_TYPES.BUY);
    for (const action of placements3) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `chain-${action.id}` });
    }

    const buyOrders3 = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL));
    assert.strictEqual(buyOrders3.length, 5, `Expected 5 buy orders after reset, got ${buyOrders3.length}`);
    console.log('  ✓ Buy side target count returned to 5');

    // 4. Test manager.getInitialOrdersToActivate
    console.log('  Scenario 4: Test manager.getInitialOrdersToActivate');
    mgr.buySideIsDoubled = true;
    const initialOrders = mgr.getInitialOrdersToActivate();
    const initialBuys = initialOrders.filter(o => o.type === ORDER_TYPES.BUY);
    assert.strictEqual(initialBuys.length, 4, `Expected 4 initial buy orders when doubled, got ${initialBuys.length}`);
    console.log('  ✓ Initial activation count reduced to 4');

    console.log('✓ Doubled Target Reduction test PASSED\n');
}

testDoubledTargetReduction().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
