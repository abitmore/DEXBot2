Tests in this folder are intended to be non-sensitive and safe to run in CI. They include:

- `test_key_validation.js` - key format validation unit tests
- `test_privatekey_sanitize.js` - sanitization checks for pasted private keys

## Market Price Derivation Tests

- `test_market_price.js` - Complete test of market price fetching from BitShares API
  - Tests pool price derivation (liquidity pool reserves)
  - Tests market price from order book (bid/ask spread)
  - Tests auto-fallback chain (pool → market → limit orders)
  - Shows detailed order book analysis with bid/ask prices and spread
  - Run: `node tests/test_market_price.js`

- `test_debug_orderbook.js` - Diagnostic tool for debugging order book fetch issues
  - Tests order book in both directions
  - Tests ticker data
  - Tests limit orders
  - Run: `node tests/test_debug_orderbook.js`

- `test_any_pair.js` - Tests multiple active trading pairs
  - Discovers which pairs have active trading
  - Shows order book and ticker data for multiple pairs
  - Run: `node tests/test_any_pair.js`

## Interactive Tests

Interactive tests (e.g., `test_account_selection.js`, `test_fills.js`, `connection_test.js`) may require
runtime credentials and network connectivity and are therefore interactive by design. They should not contain
 profiles secrets in the repository. Keep any sensitive test data in `profiles/` (which is git-ignored).

The project keeps safe example configs under `examples/` (e.g. `examples/keys.json`). For runtime testing, create
`profiles/keys.json` with your real encrypted data; `modules/chain_keys.js` and `modules/chain_orders.js`
prefer the profiles file if present.

You can quickly bootstrap a local `profiles/` from the tracked `examples/` files with:

```bash
npm run bootstrap:profiles
```
