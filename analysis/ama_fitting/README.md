# AMA Optimization: High-Resolution Tuning for Grid Trading

## Overview

This directory contains high-resolution optimization tools for tuning Kaufman's Adaptive Moving Average (KAMA) parameters for grid trading on XRP/BTS synthetic pair.

**Current Optimal Configuration**: **ER=107, Fast=2, Slow=30**
- **Combined Score**: 78.8/100 (Best balance of opportunity + efficiency)
- **Oscillation Area**: 38.85% (good trading opportunities)
- **Fill Efficiency**: 50.0% (perfect order matching)

---

## Quick Start (2 Steps)

### 1. Run High-Resolution Optimization

```bash
node optimizer_high_resolution.js
```

Tests **18,711 combinations** with fractional parameters (74x more than before!)

- ER range: 2 to 150 (step 0.5)
- Fast range: 2 to 5 (step 0.5)
- Slow range: 10 to 30 (step 2.5)

**Output**: `optimization_results_high_resolution.json` (all results ranked)

### 2. Generate Unified Comparison Chart

```bash
node generate_unified_comparison_chart.js
```

Creates one interactive HTML chart showing all three strategies.

**Output**: `chart_4h_UNIFIED_COMPARISON.html` (open in browser)

---

## Current Tools (Streamlined & Focused)

| Tool | Purpose | Output |
|------|---------|--------|
| **optimizer_high_resolution.js** | Tests 18,711 parameter combinations | `optimization_results_high_resolution.json` |
| **generate_unified_comparison_chart.js** | Creates 3-strategy comparison | `chart_4h_UNIFIED_COMPARISON.html` |
| **fetch_mexc_data.js** | Fetches market data from MEXC | `data/XRP_*.json` |
| **ama.js** | Core AMA calculation engine | (Used by optimizers) |

---

## The Three Strategies (All in One Chart)

Open `chart_4h_UNIFIED_COMPARISON.html` to see all three:

### 🟠 Orange (Solid) - MAX AREA (ER=40)
```
Area: 47.10% | Fill: 49.5% | Max UP: 29.16%
Best for: Maximum trading opportunities
```

### 🟢 Green (Dotted) - MAX EFFICIENCY (ER=15)
```
Area: 40.79% | Fill: 50.0% | Max UP: 26.26%
Best for: Reliable order matching
```

### 🔵 Blue (Dashed) - BALANCED OPTIMAL (ER=107) ⭐
```
Area: 38.85% | Fill: 50.0% | Combined: 78.8/100
Best for: Maximum profit per trade (Recommended)
```

---

## High-Resolution Advantage

**Why 18,711 combinations instead of 252?**

Old approach (integer-only):
- Tested: ER=100, ER=120
- **Missed**: ER=107 in the gap!

New approach (fractional, step 0.5):
- Tests: ER=100, ER=100.5, ER=101, ..., ER=107, ... ER=120
- **Finds**: ER=107.0 = 78.8/100 (0.8% better!)

**Result**: Found better configuration by testing 74x more combinations!

---

## AMA Parameters Explained

```javascript
const AMA_CONFIG = {
  erPeriod: 107,        // Efficiency Ratio lookback
  fastPeriod: 2,        // Fast smoothing when trending
  slowPeriod: 30,       // Slow smoothing when choppy
  gridSpacing: 0.008    // 0.8% between grid levels
};
```

### How They Work

**erPeriod (107)**: Measures trend strength over last N candles
- ER = Direction / Volatility
- If trending (high ER) → Use fastPeriod
- If choppy (low ER) → Use slowPeriod

**fastPeriod (2)** & **slowPeriod (30)**: Control adaptation range
- Smoothing Constant: SC = (ER × (fastSC - slowSC) + slowSC)²
- AMA automatically selects speed between fastest and slowest

---

## Key Metrics

| Metric | ER=40 | ER=15 | ER=107 | Meaning |
|--------|-------|-------|--------|---------|
| **Area** | 47.10% | 40.79% | 38.85% | Oscillation space (higher = more opportunities) |
| **Fill %** | 49.5% | 50.0% | 50.0% | Order matching rate |
| **Max UP** | 29.16% | 26.26% | 28.04% | Highest price above AMA |
| **Max DOWN** | 11.02% | 12.66% | 15.08% | Lowest price below AMA |
| **Combined** | 51.5 | 59.8 | **78.8** | Normalized average score |

---

## Monthly Reoptimization Workflow

```bash
# 1. Fetch fresh data
node fetch_mexc_data.js

# 2. Run optimizer with new data
node optimizer_high_resolution.js

# 3. Generate updated chart
node generate_unified_comparison_chart.js

# 4. Review metrics in right panel of HTML chart

# 5. Deploy best ER value to production
```

---

## Deployment Guide

### Choose Your Strategy

**Maximum Opportunities:**
```javascript
const AMA_CONFIG = {
  erPeriod: 40,
  fastPeriod: 5,
  slowPeriod: 30,
  gridSpacing: 0.008
};
// Result: 47.10% area, but only 49.5% fill efficiency
```

**Maximum Reliability:**
```javascript
const AMA_CONFIG = {
  erPeriod: 15,
  fastPeriod: 5,
  slowPeriod: 30,
  gridSpacing: 0.008
};
// Result: 40.79% area with 50% fill efficiency
```

**Best Balance (Recommended):**
```javascript
const AMA_CONFIG = {
  erPeriod: 107,
  fastPeriod: 2,
  slowPeriod: 30,
  gridSpacing: 0.008
};
// Result: 38.85% area, 50% fill efficiency, 78.8/100 score
```

---

## How AMA Works

### Basic Formula

```
ER = direction / volatility           (trend strength 0-1)
SC = (ER × (fastSC - slowSC) + slowSC)²  (smoothing constant)
AMA = prevAMA + SC × (price - prevAMA)    (adaptive average)
```

### Why It's Powerful

- **Trending market**: ER high → SC large → AMA moves fast (follows trend)
- **Choppy market**: ER low → SC small → AMA moves slow (filters noise)
- **Same parameter** automatically adapts to market conditions!

---

## Files in This Directory

### Tools
- `optimizer_high_resolution.js` - Main optimization engine
- `generate_unified_comparison_chart.js` - Chart generator
- `fetch_mexc_data.js` - Data fetcher
- `ama.js` - Core AMA calculation

### Data (in `/data`)
- `XRP_USDT.json` - 500 4h XRP candles from MEXC
- `BTS_USDT.json` - 500 4h BTS candles from MEXC
- `XRP_BTS_SYNTHETIC.json` - Calculated XRP/BTS pairs

### Results
- `optimization_results_high_resolution.json` - All 18,711 configurations ranked

### Output
- `chart_4h_UNIFIED_COMPARISON.html` - Interactive visualization

### Documentation
- `README.md` - This file
- `CALCULATION_GUIDE.md` - Technical deep dive
- `HIGH_RESOLUTION_ANALYSIS.md` - Latest optimization findings

---

## Understanding the Chart

**Open `chart_4h_UNIFIED_COMPARISON.html` in your browser**

### Features
- ✅ All three strategies overlaid for comparison
- ✅ Color-coded AMAs (orange/green/blue)
- ✅ Grid bands shown for each strategy
- ✅ Interactive legend (click to toggle)
- ✅ Metrics panel with comparison data
- ✅ Hover for exact values
- ✅ Zoom and pan capabilities

### How to Read It

1. **Look at candlesticks** - Green=up, Red=down
2. **See three AMAs** - How each adapts differently
3. **Check grid bands** - Dashed lines show risk zones
4. **Compare visually** - Which strategy fits your preference?
5. **Check metrics panel** - Exact numbers on right side

---

## Data Source

- **Exchange**: MEXC
- **Pair**: XRP/USDT + BTS/USDT → XRP/BTS synthetic
- **Timeframe**: 4-hour candles
- **History**: 500 candles (83.3 days)
- **Date Range**: 2025-10-26 to 2026-01-17

---

## Technical Details

### Oscillation Space Calculation

For each candle:
```
Distance UP = (candle_high - AMA) / AMA
Distance DOWN = (AMA - candle_low) / AMA
```

Sum across all candles:
```
Total Area = Σ(Distance UP) + Σ(Distance DOWN)
```

Higher area = more trading opportunities

### Fill Efficiency Calculation

Track grid level matching:
```
5 grid levels: ±0.8%, ±1.6%, ±2.4%, ±3.2%, ±4.0%

If candle touches buy level AND sell level exists at same level:
  → Match found, increment matched count

Fill Efficiency = Matched Pairs / Total Orders
Target: 50% (half of orders pair naturally)
```

---

## Performance Notes

- **Optimization time**: ~30 seconds for 18,711 combinations
- **Chart generation**: ~5 seconds
- **Data loading**: ~2 seconds
- **Total monthly rerun**: ~40 seconds

---

## Status

- **Data**: Current (2026-01-17)
- **Optimization**: Complete (18,711 combinations tested)
- **Best Configuration**: ER=107, Fast=2, Slow=30
- **Combined Score**: 78.8/100
- **Ready**: Yes, production-ready

---

## Next Steps

1. **Run optimizer**: `node optimizer_high_resolution.js`
2. **Generate chart**: `node generate_unified_comparison_chart.js`
3. **Open chart**: `chart_4h_UNIFIED_COMPARISON.html`
4. **Review metrics**: Check right panel for comparison
5. **Deploy**: Choose ER=40, ER=15, or ER=107

---

**Last Updated**: 2026-01-18
**Optimal ER**: 107 (High-Resolution Optimized)
**Combined Score**: 78.8/100 ⭐
