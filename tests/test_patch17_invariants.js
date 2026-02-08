const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');
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

async function runTests() {
    console.log('Running Patch17 Invariant Tests...');
    await testExtremePlacementOrdering();
    await testPipelineInFlightDefersMaintenance();
    await testIllegalStateAbortResyncAndCooldown();
    await testRoleAssignmentBlocksOnChainSpreadConversion();
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
