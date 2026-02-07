# DEXBot2 Dashboard (Quick Ops)

Terminal dashboard for DEXBot2 (`ratatui` + `crossterm`) with live bot status, PM2 state, log tails, and script actions.

## Run

```bash
cargo run --manifest-path dashboard/Cargo.toml
```

```bash
cargo check --manifest-path dashboard/Cargo.toml
```

## Keys

- `q` quit
- `r` refresh
- `Tab` / `Left` / `Right` switch tabs
- `j` / `k` move selection
- `x` run selected script action

## Action Safety

- `safe`: run immediately
- `confirm`: `y` to run, `n`/`Esc` cancel
- `danger`: type `DELETE` + `Enter`

## Included Actions

- `scripts/check-update.sh`
- `scripts/validate_bots.js`
- `scripts/analyze-orders.js`
- `scripts/analyze-git.js`
- `scripts/create-bot-symlinks.sh`
- `scripts/clear-logs.sh`
- `scripts/clear-orders.sh`
- `scripts/clear-all.sh`

## Excluded by Design

- `scripts/ptest.sh`
- `scripts/pdev.sh`
- `scripts/pmain.sh`

## Data Sources

- `profiles/bots.json`
- `profiles/logs/*.log`
- `pm2 jlist`

If PM2 is not available, dashboard still runs and marks PM2 as offline.

Full scope/spec: `docs/tui_dashboard_spec.md`.
