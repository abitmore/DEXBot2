# DEXBot2 Fund Movement & Accounting Technical Reference

## 1. Core Accounting Model

The accounting system is designed around a **Single Source of Truth** principle with **Optimistic Execution**. It prevents double-spending while maximizing capital efficiency by treating pending proceeds as immediately available ("Optimistic ChainFree").

### 1.1 Fund Components

| Component | Code Reference | Definition & Ownership |
|-----------|----------------|------------------------|
| **ChainFree** | `accountTotals.buyFree` | **Liquid Capital**. The unallocated balance on the blockchain. <br> *Balanced:* Deducted pre-emptively on fills to offset state release. |
| **Virtual** | `funds.virtual` | **Planned Capital**. Sum of sizes for orders in `VIRTUAL` state. <br> *Purpose:* Prevents `ChainFree` from being re-spent on overlapping grid layers. |
| **Committed (Chain)** | `funds.committed.chain` | **Locked Capital**. Sum of sizes for `ACTIVE` + `PARTIAL` orders (including those without `orderId` yet). <br> *Source:* Real-time grid state + on-chain orders. |
| **Committed (Grid)** | `funds.committed.grid` | **Strategy Capital**. Alias for `committed.chain` in the current engine. |
| **CacheFunds** | `funds.cacheFunds` | **Reporting Metric**. Cumulative fill proceeds and rotation surpluses. <br> *Note:* Physically part of `ChainFree`. Used for profit tracking and fee deduction prioritization. |
| **FeesOwed** | `funds.btsFeesOwed` | **Liability**. Accumulated blockchain fees (BTS) that must be settled. |
| **FeesReservation** | `btsFeesReservation` | **Safety Buffer**. Reserved BTS to ensure future grid operations (creation/cancellation) don't fail. |

### 1.2 The Available Funds Formula

This formula determines the bot's spending power. It is calculated atomically in `utils.js::calculateAvailableFundsValue`.

$$Available = \max(0, \text{ChainFree} - \text{Virtual} - \text{FeesOwed} - \text{FeesReservation})$$

**Critical Invariants:**
1.  **CacheFunds is NOT subtracted.** Since fill proceeds are added to `ChainFree`, subtracting `CacheFunds` would be double-counting (removing the capital you just earned).
2.  **Virtual represents Plan.** Orders remain in `Virtual` only while they are truly uncommitted. As soon as they move to `ACTIVE`, they move to `Committed` (Chain), even if the blockchain transaction is still in flight. This maintains the `Total = Free + Committed` invariant.

---

## 2. Grid Topology & Geometric Sizing

The grid is a unified array ("Master Rail") of price levels, not separate Buy/Sell arrays.

### 2.1 Geometric Weighting Formula

Order sizes are calculated using a geometric progression to distribute risk.

**Inputs:**
-   $N$: Number of orders
-   $Total$: Total budget for side
-   $w$: Weight Distribution parameter (`-1` to `2`)
-   $inc$: Increment factor (`incrementPercent / 100`)

**Base Factor:**
$$base = 1 - inc$$

**Raw Weight ($W_i$):**
For each slot $i$ from $0$ to $N-1$:
$$W_i = base^{(i \times w)}$$

**Orientation:**
-   **SELL Side:** Normal indexing ($i=0$ is market-closest).
-   **BUY Side:** Reversed indexing ($i=N-1$ is market-closest) to ensure heaviest weights are always near the spread.

**Final Size ($S_i$):**
$$S_i = \left( \frac{W_i}{\sum W} \right) \times Total$$

### 2.2 Spread Gap & Boundary

The grid is divided into zones by a dynamic **Boundary Index**.

-   **Gap Size ($G$):** Calculated from `targetSpreadPercent` and `incrementPercent`.
    $$G = \lceil \frac{\ln(1 + \text{targetSpread})}{\ln(1 + \text{increment})} \rceil$$
    *(Min capped at `MIN_SPREAD_ORDERS`, usually 2)*

-   **Zones:**
    -   **BUY:** Indices $[0, \text{boundaryIdx}]$
    -   **SPREAD:** Indices $[	ext{boundaryIdx}+1, \text{boundaryIdx}+G]$
    -   **SELL:** Indices $[	ext{boundaryIdx}+G+1, N]$

---

## 3. The Strategy Engine (Boundary-Crawl Algorithm)

The rebalancing logic (`strategy.js::rebalanceSideRobust`) executes the "Crawl" strategy.

### 3.1 Boundary Shift (The Crawl)
When a fill occurs, the boundary shifts to "follow" the price.
-   **BUY Fill:** Market moved down $\to$ `boundaryIdx--` (Shift Left).
-   **SELL Fill:** Market moved up $\to$ `boundaryIdx++` (Shift Right).

### 3.2 Global Side Capping
Budgets are dynamic. The bot calculates `TotalSideBudget` based on `ChainFree` + `Committed`.

**Safety Check:**
If the calculated ideal grid requires more capital than is available, the *increase* is capped.
$$Increase_{capped} = \min(Ideal - Current, Available)$$

### 3.3 The Rotation Cycle
Rotations move capital from "Surplus" (useless) to "Shortage" (needed).

1.  **Identify Shortages:** Empty slots *inside* the active window (near boundary).
2.  **Identify Surpluses:** Active orders *outside* the window (far edges).
3.  **Sort:**
    -   Shortages: Closest to market first.
    -   Surpluses: Furthest from market first.
4.  **Execute:**
    For each pair (Surplus $S$, Shortage $T$):
    -   **Atomic Transition:**
        -   $S$ state: `ACTIVE` $\to$ `VIRTUAL` (size 0, releases funds).
        -   $T$ state: `VIRTUAL` (size $S_{size}$, reserves funds).
    -   **Fund Calculation:**
        -   The released funds from $S$ are immediately added to `ChainFree`.
        -   The reserved funds for $T$ are immediately subtracted (added to `Virtual`).

---

## 4. Partial Order Handling

The system treats partial orders differently based on their remaining size relative to the "Ideal" size for that slot.

### 4.1 Dust Detection
A partial order is "Dust" if:
$$Size_{current} < Size_{ideal} \times 0.05$$

### 4.2 Dust Consolidation (Merge)
**Trigger:** Dust partial exists in a target slot.
**Action:**
1.  Calculate `Deficit = Ideal - Current`.
2.  Cap `Increase = min(Deficit, Available)`.
3.  Update order size: `NewSize = Current + Increase`.
4.  **Flag Side as Doubled** (`buySideIsDoubled = true`).

**Effect of Doubling:**
The *opposite* side receives a `ReactionCap` bonus (+1). This allows the bot to place an extra order on the other side to "capture" the liquidity provided by this consolidation.

### 4.3 Significant Partial (Split)
**Trigger:** Non-dust partial exists in a target slot.
**Action:**
1.  The existing partial order stays anchored at its price (maintains queue priority).
2.  The *excess* ideal size (`Ideal - Current`) is treated as a "Split".
3.  A **New Order** is placed at the *adjacent* price level with the split size.

---

## 5. Fee Management

The bot manages two types of fees: **Blockchain Fees** (BTS) and **Market Fees** (Asset deduction).

### 5.1 BTS Fees (Blockchain Operations)
BitShares charges fees for `limit_order_create` and `limit_order_cancel`.

-   **Reservation:**
    $$Reserve = N_{active} \times Fee_{create} \times Multiplier$$
    *(Multiplier defaults to ~2.0 to cover rotation cancel+create)*

-   **Settlement (`deductBtsFees`):**
    1.  Check `Funds.btsFeesOwed`.
    2.  Deduct from `CacheFunds` first (profit).
    3.  If insufficient, deduct remainder from `ChainFree` (capital).

### 5.2 Market Fees (Trade Cost)
These are deducted from the *proceeds* of a fill.

-   **Maker (Limit Orders):** Typically lower fee (e.g., 0.1%).
    -   **Rebate:** On BitShares, Makers often get a fee rebate on cancellation (vesting).
-   **Taker (Market Orders):** Typically higher fee.
-   **Calculation (`processFilledOrders`):**
    ```javascript
    GrossProceeds = Size * Price
    NetProceeds = GrossProceeds - (GrossProceeds * FeePercent)
    ```

---

## 6. Safety & Invariants

The `Accountant` enforces strict mathematical invariants to detect bugs or manual interference.

### 6.1 The Equality Invariant
Total funds on chain must equal free plus committed.
$$Total_{chain} = Free_{chain} + Committed_{chain}$$
*(Balanced Logic: The system handles high-concurrency races without drift by pre-deducting spent capital.)*

### 6.2 The Ceiling Invariant
Grid commitment cannot exceed total wealth.
$$Committed_{grid} \leq Total_{chain}$$

### 6.3 Race Condition Protection (TOCTOU)
To prevent "Time-of-Check to Time-of-Use" errors:
1.  **Locking:** `AsyncLock` prevents concurrent updates to the same order.
2.  **Atomic Deduct:** `tryDeductFromChainFree` checks *and* subtracts in a single synchronous step.
3.  **Bootstrapping:** Fills arriving during startup (`isBootstrapping=true`) are queued until the grid is fully reconciled.

---
*Technical Reference for DEXBot2 v0.7+*
