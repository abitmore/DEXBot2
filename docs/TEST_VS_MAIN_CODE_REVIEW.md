# Code Review: `test` vs `main` Branch - Order Logic Comparison

**Date**: February 17, 2026  
**Scope**: `modules/order/`, `modules/chain_orders.js`, `modules/account_orders.js`, `modules/dexbot_class.js`, `modules/constants.js`  
**Purpose**: Identify critical issues, potential bugs, and breaking changes in the `test` branch relative to `main`

---

## Executive Summary

The `test` branch contains significant architectural changes to the order management system, including:

- **Copy-on-Write (COW) immutable grid pattern** for thread safety
- **Async conversion** of previously synchronous fund management methods
- **Module restructuring** (`utils.js` split into `utils/` subdirectory)
- **New state management** via `StateManager` and `COWRebalanceEngine` classes

While many changes are improvements, several introduce **breaking API changes** and **potential race conditions** that require attention before merging to `dev`/`main`.

---

## Table of Contents

1. [Critical Issues](#critical-issues)
2. [Potential Bugs](#potential-bugs)
3. [Odd/Suspicious Patterns](#oddsuspicious-patterns)
4. [Safe Improvements](#safe-improvements)
5. [Breaking API Changes](#breaking-api-changes)
6. [Recommendations](#recommendations)
7. [Files Changed Summary](#files-changed-summary)

---

## Critical Issues

### 1. `recalculateFunds()` Changed to Async Without Full Call-Site Audit

**File**: `modules/order/accounting.js`

**Change**:
```javascript
// BEFORE (main)
recalculateFunds() {
    // synchronous implementation
}

// AFTER (test)
async recalculateFunds() {
    // async implementation with lock acquisition
}
```

**Risk Level**: HIGH

**Impact**:
- Callers that previously expected synchronous fund state updates may now have race conditions
- Any code that reads `manager.funds` immediately after calling `recalculateFunds()` without `await` will read stale data
- Multiple places in `grid.js` and `manager.js` now properly await, but some call sites may have been missed

**Detection**:
```bash
# Find potential missing awaits
grep -rn "recalculateFunds()" modules/ | grep -v "await"
```

---

### 2. `_updateOrder()` Changed to Async with New Return Semantics

**File**: `modules/order/manager.js`

**Change**:
```javascript
// BEFORE (main)
_updateOrder(id, updates, context) {
    // synchronous, returns void
}

// AFTER (test)
async _updateOrder(id, updates, context, options = {}) {
    // async, acquires _gridLock, returns boolean (success/failure)
}
```

**Risk Level**: HIGH

**Impact**:
- Code expecting synchronous state changes may have timing issues
- The return value change from `void` to `boolean` is a breaking API change
- Callers that don't check the return value may proceed with failed updates

---

### 3. Master Grid Now Uses Copy-on-Write (COW) Immutability

**File**: `modules/order/manager.js` (~line 4792)

**Change**:
```javascript
// Every order update now creates a new frozen Map
const newMap = cloneMap(this.orders);
newMap.set(id, updatedOrder);
this.orders = Object.freeze(newMap);
this._gridVersion++;
```

**Risk Level**: HIGH

**Impact**:
- **Memory/GC Pressure**: Every order update creates a new Map object, which could cause GC pressure with high-frequency operations
- **Stale References**: Any code that caches `manager.orders` or iterates over it during an update will have stale data
- **Version Tracking**: `_gridVersion` increments on every change, which can be used for staleness detection

**Mitigation in Code**:
The `WorkingGrid` class uses `baseVersion` to detect when the master grid has changed during planning:
```javascript
if (workingGrid.isStale()) {
    return buildAbortedResult(workingGrid.getStaleReason());
}
```

---

## Potential Bugs

### 1. Missing `await` on Newly Async Methods

Several methods that became async may not be properly awaited throughout the codebase:

| Method | File | Previous | Now |
|--------|------|----------|-----|
| `tryDeductFromChainFree()` | `accounting.js` | sync | async |
| `addToChainFree()` | `accounting.js` | sync | async |
| `processFillAccounting()` | `accounting.js` | sync | async |
| `_getSizingContext()` | `grid.js` | sync | async |
| `updateOptimisticFreeBalance()` | `accounting.js` | sync | async |

**Detection**:
```bash
# Check for potential missing awaits
grep -rn "tryDeductFromChainFree\|addToChainFree\|processFillAccounting" modules/ | grep -v "await"
```

---

### 2. Lock Timeout Race Condition in Sync Engine

**File**: `modules/order/sync_engine.js` (line ~238-263)

**Code**:
```javascript
return await Promise.race([
    mgr._syncLock.acquire(async () => {
        if (cancelToken.isCancelled) {
            throw new Error('Sync operation cancelled');
        }
        // ... sync work happens here
    }, { cancelToken }),
    new Promise((_, reject) =>
        setTimeout(() => {
            cancelToken.isCancelled = true;
            reject(new Error(`Sync lock timeout after ${timeoutMs}ms`));
        }, timeoutMs)
    )
]);
```

**Issue**: If the timeout fires after lock acquisition but before the `cancelToken` check, the sync operation **continues to completion** and then throws. This can result in:
- Partial sync state
- Inconsistent fund tracking
- Misleading error messages

**Recommended Fix**: Add periodic `cancelToken` checks within the sync operation, or use an AbortController pattern.

---

### 3. Invariant Check Coalescing May Lose Violations

**File**: `modules/order/accounting.js` (line ~246-276)

**Code**:
```javascript
if (this._isVerifyingInvariants) {
    this._pendingInvariantSnapshot = snapshot;  // Only keeps LATEST
} else {
    runVerification(snapshot);
}
```

**Issue**: If multiple `recalculateFunds()` calls happen while verification is running, only the **last snapshot** is checked. Intermediate fund invariant violations may be missed entirely.

**Impact**: Fund tracking corruption could go undetected if it occurs between coalesced snapshots.

---

### 4. Recovery State Decay May Allow Infinite Loops

**File**: `modules/order/accounting.js` (line ~497-506)

**Code**:
```javascript
const decayMs = retryIntervalMs > 0 ? retryIntervalMs * 3 : PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS;
if (state.attemptCount > 0 && state.lastFailureAt > 0 && (now - state.lastFailureAt) > decayMs) {
    state.attemptCount = 0;  // Reset counter after decay period
    state.lastFailureAt = 0;
}
```

**Issue**: Recovery attempt count resets after the decay period, even if the underlying issue persists. If the same problem recurs after decay, it starts fresh at attempt 1, potentially leading to infinite recovery loops.

---

## Odd/Suspicious Patterns

### 1. Duplicate State Management

**File**: `modules/order/manager.js`

The code maintains state in **two places**:

```javascript
// StateManager instance
this._state = new StateManager({ logger: this.logger });

// Direct properties (legacy)
this._isBroadcasting = false;
this.isBootstrapping = true;
```

Both must be kept in sync:
```javascript
stopBroadcasting() {
    this._isBroadcasting = false;      // Direct property
    this._state.stopBroadcasting();    // StateManager
}
```

**Risk**: Easy to forget to update both, leading to inconsistent state.

---

### 2. `getOrdersByTypeAndState()` Behavior Change

**File**: `modules/order/manager.js`

**Before (main)**:
- Passing `null` for type or state returned all matching orders

**After (test)**:
- Requires **both** type AND state to be specified
- Returns empty array if either is missing

**Impact**: Any code that relied on the `null` behavior will silently return empty results.

---

### 3. `buildCreateOrderOp()` Return Value Change

**File**: `modules/chain_orders.js`

**Before (main)**:
```javascript
return op;  // Returns operation object directly
```

**After (test)**:
```javascript
return {
    op,
    finalInts: { sell, receive, sellAssetId, receiveAssetId }
};
// OR returns null if validation fails
```

**Impact**: All callers must now destructure `{ op }` and handle `null` returns.

---

### 4. Module Restructuring: `utils.js` Split

**Change**: `modules/order/utils.js` (2594 lines) was deleted and split into:

| New File | Purpose |
|----------|---------|
| `utils/math.js` | Blockchain conversions, fund calculations, precision handling |
| `utils/order.js` | Order object manipulation, filtering, state checks |
| `utils/system.js` | Fee caching, persistence, asset lookups |
| `utils/helpers.js` | Validation, reconciliation, COW helpers |

**Impact**: Any external code importing from `./utils` will break. Internal imports were updated.

---

## Safe Improvements

### 1. `toFiniteNumber()` Helper

**File**: `modules/order/format.js`

```javascript
function toFiniteNumber(value, defaultValue = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : defaultValue;
}
```

**Benefit**: Safer than the old `Number(x) || 0` pattern which incorrectly treats `0` as falsy.

---

### 2. Ghost Order Detection

**File**: `modules/order/sync_engine.js`

Detects when an order would become a "ghost" (tiny remainder that rounds to 0 on either side) and treats it as a full fill.

**Benefit**: Prevents orders from hanging in `PARTIAL` state indefinitely.

---

### 3. Phantom Order Sanitization

**File**: `modules/order/sync_engine.js`

```javascript
sanitizePhantomOrder(order, context) {
    if (isPhantomOrder(order)) {
        // ACTIVE/PARTIAL without orderId -> downgrade to VIRTUAL
        order.state = ORDER_STATES.VIRTUAL;
        return true;
    }
    return false;
}
```

**Benefit**: Prevents fund tracking corruption from invalid order states.

---

### 4. Centralized Order Validation

**File**: `modules/order/utils/helpers.js`

```javascript
const validation = validateOrder(order, oldOrder, context);
for (const warning of validation.warnings) {
    this.logger.log(warning.message, 'warn');
}
```

**Benefit**: Catches illegal state transitions early with consistent logging.

---

### 5. Asset-Specific Precision Formatting

**File**: `modules/order/format.js`

```javascript
formatAmountByPrecision(amount, precision)
formatSizeByOrderType(size, orderType, assets)
```

**Benefit**: Uses correct asset precision instead of hardcoded 8 decimals.

---

### 6. New Pipeline State Constants

**File**: `modules/constants.js`

```javascript
const REBALANCE_STATES = Object.freeze({
    NORMAL: 'NORMAL',
    REBALANCING: 'REBALANCING',
    BROADCASTING: 'BROADCASTING'
});

const COW_ACTIONS = Object.freeze({
    CREATE: 'create',
    CANCEL: 'cancel',
    UPDATE: 'update'
});
```

**Benefit**: Better lifecycle management with explicit state machine.

---

## Breaking API Changes

| Change | File | Migration Required |
|--------|------|-------------------|
| `recalculateFunds()` now async | `accounting.js` | Add `await` to all call sites |
| `_updateOrder()` now async, returns boolean | `manager.js` | Add `await`, check return value |
| `buildCreateOrderOp()` returns object or null | `chain_orders.js` | Destructure `{ op }`, handle null |
| `getOrdersByTypeAndState()` requires both args | `manager.js` | Ensure non-null arguments |
| `utils.js` split into `utils/` directory | `order/` | Update import paths |
| `tryDeductFromChainFree()` now async | `accounting.js` | Add `await` |
| `addToChainFree()` now async | `accounting.js` | Add `await` |

---

## Recommendations

### Before Merging to `dev`

1. **Audit all async call sites**
   ```bash
   # Find potential missing awaits for critical methods
   grep -rn "recalculateFunds\|_updateOrder\|tryDeductFromChainFree\|addToChainFree" modules/ \
     | grep -v "await" | grep -v "async"
   ```

2. **Check for stale `manager.orders` references**
   - Any code that caches `manager.orders` or its entries will have stale data after COW updates
   - Use `_gridVersion` for staleness detection

3. **Review `getOrdersByTypeAndState()` callers**
   - Ensure none pass `null` for type or state

4. **Verify `buildCreateOrderOp()` callers**
   - All callers must destructure `{ op }` and handle `null` returns

5. **Add integration tests for COW pattern**
   - Verify no performance regression under high-frequency updates
   - Verify no stale reference issues

### Testing Checklist

- [ ] Run full test suite: `npm test`
- [ ] Verify fund tracking accuracy after multiple fills
- [ ] Test recovery from simulated invariant violations
- [ ] Verify grid persistence/recovery cycle
- [ ] Test concurrent fill processing
- [ ] Verify no memory leaks from COW pattern (long-running test)

---

## Files Changed Summary

| File | Lines Changed | Risk |
|------|---------------|------|
| `modules/order/accounting.js` | ~800+ | HIGH |
| `modules/order/manager.js` | ~2000+ | HIGH |
| `modules/order/sync_engine.js` | ~400+ | MEDIUM |
| `modules/order/grid.js` | ~300+ | MEDIUM |
| `modules/chain_orders.js` | ~200+ | MEDIUM |
| `modules/account_orders.js` | ~100+ | LOW |
| `modules/dexbot_class.js` | ~500+ | MEDIUM |
| `modules/constants.js` | ~200+ | LOW |
| `modules/order/utils.js` | DELETED | HIGH |
| `modules/order/utils/*.js` | NEW | N/A |

---

## Conclusion

The `test` branch introduces significant architectural improvements (COW immutability, better state management, improved validation) but also several breaking changes and potential race conditions. A thorough audit of async call sites and integration testing is recommended before promoting to `dev`.

**Overall Assessment**: The changes are directionally correct but require careful review of the async conversion and COW pattern implications.
