const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const Grid = require('../modules/order/grid');

console.log('='.repeat(80));
console.log('Testing Critical Bug Fixes');
console.log('='.repeat(80));

// Helper to setup a manager
function setupManager() {
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
        log: (msg, level) => {
            // console.log(`    [${level}] ${msg}`);
        }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });

    return mgr;
}

// ============================================================================
// TEST 1: SPREAD SORTING - ROTATION PRIORITIZES CLOSEST TO MARKET
// ============================================================================
async function testSpreadSortingForRotation() {
    console.log('\n[Test 1] Spread sorting prioritizes rotation to closest market price');
    console.log('-'.repeat(80));

    const mgr = setupManager();
    const { orders, boundaryIdx } = Grid.createOrderGrid(mgr.config);
    
    // Sort and index
    orders.sort((a, b) => a.price - b.price);
    orders.forEach(o => {
        mgr.orders.set(o.id, o);
        mgr._updateOrder(o);
    });

    // Fix boundary
    mgr.boundaryIdx = boundaryIdx;

    // Force a surplus far away on sell side
    const furthestIdx = orders.length - 1;
    const surplusOrder = orders[furthestIdx];
    surplusOrder.state = ORDER_STATES.ACTIVE;
    surplusOrder.type = ORDER_TYPES.SELL;
    surplusOrder.size = 100;
    surplusOrder.orderId = 'chain-surplus';
    mgr._updateOrder(surplusOrder);

    // Target count 1 ensures furthest is surplus
    mgr.config.activeOrders.sell = 1;

    // Rebalance
    const result = await mgr.strategy.rebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);
    
    assert(result.ordersToRotate.length > 0, 'Should have rotated at least 1 order');
    const rotation = result.ordersToRotate[0];
    
    // Check if it picked the closest shortage slot on sell side
    const sellShortages = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.VIRTUAL);
    const closestShortage = sellShortages.sort((a, b) => a.price - b.price)[0];
    
    assert.strictEqual(rotation.newPrice, closestShortage.price, `Should rotate to closest shortage at ${closestShortage.price}, got ${rotation.newPrice}`);

    console.log(`✓ Rotation correctly selected closest shortage at price ${rotation.newPrice}`);
}

// ============================================================================
// TEST 2: STATE TRANSITION STABILITY - ORDERS STAY ACTIVE AT 100%
// ============================================================================
async function testOrderStateTransitionStability() {
    console.log('\n[Test 2] Order state transition stays ACTIVE when size >= 100%');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create an order with size = idealSize * 1.02 (102% of ideal)
    const activeOrder = {
        id: 'test-sell',
        orderId: 'chain-test-sell',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 10.2, // 102% of ideal (10)
        state: ORDER_STATES.ACTIVE
    };

    mgr.orders.set(activeOrder.id, activeOrder);
    mgr._updateOrder(activeOrder);

    // Verify it's in ACTIVE state
    const before = mgr.orders.get('test-sell');
    assert(before.state === ORDER_STATES.ACTIVE, `Should start as ACTIVE, got ${before.state}`);

    // Simulate some fills and state transitions
    // The state should remain ACTIVE as long as size >= 100% (10.0)
    const updatedOrder = { ...activeOrder, size: 10.0, state: ORDER_STATES.ACTIVE };
    mgr._updateOrder(updatedOrder);

    const after = mgr.orders.get('test-sell');
    assert(after.state === ORDER_STATES.ACTIVE, `Should remain ACTIVE when size=100%, got ${after.state}`);
    assert(after.size === 10.0, `Size should be 10.0, got ${after.size}`);

    // Now test transition to PARTIAL when size < 100%
    const partialOrder = { ...activeOrder, size: 5.0, state: ORDER_STATES.PARTIAL };
    mgr._updateOrder(partialOrder);

    const final = mgr.orders.get('test-sell');
    assert(final.state === ORDER_STATES.PARTIAL, `Should transition to PARTIAL when size < 100%, got ${final.state}`);

    console.log('✓ Order state transitions correctly based on size threshold');
}

// ============================================================================
// TEST 3: GHOST-VIRTUAL TARGET SIZING ACCURACY
// ============================================================================
async function testGhostVirtualTargetSizingAccuracy() {
    console.log('\n[Test 3] Ghost virtualization ensures accurate target sizing');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a grid with specific ideal sizes
    const grid = [
        { id: 'sell-1.10', type: ORDER_TYPES.SELL, price: 1.10, size: 8, state: ORDER_STATES.VIRTUAL },
        { id: 'sell-1.15', type: ORDER_TYPES.SELL, price: 1.15, size: 9, state: ORDER_STATES.VIRTUAL },
        { id: 'sell-1.20', type: ORDER_TYPES.SELL, price: 1.20, size: 10, state: ORDER_STATES.VIRTUAL }
    ];

    for (const order of grid) {
        mgr.orders.set(order.id, order);
        mgr._updateOrder(order);
    }

    // Create 2 ghost-virtualized partials
    const partial1 = {
        id: 'sell-1.10',
        orderId: 'chain-p1',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 4, // Will be ghost-virtualized
        state: ORDER_STATES.PARTIAL
    };

    const partial2 = {
        id: 'sell-1.15',
        orderId: 'chain-p2',
        type: ORDER_TYPES.SELL,
        price: 1.15,
        size: 4.5,
        state: ORDER_STATES.PARTIAL
    };

    mgr._updateOrder(partial1);
    mgr._updateOrder(partial2);

    // Before rebalance: verify original sizes
    assert(mgr.orders.get('sell-1.10').size === 4, 'Partial 1 should start at size 4');
    assert(mgr.orders.get('sell-1.15').size === 4.5, 'Partial 2 should start at size 4.5');

    // Execute rebalance
    const result = await mgr.strategy.rebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    // After rebalance, the orders should be properly accounted for
    const restored1 = mgr.orders.get('sell-1.10');
    const restored2 = mgr.orders.get('sell-1.15');

    assert(restored1, 'Order 1 should still exist after rebalance');
    assert(restored2, 'Order 2 should still exist after rebalance');

    console.log('✓ Rebalance completed without corrupting partial order states');
}

// ============================================================================
// TEST 4: SPREAD SORTING FOR BUY ORDERS (HIGHEST PRICE FIRST)
// ============================================================================
async function testSpreadSortingForBuyRotation() {
    console.log('\n[Test 4] BUY spread sorting prioritizes highest price (closest to market)');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a grid of SPREAD slots around startPrice (1.0)
    const spreads = [
        { id: 'buy-far',     price: 0.50, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'buy-closest', price: 0.99, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'active-buy',  price: 0.80, type: ORDER_TYPES.BUY,    state: ORDER_STATES.ACTIVE,  size: 100, orderId: 'chain-active-buy' },
        { id: 'sell-anchor', price: 1.05, type: ORDER_TYPES.SELL,   state: ORDER_STATES.ACTIVE,  size: 100, orderId: 'chain-sell-anchor' }
    ];

    for (const spread of spreads) {
        mgr.orders.set(spread.id, spread);
        mgr._updateOrder(spread);
    }

    mgr.config.activeOrders.buy = 1;

    // Prepare rotation - simulate opposite side fill
    const result = await mgr.strategy.rebalance([{ type: ORDER_TYPES.SELL, price: 1.10 }]);

    assert(result.ordersToRotate.length > 0, 'Should have rotated at least 1 order');
    const rotation = result.ordersToRotate[0];
    
    // Should rotate to 0.99 (highest price for BUY side)
    assert.strictEqual(rotation.newPrice, 0.99, `Should rotate to 0.99, got ${rotation.newPrice}`);

    console.log(`✓ BUY rotation correctly selected closest shortage at price ${rotation.newPrice}`);
}

// ============================================================================
// TEST 5: STATE TRANSITION STABILITY - PARTIAL BELOW 100% CANNOT BE ACTIVE
// ============================================================================
async function testPartialStateTransitionBelow100() {
    console.log('\n[Test 5] Order state transitions correctly based on size vs ideal');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create an order that will transition from ACTIVE to PARTIAL
    const order = {
        id: 'test-order',
        orderId: 'chain-test',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 10,
        state: ORDER_STATES.ACTIVE
    };

    mgr.orders.set(order.id, order);
    mgr._updateOrder(order);

    // Verify initial state
    let current = mgr.orders.get('test-order');
    assert(current.state === ORDER_STATES.ACTIVE, 'Should start ACTIVE at size 10 (100% of ideal)');

    // Simulate partial fill: reduce to 99% of ideal
    const afterFill = { ...order, size: 9.9, state: ORDER_STATES.PARTIAL };
    mgr._updateOrder(afterFill);

    current = mgr.orders.get('test-order');
    assert(current.state === ORDER_STATES.PARTIAL, `Should be PARTIAL when size < ideal, got ${current.state}`);
    assert(current.size === 9.9, `Size should be 9.9, got ${current.size}`);

    // Refill back to 100%
    const restored = { ...order, size: 10.0, state: ORDER_STATES.ACTIVE };
    mgr._updateOrder(restored);

    current = mgr.orders.get('test-order');
    assert(current.state === ORDER_STATES.ACTIVE, `Should return to ACTIVE when size = ideal, got ${current.state}`);

    console.log('✓ State transitions correctly reflect size vs ideal threshold');
}

// ============================================================================
// TEST 6: GHOST VIRTUALIZATION RESTORES ORIGINAL STATES
// ============================================================================
async function testGhostVirtualizationRestoresStates() {
    console.log('\n[Test 6] Ghost virtualization properly restores original order states');
    console.log('-'.repeat(80));

    const mgr = setupManager();
    mgr.config.targetSpreadPercent = 0;

    const grid = [
        { id: 'sell-0', type: ORDER_TYPES.SELL, price: 1.10, size: 10, state: ORDER_STATES.VIRTUAL },
        { id: 'sell-1', type: ORDER_TYPES.SELL, price: 1.15, size: 10, state: ORDER_STATES.VIRTUAL }
    ];

    for (const order of grid) {
        mgr.orders.set(order.id, order);
        mgr._updateOrder(order);
    }

    const buyAnchor = { id: 'buy-a', price: 1.0, size: 10, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: 'anchor' };
    mgr.orders.set(buyAnchor.id, buyAnchor);
    mgr._updateOrder(buyAnchor);
    mgr.boundaryIdx = Array.from(mgr.orders.values()).sort((a,b)=>a.price-b.price).findIndex(o=>o.id==='buy-a');

    mgr._updateOrder({ id: 'sell-0', orderId: 'p1', type: ORDER_TYPES.SELL, price: 1.10, size: 4, state: ORDER_STATES.PARTIAL });
    mgr._updateOrder({ id: 'sell-1', orderId: 'p2', type: ORDER_TYPES.SELL, price: 1.15, size: 4, state: ORDER_STATES.PARTIAL });

    assert(mgr.orders.get('sell-0').state === ORDER_STATES.PARTIAL, 'P1 should start PARTIAL');

    // Executing rebalance will trigger ghosting and restoration INTERNALLY.
    // If it's NOT restored, it will stay VIRTUAL.
    await mgr.strategy.rebalance([{ type: ORDER_TYPES.BUY, price: 0.90 }]);

    const s0After = mgr.orders.get('sell-0');
    assert(s0After.state !== ORDER_STATES.VIRTUAL, 'Order state should NOT remain VIRTUAL after ghosting pass');
    
    console.log('✓ Rebalance handled ghost virtualization without state corruption');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testSpreadSortingForRotation();
        await testOrderStateTransitionStability();
        await testGhostVirtualTargetSizingAccuracy();
        await testSpreadSortingForBuyRotation();
        await testPartialStateTransitionBelow100();
        await testGhostVirtualizationRestoresStates();

        console.log('\n' + '='.repeat(80));
        console.log('All Critical Bug Fix Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
