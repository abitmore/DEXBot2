# DEXBot2 Architecture

This document provides a high-level overview of the DEXBot2 architecture, module relationships, and key data flows.

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
| **Accountant** | `accounting.js` | Fund tracking, fee management, invariant verification |
| **StrategyEngine** | `strategy.js` | Grid rebalancing, order rotation, partial order handling |
| **SyncEngine** | `sync_engine.js` | Blockchain synchronization, fill detection |
| **Grid** | `grid.js` | Grid creation, sizing, divergence detection |

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
| PARTIAL | ACTIVE | Consolidation | Lock additional funds if needed |
| PARTIAL | VIRTUAL | Order moved | Release funds, re-reserve |

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
        AVAILABLE[available<br/>= chainFree - virtual<br/>- cacheFunds - fees]
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
- **SPREAD**: Slots `[boundaryIdx + 1, boundaryIdx + G]` where G = spread gap size
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
    Strat->>Strat: Check for dust on both sides
    
    alt Dust on both sides
        Strat->>Strat: Force full rebalance
    else Normal fill
        Strat->>Strat: Identify shortages/surpluses
        Strat->>Strat: Prepare rotations
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

```mermaid
graph TB
    START[Grid Update Triggered] --> CALC[Calculate Ideal Grid<br/>Based on current funds]
    CALC --> COMPARE[Compare to Persisted Grid]
    COMPARE --> RMS[Calculate RMS Divergence<br/>For PARTIAL orders only]
    
    RMS --> CHECK{RMS > Threshold?}
    CHECK -->|Yes| UPDATE[Update Grid Sizes<br/>Trigger rebalance]
    CHECK -->|No| SKIP[Skip update]
    
    UPDATE --> PERSIST[Persist New Grid State]
    PERSIST --> DONE[Complete]
    SKIP --> DONE
```

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

## Related Documentation

- [Fund Movement Logic](fund_movement_logic.md) - Detailed mathematical formulas and algorithms
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
    manager._updateOrder(order);
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
