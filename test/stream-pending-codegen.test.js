import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { readable, get } from 'svelte/store';
import { _generateClientStubs } from '../src/vite/codegen-client.js';
import { _extractStreamOptions } from '../src/vite/extract-options.js';
import { _generateSsrStubs } from '../src/vite/codegen-ssr.js';

const fixture = resolve('test/__pending_fixture.js');
afterEach(() => { try { unlinkSync(fixture); } catch {} vi.restoreAllMocks(); });

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

	it('exposes inert pending on static, dynamic and hydrated SSR streams', () => {
		writeFileSync(fixture, `
export const items = live.stream('items', async () => []);
export const room = live.stream((ctx, id) => 'room:' + id, async () => []);
`);
		const code = _generateSsrStubs(fixture, 'pending');
		const executable = code.split('\n').filter(line => !/^(import |export )/.test(line)).join('\n');
		const timer = vi.spyOn(globalThis, 'setTimeout');
		const [items, room] = new Function('readable', executable + '\nreturn [_items, _room];')(readable);
		for (const store of [items, room('a'), items.hydrate([]), room('a').hydrate([])]) {
			expect(get(store.pending)).toBe(false);
		}
		expect(timer).not.toHaveBeenCalled();
	});
});
