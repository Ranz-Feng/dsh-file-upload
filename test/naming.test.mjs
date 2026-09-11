import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSegment, formatMention, sanitizeName } from '../lib/naming.js';

test('sanitizeName removes separators and traversal tokens', () => {
	assert.equal(sanitizeName('../../etc/passwd'), '.._.._etc_passwd');
	assert.equal(sanitizeName('/etc/passwd'), '_etc_passwd');
	assert.equal(sanitizeName('a\\b\\c.txt'), 'a_b_c.txt');
	assert.equal(sanitizeName('..'), 'upload');
	assert.equal(sanitizeName('.'), 'upload');
	assert.equal(sanitizeName(''), 'upload');
	assert.equal(sanitizeName('   '), 'upload');
	assert.equal(sanitizeName('trailing.'), 'trailing');
	assert.equal(sanitizeName('nul\u0000byte.txt'), 'nul_byte.txt');
});

test('sanitizeName keeps legitimate names, including leading dots', () => {
	assert.equal(sanitizeName('.env'), '.env');
	assert.equal(sanitizeName('report-2024 Q3.pdf'), 'report-2024 Q3.pdf');
	assert.equal(sanitizeName('数据.csv'), '数据.csv');
});

test('sanitizeName truncates by bytes and keeps the final extension', () => {
	const multiByte = `${'あ'.repeat(200)}.tar.gz`;
	const name = sanitizeName(multiByte);
	assert.ok(Buffer.byteLength(name) <= 160, `expected <=160 bytes, got ${String(Buffer.byteLength(name))}`);
	// Only the last extension survives (the rule browsers apply too), and
	// truncation must never split a code point into a replacement character.
	assert.ok(name.endsWith('.gz'));
	assert.ok(!name.includes('\ufffd'));
	const simple = sanitizeName(`${'x'.repeat(400)}.csv`);
	assert.ok(Buffer.byteLength(simple) <= 160);
	assert.ok(simple.endsWith('.csv'));
});

test('encodeSegment keeps ordinary ids and hashes everything else', () => {
	assert.equal(encodeSegment('3f2b1c9e-7a44-4d10-9c3e-2b6f5a1d8e77'), '3f2b1c9e-7a44-4d10-9c3e-2b6f5a1d8e77');
	assert.match(encodeSegment('../../../etc'), /^s-[0-9a-f]{16}$/);
	assert.match(encodeSegment(''), /^s-[0-9a-f]{16}$/);
	assert.equal(encodeSegment('..'), encodeSegment('..'));
	assert.notEqual(encodeSegment('..'), encodeSegment('.'));
});

test('formatMention quotes only what the grammar requires', () => {
	assert.equal(formatMention('.dsh/uploads/s/a1-report.pdf'), '@.dsh/uploads/s/a1-report.pdf');
	assert.equal(formatMention('.dsh/uploads/s/a1-my report.pdf'), '@".dsh/uploads/s/a1-my report.pdf"');
});
