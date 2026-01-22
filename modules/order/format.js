/**
 * modules/order/format.js - Numeric formatting utilities
 *
 * Centralized formatting utilities for consistent decimal precision display across logs and output.
 * All functions return strings formatted to specified decimal places.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DECIMAL PRECISION STANDARDS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Asset Amounts:                8 decimals  - blockchain native precision
 * Prices:                       6-8 decimals - price precision varies by pair
 * Percentages:                  1-4 decimals - display precision
 * Ratios/Metrics:               2-5 decimals - context dependent
 * Time/Performance (ms, %):     1-2 decimals - readable metrics
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * TABLE OF CONTENTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ASSET FORMATTING (lines 37-50)
 *   - formatAmount8 (Asset amounts)
 *   - formatAmount (with custom decimal places)
 *
 * PRICE FORMATTING (lines 52-65)
 *   - formatPrice (default 8 decimals)
 *   - formatPrice6 (6 decimals)
 *   - formatPrice4 (4 decimals)
 *
 * PERCENTAGE FORMATTING (lines 67-80)
 *   - formatPercent2 (2 decimal places)
 *   - formatPercent4 (4 decimal places)
 *   - formatPercent (custom decimal places)
 *
 * RATIO/METRIC FORMATTING (lines 82-95)
 *   - formatRatio (with custom decimal places)
 *   - formatMetric2 (2 decimals for metrics)
 *   - formatMetric5 (5 decimals for metrics)
 *
 * HELPER UTILITIES (lines 97-110)
 *   - isValidNumber (check if value is finite number)
 *   - safeFormat (safe formatting with fallback)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: ASSET FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format asset amounts to 8 decimal places (blockchain standard)
 * Used for: Asset amounts, order sizes
 *
 * @param {number} value - The value to format
 * @returns {string} Formatted value to 8 decimals
 */
function formatAmount8(value) {
	return safeFormat(value, 8);
}

/**
 * Format asset amounts with custom decimal places
 *
 * @param {number} value - The value to format
 * @param {number} [decimals=8] - Number of decimal places (default 8)
 * @returns {string} Formatted value
 */
function formatAmount(value, decimals = 8) {
	return safeFormat(value, decimals);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: PRICE FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format prices to 8 decimal places (maximum precision)
 * Used for: order prices, market prices
 *
 * @param {number} value - The price to format
 * @returns {string} Formatted price to 8 decimals
 */
function formatPrice(value) {
	return safeFormat(value, 8);
}

/**
 * Format prices to 6 decimal places
 * Used for: display prices where 8 decimals is excessive
 *
 * @param {number} value - The price to format
 * @returns {string} Formatted price to 6 decimals
 */
function formatPrice6(value) {
	return safeFormat(value, 6);
}

/**
 * Format prices to 4 decimal places
 * Used for: simplified price display
 *
 * @param {number} value - The price to format
 * @returns {string} Formatted price to 4 decimals
 */
function formatPrice4(value) {
	return safeFormat(value, 4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: PERCENTAGE FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format percentages to 2 decimal places
 * Used for: spread %, ratios, simple percentages
 *
 * @param {number} value - The percentage value (0-100 or decimal 0-1)
 * @returns {string} Formatted percentage to 2 decimals
 */
function formatPercent2(value) {
	return safeFormat(value, 2);
}

/**
 * Format percentages to 4 decimal places
 * Used for: precise percentage measurements (basis points context)
 *
 * @param {number} value - The percentage value
 * @returns {string} Formatted percentage to 4 decimals
 */
function formatPercent4(value) {
	return safeFormat(value, 4);
}

/**
 * Format percentages with custom decimal places
 *
 * @param {number} value - The percentage value
 * @param {number} [decimals=2] - Number of decimal places (default 2)
 * @returns {string} Formatted percentage
 */
function formatPercent(value, decimals = 2) {
	return safeFormat(value, decimals);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: RATIO/METRIC FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format ratios with custom decimal places
 *
 * @param {number} value - The ratio value
 * @param {number} [decimals=5] - Number of decimal places (default 5)
 * @returns {string} Formatted ratio
 */
function formatRatio(value, decimals = 5) {
	return safeFormat(value, decimals);
}

/**
 * Format metrics to 2 decimal places
 * Used for: timing metrics, performance percentages, simple ratios
 *
 * @param {number} value - The metric value
 * @returns {string} Formatted metric to 2 decimals
 */
function formatMetric2(value) {
	return safeFormat(value, 2);
}

/**
 * Format metrics to 5 decimal places
 * Used for: detailed metric analysis, precision metrics
 *
 * @param {number} value - The metric value
 * @returns {string} Formatted metric to 5 decimals
 */
function formatMetric5(value) {
	return safeFormat(value, 5);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: HELPER UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if value is a valid finite number
 * Note: Also defined in utils.js - kept here to avoid circular dependency
 *
 * @param {*} value - The value to check
 * @returns {boolean} True if value is a finite number
 */
function isValidNumber(value) {
	return Number.isFinite(Number(value));
}

/**
 * Safely format a value to fixed decimals with fallback for invalid inputs
 *
 * @param {*} value - The value to format
 * @param {number} decimals - Number of decimal places
 * @param {string} [fallback='N/A'] - Fallback value if format fails
 * @returns {string} Formatted value or fallback string
 */
function safeFormat(value, decimals, fallback = 'N/A') {
	try {
		if (!isValidNumber(value)) {
			return fallback;
		}
		return Number(value).toFixed(decimals);
	} catch (e) {
		return fallback;
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
	// Asset formatting
	formatAmount8,
	formatAmount,

	// Price formatting
	formatPrice,
	formatPrice6,
	formatPrice4,

	// Percentage formatting
	formatPercent2,
	formatPercent4,
	formatPercent,

	// Ratio/Metric formatting
	formatRatio,
	formatMetric2,
	formatMetric5,

	// Helper utilities
	isValidNumber,
	safeFormat,
};
