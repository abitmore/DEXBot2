const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');

async function fetchData() {
    const exchange = new ccxt.mexc({
        'enableRateLimit': true,
    });

    const pairs = ['BTS/USDT', 'XRP/USDT'];
    const timeframe = '5m'; // 5-minute candles to capture "quick movements"
    const limit = 1000; // Number of candles to fetch

    console.log(`Using exchange: ${exchange.id}`);

    for (const symbol of pairs) {
        console.log(`Fetching ${symbol} (${timeframe})...`);
        try {
            // fetchOHLCV (symbol, timeframe, since, limit, params)
            const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
            
            // Format: [timestamp, open, high, low, close, volume]
            const filename = symbol.replace('/', '_') + '.json';
            const filepath = path.join(__dirname, 'data', filename);

            fs.writeFileSync(filepath, JSON.stringify(ohlcv, null, 2));
            console.log(`Saved ${ohlcv.length} candles to ${filepath}`);
        } catch (error) {
            console.error(`Error fetching ${symbol}:`, error.message);
        }
    }
}

fetchData();
