import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64, decodedLength, isCanonicalBase64, planUpload, UploadError } from '../lib/protocol.js';

const limits = { maxFileBytes: 8, maxFiles: 2, maxBatchBytes: 12 };
const base64 = (value) => Buffer.from(value).toString('base64');

test('decodeBase64 accepts canonical base64 and rejects everything else', () => {
	assert.deepEqual([...decodeBase64(base64('hello'))], [...Buffer.from('hello')]);
	assert.throws(() => decodeBase64('aGVsbG8'), (error) => error instanceof UploadError && error.code === 'invalid');
	assert.throws(() => decodeBase64('aGVs bG8='), (error) => error instanceof UploadError);
	assert.throws(() => decodeBase64(42), (error) => error instanceof UploadError);
});

test('planUpload accepts a well-formed batch and sanitizes names', () => {
	const plan = planUpload({ sessionId: 's', files: [{ name: '../evil.txt', data: base64('hi') }] }, limits);
	assert.equal(plan.sessionId, 's');
	assert.equal(plan.files.length, 1);
	assert.equal(plan.files[0].name, '.._evil.txt');
	assert.equal(plan.files[0].bytes.byteLength, 2);
});

test('planUpload refuses shape violations', () => {
	for (const payload of [null, 'x', {}, { sessionId: '' }, { sessionId: 's' }, { sessionId: 's', files: {} }, { sessionId: 's', files: [] }]) {
		assert.throws(() => planUpload(payload, limits), (error) => error instanceof UploadError, `payload ${JSON.stringify(payload)}`);
	}
});

test('planUpload enforces count, per-file, and aggregate limits before any write', () => {
	assert.throws(() => planUpload({ sessionId: 's', files: [{ data: base64('a') }, { data: base64('b') }, { data: base64('c') }] }, limits), (error) => error.code === 'too-many-files');
	assert.throws(() => planUpload({ sessionId: 's', files: [{ name: 'big.bin', data: base64('123456789') }] }, limits), (error) => error.code === 'file-too-large');
	assert.throws(() => planUpload({ sessionId: 's', files: [{ data: base64('12345678') }, { data: base64('12345') }] }, { ...limits, maxFileBytes: 8 }), (error) => error.code === 'batch-too-large');
});

test('planUpload refuses empty files and non-object members', () => {
	assert.throws(() => planUpload({ sessionId: 's', files: [{ name: 'empty', data: '' }] }, limits), (error) => error.code === 'invalid');
	assert.throws(() => planUpload({ sessionId: 's', files: [7] }, limits), (error) => error.code === 'invalid');
});

test('planUpload carries an optional advisory media type through', () => {
	const [withType] = planUpload({ sessionId: 's', files: [{ name: 'a', data: base64('a'), mediaType: 'text/csv' }] }, limits).files;
	const [withoutType] = planUpload({ sessionId: 's', files: [{ name: 'a', data: base64('a'), mediaType: '' }] }, limits).files;
	assert.equal(withType.mediaType, 'text/csv');
	assert.equal(withoutType.mediaType, undefined);
});

test('isCanonicalBase64 decides without a regex, so large payloads cannot overflow the stack', () => {
	// 6 MB of base64: the old /^([A-Za-z0-9+/]{4})*…/ test threw
	// `RangeError: Maximum call stack size exceeded` at exactly this size.
	const large = Buffer.alloc(6 * 1024 * 1024, 0x61).toString('base64');
	assert.equal(large.length, 8 * 1024 * 1024);
	assert.equal(isCanonicalBase64(large), true);
	const decoded = decodeBase64(large);
	assert.equal(decoded.byteLength, 6 * 1024 * 1024);
	assert.equal(decoded[0], 0x61);
	assert.equal(decoded[decoded.length - 1], 0x61);
});

test('isCanonicalBase64 keeps every canonical rule the regex enforced', () => {
	assert.equal(isCanonicalBase64(''), true);
	assert.equal(decodedLength('aGVsbG8='), 5);
	assert.equal(decodedLength('aQ=='), 1);
	assert.equal(isCanonicalBase64('aGVsbG8='), true);
	assert.equal(isCanonicalBase64('aQ=='), true);
	assert.equal(isCanonicalBase64('aGVsbG8'), false); // not whole groups
	assert.equal(isCanonicalBase64('aGVsbG8=='), false); // one byte cannot need two pads
	assert.equal(isCanonicalBase64('ab=='), false); // non-zero tail bits
	assert.equal(isCanonicalBase64('aGVs bG8='), false); // whitespace
	assert.equal(isCanonicalBase64('aGVs_bG8='), false); // url-safe alphabet
	assert.equal(isCanonicalBase64('===='), false);
	assert.equal(isCanonicalBase64('A==='), false);
	assert.equal(isCanonicalBase64('aG=sbG8='), false); // embedded padding
	assert.equal(isCanonicalBase64('aGVsbG8=\u0000'), false); // control char beyond ascii set
});

test('planUpload refuses oversized members on encoded length, before decoding them', () => {
	const big = Buffer.alloc(4096, 0x61).toString('base64');
	assert.throws(() => planUpload({ sessionId: 's', files: [{ name: 'big.bin', data: big }] }, { maxFileBytes: 1000, maxFiles: 20, maxBatchBytes: 1e9 }), (error) => error instanceof UploadError && error.code === 'file-too-large' && error.message.includes('4096 bytes'));
	assert.throws(() => planUpload({ sessionId: 's', files: [{ name: 'a', data: big }, { name: 'b', data: big }] }, { maxFileBytes: 1e9, maxFiles: 20, maxBatchBytes: 5000 }), (error) => error.code === 'batch-too-large');
	// 25 MB is the shipping per-file limit; the encoded length must still be accepted.
	const allowed = planUpload({ sessionId: 's', files: [{ name: 'ok.bin', data: Buffer.alloc(25 * 1024 * 1024, 0x62).toString('base64') }] }, { maxFileBytes: 25 * 1024 * 1024, maxFiles: 20, maxBatchBytes: 100 * 1024 * 1024 });
	assert.equal(allowed.files[0].bytes.byteLength, 25 * 1024 * 1024);
});
