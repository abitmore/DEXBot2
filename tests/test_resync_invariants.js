/**
 * tests/test_resync_invariants.js
 * 
 * Verifies that the isBootstrapping flag correctly suppresses fund invariant warnings
 * during transient states like grid resync.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');

const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 30000);
const testTimeoutHandle = setTimeout(() => {
    console.error(`✗ Resync invariant tests timed out after ${TEST_TIMEOUT_MS}ms`);
    process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof testTimeoutHandle.unref === 'function') testTimeoutHandle.unref();

async function runTests() {
    console.log('Running Resync Invariant Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            activeOrders: { buy: 5, sell: 5 }
        });
        await mgr.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 10000,
            sellFree: 100
        });
        return mgr;
    };

    // Test 1: Invariant check runs when NOT bootstrapping
    console.log(' - Case 1: Invariant check runs when NOT bootstrapping...');
    {
        const manager = await createManager();
        manager.finishBootstrap(); // Set isBootstrapping = false

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: 'c1'
        });

        assert.strictEqual(invariantChecked, true, 'Invariant check should have run');
    }

    // Test 2: Invariant check is suppressed when bootstrapping
    console.log(' - Case 2: Invariant check is suppressed when bootstrapping...');
    {
        const manager = await createManager();
        manager.startBootstrap(); // Set isBootstrapping = true

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: 'c1'
        });

        assert.strictEqual(invariantChecked, false, 'Invariant check should be suppressed during bootstrap');
    }

    // Test 3: Resync simulation
    console.log(' - Case 3: Resync simulation (start -> clear -> finish)...');
    {
        const manager = await createManager();
        let invariantCallsDuringBootstrap = 0;
        let invariantCallsAfterBootstrap = 0;

        // Mock _verifyFundInvariants to count calls based on bootstrap state
        manager.accountant._verifyFundInvariants = async () => {
            if (manager._state.isBootstrapping()) {
                invariantCallsDuringBootstrap++;
            } else {
                invariantCallsAfterBootstrap++;
            }
        };

        // 1. Normal state - bootstrap already started in constructor; finish it
        manager.finishBootstrap();
        // _verifyFundInvariants should not be called during recalculateFunds while not bootstrapping
        // but the mock counting is what we care about during/after

        // 2. Start resync (bootstrap again)
        manager.startBootstrap();

        // 3. Recalculate during resync - invariant check should be suppressed
        await manager.recalculateFunds();
        assert.strictEqual(invariantCallsDuringBootstrap, 0, 'Invariant check should be suppressed during resync bootstrap');

        // 4. Finish resync (invariant check should resume)
        manager.finishBootstrap();
        await manager.recalculateFunds();

        assert(invariantCallsAfterBootstrap > 0, 'Invariant check should run now that bootstrap is finished');
    }

    console.log('✓ Resync invariant tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
}).finally(() => {
    clearTimeout(testTimeoutHandle);
});
