/**
 * modules/order/async_lock.js - AsyncLock Engine
 *
 * Distributed mutual exclusion for async operations.
 * Exports a single AsyncLock class that prevents concurrent execution of critical sections.
 *
 * Solves the Time-of-Check vs Time-of-Use (TOCTOU) race condition
 * where checking a flag and setting it are not atomic operations.
 *
 * In JavaScript async code, multiple callbacks can interleave between
 * check and set operations. This lock ensures only one caller can
 * enter a critical section at a time, with fair FIFO queueing.
 *
 * Usage:
 *   const lock = new AsyncLock();
 *
 *   const result = await lock.acquire(async () => {
 *       // Critical section - guaranteed only one execution at a time
 *       // Even if other callers check lock while this runs, they will wait
 *       return someAsyncOperation();
 *   });
 *
 * ===============================================================================
 * TABLE OF CONTENTS - AsyncLock Class (4 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor() - Create new AsyncLock with empty queue and unlocked state
 *
 * LOCK ACQUISITION (1 method)
 *   2. acquire(callback) - Acquire lock and execute callback exclusively (async)
 *      Returns promise that resolves with callback result
 *      Queues request if lock is already held, processes in FIFO order
 *
 * QUEUE PROCESSING (1 method - internal)
 *   3. _processQueue() - Process queued callbacks one at a time (async, internal)
 *      Marks as locked, executes callback, handles errors, unlocks, processes next
 *      Recursive: processes next item after each callback completes
 *
 * STATUS QUERIES (2 methods)
 *   4. isLocked() - Check if lock is currently acquired
 *   5. getQueueLength() - Get number of operations waiting for lock
 *
 * ===============================================================================
 *
 * RACE CONDITION PREVENTION:
 * Problem: Check-then-act is not atomic in async code:
 *   if (!locked) {
 *       locked = true;  // <-- Another callback can run here!
 *       doWork();
 *   }
 *
 * Solution: FIFO queue with exclusive execution:
 *   1. Queue callback and handlers
 *   2. Set _locked = true (prevents concurrent entry)
 *   3. Execute callback (guaranteed alone)
 *   4. Set _locked = false and process next queued item
 *
 * CRITICAL INVARIANTS:
 * - _locked = true ONLY if callback is currently executing
 * - At most one callback in "await callback()" at any time
 * - All queued callbacks are guaranteed exclusive access
 * - If _locked = false and queue is empty, no operations pending
 *
 * ===============================================================================
 *
 * @class
 */

class AsyncLock {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    /**
     * Acquire the lock and execute callback exclusively
     * @param {Function} callback - Async function to execute exclusively
     * @param {Object} [options] - Optional settings
     * @param {Object} [options.cancelToken] - Optional object with 'isCancelled' property
     * @returns {Promise} Result of callback execution
     */
    async acquire(callback, options = {}) {
        const cancelToken = options.cancelToken;
        return new Promise((resolve, reject) => {
            // Queue the callback with resolve/reject handlers
            this._queue.push({ callback, resolve, reject, cancelToken });

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

        const { callback, resolve, reject, cancelToken } = this._queue.shift();

        // If operation was cancelled while in queue, skip it
        if (cancelToken && cancelToken.isCancelled) {
            this._locked = false;
            reject(new Error('Lock acquisition cancelled (timeout)'));
            // Process next item immediately
            return this._processQueue();
        }

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

    /**
     * Clear all pending operations in the queue.
     * Does NOT stop the currently executing operation if it is already locked.
     */
    clearQueue() {
        const count = this._queue.length;
        while (this._queue.length > 0) {
            const { reject } = this._queue.shift();
            reject(new Error('Lock queue cleared'));
        }
        return count;
    }
}

module.exports = AsyncLock;
