/**
 * modules/order/manager.js - OrderManager Engine
 *
 * Core grid-based order management system for DEXBot2.
 * Uses helpers.js for validation and rebalance logic.
 *
 * ===============================================================================
 * TABLE OF CONTENTS
 * ===============================================================================
 *
 * SECTION 1: EXTERNAL DEPENDENCIES
 * SECTION 2: COW REBALANCE ENGINE
 * SECTION 3: STATE MANAGER
 * SECTION 4: ORDER MANAGER CLASS
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: EXTERNAL DEPENDENCIES
// ===============================================================================

const {
    ORDER_TYPES,
    ORDER_STATES,
    REBALANCE_STATES,
    COW_ACTIONS,
    DEFAULT_CONFIG,
    TIMING,
    GRID_LIMITS,
    LOG_LEVEL,
    PIPELINE_TIMING,
    COW_PERFORMANCE
} = require('../constants');
const {
    getMinAbsoluteOrderSize,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValue,
    isExplicitZeroAllocation,
    floatToBlockchainInt,
    getPrecisionSlack
} = require('./utils/math');
const {
    isOrderOnChain,
    isPhantomOrder,
    hasOnChainId,
    convertToSpreadPlaceholder
} = require('./utils/order');
const { persistGridSnapshot, deepFreeze, cloneMap } = require('./utils/system');
const {
    validateOrder,
    validateGridForPersistence,
    calculateRequiredFunds,
    validateWorkingGridFunds,
    checkFundDrift,
    reconcileGrid,
    summarizeActions,
    projectTargetToWorkingGrid,
    buildStateUpdates,
    buildAbortedResult,
    buildSuccessResult,
    evaluateCommit
} = require('./utils/helpers');
const { WorkingGrid } = require('./working_grid');
const Logger = require('./logger');
const AsyncLock = require('./async_lock');
const Accountant = require('./accounting');
const StrategyEngine = require('./strategy');
const SyncEngine = require('./sync_engine');
const Grid = require('./grid');
const Format = require('./format');

const SYNC_SOURCES_MANAGE_OWN_GRID_LOCK = new Set(['readOpenOrders', 'periodicBlockchainFetch']);

// ===============================================================================
// SECTION 2: COW REBALANCE ENGINE
// ===============================================================================

class COWRebalanceEngine {
    constructor(deps) {
        this.strategy = deps.strategy;
        this.logger = deps.logger;
        this.assets = deps.assets;
        this.config = deps.config;
    }

    async execute({
        masterGrid,
        gridVersion,
        boundaryIdx,
        funds,
        fills = [],
        excludeIds = new Set(),
        buySideIsDoubled = false,
        sellSideIsDoubled = false
    }) {
        const startTime = Date.now();

        const workingGrid = new WorkingGrid(masterGrid, { baseVersion: gridVersion });

        const strategyParams = {
            frozenMasterGrid: masterGrid,
            config: this.config,
            accountAssets: this.assets,
            funds,
            excludeIds,
            fills,
            currentBoundaryIdx: boundaryIdx,
            buySideIsDoubled,
            sellSideIsDoubled
        };

        const { targetGrid, boundaryIdx: targetBoundary } = this.strategy.calculateTargetGrid(strategyParams);

        const reconcileResult = reconcileGrid(
            masterGrid,
            targetGrid,
            targetBoundary,
            { logger: (msg, level) => this.logger?.log(msg, level) }
        );

        if (reconcileResult.aborted) {
            return buildAbortedResult(reconcileResult.reason);
        }

        projectTargetToWorkingGrid(workingGrid, targetGrid);

        const precisions = {
            buyPrecision: this.assets?.assetB?.precision,
            sellPrecision: this.assets?.assetA?.precision
        };

        const fundCheck = validateWorkingGridFunds(workingGrid, funds, precisions, this.assets);
        if (!fundCheck.isValid) {
            this.logger?.log(`[COW] Fund validation failed: ${fundCheck.reason}`, 'warn');
            return buildAbortedResult(fundCheck.reason);
        }

        if (workingGrid.isStale()) {
            const reason = workingGrid.getStaleReason() || 'Master grid changed during planning';
            this.logger?.log(`[COW] Rebalance plan invalidated: ${reason}`, 'warn');
            return buildAbortedResult(reason);
        }

        const stateUpdates = buildStateUpdates(reconcileResult.actions, masterGrid);

        const duration = Date.now() - startTime;
        if (duration > 100) {
            this.logger?.log(`[COW] Rebalance planning took ${duration}ms`, 'warn');
        }

        this.logger?.log(
            `[COW] Plan: Actions=${reconcileResult.actions.length}, StateUpdates=${stateUpdates.length}`,
            'info'
        );

        return buildSuccessResult({
            actions: reconcileResult.actions,
            stateUpdates,
            workingGrid,
            workingBoundary: targetBoundary,
            planningDuration: duration
        });
    }
}

// ===============================================================================
// SECTION 3: STATE MANAGER
// ===============================================================================

class StateManager {
    constructor(options = {}) {
        this.logger = options.logger || null;
        this.reset();
    }

    reset() {
        this.rebalance = {
            state: REBALANCE_STATES.NORMAL,
            currentWorkingGrid: null
        };

        this.recovery = {
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0
        };

        this.gridRegen = {
            buy: { armed: true, lastTriggeredAt: 0 },
            sell: { armed: true, lastTriggeredAt: 0 }
        };

        this.bootstrap = {
            isBootstrapping: false
        };

        this.broadcast = {
            isBroadcasting: false
        };

        this.signals = {
            lastIllegalState: null,
            lastAccountingFailure: null
        };

        this.pipeline = {
            blockedSince: null,
            recoveryAttempted: false
        };

        this.sides = {
            buySideIsDoubled: false,
            sellSideIsDoubled: false
        };
    }

    getRebalanceState() {
        return this.rebalance.state;
    }

    setRebalanceState(state) {
        this.rebalance.state = state;
        this.logger?.log(`[COW] Rebalance state: ${state}`, 'debug');
    }

    isRebalancing() {
        return this.rebalance.state === REBALANCE_STATES.REBALANCING;
    }

    isBroadcasting() {
        return this.rebalance.state === REBALANCE_STATES.BROADCASTING;
    }

    setWorkingGrid(workingGrid) {
        this.rebalance.currentWorkingGrid = workingGrid;
    }

    getWorkingGrid() {
        return this.rebalance.currentWorkingGrid;
    }

    clearWorkingGrid() {
        this.rebalance.currentWorkingGrid = null;
    }

    recordRecoveryAttempt() {
        this.recovery.attemptCount++;
        this.recovery.lastAttemptAt = Date.now();
        this.recovery.inFlight = true;
    }

    completeRecovery(success) {
        this.recovery.inFlight = false;
        if (!success) {
            this.recovery.lastFailureAt = Date.now();
        }
    }

    isRecoveryInFlight() {
        return this.recovery.inFlight;
    }

    getRecoveryStats() {
        return { ...this.recovery };
    }

    isSideArmed(side) {
        return this.gridRegen[side]?.armed ?? false;
    }

    disarmSide(side) {
        if (this.gridRegen[side]) {
            this.gridRegen[side].armed = false;
            this.gridRegen[side].lastTriggeredAt = Date.now();
        }
    }

    armSide(side) {
        if (this.gridRegen[side]) {
            this.gridRegen[side].armed = true;
        }
    }

    startBootstrap() {
        this.bootstrap.isBootstrapping = true;
        this.logger?.log('[BOOTSTRAP] Started', 'debug');
    }

    finishBootstrap() {
        this.bootstrap.isBootstrapping = false;
        this.logger?.log('[BOOTSTRAP] Finished', 'debug');
    }

    isBootstrapping() {
        return this.bootstrap.isBootstrapping;
    }

    startBroadcasting() {
        this.broadcast.isBroadcasting = true;
    }

    stopBroadcasting() {
        this.broadcast.isBroadcasting = false;
    }

    isBroadcastingActive() {
        return this.broadcast.isBroadcasting;
    }

    setIllegalStateSignal(signal) {
        this.signals.lastIllegalState = {
            ...signal,
            at: Date.now()
        };
    }

    consumeIllegalStateSignal() {
        const signal = this.signals.lastIllegalState;
        this.signals.lastIllegalState = null;
        return signal;
    }

    setAccountingFailureSignal(signal) {
        this.signals.lastAccountingFailure = {
            ...signal,
            at: Date.now()
        };
    }

    consumeAccountingFailureSignal() {
        const signal = this.signals.lastAccountingFailure;
        this.signals.lastAccountingFailure = null;
        return signal;
    }

    markPipelineBlocked() {
        if (!this.pipeline.blockedSince) {
            this.pipeline.blockedSince = Date.now();
        }
    }

    markPipelineClear() {
        this.pipeline.blockedSince = null;
        this.pipeline.recoveryAttempted = false;
    }

    getPipelineBlockedDuration() {
        return this.pipeline.blockedSince ? Date.now() - this.pipeline.blockedSince : 0;
    }

    isPipelineBlocked() {
        return this.pipeline.blockedSince !== null;
    }

    setSideDoubled(side, isDoubled) {
        if (side === 'buy') {
            this.sides.buySideIsDoubled = isDoubled;
        } else if (side === 'sell') {
            this.sides.sellSideIsDoubled = isDoubled;
        }
    }

    isSideDoubled(side) {
        return side === 'buy' 
            ? this.sides.buySideIsDoubled 
            : this.sides.sellSideIsDoubled;
    }

    getState() {
        return {
            rebalance: { ...this.rebalance, currentWorkingGrid: null },
            recovery: { ...this.recovery },
            gridRegen: { ...this.gridRegen },
            bootstrap: { ...this.bootstrap },
            broadcast: { ...this.broadcast },
            pipeline: { ...this.pipeline }
        };
    }
}

// ===============================================================================
// SECTION 4: ORDER MANAGER CLASS
// ===============================================================================

class OrderManager {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        this.logger = new Logger(LOG_LEVEL);
        this.logger.marketName = this.marketName;
        this.orders = Object.freeze(new Map());
        this.boundaryIdx = null;
        this.targetGrid = null;

        this.accountant = new Accountant(this);
        this.strategy = new StrategyEngine(this);
        this.sync = new SyncEngine(this);

        this._state = new StateManager({ logger: this.logger });

        this._ordersByState = {
            [ORDER_STATES.VIRTUAL]: new Set(),
            [ORDER_STATES.ACTIVE]: new Set(),
            [ORDER_STATES.PARTIAL]: new Set()
        };
        this._ordersByType = {
            [ORDER_TYPES.BUY]: new Set(),
            [ORDER_TYPES.SELL]: new Set(),
            [ORDER_TYPES.SPREAD]: new Set()
        };

        this.resetFunds();
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = 0;
        this.assets = null;
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        this._isFetchingTotals = false;
        this.ordersNeedingPriceCorrection = [];
        this.shadowOrderIds = new Map();

        this._syncLock = new AsyncLock();
        this._fillProcessingLock = new AsyncLock();
        this._divergenceLock = new AsyncLock();
        this._gridLock = new AsyncLock();
        this._fundLock = new AsyncLock({ timeout: 30000 });

        this._recentlyRotatedOrderIds = new Set();
        this._gridSidesUpdated = new Set();
        this._pauseFundRecalc = false;
        this._pauseRecalcLogging = false;
        this._isBroadcasting = false;
        this._throwOnIllegalState = false;
        this._pipelineBlockedSince = null;
        this._recoveryAttempted = false;
        this._gridVersion = 0;

        this._metrics = {
            fundRecalcCount: 0,
            invariantViolations: { buy: 0, sell: 0 },
            lockAcquisitions: 0,
            lockContentionSkips: 0,
            spreadRoleConversionBlocked: 0,
            lastSyncDurationMs: 0,
            metricsStartTime: Date.now()
        };

        this.isBootstrapping = true;
        this._currentWorkingGrid = null;
        this._cowEngine = null;

        this._cleanExpiredLocks();
    }

    _getCOWEngine() {
        if (!this._cowEngine && this.assets) {
            this._cowEngine = new COWRebalanceEngine({
                strategy: this.strategy,
                logger: this.logger,
                assets: this.assets,
                config: this.config
            });
        }
        return this._cowEngine;
    }

    _clearWorkingGridRef() {
        this._currentWorkingGrid = null;
        this._state.clearWorkingGrid();
        this._state.setRebalanceState(REBALANCE_STATES.NORMAL);
    }

    _setRebalanceState(state) {
        this._state.setRebalanceState(state);
    }

    isRebalancing() {
        return this._state.isRebalancing();
    }

    isBroadcasting() {
        return this._state.isBroadcasting();
    }

    isPlanningActive() {
        return this.isRebalancing() || this.isBroadcasting();
    }

    startBootstrap() {
        this.isBootstrapping = true;
        this._state.startBootstrap();
    }

    finishBootstrap() {
        this.isBootstrapping = false;
        this._state.finishBootstrap();
        this.logger.log('[BOOTSTRAP] Finished', 'debug');
    }

    startBroadcasting() {
        this._isBroadcasting = true;
        this._state.startBroadcasting();
    }

    stopBroadcasting() {
        this._isBroadcasting = false;
        this._state.stopBroadcasting();
    }

    resetFunds() {
        return this.accountant.resetFunds();
    }

    async _deductFromChainFree(orderType, size, operation) {
        if (!this.accountant) return;
        return await this.accountant.tryDeductFromChainFree(orderType, size, operation);
    }

    async _addToChainFree(orderType, size, operation) {
        if (!this.accountant) return;
        return await this.accountant.addToChainFree(orderType, size, operation);
    }

    _getCacheFunds(side) {
        return this.funds?.cacheFunds?.[side] || 0;
    }

    _getGridTotal(side) {
        return (this.funds?.committed?.grid?.[side] || 0) + (this.funds?.virtual?.[side] || 0);
    }

    async modifyCacheFunds(side, delta, op) {
        return await this.accountant.modifyCacheFunds(side, delta, op);
    }

    async setCacheFundsAbsolute(side, value, op = 'set-absolute') {
        return await this.accountant.setCacheFundsAbsolute(side, value, op);
    }

    getChainFundsSnapshot() {
        const totals = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = Number.isFinite(Number(this.funds?.allocated?.buy)) ? Number(this.funds.allocated.buy) : totals.chainTotalBuy;
        const allocatedSell = Number.isFinite(Number(this.funds?.allocated?.sell)) ? Number(this.funds.allocated.sell) : totals.chainTotalSell;
        return { ...totals, allocatedBuy, allocatedSell };
    }

    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, true)) return;

        let waitPromise = null;

        await this._fundLock.acquire(async () => {
            if (hasValidAccountTotals(this.accountTotals, true)) return;
            if (!this._accountTotalsPromise) {
                this._accountTotalsPromise = new Promise((resolve) => {
                    this._accountTotalsResolve = resolve;
                });
            }
            waitPromise = this._accountTotalsPromise;
        });

        if (!waitPromise) return;

        await Promise.race([
            waitPromise,
            new Promise((resolve) => {
                setTimeout(() => {
                    this.logger.log('[FUND] Timeout waiting for account totals', 'warn');
                    resolve();
                }, timeoutMs);
            })
        ]);
    }

    async fetchAccountTotals(accountId) {
        if (accountId) this.accountId = accountId;
        await this._fetchAccountBalancesAndSetTotals();
    }

    async _fetchAccountBalancesAndSetTotals() {
        return await this.sync.fetchAccountBalancesAndSetTotals();
    }

    async setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        return await this._fundLock.acquire(async () => {
            return await this._setAccountTotals(totals);
        });
    }

    async _setAccountTotals(totals) {
        if (!this.accountTotals) {
            this.accountTotals = { ...totals };
        } else {
            Object.assign(this.accountTotals, totals);
        }
        if (!this.funds) this.resetFunds();

        await this._recalculateFunds();

        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try {
                this._accountTotalsResolve();
            } catch (e) {
                this.logger?.log?.(`Error resolving account totals promise: ${e.message}`, 'warn');
            }
            this._accountTotalsPromise = null;
            this._accountTotalsResolve = null;
        }
    }

    _triggerAccountTotalsFetchIfNeeded() {
        if (!this._isFetchingTotals) {
            this._isFetchingTotals = true;
            this._fetchAccountBalancesAndSetTotals().finally(() => {
                this._isFetchingTotals = false;
            });
        }
    }

    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;
        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);

        const allocatedBuy = resolveConfigValue(this.config.botFunds.buy, chainTotalBuy);
        const allocatedSell = resolveConfigValue(this.config.botFunds.sell, chainTotalSell);

        if (allocatedBuy === 0 && typeof this.config.botFunds.buy === 'string' && this.config.botFunds.buy.trim().endsWith('%')) {
            if (chainTotalBuy === 0) this._triggerAccountTotalsFetchIfNeeded();
        }
        if (allocatedSell === 0 && typeof this.config.botFunds.sell === 'string' && this.config.botFunds.sell.trim().endsWith('%')) {
            if (chainTotalSell === 0) this._triggerAccountTotalsFetchIfNeeded();
        }

        this.funds.allocated = { buy: allocatedBuy, sell: allocatedSell };

        const shouldCapBuy = allocatedBuy > 0 || isExplicitZeroAllocation(this.config.botFunds.buy);
        const shouldCapSell = allocatedSell > 0 || isExplicitZeroAllocation(this.config.botFunds.sell);

        if (shouldCapBuy) this.funds.available.buy = Math.min(this.funds.available.buy, Math.max(0, allocatedBuy));
        if (shouldCapSell) this.funds.available.sell = Math.min(this.funds.available.sell, Math.max(0, allocatedSell));
    }

    async recalculateFunds() {
        return await this._fundLock.acquire(async () => {
            return await this._recalculateFunds();
        });
    }

    async _recalculateFunds() {
        if (!this.accountant) return;
        this._metrics.fundRecalcCount++;
        await this.accountant.recalculateFunds();
    }

    pauseFundRecalc() {
        this._pauseFundRecalc = true;
    }

    async resumeFundRecalc() {
        this._pauseFundRecalc = false;
        await this.recalculateFunds();
    }

    pauseRecalcLogging() {
        this._pauseRecalcLogging = true;
    }

    resumeRecalcLogging() {
        this._pauseRecalcLogging = false;
    }

    syncFromOpenOrders(orders, info) {
        return this.sync.syncFromOpenOrders(orders, info);
    }

    syncFromFillHistory(fill) {
        return this.sync.syncFromFillHistory(fill);
    }

    async synchronizeWithChain(data, src) {
        if (SYNC_SOURCES_MANAGE_OWN_GRID_LOCK.has(src)) {
            return await this._applySync(data, src);
        }
        return await this._gridLock.acquire(async () => {
            return await this._applySync(data, src);
        });
    }

    async _applySync(data, src) {
        return await this.sync.synchronizeWithChain(data, src);
    }

    async _initializeAssets() {
        return await this.sync.initializeAssets();
    }

    lockOrders(orderIds) {
        if (!orderIds) return;
        const expiration = Date.now() + TIMING.LOCK_TIMEOUT_MS;
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, expiration);
        this._cleanExpiredLocks();
    }

    unlockOrders(orderIds) {
        if (!orderIds) return;
        for (const id of orderIds) if (id) this.shadowOrderIds.delete(id);
        this._cleanExpiredLocks();
    }

    isOrderLocked(id) {
        const expiresAt = this.shadowOrderIds.get(id);
        if (!expiresAt) return false;
        if (Date.now() > expiresAt) {
            this.shadowOrderIds.delete(id);
            return false;
        }
        return true;
    }

    _cleanExpiredLocks() {
        const now = Date.now();
        for (const [id, expiresAt] of this.shadowOrderIds) {
            if (now > expiresAt) {
                this.shadowOrderIds.delete(id);
            }
        }
    }

    async _updateOrder(order, context = 'updateOrder', skipAccounting = false, fee = 0) {
        return await this._gridLock.acquire(async () => {
            return await this._applyOrderUpdate(order, context, skipAccounting, fee);
        });
    }

    async _applyOrderUpdate(order, context = 'updateOrder', skipAccounting = false, fee = 0) {
        const oldOrder = this.orders.get(order.id);
        const validation = validateOrder(order, oldOrder, context);

        for (const warning of validation.warnings) {
            this.logger.log(warning.message, 'warn');
        }

        if (!validation.isValid && validation.errors.length > 0) {
            const fatalError = validation.errors.find(e => e.isFatal || e.code === 'ILLEGAL_SPREAD_STATE');
            if (fatalError) {
                this.logger.log(fatalError.message, 'error');
                this._state.setIllegalStateSignal({
                    id: order.id,
                    context,
                    message: fatalError.message
                });
                if (this._throwOnIllegalState) {
                    const err = new Error(fatalError.message);
                    err.code = fatalError.code;
                    throw err;
                }
                return false;
            }
        }

        const phantomError = validation.errors.find(e => e.code === 'PHANTOM_ORDER');
        if (phantomError && phantomError.autoCorrect) {
            this.logger.log(phantomError.message, 'error');
            Object.assign(order, phantomError.autoCorrect);
        }

        const nextOrder = validation.normalizedOrder;

        if (this.accountant) {
            await this.accountant.updateOptimisticFreeBalance(oldOrder, nextOrder, context, fee, skipAccounting);
        }

        const updatedOrder = deepFreeze({ ...nextOrder });
        const id = order.id;
        Object.values(this._ordersByState).forEach(set => set.delete(id));
        Object.values(this._ordersByType).forEach(set => set.delete(id));

        if (this._ordersByState[updatedOrder.state]) {
            this._ordersByState[updatedOrder.state].add(id);
        }
        if (this._ordersByType[updatedOrder.type]) {
            this._ordersByType[updatedOrder.type].add(id);
        }

        const newMap = cloneMap(this.orders);
        newMap.set(id, updatedOrder);
        this.orders = Object.freeze(newMap);
        this._gridVersion++;

        this._syncWorkingGridFromMasterMutation(id, context);

        if (!this._pauseFundRecalc) {
            await this.recalculateFunds();
        }

        return true;
    }

    _syncWorkingGridFromMasterMutation(orderId, context) {
        if (!this._currentWorkingGrid || !this.isPlanningActive()) {
            return;
        }

        try {
            this._currentWorkingGrid.markStale(
                `master mutation during ${this._rebalanceState.toLowerCase()} (${context})`
            );
            this._currentWorkingGrid.syncFromMaster(this.orders, orderId, this._gridVersion);
        } catch (syncErr) {
            this._currentWorkingGrid.markStale(`working-grid sync failure: ${syncErr.message}`);
            this.logger.log(`[COW] Failed to sync working grid for order ${orderId}: ${syncErr.message}`, 'warn');
        }
    }

    async applyGridUpdateBatch(updates, context = 'batch-update', skipAccounting = false) {
        return await this._gridLock.acquire(async () => {
            for (const update of updates) {
                await this._applyOrderUpdate(update, context, skipAccounting);
            }
            return true;
        });
    }

    async processFilledOrders(orders, excl, options) {
        return await this.strategy.processFilledOrders(orders, excl, options);
    }

    completeOrderRotation(oldInfo) {
        return this.strategy.completeOrderRotation(oldInfo);
    }

    getInitialOrdersToActivate() {
        const result = [];
        for (const [id, order] of this.orders) {
            if (order.state === ORDER_STATES.VIRTUAL && order.size > 0 && order.type !== ORDER_TYPES.SPREAD) {
                result.push(order);
            }
        }
        return result;
    }

    getOrdersByTypeAndState(type, state) {
        const result = [];
        const ids = this._ordersByState[state];
        if (!ids) return result;
        for (const id of ids) {
            const order = this.orders.get(id);
            if (order && order.type === type) {
                result.push(order);
            }
        }
        return result;
    }

    getPartialOrdersOnSide(type) {
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL);
    }

    validateIndices() {
        for (const [id, order] of this.orders) {
            if (!order) {
                this.logger.log(`Index corruption: ${id} exists in orders Map but is null/undefined`, 'error');
                return false;
            }
            if (!order.state) {
                this.logger.log(`Index corruption: ${id} has no state`, 'error');
                return false;
            }
            if (!order.type) {
                this.logger.log(`Index corruption: ${id} has no type`, 'error');
                return false;
            }
            if (!this._ordersByState[order.state]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByState[${order.state}]`, 'error');
                return false;
            }
            if (!this._ordersByType[order.type]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByType[${order.type}]`, 'error');
                return false;
            }
        }

        for (const [state, orderIds] of Object.entries(this._ordersByState)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByState[${state}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        for (const [type, orderIds] of Object.entries(this._ordersByType)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByType[${type}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        return true;
    }

    assertIndexConsistency() {
        if (!this.validateIndices()) {
            this.logger.log('CRITICAL: Index corruption detected! Attempting repair...', 'error');
            return this._repairIndices();
        }
        return true;
    }

    _repairIndices() {
        try {
            const rebuiltByState = {
                [ORDER_STATES.VIRTUAL]: new Set(),
                [ORDER_STATES.ACTIVE]: new Set(),
                [ORDER_STATES.PARTIAL]: new Set()
            };
            const rebuiltByType = {
                [ORDER_TYPES.BUY]: new Set(),
                [ORDER_TYPES.SELL]: new Set(),
                [ORDER_TYPES.SPREAD]: new Set()
            };

            for (const [id, order] of this.orders) {
                if (order && order.state && order.type) {
                    rebuiltByState[order.state]?.add(id);
                    rebuiltByType[order.type]?.add(id);
                } else {
                    this.logger.log(`Skipping corrupted order ${id} during index repair`, 'warn');
                }
            }

            this._ordersByState = rebuiltByState;
            this._ordersByType = rebuiltByType;

            if (this.validateIndices()) {
                this.logger.log('✓ Index repair successful', 'info');
                return true;
            }

            this.logger.log('✗ Index repair failed - structure is damaged', 'error');
            return false;
        } catch (e) {
            this.logger.log(`Index repair failed with exception: ${e.message}`, 'error');
            return false;
        }
    }

    consumeIllegalStateSignal() {
        return this._state.consumeIllegalStateSignal();
    }

    consumeAccountingFailureSignal() {
        return this._state.consumeAccountingFailureSignal();
    }

    async checkSpreadCondition(BitShares, batchCb) {
        return await Grid.checkSpreadCondition(this, BitShares, batchCb);
    }

    async checkGridHealth(batchCb) {
        return await Grid.checkGridHealth(this, batchCb);
    }

    calculateCurrentSpread() {
        return Grid.calculateCurrentSpread(this);
    }

    checkFundDriftAfterFills() {
        if (!this.assets || !hasValidAccountTotals(this.accountTotals)) {
            return { isValid: true, reason: 'Skipped: missing assets or totals' };
        }
        return checkFundDrift(this.orders, this.accountTotals, this.assets);
    }

    isPipelineEmpty(pipelineSignals = 0) {
        this._cleanExpiredLocks();

        const normalizedSignals = (typeof pipelineSignals === 'number')
            ? { incomingFillQueueLength: pipelineSignals }
            : (pipelineSignals || {});

        const incomingFillQueueLength = Number(normalizedSignals.incomingFillQueueLength) || 0;
        const batchInFlight = !!normalizedSignals.batchInFlight;
        const retryInFlight = !!normalizedSignals.retryInFlight;
        const recoveryInFlight = !!normalizedSignals.recoveryInFlight;

        const reasons = [];

        if (incomingFillQueueLength > 0) {
            reasons.push(`${incomingFillQueueLength} fills queued`);
        }
        if (this.ordersNeedingPriceCorrection.length > 0) {
            reasons.push(`${this.ordersNeedingPriceCorrection.length} corrections pending`);
        }
        if (this._gridSidesUpdated?.size > 0) {
            reasons.push('grid divergence corrections pending');
        }
        if (batchInFlight) {
            reasons.push('batch broadcast in-flight');
        }
        if (retryInFlight) {
            reasons.push('batch retry in-flight');
        }
        if (recoveryInFlight) {
            reasons.push('recovery sync in-flight');
        }
        if (this._isBroadcasting) {
            reasons.push('broadcasting active orders');
        }

        if (reasons.length > 0 && !this._pipelineBlockedSince) {
            this._pipelineBlockedSince = Date.now();
            this._state.markPipelineBlocked();
        } else if (reasons.length === 0) {
            this._pipelineBlockedSince = null;
            this._state.markPipelineClear();
        }

        return {
            isEmpty: reasons.length === 0,
            reasons
        };
    }

    clearStalePipelineOperations() {
        if (!this._pipelineBlockedSince) return false;
        const age = Date.now() - this._pipelineBlockedSince;
        if (age < PIPELINE_TIMING.TIMEOUT_MS) return false;

        this.ordersNeedingPriceCorrection = [];
        this._gridSidesUpdated.clear();
        this._pipelineBlockedSince = null;
        this._state.markPipelineClear();
        return true;
    }

    getPipelineHealth() {
        const blockedDuration = this._pipelineBlockedSince
            ? Date.now() - this._pipelineBlockedSince
            : 0;

        return {
            isBlocked: this._pipelineBlockedSince !== null,
            blockedDurationMs: blockedDuration,
            hasStalled: blockedDuration > (PIPELINE_TIMING.TIMEOUT_MS || 300000),
            recoveryAttempted: this._recoveryAttempted,
            correctionsPending: this.ordersNeedingPriceCorrection.length,
            gridSidesUpdated: this._gridSidesUpdated?.size || 0
        };
    }

    reconcileGrid(targetGrid, targetBoundary) {
        return reconcileGrid(this.orders, targetGrid, targetBoundary, {
            logger: (msg, level) => this.logger.log(msg, level)
        });
    }

    async performSafeRebalance(fills = [], excludeIds = new Set()) {
        this.logger.log("[SAFE-REBALANCE] Starting with COW...", "info");
        return await this._gridLock.acquire(async () => {
            return await this._applySafeRebalanceCOW(fills, excludeIds);
        });
    }

    async _applySafeRebalanceCOW(fills = [], excludeIds = new Set()) {
        const cowEngine = this._getCOWEngine();
        if (!cowEngine) {
            return buildAbortedResult('COW Engine not initialized (assets not available)');
        }

        this._setRebalanceState(REBALANCE_STATES.REBALANCING);

        const result = await cowEngine.execute({
            masterGrid: this.orders,
            gridVersion: this._gridVersion,
            boundaryIdx: this.boundaryIdx,
            funds: this.getChainFundsSnapshot(),
            fills,
            excludeIds,
            buySideIsDoubled: this._state.isSideDoubled('buy'),
            sellSideIsDoubled: this._state.isSideDoubled('sell')
        });

        if (result.aborted) {
            this._clearWorkingGridRef();
            return result;
        }

        this._currentWorkingGrid = result.workingGrid;
        return result;
    }

    _reconcileGridCOW(targetGrid, targetBoundary, workingGrid) {
        const result = this.reconcileGrid(targetGrid, targetBoundary);
        if (result.aborted) return result;

        projectTargetToWorkingGrid(workingGrid, targetGrid);

        const actions = result.actions || [];
        return {
            ...result,
            total: actions.length,
            creates: actions.filter(a => a.type === COW_ACTIONS.CREATE).length,
            cancels: actions.filter(a => a.type === COW_ACTIONS.CANCEL).length,
            updates: actions.filter(a => a.type === COW_ACTIONS.UPDATE).length
        };
    }

    _validateWorkingGridFunds(workingGrid, projectedFunds) {
        return validateWorkingGridFunds(workingGrid, projectedFunds, {
            buyPrecision: this.assets?.assetB?.precision,
            sellPrecision: this.assets?.assetA?.precision
        }, this.assets);
    }

    _calculateRequiredFundsFromGrid(workingGrid, precisions = {}) {
        return calculateRequiredFunds(workingGrid, {
            buyPrecision: precisions.buyPrecision || this.assets?.assetB?.precision,
            sellPrecision: precisions.sellPrecision || this.assets?.assetA?.precision
        });
    }

    _buildStateUpdates(actions, masterGrid) {
        return buildStateUpdates(actions, masterGrid);
    }

    _buildAbortedCOWResult(reason) {
        return buildAbortedResult(reason);
    }

    async _commitWorkingGrid(workingGrid, workingIndexes, workingBoundary) {
        const startTime = Date.now();
        const stats = workingGrid.getMemoryStats();

        const preCommitGuard = evaluateCommit(workingGrid, {
            hasLock: false,
            currentVersion: this._gridVersion,
            masterGrid: this.orders
        });
        if (!preCommitGuard.canCommit) {
            this.logger.log(`[COW] ${preCommitGuard.reason}`, preCommitGuard.level || 'warn');
            this._clearWorkingGridRef();
            return;
        }

        await this._gridLock.acquire(async () => {
            const lockCommitGuard = evaluateCommit(workingGrid, {
                hasLock: true,
                currentVersion: this._gridVersion,
                masterGrid: this.orders
            });
            if (!lockCommitGuard.canCommit) {
                this.logger.log(`[COW] ${lockCommitGuard.reason}`, lockCommitGuard.level || 'warn');
                this._clearWorkingGridRef();
                return;
            }

            this.logger.log(
                `[COW] Committing working grid: ${stats.size} orders, ${stats.modified} modified`,
                'debug'
            );

            this.orders = Object.freeze(workingGrid.toMap());
            this.boundaryIdx = workingBoundary;
            this._gridVersion++;

            const freshIndexes = workingGrid.getIndexes();
            this._ordersByState = {
                [ORDER_STATES.VIRTUAL]: freshIndexes[ORDER_STATES.VIRTUAL] || new Set(),
                [ORDER_STATES.ACTIVE]: freshIndexes[ORDER_STATES.ACTIVE] || new Set(),
                [ORDER_STATES.PARTIAL]: freshIndexes[ORDER_STATES.PARTIAL] || new Set()
            };
            this._ordersByType = {
                [ORDER_TYPES.BUY]: freshIndexes[ORDER_TYPES.BUY] || new Set(),
                [ORDER_TYPES.SELL]: freshIndexes[ORDER_TYPES.SELL] || new Set(),
                [ORDER_TYPES.SPREAD]: freshIndexes[ORDER_TYPES.SPREAD] || new Set()
            };
        });

        try {
            await this.recalculateFunds();
            const duration = Date.now() - startTime;
            this.logger.log(`[COW] Grid committed in ${duration}ms`, 'debug');

            if (stats.size > COW_PERFORMANCE.GRID_MEMORY_WARNING) {
                this.logger.log(
                    `[COW] Warning: Large grid size (${stats.size} orders). Peak memory: ~${Math.round(stats.estimatedBytes / 1024)}KB`,
                    'warn'
                );
            }
        } catch (recalcErr) {
            this.logger.log(`[COW] Fund recalculation failed post-commit: ${recalcErr.message}`, 'error');
        } finally {
            this._clearWorkingGridRef();
        }
    }

    validateGridStateForPersistence() {
        const result = validateGridForPersistence(this.orders, this.accountTotals);

        if (!result.isValid && this.isBootstrapping) {
            this.logger.log(`[BOOTSTRAP] Transient state (expected): ${result.reason}`, 'debug');
            return { isValid: true, reason: null };
        }

        return result;
    }

    async persistGrid() {
        const validation = this.validateGridStateForPersistence();
        if (!validation.isValid) {
            this.logger.log(
                `[PERSISTENCE-GATE] Skipping persistence of corrupted state: ${validation.reason}`,
                'warn'
            );
            return validation;
        }

        await persistGridSnapshot(this, this.accountOrders, this.config.botKey);
        return validation;
    }

    getMetrics() {
        return {
            ...this._metrics,
            state: this._state.getState(),
            currentTime: Date.now()
        };
    }

    _projectTargetToWorkingGrid(workingGrid, targetGrid) {
        return projectTargetToWorkingGrid(workingGrid, targetGrid);
    }

    _summarizeCowActions(actions) {
        return summarizeActions(actions);
    }

    _evaluateWorkingGridCommit(workingGrid, hasLock = false) {
        return evaluateCommit(workingGrid, {
            hasLock,
            currentVersion: this._gridVersion,
            masterGrid: this.orders
        });
    }

    get _rebalanceState() {
        return this._state.getRebalanceState();
    }

    set _rebalanceState(value) {
        this._state.setRebalanceState(value);
    }

    get _lastIllegalState() {
        return this._state.signals?.lastIllegalState || null;
    }

    set _lastIllegalState(value) {
        if (value) {
            this._state.setIllegalStateSignal(value);
        }
    }

    get _lastAccountingFailure() {
        return this._state.signals?.lastAccountingFailure || null;
    }

    set _lastAccountingFailure(value) {
        if (value) {
            this._state.setAccountingFailureSignal(value);
        }
    }

    get _recoveryState() {
        return this._state.recovery;
    }

    set _recoveryState(value) {
        const fallback = {
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0
        };
        this._state.recovery = {
            ...fallback,
            ...(value && typeof value === 'object' ? value : {})
        };
    }

    get _gridRegenState() {
        return this._state.gridRegen;
    }

    set _gridRegenState(value) {
        if (!value || typeof value !== 'object') return;

        const defaultSide = { armed: true, lastTriggeredAt: 0 };
        this._state.gridRegen = {
            buy: { ...defaultSide, ...(value.buy || {}) },
            sell: { ...defaultSide, ...(value.sell || {}) }
        };
    }

    get buySideIsDoubled() {
        return this._state.isSideDoubled('buy');
    }

    set buySideIsDoubled(value) {
        this._state.setSideDoubled('buy', value);
    }

    get sellSideIsDoubled() {
        return this._state.isSideDoubled('sell');
    }

    set sellSideIsDoubled(value) {
        this._state.setSideDoubled('sell', value);
    }
}

module.exports = { OrderManager };
