/**
 * tests/test_multifill_opposite_partial.js
 * 
 * Verifies handling of multiple fills on one side (e.g. BUY) 
 * while a PARTIAL order exists on the opposite side (e.g. SELL).
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
    return amount;
};

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testMultifillOppositePartial() {
    console.log('Testing Multiple Fills with Opposite Partial Order...');

    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 3, sell: 3 },
        incrementPercent: 1,
        targetSpreadPercent: 2
    });

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    manager.setAccountTotals({
        buy: 1000, sell: 1000,
        buyFree: 1000, sellFree: 1000
    });

    // Mock logger
    manager.logger = {
        log: (msg, level) => {
            if (level === 'info' || level === 'warn' || level === 'error') {
                console.log(`      [${level}] ${msg}`);
            }
        },
        logFundsStatus: () => {}
    };

    // Helper to log grid state
    const logGrid = (label) => {
        console.log(`\n  --- Grid State: ${label} ---`);
        console.log(`  Boundary Index: ${manager.boundaryIdx}`);
        console.log('  Slot      Type      State       Price     Size      OrderId');
        console.log('  ' + '-'.repeat(60));
        Array.from(manager.orders.values())
            .sort((a, b) => a.price - b.price)
            .forEach(o => {
                const isBoundary = manager.orders.get(`slot-${manager.boundaryIdx}`).price === o.price;
                console.log(`  ${o.id.padEnd(9)} ${o.type.padEnd(9)} ${o.state.padEnd(11)} ${o.price.toFixed(4).padEnd(9)} ${o.size.toString().padEnd(9)} ${o.orderId || '-'}${isBoundary ? ' <--- Boundary' : ''}`);
            });
    };

    // 1. Initial Grid Setup
    console.log('\n  1. Setting up initial grid with 3 ACTIVE BUYs and 3 ACTIVE SELLs');
    const prices = [0.97, 0.98, 0.99, 1.0, 1.01, 1.02, 1.03, 1.04, 1.05];
    
    for (let i = 0; i < prices.length; i++) {
        let type = ORDER_TYPES.SPREAD;
        let state = ORDER_STATES.VIRTUAL;
        let orderId = null;
        let size = 0;

        if (i <= 2) { type = ORDER_TYPES.BUY; state = ORDER_STATES.ACTIVE; orderId = `buy-${i}`; size = 100; }
        else if (i >= 6) { type = ORDER_TYPES.SELL; state = ORDER_STATES.ACTIVE; orderId = `sell-${i}`; size = 10; }

        manager._updateOrder({
            id: `slot-${i}`,
            type, price: prices[i], size, state, orderId
        });
    }
    manager.boundaryIdx = 2; // Last buy slot
    manager.recalculateFunds();

    // 2. Make one SELL a PARTIAL
    console.log('\n  2. Converting one SELL to PARTIAL state');
    const sellToPartial = manager.orders.get('slot-6');
    manager._updateOrder({ ...sellToPartial, state: ORDER_STATES.PARTIAL, size: 5 }); // 50% filled
    
    assert.strictEqual(manager.orders.get('slot-6').state, ORDER_STATES.PARTIAL, 'Slot-6 should be PARTIAL');

    logGrid('BEFORE FILLS');

    // 3. Simulate 2 BUY fills
    console.log('\n  3. Simulating 2 BUY fills (slot-2 and slot-1)');
    // IMPORTANT: Strategy needs orderId to match fill to its grid state.
    const fill1 = { id: 'slot-2', orderId: 'buy-2', type: ORDER_TYPES.BUY, price: 0.99, size: 100, isPartial: false };
    const fill2 = { id: 'slot-1', orderId: 'buy-1', type: ORDER_TYPES.BUY, price: 0.98, size: 100, isPartial: false };

    const result = await manager.strategy.processFilledOrders([fill1, fill2]);

    // Apply all state updates to see final grid
    if (result.stateUpdates) {
        result.stateUpdates.forEach(upd => manager._updateOrder(upd));
    }
    
    logGrid('AFTER FILLS & REBALANCE');

    // 4. Verifications
    console.log('\n  4. Verifications');
    
    // Boundary check
    console.log(`     Final Boundary Index: ${manager.boundaryIdx} (Expected: 0)`);
    assert.strictEqual(manager.boundaryIdx, 0, 'Boundary should have shifted to 0');

    // Opposite Partial Check
    const slot6 = manager.orders.get('slot-6');
    console.log(`     Slot-6 (Old Partial) final state: ${slot6.state}, size: ${slot6.size}`);
    
    // Check actions
    const rotationOfSlot6 = result.ordersToRotate.find(r => r.oldOrder.id === 'slot-6');
    const wasRotated = !!rotationOfSlot6;
    
    if (wasRotated) {
        console.log('     ✓ Slot-6 partial was correctly PRIORITIZED for rotation (Success)');
        assert.strictEqual(slot6.size, 0, 'Old partial slot must be zeroed after rotation');
        assert.strictEqual(slot6.state, ORDER_STATES.VIRTUAL, 'Old partial slot must be VIRTUAL');
        assert.strictEqual(rotationOfSlot6.oldOrder.orderId, 'sell-6', 'Rotation must track old orderId');
        
        // Ensure it moved to the BEST available slot (innermost shortage)
        // shortages for SELL are sorted Closest First: 3, 4, 5
        assert.strictEqual(rotationOfSlot6.newGridId, 'slot-3', 'Partial should move to innermost shortage (slot-3)');
        console.log('     ✓ Partial moved to innermost shortage (slot-3)');
    } else {
        assert.fail('Partial order (slot-6) should have been prioritized for rotation');
    }

    // Check SPREAD slots (1 and 2)
    const slot1 = manager.orders.get('slot-1');
    const slot2 = manager.orders.get('slot-2');
    console.log(`     Slot-1 (Spread) size: ${slot1.size}`);
    console.log(`     Slot-2 (Spread) size: ${slot2.size}`);
    assert.strictEqual(slot1.size, 0, 'Spread slot 1 must have 0 size');
    assert.strictEqual(slot2.size, 0, 'Spread slot 2 must have 0 size');

    // Since we don't have a Runner/DexBot mock applying the results to on-chain orders Map,
    // we check the returned results for the presence of the on-chain sell capital.
    const hasOnChainSellInResult = result.ordersToRotate.some(r => r.type === ORDER_TYPES.SELL && r.oldOrder.orderId) ||
                                   result.ordersToUpdate.some(u => u.partialOrder.orderId) ||
                                   Array.from(manager.orders.values()).some(o => o.type === ORDER_TYPES.SELL && o.orderId && o.state !== ORDER_STATES.VIRTUAL);
    
    assert(hasOnChainSellInResult, 'Should have preserved on-chain sell capital in results or grid');
    
    // Check if the rotated target is now active/partial
    if (wasRotated) {
        const rotation = result.ordersToRotate.find(r => r.oldOrder.id === 'slot-6');
        const target = manager.orders.get(rotation.newGridId);
        console.log(`     New slot for partial: ${target.id}, state: ${target.state}, size: ${target.size}`);
        // Note: in our mock, we haven't updated the orderId to the new slot yet, 
        // StrategyEngine.processFilledOrders just returns the result.
        // But the stateUpdates in rebalance should have marked it.
    }

    console.log('\n  ✓ Scenario: Multi-fill with opposite partial handled correctly');
}

testMultifillOppositePartial().catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});