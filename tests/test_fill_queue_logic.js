
const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');

// Mock AsyncLock
class MockAsyncLock {
    constructor() {
        this.locked = false;
        this.queueLen = 0;
    }
    async acquire(fn) {
        if (this.locked) {
            this.queueLen++;
            // Simple mock: fail if locked to verify we don't double-acquire in loop
            // In real AsyncLock, it queues. Here we just run immediately if not locked?
            // For testing the queue loop, we want to simulate "lock acquired".
        }
        this.locked = true;
        try {
            return await fn();
        } finally {
            this.locked = false;
        }
    }
    isLocked() { return this.locked; }
    getQueueLength() { return this.queueLen; }
}

// Mock Dependencies
const mockConfig = { botKey: 'test_bot', dryRun: false };
const mockManager = {
    logger: { log: (msg) => console.log('[MockLog]', msg) },
    syncFromFillHistory: (op) => ({ filledOrders: [{ id: '1.7.123', ...op }] }),
    syncFromOpenOrders: (op) => ({ filledOrders: [{ id: '1.7.123', ...op }] }),
    processFilledOrders: async (orders) => ({ executed: true, hadRotation: true }),
    checkSpreadCondition: async () => ({ ordersPlaced: 0 }),
    recalculateFunds: () => { },
    assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
    orders: new Map(),
    _gridSidesUpdated: []
};
const mockChainOrders = {
    getFillProcessingMode: () => 'history',
    readOpenOrders: async () => [],
    executeBatch: async () => []
};

async function testFillQueue() {
    console.log('--- Starting Fill Queue Test ---');

    const bot = new DEXBot(mockConfig);
    bot.manager = mockManager;
    bot._fillProcessingLock = new MockAsyncLock();
    // Verify initial state
    assert.deepStrictEqual(bot._incomingFillQueue, []);

    // Create the callback
    const callback = bot._createFillCallback(mockChainOrders);

    // 1. Simulate receiving a batch of fills
    const fills1 = [
        { op: [4, { order_id: '1.7.1', is_maker: true }], block_num: 100, id: '1.11.1' },
        { op: [4, { order_id: '1.7.2', is_maker: true }], block_num: 100, id: '1.11.2' }
    ];

    console.log('1. Receiving Batch 1...');
    await callback(fills1);

    // Since _consumeFillQueue is fire-and-forget, we need to wait a tiny bit or mock the consumer to be awaited?
    // In the real code: callback pushes and calls _consumeFillQueue (which is async).
    // The callback returns promise (async).

    // We can't easily wait for the fire-and-forget consumer unless we spy on it.
    // But since node is single threaded, the promise microtasks should drain if we await.

    // Let's modify the bot instance to spy on _consumeFillQueue or just wait.
    await new Promise(r => setTimeout(r, 100));

    // Verify queue is empty (consumed) and fills processed (by checking logs or side effects)
    // We can check checks...
    assert.strictEqual(bot._incomingFillQueue.length, 0, 'Queue should be empty after processing');

    console.log('Passed: Batch 1 consumed.');

    // 2. Test Interruption / Accumulation
    // We want to simulate new fills arriving WHILE consumer is running.
    // We can mock `processFilledOrders` to be slow.

    console.log('2. Testing Interruption...');

    let processPromiseResolver;
    const processPromise = new Promise(r => { processPromiseResolver = r; });

    bot.manager.processFilledOrders = async () => {
        console.log('   [Mock] Processing started... waiting...');
        await processPromise; // Block here
        console.log('   [Mock] Processing resumed.');
        return { executed: true, hadRotation: false };
    };

    const fills2 = [{ op: [4, { order_id: '1.7.3', is_maker: true }], block_num: 101, id: '1.11.3' }];
    const fills3 = [{ op: [4, { order_id: '1.7.4', is_maker: true }], block_num: 101, id: '1.11.4' }];

    // Trigger first batch (will block)
    callback(fills2);

    await new Promise(r => setTimeout(r, 10)); // unexpected yield
    // Queue should now be empty (moved to consuming loop) or...
    // The loop takes snapshot: const allFills = [...queue]; queue = [];
    // Then iterates validFills. checking processFilledOrders.

    // Trigger second batch WHILE blocked
    console.log('   Sending Batch 3 while blocked...');
    callback(fills3);

    assert.strictEqual(bot._incomingFillQueue.length, 1, 'Batch 3 should be in queue while Batch 2 is processing');
    assert.strictEqual(bot._incomingFillQueue[0].op[1].order_id, '1.7.4');

    // Resolve the block
    console.log('   Unblocking Batch 2...');
    processPromiseResolver();

    // Wait for loop to loop back
    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(bot._incomingFillQueue.length, 0, 'Queue should be consumed after unblocking');

    console.log('Passed: Interruption handled.');

    console.log('--- Test Complete ---');
}

testFillQueue().catch(err => {
    console.error('TEST FAILED:', err);
    process.exit(1);
});
