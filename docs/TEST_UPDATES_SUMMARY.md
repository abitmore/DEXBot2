# Test Suite Updates - Based on Recent Bugfixes

This document summarizes the comprehensive test suite updates added based on the last 10 bugfixes (commits from 2026-01-09).

## Overview
Added two new test files to detect and prevent regressions from critical bugfixes:
- `tests/unit/strategy.test.js` - Strategy engine rebalancing and placement logic
- Enhanced `tests/unit/accounting.test.js` - Fund tracking and fee accounting

## Bugs Detected and Tests Added

### 1. VIRTUAL Order Placement Capping Bug (b913661)
**Problem**: VIRTUAL orders couldn't activate because their sizes were capped by availablePool, preventing activation of orders with pre-allocated capital.

**Tests Added** (strategy.test.js):
- ✅ `should activate VIRTUAL orders at full allocated size regardless of availablePool`
- ✅ `should only cap size INCREASE, not full order size for VIRTUAL orders`

**What These Tests Catch**:
- Ensures VIRTUAL orders can activate even when availablePool=0
- Verifies only new capital consumption is capped, not pre-allocated amounts

---

### 2. PARTIAL Order Update Bug (b913661)
**Problem**: Non-dust PARTIAL orders weren't being updated, preventing rebalancing when opposite side filled.

**Tests Added** (strategy.test.js):
- ✅ `should update dust PARTIAL orders to target size`
- ✅ `should update non-dust PARTIAL orders for grid rebalancing`

**What These Tests Catch**:
- Detects when PARTIAL orders don't receive update operations
- Verifies both dust and non-dust PARTIALs are handled correctly

---

### 3. Grid Divergence & Stale Cache (c02b66d)
**Problem**: Stale in-memory cache causing false divergence detections during grid comparisons.

**Tests Added** (strategy.test.js):
- ✅ `should detect divergence when grid is reloaded`
- ✅ `should maintain consistent grid state after persistence reload`

**What These Tests Catch**:
- Ensures fresh data is used for divergence checks
- Prevents false positives from stale cache

---

### 4. BoundaryIdx Persistence & Recovery (d17ece6)
**Problem**: Boundary index not persisting across restarts, causing grid misalignment.

**Tests Added** (strategy.test.js):
- ✅ `should initialize boundaryIdx from startPrice on first run`
- ✅ `should recover boundaryIdx from existing BUY orders`
- ✅ `should persist boundaryIdx across rebalance operations`

**What These Tests Catch**:
- Verifies boundary index is properly initialized and recovered
- Ensures grid zones maintain proper BUY/SELL separation

---

### 5. BUY Side Geometric Weighting - Reverse Parameter (d17ece6)
**Problem**: Wrong reverse parameter for BUY side weighting, causing incorrect capital distribution.

**Tests Added** (strategy.test.js):
- ✅ `should use correct reverse parameter for BUY side weighting`
- ✅ `should concentrate BUY capital near market price`

**What These Tests Catch**:
- Ensures BUY orders get maximum weight at market-closest positions
- Verifies geometric weighting follows expected distribution

---

### 6. CacheFunds Integration (32d81ea)
**Problem**: Bootstrap flag and cacheFunds integration not tracking spread correction properly.

**Tests Added** (strategy.test.js):
- ✅ `should deduct from cacheFunds after new placements`
- ✅ `should not deduct cacheFunds for updates and rotations`

**What These Tests Catch**:
- Verifies cacheFunds tracking is correct
- Prevents double-deduction for rotations

---

### 7. Rotation Completion (265772d)
**Problem**: Rotations being skipped instead of completing after divergence checks.

**Tests Added** (strategy.test.js):
- ✅ `should complete rotations without skipping`
- ✅ `should not skip rotations when divergence check succeeds`

**What These Tests Catch**:
- Ensures rotations are always executed
- Prevents grid gaps from incomplete rotations

---

### 8. Fee Calculation with isMaker Parameter (d17ece6)
**Problem**: Missing isMaker parameter in getAssetFees calls causing crashes.

**Tests Added** (strategy.test.js):
- ✅ `should correctly process fills with isMaker parameter`
- ✅ `should account for both maker and taker fees in fill processing`

**What These Tests Catch**:
- Ensures isMaker parameter is properly handled
- Detects fee calculation crashes

---

### 9. Market & Blockchain Taker Fees (7b0a5c5)
**Problem**: Not accounting for both market and blockchain taker fees in fill processing.

**Tests Added** (accounting.test.js):
- ✅ `should account for market taker fees in SELL order proceeds`
- ✅ `should account for blockchain taker fees in fill processing`
- ✅ `should correctly calculate net proceeds with both fee types`

**What These Tests Catch**:
- Verifies both fee types are deducted
- Prevents fund leaks from fee miscalculation

---

### 10. Fund Precision & Delta Validation (0a3d24d)
**Problem**: Precision loss and delta validation issues in fund calculations.

**Tests Added** (accounting.test.js):
- ✅ `should maintain precision when adding multiple orders`
- ✅ `should detect fund delta mismatches`
- ✅ `should validate fund totals after state transitions`

**What These Tests Catch**:
- Detects floating-point precision errors
- Verifies fund invariants are maintained
- Catches lost or phantom funds

---

## Running the Tests

```bash
# Run all strategy tests
npm test -- tests/unit/strategy.test.js

# Run accounting tests (with fee enhancements)
npm test -- tests/unit/accounting.test.js

# Run all unit tests
npm test -- tests/unit/
```

## Test Coverage Summary

| Category | Test Count | Coverage |
|----------|------------|----------|
| Placement Capping | 2 | VIRTUAL order activation |
| PARTIAL Handling | 2 | Dust & non-dust updates |
| Grid Divergence | 2 | Cache & reload logic |
| BoundaryIdx | 3 | Init, recovery, persistence |
| BUY Weighting | 2 | Reverse parameter & distribution |
| CacheFunds | 2 | Deduction tracking |
| Rotations | 2 | Completion & divergence |
| Fees (isMaker) | 2 | Parameter handling |
| Taker Fees | 3 | Market & blockchain fees |
| Fund Precision | 3 | Precision & delta validation |
| **Total** | **23** | **All critical bugfixes** |

## Key Assertions

These tests use critical assertions to catch regressions:

1. **Size Assertions**: Verify order sizes are correct (no capping, no loss)
2. **State Assertions**: Confirm order states transition properly (VIRTUAL→ACTIVE→PARTIAL)
3. **Fund Invariants**: Ensure total funds = virtual + committed (no leaks)
4. **Index Assertions**: Validate boundaryIdx consistency across operations
5. **Fee Assertions**: Confirm both fee types are accounted for

## Running Tests in CI/CD

These tests are integrated with the existing test suite:

```bash
# Full test run (includes new tests)
npm test

# Jest-specific run
npx jest tests/unit/ --no-coverage
```

## Notes for Developers

- Tests use `manager.pauseFundRecalc()` / `resumeFundRecalc()` for batch operations
- Fee cache is mocked where necessary to avoid external dependencies
- All tests are async-safe and handle rebalance promises correctly
- Tests clean up state in `beforeEach()` to ensure isolation

---

## Fill Batching & Recovery Regression Tests (Feb 7-8, 2026)

### Overview

Test file `tests/test_fill_batch_invariants.js` validates fixes for the Feb 7 market crash post-mortem analysis. These tests ensure fill batching, recovery retry system, and orphan-fill deduplication remain robust.

### Test Coverage

**Fill Batching & Recovery Retries**:

| Test | File | Purpose |
|------|------|---------|
| `test_adaptive_batch_pipeline` | `test_fill_batch_invariants.js` | Verifies fills processed in adaptive batches (1-4 per broadcast) instead of one-at-a-time |
| `test_recovery_retry_mechanism` | `test_fill_batch_invariants.js` | Validates count+time-based retry system with periodic reset (max 5 attempts, 60s interval) |
| `test_orphan_fill_deduplication` | `test_fill_batch_invariants.js` | Ensures stale-cleaned order IDs prevent double-crediting of fills |

**Cache & Stale-Order Handling**:

| Test | File | Purpose |
|------|------|---------|
| `test_cache_remainder_parity` | `test_fill_batch_invariants.js` | Verifies cache remainder calculated from actual allocated sizes (not ideal sizes) during capped grid resizes |
| `test_abort_cooldown_arming` | `test_fill_batch_invariants.js` | Ensures both primary and retry hard-abort paths arm `_maintenanceCooldownCycles` |
| `test_single_stale_cancel_fast_path` | `test_fill_batch_invariants.js` | Validates single-op batch stale recovery doesn't trigger expensive full sync |

### Running Tests

```bash
# Run fill batching invariant tests
npm test -- tests/test_fill_batch_invariants.js

# Or directly
node tests/test_fill_batch_invariants.js
```

### Test Details

#### Test 1: Adaptive Batch Pipeline

**Scenario**: Simulate 29 fills arriving over 90 seconds of market crash

**Validation**:
- ✅ Queue depth measured correctly (uses BATCH_STRESS_TIERS)
- ✅ Batches are sized adaptively (1-4 fills per broadcast)
- ✅ All fills processed in ~8 broadcasts instead of 29
- ✅ Processing time reduced from ~90s to ~24s
- ✅ Single rebalance call per batch (not per-fill)
- ✅ Cache funds credited once per batch

**Configuration Tested**:
```javascript
BATCH_STRESS_TIERS: [[0,1], [3,2], [8,3], [15,4]]
MAX_FILL_BATCH_SIZE: 4
```

#### Test 2: Recovery Retry Mechanism

**Scenario**: Recovery fails once, should retry automatically

**Validation**:
- ✅ First recovery attempt fails, recorded in state
- ✅ Retry counter increments (1/5)
- ✅ Retry blocked before 60s interval elapses
- ✅ After 60s, retry succeeds
- ✅ State reset on success (count=0, time=0)
- ✅ Periodic sync also triggers state reset

**Configuration Tested**:
```javascript
RECOVERY_RETRY_INTERVAL_MS: 60000  // 60 second minimum
MAX_RECOVERY_ATTEMPTS: 5            // Max 5 retries
```

#### Test 3: Orphan-Fill Deduplication

**Scenario**: Batch fails (stale order), cleanup recorded, orphan fill arrives later

**Validation**:
- ✅ Stale order ID recorded with timestamp when batch fails
- ✅ Orphan fill event arrives for same order ID
- ✅ Guard check (`_staleCleanedOrderIds.has(orderId)`) returns true
- ✅ Proceeds NOT credited (double-credit prevented)
- ✅ Log shows `[ORPHAN-FILL] Skipping double-credit`
- ✅ TTL pruning removes entries after 5 minutes

#### Test 4: Cache Remainder Parity

**Scenario**: Grid resize capped by available funds

**Validation**:
- ✅ Ideal grid total: 1000 BTS
- ✅ Available funds: 600 BTS
- ✅ Allocated: 600 BTS (track per-slot applied sizes)
- ✅ Cache remainder: 400 BTS (1000 - 600, not inflated)
- ✅ Next cycle gets correct 400 BTS available for allocation
- ✅ No "stuck fund" situations

#### Test 5: Hard-Abort Cooldown Arming

**Scenario**: Batch execution fails with illegal state or accounting error

**Validation**:
- ✅ Primary hard-abort path arms cooldown (50 cycles)
- ✅ Retry hard-abort path also arms cooldown
- ✅ Maintenance doesn't run immediately after abort
- ✅ Next maintenance cycle respects cooldown
- ✅ Log shows `[COOLDOWN] Arming maintenance cooldown after hard-abort`

#### Test 6: Single-Op Stale-Cancel Fast-Path

**Scenario**: Single order in batch becomes stale on-chain

**Validation**:
- ✅ Batch contains only 1 operation
- ✅ Stale order detected during execution
- ✅ Fast-path recovery applied (not full sync)
- ✅ Cleanup performed locally (stale ID recorded)
- ✅ No expensive `synchronizeWithChain()` call
- ✅ Log shows `[STALE-CANCEL] Single-op batch stale recovery (fast-path)`

### Test Statistics

```
Total Tests: 6
Status: ✅ All passing
Modules Tested:
  - dexbot_class.js (batch processing, recovery, hard-abort, stale-cancel)
  - accounting.js (recovery state management, resetRecoveryState)
  - order/grid.js (cache remainder tracking)
  - order/strategy.js (fill boundary shifts, reaction cap precision)

Configuration Validated:
  - FILL_PROCESSING.MAX_FILL_BATCH_SIZE
  - FILL_PROCESSING.BATCH_STRESS_TIERS
  - PIPELINE_TIMING.RECOVERY_RETRY_INTERVAL_MS
  - PIPELINE_TIMING.MAX_RECOVERY_ATTEMPTS

Coverage Targets:
  ✅ Fill batch processing (1-4 fills per broadcast)
  ✅ Adaptive batch sizing (queue depth → batch size)
  ✅ Recovery retry system (count+time-based)
  ✅ Orphan-fill double-credit prevention
  ✅ Cache remainder accuracy (per-slot tracking)
  ✅ Hard-abort cooldown consistency
  ✅ Stale-order fast-path recovery
```

### Key Assertions in Tests

1. **Batch Size Assertions**: Verify correct adaptive sizing based on queue depth
2. **Recovery State Assertions**: Confirm count/time-based retry state machine
3. **Stale ID Assertions**: Validate orphan deduplication map behavior
4. **Cache Remainder Assertions**: Verify per-slot allocation tracking
5. **Cooldown Assertions**: Confirm hard-abort arms maintenance cooldown
6. **Fast-Path Assertions**: Verify single-op stale recovery doesn't trigger full sync

### Integration with CI/CD

Fill batching tests are part of the main test suite:

```bash
# Full test suite
npm test

# Only fill batching tests
npm test -- test_fill_batch_invariants.js

# With coverage reporting
npm test -- --coverage test_fill_batch_invariants.js
```

### Regression Prevention

These tests catch regressions in:
- Fill batch processing logic (adaptive sizing)
- Recovery retry state management (count+time system)
- Orphan-fill deduplication guards (stale ID tracking)
- Cache remainder calculation (per-slot accuracy)
- Hard-abort cooldown arming (both paths)
- Stale-order fast-path recovery (single-op optimization)

### Related Documentation

See complete technical details in:
- [docs/FUND_MOVEMENT_AND_ACCOUNTING.md § 1.4](FUND_MOVEMENT_AND_ACCOUNTING.md#14-fill-batch-processing--cache-fund-timeline) - Fill batch processing
- [docs/FUND_MOVEMENT_AND_ACCOUNTING.md § 3.7](FUND_MOVEMENT_AND_ACCOUNTING.md#37-orphan-fill-deduplication--double-credit-prevention) - Orphan-fill prevention
- [docs/architecture.md - Fill Processing Pipeline](architecture.md#fill-processing-pipeline) - Architecture & diagrams

---

## Future Maintenance

When adding new bugfixes:
1. Create a test that would have caught the bug
2. Add it to the appropriate test file (strategy.test.js, accounting.test.js, or test_patch*.js)
3. Reference the commit hash in a comment
4. Update this summary document
5. Ensure test covers both success and failure paths

This ensures continuous regression detection and documents the evolution of the test suite.
