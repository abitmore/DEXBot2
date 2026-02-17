/**
 * tests/test_grid_logic.js
 * 
 * Ported from tests/unit/grid.test.js
 * Comprehensive unit tests for grid.js - Order grid generation and sizing
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const Grid = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, GRID_LIMITS } = require('../modules/constants');
const { OrderManager } = require('../modules/order/manager');
const { allocateFundsByWeights, getSingleDustThreshold } = require('../modules/order/utils/math');

async function runTests() {
    console.log('Running Grid Logic Tests...');

    console.log(' - Testing createOrderGrid() Basic Structure...');
    {
        const config = { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 1, targetSpreadPercent: 2 };
        const { orders, initialSpreadCount } = Grid.createOrderGrid(config);

        assert(orders !== undefined);
        assert(Array.isArray(orders));
        assert(orders.length > 0);

        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);
        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const spreadOrders = orders.filter(o => o.type === ORDER_TYPES.SPREAD);

        assert(buyOrders.length > 0);
        assert(sellOrders.length > 0);
        assert(spreadOrders.length > 0);
        assert.strictEqual(spreadOrders.length, initialSpreadCount.buy + initialSpreadCount.sell);
    }

    console.log(' - Testing Price Orientation...');
    {
        const config = { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 2, targetSpreadPercent: 4 };
        const { orders } = Grid.createOrderGrid(config);

        orders.forEach(o => {
            if (o.type === ORDER_TYPES.BUY) assert(o.price <= config.startPrice);
            if (o.type === ORDER_TYPES.SELL) assert(o.price >= config.startPrice);
            assert.strictEqual(o.state, ORDER_STATES.VIRTUAL);
        });
    }

    console.log(' - Testing Price Bounds...');
    {
        const config = { startPrice: 100, minPrice: 40, maxPrice: 160, incrementPercent: 5, targetSpreadPercent: 10 };
        const { orders } = Grid.createOrderGrid(config);

        orders.forEach(o => {
            if (o.type === ORDER_TYPES.BUY) {
                assert(o.price >= config.minPrice);
                assert(o.price <= config.startPrice);
            } else if (o.type === ORDER_TYPES.SELL) {
                assert(o.price >= config.startPrice);
                assert(o.price <= config.maxPrice);
            }
        });
    }

    console.log(' - Testing Increment Percent Validation...');
    {
        const invalidConfigs = [
            { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 0, targetSpreadPercent: 2 },
            { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 100, targetSpreadPercent: 2 },
            { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: -5, targetSpreadPercent: 2 }
        ];

        invalidConfigs.forEach(cfg => {
            assert.throws(() => Grid.createOrderGrid(cfg));
        });
    }

    console.log(' - Testing calculateGapSlots fallback uses DEFAULT_CONFIG.incrementPercent...');
    {
        const originalIncrement = DEFAULT_CONFIG.incrementPercent;
        try {
            DEFAULT_CONFIG.incrementPercent = 0.8;

            const gap = Grid.calculateGapSlots(undefined, 0);

            const step = 1 + (DEFAULT_CONFIG.incrementPercent / 100);
            const minSpreadPercent = DEFAULT_CONFIG.incrementPercent * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2.1);
            const requiredSteps = Math.ceil(Math.log(1 + (minSpreadPercent / 100)) / Math.log(step));
            const expected = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps - 1);

            assert.strictEqual(gap, expected, 'Gap slots should use DEFAULT_CONFIG.incrementPercent as fallback');
        } finally {
            DEFAULT_CONFIG.incrementPercent = originalIncrement;
        }
    }

    console.log(' - Testing minPrice validation and empty-grid protection...');
    {
        assert.throws(
            () => Grid.createOrderGrid({ startPrice: 100, minPrice: 0, maxPrice: 200, incrementPercent: 1, targetSpreadPercent: 2 }),
            /minPrice.*positive/i
        );

        assert.throws(
            () => Grid.createOrderGrid({ startPrice: 100, minPrice: 99.9, maxPrice: 100.1, incrementPercent: 1, targetSpreadPercent: 2 }),
            /produced no price levels/i
        );

        assert.throws(
            () => Grid.createOrderGrid({ startPrice: 100, minPrice: 99, maxPrice: 101, incrementPercent: 1, targetSpreadPercent: 2 }),
            /imbalanced rail/i
        );
    }

    console.log(' - Testing Geometric Progression...');
    {
        const config = { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 1, targetSpreadPercent: 2 };
        const { orders } = Grid.createOrderGrid(config);

        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => a.price - b.price);
        if (buyOrders.length > 1) {
            for (let i = 0; i < buyOrders.length - 1; i++) {
                const ratio = buyOrders[i + 1].price / buyOrders[i].price;
                // Ratio should be approx 1 + incrementPercent/100
                assert(Math.abs(ratio - 1.01) < 0.05);
            }
        }
    }

    console.log(' - Testing BUY dust threshold orientation consistency...');
    {
        const manager = new OrderManager({
            assetA: 'TESTA',
            assetB: 'TESTB',
            startPrice: 104,
            incrementPercent: 5,
            weightDistribution: { buy: 1, sell: 1 },
            botFunds: { buy: '100%', sell: '100%' },
            activeOrders: { buy: 6, sell: 6 }
        });

        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
        };
        await manager.setAccountTotals({ buy: 300, sell: 300, buyFree: 300, sellFree: 300 });

        const buyPrices = [98, 99, 100, 101, 102, 103];
        for (const price of buyPrices) {
            const i = buyPrices.indexOf(price);
            await manager._updateOrder({
                id: `b${i}`,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.VIRTUAL,
                size: 1,
                price
            });
        }

        const partialId = 'b5';
        const sideSlots = Array.from(manager.orders.values())
            .filter(o => o.type === ORDER_TYPES.BUY)
            .sort((a, b) => a.price - b.price);
        const ctx = await Grid.getSizingContext(manager, 'buy');
        const idealSizes = allocateFundsByWeights(
            ctx.budget,
            sideSlots.length,
            manager.config.weightDistribution.buy,
            manager.config.incrementPercent / 100,
            true,
            0,
            ctx.precision
        );
        const partialIdx = sideSlots.findIndex(s => s.id === partialId);
        const threshold = getSingleDustThreshold(idealSizes[partialIdx]);
        const partialSize = threshold * 0.95;

        await manager._updateOrder({
            ...manager.orders.get(partialId),
            state: ORDER_STATES.PARTIAL,
            size: partialSize,
            orderId: '1.7.555'
        });

        const partial = manager.orders.get(partialId);
        assert.strictEqual(await Grid.hasAnyDust(manager, [partial], 'buy'), true, 'BUY dust detection should match market-oriented geometric sizing');
    }

    console.log(' - Testing regeneration trigger uses cache and available funds...');
    {
        const mockManager = {
            config: {
                assetA: 'USD',
                assetB: 'EUR',
                activeOrders: { buy: 10, sell: 10 }
            },
            funds: {
                total: { grid: { buy: 100, sell: 100 } },
                cacheFunds: { buy: 4, sell: 0 },
                virtual: { buy: 0, sell: 0 },
                btsFeesOwed: 0
            },
            accountTotals: {
                buyFree: 0,
                sellFree: 0
            },
            _gridSidesUpdated: new Set(),
            getChainFundsSnapshot() {
                return {
                    allocatedBuy: 100,
                    allocatedSell: 100,
                    chainTotalBuy: 100,
                    chainTotalSell: 100
                };
            }
        };

        const fromCache = Grid.checkAndUpdateGridIfNeeded(mockManager);
        assert.strictEqual(fromCache.buyUpdated, true, 'Cache surplus above threshold should trigger buy-side update');

        mockManager.funds.cacheFunds.buy = 0;
        mockManager.accountTotals.buyFree = 4;
        const fromAvailable = Grid.checkAndUpdateGridIfNeeded(mockManager);
        assert.strictEqual(fromAvailable.buyUpdated, true, 'Available funds above threshold should also trigger buy-side update');

        mockManager.funds.cacheFunds.buy = 0;
        mockManager.accountTotals.buyFree = 0;
        const belowThreshold = Grid.checkAndUpdateGridIfNeeded(mockManager);
        assert.strictEqual(belowThreshold.buyUpdated, false, 'No surplus should not trigger update');
    }

    console.log('✓ Grid logic tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
