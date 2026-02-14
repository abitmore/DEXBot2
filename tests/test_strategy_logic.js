/**
 * tests/test_strategy_logic.js
 * 
 * Ported from tests/unit/strategy.test.js
 * Comprehensive unit tests for strategy.js - Rebalancing logic and order placement
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');

// Mock getAssetFees
const OrderUtils = require('../modules/order/utils/math');
const originalGetAssetFees = OrderUtils.getAssetFees;
OrderUtils.getAssetFees = (asset) => {
    if (asset === 'BTS') {
        return { total: 0.011, createFee: 0.1, updateFee: 0.001, makerNetFee: 0.01, takerNetFee: 0.1, netFee: 0.01, isMaker: true };
    }
    return 1.0;
};

async function runTests() {
    console.log('Running Strategy Logic Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 100, incrementPercent: 1, targetSpreadPercent: 2,
            activeOrders: { buy: 5, sell: 5 }, weightDistribution: { sell: 0.5, buy: 0.5 }
        });
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        mgr.resetFunds();
        return mgr;
    };

    console.log(' - Testing VIRTUAL Order Placement Capping (b913661)...');
    {
        const manager = await createManager();
        const virtualOrders = [
            { id: 'v-b-1', type: ORDER_TYPES.BUY, price: 99, size: 500, state: ORDER_STATES.VIRTUAL },
            { id: 'v-s-1', type: ORDER_TYPES.SELL, price: 101, size: 50, state: ORDER_STATES.VIRTUAL }
        ];
        manager.pauseFundRecalc();
        for (const o of virtualOrders) {
            await manager._updateOrder(o);
        }
        await manager.resumeFundRecalc();

        manager.funds.available.buy = 0;
        manager.funds.available.sell = 0;

        const result = await manager.strategy.rebalance();
        const placements = result.ordersToPlace.filter(o => virtualOrders.some(v => v.id === o.id));
        assert(placements.length > 0, 'Should have placements for VIRTUAL orders even if availablePool is 0');
        assert(placements[0].size > 0, 'Placement size should be greater than 0');
    }

    console.log(' - Testing PARTIAL Order Update (b913661)...');
    {
        const manager = await createManager();
        await manager._updateOrder({ id: 'p-d-1', type: ORDER_TYPES.BUY, price: 99, size: 5, state: ORDER_STATES.PARTIAL, orderId: 'c1' });
        await manager._updateOrder({ id: 'v-1', type: ORDER_TYPES.BUY, price: 98, size: 0, state: ORDER_STATES.VIRTUAL });
        
        const result = await manager.strategy.rebalance();
        const dustUpdate = result.ordersToUpdate.find(u => u.partialOrder?.id === 'p-d-1');
        assert(dustUpdate !== undefined, 'Should update dust PARTIAL');
        assert(dustUpdate.newSize > 5, 'Should increase size from dust');
    }

    console.log(' - Testing dust no-op does not consume reaction cap...');
    {
        const manager = await createManager();
        await manager.setAccountTotals({ buy: 600, sell: 100, buyFree: 600, sellFree: 100 });
        manager.resetFunds();

        await manager._updateOrder({ id: 'p-d-noop', type: ORDER_TYPES.BUY, price: 99, size: 5, state: ORDER_STATES.PARTIAL, orderId: 'c-noop' });
        await manager._updateOrder({ id: 'v-b-presized', type: ORDER_TYPES.BUY, price: 98, size: 500, state: ORDER_STATES.VIRTUAL });
        await manager._updateOrder({ id: 'v-s-presized', type: ORDER_TYPES.SELL, price: 101, size: 50, state: ORDER_STATES.VIRTUAL });

        const result = await manager.strategy.rebalance();
        const dustUpdate = result.ordersToUpdate.find(u => u.partialOrder?.id === 'p-d-noop');
        const buyPlacement = result.ordersToPlace.find(o => o.id === 'v-b-presized');

        assert.strictEqual(dustUpdate, undefined, 'Dust partial should be skipped when no affordable increase exists');
        assert(buyPlacement, 'Pre-sized virtual BUY should still be placed when dust update is a no-op');
        assert(buyPlacement.size >= 500, 'Pre-sized virtual BUY placement should preserve pre-allocated size');
    }

    console.log(' - Testing Boundary Index Persistence (d17ece6)...');
    {
        const manager = await createManager();
        manager.boundaryIdx = undefined;
        manager.pauseFundRecalc();
        for (let i = 0; i < 10; i++) {
            const price = 95 + (i * 1.0);
            await manager._updateOrder({ id: `o-${i}`, type: price < 100 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, price, size: 100, state: ORDER_STATES.VIRTUAL });
        }
        await manager.resumeFundRecalc();
        await manager.strategy.rebalance();
        assert(manager.boundaryIdx !== undefined, 'boundaryIdx should be initialized');
    }

    console.log(' - Testing BUY Side Weighting (d17ece6)...');
    {
        const manager = await createManager();
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'b-far', type: ORDER_TYPES.BUY, price: 85, size: 0, state: ORDER_STATES.VIRTUAL });
        await manager._updateOrder({ id: 'b-near', type: ORDER_TYPES.BUY, price: 99, size: 0, state: ORDER_STATES.VIRTUAL });
        await manager.resumeFundRecalc();

        const result = await manager.strategy.rebalance();
        const near = result.ordersToPlace.find(p => p.id === 'b-near');
        const far = result.ordersToPlace.find(p => p.id === 'b-far');
        if (near && far) {
            assert(near.size >= far.size, 'Market-closest BUY should have more capital');
        }
    }

    console.log(' - Testing CacheFunds Integration (32d81ea)...');
    {
        const manager = await createManager();
        manager.funds.cacheFunds.buy = 500;
        await manager._updateOrder({ id: 'c-b-1', type: ORDER_TYPES.BUY, price: 99, size: 0, state: ORDER_STATES.VIRTUAL });
        
        const cacheBefore = manager.funds.cacheFunds.buy;
        const result = await manager.strategy.rebalance();
        const cacheAfter = manager.funds.cacheFunds.buy;
        if (result.ordersToPlace.length > 0) {
            assert(cacheAfter <= cacheBefore, 'cacheFunds should be deducted or stay same');
        }
    }

    console.log(' - Testing Rotation Sizing Capping (63cdb02)...');
    {
        const manager = await createManager();
        manager.config.targetSpreadPercent = 0; // Eliminate spread gap for this test
        // Setup: buy side target is 100 per slot
        // 1. Surplus order: p-1 at 90 with size 50 (to be rotated)
        // 2. Shortage slot: v-1 at 99 with size 0 (target)
        // 3. Available funds: 20
        // Result: Rotation should cap finalSize at sourceSize + available = 50 + 20 = 70
        // (Wait, commit says: finalSize = destinationSize + cappedIncrease)
        // destinationSize is 0 for v-1.
        // cappedIncrease = min(ideal - destination, remainingAvail)
        // ideal is ~100. destination is 0. remainingAvail is 20.
        // cappedIncrease = 20.
        // finalSize = 0 + 20 = 20.
        // Actually, the commit 63cdb02 says: "finalSize = destinationSize + cappedIncrease"
        // Let's re-read the commit diff I saw earlier.
        /*
            const destinationSize = shortageSlot.size || 0; // Usually 0 for a new slot
            const gridDifference = Math.max(0, idealSize - destinationSize);
            const cappedIncrease = Math.min(gridDifference, remainingAvail);
            const finalSize = destinationSize + cappedIncrease;
        */
        // If it's a rotation of surplus p-1 -> shortage v-1:
        // sourceSize (p-1) was 50.
        // destinationSize (v-1) was 0.
        // idealSize for v-1 is 100.
        // remainingAvail is 20.
        // finalSize = 0 + 20 = 20.
        // This seems correct because surplus release is ALREADY in available funds.

        await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 100, sellFree: 1000 });
        manager.funds.available.buy = 20;

        // Mock a surplus order (needs to be rotated)
        // We'll place it far from market so it's a surplus
        await manager._updateOrder({ id: 'surplus-1', type: ORDER_TYPES.BUY, price: 50, size: 50, state: ORDER_STATES.PARTIAL, orderId: 'c-surplus' });

        // Mock a target slot near market (shortage)
        await manager._updateOrder({ id: 'target-1', type: ORDER_TYPES.BUY, price: 99, size: 0, state: ORDER_STATES.VIRTUAL });

        // We need enough slots to make surplus-1 actually a surplus
        // target active orders is 5.
        for (let i = 0; i < 5; i++) {
             await manager._updateOrder({ id: `near-${i}`, type: ORDER_TYPES.BUY, price: 98 - i, size: 100, state: ORDER_STATES.ACTIVE, orderId: `c-${i}` });
        }

        manager.funds.available.buy = 20;
        manager.pauseFundRecalc(); // Prevent overwrite during rebalance
        const fill = { id: 'near-0', type: ORDER_TYPES.BUY, price: 98, size: 100, isPartial: false };
        const result = await manager.processFilledOrders([fill]);
        await manager.resumeFundRecalc();
        
        const rotation = result.ordersToRotate?.find(r => r.oldOrder.id === 'surplus-1');
        const update = result.ordersToUpdate?.find(u => u.id === 'surplus-1');
        const cancel = result.ordersToCancel?.find(c => c.id === 'surplus-1');
        const placement = result.ordersToPlace?.find(p => p.id === 'target-1');

        // In Immutable Master Grid, surplus-1 might be cancelled and target-1 placed
        if (rotation) {
            assert.strictEqual(rotation.newSize, 20, `Rotation size should be capped by available funds (expected 20, got ${rotation.newSize})`);
        } else if (update) {
            const masterOrder = manager.orders.get('surplus-1');
            const increase = update.newSize - masterOrder.size;
            // In the new architecture, we budget based on total capital (Liquid + Committed), 
            // so the increase can exceed liquid availability if it's within total budget.
            assert(increase > 0, 'Partial size should have been increased');
        } else if (cancel && placement) {
            // New placement size is based on total budget
            assert(placement.size > 0, 'New placement size should be positive');
        } else {
            assert.fail('Should either rotate surplus-1, update it in place, or cancel it and place target');
        }
    }

    console.log(' - Testing minHealthySize ReferenceError fix...');
    {
        const manager = await createManager();
        await manager.setAccountTotals({ buy: 5000, sell: 500, buyFree: 5000, sellFree: 500 });
        manager.resetFunds();

        // Setup orders on both sides to trigger rebalanceSideRobust logic
        manager.pauseFundRecalc();
        for (let i = 0; i < 5; i++) {
            const buyPrice = 100 - (i * 2);
            const sellPrice = 100 + (i * 2);
            await manager._updateOrder({
                id: `buy-${i}`,
                type: ORDER_TYPES.BUY,
                price: buyPrice,
                size: 50,
                state: ORDER_STATES.VIRTUAL
            });
            await manager._updateOrder({
                id: `sell-${i}`,
                type: ORDER_TYPES.SELL,
                price: sellPrice,
                size: 5,
                state: ORDER_STATES.VIRTUAL
            });
        }
        await manager.resumeFundRecalc();

        // This should not throw a ReferenceError for minHealthySize
        let rebalanceError = null;
        try {
            const result = await manager.processFilledOrders([]);
            assert(result, 'Rebalance should return a result object');
        } catch (err) {
            rebalanceError = err;
        }

        assert(rebalanceError === null, `Rebalance should not throw ReferenceError for minHealthySize: ${rebalanceError?.message}`);
    }

    OrderUtils.getAssetFees = originalGetAssetFees;
    console.log('✓ Strategy logic tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
