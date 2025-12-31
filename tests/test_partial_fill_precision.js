const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { floatToBlockchainInt } = require('../modules/order/utils');

console.log('Running precision edge-case partial-fill tests');

async function runCase({ precision, initialSize, partialFilled, expectUpdated }) {
    const cfg = { assetA: 'ASSTA', assetB: 'ASSTB', startPrice: 2, botFunds: { buy: 1000, sell: 1000 } };
    const mgr = new OrderManager(cfg);
    mgr.assets = {
        assetA: { id: '1.3.100', precision },
        assetB: { id: '1.3.101', precision }
    };

    const gridId = 'grid-1';
    const chainOrderId = '1.7.5000';
    const price = 2;

    const gridOrder = { id: gridId, orderId: chainOrderId, type: 'sell', state: 'active', size: initialSize, price };
    mgr.orders.set(gridId, gridOrder);
    // Update state tracking
    mgr._ordersByState['active'].add(gridId);
    mgr._ordersByType['sell'].add(gridId);
    mgr.resetFunds();
    mgr.setAccountTotals({ buy: 0, sell: initialSize, buyFree: 0, sellFree: 0 });
    mgr.recalculateFunds(); // This will set committed.grid.sell based on the active order

    const remainingHuman = +(initialSize - partialFilled);
    const remainingInt = Math.round(remainingHuman * Math.pow(10, precision));
    const initialInt = Math.round(initialSize * Math.pow(10, precision));

    const chainOrders = [{
        id: chainOrderId,
        sell_price: {
            base: { asset_id: mgr.assets.assetA.id, amount: Math.round(initialSize * Math.pow(10, precision)) },
            quote: { asset_id: mgr.assets.assetB.id, amount: Math.round(initialSize * price * Math.pow(10, precision)) }
        },
        for_sale: remainingInt
    }];

    const fillInfo = {
        pays: { amount: Math.round(partialFilled * Math.pow(10, precision)), asset_id: mgr.assets.assetA.id },
        receives: { amount: Math.round(partialFilled * price * Math.pow(10, precision)), asset_id: mgr.assets.assetB.id }
    };

    const result = mgr.syncFromOpenOrders(chainOrders, fillInfo);

    // Check whether update occurred according to expectation
    const updated = mgr.orders.get(gridId);
    if (expectUpdated) {
        assert(result.updatedOrders.length === 1, `Expected update, got none (precision ${precision}, partial ${partialFilled})`);
        assert(updated.state === 'partial', 'should transition to partial');
        // Committed should be new remaining (compare ints using nested structure)
        const committedInt = floatToBlockchainInt(mgr.funds.committed.grid.sell, precision);
        assert.strictEqual(committedInt, remainingInt);
    } else {
        assert(result.updatedOrders.length === 0, `Expected NO update, got update (precision ${precision}, partial ${partialFilled})`);
        // committed should remain the initialSize (compare ints using nested structure)
        const committedInt = floatToBlockchainInt(mgr.funds.committed.grid.sell, precision);
        assert.strictEqual(committedInt, initialInt);
    }
}

(async () => {
    try {
        // Case 1: precision 0 (integer on-chain). small partial (0.4) should round away -> no update
        await runCase({ precision: 0, initialSize: 10, partialFilled: 0.4, expectUpdated: false });
        console.log('precision 0 small partial -> no update (passed)');

        // Case 2: precision 3, partial small below half-unit -> no update (e.g., 0.0004 < 0.0005 round threshold)
        await runCase({ precision: 3, initialSize: 10, partialFilled: 0.0004, expectUpdated: false });
        console.log('precision 3 tiny partial below rounding -> no update (passed)');

        // Case 3: precision 3, partial above rounding threshold -> update
        await runCase({ precision: 3, initialSize: 10, partialFilled: 0.0006, expectUpdated: true });
        console.log('precision 3 tiny partial above rounding -> update (passed)');

        console.log('All precision partial-fill tests passed');
        process.exit(0);
    } catch (err) {
        console.error('Precision partial-fill tests failed:', err && err.message ? err.message : err);
        process.exit(1);
    }
})();
