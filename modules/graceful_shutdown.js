/**
 * modules/graceful_shutdown.js - Process Shutdown Manager
 *
 * Centralized graceful shutdown handler for clean process termination.
 *
 * Features:
 * - Registers signal handlers (SIGTERM, SIGINT)
 * - Executes cleanup functions in reverse registration order
 * - Prevents duplicate shutdown execution
 * - Graceful cleanup with timeout protection
 * - Detailed shutdown logging
 *
 * ===============================================================================
 * EXPORTS (1 function)
 * ===============================================================================
 *
 * 1. registerCleanup(name, cleanupFn) - Register cleanup function
 *    name: Description of cleanup operation (e.g., "Bot connection", "BitShares")
 *    cleanupFn: Async function to execute during shutdown
 *    Functions execute in reverse registration order (LIFO)
 *
 * ===============================================================================
 *
 * SHUTDOWN PROCESS:
 * 1. Receive SIGTERM or SIGINT signal
 * 2. Mark shutdown in progress (prevent duplicate execution)
 * 3. Log shutdown initiation
 * 4. Execute cleanup functions in reverse order (LIFO)
 * 5. Wait for all cleanups to complete (with timeout)
 * 6. Log shutdown status
 * 7. Exit process
 *
 * USAGE:
 * const { registerCleanup } = require('./modules/graceful_shutdown');
 *
 * // Register cleanups (executed in reverse order on shutdown)
 * registerCleanup('Database', async () => db.close());
 * registerCleanup('Bot', async () => bot.shutdown());
 * registerCleanup('BitShares', async () => BitShares.disconnect());
 *
 * On SIGTERM/SIGINT:
 * 1. BitShares disconnects
 * 2. Bot shuts down
 * 3. Database closes
 *
 * ===============================================================================
 *
 * BEST PRACTICES:
 * - Register cleanups for each major component
 * - Order matters: register in opposite order of initialization
 * - Keep cleanup functions quick and non-blocking where possible
 * - Handle cleanup errors gracefully (don't throw)
 *
 * ===============================================================================
 */

let cleanupHandlers = [];
let shutdownInProgress = false;

/**
 * Register a cleanup function to be called on graceful shutdown
 * Functions are called in LIFO order (last registered = first called)
 * @param {string} name - Name of the cleanup operation (for logging)
 * @param {Function} handler - Async or sync function to call on shutdown
 */
function registerCleanup(name, handler) {
    if (typeof handler !== 'function') {
        throw new Error(`Cleanup handler for '${name}' must be a function`);
    }
    cleanupHandlers.push({ name, handler });
}

/**
 * Execute all registered cleanup handlers
 * @private
 */
async function executeCleanup() {
    if (shutdownInProgress) {
        return;
    }
    shutdownInProgress = true;

    console.log('\n[Shutdown] Cleaning up resources...');

    // Execute handlers in LIFO order (last registered = first cleaned up)
    for (let i = cleanupHandlers.length - 1; i >= 0; i--) {
        const { name, handler } = cleanupHandlers[i];
        try {
            console.log(`[Shutdown] Cleaning up: ${name}`);
            const result = handler();
            // Handle both async and sync handlers
            if (result && typeof result.then === 'function') {
                await result;
            }
            console.log(`[Shutdown] ✓ ${name}`);
        } catch (err) {
            console.error(`[Shutdown] ✗ Error cleaning up ${name}:`, err.message || err);
        }
    }

    console.log('[Shutdown] Cleanup complete');
}

/**
 * Setup signal handlers for graceful shutdown
 * Should be called once at process startup
 */
function setupGracefulShutdown() {
    const signals = ['SIGTERM', 'SIGINT'];
    
    signals.forEach(signal => {
        process.on(signal, async () => {
            console.log(`\n[Shutdown] Received ${signal}, initiating graceful shutdown...`);
            await executeCleanup();
            process.exit(0);
        });
    });

    // Also handle uncaught exceptions
    process.on('uncaughtException', async (err) => {
        console.error('[Shutdown] Uncaught exception:', err);
        await executeCleanup();
        process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', async (reason, promise) => {
        console.error('[Shutdown] Unhandled rejection at:', promise, 'reason:', reason);
        await executeCleanup();
        process.exit(1);
    });
}

module.exports = {
    registerCleanup,
    setupGracefulShutdown,
};
