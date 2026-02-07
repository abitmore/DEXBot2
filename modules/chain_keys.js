/**
 * modules/chain_keys.js - Authentication and Key Management
 *
 * Secure storage and management of BitShares private keys.
 * Provides authentication, key storage, and transaction signing capabilities.
 *
 * Features:
 * - Master password authentication with SHA-256 hash verification
 * - AES-256-GCM encryption with random salt and IV
 * - Private key retrieval for transaction signing
 * - Interactive CLI for key management (add/modify/remove)
 * - Daemon readiness checking
 *
 * Storage: profiles/keys.json (gitignored, never committed)
 *
 * Supported key formats:
 * - WIF (Wallet Import Format): 51-52 character Base58Check encoded
 * - PVT_K1_* style keys used by some Graphene chains
 * - Raw 64-character hexadecimal private keys
 *
 * Security: Master password never stored; only SHA-256 hash kept for verification.
 * All private keys encrypted before storage.
 *
 * ===============================================================================
 * EXPORTS (6 functions + 1 error class)
 * ===============================================================================
 *
 * AUTHENTICATION (1 function - async)
 *   1. authenticate() - Authenticate with master password
 *      Prompts user for password, verifies hash
 *      Throws MasterPasswordError on failure
 *
 * KEY MANAGEMENT (3 functions - async)
 *   2. getPrivateKey(accountName) - Get private key for account
 *      Returns decrypted private key string
 *      Returns null if not found
 *
 *   3. manageKeys() - Interactive CLI for key management
 *      Add/modify/remove keys from storage
 *      Re-encrypts entire key store
 *
 *   4. addKey(accountName, privateKey, masterPassword) - Add key to storage
 *      Validates key format, encrypts, saves
 *
 * DAEMON READINESS (2 functions - async)
 *   5. isDaemonReady() - Check if BitShares daemon is ready
 *
 *   6. waitForDaemon(timeoutMs) - Wait for daemon to become ready (async)
 *
 * ERROR HANDLING (1 error class)
 *   7. MasterPasswordError - Thrown when authentication fails
 *
 * ===============================================================================
 *
 * KEY STORAGE STRUCTURE (profiles/keys.json):
 * {
 *   "masterPasswordHash": "sha256hash",
 *   "keys": {
 *     "accountName": "encrypted:salt:iv:authTag:ciphertext"
 *   }
 * }
 *
 * ENCRYPTION PROCESS:
 * 1. Generate random salt (32 bytes) and IV (12 bytes)
 * 2. Derive key from master password using pbkdf2
 * 3. Encrypt private key with AES-256-GCM
 * 4. Store: encrypted:salt:iv:authTag:ciphertext
 *
 * ===============================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readInput, readPassword } = require('./order/utils/system');
const { TIMING } = require('./constants');

// Profiles key file (ignored) only
const PROFILES_KEYS_FILE = path.join(__dirname, '..', 'profiles', 'keys.json');

/**
 * Ensures that the profiles/keys directory exists.
 * @private
 */
function ensureProfilesKeysDirectory() {
    const dir = path.dirname(PROFILES_KEYS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Encrypt text using AES-256-GCM with random salt and IV.
 * Returns a colon-separated string: salt:iv:authTag:ciphertext
 * @param {string} text - Plain text to encrypt
 * @param {string} password - Encryption password
 * @returns {string} Encrypted data as hex string
 */
function encrypt(text, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text encrypted with the encrypt() function.
 * @param {string} encrypted - Colon-separated encrypted data
 * @param {string} password - Decryption password
 * @returns {string} Decrypted plain text
 * @throws {Error} If decryption fails (wrong password or corrupted data)
 */
function decrypt(encrypted, password) {
    const parts = encrypted.split(':');
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encryptedText = parts[3];
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const bs58check = require('bs58check').default || require('bs58check');

/**
 * Validate a private key format.
 * Supports WIF (Base58Check), PVT_K1_* style, and 64-char hex.
 * @param {string} key - Private key to validate
 * @returns {Object} { valid: boolean, reason?: string }
 */
function validatePrivateKey(key) {
    if (!key || typeof key !== 'string') return { valid: false, reason: 'Empty key' };
    const k = key.trim();

    // Basic characters allowed for base58-like / ASCII keys
    const base58chars = /^[1-9A-HJ-NP-Za-km-z]+$/;

    // Strict WIF validation using base58check decode (verifies checksum & structure)
    try {
        // bs58check will throw if checksum invalid
        const payload = bs58check.decode(k);
        // WIFs for Bitcoin-style keys use 0x80 version byte and payload lengths 33 or 34
        // Uncompressed WIF payload: [0x80 | 32-byte privkey]
        // Compressed WIF payload: [0x80 | 32-byte privkey | 0x01]
        if (payload && payload.length >= 33) {
            // version is first byte
            const version = payload[0];
            if (version === 0x80) {
                // valid WIF format
                // payload length 33 (no compression byte) => uncompressed, 34 => compressed
                if (payload.length === 33 || payload.length === 34) {
                    return { valid: true };
                }
            }
        }
    } catch (err) {
        // Not a valid base58check WIF; continue to other formats
    }

    // PVT-style private key used by some Graphene-based chains (e.g. PVT_K1_<data>)
    // Example shape: PVT_K1_base58...
    if (/^PVT_(?:K1_)?[A-Za-z0-9_-]+$/.test(k)) {
        return { valid: true };
    }

    // Hex private key (64 hex chars) - accept optionally
    if (/^[0-9a-fA-F]{64}$/.test(k)) {
        return { valid: true };
    }

    return { valid: false, reason: 'Unrecognized key format' };
}

/**
 * Load stored accounts from profiles/keys.json.
 * Returns empty structure if file doesn't exist or is corrupted.
 * @returns {Object} { masterPasswordHash: string, accounts: Object }
 */
function loadAccounts() {
    try {
        if (!fs.existsSync(PROFILES_KEYS_FILE)) {
            return { masterPasswordHash: '', accounts: {} };
        }
        const content = fs.readFileSync(PROFILES_KEYS_FILE, 'utf8').trim();
        if (!content) {
            return { masterPasswordHash: '', accounts: {} };
        }
        return JSON.parse(content);
    } catch (error) {
        console.error('Error loading accounts file, resetting to default:', error.message);
        return { masterPasswordHash: '', accounts: {} };
    }
}
/**
 * Hash a password using SHA-256 for storage/comparison.
 * @param {string} password - Password to hash
 * @returns {string} Hex-encoded hash
 */
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}
class MasterPasswordError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MasterPasswordError';
        this.code = 'MASTER_PASSWORD_FAILED';
    }
}

const MASTER_PASSWORD_MAX_ATTEMPTS = 3;
let masterPasswordAttempts = 0;

/**
 * Prompts the user for the master password with retry tracking.
 * @returns {Promise<string>} The entered password.
 * @throws {MasterPasswordError} If max attempts are reached.
 * @private
 */
async function _promptPassword() {
    if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
        throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
    }
    masterPasswordAttempts += 1;
    // Use readPassword instead of readlineSync to support Delete key and consistent masking
    return await readPassword('Enter master password: ');
}

/**
 * Authenticate and return the master password.
 * Prompts user interactively with limited retry attempts.
 * @returns {Promise<string>} The verified master password
 * @throws {Error} If no master password is set
 * @throws {MasterPasswordError} If max attempts exceeded
 */
async function authenticate() {
    const accountsData = loadAccounts();
    if (!accountsData.masterPasswordHash) {
        throw new Error('No master password set. Please run modules/chain_keys.js first.');
    }

    try {
        while (true) {
            const enteredPassword = await _promptPassword();
            if (hashPassword(enteredPassword) === accountsData.masterPasswordHash) {
                masterPasswordAttempts = 0;
                return enteredPassword;
            }
            if (masterPasswordAttempts < MASTER_PASSWORD_MAX_ATTEMPTS) {
                console.log('Master password not correct. Please try again.');
            }
        }
    } catch (err) {
        if (err instanceof MasterPasswordError) {
            masterPasswordAttempts = 0;
        }
        throw err;
    }
}

/**
 * Retrieve and decrypt a stored private key.
 * @param {string} accountName - Name of the account
 * @param {string} masterPassword - Master password for decryption
 * @returns {string} Decrypted private key
 * @throws {Error} If account not found
 */
function getPrivateKey(accountName, masterPassword) {
    const accountsData = loadAccounts();
    const account = accountsData.accounts[accountName];
    if (!account) {
        throw new Error(`Account '${accountName}' not found.`);
    }
    return decrypt(account.encryptedKey, masterPassword);
}
/**
 * Display stored account names to console.
 * @param {Object} accounts - Accounts object from loadAccounts()
 * @returns {Array<string>} Array of account names
 */
function listKeyNames(accounts) {
    if (!accounts || Object.keys(accounts).length === 0) {
        console.log('  (no accounts stored yet)');
        return [];
    }
    console.log('Stored keys:');
    return Object.keys(accounts).map((name, index) => {
        console.log(`  ${index + 1}. ${name}`);
        return name;
    });
}

/**
 * Prompts the user to select an account name from the stored keys.
 * @param {Object} accounts - The accounts object.
 * @param {string} promptText - The prompt message to display.
 * @returns {Promise<string|null>} The selected account name, or null/ESC.
 */
async function selectKeyName(accounts, promptText) {
    const names = Object.keys(accounts);
    if (!names.length) {
        console.log('No accounts available to select.');
        return null;
    }
    names.forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
    const raw = (await readInput(`${promptText} [1-${names.length}]: `)).trim();
    if (raw === '\x1b') return '\x1b';

    const idx = Number(raw) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= names.length) {
        if (raw !== '') console.log('Invalid selection.');
        return null;
    }
    return names[idx];
}

/**
 * Interactively changes the master password and re-encrypts all stored keys.
 * @param {Object} accountsData - The loaded accounts data object.
 * @param {string} currentPassword - The current master password.
 * @returns {Promise<string>} The new master password, or the old one if failed/cancelled.
 */
async function changeMasterPassword(accountsData, currentPassword) {
    if (!accountsData.masterPasswordHash) {
        console.log('No master password is set yet.');
        return currentPassword;
    }
    const oldPassword = await readPassword('Enter current master password: ');
    if (oldPassword === '\x1b') return currentPassword;

    if (hashPassword(oldPassword) !== accountsData.masterPasswordHash) {
        console.log('Incorrect master password!');
        return currentPassword;
    }
    const newPassword = await readPassword('Enter new master password:     ');
    if (newPassword === '\x1b') return currentPassword;

    const confirmPassword = await readPassword('Confirm new master password:   ');
    if (confirmPassword === '\x1b') return currentPassword;

    if (newPassword !== confirmPassword) {
        console.log('Passwords do not match!');
        return currentPassword;
    }
    if (!newPassword) {
        console.log('New master password cannot be empty.');
        return currentPassword;
    }

    const decryptedKeys = {};
    try {
        for (const [name, account] of Object.entries(accountsData.accounts)) {
            decryptedKeys[name] = decrypt(account.encryptedKey, oldPassword);
        }
    } catch (error) {
        console.log('Failed to decrypt stored keys with the current master password:', error.message);
        return currentPassword;
    }

    for (const [name, account] of Object.entries(accountsData.accounts)) {
        account.encryptedKey = encrypt(decryptedKeys[name], newPassword);
    }
    accountsData.masterPasswordHash = hashPassword(newPassword);
    saveAccounts(accountsData);
    console.log('Master password updated successfully.');
    return newPassword;
}

/**
 * Save accounts data to profiles/keys.json.
 * Creates directory if needed.
 * @param {Object} data - Accounts data to save
 */
function saveAccounts(data) {
    // Always save sensitive data to the live path (ignored by git)
    ensureProfilesKeysDirectory();
    fs.writeFileSync(PROFILES_KEYS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Launch the interactive key management CLI.
 * Provides menu for: add/modify/remove keys, test decryption,
 * change master password.
 */
async function main() {
    console.log('Chain Key Manager');
    console.log('========================');

    let accountsData = loadAccounts();
    let masterPassword = '';

    // Check if master password is set
    if (!accountsData.masterPasswordHash) {
        console.log('No master password set. Please set one:');
        const password1 = await readPassword('Enter master password:   ');
        const password2 = await readPassword('Confirm master password: ');
        if (password1 !== password2) {
            console.log('Passwords do not match!');
            return;
        }
        accountsData.masterPasswordHash = hashPassword(password1);
        saveAccounts(accountsData);
        masterPassword = password1;
        console.log('Master password set successfully.');
    } else {
        try {
            masterPassword = await authenticate();
            console.log('Authenticated successfully.');
        } catch (err) {
            if (err instanceof MasterPasswordError) {
                console.log(err.message);
                return;
            }
            throw err;
        }
    }

     while (true) {
         console.log('\nMenu:');
         console.log('1. Add key');
         console.log('2. Modify key');
         console.log('3. Remove key');
         console.log('4. List keys');
         console.log('5. Test decryption');
         console.log('6. Change master password');
         console.log('7. Exit (or press Enter)');

         const choiceRaw = await readInput('Choose an option: ');
         console.log('');

         if (choiceRaw === '\x1b' || choiceRaw.trim() === '') {
             console.log('Keymanager closed!');
             break;
         }

         const choice = choiceRaw.trim();

        if (choice === '1') {
            const accountNameRaw = await readInput('Enter account name: ');
            if (accountNameRaw === '\x1b') continue;
            const accountName = accountNameRaw.trim();
            if (!accountName) {
                continue;
            }

            const privateKeyRaw = await readPassword('Enter private key:  ');
            if (privateKeyRaw === '\x1b') continue;

            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, masterPassword);

            accountsData.accounts[accountName] = { encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' added successfully.`);
        } else if (choice === '2') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to modify');
            if (accountName === '\x1b' || !accountName) continue;
            
            const privateKeyRaw = await readPassword('Enter private key:   ');
            if (privateKeyRaw === '\x1b') continue;
            
            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, masterPassword);
            accountsData.accounts[accountName] = { ...accountsData.accounts[accountName], encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' updated successfully.`);
        } else if (choice === '3') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to remove');
            if (accountName === '\x1b' || !accountName) continue;
            
            const confirm = (await readInput(`Remove '${accountName}'? (y/n): `)).trim().toLowerCase();
            if (confirm === '\x1b') continue;

            if (confirm === 'y') {
                delete accountsData.accounts[accountName];
                saveAccounts(accountsData);
                console.log(`Account '${accountName}' removed successfully.`);
            } else {
                console.log('Cancelled.');
            }
        } else if (choice === '4') {
            listKeyNames(accountsData.accounts);
        } else if (choice === '5') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to test');
            if (accountName === '\x1b' || !accountName) continue;
            
            try {
                const decryptedKey = decrypt(accountsData.accounts[accountName].encryptedKey, masterPassword);
                console.log(`First 5 characters: ${decryptedKey.substring(0, 5)}`);
                decryptedKey.replace(/./g, ' ');
            } catch (error) {
                console.log('Decryption failed - wrong master password or corrupted data');
            }
        } else if (choice === '6') {
            masterPassword = await changeMasterPassword(accountsData, masterPassword);
        } else if (choice === '7') {
            console.log('Keymanager closed!');
            break;
        } else {
            console.log('Invalid choice.');
        }
    }
}

/**
 * Check if dexbot-cred daemon is ready and responsive
 * @returns {boolean} True if daemon socket is responsive
 */
function isDaemonReady() {
    try {
        return fs.existsSync('/tmp/dexbot-cred-daemon.ready') && fs.existsSync('/tmp/dexbot-cred-daemon.sock');
    } catch {
        return false;
    }
}

/**
 * Wait for dexbot-cred daemon to be ready
 * @param {number} maxWaitMs - Maximum time to wait in milliseconds (default 60000)
 * @returns {Promise<void>} Resolves when daemon is ready
 * @throws {Error} If daemon doesn't start within timeout
 */
async function waitForDaemon(maxWaitMs = TIMING.DAEMON_STARTUP_TIMEOUT_MS) {
    const startTime = Date.now();
    const checkInterval = TIMING.CHECK_INTERVAL_MS; // Check every 100ms

    while (Date.now() - startTime < maxWaitMs) {
        if (isDaemonReady()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error(`Daemon did not start within ${maxWaitMs}ms`);
}

/**
 * Request private key from dexbot-cred daemon via Unix socket
 * @param {string} accountName - Name of the account
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @returns {Promise<string>} Decrypted private key
 * @throws {Error} If daemon unavailable or request fails
 */
function getPrivateKeyFromDaemon(accountName, timeout = 5000) {
    const net = require('net');
    const SOCKET_PATH = '/tmp/dexbot-cred-daemon.sock';

    return new Promise((resolve, reject) => {
        const socket = net.createConnection(SOCKET_PATH, () => {
            // Send request
            socket.write(JSON.stringify({ type: 'private-key', accountName }) + '\n');
        });

        let responseBuffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('Daemon request timeout'));
        }, timeout);

        socket.on('data', (data) => {
            responseBuffer += data.toString();
            const lines = responseBuffer.split('\n');
            responseBuffer = lines.pop();

            for (const line of lines) {
                if (line.trim()) {
                    clearTimeout(timer);
                    socket.end();

                    try {
                        const response = JSON.parse(line);
                        if (response.success) {
                            return resolve(response.privateKey);
                        } else {
                            return reject(new Error(response.error || 'Unknown error'));
                        }
                    } catch (err) {
                        return reject(new Error('Invalid daemon response'));
                    }
                }
            }
        });

        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(new Error(`Daemon connection failed: ${error.message}`));
        });

        socket.on('end', () => {
            clearTimeout(timer);
            if (!responseBuffer.trim()) {
                reject(new Error('Daemon closed connection unexpectedly'));
            }
        });
    });
}

module.exports = {
    validatePrivateKey,
    loadAccounts,
    saveAccounts,
    encrypt,
    decrypt,
    hashPassword,
    main,
    authenticate,
    getPrivateKey,
    MasterPasswordError,
    isDaemonReady,
    waitForDaemon,
    getPrivateKeyFromDaemon,
};
