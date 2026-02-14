const assert = require('assert');

console.log('Running account totals waiter tests');

const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

(async () => {
    // Test: waiter resolves when free totals are available
    const mgr1 = new OrderManager({ botFunds: { buy: 0, sell: 0 } });
    mgr1.accountTotals = { buy: null, sell: null };

    const start1 = Date.now();
    setTimeout(async () => {
        await mgr1.setAccountTotals({ buy: 123.45, sell: 67.89, buyFree: 120.0, sellFree: 60.0 });
    }, 50);

    await mgr1.waitForAccountTotals(500);
    const elapsed1 = Date.now() - start1;
    assert(elapsed1 < 250, 'waitForAccountTotals should resolve quickly once free totals arrive');
    assert.strictEqual(Number(mgr1.accountTotals.buy), 123.45);
    assert.strictEqual(Number(mgr1.accountTotals.sell), 67.89);

    // Test: waiter does not resolve on totals-only updates (buy/sell without free)
    const mgr2 = new OrderManager({ botFunds: { buy: 0, sell: 0 } });
    mgr2.accountTotals = { buy: null, sell: null };
    setTimeout(async () => {
        await mgr2.setAccountTotals({ buy: 10, sell: 20 });
    }, 25);

    const start2 = Date.now();
    await mgr2.waitForAccountTotals(100);
    const elapsed2 = Date.now() - start2;
    assert(elapsed2 >= 90, 'waitForAccountTotals should wait for free totals, not buy/sell totals only');

    // Test: concurrent waiters should share timeout window (no lock-serialization)
    const mgr3 = new OrderManager({ botFunds: { buy: 0, sell: 0 } });
    mgr3.accountTotals = { buy: null, sell: null };

    const start3 = Date.now();
    await Promise.all([
        mgr3.waitForAccountTotals(120),
        mgr3.waitForAccountTotals(120),
        mgr3.waitForAccountTotals(120)
    ]);
    const elapsed3 = Date.now() - start3;
    assert(elapsed3 < 260, `concurrent waiters should not serialize (elapsed=${elapsed3}ms)`);

    // Test: explicit zero allocation should cap available funds to zero
    const mgr4 = new OrderManager({ botFunds: { buy: 0, sell: '0%' }, activeOrders: { buy: 1, sell: 1 } });
    await mgr4.setAccountTotals({ buy: 100, sell: 50, buyFree: 100, sellFree: 50 });
    assert.strictEqual(mgr4.funds.available.buy, 0, 'numeric zero allocation must cap buy availability to 0');
    assert.strictEqual(mgr4.funds.available.sell, 0, 'percentage zero allocation must cap sell availability to 0');

    // Test: _updateOrder rejects invalid state/type to protect indices
    const mgr5 = new OrderManager({ botFunds: { buy: 0, sell: 0 } });
    mgr5._updateOrder({ id: 'invalid-state', type: ORDER_TYPES.BUY, state: 'broken', size: 1 }, 'test-invalid-state');
    assert.strictEqual(mgr5.orders.has('invalid-state'), false, 'invalid state update must be rejected');

    mgr5._updateOrder({ id: 'invalid-type', type: 'broken', state: ORDER_STATES.VIRTUAL, size: 1 }, 'test-invalid-type');
    assert.strictEqual(mgr5.orders.has('invalid-type'), false, 'invalid type update must be rejected');

    console.log('account totals waiter tests passed');
})();
