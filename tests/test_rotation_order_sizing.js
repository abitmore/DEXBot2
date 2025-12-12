const assert = require('assert');
const Grid = require('../modules/order/grid');
const { ORDER_TYPES, DEFAULT_CONFIG } = require('../modules/order/constants');

console.log('Running rotation order sizing test...\n');

// ==========================================
// Setup: Initial Grid Configuration
// ==========================================
console.log('=== INITIAL GRID CONFIGURATION ===\n');

const config = {
    incrementPercent: 1,
    weightDistribution: { buy: 0.5, sell: 0.5 },
    activeOrders: { buy: 5, sell: 5 },
    marketPrice: 0.50,
    assetA: 'BTS',
    assetB: 'USDT'
};

console.log(`Market Price: ${config.marketPrice} USDT/BTS`);
console.log(`Active Orders: ${JSON.stringify(config.activeOrders)}`);
console.log(`Weight Distribution: ${JSON.stringify(config.weightDistribution)}`);
console.log(`Increment Percent: ${config.incrementPercent}%\n`);

// ==========================================
// Initial Order Sizes (Grid Setup)
// ==========================================
console.log('=== INITIAL GRID SIZES ===\n');

// Create mock grid orders
const initialBuyOrders = [
    { id: 'buy-0', type: ORDER_TYPES.BUY, price: 0.49, size: 0 },
    { id: 'buy-1', type: ORDER_TYPES.BUY, price: 0.48, size: 0 },
    { id: 'buy-2', type: ORDER_TYPES.BUY, price: 0.47, size: 0 },
    { id: 'buy-3', type: ORDER_TYPES.BUY, price: 0.46, size: 0 },
    { id: 'buy-4', type: ORDER_TYPES.BUY, price: 0.45, size: 0 }
];

const initialSellOrders = [
    { id: 'sell-0', type: ORDER_TYPES.SELL, price: 0.51, size: 0 },
    { id: 'sell-1', type: ORDER_TYPES.SELL, price: 0.52, size: 0 },
    { id: 'sell-2', type: ORDER_TYPES.SELL, price: 0.53, size: 0 },
    { id: 'sell-3', type: ORDER_TYPES.SELL, price: 0.54, size: 0 },
    { id: 'sell-4', type: ORDER_TYPES.SELL, price: 0.55, size: 0 }
];

// Calculate initial sizes using Grid.calculateOrderSizes
const allInitialOrders = [...initialBuyOrders, ...initialSellOrders];
const initialGridSizes = Grid.calculateOrderSizes(
    allInitialOrders,
    config,
    2000,  // 2000 BTS total for sell orders
    1000,  // 1000 USDT total for buy orders
    0,     // no min size
    0,     // no min size
    8,     // BTS precision
    3      // USDT precision
);

console.log('Initial Buy Orders (USDT allocation: 1000):');
initialGridSizes
    .filter(o => o.type === ORDER_TYPES.BUY)
    .forEach((o, i) => {
        console.log(`  ${o.id}: ${o.size.toFixed(2)} USDT @ ${o.price} (Grid slot ${i})`);
    });

const buyGridTotal = initialGridSizes
    .filter(o => o.type === ORDER_TYPES.BUY)
    .reduce((sum, o) => sum + o.size, 0);
console.log(`  TOTAL: ${buyGridTotal.toFixed(2)} USDT\n`);

console.log('Initial Sell Orders (BTS allocation: 2000):');
initialGridSizes
    .filter(o => o.type === ORDER_TYPES.SELL)
    .forEach((o, i) => {
        console.log(`  ${o.id}: ${o.size.toFixed(2)} BTS @ ${o.price} (Grid slot ${i})`);
    });

const sellGridTotal = initialGridSizes
    .filter(o => o.type === ORDER_TYPES.SELL)
    .reduce((sum, o) => sum + o.size, 0);
console.log(`  TOTAL: ${sellGridTotal.toFixed(2)} BTS\n`);

// ==========================================
// Fill Event
// ==========================================
console.log('=== FILL EVENT ===\n');

console.log('SELL Order Fill:');
console.log('  - 200 BTS sold at 0.50 USDT/BTS');
console.log('  - Proceeds: 200 × 0.50 = 100 USDT');
console.log('  - Added to availableFunds.buy\n');

console.log('BUY Order Fill:');
console.log('  - 100 USDT spent at 0.50 USDT/BTS');
console.log('  - Proceeds: 100 / 0.50 = 200 BTS');
console.log('  - Added to availableFunds.sell\n');

// ==========================================
// State After Fills
// ==========================================
console.log('=== STATE AFTER FILLS ===\n');

const availableFundsBuy = 100;   // from SELL fill proceeds
const availableFundsSell = 200;  // from BUY fill proceeds

console.log(`Available Funds Buy (USDT): ${availableFundsBuy.toFixed(2)} (from fill proceeds)`);
console.log(`Available Funds Sell (BTS): ${availableFundsSell.toFixed(2)} (from fill proceeds)\n`);

console.log(`Total Grid Buy (USDT): ${buyGridTotal.toFixed(2)} (unchanged - size updated only)`);
console.log(`Total Grid Sell (BTS): ${sellGridTotal.toFixed(2)} (unchanged - size updated only)\n`);

// ==========================================
// Rotation Calculation
// ==========================================
console.log('=== ROTATION ORDER SIZING CALCULATION ===\n');

// Calculate new rotation sizes for BUY side
console.log('Buy Side Rotation (5 new orders):');
console.log(`  Input: available = ${availableFundsBuy.toFixed(2)} USDT, grid = ${buyGridTotal.toFixed(2)} USDT`);
console.log(`  Total to distribute: ${(availableFundsBuy + buyGridTotal).toFixed(2)} USDT\n`);

const buySizesPrecision = 3;
const buyRotationSizes = Grid.calculateRotationOrderSizes(
    availableFundsBuy,
    buyGridTotal,
    5,             // 5 new rotation orders
    ORDER_TYPES.BUY,
    config,
    0,             // no min size
    buySizesPrecision
);

console.log('  Calculated Rotation Sizes:');
buyRotationSizes.forEach((size, i) => {
    console.log(`    Order ${i}: ${size.toFixed(2)} USDT`);
});

const buyRotationTotal = buyRotationSizes.reduce((a, b) => a + b, 0);
console.log(`  TOTAL DISTRIBUTED: ${buyRotationTotal.toFixed(2)} USDT\n`);

// Calculate new rotation sizes for SELL side
console.log('Sell Side Rotation (5 new orders):');
console.log(`  Input: available = ${availableFundsSell.toFixed(2)} BTS, grid = ${sellGridTotal.toFixed(2)} BTS`);
console.log(`  Total to distribute: ${(availableFundsSell + sellGridTotal).toFixed(2)} BTS\n`);

const sellSizesPrecision = 8;
const sellRotationSizes = Grid.calculateRotationOrderSizes(
    availableFundsSell,
    sellGridTotal,
    5,             // 5 new rotation orders
    ORDER_TYPES.SELL,
    config,
    0,             // no min size
    sellSizesPrecision
);

console.log('  Calculated Rotation Sizes:');
sellRotationSizes.forEach((size, i) => {
    console.log(`    Order ${i}: ${size.toFixed(2)} BTS`);
});

const sellRotationTotal = sellRotationSizes.reduce((a, b) => a + b, 0);
console.log(`  TOTAL DISTRIBUTED: ${sellRotationTotal.toFixed(2)} BTS\n`);

// ==========================================
// Final Comparison & Cache Fund Logic
// ==========================================
console.log('=== FINAL COMPARISON & CACHE FUND UPDATE ===\n');

const buyExpected = availableFundsBuy + buyGridTotal;
const buyLeftover = buyExpected - buyRotationTotal;

console.log(`Buy Side:`);
console.log(`  Available Total: ${buyExpected.toFixed(2)} USDT (available ${availableFundsBuy.toFixed(2)} + grid ${buyGridTotal.toFixed(2)})`);
console.log(`  Calculated Rotation Sizes: ${buyRotationTotal.toFixed(2)} USDT`);
console.log(`  Leftover: ${buyLeftover.toFixed(4)} USDT`);

if (buyRotationTotal < buyExpected) {
    console.log(`  → Calculated < Available: ADD ${buyLeftover.toFixed(4)} USDT to cacheFunds.buy\n`);
} else {
    console.log(`  → Calculated >= Available: cacheFunds.buy UNCHANGED\n`);
}

const sellExpected = availableFundsSell + sellGridTotal;
const sellLeftover = sellExpected - sellRotationTotal;

console.log(`Sell Side:`);
console.log(`  Available Total: ${sellExpected.toFixed(2)} BTS (available ${availableFundsSell.toFixed(2)} + grid ${sellGridTotal.toFixed(2)})`);
console.log(`  Calculated Rotation Sizes: ${sellRotationTotal.toFixed(2)} BTS`);
console.log(`  Leftover: ${sellLeftover.toFixed(4)} BTS`);

if (sellRotationTotal < sellExpected) {
    console.log(`  → Calculated < Available: ADD ${sellLeftover.toFixed(4)} BTS to cacheFunds.sell\n`);
} else {
    console.log(`  → Calculated >= Available: cacheFunds.sell UNCHANGED\n`);
}

// ==========================================
// Assertions
// ==========================================
console.log('=== ASSERTIONS ===\n');

// Check that sizes were calculated
assert(buyRotationSizes.length === 5, 'Buy rotation should have 5 sizes');
assert(sellRotationSizes.length === 5, 'Sell rotation should have 5 sizes');
console.log('✓ Correct number of rotation orders calculated');

// Check that totals are close to expected (allowing for floating point precision)
const tolerance = 0.01;
assert(Math.abs(buyRotationTotal - buyExpected) < tolerance, `Buy total should be close to ${buyExpected}`);
assert(Math.abs(sellRotationTotal - sellExpected) < tolerance, `Sell total should be close to ${sellExpected}`);
console.log('✓ Calculated totals match expected allocation (within tolerance)');

// Check that all sizes are positive
assert(buyRotationSizes.every(s => s > 0), 'All buy rotation sizes should be positive');
assert(sellRotationSizes.every(s => s > 0), 'All sell rotation sizes should be positive');
console.log('✓ All calculated sizes are positive');

// Check that larger allocations go to earlier orders (geometric weighting with weight=0.5)
const buyFirstLarger = buyRotationSizes[0] > buyRotationSizes[1];
const buyLastSmaller = buyRotationSizes[4] < buyRotationSizes[3];
assert(buyFirstLarger && buyLastSmaller, 'Buy sizes should decrease geometrically');
console.log('✓ Order sizes decrease geometrically as expected');

console.log('\n✓ All assertions passed!');
console.log('\nRotation order sizing test completed successfully.');
