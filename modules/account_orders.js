/**
 * Account Orders Module - Local persistence for order grid snapshots
 *
 * Per-Bot Architecture:
 * Each bot has its own dedicated file: profiles/orders/{botKey}.json
 * This eliminates race conditions when multiple bots write simultaneously.
 *
 * File structure (per-bot):
 * {
 *   "bots": {
 *     "botkey": {
 *       "meta": { name, assetA, assetB, active, index },
 *       "grid": [ { id, type, state, price, size, orderId }, ... ],
  *       "cacheFunds": { buy: number, sell: number },  // All unallocated funds (fill proceeds + surplus)
  *       "buySideIsDoubled": boolean,
  *       "sellSideIsDoubled": boolean,
  *       "btsFeesOwed": number,
 *       "createdAt": "ISO timestamp",
 *       "lastUpdated": "ISO timestamp"
 *     }
 *   },
 *   "lastUpdated": "ISO timestamp"
 * }
 *
 * The grid snapshot allows the bot to resume from where it left off
 * without regenerating orders, maintaining consistency with on-chain state.
 */
const fs = require('fs');
const path = require('path');
const { ORDER_TYPES, ORDER_STATES } = require('./constants');
const AsyncLock = require('./order/async_lock');

/**
 * Ensures that the directory for the given file path exists.
 * @param {string} filePath - The file path to check.
 * @private
 */
function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Sanitizes a string to be used as a key in storage.
 * @param {string} source - The source string.
 * @returns {string} The sanitized string.
 * @private
 */
function sanitizeKey(source) {
  if (!source) return 'bot';
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';
}

/**
 * Generate a unique key for identifying a bot in storage.
 * Uses bot name or asset pair, sanitized and indexed.
 * @param {Object} bot - Bot configuration
 * @param {number} index - Index in bots array
 * @returns {string} Sanitized key like 'mybot-0' or 'iob-xrp-bts-1'
 */
function createBotKey(bot, index) {
  const identifier = bot && bot.name
    ? bot.name
    : bot && bot.assetA && bot.assetB
      ? `${bot.assetA}/${bot.assetB}`
      : `bot-${index}`;
  return `${sanitizeKey(identifier)}-${index}`;
}

/**
 * Returns the current date and time in ISO format.
 * @returns {string} ISO timestamp.
 * @private
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * AccountOrders class - manages order grid persistence
 * 
 * Provides methods to:
 * - Store and load order grid snapshots
 * - Track bot metadata and state
 * - Calculate asset balances from stored grids
 * 
 * Each bot has its own file: {botkey}.json
 * This eliminates race conditions when multiple bots write simultaneously.
 * 
 * @class
 */
class AccountOrders {
  /**
   * Create an AccountOrders instance.
   * @param {Object} options - Configuration options
   * @param {string} options.botKey - Bot identifier (e.g., 'xrp-bts-0', 'h-bts-1')
   */
  constructor(options = {}) {
    if (!options.botKey) throw new Error("botKey required for AccountOrders");
    this.botKey = options.botKey;

    // Use per-bot file: {botKey}.json
    const ordersDir = path.join(__dirname, '..', 'profiles', 'orders');
    this.profilesPath = path.join(ordersDir, `${this.botKey}.json`);

    // AsyncLock prevents concurrent read-modify-write races on file I/O
    this._persistenceLock = new AsyncLock();

    this._needsBootstrapSave = !fs.existsSync(this.profilesPath);
    this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    if (this._needsBootstrapSave) {
      this._persist();
    }
  }

  /**
   * Loads the data for the current bot from its profile file.
   * @returns {Object|null} The loaded data or null if not found.
   * @private
   */
  _loadData() {
    // Load the file directly - per-bot files only contain their own bot's data
    return this._readFile(this.profilesPath);
  }

  /**
   * Reads and parses a JSON file.
   * @param {string} filePath - The path to the file.
   * @returns {Object|null} The parsed object or null on failure.
   * @private
   */
  _readFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (err) {
      console.warn('account_orders: failed to read', filePath, '-', err.message);
    }
    return null;
  }

  /**
   * Persists the current data to the profile file.
   * @private
   */
  _persist() {
    ensureDirExists(this.profilesPath);
    fs.writeFileSync(this.profilesPath, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }

  /**
   * Ensure storage entries exist for all provided bot configurations.
   * Creates new entries for unknown bots, updates metadata for existing ones.
   *
   * When in per-bot mode (botKey set): Only processes the matching bot entry and ignores others.
   * When in shared mode (no botKey): Processes all bot entries and prunes stale ones.
   *
   * @param {Array} botEntries - Array of bot configurations from bots.json
   */
  async ensureBotEntries(botEntries = []) {
    if (!Array.isArray(botEntries)) return;

    // Use AsyncLock to serialize with other write operations (storeMasterGrid, updateCacheFunds, etc.)
    // Prevents race conditions during hot-reload or concurrent initialization scenarios
    await this._persistenceLock.acquire(async () => {
      // Reload from disk to ensure we have the latest state
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      const validKeys = new Set();
      let changed = false;

      // Filter to only the matching bot entry
      const entriesToProcess = botEntries.filter(bot => {
        const key = bot.botKey || createBotKey(bot, botEntries.indexOf(bot));
        return key === this.botKey;
      });

      // 1. Update/Create the matching bot entry
      for (const [index, bot] of entriesToProcess.entries()) {
        const key = bot.botKey || createBotKey(bot, index);
        validKeys.add(key);

        let entry = this.data.bots[key];
        const meta = this._buildMeta(bot, key, index, entry && entry.meta);

        if (!entry) {
          entry = {
            meta,
            grid: [],
            cacheFunds: { buy: 0, sell: 0 },
            btsFeesOwed: 0,
            createdAt: meta.createdAt,
            lastUpdated: meta.updatedAt
          };
          this.data.bots[key] = entry;
          changed = true;
        } else {
          // Ensure cacheFunds exists even for existing bots
          if (!entry.cacheFunds || typeof entry.cacheFunds.buy !== 'number') {
            entry.cacheFunds = { buy: 0, sell: 0 };
            changed = true;
          }

          // Ensure btsFeesOwed exists even for existing bots
          if (typeof entry.btsFeesOwed !== 'number') {
            entry.btsFeesOwed = 0;
            changed = true;
          }

          entry.grid = entry.grid || [];
          if (this._metaChanged(entry.meta, meta)) {
            console.log(`[AccountOrders] Metadata changed for bot ${key}: updating from old metadata to new`);
            console.log(`  OLD: name=${entry.meta?.name}, assetA=${entry.meta?.assetA}, assetB=${entry.meta?.assetB}, active=${entry.meta?.active}`);
            console.log(`  NEW: name=${meta.name}, assetA=${meta.assetA}, assetB=${meta.assetB}, active=${meta.active}`);
            entry.meta = { ...entry.meta, ...meta, createdAt: entry.meta?.createdAt || meta.createdAt };
            entry.lastUpdated = nowIso();
            changed = true;
          } else {
            console.log(`[AccountOrders] No metadata change for bot ${key} - skipping update`);
            console.log(`  CURRENT: name=${entry.meta?.name}, assetA=${entry.meta?.assetA}, assetB=${entry.meta?.assetB}, active=${entry.meta?.active}`);
            console.log(`  PASSED:  name=${meta.name}, assetA=${meta.assetA}, assetB=${meta.assetB}, active=${meta.active}`);
          }
        }
        bot.botKey = key;
      }

      // 2. Prune zombie bots (remove entries not in botEntries) - only in shared mode
      if (!this.botKey) {
        for (const key of Object.keys(this.data.bots)) {
          if (!validKeys.has(key)) {
            console.log(`[AccountOrders] Pruning stale bot entry: ${key}`);
            delete this.data.bots[key];
            changed = true;
          }
        }
      }

      if (changed) {
        this.data.lastUpdated = nowIso();
        this._persist();
      }
    });
  }

  /**
   * Checks if metadata has changed between two metadata objects.
   * @param {Object} existing - The existing metadata.
   * @param {Object} next - The new metadata.
   * @returns {boolean} True if metadata has changed.
   * @private
   */
  _metaChanged(existing, next) {
    if (!existing) return true;
    return existing.name !== next.name ||
      existing.assetA !== next.assetA ||
      existing.assetB !== next.assetB ||
      existing.active !== next.active ||
      existing.index !== next.index;
  }

  /**
   * Builds a metadata object for a bot.
   * @param {Object} bot - The bot configuration.
   * @param {string} key - The bot key.
   * @param {number} index - The bot index.
   * @param {Object} [existing={}] - Existing metadata for preserving createdAt.
   * @returns {Object} The metadata object.
   * @private
   */
  _buildMeta(bot, key, index, existing = {}) {
    const timestamp = nowIso();
    return {
      key,
      name: bot.name || null,
      assetA: bot.assetA || null,
      assetB: bot.assetB || null,
      active: !!bot.active,
      index,
      createdAt: existing.createdAt || timestamp,
      updatedAt: timestamp
    };
  }

  /**
   * Save the current order grid snapshot for a bot.
   * Called after grid changes (initialization, fills, syncs).
   *
   * In per-bot mode: Only stores the specified bot's data (ignores other bots in this.data).
   * In shared mode: Stores all bot data.
   *
   * @param {string} botKey - Bot identifier key
   * @param {Array} orders - Array of order objects from OrderManager
  * @param {Object} cacheFunds - Optional cached funds { buy: number, sell: number }
  * @param {number} btsFeesOwed - Optional BTS blockchain fees owed
   * @param {number} boundaryIdx - Optional master boundary index for StrategyEngine
  * @param {Object} assets - Optional asset metadata { assetA, assetB }
  * @param {Object} doubleSideFlags - Optional { buySideIsDoubled, sellSideIsDoubled }
  */
  async storeMasterGrid(botKey, orders = [], cacheFunds = null, btsFeesOwed = null, boundaryIdx = null, assets = null, doubleSideFlags = null) {
    if (!botKey) return;

    // Use AsyncLock to serialize read-modify-write operations (fixes Issue #1, #5)
    // Prevents concurrent calls from overwriting each other's changes
    await this._persistenceLock.acquire(async () => {
      // CRITICAL: Reload from disk before writing to prevent race conditions between bot processes
      // In per-bot mode: loads only this bot's data from its dedicated file
      // In shared mode: loads all bots from the shared file
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      const snapshot = Array.isArray(orders) ? orders.map(order => this._serializeOrder(order)) : [];
      if (!this.data.bots[botKey]) {
        const meta = this._buildMeta({ name: null, assetA: null, assetB: null, active: false }, botKey, null);
        this.data.bots[botKey] = {
          meta,
          grid: snapshot,
          cacheFunds: cacheFunds || { buy: 0, sell: 0 },
          buySideIsDoubled: doubleSideFlags ? !!doubleSideFlags.buySideIsDoubled : false,
          sellSideIsDoubled: doubleSideFlags ? !!doubleSideFlags.sellSideIsDoubled : false,
          btsFeesOwed: Number.isFinite(btsFeesOwed) ? btsFeesOwed : 0,
          boundaryIdx: Number.isFinite(boundaryIdx) ? boundaryIdx : null,
          assets: assets || null,
          processedFills: {},
          createdAt: meta.createdAt,
          lastUpdated: meta.updatedAt
        };
      } else {
        this.data.bots[botKey].grid = snapshot;
        if (cacheFunds) {
          this.data.bots[botKey].cacheFunds = cacheFunds;
        }

        if (doubleSideFlags) {
          this.data.bots[botKey].buySideIsDoubled = !!doubleSideFlags.buySideIsDoubled;
          this.data.bots[botKey].sellSideIsDoubled = !!doubleSideFlags.sellSideIsDoubled;
        }

        if (Number.isFinite(btsFeesOwed)) {
          this.data.bots[botKey].btsFeesOwed = btsFeesOwed;
        }

        if (Number.isFinite(boundaryIdx)) {
          this.data.bots[botKey].boundaryIdx = boundaryIdx;
        }

        if (assets) {
          this.data.bots[botKey].assets = assets;
        }

        // Initialize processedFills if missing (backward compat)
        if (!this.data.bots[botKey].processedFills) {
          this.data.bots[botKey].processedFills = {};
        }

        const timestamp = nowIso();
        this.data.bots[botKey].lastUpdated = timestamp;
        if (this.data.bots[botKey].meta) this.data.bots[botKey].meta.updatedAt = timestamp;
      }
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Load the persisted order grid for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #2)
   * @returns {Array|null} Order grid array or null if not found
   */
  loadBotGrid(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      return botData.grid || null;
    }
    return null;
  }

  /**
   * Load persisted asset metadata for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} Asset metadata { assetA, assetB } or null if not found
   */
  loadPersistedAssets(botKey, forceReload = false) {
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      return this.data.bots[botKey].assets || null;
    }
    return null;
  }

  /**
   * Load cached funds for a bot (difference between available and calculated rotation sizes).
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #2)
   * @returns {Object|null} Cached funds { buy, sell } or null if not found
   */
  loadCacheFunds(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const cf = botData.cacheFunds;
      if (cf && typeof cf.buy === 'number' && typeof cf.sell === 'number') {
        return cf;
      }
    }
    return { buy: 0, sell: 0 };
  }

  /**
   * Load the master boundary index for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {number|null} Boundary index or null if not found
   */
  loadBoundaryIdx(botKey, forceReload = false) {
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const idx = botData.boundaryIdx;
      if (typeof idx === 'number' && Number.isFinite(idx)) {
        return idx;
      }
    }
    return null;
  }

  /**
   * Update cached funds for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {Object} cacheFunds - Cached funds { buy, sell }
   */
  async updateCacheFunds(botKey, cacheFunds) {
    if (!botKey) return;

    // Use AsyncLock to serialize writes and prevent stale data issues (fixes Issue #3)
    // Always reload from disk regardless of mode to ensure latest state
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }
      this.data.bots[botKey].cacheFunds = cacheFunds || { buy: 0, sell: 0 };
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /* `pendingProceeds` storage removed. */

  /**
   * Load BTS blockchain fees owed for a bot.
   * BTS fees accumulate during fill processing and must persist across restarts
   * to ensure they are properly deducted from proceeds during rotation.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #2)
   * @returns {number} BTS fees owed or 0 if not found
   */
  loadBtsFeesOwed(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const fees = botData.btsFeesOwed;
      if (typeof fees === 'number' && Number.isFinite(fees)) {
        return fees;
      }
    }
    return 0;
  }

  /**
   * Update (persist) BTS blockchain fees for a bot.
   * BTS fees are deducted during fill processing and must be tracked across restarts
   * to prevent fund loss if the bot crashes before rotation.
   * @param {string} botKey - Bot identifier key
   * @param {number} btsFeesOwed - BTS blockchain fees owed
   */
  async updateBtsFeesOwed(botKey, btsFeesOwed) {
    if (!botKey) return;

    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }
      this.data.bots[botKey].btsFeesOwed = btsFeesOwed || 0;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Load doubled side flags for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object} { buySideIsDoubled, sellSideIsDoubled }
   */
  loadDoubleSideFlags(botKey, forceReload = false) {
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      return {
        buySideIsDoubled: !!botData.buySideIsDoubled,
        sellSideIsDoubled: !!botData.sellSideIsDoubled
      };
    }
    return { buySideIsDoubled: false, sellSideIsDoubled: false };
  }

  /**
   * Update (persist) doubled side flags for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} buySideIsDoubled - Buy side doubled flag
   * @param {boolean} sellSideIsDoubled - Sell side doubled flag
   */
  async updateDoubleSideFlags(botKey, buySideIsDoubled, sellSideIsDoubled) {
    if (!botKey) return;

    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }
      this.data.bots[botKey].buySideIsDoubled = !!buySideIsDoubled;
      this.data.bots[botKey].sellSideIsDoubled = !!sellSideIsDoubled;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Clear the persisted grid for the bot.
   * @returns {Promise<boolean>} true if cleared successfully
   */
  async clearBotGrid() {
    return await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {} };
      if (this.data.bots[this.botKey]) {
        this.data.bots[this.botKey].grid = [];
        this.data.bots[this.botKey].cacheFunds = { buy: 0, sell: 0 };
        this.data.bots[this.botKey].btsFeesOwed = 0;
        this.data.lastUpdated = nowIso();
        this._persist();
        return true;
      }
      return false;
    });
  }

  /**
   * Load processed fill IDs for a bot to prevent reprocessing fills across restarts.
   * Returns a Map of fillKey => timestamp for fills already processed.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {Map} Map of fillKey => timestamp
   */
  loadProcessedFills(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const fills = botData.processedFills || {};
      // Convert stored object to Map
      const fillMap = new Map(Object.entries(fills));
      return fillMap;
    }
    return new Map();
  }

  /**
   * Add or update a processed fill record (prevents reprocessing same fills).
   * @param {string} botKey - Bot identifier key
   * @param {string} fillKey - Unique fill identifier (e.g., "order_id:block_num:history_id")
   * @param {number} timestamp - Timestamp when fill was processed
   */
  async updateProcessedFills(botKey, fillKey, timestamp) {
    if (!botKey || !fillKey) return;

    // Use AsyncLock to serialize writes
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }

      if (!this.data.bots[botKey].processedFills) {
        this.data.bots[botKey].processedFills = {};
      }

      // Store fill with timestamp
      this.data.bots[botKey].processedFills[fillKey] = timestamp;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Update multiple processed fills at once (more efficient than updating one-by-one).
   * @param {string} botKey - Bot identifier key
   * @param {Map|Object} fills - Map or object of fillKey => timestamp
   */
  async updateProcessedFillsBatch(botKey, fills) {
    if (!botKey || !fills || (fills instanceof Map && fills.size === 0) || (typeof fills === 'object' && Object.keys(fills).length === 0)) {
      return;
    }

    // Use AsyncLock to serialize writes
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }

      if (!this.data.bots[botKey].processedFills) {
        this.data.bots[botKey].processedFills = {};
      }

      // Merge fills
      if (fills instanceof Map) {
        for (const [key, timestamp] of fills) {
          this.data.bots[botKey].processedFills[key] = timestamp;
        }
      } else {
        Object.assign(this.data.bots[botKey].processedFills, fills);
      }

      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Clean up old processed fill records (remove entries older than specified age).
   * Prevents processedFills from growing unbounded over time.
   * @param {string} botKey - Bot identifier key
   * @param {number} olderThanMs - Remove fills processed more than this many milliseconds ago
   */
  async cleanOldProcessedFills(botKey, olderThanMs = 3600000) {
    // Default: 1 hour (3600000ms)
    if (!botKey) return;

    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }

      if (!this.data.bots[botKey].processedFills) {
        return;
      }

      const now = Date.now();
      const fills = this.data.bots[botKey].processedFills;
      let deletedCount = 0;

      for (const [fillKey, timestamp] of Object.entries(fills)) {
        if (now - timestamp > olderThanMs) {
          delete fills[fillKey];
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.data.lastUpdated = nowIso();
        this._persist();
      }
    });
  }

  /**
   * Calculate asset balances from a stored grid.
   * Sums order sizes by asset and state (active vs virtual).
   * @param {string} botKeyOrName - Bot key or name to look up
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #6)
   * @returns {Object|null} Balance summary or null if not found
   */
  getDBAssetBalances(botKeyOrName, forceReload = false) {
    if (!botKeyOrName) return null;

    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    // Find entry by key or by matching meta.name (case-insensitive)
    let key = null;
    if (this.data && this.data.bots) {
      if (this.data.bots[botKeyOrName]) key = botKeyOrName;
      else {
        const lower = String(botKeyOrName).toLowerCase();
        for (const k of Object.keys(this.data.bots)) {
          const meta = this.data.bots[k] && this.data.bots[k].meta;
          if (meta && meta.name && String(meta.name).toLowerCase() === lower) { key = k; break; }
        }
      }
    }
    if (!key) return null;
    const entry = this.data.bots[key];
    if (!entry) return null;
    const meta = entry.meta || {};
    const grid = Array.isArray(entry.grid) ? entry.grid : [];

    const sums = {
      assetA: { active: 0, virtual: 0 },
      assetB: { active: 0, virtual: 0 },
      meta: { key, name: meta.name || null, assetA: meta.assetA || null, assetB: meta.assetB || null }
    };

    for (const o of grid) {
      const size = Number(o && o.size) || 0;
      const state = o && o.state || '';
      const typ = o && o.type || '';

      if (typ === ORDER_TYPES.SELL) {
        if (state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL) sums.assetA.active += size;
        else if (state === ORDER_STATES.VIRTUAL) sums.assetA.virtual += size;
      } else if (typ === ORDER_TYPES.BUY) {
        if (state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL) sums.assetB.active += size;
        else if (state === ORDER_STATES.VIRTUAL) sums.assetB.virtual += size;
      }
    }

    return sums;
  }

  /**
   * Serializes an order object for persistence.
   * @param {Object} [order={}] - The order object to serialize.
   * @returns {Object} The serialized order.
   * @private
   */
  _serializeOrder(order = {}) {
    const priceValue = Number(order.price !== undefined && order.price !== null ? order.price : 0);
    const sizeValue = Number(order.size !== undefined && order.size !== null ? order.size : 0);
    // Preserve orderId for both ACTIVE and PARTIAL orders
    // CRITICAL: NEVER use slot id as fallback for orderId. 
    // This was causing grid corruption where virtual orders were treated as on-chain.
    const orderId = (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) ? (order.orderId || '') : '';

    const serialized = {
      id: order.id || null,
      type: order.type || null,
      state: order.state || null,
      price: Number.isFinite(priceValue) ? priceValue : 0,
      size: Number.isFinite(sizeValue) ? sizeValue : 0,
      orderId
    };

    return serialized;
  }
}

module.exports = {
  AccountOrders,
  createBotKey
};

