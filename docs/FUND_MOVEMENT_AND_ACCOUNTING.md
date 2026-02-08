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

## 1.4 Fill Batch Processing & Cache Fund Timeline (Patch 17)

### Problem Solved

Previously, fills were processed one-at-a-time (~3s per broadcast). A burst of 29 fills in the Feb 7 market crash took ~90 seconds, during which:
- Market prices moved significantly
- Orders became stale (filled on-chain but not yet synced)
- Orphan fills were created (fill events for orders no longer on-chain)
- Fund tracking diverged from blockchain reality

**Impact**: The extended 90s window meant the bot couldn't react to market moves, creating a cascading failure.

### Solution: Adaptive Batch Fill Processing

**Mechanism** (`modules/dexbot_class.js::processFilledOrders`): Groups fills into stress-scaled batches before executing the full rebalance pipeline.

**Batch Sizing Algorithm**:
```javascript
// Determine batch size based on queue depth using BATCH_STRESS_TIERS
const batchSize = findBatchSize(queueDepth, BATCH_STRESS_TIERS);
// Example tiers: [[0,1], [3,2], [8,3], [15,4]]
// queueDepth=5 → batchSize=2
// queueDepth=20 → batchSize=4
```

**Configuration** (`modules/constants.js`):
```javascript
FILL_PROCESSING: {
  MAX_FILL_BATCH_SIZE: 4,           // Hard cap on batch size
  BATCH_STRESS_TIERS: [             // Adaptive sizing
    [0, 1],   // 0-2 fills awaiting: batch size 1 (legacy sequential)
    [3, 2],   // 3-7 fills awaiting: batch size 2
    [8, 3],   // 8-14 fills awaiting: batch size 3
    [15, 4]   // 15+ fills awaiting: batch size 4
  ]
}
```

### Fill Batch Processing Timeline

**Per-Batch Execution**:

1. **Peek & Pop**: Check `_incomingFillQueue`, pop up to N fills (batch size)
2. **Single Accounting Pass**: Call `processFillAccounting()` once for all N fills
   - All proceeds credited to `cacheFunds` in one operation
   - All proceeds immediately available to next rebalance cycle (not split across cycles)
3. **Single Rebalance**: Call `rebalanceSideRobust()` once
   - Sizes replacement orders using combined proceeds
   - Applies rotations and boundary shifts
4. **Batch Broadcast**: Call `updateOrdersOnChainBatch()` once
   - All new orders + cancellations in single operation
5. **Persist**: Call `persistGrid()` to save grid state
6. **Loop**: Continue with next batch (or idle if queue empty)

**Result**: 29 fills now processed in ~8 broadcasts (~24s) instead of 29 broadcasts (~90s).

### Cache Fund Crediting (Critical Detail)

All fill proceeds from a batch are credited to `cacheFunds` simultaneously:
```
cacheFunds += proceeds[fill1] + proceeds[fill2] + ... + proceeds[fillN]
```

This means:
- ✅ **All proceeds available immediately** in the same rebalance cycle
- ✅ **No "wait next cycle"** delays for fund availability
- ✅ **Single rebalance uses combined capital** for sizing calculations
- ✅ **Rotation surplus also uses combined pool** for optimal placement

### Recovery Retry System (Patch 17)

**Problem**: One-shot `_recoveryAttempted` boolean flag meant permanent lockup if recovery failed once.

**New Behavior**: Count+time-based retry system with periodic reset.

**State Machine**:
```
INITIAL (count=0, time=0)
    ↓
RECOVERY_FAILED (count++, time=now) ← Recovery attempted but failed
    ↓ (wait 60s)
READY_RETRY (count < 5 and time_elapsed ≥ 60s) ← Time passed, can retry
    ↓
RECOVERY_ATTEMPTED (increment count) ← Attempt retry
    ↓ (on fail) ← Success not yet
    ↓ ← Loops back to RECOVERY_FAILED
    ↓ (on success)
RESET via resetRecoveryState() ← Recovery succeeded, reset for next episode
```

**Configuration** (`modules/constants.js`):
```javascript
PIPELINE_TIMING: {
  RECOVERY_RETRY_INTERVAL_MS: 60000,  // Min 60s between retry attempts
  MAX_RECOVERY_ATTEMPTS: 5            // Max 5 retries per episode (0 = unlimited)
}
```

**Reset Points** (Called by `resetRecoveryState()` in `modules/order/accounting.js`):
1. **Fill-triggered**: Every fill in `processFilledOrders()` resets recovery state
2. **Periodic**: Blockchain fetch loop resets state every 10 minutes (even if no fills)
3. **Bootstrap completion**: After grid initialization

**Impact**: 
- ✅ If recovery fails, bot retries every 60s instead of requiring manual restart
- ✅ Self-heals within minutes after market settles
- ✅ No permanent lockup from single failure

### Stale-Cleaned Order ID Tracking (Patch 17)

**Problem**: During batch execution failure, cleanup freed slots. Then delayed orphan fill events credited proceeds AGAIN = double-count.

**Solution**: Track stale-cleaned order IDs using timestamp-based TTL.

**Data Structure** (`modules/dexbot_class.js`):
```javascript
_staleCleanedOrderIds = new Map();  // orderId → cleanupTimestamp
```

**Lifecycle**:
1. Batch fails: "Limit order X does not exist" error
2. Cleanup: Release slot, record `orderId + timestamp` in `_staleCleanedOrderIds`
3. Delayed Orphan: Fill event arrives for cleaned order
4. Guard Check: `_staleCleanedOrderIds.has(orderId)` → true
5. Skip Credit: Orphan handler skips crediting proceeds

**TTL Pruning**: Old entries pruned every 5 minutes to prevent unbounded map growth.

**Impact**:
- ✅ Eliminates double-counting root cause
- ✅ Handles delayed orphan events
- ✅ Prevents 47,842 BTS drift cascades

---

## 1.5 Cache Remainder Accuracy During Capped Resize (Patch 18)

### Problem Fixed

When grid resize was capped by available funds, the cache remainder was computed from ideal sizes instead of actual allocated sizes. This led to:
- Understated cache funds in tracking
- Skewed sizing decisions in subsequent cycles
- Inaccurate available fund calculations

### Solution: Per-Slot Tracking

**Old Behavior** (Incorrect):
```javascript
// Compute cache remainder from ideal sizes
const cacheRemainder = totalIdealSizes - totalAllocatedSizes;
// Problem: If actual allocation capped at 80% due to insufficient funds,
// this uses 100% ideal in calculation → cache overstated
```

**New Behavior** (Correct):
```javascript
// Track per-slot applied sizes
const appliedSizes = [];
for (const slot of slots) {
    const appliedSize = min(idealSize[slot], availableFundsRemaining);
    appliedSizes.push(appliedSize);
    availableFundsRemaining -= appliedSize;
}

// Compute cache remainder from actual allocated values
const cacheRemainder = totalIdealSizes - sum(appliedSizes);
// Result: Reflects true remaining capacity for next cycle
```

**Impact**:
- ✅ Cache remainder accurately reflects what was NOT allocated due to fund caps
- ✅ Next rebalance cycle gets correct available fund picture
- ✅ No skewed sizing decisions

---



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

#### Batch Sizing Impact (Patch 18)

During fill batch rebalancing, the cache remainder (amount NOT allocated due to fund caps) affects available funds for the next cycle:

**Cache Remainder Calculation**:
- **Old (Patch 17)**: Computed from ideal sizes even when resize was capped
- **New (Patch 18)**: Tracked per-slot, derived from actual allocated values

**Effect on Side Capping Formula**:
```javascript
// In next rebalance cycle:
availableFunds = chainFree - virtual - feesOwed - feesReservation
sideIncrease = min(idealSide - currentSide, availableFunds)

// When batch capping applied in previous cycle:
// availableFunds now correctly reflects the unfulfilled allocation gap
```

**Example**:
```
Cycle N (Batch Processing):
- Ideal grid total: 1000 BTS
- Available funds: 600 BTS
- Allocate: 600 BTS (per-slot tracking)
- Cache remainder: 400 BTS (1000 - 600)

Cycle N+1:
- Cache remainder (400 BTS) available for next allocation
- Prevents "stuck fund" situations where capital appeared allocated but wasn't
```

**Impact**:
- ✅ Accurate cache fund availability for next rebalance
- ✅ No overstated fund capping in subsequent cycles
- ✅ Smooth rebalancing when market moves expand/contract positions

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

### 3.4 Edge-First Surplus Sorting (Patch 18)

**Change**: Prioritize furthest-from-market surpluses (lowest Buy / highest Sell) for rotations.

**Reason**: Improves execution robustness by using stable edge orders for rotations and leaving volatile inner surpluses to potentially catch "surplus fills" during grid shifts.

**Impact**:
- ✅ More stable rotation candidates (outer orders less likely to be filled mid-operation)
- ✅ Inner surpluses remain available for spontaneous fill opportunities
- ✅ Reduces unnecessary churn on volatile price action

### 3.5 Victim Cancel Safety Logic (Patch 18)

**Change**: Explicitly detect and cancel "victim" dust orders when a rotation targets an occupied slot.

**Reason**: Maintains 1-to-1 mapping between grid slots and blockchain orders in the Edge-First system, preventing "ghost" capital on-chain.

**Implementation**:
```javascript
// If rotation target slot has an order (victim), cancel it first
if (targetSlot.orderId) {
    scheduleCancel(targetSlot);
    targetSlot.state = VIRTUAL;  // Prepare slot for new order
}

// Then place new order at target
targetSlot.state = ACTIVE;
targetSlot.orderId = newOrderId;
```

**Impact**:
- ✅ Prevents "ghost" capital lingering on-chain
- ✅ Ensures grid slot ↔ blockchain order 1-to-1 mapping
- ✅ No orphaned capital in rotation operations

---

## 3.7 Orphan-Fill Deduplication & Double-Credit Prevention (Patch 17)

**Location**: `modules/dexbot_class.js` (constructor, `_handleBatchHardAbort()`, batch failure handler)

### Problem Solved

During Feb 7 market crash, stale-order batch failures cascaded into double-crediting:

**Scenario**:
1. Batch operation scheduled with 12 orders
2. Order X is on-chain, included in batch
3. Between sync and broadcast, order X fills on market (stale order)
4. Batch execution fails: "Limit order X does not exist"
5. Error handler: Clean up grid slot X, release funds to `chainFree`
6. Meanwhile, fill event arrives: "Order X was filled at price Y for amount Z"
7. Orphan-fill handler: Credits proceeds to `cacheFunds` AGAIN
8. **Result**: Double-credit of proceeds, inflated `trackedTotal`, fund drift

**In Crash Numbers**: 7 orphan fills × ~700 BTS = ~4,600 BTS inflated → cascaded to 47,842 BTS total drift.

### Solution: Stale-Cleaned Order ID Tracking with TTL

**Mechanism**: Track which orders were cleaned up during batch failure recovery using timestamp retention.

**Data Structure** (`modules/dexbot_class.js`):
```javascript
// Map of orderId → cleanupTimestamp
_staleCleanedOrderIds = new Map();
```

**Cleanup Process** (When batch fails):
```javascript
// In _handleBatchHardAbort() or batch error handler:
1. Parse error message for stale order IDs (e.g., "Limit order 12345 does not exist")
2. For each stale ID:
   - Find & clean grid slot (convert to SPREAD placeholder)
   - Record: _staleCleanedOrderIds.set(orderId, Date.now())
   - Log: "Cleaned stale order X from slot"
3. Periodically prune entries > 5 minutes old
```

**Orphan-Fill Handler Check**:
```javascript
// In orphan-fill event processing:
if (_staleCleanedOrderIds.has(orderId)) {
    logger.info(`[ORPHAN-FILL] Skipping double-credit for stale-cleaned order ${orderId}`);
    return;  // Don't credit proceeds
}

// Only credit if NOT in stale-cleaned map
logger.info(`[ORPHAN-FILL] Processing orphan ${orderId}, crediting ${proceeds}`);
cacheFunds += proceeds;
```

### Why This Works

1. **Delayed Orphans**: Fill events can arrive minutes after batch failure (network latency)
2. **TTL Pruning**: Map doesn't grow unbounded; entries removed after 5 minutes
3. **ID-Based**: Works with any error format (different BitShares versions have different error messages)
4. **Explicit Logging**: "Skipping double-credit" messages create audit trail

### Double-Check: Cache Remainder

The `cacheFunds` itself is protected by cache remainder tracking (see §1.5):
- Cache proceeds are only released when allocated to orders
- Stale-cleaned orders don't consume allocation funds
- Next cycle sees correct remaining cache for sizing decisions

### Impact

- ✅ **Eliminates double-counting root cause** that fed 47,842 BTS drift
- ✅ **Handles network-latent orphan events** (not just immediate fills)
- ✅ **No fund corruption** from delayed fill events after batch failure
- ✅ **Production stability** after market crashes and stale order cascades

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
2.  The anchored order is topped up toward ideal size with capped increase:
    $$Increase_{capped} = \min(Ideal - Current, Available)$$
3.  A **New Order** is placed at the *adjacent* price level with the **old anchored size** (`Current`).
4.  Operationally, surplus/cache consumption for this action tracks the **net increase** (`Increase_{capped}`), while the split leg preserves queue-shaping structure.

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

## 5.5 Precision & Quantization (Patch 14)

**Problem**: Floating-point arithmetic accumulates rounding errors over many calculations. After dozens of order size calculations, price derivations, and fund allocations, float values drift from their true blockchain integer representations, causing mismatches between internal state and on-chain reality.

**Solution**: Centralized quantization utilities that eliminate float accumulation by round-tripping through blockchain integer representation.

### 5.5.1 Core Quantization Functions

**Location**: `modules/order/utils/math.js` (lines 77-102)

#### `quantizeFloat(value, precision)` - Eliminate Accumulation Errors

Converts float → blockchain int → float to "snap" values to precision boundaries.

```javascript
/**
 * Quantize a float value by round-tripping through blockchain integer representation.
 * Converts float → blockchain int (satoshi-level precision) → float.
 * Eliminates floating-point accumulation errors.
 *
 * @param {number} value - Float value to quantize (e.g., 45.123456789)
 * @param {number} precision - Asset precision (e.g., 8 for satoshis)
 * @returns {number} Quantized float value (e.g., 45.12345679)
 */
function quantizeFloat(value, precision) {
    return blockchainToFloat(floatToBlockchainInt(value, precision), precision);
}

// Example:
// Input: 45.123456789 (accumulated float error)
// Step 1: Float → Int: 45.123456789 * 10^8 = 4512345678.9 → rounds to 4512345679
// Step 2: Int → Float: 4512345679 / 10^8 = 45.12345679 (corrected!)
```

**Use Cases:**
- After fund allocation calculations (prevent 0.000000001 drift)
- When rounding order sizes to blockchain precision
- Before storing prices for comparison operations
- After grid divergence calculations

#### `normalizeInt(value, precision)` - Ensure Integer Alignment

Converts int → float → int to ensure the integer aligns with precision boundaries.

```javascript
/**
 * Normalize an integer value by round-tripping through float representation.
 * Converts int → float (readable format) → blockchain int.
 * Ensures the integer aligns with precision boundaries.
 * Used for precision-aware comparisons.
 *
 * @param {number} value - Integer value (e.g., 4512345679)
 * @param {number} precision - Asset precision
 * @returns {number} Normalized integer value
 */
function normalizeInt(value, precision) {
    return floatToBlockchainInt(blockchainToFloat(value, precision), precision);
}

// Example: Ensure consistency in size comparisons
const currentSizeInt = 4512345679;
const idealSizeInt = 4512345679;
const normalized = normalizeInt(currentSizeInt, 8);
// Returns normalized value for consistent == comparisons
```

**Use Cases:**
- Ensuring order sizes align to blockchain satoshi boundaries
- Normalizing fund totals before invariant checks
- Preparing sizes for blockchain transaction encoding

### 5.5.2 Consolidation Impact (Patch 14)

Before Patch 14, five separate quantization implementations existed:
- `dexbot_class.js` - Manual rounding logic
- `order.js` - Custom precision handling
- `strategy.js` - Divergent rounding approach
- `chain_orders.js` - Different quantization pattern
- `export.js` - Isolated float conversions

**After Consolidation:**
✅ Single source of truth (`math.js`)
✅ Consistent precision handling across all modules
✅ Reduced regression risk (tested once, used everywhere)
✅ Eliminated subtle float accumulation bugs
✅ All 34+ test suites pass with zero regressions

### 5.5.3 Precision Best Practices

| Scenario | Function | Example |
|----------|----------|---------|
| **Calculate order size** | `quantizeFloat()` | `quantizeFloat(45.123456789, 8)` → Snap to satoshi |
| **Compare sizes** | `normalizeInt()` | Ensure both sides use same integer representation |
| **Fund allocation** | `quantizeFloat()` | After geometric distribution, eliminate drift |
| **Price derivation** | `quantizeFloat()` | Pool/market price calculations prone to float errors |
| **Validate blockchain match** | `normalizeInt()` | Check: `normalizeInt(internal) === normalizeInt(chain)` |

### 5.5.4 Relationship to Fund Validation (Patch 14 Fix)

The corrected fund validation in `_validateOperationFunds()` uses quantized values:

```javascript
// Check: Does required amount fit in available balance?
const availableBalance = snap.chainFreeSell;  // Quantized by accounting
const requiredAmount = quantizeFloat(totalRequired, precision);  // Quantize for comparison

if (requiredAmount > availableBalance) {
    // Reject batch before broadcasting
    return { valid: false, reason: 'Insufficient funds' };
}
```

This prevents the pre-Patch 14 bug where `available = chainFree + required` created a tautology (`required > chainFree + required` always false). Quantized comparisons now accurately reflect blockchain constraints.

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
