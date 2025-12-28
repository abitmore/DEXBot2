# Changelog

All notable changes to this project will be documented in this file.

---

**Note on v0.4.6**: This version includes a backported critical cacheFunds double-counting fix that was originally released in v0.4.7, then retagged to v0.4.6 for proper patch versioning. v0.4.7 release was deleted. Users should upgrade to v0.4.6 to fix the 649.72 BTS discrepancy issue.

---

## [0.4.6] - 2025-12-28 - CacheFunds Double-Counting Fix & Race Condition Prevention

### Fixed
- **CRITICAL: CacheFunds Double-Counting in Partial Fills**: Fixed proceeds being counted twice
  - **Problem**: When partial fill occurred, proceeds added to chainFree, then available recalculated from updated chainFree (which included proceeds), resulting in both proceeds + available added to cacheFunds
  - **Impact**: User reported 649.72 BTS discrepancy in fund accounting
  - **Solution**: Store available funds before updating chainFree in `_adjustFunds()`, use pre-update value in `processFilledOrders()` instead of recalculating
  - **Result**: Proceeds counted once while preserving fund cycling feature for new deposits
  - **Bug Timeline**: Introduced in v0.4.0 with fund consolidation refactor, present through v0.4.5

- **20+ Race Conditions Across Codebase**: Comprehensive race condition prevention using AsyncLock pattern
  - TOCTOU (Time-of-Check-Time-of-Use) in file persistence operations
  - Read-modify-write races on global state variables
  - Concurrent account subscription management
  - Account resolution cache synchronization
  - Order grid synchronization races
  - Concurrent fill processing with AsyncLock queuing

### Added
- **AsyncLock Utility**: New queue-based mutual exclusion system (modules/order/async_lock.js)
  - FIFO queue-based synchronization for async operations
  - Prevents concurrent operations from interfering with critical sections
  - Proper error handling and re-throwing
  - Used to protect all critical sections across codebase

- **Fresh Data Reload on Write**: All write operations reload from disk before persisting
  - `storeMasterGrid()`: Reloads before writing grid snapshot
  - `updateCacheFunds()`: Always reload to prevent stale data overwrites
  - `updateBtsFeesOwed()`: Always reload to ensure fresh state
  - Fixes race between processes where stale in-memory data overwrites fresh state

- **forceReload Option**: Added to all load methods for explicit fresh data reads
  - `loadBotGrid(botKey, forceReload)`: Optional fresh disk read
  - `loadCacheFunds(botKey, forceReload)`: Optional fresh disk read
  - `loadBtsFeesOwed(botKey, forceReload)`: Optional fresh disk read
  - `getDBAssetBalances(botKeyOrName, forceReload)`: Optional fresh disk read

### Changed
- **Per-Bot File Architecture**: Now protected with AsyncLock for safe concurrent writes
  - Existing per-bot mode (each bot has own file: `profiles/orders/{botKey}.json`) now race-safe
  - `_persistenceLock` serializes all write operations to prevent TOCTOU races
  - `ensureBotEntries()` now async with lock protection
  - Per-bot subscriptions and resolution cache also protected
  - Legacy shared mode still supported for backward compatibility

- **AsyncLock Patterns**: Multiple lock instances for different critical sections
  - `_fillProcessingLock`: Serializes fill event processing in dexbot_class
  - `_divergenceLock`: Protects divergence correction operations
  - `_correctionsLock`: Protects ordersNeedingPriceCorrection in manager
  - `_persistenceLock`: Protects file I/O operations in account_orders
  - `_subscriptionLock`: Protects accountSubscriptions map in chain_orders
  - `_preferredAccountLock`: Protects preferredAccount global state
  - `_resolutionLock`: Protects account resolution cache

- **Persistence Methods Now Async**:
  - `manager.deductBtsFees()`: Made async, uses lock
  - `manager._persistWithRetry()`: Made async
  - `manager._persistCacheFunds()`: Made async
  - `manager._persistBtsFeesOwed()`: Made async
  - `grid._clearAndPersistCacheFunds()`: Made async, awaited
  - `grid._persistCacheFunds()`: Made async, awaited
  - All callers properly await these methods

- **Account Subscription Management**: Atomic check-and-set with AsyncLock
  - `_ensureAccountSubscriber()`: Uses lock to prevent duplicate subscriptions
  - `listenForFills()`: Protects callback registration inside lock
  - `unsubscribe()`: Atomic removal with lock protection

### Technical Details
- **TOCTOU Fix**: Reload-before-write prevents stale in-memory overwrites
  - Example: Process A reads file, Process B writes update, Process A overwrites with stale data
  - Solution: Always reload immediately before writing
  - Applied to: storeMasterGrid, updateCacheFunds, updateBtsFeesOwed

- **Async/Await Consistency**: All async operations properly awaited
  - No fire-and-forget promises
  - Proper error propagation throughout call chains
  - Busy-wait loops replaced with proper async setTimeout

- **Lock Nesting**: Careful lock ordering prevents deadlocks
  - No nested lock acquisition (locks released before acquiring another)
  - Each critical section has single responsible lock

### Testing
- All 20 integration tests passing ✅
- Test coverage includes: ensureBotEntries, storeMasterGrid, cacheFunds persistence, fee deduction
- Grid comparison, startup reconciliation, partial order handling all verified

### Migration
- **Backward Compatible**: No breaking changes to APIs or configuration
- **No Schema Changes**: File format unchanged; existing bot data continues to work
- **Transparent to Users**: Race condition fixes are internal improvements

---

## [0.4.5] - 2025-12-27 - Partial Order Counting & Grid Navigation Fix

### Fixed
- **Partial Orders Not Counted in Grid Targets**: Critical bug in rebalancing logic
  - Partial filled orders were excluded from order target counting
  - Caused bot to create unnecessary orders even when at target capacity
  - Now counts both ACTIVE and PARTIAL orders toward target
  - Prevents "mixing up" of grid positions and erroneous order creation

- **Grid Navigation Limited by ID Namespace**: Critical bug in partial order movement
  - `preparePartialOrderMove()` used ID-based navigation (sell-N/buy-N)
  - Could not move partial orders across sell-*/buy-* namespace boundaries
  - Example: sell-173 (highest sell slot) couldn't move to buy-0 (adjacent by price)
  - **Now uses price-sorted navigation** for fluid grid movement
  - Partial orders can now move anywhere in the grid without artificial boundaries

### Added
- **`countOrdersByType()` Helper Function** in utils.js
  - Counts both ACTIVE and PARTIAL orders by type
  - Used consistently across order target comparisons
  - Ensures partial orders take up real grid positions

### Changed
- **Order Target Checks**: Updated to include partial orders
  - `checkSpreadCondition()` (line 1396): Includes partials in "both sides" check
  - Rebalancing checks (lines 1747, 1851): Uses `countOrdersByType()`

- **Spread Calculation**: Updated to include partial orders
  - `calculateCurrentSpread()` (line 2577): Combines ACTIVE + PARTIAL orders
  - Partial orders are on-chain and affect actual market spread

### Technical Details
- Grid is now treated as fluid: no artificial boundaries during fill handling
- Price-sorted navigation allows unrestricted partial order movement
- All 18 test suites pass
- Fixed crossed rotation test expectations (test_crossed_rotation.js)

---

## [0.4.4] - 2025-12-27 - Code Consolidation & BTS Fee Deduction Fix

### Fixed
- **BTS Fee Deduction on Wrong Side**: Critical bug in grid resize operations
  - Fixed fee deduction logic that incorrectly applied to non-BTS side during order resizing
  - XRP/BTS pairs: BTS fees no longer deducted from XRP (SELL side) funds
  - Buy side (assetB): Only deduct if assetB === 'BTS'
  - Sell side (assetA): Only deduct if assetA === 'BTS'
  - Fixes 70% order size reduction issue during grid resize

### Changed
- **Fee Multiplier Update**: Increased from 4x to 5x
  - Now reserves: 1x for initial creation + 4x for rotation buffer (was 3x)
  - Provides better buffer for multiple rotation cycles

### Refactored
- **Code Consolidation**: Moved 22 grid utility functions from grid.js to utils.js
  - Eliminated duplicate code and scattered inline requires
  - Centralized reusable utilities for consistent access across modules
  - Added 15 new utility functions for common operations

- **Grid Utilities Added to utils.js**:
  - Numeric: `toFiniteNumber`, `isValidNumber`, `compareBlockchainSizes`, `computeSizeAfterFill`
  - Order filtering: `filterOrdersByType`, `filterOrdersByTypeAndState`, `sumOrderSizes`, `mapOrderSizes`
  - Precision: `getPrecisionByOrderType`, `getPrecisionForSide`, `getPrecisionsForManager`
  - Size validation: `checkSizesBeforeMinimum`, `checkSizesNearMinimum`
  - Fee calculation: `calculateOrderCreationFees`, `deductOrderFeesFromFunds`
  - Grid sizing: `allocateFundsByWeights`, `calculateOrderSizes`, `calculateRotationOrderSizes`, `calculateGridSideDivergenceMetric`, `getOrderTypeFromUpdatedFlags`, `resolveConfiguredPriceBound`

- **Manager Helper Methods**: Added fund/chainFree tracking
  - `_getCacheFunds(side)`: Safe access to cache funds
  - `_getGridTotal(side)`: Safe access to grid totals
  - `_deductFromChainFree(orderType, size, operation)`: Track fund movements
  - `_addToChainFree(orderType, size, operation)`: Track fund releases

- **Code Cleanup**: Removed debug console.log statements from chain_orders.js

### Technical Details
- Reduced grid.js from 1190 to 635 lines (-46%)
- All 18 test suites pass
- Rotation and divergence check behavior unchanged
- Net +166 lines: Justified by new utilities and JSDoc documentation

---

## [0.4.3] - 2025-12-26 - Order Pairing, Rebalance & Fee Reservation Fixes

### Fixed
- **Asymmetric Rebalance Orders Logic for BUY Fills**: Corrected order matching in rebalanceOrders function
  - Fixed logic that incorrectly paired BUY orders during rebalancing operations
  - Ensures proper order pairing for asymmetric buy/sell scenarios

- **Order Pairing Sorting & Startup Reconciliation**: Optimized order matching algorithm
  - Implemented proper sorting for order pairing to ensure consistent matching
  - Improved startup reconciliation performance and reliability

- **Grid Data Corruption Prevention**: Added validation for order sizes and IDs
  - Prevented undefined size values from corrupting grid data
  - Added null ID checks to prevent invalid order state

- **BTS Fee Reservation During Resize**: Fixed target order selection
  - Use target orders for BTS fee reservation calculations during order resizing
  - Ensures accurate fee reservation across resize operations

- **4x Blockchain Fee Buffer Enforcement**: Corrected fee buffer application
  - Respect 4x blockchain fee buffer consistently during order resizing
  - Added 100 BTS fallback for adequate fee reservation

- **Grid Edge State Synchronization**: Fixed manager state sync after reducing largest order
  - Search by blockchain orderId to find matching grid order in manager.orders
  - Ensures manager's local grid state matches blockchain after order reduction

- **Grid Edge Order Reconciliation**: Refactored cancel+create for better efficiency
  - Replace reduce+restore with cancel+create approach (N+1 vs N+2 operations)
  - Phase 1: Cancel largest order to free funds
  - Phase 2: Update remaining orders to targets
  - Phase 3: Create new order for cancelled slot
  - Simplified logic with proper index alignment

- **Vacated Slot Size Preservation**: Fixed orphaned virtual orders from partial moves
  - Don't set vacated slots to size: 0 after partial order moves
  - Prevents "no size defined" warnings when slots are reused for new orders
  - Detects already-claimed slots to avoid conflicts with new order placement
  - Complements the "below target" path that uses vacated slots for new order creation

### Changed
- Removed unused `bot_instance.js` module for code cleanup
- Enhanced `startup_reconcile` documentation in README
- Optimized grid edge reconciliation strategy for fewer blockchain operations

---

## [0.4.2] - 2025-12-24 - Grid Recalculation Fixes & Documentation Updates

### Fixed
- **Grid Recalculation in Post-Rotation Divergence Flow**: Added missing grid recalculation call
  - **Problem**: Orders were losing size information during post-rotation divergence correction
  - **Symptoms**: "Skipping virtual X - no size defined" warnings, "Cannot read properties of undefined (reading 'toFixed')" batch errors
  - **Solution**: Added `Grid.updateGridFromBlockchainSnapshot()` call to post-rotation flow, matching startup and timer divergence paths
  - **Impact**: Prevents order size loss during divergence correction cycles

- **PARTIAL Order State Preservation at Startup**: Fixed state inconsistency during synchronization
  - **Problem**: PARTIAL orders (those with remaining amounts being filled) were unconditionally converted to ACTIVE state at startup
  - **Symptoms**: False divergence spikes (700%+ divergence), state mismatches between persistedGrid and calculatedGrid, unnecessary grid recalculations
  - **Solution**: Preserve PARTIAL state across bot restarts if already set; only convert VIRTUAL orders to ACTIVE when matched on-chain
  - **Impact**: Eliminates false divergence detection and maintains consistent order state across restarts

- **Redundant Grid Recalculation Removal**: Eliminated duplicate processing in divergence correction
  - **Problem**: Grid was being recalculated twice when divergence was detected (once by divergence check, once by correction function)
  - **Symptoms**: Double order size updates, unnecessary blockchain fetches, performance inefficiency
  - **Solution**: Removed redundant recalculation from `applyGridDivergenceCorrections()` since caller already recalculates
  - **Impact**: Single grid recalculation per divergence event, improved performance

- **BTS Fee Formula Documentation**: Updated outdated comments and logged output to accurately reflect the complete fee calculation formula
  - Fixed `modules/order/grid.js`: Changed comment from "2x multiplier" to "4x multiplier" to match actual implementation
  - Updated formula in 5 files to show complete formula: `available = max(0, chainFree - virtuel - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)`
  - Fixed `modules/order/logger.js`: Console output now displays full formula instead of simplified version
  - Updated `modules/order/manager.js`: Changed variable name references from ambiguous "4xReservation" to proper "btsFeesReservation"
  - Fixed `modules/account_bots.js`: Comment now correctly states default targetSpreadPercent is 4x not 3x

---

## [0.4.1] - 2025-12-23 - Order Consolidation, Grid Edge Handling & Partial Order Fixes

### Features
- **Code Consolidation**: Eliminated ~1,000 lines of duplicate code across entry points
  - Extracted shared `DEXBot` class to `modules/dexbot_class.js` (822 lines)
  - bot.js refactored from 1,021 → 186 lines
  - dexbot.js refactored from 1,568 → 598 lines
  - Unified class-based approach with logPrefix options for context-specific behavior
  - Extracted `buildCreateOrderArgs()` utility to `modules/order/utils.js`

- **Conditional Rotation**: Smart order creation at grid boundaries
  - When active order count drops below target, creates new orders instead of rotating
  - Handles grid edge cases where fewer orders can be placed near min/max prices
  - Seamlessly transitions back to normal rotation when target is reached
  - Prevents perpetual deficit caused by edge boundary constraints
  - Comprehensive test coverage with edge case validation

- **Repository Statistics Analyzer**: Interactive git history visualization
  - Analyzes repository commits and generates beautiful HTML charts
  - Tracks added/deleted lines across codebase with daily granularity
  - Charts include daily changes and cumulative statistics
  - Configurable file pattern filtering for focused analysis
  - Script: `scripts/analyze-repo-stats.js`

### Fixed
- **Partial Order State Machine Invariant**: Guaranteed PARTIAL orders always have size > 0
  - Fixed bug in `synchronizeWithChain()` where PARTIAL could be set with size = 0
  - Proper state transitions: ACTIVE (size > 0) → PARTIAL (size > 0) → SPREAD (size = 0)
  - PARTIAL and SPREAD orders excluded from divergence calculations
  - Prevents invalid order states from persisting to storage

### Changed
- **Entry Point Architecture**: Simplified bot.js and dexbot.js to thin wrappers
  - Removed duplicate class definitions
  - All core logic now centralized in `modules/dexbot_class.js`
  - Reduces maintenance overhead and improves consistency
  - Options object pattern enables context-specific behavior (e.g., logPrefix)

### Testing
- Added comprehensive test suite for conditional rotation edge cases
- Added state machine validation tests for partial orders
- All tests passing with improved grid coverage scenarios

### Technical Details
- **Grid Coverage Recovery**: Gradual recovery mechanism for edge-bound grids
  - Shortage = `targetCount - currentActiveCount`
  - Creates `min(shortage, fillCount)` new orders per fill cycle
  - Continues until target is reached, then resumes rotation
  - Respects available virtual orders (no over-activation)

- **Code Quality**: Significant reduction in complexity and duplication
  - Common patterns unified in shared class
  - Easier to maintain and update core logic
  - Improved testability with centralized implementation

---

## [0.4.0] - 2025-12-22 - Fund Management Consolidation & Automatic Fund Cycling

### Features
- **Automatic Fund Cycling**: Available funds now automatically included in cacheFunds before rotation
  - Newly deposited funds immediately available for grid sizing
  - Grid resizes when deposits arrive, not just after fills
  - More responsive to market changes and new capital inflows

- **Unified Fund Management**: Complete consolidation of pendingProceeds into cacheFunds
  - Simplified fund tracking: single cacheFunds field for all unallocated funds
  - Cleaner codebase (272 line reduction in complexity)
  - Backward compatible: legacy pendingProceeds automatically migrated

### Changed
- **BREAKING CHANGE**: `pendingProceeds` field removed from storage schema
  - Affects: `profiles/orders/<bot-name>.json` files for existing bots
  - Migration: Use `scripts/migrate_pending_proceeds.js` before first startup with v0.4.0
  - Backward compat: Legacy pendingProceeds merged into cacheFunds on load

- **Fund Formula Updated**:
  ```
  OLD: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
  NEW: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed)
  ```

- **Grid Regeneration Threshold**: Now includes available funds
  - OLD: Checked only `cacheFunds / gridAllocation`
  - NEW: Checks `(cacheFunds + availableFunds) / gridAllocation`
  - Result: Grid resizes when deposits arrive, enabling fund cycling

- **Fee Deduction**: Now deducts BTS fees from cacheFunds instead of pendingProceeds
  - Called once per rotation cycle after all proceeds added
  - Cleaner integration with fund cycling

### Fixed
- **Partial Order Precision**: Fixed floating-point noise in partial fill detection
  - Now uses integer-based subtraction (blockchain-safe precision)
  - Converts orders to blockchain units, subtracts, converts back
  - Prevents false PARTIAL states from float arithmetic errors (e.g., 1e-18 floats)

- **Logger Undefined Variables**: Fixed references to removed pendingProceeds variables
  - Removed orphaned variable definitions
  - Cleaned up fund display logic in logFundsStatus()

- **Bot Metadata Initialization**: Fixed new order files being created with null metadata
  - Ensured `ensureBotEntries()` is called before any Grid initialization
  - Prevents order files from having null values for name, assetA, assetB
  - Metadata properly initialized from bot configuration in profiles/bots.json at startup
  - Applied fix to both bot.js and dexbot.js DEXBot classes

### Migration Guide
1. **Backup** your `profiles/orders/` directory before updating
2. **Run migration** (if you have existing bots with pendingProceeds):
   ```bash
   node scripts/migrate_pending_proceeds.js
   ```
3. **Restart bots**: Legacy data automatically merged into cacheFunds on load
   - No data loss - all proceeds preserved
   - Grid sizing adjusted automatically

### Technical Details
- **Fund Consolidation**: All proceeds and surpluses now consolidated in single cacheFunds field
- **Backward Compatibility**: Automatic merge of legacy pendingProceeds into cacheFunds during grid load
- **Storage**: Updated account_orders.js schema, removed pendingProceeds persistence methods
- **Test Coverage**: Added test_fund_cycling_trigger.js, test_crossed_rotation.js, test_fee_refinement.js

---

## [0.3.0] - 2025-12-19 - Grid Divergence Detection & Percentage-Based Thresholds

### Features
- **Grid Divergence Detection System**: Intelligent grid state monitoring and automatic regeneration
  - Quadratic error metric calculates divergence between in-memory and persisted grids: Σ((calculated - persisted) / persisted)² / count
  - Automatic grid size recalculation when divergence exceeds DIVERGENCE_THRESHOLD_PERCENTAGE (default: 1%)
  - Detects when cached fund reserves exceed configured percentage threshold (default: 3%)
  - Two independent triggering mechanisms ensure grid stays synchronized with actual blockchain orders

- **Percentage-Based Threshold System**: Standardized threshold configuration across the system
  - Replaced promille-based thresholds (0-1000 scale) with percentage-based (0-100 scale)
  - More intuitive configuration and easier to understand threshold values
  - DIVERGENCE_THRESHOLD_PERCENTAGE: Controls grid divergence detection sensitivity
  - GRID_REGENERATION_PERCENTAGE: Controls when cached funds trigger grid recalculation (default: 3%)

- **Enhanced Documentation**: Comprehensive threshold documentation with distribution analysis
  - Added Root Mean Square (RMS) explanation and threshold reference tables
  - Distribution analysis showing how threshold requirements change with error distribution patterns
  - Clear explanation of how same average error (e.g., 3.2%) requires different thresholds based on distribution
  - Migration guide for percentage-based thresholds
  - Mathematical formulas for threshold calculation and grid regeneration logic

### Changed
- **Breaking Change**: DIVERGENCE_THRESHOLD_Promille renamed to DIVERGENCE_THRESHOLD_PERCENTAGE
  - Configuration files using old name must be updated
  - Old: promille values (10 promille ≈ 1% divergence)
  - New: percentage values (1 = 1% divergence threshold)
  - Update pattern: divide old promille value by 10 to get new percentage value

- **Default Threshold Changes**: Improved defaults based on real-world testing
  - GRID_REGENERATION_PERCENTAGE: 1% → 3% (more stable, reduces unnecessary regeneration)
  - DIVERGENCE_THRESHOLD_PERCENTAGE: 10 promille → 1% (more sensitive divergence detection)

- **Grid Comparison Metrics**: Enhanced logging and comparison output
  - All threshold comparisons now use percentage-based values
  - Log output displays percentage divergence instead of promille
  - Clearer threshold comparison messages in grid update logging

### Fixed
- **Threshold Comparison Logic**: Corrected grid comparison triggering mechanism
  - Changed division from /1000 (promille) to /100 (percentage) in threshold calculations
  - Applied fixes to both BUY and SELL side grid regeneration logic (grid.js lines 1038-1040, 1063-1065)
  - Ensures accurate divergence detection and grid synchronization

### Technical Details
- **Quadratic Error Metric**: Sum of squared relative differences detects concentrated outliers
  - Formula: Σ((calculated - persisted) / persisted)² / count
  - Penalizes outliers more than simple average, reflects actual grid synchronization issues
  - RMS (Root Mean Square) = √(metric), provides alternative view of error magnitude

- **Distribution Scaling**: Threshold requirements scale with distribution evenness
  - Theoretical relationship: promille ≈ 1 + n (where n = ratio of perfect orders)
  - Example: 10% outlier distribution (n=9) requires ~10× higher threshold than 100% even distribution
  - Reference table in README documents thresholds for 1%→10% average errors across distributions

- **Grid Regeneration Mechanics**: Independent triggering mechanisms
  - Mechanism 1: Cache funds accumulating to GRID_REGENERATION_PERCENTAGE (3%) triggers recalculation
  - Mechanism 2: Grid divergence exceeding DIVERGENCE_THRESHOLD_PERCENTAGE (1%) triggers update
  - Both operate independently, ensuring grid stays synchronized with actual blockchain state

### Migration Guide
If upgrading from v0.2.0:
1. Update configuration files to use DIVERGENCE_THRESHOLD_PERCENTAGE instead of DIVERGENCE_THRESHOLD_Promille
2. Convert threshold values: new_value = old_promille_value / 10
   - Old: 10 promille → New: 1%
   - Old: 100 promille → New: 10%
3. Test with dryRun: true to verify threshold behavior matches expectations
4. Default GRID_REGENERATION_PERCENTAGE (3%) is now more conservative; adjust if needed

### Testing
- Comprehensive test coverage for grid divergence detection (test_grid_comparison.js)
- Validates quadratic error metric calculations across various distribution patterns
- Tests both cache funds and divergence triggers independently and in combination
- Percentage-based threshold comparisons verified across BUY and SELL sides

## [0.2.0] - 2025-12-12 - Startup Grid Reconciliation & Fee Caching System

### Features
- **Startup Grid Reconciliation System**: Intelligent grid recovery at startup
  - Price-based matching to resume persisted grids with existing on-chain orders
  - Smart regeneration decisions based on on-chain order states
  - Count-based reconciliation for order synchronization
  - Unified startup logic in both bot.js and dexbot.js

- **Fee Caching System**: Improved fill processing performance
  - One-time fee data loading to avoid repeated blockchain queries
  - Cache fee deductions throughout the trading session
  - Integrated into fill processing workflows

- **Enhanced Order Manager**: Better fund tracking and grid management
  - Improved chain order synchronization with price+size matching
  - Grid recalculation for full grid resync with better parameters
  - Enhanced logging and debug output for startup troubleshooting

- **Improved Account Handling**: Better restart operations
  - Set account info on manager during restart for balance calculations
  - Support percentage-based botFunds configuration at restart
  - Fetch on-chain balances before grid initialization if needed

### Fixed
- **Limit Order Update Calculation**: Fixed parameter handling in chain_orders.js
  - Corrected receive amount handling for price-change detection
  - Improved delta calculation when price changes toward/away from market
  - Added comprehensive validation for final amounts after delta adjustment

### Testing
- Comprehensive test coverage for new reconciliation logic
- Test startup decision logic with various grid/chain scenarios
- Test TwentyX-specific edge cases and recovery paths

## [0.1.2] - 2025-12-10 - Multi-Bot Fund Allocation & Update Script

### Features
- **Multi-Bot Fund Allocation**: Enforce botFunds percentage allocation when multiple bots share an account
  - Each bot respects its allocated percentage of chainFree (what's free on-chain)
  - Bot1 with 90% gets 90% of chainFree, Bot2 with 10% gets 10% of remaining
  - Prevents fund allocation conflicts in shared accounts
  - Applied at grid initialization for accurate startup sizing

### Fixed
- **Update Script**: Removed interactive merge prompts by using `git pull --rebase`
- **Script Permissions**: Made update.sh permanently executable via git config

## [0.1.1] - 2025-12-10 - Minimum Delta Enforcement

### Features
- **Minimum Delta Enforcement**: Enforce meaningful blockchain updates for price-only order moves
  - When price changes but amount delta is zero, automatically set delta to ±1
  - Only applies when order moves toward market center (economically beneficial)
  - Prevents wasted on-chain transactions for imperceptible price changes
  - Maintains grid integrity by pushing orders toward spread

### Fixed
- Eliminated zero-delta price-only updates that had no economic effect
- Improved order update efficiency for partial order price adjustments

## [0.1.0] - 2025-12-10 - Initial Release

### Features
- **Staggered Order Grid**: Geometric order grids with configurable weight distribution
- **Dynamic Rebalancing**: Automatic order updates after fills
- **Multi-Bot Support**: Run multiple bots simultaneously on different pairs
- **PM2 Process Management**: Production-ready process orchestration with auto-restart
- **Partial Order Handling**: Atomic moves for partially-filled orders
- **Fill Deduplication**: 5-second deduplication window prevents duplicate processing
- **Master Password Security**: Encrypted key storage with RAM-only password handling
- **Price Tolerance**: Intelligent blockchain rounding compensation
- **API Resilience**: Multi-API support with graceful fallbacks
- **Dry-Run Mode**: Safe simulation before live trading

### Fixed
- **Fill Processing in PM2 Mode**: Implemented complete 4-step fill processing pipeline for PM2-managed bots
  - Fill validation and deduplication
  - Grid synchronization with blockchain
  - Batch rebalancing and order updates
  - Proper order rotation with atomic transactions
- **Fund Fallback in Order Rotation**: Added fallback to available funds when proceeds exhausted
- **Price Derivation Robustness**: Enhanced pool price lookup with multiple API variant support


### Installation & Usage
See README.md for detailed installation and usage instructions.

### Documentation
- README.md: Complete feature overview and configuration guide
- modules/: Comprehensive module documentation
- examples/bots.json: Configuration templates
- tests/: 25+ test files covering all major functionality

### Notes
- First production-ready release for BitShares DEX market making
- Always test with `dryRun: true` before enabling live trading
- Secure your keys; do not commit private keys to version control
- Use `profiles/` directory for live configuration (not tracked by git)

