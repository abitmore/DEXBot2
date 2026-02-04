#!/usr/bin/env node
/**
 * bot.js - Single Bot Instance Launcher
 *
 * PM2-friendly entry point for single grid trading bot.
 * Standalone launcher executed by PM2 for each configured bot.
 * Handles bot initialization, authentication, and continuous trading loop.
 *
 * ===============================================================================
 * STARTUP SEQUENCE
 * ===============================================================================
 *
 * 1. BOT CONFIGURATION LOADING
 *    - Reads bot settings from profiles/bots.json by bot name (from argv)
 *    - Validates bot exists in configuration
 *    - Reports market pair and account being used
 *    - Loads trading parameters (grid size, spread, order count, etc.)
 *
 * 2. AUTHENTICATION
 *    - First attempts credential daemon (Unix socket) for pre-decrypted key
 *    - Falls back to interactive master password prompt if daemon unavailable
 *    - Master password never stored in environment variables
 *    - Private key loaded directly to bot memory
 *
 * 3. BOT INITIALIZATION
 *    - Waits for BitShares blockchain connection (30 second timeout)
 *    - Uses pre-decrypted private key for transaction signing
 *    - Resolves account ID from BitShares
 *    - Initializes OrderManager with bot configuration
 *    - Sets up event handlers for fills and blockchain updates
 *
 * 4. GRID INITIALIZATION OR RESUME
 *    - Loads persisted grid snapshot if it exists and matches on-chain orders
 *    - Validates persisted grid against current blockchain state
 *    - Creates fresh grid if no valid persisted state found
 *    - Synchronizes grid state with BitShares blockchain
 *    - Places initial orders to reach target count
 *
 * 5. TRADING LOOP
 *    - Continuously monitors for fill events via blockchain subscriptions
 *    - Updates order status from chain data
 *    - Processes fills and updates fund accounting
 *    - Regenerates/rebalances grid as needed
 *    - Runs indefinitely (PM2 manages restart/stop/monitoring)
 */

const fs = require('fs');
const path = require('path');
const accountBots = require('./modules/account_bots');
const { parseJsonWithComments } = accountBots;
const { createBotKey } = require('./modules/account_orders');
const DEXBot = require('./modules/dexbot_class');
const { normalizeBotEntry } = require('./modules/dexbot_class');
const { readBotsFileSync } = require('./modules/bots_file_lock');
const { setupGracefulShutdown, registerCleanup } = require('./modules/graceful_shutdown');

// Setup graceful shutdown handlers
setupGracefulShutdown();

const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');

// Get bot name from args or environment
// Support both direct names (node bot.js botname) and flag format (node bot.js --botname)
// Flag format is used by PM2 for consistency with other CLI tools
let botNameArg = process.argv[2];
if (botNameArg && botNameArg.startsWith('--')) {
    // Strip '--' prefix if present (e.g., --mybot becomes mybot)
    botNameArg = botNameArg.substring(2);
}
const botNameEnv = process.env.BOT_NAME || process.env.PREFERRED_ACCOUNT;
const botName = botNameArg || botNameEnv;

if (!botName) {
    console.error('[bot.js] No bot name provided. Usage: node bot.js <bot-name>');
    console.error('[bot.js] Or set BOT_NAME or PREFERRED_ACCOUNT environment variable');
    process.exit(1);
}

console.log(`[bot.js] Starting bot: ${botName}`);

/**
 * Loads the configuration for a specific bot from profiles/bots.json.
 * @param {string} name - The name of the bot to load.
 * @returns {Object} The bot configuration entry.
 * @throws {Error} If profiles/bots.json is missing or bot not found.
 */
function loadBotConfig(name) {
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        console.error('[bot.js] profiles/bots.json not found. Run: dexbot bots');
        process.exit(1);
    }

    try {
        const { config } = readBotsFileSync(PROFILES_BOTS_FILE, parseJsonWithComments);
        const bots = config.bots || [];
        const botEntry = bots.find(b => b.name === name);

        if (!botEntry) {
            console.error(`[bot.js] Bot '${name}' not found in profiles/bots.json`);
            console.error(`[bot.js] Available bots: ${bots.map(b => b.name).join(', ') || 'none'}`);
            process.exit(1);
        }

        return botEntry;
    } catch (err) {
        console.error(`[bot.js] Error loading bot config:`, err.message);
        process.exit(1);
    }
}

/**
 * Get private key for account from daemon or interactive prompt.
 * Tries daemon first (if running), then falls back to interactive master password prompt.
 * @param {string} accountName - The account name to retrieve key for.
 * @returns {Promise<string>} The decrypted private key.
 * @throws {Error} If both daemon and interactive authentication fail.
 */
async function getPrivateKeyForAccount(accountName) {
    const chainKeys = require('./modules/chain_keys');

    // Try daemon first
    if (chainKeys.isDaemonReady()) {
        console.log('[bot.js] Requesting private key from credential daemon...');
        try {
            const privateKey = await chainKeys.getPrivateKeyFromDaemon(accountName);
            console.log('[bot.js] Private key loaded from daemon');
            return privateKey;
        } catch (err) {
            console.warn('[bot.js] Daemon request failed:', err.message);
            console.log('[bot.js] Falling back to interactive authentication...\n');
        }
    } else {
        console.log('[bot.js] Credential daemon not available');
        console.log('[bot.js] Falling back to interactive authentication...\n');
    }

    // Fallback to interactive master password prompt
    const originalLog = console.log;
    try {
        console.log('[bot.js] Prompting for master password...');

        // Suppress BitShares client logs during password prompt
        console.log = (...args) => {
            const msg = args.join(' ');
            if (!msg.includes('bitshares_client') && !msg.includes('modules/')) {
                originalLog(...args);
            }
        };

        const masterPassword = await chainKeys.authenticate();

        // Restore console before getting key
        console.log = originalLog;
        console.log('[bot.js] Master password authenticated');

        // Get the private key using master password
        const privateKey = chainKeys.getPrivateKey(accountName, masterPassword);
        return privateKey;
    } catch (err) {
        console.log = originalLog;
        if (err && err.message && err.message.includes('No master password set')) {
            throw err;
        }
        throw err;
    }
}

// Main entry point
(async () => {
    try {
        // Load bot configuration
        const botConfig = loadBotConfig(botName);
        console.log(`[bot.js] Loaded configuration for bot: ${botName}`);
        console.log(`[bot.js] Market: ${botConfig.assetA}-${botConfig.assetB}, Account: ${botConfig.preferredAccount}`);

         // Load all bots from configuration to prevent pruning other active bots
          const allBotsConfig = readBotsFileSync(PROFILES_BOTS_FILE, parseJsonWithComments).config.bots || [];
         
         // Normalize all active bots with their correct indices in the unfiltered array
         // CRITICAL: Index must be based on position in allBotsConfig, not in filtered array.
         // The index is embedded in botKey (e.g., "bot-0", "bot-1"), determining file names.
         // If index changes, the bot loses access to persisted state files.
         const allActiveBots = allBotsConfig
             .map((b, idx) => b.active !== false ? normalizeBotEntry(b, idx) : null)
             .filter(b => b !== null);

         // Find the current bot's index in the unfiltered bots.json array
         const botIndex = allBotsConfig.findIndex(b => b.name === botName);
         if (botIndex === -1) {
             throw new Error(`Bot "${botName}" not found in ${PROFILES_BOTS_FILE}`);
         }

         // Normalize config for current bot with correct index from unfiltered array
         const normalizedConfig = normalizeBotEntry(botConfig, botIndex);

        // Get private key from daemon or interactively
        const preferredAccount = normalizedConfig.preferredAccount;
        const privateKey = await getPrivateKeyForAccount(preferredAccount);

         // Create and start bot with log prefix for [bot.js] context
          const bot = new DEXBot(normalizedConfig, { logPrefix: '[bot.js]' });
          try {
              // Register bot cleanup on shutdown
              registerCleanup(`Bot: ${botName}`, () => bot.shutdown());

              await bot.startWithPrivateKey(privateKey);
          } catch (err) {
              // Attempt graceful cleanup before exiting
              try {
                  await bot.shutdown();
              } catch (shutdownErr) {
                  console.error('[bot.js] Error during cleanup:', shutdownErr.message);
              }
              throw err;
          }

     } catch (err) {
         console.error('[bot.js] Failed to start bot:', err.message);
         process.exit(1);
     }
})();
