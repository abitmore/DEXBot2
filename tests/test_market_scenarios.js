/**
 * tests/test_market_scenarios.js
 * 
 * Complex integration test simulating realistic market scenarios.
 * Focuses on StrategyEngine unified rebalancing logic.
 * UPDATED: Uses modern COW pipeline (performSafeRebalance).
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils/system');

// --- Mock Environment ---
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

async function setupScenarioManager(activeCount = 3) {
    const cfg = {
        name: 'scenario-bot', assetA: 'BTS', assetB: 'USD',
        startPrice: 0.02, minPrice: 0.01, maxPrice: 0.04,
        botFunds: { buy: 1000, sell: 50000 },
        activeOrders: { buy: activeCount, sell: activeCount },
        incrementPercent: 1, targetSpreadPercent: 2, weightDistribution: { buy: 0.5, sell: 0.5 }
    };
    const mgr = new OrderManager(cfg);
    mgr.logger = { 
        log: (msg, lvl) => { 
            if (lvl === 'error' || lvl === 'warn') console.log(`    [${lvl.toUpperCase()}] ${msg}`); 
        }, 
        logFundsStatus: () => {} 
    };
    mgr.assets = { 
        assetA: { id: '1.3.0', precision: 5, symbol: 'BTS' }, 
        assetB: { id: '1.3.1', precision: 8, symbol: 'USD' } 
    };
    await mgr.setAccountTotals({ buy: 1000, buyFree: 1000, sell: 50000, sellFree: 50000 });
    return mgr;
}

// --- Scenarios ---

async function runMarketPumpScenario() {
    console.log('\n📈 SCENARIO 1: Market Pump');
    const mgr = await setupScenarioManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Initial rebalance to place orders
    const res = await mgr.performSafeRebalance();
    const placements = res.actions.filter(a => a.type === 'create');
    for (const action of placements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `id-${action.id}` });
    }
    await mgr.recalculateFunds();

    console.log('  >>> Market PUMPS');
    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const fills = activeSells.slice(0, 2).map(o => ({ ...o, isPartial: false }));
    
    // Fills settled, then rebalance
    await mgr.strategy.processFillsOnly(fills);
    const result = await mgr.performSafeRebalance(fills);
    assert(result.actions.length > 0, 'Pump should trigger strategy actions');
    console.log('    ✓ Pump handled.');
}

async function runDumpAndPumpScenario() {
    console.log('\n📉 SCENARIO 2: Dump and Recovery');
    const mgr = await setupScenarioManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    const setup = await mgr.performSafeRebalance();
    const placements = setup.actions.filter(a => a.type === 'create');
    for (const action of placements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `init-${action.id}` });
    }
    await mgr.recalculateFunds();

    console.log('  >>> Flash DUMP');
    const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
    const dumpFills = activeBuys.map(o => ({ ...o, isPartial: false }));
    await mgr.strategy.processFillsOnly(dumpFills);
    await mgr.performSafeRebalance(dumpFills);
    
    console.log('  >>> Fast RECOVERY');
    const currentSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const recoveryFills = currentSells.slice(0, 1).map(o => ({ ...o, isPartial: false }));
    await mgr.strategy.processFillsOnly(recoveryFills);
    const recoveryResult = await mgr.performSafeRebalance(recoveryFills);
    assert(recoveryResult, 'Recovery rebalance should return result');
    console.log('    ✓ V-Shape handled.');
}

async function runStateLifecycleScenario() {
    console.log('\n🔄 SCENARIO 3: Single Slot Lifecycle (V->A->S->A)');
    const mgr = await setupScenarioManager(1);
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    const res1 = await mgr.performSafeRebalance();
    const targetAction = res1.actions.find(a => a.type === 'create' && a.order.type === ORDER_TYPES.SELL);
    const targetId = targetAction.id;
    
    const placements = res1.actions.filter(a => a.type === 'create');
    for (const action of placements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: 'L1' });
    }
    assert.strictEqual(mgr.orders.get(targetId).state, ORDER_STATES.ACTIVE);
    console.log('    ✓ ACTIVE');

    const fill = { ...mgr.orders.get(targetId), isPartial: false };
    await mgr.strategy.processFillsOnly([fill]);
    await mgr.performSafeRebalance([fill]);
    
    // Move window past it
    const sellSlots = Array.from(mgr.orders.values()).filter(o => o.id.startsWith('sell-')).sort((a,b) => a.price - b.price);
    await mgr._updateOrder({ ...sellSlots[10], state: ORDER_STATES.ACTIVE, orderId: 'force' });
    await mgr.performSafeRebalance();
    
    assert.strictEqual(mgr.orders.get(targetId).type, ORDER_TYPES.SPREAD);
    console.log('    ✓ SPREAD');

    await mgr._updateOrder({ ...sellSlots[10], state: ORDER_STATES.VIRTUAL, orderId: null });
    const res2 = await mgr.performSafeRebalance([{ type: ORDER_TYPES.SELL, price: targetAction.order.price * 0.99 }]);
    const placements2 = res2.actions.filter(a => a.type === 'create');
    for (const action of placements2) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: 'L2' });
    }
    
    assert.strictEqual(mgr.orders.get(targetId).state, ORDER_STATES.ACTIVE);
    console.log('    ✓ ACTIVE again');
}

async function runPartialHandlingScenario() {
    console.log('\n🧩 SCENARIO 4: Partial Order Handling');
    const mgr = await setupScenarioManager(2);
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Initial placement to get sizes into orders
    const initial = await mgr.performSafeRebalance();
    const initialPlacements = initial.actions.filter(a => a.type === 'create');
    for (const action of initialPlacements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `id-${action.id}` });
    }
    await mgr.recalculateFunds();

    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const idealSize = activeSells[0].size;
    const subId = activeSells[0].id;
    
    console.log(`  Ideal Size: ${idealSize.toFixed(5)}`);

    // 1. Substantial (Oversized)
    await mgr._updateOrder({ ...mgr.orders.get(subId), state: ORDER_STATES.PARTIAL, size: idealSize * 1.5, orderId: 'sub-1' });
    const resSub = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.019 }]);
    assert(resSub.actions.some(a => a.type === 'update' && a.id === subId), 'Oversized partial should be anchored down');
    console.log('    ✓ Substantial (oversized) correctly anchored.');

    // 2. Dust
    const dustId = activeSells[1].id;
    await mgr._updateOrder({ ...mgr.orders.get(dustId), state: ORDER_STATES.PARTIAL, size: idealSize * 0.01, orderId: 'dust-1' });
    
    // Inject available funds to allow merge
    mgr.accountTotals.sellFree += 1000;
    await mgr.recalculateFunds();
    
    await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.019 }]);
    
    // In COW, if dust is merged, sellSideIsDoubled is flagged if it was a dust PARTIAL resized up
    // However, calculateTargetGrid might just handle it as a regular slot
    assert(mgr.sellSideIsDoubled, 'Dust partial should flag sellSideIsDoubled');
    console.log('    ✓ Dust correctly merged.');
}

(async () => {
    try {
        await initializeFeeCache(['BTS', 'USD'], mockBitShares);
        await runMarketPumpScenario();
        await runDumpAndPumpScenario();
        await runStateLifecycleScenario();
        await runPartialHandlingScenario();
        console.log('\n' + '='.repeat(50) + '\n✅ ALL MARKET SCENARIOS PASSED\n' + '='.repeat(50));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Scenario test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
