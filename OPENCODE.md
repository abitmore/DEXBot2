# Opencode Development Context - DEXBot2

## Branch Strategy
**Pipeline: `test` → `dev` → `main`** (ONE DIRECTION ONLY!)

- **test**: Primary development branch (where work happens)
- **dev**: Integration/staging (merged from test)
- **main**: Production-ready (merged from dev)

⚠️ **KEY RULE**: Always merge **test → dev**, NEVER dev → test
⚠️ **KEY RULE**: Do NOT use `npm run pmain` for automated branch synchronization. Always merge and push branches manually or as requested by the user to ensure explicit control over the deployment process.

See `docs/WORKFLOW.md` for detailed workflow guide.

## Current Status
| Branch | Commits Ahead | Status |
|--------|---|--------|
| test | 100 | ✓ Synced with origin/test |
| dev | 100 | ✓ Synced with origin/dev |
| Both | Equal | ✓ Fully synchronized |

## Key Modules
- `dexbot.js` - Entry point
- `modules/dexbot_class.js` - Core bot class
- `modules/order/` - Order management (manager, strategy, grid, accounting, sync_engine)
- `modules/chain_orders.js`, `account_orders.js`, `account_bots.js` - Chain interaction
- `modules/constants.js` - Configuration

## Quick Commands
```bash
# Create feature
git checkout test && git pull
git checkout -b feature/my-feature test

# Merge to test
git checkout test && git pull && git merge --no-ff feature/my-feature && git push

# Integrate to dev
git checkout dev && git pull && git merge --no-ff test && git push

# Release to main
git checkout main && git pull && git merge --no-ff dev && git push
```

## Key Files

### Entry Points
- `dexbot.js` - Main CLI entry point (executable)
- `bot.js` - Alternative bot starter
- `pm2.js` - PM2 process management

### Core Bot
- `modules/dexbot_class.js` - Core bot class and logic (1424 lines)
- `modules/constants.js` - Centralized configuration and tuning parameters

### Order Management (`modules/order/`)
- `manager.js` - Order lifecycle and state management (2852+ lines)
- `grid.js` - Grid calculation, placement, and management
- `strategy.js` - Trading strategy (anchor & refill, consolidation)
- `accounting.js` - Fee accounting and fund tracking
- `sync_engine.js` - Blockchain synchronization
- `startup_reconcile.js` - Startup order reconciliation
- `utils.js` - Utility functions (1254+ lines)
- `index.js` - Module exports
- `logger.js` - Order logging
- `runner.js` - Order execution runner
- `async_lock.js` - Concurrency control

### Blockchain Interaction
- `modules/chain_orders.js` - Blockchain order operations (269+ lines)
- `modules/account_orders.js` - Account order queries (454+ lines)
- `modules/account_bots.js` - Account bot data management (314+ lines)

### Configuration & Examples
- `examples/bots.json` - Bot configuration examples
- `profiles/ecosystem.config.js` - PM2 ecosystem configuration
- `package.json` - Dependencies and npm scripts

### Testing
- `tests/` - Comprehensive test suite including integration tests and ported unit logic:
  - `test_accounting_logic.js` - Ported from accounting.test.js
  - `test_strategy_logic.js` - Ported from strategy.test.js
  - `test_sync_logic.js` - Ported from sync_engine.test.js
  - `test_grid_logic.js` - Ported from grid.test.js
  - `test_manager_logic.js` - Ported from manager.test.js
  - `test_bts_fee_logic.js` - Ported from bts_fee_settlement.test.js
  - Scenario and integration tests (fills, grid, manager, etc.)

## Recent Updates
- **Native Test Porting**: Ported all unit tests from Jest (`tests/unit/`) to native Node.js `assert` (`tests/test_*_logic.js`) to eliminate heavy devDependencies in standard installations. Removed `jest` and `tests/unit/` directory.
- **BTS Fee Accounting Fix**: Corrected under-counting of fees during order rotations and size updates. Unified deduction logic in `Accountant` to handle all on-chain fees via `total` balance reduction.
- **Rotation Synchronization**: Fixed `SyncEngine` to correctly apply `updateFee` during order rotations, ensuring `synchronizeWithChain` reflects actual blockchain costs.
- **Unified Resize Accounting**: Migrated manual `chainFree` deductions in `DEXBot` to the centralized `_updateOrder` flow, ensuring consistent tracking of both total and free balances.
- **Fund Rotation Fix**: Aligned `rebalanceSideRobust` in `strategy.js` with the `main` branch's budgeted rotation model.
- **Available Funds Bug**: Eliminated double-deduction of `inFlight` funds in `utils.js::calculateAvailableFundsValue`, ensuring rotations proceed when capital is available.
- **Accounting Stabilization**: Reported `recalculateFunds` in `accounting.js` to match the strict `main` branch structure.
- **Startup Invariant Suppression**: Suppressed transient fund invariant warnings during the bootstrap phase. Added `startBootstrap()` and enhanced `finishBootstrap()` in `OrderManager` to explicitly control the bootstrap lifecycle. Integrated these into `recalculateGrid` and `performResync` to ensure invariant checks are paused during transient states. Added `tests/test_resync_invariants.js` for verification.
- **Resync Order Duplication Fix**: Fixed a bug where triggered resyncs would create new orders instead of updating existing ones. Resolved a `ReferenceError` in `utils.js::parseChainOrder` and refactored `reconcileStartupOrders` in `startup_reconcile.js` to use **delta-based balance checks**. This allows existing orders to be updated/reused even when liquid funds are low, preventing duplicate order placements. Added `tests/test_resync_balance_fix.js`.
- **Dynamic Configuration Refresh**: Implemented periodic (4h) refresh of `bots.json` in `dexbot_class.js` to pick up manual configuration changes (like `startPrice`) without process restart. Updates memory valuation anchors while maintaining "fund-driven" operational stability (no auto-rebalancing).
- **Streamlined `startPrice` Logic**: Centralized `startPrice` handling across all bot states. If numeric, it acts as the **Single Source of Truth**, blocking auto-derivation. Used for valuation during runtime and as a fixed anchor during grid resets. Updated `architecture.md` and `developer_guide.md` with configuration management details.
- **Refined Optimistic Accounting**: Centralized fund updates in `manager.js::_updateOrder` with `skipAccounting` support for full-sync scenarios.
- **Documentation**: Updated fund model overview in `runner.js` to reflect refined handling of `virtual` fund commitments.

## Documentation
- `README.md` - Full documentation
- `docs/WORKFLOW.md` - Branch workflow
- `docs/architecture.md` - System architecture and module relationships
- `docs/developer_guide.md` - Developer quick start and glossary
- `docs/TEST_UPDATES_SUMMARY.md` - Recent test coverage improvements
- `FUND_MOVEMENT_AND_ACCOUNTING.md` - (In docs/) Unified fund accounting and grid mechanics
- `CHANGELOG.md` - Version history
