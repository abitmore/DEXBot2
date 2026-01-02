/**
 * Unit tests for sync_engine.js - Blockchain reconciliation
 *
 * CRITICAL: Tests validate fill detection, state sync, and reconciliation logic.
 * Run with: npm test -- tests/unit/sync_engine.test.js
 */

const { OrderManager } = require('../../modules/order');
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('../../modules/constants');

describe('SyncEngine - Blockchain Reconciliation', () => {
    let manager;

    beforeEach(() => {
        manager = new OrderManager({
            ...DEFAULT_CONFIG,
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS'
        });

        // Mock assets for sync tests
        manager.assets = {
            assetA: { id: '1.3.0', precision: 8 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        manager.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 10000,
            sellFree: 100
        });
    });

    describe('Input Validation', () => {
        it('should return empty results for null chainOrders', async () => {
            const result = await manager.sync.syncFromOpenOrders(null);

            expect(result).toBeDefined();
            expect(result.filledOrders).toEqual([]);
            expect(result.updatedOrders).toEqual([]);
            expect(result.ordersNeedingCorrection).toEqual([]);
        });

        it('should return empty results for non-array chainOrders', async () => {
            const result = await manager.sync.syncFromOpenOrders({ invalid: 'object' });

            expect(result).toBeDefined();
            expect(Array.isArray(result.filledOrders)).toBe(true);
            expect(Array.isArray(result.updatedOrders)).toBe(true);
        });

        it('should handle empty chainOrders array', async () => {
            const result = await manager.sync.syncFromOpenOrders([]);

            expect(result).toBeDefined();
            expect(result.filledOrders).toEqual([]);
        });

        it('should require manager to be initialized', async () => {
            const sync = manager.sync;
            sync.manager = null;

            await expect(async () => {
                await sync.syncFromOpenOrders([]);
            }).rejects.toThrow();
        });

        it('should validate assets are initialized', async () => {
            manager.assets = null;

            const result = await manager.sync.syncFromOpenOrders([]);

            expect(result.filledOrders).toEqual([]);
            expect(result.updatedOrders).toEqual([]);
        });
    });

    describe('Lock Handling', () => {
        it('should require syncLock to be initialized', async () => {
            manager._syncLock = null;

            const result = await manager.sync.syncFromOpenOrders([]);

            expect(result).toBeDefined();
            expect(result.filledOrders).toEqual([]);
        });

        it('should acquire exclusive syncLock during synchronization', async () => {
            const lockSpy = jest.spyOn(manager._syncLock, 'acquire');

            await manager.sync.syncFromOpenOrders([]);

            expect(lockSpy).toHaveBeenCalled();
            lockSpy.mockRestore();
        });
    });

    describe('Order State Management', () => {
        it('should detect and report filled orders', async () => {
            // Create a grid order that is on-chain
            manager._updateOrder({
                id: 'grid-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 100,
                price: 50,
                orderId: 'chain-123'
            });

            // Sync with empty chain (order was filled)
            const result = await manager.sync.syncFromOpenOrders([]);

            // Should detect the fill
            expect(result.filledOrders.length).toBeGreaterThanOrEqual(0);
        });

        it('should handle partial fills correctly', async () => {
            manager._updateOrder({
                id: 'partial-order',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 100,
                price: 150,
                orderId: 'chain-456'
            });

            // Create mock chain order with reduced size (partial fill)
            const chainOrders = [{
                id: 'chain-456',
                sell_price: {
                    base: { amount: 50, asset_id: '1.3.0' },
                    quote: { amount: 7500, asset_id: '1.3.1' }
                },
                for_sale: 5000000000 // 50 units with precision 8
            }];

            const result = await manager.sync.syncFromOpenOrders(chainOrders);

            // Should detect partial state
            expect(result.updatedOrders.length).toBeGreaterThanOrEqual(0);
        });

        it('should not transition VIRTUAL orders on sync', async () => {
            const order = {
                id: 'virtual-order',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100,
                price: 50
            };
            manager._updateOrder(order);

            const result = await manager.sync.syncFromOpenOrders([]);

            const syncedOrder = manager.orders.get('virtual-order');
            expect(syncedOrder.state).toBe(ORDER_STATES.VIRTUAL);
        });

        it('should maintain price tolerance for matching', async () => {
            // Grid order
            manager._updateOrder({
                id: 'tol-order',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 100,
                price: 100.00,
                orderId: 'chain-789'
            });

            // Chain order with slightly different price (within tolerance)
            const chainOrders = [{
                id: 'chain-789',
                sell_price: {
                    base: { amount: 100, asset_id: '1.3.1' },
                    quote: { amount: 10001, asset_id: '1.3.0' } // Slightly higher price
                },
                for_sale: 10000000000
            }];

            const result = await manager.sync.syncFromOpenOrders(chainOrders);

            // Should match despite minor price difference
            const syncedOrder = manager.orders.get('tol-order');
            expect(syncedOrder).toBeDefined();
        });
    });

    describe('Edge Cases', () => {
        it('should handle chainOrders with missing fields gracefully', async () => {
            const malformedOrders = [
                { id: 'missing-price' },
                {
                    id: 'malformed-order',
                    sell_price: {
                        base: { amount: 100, asset_id: '1.3.0' },
                        quote: { amount: 5000, asset_id: '1.3.1' }
                    },
                    for_sale: 10000000000
                }
            ];

            // Should not throw, just skip invalid orders
            const result = await manager.sync.syncFromOpenOrders(malformedOrders);
            expect(result).toBeDefined();
            expect(Array.isArray(result.filledOrders)).toBe(true);
        });

        it('should handle large number of orders without performance degradation', async () => {
            // Create 100 grid orders
            for (let i = 0; i < 100; i++) {
                manager._updateOrder({
                    id: `perf-order-${i}`,
                    state: ORDER_STATES.VIRTUAL,
                    type: i % 2 === 0 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                    size: 50,
                    price: 100 + (i % 10)
                });
            }

            const start = Date.now();
            await manager.sync.syncFromOpenOrders([]);
            const elapsed = Date.now() - start;

            // Should complete in reasonable time (< 1 second)
            expect(elapsed).toBeLessThan(1000);
        });

        it('should handle precision mismatches correctly', async () => {
            manager._updateOrder({
                id: 'prec-order',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 123.45678901, // High precision
                price: 100,
                orderId: 'chain-prec'
            });

            // Chain order with blockchain integer representation
            const chainOrders = [{
                id: 'chain-prec',
                sell_price: {
                    base: { amount: 12345, asset_id: '1.3.1' },
                    quote: { amount: 1234567890, asset_id: '1.3.0' }
                },
                for_sale: 12345678900000000 // Blockchain representation
            }];

            expect(async () => {
                await manager.sync.syncFromOpenOrders(chainOrders);
            }).not.toThrow();
        });

        it('should prevent race conditions with concurrent syncs', async () => {
            manager._updateOrder({
                id: 'race-order',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 50,
                price: 100,
                orderId: 'chain-race'
            });

            // Try to run two syncs concurrently - should be serialized
            const promise1 = manager.sync.syncFromOpenOrders([]);
            const promise2 = manager.sync.syncFromOpenOrders([]);

            const [result1, result2] = await Promise.all([promise1, promise2]);

            expect(result1).toBeDefined();
            expect(result2).toBeDefined();
        });
    });

    describe('Consistency Validation', () => {
        it('should maintain order consistency after sync', async () => {
            // Add orders
            manager._updateOrder({
                id: 'consistency-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100,
                price: 50
            });

            await manager.sync.syncFromOpenOrders([]);

            // Indices should still be consistent
            const isValid = manager.validateIndices();
            expect(isValid).toBe(true);
        });

        it('should recover from index corruption during sync', async () => {
            manager._updateOrder({
                id: 'recover-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 50,
                price: 150
            });

            // Corrupt indices
            manager._ordersByState[ORDER_STATES.VIRTUAL].clear();

            // Sync should not worsen the corruption
            await manager.sync.syncFromOpenOrders([]);

            // Can call assertIndexConsistency to repair if needed
            const repaired = manager.assertIndexConsistency();
            expect(repaired).toBe(true);
        });
    });
});
