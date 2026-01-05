# DEXBot2 /scripts CLI Documentation

This guide provides a terminal-focused reference for the maintenance and diagnostic utilities available in the `scripts/` directory.

---

## 🛠️ CORE MAINTENANCE

### Update DEXBot2
**File:** `update.sh`
**Purpose:** Perform a safe, production-ready update.
```bash
# Pull latest code, install deps, and reload PM2
bash scripts/update.sh
```
*Note: Protects your `profiles/` directory and logs all changes to `profiles/logs/update.log`.*

### Bootstrap Environment
**File:** `bootstrap-profiles.js`
**Purpose:** Initialize directory structure for new installations.
```bash
# Create profiles/, logs/, and orders/ from examples
node scripts/bootstrap-profiles.js
```

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
**Purpose:** Free up disk space by deleting all bot logs.
```bash
# IRREVERSIBLE: Deletes everything in profiles/logs/*.log
bash scripts/clear-logs.sh
```

### Hard Reset Grid
**File:** `clear-orders.sh`
**Purpose:** Clear all persistent grid state.
```bash
# IRREVERSIBLE: Forces full grid regeneration on next run
bash scripts/clear-orders.sh
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
**Purpose:** Measure the "drift" between in-memory grid and disk state.
```bash
# Calculates RMS Error (Default threshold is 14.3%)
node scripts/divergence-calc.js
```

### Codebase Health
**File:** `analyze-repo-stats.js`
**Purpose:** Generate a visual complexity and size report.
```bash
# Outputs repo-stats.html
node scripts/analyze-repo-stats.js
```

---

## 💻 DEVELOPMENT UTILITIES

### Test Suite Setup
**File:** `dev-install.sh`
**Purpose:** Install Jest, ESLint, and other dev-only dependencies.
```bash
bash scripts/dev-install.sh
```

### Dev update
**File:** `update-dev.sh`
**Purpose:** Update code without production side-effects (skips PM2 reloads).
```bash
bash scripts/update-dev.sh
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

## ⌨️ TERMINAL PRODUCTIVITY

Boost your workflow by adding these aliases to your `~/.bashrc` or `~/.zshrc`:

```bash
# DEXBot2 Shortcuts
alias dbu='bash scripts/update.sh'
alias dbc='bash scripts/clear-logs.sh'
alias dbr='bash scripts/clear-orders.sh'
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
