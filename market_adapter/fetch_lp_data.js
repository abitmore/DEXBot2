/**
 * FETCH LP PRICE DATA FROM KIBANA — Pool-centric
 *
 * Reads profiles/server-profiles/bots.json for asset pairs, connects to
 * the BitShares blockchain to resolve asset precisions and the pool ID
 * (using the same logic as derivePoolPrice in modules/order/utils/system.js),
 * then fetches all swap history from Kibana and exports OHLCV candles to JSON.
 *
 * Usage:
 *   node market_adapter/fetch_lp_data.js
 *   node market_adapter/fetch_lp_data.js --bot XRP-BTS
 *   node market_adapter/fetch_lp_data.js --bot XRP-BTS --interval 4h --lookback 8760h
 *
 * Manual override (no blockchain connection needed):
 *   node market_adapter/fetch_lp_data.js --pool 133 --precA 5 --precB 8
 *
 * Output:
 *   market_adapter/data/lp_pool_133_4h.json
 *
 * Precision:
 *   Resolved automatically from the BitShares blockchain via lookup_asset_symbols.
 *   Use --precA / --precB to override if needed.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const kibanaSource = require('./kibana_source');

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
    intervalSeconds: 14400,   // 4h buckets — good balance of resolution vs noise
    lookbackHours:   8760,    // 365 days
    apiKey:          null,
};

const BOTS_JSON = path.join(__dirname, '..', 'profiles', 'bots.json');

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args   = process.argv.slice(2);
    const config = { ...DEFAULT_CONFIG };
    let poolId   = null;   // null = auto-discover from bots.json
    let botName  = null;
    let precA    = null;   // null = auto from blockchain
    let precB    = null;

    const intervalMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const val = args[i + 1];

        switch (arg) {
            case '--bot':      botName              = val; i++; break;
            case '--pool':     poolId               = val; i++; break;
            case '--interval': config.intervalSeconds = intervalMap[val] ?? parseInt(val, 10); i++; break;
            case '--lookback': config.lookbackHours   = parseInt(val.replace('h', ''), 10); i++; break;
            case '--precA':    precA                  = parseInt(val, 10); i++; break;
            case '--precB':    precB                  = parseInt(val, 10); i++; break;
            case '--apiKey':   config.apiKey          = val; i++; break;
        }
    }

    return { poolId, botName, precA, precB, config };
}

// ─── Output path ──────────────────────────────────────────────────────────────

function outputPath(poolId, intervalSeconds) {
    const label = intervalSeconds >= 86400 ? `${intervalSeconds / 86400}d` :
                  intervalSeconds >= 3600  ? `${intervalSeconds / 3600}h`  :
                  intervalSeconds >= 60    ? `${intervalSeconds / 60}m`    : `${intervalSeconds}s`;
    const id  = String(poolId).replace('1.19.', '');
    return path.join(__dirname, 'data', `lp_pool_${id}_${label}.json`);
}

// ─── bots.json helper ─────────────────────────────────────────────────────────

function loadBotsJson() {
    if (!fs.existsSync(BOTS_JSON)) {
        throw new Error(`bots.json not found: ${BOTS_JSON}`);
    }
    const { bots } = JSON.parse(fs.readFileSync(BOTS_JSON, 'utf8'));
    return bots;
}

/**
 * Pick a bot: by name if given, otherwise first active bot with startPrice: "pool".
 */
function selectBot(bots, botName) {
    if (botName) {
        const bot = bots.find(b => b.name === botName);
        if (!bot) throw new Error(`Bot "${botName}" not found in bots.json`);
        return bot;
    }
    const bot = bots.find(b => b.active && b.startPrice === 'pool');
    if (!bot) throw new Error('No active pool-price bot found in bots.json. Use --bot NAME to specify one.');
    return bot;
}

// ─── Pool finder (mirrors derivePoolPrice logic from modules/order/utils/system.js) ──

/**
 * Resolve asset symbol to { id, precision } via BitShares blockchain.
 */
async function resolveAsset(BitShares, symbol) {
    const results = await BitShares.db.lookup_asset_symbols([symbol]);
    const asset = results?.[0];
    if (!asset?.id || typeof asset.precision !== 'number') {
        throw new Error(`Cannot resolve asset "${symbol}" from blockchain`);
    }
    return { id: asset.id, precision: asset.precision, symbol };
}

/**
 * Find the liquidity pool for an asset pair.
 * Mirrors the logic in modules/order/utils/system.js::derivePoolPrice().
 * Returns the pool object with .id and balances, or throws if not found.
 */
async function findPool(BitShares, idA, idB) {
    // Fast path: direct lookup by asset ID pair
    if (typeof BitShares.db?.get_liquidity_pool_by_asset_ids === 'function') {
        try {
            const pool = await BitShares.db.get_liquidity_pool_by_asset_ids(idA, idB);
            if (pool?.id) return pool;
        } catch (e) {}
    }

    // Fast path: get_liquidity_pools_by_assets (used by blockchain_source.js)
    if (typeof BitShares.db?.get_liquidity_pools_by_assets === 'function') {
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_assets(idA, idB, 10, false);
            if (pools?.length > 0) return pools[0];
        } catch (e) {}
    }

    // Fallback: paginated scan through all pools
    const listFn = BitShares.db?.list_liquidity_pools ?? BitShares.db?.get_liquidity_pools;
    if (typeof listFn === 'function') {
        let startId  = '1.19.0';
        const PAGE   = 100;
        const idAStr = String(idA);
        const idBStr = String(idB);

        while (true) {
            const pools = await listFn(PAGE, startId);
            if (!pools?.length) break;

            const effective = startId === '1.19.0' ? pools : pools.slice(1);
            const matches = effective.filter(p => {
                const ids = (p.asset_ids ?? [p.asset_a, p.asset_b]).map(String);
                return ids.includes(idAStr) && ids.includes(idBStr);
            });

            if (matches.length) {
                // Pick pool with highest assetA balance
                return matches.sort((a, b) => {
                    const bal = (p) => Number(String(p.asset_a) === idAStr ? p.balance_a : p.balance_b);
                    return bal(b) - bal(a);
                })[0];
            }

            if (pools.length < PAGE) break;
            startId = pools[pools.length - 1].id;
        }
    }

    throw new Error(`No liquidity pool found for ${idA} / ${idB}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
    const { poolId: cliPoolId, botName, precA: cliPrecA, precB: cliPrecB, config } = parseArgs();

    const intervalLabel = config.intervalSeconds >= 86400 ? `${config.intervalSeconds / 86400}d` :
                          config.intervalSeconds >= 3600  ? `${config.intervalSeconds / 3600}h`  :
                          `${config.intervalSeconds / 60}m`;

    console.log('══════════════════════════════════════════════');
    console.log(' Kibana LP Fetcher — Pool-centric');
    console.log('══════════════════════════════════════════════');

    let fullPoolId, assetA, assetB;

    // ── Mode A: manual --pool override (no blockchain connection needed) ──────
    if (cliPoolId) {
        const { waitForConnected, BitShares } = require('../modules/bitshares_client');

        console.log(`  Mode:     Manual (--pool ${cliPoolId})`);
        fullPoolId = kibanaSource.normalizePoolId(cliPoolId);

        // Still need to discover asset IDs from Kibana; precisions from CLI or default
        console.log(`  Pool:     ${fullPoolId}`);
        console.log(`  Interval: ${intervalLabel} candles`);
        console.log(`  Lookback: ${config.lookbackHours}h (${(config.lookbackHours / 24 / 365).toFixed(2)} years)`);
        console.log('══════════════════════════════════════════════');

        console.log(`\n[1/4] Discovering assets in pool ${fullPoolId}...`);
        let assetIds;
        try {
            assetIds = await kibanaSource.discoverPoolAssets(fullPoolId, config);
        } catch (err) {
            console.error(`  Discovery failed: ${err.message}`);
            process.exit(1);
        }

        if (assetIds.length < 2) {
            console.error(`  Expected 2 asset IDs, found: [${assetIds.join(', ')}]`);
            process.exit(1);
        }

        const [idA, idB] = assetIds;
        const precA = cliPrecA ?? 5;
        const precB = cliPrecB ?? 5;

        console.log(`  Asset A: ${idA} (precision ${precA}${cliPrecA == null ? ' — default, use --precA to override' : ''})`);
        console.log(`  Asset B: ${idB} (precision ${precB}${cliPrecB == null ? ' — default, use --precB to override' : ''})`);

        assetA = { id: idA, precision: precA, symbol: idA };
        assetB = { id: idB, precision: precB, symbol: idB };

    // ── Mode B: auto-resolve from bots.json + blockchain (default) ───────────
    } else {
        const { waitForConnected, BitShares } = require('../modules/bitshares_client');

        const bots = loadBotsJson();
        const bot  = selectBot(bots, botName);

        console.log(`  Mode:     Auto (bots.json → blockchain → Kibana)`);
        console.log(`  Bot:      ${bot.name} (${bot.assetA} / ${bot.assetB})`);
        console.log(`  Interval: ${intervalLabel} candles`);
        console.log(`  Lookback: ${config.lookbackHours}h (${(config.lookbackHours / 24 / 365).toFixed(2)} years)`);
        console.log(`  Auth:     ${config.apiKey ? 'API key set' : 'open (no auth)'}`);
        console.log('══════════════════════════════════════════════');

        // ── Step 1: Connect + resolve asset metadata ─────────────────────────
        console.log('\n[1/4] Connecting to BitShares and resolving asset metadata...');
        await waitForConnected();
        console.log('  Connected.');

        let metaA, metaB;
        try {
            [metaA, metaB] = await Promise.all([
                resolveAsset(BitShares, bot.assetA),
                resolveAsset(BitShares, bot.assetB),
            ]);
        } catch (err) {
            console.error(`  Asset resolution failed: ${err.message}`);
            process.exit(1);
        }

        // Apply CLI precision overrides if given
        if (cliPrecA != null) metaA = { ...metaA, precision: cliPrecA };
        if (cliPrecB != null) metaB = { ...metaB, precision: cliPrecB };

        assetA = { id: metaA.id, precision: metaA.precision, symbol: bot.assetA };
        assetB = { id: metaB.id, precision: metaB.precision, symbol: bot.assetB };

        console.log(`  Asset A: ${bot.assetA} → ${assetA.id} (precision ${assetA.precision})`);
        console.log(`  Asset B: ${bot.assetB} → ${assetB.id} (precision ${assetB.precision})`);

        // ── Step 2: Find liquidity pool ───────────────────────────────────────
        console.log(`\n[2/4] Finding liquidity pool for ${bot.assetA} / ${bot.assetB}...`);
        let pool;
        try {
            pool = await findPool(BitShares, assetA.id, assetB.id);
        } catch (err) {
            console.error(`  Pool lookup failed: ${err.message}`);
            process.exit(1);
        }

        fullPoolId = pool.id;
        console.log(`  Pool:    ${fullPoolId}`);
    }

    // ── Probe (or renumber steps in manual mode) ──────────────────────────────
    const stepProbe  = cliPoolId ? 2 : 3;
    const stepFetch  = cliPoolId ? 3 : 4;

    console.log(`\n[${stepProbe}/4] Probing data availability (last 48h)...`);
    try {
        const bucketsA = await kibanaSource.getRawBuckets(fullPoolId, assetA.id, {
            ...config, lookbackHours: Math.min(config.lookbackHours, 48),
        });
        const bucketsB = await kibanaSource.getRawBuckets(fullPoolId, assetB.id, {
            ...config, lookbackHours: Math.min(config.lookbackHours, 48),
        });
        console.log(`  A→B swaps in 48h: ${bucketsA.length} buckets`);
        console.log(`  B→A swaps in 48h: ${bucketsB.length} buckets`);

        const sample = bucketsA[0] ?? bucketsB[0];
        if (sample) {
            console.log(`  Sample bucket: key=${new Date(sample.key).toISOString()}`);
            if ((sample.sum_received?.value ?? 0) === 0) {
                console.warn('\n  WARNING: sum_received = 0');
                console.warn('  The field "operation_result_object.data_object.received.amount" may not be');
                console.warn('  populated for this pool. Candles will be empty.');
            }
        } else {
            console.warn('  No buckets in last 48h — pool may be low-activity. Proceeding with full lookback.');
        }
    } catch (err) {
        console.error(`  Probe failed: ${err.message}`);
        process.exit(1);
    }

    // ── Fetch full history ────────────────────────────────────────────────────
    console.log(`\n[${stepFetch}/4] Fetching full history (${config.lookbackHours}h, ${intervalLabel} buckets)...`);
    let candles;
    try {
        candles = await kibanaSource.getLpCandlesForPool(fullPoolId, assetA, assetB, config);
        console.log(`  Total candles: ${candles.length}`);

        if (candles.length === 0) {
            console.error('  No candles returned.');
            console.error('  If sum_received was 0 above, the operation_result field is not indexed.');
            process.exit(1);
        }

        const firstTs  = new Date(candles[0][0]).toISOString();
        const lastTs   = new Date(candles[candles.length - 1][0]).toISOString();
        const closes   = candles.map(c => c[4]);
        const minPrice = Math.min(...closes);
        const maxPrice = Math.max(...closes);
        const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;

        console.log(`  Date range:  ${firstTs}  →  ${lastTs}`);
        console.log(`  Price range: ${minPrice.toFixed(8)} – ${maxPrice.toFixed(8)}`);
        console.log(`  Avg price:   ${avgPrice.toFixed(8)}  (${assetB.symbol} per ${assetA.symbol})`);
    } catch (err) {
        console.error(`  Fetch failed: ${err.message}`);
        process.exit(1);
    }

    // ── Save ──────────────────────────────────────────────────────────────────
    console.log('\n[4/4] Saving...');
    const outPath = outputPath(fullPoolId, config.intervalSeconds);

    const output = {
        meta: {
            fetchedAt:       new Date().toISOString(),
            source:          `https://kibana.bitshares.dev (bitshares-*, op_type 63, pool ${fullPoolId})`,
            pool:            fullPoolId,
            assetA,
            assetB,
            intervalSeconds: config.intervalSeconds,
            lookbackHours:   config.lookbackHours,
            candleCount:     candles.length,
            priceUnit:       `${assetB.symbol} per ${assetA.symbol}`,
            // Candle format: [timestamp_ms, open, high, low, close, volume_in_assetA]
            // Directional buckets are merged and consolidated by timestamp.
            // If both swap directions exist in the same interval, OHLC is aggregated
            // and volume is expressed in assetA units.
            // Actual received used (operation_result_object), not min_to_receive.
            format:          '[timestamp_ms, open, high, low, close, volume_A]',
        },
        candles,
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log(`  Saved: ${path.relative(process.cwd(), outPath)}  (${kb} KB)`);

    console.log('\nNext — chart it:');
    console.log(`  node market_adapter/chart_lp_prices.js --file ${path.relative(process.cwd(), outPath)}`);
}

run().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
