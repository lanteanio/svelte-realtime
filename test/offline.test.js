// The durable offline queue: persistence write-through (via an injected
// OfflineStore fake - the house "mock the module boundary, run in node"
// pattern, no jsdom/fake-indexeddb), rehydrate-on-configure, the synthesized
// idempotency key, the upload checkpoint (advance + gap detection + clean
// clear), the pendingMutations/uploading consumer stores, the
// conflict-resolution stance (server-win / lww / custom) for replayed
// mutations rejected with CONFLICT, what a connection closed for good leaves
// queued, and what a queued call stores (a hand-rolled IndexedDB stands in
// for the default store, and a compiled `$state` for component state).
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { compileModule } from 'svelte/compiler';

let statusCallbacks;
let statusInitialValue;
let topicCallbacks;
/** Every frame that reached the socket, in order. */
let wire;
/** Frames `sendQueued` held while the socket was not open, like the adapter's send queue. */
let adapterQueue;
let socketOpen;
let sendQueuedFn;
let sendFn;

function simulateStatus(s) {
	// Like the adapter's status store, a later subscriber gets the last value.
	statusInitialValue = s;
	socketOpen = s === 'open' || s === 'suspended';
	for (const cb of [...statusCallbacks]) cb(s);
	// Like the adapter, the send queue is flushed once the open status is out.
	if (socketOpen) wire.push(...adapterQueue.splice(0));
}
/** The socket is closing: frames no longer reach it, and the status says so only once the close lands. */
function simulateClosing() {
	socketOpen = false;
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
	mod = await loadClient();
});

/**
 * A fresh client module graph over a fresh adapter mock: what a page load
 * gets. Calling it again inside a test is a reload.
 */
async function loadClient() {
	vi.resetModules();
	statusCallbacks = new Set();
	statusInitialValue = 'open';
	topicCallbacks = new Map();
	wire = [];
	adapterQueue = [];
	socketOpen = true;
	sendQueuedFn = vi.fn((frame) => { if (socketOpen) wire.push(frame); else adapterQueue.push(frame); });
	sendFn = vi.fn((frame) => { if (socketOpen) wire.push(frame); });

	// Like the adapter's, the connection object carries the module's topic
	// factory, stores and request hook.
	const adapterMock = {
		connect: vi.fn(() => ({
			send: sendFn,
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

	const client = await import('../src/client.js');
	client._resetOffline();
	return client;
}

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
		let progressed = false;
		for (let i = 0; i < wire.length; i++) {
			const env = wire[i];
			if (!env || env.__answered || env.id === undefined || env.type) continue;
			env.__answered = true;
			simulateRpcResponse(env.id, payloadFor(env, i));
			progressed = true;
		}
		await flush(1);
		if (!progressed) break;
	}
}

const storedKeys = (store) => [...store.map.keys()].filter((k) => k.startsWith('q:')).sort();
const replayedPaths = () => wire.filter((e) => e && e.rpc).map((e) => e.rpc);
/** Every RPC envelope sent so far, in send order. */
const sentCalls = () => wire.filter((e) => e && e.rpc);
/** @param {Promise<any>} p */
const watch = (p) => {
	/** @type {{ settled: boolean, value?: any, error?: any }} */
	const state = { settled: false };
	p.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
	return state;
};

/**
 * A minimal IndexedDB: `open` fails, or creates the object store on the
 * first open and opens a database whose writes commit or abort. Values are
 * cloned in and out the way IndexedDB clones them, so `put` throws for a
 * value it cannot clone. An aborted write still reports its request as a
 * success first, the way a full quota ends a transaction. The rows outlive
 * the client that wrote them, so a test can reload against them.
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
					const copy = structuredClone(value);
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
								map.set(key, copy);
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
				openCursor(range) {
					const keys = [...map.keys()].filter((k) => k >= range.lower && k <= range.upper).sort();
					/** @type {any} */
					const req = { result: null };
					let i = 0;
					const step = () => later(() => {
						const key = keys[i++];
						req.result = key === undefined ? null : { key, value: structuredClone(map.get(key)), continue: step };
						req.onsuccess?.();
					});
					step();
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

const runeProbeRoot = resolve(import.meta.dirname, '__offline_rune__');
afterAll(() => rmSync(runeProbeRoot, { recursive: true, force: true }));

/**
 * `$state(value)` compiled from a `.svelte.js` module: the deep proxy a
 * component's form state is.
 * @param {any} value
 */
async function stateOf(value) {
	mkdirSync(runeProbeRoot, { recursive: true });
	const dir = mkdtempSync(resolve(runeProbeRoot, 'probe-'));
	const { js } = compileModule('export function make(v) {\n\tconst s = $state(v);\n\treturn s;\n}\n', { filename: 'probe.svelte.js', generate: 'client' });
	const out = resolve(dir, 'probe.js');
	writeFileSync(out, js.code);
	const { make } = await import(pathToFileURL(out).href);
	return make(value);
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
		const replayed = wire.find((e) => e.rpc === 'todos/add');
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

		const replayed = wire.filter((e) => e.rpc === 'todos/add');
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

describe('offline queue - a call queued while the restore runs', () => {
	/** A store seeded with one restored row whose scan waits for `release()`. */
	function gatedStore({ fail = false } = {}) {
		/** @type {(v?: any) => void} */
		let release = () => {};
		const gate = new Promise((r) => { release = r; });
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'restored' }], 'off-restored')
		]));
		const getAll = store.getAll;
		store.getAll = async (prefix) => {
			await gate;
			if (fail) throw new Error('scan failed');
			return getAll(prefix);
		};
		return { store, release: () => release() };
	}

	it('takes a seq past the stored rows, and each settle deletes only its own copy', async () => {
		const { store, release } = gatedStore();
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('todos/add')({ t: 'fresh' }));
		await flush(1);
		expect(storedKeys(store)).toEqual(['q:default:000000000001']);
		expect(store.map.get('q:default:000000000001').args).toEqual([{ t: 'restored' }]);

		release();
		await flush();
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
		expect(store.map.get('q:default:000000000002').args).toEqual([{ t: 'fresh' }]);
		const freshKey = store.map.get('q:default:000000000002').idempotencyKey;
		expect(freshKey).not.toBe('off-restored');

		simulateStatus('open');
		await flush();
		const [first] = sentCalls();
		expect(first.args).toEqual([{ t: 'restored' }]);
		simulateRpcResponse(first.id, { ok: true, data: 'ok' });
		await flush();
		expect(storedKeys(store)).toEqual(['q:default:000000000002']);
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(fresh.value).toBe('ok');
		const [restored, queued] = sentCalls();
		expect(restored.idempotencyKey).toBe('off-restored');
		expect(queued.args).toEqual([{ t: 'fresh' }]);
		expect(queued.idempotencyKey).toBe(freshKey);
		expect(storedKeys(store)).toEqual([]);
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(2);
	});

	it('a call the full queue drops before the restore ends is never written', async () => {
		const { store, release } = gatedStore();
		mod.configure({ offline: { queue: true, maxQueue: 1, persist: store } });
		simulateStatus('disconnected');
		const dropped = watch(mod.__rpc('todos/add')({ t: 'dropped' }));
		const kept = watch(mod.__rpc('todos/add')({ t: 'kept' }));
		await flush(1);
		expect(dropped.error).toMatchObject({ code: 'QUEUE_FULL' });

		release();
		await flush();
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
		expect(store.map.get('q:default:000000000001').args).toEqual([{ t: 'restored' }]);
		expect(store.map.get('q:default:000000000002').args).toEqual([{ t: 'kept' }]);
		expect(kept.settled).toBe(false);
	});

	it('a close during the restore keeps the call once its own copy is written', async () => {
		const { store, release } = gatedStore();
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('todos/add')({ t: 'fresh' }));
		await flush(1);
		simulateStatus('failed');
		await flush();
		expect(fresh.settled).toBe(false);

		release();
		await flush();
		expect(fresh.settled).toBe(false);
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(2);
	});

	it('a restore that fails still writes the call queued while it ran', async () => {
		const { store, release } = gatedStore({ fail: true });
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('todos/add')({ t: 'fresh' }));
		await flush(1);
		release();
		await flush();
		expect(store.ops.filter(([op]) => op === 'put')).toHaveLength(1);

		simulateStatus('failed');
		await flush();
		expect(fresh.settled).toBe(false);
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
		expect(wire.filter((e) => e.rpc === 'docs/save')).toHaveLength(1);
	});

	it('lww: re-issues the same call once; a second CONFLICT drops', async () => {
		const { p } = await conflictSetup({ conflictResolution: 'lww' });
		await respondAll(() => ({ ok: false, code: 'CONFLICT', error: 'moved' }));

		await expect(p).rejects.toMatchObject({ code: 'CONFLICT' });
		const attempts = wire.filter((e) => e.rpc === 'docs/save');
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
		const attempts = wire.filter((e) => e.rpc === 'docs/save');
		expect(attempts[1].args).toEqual([{ v: 'merged' }]);
	});

	it('custom: a non-array from onConflict drops the mutation', async () => {
		const { p } = await conflictSetup({
			conflictResolution: 'custom',
			onConflict: () => undefined
		});
		await respondAll(() => ({ ok: false, code: 'CONFLICT', error: 'moved' }));
		await expect(p).rejects.toMatchObject({ code: 'CONFLICT' });
		expect(wire.filter((e) => e.rpc === 'docs/save')).toHaveLength(1);
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

describe('offline queue - a drop during the drain', () => {
	const queuedPuts = (store) => store.ops.filter(([op, key]) => op === 'put' && key.startsWith('q:')).length;

	it('a replay cut off by a drop keeps its stored copy and replays on the next reconnect', async () => {
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
		let uploadingNow;
		mod.uploading.subscribe((v) => { uploadingNow = v; });
		expect(queuedPuts(store)).toBe(2);

		simulateStatus('open');
		await flush();
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([1]);

		simulateStatus('disconnected');
		await flush();
		expect(w1.settled).toBe(false);
		expect(w2.settled).toBe(false);
		expect(onReplayError).not.toHaveBeenCalled();
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
		expect(queuedPuts(store)).toBe(2);
		expect(pendingSeen).toBe(2);
		expect(uploadingNow).toBe(false);
		expect(sentCalls()).toHaveLength(1);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w1.value).toBe('ok');
		expect(w2.value).toBe('ok');
		const [cut, again, second] = sentCalls();
		expect([cut, again, second].map((e) => e.args[0].t)).toEqual([1, 1, 2]);
		expect(again.idempotencyKey).toBe(cut.idempotencyKey);
		expect(second.idempotencyKey).not.toBe(cut.idempotencyKey);
		expect(storedKeys(store)).toEqual([]);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 2, gapDetected: false });
		expect(pendingSeen).toBe(0);
		expect(onReplayError).not.toHaveBeenCalled();
	});

	it('without persistence a cut-off replay stays queued and the next reconnect drains it', async () => {
		const onReplayError = vi.fn();
		const [p1, p2] = await goOfflineAndQueue({ onReplayError }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		const w1 = watch(p1);
		const w2 = watch(p2);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		let uploadingNow;
		mod.uploading.subscribe((v) => { uploadingNow = v; });

		simulateStatus('open');
		await flush();
		simulateStatus('disconnected');
		await flush();
		expect(w1.settled).toBe(false);
		expect(w2.settled).toBe(false);
		expect(pendingSeen).toBe(2);
		expect(uploadingNow).toBe(false);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w1.value).toBe('ok');
		expect(w2.value).toBe('ok');
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 1, 2]);
		expect(pendingSeen).toBe(0);
		expect(uploadingNow).toBe(false);
		expect(onReplayError).not.toHaveBeenCalled();
	});

	it('concurrent replay: a drop puts back only the calls it cut off, in order', async () => {
		const store = fakeStore();
		const [p1, p2, p3] = await goOfflineAndQueue({ persist: store, replay: 'concurrent' }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]],
			['todos/add', [{ t: 3 }]]
		]);
		const w1 = watch(p1);
		const w3 = watch(p3);
		simulateStatus('open');
		await flush();
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 2, 3]);
		simulateRpcResponse(sentCalls()[1].id, { ok: true, data: 'two' });
		await flush();
		await expect(p2).resolves.toBe('two');

		simulateStatus('disconnected');
		await flush();
		expect(w1.settled).toBe(false);
		expect(w3.settled).toBe(false);
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000003']);
		expect(queuedPuts(store)).toBe(3);

		simulateStatus('open');
		await flush();
		expect(sentCalls().slice(3).map((e) => e.args[0].t)).toEqual([1, 3]);
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w1.value).toBe('ok');
		expect(w3.value).toBe('ok');
		expect(storedKeys(store)).toEqual([]);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 3, gapDetected: false });
	});

	it('a drop while the restore is read sends nothing until the next reconnect', async () => {
		/** @type {(v?: any) => void} */
		let release = () => {};
		const gate = new Promise((r) => { release = r; });
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'a' }], 'off-a'),
			seedEntry('default', 2, 'todos/add', [{ t: 'b' }], 'off-b')
		]));
		const getAll = store.getAll;
		store.getAll = async (prefix) => { await gate; return getAll(prefix); };
		mod.configure({ offline: { queue: true, persist: store } });
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		const uploadingSeen = [];
		mod.uploading.subscribe((v) => uploadingSeen.push(v));

		simulateStatus('disconnected');
		simulateStatus('open');
		await flush(1);
		simulateStatus('disconnected');
		release();
		await flush();
		expect(sentCalls()).toEqual([]);
		expect(pendingSeen).toBe(2);
		expect(queuedPuts(store)).toBe(0);
		expect(uploadingSeen).toEqual([false]);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.idempotencyKey)).toEqual(['off-a', 'off-b']);
		expect(storedKeys(store)).toEqual([]);
		expect(pendingSeen).toBe(0);
	});

	it('a reconnect that lands before the drain sees the drop drains again', async () => {
		const [p] = await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]]]);
		const w = watch(p);
		const uploadingSeen = [];
		mod.uploading.subscribe((v) => uploadingSeen.push(v));
		simulateStatus('open');
		await flush();
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		expect(sentCalls()).toHaveLength(2);
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w.value).toBe('ok');
		expect(uploadingSeen).toEqual([false, true, false]);
	});

	it('a replay sent while the socket closes goes out once, after the reconnect', async () => {
		const store = fakeStore();
		const [p1, p2] = await goOfflineAndQueue({ persist: store }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		simulateClosing();
		simulateRpcResponse(sentCalls()[0].id, { ok: true, data: 'one' });
		await flush();
		await expect(p1).resolves.toBe('one');

		simulateStatus('disconnected');
		await flush();
		expect(w2.settled).toBe(false);
		simulateStatus('open');
		await flush();
		expect(sentCalls().filter((e) => e.args[0].t === 2)).toHaveLength(1);
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w2.value).toBe('ok');
		expect(storedKeys(store)).toEqual([]);
	});

	it('a cut puts calls back in the order they were queued, as they were queued', async () => {
		// Newest first, and each replay marks the copy it sends.
		const replay = (queue) => [...queue].reverse().map((e) => ({ ...e, args: [{ ...e.args[0], hops: (e.args[0].hops ?? 0) + 1 }] }));
		const promises = await goOfflineAndQueue({ replay }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]],
			['todos/add', [{ t: 3 }]]
		]);
		const watched = promises.map(watch);
		simulateStatus('open');
		await flush();
		simulateStatus('disconnected');
		await flush();
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => [e.args[0].t, e.args[0].hops])).toEqual([[3, 1], [3, 1], [2, 1], [1, 1]]);
		expect(watched.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
	});

	it('a cut puts back every restored entry, also ones stored without a seq', async () => {
		const store = fakeStore({
			'q:default:000000000001': { path: 'todos/add', args: [{ t: 'a' }], queuedAt: 1, idempotencyKey: 'off-a' },
			'q:default:000000000002': { path: 'todos/add', args: [{ t: 'b' }], queuedAt: 1, idempotencyKey: 'off-b' }
		});
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		simulateStatus('disconnected');
		await flush();
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.idempotencyKey)).toEqual(['off-a', 'off-a', 'off-b']);
	});

	it('a maxQueue below one keeps only the newest call', async () => {
		const [first, second] = await goOfflineAndQueue({ maxQueue: -1 }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		await expect(first).rejects.toMatchObject({ code: 'QUEUE_FULL' });
		const w = watch(second);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w.value).toBe('ok');
	});

	it('calls put back past maxQueue drop the oldest', async () => {
		const store = fakeStore();
		const save = mod.__rpc('todos/add');
		let draftsOnDrop = false;
		mod.configure({
			offline: { queue: true, maxQueue: 2, persist: store },
			onDisconnect: () => {
				if (!draftsOnDrop) return;
				save({ t: 'd1' }).catch(() => {});
				save({ t: 'd2' }).catch(() => {});
			}
		});
		simulateStatus('disconnected');
		const w1 = watch(save({ t: 1 }));
		const w2 = watch(save({ t: 2 }));
		await flush(1);
		simulateStatus('open');
		await flush();

		draftsOnDrop = true;
		simulateStatus('disconnected');
		await flush();
		expect(w1.error).toMatchObject({ code: 'QUEUE_FULL' });
		expect(w2.error).toMatchObject({ code: 'QUEUE_FULL' });
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(2);
		expect(storedKeys(store)).toEqual(['q:default:000000000003', 'q:default:000000000004']);
	});

	it('a replay cut off by a device sleep is sent again at once', async () => {
		const rt = await import('../src/client-runtime.js');
		let clock = 1_000_000;
		/** @type {Array<{ cb: () => void, cleared: boolean }>} */
		const timers = [];
		rt.setRuntimeEnv({
			clock: { now: () => clock },
			timers: {
				set: (cb) => { const t = { cb, cleared: false }; timers.push(t); return t; },
				clear: (t) => { if (t) t.cleared = true; }
			}
		});
		try {
			const store = fakeStore();
			const onReplayError = vi.fn();
			const [p1, p2] = await goOfflineAndQueue({ persist: store, onReplayError }, [
				['todos/add', [{ t: 1 }]],
				['todos/add', [{ t: 2 }]]
			]);
			const w1 = watch(p1);
			const w2 = watch(p2);
			const armedBefore = timers.length;
			simulateStatus('open');
			await flush();
			expect(sentCalls()).toHaveLength(1);

			// The device slept through the replay; the socket has not reported a drop.
			clock += 100_000;
			for (const t of timers.slice(armedBefore).filter((t) => !t.cleared)) t.cb();
			await flush();
			expect(onReplayError).not.toHaveBeenCalled();
			expect(w1.settled).toBe(false);
			expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
			const [cut, again] = sentCalls();
			expect(again.idempotencyKey).toBe(cut.idempotencyKey);

			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(w1.value).toBe('ok');
			expect(w2.value).toBe('ok');
			expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 1, 2]);
			expect(storedKeys(store)).toEqual([]);
		} finally {
			rt.resetRuntimeEnv();
		}
	});

	it('a call made while the drop is reported queues behind the cut-off replays', async () => {
		const store = fakeStore();
		const save = mod.__rpc('todos/add');
		let saveOnDrop = false;
		/** @type {Promise<any> | undefined} */
		let draft;
		mod.configure({
			offline: { queue: true, persist: store },
			onDisconnect: () => {
				if (!saveOnDrop) return;
				draft = save({ t: 'draft' });
				draft.catch(() => {});
			}
		});
		simulateStatus('disconnected');
		const p1 = save({ t: 1 });
		const p2 = save({ t: 2 });
		p1.catch(() => {});
		p2.catch(() => {});
		await flush(1);
		simulateStatus('open');
		await flush();

		saveOnDrop = true;
		simulateStatus('disconnected');
		await flush();
		expect(draft).toBeDefined();
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002', 'q:default:000000000003']);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		await expect(draft).resolves.toBe('ok');
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 1, 2, 'draft']);
	});

	it("a drop reported during the drain's own callbacks stops it before the next send", async () => {
		const store = fakeStore();
		const [p1, p2] = await goOfflineAndQueue({
			persist: store,
			onReplayError: () => simulateStatus('disconnected')
		}, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[0].id, { ok: false, code: 'VALIDATION', error: 'bad' });
		await flush();
		await expect(p1).rejects.toMatchObject({ code: 'VALIDATION' });
		expect(w2.settled).toBe(false);
		expect(sentCalls()).toHaveLength(1);
		expect(storedKeys(store)).toEqual(['q:default:000000000002']);
		expect(queuedPuts(store)).toBe(2);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w2.value).toBe('ok');
	});

	it('an onReplayError that throws does not stop the drain', async () => {
		const store = fakeStore();
		const [p1, p2] = await goOfflineAndQueue({
			persist: store,
			onReplayError: () => { throw new Error('app bug'); }
		}, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		const w1 = watch(p1);
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		await respondAll((env) => (env.args[0].t === 1 ? { ok: false, code: 'VALIDATION', error: 'bad' } : { ok: true, data: 'ok' }));
		expect(w1.error).toMatchObject({ code: 'VALIDATION' });
		expect(w2.value).toBe('ok');
		expect(storedKeys(store)).toEqual([]);
	});

	it('a beforeReplay that throws keeps the call', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const [p] = await goOfflineAndQueue({ beforeReplay: () => { throw new Error('app bug'); } }, [['todos/add', [{ t: 1 }]]]);
			const w = watch(p);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(w.value).toBe('ok');
			expect(warn.mock.calls.some(([m]) => String(m).includes('beforeReplay threw'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('a server answer with the code DISCONNECTED is a replay failure', async () => {
		const store = fakeStore();
		const onReplayError = vi.fn();
		const [p] = await goOfflineAndQueue({ persist: store, onReplayError }, [['todos/add', [{ t: 1 }]]]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: false, code: 'DISCONNECTED', error: 'thrown by the handler' }));
		await expect(p).rejects.toMatchObject({ code: 'DISCONNECTED' });
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(storedKeys(store)).toEqual([]);
		expect(sentCalls()).toHaveLength(1);
	});
});

describe('offline queue - what a queued call stores', () => {
	const queuedRows = (idb) => [...idb.map.entries()].filter(([k]) => k.startsWith('q:'));
	/** @type {any} */
	let warn;
	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
	});
	afterEach(() => {
		warn.mockRestore();
		vi.unstubAllGlobals();
	});

	it('a call queued with $state args is stored in IndexedDB and replays the same values after a reload', async () => {
		const idb = fakeIndexedDb();
		vi.stubGlobal('indexedDB', idb);
		const form = await stateOf({ title: 'draft', tags: ['a'] });
		mod.configure({ offline: { queue: true, persist: true } });
		simulateStatus('disconnected');
		const p = mod.__rpc('todos/save')(form);
		const w = watch(p);
		// The write waits for the restore's scan, then commits.
		await flush(8);
		const rows = queuedRows(idb);
		expect(rows).toHaveLength(1);
		expect(rows[0][1].args).toEqual([{ title: 'draft', tags: ['a'] }]);
		expect(warn).not.toHaveBeenCalled();
		simulateStatus('failed');
		await flush();
		expect(w.settled).toBe(false);

		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: true } });
		await flush();
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		const [sent] = sentCalls();
		expect(sent.rpc).toBe('todos/save');
		expect(sent.args).toEqual([{ title: 'draft', tags: ['a'] }]);
		expect(sent.idempotencyKey).toBe(rows[0][1].idempotencyKey);
		await flush();
		expect(queuedRows(idb)).toEqual([]);
	});

	it('a queued call sends the args it was made with', async () => {
		const form = await stateOf({ title: 'draft' });
		const beforeReplay = vi.fn(() => true);
		mod.configure({ offline: { queue: true, beforeReplay } });
		simulateStatus('disconnected');
		const w = watch(mod.__rpc('todos/save')(form));
		await flush(1);
		form.title = 'edited later';

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w.value).toBe('ok');
		expect(sentCalls()[0].args).toEqual([{ title: 'draft' }]);
		expect(beforeReplay.mock.calls[0][0].args).toEqual([{ title: 'draft' }]);
	});

	it('args that cannot be serialized fail the call at once and queue nothing', async () => {
		const store = fakeStore();
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		const cyclic = { title: 'x' };
		cyclic.self = cyclic;
		const big = watch(mod.__rpc('todos/save').fresh({ count: 1n }));
		const loop = watch(mod.__rpc('todos/save').fresh(cyclic));
		await flush(1);
		expect(big.error).toBeInstanceOf(TypeError);
		expect(loop.error).toBeInstanceOf(TypeError);
		expect(pendingSeen).toBe(0);
		expect(store.ops).toEqual([]);
	});
});

describe('offline queue - connection closed for good', () => {
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

	it.each(['VALIDATION', 'CONNECTION_CLOSED', 'DISCONNECTED'])('a replay the server rejects with %s stays a failure when the close lands in the same tick', async (code) => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'restored' }], 'off-r')
		]));
		const onReplayError = vi.fn();
		mod.configure({ offline: { queue: true, persist: store, onReplayError } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		const sent = wire.find((e) => e.rpc === 'todos/add');

		simulateRpcResponse(sent.id, { ok: false, code, error: 'bad' });
		simulateStatus('failed');
		await flush();
		expect(storedKeys(store)).toEqual([]);
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(onReplayError.mock.calls[0][1].code).toBe(code);
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
			vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
		});
		afterEach(() => {
			warn.mockRestore();
			vi.unstubAllGlobals();
		});

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
