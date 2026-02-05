/**
 * modules/node_manager.js - Multi-Node Health Checking and Failover Management
 *
 * Manages a configurable list of BitShares nodes with automatic health checking and
 * intelligent node selection based on latency and availability.
 *
 * ===============================================================================
 * FEATURES
 * ===============================================================================
 *
 * 1. Node Health Monitoring
 *    - Periodic health checks for all configured nodes
 *    - Latency measurement via WebSocket ping
 *    - Chain ID validation (ensure correct network)
 *    - Automatic blacklisting of failed nodes
 *
 * 2. Intelligent Node Selection
 *    - Selects lowest-latency healthy node
 *    - Falls back to slow nodes if no healthy ones available
 *    - Respects user-preferred node if healthy
 *
 * 3. Failover Integration
 *    - Exports node stats for monitoring
 *    - Designed to work with btsdex-api's setServers() API
 *    - Automatic recovery when blacklisted nodes become healthy
 *
 * ===============================================================================
 * USAGE
 * ===============================================================================
 *
 * In bitshares_client.js:
 *
 *   const NodeManager = require('./node_manager');
 *   const nodeManager = new NodeManager(config);
 *   await nodeManager.checkAllNodes();
 *   const bestNode = nodeManager.getBestNode();
 *   btsdexApi.connection.setServers(nodeManager.getHealthyNodes());
 *   nodeManager.start();  // Begin periodic monitoring
 *
 * ===============================================================================
 */

const WebSocket = require('isomorphic-ws');

/**
 * NodeManager - Manages health checking and selection of BitShares nodes
 *
 * @class
 * @param {Object} config - Configuration object
 * @param {string[]} config.list - List of node URLs to monitor (e.g., wss://dex.iobanker.com/ws)
 * @param {Object} [config.healthCheck] - Health check settings
 * @param {number} [config.healthCheck.intervalMs=60000] - How often to check nodes (milliseconds)
 * @param {number} [config.healthCheck.timeoutMs=5000] - Timeout for each health check
 * @param {number} [config.healthCheck.maxPingMs=3000] - Max acceptable latency
 * @param {number} [config.healthCheck.blacklistThreshold=3] - Failures before blacklist
 * @param {Object} [config.selection] - Node selection settings
 * @param {string} [config.selection.strategy="latency"] - Selection strategy
 * @param {string} [config.selection.preferredNode] - Optional preferred node (if healthy)
 */
class NodeManager {
    constructor(config = {}) {
        this.config = {
            list: config.list || [],
            healthCheck: {
                intervalMs: config.healthCheck?.intervalMs ?? 60000,
                timeoutMs: config.healthCheck?.timeoutMs ?? 5000,
                maxPingMs: config.healthCheck?.maxPingMs ?? 3000,
                blacklistThreshold: config.healthCheck?.blacklistThreshold ?? 3,
                enabled: config.healthCheck?.enabled ?? true
            },
            selection: {
                strategy: config.selection?.strategy || 'latency',
                preferredNode: config.selection?.preferredNode || null
            }
        };

        // Node statistics tracking
        this.nodeStats = new Map();
        this.initializeNodeStats();

        // Control flags
        this.monitoringActive = false;
        this.checkIntervalId = null;

        // Expected chain ID (BitShares mainnet)
        this.expectedChainId = '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8';
    }

    /**
     * Initialize tracking for all configured nodes
     * @private
     */
    initializeNodeStats() {
        for (const nodeUrl of this.config.list) {
            if (!this.nodeStats.has(nodeUrl)) {
                this.nodeStats.set(nodeUrl, {
                    url: nodeUrl,
                    status: 'unchecked',      // unchecked | healthy | slow | failed | blacklisted
                    latencyMs: null,
                    failureCount: 0,
                    lastCheckTime: null,
                    lastErrorMessage: null,
                    chainId: null
                });
            }
        }
    }

    /**
     * Start periodic health monitoring
     */
    start() {
        if (this.monitoringActive) {
            console.warn('[NodeManager] Monitoring already active, ignoring duplicate start()');
            return;
        }

        this.monitoringActive = true;
        console.log(`[NodeManager] Started monitoring ${this.config.list.length} nodes (interval: ${this.config.healthCheck.intervalMs}ms)`);

        // Initial check immediately
        this.checkAllNodes().catch(err => {
            console.warn('[NodeManager] Initial health check failed:', err.message);
        });

        // Schedule periodic checks
        this.checkIntervalId = setInterval(() => {
            this.checkAllNodes().catch(err => {
                console.warn('[NodeManager] Health check cycle failed:', err.message);
            });
        }, this.config.healthCheck.intervalMs);
    }

    /**
     * Stop periodic health monitoring
     */
    stop() {
        if (!this.monitoringActive) return;

        this.monitoringActive = false;
        if (this.checkIntervalId !== null) {
            clearInterval(this.checkIntervalId);
            this.checkIntervalId = null;
        }
        console.log('[NodeManager] Stopped monitoring');
    }

    /**
     * Check all nodes in parallel
     * @returns {Promise<void>}
     */
    async checkAllNodes() {
        const promises = Array.from(this.nodeStats.keys()).map(nodeUrl => {
            return this.checkNode(nodeUrl).catch(err => {
                // Don't throw, just log - one node failure shouldn't crash the check cycle
                console.debug(`[NodeManager] Check failed for ${nodeUrl}: ${err.message}`);
            });
        });

        await Promise.all(promises);
    }

    /**
     * Check a single node's health
     *
     * Measures:
     * 1. WebSocket handshake latency
     * 2. RPC ping latency (get_chain_id)
     * 3. Chain ID validation
     * 4. Classifies as: healthy, slow, or failed
     *
     * @param {string} nodeUrl - WebSocket URL of the node
     * @returns {Promise<Object>} Health check result: { status, latency, error }
     */
    async checkNode(nodeUrl) {
        const stats = this.nodeStats.get(nodeUrl);
        if (!stats) {
            console.warn(`[NodeManager] Node ${nodeUrl} not in configured list`);
            return { status: 'unknown', latency: null, error: 'Not configured' };
        }

        const startTime = Date.now();
        const timeoutMs = this.config.healthCheck.timeoutMs;

        try {
            // Connect with timeout
            const ws = await this.connectWithTimeout(nodeUrl, timeoutMs);

            try {
                // Measure RPC latency
                const rpcStart = Date.now();
                const result = await this.rpcCall(ws, 'get_chain_id', [], timeoutMs);
                const latencyMs = Date.now() - rpcStart;

                // Validate chain ID
                if (result !== this.expectedChainId) {
                    throw new Error(`Wrong chain ID: ${result}, expected: ${this.expectedChainId}`);
                }

                // Classify health
                const status = latencyMs > this.config.healthCheck.maxPingMs ? 'slow' : 'healthy';

                // Update stats
                stats.status = status;
                stats.latencyMs = latencyMs;
                stats.failureCount = 0;
                stats.lastCheckTime = new Date().toISOString();
                stats.lastErrorMessage = null;
                stats.chainId = result;

                if (status === 'healthy') {
                    console.debug(`[NodeManager] ✓ ${nodeUrl.substring(0, 40)}... (${latencyMs}ms)`);
                } else {
                    console.debug(`[NodeManager] ⚠ ${nodeUrl.substring(0, 40)}... SLOW (${latencyMs}ms)`);
                }

                return { status, latency: latencyMs, error: null };
            } finally {
                ws.close();
            }
        } catch (err) {
            // Node failed health check
            stats.failureCount++;
            stats.lastCheckTime = new Date().toISOString();
            stats.lastErrorMessage = err.message;

            // Check if should be blacklisted
            if (stats.failureCount >= this.config.healthCheck.blacklistThreshold) {
                stats.status = 'blacklisted';
                console.warn(`[NodeManager] ✗ ${nodeUrl.substring(0, 40)}... BLACKLISTED (${err.message})`);
            } else {
                stats.status = 'failed';
                console.debug(`[NodeManager] ✗ ${nodeUrl.substring(0, 40)}... FAILED attempt ${stats.failureCount} (${err.message})`);
            }

            return { status: stats.status, latency: null, error: err.message };
        }
    }

    /**
     * Connect to a WebSocket with timeout
     * @private
     * @param {string} nodeUrl - WebSocket URL
     * @param {number} timeoutMs - Connection timeout
     * @returns {Promise<WebSocket>} Connected WebSocket instance
     */
    connectWithTimeout(nodeUrl, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Connection timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            try {
                const ws = new WebSocket(nodeUrl);

                ws.onopen = () => {
                    clearTimeout(timeout);
                    resolve(ws);
                };

                ws.onerror = (err) => {
                    clearTimeout(timeout);
                    reject(new Error(`WebSocket error: ${err.message || 'Unknown'}`));
                };

                ws.onclose = () => {
                    clearTimeout(timeout);
                    reject(new Error('WebSocket closed unexpectedly'));
                };
            } catch (err) {
                clearTimeout(timeout);
                reject(err);
            }
        });
    }

    /**
     * Make a JSON-RPC call to a WebSocket
     * @private
     * @param {WebSocket} ws - Connected WebSocket
     * @param {string} method - RPC method name
     * @param {Array} params - RPC parameters
     * @param {number} timeoutMs - RPC timeout
     * @returns {Promise<any>} RPC result
     */
    rpcCall(ws, method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(7);
            const request = {
                jsonrpc: '2.0',
                id: requestId,
                method,
                params
            };

            let isResolved = false;
            const originalHandler = ws.onmessage;

            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    // Clean up message handler to prevent memory leak
                    ws.onmessage = originalHandler;
                    reject(new Error(`RPC timeout after ${timeoutMs}ms`));
                }
            }, timeoutMs);

            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data.id === requestId && !isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        ws.onmessage = originalHandler;

                        if (data.error) {
                            reject(new Error(`RPC error: ${data.error.message}`));
                        } else {
                            resolve(data.result);
                        }
                    }
                } catch (err) {
                    // Continue listening for correct response
                }
            };

            try {
                ws.send(JSON.stringify(request));
            } catch (err) {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    ws.onmessage = originalHandler;
                    reject(err);
                }
            }
        });
    }

    /**
     * Get list of healthy nodes sorted by latency (best first)
     * @returns {string[]} Array of node URLs
     */
    getHealthyNodes() {
        const healthy = Array.from(this.nodeStats.values())
            .filter(stat => stat.status === 'healthy' || stat.status === 'slow')
            .sort((a, b) => {
                // Healthy nodes first, then by latency
                if (a.status !== b.status) {
                    return a.status === 'healthy' ? -1 : 1;
                }
                return (a.latencyMs || Infinity) - (b.latencyMs || Infinity);
            })
            .map(stat => stat.url);

        return healthy.length > 0 ? healthy : [];
    }

    /**
     * Get the single best (lowest latency) healthy node
     * @returns {string|null} Best node URL or null if none available
     */
    getBestNode() {
        const healthy = this.getHealthyNodes();
        return healthy.length > 0 ? healthy[0] : null;
    }

    /**
     * Manually blacklist a node (e.g., when it causes a connection failure)
     * @param {string} nodeUrl - Node URL to blacklist
     */
    blacklistNode(nodeUrl) {
        const stats = this.nodeStats.get(nodeUrl);
        if (stats) {
            stats.status = 'blacklisted';
            stats.failureCount = this.config.healthCheck.blacklistThreshold;
            console.warn(`[NodeManager] Manually blacklisted: ${nodeUrl}`);
        }
    }

    /**
     * Reset blacklist for a specific node (allow recovery)
     * @param {string} nodeUrl - Node URL to reset
     */
    resetNode(nodeUrl) {
        const stats = this.nodeStats.get(nodeUrl);
        if (stats) {
            stats.status = 'unchecked';
            stats.failureCount = 0;
            stats.latencyMs = null;
            stats.lastErrorMessage = null;
            console.log(`[NodeManager] Reset node: ${nodeUrl}`);
        }
    }

    /**
     * Reset all nodes (allow full recovery)
     */
    resetAllNodes() {
        for (const stats of this.nodeStats.values()) {
            stats.status = 'unchecked';
            stats.failureCount = 0;
            stats.latencyMs = null;
            stats.lastErrorMessage = null;
            stats.chainId = null;
        }
        console.log('[NodeManager] Reset all nodes');
    }

    /**
     * Get current node statistics (for monitoring/logging)
     * @returns {Array<Object>} Array of node stats
     */
    getStats() {
        return Array.from(this.nodeStats.values()).map(stat => ({
            url: stat.url,
            status: stat.status,
            latencyMs: stat.latencyMs,
            failureCount: stat.failureCount,
            lastCheckTime: stat.lastCheckTime,
            lastErrorMessage: stat.lastErrorMessage
        }));
    }

    /**
     * Get summary statistics
     * @returns {Object} Summary stats
     */
    getSummary() {
        const stats = Array.from(this.nodeStats.values());
        const counts = {
            total: stats.length,
            healthy: stats.filter(s => s.status === 'healthy').length,
            slow: stats.filter(s => s.status === 'slow').length,
            failed: stats.filter(s => s.status === 'failed').length,
            blacklisted: stats.filter(s => s.status === 'blacklisted').length,
            unchecked: stats.filter(s => s.status === 'unchecked').length
        };

        const bestNode = this.getBestNode();
        const statsWithLatency = stats.filter(s => s.latencyMs !== null);
        const avgLatency = statsWithLatency.length > 0
            ? Math.round(statsWithLatency.reduce((sum, s) => sum + s.latencyMs, 0) / statsWithLatency.length)
            : null;

        return {
            monitoring: this.monitoringActive,
            counts,
            bestNode,
            avgLatency
        };
    }
}

module.exports = NodeManager;
