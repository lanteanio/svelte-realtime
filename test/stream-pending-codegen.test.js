import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { readable, get } from 'svelte/store';
import { _fileCache } from '../src/vite/source-cache.js';
import { _generateClientStubs } from '../src/vite/codegen-client.js';
import { _extractStreamOptions } from '../src/vite/extract-options.js';
import { _generateSsrStubs } from '../src/vite/codegen-ssr.js';

// Per process, so parallel runs of this file do not share one fixture.
const fixture = resolve(`test/__pending_fixture_${process.pid}.js`);
afterEach(() => { _fileCache.delete(fixture); try { unlinkSync(fixture); } catch {} vi.restoreAllMocks(); });

describe('pending indicator code generation', () => {
	it('forwards zero and custom stream delays to client stubs', () => {
		writeFileSync(fixture, `
// realtime-allow-public
export const items = live.stream('items', async () => [], { pendingDelay: 0 });
export const room = live.stream((ctx, id) => 'room:' + id, async () => [], { pendingDelay: 250 });
`);
		const code = _generateClientStubs(fixture, 'pending', 'src/live');
		expect(code).toContain('"pendingDelay":0');
		expect(code).toContain('"pendingDelay":250');
	});

	it.each(['-1', '0.5', 'Infinity', 'NaN', '2147483648', 'delay'])('rejects invalid literal %s', value => {
		expect(() => _extractStreamOptions(`// realtime-allow-public
export const items = live.stream('items', async () => [], { pendingDelay: ${value} });`, 'items')).toThrow(/pendingDelay/);
	});

	it('uses the last declared delay and rejects an unknown overriding spread', () => {
		expect(_extractStreamOptions("export const items = live.stream('items', () => [], { pendingDelay: 10, pendingDelay: 250 });", 'items').pendingDelay).toBe(250);
		expect(() => _extractStreamOptions("export const items = live.stream('items', () => [], { pendingDelay: 10, ...unknown });", 'items')).toThrow(/pendingDelay/);
		expect(_extractStreamOptions("export const items = live.stream('items', () => [], { ...unknown, pendingDelay: 250 });", 'items').pendingDelay).toBe(250);
	});

	it('reads a delay held in a module-level const or spread from one', () => {
		expect(_extractStreamOptions("const DELAY = 250;\nexport const items = live.stream('items', () => [], { pendingDelay: DELAY });", 'items').pendingDelay).toBe(250);
		expect(_extractStreamOptions("const BASE = { pendingDelay: 300 };\nexport const items = live.stream('items', () => [], { ...BASE, merge: 'set' });", 'items')).toMatchObject({ merge: 'set', pendingDelay: 300 });
		expect(() => _extractStreamOptions("let delay = 250; delay++;\nexport const items = live.stream('items', () => [], { pendingDelay: delay });", 'items')).toThrow(/pendingDelay/);
	});

	it('exposes inert pending on static, dynamic and hydrated SSR streams', () => {
		writeFileSync(fixture, `
export const items = live.stream('items', async () => []);
export const _pending = live.stream('named', async () => []);
export const room = live.stream((ctx, id) => 'room:' + id, async () => []);
`);
		const code = _generateSsrStubs(fixture, 'pending');
		const executable = code.split('\n').filter(line => !/^(import |export )/.test(line)).join('\n');
		const timer = vi.spyOn(globalThis, 'setTimeout');
		const [items, room, named] = new Function('readable', executable + '\nreturn [_items, _room, __pending];')(readable);
		for (const store of [items, named, room('a'), items.hydrate([]), room('a').hydrate([])]) {
			expect(get(store.pending)).toBe(false);
		}
		expect(timer).not.toHaveBeenCalled();
	});
});
