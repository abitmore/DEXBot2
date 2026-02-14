const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const Grid = require('../modules/order/grid');

console.log('='.repeat(80));
console.log('Testing Critical Bug Fixes (COW)');
console.log('='.repeat(80));

// Helper to setup a manager
async function setupManager() {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        minPrice: 0.1,
        maxPrice: 10.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => { }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });

    return mgr;
}

// ============================================================================
// TEST 1: SPREAD SORTING
// ============================================================================
async function testSpreadSorting() {
    console.log('\n[Test 1] Target selection prioritizes closest market price');
    console.log('-'.repeat(80));

    const mgr = await setupManager();
    const { orders, boundaryIdx } = Grid.createOrderGrid(mgr.config);
    
    // Index
    for (const o of orders) {
        mgr.orders.set(o.id, o);
        await mgr._updateOrder(o);
    }
    mgr.boundaryIdx = boundaryIdx;

    // Force a surplus far away on sell side
    const furthestSell = Array.from(mgr.orders.values())
        .filter(o => o.type === ORDER_TYPES.SELL)
        .sort((a,b) => b.price - a.price)[0];
    
    await mgr._updateOrder({ ...furthestSell, state: ORDER_STATES.ACTIVE, orderId: 'chain-surplus', size: 100 });

    // Target count 1 ensures furthest is surplus
    mgr.config.activeOrders.sell = 1;

    // Rebalance
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);
    
    const creation = result.actions.find(a => a.type === 'create');
    assert(creation, 'Should plan at least one creation');

    const sameSideVirtuals = Array.from(mgr.orders.values()).filter(o => o.type === creation.order.type && o.state === ORDER_STATES.VIRTUAL);
    
    const expectedNearest = creation.order.type === ORDER_TYPES.BUY
        ? sameSideVirtuals.sort((a, b) => b.price - a.price)[0]
        : sameSideVirtuals.sort((a, b) => a.price - b.price)[0];

    assert.strictEqual(
        creation.order.price,
        expectedNearest.price,
        `Should target nearest shortage at ${expectedNearest.price}, got ${creation.order.price}`
    );

    console.log(`✓ Target selection correctly picked nearest shortage`);
}

// ============================================================================
// TEST 2: STATE TRANSITION STABILITY - ORDERS STAY ACTIVE AT 100%
// ============================================================================
async function testOrderStateTransitionStability() {
    console.log('\n[Test 2] Order state transition stays ACTIVE when size >= 100%');
    console.log('-'.repeat(80));

    const mgr = await setupManager();

    const activeOrder = {
        id: 'sell-test',
        orderId: 'chain-test-sell',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 10.2, 
        state: ORDER_STATES.ACTIVE
    };

    await mgr._updateOrder(activeOrder);

    const updatedOrder = { ...activeOrder, size: 10.0, state: ORDER_STATES.ACTIVE };
    await mgr._updateOrder(updatedOrder);

    const after = mgr.orders.get('sell-test');
    assert(after.state === ORDER_STATES.ACTIVE, `Should remain ACTIVE when size=100%, got ${after.state}`);

    const partialOrder = { ...activeOrder, size: 5.0, state: ORDER_STATES.PARTIAL };
    await mgr._updateOrder(partialOrder);

    const final = mgr.orders.get('sell-test');
    assert(final.state === ORDER_STATES.PARTIAL, `Should transition to PARTIAL when size < 100%`);

    console.log('✓ Order state transitions correctly based on size threshold');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testSpreadSorting();
        await testOrderStateTransitionStability();

        console.log('\n' + '='.repeat(80));
        console.log('Critical Bug Fix Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
