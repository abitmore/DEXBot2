const assert = require('assert');

const DEXBot = require('../modules/dexbot_class');
const chainOrders = require('../modules/chain_orders');
const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

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

async function testExecuteBatchIfNeededSkipsEmptyActions() {
    console.log('\n[COW-COMMIT-003] central empty-action guard skips broadcast...');

    const bot = new DEXBot({
        botKey: 'test_cow_commit_guard_empty_actions',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    const logs = [];
    bot.manager = {
        logger: {
            log: (msg, level) => logs.push({ msg: String(msg), level })
        }
    };

    let batchCalls = 0;
    bot.updateOrdersOnChainBatch = async () => {
        batchCalls += 1;
        return { executed: true, hadRotation: false };
    };

    const emptyResult = await bot._executeBatchIfNeeded({ actions: [] }, 'unit-empty');
    assert.strictEqual(batchCalls, 0, 'Empty action set must not call updateOrdersOnChainBatch');
    assert.strictEqual(emptyResult.skippedNoActions, true, 'Empty action set should return skipped marker');
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('No actions needed for unit-empty')),
        'Empty action guard should emit debug log');

    await bot._executeBatchIfNeeded({
        actions: [{ type: COW_ACTIONS.CREATE, id: 'slot-new', order: { id: 'slot-new' } }],
        workingGrid: {}
    }, 'unit-non-empty');
    assert.strictEqual(batchCalls, 1, 'Non-empty action set must execute batch once');

    console.log('✓ COW-COMMIT-003 passed');
}

async function testRejectsCreateOnOccupiedSlotBeforeBroadcast() {
    console.log('\n[COW-COMMIT-004] rejects create on occupied slot pre-broadcast...');

    const { manager } = createManagerFixture();
    manager.assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
    };

    const bot = new DEXBot({
        botKey: 'test_cow_commit_guard_occupied_slot',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = manager;
    bot.account = { id: '1.2.999' };
    bot.privateKey = 'TEST_PRIVATE_KEY';

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    const cowResult = {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: manager.boundaryIdx,
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: 'slot-1',
            order: {
                id: 'slot-1',
                type: ORDER_TYPES.SELL,
                price: 1.1,
                size: 10,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        }]
    };

    const originalExecuteBatch = chainOrders.executeBatch;
    let executeBatchCalls = 0;
    chainOrders.executeBatch = async () => {
        executeBatchCalls += 1;
        return { success: true, operation_results: [] };
    };

    try {
        const result = await bot.updateOrdersOnChainBatch(cowResult);
        assert.strictEqual(result.executed, false, 'Occupied-slot create batch must not execute');
        assert.strictEqual(result.aborted, true, 'Occupied-slot create batch should abort early');
        assert.strictEqual(result.reason, 'CREATE_SLOT_OCCUPIED', 'Abort reason should indicate occupied slot');
        assert.strictEqual(executeBatchCalls, 0, 'Pre-broadcast guard must block blockchain executeBatch call');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-004 passed');
}

async function run() {
    console.log('Running COW commit guard regression tests...');
    await testRejectsVersionMismatchWithoutCommit();
    await testNoPostCommitSideEffectsWhenDeltaEmpty();
    await testExecuteBatchIfNeededSkipsEmptyActions();
    await testRejectsCreateOnOccupiedSlotBeforeBroadcast();
    console.log('\n✓ All COW commit guard regression tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
}).finally(() => {
    try {
        const bsModule = require('../modules/bitshares_client');
        const BitShares = bsModule?.BitShares;
        if (BitShares?.ws?.isConnected && typeof BitShares.disconnect === 'function') {
            BitShares.disconnect();
        }
    } catch (_) {
        // noop
    }
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
