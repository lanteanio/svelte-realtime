import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import realtime from '../src/vite.js';
import { ADAPTER_CLIENT_DEPS } from '../src/vite/optimize-deps.js';

const CLIENT = 'svelte-realtime/client';
const DEPS = [CLIENT, 'svelte-realtime/devtools'];
const ADAPTER = ['svelte-adapter-uws/client', 'svelte-adapter-uws/plugins/smooth/random'];
const SMOOTH_CHANNEL = 'svelte-adapter-uws/plugins/smooth/client';
const CRDT_CHANNEL = 'svelte-adapter-uws/plugins/crdt/channel';
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
		for (const entry of Object.keys(exports)) {
			const file = resolve(dir, exports[entry].default);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, '');
		}
	}
	const installed = () => installRealtime(resolve(appRoot, 'node_modules/svelte-realtime'));
	function installAdapter(dir, version = '0.6.0') {
		const adapterExports = {};
		for (const id of [...ADAPTER, SMOOTH_CHANNEL, CRDT_CHANNEL]) {
			const file = './src/' + id.slice('svelte-adapter-uws/'.length) + '.js';
			adapterExports['.' + id.slice('svelte-adapter-uws'.length)] = { default: file };
			mkdirSync(dirname(resolve(dir, file)), { recursive: true });
			writeFileSync(resolve(dir, file), id === CRDT_CHANNEL ? "import * as Y from 'yjs';\nimport { on } from '../../client.js';\n" : '');
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'svelte-adapter-uws', version, exports: adapterExports }));
	}
	// svelte-realtime linked from a checkout of its own, which has its own
	// node_modules, as `npm link` and `file:` installs set it up.
	function linkedRealtime() {
		const target = resolve(appRoot, 'checkout/svelte-realtime');
		installRealtime(target);
		link(target, resolve(appRoot, 'node_modules/svelte-realtime'));
		return target;
	}
	function installPackage(name, version = '1.0.0') {
		const dir = resolve(appRoot, 'node_modules', name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
		writeFileSync(resolve(dir, 'index.js'), '');
	}
	function writeLive(source) {
		writeFileSync(resolve(appRoot, 'src/live/mod.js'), "import { live } from 'svelte-realtime/server';\n" + source + '\n');
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

	describe('modules the generated code imports for the declared export kinds', () => {
		beforeEach(() => {
			installed();
			installAdapter(resolve(appRoot, 'node_modules/svelte-adapter-uws'));
			installPackage('yjs');
		});

		it('optimizes the smoothed-entity runtime for a live.smooth export', () => {
			writeLive("export const game = live.smooth({ topic: 'game', apply: (s) => s });");
			expect(resolveWith()).toEqual([...DEPS, 'svelte-realtime/smooth', SMOOTH_CHANNEL]);
		});

		it('optimizes the CRDT runtime for a live.doc, live.map or live.array export', () => {
			for (const kind of ['doc', 'map', 'array']) {
				writeLive(`export const notes = live.${kind}({ topic: 'notes' });`);
				expect(resolveWith()).toEqual([...DEPS, 'svelte-realtime/doc', CRDT_CHANNEL]);
			}
		});

		it('leaves out the CRDT channel when yjs is not installed', () => {
			rmSync(resolve(appRoot, 'node_modules/yjs'), { recursive: true });
			writeLive("export const notes = live.doc({ topic: 'notes' });");
			expect(resolveWith()).toEqual([...DEPS, 'svelte-realtime/doc']);
		});

		it('optimizes the multiplayer view only for a multiplayer export that has one', () => {
			writeLive("export const board = live.multiplayer({ topic: 'board' });");
			expect(resolveWith()).toEqual(DEPS);
			writeLive("export const board = live.multiplayer({ topic: 'board', presence: true });");
			expect(resolveWith()).toEqual([...DEPS, 'svelte-realtime/multiplayer']);
		});

		it('optimizes the rooms list only for an enumerable room', () => {
			writeLive("export const lobby = live.room({ topic: 'lobby' });");
			expect(resolveWith()).toEqual(DEPS);
			writeLive("export const lobby = live.room({ topic: 'lobby', enumerable: true });");
			expect(resolveWith()).toEqual([...DEPS, 'svelte-realtime/rooms']);
		});

		it('optimizes the adapter runtime and leaves the realtime subpaths of a linked svelte-realtime to source', () => {
			rmSync(resolve(appRoot, 'node_modules/svelte-realtime'), { recursive: true });
			const target = linkedRealtime();
			installAdapter(resolve(target, 'node_modules/svelte-adapter-uws'));
			writeLive("export const game = live.smooth({ topic: 'game', apply: (s) => s });\nexport const notes = live.doc({ topic: 'notes' });");
			expect(resolveWith()).toEqual([...ADAPTER, SMOOTH_CHANNEL, CRDT_CHANNEL]);
		});

		it('adds no adapter runtime when the linked package runs the adapter from source', () => {
			rmSync(resolve(appRoot, 'node_modules/svelte-realtime'), { recursive: true });
			const target = linkedRealtime();
			const adapterCheckout = resolve(appRoot, 'checkout/svelte-adapter-uws');
			installAdapter(adapterCheckout);
			link(adapterCheckout, resolve(target, 'node_modules/svelte-adapter-uws'));
			writeLive("export const game = live.smooth({ topic: 'game', apply: (s) => s });\nexport const notes = live.doc({ topic: 'notes' });");
			expect(resolveWith()).toEqual([]);
		});

		it('adds no rune module the installed Svelte cannot run', () => {
			installPackage('svelte', '4.2.19');
			writeLive("export const game = live.smooth({ topic: 'game', apply: (s) => s });\nexport const notes = live.doc({ topic: 'notes' });");
			expect(resolveWith()).toEqual(DEPS);
		});

		it('keeps excluded runtime modules out of the list', () => {
			writeLive("export const game = live.smooth({ topic: 'game', apply: (s) => s });");
			expect(resolveWith({}, { exclude: [SMOOTH_CHANNEL] })).toEqual([...DEPS, 'svelte-realtime/smooth']);
			expect(resolveWith({}, { exclude: ['svelte-adapter-uws', 'svelte-realtime/smooth'] })).toEqual(DEPS);
			expect(resolveWith({}, { noDiscovery: true })).toEqual([]);
		});

		it('leaves the warnings of a live module to its first request', () => {
			writeLive("export const game = live.smooth({ topic: 'game', apply: (s) => s });\nexport const helper = 1;");
			const warn = console.warn;
			const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const plugin = realtime({ typedImports: false });
				const resolved = { include: [] };
				plugin.configResolved({ root: appRoot, build: {}, command: 'serve', optimizeDeps: resolved });
				expect(resolved.include).toContain(SMOOTH_CHANNEL);
				expect(spy).not.toHaveBeenCalled();
				expect(console.warn).toBe(spy);
				plugin.load.call({ error: (e) => { throw new Error(e); } }, '\0live:mod', { ssr: false });
				expect(spy.mock.calls.flat().join('\n')).toContain("exports 'helper' which is not wrapped in live()");
			} finally {
				spy.mockRestore();
			}
			expect(console.warn).toBe(warn);
		});
	});

	it('reads only the import lines of generated code, not literals copied into it', () => {
		installed();
		installPackage('lodash');
		writeLive("export const lobby = live.room({ topic: 'lobby', key: \"from 'lodash'\" });\nexport const items = live.stream('items', async () => [], { key: \"import 'lodash'\" });");
		expect(resolveWith()).toEqual(DEPS);
	});

	it('generates every module whose client code imports more than the realtime client', async () => {
		// Each fixture module, generated in full, against what the scan reports.
		const { _generateClientStubs } = await import('../src/vite/codegen-client.js');
		const { _generatedClientImports } = await import('../src/vite/optimize-deps.js');
		const liveDir = resolve(import.meta.dirname, 'fixture/src/live');
		writeLive([
			"export const game = live.smooth({ topic: 'game', apply: (s) => s });",
			"export const notes = live.array({ topic: 'notes' });",
			"export const board = live.multiplayer({ topic: 'board', cursors: true });",
			"export const lobby = live.room({ topic: 'lobby', enumerable: true });"
		].join('\n'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (const dir of [liveDir, resolve(appRoot, 'src/live')]) {
				const expected = new Set();
				for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
					const code = _generateClientStubs(resolve(dir, file), file.slice(0, -3), 'src/live');
					for (const m of code.matchAll(/^(?:import|export) .* from '([^']+)';$/gm)) {
						if (m[1] !== CLIENT) expected.add(m[1]);
					}
				}
				const found = new Set(_generatedClientImports(dir, 'src/live', undefined, null));
				found.delete(CLIENT);
				expect([...found].sort()).toEqual([...expected].sort());
			}
		} finally {
			warn.mockRestore();
		}
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
