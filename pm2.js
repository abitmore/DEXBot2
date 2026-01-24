#!/usr/bin/env node
/**
 * pm2.js - Unified PM2 launcher for DEXBot2
 *
 * One-command startup for DEXBot2 with PM2 process management.
 * Handles all setup required before starting bot processes:
 *
 * 1. BitShares Connection
 *    - Waits for BitShares network connection
 *    - Suppresses debug output to keep terminal clean
 *
 * 2. PM2 Installation Check
 *    - Detects local and global PM2 installations
 *    - Prompts to install PM2 if missing
 *
 * 3. Ecosystem Configuration Generation
 *    - Reads bot definitions from profiles/bots.json
 *    - Generates profiles/ecosystem.config.js with absolute paths
 *    - Filters only active bots (active !== false)
 *    - If bot-name provided, filters to only that bot
 *
 * 4. Credential Daemon Startup
 *    - Starts credential daemon if not already running
 *    - Prompts user interactively for master password (once)
 *    - Daemon authenticates and keeps password in RAM
 *    - Bot processes request keys via Unix socket
 *    - Master password never exposed to bot processes
 *
 * 5. PM2 Startup
 *    - Starts configured bots via PM2
 *    - Bots request private keys from credential daemon
 *    - No MASTER_PASSWORD environment variable passed
 *
 * Usage:
 *   node pm2.js              - Full setup and start all active bots
 *   node pm2.js <bot-name>   - Start only the specified bot via PM2
 *   node dexbot.js pm2       - Same as 'node pm2.js' via CLI
 *   npm run pm2:unlock-start - Same as 'node pm2.js' via npm script
 *
 * Security:
 *   - Master password never in environment variables
 *   - Master password kept only in daemon process
 *   - Unix socket communication (not exposed in process env)
 *   - Each bot authenticates via socket request
 *   - Password never written to disk
 *
 * Output:
 *   - Clean startup messages (BitShares connection status)
 *   - Ecosystem generation confirmation
 *   - Active bot count
 *   - Daemon startup confirmation
 *   - PM2 management commands reference
 */

const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const { promisify } = require('util');
const { parseJsonWithComments } = require('./modules/account_bots');
const { readBotsFileSync, readBotsFileWithLock } = require('./modules/bots_file_lock');
const { setupGracefulShutdown } = require('./modules/graceful_shutdown');
const { UPDATER } = require('./modules/constants');

// Setup graceful shutdown handlers
setupGracefulShutdown();

const execAsync = promisify(exec);

const ROOT = __dirname;
const PROFILES_DIR = path.join(ROOT, 'profiles');
const BOTS_JSON = path.join(PROFILES_DIR, 'bots.json');
const ECOSYSTEM_FILE = path.join(PROFILES_DIR, 'ecosystem.config.js');
const LOGS_DIR = path.join(PROFILES_DIR, 'logs');

/**
 * Generate ecosystem.config.js from bots.json.
 * @param {string|null} [botNameFilter=null] - Optional bot name to filter by.
 * @returns {Array<Object>} The generated app configurations.
 * @throws {Error} If configuration loading fails.
 */
function generateEcosystemConfig(botNameFilter = null) {
    if (!fs.existsSync(BOTS_JSON)) {
        console.error('profiles/bots.json not found. Run: npm run bootstrap:profiles');
        process.exit(1);
    }

    // Ensure logs directory exists
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    try {
        const { config } = readBotsFileSync(BOTS_JSON, parseJsonWithComments);
        let bots = (config.bots || []).filter(b => b.active !== false);

        // Filter to specific bot if name provided
        if (botNameFilter) {
            bots = bots.filter(b => b.name === botNameFilter);
            if (bots.length === 0) {
                console.error(`Bot '${botNameFilter}' not found or not active in profiles/bots.json`);
                process.exit(1);
            }
        } else if (bots.length === 0) {
            console.error('No active bots found in profiles/bots.json');
            process.exit(1);
        }

        const apps = bots.map((bot, index) => {
            const botName = bot.name || `bot-${index}`;
            return {
                name: botName,
                script: path.join(ROOT, 'bot.js'),
                args: botName,
                cwd: ROOT,
                max_memory_restart: '250M',
                watch: false,
                autorestart: true,
                error_file: path.join(LOGS_DIR, `${botName}-error.log`),
                out_file: path.join(LOGS_DIR, `${botName}.log`),
                log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
                merge_logs: false,
                combine_logs: true,
                max_restarts: 13,
                min_uptime: 86400000,
                restart_delay: 3000
            };
        });

        // Add credential daemon as a managed service
        apps.unshift({
            name: 'credential-daemon',
            script: path.join(ROOT, 'credential-daemon.js'),
            cwd: ROOT,
            autorestart: true,
            max_memory_restart: '100M',
            error_file: path.join(LOGS_DIR, 'credential-daemon-error.log'),
            out_file: path.join(LOGS_DIR, 'credential-daemon.log'),
            log_date_format: 'YY-MM-DD HH:mm:ss.SSS'
        });

        // Add weekly updater (if active and not filtering for a specific bot)
        if (!botNameFilter && UPDATER.ACTIVE) {
            apps.push({
                name: "updater",
                script: path.join(ROOT, 'scripts', 'update.js'),
                cwd: ROOT,
                autorestart: false,
                cron_restart: UPDATER.SCHEDULE,
                error_file: path.join(LOGS_DIR, `updater-error.log`),
                out_file: path.join(LOGS_DIR, `updater.log`),
                log_date_format: "YY-MM-DD HH:mm:ss.SSS"
            });
        }

        const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: node pm2.js or node dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

        fs.writeFileSync(ECOSYSTEM_FILE, ecosystemContent);
        console.log(`Ecosystem configuration generated`);
        return apps;
    } catch (err) {
        console.error('Error reading bots.json:', err.message);
        process.exit(1);
    }
}

/**
 * Authenticate master password without waiting for connection.
 * @returns {Promise<string>} The authenticated master password.
 * @throws {Error} If authentication fails or no password is set.
 */
async function authenticateWithoutWait() {
    const chainKeys = require('./modules/chain_keys');

    try {
        const password = await chainKeys.authenticate();
        console.log('Master password authenticated');
        return password;
    } catch (err) {
        if (err.message && err.message.includes('No master password set')) {
            console.error('No master password set. Run: node dexbot.js keys');
            process.exit(1);
        }
        throw err;
    }
}

/**
 * Main application entry point for PM2 orchestration.
 * @param {string|null} [botNameFilter=null] - Optional bot name to start.
 * @returns {Promise<void>}
 */
async function main(botNameFilter = null) {
    console.log('='.repeat(50));
    console.log('DEXBot2 PM2 Launcher');
    if (botNameFilter) {
        console.log(`Starting bot: ${botNameFilter}`);
    }
    console.log('='.repeat(50));
    console.log();

     // Step 0: Wait for BitShares connection (suppress BitShares client logs)
     const { waitForConnected } = require('./modules/bitshares_client');
     const chainKeys = require('./modules/chain_keys');
     console.log('Connecting to BitShares...');
 
     // Suppress BitShares console output during connection
     const originalLog = console.log;
     try {
         console.log = (...args) => {
             // Only suppress BitShares-specific messages
             const msg = args.join(' ');
             if (!msg.includes('bitshares_client') && !msg.includes('modules/')) {
                 originalLog(...args);
             }
         };

         await waitForConnected(30000);
     } finally {
         // Always restore console output, even if waitForConnected throws
         console.log = originalLog;
     }
     
     console.log('Connected to BitShares');
     console.log();

    // Step 1: Check PM2
    if (!checkPM2Installed()) {
        console.error('PM2 is not installed');
        await installPM2();
    }

    // Step 2: Generate ecosystem config
    const apps = generateEcosystemConfig(botNameFilter);
    const botCount = apps.filter(a => a.name !== 'updater' && a.name !== 'credential-daemon').length;
    console.log(`Number active bots: ${botCount}`);
    console.log();

    // Step 3: Clean up and authenticate
    // Clean up any stale daemon socket files
    try {
        try { fs.unlinkSync('/tmp/dexbot-cred-daemon.sock'); } catch (e) { }
        try { fs.unlinkSync('/tmp/dexbot-cred-daemon.ready'); } catch (e) { }
    } catch (e) {
        // Socket files already cleaned, that's fine
    }

    // Authenticate password and set in environment for PM2 apps
    console.log('Authenticating master password...');
    try {
        const masterPassword = await chainKeys.authenticate();
        process.env.DAEMON_PASSWORD = masterPassword;
    } catch (error) {
        console.error('\n❌', error.message);
        process.exit(1);
    }
    console.log('✓ Authentication successful\n');

    // Step 4: Start PM2
    console.log('Starting PM2 with all services...');
    await startPM2();

    console.log();
    console.log('='.repeat(50));
    console.log('DEXBot2 started successfully!');
    console.log('='.repeat(50));
    console.log();
}

/**
 * Start PM2 with provided configuration.
 * @returns {Promise<void>}
 */
function startPM2() {
    return new Promise((resolve, reject) => {
        // Use 'pm2 start' to handle both cases:
        // 1. First run (processes don't exist yet) - creates new processes
        // 2. Subsequent runs (processes exist) - restarts existing processes gracefully
        // This prevents duplicate processes while supporting both fresh start and restart scenarios
        const pm2 = spawn('pm2', ['start', ECOSYSTEM_FILE], {
            cwd: ROOT,
            env: process.env,
            stdio: 'inherit',
            detached: false,
            shell: process.platform === 'win32'
        });

        pm2.on('close', code => {
            if (code === 0) {
                // Ensure we disconnect from PM2's file descriptors
                setImmediate(resolve);
            } else {
                reject(new Error(`PM2 exited with code ${code}`));
            }
        });

        pm2.on('error', reject);
    });
}

/**
 * Check if PM2 is installed locally or globally.
 * @returns {boolean} True if PM2 is found.
 */
function checkPM2Installed() {
    try {
        require.resolve('pm2');
        return true;
    } catch (e) {
        // Check if pm2 is available in PATH
        const { execSync } = require('child_process');
        try {
            execSync('pm2 --version', { stdio: 'ignore' });
            return true;
        } catch (err) {
            return false;
        }
    }
}

/**
 * Prompt the user to install PM2 globally.
 * @returns {Promise<void>}
 */
async function installPM2() {
    const readline = require('readline');
    const { spawn } = require('child_process');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve, reject) => {
        rl.question('PM2 is not installed. Install now? (Y/n): ', (answer) => {
            rl.close();

            if (answer.toLowerCase() === 'n') {
                console.log('PM2 installation cancelled. Run: npm install -g pm2');
                process.exit(1);
            }

            console.log('Installing PM2...');
            
            // Helper to run installation command
            const runInstall = (command, args) => {
                return new Promise((res, rej) => {
                    const proc = spawn(command, args, { 
                        stdio: 'inherit', 
                        shell: process.platform === 'win32' 
                    });
                    proc.on('close', (code) => {
                        if (code === 0) res();
                        else rej(code);
                    });
                    proc.on('error', (err) => rej(err));
                });
            };

            // Try standard install first
            runInstall('npm', ['install', '-g', 'pm2'])
                .then(() => {
                    console.log('PM2 installed successfully!');
                    resolve();
                })
                .catch((err) => {
                    // If failed and not on Windows, try sudo
                    if (process.platform !== 'win32') {
                        console.log('\nStandard installation failed (likely permissions). Trying with sudo...');
                        console.log('This covers Linux and macOS. Please enter your password if prompted:');
                        
                        runInstall('sudo', ['npm', 'install', '-g', 'pm2'])
                            .then(() => {
                                console.log('PM2 installed successfully with sudo!');
                                resolve();
                            })
                            .catch((finalErr) => {
                                reject(new Error('PM2 installation failed even with sudo'));
                            });
                    } else {
                        // Windows handling
                        console.log('\nStandard installation failed (likely permissions).');
                        console.log('Attempting to install with Administrator privileges...');
                        console.log('Please accept the UAC dialog to proceed.');

                        // Run npm install in a new elevated window
                        // We use timeout so the user can see the result before window closes
                        const psCommand = "Start-Process cmd -ArgumentList '/c npm install -g pm2 & echo. & echo Installation complete. Closing in 5 seconds... & timeout /t 5' -Verb RunAs -Wait";
                        
                        runInstall('powershell', ['-Command', psCommand])
                            .then(() => {
                                // Verify installation succeeded since we can't easily get the exit code from the elevated process
                                if (checkPM2Installed()) {
                                    console.log('PM2 installed successfully (Elevated)!');
                                    resolve();
                                } else {
                                    reject(new Error('PM2 installation failed or was cancelled in the elevated window.'));
                                }
                            })
                            .catch((winErr) => {
                                console.error('\nFailed to elevate permissions.');
                                console.error('Please manually run "npm install -g pm2" as Administrator.');
                                reject(new Error('PM2 installation failed.'));
                            });
                    }
                });
        });
    });
}

/**
 * Execute a PM2 command safely.
 * @param {string} action - PM2 action (start, stop, etc.).
 * @param {string} [target] - The target process name or configuration file.
 * @returns {Promise<Object>} Command result.
 * @throws {Error} If action is invalid or command fails.
 */
async function execPM2Command(action, target) {
    // Validate action to prevent injection
    const validActions = ['start', 'stop', 'delete', 'restart', 'reload'];
    if (!validActions.includes(action)) {
        throw new Error(`Invalid PM2 action: ${action}`);
    }

    // Use spawn instead of shell to avoid injection vulnerabilities
    // spawn passes arguments as array, preventing shell interpretation
    return new Promise((resolve, reject) => {
        const args = [action];
        if (target) {
            args.push(target);
        }

        const { spawn } = require('child_process');
        const pm2 = spawn('pm2', args, { 
            stdio: 'pipe', 
            shell: process.platform === 'win32' 
        });
        
        let stdout = '';
        let stderr = '';

        pm2.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        pm2.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        pm2.on('close', (code) => {
            if (code === 0) {
                if (stdout) console.log(stdout);
                resolve({ success: true, stdout, stderr });
            } else {
                if (stderr) console.error(stderr);
                reject(new Error(`PM2 command failed with code ${code}: ${stderr || stdout}`));
            }
        });

        pm2.on('error', reject);
    });
}

/**
 * Stop PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or stopping fails.
 */
async function stopPM2Processes(target) {
    // Ensure ecosystem config exists (validates bot configuration)
    if (!fs.existsSync(BOTS_JSON)) {
        throw new Error('profiles/bots.json not found. Run: npm run bootstrap:profiles');
    }

    console.log(`Stopping PM2 processes: ${target}`);

    if (target === 'all') {
        // Regenerate ecosystem config to ensure it's current
        generateEcosystemConfig();
        // Stop all dexbot processes via ecosystem config
        await execPM2Command('stop', ECOSYSTEM_FILE);
        console.log('All dexbot PM2 processes stopped.');
    } else {
        // Validate bot exists in configuration before stopping (with lock protection)
        try {
            const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
            const botExists = config.bots && config.bots.some(b => b.name === target && b.active !== false);
            
            if (!botExists) {
                throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
            }
        } catch (err) {
            throw new Error(`Failed to read bots configuration: ${err.message}`);
        }

        // Stop specific bot by name
        await execPM2Command('stop', target);
        console.log(`PM2 process '${target}' stopped.`);
    }
}

/**
 * Delete PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or deleting fails.
 */
async function deletePM2Processes(target) {
    // Ensure ecosystem config exists (validates bot configuration)
    if (!fs.existsSync(BOTS_JSON)) {
        throw new Error('profiles/bots.json not found. Run: npm run bootstrap:profiles');
    }

    console.log(`Deleting PM2 processes: ${target}`);

    if (target === 'all') {
        // Regenerate ecosystem config to ensure it's current
        generateEcosystemConfig();
        // Delete all dexbot processes via ecosystem config
        await execPM2Command('delete', ECOSYSTEM_FILE);
        console.log('All dexbot PM2 processes deleted.');
    } else {
        // Validate bot exists in configuration before deleting (with lock protection)
        try {
            const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
            const botExists = config.bots && config.bots.some(b => b.name === target && b.active !== false);
            
            if (!botExists) {
                throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
            }
        } catch (err) {
            throw new Error(`Failed to read bots configuration: ${err.message}`);
        }

        // Delete specific bot by name
        await execPM2Command('delete', target);
        console.log(`PM2 process '${target}' deleted.`);
    }

    console.log('Bot configs remain in profiles/bots.json.');
    console.log('Run "node dexbot.js bots" to manage bot configurations.');
}

/**
 * Show help text for PM2 CLI usage.
 */
function showPM2Help() {
    console.log(`
Usage: node pm2.js <command> [target]

Commands:
  unlock-start              Unlock keystore and start all bots with PM2 (default)
  update                    Run the update script immediately
  stop <bot-name|all>       Stop PM2 process(es) - only dexbot processes
  delete <bot-name|all>     Delete PM2 process(es) - only dexbot processes
  help                      Show this help message

Examples:
  node pm2.js                    # Start all bots (unlock + start)
  node pm2.js stop all           # Stop all dexbot processes
  node pm2.js stop XRP-BTS       # Stop specific bot
  node pm2.js delete all         # Delete all dexbot processes from PM2
  node pm2.js delete XRP-BTS     # Delete specific bot from PM2
  node pm2.js help               # Show help
    `);
}

// Run if called directly
if (require.main === module) {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const command = args[0] || 'unlock-start';
    const target = args[1];

    (async () => {
        try {
            if (command === 'unlock-start') {
                // Full setup: unlock, generate config, authenticate, start PM2
                // Optional: filter to specific bot if provided
                await main(target || null);
                // Close stdin to prevent hanging
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } else if (command === 'update') {
                const { spawn } = require('child_process');
                const update = spawn('node', [path.join(ROOT, 'scripts', 'update.js')], { stdio: 'inherit' });
                update.on('close', code => process.exit(code));
            } else if (command === 'stop') {
                if (!target) {
                    console.error('Error: Target required. Specify bot name or "all".');
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await stopPM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(`Failed to stop processes: ${err.message}`);
                    process.exit(1);
                }
            } else if (command === 'delete') {
                if (!target) {
                    console.error('Error: Target required. Specify bot name or "all".');
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await deletePM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(`Failed to delete processes: ${err.message}`);
                    process.exit(1);
                }
            } else if (command === 'help') {
                showPM2Help();
                process.exit(0);
            } else {
                console.error(`Unknown command: ${command}`);
                showPM2Help();
                process.exit(1);
            }
        } catch (err) {
            console.error('Error:', err.message);
            process.exit(1);
        }
    })();
}

module.exports = { main, generateEcosystemConfig, authenticateWithoutWait };
