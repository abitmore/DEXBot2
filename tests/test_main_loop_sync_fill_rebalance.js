const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');
const chainOrders = require('../modules/chain_orders');

class MockAsyncLock {
    constructor() {
        this.locked = false;
    }

    async acquire(fn) {
        this.locked = true;
        try {
            return await fn();
        } finally {
            this.locked = false;
        }
    }

    isLocked() {
        return this.locked;
    }

    getQueueLength() {
        return 0;
    }
}

async function runTests() {
    console.log('Running Main Loop Sync Fill Rebalance Test...');

    const originalLoopMs = process.env.OPEN_ORDERS_SYNC_LOOP_MS;
    const originalReadOpenOrders = chainOrders.readOpenOrders;

    process.env.OPEN_ORDERS_SYNC_LOOP_MS = '20';

    try {
        let syncCalls = 0;
        let processCalls = 0;
        let batchCalls = 0;
        let persistCalls = 0;

        const bot = new DEXBot({
            botKey: 'test_main_loop_sync_fill_rebalance',
            dryRun: false,
            startPrice: 1,
            assetA: 'XRP',
            assetB: 'BTS',
            incrementPercent: 0.5
        });

        const syntheticFilledOrder = {
            id: 'slot-174',
            orderId: '1.7.999999',
            type: 'sell',
            state: 'partial',
            size: 0.0001,
            price: 1357.58,
            isPartial: false
        };

        bot.accountId = '1.2.999';
        bot.manager = {
            _fillProcessingLock: new MockAsyncLock(),
            synchronizeWithChain: async () => {
                syncCalls++;
                if (syncCalls === 1) {
                    return { filledOrders: [syntheticFilledOrder] };
                }
                return { filledOrders: [] };
            },
            processFilledOrders: async (filledOrders) => {
                processCalls++;
                assert.strictEqual(filledOrders.length, 1, 'Expected one sync-detected filled order');
                assert.strictEqual(filledOrders[0].orderId, '1.7.999999', 'Expected detected order to flow into strategy');
                return {
                    ordersToPlace: [],
                    ordersToRotate: [],
                    ordersToUpdate: [],
                    ordersToCancel: [],
                    stateUpdates: [],
                    hadRotation: false
                };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            }
        };

        bot.updateOrdersOnChainBatch = async () => {
            batchCalls++;
            return { executed: false, hadRotation: false };
        };

        chainOrders.readOpenOrders = async () => [];

        bot._startOpenOrdersSyncLoop();
        await new Promise((resolve) => setTimeout(resolve, 90));
        await bot._stopOpenOrdersSyncLoop();

        assert(syncCalls >= 1, 'Main loop should run synchronizeWithChain at least once');
        assert.strictEqual(processCalls, 1, 'Main loop should process sync-detected fills');
        assert.strictEqual(batchCalls, 1, 'Main loop should execute rebalance batch pipeline');
        assert.strictEqual(persistCalls, 1, 'Main loop should persist grid after rebalance pipeline');

        console.log('✓ Main loop processes sync-detected fills through rebalance pipeline');
    } finally {
        if (originalLoopMs === undefined) {
            delete process.env.OPEN_ORDERS_SYNC_LOOP_MS;
        } else {
            process.env.OPEN_ORDERS_SYNC_LOOP_MS = originalLoopMs;
        }
        chainOrders.readOpenOrders = originalReadOpenOrders;
    }
}

runTests()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('✗ Main loop sync fill rebalance test failed');
        console.error(err);
        process.exit(1);
    });
