/**
 * modules/bitshares_client.js - BitShares Connection Manager
 *
 * Centralized BitShares client connection and account client factory.
 *
 * Features:
 * - Single shared connection for all database queries
 * - Connection state tracking with waitForConnected() helper
 * - Per-account client factory for signing/broadcasting transactions
 * - Subscription and event handling
 *
 * ===============================================================================
 * EXPORTS (3 items)
 * ===============================================================================
 *
 * 1. BitShares - Shared BitShares instance for database operations
 *    Used for: querying accounts, assets, orders, subscriptions
 *    Never use for signing transactions
 *
 * 2. waitForConnected(timeoutMs) - Wait for connection to ready state (async)
 *    Call before any chain operations
 *    Returns promise that resolves when connected
 *
 * 3. createAccountClient(name, key) - Create per-account client for signing
 *    Returns client instance with sign() and broadcast() methods
 *    Used for: createOrder, updateOrder, cancelOrder operations
 *
 * ===============================================================================
 *
 * ARCHITECTURE:
 * - Single shared connection: Reduces resource usage, centralized subscriptions
 * - Per-account clients: Enables multi-account signing without connection overhead
 * - Separation of concerns: Read ops on shared connection, write ops on account clients
 *
 * USAGE:
 * - Database queries: await BitShares.db.call("get_accounts", [[accountId]])
 * - Subscribe to events: BitShares.subscribe("connected", callback)
 * - Create/update orders: const client = createAccountClient(name, key); client.broadcast(op)
 *
 * ===============================================================================
 */

const BitSharesLib = require('btsdex');
require('./btsdex_event_patch');
const { TIMING, NODE_MANAGEMENT } = require('./constants');
const NodeManager = require('./node_manager');
const { readGeneralSettings } = require('./general_settings');

// Shared connection state for the process. Modules should use waitForConnected()
// to ensure the shared BitShares client is connected before making DB calls.
let connected = false;
let suppressConnectionLog = false;
const connectedCallbacks = new Set();

// Node Manager for multi-node support
let nodeManager = null;
let nodeConfig = null;

// Load node configuration from settings file
const settings = readGeneralSettings({
    fallback: null,
    onError: (err) => {
        console.warn('[NodeManager] Config load failed, continuing with defaults:', err.message);
    }
});

if (settings?.NODES?.enabled && settings.NODES?.list?.length > 0) {
    nodeConfig = settings.NODES;
    nodeManager = new NodeManager(nodeConfig);
    console.log(`[NodeManager] Loaded config for ${nodeConfig.list.length} nodes`);
}

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

    // Handle disconnections for failover
    BitSharesLib.subscribe('disconnected', async () => {
        if (nodeManager && nodeConfig?.healthCheck?.enabled) {
            console.warn('[NodeManager] Disconnected, triggering failover assessment');
            try {
                // Run immediate health check
                await nodeManager.checkAllNodes();

                // Get healthy nodes
                const healthyNodes = nodeManager.getHealthyNodes();
                if (healthyNodes.length > 0) {
                    const btsdexApi = BitSharesLib._api;
                    if (btsdexApi?.connection?.setServers) {
                        btsdexApi.connection.setServers(healthyNodes);
                        console.log(`[NodeManager] Updated server list for failover: ${healthyNodes.length} healthy nodes`);
                    }
                }
            } catch (err) {
                console.warn('[NodeManager] Failover assessment error:', err.message);
            }
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
async function waitForConnected(timeoutMs = TIMING.CONNECTION_TIMEOUT_MS) {
    const start = Date.now();
    while (!connected) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, TIMING.CHECK_INTERVAL_MS));
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
    getNodeManager: () => nodeManager,
    getNodeStats: () => nodeManager?.getStats(),
    getNodeSummary: () => nodeManager?.getSummary(),
    _internal: { get connected() { return connected; } }
};
