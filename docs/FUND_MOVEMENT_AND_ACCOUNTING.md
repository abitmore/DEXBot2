# Unified Fund Movement & Accounting Guide

## Overview

This document provides a comprehensive technical guide to the fund accounting model, grid topology, order rotation mechanics, and safety systems in DEXBot2. It unifies the architectural logic with practical accounting principles to serve as the "Single Source of Truth" for developers.

---

## Part 1: Core Fund Accounting Model

### 1.1 The Single Source of Truth

**Rule: Each unit of capital has exactly ONE owner at any given time.**

Without proper accounting, bots risk insolvency (spending more than they have), double-counting capital, or losing track of proceeds.

### 1.2 Fund Components

| Component | Definition | Owner / Purpose |
|-----------|------------|----------------|
| **ChainFree** | Unallocated funds on blockchain | **Bot (Liquid Capital)**. The total balance available for new orders. |
| **Virtual** | Funds reserved for VIRTUAL orders | **Bot (Reserved)**. Capital allocated to orders that are internally tracked but not yet on-chain. |
| **Committed** | Funds in ACTIVE/PARTIAL orders | **Bot (Locked)**. Capital currently placed in orders on the blockchain. |
| **CacheFunds** | Reporting metric for fill proceeds | **Bot (Reporting)**. A subset of ChainFree that tracks profit/proceeds from fills. **NOT** a separate pool. |
| **FeesOwed** | Accumulated BTS fees | **Blockchain (Liability)**. Hard debt that must be paid. |
| **FeesReservation** | Buffer for future fees | **Bot (Safety)**. Reserved buffer to prevent getting stuck without fee capital. |

### 1.3 The Available Funds Formula

The most critical formula in the system defines what the bot is allowed to spend:

```javascript
// In utils.js calculateAvailableFundsValue()
const Available = Math.max(0,
    ChainFree                // Total unallocated funds on blockchain
    - Virtual                // - Funds reserved for pending VIRTUAL orders
    - btsFeesOwed            // - Hard fees waiting to be paid
    - btsFeesReservation     // - Buffer for future operations
    // NOTE: CacheFunds is NOT subtracted!
);
```

### 1.4 Why CacheFunds Is NOT Subtracted

A common misconception is that `CacheFunds` (fill proceeds) must be subtracted from `ChainFree` to find available funds. This is **incorrect** and leads to double-counting.

**The Logic:**
1. **Fill Occurs:** Blockchain balance increases by proceeds ($10). `ChainFree` increases by $10.
2. **Tracking:** `CacheFunds` increases by $10 to record "this $10 came from a fill".
3. **Calculation:** Since `ChainFree` already contains the $10, we use it directly.
   - If we subtracted `CacheFunds`, we would remove the capital we just earned: `(100 + 10) - 10 = 100`.
   - Correct: `(100 + 10) - 0 = 110`. The bot *should* use the proceeds.

### 1.5 Fund Invariants (Safety Checks)

The bot continuously monitors three mathematical invariants to detect leaks:

1.  **Account Equality:** $TotalChain \approx FreeChain + CommittedChain$ (Tolerance: 0.1%)
2.  **Committed Ceiling:** $CommittedGrid \leq TotalChain$ (Intended usage never exceeds wealth)
3.  **Available Leak:** $Available \leq FreeChain$ (Derived available never exceeds raw free balance)

---

## Part 2: Grid Topology & Sizing Logic

### 2.1 Grid Topology & Spread Gap

The grid is a unified array of `priceLevels` (Master Rail) rather than separate Buy/Sell rails.

-   **Spread Zone:** A buffer of locked slots between the best buy and sell.
    -   *Gap Size ($G$):* Determined by `incrementPercent` and `targetSpreadPercent`.
-   **Boundary Anchoring:** The grid centers around a `boundaryIdx`.
    -   **Buy Fill:** Shifts boundary down ($boundaryIdx - 1$).
    -   **Sell Fill:** Shifts boundary up ($boundaryIdx + 1$).

### 2.2 Global Side Capping

This mechanism ensures the bot never attempts to place orders beyond its liquid reality.

1.  **Budget Ceiling ($B$):** $\min(ConfigBudget, TotalWealth)$
2.  **Available Pool ($P$):** The fuel for growth.
    -   $P = ChainFree - Virtual - Fees$
3.  **Scaling Factor ($S$):** If the total capital increase required ($\Delta Total$) exceeds $P$:
    -   $S = P / \Delta Total$
    -   All order increases are multiplied by $S$, shrinking them to fit the wallet.

---

## Part 3: Order Rotation Mechanics

### 3.1 The "Crawl" Strategy

Rotation moves capital from "Surplus" (orders far from price) to "Shortage" (empty slots near price).

-   **Trigger:** If $PriceShortage$ is closer to market than $PriceSurplus$.
-   **Action:** Cancel Surplus -> Release Capital -> Place Shortage.

### 3.2 State Transitions (The Critical Path)

Correct state transitions are essential to prevent the "Double Spend" or "Lost Fund" problems.

**The Lifecycle of a Rotation:**

| Step | Old Order (Surplus) | New Order (Shortage) | Accounting Impact |
|------|---------------------|----------------------|-------------------|
| **1. Decision** | `ACTIVE` (Size: 100) | `EMPTY` | Capital is locked in Old. |
| **2. Transition** | `VIRTUAL` (Size: 0, OrderId: null) | `VIRTUAL` (Size: 100) | Old capital released; New capital reserved. |
| **3. Broadcast** | Cancel Op Sent | Place Op Sent | Blockchain processes changes. |
| **4. Sync** | Confirmed Cancelled | Confirmed `ACTIVE` | Internal state aligns with Chain. |

**Key Fix (Commit 5b4fc2f):**
We explicitly set the Old Order to `VIRTUAL` with `size: 0` *before* the New Order consumes funds. This atomic update ensures `Available` is calculated correctly during the transition.

### 3.3 Memory-Only Integer Tracking

To optimize performance and precision, the bot uses a **"memory-driven"** model:

-   **Raw Order Cache:** Stores exact satoshi values of on-chain orders.
-   **No Redundant Fetches:** Update/Rotation operations do *not* query the blockchain for current order state. They trust the internal `rawOnChain` cache.
-   **Self-Healing:** If an error occurs (state mismatch), the bot triggers a full `synchronizeWithChain()` to reset.

---

## Part 4: Partial Order Handling

Partial orders (filled < 100%) require special handling to avoid "dust" accumulation and capital fragmentation.

### 4.1 Dust vs. Significant

-   **Dust Threshold:** $< 5\%$ of Ideal Size.
-   **Action:** Treat as "empty" for logic purposes, merge back into pool when possible.

### 4.2 Side-Wide Double-Order Strategy

When a slot has a Partial order but needs to grow or shrink:

1.  **Merge (Dust):**
    -   If partial is dust, we overwrite it with a new standard-sized order.
    -   The dust amount is conceptually "released" into `CacheFunds`.
    -   The side is flagged as `Doubled` to allow an extra reaction order on the opposite side.

2.  **Split (Significant):**
    -   If partial is large, we resize it to exactly $SizeIdeal$.
    -   The "overflow" capital is placed as a **new** order at the adjacent slot.
    -   This keeps the original fill anchored (preserving queue position) while putting excess capital to work.

---

## Part 5: Concurrency & Safety

### 5.1 Protecting Against Races (TOCTOU)

**Problem:** Thread A checks funds ($100 avail). Thread B fills an order. Thread A spends $100.
**Solution:**
1.  **Atomic Operations:** Calculations and state updates happen synchronously in the event loop.
2.  **Startup Protection:**
    -   Flag `isBootstrapping = true` during startup.
    -   Fills arriving during startup are **queued**.
    -   Queue processes only after `isBootstrapping = false`.

### 5.2 Fee Management

-   **FeesOwed:** Tracked per fill. Deducted from `CacheFunds` first, then `ChainFree`.
-   **FeesReservation:** $N_{orders} \times Fee_{est}$. Subtracted from `Available` to ensure we can always cancel/update.

---

## Part 6: Best Practices & Testing

### 6.1 Debugging Fund Issues

1.  **Check Invariants:** Search logs for "Fund invariant violation".
2.  **Trace State:** Ensure `ACTIVE` -> `VIRTUAL` transitions happen atomically with `size: 0`.
3.  **Verify Formula:** Remember: $Available = ChainFree - Virtual$. Do NOT subtract CacheFunds.

### 6.2 Running Tests

The system has extensive test coverage for these mechanics.

```bash
# Run all fund-related tests
npm test

# Test specific mechanics
node tests/test_rotation_cachefunds.js       # Rotation logic
node tests/test_multifill_opposite_partial.js # Partial/Double logic
node tests/test_dust_rebalance_logic.js      # Dust handling
node tests/unit/accounting.test.js           # Core math
```

### 6.3 Verification

Enable fund snapshots in `debug` mode to see a tick-by-tick ledger of fund movements in the logs.

---
*Reference: Merged from `FUND_ACCOUNTING_AND_ROTATION.md` and `fund_movement_logic.md`.*
