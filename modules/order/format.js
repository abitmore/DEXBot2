/**
 * modules/order/format.js - Numeric formatting utilities
 *
 * Centralized formatting utilities for consistent decimal precision display across logs and output.
 * All functions return strings formatted to specified decimal places.
 *
 * ===============================================================================
 * DECIMAL PRECISION STANDARDS
 * ===============================================================================
 *
 * Asset Amounts:                8 decimals  - blockchain native precision
 * Prices:                       6-8 decimals - price precision varies by pair
 * Percentages:                  1-4 decimals - display precision
 * Ratios/Metrics:               2-5 decimals - context dependent
 * Time/Performance (ms, %):     1-2 decimals - readable metrics
 *
 * ===============================================================================
 * TABLE OF CONTENTS (16 exported functions)
 * ===============================================================================
 *
 * SECTION 1: ASSET FORMATTING (2 functions)
 *   1. formatAmount8(value) - Format to 8 decimals (blockchain standard)
 *   2. formatAmount(value, decimals) - Format with custom decimal places
 *   3. formatAmountByPrecision(value, precision, fallbackPrecision) - Format using chain precision
 *   4. formatSizeByOrderType(value, orderType, assets, fallbackPrecision) - Format order size by BUY/SELL asset precision
 *
 * SECTION 2: PRICE FORMATTING (3 functions)
 *   5. formatPrice(value) - Format to 8 decimals (maximum precision)
 *   6. formatPrice6(value) - Format to 6 decimals
 *   7. formatPrice4(value) - Format to 4 decimals (simplified display)
 *
 * SECTION 3: PERCENTAGE FORMATTING (3 functions)
 *   8. formatPercent2(value) - Format to 2 decimals (spread %, ratios)
 *   9. formatPercent4(value) - Format to 4 decimals (precise measurements)
 *   10. formatPercent(value, decimals) - Format with custom decimal places
 *
 * SECTION 4: RATIO/METRIC FORMATTING (3 functions)
 *   11. formatRatio(value, decimals) - Format ratios with custom decimals (default 5)
 *   12. formatMetric2(value) - Format to 2 decimals (timing, performance)
 *   13. formatMetric5(value) - Format to 5 decimals (detailed metrics)
 *
 * SECTION 5: HELPER UTILITIES (3 functions)
 *   14. isValidNumber(value) - Check if value is defined and finite
 *   15. toFiniteNumber(value, defaultValue) - Convert to finite number with fallback
 *   16. safeFormat(value, decimals, fallback) - Safely format with fallback
 *
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: ASSET FORMATTING
// ===============================================================================

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

/**
 * Format asset amount using an explicit blockchain precision.
 *
 * @param {number} value - The value to format
 * @param {number} precision - Asset precision to apply
 * @param {number} [fallbackPrecision=8] - Fallback decimals when precision is invalid
 * @returns {string} Formatted value
 */
function formatAmountByPrecision(value, precision, fallbackPrecision = 8) {
	const decimals = Number.isInteger(precision) && precision >= 0 ? precision : fallbackPrecision;
	return safeFormat(value, decimals);
}

/**
 * Format an order size using market-side precision.
 * BUY size is in assetB units, SELL size is in assetA units.
 *
 * @param {number} value - The value to format
 * @param {string} orderType - Order side ('buy' or 'sell')
 * @param {Object} assets - Asset metadata with assetA/assetB precision
 * @param {number} [fallbackPrecision=8] - Fallback decimals
 * @returns {string} Formatted value
 */
function formatSizeByOrderType(value, orderType, assets, fallbackPrecision = 8) {
	const side = String(orderType || '').toLowerCase();
	const buyPrecision = assets?.assetB?.precision;
	const sellPrecision = assets?.assetA?.precision;
	const precision = side === 'buy' ? buyPrecision : side === 'sell' ? sellPrecision : undefined;
	return formatAmountByPrecision(value, precision, fallbackPrecision);
}

/**
 * Format an amount with strict precision validation.
 * Returns 'N/A' if value or precision is invalid.
 * 
 * @param {*} value - Value to format
 * @param {number} precision - Decimal precision
 * @returns {string} Formatted amount or 'N/A'
 */
function formatAmountStrict(value, precision) {
	if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(precision))) return 'N/A';
	return formatAmountByPrecision(value, precision);
}

// ===============================================================================
// SECTION 2: PRICE FORMATTING
// ===============================================================================

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

// ===============================================================================
// SECTION 3: PERCENTAGE FORMATTING
// ===============================================================================

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

// ===============================================================================
// SECTION 4: RATIO/METRIC FORMATTING
// ===============================================================================

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

// ===============================================================================
// SECTION 5: HELPER UTILITIES
// ===============================================================================

/**
 * Check if a value is defined and represents a finite number.
 * @param {*} value - Value to check
 * @returns {boolean} True if value is defined and finite
 */
function isValidNumber(value) {
	return value !== null && value !== undefined && Number.isFinite(Number(value));
}

/**
 * Check if a value can be converted to a number.
 * Accepts numbers and numeric strings that are not empty or NaN.
 * 
 * @param {*} val - Value to test
 * @returns {boolean} True if val is a number or can be parsed as one
 */
function isNumeric(val) {
	return typeof val === 'number' || (typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val)));
}

/**
 * Safely convert a value to a finite number with fallback.
 * @param {*} value - Value to convert
 * @param {number} defaultValue - Fallback if not finite (default: 0)
 * @returns {number} Finite number or default
 */
function toFiniteNumber(value, defaultValue = 0) {
	const num = Number(value);
	return Number.isFinite(num) ? num : defaultValue;
}

/**
 * Safely format a numeric value with specified decimals and fallback.
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

// ===============================================================================
// EXPORTS
// ===============================================================================

module.exports = {
	// Asset formatting
	formatAmount8,
	formatAmount,
	formatAmountByPrecision,
	formatAmountStrict,
	formatSizeByOrderType,

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
	isNumeric,
	toFiniteNumber,
	safeFormat,
};
