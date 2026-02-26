const { BitShares, waitForConnected } = require('../modules/bitshares_client');

class BlockchainSource {
    constructor() {
        this.cache = new Map(); // simple cache for history
    }

    /**
     * Fetch recent fills for an account
     * @param {string} accountNameOrId
     * @param {number} limit
     * @returns {Promise<Array>} Array of fill objects
     */
    async getRecentFills(accountNameOrId, limit = 100) {
        await waitForConnected();
        
        // Resolve account ID if name provided
        let accountId = accountNameOrId;
        if (!accountId.startsWith('1.2.')) {
            // detailed lookup if needed, for now assume ID or simple lookup could be added
            // But since we don't have a resolve function exposed easily here, 
            // we might rely on the caller providing ID or implement a simple lookup.
            try {
                const acc = await BitShares.db.get_account_by_name(accountNameOrId);
                if (acc) accountId = acc.id;
            } catch (e) {
                console.warn(`Could not resolve account ${accountNameOrId}: ${e.message}`);
                return [];
            }
        }

        // Fetch history
        // stop (newest) = "1.11.0", start (oldest) = "1.11.0" implies getting latest
        // Actually get_account_history(account, stop, limit, start)
        // To get most recent: stop="1.11.0", start="1.11.0" is not quite right usually.
        // Usually it's (account, stop, limit, start).
        // To get latest, we usually pass stop as a very high ID or "1.11.0" (which sometimes means 'head').
        // Let's use the pattern from test_blockchain_fill_history.js:
        // get_account_history(accountId, '1.11.0', 100, '1.11.0')
        
        const history = await BitShares.history.get_account_history(accountId, '1.11.999999999', limit, '1.11.0');
        
        const fills = [];
        for (const entry of history) {
            const opData = entry.op;
            if (!Array.isArray(opData) || opData[0] !== 4) continue; // 4 = fill_order

            const fillData = opData[1];
            // We usually care about fills where we are the maker (our order was hit) 
            // OR taker (we hit someone else).
            // The test filtered for `is_maker`, but for metrics we might want both.
            // Let's keep both but mark them.

            fills.push({
                id: entry.id,
                block_num: entry.block_num,
                block_time: entry.block_time,
                order_id: fillData.order_id,
                pays: fillData.pays,
                receives: fillData.receives,
                is_maker: fillData.is_maker,
                fee: fillData.fee
            });
        }

        return fills;
    }

    /**
     * Resolve asset symbols to IDs
     * @param {string[]} symbols - Array of asset symbols (e.g. ['BTS', 'USD'])
     * @returns {Promise<Object>} Map of symbol -> asset object
     */
    async resolveAssetIds(symbols) {
        await waitForConnected();
        const assets = await BitShares.db.lookup_asset_symbols(symbols);
        const result = {};
        assets.forEach((asset, index) => {
            if (asset) {
                result[symbols[index]] = asset;
            }
        });
        return result;
    }

    /**
     * Get market candles (OHLCV) for an asset pair.
     *
     * NOTE: On BitShares, liquidity pool swaps (op_type 63) generate virtual
     * fill_order operations (op_type 4, is_virtual=true) which ARE included in
     * get_market_history buckets. So these candles contain both order-book and
     * LP-sourced trades combined.
     *
     * @param {string} baseAssetId
     * @param {string} quoteAssetId
     * @param {number} periodSeconds
     * @param {string} startDate  - ISO string e.g. '2026-01-01T00:00:00'
     * @param {string} endDate    - ISO string
     * @returns {Promise<Array>} OHLCV bucket array from BitShares history API
     */
    async getMarketCandles(baseAssetId, quoteAssetId, periodSeconds, startDate, endDate) {
        await waitForConnected();
        return await BitShares.history.get_market_history(
            baseAssetId,
            quoteAssetId,
            periodSeconds,
            startDate,
            endDate
        );
    }

    /**
     * Fetch raw LP swap operations (op_type 63) for an asset pair from the
     * blockchain history API, by querying the liquidity pool object directly.
     *
     * This gives pure LP-only data (no order-book fills mixed in), suitable
     * for computing implied pool price from actual swap amounts.
     *
     * Flow:
     *   1. get_liquidity_pools_by_assets(assetA, assetB) → find pool ID (1.19.X)
     *   2. get_account_history(pool_id, ...) → raw op history of the pool
     *   3. Filter for op_type 63, extract swap amounts
     *
     * @param {string} assetAId  - e.g. '1.3.0'
     * @param {string} assetBId  - e.g. '1.3.3926'
     * @param {number} [limit]   - max ops to fetch (default 200)
     * @returns {Promise<Array>} array of { block_time, soldAssetId, soldAmount, receivedAssetId, receivedAmount }
     */
    async getLpSwapHistory(assetAId, assetBId, limit = 200) {
        await waitForConnected();

        // Step 1: Find the LP pool for this pair
        let pools;
        try {
            pools = await BitShares.db.get_liquidity_pools_by_assets(assetAId, assetBId, 10, false);
        } catch (e) {
            throw new Error(`get_liquidity_pools_by_assets failed: ${e.message}`);
        }

        if (!pools || pools.length === 0) {
            return [];  // No LP pool exists for this pair
        }

        const poolId = pools[0].id;  // e.g. '1.19.5' — use the first (usually only) pool

        // Step 2: Get the pool's operation history
        // Treating the pool object as an "account" in the history API works on BitShares.
        let history;
        try {
            history = await BitShares.history.get_account_history(poolId, '1.11.999999999', limit, '1.11.0');
        } catch (e) {
            throw new Error(`get_account_history(pool ${poolId}) failed: ${e.message}`);
        }

        // Step 3: Filter for LP exchange ops and extract swap amounts
        const swaps = [];
        for (const entry of history) {
            const op = entry.op;
            if (!Array.isArray(op) || op[0] !== 63) continue;  // op_type 63 = liquidity_pool_exchange

            const d = op[1];
            swaps.push({
                block_time:       entry.block_time,
                block_num:        entry.block_num,
                poolId,
                soldAssetId:      d.amount_to_sell?.asset_id,
                soldAmount:       d.amount_to_sell?.amount,
                receivedAssetId:  d.min_to_receive?.asset_id,
                receivedAmount:   d.min_to_receive?.amount,
            });
        }

        return swaps;
    }
}

module.exports = new BlockchainSource();
