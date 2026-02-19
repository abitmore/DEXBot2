/**
 * modules/order/working_grid.js - WorkingGrid Copy-on-Write Engine
 *
 * Efficient grid modification tracking for Copy-on-Write (COW) pattern.
 * Enables safe concurrent rebalancing by detecting changes without mutating master grid.
 *
 * Purpose:
 * - Clone master grid for isolated modifications
 * - Track which orders were modified (Modified Set)
 * - Build delta actions (create/update/delete) from master vs working
 * - Support price/index calculations for modified state
 * - Sync fills that arrive during rebalancing back to working grid
 *
 * Copy-on-Write Benefits:
 * - Master grid remains immutable during rebalancing
 * - Fills that arrive during rebalancing can sync to working grid without conflicts
 * - If rebalance fails, working grid is discarded (no cleanup needed)
 * - If rebalance succeeds, delta is applied atomically to master
 *
 * ===============================================================================
 * TABLE OF CONTENTS - WorkingGrid Class (13 methods)
 * ===============================================================================
 *
 * INITIALIZATION (2 methods)
 *   1. constructor(masterGrid, options) - Clone master grid and initialize tracking
 *      options.baseVersion: Track version synced from master
 *
 *   2. _cloneGrid(source) - Clone grid Map (internal)
 *   3. _cloneOrder(order) - Clone single order object with metadata cloning (internal)
 *
 * GRID OPERATIONS (6 methods)
 *   4. get(id) - Get order by ID
 *   5. set(id, order) - Set order and mark as modified
 *   6. delete(id) - Delete order and mark as modified
 *   7. has(id) - Check if order exists
 *   8. toMap() - Convert to plain Map (for commit)
 *
 * ITERATION & PROPERTIES (4 methods)
 *   9. values() - Iterate order values
 *   10. entries() - Iterate [id, order] pairs
 *   11. keys() - Iterate order IDs
 *   12. size - Get grid size property
 *
 * DELTA & DIFF CALCULATION (2 methods)
 *   13. buildDelta(masterGrid) - Calculate actions between master and working grids
 *       Returns: Array of {type, id, order} actions (create/update/delete)
 *   14. getIndexes() - Get lazy-computed price/type/state indexes
 *
 * MODIFICATION TRACKING (3 methods)
 *   15. getModifiedIds() - Get array of modified order IDs
 *   16. isModified() - Check if any modifications made
 *
 * SYNCHRONIZATION (1 method)
 *   17. syncFromMaster(masterGrid, orderId, masterVersion) - Sync specific order from master
 *       Used when fills arrive during rebalancing
 *
 * STALENESS & DIAGNOSTICS (3 methods)
 *   18. markStale(reason) - Mark working grid as stale (version mismatch)
 *   19. isStale() - Check if grid is stale
 *   20. getStaleReason() - Get reason for staleness
 *   21. getMemoryStats() - Get memory usage estimate
 *
 * ===============================================================================
 *
 * KEY PROPERTIES:
 * - grid: Map<orderId, order> - The working copy (cloned from master)
 * - modified: Set<orderId> - Tracks which orders were changed
 * - baseVersion: number - Version synced from master (for atomic commit check)
 * - _stale: boolean - Flag indicating grid has diverged from master version
 * - _indexes: Object - Lazy-computed indexes (price lookup, type/state filters)
 *
 * ===============================================================================
 */

const { buildDelta, buildIndexes } = require('./utils/order');
const { COW_PERFORMANCE } = require('../constants');

class WorkingGrid {
    /**
     * Create working grid from master
     * @param {Map} masterGrid - Source of truth grid (will be cloned)
     */
    constructor(masterGrid, options = {}) {
        this.grid = this._cloneGrid(masterGrid);
        this.modified = new Set();
        this._indexes = null;
        this.baseVersion = Number.isFinite(Number(options.baseVersion)) ? Number(options.baseVersion) : 0;
        this._stale = false;
        this._staleReason = null;
    }

    /**
     * Clone a Map containing order objects
     * @param {Map} source - Source map
     * @returns {Map} - Cloned map
     */
    _cloneGrid(source) {
        const cloned = new Map();
        for (const [id, order] of source.entries()) {
            cloned.set(id, this._cloneOrder(order));
        }
        return cloned;
    }

    /**
     * Clone a single order object
     * @param {Object} order - Order to clone
     * @returns {Object} - Cloned order
     */
    _cloneOrder(order) {
        return {
            ...order,
            metadata: order.metadata ? { ...order.metadata } : undefined
        };
    }

    get(id) { return this.grid.get(id); }
    
    set(id, order) {
        this.grid.set(id, order);
        this.modified.add(id);
        this._indexes = null;
    }
    
    delete(id) {
        this.grid.delete(id);
        this.modified.add(id);
        this._indexes = null;
    }
    
    has(id) { return this.grid.has(id); }
    values() { return this.grid.values(); }
    entries() { return this.grid.entries(); }
    keys() { return this.grid.keys(); }
    get size() { return this.grid.size; }

    /**
     * Get indexes (builds if not cached)
     * @returns {Object} - Grid indexes
     */
    getIndexes() {
        if (!this._indexes) {
            this._indexes = buildIndexes(this.grid);
        }
        return this._indexes;
    }

    /**
     * Build delta actions from master grid
     * @param {Map} masterGrid - Original master grid
     * @returns {Array} - Array of action objects
     */
    buildDelta(masterGrid) {
        return buildDelta(masterGrid, this.grid);
    }

    /**
     * Get list of modified order IDs
     * @returns {Array} - Array of modified IDs
     */
    getModifiedIds() {
        return Array.from(this.modified);
    }

    /**
     * Check if any modifications were made
     * @returns {boolean} - True if grid was modified
     */
    isModified() {
        return this.modified.size > 0;
    }

    markStale(reason = 'working grid stale') {
        this._stale = true;
        this._staleReason = reason;
    }

    isStale() {
        return this._stale;
    }

    getStaleReason() {
        return this._staleReason;
    }

    /**
     * Convert to plain Map (for commit)
     * @returns {Map} - The internal grid map
     */
    toMap() {
        return this.grid;
    }

    /**
     * Get memory usage estimate
     * @returns {Object} - Memory stats
     */
    getMemoryStats() {
        return {
            size: this.grid.size,
            modified: this.modified.size,
            estimatedBytes: this.grid.size * COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER
        };
    }

    /**
     * Sync a specific order from master grid to working grid.
     * Used when fills arrive during rebalance to keep working grid in sync.
     * @param {Map} masterGrid - Current master grid
     * @param {string} orderId - Order ID to sync
     * @param {number} [masterVersion] - Current master grid version (updates baseVersion to stay in sync)
     */
    syncFromMaster(masterGrid, orderId, masterVersion) {
        const masterOrder = masterGrid.get(orderId);
        if (!masterOrder) {
            // Order was deleted from master, also delete from working
            if (this.grid.has(orderId)) {
                this.grid.delete(orderId);
                this.modified.add(orderId);
                this._indexes = null;
            }
        } else {
            // Clone and update working grid with master state
            this.grid.set(orderId, this._cloneOrder(masterOrder));
            this.modified.add(orderId);
            this._indexes = null;
        }

        // Track the master version we've synced to so the commit-time version
        // check passes when the working grid has been kept up-to-date.
        if (Number.isFinite(masterVersion)) {
            this.baseVersion = masterVersion;
        }
    }
}

module.exports = { WorkingGrid };
