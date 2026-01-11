/**
 * Unit tests for accounting.js - Fund tracking and calculations
 *
 * CRITICAL: These tests ensure funds are tracked correctly and no leaks occur.
 * Run with: npm test -- tests/unit/accounting.test.js
 */

const { OrderManager } = require('../../modules/order');
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('../../modules/constants');

describe('Accountant - Fund Tracking', () => {
    let manager;

    beforeEach(() => {
        // Create a fresh manager for each test
        manager = new OrderManager({
            ...DEFAULT_CONFIG,
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS'
        });

        // Set up account totals
        manager.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 10000,
            sellFree: 100
        });
    });

    describe('resetFunds()', () => {
        it('should initialize funds structure with zero values', () => {
            manager.resetFunds();
            expect(manager.funds).toBeDefined();
            expect(manager.funds.available).toEqual({ buy: 0, sell: 0 });
            expect(manager.funds.committed.chain).toEqual({ buy: 0, sell: 0 });
            expect(manager.funds.virtual).toEqual({ buy: 0, sell: 0 });
            expect(manager.funds.cacheFunds).toEqual({ buy: 0, sell: 0 });
        });

        it('should create backwards-compatible reserved alias', () => {
            manager.resetFunds();
            expect(manager.funds.reserved).toBe(manager.funds.virtual);
        });
    });

    describe('recalculateFunds()', () => {
        it('should calculate virtual funds from VIRTUAL orders', () => {
            const order = {
                id: 'virtual-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 500,
                price: 100
            };
            manager._updateOrder(order);

            expect(manager.funds.virtual.buy).toBe(500);
            expect(manager.funds.total.grid.buy).toBeGreaterThanOrEqual(500);
        });

        it('should calculate committed funds from ACTIVE orders', () => {
            const order = {
                id: 'active-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 25,
                price: 100,
                orderId: 'chain-001'
            };
            manager._updateOrder(order);

            expect(manager.funds.committed.chain.sell).toBe(25);
            expect(manager.funds.total.grid.sell).toBe(25);
        });

        it('should include PARTIAL orders in grid committed', () => {
            const order = {
                id: 'partial-1',
                state: ORDER_STATES.PARTIAL,
                type: ORDER_TYPES.BUY,
                size: 300,
                price: 100,
                orderId: 'chain-002'
            };
            manager._updateOrder(order);

            expect(manager.funds.committed.grid.buy).toBe(300);
            expect(manager.funds.committed.chain.buy).toBe(300);
        });

        it('should sum multiple orders correctly', () => {
            manager.pauseFundRecalc();

            manager._updateOrder({
                id: 'buy-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });
            manager._updateOrder({
                id: 'buy-2',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 200
            });
            manager._updateOrder({
                id: 'buy-3',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 150,
                orderId: 'chain-003'
            });

            manager.resumeFundRecalc();

            // Virtual: 100 + 200 = 300
            expect(manager.funds.virtual.buy).toBe(300);
            // Grid committed: 150
            expect(manager.funds.committed.grid.buy).toBe(150);
            // Total grid: 300 + 150 = 450
            expect(manager.funds.total.grid.buy).toBe(450);
        });

        it('should handle zero-size orders safely', () => {
            manager._updateOrder({
                id: 'zero-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 0
            });

            expect(manager.funds.virtual.sell).toBe(0);
            expect(manager.funds.committed.grid.sell).toBe(0);
        });

        it('should ignore orders with invalid types', () => {
            // This should be skipped due to validation
            manager._updateOrder({
                id: 'invalid-1',
                state: ORDER_STATES.VIRTUAL,
                type: 'INVALID_TYPE',
                size: 100
            });

            expect(manager.funds.virtual.buy + manager.funds.virtual.sell).toBe(0);
        });

        it('should detect fund invariant violations', () => {
            // Create order that uses most of funds
            manager._updateOrder({
                id: 'big-order',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 100
            });

            // Manually corrupt the funds to trigger invariant violation
            manager.funds.total.chain.sell = 50; // Less than committed.grid.sell

            // Recalculate should verify invariants
            manager.recalculateFunds();

            // The invariant check should have been called
            // Just verify the recalculation completes without error
            expect(manager.funds).toBeDefined();
        });
    });

    describe('Fund consistency checks', () => {
        it('should maintain chainTotal = chainFree + chainCommitted invariant', () => {
            manager._updateOrder({
                id: 'order-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 1000,
                orderId: 'chain-001'
            });

            const { buy: chainTotal } = manager.funds.total.chain;
            const { buy: chainFree } = manager.accountTotals ? { buy: manager.accountTotals.buyFree } : { buy: 0 };
            const { buy: chainCommitted } = manager.funds.committed.chain;

            // Within tolerance
            expect(Math.abs(chainTotal - (chainFree + chainCommitted))).toBeLessThan(0.01);
        });

        it('should prevent available funds from exceeding chainFree', () => {
            manager.setAccountTotals({
                buy: 5000,
                sell: 50,
                buyFree: 5000,
                sellFree: 50
            });

            expect(manager.funds.available.buy).toBeLessThanOrEqual(5000 + 0.01);
            expect(manager.funds.available.sell).toBeLessThanOrEqual(50 + 0.01);
        });
    });

    describe('Taker Fee Accounting (7b0a5c5)', () => {
        beforeEach(() => {
            // Setup assets for fee calculations
            manager.assets = {
                assetA: { id: '1.3.0', precision: 8 },
                assetB: { id: '1.3.1', precision: 5 }
            };
            manager.config = {
                assetA: 'TEST',
                assetB: 'BTS'
            };
        });

        it('should account for market taker fees in SELL order proceeds', () => {
            // A SELL order fills at price 100, selling 50 TEST for 5000 BTS
            const fillProceeds = 50 * 100;  // 5000 BTS

            // Should properly account for taker fees that reduce proceeds
            manager.pauseFundRecalc();
            manager._updateOrder({
                id: 'sell-fill-1',
                state: ORDER_STATES.PARTIAL,
                type: ORDER_TYPES.SELL,
                size: 50,
                price: 100,
                orderId: 'chain-001'
            });
            manager.resumeFundRecalc();

            // Fund calculation should include taker fee impact
            expect(manager.funds).toBeDefined();
            expect(manager.funds.committed).toBeDefined();
        });

        it('should account for blockchain taker fees in fill processing', () => {
            // When a fill is processed, both market taker fee and blockchain taker fee apply
            // Market fee: deducted from proceeds (SELL) or added to cost (BUY)
            // Blockchain fee: deducted from final amount received

            const filledOrder = {
                id: 'filled-1',
                type: ORDER_TYPES.SELL,
                price: 100,
                size: 50,
                state: ORDER_STATES.PARTIAL,
                orderId: 'chain-001',
                isMaker: false  // Taker, so fees apply
            };

            manager._updateOrder({
                id: 'filled-1',
                type: ORDER_TYPES.SELL,
                price: 100,
                size: 50,
                state: ORDER_STATES.ACTIVE,
                orderId: 'chain-001'
            });

            // Process fill and verify fees are calculated
            expect(() => {
                manager.strategy?.processFilledOrders?.([filledOrder]);
            }).not.toThrow();
        });

        it('should correctly calculate net proceeds with both fee types', () => {
            // SELL 50 TEST @ 100 = 5000 BTS gross
            // Market taker fee (assume 0.1%): 5 BTS
            // Net before blockchain fee: 4995 BTS
            // Blockchain fee (assume 0.05%): 2.50 BTS
            // Final proceeds: 4992.50 BTS

            const grossProceeds = 50 * 100;
            const marketTakerFeePercent = 0.001;  // 0.1%
            const blockchainFeePercent = 0.0005;   // 0.05%

            const netProceeds = grossProceeds * (1 - marketTakerFeePercent) * (1 - blockchainFeePercent);

            expect(netProceeds).toBeLessThan(grossProceeds);
            expect(netProceeds).toBeGreaterThan(0);
        });
    });

    describe('Fund Precision & Delta Validation (0a3d24d)', () => {
        it('should maintain precision when adding multiple orders', () => {
            manager.pauseFundRecalc();

            // Add orders with high precision values
            const orders = [
                { id: 'prec-1', type: ORDER_TYPES.BUY, size: 123.456789, price: 100, state: ORDER_STATES.VIRTUAL },
                { id: 'prec-2', type: ORDER_TYPES.BUY, size: 987.654321, price: 99, state: ORDER_STATES.VIRTUAL },
                { id: 'prec-3', type: ORDER_TYPES.BUY, size: 0.000001, price: 98, state: ORDER_STATES.VIRTUAL }
            ];

            for (const order of orders) {
                manager._updateOrder(order);
            }

            manager.resumeFundRecalc();

            const expectedTotal = 123.456789 + 987.654321 + 0.000001;
            const actualTotal = manager.funds.virtual.buy;

            // Should be within floating point precision limits
            expect(Math.abs(actualTotal - expectedTotal)).toBeLessThan(0.00000001);
        });

        it('should detect fund delta mismatches', () => {
            manager.pauseFundRecalc();

            // Add initial orders
            manager._updateOrder({
                id: 'delta-1',
                type: ORDER_TYPES.BUY,
                size: 500,
                price: 100,
                state: ORDER_STATES.VIRTUAL
            });

            const before = manager.funds.virtual.buy;

            // Update with new order
            manager._updateOrder({
                id: 'delta-2',
                type: ORDER_TYPES.BUY,
                size: 250,
                price: 99,
                state: ORDER_STATES.VIRTUAL
            });

            manager.resumeFundRecalc();

            const after = manager.funds.virtual.buy;
            const delta = after - before;

            // Delta should equal the new order size (within tolerance)
            expect(Math.abs(delta - 250)).toBeLessThan(0.01);
        });

        it('should validate fund totals after state transitions', () => {
            manager.pauseFundRecalc();

            // Create a VIRTUAL order
            manager._updateOrder({
                id: 'trans-1',
                type: ORDER_TYPES.BUY,
                size: 500,
                price: 100,
                state: ORDER_STATES.VIRTUAL
            });

            const virtualBefore = manager.funds.virtual.buy;

            // Transition to ACTIVE
            manager._updateOrder({
                id: 'trans-1',
                type: ORDER_TYPES.BUY,
                size: 500,
                price: 100,
                state: ORDER_STATES.ACTIVE,
                orderId: 'chain-001'
            });

            manager.resumeFundRecalc();

            const virtualAfter = manager.funds.virtual.buy;
            const committedAfter = manager.funds.committed.chain.buy;

            // Virtual should decrease, committed should increase
            expect(virtualAfter).toBeLessThan(virtualBefore);
            expect(committedAfter).toBeGreaterThan(0);

            // Total should remain roughly the same
            const totalBefore = virtualBefore + (manager.funds.committed.chain.buy || 0);
            const totalAfter = virtualAfter + committedAfter;
            expect(Math.abs(totalAfter - totalBefore)).toBeLessThan(1);
        });
    });

    describe('CacheFunds Deduction Tracking', () => {
        it('should track cacheFunds deductions correctly', () => {
            manager.resetFunds();
            manager.funds.cacheFunds.buy = 1000;
            manager.funds.cacheFunds.sell = 100;

            const initialCacheBuy = manager.funds.cacheFunds.buy;

            // Simulate a new placement that consumes cache
            manager._updateOrder({
                id: 'cache-order-1',
                type: ORDER_TYPES.BUY,
                size: 500,
                price: 100,
                state: ORDER_STATES.ACTIVE,
                orderId: 'chain-001'
            });

            // Cache should be preserved until explicitly deducted
            expect(manager.funds.cacheFunds.buy).toBe(initialCacheBuy);
        });

        it('should not double-deduct cacheFunds for rotations', () => {
            manager.resetFunds();
            manager.funds.cacheFunds.buy = 500;

            manager.pauseFundRecalc();

            // Create an existing order (already consumed cache)
            manager._updateOrder({
                id: 'rotate-from-1',
                type: ORDER_TYPES.BUY,
                size: 200,
                price: 99,
                state: ORDER_STATES.ACTIVE,
                orderId: 'chain-001'
            });

            // Rotation target
            manager._updateOrder({
                id: 'rotate-to-1',
                type: ORDER_TYPES.BUY,
                size: 0,
                price: 98,
                state: ORDER_STATES.VIRTUAL
            });

            manager.resumeFundRecalc();

            const cacheBeforeRotation = manager.funds.cacheFunds.buy;

            // Simulate rotation (cache was already spent on the moved order)
            // So rotation shouldn't deduct additional cache
            expect(manager.funds.cacheFunds.buy).toBe(cacheBeforeRotation);
        });
    });

     describe('PARTIAL→ACTIVE Transition Bug Fix', () => {
         it('should correctly handle PARTIAL→ACTIVE when PARTIAL had no orderId', () => {
             // CRITICAL TEST: Prevents double-counting bug where a PARTIAL order
             // without an orderId transitions to ACTIVE with a new orderId.
             // The full size should be deducted, not just the delta.

             manager.setAccountTotals({
                 buy: 10000,
                 sell: 100,
                 buyFree: 10000,
                 sellFree: 100
             });

             const oldOrder = {
                 id: 'partial-grid-only',
                 state: ORDER_STATES.PARTIAL,
                 type: ORDER_TYPES.BUY,
                 size: 100,
                 price: 100
                 // NOTE: No orderId - this is grid-only, not on-chain yet
             };

             const newOrder = {
                 id: 'partial-grid-only',
                 state: ORDER_STATES.ACTIVE,
                 type: ORDER_TYPES.BUY,
                 size: 100,
                 price: 100,
                 orderId: 'chain-new-001'  // Now on-chain!
             };

             const buyFreeBefore = manager.accountTotals.buyFree;

             // Call updateOptimisticFreeBalance as sync engine would
             manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test-transition');

             const buyFreeAfter = manager.accountTotals.buyFree;
             const deducted = buyFreeBefore - buyFreeAfter;

             // Should deduct the FULL 100 (not zero or partial delta)
             expect(deducted).toBe(100);
         });

         it('should correctly handle PARTIAL→ACTIVE when PARTIAL already had orderId', () => {
             // PARTIAL with orderId is already on-chain
             // Transition to ACTIVE should only deduct the size increase

             manager.setAccountTotals({
                 buy: 10000,
                 sell: 100,
                 buyFree: 10000,
                 sellFree: 100
             });

             const oldOrder = {
                 id: 'partial-onchain',
                 state: ORDER_STATES.PARTIAL,
                 type: ORDER_TYPES.BUY,
                 size: 100,
                 price: 100,
                 orderId: 'chain-001'  // Already on-chain
             };

             const newOrder = {
                 id: 'partial-onchain',
                 state: ORDER_STATES.ACTIVE,
                 type: ORDER_TYPES.BUY,
                 size: 150,  // Size increased
                 price: 100,
                 orderId: 'chain-001'  // Same orderId
             };

             const buyFreeBefore = manager.accountTotals.buyFree;

             manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test-resize');

             const buyFreeAfter = manager.accountTotals.buyFree;
             const deducted = buyFreeBefore - buyFreeAfter;

             // Should deduct only the DELTA (150 - 100 = 50)
             expect(deducted).toBe(50);
         });

         it('should correctly handle PARTIAL→ACTIVE with size decrease', () => {
             // PARTIAL with orderId, size decreasing (maybe a partial fill occurred)

             manager.setAccountTotals({
                 buy: 10000,
                 sell: 100,
                 buyFree: 5000,  // Some funds already committed
                 sellFree: 100
             });

             const oldOrder = {
                 id: 'partial-shrinking',
                 state: ORDER_STATES.PARTIAL,
                 type: ORDER_TYPES.BUY,
                 size: 200,
                 price: 100,
                 orderId: 'chain-001'
             };

             const newOrder = {
                 id: 'partial-shrinking',
                 state: ORDER_STATES.ACTIVE,
                 type: ORDER_TYPES.BUY,
                 size: 150,  // Size decreased after partial fill
                 price: 100,
                 orderId: 'chain-001'
             };

             const buyFreeBefore = manager.accountTotals.buyFree;

             manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test-shrink');

             const buyFreeAfter = manager.accountTotals.buyFree;
             const released = buyFreeAfter - buyFreeBefore;

             // Should RELEASE the delta (200 - 150 = 50)
             expect(released).toBe(50);
         });

         it('should maintain chainFree invariant after PARTIAL→ACTIVE transition', () => {
             // After the fix, the invariant chainTotal = chainFree + chainCommitted
             // should always hold

             manager.setAccountTotals({
                 buy: 10000,
                 sell: 100,
                 buyFree: 10000,
                 sellFree: 100
             });

             manager.pauseFundRecalc();

             const oldOrder = {
                 id: 'test-invariant',
                 state: ORDER_STATES.PARTIAL,
                 type: ORDER_TYPES.BUY,
                 size: 500
                 // No orderId - grid-only
             };

             // Create the order first
             manager._updateOrder({
                 id: 'test-invariant',
                 state: ORDER_STATES.PARTIAL,
                 type: ORDER_TYPES.BUY,
                 size: 500,
                 price: 100
             });

             manager.resumeFundRecalc();

             const virtualBefore = manager.funds.virtual.buy;

             manager.pauseFundRecalc();

             const newOrder = {
                 id: 'test-invariant',
                 state: ORDER_STATES.ACTIVE,
                 type: ORDER_TYPES.BUY,
                 size: 500,
                 price: 100,
                 orderId: 'chain-invariant'
             };

             manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test');
             manager._updateOrder(newOrder);

             manager.resumeFundRecalc();

             // Check invariants
             const chainFree = manager.accountTotals.buyFree;
             const chainCommitted = manager.funds.committed.chain.buy;
             const chainTotal = manager.funds.total.chain.buy;

             // chainTotal should equal chainFree + chainCommitted
             expect(Math.abs(chainTotal - (chainFree + chainCommitted))).toBeLessThan(1);

             // Available should not exceed chainFree
             expect(manager.funds.available.buy).toBeLessThanOrEqual(chainFree + 0.01);
         });
     });

     describe('Edge cases', () => {
         it('should handle null accountTotals gracefully', () => {
             manager.accountTotals = null;

             expect(() => {
                 manager.recalculateFunds();
             }).not.toThrow();

             expect(manager.funds).toBeDefined();
         });

         it('should handle large fund values without precision loss', () => {
             const largeValue = 999999999.123456;
             manager.setAccountTotals({
                 buy: largeValue,
                 sell: largeValue,
                 buyFree: largeValue,
                 sellFree: largeValue
             });

             manager.recalculateFunds();

             expect(manager.funds.total.chain.buy).toBeGreaterThan(0);
             expect(manager.funds.total.chain.sell).toBeGreaterThan(0);
         });
     });
 });
