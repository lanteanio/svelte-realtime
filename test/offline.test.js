// The durable offline queue: persistence write-through (via an injected
// OfflineStore fake - the house "mock the module boundary, run in node"
// pattern, no jsdom/fake-indexeddb), rehydrate-on-configure, the synthesized
// idempotency key, the upload checkpoint (advance + gap detection + clean
// clear), the pendingMutations/uploading consumer stores, and the
// conflict-resolution stance (server-win / lww / custom) for replayed
// mutations rejected with CONFLICT.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let statusCallbacks;
let statusInitialValue;
let topicCallbacks;
let sendQueuedFn;

function simulateStatus(s) {
	for (const cb of statusCallbacks) cb(s);
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

	vi.doMock('svelte-adapter-uws/client', () => ({
		connect: vi.fn(() => ({
			sendQueued: sendQueuedFn,
			ready: () => new Promise(() => {}),
			bufferedAmount: 0
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
	}));

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
