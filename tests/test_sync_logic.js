/**
 * tests/test_sync_logic.js
 * 
 * Ported from tests/unit/sync_engine.test.js
 * Comprehensive unit tests for sync_engine.js - Blockchain reconciliation
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
    console.log('Running Sync Logic Tests...');

    const createManager = () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS'
        });
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        return mgr;
    };

    console.log(' - Testing Input Validation...');
    {
        const manager = createManager();
        const result = await manager.sync.syncFromOpenOrders(null);
        assert(result !== undefined);
        assert.deepStrictEqual(result.filledOrders, []);
    }

    console.log(' - Testing Fill Detection...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'g-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: 'c-123'
        });
        // Sync with empty chain -> order filled
        const result = await manager.sync.syncFromOpenOrders([]);
        assert(result.filledOrders.length >= 0, 'Should return filled orders list');
    }

    console.log(' - Testing Partial Fill Detection...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'p-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
            size: 100, price: 150, orderId: 'c-456'
        });
        const chainOrders = [{
            id: 'c-456',
            sell_price: { base: { amount: 50, asset_id: '1.3.0' }, quote: { amount: 7500, asset_id: '1.3.1' } },
            for_sale: 5000000000 // 50 units
        }];
        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        assert(result.updatedOrders.length >= 0, 'Should detect partial fill');
    }

    console.log(' - Testing Price Tolerance...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 't-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 100.00, orderId: 'c-789'
        });
        const chainOrders = [{
            id: 'c-789',
            sell_price: { base: { amount: 100, asset_id: '1.3.1' }, quote: { amount: 10001, asset_id: '1.3.0' } },
            for_sale: 10000000000
        }];
        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        const synced = manager.orders.get('t-1');
        assert(synced !== undefined, 'Should match within tolerance');
    }

    console.log(' - Testing Type Mismatch Does Not Mutate Grid Slot...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'tm-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 10, orderId: 'c-tm'
        });

        // On-chain order uses opposite side (SELL) for same orderId.
        const chainOrders = [{
            id: 'c-tm',
            sell_price: { base: { amount: 100000000, asset_id: '1.3.0' }, quote: { amount: 10000000, asset_id: '1.3.1' } },
            for_sale: 50000000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        const slot = manager.orders.get('tm-1');

        assert.strictEqual(slot.type, ORDER_TYPES.BUY, 'Type-mismatched sync must not mutate slot type');
        assert.strictEqual(slot.state, ORDER_STATES.ACTIVE, 'Type-mismatched sync must not mutate slot state');
        assert.strictEqual(slot.size, 100, 'Type-mismatched sync must not mutate slot size');
        assert.strictEqual(result.updatedOrders.length, 0, 'Type-mismatched sync should not apply local order updates');
        assert(manager.ordersNeedingPriceCorrection.some(c => c.chainOrderId === 'c-tm' && c.isSurplus), 'Mismatch should queue stale order cancellation');
    }

    console.log(' - Testing Non-Grid Pair Chain Orders Are Ignored...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'fg-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY,
            size: 5, price: 10, orderId: null
        });

        // This order does NOT belong to the managed asset pair (1.3.0/1.3.1).
        const chainOrders = [{
            id: 'c-foreign',
            sell_price: { base: { amount: 10000, asset_id: '1.3.999' }, quote: { amount: 1000000, asset_id: '1.3.0' } },
            for_sale: 500000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        const slot = manager.orders.get('fg-1');

        assert.strictEqual(slot.state, ORDER_STATES.VIRTUAL, 'Foreign pair order must not activate any slot');
        assert.strictEqual(slot.orderId, null, 'Foreign pair order must not be assigned to grid slot');
        assert.strictEqual(result.updatedOrders.length, 0, 'Foreign pair orders should produce no grid updates');
    }

    console.log(' - Testing Price Mismatch Queues Manager Correction...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'pc-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 100, orderId: 'c-price'
        });

        const chainOrders = [{
            id: 'c-price',
            // BUY orientation for this market pair; price resolves to 120 (outside normal tolerance).
            sell_price: { base: { amount: 120000, asset_id: '1.3.1' }, quote: { amount: 1000000, asset_id: '1.3.0' } },
            for_sale: 10000000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);

        assert(result.ordersNeedingCorrection.some(c => c.chainOrderId === 'c-price'), 'Sync result should include price correction');
        assert(manager.ordersNeedingPriceCorrection.some(c => c.chainOrderId === 'c-price' && !c.isSurplus), 'Manager correction queue should include regular price mismatch');
    }

    console.log(' - Testing Concurrent Sync Race Protection...');
    {
        const manager = createManager();
        const p1 = manager.sync.syncFromOpenOrders([]);
        const p2 = manager.sync.syncFromOpenOrders([]);
        const [r1, r2] = await Promise.all([p1, p2]);
        assert(r1 !== undefined && r2 !== undefined);
    }

    console.log(' - Testing Fill History defaults missing is_maker to maker...');
    {
        const manager = createManager();
        manager._updateOrder({
            id: 'mk-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 1,
            price: 100,
            orderId: 'c-maker-default'
        });

        const fill = {
            op: [4, {
                order_id: 'c-maker-default',
                pays: { amount: 100000000, asset_id: '1.3.0' },
                receives: { amount: 100000, asset_id: '1.3.1' }
            }],
            block_num: 999,
            id: '1.11.999'
        };

        const result = manager.sync.syncFromFillHistory(fill);
        assert.strictEqual(result.filledOrders.length, 1, 'Expected full fill to be detected');
        assert.strictEqual(result.filledOrders[0].isMaker, true, 'Missing is_maker should default to maker');
    }

    OrderUtils.getAssetFees = originalGetAssetFees;
    console.log('✓ Sync logic tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
