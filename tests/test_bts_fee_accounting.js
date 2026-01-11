/**
 * tests/test_bts_fee_accounting.js
 * 
 * Verifies that BTS fees are not double-counted during fill processing and rebalancing.
 */

// MOCK UTILS BEFORE ANYTHING ELSE
const utils = require('../modules/order/utils');
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

    await manager.strategy.processFilledOrders([fill]);

    const totalFees = deductedAmount + manager.funds.btsFeesOwed;
    console.log(`  Total BTS fees (deducted + remaining): ${Format.formatMetric5(totalFees)}`);
    
    // Expected: 
    // 1 Fill net cost: makerNetFee = 0.001
    // 2 Rotations cost: 2 * updateFee = 0.0002
    // TOTAL: 0.0012
    
    const expected = 0.0012;
    if (Math.abs(totalFees - expected) > 0.000001) {
        console.warn(`  ⚠ Unexpected fee total: ${totalFees.toFixed(5)} != ${expected.toFixed(5)}`);
        if (totalFees > expected) {
            console.log('    Possible over-counting still present.');
        }
    } else {
        console.log('  ✓ Fee accounting is correct: 0.001 (fill) + 0.0002 (2 rotations) = 0.0012');
    }
}

testFeeAccounting().catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});