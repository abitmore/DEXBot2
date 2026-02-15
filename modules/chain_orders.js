/**
 * modules/chain_orders.js - Blockchain Interaction Layer
 *
 * BitShares blockchain operations and order management interface.
 * Provides all blockchain I/O operations for the bot.
 *
 * Responsibilities:
 * - Account selection and management
 * - Reading open orders from blockchain
 * - Creating, updating, and canceling limit orders
 * - Listening for fill events via subscriptions
 * - Fetching on-chain asset balances and metadata
 * - Batch operation execution
 * - Fill deduplication and processing mode selection
 *
 * All order amounts are human-readable floats externally,
 * converted to blockchain integers internally using asset precision.
 *
 * ===============================================================================
 * EXPORTS (15 functions)
 * ===============================================================================
 *
 * ACCOUNT MANAGEMENT (2 functions - async)
 *   1. selectAccount(nameOrId) - Select/authenticate account by name or ID
 *      Prompts for password if needed, caches selection
 *      Returns { accountId, accountName, authority }
 *
 *   2. setPreferredAccount(nameOrId) - Set preferred default account
 *      Used by selectAccount() if no account specified
 *
 * ORDER OPERATIONS (5 functions - async)
 *   3. readOpenOrders(accountId) - Read all open orders for account
 *      Returns array of { id, seller, sells, receives, ...blockchain fields }
 *
 *   4. createOrder(accountId, orderParams, broadcastFn) - Create limit order
 *      orderParams: { sellSymbol, sellAmount, buySymbol, buyAmount, fillOrKill, ... }
 *      Returns { tx_id, operation_results } or throws
 *
 *   5. updateOrder(accountId, orderId, newAmount, broadcastFn) - Update existing order
 *      Changes order amount, preserves price
 *      Returns transaction result
 *
 *   6. cancelOrder(accountId, orderId, broadcastFn) - Cancel order
 *      Removes order from blockchain
 *      Returns transaction result
 *
 *   7. executeBatch(operations, broadcastFn) - Execute batch of operations
 *      Executes multiple operations (create/update/cancel) in one transaction
 *      Returns transaction result
 *
 * FILL EVENT HANDLING (1 function - async)
 *   8. listenForFills(accountId, fillCallback) - Subscribe to fill events
 *      Invokes fillCallback({ id, orderId, side, amount, price, proceeds, ... })
 *      Returns unsubscribe function
 *
 * ACCOUNT STATE (1 function - async)
 *   9. getOnChainAssetBalances(accountId) - Fetch account asset balances
 *      Returns { BTS: amount, USD: amount, ... } (human-readable floats)
 *
 * OPERATION BUILDERS (3 functions)
 *   10. buildCreateOrderOp(accountId, orderParams) - Build create order operation
 *   11. buildUpdateOrderOp(accountId, orderId, newAmount) - Build update order operation
 *   12. buildCancelOrderOp(accountId, orderId) - Build cancel order operation
 *
 * CONFIGURATION (2 functions/constants)
 *   13. getFillProcessingMode() - Get current fill processing mode
 *       Returns 'history' (use fill event data) or 'open' (fetch open orders)
 *
 *   14. FILL_PROCESSING_MODE - Constant: current fill processing mode
 *
 * ===============================================================================
 *
 * ACCOUNT RESOLUTION:
 * - Caches account name ↔ ID mappings to avoid repeated blockchain queries
 * - Shared with modules/chain_keys.js for authentication
 *
 * FILL MODES:
 * - 'history' mode: Use fill event data directly (faster, preferred)
 * - 'open' mode: Fetch open orders from blockchain (backup method, more API calls)
 *
 * RACE CONDITION PREVENTION:
 * - _subscriptionLock: Serializes subscription map access
 * - _preferredAccountLock: Serializes preferred account access
 * - _resolutionLock: Serializes account resolution calls
 *
 * AUTHENTICATION:
 * Moved to modules/chain_keys.js for centralized key management.
 * Use chain_keys.authenticate() and getPrivateKey() for auth operations.
 *
 * ===============================================================================
 */

const { BitShares, createAccountClient, waitForConnected } = require('./bitshares_client');
const { floatToBlockchainInt, blockchainToFloat, normalizeInt, validateOrderAmountsWithinLimits } = require('./order/utils/math');
const { FILL_PROCESSING, TIMING } = require('./constants');
const AsyncLock = require('./order/async_lock');
const { readInput } = require('./order/utils/system');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const chainKeys = require('./chain_keys');

// Key/auth helpers provided by modules/chain_keys.js
// (authenticate(), getPrivateKey(), MasterPasswordError)

/**
 * Fill processing mode from FILL_PROCESSING.MODE constant:
 * - 'history': Use fill event data directly to match order_id with account_orders (preferred, faster)
 * - 'open': Fetch open orders from blockchain and sync (backup method, more API calls)
 */
const FILL_PROCESSING_MODE = FILL_PROCESSING.MODE;

// AsyncLock instances for preventing race conditions
// _subscriptionLock: Serializes access to accountSubscriptions map
// _preferredAccountLock: Serializes access to preferredAccount global state
// _resolutionLock: Serializes account resolution calls and caching
const _subscriptionLock = new AsyncLock();
const _preferredAccountLock = new AsyncLock();
const _resolutionLock = new AsyncLock();

// Cache for account resolutions (name -> id and id -> name)
const _accountResolutionCache = new Map();

/**
 * Resolve asset precision from ID or symbol via BitShares DB.
 * @param {string} assetRef - Asset ID or symbol.
 * @returns {Promise<number>} The asset's precision (number of decimals), or 0 on failure.
 * @private
 */
async function _getAssetPrecision(assetRef) {
    if (!assetRef) throw new Error("Asset reference required for _getAssetPrecision");
    try {
        if (typeof assetRef === 'string' && assetRef.match(/^1\.3\.\d+$/)) {
            if (BitShares && BitShares.db && typeof BitShares.db.get_assets === 'function') {
                const assets = await BitShares.db.get_assets([assetRef]);
                if (Array.isArray(assets) && assets[0] && typeof assets[0].precision === 'number') return assets[0].precision;
            }
        } else if (typeof assetRef === 'string') {
            if (BitShares && BitShares.db && typeof BitShares.db.lookup_asset_symbols === 'function') {
                const res = await BitShares.db.lookup_asset_symbols([assetRef]);
                if (Array.isArray(res) && res[0] && typeof res[0].precision === 'number') return res[0].precision;
            }
        }
    } catch (e) { 
        console.error(`[_getAssetPrecision] Failed to resolve precision for ${assetRef}: ${e.message}`);
    }
    
    throw new Error(`CRITICAL: Could not resolve precision for asset ${assetRef}. Halting operation to prevent scaling errors.`);
}

// Preferred account ID and name for operations (can be changed)
// Access MUST be protected by _preferredAccountLock to prevent race conditions
let preferredAccountId = null;
let preferredAccountName = null;

/**
 * Set the preferred account for subsequent operations.
 * This allows other functions to operate without requiring account parameters.
 * Uses AsyncLock to prevent race conditions when multiple functions access this simultaneously.
 * @param {string} accountId - BitShares account ID (e.g., '1.2.12345')
 * @param {string} accountName - Human-readable account name
 */
async function setPreferredAccount(accountId, accountName) {
    await _preferredAccountLock.acquire(async () => {
        preferredAccountId = accountId;
        if (accountName) preferredAccountName = accountName;
    });
}

/**
 * Get the current preferred account (thread-safe).
 * @returns {Promise<{id: string|null, name: string|null}>}
 */
async function getPreferredAccount() {
    return await _preferredAccountLock.acquire(async () => {
        return { id: preferredAccountId, name: preferredAccountName };
    });
}

/**
 * Resolve an account ID to its human-readable name via chain lookup.
 * Results are cached to prevent repeated lookups (fixes Issue #4).
 * @param {string} accountRef - Account ID (e.g., '1.2.12345') or name
 * @returns {Promise<string|null>} Account name or null if not found
 */
async function resolveAccountName(accountRef) {
    if (!accountRef) return null;
    if (typeof accountRef !== 'string') return null;
    if (!/^1\.2\./.test(accountRef)) return accountRef;

    return await _resolutionLock.acquire(async () => {
        // Check cache first
        const cacheKey = `id->${accountRef}`;
        if (_accountResolutionCache.has(cacheKey)) {
            return _accountResolutionCache.get(cacheKey);
        }

        try {
            await waitForConnected();
            const full = await BitShares.db.get_full_accounts([accountRef], false);
            if (full && full[0] && full[0][1] && full[0][1].account && full[0][1].account.name) {
                const name = full[0][1].account.name;
                _accountResolutionCache.set(cacheKey, name);
                // Also cache reverse mapping
                _accountResolutionCache.set(`name->${name}`, accountRef);
                return name;
            }
        } catch (err) {
            // ignore resolution failures
        }
        _accountResolutionCache.set(cacheKey, null);
        return null;
    });
}

/**
 * Resolve an account name to its ID via chain lookup.
 * Results are cached to prevent repeated lookups (fixes Issue #4).
 * @param {string} accountName - Human-readable account name
 * @returns {Promise<string|null>} Account ID or null if not found
 */
async function resolveAccountId(accountName) {
    if (!accountName) return null;
    if (typeof accountName !== 'string') return null;
    // If already in ID format, return as-is
    if (/^1\.2\.\d+$/.test(accountName)) return accountName;

    return await _resolutionLock.acquire(async () => {
        // Check cache first
        const cacheKey = `name->${accountName}`;
        if (_accountResolutionCache.has(cacheKey)) {
            return _accountResolutionCache.get(cacheKey);
        }

        try {
            await waitForConnected();
            const full = await BitShares.db.get_full_accounts([accountName], false);
            // full[0][0] is the account name (key), full[0][1] contains account data
            if (full && full[0] && full[0][1] && full[0][1].account && full[0][1].account.id) {
                const id = full[0][1].account.id;
                _accountResolutionCache.set(cacheKey, id);
                // Also cache reverse mapping
                _accountResolutionCache.set(`id->${id}`, accountName);
                return id;
            }
        } catch (err) {
            // ignore resolution failures
        }
        _accountResolutionCache.set(cacheKey, null);
        return null;
    });
}

// Track active account subscriptions so we avoid duplicate listeners per account
// Map accountName -> { userCallbacks: Set<Function>, bsCallback: Function }
// Access MUST be protected by _subscriptionLock to prevent TOCTOU races (fixes Issue #1)
const accountSubscriptions = new Map();

/**
 * Ensure a per-account BitShares subscription exists so we only subscribe once.
 * @param {string} accountName - The name of the account to subscribe to.
 * @returns {Promise<Object>} The subscription entry { userCallbacks, bsCallback }.
 * @private
 */
async function _ensureAccountSubscriber(accountName) {
    return await _subscriptionLock.acquire(async () => {
        // Check again inside lock to prevent duplicate subscriptions
        if (accountSubscriptions.has(accountName)) {
            return accountSubscriptions.get(accountName);
        }

        const userCallbacks = new Set();

        // BitShares callback that receives raw updates and dispatches to user callbacks
        const bsCallback = (updates) => {
            // Filter for fill-related operations
            const fills = updates.filter(update => {
                const op = update.op;
                return op && op[0] === FILL_PROCESSING.OPERATION_TYPE; // operation type for fill_order
            });

            if (fills.length > 0) {
                // Call each registered user callback with the fills array
                for (const c of Array.from(userCallbacks)) {
                    try { c(fills); } catch (e) { console.error('chain_orders listener error', e.message); }
                }
            }
        };

        try {
            BitShares.subscribe('account', bsCallback, accountName);
        } catch (e) { }

        const entry = { userCallbacks, bsCallback };
        accountSubscriptions.set(accountName, entry);
        return entry;
    });
}

/**
 * Interactive account selection from stored encrypted keys.
 * Prompts user to authenticate and select an account.
 * Uses AsyncLock to prevent race conditions with concurrent listenForFills calls (fixes Issue #2, #5).
 * @returns {Promise<Object>} { accountName, privateKey, id }
 */
async function selectAccount() {
    const masterPassword = await chainKeys.authenticate();
    const accountsData = chainKeys.loadAccounts();
    const accountNames = Object.keys(accountsData.accounts);

    if (accountNames.length === 0) {
        throw new Error('No accounts found. Please add accounts using modules/chain_keys.js');
    }

    console.log('Available accounts:');
    accountNames.forEach((name, index) => {
        console.log(`${index + 1}. ${name}`);
    });

    const choiceStr = await readInput('Select account number: ');
    const choice = parseInt(choiceStr, 10) - 1;
    if (choice < 0 || choice >= accountNames.length) {
        throw new Error('Invalid account selection.');
    }

    const selectedAccount = accountNames[choice];
    const privateKey = chainKeys.getPrivateKey(selectedAccount, masterPassword);

    let selectedId = null;
    try {
        const full = await BitShares.db.get_full_accounts([selectedAccount], false);
        if (full && full[0]) {
            const candidateId = full[0][0];
            if (candidateId && String(candidateId).startsWith('1.2.')) selectedId = candidateId;
            else if (full[0][1] && full[0][1].account && full[0][1].account.id) selectedId = full[0][1].account.id;
        }
    } catch (e) { }

    if (selectedId) {
        await setPreferredAccount(selectedId, selectedAccount);
    }

    const pref = await getPreferredAccount();
    console.log(`Selected account: ${selectedAccount} (ID: ${pref.id})`);
    return { accountName: selectedAccount, privateKey: privateKey, id: pref.id };
}

/**
 * Fetch all open limit orders for an account from the blockchain using pagination.
 * This is more robust than get_full_accounts which can truncate order lists on large accounts.
 * @param {string} accId - Account ID to query
 * @param {number} limit - Batch size per page (default 100)
 * @returns {Promise<Array>} Combined array of all open orders
 * @private
 */
/**
 * Fetch all limit orders in a specific market for an account.
 * This is the most reliable way to find orders when get_full_accounts is truncated.
 * @param {string} accountId - Account ID
 * @param {string} assetAId - First asset ID
 * @param {string} assetBId - Second asset ID
 * @param {number} limit - Depth to fetch (default 300)
 * @returns {Promise<Array>} Filtered orders
 * @private
 */
async function _readMarketOrders(accountId, assetAId, assetBId, limit = 300) {
    try {
        // Fetch both sides of the book
        const [side1, side2] = await Promise.all([
            BitShares.db.get_limit_orders(assetAId, assetBId, limit),
            BitShares.db.get_limit_orders(assetBId, assetAId, limit)
        ]);
        
        const combined = [...(side1 || []), ...(side2 || [])];
        return combined.filter(o => o && o.seller === accountId);
    } catch (err) {
        console.warn(`[chain_orders] Market order fetch failed: ${err.message}`);
        return [];
    }
}

async function _readOpenOrdersPaginated(accId) {
    const fullAccount = await BitShares.db.get_full_accounts([accId], false);
    if (!Array.isArray(fullAccount) || !fullAccount[0] || !fullAccount[0][1]) return [];
    return fullAccount[0][1].limit_orders || [];
}

/**
 * Fetch all open limit orders for an account from the blockchain.
 * Uses AsyncLock to safely access preferredAccountId (fixes Issue #2).
 * Uses account query and optional market deep scan.
 * @param {string|null} accountId - Account ID to query (uses preferred if null)
 * @param {number} timeoutMs - Connection timeout in milliseconds
 * @param {boolean} suppress_log - Whether to suppress the log
 * @param {Object} [marketAssets] - Optional asset IDs {assetAId, assetBId} for deep market scan
 * @returns {Promise<Array>} Array of raw order objects from chain
 */
async function readOpenOrders(accountId = null, timeoutMs = TIMING.CONNECTION_TIMEOUT_MS, suppress_log = true, marketAssets = null) {
    await waitForConnected(timeoutMs);
    try {
        let accId = accountId;
        if (!accId) {
            const pref = await getPreferredAccount();
            accId = pref.id;
        }
        if (!accId) {
            throw new Error('No account selected. Please call selectAccount() first or pass an account id');
        }

        // 1. Get orders from standard (paginated or fallback) account query
        const orders = await _readOpenOrdersPaginated(accId);

        // 2. If market assets provided, perform a deep scan of that specific market
        // This bypasses account-level truncation for the market we actually care about.
        if (marketAssets && marketAssets.assetAId && marketAssets.assetBId) {
            const marketOrders = await _readMarketOrders(accId, marketAssets.assetAId, marketAssets.assetBId);
            
            // Merge results to ensure we have every order found in either source
            const orderMap = new Map();
            orders.forEach(o => orderMap.set(o.id, o));
            marketOrders.forEach(o => {
                if (!orderMap.has(o.id)) {
                    if (!suppress_log) console.log(`[chain_orders] Deep scan found hidden market order: ${o.id}`);
                    orderMap.set(o.id, o);
                }
            });
            
            const finalOrders = Array.from(orderMap.values());
            if (!suppress_log) {
                console.log(`Found ${finalOrders.length} total orders (Account Scan: ${orders.length}, Deep Market Scan: ${marketOrders.length})`);
            }
            return finalOrders;
        }

        if (!suppress_log) {
            console.log(`Found ${orders.length} open orders for account ${accId}`);
        }
        return orders;
    } catch (error) {
        console.error('Error reading open orders:', error.message);
        throw error;
    }
}

/**
 * Subscribe to fill events for an account.
 * Calls the callback when any of the account's orders are filled.
 * Uses AsyncLock to safely access preferredAccount and subscription state (fixes Issue #2, #5).
 *
 * @param {string|Function} accountRef - Account name/id, or callback if using preferred
 * @param {Function} callback - Function called with array of fill operations
 * @returns {Function} Unsubscribe function to stop listening
 */
async function listenForFills(accountRef, callback) {
    let userCallback = null;
    let accountToken = null;
    if (typeof accountRef === 'function' && arguments.length === 1) {
        userCallback = accountRef;
    } else {
        accountToken = accountRef;
        userCallback = callback;
    }

    if (typeof userCallback !== 'function') {
        console.error('listenForFills requires a callback function');
        return () => { };
    }

    // Safely access preferredAccount using getPreferredAccount (fixes Issue #2, #5)
    const pref = await getPreferredAccount();
    let accountName = accountToken || pref.name;
    if (!accountName && pref.id) {
        accountName = await resolveAccountName(pref.id);
    }
    if (!accountName && accountToken) {
        accountName = await resolveAccountName(accountToken);
    }

    if (!accountName) {
        console.error('listenForFills requires an account name or a preferredAccount to be set');
        return () => { };
    }

    let accountId = /^1\.2\./.test(accountToken || '') ? accountToken : pref.id;
    if (!accountId) {
        accountId = await resolveAccountId(accountName);
    }

    if (accountId) {
        readOpenOrders(accountId, 30000, true).catch(error => console.error('Error loading account for listening:', error.message));
    } else {
        console.warn('Unable to derive account id before listening for fills; skipping open-order prefetch.');
    }

    const entry = await _ensureAccountSubscriber(accountName);

    // Add callback inside lock to prevent race with concurrent listenForFills calls
    const listenerCount = await _subscriptionLock.acquire(async () => {
        entry.userCallbacks.add(userCallback);
        return entry.userCallbacks.size;
    });

    console.log(`Listening for fills on account: ${accountName} (total listeners: ${listenerCount})`);

    // Return an unsubscribe function that atomically removes the listener
    return async function unsubscribe() {
        try {
            await _subscriptionLock.acquire(async () => {
                entry.userCallbacks.delete(userCallback);
                if (entry.userCallbacks.size === 0) {
                    try {
                        if (typeof BitShares.unsubscribe === 'function') {
                            BitShares.unsubscribe('account', entry.bsCallback, accountName);
                        }
                    } catch (e) { }
                    accountSubscriptions.delete(accountName);
                }
            });
        } catch (e) {
            console.error('Error unsubscribing listenForFills', e.message);
        }
    };
}

/**
 * Build a limit_order_update operation.
 * @param {string} accountName - The name of the account.
 * @param {string} orderId - The ID of the order to update.
 * @param {Object} newParams - The new parameters for the order.
 * @param {number} [newParams.amountToSell] - New amount to sell.
 * @param {number} [newParams.minToReceive] - New minimum amount to receive.
 * @param {number} [newParams.newPrice] - New price.
 * @param {string} [newParams.orderType] - Type of the order ('buy' or 'sell').
 * @param {string} [newParams.expiration] - New expiration date.
 * @param {Object} [cachedOrder=null] - Optional already-fetched raw chain order.
 * @returns {Promise<Object|null>} Operation object or null if no change.
 * @throws {Error} If account or order not found, or if amounts exceed limits.
 */
async function buildUpdateOrderOp(accountName, orderId, newParams, cachedOrder = null) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    // Use cached order if provided, otherwise fetch fresh from blockchain
    let order = cachedOrder;
    if (!order) {
        const orders = await readOpenOrders(accId);
        order = orders.find(o => o.id === orderId);
    }
    
    if (!order) throw new Error(`Order ${orderId} not found`);

    const sellAssetId = order.sell_price.base.asset_id;
    const receiveAssetId = order.sell_price.quote.asset_id;
    const sellPrecision = await _getAssetPrecision(sellAssetId);
    const receivePrecision = await _getAssetPrecision(receiveAssetId);

    const currentSellInt = Number(order.for_sale);
    const currentSellFloat = blockchainToFloat(currentSellInt, sellPrecision);

    const priceRatioBase = order.sell_price.base.amount;
    const priceRatioQuote = order.sell_price.quote.amount;
    const currentReceiveInt = Math.round((currentSellInt * priceRatioQuote) / priceRatioBase);
    const currentReceiveFloat = blockchainToFloat(currentReceiveInt, receivePrecision);

    // Determine target sell amount first.
    // IMPORTANT: When amountToSell is undefined, use currentSellInt directly to avoid
    // floating-point precision loss (blockchainToFloat -> floatToBlockchainInt roundtrip).
    let newSellInt;
    let newSellFloat;
    if (newParams.amountToSell !== undefined && newParams.amountToSell !== null) {
        newSellFloat = newParams.amountToSell;
         
         newSellInt = floatToBlockchainInt(newSellFloat, sellPrecision);
    } else {
        // Keep current amount exactly as-is on-chain, bypassing float conversion
        newSellInt = currentSellInt;
        newSellFloat = blockchainToFloat(currentSellInt, sellPrecision);
    }

    // Determine an initial receive amount for price-change detection.
    // Policy:
    // - If minToReceive is provided: use it as an absolute override.
    // - Else if newPrice is provided: compute receive from the (new or current) sell amount.
    // - Else: keep the existing on-chain price by scaling receive with sell.
    let candidateReceiveInt;
    if (newParams.minToReceive !== undefined && newParams.minToReceive !== null) {
        candidateReceiveInt = floatToBlockchainInt(newParams.minToReceive, receivePrecision);
    } else if (newParams.newPrice !== undefined && newParams.newPrice !== null) {
        const price = Number(newParams.newPrice);
        const sellFloat = (newParams.amountToSell !== undefined && newParams.amountToSell !== null) ? newParams.amountToSell : currentSellFloat;
        const receiveFloat = (newParams.orderType === 'sell')
            ? (sellFloat * price)
            : (sellFloat / price);
        candidateReceiveInt = floatToBlockchainInt(receiveFloat, receivePrecision);
    } else {
        candidateReceiveInt = Math.round((newSellInt * priceRatioQuote) / priceRatioBase);
    }

    // Validate amounts before converting to blockchain integers / computing deltas
    const candidateReceiveFloat = blockchainToFloat(candidateReceiveInt, receivePrecision);
    if (!validateOrderAmountsWithinLimits(newSellFloat, candidateReceiveFloat, sellPrecision, receivePrecision)) {
        throw new Error(
            `Cannot update order: calculated amounts exceed blockchain limits. ` +
            `Sell: ${newSellFloat}, Receive: ${candidateReceiveFloat}. ` +
            `This typically happens with extreme price values or mixed absolute/relative price bounds that diverge too far. ` +
            `Consider adjusting minPrice/maxPrice configuration.`
        );
    }

    // Calculate delta (new - current)
    // IMPORTANT: BitShares limit_order_update takes a delta for amount_to_sell
    // But for the new_price, it takes the NEW total amounts.
    let deltaSellInt = newSellInt - currentSellInt;

    // PRECISION FIX: If delta is ±1 and it's due to floating-point precision loss,
    // use the current amount to avoid unnecessary blockchain changes.
    // This happens when newAmountToSell was rounded, causing floatToBlockchainInt
    // to produce a different value than what's currently on-chain.
    if (Math.abs(deltaSellInt) === 1 && newParams.amountToSell !== undefined && newParams.amountToSell !== null) {
        const roundedNewSellInt = normalizeInt(newSellInt, sellPrecision);
        const roundedCurrentSellInt = normalizeInt(currentSellInt, sellPrecision);

        // If they match after rounding to precision, use the current amount (delta = 0)
        if (roundedNewSellInt === roundedCurrentSellInt || Math.abs(roundedNewSellInt - roundedCurrentSellInt) <= 1) {
            newSellInt = currentSellInt;
            deltaSellInt = 0;
        }
    }

    // First, compute the receive amount with the current delta (not adjusted yet)
    let newReceiveInt;

    if (newParams.minToReceive !== undefined && newParams.minToReceive !== null) {
        newReceiveInt = floatToBlockchainInt(newParams.minToReceive, receivePrecision);
    } else if (newParams.newPrice !== undefined && newParams.newPrice !== null) {
        const price = Number(newParams.newPrice);
        const receiveFloat = (newParams.orderType === 'sell')
            ? (newSellFloat * price)
            : (newSellFloat / price);
        newReceiveInt = floatToBlockchainInt(receiveFloat, receivePrecision);
    } else {
        // Keep existing on-chain price ratio.
        newReceiveInt = Math.round((newSellInt * priceRatioQuote) / priceRatioBase);
    }

    // Check if price or amount is actually changing
    const priceChanged = newReceiveInt !== currentReceiveInt;
    const amountChanged = deltaSellInt !== 0;

    // PRECISION FIX for price-only updates: if price change is too small to detect (rounds to same value),
    // adjust minToReceive by 1 unit in the appropriate direction to force the operation.
    // This ensures partial orders are actually moved even when price change is < 1 blockchain unit.
    if (!priceChanged && !amountChanged && newParams.newPrice !== undefined && newParams.newPrice !== null) {
        if (newParams.orderType === 'sell') {
            // SELL moving down = lower price = receive less → decrease by 1
            newReceiveInt = currentReceiveInt - 1;
        } else if (newParams.orderType === 'buy') {
            // BUY moving up = higher price = receive more → increase by 1
            newReceiveInt = currentReceiveInt + 1;
        }
    }

    // Skip update only if BOTH amount and price are unchanged
    if (!amountChanged && newReceiveInt === currentReceiveInt) {
        return null;
    }

    // At this point, at least one field (amount or price) changed.
    // If BOTH are unchanged (which shouldn't happen due to check above),
    // we need to enforce a minimum delta of +1 to ensure operation validity
    if (!amountChanged && !priceChanged) {
        deltaSellInt = 1;
    }

    // Adjust newSellInt to strict logic: current + delta
    const adjustedSellInt = currentSellInt + deltaSellInt;

    // Recompute the final receive amount with the adjusted sell amount
    if (newParams.minToReceive !== undefined && newParams.minToReceive !== null) {
        newReceiveInt = floatToBlockchainInt(newParams.minToReceive, receivePrecision);
    } else if (newParams.newPrice !== undefined && newParams.newPrice !== null) {
        const price = Number(newParams.newPrice);
        const adjustedSellFloat = blockchainToFloat(adjustedSellInt, sellPrecision);
        const receiveFloat = (newParams.orderType === 'sell')
            ? (adjustedSellFloat * price)
            : (adjustedSellFloat / price);
        newReceiveInt = floatToBlockchainInt(receiveFloat, receivePrecision);
    } else {
        // Keep existing on-chain price ratio.
        newReceiveInt = Math.round((adjustedSellInt * priceRatioQuote) / priceRatioBase);
    }

    const adjustedSellFloat = blockchainToFloat(adjustedSellInt, sellPrecision);

    const finalReceiveFloat = blockchainToFloat(newReceiveInt, receivePrecision);
    if (!validateOrderAmountsWithinLimits(adjustedSellFloat, finalReceiveFloat, sellPrecision, receivePrecision)) {
        throw new Error(
            `Cannot update order: calculated amounts exceed blockchain limits. ` +
            `Sell: ${adjustedSellFloat}, Receive: ${finalReceiveFloat}. ` +
            `Consider adjusting minPrice/maxPrice configuration.`
        );
    }

    return {
        op: {
            op_name: 'limit_order_update',
            op_data: {
                fee: { amount: 0, asset_id: '1.3.0' },
                seller: accId,
                order: orderId,
                new_price: {
                    base: {
                        amount: adjustedSellInt,
                        asset_id: sellAssetId
                    },
                    quote: {
                        amount: newReceiveInt,
                        asset_id: receiveAssetId
                    }
                },
                ...(deltaSellInt !== 0 ? { delta_amount_to_sell: { amount: deltaSellInt, asset_id: sellAssetId } } : {}),
                ...(newParams.expiration ? { expiration: newParams.expiration } : {})
            }
        },
        finalInts: { sell: adjustedSellInt, receive: newReceiveInt, sellAssetId, receiveAssetId }
    };
}

/**
 * Update an existing limit order on the blockchain.
 * @param {string} accountName - The name of the account.
 * @param {string} privateKey - The private key for signing.
 * @param {string} orderId - The ID of the order to update.
 * @param {Object} newParams - The new parameters for the order.
 * @returns {Promise<Object|null>} Success object or null if skipped.
 * @throws {Error} If update fails.
 */
async function updateOrder(accountName, privateKey, orderId, newParams) {
    try {
        const buildResult = await buildUpdateOrderOp(accountName, orderId, newParams);
        if (!buildResult) {
            console.log(`Delta is 0; skipping limit_order_update (no change to amount_to_sell)`);
            return null;
        }

        const { op } = buildResult;
        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();

        // Use explicit method call for robustness
        if (typeof tx.limit_order_update === 'function') {
            tx.limit_order_update(op.op_data);
        } else {
            throw new Error(`Transaction builder does not support limit_order_update`);
        }
        await tx.broadcast();

        console.log(`Order ${orderId} updated successfully`);
        return { success: true, orderId };
    } catch (error) {
        console.error('Error updating order:', error.message);
        throw error;
    }
}

/**
 * Build a limit_order_create operation.
 * @param {string} accountName - The name of the account.
 * @param {number} amountToSell - The amount of the asset to sell.
 * @param {string} sellAssetId - The ID of the asset to sell.
 * @param {number} minToReceive - The minimum amount of the asset to receive.
 * @param {string} receiveAssetId - The ID of the asset to receive.
 * @param {string} [expiration] - The expiration date for the order.
 * @returns {Promise<Object>} The operation object.
 * @throws {Error} If account not found.
 */
async function buildCreateOrderOp(accountName, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    if (!expiration) {
        const now = new Date();
        now.setFullYear(now.getFullYear() + 1);
        expiration = now.toISOString().split('T')[0] + 'T23:59:59';
    }

    const sellPrecision = await _getAssetPrecision(sellAssetId);
    const receivePrecision = await _getAssetPrecision(receiveAssetId);
    const amountToSellInt = floatToBlockchainInt(amountToSell, sellPrecision);
    const minToReceiveInt = floatToBlockchainInt(minToReceive, receivePrecision);

    // CRITICAL: Validate order amounts before creating operation
    // This prevents "Assert Exception: min_to_receive.amount > 0" errors from BitShares
    // when order sizes are too small and round to 0 after precision conversion
    // Returns null instead of throwing to allow caller to skip invalid orders gracefully
    if (!validateOrderAmountsWithinLimits(amountToSell, minToReceive, sellPrecision, receivePrecision)) {
        console.warn(
            `[buildCreateOrderOp] Order skipped: amounts would round to 0 on blockchain\n` +
            `  Float values: sell=${amountToSell}, receive=${minToReceive}\n` +
            `  Blockchain integers: sell=${amountToSellInt} (prec ${sellPrecision}), receive=${minToReceiveInt} (prec ${receivePrecision})\n` +
            `  Required: both > 0`
        );
        return null;
    }

    const op = {
        op_name: 'limit_order_create',
        op_data: {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: accId,
            amount_to_sell: { amount: amountToSellInt, asset_id: sellAssetId },
            min_to_receive: { amount: minToReceiveInt, asset_id: receiveAssetId },
            expiration: expiration,
            fill_or_kill: false,
            extensions: []
        }
    };
    return {
        op,
        finalInts: { sell: amountToSellInt, receive: minToReceiveInt, sellAssetId, receiveAssetId }
    };
}

/**
 * Create a new limit order on the blockchain.
 * @param {string} accountName - The name of the account.
 * @param {string} privateKey - The private key for signing.
 * @param {number} amountToSell - The amount of the asset to sell.
 * @param {string} sellAssetId - The ID of the asset to sell.
 * @param {number} minToReceive - The minimum amount of the asset to receive.
 * @param {string} receiveAssetId - The ID of the asset to receive.
 * @param {string} [expiration] - The expiration date for the order.
 * @param {boolean} [dryRun=false] - Whether to simulate the operation.
 * @returns {Promise<Object>} The transaction result or dry run info.
 * @throws {Error} If account not found or creation fails.
 */
async function createOrder(accountName, privateKey, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration, dryRun = false) {
    try {
        const { op } = await buildCreateOrderOp(accountName, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration);

        if (dryRun) {
            console.log(`Dry run: Limit order prepared for account ${accountName} (not broadcasted)`);
            return { dryRun: true, params: op.op_data };
        }

        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();
        // Invoke standard method directly
        tx.limit_order_create(op.op_data);
        const result = await tx.broadcast();
        console.log(`Limit order created successfully for account ${accountName}`);
        return result;
    } catch (error) {
        console.error('Error creating limit order:', error.message);
        throw error;
    }
}

/**
 * Build a limit_order_cancel operation.
 * @param {string} accountName - The name of the account.
 * @param {string} orderId - The ID of the order to cancel.
 * @returns {Promise<Object>} The operation object.
 * @throws {Error} If account not found.
 */
async function buildCancelOrderOp(accountName, orderId) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    return {
        op_name: 'limit_order_cancel',
        op_data: {
            fee: { amount: 0, asset_id: '1.3.0' },
            fee_paying_account: accId,
            order: orderId
        }
    };
}

/**
 * Cancel an existing limit order on the blockchain.
 * @param {string} accountName - The name of the account.
 * @param {string} privateKey - The private key for signing.
 * @param {string} orderId - The ID of the order to cancel.
 * @returns {Promise<Object>} Success object with order ID.
 * @throws {Error} If cancellation fails.
 */
async function cancelOrder(accountName, privateKey, orderId) {
    try {
        const op = await buildCancelOrderOp(accountName, orderId);

        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();
        // Explicit call
        tx.limit_order_cancel(op.op_data);
        await tx.broadcast();

        console.log(`Order ${orderId} cancelled successfully`);
        return { success: true, orderId };
    } catch (error) {
        console.error('Error cancelling order:', error.message);
        throw error;
    }
}

/**
 * Execute a batch of operations in a single transaction.
 * @param {string} accountName - Account paying fees (usually the bot account)
 * @param {string} privateKey - Private key for signing
 * @param {Array} operations - Array of operation objects { op_name, op_data } returned by build helpers
 * @returns {Promise<Object>} Transaction result
 */
async function executeBatch(accountName, privateKey, operations) {
    if (!operations || operations.length === 0) return { success: true, operations: 0 };

    try {
        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();

        for (const op of operations) {
            if (typeof tx[op.op_name] === 'function') {
                tx[op.op_name](op.op_data);
            } else {
                console.warn(`Transaction builder missing method for ${op.op_name}`);
                throw new Error(`Transaction builder does not support ${op.op_name}`);
            }
        }

        const result = await tx.broadcast();

        // Normalize broadcast response shape across btsdex/node variants.
        const operationResults =
            (result && Array.isArray(result.operation_results) && result.operation_results) ||
            (result && result.trx && Array.isArray(result.trx.operation_results) && result.trx.operation_results) ||
            (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results) ||
            [];

        return {
            success: true,
            raw: result,
            operation_results: operationResults
        };
    } catch (error) {
        console.error('Error executing batch transaction:', error.message);
        throw error;
    }
}

/**
 * Fetch on-chain balances and locked amounts for the specified account and assets.
 * This helper only reads on-chain balances and open-order locks and MUST NOT be
 * mixed with the manager's internal "available for orders" calculations.
 *
 * @param {String} accountRef - account name or id
 * @param {Array<String>} assets - array of asset ids or symbols to query (e.g. ['1.3.0','IOB.XRP'])
 * @returns {Object} mapping assetRef -> { assetId, symbol, precision, freeRaw, lockedRaw, free, locked, total }
 */
/**
 * Fetch account asset balances, including both free and locked portions.
 * @param {string} accountRef - Account ID or Name
 * @param {Array<string>} [assets] - Optional list of asset IDs or Symbols to fetch
 * @param {Object} [marketAssets] - Optional market IDs {assetAId, assetBId} for deep market scan
 * @returns {Promise<Object>} Map of asset details: { assetId, symbol, precision, free, locked, total }
 */
async function getOnChainAssetBalances(accountRef, assets = [], marketAssets = null) {
    if (!accountRef) return {};
    try {
        await waitForConnected();
        // Resolve account id if name provided
        let accountId = accountRef;
        if (typeof accountRef === 'string' && !/^1\.2\./.test(accountRef)) {
            const full = await BitShares.db.get_full_accounts([accountRef], false);
            if (Array.isArray(full) && full[0] && full[0][0]) accountId = full[0][0];
        }

        // Fetch account data (may be truncated)
        const full = await BitShares.db.get_full_accounts([accountId], false);
        if (!Array.isArray(full) || !full[0] || !full[0][1]) return {};
        const accountData = full[0][1] || {};
        const balances = accountData.balances || [];
        let limitOrders = accountData.limit_orders || [];

        // IMPROVEMENT: If marketAssets provided, perform deep scan to ensure locked funds
        // in our primary market are fully accounted for, even if get_full_accounts truncated them.
        if (marketAssets && marketAssets.assetAId && marketAssets.assetBId) {
            const deepScanOrders = await _readMarketOrders(accountId, marketAssets.assetAId, marketAssets.assetBId);
            if (deepScanOrders.length > 0) {
                const orderMap = new Map();
                limitOrders.forEach(o => orderMap.set(o.id, o));
                deepScanOrders.forEach(o => orderMap.set(o.id, o));
                limitOrders = Array.from(orderMap.values());
            }
        }

        // Build free balances map by asset id
        const freeInt = new Map();
        for (const b of balances) {
            const aid = String(b.asset_type || b.asset_id || b.asset);
            const val = Number(b.balance || b.amount || 0);
            freeInt.set(aid, (freeInt.get(aid) || 0) + val);
        }

        // Build locked map (for_sale) grouped by base asset id
        const lockedInt = new Map();
        for (const o of limitOrders) {
            if (!o || !o.sell_price || !o.sell_price.base) continue;
            const baseId = String(o.sell_price.base.asset_id);
            const forSale = Number(o.for_sale || 0);
            lockedInt.set(baseId, (lockedInt.get(baseId) || 0) + forSale);
        }

        // If assets omitted, build list from balances and limit_orders
        let assetList = assets;
        if (!assetList || !Array.isArray(assetList) || assetList.length === 0) {
            assetList = [];
            for (const b of balances) assetList.push(String(b.asset_type || b.asset_id || b.asset));
            for (const o of limitOrders) {
                if (!o || !o.sell_price || !o.sell_price.base) continue;
                assetList.push(String(o.sell_price.base.asset_id));
            }
            // de-duplicate
            assetList = Array.from(new Set(assetList));
        }

        const out = {};
        for (const a of assetList) {
            // resolve asset id and precision
            let aid = a;
            try {
                if (!/^1\.3\./.test(String(a))) {
                    // symbol -> asset
                    const res = await BitShares.db.lookup_asset_symbols([String(a)]).catch(() => null);
                    if (res && res[0] && res[0].id) aid = res[0].id;
                }
            } catch (e) { }

            // try to get precision and symbol
            let precision = null; let symbol = String(a);
            try {
                const am = await BitShares.db.get_assets([aid]).catch(() => null);
                if (Array.isArray(am) && am[0]) {
                    precision = typeof am[0].precision === 'number' ? am[0].precision : null;
                    symbol = am[0].symbol || symbol;
                }
            } catch (e) { 
                console.warn(`[chain_orders.js] Failed to fetch asset data for ${aid}:`, e.message);
            }

            if (precision === null) {
                console.error(`[chain_orders.js] CRITICAL: Could not determine precision for asset ${aid}. Skipping balance entry to prevent massive scaling errors.`);
                continue;
            }

            const freeRaw = freeInt.get(String(aid)) || 0;
            const lockedRaw = lockedInt.get(String(aid)) || 0;
            const free = blockchainToFloat(freeRaw, precision);
            const locked = blockchainToFloat(lockedRaw, precision);
            out[String(a)] = { assetId: String(aid), symbol, precision, freeRaw, lockedRaw, free, locked, total: free + locked };
        }

        return out;
    } catch (err) {
        return {};
    }
}

/**
 * Get the current fill processing mode.
 * @returns {string} 'history' or 'open'
 */
function getFillProcessingMode() {
    return FILL_PROCESSING_MODE;
}

module.exports = {
    selectAccount,
    setPreferredAccount,
    resolveAccountId,
    resolveAccountName,
    readOpenOrders,
    listenForFills,
    updateOrder,
    createOrder,
    cancelOrder,
    getOnChainAssetBalances,
    getFillProcessingMode,
    FILL_PROCESSING_MODE,
    buildUpdateOrderOp,
    buildCreateOrderOp,
    buildCancelOrderOp,
    executeBatch,

    // Note: authentication and key retrieval moved to modules/chain_keys.js
};
