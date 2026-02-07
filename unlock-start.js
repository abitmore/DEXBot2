#!/usr/bin/env node

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

function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
    });
}

function removeStaleDaemonFiles() {
    if (chainKeys.isDaemonReady()) return;
    try { fs.unlinkSync(SOCKET_PATH); } catch (err) { }
    try { fs.unlinkSync(READY_FILE); } catch (err) { }
}

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

function forwardSignal(child, signal) {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch (err) {
    }
}

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
