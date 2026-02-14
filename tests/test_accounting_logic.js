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
const OrderUtils = require('../modules/order/utils/math');
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

     const createManager = async () => {
         const mgr = new OrderManager({
             market: 'TEST/BTS',
             assetA: 'TEST',
             assetB: 'BTS',
             weightDistribution: { sell: 0.5, buy: 0.5 },
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

     // Test: resetFunds()
     console.log(' - Testing resetFunds()...');
     {
         const manager = await createManager();
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
         const manager = await createManager();
        await manager._updateOrder({
            id: 'virtual-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            size: 500,
            price: 100
        });
        assert.strictEqual(manager.funds.virtual.buy, 500);

        await manager._updateOrder({
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
         const manager = await createManager();
         manager.pauseFundRecalc();
          await manager._updateOrder({ id: 'b1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
          await manager._updateOrder({ id: 'b2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 200 });
          await manager._updateOrder({ id: 'b3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 150, orderId: 'c1' });
          await manager.resumeFundRecalc();

         assert.strictEqual(manager.funds.virtual.buy, 300);
         assert.strictEqual(manager.funds.committed.grid.buy, 150);
         assert.strictEqual(manager.funds.total.grid.buy, 450);
     }

    // Test: Invariant chainTotal = chainFree + chainCommitted
    console.log(' - Testing chainTotal invariant...');
    {
        const manager = await createManager();
        await manager._updateOrder({
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
        const manager = await createManager();
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'p1', type: ORDER_TYPES.BUY, size: 123.456789, price: 100, state: ORDER_STATES.VIRTUAL });
        await manager._updateOrder({ id: 'p2', type: ORDER_TYPES.BUY, size: 987.654321, price: 99, state: ORDER_STATES.VIRTUAL });
        await manager.resumeFundRecalc();

        const expected = 123.456789 + 987.654321;
        assert(Math.abs(manager.funds.virtual.buy - expected) < 0.00000001);
    }

    // Test: PARTIAL -> ACTIVE Transition Bug Fix
    console.log(' - Testing PARTIAL -> ACTIVE transition bug fix...');
    {
        const manager = await createManager();
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
        await manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test');
        const buyFreeAfter = manager.accountTotals.buyFree;

        assert.strictEqual(buyFreeBefore - buyFreeAfter, 0, 'Should not deduct again if already PARTIAL');
    }

    // Test: Manual Fund Override Protection (pauseFundRecalcDepth flag)
    console.log(' - Testing manual fund override protection via pauseFundRecalc...');
    {
        const manager = await createManager();
        manager.resetFunds();

        // Manually override fund values
        const manualAvailable = 5000;
        manager.funds.available.buy = manualAvailable;

        // While paused, add orders that would normally trigger recalculateFunds
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'override-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
        await manager._updateOrder({ id: 'override-2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 200 });
        await manager._updateOrder({ id: 'override-3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 150, orderId: 'c-override' });

        // Verify manual value is NOT overwritten while paused
        assert.strictEqual(
            manager.funds.available.buy,
            manualAvailable,
            `Manual fund override should be preserved while paused (expected ${manualAvailable}, got ${manager.funds.available.buy})`
        );

        // Resume and verify recalculateFunds NOW applies
        await manager.resumeFundRecalc();
        const expectedVirtual = 300; // 100 + 200
        assert.strictEqual(
            manager.funds.virtual.buy,
            expectedVirtual,
            `After resume, virtual funds should be recalculated (expected ${expectedVirtual}, got ${manager.funds.virtual.buy})`
        );
    }

    // Test: Missing fee cache must not crash fill accounting (fallback to raw proceeds)
    console.log(' - Testing fill accounting fee-cache fallback...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const cacheSellBefore = manager.funds.cacheFunds.sell;
        const rawReceives = 2.5;

        try {
            await manager.accountant.processFillAccounting({
                pays: { asset_id: '1.3.1', amount: 100000 },
                receives: { asset_id: '1.3.0', amount: 250000 }
            });
        } catch (err) {
            assert.fail('processFillAccounting should tolerate missing fee cache and continue: ' + err.message);
        }

        assert.strictEqual(manager.accountTotals.sell, sellTotalBefore + rawReceives, 'Sell total should credit raw proceeds when fee lookup fails');
        assert.strictEqual(manager.funds.cacheFunds.sell, cacheSellBefore + rawReceives, 'cacheFunds should track credited raw proceeds');
    }

    // Restore original
    OrderUtils.getAssetFees = originalGetAssetFees;

    console.log('✓ Accountant logic tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
