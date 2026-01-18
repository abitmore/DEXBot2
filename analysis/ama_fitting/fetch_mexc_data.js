/**
 * MEXC DATA FETCHER
 *
 * ⚠️  DATA: 4-HOUR CANDLES ONLY
 *
 * Fetches 4-hour candles from MEXC for:
 * - XRP/USDT (500 candles, ~83 days)
 * - BTS/USDT (500 candles, ~83 days)
 *
 * Then calculates synthetic pair:
 * - XRP/BTS = XRP price / BTS price
 * - High = XRP_high / BTS_low (maximize ratio)
 * - Low = XRP_low / BTS_high (minimize ratio)
 *
 * Output:
 * - data/XRP_USDT.json
 * - data/BTS_USDT.json
 * - data/XRP_BTS_SYNTHETIC.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function fetchFromMEXC(symbol) {
    return new Promise((resolve, reject) => {
        console.log(`  Fetching ${symbol} 4h candles from MEXC...`);

        // MEXC API endpoint for klines
        // interval: 4h, limit: 500 (max is 1000, but we want recent ~500)
        const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=500`;

        https.get(url, { timeout: 10000 }, (res) => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(data);

                    if (!Array.isArray(json) || json.length === 0) {
                        throw new Error(`No data for ${symbol}`);
                    }

                    // MEXC klines format: [time, open, high, low, close, volume, ...]
                    const candles = json.map(candle => [
                        parseInt(candle[0]),  // timestamp
                        parseFloat(candle[1]),  // open
                        parseFloat(candle[2]),  // high
                        parseFloat(candle[3]),  // low
                        parseFloat(candle[4]),  // close
                        parseFloat(candle[5])   // volume
                    ]);

                    console.log(`    ✓ Fetched ${candles.length} 4h candles for ${symbol}`);
                    resolve(candles);
                } catch (e) {
                    reject(new Error(`${symbol}: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

function generateSyntheticPair(xrpData, btsData) {
    // Create maps for quick lookup
    const xrpMap = new Map();
    const btsMap = new Map();

    xrpData.forEach(candle => xrpMap.set(candle[0], candle));
    btsData.forEach(candle => btsMap.set(candle[0], candle));

    // Find common timestamps
    const commonTimestamps = [];
    for (const [ts, xrp] of xrpMap) {
        if (btsMap.has(ts)) {
            commonTimestamps.push(ts);
        }
    }

    console.log(`\n  Common timestamps: ${commonTimestamps.length}`);

    // Sort by timestamp
    commonTimestamps.sort((a, b) => a - b);

    // Calculate XRP/BTS for each common timestamp
    // XRP/BTS = XRP / BTS
    // High = XRP_high / BTS_low (maximize ratio)
    // Low = XRP_low / BTS_high (minimize ratio)
    const synthetic = [];

    for (const ts of commonTimestamps) {
        const xrp = xrpMap.get(ts);
        const bts = btsMap.get(ts);

        synthetic.push([
            ts,
            xrp[1] / bts[1],  // open: XRP_open / BTS_open
            xrp[2] / bts[3],  // high: XRP_high / BTS_low
            xrp[3] / bts[2],  // low: XRP_low / BTS_high
            xrp[4] / bts[4],  // close: XRP_close / BTS_close
            0  // volume (combined, set to 0)
        ]);
    }

    return synthetic;
}

async function run() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        console.log('Fetching 4-hour candle data from MEXC...\n');

        // Fetch both pairs
        const [xrpData, btsData] = await Promise.all([
            fetchFromMEXC('XRPUSDT'),
            fetchFromMEXC('BTSUSDT')
        ]);

        console.log(`\nData fetched:`);
        console.log(`  XRP/USDT: ${xrpData.length} candles (oldest: ${new Date(xrpData[0][0]).toISOString()}, newest: ${new Date(xrpData[xrpData.length - 1][0]).toISOString()})`);
        console.log(`  BTS/USDT: ${btsData.length} candles (oldest: ${new Date(btsData[0][0]).toISOString()}, newest: ${new Date(btsData[btsData.length - 1][0]).toISOString()})`);

        // Generate XRP/BTS synthetic pair
        console.log('\nGenerating XRP/BTS synthetic pair...');
        const synthetic = generateSyntheticPair(xrpData, btsData);

        // Save all three
        fs.writeFileSync(
            path.join(DATA_DIR, 'XRP_USDT.json'),
            JSON.stringify(xrpData, null, 2)
        );
        fs.writeFileSync(
            path.join(DATA_DIR, 'BTS_USDT.json'),
            JSON.stringify(btsData, null, 2)
        );
        fs.writeFileSync(
            path.join(DATA_DIR, 'XRP_BTS_SYNTHETIC.json'),
            JSON.stringify(synthetic, null, 2)
        );

        console.log(`\n✅ Data saved:`);
        console.log(`   - data/XRP_USDT.json (${xrpData.length} 4h candles)`);
        console.log(`   - data/BTS_USDT.json (${btsData.length} 4h candles)`);
        console.log(`   - data/XRP_BTS_SYNTHETIC.json (${synthetic.length} 4h candles)`);

        console.log(`\nSynthetic pair date range:`);
        console.log(`  Start: ${new Date(synthetic[0][0]).toISOString()}`);
        console.log(`  End:   ${new Date(synthetic[synthetic.length - 1][0]).toISOString()}`);
        console.log(`  Total: ${(synthetic.length * 4 / 24).toFixed(1)} days of data`);

        console.log('\n✓ Ready for optimization!');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    }
}

run();
