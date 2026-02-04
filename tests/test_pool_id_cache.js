const assert = require('assert');
const { derivePoolPrice } = require('../modules/order/utils/system');

async function testPoolIdCache() {
    console.log('Running test: Pool ID Cache');

    // Mock BitShares client
    let listPoolsCallCount = 0;
    let getObjectsCallCount = 0;

    const mockPool = {
        id: '1.19.100',
        asset_a: '1.3.1',
        asset_b: '1.3.2',
        balance_a: '1000000',
        balance_b: '2000000'
    };

    const BitShares = {
        db: {
            list_liquidity_pools: async (limit, startId) => {
                listPoolsCallCount++;
                if (listPoolsCallCount === 1) {
                    return [mockPool];
                }
                return [];
            },
            get_objects: async (ids) => {
                getObjectsCallCount++;
                if (ids.includes('1.19.100')) {
                    return [mockPool];
                }
                return [];
            },
            lookup_asset_symbols: async (symbols) => {
                if (symbols.includes('BASE')) return [{ id: '1.3.1', symbol: 'BASE', precision: 5 }];
                if (symbols.includes('QUOTE')) return [{ id: '1.3.2', symbol: 'QUOTE', precision: 5 }];
                return [];
            }
        },
        assets: {
            'base': { id: '1.3.1', symbol: 'BASE', precision: 5 },
            'quote': { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        }
    };

    // First call: Should scan pools
    console.log('  First call: Should scan pools');
    const price1 = await derivePoolPrice(BitShares, 'BASE', 'QUOTE');
    assert.strictEqual(listPoolsCallCount, 1, 'Should have called list_liquidity_pools');
    // Enrichment get_objects is only called if !chosen.balance_a
    assert.strictEqual(getObjectsCallCount, 0, 'Should NOT have called get_objects for enrichment (balance_a present)');
    assert(price1 > 0, 'Should return a valid price');

    // Second call: Should use cache
    console.log('  Second call: Should use cache');
    const price2 = await derivePoolPrice(BitShares, 'BASE', 'QUOTE');
    assert.strictEqual(listPoolsCallCount, 1, 'Should NOT have called list_liquidity_pools again');
    assert.strictEqual(getObjectsCallCount, 1, 'Should have called get_objects for cached ID');
    assert.strictEqual(price1, price2, 'Prices should be identical');

    console.log('✓ Pool ID Cache test PASSED\n');
}

testPoolIdCache().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
