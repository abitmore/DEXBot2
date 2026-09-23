/**
 * Central bot-defaults seeder — the single place that knows how
 * `DEFAULT_CONFIG` values are applied to bot data. Three modes:
 *
 *  * seedBotDraft          — `normalizeBotDraft` (editor new/edit seed): fills
 *                            every DEFAULT_CONFIG key except the excluded
 *                            pair/funds keys; preserves nulls and partial
 *                            objects so already-seeded entries stay byte-stable.
 *  * seedBotEntry          — `normalizeBotEntry` (runtime load): only the
 *                            `active` default; validation relies on most keys
 *                            being ABSENT, so entry seeding stays minimal.
 *  * seedBotRuntimeConfig  — `OrderManager` config: fills absent DEFAULT_CONFIG
 *                            keys with deep clones (never aliases the global
 *                            default) and passes provided values through
 *                            verbatim with `{ ...DEFAULT_CONFIG, ...config }`
 *                            semantics (key order included).
 *
 * Mode rules are pinned by tests/test_bot_defaults_characterization.ts and
 * tests/test_bot_defaults_parity.ts — update them together with this file.
 */

import { DEFAULT_CONFIG } from './constants.js';

export interface SeedOptions {
    /** Defaults source; omit to use the merged DEFAULT_CONFIG. */
    defaults?: Record<string, any>;
}

/**
 * DEFAULT_CONFIG keys the draft seed must NEVER add. Seeding these would change
 * persisted bots.json bytes for existing bots and pre-satisfy
 * `validateBotEntry`'s required-key check (assetA/assetB), hiding genuine
 * configuration mistakes from the validator.
 */
export const DRAFT_EXCLUDED_KEYS = ['assetA', 'assetB', 'creditOnly', 'min_BTS_value'];

/**
 * Draft seed order — kept identical to the historical if-chain so a freshly
 * created bot's JSON key order does not change. Together with
 * DRAFT_EXCLUDED_KEYS this must cover EVERY DEFAULT_CONFIG key; the parity test
 * fails when a new DEFAULT_CONFIG key is added without classifying it here.
 */
export const DRAFT_SEED_ORDER = [
    'weightDistribution', 'botFunds', 'activeOrders', 'reserveOrders',
    'active', 'dryRun', 'minPrice', 'maxPrice', 'incrementPercent',
    'targetSpreadPercent', 'startPrice', 'gridPrice',
];

/** Fields with no meaning since the grid-price offset was removed; stripped from drafts. */
export const LEGACY_DRAFT_KEYS = ['gridPriceOffsetPct', 'gridPriceOffsetClampToBounds'];

function clone<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
}

/** Numbers migrate to `{ buy, sell: 0 }` (floored, clamped at 0); anything
 *  that is not a plain object becomes the default; plain objects — including
 *  partial ones — are kept verbatim. */
function seedReserveOrders(value: any, def: any): any {
    if (typeof value === 'number') {
        return { buy: Math.max(0, Math.floor(value)), sell: 0 };
    }
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
        return clone(def);
    }
    return value;
}

/**
 * Editor draft seed (formerly the `normalizeBotDraft` if-chain in
 * modules/account_bots.ts). Deep-clones the input, then applies defaults:
 *
 *  * count objects (`weightDistribution`/`botFunds`/`activeOrders`): falsy
 *    input → default clone; truthy input (including partials) kept verbatim —
 *    never deep-filled;
 *  * `reserveOrders`: number migration / invalid → default (see seedReserveOrders);
 *  * `startPrice`: undefined → `default || 'pool'` (falsy defaults fall back);
 *  * `gridPrice`: undefined → `default ?? null` (Phase 2: was a hardcoded null
 *    that ignored DEFAULT_CONFIG.gridPrice overrides);
 *  * other scalars: filled only when `=== undefined` — explicit nulls survive.
 */
export function seedBotDraft(base?: Record<string, any> | null, options: SeedOptions = {}): Record<string, any> {
    const defaults: Record<string, any> = options.defaults ?? DEFAULT_CONFIG;
    const data: Record<string, any> = JSON.parse(JSON.stringify(base ?? {}));
    for (const key of DRAFT_SEED_ORDER) {
        const def = defaults[key];
        if (key === 'reserveOrders') {
            data.reserveOrders = seedReserveOrders(data.reserveOrders, def);
        } else if (key === 'startPrice') {
            if (data.startPrice === undefined) data.startPrice = def || 'pool';
        } else if (key === 'gridPrice') {
            if (data.gridPrice === undefined) data.gridPrice = def ?? null;
        } else if (def !== null && typeof def === 'object') {
            if (!data[key]) data[key] = clone(def);
        } else if (data[key] === undefined) {
            data[key] = def;
        }
    }
    for (const key of LEGACY_DRAFT_KEYS) delete data[key];
    return data;
}

/**
 * Runtime entry default (formerly duplicated in `modules/bot_settings.ts` and
 * `claw/modules/dexbot_profiles.ts`). Only `active` is defaulted:
 *
 *  * missing/undefined → DEFAULT_CONFIG.active (the historical copy hardcoded
 *    `true`; sourcing it makes a DEFAULT_CONFIG.active override take effect);
 *  * present values pass through RAW — the spread deliberately wins, matching
 *    the `active !== false` convention used by every consumer (a present
 *    `null`/`0` stays `null`/`0` and classifies as active).
 *
 * No other DEFAULT_CONFIG key may be seeded here: `validateBotEntry` treats
 * missing keys as mistakes (assetA/assetB must be genuinely absent when
 * unconfigured).
 */
export function seedBotEntry<T extends Record<string, any>>(entry: T, options: SeedOptions = {}): T {
    const defaults: Record<string, any> = options.defaults ?? DEFAULT_CONFIG;
    return { active: entry.active === undefined ? defaults.active : entry.active, ...entry } as T;
}

/**
 * Runtime config seed (formerly `{ ...DEFAULT_CONFIG, ...config }` in the
 * OrderManager constructor). Produces exactly the spread result — same key
 * order, provided values passed through by reference, explicit-undefined
 * values winning — except that ABSENT defaults are deep CLONES, so mutating
 * `manager.config.botFunds` can no longer corrupt the global DEFAULT_CONFIG
 * (the historical shallow spread aliased every nested default object).
 */
export function seedBotRuntimeConfig(config: Record<string, any> = {}, options: SeedOptions = {}): Record<string, any> {
    const defaults: Record<string, any> = options.defaults ?? DEFAULT_CONFIG;
    const configKeys = new Set(Object.keys(config));
    const out: Record<string, any> = {};
    for (const key of Object.keys(defaults)) {
        out[key] = configKeys.has(key) ? config[key] : clone(defaults[key]);
    }
    for (const key of configKeys) {
        if (!(key in out)) out[key] = config[key];
    }
    return out;
}
