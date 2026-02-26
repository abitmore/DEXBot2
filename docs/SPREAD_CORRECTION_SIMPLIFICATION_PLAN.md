# Spread Correction Simplification Plan

Date: 2026-02-26  
Branch target: `test`

## Goal

Simplify spread maintenance while preserving stability:

- Keep current double-side replacement behavior.
- Keep existing `n-extra` slot creation when spread is too wide.
- Remove reliance on split/merge-style partial handling for spread correction.
- Ensure correction is always fund-safe and converges smoothly over time using total funds + ideal grid sizing.

## Confirmed Strategy Rules

1. If spread is too wide and `n` slots are missing, create exactly `n` extra edge orders (existing behavior on `test` stays).
2. If the chosen edge candidate is `PARTIAL`, update it toward ideal full size first (fund-capped).
3. New orders must use available funds first.
4. If available funds are insufficient (including zero), run redistribution from existing same-side orders using updated ideal sizing (grid-reset style projection).
5. Keep doubled-side update/replacement behavior unchanged.
6. Do not dynamically modify target spread based on doubled flags.
7. Temporary grid gaps are acceptable; repeated cycles should smooth naturally.

## Why This Change

Observed behavior in `profiles/server-profiles/logs/XRP-BTS.log` after commit `d1a6d9b63c7378c646031500fc1b0c299d0cb5b2`:

- System is generally stable (`SAFE-REBALANCE` + `VALIDATION PASSED` repeatedly).
- Spread correction can fail to execute when it picks a partial update with no blockchain delta:
  - `Spread too wide ... correcting with 1 extra slot(s)`
  - `Identified partial order ... for update`
  - `Skipping size update ... no blockchain delta`
  - `Spread correction batch was prepared but not executed`

This suggests correction should be deterministic, fund-aware, and less coupled to fragile split/merge side effects.

## Scope

### In Scope

- Spread correction planning and funding logic.
- Partial-to-ideal top-up behavior at the edge.
- Funding fallback through redistribution/reprojection.
- Tests for correction and funding edge cases.

### Out of Scope

- Rewriting sync engine fill semantics.
- Changing doubled-side trigger/reset behavior.
- Broad architecture refactors unrelated to spread correction.

## Implementation Plan

### Phase 1 - Lock Target Behavior

1. Keep existing missing-slot detection and `n-extra` decision logic.
2. Ensure correction can produce both:
   - edge partial size update (if candidate is partial), and
   - exactly `n` edge creates.
3. Remove target-spread inflation tied to doubled flags in spread checks.

Primary file: `modules/order/grid.js`

### Phase 2 - Fund-Safe Allocation Pipeline

Build a two-stage funding allocator for correction actions on the selected side.

#### Stage A: Available-Funds First

- Compute available budget:
  - `available = min(funds.available[side], accountTotals.sideFree)`
- Apply available budget to:
  1) partial top-up (edge partial -> ideal),
  2) `n` new edge orders.

#### Stage B: Redistribution Fallback (if Stage A insufficient)

If remaining demand > 0, do a same-side reprojection:

1. Recompute ideal sizes using total side budget and updated side layout (including missing slots to be created).
2. Identify over-allocated existing active/partial orders (size above new ideal).
3. Reduce those orders down toward ideal, respecting minimum size safety.
4. Allocate recovered size to:
   - edge partial top-up first,
   - then new edge orders in edge-priority order.
5. If still insufficient, place only affordable creates (`k <= n`) and log shortfall.

Safety guards:

- Never resize below minimum absolute / dust-safe constraints.
- Never create below health threshold.
- Never spend beyond available + recovered budget.

Primary files: `modules/order/grid.js`, possibly `modules/order/manager.js` (if action merge flow needs small extensions)

### Phase 3 - Keep Double-Side Behavior Untouched

No behavior change in:

- `modules/order/sync_engine.js`
  - doubled full fill -> reset flag + double replacement trigger
  - doubled partial fill -> reset flag + single replacement trigger

This is intentionally preserved for runtime stability.

### Phase 4 - Tests

Add/adjust tests to cover:

1. Spread too wide + `n` missing -> plans `n` creates.
2. Edge partial exists -> partial is topped up toward ideal before/alongside creates.
3. Sufficient available funds -> no redistribution needed.
4. Zero available funds + recoverable excess -> redistribution funds correction.
5. Zero available funds + no recoverable excess -> safe no-op or partial correction only.
6. No target spread mutation from doubled flags.
7. Double-side fill triggers still behave exactly as before.

Likely test files:

- `tests/test_fill_coupled_partial_planner.js` (adjust or split responsibilities)
- new spread-correction funding tests (recommended dedicated file)

## Detailed Correction Ordering

When spread is too wide:

1. Compute `n` missing edge slots.
2. Select preferred side via existing side-selection logic.
3. Build correction candidates:
   - optional edge partial update candidate,
   - `n` nearest free spread slots.
4. Run funding allocator (available-first, redistribution fallback).
5. Emit one COW batch with final `ordersToUpdate` + `ordersToPlace`.
6. If any planned action has zero blockchain delta, skip that action only (do not fail entire correction unless batch would be empty).

## Acceptance Criteria

1. Spread correction does not rely on split/merge maintenance behavior.
2. `n-extra` behavior remains active and deterministic.
3. Partial edge orders can be topped up to ideal target when affordable.
4. New orders never exceed available/recovered budget.
5. With no free funds, redistribution can still fund corrections when over-allocated orders exist.
6. Duplicated/no-delta update edge cases do not cause unstable correction loops.
7. Doubled-side replacement behavior remains unchanged.

## Rollout and Validation

1. Implement behind existing flow (no new config required initially).
2. Run targeted tests for spread correction + fill handling.
3. Replay/observe live log markers:
   - `Spread too wide`
   - `SPREAD-CORRECTION`
   - `Skipping size update ... no blockchain delta`
   - `Spread correction batch was prepared but not executed`
4. Confirm reduced occurrence of aborted correction batches and smoother convergence over several rebalance cycles.

## Notes

- This plan intentionally prioritizes deterministic correction and financial safety over strict contiguous-grid aesthetics.
- Grid smoothness is expected to emerge over repeated cycles from ideal-size reprojection, not from forced split/merge mechanics.
