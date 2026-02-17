const assert = require('assert');

const DEXBot = require('../modules/dexbot_class');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

async function testLegacyProjectionIntoWorkingGrid() {
    const bot = new DEXBot({
        botKey: 'test_legacy_cow_projection',
        dryRun: true,
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 1300,
        incrementPercent: 0.4
    });

    bot.manager = {
        _gridVersion: 9,
        boundaryIdx: 100,
        orders: new Map([
            ['slot-101', { id: 'slot-101', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 1310.85, size: 0, orderId: null }],
            ['slot-200', { id: 'slot-200', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, price: 1290, size: 1.2, orderId: '1.7.200' }],
            ['slot-300', { id: 'slot-300', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1326, size: 0.06, orderId: '1.7.300' }]
        ])
    };

    let captured = null;
    bot._updateOrdersOnChainBatchCOW = async (cowResult) => {
        captured = cowResult;
        return { executed: true, hadRotation: true };
    };

    await bot.updateOrdersOnChainPlan({
        ordersToPlace: [
            { id: 'slot-101', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1310.85, size: 0.0607 }
        ],
        ordersToUpdate: [
            {
                partialOrder: {
                    id: 'slot-200',
                    orderId: '1.7.200',
                    type: ORDER_TYPES.BUY,
                    state: ORDER_STATES.PARTIAL,
                    price: 1290,
                    size: 1.2
                },
                newSize: 1.5
            }
        ],
        ordersToCancel: [
            { id: 'slot-300', orderId: '1.7.300' }
        ]
    });

    assert(captured, 'legacy path should forward normalized COW result');
    assert.strictEqual(captured.workingGrid.baseVersion, 9, 'working grid should preserve manager grid version');

    const projectedCreate = captured.workingGrid.get('slot-101');
    assert.strictEqual(projectedCreate.type, ORDER_TYPES.SELL, 'create projection should assign target side');
    assert.strictEqual(projectedCreate.size, 0.0607, 'create projection should preserve target size');
    assert.strictEqual(projectedCreate.state, ORDER_STATES.VIRTUAL, 'create projection should remain virtual before sync');
    assert.strictEqual(projectedCreate.orderId, null, 'create projection should clear orderId before placement');

    const projectedUpdate = captured.workingGrid.get('slot-200');
    assert.strictEqual(projectedUpdate.size, 1.5, 'update projection should apply new size');
    assert.strictEqual(projectedUpdate.orderId, '1.7.200', 'update projection should preserve orderId');

    const projectedCancel = captured.workingGrid.get('slot-300');
    assert.strictEqual(projectedCancel.type, ORDER_TYPES.SPREAD, 'cancel projection should virtualize to spread slot');
    assert.strictEqual(projectedCancel.state, ORDER_STATES.VIRTUAL, 'cancel projection should set virtual state');

    const updateAction = captured.actions.find(a => a.type === COW_ACTIONS.UPDATE);
    assert(updateAction, 'legacy update should normalize into COW update action');
    assert.strictEqual(updateAction.id, 'slot-200', 'normalized update action should use partialOrder.id');
    assert.strictEqual(updateAction.orderId, '1.7.200', 'normalized update action should use partialOrder.orderId');
}

async function run() {
    console.log('Running legacy COW projection tests...');
    await testLegacyProjectionIntoWorkingGrid();
    console.log('✓ Legacy COW projection tests passed');
}

run().catch((err) => {
    console.error('✗ Legacy COW projection tests failed');
    console.error(err);
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
