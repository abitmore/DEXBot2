# COW Invariants (Stable Theory Contract)

This document defines the non-negotiable behavioral invariants for the Copy-on-Write (COW) pipeline. It is a contract for code review and release safety, not a design tutorial.

## Scope

- Applies to COW planning, projection, reconciliation, commit, and fund accounting flows.
- Primary modules: `modules/order/utils/validate.js`, `modules/order/manager.js`, `modules/order/accounting.js`, `modules/order/working_grid.js`.

## Invariants

- `INV-COW-001` Master immutability until commit
  - The master grid must not be mutated during planning/execution prep.
  - All intermediate mutations happen in `WorkingGrid`.
  - Master updates occur only during commit after guard checks pass.

- `INV-COW-002` Commit atomicity
  - Commit swaps working state to master atomically.
  - On failed/aborted execution, working state is discarded and master remains unchanged.

- `INV-REC-001` Rotation-only size updates in reconcile
  - `reconcileGrid` does not emit generic in-place size UPDATEs for active slot diffs.
  - Size-changing UPDATE actions are rotation updates (`newGridId` path).
  - Non-rotation size correction is handled by dedicated maintenance flows.

- `INV-PROJ-001` New projected orders remain virtual
  - Orders projected into empty slots must be `VIRTUAL` with no `orderId` until chain confirmation.

- `INV-PROJ-002` Preserve on-chain PARTIAL size in projection
  - If identity is retained (`keepOrderId=true`) and current state is `PARTIAL`, projected size must preserve current on-chain remaining size.
  - It must not be overwritten by ideal geometric `targetSize`.
  - Preserve-path size must be normalized to finite, non-negative value.

- `INV-PROJ-003` ACTIVE on-chain projection follows target size
  - If identity is retained and state is `ACTIVE`, projection may apply target size normally.

- `INV-ID-001` Order identity retention rule
  - `orderId` and on-chain state are retained only when order is on-chain and side/type is unchanged.
  - Otherwise projected order becomes `VIRTUAL` with `orderId=null`.

- `INV-ACC-001` Committed accounting source of truth
  - Committed chain/grid totals derive only from on-chain orders (`ACTIVE`/`PARTIAL` with `orderId`) and their projected sizes.
  - Virtual orders contribute only to virtual pools, not committed chain totals.

- `INV-ACC-002` Fund invariant consistency
  - Tracked totals must remain consistent with blockchain totals within configured tolerance.
  - False violations due to ideal-size projection overstatement are prohibited.

- `INV-DUST-001` Dust health gating parity
  - Dust health thresholding applies consistently to both CREATE and rotation destination holes.

## Test Mapping

- `INV-COW-001`, `INV-COW-002`
  - `tests/test_cow_master_plan.js` (`COW-001`, `COW-002`)
  - `tests/test_cow_commit_guards.js`

- `INV-REC-001`
  - `tests/test_cow_master_plan.js` (`COW-016`)

- `INV-PROJ-001`
  - `tests/test_cow_master_plan.js` (`COW-012`, `COW-013`, `COW-014`)

- `INV-PROJ-002`
  - `tests/test_cow_master_plan.js` (`COW-018`, `COW-018c`)

- `INV-PROJ-003`
  - `tests/test_cow_master_plan.js` (`COW-018b`)

- `INV-DUST-001`
  - `tests/test_cow_master_plan.js` (`COW-017`)

## Review Checklist (Quick Use)

For any COW/accounting change, reviewers should verify:

- Does it preserve `INV-PROJ-002` for on-chain PARTIAL orders?
- Does it avoid non-rotation size UPDATE leakage in reconcile (`INV-REC-001`)?
- Does it keep virtual/on-chain accounting separation (`INV-ACC-001`)?
- Does it preserve atomic commit semantics (`INV-COW-001`, `INV-COW-002`)?
- Are corresponding regression tests added/updated?

## Change Policy

- Any intentional invariant change must:
  - Update this document in the same PR/commit.
  - Include explicit rationale and risk note.
  - Add or update regression tests linked in Test Mapping.
