const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('../modules/bitshares_client');
const blockchainSource = require('./blockchain_source');
const { calculateAMA } = require('../analysis/ama_fitting/ama');

// Default config
const MONITOR_CONFIG = {
    pollInterval: 60000, // 1 minute
    amaConfig: {
        erPeriod: 10,
        fastPeriod: 2,
        slowPeriod: 30
    }
};

async function runMonitor() {
    console.log('Starting Market Adapter Monitor...');
    
    try {
        await waitForConnected();
        console.log('Connected to BitShares.');

        // 1. Identify Target Bots/Accounts
        // Try to read profiles/bots.json, fall back to examples if needed
        let botsConfigPath = path.join(__dirname, '../profiles/bots.json');
        if (!fs.existsSync(botsConfigPath)) {
            console.warn('profiles/bots.json not found, using examples/bots.json');
            botsConfigPath = path.join(__dirname, '../examples/bots.json');
        }

        let botsConfig = JSON.parse(fs.readFileSync(botsConfigPath, 'utf8'));
        
        // Handle format { bots: [...] } vs [...] 
        let botsArray = [];
        if (Array.isArray(botsConfig)) {
            botsArray = botsConfig;
        } else if (botsConfig.bots && Array.isArray(botsConfig.bots)) {
            botsArray = botsConfig.bots;
        }

        const activeBots = botsArray.filter(b => b.active);

        console.log(`Found ${activeBots.length} active bots.`);

        for (const bot of activeBots) {
            console.log(`\nAnalyzing Bot: ${bot.name} (${bot.preferredAccount})`);
            
            // 2. Fetch Blockchain Metrics (Fills)
            // Use preferredAccount
            const accountName = bot.preferredAccount;
            if (accountName) {
                const fills = await blockchainSource.getRecentFills(accountName);
                console.log(`  - Recent fills: ${fills.length}`);
                
                if (fills.length > 0) {
                    const recentFill = fills[fills.length - 1]; // Oldest to Newest usually?
                    // Actually, let's verify sort order if we were doing this for real.
                    // But for logs:
                    console.log(`    Last fill ID: ${recentFill.id} at ${recentFill.block_time}`);
                }
            } else {
                console.log('  - No preferredAccount specified, skipping fill history.');
            }

            // 3. Fetch Market Data for AMA
            if (bot.assetA && bot.assetB) {
                 console.log(`  - Asset Pair: ${bot.assetA}/${bot.assetB}`);
                 
                 const assets = await blockchainSource.resolveAssetIds([bot.assetA, bot.assetB]);
                 const assetA = assets[bot.assetA];
                 const assetB = assets[bot.assetB];

                 if (assetA && assetB) {
                     // Fetch Candles
                     const bucketSize = 3600; // 1h
                     const now = new Date();
                     const start = new Date(now - 100 * bucketSize * 1000).toISOString().split('.')[0]; // 100h ago
                     const end = now.toISOString().split('.')[0];

                     const candles = await blockchainSource.getMarketCandles(
                         assetA.id, 
                         assetB.id, 
                         bucketSize, 
                         start, 
                         end
                     );

                     if (candles && candles.length > 0) {
                        const closes = candles.map(c => {
                            let valBase = c.close_base;
                            let valQuote = c.close_quote;
                            let precBase = 0;
                            let precQuote = 0;

                            // Identify which asset is base/quote in the candle key
                            if (c.key.base === assetA.id) {
                                precBase = assetA.precision;
                                precQuote = assetB.precision;
                            } else {
                                precBase = assetB.precision;
                                precQuote = assetA.precision;
                            }

                            const amountBase = valBase / Math.pow(10, precBase);
                            const amountQuote = valQuote / Math.pow(10, precQuote);
                            
                            // We want Price of Asset A in terms of Asset B.
                            // If candle base is Asset A, then Price = Quote / Base ? 
                            // Usually Market is Base/Quote.
                            // If market is BTS/USD. Base=BTS, Quote=USD. Price is USD per BTS.
                            // Price = AmountQuote / AmountBase.
                            
                            // Here we want price of A (IOB.XRP) in B (BTS).
                            // If candle base is IOB.XRP (A), quote is BTS (B).
                            // Price = AmountB / AmountA.
                            
                            if (c.key.base === assetA.id) {
                                return amountQuote / amountBase;
                            } else {
                                // Candle base is B, quote is A.
                                // Price = AmountB / AmountA = AmountBase / AmountQuote.
                                return amountBase / amountQuote;
                            }
                        });

                        const amas = calculateAMA(closes, MONITOR_CONFIG.amaConfig);
                        const currentAMA = amas[amas.length - 1];
                        const currentPrice = closes[closes.length - 1];

                        console.log(`    Current Price: ${currentPrice}`);
                        console.log(`    Current AMA:   ${currentAMA.toFixed(8)}`);
                        
                        const deviation = ((currentPrice - currentAMA) / currentAMA) * 100;
                        console.log(`    Deviation:     ${deviation.toFixed(2)}%`);

                        // Metric: Divergence from AMA
                        if (Math.abs(deviation) > 2) {
                            console.log('    >> High Volatility Detected (Price > 2% from AMA)');
                        }
                     } else {
                         console.log('    (No market history found)');
                     }
                 } else {
                     console.log('    (Could not resolve asset IDs)');
                 }
            }
        }
        
        process.exit(0);

    } catch (error) {
        console.error('Monitor Error:', error);
        process.exit(1);
    }
}

// If running directly
if (require.main === module) {
    runMonitor();
}

module.exports = { runMonitor };