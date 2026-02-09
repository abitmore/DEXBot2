/**
 * modules/general_settings.js - General Application Settings
 * 
 * Centralized management for application-wide settings stored in profiles/general.settings.json.
 * Provides read/write operations with fallback handling.
 */

const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const SETTINGS_FILE = path.join(PROFILES_DIR, 'general.settings.json');

/**
 * Read general application settings from file.
 * Returns fallback if file missing, empty, or parse fails.
 * 
 * @param {Object} [options={}] - Read options
 * @param {*} [options.fallback=null] - Fallback value if file missing or invalid
 * @param {Function} [options.onError=null] - Optional error callback (err, filePath)
 * @returns {Object|*} Parsed settings object or fallback value
 */
function readGeneralSettings({ fallback = null, onError = null } = {}) {
    if (!fs.existsSync(SETTINGS_FILE)) return fallback;

    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        if (typeof onError === 'function') onError(err, SETTINGS_FILE);
        return fallback;
    }
}

/**
 * Write general application settings to file.
 * Creates profiles directory if it doesn't exist.
 * Formats output as pretty-printed JSON.
 * 
 * @param {Object} settings - Settings object to write
 * @throws {Error} If write operation fails
 */
function writeGeneralSettings(settings) {
    if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

module.exports = {
    PROFILES_DIR,
    SETTINGS_FILE,
    readGeneralSettings,
    writeGeneralSettings,
};
