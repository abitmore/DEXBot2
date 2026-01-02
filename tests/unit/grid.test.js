/**
 * Unit tests for grid.js - Order grid generation and sizing
 *
 * CRITICAL: Tests validate grid algorithm, order sizing, and price levels.
 * Run with: npm test -- tests/unit/grid.test.js
 */

const Grid = require('../../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../../modules/constants');

describe('Grid - Order Grid Generation', () => {
    describe('createOrderGrid() - Basic Structure', () => {
        it('should create grid with correct spread orders', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 1,
                targetSpreadPercent: 2
            };

            const { orders, initialSpreadCount } = Grid.createOrderGrid(config);

            expect(orders).toBeDefined();
            expect(Array.isArray(orders)).toBe(true);
            expect(orders.length).toBeGreaterThan(0);

            // Should have buy and sell orders
            const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);
            const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
            const spreadOrders = orders.filter(o => o.type === ORDER_TYPES.SPREAD);

            expect(buyOrders.length).toBeGreaterThan(0);
            expect(sellOrders.length).toBeGreaterThan(0);
            expect(spreadOrders.length).toBeGreaterThan(0);
        });

        it('should validate increment percent bounds', () => {
            const invalidConfigs = [
                { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 0, targetSpreadPercent: 2 },
                { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 100, targetSpreadPercent: 2 },
                { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: -5, targetSpreadPercent: 2 }
            ];

            for (const config of invalidConfigs) {
                expect(() => {
                    Grid.createOrderGrid(config);
                }).toThrow();
            }
        });

        it('should place buys below market and sells above market', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 2,
                targetSpreadPercent: 4
            };

            const { orders } = Grid.createOrderGrid(config);

            const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);
            const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);

            // All buys should be below market
            for (const buy of buyOrders) {
                expect(buy.price).toBeLessThanOrEqual(config.startPrice);
            }

            // All sells should be above market
            for (const sell of sellOrders) {
                expect(sell.price).toBeGreaterThanOrEqual(config.startPrice);
            }
        });

        it('should respect min/max price bounds', () => {
            const config = {
                startPrice: 100,
                minPrice: 40,
                maxPrice: 160,
                incrementPercent: 5,
                targetSpreadPercent: 10
            };

            const { orders } = Grid.createOrderGrid(config);

            for (const order of orders) {
                if (order.type === ORDER_TYPES.BUY) {
                    expect(order.price).toBeGreaterThanOrEqual(config.minPrice);
                    expect(order.price).toBeLessThanOrEqual(config.startPrice);
                } else if (order.type === ORDER_TYPES.SELL) {
                    expect(order.price).toBeGreaterThanOrEqual(config.startPrice);
                    expect(order.price).toBeLessThanOrEqual(config.maxPrice);
                }
            }
        });

        it('should initialize all orders in VIRTUAL state', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 1,
                targetSpreadPercent: 2
            };

            const { orders } = Grid.createOrderGrid(config);

            for (const order of orders) {
                expect(order.state).toBe(ORDER_STATES.VIRTUAL);
            }
        });

        it('should assign spread type to orders near market price', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 1,
                targetSpreadPercent: 5
            };

            const { orders, initialSpreadCount } = Grid.createOrderGrid(config);

            const spreadOrders = orders.filter(o => o.type === ORDER_TYPES.SPREAD);
            expect(spreadOrders.length).toBeGreaterThanOrEqual(initialSpreadCount.buy + initialSpreadCount.sell);

            // Spread orders should be closest to market price
            for (const spread of spreadOrders) {
                const distanceFromMarket = Math.abs(spread.price - config.startPrice);
                expect(distanceFromMarket).toBeLessThanOrEqual(config.startPrice * (config.targetSpreadPercent / 100) + 1);
            }
        });
    });

    describe('createOrderGrid() - Order Sizing', () => {
        it('should create orders with valid structure', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 2,
                targetSpreadPercent: 4
            };

            const { orders } = Grid.createOrderGrid(config);

            // All orders should have required fields
            for (const order of orders) {
                expect(order.id).toBeDefined();
                expect(order.price).toBeGreaterThan(0);
                expect(Number.isFinite(order.price)).toBe(true);
                expect(order.state).toBe(ORDER_STATES.VIRTUAL);
                expect([ORDER_TYPES.BUY, ORDER_TYPES.SELL, ORDER_TYPES.SPREAD]).toContain(order.type);
            }
        });

        it('should include spread orders in the grid', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 2,
                targetSpreadPercent: 4
            };

            const { orders, initialSpreadCount } = Grid.createOrderGrid(config);

            const spreadOrders = orders.filter(o => o.type === ORDER_TYPES.SPREAD);
            expect(spreadOrders.length).toBeGreaterThan(0);
            expect(initialSpreadCount.buy + initialSpreadCount.sell).toEqual(spreadOrders.length);
        });
    });

    describe('createOrderGrid() - Precision', () => {
        it('should handle geometric progression correctly', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 1,
                targetSpreadPercent: 2
            };

            const { orders } = Grid.createOrderGrid(config);

            // Orders should follow geometric progression
            // For buy: each next order should be ~1% lower
            const buyOrders = orders
                .filter(o => o.type === ORDER_TYPES.BUY)
                .sort((a, b) => a.price - b.price);

            if (buyOrders.length > 1) {
                for (let i = 0; i < buyOrders.length - 1; i++) {
                    const ratio = buyOrders[i + 1].price / buyOrders[i].price;
                    // Should be approximately 1.01 for 1% increment
                    expect(ratio).toBeCloseTo(1.01, 1);
                }
            }
        });
    });

    describe('Edge Cases', () => {
        it('should handle very small increment percent', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 0.1,
                targetSpreadPercent: 1
            };

            expect(() => {
                const { orders } = Grid.createOrderGrid(config);
                expect(orders.length).toBeGreaterThan(0);
            }).not.toThrow();
        });

        it('should handle very large increment percent', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 50,
                targetSpreadPercent: 10
            };

            expect(() => {
                const { orders } = Grid.createOrderGrid(config);
                expect(orders.length).toBeGreaterThan(0);
            }).not.toThrow();
        });

        it('should handle narrow price range', () => {
            const config = {
                startPrice: 100,
                minPrice: 99,
                maxPrice: 101,
                incrementPercent: 1,
                targetSpreadPercent: 2
            };

            expect(() => {
                const { orders } = Grid.createOrderGrid(config);
                // Should have at least some orders
                expect(orders.length).toBeGreaterThan(0);
            }).not.toThrow();
        });

        it('should enforce minimum spread orders even with small targetSpread', () => {
            const config = {
                startPrice: 100,
                minPrice: 50,
                maxPrice: 200,
                incrementPercent: 1,
                targetSpreadPercent: 0.01 // Very small spread
            };

            const { orders, initialSpreadCount } = Grid.createOrderGrid(config);

            const spreadOrders = orders.filter(o => o.type === ORDER_TYPES.SPREAD);
            // Should have at least MIN_SPREAD_ORDERS minimum
            expect(initialSpreadCount.buy + initialSpreadCount.sell).toBeGreaterThanOrEqual(GRID_LIMITS.MIN_SPREAD_ORDERS);
        });
    });
});
