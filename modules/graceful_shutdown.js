/**
 * graceful_shutdown.js - Centralized graceful shutdown handler
 * 
 * Registers SIGTERM and SIGINT handlers to ensure clean process termination:
 * - Calls cleanup functions in reverse registration order
 * - Logs shutdown status
 * - Prevents duplicate shutdown execution
 * - Exits after cleanup complete
 * 
 * Usage:
 *   const { registerCleanup } = require('./modules/graceful_shutdown');
 *   registerCleanup('Bot connection', () => bot.shutdown());
 *   registerCleanup('BitShares', () => BitShares.disconnect());
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
