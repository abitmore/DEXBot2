
const { BitShares } = require('../modules/bitshares_client');
const { derivePrice } = require('../modules/order/utils');

const ASSET_A = 'IOB.XRP';
const ASSET_B = 'BTS';

async function run() {
    console.log('--- Verifying derivePrice ---');
    await BitShares.connect();

    try {
        console.log(`Deriving price for ${ASSET_A}/${ASSET_B}...`);
        // Verify 'pool' mode explicitly to ensure logic works
        const p = await derivePrice(BitShares, ASSET_A, ASSET_B, 'pool');
        console.log('Pool Price Result:', p);

        // Also auto mode
        const a = await derivePrice(BitShares, ASSET_A, ASSET_B, 'auto');
        console.log('Auto Price Result:', a);

    } catch (e) {
        console.error('Error during run:', e);
    } finally {
        BitShares.disconnect();
    }
}
run();
