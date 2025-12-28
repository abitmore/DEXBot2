/**
 * AsyncLock - Prevents concurrent execution of critical sections
 *
 * Solves the Time-of-Check vs Time-of-Use (TOCTOU) race condition
 * where checking a flag and setting it are not atomic operations.
 *
 * In JavaScript async code, multiple callbacks can interleave between
 * check and set operations. This lock ensures only one caller can
 * enter a critical section at a time.
 *
 * Usage:
 *   const lock = new AsyncLock();
 *
 *   const result = await lock.acquire(async () => {
 *       // Critical section - guaranteed only one execution at a time
 *       // Even if other callers check lock while this runs, they will wait
 *       return someAsyncOperation();
 *   });
 */
class AsyncLock {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    /**
     * Acquire the lock and execute callback exclusively
     * @param {Function} callback - Async function to execute exclusively
     * @returns {Promise} Result of callback execution
     */
    async acquire(callback) {
        return new Promise((resolve, reject) => {
            // Queue the callback with resolve/reject handlers
            this._queue.push({ callback, resolve, reject });

            // Try to process queue (will only run if not locked)
            this._processQueue();
        });
    }

    /**
     * Process queued callbacks one at a time
     * @private
     */
    async _processQueue() {
        // If already locked, another call is executing, wait
        if (this._locked || this._queue.length === 0) {
            return;
        }

        // Mark as locked to prevent concurrent processing
        this._locked = true;

        const { callback, resolve, reject } = this._queue.shift();

        try {
            // Execute the callback (guaranteed to be alone)
            const result = await callback();
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            // Unlock and process next item in queue
            this._locked = false;
            this._processQueue();
        }
    }

    /**
     * Check if lock is currently acquired
     * @returns {boolean}
     */
    isLocked() {
        return this._locked;
    }

    /**
     * Get number of operations waiting for lock
     * @returns {number}
     */
    getQueueLength() {
        return this._queue.length;
    }
}

module.exports = AsyncLock;
