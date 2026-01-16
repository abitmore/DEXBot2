/**
 * LoggerState - Tracks previous state and detects changes
 *
 * Used by Logger to determine if logging is needed (change detection).
 * Enables smart logging that only outputs when values actually change.
 *
 * @class
 */

class LoggerState {
    constructor() {
        this.previousState = {
            funds: null,
            orders: null,
            fills: null,
            boundary: null,
            errors: null
        };
        this.changeHistory = [];
        this.maxHistory = 100;
    }

    /**
     * Detect what changed between previous and current state
     * @param {string} category - Category name (funds, orders, fills, etc.)
     * @param {Object} current - Current state object
     * @returns {Object} { isNew: boolean, changes: Object }
     */
    detectChanges(category, current) {
        const prev = this.previousState[category];
        if (!prev) {
            this.previousState[category] = { ...current };
            return { isNew: true, changes: current };
        }

        const changes = this._deepDiff(prev, current);
        this.previousState[category] = { ...current };
        return { isNew: false, changes };
    }

    /**
     * Check if change exceeds significance threshold
     * @param {number} oldVal - Previous value
     * @param {number} newVal - Current value
     * @param {number} threshold - Threshold for significance
     * @returns {boolean} True if change is significant
     */
    isSignificantChange(oldVal, newVal, threshold = 0) {
        if (!Number.isFinite(oldVal) || !Number.isFinite(newVal)) return true;
        return Math.abs(oldVal - newVal) > threshold;
    }

    /**
     * Record change for history (auditing)
     * @param {number} timestamp - Unix timestamp
     * @param {string} category - Log category
     * @param {string} type - Event type
     * @param {Object} data - Change data
     */
    recordChange(timestamp, category, type, data) {
        this.changeHistory.push({ timestamp, category, type, data });
        if (this.changeHistory.length > this.maxHistory) {
            this.changeHistory.shift();
        }
    }

    /**
     * Get recent changes for a category
     * @param {string} category - Category to query
     * @param {number} count - Number of recent changes to return
     * @returns {Array} Recent changes
     */
    getRecentChanges(category, count = 10) {
        return this.changeHistory
            .filter(c => c.category === category)
            .slice(-count);
    }

    /**
     * Clear state for a category (reset previous state)
     * @param {string} category - Category to reset
     */
    reset(category) {
        this.previousState[category] = null;
    }

    /**
     * Deep diff between two objects
     * Detects all changes recursively
     * @param {Object} prev - Previous state
     * @param {Object} current - Current state
     * @returns {Object} Object with keys that changed
     * @private
     */
    _deepDiff(prev, current) {
        const diff = {};

        // Check all keys in current
        for (const key in current) {
            if (JSON.stringify(prev[key]) !== JSON.stringify(current[key])) {
                diff[key] = { from: prev[key], to: current[key] };
            }
        }

        // Check for deleted keys
        for (const key in prev) {
            if (!(key in current)) {
                diff[key] = { from: prev[key], to: undefined };
            }
        }

        return diff;
    }
}

module.exports = LoggerState;
