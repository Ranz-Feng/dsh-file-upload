/**
 * `dsh-file-upload` — a generic browser file-upload channel whose destination
 * is the session's own workspace.
 *
 * DSH's existing intake path is image-only by construction: `dsh-attachment`
 * decodes, normalizes, and stores rasters, and its store exposes nothing but
 * `…Image` methods. Everything else a person wants to hand an agent — a PDF, a
 * CSV, a log, a patch, an archive — has no route in. This plugin adds one, and
 * deliberately does not invent a second storage model: uploaded bytes land in
 * `<session cwd>/.dsh/uploads/<session>/…` as ordinary files, so the agent
 * reads them with the tools it already has (`read`, `grep`, `bash`) and the
 * person can point at them with the existing `@` mention grammar.
 *
 * Transport is the generic Connection RPC channel
 * (`ctx.connection.rpc.handle`), which brings three properties this problem
 * needs and cannot safely reimplement: the host's own loopback/trusted-host
 * fence, the shared request-body cap, and a carrier the browser already speaks.
 * The carrier is JSON-only, so payloads are canonical base64 — a deliberate
 * trade (33% overhead, whole-body buffering) bought in exchange for needing no
 * multipart parser and no second trust fence. See `DESIGN.md` for the
 * streaming upgrade path and the sizes it unlocks.
 *
 * @module dsh-file-upload
 */
import z from '@deepseek-ai/schemastery';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeSegment, formatMention } from './naming.js';
import { planUpload, UploadError } from './protocol.js';
import { ensureContainedDirectory, isContained, saveUploadedFile, toMentionPath } from './store.js';

export const name = 'file-upload';

/** The RPC channel the browser calls; absolute, per the Connection contract. */
export const CHANNEL = '/dsh-upload';

/** Services this plugin cannot work without (injection waits for both). */
export const inject = ['connection', 'agents'];

/** Plugin config; every field has a working default. */
export const Config = z.object({
	/**
	 * Upload directory, relative to the session workspace. Relative on purpose:
	 * an absolute root would let one deployment's config silently write outside
	 * every session's workspace, which is the one property this design keeps.
	 */
	directory: z.string().default('.dsh/uploads'),
	/** Largest single file accepted, in bytes (before base64 expansion). */
	maxFileBytes: z.natural().default(25 * 1024 * 1024),
	/** Largest number of files in one batch. */
	maxFiles: z.natural().default(20),
	/** Largest aggregate batch, in bytes. */
	maxBatchBytes: z.natural().default(100 * 1024 * 1024),
	/**
	 * Which browser authorities may upload. `loopback` is the default because
	 * this channel writes into the workspace on a person's behalf; a deployment
	 * that serves the GUI over a LAN and accepts that reach sets
	 * `trusted-host`.
	 */
	authority: z.union([z.const('loopback'), z.const('trusted-host')]).default('loopback'),
	/** Keep `.dsh/uploads` out of the repository when the default directory is used. */
	gitignore: z.boolean().default(true),
});

/**
 * Mount the upload channel.
 *
 * @param ctx - Cordis context of the mounted plugin.
 * @param config - Validated plugin config.
 */
export function apply(ctx, config) {
	const settings = { ...Config(config), ...config };
	// The registration belongs to this plugin's fiber: disposing the plugin
	// removes the physical route along with it.
	ctx.effect(() => {
		const dispose = ctx.connection.rpc.handle(
			CHANNEL,
			(endpoint, payload, signal) => handleUpload(ctx, settings, endpoint, payload, signal),
			{ authority: settings.authority },
		);
		return () => {
			void dispose();
		};
	}, `file-upload: ${CHANNEL} channel`);
}

// Attach metadata to the apply function for Cordis
apply.inject = inject;
apply.Config = Config;

/**
 * Serve one `save` endpoint call.
 *
 * The order is: validate the whole batch, resolve the destination from
 * *host-side* session state, then write. The browser never names a directory —
 * it names a session — so path traversal is impossible by construction rather
 * than filtered after the fact.
 *
 * @param ctx - Plugin context, used only to read the agent registry.
 * @param config - Resolved plugin config.
 * @param endpoint - Channel-relative endpoint name.
 * @param payload - Decoded request payload.
 * @param signal - Cancellation owned by the browser request.
 * @returns The RPC result: durable, workspace-relative references or a refusal.
 */
async function handleUpload(ctx, config, endpoint, payload, signal) {
	if (endpoint !== 'save') return refuse('bad-request', `unknown file-upload endpoint "${endpoint}"`, { issues: [] });
	let plan;
	try {
		plan = planUpload(payload, config);
	} catch (error) {
		if (error instanceof UploadError) return refuse('bad-request', error.message, { issues: [] });
		throw error;
	}
	const agents = ctx.get('agents');
	if (agents === undefined) return refuse('internal', 'the agent registry is unavailable, so an upload cannot resolve a workspace', {});
	const agent = agents.get(plan.sessionId);
	if (agent === undefined) return refuse('session-not-found', `session "${plan.sessionId}" is not open on this host`, { sessionId: plan.sessionId });
	const cwd = agent.session.header.cwd;
	if (cwd === undefined) return refuse('bad-request', `session "${plan.sessionId}" has no working directory, so it has nowhere to accept uploads`, { issues: [] });
	if (signal.aborted) return refuse('cancelled', 'upload cancelled', {});
	try {
		const workspaceReal = await realpath(cwd);
		const uploadsReal = await uploadedRoot(workspaceReal, config);
		const sessionReal = await ensureContainedDirectory(uploadsReal, encodeSegment(plan.sessionId));
		const files = [];
		for (const file of plan.files) {
			if (signal.aborted) return refuse('cancelled', 'upload cancelled', {});
			const saved = await saveUploadedFile({ dir: sessionReal, name: file.name, bytes: file.bytes });
			const relativePath = toMentionPath(workspaceReal, saved.path);
			if (relativePath === undefined) throw new UploadError('unsafe-path', 'resolved upload path escapes the session workspace');
			files.push({
				name: file.name,
				path: relativePath,
				mention: formatMention(relativePath),
				bytes: file.bytes.byteLength,
				sha256: saved.digest,
				deduplicated: saved.deduplicated,
			});
		}
		return { ok: true, value: { files } };
	} catch (error) {
		if (error instanceof UploadError) return refuse('bad-request', error.message, { issues: [] });
		ctx.logger?.warn?.(`file-upload: ${String(error)}`);
		return refuse('internal', 'the upload could not be stored', {});
	}
}

/**
 * Resolve (and create) the upload root inside a workspace, refusing escapes.
 *
 * @param workspaceReal - Symlink-free session workspace root.
 * @param config - Resolved plugin config.
 * @returns The symlink-free absolute upload root.
 */
async function uploadedRoot(workspaceReal, config) {
	const uploadsReal = await ensureContainedDirectory(workspaceReal, config.directory);
	if (!isContained(workspaceReal, uploadsReal)) throw new UploadError('unsafe-path', 'the configured upload directory resolves outside the session workspace');
	if (config.gitignore && config.directory === '.dsh/uploads') await writeGitignore(workspaceReal);
	return uploadsReal;
}

/**
 * Keep uploads out of the repository without touching a file the person owns.
 *
 * Uploaded bytes are working material, not source; a `.gitignore` inside `.dsh`
 * keeps `git status` honest. An existing `.dsh/.gitignore` is never edited —
 * silently rewriting a tracked file would be worse than the noise it prevents.
 *
 * @param workspaceReal - Symlink-free session workspace root.
 */
async function writeGitignore(workspaceReal) {
	let handle;
	try {
		handle = await open(join(workspaceReal, '.dsh', '.gitignore'), 'wx', 0o600);
	} catch {
		return;
	}
	try {
		await handle.writeFile('# Written by dsh-file-upload: uploaded files are working material.\nuploads/\n');
	} finally {
		await handle.close();
	}
}

/**
 * Build the error branch of an RPC result.
 *
 * The codes are the connection layer's existing vocabulary rather than new
 * ones, so a caller that already folds `RpcResult` needs no special case.
 *
 * @param code - One of the shared RPC error codes.
 * @param message - Human-readable explanation.
 * @param details - Code-specific details payload.
 * @returns The failure result.
 */
function refuse(code, message, details) {
	return { ok: false, error: { code, message, details } };
}

export default apply;
