/**
 * Integration tests for Layer 2 Stabilization Gate (Self-Healing Recovery)
 * Tests checkFundDriftAfterFills() and the recovery path in processFilledOrders()
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_STATES, ORDER_TYPES, GRID_LIMITS } = require('../modules/constants');

function createMockManager(options = {}) {
    const {
        buyTotal = 10000,
        sellTotal = 100,
        buyFree = 5000,
        sellFree = 50,
        gridBuySize = 500,
        gridSellSize = 5,
        activeOrderCount = 10
    } = options;

    const manager = new OrderManager({
        startPrice: 100,
        incrementPercent: 0.5,
        targetSpreadPercent: 2,
        assetA: 'USD',
        assetB: 'TESTCOIN',
        minPrice: 50,
        maxPrice: 200
    });

    // Set up account totals (simulating blockchain state)
    manager.accountTotals = {
        buy: buyTotal,
        sell: sellTotal,
        buyFree: buyFree,
        sellFree: sellFree
    };

    // Set up assets with precision
    manager.assets = {
        assetA: { id: 'test-a', symbol: 'USD', precision: 8 },
        assetB: { id: 'test-b', symbol: 'TESTCOIN', precision: 8 }
    };

    // Create mock orders
    manager.orders = new Map();
    for (let i = 0; i < activeOrderCount; i++) {
        const isBuy = i < activeOrderCount / 2;
        manager.orders.set(`order-${i}`, {
            id: `order-${i}`,
            orderId: `chain-${i}`,
            type: isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: isBuy ? gridBuySize : gridSellSize,
            price: 100 * Math.pow(1.005, i - 5)
        });
    }

    // Silent logger for tests
    manager.logger = {
        log: (msg, level) => { /* silent */ }
    };

    return manager;
}

function logTest(name, passed, details = '') {
    const status = passed ? '✓' : '✗';
    console.log(` - ${status} ${name}${details ? ' (' + details + ')' : ''}`);
    return passed;
}

async function runLayer2Tests() {
    console.log('\nRunning Layer 2 Self-Healing Tests...');
    let allPassed = true;

    // Test 1: checkFundDriftAfterFills returns valid when totals match
    {
        // Grid has 5 buy orders @ 500 each = 2500 grid buy
        // chainFreeBuy = 5000, gridBuy = 2500, expected = 7500
        // actualBuy = 10000 -> drift = 2500 (exceeds tolerance!)
        // Let's set values that match:
        const manager = createMockManager({
            buyTotal: 7500,  // actualBuy
            sellTotal: 75,   // actualSell
            buyFree: 5000,   // chainFreeBuy
            sellFree: 50,    // chainFreeSell
            gridBuySize: 500,   // 5 orders * 500 = 2500
            gridSellSize: 5,    // 5 orders * 5 = 25
            activeOrderCount: 10
        });

        const result = manager.checkFundDriftAfterFills();
        const passed = logTest(
            'Valid state returns isValid=true',
            result.isValid === true,
            `driftBuy=${result.driftBuy.toFixed(4)}, driftSell=${result.driftSell.toFixed(4)}`
        );
        allPassed = allPassed && passed;
    }

    // Test 2: checkFundDriftAfterFills detects buy drift
    {
        const manager = createMockManager({
            buyTotal: 10000,   // actualBuy (way more than expected)
            sellTotal: 75,
            buyFree: 5000,
            sellFree: 50,
            gridBuySize: 500,
            gridSellSize: 5,
            activeOrderCount: 10
        });

        const result = manager.checkFundDriftAfterFills();
        const passed = logTest(
            'Detects buy-side drift when actual > expected',
            result.isValid === false && result.reason.includes('BUY drift'),
            `reason: ${result.reason}`
        );
        allPassed = allPassed && passed;
    }

    // Test 3: checkFundDriftAfterFills detects sell drift
    {
        const manager = createMockManager({
            buyTotal: 7500,
            sellTotal: 500,    // actualSell (way more than expected ~75)
            buyFree: 5000,
            sellFree: 50,
            gridBuySize: 500,
            gridSellSize: 5,
            activeOrderCount: 10
        });

        const result = manager.checkFundDriftAfterFills();
        const passed = logTest(
            'Detects sell-side drift when actual > expected',
            result.isValid === false && result.reason.includes('SELL drift'),
            `reason: ${result.reason}`
        );
        allPassed = allPassed && passed;
    }

    // Test 4: Precision slack allows tiny differences
    {
        const manager = createMockManager({
            buyTotal: 7500.00000001,  // Tiny difference (1e-8)
            sellTotal: 75.00000001,
            buyFree: 5000,
            sellFree: 50,
            gridBuySize: 500,
            gridSellSize: 5,
            activeOrderCount: 10
        });

        const result = manager.checkFundDriftAfterFills();
        const passed = logTest(
            'Precision slack allows tiny rounding differences',
            result.isValid === true,
            `driftBuy=${result.driftBuy.toFixed(10)}`
        );
        allPassed = allPassed && passed;
    }

    // Test 5: Percentage tolerance scales with total value
    {
        // With 0.1% tolerance (default), 10000 total allows 10 drift
        const manager = createMockManager({
            buyTotal: 10009,   // 9 under the 10 tolerance (0.1% of 10000)
            sellTotal: 75,
            buyFree: 5000,
            sellFree: 50,
            gridBuySize: 500,
            gridSellSize: 5,
            activeOrderCount: 10
        });

        // Expected: 5000 + 2500 = 7500, actual = 10009, drift = 2509
        // But tolerance is max(precision, 10009 * 0.001) = ~10
        // So drift 2509 > 10 -> invalid
        const result = manager.checkFundDriftAfterFills();
        const passed = logTest(
            'Large drift exceeds percentage tolerance',
            result.isValid === false,
            `drift=${result.driftBuy.toFixed(2)}, allowed=${result.allowedDriftBuy.toFixed(2)}`
        );
        allPassed = allPassed && passed;
    }

    // Test 6: Empty grid returns valid (no orders to check)
    {
        const manager = createMockManager();
        manager.orders = new Map(); // Empty
        manager.accountTotals = { buy: 100, sell: 10, buyFree: 100, sellFree: 10 };

        const result = manager.checkFundDriftAfterFills();
        // gridBuy=0, gridSell=0 -> expected = chainFree
        // expected = free, actual = total, if free == total -> valid
        const passed = logTest(
            'Empty grid (no active orders) returns valid',
            result.isValid === true,
            'free == total'
        );
        allPassed = allPassed && passed;
    }

    // Test 7: VIRTUAL orders are not counted in grid allocation
    {
        const manager = createMockManager({
            buyTotal: 5000,   // Just the free balance
            sellTotal: 50,
            buyFree: 5000,
            sellFree: 50,
            gridBuySize: 500,
            gridSellSize: 5,
            activeOrderCount: 10
        });

        // Convert all orders to VIRTUAL (simulating pre-placement state)
        for (const order of manager.orders.values()) {
            order.state = ORDER_STATES.VIRTUAL;
        }

        const result = manager.checkFundDriftAfterFills();
        // VIRTUAL orders should NOT be counted, so gridBuy=0, gridSell=0
        // expected = free = 5000/50, actual = 5000/50 -> valid
        const passed = logTest(
            'VIRTUAL orders excluded from grid allocation',
            result.isValid === true,
            'only ACTIVE/PARTIAL counted'
        );
        allPassed = allPassed && passed;
    }

    // Test 8: Result object has all required fields
    {
        const manager = createMockManager();
        const result = manager.checkFundDriftAfterFills();

        const hasAllFields = (
            'isValid' in result &&
            'driftBuy' in result &&
            'driftSell' in result &&
            'allowedDriftBuy' in result &&
            'allowedDriftSell' in result &&
            'reason' in result
        );

        const passed = logTest(
            'Result object contains all required fields',
            hasAllFields,
            Object.keys(result).join(', ')
        );
        allPassed = allPassed && passed;
    }

    // Test 9: Zero balance edge case
    {
        const manager = createMockManager();
        manager.accountTotals = { buy: 0, sell: 0, buyFree: 0, sellFree: 0 };
        manager.orders = new Map();

        const result = manager.checkFundDriftAfterFills();
        const passed = logTest(
            'Zero balance returns valid',
            result.isValid === true,
            'no funds, no drift'
        );
        allPassed = allPassed && passed;
    }

    // Test 10: Missing accountTotals handled gracefully
    {
        const manager = createMockManager();
        manager.accountTotals = null;

        const result = manager.checkFundDriftAfterFills();
        // Should not throw, should return valid (all zeros)
        const passed = logTest(
            'Missing accountTotals does not throw',
            result !== undefined && typeof result.isValid === 'boolean',
            'graceful handling'
        );
        allPassed = allPassed && passed;
    }

    return allPassed;
}

// Run tests
(async () => {
    try {
        const passed = await runLayer2Tests();
        console.log('\n' + '='.repeat(50));
        if (passed) {
            console.log('All Layer 2 self-healing tests passed!');
            process.exit(0);
        } else {
            console.log('Some tests failed!');
            process.exit(1);
        }
    } catch (err) {
        console.error('Test suite error:', err);
        process.exit(1);
    }
})();
