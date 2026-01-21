#!/usr/bin/env node
/**
 * Credential Daemon - Secure BitShares private key server
 *
 * This daemon:
 * 1. Prompts for master password ONCE at startup
 * 2. Keeps password in RAM only
 * 3. Listens on Unix socket for credential requests
 * 4. Decrypts and serves private keys to bot processes
 * 5. Never exposes password via environment variables
 *
 * Usage: node credential-daemon.js
 * Communication: Unix socket at /tmp/dexbot-cred-daemon.sock
 *
 * Request format: {"type": "private-key", "accountName": "account-name"}
 * Response format: {"success": true, "privateKey": "5K..."} or {"success": false, "error": "..."}
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

        // Get master password from environment variable (passed by pm2.js)
        // This avoids stdin inheritance issues entirely
        masterPassword = process.env.DAEMON_PASSWORD;
        if (!masterPassword) {
            throw new Error('No password provided - daemon must be started by pm2.js');
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
 * Handle incoming client connection
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
 * Process credential request
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
 * Send successful response
 */
function sendSuccess(socket, data) {
    const response = JSON.stringify({
        success: true,
        ...data
    });
    socket.write(response + '\n');
}

/**
 * Send error response
 */
function sendError(socket, message) {
    const response = JSON.stringify({
        success: false,
        error: message
    });
    socket.write(response + '\n');
}

/**
 * Graceful shutdown
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
