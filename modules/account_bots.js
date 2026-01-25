// Interactive CLI helper for editing the tracked bot profiles stored in profiles/bots.json.
const fs = require('fs');
const path = require('path');
const readlineSync = require('readline-sync');
const readline = require('readline');
const { execSync } = require('child_process');
const { DEFAULT_CONFIG, GRID_LIMITS, TIMING, LOG_LEVEL, UPDATER } = require('./constants');

/**
 * Parses JSON content that may contain comments (/* or //).
 * @param {string} raw - The raw string content with possible comments.
 * @returns {Object} The parsed JSON object.
 */
function parseJsonWithComments(raw) {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped);
}

const BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');
const SETTINGS_FILE = path.join(__dirname, '..', 'profiles', 'general.settings.json');

/**
 * Async version of readlineSync.question that supports ESC key.
 * @param {string} prompt - The prompt text to display.
 * @param {Object} [options={}] - Input options.
 * @param {string} [options.mask] - Mask character for hidden input.
 * @param {boolean} [options.hideEchoBack=false] - Whether to hide input as it is typed.
 * @param {Function} [options.validate] - Validation function for the input.
 * @returns {Promise<string>} The input string, or '\x1b' if ESC is pressed.
 */
function readInput(prompt, options = {}) {
    const { mask, hideEchoBack = false, validate } = options;
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        let input = '';

        stdout.write(prompt);

        const isRaw = stdin.isRaw;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        const onData = (chunk) => {
            const s = String(chunk);
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];

                if (ch === '\x1b') { // ESC
                    if (s.length === 1) {
                        cleanup();
                        stdout.write('\n');
                        return resolve('\x1b');
                    }
                    continue;
                }

                if (ch === '\r' || ch === '\n' || ch === '\u0004') {
                    const trimmedInput = input.trim().toLowerCase();
                    // If validation function exists, check if input is valid
                    if (validate && !validate(trimmedInput)) {
                        // Invalid input - clear line and restart
                        for (let j = 0; j < input.length; j++) {
                            stdout.write('\b \b');
                        }
                        input = '';
                        return;
                    }
                    cleanup();
                    stdout.write('\n');
                    return resolve(input);
                }

                if (ch === '\u0003') { // Ctrl+C
                    cleanup();
                    process.exit();
                }

                if (ch === '\u007f' || ch === '\u0008') { // Backspace
                    if (input.length > 0) {
                        input = input.slice(0, -1);
                        stdout.write('\b \b');
                    }
                    continue;
                }

                const code = ch.charCodeAt(0);
                if (code >= 32 && code <= 126) {
                    input += ch;
                    if (!hideEchoBack) {
                        stdout.write(mask || ch);
                    }
                }
            }
        };

        const cleanup = () => {
            stdin.removeListener('data', onData);
            if (stdin.isTTY) stdin.setRawMode(isRaw);
        };

        stdin.on('data', onData);
    });
}

/**
 * Ensures that the profiles directory exists.
 * @private
 */
function ensureProfilesDirectory() {
    const dir = path.dirname(BOTS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Loads the bots configuration from profiles/bots.json.
 * @returns {Object} An object containing the config and the file path.
 */
function loadBotsConfig() {
    if (!fs.existsSync(BOTS_FILE)) {
        return { config: { bots: [] }, filePath: BOTS_FILE };
    }
    try {
        const content = fs.readFileSync(BOTS_FILE, 'utf8');
        if (!content || !content.trim()) return { config: { bots: [] }, filePath: BOTS_FILE };
        const parsed = parseJsonWithComments(content);
        if (!Array.isArray(parsed.bots)) parsed.bots = [];
        return { config: parsed, filePath: BOTS_FILE };
    } catch (err) {
        console.error('Failed to load bots configuration:', err.message);
        return { config: { bots: [] }, filePath: BOTS_FILE };
    }
}

/**
 * Saves the bots configuration to the specified file path.
 * @param {Object} config - The configuration object to save.
 * @param {string} filePath - The path to the file.
 * @throws {Error} If saving fails.
 */
function saveBotsConfig(config, filePath) {
    try {
            ensureProfilesDirectory();
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Failed to save bots configuration:', err.message);
        throw err;
    }
}

/**
 * Loads general settings from profiles/general.settings.json.
 * @returns {Object} The loaded settings or default settings if the file doesn't exist.
 */
function loadGeneralSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) {
        return {
            LOG_LEVEL: LOG_LEVEL,
            GRID_LIMITS: { ...GRID_LIMITS },
            TIMING: { ...TIMING },
            UPDATER: { ...UPDATER }
        };
    }
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(raw);
        // Ensure UPDATER section exists
        if (!settings.UPDATER) {
            settings.UPDATER = { ...UPDATER };
        }
        return settings;
    } catch (err) {
        console.error('Failed to load general settings:', err.message);
        return {
            LOG_LEVEL: LOG_LEVEL,
            GRID_LIMITS: { ...GRID_LIMITS },
            TIMING: { ...TIMING },
            UPDATER: { ...UPDATER }
        };
    }
}

/**
 * Saves general settings to profiles/general.settings.json.
 * @param {Object} settings - The settings object to save.
 */
function saveGeneralSettings(settings) {
    try {
        ensureProfilesDirectory();
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        console.log(`\n✓ General settings saved to ${path.basename(SETTINGS_FILE)}`);
    } catch (err) {
        console.error('Failed to save general settings:', err.message);
    }
}

/**
 * Lists the configured bots to the console.
 * @param {Array<Object>} bots - The list of bot configuration objects.
 */
function listBots(bots) {
    if (!bots.length) {
        console.log('  (no bot entries defined yet)');
        return;
    }
    bots.forEach((bot, index) => {
        const name = bot.name || `<unnamed-${index + 1}>`;
        const inactiveSuffix = bot.active === false ? ' [inactive]' : '';
        const dryRunSuffix = bot.dryRun ? ' (dryRun)' : '';
        console.log(`  ${index + 1}: ${name}${inactiveSuffix}${dryRunSuffix} ${bot.assetA || '?'} / ${bot.assetB || '?'}`);
    });
}

/**
 * Prompts the user to select a bot from the list.
 * @param {Array<Object>} bots - The list of bots.
 * @param {string} promptMessage - The message to display.
 * @returns {Promise<number|string|null>} The selected index, '\x1b' if ESC, or null if invalid.
 */
async function selectBotIndex(bots, promptMessage) {
    if (!bots.length) return null;
    listBots(bots);
    const raw = (await readInput(`${promptMessage} [1-${bots.length}]: `)).trim();
    if (raw === '\x1b') return '\x1b';
    const idx = Number(raw);
    if (Number.isNaN(idx) || idx < 1 || idx > bots.length) {
        if (raw !== '') console.log('Invalid selection.');
        return null;
    }
    return idx - 1;
}

/**
 * Prompts the user for a string input.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The user input or default value.
 */
async function askString(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const answer = await readInput(`${promptText}${suffix}: `);
    if (answer === '\x1b') return '\x1b';
    if (!answer) return defaultValue;
    return answer.trim();
}

/**
 * Prompts the user for a required string input.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askRequiredString(promptText, defaultValue) {
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        if (value && value.trim()) return value.trim();
        console.log('This field is required.');
    }
}

/**
 * Prompts the user for a cron schedule using interval and time.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askCronSchedule(promptText, defaultValue) {
    const current = parseCronToDelta(defaultValue);

    // Interval Prompt
    const days = await askNumberWithBounds('  Interval (days)', current.days, 1, 31);
    if (days === '\x1b') return '\x1b';

    // Time Prompt
    let time = current.time;
    while (true) {
        const rawTime = await askString('  Time (HH:mm)', current.time);
        if (rawTime === '\x1b') return '\x1b';
        if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(rawTime)) {
            time = rawTime;
            break;
        }
        console.log('  Invalid time format. Use HH:mm (24h)');
    }

    return deltaToCron(days, time);
}

/**
 * Prompts the user for a branch and validates it.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askUpdaterBranch(promptText, defaultValue) {
    const validBranches = ['main', 'dev', 'test', 'auto'];
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = value.toLowerCase().trim();
        if (validBranches.includes(lowered)) return lowered;
        console.log(`Invalid branch. Please choose from: ${validBranches.join(', ')}`);
    }
}

/**
 * Prompts the user for a log level and validates it.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askLogLevel(promptText, defaultValue) {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    while (true) {
        console.log(`Available levels: ${validLevels.join(', ')}`);
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = value.toLowerCase().trim();
        if (validLevels.includes(lowered)) return lowered;
        console.log(`Invalid log level. Please choose from: ${validLevels.join(', ')}`);
    }
}

/**
 * Prompts the user for an asset symbol.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAsset(promptText, defaultValue) {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        const answer = await readInput(`${promptText}${suffix}: `);
        if (answer === '\x1b') return '\x1b';

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        return answer.toUpperCase().trim();
    }
}

/**
 * Prompts the user for Asset B, ensuring it's different from Asset A.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @param {string} assetA - The symbol of Asset A.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAssetB(promptText, defaultValue, assetA) {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        const answer = await readInput(`${promptText}${suffix}: `);
        if (answer === '\x1b') return '\x1b';

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        const assetB = answer.toUpperCase().trim();

        // Validate that Asset B is different from Asset A
        if (assetB === assetA) {
            console.log(`Invalid: Asset B cannot be the same as Asset A (${assetA})`);
            continue;
        }

        return assetB;
    }
}

/**
 * Prompts the user for a numeric value.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askNumber(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumber(promptText, defaultValue);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askNumber(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for a weight distribution value with a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askWeightDistribution(promptText, defaultValue) {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    console.log('  \x1b[38;5;45m-1=SuperValley\x1b[0m ←→ \x1b[38;5;39m0=Valley\x1b[0m ←→ \x1b[38;5;250m0.5=Neutral\x1b[0m ←→ \x1b[38;5;208m1=Mountain\x1b[0m ←→ \x1b[38;5;196m2=SuperMountain\x1b[0m');
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistribution(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistribution(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for a weight distribution value without a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askWeightDistributionNoLegend(promptText, defaultValue) {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Checks if a value is a multiplier string (e.g. "3x").
 * @param {*} value - The value to check.
 * @returns {boolean} True if it's a multiplier string.
 */
function isMultiplierString(value) {
    return typeof value === 'string' && /^[-￿]*[0-9]+(?:\.[0-9]+)?x[-￿]*$/i.test(value);
}

/**
 * Validates a cron expression (5 fields).
 * @param {string} cron - The cron string to validate.
 * @returns {boolean} True if valid.
 */
function isValidCron(cron) {
    const cronRegex = /^((\*(\/\d+)?)|(\d+(-\d+)?(,\d+(-\d+)?)*))( ((\*(\/\d+)?)|(\d+(-\d+)?(,\d+(-\d+)?)*))){4}$/;
    return cronRegex.test(cron.trim());
}

/**
 * Converts a cron string to a readable format (days delta and time).
 * Only supports simple daily/multi-day patterns like "0 0 * /N * *".
 * @param {string} cron
 * @returns {Object} { days, time }
 */
function parseCronToDelta(cron) {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return { days: 1, time: '00:00' };

    const min = parts[0].padStart(2, '0');
    const hour = parts[1].padStart(2, '0');
    let days = 1;

    if (parts[2].startsWith('*/')) {
        days = parseInt(parts[2].substring(2)) || 1;
    } else if (parts[2] === '*') {
        days = 1;
    }

    return { days, time: `${hour}:${min}` };
}

/**
 * Converts days delta and time to a cron string.
 * @param {number} days
 * @param {string} time - format "HH:mm"
 * @returns {string} cron string
 */
function deltaToCron(days, time) {
    const [hour, min] = time.split(':').map(s => parseInt(s));
    const dayPart = days > 1 ? `*/${days}` : '*';
    return `${min} ${hour} ${dayPart} * *`;
}

/**
 * Prompts the user for a number within specified bounds.
 * @param {string} promptText - The prompt text to display.
 * @param {number} defaultValue - The default value to use if input is empty.
 * @param {number} minVal - The minimum allowed value.
 * @param {number} maxVal - The maximum allowed value.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askNumberWithBounds(promptText, defaultValue, minVal, maxVal) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= ${minVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    if (parsed > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be <= ${maxVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
}

/**
 * Prompts the user for the target spread percentage.
 * @param {string} promptText - The prompt text to display.
 * @param {number} defaultValue - The default value to use if input is empty.
 * @param {number} incrementPercent - The grid increment percentage.
 * @param {number} minSpreadFactor - The minimum spread factor from GRID_LIMITS.
 * @returns {Promise<number|string>} The spread percentage or '\x1b' if ESC.
 */
async function askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor = 2.1) {
    const minRequired = incrementPercent * minSpreadFactor;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue.toFixed(2)}]` : '';
    const raw = (await readInput(`${promptText} (>= ${minRequired.toFixed(2)})${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate >= minSpreadFactor x incrementPercent
    if (parsed < minRequired) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= ${minSpreadFactor}x incrementPercent (${minRequired.toFixed(2)})`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate no negative
    if (parsed < 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Cannot be negative`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    return parsed;
}

/**
 * Prompts the user for an integer within a range.
 * @param {string} promptText - The prompt text to display.
 * @param {number} defaultValue - The default value to use if input is empty.
 * @param {number} minVal - The minimum allowed value.
 * @param {number} maxVal - The maximum allowed value.
 * @returns {Promise<number|string>} The integer or '\x1b' if ESC.
 */
async function askIntegerInRange(promptText, defaultValue, minVal, maxVal) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is integer (not float)
    if (!Number.isInteger(parsed)) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be an integer (no decimals)`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal || Math.floor(parsed) > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be between ${minVal} and ${maxVal}`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
}

/**
 * Prompts the user for a numeric value or a multiplier.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askNumberOrMultiplier(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askNumberOrMultiplier(promptText, defaultValue);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for the maximum price, ensuring it's greater than minimum price.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} defaultValue - The default value to use if input is empty.
 * @param {number|string} minPrice - The minimum price.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askMaxPrice(promptText, defaultValue, minPrice) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askMaxPrice(promptText, defaultValue, minPrice);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that maxPrice > minPrice
    const minPriceValue = typeof minPrice === 'string' ? parseFloat(minPrice) : minPrice;
    if (parsed <= minPriceValue) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > minPrice (${minPriceValue})`);
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    return parsed;
}

/**
 * Normalizes a percentage string input.
 * @param {string} value - The input string.
 * @returns {string|null} The normalized percentage string or null if invalid.
 */
function normalizePercentageInput(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.endsWith('%')) return null;
    const numeric = Number(trimmed.slice(0, -1).trim());
    if (Number.isNaN(numeric)) return null;
    return `${numeric}%`;
}

/**
 * Prompts the user for a numeric value or a percentage.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askNumberOrPercentage(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const percent = normalizePercentageInput(raw);
    if (percent !== null) return percent;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or percentage (e.g. 100, 50%).');
        return askNumberOrPercentage(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for a boolean value (Y/n).
 * @param {string} promptText - The prompt text to display.
 * @param {boolean} defaultValue - The default value to use if input is empty.
 * @returns {Promise<boolean|string>} The boolean value or '\x1b' if ESC.
 */
async function askBoolean(promptText, defaultValue) {
    const label = defaultValue ? 'Y/n' : 'y/N';
    const raw = (await readInput(`${promptText} (${label}): `)).trim().toLowerCase();
    if (raw === '\x1b') return '\x1b';
    if (!raw) return !!defaultValue;
    return raw.startsWith('y');
}

/**
 * Prompts the user for the start price (numeric or "pool"/"market").
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<number|string>} The start price or '\x1b' if ESC.
 */
async function askStartPrice(promptText, defaultValue) {
    while (true) {
        const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
        const raw = (await readInput(`${promptText}${suffix}: `)).trim();

        if (raw === '\x1b') return '\x1b';

        if (!raw) {
            if (defaultValue !== undefined && defaultValue !== null) {
                return defaultValue;
            }
            return undefined;
        }

        const lower = raw.toLowerCase();
        // Accept 'pool' or 'market' strings
        if (lower === 'pool' || lower === 'market') {
            return lower;
        }

        // Accept numeric values (including decimals)
        const num = Number(raw);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
            return num;
        }

        console.log('Please enter "pool", "market", or a numeric value.');
    }
}

/**
 * Interactive menu to edit bot data.
 * @param {Object} [base={}] - The initial bot data to edit.
 * @returns {Promise<Object|null>} The edited bot data or null if cancelled.
 */
async function promptBotData(base = {}) {
    // Create a working copy of the data
    const data = JSON.parse(JSON.stringify(base));

    // Ensure nested objects exist
    if (!data.weightDistribution) data.weightDistribution = { ...DEFAULT_CONFIG.weightDistribution };
    if (!data.botFunds) data.botFunds = { ...DEFAULT_CONFIG.botFunds };
    if (!data.activeOrders) data.activeOrders = { ...DEFAULT_CONFIG.activeOrders };

    // Set other defaults if missing
    if (data.active === undefined) data.active = DEFAULT_CONFIG.active;
    if (data.dryRun === undefined) data.dryRun = DEFAULT_CONFIG.dryRun;
    if (data.minPrice === undefined) data.minPrice = DEFAULT_CONFIG.minPrice;
    if (data.maxPrice === undefined) data.maxPrice = DEFAULT_CONFIG.maxPrice;
    if (data.incrementPercent === undefined) data.incrementPercent = DEFAULT_CONFIG.incrementPercent;
    if (data.targetSpreadPercent === undefined) data.targetSpreadPercent = DEFAULT_CONFIG.targetSpreadPercent;
    if (data.startPrice === undefined) data.startPrice = data.startPrice || DEFAULT_CONFIG.startPrice || 'pool';

    let finished = false;
    let cancelled = false;
    let showMenu = true;

    while (!finished) {
        if (showMenu) {
             console.log('\n\x1b[1m--- Bot Editor: ' + (data.name || 'New Bot') + ' ---\x1b[0m');
             console.log(`\x1b[1;33m1) Pair:\x1b[0m       \x1b[1;31m${data.assetA || '?'} / ${data.assetB || '?'} \x1b[0m`);
             console.log(`\x1b[1;33m2) Identity:\x1b[0m   \x1b[38;5;208mName:\x1b[0m ${data.name || '?'} , \x1b[38;5;208mAccount:\x1b[0m ${data.preferredAccount || '?'} , \x1b[38;5;208mActive:\x1b[0m ${data.active}, \x1b[38;5;208mDryRun:\x1b[0m ${data.dryRun}`);
             console.log(`\x1b[1;33m3) Price:\x1b[0m      \x1b[38;5;208mRange:\x1b[0m [${data.minPrice} - ${data.maxPrice}], \x1b[38;5;208mStart:\x1b[0m ${data.startPrice}`);
             console.log(`\x1b[1;33m4) Grid:\x1b[0m       \x1b[38;5;208mWeights:\x1b[0m (S:${data.weightDistribution.sell}, B:${data.weightDistribution.buy}), \x1b[38;5;208mIncr:\x1b[0m ${data.incrementPercent}%, \x1b[38;5;208mSpread:\x1b[0m ${data.targetSpreadPercent}%`);
             console.log(`\x1b[1;33m5) Funding:\x1b[0m    \x1b[38;5;208mSell:\x1b[0m ${data.botFunds.sell}, \x1b[38;5;208mBuy:\x1b[0m ${data.botFunds.buy} | \x1b[38;5;208mOrders:\x1b[0m (S:${data.activeOrders.sell}, B:${data.activeOrders.buy})`);
             console.log('--------------------------------------------------');
             console.log('\x1b[1;32mS) Save & Exit\x1b[0m');
             console.log('\x1b[37mC) Cancel (Discard changes)\x1b[0m');
            showMenu = false;
        }

        const choice = (await readInput('Select section to edit or action: ', {
            validate: (input) => ['1', '2', '3', '4', '5', 's', 'c'].includes(input)
        })).trim().toLowerCase();

        if (choice === '\x1b') {
            finished = true;
            cancelled = true;
            break;
        }

        switch (choice) {
            case '1':
                const assetA = await askAsset('Asset A for selling', data.assetA);
                if (assetA === '\x1b') break;
                const assetB = await askAssetB('Asset B for buying', data.assetB, assetA);
                if (assetB === '\x1b') break;
                data.assetA = assetA;
                data.assetB = assetB;
                showMenu = true;
                break;
            case '2':
                const name = await askRequiredString('Bot name', data.name);
                if (name === '\x1b') break;
                const prefAcc = await askRequiredString('Preferred account', data.preferredAccount);
                if (prefAcc === '\x1b') break;
                const active = await askBoolean('Active', data.active);
                if (active === '\x1b') break;
                const dryRun = await askBoolean('Dry run', data.dryRun);
                if (dryRun === '\x1b') break;
                data.name = name;
                data.preferredAccount = prefAcc;
                data.active = active;
                data.dryRun = dryRun;
                showMenu = true;
                break;
            case '3':
                const minP = await askNumberOrMultiplier('minPrice', data.minPrice);
                if (minP === '\x1b') break;
                const maxP = await askMaxPrice('maxPrice', data.maxPrice, minP);
                if (maxP === '\x1b') break;
                const startP = await askStartPrice('startPrice (pool, market or A/B)', data.startPrice);
                if (startP === '\x1b') break;
                data.minPrice = minP;
                data.maxPrice = maxP;
                data.startPrice = startP;
                showMenu = true;
                break;
            case '4':
                const wSell = await askWeightDistribution('Weight distribution (sell)', data.weightDistribution.sell);
                if (wSell === '\x1b') break;
                const wBuy = await askWeightDistributionNoLegend('Weight distribution (buy)', data.weightDistribution.buy);
                if (wBuy === '\x1b') break;
                const incrP = await askNumberWithBounds('incrementPercent', data.incrementPercent, 0.01, 10);
                if (incrP === '\x1b') break;
                const defaultSpread = data.targetSpreadPercent || incrP * 4;

                // Use current general settings for the validation limit
                const currentSettings = loadGeneralSettings();
                const targetS = await askTargetSpreadPercent('targetSpread %', defaultSpread, incrP, currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR);

                if (targetS === '\x1b') break;
                data.weightDistribution.sell = wSell;
                data.weightDistribution.buy = wBuy;
                data.incrementPercent = incrP;
                data.targetSpreadPercent = targetS;
                showMenu = true;
                break;
            case '5':
                const fSell = await askNumberOrPercentage('botFunds sell amount', data.botFunds.sell);
                if (fSell === '\x1b') break;
                const fBuy = await askNumberOrPercentage('botFunds buy amount', data.botFunds.buy);
                if (fBuy === '\x1b') break;
                const oSell = await askIntegerInRange('activeOrders sell count', data.activeOrders.sell, 1, 100);
                if (oSell === '\x1b') break;
                const oBuy = await askIntegerInRange('activeOrders buy count', data.activeOrders.buy, 1, 100);
                if (oBuy === '\x1b') break;
                data.botFunds.sell = fSell;
                data.botFunds.buy = fBuy;
                data.activeOrders.sell = oSell;
                data.activeOrders.buy = oBuy;
                showMenu = true;
                break;
            case 's':
                // Final basic validation before saving
                if (!data.name || !data.assetA || !data.assetB || !data.preferredAccount) {
                    console.log('\x1b[31mError: Name, Pair, and Account are required before saving.\x1b[0m');
                    break;
                }
                finished = true;
                break;
            case 'c':
                finished = true;
                cancelled = true;
                break;
            default:
                // Invalid choice - just ignore and prompt again without redisplaying menu
        }
    }

    if (cancelled) return null;

    // Return the final data structure
    return {
        name: data.name,
        active: data.active,
        dryRun: data.dryRun,
        preferredAccount: data.preferredAccount,
        assetA: data.assetA,
        assetB: data.assetB,
        startPrice: data.startPrice,
        minPrice: data.minPrice,
        maxPrice: data.maxPrice,
        incrementPercent: data.incrementPercent,
        targetSpreadPercent: data.targetSpreadPercent,
        weightDistribution: data.weightDistribution,
        botFunds: data.botFunds,
        activeOrders: data.activeOrders
    };
}

/**
 * Interactive menu to edit general settings.
 * @returns {Promise<void>}
 */
async function promptGeneralSettings() {
    const settings = loadGeneralSettings();
    let finished = false;

     while (!finished) {
          console.log('\x1b[1m--- General Settings (Global) ---\x1b[0m');
          console.log(`\x1b[1;33m1) Grid Limits:\x1b[0m   \x1b[38;5;208mCache:\x1b[0m ${settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE}%, \x1b[38;5;208mRMS:\x1b[0m ${settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE}%, \x1b[38;5;208mDust:\x1b[0m ${settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE}%`);
          console.log(`\x1b[1;33m2) Grid Safety:\x1b[0m   \x1b[38;5;208mMinSpreadFactor:\x1b[0m ${settings.GRID_LIMITS.MIN_SPREAD_FACTOR}, \x1b[38;5;208mMinSpreadOrders:\x1b[0m ${settings.GRID_LIMITS.MIN_SPREAD_ORDERS}`);
          console.log(`\x1b[1;33m3) Timing (Core):\x1b[0m \x1b[38;5;208mFetchInterval:\x1b[0m ${settings.TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN}min, \x1b[38;5;208mSyncDelay:\x1b[0m ${settings.TIMING.SYNC_DELAY_MS / 1000}s, \x1b[38;5;208mLockTimeout:\x1b[0m ${settings.TIMING.LOCK_TIMEOUT_MS / 1000}s`);
          console.log(`\x1b[1;33m4) Timing (Fill):\x1b[0m \x1b[38;5;208mDedupeWindow:\x1b[0m ${settings.TIMING.FILL_DEDUPE_WINDOW_MS / 1000}s, \x1b[38;5;208mCleanupInterval:\x1b[0m ${settings.TIMING.FILL_CLEANUP_INTERVAL_MS / 1000}s, \x1b[38;5;208mRetention:\x1b[0m ${settings.TIMING.FILL_RECORD_RETENTION_MS / 1000}s`);
          console.log(`\x1b[1;33m5) Log lvl:\x1b[0m      \x1b[38;5;208m${settings.LOG_LEVEL}\x1b[0m (debug, info, warn, error)`);
          const updaterStatus = settings.UPDATER.ACTIVE ? `\x1b[32mON\x1b[0m` : `\x1b[31mOFF\x1b[0m`;
          const currentSched = parseCronToDelta(settings.UPDATER.SCHEDULE || "0 0 * * *");
          console.log(`\x1b[1;33m6) Updater:\x1b[0m      [${updaterStatus}] \x1b[38;5;208mBranch:\x1b[0m ${settings.UPDATER.BRANCH}, \x1b[38;5;208mInterval:\x1b[0m ${currentSched.days}d, \x1b[38;5;208mTime:\x1b[0m ${currentSched.time}`);
          console.log('--------------------------------------------------');
          console.log('\x1b[1;32mS) Save & Exit\x1b[0m');
          console.log('\x1b[37mC) Cancel (Discard changes)\x1b[0m');

         const choice = (await readInput('Select section to edit or action: ', {
             validate: (input) => ['1', '2', '3', '4', '5', '6', 's', 'c'].includes(input)
         })).trim().toLowerCase();

        if (choice === '\x1b') {
            finished = true;
            break;
        }

        switch (choice) {
            case '1':
                const gRegen = await askNumberWithBounds('Grid Cache Regeneration %', settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE, 0.1, 50);
                if (gRegen === '\x1b') break;
                const rms = await askNumberWithBounds('RMS Divergence Threshold %', settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE, 1, 100);
                if (rms === '\x1b') break;
                const dust = await askNumberWithBounds('Partial Dust Threshold %', settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE, 0.1, 50);
                if (dust === '\x1b') break;
                settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE = gRegen;
                settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE = rms;
                settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE = dust;
                break;
            case '2':
                const mFactor = await askNumberWithBounds('Minimum Spread Factor (Inc x Factor)', settings.GRID_LIMITS.MIN_SPREAD_FACTOR, 1.0, 10.0);
                if (mFactor === '\x1b') break;
                const mOrders = await askIntegerInRange('Minimum Spread Orders (Empty Slots)', settings.GRID_LIMITS.MIN_SPREAD_ORDERS, 1, 10);
                if (mOrders === '\x1b') break;
                settings.GRID_LIMITS.MIN_SPREAD_FACTOR = mFactor;
                settings.GRID_LIMITS.MIN_SPREAD_ORDERS = mOrders;
                break;
            case '3':
                const fetch = await askNumberWithBounds('Blockchain Fetch Interval (min)', settings.TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN, 1, 1440);
                if (fetch === '\x1b') break;
                const delay = await askNumberWithBounds('Sync Delay (s)', settings.TIMING.SYNC_DELAY_MS / 1000, 0.1, 10);
                if (delay === '\x1b') break;
                const lock = await askNumberWithBounds('Lock Timeout (s)', settings.TIMING.LOCK_TIMEOUT_MS / 1000, 1, 60);
                if (lock === '\x1b') break;
                settings.TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN = fetch;
                settings.TIMING.SYNC_DELAY_MS = delay * 1000;
                settings.TIMING.LOCK_TIMEOUT_MS = lock * 1000;
                break;
            case '4':
                const dedupe = await askNumberWithBounds('Fill Dedup Window (s)', settings.TIMING.FILL_DEDUPE_WINDOW_MS / 1000, 0.1, 30);
                if (dedupe === '\x1b') break;
                const clean = await askNumberWithBounds('Fill Cleanup Interval (s)', settings.TIMING.FILL_CLEANUP_INTERVAL_MS / 1000, 1, 60);
                if (clean === '\x1b') break;
                const retain = await askNumberWithBounds('Fill Record Retention (s)', settings.TIMING.FILL_RECORD_RETENTION_MS / 1000, 600, 86400);
                if (retain === '\x1b') break;
                settings.TIMING.FILL_DEDUPE_WINDOW_MS = dedupe * 1000;
                settings.TIMING.FILL_CLEANUP_INTERVAL_MS = clean * 1000;
                settings.TIMING.FILL_RECORD_RETENTION_MS = retain * 1000;
                break;
            case '5':
                const newLevel = await askLogLevel('Enter log level', settings.LOG_LEVEL);
                if (newLevel === '\x1b') break;
                settings.LOG_LEVEL = newLevel;
                break;
            case '6':
                const upActive = await askBoolean('Enable Automated Updater', settings.UPDATER.ACTIVE !== false);
                if (upActive === '\x1b') break;
                settings.UPDATER.ACTIVE = upActive;

                 console.log('  \x1b[38;5;250mBranch:\x1b[0m \x1b[32mmain\x1b[0m, \x1b[38;5;208mdev\x1b[0m, \x1b[31mtest\x1b[0m, or \x1b[38;5;39mauto\x1b[0m (detected current)');
                const branch = await askUpdaterBranch('Branch', settings.UPDATER.BRANCH);
                if (branch === '\x1b') break;

                const schedule = await askCronSchedule('Schedule', settings.UPDATER.SCHEDULE);
                if (schedule === '\x1b') break;

                settings.UPDATER.BRANCH = branch;

                settings.UPDATER.SCHEDULE = schedule;
                break;
            case 's':
                saveGeneralSettings(settings);
                finished = true;
                break;
            case 'c':
                finished = true;
                break;
            default:
                console.log('Invalid choice.');
        }
    }
}

/**
 * Entry point exposing a menu-driven interface for creating, modifying, and reviewing bots.
 * @returns {Promise<void>}
 */
async function main() {
    console.log('dexbot bots — bots.json configurator (writes profiles/bots.json)');
    const { config, filePath } = loadBotsConfig();
    let exit = false;
     while (!exit) {
         console.log('\nActions:');
         console.log('  1) New bot');
         console.log('  2) Modify bot');
         console.log('  3) Delete bot');
         console.log('  4) Copy bot');
         console.log('  5) List bots');
         console.log('  6) General settings');
         console.log('  7) Exit (or press Enter)');
         const selection = (await readInput('Choose an action [1-7]: ')).trim();
         console.log('');

         if (selection === '\x1b' || selection === '7' || selection === '') {
             exit = true;
             continue;
         }

        switch (selection) {
            case '1': {
                while (true) {
                    try {
                        const entry = await promptBotData();
                        if (!entry) break;
                        config.bots.push(entry);
                        saveBotsConfig(config, filePath);
                        console.log(`\nAdded bot '${entry.name}' to ${path.basename(filePath)}.`);
                    } catch (err) {
                        console.log(`\n❌ Invalid input: ${err.message}\n`);
                        break;
                    }
                }
                break;
            }
            case '2': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'modify or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    try {
                        const entry = await promptBotData(config.bots[idx]);
                        if (entry) {
                            config.bots[idx] = entry;
                            saveBotsConfig(config, filePath);
                            console.log(`saved settings '${entry.name}' in ${path.basename(filePath)}.\n`);
                        }
                    } catch (err) {
                        console.log(`\n❌ Invalid input: ${err.message}\n`);
                    }
                }
                break;
            }
            case '3': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'delete or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    const placeholderName = config.bots[idx].name || `<unnamed-${idx + 1}>`;
                    const confirm = await askBoolean(`Delete '${placeholderName}'?`, false);
                    if (confirm === '\x1b') break;
                    if (confirm) {
                        const removed = config.bots.splice(idx, 1)[0];
                        saveBotsConfig(config, filePath);
                        console.log(`Removed bot '${removed.name || placeholderName}' from ${path.basename(filePath)}.\n`);
                    } else {
                        console.log('\nDeletion cancelled.');
                    }
                }
                break;
            }
            case '4': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'copy or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    try {
                        const entry = await promptBotData(config.bots[idx]);
                        if (entry) {
                            config.bots.splice(idx + 1, 0, entry);
                            saveBotsConfig(config, filePath);
                            console.log(`Copied bot '${entry.name}' into ${path.basename(filePath)}.\n`);
                        }
                    } catch (err) {
                        console.log(`\n❌ Invalid input: ${err.message}\n`);
                    }
                }
                break;
            }
            case '5':
                listBots(config.bots);
                break;
            case '6':
                await promptGeneralSettings();
                break;
            case '7':
                exit = true;
                break;
            default:
                console.log('Unknown selection.');
        }
    }
    console.log('Botmanager closed!');
}

module.exports = { main, parseJsonWithComments, parseCronToDelta, deltaToCron };
