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
        
        const history = await BitShares.history.get_account_history(accountId, '1.11.0', limit, '1.11.0');
        
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
     * Get market candles (OHLCV)
     * @param {string} baseAssetId
     * @param {string} quoteAssetId
     * @param {number} periodSeconds
     * @param {string} startDate
     * @param {string} endDate
     */
    async getMarketCandles(baseAssetId, quoteAssetId, periodSeconds, startDate, endDate) {
        await waitForConnected();
        // Ensure ISO strings are converted if API expects specific format
        // get_market_history expects ISO strings usually
        return await BitShares.history.get_market_history(
            baseAssetId,
            quoteAssetId,
            periodSeconds,
            startDate,
            endDate
        );
    }
}

module.exports = new BlockchainSource();
