// Runtime tests for the SmoothEntity rune's onEvent fan-out. SmoothEntity is a
// Svelte 5 rune class, so it is compiled with compileModule and imported - the
// same probe harness multiplayer.test.js uses. Its imports (the shared health
// flag from `./client.js` and the smooth devtools registrar from
// `./client/devtools-instrument.js`) are repointed to local stubs so the probe
// does not drag in the whole browser client. The adapter channel is mocked: it
// exposes the
// single-consumer onFrame/onOverflow/onEvent the rune wires in its constructor,
// and the test fires the captured onEvent callback to simulate delivery.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { compileModule } from 'svelte/compiler';

const SHIPPED_RUNE_PATH = resolve(import.meta.dirname, '../src/client-smooth.svelte.js');
const runeProbeRoot = resolve(import.meta.dirname, '__smooth_rune__');
const runeProbeDirs = [];
let runeProbeCounter = 0;

/** Compile the shipped SmoothEntity rune with its ./client.js import stubbed,
 * import it, and return the class. */
async function loadSmoothEntity() {
	mkdirSync(runeProbeRoot, { recursive: true });
	const probeDir = mkdtempSync(resolve(runeProbeRoot, 'probe-'));
	runeProbeDirs.push(probeDir);

	// Stub the imports so the probe does not pull in the browser connection module
	// or the devtools instrument: the shared degraded-health flag (`./client.js`)
	// and the smooth devtools registrar (`./client/devtools-instrument.js`), the
	// latter a no-op that returns a no-op unregister.
	writeFileSync(resolve(probeDir, 'client.js'), 'export function _setSmoothDegraded(v) { (globalThis.__degradedCalls ??= []).push(v); }\n');
	mkdirSync(resolve(probeDir, 'client'), { recursive: true });
	writeFileSync(resolve(probeDir, 'client', 'devtools-instrument.js'), 'export function _devtoolsSmoothRegister() { return () => {}; }\n');

	const source = readFileSync(SHIPPED_RUNE_PATH, 'utf8');
	const { js } = compileModule(source, { filename: 'client-smooth.svelte.js', generate: 'client' });
	const out = resolve(probeDir, 'client-smooth.js');
	writeFileSync(out, js.code);

	const mod = await import(pathToFileURL(out).href + '?t=' + ++runeProbeCounter);
	return mod.SmoothEntity;
}

/** A mock adapter smooth channel capturing the rune's single onEvent consumer. */
function mockChannel() {
	const ch = {
		predicted: { x: 0, y: 0 },
		self: 'me',
		fire: null,
		frame: null,
		overflow: null,
		stall: null,
		destroyed: false,
		onFrame(cb) {
			ch.frame = cb;
		},
		onOverflow(cb) {
			ch.overflow = cb;
		},
		onStall(cb) {
			ch.stall = cb;
		},
		onEvent(cb) {
			ch.fire = cb;
		},
		command: () => 0,
		now: () => 0,
		resync() {},
		destroy() {
			ch.destroyed = true;
		}
	};
	return ch;
}

// The freshness tag the adapter attaches to each remote frame state; Symbol.for
// so it matches the rune's key without importing the adapter.
const SMOOTH_FRESHNESS = Symbol.for('svelte-adapter-uws.smooth.freshness');

// The adapter connection-status store emits 'open' on connect (never
// 'connected' - the vocabulary the earlier center-resend bug checked).
const statusStore = { subscribe: (fn) => (fn('open'), () => {}) };

describe('SmoothEntity onEvent fan-out', () => {
	afterEach(() => {
		for (const dir of runeProbeDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		runeProbeDirs.length = 0;
		if (existsSync(runeProbeRoot) && readdirSync(runeProbeRoot).length === 0) {
			rmSync(runeProbeRoot, { recursive: true, force: true });
		}
	});

	it('registers ONE channel consumer and fans out to every subscriber, passing the event through unchanged', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		const view = new SmoothEntity(ch, statusStore);

		const a = [];
		const b = [];
		view.onEvent((e) => a.push(e));
		view.onEvent((e) => b.push(e));

		const ev = { type: 'shot', key: '1:0', data: { dir: 'N' }, id: 1, origin: 'local' };
		ch.fire(ev);
		expect(a).toEqual([ev]);
		expect(b).toEqual([ev]);

		view.destroy();
	});

	it('the returned unsubscribe stops delivery to that handler only', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		const view = new SmoothEntity(ch, statusStore);

		const a = [];
		const b = [];
		const offA = view.onEvent((e) => a.push(e));
		view.onEvent((e) => b.push(e));

		ch.fire({ type: 'x', key: '1:0', data: {}, id: 1, origin: 'server' });
		offA();
		ch.fire({ type: 'y', key: '2:0', data: {}, id: 2, origin: 'server' });

		expect(a.map((e) => e.type)).toEqual(['x']); // stopped after offA
		expect(b.map((e) => e.type)).toEqual(['x', 'y']); // still receiving

		view.destroy();
	});

	it('destroy() detaches all subscribers and releases the channel', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		const view = new SmoothEntity(ch, statusStore);

		const seen = [];
		view.onEvent((e) => seen.push(e));
		view.destroy();
		expect(ch.destroyed).toBe(true);
		ch.fire({ type: 'z', key: '1:0', data: {}, id: 1, origin: 'server' });
		expect(seen).toEqual([]);
	});
});

describe('SmoothEntity reportCenter / clearCenter', () => {
	afterEach(() => {
		for (const dir of runeProbeDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		runeProbeDirs.length = 0;
		if (existsSync(runeProbeRoot) && readdirSync(runeProbeRoot).length === 0) {
			rmSync(runeProbeRoot, { recursive: true, force: true });
		}
	});

	it('forwards a center, de-dupes an unchanged one, and forwards a clear (null)', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const reports = [];
		const view = new SmoothEntity(mockChannel(), statusStore, (c) => reports.push(c));

		view.reportCenter(10, 20);
		view.reportCenter(10, 20); // unchanged -> dropped
		view.reportCenter(11, 20); // moved -> sent
		view.reportCenter(NaN, 5); // non-finite -> dropped
		view.clearCenter();
		view.clearCenter(); // already cleared -> dropped
		view.reportCenter(11, 20); // after a clear, the prior center sends again

		expect(reports).toEqual([{ x: 10, y: 20 }, { x: 11, y: 20 }, null, { x: 11, y: 20 }]);
	});

	it('is inert when the topic has no interest (no report fn wired)', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const view = new SmoothEntity(mockChannel(), statusStore); // no reportCenter fn
		expect(() => { view.reportCenter(1, 2); view.clearCenter(); }).not.toThrow();
	});

	it('re-reports a set center on the first frame after a (re)connect so a free-cam survives a reconnect', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		let emit;
		// Real adapter status vocabulary: 'connecting' -> 'open' on connect,
		// 'disconnected' -> 'connecting' -> 'open' on a reconnect.
		const status = { subscribe: (fn) => { emit = fn; fn('connecting'); return () => {}; } };
		const reports = [];
		const view = new SmoothEntity(ch, status, (c) => reports.push(c));

		emit('open'); // initial connect, no center yet -> no pending re-send
		view.reportCenter(7, 8); // sent immediately
		ch.frame({ x: 0, y: 0 }, new Map()); // a frame with nothing pending -> no extra send
		expect(reports).toEqual([{ x: 7, y: 8 }]);

		// Reconnect on a new socket: the server has dropped the center; the next
		// frame re-establishes it.
		emit('disconnected');
		emit('connecting');
		emit('open');
		ch.frame({ x: 0, y: 0 }, new Map());
		expect(reports).toEqual([{ x: 7, y: 8 }, { x: 7, y: 8 }]);

		// A second frame does not re-send again (the flag was cleared).
		ch.frame({ x: 0, y: 0 }, new Map());
		expect(reports).toHaveLength(2);
	});

	it('does not re-send the center on a socket-survived suspended -> open refocus', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		let emit;
		const status = { subscribe: (fn) => { emit = fn; fn('connecting'); return () => {}; } };
		const reports = [];
		const view = new SmoothEntity(ch, status, (c) => reports.push(c));

		emit('open');
		view.reportCenter(7, 8);
		ch.frame({ x: 0, y: 0 }, new Map());
		expect(reports).toEqual([{ x: 7, y: 8 }]);

		// Background then foreground with the socket alive: server interest is
		// intact (the adapter soft-resumes in place), so no re-send.
		emit('suspended');
		emit('open');
		ch.frame({ x: 0, y: 0 }, new Map());
		expect(reports).toEqual([{ x: 7, y: 8 }]);
		view.destroy();
	});
});

describe('SmoothEntity stall and freshness', () => {
	afterEach(() => {
		for (const dir of runeProbeDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		runeProbeDirs.length = 0;
		if (existsSync(runeProbeRoot) && readdirSync(runeProbeRoot).length === 0) {
			rmSync(runeProbeRoot, { recursive: true, force: true });
		}
	});

	it('surfaces stalled and folds it into degraded health', async () => {
		globalThis.__degradedCalls = [];
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		const view = new SmoothEntity(ch, statusStore);
		expect(view.stalled).toBe(false);
		ch.stall(true);
		expect(view.stalled).toBe(true);
		expect(globalThis.__degradedCalls).toEqual([true]); // stall alone flips degraded
		ch.stall(false);
		expect(view.stalled).toBe(false);
		expect(globalThis.__degradedCalls).toEqual([true, false]);
		view.destroy();
	});

	it('keeps degraded set while either overflow or stall is active', async () => {
		globalThis.__degradedCalls = [];
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		const view = new SmoothEntity(ch, statusStore);
		ch.overflow(true); // -> degraded true
		ch.stall(true); // still degraded, no new transition
		ch.overflow(false); // stall still active -> stays degraded
		ch.stall(false); // both clear -> degraded false
		expect(globalThis.__degradedCalls).toEqual([true, false]);
		view.destroy();
	});

	it('reports per-entity freshness from the remote frame tag', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		const view = new SmoothEntity(ch, statusStore);
		const other = { x: 5, y: 5, [SMOOTH_FRESHNESS]: 'coasting' };
		ch.frame({ x: 0, y: 0 }, new Map([['other', other]]));
		expect(view.freshness('other')).toBe('coasting');
		expect(view.freshness('absent')).toBeUndefined();
		view.destroy();
	});
});

describe('SmoothEntity state identity (raw state, no deep proxy)', () => {
	afterEach(() => {
		for (const dir of runeProbeDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		runeProbeDirs.length = 0;
		if (existsSync(runeProbeRoot) && readdirSync(runeProbeRoot).length === 0) {
			rmSync(runeProbeRoot, { recursive: true, force: true });
		}
	});

	// Apps hang shared immutable records off their states and compare them by
	// reference (an identity-keyed Map, a frozen singleton). The view must hand
	// back the channel's objects untouched: a deep $state proxy would wrap every
	// nested read in a fresh proxy and silently break those comparisons.
	it('local and remote hand back the channel frame objects by reference, nested records included', async () => {
		const SmoothEntity = await loadSmoothEntity();
		const ch = mockChannel();
		const view = new SmoothEntity(ch, statusStore);

		const RECORD = Object.freeze({ speed: 24, name: 'ak' });
		const REGISTRY = new Map([[RECORD, 3]]);
		const local = { x: 1, y: 2, weapon: RECORD };
		const remoteState = { x: 5, y: 6, weapon: RECORD };
		ch.frame(local, new Map([['peer', remoteState]]));

		expect(view.local).toBe(local); // the frame object itself, not a wrapper
		expect(view.local.weapon).toBe(RECORD); // nested reads keep identity
		expect(REGISTRY.get(view.local.weapon)).toBe(3); // identity-keyed lookups resolve
		expect(view.remote.get('peer')).toBe(remoteState);
		expect(view.remote.get('peer').weapon).toBe(RECORD);

		// Reactivity by replacement still holds: a new frame shows through.
		const next = { x: 9, y: 9, weapon: RECORD };
		ch.frame(next, new Map());
		expect(view.local).toBe(next);
		expect(view.remote.size).toBe(0);

		view.destroy();
	});
});
