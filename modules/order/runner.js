/**
 * Runner Module - Standalone order grid calculation utility
 * 
 * Provides a command-line tool for testing order grid generation
 * without actually placing orders. Useful for:
 * - Verifying configuration produces expected grid
 * - Testing price derivation from pool/market
 * - Debugging order sizing and fund allocation
 * - Validating fund calculations (available, virtual, committed)
 * 
 * Fund model overview (see manager.js for full details):
 * - available = max(0, chainFree - virtual - applicableBtsFeesOwed - btsFeesReservation)
 * - cacheFunds = fill proceeds and rotation surplus (tracked separately, part of chainFree)
 * - virtual = sum of VIRTUAL orders and ACTIVE orders without orderId (reserved, not yet on-chain)
 * - committed.grid = total sum of all grid order sizes (active + partial + virtual)
 * - committed.chain = sum of ACTIVE or PARTIAL orders that have an orderId on-chain
 * 
 * Usage: CALC_CYCLES=5 CALC_DELAY_MS=1000 node -e \"require('./runner').runOrderManagerCalculation()\"
 */
const fs = require('fs');
const path = require('path');
const { OrderManager } = require('./manager');
const Grid = require('./grid');
const { readBotsFileSync } = require('../bots_file_lock');
const { parseJsonWithComments } = require('../account_bots');
const { derivePrice, isNumeric } = require('./utils');

/**
 * Run a standalone order grid calculation for testing.
 * Loads bot config, derives market price, creates grid, and simulates cycles.
 * @throws {Error} If config invalid or startPrice outside bounds
 */
async function runOrderManagerCalculation() {
    const cfgFile = path.join(__dirname, '..', 'profiles', 'bots.json');
    let botConfig = {};
    
    try {
        const { config } = readBotsFileSync(cfgFile, parseJsonWithComments);
        const bots = config.bots || [];

        const envName = process.env.LIVE_BOT_NAME || process.env.BOT_NAME;
        let chosenBot = null;
        if (envName) chosenBot = bots.find(b => String(b.name).toLowerCase() === String(envName).toLowerCase());
        if (!chosenBot) chosenBot = bots[0];
        
        if (!chosenBot) {
            throw new Error('No bots found in profiles/bots.json');
        }
        
        console.log(`Using bot from settings: ${chosenBot.name || '<unnamed>'}`);
        botConfig = { ...chosenBot };
    } catch (err) {
        console.warn('Failed to read bot configuration:', err.message);
        throw err;
    }

    const rawMarketPrice = botConfig.startPrice;

    // Auto-derive price ONLY if not a fixed numeric value
    if (!isNumeric(rawMarketPrice)) {
        try {
            const { BitShares } = require('../bitshares_client');
            const mode = botConfig.priceMode || (rawMarketPrice === 'market' ? 'market' : (rawMarketPrice === 'pool' ? 'pool' : 'auto'));
            
            console.log(`Deriving startPrice using mode: ${mode}...`);
            const derived = await derivePrice(BitShares, botConfig.assetA, botConfig.assetB, mode);
            
            if (derived) {
                botConfig.startPrice = Number(derived);
                console.log(`✓ Derived startPrice from on-chain: ${botConfig.startPrice}`);
            } else {
                throw new Error(`Failed to derive price using mode "${mode}" and no numeric fallback available.`);
            }
        } catch (err) {
            console.error('Price derivation failed:', err.message);
            throw err;
        }
    }

    try {
        const mp = Number(botConfig.startPrice);
        if (!Number.isFinite(mp)) throw new Error('Invalid startPrice (not a number)');
    } catch (err) { throw err; }

    const manager = new OrderManager(botConfig);
    await Grid.initializeGrid(manager);

    const cycles = Number(process.env.CALC_CYCLES || 3);
    const delayMs = Number(process.env.CALC_DELAY_MS || 500);

    for (let cycle = 1; cycle <= cycles; cycle++) {
        manager.logger.log(`\n----- Cycle ${cycle}/${cycles} -----`, 'info');
        // Use syncFromOpenOrders([]) to simulate a sync check in the test runner
        await manager.syncFromOpenOrders([]);
        manager.logger && manager.logger.displayStatus && manager.logger.displayStatus(manager);
        if (cycle < cycles) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
}

module.exports = { runOrderManagerCalculation };

