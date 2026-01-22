/**
 * tests/test_manager_logic.js
 * 
 * Ported from tests/unit/manager.test.js
 * Comprehensive unit tests for manager.js - Order management and state machine
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');

// Mock getAssetFees
const OrderUtils = require('../modules/order/utils');
const originalGetAssetFees = OrderUtils.getAssetFees;
OrderUtils.getAssetFees = (asset) => {
    if (asset === 'BTS') {
        return { total: 0.011, createFee: 0.1, updateFee: 0.001, makerNetFee: 0.01, takerNetFee: 0.1, netFee: 0.01, isMaker: true };
    }
    return 1.0;
};

async function runTests() {
    console.log('Running OrderManager Logic Tests...');

    const createManager = () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            activeOrders: { buy: 5, sell: 5 }
        });
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        return mgr;
    };

    console.log(' - Testing Index Consistency...');
    {
        const manager = createManager();
        const order = { id: 't-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 };
        manager._updateOrder(order);

        assert(manager._ordersByState[ORDER_STATES.VIRTUAL].has('t-1'));
        assert(manager._ordersByType[ORDER_TYPES.BUY].has('t-1'));
        assert(manager.orders.has('t-1'));

        // Transition
        manager._updateOrder({ id: 't-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 100, orderId: 'c-1' });
        assert(!manager._ordersByState[ORDER_STATES.VIRTUAL].has('t-1'));
        assert(manager._ordersByState[ORDER_STATES.ACTIVE].has('t-1'));
    }

    console.log(' - Testing Index Repair...');
    {
        const manager = createManager();
        manager._updateOrder({ id: 'r-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
        manager._ordersByState[ORDER_STATES.VIRTUAL].clear(); // Corrupt

        assert(!manager.validateIndices());
        manager.assertIndexConsistency();
        assert(manager.validateIndices());
    }

    console.log(' - Testing SPREAD state restriction...');
    {
        const manager = createManager();
        let loggedError = false;
        const originalLog = manager.logger.log;
        manager.logger.log = (msg, level) => { if (level === 'error' && msg.includes('SPREAD')) loggedError = true; };

        manager._updateOrder({ id: 's-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SPREAD, size: 0 });
        manager._updateOrder({ id: 's-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SPREAD, size: 0 });

        manager.logger.log = originalLog;
        assert(loggedError, 'Should log error when trying to move SPREAD to ACTIVE');
    }

    console.log(' - Testing Order Locking...');
    {
        const manager = createManager();
        const id = 'l-1';
        assert(!manager.isOrderLocked(id));
        manager.lockOrders([id]);
        assert(manager.isOrderLocked(id));
        manager.unlockOrders([id]);
        assert(!manager.isOrderLocked(id));
    }

    console.log(' - Testing Fund Recalc Pausing...');
    {
        const manager = createManager();
        let recalcCount = 0;
        const originalRecalc = manager.accountant.recalculateFunds;
        manager.accountant.recalculateFunds = () => { recalcCount++; };

        manager.pauseFundRecalc();
        manager._updateOrder({ id: 'p-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
        assert.strictEqual(recalcCount, 0);

        manager.resumeFundRecalc();
        assert(recalcCount > 0);
        manager.accountant.recalculateFunds = originalRecalc;
    }

    OrderUtils.getAssetFees = originalGetAssetFees;
    console.log('✓ OrderManager logic tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
