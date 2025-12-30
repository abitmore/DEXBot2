/**
 * Verification Test: Virtual Spread Correction
 * 
 * Verifies that:
 * 1. calculateSpreadFromOrders includes virtual orders.
 * 2. prepareSpreadCorrectionOrders pools VIRTUAL and SPREAD orders.
 * 3. prepareSpreadCorrectionOrders selects the slot closest to the active cluster.
 */

const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { calculateSpreadFromOrders } = require('../modules/order/utils');
const Grid = require('../modules/order/grid');

async function runTests() {
    console.log('--- Verification Test: Virtual Spread Correction ---');

    // --- Part 1: Spread Calculation ---
    console.log('\n[Part 1] Testing calculateSpreadFromOrders with Virtual Orders...');

    const activeBuys = [{ price: 80 }];
    const activeSells = [{ price: 100 }];
    const virtualBuys = [{ price: 82 }];
    const virtualSells = [{ price: 98 }];

    // Reverted behavior: spread depends only on ACTIVE orders
    const expectedSpread = ((100 / 80) - 1) * 100; // 25%

    const result = calculateSpreadFromOrders(activeBuys, activeSells, virtualBuys, virtualSells);
    console.log(`Expected Spread: ${expectedSpread.toFixed(2)}% (only active)`);
    console.log(`Actual Spread:   ${result.toFixed(2)}%`);

    if (Math.abs(result - expectedSpread) < 1e-6) {
        console.log('✓ SUCCESS: Spreadsheet calculation correctly ignores virtual orders (as per "keep old logic").');
    } else {
        console.log('✗ FAILURE: Spreadsheet calculation did not match the expected active-only spread.');
    }

    // --- Part 2: prepareSpreadCorrectionOrders pooling and selection ---
    console.log('\n[Part 2] Testing prepareSpreadCorrectionOrders selection logic...');

    const mockManager = {
        orders: new Map(),
        funds: {
            available: { buy: 10, sell: 10 },
            committed: { grid: { buy: 100, sell: 100 } },
            cacheFunds: { buy: 0, sell: 0 }
        },
        assets: {
            assetA: { precision: 8 },
            assetB: { precision: 8 }
        },
        config: {
            activeOrders: { buy: 1, sell: 1 }
        },
        logger: {
            log: (msg, level) => {
                if (level === 'info' || level === 'warn') console.log(`[${level.toUpperCase()}] ${msg}`);
            }
        },
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(mockManager.orders.values()).filter(o => o.type === type && o.state === state);
        },
        getPartialOrdersOnSide: () => []
    };

    // Setup Grid for SELL side
    // Active SELL at 100
    // Virtual SELL at 95 (Candidate V)
    // Spread slot at 90 (Candidate S)
    // Active BUY at 80 (to trigger spread correction)

    mockManager.orders.set('A-SELL', { id: 'A-SELL', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 100, size: 1, orderId: '123' });
    mockManager.orders.set('V-SELL', { id: 'V-SELL', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 95, size: 0 }); // size 0 as it's virtual grid level
    mockManager.orders.set('S-SLOT', { id: 'S-SLOT', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 90, size: 0 });
    mockManager.orders.set('A-BUY', { id: 'A-BUY', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 1, orderId: '456' });

    // Mock Grid.calculateGeometricSizeForSpreadCorrection
    Grid.calculateGeometricSizeForSpreadCorrection = () => 0.5;

    console.log('\nScenario: SELL correction. Gap between Active(100) and Spread(90). Gap slot is Virtual(95).');
    const correctionResult = await Grid.prepareSpreadCorrectionOrders(mockManager, ORDER_TYPES.SELL);

    if (correctionResult.ordersToPlace.length > 0) {
        const selected = correctionResult.ordersToPlace[0];
        console.log(`Selected Slot ID: ${selected.id}`);
        console.log(`Selected Price:   ${selected.price}`);

        if (selected.id === 'V-SELL' && selected.price === 95) {
            console.log('✓ SUCCESS: Correctly selected the VIRTUAL slot at 95 (pooling works!).');
        } else {
            console.log('✗ FAILURE: Expected V-SELL at 95.');
        }
    } else {
        console.log('✗ FAILURE: No orders prepared for placement.');
    }

    // Setup Grid for BUY side
    // Active BUY at 80
    // Virtual BUY at 82 (Candidate V)
    // Spread slot at 85 (Candidate S)

    mockManager.orders.clear();
    mockManager.orders.set('A-BUY', { id: 'A-BUY', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 1, orderId: '456' });
    mockManager.orders.set('V-BUY', { id: 'V-BUY', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 82, size: 0 });
    mockManager.orders.set('S-SLOT', { id: 'S-SLOT', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 85, size: 0 });
    mockManager.orders.set('A-SELL', { id: 'A-SELL', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 100, size: 1, orderId: '123' });

    console.log('\nScenario: BUY correction. Gap between Active(80) and Spread(85). Gap slot is Virtual(82).');
    const correctionResultBuy = await Grid.prepareSpreadCorrectionOrders(mockManager, ORDER_TYPES.BUY);

    if (correctionResultBuy.ordersToPlace.length > 0) {
        const selected = correctionResultBuy.ordersToPlace[0];
        console.log(`Selected Slot ID: ${selected.id}`);
        console.log(`Selected Price:   ${selected.price}`);

        if (selected.id === 'V-BUY' && selected.price === 82) {
            console.log('✓ SUCCESS: Correctly selected the VIRTUAL slot at 82.');
        } else {
            console.log('✗ FAILURE: Expected V-BUY at 82.');
        }
    } else {
        console.log('✗ FAILURE: No orders prepared for placement.');
    }
}

runTests().catch(err => {
    console.error('ERROR during verification tests:', err);
    process.exit(1);
});
