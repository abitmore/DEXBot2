# Fund Accounting & Rotation Mechanics Guide

## Overview

This guide explains the fund accounting model and order rotation mechanism in DEXBot2. Understanding these concepts is critical for debugging fund-related issues, implementing new features, and understanding why certain safeguards exist.

---

## Part 1: Fund Accounting Model

### The Problem We Solve

Without proper fund accounting:
- Bots can become insolvent (spending more than they have)
- Capital can be double-counted (counted as both available AND reserved)
- Fills arriving concurrently with order placement can cause races
- Restarts can lose track of proceeds from trades

### Core Principle: Single Source of Truth

**Rule: Each unit of capital has exactly ONE owner at any given time.**

```
Possible owners of a unit of capital:
├── ChainFree: Not yet allocated to any order
├── Virtual: Allocated to VIRTUAL orders (not yet on-chain)
├── Committed (on-chain): Allocated to ACTIVE/PARTIAL orders on-chain
└── Fees: Allocated to pay transaction costs
```

### Fund Components

| Component | Example | Purpose | Who Owns It |
|-----------|---------|---------|-----------|
| **ChainFree** | 1000 BTS on-chain | Unallocated capital | Bot (ChainFree owner) |
| **Virtual** | 200 BTS reserved | Waiting for order confirmation | Bot (reserved for VIRTUAL orders) |
| **Committed (Chain)** | 300 BTS in active orders | Currently placed on-chain | Bot (committed to ACTIVE orders) |
| **CacheFunds** | 50 BTS from fill proceeds | *Part of ChainFree* | Bot (tracking metric only) |
| **FeesOwed** | 1 BTS to be paid | Hard liability | Blockchain (will deduct on next order) |

### The Available Funds Formula

```
Available = ChainFree - Virtual - InFlight - FeesOwed - FeesReservation
```

NOT included: `CacheFunds` (because it's already part of ChainFree)

### Why CacheFunds Is NOT Subtracted

**Before Fix (WRONG):**
```
Available = ChainFree - Virtual - CacheFunds - FeesOwed
```

This was wrong because:
1. A fill increases ChainFree by the proceeds amount
2. We also track those same proceeds in CacheFunds
3. Subtracting CacheFunds from ChainFree = **double-counting** as a reduction
4. Result: Available would be **artificially low** by 50-100%

**Example of the Bug:**
```
ChainFree: 1000 BTS
CacheFunds: 100 BTS (from fills)
Virtual: 0

OLD FORMULA (WRONG):
Available = 1000 - 0 - 100 = 900 BTS  ← Artificially low!

CORRECT FORMULA:
Available = 1000 - 0 - 0 = 1000 BTS   ← The 100 BTS is PART of the 1000
```

### After Fix (CORRECT)

```javascript
// In utils.js calculateAvailableFundsValue()
const available = Math.max(0,
    chainFree                // Unallocated funds on blockchain
    - virtual                // Funds reserved for VIRTUAL orders (off-chain)
    - btsFeesOwed            // Hard BTS fees to pay
    - btsFeesReservation     // Buffer reserved for future order creation fees
    // NO cacheFunds subtraction!
);
```

**Key Points:**
- **ChainFree is already "optimistic"** — it accounts for pending orders and reserved capital
- **CacheFunds is purely reporting** — it tells you "of the ChainFree, this much came from fills"—but doesn't change the calculation
- **Virtual** tracks VIRTUAL orders and ACTIVE orders that haven't been placed on-chain yet
- **Consolidated virtual tracking** — all reserved, off-chain capital is consolidated into virtual funds

---

## Part 2: Fund Lifecycle During Trading

### Scenario: A Sell Order Fills

**Initial State:**
```
ChainFree: 1000 BTS
Available: 950 BTS (after Virtual + Fees reserves)
CacheFunds: 0 BTS
```

**Fill Occurs:**
- Sell 10 USD at price 1.1
- Proceeds: 10 × 1.1 = 11 USD received

**State After Fill (Two Updates Happen Together):**
```
ChainFree: 1000 BTS (unchanged, blockchain balance is still on its way)
CacheFunds: 11 USD (tracked separately as "fill proceeds")
```

**State After Sync with Blockchain:**
```
ChainFree: 1011 USD (blockchain now shows the fill)
CacheFunds: 11 USD (still tracks that 11 came from fills)
Available: 961 USD (1011 - Virtual - Fees, still uses ONLY ChainFree)
```

### Scenario: Rotation Using CacheFunds

**Before Rotation:**
```
ChainFree: 1050 USD (includes 50 from previous fills)
CacheFunds: 50 USD (tracking the fill proceeds)
Available: 1000 USD
```

**Rotation Happens:**
1. Select order to move (surplus at worse price)
2. Calculate size for new order (closer to market)
3. When placing new order, deduct from Available
4. If Available >= OrderSize, deduct and proceed
5. New order gets placed using capital from ChainFree (which includes fill proceeds)

**After Rotation:**
```
ChainFree: 1050 USD (still the same, just redistributed)
CacheFunds: 50 USD (still tracks the profit)
Available: Uses only ChainFree in the formula
```

---

## Part 3: Order Rotation Mechanics

### What Is Rotation?

Rotation moves capital from one order to another without needing external funding:

```
Old Order (Surplus)          New Order (Shortage)
    100 BTS @ 0.95           empty @ 0.97
         ↓
    [Cancel & Place]
         ↓
       VIRTUAL                  VIRTUAL (new)
         ↓
   [Blockchain Confirms]
         ↓
       released                 ACTIVE
```

### State Transitions During Rotation

When an order is rotated:

**Old Order:**
```
Current:  { id: 'slot-5', state: 'ACTIVE', orderId: '1.7.123', size: 100 }
          ↓ (marked for replacement)
Target:   { id: 'slot-5', state: 'VIRTUAL', orderId: null, size: 0 }
          ↓ (after blockchain confirms)
Final:    { id: 'slot-5', state: 'VIRTUAL', orderId: null, size: 0 }
          (capital is released, slot is empty)
```

**New Order:**
```
Initial:  { id: 'slot-9', state: 'VIRTUAL', orderId: null, size: 150 }
          (created and placed on blockchain)
          ↓ (after blockchain confirms)
Final:    { id: 'slot-9', state: 'ACTIVE', orderId: '1.7.456', size: 150 }
          (capital is now committed to this order)
```

### Why This Order Matters

The timing of state changes is **critical** for fund accounting:

| Mistake | Result |
|---------|--------|
| **State not updated** | Bot thinks capital is still committed; refuses to use it → Grid can't grow |
| **State updated before broadcast** | Bot tries to use capital twice → Fund violations |
| **State with wrong size** | Available calculations become incorrect |
| **State updated but no sync check** | Bot thinks order is cancelled before blockchain confirms |

### The Fix (Commit 5b4fc2f)

Before this commit, rotations would NOT update the old order's state:

```javascript
// OLD CODE (WRONG):
// After rotation, old order remains as:
// { id: 'slot-5', state: 'ACTIVE', orderId: '1.7.123', size: 100 }
// Bot thinks: "This 100 is still committed, can't use it elsewhere"
// Result: Grid can't grow, rotation fails
```

After the fix, old order is properly marked as released:

```javascript
// NEW CODE (CORRECT):
stateUpdates.push({
    id: 'slot-5',
    state: ORDER_STATES.VIRTUAL,
    size: 0,
    orderId: null
});
// Bot now knows: "This slot's capital is released"
// Result: Capital can be reused for new placements
```

---

## Part 4: Protecting Against Races

### The TOCTOU Problem

**TOCTOU = Time-Of-Check-Time-Of-Use**

A race can occur when:
1. Check: "Do I have 100 units free?"
2. **Other thread acts**
3. Use: "Spend 100 units"

If the other thread changed the state between check and use, the decision becomes invalid.

### Example: Startup Race

```
Timeline:

T1. Bot starts up
T2. Load persisted grid (assumes certain state)
T3. User makes a trade (fill arrives)
T4. Bot syncs with blockchain (discovers new state)
T5. Bot updates grid

Problem: At T5, bot's grid may be based on stale assumptions from T2
```

### How We Protect

**Old Approach (Commit a4675ce):**
- Hold `_fillProcessingLock` for entire startup duration (~1-5 seconds)
- Fills arriving during startup are **queued** (can't acquire lock)
- After startup completes, fills are **processed**

**New Approach (Commit c7e7188):**
- Use `isBootstrapping` flag instead of holding lock
- Fills arriving during startup are still **queued** (flag checked before processing)
- No lock held, but same effect: fills don't process until bootstrap completes
- More efficient: eliminates lock contention during long startup

**Benefit:**
```
Startup Operations → (Fills queue) → Bootstrap completes → Fills process

With proper state at each step, no race can occur
```

---

## Part 5: Best Practices

### When Adding New Features

1. **Identify Fund Owners**
   - Which component owns each unit of capital?
   - When does ownership transfer?

2. **Check State Transitions**
   - When do order states change?
   - Is the state change atomic with fund deductions?
   - Does `recalculateFunds()` get called after?

3. **Protect Against Races**
   - Could a fill arrive during your operation?
   - Should you check `isBootstrapping`?
   - Should you use a lock?

4. **Verify Fund Invariants**
   - After your change, do the invariants still hold?
   - Run: `npm test` to verify

### When Debugging Fund Issues

**Check in this order:**

1. **State Transitions**
   ```
   Order state changes should be atomic:
   - Old order: ACTIVE → VIRTUAL (with size: 0)
   - New order: VIRTUAL → ACTIVE (with new orderId)
   ```

2. **Fund Calculations**
   ```
   Available should never exceed ChainFree
   Available = ChainFree - Virtual - InFlight - Fees
   (NOT including CacheFunds)
   ```

3. **Recalculation Calls**
   ```
   After fund-affecting operations, recalculateFunds() must be called
   This recomputes all derived values
   ```

4. **Invariant Violations**
   ```
   Check logs for: "Fund invariant violation"
   This indicates a fund leak or accounting error
   ```

---

## Part 6: Testing Fund Accounting

### Run All Tests

```bash
npm test
```

This runs 25+ test suites including:
- Fund calculation tests
- Rotation state tests
- Partial order handling tests
- Fund invariant verification

### Run Specific Fund Tests

```bash
# Test rotation with cacheFunds
node tests/test_rotation_cachefunds.js

# Test multi-fill opposite partial
node tests/test_multifill_opposite_partial.js

# Test dust rebalancing
node tests/test_dust_rebalance_logic.js
```

### Verify Fund Snapshot History

Enable fund snapshots in debug mode:

```javascript
// In dexbot_class.js initialize()
this.manager._snapshotHistory.enabled = true;
// Then check logs for fund state changes
```

---

## Part 7: Quick Reference

### Fund Formula
```
Available = ChainFree - Virtual - InFlight - FeesOwed - FeesReservation

CacheFunds: Reporting only, NOT subtracted (already part of ChainFree)
```

### Rotation State Flow
```
Old Order: ACTIVE → VIRTUAL (size: 0, orderId: null)
New Order: VIRTUAL → ACTIVE (size: calculated, orderId: on-chain)
```

### Protection Mechanisms
```
1. Fund Invariant Checks (continuous)
2. Atomic State Transitions (per rotation)
3. Fund Recalculation (after operations)
4. Bootstrap Flag (during startup)
5. Lock (during sync operations)
```

### Common Mistakes
```
❌ Subtracting CacheFunds from Available
❌ Not updating old order state during rotation
❌ Forgetting to call recalculateFunds()
❌ Not checking isBootstrapping in fill processing
✓ Use only ChainFree in calculations
✓ Always transition states atomically
✓ Always call recalculateFunds() after fund changes
✓ Check isBootstrapping before processing fills
```

---

## Additional Resources

- **[fund_movement_logic.md](fund_movement_logic.md)** - Technical architecture details
- **[developer_guide.md](developer_guide.md)** - Complete developer guide
- **[TEST_UPDATES_SUMMARY.md](TEST_UPDATES_SUMMARY.md)** - Test suite documentation
- **GitHub Commits:**
  - `5b4fc2f` - Fund accounting fix and rotation state transitions
  - `c7e7188` - Startup lock optimization

---

## Questions?

Refer to test cases for working examples of fund accounting and rotation:
- `tests/test_rotation_cachefunds.js`
- `tests/test_multifill_opposite_partial.js`
- `tests/test_dust_rebalance_logic.js`
