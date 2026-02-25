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

function createCowExecutionFixture(masterOrders = new Map()) {
    const bot = new DEXBot({
        botKey: 'test_cow_cache_deduction',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });

    const cacheDeductions = [];
    const manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: Object.freeze(masterOrders),
        logger: {
            log: () => {},
            logFundsStatus: () => {}
        },
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => {},
        modifyCacheFunds: async (side, delta, operation) => {
            cacheDeductions.push({ side, delta, operation });
            return delta;
        },
        persistGrid: async () => {},
        _clearWorkingGridRef: () => {}
    };

    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok', violations: [] });
    bot._processBatchResults = async () => ({ executed: true, hadRotation: false, updateOperationCount: 0 });

    return { bot, manager, cacheDeductions };
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
    let clearWorkingGridCalls = 0;
    bot.manager = {
        logger: {
            log: (msg, level) => logs.push({ msg: String(msg), level })
        },
        _clearWorkingGridRef: () => { clearWorkingGridCalls++; }
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
    assert.strictEqual(clearWorkingGridCalls, 1,
        'Empty action guard must call _clearWorkingGridRef to reset REBALANCING state');

    await bot._executeBatchIfNeeded({
        actions: [{ type: COW_ACTIONS.CREATE, id: 'slot-new', order: { id: 'slot-new' } }],
        workingGrid: {}
    }, 'unit-non-empty');
    assert.strictEqual(batchCalls, 1, 'Non-empty action set must execute batch once');
    // _clearWorkingGridRef for non-empty path is handled inside _updateOrdersOnChainBatchCOW
    assert.strictEqual(clearWorkingGridCalls, 1, 'Non-empty path must not double-call _clearWorkingGridRef');

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

async function testNoPostBatchCacheDeductionForCreates() {
    console.log('\n[COW-COMMIT-005] no post-batch cache deduction (handled in real-time by updateOptimisticFreeBalance)...');

    const { bot, manager, cacheDeductions } = createCowExecutionFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });

    const actions = [{
        type: COW_ACTIONS.CREATE,
        id: 'slot-create-buy',
        order: {
            id: 'slot-create-buy',
            type: ORDER_TYPES.BUY,
            price: 1,
            size: 1.23456789,
            state: ORDER_STATES.VIRTUAL,
            orderId: null
        }
    }];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildUpdateOrderOp = async () => ({ op: { op_name: 'limit_order_update', op_data: {} }, finalInts: null });
    chainOrders.buildCreateOrderOp = async () => ({
        op: {
            op_name: 'limit_order_create',
            op_data: {
                amount_to_sell: { amount: 123456, asset_id: manager.assets.assetB.id }
            }
        },
        finalInts: {
            sell: 123456,
            receive: 12345678,
            sellAssetId: manager.assets.assetB.id,
            receiveAssetId: manager.assets.assetA.id
        }
    });

    bot._executeOperationsWithStrategy = async (operations, opContexts) => ({
        result: { success: true, operation_results: [] },
        opContexts
    });

    try {
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
    }

    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    // No cow-placements deductions should occur (would be double-deducting).
    assert.strictEqual(cacheDeductions.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-005 passed');
}

async function testNoPostBatchCacheDeductionForMixedCreates() {
    console.log('\n[COW-COMMIT-006] no post-batch cache deduction for mixed creates...');

    const { bot, manager, cacheDeductions } = createCowExecutionFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });

    const actions = [
        {
            type: COW_ACTIONS.CREATE,
            id: 'slot-create-buy',
            order: {
                id: 'slot-create-buy',
                type: ORDER_TYPES.BUY,
                price: 1,
                size: 1,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        },
        {
            type: COW_ACTIONS.CREATE,
            id: 'slot-create-sell',
            order: {
                id: 'slot-create-sell',
                type: ORDER_TYPES.SELL,
                price: 1,
                size: 2,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        }
    ];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildUpdateOrderOp = async () => ({ op: { op_name: 'limit_order_update', op_data: {} }, finalInts: null });
    chainOrders.buildCreateOrderOp = async (_account, _amountToSell, sellAssetId) => {
        if (sellAssetId === manager.assets.assetB.id) {
            return {
                op: {
                    op_name: 'limit_order_create',
                    op_data: {
                        amount_to_sell: { amount: 100000, asset_id: sellAssetId }
                    }
                },
                finalInts: {
                    sell: 100000,
                    receive: 10000000,
                    sellAssetId,
                    receiveAssetId: manager.assets.assetA.id
                }
            };
        }

        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: 200000000, asset_id: sellAssetId }
                }
            },
            finalInts: {
                sell: 200000000,
                receive: 200000,
                sellAssetId,
                receiveAssetId: manager.assets.assetB.id
            }
        };
    };

    bot._executeOperationsWithStrategy = async (operations, opContexts) => ({
        result: { success: true, operation_results: [] },
        opContexts: opContexts.filter(ctx => ctx?.kind === 'create' && ctx?.order?.type === ORDER_TYPES.SELL)
    });

    try {
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
    }

    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    assert.strictEqual(cacheDeductions.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-006 passed');
}

async function testNoPostBatchCacheDeductionForSizeUpdates() {
    console.log('\n[COW-COMMIT-007] no post-batch cache deduction for size updates...');

    const master = new Map([
        ['slot-update-buy', createOrder('slot-update-buy', {
            type: ORDER_TYPES.BUY,
            size: 1,
            state: ORDER_STATES.ACTIVE,
            orderId: '1.7.700',
            rawOnChain: { for_sale: '100000' }
        })]
    ]);
    const { bot, manager, cacheDeductions } = createCowExecutionFixture(master);
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });

    const actions = [{
        type: COW_ACTIONS.UPDATE,
        id: 'slot-update-buy',
        orderId: '1.7.700',
        newGridId: 'slot-update-buy',
        newSize: 1.000009,
        order: {
            id: 'slot-update-buy',
            type: ORDER_TYPES.BUY,
            price: 1,
            size: 1.000009
        }
    }];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildCreateOrderOp = async () => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: null
    });
    chainOrders.buildUpdateOrderOp = async () => ({
        op: {
            op_name: 'limit_order_update',
            op_data: {
                new_price: {
                    base: { amount: 100001, asset_id: manager.assets.assetB.id },
                    quote: { amount: 10000100, asset_id: manager.assets.assetA.id }
                },
                delta_amount_to_sell: { amount: 1, asset_id: manager.assets.assetB.id }
            }
        },
        finalInts: {
            sell: 100001,
            receive: 10000100,
            sellAssetId: manager.assets.assetB.id,
            receiveAssetId: manager.assets.assetA.id
        }
    });

    bot._executeOperationsWithStrategy = async (operations, opContexts) => ({
        result: { success: true, operation_results: [] },
        opContexts
    });

    try {
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
    }

    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    assert.strictEqual(cacheDeductions.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-007 passed');
}

async function run() {
    console.log('Running COW commit guard regression tests...');
    await testRejectsVersionMismatchWithoutCommit();
    await testNoPostCommitSideEffectsWhenDeltaEmpty();
    await testExecuteBatchIfNeededSkipsEmptyActions();
    await testRejectsCreateOnOccupiedSlotBeforeBroadcast();
    await testNoPostBatchCacheDeductionForCreates();
    await testNoPostBatchCacheDeductionForMixedCreates();
    await testNoPostBatchCacheDeductionForSizeUpdates();
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
