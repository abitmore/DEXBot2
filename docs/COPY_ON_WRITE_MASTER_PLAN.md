# Copy-on-Write (COW) Grid Master Plan

**Author:** Antigravity (Gemini)  
**Status:** Implemented  
**Objective:** Eliminate optimistic state corruption by separating "Blockchain Truth" from "Strategy Targets" using immutable master grids and Copy-on-Write semantics.

## Overview

The Copy-on-Write (COW) Grid Architecture replaces the old snapshot/rollback pattern with a cleaner approach: **master grid is never modified until blockchain confirmation**.

This architecture implements the core philosophy of **"Verify, Then Commit"**:
1. **Immutable Master Grid:** The master grid is never directly modified during planning
2. **Atomic Promotion:** Changes only move from working copy to master upon verified blockchain success
3. **Delta-Only Execution:** Only the difference between Master and Target triggers blockchain actions
4. **Side Invariance:** Order side (BUY/SELL) is absolute. Any price-flip requires a full `Cancel` → `Place` sequence

## Architecture

### Old Pattern (Removed)
```
1. Take snapshot of master grid
2. Modify master directly (optimistic)
3. Broadcast to blockchain
4. On failure: rollback to snapshot
```

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

### Phase 1: Frozen Master State (v1.0)
- **Approach:** `Object.freeze()` on Maps and order objects
- **Problem:** Performance overhead, complexity in deep-freezing nested structures
- **Status:** Abandoned in favor of COW approach

### Phase 2: Copy-on-Write (v2.0 - Current)
- **Approach:** Working copy during planning, atomic swap on success
- **Advantage:** Cleaner semantics, better performance, easier to reason about
- **Status:** ✅ Production-ready

The key insight was that true immutability wasn't necessary - what matters is that **the master is never in a partially-modified state**. COW achieves this by keeping modifications isolated until confirmation.

## Implementation Status

### Phase 0: Dependencies ✅
- Created `modules/order/utils/order_comparison.js` - Epsilon-based order comparison
- Created `modules/order/utils/grid_indexes.js` - Index building utilities

### Phase 1: Infrastructure ✅
- Created `modules/order/working_grid.js` - WorkingGrid class
- Added `COW_PERFORMANCE` thresholds to `modules/constants.js`

### Phase 2: Core Integration ✅
- `performSafeRebalance()` → delegates to `_applySafeRebalanceCOW()`
- `_applySafeRebalanceCOW()` - Creates working grid, runs planning, returns result without modifying master
- `_reconcileGridCOW()` - Delta reconciliation against working copy
- `_commitWorkingGrid()` - Atomic swap from working to master
- Fill queue for handling fills during broadcast
- Abort controller for fill detection during broadcast

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
    // ... update master grid ...
    
    // --- COW WORKING GRID SYNC ---
    if (this._currentWorkingGrid && this._rebalanceState === 'REBALANCING') {
        this._currentWorkingGrid.syncFromMaster(this.orders, order.id);
    }
}

// WorkingGrid.syncFromMaster (working_grid.js)
syncFromMaster(masterGrid, orderId) {
    const masterOrder = masterGrid.get(orderId);
    if (masterOrder) {
        this.grid.set(orderId, this._cloneOrder(masterOrder));
        this.modified.add(orderId);
        this._indexes = null;
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
        │                      Sync to working grid (if REBALANCING)
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

### Phase 5: Tests ✅
- `tests/test_cow_master_plan.js` - 10 COW tests
- `tests/test_working_grid.js` - WorkingGrid unit tests
- `tests/benchmark_cow.js` - Performance benchmarks

### Phase 6: Divergence & Cache Updates ✅
**Critical Rule**: Divergence checks and cache function updates only execute when NO fills are pending.

**Execution Conditions**:
```javascript
if (fills.length === 0 && rebalanceState === 'NORMAL') {
    // Safe to check divergence
    // Safe to update cache functions
}
```

**Why this restriction**:
- Divergence calculations assume stable grid state
- Fills modify the grid mid-calculation
- Cache updates must reflect committed state, not speculative working state
- Prevents race conditions between fill processing and cache invalidation

### Phase 7: Benchmarks ✅
- 100 orders: ~0.03ms clone
- 500 orders: ~0.05ms clone
- 1000 orders: ~0.08ms clone
- 5000 orders: ~0.5ms clone

### Phase 8: Cleanup ✅
- Removed snapshot/rollback from `_applySafeRebalance()`
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
NORMAL → REBALANCING → BROADCASTING → CONFIRMED → NORMAL
                         ↓ (on failure)
                       NORMAL (master unchanged)
```

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

- `modules/order/utils/order_comparison.js`
- `modules/order/utils/grid_indexes.js`
- `modules/order/working_grid.js`
- `tests/test_cow_master_plan.js`
- `tests/test_working_grid.js`
- `tests/benchmark_cow.js`

## Files Modified

- `modules/constants.js` - Added COW_PERFORMANCE
- `modules/order/manager.js` - Added COW methods, removed snapshot/rollback
- `modules/order/dexbot_class.js` - Wired COW broadcast, removed legacy rollback

## Test Results

```
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

### 2. Divergence Checks Blocked During Rebalance
```javascript
// Divergence check entry point
async checkDivergence() {
    if (this.fillsPending.length > 0) {
        // Defer until fills processed
        return { deferred: true, reason: 'fills_pending' };
    }
    if (this._rebalanceState !== 'NORMAL') {
        // Defer until rebalance completes
        return { deferred: true, reason: 'rebalance_in_progress' };
    }
    // Safe to check divergence
    return this._calculateDivergence();
}
```

### 3. Cache Updates Blocked During Rebalance
```javascript
// Cache update entry point
async updateCache() {
    if (this.fillsPending.length > 0) {
        // Cache update invalid - fills will change state
        return { skipped: true, reason: 'fills_pending' };
    }
    if (this._rebalanceState !== 'NORMAL') {
        // Cache would reflect uncommitted state
        return { skipped: true, reason: 'rebalance_in_progress' };
    }
    // Safe to update cache
    return this._performCacheUpdate();
}
```

## Integration & Validation

### Fill Integration Sequence
1. ✅ Keep fill mutation authoritative in master flow (`syncFromFillHistory` / `syncFromOpenOrders`)
2. ✅ Normalize COW order shape to `size` (remove `amount` assumptions)
3. ✅ Reconcile COW actions by state transition semantics:
   - virtual → active target: `create`
   - active/partial → zero target: `cancel`
   - same-side on-chain size change: `update`
   - side change: `cancel + create`
4. ✅ Restore open-order sync parity: missing on-chain ACTIVE/PARTIAL with `orderId` treated as fill trigger
5. ✅ Keep COW scope strict: planning + broadcast + commit-on-success; discard on failure

### Validation Gates
Run these tests before promotion:
- `node tests/test_engine_integration.js`
- `node tests/test_sequential_multi_fill.js`
- `node tests/test_sync_logic.js`
- `node tests/test_ghost_order_fix.js`
- `node tests/test_working_grid.js`
- `node tests/test_cow_master_plan.js`

### Additional Checks
- Unchanged grids do not emit global COW `update` actions
- Missing on-chain ACTIVE order with `orderId` appears in `filledOrders` from open-order sync

## Safety Guardrails

1. **Accountant Dry-Run:** `Accountant.validateTargetGrid(targetMap)` verifies that the entire proposed grid fits within `Liquid + CurrentOrderValue` *before* broadcasting.

2. **Volatility Protection:** If `Target.boundaryIndex` shifts more than `MAX_SHIFT` slots (configurable, default 5) from `Master.boundaryIndex`, the rebalance is deferred until market stabilizes.

3. **Resync on Error:** If any blockchain action fails (e.g., "Insufficient funds"), the bot discards the working grid and triggers `startup_reconcile.js` for a fresh blockchain sync.

## Backward Compatibility

None. COW is the **only standard**. The old snapshot/rollback pattern has been completely removed.

## Verification

This architecture makes the "Metadata Reinterpretation" bug impossible by ensuring that memory is only a reflection of verified blockchain state. The master grid is never partially modified - it's either the old state or the new state, with no intermediate "limbo" states.
