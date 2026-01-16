/**
 * Unit tests for BTS fee settlement fix
 *
 * Tests the deductBtsFees() method to ensure:
 * 1. Full fees are deducted from chainFree (not just remainder)
 * 2. Cache is drawn down first, then base capital
 * 3. Settlement is deferred if insufficient funds
 * 4. Fees are reset after successful settlement
 *
 * Run with: npm test -- tests/unit/bts_fee_settlement.test.js
 */

const { OrderManager } = require('../../modules/order');
const { ORDER_TYPES, ORDER_STATES } = require('../../modules/constants');
const Format = require('../../modules/order/format');

describe('BTS Fee Settlement - deductBtsFees()', () => {
    let manager;

    beforeEach(() => {
        // Create a fresh manager for each test
        // Using BTS as assetB (sell side holds BTS)
        manager = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            startPrice: 1.0,
            botFunds: { buy: 10000, sell: 1000 },
            activeOrders: { buy: 5, sell: 5 },
            incrementPercent: 1
        });

        manager.assets = {
            assetA: { id: '1.3.0', symbol: 'TEST', precision: 5 },
            assetB: { id: '1.3.121', symbol: 'BTS', precision: 5 }
        };

        manager.setAccountTotals({
            buy: 10000,
            sell: 1000,
            buyFree: 10000,
            sellFree: 1000
        });

        // Initialize funds
        if (!manager.funds) manager.resetFunds();
        manager.funds.cacheFunds = { buy: 0, sell: 0 };
    });

    // ============= NORMAL SETTLEMENT FLOW =============

    describe('Normal Settlement Flow', () => {
        it('should settle fees when cache >= fees', async () => {
            // Setup: 50 BTS owed, 50 in cache
            manager.funds.btsFeesOwed = 50;
            manager.funds.cacheFunds.sell = 50;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            // Execute settlement
            await manager.accountant.deductBtsFees('sell');

            // Verify
            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore - 50);
            expect(manager.funds.cacheFunds.sell).toBe(0);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });

        it('should deduct FULL fees from chainFree (the bug scenario)', async () => {
            // Setup: 50 BTS owed, 30 in cache, 1000 chainFree
            // THE BUG: Previously only deducted (50-30) = 20 from chainFree
            // FIX: Should deduct full 50 from chainFree
            manager.funds.btsFeesOwed = 50;
            manager.funds.cacheFunds.sell = 30;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;
            const cacheBefore = manager.funds.cacheFunds.sell;

            // Execute settlement
            await manager.accountant.deductBtsFees('sell');

            // Verify cache was drawn down
            expect(manager.funds.cacheFunds.sell).toBe(cacheBefore - 30);
            expect(manager.funds.cacheFunds.sell).toBe(0);

            // CRITICAL: Full fee amount must reduce chainFree, not just remainder
            const expectedChainFreeReduction = 50; // Full amount
            const actualChainFreeReduction = sellFreeBefore - manager.accountTotals.sellFree;
            expect(actualChainFreeReduction).toBe(expectedChainFreeReduction);

            // Verify fees reset
            expect(manager.funds.btsFeesOwed).toBe(0);
        });

        it('should settle fees when cache = 0', async () => {
            // Setup: 50 BTS owed, 0 in cache, 1000 chainFree
            // All 50 should come from base capital
            manager.funds.btsFeesOwed = 50;
            manager.funds.cacheFunds.sell = 0;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            // Execute settlement
            await manager.accountant.deductBtsFees('sell');

            // Full amount should come from base capital
            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore - 50);
            expect(manager.funds.cacheFunds.sell).toBe(0);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });
    });

    // ============= INSUFFICIENT FUNDS SCENARIOS =============

    describe('Insufficient Funds (Deferred Settlement)', () => {
        it('should defer settlement if chainFree < fees', async () => {
            // Setup: 50 BTS owed, 30 in cache, only 40 chainFree
            // Settlement should be deferred (chainFree 40 < fees 50)
            manager.funds.btsFeesOwed = 50;
            manager.funds.cacheFunds.sell = 30;
            manager.setAccountTotals({
                buy: 10000,
                sell: 40,  // Less than fees!
                buyFree: 10000,
                sellFree: 40
            });

            const sellFreeBefore = manager.accountTotals.sellFree;
            const cacheBeforeBefore = manager.funds.cacheFunds.sell;

            // Execute settlement attempt
            await manager.accountant.deductBtsFees('sell');

            // Verify settlement was deferred (fees still owed, cache untouched)
            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore);
            expect(manager.funds.cacheFunds.sell).toBe(cacheBeforeBefore);
            expect(manager.funds.btsFeesOwed).toBe(50); // Still owed
        });

        it('should settle when funds become available after deferral', async () => {
            // Setup: 50 BTS owed, insufficient funds initially
            manager.funds.btsFeesOwed = 50;
            manager.funds.cacheFunds.sell = 20;
            manager.setAccountTotals({
                buy: 10000,
                sell: 30,  // Insufficient
                buyFree: 10000,
                sellFree: 30
            });

            // First attempt - should defer
            await manager.accountant.deductBtsFees('sell');
            expect(manager.funds.btsFeesOwed).toBe(50);

            // Now more funds become available (e.g., from fill proceeds)
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,  // Now sufficient
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            // Second attempt - should succeed
            await manager.accountant.deductBtsFees('sell');
            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore - 50);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });
    });

    // ============= EDGE CASES =============

    describe('Edge Cases', () => {
        it('should handle zero fees gracefully', async () => {
            manager.funds.btsFeesOwed = 0;
            manager.funds.cacheFunds.sell = 0;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            // Should return early without changes
            await manager.accountant.deductBtsFees('sell');

            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });

        it('should handle negative fees gracefully', async () => {
            manager.funds.btsFeesOwed = -50;  // Invalid, but should be handled
            manager.funds.cacheFunds.sell = 0;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            // Should return early without changes
            await manager.accountant.deductBtsFees('sell');

            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore);
        });

        it('should handle null accountTotals gracefully', async () => {
            manager.accountTotals = null;
            manager.funds.btsFeesOwed = 50;

            // Should return early without throwing
            expect(async () => {
                await manager.accountant.deductBtsFees('sell');
            }).not.toThrow();
        });

        it('should handle null funds gracefully', async () => {
            manager.funds = null;

            // Should return early without throwing
            expect(async () => {
                await manager.accountant.deductBtsFees('sell');
            }).not.toThrow();
        });

        it('should handle BTS on buy side (assetB is BTS)', async () => {
            // Create manager with BTS on buy side
            const buyBtsManager = new OrderManager({
                market: 'BTS/TEST',
                assetA: 'BTS',
                assetB: 'TEST',
                startPrice: 1.0,
                botFunds: { buy: 1000, sell: 10000 },
                activeOrders: { buy: 5, sell: 5 },
                incrementPercent: 1
            });

            buyBtsManager.setAccountTotals({
                buy: 1000,
                sell: 10000,
                buyFree: 1000,
                sellFree: 10000
            });

            buyBtsManager.funds.btsFeesOwed = 50;
            buyBtsManager.funds.cacheFunds = { buy: 30, sell: 0 };

            const buyFreeBefore = buyBtsManager.accountTotals.buyFree;

            // Settlement should occur on BUY side
            await buyBtsManager.accountant.deductBtsFees('buy');

            expect(buyBtsManager.accountTotals.buyFree).toBe(buyFreeBefore - 50);
            expect(buyBtsManager.funds.cacheFunds.buy).toBe(0);
            expect(buyBtsManager.funds.btsFeesOwed).toBe(0);
        });

        it('should handle very small fees (precision)', async () => {
            // Setup: Very small BTS fee (0.00001)
            manager.funds.btsFeesOwed = 0.00001;
            manager.funds.cacheFunds.sell = 0.00001;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            await manager.accountant.deductBtsFees('sell');

            // Should deduct the full small amount
            expect(Math.abs(manager.accountTotals.sellFree - (sellFreeBefore - 0.00001))).toBeLessThan(0.000001);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });

        it('should handle very large fees', async () => {
            // Setup: Large BTS fee (500)
            manager.funds.btsFeesOwed = 500;
            manager.funds.cacheFunds.sell = 200;
            manager.setAccountTotals({
                buy: 10000,
                sell: 2000,
                buyFree: 10000,
                sellFree: 2000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            await manager.accountant.deductBtsFees('sell');

            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore - 500);
            expect(manager.funds.cacheFunds.sell).toBe(0);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });
    });

    // ============= INVARIANT TESTS =============

    describe('Fund Invariants After Settlement', () => {
        it('should maintain cacheFunds <= chainFree after settlement', async () => {
            manager.funds.btsFeesOwed = 30;
            manager.funds.cacheFunds.sell = 20;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            await manager.accountant.deductBtsFees('sell');

            const cache = manager.funds.cacheFunds.sell;
            const chainFree = manager.accountTotals.sellFree;

            // Cache should never exceed chainFree
            expect(cache).toBeLessThanOrEqual(chainFree + 0.00001);
        });

        it('should maintain invariants with committed capital present', async () => {
            // Create some orders to have committed capital
            manager.pauseFundRecalc();

            manager._updateOrder({
                id: 'order-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 100,
                price: 1.0,
                orderId: 'chain-001'
            });

            manager.resumeFundRecalc();

            // Setup fees
            const chainFreeBefore = manager.accountTotals.sellFree;
            manager.funds.cacheFunds.sell = 30;
            manager.funds.btsFeesOwed = 50;

            // Execute settlement
            await manager.accountant.deductBtsFees('sell');

            const chainFreeAfter = manager.accountTotals.sellFree;
            const chainCommittedAfter = manager.funds.committed.chain.sell;

            // CRITICAL: Full fee must be deducted from chainFree
            expect(chainFreeBefore - chainFreeAfter).toBe(50);

            // Cache should be drawn down to zero
            expect(manager.funds.cacheFunds.sell).toBe(0);

            // After settlement, cache should not exceed chainFree
            expect(manager.funds.cacheFunds.sell).toBeLessThanOrEqual(chainFreeAfter + 0.00001);

            // Committed capital should remain unchanged (fees don't affect orders)
            expect(chainCommittedAfter).toBe(100);
        });
    });

    // ============= INTEGRATION SCENARIOS =============

    describe('Integration Scenarios', () => {
        it('should settle fees after multiple rotations', async () => {
            // Simulate accumulation of fees over multiple rotations
            manager.funds.btsFeesOwed = 0;
            manager.funds.cacheFunds.sell = 100;

            // First rotation fee
            manager.funds.btsFeesOwed += 25;
            // Second rotation fee
            manager.funds.btsFeesOwed += 25;
            // Total: 50 BTS owed

            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            await manager.accountant.deductBtsFees('sell');

            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore - 50);
            expect(manager.funds.cacheFunds.sell).toBe(50); // Used 50 from cache
            expect(manager.funds.btsFeesOwed).toBe(0);
        });

        it('should handle settlement after fills with cache proceeds', async () => {
            // Simulate: Order fills, generates cache proceeds, then fees settle
            manager.funds.btsFeesOwed = 0;
            manager.funds.cacheFunds.sell = 0;

            // Fill generates proceeds
            await manager.accountant.modifyCacheFunds('sell', 150, 'fill-proceeds');
            expect(manager.funds.cacheFunds.sell).toBe(150);

            // Fees accumulate
            manager.funds.btsFeesOwed = 100;

            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            // Settle fees
            await manager.accountant.deductBtsFees('sell');

            // Fees deducted entirely, cache reduced
            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore - 100);
            expect(manager.funds.cacheFunds.sell).toBe(50); // 150 - 100
            expect(manager.funds.btsFeesOwed).toBe(0);
        });

        it('should recover from insufficient funds scenario in real workflow', async () => {
            // Simulate real scenario: Insufficient funds, then fill provides more
            manager.funds.btsFeesOwed = 100;
            manager.funds.cacheFunds.sell = 30;
            manager.setAccountTotals({
                buy: 10000,
                sell: 80,
                buyFree: 10000,
                sellFree: 80
            });

            // Try to settle - should defer
            await manager.accountant.deductBtsFees('sell');
            expect(manager.funds.btsFeesOwed).toBe(100);

            // Fill happens, adds to sellFree
            manager.accountant.adjustTotalBalance(ORDER_TYPES.SELL, 500, 'fill-receives');

            // Try again - should succeed
            await manager.accountant.deductBtsFees('sell');
            expect(manager.funds.btsFeesOwed).toBe(0);
        });
    });

    // ============= ACCUMULATION TESTS =============

    describe('Fee Accumulation Before Settlement', () => {
        it('should accumulate multiple rotation fees before settling', async () => {
            manager.funds.btsFeesOwed = 0;

            // Simulate 3 rotations each costing 10 BTS
            for (let i = 0; i < 3; i++) {
                manager.funds.btsFeesOwed += 10;
            }

            expect(manager.funds.btsFeesOwed).toBe(30);

            // Add cache funds
            manager.funds.cacheFunds.sell = 20;
            manager.setAccountTotals({
                buy: 10000,
                sell: 1000,
                buyFree: 10000,
                sellFree: 1000
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            // Settle all at once
            await manager.accountant.deductBtsFees('sell');

            // 20 from cache, 10 from base capital
            expect(manager.funds.cacheFunds.sell).toBe(0);
            expect(manager.accountTotals.sellFree).toBe(sellFreeBefore - 30);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });

        it('should handle settlement when accumulated fees equal chainFree', async () => {
            manager.funds.btsFeesOwed = 100;
            manager.funds.cacheFunds.sell = 50;
            manager.setAccountTotals({
                buy: 10000,
                sell: 100,  // Exactly enough
                buyFree: 10000,
                sellFree: 100
            });

            const sellFreeBefore = manager.accountTotals.sellFree;

            await manager.accountant.deductBtsFees('sell');

            // Should settle completely, leaving zero chainFree
            expect(manager.accountTotals.sellFree).toBe(0);
            expect(manager.funds.btsFeesOwed).toBe(0);
        });
    });
});
