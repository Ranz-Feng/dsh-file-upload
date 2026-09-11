import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64, planUpload, UploadError } from '../lib/protocol.js';

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
