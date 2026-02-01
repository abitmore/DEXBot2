#!/usr/bin/env node

/**
 * DEXBot2 Auto-Update Script
 *
 * Manages pulling latest code from git repository with smart logic:
 * - Fetches from configured remote repository
 * - Detects if updates are available
 * - Handles branch switching if needed
 * - Reinstalls npm dependencies
 * - Selectively reloads active PM2 processes
 * - Gracefully handles missing files or PM2
 *
 * Configuration:
 * - Repository URL: Hardcoded in modules/constants.js (UPDATER.REPOSITORY_URL)
 * - Target branch: Configurable in constants.js (UPDATER.BRANCH), supports 'auto' for auto-detection
 *
 * Exit codes:
 * - 0: Update completed successfully (or already up-to-date)
 * - 1: Update failed (with error details printed)
 *
 * Usage: node scripts/update.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Project root directory (parent of scripts folder)
const ROOT = path.join(__dirname, '..');

// Import update configuration from constants
// Contains: REPOSITORY_URL, BRANCH settings
const { UPDATER } = require('../modules/constants');

/**
 * log: Output timestamped update log message
 *
 * Formats: [ISO_TIMESTAMP] [UPDATE] message
 *
 * @param {string} msg - Message to log
 */
function log(msg) {
    console.log(`[${new Date().toISOString()}] [UPDATE] ${msg}`);
}

/**
 * run: Execute shell command with error handling
 *
 * Runs command with inherited stdio so user sees full output.
 * Throws error if command fails, breaking update process.
 *
 * @param {string} cmd - Shell command to execute
 * @throws {Error} If command exits with non-zero status
 */
function run(cmd) {
    log(`Executing: ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    } catch (err) {
        console.error(`[ERROR] Command failed: ${cmd}`);
        throw err;
    }
}

try {
    // Change to project root for all git operations
    process.chdir(ROOT);
    log('Starting DEXBot2 update process...');

    // Get configured repository URL and target branch
    const repoUrl = UPDATER.REPOSITORY_URL;
    let branch = UPDATER.BRANCH;

    /**
     * STEP 1: Validate Git Repository
     * Ensures .git directory exists so we can perform git operations
     */
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
        throw new Error('Not a git repository. Manual update required.');
    }

    /**
     * STEP 2: Detect Current Branch
     * Gets the current checked-out branch name
     */
    log('Checking for updates...');

    let currentBranch;
    try {
        // Get detached/attached branch name
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {
        // Fallback if command fails
        currentBranch = 'unknown';
    }

    /**
     * STEP 3: Handle Branch Auto-Detection
     * If UPDATER.BRANCH is 'auto', detect or default to 'main'
     * Otherwise use the configured branch name
     */
    if (branch === 'auto') {
        if (currentBranch === 'HEAD' || currentBranch === 'unknown') {
            // Detached HEAD or unknown state - default to main
            branch = 'main';
            log(`Could not detect current branch, defaulting to: ${branch}`);
        } else {
            // Auto-detect: use current branch
            branch = currentBranch;
            log(`Detected current branch: ${branch}`);
        }
    }

    /**
     * STEP 4: Verify/Fix Remote Configuration
     * Ensures origin points to the correct repository URL
     * Updates URL if it differs, or adds origin remote if missing
     */
    try {
        const currentRemote = execSync('git remote get-url origin').toString().trim();
        if (currentRemote !== repoUrl) {
            log(`Updating origin URL to: ${repoUrl}`);
            run(`git remote set-url origin ${repoUrl}`);
        }
    } catch (e) {
        // Remote doesn't exist, add it
        log(`Adding origin remote: ${repoUrl}`);
        run(`git remote add origin ${repoUrl}`);
    }

    /**
     * STEP 5: Check for Available Updates
     * Fetches remote branch metadata and compares with local
     */
    run(`git fetch origin ${branch}`);

    // Get current commit hashes for comparison
    const localHash = execSync('git rev-parse HEAD').toString().trim();
    const remoteHash = execSync(`git rev-parse origin/${branch}`).toString().trim();

    /**
     * Check for incoming commits
     * git rev-list --count HEAD..origin/branch = commits that exist remotely but not locally
     * This is the core check: if > 0, updates are available
     */
    const incomingCommits = parseInt(execSync(`git rev-list --count HEAD..origin/${branch}`).toString().trim(), 10);
    const updatesAvailable = incomingCommits > 0;
    const branchSwitchNeeded = currentBranch !== branch;

    /**
     * Decision Logic for Update Flow
     *
     * Three scenarios are possible:
     * 1. NO incoming updates (updatesAvailable = false)
     *    - Local is either equal to or ahead of remote
     *    - Action: Switch branch if needed, then exit cleanly
     * 2. Incoming updates available (updatesAvailable = true)
     *    - Remote has new commits we need to pull
     *    - Action: Proceed with full update (pull, npm install, reload PM2)
     */
    if (!updatesAvailable) {
        // No updates available - check if branch switch is needed
        if (branchSwitchNeeded) {
            log(`Aligning branch reference: ${currentBranch} -> ${branch} (no incoming updates).`);
            run(`git checkout ${branch}`);
            log('DEXBot2 is now tracking the correct branch.');
        }
        log('DEXBot2 is already up to date (local is equal or ahead of remote).');
        process.exit(0);
    }

    log(`${incomingCommits} update(s) available. Proceeding with update process...`);

    // List changes
    console.log('\n----------------------------------------------------------------');
    console.log('Incoming Changes:');
    try {
        execSync(`git log --oneline --graph --decorate HEAD..origin/${branch}`, { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
        log('Warning: Could not list changes.');
    }
    console.log('----------------------------------------------------------------\n');

    /**
     * STEP 3: Prepare Working Directory
     * Cleans up any uncommitted changes to ensure clean pull
     * git reset --hard: Discards all local modifications
     * git clean -fd: Removes untracked files/directories
     */
    log('Cleaning working directory...');
    run('git reset --hard');
    run('git clean -fd');

    /**
     * STEP 4: Pull Latest Code Changes
     * Switches branch if needed, then pulls remote changes
     */
    if (currentBranch !== branch) {
        log(`Switching to branch: ${branch}...`);
        run(`git checkout ${branch}`);
    }
    log(`Pulling latest changes from ${repoUrl} (branch: ${branch})...`);
    // Use --rebase to avoid merge commits and keep clean linear history
    run(`git pull --rebase origin ${branch}`);

    /**
     * STEP 5: Reinstall Dependencies
     * Updates npm packages to versions specified in package-lock.json
     * --prefer-offline: Uses cached packages when possible
     */
    log('Updating dependencies...');
    run('npm install --prefer-offline');

    /**
     * STEP 6: Reload Active PM2 Processes
     * Intelligently reloads only the bots that were active before update
     * This approach:
     * - Preserves PM2 state if not running
     * - Reloads active bots to pick up code changes
     * - Handles missing bots.json gracefully
     * - Falls back to "reload all" if selective reload fails
     */
    log('Reloading active bots in PM2...');
    try {
        const BOTS_FILE = path.join(ROOT, 'profiles', 'bots.json');
        if (fs.existsSync(BOTS_FILE)) {
            // Read and parse bots configuration
            const raw = fs.readFileSync(BOTS_FILE, 'utf8');
            // Strip JSONC comments (/* */ and // style) for JSON parsing
            const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
            const config = JSON.parse(stripped);

            // Extract list of active bots from config
            // Filter: only bots where active !== false (null/undefined defaults to active)
            const activeInConfig = (config.bots || [])
                .filter(b => b.active !== false)
                .map(b => b.name)
                .filter(name => !!name);

            if (activeInConfig.length > 0) {
                /**
                 * Get list of running PM2 processes
                 * pm2 jlist outputs JSON array of process info
                 * Parse and extract process names to compare with active config
                 */
                let runningProcesses = [];
                try {
                    const output = execSync('pm2 jlist').toString().trim();
                    // pm2 jlist may output text before JSON, find [ to locate JSON start
                    const jsonStart = output.indexOf('[');
                    if (jsonStart !== -1) {
                        const jsonPart = output.substring(jsonStart);
                        const parsed = JSON.parse(jsonPart);
                        // Extract just the process names
                        runningProcesses = parsed.map(p => p.name);
                    } else {
                        log('Warning: PM2 jlist output did not contain JSON array.');
                    }
                } catch (e) {
                    // PM2 query failed - fall back to config list
                    log('Warning: Could not fetch PM2 process list. Falling back to config-only detection.');
                    runningProcesses = activeInConfig; // Fallback: assume all config bots are running
                }

                /**
                 * Find intersection of running processes and active config
                 * Only reload bots that are both:
                 * 1. Marked active in config
                 * 2. Actually running in PM2
                 */
                const botsToReload = activeInConfig.filter(name => runningProcesses.includes(name));

                if (botsToReload.length > 0) {
                    log(`Active bots detected: ${botsToReload.join(', ')}`);
                    // Reload each bot individually to pick up code changes
                    for (const name of botsToReload) {
                        try {
                            run(`pm2 reload "${name}"`);
                        } catch (e) {
                            // Individual reload failed - log warning but continue
                            log(`Warning: Failed to reload bot "${name}" (it might not be running).`);
                        }
                    }
                } else {
                    // Config has active bots but none are running
                    log('No active bots currently running in PM2. Skipping reload.');
                }
            } else {
                // Config exists but has no active bots
                log('No active bots found in config.');
            }
        } else {
            // bots.json not found - reload all PM2 apps as fallback
            log('Warning: profiles/bots.json not found, skipping selective reload.');
            run('pm2 reload all');
        }
    } catch (err) {
        // PM2 reload logic itself failed - try reload all as last resort
        log(`Warning: PM2 reload logic failed (${err.message}). Falling back to reload all.`);
        try {
            run('pm2 reload all');
        } catch (e) {
            // Even fallback failed, but this is not critical - update still succeeded
        }
    }


    log('DEXBot2 update completed successfully.');
    process.exit(0);
} catch (err) {
    console.error('==========================================');
    console.error('UPDATE FAILED');
    console.error('Error:', err.message);
    console.error('==========================================');
    process.exit(1);
}
