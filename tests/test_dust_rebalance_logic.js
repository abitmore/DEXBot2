/**
 * tests/test_dust_rebalance_logic.js
 * 
 * Verifies the "Dual-side dust" rebalance trigger logic.
 * Ensures that rebalancing is only triggered when BOTH sides have dust partials,
 * or when there are actual fills to settle.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testDustTrigger() {
    console.log('Testing Dust Rebalance Trigger Logic...');

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    // Initialize with some funds
    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    // Mock logger to avoid spam
    manager.logger = {
        log: (msg, level) => {
            if (msg.includes('Triggering rebalance')) console.log(`      [${level}] ${msg}`);
        },
        logFundsStatus: () => {}
    };

    // 1. Scenario: No fills, no dust -> should NOT rebalance
    console.log('\n  Scenario 1: No fills, no dust');
    let result = await manager.processFilledOrders([]);
    assert.strictEqual(result.ordersToPlace.length, 0, 'Should not place orders');
    assert.strictEqual(result.ordersToRotate.length, 0, 'Should not rotate orders');
    console.log('  ✓ Correctly skipped rebalance');

    // 2. Scenario: No fills, single-side dust (BUY) -> should NOT rebalance
    console.log('\n  Scenario 2: Single-side dust (BUY)');
    const idealSize = 100; // estimated
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        size: 0.1, // very small
        price: 0.9,
        orderId: '1.7.1'
    });
    
    // We need to make sure hasAnyDust returns true.
    // hasAnyDust uses budget to calculate idealSize.
    
    result = await manager.processFilledOrders([]);
    assert.strictEqual(result.ordersToPlace.length, 0, 'Should still skip rebalance for single-side dust');
    console.log('  ✓ Correctly skipped rebalance for single-side dust');

    // 3. Scenario: No fills, dual-side dust -> SHOULD rebalance
    console.log('\n  Scenario 3: Dual-side dust');
    let rebalanceTriggered = false;
    manager.logger.log = (msg) => {
        if (msg.includes('Dual-side dust partials detected')) rebalanceTriggered = true;
    };

    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.1, // very small
        price: 1.1,
        orderId: '1.7.2'
    });

    result = await manager.processFilledOrders([]);
    assert.strictEqual(rebalanceTriggered, true, 'Should have triggered rebalance for dual-side dust');
    console.log('  ✓ Correctly triggered rebalance for dual-side dust');

    // 4. Scenario: Actual fill -> SHOULD rebalance regardless of dust
    console.log('\n  Scenario 4: Actual fill');
    rebalanceTriggered = false;
    manager.logger.log = (msg) => {
        if (msg.includes('Starting...')) rebalanceTriggered = true;
    };
    
    const fill = { id: 'buy-dust', type: ORDER_TYPES.BUY, price: 0.9, size: 0.1, isPartial: false };
    result = await manager.processFilledOrders([fill]);
    assert.strictEqual(rebalanceTriggered, true, 'Should have triggered rebalance for actual fill');
    console.log('  ✓ Correctly triggered rebalance for actual fill');
}

testDustTrigger().catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
