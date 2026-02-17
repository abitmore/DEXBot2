/**
 * modules/order/accounting.js - Accountant Engine
 *
 * Specialized engine for financial state and fund tracking.
 * Responsible for calculating available funds, committed capital, and managing BTS blockchain fees.
 * Exports a single Accountant class that manages all fund accounting operations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS - Accountant Class (16 methods)
 * ===============================================================================
 *
 * CORE INITIALIZATION & RECALCULATION (2 methods)
 *   1. constructor(manager) - Create new Accountant instance
 *   2. resetFunds() - Initialize funds structure with zeroed values
 *
 * MASTER FUND CALCULATIONS (1 method)
 *   3. recalculateFunds() - MASTER FUND CALCULATION: Recalculate all fund values based on order states
 *      Called after any state change. Aggregates committed/available funds and triggers allocation.
 *
 * VERIFICATION & RECOVERY (3 methods - async, internal)
 *   4. _verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell) - Verify fund tracking invariants
 *   5. _performStateRecovery(mgr) - Centralized state recovery (fetch + sync + validate) (async, internal)
 *   6. _attemptFundRecovery(mgr, violationType) - Attempt immediate recovery from invariant violations (async, internal)
 *
 * CHAINFREE BALANCE MANAGEMENT (2 methods)
 *   7. tryDeductFromChainFree(orderType, size, operation) - Atomically deduct from FREE portion
 *   8. addToChainFree(orderType, size, operation) - Add amount back to optimistic chainFree balance
 *
 * BALANCE ADJUSTMENTS (4 methods)
 *   9. adjustTotalBalance(orderType, delta, operation, totalOnly) - Adjust total and free balances
 *   10. _normalizeSideHint(sideHint) - Normalize side hint to standard key (internal)
 *   11. _resolveOrderSide(order, fallbackOrder, explicitSideHint) - Resolve order side (internal)
 *   12. updateOptimisticFreeBalance(oldOrder, newOrder, context, fee, skipAssetAccounting) - Update optimistic balance during transitions
 *
 * FEE MANAGEMENT (3 methods)
 *   13. deductBtsFees(requestedSide) - Deduct BTS fees using adjustTotalBalance with deferral strategy (async)
 *   14. _deductFeesFromProceeds(assetSymbol, rawAmount, isMaker) - Deduct fees from fill proceeds (internal)
 *   15. modifyCacheFunds(side, delta, operation) - Modify cache funds (rotation surplus + fill proceeds)
 *
 * FILL PROCESSING (1 method)
 *   16. processFillAccounting(fillOp) - Process fund impact of order fill (atomically updates accountTotals)
 *
 * ===============================================================================
 * FUND STRUCTURE (managed by Accountant)
 * ===============================================================================
 *
 * manager.funds = {
 *     available:   { buy, sell }          // Available funds for placement
 *     total:       { chain, grid }        // Total across blockchain + grid
 *     virtual:     { buy, sell }          // Virtual order capital
 *     committed:   { chain, grid }        // Capital locked in active orders
 *     cacheFunds:  { buy, sell }          // Surplus from rotation + fill proceeds
 *     btsFeesOwed: number                 // Unpaid BTS fees (deducted from cache)
 * }
 *
 * manager.accountTotals = {
 *     buy:      number                   // Total BUY balance on blockchain
 *     sell:     number                   // Total SELL balance on blockchain
 *     buyFree:  number                   // FREE BUY (not in any order)
 *     sellFree: number                   // FREE SELL (not in any order)
 * }
 *
 * ===============================================================================
 *
 * FUND INVARIANTS (verified by _verifyFundInvariants):
 * - blockchainTotal = chainFreeBalance + committedAmount
 * - cacheFunds <= chainFreeBalance (surplus detection)
 * - Virtual orders don't reduce FREE balance
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, PIPELINE_TIMING } = require('../constants');
const {
    calculateAvailableFundsValue,
    getAssetFees,
    blockchainToFloat,
    getPrecisionSlack
} = require('./utils/math');
const { resolveAccountRef } = require('./utils/system');
const Format = require('./format');
const { toFiniteNumber } = Format;

/**
 * Accountant engine - Specialized handler for fund tracking and calculations
 * @typedef {Object} Accountant
 */
class Accountant {
    /**
     * Create a new Accountant instance
     *
     * @param {Object} manager - OrderManager instance
     * @param {Map<string, Object>} manager.orders - Orders map
     * @param {Object} manager.accountTotals - Blockchain account balances
     * @param {Object} manager.funds - Fund tracking structure
     * @param {Logger} manager.logger - Logger instance
     */
    constructor(manager) {
        this.manager = manager;
        this._isVerifyingInvariants = false;  // Prevents overlapping invariant checks
        this._pendingInvariantSnapshot = null;  // Coalesces latest request while one is running
    }

    /**
     * Initialize the funds structure with zeroed values.
     *
     * @returns {void}
     */
    resetFunds() {
        const mgr = this.manager;
        mgr.accountTotals = mgr.accountTotals || (mgr.config.accountTotals ? { ...mgr.config.accountTotals } : { buy: null, sell: null, buyFree: null, sellFree: null });

        mgr.funds = {
            available: { buy: 0, sell: 0 },
            total: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            virtual: { buy: 0, sell: 0 },
            committed: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            cacheFunds: { buy: 0, sell: 0 },       // Surplus from rotation + fill proceeds
            btsFeesOwed: 0                         // Unpaid BTS fees (deducted from cache)
        };
    }

    /**
     * Recalculate all fund values based on current order states.
     * This is THE MASTER FUND CALCULATION and must be called after any state change.
     * Called automatically by _updateOrder(), but can be manually triggered to verify consistency.
     *
     * PSEUDOCODE ALGORITHM:
     * =====================
     * 1. Initialize accumulators (gridBuy, gridSell, chainBuy, chainSell, virtualBuy, virtualSell)
     * 2. Classify each order's state (ACTIVE/PARTIAL = on-chain committed, VIRTUAL = pending)
     * 3. Determine side from order.type, or derive from SPREAD price vs startPrice threshold
     * 4. Aggregate sizes by side and state:
     *    - ACTIVE/PARTIAL orders → committed.grid and committed.chain
     *    - VIRTUAL orders → virtual pool
     *    - Skip zero-sized orders
     * 5. Calculate blockchain totals:
     *    - chainTotalBuy = chainFreeBuy (from accountTotals) + chainBuy (committed on-chain)
     *    - chainTotalSell = chainFreeSell + chainSell
     * 6. Calculate available funds by subtracting committed amounts from blockchain totals
     *    - available.buy = chainTotalBuy - committed.chain.buy (after grid allocation)
     *    - available.sell = chainTotalSell - committed.chain.sell (after grid allocation)
     * 7. Apply percentage-based fund allocations (botFunds) if configured
     * 8. Verify fund invariants (total = free + committed) to detect tracking drift
     *
     * CRITICAL INVARIANTS MAINTAINED:
     * - Total on-chain balance = Free portion + Committed portion
     * - Virtual orders don't reduce blockchain-tracked free balance
     * - Grid totals = committed amounts + virtual amounts (pending placements)
     * - Available funds represent true spending power (after commitment deductions)
     *
     * @returns {void}
     */
    async recalculateFunds() {
         const mgr = this.manager;
         if (mgr._pauseFundRecalc) return;
         if (!mgr.funds) this.resetFunds();

         // CRITICAL: Acquire lock to get consistent snapshot of orders (Race Condition #3)
         // Otherwise _updateOrder() could change mgr.orders while we're iterating,
         // causing us to miss newly added orders or include stale ones.
         // No lock needed for read-only access to frozen orders
         const orderSnapshot = Array.from(mgr.orders.values());

         let gridBuy = 0, gridSell = 0;
         let chainBuy = 0, chainSell = 0;
         let virtualBuy = 0, virtualSell = 0;

         // AUTO-SYNC SPREAD COUNT
         mgr.currentSpreadCount = mgr._ordersByType[ORDER_TYPES.SPREAD]?.size || 0;

         // STEP 1-4: Iterate all orders, classify, and aggregate by state
         for (const order of orderSnapshot) {
             const isActive = (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL);
             const isVirtual = (order.state === ORDER_STATES.VIRTUAL);
             const size = toFiniteNumber(order.size);
             if (size <= 0) continue;

             // SIDE DETERMINATION:
             // - Explicit BUY/SELL: use order.type directly
             // - SPREAD type: derive from price relation to startPrice (market midpoint)
             //   * price < startPrice → BUY side (lower prices are bids)
             //   * price >= startPrice → SELL side (higher prices are asks)
             const isBuy = order.type === ORDER_TYPES.BUY || (order.type === ORDER_TYPES.SPREAD && order.price < mgr.startPrice);
             const isSell = order.type === ORDER_TYPES.SELL || (order.type === ORDER_TYPES.SPREAD && order.price >= mgr.startPrice);

             if (isBuy) {
                 if (isActive) gridBuy += size;           // On-chain BUY commitment
                 if (isActive) chainBuy += size;          // Same as gridBuy for this accounting method
                 if (isVirtual) virtualBuy += size;       // Pending virtual BUY order
             } else if (isSell) {
                 if (isActive) gridSell += size;          // On-chain SELL commitment
                 if (isActive) chainSell += size;         // Same as gridSell
                 if (isVirtual) virtualSell += size;      // Pending virtual SELL order
             }
         }

         // STEP 5: Fetch blockchain free balances and compute totals
         const chainFreeBuy = mgr.accountTotals?.buyFree || 0;
         const chainFreeSell = mgr.accountTotals?.sellFree || 0;

         // Store committed amounts (on-chain and in-memory grid)
         mgr.funds.committed.grid = { buy: gridBuy, sell: gridSell };
         mgr.funds.committed.chain = { buy: chainBuy, sell: chainSell };
         mgr.funds.virtual = { buy: virtualBuy, sell: virtualSell };

         // STEP 5: Compute total balances (free + committed)
         // These represent ALL funds we have, regardless of state
         const chainTotalBuy = chainFreeBuy + chainBuy;
         const chainTotalSell = chainFreeSell + chainSell;

         mgr.funds.total.chain = { buy: chainTotalBuy, sell: chainTotalSell };
         mgr.funds.total.grid = { buy: gridBuy + virtualBuy, sell: gridSell + virtualSell };

         // STEP 6: Calculate available funds (what we can spend right now)
         // Uses utils::calculateAvailableFundsValue which deducts committe amounts
         mgr.funds.available.buy = calculateAvailableFundsValue('buy', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
         mgr.funds.available.sell = calculateAvailableFundsValue('sell', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);

         // Ensure percentage-based allocations are applied to the newly calculated totals
         if (typeof mgr.applyBotFundsAllocation === 'function') {
             mgr.applyBotFundsAllocation();
         }

          if (mgr.logger && mgr.logger.level === 'debug' && !mgr._pauseFundRecalc && !mgr._pauseRecalcLogging) {
              const buyPrecision = mgr.config?.assetB?.precision;
              const sellPrecision = mgr.config?.assetA?.precision;
             if (Number.isFinite(buyPrecision) && Number.isFinite(sellPrecision)) {
                 mgr.logger.log(`[RECALC] BUY: Total=${Format.formatAmountByPrecision(chainTotalBuy, buyPrecision)} (Free=${Format.formatAmountByPrecision(chainFreeBuy, buyPrecision)}, Grid=${Format.formatAmountByPrecision(gridBuy, buyPrecision)})`, 'debug');
                 mgr.logger.log(`[RECALC] SELL: Total=${Format.formatAmountByPrecision(chainTotalSell, sellPrecision)} (Free=${Format.formatAmountByPrecision(chainFreeSell, sellPrecision)}, Grid=${Format.formatAmountByPrecision(gridSell, sellPrecision)})`, 'debug');
             }
         }

        if (!mgr._pauseFundRecalc && !mgr.isBootstrapping && !mgr._isBroadcasting) {
            const snapshot = { chainFreeBuy, chainFreeSell, chainBuy, chainSell };

            const runVerification = (nextSnapshot) => {
                this._isVerifyingInvariants = true;
                this._verifyFundInvariants(
                    mgr,
                    nextSnapshot.chainFreeBuy,
                    nextSnapshot.chainFreeSell,
                    nextSnapshot.chainBuy,
                    nextSnapshot.chainSell
                )
                    .catch(err => {
                        mgr.logger?.log?.(`[RECOVERY] Verification error: ${err.message}`, 'error');
                    })
                    .finally(() => {
                        this._isVerifyingInvariants = false;
                        if (this._pendingInvariantSnapshot) {
                            const pending = this._pendingInvariantSnapshot;
                            this._pendingInvariantSnapshot = null;
                            runVerification(pending);
                        }
                    });
            };

            if (this._isVerifyingInvariants) {
                this._pendingInvariantSnapshot = snapshot;
            } else {
                runVerification(snapshot);
            }
        }
    }

     /**
      * Verify critical fund tracking invariants.
      * Now async to support immediate recovery attempts without blocking.
      *
      * TOLERANCE CALCULATION STRATEGY:
      * ===============================
      * Two tolerance sources are combined using MAX() for conservative checking:
      * 1. PRECISION SLACK: Accounts for blockchain float<→int rounding errors at asset decimals
      *    - Formula: 10^(-precision) (e.g., BTS @ 8 decimals = 0.00000001)
      *    - Reason: Float arithmetic can round amounts by ±1 satoshi (smallest unit)
      *    - Typical: 0.00000001 BTS, 0.0001 USD
      * 
      * 2. PERCENTAGE TOLERANCE: Accounts for timing-dependent balance changes (in-flight txs)
      *    - Formula: balance * (configured percentage / 100)
      *    - Configured: FUND_INVARIANT_PERCENT_TOLERANCE (default: 0.1 = 0.1%)
      *    - Reason: Small balance changes from fills/fees may propagate slowly on-chain
      *    - Scales with balance size (larger balances tolerate larger absolute diffs)
      * 
      * Combined tolerance = MAX(precisionSlack, balance * percentTolerance)
      * This prevents both:
      *   - False positives from rounding noise on small amounts
      *   - Undetected drift on large amounts
      *
      * INVARIANTS CHECKED:
      * 1. Total Balance Drift: accountTotals.buy/sell vs (chainFree + committed)
      *    - Detects: Fees deducted twice, missing fills, blockchain state desync
      * 2. Surplus Over-estimation: cacheFunds > chainFree balance
      *    - Detects: Over-counting fill proceeds, double-crediting cache
      */
      async _verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell) {
          const buyPrecision = mgr.assets?.assetB?.precision;
          const sellPrecision = mgr.assets?.assetA?.precision;
          if (!Number.isFinite(buyPrecision) || !Number.isFinite(sellPrecision)) {
              return;  // Skip invariant check if precision not available
          }
         const precisionSlackBuy = getPrecisionSlack(buyPrecision);
         const precisionSlackSell = getPrecisionSlack(sellPrecision);
         const PERCENT_TOLERANCE = (GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE || 0.1) / 100;

         let hasViolation = false;

         // INVARIANT 1: Drift detection
         // FORMULA: expectedBuy = chainFreeBuy + chainBuy (what we think we have)
         //          actualBuy = mgr.accountTotals.buy (what blockchain says)
         //          If |actualBuy - expectedBuy| > tolerance → fund tracking corruption detected
         const expectedBuy = chainFreeBuy + chainBuy;
         const actualBuy = mgr.accountTotals?.buy;
         const diffBuy = Math.abs((actualBuy ?? expectedBuy) - expectedBuy);
         const allowedBuyTolerance = Math.max(precisionSlackBuy, (actualBuy || expectedBuy) * PERCENT_TOLERANCE);

        if (actualBuy !== null && actualBuy !== undefined && diffBuy > allowedBuyTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR instead of WARN
            // Invariant violations indicate serious fund tracking corruption and must not be silent
            // This triggers immediate recovery attempt
            mgr.logger?.log?.(`CRITICAL: Fund invariant violation (BUY): blockchainTotal (${Format.formatAmountByPrecision(actualBuy, buyPrecision)}) != trackedTotal (${Format.formatAmountByPrecision(expectedBuy, buyPrecision)}) (diff: ${Format.formatAmountByPrecision(diffBuy, buyPrecision)}, allowed: ${Format.formatAmountByPrecision(allowedBuyTolerance, buyPrecision)})`, 'error');
        }

        const expectedSell = chainFreeSell + chainSell;
        const actualSell = mgr.accountTotals?.sell;
        const diffSell = Math.abs((actualSell ?? expectedSell) - expectedSell);
        const allowedSellTolerance = Math.max(precisionSlackSell, (actualSell || expectedSell) * PERCENT_TOLERANCE);

        if (actualSell !== null && actualSell !== undefined && diffSell > allowedSellTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR instead of WARN
            mgr.logger?.log?.(`CRITICAL: Fund invariant violation (SELL): blockchainTotal (${Format.formatAmountByPrecision(actualSell, sellPrecision)}) != trackedTotal (${Format.formatAmountByPrecision(expectedSell, sellPrecision)}) (diff: ${Format.formatAmountByPrecision(diffSell, sellPrecision)}, allowed: ${Format.formatAmountByPrecision(allowedSellTolerance, sellPrecision)})`, 'error');
        }

        // INVARIANT 2: Surplus check
        const cacheBuy = mgr.funds?.cacheFunds?.buy || 0;
        const cacheSell = mgr.funds?.cacheFunds?.sell || 0;
        if (cacheBuy > chainFreeBuy + allowedBuyTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR - surplus over-estimation can cause overdrafts
            mgr.logger?.log?.(`CRITICAL: Surplus over-estimation (BUY): cacheFunds (${Format.formatAmountByPrecision(cacheBuy, buyPrecision)}) > chainFree (${Format.formatAmountByPrecision(chainFreeBuy, buyPrecision)})`, 'error');
        }
        if (cacheSell > chainFreeSell + allowedSellTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR
            mgr.logger?.log?.(`CRITICAL: Surplus over-estimation (SELL): cacheFunds (${Format.formatAmountByPrecision(cacheSell, sellPrecision)}) > chainFree (${Format.formatAmountByPrecision(chainFreeSell, sellPrecision)})`, 'error');
        }

        // NEW: Attempt immediate recovery if violation detected
        if (hasViolation) {
            if (mgr._gridLock?.isLocked?.()) {
                this._attemptFundRecovery(mgr, 'Fund invariant violation').catch(err => {
                    mgr.logger?.log?.(`[RECOVERY] Deferred recovery scheduling failed: ${err.message}`, 'error');
                });
            } else {
                await this._attemptFundRecovery(mgr, 'Fund invariant violation');
            }
        }
    }

    /**
     * Perform centralized state recovery (fetch + sync + validate).
     * Shared by both immediate recovery and stabilization gate.
     *
     * @param {Object} mgr - Manager instance
     * @returns {Promise<Object>} - Validation result from validateGridStateForPersistence()
     */
    async _performStateRecovery(mgr) {
        const accountRef = resolveAccountRef(mgr);
        if (!accountRef) {
            return {
                isValid: false,
                reason: 'Recovery skipped: missing account context (accountId/account)'
            };
        }

        // 1. Fetch fresh blockchain state
        await mgr.fetchAccountTotals(accountRef);

        // 2. Sync from open orders
        const chainOrders = require('../chain_orders');
        const openOrders = await chainOrders.readOpenOrders(accountRef);
        await mgr.syncFromOpenOrders(openOrders, { skipAccounting: false });

        // 3. Validate recovery
        return mgr.validateGridStateForPersistence();
    }

      /**
       * Attempt immediate recovery from fund invariant violations.
       * Runs once per cycle - subsequent violations in same cycle are skipped.
       *
       * @param {Object} mgr - Manager instance
       * @param {string} violationType - Description of the violation for logging
       * @returns {Promise<boolean>} - True if recovery succeeded, false otherwise
       */
    async _attemptFundRecovery(mgr, violationType) {
          if (!mgr._recoveryState || typeof mgr._recoveryState !== 'object') {
              mgr._recoveryState = { attemptCount: 0, lastAttemptAt: 0, inFlight: false, lastFailureAt: 0 };
          }

          const state = mgr._recoveryState;
          const now = Date.now();
          const retryIntervalMs = Math.max(0, Number(PIPELINE_TIMING.RECOVERY_RETRY_INTERVAL_MS) || 0);
          const maxAttemptsRaw = Number(PIPELINE_TIMING.MAX_RECOVERY_ATTEMPTS);
          const hasAttemptLimit = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0;

          if (state.inFlight) {
              mgr.logger?.log?.('[RECOVERY] Skipping recovery: attempt already in flight', 'debug');
              return false;
          }

          // Decay: if enough time has passed since the last failure, treat this
          // as a fresh violation cycle to prevent stale counts from a previous
          // cycle permanently exhausting the attempt budget.
          const decayMs = retryIntervalMs > 0 ? retryIntervalMs * 3 : PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS;
          if (state.attemptCount > 0 && state.lastFailureAt > 0 && (now - state.lastFailureAt) > decayMs) {
              // Log at 'info' level so operators can monitor for repeated decay patterns
              // which may indicate a persistent issue that self-corrects just long enough
              // to trigger decay, then recurs. Pattern: repeated "decayed" messages.
              mgr.logger?.log?.(
                  `[RECOVERY] Attempt count decayed (${state.attemptCount} -> 0) after ${Math.round((now - state.lastFailureAt) / 1000)}s idle`,
                  'info'
              );
              state.attemptCount = 0;
              state.lastFailureAt = 0;
          }

          if (hasAttemptLimit && state.attemptCount >= maxAttemptsRaw) {
              mgr.logger?.log?.(
                  `[RECOVERY] Skipping recovery: max attempts reached (${state.attemptCount}/${maxAttemptsRaw})`,
                  'warn'
              );
              return false;
          }

          if (state.attemptCount > 0 && retryIntervalMs > 0) {
              const elapsed = now - state.lastAttemptAt;
              if (elapsed < retryIntervalMs) {
                  mgr.logger?.log?.(
                      `[RECOVERY] Cooldown active (${elapsed}ms/${retryIntervalMs}ms). Skipping retry.`,
                      'debug'
                  );
                  return false;
              }
          }

          state.inFlight = true;
          state.attemptCount += 1;
          state.lastAttemptAt = now;
          mgr._recoveryAttempted = true;
          mgr.logger?.log?.(
              `[RECOVERY] ${violationType} - attempting state recovery (attempt ${state.attemptCount}${hasAttemptLimit ? `/${maxAttemptsRaw}` : ''})...`,
              'warn'
          );

          try {
              const validation = await this._performStateRecovery(mgr);

              if (validation.isValid) {
                  mgr.logger?.log?.('[RECOVERY] State recovery succeeded', 'info');
                  // NOTE: Do NOT reset attemptCount here. The fund invariant check will
                  // run again after recovery returns. If the invariant is still violated,
                  // we want the counter to increment properly (2/5, 3/5, etc.) rather
                  // than resetting to 1/5 each time. The decay logic (line 417) will
                  // reset the counter if enough time passes without violations.
                  return true;
              }

              state.lastFailureAt = Date.now();
              mgr.logger?.log?.(`[RECOVERY] State recovery failed: ${validation.reason}`, 'error');
              return false;
          } catch (err) {
              state.lastFailureAt = Date.now();
              mgr.logger?.log?.(`[RECOVERY] State recovery error: ${err.message}`, 'error');
              return false;
          } finally {
              state.inFlight = false;
              mgr._recoveryAttempted = false;
          }
      }

      /**
       * Reset the recovery attempt flag.
       * Called at the start of each fill processing cycle to allow fresh recovery attempts.
       */
       resetRecoveryState() {
           if (!this.manager) return;
           this.manager._recoveryAttempted = false;
           this.manager._recoveryState = {
               attemptCount: 0,
               lastAttemptAt: 0,
               inFlight: false,
               lastFailureAt: 0
           };
        }

    /**
     * Check if sufficient funds exist AND atomically deduct (FREE portion only).
     * PRIVATE: Must be called while holding _fundLock.
     */
    async tryDeductFromChainFree(orderType, size, operation = 'move') {
         const mgr = this.manager;
         const isBuy = orderType === ORDER_TYPES.BUY;
         const key = isBuy ? 'buyFree' : 'sellFree';

         if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) return false;

         const current = toFiniteNumber(mgr.accountTotals[key]);
         if (current < size) {
             mgr.logger.log(`[chainFree] ${orderType} ${operation}: INSUFFICIENT FUNDS (have ${Format.formatAmount8(current)}, need ${Format.formatAmount8(size)})`, 'warn');
             return false;
         }

         const oldValue = mgr.accountTotals[key];
         mgr.accountTotals[key] = Math.max(0, current - size);

         if (mgr.logger && mgr.logger.level === 'debug') {
             mgr.logger.log(`[ACCOUNTING] ${key} -${Format.formatAmount8(size)} (${operation}) -> ${Format.formatAmount8(mgr.accountTotals[key])} (was ${Format.formatAmount8(oldValue)})`, 'debug');
         }
         return true;
    }

    /**
     * Add an amount back to the optimistic chainFree balance (FREE portion only).
     * PRIVATE: Must be called while holding _fundLock.
     */
    async addToChainFree(orderType, size, operation = 'release') {
         const mgr = this.manager;
         const isBuy = orderType === ORDER_TYPES.BUY;
         const key = isBuy ? 'buyFree' : 'sellFree';

         if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) return false;

         const oldFree = toFiniteNumber(mgr.accountTotals[key]);
         mgr.accountTotals[key] = oldFree + size;

         if (mgr.logger && mgr.logger.level === 'debug') {
             mgr.logger.log(`[ACCOUNTING] ${key} +${Format.formatAmount8(size)} (${operation}) -> ${Format.formatAmount8(mgr.accountTotals[key])} (was ${Format.formatAmount8(oldFree)})`, 'debug');
          }
          return true;
    }

    /**
     * Record a fill in the optimistic total balances.
     * PUBLIC API: Acquires _fundLock.
     */
    async recordFillBalances(paysAsset, paysAmount, receivesAsset, receivesAmount, context = 'fill') {
        return await this.manager._fundLock.acquire(async () => {
            const mgr = this.manager;
            const assetA = mgr.config.assetA;
            const assetB = mgr.config.assetB;

            // Determine orientation
            if (paysAsset === assetA) {
                // Bot paid assetA (Selling assetA, buying assetB)
                this.adjustTotalBalance(ORDER_TYPES.SELL, -paysAmount, `${context}-pays`);
                this.adjustTotalBalance(ORDER_TYPES.BUY, receivesAmount, `${context}-receives`);
                await this._modifyCacheFunds('buy', receivesAmount, `${context}-proceeds`);
            } else {
                // Bot paid assetB (Buying assetA, selling assetB)
                this.adjustTotalBalance(ORDER_TYPES.BUY, -paysAmount, `${context}-pays`);
                this.adjustTotalBalance(ORDER_TYPES.SELL, receivesAmount, `${context}-receives`);
                await this._modifyCacheFunds('sell', receivesAmount, `${context}-proceeds`);
            }
        });
    }

    /**
     * Atomically set cache funds to an absolute value.
     * PUBLIC API: Acquires _fundLock.
     *
     * @param {string} side - 'buy' or 'sell'
     * @param {number} absoluteValue - New absolute cache value
     * @param {string} operation - Logging context
     * @returns {Promise<number>} New cached value
     */
    async setCacheFundsAbsolute(side, absoluteValue, operation = 'set-absolute') {
        return await this.manager._fundLock.acquire(async () => {
            const mgr = this.manager;
            if (!mgr.funds.cacheFunds) mgr.funds.cacheFunds = { buy: 0, sell: 0 };

            const oldValue = toFiniteNumber(mgr.funds.cacheFunds[side]);
            const nextValue = toFiniteNumber(absoluteValue);
            mgr.funds.cacheFunds[side] = nextValue;

            if (mgr.logger && mgr.logger.level === 'debug') {
                const delta = nextValue - oldValue;
                mgr.logger.log(
                    `[CACHEFUNDS] ${side} set ${Format.formatAmount8(oldValue)} -> ${Format.formatAmount8(nextValue)} ` +
                    `(${operation}, delta=${delta >= 0 ? '+' : ''}${Format.formatAmount8(delta)})`,
                    'debug'
                );
            }
            return nextValue;
        });
    }

    /**
     * Internal logic for modifying cache funds.
     * PRIVATE: Must be called while holding _fundLock.
     */
    async _modifyCacheFunds(side, delta, operation = 'update') {
         const mgr = this.manager;
         
         if (!mgr.funds.cacheFunds) mgr.funds.cacheFunds = { buy: 0, sell: 0 };
         const oldValue = mgr.funds.cacheFunds[side] || 0;
         const newValue = Math.max(0, oldValue + delta);
         mgr.funds.cacheFunds[side] = newValue;

         if (mgr.logger && mgr.logger.level === 'debug') {
             mgr.logger.log(`[CACHEFUNDS] ${side} ${delta > 0 ? '+' : ''}${Format.formatAmount8(delta)} (${operation}) -> ${Format.formatAmount8(newValue)}`, 'debug');
         }
    }

    /**
     * Adjust both total and free balances (for fills, fees, deposits).
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {number} delta - Amount to adjust
     * @param {string} operation - Context for logging
     * @param {boolean} totalOnly - If true, only adjust TOTAL balance, not FREE portion.
     */
    adjustTotalBalance(orderType, delta, operation, totalOnly = false) {
        const mgr = this.manager;
        const isBuy = (orderType === ORDER_TYPES.BUY);
        const freeKey = isBuy ? 'buyFree' : 'sellFree';
        const totalKey = isBuy ? 'buy' : 'sell';

        if (!mgr.accountTotals) return;

        if (!totalOnly) {
            const oldFree = toFiniteNumber(mgr.accountTotals[freeKey]);
            // IMPORTANT: No clamping to 0 here. Allowing temporary negative Free balance
            // ensures the invariant Total = Free + Committed remains stable during
            // the short race between Fill detection and Order state update.
            mgr.accountTotals[freeKey] = oldFree + delta;
        }

        if (mgr.accountTotals[totalKey] !== undefined && mgr.accountTotals[totalKey] !== null) {
            const oldTotal = toFiniteNumber(mgr.accountTotals[totalKey]);
            mgr.accountTotals[totalKey] = Math.max(0, oldTotal + delta);
        }

        if (mgr.logger && mgr.logger.level === 'debug') {
            const freeMsg = totalOnly ? `Free: (untouched)` : `Free: ${Format.formatAmount8(mgr.accountTotals[freeKey])}`;
            mgr.logger.log(`[ACCOUNTING] ${totalKey} ${delta >= 0 ? '+' : ''}${Format.formatAmount8(delta)} (${operation}) -> Total: ${Format.formatAmount8(mgr.accountTotals[totalKey])}, ${freeMsg}`, 'debug');
        }
    }

    _normalizeSideHint(sideHint) {
        if (sideHint === ORDER_TYPES.BUY || sideHint === 'buy') return ORDER_TYPES.BUY;
        if (sideHint === ORDER_TYPES.SELL || sideHint === 'sell') return ORDER_TYPES.SELL;
        return null;
    }

    _resolveOrderSide(order, fallbackOrder = null, explicitSideHint = null) {
        const fromHint = this._normalizeSideHint(explicitSideHint);
        if (fromHint) return fromHint;

        const candidates = [
            order?.sideHint,
            order?.committedSide,
            order?.type,
            fallbackOrder?.sideHint,
            fallbackOrder?.committedSide,
            fallbackOrder?.type
        ];

        for (const candidate of candidates) {
            const normalized = this._normalizeSideHint(candidate);
            if (normalized) return normalized;
        }

        return null;
    }

    /**
     * Update optimistic balance during transitions.
     * @param {Object} oldOrder - Previous order state
     * @param {Object} newOrder - New order state
     * @param {string} context - Context for logging/tracking
     * @param {number} fee - Blockchain fee to deduct
     * @param {boolean} skipAssetAccounting - If true, skip capital commitment changes (asset amounts) but still process fees
     */
    async updateOptimisticFreeBalance(oldOrder, newOrder, context, fee = 0, skipAssetAccounting = false) {
        const mgr = this.manager;
        if (!oldOrder || !newOrder) return;

        if (!skipAssetAccounting) {
            const oldIsActive = (oldOrder.state === ORDER_STATES.ACTIVE || oldOrder.state === ORDER_STATES.PARTIAL);
            const newIsActive = (newOrder.state === ORDER_STATES.ACTIVE || newOrder.state === ORDER_STATES.PARTIAL);
            const oldSize = toFiniteNumber(oldOrder.size);
            const newSize = toFiniteNumber(newOrder.size);

            // 1. Handle Capital Commitment (Moves between FREE and LOCKED)
            // For COMMITMENT: Use GRID state (isActive), not blockchain ID
            const oldGridCommitted = oldIsActive ? oldSize : 0;
            const newGridCommitted = newIsActive ? newSize : 0;
            const commitmentDelta = newGridCommitted - oldGridCommitted;
            const newSideType = this._resolveOrderSide(newOrder, oldOrder);
            const oldSideType = this._resolveOrderSide(oldOrder, newOrder);
            const sideForPrecision = newSideType || oldSideType;

            if (mgr.logger && mgr.logger.level === 'debug') {
                mgr.logger.log(
                    `[ACCOUNTING] updateOptimisticFreeBalance: id=${newOrder.id}, type=${newOrder.type}, ` +
                    `state=${oldOrder.state}->${newOrder.state}, ` +
                    `size=${Format.formatSizeByOrderType(oldSize, sideForPrecision, mgr.assets)}->${Format.formatSizeByOrderType(newSize, sideForPrecision, mgr.assets)}, ` +
                    `delta=${Format.formatSizeByOrderType(commitmentDelta, sideForPrecision, mgr.assets)}, context=${context}`,
                    'debug'
                );
            }

            if (commitmentDelta > 0) {
                // Lock capital: move from Free to Committed
                const commitmentSide = newSideType || newOrder.type;
                const deducted = await this.tryDeductFromChainFree(commitmentSide, commitmentDelta, `${context}`);
                if (!deducted) {
                    const failure = {
                        code: 'ACCOUNTING_COMMITMENT_FAILED',
                        side: commitmentSide,
                        amount: commitmentDelta,
                        context,
                        at: Date.now()
                    };
                    mgr._lastAccountingFailure = failure;

                    mgr.logger?.log?.(
                        `[ACCOUNTING] CRITICAL: Failed to lock ${Format.formatAmount8(commitmentDelta)} for ${commitmentSide} during ${context}. Scheduling recovery.`,
                        'error'
                    );

                    if (mgr._throwOnIllegalState) {
                        const err = new Error(
                            `CRITICAL ACCOUNTING STATE: failed to lock ${Format.formatAmount8(commitmentDelta)} ${commitmentSide} during ${context}`
                        );
                        err.code = 'ACCOUNTING_COMMITMENT_FAILED';
                        throw err;
                    }

                    this._attemptFundRecovery(mgr, 'Optimistic commitment deduction failure').catch(err => {
                        mgr.logger?.log?.(`[RECOVERY] Immediate recovery scheduling failed: ${err.message}`, 'error');
                    });
                }
            } else if (commitmentDelta < 0) {
                // Release capital: move from Committed back to Free
                const releaseSide = oldSideType || oldOrder.type;
                await this.addToChainFree(releaseSide, Math.abs(commitmentDelta), `${context}`);
            }
        }

        // 2. Handle Blockchain Fees (Physical reduction of TOTAL balance)
        // Fees are ALWAYS deducted if provided, even if skipAssetAccounting is true
        const btsSide = (mgr.config?.assetA === 'BTS') ? 'sell' : (mgr.config?.assetB === 'BTS') ? 'buy' : null;
        if (fee > 0 && btsSide) {
            const btsOrderType = (btsSide === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
            this.adjustTotalBalance(btsOrderType, -fee, `${context}-fee`);
        }
    }

    /**
     * Deduct BTS fees using adjustTotalBalance.
     *
     * Strategy: Accumulate fees in btsFeesOwed, then settle when sufficient funds available.
     * - Fees are part of chainFree (not separate capital)
     * - Full fee amount must reduce chainFree
     * - Cache is drawn down first, then base capital
     * - Defers settlement if insufficient funds (will retry when funds become available)
     */
    async deductBtsFees(requestedSide = null) {
        const mgr = this.manager;

        // Early returns for no work needed
        if (!mgr.funds || !mgr.funds.btsFeesOwed || mgr.funds.btsFeesOwed <= 0) return;
        if (!mgr.accountTotals) return;

        const btsSide = (mgr.config.assetA === 'BTS') ? 'sell' : (mgr.config.assetB === 'BTS') ? 'buy' : null;
        const normalizedRequestedSide = (requestedSide === 'buy' || requestedSide === 'sell') ? requestedSide : null;
        let side = btsSide || normalizedRequestedSide;

        if (normalizedRequestedSide && btsSide && normalizedRequestedSide !== btsSide) {
            mgr.logger?.log?.(
                `[BTS-FEE] Ignoring requested side '${normalizedRequestedSide}' (configured BTS side is '${btsSide}').`,
                'warn'
            );
            side = btsSide;
        }

        if (!side) return;

        const fees = mgr.funds.btsFeesOwed;
        const orderType = (side === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        const freeKey = (side === 'buy') ? 'buyFree' : 'sellFree';
        const chainFree = mgr.accountTotals[freeKey] || 0;

        // SUFFICIENCY CHECK: Defer if insufficient funds
        if (chainFree < fees) {
            if (mgr.logger && mgr.logger.level === 'debug') {
                mgr.logger.log(`[BTS-FEE] Deferring settlement: need ${Format.formatAmount8(fees)}, have ${Format.formatAmount8(chainFree)}`, 'debug');
            }
            return;
        }

        // SETTLEMENT: Deduct from cache first, then base capital
        const cache = mgr.funds.cacheFunds?.[side] || 0;
         const cacheDeduction = Math.min(fees, cache);

         if (cacheDeduction > 0) {
             await this.modifyCacheFunds(side, -cacheDeduction, 'bts-fee-settlement');
         }

        // FULL DEDUCTION from chainFree (cache is part of chainFree, so always deduct full amount)
        this.adjustTotalBalance(orderType, -fees, 'bts-fee-settlement');

        if (mgr.logger && mgr.logger.level === 'debug') {
            const baseCapitalDeduction = fees - cacheDeduction;
            mgr.logger.log(`[BTS-FEE] Settled: ${Format.formatAmount8(fees)} BTS (${Format.formatAmount8(cacheDeduction)} from cache, ${Format.formatAmount8(baseCapitalDeduction)} from base capital)`, 'debug');
        }

        // Reset fees after successful settlement
        mgr.funds.btsFeesOwed = 0;

        // Recalculate funds to update all tracking metrics
        await mgr.recalculateFunds();
    }

    /**
     * Validate that a proposed Target Grid fits within the account's total available funds.
     * Prevents over-commitment before orders are broadcast.
     * 
     * @param {Map} targetGrid - Proposed grid (price -> {size, type})
     * @returns {Object} { isValid, shortfall, details }
     */
    validateTargetGrid(targetGrid) {
        if (!targetGrid || typeof targetGrid.values !== 'function') {
            return { isValid: false, shortfall: { buy: 0, sell: 0 }, details: { error: 'Invalid targetGrid' } };
        }
        const mgr = this.manager;
        let requiredBuy = 0;
        let requiredSell = 0;

        // 1. Sum up requirements for the new grid
        for (const order of targetGrid.values()) {
            const size = toFiniteNumber(order.size);
            if (size <= 0) continue;

            if (order.type === ORDER_TYPES.BUY) {
                // Buy order uses Asset B (Quote)
                requiredBuy += size;
            } else if (order.type === ORDER_TYPES.SELL) {
                // Sell order uses Asset A (Base)
                requiredSell += size;
            }
        }

        // 2. Add Estimated BTS Fees (if BTS is one of the pairs)
        // Fees reduce the "Free" balance, so they compete with Order Capital
        const btsSide = (mgr.config.assetA === 'BTS') ? 'sell' : (mgr.config.assetB === 'BTS') ? 'buy' : null;
        if (btsSide && mgr.funds.btsFeesOwed > 0) {
            if (btsSide === 'buy') requiredBuy += mgr.funds.btsFeesOwed;
            else requiredSell += mgr.funds.btsFeesOwed;
        }

        // 3. Compare against Total Account Balance (Free + Committed)
        // Note: We use the *current* totals from the manager, which includes
        // money locked in current orders. Since the new grid *replaces* the old one,
        // we can essentially "re-spend" the money from old orders.
        const totalBuy = (mgr.accountTotals?.buy || 0);
        const totalSell = (mgr.accountTotals?.sell || 0);

        // Add slack for precision rounding errors
        const slackBuy = getPrecisionSlack(mgr.assets?.assetB?.precision || 8);
        const slackSell = getPrecisionSlack(mgr.assets?.assetA?.precision || 8);

        const buyShortfall = Math.max(0, requiredBuy - (totalBuy + slackBuy));
        const sellShortfall = Math.max(0, requiredSell - (totalSell + slackSell));

        const isValid = buyShortfall === 0 && sellShortfall === 0;

        if (!isValid) {
            mgr.logger.log(
                `[ACCOUNTING] Target Grid validation failed. Shortfall: Buy=${Format.formatAmount8(buyShortfall)}, Sell=${Format.formatAmount8(sellShortfall)}`,
                'warn'
            );
        }

        return {
            isValid,
            shortfall: { buy: buyShortfall, sell: sellShortfall },
            details: { requiredBuy, requiredSell, totalBuy, totalSell }
        };
     }

    async modifyCacheFunds(side, delta, operation = 'update') {
         return await this.manager._fundLock.acquire(async () => {
             await this._modifyCacheFunds(side, delta, operation);
             return this.manager.funds.cacheFunds[side];
         });
    }

    /**
     * Centralized fee deduction helper - prevents duplicate logic across codebase.
     * Returns net proceeds after market fees, or raw amount if asset is not recognized.
     * @param {string} assetSymbol - Asset symbol (e.g., 'BTS', 'XRP')
     * @param {number} rawAmount - Amount before fees
     * @param {boolean} isMaker - Whether this was a maker order (0.1% fee) vs taker (0.1% fee)
     * @returns {number} Net proceeds after fees, or rawAmount if symbol not found
     * @private
     */
    _deductFeesFromProceeds(assetSymbol, rawAmount, isMaker) {
        if (!assetSymbol) return rawAmount;

        // CRITICAL: For BTS, the refund is a SEPARATE transaction, not included in fill amount
        // Do NOT add refund to fill proceeds - that would be double counting
        // The fill.receives already contains only the market proceeds
        // The refund will arrive as a separate transaction that we'll account for separately
        if (assetSymbol === 'BTS') {
            // For BTS: just return raw amount (no refund addition)
            // Fee settlement (net fee) will be deducted later via deductBtsFees()
            return rawAmount;
        }

        // For other assets: apply normal fee calculation (market fee %)
        // Fail-safe: if fee cache is missing/stale, do not crash fill processing.
        try {
            const feeInfo = getAssetFees(assetSymbol, rawAmount, isMaker);
            const netProceeds = toFiniteNumber(feeInfo?.netProceeds, null);
            if (netProceeds === null) {
                throw new Error('netProceeds is not finite');
            }
            return netProceeds;
        } catch (err) {
            this.manager?.logger?.log?.(
                `[FILL-FEE] Failed to compute fees for ${assetSymbol}: ${err.message}. Using raw proceeds (${Format.formatAmount8(rawAmount)}).`,
                'warn'
            );
            return rawAmount;
        }
    }

     /**
      * Process the fund impact of an order fill.
      * Atomically updates accountTotals to keep internal state in sync with blockchain.
      * CRITICAL: Called within fill processing lock context to prevent race conditions.
      * NOTE: Now async due to modifyCacheFunds() being async (Race Condition #4).
      */
    async processFillAccounting(fillOp) {
         const mgr = this.manager;
         const pays = fillOp?.pays;
         const receives = fillOp?.receives;
         if (!pays || !receives) return;

         // Default to maker (not taker) because:
        // 1. This bot primarily places orders (maker orders, not taker)
        // 2. Maker fees are CHEAPER: 10% of fee vs 100% for taker
        // 3. When is_maker is missing, it's safer to assume maker (the normal case)
        // 4. Makers get 90% refund on BTS fees, so we account for that
        const isMaker = fillOp.is_maker !== false;

        const assetAId = mgr.assets?.assetA?.id;
        const assetBId = mgr.assets?.assetB?.id;

        const assetAPrecision = mgr.assets?.assetA?.precision;
        const assetBPrecision = mgr.assets?.assetB?.precision;

        if (assetAPrecision === undefined || assetBPrecision === undefined) return;

        const assetASymbol = mgr.config?.assetA;
        const assetBSymbol = mgr.config?.assetB;

        // 1. Deduct PAYS amount from both TOTAL and FREE balances.
        // We must deduct from FREE to offset the optimistic "release to Free"
        // that happens when _updateOrder transitions the filled order to VIRTUAL.
        if (pays.asset_id === assetAId) {
            const amount = blockchainToFloat(pays.amount, assetAPrecision, true);
            this.adjustTotalBalance(ORDER_TYPES.SELL, -amount, 'fill-pays');
        } else if (pays.asset_id === assetBId) {
            const amount = blockchainToFloat(pays.amount, assetBPrecision, true);
            this.adjustTotalBalance(ORDER_TYPES.BUY, -amount, 'fill-pays');
        }

        // 2. Add RECEIVES amount to both TOTAL and FREE
        // These proceeds are liquid and increase spending power.
        // IMPORTANT: Deduct market fees from proceeds to match blockchain reality.
        if (receives.asset_id === assetAId) {
            const rawAmount = blockchainToFloat(receives.amount, assetAPrecision, true);
            const netAmount = this._deductFeesFromProceeds(assetASymbol, rawAmount, isMaker);

             this.adjustTotalBalance(ORDER_TYPES.SELL, netAmount, 'fill-receives');
             await this.modifyCacheFunds('sell', netAmount, 'fill-proceeds');
         } else if (receives.asset_id === assetBId) {
             const rawAmount = blockchainToFloat(receives.amount, assetBPrecision, true);
             const netAmount = this._deductFeesFromProceeds(assetBSymbol, rawAmount, isMaker);

             this.adjustTotalBalance(ORDER_TYPES.BUY, netAmount, 'fill-receives');
             await this.modifyCacheFunds('buy', netAmount, 'fill-proceeds');
        }
    }
}

module.exports = Accountant;
