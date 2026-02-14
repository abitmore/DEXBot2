/**
 * Test working grid clone behavior
 */

const assert = require('assert');
const { WorkingGrid } = require('../modules/order/working_grid');

function testCloneIndependence() {
    const master = new Map([
        ['order1', { id: 'order1', price: 100, amount: 10, type: 'BUY', state: 'ACTIVE', gridIndex: 0 }],
        ['order2', { id: 'order2', price: 200, amount: 20, type: 'SELL', state: 'ACTIVE', gridIndex: 1 }]
    ]);

    const working = new WorkingGrid(master);
    
    working.set('order1', { id: 'order1', price: 150, amount: 10, type: 'BUY', state: 'ACTIVE', gridIndex: 0 });
    
    const masterOrder = master.get('order1');
    assert.strictEqual(masterOrder.price, 100, 'Master should be unchanged');
    
    const workingOrder = working.get('order1');
    assert.strictEqual(workingOrder.price, 150, 'Working should have new value');
    
    console.log('✓ Clone independence test passed');
}

function testDeltaBuilding() {
    const master = new Map([
        ['order1', { id: 'order1', type: 'BUY', state: 'ACTIVE', price: 100, amount: 10, orderId: 'chain1', gridIndex: 0 }],
        ['order2', { id: 'order2', type: 'SELL', state: 'ACTIVE', price: 200, amount: 20, orderId: 'chain2', gridIndex: 1 }]
    ]);

    const working = new WorkingGrid(master);
    
    working.set('order1', { id: 'order1', type: 'BUY', state: 'ACTIVE', price: 150, amount: 10, orderId: 'chain1', gridIndex: 0 });
    working.set('order3', { id: 'order3', type: 'BUY', state: 'VIRTUAL', price: 120, amount: 15, orderId: null, gridIndex: 2 });
    working.delete('order2');
    
    const actions = working.buildDelta(master);
    
    assert.strictEqual(actions.length, 3, 'Should have 3 actions');
    assert.strictEqual(actions.filter(a => a.type === 'update').length, 1, 'Should have 1 update');
    assert.strictEqual(actions.filter(a => a.type === 'create').length, 1, 'Should have 1 create');
    assert.strictEqual(actions.filter(a => a.type === 'cancel').length, 1, 'Should have 1 cancel');
    
    console.log('✓ Delta building test passed');
}

function testOrderComparison() {
    const { ordersEqual } = require('../modules/order/utils/order_comparison');
    
    const order1 = { id: '1', price: 100.00000001, amount: 10, type: 'BUY', state: 'ACTIVE', orderId: 'chain1', gridIndex: 0 };
    const order2 = { id: '1', price: 100.00000002, amount: 10, type: 'BUY', state: 'ACTIVE', orderId: 'chain1', gridIndex: 0 };
    
    assert.strictEqual(ordersEqual(order1, order2), true, 'Should be equal within epsilon');
    
    const order3 = { id: '1', price: 100.1, amount: 10, type: 'BUY', state: 'ACTIVE', orderId: 'chain1', gridIndex: 0 };
    assert.strictEqual(ordersEqual(order1, order3), false, 'Should not be equal');
    
    console.log('✓ Order comparison test passed');
}

function testIndexes() {
    const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
    
    const master = new Map([
        ['order1', { id: 'order1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 100, amount: 10 }],
        ['order2', { id: 'order2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 200, amount: 20 }],
        ['order3', { id: 'order3', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 150, amount: 15 }]
    ]);

    const working = new WorkingGrid(master);
    const indexes = working.getIndexes();
    
    assert(indexes[ORDER_TYPES.BUY].has('order1'), 'BUY should contain order1');
    assert(indexes[ORDER_TYPES.BUY].has('order3'), 'BUY should contain order3');
    assert(indexes[ORDER_TYPES.SELL].has('order2'), 'SELL should contain order2');
    assert(indexes[ORDER_STATES.ACTIVE].has('order1'), 'ACTIVE should contain order1');
    assert(indexes[ORDER_STATES.ACTIVE].has('order2'), 'ACTIVE should contain order2');
    assert(indexes[ORDER_STATES.VIRTUAL].has('order3'), 'VIRTUAL should contain order3');
    
    console.log('✓ Index building test passed');
}

testCloneIndependence();
testDeltaBuilding();
testOrderComparison();
testIndexes();
console.log('\nAll WorkingGrid tests passed!');
