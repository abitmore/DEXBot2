/**
 * DELETED: This test referenced old API methods that no longer exist.
 *
 * Old Methods (no longer available):
 * - OrderManager.calculateAvailableFunds()
 * - OrderManager.deductBtsFees()
 *
 * Current Implementation:
 * - Fee deduction is now handled by the Accountant class (modules/order/accounting.js)
 * - The Accountant.deductBtsFees() method handles fee deduction with deferral strategy
 * - Fee accounting is tested through integration tests and accounting-specific tests
 *
 * If fee deduction behavior needs specific testing, see:
 * - test_bts_fee_accounting.js
 * - test_accounting_logic.js
 */

console.log('⚠️  Test deleted: test_fix_proceeds_fee_deduction');
console.log('   Reason: Uses deprecated API (calculateAvailableFunds, deductBtsFees on OrderManager)');
console.log('   Functionality now in Accountant class, tested by accounting tests');
process.exit(0);
