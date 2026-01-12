/**
 * BitShares Client Module - Shared connection wrapper
 * 
 * This module provides a centralized BitShares client for the application:
 * - Single shared connection for all database queries
 * - Connection state tracking with waitForConnected() helper
 * - Per-account client factory for signing/broadcasting transactions
 * 
 * Usage:
 * - Import { BitShares, waitForConnected } for database operations
 * - Use createAccountClient(name, key) for transaction signing
 * - Call waitForConnected() before any chain operations
 * 
 * The shared BitShares instance handles subscriptions and DB queries.
 * Per-account clients are created for operations that require signing.
 */
const BitSharesLib = require('btsdex');
require('./btsdex_event_patch');

// Shared connection state for the process. Modules should use waitForConnected()
// to ensure the shared BitShares client is connected before making DB calls.
let connected = false;
let suppressConnectionLog = false;
const connectedCallbacks = new Set();

/**
 * Allow suppressing the connection log message.
 * @param {boolean} suppress - Whether to suppress the log message.
 */
function setSuppressConnectionLog(suppress) {
    suppressConnectionLog = suppress;
}

try {
    BitSharesLib.subscribe('connected', () => {
        connected = true;
        if (!suppressConnectionLog) {
            console.log('modules/bitshares_client: BitShares connected');
        }
        for (const cb of Array.from(connectedCallbacks)) {
            try { cb(); } catch (e) { console.error('connected callback error', e.message); }
        }
    });
} catch (e) {
    // Some environments may not have subscribe available at require time; that's okay
}

/**
 * Wait for the shared BitShares client to establish a connection.
 * Polls connection state until connected or timeout.
 * @param {number} timeoutMs - Maximum wait time in milliseconds (default: 30000)
 * @throws {Error} If connection times out
 */
async function waitForConnected(timeoutMs = 30000) {
    const start = Date.now();
    while (!connected) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

/**
 * Create a per-account client for signing and broadcasting transactions.
 * Each account needs its own client instance with the private key.
 * @param {string} accountName - BitShares account name
 * @param {string} privateKey - WIF-encoded private key
 * @returns {Object} btsdex client instance for this account
 */
function createAccountClient(accountName, privateKey) {
    // Instantiate a per-account client used for signing/broadcasting transactions.
    return new BitSharesLib(accountName, privateKey);
}

module.exports = {
    BitShares: BitSharesLib,
    createAccountClient,
    waitForConnected,
    setSuppressConnectionLog,
    _internal: { get connected() { return connected; } }
};

