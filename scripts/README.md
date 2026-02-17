# DEXBot2 /scripts CLI Documentation

This guide provides a terminal-focused reference for the maintenance and diagnostic utilities available in the `scripts/` directory.

---

## 🛠️ CORE MAINTENANCE

### Update DEXBot2
**File:** `update.js`
**Purpose:** Perform a safe, production-ready update.
```bash
# Pull latest code, install deps, and reload PM2
node dexbot update
```
*Note: Protects your `profiles/` directory and logs all changes to `profiles/logs/update.log`.*

### Fix Environment Paths
**File:** `create-bot-symlinks.sh`
**Purpose:** Create convenience root-level symlinks to profile data.
```bash
# Creates logs -> profiles/logs and orders -> profiles/orders
bash scripts/create-bot-symlinks.sh
```

---

## 🧹 CLEANING & RESET (DANGER ZONE)

### Wipe Logs
**File:** `clear-logs.sh`
**Purpose:** Delete all bot `.log` files.
```bash
# IRREVERSIBLE: Deletes all files in profiles/logs/*.log
bash scripts/clear-logs.sh
```

### Wipe Orders
**File:** `clear-orders.sh`
**Purpose:** Delete all persistent order state files.
```bash
# IRREVERSIBLE: Deletes all files in profiles/orders/*
bash scripts/clear-orders.sh
```

### Wipe Orders + Logs
**File:** `clear-all.sh`
**Purpose:** Delete order state files and `.log` files in one confirmed operation.
```bash
# IRREVERSIBLE: Deletes profiles/orders/* and profiles/logs/*.log
bash scripts/clear-all.sh
```

---

## 📊 DIAGNOSTICS & VALIDATION

### Configuration Audit
**File:** `validate_bots.js`
**Purpose:** Check `bots.json` for schema errors or missing required fields.
```bash
# Validate both example and live bot configurations
node scripts/validate_bots.js
```

### Grid Divergence Audit
**File:** `divergence-calc.js`
**Purpose:** Measure the "drift" between in-memory grid and disk state using RMS divergence metric.
```bash
# Calculates RMS Error (Default threshold is 14.3%)
# RMS quadratically penalizes large errors - see docs/README.md for threshold interpretation
node scripts/divergence-calc.js
```
**Reference:** RMS threshold explanation in [root README GRID RECALCULATION section](../README.md#-automatic-grid-recalculation-via-threshold-detection)

### Grid Trading Analysis
**File:** `analyze-orders.js`
**Purpose:** Analyze grid trading metrics and order distribution patterns.
```bash
# Analyzes spread accuracy, geometric consistency, and fund distribution
node scripts/analyze-orders.js
```

### Codebase Health
**File:** `analyze-repo-stats.js`
**Purpose:** Generate a visual complexity and size report.
```bash
# Outputs repo-stats.html
node scripts/analyze-repo-stats.js
```

---

## 🔍 GIT & DEVELOPMENT WORKFLOW

### Interactive Git Changes Monitor
**File:** `git-viewer.sh`
**Purpose:** Interactive monitor for uncommitted, committed, and pushed changes.
```bash
# Launch interactive git changes viewer with fzf search
bash scripts/git-viewer.sh
```

**Features**:
- View uncommitted (working tree) changes
- View committed (staged) changes
- View pushed vs. remote-tracking changes
- Smart auto-refresh (1s for local, 15s for remote)
- Fuzzy search with `fzf` for finding files
- Toggle between full file view and diff-only view

**Usage**:
```bash
# Press 'u' to toggle uncommitted changes
# Press 'c' to toggle committed changes
# Press 'p' to toggle pushed status
# Press 's' to search with fzf
# Press 'f' to toggle full file view
# Press 'q' to quit
```

---

## 💻 DEVELOPMENT UTILITIES

### Test Suite Setup
**File:** `dev-install.sh`
**Purpose:** Install Jest, ESLint, and other dev-only dependencies.
```bash
bash scripts/dev-install.sh
```

---

## 🌳 BRANCH SYNCHRONIZATION

### Synchronize test → dev → main
**File:** `pmain.sh` (also: `npm run pmain`)
**Purpose:** Sync local test branch through dev to main remote.
```bash
# Push test → dev → main
bash scripts/pmain.sh
# OR
npm run pmain
```

### Synchronize test → dev
**File:** `pdev.sh` (also: `npm run pdev`)
**Purpose:** Sync local test branch to dev remote.
```bash
# Push test → dev
bash scripts/pdev.sh
# OR
npm run pdev
```

### Synchronize local test → origin/test
**File:** `ptest.sh` (also: `npm run ptest`)
**Purpose:** Push local test branch to remote.
```bash
# Push test to origin/test
bash scripts/ptest.sh
# OR
npm run ptest
```

---

## ⚡ CONVENIENCE WRAPPERS

The following scripts allow you to call `dexbot` commands directly from the `scripts/` directory:

| Wrapper | Target Command | Usage |
|:---|:---|:---|
| `scripts/bots` | `node dexbot bots` | `./scripts/bots` |
| `scripts/keys` | `node dexbot keys` | `./scripts/keys` |
| `scripts/dexbot` | `node dexbot` | `./scripts/dexbot <cmd>` |
| `scripts/pm2` | `node pm2.js` | `./scripts/pm2` |

---

## 📦 NPM SCRIPTS

| Command | Purpose |
|:---|:---|
| `npm run ptest` | Sync local test → origin/test |
| `npm run pdev` | Sync local test → dev |
| `npm run pmain` | Sync local test → dev → main |
| `npm test` | Run full test suite (35+ test cases) |

---

## 📚 DOCUMENTATION REFERENCES

For understanding the systems these scripts interact with:
- **Module Architecture**: See [root README 📦 Modules section](../README.md#-modules)
- **Copy-on-Write Pattern**: See [docs/COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md) for rebalancing architecture
- **Fund Accounting**: See [docs/FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)
- **Grid Divergence**: See [docs/README.md](../docs/README.md) for RMS threshold explanations
- **Logging System**: See [docs/LOGGING.md](../docs/LOGGING.md) for log configuration and levels

---

## ⌨️ TERMINAL PRODUCTIVITY

Boost your workflow by adding these aliases to your `~/.bashrc` or `~/.zshrc`:

```bash
# DEXBot2 Shortcuts
alias dbu='node dexbot update'
alias dbc='bash scripts/clear-logs.sh'
alias dbr='bash scripts/clear-orders.sh'
alias dba='bash scripts/clear-all.sh'
alias dbv='node scripts/validate_bots.js'
alias dbd='node scripts/divergence-calc.js'
```

---

## 💡 PRO-TIPS FOR TERMINAL USERS

**Monitor live updates while running a script:**
```bash
# Tail the update log in a separate pane
tail -f profiles/logs/update.log
```

**Run a specific bot dry-run from the CLI:**
```bash
# Force a clean start for 'my-bot'
bash scripts/clear-orders.sh && BOT_NAME=my-bot node dexbot start
```
