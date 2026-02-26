'use strict';

/**
 * KIBANA MONITOR
 *
 * Fetches liquidity pool price data from the BitShares Elasticsearch index
 * (op_type 63 = liquidity_pool_exchange) and runs AMA analysis on it.
 *
 * Usage:
 *   node market_adapter/monitor_kibana.js
 *
 * Does NOT require a BitShares node connection for price data.
 * Fills (for bot performance metrics) are still read from the blockchain.
 */

const { loadActiveBots, reportAMA } = require('./market_monitor');
const kibanaSource     = require('./kibana_source');
const blockchainSource = require('./blockchain_source');
const { waitForConnected } = require('../modules/bitshares_client');

const KIBANA_CONFIG = {
    intervalSeconds: 3600,  // 1h buckets
    lookbackHours:   100,   // ~4 days of data
    apiKey:          null,  // set if Kibana requires auth
};

async function run() {
    console.log('═══════════════════════════════════════');
    console.log(' Market Monitor — Kibana LP Source');
    console.log('═══════════════════════════════════════');

    const activeBots = loadActiveBots();
    console.log(`Active bots: ${activeBots.length}`);

    // Blockchain connection only needed for fills — connect once upfront
    let blockchainConnected = false;
    try {
        await waitForConnected();
        blockchainConnected = true;
    } catch (err) {
        console.warn(`Blockchain unavailable (${err.message}) — fills will be skipped`);
    }

    for (const bot of activeBots) {
        console.log(`\n─── ${bot.name} (${bot.preferredAccount ?? 'no account'}) ───`);

        // ── Fills from blockchain ────────────────────────────────────────────
        if (blockchainConnected && bot.preferredAccount) {
            try {
                const fills = await blockchainSource.getRecentFills(bot.preferredAccount);
                console.log(`  Fills (last 100): ${fills.length}`);
                if (fills.length > 0) {
                    const last = fills[fills.length - 1];
                    console.log(`  Last fill: ${last.id} at ${last.block_time}`);
                }
            } catch (err) {
                console.warn(`  Fills: ${err.message}`);
            }
        }

        // ── Price from Kibana LP history ─────────────────────────────────────
        if (!bot.assetA || !bot.assetB) {
            console.log('  (No asset pair configured — skipping price fetch)');
            continue;
        }

        console.log(`  Pair: ${bot.assetA} / ${bot.assetB}`);

        // Resolve asset IDs + precisions.
        // Prefer explicit IDs in bot config (assetAId, assetBId) to avoid a
        // blockchain round-trip; fall back to symbol resolution via RPC.
        let assetAId  = bot.assetAId;
        let assetBId  = bot.assetBId;
        let precA     = bot.assetAPrecision ?? 5;
        let precB     = bot.assetBPrecision ?? 5;

        if ((!assetAId || !assetBId) && blockchainConnected) {
            try {
                const resolved = await blockchainSource.resolveAssetIds([bot.assetA, bot.assetB]);
                assetAId = assetAId ?? resolved[bot.assetA]?.id;
                assetBId = assetBId ?? resolved[bot.assetB]?.id;
                precA    = bot.assetAPrecision ?? resolved[bot.assetA]?.precision ?? 5;
                precB    = bot.assetBPrecision ?? resolved[bot.assetB]?.precision ?? 5;
            } catch (err) {
                console.warn(`  Asset resolution failed: ${err.message}`);
            }
        }

        if (!assetAId || !assetBId) {
            console.warn('  Cannot fetch price: asset IDs unknown (add assetAId/assetBId to bots.json or connect to blockchain)');
            continue;
        }

        console.log(`  AssetA: ${assetAId} (precision ${precA})`);
        console.log(`  AssetB: ${assetBId} (precision ${precB})`);

        let closes = [];
        try {
            closes = await kibanaSource.getLpClosePrices(
                { id: assetAId, precision: precA },
                { id: assetBId, precision: precB },
                KIBANA_CONFIG
            );
        } catch (err) {
            console.warn(`  Kibana fetch failed: ${err.message}`);
        }

        reportAMA(`${bot.assetA}/${bot.assetB}`, closes, `Kibana LP (op_type 63) · ${KIBANA_CONFIG.intervalSeconds / 3600}h buckets`);
    }
}

run().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
