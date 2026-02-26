## AMA Fitting (Current Workflow)

This folder contains the active AMA optimization and comparison tooling used for LP pool data.

### Active Scripts

- `optimizer_high_resolution.js`
  - Runs geometric optimization over ER/Fast/Slow grid.
  - Produces four winners:
    - `MAX AREA/MAXDIST`
    - `MAX PROD/MAXDIST`
    - `MAX AREA/MAXDIST` with cap (`80%` of base area winner band factor)
    - `MAX PROD/MAXDIST` with cap (`80%` of base product winner band factor)
  - Writes `optimization_results_*.json`.

- `generate_unified_comparison_chart.js`
  - Loads winners from `optimization_results_*.json`.
  - Renders one HTML chart with candlesticks + 4 AMA overlays + bands.
  - Writes `chart_lp_*.html` when `--data` is provided.

- `ama.js`
  - Core AMA implementation used by analysis scripts.

### Data Source

Primary source is LP swap data exported from Kibana through:

- `market_adapter/fetch_lp_data.js`
- `market_adapter/kibana_source.js`

The LP candle export file shape:

```text
{
  "meta": { ... },
  "candles": [[timestamp_ms, open, high, low, close, volume_A], ...]
}
```

Directional swaps are merged and consolidated by timestamp before writing candles.

## Quick Start

1) Fetch/rebuild LP candles (example pool 133, 4h, 1 year):

```bash
node market_adapter/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 4h --lookback 8760h
```

2) Run optimizer on LP dataset:

```bash
node optimizer_high_resolution.js --data ../../market_adapter/data/lp_pool_133_4h.json
```

3) Build comparison chart:

```bash
node generate_unified_comparison_chart.js --data ../../market_adapter/data/lp_pool_133_4h.json
```

Generated outputs:

- `optimization_results_lp_pool_133_4h.json`
- `chart_lp_lp_pool_133_4h.html`

## Parameter Grid (Current)

- ER: `5..200` step `5`
- Fast: `2..10` step `0.5`
- Slow: `5..100` step `2.5`
- Total combos: `40 x 17 x 39 = 26,520`

## Notes

- `BAND_CAP_RATIO` is currently `0.8` (80%) in `optimizer_high_resolution.js`.
- Cap thresholds are derived from each base winner independently:
  - `areaCapPct = 0.8 * bandFactor(baseAreaWinner)`
  - `prodCapPct = 0.8 * bandFactor(baseProdWinner)`
- Chart labels and capped winner selection are read from the optimizer JSON metadata.

## Legacy Docs

The following docs remain for historical context and older experiments:

- `HIGH_RESOLUTION_ANALYSIS.md`
- `CALCULATION_GUIDE.md`
- `AMA_STRATEGIES_COMPLETE_GUIDE.md`

They may reference older metrics, datasets, and filenames.
