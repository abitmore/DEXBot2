/**
 * test_tagged_conversions.js
 *
 * Minimal test suite for tagged number conversions.
 * Tests the core defense against double-conversion bugs.
 */

const assert = require('assert');

console.log('Running tagged conversion tests...\n');

const {
    tagAsFloat,
    tagAsBlockchainInt,
    blockchainToFloat,
    floatToBlockchainInt
} = require('../modules/order/utils.js');

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1: BASIC TAGGING
// ════════════════════════════════════════════════════════════════════════════════

console.log('TEST SECTION 1: Basic Tagging');
console.log('─'.repeat(60));

// Test 1.1: Tag as float
const floatTag = tagAsFloat(1.5, 'test');
assert.strictEqual(floatTag.value, 1.5, 'tagAsFloat preserves value');
assert.strictEqual(floatTag.type, 'float', 'tagAsFloat sets type');
console.log('✓ 1.1: tagAsFloat creates proper tag');

// Test 1.2: Tag as blockchain int
const intTag = tagAsBlockchainInt(150000000, 'test');
assert.strictEqual(intTag.value, 150000000, 'tagAsBlockchainInt preserves value');
assert.strictEqual(intTag.type, 'blockchain_int', 'tagAsBlockchainInt sets type');
console.log('✓ 1.2: tagAsBlockchainInt creates proper tag');

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2: BLOCKCHAINTOFLOAT WITH TAGGING
// ════════════════════════════════════════════════════════════════════════════════

console.log('\nTEST SECTION 2: blockchainToFloat with Tagging');
console.log('─'.repeat(60));

// Test 2.1: Without tag returns plain number
const plain = blockchainToFloat(150000000, 8);
assert.strictEqual(plain, 1.5, 'blockchainToFloat returns number');
assert.strictEqual(typeof plain, 'number', 'blockchainToFloat returns plain number');
console.log('✓ 2.1: blockchainToFloat without tag returns plain number');

// Test 2.2: With tag returns tagged value
const tagged = blockchainToFloat(150000000, 8, true);
assert.strictEqual(tagged.value, 1.5, 'blockchainToFloat tag=true converts correctly');
assert.strictEqual(tagged.type, 'float', 'blockchainToFloat tag=true sets type');
console.log('✓ 2.2: blockchainToFloat with tag=true returns tagged value');

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3: TYPE SAFETY - PREVENTION OF DOUBLE CONVERSION
// ════════════════════════════════════════════════════════════════════════════════

console.log('\nTEST SECTION 3: Type Safety - Double Conversion Prevention');
console.log('─'.repeat(60));

// Test 3.1: Reject tagged blockchain int
const badTag = tagAsBlockchainInt(1000000, 'test');
try {
    floatToBlockchainInt(badTag, 5);
    assert.fail('Should reject blockchain_int tag');
} catch (e) {
    assert(e.message.includes('Type error'), 'Error message indicates type error');
    console.log('✓ 3.1: Rejects tagged blockchain_int');
}

// Test 3.2: Accept tagged float
const goodTag = tagAsFloat(1.5, 'test');
const result = floatToBlockchainInt(goodTag, 5);
assert.strictEqual(result, 150000, 'Accepts tagged float');
console.log('✓ 3.2: Accepts tagged float');

// Test 3.3: Accept untagged float
const untagged = floatToBlockchainInt(1.5, 5);
assert.strictEqual(untagged, 150000, 'Accepts untagged float');
console.log('✓ 3.3: Accepts untagged float (backward compat)');

// Test 3.4: Reject suspiciously large untagged value
try {
    floatToBlockchainInt(1e11, 5); // Too large for precision 5
    assert.fail('Should reject suspiciously large value');
} catch (e) {
    assert(e.message.includes('Suspicious magnitude'), 'Detects suspicious magnitude');
    console.log('✓ 3.4: Detects suspiciously large untagged value');
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4: ROUND-TRIP CONVERSIONS
// ════════════════════════════════════════════════════════════════════════════════

console.log('\nTEST SECTION 4: Round-Trip Conversions');
console.log('─'.repeat(60));

// Test 4.1: Float → Int → Float
const original = 2.3456;
const asInt = floatToBlockchainInt(tagAsFloat(original, 'test'), 8);
const back = blockchainToFloat(asInt, 8, true);
assert.strictEqual(Math.abs(back.value - original) < 1e-10, true, 'Round-trip preserves value');
console.log('✓ 4.1: Float → Int → Float preserves value');

// Test 4.2: Int → Float → Int
const blockchainInt = 234560000000;
const asFloat = blockchainToFloat(blockchainInt, 8, true);
const backToInt = floatToBlockchainInt(asFloat, 8);
assert.strictEqual(backToInt, blockchainInt, 'Int round-trip preserves value');
console.log('✓ 4.2: Int → Float → Int preserves value');

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5: EDGE CASES
// ════════════════════════════════════════════════════════════════════════════════

console.log('\nTEST SECTION 5: Edge Cases');
console.log('─'.repeat(60));

// Test 5.1: Zero value
const zeroTag = blockchainToFloat(0, 5, true);
assert.strictEqual(zeroTag.value, 0, 'Handles zero');
console.log('✓ 5.1: Handles zero value');

// Test 5.2: Different precisions
for (let prec of [0, 5, 8, 18]) {
    const test = blockchainToFloat(1000000, prec, true);
    assert.strictEqual(test.type, 'float', `Precision ${prec} preserves type`);
}
console.log('✓ 5.2: Different precision levels (0, 5, 8, 18)');

// Test 5.3: Negative values
const negTag = tagAsBlockchainInt(-500000, 'test');
const negFloat = blockchainToFloat(negTag.value, 5, true);
assert.strictEqual(negFloat.value, -5, 'Handles negative values');
console.log('✓ 5.3: Handles negative values');

// ════════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(60));
console.log('✓ ALL TAGGED CONVERSION TESTS PASSED');
console.log('═'.repeat(60));
console.log('\nSimple, effective defense against double-conversion bugs:');
console.log('  1. Tag blockchain conversions: blockchainToFloat(..., true)');
console.log('  2. Conversion validates types: floatToBlockchainInt()');
console.log('  3. Magnitude heuristic for backward compatibility');
console.log('  4. Zero breaking changes to existing code');
