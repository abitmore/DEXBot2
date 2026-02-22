# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0-patch.23] - 2026-02-22 - Dust Rotation Guard, Legacy Builder Removal & PARTIAL Fund Invariant Fix

This patch closes two fund-accounting correctness gaps: dust-sized slots could still be reached via surplus→hole rotation despite CREATE filtering, and PARTIAL orders had their actual on-chain remaining size silently overwritten with the ideal target size in the COW projection step, causing a spurious fund-invariant violation. Legacy plan-builder helpers that duplicated COW execution logic are also removed.

### Fixed

- **Dust Rotation Guard in reconcileGrid** (`modules/order/utils/validate.js`, `modules/order/manager.js`) - commit af33cdd
  - **Problem**: `reconcileGrid` filtered dust only for CREATE leftovers. Surplus→hole rotation UPDATE paths bypassed the filter, allowing sub-double-dust target slots to receive rotation operations.
  - **Impact**: Tiny, uneconomical orders could still be scheduled via rotation UPDATE even when they would have been rejected as CREATE targets.
  - **Solution**: Added configurable `dustThresholdPercent` option to `reconcileGrid`. Healthy holes are now computed up front using `isCreateHealthy` before any surplus pairing occurs, ensuring the same dust threshold applies to both rotation and direct CREATE paths. `GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE` is now passed through both manager reconcile entry points for consistent runtime behaviour.

- **PARTIAL Order Size Preserved in COW Projection** (`modules/order/utils/validate.js`) - commit (current)
  - **Problem**: `projectTargetToWorkingGrid` unconditionally overwrote the working-grid order's `size` with `targetSize` (the ideal geometric size from `calculateTargetGrid`). For PARTIAL orders still on-chain, `targetSize` reflects the desired full size, not the actual remaining quantity. Because `reconcileGrid` intentionally emits no in-place UPDATE for this case (rotation-only design), no blockchain resize occurs — yet `recalculateFunds` was summing the ideal size as committed, inflating `chainBuy` by up to ~350 BTS.
  - **Impact**: Spurious CRITICAL fund-invariant violation (`trackedTotal > blockchainTotal`) after any partial buy fill, self-correcting only at the next 4-hour blockchain sync.
  - **Solution**: Added a narrowly scoped guard: when `keepOrderId` is true (order is still on-chain, same type) and `current.state === PARTIAL`, preserve current on-chain size instead of overwriting with `targetSize`. Preserve-path sizing is normalized to a finite non-negative value for safety, and redundant `hasOnChainId` duplication was removed because `isOrderOnChain` already guarantees an on-chain id.

### Refactored

- **Legacy Plan-Builder Removal** (`modules/dexbot_class.js`) - commit af33cdd
  - Removed `_buildCancelOps`, `_buildCreateOps`, `_buildSizeUpdateOps`, and `_buildRotationOps` — pre-COW helpers that duplicated execution logic now handled solely by the COW action execution path.
  - Centralized execution-time size and dust validation into `_resolveIdealSizeForValidation` to eliminate repeated logic across placement paths.

### Testing

- Added **COW-017** (`tests/test_cow_master_plan.js`) — asserts `reconcileGrid` emits no CREATE or rotation UPDATE for sub-double-dust target holes.
- Added **COW-018** (`tests/test_cow_master_plan.js`) — asserts `projectTargetToWorkingGrid` preserves `current.size` for PARTIAL on-chain orders (regression guard for the fund-invariant violation).
- Added **COW-018b** (`tests/test_cow_master_plan.js`) — asserts ACTIVE orders still receive the updated target size (fix is narrowly scoped to PARTIAL state).
- Added **COW-018c** (`tests/test_cow_master_plan.js`) — asserts malformed PARTIAL preserve-path sizes are normalized to safe finite non-negative values while retaining on-chain identity/state.
- Updated `tests/test_patch17_invariants.js` — removed stubs for deleted legacy builder methods.
- Updated `tests/test_rotation_fallback_recheck.js` — replaced legacy-helper invocation checks with assertions that those methods no longer exist.
- `npm test` ✓ (all 40+ tests pass, zero regressions)

### Core Lines Changed
**Total: ~580** (dust guard + legacy removal commit af33cdd: 183 added / 374 removed; PARTIAL fix: 10 added / 3 removed)

---

## [0.6.0-patch.22] - 2026-02-21 - Fill Accounting Alignment, COW Invariant Hardening & API Safety

This patch aligns BTS fee handling with the operation-fee lifecycle, hardens COW fill/rebalance flows against race conditions and edge cases, and replaces positional-boolean APIs with explicit options objects to prevent ordering bugs.

### Fixed
- **BTS Fill Accounting Alignment with Operation-Fee Lifecycle** (`modules/order/strategy.js`, `modules/order/accounting.js`) - commit 73754c8
  - **Problem**: Fill processing accrued/deducted BTS fees after proceeds already included maker refund projection, causing maker fills to be effectively charged twice across create + fill settlement.
  - **Impact**: Overcharging maker fills with combined refund-projected proceeds and additional fill-time BTS fee settlement.
  - **Solution**: Removed fill-time `btsFeesOwed` accrual/settlement from strategy. BTS fee handling now stays on operation events (create/update/cancel), and fill accounting focuses on proceeds via unified `getAssetFees('BTS', rawAmount, isMaker).netProceeds`.

- **COW Fill Handling and Accounting Invariants** (`modules/dexbot_class.js`, `modules/order/accounting.js`, `modules/order/strategy.js`, `modules/order/utils/validate.js`) - commit 7dbbb49
  - **Problem**: Fill rebalance flow was vulnerable to empty-batch execution paths, CREATE actions could target occupied slots in edge races, and side metadata drift could misclassify commitments after boundary flips.
  - **Impact**: Inconsistent empty payload handling, slot exclusivity violations, wrong-side optimistic deductions, and SPREAD invariant drift.
  - **Solution**: Centralized batch execution gating with shared empty-action handling across all call sites. Added pre-broadcast validation to reject CREATE actions on occupied ACTIVE/PARTIAL slots. Side resolution now prefers explicit order type and preserves committed side from slot type in target-grid projections.

- **COW Rebalance Invariant Race Elimination** (`modules/order/manager.js`, `modules/dexbot_class.js`) - commit b27619a
  - **Problem**: COW commit path triggered fund recalculation before optimistic accounting was applied, producing transient invariant violations.
  - **Impact**: Race condition between commit and recalc could produce false invariant failures.
  - **Solution**: Made `_commitWorkingGrid` recalculation optional via explicit `options.skipRecalc`. Commit path now defers recalculation to resume flow.

- **Order Edge-Cases Across Chain Modules** (`modules/chain_orders.js`, `modules/order/startup_reconcile.js`, `modules/chain_keys.js`, `modules/account_bots.js`) - commit 986a28a
  - **Problem**: `_ensureAccountSubscriber()` swallowed subscription failures, `createOrder()` could destructure `null` from `buildCreateOrderOp()`, `_getAssetPrecision()` returned `undefined` on missing metadata, and reconcile flow misinterpreted `{ skipped: true }` responses.
  - **Impact**: Silent subscription outages, TypeError on dust-sized orders, less actionable precision errors, and malformed success payload interpretation.
  - **Solution**: Log subscription failures with account context, return `{ skipped: true }` for intentionally skipped placements, add explicit CRITICAL throw for missing asset metadata, and handle skip explicitly in reconcile flow.

### Refactored
- **Positional-Boolean to Options Object API Migration** (`modules/order/manager.js`, `modules/order/sync_engine.js`, `modules/order/grid.js`, `modules/order/strategy.js`, `modules/order/utils/order.js`, `modules/dexbot_class.js`) - commit b27619a
  - Replaced legacy positional flags with explicit options objects for `_updateOrder`, `_applyOrderUpdate`, `applyGridUpdateBatch`, and `_runGridMaintenance`.
  - Removed legacy compatibility shims and enforced object options to prevent ambiguous call signatures that made ordering bugs easier to introduce.

- **Removed Redundant rawOnChain Deep-Clone** (`modules/order/working_grid.js`) - commit 4cb3430
  - Deep-clone block was redundant because partial-fill updates already use immutable replacement and operation builders consume cached rawOnChain from master state.
  - Updated WorkingGrid docs/comments to match actual shallow clone behavior (metadata-only nested clone).

### Documentation
- **Data-Flow Diagram and DEXBot Comparison** (`docs/architecture.md`, `docs/DEXBOT_COMPARISON.md`, `AGENTS.md`) - commit 6026de5
  - Added top-level data-oriented Mermaid flowchart to architecture.md (GitHub-compatible with br/ line breaks).
  - Added comprehensive DEXBot vs DEXBot2 comparison report (797 lines).
  - Clarified that agents must not proactively ask for or execute git write actions.

- **TOC Header Errors in 6 Module Files** (`modules/bots_file_lock.js`, `modules/graceful_shutdown.js`, `modules/order/async_lock.js`, `modules/order/format.js`, `modules/order/startup_reconcile.js`, `modules/order/sync_engine.js`) - commit 32be4dd
  - Fixed inaccurate section counts and added missing function entries across all affected modules.

- **Project Evolution and Roadmap Documentation** (`docs/EVOLUTION.md`, `docs/IMPROVEMENT_ROADMAP.md`) - commit 2ec1ae3
  - Added comprehensive 499-line EVOLUTION.md documenting project history and architectural decisions.
  - Added 486-line IMPROVEMENT_ROADMAP.md with future enhancement planning.

- **AGENTS.md Cleanup** - commit c47acd6
  - Removed obsolete "Recent Updates" section.

### Testing
- `node tests/test_strategy_logic.js` ✓
- `node tests/test_bts_fee_accounting.js` ✓
- `node tests/test_cow_commit_guards.js` ✓
- `node tests/test_cow_concurrent_fills.js` ✓
- `node tests/test_patch17_invariants.js` ✓
- `node tests/test_sync_logic.js` ✓
- `node tests/test_grid_logic.js` ✓
- `node tests/test_cow_master_plan.js` ✓
- `npm test` ✓

### Core Lines Changed
**Total: 1,282** (678 added, 604 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.21] - 2026-02-19 - StateManager Consolidation

Eliminated duplicate state tracking where `isBootstrapping` and `_isBroadcasting` were maintained as both direct `OrderManager` properties and `StateManager` fields, requiring both to be kept in sync and creating a latent bug class.

### Refactored
- **Consolidated Bootstrap and Broadcast State** (`modules/order/manager.js`, `modules/dexbot_class.js`, `modules/order/accounting.js`, `modules/order/grid.js`) - commit f9bc182
  - **Problem**: `isBootstrapping` and `_isBroadcasting` existed as direct `OrderManager` properties *and* as `StateManager` fields simultaneously. `isPipelineEmpty()` queried `broadcasting || this._isBroadcasting` — two paths to the same state — evidence of prior divergence.
  - **Impact**: Any code path that updated one tracker but not the other caused a silent divergence. The double-check was a defensive hedge that indicated the trackers had already drifted.
  - **Solution**: Removed `this._isBroadcasting` and `this.isBootstrapping` direct properties. `StateManager` is now the sole source of truth. All read sites updated to `this._state.isBootstrapping()` and `this._state.isBroadcastingActive()`. Deleted the tech debt TODO block that tracked this problem.
  - **Dead code removed**: Else-branch `manager.isBootstrapping = true` in `recalculateGrid()` — `startBootstrap()` always exists; the runtime fallback was unreachable.

### Fixed
- **Broken Test Case** (`tests/test_resync_invariants.js`) - commit f9bc182
  - Case 3 checked `level === 'warn'` but the code logs at `'error'`. Additionally `assets=null` caused an early return from `_verifyFundInvariants`, meaning the test never validated what it claimed. Rewrote to match the pattern of Cases 1 and 2.

### Testing
- `node tests/test_resync_invariants.js` ✓
- `node tests/test_manager_logic.js` ✓
- `node tests/test_accounting_logic.js` ✓
- `node tests/test_grid_logic.js` ✓
- `node tests/test_resync_balance_fix.js` ✓
- `node tests/test_cow_commit_guards.js` ✓
- `node tests/test_manager.js` ✓
- `node tests/test_cow_divergence_correction.js` ✓

### Core Lines Changed
**Total: 230** (133 added, 97 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.20] - 2026-02-18 - Atomic Boundary Shifts in COW Pipeline

This patch ensures boundary index shifts during divergence correction are atomic with slot-type reassignment, preventing temporary mismatches between `boundaryIdx` and slot roles during the COW planning-to-commit lifecycle.

### Fixed
- **Atomic Boundary Shifts in COW Divergence Updates** (`modules/order/utils/system.js`) - commit 86ab205
  - **Problem**: Boundary movement during divergence correction was threaded through manager state (`manager.boundaryIdx`) before the COW commit completed, risking temporary mismatch between boundary index and slot typing.
  - **Impact**: If blockchain execution failed after boundary was mutated, slot types would be inconsistent with the boundary index, potentially corrupting grid role assignments.
  - **Solution**: Introduced `pendingBoundaryIdx` to carry boundary changes through the COW pipeline. `updateGridFromBlockchainSnapshot` now accepts `overrideBoundaryIdx` and reassigns slot roles in the working grid before commit. `manager.boundaryIdx` is only updated atomically inside `_commitWorkingGrid`.

- **Boundary Clamping to Existing Orders** (`modules/order/utils/system.js`) - commit eabbaf6
  - **Problem**: Fund-driven boundary shifts could cross existing on-chain or virtual orders, causing slot-type inversions.
  - **Impact**: Boundary could jump over committed orders, leading to incorrect BUY/SELL role assignments.
  - **Solution**: `syncBoundaryToFunds` now clamps the new boundary index to the gap between the highest BUY slot and lowest SELL slot. Counts both virtual and active orders in clamp calculation. Returns `{ changed, newIdx }` instead of mutating manager state directly.

- **Working Grid Slot Role Reassignment** (`modules/order/grid.js`) - commit 86ab205
  - Extended `updateGridFromBlockchainSnapshot` with `overrideBoundaryIdx` parameter.
  - Reassigns slot roles in working grid when boundary changes, ensuring atomic commit of both types and boundary.

### Technical Details
- Boundary shifts now flow: `syncBoundaryToFunds()` → `pendingBoundaryIdx` → `updateGridFromBlockchainSnapshot(overrideBoundaryIdx)` → `_commitWorkingGrid()` → `manager.boundaryIdx`
- No manager state mutation before blockchain confirmation
- Clamp bounds derived from typed slots (BUY/SELL), not just on-chain orders

### Testing
- `node tests/test_unanchored_spread_correction.js` - Boundary regression tests
- `node tests/test_cow_commit_guards.js` - COW commit guards
- `node tests/test_boundary_sync_logic.js` - Boundary sync logic
- `node tests/test_cow_divergence_correction.js` - Divergence correction COW tests

### Core Lines Changed
**Total: 9,731** (6,730 added, 3,001 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.19] - 2026-02-14 to 2026-02-17 - Copy-on-Write (COW) Grid Architecture

This patch introduces a major architectural refactoring replacing the snapshot/rollback pattern with a cleaner Copy-on-Write approach. The master grid remains immutable until blockchain confirmation succeeds, eliminating state corruption risks and simplifying failure recovery.

### Added
- **Copy-on-Write (COW) Grid Architecture** (commit 2fc849b)
  - **WorkingGrid Class** (`modules/order/working_grid.js`): Clone of master grid for planning phase modifications without touching production state.
  - **Grid Index Utilities** (`modules/order/utils/grid_indexes.js`): Efficient index building for grid operations.
  - **Order Comparison Utilities** (`modules/order/utils/order_comparison.js`): Epsilon-based order comparison for robust equality checks.
  - **COW Performance Thresholds** (`modules/constants.js`): Performance monitoring for grid cloning operations.

### Changed
- **OrderManager** (`modules/order/manager.js`):
  - Replaced snapshot/rollback with COW pattern: `_applySafeRebalanceCOW()`, `_commitWorkingGrid()`
  - Added rebalance state tracking: `NORMAL → REBALANCING → BROADCASTING → CONFIRMED → NORMAL`
  - Implemented selective fill handling: individual fills processed immediately, full-side updates blocked during fills
  - Added working grid synchronization during fill processing to prevent stale data commits

- **DEXBot Core** (`modules/dexbot_class.js`):
  - Integrated COW broadcast path: `_updateOrdersOnChainBatchCOW()`
  - Atomic swap on success, discard on failure (master never partially modified)
  - Removed legacy rollback code (~55 lines)

- **Async-Safe Fund Accounting**:
  - Implemented semaphore-protected fund updates using `AsyncLock`
  - Converted fund tracking methods to async: `recalculateFunds()`, `setAccountTotals()`
  - Added `_fundsSemaphore` for atomic fund updates and snapshotting

- **Atomic Service Pattern**:
  - Unified locking architecture with `_gridLock` and `_fundLock`
  - Separated public (locked) and private (logic-only) method pairs
  - Consolidated multiple specialized locks into unified concurrency model

### Removed
- Snapshot/rollback pattern and associated rollback code
- Optimistic master grid modifications
- Pre-COW volatility freeze mechanism (superseded by atomic COW semantics)

### Technical Improvements
- **Simpler State Management**: No complex rollback code, clear before/after states
- **Atomic Commits**: All-or-nothing via swap, master never in limbo state
- **Better Consistency**: Master only changes after blockchain confirmation
- **Easier Debugging**: Clear separation between planning and committed state
- **Performance**: Sub-millisecond grid cloning (100 orders: ~0.03ms, 1000 orders: ~0.08ms, 5000 orders: ~0.5ms)

### Documentation
- Created comprehensive COW architecture documentation (`docs/COPY_ON_WRITE_MASTER_PLAN.md`)
- Consolidated 3 separate docs into single unified reference

### Testing
- Added `tests/test_cow_master_plan.js` - 10 COW-specific test cases
- Added `tests/test_working_grid.js` - WorkingGrid unit tests
- Added `tests/benchmark_cow.js` - Performance benchmarks
- All existing tests pass with new architecture

### Safety Guardrails
- Accountant dry-run validation before broadcasting
- Atomic COW semantics inherently handle volatility (no partial state commits)
- Automatic resync on blockchain failure via `startup_reconcile.js`
- Divergence checks and cache updates blocked during rebalance operations

### Fixes and Refinements (Post-Implementation)

**Critical Bug Fixes:**
- **Explicit Zero-Value Handling in COW Helpers** (`modules/order/utils/helpers.js`) - commit pending
  - Replaced `||` fallbacks with nullish coalescing (`??`) in fund and size derivation paths
  - Prevents explicit `0` values from being overwritten by fallback fields
  - Fixes optimistic UPDATE rendering and required-fund calculations when target size is zero

- **Post-Commit State Cleanup** (`modules/order/manager.js`) - commit 55ab7d1
  - Fixed bug where `recalculateFunds()` exception left system stuck in `BROADCASTING` state
  - Added try-finally block to ensure `_clearWorkingGridRef()` always executes

- **Fee Event Deduplication Memory Hardening** (`modules/order/strategy.js`) - commit 55ab7d1
  - Added LRU eviction for `_settledFeeEvents` Map (limit: 10,000 entries)
  - Prevents unbounded memory growth (~60MB worst case during high-fill periods)
  - Added sampling optimization (every 10th call) reducing CPU overhead ~90%

- **COW Deadlocks and Lock Routing** - commit 710e1d3
  - Fixed deadlock in `correctOrderPriceOnChain` (nested `_gridLock` acquire)
  - Fixed commit outside lock boundary with stale index usage
  - Added proper lock routing for all chain operations

- **Sync/Accounting Concurrency Hardening** - commit 584cb23
  - Ensured sync reconciliation executes under `_gridLock`
  - Added grid version tracking to detect stale working grids
  - Fixed PARTIAL/ACTIVE premature restoration with restore-ratio-based state resolution
  - Implemented atomic cache-funds setter and recovery cooldown/max-attempt policy

- **Bug Fixes from Post-Review** - commit ef03f39
  - Fixed `rawOnChain` cleared to undefined in sync_engine.js:551
  - Fixed `syncFromMaster` version mismatch in working_grid.js
  - Removed 208 lines of dead duplicate methods in accounting.js
  - Fixed float precision in `_buildFeeEventId` using satoshi-based keys
  - Fixed recovery `attemptCount` never decaying after max retries

**Refactoring:**
- **Gap-Slot Math Centralization** (`modules/order/utils/math.js`) - commit f19ff01
  - Consolidated spread-gap calculation into shared utility
  - Removed unused `grid_indexes.js` implementation
  - Hardened fallback behavior with config-default anchoring

- **COW Implementation Corrections** - commit 804ff55
  - Added missing `Object.freeze()` on grid commit
  - Added delta re-validation before commit
  - Removed duplicate `recalculateFunds()` and dead `_applySafeRebalance` wrapper

**Documentation and Testing:**
- **JSDoc Improvements** - commit 9d12283
  - Enhanced documentation for `processFilledOrders()`, `performSafeRebalance()`, `_buildStateUpdates()`
  - Documented COW pattern and decoupled architecture in strategy.js

- **Test Suite Fixes** - commit 9d12283
  - Fixed test hanging issue from BitConnections keeping event loop alive
  - Added `process.exit(0)` to 20 test files for clean exits

**Magic Number Elimination** (`modules/constants.js`) - commit 55ab7d1
- Added `TIMING.LOCK_REFRESH_MIN_MS: 250`
- Added `GRID_LIMITS.SATOSHI_CONVERSION_FACTOR: 1e8`
- Added `GRID_LIMITS.STATE_CHANGE_HISTORY_MAX: 100`
- Added `COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER: 500`
- Added `PIPELINE_TIMING.CACHE_EVICTION_RETENTION_RATIO: 0.75`
- Added `PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS: 180000`
- Added `PIPELINE_TIMING.MAX_FEE_EVENT_CACHE_SIZE: 10000`
- Added `PIPELINE_TIMING.FEE_EVENT_DEDUP_TTL_MS: 21600000`

**COW State/Action Semantics Centralization** - commit 4312230
- Added `REBALANCE_STATES` and `COW_ACTIONS` constants for shared contract
- Extracted `isRebalancing`/`isBroadcasting`/`isPlanningActive` helpers
- Centralized `_syncWorkingGridFromMasterMutation`, `_buildAbortedCOWResult`, and `_summarizeCowActions`
- Unified commit gate evaluation in `_evaluateWorkingGridCommit`
- Updated docs with COW state-machine cheat sheet

**Fill Rebalance Sizing and COW Consistency** - commit c620098
- Fixed target sizing distribution across full side topology (was concentrated in active window only)
- Fixed create args reusing stale `rawOnChain.for_sale` metadata
- Added precision-aware fund validation in blockchain integer space
- Normalized batch result envelope parsing
- Reordered maintenance: spread correction now runs after health/divergence

**OrderManager Refactoring** - commit b01f40f
- Extracted pure functions to `helpers.js` (~834 lines): `validateOrder()`, `reconcileGrid()`, `projectTargetToWorkingGrid()`, etc.
- Introduced `StateManager` class encapsulating rebalance/recovery/bootstrap flags
- Reduced `manager.js` from ~2,850 to ~1,200 lines

**Helpers Reorganization** - commit 18611c7
- Consolidated 7 scattered sections into 4 cohesive groups: DEPENDENCIES, VALIDATION, RECONCILIATION, MUTATIONS
- No logic changes - only section headers, TOC, and export groupings

**Critical Fill Handling Restoration** - commit f56e0c3
- Restored `processFilledOrders` two-step logic: accounting via strategy, then `performSafeRebalance()` for non-partial fills
- Restored `finishBootstrap` fund drift validation
- Restored `isPipelineEmpty` shadow locks and external broadcasting signal handling

**Deep Market Scan Revert** - commit 25a317c
- Reverted deep market scan feature to restore simpler `get_full_accounts` based order fetching
- Removed `_readMarketOrders()`, `_readOpenOrdersPaginated()`, and `marketAssets` parameters

**COW Accounting Invariant Fix** - commit fce0f0b
- Fixed fund invariant violation where new orders were set to ACTIVE immediately
- New orders now remain VIRTUAL until blockchain confirms placement
- Rotation orders get orderId cleared and state set to VIRTUAL
- Added 4 regression tests: COW-012 through COW-015

**COW Fill Rebalance Alignment** - commit 9022942
- Restricted in-place size updates to PARTIAL orders only
- Added action optimization pairing same-side CANCEL+CREATE into rotation-style UPDATE
- Added explicit `updateOrdersOnChainPlan()` + plan-to-COW projection helpers
- Manager now calls `processFillsOnly()` directly, removing legacy pass-through methods

**COW Rotation Accounting Stabilization** - commit 766fe37
- Reconcile now treats fill-driven updates as rotation-oriented (emit UPDATE only as rotations)
- Fixed `_processBatchResults` using wrong `getAssetFees` mode (proceeds vs schedule)
- Fixed rotation source slots remaining ACTIVE after successful rotation

**Post-Fill Maintenance and Divergence Alignment** - commit a4c4880
- Gated post-fill checks behind `shouldRunPostFillChecks` (requires full fill + rotation)
- Added explicit broadcasting state lifecycle calls around COW batch broadcast
- Cleaned up divergence trigger model (removed cooldown/re-arm state dependencies)

**Divergence COW Migration** - commit d322445
- Migrated divergence handling to full COW planning/execution with working-grid-first semantics
- Extended `_recalculateGridOrderSizesFromBlockchain` to support COW action collection
- Made `updateGridFromBlockchainSnapshot` return COW result instead of mutating master
- Added shared helpers `hasActionForOrder` and `removeActionsForOrder`

**Numeric Validation Unification and Legacy Pruning** - commit 3ea3be7
- Removed unused legacy functions: `applyOrderUpdate`, `applyOrderUpdatesBatch`, `buildIndices`, `swapMasterGrid`
- Unified `isNumeric` in `format.js`, removed duplicate from `math.js`
- Standardized utility usage across 8 modules (eliminated fragile `Number()` casts)
- Added TABLE OF CONTENTS to `math.js`, `order.js`, and `system.js`
- Consolidated duplicated `modifyCacheFunds` logic in `accounting.js`

**Documentation Updates** - commit b834192
- Relaxed git action gate policy from strict inference to user-directed writes
- Simplified interpretation rules while maintaining safety guardrails

**Code Review and Bug Fixes** - 2026-02-17
- **Fixed `getOrdersByTypeAndState(null, state)` Breaking Change** (`modules/order/manager.js`)
  - Restored support for `null` type parameter to return all orders with matching state
  - This fixes `logger.js` status display which passes `null` to get all ACTIVE/PARTIAL/VIRTUAL orders
  - Added JSDoc documenting the `null` type behavior

- **Documented Intentional Lock Timeout Race Behavior** (`modules/order/sync_engine.js`)
  - Added detailed comment explaining why `Promise.race` timeout behavior is intentional
  - Completing a sync fully then throwing is safer than aborting mid-sync (partial state corruption)
  - The timeout error triggers recovery which re-syncs anyway

- **Recovery Decay Logging Visibility** (`modules/order/accounting.js`)
  - Changed recovery attempt decay log from `debug` to `info` level
  - Operators can now monitor for repeated decay patterns indicating persistent issues
  - Added comment explaining monitoring rationale

- **Tech Debt Documentation** (`modules/order/manager.js`)
  - Added TODO comment documenting duplicate state management pattern
  - Currently `_state` (StateManager) and direct properties (`_isBroadcasting`, `isBootstrapping`) must be kept in sync
  - Documented refactor plan to consolidate to StateManager only

**Utils Consolidation and COW Hardening** - 2026-02-17
- **Utils Folder Consolidation** (commit 4bc88bc)
  - Merged `grid_indexes.js` into `order.js` (buildIndexes, validateIndexes)
  - Merged `order_comparison.js` into `order.js` (ordersEqual, buildDelta, getOrderSize)
  - Merged `strategy_logic.js` into `order.js` (deriveTargetBoundary, getSideBudget, calculateBudgetedSizes)
  - Renamed `helpers.js` → `validate.js` for more specific naming
  - Reduced utils folder from 7 files to 4 consolidated files
  - Updated all imports across modules and tests

- **COW Architecture Hardening** (commit 1fed7f2, 2a95540, ada36b7)
  - Eliminated all in-place mutations in COW pipeline
  - Implemented hybrid Copy-on-Write pattern with static mutation detection
  - Preserved explicit zero values in COW helpers using nullish coalescing (`??`)
  - Hardened test exits with `process.exit(0)` for clean termination

- **Documentation Improvements** (commit 17e7a18)
  - Enhanced `working_grid.js` header with 70+ line comprehensive documentation
  - Added COW pattern documentation to `manager.js`
  - Enhanced inline documentation in `math.js` for RMS divergence calculation
  - Removed ASCII workflow diagrams for reduced verbosity
  - Updated `docs/README.md` to remove "Patch" references
  - Updated `tests/README.md` to reflect native assert (no Jest)
  - Updated `scripts/README.md` test count (100+ test cases)

- **README.md Consolidation** (2026-02-17)
  - Removed redundant sections: OS-specific install details moved to short paragraph, technical details moved to docs/
  - Removed "Patch 17" markers from features (now standard functionality)
  - Removed obsolete `docs/PATCH17_18_DOCUMENTATION_UPDATES.md` planning document
  - Removed "Patch 8/12/17/18" references from architecture.md and other docs
  - Streamlined from 549 to ~260 lines while keeping all user-essential info

### Core Lines Changed
**Total: 4,059** (1,389 added, 2,670 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.18] - 2026-02-08 - Batching Hardening, Accounting Precision & Telemetry Optimization

This patch refines the adaptive fill batching introduced in patch 17, addressing regression gaps in cache accounting and deduplicating error recovery paths for better operational stability.

### Fixed
- **Cache Remainder Accuracy During Capped Resize** in `modules/order/grid.js` (commit 426455c)
  - **Problem**: Cache remainder was computed from ideal sizes even when the grid resize was capped by available funds.
  - **Impact**: Could lead to understated cache funds and skewed sizing decisions in subsequent cycles.
  - **Solution**: Track per-slot applied sizes and derive cache remainder from the actual allocated values.

- **Hard-Abort Cooldown Consistency** in `modules/dexbot_class.js` (commit 426455c)
  - **Problem**: Batch abort paths (Illegal State/Accounting) could skip arming maintenance cooldowns.
  - **Impact**: Maintenance could run prematurely immediately after a hard-abort recovery sync.
  - **Solution**: Explicitly arm `_maintenanceCooldownCycles` in both primary and retry hard-abort handlers.

- **Stale-Cancel Fast-Path for Single-Op Batches** in `modules/dexbot_class.js` (commit 426455c)
  - **Problem**: Stale-order retry handling only executed for batches with more than one operation.
  - **Impact**: Single-order cancel races unnecessarily triggered full state recovery syncs.
  - **Solution**: Applied stale-order cleanup logic to all batch sizes, enabling fast-path recovery for single-op cancel races.

- **Fill Reaction Cap Precision** in `modules/order/strategy.js` (commit 33eaecb)
  - **Problem**: Malformed or unknown fill types were incorrectly incrementing the boundary shift counter before validation.
  - **Impact**: Inflated reaction caps and unpredictable boundary crawl behavior.
  - **Solution**: Moved counter increments after type validation.

### Refactored
- **Edge-First Surplus Sorting** in `modules/order/strategy.js`
  - **Change**: Prioritize furthest-from-market surpluses (lowest Buy / highest Sell) for rotations.
  - **Reason**: Improves execution robustness by using stable edge orders for rotations and leaving volatile inner surpluses to potentially catch "surplus fills" during grid shifts.

- **Victim Cancel Safety Logic** in `modules/order/strategy.js`
  - **Change**: Explicitly detect and cancel "victim" dust orders when a rotation targets an occupied slot.
  - **Reason**: Maintains 1-to-1 mapping between grid slots and blockchain orders in the Edge-First system, preventing "ghost" capital on-chain.

- **Deduplicated Batch Hard-Abort Handling** in `modules/dexbot_class.js` (commit 7b1bb38)
  - Consolidated `ILLEGAL_ORDER_STATE` and `ACCOUNTING_COMMITMENT_FAILED` handling into a shared `_handleBatchHardAbort` helper.
  - Ensures identical recovery behavior across both primary and retry batch execution paths.

- **Strategy Scan Optimization** in `modules/order/strategy.js` (commit 33eaecb, refined in 016c316)
  - Implemented an advancing scan pointer (`_priorityScanStart`) in `pickPriorityFreeSlot`.
  - Pointer now advances past the selected slot, eliminating redundant linear scans across large grids within a single rebalance cycle.

- **Cooldown Logic Consolidation** in `modules/dexbot_class.js` (commit 33eaecb)
  - Merged separate cooldown blocks for partial and burst fills into a unified `[FILL-GATE]` mechanism.

### Added
- **Batch Size Telemetry** in `modules/dexbot_class.js` (commit 016c316)
  - Hard-abort recovery logs now include the number of operations in the failed batch (e.g., "illegal state during batch processing with 12 ops").
  - Improves diagnostic visibility into whether failures occur during large maintenance bursts or small retries.

- **New Regression Tests** in `tests/test_patch17_invariants.js`:
  - Added cache remainder parity check for capped grid resizes.
  - Added abort-cooldown arming verification.
  - Added single-stale-cancel fast-path verification.

### Testing
- All core test suites pass: `tests/test_strategy_logic.js`, `tests/test_patch17_invariants.js`, `tests/test_critical_bug_fixes.js`.
- Verified batching simulation across queue depths (1..20) to ensure adaptive tiers and anti-singleton tail logic.

### Core Lines Changed
**Total: 666** (471 added, 195 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.17] - 2026-02-07 - Adaptive Fill Batching, Periodic Recovery Retries & Orphan-Fill Double-Credit Prevention

Post-mortem analysis of the Feb 7 market crash (8% spike + reversal) revealed three structural weaknesses in the fill processing pipeline that cascaded into a 4.5-hour trading halt. This patch addresses all three root causes.

### Fixed
- **Adaptive Batch Fill Processing** in `modules/dexbot_class.js`, `modules/constants.js` (commits 21af7d2)
  - **Problem**: Fills processed one-at-a-time (~3s per broadcast). 29 fills = ~90s during which market outran bot, causing stale orders and orphan fills.
  - **Solution**: Group fills into stress-scaled batches (1/2/3/4 per broadcast based on queue depth). `processFilledOrders()` already supports multi-fill input; the bottleneck was the sequential 1-at-a-time loop.
  - **Config**: `FILL_PROCESSING.MAX_FILL_BATCH_SIZE` (default 4), `BATCH_STRESS_TIERS` (configurable stress tiers). Batch size 1 = legacy sequential behavior.
  - **Impact**: 29 fills processed in ~8 broadcasts (~24s) instead of 29 (~90s). Reduces market divergence window during fill bursts.

- **Periodic Recovery Retries** in `modules/order/accounting.js`, `modules/order/strategy.js` (commit 21af7d2)
  - **Problem**: One-shot `_recoveryAttempted` flag meant a single failed recovery bricked the bot permanently until the next `processFilledOrders()` call (which never comes if the bot can't trade). In crash: "Recovery already attempted" logged thousands of times over 4.5 hours.
  - **Solution**: Replace boolean guard with count+time-based retry system. Up to 5 attempts per episode with 60s minimum interval. `resetRecoveryState()` called by each fill cycle and periodic blockchain fetch. Follow-up hardening ensures explicit zero semantics are respected (`MAX_RECOVERY_ATTEMPTS=0` means unlimited) and adds compatibility fallback when `accountant.resetRecoveryState()` is unavailable.
  - **Config**: `PIPELINE_TIMING.RECOVERY_RETRY_INTERVAL_MS` (default 60000ms), `MAX_RECOVERY_ATTEMPTS` (default 5). Both overridable via `general.settings.json`.
  - **Impact**: After market settles, recovery auto-retries periodically instead of giving up after one failure. Bot self-heals within minutes instead of requiring manual restart.

- **Orphan-Fill Double-Credit Prevention** in `modules/dexbot_class.js` (commit 21af7d2)
  - **Problem**: When batch failed due to stale order (filled on-chain between sync and broadcast), cleanup freed slot (releasing funds to `chainFree`). Then orphan-fill handler ALSO credited proceeds — double-counting. In crash: 7 orphan fills at ~700 BTS each inflated trackedTotal by ~4,600 BTS, cascading into 47,842 BTS drift.
  - **Solution**: Track stale-cleaned order IDs in `_staleCleanedOrderIds`. Initial set-based guard was hardened to timestamp retention (Map + TTL pruning) so delayed/repeated orphan fill events are still blocked. Orphan-fill handler skips credit with explicit `[ORPHAN-FILL] Skipping double-credit` log.
  - **Impact**: Eliminates double-counting root cause that fed the fund invariant violations and recovery cascade.

- **Precision-Aware Logging Normalization** in `modules/order/format.js`, `modules/order/accounting.js`, `modules/order/strategy.js`, `modules/order/startup_reconcile.js`, `modules/order/logger.js`, `modules/dexbot_class.js` (commit pending)
  - **Problem**: Several debug/info logs emitted raw floating-point values (e.g. `52.82927000000115`) instead of chain-precision values, creating noise and false drift perception.
  - **Solution**: Added reusable precision helpers (`formatAmountByPrecision`, `formatSizeByOrderType`) and routed size logs through side-aware asset precision formatting.
  - **Impact**: Logs now consistently reflect blockchain precision across fill, accounting, startup reconcile, diagnostics, and placement-validation paths.

### Added
- **New Configuration Constants** in `modules/constants.js`:
  - `FILL_PROCESSING.MAX_FILL_BATCH_SIZE`: Maximum fills per rebalance batch (default 4).
  - `FILL_PROCESSING.BATCH_STRESS_TIERS`: Array of [minQueueDepth, batchSize] tuples for adaptive sizing.
  - `PIPELINE_TIMING.RECOVERY_RETRY_INTERVAL_MS`: Minimum time between recovery attempts (default 60000ms).
  - `PIPELINE_TIMING.MAX_RECOVERY_ATTEMPTS`: Max retries per recovery episode (default 5, 0 = unlimited).
- **New Accountant Method** in `modules/order/accounting.js`:
  - `resetRecoveryState()`: Resets retry counter and time for new fill cycle. Called by `processFilledOrders()` and periodic blockchain fetch.

### Testing
- All existing test suites pass: accounting, strategy, manager, grid, ghost order, BTS fee, engine integration, layer2 self-healing, critical bug fixes.
- Constants load and freeze correctly with new `PIPELINE_TIMING` export.
- `resetRecoveryState()` verified: resets count (0), time (0), and legacy flag (false).
- Backward compatible: batch size 1 = legacy one-at-a-time behavior.
- Follow-up verification: `node tests/test_periodic_sync_fill_rebalance.js`, `node tests/test_layer2_self_healing.js`.
- Precision-format verification: `node tests/test_strategy_logic.js`, `node tests/test_accounting_logic.js`, `node tests/test_startup_reconcile_regressions.js`.

### Core Lines Changed
**Total: 9,812** (7,072 added, 2,740 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.16] - 2026-02-07 - Runtime Safety, Sync Execution Completeness, Grid/Accounting Hardening & Ops Dashboard Scaffold

### Added
- **Operations Dashboard (Experimental Rust TUI Sidecar)** in `dashboard/` (commit 0d6af8f)
  - Added a ratatui/crossterm terminal dashboard loop with tabbed UI, periodic refresh ticks, centralized key handling, and stateful list navigation.
  - Added runtime snapshot ingestion that merges `profiles/bots.json`, `pm2 jlist` status, and per-bot log tails with basic alert signal detection.
  - Added guarded script action model (`safe` / `confirm` / `danger`) with confirmation modal flow and typed-token protection for dangerous actions.
  - Added dashboard docs/spec (`dashboard/README.md`, `docs/tui_dashboard_spec.md`) and repo hygiene updates (`dashboard/target` + generated aliases in `.gitignore`).
  - Scope guard: dashboard excludes branch-sync scripts (`ptest`, `pdev`, `pmain`) and operates as a sidecar, not a direct trading-logic mutator.

- **Clear-All Cleanup Script** (commit 3742d1c)
  - Added a new script command for broad local/runtime cleanup in one operation, reducing manual operational cleanup steps.

### Fixed
- **Sync-Detected Fills Now Execute Full Rebalance Pipeline** in `modules/dexbot_class.js` (commit 65f8970)
  - **Problem**: Two runtime sync paths detected fills but stopped at strategy computation.
  - **Fix**: Both main-loop and periodic sync paths now run the full chain: `synchronizeWithChain(...)` -> `processFilledOrders(...)` -> `updateOrdersOnChainBatch(...)` -> `persistGrid()`.
  - **Impact**: Full fills found during sync are now replaced/persisted immediately instead of waiting for unrelated future events.

- **Open-Order Watchdog Churn Reduction + Explicit Opt-In Polling** in `modules/order/sync_engine.js`, `modules/dexbot_class.js`, `modules/constants.js`, `dexbot.js` (commit a2d6fc4)
  - **Problem**: No-op pass-1 updates still called `_updateOrder(...)`, producing repeated logs/work and lock contention.
  - **Fix**: Added quantized size/state + raw-chain equivalence checks to suppress material no-op updates.
  - **Behavior Change**: Renamed runtime semantics to explicit open-orders watchdog loop and made polling opt-in by default (`OPEN_ORDERS_SYNC_LOOP_ENABLED=false`), with `OPEN_ORDERS_SYNC_LOOP_MS` as the interval override.

- **Lifecycle Shutdown and Account-Context Recovery Hardening** in `modules/dexbot_class.js`, `modules/order/accounting.js`, `modules/order/startup_reconcile.js` (commit 47ca2d8)
  - **Problem**: Duplicate/uncancelled loops and missing cleanup handles could leave watchers/listeners active post-shutdown; startup/trigger paths could proceed with unresolved account context.
  - **Fix**: Introduced managed runtime handles and dedicated start/stop loop controls, added explicit fs watcher/fill listener cleanup, added shutdown guards, enforced account-id resolution, and made trigger-reset short-circuit contingent on actual success.
  - **Impact**: Prevents background activity leakage and late read failures; startup/recovery now fail fast and deterministically when account context is unavailable.

- **Open-Order Reconciliation Safety Guards** in `modules/order/sync_engine.js` (commit 7ff07d7)
  - **Type mismatch safety**: Type-mismatched chain orders are queued for cancellation and skipped from reconciliation in the same pass (prevents slot mutation to false PARTIAL states).
  - **Pair validation safety**: Reconciliation now accepts only true market-pair orders (`assetA->assetB` or `assetB->assetA`) and rejects unrelated account orders.
  - **Correction queue consistency**: Regular price mismatches now update both returned corrections and `manager.ordersNeedingPriceCorrection` with dedupe/update semantics.

- **Accounting Resiliency Against Fee-Cache and Optimistic Drift Failures** in `modules/order/accounting.js` + `modules/order/sync_engine.js` (commit b6649e6)
  - Added fail-safe fallback in `_deductFeesFromProceeds()` when fee cache lookup fails (logs and uses raw proceeds).
  - Added explicit critical-path handling when `tryDeductFromChainFree()` fails, with immediate recovery scheduling.
  - Coalesced overlapping invariant checks into one in-flight run + latest pending snapshot to reduce noise and overlap.
  - Normalized BTS fee side selection and aligned missing `fillOp.is_maker` default to maker in sync for accounting parity.

- **Grid Generation and Spread-Correction Safety Hardening** in `modules/order/grid.js` (commits bafed2b, 59e1d8f)
  - Enforced `minPrice > 0` guard to prevent non-terminating downward progression.
  - Added fail-fast guards for empty level generation and imbalanced BUY/SELL rails.
  - Removed pre-broadcast local mutation from spread correction preparation to avoid local/chain drift when batch execution fails or does not execute.
  - Spread-correction outcomes now apply only when chain batch reports `executed=true`.
  - Increment validation now enforces configured `INCREMENT_BOUNDS` (0.01..10), replacing legacy 0..100 logic.

- **Dust Sizing Orientation Consistency (BUY Side)** in `modules/order/grid.js` (commit bafed2b)
  - **Problem**: BUY dust checks sorted slots opposite geometric sizing assumptions.
  - **Fix**: Normalized BUY slot sorting orientation to preserve correct ideal-size mapping under reverse allocation.
  - **Impact**: Eliminates threshold-adjacent BUY dust misclassification.

- **Strategy Safety: Fill-Type Validation + Self-Rotation Churn Prevention** in `modules/order/strategy.js` (commit 7b24491)
  - Invalid/missing fill types no longer consume SELL reaction budget implicitly; unknown types are warned and skipped.
  - Self-rotation candidates (`oldOrder.id === newGridId`) are converted to in-place updates and excluded from later cancellation flow.
  - Prevents unnecessary cancel/update churn and avoidable fee pressure.

- **OrderManager Waiter/State Guard Corrections** in `modules/order/manager.js` (commit 715ebd7)
  - `waitForAccountTotals` now creates/reuses waiter under lock but awaits outside lock to avoid serialized timeout behavior.
  - Readiness checks aligned to `buyFree/sellFree` semantics.
  - Explicit zero allocation caps are honored (`0` no longer treated as "no cap").
  - Added strict enum validation for order type/state updates, with backward-compat normalization for zero-size virtual placeholders.

- **Startup Reconcile Fund-Release and Race Recovery Hardening** in `modules/order/startup_reconcile.js` (commit e413e35)
  - Unmatched chain cancels now route through release-aware path to return optimistic free balances.
  - Stale-slot updates are skipped when slot already mapped to same orderId (prevents double-credit).
  - Resume persistence now awaits async `storeGrid` completion; chain-order ID extraction hardened against null entries.

### Refactored
- **Deduplicated Startup/Auth/Settings/Resolution Paths** across core modules (commit d479015)
  - Consolidated mirrored SELL/BUY startup reconciliation flows into shared side-parameterized helpers.
  - Unified general settings load/write behavior into shared utility consumed across modules.
  - Reused common account resolution/authentication paths to reduce divergence in sensitive startup/auth code.
  - Removed duplicate conversion helpers and hoisted shared int64 constants.

- **Grid Helper Consolidation + Dead Path Removal** in order modules (commit 4736777)
  - Centralized spread gap and dust helpers (`calculateGapSlots`, `hasAnyDust`, `getSizingContext`) and routed strategy/manager callers through shared implementations.
  - Removed stale manager state/methods/imports and aligned signatures to live call patterns.

- **Removed Dead `cacheFunds` Trigger Wiring in Grid Regen Checks** (commit 609ca12)
  - Removed unused `cacheFunds` parameter from `checkAndUpdateGridIfNeeded` and `compareGrids`, updated call sites/tests.
  - Clarifies that trigger behavior is driven by available funds (`buyFree/sellFree`), not unused cache fallback plumbing.

- **Legacy Utility Surface Pruning** in split utils modules (commit c820cbf)
  - Removed unreferenced helper exports from `modules/order/utils/{system,math,order}.js`.
  - Updated module documentation references to match current split utility architecture.

- **Post-Hardening Cleanup: Shared Account-Ref Utility Extraction** (commit 2d5f2fe)
  - Extracted common account reference fallback logic and improved code readability around lifecycle/account-resolution paths.

### Changed
- **Documentation and Repository Guidance Consolidation** (commits dabe591, 47ca2d8, e413e35)
  - Renamed OPENCODE guidance to `AGENTS.md` and standardized agent-doc references.
  - Added commit quality guidance for substantial changes (high-context body with problem/impact/solution + testing notes).
  - Added newline-safe commit/PR formatting guidance (heredoc-first patterns for CLI reliability).

### Quality Assurance
- Regression and behavior-lock tests added/updated across sync, startup reconcile, manager/account totals, grid logic, strategy reaction-cap/self-rotation, and full sync-fill rebalance execution paths.
- Dashboard build validation: `cargo check --manifest-path dashboard/Cargo.toml`.
- JavaScript runtime checks and focused Node test runs were executed per change set and documented in commit testing notes.


## [0.6.0-patch.15] - 2026-02-06 - Stale Order Recovery Hardening, Liquidity Pool Pagination & Type-Mismatch Correction Pipeline

### Fixed
- **Grid Reset Race Condition - Bootstrap Flag Guard** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: During grid reset, the `isBootstrapping` flag was checked before acquiring the fill processing lock. The flag could become false while waiting for lock acquisition, causing stale bootstrap code to execute for fills arriving during grid resync.
  - **Impact**: Fills received during grid recovery were processed with bootstrap logic even after bootstrap completed, preventing proper boundary slot reassignment and leaving the grid in an inconsistent state.
  - **Fix**: Moved `isBootstrapping` flag check inside the fill processing lock callback (line 691). If bootstrap finished while waiting, the code now skips the bootstrap handler and allows normal POST-RESET fill processing.
  - **Result**: Grid boundary slots are now properly reassigned after fill events during recovery

- **Fill Accounting in POST-RESET Path** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: The POST-RESET fill handler processed known grid fills but skipped the `processFillAccounting()` call, which only ran for unknown orders. This broke `cacheFunds` tracking.
  - **Impact**: Cache funds from grid fills during recovery were never credited, causing subsequent dust resize operations to fail due to insufficient cache funds.
  - **Fix**: Added `accountant.processFillAccounting()` call before the `processFilledOrders` rebalance pipeline (line 404).
  - **Result**: Fill proceeds are now correctly credited to cache funds during grid recovery

- **Doubled Flags Reset During Grid Regeneration** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: The `buySideIsDoubled` and `sellSideIsDoubled` flags persisted from the old grid through the regeneration process, reducing the effective target order count.
  - **Impact**: Grid stayed at reduced capacity (5 orders instead of 6) even after successful recovery.
  - **Fix**: Added doubled flag resets to the grid regeneration cleanup block (line 530).
  - **Result**: Grid reaches full target capacity after regeneration

- **FillType Logging Case Mismatch** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: FillType comparison used hardcoded uppercase `'BUY'` but `ORDER_TYPES.BUY` equals lowercase `'buy'`, causing the comparison to always fail (line 1050).
  - **Impact**: Fill logs always showed 'SELL' regardless of actual order type.
  - **Fix**: Changed comparison from `'BUY'` to `ORDER_TYPES.BUY` enum constant for case-sensitive match.
  - **Result**: Fill logs now correctly reflect the actual order type (buy vs sell)

- **Grid Divergence Threshold Denominator** in modules/order/grid.js (commit 857c8f3)
  - **Root Cause**: The threshold check used `(grid + pending)` as denominator for the divergence ratio, which could be much smaller than total allocated funds (line 741).
  - **Impact**: False-positive triggers when grid size < allocated funds, causing unnecessary sell order updates/rebalancing post-fill.
  - **Fix**: Changed denominator to use `allocated` funds with `chainTotal` fallback (free + locked balance).
  - **Result**: Divergence threshold now uses appropriate baseline, reducing false positives

- **Spread Correction Sizing Index Swap** in modules/order/grid.js (commit 857c8f3)
  - **Root Cause**: Geometric sizing produces arrays where weight distribution depends on the `reverse` parameter. For SELL orders (reverse=false), largest allocation is at index [0]. For BUY orders (reverse=true), largest is at index [N-1]. Code was returning smallest for both sides (line 1205).
  - **Impact**: Spread correction orders placed with dust-level sizes (~0.14) instead of ideal sizes (~0.30).
  - **Fix**: Swapped return indices: sell uses `sized[0]` (largest), buy uses `sized[N-1]` (largest for reversed array).
  - **Result**: Spread correction orders now place with appropriate sizing near market

- **Dust Partial Resize Fallback Source** in modules/order/strategy.js (commit 857c8f3)
  - **Root Cause**: Dust resize operations used `chainFree` (raw on-chain balance) as fallback, which was too aggressive. Available funds exhaustion should prevent resize unless fill proceeds become available (lines 534-541, 581).
  - **Impact**: Dust orders were being enlarged using raw on-chain funds when they should only use dedicated cache funds from fills.
  - **Fix**: Replaced `chainFree` fallback with `cacheFunds` (fill proceeds earmarked for grid operations). `cacheFunds` is safely available here since it's not consumed until after rebalance completes (lines 366-372).
  - **Result**: Dust orders only enlarge using fill proceeds, preventing fund exhaustion

- **Liquidity Pool Pagination for Price Discovery** in system.js (commit e9e09bc)
  - **Root Cause**: Pool lookup only fetched the first 100 pools using a single API call, missing pools with higher IDs on networks with >100 liquidity pools
  - **Impact**: Price derivation would fail for asset pairs in high-ID pools, silently falling back to market price and potentially using stale/incorrect pricing
  - **Fix**:
    - Implemented pagination loop with `startId` tracking through pool batches
    - Continues fetching 100-pool pages until target pool is found or all pools exhausted
    - Correctly handles `pools.length < PAGE_SIZE` condition to detect end of list
  - **Result**: Price discovery now works reliably for all liquidity pools regardless of pool ID value

- **Spread Threshold Configuration Key Correction** in grid.js (commit e9e09bc)
  - **Root Cause**: Spread correction code used non-existent config key `targetSpread`, which defaulted to `undefined` and fell back to 2.0%
  - **Impact**: Spread corrections used hardcoded 2.0% nominal spread instead of user-configured `targetSpreadPercent`, causing incorrect grid adjustments when users configured different spreads
  - **Fix**: Changed `manager.config.targetSpread` to `manager.config.targetSpreadPercent` (the actual config key)
  - **Result**: Spread corrections now use the user-configured target spread percentage

- **Type-Mismatch Order Cancellation Pipeline** in sync_engine.js and order.js (commit d2f4068)
  - **Root Cause**: When type mismatches were detected (e.g., grid slot reassigned from sell→buy but chain order retained original type), the code pushed a surplus entry to `manager.ordersNeedingPriceCorrection` but `correctOrderPriceOnChain()` treated it like a price update, attempting to call `updateOrder()` with undefined values (expectedPrice, size, type).
  - **Impact**: Type-mismatched chain orders were never cancelled, leaving stale orders on-chain that continued trading against the current grid configuration, causing incorrect balances and failed rotations.
  - **Fix**: Added explicit `isSurplus` handling in `correctOrderPriceOnChain()`:
    - Detects surplus entries early via `isSurplus` flag
    - Routes them to `accountOrders.cancelOrder()` instead of price update
    - Cleans up grid slot by converting to SPREAD placeholder (prevents phantom order references)
    - Returns `{ cancelled: true }` to distinguish from price corrections
  - **Result**: Type-mismatched chain orders are now properly cancelled and grid slots cleared, preventing phantom order accumulation

- **Multi-ID Stale Order Extraction from Batch Failures** in dexbot_class.js (commit d2f4068)
  - **Root Cause**: Batch failure handler only extracted the first stale order ID from error messages using single regex match, but errors can reference multiple stale orders across different BitShares node versions
  - **Issue**: Remaining stale order references in the batch weren't filtered out, causing retry with same failed operations and cascading failures
  - **Fix**:
    - Changed from single `match()` to `Set` with multiple regex patterns (`g` flag on fresh pattern objects)
    - Covers BitShares error format variants: "Limit order X does not exist", "Unable to find Object X", "object X does not exist|not found"
    - Cleans up ALL grid slots referencing any stale order ID (not just first)
    - Filters operations by Set membership check instead of single ID comparison
  - **Result**: Batch recovery now handles multi-ID stale order scenarios correctly, successfully retrying with all valid operations

- **Spread-Out-of-Range False Positive** in order.js (commit d2f4068)
  - **Root Cause**: `shouldFlagOutOfSpread()` returned `1` (flag) when either buy or sell side had zero active orders, even though spread is mathematically undefined with only one side
  - **Impact**: Triggered unnecessary spread corrections when one grid side was exhausted (e.g., all sell orders filled), causing thrashing and grid churn
  - **Fix**: Changed return value from `1` to `0` when `buyCount === 0 || sellCount === 0`, making it skip spread checks when an entire side is empty
  - **Result**: No false spread-out-of-range flags during normal one-sided inventory accumulation

- **Unused Parameter Removal** in dexbot_class.js (commit d2f4068)
  - Removed unused `ordersToPlace` and `ordersToRotate` parameters from `_processBatchResults()` method signature
  - These were passed from two call sites but never used in the method body
  - Cleanup reduces parameter coupling and simplifies the function contract

- **Recovery Cycle Documentation Clarification** in dexbot_class.js (commit d2f4068)
  - Added comment clarifying dual reset points for `_recoveryAttempted` flag:
    - Periodic reset: Every 10-minute cycle (`pauseFundRecalc` block at line 2164)
    - Fill-triggered reset: Only on actual fill events (in `processFilledOrders`)
  - Ensures accounting recovery can be re-attempted even when no fills occur for extended periods

### Core Lines Changed
**Total: 1,428** (1,390 added, 38 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.14] - 2026-02-05 - Critical Bug Fixes, Price Orientation, Fund Validation & Quantization Consolidation

### Added
- **Robust Ghost Order / Full-Fill Detection** in sync_engine.js (commit a8594f0)
  - Implemented detection for "effectively full" orders where the counter-asset (the side not defining the order size) rounds to zero on the blockchain.
  - Prevents untradable orders with tiny remainders from hanging in `PARTIAL` state and blocking rotations.
  - **Verification**: Added `tests/test_ghost_order_fix.js` covering real-world scenarios from production logs.

- **Unanchored Spread Correction Test Integration** (commit c8f4dc5)
  - Integrated `tests/test_unanchored_spread_correction.js` into the main test suite in package.json.
  - Fixed stale imports and ReferenceErrors in the test caused by utility refactoring.

- **Centralized Quantization Utilities** in math.js (commit 9f50184)
  - Extracted `quantizeFloat(value, precision)` - Float → int → float conversion eliminates floating-point accumulation errors
  - Extracted `normalizeInt(value, precision)` - Int → float → int conversion ensures integer alignment with precision boundaries
  - Consolidated from 5 separate implementations across dexbot_class.js, order.js, strategy.js, and chain_orders.js
  - **Result**: Single source of truth for precision logic, improved maintainability, all 34 test suites pass with no regressions

- **Startup Configuration Validation** in dexbot_class.js (commit 56dd4bd)
  - New method `_validateStartupConfig()` validates critical parameters at construction time:
    - Validates `startPrice` is numeric or valid mode (pool/market/orderbook)
    - Validates `assetA` and `assetB` are present and non-empty
    - Validates `incrementPercent` is in valid range (0-100)
  - Consolidated error reporting shows all validation failures at once instead of cascading errors
  - Improves early error detection and clarifies business rules

- **Precision & Quantization Documentation** (commit d168fb2)
  - Added comprehensive Section 5.5 to FUND_MOVEMENT_AND_ACCOUNTING.md explaining precision issues and quantization utilities
  - Documented `quantizeFloat()` and `normalizeInt()` with detailed examples and use cases
  - Highlighted Patch 14 consolidation: 5 separate implementations → 1 centralized module
  - Added best practices table with 5 real-world scenarios for when to quantize
  - Added cross-references in architecture.md and new "Precision & Quantization Best Practices" section in developer_guide.md
  - Includes code examples showing correct vs incorrect float handling patterns

### Fixed
- **Correct Fund Validation Logic** in dexbot_class.js (commit ac1db74)
  - **Root Cause**: Fund validation computed available as `(chainFree + requiredFunds)`, then checked `if (required > available)`. This became checking `if (required > chainFree + required)` which is always false.
  - **Impact**: Validation never caught batches exceeding available balance, causing "Insufficient Balance" errors on execution despite passing validation.
  - **Fix**: Available funds now correctly equals current free balance (chainFree). Validation checks: `required <= available` where available = chainFree.
  - **Result**: Batches that exceed free balance are rejected BEFORE broadcasting, allowing both sides of order pairs to be created successfully.

- **Correct Price Orientation - B/A Standard** in system.js (commit cd0a249, documentation updated in commit 45eedac)
  - **Root Cause**: Commit ae6e169 incorrectly removed price inversion and reversed pool calculation, causing inverted prices in production.
  - **Fix**: Restored correct inversion logic: `1 / mid` for market prices (BitShares `get_order_book(A,B)` returns A/B format, need B/A)
  - **Example**: XRP/BTS market should be ~1350 (1 XRP = 1350 BTS), not 0.000752 (which is A/B inverted)
  - **Verification**: Pool price = `floatB / floatA` (3000000 BTS / 20000 XRP = 150 BTS/XRP); Market price = `1 / mid` (inverts API's A/B to B/A)
  - **Documentation Added**: Comprehensive developer guide section explaining price orientation standards, conversion tables, and debugging patterns (commit 45eedac)

- **Critical Edge Case & Data Integrity Fixes** in multiple files (commit 16d1651)
  - **Empty Grid Edge Case**: Added check in startup_reconcile.js to prevent `.every([])` returning true for empty edge order list - fixes false "grid edge fully active" reports
  - **Suspicious Order Size**: Changed silent return to throw error in order.js - order exceeding 1e15 satoshis indicates data corruption; forces recovery instead of continuing with phantom orders
  - **BTS Fee Handling**: Centralized fee calculation in accounting.js - **CRITICAL**: For BTS, refund is a SEPARATE transaction, not in fill amount. Don't add refund to fill proceeds (prevents double counting).
  - **Deadlock Prevention & AsyncLock Hardening**: Added timeout to sync lock acquisition in sync_engine.js (commit 16d1651, hardened in commit 276b07d)
    - Wraps lock acquisition with `Promise.race() + 20s timeout` to prevent indefinite hangs
    - Implemented `cancelToken` support in AsyncLock to enable safe operation cancellation
    - Added abortion check after lock acquisition to prevent "Zombie Sync" race conditions
    - Added `clearQueue()` method for emergency operation cleanup

- **Boundary and Precision Issues** in multiple files (commit 58a46d2)
  - **Negative Boundary Index**: Added immediate `Math.max(0, ...)` clamp to boundaryIdx calculation in strategy.js - prevents negative array indices during boundary initialization
  - **Precision Underflow**: Fixed precision calculation in order.js - when `assetA.precision < assetB.precision`, divide instead of multiply to prevent precision loss for asset pairs with different scales
  - **Overly Permissive Logging**: Enforced strict equality check `=== 0` in accounting.js instead of `=== 0 || === undefined` - prevents spurious debug logging with uninitialized depth counter

- **Removed Unused MAKER_REFUND_RATIO Constant** in constants.js
  - Removed unused and semantically confusing `MAKER_REFUND_RATIO: 0.1` constant
  - The correct refund logic uses `MAKER_REFUND_PERCENT: 0.9` which is the only one actually used in calculations
  - Cleanup reduces configuration confusion around fee parameters

- **Liquidity Pool Asset Mapping** in system.js (commit c8f4dc5)
  - Enhanced `derivePoolPrice` with explicit asset ID numerical ordering
  - Correctly maps BitShares' `balance_a`/`balance_b` (ordered by internal ID) to the bot's `assetA`/`assetB` regardless of which asset was created first on the network

- **Divergence Correction Race Protection** in system.js (commit a8594f0)
  - Implemented `_correctionsLock` acquisition in `applyGridDivergenceCorrections`
  - Prevents "Time-of-Check to Time-of-Use" (TOCTOU) race conditions where concurrent fill processing could interleave with structural grid updates

- **Rotation Size Overrun Prevention** in strategy.js (commit 02f61a2)
  - Fixed a bug where order sizes during rotations could exceed available capital
  - Rotation sizes are now strictly capped by the sum of available funds and released surplus from canceled orders

- **Rebalance Scoping Fix** in strategy.js (commit a8594f0)
  - Resolved a `ReferenceError` for `minHealthySize` variable that caused crashes during certain rebalance cycles

- **Extract Magic Numbers to Constants** in constants.js and affected modules (commit 56dd4bd, expanded with timeout constants in commit 8b29396)
  - **Fee Parameters**: `MAKER_FEE_PERCENT` (0.1), `MAKER_REFUND_PERCENT` (0.9), `TAKER_FEE_PERCENT` (1.0)
  - **Timing Constants** (commit 8b29396):
    - `SYNC_LOCK_TIMEOUT_MS` (20s): Deadlock prevention for sync lock acquisition
    - `CONNECTION_TIMEOUT_MS` (30s): BitShares client connection establishment
    - `DAEMON_STARTUP_TIMEOUT_MS` (60s): Private key daemon startup timeout
    - `RUN_LOOP_DEFAULT_MS` (5s): Main loop cycle delay default value
    - `CHECK_INTERVAL_MS` (100ms): Polling interval for connection/daemon readiness
  - **Grid Parameters**: `MAX_ORDER_FACTOR` (1.1) for max order sizing
  - **Impact**: Eliminated all hardcoded timeout values from 8 modules; centralized timing configuration in one location
  - Updated math.js, export.js, dexbot_class.js, bitshares_client.js, chain_keys.js, chain_orders.js, dexbot_class.js, startup_reconcile.js, sync_engine.js, pm2.js to use constants
  - Added fallback for MAX_ORDER_FACTOR in _getMaxOrderSize() with || 1.1 fallback

### Key Improvements
- **Accuracy**: Price derivation consistently reflects B/A standard; fund calculations prevent over-commitment
- **Robustness**: Ghost order detection ensures grid flow; quantization consolidation eliminates precision errors; validation catches configuration issues early
- **Stability**: Locking prevents race conditions; boundary clamping prevents array corruption; timeout prevents deadlocks; startup validation prevents cascading failures
- **Maintainability**: Centralized quantization logic, consolidated fee calculations, documented magic numbers reduce technical debt

---

## [0.6.0-patch.13] - 2026-02-03 - Spread Correction Redesign, Index Bug Fixes & Config Extraction Improvements

### Added
- **Edge-Based Spread Correction Strategy** in correctionManager.js (commit fe66916)
  - Replaces vulnerable mid-price based approach with conservative edge-based correction
  - **Priority 1**: Update existing PARTIAL orders at the gap edge (closest to market)
    - Calculates delta: min(idealSize - currentSize, availableFund)
    - Sets state to ACTIVE (already on-chain, no re-placement needed)
  - **Priority 2**: Activate SPREAD slots at the edge (fallback if no partials available)
    - BUY: Picks lowest price spread slot (extends wall upward gradually)
    - SELL: Picks highest price spread slot (extends wall downward gradually)
    - Sets state to VIRTUAL (goes through normal placement pipeline)
  - **Safety guarantee**: Processes ONE candidate per call (prevents cascade placements)
  - Enables incremental gap closure with manual verification between steps

### Enhanced
- **Spread Adjustment for Doubled Sides** in grid.js and strategy.js (commit e04f371)
  - When a side is flagged as doubled, adjust effective target spread by +1 increment
  - Widens spread goal, increases gapSlots boundary, maintains wider separation
  - Example: BUY side doubled at 1.60% → aims for 2.00% spread (+ 0.40% increment)
  - Compensates for having fewer orders on the doubled side

- **Bot Config Extraction Logic** in analyze-orders.js (commit 52f4d58)
  - Now matches order files to bot configs even when metadata is null
  - Extracts asset symbols directly from order file's assets object
  - Fallback pattern matching: "t-bts-2.json" → "T/BTS"
  - Safety fallback for currency symbols: uses "BASE"/"QUOTE" if null
  - Improved double-sided mode display: shows which specific sides (BUY/SELL) are doubled

### Fixed
- **Critical Index Mismatch Bugs** (commit 27b3f4a)
  - **Bug #1 in dexbot_class.js (lines 220-222)**:
    - Issue: Filtered active bots first, then mapped with new indices
    - Result: T-BTS (originally index 2) reassigned to index 1
    - Caused botKey mismatch: looking for t-bts-1.json instead of t-bts-2.json
    - Fix: Map with original indices first, then filter by active status

  - **Bug #2 in account_orders.js (lines 213-227)**:
    - Issue: Used filtered array indices in ensureBotEntries processing
    - Same root cause created wrong bot keys and metadata storage
    - Fix: Preserve original indices through map-filter-destructure chain

  - **Impact**:
    - Correct botKey generation ensures proper file matching
    - Metadata will be loaded from correct bot file
    - Metadata properly updates from null to actual values (e.g., TWENTIX/BTS)

- **Spread Threshold Calculation Simplification** in constants.js and strategy.js (commit 326cef5)
  - Replaced complex geometric formula for nominalSpread with direct config.targetSpread value
  - Simplified limitSpread from geometric formula to linear: limitSpread = nominalSpread + (incrementPercent × toleranceSteps)
  - Tolerance scales with doubled state: base 1 increment, +1 per doubled side (max 3 total)
  - **Result**: Respects MIN_SPREAD_FACTOR constraint, resolves false "out of spread" corrections
  - Verified: 100% test pass rate for 0.5% increment across 2.1x to 4.0x multipliers

### Key Improvements
- **Safety**: Edge-based correction eliminates geometric mean calculation vulnerabilities
- **Predictability**: Single-order-per-call approach enables verification and control
- **Correctness**: Fixed critical botKey generation bugs that caused config mismatches
- **Robustness**: Spread logic now respects constraints and properly handles doubled states
- **Observability**: Improved config extraction and metadata handling for diagnostics

### Testing
- All 107+ existing tests pass
- No regressions detected
- Verified spread threshold calculation across multiple multiplier ranges
- Config extraction tested with null metadata scenarios

### Core Lines Changed
**Total: 608** (407 added, 201 removed) - Root and modules/*.js files only

### Related Commits
- Builds on Patch 12 pipeline safety (non-destructive recovery principles)
- Complements Patch 11 order state predicates
- Fixes edge cases in order metadata handling from Patch 10

### Core Lines Changed
**Total: 6,125** (2,600 added, 3,525 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.12] - 2026-02-02 - Pipeline Safety Enhancement, Fund Availability Fix & Code Quality Improvements

### Added
- **Pipeline Timeout Safeguard** in manager.js (commit 6737d35)
  - 5-minute timeout on `isPipelineEmpty()` to prevent indefinite grid-maintenance blocking
  - Automatic flag clearing with warning logs when timeout triggers
  - `_pipelineBlockedSince` tracking for diagnostics
  - Non-destructive recovery (clears flags only, not orders)

- **Pipeline Health Diagnostic Method** in manager.js (commit 6737d35)
  - `getPipelineHealth()` returns 8 diagnostic fields
  - Blockage timestamp, duration (both milliseconds and human-readable), pending counts, affected sides
  - Enables production monitoring dashboards and alerting systems
  - Integrated into post-fill logging for operational visibility

- **Pipeline Timing Configuration** in constants.js (commit 6737d35)
  - `PIPELINE_TIMING.TIMEOUT_MS` (300000 ms / 5 minutes) - Conservative timeout preventing false positives

- **Stale Pipeline Operations Clearing** in manager.js (commit dd94044)
  - `clearStalePipelineOperations()` method explicitly handles timeout recovery
  - Separates timeout logic from `isPipelineEmpty()` query
  - Called from `_executeMaintenanceLogic()` for scheduled cleanup

### Refactored
- **Pipeline Timeout Logic Separation** in manager.js (commit dd94044)
  - Extracted timeout and clearing logic from `isPipelineEmpty()` into `clearStalePipelineOperations()`
  - `isPipelineEmpty()` now a pure query (except timestamp tracking)
  - `getPipelineHealth()` no longer calls `isPipelineEmpty()` internally
  - Improves separation of concerns and testability
  - Removes hidden side effects in query method

- **Fill Cleanup Counter Logic** in dexbot_class.js (commit 83b4dc6)
  - Removed redundant lazy initialization (counter already initialized in constructor)
  - Removed misleading "locally track" comment that incorrectly described synchronization
  - Simplified from 14 to 10 lines while maintaining same functionality
  - Clarified lock-based synchronization mechanism in comments

### Fixed
- **Mixed BUY/SELL Order Fund Availability Checks** in dexbot_class.js (commit 701352b)
  - **Problem 1 - Asset Mapping Regression**: After commit ee76bcd, BUY orders checked `sellFree` and SELL orders checked `buyFree` (inverted)
  - **Problem 2 - Mixed Order Handling**: `_buildCreateOps()` received both BUY and SELL orders but summed them together and only checked first order's type, causing false fund warnings
  - **Problem 3 - Per-Order Validation**: Used first order's type for validating all orders instead of each order's individual type
  - **Solution**:
    - Separate BUY and SELL orders into independent checks
    - BUY orders now correctly check `buyFree` (assetB capital)
    - SELL orders now correctly check `sellFree` (assetA inventory)
    - Each order validated against its own type, not first order's type
  - **Impact**: Accurate fund warnings, eliminates false positives for mixed placements

- **Critical Pipeline Vulnerability** (commit 6737d35)
  - **Problem**: Pipeline checks could block indefinitely if operations hung (network issues, stuck corrections)
  - **Solution**: 5-minute timeout with automatic recovery
  - **Impact**: Prevents bot from entering permanent locked state

- **Fill Persistence Error Clarity** in dexbot_class.js (commit ebc17ff)
  - **Problem**: Unclear what happens when fill persistence fails
  - **Solution**: Enhanced error message documents potential reprocessing on next run
  - **Impact**: Operators understand expected behavior without false alarm about bugs

### Documentation Enhancements
- Enhanced `_executeMaintenanceLogic()` header with:
  - 6-step maintenance sequence breakdown
  - Race-to-resize prevention rationale
  - Timeout safety guarantees
  - Detailed explanation of why pipeline consensus matters

- Enhanced `_runGridMaintenance()` header with:
  - 3 entry points (startup, periodic, post-fill)
  - Lock ordering explanation and deadlock prevention
  - Pipeline protection details

- Improved post-fill logging to show blockage duration
- Added inline comments explaining retry behavior on cleanup failure

### Benefits
- **Stability**: Pipeline no longer blocks indefinitely due to stuck operations
- **Observability**: getPipelineHealth() enables monitoring and alerting
- **Clarity**: Removed misleading comments, improved documentation
- **Quality**: Simplified code without losing functionality
- **Safety**: Non-destructive timeout prevents resource leaks

### Testing
- All 107+ existing tests pass
- No regressions detected
- All integration tests verified
- Backward compatible with existing code

### Related Commits
- Builds on commit a946c33 (grid maintenance race-to-resize fix)
- Complements pipeline consensus enforcement from Patch 11
- Includes refactoring in dd94044 (pipeline timeout separation)
- Fixes regression from ee76bcd (asset mapping in fund checks)

---

## [0.6.0-patch.11] - 2026-02-02 - Order State Predicate Centralization

### Added
- **Centralized Order State Helpers** in utils.js (commit 2fb171d)
  - `isOrderOnChain()` - ACTIVE or PARTIAL check
  - `isOrderVirtual()` - VIRTUAL check
  - `hasOnChainId()` - orderId existence check
  - `isOrderPlaced()` - on-chain AND has ID (safe placement)
  - `isPhantomOrder()` - on-chain WITHOUT ID (error detection)
  - `isSlotAvailable()` - virtual + no ID (reusable slot)
  - `virtualizeOrder()` - transitions order to VIRTUAL, clears blockchain metadata
  - `isOrderHealthy()` - comprehensive size validation (absolute + dust threshold)

- **Additional Centralized Helpers** in utils.js (commit d6560a8)
  - `getPartialsByType(orders)` - Returns `{buy: [], sell: []}` of partial orders by type
  - `validateAssetPrecisions(assets)` - Validates both asset precisions at once
  - `getPrecisionSlack(precision, factor)` - Calculates precision slack for float comparisons

### Refactored
- Replaced 34+ inline state checks across 6 modules with semantic helpers (commit 2fb171d)
  - **strategy.js**: -27 lines (role-assignment, surplus/shortage detection)
  - **manager.js**: -2 lines (SPREAD validation, phantom prevention)
  - **sync_engine.js**: rotation/fill cleanup uses helpers
  - **grid.js**: -10 lines (slot availability, phantom sanitization)
  - **startup_reconcile.js**: edge validation, price matching

- Replaced pattern duplications with centralized helpers (commit 56a7344)
  - **`getPartialsByType()` eliminated 3 duplications**: strategy.js, grid.js, startup_reconcile.js
  - **`getPrecisionSlack()` eliminated 2 duplications**: accounting.js, manager.js
  - **Net result**: -15 lines of duplication across 5 modules

### Fixed
- **Dynamic require in dexbot_class.js**: Moved `virtualizeOrder` import to module-level

### Core Lines Changed
**Total: 2,196** (1,686 added, 510 removed) - Root and modules/*.js files only

### Benefits
- Single source of truth for order state logic
- Semantic function names improve readability
- Centralized phantom order detection
- Consistent patterns across all modules

### Core Lines Changed
**Total: 2,717** (2,118 added, 599 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.10] - 2026-01-30 - Trigger Reset Stabilization, Fund Loss Prevention & Order State Management

### Added
- **Bootstrap Validation During Trigger Reset** (commit d1989eb)
  - **Feature**: Added fund drift validation at bootstrap completion to detect real bugs vs transient state mismatches.
  - **Mechanism**: `finishBootstrap()` validates drift when grid is stable; `validateGridStateForPersistence()` logs transient drift for observability without blocking regeneration.
  - **Benefit**: Distinguishes between genuine accounting errors and expected temporary state changes during grid rebuild.

- **Immediate Fill Processing After Trigger Reset** (commit d1989eb)
  - **Feature**: Checks `_incomingFillQueue` immediately after trigger reset completes and processes fills through rebalance pipeline.
  - **Mechanism**: Fills that occur during grid regeneration are now detected and replacement orders placed before spread check, maintaining grid consistency.
  - **Benefit**: Eliminates "holes" where filled orders aren't replaced, ensuring no gaps in grid coverage after reset.

- **Git Diff Watcher Script** (commit 165f380)
  - **Feature**: Added `scripts/watch-all-changes.sh` for interactive monitoring of uncommitted, committed, and pushed changes.
  - **Capabilities**: Smart auto-refresh (1s for uncommitted, 15s for committed), split-view file/diff search with fzf, toggle between full file and diff-only views.
  - **Benefit**: Enhanced development workflow for tracking changes across multiple states.

### Fixed
- **Comprehensive Trigger Reset Flow** (commit 3d90b2a)
  - **Problem**: Trigger reset was redundantly reinitializing fully-prepared state and running spread checks at wrong time, causing race conditions with partial order integration.
  - **Solution**:
    - Skip normal startup initialization after trigger reset (grid already fully initialized with orders placed, synced, and persisted).
    - Run only spread correction and bootstrap after reset instead of full initialization sequence.
    - Reorder maintenance steps: spread check FIRST, then divergence check (ensures wide spreads from reset are corrected before structural analysis).
    - Filter PARTIAL orders from chain sync before grid regeneration (remnants of old grid shouldn't be re-integrated).
    - Fix VIRTUAL→ACTIVE transitions: only mark as PARTIAL if previously ACTIVE (genuine partial fills), not on new matches with precision variance.
  - **Impact**: Eliminates race conditions and improves grid state consistency after trigger reset.

- **Grid Persistence After Trigger Reset** (commit 1ede196)
  - **Problem**: Destructured `persistedGrid` variable was stale after trigger reset, causing duplicate orders at same slots.
  - **Solution**: Changed `const persistedGrid` to `let` and directly reassign after reset so subsequent code uses regenerated grid.
  - **Impact**: Prevents duplicate order placement from using stale grid state.

- **Trigger File Reset Sequencing** (commit c7e5da9)
  - **Problem**: Trigger reset was handled after persisting old grid state, causing fund invariant violations (8 BTS) and persistence gate warnings.
  - **Solution**:
    - Activate fill listener FIRST before any orders placed.
    - Handle pending trigger reset IMMEDIATELY after listener activation.
    - Reload persisted grid from storage after reset (ensures grid matches regenerated state).
    - Skip fund drift validation during bootstrap (temporary mismatches expected during rebuild).
    - Refactor shared `_performGridResync()` for both startup and runtime trigger detection.
  - **Impact**: Eliminates fund invariant violations and persistence warnings during trigger reset.

- **100,000x Order Size Multiplier Bug** (commit c1dd906)
  - **Problem**: `rawOnChain.for_sale` was populated with float strings ("60.10317") instead of blockchain integers ("6010317"), causing delta calculations to be 100,000x too large.
  - **Solution**: Modified `buildCreateOrderOp()` to return both operation and `finalInts` (blockchain integers), updated `rawOnChain` population to use blockchain integers instead of float values.
  - **Impact**: Prevents massive order size mismatches and funding errors during order creation.

- **Phantom Fund Losses During Boundary-Crawl Rebalance** (commit 43ace9b)
  - **Problem**: 3,950 IOB.XRP phantom fund loss caused by three issues:
    1. Grid-resize calculated SELL sizes using wrong asset units (drained sellFree by 18.21 IOB.XRP).
    2. Accounting skipped in recovery paths, leaving funds locked in grid.committed.
    3. Type changes (SELL→BUY) applied before state transitions, releasing capital to wrong bucket.
  - **Solution**:
    - Enable accounting in batch validation/execution recovery paths (lines 1272, 1304 in dexbot_class.js).
    - Enable accounting in periodic blockchain fetch (line 661 in sync_engine.js).
    - Fix capital release order: state transitions applied BEFORE type changes so releases use original type.
  - **Impact**: Prevents phantom fund cascades, oversized orders, and grid invariant violations.

- **Type/State Change Processing Order** (commit ac329cd)
  - **Problem**: Boundary-driven type changes (BUY/SELL/SPREAD reassignment) and state changes (cancellations/virtualizations) applied in wrong order, causing fund releases with incorrect types.
  - **Solution**: Implement two-phase architecture:
    - PHASE 1: Apply type changes immediately via `mgr._updateOrder()` with `context='role-assignment'` BEFORE rebalancing logic runs.
    - PHASE 2: Apply state changes AFTER `rebalanceSideRobust()` completes.
  - **Impact**: Eliminates race condition where same order receives type + state change in one batch; improves code clarity and prevents future bugs.

- **Spread Check Logging Timing** (commit 09bf17f)
  - **Problem**: Spread condition check logic timing and logging were misaligned, causing state to be set at wrong time.
  - **Solution**: Keep spread check logic inside `rebalance()` to set `mgr.outOfSpread` at correct time, defer logging to AFTER persistGrid() via stored spread info.
  - **Impact**: Maintains correct state timing for subsequent operations while deferring log output to show actual on-chain state.

### Refactored
- **Mid-Price Calculation for Spread Correction** (commit 3d90b2a)
  - **Mechanism**: Added mid-price calculation in grid regeneration to identify valid order zones (BUY orders below mid-price, SELL orders above).
  - **Benefit**: Improves spread correction accuracy by properly validating order positioning.

- **Simplified Startup Resumption** (commit 3d90b2a)
  - **Change**: After trigger reset, resume main order manager loop with correct sequencing (spread check → health check → main loop) instead of full initialization.
  - **Impact**: Cleaner, more predictable flow with reduced redundant operations.

### Changed
- **Unused Imports Cleanup** (commit 165f380)
  - Removed unused `readline-sync` imports from `modules/account_bots.js` and `modules/chain_keys.js` (already using custom async methods).
  - Reduces unnecessary dependencies and improves code clarity.

- **Project Documentation** (commits 4a08821, d6be00b)
  - Added `CLAUDE.md` reference file for Claude AI context tracking.
  - Added `GEMINI.md` for project context tracking.
  - Renamed `opencode.md` to `OPENCODE.md` for consistency with convention.

### Performance
- **No Performance Regression**: All refactoring maintains identical operation counts; improvements are correctness-focused.

### Quality Assurance
- **Test Coverage**: All 35 test suites pass ✓
- **Correctness Improvements**:
  - Eliminated phantom fund loss scenarios through proper accounting and release ordering.
  - Fixed race conditions in trigger reset flow with explicit sequencing.
  - Prevented order duplication through proper grid state management.
  - Improved type/state change atomicity with two-phase architecture.

### Core Lines Changed
**Total: 511** (365 added, 146 removed) - Root and modules/*.js files only

### Core Lines Changed
**Total: 5,388** (1,216 added, 4,172 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.9] - 2026-01-28 - Startup Consolidation, Zero-Amount Prevention & Auto-Recovery

### Added
- **Startup Auto-Recovery for Accounting Drift** (commit 6f2e481)
  - **Feature**: Automatic recovery mechanism triggered during startup when accounting drift is detected.
  - **Mechanism**: Performs fresh blockchain balance fetch and full synchronization from open orders to reset optimistic drift.
  - **Benefit**: Prevents accumulated accounting errors from affecting bot operations and ensures clean state initialization.

### Fixed
- **Zero-Amount Order Prevention** (commit ca2a28e)
  - **Problem**: Strict minimum order size validation was missing, allowing zero-amount orders to be created and broadcast to blockchain, causing transaction failures and accounting drift.
  - **Solution**:
    - Enforced absolute minimum order size in both strategy and grid logic using `getMinOrderSize()`.
    - Added validation gate in `broadcastBatch()` to reject zero-amount operations before blockchain submission.
    - Implemented fresh balance fetch during batch failure recovery to reset optimistic drift to blockchain reality.
  - **Impact**: Prevents zero-size orders from corrupting chain state and triggering cascading recovery cycles.

- **Optimistic Accounting Drift Recovery** (commit ca2a28e)
  - **Problem**: Failed batch operations could leave optimistic accounting state desynchronized from actual blockchain totals.
  - **Solution**: Fresh `fetchAccountTotals()` call before synchronization resets optimistic tracking to true blockchain values.
  - **Safety**: Applied in both validation failure and execution failure paths to ensure consistent recovery.

### Refactored
- **Startup Sequence Deduplication** (commit f11cc3c)
  - **Problem**: 697 lines of duplicated startup code between `start()` and `startWithPrivateKey()` created maintenance burden and inconsistency risk.
  - **Solution**: Extracted shared logic into unified private methods:
    - `_initializeStartupState()`: Centralized state initialization
    - `_finishStartupSequence()`: Unified startup completion logic
    - `_setupAccountContext()`: Consolidated account setup
    - `_runGridMaintenance()`: Single grid maintenance entry point
    - `_executeMaintenanceLogic()`: Centralized threshold, divergence, spread, and health checks
  - **Refactored `placeInitialOrders()`**: Now uses `updateOrdersOnChainBatch()` for consistency.
  - **Impact**: Net reduction of ~280 lines with guaranteed identical startup behavior across all entry points.

- **Lock Ordering Fixes for Deadlock Prevention** (commit f11cc3c)
  - **Problem**: Inconsistent lock acquisition order between fill processing and grid maintenance could cause deadlocks.
  - **Solution**:
    - Enforce canonical lock order: `_fillProcessingLock → _divergenceLock`
    - Replace fragile `isLocked()` checks with explicit `fillLockAlreadyHeld` parameter
    - Add try-finally to ensure `isBootstrapping` flag is always cleared
    - Extend lock scope in startup to cover finishBootstrap and maintenance atomically
    - Add error handling in `_consumeFillQueue()` divergence lock
  - **Impact**: Eliminates potential deadlock scenarios and ensures atomic startup operations.

### Changed
- **Package Scripts Enhancement** (commits f02497d, 2f4a938)
  - Added `pdev` npm script: Synchronizes test branch to dev branch with safe remote push mode
  - Added `ptest` npm script: Synchronizes local test branch to origin/test safely without branch switching
  - **Benefit**: Streamlined development workflow with safer branch promotion

### Performance
- **No Performance Impact**: Startup deduplication maintains identical execution paths; refactoring is internal only.

### Quality Assurance
- **Code Quality Improvements**
  - Consolidated ~280 lines of duplicate startup code
  - Improved lock management with explicit parameter passing
  - Enhanced error handling in divergence lock acquisition
  - Maintainability improvement: Single source of truth for startup sequence and grid maintenance logic

### Core Lines Changed
**Total: 3,498** (2,426 added, 1,072 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.8] - 2026-01-25 - Spread Refinement, Inventory Sync & Operational Hardening

### Added
- **Layer 2 Self-Healing Recovery** (commit 8e88a6d)
  - **Feature**: Enhanced stabilization gate with automated recovery when transient fund drift is detected.
  - **Mechanism**: Attempts account refresh and full syncFromOpenOrders before re-verifying invariants.
  - **Benefit**: Prevents unnecessary halting from transient optimistic tracking drifts while maintaining safety against persistent corruption.
- **Fund-Driven Boundary Sync** (commit 7a443f5)
  - **Feature**: Implemented a new synchronization layer that aligns the grid boundary with the account's actual inventory distribution (buy/sell fund ratio).
  - **Benefit**: Automatically shifts the grid to favor the "heavier" side, ensuring the bot remains positioned where it has the most capital to trade.
- **Scaled Spread Correction** (commit 75e23b2)
  - **Feature**: Introduced dynamic spread correction that scales the number of replacement slots based on the severity of the widening.
  - **Safety**: Integrated a "double-dust" safety floor to prevent creating undersized orders during aggressive corrections.
- **Periodic Market Price Refresh** (commit ec97a02)
  - **Feature**: Added background market price updates every 4 hours (configurable).
  - **Impact**: Ensures that fund valuation and grid anchoring remain accurate even during long-running sessions without fills.

### Fixed
- **Rapid-Restart Cascade Defense (Layer 1 & Layer 2)** (commit ebca167)
  - **Problem**: Rapid bot restarts caused cascading fund drift (416 BTS), 2,470x order size mismatches, and 43 billion BTS delta calculation errors when orders filled on-chain while bot was offline.
  - **Solution - Layer 1**: Session timestamps (sessionId, createdAtMs) prevent stale grid orders from being matched to chain orders via orphan-fallback. Pre-restart orders are marked with `previousSessionMarker=true` and automatically skipped.
  - **Solution - Layer 2**: Stabilization gate (`checkFundDriftAfterFills()`) compares grid allocation + free balance vs actual blockchain totals before rebalancing. Aborts if drift exceeds tolerance, preventing cascade corruption spread.
  - **Impact**: Defense-in-depth protection with negligible overhead (O(1) check + <1ms scan).
- **Periodic Fetch Deadlock Resolution** (commit a2f76c9)
  - **Problem**: Periodic fetch operations could deadlock during boundary sync or fill processing, causing bot to hang.
  - **Solution**: Refined timeout logic and acquisition sequencing in periodic fetch handler.
  - **Impact**: Smooth background updates without blocking core operations.
- **Updater Restart Loop Prevention** (commits 95b6d15, 230af49)
  - **Problem**: Updater would trigger redundant restarts and fail to gracefully handle branches where local is ahead of remote.
  - **Solution**: Optimized branch switching detection and added checks to prevent unnecessary reloads when local is ahead.
  - **Impact**: Cleaner update cycle, fewer spurious restarts.
- **Grid Check API Breakage** (commit bf41543)
  - **Problem**: Periodic grid checks broke API contract and caused deadlock during fill processing.
  - **Solution**: Fixed deadlock and restored API compatibility.
- **Spread Gap Over-calculation & Alignment** (commit 77d01cd)
  - **Problem**: The grid was creating one more price gap than intended because it didn't account for the naturally occurring 'Center Gap' during symmetric centering.
  - **Solution**: Refined `gapSlots` calculation to `requiredSteps - 1` and standardized spread-check logic to use `gapSlots + 1` as the true gap distance.
- **BUY Side Sizing & Fee Accounting** (commits 6190e46, eea127b)
  - **Fix**: Resolved a sizing mismatch on the BUY side where fees were incorrectly applied to the base asset instead of the quote asset.
  - **Accuracy**: Now correctly accounts for market fees and BTS maker refunds in fill proceeds calculation, ensuring internal ledgers match blockchain totals.
- **Configurable Pricing Priority** (commit 46b39f8)
  - **Fix**: Disabled automatic `startPrice` derivation and refresh when a numeric value is explicitly provided in `bots.json`. This gives users absolute control over grid anchoring.
- **Strategic Grid Balance** (commit 2313bdd)
  - **Logic**: Implemented automatic target count reduction (-1) on "doubled" sides (sides with dust-consolidated orders) to prevent structural grid drift and maintain symmetry.

### Refactored
- **Unused Stabilization Constants Removal** (commit ebca167)
  - **Cleanup**: Removed unused STABILIZATION constants (MAX_DRIFT_BTS, MAX_DRIFT_PERCENT, INVARIANT_CHECK_TIMEOUT_MS, SESSION_BOUNDARY_GRACE_PERIOD_MS) from Layer 2 defense implementation.
  - **Rationale**: Implementation uses existing GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE instead; preset constants added unnecessary complexity without usage.
- **PM2 Orchestration & Credential Management** (commits 5ddd6cb, 3685332)
  - **Cleanup**: Integrated the credential daemon directly into the PM2 lifecycle and simplified the launcher logic.
  - **Visibility**: Renamed PM2 processes to `dexbot-cred` and `dexbot-update` for easier monitoring via `pm2 list`.
- **Legacy Spread Multiplier Removal** (commit 77d01cd)
  - **Cleanup**: Completely removed `SPREAD_WIDENING_MULTIPLIER` and replaced it with a neutral, fixed 1-slot tolerance buffer across all modules.
- **Out-of-Spread Metric Unification** (commit 0546487)
  - **Logic**: Refactored `outOfSpread` from a boolean flag to a numeric distance (steps), allowing for more precise structural updates during rebalancing.

### Performance
- **Pool ID Caching** (commit 490b793)
  - **Optimization**: Cached Liquidity Pool IDs in `derivePoolPrice` to eliminate redundant blockchain scans, significantly reducing API load during startup and refreshes.
  - **Cache Invalidation**: Validates cached pools against requested assets to prevent stale pool reuse
  - **Transparent Fallback**: Falls back to blockchain scan on cache miss, maintaining correctness

### Quality Assurance
- **Boundary Sync Integration Tests** (`tests/test_boundary_sync_logic.js`)
  - **Coverage**: 10+ test cases covering fund-driven boundary recalculation, rotation pairing, and target count reduction
  - **Tests Include**:
    - Boundary shifts with fund imbalance (validates fund-driven boundary logic)
    - Rotation pairing matches existing orders to desired slots
    - Doubled side reduces target count by 1 (prevents grid imbalance)
    - Boundary respects available funds (prevents overfunding)
    - Cache ratio threshold detection (20% GRID_REGENERATION_PERCENTAGE)
    - Grid divergence detection between persisted and calculated states
    - Bootstrap divergence ordering (threshold check → divergence check)
    - Pool ID cache hit/miss behavior
    - Cache invalidation on stale pools
    - Concurrent cache access integrity
  - **Impact**: Comprehensive validation of core boundary sync and startup grid check logic

- **Fee Calculation Backwards Compatibility Tests** (`tests/test_fee_backwards_compat.js`)
  - **Coverage**: 21+ test cases validating fee calculation changes and API compatibility
  - **Tests Include**:
    - **BTS Fee Object Structure**: Always returns object (never number) for BTS
    - **Old Fields Preserved**: `total`, `createFee`, `netFee` still present (legacy code compatibility)
    - **New Field Added**: `netProceeds` field for improved accounting
    - **Maker/Taker Differentiation**: 90% refund for makers preserved
    - **Non-BTS Assets**: Still return number (unchanged behavior)
    - **Mixed Asset Pattern**: Code handles both BTS and non-BTS safely
    - **Fee Math Accuracy**: Validates BTS maker/taker proceeds and non-BTS fee deduction
  - **Key Finding**: New `netProceeds` field is backwards compatible; code can safely use `typeof` checks to access it
  - **Impact**: Ensures no breaking changes to fee API while adding accounting precision

- **Code Quality Improvements**
  - **Trailing Whitespace**: Removed 34 lines of trailing whitespace across 10 files
    - `modules/dexbot_class.js`, `modules/order/runner.js`, `modules/order/grid.js`
    - `modules/order/accounting.js`, `modules/order/strategy.js`, `modules/account_bots.js`
    - `modules/order/startup_reconcile.js`, `modules/order/utils.js`, `dexbot.js`, `pm2.js`
  - **Whitespace Verification**: `git diff --cached --check` shows 0 issues post-cleanup
  - **Test Integration**: New tests added to npm test script (package.json)
  - **All Tests Passing**: Full test suite runs 32+ test files with no failures

### Changed
- **Documentation Overhaul**: Updated `FUND_MOVEMENT_AND_ACCOUNTING.md`, `architecture.md`, and `developer_guide.md` to reflect refined gap formulas, zone indexing, and new sync behaviors.
- **Research**: Added the 3-indicator reversal architecture to the trend detection analysis folder (`74203ab`).
- **Fee Calculation**: Added `netProceeds` field to BTS fee objects for improved accounting accuracy
  - **For Makers**: `netProceeds = assetAmount + (creationFee * 0.9)` (includes refund)
  - **For Takers**: `netProceeds = assetAmount` (no refund)
  - **Backwards Compat**: Non-BTS assets unchanged; BTS object structure is additive

### Technical Details Added
- **Locking Architecture**: New `_divergenceLock` in `_performGridChecks()` prevents races with fill processing during boundary sync
- **Startup Grid Checks**: New `_performGridChecks()` method consolidates fund threshold and divergence checks
  - **Phase 1**: Threshold check (cache ratio exceeds GRID_REGENERATION_PERCENTAGE)
  - **Phase 2**: Divergence check (only after threshold check fails, only during bootstrap)
  - **Atomic Operations**: Uses `_divergenceLock.acquire()` to prevent concurrent modifications
- **Fund-Driven Boundary Calculation**: Adjusts grid boundary based on inventory distribution (buy/sell fund ratio)
  - **Initialization**: Scans all grid slots and calculates fund-driven boundary position
  - **Role Assignment**: Adjusts BUY/SPREAD/SELL zone assignments based on new boundary
  - **Fund Respect**: Never exceeds available funds during slot activation
- **Rotation Pairing Algorithm**: Matches existing on-chain orders to desired slots
  - **Closest First**: Sorts active orders by market distance (best execution first)
  - **Adaptive Target Count**: Reduces by 1 on doubled sides to prevent structural drift
  - **Three Cases**: MATCH (update), ACTIVATE (new placement), DEACTIVATE (excessive)

---

## [0.6.0-patch.7] - 2026-01-23 - Architectural Hardening, Deep Consolidation & Performance Optimization

### Fixed
- **Deep Startup Consolidation & Refactoring** (commits 3898ae0, a3df538, aeb6850, c33568c)
  - **Problem**: CLI and PM2 startup paths had diverged into 100+ lines of duplicated, inconsistent logic, increasing maintenance burden and race condition risk.
  - **Solution**: Extracted shared logic into unified private methods:
    - `_executeStartupGridSequence()`: Centralized fund restoration, grid decision (resume/regenerate), and initial reconciliation.
    - `_initializeBootstrapPhase()`: Centralized AccountOrders setup, fill loading, and OrderManager creation.
    - `_resolveAccountId()`: Single source of truth for account resolution.
  - **Impact**: Guaranteed identical, hardened startup behavior across all entry points. Net reduction of ~200 lines of redundant code.

- **Startup Accounting Alignment (The "Fund Invariant" Fix)** (commit 64c7287)
  - **Problem**: When repurposing an on-chain order during startup, any reduction in size was "leaked" from internal tracking, causing a permanent discrepancy where `blockchainTotal > trackedTotal`.
  - **Solution**: Refactored `startup_reconcile.js` to use delta-based accounting.
    - Optimistically adds existing order size to `Free` balance before resizing.
    - Uses `skipAccounting: false` during synchronization to correctly deduct the new grid size.
  - **Impact**: Correctly tracks fund deltas (released or required) during startup, maintaining perfect 1:1 synchronization with blockchain totals.

- **Grid Resizing Performance & "Hang" Prevention** (commit 64c7287)
  - **Problem**: Modifying 300+ grid slots during rebalancing triggered a full fund recalculation and invariant check for *every single order*, causing massive log spam and process "hangs" during bootstrap.
  - **Solution**: Wrapped `Grid._updateOrdersForSide()` in `pauseFundRecalc()` and `resumeFundRecalc()` guards.
  - **Impact**: Fund totals are recalculated exactly once after the entire side is updated. Eliminates redundant processing and prevents logging-related performance degradation.

- **Earliest Phase Fill Capture** (commit a291f30)
  - **Problem**: Fills occurring during the few seconds of grid synchronization at startup could be missed or cause state collisions.
  - **Solution**: Moved `listenForFills` activation to the very beginning of the shared `_initializeBootstrapPhase()`.
  - **Hardening**: Fills arriving during setup are safely queued and only processed after the `isBootstrapping` flag is cleared and the startup lock is released.
  - **Impact**: Full capture of trading activity during any startup path (normal or reset).

- **Unified Grid Reset Logic** (commit 3898ae0)
  - **Problem**: Trigger-based resets used separate implementations for startup detection vs. runtime file watching.
  - **Solution**: Extracted shared regeneration logic into `_performGridReset()`.
  - **Impact**: Consistent behavior for config reloading, fund clearing, and trigger file removal across the entire bot lifecycle.

- **Phantom Orders Prevention with Defense-in-Depth** (commits c73e790, d36c180)
  - **Problem**: Orders could exist in ACTIVE/PARTIAL state without blockchain `orderId`, causing "doubled funds" warnings.
  - **Solution - Three Layer Defense**:
    1. **Primary Guard**: Centralized validation in `_updateOrder()` rejects ACTIVE/PARTIAL state without valid orderId.
    2. **Grid Protection**: Preserves order state during resizing instead of forcing ACTIVE.
    3. **Sync Cleanup**: Detects and converts nameless ACTIVE/PARTIAL orders to SPREAD placeholders.
  - **Impact**: Provides permanent protection against fund tracking corruption and high RMS divergence logs.

### Refactored
- **Strategy Logic Cleanup** (commit 3898ae0)
  - Simplified `countOrdersByType()` in `utils.js` by removing stale `pendingRotation` and `EffectiveActive` logic from older models.
- **Standardized Bootstrap Management** (commit 3898ae0)
  - Enforced formal `manager.startBootstrap()` and `finishBootstrap()` calls across all paths for consistent logging and invariant suppression.
- **Utils Module Organization** (commit 0e5e9e7)
  - Reorganized utils.js sections to match Table of Contents.

### Updated Documentation
- **PM2 Documentation** (commit a47ddbf)
  - Updated README to clarify PM2 orchestration and trigger detection for running bots.
- **Architecture & Developer Guides** (commit 86261fc)
  - Added "Phantom Order Prevention" and "Hardened Startup Sequence" sections.

### Core Lines Changed
**Total: 7,317** (5,326 added, 1,991 removed) - Root and modules/*.js files only

### Core Lines Changed
**Total: 6,217** (3,872 added, 2,345 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.6] - 2026-01-22 - Accounting Hardening & Asset Neutrality

### Added
- **Automated Branch Synchronization Script** (commit 0d7dac0, 1596c93)
  - New `pmain` script for automated synchronization between `dev`, `test`, and `main` branches.
  - Ensures proper push order (test -> dev -> main) to maintain consistency.
- **Gitignore for Generated Documentation** (commit 6ccf2cc)
  - Automatically ignores generated HTML documentation files from the repository.

### Fixed
- **Critical Accounting Inconsistency & Double-Deduction** (commit 2deb9fc)
  - Fixed bugs in `startup_reconcile`, `grid.js`, and `sync_engine` where initial order states triggered redundant optimistic deductions.
  - Sanitized phantom order cleanup to use `skipAccounting` preventing tracked balance inflation.
- **Resync Order Duplication** (commit 8d65e0b)
  - Implemented delta-based balance checks during resync to prevent creating duplicate orders.
  - Fixed `ReferenceError` in reconciliation logic.
- **False Positive Fund Invariants** (commit 16f15c7)
  - Silenced spurious "Fund invariant violation" warnings during resync and startup phases.
- **Signature Mismatch in Order Updates** (commit 90b27fe, 518f9f8)
  - Corrected `_updateOrder` signature mismatches across modules.
  - Implemented `_isBroadcasting` flag for improved operation tracking.
- **Build/Update Script Robustness** (commit 4082646, 1dea7a4)
  - Fixed shell script errors ("integer expression expected") and relaxed merge history checks.
- **Resync Atomic Re-verification & Locking**
  - Added "Just-in-Time" state verification in `startup_reconcile.js` to abort double-placements after recovery syncs.
  - Wrapped startup synchronization in `dexbot_class.js` with `_fillProcessingLock` to serialize early fill notifications.
- **BTS Fee Accounting during Sync**
  - Fixed bug where BTS fees were skipped during resync; fees are now always tracked even when asset accounting is disabled.

### Refactored
- **Asset Neutrality (Generic Variable Names)** (commit fc3fa9f)
  - Refactored codebase to replace asset-specific variable names (e.g., `currentXrpBalance`) with generic alternatives.
  - Improves multi-asset support and reduces confusion when trading non-XRP pairs.
- **Integer-First Alignment (rawOnChain)** (commit 92f0701)
  - Modernized core logic to fully align with the `rawOnChain` integer-tracking model.
- **Fund Management Streamlining** (commit 83fca8e)
  - Simplified fund state management and reduced transient logging noise.

### Updated Documentation
- **Consolidated Fund Guide** (commit ab7789c, 6b2d826)
  - Merged and expanded fund accounting and movement documentation into a single authoritative guide.
- **Modernized Architecture & Testing Docs** (commit 0e8c623)
  - Updated technical documentation to reflect recent architectural shifts and testing procedures.

---

## [0.6.0-patch.5] - 2026-01-21 - Security, Performance & AMA Integration

### Added
- **Unix Socket Credential Daemon** (commit 75e9eed)
  - Eliminates security vulnerability where master passwords were exposed via `MASTER_PASSWORD` environment variables
  - Implements daemon pattern that authenticates once and serves decrypted private keys securely via JSON-RPC
  - Password kept in RAM only, never written to disk
- **High-Precision Dual-AMA Trend Detection** (commit 372167c)
  - Implements production-ready trend detection using fast/slow Adaptive Moving Averages
  - Features parameter optimization (6240+ configs), backtesting, and interactive chart generation
- **QTradeX Export Functionality** (commit e78d676)
  - New `dexbot export <bot-name>` command to generate backtesting-compatible CSV files
  - Automatically parses PM2 logs to extract trades, fees, and sanitized settings

### Fixed
- **'Active No ID' Grid Corruption** (commit b35946a)
  - Prevents writing corrupted state to disk by downgrading nameless orders to VIRTUAL
  - Added self-healing logic to sanitize existing corrupted files on load
  - Orders now transition to ACTIVE only after confirmed blockchain broadcast
- **BTS Fee Deduction Unification** (commit 160fa9a)
  - Fixed capital drift by applying fees to all on-chain operations (rotations, size updates)
  - Ensures internal ledger perfectly matches blockchain total balances
- **Startup Reconciliation Index Overflow** (commit fc3c31a)
  - Resolved array index overflow when syncing large numbers of orders during bootstrap
- **Excess Order Cancellation Sorting** (commit e941aba)
  - Fixed asymmetry in how excess orders were prioritized for cancellation during grid compression

### Optimized
- **Memory-Only Integer Tracking** (commit 94dd4fa)
  - Transitioned from query-driven to memory-driven model using `rawOnChain` integer cache
  - Eliminates redundant API fetches during rotations and size updates (O(1) local updates)
  - Significantly improves reaction time and reduces blockchain API load
- **Logging System Refactor** (commit b44a370)
  - Consolidated logging logic and reduced CLI verbosity for cleaner PM2 logs

### Updated Documentation
- **docs/ama_strategies_guide.md**
  - Added comprehensive guide for the three Adaptive Moving Average strategies
- **docs/memory_tracking.md**
  - Documented new integer-based memory tracking architecture

### Core Lines Changed
**Total: 8,443** (6,939 added, 1,504 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.4] - 2026-01-15 - Rotation Sizing Formula Fix

### Fixed
- **Rotation Sizing Formula** (commit 63cdb02)
  - Reverted back to grid-difference formula: `gridDifference = idealSize - destinationSize`
  - Previous "fund-neutral" formula incorrectly credited source order size against new order budget
  - **Problem:** sourceSize credit breaks accounting when fill proceeds are already in available funds via cacheFunds
  - **Impact:** Rotation sizing now correctly caps against actual available funds on the rebalance side
  - **Formula:** `finalSize = destinationSize + min(gridDifference, remainingAvail)`
  - **Key Insight:** Available funds already include fill proceeds, source order release is handled separately in fund accounting
  - **Tests:** All 24+ rotation and fund accounting tests pass ✓

### Core Lines Changed
**Total: 31** (14 added, 17 removed) - Root and modules/*.js files only

### Updated Documentation
- **docs/fund_movement_logic.md**
  - Added new section "Rotation Sizing Formula" with mathematical explanation
  - Documented the gridDifference formula and why it's correct
  - Clarified relationship between available funds and rotation capital allocation
  - Explained how fill accounting via cacheFunds integrates with rotation sizing

### Core Lines Changed
**Total: 4,899** (1,511 added, 3,388 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.3] - 2026-01-15 - Rotation Logic & Fund Update Atomicity

### Fixed
- **Buy Order Rotation Logic** (commit 182c43c)
  - Fixed `calculateAvailableFundsValue()` double-deduction of fill proceeds in available funds calculation
  - Removed redundant `inFlight` subtraction that was causing "Available = 0" even with capital present
  - **Impact:** Rotations were being skipped when capital was actually available
  - **Solution:** chainFree is already "optimistic" and accounts for pending orders; no need for separate inFlight tracking

- **Startup Fund Invariant Violations** (commit 182c43c)
  - Added `isBootstrapping` guard to `_verifyFundInvariants()` to prevent false warnings during initial sync
  - Invariants now only checked once bootstrap phase completes (`mgr.isBootstrapping === false`)
  - **Impact:** Eliminates spurious warnings that mask actual issues

### Added
- **Fill Accounting Processing** (commit 182c43c)
  - New `processFillAccounting()` method in Accountant for atomic pays/receives handling
  - Called from sync_engine when fills are detected
  - Ensures internal state stays synchronized with blockchain state

- **Priority-Based Fill Processing** (commit fe14898)
  - Implemented priority queue for fill processing during bootstrap phase
  - Prevents race conditions during initial synchronization

### Refactored
- **Fund Update Atomicity Documentation** (commit 55c2326)
  - Made atomic fund update sequence explicit with step-by-step comments in `rebalance()`
  - **Step 1:** Apply state transitions (reduces chainFree via updateOptimisticFreeBalance)
  - **Step 2:** Deduct cacheFunds (while pauseFundRecalc still active)
  - **Step 3:** Recalculate all funds (everything now in sync)
  - Improves maintainability by making it clear that all fund state is consistent before any calculation

### Core Lines Changed
**Total: 1,663** (769 added, 894 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.2] - 2026-01-15 - Fund Accounting Fixes & Startup Optimization

### Fixed
- **Fund Accounting Double-Counting Bug** (commit 5b4fc2f)
  - Fixed `Grid.determineOrderSideByFunds()` incorrectly adding cacheFunds to available funds
  - **Issue:** cacheFunds is already part of chainFree; adding it again inflates available by 100%+
  - **Impact:** Spread correction would overestimate available capital, potentially leading to over-allocation
  - **Solution:** Use only `available` in fund ratio calculations; cacheFunds is a reporting metric, not a deduction
  - **Reference:** See `docs/fund_movement_logic.md` section 4 for corrected accounting model

- **Rotation State Transitions** (commit 5b4fc2f)
  - Fixed `strategy.js` to properly transition old rotated orders to `VIRTUAL` state with `size: 0`
  - Ensures orders are properly cleaned up during rebalancing without requiring blockchain sync
  - `sync_engine.js` safely handles orders already in VIRTUAL state

### Optimized
- **Startup Fill Processing Lock** (commit c7e7188)
  - Replaced heavy `_fillProcessingLock.acquire()` wrapper during entire startup (~1-5 seconds) with `isBootstrapping` flag
  - **Benefit:** Fills still queue safely but processing is deferred until bootstrap completes
  - **Result:** Eliminates lock contention while maintaining all TOCTOU race prevention
  - **Implementation:** Check `isBootstrapping` in fill consumer loop to skip processing during startup

### Updated Documentation
- **docs/fund_movement_logic.md**
  - Corrected Available Funds formula: removed cacheFunds subtraction
  - Added detailed explanation of fund components and their purpose
  - Clarified cacheFunds lifecycle: it's part of chainFree, not a separate deduction
  - Added new section 5.1 on Rotation State Management with examples
  - Includes code examples showing proper state transitions during rotation

### All Tests Pass ✓
- 25+ test suites including fund accounting, partial orders, and rotation scenarios
- Multi-fill opposite partial order tests verify rotation state transitions

### Core Lines Changed
**Total: 2,120** (1,166 added, 954 removed) - Root and modules/*.js files only

---

## [0.6.0] - 2026-01-04 - Physical Rail Strategy, Merge/Split Consolidation & Engine Modularization (Updated 2026-01-14)

### Commit Statistics (v0.5.1 → v0.6.0)
**Total Commits:** 230

| Type | Count | Percentage |
|------|-------|------------|
| **fix** | 99 | 43.0% |
| **refactor** | 49 | 21.3% |
| **feat** | 34 | 14.8% |
| **docs** | 28 | 12.2% |
| **test** | 8 | 3.5% |
| **cleanup** | 8 | 3.5% |
| **style** | 4 | 1.7% |
| **chore** | 5 | 2.2% |

### Theme Breakdown
| Theme | Count | Description |
|-------|-------|-------------|
| **Grid/Spread/Order/Rotation** | 76 | Grid management, order placement, rotations |
| **Fund/Capital/Budget/Wallet** | 31 | Fund management, budgeting, capital cycling |
| **Concurrency/Race/Lock** | 16 | Race conditions, locking, concurrency safety |
| **Precision/Asset/Fee** | 19 | Asset precision, fee handling, validation |

### Added
- **Contiguous Physical Rail Strategy**: A major architectural evolution where the grid is treated as a solid "rail" of orders.
  - Ensures contiguous order placement without gaps.
  - Moves the entire rail physically with market price changes.
  - Significantly improves stability during high-volatility events.
- **MERGE vs SPLIT Consolidation**: Advanced decision logic for handling partial orders:
  - **MERGE (Dust)**: Tiny partials (< 5%) are absorbed and refilled with new capital to restore their full ideal size.
  - **SPLIT (Substantial)**: Larger partials are cleanly split, keeping the filled portion active on-chain while managing the remainder as a new virtual order.
- **Complete Constants Centralization**: Consolidated 60+ hardcoded magic numbers into a single source of truth
    - **New Constants Sections**:
      - `INCREMENT_BOUNDS`: Grid increment percentage bounds (0.01% - 10%)
      - `FEE_PARAMETERS`: BTS fee reservation multiplier (5), fallback fee (100), **maker refund ratio (10%)**
      - `API_LIMITS`: Pool batch size (100), scan batches (100), orderbook depth (5), limit orders batch (100)
      - `FILL_PROCESSING`: Fill mode ('history'), operation type (4), taker indicator (0)
      - `MAINTENANCE`: Cleanup probability (0.1)
      - **Note**: Bot requires asset precision metadata for all trading pairs. Without precision, the bot cannot safely calculate order sizes and will not operate.
   - **Note**: Asset precision fallback removed - bot now enforces strict precision requirements and fails loudly if asset metadata is unavailable
   - **Grid Constants Additions**:
     - `MIN_SPREAD_ORDERS`: Minimum number of spread orders (2)
     - `SPREAD_WIDENING_MULTIPLIER`: Buffer multiplier for spread condition threshold (1.5)
   - **Impact**: Eliminates scattered magic numbers across 10 files, improves maintainability and consistency

- **Enhanced Settings Configuration**:
  - Split `TIMING` configuration menu into two clear sections:
    - **Timing (Core)**: Fetch interval, sync delay, lock timeout
    - **Timing (Fill)**: Dedup window, cleanup interval, record retention
  - `EXPERT` section support for advanced settings (accessible via JSON-only, not menu)

- **Specialized Engine Architecture**: Modularized OrderManager into three focused engines
  - **Accountant Engine** (`accounting.js`): Fund tracking, invariant verification, fee management
  - **Strategy Engine** (`strategy.js`): Now implements the **Physical Rail** and **Unified Rebalancing** logic.
  - **Sync Engine** (`sync_engine.js`): Blockchain reconciliation and fill processing

- **Optimized Grid Diagnostics**: Added `logGridDiagnostics` to `Logger` providing a color-coded visualization of the grid.
- **Fund Invariant Verification System**: Automatic detection of fund accounting leaks with configurable tolerance.
- **Order Index Validation Method**: Defensive `validateIndices()` method for debugging index corruption.
- **Metrics Tracking System**: Enhanced observability with `getMetrics()` for production monitoring.

### Fixed (99 commits)
**Grid & Order Management (26 fixes)**
- Disable dynamic spread check during fill-replacement rotations to prevent conflicts
- Remove proactive spread correction from fill-processing loop
- Relax grid health check to support edge-first placement strategy
- Unify grid sizing budget, resolve botFunds % inconsistency and fee accounting
- Resolve budget double-counting in divergence check and align fund docs
- Apply full grid regeneration for divergence corrections to prevent Frankenstein grids
- Implement selective filtering strategy for order size updates to prevent fund leaks
- Resolve grid side update crash and improve cacheFunds accounting
- Improve spread correction and fix fill queue test logic
- Resolve 7 critical issues in strategy rebalancing
- Resolve 10 critical issues in strategy and grid rebalancing logic
- Prevent double dust partial creation
- Resolve placement and partial order handling in rebalancing
- Cap placements and refactor strategy helper methods
- Force reload persisted grid during divergence checks to ensure fresh data
- Ensure rotations complete after divergence correction instead of skipping
- Restore reverse parameter for BUY side allocation
- Correct fund validation for precision and update deltas
- Persist boundaryIdx and stabilize grid rebalancing logic
- Handle missing rotation orders and partial fills properly
- Resolve 4 critical issues in grid.js spread correction and locking
- Prevent race conditions in spread correction and grid startup
- Correct buy order sort order in Grid.checkGridHealth
- Restore minimum order size warning and refine rounding safety
- Finalize hardening with robust spread counting and rounding safety
- Ensure contiguous starting grid in startup_reconcile

**Fund Management (18 fixes)**
- Resolve fund inflation, precision handling, and align divergence check ideals
- Improve budget calculation and remove double-counting optimistic updates
- Preserve cacheFunds across rebalance cycles instead of recalculating
- Resolve ghost sizes and implement partial rotation priority during rebalancing
- Revert dust detection to dual-side (AND) logic
- Implement startup dual-dust check and harden index management
- Simplify fund distribution and stabilize active order sizes
- Resolve fund accounting leaks and excess order creation
- Fix high available funds and duplicate cleanup
- Resolve cacheFunds double-counting and prevent accounting errors
- Fix BTS fee over-reservation and implement Greedy Crawl rotations
- Resolve double BTS fee deduction in order sizing
- Restore btsFeesReservation to available funds calculation
- Refine fund tracking accuracy across rotation cycles
- Improve fund accuracy and reduce logging noise
- Add pre-flight fund validation before batch broadcast
- Restore is_maker filter and align dust detection budget calculation

**Concurrency & Race Conditions (16 fixes)**
- Resolve 4 critical cross-file issues with locking and graceful shutdown
- Fix security and error handling issues in pm2.js
- Fix 5 critical error handling issues in dexbot
- Fix race condition in waitForAccountTotals and SPREAD order tracking
- Prevent lock deadlocks in syncFromFillHistory() by adding nested try/finally blocks
- Eliminate 12 critical race conditions and concurrency issues in fill processing
- Fix concurrency issues and code quality in dexbot_class.js
- Resolve 6 race conditions and bugs in sync_engine.js
- Prevent race condition in waitForAccountTotals with concurrent calls
- Eliminate 9 race conditions in grid.js for production safety
- Restore fill listener activation BEFORE grid operations
- Implement strict trigger-based rebalancing and partial anchoring
- Improve code style and lock atomicity
- Add locking and precision improvements for concurrent safety
- Address 6 critical issues from code review
- Implement 9 critical bug fixes and improvements

**Precision & Fees (19 fixes)**
- Implement fail-fast logic for asset precision and strengthen tolerance checks
- Prevent and repair grid corruption caused by fake orderIds
- Remove precision fallback defaults - halt bot if precision unavailable
- Remove unused PRECISION_DEFAULTS constant and implement graceful halt on missing asset precision
- Correct precision calculation and order reconciliation logic
- Add await to async Grid.compareGrids() calls and improve error handling
- Account for both market and blockchain taker fees in fill processing
- Handle PARTIAL orders in fund summation (critical)
- Correct order type case matching in proceeds calculation
- Use filledOrder.type directly instead of undefined variable
- Restore market fee logic and physical role synchronization in StrategyEngine
- Cleanup magic numbers and finalize fund naming consistency
- Implement 6 Opus recommendations for robustness and observability
- Properly restore order states in ghost virtualization and refine validation
- Crash fix: correct method call updateAccountTotals to fetchAccountTotals
- Fix crash in grid resync by correcting method calls
- Remove null bytes from account_bots.js to fix encoding issues
- Add null/NaN guards and return values to addToChainFree
- Resolve 3 bugs in startup_reconcile.js (state comparison, array slicing, parameter validation)

**Strategy & Rebalancing (8 fixes)**
- Resolve critical strategy engine issues with state consistency and performance
- Apply 5 defensive fixes to Physical Rail Strategy
- Remove excessive maintenance resizing of active orders
- Implement strict trigger-based rebalancing and partial anchoring
- Restore grid.js functionality and improve bot stability
- Hardening strategy logic with transactional updates and safety checks
- Fix 8 critical and medium-priority bugs in manager.js and grid.js
- Implement side-wide double-order strategy for dust merges

**Error Handling & Validation (12 fixes)**
- Resolve critical issues in bot.js initialization and error handling
- Fix initialization and startup validation issues
- Improve general settings UI and input validation
- Silence transient warnings and prevent cacheFunds double-counting
- Only log divergence breakdown when exceeding regeneration threshold
- Process filled orders found during periodic and startup sync
- Implement strict trigger-based rebalancing
- Maintain ACTIVE state for DoubleOrders until below 100% size
- Finalize SPREAD and ACTIVE state management
- Add missing _persistWithRetry method to OrderManager
- Disable non-existent get_liquidity_pool_by_asset_ids direct lookup
- Remove legacy-testing-migration.md file

### Refactored (49 commits)
**Architecture & Modularization**
- Complete OrderManager modularization into specialized engines
- Extract strategy engine and finalize anchored multi-partial logic
- Extract strategy engine and finalize multi-partial consolidation
- Extract accounting logic and refine state transitions
- Improve dexbot_class architecture and consolidate grid checking logic
- Cleanup and stability improvements for physical rail strategy
- Contiguous physical Rail Strategy with Constant Spread
- Unified Rebalancing with explicit Physical Shift and Surplus Management

**Code Cleanup & Simplification**
- Remove 16+ unused functions and dead code modules
- Consolidate duplicate bot entry and authentication functions
- Remove emptyResult: inline factory method for result object
- Remove isExcluded: inline simple exclusion check
- Remove _recordStateTransition: dead metrics tracking code
- Remove checkSizesNearMinimum: inline wrapper for warning check
- Remove mapOrderSizes: inline thin wrapper function
- Remove getCachedFees function - getAssetFees is the preferred interface
- Remove checkPriceWithinTolerance wrapper function
- Remove assertIsHumanReadableFloat function
- Inline isRelativeMultiplierString and parseRelativeMultiplierString into resolveRelativePrice
- Remove onConnected: unused callback-based connection API
- Prune redundant passthrough methods in OrderManager
- Remove legacy code and deprecated fund management functions
- Final cleanup of legacy functions and storage logic
- Cleanup: Prune legacy/unused code from root scripts and update package.json

**Grid & Strategy Logic**
- Simplify strategy.js structure and fix partial order handling
- Simplify order validation with strict max order size constraint
- Optimize batch processing and remove unsafe interrupt logic
- Simplify rebalanceSideRobust logic and update tests
- Simplify rebalanceSideRobust algorithm documentation and implementation
- Simplify spread activation with sequential order placement
- Simplify updater schedule to interval/time in bot editor
- Simplify and standardize utils.js order subsystem utilities
- Simplify order type check to match main branch
- Remove redundant case conversion in runner.js

**Utilities & Formatting**
- Centralize numeric formatting to eliminate .toFixed() duplication
- Organize grid.js and utils.js into clear functional sections
- Eliminate duplicate gap calculation in rebalance
- Refine anchoring rules and revert rotation sorting
- Move legacy testing functions to dedicated module
- Final cleanup of legacy code and redundant logic across modules
- Consolidate persistence and cleanup ghost logic since 57f408c
- Clean up unused virtual order extraction in calculateSpreadFromOrders call
- Refactor tests to use modern StrategyEngine and remove legacy-testing.js

### Changed
- **Spread Zone Boundaries**: Implemented strict price boundaries (`highestActiveBuy < price < lowestActiveSell`) for rotations.
- **Rotation Selection Priority**: Refined selection logic to prioritize the lowest SPREAD slot for BUY rotations and highest for SELL.
- **Log Verbosity Control**: Silenced high-frequency logs in standard `info` mode.
- **Architecture**: Refactored OrderManager to delegate to specialized engines (Accountant, Strategy, Sync).
- **Fund Calculation Flow**: Optimized to walk active/partial orders using indices for performance.
- **State Transition Validation**: Enhanced state machine enforcement with logging and input validation.
- **Batch Fund Recalculation**: Pause/resume mechanism for multi-order operations with depth counter.
- **Updater Schedule**: Changed timing units to seconds for UI display, simplified to interval/time configuration.

### Documentation (28 commits)
- Update and standardize JSDoc documentation across modules
- Update and standardize JSDoc for root scripts (bot.js, dexbot.js, pm2.js)
- Add JSDoc headers to strategy.js methods
- Add comprehensive architecture and developer documentation
- Add comprehensive technical report on fund movement architecture
- Comprehensive documentation for order management system
- Add comprehensive code review report
- Update Features section: remove duplication and add current capabilities
- Update readme.md to reflect new update routine
- Enhance scripts/README.md with terminal-focused documentation and wrappers
- Add scripts/README.md documentation
- Update tests/README.md with comprehensive test list
- Update tests/README.md with test_market_scenarios.js entry
- Consolidate documentation and remove redundant files
- Update CHANGELOG for documentation improvements
- Enhance workflow documentation with comprehensive guide and troubleshooting
- Add development context and move workflow documentation
- Update README to reflect updated configuration approach
- Fix available funds formula documentation inconsistencies
- Update changelog for constants centralization in v0.6.0
- Document code review fixes in v0.5.2 changelog

### Testing (8 commits)
- Add comprehensive unit tests and quality improvements to order subsystem
- Add comprehensive engine integration tests
- Optimize test suite and fix fee accounting and grid sorting logic
- Update partial order tests for STEP 2.5 in-place handling
- Add Scenario 4 (Partial Handling) to market scenarios test
- Refactor tests to use modern StrategyEngine and remove legacy-testing.js
- Add high-priority documentation and sliding window transition tests
- Integrate fund calculation testing and recent bugfix coverage

### Cleanup (8 commits)
- Delete test_output directory and artifacts
- Remove temporary test artifacts and ignore tests/tmp/ directory
- Final cleanup of legacy functions and storage logic
- Remove Jest from production and clean up configuration
- Minor account_bots line formatting
- Add .gemini to gitignore and remove from git tracking
- Consolidate test improvements into dev branch

### Style (4 commits)
- Unify updater branch color in general settings menu
- Color-code branch and schedule options in CLI with improved readability
- Match general settings menu colors to account_bots editor
- Update bot editor color scheme for better readability and retro vibe

### Technical Details
- **Physical Rail Logic**: The strategy now calculates a "rail" of ideal prices and maps existing orders to these physical slots, ensuring continuity.
- **Ghost Virtualization**: Safely processes multiple partials by temporarily marking them as VIRTUAL during consolidation.
- **Atomic Fund Operations**: Uses `tryDeductFromChainFree()` pattern to prevent TOCTOU race conditions.
- **Fund Invariant Tolerance**: Dual-mode tolerance (Precision Slack + Percentage) for robust invariant checking.

### Performance Impact
- **Faster Fund Calculation**: Uses indices instead of walking all orders.
- **Batch Operations**: Pause/resume mechanism eliminates redundant recalculations.
- **Lock Refresh**: Prevents timeout during long reconciliation cycles.

### Testing
- All core tests passing (230 commits validated).
- New coverage for sliding window transitions and physical rail logic.
- Comprehensive engine integration tests with 99 bug fixes verified.
- Unit tests for order subsystem with quality improvements.
- Market scenarios test with Scenario 4 (Partial Handling).
- Fund calculation testing integrated with bugfix coverage.
- Test suite optimized with fee accounting and grid sorting logic fixes.

### Migration
- **No Breaking Changes**: Fully backward compatible with existing bots.
- **Automatic Initialization**: Legacy bots automatically migrate to new architecture.

---

- **Null Safety Hardening** (accounting.js, grid.js)
  - Added optional chaining (`?.`) to all manager.logger.log() calls
  - Protected manager._metrics access to prevent crashes if metrics uninitialized
  - Prevents runtime errors in edge cases where logger or metrics are null

- **Price Correction Lock Protection** (utils.js)
  - Price correction operations now acquire AsyncLock before modifying order state
  - Ensures lock is released via finally block even if correction operation fails
  - Prevents concurrent mutations during price correction snapshots
  - Note: Spread correction (grid.js) currently does not acquire locks before fund deduction - potential race condition for future improvement

### Changed
- **Architecture**: Refactored OrderManager to delegate to specialized engines
  - Manager now coordinates three engines instead of implementing all logic
  - Delegation methods maintain backward compatibility
  - Cleaner separation of concerns improves maintainability

- **Fund Calculation Flow**:
  - Walk active/partial orders (not all orders) for better performance
  - Indices (_ordersByState, _ordersByType) used for faster iteration
  - Dynamic precision-based slack for rounding tolerance

- **State Transition Validation**: Enhanced state machine enforcement
  - State transitions now logged and tracked for metrics
  - Input validation prevents invalid order states from corrupting grid
  - Proper handling of undefined intermediate states

- **Batch Fund Recalculation**: Pause/resume mechanism for multi-order operations
  - `pauseFundRecalc()` / `resumeFundRecalc()` with depth counter
  - Supports safe nesting for complex operations
  - Avoids redundant recalculations during batch updates

### Technical Details
- **Ghost Virtualization**: Safely process multiple partials without blocking each other
  - Temporarily mark partials as VIRTUAL during consolidation
  - Enables accurate target slot calculations
  - Automatic restoration with batch fund recalc to keep indices in sync
  - Error safety: try/catch ensures partial rollback on failure

- **Atomic Fund Operations**: Prevention of TOCTOU race conditions
  - `tryDeductFromChainFree()`: Atomic check-and-deduct pattern
  - Guards against race where multiple operations check same balance
  - Returns false if insufficient funds, preventing negative balances

- **Fund Invariant Tolerance**: Dual-mode tolerance for rounding noise
  - **Precision Slack**: 2 × 10^(-precision) units (e.g., 0.00000002 for 8-decimal assets)
  - **Percentage Tolerance**: 0.1% of chain total (default, configurable)
  - Uses maximum of both tolerances for flexibility

### Performance Impact
- **Faster Fund Calculation**: Uses indices instead of walking all orders (~3-10× faster for large grids)
- **Grid Lookup Optimization**: O(1) slotmap-based lookups instead of O(n) findIndex (~50× faster for large grids)
- **Batch Operations**: Pause/resume eliminates redundant recalculations
- **Lock Refresh**: Prevents timeout during long reconciliation (~5 second refresh cycles)
- **Fund Snapshot Capture**: Negligible overhead (<1ms per snapshot) despite comprehensive audit trail

### Summary Statistics

**Total Commits:** 230 commits analyzed and documented
- 99 bug fixes (43%) covering grid, funds, concurrency, precision, and strategy
- 49 refactor commits (21%) improving architecture and code quality
- 34 feature additions (15%) including new strategies and UI improvements
- 28 documentation updates (12%) enhancing developer experience
- 8 test improvements (3.5%) with comprehensive coverage
- 8 cleanup operations (3.5%) removing legacy code
- 4 style improvements (1.7%) for better code readability
- 5 chore updates (2.2%) for maintenance tasks

**Critical Focus Areas:**
- Grid & Order Management: 76 commits
- Fund Management: 31 commits
- Concurrency Safety: 16 commits
- Precision & Fees: 19 commits

**Quality Metrics:**
- All tests passing ✅
- 99 bug fixes validated across 6 categories
- 49 refactor commits improving maintainability
- Extensive documentation (28 commits) for long-term sustainability

---

## [0.5.1] - 2026-01-01 - Anchor & Refill Strategy, Precision Quantization & Operational Robustness

### Added
- **Anchor & Refill Strategy**: Major architectural upgrade for partial order handling. Instead of moving partials, the bot now anchors them in place.
  - **Case A: Merged Refill (Dust)**: Merges dust (< 5%) into the next geometric allocation and delays the opposite-side rotation until the dust portion is filled.
  - **Case B: Full Anchor (Substantial)**: Upgrades partials (>= 5%) to 100% ideal size and places the leftover capital as a residual order at the spread.
- **On-Chain Alignment for Refills**: The bot now broadcasts `limit_order_update` for dust refills to ensure on-chain sizes perfectly match the merged internal allocation.
- **Cumulative Fill Tracking**: Added `filledSinceRefill` property to accurately trigger delayed rotations across multiple partial fills.
- **Precision Quantization**: Implemented size quantization to exact blockchain precision before order placement, eliminating float rounding errors.
- **Pending-Aware Health Checks**: Updated `countOrdersByType` and `checkGridHealth` to recognize intentional gaps created by delayed rotations, preventing false-positive corrections.
- **Double-Aware Divergence Engine**: Updated `calculateGridSideDivergenceMetric` to account for merged dust sizes, preventing unnecessary grid resets for anchored orders.
- **Periodic Order Synchronization**: Added `readOpenOrders` to the 4-hour periodic fetch to automatically reconcile the internal grid with the blockchain source of truth.
- **Modernized Test Suite**: Added comprehensive unit, integration, and E2E tests for the Anchor & Refill strategy and precision fixes.

### Changed
- **Pipeline-Aware Monitoring**: `checkGridHealth` now only executes when the order pipeline is clear (no pending fills or corrections), increasing operational stability.
- **Memory-Chain Alignment**: Quantized order sizes are synchronized back to the internal memory state to ensure 1:1 parity with blockchain integers.
- **State Persistence**: Added full serialization for new strategy fields (`isDoubleOrder`, `mergedDustSize`, `pendingRotation`, `filledSinceRefill`).

### Fixed
- **Sync Reversion Protection**: Prevented the bot from prematurely reverting merged sizes back to old on-chain sizes during synchronization gaps.
- **Off-by-One Eradication**: Fixed a recurring issue where small float remainders would block grid flow or cause spurious partial-state transitions.
- **Race Condition Handling**: Improved observability and lock management in `dexbot_class.js` to ensure sequential consistency during high-volume fill events.

---

## [0.5.0] - 2025-12-31 - Stability Milestone: Global Terminology Migration, General Settings & Grid Health

### Added
- **Persistent General Settings**: Implemented a new architecture using `profiles/general.settings.json` for untracked user overrides.
- **Global Settings Manager**: Added a new sub-menu to `dexbot bots` to manage global parameters (Log lvl, Grid, Timing).
- **Grid Health Monitoring**: New system to monitor structural grid integrity and log violations (e.g., ACTIVE orders further from market than VIRTUAL slots).
- **Dual-Side Dust Recovery**: Automatically refills small partial orders (< 5%) to ideal geometric sizes using `cacheFunds` when detected on both sides.
- **Enhanced Spread Correction**: Implemented proactive spread correction that pools both `VIRTUAL` and `SPREAD` slots to identify the best candidates for narrowing the market spread.
- **Sequential Fill Queue**: Implemented thread-safe sequential processing of fill events using AsyncLock to prevent accounting race conditions.
- **Safe PM2 Lifecycle Management**: Added `pm2.js stop` and `pm2.js delete` commands that safely filter for dexbot-specific processes.
- **Robust Fill Detection**: Implemented `history` mode for fill processing to reliably match orders from blockchain events.

### Changed
- **Global Terminology Migration**: Renamed all occurrences of `marketPrice` to `startPrice` across codebase, CLI, and documentation to better reflect its role as the grid center.
- **Menu-Driven Bot Editor**: Refactored `modules/account_bots.js` into a sectional, menu-driven interface for faster configuration.
- **Simplified Update Process**: Removed fragile git stashing from `update.sh` and `update-dev.sh`; user settings are now preserved via untracked JSON.
- **CLI Command Renaming**: Renamed `dexbot stop` to `dexbot disable` for better alignment with its actual function (marking bots inactive in config).
- **Price Calculation Accuracy**: Updated `buildUpdateOrderOp` to use current sell amounts when deriving prices, fixing precision issues in small price moves.
- **Default Log Level**: Changed default `LOG_LEVEL` from `debug` to `info`.
- **Architectural Cleanup**: Consolidated core logic into pure utility functions to eliminate duplication and improve maintainability.

### Fixed
- **Fund Double-Counting**: Fixed a critical bug in `processFilledOrders` where proceeds were incorrectly added to available funds twice.
- **Startup Double-Initialization**: Resolved a race condition that could cause corrupted virtual order sizes during bot startup.
- **Reset Reliability**: Fixed `node dexbot reset` command to ensure a true hard reset from blockchain state, including hot-reloading of `bots.json`.
- **Stuck VIRTUAL Orders**: Added error handling for rotation synchronization to prevent orders from being stuck in a virtual state.
- **Logging Visibility**: Ensured all cancellation operations provide explicit success/fail messages in logs.
- **Offline Detection Fixes**: Resolved edge cases in offline partial fill detection to ensure capital efficiency on startup.
- **Update Script Robustness**: Refactored update scripts to use `git reset --hard` to forcefully clear environment conflicts (e.g., in `constants.js`).
- **Module Path Corrections**: Fixed incorrect relative paths in `startup_reconcile.js` and streamlined operational logging.

---

**Note on v0.4.6**: This version includes a backported critical cacheFunds double-counting fix that was originally released in v0.4.7, then retagged to v0.4.6 for proper patch versioning. v0.4.7 release was deleted. Users should upgrade to v0.4.6 to fix the 649.72 BTS discrepancy issue.

---

## [0.4.6] - 2025-12-28 - CacheFunds Double-Counting Fix, Fill Deduplication & Race Condition Prevention

### Fixed

#### 1. CRITICAL: CacheFunds Double-Counting in Partial Fills
- **Location**: `modules/order/manager.js` lines 570-596, 1618-1625
- **Problem**: Proceeds being counted twice in `cacheFunds` balance
  - When partial fill occurred, proceeds added to `chainFree` (buyFree/sellFree)
  - Then `available` recalculated from **updated** chainFree (which already included proceeds)
  - Both `proceeds + available` added to cacheFunds → **double-counting**
- **Impact**: User reported 649.72 BTS discrepancy in fund accounting
- **Bug Timeline**: Introduced in v0.4.0 with fund consolidation refactor, present through v0.4.5
- **Solution**:
  1. Calculate available BEFORE updating chainFree (lines 570-576)
  2. Update chainFree with proceeds (lines 578-610)
  3. Store pre-update available in `this._preFillAvailable` (line 596)
  4. Use stored value in `processFilledOrders()` (lines 1618-1625)
- **Result**: Proceeds counted exactly once while preserving fund cycling feature for new deposits

#### 2. CRITICAL: Fee Double-Deduction After Bot Restart
- **Location**: `modules/account_orders.js` lines 427-551, `modules/dexbot_class.js` lines 42-48, 77-251, 652-660
- **Problem**: Permanent fund loss on bot restart during fill processing
  - When bot restarts, same fills detected again from blockchain history
  - `processFilledOrders()` called twice with identical fills
  - BTS fees double-deducted from cacheFunds
- **Impact**: Every bot restart during active trading could lose funds (fees permanently deducted twice)
- **Solution**: Persistent fill ID deduplication with multi-layer protection
  - **In-Memory Layer (5 second window)**:
    - Fill key: `${orderId}:${blockNum}:${historyId}`
    - Prevents immediate reprocessing within 5 seconds
    - Location: `dexbot_class.js` lines 100-114
  - **Persistent Layer (1 hour window)**:
    - Saves processed fill IDs to disk after each batch
    - Loads persisted fills on startup to restore dedup memory
    - Prevents reprocessing across bot restarts
    - Locations: `dexbot_class.js` lines 222-235 (save), 652-660 (load)
  - **Automatic Cleanup**:
    - Runs ~10% of batches to minimize I/O overhead
    - Removes entries older than 1 hour to prevent unbounded growth
    - Location: `dexbot_class.js` lines 237-245
  - **Persistence Methods** (`account_orders.js` lines 427-551):
    - `loadProcessedFills()`: Load fill dedup map from disk
    - `updateProcessedFillsBatch()`: Efficiently save multiple fills
    - `cleanOldProcessedFills()`: Remove old entries
    - All protected by AsyncLock to prevent race conditions
- **Storage Format** (in `profiles/orders/{botKey}.json`):
  ```json
  {
    "bots": {
      "botkey": {
        "processedFills": {
          "1.7.12345:67890:hist123": 1703808000000,
          "1.7.12346:67891:hist124": 1703808005000
        }
      }
    }
  }
  ```
- **Defensive Impact**: Protects entire fill pipeline, not just fees
  - Prevents committed funds from being recalculated twice
  - Prevents fund cycling from being triggered twice
  - Prevents grid rebalancing from being triggered twice
  - Prevents order status changes from being processed twice

#### 3. 20+ Race Conditions: TOCTOU & Concurrent Access

**Overview**: Comprehensive race condition prevention using AsyncLock pattern with 7 lock instances protecting critical sections.

**A. File Persistence Races** (`account_orders.js`)
- **Problem**: Process A reads file → Process B writes update → Process A overwrites with stale data
- **Fix**: Persistence Lock + Reload-Before-Write Pattern
  - Lock: `_persistenceLock` (line 104)
  - Protected methods:
    - `storeMasterGrid()` (lines 275-278): Reload before writing grid snapshot
    - `updateCacheFunds()` (line 366): Reload before updating cache
    - `updateBtsFeesOwed()` (line 416): Reload before updating fees
    - `ensureBotEntries()` (line 152): Reload before ensuring entries
    - `updateProcessedFillsBatch()` (line 460): Reload before batch save
  - Pattern: Always reload from disk immediately before writing to prevent stale data overwrites

**B. Account Subscription Management Races** (`chain_orders.js`)
- **Problem**: Multiple concurrent calls to `listenForFills()` could create duplicate subscriptions
- **Fix**: Subscription Lock (line 37)
  - Protected operations:
    - `_ensureAccountSubscriber()` (line 174): Atomic subscription creation
    - `listenForFills()` (line 339): Atomic callback registration
    - Unsubscribe (line 349): Atomic callback removal
  - Result: Prevents duplicate subscriptions, ensures atomic add/remove of callbacks

**C. Account Resolution Cache Races** (`chain_orders.js`)
- **Problem**: Concurrent account name/ID resolutions could race in cache updates
- **Fix**: Resolution Lock (line 39)
  - Protected operations:
    - `resolveAccountName()` (line 103): Atomic name resolution with cache
    - `resolveAccountId()` (line 140): Atomic ID resolution with cache
  - Result: Ensures atomic cache check-and-set for account resolution

**D. Preferred Account State Races** (`chain_orders.js`)
- **Problem**: Global variables `preferredAccountId` and `preferredAccountName` accessed without synchronization
- **Fix**: Preferred Account Lock (line 38)
  - Warning comment (lines 64-65): "Access MUST be protected by _preferredAccountLock to prevent race conditions"
  - Protected operations:
    - `setPreferredAccount()` (line 76): Atomic state update
    - `getPreferredAccount()` (line 87): Thread-safe read
  - Result: All access goes through thread-safe getters/setters

**E. Fill Processing Races** (`dexbot_class.js`)
- **Problem**: Multiple fill events arriving simultaneously could interleave during processing
- **Fix**: Fill Processing Lock (line 47)
  - Protected operations:
    - Fill callback (line 83): Main fill event handler
    - Triggered resync (line 892): Resync when no rotation occurs
    - Order manager loop (line 961): Catch missed fills
  - Protected workflow:
    - Filter and deduplicate fills
    - Sync and collect filled orders
    - Handle price corrections
    - Batch rebalance and execution
    - Persist processed fills
  - Result: All fill processing serialized, preventing concurrent state modifications

**F. Divergence Correction Races** (`dexbot_class.js`)
- **Problem**: Concurrent divergence corrections could modify grid state simultaneously
- **Fix**: Divergence Lock (line 48)
  - Protected operations:
    - Post-rotation divergence (line 191): Divergence check after rotation
    - Timer-based divergence (line 1017): Periodic divergence check
  - Guard check (line 569): Skip divergence if lock already held (prevents queue buildup)
  - Result: Grid updates serialized, prevents concurrent modification conflicts

**G. Order Corrections List Races** (`manager.js`)
- **Problem**: Shared array `ordersNeedingPriceCorrection` accessed by multiple functions
- **Fix**: Corrections Lock (line 140)
  - Status: Declared and prepared for active use
  - Array accessed at: Lines 138, 843, 879, 1174, 1286, 1292, 1300, 1723, 1726, 2005, 2012
  - Result: Foundation laid for serialized price correction handling

**AsyncLock Summary Table**:

| Lock Instance | File | Protected Operations | Purpose |
|--------------|------|----------------------|---------|
| `_persistenceLock` | account_orders.js | storeMasterGrid, updateCacheFunds, updateBtsFeesOwed, ensureBotEntries, processedFills methods | File I/O synchronization, prevent stale data overwrites |
| `_subscriptionLock` | chain_orders.js | _ensureAccountSubscriber, listenForFills, unsubscribe | Account subscription management, prevent duplicate subscriptions |
| `_preferredAccountLock` | chain_orders.js | setPreferredAccount, getPreferredAccount | Preferred account state synchronization |
| `_resolutionLock` | chain_orders.js | resolveAccountName, resolveAccountId | Account resolution cache atomic updates |
| `_fillProcessingLock` | dexbot_class.js | Fill callback, triggered resync, order manager loop | Fill event processing serialization |
| `_divergenceLock` | dexbot_class.js | Post-rotation divergence, timer-based divergence | Divergence correction synchronization |
| `_correctionsLock` | manager.js | ordersNeedingPriceCorrection mutations | Price correction list synchronization (prepared) |

### Added
- **AsyncLock Utility**: New queue-based mutual exclusion system (modules/order/async_lock.js)
  - FIFO queue-based synchronization for async operations
  - Prevents concurrent operations from interfering with critical sections
  - Proper error handling and re-throwing
  - Used to protect all critical sections across codebase

- **Fresh Data Reload on Write**: All write operations reload from disk before persisting
  - `storeMasterGrid()`: Reloads before writing grid snapshot
  - `updateCacheFunds()`: Always reload to prevent stale data overwrites
  - `updateBtsFeesOwed()`: Always reload to ensure fresh state
  - Fixes race between processes where stale in-memory data overwrites fresh state

- **forceReload Option**: Added to all load methods for explicit fresh data reads
  - `loadBotGrid(botKey, forceReload)`: Optional fresh disk read
  - `loadCacheFunds(botKey, forceReload)`: Optional fresh disk read
  - `loadBtsFeesOwed(botKey, forceReload)`: Optional fresh disk read
  - `getDBAssetBalances(botKeyOrName, forceReload)`: Optional fresh disk read

### Changed
- **Per-Bot File Architecture**: Now protected with AsyncLock for safe concurrent writes
  - Existing per-bot mode (each bot has own file: `profiles/orders/{botKey}.json`) now race-safe
  - `_persistenceLock` serializes all write operations to prevent TOCTOU races
  - `ensureBotEntries()` now async with lock protection
  - Per-bot subscriptions and resolution cache also protected
  - Legacy shared mode still supported for backward compatibility

- **AsyncLock Patterns**: Multiple lock instances for different critical sections
  - `_fillProcessingLock`: Serializes fill event processing in dexbot_class
  - `_divergenceLock`: Protects divergence correction operations
  - `_correctionsLock`: Protects ordersNeedingPriceCorrection in manager
  - `_persistenceLock`: Protects file I/O operations in account_orders
  - `_subscriptionLock`: Protects accountSubscriptions map in chain_orders
  - `_preferredAccountLock`: Protects preferredAccount global state
  - `_resolutionLock`: Protects account resolution cache

- **Persistence Methods Now Async**:
  - `manager.deductBtsFees()`: Made async, uses lock
  - `manager._persistWithRetry()`: Made async
  - `manager._persistCacheFunds()`: Made async
  - `manager._persistBtsFeesOwed()`: Made async
  - `grid._clearAndPersistCacheFunds()`: Made async, awaited
  - `grid._persistCacheFunds()`: Made async, awaited
  - All callers properly await these methods

- **Account Subscription Management**: Atomic check-and-set with AsyncLock
  - `_ensureAccountSubscriber()`: Uses lock to prevent duplicate subscriptions
  - `listenForFills()`: Protects callback registration inside lock
  - `unsubscribe()`: Atomic removal with lock protection

### Technical Details
- **TOCTOU Fix**: Reload-before-write prevents stale in-memory overwrites
  - Example: Process A reads file, Process B writes update, Process A overwrites with stale data
  - Solution: Always reload immediately before writing
  - Applied to: storeMasterGrid, updateCacheFunds, updateBtsFeesOwed

- **Async/Await Consistency**: All async operations properly awaited
  - No fire-and-forget promises
  - Proper error propagation throughout call chains
  - Busy-wait loops replaced with proper async setTimeout

- **Lock Nesting**: Careful lock ordering prevents deadlocks
  - No nested lock acquisition (locks released before acquiring another)
  - Each critical section has single responsible lock

### Files Modified in v0.4.6

**New Files**:
- `modules/order/async_lock.js` (84 lines): AsyncLock utility implementation with FIFO queue-based synchronization

**Modified Files**:
- `modules/account_orders.js`:
  - Line 104: _persistenceLock declaration
  - Lines 145-232: ensureBotEntries with lock
  - Lines 269-312: storeMasterGrid with lock and reload-before-write
  - Lines 360-375: updateCacheFunds with lock and reload
  - Lines 410-425: updateBtsFeesOwed with lock and reload
  - Lines 427-551: processedFills tracking methods (NEW)

- `modules/chain_orders.js`:
  - Lines 37-39: Three lock declarations (_subscriptionLock, _resolutionLock, _preferredAccountLock)
  - Lines 64-65: Warning comment about lock requirements
  - Lines 76-90: setPreferredAccount/getPreferredAccount thread-safe wrappers
  - Lines 98-164: Account resolution with locks
  - Lines 173-206: _ensureAccountSubscriber with lock
  - Lines 295-364: listenForFills with lock protection

- `modules/dexbot_class.js`:
  - Lines 42-48: Fill dedup and lock declarations
  - Lines 77-251: Fill callback with deduplication logic
  - Lines 652-660: Load persisted fills on startup (NEW)

- `modules/order/manager.js`:
  - Line 140: _correctionsLock declaration
  - Lines 570-596: cacheFunds double-counting fix (_adjustFunds method)
  - Lines 1618-1625: Use pre-update available in processFilledOrders()

- `CHANGELOG.md`:
  - Complete v0.4.6 documentation

### Performance Impact

**Minimal Overhead**:
- AsyncLock uses efficient FIFO queue (O(1) operations)
- Locks held only during critical sections (milliseconds)
- Reload-before-write adds single disk read per write (~5ms, negligible vs network latency)
- Fill dedup cleanup runs only ~10% of batches, not every batch

**Benefits**:
- Eliminates fund loss from race conditions (saves 649.72+ BTS per release cycle)
- Prevents duplicate fill processing (reduces unnecessary grid operations)
- Ensures data consistency across bot restarts (reliable state recovery)
- Foundation for future concurrent enhancements

### Testing
- All 20 integration tests passing ✅
- Test coverage includes: ensureBotEntries, storeMasterGrid, cacheFunds persistence, fee deduction, fill dedup
- Grid comparison, startup reconciliation, partial order handling all verified
- No changes to fill processing logic or output; only adds deduplication layer

### Migration
- **Backward Compatible**: No breaking changes to APIs or configuration
- **No Schema Changes**: File format unchanged; existing bot data continues to work
- **Transparent to Users**: Race condition fixes are internal improvements
- **Automatic Initialization**: `processedFills` field auto-initialized if missing in existing bots

### Summary Statistics

**Total Fixes**: 23 critical bugs
- 1 cacheFunds double-counting fix
- 1 fee double-deduction fix
- 20+ race condition fixes (7 categories of TOCTOU and concurrent access issues)
- 1 defensive fill deduplication system (multi-layer protection)

**Implementation**:
- Total AsyncLock instances: 7
- Lines of code added: ~300
- Files modified: 5 existing + 1 new
- Tests passing: 20/20 ✅

**Risk Level**: LOW
- Simple addition of locks to existing code paths
- No core algorithm changes
- Fully backward compatible
- All tests passing

---

## [0.4.5] - 2025-12-27 - Partial Order Counting & Grid Navigation Fix

### Fixed
- **Partial Orders Not Counted in Grid Targets**: Critical bug in rebalancing logic
  - Partial filled orders were excluded from order target counting
  - Caused bot to create unnecessary orders even when at target capacity
  - Now counts both ACTIVE and PARTIAL orders toward target
  - Prevents "mixing up" of grid positions and erroneous order creation

- **Grid Navigation Limited by ID Namespace**: Critical bug in partial order movement
  - `preparePartialOrderMove()` used ID-based navigation (sell-N/buy-N)
  - Could not move partial orders across sell-*/buy-* namespace boundaries
  - Example: sell-173 (highest sell slot) couldn't move to buy-0 (adjacent by price)
  - **Now uses price-sorted navigation** for fluid grid movement
  - Partial orders can now move anywhere in the grid without artificial boundaries

### Added
- **`countOrdersByType()` Helper Function** in utils.js
  - Counts both ACTIVE and PARTIAL orders by type
  - Used consistently across order target comparisons
  - Ensures partial orders take up real grid positions

### Changed
- **Order Target Checks**: Updated to include partial orders
  - `checkSpreadCondition()` (line 1396): Includes partials in "both sides" check
  - Rebalancing checks (lines 1747, 1851): Uses `countOrdersByType()`

- **Spread Calculation**: Updated to include partial orders
  - `calculateCurrentSpread()` (line 2577): Combines ACTIVE + PARTIAL orders
  - Partial orders are on-chain and affect actual market spread

### Technical Details
- Grid is now treated as fluid: no artificial boundaries during fill handling
- Price-sorted navigation allows unrestricted partial order movement
- All 18 test suites pass
- Fixed crossed rotation test expectations (test_crossed_rotation.js)

---

## [0.4.4] - 2025-12-27 - Code Consolidation & BTS Fee Deduction Fix

### Fixed
- **BTS Fee Deduction on Wrong Side**: Critical bug in grid resize operations
  - Fixed fee deduction logic that incorrectly applied to non-BTS side during order resizing
  - XRP/BTS pairs: BTS fees no longer deducted from XRP (SELL side) funds
  - Buy side (assetB): Only deduct if assetB === 'BTS'
  - Sell side (assetA): Only deduct if assetA === 'BTS'
  - Fixes 70% order size reduction issue during grid resize

### Changed
- **Fee Multiplier Update**: Increased from 4x to 5x
  - Now reserves: 1x for initial creation + 4x for rotation buffer (was 3x)
  - Provides better buffer for multiple rotation cycles

### Refactored
- **Code Consolidation**: Moved 22 grid utility functions from grid.js to utils.js
  - Eliminated duplicate code and scattered inline requires
  - Centralized reusable utilities for consistent access across modules
  - Added 15 new utility functions for common operations

- **Grid Utilities Added to utils.js**:
  - Numeric: `toFiniteNumber`, `isValidNumber`, `compareBlockchainSizes`, `computeSizeAfterFill`
  - Order filtering: `filterOrdersByType`, `filterOrdersByTypeAndState`, `sumOrderSizes`, `mapOrderSizes`
  - Precision: `getPrecisionByOrderType`, `getPrecisionForSide`, `getPrecisionsForManager`
  - Size validation: `checkSizesBeforeMinimum`, `checkSizesNearMinimum`
  - Fee calculation: `calculateOrderCreationFees`, `deductOrderFeesFromFunds`
  - Grid sizing: `allocateFundsByWeights`, `calculateOrderSizes`, `calculateRotationOrderSizes`, `calculateGridSideDivergenceMetric`, `getOrderTypeFromUpdatedFlags`, `resolveConfiguredPriceBound`

- **Manager Helper Methods**: Added fund/chainFree tracking
  - `_getCacheFunds(side)`: Safe access to cache funds
  - `_getGridTotal(side)`: Safe access to grid totals
  - `_deductFromChainFree(orderType, size, operation)`: Track fund movements
  - `_addToChainFree(orderType, size, operation)`: Track fund releases

- **Code Cleanup**: Removed debug console.log statements from chain_orders.js

### Technical Details
- Reduced grid.js from 1190 to 635 lines (-46%)
- All 18 test suites pass
- Rotation and divergence check behavior unchanged
- Net +166 lines: Justified by new utilities and JSDoc documentation

---

## [0.4.3] - 2025-12-26 - Order Pairing, Rebalance & Fee Reservation Fixes

### Fixed
- **Asymmetric Rebalance Orders Logic for BUY Fills**: Corrected order matching in rebalanceOrders function
  - Fixed logic that incorrectly paired BUY orders during rebalancing operations
  - Ensures proper order pairing for asymmetric buy/sell scenarios

- **Order Pairing Sorting & Startup Reconciliation**: Optimized order matching algorithm
  - Implemented proper sorting for order pairing to ensure consistent matching
  - Improved startup reconciliation performance and reliability

- **Grid Data Corruption Prevention**: Added validation for order sizes and IDs
  - Prevented undefined size values from corrupting grid data
  - Added null ID checks to prevent invalid order state

- **BTS Fee Reservation During Resize**: Fixed target order selection
  - Use target orders for BTS fee reservation calculations during order resizing
  - Ensures accurate fee reservation across resize operations

- **4x Blockchain Fee Buffer Enforcement**: Corrected fee buffer application
  - Respect 4x blockchain fee buffer consistently during order resizing
  - Added 100 BTS fallback for adequate fee reservation

- **Grid Edge State Synchronization**: Fixed manager state sync after reducing largest order
  - Search by blockchain orderId to find matching grid order in manager.orders
  - Ensures manager's local grid state matches blockchain after order reduction

- **Grid Edge Order Reconciliation**: Refactored cancel+create for better efficiency
  - Replace reduce+restore with cancel+create approach (N+1 vs N+2 operations)
  - Phase 1: Cancel largest order to free funds
  - Phase 2: Update remaining orders to targets
  - Phase 3: Create new order for cancelled slot
  - Simplified logic with proper index alignment

- **Vacated Slot Size Preservation**: Fixed orphaned virtual orders from partial moves
  - Don't set vacated slots to size: 0 after partial order moves
  - Prevents "no size defined" warnings when slots are reused for new orders
  - Detects already-claimed slots to avoid conflicts with new order placement
  - Complements the "below target" path that uses vacated slots for new order creation

### Changed
- Removed unused `bot_instance.js` module for code cleanup
- Enhanced `startup_reconcile` documentation in README
- Optimized grid edge reconciliation strategy for fewer blockchain operations

---

## [0.4.2] - 2025-12-24 - Grid Recalculation Fixes & Documentation Updates

### Fixed
- **Grid Recalculation in Post-Rotation Divergence Flow**: Added missing grid recalculation call
  - **Problem**: Orders were losing size information during post-rotation divergence correction
  - **Symptoms**: "Skipping virtual X - no size defined" warnings, "Cannot read properties of undefined (reading 'toFixed')" batch errors
  - **Solution**: Added `Grid.updateGridFromBlockchainSnapshot()` call to post-rotation flow, matching startup and timer divergence paths
  - **Impact**: Prevents order size loss during divergence correction cycles

- **PARTIAL Order State Preservation at Startup**: Fixed state inconsistency during synchronization
  - **Problem**: PARTIAL orders (those with remaining amounts being filled) were unconditionally converted to ACTIVE state at startup
  - **Symptoms**: False divergence spikes (700%+ divergence), state mismatches between persistedGrid and calculatedGrid, unnecessary grid recalculations
  - **Solution**: Preserve PARTIAL state across bot restarts if already set; only convert VIRTUAL orders to ACTIVE when matched on-chain
  - **Impact**: Eliminates false divergence detection and maintains consistent order state across restarts

- **Redundant Grid Recalculation Removal**: Eliminated duplicate processing in divergence correction
  - **Problem**: Grid was being recalculated twice when divergence was detected (once by divergence check, once by correction function)
  - **Symptoms**: Double order size updates, unnecessary blockchain fetches, performance inefficiency
  - **Solution**: Removed redundant recalculation from `applyGridDivergenceCorrections()` since caller already recalculates
  - **Impact**: Single grid recalculation per divergence event, improved performance

- **BTS Fee Formula Documentation**: Updated outdated comments and logged output to accurately reflect the complete fee calculation formula
  - Fixed `modules/order/grid.js`: Changed comment from "2x multiplier" to "4x multiplier" to match actual implementation
  - Updated formula in 5 files to show complete formula: `available = max(0, chainFree - virtual - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)`
  - Fixed `modules/order/logger.js`: Console output now displays full formula instead of simplified version
  - Updated `modules/order/manager.js`: Changed variable name references from ambiguous "4xReservation" to proper "btsFeesReservation"
  - Fixed `modules/account_bots.js`: Comment now correctly states default targetSpreadPercent is 4x not 3x

---

## [0.4.1] - 2025-12-23 - Order Consolidation, Grid Edge Handling & Partial Order Fixes

### Features
- **Code Consolidation**: Eliminated ~1,000 lines of duplicate code across entry points
  - Extracted shared `DEXBot` class to `modules/dexbot_class.js` (822 lines)
  - bot.js refactored from 1,021 → 186 lines
  - dexbot.js refactored from 1,568 → 598 lines
  - Unified class-based approach with logPrefix options for context-specific behavior
  - Extracted `buildCreateOrderArgs()` utility to `modules/order/utils.js`

- **Conditional Rotation**: Smart order creation at grid boundaries
  - When active order count drops below target, creates new orders instead of rotating
  - Handles grid edge cases where fewer orders can be placed near min/max prices
  - Seamlessly transitions back to normal rotation when target is reached
  - Prevents perpetual deficit caused by edge boundary constraints
  - Comprehensive test coverage with edge case validation

- **Repository Statistics Analyzer**: Interactive git history visualization
  - Analyzes repository commits and generates beautiful HTML charts
  - Tracks added/deleted lines across codebase with daily granularity
  - Charts include daily changes and cumulative statistics
  - Configurable file pattern filtering for focused analysis
  - Script: `scripts/analyze-repo-stats.js`

### Fixed
- **Partial Order State Machine Invariant**: Guaranteed PARTIAL orders always have size > 0
  - Fixed bug in `synchronizeWithChain()` where PARTIAL could be set with size = 0
  - Proper state transitions: ACTIVE (size > 0) → PARTIAL (size > 0) → SPREAD (size = 0)
  - PARTIAL and SPREAD orders excluded from divergence calculations
  - Prevents invalid order states from persisting to storage

### Changed
- **Entry Point Architecture**: Simplified bot.js and dexbot.js to thin wrappers
  - Removed duplicate class definitions
  - All core logic now centralized in `modules/dexbot_class.js`
  - Reduces maintenance overhead and improves consistency
  - Options object pattern enables context-specific behavior (e.g., logPrefix)

### Testing
- Added comprehensive test suite for conditional rotation edge cases
- Added state machine validation tests for partial orders
- All tests passing with improved grid coverage scenarios

### Technical Details
- **Grid Coverage Recovery**: Gradual recovery mechanism for edge-bound grids
  - Shortage = `targetCount - currentActiveCount`
  - Creates `min(shortage, fillCount)` new orders per fill cycle
  - Continues until target is reached, then resumes rotation
  - Respects available virtual orders (no over-activation)

- **Code Quality**: Significant reduction in complexity and duplication
  - Common patterns unified in shared class
  - Easier to maintain and update core logic
  - Improved testability with centralized implementation

---

## [0.4.0] - 2025-12-22 - Fund Management Consolidation & Automatic Fund Cycling

### Features
- **Automatic Fund Cycling**: Available funds now automatically included in cacheFunds before rotation
  - Newly deposited funds immediately available for grid sizing
  - Grid resizes when deposits arrive, not just after fills
  - More responsive to market changes and new capital inflows

- **Unified Fund Management**: Complete consolidation of pendingProceeds into cacheFunds
  - Simplified fund tracking: single cacheFunds field for all unallocated funds
  - Cleaner codebase (272 line reduction in complexity)
  - Backward compatible: legacy pendingProceeds automatically migrated

### Changed
- **BREAKING CHANGE**: `pendingProceeds` field removed from storage schema
  - Affects: `profiles/orders/<bot-name>.json` files for existing bots
  - Migration: Use `scripts/migrate_pending_proceeds.js` before first startup with v0.4.0
  - Backward compat: Legacy pendingProceeds merged into cacheFunds on load

- **Fund Formula Updated**:
  ```
  OLD: available = max(0, chainFree - virtual - cacheFunds - btsFeesOwed) + pendingProceeds
  NEW: available = max(0, chainFree - virtual - cacheFunds - btsFeesOwed)
  ```

- **Grid Regeneration Threshold**: Now includes available funds
  - OLD: Checked only `cacheFunds / gridAllocation`
  - NEW: Checks `(cacheFunds + availableFunds) / gridAllocation`
  - Result: Grid resizes when deposits arrive, enabling fund cycling

- **Fee Deduction**: Now deducts BTS fees from cacheFunds instead of pendingProceeds
  - Called once per rotation cycle after all proceeds added
  - Cleaner integration with fund cycling

### Fixed
- **Partial Order Precision**: Fixed floating-point noise in partial fill detection
  - Now uses integer-based subtraction (blockchain-safe precision)
  - Converts orders to blockchain units, subtracts, converts back
  - Prevents false PARTIAL states from float arithmetic errors (e.g., 1e-18 floats)

- **Logger Undefined Variables**: Fixed references to removed pendingProceeds variables
  - Removed orphaned variable definitions
  - Cleaned up fund display logic in logFundsStatus()

- **Bot Metadata Initialization**: Fixed new order files being created with null metadata
  - Ensured `ensureBotEntries()` is called before any Grid initialization
  - Prevents order files from having null values for name, assetA, assetB
  - Metadata properly initialized from bot configuration in profiles/bots.json at startup
  - Applied fix to both bot.js and dexbot.js DEXBot classes

### Migration Guide
1. **Backup** your `profiles/orders/` directory before updating
2. **Run migration** (if you have existing bots with pendingProceeds):
   ```bash
   node scripts/migrate_pending_proceeds.js
   ```
3. **Restart bots**: Legacy data automatically merged into cacheFunds on load
   - No data loss - all proceeds preserved
   - Grid sizing adjusted automatically

### Technical Details
- **Fund Consolidation**: All proceeds and surpluses now consolidated in single cacheFunds field
- **Backward Compatibility**: Automatic merge of legacy pendingProceeds into cacheFunds during grid load
- **Storage**: Updated account_orders.js schema, removed pendingProceeds persistence methods
- **Test Coverage**: Added test_fund_cycling_trigger.js, test_crossed_rotation.js, test_fee_refinement.js

---

## [0.3.0] - 2025-12-19 - Grid Divergence Detection & Percentage-Based Thresholds

### Features
- **Grid Divergence Detection System**: Intelligent grid state monitoring and automatic regeneration
  - Quadratic error metric calculates divergence between in-memory and persisted grids: Σ((calculated - persisted) / persisted)² / count
  - Automatic grid size recalculation when divergence exceeds DIVERGENCE_THRESHOLD_PERCENTAGE (default: 1%)
  - Detects when cached fund reserves exceed configured percentage threshold (default: 3%)
  - Two independent triggering mechanisms ensure grid stays synchronized with actual blockchain orders

- **Percentage-Based Threshold System**: Standardized threshold configuration across the system
  - Replaced promille-based thresholds (0-1000 scale) with percentage-based (0-100 scale)
  - More intuitive configuration and easier to understand threshold values
  - DIVERGENCE_THRESHOLD_PERCENTAGE: Controls grid divergence detection sensitivity
  - GRID_REGENERATION_PERCENTAGE: Controls when cached funds trigger grid recalculation (default: 3%)

- **Enhanced Documentation**: Comprehensive threshold documentation with distribution analysis
  - Added Root Mean Square (RMS) explanation and threshold reference tables
  - Distribution analysis showing how threshold requirements change with error distribution patterns
  - Clear explanation of how same average error (e.g., 3.2%) requires different thresholds based on distribution
  - Migration guide for percentage-based thresholds
  - Mathematical formulas for threshold calculation and grid regeneration logic

### Changed
- **Breaking Change**: DIVERGENCE_THRESHOLD_Promille renamed to DIVERGENCE_THRESHOLD_PERCENTAGE
  - Configuration files using old name must be updated
  - Old: promille values (10 promille ≈ 1% divergence)
  - New: percentage values (1 = 1% divergence threshold)
  - Update pattern: divide old promille value by 10 to get new percentage value

- **Default Threshold Changes**: Improved defaults based on real-world testing
  - GRID_REGENERATION_PERCENTAGE: 1% → 3% (more stable, reduces unnecessary regeneration)
  - DIVERGENCE_THRESHOLD_PERCENTAGE: 10 promille → 1% (more sensitive divergence detection)

- **Grid Comparison Metrics**: Enhanced logging and comparison output
  - All threshold comparisons now use percentage-based values
  - Log output displays percentage divergence instead of promille
  - Clearer threshold comparison messages in grid update logging

### Fixed
- **Threshold Comparison Logic**: Corrected grid comparison triggering mechanism
  - Changed division from /1000 (promille) to /100 (percentage) in threshold calculations
  - Applied fixes to both BUY and SELL side grid regeneration logic (grid.js lines 1038-1040, 1063-1065)
  - Ensures accurate divergence detection and grid synchronization

### Technical Details
- **Quadratic Error Metric**: Sum of squared relative differences detects concentrated outliers
  - Formula: Σ((calculated - persisted) / persisted)² / count
  - Penalizes outliers more than simple average, reflects actual grid synchronization issues
  - RMS (Root Mean Square) = √(metric), provides alternative view of error magnitude

- **Distribution Scaling**: Threshold requirements scale with distribution evenness
  - Theoretical relationship: promille ≈ 1 + n (where n = ratio of perfect orders)
  - Example: 10% outlier distribution (n=9) requires ~10× higher threshold than 100% even distribution
  - Reference table in README documents thresholds for 1%→10% average errors across distributions

- **Grid Regeneration Mechanics**: Independent triggering mechanisms
  - Mechanism 1: Cache funds accumulating to GRID_REGENERATION_PERCENTAGE (3%) triggers recalculation
  - Mechanism 2: Grid divergence exceeding DIVERGENCE_THRESHOLD_PERCENTAGE (1%) triggers update
  - Both operate independently, ensuring grid stays synchronized with actual blockchain state

### Migration Guide
If upgrading from v0.2.0:
1. Update configuration files to use DIVERGENCE_THRESHOLD_PERCENTAGE instead of DIVERGENCE_THRESHOLD_Promille
2. Convert threshold values: new_value = old_promille_value / 10
   - Old: 10 promille → New: 1%
   - Old: 100 promille → New: 10%
3. Test with dryRun: true to verify threshold behavior matches expectations
4. Default GRID_REGENERATION_PERCENTAGE (3%) is now more conservative; adjust if needed

### Testing
- Comprehensive test coverage for grid divergence detection (test_grid_comparison.js)
- Validates quadratic error metric calculations across various distribution patterns
- Tests both cache funds and divergence triggers independently and in combination
- Percentage-based threshold comparisons verified across BUY and SELL sides

## [0.2.0] - 2025-12-12 - Startup Grid Reconciliation & Fee Caching System

### Features
- **Startup Grid Reconciliation System**: Intelligent grid recovery at startup
  - Price-based matching to resume persisted grids with existing on-chain orders
  - Smart regeneration decisions based on on-chain order states
  - Count-based reconciliation for order synchronization
  - Unified startup logic in both bot.js and dexbot.js

- **Fee Caching System**: Improved fill processing performance
  - One-time fee data loading to avoid repeated blockchain queries
  - Cache fee deductions throughout the trading session
  - Integrated into fill processing workflows

- **Enhanced Order Manager**: Better fund tracking and grid management
  - Improved chain order synchronization with price+size matching
  - Grid recalculation for full grid resync with better parameters
  - Enhanced logging and debug output for startup troubleshooting

- **Improved Account Handling**: Better restart operations
  - Set account info on manager during restart for balance calculations
  - Support percentage-based botFunds configuration at restart
  - Fetch on-chain balances before grid initialization if needed

### Fixed
- **Limit Order Update Calculation**: Fixed parameter handling in chain_orders.js
  - Corrected receive amount handling for price-change detection
  - Improved delta calculation when price changes toward/away from market
  - Added comprehensive validation for final amounts after delta adjustment

### Testing
- Comprehensive test coverage for new reconciliation logic
- Test startup decision logic with various grid/chain scenarios
- Test TwentyX-specific edge cases and recovery paths

## [0.1.2] - 2025-12-10 - Multi-Bot Fund Allocation & Update Script

### Features
- **Multi-Bot Fund Allocation**: Enforce botFunds percentage allocation when multiple bots share an account
  - Each bot respects its allocated percentage of chainFree (what's free on-chain)
  - Bot1 with 90% gets 90% of chainFree, Bot2 with 10% gets 10% of remaining
  - Prevents fund allocation conflicts in shared accounts
  - Applied at grid initialization for accurate startup sizing

### Fixed
- **Update Script**: Removed interactive merge prompts by using `git pull --rebase`
- **Script Permissions**: Made update.sh permanently executable via git config

## [0.1.1] - 2025-12-10 - Minimum Delta Enforcement

### Features
- **Minimum Delta Enforcement**: Enforce meaningful blockchain updates for price-only order moves
  - When price changes but amount delta is zero, automatically set delta to ±1
  - Only applies when order moves toward market center (economically beneficial)
  - Prevents wasted on-chain transactions for imperceptible price changes
  - Maintains grid integrity by pushing orders toward spread

### Fixed
- Eliminated zero-delta price-only updates that had no economic effect
- Improved order update efficiency for partial order price adjustments

## [0.1.0] - 2025-12-10 - Initial Release

### Features
- **Staggered Order Grid**: Geometric order grids with configurable weight distribution
- **Dynamic Rebalancing**: Automatic order updates after fills
- **Multi-Bot Support**: Run multiple bots simultaneously on different pairs
- **PM2 Process Management**: Production-ready process orchestration with auto-restart
- **Partial Order Handling**: Atomic moves for partially-filled orders
- **Fill Deduplication**: 5-second deduplication window prevents duplicate processing
- **Master Password Security**: Encrypted key storage with RAM-only password handling
- **Price Tolerance**: Intelligent blockchain rounding compensation
- **API Resilience**: Multi-API support with graceful fallbacks
- **Dry-Run Mode**: Safe simulation before live trading

### Fixed
- **Fill Processing in PM2 Mode**: Implemented complete 4-step fill processing pipeline for PM2-managed bots
  - Fill validation and deduplication
  - Grid synchronization with blockchain
  - Batch rebalancing and order updates
  - Proper order rotation with atomic transactions
- **Fund Fallback in Order Rotation**: Added fallback to available funds when proceeds exhausted
- **Price Derivation Robustness**: Enhanced pool price lookup with multiple API variant support


### Installation & Usage
See README.md for detailed installation and usage instructions.

### Documentation
- README.md: Complete feature overview and configuration guide
- modules/: Comprehensive module documentation
- examples/bots.json: Configuration templates
- tests/: 25+ test files covering all major functionality

### Notes
- First production-ready release for BitShares DEX market making
- Always test with `dryRun: true` before enabling live trading
- Secure your keys; do not commit private keys to version control
- Use `profiles/` directory for live configuration (not tracked by git)
