'use strict';

import { PATHS } from './paths.js';
import { Config } from './config.js';
import { getStorage } from './storage/index.js';
import { getErrorMessage } from './utils/errors.js';

const storage = getStorage();
const { readJSON } = storage;

// Resolved per read (not at module load) so test overrides via the
// DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE config value take effect on
// modules that are already loaded.
function whitelistFile(): string {
    return Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE || PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();
}

interface WhitelistFlags {
    ama: boolean;
    dynamicWeight: boolean;
    asymmetricBounds: boolean;
}

let _whitelistCache: Map<string, WhitelistFlags> | false | null = null;

function resetMarketAdapterWhitelistCache(): void {
    _whitelistCache = null;
}

function normalizeEntry(entry: any): WhitelistFlags {
    if (entry === true) {
        return { ama: true, dynamicWeight: true, asymmetricBounds: true };
    }
    if (!entry || typeof entry !== 'object') {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return {
        ama: entry.ama === true,
        dynamicWeight: entry.dynamicWeight === true,
        asymmetricBounds: entry.asymmetricBounds === true,
    };
}

function loadMarketAdapterWhitelist(): Map<string, WhitelistFlags> | false {
    if (_whitelistCache !== null) return _whitelistCache;
    if (!storage.exists(whitelistFile())) {
        _whitelistCache = false;
        return _whitelistCache;
    }

    try {
        const json = readJSON(whitelistFile());
        const raw = json?.whitelist;
        const map = new Map<string, WhitelistFlags>();

        if (Array.isArray(raw)) {
            for (const botKey of raw) {
                map.set(String(botKey), { ama: true, dynamicWeight: false, asymmetricBounds: false });
            }
        } else if (raw && typeof raw === 'object') {
            for (const [botKey, entry] of Object.entries(raw)) {
                map.set(String(botKey), normalizeEntry(entry));
            }
        }

        _whitelistCache = map;
        return _whitelistCache;
    } catch (_: any) {
        console.warn(`[WARN] Failed to parse ${whitelistFile()}: ${getErrorMessage(_)}. All whitelist features disabled.`);
        _whitelistCache = false;
        return _whitelistCache;
    }
}

function getWhitelistFlags(botKey: string): WhitelistFlags {
    const whitelist = loadMarketAdapterWhitelist();
    if (whitelist === false || !botKey) {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return whitelist.get(String(botKey)) || { ama: false, dynamicWeight: false, asymmetricBounds: false };
}

function isBotWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).ama === true;
}

function isBotDynamicWeightWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).dynamicWeight === true;
}

function isBotAsymmetricBoundsWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).asymmetricBounds === true;
}

/**
 * Reads the whitelist document from disk, normalizing its `whitelist` payload
 * into a plain botKey-keyed object (the legacy array form is upgraded to the
 * object form on the next write).
 * @returns {{ doc: any, entries: Record<string, any> }|null} null when the
 *   file exists but cannot be parsed — callers must abort the write so a
 *   malformed file is never silently replaced by an empty one.
 */
function readWhitelistDocument(): { doc: any; entries: Record<string, any> } | null {
    if (!storage.exists(whitelistFile())) {
        return { doc: {}, entries: {} };
    }
    let json: any;
    try {
        json = readJSON(whitelistFile());
    } catch (err: any) {
        console.warn(`[WARN] Refusing to update malformed ${whitelistFile()}: ${getErrorMessage(err)}. Fix or delete the file first.`);
        return null;
    }
    const raw = json?.whitelist;
    const entries: Record<string, any> = {};
    if (Array.isArray(raw)) {
        for (const botKey of raw) {
            if (botKey) entries[String(botKey)] = { ama: true, dynamicWeight: false, asymmetricBounds: false };
        }
    } else if (raw && typeof raw === 'object') {
        for (const [botKey, entry] of Object.entries(raw)) {
            entries[String(botKey)] = entry;
        }
    }
    const doc = (json && typeof json === 'object' && !Array.isArray(json)) ? json : {};
    return { doc, entries };
}

/**
 * Writes the whitelist document back (sorted keys, same shape the `dexbot
 * white` script produces) and invalidates the in-process read cache.
 * @param {any} doc - Top-level document to preserve (extra keys survive).
 * @param {Record<string, any>} entries - botKey-keyed whitelist entries.
 */
function writeWhitelistDocument(doc: any, entries: Record<string, any>): void {
    doc.whitelist = Object.fromEntries(
        Object.entries(entries).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
    storage.writeJSON(whitelistFile(), doc);
    resetMarketAdapterWhitelistCache();
}

/**
 * Stores the market-adapter flags for a single bot key. This is the bot
 * editor's write-through path for section `6) Adapter` and writes the same
 * file/shape as `dexbot white --bot <key>` (which stays available for bulk
 * regeneration).
 * @param {string} botKey - Whitelist key (sanitized bot name).
 * @param {Partial<WhitelistFlags>} flags - Flags to apply; omitted keys keep
 *   their current value.
 * @returns {boolean} false when nothing was written (empty key or malformed file).
 */
function setWhitelistFlags(botKey: string, flags: Partial<WhitelistFlags>): boolean {
    const key = String(botKey ?? '').trim();
    if (!key) return false;
    const loaded = readWhitelistDocument();
    if (!loaded) return false;
    const current = normalizeEntry(loaded.entries[key]);
    const pick = (next: boolean | undefined, fallback: boolean) => next === undefined ? fallback : next === true;
    loaded.entries[key] = {
        ama: pick(flags.ama, current.ama),
        dynamicWeight: pick(flags.dynamicWeight, current.dynamicWeight),
        asymmetricBounds: pick(flags.asymmetricBounds, current.asymmetricBounds),
    };
    writeWhitelistDocument(loaded.doc, loaded.entries);
    return true;
}

/**
 * Moves a whitelist entry to a new key (bot renamed in the editor). The
 * entry value is carried over unchanged (legacy array-form entries were
 * already normalized to the object form on read).
 * @param {string} oldKey - Key derived from the previous bot name.
 * @param {string} newKey - Key derived from the new bot name.
 * @returns {boolean} true when the move happened or was a no-op; false when
 *   it was refused — the target key is occupied (checked even when there is
 *   no source entry, so callers never follow up by overwriting the occupant)
 *   or the file is unreadable. On refusal the surviving entry wins so the
 *   other bot's flags are never lost.
 */
function renameWhitelistEntry(oldKey: string, newKey: string): boolean {
    const from = String(oldKey ?? '').trim();
    const to = String(newKey ?? '').trim();
    if (!from || !to || from === to) return true;
    const loaded = readWhitelistDocument();
    if (!loaded) return false;
    if (to in loaded.entries) {
        console.warn(`[WARN] Whitelist entry '${to}' already exists; keeping it and leaving '${from}' in place (clean up with 'dexbot white --prune').`);
        return false;
    }
    if (!(from in loaded.entries)) return true;
    loaded.entries[to] = loaded.entries[from];
    delete loaded.entries[from];
    writeWhitelistDocument(loaded.doc, loaded.entries);
    return true;
}

export { whitelistFile, resetMarketAdapterWhitelistCache, getWhitelistFlags, isBotWhitelisted, isBotDynamicWeightWhitelisted, isBotAsymmetricBoundsWhitelisted, setWhitelistFlags, renameWhitelistEntry }

