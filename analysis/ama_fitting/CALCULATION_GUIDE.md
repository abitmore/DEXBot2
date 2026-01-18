# AMA Optimization: Calculation Guide

## Overview of Current Scripts

You now have several optimizers that calculate different metrics. Here's how they all work:

```
optimizer_order_overlap.js
    ↓
    Calculates: Fill Efficiency (order matching)
    Method: Tracks buy/sell orders at grid levels
    Output: Which configuration matches most orders

optimizer_area_analysis.js
    ↓
    Calculates: Area Above/Below AMA + Max Distance
    Method: Sums all distance values for each candle
    Output: Oscillation space for each ER value

optimizer_edge_fitting.js
    ↓
    Calculates: Inflection point analysis
    Method: Tracks distance changes across ER values
    Output: Where the curve "elbows"

optimizer_high_lag_ama.js
    ↓
    Calculates: Maximum achievable distance
    Method: Tests very high ER values
    Output: Best high-lag configuration
```

---

## How to Find Maximum Oscillation Space

### Step 1: Understanding "Oscillation Space"

Oscillation Space = **Area Above AMA + Area Below AMA**

```
Price Movement Around AMA:

Time →

          Price high
            ↑
Area Above: │    ╱╲
            │   ╱  ╲
    ────────┼──────── AMA (baseline)
            │ ╱      ╲
Area Below: │╱        ╲
            ↓
          Price low
```

### Step 2: Running the Area Analysis

Run the area analyzer to see all ER values:

```bash
cd analysis/ama_fitting
node optimizer_area_analysis.js
```

This outputs a table showing oscillation space for each ER:

```
ER  | Area Above | Area Below | Total Area (Oscillation Space)
----|------------|------------|----------
 3  |    143.42% |    128.60% |    272.02%
 5  |    154.13% |    135.97% |    290.10%
10  |    169.68% |    146.11% |    315.79%
60  |    194.58% |    180.97% |    375.55% ← MAXIMUM
100 |    234.19% |    136.65% |    370.84%
150 |    248.31% |    119.88% |    368.19%
```

**ER=60 shows the PEAK at 375.55%**

### Step 3: Verify with the High-Lag Optimizer

Run high-lag optimizer to confirm max distance with high ER:

```bash
node optimizer_high_lag_ama.js
```

This shows that:
- ER=60 creates 3.25% max distance
- ER=400 creates 3.54% max distance (but less area)
- ER=500+ collapses (too laggy)

**Result: ER=60 is the sweet spot**

---

## Detailed Calculation Methodology

### 1. AMA Calculation (ama.js)

```javascript
// For each candle:
const er = direction / volatility;
const sc = Math.pow(er * (fast - slow) + slow, 2);
const ama = prevAMA + sc * (price - prevAMA);

Where:
- direction = |price_now - price_n_periods_ago|
- volatility = sum of all |price_i - price_i-1|
- fast = fast smoothing constant (2/(2+1))
- slow = slow smoothing constant (2/(15+1))
- sc = smoothing constant (how much to move AMA)
- ama = new AMA value
```

**ER Period Impact:**
- Low ER (e.g., 3): Sees only 3 candles, very responsive
- High ER (e.g., 60): Sees 60 candles, very laggy

---

### 2. Area Calculation (optimizer_area_analysis.js)

For each candle, measure distance from AMA:

```javascript
// Candle high above AMA
const driftUpAmount = (high - ama) / ama;
areaAbove += driftUpAmount;

// Candle low below AMA
const driftDownAmount = (ama - low) / ama;
areaBelow += driftDownAmount;  // Counted as positive

totalArea = areaAbove + areaBelow;
```

**Example:**
```
Candle:  High=1.05, Low=0.95, AMA=1.00

driftUp = (1.05 - 1.00) / 1.00 = 0.05 (5%)
driftDown = (1.00 - 0.95) / 1.00 = 0.05 (5%)

areaAbove += 0.05
areaBelow += 0.05
totalArea += 0.10 (10%)
```

Summed across all 450 candles (after 50 warmup):
- ER=3: totalArea = 272.02%
- ER=60: totalArea = 375.55%
- ER=100: totalArea = 370.84%

---

### 3. Max Distance Calculation (optimizer_edge_fitting.js)

Track the **maximum** deviation in any direction:

```javascript
for each candle {
    const driftUp = (high - ama) / ama;
    const driftDown = (ama - low) / ama;

    maxDriftUp = max(maxDriftUp, driftUp);
    maxDriftDown = max(maxDriftDown, driftDown);
}

maxTotalDistance = max(maxDriftUp, maxDriftDown);
```

**Example for ER=60:**
```
Across all 450 candles:
  Highest price was 3.25% above AMA
  Lowest price was 2.67% below AMA
  maxTotalDistance = 3.25%
```

This tells you: **Price can deviate up to 3.25% from AMA**

---

### 4. Fill Efficiency Calculation (optimizer_order_overlap.js)

Track which buy/sell orders actually match:

```javascript
for each candle {
    for each grid level {
        // Buy order triggers if price goes DOWN to buy level
        if (low <= buyLevel) {
            openOrders[buyKey] = true;
            if (openOrders[sellKey]) {
                // MATCH FOUND!
                matchedCount++;
                openOrders[buyKey] = false;
                openOrders[sellKey] = false;
            }
        }

        // Sell order triggers if price goes UP to sell level
        if (high >= sellLevel) {
            openOrders[sellKey] = true;
            if (openOrders[buyKey]) {
                // MATCH FOUND!
                matchedCount++;
                openOrders[buyKey] = false;
                openOrders[sellKey] = false;
            }
        }
    }
}

fillEfficiency = matchedCount / max(totalBuys, totalSells);
```

**Grid levels at 0.80% spacing:**
```
Level 1 BUY:  AMA × 0.992
Level 1 SELL: AMA × 1.008

Level 2 BUY:  AMA × 0.984
Level 2 SELL: AMA × 1.016

etc.
```

Example with ER=3:
- 18 buy orders placed
- 18 sell orders placed
- 18 matched pairs = 100% efficiency

Example with ER=60:
- Will have different matching pattern due to slower AMA

---

## Understanding ER=60 Metrics

### For ER=60, the calculations show:

```
INPUT DATA:
  500 candles (4-hour timeframe)
  BTS/XRP synthetic pair
  450 candles used (after 50 warmup)

CALCULATIONS:

1. AMA Line
   - Calculate AMA value for each of 450 candles
   - ER=60 means AMA sees last 60 candles
   - Result: Smooth line that lags behind price

2. Area Analysis
   - For each candle: measure (high-AMA)/AMA and (AMA-low)/AMA
   - Sum all distances
   - Result: Area Above = 194.58%, Area Below = 180.97%

3. Max Distance
   - Find highest point price reached above AMA: 3.25%
   - Find lowest point price reached below AMA: 2.67%
   - Result: Max Distance = 3.25%

4. Fill Efficiency
   - Track grid order matching with ER=60's AMA
   - See how many buy/sell orders pair up
   - Result: Varies (typically 90%+ for this ER)

OUTPUT SUMMARY FOR ER=60:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Metric                          Value
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Max Distance UP                 3.25%
Max Distance DOWN               2.67%
Area Above AMA                  194.58%
Area Below AMA                  180.97%
Total Oscillation Space         375.55%
Balance (Above/Below ratio)     1.07 (very balanced)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Step-by-Step: How to Calculate ER=60 Metrics Manually

### Example Candle Sequence:

```
Candle 1: High=1.0250, Low=0.9950, Close=1.0100
Candle 2: High=1.0180, Low=0.9980, Close=1.0050
Candle 3: High=1.0320, Low=1.0000, Close=1.0200
```

### Step 1: Calculate AMA values

With ER=60, see last 60 candles for trend analysis.

For candle 1:
```
ER = direction / volatility
   = |1.0100 - previous_60_candles_ago| / sum(daily_changes)
   = (some value between 0 and 1)

SC = (ER × (2/3 - 2/16) + 2/16)²
   = (ER × 0.111 + 0.125)²

AMA = previous_AMA + SC × (1.0100 - previous_AMA)
```

Repeated for all candles → creates smooth AMA line

### Step 2: Calculate area for each candle

For candle 1 with AMA=1.0120 (example):
```
driftUp = (1.0250 - 1.0120) / 1.0120 = 0.01285 = 1.285%
driftDown = (1.0120 - 0.9950) / 1.0120 = 0.01683 = 1.683%

Add to totals:
areaAbove += 1.285%
areaBelow += 1.683%
```

### Step 3: Accumulate for all 450 candles

Sum all driftUp values → Area Above = 194.58%
Sum all driftDown values → Area Below = 180.97%
Total = 375.55%

### Step 4: Track maximum distances

```
maxDriftUp = max(1.285%, 1.112%, ..., 3.25%) = 3.25%
maxDriftDown = max(1.683%, 1.456%, ..., 2.67%) = 2.67%
```

---

## Quick Reference: All Metrics Explained

| Metric | What It Measures | Formula | Interpretation |
|--------|------------------|---------|-----------------|
| **Area Above** | How much price stays above AMA | Σ(high-AMA)/AMA | 194.58% = lots of upside space |
| **Area Below** | How much price stays below AMA | Σ(AMA-low)/AMA | 180.97% = lots of downside space |
| **Total Area** | Overall oscillation space | Area Above + Area Below | 375.55% = maximum oscillation |
| **Max Distance UP** | Highest price reached above | max((high-AMA)/AMA) | 3.25% = price can go 3.25% above |
| **Max Distance DOWN** | Lowest price reached below | max((AMA-low)/AMA) | 2.67% = price can go 2.67% below |
| **Fill Efficiency** | Order matching rate | matchedCount / totalOrders | 100% = every order finds a pair |
| **ER Period** | Lookback window | Number of candles | 60 = sees last 60 candles |
| **Balance Ratio** | Above/Below symmetry | Area Above / Area Below | 1.07 = nearly equal |

---

## How to Find Maximum Oscillation for Your Data

### Quick Process:

```bash
# 1. Run area analysis
node optimizer_area_analysis.js

# 2. Look for highest "Total Area" value
# 3. That ER value maximizes oscillation space

# For current data:
# ER=60 has Total Area = 375.55% (PEAK)

# 4. Verify it's not too laggy
node optimizer_high_lag_ama.js

# 5. Check that max distance is reasonable (3-4%)

# 6. Plot it
node generate_chart_enhanced.js  # Uses ER=60
```

### Result:

```
ER=60 is OPTIMAL because:
✓ Maximum Total Area: 375.55%
✓ Reasonable Max Distance: 3.25% (not too extreme)
✓ Balanced Above/Below: 194.58% / 180.97%
✓ Not overly laggy (still responsive enough)
✓ Good for oscillation-based grid trading
```

---

## Summary: The Calculation Pipeline

```
Raw Data (500 4h candles)
    ↓
├─ Remove warmup (first 50 candles)
├─ Calculate AMA for each remaining candle (450 candles)
│
├─ For each AMA calculation:
│  ├─ Measure distance: (high-AMA)/AMA and (AMA-low)/AMA
│  ├─ Accumulate: areaAbove += distance, areaBelow += distance
│  ├─ Track maximum: maxDistance = max of all distances
│  └─ Track matching: buy/sell order pairing
│
├─ Aggregate across 450 candles:
│  ├─ Total Area Above: 194.58%
│  ├─ Total Area Below: 180.97%
│  ├─ Total Area: 375.55%
│  ├─ Max Distance: 3.25%
│  └─ Fill Efficiency: (based on order matching)
│
└─ Output: ER=60 is optimal for this dataset
```

---

## Testing ER=60 Live

Once deployed with ER=60:

```
Monitor these metrics:
1. Area Above/Below balance
   → Should stay ~50/50 split
   → If >60/40, market conditions changed

2. Max Distance in live trading
   → Should stay < 4%
   → If >5%, increase ER even more

3. Order fill efficiency
   → Should stay > 90%
   → If <80%, AMA settings need adjustment

4. Total oscillations per day
   → Should see multiple complete cycles
   → Higher ER = slower cycles
```
