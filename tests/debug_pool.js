
const { BitShares } = require('../modules/bitshares_client');

const ASSET_A = 'IOB.XRP';
const ASSET_B = 'BTS';

async function run() {
    console.log('--- Debugging Pool Retrieval ---');
    console.log('--- Debuging Pool Retrieval ---');
    await BitShares.connect();

    try {
        const [a, b] = await BitShares.db.get_assets([ASSET_A, ASSET_B]);
        console.log(`Assets: ${a.symbol} (${a.id}) / ${b.symbol} (${b.id})`);

        // Scan using list_liquidity_pools
        let foundPool = null;
        let startId = '1.19.0';
        let limit = 100;

        console.log('Scanning pools...');
        while (!foundPool) {
            // list_liquidity_pools(lower_bound_id, limit) - check signature usually
            // The previous output said it returned 100 pools for args(100). 
            // Maybe args are just (limit)? Or (limit) implies start at 0?
            // If I cannot paginate, I am limited to 100.

            // Wait, the previous log said: "Attempt 2: list_liquidity_pools(100)... Result length: 100"
            // If I pass 100, is it limit?
            // Let's try passing (startId, limit) if possible, or just limit.
            // If I can't paginate, I might miss it.

            // Let's try to pass (limit) first, then iterate if needed?
            // Actually, verify signature if possible. But I can just try to find it in the first 100.

            const pools = await BitShares.db.list_liquidity_pools(limit, startId); // Hoping (limit, start) or (start, limit)?
            // Standard Graphene API list_xxx is usually (lower_bound, limit).
            // But JS wrapper might be different. Let's try list_liquidity_pools(limit) since that worked.
            // And scan the result.

            // Wait, previous attempt passed (100).
            const batch = await BitShares.db.list_liquidity_pools(100);

            if (!batch || batch.length === 0) break;

            foundPool = batch.find(p => {
                const ids = (p.asset_ids || []).map(String);
                // Also check p.asset_a/b if explicit
                const hasA = (p.asset_a === a.id || p.asset_b === a.id);
                const hasB = (p.asset_a === b.id || p.asset_b === b.id);
                return hasA && hasB;
            });

            if (foundPool) {
                console.log('FOUND POOL:', JSON.stringify(foundPool, null, 2));
                const balA = foundPool.balance_a;
                const balB = foundPool.balance_b;
                console.log(`Balance A (raw): ${balA}`);
                console.log(`Balance B (raw): ${balB}`);

                // Calculate Price
                // Determine which balance belongs to which asset
                let amtA, amtB;
                if (foundPool.asset_a === a.id) {
                    amtA = Number(foundPool.balance_a);
                    amtB = Number(foundPool.balance_b);
                } else {
                    amtA = Number(foundPool.balance_b);
                    amtB = Number(foundPool.balance_a);
                }

                const floatA = amtA / Math.pow(10, a.precision);
                const floatB = amtB / Math.pow(10, b.precision);
                // Price A/B (How much B for 1 A)
                const priceAB = floatB / floatA;
                const priceBA = floatA / floatB;

                console.log(`Price ${a.symbol}/${b.symbol}: ${priceBA}`);
                console.log(`Price ${b.symbol}/${a.symbol}: ${priceAB}`);
            }
            break; // Scan only first batch for now. 
        }

    } catch (e) {
        console.error('Error during run:', e);
    } finally {
        BitShares.disconnect();
    }
}
run();
