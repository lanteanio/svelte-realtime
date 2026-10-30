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

describe('offline replay of an idempotency refusal that names a wait', () => {
	const rpcFrames = () => wire.filter(frame => frame.rpc);

	async function refuseFirst(code, retryAfter, calls = 1) {
		const observers = configure('server-win');
		status('disconnected');
		const pending = [];
		for (let i = 1; i <= calls; i++) {
			const call = client.__rpc('work/run')({ value: i });
			call.catch(() => {});
			pending.push(call);
		}
		await turn(); status('open'); await turn();
		const first = rpcFrames()[0];
		answer(first, { ok: false, code, error: 'later', retryAfter }); await turn();
		return { ...observers, pending, first };
	}

	for (const code of ['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_CAPACITY']) {
		it(`${code} waits as long as its retryAfter asks, up to the hold`, async () => {
			const { onReplayError, pending, first } = await refuseFirst(code, 30000);
			await vi.advanceTimersByTimeAsync(29999); expect(rpcFrames()).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			const second = rpcFrames()[1]; expect(second.idempotencyKey).toBe(first.idempotencyKey);
			answer(second, { ok: true, data: 'done' }); await turn();
			expect(await pending[0]).toBe('done'); expect(onReplayError).not.toHaveBeenCalled();
		});
	}

	it('waits for the longest hint when concurrent replays are refused', async () => {
		const onReplayError = vi.fn();
		const persist = { async getAll() { return []; }, async put(key, value) { rows.set(key, value); }, async delete(key) { rows.delete(key); }, async clear() {} };
		client.configure({ offline: { queue: true, persist, replay: 'concurrent', onReplayError } });
		status('disconnected');
		const calls = [1, 2].map(value => { const call = client.__rpc('work/run')({ value }); call.catch(() => {}); return call; });
		await turn(); status('open'); await turn();
		const [a, b] = rpcFrames();
		answer(a, { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'later', retryAfter: 20000 });
		answer(b, { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'later', retryAfter: 5000 });
		await turn();
		await vi.advanceTimersByTimeAsync(19999); expect(rpcFrames()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1); expect(rpcFrames().length).toBeGreaterThan(2);
		for (const frame of rpcFrames().slice(2)) answer(frame, { ok: true, data: frame.args[0].value });
		await turn();
		expect(await Promise.all(calls)).toEqual([1, 2]);
		expect(onReplayError).not.toHaveBeenCalled();
	});

	it('sets a call aside past the hold, keeps its row and replays the calls behind it', async () => {
		const { onReplayError, pending, first } = await refuseFirst('IDEMPOTENCY_CAPACITY', 30001, 2);
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(onReplayError.mock.calls[0][1]).toMatchObject({ code: 'IDEMPOTENCY_CAPACITY', retryAfter: 30001 });
		const second = rpcFrames()[1]; expect(second.args).toEqual([{ value: 2 }]);
		answer(second, { ok: true, data: 'second' }); await turn();
		expect(await pending[1]).toBe('second');
		let settled = false; pending[0].then(() => { settled = true; }, () => { settled = true; });
		await turn(); expect(settled).toBe(false);
		expect(stored()).toHaveLength(1);
		expect(rows.get(stored()[0]).retryAt).toBe(Date.now() + 30001);
		await vi.advanceTimersByTimeAsync(30000); expect(rpcFrames()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		const third = rpcFrames()[2]; expect(third.idempotencyKey).toBe(first.idempotencyKey);
		answer(third, { ok: true, data: 'first' }); await turn();
		expect(await pending[0]).toBe('first'); expect(stored()).toEqual([]);
	});

	it('keeps a call set aside through a page load until its retryAt', async () => {
		const { first } = await refuseFirst('IDEMPOTENCY_CAPACITY', 3600000);
		const retryAt = rows.get(stored()[0]).retryAt;
		expect(retryAt).toBe(Date.now() + 3600000);
		// A page load: the old page goes away, a fresh client reads the same rows.
		client._resetOffline();
		status('disconnected');
		statuses.clear();
		vi.resetModules();
		client = await import('../src/client.js');
		const { onReplayError } = configure('server-win');
		status('disconnected'); await turn(); status('open'); await turn();
		await vi.advanceTimersByTimeAsync(3600000 - 1);
		expect(rpcFrames()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		const again = rpcFrames()[1]; expect(again.idempotencyKey).toBe(first.idempotencyKey);
		answer(again, { ok: true, data: 'applied' }); await turn();
		expect(stored()).toEqual([]); expect(onReplayError).not.toHaveBeenCalled();
	});
});

describe('offline calls set aside by an idempotency refusal', () => {
	const rpcFrames = () => wire.filter(frame => frame.rpc);
	const persistTo = () => ({
		async getAll(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
		async put(key, value) { rows.set(key, value); }, async delete(key) { rows.delete(key); },
		async clear(prefix) { for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key); }
	});

	async function setAside(retryAfter, offline = {}, calls = 1) {
		const onReplayError = vi.fn();
		client.configure({ offline: { queue: true, persist: persistTo(), onReplayError, ...offline } });
		status('disconnected');
		const pending = [];
		for (let i = 1; i <= calls; i++) { const call = client.__rpc('work/run')({ value: i }); call.catch(() => {}); pending.push(call); }
		await turn(); status('open'); await turn();
		const first = rpcFrames()[0];
		answer(first, { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'later', retryAfter }); await turn();
		return { onReplayError, pending, first };
	}

	it('arms no wake while offline and replays on the next open', async () => {
		const { first } = await setAside(31000);
		const armed = vi.getTimerCount();
		status('disconnected'); await turn();
		// The one re-drain timer is gone, and nothing re-arms while offline.
		expect(vi.getTimerCount()).toBe(armed - 1);
		await vi.advanceTimersByTimeAsync(120000);
		expect(vi.getTimerCount()).toBe(armed - 1);
		expect(rpcFrames()).toHaveLength(1);
		status('open'); await turn();
		const again = rpcFrames()[1]; expect(again.idempotencyKey).toBe(first.idempotencyKey);
		expect(rows.get(stored()[0]).retryAt).toBeUndefined();
	});

	it('honours the next refusal\'s wait after a set-aside call is retried', async () => {
		await setAside(31000);
		await vi.advanceTimersByTimeAsync(31000);
		const retried = rpcFrames()[1]; expect(retried).toBeTruthy();
		answer(retried, { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'later', retryAfter: 5000 }); await turn();
		await vi.advanceTimersByTimeAsync(4999); expect(rpcFrames()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1); expect(rpcFrames()).toHaveLength(3);
		answer(rpcFrames()[2], { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'later' }); await turn();
		await vi.advanceTimersByTimeAsync(999); expect(rpcFrames()).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1); expect(rpcFrames()).toHaveLength(4);
	});

	it('drops a call as STALE when the wait reaches past its retention', async () => {
		const { onReplayError, pending } = await setAside(3600000, { maxAge: 60000 });
		await expect(pending[0]).rejects.toMatchObject({ code: 'STALE', message: expect.stringMatching(/server asked/), cause: { code: 'IDEMPOTENCY_CAPACITY' } });
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(stored()).toEqual([]);
	});

	it('waits out a hint longer than one timer can take', async () => {
		const wait = 3000000000;
		const { pending, first } = await setAside(wait, { retentionMs: 10 * wait });
		await vi.advanceTimersByTimeAsync(wait - 1); expect(rpcFrames()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		const again = rpcFrames()[1]; expect(again.idempotencyKey).toBe(first.idempotencyKey);
		answer(again, { ok: true, data: 'late' }); await turn();
		expect(await pending[0]).toBe('late');
	});

	it('keeps waking the current queue after its scope changes', async () => {
		await setAside(31000);
		client.configure({ offline: { queue: true, persist: persistTo(), persistKey: 'other' } }); await turn();
		status('disconnected');
		const call = client.__rpc('work/run')({ value: 'other' }); call.catch(() => {});
		await turn(); status('open'); await turn();
		const sent = rpcFrames().find(frame => frame.args[0].value === 'other');
		answer(sent, { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'later', retryAfter: 60000 }); await turn();
		const before = rpcFrames().length;
		await vi.advanceTimersByTimeAsync(60000);
		const again = rpcFrames().slice(before).find(frame => frame.args[0].value === 'other');
		expect(again?.idempotencyKey).toBe(sent.idempotencyKey);
	});

	it('keeps the upload-order gap when a set-aside call goes up after the calls behind it', async () => {
		const { pending } = await setAside(31000, {}, 2);
		answer(rpcFrames()[1], { ok: true, data: 'second' }); await turn();
		expect(await pending[1]).toBe('second');
		expect(client.offlineCheckpoint().gapDetected).toBe(true);
		await vi.advanceTimersByTimeAsync(31000);
		answer(rpcFrames()[2], { ok: true, data: 'first' }); await turn();
		expect(await pending[0]).toBe('first');
		expect(client.offlineCheckpoint()).toMatchObject({ lastUploadedSeq: 2, gapDetected: true });
	});
});

describe('calls set aside that come due during another drain', () => {
	const rpcFrames = () => wire.filter(frame => frame.rpc);
	const persist = () => ({
		async getAll(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
		async put(key, value) { rows.set(key, value); }, async delete(key) { rows.delete(key); },
		async clear(prefix) { for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key); }
	});
	const later = (frame, retryAfter, code = 'IDEMPOTENCY_CAPACITY') => answer(frame, { ok: false, code, error: 'later', retryAfter });

	it('replays a call that came due while the same drain was still running', async () => {
		client.configure({ offline: { queue: true, persist: persist() } });
		status('disconnected');
		const a = client.__rpc('work/run')({ value: 'a' }); a.catch(() => {});
		const b = client.__rpc('work/run').with({ timeout: 120000 })({ value: 'b' });
		await turn(); status('open'); await turn();
		const [first] = rpcFrames();
		later(first, 31000); await turn();
		const slow = rpcFrames()[1]; expect(slow.args).toEqual([{ value: 'b' }]);
		await vi.advanceTimersByTimeAsync(40000);
		expect(rpcFrames()).toHaveLength(2);
		answer(slow, { ok: true, data: 'b' }); await turn();
		const again = rpcFrames()[2]; expect(again?.idempotencyKey).toBe(first.idempotencyKey);
		answer(again, { ok: true, data: 'a' }); await turn();
		expect(await a).toBe('a'); expect(await b).toBe('b');
	});

	it('replays a call that came due while a retry drain was running', async () => {
		client.configure({ offline: { queue: true, persist: persist() } });
		status('disconnected');
		const a = client.__rpc('work/run')({ value: 'a' }); a.catch(() => {});
		const b = client.__rpc('work/run').with({ timeout: 120000 })({ value: 'b' });
		await turn(); status('open'); await turn();
		const [first] = rpcFrames();
		later(first, 31000); await turn();
		later(rpcFrames()[1], 20000, 'IDEMPOTENCY_IN_PROGRESS'); await turn();
		await vi.advanceTimersByTimeAsync(20000);
		const retried = rpcFrames()[2]; expect(retried.args).toEqual([{ value: 'b' }]);
		await vi.advanceTimersByTimeAsync(20000);
		expect(rpcFrames()).toHaveLength(3);
		answer(retried, { ok: true, data: 'b' }); await turn();
		const again = rpcFrames()[3]; expect(again?.idempotencyKey).toBe(first.idempotencyKey);
		answer(again, { ok: true, data: 'a' }); await turn();
		expect(await a).toBe('a'); expect(await b).toBe('b');
	});

	it('keeps the gap while a set-aside call waits through other drains', async () => {
		client.configure({ offline: { queue: true, persist: persist() } });
		status('disconnected');
		const a = client.__rpc('work/run')({ value: 'a' }); a.catch(() => {});
		const b = client.__rpc('work/run')({ value: 'b' });
		await turn(); status('open'); await turn();
		later(rpcFrames()[0], 60000); await turn();
		answer(rpcFrames()[1], { ok: true, data: 'b' }); await turn();
		expect(await b).toBe('b');
		expect(client.offlineCheckpoint().gapDetected).toBe(true);
		status('disconnected'); await turn();
		const c = client.__rpc('work/run')({ value: 'c' });
		await turn(); status('open'); await turn();
		const sentC = rpcFrames().find(frame => frame.args[0].value === 'c');
		answer(sentC, { ok: true, data: 'c' }); await turn();
		expect(await c).toBe('c');
		expect(client.offlineCheckpoint().gapDetected).toBe(true);
		await vi.advanceTimersByTimeAsync(60000);
		const sentA = rpcFrames().filter(frame => frame.args[0].value === 'a')[1];
		answer(sentA, { ok: true, data: 'a' }); await turn();
		expect(await a).toBe('a');
		expect(client.offlineCheckpoint().gapDetected).toBe(true);
	});
});

describe('offline replay of refusals that name no wait', () => {
	const rpcFrames = () => wire.filter(frame => frame.rpc);
	const persist = () => ({
		async getAll(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
		async put(key, value) { rows.set(key, value); }, async delete(key) { rows.delete(key); },
		async clear(prefix) { for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key); }
	});

	it('backs off, then sets the call aside so the calls behind it replay', async () => {
		const onReplayError = vi.fn();
		client.configure({ offline: { queue: true, persist: persist(), onReplayError } });
		status('disconnected');
		const a = client.__rpc('work/run')({ value: 'a' }); a.catch(() => {});
		const b = client.__rpc('work/run')({ value: 'b' });
		await turn(); status('open'); await turn();
		const sentA = [];
		const refuse = async () => {
			const frame = rpcFrames().at(-1); expect(frame.args).toEqual([{ value: 'a' }]);
			sentA.push(Date.now());
			answer(frame, { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'own call running' }); await turn();
		};
		const start = Date.now();
		await refuse();
		for (const step of [1000, 2000, 4000, 8000]) {
			await vi.advanceTimersByTimeAsync(step - 1); expect(rpcFrames()).toHaveLength(sentA.length);
			await vi.advanceTimersByTimeAsync(1); await refuse();
		}
		expect(sentA.map(at => at - start)).toEqual([0, 1000, 3000, 7000, 15000]);
		// The fifth refusal passes the hold in all: a is set aside and b goes up.
		expect(onReplayError).toHaveBeenCalledTimes(1);
		const sentB = rpcFrames().at(-1); expect(sentB.args).toEqual([{ value: 'b' }]);
		answer(sentB, { ok: true, data: 'b' }); await turn();
		expect(await b).toBe('b');
		await vi.advanceTimersByTimeAsync(15999); expect(rpcFrames().at(-1).args).toEqual([{ value: 'b' }]);
		await vi.advanceTimersByTimeAsync(1); await refuse();
		// The next wait doubles again, past the hold, so it sets the call aside at once.
		expect(onReplayError).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(32000);
		const last = rpcFrames().at(-1); expect(last.args).toEqual([{ value: 'a' }]);
		answer(last, { ok: true, data: 'a' }); await turn();
		expect(await a).toBe('a');
	});

	it('keeps the backoff before replaying a set-aside call that came due', async () => {
		client.configure({ offline: { queue: true, persist: persist() } });
		status('disconnected');
		const a = client.__rpc('work/run')({ value: 'a' }); a.catch(() => {});
		const b = client.__rpc('work/run').with({ timeout: 120000 })({ value: 'b' }); b.catch(() => {});
		await turn(); status('open'); await turn();
		answer(rpcFrames()[0], { ok: false, code: 'IDEMPOTENCY_CAPACITY', error: 'later', retryAfter: 31000 }); await turn();
		const slow = rpcFrames()[1];
		await vi.advanceTimersByTimeAsync(40000);
		// a came due while b ran; b is refused with no wait, so the drain backs off first.
		answer(slow, { ok: false, code: 'IDEMPOTENCY_IN_PROGRESS', error: 'later' }); await turn();
		expect(rpcFrames()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(999); expect(rpcFrames()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1); expect(rpcFrames().length).toBeGreaterThan(2);
	});
});

describe('offline backoff around the hold and retention', () => {
	const rpcFrames = () => wire.filter(frame => frame.rpc);
	const persist = () => ({
		async getAll(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
		async put(key, value) { rows.set(key, value); }, async delete(key) { rows.delete(key); },
		async clear(prefix) { for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key); }
	});
	const refuse = (frame, retryAfter, code = 'IDEMPOTENCY_CAPACITY') => answer(frame, retryAfter === undefined ? { ok: false, code, error: 'later' } : { ok: false, code, error: 'later', retryAfter });
	async function queued(values, offline = {}) {
		const onReplayError = vi.fn();
		client.configure({ offline: { queue: true, persist: persist(), onReplayError, ...offline } });
		status('disconnected');
		const calls = values.map(value => { const call = client.__rpc('work/run').with({ timeout: 600000 })({ value }); call.catch(() => {}); return call; });
		await turn(); status('open'); await turn();
		return { onReplayError, calls };
	}
	const last = value => rpcFrames().filter(frame => frame.args[0].value === value).at(-1);
	const sent = value => rpcFrames().filter(frame => frame.args[0].value === value).length;

	it('keeps a backed-off head waiting when a set-aside call comes due sooner', async () => {
		await queued(['a', 'b']);
		refuse(last('a'), 31000); await turn();
		await vi.advanceTimersByTimeAsync(29000);
		refuse(last('b'), 20000); await turn();
		await vi.advanceTimersByTimeAsync(2000);
		expect(sent('a')).toBe(1); expect(sent('b')).toBe(1);
		await vi.advanceTimersByTimeAsync(17999);
		expect(sent('b')).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent('a')).toBe(2);
		answer(last('a'), { ok: true, data: 'a' }); await turn();
		expect(sent('b')).toBe(2);
	});

	it('gives its own backoff one last try inside the retention', async () => {
		const { onReplayError, calls } = await queued(['a'], { maxAge: 20000 });
		const start = Date.now();
		refuse(last('a')); await turn();
		for (const step of [1000, 2000, 4000, 8000]) { await vi.advanceTimersByTimeAsync(step); refuse(last('a')); await turn(); }
		// The next backoff, 16 s, would pass the retention: it is cut to one
		// last try a second before the retention ends.
		expect(onReplayError).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(start + 19000 - Date.now() - 1); expect(sent('a')).toBe(5);
		await vi.advanceTimersByTimeAsync(1); expect(sent('a')).toBe(6);
		refuse(last('a')); await turn();
		await expect(calls[0]).rejects.toMatchObject({ code: 'STALE', message: 'Offline mutation expired' });
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(stored()).toEqual([]);
	});

	it('still takes the last try when its timer fires late', async () => {
		const { calls } = await queued(['a'], { maxAge: 20000 });
		const start = Date.now();
		refuse(last('a')); await turn();
		for (const step of [1000, 2000, 4000, 8000]) { await vi.advanceTimersByTimeAsync(step); refuse(last('a')); await turn(); }
		await vi.advanceTimersByTimeAsync(start + 19000 - Date.now() - 1);
		// The clock moves on while the timer is held back, as in a background tab.
		vi.setSystemTime(Date.now() + 900);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent('a')).toBe(6);
		answer(last('a'), { ok: true, data: 'a' }); await turn();
		expect(await calls[0]).toBe('a');
	});

	it('drops a held call at once when the server names a wait past its retention', async () => {
		const { calls } = await queued(['a', 'b'], { maxAge: 20000 });
		await vi.advanceTimersByTimeAsync(15000);
		refuse(last('a'), 10000); await turn();
		await expect(calls[0]).rejects.toMatchObject({ code: 'STALE', message: expect.stringMatching(/server asked/), cause: { code: 'IDEMPOTENCY_CAPACITY' } });
		expect(sent('b')).toBe(1);
	});

	it('cuts a held backoff to one last try inside the retention', async () => {
		const { calls } = await queued(['a'], { maxAge: 20000 });
		await vi.advanceTimersByTimeAsync(15000);
		refuse(last('a')); await turn();
		await vi.advanceTimersByTimeAsync(1000); refuse(last('a')); await turn();
		await vi.advanceTimersByTimeAsync(2000);
		// 18 s in: a 4 s backoff would pass the retention, so the try comes at 19 s.
		refuse(last('a')); await turn();
		await vi.advanceTimersByTimeAsync(999); expect(sent('a')).toBe(3);
		await vi.advanceTimersByTimeAsync(1); expect(sent('a')).toBe(4);
		refuse(last('a')); await turn();
		await expect(calls[0]).rejects.toMatchObject({ code: 'STALE', message: 'Offline mutation expired' });
	});

	it('does not blame the server for the one-second minimum on its hint', async () => {
		const { calls } = await queued(['a'], { maxAge: 20000 });
		await vi.advanceTimersByTimeAsync(19500);
		refuse(last('a'), 400); await turn();
		expect(sent('a')).toBe(2);
		answer(last('a'), { ok: true, data: 'a' }); await turn();
		expect(await calls[0]).toBe('a');
	});

	it('doubles a backoff past the hold up to five minutes', async () => {
		const { onReplayError } = await queued(['a']);
		refuse(last('a')); await turn();
		for (const step of [1000, 2000, 4000, 8000]) { await vi.advanceTimersByTimeAsync(step); refuse(last('a')); await turn(); }
		for (const wait of [16000, 32000, 64000, 128000, 256000, 300000, 300000]) {
			expect(rows.get(stored()[0]).retryAt).toBe(Date.now() + wait);
			await vi.advanceTimersByTimeAsync(wait);
			refuse(last('a')); await turn();
		}
		expect(onReplayError).toHaveBeenCalledTimes(8);
	});

	it('replays a set-aside call that would expire before a hold ends', async () => {
		const onReplayError = vi.fn();
		client.configure({ offline: { queue: true, persist: persist(), onReplayError, maxAge: 60000 } });
		status('disconnected');
		const x = client.__rpc('work/run').with({ timeout: 600000 })({ value: 'x' }); x.catch(() => {});
		await vi.advanceTimersByTimeAsync(20000);
		const a = client.__rpc('work/run').with({ timeout: 600000 })({ value: 'a' }); a.catch(() => {});
		await turn(); status('open'); await turn();
		refuse(last('x'), 31000); await turn();
		await vi.advanceTimersByTimeAsync(32000);
		// a holds the queue until 72 s; x is due at 51 s and expires at 60 s.
		refuse(last('a'), 20000); await turn();
		expect(sent('x')).toBe(2);
		answer(last('x'), { ok: true, data: 'x' }); await turn();
		expect(await x).toBe('x');
		await vi.advanceTimersByTimeAsync(19999); expect(sent('a')).toBe(1);
		await vi.advanceTimersByTimeAsync(1); expect(sent('a')).toBe(2);
		answer(last('a'), { ok: true, data: 'a' }); await turn();
		expect(await a).toBe('a');
		expect(client.offlineCheckpoint().gapDetected).toBe(true);
	});

	it('keeps the gap when a set-aside call goes up ahead of the held head', async () => {
		const at = Date.now();
		const row = (seq, value, expiresAt) => ({ seq, path: 'work/run', args: [{ value }], queuedAt: at, expiresAt, idempotencyKey: 'key-' + value, timeout: 600000 });
		rows.set('q:default:000000000001', row(1, 'a', at + 600000));
		rows.set('q:default:000000000002', row(2, 'x', at + 40000));
		client.configure({ offline: { queue: true, persist: persist(), replay: 'concurrent' } });
		status('disconnected'); await turn(); status('open'); await turn();
		refuse(last('x'), 31000); await turn();
		await vi.advanceTimersByTimeAsync(20000);
		// a holds the queue until 45 s; x is due at 31 s and expires at 40 s.
		refuse(last('a'), 25000); await turn();
		await vi.advanceTimersByTimeAsync(11000);
		expect(sent('x')).toBe(2); expect(sent('a')).toBe(1);
		answer(last('x'), { ok: true, data: 'x' }); await turn();
		await vi.advanceTimersByTimeAsync(14000);
		expect(sent('a')).toBe(2);
		answer(last('a'), { ok: true, data: 'a' }); await turn();
		expect(stored()).toEqual([]);
		expect(client.offlineCheckpoint().gapDetected).toBe(true);
	});

	it('does not count a hold that a lost connection cut short', async () => {
		const { onReplayError } = await queued(['a', 'b'], { replay: 'concurrent' });
		refuse(last('a'), 20000); await turn();
		status('disconnected'); await turn();
		status('open'); await turn();
		expect(sent('a')).toBe(2);
		refuse(last('a'), 15000); await turn();
		expect(onReplayError).not.toHaveBeenCalled();
	});

	it('starts the hold afresh once a call has been set aside', async () => {
		const { onReplayError } = await queued(['a']);
		refuse(last('a')); await turn();
		for (const step of [1000, 2000, 4000, 8000]) { await vi.advanceTimersByTimeAsync(step); refuse(last('a')); await turn(); }
		expect(onReplayError).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(16000);
		refuse(last('a'), 20000); await turn();
		// A fresh hold: 20 s fits, so the queue waits for it rather than setting it aside.
		expect(onReplayError).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(19999); expect(sent('a')).toBe(6);
		await vi.advanceTimersByTimeAsync(1); expect(sent('a')).toBe(7);
	});

	it('counts the time a concurrent drain actually waited toward the hold', async () => {
		const { onReplayError, calls } = await queued(['a', 'b'], { replay: 'concurrent' });
		refuse(last('a')); refuse(last('b'), 20000); await turn();
		await vi.advanceTimersByTimeAsync(20000);
		answer(last('b'), { ok: true, data: 'b' });
		refuse(last('a'), 15000); await turn();
		// a held the queue for 20 s already, so another 15 s passes the hold.
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(await calls[1]).toBe('b');
	});

	it('moves an earlier wake out past a hold that starts after it was armed', async () => {
		await queued(['a', 'd', 'b']);
		refuse(last('a'), 31000); await turn();
		refuse(last('d'), 40000); await turn();
		// a comes due while b is still out: the drain that picks it up starts
		// with the wake for d already armed.
		await vi.advanceTimersByTimeAsync(31500);
		answer(last('b'), { ok: true, data: 'b' }); await turn();
		expect(sent('a')).toBe(2);
		refuse(last('a'), 20000); await turn();
		await vi.advanceTimersByTimeAsync(19999);
		expect(sent('a')).toBe(2); expect(sent('d')).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent('a')).toBe(3);
	});

	it('counts the time a concurrent replay waited for the rest of its drain', async () => {
		const { onReplayError } = await queued(['a', 'b'], { replay: 'concurrent' });
		refuse(last('a')); await turn();
		await vi.advanceTimersByTimeAsync(25000);
		answer(last('b'), { ok: true, data: 'b' }); await turn();
		// Its 1 s backoff has long passed: it goes again as the drain ends.
		expect(sent('a')).toBe(2);
		// 25 s held already: another 6 s passes the hold.
		refuse(last('a'), 6000); await turn();
		expect(onReplayError).toHaveBeenCalledTimes(1);
	});

	it('does not hold a new scope to the backoff of the scope before it', async () => {
		await queued(['a']);
		refuse(last('a'), 25000); await turn();
		const value = rows.get(stored()[0]);
		rows.set('q:other:000000000001', { ...value, args: [{ value: 'o' }] });
		client.configure({ offline: { queue: true, persist: persist(), persistKey: 'other' } }); await turn();
		expect(sent('o')).toBe(1);
		refuse(last('o')); await turn();
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent('o')).toBe(2);
	});

	it('wakes a new scope\'s set-aside call on time after the scope before it backed off', async () => {
		await queued(['a']);
		refuse(last('a'), 25000); await turn();
		const value = rows.get(stored()[0]);
		rows.set('q:other:000000000001', { ...value, args: [{ value: 'o' }], retryAt: Date.now() + 5000 });
		client.configure({ offline: { queue: true, persist: persist(), persistKey: 'other' } }); await turn();
		expect(sent('o')).toBe(0);
		await vi.advanceTimersByTimeAsync(4999); expect(sent('o')).toBe(0);
		await vi.advanceTimersByTimeAsync(1); expect(sent('o')).toBe(1);
	});
});
