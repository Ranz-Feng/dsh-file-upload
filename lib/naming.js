/**
 * Untrusted-name handling for the DSH file-upload channel.
 *
 * Every string that ends up inside a path here is caller-supplied: the browser
 * sends both the session id and the display name. Nothing in this module may
 * assume either is well-formed, so the rules live in one place, free of `ctx`
 * and of the filesystem, and are unit-testable on their own.
 *
 * @module dsh-file-upload/naming
 */
import { createHash } from 'node:crypto';

/** Code points that may never survive into a single path segment. */
const UNSAFE_CODE_POINT = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/** Session-id shape used verbatim as a directory name (UUIDs and similar). */
const PLAIN_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Truncate a string to a UTF-8 byte budget without splitting a code point.
 *
 * `Buffer.subarray` on an encoded string can cut a surrogate pair or a
 * multi-byte sequence in half, which would put a replacement character in a
 * filename. Iterating code points keeps the result valid UTF-8.
 *
 * @param value - String to truncate.
 * @param maxBytes - Maximum encoded length in bytes.
 * @returns The longest prefix that fits the budget.
 */
function truncateUtf8(value, maxBytes) {
	if (maxBytes <= 0) return '';
	let used = 0;
	let out = '';
	for (const character of value) {
		const size = Buffer.byteLength(character);
		if (used + size > maxBytes) break;
		used += size;
		out += character;
	}
	return out;
}

/**
 * Derive one filesystem-safe display name from an untrusted suggestion.
 *
 * The transformation is deliberately lossy: separators, control characters,
 * and Windows-hostile punctuation become `_`, trailing dots and spaces are
 * dropped (a trailing dot is unrepresentable on some filesystems and confuses
 * extension handling), and the whole-segment tokens `.`/`..` collapse to the
 * fallback. A name that begins with a dot is preserved, because `.env` is a
 * legitimate thing to upload.
 *
 * @param raw - Caller-suggested name; any string, including empty.
 * @param options - Optional byte budget and empty-name fallback.
 * @param options.maxBytes - Maximum encoded length, extension preserved.
 * @param options.fallback - Name used when nothing usable remains.
 * @returns A non-empty, single-segment, filesystem-safe name.
 */
export function sanitizeName(raw, { maxBytes = 160, fallback = 'upload' } = {}) {
	let name = typeof raw === 'string' ? raw.normalize('NFC').replace(UNSAFE_CODE_POINT, '_') : '';
	name = name.replace(/^[\s]+/u, '').replace(/[.\s]+$/u, '');
	if (name === '' || name === '.' || name === '..') name = fallback;
	if (Buffer.byteLength(name) <= maxBytes) return name;
	const dot = name.lastIndexOf('.');
	const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const truncated = truncateUtf8(stem, maxBytes - Buffer.byteLength(extension));
	return `${truncated === '' ? fallback : truncated}${extension}`;
}

/**
 * Encode an untrusted string as exactly one path segment.
 *
 * The ordinary case (a session UUID) survives verbatim, which keeps uploaded
 * paths legible. Anything else — separators, `.`/`..`, control characters,
 * over-long input — is replaced by a stable hash, so a hostile session id can
 * never traverse, collide with a sibling, or name a parent directory.
 *
 * @param raw - Untrusted identifier.
 * @returns A single safe path segment.
 */
export function encodeSegment(raw) {
	if (typeof raw === 'string' && PLAIN_SEGMENT.test(raw) && raw !== '.' && raw !== '..') return raw;
	const digest = createHash('sha256').update(typeof raw === 'string' ? raw : String(raw)).digest('hex');
	return `s-${digest.slice(0, 16)}`;
}

/**
 * Quote one workspace-relative path for the composer's `@` grammar.
 *
 * Mirrors `dsh-file-reference`'s formatter: the bare form is used when the
 * path contains neither whitespace nor a double quote, and the quoted form
 * otherwise. Kept here so the host owns the exact text the browser inserts.
 *
 * @param relativePath - Workspace-relative POSIX path.
 * @returns The mention text, including the leading `@`.
 */
export function formatMention(relativePath) {
	return /[\s"]/u.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`;
}
