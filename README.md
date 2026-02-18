# DEXBot2

A sophisticated market making bot for the BitShares Decentralized Exchange (DEX), implementing optimized staggered order strategies for automated trading.

## 🚀 Features

- **Adaptive Geometric Grids**: Dynamic order scaling with configurable weight distribution and automated recalculation based on market volatility.
- **Copy-on-Write Grid Architecture**: Master grid is immutable—all strategy planning occurs on an isolated working copy and is only committed to the master after blockchain confirmation. Eliminates speculative state corruption and supports true transactional semantics. See [COPY_ON_WRITE_MASTER_PLAN.md](docs/COPY_ON_WRITE_MASTER_PLAN.md).
- **Adaptive Fill Batching**: Groups fills into stress-scaled batches (1-4 per broadcast) reducing processing time from ~90s to ~24s for 29 fills. Prevents stale orders and orphan fills during market surges.
- **Atomic Execution & Recovery**: Instant state sync for partial fills and automatic detection of orders filled while offline to ensure capital efficiency.
- **Self-Healing Recovery**: Periodic recovery retries (max 5 attempts, 60s interval) with automatic state reset prevent permanent lockup after single failures.
- **Persistent State Management**: Caches grid configurations and price levels across restarts to ensure continuity and minimize blockchain queries.
- **Enterprise-Grade Security**: AES-encrypted key storage with RAM-only password handling—sensitive data is never written to disk.
- **Production-Ready Orchestration**: Native PM2 integration for multi-bot management with built-in auto-updates and real-time monitoring.

## 🔥 Quick Start

Get DEXBot2 running in 5 minutes:

```bash
# 1. Clone and install
git clone https://github.com/froooze/DEXBot2.git && cd DEXBot2 && npm install

# 2. Set up your master password, keys and add bots
node dexbot keys
node dexbot bots

# 3. Start with PM2 or directly
node pm2           # For production
node unlock-start.js  # Single prompt, no PM2
node dexbot start  # For testing
```

For detailed setup, see [Installation](#-installation) or [Updating](#updating-dexbot2) sections below.

### ⚠️ Disclaimer — Use At Your Own Risk

- This software is in beta stage and provided "as‑is" without warranty.
- Secure your keys and secrets. Do not commit private keys or passwords to anyone.
- The authors and maintainers are not responsible for losses.

## 📥 Installation

### Prerequisites

You'll need **Git** and **Node.js** installed on your system.

#### Windows Users

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/) (accept defaults, restart after)
2. Install **Git** from [git-scm.com](https://git-scm.com/) (accept defaults, restart after)
3. Verify installation in Command Prompt:
   ```bash
   node --version && npm --version && git --version
   ```
   All three should display version numbers.

#### macOS Users

Use Homebrew to install Node.js and Git:
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and Git
brew install node git
```

#### Linux Users

Use your package manager:
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install nodejs npm git

# Fedora/RHEL
sudo dnf install nodejs npm git
```

### Clone and Setup DEXBot2

```bash
# Clone the repository and switch to folder
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2

# Install dependencies
npm install

# Set up your master password and keyring
node dexbot keys

# Create and configure your bots
node dexbot bots
```

### Updating DEXBot2

To update DEXBot2 to the latest version from the main branch:

```bash
# Run the update script from project root
node dexbot update
```

The update script automatically:
- Fetches and pulls the latest code
- Installs any new dependencies
- Reloads PM2 processes if running
- Ensures your `profiles/` directory is protected and unchanged
- Logs all operations to `update.log`

## 🔧 Configuration

### 🤖 Bot Options

Below is a reference guide for each configuration option from `node dexbot bots` stored in `profiles/bots.json`.

#### 1. Trading Pair
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`assetA`** | string | Base asset |
| **`assetB`** | string | Quote asset |

#### 2. Identity & Status
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`name`** | string | Friendly name for logging and CLI selection. |
| **`active`** | boolean | Set to `false` to keep the config without running it. |
| **`dryRun`** | boolean | If `true`, simulates orders without broadcasting to the blockchain. |
| **`preferredAccount`** | string | The BitShares account name to use for trading. |

#### 3. Price Range
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`startPrice`** | num \| str | Default start price from liquidiy pool (`"pool"`), `"market"` (order book) or a number `A/B` is also possible. |
| **`minPrice`** | number \| string | Lower bound. Use a number (e.g., `0.5`) or multiplier (e.g., `"2x"` = `startPrice / 2`). |
| **`maxPrice`** | number \| string | Upper bound. Use a number (e.g., `1.5`) or multiplier (e.g., `"2x"` = `startPrice * 2`). |

#### 4. Grid Strategy
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`incrementPercent`** | number | Geometric step between layers (e.g., `0.5` for 0.5% increments). |
| **`targetSpreadPercent`** | number | Target width of the empty spread zone between buy and sell orders. |
| **`weightDistribution`**| object | Sizing logic: `{ "sell": 1.0, "buy": 1.0 }`. Range: `-1` to `2`. <br>• `-1`: **Super Valley** (heavy edge) <br>• `0.5`: **Neutral** <br>• `2`: **Super Mountain** (heavy center) |

#### 5. Funding & Scaling
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`botFunds`** | object | Capital allocation: `{ "sell": "100%", "buy": 1000 }`. Supports numbers or percentage strings (e.g., `"50%"`). |
| **`activeOrders`** | object | Maximum concurrent orders per side: `{ "sell": 5, "buy": 5 }`. |

### ⚙️ General Options (Global)

DEXBot2 now supports global parameter management via the interactive editor (`dexbot bots`). These settings are stored in `profiles/general.settings.json` and persist across repository updates.

**Available Global Parameters:**
- **Grid Cache Regeneration %**: Threshold for resizing the grid when proceeds accumulate (Default: `3%`).
- **RMS Divergence Threshold %**: Maximum allowed deviation between in-memory and persisted grid state (Default: `14.3%`).
- **Partial Dust Threshold %**: Threshold for identifying small "dust" orders for geometric refilling (Default: `5%`).
- **Timing (Core)**: **Blockchain Fetch Interval**: Frequency of full account balance refreshes (Default: `240 min`); **Sync Delay**: Polling delay for blockchain synchronization (Default: `500ms`); **Lock Timeout**: Order lock auto-expiry timeout (Default: `10s`).
- **Timing (Fill)**: **Fill Dedupe Window**: Window for deduplicating same fill events (Default: `5s`); **Fill Cleanup Interval**: Frequency for cleaning old fill records (Default: `10s`); **Fill Record Retention**: Duration to keep persisted fill records (Default: `60 min`).
- **Log Level**: Global verbosity control (`debug`, `info`, `warn`, `error`). Advanced logging configuration with fine-grained category control is available in `LOGGING_CONFIG` (see [Logging System](docs/LOGGING.md) below).
- **Updater**: **Updater Active**: Toggle daily automated repository updates (Default: `ON`); **Updater Branch**: Branch to track for updates (`auto`, `main`, `dev`, `test`); **Updater Interval**: Frequency of automated updates in days (Default: `1 day`); **Updater Time**: Specific time of day to run the update (Default: `00:00`).

## 🎯 PM2 Process Management (Recommended for Production)

For production use with automatic restart and process monitoring, use PM2:

### Starting Bots via PM2

Use `node pm2.js` to start bots with PM2 process management. This unified launcher handles everything automatically:
1. **BitShares Connection**: Waits for network connection
2. **PM2 Check**: Detects local and global PM2; prompts to install if missing
3. **Config Generation**: Creates `profiles/ecosystem.config.js` from `profiles/bots.json`
4. **Authentication**: Prompts for master password (kept in RAM only, never saved to disk)
5. **Startup**: Starts all active bots as PM2-managed processes with auto-restart

```bash
# Start all active bots with PM2
node pm2

# Or via CLI
node dexbot pm2

# Start a specific bot via PM2
node pm2 <bot-name>
```

### Managing PM2 Processes

After startup via `node pm2.js`, use these commands to manage and monitor every pm2 process:

```bash
# View status and resource usage
pm2 status

# View real-time logs
pm2 logs [<bot-name>]

# Restart processes
pm2 restart {all|<bot-name>}

# Stop processes
pm2 stop {all|<bot-name>}

# Delete processes
pm2 delete {all|<bot-name>}
```

### Managing Bot Processes via pm2.js

Use `node pm2.js` wrapper commands to select only dexbot processes:

```bash
# Stop only dexbot processes
node pm2 stop {all|<bot-name>}

# Delete only dexbot processes
node pm2 delete {all|<bot-name>}

# Show pm2.js usage information
node pm2.js help
```

### Grid Management & Bot Config

```bash
# Reset Grid by using  (Regenerate orders)
node dexbot reset {all|[<bot-name>]}

# Disable a bot in config (marks as inactive)
node dexbot disable {all|[<bot-name>]}
```

### Configuration & Logs

Bot configurations are defined in `profiles/bots.json`. The PM2 launcher automatically:
- Filters only bots with `active !== false`
- Generates ecosystem config with proper paths and logging
- Logs bot output to `profiles/logs/<bot-name>.log`
- Logs bot errors to `profiles/logs/<bot-name>-error.log`
- Applies restart policies (max 13 restarts, 1 day min uptime, 3 second restart delay)

### Security

- Master password is prompted interactively in your terminal
- Password passed via environment variable to bot processes (RAM only)
- Never written to disk or config files
- Cleared when process exits

## 📚 Documentation

For comprehensive guides on architecture, fund accounting, rotation mechanics, and development, see the **[docs/](docs/)** folder.

Key documents:
- **[FUND_MOVEMENT_AND_ACCOUNTING.md](docs/FUND_MOVEMENT_AND_ACCOUNTING.md)** - Unified guide to fund accounting, grid topology, and rotation mechanics
- **[architecture.md](docs/architecture.md)** - System design, fill processing pipeline, and testing strategy
- **[COPY_ON_WRITE_MASTER_PLAN.md](docs/COPY_ON_WRITE_MASTER_PLAN.md)** - Copy-on-Write grid architecture: immutable master, working copies, and transactional rebalancing
- **[developer_guide.md](docs/developer_guide.md)** - Development guide with examples and glossary
- **[LOGGING.md](docs/LOGGING.md)** - Comprehensive logging system documentation
- **[WORKFLOW.md](docs/WORKFLOW.md)** - Project workflow and contribution guide

## 🔐 Environment Variables

Control bot behavior via environment variables (useful for advanced setups):

- `MASTER_PASSWORD` - Master password for key decryption (set by `pm2.js`, used by `bot.js` and `dexbot.js`)
- `BOT_NAME` or `LIVE_BOT_NAME` - Select a specific bot from `profiles/bots.json` by name (for single-bot runs)
- `PREFERRED_ACCOUNT` - Override the preferred account for the selected bot
- `RUN_LOOP_MS` - Polling interval in milliseconds (default: 5000). Controls how often the bot checks for fills and market conditions
- `CALC_CYCLES` - Number of calculation passes for standalone grid calculator (default: 1)
- `CALC_DELAY_MS` - Delay between calculator cycles in milliseconds (default: 0)

Example - Run a specific bot with custom polling interval:
```bash
BOT_NAME=my-bot RUN_LOOP_MS=3000 node dexbot.js
```

## 🤝 Contributing

1. Fork the repository and create a feature branch
2. Make your changes and test with `npm test`
3. For Jest tests: `./scripts/dev-install.sh` then `npm run test:unit`
4. Submit a pull request

**Development Setup:** `npm install` then optionally `./scripts/dev-install.sh` for Jest testing framework

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)
