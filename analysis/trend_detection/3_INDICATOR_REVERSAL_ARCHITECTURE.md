# Volume-King 3-Indicator Reversal System Architecture

This document outlines a high-confidence reversal detection system designed to identify market pivots through a validated three-stage process: Momentum Exhaustion, Price Action Breakout, and Institutional Flow Validation.

## 🏛️ ARCHITECTURE OVERVIEW

```text
┌─────────────────────────────────────────────────────────────┐
│                VOLUME-CONFIRMED REVERSAL SYSTEM             │
├───────────────┬─────────────────┬───────────────────────────┤
│  DIVERGENCE   │   TREND BREAK   │   VOLUME VALIDATION       │
│  (WHEN)       │   (WHERE)       │   (WHY REAL)              │
│               │                 │                           │
│  Momentum     │  Price Action   │  Participation           │
│  Exhaustion   │  Breakout       │  Institutional Flow      │
└───────────────┴─────────────────┴───────────────────────────┘
```

---

## 📊 COMPONENT 1: DIVERGENCE DETECTOR - The "When"
**Purpose:** Identify momentum exhaustion before price reversal.

### Options (Choose ONE):

#### Option A: RSI Divergence (Most Reliable)
- **Parameters:** `RSI_DIVERGENCE(period=14, oversold=30, overbought=70)`
- **Logic:**
    - **Bullish:** Price makes Lower Low, RSI makes Higher Low.
    - **Bearish:** Price makes Higher High, RSI makes Lower High.
    - **Constraints:** Min 5 bars between peaks/troughs. Must occur outside RSI 40-60 range (meaningful extremes).

#### Option B: MACD Histogram Divergence (Strong Momentum)
- **Parameters:** `MACD_DIVERGENCE(fast=12, slow=26, signal=9)`
- **Logic:**
    - **Bullish:** Price LL, MACD histogram HL.
    - **Bearish:** Price HH, MACD histogram LH.
    - **Constraints:** Histogram must cross zero-line for valid divergence.

#### Option C: Stochastic Divergence (Fast Markets)
- **Parameters:** `STOCHASTIC_DIVERGENCE(k=14, d=3, smooth=3)`
- **Logic:**
    - **Bullish:** Price LL, %K HL, occurs below 20.
    - **Bearish:** Price HH, %K LH, occurs above 80.
    - **Constraints:** %D must confirm direction.

---

## 📈 COMPONENT 2: TREND BREAK CONFIRMATION - The "Where"
**Purpose:** Confirm price has broken structure, signaling trend change.

### Options (Choose ONE):

#### Option A: EMA Golden/Death Cross (Classic)
- **Parameters:** `EMA_CROSS(fast=13, slow=34)`
- **Logic:**
    - **Bullish:** EMA(fast) crosses above EMA(slow).
    - **Bearish:** EMA(fast) crosses below EMA(slow).
    - **Constraints:** Cross must occur within 3 bars of divergence.

#### Option B: Support/Resistance Break (Pure Price Action)
- **Parameters:** `SR_BREAK(lookback=20, confirmation=2)`
- **Logic:**
    - **Bullish:** Close above recent swing high (20-bar lookback).
    - **Bearish:** Close below recent swing low (20-bar lookback).
    - **Constraints:** Requires 2 consecutive closes beyond level.

#### Option C: Trendline Break (Visual)
- **Parameters:** `TRENDLINE_BREAK(min_touches=3, break_type='close')`
- **Logic:**
    - **Bullish:** Close above downtrend line (min 3 touches).
    - **Bearish:** Close below uptrend line (min 3 touches).
    - **Constraints:** Volume spike on break (combined with Component 3).

---

## 🔥 COMPONENT 3: VOLUME VALIDATION - The "Why"
**Purpose:** Validate institutional participation and commitment.

### Options (Choose ONE):

#### Option A: Volume Spike + OBV Confirmation (Strongest)
- **Parameters:** `VOLUME_SPIKE_OBV(volume_period=20, multiplier=1.5)`
- **Logic:**
    - **Volume Spike:** Current volume > `SMA(20) * 1.5`.
    - **OBV Confirmation:** OBV making new highs/lows with price.
    - **Volume Trend:** Increasing volume over last 3 bars.

#### Option B: VWAP Deviation + Volume (Institutional Focus)
- **Parameters:** `VWAP_VOLUME(vwap_period=20, deviation=1.0)`
- **Logic:**
    - **VWAP Break:** Price > VWAP + 1% (bullish) or < VWAP - 1% (bearish).
    - **Volume:** Current volume > 20-period average.
    - **VWAP Slope:** VWAP sloping in direction of break.

#### Option C: Volume-Weighted MACD (Momentum + Volume)
- **Parameters:** `VW_MACD(fast=12, slow=26, signal=9)`
- **Logic:**
    - **VW-MACD Cross:** VW-MACD line crosses signal line.
    - **Volume:** Volume > 1.2x average on cross.
    - **Expansion:** Increasing histogram bars.

---

## ⚙️ SIGNAL GENERATION LOGIC

### Complete Flow:

1.  **DIVERGENCE DETECTED** (Component 1)
2.  **WAIT FOR CONFIRMATION** (0-3 bars max)
3.  **TREND BREAK OCCURS** (Component 2)
4.  **VOLUME VALIDATION** (Component 3)
5.  **ENTRY SIGNAL GENERATED**

### Entry Strategies:
```python
ENTRY_STRATEGY = {
    'immediate': 'Enter on close of confirmation bar',
    'pullback': 'Wait for pullback to broken level',
    'retest': 'Enter on successful retest'
}
```

### Filter Rules:
```python
FILTERS = {
    'time_window': 3,      # Max bars between divergence & confirmation
    'divergence_bars': 5,  # Min bars between divergence peaks/troughs
    'volume_timing': 'same_bar'  # Volume must spike on confirmation bar
}
```

---

## 🎯 RECOMMENDED COMBINATIONS

### Combination 1: High Probability Setup (Conservative)
*Best for: Swing trading, daily timeframe*
- **Component 1:** `RSI_DIVERGENCE(14, 30, 70)`
- **Component 2:** `EMA_CROSS(13, 34)`
- **Component 3:** `VOLUME_SPIKE_OBV(20, 1.5)`

### Combination 2: Early Entry Setup (Aggressive)
*Best for: Day trading, 4H/1H timeframe*
- **Component 1:** `MACD_DIVERGENCE(12, 26, 9)`
- **Component 2:** `TRENDLINE_BREAK(3, 'close')`
- **Component 3:** `VWAP_VOLUME(20, 1.0)`

### Combination 3: Pure Price Action (Discretionary)
*Best for: Key level trading, weekly pivots*
- **Component 1:** `RSI_DIVERGENCE(21, 35, 65)`
- **Component 2:** `SR_BREAK(20, 2)`
- **Component 3:** `VOLUME_SPIKE_OBV(50, 2.0)`

---

## 📊 BACKTEST OPTIMIZATION PARAMETERS

```python
DIVERGENCE_PARAMS = {
    'rsi_period': [7, 14, 21],
    'oversold': [25, 30, 35, 40],
    'overbought': [60, 65, 70, 75],
    'min_bars': [3, 5, 8, 13]
}

CONFIRMATION_PARAMS = {
    'ema_fast': [8, 13, 21, 34],
    'ema_slow': [21, 34, 55, 89],
    'sr_lookback': [10, 20, 50],
    'close_confirmations': [1, 2, 3]
}

VOLUME_PARAMS = {
    'volume_period': [10, 20, 50],
    'spike_multiplier': [1.2, 1.5, 2.0, 2.5],
    'vwap_deviation': [0.5, 1.0, 1.5, 2.0]
}

TIMING_PARAMS = {
    'max_bars_between': [2, 3, 5, 8],
    'entry_delay': [0, 1, 2],
    'exit_on_divergence': [True, False]
}
```

---

## 🚨 RISK MANAGEMENT RULES

### Stop Loss & Take Profit:
```python
STOP_RULES = {
    'method': 'atr',        # or 'percentage', 'swing'
    'atr_multiplier': 1.5,  # x ATR(14)
    'max_risk': 2.0,        # % of capital
    'breakeven_at': 1.0     # Move to breakeven at 1:1 R/R
}

TP_RULES = {
    'method': 'multi_target',
    'targets': [
        {'rr': 1.0, 'size': 30},
        {'rr': 2.0, 'size': 40},
        {'rr': 3.0, 'size': 30}
    ],
    'trail_type': 'ema',    # or 'atr', 'parabolic'
    'trail_period': 21
}
```

---

## 📈 PERFORMANCE METRICS TO TRACK

- **Win Rate:** Target > 45%
- **Profit Factor:** Target > 2.0
- **Sharpe Ratio:** Target > 1.5
- **Max Drawdown:** Limit < 15%
- **Avg Win/Loss Ratio:** Target > 2.0
- **Volume Confirmation Rate:** Target > 80%

---

## 🔄 IMPLEMENTATION TEMPLATE (Pseudo-code)

```python
class VolumeConfirmedReversal:
    def __init__(self, config):
        self.divergence = self.set_divergence(config['div'])
        self.confirmation = self.set_confirmation(config['conf'])
        self.volume = self.set_volume(config['vol'])
        self.filters = config.get('filters', {})
    
    def check_signal(self, df):
        # Step 1: Check for divergence
        div_signal = self.divergence.scan(df)
        if not div_signal:
            return None
        
        # Step 2: Look for confirmation within window
        max_window = self.filters.get('max_window', 3)
        for i in range(max_window):
            if len(df) < i+1: break
            
            conf_signal = self.confirmation.check(df.iloc[-i-1:])
            if conf_signal:
                # Step 3: Validate with volume
                if self.volume.validate(df.iloc[-i-1:], conf_signal):
                    return self.generate_signal(div_signal, conf_signal)
        return None
    
    def generate_signal(self, divergence, confirmation):
        return {
            'direction': confirmation['direction'],
            'entry_price': confirmation['break_price'],
            'stop_loss': self.calculate_stop(divergence, confirmation),
            'timestamp': confirmation['timestamp'],
            'volume_spike': self.volume.get_spike_value(),
            'confidence': self.calculate_confidence(divergence, confirmation)
        }
```

---

## 💡 KEY INSIGHTS

1.  **Volume is not optional** - It's the difference between a real move and a fakeout.
2.  **Sequence matters** - Divergence → Break → Volume = High probability.
3.  **Timing is critical** - Volume must spike **ON** the breakout bar.
4.  **Context enhances** - Volume confirmation at key levels (support/resistance) is strongest.
5.  **Avoid divergence alone** - Without volume, divergence fails 60%+ of the time.

---

## 🎯 FINAL RECOMMENDATION

**Best Overall Combination for Most Markets:**
- **Component 1:** `RSI_DIVERGENCE(14, 30, 70)`
- **Component 2:** `EMA_CROSS(13, 34)`
- **Component 3:** `VOLUME_SPIKE_OBV(20, 1.5)`

This combination catches momentum shifts early, provides clear trend-change signals, and confirms institutional participation while filtering most noise. Start here, backtest, then optimize one component at a time.