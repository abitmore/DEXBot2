# DEXBot2 Documentation

This directory contains the comprehensive technical documentation for the DEXBot2 trading bot. It is designed to guide developers from high-level architecture down to the nuances of fund accounting and state management.

---

## 🛠️ Core System Documentation

### 🏛️ [Architecture](architecture.md)
*The blueprint of the system.*
- **Design Philosophy**: Simplicity, constant spread, minimal blockchain interaction, and closed-loop market dynamics.
- **System Design**: High-level overview of how the bot components interact.
- **Module Responsibilities**: Detailed breakdown of the **Manager**, **Accountant**, **Strategy**, and **Grid** modules.
- **Copy-on-Write Pattern**: Safe concurrent rebalancing with isolated working grids (see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md))
- **Fill Processing Pipeline**: Adaptive batch fill processing (1-4 fills per broadcast, ~24s for 29 fills)
- **Fund-Driven Boundary Sync**: Automatic grid alignment with inventory distribution
- **Spread Correction**: Conservative, fund-aware maintenance of constant spread width
- **Periodic Market Price Refresh**: Background 4-hour price updates
- **Pipeline Safety & Diagnostics**: 5-minute timeout safeguard and health monitoring
- **Data Flow**: Visualization of how market data becomes trading operations and then blockchain transactions.

### 📖 [Developer Guide](developer_guide.md)
*Your daily companion for coding.*
- **Quick Start**: How to get the development environment running.
- **Module Deep-Dive**: In-depth analysis of the internal logic of each primary module.
- **Copy-on-Write Pattern**: How to work safely within the COW rebalance pipeline; `WorkingGrid` usage and master-grid commit rules (see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md))
- **Startup Sequence & Lock Ordering**: Consolidated startup with deadlock prevention
- **Zero-Amount Order Prevention**: Validation gates for healthy order sizes
- **Configurable Pricing Priority**: Fixed vs dynamic startPrice behavior
- **Pool ID Caching**: Optimization for price derivation
- **Order State Helper Functions**: Centralized predicate functions for state checking
- **Common Tasks**: Practical "how-to" guides for adding features or fixing bugs.
- **Glossary**: Definitions of project-specific terminology (e.g., "Virtual Orders", "Rotation", "Pipeline Safety", "Fund-Driven Boundary", "WorkingGrid", "COW Commit").

### 🔄 [Workflow](WORKFLOW.md)
*How we build and release.*
- **Branching Strategy**: Explanation of the `test` → `dev` → `main` lifecycle.
- **CI/CD Patterns**: Standards for merging and ensuring code quality across branches.

---

## 🔬 Specialized Technical References

### 💰 [Fund Movement & Accounting](FUND_MOVEMENT_AND_ACCOUNTING.md)
*The most critical part of the bot: safe capital management.*
- **Single Source of Truth**: How the bot avoids double-spending and out-of-sync balances.
- **Optimistic ChainFree**: The mechanism that allows the bot to trade with fill proceeds before they are finalized on-chain.
- **Fill Batch Processing**: Adaptive batch sizing for efficient fill processing (1-4 fills per cycle)
- **Partial Order Consolidation**: Simplified, direct consolidation through grid rebuilding (no merge/split mechanics)
- **Dust Detection & Management**: Unhealthy partials are absorbed into next grid rebuild cycle
- **BTS Fee Object Structure**: `netProceeds` field for accounting precision
- **BUY Side Sizing & Fee Accounting**: Correct fee application by order side
- **Mixed Order Fund Validation**: Separate validation for BUY vs SELL order fund checks
- **Fee Management**: Detailed logic for BTS fee reservations and market fee deductions.

### 📝 [Logging System](LOGGING.md)
*Observability and debugging.*
- **Severity Levels**: Guidelines on using `info`, `warn`, `error`, and `debug`.
- **Log Rotation**: Configuration for managing log file sizes and retention.
- **Performance**: How the logging system minimizes overhead during high-frequency events.
- **Batch Processing Logs**: Fill batching, recovery retry, and orphan-fill deduplication messages.

### 🧪 [Test Suite Updates](TEST_UPDATES_SUMMARY.md)
*Reliability and regression testing.*
- **Recent Fixes**: Summary of test coverage added for the most recent critical bugfixes.
- **Integration Scenarios**: Documentation of complex multi-fill and partial-fill test cases.
- **Fill Batching Tests**: Regression tests for adaptive batching and recovery retry system.
- **Verification**: How to use the test suite to validate grid stability.

---

## 📂 Source Code Map

While these docs explain the *why*, the *how* lives in the code. See [root README 📦 Modules section](../README.md#-modules) for comprehensive module documentation:

**Core Modules:**
- **`modules/dexbot_class.js`**: Bot initialization, account setup, order placement, fill processing, and rebalancing
- **`modules/order/manager.js`**: Central controller with Copy-on-Write rebalancing pattern (see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md))
- **`modules/order/working_grid.js`**: COW grid wrapper enabling safe concurrent rebalancing with isolated modifications
- **`modules/order/grid.js`**: Grid generation, sizing, divergence detection, and spread management
- **`modules/order/accounting.js`**: Fund tracking, available balance calculation, fee deduction, and committed fund management
- **`modules/order/strategy.js`**: Grid rebalancing, order activation, consolidation, rotation, and spread management
- **`modules/order/sync_engine.js`**: Blockchain synchronization, fill detection, order reconciliation

**Utilities & Support:**
- **`modules/order/utils/math.js`**: Precision conversions, RMS divergence calculation, fund allocation math
- **`modules/order/utils/order.js`**: Order state predicates, grid indexing, reconciliation helpers, strategy calculations
- **`modules/order/utils/validate.js`**: Order validation, grid reconciliation, COW action building
- **`modules/order/utils/order_comparison.js`**: Epsilon-based order comparison and COW delta building
- **`modules/order/utils/grid_indexes.js`**: Index building utilities used by WorkingGrid
- **`modules/order/utils/system.js`**: System utilities, price derivation, fill deduplication
- **`modules/order/startup_reconcile.js`**: Startup grid reconciliation and offline fill detection