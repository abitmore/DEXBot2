/**
 * tests/test_grid_logic.js
 * 
 * Ported from tests/unit/grid.test.js
 * Comprehensive unit tests for grid.js - Order grid generation and sizing
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const Grid = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../modules/constants');

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

    console.log('✓ Grid logic tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
