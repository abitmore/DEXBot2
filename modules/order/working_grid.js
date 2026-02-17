/**
 * WorkingGrid - Copy-on-Write grid wrapper
 * Tracks modifications and builds deltas from master
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
     * @returns {Map} - Deep cloned map
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
        const cloned = {
            ...order,
            metadata: order.metadata ? { ...order.metadata } : undefined
        };
        // Shallow-clone rawOnChain to prevent frozen-object mutation when
        // sync_engine updates for_sale on partial fills.
        if (order.rawOnChain && typeof order.rawOnChain === 'object') {
            cloned.rawOnChain = { ...order.rawOnChain };
            // Also clone sell_price if present (nested object with base/quote)
            if (order.rawOnChain.sell_price && typeof order.rawOnChain.sell_price === 'object') {
                cloned.rawOnChain.sell_price = {
                    ...order.rawOnChain.sell_price,
                    base: order.rawOnChain.sell_price.base ? { ...order.rawOnChain.sell_price.base } : undefined,
                    quote: order.rawOnChain.sell_price.quote ? { ...order.rawOnChain.sell_price.quote } : undefined
                };
            }
        }
        return cloned;
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
