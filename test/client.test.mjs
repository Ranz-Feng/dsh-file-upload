import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const CLIENT_BUNDLE = new URL('../lib/client.js', import.meta.url);

/**
 * Execute the browser bundle the way the page does — as a classic script that
 * may only register a factory — and hand back the registration.
 *
 * This is the closest a Node test can get to the real loader: it proves the
 * global call shape, the plugin id, and that nothing in the bundle touches the
 * DOM or React at script-evaluation time.
 *
 * @param require - Stand-in for the loader's synchronous module table.
 * @returns The single registration the bundle performed.
 */
async function loadBundle(require) {
	const source = await readFile(CLIENT_BUNDLE, 'utf8');
	const registrations = [];
	const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
	vm.runInNewContext(source, { window, console, btoa: (value) => Buffer.from(value, 'binary').toString('base64') });
	assert.equal(registrations.length, 1, 'the bundle must register exactly one factory');
	const [registration] = registrations;
	return { registration, exports: registration.factory(require) };
}

/** Minimal React stand-in: the component is created, never rendered, in these tests. */
const inertReact = { createElement: () => undefined, useState: () => [undefined, () => {}], useRef: () => ({}), useEffect: () => {} };

test('the bundle registers under its package name with a single-argument factory', async () => {
	const { registration } = await loadBundle((spec) => {
		assert.equal(spec, 'react');
		return inertReact;
	});
	assert.equal(registration.id, 'dsh-file-upload');
	assert.equal(typeof registration.factory, 'function');
	assert.equal(registration.factory.length, 1);
});

test('the bundle exports a cordis plugin that reads slots and connection', async () => {
	const { exports } = await loadBundle(() => inertReact);
	assert.equal(typeof exports.apply, 'function');
	assert.deepEqual([...exports.inject], ['slots', 'connection']);
	assert.equal(exports.name, 'file-upload');
	assert.equal(exports[Symbol.toStringTag], 'Module');
});

test('apply fills the composer input seat with a component', async () => {
	const { exports } = await loadBundle(() => inertReact);
	let injected;
	let registered;
	const ctx = {
		slots: {
			inject: (name, callback) => {
				injected = { name, callback };
			},
			register: (spec, component) => {
				registered = { spec, component };
			},
		},
		get: () => undefined,
	};
	exports.apply(ctx);
	assert.equal(injected.name, 'conversation.input.right');
	injected.callback();
	assert.equal(registered.spec.name, 'conversation.input.right');
	assert.equal(registered.spec.id, 'file-upload');
	assert.equal(typeof registered.component, 'function');
});
