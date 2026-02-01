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

// Utility functions
function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getModifiedTime(filePath) {
  return fs.statSync(filePath).mtime;
}

function formatPercent(value) {
  return (value * 100).toFixed(2) + '%';
}

function formatCurrency(value) {
  if (Math.abs(value) >= 1000000) {
    return (value / 1000000).toFixed(2) + 'M';
  } else if (Math.abs(value) >= 1000) {
    return (value / 1000).toFixed(2) + 'K';
  } else if (Math.abs(value) < 0.01) {
    return value.toFixed(6);
  }
  return value.toFixed(4);
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

// Analyze a single order
function analyzeOrder(botData, config) {
  const meta = botData.meta;
  const grid = botData.grid;
  const boundaryIdx = botData.boundaryIdx;

  // Separate buy/sell/spread slots
  const buySlots = grid.filter((s, i) => i <= boundaryIdx && s.type === 'buy');
  const sellSlots = grid.filter((s, i) => i > boundaryIdx && s.type === 'sell');
  const spreadSlots = grid.filter(s => s.type === 'spread');

  // Find best buy and best sell prices (closest to boundary)
  const bestBuySlot = grid[boundaryIdx];
  const bestSellSlot = grid.slice(boundaryIdx + 1).find(s => s.type === 'sell');

  // Calculate real spread
  const realSpread = bestBuySlot && bestSellSlot
    ? ((bestSellSlot.price - bestBuySlot.price) / bestBuySlot.price)
    : 0;

  let spreadDiff, targetSpread, incrementCheck;

  // Only calculate target comparisons if config exists
  if (config) {
    targetSpread = config.targetSpreadPercent / 100;
    spreadDiff = realSpread - targetSpread;
    incrementCheck = checkGeometricIncrement(grid, config.incrementPercent / 100);
  } else {
    targetSpread = null;
    spreadDiff = null;
    incrementCheck = checkGeometricIncrement(grid, null);
  }

  // Calculate total funds in grid
  const gridFunds = calculateGridFunds(buySlots, sellSlots, bestBuySlot, bestSellSlot);

  // Analyze distribution
  const distribution = analyzeDistribution(buySlots, sellSlots, bestBuySlot, bestSellSlot);

  return {
    pair: `${meta.assetA}/${meta.assetB}`,
    lastUpdated: new Date(meta.updatedAt || botData.lastUpdated),
    doubleSided: botData.buySideIsDoubled || botData.sellSideIsDoubled,
    hasConfig: !!config,
    spread: {
      real: realSpread,
      target: targetSpread,
      diff: spreadDiff,
      pass: config ? Math.abs(spreadDiff) < 0.001 : null
    },
    increment: incrementCheck,
    funds: gridFunds,
    distribution: distribution,
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      spread: spreadSlots.length
    }
  };
}

// Check if increment is geometric
function checkGeometricIncrement(grid, targetIncrement) {
  // Get non-spread slots
  const slots = grid.filter(s => s.type !== 'spread');
  if (slots.length < 2) {
    return { pass: null, avgIncrement: 0, consistent: true, target: targetIncrement };
  }

  const increments = [];
  for (let i = 1; i < slots.length; i++) {
    const prevPrice = slots[i - 1].price;
    const currPrice = slots[i].price;
    const increment = (currPrice - prevPrice) / prevPrice;
    increments.push(increment);
  }

  const avgIncrement = increments.reduce((a, b) => a + b) / increments.length;
  const stdDev = Math.sqrt(
    increments.reduce((sum, inc) => sum + Math.pow(inc - avgIncrement, 2), 0) / increments.length
  );

  return {
    avg: avgIncrement,
    target: targetIncrement,
    diff: targetIncrement ? avgIncrement - targetIncrement : null,
    stdDev: stdDev,
    consistent: stdDev < 0.001,
    pass: targetIncrement ? (Math.abs(avgIncrement - targetIncrement) < 0.0001 && stdDev < 0.001) : null
  };
}

// Calculate total funds in grid
function calculateGridFunds(buySlots, sellSlots, bestBuySlot, bestSellSlot) {
  // Buy slot sizes are in AssetB (BTS) - quote currency
  // Sell slot sizes are in AssetA (XRP) - base currency
  // Just sum them directly

  const totalBTS = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalXRP = sellSlots.reduce((sum, s) => sum + s.size, 0);

  // Convert to cross-asset for reference
  const avgBuyPrice = buySlots.length > 0
    ? buySlots.reduce((sum, s) => sum + s.price, 0) / buySlots.length
    : 0;
  const avgSellPrice = sellSlots.length > 0
    ? sellSlots.reduce((sum, s) => sum + s.price, 0) / sellSlots.length
    : 0;

  const totalXRPFromBuy = totalBTS / avgBuyPrice;
  const totalBTSFromSell = totalXRP * avgSellPrice;

  return {
    buy: {
      bts: totalBTS,
      xrp: totalXRPFromBuy
    },
    sell: {
      xrp: totalXRP,
      bts: totalBTSFromSell
    }
  };
}

// Analyze grid distribution vs fund ratio
function analyzeDistribution(buySlots, sellSlots, bestBuySlot, bestSellSlot) {
  const totalSlots = buySlots.length + sellSlots.length;
  const buySlotPercent = totalSlots > 0 ? (buySlots.length / totalSlots) * 100 : 0;
  const sellSlotPercent = totalSlots > 0 ? (sellSlots.length / totalSlots) * 100 : 0;

  // For funds, calculate what percentage each side represents
  const totalBuyFunds = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalSellFunds = sellSlots.reduce((sum, s) => sum + s.size, 0);

  // Convert to common basis using average prices
  const avgBuyPrice = buySlots.length > 0
    ? buySlots.reduce((sum, s) => sum + s.price, 0) / buySlots.length
    : 1;
  const avgSellPrice = sellSlots.length > 0
    ? sellSlots.reduce((sum, s) => sum + s.price, 0) / sellSlots.length
    : 1;

  // Convert sell funds (XRP) to BTS equivalent for comparison
  const sellFundsInBTS = totalSellFunds * avgSellPrice;
  const totalFunds = totalBuyFunds + sellFundsInBTS;

  const buyFundPercent = totalFunds > 0 ? (totalBuyFunds / totalFunds) * 100 : 0;
  const sellFundPercent = totalFunds > 0 ? (sellFundsInBTS / totalFunds) * 100 : 0;

  return {
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      buyPercent: buySlotPercent,
      sellPercent: sellSlotPercent
    },
    funds: {
      buyPercent: buyFundPercent,
      sellPercent: sellFundPercent
    },
    match: {
      buyDiff: Math.abs(buySlotPercent - buyFundPercent),
      sellDiff: Math.abs(sellSlotPercent - sellFundPercent)
    }
  };
}

// Format output
function formatAnalysis(analysis) {
  const lines = [];
  lines.push(`\n📊 ${analysis.pair}`);
  lines.push(`   Updated: ${analysis.lastUpdated.toLocaleString()}`);

  if (!analysis.hasConfig) {
    lines.push(`   ⚠️  No config found - showing grid data only`);
  }

  // Spread analysis
  if (analysis.hasConfig) {
    const spreadStatus = analysis.spread.pass ? '✓' : '✗';
    const spreadDir = analysis.spread.diff < 0 ? '↓' : '↑';
    lines.push(`   Spread:    ${spreadStatus} ${formatPercent(analysis.spread.real).padStart(6)} (target: ${formatPercent(analysis.spread.target)}) ${spreadDir}${formatPercent(Math.abs(analysis.spread.diff))}`);
  } else {
    lines.push(`   Spread:    ${formatPercent(analysis.spread.real).padStart(6)}`);
  }

  // Double sided
  if (analysis.doubleSided) {
    lines.push(`   ⚠️  Double-sided mode`);
  }

  // Increment analysis
  if (analysis.hasConfig) {
    const incStatus = analysis.increment.pass ? '✓' : '✗';
    const incDir = analysis.increment.diff < 0 ? '↓' : '↑';
    lines.push(`   Increment: ${incStatus} ${formatPercent(analysis.increment.avg).padStart(6)} (target: ${formatPercent(analysis.increment.target)}) ${incDir}${formatPercent(Math.abs(analysis.increment.diff))} σ=${formatPercent(analysis.increment.stdDev)}`);
  } else {
    lines.push(`   Increment: ${formatPercent(analysis.increment.avg).padStart(6)} σ=${formatPercent(analysis.increment.stdDev)}`);
  }

  // Grid composition
  lines.push(`   Slots:     ${analysis.slots.buy} buy + ${analysis.slots.spread} spread + ${analysis.slots.sell} sell`);

  // Funds summary - extract asset symbols from pair
  const [assetASymbol, assetBSymbol] = analysis.pair.split('/');
  const buyBTS = formatCurrency(analysis.funds.buy.bts);
  const buyXRP = analysis.funds.buy.xrp.toFixed(4);
  const sellXRP = analysis.funds.sell.xrp.toFixed(4);
  const sellBTS = formatCurrency(analysis.funds.sell.bts);

  lines.push(`   Grid:      BUY ${buyBTS} ${assetBSymbol} ≈ ${buyXRP} ${assetASymbol}`);
  lines.push(`            SELL ${sellXRP} ${assetASymbol} ≈ ${sellBTS} ${assetBSymbol}`);

  // Distribution - compare slot % to fund %
  const buySlotPct = analysis.distribution.slots.buyPercent.toFixed(1);
  const buyFundPct = analysis.distribution.funds.buyPercent.toFixed(1);
  const sellSlotPct = analysis.distribution.slots.sellPercent.toFixed(1);
  const sellFundPct = analysis.distribution.funds.sellPercent.toFixed(1);
  const buyMatch = analysis.distribution.match.buyDiff.toFixed(1);
  const sellMatch = analysis.distribution.match.sellDiff.toFixed(1);

  lines.push(`   Dist:      BUY slots ${buySlotPct}% vs funds ${buyFundPct}% (Δ${buyMatch}%) | SELL slots ${sellSlotPct}% vs funds ${sellFundPct}% (Δ${sellMatch}%)`);

  return lines.join('\n');
}

// Main execution
function main() {
  console.log('\n🔍 Order Analysis');
  console.log('='.repeat(70));
  console.log('Legend: ✓=pass  ✗=check  ↓=buy  ↑=sell  ~=spread  σ=std.dev');
  console.log('='.repeat(70));

  const files = getOrderFiles();

  if (files.length === 0) {
    console.log('No order files found in profiles/orders/');
    process.exit(0);
  }

  let analyzed = 0;
  let skipped = 0;

  files.forEach(file => {
    try {
      const orderData = readJSON(file.path);
      const botKey = Object.keys(orderData.bots)[0];
      const botData = orderData.bots[botKey];

      const config = getBotConfig(botData.meta.name, botData.meta.assetA, botData.meta.assetB);

      const analysis = analyzeOrder(botData, config);
      console.log(formatAnalysis(analysis));
      analyzed++;

    } catch (error) {
      console.error(`\n❌ Error processing ${file.name}: ${error.message}`);
      skipped++;
    }
  });

  console.log('='.repeat(70));
  console.log(`Summary: ${analyzed} analyzed, ${skipped} skipped\n`);
}

main();
