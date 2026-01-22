/**
 * tests/test_accounting_logic.js
 * 
 * Ported from tests/unit/accounting.test.js
 * Comprehensive unit tests for accounting.js - Fund tracking and calculations
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');

// Mock getAssetFees to prevent crashes during recalculateFunds
const OrderUtils = require('../modules/order/utils');
const originalGetAssetFees = OrderUtils.getAssetFees;

OrderUtils.getAssetFees = (asset) => {
    if (asset === 'BTS') {
        return {
            total: 0.011,
            createFee: 0.1,
            updateFee: 0.001,
            makerNetFee: 0.01,
            takerNetFee: 0.1,
            netFee: 0.01,
            isMaker: true
        };
    }
    return 1.0;
};

async function runTests() {
    console.log('Running Accountant Logic Tests...');

    const createManager = () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            weightDistribution: { sell: 0.5, buy: 0.5 },
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

    // Test: resetFunds()
    console.log(' - Testing resetFunds()...');
    {
        const manager = createManager();
        manager.resetFunds();
        assert(manager.funds !== undefined, 'funds should be defined');
        assert.strictEqual(manager.funds.available.buy, 0);
        assert.strictEqual(manager.funds.available.sell, 0);
        assert.strictEqual(manager.funds.committed.chain.buy, 0);
        assert.strictEqual(manager.funds.virtual.buy, 0);
    }

    // Test: recalculateFunds()
    console.log(' - Testing recalculateFunds()...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'virtual-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            size: 500,
            price: 100
        });
        assert.strictEqual(manager.funds.virtual.buy, 500);

        manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 25,
            price: 100,
            orderId: 'chain-001'
        });
        assert.strictEqual(manager.funds.committed.chain.sell, 25);
    }

    // Test: Multiple orders summing
    console.log(' - Testing multiple orders summing...');
    {
        const manager = createManager();
        manager.pauseFundRecalc();
        manager._updateOrder({ id: 'b1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
        manager._updateOrder({ id: 'b2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 200 });
        manager._updateOrder({ id: 'b3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 150, orderId: 'c1' });
        manager.resumeFundRecalc();

        assert.strictEqual(manager.funds.virtual.buy, 300);
        assert.strictEqual(manager.funds.committed.grid.buy, 150);
        assert.strictEqual(manager.funds.total.grid.buy, 450);
    }

    // Test: Invariant chainTotal = chainFree + chainCommitted
    console.log(' - Testing chainTotal invariant...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'o1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 1000,
            orderId: 'c1'
        });

        const { buy: chainTotal } = manager.funds.total.chain;
        const { buy: chainFree } = manager.accountTotals;
        const { buy: chainCommitted } = manager.funds.committed.chain;

        assert(Math.abs(chainTotal - (chainFree + chainCommitted)) < 0.01, 'Invariant failed: chainTotal != chainFree + chainCommitted');
    }

    // Test: Precision
    console.log(' - Testing precision...');
    {
        const manager = createManager();
        manager.pauseFundRecalc();
        manager._updateOrder({ id: 'p1', type: ORDER_TYPES.BUY, size: 123.456789, price: 100, state: ORDER_STATES.VIRTUAL });
        manager._updateOrder({ id: 'p2', type: ORDER_TYPES.BUY, size: 987.654321, price: 99, state: ORDER_STATES.VIRTUAL });
        manager.resumeFundRecalc();

        const expected = 123.456789 + 987.654321;
        assert(Math.abs(manager.funds.virtual.buy - expected) < 0.00000001);
    }

    // Test: PARTIAL -> ACTIVE Transition Bug Fix
    console.log(' - Testing PARTIAL -> ACTIVE transition bug fix...');
    {
        const manager = createManager();
        const oldOrder = {
            id: 'p-fix',
            state: ORDER_STATES.PARTIAL,
            type: ORDER_TYPES.BUY,
            size: 100,
            price: 100
        };
        const newOrder = {
            id: 'p-fix',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            price: 100,
            orderId: 'c-new'
        };

        const buyFreeBefore = manager.accountTotals.buyFree;
        manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test');
        const buyFreeAfter = manager.accountTotals.buyFree;
        
        assert.strictEqual(buyFreeBefore - buyFreeAfter, 0, 'Should not deduct again if already PARTIAL');
    }

    // Restore original
    OrderUtils.getAssetFees = originalGetAssetFees;

    console.log('✓ Accountant logic tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
