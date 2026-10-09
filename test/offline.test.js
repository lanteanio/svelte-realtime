// The durable offline queue: persistence write-through (via an injected
// OfflineStore fake - the house "mock the module boundary, run in node"
// pattern, no jsdom/fake-indexeddb), rehydrate-on-configure, the synthesized
// idempotency key, the upload checkpoint (advance + gap detection + clean
// clear), the pendingMutations/uploading consumer stores, the
// conflict-resolution stance (server-win / lww / custom) for replayed
// mutations rejected with CONFLICT, and what a connection closed for good
// leaves queued (a hand-rolled IndexedDB stands in for the default store).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let statusCallbacks;
let statusInitialValue;
let topicCallbacks;
let sendQueuedFn;

function simulateStatus(s) {
	// Like the adapter's status store, a later subscriber gets the last value.
	statusInitialValue = s;
	for (const cb of [...statusCallbacks]) cb(s);
}
function simulateRpcResponse(correlationId, payload) {
	const fns = topicCallbacks.get('__rpc');
	if (fns) for (const cb of fns) cb({ event: correlationId, data: payload });
}
function flush(n = 3) {
	let p = Promise.resolve();
	for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
	return p;
}

/** In-test OfflineStore fake recording every operation. */
function fakeStore(seed = {}) {
	const map = new Map(Object.entries(seed));
	const ops = [];
	return {
		map,
		ops,
		async getAll(prefix) {
			const out = [];
			for (const [key, value] of map) if (key.startsWith(prefix)) out.push({ key, value });
			out.sort((a, b) => (a.key < b.key ? -1 : 1));
			return out;
		},
		async put(key, value) { ops.push(['put', key]); map.set(key, value); },
		async delete(key) { ops.push(['delete', key]); map.delete(key); },
		async clear(prefix) { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); }
	};
}

/** Persisted-entry seed row. */
function seedEntry(persistKey, seq, path, args, idempotencyKey) {
	return ['q:' + persistKey + ':' + String(seq).padStart(12, '0'), { seq, path, args, queuedAt: 1, idempotencyKey }];
}

let mod;

beforeEach(async () => {
	vi.resetModules();
	statusCallbacks = new Set();
	statusInitialValue = 'open';
	topicCallbacks = new Map();
	sendQueuedFn = vi.fn();

	// Like the adapter's, the connection object carries the module's topic
	// factory, stores and request hook.
	const adapterMock = {
		connect: vi.fn(() => ({
			sendQueued: sendQueuedFn,
			bufferedAmount: 0,
			on: adapterMock.on,
			status: adapterMock.status,
			failure: adapterMock.failure,
			denials: adapterMock.denials,
			onRequest: adapterMock.onRequest
		})),
		setTopicManaged: () => {},
		on: (topic) => ({
			subscribe: (fn) => {
				let fns = topicCallbacks.get(topic);
				if (!fns) { fns = new Set(); topicCallbacks.set(topic, fns); }
				fns.add(fn);
				return () => fns.delete(fn);
			}
		}),
		onDerived: () => ({ subscribe: () => () => {} }),
		status: {
			subscribe: (fn) => {
				statusCallbacks.add(fn);
				fn(statusInitialValue);
				return () => statusCallbacks.delete(fn);
			}
		},
		failure: { subscribe: (fn) => { fn(null); return () => {}; } },
		denials: { subscribe: (fn) => { fn(null); return () => {}; } },
		onRequest: () => () => {}
	};
	vi.doMock('svelte-adapter-uws/client', () => adapterMock);

	mod = await import('../src/client.js');
	mod._resetOffline();
});

/** Configure with an offline queue, go offline, enqueue N calls. */
async function goOfflineAndQueue(offline, calls) {
	mod.configure({ offline: { queue: true, ...offline } });
	simulateStatus('disconnected');
	const promises = calls.map(([path, args]) => {
		const fn = mod.__rpc(path);
		const p = fn(...args);
		p.catch(() => {}); // observed via asserts; never unhandled
		return p;
	});
	await flush(1);
	return promises;
}

/** Respond OK (or a rejection payload) to every outstanding sent envelope, in order. */
async function respondAll(payloadFor) {
	for (let round = 0; round < 20; round++) {
		const calls = sendQueuedFn.mock.calls;
		let progressed = false;
		for (let i = 0; i < calls.length; i++) {
			const env = calls[i][0];
			if (!env || env.__answered || env.id === undefined || env.type) continue;
			env.__answered = true;
			simulateRpcResponse(env.id, payloadFor(env, i));
			progressed = true;
		}
		await flush(1);
		if (!progressed) break;
	}
}

describe('offline queue - durability', () => {
	it('write-through on enqueue, delete on settle, synthesized idempotency key', async () => {
		const store = fakeStore();
		const [p1] = await goOfflineAndQueue({ persist: store }, [['todos/add', [{ title: 'x' }]]]);

		// Persisted at enqueue with a synthesized key.
		expect(store.map.size).toBe(1);
		const persisted = [...store.map.values()][0];
		expect(persisted.path).toBe('todos/add');
		expect(persisted.idempotencyKey).toMatch(/^off-/);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'done' }));

		await expect(p1).resolves.toBe('done');
		// The replayed envelope carried the synthesized key (server dedup).
		const replayed = sendQueuedFn.mock.calls.map((c) => c[0]).find((e) => e.rpc === 'todos/add');
		expect(replayed.idempotencyKey).toMatch(/^off-/);
		// Settle dropped the persisted copy and advanced the checkpoint.
		expect([...store.map.keys()].filter((k) => k.startsWith('q:'))).toEqual([]);
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(1);
	});

	it('a store that throws instead of rejecting does not fail a replay the server applied', async () => {
		const store = fakeStore();
		store.put = () => { throw new Error('storage broke'); };
		store.delete = () => { throw new Error('storage broke'); };
		const [p] = await goOfflineAndQueue({ persist: store }, [['todos/add', [{ t: 1 }]]]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'done' }));
		await expect(p).resolves.toBe('done');
	});

	it('rehydrates persisted entries on configure and replays them in seq order', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'first' }], 'off-a'),
			seedEntry('default', 2, 'todos/add', [{ t: 'second' }], 'off-b')
		]));
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);

		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(2);

		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));

		const replayed = sendQueuedFn.mock.calls.map((c) => c[0]).filter((e) => e.rpc === 'todos/add');
		expect(replayed.map((e) => e.args[0].t)).toEqual(['first', 'second']);
		expect(replayed.map((e) => e.idempotencyKey)).toEqual(['off-a', 'off-b']);
		expect(pendingSeen).toBe(0);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 2, gapDetected: false });
		expect([...store.map.keys()].filter((k) => k.startsWith('q:'))).toEqual([]);
	});

	it('persistKey scopes the restore (user A entries never replay as user B)', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('userA', 1, 'todos/add', [{ t: 'a' }], 'off-a')
		]));
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'userB' } });
		await flush(1);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(0);
		expect(store.map.size).toBe(1); // user A's entry is untouched
	});

	it('a fresh enqueue after rehydrate continues the seq past the restored max', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 7, 'todos/add', [{ t: 'old' }], 'off-old')
		]));
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		const fn = mod.__rpc('todos/add');
		fn({ t: 'new' }).catch(() => {});
		await flush(1);

		const keys = [...store.map.keys()].filter((k) => k.startsWith('q:')).sort();
		expect(keys).toEqual(['q:default:000000000007', 'q:default:000000000008']);
	});

	it('validates persist / conflictResolution / onConflict options', async () => {
		expect(() => mod.configure({ offline: { queue: true, persist: {} } })).toThrow(/persist/);
		expect(() => mod.configure({ offline: { queue: true, conflictResolution: 'nope' } })).toThrow(/conflictResolution/);
		expect(() => mod.configure({ offline: { queue: true, conflictResolution: 'custom' } })).toThrow(/onConflict/);
		expect(() => mod.configure({ offline: { queue: true, persistKey: '' } })).toThrow(/persistKey/);
	});
});

describe('offline queue - checkpoint and consumer stores', () => {
	it('gapDetected flips when a later mutation succeeds after an earlier failure, and clears on a clean drain', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'fails' }], 'off-1'),
			seedEntry('default', 2, 'todos/add', [{ t: 'succeeds' }], 'off-2')
		]));
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll((env) =>
			env.args[0].t === 'fails' ? { ok: false, code: 'INTERNAL', error: 'boom' } : { ok: true, data: 'ok' }
		);

		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 2, gapDetected: true });

		// A later fully-clean drain closes the hole.
		simulateStatus('disconnected');
		const fn = mod.__rpc('todos/add');
		const p = fn({ t: 'clean' });
		p.catch(() => {});
		await flush(1);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(mod.offlineCheckpoint().gapDetected).toBe(false);
	});

	it('uploading is true during a drain and false after; pendingMutations tracks the queue', async () => {
		const uploadingSeen = [];
		mod.uploading.subscribe((v) => uploadingSeen.push(v));
		const pendingSeen = [];
		mod.pendingMutations.subscribe((n) => pendingSeen.push(n));

		const [p] = await goOfflineAndQueue({}, [['todos/add', [{ t: 'x' }]]]);
		expect(pendingSeen[pendingSeen.length - 1]).toBe(1);

		simulateStatus('open');
		await flush();
		expect(uploadingSeen).toContain(true);
		await respondAll(() => ({ ok: true, data: 'ok' }));
		await p;
		expect(uploadingSeen[uploadingSeen.length - 1]).toBe(false);
		expect(pendingSeen[pendingSeen.length - 1]).toBe(0);
	});
});

describe('offline queue - conflict resolution', () => {
	async function conflictSetup(offline) {
		const [p] = await goOfflineAndQueue(offline, [['docs/save', [{ v: 'local' }]]]);
		simulateStatus('open');
		await flush();
		// Wrapped so callers' `await` does not flatten-and-wait on the RPC
		// promise itself (it only settles after the replay responses land).
		return { p };
	}

	it("server-win (default): drops the mutation, notifies onConflict, no retry", async () => {
		const conflicts = [];
		const { p } = await conflictSetup({ onConflict: (call, err) => conflicts.push([call.path, err.code]) });
		await respondAll(() => ({ ok: false, code: 'CONFLICT', error: 'moved' }));

		await expect(p).rejects.toMatchObject({ code: 'CONFLICT' });
		expect(conflicts).toEqual([['docs/save', 'CONFLICT']]);
		expect(sendQueuedFn.mock.calls.map((c) => c[0]).filter((e) => e.rpc === 'docs/save')).toHaveLength(1);
	});

	it('lww: re-issues the same call once; a second CONFLICT drops', async () => {
		const { p } = await conflictSetup({ conflictResolution: 'lww' });
		await respondAll(() => ({ ok: false, code: 'CONFLICT', error: 'moved' }));

		await expect(p).rejects.toMatchObject({ code: 'CONFLICT' });
		const attempts = sendQueuedFn.mock.calls.map((c) => c[0]).filter((e) => e.rpc === 'docs/save');
		expect(attempts).toHaveLength(2);
		expect(attempts[1].args).toEqual(attempts[0].args);
	});

	it('lww: the retry can succeed (local write wins by being applied last)', async () => {
		const { p } = await conflictSetup({ conflictResolution: 'lww' });
		let first = true;
		await respondAll(() => {
			if (first) { first = false; return { ok: false, code: 'CONFLICT', error: 'moved' }; }
			return { ok: true, data: 'applied' };
		});
		await expect(p).resolves.toBe('applied');
	});

	it('custom: an args array from onConflict re-issues once with merged args', async () => {
		const { p } = await conflictSetup({
			conflictResolution: 'custom',
			onConflict: () => [{ v: 'merged' }]
		});
		let first = true;
		await respondAll(() => {
			if (first) { first = false; return { ok: false, code: 'CONFLICT', error: 'moved' }; }
			return { ok: true, data: 'applied' };
		});
		await expect(p).resolves.toBe('applied');
		const attempts = sendQueuedFn.mock.calls.map((c) => c[0]).filter((e) => e.rpc === 'docs/save');
		expect(attempts[1].args).toEqual([{ v: 'merged' }]);
	});

	it('custom: a non-array from onConflict drops the mutation', async () => {
		const { p } = await conflictSetup({
			conflictResolution: 'custom',
			onConflict: () => undefined
		});
		await respondAll(() => ({ ok: false, code: 'CONFLICT', error: 'moved' }));
		await expect(p).rejects.toMatchObject({ code: 'CONFLICT' });
		expect(sendQueuedFn.mock.calls.map((c) => c[0]).filter((e) => e.rpc === 'docs/save')).toHaveLength(1);
	});

	it('a non-CONFLICT rejection takes the plain onReplayError path (no conflict machinery)', async () => {
		const errors = [];
		const conflicts = [];
		const [p] = await goOfflineAndQueue({
			conflictResolution: 'lww',
			onReplayError: (call, err) => errors.push(err.code),
			onConflict: () => conflicts.push(1)
		}, [['docs/save', [{ v: 'x' }]]]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: false, code: 'INTERNAL', error: 'boom' }));

		await expect(p).rejects.toMatchObject({ code: 'INTERNAL' });
		expect(errors).toEqual(['INTERNAL']);
		expect(conflicts).toEqual([]);
	});
});

describe('offline queue - connection closed for good', () => {
	const storedKeys = (store) => [...store.map.keys()].filter((k) => k.startsWith('q:')).sort();
	const replayedPaths = () => sendQueuedFn.mock.calls.map((c) => c[0]).filter((e) => e && e.rpc).map((e) => e.rpc);
	/** @param {Promise<any>} p */
	const watch = (p) => {
		const state = { settled: false };
		p.then(() => { state.settled = true; }, () => { state.settled = true; });
		return state;
	};

	it('stored mutations stay queued, their calls pending, for a later page load', async () => {
		const store = fakeStore();
		const onReplayError = vi.fn();
		const [p1, p2] = await goOfflineAndQueue({ persist: store, onReplayError }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		const w1 = watch(p1);
		const w2 = watch(p2);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(2);

		simulateStatus('failed');
		await flush();
		expect(w1.settled).toBe(false);
		expect(w2.settled).toBe(false);
		expect(pendingSeen).toBe(2);
		expect(storedKeys(store)).toHaveLength(2);
		expect(onReplayError).not.toHaveBeenCalled();
		expect(replayedPaths()).toEqual([]);
	});

	it('without persistence queued calls reject with CONNECTION_CLOSED', async () => {
		const [p1, p2] = await goOfflineAndQueue({}, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(2);

		simulateStatus('failed');
		await expect(p1).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await expect(p2).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await flush(1);
		expect(pendingSeen).toBe(0);
	});

	it('restored entries stay queued and stored', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'a' }], 'off-a'),
			seedEntry('default', 2, 'todos/add', [{ t: 'b' }], 'off-b')
		]));
		const onReplayError = vi.fn();
		mod.configure({ offline: { queue: true, persist: store, onReplayError } });
		await flush(1);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(2);

		simulateStatus('failed');
		await flush(1);
		expect(pendingSeen).toBe(2);
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
		expect(onReplayError).not.toHaveBeenCalled();
		expect(replayedPaths()).toEqual([]);
	});

	it('a close during the drain puts stored entries back in the queue', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'restored' }], 'off-r')
		]));
		const onReplayError = vi.fn();
		mod.configure({ offline: { queue: true, persist: store, onReplayError } });
		await flush(1);
		simulateStatus('disconnected');
		const live = mod.__rpc('todos/add')({ t: 'live' });
		const w = watch(live);
		await flush(1);
		expect(storedKeys(store)).toHaveLength(2);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });

		simulateStatus('open');
		await flush();
		// The restored entry is on the wire; the live one waits behind it.
		expect(replayedPaths()).toEqual(['todos/add']);

		simulateStatus('failed');
		await flush();
		expect(w.settled).toBe(false);
		expect(pendingSeen).toBe(2);
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
		expect(onReplayError).not.toHaveBeenCalled();
		expect(replayedPaths()).toEqual(['todos/add']);
	});

	it('without persistence a replay the close cuts off rejects with CONNECTION_CLOSED, also on the last-attempt drop', async () => {
		const onReplayError = vi.fn();
		const [p] = await goOfflineAndQueue({ onReplayError }, [['todos/add', [{ t: 'live' }]]]);
		simulateStatus('open');
		await flush();
		expect(replayedPaths()).toEqual(['todos/add']);

		// What the adapter reports when the drop exhausts its retries: the
		// in-flight replay is rejected with DISCONNECTED, then 'failed' follows.
		simulateStatus('disconnected');
		simulateStatus('failed');
		await expect(p).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(onReplayError).not.toHaveBeenCalled();
	});

	it('the drop that uses up the last reconnect keeps a restored entry it cut off', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'restored' }], 'off-r')
		]));
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		expect(replayedPaths()).toEqual(['todos/add']);

		simulateStatus('disconnected');
		simulateStatus('failed');
		await flush();
		expect(storedKeys(store)).toEqual(['q:default:000000000001']);
	});

	it('a replay the server rejects stays a failure when the close lands in the same tick', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'restored' }], 'off-r')
		]));
		const onReplayError = vi.fn();
		mod.configure({ offline: { queue: true, persist: store, onReplayError } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		const sent = sendQueuedFn.mock.calls.map((c) => c[0]).find((e) => e.rpc === 'todos/add');

		simulateRpcResponse(sent.id, { ok: false, code: 'VALIDATION', error: 'bad' });
		simulateStatus('failed');
		await flush();
		expect(storedKeys(store)).toEqual([]);
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(onReplayError.mock.calls[0][1].code).toBe('VALIDATION');
	});

	it('entries restored after the close count as pending and stay stored', async () => {
		/** @type {(v?: any) => void} */
		let release = () => {};
		const gate = new Promise((r) => { release = r; });
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'a' }], 'off-a')
		]));
		const getAll = store.getAll;
		store.getAll = async (prefix) => { await gate; return getAll(prefix); };
		mod.configure({ offline: { queue: true, persist: store } });
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });

		simulateStatus('failed');
		release();
		await flush();
		expect(pendingSeen).toBe(1);
		expect(storedKeys(store)).toEqual(['q:default:000000000001']);
		expect(replayedPaths()).toEqual([]);
	});

	it('a drain cut short by the close keeps its stored entry queued and the gap open', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'restored' }], 'off-r'),
			['c:default', { lastUploadedSeq: 0, gapDetected: true }]
		]));
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);

		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		expect(replayedPaths()).toEqual(['todos/add']);

		simulateStatus('failed');
		await flush();
		expect(storedKeys(store)).toEqual(['q:default:000000000001']);
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);
	});

	it('without persistence a drain cut short by the close does not count as clean', async () => {
		// A first drain leaves a gap: the earlier mutation fails, the later one applies.
		const [p1, p2] = await goOfflineAndQueue({}, [
			['todos/add', [{ t: 'fails' }]],
			['todos/add', [{ t: 'succeeds' }]]
		]);
		simulateStatus('open');
		await flush();
		await respondAll((env) =>
			env.args[0].t === 'fails' ? { ok: false, code: 'INTERNAL', error: 'boom' } : { ok: true, data: 'ok' }
		);
		await expect(p1).rejects.toMatchObject({ code: 'INTERNAL' });
		await expect(p2).resolves.toBe('ok');
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);

		simulateStatus('disconnected');
		const p3 = mod.__rpc('todos/add')({ t: 'cut' });
		p3.catch(() => {});
		await flush(1);
		simulateStatus('open');
		await flush();
		expect(replayedPaths()).toHaveLength(3);

		simulateStatus('failed');
		await expect(p3).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await flush();
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);
	});

	it('persist: true without IndexedDB keeps nothing past the page, so queued calls reject', async () => {
		const [p] = await goOfflineAndQueue({ persist: true }, [['todos/add', [{ t: 1 }]]]);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		await flush(1);

		simulateStatus('failed');
		await expect(p).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(pendingSeen).toBe(0);
	});

	it('a replay the close cuts off rejects when its store keeps nothing past the page', async () => {
		const [p] = await goOfflineAndQueue({ persist: mod.createMemoryStore() }, [['todos/add', [{ t: 1 }]]]);
		simulateStatus('open');
		await flush();
		expect(replayedPaths()).toEqual(['todos/add']);

		simulateStatus('failed');
		await expect(p).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
	});

	it('entries restored from a store that keeps nothing past the page leave the queue at the close', async () => {
		const store = mod.createMemoryStore();
		const [key, value] = seedEntry('default', 1, 'todos/add', [{ t: 'a' }], 'off-a');
		await store.put(key, value);
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(1);

		simulateStatus('failed');
		await flush();
		expect(pendingSeen).toBe(0);
		expect(replayedPaths()).toEqual([]);
	});

	it('a mutation whose write failed rejects, one that was stored stays queued', async () => {
		const store = fakeStore();
		const put = store.put;
		store.put = async (key, value) => {
			if (value.args?.[0]?.t === 'lost') throw new Error('quota exceeded');
			return put(key, value);
		};
		const [kept, lost] = await goOfflineAndQueue({ persist: store }, [
			['todos/add', [{ t: 'kept' }]],
			['todos/add', [{ t: 'lost' }]]
		]);
		const w = watch(kept);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });

		simulateStatus('failed');
		await expect(lost).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await flush();
		expect(w.settled).toBe(false);
		expect(pendingSeen).toBe(1);
		expect(storedKeys(store)).toEqual(['q:default:000000000001']);
	});

	it('a write still running at the close decides when it ends', async () => {
		const store = fakeStore();
		const put = store.put;
		/** @type {Array<{ ok: () => void, fail: () => void }>} */
		const writes = [];
		store.put = (key, value) => new Promise((resolve, reject) => {
			writes.push({ ok: () => resolve(put(key, value)), fail: () => reject(new Error('quota exceeded')) });
		});
		const [p1, p2] = await goOfflineAndQueue({ persist: store }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		const w1 = watch(p1);
		const w2 = watch(p2);

		simulateStatus('failed');
		await flush();
		expect(w1.settled).toBe(false);
		expect(w2.settled).toBe(false);

		writes[0].ok();
		writes[1].fail();
		await expect(p2).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await flush();
		expect(w1.settled).toBe(false);
		expect(storedKeys(store)).toEqual(['q:default:000000000001']);
	});

	describe('with IndexedDB', () => {
		/** @type {any} */
		let warn;
		beforeEach(() => {
			warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			vi.stubGlobal('IDBKeyRange', { bound: () => null });
		});
		afterEach(() => {
			warn.mockRestore();
			vi.unstubAllGlobals();
		});

		/**
		 * A minimal IndexedDB: `open` fails, or creates the object store on the
		 * first open and opens a database whose writes commit or abort. An
		 * aborted write still reports its request as a success first, the way a
		 * full quota ends a transaction.
		 */
		function fakeIndexedDb({ openFails = false, abortWrites = false } = {}) {
			const map = new Map();
			const stores = new Set();
			const later = (fn) => setTimeout(fn, 0);
			const db = {
				objectStoreNames: { contains: (name) => stores.has(name) },
				createObjectStore: (name) => { stores.add(name); },
				transaction() {
					/** @type {any} */
					const tx = { error: null };
					tx.objectStore = () => ({
						put(value, key) {
							/** @type {any} */
							const req = {};
							later(() => {
								req.result = key;
								req.onsuccess?.();
								later(() => {
									if (abortWrites) {
										tx.error = new Error('QuotaExceededError');
										tx.onabort?.();
									} else {
										map.set(key, value);
										tx.oncomplete?.();
									}
								});
							});
							return req;
						},
						delete(key) {
							/** @type {any} */
							const req = {};
							later(() => { map.delete(key); req.onsuccess?.(); });
							return req;
						},
						openCursor() {
							/** @type {any} */
							const req = { result: null };
							later(() => req.onsuccess?.());
							return req;
						}
					});
					return tx;
				}
			};
			return {
				map,
				open() {
					/** @type {any} */
					const req = { error: null };
					later(() => {
						if (openFails) {
							req.error = new Error('denied');
							req.onerror?.();
							return;
						}
						req.result = db;
						if (stores.size === 0) req.onupgradeneeded?.();
						req.onsuccess?.();
					});
					return req;
				}
			};
		}

		/** @param {{ openFails?: boolean, abortWrites?: boolean }} options */
		async function queueOneAndClose(options) {
			const idb = fakeIndexedDb(options);
			vi.stubGlobal('indexedDB', idb);
			const [p] = await goOfflineAndQueue({ persist: true }, [['todos/add', [{ t: 1 }]]]);
			const w = watch(p);
			await flush();
			simulateStatus('failed');
			await flush();
			return { p, w, idb };
		}

		it('a committed write keeps the call queued', async () => {
			const { w, idb } = await queueOneAndClose({});
			await flush();
			expect(w.settled).toBe(false);
			expect([...idb.map.keys()]).toEqual(['q:default:000000000001']);
		});

		it('a database that cannot open stores nothing, so the call rejects', async () => {
			const { p } = await queueOneAndClose({ openFails: true });
			await expect(p).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		});

		it('an aborted write stores nothing, so the call rejects', async () => {
			const { p, idb } = await queueOneAndClose({ abortWrites: true });
			await expect(p).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
			expect(idb.map.size).toBe(0);
		});
	});
});
