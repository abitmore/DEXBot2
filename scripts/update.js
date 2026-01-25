#!/usr/bin/env node
/**
 * update.js - Cross-platform update script for DEXBot2
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
// Import hardcoded repo and default settings from constants
const { UPDATER } = require('../modules/constants');

function log(msg) {
    console.log(`[${new Date().toISOString()}] [UPDATE] ${msg}`);
}

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
    process.chdir(ROOT);
    log('Starting DEXBot2 update process...');

    const repoUrl = UPDATER.REPOSITORY_URL;
    let branch = UPDATER.BRANCH;

    // Step 1: Check git
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
        throw new Error('Not a git repository. Manual update required.');
    }

    // Step 2: Fetch and Check for updates
    log('Checking for updates...');
    
    let currentBranch;
    try {
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {
        currentBranch = 'unknown';
    }

    // Handle Branch policy for detection
    if (branch === 'auto') {
        if (currentBranch === 'HEAD' || currentBranch === 'unknown') {
            branch = 'main';
            log(`Could not detect current branch, defaulting to: ${branch}`);
        } else {
            branch = currentBranch;
            log(`Detected current branch: ${branch}`);
        }
    }

    // Ensure remote is correct (Hardcoded in constants.js)
    try {
        const currentRemote = execSync('git remote get-url origin').toString().trim();
        if (currentRemote !== repoUrl) {
            log(`Updating origin URL to: ${repoUrl}`);
            run(`git remote set-url origin ${repoUrl}`);
        }
    } catch (e) {
        log(`Adding origin remote: ${repoUrl}`);
        run(`git remote add origin ${repoUrl}`);
    }

    run(`git fetch origin ${branch}`);
    
    const localHash = execSync('git rev-parse HEAD').toString().trim();
    const remoteHash = execSync(`git rev-parse origin/${branch}`).toString().trim();
    
    // Check for incoming updates: commits that are in origin/branch but NOT in HEAD
    const incomingCommits = parseInt(execSync(`git rev-list --count HEAD..origin/${branch}`).toString().trim(), 10);
    const updatesAvailable = incomingCommits > 0;
    const branchSwitchNeeded = currentBranch !== branch;

    // Logic:
    // 1. If code is exactly identical (hashes match) -> Switch branch if needed, then exit.
    // 2. If local is AHEAD of remote (updatesAvailable=false but hashes differ) -> Switch branch if needed, then exit.
    // 3. If there are INCOMING commits (updatesAvailable=true) -> Proceed with update and reload.

    if (!updatesAvailable) {
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

    // Step 3: Prepare working directory
    log('Cleaning working directory...');
    run('git reset --hard');
    run('git clean -fd');

    // Step 4: Pull changes / Switch branch
    if (currentBranch !== branch) {
        log(`Switching to branch: ${branch}...`);
        run(`git checkout ${branch}`);
    }
    log(`Pulling latest changes from ${repoUrl} (branch: ${branch})...`);
    run(`git pull --rebase origin ${branch}`);

    // Step 5: Update dependencies
    log('Updating dependencies...');
    run('npm install --prefer-offline');

    // Step 6: Reload PM2
    log('Reloading active bots in PM2...');
    try {
        const BOTS_FILE = path.join(ROOT, 'profiles', 'bots.json');
        if (fs.existsSync(BOTS_FILE)) {
            const raw = fs.readFileSync(BOTS_FILE, 'utf8');
            const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
            const config = JSON.parse(stripped);
            const activeInConfig = (config.bots || [])
                .filter(b => b.active !== false)
                .map(b => b.name)
                .filter(name => !!name);

            if (activeInConfig.length > 0) {
                // Get list of actually running PM2 processes
                let runningProcesses = [];
                try {
                    const output = execSync('pm2 jlist').toString().trim();
                    // Find the start of the JSON array
                    const jsonStart = output.indexOf('[');
                    if (jsonStart !== -1) {
                        const jsonPart = output.substring(jsonStart);
                        const parsed = JSON.parse(jsonPart);
                        runningProcesses = parsed.map(p => p.name);
                    } else {
                        log('Warning: PM2 jlist output did not contain JSON array.');
                    }
                } catch (e) {
                    log('Warning: Could not fetch PM2 process list. Falling back to config-only detection.');
                    runningProcesses = activeInConfig; // Fallback
                }

                const botsToReload = activeInConfig.filter(name => runningProcesses.includes(name));

                if (botsToReload.length > 0) {
                    log(`Active bots detected: ${botsToReload.join(', ')}`);
                    for (const name of botsToReload) {
                        try {
                            run(`pm2 reload "${name}"`);
                        } catch (e) {
                            log(`Warning: Failed to reload bot "${name}" (it might not be running).`);
                        }
                    }
                } else {
                    log('No active bots currently running in PM2. Skipping reload.');
                }
            } else {
                log('No active bots found in config.');
            }
        } else {
            log('Warning: profiles/bots.json not found, skipping selective reload.');
            run('pm2 reload all');
        }
    } catch (err) {
        log(`Warning: PM2 reload logic failed (${err.message}). Falling back to reload all.`);
        try { run('pm2 reload all'); } catch (e) {}
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
