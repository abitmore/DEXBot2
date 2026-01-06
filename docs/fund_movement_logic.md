# Technical Report: Fund Movement & Grid Management

This document provides a deep technical architectural overview of how funds are moved, scaled, and accounted for in the DEXBot2 strategy.

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
$$Available = \max(0, \text{ChainFree} - \text{Virtual} - \text{Cache} - \text{FeesOwed} - \text{FeesReserveration})$$

### Atomic Deduction (`tryDeductFromChainFree`)
When creating an order, the bot does not just "add it to the list". It performs an atomic update:
1. Check if $Available \geq OrderSize$.
2. If yes: Subtract $OrderSize$ from $Available$, add to $VirtualReserved$.
3. If no: Fail the placement (preventing overdrafts).

### Cache Funds Logic
`CacheFunds` act as an optimistic "transit bucket":
- **Incoming:** Fill proceeds (Sell size * Price) are added to `CacheFunds`.
- **Outgoing:** Used as the first source of funding for new placements/rotations.
- **Persistence:** Persisted to `account.json` to ensure no money is "lost" across bot restarts.

---

## 5. Partial Order Handling: Merge, Split & Anchoring
Partial orders (state `PARTIAL`) are on-chain orders that have partially filled. The system manages these using "Anchor" logic to prevent capital fragmentation.

### The Dust Threshold (5%)
The system uses a hardcoded threshold to distinguish between "significant" partial orders and "dust":
- **Dust Criterion**: $Size < SizeIdeal \times 0.05$ (5%).
- **Impact**: Dust orders are prioritized for cancellation and "Merging" back into the liquidity pool to keep the grid clean.

### Merge Logic (Consolidation)
"Merging" is the process of combining small fragments of capital (dust) into a single target size.
- **Trigger**: When a slot is assigned a $SizeIdeal$ but already contains a `PARTIAL` order, or when nearby dust is consolidated.
- **Size Limit (Oversizing)**: Unlike normal placements, a Merged order **CAN exceed 100% of the ideal slot size**.
    - If a slot needs $SizeIdeal$ and absorbs $SizeDust$, the result is a **Double Order** with $SizeTotal = SizeIdeal + SizeDust$.
- **Double Order State**:
    - The order is marked as `isDoubleOrder`.
    - It stays in the `ACTIVE` state even while filling, as long as its remaining size is greater than its original "Core" size ($SizeIdeal$).
    - This allows the bot to "work through" the extra dust without triggering a premature rotation.
- **Promotion**: If the new size is $\geq 99\%$ of the (potentially oversized) target, the state is promoted to `ACTIVE`.

### Split Logic (Surplus Extraction)
"Splitting" occurs when a partial order contains *more* capital than its slot currently requires.
- **Trigger**: Usually after a grid recalculation where a slot's ideal size decreases.
- **Process**: The bot "splits" the order:
    - $SizeNew = SizeIdeal$
    - $Surplus = SizeOld - SizeIdeal$
- **Outcome**: The `Surplus` is returned to `CacheFunds`, and the order remains on-chain with the reduced $SizeNew$.

### Dual-Side Dust Consolidation
A unique safeguard in `processFilledOrders` triggers a mandatory rebalance if dust exists on both sides:
- If **Buy Side has Dust** AND **Sell Side has Dust**:
- The bot forces a full rebalance cycle. This "cleans the rail" by cancelling the tiny fragments and merging them into the next round of placements.

### Moving Partial Orders
During rotations, a `PARTIAL` order can be moved to a new slot:
- It retains its `PARTIAL` state if the capital moved is still less than the target slot's $SizeIdeal$.
- The movement is handled as an **atomic transition** (Vacate old ID → Occupy new ID) to ensure the accountant never loses track of the committed capital.

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
| **Partials** | Stationary | Anchor, Move, and Merge | Prevents dust accumulation. |
| **Safety** | Logs only | Invariant Enforcement | Detects leaks and double-spends. |
