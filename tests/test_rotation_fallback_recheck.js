const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');
const chainOrders = require('../modules/chain_orders');
const { ORDER_TYPES } = require('../modules/constants');

const assetA = { id: '1.3.1', precision: 5 };
const assetB = { id: '1.3.0', precision: 5 };

function makeRotation() {
    return {
        oldOrder: {
            id: 'slot-1',
            orderId: '1.7.123',
            rawOnChain: { id: '1.7.123' }
        },
        newPrice: 1.2345,
        newSize: 10,
        type: ORDER_TYPES.BUY,
        newGridId: 'slot-2'
    };
}

function makeBotContext(logs) {
    return {
        account: '1.2.999',
        accountId: '1.2.999',
        manager: {
            logger: {
                log: (message, level) => logs.push({ message, level })
            }
        },
        _getMarketAssets: () => ({ assetAId: '1.3.1', assetBId: '1.3.0' })
    };
}

async function runCase({ name, readOpenOrdersImpl, expectedFallbackCount, expectedLogSnippet }) {
    const originalBuildUpdateOrderOp = chainOrders.buildUpdateOrderOp;
    const originalReadOpenOrders = chainOrders.readOpenOrders;

    const logs = [];
    let recheckCalls = 0;

    chainOrders.buildUpdateOrderOp = async () => {
        throw new Error('Order not found');
    };

    chainOrders.readOpenOrders = async (...args) => {
        recheckCalls += 1;
        return readOpenOrdersImpl(...args);
    };

    try {
        const operations = [];
        const opContexts = [];
        const ctx = makeBotContext(logs);

        const unmet = await DEXBot.prototype._buildRotationOps.call(
            ctx,
            [makeRotation()],
            assetA,
            assetB,
            operations,
            opContexts
        );

        assert.strictEqual(operations.length, 0, `${name}: should not enqueue update op`);
        assert.strictEqual(opContexts.length, 0, `${name}: should not enqueue op context`);
        assert.strictEqual(recheckCalls, 1, `${name}: should recheck chain exactly once`);
        assert.strictEqual(unmet.length, expectedFallbackCount, `${name}: unexpected fallback count`);
        assert(
            logs.some(entry => String(entry.message).includes(expectedLogSnippet)),
            `${name}: expected log to include "${expectedLogSnippet}"`
        );
    } finally {
        chainOrders.buildUpdateOrderOp = originalBuildUpdateOrderOp;
        chainOrders.readOpenOrders = originalReadOpenOrders;
    }
}

async function run() {
    console.log('Running rotation fallback recheck tests...');

    await runCase({
        name: 'still-exists-skip-fallback',
        readOpenOrdersImpl: async () => [{ id: '1.7.123' }],
        expectedFallbackCount: 0,
        expectedLogSnippet: 'still on-chain'
    });

    await runCase({
        name: 'confirmed-missing-create-fallback',
        readOpenOrdersImpl: async () => [],
        expectedFallbackCount: 1,
        expectedLogSnippet: 'not found after recheck'
    });

    await runCase({
        name: 'recheck-error-defers-fallback',
        readOpenOrdersImpl: async () => {
            throw new Error('rpc timeout');
        },
        expectedFallbackCount: 0,
        expectedLogSnippet: 'recheck failed'
    });

    console.log('rotation fallback recheck tests passed');
}

run().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('rotation fallback recheck tests failed');
    console.error(err);
    process.exit(1);
});
