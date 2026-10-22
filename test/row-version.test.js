import { afterEach, describe, expect, it } from 'vitest';
import { live } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { _extractStreamOptions } from '../src/vite/extract-options.js';

// A crud stream's rowVersion names the row field that orders writes to one
// row; rows that are not newer than the one held are dropped.

let env;
afterEach(() => { env?.cleanup(); env = undefined; });

describe('crud rowVersion', () => {
	it('is validated where the stream is declared', () => {
		const load = async () => [];
		expect(() => live.stream('rv-bad', load, { rowVersion: '' })).toThrow(/rowVersion must be the name of a row field/);
		expect(() => live.stream('rv-bad', load, { rowVersion: 3 })).toThrow(/rowVersion must be the name of a row field/);
		expect(() => live.stream('rv-bad', load, { merge: 'set', rowVersion: 'rev' })).toThrow(/merge: 'crud' stream/);
		expect(live.stream('rv-ok', load, { rowVersion: 'rev' }).__streamOptions).toMatchObject({ merge: 'crud', key: 'id', rowVersion: 'rev' });
	});

	it('reaches subscribers, whose rows keep the newest version whatever the arrival order', async () => {
		env = createTestEnv();
		env.register('rv', { counter: live.stream('rv-counter', async () => [{ id: 'alpha', rev: 0, value: 0 }], { rowVersion: 'rev' }) });
		const client = env.connect({ id: 'u1' });
		const stream = client.subscribe('rv/counter');
		await stream.waitFor((value) => Array.isArray(value) && value.length === 1);
		env.platform.publish('rv-counter', 'updated', { id: 'alpha', rev: 2, value: 2 });
		env.platform.publish('rv-counter', 'updated', { id: 'alpha', rev: 1, value: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(stream.value).toEqual([{ id: 'alpha', rev: 2, value: 2 }]);
	});

	it('is carried into the generated client options', () => {
		const source = "export const counter = live.stream('counter', load, { merge: 'crud', key: 'id', rowVersion: 'rev' });";
		expect(_extractStreamOptions(source, 'counter')).toMatchObject({ merge: 'crud', key: 'id', rowVersion: 'rev' });
	});
});
