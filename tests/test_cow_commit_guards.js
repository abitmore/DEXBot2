const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function createOrder(id, overrides = {}) {
    return {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1,
        size: 100,
        orderId: '1.7.100',
        ...overrides
    };
}

function buildIndexes(orders) {
    const byState = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set()
    };
    const byType = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    for (const [id, order] of orders.entries()) {
        if (byState[order.state]) byState[order.state].add(id);
        if (byType[order.type]) byType[order.type].add(id);
    }

    return { byState, byType };
}

function createManagerFixture() {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
    const logs = [];
    let recalcCount = 0;

    manager.logger = {
        log: (msg, level) => logs.push({ msg, level })
    };

    manager.recalculateFunds = async () => {
        recalcCount += 1;
    };

    manager._gridVersion = 5;
    manager.boundaryIdx = 0;

    const master = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    manager.orders = Object.freeze(master);

    const { byState, byType } = buildIndexes(master);
    manager._ordersByState = byState;
    manager._ordersByType = byType;

    return {
        manager,
        logs,
        getRecalcCount: () => recalcCount
    };
}

async function testRejectsVersionMismatchWithoutCommit() {
    console.log('\n[COW-COMMIT-001] rejects version mismatch without commit...');

    const { manager, logs, getRecalcCount } = createManagerFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 4 });
    workingGrid.set('slot-1', createOrder('slot-1', { price: 2 }));

    manager._currentWorkingGrid = workingGrid;
    manager._rebalanceState = 'BROADCASTING';

    await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0);

    assert.strictEqual(manager.orders.get('slot-1').price, 1, 'master order must remain unchanged');
    assert.strictEqual(manager._gridVersion, 5, 'grid version must not advance');
    assert.strictEqual(getRecalcCount(), 0, 'fund recalculation must be skipped for rejected commit');
    assert.strictEqual(manager._currentWorkingGrid, null, 'working grid reference should be cleared');
    assert.strictEqual(manager._rebalanceState, 'NORMAL', 'rebalance state should be reset');
    assert(logs.some(l => String(l.msg).includes('base version')), 'should log base version mismatch');
    assert(!logs.some(l => String(l.msg).includes('Grid committed in')), 'must not log successful commit');

    console.log('✓ COW-COMMIT-001 passed');
}

async function testNoPostCommitSideEffectsWhenDeltaEmpty() {
    console.log('\n[COW-COMMIT-002] skips post-commit side effects on empty delta...');

    const { manager, logs, getRecalcCount } = createManagerFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 5 });

    manager._currentWorkingGrid = workingGrid;
    manager._rebalanceState = 'BROADCASTING';

    await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0);

    assert.strictEqual(manager.orders.get('slot-1').price, 1, 'master order must remain unchanged');
    assert.strictEqual(manager._gridVersion, 5, 'grid version must not advance');
    assert.strictEqual(getRecalcCount(), 0, 'fund recalculation must be skipped for empty delta');
    assert.strictEqual(manager._currentWorkingGrid, null, 'working grid reference should be cleared');
    assert.strictEqual(manager._rebalanceState, 'NORMAL', 'rebalance state should be reset');
    assert(logs.some(l => String(l.msg).includes('Delta empty at commit')), 'should log empty delta refusal');
    assert(!logs.some(l => String(l.msg).includes('Grid committed in')), 'must not log successful commit');

    console.log('✓ COW-COMMIT-002 passed');
}

async function run() {
    console.log('Running COW commit guard regression tests...');
    await testRejectsVersionMismatchWithoutCommit();
    await testNoPostCommitSideEffectsWhenDeltaEmpty();
    console.log('\n✓ All COW commit guard regression tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
