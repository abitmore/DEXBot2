# DEXBot vs DEXBot2 — Detailed Comparison Report

> **Date:** 2026-02-19
> **Scope:** Full architectural, functional, and operational comparison between the original [DEXBot](https://github.com/Codaone/DEXBot) (Python, v1.0.0) and DEXBot2 (Node.js rewrite, v0.6.x).
> **Audience:** Developers, contributors, and operators evaluating or migrating between the two projects.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Technology Stack](#2-technology-stack)
3. [Architecture](#3-architecture)
4. [Trading Strategies](#4-trading-strategies)
5. [Order Management](#5-order-management)
6. [Configuration System](#6-configuration-system)
7. [Exchange & Blockchain Integration](#7-exchange--blockchain-integration)
8. [Fund & Balance Accounting](#8-fund--balance-accounting)
9. [Concurrency & Safety](#9-concurrency--safety)
10. [User Interface](#10-user-interface)
11. [Process Management & Deployment](#11-process-management--deployment)
12. [Security](#12-security)
13. [Testing](#13-testing)
14. [Documentation](#14-documentation)
15. [Dependencies & Footprint](#15-dependencies--footprint)
16. [Extensibility & Plugin System](#16-extensibility--plugin-system)
17. [Metrics & Scale](#17-metrics--scale)
18. [Known Limitations & Trade-offs](#18-known-limitations--trade-offs)
19. [Summary Scorecard](#19-summary-scorecard)
20. [Migration Considerations](#20-migration-considerations)

---

## 1. Project Overview

| Attribute | DEXBot (original) | DEXBot2 |
|---|---|---|
| **Version** | 1.0.0 | 0.6.0-patch.21 |
| **Language** | Python 3.6+ | Node.js (JavaScript ES2022) |
| **Status** | Alpha / Maintenance | Active Development |
| **Last Update** | ~May 2020 | February 2026 |
| **License** | MIT | MIT |
| **Origin** | BitShares worker-proposal funded, Codaone Oy | Private rewrite by froooze |
| **Primary Goal** | Multi-strategy, extensible trading framework | Hardened, single-strategy grid bot |
| **Target Exchange** | BitShares DEX | BitShares DEX |
| **Lines of Code** | ~10,846 (Python) | ~15,000+ (JavaScript) |
| **Source Files** | 72 Python files | 30+ JS modules |

### Summary

DEXBot (original) is a community-governed, multi-strategy trading framework built in Python with a full GUI and plugin system. It was designed to be user-friendly and extensible, supporting multiple strategies and external price feeds out of the box.

DEXBot2 is a ground-up rewrite in Node.js focused entirely on a single, deeply engineered grid trading strategy. It trades breadth of features for depth of correctness, adding production-grade state management, concurrency safety, and a comprehensive test suite.

---

## 2. Technology Stack

| Layer | DEXBot | DEXBot2 |
|---|---|---|
| **Language** | Python 3.6+ | Node.js LTS (JavaScript) |
| **GUI** | PyQt5 (desktop GUI) | None (CLI only) |
| **CLI Framework** | Click | Custom (readline-sync, native) |
| **Blockchain Client** | `bitshares` Python library | `btsdex` Node.js library |
| **Key Management** | `uptick` (BitShares wallet) | Custom AES-256-GCM encrypted store |
| **Database / State** | SQLite via SQLAlchemy ORM | JSON flat files (no DB) |
| **DB Migrations** | Alembic | N/A |
| **Process Manager** | Systemd service (Linux) | PM2 |
| **External APIs** | CoinGecko, CCXT, Waves | None (on-chain only) |
| **Container** | Docker (Ubuntu 18.04) | Docker (multi-stage) |
| **Dashboard** | PyQt5 GUI | Rust/Ratatui TUI (in progress) |
| **Testing** | pytest + Docker testnet | Native Node.js assert (40+ tests) |
| **CI/CD** | Travis CI, AppVeyor | GitHub Actions |
| **Packaging** | PyInstaller (Win/Mac/Linux binaries) | npm / PM2 ecosystem |

### Key Difference

DEXBot brings a full Python scientific ecosystem and desktop GUI. DEXBot2 runs headlessly in a terminal, deploying on any server via PM2 with minimal dependencies — just Node.js and two npm packages.

---

## 3. Architecture

### DEXBot — Event-Driven Plugin Framework

```
┌─────────────────────────────────────────────┐
│              WorkerInfrastructure            │
│          (threading.Thread)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Worker 1 │  │ Worker 2 │  │ Worker N │  │
│  │(Strategy)│  │(Strategy)│  │(Strategy)│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │         │
│  ┌────▼──────────────▼──────────────▼──────┐ │
│  │         BitShares WebSocket Events       │ │
│  │  (ontick / onMarketUpdate / onAccount)   │ │
│  └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
         │ Config (YAML)    │ State (SQLite)
```

- **Single thread** manages all workers
- Workers react to **blockchain events** (blocks, market updates, account changes)
- Each worker is a **plugin** implementing a Strategy interface
- State persisted in **SQLite** (orders, balances, config)
- GUI runs separately in the **main thread**

**Pattern:** Event-driven, callback-based, plugin architecture.

---

### DEXBot2 — Layered Engine with Copy-on-Write State

```
┌──────────────────────────────────────────────────────────┐
│                    DEXBot (dexbot_class.js)               │
│              Trading Loop + Lifecycle Manager             │
│  ┌────────────────────────────────────────────────────┐  │
│  │                   OrderManager                      │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────┐ ┌──────────┐  │  │
│  │  │Accountant│ │Strategy  │ │Grid  │ │SyncEngine│  │  │
│  │  │(Funds)   │ │(Boundary │ │(Geo  │ │(Chain    │  │  │
│  │  │          │ │ Crawl)   │ │ Grid)│ │ Reconcile│  │  │
│  │  └──────────┘ └──────────┘ └──────┘ └──────────┘  │  │
│  │                                                      │  │
│  │         Master Grid (Immutable Orders Map)           │  │
│  │              ↓ (COW clone on rebalance)              │  │
│  │         Working Grid (Isolated Planning Copy)        │  │
│  │              ↓ (atomic commit on success)            │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ BitShares    │  │ NodeManager  │  │ MarketAdapter │   │
│  │ Client       │  │ (Failover)   │  │ (Real-time)   │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
└──────────────────────────────────────────────────────────┘
         │ Config (JSON)    │ State (JSON flat files)
```

- **Four specialized engines** (Accountant, StrategyEngine, Grid, SyncEngine) coordinate through OrderManager
- **Copy-on-Write** grid: planning happens on isolated copy; committed atomically or discarded on failure
- **No event callbacks**: polling-based loop with adaptive fill detection
- State in **JSON flat files** (no database dependency)
- Each PM2 process manages **one bot**

**Pattern:** Layered engines, polling with adaptive batching, immutable/COW state management.

---

### Architecture Comparison

| Dimension | DEXBot | DEXBot2 |
|---|---|---|
| **Core Pattern** | Event-driven callbacks | Polling + adaptive batching |
| **Concurrency Model** | Python threading (GIL-bound) | Node.js async + AsyncLock semaphores |
| **State Storage** | SQLite (relational, queryable) | JSON flat files (simple, no dependency) |
| **State Safety** | Mutable shared state per worker | Copy-on-Write immutable master grid |
| **Multi-bot Scaling** | Single thread, multiple workers | One PM2 process per bot |
| **Strategy Coupling** | Loosely coupled via base class | Single strategy deeply integrated |
| **Recovery Model** | Restart from SQLite state | Startup reconciliation + blockchain re-sync |
| **Error Isolation** | Per-worker exception handling | Per-engine try/catch, up to 5 recovery retries |

---

## 4. Trading Strategies

### DEXBot — Three Built-in Strategies + Plugin System

#### Relative Orders Strategy
- Uses **external price feeds** (CoinGecko, CCXT, Waves) as reference price
- Maintains buy/sell orders at a **relative spread** around the external price
- Adjusts when price deviates beyond a configured threshold
- Best for: market making in active, liquid markets
- Requires: active monitoring and regular tweaking
- Risk: price feed latency or manipulation

#### Staggered Orders Strategy (2,256 lines — largest module)
- **"Set and forget"** approach
- Creates **multiple staggered buy/sell orders** across a price range
- Profits by capturing spread repeatedly as market oscillates
- Replenishes filled orders from profits
- Best for: volatile markets, bootstrapping new markets
- Risk: inventory skew in strongly trending markets

#### King of the Hill Strategy
- Places **single buy or sell order** closest to the opposing side
- Continuously **re-stakes position** to stay at the top of the book
- Aggressive, high-frequency market making
- Best for: competitive, active markets
- Risk: high transaction fee cost

#### Plugin System
- Custom strategies can be installed as Python packages
- Discovery via `setuptools` entry points
- User bot directory: `~/bots`
- Template available: `strategy_template.py`

---

### DEXBot2 — Single Boundary-Crawl Grid Strategy

#### Boundary-Crawl Grid Strategy (deeply engineered)
- Creates a **geometric price grid** from min to max price
- **Fixed reference boundary** divides BUY zone (below) from SELL zone (above)
- **Dynamic spread gap** around market price (configurable `targetSpreadPercent`)
- On fill: grid **crawls** — boundary shifts, slots reassign roles, new orders placed
- **Partial fill consolidation**: dust detection and cleanup
- **Adaptive fill batching**: 1–4 fills processed per cycle based on queue depth

```
Price Scale (geometric, e.g. 0.4% increments):
  ─── maxPrice
  │   SELL slot 5
  │   SELL slot 4
  │   SELL slot 3
  ═══ spread zone (targetSpreadPercent gap)
  │   BUY slot 2   ← market price here
  │   BUY slot 1
  ─── minPrice
```

#### No Plugin System
- Single strategy is not swappable at runtime
- Strategy logic is deeply integrated into OrderManager, Grid, and Accountant

---

### Strategy Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Number of Strategies** | 3 built-in + plugins | 1 (boundary-crawl grid) |
| **Custom Strategies** | Yes (plugin system) | No |
| **External Price Feeds** | Yes (CoinGecko, CCXT, Waves) | No (on-chain only) |
| **Strategy Isolation** | Yes (each worker independent) | N/A (one strategy) |
| **Grid Trading** | Staggered Orders (similar concept) | Yes (core, heavily engineered) |
| **Market Making** | Relative Orders, KOTH | Yes (spread-based) |
| **Rebalancing Logic** | Per-strategy | Centralized in OrderManager |
| **Partial Fill Handling** | Basic | Advanced (consolidation, dust detection) |
| **Boundary Mechanics** | N/A | Atomic boundary-crawl with role reassignment |

---

## 5. Order Management

### DEXBot

- Orders tracked in **SQLite** (`Orders` table) alongside real blockchain orders
- Virtual order support (simulation without placing real orders)
- Order operations in `BitsharesOrderEngine` (34KB class)
- No formal order state machine — strategies manage order lifecycle directly
- Orders fetched from blockchain via `bitshares` library on each tick
- **No Copy-on-Write**: mutable shared state, no atomic commits

### DEXBot2

- Orders tracked in an **in-memory `Map`** (master grid) + JSON snapshots
- Formal **order state machine**: `VIRTUAL → ACTIVE → PARTIAL`
- **Copy-on-Write**: planning on isolated `WorkingGrid`, atomic commit to master
- Two-pass blockchain reconciliation on every sync cycle:
  1. Match master grid orders to on-chain orders
  2. Create entries for unexpected on-chain orders
  3. Mark orphaned grid orders as VIRTUAL
- **Ghost order prevention**: robust full-fill detection
- **Version epoch tracking**: stale working grids detected and aborted

### Order Management Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Order State Machine** | Informal | Formal (VIRTUAL/ACTIVE/PARTIAL) |
| **Storage** | SQLite | In-memory Map + JSON snapshots |
| **Virtual Orders** | Yes | Yes |
| **COW / Atomic Commits** | No | Yes |
| **Reconciliation** | Per-tick fetch | Two-pass sync engine |
| **Orphan Detection** | Basic | Full two-pass matching |
| **Ghost Order Prevention** | Basic | Hardened (multiple guards) |
| **Partial Fill Tracking** | Basic | Advanced (per-order tracking) |
| **Dust Detection** | No | Yes |
| **Stale State Detection** | No | Version epoch tracking |

---

## 6. Configuration System

### DEXBot

- **Format:** YAML (`~/.config/dexbot/config.yml`)
- **Interactive setup:** `whiptail`-based text UI wizard
- **GUI configuration:** full PyQt5 forms for each strategy
- Each strategy defines `ConfigElement` tuples for self-describing configuration
- Asset intersection management for multi-worker accounts (automatic balance splitting)
- Node list configurable; `resetnodes` CLI command resets to defaults
- **No encryption** of config values; relies on file-system permissions

```yaml
# Example config.yml excerpt
workers:
  MyBot:
    module: dexbot.strategies.staggered_orders
    account: my-account
    market: XRP/BTS
    center_price: 1.5
    spread: 4.0
    increment: 2.0
    lower_bound: 0.5
    upper_bound: 5.0
    operational_percent_base: 50
    operational_percent_quote: 50
```

### DEXBot2

- **Format:** JSON (`profiles/bots.json`, `profiles/general.settings.json`)
- **No interactive wizard** — manual JSON editing
- **14 frozen configuration objects** in `modules/constants.js` (loaded at startup)
- Runtime parameters via environment variables (`RUN_LOOP_MS`, `BOT_NAME`, etc.)
- `profiles/general.settings.json` for global timing/limits/node settings
- **Encrypted key storage** (AES-256-GCM) with RAM-only master password

```json
// Example bots.json entry
{
  "name": "XRP-BTS",
  "active": true,
  "assetA": "IOB.XRP",
  "assetB": "BTS",
  "startPrice": "pool",
  "minPrice": "2x",
  "maxPrice": "2x",
  "incrementPercent": 0.4,
  "targetSpreadPercent": 4,
  "weightDistribution": { "sell": 1, "buy": 1 },
  "botFunds": { "sell": "100%", "buy": "100%" },
  "activeOrders": { "sell": 5, "buy": 5 }
}
```

### Configuration Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Format** | YAML | JSON |
| **Interactive Setup** | Yes (whiptail + PyQt5 GUI) | No (manual edit) |
| **Key Encryption** | No (file-system only) | Yes (AES-256-GCM) |
| **Multi-bot in one config** | Yes (YAML array) | Yes (JSON array) |
| **Runtime overrides** | Env vars (limited) | Env vars (full) |
| **Hot reload** | Partial (restart worker) | No (restart process) |
| **Validation** | `config_validator.py` | `modules/order/utils/validate.js` |
| **Documentation** | Strategy ConfigElement docs | README + developer_guide.md |

---

## 7. Exchange & Blockchain Integration

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Exchange** | BitShares DEX | BitShares DEX |
| **Client Library** | `bitshares` (Python, v0.5.x) | `btsdex` (Node.js, v0.7.x) |
| **Key Management** | `uptick` library | Custom AES-256-GCM + RAM-only password |
| **Connection Mode** | WebSocket (event-driven) | WebSocket (polling + subscriptions) |
| **Multi-node Failover** | Yes (latency-sorted) | Yes (health-checked) |
| **External Price Feeds** | CoinGecko, CCXT, Waves | None |
| **Account Type** | Single or multi-account | Per-bot account |
| **Order Operations** | Place, cancel, update via `bitshares` lib | Place, cancel, update via `btsdex` |
| **Asset Metadata** | Fetched via `bitshares` | Fetched on startup, cached |
| **Balance Queries** | Per tick via library | Periodic + event-triggered |
| **Fee Handling** | Basic (relies on library) | Advanced (reservation system, fee accounting) |

---

## 8. Fund & Balance Accounting

### DEXBot

- Balance queried each tick from blockchain
- Per-strategy allocation via `operational_percent_base/quote`
- Multi-worker balance split calculated automatically
- No formal fund invariant system
- Virtual orders tracked in SQLite for simulation
- No fee reservation mechanism

### DEXBot2 — Accountant Engine (dedicated module)

The `Accountant` class is a **Single Source of Truth** for all fund state:

```
Available Funds = max(0, ChainFree - Virtual - FeesOwed - FeesReservation)

Where:
  ChainFree        = on-chain liquid balance
  Virtual          = Σ sizes for VIRTUAL (planned, not-yet-placed) orders
  FeesOwed         = accumulated BTS fees (liability)
  FeesReservation  = safety buffer for future operations
```

- **Fund invariant**: `Total = Free + Committed` — verified before every operation
- **Optimistic proceeds**: fills treated as available immediately (pre-confirmation)
- **Fee reservation**: ensures future operations never fail due to missing fees
- **Atomic snapshots**: consistent reads across all fund components
- **Recovery triggers**: invariant violation automatically initiates recovery cycle

### Accounting Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Balance Source** | Blockchain per-tick | Blockchain + local accounting |
| **Fund Invariant** | No | Yes (verified each operation) |
| **Fee Reservation** | No | Yes (BTS buffer maintained) |
| **Virtual Order Accounting** | SQLite | In-memory with invariant tracking |
| **Multi-worker Balance Split** | Yes (automatic) | N/A (one bot per process) |
| **Overdraft Protection** | Basic | Yes (invariant enforcement) |
| **Optimistic Proceeds** | No | Yes |
| **Accounting Audit Trail** | No | Partial (logging) |

---

## 9. Concurrency & Safety

### DEXBot

- Python **threading** (subject to GIL for CPU-bound work)
- Single worker thread manages all strategies
- Thread-safe config via `threading.Lock`
- Mutable shared state — no formal protection against concurrent mutation
- No atomic commits for order state changes
- WebSocket callbacks can interrupt strategy execution

### DEXBot2

- **Node.js async/await** (single-threaded event loop, no GIL)
- **AsyncLock** semaphores guard all critical sections:
  - `_gridLock`: serializes grid mutations
  - `_syncLock`: ensures one full sync at a time
  - Per-order locks for specific operations
- **Copy-on-Write** grid: rebalancing cannot corrupt master state
- **Version epoch counter** (`_gridVersion`): stale working grids detected and aborted
- **Double-check pattern**: consistency validated both outside and inside locks
- **Layer 1 & Layer 2 defenses** against rapid-restart cascades
- **Lock refresh mechanism**: prevents timeout during long blockchain operations

### Concurrency Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Threading Model** | Python threads (GIL) | Node.js async (event loop) |
| **Shared State Protection** | `threading.Lock` | AsyncLock semaphores (hierarchy) |
| **Atomic State Commits** | No | Yes (COW pattern) |
| **Stale State Detection** | No | Yes (version epochs) |
| **Concurrent Fill Safety** | Partial | Yes (fill batching + COW) |
| **Deadlock Prevention** | Basic | Formal lock hierarchy |
| **Rapid-restart Protection** | No | Yes (Layer 1 + Layer 2) |

---

## 10. User Interface

### DEXBot

- **Full PyQt5 desktop GUI** (`gui.py`)
  - Worker list with real-time status
  - Worker detail view (open orders, balances)
  - Strategy configuration dialogs (per-strategy forms)
  - Wallet creation and unlock dialogs
  - Settings panel
- **Text-based CLI setup** (`whiptail`) for headless environments
- **Click CLI** for command-line control
- Designed to be accessible to non-technical users

### DEXBot2

- **CLI-only** (no GUI)
- `dexbot.js`: multi-bot management, config viewing, log tailing
- `bot.js`: single bot launcher
- `pm2.js`: PM2 orchestration (start, stop, restart, status, logs)
- `unlock-start.js`: single-prompt startup helper
- **Rust/Ratatui TUI dashboard** (in development — not yet complete)
- Designed for operators comfortable with terminal and JSON config

### UI Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Desktop GUI** | Yes (PyQt5) | No |
| **Interactive Config Wizard** | Yes (GUI + whiptail) | No |
| **TUI Dashboard** | No | In development (Rust/Ratatui) |
| **CLI** | Yes (Click) | Yes (custom) |
| **Real-time Status** | GUI view | PM2 status + log tailing |
| **Accessibility** | High (non-technical users) | Low (requires CLI comfort) |

---

## 11. Process Management & Deployment

### DEXBot

- **Systemd service** (Linux): `runservice` command installs unit file
- Passphrase via environment variable (`BITSHARES_PASSPHRASE`)
- `sdnotify` for service readiness notifications
- Docker: Ubuntu 18.04 base, single container
- Windows/Mac/Linux: **PyInstaller binaries** (no runtime required)
- Raspberry Pi support
- Single process manages all bots (workers)

### DEXBot2

- **PM2** process manager
  - One PM2 process per bot
  - Auto-restart on crash
  - `ecosystem.config.js` template for PM2
  - Log management (PM2 log rotation)
- **credential-daemon.js**: RAM-only key management daemon
- Docker: multi-stage Dockerfile
- **Automated updates**: daily repository pull with branch tracking
- No binary packages — requires Node.js runtime
- Horizontal scaling: add more PM2 processes for more bots

### Deployment Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Process Manager** | Systemd | PM2 |
| **Multi-bot Scaling** | One process (multi-thread) | One PM2 process per bot |
| **Auto-restart** | Systemd restart policy | PM2 auto-restart |
| **Binary Distribution** | Yes (PyInstaller) | No (requires Node.js) |
| **Docker** | Yes | Yes |
| **Systemd Integration** | Yes (sdnotify) | No |
| **Automated Updates** | No | Yes (daily pull) |
| **Raspberry Pi** | Yes | Yes (Node.js supported) |
| **Windows** | Yes (binary) | Partial (PM2 on Windows) |

---

## 12. Security

### DEXBot

- Keys stored in **BitShares wallet** (`uptick`) — file-based, password-protected
- Config file at `~/.config/dexbot/config.yml` — plain text (file permissions only)
- Passphrase passed via environment variable or prompted at startup
- No key encryption beyond `uptick` wallet format
- No memory-wipe of sensitive data

### DEXBot2

- **AES-256-GCM encrypted key storage** (`profiles/keys.json`)
- **RAM-only master password**: never written to disk (set only in environment, wiped after use)
- `credential-daemon.js`: manages key decryption in a separate daemon process
- Config in plain JSON but no keys stored in config (separate encrypted store)
- `.gitignore` ensures `keys.json` and sensitive files are never committed
- **Fund invariant enforcement**: prevents accidental overdraft

### Security Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Key Encryption** | uptick wallet (basic) | AES-256-GCM |
| **Password Handling** | Env var or prompt | RAM-only (never disk) |
| **Config Sensitivity** | YAML (may include secrets) | JSON (keys separate) |
| **Key Storage Format** | Wallet file | Encrypted JSON |
| **Memory Safety** | No explicit wipe | RAM-only password |
| **Overdraft Protection** | No | Fund invariant system |
| **Audit Logging** | Basic | Structured per-component logging |

---

## 13. Testing

### DEXBot

- **Framework:** `pytest`
- **Test types:**
  - Unit tests (strategies, storage, primitives)
  - Integration tests (Docker-based local BitShares testnet)
  - Migration tests (Alembic schema migrations)
  - Price feed tests (CoinGecko, CCXT, Waves)
- **Testnet:** Docker-composed local BitShares node
- Tests cover external integrations realistically
- Pre-commit hooks via `.pre-commit-config.yaml`

### DEXBot2

- **Framework:** Native Node.js `assert` module (no external test framework)
- **40+ test files** covering:
  - Unit tests: accounting, strategy, grid, manager logic
  - Copy-on-Write semantics: COW commits, guards, concurrent fills
  - Edge cases: ghost orders, partial fills, BTS fee accounting, precision
  - Concurrency: fill batching, lock behaviors
  - Scenario tests: specific bug reproductions
- Tests run with `npm test` (concatenated `node` commands)
- No Docker testnet — pure unit/integration testing with mocks
- Migrated from Jest to eliminate all external test dependencies

### Testing Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Framework** | pytest | Native Node.js assert |
| **Test Count** | ~20-30 | 40+ |
| **Test Types** | Unit + integration | Unit + integration + edge-case |
| **Testnet Integration** | Yes (Docker) | No (mocks) |
| **External Dependency** | pytest, Docker | None |
| **COW / Concurrency Tests** | No | Yes (dedicated suite) |
| **Edge Case Coverage** | Moderate | Extensive |
| **CI Integration** | Travis CI, AppVeyor | GitHub Actions |

---

## 14. Documentation

### DEXBot

- **Sphinx docs** (`docs/`): setup, configuration, events, storage, strategy development
- **README.md**: overview, strategy descriptions, installation links
- **Medium article**: step-by-step getting started guide
- Community wiki (external)
- Strategy development guide via Sphinx
- No formal architecture documentation

### DEXBot2

| Document | Size | Purpose |
|---|---|---|
| `README.md` | 12 KB | Quick start, installation, config reference |
| `docs/architecture.md` | 48 KB | System design, data flows, COW pattern |
| `docs/COPY_ON_WRITE_MASTER_PLAN.md` | 24 KB | Deep dive into COW implementation |
| `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` | 30 KB | Fund tracking model, invariants |
| `docs/developer_guide.md` | 56 KB | Developer quick start, glossary, examples |
| `docs/EVOLUTION.md` | 18 KB | Project history, 3-phase development |
| `docs/IMPROVEMENT_ROADMAP.md` | 13 KB | Historical bugs, recommended improvements |
| `docs/LOGGING.md` | 21 KB | Logging categories and configuration |
| `docs/WORKFLOW.md` | 7 KB | Branch strategy, commit standards |
| `docs/TEST_UPDATES_SUMMARY.md` | 14 KB | Test suite coverage and improvements |
| `docs/TYPESCRIPT_MIGRATION_ANALYSIS.md` | 23 KB | Future TypeScript migration roadmap |
| `AGENTS.md` | 6.5 KB | AI development context |
| `CHANGELOG.md` | Very large | Full version history (983 commits) |

### Documentation Comparison

| Aspect | DEXBot | DEXBot2 |
|---|---|---|
| **Format** | Sphinx RST + Markdown | Markdown only |
| **API Docs** | Sphinx auto-generated | Inline JSDoc comments |
| **Architecture Docs** | None | Extensive (architecture.md, 48 KB) |
| **Developer Guide** | Sphinx strategybase.rst | developer_guide.md (56 KB) |
| **Fund Model** | None | FUND_MOVEMENT_AND_ACCOUNTING.md (30 KB) |
| **Changelog** | None | CHANGELOG.md (complete, 983 commits) |
| **Accessibility** | Moderate | Technical / developer-focused |

---

## 15. Dependencies & Footprint

### DEXBot

**Production dependencies (requirements.txt):**
- `pyqt5 >= 5.10` — GUI framework (~80MB)
- `bitshares >= 0.5.0` — blockchain client
- `uptick >= 0.2.4` — key management
- `ccxt >= 1.17` — 100+ exchange API (~10MB)
- `pywaves >= 0.8` — Waves integration
- `sqlalchemy >= 1.3` — ORM
- `alembic >= 1.0` — migrations
- `click >= 7.0` — CLI
- `ruamel.yaml >= 0.15` — YAML parser
- `sdnotify >= 0.3` — systemd
- `requests >= 2.21` — HTTP client
- Total: **~15-20 packages**, significant install size

**Dev dependencies:** pytest, docker, pyinstaller, pre-commit

### DEXBot2

**Production dependencies (package.json):**
- `btsdex ^0.7.11` — BitShares DEX client
- `bs58check ^4.0.0` — key encoding
- `readline-sync ^1.4.10` — CLI prompts
- Total: **3 packages**, minimal footprint

### Dependency Comparison

| Metric | DEXBot | DEXBot2 |
|---|---|---|
| **Production Packages** | ~15-20 | 3 |
| **Dev Packages** | ~5-8 | 0 (native assert) |
| **GUI Framework** | PyQt5 (~80MB) | None |
| **Database ORM** | SQLAlchemy | None |
| **External Price APIs** | CoinGecko, CCXT, Waves | None |
| **Install Size (approx)** | Large (100MB+) | Small (<20MB with node_modules) |
| **Runtime Requirement** | Python 3.6+ | Node.js LTS |

---

## 16. Extensibility & Plugin System

### DEXBot

- **Plugin architecture** via `setuptools` entry points
- Install a Python package → strategy auto-discovered
- User bot directory: `~/bots` for quick custom strategies
- Strategy template (`strategy_template.py`) provided
- Strategies are fully decoupled from the framework
- Community can publish and install strategies independently

### DEXBot2

- **No plugin system**
- Single hardcoded strategy (boundary-crawl grid)
- Extending requires forking the codebase or modifying core modules
- Market adapter (`market_adapter/`) allows real-time parameter tuning
- `analysis/` tools for offline AMA fitting and trend detection

### Extensibility Comparison

| Feature | DEXBot | DEXBot2 |
|---|---|---|
| **Plugin System** | Yes (setuptools entry points) | No |
| **Custom Strategies** | Yes | No |
| **Strategy Template** | Yes | No |
| **Community Strategy Sharing** | Yes (PyPI packages) | No |
| **Runtime Parameter Tuning** | Via config/restart | MarketAdapter (in progress) |
| **Analysis Tools** | No | Yes (AMA fitting, trend detection) |

---

## 17. Metrics & Scale

| Metric | DEXBot | DEXBot2 |
|---|---|---|
| **Version** | 1.0.0 | 0.6.0-patch.21 |
| **Active Since** | ~2018 | December 2025 |
| **Last Commit** | ~May 2020 | February 2026 |
| **Total Commits** | Unknown (mature project) | 983 (3 months) |
| **Lines of Code** | ~10,846 | ~15,000+ |
| **Source Files** | 72 Python files | 30+ JS modules |
| **Test Files** | ~20-30 | 40+ |
| **Documentation** | Sphinx docs + README | 14 comprehensive Markdown files |
| **Strategies** | 3 + plugins | 1 |
| **Max Concurrent Bots** | Many (one process) | Many (one process per bot, PM2) |
| **Primary Developer** | Codaone Oy (team) | froooze (individual, 99.1% commits) |
| **Community** | BitShares worker-funded | Private |
| **Governance** | "The Cabinet" (6-person, 3/5 multisig) | None |

---

## 18. Known Limitations & Trade-offs

### DEXBot Limitations

- **No longer actively maintained** (last commit ~May 2020, 6 years ago)
- Python GIL limits true parallelism for multi-worker scenarios
- Mutable shared state — susceptible to race conditions in multi-worker use
- No formal fund invariant enforcement — overdraft possible under edge cases
- YAML config has no key encryption (relies on OS file permissions)
- Staggered Orders strategy can suffer inventory skew in strong trends
- External price feeds introduce latency and potential for price manipulation
- PyQt5 dependency adds significant install complexity and size
- SQLite state can desync from blockchain after unclean shutdowns

### DEXBot2 Limitations

- **Single strategy only** — no flexibility for different market conditions
- No GUI — requires CLI proficiency
- No external price feed support (on-chain prices only)
- JSON config requires manual editing (no wizard)
- No built-in backtesting framework
- Rust TUI dashboard not yet complete
- No community/plugin ecosystem
- Heavy documentation suggests significant learning curve for contributors
- 983 commits in 3 months suggests rapid, potentially unstable iteration

---

## 19. Summary Scorecard

| Category | DEXBot | DEXBot2 | Winner |
|---|---|---|---|
| **Strategy Variety** | ★★★★★ (3 + plugins) | ★☆☆☆☆ (1) | DEXBot |
| **State Safety** | ★★☆☆☆ | ★★★★★ (COW + invariants) | DEXBot2 |
| **Fund Accounting** | ★★☆☆☆ | ★★★★★ (formal model) | DEXBot2 |
| **Concurrency Safety** | ★★☆☆☆ | ★★★★★ (AsyncLock + COW) | DEXBot2 |
| **Security** | ★★★☆☆ | ★★★★★ (AES-256-GCM, RAM-only) | DEXBot2 |
| **Ease of Setup** | ★★★★★ (GUI wizard) | ★★☆☆☆ (manual JSON) | DEXBot |
| **Accessibility** | ★★★★★ (GUI) | ★★☆☆☆ (CLI only) | DEXBot |
| **Testing Depth** | ★★★☆☆ | ★★★★★ (40+ edge-case tests) | DEXBot2 |
| **Documentation** | ★★★☆☆ | ★★★★★ (14 detailed docs) | DEXBot2 |
| **Dependency Footprint** | ★★☆☆☆ (heavy) | ★★★★★ (3 packages) | DEXBot2 |
| **Extensibility** | ★★★★★ (plugins) | ★☆☆☆☆ | DEXBot |
| **Active Maintenance** | ★☆☆☆☆ (abandoned) | ★★★★★ (active) | DEXBot2 |
| **Grid Strategy Depth** | ★★★☆☆ (Staggered) | ★★★★★ (engineered) | DEXBot2 |
| **Process Management** | ★★★☆☆ (Systemd) | ★★★★☆ (PM2) | DEXBot2 |
| **Community/Ecosystem** | ★★★★☆ | ★☆☆☆☆ | DEXBot |
| **Multi-Strategy Support** | ★★★★★ | ★☆☆☆☆ | DEXBot |

---

*Report generated 2026-02-19. DEXBot2 analyzed at commit `986a28a`. DEXBot analyzed at HEAD of DEXBot-master.*
