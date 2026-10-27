/**
 * Wire validation for the `/dsh-upload` channel's `save` endpoint.
 *
 * The shape of the decision matters more than the parsing: every member of a
 * batch is validated *before* any member is written, so a rejected batch never
 * leaves a half-uploaded set behind for the model to reason about.
 *
 * @module dsh-file-upload/protocol
 */
import { sanitizeName } from './naming.js';

/**
 * Base64 alphabet as a 128-entry table: the value for each ASCII character,
 * `255` for everything a canonical payload may not contain.
 *
 * A table plus a linear scan replaces the obvious
 * `/^(?:[A-Za-z0-9+/]{4})*(?:…)?$/` check on purpose. That regex makes V8's
 * backtracking engine recurse once per repeated group, so validating a
 * multi-megabyte upload — an ordinary 5 MB file is already ~6.7 MB of base64 —
 * throws `RangeError: Maximum call stack size exceeded` instead of returning
 * true. The scan below is O(n), allocation-free, and cannot overflow.
 */
const BASE64_VALUE = new Uint8Array(128).fill(255);
for (let index = 0; index < 26; index += 1) {
	BASE64_VALUE[0x41 + index] = index; // A–Z
	BASE64_VALUE[0x61 + index] = 26 + index; // a–z
}
for (let index = 0; index < 10; index += 1) BASE64_VALUE[0x30 + index] = 52 + index; // 0–9
BASE64_VALUE[0x2b] = 62; // +
BASE64_VALUE[0x2f] = 63; // /

/**
 * A refusal the caller can correct: bad shape, bad encoding, or a limit.
 *
 * `code` is the plugin's own vocabulary; the plugin maps it onto the RPC
 * error codes the browser already understands.
 */
export class UploadError extends Error {
	/**
	 * @param code - Stable machine-readable reason.
	 * @param message - Human-readable explanation, safe to show in the composer.
	 */
	constructor(code, message) {
		super(message);
		this.name = 'UploadError';
		this.code = code;
	}
}

/**
 * Whether a string is canonical base64 without decoding it.
 *
 * Canonical means: whole 4-character groups, alphabet only, at most two `=`
 * only as the final group's tail, and the tail's unused bits zero — exactly
 * what `btoa` produces, so a browser payload always passes and anything else
 * (truncated, hand-typed, whitespace-wrapped, url-safe) is refused.
 *
 * @param data - Candidate string.
 * @returns True when the value is canonical base64.
 */
export function isCanonicalBase64(data) {
	const length = data.length;
	if (length % 4 !== 0) return false;
	let padding = 0;
	if (length > 0 && data.charCodeAt(length - 1) === 0x3d) {
		padding = 1;
		if (length > 1 && data.charCodeAt(length - 2) === 0x3d) padding = 2;
	}
	const bodyEnd = length - padding;
	for (let index = 0; index < bodyEnd; index += 1) {
		const code = data.charCodeAt(index);
		if (code > 0x7f || BASE64_VALUE[code] === 255) return false;
	}
	// Canonical padding requires the bits the tail does not carry to be zero.
	if (padding === 2) {
		const value = BASE64_VALUE[data.charCodeAt(length - 3)];
		return value !== 255 && (value & 0x0f) === 0;
	}
	if (padding === 1) {
		const value = BASE64_VALUE[data.charCodeAt(length - 2)];
		return value !== 255 && (value & 0x03) === 0;
	}
	return true;
}

/**
 * Decoded byte length of a canonical base64 string, without decoding it.
 *
 * Lets the limits in {@link planUpload} run before any multi-megabyte buffer
 * is allocated, so an oversized file is refused cheaply instead of after a
 * pointless decode.
 *
 * @param data - Canonical base64 string.
 * @returns The number of bytes it carries.
 */
export function decodedLength(data) {
	if (data.length === 0) return 0;
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

/**
 * Decode one wire payload into bytes, rejecting non-canonical base64.
 *
 * A browser `btoa` output always round-trips, so a payload that does not is
 * either corrupt or hand-written; both are refused rather than guessed at.
 *
 * @param data - Claimed base64 string.
 * @returns The decoded bytes.
 * @throws {UploadError} When the value is not a canonical base64 string.
 */
export function decodeBase64(data) {
	if (typeof data !== 'string') throw new UploadError('invalid', 'file data must be a base64 string');
	if (!isCanonicalBase64(data)) throw new UploadError('invalid', 'file data is not canonical base64');
	return new Uint8Array(Buffer.from(data, 'base64'));
}

/**
 * Validate one upload request and bind each member to its decoded bytes.
 *
 * Enforces, in order: request shape, batch count, per-file size, and the
 * aggregate batch size — the same precedence the RPC carrier applies to HTTP
 * bodies, so the message a caller sees names the first real violation.
 *
 * @param payload - Decoded request payload from the browser.
 * @param limits - Deployment limits (`maxFileBytes`, `maxFiles`, `maxBatchBytes`).
 * @returns The session id and the validated, sanitized members in order.
 * @throws {UploadError} On any shape or limit violation.
 */
export function planUpload(payload, limits) {
	if (payload === null || typeof payload !== 'object') throw new UploadError('invalid', 'request payload must be an object');
	const { sessionId, files } = payload;
	if (typeof sessionId !== 'string' || sessionId === '') throw new UploadError('invalid', 'sessionId must be a non-empty string');
	if (!Array.isArray(files)) throw new UploadError('invalid', 'files must be an array');
	if (files.length === 0) throw new UploadError('invalid', 'files must not be empty');
	if (files.length > limits.maxFiles) throw new UploadError('too-many-files', `at most ${String(limits.maxFiles)} files may be uploaded at once (received ${String(files.length)})`);
	let total = 0;
	const planned = [];
	for (const [index, file] of files.entries()) {
		if (file === null || typeof file !== 'object') throw new UploadError('invalid', `file ${String(index)} must be an object`);
		const name = sanitizeName(file.name);
		if (typeof file.data !== 'string') throw new UploadError('invalid', 'file data must be a base64 string');
		if (!isCanonicalBase64(file.data)) throw new UploadError('invalid', 'file data is not canonical base64');
		// Sizes are decided on the encoded length, before any buffer exists: an
		// oversized member must not first allocate its own bytes just to be refused.
		const size = decodedLength(file.data);
		if (size === 0) throw new UploadError('invalid', `file "${name}" is empty`);
		if (size > limits.maxFileBytes) throw new UploadError('file-too-large', `file "${name}" is ${String(size)} bytes; the limit is ${String(limits.maxFileBytes)} bytes`);
		if (total + size > limits.maxBatchBytes) throw new UploadError('batch-too-large', `this batch exceeds ${String(limits.maxBatchBytes)} bytes`);
		const bytes = new Uint8Array(Buffer.from(file.data, 'base64'));
		total += size;
		planned.push({
			index,
			name,
			bytes,
			...(typeof file.mediaType === 'string' && file.mediaType !== '' ? { mediaType: file.mediaType } : {}),
		});
	}
	return { sessionId, files: planned };
}
