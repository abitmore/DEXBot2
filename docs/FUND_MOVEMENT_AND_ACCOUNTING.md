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

## 1.3 Mixed Order Fund Validation (Patch 12)

**Problem Fixed**: When `_buildCreateOps()` received both BUY and SELL orders in a batch, it used a single fund check on the first order's type, causing false fund warnings.

**Solution**: Separate validation per order type (Patch 12, commit 701352b).

### Fund Availability Checks by Order Type

**BUY Orders** validate against `buyFree` (assetB capital):
```
buyFree represents unallocated assetB available for limit orders
```

**SELL Orders** validate against `sellFree` (assetA inventory):
```
sellFree represents unallocated assetA available for limit orders
```

### Implementation Location

File: `modules/dexbot_class.js::_buildCreateOps()` (lines 1516-1548, Patch 12)

```javascript
// Separate BUY and SELL orders
const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);
const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);

// BUY orders: check assetB capital (buyFree)
if (buyOrders.length > 0) {
    const buyTotal = buyOrders.reduce((sum, o) => sum + o.size, 0);
    if (buyTotal > this.accountTotals.buyFree) {
        // Log fund warning specific to BUY side
    }
}

// SELL orders: check assetA inventory (sellFree)
if (sellOrders.length > 0) {
    const sellTotal = sellOrders.reduce((sum, o) => sum + o.size, 0);
    if (sellTotal > this.accountTotals.sellFree) {
        // Log fund warning specific to SELL side
    }
}
```

### Key Points

1. **Each order validated independently** against its own type's available funds
2. **No double-counting** when both BUY and SELL orders are placed simultaneously
3. **Accurate warnings** showing which side lacks funds (BUY vs SELL)
4. **Prevents false positives** where mixed placements incorrectly appear to exceed available capital

### Helper Reference

For checking order types and states, use centralized helpers from `modules/order/utils.js`:
- `isOrderOnChain()` - Check if ACTIVE or PARTIAL
- `isOrderPlaced()` - Check if safely placed (on-chain with ID)
- `isOrderVirtual()` - Check if VIRTUAL state

See [developer_guide.md#order-state-helper-functions-patch-11](developer_guide.md#order-state-helper-functions-patch-11) for complete helper function reference.

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
    $$G = \lceil \frac{\ln(1 + \text{targetSpread}/100)}{\ln(1 + \text{increment}/100)} \rceil - 1$$
    *(Min capped at `MIN_SPREAD_ORDERS`, usually 2. The $-1$ accounts for the naturally occurring center gap during grid centering)*

-   **Zones:**
    -   **BUY:** Indices $[0, \text{boundaryIdx}]$
    -   **SPREAD:** Indices $[\text{boundaryIdx}+1, \text{boundaryIdx}+G]$ (Total of $G+1$ actual gaps)
    -   **SELL:** Indices $[\text{boundaryIdx}+G+1, N]$

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

## 5.3 BTS Fee Object Structure (Patch 8)

For BTS fees, the system returns a structured object (not a simple number) with multiple fields for accounting precision.

**Location**: `modules/order/utils.js::getAssetFees()`

### BTS Fee Object (Always Object)

```javascript
getAssetFees('BTS', amount)
// Returns:
{
    total: 500,              // Old field: total fee (preserved for compatibility)
    createFee: 500,          // Old field: single create fee (preserved)
    netFee: 450,             // Old field: net fee after processing
    netProceeds: 45500,      // NEW FIELD (Patch 8): proceeds after fee
    isMaker: true            // Flag: is this a maker fee?
}
```

### netProceeds Calculation (Patch 8)

**For Makers** (isMaker = true, gets 90% rebate):
```
netProceeds = assetAmount + (creationFee * 0.9)
// Example: 45,000 asset + (500 fee * 0.9 refund) = 45,450
```

**For Takers** (isMaker = false, no rebate):
```
netProceeds = assetAmount
// Example: 45,000 asset (no refund) = 45,000
```

### Non-BTS Fees (Unchanged)

Non-BTS assets continue to return simple numbers:

```javascript
getAssetFees('IOB.XRP', 1000)
// Returns: 990  (number, not object)

getAssetFees('USD')
// Returns: 995  (number, not object)
```

### Backwards Compatibility

Code can safely detect the fee type:

```javascript
// Check if BTS (object) or asset (number)
if (typeof feeInfo === 'object') {
    // BTS: Use netProceeds field
    const proceeds = feeInfo.netProceeds;
} else {
    // Asset: Use direct number
    const proceeds = assetAmount - feeInfo;
}

// OR use older fields (still present)
const legacyFee = feeInfo.createFee;  // Works for both old and new code
```

---

## 5.4 BUY Side Sizing & Fee Accounting (Patch 8)

**Problem Fixed**: BUY side fee calculations incorrectly applied fees to base asset instead of quote asset.

**Solution**: Corrected fee accounting with proper asset assignment.

### Fee Application by Side

| Side | Asset | Calculation | Notes |
|------|-------|-------------|-------|
| **BUY** | Quote (assetB) | Fee deducted from `buyFree` | Buyers pay in quote currency |
| **SELL** | Base (assetA) | Fee deducted from `sellFree` | Sellers pay in base currency |

### Example Scenario

```
Trading pair: XRP (base) / USD (quote)

BUY Order Fills:
- Receives: 1000 XRP
- Pays: 45,000 USD
- Fee: 500 USD (0.1% of 45,500 total)
- Net proceeds: 45,000 USD (quoted asset reduced by fee)

SELL Order Fills:
- Receives: 45,000 USD
- Pays: 1000 XRP
- Fee: 1 XRP (0.1% of 1000 total)
- Net proceeds: 999 XRP (base asset reduced by fee)
```

### Maker Refund Impact on BUY Orders

For BUY orders that are makers:

```javascript
// Market fill amount: 45,500 USD worth
// Maker fee: 500 USD (0.1%)
// Maker refund: 90% of 500 = 450 USD back

// Net proceeds to chainFree:
// - Deposit: 45,500 USD (market received)
// - Fee paid: -500 USD
// - Refund received: +450 USD
// - Final: 45,450 USD credited to buyFree
```

**Impact**: Ensures internal ledgers match blockchain totals exactly, preventing accounting drift from fee variances.

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
