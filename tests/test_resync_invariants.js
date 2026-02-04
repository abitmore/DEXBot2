/**
 * tests/test_resync_invariants.js
 * 
 * Verifies that the isBootstrapping flag correctly suppresses fund invariant warnings
 * during transient states like grid resync.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');

async function runTests() {
    console.log('Running Resync Invariant Tests...');

    const createManager = () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            activeOrders: { buy: 5, sell: 5 }
        });
        mgr.setAccountTotals({
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
        const manager = createManager();
        manager.finishBootstrap(); // Set isBootstrapping = false

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        manager._updateOrder({
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
        const manager = createManager();
        manager.startBootstrap(); // Set isBootstrapping = true

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        manager._updateOrder({
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
        const manager = createManager();
        let invariantViolations = 0;

        // Mock logger to count warnings
        manager.logger.log = (msg, level) => {
            if (level === 'warn' && msg.includes('Fund invariant violation')) {
                invariantViolations++;
            }
        };

        // 1. Normal state (no violations)
        manager.finishBootstrap();
        manager.recalculateFunds();
        assert.strictEqual(invariantViolations, 0);

        // 2. Start resync
        manager.startBootstrap();

        // 3. Clear grid (this would normally cause a violation if not bootstrapping)
        manager.orders.clear();
        manager._ordersByState[ORDER_STATES.ACTIVE].clear();
        manager.recalculateFunds(); // Tracked total becomes 10000 (free only), but actual is still 10000. Wait, if actual is same as free, no violation.

        // To force a violation, we'd need tracked != actual.
        // During resync, tracked = free, but actual = free + chain_orders_still_on_chain.
        // So tracked < actual.

        // Let's manually set accountTotals.buy to 11000 (simulating 1000 on chain)
        manager.setAccountTotals({ buy: 11000, buyFree: 10000 });
        manager.recalculateFunds(); // Tracked = 10000. Invariant would see diff of 1000.

        assert.strictEqual(invariantViolations, 0, 'No violations should be logged during resync bootstrap');

        // 4. Finish resync (invariant check should resume)
        manager.finishBootstrap();
        manager.recalculateFunds();

        assert(invariantViolations > 0, 'Violation should be logged now that bootstrap is finished and grid is still empty');
    }

    console.log('✓ Resync invariant tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
