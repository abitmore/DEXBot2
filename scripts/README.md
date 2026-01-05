# DEXBot2 Scripts

This directory contains utility scripts for managing, maintaining, and developing DEXBot2. These scripts automate common tasks like updates, profile bootstrapping, log clearing, and system diagnostics.

## 🚀 Key Scripts

### 🛠️ Maintenance & Setup

| Script | Description | Usage |
| :--- | :--- | :--- |
| **`update.sh`** | **Primary Update Script.** Fetches latest code, installs dependencies, and restarts PM2 processes. Safe to use in production. | `bash scripts/update.sh` |
| **`bootstrap-profiles.js`** | Creates the `profiles/` directory structure from examples if it doesn't exist. Useful for new installs. | `node scripts/bootstrap-profiles.js` |
| **`create-bot-symlinks.sh`** | Creates convenience symlinks (`logs`, `orders`) in the root directory pointing to `profiles/`. | `bash scripts/create-bot-symlinks.sh` |

### 🧹 Cleaning & Reset

| Script | Description | Usage |
| :--- | :--- | :--- |
| **`clear-logs.sh`** | Deletes all log files in `profiles/logs/`. Use when logs consume too much space. | `bash scripts/clear-logs.sh` |
| **`clear-orders.sh`** | **Danger Zone.** Deletes all persisted order state files in `profiles/orders/`. Forces a full grid regeneration on next run. | `bash scripts/clear-orders.sh` |

### 📊 Diagnostics & Analysis

| Script | Description | Usage |
| :--- | :--- | :--- |
| **`analyze-repo-stats.js`** | Generates an HTML report (`repo-stats.html`) visualizing codebase statistics (file sizes, line counts). | `node scripts/analyze-repo-stats.js` |
| **`print_grid.js`** | Visualizes the order grid for a specific bot without running it. Useful for checking strategy parameters. | `node scripts/print_grid.js <bot-name>` |
| **`divergence-calc.js`** | Calculates and displays grid divergence metrics (RMS error) for debugging order sizing logic. | `node scripts/divergence-calc.js` |
| **`validate_bots.js`** | Validates the integrity and schema of `profiles/bots.json`. Checks for missing fields or invalid types. | `node scripts/validate_bots.js` |

## 💻 Development Scripts

These scripts are primarily for contributors and developers working on the DEXBot2 codebase.

| Script | Description | Usage |
| :--- | :--- | :--- |
| **`dev-install.sh`** | Installs development dependencies (Jest, ESLint) required for running unit tests. | `bash scripts/dev-install.sh` |
| **`update-dev.sh`** | Developer-focused update. Pulls changes but skips PM2 restarts and production safeguards. | `bash scripts/update-dev.sh` |

## 📂 Directories

- **`bots/`**: Contains logic or templates related to bot configuration management (internal use).
- **`keys/`**: Contains logic or templates related to key management (internal use).

---

**Note:** Always run scripts from the project root directory unless otherwise specified.
Example: `bash scripts/update.sh`, not `cd scripts && ./update.sh`.
