const assert = require('assert');
const { reconcileStartupOrders } = require('../modules/order/startup_reconcile');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testDuplicateRacePrevention() {
    console.log("\n========== STARTING DUPLICATE RACE PREVENTION TEST ==========\n");

    const orders = new Map();
    const manager = {
        orders: orders,
        logger: { log: (m, l) => console.log(`[LOG ${l}] ${m}`) },
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' }
        },
        accountTotals: { sellFree: 100, buyFree: 100 },
        _gridLock: { acquire: async (cb) => await cb() },
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(orders.values()).filter(o => o.type === type && o.state === state);
        },
        synchronizeWithChain: async () => { },
        syncFromOpenOrders: async (chainOrders) => {
            console.log("[MOCK] syncFromOpenOrders matching sell-2 to 1.7.2");
            const s2 = orders.get('sell-2');
            if (s2) {
                s2.orderId = '1.7.2';
                s2.state = ORDER_STATES.ACTIVE;
            }
        },
        _updateOrder: (o) => { orders.set(o.id, o); },
        startPrice: 0.5
    };

    // SETUP: 
    // sell-1 and sell-2 are both VIRTUAL
    // One chain order exists (1.7.1) which is unmatched on grid
    orders.set('sell-1', { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 0.55, size: 100 });
    orders.set('sell-2', { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 0.6, size: 100 });

    const chainOpenOrders = [
        {
            id: '1.7.1',
            sell_price: { base: { amount: 10000000, asset_id: '1.3.1' }, quote: { amount: 5500000, asset_id: '1.3.0' } },
            for_sale: 10000000
        }
    ];

    let createCalled = false;
    const chainOrdersMock = {
        updateOrder: async () => {
            console.log("[MOCK] updateOrder failing, triggering recovery sync...");
            throw new Error("Simulated failure to trigger recovery sync");
        },
        createOrder: async () => {
            createCalled = true;
            return [{ trx: { operation_results: [[0, '1.7.100']] } }];
        },
        cancelOrder: async () => { },
        readOpenOrders: async () => {
            return chainOpenOrders;
        }
    };

    // targetSell = 2. 
    // unmatchedSell = 1. 
    // updates = 1 (sell-1 will be targeted for update by 1.7.1).
    // creations = 1 (sell-2 will be targeted for creation).
    console.log("RUNNING RECONCILE: Expecting Phase 2 update for sell-1 to fail, trigger sync, and match sell-2");
    await reconcileStartupOrders({
        manager,
        config: { activeOrders: { sell: 2 } },
        account: 'test',
        privateKey: 'test',
        chainOrders: chainOrdersMock,
        chainOpenOrders: chainOpenOrders
    });

    assert.strictEqual(createCalled, false, "Should NOT call createOrder for sell-2 because it was matched during recovery sync");
    console.log("✅ Race prevention test passed");
}

testDuplicateRacePrevention().catch(err => {
    console.error("\n❌ TEST FAILED:");
    console.error(err);
    process.exit(1);
});
