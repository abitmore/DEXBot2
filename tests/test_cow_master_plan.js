/**
 * Copy-on-Write Master Plan Test Suite
 * Tests all critical COW functionality
 */

const assert = require('assert');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ordersEqual, buildDelta } = require('../modules/order/utils/order_comparison');
const { buildIndexes, validateIndexes } = require('../modules/order/utils/grid_indexes');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function createTestOrder(id, type, state, price, amount, orderId = null) {
    return {
        id,
        type,
        state,
        price,
        amount,
        orderId,
        gridIndex: parseInt(id.replace(/\D/g, '')) || 0
    };
}

async function testCOW001_MasterUnchangedOnFailure() {
    console.log('\n[COW-001] Testing master grid unchanged on failure...');
    
    const masterGrid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10, 'chain1')],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20, 'chain2')]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    workingGrid.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 150, 10, 'chain1'));
    
    const masterOrder1 = masterGrid.get('order1');
    assert.strictEqual(masterOrder1.price, 100, 'Master should be unchanged after working copy modification');
    
    workingGrid.delete('order2');
    assert(masterGrid.has('order2'), 'Master should still have order2 after working copy delete');
    
    console.log('✓ COW-001 passed');
}

async function testCOW002_MasterUpdatedOnlyOnSuccess() {
    console.log('\n[COW-002] Testing master update on success only...');
    
    const masterGrid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10, 'chain1')]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    workingGrid.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 150, 10, 'chain1'));
    
    const actions = workingGrid.buildDelta(masterGrid);
    assert.strictEqual(actions.length, 1, 'Should have 1 update action');
    assert.strictEqual(actions[0].type, 'update', 'Action should be update');
    
    const newMasterGrid = workingGrid.toMap();
    assert.strictEqual(newMasterGrid.get('order1').price, 150, 'New grid should have updated price');
    assert.strictEqual(masterGrid.get('order1').price, 100, 'Original master should be unchanged');
    
    console.log('✓ COW-002 passed');
}

async function testCOW003_IndexTransfer() {
    console.log('\n[COW-003] Testing index transfer...');
    
    const masterGrid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10)],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20)],
        ['order3', createTestOrder('order3', ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, 150, 15)]
    ]);

    const masterIndexes = buildIndexes(masterGrid);
    
    const workingGrid = new WorkingGrid(masterGrid);
    workingGrid.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 120, 10));
    workingGrid.set('order4', createTestOrder('order4', ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, 180, 25));
    workingGrid.delete('order2');
    
    const workingIndexes = workingGrid.getIndexes();
    
    assert(workingIndexes[ORDER_TYPES.BUY].has('order1'), 'BUY should contain order1');
    assert(workingIndexes[ORDER_TYPES.BUY].has('order3'), 'BUY should contain order3');
    assert(workingIndexes[ORDER_TYPES.BUY].has('order4'), 'BUY should contain order4 (new)');
    assert(!workingIndexes[ORDER_TYPES.SELL].has('order2'), 'SELL should not contain order2 (deleted)');
    assert(workingIndexes[ORDER_STATES.ACTIVE].has('order1'), 'ACTIVE should contain order1');
    assert(workingIndexes[ORDER_STATES.VIRTUAL].has('order3'), 'VIRTUAL should contain order3');
    assert(workingIndexes[ORDER_STATES.VIRTUAL].has('order4'), 'VIRTUAL should contain order4');
    
    console.log('✓ COW-003 passed');
}

async function testCOW004_FundRecalculation() {
    console.log('\n[COW-004] Testing fund calculation from grid...');
    
    const workingGrid = new WorkingGrid(new Map());
    
    workingGrid.set('buy1', createTestOrder('buy1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10));
    workingGrid.set('buy2', createTestOrder('buy2', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 90, 20));
    workingGrid.set('sell1', createTestOrder('sell1', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 15));
    workingGrid.set('sell2', createTestOrder('sell2', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 210, 25));
    
    let buyRequired = 0;
    let sellRequired = 0;
    
    for (const order of workingGrid.values()) {
        if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.VIRTUAL) {
            if (order.type === ORDER_TYPES.BUY) {
                buyRequired += order.price * order.amount;
            } else if (order.type === ORDER_TYPES.SELL) {
                sellRequired += order.amount;
            }
        }
    }
    
    assert.strictEqual(buyRequired, 2800, 'Buy required should be 100*10 + 90*20 = 2800');
    assert.strictEqual(sellRequired, 40, 'Sell required should be 15 + 25 = 40');
    
    console.log('✓ COW-004 passed');
}

async function testCOW005_OrderComparison() {
    console.log('\n[COW-005] Testing order comparison...');
    
    const order1 = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100.000001, 10, 'chain1');
    const order2 = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100.000002, 10, 'chain1');
    
    assert.strictEqual(ordersEqual(order1, order2), true, 'Should be equal within epsilon');
    
    const order3 = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100.1, 10, 'chain1');
    assert.strictEqual(ordersEqual(order1, order3), false, 'Should not be equal with large price diff');
    
    const order4 = createTestOrder('1', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 100, 10, 'chain1');
    assert.strictEqual(ordersEqual(order1, order4), false, 'Should not be equal with different type');
    
    console.log('✓ COW-005 passed');
}

async function testCOW006_DeltaBuilding() {
    console.log('\n[COW-006] Testing delta building...');
    
    const master = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10, 'chain1')],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20, 'chain2')]
    ]);

    const working = new WorkingGrid(master);
    
    working.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 150, 10, 'chain1'));
    working.set('order3', createTestOrder('order3', ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, 120, 15));
    working.delete('order2');
    
    const actions = buildDelta(master, working);
    
    assert.strictEqual(actions.length, 3, 'Should have 3 actions');
    assert.strictEqual(actions.filter(a => a.type === 'update').length, 1, 'Should have 1 update');
    assert.strictEqual(actions.filter(a => a.type === 'create').length, 1, 'Should have 1 create');
    assert.strictEqual(actions.filter(a => a.type === 'cancel').length, 1, 'Should have 1 cancel');
    
    const updateAction = actions.find(a => a.type === 'update');
    assert.strictEqual(updateAction.order.price, 150, 'Update should have new price');
    
    console.log('✓ COW-006 passed');
}

async function testCOW007_IndexValidation() {
    console.log('\n[COW-007] Testing index validation...');
    
    const grid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10)],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20)]
    ]);

    const indexes = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(['order1', 'order2']),
        [ORDER_STATES.PARTIAL]: new Set(),
        [ORDER_TYPES.BUY]: new Set(['order1']),
        [ORDER_TYPES.SELL]: new Set(['order2']),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    const validation = validateIndexes(grid, indexes);
    assert(validation.valid, 'Indexes should be valid');
    
    const badIndexes = {
        ...indexes,
        [ORDER_STATES.ACTIVE]: new Set(['order1', 'order3'])
    };
    
    const badValidation = validateIndexes(grid, badIndexes);
    assert(!badValidation.valid, 'Indexes should be invalid');
    assert(badValidation.errors.length > 0, 'Should have errors');
    
    console.log('✓ COW-007 passed');
}

async function testCOW008_WorkingGridIndependence() {
    console.log('\n[COW-008] Testing working grid independence...');
    
    const original = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10)]
    ]);

    const wg1 = new WorkingGrid(original);
    const wg2 = new WorkingGrid(original);
    
    wg1.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 200, 10));
    wg2.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 300, 10));
    
    assert.strictEqual(wg1.get('order1').price, 200, 'WG1 should have price 200');
    assert.strictEqual(wg2.get('order1').price, 300, 'WG2 should have price 300');
    assert.strictEqual(original.get('order1').price, 100, 'Original should be unchanged');
    
    console.log('✓ COW-008 passed');
}

async function testCOW009_EmptyGridHandling() {
    console.log('\n[COW-009] Testing empty grid handling...');
    
    const emptyMaster = new Map();
    const working = new WorkingGrid(emptyMaster);
    
    assert.strictEqual(working.size, 0, 'Working grid should be empty');
    assert(!working.isModified(), 'Should not be modified initially');
    
    const actions = working.buildDelta(emptyMaster);
    assert.strictEqual(actions.length, 0, 'Should have no actions');
    
    console.log('✓ COW-009 passed');
}

async function testCOW010_MemoryStats() {
    console.log('\n[COW-010] Testing memory stats...');
    
    const grid = new Map();
    for (let i = 0; i < 100; i++) {
        grid.set(`order${i}`, createTestOrder(`order${i}`, ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100 + i, 10));
    }

    const working = new WorkingGrid(grid);
    const stats = working.getMemoryStats();
    
    assert.strictEqual(stats.size, 100, 'Size should be 100');
    assert(stats.estimatedBytes > 0, 'Estimated bytes should be positive');
    
    working.set('order0', createTestOrder('order0', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 999, 10));
    const modifiedStats = working.getMemoryStats();
    assert(modifiedStats.modified > 0, 'Modified count should be positive');
    
    console.log('✓ COW-010 passed');
}

async function testCOW011_NoSpuriousUpdatesOnUnchangedGrid() {
    console.log('\n[COW-011] Testing unchanged grid emits no updates...');

    const master = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 1.2345,
            size: 10,
            orderId: '1.7.100',
            gridIndex: 1
        }],
        ['slot-2', {
            id: 'slot-2',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1.3456,
            size: 20,
            orderId: '1.7.101',
            gridIndex: 2
        }]
    ]);

    const working = new WorkingGrid(master);
    const actions = buildDelta(master, working);

    assert.strictEqual(actions.length, 0, 'Unchanged working grid must produce zero actions');
    assert.strictEqual(actions.filter(a => a.type === 'update').length, 0, 'Unchanged working grid must produce zero updates');

    console.log('✓ COW-011 passed');
}

async function runAllTests() {
    console.log('=== Copy-on-Write Master Plan Test Suite ===\n');
    
    await testCOW001_MasterUnchangedOnFailure();
    await testCOW002_MasterUpdatedOnlyOnSuccess();
    await testCOW003_IndexTransfer();
    await testCOW004_FundRecalculation();
    await testCOW005_OrderComparison();
    await testCOW006_DeltaBuilding();
    await testCOW007_IndexValidation();
    await testCOW008_WorkingGridIndependence();
    await testCOW009_EmptyGridHandling();
    await testCOW010_MemoryStats();
    await testCOW011_NoSpuriousUpdatesOnUnchangedGrid();
    
    console.log('\n=== All COW tests passed! ===');
}

runAllTests().catch(console.error);
