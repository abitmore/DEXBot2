/**
 * modules/order/index.js - Order Subsystem Entry Point
 *
 * Combined entry point that exports the order subsystem components.
 * Exposes OrderManager and supporting utilities for grid-based trading.
 *
 * ===============================================================================
 * EXPORTS
 * ===============================================================================
 *
 * CORE COMPONENTS:
 * - OrderManager - Core class managing order grid and fund tracking (manager.js)
 * - grid - Grid creation and sizing utilities (grid.js)
 * - utils - Combined helpers from utils/math.js, utils/order.js, and utils/system.js
 * - constants - ORDER_TYPES, ORDER_STATES, defaults, and limits (../constants.js)
 * - logger - Color-coded console output for debugging (logger.js)
 *
 * LAZY-LOADED:
 * - runOrderManagerCalculation(...args) - Heavy I/O calculation runner (runner.js)
 *   Lazy-loaded to avoid loading during unit tests
 *
 * ===============================================================================
 *
 * FUND TRACKING MODEL (see manager.js for details):
 * - available = max(0, chainFree - virtual - applicableBtsFeesOwed - btsFeesReservation)
 * - cacheFunds = fill proceeds and rotation surplus (kept separate)
 * - total.chain = chainFree + committed.chain (on-blockchain)
 * - total.grid = committed.grid + virtual (grid allocation)
 *
 * ORDER STATES:
 * - VIRTUAL: Not placed on blockchain, reserved on grid
 * - ACTIVE: Placed on blockchain, active in market
 * - PARTIAL: Partially filled on blockchain
 * - FILLED: Completed, removed from active grid
 * - CANCELLED: Removed from blockchain, cleared from grid
 *
 * ===============================================================================
 *
 * SUBSYSTEM MODULES:
 * 1. manager.js - OrderManager class (order lifecycle, fund tracking)
 * 2. grid.js - Grid class (grid creation, synchronization, health)
 * 3. utils/math.js, utils/order.js, utils/system.js - Helper functions by concern
 * 4. format.js - Numeric formatting (14 functions for consistent display)
 * 5. accounting.js - Accountant class (fund calculations and reconciliation)
 * 6. logger.js - Logger class (structured, color-coded output)
 * 7. logger_state.js - LoggerState class (change detection, audit trail)
 * 8. async_lock.js - AsyncLock class (race condition prevention)
 * 9. export.js - QTradeX export module (trade history extraction)
 * 10. runner.js - Heavy calculation and I/O operations
 * 11. startup_reconcile.js - Blockchain synchronization on startup
 * 12. strategy.js - Strategy configuration and parsing
 * 13. sync_engine.js - Real-time blockchain synchronization
 *
 * ===============================================================================
 */

const { OrderManager } = require('./manager');
// Runner may contain I/O and larger logic; require lazily to avoid loading it
// during small unit tests. Expose a lazy accessor instead.
const math = require('./utils/math');
const order = require('./utils/order');
const system = require('./utils/system');
const utils = { ...math, ...order, ...system };
const constants = require('../constants');
const logger = require('./logger');
const grid = require('./grid');

module.exports = {
  OrderManager,
  // Lazy-load the calculation runner so tests can require this module without triggering heavy I/O.
  runOrderManagerCalculation: (...args) => require('./runner').runOrderManagerCalculation(...args),
  utils,
  constants,
  logger,
  grid,
};
