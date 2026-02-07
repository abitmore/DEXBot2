const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const SETTINGS_FILE = path.join(PROFILES_DIR, 'general.settings.json');

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
