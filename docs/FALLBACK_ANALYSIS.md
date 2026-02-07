# DEXBot2 Fallback Analysis

## Complete Fallback Categorization by Theme

### Summary
Found **37+ distinct instances** of "fallback" across the codebase, organized into 7 categories with file paths, line numbers, and context.

⚠️ **Recent Updates**:
- Numeric format precision fallback has been completely removed. Precision is now strictly validated at startup.
- Price fallback system has been removed. All price modes (`pool`, `market`, `auto`) now use strict semantics with no cross-fallback.
- Orphan order lax tolerance fallback has been removed. Orphaned chain orders that don't strictly match grid orders are no longer recovered.

---

## 1. FUND ACCOUNTING & BUDGET FALLBACK

### 1.1 Dust Resize Fallback (Cache Funds)
**Category**: When standard available funds are exhausted, use fill-proceeds cache for correcting small orders.

| File | Line | Context |
|------|------|---------|
| `modules/order/strategy.js` | 533-541 | `// Dust resize fallback budget: use cacheFunds (fill proceeds earmarked for grid ops) when normal available funds (after virtual deductions) are insufficient. cacheFunds is not yet consumed during rebalance (deducted after at lines 366-372), so it's safely available here for correcting existing on-chain dust orders.` |
| `modules/order/strategy.js` | 572-580 | `// Dust resize fallback: when normal available funds (after virtual deductions) are insufficient, use chain free balance for on-chain orders. This corrects an existing order — not new capital deployment. if (finalSize < minAbsoluteSize && hasOnChainId(partial) && dustResizeBudget > 0)` |

**Behavior**: When resizing partial orders and available funds are low, fallback to `cacheFunds` (earmarked fill proceeds) instead of failing the resize operation.

---

### 1.2 Fund Denominator Fallback
**Category**: When allocated funds unavailable, fallback to total on-chain balance for percentage calculations.

| File | Line | Context |
|------|------|---------|
| `modules/order/grid.js` | 776-781 | `// Denominator: bot's total funds for this side (respects botFunds % allocation). Primary: allocated (botFunds-adjusted). Fallback: chainTotal (free + locked). Previous fallback (grid + pending) caused false-positive triggers when the grid allocation was small relative to total funds. const denominator = (allocated > 0) ? allocated : chainTotal;` |

**Behavior**: When calculating fund utilization ratios, prefer `allocated` (configured %), but fallback to `chainTotal` (on-chain balance) if allocated is 0.

---

## 2. ORDER ROTATION & PLACEMENT FALLBACK

### 2.1 Rotation to Creation Conversion
**Category**: When order rotation fails (order not found on-chain), convert unmet rotations to new placements.

| File | Line | Context |
|------|------|---------|
| `modules/dexbot_class.js` | 1568-1580 | `// Convert unmet rotations to placements so we still fill the grid gaps. if (unmetRotations.length > 0) { ... const fallbackPlacements = unmetRotations.map(r => ({ id: r.newGridId, price: r.newPrice, size: r.newSize, type: r.type, state: ORDER_STATES.VIRTUAL })); await this._buildCreateOps(fallbackPlacements, assetA, assetB, operations, opContexts);` |
| `modules/dexbot_class.js` | 1860-1867 | `Tracks unmet rotations (orders missing on-chain) for fallback to creation. @returns {Array} Unmet rotations (fallback to placements)` |
| `modules/dexbot_class.js` | 1902 | `this.manager.logger.log(\`Rotation fallback to creation: Order ${oldOrder.orderId} not found (assuming filled or cancelled)\`, 'warn');` |

**Behavior**: If an order rotation fails because the order doesn't exist on-chain (likely filled/cancelled), convert the rotation spec into a new placement order with VIRTUAL state.

---

## 3. ASSET METADATA FALLBACK

### 3.1 Persisted Asset Fallback (Blockchain Lookup)
**Category**: When live blockchain lookup fails, fallback to persisted asset metadata from last successful load.

| File | Line | Context |
|------|------|---------|
| `modules/order/sync_engine.js` | 1020-1035 | `const fetchAssetWithFallback = async (symbol, side) => { try { return await lookupAsset(BitShares, symbol); } catch (err) { if (mgr.accountOrders) { const persistedAssets = mgr.accountOrders.loadPersistedAssets(mgr.config.botKey); const assetData = (side === 'A') ? persistedAssets?.assetA : persistedAssets?.assetB; if (assetData && assetData.symbol === symbol && typeof assetData.precision === 'number') { mgr.logger.log(\`Blockchain lookup failed for ${symbol}: ${err.message}. Using persisted fallback: id=${assetData.id}, precision=${assetData.precision}\`, 'warn'); return assetData;` |

**Behavior**: If blockchain API fails to lookup asset metadata (id, precision), fallback to persisted data from previous successful loads stored in grid state.

---

## 4. ACCOUNT & CONFIGURATION FALLBACK

### 4.1 Account Selection Fallback
**Category**: When preferred account setup fails, fallback to interactive account selection.

| File | Line | Context |
|------|------|---------|
| `modules/dexbot_class.js` | 1266 | `// dexbot.js has fallback to selectAccount, bot.js throws` |
| `modules/dexbot_class.js` | 1264-1274 | `catch (err) { this._warn(\`Auto-selection of preferredAccount failed: ${err.message}\`); if (typeof chainOrders.selectAccount === 'function') { const accountData = await chainOrders.selectAccount(); this.privateKey = accountData.privateKey; await this._setupAccountContext(accountData.accountName); } else { throw err;` |

**Behavior**: If auto-selecting a configured preferred account fails, fallback to `selectAccount()` (interactive) if available.

---

### 4.2 Bot Configuration Name Fallback
**Category**: When finding updated bot config, fallback to index if name changed.

| File | Line | Context |
|------|------|---------|
| `modules/dexbot_class.js` | 2066 | `// Find this bot by name or fallback to index if name changed?` |

**Behavior**: Comment indicating potential fallback strategy if bot name is changed during runtime config refresh.

---

## 5. GENERAL SETTINGS & FILE I/O FALLBACK

### 5.1 Settings File Fallback
**Category**: When settings file unavailable or unparseable, fallback to provided default value.

| File | Line | Context |
|------|------|---------|
| `modules/general_settings.js` | 7-16 | `function readGeneralSettings({ fallback = null, onError = null } = {}) { if (!fs.existsSync(SETTINGS_FILE)) return fallback; try { const raw = fs.readFileSync(SETTINGS_FILE, 'utf8'); if (!raw || !raw.trim()) return fallback; return JSON.parse(raw); } catch (err) { if (typeof onError === 'function') onError(err, SETTINGS_FILE); return fallback;` |

**Behavior**: Load settings file; if file missing, empty, or invalid JSON, return `fallback` parameter (default `null`).

---

### 5.2 Module Settings Fallback
**Category**: When settings unavailable, use hardcoded defaults throughout modules.

| File | Line | Context |
|------|------|---------|
| `modules/constants.js` | 486-487 | `fallback: null,` (in readGeneralSettings call) |
| `modules/account_bots.js` | 123-124 | `const settings = readGeneralSettings({ fallback: null, onError: (err) => { console.error('Failed to load general settings:', err.message); } });` |
| `modules/bitshares_client.js` | 60-65 | `const settings = readGeneralSettings({ fallback: null, onError: (err) => { console.warn('[NodeManager] Config load failed, continuing with defaults:', err.message); } });` |

**Behavior**: All module initialization uses `readGeneralSettings()` with `fallback: null`; if settings unavailable, modules continue with hardcoded defaults (e.g., default node URL).

---

## 6. TEST & UTILITY FALLBACK

### 6.1 Account Reference Fallback
**Category**: Test utility for resolving account references with explicit fallback.

| File | Line | Context |
|------|------|---------|
| `tests/test_utils.js` | 28 | `utils.resolveAccountRef({ accountId: '1.2.345', account: 'fallback-account' }, 'explicit-account'),` |

**Behavior**: Test verifying that account resolution prefers `accountId` but falls back to `account` field.

---

### 6.2 Fee Cache Fallback in Accounting
**Category**: When fee cache lookup fails, fallback to raw proceeds without fee adjustments.

| File | Line | Context |
|------|------|---------|
| `tests/test_accounting_logic.js` | 195-196 | `// Test: Missing fee cache must not crash fill accounting (fallback to raw proceeds) console.log(' - Testing fill accounting fee-cache fallback...');` |

**Behavior**: If fee cache is unavailable during order fill accounting, fallback to using raw fill proceeds without fee deductions.

---

### 6.3 Node Failover Fallback
**Category**: Multi-node configuration with automatic failover behavior.

| File | Line | Context |
|------|------|---------|
| `tests/test_node_failover.js` | 8 | `- Default fallback behavior` |
| `tests/test_node_failover.js` | 153 | `console.log('✓ Slow node fallback test passed\n');` |

**Behavior**: NodeManager automatically fails over to next configured node if current node is slow or unresponsive.

---

## 7. DOCUMENTATION REFERENCES

### 7.1 Architecture & Developer Docs
| File | Line | Context |
|------|------|---------|
| `docs/developer_guide.md` | 355 | `const fallbackPlacements = unmetRotations.map(r => ({` |
| `docs/developer_guide.md` | 1192 | `// Smart fallback: Cache miss triggers fresh scan` |
| `docs/architecture.md` | 804 | `- Maintains "State Recovery Sync" fallback` |

---

### 7.2 Format Module Documentation
| File | Line | Context |
|------|------|---------|
| `modules/order/format.js` | 44-45 | `15. toFiniteNumber(value, defaultValue) - Convert to finite number with fallback 16. safeFormat(value, decimals, fallback) - Safely format with fallback` |
| `modules/order/format.js` | 247-257 | `@param {string} [fallback='N/A'] - Fallback value if format fails @returns {string} Formatted value or fallback string function safeFormat(value, decimals, fallback = 'N/A') { ... return fallback;` |

---

## CHANGELOG REFERENCES (Recent Updates)

| Line | Context | Category |
|------|---------|----------|
| 18 | "fallback when `accountant.resetRecoveryState()` is unavailable" | Account Fallback |
| 86 | "Added fail-safe fallback in `_deductFeesFromProceeds()` when fee cache lookup fails" | Fee Cache Fallback |
| 132 | "trigger behavior is driven by available funds (`buyFree/sellFree`), not unused cache fallback plumbing" | Fund Accounting |
| 139 | "Extracted common account reference fallback logic" | Account Selection |
| 183 | "use `allocated` funds with `chainTotal` fallback (free + locked balance)" | Fund Denominator |
| 193 | "Dust resize operations used `chainFree` (raw on-chain balance) as fallback" | Dust Resize |
| 195 | "Replaced `chainFree` fallback with `cacheFunds`" | Fund Fallback |
| 346 | "Added fallback for MAX_ORDER_FACTOR in _getMaxOrderSize() with \|\| 1.1 fallback" | Grid Calculation |
| 364 | "Activate SPREAD slots at the edge (fallback if no partials available)" | Slot Selection |
| 382 | "Safety fallback for currency symbols: uses \"BASE\"/\"QUOTE\" if null" | Symbol Fallback |

| 1132 | "fallback fee (100), **maker refund ratio (10%)**" | Fee Parameters |
| 1137 | "Asset precision fallback removed - bot now enforces strict precision requirements" | Precision Strictness |
| 1228 | "Remove precision fallback defaults - halt bot if precision unavailable" | Critical Precision |
| 1229+ | "Remove inline `\|\| 8` precision fallbacks from formatting code - enforce strict precision at startup" | Critical Precision Cleanup |
| 1953 | "Added 100 BTS fallback for adequate fee reservation" | Fee Reservation |
| 2281 | "Multi-API support with graceful fallbacks" | API Resilience |
| 2290 | "Fund Fallback in Order Rotation: Added fallback to available funds when proceeds exhausted" | Rotation Fund Fallback |

---

## SUMMARY STATISTICS

**Total Instances**: 37+ (reduced from 38+ after orphan lax tolerance removal)
**Categories**: 7 primary categories (price/precision/orphan-lax fallbacks removed)
**Files Affected**: 15 source files

### Fallback Distribution by Type:
1. **Fund Management** - 8 instances (Budget, denominator, dust resize, cache, proceeds)
2. **Asset Metadata** - 3 instances (Blockchain lookup, persisted state)
3. **Account/Config** - 4 instances (Account selection, bot name, settings)
4. **Order Operations** - 4 instances (Rotation conversion, slot selection)
5. **File I/O** - 3 instances (Settings loading, parsing)
6. **Testing/Utilities** - 6 instances (Account ref, fee cache, node failover)
7. **Documentation** - 6 instances (Architecture, developer guide references)

---

## Key Patterns

### Resilience Strategy
Fallbacks are implemented at multiple layers:
- **I/O Layer**: File reads with defaults
- **Blockchain Layer**: Persisted assets, node failover
- **Financial Layer**: Fund sources, fee cache alternatives
- **Configuration Layer**: Auto → interactive account selection

**Price Derivation**: No fallback system. Each mode (`pool`, `market`, `auto`) uses strict semantics with explicit failures instead of silent fallbacks.

### Naming Convention
Most fallbacks follow consistent patterns:
- `fallback` parameter in function signatures
- `fetchAssetWithFallback()` - explicit naming
- `[fallback-<type>]` in logs
- Comments documenting fallback triggers

### Logging
All significant fallbacks are logged at WARN level with context:
```
[WARN] Blockchain lookup failed for SYMBOL: timeout. Using persisted fallback...
[WARN] Auto-selection of preferredAccount failed. Falling back to interactive selection...
```

This enables operators to monitor when fallback mechanisms are engaged and investigate underlying issues.
