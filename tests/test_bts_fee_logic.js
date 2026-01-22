/**
 * tests/test_bts_fee_logic.js
 * 
 * Ported from tests/unit/bts_fee_settlement.test.js
 * Unit tests for BTS fee settlement fix
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');

async function runTests() {
    console.log('Running BTS Fee Logic Tests...');

    const createManager = () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 1.0, botFunds: { buy: 10000, sell: 1000 },
            activeOrders: { buy: 5, sell: 5 }, incrementPercent: 1
        });
        mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.121', precision: 5 } };
        mgr.setAccountTotals({ buy: 10000, sell: 1000, buyFree: 10000, sellFree: 1000 });
        mgr.resetFunds();
        return mgr;
    };

    console.log(' - Testing Normal Settlement Flow...');
    {
        const manager = createManager();
        manager.funds.btsFeesOwed = 50;
        manager.funds.cacheFunds.sell = 50;
        const sellFreeBefore = manager.accountTotals.sellFree;
        await manager.accountant.deductBtsFees('sell');
        assert.strictEqual(manager.accountTotals.sellFree, sellFreeBefore - 50);
        assert.strictEqual(manager.funds.cacheFunds.sell, 0);
        assert.strictEqual(manager.funds.btsFeesOwed, 0);
    }

    console.log(' - Testing FULL fee deduction (Bug Fix)...');
    {
        const manager = createManager();
        manager.funds.btsFeesOwed = 50;
        manager.funds.cacheFunds.sell = 30;
        const sellFreeBefore = manager.accountTotals.sellFree;
        await manager.accountant.deductBtsFees('sell');
        assert.strictEqual(sellFreeBefore - manager.accountTotals.sellFree, 50, 'Full fee amount must reduce chainFree');
        assert.strictEqual(manager.funds.cacheFunds.sell, 0);
        assert.strictEqual(manager.funds.btsFeesOwed, 0);
    }

    console.log(' - Testing Insufficient Funds (Deferral)...');
    {
        const manager = createManager();
        manager.funds.btsFeesOwed = 50;
        manager.funds.cacheFunds.sell = 30;
        manager.setAccountTotals({ buy: 10000, sell: 40, buyFree: 10000, sellFree: 40 });
        await manager.accountant.deductBtsFees('sell');
        assert.strictEqual(manager.funds.btsFeesOwed, 50, 'Settlement should be deferred');
        assert.strictEqual(manager.funds.cacheFunds.sell, 30);
    }

    console.log(' - Testing Zero Fees Graceful Handling...');
    {
        const manager = createManager();
        manager.funds.btsFeesOwed = 0;
        await manager.accountant.deductBtsFees('sell');
        assert.strictEqual(manager.funds.btsFeesOwed, 0);
    }

    console.log('✓ BTS Fee logic tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
