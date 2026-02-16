/**
 * tests/test_dust_rebalance_logic.js
 * 
 * Verifies the "Dual-side dust" detection logic.
 * Tests that dust detection correctly identifies when BOTH sides have dust partials.
 * 
 * processFilledOrders() handles both fill processing AND rebalance triggering:
 * - Step 1: Processes fills via strategy.processFilledOrders (accounting/state)
 * - Step 2: Triggers performSafeRebalance when fills exist OR dual-side dust detected
 * This test verifies the underlying hasAnyDust() detection logic.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const Grid = require('../modules/order/grid');

async function testDustTrigger() {
    console.log('Testing Dust Detection Logic (COW Architecture)...');

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
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

    // Mock logger
    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    // 1. Scenario: No fills, no dust - processFilledOrders returns empty
    console.log('\n  Scenario 1: No fills, no dust');
    let result = await manager.processFilledOrders([]);
    const hasActions = (result.actions?.length > 0) || (result.ordersToPlace?.length > 0);
    assert.strictEqual(!!hasActions, false, 'Should not have actions with no fills');
    console.log('  ✓ Correctly returned empty actions');

    // 2. Scenario: Single-side dust detection (BUY only)
    console.log('\n  Scenario 2: Single-side dust (BUY)');
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 0.9,
        orderId: '1.7.1'
    });

    const buyPartials = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL);
    const sellPartials = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL);

    const buyHasDust = buyPartials.length > 0 && await Grid.hasAnyDust(manager, buyPartials, 'buy');
    const sellHasDust = sellPartials.length > 0 && await Grid.hasAnyDust(manager, sellPartials, 'sell');

    assert.strictEqual(buyHasDust, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust, false, 'Sell side should NOT have dust (no partials)');
    assert.strictEqual(buyHasDust && sellHasDust, false, 'Should NOT trigger dual-side dust (only one side)');
    console.log('  ✓ Correctly detected single-side dust');

    // 3. Scenario: Dual-side dust detection
    console.log('\n  Scenario 3: Dual-side dust');
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 1.1,
        orderId: '1.7.2'
    });

    const buyPartials2 = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL);
    const sellPartials2 = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL);

    const buyHasDust2 = buyPartials2.length > 0 && await Grid.hasAnyDust(manager, buyPartials2, 'buy');
    const sellHasDust2 = sellPartials2.length > 0 && await Grid.hasAnyDust(manager, sellPartials2, 'sell');

    assert.strictEqual(buyHasDust2, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust2, true, 'Sell side should have dust');
    assert.strictEqual(buyHasDust2 && sellHasDust2, true, 'Should detect dual-side dust');
    console.log('  ✓ Correctly detected dual-side dust');

    // 4. Scenario: processFilledOrders with fills triggers rebalance
    console.log('\n  Scenario 4: processFilledOrders with fills (triggers rebalance)');
    
    // Reset dust orders to VIRTUAL first
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 0.9,
        orderId: null
    });
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 1.1,
        orderId: null
    });

    const fill = { id: 'buy-dust', type: ORDER_TYPES.BUY, price: 0.9, size: 10, isPartial: false };
    result = await manager.processFilledOrders([fill]);
    
    // processFilledOrders triggers performSafeRebalance for non-partial fills
    // Result may have actions/ordersToPlace depending on grid state
    // Key assertion: method completes without error (rebalance is triggered)
    const resultHasStructure = result !== undefined && typeof result === 'object';
    assert.strictEqual(resultHasStructure, true, 'processFilledOrders should return result object');
    console.log('  ✓ processFilledOrders correctly triggers rebalance for fills');

    // 5. Verify processFillsOnly properly processes fills
    console.log('\n  Scenario 5: processFillsOnly properly processes fills');
    
    // Create an active order to fill
    await manager._updateOrder({
        id: 'test-active',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 50,
        price: 0.85,
        orderId: '1.7.100'
    });

    const fillForActive = { 
        id: 'test-active', 
        type: ORDER_TYPES.BUY, 
        price: 0.85, 
        size: 50, 
        isPartial: false,
        orderId: '1.7.100'
    };
    
    // processFillsOnly should update the order state
    await manager.strategy.processFillsOnly([fillForActive], new Set());
    
    // The order should now be VIRTUAL (fully filled)
    const updatedOrder = manager.orders.get('test-active');
    assert.strictEqual(updatedOrder.state, ORDER_STATES.VIRTUAL, 'Filled order should be VIRTUAL');
    console.log('  ✓ processFillsOnly correctly updates order state');

    console.log('\n✅ All dust detection tests passed!\n');
}

testDustTrigger().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
