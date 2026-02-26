'use strict';

/**
 * MARKET MONITOR — shared utilities
 *
 * Provides helpers used by both monitor_kibana.js and monitor_blockchain.js:
 *   - loadActiveBots()   read bots.json and return active bot entries
 *   - reportAMA()        run AMA on a close-price array and print results
 *
 * To run a monitor, use one of the dedicated scripts:
 *   node market_adapter/monitor_kibana.js      ← LP swap data from Elasticsearch
 *   node market_adapter/monitor_blockchain.js  ← DEX candles via BitShares RPC
 */

const fs   = require('fs');
const path = require('path');
const { calculateAMA } = require('../analysis/ama_fitting/ama');

const AMA_CONFIG = {
    erPeriod:   10,
    fastPeriod:  2,
    slowPeriod: 30,
};

/**
 * Load active bots from profiles/bots.json (falls back to examples/bots.json).
 * @returns {Array} active bot config objects
 */
function loadActiveBots() {
    let botsPath = path.join(__dirname, '../profiles/bots.json');
    if (!fs.existsSync(botsPath)) {
        console.warn('profiles/bots.json not found, using examples/bots.json');
        botsPath = path.join(__dirname, '../examples/bots.json');
    }

    const raw  = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
    const bots = Array.isArray(raw) ? raw : (raw.bots ?? []);
    return bots.filter(b => b.active);
}

/**
 * Run AMA on a close-price array and print a standard summary to console.
 * @param {string}   label   - display label (e.g. 'XRP/BTS')
 * @param {number[]} closes  - array of close prices, oldest first
 * @param {string}   [source] - optional label of where data came from
 */
function reportAMA(label, closes, source) {
    if (!closes || closes.length === 0) {
        console.log(`    (No price data — skipping AMA for ${label})`);
        return;
    }

    const amaValues    = calculateAMA(closes, AMA_CONFIG);
    const currentPrice = closes[closes.length - 1];
    const currentAMA   = amaValues[amaValues.length - 1];
    const deviation    = ((currentPrice - currentAMA) / currentAMA) * 100;

    if (source) console.log(`    Source:    ${source}`);
    console.log(`    Candles:   ${closes.length}`);
    console.log(`    Price:     ${currentPrice}`);
    console.log(`    AMA:       ${currentAMA.toFixed(8)}`);
    console.log(`    Deviation: ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}%`);

    if (Math.abs(deviation) > 2) {
        console.log('    ⚠  High volatility (|deviation| > 2%)');
    }
}

module.exports = { loadActiveBots, reportAMA, AMA_CONFIG };
