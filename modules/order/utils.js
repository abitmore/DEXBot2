/**
 * Utility helpers for OrderManager calculations and conversions
 * 
 * This module provides:
 * - Percentage string parsing ('50%' -> 0.5)
 * - Blockchain integer <-> human float conversions
 * - Relative price multiplier parsing ('5x' -> 5)
 */

/**
 * Check if a value is a percentage string (ends with '%')
 * @param {*} v - Value to check
 * @returns {boolean} True if percentage string
 */
function isPercentageString(v) {
    return typeof v === 'string' && v.trim().endsWith('%');
}

/**
 * Parse a percentage string to a decimal fraction.
 * @param {string} v - Percentage string (e.g., '50%')
 * @returns {number|null} Decimal fraction (0.5) or null if invalid
 */
function parsePercentageString(v) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    if (Number.isNaN(num)) return null;
    return num / 100.0;
}

/**
 * Convert a blockchain integer amount to human-readable float.
 * Blockchain stores amounts as integers (satoshis), this converts
 * to the human-readable decimal value.
 * 
 * @example blockchainToFloat(12345678, 4) -> 1234.5678
 * 
 * @param {number} intValue - Integer amount from blockchain
 * @param {number} precision - Asset precision (decimal places)
 * @returns {number} Human-readable float value
 */
function blockchainToFloat(intValue, precision) {
    if (intValue === null || intValue === undefined) return 0;
    const p = Number(precision || 0);
    return Number(intValue) / Math.pow(10, p);
}

/**
 * Convert a human-readable float to blockchain integer.
 * Reverses blockchainToFloat - converts decimals to satoshis.
 * 
 * @example floatToBlockchainInt(1234.5678, 4) -> 12345678
 * 
 * @param {number} floatValue - Human-readable amount
 * @param {number} precision - Asset precision (decimal places)
 * @returns {number} Integer amount for blockchain
 */
function floatToBlockchainInt(floatValue, precision) {
    const p = Number(precision || 0);
    // Return a JS Number integer representing the blockchain integer (not BigInt)
    return Math.round(Number(floatValue) * Math.pow(10, p));
}

/**
 * Check if a value is a relative multiplier string (e.g., '5x')
 * @param {*} value - Value to check
 * @returns {boolean} True if multiplier string
 */
function isRelativeMultiplierString(value) {
    return typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value);
}

/**
 * Parse a relative multiplier string to a number.
 * @param {string} value - Multiplier string (e.g., '5x')
 * @returns {number|null} Numeric multiplier or null if invalid
 */
function parseRelativeMultiplierString(value) {
    if (!isRelativeMultiplierString(value)) return null;
    const cleaned = value.trim().toLowerCase();
    const numeric = parseFloat(cleaned.slice(0, -1));
    return Number.isNaN(numeric) ? null : numeric;
}

/**
 * Resolve a relative price multiplier to an absolute price.
 * Used to configure min/max price bounds relative to market price.
 * 
 * @example
 * resolveRelativePrice('5x', 100, 'max') -> 500 (100 * 5)
 * resolveRelativePrice('5x', 100, 'min') -> 20  (100 / 5)
 * 
 * @param {string} value - Multiplier string (e.g., '5x')
 * @param {number} marketPrice - Current market price
 * @param {string} mode - 'min' (divide) or 'max' (multiply)
 * @returns {number|null} Absolute price or null if invalid
 */
function resolveRelativePrice(value, marketPrice, mode = 'min') {
    // Interpret relative multipliers like '5x' as min/max bounds around the market price.
    const multiplier = parseRelativeMultiplierString(value);
    if (multiplier === null || !Number.isFinite(marketPrice) || multiplier === 0) return null;
    if (mode === 'min') return marketPrice / multiplier;
    if (mode === 'max') return marketPrice * multiplier;
    return null;
}

module.exports = {
    isPercentageString,
    parsePercentageString,
    blockchainToFloat,
    floatToBlockchainInt,
    resolveRelativePrice
};

