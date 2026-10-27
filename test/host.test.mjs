import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, CHANNEL } from '../lib/index.js';

const base64 = (value) => Buffer.from(value).toString('base64');
const never = new AbortController().signal;

/**
 * Mount the plugin against a stub context and hand back the registered channel.
 *
 * The stub covers exactly the surface `apply` touches: fiber-scoped effects,
 * the generic RPC registry, and the agent registry that resolves a session to
 * its working directory.
 *
 * @param cwds - Session id to workspace cwd (a missing entry is an unknown session).
 * @param config - Plugin config override.
 * @returns The channel registration the plugin performed.
 */
function mount(cwds, config = {}) {
	let registration;
	const ctx = {
		effect: (callback) => {
			callback();
		},
		connection: {
			rpc: {
				handle: (channel, handler, options) => {
					registration = { channel, handler, options };
					return async () => {};
				},
			},
		},
		get: (service) => service === 'agents'
			? { get: (id) => (id in cwds ? { session: { header: { cwd: cwds[id] } } } : undefined) }
			: undefined,
		logger: { warn: () => {} },
	};
	apply(ctx, config);
	assert.ok(registration, 'the plugin registered no channel');
	return registration;
}

const workspace = async () => realpath(await mkdtemp(join(tmpdir(), 'dsh-upload-host-')));

test('mounts one channel and inherits the loopback fence by default', () => {
	const registration = mount({ s: '/tmp' });
	assert.equal(registration.channel, CHANNEL);
	assert.equal(registration.options.authority, 'loopback');
});

test('authority and directory are configurable', () => {
	const registration = mount({ s: '/tmp' }, { authority: 'trusted-host' });
	assert.equal(registration.options.authority, 'trusted-host');
});

test('saves a batch into the session workspace and returns mention text', async () => {
	const cwd = await workspace();
	const { handler } = mount({ 'session-a': cwd });
	const result = await handler('save', {
		sessionId: 'session-a',
		files: [
			{ name: 'report Q3.csv', data: base64('a,b\n1,2\n'), mediaType: 'text/csv' },
			{ name: 'notes.txt', data: base64('hello') },
		],
	}, never);
	assert.equal(result.ok, true);
	assert.equal(result.value.files.length, 2);
	const [report, notes] = result.value.files;
	assert.equal(report.path, `.dsh/uploads/session-a/${report.sha256.slice(0, 12)}-report Q3.csv`);
	assert.equal(report.mention, `@".dsh/uploads/session-a/${report.sha256.slice(0, 12)}-report Q3.csv"`);
	assert.equal(report.bytes, 8);
	assert.equal(report.deduplicated, false);
	assert.equal(notes.mention, `@.dsh/uploads/session-a/${notes.sha256.slice(0, 12)}-notes.txt`);
	assert.equal(await readFile(join(cwd, notes.path), 'utf8'), 'hello');
	assert.equal(await readFile(join(cwd, report.path), 'utf8'), 'a,b\n1,2\n');
	assert.equal(await readFile(join(cwd, '.dsh', '.gitignore'), 'utf8').then((text) => text.includes('uploads/')), true);
});

test('re-uploading identical content deduplicates instead of colliding', async () => {
	const cwd = await workspace();
	const { handler } = mount({ s: cwd });
	const payload = { sessionId: 's', files: [{ name: 'dup.txt', data: base64('same') }] };
	const first = await handler('save', payload, never);
	const second = await handler('save', payload, never);
	assert.equal(second.value.files[0].path, first.value.files[0].path);
	assert.equal(second.value.files[0].deduplicated, true);
	assert.deepEqual((await readdir(join(cwd, '.dsh', 'uploads', 's'))).length, 1);
});

test('an unknown session and a session without a workspace are refused', async () => {
	const cwd = await workspace();
	const { handler } = mount({ s: cwd });
	const unknown = await handler('save', { sessionId: 'nope', files: [{ name: 'a', data: base64('a') }] }, never);
	assert.deepEqual(unknown, { ok: false, error: { code: 'session-not-found', message: 'session "nope" is not open on this host', details: { sessionId: 'nope' } } });
	const nows = mount({ bare: undefined });
	const noWorkspace = await nows.handler('save', { sessionId: 'bare', files: [{ name: 'a', data: base64('a') }] }, never);
	assert.equal(noWorkspace.ok, false);
	assert.equal(noWorkspace.error.code, 'bad-request');
});

test('an unknown endpoint and a malformed batch are refused without touching the disk', async () => {
	const cwd = await workspace();
	const { handler } = mount({ s: cwd });
	const endpoint = await handler('delete', { sessionId: 's', files: [] }, never);
	assert.equal(endpoint.error.code, 'bad-request');
	const malformed = await handler('save', { sessionId: 's', files: [{ name: 'a', data: 'not base64!' }] }, never);
	assert.equal(malformed.error.code, 'bad-request');
	await assert.rejects(() => stat(join(cwd, '.dsh')));
});

test('a rejected batch writes no member of that batch', async () => {
	const cwd = await workspace();
	const { handler } = mount({ s: cwd }, { maxFileBytes: 4 });
	const result = await handler('save', {
		sessionId: 's',
		files: [{ name: 'small.txt', data: base64('ok') }, { name: 'big.txt', data: base64('too big') }],
	}, never);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'bad-request');
	assert.match(result.error.message, /big\.txt/);
	await assert.rejects(() => stat(join(cwd, '.dsh')), 'validation ran before any directory was created');
});

test('a symlinked upload directory that escapes the workspace is refused', async () => {
	const cwd = await workspace();
	const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-upload-outside-')));
	await symlink(outside, join(cwd, '.dsh'));
	const { handler } = mount({ s: cwd });
	const result = await handler('save', { sessionId: 's', files: [{ name: 'a.txt', data: base64('a') }] }, never);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'bad-request');
	assert.match(result.error.message, /outside the session workspace/);
	assert.deepEqual(await readdir(outside), []);
});

test('a custom directory is honored and the gitignore guard does not apply', async () => {
	const cwd = await workspace();
	const { handler } = mount({ s: cwd }, { directory: 'inbox' });
	const result = await handler('save', { sessionId: 's', files: [{ name: 'a.txt', data: base64('a') }] }, never);
	assert.equal(result.ok, true);
	assert.match(result.value.files[0].path, /^inbox\/s\//);
	await assert.rejects(() => stat(join(cwd, '.dsh')));
});

test('an exception in host-owned agent state is refused, never thrown at the carrier', async () => {
	// The carrier reports a thrown handler as a bare `HTTP 500`, so the browser
	// can only say "transport failure" and the person learns nothing. Anything
	// this plugin does not control — an agent detaching mid-request, a host shape
	// change — has to come back as a refusal that names the cause.
	let registration;
	const logged = [];
	const ctx = {
		effect: (callback) => {
			callback();
		},
		connection: {
			rpc: {
				handle: (channel, handler, options) => {
					registration = { channel, handler, options };
					return async () => {};
				},
			},
		},
		get: () => ({
			get: () => ({
				get session() {
					throw new Error('agent detached mid-flight');
				},
			}),
		}),
		logger: { warn: () => {}, error: (message) => logged.push(String(message)) },
	};
	apply(ctx, {});
	const result = await registration.handler('save', {
		sessionId: 's',
		files: [{ name: 'a.txt', data: base64('a') }],
	}, never);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'internal');
	assert.match(result.error.message, /agent detached mid-flight/);
	assert.equal(logged.length, 1, 'the stack reaches the host log');
});

test('cancellation before the write is reported as cancelled', async () => {
	const cwd = await workspace();
	const { handler } = mount({ s: cwd });
	const controller = new AbortController();
	controller.abort();
	const result = await handler('save', { sessionId: 's', files: [{ name: 'a.txt', data: base64('a') }] }, controller.signal);
	assert.equal(result.error.code, 'cancelled');
});
