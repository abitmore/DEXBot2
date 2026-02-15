const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function run() {
    console.log('Running strategy window budget distribution tests...');

    const manager = new OrderManager({
        assetA: 'XRP',
        assetB: 'USD',
        startPrice: 1,
        incrementPercent: 0.4,
        targetSpreadPercent: 2,
        activeOrders: { buy: 3, sell: 3 },
        weightDistribution: { buy: 0.5, sell: 0.5 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'XRP', precision: 4 },
        assetB: { id: '1.3.2', symbol: 'USD', precision: 5 }
    };

    const frozenMasterGrid = new Map();
    for (let i = 0; i < 40; i++) {
        frozenMasterGrid.set(`slot-${i}`, {
            id: `slot-${i}`,
            price: 0.8 + (i * 0.01),
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null
        });
    }

    const { targetGrid } = manager.strategy.calculateTargetGrid({
        frozenMasterGrid,
        config: manager.config,
        accountAssets: manager.assets,
        funds: {
            allocatedBuy: 6000,
            allocatedSell: 6
        },
        fills: [],
        currentBoundaryIdx: 19,
        buySideIsDoubled: false,
        sellSideIsDoubled: false
    });

    const buyTargets = Array.from(targetGrid.values()).filter(o => o.type === ORDER_TYPES.BUY && Number(o.size || 0) > 0);
    assert.strictEqual(buyTargets.length, 3, 'window discipline should keep 3 buy slots non-zero');

    const maxBuySize = Math.max(...buyTargets.map(o => Number(o.size || 0)));

    // Regression guard: sizing must be based on full side topology, not only 3-window slots.
    // If concentrated into 3 slots, sizes jump near ~2000 for this budget.
    assert(maxBuySize < 1000, `buy size should not be absurdly concentrated (max=${maxBuySize})`);

    console.log('✓ strategy window budget distribution tests passed');
}

run().catch((err) => {
    console.error('✗ strategy window budget distribution tests failed');
    console.error(err);
    process.exit(1);
});
