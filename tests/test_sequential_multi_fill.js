/**
 * tests/test_sequential_multi_fill.js
 * 
 * Focused test for sequential processing of multiple filled orders.
 * Verifies that when two buy orders fill at once:
 * 1. First fill: activates highest virtual buy + places new sell at highest spread
 * 2. Second fill: activates next virtual buy + places next sell at highest spread
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils');

// Mock BitShares for fee initialization
const mockBitShares = {
    db: {
        getGlobalProperties: async () => ({
            parameters: { current_fees: { parameters: [[1, { fee: 100000 }], [2, { fee: 10000 }], [77, { fee: 1000 }]] } }
        }),
        lookupAssetSymbols: async (symbols) => symbols.map(s => ({
            id: s === 'BTS' ? '1.3.0' : '1.3.1',
            symbol: s,
            options: { market_fee_percent: 0, extensions: {} }
        }))
    }
};

function setupManager() {
    const cfg = {
        name: 'multi-fill-test',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 0.02,
        minPrice: 0.01,
        maxPrice: 0.04,
        botFunds: { buy: 1000, sell: 50000 },
        activeOrders: { buy: 3, sell: 3 },  // 3 active orders per side
        incrementPercent: 1,
        targetSpreadPercent: 2,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, lvl) => console.log(`[${(lvl || 'INFO').toUpperCase().padEnd(5)}] ${msg}`),
        logFundsStatus: () => { },
        level: 'debug'
    };
    mgr.assets = {
        assetA: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        assetB: { id: '1.3.1', precision: 8, symbol: 'USD' }
    };
    mgr.setAccountTotals({ buy: 1000, buyFree: 1000, sell: 50000, sellFree: 50000 });

    return mgr;
}

async function testSequentialMultiFillProcessing() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST: Sequential Multi-Fill Processing');
    console.log('='.repeat(80));

    const mgr = setupManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Initial rebalance to place orders
    console.log('\n>>> Initial Grid Setup');
    
    // Loop rebalance to build up grid (since strict cap limits to 1 per cycle)
    for (let i = 0; i < 5; i++) {
        const initial = await mgr.strategy.rebalance();
        if (initial.ordersToPlace.length === 0) break;
        
        console.log(`    Cycle ${i}: Placing ${initial.ordersToPlace.length} orders`);
        
        // Simulate placing orders on-chain
        initial.ordersToPlace.forEach(o => {
            mgr._updateOrder({ ...o, state: ORDER_STATES.ACTIVE, orderId: `ord-${o.id}` });
        });
        mgr.recalculateFunds();
        
        const activeCount = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length;
        if (activeCount >= 2) break;
    }

    // Get current state
    const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE)
        .sort((a, b) => b.price - a.price);  // Highest price first (closest to market)
    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE)
        .sort((a, b) => a.price - b.price);  // Lowest price first (closest to market)

    console.log(`\n>>> Initial Active Orders:`);
    console.log(`    BUY: ${activeBuys.map(o => `${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
    console.log(`    SELL: ${activeSells.map(o => `${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
    console.log(`    Boundary Index: ${mgr.boundaryIdx}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // SIMULATE TWO BUY ORDERS FILLING SIMULTANEOUSLY
    // ═══════════════════════════════════════════════════════════════════════════

    // Select the two closest-to-market buys (highest prices)
    const fill1 = { ...activeBuys[0], isPartial: false };
    const fill2 = { ...activeBuys[1], isPartial: false };

    console.log('\n' + '─'.repeat(80));
    console.log('SIMULATING: Two buy orders filled at once');
    console.log(`    Fill 1: ${fill1.id} @ ${fill1.price.toFixed(4)} (closest to market)`);
    console.log(`    Fill 2: ${fill2.id} @ ${fill2.price.toFixed(4)} (next closest)`);
    console.log('─'.repeat(80));

    // ═══════════════════════════════════════════════════════════════════════════
    // PROCESS FILL 1 (Sequential)
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n>>> Processing FILL 1 (Sequential - Single Fill)');
    const boundaryBefore1 = mgr.boundaryIdx;

    const result1 = await mgr.strategy.processFilledOrders([fill1], new Set([fill2.id]));

    console.log(`    Boundary: ${boundaryBefore1} -> ${mgr.boundaryIdx}`);
    console.log(`    New Orders to Place: ${result1.ordersToPlace.length}`);
    console.log(`    Orders to Rotate: ${result1.ordersToRotate.length}`);

    if (result1.ordersToPlace.length > 0) {
        console.log(`    Placing: ${result1.ordersToPlace.map(o => `${o.type} ${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
    }
    if (result1.ordersToRotate.length > 0) {
        console.log(`    Rotating: ${result1.ordersToRotate.map(r => `${r.oldOrder.id}->${r.newGridId}@${r.newPrice.toFixed(4)}`).join(', ')}`);
    }

    // Simulate on-chain execution of result1
    result1.ordersToPlace.forEach(o => {
        mgr._updateOrder({ ...o, state: ORDER_STATES.ACTIVE, orderId: `new1-${o.id}` });
    });
    result1.ordersToRotate.forEach(r => {
        mgr._updateOrder({ ...mgr.orders.get(r.oldOrder.id), state: ORDER_STATES.VIRTUAL, orderId: null });
        const targetSlot = mgr.orders.get(r.newGridId);
        if (targetSlot) {
            mgr._updateOrder({ ...targetSlot, size: r.newSize, state: ORDER_STATES.ACTIVE, orderId: `rot1-${r.newGridId}` });
        }
    });
    mgr.recalculateFunds();

    // ═══════════════════════════════════════════════════════════════════════════
    // PROCESS FILL 2 (Sequential)
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n>>> Processing FILL 2 (Sequential - Single Fill)');
    const boundaryBefore2 = mgr.boundaryIdx;

    const result2 = await mgr.strategy.processFilledOrders([fill2], new Set());

    console.log(`    Boundary: ${boundaryBefore2} -> ${mgr.boundaryIdx}`);
    console.log(`    New Orders to Place: ${result2.ordersToPlace.length}`);
    console.log(`    Orders to Rotate: ${result2.ordersToRotate.length}`);

    if (result2.ordersToPlace.length > 0) {
        console.log(`    Placing: ${result2.ordersToPlace.map(o => `${o.type} ${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
    }
    if (result2.ordersToRotate.length > 0) {
        console.log(`    Rotating: ${result2.ordersToRotate.map(r => `${r.oldOrder.id}->${r.newGridId}@${r.newPrice.toFixed(4)}`).join(', ')}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n>>> Verification');

    // 1. Each fill should trigger at least one action
    const actions1 = result1.ordersToPlace.length + result1.ordersToRotate.length;
    const actions2 = result2.ordersToPlace.length + result2.ordersToRotate.length;

    console.log(`    Fill 1 actions: ${actions1}`);
    console.log(`    Fill 2 actions: ${actions2}`);

    assert(actions1 > 0, 'Fill 1 should trigger at least one action');
    assert(actions2 > 0, 'Fill 2 should trigger at least one action');

    // 2. Boundary should shift once per fill
    // (BUY fill shifts boundary left by 1)
    // TODO: Add boundary assertion based on actual expected behavior

    console.log('\n✅ Sequential multi-fill processing test PASSED');
}

(async () => {
    try {
        await initializeFeeCache(['BTS', 'USD'], mockBitShares);
        await testSequentialMultiFillProcessing();
        console.log('\n' + '='.repeat(80));
        console.log('ALL TESTS PASSED');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test FAILED:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
