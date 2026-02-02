# DEXBot2 Architecture

This document provides a high-level overview of the DEXBot2 architecture, module relationships, and key data flows.

> **For practical development guidance**, see [developer_guide.md](developer_guide.md) for quick start, glossary, module deep dive, and common development tasks.

---

## System Overview

DEXBot2 is a grid trading bot for the BitShares blockchain. It maintains a geometric grid of limit orders that automatically rebalance as the market moves, capturing profit from price oscillations.

### Core Concepts

- **Grid**: A geometric array of price levels with orders placed at each level
- **Spread Zone**: A buffer of empty slots between buy and sell orders
- **Order States**: VIRTUAL (planned) → ACTIVE (on-chain) → PARTIAL (partially filled)
- **Fund Tracking**: Atomic accounting system preventing race conditions and overdrafts

---

## Module Architecture

```mermaid
graph TB
    subgraph "Entry Points"
        CLI[dexbot.js]
        BOT[bot.js]
        PM2[pm2.js]
    end

    subgraph "Core Bot"
        DEXBOT[DexBotClass<br/>modules/dexbot_class.js]
        CONSTANTS[Constants<br/>modules/constants.js]
    end

    subgraph "Order Management System"
        MANAGER[OrderManager<br/>modules/order/manager.js]
        
        subgraph "Specialized Engines"
            ACCOUNTANT[Accountant<br/>accounting.js]
            STRATEGY[StrategyEngine<br/>strategy.js]
            SYNC[SyncEngine<br/>sync_engine.js]
            GRID[Grid<br/>grid.js]
        end
        
        UTILS[Utils<br/>utils.js]
        LOGGER[Logger<br/>logger.js]
        RUNNER[Runner<br/>runner.js]
    end

    subgraph "Blockchain Layer"
        CHAIN_ORDERS[ChainOrders<br/>modules/chain_orders.js]
        ACCOUNT_ORDERS[AccountOrders<br/>modules/account_orders.js]
        ACCOUNT_BOTS[AccountBots<br/>modules/account_bots.js]
    end

    CLI --> DEXBOT
    BOT --> DEXBOT
    PM2 --> DEXBOT
    
    DEXBOT --> MANAGER
    DEXBOT --> CONSTANTS
    
    MANAGER --> ACCOUNTANT
    MANAGER --> STRATEGY
    MANAGER --> SYNC
    MANAGER --> GRID
    MANAGER --> UTILS
    MANAGER --> LOGGER
    MANAGER --> RUNNER
    
    STRATEGY --> UTILS
    ACCOUNTANT --> UTILS
    SYNC --> UTILS
    GRID --> UTILS
    
    RUNNER --> CHAIN_ORDERS
    SYNC --> ACCOUNT_ORDERS
    MANAGER --> ACCOUNT_BOTS
    
    CHAIN_ORDERS -.->|BitShares API| BLOCKCHAIN[(BitShares<br/>Blockchain)]
    ACCOUNT_ORDERS -.->|BitShares API| BLOCKCHAIN
```

---

## Order Manager: Central Coordinator

The `OrderManager` is the central hub that coordinates all order operations. It delegates specialized tasks to four engine modules:

### Engine Responsibilities

| Engine | File | Responsibility |
|--------|------|----------------|
| **Accountant** | `accounting.js` | **Single Source of Truth**. Centralized fund tracking via `recalculateFunds()`, fee management, invariant verification |
| **StrategyEngine** | `strategy.js` | Grid rebalancing, order rotation, partial order handling |
| **SyncEngine** | `sync_engine.js` | Blockchain synchronization, fill detection |
| **Grid** | `grid.js` | Grid creation, sizing, divergence detection |

---

## Pipeline Safety & Diagnostics

The bot includes a comprehensive pipeline monitoring system to prevent indefinite blocking and enable operational visibility.

### Pipeline Timeout Safeguard

**Problem**: Pipeline checks could block indefinitely if operations hung due to network issues or stuck corrections.

**Solution**: 5-minute timeout with automatic, non-destructive recovery.

**Configuration** (modules/constants.js):
```javascript
PIPELINE_TIMING: {
    TIMEOUT_MS: 300000,  // 5 minutes
}
```

**How It Works**:
- `isPipelineEmpty()` tracks when pipeline operations started blocking via `_pipelineBlockedSince` timestamp
- If blockage exceeds 5 minutes, `clearStalePipelineOperations()` is called (Patch 12, commit dd94044)
- Non-destructive recovery: clears operation flags only, does NOT delete orders or modify grid state
- Recovery called from `_executeMaintenanceLogic()` during periodic maintenance checks

**Location**: `modules/order/manager.js` lines 570-650

### Pipeline Health Diagnostics

**Purpose**: Enable production monitoring dashboards and alerting systems.

**Method**: `getPipelineHealth()`

**Returns** (8 diagnostic fields):
```javascript
{
    isEmpty: boolean,              // Pipeline is empty/clear?
    reasons: string[],             // Why pipeline is blocked (if blocked)
    blockedSince: number,          // Timestamp when blockage started (ms since epoch)
    blockedDurationMs: number,     // How long blocked (milliseconds)
    blockedDurationHuman: string,  // How long blocked (human-readable: "5m 30s")
    correctionsPending: number,    // Count of pending spread corrections
    gridSidesUpdated: string[],    // Which sides have queued updates ("BUY", "SELL", "BOTH")
}
```

**Integration**: Post-fill logging shows health status for operational visibility.

**Location**: `modules/order/manager.js` lines 650-700

### Data Flow

```mermaid
sequenceDiagram
    participant Bot as DexBotClass
    participant Mgr as OrderManager
    participant Sync as SyncEngine
    participant Strat as StrategyEngine
    participant Acct as Accountant
    participant Chain as Blockchain

    Bot->>Mgr: Initialize grid
    Mgr->>Acct: Reset funds
    Mgr->>Sync: Fetch account balances
    Sync->>Chain: Get balances
    Chain-->>Sync: Balance data
    Sync->>Acct: Set account totals
    Acct->>Acct: Recalculate funds
    
    Note over Mgr: Grid initialized, ready for trading
    
    Bot->>Sync: Detect fills (polling)
    Sync->>Chain: Get open orders
    Chain-->>Sync: Order data
    Sync->>Mgr: syncFromOpenOrders()
    Mgr->>Strat: processFilledOrders()
    Strat->>Acct: Update funds (cache proceeds)
    Strat->>Strat: Identify shortages/surpluses
    Strat->>Mgr: Rotate orders
    Mgr->>Acct: Deduct funds (atomic)
    Mgr->>Chain: Place new orders
```

---

## Order State Machine

Orders transition through three primary states during their lifecycle:

```mermaid
stateDiagram-v2
    [*] --> VIRTUAL: Grid created
    
    VIRTUAL --> ACTIVE: Order placed on-chain
    VIRTUAL --> SPREAD: After fill (placeholder)
    
    ACTIVE --> PARTIAL: Partial fill detected
    ACTIVE --> VIRTUAL: Order cancelled/rotated
    ACTIVE --> SPREAD: Order cancelled after fill
    
    PARTIAL --> ACTIVE: Consolidated (size >= ideal)
    PARTIAL --> VIRTUAL: Moved/consolidated
    PARTIAL --> SPREAD: Absorbed into spread
    
    SPREAD --> [*]: Grid regenerated
    
    note right of VIRTUAL
        No on-chain presence
        Funds reserved in virtual pool
    end note
    
    note right of ACTIVE
        On-chain with orderId
        Funds locked/committed
    end note
    
    note right of PARTIAL
        Partially filled on-chain
        Waiting for consolidation
    end note
    
    note right of SPREAD
        Placeholder for spread zone
        Always VIRTUAL state
    end note
```

### State Transition Rules

| From State | To State | Trigger | Fund Impact |
|------------|----------|---------|-------------|
| VIRTUAL | ACTIVE | Order placed | Deduct from `chainFree` |
| ACTIVE | PARTIAL | Partial fill | Reduce `committed` by filled amount |
| ACTIVE | VIRTUAL | Order cancelled | Add back to `chainFree` |
| PARTIAL | ACTIVE | Consolidation | Update to `idealSize` (releases dust to `cacheFunds`) |
| PARTIAL | VIRTUAL | Order moved | Release funds, re-reserve |

### Critical: Phantom Order Prevention

A **phantom order** is an illegal state where an order exists as ACTIVE/PARTIAL without a corresponding blockchain `orderId`. This corrupts fund tracking and causes "doubled funds" warnings.

**Why Phantoms Occur**:
1. **Grid Resize Bug**: `Grid._updateOrdersForSide()` could force VIRTUAL → ACTIVE without blockchain confirmation
2. **Sync Gap**: Orders without orderId could remain ACTIVE indefinitely if sync logic skipped them
3. **No Validation**: No centralized check prevented invalid state assignments

**Prevention System** (Three-Layer Defense):

| Layer | Location | Mechanism |
|-------|----------|-----------|
| **Guard** | `manager.js:570-584` | Centralized validation in `_updateOrder()` rejects ACTIVE/PARTIAL without orderId, auto-downgrades to VIRTUAL |
| **Grid Protection** | `grid.js:1154` | Preserve order state during resize: `state: order.state` instead of forcing ACTIVE |
| **Sync Cleanup** | `sync_engine.js:297-305` | Detect orders without orderId and convert to SPREAD placeholders; prevent phantom fills from triggering rebalancing |

**Verification**:
- Direct state assignment in code review: All transitions go through `_updateOrder()` (cannot bypass)
- Automated tests: `tests/repro_phantom_orders.js` confirms all prevention layers work
- Logging: Any phantom creation attempt is logged as ERROR with context

---

## Fund Flow Architecture

The fund tracking system uses atomic operations to prevent race conditions and overdrafts.

```mermaid
graph LR
    subgraph "Blockchain Balances"
        CHAIN_FREE[chainFree<br/>Unallocated funds]
        CHAIN_COMMITTED[committed.chain<br/>On-chain orders]
    end
    
    subgraph "Internal Tracking"
        VIRTUAL[virtual<br/>Reserved for VIRTUAL orders]
        CACHE[cacheFunds<br/>Fill proceeds + surplus]
        GRID_COMMITTED[committed.grid<br/>ACTIVE order sizes]
    end
    
    subgraph "Calculated Values"
        AVAILABLE[available<br/>= chainFree - virtual<br/>- fees]
        TOTAL_CHAIN[total.chain<br/>= chainFree + committed.chain]
        TOTAL_GRID[total.grid<br/>= committed.grid + virtual]
    end
    
    CHAIN_FREE --> AVAILABLE
    VIRTUAL --> AVAILABLE
    CACHE --> AVAILABLE
    
    CHAIN_FREE --> TOTAL_CHAIN
    CHAIN_COMMITTED --> TOTAL_CHAIN
    
    GRID_COMMITTED --> TOTAL_GRID
    VIRTUAL --> TOTAL_GRID
    
    style AVAILABLE fill:#90EE90
    style CACHE fill:#FFD700
    style VIRTUAL fill:#87CEEB
```

### Fund Components Explained

- **chainFree**: Unallocated funds on blockchain (from `accountTotals.buyFree/sellFree`)
- **committed.chain**: Funds locked in on-chain orders (ACTIVE orders with `orderId`)
- **committed.grid**: Internal tracking of ACTIVE order sizes
- **virtual**: Funds reserved for VIRTUAL orders (not yet on-chain)
- **cacheFunds**: Fill proceeds and rotation surplus (added to sizing calculations)
- **available**: Free funds for new orders = `max(0, chainFree - virtual - cacheFunds - fees)`

### Atomic Fund Operations

```mermaid
sequenceDiagram
    participant Strat as StrategyEngine
    participant Acct as Accountant
    participant Mgr as OrderManager

    Note over Strat: Want to place order<br/>size = 100
    
    Strat->>Acct: tryDeductFromChainFree(type, 100)
    
    alt Sufficient funds (available >= 100)
        Acct->>Acct: chainFree -= 100
        Acct->>Acct: virtual += 100
        Acct-->>Strat: true (success)
        Strat->>Mgr: Place order
    else Insufficient funds
        Acct-->>Strat: false (failed)
        Note over Strat: Order not placed<br/>No fund leak
    end
```

---

## Grid Topology

The grid uses a unified "Master Rail" with a dynamic boundary that shifts as fills occur.

```mermaid
graph LR
    subgraph "Master Rail (Price Levels)"
        direction LR
        B0[buy-0<br/>VIRTUAL]
        B1[buy-1<br/>ACTIVE]
        B2[buy-2<br/>ACTIVE]
        BOUNDARY{Boundary<br/>Index}
        S0[spread-0<br/>SPREAD]
        S1[spread-1<br/>SPREAD]
        S2[spread-2<br/>SPREAD]
        SELL0[sell-173<br/>ACTIVE]
        SELL1[sell-174<br/>ACTIVE]
        SELL2[sell-175<br/>VIRTUAL]
    end
    
    B0 --> B1 --> B2 --> BOUNDARY
    BOUNDARY --> S0 --> S1 --> S2
    S2 --> SELL0 --> SELL1 --> SELL2
    
    style B1 fill:#90EE90
    style B2 fill:#90EE90
    style S0 fill:#FFD700
    style S1 fill:#FFD700
    style S2 fill:#FFD700
    style SELL0 fill:#FF6B6B
    style SELL1 fill:#FF6B6B
    style BOUNDARY fill:#87CEEB
```

### Boundary Movement

- **Buy Fill**: `boundaryIdx -= 1` (shift left/down)
- **Sell Fill**: `boundaryIdx += 1` (shift right/up)

### Role Assignment

- **BUY**: Slots `[0, boundaryIdx]`
- **SPREAD**: Slots `[boundaryIdx + 1, boundaryIdx + G]` where G = spread gap size (empty slots). Actual gaps = G + 1.
- **SELL**: Slots `[boundaryIdx + G + 1, N]`

---

## Key Operations

### 1. Fill Processing Flow

```mermaid
sequenceDiagram
    participant Chain as Blockchain
    participant Sync as SyncEngine
    participant Strat as StrategyEngine
    participant Acct as Accountant
    participant Grid as Grid

    Chain->>Sync: Order filled
    Sync->>Sync: Detect fill
    Sync->>Strat: processFilledOrders([fills])
    
    Strat->>Acct: Add proceeds to cacheFunds
        Strat->>Strat: Check for side-wide Double Token
        alt Side is Doubled
            Strat->>Strat: Trigger Double Replacement (2 slots)
        end
    
    Strat->>Grid: Shift boundary
    Strat->>Acct: Deduct BTS fees from cache
    Strat->>Strat: Execute rotations
```

### 2. Order Rotation (Crawl Mechanism)

```mermaid
graph TB
    START[Fill Detected] --> SHIFT[Shift Boundary]
    SHIFT --> IDENTIFY[Identify Shortages<br/>Empty slots in active window]
    IDENTIFY --> CHECK{Surpluses<br/>Available?}
    
    CHECK -->|Yes| CRAWL[Select Crawl Candidate<br/>Furthest active order]
    CHECK -->|No| NEW[Place New Order<br/>if funds available]
    
    CRAWL --> COMPARE{Shortage price<br/>better than<br/>surplus price?}
    COMPARE -->|Yes| ROTATE[Rotate Order<br/>Cancel old, place new]
    COMPARE -->|No| SKIP[Skip rotation]
    
    ROTATE --> NEXT{More<br/>shortages?}
    SKIP --> NEXT
    NEW --> NEXT
    
    NEXT -->|Yes| IDENTIFY
    NEXT -->|No| DONE[Rebalance Complete]
```

### 3. Grid Divergence Detection

The grid divergence system monitors and corrects misalignment between ideal grid state and persistent blockchain state.

```mermaid
graph TB
    START[Grid Update Triggered] --> CALC[Calculate Ideal Grid<br/>Based on current funds]
    CALC --> RELOAD["Force Reload Persisted Grid<br/>Ensure fresh blockchain state"]
    RELOAD --> COMPARE[Compare to Persisted Grid]
    COMPARE --> RMS[Calculate RMS Divergence<br/>For PARTIAL orders only]
    
    RMS --> CHECK{RMS > Threshold?}
    CHECK -->|Yes| UPDATE[Update Grid Sizes<br/>Trigger rebalance]
    CHECK -->|No| SKIP[Skip update]
    
    UPDATE --> PERSIST[Persist New Grid State]
    PERSIST --> DONE[Complete]
    SKIP --> DONE
```

**Key Improvement (v0.6.1)**: Force reload mechanism now ensures fresh persisted grid data before comparison, preventing stale cache from causing false divergence detections.

---

## Concurrency & Locking

The system uses order-level locks to prevent race conditions during async operations.

### Lock Mechanism

```mermaid
sequenceDiagram
    participant Sync as SyncEngine
    participant Strat as StrategyEngine
    participant Mgr as OrderManager

    Note over Sync: Detected fill on order P1
    Sync->>Mgr: lockOrders([P1])
    Sync->>Sync: Process fill
    
    par Concurrent Strategy Check
        Strat->>Mgr: isOrderLocked(P1)?
        Mgr-->>Strat: true
        Note over Strat: Skip P1 (locked)
    end
    
    Sync->>Sync: Complete fill processing
    Sync->>Mgr: unlockOrders([P1])
    
    Note over Strat: Next cycle can now process P1
```

### Lock Lifetime

- **Default timeout**: 5-10 seconds
- **Auto-expiry**: Prevents deadlocks from crashes
- **Best practice**: Always use try/finally to ensure unlock

---

## Module Responsibilities Summary

| Module | Primary Responsibility | Key Functions |
|--------|----------------------|---------------|
| **OrderManager** | Central coordinator, state management | `_updateOrder()`, `lockOrders()`, `getOrdersByTypeAndState()` |
| **Accountant** | Fund tracking, fee management | `recalculateFunds()`, `tryDeductFromChainFree()`, `_verifyFundInvariants()` |
| **StrategyEngine** | Rebalancing, rotation, partial handling | `rebalance()`, `processFilledOrders()`, `preparePartialOrderMove()` |
| **SyncEngine** | Blockchain sync, fill detection | `syncFromOpenOrders()`, `synchronizeWithChain()` |
| **Grid** | Grid creation, sizing, divergence | `createOrderGrid()`, `compareGrids()`, `checkAndUpdateGridIfNeeded()` |
| **Utils** | Shared utilities, conversions | `calculateAvailableFundsValue()`, `floatToBlockchainInt()`, `parseChainOrder()` |
| **Logger** | Formatted logging, diagnostics | `logOrderGrid()`, `logFundsStatus()`, `logGridDiagnostics()` |

---

## Dynamic Configuration Refresh

The bot implementation supports runtime updates to specific configuration parameters without requiring a process restart. This is handled via a **Periodic Configuration Refresh** mechanism.

### The Refresh Cycle

Every 4 hours (default `BLOCKCHAIN_FETCH_INTERVAL_MIN`), the bot performs the following safe refresh cycle:

1.  **Thread-Safe Load**: The bot re-reads `profiles/bots.json` using `readBotsFileWithLock` to ensure it doesn't collide with manual edits or the CLI manager.
2.  **Memory Update**: It identifies its own configuration entry and updates its internal memory state (`this.config` and `manager.config`).
3.  **Non-Disruptive Application**: The refresh is designed to be **passive**. It updates valuation anchors but does **not** trigger on-chain order movement automatically.

### Configuration Authority: `startPrice`

The `startPrice` parameter follows a strict hierarchy of authority:

| Setting Type | Source | Behavior |
|--------------|--------|----------|
| **Numeric** | `bots.json` | **Single Source of Truth**. Blocks all auto-derivation. Used as a fixed anchor for valuation and grid resets. |
| **"pool"** | Blockchain | Derived from current Liquidity Pool price during resets or 4h refresh cycles. |
| **"market"** | Blockchain | Derived from current Orderbook price during resets or 4h refresh cycles. |

---

## Data Persistence

```mermaid
graph LR
    subgraph "In-Memory State"
        ORDERS[orders Map<br/>Grid state]
        FUNDS[funds Object<br/>Fund tracking]
        INDICES[Indices<br/>_ordersByState<br/>_ordersByType]
    end
    
    subgraph "Persisted State"
        ACCOUNT_JSON[account.json<br/>Grid snapshot<br/>cacheFunds]
        BOTS_JSON[bots.json<br/>Bot config]
    end
    
    ORDERS --> ACCOUNT_JSON
    FUNDS --> ACCOUNT_JSON
    
    ACCOUNT_JSON -.->|Load on startup| ORDERS
    ACCOUNT_JSON -.->|Load on startup| FUNDS
    
    BOTS_JSON -.->|Load on startup| CONFIG[Bot Config]
```

### Persistence Strategy

- **Grid state**: Persisted after every rebalance to `account.json`
- **cacheFunds**: Persisted to survive bot restarts
- **Retry logic**: 3 attempts with exponential backoff
- **Graceful degradation**: Bot continues if persistence fails (in-memory only)

---

## Memory-Only Integer Tracking

The system has been optimized to use a "memory-driven" model for order updates, eliminating redundant blockchain API calls during normal operation.

### Key Changes

**1. Raw Order Cache (`rawOnChain`)**
- Grid slots now store exact blockchain order representations (integers/satoshis) in a `rawOnChain` cache
- **Birth**: Cache populated immediately after successful order placement using broadcasted arguments
- **Partial Fills**: Cache updated in-place via integer subtraction (subtracting filled satoshis from `for_sale`)
- **Updates/Rotations**: Cache refreshed with adjusted integers returned by build process

**2. Eliminated Redundant API Calls**
- Removed all `readOpenOrders()` calls from `_buildSizeUpdateOps()` and `_buildRotationOps()`
- Removed `computeVirtualOpenOrders()` logic that was redundantly fetching entire account state
- The bot now trusts its internal state, backed by real-time fill listener, to build transactions

**3. Refactored `buildUpdateOrderOp()`**
- Updated to support optional `cachedOrder` parameter
- Allows callers to bypass blockchain queries if they have raw state in memory
- Returns `finalInts` along with operation data for local tracking

**4. Self-Healing Resilience**
- Maintains "State Recovery Sync" fallback
- If a memory-driven transaction fails, bot catches error and performs a full refresh
- Ensures internal ledger stays synchronized with BitShares blockchain

### Benefits
- **Faster reaction time**: No waiting for blockchain queries during order updates
- **Reduced API load**: Fewer fetches, less network congestion
- **Mathematical precision**: Integer-based tracking prevents float precision errors
- **Fallback safety**: Automatic recovery if memory state becomes inconsistent

### Performance Impact
- Batch operations (size updates, rotations) now run without any blockchain fetches
- Only placement operations and recovery syncs query the blockchain
- Estimated **10-20x speedup** for high-frequency operations

---

## Error Handling & Safety

### Fund Invariants

The system continuously monitors three mathematical invariants:

1. **Account Equality**: `chainTotal = chainFree + committed.chain`
2. **Committed Ceiling**: `committed.grid <= chainTotal`
3. **Available Leak Check**: `available <= chainFree`

**Tolerance**: 0.1% (to account for fees and rounding)

### Index Consistency

- **Validation**: `validateIndices()` checks Map ↔ Set consistency
- **Repair**: `_repairIndices()` rebuilds indices if corruption detected
- **Defensive**: Called after critical operations

---

## Performance Considerations

### Optimization Strategies

1. **Batch fund recalculation**: `pauseFundRecalc()` / `resumeFundRecalc()`
2. **Index-based lookups**: O(1) access via `_ordersByState` and `_ordersByType`
3. **Lock expiry**: Prevents permanent blocking from crashes
4. **Fee caching**: Reduces blockchain API calls

### Metrics Tracking

```javascript
manager.getMetrics()
// Returns:
// - fundRecalcCount
// - invariantViolations
// - lockAcquisitions
// - stateTransitions
// - lastSyncDurationMs
```

---

### Testing Strategy & Quality Assurance

DEXBot2 uses a native Node.js `assert` testing strategy to ensure reliability without heavy dependencies.

### Test Coverage by Module

```mermaid
graph LR
    A["Logic Tests<br/>(tests/test_*_logic.js)"]
    B["Integration Tests<br/>(tests/test_*.js)"]

    A -->|Manager, State Machine| A1["manager_logic"]
    A -->|Fund Tracking| A2["accounting_logic"]
    A -->|Grid Creation| A3["grid_logic"]
    A -->|Rebalancing| A4["strategy_logic"]
    A -->|Sync Logic| A5["sync_logic"]

    B -->|Multi-step Scenarios| B1["Market Scenarios"]
    B -->|Edge Cases| B2["Partial Order Tests"]
    B -->|Real-world Scenarios| B3["Fills/FEE Tests"]
```

### Running Tests

```bash
# Run all tests (native assert)
npm test

# Specific logic area
node tests/test_accounting_logic.js
```

### Test Quality Metrics

**Coverage Goals:**
- ✅ All public methods have tests
- ✅ All invariants verified automatically
- ✅ Edge cases covered (zero funds, max orders, etc.)
- ✅ Concurrent operations tested with locks
- ✅ State transitions validated end-to-end

**Recent Improvements (2026-01-09):**
- Added 23 new test cases for recent bugfixes
- Created comprehensive strategy engine tests
- Enhanced accounting tests with fee validation
- Added fund precision and delta tests

### Testing Best Practices

**For Developers:**

1. **Run tests before commits**
   ```bash
   npm test
   ```

2. **Add tests for new features**
   - Follow patterns in existing tests
   - Test fund impact of new logic
   - Include edge cases

3. **Verify invariants**
   ```javascript
   expect(manager.validateIndices()).toBe(true);
   expect(chainTotal === chainFree + chainCommitted).toBe(true);
   ```

4. **Use debug mode for problematic scenarios**
   ```javascript
   manager.logger.level = 'debug';  // Enable detailed logging
   // ... run scenario ...
   // Check console output for detailed fund tracking
   ```

### Test Documentation References

- **[TEST_UPDATES_SUMMARY.md](TEST_UPDATES_SUMMARY.md)** - Detailed test coverage for 23 new test cases
  - Maps each test to specific bugfixes
  - Shows what each test validates
  - Running instructions for specific areas

- **[developer_guide.md#testing-fund-calculations](developer_guide.md#testing-fund-calculations)** - Testing guide for developers
  - How to write fund tests
  - Common test patterns
  - Debugging failing tests
  - Adding tests for new features

- **[TESTING_IMPROVEMENTS.md](TESTING_IMPROVEMENTS.md)** - Lessons from bugfix iteration
  - What caused bugs in 0.4.x
  - How tests prevent regressions
  - Design validation checklist

---

## Recent Improvements

### Grid Rebalancing Robustness

The strategy engine has been significantly strengthened with improvements to fund validation, dust handling, and order constraints:

**1. Pre-Flight Fund Validation**
- Before executing batch order placements, available funds are validated
- Prevents insufficient fund errors during large rotation cycles
- Uses atomic check-and-deduct pattern for safety
- Located in: `modules/order/strategy.js` - `rebalanceSideRobust()`

**2. Dust Partial Prevention**
- Improved dust detection algorithm prevents false positives
- Double-creation of dust partials eliminated
- Dust consolidation now happens in single operation
- Detects dust as `< 5% of ideal order size`

**3. Strict Order Size Constraints**
- Orders validated to not exceed available funds
- Maximum order size enforced during both placement and rotation
- Prevents oversized orders that fail on-chain
- Atomic validation with placement ensures consistency

**4. Boundary Index Persistence**
- BoundaryIdx (spread zone pivot) now correctly persisted across bot restarts
- Ensures grid rotation continues seamlessly after divergence correction
- Fixes grid instability from incorrect boundary tracking

**5. Taker Fee Accounting**
- Both market and blockchain taker fees now accounted for correctly
- Fee deduction uses proper `isMaker` parameter
- Prevents fund leaks from missing fee calculations
- Located in: `modules/order/strategy.js` - `processFilledOrders()`

**7. Precision Spread Management (Logarithmic Logic)**
- **Discrete Step Tracking**: Replaced the legacy linear multiplier (`SPREAD_WIDENING_MULTIPLIER`) with a discrete 1-slot logarithmic buffer. This ensures correction triggers exactly when the market moves by one full increment.
- **Center-Gap Awareness**: Refined the grid initialization math to account for the "Center Gap" naturally created during symmetric centering. This reduces the initial spread by ~0.5% (one full increment) compared to the previous version.
- **Collision-Free Safety**: Increased `MIN_SPREAD_FACTOR` to 2.1 to ensure that the security minimum (2 spread orders) never conflicts with the spread correction threshold, even at micro-spread configurations.

### Related Documentation

For detailed fund calculations and test coverage, see:
- [developer_guide.md#testing-fund-calculations](developer_guide.md#testing-fund-calculations) - How fund calculations are tested
- [TEST_UPDATES_SUMMARY.md](TEST_UPDATES_SUMMARY.md) - Detailed coverage of recent bugfix tests

---

- [Fund Movement Logic](FUND_MOVEMENT_AND_ACCOUNTING.md) - Detailed mathematical formulas and algorithms
- [Developer Guide](developer_guide.md) - Code navigation and onboarding
- [README.md](../README.md) - User documentation and setup
- [WORKFLOW.md](WORKFLOW.md) - Git branch workflow

---

## Quick Reference

### Common Code Patterns

**Get orders by state and type:**
```javascript
const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
```

**Atomic fund deduction:**
```javascript
if (manager.accountant.tryDeductFromChainFree(orderType, size)) {
    // Funds deducted, safe to place order
} else {
    // Insufficient funds, skip
}
```

**Batch order updates:**
```javascript
manager.pauseFundRecalc();
for (const order of orders) {
    // context parameter helps with logging/debugging the source of the update
    manager._updateOrder(order, 'batch-update', false, 0);
}
manager.resumeFundRecalc(); // Recalculates once
```

**Lock orders during async operations:**
```javascript
manager.lockOrders([orderId]);
try {
    await asyncOperation();
} finally {
    manager.unlockOrders([orderId]);
}
```
