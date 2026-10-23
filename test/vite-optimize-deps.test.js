import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import realtime from '../src/vite.js';

const CLIENT = 'svelte-realtime/client';
const DEPS = [CLIENT, 'svelte-realtime/devtools'];
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
