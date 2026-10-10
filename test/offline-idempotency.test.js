import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let client, statuses, topics, wire, rows;
function status(value) { for (const callback of [...statuses]) callback(value); }
function answer(frame, payload) { for (const callback of topics.get('__rpc') || []) callback({ event: frame.id, data: payload }); }
const turn = () => vi.advanceTimersByTimeAsync(0);
const stored = () => [...rows.keys()].filter(key => key.startsWith('q:'));
beforeEach(async () => {
	vi.resetModules(); vi.useFakeTimers();
	statuses = new Set(); topics = new Map(); wire = []; rows = new Map();
	const connection = {
		send: frame => wire.push(frame), sendQueued: frame => wire.push(frame), bufferedAmount: 0,
		status: { subscribe(callback) { statuses.add(callback); callback('open'); return () => statuses.delete(callback); } },
		failure: { subscribe(callback) { callback(null); return () => {}; } },
		denials: { subscribe(callback) { callback(null); return () => {}; } },
		onRequest: () => () => {},
		on: topic => ({ subscribe(callback) { let callbacks = topics.get(topic); if (!callbacks) topics.set(topic, callbacks = new Set()); callbacks.add(callback); return () => callbacks.delete(callback); } })
	};
	vi.doMock('svelte-adapter-uws/client', () => ({ ...connection, connect: () => connection, setTopicManaged: () => {}, onDerived: () => ({ subscribe: () => () => {} }) }));
	client = await import('../src/client.js'); client._resetOffline();
});
afterEach(() => { status('disconnected'); client._resetOffline(); vi.clearAllTimers(); vi.useRealTimers(); });

function configure(conflictResolution) {
	const onReplayError = vi.fn(), onConflict = vi.fn();
	const persist = {
		async getAll(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({ key,value })); },
		async put(key,value) { rows.set(key,value); }, async delete(key) { rows.delete(key); },
		async clear(prefix) { for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key); }
	};
	client.configure({ offline: { queue: true, persist, conflictResolution, onReplayError, onConflict } });
	return { onReplayError, onConflict, persist };
}

describe('offline replay of retryable idempotency refusals', () => {
	for (const code of ['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_CAPACITY']) for (const policy of ['server-win', 'lww', 'custom']) {
		it(`${code} retains the mutation and retries with backoff under ${policy}`, async () => {
			const observers = configure(policy);
			status('disconnected');
			let settled = false;
			const call = client.__rpc('work/run')({ value: 1 });
			call.then(() => { settled = true; }, () => { settled = true; });
			await turn(); status('open'); await turn();
			const first = wire.find(frame => frame.rpc); expect(first).toBeTruthy();
			answer(first, { ok: false, code, error: 'retry later' }); await turn();
			expect(settled).toBe(false); expect(stored()).toHaveLength(1);
			expect(observers.onReplayError).not.toHaveBeenCalled(); expect(observers.onConflict).not.toHaveBeenCalled();
			expect(wire.filter(frame => frame.rpc)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(999); expect(wire.filter(frame => frame.rpc)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			const second = wire.filter(frame => frame.rpc)[1]; expect(second).toBeTruthy();
			expect(second.idempotencyKey).toBe(first.idempotencyKey); expect(second.args).toEqual(first.args);
			answer(second, { ok: true, data: 'original result' }); await turn();
			expect(await call).toBe('original result'); expect(stored()).toEqual([]);
		});
	}

	async function waitForRetry() {
		const observers = configure('server-win'); status('disconnected');
		const call = client.__rpc('work/run')({ value: 1 }); call.catch(() => {});
		await turn(); status('open'); await turn();
		const first = wire.find(frame => frame.rpc);
		answer(first, { ok: false, code: 'IDEMPOTENCY_IN_PROGRESS', error: 'retry later' }); await turn();
		return { ...observers, call, first };
	}

	it('keeps the queued row through disconnect during retry backoff', async () => {
		const { call, first } = await waitForRetry();
		status('disconnected'); await vi.advanceTimersByTimeAsync(1000);
		expect(wire.filter(frame => frame.rpc)).toHaveLength(1); expect(stored()).toHaveLength(1);
		status('open'); await turn();
		const second = wire.filter(frame => frame.rpc)[1]; expect(second.idempotencyKey).toBe(first.idempotencyKey);
		answer(second, { ok: true, data: 'done' }); await turn(); expect(await call).toBe('done');
	});

	it('does not replay an old queue after its scope changes during backoff', async () => {
		const { call, persist } = await waitForRetry();
		client.configure({ offline: { queue: true, persist, persistKey: 'another' } });
		await expect(call).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(wire.filter(frame => frame.rpc)).toHaveLength(1); expect(stored()).toHaveLength(1);
	});

	it('does not restart a replay after the connection closes for good during backoff', async () => {
		const { call } = await waitForRetry();
		let settled = false; call.then(() => { settled = true; }, () => { settled = true; });
		status('failed'); await turn();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wire.filter(frame => frame.rpc)).toHaveLength(1); expect(stored()).toHaveLength(1);
	});

});
