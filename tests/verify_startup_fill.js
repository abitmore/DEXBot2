
const { OrderManager } = require('../modules/order/manager');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

// Mock assets/logger
const mockAssets = {
    assetA: { id: '1.3.0', precision: 5, symbol: 'A' },
    assetB: { id: '1.3.1', precision: 5, symbol: 'B' }
};

class MockLogger {
    log(msg, level) { console.log(`[${level}] ${msg}`); }
}

async function runTest() {
    console.log('--- Starting Startup Fill Verification ---');

    const config = {
        assetA: 'A', assetB: 'B', startPrice: 100,
        activeOrders: { buy: 2, sell: 2 },
        botFunds: { buy: 1000, sell: 1000 },
        targetSpreadPercent: 1, incrementPercent: 1
    };

    const manager = new OrderManager(config);
    manager.logger = new MockLogger();
    manager.assets = mockAssets;

    // 1. Setup: Create a grid order that is ACTIVE
    const orderId = 'grid-order-1';
    const chainOrderId = '1.7.999';

    manager.orders.set(orderId, {
        id: orderId,
        orderId: chainOrderId,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 90,
        size: 10
    });

    // Also mock funds/available so rebalance works
    manager.funds.available.buy = 100;
    manager.funds.available.sell = 100;

    console.log(`Setup: Created ACTIVE order ${orderId} linked to ${chainOrderId}`);

    // 2. Action: Call synchronizeWithChain with 'readOpenOrders' and EMPTY chain list
    // This simulates that the order was filled while offline
    console.log('Action: Syncing with EMPTY open orders (simulating fill)...');

    // We need to mock processFilledOrders because it calls other things, or let it run.
    // Let's let it run but we might need to mock maybeConvertToSpread etc if they have external deps?
    // manager.js seems mostly self-contained except for 'utils' which are required.
    // It shouldn't make network calls in processFilledOrders logic itself, 
    // but rebalanceOrders might call activateClosestVirtualOrdersForPlacement.

    // Mock rebalanceOrders to avoid complex logic if we just want to verify the detection
    // But we want to verify the RESULT contains ordersToPlace/Rotate

    // Let's stub processFilledOrders to just return a known object to prove it was called
    manager.processFilledOrders = async (filledOrders) => {
        console.log(`Called processFilledOrders with ${filledOrders.length} orders`);
        return { ordersToPlace: [{ fake: 'order' }], ordersToRotate: [] };
    };

    const result = await manager.synchronizeWithChain([], 'readOpenOrders');

    // 3. Assertions
    console.log('--- Results ---');

    if (result.rebalanceResult && result.rebalanceResult.ordersToPlace && result.rebalanceResult.ordersToPlace.length > 0) {
        console.log('SUCCESS: synchronizeWithChain returned rebalance instructions.');
    } else {
        console.log('FAILURE: synchronizeWithChain did NOT return rebalance instructions.');
        console.log('Result:', JSON.stringify(result, null, 2));
        process.exit(1);
    }
}

runTest().catch(err => {
    console.error(err);
    process.exit(1);
});
