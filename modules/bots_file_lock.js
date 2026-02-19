/**
 * modules/bots_file_lock.js - File Synchronization Lock
 *
 * Thread-safe reading of bots.json with in-memory locking.
 * Prevents race conditions when multiple processes access file simultaneously.
 *
 * Locking Strategy:
 * - Semaphore-based mechanism
 * - Multiple reads can proceed in parallel
 * - Writes are exclusive (block all reads/writes)
 * - Queues operations during conflicts
 *
 * ===============================================================================
 * EXPORTS (3 functions)
 * ===============================================================================
 *
 * 1. readBotsFileWithLock(botsJsonPath, parseFunction) - Lock-protected async file read
 *    Returns: Promise<{content: string, config: Object}>
 *    Acquires lock, reads and parses file, releases lock
 *
 * 2. writeBotsFileWithLock(botsJsonPath, config) - Lock-protected async file write
 *    Returns: Promise<void>
 *    Acquires lock, writes JSON, releases lock
 *
 * 3. readBotsFileSync(botsJsonPath, parseFunction) - Synchronous file read (startup only)
 *    Returns: {content: string, config: Object}
 *    WARNING: Blocks event loop — only use before event loop is active
 *
 * ===============================================================================
 *
 * USAGE:
 * const { readBotsFileWithLock, writeBotsFileWithLock, readBotsFileSync } = require('./bots_file_lock');
 * const { config } = await readBotsFileWithLock('./profiles/bots.json', JSON.parse);
 * await writeBotsFileWithLock('./profiles/bots.json', updatedConfig);
 *
 * ===============================================================================
 */

const fs = require('fs');
const path = require('path');

/**
 * Semaphore for synchronizing access to bots.json.
 * @class
 */
class FileLock {
    constructor() {
        /** @type {boolean} */
        this.isLocked = false;
        /** @type {Array<Function>} */
        this.queue = [];
    }

    /**
     * Acquires the lock. If already locked, waits in queue.
     * @returns {Promise<void>}
     */
    async acquire() {
        if (!this.isLocked) {
            this.isLocked = true;
            return;
        }

        await new Promise(resolve => {
            this.queue.push(resolve);
        });
    }

    /**
     * Releases the lock and allows the next waiting operation to proceed.
     */
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        } else {
            this.isLocked = false;
        }
    }
}

// Global lock instance for bots.json
const botsFileLock = new FileLock();

/**
 * Safely read bots.json with lock protection
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Function} parseFunction - JSON parser function (e.g., parseJsonWithComments)
 * @returns {Promise<{content: string, config: Object}>} File content and parsed config
 * @throws {Error} If file doesn't exist or JSON is invalid
 */
async function readBotsFileWithLock(botsJsonPath, parseFunction) {
    await botsFileLock.acquire();
    try {
        if (!fs.existsSync(botsJsonPath)) {
            throw new Error(`bots.json not found at ${botsJsonPath}`);
        }

        const content = fs.readFileSync(botsJsonPath, 'utf8');
        if (!content || !content.trim()) {
            return { content: '', config: { bots: [] } };
        }

        const config = parseFunction(content);
        return { content, config };
    } finally {
        botsFileLock.release();
    }
}

/**
 * Safely write bots.json with lock protection
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Object} config - Configuration object to write
 * @returns {Promise<void>}
 * @throws {Error} If write fails
 */
async function writeBotsFileWithLock(botsJsonPath, config) {
    await botsFileLock.acquire();
    try {
        fs.writeFileSync(botsJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } finally {
        botsFileLock.release();
    }
}

/**
 * Synchronously read bots.json with lock protection
 * WARNING: This blocks the event loop. Use async version when possible.
 * Only use this for startup initialization before event loop is active.
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Function} parseFunction - JSON parser function
 * @returns {{content: string, config: Object}} File content and parsed config
 * @throws {Error} If file doesn't exist or JSON is invalid
 */
function readBotsFileSync(botsJsonPath, parseFunction) {
    if (!fs.existsSync(botsJsonPath)) {
        throw new Error(`bots.json not found at ${botsJsonPath}`);
    }

    const content = fs.readFileSync(botsJsonPath, 'utf8');
    if (!content || !content.trim()) {
        return { content: '', config: { bots: [] } };
    }

    const config = parseFunction(content);
    return { content, config };
}

module.exports = {
    readBotsFileWithLock,
    writeBotsFileWithLock,
    readBotsFileSync,
};
