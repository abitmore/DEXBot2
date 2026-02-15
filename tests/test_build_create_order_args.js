const assert = require('assert');

const { buildCreateOrderArgs } = require('../modules/order/utils/order');

function run() {
    console.log('Running buildCreateOrderArgs tests...');

    const assetA = { id: '1.3.5537', symbol: 'IOB.XRP', precision: 4 };
    const assetB = { id: '1.3.0', symbol: 'BTS', precision: 5 };

    const order = {
        type: 'buy',
        size: 80.24143,
        price: 1330.735856250621,
        // Stale metadata from previous slot role must be ignored for create args.
        rawOnChain: { for_sale: '221710657' }
    };

    const args = buildCreateOrderArgs(order, assetA, assetB);

    assert.strictEqual(args.sellAssetId, assetB.id, 'buy orders should sell assetB');
    assert.strictEqual(args.receiveAssetId, assetA.id, 'buy orders should receive assetA');
    assert(Math.abs(args.amountToSell - 80.24143) < 1e-8, `amountToSell should follow target size, got ${args.amountToSell}`);
    assert(args.amountToSell < 100, 'stale rawOnChain should not inflate create amount');

    console.log('✓ buildCreateOrderArgs tests passed');
}

try {
    run();
} catch (err) {
    console.error('✗ buildCreateOrderArgs tests failed');
    console.error(err);
    process.exit(1);
}
