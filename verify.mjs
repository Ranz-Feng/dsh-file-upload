#!/usr/bin/env node
/**
 * Verify a running dsh host actually serves the file-upload plugin.
 *
 * Written because two mistakes are easy to make and both look like a broken
 * plugin:
 *
 * 1. **Probing too early.** The webserver row binds the port before the rest of
 *    the loader tree finishes activating, so `/` can answer while the plugin's
 *    channel and client bundle are still absent. Every check here polls.
 * 2. **Sending the wrong envelope.** The generic RPC carrier only reaches a
 *    handler for a full `{type:'client-request', rpcId, method, payload}`
 *    envelope; a bare payload is rejected by the carrier with a 200 that looks
 *    deceptively like a handler-level refusal.
 *
 * Usage:
 *   node verify.mjs                                  # structural checks only
 *   node verify.mjs --session <sessionId>            # + a real upload round trip
 *   node verify.mjs --session <id> --file ./a.pdf --base http://127.0.0.1:3080
 *
 * The round trip WRITES a file into that session's workspace under
 * `.dsh/uploads/<session>/`, which is the whole point of the plugin; it prints
 * the path so it can be removed afterwards.
 */
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};

const base = (flag('base', 'http://127.0.0.1:3080')).replace(/\/$/u, '');
const sessionId = flag('session', undefined);
const filePath = flag('file', undefined);
const PACKAGE_NAME = 'dsh-file-upload';
const CHANNEL = '/dsh-upload';

let failures = 0;

/**
 * Report one check result.
 * @param ok - Whether the check passed.
 * @param label - What was checked.
 * @param detail - Optional evidence (response status, sizes, ids).
 */
function check(ok, label, detail = '') {
	if (!ok) failures += 1;
	process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `  (${detail})`}\n`);
}

/**
 * Fetch with a timeout, returning undefined instead of throwing.
 * @param path - URL path below the base.
 * @param init - Fetch options.
 * @returns The response, or undefined when the request failed.
 */
async function attempt(path, init) {
	try {
		return await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000), ...init });
	} catch {
		return undefined;
	}
}

/**
 * Poll a probe until it yields a value or the budget runs out.
 * @param probe - Probe returning a value or undefined.
 * @param timeoutMs - Total budget.
 * @returns The first truthy probe result, or undefined on timeout.
 */
async function waitFor(probe, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) return undefined;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
}

/**
 * POST one upload request and return the RPC result envelope.
 * @param payload - Request payload.
 * @param rpcId - Correlation id.
 * @returns The parsed envelope result, or undefined when the call failed.
 */
async function callChannel(payload, rpcId) {
	const response = await attempt(`${CHANNEL}/save`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId, method: 'save', payload }),
	});
	if (response === undefined || response.status !== 200) return undefined;
	const body = await response.json().catch(() => undefined);
	return body?.result;
}

process.stdout.write(`verifying ${PACKAGE_NAME} at ${base}\n`);

// ── 1. the host is up and its boot manifest carries the plugin ────────────────
const index = await waitFor(async () => {
	const response = await attempt('/');
	if (response?.ok !== true) return undefined;
	const html = await response.text();
	return html.includes(PACKAGE_NAME) ? html : undefined;
}, 60000);
check(index !== undefined, 'boot manifest carries the plugin', index === undefined ? 'not found within 60s' : `${String(index.length)} bytes of index`);

// ── 2. the browser half is served ────────────────────────────────────────────
const bundle = await waitFor(async () => {
	const response = await attempt(`/plugins/${PACKAGE_NAME}/client.js`);
	if (response?.ok !== true) return undefined;
	const source = await response.text();
	return source.includes('__ModuleLoader__') ? source : undefined;
}, 30000);
check(bundle !== undefined, 'client bundle served and registers a factory', bundle === undefined ? 'missing' : `${String(bundle.length)} bytes`);

// ── 3. the host channel is mounted, and the trust fence lets us in ───────────
const refusal = await callChannel({ sessionId: 'verify-probe-not-a-session', files: [] }, 'verify-empty');
check(refusal?.ok === false, 'upload channel reaches the plugin handler', refusal === undefined ? 'no RPC result' : JSON.stringify(refusal.error?.message ?? refusal));

// ── 4. optional: a real upload into a real session ───────────────────────────
if (sessionId === undefined) {
	process.stdout.write('\n(no --session given: skipped the real upload round trip)\n');
} else {
	const name = filePath === undefined ? 'verify-probe.txt' : basename(resolve(filePath));
	const bytes = filePath === undefined ? Buffer.from('dsh-file-upload verification\n') : await readFile(resolve(filePath));
	const result = await callChannel({ sessionId, files: [{ name, data: bytes.toString('base64') }] }, 'verify-upload');
	const uploaded = result?.ok === true ? result.value.files[0] : undefined;
	check(uploaded !== undefined, 'upload round trip wrote the file', uploaded === undefined ? JSON.stringify(result?.error ?? result) : `${String(uploaded.bytes)} bytes -> ${uploaded.path}`);
	if (uploaded !== undefined) process.stdout.write(`     remove it with: rm "…/${uploaded.path}"\n`);
}

process.stdout.write(failures === 0 ? '\nall checks passed\n' : `\n${String(failures)} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
