#!/usr/bin/env node
/**
 * Install `dsh-file-upload` into a local dsh profile.
 *
 * Four things have to be true before the plugin loads on the next boot:
 *
 * 1. The package resolves from the profile. The loader picks bare names up
 *    through `$DSH_HOME/profiles/node_modules` — the shared module fallback
 *    `healProfilesModuleFallback` populates and, importantly, only ever *adds*
 *    to, so a link placed here survives later boots. The browser half resolves
 *    from the same anchor (`createRequire(ctx.baseUrl)` in `dsh-client-modules`),
 *    so one link serves both halves.
 * 2. The profile patch layer mounts a loader row. `cordis.patch.yml` is a
 *    top-level YAML array; the template ships it as `[]`. This script refuses to
 *    touch a file that already carries someone else's entries.
 * 3. Both halves resolve, and the host half imports.
 * 4. The row actually composes: `--dump-config` is run, so a broken mount is
 *    caught here instead of at the next restart.
 *
 * Idempotent: re-running replaces the link and leaves an existing row alone.
 *
 * Usage: node install.mjs [--profile web] [--uninstall]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'dsh-file-upload';
const ROW_ID = 'file-upload';
const packageDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile');
const profile = profileIndex === -1 ? 'web' : args[profileIndex + 1];
const uninstall = args.includes('--uninstall');

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profilesDir = join(dshHome, 'profiles');
const profileDir = join(profilesDir, profile);
const linkPath = join(profilesDir, 'node_modules', PACKAGE_NAME);
const patchPath = join(profileDir, 'cordis.patch.yml');

if (!existsSync(profileDir)) {
	process.stderr.write(`install: profile directory ${profileDir} does not exist\n`);
	process.exit(1);
}

console.log(`install: dsh home      ${dshHome}`);
console.log(`install: profile       ${profileDir}`);
console.log(`install: package       ${packageDir}`);

const rowBlock = [
	`# ${PACKAGE_NAME}: generic file upload into the session workspace.`,
	'# Remove this entry to unmount the plugin.',
	'- insert:',
	`    - id: ${ROW_ID}`,
	`      name: ${PACKAGE_NAME}`,
].join('\n');

const patchSource = readFileSync(patchPath, 'utf8');
const alreadyMounted = patchSource.includes(`name: ${PACKAGE_NAME}`);
// "Has entries" means any non-comment, non-blank line that is not the empty
// array placeholder. Anything else belongs to the user and stays untouched.
const foreign = alreadyMounted
	? []
	: patchSource
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#') && line !== '[]');

// ── 1. resolution link ────────────────────────────────────────────────────────
if (uninstall) {
	rmSync(linkPath, { force: true });
	console.log(`install: removed link  ${linkPath}`);
} else {
	symlinkSync(resolve(packageDir), linkPath, 'dir');
	console.log(`install: linked        ${linkPath} -> ${resolve(packageDir)}`);
}

// ── 2. mount row ──────────────────────────────────────────────────────────────
if (uninstall) {
	if (alreadyMounted && foreign.length === 0) {
		writeFileSync(patchPath, '[]\n');
		console.log('install: profile patch layer restored to []');
	} else if (alreadyMounted) {
		process.stderr.write(`install: ${patchPath} also holds other entries; remove the block manually\n`);
	}
	process.exit(0);
}
if (alreadyMounted) {
	console.log('install: profile patch layer already mounts the row; left as-is');
} else if (foreign.length > 0) {
	process.stderr.write(`install: refusing to edit ${patchPath}: it holds entries of its own. Add this block manually:\n\n${rowBlock}\n`);
	process.exit(1);
} else {
	const preamble = patchSource
		.split('\n')
		.filter((line) => line.trim() !== '[]')
		.join('\n')
		.replace(/\n+$/u, '');
	writeFileSync(patchPath, `${preamble}\n\n${rowBlock}\n`);
	console.log(`install: mounted       ${ROW_ID} in ${patchPath}`);
}

// ── 3. resolution and import probe ────────────────────────────────────────────
const require = createRequire(`${profileDir}/`);
const manifestPath = require.resolve(`${PACKAGE_NAME}/package.json`);
console.log(`probe: manifest        ${manifestPath}`);
console.log(`probe: client bundle   ${require.resolve(`${PACKAGE_NAME}/client`)}`);
console.log(`probe: dsh declaration ${JSON.stringify(require(manifestPath).dsh)}`);
await import(PACKAGE_NAME);
console.log('probe: host half imported');

// ── 4. composition check ──────────────────────────────────────────────────────
const cliBin = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
const dump = execFileSync(process.execPath, [cliBin, '--profile', profile, '--dump-config'], { encoding: 'utf8' });
console.log(`probe: dump-config     ${String(dump.split('\n').filter((line) => line.includes(PACKAGE_NAME)).length)} line(s) mention ${PACKAGE_NAME}`);
if (!dump.includes(ROW_ID)) {
	process.stderr.write('install: the composed profile tree does not carry the row — the mount did not take effect\n');
	process.exit(1);
}
console.log('install: OK — mounted. Restart `dsh web` to load it.');
