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
    console.log('Running Periodic Sync Fill Rebalance Test...');

    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalReadOpenOrders = chainOrders.readOpenOrders;

    let capturedCallback = null;

    global.setInterval = (fn) => {
        capturedCallback = fn;
        return { timer: 'mock-periodic' };
    };
    global.clearInterval = () => { };

    try {
        let fetchCalls = 0;
        let syncCalls = 0;
        let processCalls = 0;
        let batchCalls = 0;
        let persistCalls = 0;
        let maintenanceCalls = 0;

        const bot = new DEXBot({
            botKey: 'test_periodic_sync_fill_rebalance',
            dryRun: false,
            startPrice: 1,
            assetA: 'XRP',
            assetB: 'BTS',
            incrementPercent: 0.5
        });

        bot.accountId = '1.2.999';

        const syntheticFilledOrder = {
            id: 'slot-174',
            orderId: '1.7.777777',
            type: 'sell',
            state: 'partial',
            size: 0.0001,
            price: 1357.58,
            isPartial: false
        };

        bot.manager = {
            _fillProcessingLock: new MockAsyncLock(),
            _recoveryAttempted: true,
            fetchAccountTotals: async () => {
                fetchCalls++;
            },
            synchronizeWithChain: async () => {
                syncCalls++;
                return { filledOrders: [syntheticFilledOrder], unmatchedChainOrders: [] };
            },
            processFilledOrders: async (filledOrders) => {
                processCalls++;
                assert.strictEqual(filledOrders.length, 1, 'Expected one periodic sync-detected fill');
                assert.strictEqual(filledOrders[0].orderId, '1.7.777777', 'Expected periodic detected order to flow into strategy');
                return {
                    actions: [{ type: 'create', id: 'slot-174', order: { id: 'slot-174', type: 'buy', size: 1, price: 100 } }],
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

        bot._performPeriodicGridChecks = async () => {
            maintenanceCalls++;
        };

        chainOrders.readOpenOrders = async () => [];

        bot._setupBlockchainFetchInterval();
        assert.strictEqual(typeof capturedCallback, 'function', 'Periodic interval callback should be registered');

        await capturedCallback();

        assert.strictEqual(fetchCalls, 1, 'Periodic callback should fetch account totals once');
        assert.strictEqual(syncCalls, 1, 'Periodic callback should sync open orders once');
        assert.strictEqual(processCalls, 1, 'Periodic callback should process sync-detected fills');
        assert.strictEqual(batchCalls, 1, 'Periodic callback should execute rebalance batch for sync-detected fills');
        assert.strictEqual(persistCalls, 1, 'Periodic callback should persist grid after batch execution');
        assert.strictEqual(maintenanceCalls, 1, 'Periodic callback should continue into maintenance checks');
        assert.strictEqual(bot.manager._recoveryAttempted, false, 'Periodic callback should reset recovery flag each cycle');

        console.log('✓ Periodic sync processes detected fills through rebalance and batch pipeline');
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        chainOrders.readOpenOrders = originalReadOpenOrders;
    }
}

runTests()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('✗ Periodic sync fill rebalance test failed');
        console.error(err);
        process.exit(1);
    });
