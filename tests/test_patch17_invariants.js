const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');
const Grid = require('../modules/order/grid');
const chainOrders = require('../modules/chain_orders');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const bsModule = require('../modules/bitshares_client');

if (typeof bsModule.setSuppressConnectionLog === 'function') {
    bsModule.setSuppressConnectionLog(true);
}

function createManager() {
    const mgr = new OrderManager({
        market: 'TEST/BTS',
        assetA: 'TEST',
        assetB: 'BTS',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        activeOrders: { buy: 4, sell: 4 },
        weightDistribution: { sell: 0.5, buy: 0.5 }
    });
    mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 10000, sell: 1000, buyFree: 10000, sellFree: 1000 });
    mgr.resetFunds();
    return mgr;
}

function createBatchManagerStub(overrides = {}) {
    return {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
        },
        lockOrders: () => {},
        unlockOrders: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: () => {},
        consumeIllegalStateSignal: () => null,
        consumeAccountingFailureSignal: () => null,
        orders: new Map(),
        _updateOrder: () => {},
        _throwOnIllegalState: false,
        logger: {
            log: () => {},
            logFundsStatus: () => {}
        },
        ...overrides
    };
}

async function testExtremePlacementOrdering() {
    const mgr = createManager();

    const allSlots = [
        { id: 'b0', price: 99, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b1', price: 98, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b2', price: 97, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b3', price: 96, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's0', price: 101, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's1', price: 102, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's2', price: 103, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's3', price: 104, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 }
    ];

    mgr.pauseFundRecalc();
    allSlots.forEach(slot => mgr._updateOrder(slot, 'seed', true, 0));
    mgr.resumeFundRecalc();

    const buySlots = allSlots.filter(s => s.type === ORDER_TYPES.BUY);
    const sellSlots = allSlots.filter(s => s.type === ORDER_TYPES.SELL);

    const buyResult = await mgr.strategy.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, 9000, 9000, new Set(), 4);
    const sellResult = await mgr.strategy.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, 900, 900, new Set(), 4);

    assert.deepStrictEqual(
        buyResult.ordersToPlace.map(o => o.id),
        ['b0', 'b1', 'b2', 'b3'],
        'BUY placements must use nearest available free slots first'
    );
    assert.deepStrictEqual(
        sellResult.ordersToPlace.map(o => o.id),
        ['s0', 's1', 's2', 's3'],
        'SELL placements must use nearest available free slots first'
    );
}

async function testPipelineInFlightDefersMaintenance() {
    const bot = new DEXBot({
        botKey: 'test_patch17_invariants_pipeline',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let spreadChecks = 0;
    let healthChecks = 0;
    let capturedSignals = null;

    bot._incomingFillQueue.push({ id: 'fill-1' });
    bot._batchInFlight = true;
    bot._batchRetryInFlight = true;
    bot._recoverySyncInFlight = true;

    bot.manager = {
        recalculateFunds: () => {},
        clearStalePipelineOperations: () => {},
        isPipelineEmpty: (signals) => {
            capturedSignals = signals;
            return { isEmpty: false, reasons: ['in-flight test'] };
        },
        checkSpreadCondition: async () => {
            spreadChecks++;
            return { ordersPlaced: 0 };
        },
        checkGridHealth: async () => {
            healthChecks++;
            return { buyDust: false, sellDust: false };
        },
        _isBroadcasting: true,
        shadowOrderIds: new Set(['lock-1']),
        logger: { log: () => {} }
    };

    await bot._executeMaintenanceLogic('invariant-pipeline');

    assert(capturedSignals, 'Pipeline signals should be passed to isPipelineEmpty');
    assert.strictEqual(capturedSignals.batchInFlight, true, 'batchInFlight signal should be true');
    assert.strictEqual(capturedSignals.retryInFlight, true, 'retryInFlight signal should be true');
    assert.strictEqual(capturedSignals.recoveryInFlight, true, 'recoveryInFlight signal should be true');
    assert.strictEqual(capturedSignals.broadcasting, true, 'broadcasting signal should be true');
    assert.strictEqual(spreadChecks, 0, 'Spread maintenance must be deferred when pipeline is in-flight');
    assert.strictEqual(healthChecks, 0, 'Health maintenance must be deferred when pipeline is in-flight');
}

async function testIllegalStateAbortResyncAndCooldown() {
    const bot = new DEXBot({
        botKey: 'test_patch17_invariants_abort',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let spreadChecks = 0;
    let healthChecks = 0;
    let persistCalls = 0;
    let recoverySyncCalls = 0;
    let consumeCount = 0;

    bot._triggerStateRecoverySync = async () => {
        recoverySyncCalls++;
    };
    bot._persistAndRecoverIfNeeded = async () => {
        persistCalls++;
    };

    bot.manager = {
        recalculateFunds: () => {},
        clearStalePipelineOperations: () => {},
        isPipelineEmpty: () => ({ isEmpty: true, reasons: [] }),
        checkSpreadCondition: async () => {
            spreadChecks++;
            return { ordersPlaced: 1 };
        },
        checkGridHealth: async () => {
            healthChecks++;
            return { buyDust: false, sellDust: false };
        },
        consumeIllegalStateSignal: () => {
            consumeCount++;
            if (consumeCount === 1) {
                return { id: 'slot-x', context: 'fill-place', message: 'simulated illegal spread on-chain' };
            }
            return null;
        },
        logger: { log: () => {} }
    };

    await bot._executeMaintenanceLogic('invariant-abort-1');

    assert.strictEqual(recoverySyncCalls, 1, 'Illegal state should trigger immediate recovery sync');
    assert.strictEqual(persistCalls, 0, 'Illegal state abort should skip persistence in same cycle');
    assert.strictEqual(healthChecks, 0, 'Illegal state abort should skip further maintenance in same cycle');
    assert.strictEqual(bot._maintenanceCooldownCycles, 1, 'Hard-abort should arm one maintenance cooldown cycle');

    await bot._executeMaintenanceLogic('invariant-abort-2');
    assert.strictEqual(spreadChecks, 1, 'Cooldown cycle should skip spread check once after hard-abort');
}

async function testRoleAssignmentBlocksOnChainSpreadConversion() {
    const mgr = createManager();
    mgr.logger.level = 'error';

    const slots = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, price: 98, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.1' },
        { id: 'buy-1', type: ORDER_TYPES.BUY, price: 99, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.2' },
        { id: 'mid-active', type: ORDER_TYPES.BUY, price: 100, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.3' },
        { id: 'sell-0', type: ORDER_TYPES.SELL, price: 101, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.4' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, price: 102, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.5' }
    ];

    slots.forEach(slot => mgr._updateOrder(slot, 'seed', true, 0));
    mgr.config.startPrice = 99;
    mgr.boundaryIdx = 1;

    await mgr.strategy.rebalance([]);

    const midOrder = mgr.orders.get('mid-active');
    assert(midOrder, 'Mid slot should still exist');
    assert.notStrictEqual(midOrder.type, ORDER_TYPES.SPREAD, 'On-chain mid slot must not be converted to SPREAD');
    assert(
        (mgr._metrics?.spreadRoleConversionBlocked || 0) > 0,
        'Blocked SPREAD conversion metric should increment for on-chain slot'
    );
}

async function testGridResizeCacheTracksAppliedSizesAfterCap() {
    const mgr = createManager();
    mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1, sellFree: 1000 });
    mgr.resetFunds();

    const slots = [
        { id: 'b0', type: ORDER_TYPES.BUY, price: 99, state: ORDER_STATES.ACTIVE, orderId: '1.7.1', size: 0.5 },
        { id: 'b1', type: ORDER_TYPES.BUY, price: 98, state: ORDER_STATES.ACTIVE, orderId: '1.7.2', size: 0.5 },
        { id: 'b2', type: ORDER_TYPES.BUY, price: 97, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b3', type: ORDER_TYPES.BUY, price: 96, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's0', type: ORDER_TYPES.SELL, price: 101, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's1', type: ORDER_TYPES.SELL, price: 102, state: ORDER_STATES.VIRTUAL, size: 0 }
    ];

    mgr.pauseFundRecalc();
    slots.forEach(slot => mgr._updateOrder(slot, 'seed', true, 0));
    mgr.resumeFundRecalc();

    await Grid._recalculateGridOrderSizesFromBlockchain(mgr, ORDER_TYPES.BUY);

    const buyOrders = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);
    const allocatedBuy = buyOrders.reduce((sum, o) => sum + Number(o.size || 0), 0);
    const buyCtx = Grid._getSizingContext(mgr, 'buy');
    const expectedCache = Math.max(0, Number(buyCtx?.budget || 0) - allocatedBuy);
    const actualCache = Number(mgr.funds?.cacheFunds?.buy || 0);

    assert(
        Math.abs(actualCache - expectedCache) < 1e-5,
        `BUY cache remainder should match post-cap allocated sizes (expected ${expectedCache}, got ${actualCache})`
    );
}

async function testIllegalBatchAbortArmsMaintenanceCooldown() {
    const bot = new DEXBot({
        botKey: 'test_patch17_batch_abort_cooldown',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let recoverySyncCalls = 0;
    bot._triggerStateRecoverySync = async () => {
        recoverySyncCalls++;
    };

    bot.manager = createBatchManagerStub({
        consumeIllegalStateSignal: () => ({ message: 'simulated illegal state from test' })
    });

    bot._buildCancelOps = async () => {};
    bot._buildCreateOps = async (_ordersToPlace, _assetA, _assetB, operations, opContexts) => {
        operations.push({ op_data: { amount_to_sell: { asset_id: '1.3.1', amount: 1 }, min_to_receive: { asset_id: '1.3.0', amount: 1 } } });
        opContexts.push({ kind: 'create', order: { id: 'slot-new' } });
    };
    bot._buildSizeUpdateOps = async () => {};
    bot._buildRotationOps = async () => [];
    bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok' });

    const originalExecuteBatch = chainOrders.executeBatch;
    try {
        chainOrders.executeBatch = async () => {
            const err = new Error('simulated illegal state');
            err.code = 'ILLEGAL_ORDER_STATE';
            throw err;
        };

        const result = await bot.updateOrdersOnChainBatch({
            ordersToPlace: [{ id: 'slot-new', type: ORDER_TYPES.BUY, size: 1, price: 99 }],
            ordersToRotate: [],
            ordersToUpdate: [],
            ordersToCancel: []
        });

        assert.strictEqual(result?.abortedForIllegalState, true, 'Batch should abort with ILLEGAL_ORDER_STATE signal');
        assert.strictEqual(recoverySyncCalls, 1, 'Illegal-state abort should trigger one immediate recovery sync');
        assert.strictEqual(bot._maintenanceCooldownCycles, 1, 'Illegal-state batch abort must arm maintenance cooldown');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
    }
}

async function testSingleStaleCancelBatchUsesStaleOnlyFastPath() {
    const bot = new DEXBot({
        botKey: 'test_patch17_single_stale_cancel',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let staleCleanupUpdates = 0;
    let recoverySyncCalls = 0;
    bot._triggerStateRecoverySync = async () => {
        recoverySyncCalls++;
    };

    bot.manager = createBatchManagerStub({
        orders: new Map([
            ['slot-stale', {
                id: 'slot-stale',
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                size: 1,
                price: 99,
                orderId: '1.7.999'
            }]
        ]),
        _updateOrder: () => {
            staleCleanupUpdates++;
        }
    });

    bot._buildCancelOps = async (_ordersToCancel, operations, opContexts) => {
        operations.push({ op_data: { order: '1.7.999' } });
        opContexts.push({ kind: 'cancel', order: { id: 'slot-stale', orderId: '1.7.999' } });
    };
    bot._buildCreateOps = async () => {};
    bot._buildSizeUpdateOps = async () => {};
    bot._buildRotationOps = async () => [];
    bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok' });

    const originalExecuteBatch = chainOrders.executeBatch;
    try {
        chainOrders.executeBatch = async () => {
            throw new Error('Limit order 1.7.999 does not exist');
        };

        const result = await bot.updateOrdersOnChainBatch({
            ordersToPlace: [],
            ordersToRotate: [],
            ordersToUpdate: [],
            ordersToCancel: []
        });

        assert.strictEqual(result?.staleOnly, true, 'Single stale cancel batch should exit via stale-only fast path');
        assert.strictEqual(recoverySyncCalls, 0, 'Stale-only cancel race should not trigger recovery sync');
        assert.strictEqual(staleCleanupUpdates > 0, true, 'Stale grid reference should still be cleaned up');
        assert.strictEqual(bot._staleCleanedOrderIds.has('1.7.999'), true, 'Stale order id should be tracked to avoid double-credit');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
    }
}

async function runTests() {
    console.log('Running Patch17 Invariant Tests...');
    await testExtremePlacementOrdering();
    await testPipelineInFlightDefersMaintenance();
    await testIllegalStateAbortResyncAndCooldown();
    await testRoleAssignmentBlocksOnChainSpreadConversion();
    await testGridResizeCacheTracksAppliedSizesAfterCap();
    await testIllegalBatchAbortArmsMaintenanceCooldown();
    await testSingleStaleCancelBatchUsesStaleOnlyFastPath();
    console.log('✓ Patch17 invariant tests passed!');
}

runTests().catch(err => {
    console.error('✗ Patch17 invariant tests failed');
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    const BitShares = bsModule.BitShares;
    if (BitShares?.ws?.isConnected && typeof BitShares.disconnect === 'function') {
        try { BitShares.disconnect(); } catch (_) { }
    }
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
