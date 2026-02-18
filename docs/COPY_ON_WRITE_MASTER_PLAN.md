# Copy-on-Write (COW) Grid Master Plan

**Author:** froooze  
**Status:** Implemented & Stabilized  
**Objective:** Eliminate optimistic state corruption by separating "Blockchain Truth" from "Strategy Targets" using immutable master grids and Copy-on-Write semantics.

## Overview

The Copy-on-Write (COW) Grid Architecture replaces the old optimistic mutation pattern with a cleaner approach: **master grid is never modified until blockchain confirmation**.

This architecture implements the core philosophy of **"Verify, Then Commit"**:
1. **Immutable Master Grid:** The master grid is never directly modified during planning
2. **Atomic Promotion:** Changes only move from working copy to master upon verified blockchain success
3. **Delta-Only Execution:** Only the difference between Master and Target triggers blockchain actions
4. **Side Invariance:** Order side (BUY/SELL) is absolute. Any price-flip requires a full `Cancel` → `Place` sequence

## Architecture

### Phase 0: Original Optimistic State (Removed)
**Also known as:** "Old Pattern"

```
1. Modify master grid directly (optimistic)
2. Broadcast to blockchain
3. (No recovery mechanism on failure)
```

**Problems:**
- Direct mutation of master grid during planning
- No isolation between planning and committed state
- No snapshot/rollback capability - failures leave grid in corrupted state
- Ghost orders persist because nothing cleans them up (see Incident Report: XRP-BTS Price Jump)

### New COW Pattern
```
1. Create WorkingGrid (clone of master)
2. Modify working copy
3. Broadcast to blockchain
4. On success: atomic swap (working → master)
5. On failure: discard working (master unchanged)
```

## Historical Context: Immutable Master Grid Evolution

The COW architecture evolved from earlier attempts to achieve grid immutability:

### Phase 0: Original Optimistic State (Pre-v1.0)
- **Approach:** Direct in-memory mutation of master grid during planning
- **Pattern:** Modify master directly → Broadcast to blockchain → No recovery mechanism
- **Vulnerability:** State corruption during any failure, no isolation between planning and committed state, no rollback capability
- **Incident:** This approach caused the XRP-BTS Price Jump incident (see `/docs/INCIDENT_REPORT_XRP_BTS_PRICE_JUMP.md`)
- **Status:** ❌ **Vulnerable** - Replaced by frozen master approach

### Phase 1: Frozen Master State (v1.0)
- **Approach:** `Object.freeze()` on Maps and order objects
- **Implementation:** Each `_applyOrderUpdate` creates new frozen Map via immutable-swap pattern
- **Original concern:** Performance overhead, complexity in deep-freezing nested structures
- **Advantage:** Runtime enforcement prevents accidental mutations, catches bugs that read `manager.orders` and mutate in-place
- **Status:** ✅ **Retained** as defense-in-depth layer alongside COW

### Phase 2: Copy-on-Write (v2.0 - Current)
- **Approach:** Working copy during planning, atomic swap on blockchain confirmation
- **Pattern:** Clone → Modify working copy → Broadcast → Commit on success / Discard on failure
- **Advantage:** True transactional semantics, master never in intermediate state, cleaner than snapshot/rollback
- **Status:** ✅ Production-ready

**Actual Implementation: Freeze + COW Hybrid**

The production implementation uses BOTH approaches as complementary layers:

1. **`Object.freeze()`** on the master Map and `deepFreeze()` on individual order objects
   provides runtime enforcement -- any accidental direct mutation throws in strict mode.
   Each `_applyOrderUpdate` call creates a new frozen Map via immutable-swap pattern:
   ```javascript
   const newMap = cloneMap(this.orders);
   newMap.set(id, deepFreeze({ ...nextOrder }));
   this.orders = Object.freeze(newMap);
   ```

2. **COW working grids** provide the planning/broadcast lifecycle isolation -- strategy
   computes target state on a mutable clone, and master is only replaced after blockchain
   confirmation via `_commitWorkingGrid()`.

The freeze layer catches bugs that COW alone wouldn't (e.g., code that reads `manager.orders`
and mutates an order object in-place). The COW layer provides the transactional semantics
(plan, broadcast, commit-or-discard).

## Implementation Status

### Phase 0: Dependencies ✅
- Created `modules/order/utils/order_comparison.js` - Epsilon-based order comparison
- Created `modules/order/utils/grid_indexes.js` - Index building utilities (used by WorkingGrid)

### Phase 1: Infrastructure ✅
- Created `modules/order/working_grid.js` - WorkingGrid class
- Added `COW_PERFORMANCE` thresholds to `modules/constants.js`

### Phase 2: Core Integration ✅
- `performSafeRebalance()` → delegates to `_applySafeRebalanceCOW()`
- `_applySafeRebalanceCOW()` - Creates working grid, runs planning, returns result without modifying master
- `_reconcileGridCOW()` - Delta reconciliation against working copy
- `_commitWorkingGrid()` - Atomic swap from working to master

### Phase 3: Broadcast Integration ✅
- `updateOrdersOnChainBatch()` - Routes to COW path when `workingGrid` present
- `_updateOrdersOnChainBatchCOW()` - Full COW broadcast with commit on success
- Removed legacy rollback code

### Phase 4: Fill Handling Strategy ✅
**Updated Decision**: "Selective abort - Continue individual fills, block full-side updates"

**Fill Processing Behavior**:

| Scenario | Scope | Action | Reason |
|----------|-------|--------|--------|
| **Individual fill** | Single slot (boundary shift) | Process immediately | Just moves boundary, doesn't modify filled order. Low risk. |
| **Divergence-triggered full update** | Entire side of grid | BLOCK if fills pending | Rebuilding all orders - needs stable state, no concurrent fills |
| **Cache threshold full update** | Entire side of grid | BLOCK if fills pending | Rebalancing depleted side - complex planning, can't have stale data |

**Key Principle**:

**Individual Fills** (Grid Maintenance):
- Only move boundary and handle next slot - **don't modify the filled order itself**
- Fills keep the grid alive by shifting the boundary as market moves
- Low risk, can sync to working grid and continue current rebalance
- **Never abort blockchain operations for individual fills**

**Full Side Updates** (Major Planning):
- Divergence: Rebuild entire side of grid (potentially dozens of orders)
- Cache threshold: Rebalance all orders on depleted side
- High risk - complex planning that shouldn't run with stale state
- **Abort if fills pending or during BROADCASTING**

**Why the distinction matters**:
- Individual fills: "Just handle this one slot, keep grid alive"
- Full updates: "Rebuild everything, needs stable foundation"

**Critical: Working Grid Synchronization**
When fills arrive during REBALANCING state (before BROADCASTING):
1. Update master grid immediately (blockchain truth)
2. **Also apply same fill to working grid** (keep copies in sync)
3. Continue with current rebalance using updated working copy

```javascript
// Implementation in _applyOrderUpdate (manager.js)
async _applyOrderUpdate(order, context, skipAccounting, fee) {
    // ... update master grid (immutable swap) ...

    // Centralized adapter handles:
    // 1) planning-state gate,
    // 2) markStale(),
    // 3) syncFromMaster(),
    // 4) sync error handling.
    this._syncWorkingGridFromMasterMutation(order.id, context);
}

// WorkingGrid.syncFromMaster (working_grid.js)
syncFromMaster(masterGrid, orderId, masterVersion) {
    const masterOrder = masterGrid.get(orderId);
    if (masterOrder) {
        this.grid.set(orderId, this._cloneOrder(masterOrder));
        this.modified.add(orderId);
        this._indexes = null;
    }
    if (Number.isFinite(masterVersion)) {
        this.baseVersion = masterVersion;
    }
}
```

**Why this matters**:
- Working grid must reflect all blockchain state changes
- Prevents stale data from being committed
- Avoids unnecessary aborts for individual fills

**Fill Processing Flow**:
```
NEW FILL ARRIVES (Individual Order Fill)
        │
        ▼
[What type of update triggered this?]
        │
    Boundary Shift Only? ──Yes──> Update master grid
        │                      Sync to working grid (if planning active)
       No                      Continue current operations
        │
    Full Side Update? ──Yes──> Check State
        │                         │
       No                   REBALANCING?
        │                         │
        │                    Yes ──> Block, wait for fills=0
        │                         │
        │                    No ──> Check if BROADCASTING
        │                         │
        │                   Yes ──> AbortController.abort()
        │                         │
        │                   No ──> Safe to proceed
        ▼
[Note: Individual fills move boundary, don't touch filled order]
[Note: Full updates touch all orders - needs stable state]
```

### COW State Machine Cheat Sheet

| State | Fill Handling | Working Grid Action | Commit Outcome |
|-------|---------------|---------------------|----------------|
| `NORMAL` | Apply fill to master immediately | No working-grid sync | Not applicable |
| `REBALANCING` | Apply fill to master immediately | Mark stale + sync changed order from master | Planning returns aborted result |
| `BROADCASTING` | Apply fill to master immediately | Mark stale + sync changed order from master | Commit guard rejects stale/version-mismatch grid |

**Single-source rules (no special cases):**
- Master grid always updates first (blockchain truth)
- If planning/broadcasting is active, sync the changed order into the working grid
- Any master mutation marks the working grid stale
- Commit succeeds only when stale/version/delta guards all pass

### Phase 5: Tests ✅
- `tests/test_cow_master_plan.js` - 11 COW core tests
- `tests/test_cow_commit_guards.js` - Commit guard regression tests
- `tests/test_cow_concurrent_fills.js` - Concurrent fill integration tests
- `tests/test_sync_lock_routing.js` - Lock routing verification tests
- `tests/test_working_grid.js` - WorkingGrid unit tests
- `tests/benchmark_cow.js` - Performance benchmarks

### Phase 6: Divergence & Cache Updates ✅
**Critical Rule**: Divergence checks and cache function updates only execute when NO fills are pending.

**Execution Conditions**:
```javascript
if (fills.length === 0 && rebalanceState === REBALANCE_STATES.NORMAL) {
    // Safe to check divergence
    // Safe to update cache functions
}
```

**Why this restriction**:
- Divergence calculations assume stable grid state
- Fills modify the grid mid-calculation
- Cache updates must reflect committed state, not speculative working state
- Prevents race conditions between fill processing and cache invalidation

### Phase 7: Divergence Correction COW Migration ✅
Migrated `applyGridDivergenceCorrections` from queue-based cancellations to full COW pattern.

**Atomic Boundary Shifts (Patch 20)**: Boundary index changes during divergence correction are now atomic with slot-type reassignment. The `pendingBoundaryIdx` variable carries boundary changes through the COW pipeline without touching `manager.boundaryIdx` until `_commitWorkingGrid` completes. This prevents temporary mismatches between boundary position and slot BUY/SELL roles during blockchain execution.

```javascript
// Boundary changes flow through COW pipeline atomically
const boundarySync = syncBoundaryToFunds(manager);  // Returns { changed, newIdx }
if (boundarySync.changed) {
    pendingBoundaryIdx = boundarySync.newIdx;  // NOT manager.boundaryIdx!
    // updateGridFromBlockchainSnapshot reassigns slot types in WorkingGrid
    // manager.boundaryIdx updated atomically in _commitWorkingGrid
}
```

**Before (Queue-Based)**:
```javascript
// Detect divergence → Queue corrections → Execute batch → Clear queue
// Master grid stays ACTIVE during entire process (race condition)
ordersNeedingPriceCorrection.push({ gridOrder, chainOrderId, isSurplus: true });
// ...later...
await updateOrdersOnChainBatchFn({ ordersToCancel, ordersToPlace, ordersToRotate });
```

**After (COW-Based)**:
```javascript
// Detect divergence → Create WorkingGrid → Update sizes in working copy
// → Execute UPDATE/CANCEL/CREATE ops on chain → Commit working grid on success
const workingGrid = new WorkingGrid(manager.orders);
workingGrid.set(orderId, convertToSpreadPlaceholder(order)); // Surplus → virtual slot
const actions = [{ type: COW_ACTIONS.CANCEL, id, orderId }, ...];
const cowResult = { actions, workingGrid, ... };
await updateOrdersOnChainBatch(cowResult); // Commit only on success
```

**Key Changes**:
1. **Surplus orders**: CANCEL on-chain and virtualize in working grid
2. **State preservation**: ACTIVE/PARTIAL orders keep their state in working grid
3. **No race conditions**: Master unchanged until blockchain confirms
4. **Unified flow**: Same COW pattern as fill rebalancing

**Grid Resizing Also Migrated**:
`updateGridFromBlockchainSnapshot` now returns COW result:
```javascript
// Before: Modified master grid directly
await Grid.updateGridFromBlockchainSnapshot(manager, 'buy'); // Direct update!

// After: Returns COW result for batch execution
const cowResult = await Grid.updateGridFromBlockchainSnapshot(manager, 'buy');
await updateOrdersOnChainBatch(cowResult); // Execute via COW
```

### Phase 8: Benchmarks ✅
- 100 orders: ~0.03ms clone
- 500 orders: ~0.05ms clone
- 1000 orders: ~0.08ms clone
- 5000 orders: ~0.5ms clone

### Phase 9: Cleanup ✅
- Removed snapshot/rollback pattern; `performSafeRebalance()` now delegates to `_applySafeRebalanceCOW()`
- Removed duplicate `_updateOrdersOnChainBatchCOW`
- Removed legacy rollback references in `dexbot_class.js`

## Key Methods

### OrderManager (manager.js)
| Method | Description |
|--------|-------------|
| `performSafeRebalance(fills, excludeIds)` | Entry point - delegates to COW |
| `_applySafeRebalanceCOW(fills, excludeIds)` | Creates working grid, runs planning |
| `_reconcileGridCOW(targetGrid, boundary, workingGrid)` | Delta against working copy |
| `_commitWorkingGrid(workingGrid, indexes, boundary)` | Atomic swap to master |
| `_setRebalanceState(state)` | Track rebalance state |
| `_currentWorkingGrid` | Reference to working grid during rebalance for fill sync |
| `syncFromMaster(masterGrid, orderId)` | Sync specific order from master to working grid (WorkingGrid method) |

### DEXBot (dexbot_class.js)
| Method | Description |
|--------|-------------|
| `updateOrdersOnChainBatch(rebalanceResult)` | Routes to COW broadcast |
| `_updateOrdersOnChainBatchCOW(rebalanceResult)` | Full COW broadcast with commit |

### WorkingGrid (working_grid.js)
| Method | Description |
|--------|-------------|
| `syncFromMaster(masterGrid, orderId)` | Sync specific order from master to working grid during fill processing |
| `buildDelta(masterGrid)` | Build delta actions between master and working grid |
| `getIndexes()` | Get cached grid indexes |

## Rebalance States

```
NORMAL → REBALANCING → BROADCASTING → _commitWorkingGrid() → NORMAL
                                          ↓ (on failure)
                                    _clearWorkingGridRef() → NORMAL
                                        (master unchanged)
```

**State transitions:**
- `NORMAL → REBALANCING`: `_applySafeRebalanceCOW()` begins planning
- `REBALANCING → BROADCASTING`: `_updateOrdersOnChainBatchCOW()` starts blockchain ops
- `BROADCASTING → NORMAL`: `_clearWorkingGridRef()` always called on exit (success or failure)
- Fill during REBALANCING/BROADCASTING: marks working grid stale, syncs data

## Data Flow

### Normal Rebalance Flow
```
1. performSafeRebalance(fills, excludeIds)
   └─> _applySafeRebalanceCOW()
       ├─> Create WorkingGrid (clone master)
       ├─> Calculate target grid (from strategy)
       ├─> Reconcile against working copy
       ├─> Validate working grid funds
       └─> Return { workingGrid, actions, ... }

2. updateOrdersOnChainBatch(result)
   └─> _updateOrdersOnChainBatchCOW()
       ├─> Lock order IDs
       ├─> Build blockchain operations
       ├─> Execute batch
       ├─> On success:
       │   └─> _commitWorkingGrid() → atomic swap
       │   └─> persistGrid() → write to disk
       └─> On failure:
           └─> workingGrid discarded (master unchanged)
```

### Fill During Broadcast Flow (Selective Abort)
```
NEW FILL ARRIVES
        │
        ▼
[What type of update?]
        │
    Individual Fill? ──Yes───────────────────────┐
        │                                         │
       No                                         │
        │                                         │
    Full Side Update? ──Yes──> [Check State]     │
        │                          │              │
       No                     BROADCASTING?       │
        │                          │              │
        │                     Yes ──> Abort       │
        │                     No  ──> Block       │
        │                          │              │
        │                     Working grid        │
        │                     discarded           │
        │                          │              │
        └──────────────────────────┴──────────────┘
                                     │
                                     ▼
                           Master grid updated
                           (fills processed)
                                     │
                                     ▼
                           Continue blockchain ops
                           OR trigger new rebalance
```

## Files Created

- `modules/order/utils/order_comparison.js` - Epsilon-based order comparison, delta building
- `modules/order/utils/grid_indexes.js` - Index building and validation utilities
- `modules/order/working_grid.js` - WorkingGrid class (COW wrapper with clone/delta/stale tracking)
- `tests/test_cow_master_plan.js` - Core COW tests
- `tests/test_cow_commit_guards.js` - Commit guard regression tests
- `tests/test_cow_concurrent_fills.js` - Concurrent fill integration tests
- `tests/test_cow_divergence_correction.js` - Divergence correction COW tests
- `tests/test_working_grid.js` - WorkingGrid unit tests
- `tests/benchmark_cow.js` - Performance benchmarks

## Files Modified

- `modules/constants.js` - Added COW_PERFORMANCE thresholds
- `modules/order/manager.js` - Added COW methods, immutable master (Object.freeze), version tracking
- `modules/dexbot_class.js` - Wired COW broadcast, removed legacy rollback
- `modules/order/sync_engine.js` - Uses `_applyOrderUpdate` (lock-free) for all sync paths
- `modules/order/startup_reconcile.js` - Uses `_applySync` (lock-free) when inside `_gridLock`
- `modules/order/utils/system.js` - Migrated `applyGridDivergenceCorrections` to full COW pattern
- `modules/order/grid.js` - Migrated `updateGridFromBlockchainSnapshot` to return COW result instead of modifying master directly

## Test Results

```
Core COW Tests (test_cow_master_plan.js):
  ✓ COW-001: Master unchanged on failure
  ✓ COW-002: Master updated only on success
  ✓ COW-003: Index transfer
  ✓ COW-004: Fund recalculation
  ✓ COW-005: Order comparison
  ✓ COW-006: Delta building
  ✓ COW-007: Index validation
  ✓ COW-008: Working grid independence
  ✓ COW-009: Empty grid handling
  ✓ COW-010: Memory stats
  ✓ COW-011: No spurious updates on unchanged grid

Commit Guard Tests (test_cow_commit_guards.js):
  ✓ COW-COMMIT-001: Version mismatch rejection
  ✓ COW-COMMIT-002: Empty delta rejection

Concurrent Fill Tests (test_cow_concurrent_fills.js):
  ✓ COW-FILL-001: Fill during REBALANCING syncs to working grid
  ✓ COW-FILL-002: Fill during BROADCASTING syncs to working grid
  ✓ COW-FILL-003: Commit rejected after fill during broadcast
  ✓ COW-FILL-004: No working grid sync during NORMAL state
  ✓ COW-FILL-005: _cloneOrder deep-clones rawOnChain
  ✓ COW-FILL-006: _cloneOrder handles missing rawOnChain
  ✓ COW-FILL-007: Staleness reason includes phase context

Divergence Correction Tests (test_cow_divergence_correction.js):
  ✓ Surplus orders are CANCELLED (not UPDATE to size=0)
  ✓ Working grid preserves order states (ACTIVE, PARTIAL)
  ✓ Orders within target window get size updates
  ✓ No duplicate UPDATE/CANCEL overlap for same order
```

## Operational Rules

### 1. Fill Priority Always Wins
Filled orders are blockchain truth and always processed immediately.

**Individual Fills** (Single Order):
- Only shift boundary index - filled order becomes SPREAD, next slot gets filled
- Does NOT modify the filled order itself
- Low impact - just keeps grid aligned with market
- **Always process immediately, sync to working grid, continue operations**

**Full Side Updates** (All Orders):
- Divergence: Recalculate and update ALL orders on one side
- Cache threshold: Rebalance entire depleted side
- High impact - complex planning across many orders
- **BLOCK if fills pending - can't plan with stale state**

**Key distinction**: Individual fills move the boundary. Full updates rebuild everything.

### 2. Divergence & Cache Checks Blocked During Rebalance
Divergence detection and cache function updates are deferred when fills are pending or when rebalancing is in progress to ensure calculations use stable, committed state rather than speculative working grid state.

## Integration & Validation

### Validation Gates
Run these tests before promotion:
- `node tests/test_engine_integration.js`
- `node tests/test_sequential_multi_fill.js`
- `node tests/test_sync_logic.js`
- `node tests/test_ghost_order_fix.js`
- `node tests/test_working_grid.js`
- `node tests/test_cow_master_plan.js`
- `node tests/test_cow_commit_guards.js`
- `node tests/test_cow_concurrent_fills.js`
- `node tests/test_cow_divergence_correction.js`

### Additional Checks
- Unchanged grids do not emit global COW `update` actions
- Missing on-chain ACTIVE order with `orderId` appears in `filledOrders` from open-order sync

## Constants Added (modules/constants.js)

### COW Performance Thresholds
- `COW_PERFORMANCE.MAX_REBALANCE_PLANNING_MS` - Max time for rebalance planning phase
- `COW_PERFORMANCE.MAX_COMMIT_MS` - Max time for grid commit operation
- `COW_PERFORMANCE.MAX_MEMORY_MB` - Memory threshold for working grid operations
- `COW_PERFORMANCE.INDEX_REBUILD_THRESHOLD` - Grid size threshold for index rebuilding
- `COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER` - Estimated memory per order (500 bytes)

### Pipeline Timing (added in stabilization commits)
- `PIPELINE_TIMING.MAX_FEE_EVENT_CACHE_SIZE` - LRU cache limit for fee dedup (10,000 entries)
- `PIPELINE_TIMING.FEE_EVENT_DEDUP_TTL_MS` - Fee event deduplication TTL (6 hours)
- `PIPELINE_TIMING.CACHE_EVICTION_RETENTION_RATIO` - LRU eviction retention (0.75)
- `PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS` - Recovery decay fallback (180 seconds)

### Grid & Timing
- `GRID_LIMITS.SATOSHI_CONVERSION_FACTOR` - Precision conversion factor (1e8)
- `GRID_LIMITS.STATE_CHANGE_HISTORY_MAX` - Max state change history entries (100)
- `TIMING.LOCK_REFRESH_MIN_MS` - Minimum lock refresh interval (250ms)

## Safety Guardrails

1. **Accountant Dry-Run:** `Accountant.validateTargetGrid(targetMap)` verifies that the entire proposed grid fits within `Liquid + CurrentOrderValue` *before* broadcasting.

2. **Atomic Transaction Semantics:** Large boundary shifts (>5 slots) are inherently safe because the COW pattern only commits after successful blockchain confirmation. If market volatility causes rapid shifts during planning, the working grid is simply discarded and replanning occurs on the next cycle.

3. **Resync on Error:** If any blockchain action fails (e.g., "Insufficient funds"), the bot discards the working grid and triggers `startup_reconcile.js` for a fresh blockchain sync.

## Backward Compatibility

None. COW is the **only standard**. The old snapshot/rollback pattern has been completely removed.

## Verification

This architecture makes the "Metadata Reinterpretation" bug impossible by ensuring that memory is only a reflection of verified blockchain state. The master grid is never partially modified - it's either the old state or the new state, with no intermediate "limbo" states.
