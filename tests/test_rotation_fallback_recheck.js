const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');

function run() {
    console.log('Running rotation fallback recheck tests...');

    assert.strictEqual(
        typeof DEXBot.prototype._buildRotationOps,
        'undefined',
        'Legacy _buildRotationOps helper should be removed'
    );
    assert.strictEqual(
        typeof DEXBot.prototype._buildCreateOps,
        'undefined',
        'Legacy _buildCreateOps helper should be removed'
    );
    assert.strictEqual(
        typeof DEXBot.prototype._buildCancelOps,
        'undefined',
        'Legacy _buildCancelOps helper should be removed'
    );
    assert.strictEqual(
        typeof DEXBot.prototype._buildSizeUpdateOps,
        'undefined',
        'Legacy _buildSizeUpdateOps helper should be removed'
    );

    console.log('rotation fallback recheck tests passed');
}

try {
    run();
    process.exit(0);
} catch (err) {
    console.error('rotation fallback recheck tests failed');
    console.error(err);
    process.exit(1);
}
