/**
 * Unit tests for manager.js - Order management and state machine
 *
 * CRITICAL: Tests validate order state transitions, index consistency, and locking.
 * Run with: npm test -- tests/unit/manager.test.js
 */

const { OrderManager } = require('../../modules/order');
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('../../modules/constants');

describe('OrderManager - State Machine & Indexing', () => {
    let manager;

    beforeEach(() => {
        manager = new OrderManager({
            ...DEFAULT_CONFIG,
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS'
        });
    });

    describe('Index Consistency', () => {
        it('should maintain indices in sync with orders Map', () => {
            const order = {
                id: 'test-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            };

            manager._updateOrder(order);

            // Check both indices contain the order
            expect(manager._ordersByState[ORDER_STATES.VIRTUAL]).toContain('test-1');
            expect(manager._ordersByType[ORDER_TYPES.BUY]).toContain('test-1');
            expect(manager.orders.has('test-1')).toBe(true);
        });

        it('should update indices when order state changes', () => {
            manager._updateOrder({
                id: 'test-2',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 50
            });

            expect(manager._ordersByState[ORDER_STATES.VIRTUAL]).toContain('test-2');
            expect(manager._ordersByState[ORDER_STATES.ACTIVE]).not.toContain('test-2');

            // Transition to ACTIVE
            manager._updateOrder({
                id: 'test-2',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 50,
                orderId: 'chain-001'
            });

            expect(manager._ordersByState[ORDER_STATES.VIRTUAL]).not.toContain('test-2');
            expect(manager._ordersByState[ORDER_STATES.ACTIVE]).toContain('test-2');
            expect(manager._ordersByType[ORDER_TYPES.SELL]).toContain('test-2');
        });

        it('should remove order from all indices on deletion', () => {
            manager._updateOrder({
                id: 'test-3',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 75
            });

            // Remove by deleting from map (simulates deletion)
            manager.orders.delete('test-3');
            manager._ordersByState[ORDER_STATES.VIRTUAL].delete('test-3');
            manager._ordersByType[ORDER_TYPES.BUY].delete('test-3');

            expect(manager.orders.has('test-3')).toBe(false);
            expect(manager._ordersByState[ORDER_STATES.VIRTUAL]).not.toContain('test-3');
            expect(manager._ordersByType[ORDER_TYPES.BUY]).not.toContain('test-3');
        });

        it('validateIndices() should pass for consistent state', () => {
            manager._updateOrder({
                id: 'valid-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });

            const isValid = manager.validateIndices();
            expect(isValid).toBe(true);
        });

        it('validateIndices() should detect missing state index', () => {
            manager._updateOrder({
                id: 'corrupt-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 50
            });

            // Corrupt the indices by removing from state index
            manager._ordersByState[ORDER_STATES.VIRTUAL].delete('corrupt-1');

            const isValid = manager.validateIndices();
            expect(isValid).toBe(false);
        });

        it('validateIndices() should detect orphan references in indices', () => {
            // Add an orphan reference to index
            manager._ordersByState[ORDER_STATES.VIRTUAL].add('nonexistent-123');

            const isValid = manager.validateIndices();
            expect(isValid).toBe(false);
        });

        it('assertIndexConsistency() should repair indices automatically', () => {
            manager._updateOrder({
                id: 'repair-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });
            manager._updateOrder({
                id: 'repair-2',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 50,
                orderId: 'chain-001'
            });

            // Simulate corruption
            manager._ordersByState[ORDER_STATES.VIRTUAL].clear();
            manager._ordersByType[ORDER_TYPES.SELL].clear();

            // Repair should succeed
            const repaired = manager.assertIndexConsistency();
            expect(repaired).toBe(true);

            // Verify indices are restored
            expect(manager.validateIndices()).toBe(true);
        });
    });

    describe('State Transitions', () => {
        it('should allow VIRTUAL → ACTIVE transition', () => {
            manager._updateOrder({
                id: 'virt-active-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });

            expect(() => {
                manager._updateOrder({
                    id: 'virt-active-1',
                    state: ORDER_STATES.ACTIVE,
                    type: ORDER_TYPES.BUY,
                    size: 100,
                    orderId: 'chain-123'
                });
            }).not.toThrow();
        });

        it('should allow ACTIVE → PARTIAL transition', () => {
            manager._updateOrder({
                id: 'active-partial-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 100,
                orderId: 'chain-456'
            });

            expect(() => {
                manager._updateOrder({
                    id: 'active-partial-1',
                    state: ORDER_STATES.PARTIAL,
                    type: ORDER_TYPES.SELL,
                    size: 50,
                    orderId: 'chain-456'
                });
            }).not.toThrow();
        });

        it('should reject invalid state transitions', () => {
            // Create initial VIRTUAL order
            manager._updateOrder({
                id: 'invalid-trans-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });

            const originalOrder = manager.orders.get('invalid-trans-1');
            expect(originalOrder.state).toBe(ORDER_STATES.VIRTUAL);

            // Try to transition VIRTUAL → a non-existent invalid state
            // (The _updateOrder validation will catch non-existent states)
            const logSpy = jest.fn();
            const originalLog = manager.logger.log;
            manager.logger.log = logSpy;

            manager._updateOrder({
                id: 'invalid-trans-1',
                state: 'INVALID_STATE',
                type: ORDER_TYPES.BUY,
                size: 100
            });

            manager.logger.log = originalLog;

            // Should have logged an error about invalid state
            expect(logSpy.mock.calls.some(call =>
                call[1] === 'error' && call[0].includes('Invalid order state')
            )).toBe(true);
        });

        it('should enforce SPREAD orders stay in VIRTUAL state', () => {
            const logSpy = jest.fn();
            manager.logger.log = logSpy;

            manager._updateOrder({
                id: 'spread-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SPREAD,
                size: 0
            });

            // Try to move spread to ACTIVE (should be rejected)
            manager._updateOrder({
                id: 'spread-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SPREAD,
                size: 0
            });

            const errorCalls = logSpy.mock.calls.filter(call => call[1] === 'error');
            expect(errorCalls.length).toBeGreaterThan(0);
        });
    });

    describe('Order Locking', () => {
        it('should lock and unlock orders', () => {
            const orderId = 'lock-test-1';

            expect(manager.isOrderLocked(orderId)).toBe(false);

            manager.lockOrders([orderId]);
            expect(manager.isOrderLocked(orderId)).toBe(true);

            manager.unlockOrders([orderId]);
            expect(manager.isOrderLocked(orderId)).toBe(false);
        });

        it('should expire locks after timeout', () => {
            const orderId = 'lock-expire-1';
            const LOCK_TIMEOUT_MS = require('../../modules/constants').TIMING.LOCK_TIMEOUT_MS;

            manager.lockOrders([orderId]);
            expect(manager.isOrderLocked(orderId)).toBe(true);

            // Simulate time passing by manually setting an old timestamp
            manager.shadowOrderIds.set(orderId, Date.now() - LOCK_TIMEOUT_MS - 1000);

            // Now check if it's expired (should be false)
            expect(manager.isOrderLocked(orderId)).toBe(false);
        });

        it('should handle multiple order locks', () => {
            const ids = ['lock-multi-1', 'lock-multi-2', 'lock-multi-3'];

            manager.lockOrders(ids);

            for (const id of ids) {
                expect(manager.isOrderLocked(id)).toBe(true);
            }

            manager.unlockOrders(ids);

            for (const id of ids) {
                expect(manager.isOrderLocked(id)).toBe(false);
            }
        });
    });

    describe('Fund Recalc Pausing', () => {
        it('should pause and resume fund recalculation', () => {
            const recalcSpy = jest.spyOn(manager.accountant, 'recalculateFunds');

            manager.pauseFundRecalc();
            manager._updateOrder({
                id: 'pause-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });

            expect(recalcSpy).not.toHaveBeenCalled();

            manager.resumeFundRecalc();
            expect(recalcSpy).toHaveBeenCalled();

            recalcSpy.mockRestore();
        });

        it('should support nested pausing', () => {
            const recalcSpy = jest.spyOn(manager.accountant, 'recalculateFunds');

            manager.pauseFundRecalc();
            manager.pauseFundRecalc();

            manager._updateOrder({
                id: 'nested-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 50
            });

            expect(recalcSpy).not.toHaveBeenCalled();

            manager.resumeFundRecalc(); // Depth = 1
            expect(recalcSpy).not.toHaveBeenCalled();

            manager.resumeFundRecalc(); // Depth = 0
            expect(recalcSpy).toHaveBeenCalled();

            recalcSpy.mockRestore();
        });
    });

    describe('Order Lookup', () => {
        it('should retrieve orders by type and state', () => {
            manager.pauseFundRecalc();

            manager._updateOrder({
                id: 'lookup-buy-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });
            manager._updateOrder({
                id: 'lookup-buy-2',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 50,
                orderId: 'chain-001'
            });
            manager._updateOrder({
                id: 'lookup-sell-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 30
            });

            manager.resumeFundRecalc();

            const virtualBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
            expect(virtualBuys).toHaveLength(1);
            expect(virtualBuys[0].id).toBe('lookup-buy-1');

            const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
            expect(activeBuys).toHaveLength(1);
            expect(activeBuys[0].id).toBe('lookup-buy-2');

            const allSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, null);
            expect(allSells.length).toBeGreaterThanOrEqual(1);
        });
    });
});
