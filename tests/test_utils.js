const assert = require('assert');

console.log('Running utils tests');

const { utils } = require('../modules/order/index.js');

// isPercentageString
assert.strictEqual(utils.isPercentageString('50%'), true, 'isPercentageString should detect percentages');
assert.strictEqual(utils.isPercentageString(' 12.5% '), true, 'isPercentageString should trim and detect');
assert.strictEqual(utils.isPercentageString('0.5'), false, 'isPercentageString should not detect plain numbers');

// parsePercentageString
assert.strictEqual(utils.parsePercentageString('50%'), 0.5, 'parsePercentageString should parse 50%');
assert.strictEqual(utils.parsePercentageString(' 12.5% '), 0.125, 'parsePercentageString should handle spaces');
assert.strictEqual(utils.parsePercentageString('not%'), null, 'parsePercentageString should return null for invalid');

// blockchainToFloat
assert.strictEqual(utils.blockchainToFloat(null, 3), 0, 'blockchainToFloat should return 0 for null');
assert.strictEqual(utils.blockchainToFloat(1000, 3), 1.0, 'blockchainToFloat should divide by 10^precision');

// floatToBlockchainInt
const intval = utils.floatToBlockchainInt(1.2345, 4);
assert.strictEqual(typeof intval === 'number', true, 'floatToBlockchainInt should return Number');
assert.strictEqual(intval, Math.round(1.2345 * 10000));

// resolveAccountRef
assert.strictEqual(
    utils.resolveAccountRef({ accountId: '1.2.345', account: 'fallback-account' }, 'explicit-account'),
    '1.2.345',
    'resolveAccountRef should prefer manager.accountId'
);
assert.strictEqual(
    utils.resolveAccountRef({ account: 'manager-account' }, 'explicit-account'),
    'manager-account',
    'resolveAccountRef should fall back to manager.account'
);
assert.strictEqual(
    utils.resolveAccountRef({}, 'explicit-account'),
    'explicit-account',
    'resolveAccountRef should fall back to account arg'
);
assert.strictEqual(
    utils.resolveAccountRef({}, null),
    null,
    'resolveAccountRef should return null when no reference exists'
);

console.log('utils tests passed');
