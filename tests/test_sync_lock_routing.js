const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');

function createManagerFixture() {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });

    manager.logger = {
        log: () => {},
        marketName: 'TEST/USD',
        logFundsStatus: () => {}
    };

    manager.accountant = {
        updateOptimisticFreeBalance: async () => {},
        recalculateFunds: async () => {},
        tryDeductFromChainFree: async () => true,
        addToChainFree: async () => true
    };

    manager.assets = {
        assetA: { symbol: 'BTS', id: '1.3.0', precision: 5 },
        assetB: { symbol: 'USD', id: '1.3.121', precision: 4 }
    };

    return manager;
}

async function testReadOpenOrdersNoDeadlock() {
    console.log('\n[SYNC-LOCK-001] readOpenOrders sync does not deadlock...');
    const manager = createManagerFixture();

    const timeoutMs = 1500;
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    const result = await Promise.race([
        manager.synchronizeWithChain([], 'readOpenOrders'),
        timeoutPromise
    ]);

    assert.ok(result && typeof result === 'object', 'sync should resolve with result object');
    console.log('  PASS');
}

async function testSourceBasedLockRouting() {
    console.log('\n[SYNC-LOCK-002] synchronizeWithChain routes lock ownership by source...');
    const manager = createManagerFixture();

    let lockAcquireCalls = 0;
    manager._gridLock = {
        acquire: async (callback) => {
            lockAcquireCalls += 1;
            return await callback();
        }
    };

    manager.sync.synchronizeWithChain = async (_data, src) => ({ src });

    await manager.synchronizeWithChain({ any: 1 }, 'createOrder');
    assert.strictEqual(lockAcquireCalls, 1, 'createOrder should acquire _gridLock in manager wrapper');

    lockAcquireCalls = 0;
    await manager.synchronizeWithChain([], 'readOpenOrders');
    assert.strictEqual(lockAcquireCalls, 0, 'readOpenOrders should bypass manager-level _gridLock');

    lockAcquireCalls = 0;
    await manager.synchronizeWithChain([], 'periodicBlockchainFetch');
    assert.strictEqual(lockAcquireCalls, 0, 'periodicBlockchainFetch should bypass manager-level _gridLock');

    lockAcquireCalls = 0;
    await manager.synchronizeWithChain({ any: 1 }, 'customSource');
    assert.strictEqual(lockAcquireCalls, 1, 'unknown source should still acquire _gridLock');

    console.log('  PASS');
}

async function run() {
    console.log('Running sync lock routing regression tests...');
    await testReadOpenOrdersNoDeadlock();
    await testSourceBasedLockRouting();
    console.log('\nAll sync lock routing regression tests passed');
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
