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
_updateOrder(order)

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
// Pattern 1: Update order state
manager._updateOrder({
    id: 'buy-5',
    state: ORDER_STATES.ACTIVE,
    type: ORDER_TYPES.BUY,
    price: 0.5,
    size: 100,
    orderId: '1.7.12345'
});

// Pattern 2: Batch updates
manager.pauseFundRecalc();
for (const order of orders) {
    manager._updateOrder(order);
}
manager.resumeFundRecalc(); // Recalculates once at end

// Pattern 3: Safe async operations
manager.lockOrders([orderId]);
try {
    await chainOperation();
} finally {
    manager.unlockOrders([orderId]);
}
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
const gapSlots = max(minSteps, targetSteps);

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
// ✅ CORRECT
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
// ✅ CORRECT - Recalculates once
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
// ✅ GOOD - Uses fee cache
const fees = getAssetFees('BTS', 1);

// ❌ BAD - Fetches every time
const fees = await BitShares.db.get_global_properties();
```

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
        });

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
manager._updateOrder(order1);
manager._updateOrder(order2);
manager._updateOrder(order3);
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
});

const virtualBefore = manager.funds.virtual.buy;

manager._updateOrder({
    id: 'order-1',
    state: ORDER_STATES.ACTIVE,
    orderId: 'chain-001',
    size: 500
});

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
