/**
 * Test Trend Analyzer
 * Usage example and testing
 */

const { TrendAnalyzer } = require('../trend_analyzer');

// Example usage
async function testTrendAnalyzer() {
    console.log('=== Trend Analyzer Test ===\n');

    const analyzer = new TrendAnalyzer({
        lookbackBars: 20,
        dualAMAConfig: {
            // Fast AMA - quicker response
            fastErPeriod: 40,
            fastFastPeriod: 5,
            fastSlowPeriod: 15,
            // Slow AMA - longer trend confirmation
            slowErPeriod: 20,
            slowFastPeriod: 2,
            slowSlowPeriod: 30,
        },
    });

    // Simulate price data (uptrend)
    const uptrendPrices = [
        100, 101, 102, 101.5, 103, 104, 105, 104.5, 106, 107,
        108, 107.5, 109, 110, 111, 110.5, 112, 113, 114, 115,
        // Repeat pattern to build confidence
        116, 117, 118, 119, 120, 121, 122, 123, 124, 125,
        126, 127, 128, 129, 130, 131, 132, 133, 134, 135,
        136, 137, 138, 139, 140, 141, 142, 143, 144, 145,
        146, 147, 148, 149, 150,
    ];

    console.log('Feeding uptrend prices...\n');

    for (let i = 0; i < uptrendPrices.length; i++) {
        const price = uptrendPrices[i];
        const analysis = analyzer.update(price);

        // Print every 10 updates
        if ((i + 1) % 10 === 0) {
            console.log(`[Update ${i + 1}] Price: ${price}`);
            console.log(`  Trend: ${analysis.trend} (Confidence: ${analysis.confidence}%)`);
            console.log(`  Confirmed: ${analysis.isConfirmed}`);
            console.log(`  Bars in trend: ${analysis.barsInTrend}`);
            console.log(`  AMA Separation: ${analysis.amaSeparation.percent}%`);
            console.log('');
        }
    }

    // Final detailed analysis
    console.log('=== Final Analysis ===\n');
    const fullSnapshot = analyzer.getFullSnapshot();
    console.log(JSON.stringify(fullSnapshot, null, 2));

    // Quick status
    console.log('\n=== Status Checks ===');
    console.log(`Is Uptrend? ${analyzer.isUptrend()}`);
    console.log(`Is Downtrend? ${analyzer.isDowntrend()}`);
    console.log(`Is Neutral? ${analyzer.isNeutral()}`);
    console.log(`Simple Trend: ${JSON.stringify(analyzer.getSimpleTrend())}`);

    // Test downtrend
    console.log('\n=== Testing Downtrend ===\n');
    analyzer.reset();

    const downtrendPrices = [
        150, 149, 148, 149.5, 147, 146, 145, 145.5, 144, 143,
        142, 142.5, 141, 140, 139, 139.5, 138, 137, 136, 135,
        134, 133, 132, 131, 130, 129, 128, 127, 126, 125,
        124, 123, 122, 121, 120, 119, 118, 117, 116, 115,
        114, 113, 112, 111, 110, 109, 108, 107, 106, 105,
        104, 103, 102, 101, 100,
    ];

    for (let i = 0; i < downtrendPrices.length; i++) {
        const price = downtrendPrices[i];
        const analysis = analyzer.update(price);

        if ((i + 1) % 10 === 0) {
            console.log(`[Update ${i + 1}] Price: ${price}`);
            console.log(`  Trend: ${analysis.trend} (Confidence: ${analysis.confidence}%)`);
            console.log(`  Confirmed: ${analysis.isConfirmed}`);
            console.log('');
        }
    }

    console.log('=== Final Downtrend Status ===');
    const simpleTrend = analyzer.getSimpleTrend();
    console.log(`Trend: ${simpleTrend.trend}`);
    console.log(`Confidence: ${simpleTrend.confidence}%`);
    console.log(`Is Downtrend? ${analyzer.isDowntrend()}`);
}

// Run test
testTrendAnalyzer().catch(console.error);

// Export for use in other scripts
module.exports = { testTrendAnalyzer };
