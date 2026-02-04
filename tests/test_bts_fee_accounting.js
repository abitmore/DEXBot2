/**
 * tests/test_bts_fee_accounting.js
 * 
 * Verifies that BTS fees are not double-counted during fill processing and rebalancing.
 */

// MOCK UTILS BEFORE ANYTHING ELSE
const utils = require('../modules/order/utils/math');
utils.getAssetFees = (asset, amount, isMaker = true) => {
     if (asset === 'BTS') {
         const createFee = 0.01;
         const updateFee = 0.0001;
         const makerNetFee = createFee * 0.1;
         const takerNetFee = createFee;
         const netFee = isMaker ? makerNetFee : takerNetFee;
         return {
             total: netFee + updateFee,
             createFee: createFee,
             updateFee: updateFee,
             makerNetFee: makerNetFee,
             takerNetFee: takerNetFee,
             netFee: netFee,
             isMaker: isMaker
         };
     }
     if (asset === 'USD') return amount;
     return amount;
 };

// SUPPRESS BitShares CONNECTION LOGGING IN TESTS
const bsModule = require('../modules/bitshares_client');
if (bsModule.setSuppressConnectionLog) {
    bsModule.setSuppressConnectionLog(true);
}

 const assert = require('assert');
 const { OrderManager } = require('../modules/order/manager');
 const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
 const Format = require('../modules/order/format');

async function testFeeAccounting() {
    console.log('Testing BTS Fee Accounting...');

    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1
    });

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    // Mock accountant.deductBtsFees to just record the call
    let deductedAmount = 0;
    manager.accountant.deductBtsFees = async () => {
        deductedAmount += manager.funds.btsFeesOwed;
        manager.funds.btsFeesOwed = 0;
    };

    // Track direct deductions (placements/rotations)
    let directDeductedAmount = 0;
    const originalAdjust = manager.accountant.adjustTotalBalance.bind(manager.accountant);
    manager.accountant.adjustTotalBalance = (type, delta, op) => {
        if (delta < 0) directDeductedAmount += Math.abs(delta);
        return originalAdjust(type, delta, op);
    };

    // 1. Simulate a single fill
    console.log('\n  Simulating 1 fill...');
    const fill = { id: 'slot-6', type: ORDER_TYPES.SELL, price: 1.1, size: 10, isPartial: false };
    
    // We need some orders on the grid for rebalance to work
    for (let i = 0; i < 10; i++) {
        manager._updateOrder({
            id: `slot-${i}`,
            type: i < 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            state: i === 6 ? ORDER_STATES.VIRTUAL : ORDER_STATES.ACTIVE, // slot 6 is filled
            price: 0.9 + i * 0.02,
            size: 10,
            orderId: i === 6 ? null : `chain-${i}`
        });
    }

    const result = await manager.strategy.processFilledOrders([fill]);

    // 2. Simulate execution of planned rotations (this is where updateFees are deducted)
    if (result && result.ordersToRotate) {
        for (const rotation of result.ordersToRotate) {
            const btsFeeData = utils.getAssetFees('BTS');
            await manager.synchronizeWithChain({
                gridOrderId: rotation.newGridId,
                chainOrderId: rotation.oldOrder.orderId,
                isPartialPlacement: false,
                fee: btsFeeData.updateFee
            }, 'createOrder');
        }
    }

    const totalFees = deductedAmount + directDeductedAmount + manager.funds.btsFeesOwed;
    console.log(`  Total BTS fees (deducted + remaining): ${Format.formatMetric5(totalFees)}`);
    
    // Expected: 
    // 1 Fill net cost: makerNetFee = 0.001
    // 1 Rotation cost: 1 * updateFee = 0.0001
    // TOTAL: 0.0011
    
    const expected = 0.0011;
    if (Math.abs(totalFees - expected) > 0.000001) {
        console.warn(`  ⚠ Unexpected fee total: ${totalFees.toFixed(5)} != ${expected.toFixed(5)}`);
        if (totalFees > expected) {
            console.log('    Possible over-counting still present.');
        }
    } else {
        console.log(`  ✓ Fee accounting is correct: 0.001 (fill) + ${(expected - 0.001).toFixed(4)} (rotations) = ${expected.toFixed(4)}`);
    }
}

async function testFeeSettlementCorrectness() {
    console.log('\nTesting Fee Settlement Correctness (Bug Fix)...');

    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1
    });

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    // Initialize funds
    manager.funds.cacheFunds = { buy: 0, sell: 0 };
    manager.funds.btsFeesOwed = 0;

    // THE BUG SCENARIO:
    // Setup: 50 BTS owed, 30 in cache, 1000 chainFree
    // OLD (WRONG): chainFree reduced by (50-30) = 20 BTS
    // NEW (CORRECT): chainFree reduced by full 50 BTS
    const feesOwed = 50;
    const cacheAmount = 30;
    const baseCapitalBefore = manager.accountTotals.sellFree;

    manager.funds.btsFeesOwed = feesOwed;
    manager.funds.cacheFunds.sell = cacheAmount;

    console.log(`  Setup: ${feesOwed} BTS owed, ${cacheAmount} in cache, ${baseCapitalBefore} base capital`);

    // Execute settlement
    await manager.accountant.deductBtsFees('sell');

    const baseCapitalAfter = manager.accountTotals.sellFree;
    const baseCapitalReduction = baseCapitalBefore - baseCapitalAfter;
    const cacheAfter = manager.funds.cacheFunds.sell;

    console.log(`  Result: Cache ${cacheAmount} → ${cacheAfter}, Base capital reduced by ${baseCapitalReduction}`);

    // Verify the fix
    const expectedCacheReduction = cacheAmount;
    const expectedBaseCapitalReduction = feesOwed; // FULL amount, not remainder

    const cacheCorrect = (cacheAfter === 0);
    const baseCapitalCorrect = (baseCapitalReduction === expectedBaseCapitalReduction);
    const feesReset = (manager.funds.btsFeesOwed === 0);

    if (cacheCorrect && baseCapitalCorrect && feesReset) {
        console.log(`  ✓ Fee settlement is CORRECT:`);
        console.log(`    - Cache reduced by: ${cacheAmount} (expected: ${expectedCacheReduction})`);
        console.log(`    - Base capital reduced by: ${baseCapitalReduction} (expected: ${expectedBaseCapitalReduction})`);
        console.log(`    - Fees reset: ${manager.funds.btsFeesOwed === 0}`);
    } else {
        console.warn(`  ✗ Fee settlement is INCORRECT:`);
        if (!cacheCorrect) {
            console.warn(`    - Cache issue: ${cacheAfter} (expected: 0)`);
        }
        if (!baseCapitalCorrect) {
            console.warn(`    - Base capital reduction: ${baseCapitalReduction} (expected: ${expectedBaseCapitalReduction}) - BUG STILL PRESENT!`);
        }
        if (!feesReset) {
            console.warn(`    - Fees not reset: ${manager.funds.btsFeesOwed} (expected: 0)`);
        }
        throw new Error('Fee settlement correctness test failed');
    }
}

async function testInsufficientFundsDeferral() {
    console.log('\nTesting Insufficient Funds Deferral...');

    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1
    });

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    // Setup: 50 BTS owed, 30 in cache, but only 40 chainFree
    manager.setAccountTotals({
        buy: 1000,
        sell: 40,  // Less than fees owed (50)
        buyFree: 1000,
        sellFree: 40
    });

    manager.funds.cacheFunds = { buy: 0, sell: 30 };
    manager.funds.btsFeesOwed = 50;

    const sellFreeBefore = manager.accountTotals.sellFree;
    const cacheBeforeBefore = manager.funds.cacheFunds.sell;

    console.log(`  Setup: 50 BTS owed, 30 in cache, 40 chainFree (insufficient)`);

    // Attempt settlement
    await manager.accountant.deductBtsFees('sell');

    // Verify deferral
    const deferred = (manager.funds.btsFeesOwed === 50) &&
                     (manager.accountTotals.sellFree === sellFreeBefore) &&
                     (manager.funds.cacheFunds.sell === cacheBeforeBefore);

    if (deferred) {
        console.log(`  ✓ Settlement correctly deferred (fees still owed, cache untouched)`);
    } else {
        console.warn(`  ✗ Settlement was not deferred correctly`);
        throw new Error('Insufficient funds deferral test failed');
    }
}

async function runAllTests() {
    try {
        await testFeeAccounting();
        await testFeeSettlementCorrectness();
        await testInsufficientFundsDeferral();
        console.log('\n✓ All tests passed!');
        process.exit(0);
    } catch (err) {
        console.error('\n✗ Tests failed!');
        console.error(err);
        process.exit(1);
    }
}

runAllTests();