'use strict';

/**
 * BLOCKCHAIN MONITOR
 *
 * Fetches liquidity pool price data directly from the BitShares blockchain,
 * using two data paths and merging them:
 *
 *   1. getLpSwapHistory()   — op_type 63 ops from the LP pool object itself
 *                             (pure LP data, raw swap amounts → implied price)
 *
 *   2. getMarketCandles()   — get_market_history buckets for the pair
 *                             (includes LP-sourced virtual fills + order book fills)
 *                             Used as fallback if no LP pool exists for the pair.
 *
 * Requires a live BitShares node connection.
 *
 * Usage:
 *   node market_adapter/monitor_blockchain.js
 */

const { loadActiveBots, reportAMA } = require('./market_monitor');
const blockchainSource = require('./blockchain_source');
const { waitForConnected } = require('../modules/bitshares_client');

const CANDLE_CONFIG = {
    bucketSeconds: 3600,   // 1h
    lookbackHours: 100,    // ~4 days
};

// ─── LP swap ops → close price array ──────────────────────────────────────────

/**
 * Convert raw LP swap history (from getLpSwapHistory) into hourly close prices.
 * Price = received / sold (precision-adjusted).
 * Both swap directions are handled and expressed as assetB per assetA.
 *
 * @param {Array}  swaps    - from blockchainSource.getLpSwapHistory()
 * @param {string} assetAId - the "A" asset (numerator for price)
 * @param {number} precA    - decimal precision of A
 * @param {number} precB    - decimal precision of B
 * @param {number} [bucketSeconds] - time bucket size for aggregation
 * @returns {number[]} close prices per bucket, oldest first
 */
function swapsToBucketedPrices(swaps, assetAId, precA, precB, bucketSeconds = 3600) {
    if (swaps.length === 0) return [];

    const scaleA = Math.pow(10, precA);
    const scaleB = Math.pow(10, precB);
    const bucketMs = bucketSeconds * 1000;

    // Bucket swaps by time interval
    const buckets = new Map();  // bucketKey → { sumSoldA, sumRecvB, sumSoldB, sumRecvA }

    for (const s of swaps) {
        const ts        = new Date(s.block_time).getTime();
        const bucketKey = Math.floor(ts / bucketMs) * bucketMs;

        if (!buckets.has(bucketKey)) {
            buckets.set(bucketKey, { sumSoldA: 0, sumRecvB: 0, sumSoldB: 0, sumRecvA: 0 });
        }
        const b = buckets.get(bucketKey);

        if (s.soldAssetId === assetAId) {
            // Direction A→B: selling A, receiving B
            b.sumSoldA += (s.soldAmount ?? 0) / scaleA;
            b.sumRecvB += (s.receivedAmount ?? 0) / scaleB;
        } else {
            // Direction B→A: selling B, receiving A → invert to get B-per-A
            b.sumSoldB += (s.soldAmount ?? 0) / scaleB;
            b.sumRecvA += (s.receivedAmount ?? 0) / scaleA;
        }
    }

    // Sort buckets and compute VWAP price for each
    return [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, b]) => {
            // Merge both directions: price = B per A
            const totalSoldA = b.sumSoldA + b.sumRecvA;  // total A that moved
            const totalSoldB = b.sumSoldB + b.sumRecvB;  // total B that moved
            if (totalSoldA === 0) return null;
            return totalSoldB / totalSoldA;
        })
        .filter(p => p !== null && isFinite(p) && p > 0);
}

// ─── Market candles → close price array ───────────────────────────────────────

/**
 * Convert BitShares market candle objects into a close-price array.
 * get_market_history returns buckets that include LP virtual fills.
 *
 * @param {Array}  candles  - raw result from get_market_history
 * @param {string} assetAId - to determine which side is "A"
 * @param {number} precA
 * @param {number} precB
 * @returns {number[]} close prices (B per A)
 */
function candlesToCloses(candles, assetAId, precA, precB) {
    return candles.map((c) => {
        const isABase  = c.key.base === assetAId;
        const pBase    = isABase ? precA : precB;
        const pQuote   = isABase ? precB : precA;
        const base     = c.close_base  / Math.pow(10, pBase);
        const quote    = c.close_quote / Math.pow(10, pQuote);
        // Price = B per A.  If A is base: quote/base.  If B is base: base/quote.
        return isABase ? quote / base : base / quote;
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
    console.log('═══════════════════════════════════════');
    console.log(' Market Monitor — Blockchain LP Source');
    console.log('═══════════════════════════════════════');

    await waitForConnected();
    console.log('Connected to BitShares node.\n');

    const activeBots = loadActiveBots();
    console.log(`Active bots: ${activeBots.length}`);

    for (const bot of activeBots) {
        console.log(`\n─── ${bot.name} (${bot.preferredAccount ?? 'no account'}) ───`);

        // ── Fills ────────────────────────────────────────────────────────────
        if (bot.preferredAccount) {
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

        if (!bot.assetA || !bot.assetB) {
            console.log('  (No asset pair configured — skipping)');
            continue;
        }

        console.log(`  Pair: ${bot.assetA} / ${bot.assetB}`);

        // ── Resolve asset metadata ───────────────────────────────────────────
        const resolved = await blockchainSource.resolveAssetIds([bot.assetA, bot.assetB]);
        const metaA    = resolved[bot.assetA];
        const metaB    = resolved[bot.assetB];

        if (!metaA || !metaB) {
            console.warn('  Cannot resolve asset IDs — skipping');
            continue;
        }

        const assetAId = metaA.id;
        const assetBId = metaB.id;
        const precA    = bot.assetAPrecision ?? metaA.precision ?? 5;
        const precB    = bot.assetBPrecision ?? metaB.precision ?? 5;

        console.log(`  AssetA: ${assetAId} (precision ${precA})`);
        console.log(`  AssetB: ${assetBId} (precision ${precB})`);

        // ── Path 1: LP pool swap history (pure LP data) ──────────────────────
        let closes = [];
        let source = '';

        try {
            const swaps = await blockchainSource.getLpSwapHistory(assetAId, assetBId, 200);
            console.log(`  LP swaps (on-chain, last 200 ops): ${swaps.length}`);

            if (swaps.length > 0) {
                closes = swapsToBucketedPrices(swaps, assetAId, precA, precB, CANDLE_CONFIG.bucketSeconds);
                source = `Blockchain LP pool (op_type 63) · ${CANDLE_CONFIG.bucketSeconds / 3600}h buckets`;
            }
        } catch (err) {
            console.warn(`  LP swap history failed: ${err.message}`);
        }

        // ── Path 2: Fallback — market candle history (includes LP virtual fills) ──
        if (closes.length === 0) {
            console.log('  Falling back to get_market_history (includes LP virtual fills)...');
            try {
                const now   = new Date();
                const start = new Date(now - CANDLE_CONFIG.lookbackHours * 3600 * 1000)
                    .toISOString().split('.')[0];
                const end   = now.toISOString().split('.')[0];

                const candles = await blockchainSource.getMarketCandles(
                    assetAId, assetBId, CANDLE_CONFIG.bucketSeconds, start, end
                );

                console.log(`  Market candles: ${candles?.length ?? 0}`);
                if (candles && candles.length > 0) {
                    closes = candlesToCloses(candles, assetAId, precA, precB);
                    source = `Blockchain get_market_history (LP fills included) · ${CANDLE_CONFIG.bucketSeconds / 3600}h`;
                }
            } catch (err) {
                console.warn(`  Market candles failed: ${err.message}`);
            }
        }

        reportAMA(`${bot.assetA}/${bot.assetB}`, closes, source);
    }
}

run().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
