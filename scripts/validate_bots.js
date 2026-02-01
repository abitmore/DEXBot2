#!/usr/bin/env node

/**
 * Bot Configuration Validator
 *
 * Validates that both the template and live bot configuration files contain
 * all required fields for each bot entry. This is a health check to ensure
 * configurations are valid before being used by the system.
 *
 * Checks two files:
 * 1. examples/bots.json (JSONC template with comments)
 * 2. profiles/bots.json (live config, plain JSON)
 *
 * Required fields for each bot: assetA, assetB, activeOrders, botFunds
 *
 * Usage: node scripts/validate_bots.js
 * Exit code: 0 (always, even if warnings found)
 */

const fs = require('fs');
const path = require('path');

// Define paths to configuration files
// cfgPath: Template file in examples folder (supports JSONC with comments)
// livePath: Production file in profiles folder (plain JSON, no comments)
const cfgPath = path.join(__dirname, '..', 'examples', 'bots.json');
const livePath = path.join(__dirname, '..', 'profiles', 'bots.json');

/**
 * stripComments: Remove JavaScript-style comments from JSON string
 *
 * JSONC (JSON with Comments) format is not standard JSON, but is commonly used
 * for configuration files. This function removes:
 * - Block comments: /* ... */
 * - Line comments: // ...
 *
 * Regex patterns:
 * - /\/\*(?:.|[\r\n])*?\*\//g: Matches /* */ comments across lines
 * - (^|\s*)\/\/.*: Matches // comments at any position in line
 *
 * @param {string} s - JSONC string potentially containing comments
 * @returns {string} - Cleaned JSON string ready for JSON.parse()
 */
function stripComments(s) {
  return s.replace(/\/\*(?:.|[\r\n])*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|\s*)\/\/.*/, ''))
    .join('\n');
}

/**
 * checkConfig: Validate bot configuration entries
 *
 * Verifies that each bot entry contains all required configuration fields.
 * Handles both single bot objects and arrays of bots in {bots: [...]}.
 *
 * Required fields:
 * - assetA: Base currency symbol (e.g., 'XRP')
 * - assetB: Quote currency symbol (e.g., 'BTS')
 * - activeOrders: Number of orders in the grid
 * - botFunds: Amount of funds allocated to the bot
 *
 * Output:
 * - Prints OK status for valid bots
 * - Warns about missing fields with bot index and name
 * - Summary message if all bots are valid
 *
 * @param {Object} obj - Parsed configuration object (single bot or {bots: [...]})
 * @param {string} src - Source name for display (e.g., 'examples/bots.json')
 */
function checkConfig(obj, src) {
  // Normalize: convert single bot to array format for uniform processing
  const bots = Array.isArray(obj.bots) && obj.bots.length ? obj.bots : [obj];
  console.log(`\n== Checking ${src}: found ${bots.length} bot entries`);

  // List of required fields that every bot must have
  const required = ['assetA', 'assetB', 'activeOrders', 'botFunds'];
  let anyMissing = false;

  // Validate each bot entry
  bots.forEach((b, i) => {
    // Use bot name if available, otherwise use index
    const name = b.name || `<unnamed-${i}>`;
    // Find which required fields are missing from this bot
    const missing = required.filter(k => !(k in b));

    if (missing.length) {
      // Bot is missing required fields
      anyMissing = true;
      console.warn(`- Bot[${i}] '${name}' is MISSING: ${missing.join(', ')}`);
    } else {
      // Bot has all required fields
      console.log(`- Bot[${i}] '${name}' OK`);
    }
  });

  // Print summary if all bots are valid
  if (!anyMissing) {
    console.log(`-> ${src}: all required fields present for every bot entry`);
  }
}

/**
 * Validate Template Configuration
 *
 * The template file (examples/bots.json) is in JSONC format (JSON with Comments).
 * Comments are stripped before parsing to allow JSON.parse() to work correctly.
 * Any parse errors are caught and reported without stopping execution.
 */
try {
  const rawCfg = fs.readFileSync(cfgPath, 'utf8');
  // Strip JSONC comments before parsing as standard JSON
  const cfg = JSON.parse(stripComments(rawCfg));
  checkConfig(cfg, 'examples/bots.json (template, JSONC)');
} catch (err) {
  console.error('tracked config: parse error ->', err.message);
}

/**
 * Validate Live Configuration
 *
 * The live config (profiles/bots.json) is plain JSON without comments.
 * It's used at runtime, so it must be valid JSON.
 * Parse errors are caught and reported without stopping execution.
 */
try {
  const rawLive = fs.readFileSync(livePath, 'utf8');
  const live = JSON.parse(rawLive);
  checkConfig(live, 'profiles/bots.json (live JSON)');
} catch (err) {
  console.error('live config: parse error ->', err.message);
}

// Exit with success code (validation warnings don't cause non-zero exit)
process.exit(0);
