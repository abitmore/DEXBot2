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

    // Step 2: Prepare working directory
    log('Cleaning working directory...');
    run('git reset --hard');
    run('git clean -fd');

    // Step 3: Handle Branch policy
    if (branch === 'auto') {
        try {
            branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
            log(`Detected current branch: ${branch}`);
        } catch (e) {
            branch = 'main';
            log('Warning: Could not detect current branch, defaulting to main.');
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

    // Step 4: Pull changes
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
            const activeBots = (config.bots || [])
                .filter(b => b.active !== false)
                .map(b => b.name)
                .filter(name => !!name);

            if (activeBots.length > 0) {
                log(`Active bots detected: ${activeBots.join(', ')}`);
                for (const name of activeBots) {
                    try {
                        run(`pm2 reload "${name}"`);
                    } catch (e) {
                        log(`Warning: Failed to reload bot "${name}" (it might not be running).`);
                    }
                }
            } else {
                log('No active bots found to reload.');
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
} catch (err) {
    console.error('==========================================');
    console.error('UPDATE FAILED');
    console.error('Error:', err.message);
    console.error('==========================================');
    process.exit(1);
}
