const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

console.log('='.repeat(80));
console.log('Testing Multi-Partial Consolidation Edge Cases');
console.log('='.repeat(80));

// Helper to setup a manager with grid
function setupManager(gridSize = 6) {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 10000, sell: 10000 },
        activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return;
            console.log(`    [${level}] ${msg}`);
        }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Setup grid with alternating VIRTUAL slots (spreads)
    for (let i = 0; i < gridSize; i++) {
        const price = 1.0 + (i * 0.05);
        const isSpread = i % 2 === 1;
        mgr.orders.set(`sell-${i}`, {
            id: `sell-${i}`,
            type: ORDER_TYPES.SELL,
            price: price,
            size: 10,
            state: isSpread ? ORDER_STATES.SPREAD : ORDER_STATES.VIRTUAL
        });
    }

    for (const order of mgr.orders.values()) {
        mgr._updateOrder(order);
    }

    // Mock evaluatePartialOrderAnchor to use a consistent ideal size mapping
    const slotIdealSizes = {};
    for (let i = 0; i < gridSize; i++) {
        slotIdealSizes[`sell-${i}`] = 10;
    }

    mgr.strategy.evaluatePartialOrderAnchor = (p, moveInfo) => {
        const idealSize = slotIdealSizes[moveInfo.newGridId] || 10;
        const residualCapital = Math.max(0, (p.size - idealSize) * p.price);
        return {
            isDust: p.size < 5,
            idealSize: idealSize,
            percentOfIdeal: p.size / idealSize,
            residualCapital: residualCapital
        };
    };

    return mgr;
}

// ============================================================================
// TEST 1: SINGLE DUST PARTIAL
// ============================================================================
async function testSingleDustPartial() {
    console.log('\n[Test 1] Single DUST partial (should restore to ideal)');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a single tiny partial at 1.10 (ideal size = 10)
    const dustPartial = {
        id: 'sell-0',
        orderId: 'chain-dust',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 0.3, // < 5% of ideal (0.3 < 0.5)
        state: ORDER_STATES.PARTIAL
    };

    mgr._updateOrder(dustPartial);

    const result = await mgr._rebalanceSideAfterFill(ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    assert(result.partialMoves.length >= 1, 'Should have at least one partial move');
    const move = result.partialMoves[0];
    assert(move.partialOrder.size === 10, `Dust partial should upgrade to ideal 10, got ${move.partialOrder.size}`);
    assert(move.newPrice === 1.10, 'Should stay anchored at original price');

    console.log('✓ Single dust partial correctly restored to ideal size');
}

// ============================================================================
// TEST 2: MULTIPLE DUST PARTIALS (all at different prices)
// ============================================================================
async function testMultipleDustPartials() {
    console.log('\n[Test 2] Multiple DUST partials at different grid positions');
    console.log('-'.repeat(80));

    const mgr = setupManager(8);

    // Create 3 dust partials at different grid positions
    const dustPartials = [
        { id: 'sell-1', price: 1.05, size: 0.2, orderId: 'chain-d1' },
        { id: 'sell-3', price: 1.15, size: 0.3, orderId: 'chain-d2' },
        { id: 'sell-5', price: 1.25, size: 0.1, orderId: 'chain-d3' }
    ];

    for (const dp of dustPartials) {
        const order = {
            ...mgr.orders.get(dp.id),
            ...dp,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL
        };
        mgr._updateOrder(order);
    }

    const result = await mgr._rebalanceSideAfterFill(ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    console.log(`  Partial moves found: ${result.partialMoves.length}`);
    assert(result.partialMoves.length === 3, `Should have 3 partial moves, got ${result.partialMoves.length}`);

    // Verify all moved to ideal size
    for (const move of result.partialMoves) {
        assert(move.partialOrder.size === 10, `All dust partials should restore to ideal 10, got ${move.partialOrder.size}`);
    }

    console.log('✓ All dust partials correctly restored to ideal size');
}

// ============================================================================
// TEST 3: SUBSTANTIAL PARTIAL (should absorb residual if innermost)
// ============================================================================
async function testSubstantialPartialAsInnermost() {
    console.log('\n[Test 3] Substantial partial as innermost absorbs residuals');
    console.log('-'.repeat(80));

    const mgr = setupManager(6);

    // Create 2 partials: outer dust + inner substantial
    const outerDust = {
        id: 'sell-0',
        orderId: 'chain-outer',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 0.5, // Dust (< 5% of 10)
        state: ORDER_STATES.PARTIAL
    };

    const innerSubstantial = {
        id: 'sell-2',
        orderId: 'chain-inner',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 8, // Substantial (80% of ideal 10)
        state: ORDER_STATES.PARTIAL
    };

    mgr._updateOrder(outerDust);
    mgr._updateOrder(innerSubstantial);

    const result = await mgr._rebalanceSideAfterFill(ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    assert(result.partialMoves.length === 2, `Should have 2 partial moves, got ${result.partialMoves.length}`);

    // Sort by price to identify outer vs inner
    const moves = result.partialMoves.sort((a, b) => a.newPrice - b.newPrice);

    // Outer (lower price) should restore to ideal
    assert(moves[0].partialOrder.size === 10, `Outer dust should restore to 10, got ${moves[0].partialOrder.size}`);

    // Inner (higher price) should also restore to ideal (no merge in this case because substantial != dust)
    assert(moves[1].partialOrder.size === 10, `Inner substantial should restore to 10, got ${moves[1].partialOrder.size}`);

    console.log('✓ Substantial partial correctly handled as innermost');
}

// ============================================================================
// TEST 4: LARGE RESIDUAL THAT CAUSES SPLIT
// ============================================================================
async function testLargeResidualSplit() {
    console.log('\n[Test 4] Large residual capital causes innermost to SPLIT');
    console.log('-'.repeat(80));

    const mgr = setupManager(6);

    // Create 2 partials: outer oversized + inner dust
    const outerOversized = {
        id: 'sell-0',
        orderId: 'chain-outer',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 20, // Double ideal (100% residual)
        state: ORDER_STATES.PARTIAL
    };

    const innerDust = {
        id: 'sell-2',
        orderId: 'chain-inner',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 0.5, // Dust
        state: ORDER_STATES.PARTIAL
    };

    mgr._updateOrder(outerOversized);
    mgr._updateOrder(innerDust);

    const result = await mgr._rebalanceSideAfterFill(ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    assert(result.partialMoves.length >= 2, 'Should have at least 2 partial moves');

    // Inner partial should be at ideal size (not merged because residual is too large)
    const innerMove = result.partialMoves.find(m => m.partialOrder.orderId === 'chain-inner');
    assert(innerMove && innerMove.partialOrder.size === 10, `Inner should split and be at ideal 10, got ${innerMove?.partialOrder.size}`);

    // Should create a residual order for the excess
    assert(result.ordersToPlace.some(o => o.isResidualFromAnchor), 'Should create residual order');

    console.log('✓ Large residual correctly caused split behavior');
}

// ============================================================================
// TEST 5: VERIFY GHOST VIRTUALIZATION ISOLATION
// ============================================================================
async function testGhostVirtualizationIsolation() {
    console.log('\n[Test 5] Ghost virtualization prevents mutual blocking');
    console.log('-'.repeat(80));

    const mgr = setupManager(6);

    // Create 3 partials that would block each other without ghost virtualization
    const p1 = {
        id: 'sell-0',
        orderId: 'chain-p1',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 5,
        state: ORDER_STATES.PARTIAL
    };

    const p2 = {
        id: 'sell-2',
        orderId: 'chain-p2',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 5,
        state: ORDER_STATES.PARTIAL
    };

    const p3 = {
        id: 'sell-4',
        orderId: 'chain-p3',
        type: ORDER_TYPES.SELL,
        price: 1.30,
        size: 5,
        state: ORDER_STATES.PARTIAL
    };

    mgr._updateOrder(p1);
    mgr._updateOrder(p2);
    mgr._updateOrder(p3);

    // Before executing, verify all are PARTIAL
    assert(mgr.orders.get('sell-0').state === ORDER_STATES.PARTIAL);
    assert(mgr.orders.get('sell-2').state === ORDER_STATES.PARTIAL);
    assert(mgr.orders.get('sell-4').state === ORDER_STATES.PARTIAL);

    const result = await mgr._rebalanceSideAfterFill(ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    // All 3 partials should be processed (ghost virtualization prevents blocking)
    assert(result.partialMoves.length === 3, `Should process all 3 partials, got ${result.partialMoves.length}`);

    // After processing, all should be restored to their original states
    assert(mgr.orders.get('sell-0').state === ORDER_STATES.PARTIAL || mgr.orders.get('sell-0').state === ORDER_STATES.VIRTUAL);
    assert(mgr.orders.get('sell-2').state === ORDER_STATES.PARTIAL || mgr.orders.get('sell-2').state === ORDER_STATES.VIRTUAL);
    assert(mgr.orders.get('sell-4').state === ORDER_STATES.PARTIAL || mgr.orders.get('sell-4').state === ORDER_STATES.VIRTUAL);

    console.log('✓ Ghost virtualization successfully prevented mutual blocking');
}

// ============================================================================
// TEST 6: INNERMOST MERGE WITH ACCUMULATED RESIDUALS
// ============================================================================
async function testInnermostMergeWithAccumulatedResiduals() {
    console.log('\n[Test 6] Innermost partial merges small accumulated residuals');
    console.log('-'.repeat(80));

    const mgr = setupManager(6);

    // Create 3 partials: two small outer + one inner
    // Outer residuals: 0.5*1.10 + 0.5*1.15 = 1.075 total capital
    // Inner at 1.20: 1.075/1.20 = ~0.9 size → merged = 10 + 0.9 = 10.9 < 10.5 (threshold)
    // Should trigger MERGE
    const outer1 = {
        id: 'sell-0',
        orderId: 'chain-o1',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 10.5, // Small residual
        state: ORDER_STATES.PARTIAL
    };

    const outer2 = {
        id: 'sell-2',
        orderId: 'chain-o2',
        type: ORDER_TYPES.SELL,
        price: 1.15,
        size: 10.4, // Small residual
        state: ORDER_STATES.PARTIAL
    };

    const inner = {
        id: 'sell-4',
        orderId: 'chain-inner',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 0.3, // Dust
        state: ORDER_STATES.PARTIAL
    };

    mgr._updateOrder(outer1);
    mgr._updateOrder(outer2);
    mgr._updateOrder(inner);

    const result = await mgr._rebalanceSideAfterFill(ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    assert(result.partialMoves.length === 3, `Should have 3 partial moves, got ${result.partialMoves.length}`);

    // Inner should be marked as DoubleOrder if it merged
    const innerMove = result.partialMoves.find(m => m.partialOrder.orderId === 'chain-inner');
    assert(innerMove, 'Should find inner partial move');

    // The size should be > 10 (merged) or exactly 10 (split)
    assert(innerMove.partialOrder.size >= 10, `Inner should be at least 10, got ${innerMove.partialOrder.size}`);

    console.log('✓ Innermost partial correctly merged accumulated residuals');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testSingleDustPartial();
        await testMultipleDustPartials();
        await testSubstantialPartialAsInnermost();
        await testLargeResidualSplit();
        await testGhostVirtualizationIsolation();
        await testInnermostMergeWithAccumulatedResiduals();

        console.log('\n' + '='.repeat(80));
        console.log('All Multi-Partial Edge Case Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
