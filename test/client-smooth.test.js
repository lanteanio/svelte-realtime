// Runtime tests for the SmoothEntity rune's onEvent fan-out. SmoothEntity is a
// Svelte 5 rune class, so it is compiled with compileModule and imported - the
// same probe harness multiplayer.test.js uses. Its `./client.js` import (the
// shared health flag) is repointed to a local stub so the probe does not drag
// in the whole browser client. The adapter channel is mocked: it exposes the
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

	// Stub the only import (the shared degraded-health flag) so the probe does
	// not pull in the browser connection module.
	writeFileSync(resolve(probeDir, 'client.js'), 'export function _setSmoothDegraded() {}\n');

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
		destroyed: false,
		onFrame() {},
		onOverflow() {},
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

const statusStore = { subscribe: (fn) => (fn('connected'), () => {}) };

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
