# Technical Report: Fund Movement & Grid Management

This document provides a deep technical architectural overview of how funds are moved, scaled, and accounted for in the DEXBot2 strategy.

---

## Important: Fund Testing & Validation

**For comprehensive test coverage of fund calculations, see:**
- **[TEST_UPDATES_SUMMARY.md](TEST_UPDATES_SUMMARY.md)** - 23 new test cases covering recent bugfixes
- **[developer_guide.md#testing-fund-calculations](developer_guide.md#testing-fund-calculations)** - How to test fund-related features

These tests validate all formulas and invariants described below.

---

## 1. Grid Topology & Spread Gap
The grid is a unified array of `priceLevels`. Instead of separate Buy/Sell rails, everything is indexed in a single "Master Rail".

### The Spread Gap Formula
The "Spread Zone" is a buffer of locked slots between the best buy and best sell. Its size is determined by the `incrementPercent` and `targetSpreadPercent`.

- **Step Factor ($s$):** $s = 1 + \left(\frac{\text{incrementPercent}}{100}\right)$
- **Min Steps ($nMin$):** `MinSpreadFactor` = 2 (default).
- **Target Steps ($nTarget$):** $nTarget = \lceil \frac{\ln(1 + \text{targetSpread} / 100)}{\ln(s)} \rceil$
- **Total Gap Slots ($G$):** $G = \max(\text{MinSpreadOrders}, nTarget)$

### Boundary Anchoring
The grid is centered around a `boundaryIdx`. When a fill occurs:
- **Buy Fill:** $boundaryIdx = boundaryIdx - 1$ (Shift left/down).
- **Sell Fill:** $boundaryIdx = boundaryIdx + 1$ (Shift right/up).

The roles are then assigned:
- **BUY:** Slots $[0, boundaryIdx]$
- **SPREAD:** Slots $[boundaryIdx + 1, boundaryIdx + G]$
- **SELL:** Slots $[boundaryIdx + G + 1, N]$

---

## 2. Global Side Capping (Sizing & Scaling)
Global Side Capping is the core protection mechanism that ensures the bot never attempts to place orders beyond its liquid reality.

### The Budget Ceiling ($B$)
The total budget for a side is capped by the total wealth on the chain.
- $TotalWealth = \text{FreeBalance} + \text{CommittedFunds}$
- $B = \min(\text{ConfigBudget}, TotalWealth)$

### The Available Pool ($P$)
The "fuel" available for growing orders:
- $P = \text{ChainFree} - \text{VirtualReserves} - \text{Fees} + \text{CacheFunds}$

### The Scaling Factor ($S$)
When the bot calculates new "Ideal" sizes for a side, it checks the total capital increase required ($\Delta Total$):
- $\Delta I = \max(0, SizeIdealI - SizeCurrentI)$
- $\Delta Total = \sum \Delta I$

If $\Delta Total > P$, the bot calculates a **Scale Factor**:
$$S = \frac{P}{\Delta Total} \quad (0 \leq S \leq 1)$$

### Final Size Calculation
Increases are scaled; decreases are processed instantly.
$$SizeFinalI = \begin{cases} 
SizeCurrentI + (\Delta I \times S) & \text{if growing} \\
SizeIdealI & \text{if shrinking} 
\end{cases}$$

---

## 3. Order Rotation (The "Crawl" Mechanism)
Order rotation in `dev` is fluid. Instead of a strict sliding window, it uses **Crawl Candidates**.

### Rotation Strategy
1. **Shortages:** Identify empty slots inside the "Active Window" (slots closest to the spread).
2. **Surpluses:**
    - **Hard Surpluses:** Orders outside the configured `activeOrders` count.
    - **Crawl Candidates:** The furthest active orders *inside* the window.
3. **Execution:**
    If a shortage exists closer to the market than an existing order, the bot **Rotates** that capital.
    - **Rotation Condition:** $PriceShortage$ is better than $PriceSurplus$.

This creates a "Contiguous Rail" where capital actively follows the price action even if the window hasn't shifted entirely.

---

## 4. Fund Accounting & Safety
Accounting in `dev` uses an **Atomic Check-and-Deduct** model to prevent race conditions.

### Available Funds Calculation
Available funds are calculated defensively in `utils.js`:
$$Available = \max(0, \text{ChainFree} - \text{Virtual} - \text{InFlight} - \text{FeesOwed} - \text{FeesReservation})$$

**Critical Note:** `CacheFunds` is **NOT** subtracted from available because it is **physically part of ChainFree**.

### Fund Components Explained

| Component | Definition | Purpose |
|-----------|-----------|---------|
| **ChainFree** | Unallocated funds on blockchain | Total liquid capital available |
| **Virtual** | Funds reserved for VIRTUAL orders (not yet on-chain) | Prevents over-allocation to new orders |
| **InFlight** | Committed to ACTIVE orders not yet confirmed on-chain | Bridges VIRTUAL→ACTIVE gap |
| **CacheFunds** | Separate tracking metric for fill proceeds (subset of ChainFree) | Reporting only - does NOT reduce spending power |
| **FeesOwed** | Accumulated BTS fees from trades | Hard liability that must be settled |
| **FeesReservation** | Buffer reserved for future order creation fees | Safety margin for operations |

### Understanding CacheFunds

`CacheFunds` is a **reporting metric**, not a deduction:

```
When a fill occurs:
1. Blockchain balance increases by proceeds → ChainFree increases
2. modifyCacheFunds() also increases by same amount → CacheFunds increases
3. Available = ChainFree - Virtual - InFlight - ... (NO cacheFunds subtraction)

Result: Available already includes fill proceeds via ChainFree.
```

**Why not subtract CacheFunds?** Because it's already included in ChainFree. Subtracting it would:
- **Double-count** the same capital as both "free" and "reserved"
- **Artificially restrict** the bot's spending power
- **Break invariants** between chainFree and available calculations

### Atomic Deduction (`tryDeductFromChainFree`)
When creating an order, the bot does not just "add it to the list". It performs an atomic update:
1. Check if $Available \geq OrderSize$.
2. If yes: Subtract $OrderSize$ from $Available$, add to $VirtualReserved$.
3. If no: Fail the placement (preventing overdrafts).

### CacheFunds Lifecycle

`CacheFunds` tracks fill proceeds and rotation surpluses separately:
- **Incoming:** Fill proceeds (Sell size × Price) are added to `CacheFunds` and simultaneously to `ChainFree`
- **Reporting:** Provides visibility into "profit" available from trading activity
- **Persistence:** Persisted to `account.json` to ensure capital tracking survives restarts
- **Settlement:** Used as the first source for paying BTS transaction fees

---

## 5. Partial Order Handling: Merge & Split
Partial orders (state `PARTIAL`) are on-chain orders that have partially filled. The system manages these using a "Side-Wide Double-Order" strategy to prevent capital fragmentation and divergence errors.

### The Dust Threshold (5%)
The system uses a threshold (defined in `constants.js`) to distinguish between "significant" partial orders and "dust":
- **Dust Criterion**: $Size < SizeIdeal \times 0.05$ (5%).
- **Impact**: Dust orders are prioritized for merging back into the liquidity pool to keep the grid clean.

### Merge Logic (Side-Wide Strategy)
"Merging" is the process of absorbing small fragments of capital (dust) back into the grid's standard sizing.
- **Trigger**: When a slot is assigned an $SizeIdeal$ but already contains a `PARTIAL` dust order.
- **Process**:
    1. The partial order is updated on-chain to **exactly** $SizeIdeal$ (the "extra" dust capital is released into `cacheFunds`).
    2. The side (Buy or Sell) is flagged as **Doubled** (`sideIsDoubled = true`).
- **Benefit**: Unlike the previous "Double Order" strategy, the on-chain order size remains standard. This prevents the "Squeeze" effect where the divergence engine would fight against intentionally oversized orders.

### Double-Side State & Reactions
The `sideIsDoubled` flag acts as a pending "bonus" for the opposite side's reaction logic:
- **State Reset**: The flag is reset immediately after the *first* fill (partial or full) occurs on that side.
- **Partial Fill**: Triggers **one** replacement order on the opposite side (normal behavior).
- **Full Fill**: Triggers **two** replacement orders on the opposite side (the "Double Replacement").
    - One replacement represents the filled order itself.
    - The second replacement utilizes the "released" dust capital from the earlier merge.

### Split Logic (Substantial Partials)
If a partial order is **not** dust (significant capital), the system "Splits" it:
- **Trigger**: Usually after a grid recalculation where a slot's ideal size decreases.
- **Process**: 
    1. The on-chain order is resized down to $SizeIdeal$.
    2. The "overflow" capital is placed as a **new order** at the spread or the next available slot.
- **Result**: This anchors the fill in its current position while allowing the excess capital to continue working elsewhere.

### Dual-Side Dust Consolidation
A unique safeguard in `processFilledOrders` triggers a mandatory rebalance if dust exists on both sides simultaneously. The strategy will prioritize canceling the dust on both sides to consolidate it into target-sized orders, ensuring capital doesn't remain fragmented in tiny remnants.

### Moving Partial Orders
During rotations, a `PARTIAL` order can be moved to a new slot:
- It retains its `PARTIAL` state if the capital moved is still less than the target slot's $SizeIdeal$.
- The movement is handled as an **atomic transition** (Vacate old ID → Occupy new ID) to ensure the accountant never loses track of the committed capital.

---

## 5.1 Rotation State Management

During order rotation, orders transition through states to ensure proper accounting and blockchain synchronization.

### Rotation State Lifecycle

```
ACTIVE (old surplus order)
    ↓
VIRTUAL (marked for replacement)
    ↓
[On-chain cancellation broadcast]
    ↓
synchronizeWithChain() confirms cancellation
    ↓
Capital released, available for new placement
```

### State Transition During Rotation

When a rotation occurs (moving capital from surplus to shortage):

1. **Old Order Transition:**
   - Current state: `ACTIVE` with `orderId` (on-chain)
   - Rotation action: Transition to `VIRTUAL` with `size: 0` and `orderId: null`
   - Purpose: Signals that the order is no longer active and capital has been released
   - Blockchain confirmation: `synchronizeWithChain()` verifies the order is cancelled

2. **New Order Placement:**
   - Creates a new order in `VIRTUAL` state
   - Size: Calculated based on available funds and grid demand
   - State: Remains `VIRTUAL` until blockchain confirms creation
   - Blockchain confirmation: `synchronizeWithChain()` transitions to `ACTIVE` when confirmed

### Why State Transitions Matter

| Scenario | Handling |
|----------|----------|
| **State not updated** | Bot thinks capital is still committed; refuses to use it elsewhere → Grid stops growing |
| **State updated too early** | Bot might double-spend before blockchain confirms → Fund violations |
| **State with wrong size** | Available fund calculations corrupt; grid becomes over/under-sized |

### Protection Mechanisms

1. **Atomic Transitions:** Both old and new order states are updated within the same rebalance operation
2. **Blockchain Sync:** `synchronizeWithChain()` verifies actual on-chain state matches memory
3. **Fund Recalculation:** After any state change, `recalculateFunds()` recomputes available to prevent leaks

### Example: Proper Rotation with Partial Orders

```javascript
// Old rotated order (was ACTIVE, now being replaced)
stateUpdates.push({
    id: 'slot-5',                    // Old slot
    state: ORDER_STATES.VIRTUAL,    // Marked as no longer active
    size: 0,                          // Capital released
    orderId: null                     // Blockchain reference cleared
});

// New placement order (will be ACTIVE after sync)
stateUpdates.push({
    id: 'slot-9',                    // New slot (closer to market)
    type: ORDER_TYPES.SELL,
    state: ORDER_STATES.VIRTUAL,     // Not yet on blockchain
    size: 451.13066,                 // Size calculated from available funds
    orderId: null                     // Will be assigned after blockchain confirms
});

// After broadcast and synchronizeWithChain():
// - slot-5: VIRTUAL with orderId cleared (blockchain confirmed)
// - slot-9: ACTIVE with new orderId (blockchain confirmed)
```

---

## 6. Fund Invariants (Safety Checks)
The bot continuously monitors three "Mathematical Invariants" to detect fund leaks or manual wallet interference.

### Invariant 1: The Account Equality
$$TotalChain = FreeChain + CommittedChain$$
If this $TotalChain$ differs from the blockchain's reported balance, the bot logs an **Invariant Violation**.
- **Tolerance**: 0.1% (to account for exchange fees and rounding).

### Invariant 2: The Committed Ceiling
$$CommittedGrid \leq TotalChain$$
The bot ensures that its internal "intended" committed capital never exceeds the actual wealth on the wallet.

### Invariant 3: Available Leak Check
$$Available \leq FreeChain$$
Since `Available` is derived by subtracting reserves from $FreeChain$, it can never logically exceed it.

---

## 7. Fee Management & Reservation
Transaction fees (BTS) are handled as a "hard liability" to prevent the bot from becoming "stuck" without funds to cancel or move orders.

### Fee Reservation Formula
Before any new orders are placed, the bot calculates a **Fee Buffer**:
$$Buffer = NOrders \times FeeFallback \times MultiplierBuffer$$
- **Result**: This buffer is subtracted from `AvailablePool` immediately. It ensures that even if you have 0 balance, you still have "virtual" BTS saved to pay for the operations of the grid.

### Owed Fees Settlement
When actual fees are charged on-chain, they are tracked in `btsFeesOwed`. During a rotation, the bot: 
1. Deducts the fee from `CacheFunds` (surplus from fills).
2. If `CacheFunds` are empty, it deducts from $FreeChain$.

---

## 8. Summary of Improvements
| Feature | Main Branch | Current Strategy | Benefit |
| :--- | :--- | :--- | :--- |
| **Sizing** | Budget-based (static) | Global Side Capping | Fund-neutral rotations even at 0 balance. |
| **Rotation** | Sliding Window | Greedy Crawl | Capital closer to price action. |
| **Accounting**| Optimistic | Atomic (Check-and-Deduct) | No race conditions/negative balances. |
| **Topology** | Rigid Buying/Selling | Master Rail + Dynamic Boundary | Smoother role transitions. |
| **Partials** | Stationary | Side-Wide Double-Order Strategy | Prevents dust accumulation without grid squeezing. |
| **Safety** | Logs only | Invariant Enforcement | Detects leaks and double-spends. |

---

## Related Documentation

### Understanding Fund Accounting & Rotation
- **[FUND_ACCOUNTING_AND_ROTATION.md](FUND_ACCOUNTING_AND_ROTATION.md)** - Comprehensive guide (START HERE)
  - Fund accounting model and core principles
  - Why cacheFunds is NOT subtracted from available
  - Order rotation state transitions
  - Protection against race conditions
  - Best practices and debugging
  - Common mistakes to avoid

### Testing & Validation
- **[TEST_UPDATES_SUMMARY.md](TEST_UPDATES_SUMMARY.md)** - Complete test coverage for fund calculations
  - 23 test cases covering all formulas and invariants
  - Maps each test to bugfixes and edge cases
  - How to run tests for fund validation

- **[developer_guide.md - Testing Fund Calculations](developer_guide.md#testing-fund-calculations)** - Testing guide
  - What gets tested
  - How to write fund tests
  - Common test patterns
  - Debugging fund issues

### Reference Documentation
- **[architecture.md](architecture.md)** - System architecture and testing strategy
- **[developer_guide.md](developer_guide.md)** - Complete developer guide with fund examples
- **[FUND_SNAPSHOT_GUIDE.md](FUND_SNAPSHOT_GUIDE.md)** - Fund snapshot history and debugging

---

## How to Verify These Formulas

All formulas in this document are validated by the test suite. To verify:

```bash
# Run fund calculation tests
npx jest tests/unit/accounting.test.js

# Run all tests (includes fund validation)
npm test

# Check fund invariants in debug mode
# Set logLevel: "debug" and enable fund snapshots
```

For detailed test information, see [TEST_UPDATES_SUMMARY.md](TEST_UPDATES_SUMMARY.md).
