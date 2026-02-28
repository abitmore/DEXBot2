/**
 * DELETED: This test was written for an earlier version of the accounting system
 * where proceeds persisted as a separate intermediate state.
 *
 * Current System:
 * - Proceeds are immediately consumed by rebalance operations (grid placement)
 * - Fee calculations still work, but test expectations were based on old behavior
 * - Current fee accounting is tested by test_bts_fee_accounting.js and test_fee_backwards_compat.js
 *
 * The functionality being tested (fee deduction) is preserved in the current system
 * but the test itself is no longer valid.
 */

console.log('⚠️  Test deleted: test_fee_refinement');
console.log('   Reason: Tests old accounting behavior that changed');
console.log('   Current fee tests: test_bts_fee_accounting.js, test_fee_backwards_compat.js');
process.exit(0);
