## Bot Fitting Backtest (LP 1h + 4 AMA)

This folder contains a parameter sweep backtest that simulates grid fills for the four AMA winners from `analysis/ama_fitting`.

### What it optimizes

For each of the 4 AMA strategies, it searches for best:

- `spread` (% target round-trip spread)
- `increment` (% grid step)
- `max/min ratio` (symmetric range around AMA, e.g. `2.0` means `[AMA/2, AMA*2]`)

### Input dependencies

- LP candles JSON (recommended 1h):
  - `market_adapter/data/lp_pool_133_1h.json`
- AMA optimization winners JSON:
  - `analysis/ama_fitting/optimization_results_lp_pool_133_1h.json`

### Run

```bash
node analysis/bot_fitting/backtest_bot_fitting.js \
  --data market_adapter/data/lp_pool_133_1h.json
```

Optional tuning:

```bash
node analysis/bot_fitting/backtest_bot_fitting.js \
  --data market_adapter/data/lp_pool_133_1h.json \
  --spread 0.4:1.6:0.1 \
  --increment 0.2:0.8:0.1 \
  --ratio 1.5,2,2.5,3,4,5,8,10 \
  --active-orders 5 \
  --fee 0.20 \
  --min-spread-factor 2.1 \
  --risk-duration 1.0 \
  --risk-peak-open 2.0 \
  --risk-imbalance 1.2 \
  --risk-cancel 0.15
```

### Output

- `analysis/bot_fitting/bot_fitting_results_lp_pool_133_1h.json`

The console also prints best parameter set per AMA with matched pairs, fill efficiency, net capture and score.

### Notes

- This is an offline simulation proxy, not a full chain execution model.
- Reposition reset is modeled when AMA changes by more than increment in one candle.
- Pair search enforces bot rule: `spread >= 2.1 x increment` by default
  (`--min-spread-factor` to override).
- Score used for ranking:
  - `totalNetCapturePct = matchedPairs * (spread - increment - fee)`
  - `baseScore = totalNetCapturePct * (fillEfficiency / 100)`
  - `riskPenalty = avgOpenDurationBars*1.0 + peakOpenOrders*2.0 + avgImbalance*1.2 + canceledOnReposition*0.15`
  - `finalScore = baseScore - riskPenalty`
