# DEXBot2 TUI Dashboard Spec (Ratatui + Crossterm)

## Purpose

Define a terminal dashboard that shows live DEXBot2 status and provides controlled access to existing `scripts/` utilities, without changing trading behavior.

## Scope

- Runtime visibility for all configured/running bots
- Real-time status from `profiles/orders`, `profiles/logs`, `profiles/bots.json`, and PM2
- Script execution panel for maintenance and diagnostics
- Safety controls for destructive operations
- No branch synchronization actions in the dashboard

## Explicit Exclusion

The dashboard must **not** include or expose:

- `scripts/ptest.sh`
- `scripts/pdev.sh`
- `scripts/pmain.sh`

These commands remain out of scope for UI-triggered operations.

## Data Sources

- `profiles/bots.json` for bot definitions and active flags
- `profiles/orders/*.json` for grid/fund/order state snapshots
- `profiles/logs/*.log` for live event tailing
- PM2 process list/status for runtime health
- Script stdout/stderr capture for action results

## User Interface

### Global Layout

- Top status bar: branch, PM2 health, refresh timestamp, bot counts, warning count
- Left pane: bot list with state badges
- Center pane: selected bot detail (funds, grid, boundaries, fills)
- Right pane: action list (scripts)
- Bottom pane: log tail or command output

### Tabs

- `F1` Overview
- `F2` Bot Detail
- `F3` Scripts
- `F4` Alerts

## Bot States

Badges shown in list/detail views:

- `RUNNING` (PM2 online + recent updates)
- `DRY` (dry-run configuration)
- `STALE` (no recent file/log updates)
- `ERROR` (recent warnings/errors)
- `STOPPED` (configured but not running)

## Script Integration

### Included Actions

Maintenance:

- `node scripts/update.js`
- `bash scripts/check-update.sh`
- `bash scripts/create-bot-symlinks.sh`

Diagnostics:

- `node scripts/validate_bots.js`
- `node scripts/analyze-orders.js`
- `node scripts/divergence-calc.js`
- `node scripts/print_grid.js`
- `node scripts/analyze-git.js`
- `bash scripts/git-viewer.sh`

Cleanup:

- `bash scripts/clear-logs.sh`
- `bash scripts/clear-orders.sh`
- `bash scripts/clear-all.sh`

Wrappers:

- `./scripts/bots`
- `./scripts/keys`

### Safety Classes

- `safe`: read-only diagnostics and status checks
- `confirm`: operational changes requiring y/n confirmation
- `danger`: destructive actions requiring typed confirmation

### Confirmation Rules

- `confirm` actions: explicit `y/n` prompt in modal
- `danger` actions: typed token confirmation (`DELETE`) plus target summary
- All command runs show live stdout/stderr and final exit code

## Keyboard Model

- `j/k` move selection
- `Enter` open selected bot/action
- `x` execute selected action
- `r` refresh
- `l` toggle logs/output pane
- `:` open command palette
- `?` help overlay
- `q` quit

## Refresh Strategy

- UI redraw: 4-10 FPS (adaptive)
- Core snapshots (`orders`, `bots`): every 1-2 seconds
- PM2 state: every 2-3 seconds
- Log tail updates: streaming/polling every 300-600 ms
- Heavy diagnostics: on-demand only

## Operational Constraints

- Dashboard is read-mostly and sidecar-safe: bot engine keeps running if dashboard exits
- No direct mutation of core trading state except through existing script commands
- No force-push, branch sync, or irreversible git operations exposed via dashboard

## MVP Milestones

1. Overview + Bot Detail (read-only)
2. Log/output panel with command execution plumbing
3. Script action panel with safety classes
4. Alerts tab (error/stale/invariant signals)
5. UX polish and resilience hardening

## Acceptance Criteria

- Shows live status for configured bots and PM2 runtime state
- Displays per-bot funds/grid/health data from current persisted files
- Executes included scripts and captures output/exit status
- Requires confirmations for cleanup actions
- Does not show or run `ptest.sh`, `pdev.sh`, or `pmain.sh`
