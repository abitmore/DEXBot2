# DEXBot2 Developer Guide

Welcome to DEXBot2! This guide will help you understand the codebase, navigate key concepts, and contribute effectively.

> **For system design overview**, see [architecture.md](architecture.md) which provides high-level module relationships and data flows.

---

## Quick Start: Where to Begin

### 1. **Start Here** (5 minutes)
Read these files in order to get oriented:
1. [README.md](../README.md) - User documentation and setup
2. [architecture.md](architecture.md) - System architecture and module relationships
3. [FUND_MOVEMENT_AND_ACCOUNTING.md](FUND_MOVEMENT_AND_ACCOUNTING.md) - Core algorithms and formulas

### 2. **Core Concepts** (15 minutes)
Understand these fundamental concepts before diving into code:
- **Grid Trading**: Placing orders at geometric price levels to profit from volatility
- **Order States**: VIRTUAL → ACTIVE → PARTIAL lifecycle
- **Fund Tracking**: Atomic accounting to prevent overdrafts
- **Boundary Crawl**: Dynamic order rotation following price movement

### 3. **Code Reading Roadmap** (30 minutes)
Follow this path through the codebase:

```
1. modules/constants.js          (5 min)  - Configuration and tuning parameters
2. modules/order/manager.js      (10 min) - Central coordinator, read constructor + _updateOrder()
3. modules/order/accounting.js   (5 min)  - Fund tracking, read recalculateFunds()
4. modules/order/strategy.js     (5 min)  - Rebalancing logic, read rebalance()
5. modules/order/grid.js         (5 min)  - Grid creation, read createOrderGrid()
```

---

## Glossary of Terms

### Order States

| Term | Meaning | Fund Impact |
|------|---------|-------------|
| **VIRTUAL** | Order planned but not on-chain | Funds reserved in `virtual` pool |
| **ACTIVE** | Order placed on blockchain | Funds locked in `committed.chain` |
| **PARTIAL** | Order partially filled | Reduced `committed`, proceeds in `cacheFunds` |
| **SPREAD** | Placeholder for spread zone | Always VIRTUAL, no funds |

⚠️ **CRITICAL: Phantom Orders**

A **phantom order** is an order in ACTIVE/PARTIAL state WITHOUT a valid `orderId`. This is an illegal state that corrupts fund tracking. The system implements a three-layer defense to prevent phantoms (see **Phantom Orders Prevention** section). If encountered, the order is automatically downgraded to VIRTUAL with error logging.

### Pipeline Safety Features (Patch 12)

| Term | Meaning |
|------|---------|
| **Pipeline Timeout Safeguard** | 5-minute timeout preventing indefinite blocking on pipeline checks |
| **Pipeline Health Diagnostics** | `getPipelineHealth()` method returning 8 diagnostic fields for monitoring |
| **Stale Operation Clearing** | Non-destructive recovery clearing operation flags without touching orders |

### Fund Components

| Term | Meaning | Formula |
|------|---------|---------|
| **chainFree** | Unallocated blockchain balance | From `accountTotals.buyFree/sellFree` |
| **committed.chain** | Funds locked in on-chain orders | Sum of ACTIVE orders with `orderId` |
| **committed.grid** | Internal tracking of ACTIVE sizes | Sum of all ACTIVE order sizes |
| **virtual** | Reserved for VIRTUAL orders | Sum of VIRTUAL order sizes |
| **cacheFunds** | Fill proceeds + rotation surplus | Added during fills, consumed during placements |
| **available** | Free funds for new orders | `max(0, chainFree - virtual - cacheFunds - fees)` |
| **total.chain** | Total on-chain balance | `chainFree + committed.chain` |
| **total.grid** | Total grid allocation | `committed.grid + virtual` |

### Grid Concepts

| Term | Meaning |
|------|---------|
| **Master Rail** | Unified array of price levels (not separate buy/sell rails) |
| **Boundary Index** | Pivot point separating BUY/SPREAD/SELL zones |
| **Spread Gap** | Buffer of empty slots between best buy and best sell |
| **Crawl Candidate** | Furthest active order eligible for rotation |
| **Shortage** | Empty slot in the active window that needs an order |
| **Surplus** | Order outside the active window that can be rotated |
| **Hard Surplus** | Order beyond the configured `activeOrders` count |
| **Dust** | Partial order < 5% of ideal size |
| **Doubled Side** | Flag set when a dust partial is updated to ideal size; allows additional rebalancing actions on that side |

### Operations

| Term | Meaning |
|------|---------|
| **Rotation** | Moving an order from one price level to another |
| **Consolidation** | Updating dust partials to ideal size and flagging the side as "doubled" for additional rebalancing capacity |
| **Rebalancing** | Adjusting order sizes based on current funds |
| **Global Side Capping** | Scaling order sizes when insufficient funds |
| **Atomic Check-and-Deduct** | Verify funds + deduct in single operation |
| **Divergence Detection** | Comparing ideal grid vs. persisted grid |
| **Invariant Verification** | Checking fund accounting consistency |

### Price Orientation and Derivation

**Critical Concept**: All prices in DEXBot2 use **B/A orientation** (how much of asset B per 1 unit of asset A).

| Term | Meaning | Example |
|------|---------|---------|
| **B/A Orientation** | Price format representing "how much B per 1 A" | XRP/BTS: 1350 means 1 XRP = 1350 BTS |
| **A/B Orientation** | Price format representing "how much A per 1 B" (NOT used in bot) | XRP/BTS: 0.00074 means 0.00074 XRP per 1 BTS |

#### Price Sources and Conversions

| Source | Raw Format | Conversion | Final Format |
|--------|-----------|-----------|-------------|
| **BitShares `get_order_book(A, B)`** | A/B (base/quote) | `1 / mid` | B/A ✓ |
| **BitShares `get_ticker(A, B)`** | A/B (base/quote) | `1 / value` | B/A ✓ |
| **Liquidity Pool Reserves** | `reserve_A / reserve_B` | `floatB / floatA` | B/A ✓ |

#### Implementation (`modules/order/utils/system.js`)

**`deriveMarketPrice(BitShares, symA, symB)`**:
```javascript
// BitShares get_order_book(A, B) returns prices in A/B format
const mid = (bestBid + bestAsk) / 2;  // e.g., 0.00074 (XRP per BTS)
return 1 / mid;  // Convert to B/A: 1/0.00074 ≈ 1350 (BTS per XRP)
```

**`derivePoolPrice(BitShares, symA, symB)`**:
```javascript
// Pool reserves come from blockchain in order [reserve_A, reserve_B]
const floatA = safeBlockchainToFloat(amtA, aMeta.precision);
const floatB = safeBlockchainToFloat(amtB, bMeta.precision);
return floatB / floatA;  // Already B/A: 3000000 BTS / 20000 XRP = 150 (BTS/XRP)
```

#### Why This Matters

- **Grid Placement**: `startPrice` determines where BUY orders (below) and SELL orders (above) are placed
- **Consistency**: Both market and pool prices use B/A so they're directly comparable
- **Debugging**: Inverted prices cause bot to place orders on the wrong side of the market (e.g., massive sells when market rises)

#### Common Debugging Pattern

If you see prices like `0.000795` when expecting `1350`:
1. This is likely A/B format (raw from API)
2. Check if inversion (`1 / price`) is being applied
3. Verify which function is missing the conversion

---

## Module Deep Dive

### OrderManager (`modules/order/manager.js`)

**Role**: Central coordinator for all order operations

**Key Responsibilities**:
- Maintain order state in `orders` Map
- Coordinate specialized engines (Accountant, Strategy, Sync, Grid)
- Manage order indices for fast lookups
- Handle order locking to prevent race conditions

**Critical Methods**:
```javascript
// Central state update - ALWAYS use this, never modify orders Map directly
// Signature: _updateOrder(order, context = 'updateOrder', skipAccounting = false, fee = 0)
_updateOrder(order, context, skipAccounting, fee)

// Fast lookups using indices
getOrdersByTypeAndState(type, state)

// Concurrency control
lockOrders([orderId])
unlockOrders([orderId])
isOrderLocked(orderId)

// Batch optimization
pauseFundRecalc()
resumeFundRecalc()
```

**Common Patterns**:
```javascript
// Pattern 1: Simple order state update (uses defaults)
manager._updateOrder({
    id: 'buy-5',
    state: ORDER_STATES.ACTIVE,
    type: ORDER_TYPES.BUY,
    price: 0.5,
    size: 100,
    orderId: '1.7.12345'
});

// Pattern 2: Update with context and fee (for blockchain operations)
manager._updateOrder(
    { id: 'buy-5', state: ORDER_STATES.VIRTUAL, orderId: null },
    'cancel-order',  // context for logging
    false,           // skipAccounting: update balances
    0                // fee: no fee for cancel
);

// Pattern 3: Batch updates with pause/resume
manager.pauseFundRecalc();
for (const order of orders) {
    manager._updateOrder(order, 'rebalance-batch', false, 0);
}
manager.resumeFundRecalc(); // Recalculates once at end

// Pattern 4: Safe async operations
manager.lockOrders([orderId]);
try {
    await chainOperation();
} finally {
    manager.unlockOrders([orderId]);
}
```

---

## Phantom Orders Prevention (Defense-in-Depth)

### Why This Matters

**Phantom orders** are orders that exist in memory as ACTIVE/PARTIAL state but lack a corresponding blockchain `orderId`. This causes fund tracking corruption:
- Memory shows orders locked in `committed.grid` but blockchain has no such orders
- Leads to "doubled funds" warnings where `trackedTotal >> blockchainTotal`
- Causes high RMS divergence with many unmatched orders
- Can lock funds indefinitely if not detected

### Three-Layer Prevention System

#### Layer 1: Primary Guard in `OrderManager._updateOrder()` (manager.js:570-584)

**The Critical Validation**:
```javascript
// Centralized check - ALL state transitions go through here
if ((order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) && !order.orderId) {
    logger.log(
        `ILLEGAL STATE: Refusing to set order ${id} to ${order.state} without orderId. ` +
        `Context: ${context}. This would create a phantom order that doubles fund tracking. ` +
        `Downgrading to VIRTUAL instead.`,
        'error'
    );
    order.state = ORDER_STATES.VIRTUAL;  // Auto-correct
}
```

**Why It Works**:
- Every order state change must call `_updateOrder()` (enforced throughout codebase)
- Cannot be bypassed - direct state assignments are not used for order state
- Applies to ALL modules: grid, sync, strategy, dexbot_class
- Auto-correction with logging provides audit trail

#### Layer 2: Grid Resize Protection (grid.js:1154)

**Before (Vulnerable)**:
```javascript
manager._updateOrder({ ...order, size: newSize, state: ORDER_STATES.ACTIVE }, 'grid-resize', ...);
```

**After (Safe)**:
```javascript
manager._updateOrder({ ...order, size: newSize, state: order.state }, 'grid-resize', ...);
```

**Why It Matters**: Preserves order's current state instead of forcing ACTIVE, preventing VIRTUAL → ACTIVE phantom creation during grid resizing.

#### Layer 3: Sync Cleanup (sync_engine.js:297-305)

**Phantom Detection & Prevention**:
```javascript
// If order has no ID OR its ID is not on chain, it's a phantom/filled order
if (!currentGridOrder?.orderId || !parsedChainOrders.has(currentGridOrder.orderId)) {
    const spreadOrder = convertToSpreadPlaceholder(currentGridOrder);
    mgr._updateOrder(spreadOrder, 'sync-cleanup-phantom', ...);

    // CRITICAL: Only trigger fill processing for GENUINE fills (had orderId)
    // Phantoms (never had orderId) should NOT trigger rotations/rebalancing
    if (currentGridOrder?.orderId) {
        filledOrders.push({ ...currentGridOrder });
    }
}
```

**Why It Matters**:
- Detects phantoms on every sync
- Converts to SPREAD placeholders (releases locked funds)
- Prevents phantom fills from triggering unwarranted rotations/rebalancing

### Additional Hardening

**Strategy Module** (strategy.js:484, 521):
```javascript
// Only upgrade to ACTIVE if order has valid orderId
const newState = partial.orderId ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
```

**Fallback Placements** (dexbot_class.js:982):
```javascript
const fallbackPlacements = unmetRotations.map(r => ({
    id: r.newGridId,
    price: r.newPrice,
    size: r.newSize,
    type: r.type,
    state: ORDER_STATES.VIRTUAL  // Start VIRTUAL, become ACTIVE after blockchain confirmation
}));
```

### Testing

See `tests/repro_phantom_orders.js` for comprehensive test coverage:
- Direct phantom creation attempt (blocked)
- Grid resize phantom prevention (verified)
- Sync cleanup of orphaned ACTIVE orders (verified)
- Valid ACTIVE order preservation (verified)

---

## Order State Helper Functions (Patch 11)

**Location**: `modules/order/utils.js`

**Purpose**: Single source of truth for order state logic, replacing 34+ inline checks scattered across the codebase.

**Benefit**: Semantic function names, centralized phantom detection, consistent patterns across all modules.

### Core State Checkers

#### `isOrderOnChain(order)`
```javascript
// Check if order exists on blockchain
// Returns true for ACTIVE or PARTIAL orders
if (isOrderOnChain(order)) {
    // Order has presence on blockchain
}
```

#### `isOrderVirtual(order)`
```javascript
// Check if order is planned but not yet placed
// Returns true for VIRTUAL orders
if (isOrderVirtual(order)) {
    // Order is reserved capital but not on-chain yet
}
```

#### `hasOnChainId(order)`
```javascript
// Check if order has a valid blockchain orderId
// Returns true if orderId is non-null and non-empty
if (hasOnChainId(order)) {
    // Order has been successfully placed and confirmed
}
```

#### `isOrderPlaced(order)`
```javascript
// Check if order is safely placed (on-chain with ID)
// Combines: state === ACTIVE/PARTIAL AND orderId exists
if (isOrderPlaced(order)) {
    // Safe to use in calculations requiring blockchain confirmation
}
```

#### `isPhantomOrder(order)`
```javascript
// Detect phantom orders (on-chain state without ID - error state)
// Returns true for ACTIVE/PARTIAL orders WITHOUT orderId
if (isPhantomOrder(order)) {
    // ERROR: This order shouldn't exist - fund tracking is corrupt
    logger.error(`Phantom order detected: ${order.id}`);
}
```

#### `isSlotAvailable(order)`
```javascript
// Check if slot can be reused (VIRTUAL + no ID)
// Returns true for VIRTUAL orders without orderId
if (isSlotAvailable(order)) {
    // Can overwrite this slot with a new order
}
```

### State Transition Helper

#### `virtualizeOrder(order)`
```javascript
// Transition order to VIRTUAL state and clear blockchain metadata
// Safely clears orderId, filledSize, and other blockchain-specific fields
const virtualizedOrder = virtualizeOrder(order);
// Result: {
//     ...order,
//     state: ORDER_STATES.VIRTUAL,
//     orderId: null,
//     filledSize: 0
// }
```

### Order Health Validation

#### `isOrderHealthy(order, minSize)`
```javascript
// Comprehensive validation: size > 0 AND not dust-threshold
// Prevents undersized orders that cause blockchain failures
const minHealthySize = getMinOrderSize(ORDER_TYPES.BUY, assets, 1.0);
if (isOrderHealthy(order, minHealthySize)) {
    // Order is valid for placement/rotation
} else {
    // Order is dust - consolidate or skip
}
```

### Pattern Matching Helpers

#### `getPartialsByType(orders)`
```javascript
// Segregate partial orders by type efficiently
// Returns: { buy: [partial1, partial2], sell: [partial3] }
const { buy: buyPartials, sell: sellPartials } = getPartialsByType(orders);

// Use case: Consolidate dust partials per side
for (const partial of buyPartials) {
    if (isDust(partial)) {
        scheduleConsolidation(partial);
    }
}
```

**Eliminates duplications in**:
- `strategy.js::_getPartialOrdersByType()`
- `grid.js::compareGrids()`
- `startup_reconcile.js::selectPartialSlots()`

#### `validateAssetPrecisions(assets)`
```javascript
// Validate both asset precisions simultaneously
// Checks: precision >= 0 AND precision <= MAX_PRECISION
const { buy, sell } = validateAssetPrecisions({
    buy: assetB.precision,
    sell: assetA.precision
});

if (!buy.valid || !sell.valid) {
    throw new Error(`Invalid precisions: ${buy} / ${sell}`);
}
```

#### `getPrecisionSlack(precision, factor)`
```javascript
// Calculate float comparison tolerance for given precision
// Returns: 10^(-precision) * factor (typically factor = 0.001 = 0.1%)
const slack = getPrecisionSlack(5, 0.001);  // Returns 0.00001 * 0.001 = 0.00000001

// Use case: Floating-point safe comparisons
if (Math.abs(order.size - expected) <= slack) {
    // Sizes match within precision tolerance
}
```

**Eliminates duplications in**:
- `accounting.js::recalculateFunds()`
- `manager.js::_updateOrder()`

### Common Usage Patterns

**Pattern 1: Type-safe Order Placement**
```javascript
// Only place orders that are truly safe
const ordersToPlace = orders.filter(o =>
    isOrderHealthy(o, minSize) && !isOrderPlaced(o)
);
```

**Pattern 2: Phantom Detection During Sync**
```javascript
// Detect and cleanup phantoms during blockchain sync
for (const order of allOrders) {
    if (isPhantomOrder(order)) {
        const placeholder = convertToSpreadPlaceholder(order);
        mgr._updateOrder(placeholder, 'sync-cleanup-phantom', false, 0);
    }
}
```

**Pattern 3: Reusable Slot Identification**
```javascript
// Find slots available for overwriting
const reusableSlots = grid.filter(isSlotAvailable);
for (const slot of reusableSlots) {
    slot = createNewOrder(slot.index, newPrice);
}
```

**Pattern 4: Side-Segregated Rebalancing**
```javascript
// Rebalance each side separately based on fill type
const { buy: buyPartials, sell: sellPartials } = getPartialsByType(orders);

rebalanceBuySide(buyPartials);
rebalanceSellSide(sellPartials);
```

---

### Accountant (`modules/order/accounting.js`)

**Role**: Fund tracking and fee management

**Key Responsibilities**:
- Calculate available funds for each side
- Verify fund invariants
- Manage BTS transaction fees
- Atomic fund deduction

**Critical Methods**:
```javascript
// Master fund calculation - called after every state change
recalculateFunds()

// Atomic fund operations
tryDeductFromChainFree(orderType, size, operation)
addToChainFree(orderType, size, operation)

// Fee management
deductBtsFees(requestedSide)

// Safety checks
_verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell)
```

**Fund Calculation Flow**:
```javascript
// 1. Reset all fund pools
resetFunds()

// 2. Iterate all orders and accumulate
for (const order of orders) {
    if (order.state === VIRTUAL) {
        funds.virtual[side] += order.size
    } else if (order.state === ACTIVE || order.state === PARTIAL) {
        funds.committed.grid[side] += order.size
        if (order.orderId) {
            funds.committed.chain[side] += order.size
        }
    }
}

// 3. Calculate available
funds.available[side] = max(0, 
    chainFree - virtual - cacheFunds - btsFeesOwed - btsFeesReservation
)

// 4. Verify invariants
_verifyFundInvariants(...)
```

---

### StrategyEngine (`modules/order/strategy.js`)

**Role**: Grid rebalancing and order rotation

**Key Responsibilities**:
- Process filled orders
- Identify shortages and surpluses
- Execute order rotations
- Handle partial order consolidation

**Critical Methods**:
```javascript
// Main entry point for rebalancing
rebalance(fills, excludeIds)

// Core rebalancing algorithm
rebalanceSideRobust(type, allSlots, sideSlots, direction, budget, available, excludeIds, reactionCap)

// Fill processing
processFilledOrders(filledOrders, excludeOrderIds)

// Partial order movement
preparePartialOrderMove(partialOrder, gridSlotsToMove, reservedGridIds)
completePartialOrderMove(moveInfo)
```

**Rebalancing Algorithm**:
```javascript
// 1. Identify shortages (empty slots in active window)
const shortages = sideSlots
    .filter(slot => slot.state === VIRTUAL)
    .slice(0, targetActiveCount);

// 2. Identify surpluses (orders outside active window)
const hardSurpluses = activeOrders.slice(targetActiveCount);
const crawlCandidates = activeOrders.slice(0, targetActiveCount);

// 3. For each shortage, find rotation candidate
for (const shortage of shortages) {
    const candidate = findFurthestOrder(crawlCandidates);
    
    if (shortage.price is better than candidate.price) {
        // Rotate: cancel candidate, place at shortage
        rotateOrder(candidate, shortage);
    }
}

// 4. Apply Global Side Capping if needed
if (totalIncrease > availablePool) {
    const scaleFactor = availablePool / totalIncrease;
    for (const order of orders) {
        order.size *= scaleFactor;
    }
}
```

---

### Grid (`modules/order/grid.js`)

**Role**: Grid creation, sizing, and divergence detection

**Key Responsibilities**:
- Create geometric price grids
- Calculate spread gap size
- Detect grid divergence
- Update order sizes from blockchain

**Critical Methods**:
```javascript
// Create initial grid
createOrderGrid(config)

// Initialize with blockchain balances
initializeGrid(manager)

// Detect divergence and trigger updates
checkAndUpdateGridIfNeeded(manager, cacheFunds)

// Compare ideal vs. persisted grid
compareGrids(calculatedGrid, persistedGrid, manager, cacheFunds)
```

**Grid Creation Flow**:
```javascript
// 1. Calculate spread gap size
const stepFactor = 1 + (incrementPercent / 100);
const minSteps = MIN_SPREAD_FACTOR; // 2
const targetSteps = ceil(ln(1 + targetSpread/100) / ln(stepFactor));
const gapSlots = max(minSteps, targetSteps - 1); // Account for naturally occurring center gap

// 2. Generate price levels
const prices = [];
let price = startPrice;
for (let i = 0; i < totalLevels; i++) {
    prices.push(price);
    price *= stepFactor;
}

// 3. Assign roles based on boundary
for (let i = 0; i < prices.length; i++) {
    if (i <= boundaryIdx) {
        type = BUY;
    } else if (i <= boundaryIdx + gapSlots) {
        type = SPREAD;
    } else {
        type = SELL;
    }
}
```

---

### SyncEngine (`modules/order/sync_engine.js`)

**Role**: Blockchain synchronization and fill detection

**Key Responsibilities**:
- Sync grid state with blockchain
- Detect filled orders
- Update account balances
- Match chain orders to grid orders

**Critical Methods**:
```javascript
// Main sync entry point
synchronizeWithChain(data, source)

// Sync from open orders
syncFromOpenOrders(openOrders, syncInfo)

// Sync from fill history
syncFromFillHistory(operation)

// Fetch account balances
fetchAccountBalancesAndSetTotals()
```

---

## Startup Sequence & Lock Ordering (Patch 9 Consolidation)

### Unified Startup Flow

The bot startup has been consolidated into a shared sequence used by all entry points (`start()`, `startWithPrivateKey()`, CLI, PM2). This ensures identical behavior and eliminates maintenance burden from duplicate code.

#### Startup Phases (In Order)

```javascript
// Phase 1: Initialize state
_initializeStartupState()
  ├─ Verify account configuration
  └─ Load existing or generate new grid state

// Phase 2: Set up account context
_setupAccountContext()
  ├─ Resolve account ID
  ├─ Load fund balances
  └─ Initialize AccountOrders subscription

// Phase 3: Create order manager
// (OrderManager spawned with initial state)

// Phase 4: Run grid maintenance
_runGridMaintenance()
  ├─ Acquire _fillProcessingLock
  └─ Execute maintenance logic:
      ├─ Threshold check (cache ratio)
      ├─ Divergence check (if threshold fails)
      ├─ Spread check (out-of-spread recovery)
      └─ Health check (invariant verification)

// Phase 5: Finish startup
_finishStartupSequence()
  ├─ Mark bootstrap complete
  ├─ Begin fill processing
  └─ Start periodic maintenance timer
```

### Lock Ordering for Deadlock Prevention

**Critical Rule: Always acquire locks in canonical order**

```
_fillProcessingLock → _divergenceLock
```

**Why This Order?**

- Fill processing is the most frequent operation (high contention)
- Grid maintenance is less frequent but synchronous
- By acquiring fill lock first, we ensure fills can't be blocked by slower divergence checks
- Reverse order (divergence first) would create deadlock when fills arrive during maintenance

**Example: Safe Pattern**

```javascript
// ✅ CORRECT: Fill lock acquired, then divergence lock
async processFill(fill) {
    await this._fillProcessingLock.acquire();
    try {
        // Do fill processing...

        // If divergence check needed:
        await this._divergenceLock.acquire();
        try {
            // Check divergence...
        } finally {
            this._divergenceLock.release();
        }
    } finally {
        this._fillProcessingLock.release();
    }
}

// ❌ WRONG: Would deadlock if fill arrives during divergence check
async checkDivergence() {
    await this._divergenceLock.acquire();  // This blocks fills!
    try {
        // ...
    }
}
```

**Lock Scope in Startup**

The startup sequence extends lock scope to ensure atomic operations:

```javascript
async _runGridMaintenance(fillLockAlreadyHeld = false) {
    const lockHeld = fillLockAlreadyHeld || await this._fillProcessingLock.acquire();
    try {
        // All maintenance operations run atomically
        // Fills cannot arrive mid-startup
    } finally {
        if (!fillLockAlreadyHeld) {
            this._fillProcessingLock.release();
        }
    }
}
```

**Bootstrap Flag Safety**

The `isBootstrapping` flag is guaranteed to be cleared using try-finally:

```javascript
async start() {
    this.isBootstrapping = true;
    try {
        // All startup phases...
    } finally {
        this.isBootstrapping = false;  // Always cleared, even on error
    }
}
```

### Zero-Amount Order Prevention

All new orders pass through two validation gates:

1. **Strategy/Grid Logic** (`strategy.js`, `grid.js`):
   - Check: `size >= getMinOrderSize(type, assets, factor)`
   - Double-dust threshold: `size >= minHealthySize`
   - Prevents undersized placement attempts

2. **Broadcast Validation** (`dexbot_class.js`):
   - Check: `amount > 0` for each order
   - Rejects zero-amount operations before blockchain transmission
   - Triggers recovery sync on validation failure

**Recovery from Failed Batches**

If a batch broadcast fails, the bot performs recovery:

```javascript
try {
    await broadcastBatch(orders);  // Broadcasting
} catch (error) {
    // Fresh balance fetch resets optimistic drift
    await this.manager.fetchAccountTotals(this.accountId);

    // Full sync aligns grid with blockchain reality
    const openOrders = await chainOrders.readOpenOrders(this.accountId);
    await this.manager.syncFromOpenOrders(openOrders, { skipAccounting: true });
}
```

---

## Managing Bot Configuration

### The `bots.json` Source of Truth

The bot's operational parameters are defined in `profiles/bots.json`. While most settings are loaded at startup, the system is designed to pick up manual changes to critical valuation parameters during its runtime.

#### Handling `startPrice`

The `startPrice` is the anchor for valuation (calculating the relative value of Asset A and Asset B). It can be configured in three ways:

1.  **Fixed Numeric Price** (e.g., `105.5`):
    *   The bot treats this as a **fixed anchor**.
    *   Automatic price derivation from the market is **disabled**.
    *   Used as the base for all grid math during a **Grid Reset**.

2.  **"pool"**:
    *   The bot fetches the current BitShares Liquidity Pool price.
    *   Updated periodically every 4 hours.

3.  **"market"**:
    *   The bot derives the price from the current orderbook.
    *   Updated periodically every 4 hours.

### Numeric `startPrice` - Fixed Anchor (Patch 8)

When you set a **numeric value** like `"startPrice": 105.5` in `bots.json`:

**Behavior**:
- ✅ Auto-refresh is **DISABLED** - numeric value is treated as absolute anchor
- ✅ Grid valuation uses this fixed price for all calculations
- ✅ Grid remains stable during market moves (fund-driven rebalancing only)
- ❌ Auto-derivation never happens - market/pool price is ignored

**Use Case**: You want absolute control over grid positioning regardless of current market conditions.

### Runtime Updates (The 4h Refresh)

The bot performs a **Periodic Configuration Refresh** (every 4 hours by default).

**For Dynamic Pricing** (`startPrice: "market"` or `startPrice: "pool"`):
*   **Valuation Update**: Fetches latest market/pool price and updates grid anchor
*   **Grid Reposition**: Subsequent grid resets use updated valuation
*   **Operational Stability**: During normal operation, the bot remains "fund-driven" and doesn't move orders on-chain

**For Numeric Pricing** (`startPrice: 105.5`):
*   **No Changes**: Fixed value is never updated
*   **Valuation locked**: All calculations use the configured numeric value
*   **Manual Override Required**: To change numeric anchor, edit `bots.json` and use **File Trigger**

*   **Applying Changes**: To force the bot to move orders to a new `startPrice` immediately, you must use the **File Trigger** (`recalculate.{botKey}.trigger`) to perform a full grid reset.

---

## How to Add New Features

### Example: Adding a New Order Type

**1. Update Constants**
```javascript
// modules/constants.js
ORDER_TYPES: {
    BUY: 'buy',
    SELL: 'sell',
    SPREAD: 'spread',
    LIMIT: 'limit'  // NEW
}
```

**2. Update Manager Indices**
```javascript
// modules/order/manager.js - constructor
this._ordersByType = {
    [ORDER_TYPES.BUY]: new Set(),
    [ORDER_TYPES.SELL]: new Set(),
    [ORDER_TYPES.SPREAD]: new Set(),
    [ORDER_TYPES.LIMIT]: new Set()  // NEW
};
```

**3. Update Fund Calculation**
```javascript
// modules/order/accounting.js - recalculateFunds()
for (const order of orders.values()) {
    if (order.type === ORDER_TYPES.LIMIT) {
        // Handle new type
        funds.committed.grid[order.side] += order.size;
    }
}
```

**4. Update Strategy Logic**
```javascript
// modules/order/strategy.js - rebalance()
const limitOrders = manager.getOrdersByTypeAndState(ORDER_TYPES.LIMIT, null);
// Process limit orders...
```

**5. Add Tests**
```javascript
// tests/test_manager.js
describe('LIMIT order type', () => {
    it('should track LIMIT orders in indices', () => {
        // Test implementation
    });
});
```

**6. Update Documentation**
```markdown
// docs/architecture.md
### Order Types
- **LIMIT**: User-defined limit orders outside the grid
```

---

## Testing Strategy

### Unit Tests
Located in `tests/unit/`:
- `test_accounting.js` - Fund calculation tests
- `test_grid.js` - Grid creation and sizing tests
- `test_manager.js` - State management tests
- `test_sync_engine.js` - Blockchain sync tests

**Run tests**:
```bash
npm test
```

### Manual Verification

**1. Fund Invariant Check**
```javascript
// After any operation
manager.accountant._verifyFundInvariants(
    manager,
    chainFreeBuy,
    chainFreeSell,
    chainBuy,
    chainSell
);
```

**2. Index Consistency Check**
```javascript
// Periodically
const isValid = manager.validateIndices();
if (!isValid) {
    manager._repairIndices();
}
```

**3. Grid Diagnostics**
```javascript
// After fills or rotations
manager.logger.logGridDiagnostics(manager, 'AFTER FILL');
```

---

## Code Style Guidelines

### 1. **Always Use _updateOrder()**
```javascript
// ✅ CORRECT - Uses proper signature with context
manager._updateOrder({
    id: 'buy-5',
    state: ORDER_STATES.ACTIVE,
    type: ORDER_TYPES.BUY,
    price: 0.5,
    size: 100
}, 'order-update', false, 0);

// ✅ ALSO CORRECT - Using defaults (context='updateOrder', skipAccounting=false, fee=0)
manager._updateOrder({
    id: 'buy-5',
    state: ORDER_STATES.ACTIVE,
    type: ORDER_TYPES.BUY,
    price: 0.5,
    size: 100
});

// ❌ WRONG - Breaks indices
manager.orders.set('buy-5', order);
```

### 2. **Batch Fund Recalculation**
```javascript
// ✅ CORRECT - Recalculates once, with context for logging
manager.pauseFundRecalc();
for (const order of orders) {
    manager._updateOrder(order, 'rebalance-batch', false, 0);
}
manager.resumeFundRecalc();

// ⚠️ ACCEPTABLE - Uses defaults but less ideal for debugging
manager.pauseFundRecalc();
for (const order of orders) {
    manager._updateOrder(order);
}
manager.resumeFundRecalc();

// ❌ WRONG - Recalculates N times
for (const order of orders) {
    manager._updateOrder(order); // Triggers recalc each time
}
```

### 3. **Lock During Async Operations**
```javascript
// ✅ CORRECT
manager.lockOrders([orderId]);
try {
    await chainOperation();
} finally {
    manager.unlockOrders([orderId]);
}

// ❌ WRONG - Race condition possible
await chainOperation();
```

### 4. **Use Atomic Fund Operations**
```javascript
// ✅ CORRECT
if (manager.accountant.tryDeductFromChainFree(type, size)) {
    // Funds deducted atomically
    placeOrder();
} else {
    // Insufficient funds
}

// ❌ WRONG - Race condition
if (manager.funds.available[type] >= size) {
    manager.funds.available[type] -= size; // Not atomic!
    placeOrder();
}
```

---

## Performance Tips

### 1. **Use Index Lookups**
```javascript
// ✅ FAST - O(1) lookup
const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);

// ❌ SLOW - O(n) iteration
const activeBuys = Array.from(manager.orders.values())
    .filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE);
```

### 2. **Batch Operations**
```javascript
// ✅ EFFICIENT - One recalc
manager.pauseFundRecalc();
// ... many updates ...
manager.resumeFundRecalc();

// ❌ INEFFICIENT - N recalcs
// ... many updates without pausing ...
```

### 3. **Cache Blockchain Calls**
```javascript
// ✅ GOOD - Uses fee cache (no amount = returns fee info object)
const feeInfo = getAssetFees('BTS');
console.log(feeInfo.createFee, feeInfo.updateFee);

// ✅ GOOD - With amount = returns net proceeds (number)
const netProceeds = getAssetFees('IOB.XRP', 100);

// ❌ BAD - Fetches every time
const fees = await BitShares.db.get_global_properties();
```

### 4. **Leverage Pool ID Caching (Patch 8)**

When deriving pool prices, the bot caches Liquidity Pool IDs to avoid repeated blockchain scans.

```javascript
// ✅ GOOD - Uses cached pool IDs
const price = await derivePoolPrice(assetA.symbol, assetB.symbol);
// First call: scans blockchain for pool
// Subsequent calls: uses cached ID if assets match

// Smart fallback: Cache miss triggers fresh scan
if (cachedPoolId.assets !== requestedAssets) {
    // Cache invalidated - rescan blockchain
    const newPoolId = await scanBlockchainForPool(assetA, assetB);
}

// ✅ Transparent: No manual cache management needed
```

**How It Works**:
- Cache validated against requested assets before use
- Stale pool IDs automatically detected and refreshed
- Concurrent access safe via lock protection

**Performance Impact**:
- Eliminates redundant blockchain scans during startup and config refresh
- Particularly effective during periodic 4-hour price refresh cycles

---

## Common Pitfalls

### 1. **Forgetting to Unlock Orders**
```javascript
// ❌ BAD - Lock never released if error
manager.lockOrders([id]);
await operation(); // Might throw
manager.unlockOrders([id]); // Never reached

// ✅ GOOD - Always unlocks
manager.lockOrders([id]);
try {
    await operation();
} finally {
    manager.unlockOrders([id]);
}
```

### 2. **Direct Map Modification**
```javascript
// ❌ BAD - Breaks indices
manager.orders.set(id, order);

// ✅ GOOD - Updates indices
manager._updateOrder(order);
```

### 3. **Ignoring State Transition Rules**
```javascript
// ❌ BAD - Invalid transition
order.state = ORDER_STATES.VIRTUAL; // Was PARTIAL
manager._updateOrder(order); // Error logged

// ✅ GOOD - Valid transition
order.state = ORDER_STATES.ACTIVE; // PARTIAL → ACTIVE is valid
manager._updateOrder(order);
```

### 4. **Not Checking Lock Status**
```javascript
// ❌ BAD - Might process locked order
processOrder(order);

// ✅ GOOD - Skip if locked
if (!manager.isOrderLocked(order.id)) {
    processOrder(order);
}
```

---

## Useful Debugging Commands

### Enable Debug Logging
```javascript
manager.logger.level = 'debug';
```

### View Fund Status
```javascript
manager.logger.logFundsStatus(manager, 'CONTEXT');
```

### View Grid Diagnostics
```javascript
manager.logger.logGridDiagnostics(manager, 'CONTEXT');
```

### View Metrics
```javascript
console.log(manager.getMetrics());
```

### Validate Indices
```javascript
const isValid = manager.validateIndices();
```

### Check Specific Order
```javascript
const order = manager.orders.get('buy-5');
console.log('State:', order.state);
console.log('Type:', order.type);
console.log('Locked?', manager.isOrderLocked(order.id));
```

---

## Resources

### Documentation
- [Architecture](architecture.md) - System design and module relationships
- [Fund Movement Logic](FUND_MOVEMENT_AND_ACCOUNTING.md) - Algorithms and formulas
- [README](../README.md) - User documentation
- [WORKFLOW](WORKFLOW.md) - Git branch workflow

### Code Entry Points
- `dexbot.js` - CLI entry point
- `modules/dexbot_class.js` - Core bot class
- `modules/order/manager.js` - Order management hub

### Key Modules
- `modules/order/accounting.js` - Fund tracking
- `modules/order/strategy.js` - Rebalancing logic
- `modules/order/grid.js` - Grid creation
- `modules/order/sync_engine.js` - Blockchain sync
- `modules/order/utils.js` - Shared utilities

---

## Testing Fund Calculations

Fund calculations are critical to system stability. This section covers how the test suite validates fund logic and how to add tests for new features.

### What Gets Tested

The test suite validates the following fund-related behaviors:

**Order State Transitions:**
```javascript
✓ VIRTUAL → ACTIVE → PARTIAL lifecycle
✓ Fund movement between pools during transitions
✓ Index consistency during state changes
✓ Invariant preservation during transitions
```

**Fund Pool Integrity:**
```javascript
✓ virtual.buy + virtual.sell = sum of all VIRTUAL orders
✓ committed.chain.buy = sum of ACTIVE orders with orderId
✓ committed.grid.buy = sum of ACTIVE + PARTIAL orders
✓ available.buy = max(0, chainFree - virtual - cache - fees)
```

**Critical Invariants:**
```javascript
✓ Invariant 1: chainTotal = chainFree + chainCommitted
✓ Invariant 2: available ≤ chainFree
✓ Invariant 3: gridCommitted ≤ chainTotal
```

**Edge Cases:**
```javascript
✓ Zero-size orders
✓ Very large orders (precision handling)
✓ Multiple concurrent state changes (atomicity)
✓ Fund deductions and additions
```

### Running Tests

```bash
# All tests (native assert)
npm test

# Specific logic area
node tests/test_accounting_logic.js

# Specific integration test
node tests/test_fills.js
```

### Understanding Test Structure

Tests use a consistent pattern for fund validation:

```javascript
describe('Fund Tracking - Fund Updates', () => {
    let manager;

    beforeEach(() => {
        // Setup manager with known initial state
        manager = new OrderManager(config);
        manager.setAccountTotals({
            buy: 10000,
            sell: 100
        });
        manager.resetFunds();
    });

    it('should calculate virtual funds from VIRTUAL orders', () => {
        // Add VIRTUAL order
        manager._updateOrder({
            id: 'virtual-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            size: 500
        }, 'test-virtual', false, 0);

        // Assert fund pool updated
        expect(manager.funds.virtual.buy).toBe(500);
        expect(manager.funds.total.grid.buy).toBeGreaterThanOrEqual(500);
    });
});
```

### Key Test Files

| File | Purpose | Test Count |
|------|---------|-----------|
| `tests/unit/strategy.test.js` | Rebalancing, placement, rotation | 16 |
| `tests/unit/accounting.test.js` | Fund tracking, fees, precision | 10 |
| `tests/unit/grid.test.js` | Grid creation, sizing | 8 |
| `tests/unit/manager.test.js` | State machine, indexing | 8 |
| `tests/unit/sync_engine.test.js` | Blockchain reconciliation | 6 |

### Adding Tests for Fund-Related Features

When adding features that affect funds, follow this checklist:

**1. Identify Fund Impact**
```javascript
// What fund pools are affected?
// - virtual (VIRTUAL orders)
// - committed.chain (ACTIVE orders with orderId)
// - committed.grid (ACTIVE + PARTIAL orders)
// - available (available pool)
// - cacheFunds (fill proceeds)
```

**2. Create Test Case**
```javascript
it('should [action] and update [fund pool]', () => {
    // Setup
    const initialFunds = manager.funds[poolName][side];

    // Action
    performAction();

    // Assert
    const finalFunds = manager.funds[poolName][side];
    expect(finalFunds).toBe(expectedValue);
    expect(manager.validateIndices()).toBe(true);  // Indices OK?
});
```

**3. Verify Invariants**
```javascript
// After your action, verify invariants
expect(
    manager.funds.total.chain.buy ===
    manager.funds.total.chain.buy + manager.funds.committed.chain.buy
).toBe(true);
```

**4. Test Edge Cases**
```javascript
// Test with:
✓ Zero funds available
✓ Very large orders (precision)
✓ Multiple concurrent updates
✓ State transitions
```

### Common Test Patterns

**Pattern 1: Batch Fund Updates**
```javascript
manager.pauseFundRecalc();  // Batch mode
manager._updateOrder(order1, 'test-batch', false, 0);
manager._updateOrder(order2, 'test-batch', false, 0);
manager._updateOrder(order3, 'test-batch', false, 0);
manager.resumeFundRecalc();  // Recalc once

// Verify final state
expect(manager.funds.total.grid.buy).toBe(order1.size + order2.size + order3.size);
```

**Pattern 2: Fund Transitions**
```javascript
// VIRTUAL → ACTIVE
manager._updateOrder({
    id: 'order-1',
    state: ORDER_STATES.VIRTUAL,
    size: 500
}, 'test-setup', false, 0);

const virtualBefore = manager.funds.virtual.buy;

manager._updateOrder({
    id: 'order-1',
    state: ORDER_STATES.ACTIVE,
    orderId: 'chain-001',
    size: 500
}, 'test-transition', false, 0);

// Verify movement
expect(manager.funds.virtual.buy).toBeLessThan(virtualBefore);
expect(manager.funds.committed.chain.buy).toBeGreaterThan(0);
```

**Pattern 3: Atomicity Check**
```javascript
// Verify operation is atomic (no partial state)
manager.lockOrders(['order-1']);
try {
    // Perform operation
    await fundDependentOperation();
    // Check state consistency
    expect(manager.validateIndices()).toBe(true);
} finally {
    manager.unlockOrders(['order-1']);
}
```

### Recent Test Coverage

The test suite provides comprehensive coverage of fund calculations and rebalancing logic:

**Key Areas Tested:**
- ✅ VIRTUAL order placement with zero available pool
- ✅ PARTIAL order updates during rebalancing
- ✅ Grid divergence detection with stale cache
- ✅ BoundaryIdx persistence and recovery
- ✅ BUY side geometric weighting
- ✅ CacheFunds integration and deduction
- ✅ Rotation completion and skip prevention
- ✅ Fee calculation with isMaker parameter
- ✅ Market and blockchain taker fees
- ✅ Fund precision and delta validation

**Running Tests**:
```bash
# Test strategy rebalancing
npx jest tests/unit/strategy.test.js

# Test grid divergence
npx jest tests/unit/grid.test.js

# Test accounting precision
npx jest tests/unit/accounting.test.js

# Test all funds-related
npx jest --testNamePattern="fund"
```

See [TEST_UPDATES_SUMMARY.md](TEST_UPDATES_SUMMARY.md) for detailed coverage.

### Debugging Fund Issues in Tests

If a test fails due to fund calculation issues:

```javascript
// 1. Print fund state
console.log('Fund state:', JSON.stringify(manager.funds, null, 2));

// 2. Check invariants
console.log('Invariants valid?', manager._verifyFundInvariants(
    manager,
    ...values
));

// 3. Trace order state
manager.orders.forEach(order => {
    console.log(`Order ${order.id}: state=${order.state}, size=${order.size}`);
});

// 4. Check index consistency
console.log('Indices valid?', manager.validateIndices());

// 5. Examine specific fund pool
console.log('Virtual buy:', manager.funds.virtual.buy);
console.log('Committed buy:', manager.funds.committed.grid.buy);
console.log('Available buy:', manager.funds.available.buy);
```

---

## Getting Help

### Common Questions

**Q: Where do I start reading the code?**  
A: Follow the Code Reading Roadmap above, starting with `constants.js` and `manager.js`.

**Q: How do I debug fund issues?**  
A: Use `manager.logger.logFundsStatus(manager)` and check invariants with `_verifyFundInvariants()`.

**Q: Why is my order not rotating?**  
A: Check if it's locked (`isOrderLocked()`), in exclusion list, or below dust threshold.

**Q: How do I add a new feature?**  
A: Follow the "How to Add New Features" section above.

**Q: Where are the tests?**  
A: Unit tests in `tests/unit/`, integration tests in `tests/`.

---

## Contributing

### Branch Workflow
```
test → dev → main
```

See [WORKFLOW.md](WORKFLOW.md) for detailed branching strategy.

### Before Submitting PR
1. Run tests: `npm test`
2. Verify fund invariants
3. Check index consistency
4. Update documentation
5. Add inline comments for complex logic

---

## Next Steps

1. **Read the Architecture**: [architecture.md](architecture.md)
2. **Understand Fund Logic**: [FUND_MOVEMENT_AND_ACCOUNTING.md](FUND_MOVEMENT_AND_ACCOUNTING.md)
3. **Follow Code Roadmap**: Start with `constants.js` → `manager.js`
4. **Try Debugging**: Enable debug logging and explore fund status
5. **Run Tests**: `npm test` to see how components work

Happy coding! 🚀
