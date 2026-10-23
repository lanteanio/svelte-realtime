import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import realtime from '../src/vite.js';
import { ADAPTER_CLIENT_DEPS } from '../src/vite/optimize-deps.js';

const CLIENT = 'svelte-realtime/client';
const DEPS = [CLIENT, 'svelte-realtime/devtools'];
const ADAPTER = ['svelte-adapter-uws/client', 'svelte-adapter-uws/plugins/smooth/random'];
const { exports } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));

describe('dependency optimization for generated modules', () => {
	// Each test gets an app root of its own: Node caches resolutions and
	// package.json reads per path for the life of the process.
	let appRoot;
	beforeEach(() => {
		appRoot = mkdtempSync(resolve(tmpdir(), 'realtime-optimize-'));
		writeFileSync(resolve(appRoot, 'package.json'), JSON.stringify({ name: 'app', private: true }));
		mkdirSync(resolve(appRoot, 'src/live'), { recursive: true });
	});
	afterEach(() => { rmSync(appRoot, { recursive: true, force: true }); });

	function installRealtime(dir) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'svelte-realtime', exports }));
		for (const entry of ['./client', './devtools']) {
			const file = resolve(dir, exports[entry].default);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, '');
		}
	}
	const installed = () => installRealtime(resolve(appRoot, 'node_modules/svelte-realtime'));
	function installAdapter(dir) {
		const adapterExports = {};
		for (const id of ADAPTER) {
			const file = './src/' + id.slice('svelte-adapter-uws/'.length) + '.js';
			adapterExports['.' + id.slice('svelte-adapter-uws'.length)] = { default: file };
			mkdirSync(dirname(resolve(dir, file)), { recursive: true });
			writeFileSync(resolve(dir, file), '');
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'svelte-adapter-uws', exports: adapterExports }));
	}
	// svelte-realtime linked from a checkout of its own, which has its own
	// node_modules, as `npm link` and `file:` installs set it up.
	function linkedRealtime() {
		const target = resolve(appRoot, 'checkout/svelte-realtime');
		installRealtime(target);
		link(target, resolve(appRoot, 'node_modules/svelte-realtime'));
		return target;
	}
	function link(target, path) {
		mkdirSync(resolve(path, '..'), { recursive: true });
		symlinkSync(target, path, 'junction');
	}

	// Vite hands configResolved the client's resolved optimizeDeps, after every
	// plugin and environment hook has adjusted it. Returns its final include.
	function resolveWith(options = {}, optimizeDeps = {}, config = {}) {
		const resolved = { include: [], ...optimizeDeps };
		realtime({ typedImports: false, ...options })
			.configResolved({ root: appRoot, build: {}, command: 'serve', optimizeDeps: resolved, ...config });
		return resolved.include;
	}

	it('optimizes the entry points generated modules import before the first page load', () => {
		installed();
		expect(resolveWith()).toEqual(DEPS);
	});

	it('optimizes the client entry point with devtools disabled', () => {
		installed();
		expect(resolveWith({ devtools: false })).toEqual([CLIENT]);
	});

	it('keeps the entries already listed and adds none twice', () => {
		installed();
		expect(resolveWith({}, { include: ['other', CLIENT] })).toEqual(['other', CLIENT, 'svelte-realtime/devtools']);
	});

	it('adds nothing to a build or a preview', () => {
		installed();
		expect(resolveWith({}, {}, { command: 'build' })).toEqual([]);
		expect(resolveWith({}, {}, { isPreview: true })).toEqual([]);
	});

	it('leaves a linked svelte-realtime to be served from source', () => {
		const target = resolve(appRoot, 'linked/svelte-realtime');
		installRealtime(target);
		link(target, resolve(appRoot, 'node_modules/svelte-realtime'));
		expect(resolveWith()).toEqual([]);
	});

	it('optimizes the adapter entries a linked svelte-realtime imports from node_modules', () => {
		const target = linkedRealtime();
		installAdapter(resolve(target, 'node_modules/svelte-adapter-uws'));
		installAdapter(resolve(appRoot, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith()).toEqual(ADAPTER);
		expect(resolveWith({ devtools: false })).toEqual(ADAPTER);
	});

	it('optimizes the adapter entries of an excluded svelte-realtime served from outside node_modules', () => {
		const target = linkedRealtime();
		installAdapter(resolve(target, 'node_modules/svelte-adapter-uws'));
		installAdapter(resolve(appRoot, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith({}, { exclude: ['svelte-realtime'] })).toEqual(ADAPTER);
	});

	it('leaves the adapter to be served from source where Vite would not optimize it', () => {
		const target = linkedRealtime();
		// The realtime checkout links the adapter from source.
		const adapterCheckout = resolve(appRoot, 'checkout/svelte-adapter-uws');
		installAdapter(adapterCheckout);
		link(adapterCheckout, resolve(target, 'node_modules/svelte-adapter-uws'));
		installAdapter(resolve(appRoot, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith()).toEqual([]);
	});

	it('leaves an adapter the app links from source to be served from source', () => {
		const target = linkedRealtime();
		installAdapter(resolve(target, 'node_modules/svelte-adapter-uws'));
		const adapterCheckout = resolve(appRoot, 'checkout/svelte-adapter-uws');
		installAdapter(adapterCheckout);
		link(adapterCheckout, resolve(appRoot, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith()).toEqual([]);
	});

	it('adds no adapter entry the app does not resolve', () => {
		const target = linkedRealtime();
		installAdapter(resolve(target, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith()).toEqual([]);
	});

	it('keeps adapter entries the user excluded out of the list', () => {
		const target = linkedRealtime();
		installAdapter(resolve(target, 'node_modules/svelte-adapter-uws'));
		installAdapter(resolve(appRoot, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith({}, { exclude: ['svelte-adapter-uws'] })).toEqual([]);
		expect(resolveWith({}, { exclude: [ADAPTER[0]] })).toEqual([ADAPTER[1]]);
	});

	it('adds no adapter entry for a linked svelte-realtime with discovery off', () => {
		const target = linkedRealtime();
		installAdapter(resolve(target, 'node_modules/svelte-adapter-uws'));
		installAdapter(resolve(appRoot, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith({}, { noDiscovery: true })).toEqual([]);
		expect(resolveWith({}, { disabled: 'dev' })).toEqual([]);
	});

	it('adds no adapter entry for an excluded svelte-realtime under node_modules', () => {
		installed();
		installAdapter(resolve(appRoot, 'node_modules/svelte-adapter-uws'));
		expect(resolveWith({}, { exclude: ['svelte-realtime'] })).toEqual([]);
	});

	it('lists every adapter entry the realtime browser modules import', () => {
		// Walk the relative imports of each browser entry point and collect
		// the svelte-adapter-uws specifiers they reach.
		const src = resolve(import.meta.dirname, '../src');
		const seen = new Set();
		const found = new Set();
		const visit = (file) => {
			if (seen.has(file)) return;
			seen.add(file);
			const code = readFileSync(file, 'utf8');
			for (const match of code.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)) {
				const spec = match[1] ?? match[2];
				if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
				else if (spec === 'svelte-adapter-uws' || spec.startsWith('svelte-adapter-uws/')) found.add(spec);
			}
		};
		for (const entry of ['./client', './multiplayer', './smooth', './doc', './rooms', './devtools']) {
			visit(resolve(src, '..', exports[entry].default));
		}
		expect(seen.size).toBeGreaterThan(6);
		expect([...found].sort()).toEqual([...ADAPTER_CLIENT_DEPS].sort());
		expect(ADAPTER).toEqual(ADAPTER_CLIENT_DEPS);
	});

	it('optimizes a linked svelte-realtime when Vite preserves symlinks', () => {
		const target = resolve(appRoot, 'linked/svelte-realtime');
		installRealtime(target);
		link(target, resolve(appRoot, 'node_modules/svelte-realtime'));
		expect(resolveWith({}, {}, { resolve: { preserveSymlinks: true } })).toEqual(DEPS);
	});

	it('optimizes a pnpm install, which links into node_modules/.pnpm', () => {
		const target = resolve(appRoot, 'node_modules/.pnpm/svelte-realtime@0.6.0/node_modules/svelte-realtime');
		installRealtime(target);
		link(target, resolve(appRoot, 'node_modules/svelte-realtime'));
		expect(resolveWith()).toEqual(DEPS);
	});

	it('adds nothing when the client entry point does not resolve', () => {
		const dir = resolve(appRoot, 'node_modules/svelte-realtime');
		installRealtime(dir);
		writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'svelte-realtime', exports: { './devtools': exports['./devtools'] } }));
		expect(resolveWith()).toEqual([]);
	});

	it('keeps entry points the user excluded out of the list', () => {
		installed();
		expect(resolveWith({}, { exclude: ['svelte-realtime'] })).toEqual([]);
		expect(resolveWith({}, { exclude: [CLIENT] })).toEqual(['svelte-realtime/devtools']);
	});

	it('adds nothing when dependency discovery is off in the resolved config', () => {
		installed();
		expect(resolveWith({}, { noDiscovery: true })).toEqual([]);
		expect(resolveWith({}, { disabled: true })).toEqual([]);
		expect(resolveWith({}, { disabled: 'dev' })).toEqual([]);
		expect(resolveWith({}, { disabled: 'build' })).toEqual(DEPS);
	});

	it('adds nothing through the config hook', () => {
		installed();
		expect(realtime({ typedImports: false }).config({ root: appRoot }, { command: 'serve' })).toBeUndefined();
	});
});
