/**
 * Filesystem mechanics for the upload channel: workspace containment, the
 * upload directory tree, and the no-overwrite write itself.
 *
 * Kept free of `ctx` so the security-relevant behavior — containment, no
 * traversal, no clobber, owner-only mode — is unit-testable without booting
 * the harness.
 *
 * @module dsh-file-upload/store
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, dirname, join, relative, sep } from 'node:path';
import { UploadError } from './protocol.js';

/**
 * Whether a resolved path is the base directory or lies beneath it.
 *
 * Both arguments must already be real paths (symlinks resolved); the check is
 * only as good as that precondition, which is why callers resolve first.
 *
 * @param baseRealPath - Containing directory, symlink-free.
 * @param candidateRealPath - Path to test, symlink-free.
 * @returns True when the candidate is inside the base.
 */
export function isContained(baseRealPath, candidateRealPath) {
	const step = relative(baseRealPath, candidateRealPath);
	return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

/**
 * Convert an absolute path into the POSIX-relative form the composer speaks.
 *
 * @param baseRealPath - Directory the relative path is taken from.
 * @param targetPath - Absolute path to convert.
 * @returns A `/`-separated relative path, or undefined when it escapes the base.
 */
export function toMentionPath(baseRealPath, targetPath) {
	const step = relative(baseRealPath, targetPath);
	if (step === '' || step.startsWith('..') || isAbsolute(step)) return undefined;
	return step.split(sep).join('/');
}

/**
 * Create one directory and prove that it really sits inside its parent.
 *
 * `mkdir -p` follows symlinks, so a plant at any component of the upload path —
 * `.dsh` checked out from a hostile repository, for instance — would redirect
 * every later write. The containment check therefore runs against the deepest
 * *already existing* ancestor before anything is created: resolving only after
 * `mkdir` would refuse the write while still having created a directory outside
 * the workspace, which is the wrong half of the guarantee. The post-creation
 * resolve stays as a second gate, so a symlink swapped in during the race is
 * caught too.
 *
 * @param parentRealPath - Symlink-free parent that must contain the result.
 * @param relativePath - Single path segment (or nested relative path) to create.
 * @returns The symlink-free absolute path of the created directory.
 * @throws {UploadError} When the target resolves outside the parent.
 */
export async function ensureContainedDirectory(parentRealPath, relativePath) {
	const requested = join(parentRealPath, relativePath);
	const anchor = await nearestExistingAncestor(requested);
	if (!isContained(parentRealPath, anchor)) throw new UploadError('unsafe-path', `refusing to use "${relativePath}": it resolves outside the session workspace`);
	await mkdir(requested, { recursive: true, mode: 0o700 });
	const resolved = await realpath(requested);
	if (!isContained(parentRealPath, resolved)) throw new UploadError('unsafe-path', `refusing to use "${relativePath}": it resolves outside the session workspace`);
	return resolved;
}

/**
 * Resolve the deepest ancestor of a path that already exists, creating nothing.
 *
 * @param path - Absolute path that may not exist yet.
 * @returns The symlink-free path of the nearest existing ancestor.
 */
async function nearestExistingAncestor(path) {
	let candidate = path;
	for (;;) {
		if (await statOrUndefined(candidate) !== undefined) return await realpath(candidate);
		const parent = dirname(candidate);
		if (parent === candidate) return candidate;
		candidate = parent;
	}
}

/**
 * Write one uploaded file without ever overwriting an existing path.
 *
 * Publication is `link`-based rather than `rename`-based on purpose: `link`
 * fails with `EEXIST` instead of silently replacing, which is what makes the
 * content-addressed name a *deduplicating* name rather than a clobbering one.
 * The staged temp file is owner-only (0600) and removed on every path.
 *
 * @param options - Write inputs.
 * @param options.dir - Symlink-free destination directory.
 * @param options.name - Already-sanitized single-segment file name.
 * @param options.bytes - Exact file content.
 * @returns The absolute path, the digest, and whether an identical file was already there.
 */
export async function saveUploadedFile({ dir, name, bytes }) {
	const digest = createHash('sha256').update(bytes).digest('hex');
	const fileName = `${digest.slice(0, 12)}-${name}`;
	const target = join(dir, fileName);
	const existing = await statOrUndefined(target);
	if (existing !== undefined) {
		if (existing.size !== bytes.byteLength) throw new UploadError('conflict', `"${fileName}" already exists with different content; refusing to replace it`);
		return { path: target, fileName, digest, deduplicated: true };
	}
	const temporary = join(dir, `.${randomBytes(8).toString('hex')}.part`);
	const handle = await open(temporary, 'wx', 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	let deduplicated = false;
	try {
		await link(temporary, target);
	} catch (error) {
		if (error.code !== 'EEXIST') {
			await rm(temporary, { force: true });
			throw error;
		}
		deduplicated = true;
	}
	await rm(temporary, { force: true });
	return { path: target, fileName, digest, deduplicated };
}

/**
 * `stat` that answers undefined instead of throwing for a missing path.
 *
 * @param path - Path to inspect.
 * @returns The stats, or undefined when the path does not exist.
 */
async function statOrUndefined(path) {
	try {
		return await stat(path);
	} catch (error) {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	}
}
