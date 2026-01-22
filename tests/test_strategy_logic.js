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
const OrderUtils = require('../modules/order/utils');
const originalGetAssetFees = OrderUtils.getAssetFees;
OrderUtils.getAssetFees = (asset) => {
    if (asset === 'BTS') {
        return { total: 0.011, createFee: 0.1, updateFee: 0.001, makerNetFee: 0.01, takerNetFee: 0.1, netFee: 0.01, isMaker: true };
    }
    return 1.0;
};

async function runTests() {
    console.log('Running Strategy Logic Tests...');

    const createManager = () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 100, incrementPercent: 1, targetSpreadPercent: 2,
            activeOrders: { buy: 5, sell: 5 }, weightDistribution: { sell: 0.5, buy: 0.5 }
        });
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        mgr.resetFunds();
        return mgr;
    };

    console.log(' - Testing VIRTUAL Order Placement Capping (b913661)...');
    {
        const manager = createManager();
        const virtualOrders = [
            { id: 'v-b-1', type: ORDER_TYPES.BUY, price: 99, size: 500, state: ORDER_STATES.VIRTUAL },
            { id: 'v-s-1', type: ORDER_TYPES.SELL, price: 101, size: 50, state: ORDER_STATES.VIRTUAL }
        ];
        manager.pauseFundRecalc();
        virtualOrders.forEach(o => manager._updateOrder(o));
        manager.resumeFundRecalc();

        manager.funds.available.buy = 0;
        manager.funds.available.sell = 0;

        const result = await manager.strategy.rebalance();
        const placements = result.ordersToPlace.filter(o => virtualOrders.some(v => v.id === o.id));
        assert(placements.length > 0, 'Should have placements for VIRTUAL orders even if availablePool is 0');
        assert(placements[0].size > 0, 'Placement size should be greater than 0');
    }

    console.log(' - Testing PARTIAL Order Update (b913661)...');
    {
        const manager = createManager();
        manager._updateOrder({ id: 'p-d-1', type: ORDER_TYPES.BUY, price: 99, size: 5, state: ORDER_STATES.PARTIAL, orderId: 'c1' });
        manager._updateOrder({ id: 'v-1', type: ORDER_TYPES.BUY, price: 98, size: 0, state: ORDER_STATES.VIRTUAL });
        
        const result = await manager.strategy.rebalance();
        const dustUpdate = result.ordersToUpdate.find(u => u.partialOrder?.id === 'p-d-1');
        assert(dustUpdate !== undefined, 'Should update dust PARTIAL');
        assert(dustUpdate.newSize > 5, 'Should increase size from dust');
    }

    console.log(' - Testing Boundary Index Persistence (d17ece6)...');
    {
        const manager = createManager();
        manager.boundaryIdx = undefined;
        manager.pauseFundRecalc();
        for (let i = 0; i < 10; i++) {
            const price = 95 + (i * 1.0);
            manager._updateOrder({ id: `o-${i}`, type: price < 100 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, price, size: 100, state: ORDER_STATES.VIRTUAL });
        }
        manager.resumeFundRecalc();
        await manager.strategy.rebalance();
        assert(manager.boundaryIdx !== undefined, 'boundaryIdx should be initialized');
    }

    console.log(' - Testing BUY Side Weighting (d17ece6)...');
    {
        const manager = createManager();
        manager.pauseFundRecalc();
        manager._updateOrder({ id: 'b-far', type: ORDER_TYPES.BUY, price: 85, size: 0, state: ORDER_STATES.VIRTUAL });
        manager._updateOrder({ id: 'b-near', type: ORDER_TYPES.BUY, price: 99, size: 0, state: ORDER_STATES.VIRTUAL });
        manager.resumeFundRecalc();

        const result = await manager.strategy.rebalance();
        const near = result.ordersToPlace.find(p => p.id === 'b-near');
        const far = result.ordersToPlace.find(p => p.id === 'b-far');
        if (near && far) {
            assert(near.size >= far.size, 'Market-closest BUY should have more capital');
        }
    }

    console.log(' - Testing CacheFunds Integration (32d81ea)...');
    {
        const manager = createManager();
        manager.funds.cacheFunds.buy = 500;
        manager._updateOrder({ id: 'c-b-1', type: ORDER_TYPES.BUY, price: 99, size: 0, state: ORDER_STATES.VIRTUAL });
        
        const cacheBefore = manager.funds.cacheFunds.buy;
        const result = await manager.strategy.rebalance();
        const cacheAfter = manager.funds.cacheFunds.buy;
        if (result.ordersToPlace.length > 0) {
            assert(cacheAfter <= cacheBefore, 'cacheFunds should be deducted or stay same');
        }
    }

    OrderUtils.getAssetFees = originalGetAssetFees;
    console.log('✓ Strategy logic tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
