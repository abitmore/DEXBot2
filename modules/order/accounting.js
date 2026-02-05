/**
 * modules/order/accounting.js - Accountant Engine
 *
 * Specialized engine for financial state and fund tracking.
 * Responsible for calculating available funds, committed capital, and managing BTS blockchain fees.
 * Exports a single Accountant class that manages all fund accounting operations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS - Accountant Class (13 methods)
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
 *   5. _performStateRecovery(mgr) - Centralized state recovery (fetch + sync + validate)
 *   6. _attemptFundRecovery(mgr, violationType) - Attempt immediate recovery from invariant violations
 *
 * CHAINFREEE BALANCE MANAGEMENT (2 methods)
 *   7. tryDeductFromChainFree(orderType, size, operation) - Atomically deduct from FREE portion
 *   8. addToChainFree(orderType, size, operation) - Add amount back to optimistic chainFree balance
 *
 * BALANCE ADJUSTMENTS (2 methods)
 *   9. adjustTotalBalance(orderType, delta, operation, totalOnly) - Adjust total and free balances
 *   10. updateOptimisticFreeBalance(oldOrder, newOrder, context, fee, skipAssetAccounting) - Update optimistic balance during transitions
 *
 * FEE MANAGEMENT (2 methods - async)
 *   11. deductBtsFees(requestedSide) - Deduct BTS fees using adjustTotalBalance with deferral strategy
 *   12. modifyCacheFunds(side, delta, operation) - Modify cache funds (rotation surplus + fill proceeds)
 *
 * FILL PROCESSING (1 method)
 *   13. processFillAccounting(fillOp) - Process fund impact of order fill (atomically updates accountTotals)
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

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../constants');
const {
    computeChainFundTotals,
    calculateAvailableFundsValue,
    getAssetFees,
    blockchainToFloat,
    getPrecisionSlack
} = require('./utils/math');
const Format = require('./format');

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
        this._isRecovering = false;  // Prevents nested recovery attempts
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
     * @returns {void}
     */
    recalculateFunds() {
        const mgr = this.manager;
        if (mgr._pauseFundRecalcDepth > 0) return;
        if (!mgr.funds) this.resetFunds();

        let gridBuy = 0, gridSell = 0;
        let chainBuy = 0, chainSell = 0;
        let virtualBuy = 0, virtualSell = 0;

        // AUTO-SYNC SPREAD COUNT
        mgr.currentSpreadCount = mgr._ordersByType[ORDER_TYPES.SPREAD]?.size || 0;

        for (const order of Array.from(mgr.orders.values())) {
            const isActive = (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL);
            const isVirtual = (order.state === ORDER_STATES.VIRTUAL);
            const size = Number(order.size) || 0;
            if (size <= 0) continue;

            // For explicit BUY/SELL orders, use their type; for SPREAD, determine by price
            const isBuy = order.type === ORDER_TYPES.BUY || (order.type === ORDER_TYPES.SPREAD && order.price < mgr.startPrice);
            const isSell = order.type === ORDER_TYPES.SELL || (order.type === ORDER_TYPES.SPREAD && order.price >= mgr.startPrice);

            if (isBuy) {
                if (isActive) gridBuy += size;
                if (isActive) chainBuy += size;
                if (isVirtual) virtualBuy += size;
            } else if (isSell) {
                if (isActive) gridSell += size;
                if (isActive) chainSell += size;
                if (isVirtual) virtualSell += size;
            }
        }

        const chainFreeBuy = mgr.accountTotals?.buyFree || 0;
        const chainFreeSell = mgr.accountTotals?.sellFree || 0;

        mgr.funds.committed.grid = { buy: gridBuy, sell: gridSell };
        mgr.funds.committed.chain = { buy: chainBuy, sell: chainSell };
        mgr.funds.virtual = { buy: virtualBuy, sell: virtualSell };

        const chainTotalBuy = chainFreeBuy + chainBuy;
        const chainTotalSell = chainFreeSell + chainSell;

        mgr.funds.total.chain = { buy: chainTotalBuy, sell: chainTotalSell };
        mgr.funds.total.grid = { buy: gridBuy + virtualBuy, sell: gridSell + virtualSell };

        mgr.funds.available.buy = calculateAvailableFundsValue('buy', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
        mgr.funds.available.sell = calculateAvailableFundsValue('sell', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);

        // Ensure percentage-based allocations are applied to the newly calculated totals
        if (typeof mgr.applyBotFundsAllocation === 'function') {
            mgr.applyBotFundsAllocation();
        }

        if (mgr.logger && mgr.logger.level === 'debug' && mgr._pauseFundRecalcDepth === 0 && mgr._recalcLoggingDepth === 0) {
            mgr.logger.log(`[RECALC] BUY: Total=${Format.formatAmount8(chainTotalBuy)} (Free=${Format.formatAmount8(chainFreeBuy)}, Grid=${Format.formatAmount8(gridBuy)})`, 'debug');
            mgr.logger.log(`[RECALC] SELL: Total=${Format.formatAmount8(chainTotalSell)} (Free=${Format.formatAmount8(chainFreeSell)}, Grid=${Format.formatAmount8(gridSell)})`, 'debug');
        }

        if (mgr._pauseFundRecalcDepth === 0 && !mgr.isBootstrapping && !mgr._isBroadcasting) {
            // Don't await - allow recovery to run in background without blocking
            this._verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell).catch(err => {
                mgr.logger?.log?.(`[RECOVERY] Verification error: ${err.message}`, 'error');
            });
        }
    }

    /**
     * Verify critical fund tracking invariants.
     * Now async to support immediate recovery attempts without blocking.
     */
    async _verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell) {
        const buyPrecision = mgr.assets?.assetB?.precision || 8;
        const sellPrecision = mgr.assets?.assetA?.precision || 8;
        const precisionSlackBuy = getPrecisionSlack(buyPrecision);
        const precisionSlackSell = getPrecisionSlack(sellPrecision);
        const PERCENT_TOLERANCE = (GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE || 0.1) / 100;

        let hasViolation = false;

        // INVARIANT 1: Drift detection
        const expectedBuy = chainFreeBuy + chainBuy;
        const actualBuy = mgr.accountTotals?.buy;
        const diffBuy = Math.abs((actualBuy ?? expectedBuy) - expectedBuy);
        const allowedBuyTolerance = Math.max(precisionSlackBuy, (actualBuy || expectedBuy) * PERCENT_TOLERANCE);

        if (actualBuy !== null && actualBuy !== undefined && diffBuy > allowedBuyTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR instead of WARN
            // Invariant violations indicate serious fund tracking corruption and must not be silent
            // This triggers immediate recovery attempt
            mgr.logger?.log?.(`CRITICAL: Fund invariant violation (BUY): blockchainTotal (${Format.formatAmount8(actualBuy)}) != trackedTotal (${Format.formatAmount8(expectedBuy)}) (diff: ${Format.formatAmount8(diffBuy)}, allowed: ${Format.formatAmount8(allowedBuyTolerance)})`, 'error');
        }

        const expectedSell = chainFreeSell + chainSell;
        const actualSell = mgr.accountTotals?.sell;
        const diffSell = Math.abs((actualSell ?? expectedSell) - expectedSell);
        const allowedSellTolerance = Math.max(precisionSlackSell, (actualSell || expectedSell) * PERCENT_TOLERANCE);

        if (actualSell !== null && actualSell !== undefined && diffSell > allowedSellTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR instead of WARN
            mgr.logger?.log?.(`CRITICAL: Fund invariant violation (SELL): blockchainTotal (${Format.formatAmount8(actualSell)}) != trackedTotal (${Format.formatAmount8(expectedSell)}) (diff: ${Format.formatAmount8(diffSell)}, allowed: ${Format.formatAmount8(allowedSellTolerance)})`, 'error');
        }

        // INVARIANT 2: Surplus check
        const cacheBuy = mgr.funds?.cacheFunds?.buy || 0;
        const cacheSell = mgr.funds?.cacheFunds?.sell || 0;
        if (cacheBuy > chainFreeBuy + allowedBuyTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR - surplus over-estimation can cause overdrafts
            mgr.logger?.log?.(`CRITICAL: Surplus over-estimation (BUY): cacheFunds (${Format.formatAmount8(cacheBuy)}) > chainFree (${Format.formatAmount8(chainFreeBuy)})`, 'error');
        }
        if (cacheSell > chainFreeSell + allowedSellTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR
            mgr.logger?.log?.(`CRITICAL: Surplus over-estimation (SELL): cacheFunds (${Format.formatAmount8(cacheSell)}) > chainFree (${Format.formatAmount8(chainFreeSell)})`, 'error');
        }

        // NEW: Attempt immediate recovery if violation detected
        if (hasViolation) {
            await this._attemptFundRecovery(mgr, 'Fund invariant violation');
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
        // 1. Fetch fresh blockchain state
        await mgr.fetchAccountTotals();

        // 2. Sync from open orders
        const chainOrders = require('../chain_orders');
        const openOrders = await chainOrders.readOpenOrders(mgr.accountId);
        await mgr.syncFromOpenOrders(openOrders, { skipAccounting: false });

        // 3. Validate recovery
        return mgr.validateGridStateForPersistence();
    }

    /**
     * Attempt immediate recovery from fund invariant violations.
     * Runs asynchronously in background without blocking operations.
     * Only runs if stabilization gate hasn't already attempted recovery this cycle.
     *
     * @param {Object} mgr - Manager instance
     * @param {string} violationType - Description of the violation for logging
     * @returns {Promise<boolean>} - True if recovery succeeded, false otherwise
     */
    async _attemptFundRecovery(mgr, violationType) {
        // Prevent nested recovery attempts
        if (this._isRecovering) {
            mgr.logger?.log?.(`[RECOVERY] Recovery already in progress, skipping nested attempt`, 'debug');
            return false;
        }

        // Prevent double recovery if stabilization gate already attempted it
        if (mgr._recoveryAttempted) {
            mgr.logger?.log?.(`[IMMEDIATE-RECOVERY] Recovery already attempted this cycle, skipping`, 'debug');
            return false;
        }

        this._isRecovering = true;
        mgr.logger?.log?.(`[IMMEDIATE-RECOVERY] ${violationType} detected. Attempting recovery...`, 'warn');

        try {
            const validation = await this._performStateRecovery(mgr);

            if (validation.isValid) {
                mgr.logger?.log?.(`[IMMEDIATE-RECOVERY] Recovery succeeded`, 'info');
                mgr._recoveryAttempted = true;  // Mark recovery as attempted
                return true;
            } else {
                mgr.logger?.log?.(`[IMMEDIATE-RECOVERY] Recovery failed: ${validation.reason}. Will retry on next cycle.`, 'error');
                mgr._recoveryAttempted = true;  // Mark recovery as attempted even on failure
                return false;
            }
        } catch (err) {
            mgr.logger?.log?.(`[IMMEDIATE-RECOVERY] Recovery exception: ${err.message}`, 'error');
            mgr._recoveryAttempted = true;  // Mark recovery as attempted
            return false;
        } finally {
            this._isRecovering = false;
        }
    }

    /**
     * Check if sufficient funds exist AND atomically deduct (FREE portion only).
     */
    tryDeductFromChainFree(orderType, size, operation = 'move') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) return false;

        const current = Number(mgr.accountTotals[key]) || 0;
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
     */
    addToChainFree(orderType, size, operation = 'release') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) return false;

        const oldFree = Number(mgr.accountTotals[key]) || 0;
        mgr.accountTotals[key] = oldFree + size;

        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[ACCOUNTING] ${key} +${Format.formatAmount8(size)} (${operation}) -> ${Format.formatAmount8(mgr.accountTotals[key])} (was ${Format.formatAmount8(oldFree)})`, 'debug');
        }
        return true;
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
            const oldFree = Number(mgr.accountTotals[freeKey]) || 0;
            // IMPORTANT: No clamping to 0 here. Allowing temporary negative Free balance
            // ensures the invariant Total = Free + Committed remains stable during
            // the short race between Fill detection and Order state update.
            mgr.accountTotals[freeKey] = oldFree + delta;
        }

        if (mgr.accountTotals[totalKey] !== undefined && mgr.accountTotals[totalKey] !== null) {
            const oldTotal = Number(mgr.accountTotals[totalKey]) || 0;
            mgr.accountTotals[totalKey] = Math.max(0, oldTotal + delta);
        }

        if (mgr.logger && mgr.logger.level === 'debug') {
            const freeMsg = totalOnly ? `Free: (untouched)` : `Free: ${Format.formatAmount8(mgr.accountTotals[freeKey])}`;
            mgr.logger.log(`[ACCOUNTING] ${totalKey} ${delta >= 0 ? '+' : ''}${Format.formatAmount8(delta)} (${operation}) -> Total: ${Format.formatAmount8(mgr.accountTotals[totalKey])}, ${freeMsg}`, 'debug');
        }
    }

    /**
     * Update optimistic balance during transitions.
     * @param {Object} oldOrder - Previous order state
     * @param {Object} newOrder - New order state
     * @param {string} context - Context for logging/tracking
     * @param {number} fee - Blockchain fee to deduct
     * @param {boolean} skipAssetAccounting - If true, skip capital commitment changes (asset amounts) but still process fees
     */
    updateOptimisticFreeBalance(oldOrder, newOrder, context, fee = 0, skipAssetAccounting = false) {
        const mgr = this.manager;
        if (!oldOrder || !newOrder) return;

        if (!skipAssetAccounting) {
            const oldIsActive = (oldOrder.state === ORDER_STATES.ACTIVE || oldOrder.state === ORDER_STATES.PARTIAL);
            const newIsActive = (newOrder.state === ORDER_STATES.ACTIVE || newOrder.state === ORDER_STATES.PARTIAL);
            const oldSize = Number(oldOrder.size) || 0;
            const newSize = Number(newOrder.size) || 0;

            // 1. Handle Capital Commitment (Moves between FREE and LOCKED)
            // For COMMITMENT: Use GRID state (isActive), not blockchain ID
            const oldGridCommitted = oldIsActive ? oldSize : 0;
            const newGridCommitted = newIsActive ? newSize : 0;
            const commitmentDelta = newGridCommitted - oldGridCommitted;

            if (mgr.logger && mgr.logger.level === 'debug') {
                mgr.logger.log(`[ACCOUNTING] updateOptimisticFreeBalance: id=${newOrder.id}, type=${newOrder.type}, state=${oldOrder.state}->${newOrder.state}, size=${oldSize}->${newSize}, delta=${Format.formatAmount8(commitmentDelta)}, context=${context}`, 'debug');
            }

            if (commitmentDelta > 0) {
                // Lock capital: move from Free to Committed
                this.tryDeductFromChainFree(newOrder.type, commitmentDelta, `${context}`);
            } else if (commitmentDelta < 0) {
                // Release capital: move from Committed back to Free
                this.addToChainFree(oldOrder.type, Math.abs(commitmentDelta), `${context}`);
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
        const side = requestedSide || btsSide;

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
        mgr.recalculateFunds();
    }

    async modifyCacheFunds(side, delta, operation = 'update') {
        const mgr = this.manager;
        if (!mgr.funds.cacheFunds) mgr.funds.cacheFunds = { buy: 0, sell: 0 };
        const oldValue = mgr.funds.cacheFunds[side] || 0;
        const newValue = Math.max(0, oldValue + delta);
        mgr.funds.cacheFunds[side] = newValue;
        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[CACHEFUNDS] ${side} ${delta >= 0 ? '+' : ''}${Format.formatAmount8(delta)} (${operation}) -> ${Format.formatAmount8(newValue)}`, 'debug');
        }
        return newValue;
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
        return getAssetFees(assetSymbol, rawAmount, isMaker).netProceeds;
    }

    /**
     * Process the fund impact of an order fill.
     * Atomically updates accountTotals to keep internal state in sync with blockchain.
     * CRITICAL: Called within fill processing lock context to prevent race conditions.
     */
    processFillAccounting(fillOp) {
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
            this.modifyCacheFunds('sell', netAmount, 'fill-proceeds');
        } else if (receives.asset_id === assetBId) {
            const rawAmount = blockchainToFloat(receives.amount, assetBPrecision, true);
            const netAmount = this._deductFeesFromProceeds(assetBSymbol, rawAmount, isMaker);

            this.adjustTotalBalance(ORDER_TYPES.BUY, netAmount, 'fill-receives');
            this.modifyCacheFunds('buy', netAmount, 'fill-proceeds');
        }
    }
}

module.exports = Accountant;
