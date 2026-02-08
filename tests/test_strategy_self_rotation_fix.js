const assert = require('assert');
const StrategyEngine = require('../modules/order/strategy');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function createManager(slots) {
    return {
        orders: new Map(slots.map(s => [s.id, { ...s }])),
        config: {
            incrementPercent: 1,
            activeOrders: { buy: 2, sell: 2 },
            weightDistribution: { buy: 0.5, sell: 0.5 }
        },
        assets: {
            assetA: { precision: 6 },
            assetB: { precision: 6 }
        },
        buySideIsDoubled: false,
        sellSideIsDoubled: false,
        logger: {
            level: 'warn',
            log: () => {}
        }
    };
}

async function run() {
    console.log('Running self-rotation prevention test...');

    const allSlots = [
        { id: 's0', price: 1.0, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 100, orderId: 'o0' },
        { id: 's1', price: 1.1, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 0.000001, orderId: 'o1' },
        { id: 's2', price: 1.2, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 90, orderId: 'o2' }
    ];

    const manager = createManager(allSlots);
    const strategy = new StrategyEngine(manager);

    const result = await strategy.rebalanceSideRobust(
        ORDER_TYPES.BUY,
        allSlots,
        allSlots,
        1000,
        1000,
        new Set(),
        5
    );

    const rotation = result.ordersToRotate.find(r => r.oldOrder?.id === 's0' && r.newGridId === 's1');
    assert(rotation, 'Edge-First: Should rotate s0 (furthest) to s1 (shortage)');

    const canceledS1 = result.ordersToCancel.some(o => o.id === 's1');
    assert.strictEqual(canceledS1, true, 'Inner surplus s1 should be canceled after edge s0 consumed the shortage');

    console.log('✓ Edge surplus used for rotation, inner surplus canceled (Edge-First)');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
