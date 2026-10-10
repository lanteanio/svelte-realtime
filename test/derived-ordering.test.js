import { afterEach, describe, expect, it, vi } from 'vitest';
import { live, _prepareHmr, _restoreHmr } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';

const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

let env;
afterEach(() => {
	env?.cleanup();
	env = null;
	_prepareHmr();
	vi.useRealTimers();
});

async function setup(options = {}) {
	let value = 0;
	const pending = [];
	const compute = () => value === 0 ? 0 : new Promise((resolve, reject) => {
		pending.push({ value, resolve, reject });
	});
	const derived = options.dynamic
		? live.derived(() => ['source'], compute, options)
		: live.derived(['source'], compute, options);
	env = createTestEnv();
	env.register('stats', { derived });
	const client = env.connect();
	const stream = client.subscribe('stats/derived');
	await stream.waitFor((v) => v === 0);
	return { stream, pending, client, publish(next) { value = next; env.platform.publish('source', 'set', next); } };
}

describe('derived recomputation ordering', () => {
	it.each([false, true])('serializes work and delivers only the latest value (dynamic: %s)', async (dynamic) => {
		const { stream, pending, publish } = await setup({ dynamic });
		publish(1);
		publish(2);
		publish(3);
		expect(pending.map((p) => p.value)).toEqual([1]);
		pending[0].resolve(1);
		await flush();
		expect(stream.events).toEqual([]);
		expect(pending.map((p) => p.value)).toEqual([1, 3]);
		pending[1].resolve(3);
		await flush();
		expect(stream.value).toBe(3);
		expect(stream.events.map((event) => event.data)).toEqual([3]);
	});

	it('invalidates an in-flight value as soon as a debounced source changes', async () => {
		const { stream, pending, publish } = await setup({ debounce: 30 });
		vi.useFakeTimers();
		publish(1);
		await vi.advanceTimersByTimeAsync(30);
		publish(2);
		pending[0].resolve(1);
		await flush();
		expect(stream.events).toEqual([]);
		expect(pending).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30);
		pending[1].resolve(2);
		await flush();
		expect(stream.value).toBe(2);
	});

	it('retries the latest source state after an older computation fails', async () => {
		const { stream, pending, publish } = await setup();
		publish(1);
		publish(2);
		pending[0].reject(new Error('Read unavailable'));
		await flush();
		expect(pending.map((p) => p.value)).toEqual([1, 2]);
		pending[1].resolve(2);
		await flush();
		expect(stream.value).toBe(2);
	});

	it('drops completions and queued work when the last dynamic subscriber leaves', async () => {
		const { stream, pending, client, publish } = await setup({ dynamic: true });
		const published = vi.spyOn(env.platform, 'publish');
		publish(1);
		publish(2);
		client.disconnect();
		pending[0].resolve(1);
		await flush();
		expect(pending).toHaveLength(1);
		expect(stream.events).toEqual([]);
		expect(published.mock.calls.some(([topic]) => topic === stream.topic)).toBe(false);
	});

	it('discards computations suspended across module replacement', async () => {
		const { stream, pending, publish } = await setup();
		publish(1);
		const snapshot = _prepareHmr();
		_restoreHmr(snapshot);
		pending[0].resolve(1);
		await flush();
		expect(stream.events).toEqual([]);
		publish(2);
		pending[1].resolve(2);
		await flush();
		expect(stream.value).toBe(2);
	});
});
