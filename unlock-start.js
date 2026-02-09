#!/usr/bin/env node

/**
 * unlock-start.js - Credential Daemon Launcher
 * 
 * Starts credential daemon with master password and launches bot process.
 * Ensures daemon is ready before starting bot, and handles graceful shutdown.
 * 
 * Usage:
 *   node unlock-start.js [botName]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chainKeys = require('./modules/chain_keys');

const ROOT = __dirname;
const SOCKET_PATH = '/tmp/dexbot-cred-daemon.sock';
const READY_FILE = '/tmp/dexbot-cred-daemon.ready';

let daemonProcess = null;
let startedDaemon = false;
let shuttingDown = false;

/**
 * Wait for child process to exit.
 * 
 * @param {ChildProcess} child - Child process to wait for
 * @returns {Promise<number>} Exit code
 */
function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
    });
}

/**
 * Remove stale daemon socket and ready files if daemon not active.
 * Prevents connection attempts to dead daemon processes.
 * 
 * @private
 */
function removeStaleDaemonFiles() {
    if (chainKeys.isDaemonReady()) return;
    try { fs.unlinkSync(SOCKET_PATH); } catch (err) { }
    try { fs.unlinkSync(READY_FILE); } catch (err) { }
}

/**
 * Ensure credential daemon is running.
 * If not active, prompts for master password and starts daemon in background.
 * Waits for daemon to signal readiness.
 * 
 * @returns {Promise<void>}
 */
async function ensureCredentialDaemon() {
    if (chainKeys.isDaemonReady()) {
        console.log('Credential daemon already running. Reusing existing daemon session.');
        return;
    }

    removeStaleDaemonFiles();

    console.log('Unlocking credential daemon...');
    const masterPassword = await chainKeys.authenticate();

    daemonProcess = spawn(process.execPath, [path.join(ROOT, 'credential-daemon.js')], {
        cwd: ROOT,
        env: { ...process.env, DAEMON_PASSWORD: masterPassword },
        stdio: 'inherit',
    });
    startedDaemon = true;

    await chainKeys.waitForDaemon();
    console.log('Credential daemon is ready.');
}

/**
 * Forward signal to child process if still alive.
 * Used for graceful shutdown (SIGTERM).
 * 
 * @private
 * @param {ChildProcess} child - Child process
 * @param {string} signal - Signal to send (e.g., "SIGTERM")
 */
function forwardSignal(child, signal) {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch (err) {
    }
}

/**
 * Stop the managed credential daemon if started by this process.
 * Sends SIGTERM and waits with timeout, then cleans up socket files.
 * 
 * @private
 * @returns {Promise<void>}
 */
async function stopManagedDaemon() {
    if (!startedDaemon || !daemonProcess || daemonProcess.killed) return;

    forwardSignal(daemonProcess, 'SIGTERM');
    await Promise.race([
        waitForExit(daemonProcess),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    try { fs.unlinkSync(SOCKET_PATH); } catch (err) { }
    try { fs.unlinkSync(READY_FILE); } catch (err) { }
}

/**
 * Main entry point.
 * Starts daemon, then launches bot process with stdio inheritance.
 * Forwards SIGINT/SIGTERM to bot, and cleans up daemon on exit.
 * 
 * @private
 * @returns {Promise<void>}
 */
async function main() {
    const botName = process.argv[2] || null;

    await ensureCredentialDaemon();

    const dexbotArgs = ['dexbot.js', 'start'];
    if (botName) dexbotArgs.push(botName);

    const botProcess = spawn(process.execPath, dexbotArgs, {
        cwd: ROOT,
        env: process.env,
        stdio: 'inherit',
    });

    process.on('SIGINT', () => forwardSignal(botProcess, 'SIGINT'));
    process.on('SIGTERM', () => forwardSignal(botProcess, 'SIGTERM'));

    const exitCode = await waitForExit(botProcess);
    process.exitCode = exitCode || 0;
}

(async () => {
    try {
        await main();
    } catch (err) {
        console.error('unlock-start failed:', err.message || err);
        process.exitCode = 1;
    } finally {
        if (!shuttingDown) {
            shuttingDown = true;
            await stopManagedDaemon();
        }
    }
})();
