import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureContainedDirectory, isContained, saveUploadedFile, toMentionPath } from '../lib/store.js';
import { UploadError } from '../lib/protocol.js';

const workspace = () => mkdtemp(join(tmpdir(), 'dsh-upload-test-'));

test('isContained accepts the base itself and descendants only', () => {
	assert.equal(isContained('/a/b', '/a/b'), true);
	assert.equal(isContained('/a/b', '/a/b/c/d'), true);
	assert.equal(isContained('/a/b', '/a/c'), false);
	assert.equal(isContained('/a/b', '/a/bc'), false);
	assert.equal(isContained('/a/b', '/a'), false);
});

test('toMentionPath produces a POSIX relative path or nothing', async () => {
	const base = await workspace();
	assert.equal(toMentionPath(base, join(base, '.dsh', 'uploads', 'x.txt')), '.dsh/uploads/x.txt');
	assert.equal(toMentionPath(base, '/etc/passwd'), undefined);
	assert.equal(toMentionPath(base, base), undefined);
});

test('ensureContainedDirectory creates a private tree and reports its real path', async () => {
	const base = await realpath(await workspace());
	const uploads = await ensureContainedDirectory(base, '.dsh/uploads');
	assert.equal(uploads, join(base, '.dsh', 'uploads'));
	assert.equal(isContained(base, uploads), true);
});

test('ensureContainedDirectory refuses a symlinked component that escapes the workspace', async () => {
	const base = await realpath(await workspace());
	const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-upload-outside-')));
	await symlink(outside, join(base, '.dsh'));
	await assert.rejects(
		() => ensureContainedDirectory(base, '.dsh/uploads'),
		(error) => error instanceof UploadError && error.code === 'unsafe-path',
	);
});

test('saveUploadedFile writes content-addressed files and never overwrites', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-dir-'));
	const first = await saveUploadedFile({ dir, name: 'notes.txt', bytes: Buffer.from('hello') });
	assert.equal(first.deduplicated, false);
	assert.equal(await readFile(first.path, 'utf8'), 'hello');
	assert.match(first.fileName, /^[0-9a-f]{12}-notes\.txt$/);

	const second = await saveUploadedFile({ dir, name: 'notes.txt', bytes: Buffer.from('hello') });
	assert.equal(second.path, first.path);
	assert.equal(second.deduplicated, true);

	const third = await saveUploadedFile({ dir, name: 'notes.txt', bytes: Buffer.from('different') });
	assert.notEqual(third.path, first.path);
	assert.equal(await readFile(third.path, 'utf8'), 'different');
	assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith('.part')), []);
});

test('saveUploadedFile refuses a planted file at the same content address', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-dir-'));
	const bytes = Buffer.from('hello');
	const digest = createHash('sha256').update(bytes).digest('hex');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${digest.slice(0, 12)}-notes.txt`), 'not hello');
	await assert.rejects(
		() => saveUploadedFile({ dir, name: 'notes.txt', bytes }),
		(error) => error instanceof UploadError && error.code === 'conflict',
	);
});
