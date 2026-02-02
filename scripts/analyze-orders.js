#!/usr/bin/env node

/**
 * DEXBot Order Analysis Script
 *
 * Analyzes all order files in profiles/orders/ sorted by modified date.
 * Provides compact terminal output checking:
 * - Real spread vs. target spread (including double-sided status)
 * - Increment value % geometric consistency between grid slots
 * - Total funds of AssetA and AssetB in the grid
 * - Grid slot distribution (% near center) vs grid composition
 *
 * Usage: node scripts/analyze-orders.js
 */

const fs = require('fs');
const path = require('path');

const ORDERS_DIR = path.join(__dirname, '../profiles/orders');
const BOTS_CONFIG = path.join(__dirname, '../profiles/bots.json');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  buy: '\x1b[32m',    // green
  sell: '\x1b[31m',   // red
  spread: '\x1b[33m', // yellow
  cyan: '\x1b[36m',   // cyan
  gray: '\x1b[90m'    // gray
};

/**
 * Utility Functions
 * Helper functions for file I/O, formatting, and data retrieval
 */

/**
 * readJSON: Load and parse JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {Object} Parsed JSON object
 */
function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * getModifiedTime: Get file modification timestamp
 * Used to sort order files by most recently updated
 * @param {string} filePath - Path to file
 * @returns {Date} Modification time
 */
function getModifiedTime(filePath) {
  return fs.statSync(filePath).mtime;
}

/**
 * formatPercent: Convert decimal to percentage string
 * Example: 0.05 -> "5.00%"
 * @param {number} value - Decimal value (0-1)
 * @returns {string} Formatted percentage with 2 decimal places
 */
function formatPercent(value) {
  return (value * 100).toFixed(2) + '%';
}

/**
 * formatCurrency: Format large numbers with compact notation
 * Handles millions (M), thousands (K), small values (6 decimals)
 * Examples: 1500000 -> "1.50M", 5500 -> "5.50K", 0.001 -> "0.001000"
 * @param {number} value - Numeric value to format
 * @returns {string} Formatted currency/quantity string
 */
function formatCurrency(value) {
  if (Math.abs(value) >= 1000000) {
    return (value / 1000000).toFixed(2) + 'M';
  } else if (Math.abs(value) >= 1000) {
    return (value / 1000).toFixed(2) + 'K';
  } else if (Math.abs(value) < 0.01) {
    return value.toFixed(6);  // High precision for small values
  }
  return value.toFixed(4);     // Standard 4 decimal places
}

// Load bot configurations
const botsConfig = readJSON(BOTS_CONFIG).bots;
function getBotConfig(name, assetA, assetB) {
  return botsConfig.find(b => b.name === name || (b.assetA === assetA && b.assetB === assetB));
}

// Get all order files sorted by modified date
function getOrderFiles() {
  const files = fs.readdirSync(ORDERS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(ORDERS_DIR, f),
      mtime: getModifiedTime(path.join(ORDERS_DIR, f))
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files;
}

/**
 * analyzeOrder: Comprehensive analysis of a single bot's order grid
 *
 * Examines all aspects of grid health:
 * - Spread: Gap between best buy and best sell vs. target
 * - Increment: Consistency of price steps between grid slots
 * - Funds: Total funds allocated to each side
 * - Distribution: Comparison of slot count vs. fund allocation
 * - Double-sided mode: Whether sides are intentionally unbalanced
 *
 * Terminology:
 * - boundaryIdx: Index of best buy slot (highest buy price)
 * - Slots > boundaryIdx are sells
 * - Slots < boundaryIdx are buys at boundary position
 * - Spread slots are outside normal grid (rare)
 *
 * @param {Object} botData - Order data with grid array and metadata
 * @param {Object} config - Bot configuration (optional) for comparison
 * @returns {Object} Analysis result with spread, increment, funds, distribution
 */
function analyzeOrder(botData, config) {
  const meta = botData.meta;
  const grid = botData.grid;
  const boundaryIdx = botData.boundaryIdx;

  /**
   * Grid Slot Separation
   * The grid contains buy slots (prices below market), sell slots (above market),
   * and optional spread slots. Separation enables independent analysis.
   */
  const buySlots = grid.filter((s, i) => i <= boundaryIdx && s.type === 'buy');
  const sellSlots = grid.filter((s, i) => i > boundaryIdx && s.type === 'sell');
  const spreadSlots = grid.filter(s => s.type === 'spread');

  /**
   * Best Prices Identification
   * bestBuySlot: Highest buy price (at boundary, closest to market)
   * bestSellSlot: Lowest sell price (first sell after boundary, closest to market)
   * The spread between these is the "real" spread of the grid
   */
  const bestBuySlot = grid[boundaryIdx];
  const bestSellSlot = grid.slice(boundaryIdx + 1).find(s => s.type === 'sell');

  /**
   * Real Spread Calculation
   * Formula: (bestSellPrice - bestBuyPrice) / bestBuyPrice
   * This is the actual gap in the market, measured as percentage from buy price
   * Example: buy=100, sell=105 -> spread = 5%
   */
  const realSpread = bestBuySlot && bestSellSlot
    ? ((bestSellSlot.price - bestBuySlot.price) / bestBuySlot.price)
    : 0;

  let spreadDiff, targetSpread, incrementCheck;

  /**
   * Config-based Comparisons
   * If bot has configuration, compare actual to target values
   * Otherwise, just report actual values
   */
  if (config) {
    // Config exists - calculate variance from target
    targetSpread = config.targetSpreadPercent / 100;
    spreadDiff = realSpread - targetSpread;
    incrementCheck = checkGeometricIncrement(grid, config.incrementPercent / 100);
  } else {
    // No config - report actual values only
    targetSpread = null;
    spreadDiff = null;
    incrementCheck = checkGeometricIncrement(grid, null);
  }

  // Calculate total funds committed to buy and sell sides
  const gridFunds = calculateGridFunds(buySlots, sellSlots, bestBuySlot, bestSellSlot);

  // Analyze how funds are distributed across slots
  const distribution = analyzeDistribution(buySlots, sellSlots, bestBuySlot, bestSellSlot);

  // Calculate grid extremes and market price
  const gridMinPrice = grid.length > 0 ? Math.min(...grid.map(s => s.price)) : null;
  const gridMaxPrice = grid.length > 0 ? Math.max(...grid.map(s => s.price)) : null;
  const marketPrice = bestBuySlot && bestSellSlot
    ? (bestBuySlot.price + bestSellSlot.price) / 2
    : null;

  /**
   * Return comprehensive analysis object
   * Includes all metrics needed for health check output
   */
  return {
    pair: `${meta.assetA}/${meta.assetB}`,
    lastUpdated: new Date(meta.updatedAt || botData.lastUpdated),
    gridMinPrice: gridMinPrice,
    marketPrice: marketPrice,
    gridMaxPrice: gridMaxPrice,
    doubleSided: botData.buySideIsDoubled || botData.sellSideIsDoubled,
    hasConfig: !!config,
    // Spread metrics
    spread: {
      real: realSpread,
      target: targetSpread,
      diff: spreadDiff,
      // Pass if within 0.1% of target (or null if no config to compare)
      pass: config ? Math.abs(spreadDiff) < 0.001 : null
    },
    // Increment consistency metrics
    increment: incrementCheck,
    // Fund allocation breakdown
    funds: gridFunds,
    // Slot vs fund distribution analysis
    distribution: distribution,
    // Slot counts for structure overview
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      spread: spreadSlots.length
    }
  };
}

/**
 * checkGeometricIncrement: Verify grid uses consistent geometric price progression
 *
 * A proper grid should have constant percentage increments between slots.
 * This function checks if increments are consistent (low standard deviation).
 *
 * Geometric increment formula:
 * increment = (nextPrice - currentPrice) / currentPrice
 * This is a percentage change from one slot to the next.
 *
 * Example with 2% increment:
 * - Slot 1: 100
 * - Slot 2: 102 (increment = 0.02 or 2%)
 * - Slot 3: 104.04 (increment = 0.02 or 2%)
 *
 * Metrics:
 * - avg: Average increment across all slots
 * - stdDev: Standard deviation (should be < 0.1% for good grids)
 * - pass: True if avg matches target and is consistent (for grids with config)
 *
 * @param {Array} grid - All grid slots
 * @param {number} targetIncrement - Target increment ratio (e.g., 0.02 for 2%)
 * @returns {Object} Increment analysis with avg, target, stdDev, consistency
 */
function checkGeometricIncrement(grid, targetIncrement) {
  // Filter out spread slots (only analyze regular buy/sell slots)
  const slots = grid.filter(s => s.type !== 'spread');

  // Need at least 2 slots to calculate increment
  if (slots.length < 2) {
    return { pass: null, avgIncrement: 0, consistent: true, target: targetIncrement };
  }

  /**
   * Calculate increment for each consecutive pair of slots
   * Increment = percentage change from previous to current price
   */
  const increments = [];
  for (let i = 1; i < slots.length; i++) {
    const prevPrice = slots[i - 1].price;
    const currPrice = slots[i].price;
    // Relative price change as decimal (0.02 = 2%)
    const increment = (currPrice - prevPrice) / prevPrice;
    increments.push(increment);
  }

  /**
   * Statistical Analysis
   * Average: Mean of all increments
   * Standard deviation: Measure of variability (lower = more consistent)
   */
  const avgIncrement = increments.reduce((a, b) => a + b) / increments.length;

  // Calculate standard deviation (measure of consistency)
  const stdDev = Math.sqrt(
    increments.reduce((sum, inc) => sum + Math.pow(inc - avgIncrement, 2), 0) / increments.length
  );

  return {
    avg: avgIncrement,                    // Actual average increment
    target: targetIncrement,              // Expected increment from config
    // Difference from target (null if no config)
    diff: targetIncrement ? avgIncrement - targetIncrement : null,
    stdDev: stdDev,                       // Consistency metric
    // Grid is "consistent" if std dev < 0.1%
    consistent: stdDev < 0.001,
    // Pass if matches target AND is consistent (null if no config)
    pass: targetIncrement ? (Math.abs(avgIncrement - targetIncrement) < 0.0001 && stdDev < 0.001) : null
  };
}

/**
 * calculateGridFunds: Calculate total funds in buy and sell sides
 *
 * Currency Note:
 * - Buy slot sizes: Measured in AssetB (quote currency, e.g., BTS)
 *   Each buy slot uses quote currency to purchase base currency
 * - Sell slot sizes: Measured in AssetA (base currency, e.g., XRP)
 *   Each sell slot holds base currency ready to sell
 *
 * Conversion logic:
 * - BTS fund in buy side represents potential XRP purchase: totalBTS / avgBuyPrice
 * - XRP fund in sell side converts to BTS equivalent: totalXRP * avgSellPrice
 *
 * @param {Array} buySlots - Buy order slots
 * @param {Array} sellSlots - Sell order slots
 * @param {Object} bestBuySlot - Best (highest) buy price slot
 * @param {Object} bestSellSlot - Best (lowest) sell price slot
 * @returns {Object} Fund breakdown {buy: {bts, xrp}, sell: {xrp, bts}}
 */
function calculateGridFunds(buySlots, sellSlots, bestBuySlot, bestSellSlot) {
  /**
   * Direct Fund Aggregation
   * Sum all slot sizes on each side
   * Buy slots: Total BTS committed
   * Sell slots: Total XRP (or base currency) available
   */
  const totalBTS = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalXRP = sellSlots.reduce((sum, s) => sum + s.size, 0);

  /**
   * Cross-Asset Fund Representation
   * Calculate how much of each asset each side could represent
   * Using average prices as conversion rate
   */
  const avgBuyPrice = buySlots.length > 0
    ? buySlots.reduce((sum, s) => sum + s.price, 0) / buySlots.length
    : 0;
  const avgSellPrice = sellSlots.length > 0
    ? sellSlots.reduce((sum, s) => sum + s.price, 0) / sellSlots.length
    : 0;

  // How much XRP the buy-side BTS could purchase (at avg buy price)
  const totalXRPFromBuy = totalBTS / (avgBuyPrice || 1);
  // How much BTS the sell-side XRP could generate (at avg sell price)
  const totalBTSFromSell = totalXRP * (avgSellPrice || 1);

  return {
    // Buy side: funds dedicated to purchasing base currency
    buy: {
      bts: totalBTS,            // Direct BTS allocation
      xrp: totalXRPFromBuy      // Equivalent XRP buying power
    },
    // Sell side: funds available to sell base currency
    sell: {
      xrp: totalXRP,            // Direct XRP holdings
      bts: totalBTSFromSell     // Equivalent BTS revenue potential
    }
  };
}

/**
 * getDeltaColor: Return color code based on delta percentage value
 * Under 10%: green, 10-20%: yellow, over 20%: red
 * @param {number} deltaValue - The delta percentage value
 * @returns {string} Color code
 */
function getDeltaColor(deltaValue) {
  if (deltaValue < 10) return colors.buy;      // green
  if (deltaValue <= 20) return colors.spread;  // yellow
  return colors.sell;                          // red
}

/**
 * createDistributionBar: Create a horizontal bar chart showing BUY/SELL/spread distribution
 * @param {number} buySlots - Percentage of buy slots
 * @param {number} spreadSlots - Percentage of spread slots
 * @param {number} sellSlots - Percentage of sell slots
 * @returns {string} Colored bar visualization
 */
function createDistributionBar(buySlots, spreadSlots, sellSlots) {
  const barWidth = 50; // total width in characters
  const total = buySlots + spreadSlots + sellSlots;

  // Calculate widths proportionally
  let buyWidth = Math.round((buySlots / total) * barWidth);
  let spreadWidth = Math.round((spreadSlots / total) * barWidth);
  let sellWidth = Math.round((sellSlots / total) * barWidth);

  // Ensure spread is visible if it exists
  if (spreadSlots > 0 && spreadWidth === 0) {
    spreadWidth = 1;
    if (sellWidth > 0) {
      sellWidth -= 1;
    } else if (buyWidth > 0) {
      buyWidth -= 1;
    }
  }

  // Adjust to ensure total is exactly barWidth
  const sum = buyWidth + spreadWidth + sellWidth;
  if (sum !== barWidth) {
    const diff = barWidth - sum;
    sellWidth += diff;
  }

  const buyBar = colors.buy + '█'.repeat(buyWidth) + colors.reset;
  const spreadBar = '\x1b[97m' + '█'.repeat(spreadWidth) + colors.reset; // white
  const sellBar = colors.sell + '█'.repeat(sellWidth) + colors.reset;

  return `${buyBar}${spreadBar}${sellBar}`;
}

/**
 * analyzeDistribution: Compare slot distribution vs fund distribution
 *
 * Identifies imbalances between:
 * - Slot distribution: How many buy vs sell slots exist
 * - Fund distribution: How much funds are allocated to buy vs sell
 *
 * These should ideally match:
 * - If 50% slots are buy, ~50% of funds should be on buy side
 * - Deviation suggests intentional weighting or uneven fees
 *
 * Example:
 * - 100 total slots: 40 buy + 60 sell = 40% buy slots
 * - Funds: 6000 BTS buy + 4000 BTS sell equivalent = 60% buy funds
 * - Delta buy: |40% - 60%| = 20% (funds weight more toward buy)
 *
 * @param {Array} buySlots - Buy order slots
 * @param {Array} sellSlots - Sell order slots
 * @param {Object} bestBuySlot - Best buy price (unused but kept for compatibility)
 * @param {Object} bestSellSlot - Best sell price (unused but kept for compatibility)
 * @returns {Object} Distribution analysis with slot%, fund%, and deltas
 */
function analyzeDistribution(buySlots, sellSlots, bestBuySlot, bestSellSlot) {
  /**
   * Slot Distribution
   * Simple count: what percentage of total slots are buy vs sell
   */
  const totalSlots = buySlots.length + sellSlots.length;
  const buySlotPercent = totalSlots > 0 ? (buySlots.length / totalSlots) * 100 : 0;
  const sellSlotPercent = totalSlots > 0 ? (sellSlots.length / totalSlots) * 100 : 0;

  /**
   * Fund Distribution
   * Calculate total funds on each side, convert to common currency basis
   * This shows if sides have equal capital or if one is prioritized
   */
  const totalBuyFunds = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalSellFunds = sellSlots.reduce((sum, s) => sum + s.size, 0);

  /**
   * Currency Conversion for Comparison
   * Buy side funds: Measured in AssetB (quote)
   * Sell side funds: Measured in AssetA (base)
   * Convert both to common basis using average prices
   */
  const avgBuyPrice = buySlots.length > 0
    ? buySlots.reduce((sum, s) => sum + s.price, 0) / buySlots.length
    : 1;
  const avgSellPrice = sellSlots.length > 0
    ? sellSlots.reduce((sum, s) => sum + s.price, 0) / sellSlots.length
    : 1;

  // Convert sell-side funds (XRP) to quote currency equivalent (BTS)
  // This allows apples-to-apples fund comparison
  const sellFundsInBTS = totalSellFunds * avgSellPrice;
  const totalFunds = totalBuyFunds + sellFundsInBTS;

  /**
   * Fund Percentage
   * What % of total funds are allocated to buy vs sell
   */
  const buyFundPercent = totalFunds > 0 ? (totalBuyFunds / totalFunds) * 100 : 0;
  const sellFundPercent = totalFunds > 0 ? (sellFundsInBTS / totalFunds) * 100 : 0;

  return {
    // Slot-level breakdown
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      buyPercent: buySlotPercent,
      sellPercent: sellSlotPercent
    },
    // Fund-level breakdown (in common currency)
    funds: {
      buyPercent: buyFundPercent,
      sellPercent: sellFundPercent
    },
    // Delta: difference between slot% and fund% (shows imbalance)
    // If match is 0, slots and funds are perfectly balanced
    // If match is high, one side is over/under-weighted in funds
    match: {
      buyDiff: Math.abs(buySlotPercent - buyFundPercent),
      sellDiff: Math.abs(sellSlotPercent - sellFundPercent)
    }
  };
}

/**
 * formatAnalysis: Format analysis results into readable console output
 *
 * Creates a compact, emoji-enriched display of all analysis metrics.
 * Each line is designed to fit in typical terminal width.
 *
 * Output layout:
 * 📊 PAIR
 *    Updated: [timestamp]
 *    [warnings if applicable]
 *    Spread: [status] [real]% (target: [target]%) [direction][delta]
 *    Increment: [status] [avg]% (target: [target]%) [direction][delta] σ=[stddev]
 *    Slots: [buy] buy + [spread] spread + [sell] sell
 *    Grid: BUY [amount] QUOTE ≈ [amount] BASE
 *           SELL [amount] BASE ≈ [amount] QUOTE
 *    Dist: BUY slots [%] vs funds [%] (Δ[diff]%) | SELL slots [%] vs funds [%] (Δ[diff]%)
 *
 * Symbols:
 * ✓ = passes threshold
 * ✗ = exceeds threshold (needs attention)
 * ↓ = value is lower than target
 * ↑ = value is higher than target
 * σ = standard deviation (consistency)
 * Δ = delta (difference)
 *
 * @param {Object} analysis - Analysis result object from analyzeOrder()
 * @returns {string} Formatted multi-line output ready for console.log
 */
function formatAnalysis(analysis) {
  const lines = [];

  // Header: Trading pair name
  lines.push(`\n${colors.cyan}📊 ${analysis.pair}${colors.reset}`);
  lines.push(`   Update: ${analysis.lastUpdated.toLocaleString()}`);

  // Warning: No config available for comparison
  if (!analysis.hasConfig) {
    lines.push(`   ${colors.gray}⚠️  No config found - showing grid data only${colors.reset}`);
  }

  /**
   * Spread Analysis
   * Shows: actual spread vs target spread
   * Status: ✓ if within 0.1% of target, ✗ if not
   * Direction: ↑ if above target, ↓ if below target
   */
  if (analysis.hasConfig) {
    lines.push(
      `   Spread:${formatPercent(analysis.spread.real).padStart(6)} (target: ${formatPercent(analysis.spread.target)})`
    );
  } else {
    lines.push(`   Spread:${formatPercent(analysis.spread.real).padStart(6)}`);
  }

  // Warning: Double-sided mode (intentional buy/sell imbalance)
  if (analysis.doubleSided) {
    lines.push(`   ⚠️  Double-sided mode`);
  }

  /**
   * Increment Analysis
   * Shows: actual increment vs target
   * Status: ✓ if within tolerance and consistent, ✗ otherwise
   * σ (sigma): Standard deviation - measure of consistency
   *   Low σ (<0.1%) = consistent geometric progression
   *   High σ (>0.5%) = irregular slot spacing
   */
  if (analysis.hasConfig) {
    lines.push(
      `   Incr.: ${formatPercent(analysis.increment.avg).padStart(6)} (target: ${formatPercent(analysis.increment.target)})`
    );
  } else {
    lines.push(`   Incr.: ${formatPercent(analysis.increment.avg).padStart(6)}`);
  }

  // Price Range
  const priceRange = analysis.gridMinPrice && analysis.marketPrice && analysis.gridMaxPrice
    ? `${colors.buy}${formatCurrency(analysis.gridMinPrice)}${colors.reset} - ${formatCurrency(analysis.marketPrice)} - ${colors.sell}${formatCurrency(analysis.gridMaxPrice)}${colors.reset}`
    : 'N/A';
  lines.push(`   Price:  ${priceRange}`);

  /**
   * Fund Allocation Breakdown
   * Shows funds in each currency (quote for buy, base for sell)
   * Also shows cross-currency equivalent for comparison
   * Example: BUY 1000 BTS ≈ 50 XRP (at avg buy price)
   */
  const [assetASymbol, assetBSymbol] = analysis.pair.split('/');
  const buyBTS = formatCurrency(analysis.funds.buy.bts);
  const buyXRP = analysis.funds.buy.xrp.toFixed(4);
  const sellXRP = analysis.funds.sell.xrp.toFixed(4);
  const sellBTS = formatCurrency(analysis.funds.sell.bts);

  // Grid Composition: Count of slots on each side
  lines.push(`   Slots:  ${colors.buy}${analysis.slots.buy} buy${colors.reset} + ${analysis.slots.spread} spread + ${colors.sell}${analysis.slots.sell} sell${colors.reset}`);

  /**
   * Distribution Analysis
   * Compares slot count % with fund allocation %
   * Shows if one side is over/under-weighted relative to slot count
   * Δ (delta) = difference between slot % and fund %
   *   Δ 0% = perfectly balanced (slots match funds)
   *   Δ 20% = significant imbalance (e.g., 40% slots but 60% funds)
   */
  const buySlotPct = analysis.distribution.slots.buyPercent.toFixed(1);
  const buyFundPct = analysis.distribution.funds.buyPercent.toFixed(1);
  const sellSlotPct = analysis.distribution.slots.sellPercent.toFixed(1);
  const sellFundPct = analysis.distribution.funds.sellPercent.toFixed(1);
  const buyMatch = analysis.distribution.match.buyDiff.toFixed(1);
  const sellMatch = analysis.distribution.match.sellDiff.toFixed(1);

  // Calculate spread slot percentage
  const totalSlots = analysis.slots.buy + analysis.slots.sell + analysis.slots.spread;
  const spreadSlotPct = totalSlots > 0 ? ((analysis.slots.spread / totalSlots) * 100).toFixed(1) : '0.0';
  // Recalculate buy/sell percentages to include spread in total
  const buySlotPctWithSpread = totalSlots > 0 ? ((analysis.slots.buy / totalSlots) * 100).toFixed(1) : '0.0';
  const sellSlotPctWithSpread = totalSlots > 0 ? ((analysis.slots.sell / totalSlots) * 100).toFixed(1) : '0.0';

  const slotDistBar = createDistributionBar(parseFloat(buySlotPctWithSpread), parseFloat(spreadSlotPct), parseFloat(sellSlotPctWithSpread));
  const fundDistBar = createDistributionBar(parseFloat(buyFundPct), 0, parseFloat(sellFundPct));

  lines.push(
    `   Slots:  ${slotDistBar}`
  );
  lines.push(
    `   Funds:  ${fundDistBar}  Δ ${buyMatch}%`
  );

  lines.push(`   Funds:  ${colors.buy}${buyBTS} ${assetBSymbol}${colors.reset} ≈ ${buyXRP} ${assetASymbol}`);
  lines.push(`           ${colors.sell}${sellXRP} ${assetASymbol}${colors.reset} ≈ ${sellBTS} ${assetBSymbol}`);

  return lines.join('\n');
}

/**
 * main: Entry point - analyze all order files and display results
 *
 * Flow:
 * 1. Get all order files from profiles/orders/ (sorted by modified date)
 * 2. For each file:
 *    - Parse order data JSON
 *    - Look up bot configuration from profiles/bots.json
 *    - Perform comprehensive analysis
 *    - Format and display results
 * 3. Handle errors gracefully (skip bad files, continue)
 * 4. Print summary statistics
 *
 * Error handling:
 * - Invalid JSON: Catch and skip file with error message
 * - Missing config: Display grid data only (no target comparisons)
 * - Empty orders directory: Display message and exit
 *
 * Output order: Files sorted by modification time (most recent first)
 * makes it easy to see which bots were most recently updated
 */
function main() {
  // Header
  console.log(`\n${colors.cyan}🔍 Order Analysis${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(70)}${colors.reset}`);

  // Get all order files sorted by modification time (newest first)
  const files = getOrderFiles();

  // Handle empty directory case
  if (files.length === 0) {
    console.log('No order files found in profiles/orders/');
    process.exit(0);
  }

  // Counters for summary statistics
  let analyzed = 0;
  let skipped = 0;

  /**
   * Process each order file
   * Try-catch ensures one bad file doesn't stop analysis of others
   */
  files.forEach((file, index) => {
    try {
      // Parse order file JSON
      const orderData = readJSON(file.path);
      // Extract bot data (typically only one bot per file)
      const botKey = Object.keys(orderData.bots)[0];
      const botData = orderData.bots[botKey];

      // Find matching configuration for this bot
      // Uses bot name or asset pair to find config
      const config = getBotConfig(botData.meta.name, botData.meta.assetA, botData.meta.assetB);

      // Analyze the order grid
      const analysis = analyzeOrder(botData, config);
      // Display formatted results
      let output = formatAnalysis(analysis);
      // Remove leading newline from first pair to avoid blank line after header
      if (index === 0) {
        output = output.replace(/^\n/, '');
        console.log(output);
        console.log('');  // Extra blank line after first batch
      } else {
        console.log(output);
      }
      analyzed++;

    } catch (error) {
      // Log error but continue processing other files
      console.error(`\n❌ Error processing ${file.name}: ${error.message}`);
      skipped++;
    }
  });

  // Summary line
  console.log(`${colors.cyan}${'='.repeat(70)}${colors.reset}`);
  console.log(`${colors.cyan}Summary: ${analyzed} analyzed, ${skipped} skipped${colors.reset}\n`);
}

// Execute analysis
main();
