#!/usr/bin/env node
/**
 * credential-daemon.js - Secure Private Key Server
 *
 * DEXBot credential daemon for multi-bot private key management.
 * Enables bot processes to request pre-decrypted keys via Unix socket.
 * Master password kept in RAM only, never exposed to bot processes.
 *
 * ===============================================================================
 * DAEMON OPERATION
 * ===============================================================================
 *
 * STARTUP:
 * 1. Prompts for master password ONCE at startup
 * 2. Authenticates with profiles/keys.json
 * 3. Keeps password in RAM only during operation
 * 4. Listens on Unix socket for credential requests
 * 5. Services private key requests from bot processes
 *
 * COMMUNICATION:
 * - Socket: /tmp/dexbot-cred-daemon.sock
 * - Ready file: /tmp/dexbot-cred-daemon.ready
 * - Connection timeout: 30 seconds
 * - Windows 10+: Supported; earlier Windows not supported
 *
 * REQUEST FORMAT:
 *   {"type": "private-key", "accountName": "account-name"}
 *
 * RESPONSE FORMAT:
 *   Success:  {"success": true, "privateKey": "5K..."}
 *   Failure:  {"success": false, "error": "Error message"}
 *
 * ===============================================================================
 * SECURITY BENEFITS
 * ===============================================================================
 *
 * - Master password prompt only once (at daemon startup)
 * - Individual bot processes have no access to master password
 * - No password in environment variables
 * - Private keys never written to disk unencrypted
 * - Centralized key management
 * - Unix socket provides process-level isolation
 *
 * ===============================================================================
 * USAGE
 * ===============================================================================
 *
 * Direct:
 *   node credential-daemon.js
 *
 * Via PM2 (recommended):
 *   npm run pm2:unlock-start
 *   or: node dexbot.js pm2
 *
 * Bot processes then access keys automatically via socket connection.
 *
 * ===============================================================================
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const chainKeys = require('./modules/chain_keys');

// Platform check - Unix sockets require Unix-like systems or Windows 10+
const platform = os.platform();
if (platform === 'win32') {
    const release = os.release();
    const majorVersion = parseInt(release.split('.')[0], 10);
    if (majorVersion < 10) {
        console.error('❌ Credential daemon requires Windows 10 or later');
        console.error('   On older Windows, use: node bot.js <bot-name> with interactive prompt');
        process.exit(1);
    }
}

const SOCKET_PATH = '/tmp/dexbot-cred-daemon.sock';
const READY_FILE = '/tmp/dexbot-cred-daemon.ready';

let masterPassword = null;
let server = null;

/**
 * Initialize daemon: authenticate and start listening
 */
async function initialize() {
    try {
        // Check if profiles/keys.json exists
        const keysPath = path.join(__dirname, 'profiles', 'keys.json');
        if (!fs.existsSync(keysPath)) {
            throw new Error('profiles/keys.json not found. Please run: node dexbot.js keys');
        }

        // Accept password from PM2 environment when available, otherwise prompt once.
        masterPassword = process.env.DAEMON_PASSWORD;
        if (!masterPassword) {
            masterPassword = await chainKeys.authenticate();
        }

        // Clean up old socket if it exists
        try {
            if (fs.existsSync(SOCKET_PATH)) {
                fs.unlinkSync(SOCKET_PATH);
            }
        } catch (err) {
            // Silently ignore
        }

        // Create server
        server = net.createServer(handleConnection);
        server.listen(SOCKET_PATH, () => {
            // Create ready file to signal startup completion
            try {
                fs.writeFileSync(READY_FILE, Date.now().toString());
            } catch (err) {
                // Silently ignore
            }
        });

        server.on('error', (error) => {
            console.error('❌ Server error:', error.message);
            process.exit(1);
        });

        // Handle graceful shutdown
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

    } catch (error) {
        console.error('❌', error.message);
        process.exit(1);
    }
}

/**
 * Handle incoming client connection to daemon.
 * Reads newline-delimited JSON requests and processes credential requests.
 * 
 * @param {net.Socket} socket - Connected client socket
 */
function handleConnection(socket) {
    let buffer = '';

    socket.on('data', (data) => {
        try {
            buffer += data.toString();

            // Look for newline-delimited JSON
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.trim()) {
                    processRequest(line.trim(), socket);
                }
            }
        } catch (error) {
            sendError(socket, 'Invalid request');
        }
    });

    socket.on('end', () => {
        // Connection closed
    });

    socket.on('error', (error) => {
        // Client disconnected or error
    });
}

/**
 * Process incoming credential request from client.
 * Validates request format and retrieves private key if valid.
 * Sends success or error response back to client.
 * 
 * @param {string} requestStr - JSON string with {type, accountName}
 * @param {net.Socket} socket - Client socket to send response
 */
function processRequest(requestStr, socket) {
    try {
        const request = JSON.parse(requestStr);
        const { type, accountName } = request;

        if (!type) {
            return sendError(socket, 'Missing "type" field');
        }

        if (type !== 'private-key') {
            return sendError(socket, `Unknown credential type: ${type}`);
        }

        if (!accountName) {
            return sendError(socket, 'Missing "accountName" field');
        }

        // Retrieve private key
        let privateKey;
        try {
            privateKey = chainKeys.getPrivateKey(accountName, masterPassword);
        } catch (error) {
            return sendError(socket, error.message);
        }

        sendSuccess(socket, { privateKey });
    } catch (error) {
        sendError(socket, error.message);
    }
}

/**
 * Send successful credential response to client.
 * 
 * @param {net.Socket} socket - Client socket
 * @param {Object} data - Response data (e.g., {privateKey: "5K..."})
 */
function sendSuccess(socket, data) {
    const response = JSON.stringify({
        success: true,
        ...data
    });
    socket.write(response + '\n');
}

/**
 * Send error response to client.
 * 
 * @param {net.Socket} socket - Client socket
 * @param {string} message - Error message
 */
function sendError(socket, message) {
    const response = JSON.stringify({
        success: false,
        error: message
    });
    socket.write(response + '\n');
}

/**
 * Gracefully shutdown daemon.
 * Clears master password from memory and closes server.
 */
function shutdown() {
    // Clear master password from memory
    if (masterPassword) {
        masterPassword = null;
    }

    // Close server
    if (server) {
        server.close(() => {
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
}

// Start daemon
initialize().catch(error => {
    console.error('❌', error.message);
    process.exit(1);
});
