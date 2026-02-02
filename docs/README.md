# DEXBot2 Documentation

This directory contains the comprehensive technical documentation for the DEXBot2 trading bot. It is designed to guide developers from high-level architecture down to the nuances of fund accounting and state management.

---

## 🛠️ Core System Documentation

### 🏛️ [Architecture](architecture.md)
*The blueprint of the system.*
- **System Design**: High-level overview of how the bot components interact.
- **Module Responsibilities**: Detailed breakdown of the **Manager**, **Accountant**, **Strategy**, and **Grid** modules.
- **Fund-Driven Boundary Sync**: Automatic grid alignment with inventory distribution (Patch 8)
- **Scaled Spread Correction**: Dynamic spread correction with double-dust safety (Patch 8)
- **Periodic Market Price Refresh**: Background 4-hour price updates (Patch 8)
- **Out-of-Spread Metric**: Numeric distance refinement for precise corrections (Patch 8)
- **Pipeline Safety & Diagnostics**: 5-minute timeout safeguard and health monitoring (Patch 12)
- **Data Flow**: Visualization of how market data becomes trading operations and then blockchain transactions.

### 📖 [Developer Guide](developer_guide.md)
*Your daily companion for coding.*
- **Quick Start**: How to get the development environment running.
- **Module Deep-Dive**: In-depth analysis of the internal logic of each primary module.
- **Startup Sequence & Lock Ordering**: Consolidated startup with deadlock prevention (Patch 9)
- **Zero-Amount Order Prevention**: Validation gates for healthy order sizes (Patch 9)
- **Configurable Pricing Priority**: Fixed vs dynamic startPrice behavior (Patch 8)
- **Pool ID Caching**: Optimization for price derivation (Patch 8)
- **Order State Helper Functions**: Centralized predicate functions for state checking (Patch 11)
- **Common Tasks**: Practical "how-to" guides for adding features or fixing bugs.
- **Glossary**: Definitions of project-specific terminology (e.g., "Virtual Orders", "Rotation", "Pipeline Safety", "Fund-Driven Boundary").

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
- **BTS Fee Object Structure**: `netProceeds` field for accounting precision (Patch 8)
- **BUY Side Sizing & Fee Accounting**: Correct fee application by order side (Patch 8)
- **Mixed Order Fund Validation**: Separate validation for BUY vs SELL order fund checks (Patch 12)
- **Fee Management**: Detailed logic for BTS fee reservations and market fee deductions.

### 📝 [Logging System](LOGGING.md)
*Observability and debugging.*
- **Severity Levels**: Guidelines on using `info`, `warn`, `error`, and `debug`.
- **Log Rotation**: Configuration for managing log file sizes and retention.
- **Performance**: How the logging system minimizes overhead during high-frequency events.

### 🧪 [Test Suite Updates](TEST_UPDATES_SUMMARY.md)
*Reliability and regression testing.*
- **Recent Fixes**: Summary of test coverage added for the most recent critical bugfixes.
- **Integration Scenarios**: Documentation of complex multi-fill and partial-fill test cases.
- **Verification**: How to use the test suite to validate grid stability.

---

## 📂 Source Code Map

While these docs explain the *why*, the *how* lives in the code:
- **`modules/dexbot_class.js`**: The main entry point and orchestration layer.
- **`modules/order/manager.js`**: Central controller for the order lifecycle.
- **`modules/order/accounting.js`**: The engine for fund tracking and invariant checks.
- **`modules/order/strategy.js`**: The brains behind order placement and grid logic.
- **`modules/order/utils.js`**: A centralized library of 10+ categories of helper functions.