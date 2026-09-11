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

/** Canonical base64: whole 4-character groups, one optional padded tail. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

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
	if (!CANONICAL_BASE64.test(data)) throw new UploadError('invalid', 'file data is not canonical base64');
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
		const bytes = decodeBase64(file.data);
		if (bytes.byteLength === 0) throw new UploadError('invalid', `file "${name}" is empty`);
		if (bytes.byteLength > limits.maxFileBytes) throw new UploadError('file-too-large', `file "${name}" is ${String(bytes.byteLength)} bytes; the limit is ${String(limits.maxFileBytes)} bytes`);
		total += bytes.byteLength;
		if (total > limits.maxBatchBytes) throw new UploadError('batch-too-large', `this batch exceeds ${String(limits.maxBatchBytes)} bytes`);
		planned.push({
			index,
			name,
			bytes,
			...(typeof file.mediaType === 'string' && file.mediaType !== '' ? { mediaType: file.mediaType } : {}),
		});
	}
	return { sessionId, files: planned };
}
