import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import svelteRealtime from '../src/vite.js';

const root = resolve(import.meta.dirname, '__crdt_options__');
beforeEach(() => {
	mkdirSync(resolve(root, 'src/live'), { recursive: true });
	writeFileSync(resolve(root, 'src/live/docs.js'), `
// realtime-allow-public
import { live } from 'svelte-realtime/server';
export const document = live.doc({ topic: 'doc' });
export const dictionary = live.map({ topic: 'map' });
export const list = live.array({ topic: 'array' });
`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plugin(interval) {
	const instance = svelteRealtime({ crdt: { reconcileIntervalMs: interval } });
	instance.configResolved({ root, build: {} });
	return instance;
}

function channels(instance) {
	const code = instance.load('\0live:docs', { ssr: false });
	const executable = code.replace(/^(?:import |export \{).*;$/gm, '').replace(/^export const /gm, 'const ').replaceAll('import.meta.hot', 'undefined');
	const rpc = (path) => Object.assign((...args) => ({ path, args }), {
		send: (...args) => ({ path, args })
	});
	return new Function('__rpc', 'status', '_acquireDoc', 'createCrdtChannel',
		executable + '\nreturn [document.doc(7), dictionary.map(7), list.array(7)];')(
		rpc, {}, (_key, _kind, create) => create(), (options) => options);
}

describe('document reconcile configuration', () => {
	it.each([0, 1250])('passes interval %s to every generated document channel', (interval) => {
		for (const [index, channel] of channels(plugin(interval)).entries()) {
			expect(channel.reconcileIntervalMs).toBe(interval);
			const name = ['document', 'dictionary', 'list'][index];
			expect(channel.transport.sync('vector', 'mount')).toEqual({
				path: `docs/${name}/__doc/sync`, args: [7, 'vector', 'mount']
			});
			expect(channel.transport.sendUpdate([1])).toEqual({
				path: `docs/${name}/__doc/update`, args: [7, [1]]
			});
		}
	});

	it.each([undefined, -1, NaN, Infinity, '500'])('preserves the adapter default for %s', (interval) => {
		for (const channel of channels(plugin(interval))) {
			expect(channel).not.toHaveProperty('reconcileIntervalMs');
		}
	});

	it('keeps generated caches separate for different plugin configurations', () => {
		const first = plugin(0);
		const second = plugin(5000);
		expect(channels(first)[0].reconcileIntervalMs).toBe(0);
		expect(channels(second)[0].reconcileIntervalMs).toBe(5000);
		expect(channels(first)[0].reconcileIntervalMs).toBe(0);
	});
});
