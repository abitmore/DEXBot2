const assert = require('assert');
const StrategyEngine = require('../modules/order/strategy');
const Grid = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function buildSlots() {
    const slots = [];
    for (let i = 0; i < 12; i++) {
        const type = i < 5 ? ORDER_TYPES.BUY : (i < 7 ? ORDER_TYPES.SPREAD : ORDER_TYPES.SELL);
        slots.push({
            id: `slot-${i}`,
            price: 100 + i,
            type,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null
        });
    }
    return slots;
}

function createManager(slots) {
    return {
        orders: new Map(slots.map(s => [s.id, { ...s }])),
        config: {
            assetA: 'XRP',
            assetB: 'BTS',
            startPrice: 105,
            incrementPercent: 1,
            targetSpreadPercent: 2,
            activeOrders: { buy: 2, sell: 2 },
            weightDistribution: { buy: 0.5, sell: 0.5 }
        },
        assets: {
            assetA: { id: '1.3.0', precision: 6, symbol: 'XRP' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
        },
        funds: {
            available: { buy: 1000, sell: 1000 },
            virtual: { buy: 0, sell: 0 },
            cacheFunds: { buy: 0, sell: 0 }
        },
        accountTotals: { buyFree: 1000, sellFree: 1000 },
        buySideIsDoubled: false,
        sellSideIsDoubled: false,
        boundaryIdx: undefined,
        logger: {
            level: 'warn',
            log: () => {}
        },
        pauseFundRecalc: () => {},
        resumeFundRecalc: () => {},
        _updateOrder(order) {
            this.orders.set(order.id, { ...order });
        },
        modifyCacheFunds: async () => {}
    };
}

async function run() {
    console.log('Running reaction-cap malformed fill type test...');

    const slots = buildSlots();
    const manager = createManager(slots);
    const strategy = new StrategyEngine(manager);

    const originalGetSizingContext = Grid.getSizingContext;
    Grid.getSizingContext = () => ({ budget: 1000 });

    const capturedCaps = [];
    const originalRebalanceSideRobust = strategy.rebalanceSideRobust.bind(strategy);
    strategy.rebalanceSideRobust = async function(type, allSlots, sideSlots, budget, avail, excludeIds, reactionCap) {
        capturedCaps.push({ type, reactionCap });
        return {
            ordersToPlace: [],
            ordersToRotate: [],
            ordersToUpdate: [],
            ordersToCancel: [],
            stateUpdates: [],
            totalNewPlacementSize: 0
        };
    };

    try {
        await strategy.rebalance([
            { type: ORDER_TYPES.SELL, isPartial: false },
            { type: ORDER_TYPES.BUY, isPartial: false },
            { type: 'MALFORMED', isPartial: false },
            { isPartial: false }
        ], new Set());
    } finally {
        Grid.getSizingContext = originalGetSizingContext;
        strategy.rebalanceSideRobust = originalRebalanceSideRobust;
    }

    assert.strictEqual(capturedCaps.length, 2, 'rebalanceSideRobust should be called for both sides');

    const buyCap = capturedCaps.find(c => c.type === ORDER_TYPES.BUY);
    const sellCap = capturedCaps.find(c => c.type === ORDER_TYPES.SELL);

    assert(buyCap, 'BUY cap should be captured');
    assert(sellCap, 'SELL cap should be captured');
    assert.strictEqual(buyCap.reactionCap, 1, 'BUY reaction cap should only count valid SELL fills');
    assert.strictEqual(sellCap.reactionCap, 1, 'SELL reaction cap should only count valid BUY fills');

    console.log('✓ Reaction cap ignores malformed fill types');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
