# Changelog

All notable changes to this project will be documented in this file.

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

