'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Config snapshots process.env at module load — set the whitelist override
// BEFORE the first project require() so these tests never touch the real
// profiles/market_adapter_whitelist.json.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-adapter-flags-'));
const WHITELIST_FILE = path.join(TEMP_DIR, 'market_adapter_whitelist.json');
process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = WHITELIST_FILE;

const { parseBooleanInput } = require('../modules/account_bots');
const {
    setWhitelistFlags,
    renameWhitelistEntry,
    removeWhitelistEntry,
    getWhitelistFlags,
    resetMarketAdapterWhitelistCache,
} = require('../modules/market_adapter_whitelist');

function writeDoc(doc) {
    fs.writeFileSync(WHITELIST_FILE, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n', 'utf8');
    // Raw fs writes bypass the module's own write path, so refresh its cache.
    resetMarketAdapterWhitelistCache();
}

function readDoc() {
    return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
}

function testParseBooleanInputAcceptsYesSpellings() {
    for (const raw of ['y', 'Y', 'yes', 'YES', 'true', 'TRUE', '1', 't', ' T ']) {
        const parsed = parseBooleanInput(raw, false);
        assert.strictEqual(parsed.ok, true, `'${raw}' should be recognized`);
        assert.strictEqual(parsed.value, true, `'${raw}' should parse as true`);
    }
}

function testParseBooleanInputAcceptsNoSpellings() {
    for (const raw of ['n', 'N', 'no', 'NO', 'false', 'FALSE', '0', 'f']) {
        const parsed = parseBooleanInput(raw, true);
        assert.strictEqual(parsed.ok, true, `'${raw}' should be recognized`);
        assert.strictEqual(parsed.value, false, `'${raw}' should parse as false`);
    }
}

function testParseBooleanInputKeepsDefaultAndRejectsGarbage() {
    assert.strictEqual(parseBooleanInput('', true).value, true, 'empty input keeps a true default');
    assert.strictEqual(parseBooleanInput('   ', false).value, false, 'blank input keeps a false default');
    assert.strictEqual(parseBooleanInput('maybe', true).ok, false, 'unknown words must be rejected');
    assert.strictEqual(parseBooleanInput('2', true).ok, false, 'unlisted numbers must be rejected');
    assert.strictEqual(parseBooleanInput(true as any, false).value, true, 'boolean input coerces via String()');
}

function testSetWhitelistFlagsRoundTrip() {
    writeDoc({ whitelist: {}, meta: { keep: 1 } });

    assert.strictEqual(setWhitelistFlags('bot-a', { ama: true }), true);
    assert.deepStrictEqual(
        getWhitelistFlags('bot-a'),
        { ama: true, dynamicWeight: false, asymmetricBounds: false },
        'Price-only entry should round-trip through the file'
    );

    // Partial update must keep the flags it does not mention.
    assert.strictEqual(setWhitelistFlags('bot-a', { asymmetricBounds: true }), true);
    assert.deepStrictEqual(
        getWhitelistFlags('bot-a'),
        { ama: true, dynamicWeight: false, asymmetricBounds: true },
        'omitted flags keep their current value'
    );

    // Explicit all-off keeps a protective entry so the bot stays explicitly
    // disabled rather than falling back to absent/default flags.
    assert.strictEqual(setWhitelistFlags('bot-a', { ama: false, dynamicWeight: false, asymmetricBounds: false }), true);
    const doc = readDoc();
    assert.deepStrictEqual(doc.whitelist['bot-a'], { ama: false, dynamicWeight: false, asymmetricBounds: false });
    assert.strictEqual(doc.meta.keep, 1, 'unrelated top-level keys survive the write');
    assert.strictEqual(setWhitelistFlags('', { ama: true }), false, 'empty botKey must refuse to write');
}

function testLegacyArrayFormUpgrade() {
    writeDoc({ whitelist: ['legacy-bot'] });
    assert.deepStrictEqual(
        getWhitelistFlags('legacy-bot'),
        { ama: true, dynamicWeight: false, asymmetricBounds: false },
        'legacy array entries stay readable before any write'
    );

    assert.strictEqual(setWhitelistFlags('bot-b', { asymmetricBounds: true }), true);
    const doc = readDoc();
    assert.ok(!Array.isArray(doc.whitelist), 'legacy array form is upgraded to the object form');
    assert.deepStrictEqual(doc.whitelist['legacy-bot'], { ama: true, dynamicWeight: false, asymmetricBounds: false });
    assert.deepStrictEqual(doc.whitelist['bot-b'], { ama: false, dynamicWeight: false, asymmetricBounds: true });
    assert.deepStrictEqual(Object.keys(doc.whitelist), ['bot-b', 'legacy-bot'], 'keys stay sorted on write');
}

function testMalformedFileIsNeverOverwritten() {
    writeDoc('{ not json');
    const before = fs.readFileSync(WHITELIST_FILE, 'utf8');
    assert.strictEqual(setWhitelistFlags('bot-c', { ama: true }), false, 'malformed file must abort the write');
    assert.strictEqual(renameWhitelistEntry('a', 'b'), false, 'malformed file must abort the rename');
    assert.strictEqual(fs.readFileSync(WHITELIST_FILE, 'utf8'), before, 'malformed file left untouched');
}

function testRenameWhitelistEntry() {
    const entry = { ama: true, dynamicWeight: true, asymmetricBounds: false };
    writeDoc({ whitelist: { 'old-name': entry } });

    assert.strictEqual(renameWhitelistEntry('old-name', 'new-name'), true);
    let doc = readDoc();
    assert.strictEqual(doc.whitelist['old-name'], undefined, 'old key removed after rename');
    assert.deepStrictEqual(doc.whitelist['new-name'], entry, 'entry moved with its flags intact');

    // Renaming a bot that has no entry is a no-op, not an error.
    assert.strictEqual(renameWhitelistEntry('ghost', 'ghost-2'), true);

    // A key collision must never destroy the occupant's flags.
    writeDoc({ whitelist: { taken: { ama: false, dynamicWeight: false, asymmetricBounds: false }, other: entry } });
    assert.strictEqual(renameWhitelistEntry('other', 'taken'), false, 'occupied target refuses the move');
    assert.strictEqual(renameWhitelistEntry('ghost', 'taken'), false, 'occupied target refuses even when the source entry is missing');
    doc = readDoc();
    assert.deepStrictEqual(doc.whitelist.taken, { ama: false, dynamicWeight: false, asymmetricBounds: false }, 'occupant keeps its flags');
    assert.deepStrictEqual(doc.whitelist.other, entry, 'source entry is left in place');
}

function testRemoveWhitelistEntry() {
    writeDoc({
        whitelist: {
            'bot-a': { ama: true, dynamicWeight: true, asymmetricBounds: true },
            'bot-b': { ama: true, dynamicWeight: false, asymmetricBounds: false },
        },
        meta: { keep: 1 },
    });

    assert.strictEqual(removeWhitelistEntry('bot-a'), true);
    const doc = readDoc();
    assert.strictEqual(doc.whitelist['bot-a'], undefined, 'deleted bot entry is wiped from the whitelist');
    assert.deepStrictEqual(doc.whitelist['bot-b'], { ama: true, dynamicWeight: false, asymmetricBounds: false }, 'other entries survive the delete');
    assert.strictEqual(doc.meta.keep, 1, 'unrelated top-level keys survive the removal');

    // Missing key and empty key are no-ops, not errors.
    assert.strictEqual(removeWhitelistEntry('ghost'), true, 'missing entry is a no-op');
    assert.strictEqual(removeWhitelistEntry(''), true, 'empty key is a no-op');

    // A malformed file must abort the write, exactly like set/rename.
    writeDoc('{ not json');
    const before = fs.readFileSync(WHITELIST_FILE, 'utf8');
    assert.strictEqual(removeWhitelistEntry('bot-b'), false, 'malformed file must abort the removal');
    assert.strictEqual(fs.readFileSync(WHITELIST_FILE, 'utf8'), before, 'malformed file left untouched');
}

function main() {
    console.log('Running account bot adapter flag tests');
    testParseBooleanInputAcceptsYesSpellings();
    testParseBooleanInputAcceptsNoSpellings();
    testParseBooleanInputKeepsDefaultAndRejectsGarbage();
    testSetWhitelistFlagsRoundTrip();
    testLegacyArrayFormUpgrade();
    testMalformedFileIsNeverOverwritten();
    testRenameWhitelistEntry();
    testRemoveWhitelistEntry();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    console.log('account bot adapter flag tests passed');
}

main();
