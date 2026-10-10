// The durable offline queue: persistence write-through (via an injected
// OfflineStore fake - the house "mock the module boundary, run in node"
// pattern, no jsdom/fake-indexeddb), rehydrate-on-configure, the synthesized
// idempotency key, the upload checkpoint (advance + gap detection + clean
// clear), the pendingMutations/uploading consumer stores, the
// conflict-resolution stance (server-win / lww / custom) for replayed
// mutations rejected with CONFLICT, what a connection closed for good leaves
// queued, and what a queued call stores (a hand-rolled IndexedDB stands in
// for the default store, and a compiled `$state` for component state).
import { describe, it, expect, vi, beforeEach, afterEach, afterAll, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { compileModule } from 'svelte/compiler';
import { writable } from 'svelte/store';

let realStatusStore;

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
	if (realStatusStore) realStatusStore.set(s);
	else for (const cb of [...statusCallbacks]) cb(s);
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
/** Turn the event loop until `cond()` holds (or give up after `rounds` turns). */
async function until(cond, rounds = 50) {
	for (let i = 0; i < rounds && !cond(); i++) await flush(1);
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
	return ['q:' + persistKey + ':' + String(seq).padStart(12, '0'), { seq, path, args, queuedAt: Date.now(), idempotencyKey }];
}

let mod;

beforeEach(async () => {
	mod = await loadClient();
});

/**
 * A fresh client module graph over a fresh adapter mock: what a page load
 * gets. Calling it again inside a test is a reload.
 */
async function loadClient(realStatus = false) {
	vi.resetModules();
	statusCallbacks = new Set();
	statusInitialValue = 'open';
	realStatusStore = realStatus ? writable('open') : null;
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
		status: realStatusStore || {
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
 * success first, the way a full quota ends a transaction; a delete, too,
 * reports its request before its transaction commits or aborts. The rows
 * outlive the client that wrote them, so a test can reload against them.
 */
function fakeIndexedDb({ openFails = false, abortWrites = false, abortDeletes = false, readFails = false, abortReads = false, readHangs = false, deleteHangs = false, afterGet = null, unreadableKeys = new Set() } = {}) {
	const map = new Map();
	const stores = new Set();
	let closed = false;
	let opens = 0;
	const later = (fn) => setTimeout(fn, 0);
	const db = {
		close() { closed = true; },
		objectStoreNames: { contains: (name) => stores.has(name) },
		createObjectStore: (name) => { stores.add(name); },
		transaction(_name, mode) {
			if (closed) throw new Error('InvalidStateError');
			/** @type {any} */
			const tx = { error: null, pending: 0, aborted: false, abort() { tx.aborted = true; later(() => tx.onabort?.()); } };
			const completed = () => {
				tx.pending--;
				later(() => { if (!tx.aborted && tx.pending === 0) tx.oncomplete?.(); });
			};
			tx.objectStore = () => ({
				put(value, key) {
					tx.pending++;
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
								completed();
							}
						});
					});
					return req;
				},
				delete(keyOrRange) {
					tx.pending++;
					const keys = typeof keyOrRange === 'string'
						? [keyOrRange]
						: [...map.keys()].filter((k) => k >= keyOrRange.lower && k <= keyOrRange.upper);
					/** @type {any} */
					const req = {};
					later(() => {
						if (deleteHangs) return;
						req.onsuccess?.();
						later(() => {
							if (abortDeletes) {
								tx.error = new Error('AbortError');
								tx.onabort?.();
							} else {
								for (const k of keys) map.delete(k);
								completed();
							}
						});
					});
					return req;
				},
				get(key) {
					tx.pending++;
					const req = {};
					later(async () => {
						if (readHangs) return;
						if (readFails || unreadableKeys.has(key)) { req.error = new Error('Failed to read large IndexedDB value'); req.onerror?.(); tx.abort(); return; }
						if (abortReads) { tx.error = new Error('AbortError'); tx.abort(); return; }
						req.result = structuredClone(map.get(key));
						if (afterGet) await afterGet(key, mode);
						req.onsuccess?.(); completed();
					});
					return req;
				},
				openKeyCursor(range) { return this.openCursor(range, true); },
				openCursor(range, keysOnly = false) {
					const keys = [...map.keys()].filter((k) => k >= range.lower && k <= range.upper).sort();
					/** @type {any} */
					const req = { result: null };
					let i = 0;
					const step = () => later(() => {
						if (readHangs) return;
						if (readFails) {
							req.error = new Error('Failed to read large IndexedDB value');
							req.onerror?.();
							return;
						}
						if (abortReads) {
							tx.error = new Error('AbortError');
							tx.onabort?.();
							return;
						}
						const key = keys[i++];
						if (!keysOnly && unreadableKeys.has(key)) { req.error = new Error('Failed to read large IndexedDB value'); req.onerror?.(); return; }
						req.result = key === undefined ? null : { key, ...(keysOnly ? {} : { value: structuredClone(map.get(key)) }), continue: step };
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
		db,
		get opens() { return opens; },
		open() {
			opens++;
			/** @type {any} */
			const req = { error: null };
			later(() => {
				if (openFails) {
					req.error = new Error('denied');
					req.onerror?.();
					return;
				}
				closed = false;
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

	it('settling waits for a delayed enqueue write before deleting the stored mutation', async () => {
		const store = fakeStore();
		const put = store.put;
		let finishWrite;
		store.put = (key, value) => key.startsWith('q:')
			? new Promise((resolve) => { finishWrite = () => resolve(put(key, value)); })
			: put(key, value);
		const [pending] = await goOfflineAndQueue({ persist: store }, [['todos/add', ['queued']]]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'saved' }));
		await expect(pending).resolves.toBe('saved');
		expect(store.ops.filter(([op]) => op === 'delete')).toEqual([]);
		finishWrite();
		await flush();
		expect(storedKeys(store)).toEqual([]);
		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: store } });
		await flush();
		expect(replayedPaths()).toEqual([]);
	});

	it('checkpoint writes finish in upload order even when the first write is delayed', async () => {
		const store = fakeStore();
		const put = store.put;
		let finishWrite;
		let checkpointCalls = 0;
		store.put = (key, value) => {
			if (key.startsWith('c:') && ++checkpointCalls === 1) {
				return new Promise((resolve) => { finishWrite = () => resolve(put(key, value)); });
			}
			return put(key, value);
		};
		const [pending] = await goOfflineAndQueue({ persist: store }, [['todos/add', ['queued']]]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'saved' }));
		await expect(pending).resolves.toBe('saved');
		expect(checkpointCalls).toBe(1);
		finishWrite();
		await flush();
		expect(store.map.get('c:default')).toMatchObject({ lastUploadedSeq: 1, batchClean: true });
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

describe('offline queue - a replay function', () => {
	const three = [
		['todos/add', [{ t: 1 }]],
		['todos/add', [{ t: 2 }]],
		['todos/add', [{ t: 3 }]]
	];

	it('replays what it returns, in its order, and drops what it leaves out as STALE', async () => {
		const store = fakeStore();
		const onReplayError = vi.fn();
		const replay = (queue) => [queue[2], queue[0]];
		const watched = (await goOfflineAndQueue({ persist: store, replay, onReplayError }, three)).map(watch);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([3, 1]);
		expect(watched[0].value).toBe('ok');
		expect(watched[1].error).toMatchObject({ code: 'STALE' });
		expect(watched[2].value).toBe('ok');
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(onReplayError.mock.calls[0][0].args).toEqual([{ t: 2 }]);
		expect(storedKeys(store)).toEqual([]);
	});

	it('one that throws replays the queue as it is', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const replay = () => { throw new Error('app bug'); };
			const watched = (await goOfflineAndQueue({ replay }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 2, 3]);
			expect(watched.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
			expect(warn.mock.calls.some(([m]) => String(m).includes('offline.replay'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('one that returns no array replays the queue as it is', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const watched = (await goOfflineAndQueue({ replay: () => undefined }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(watched.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
		} finally {
			warn.mockRestore();
		}
	});

	it('a call it returns twice replays once, and anything not from the queue is ignored', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// The foreign item even carries a queued call's seq.
			const replay = (queue) => [queue[0], queue[0], { path: 'admin/wipe', args: [], queuedAt: 0, resolve() {}, reject() {}, seq: queue[2].seq, idempotencyKey: queue[2].idempotencyKey }, queue[1]];
			const watched = (await goOfflineAndQueue({ replay }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.rpc + ':' + e.args[0]?.t)).toEqual(['todos/add:1', 'todos/add:2']);
			expect(watched[2].error).toMatchObject({ code: 'STALE' });
			expect(warn.mock.calls.some(([m]) => String(m).includes('not queued calls'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('a copy built from the declared fields replays with its own path and args, under the call it copies', async () => {
		const store = fakeStore();
		const replay = (queue) => queue.map(({ path, args, queuedAt, resolve, reject }) => ({
			path: path.replace('todos/', 'tasks/'),
			args: [{ ...args[0], migrated: true }],
			queuedAt,
			resolve,
			reject
		}));
		const watched = (await goOfflineAndQueue({ persist: store, replay }, three.slice(0, 2))).map(watch);
		const keys = [...store.map.values()].map((v) => v.idempotencyKey);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => [e.rpc, e.args[0].migrated, e.idempotencyKey])).toEqual([
			['tasks/add', true, keys[0]],
			['tasks/add', true, keys[1]]
		]);
		expect(watched.map((w) => w.value)).toEqual(['ok', 'ok']);
		expect(storedKeys(store)).toEqual([]);
	});

	it('one that returns a promise replays the queue as it is', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const replay = async () => { throw new Error('rejected later'); };
			const watched = (await goOfflineAndQueue({ replay }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(watched.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
			expect(warn.mock.calls.some(([m]) => String(m).includes('synchronously'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('an array it throws is not taken for its answer', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const replay = () => { throw []; };
			const watched = (await goOfflineAndQueue({ replay }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(watched.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
		} finally {
			warn.mockRestore();
		}
	});

	it('JSON copies of the calls pick, order and rename like the entries, under each call\'s idempotency key', async () => {
		const store = fakeStore();
		const onReplayError = vi.fn();
		const replay = (queue) => JSON.parse(JSON.stringify(queue))
			.filter((call) => call.args[0].t !== 2)
			.map((call) => ({ ...call, path: call.path.replace('todos/', 'tasks/') }))
			.reverse();
		const watched = (await goOfflineAndQueue({ persist: store, replay, onReplayError }, three)).map(watch);
		const keys = [...store.map.values()].map((v) => v.idempotencyKey);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => [e.rpc, e.args[0].t, e.idempotencyKey])).toEqual([
			['tasks/add', 3, keys[2]],
			['tasks/add', 1, keys[0]]
		]);
		expect(watched[0].value).toBe('ok');
		expect(watched[1].error).toMatchObject({ code: 'STALE' });
		expect(watched[2].value).toBe('ok');
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(storedKeys(store)).toEqual([]);
	});

	it('a copy without a resolve function is a call\'s only when both its seq and its idempotency key are that call\'s', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const replay = (queue) => [
				{ path: 'admin/wipe', args: [], queuedAt: 0, seq: queue[0].seq, idempotencyKey: 'forged' },
				queue[1]
			];
			const watched = (await goOfflineAndQueue({ replay }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.rpc + ':' + e.args[0]?.t)).toEqual(['todos/add:2']);
			expect(watched[0].error).toMatchObject({ code: 'STALE' });
			expect(watched[2].error).toMatchObject({ code: 'STALE' });
			expect(warn.mock.calls.some(([m]) => String(m).includes('not queued calls'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('an answer with items but no queued call in it decides nothing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const store = fakeStore();
			const onReplayError = vi.fn();
			// Copies stripped of what identifies them.
			const replay = (queue) => queue.map(({ path, args }) => ({ path, args }));
			const watched = (await goOfflineAndQueue({ persist: store, replay, onReplayError }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 2, 3]);
			expect(watched.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
			expect(onReplayError).not.toHaveBeenCalled();
			expect(warn.mock.calls.some(([m]) => String(m).includes('none of them is a queued call'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('changing the entries it gets changes no queued call', async () => {
		const store = fakeStore();
		const onReplayError = vi.fn();
		const replay = (queue) => {
			queue[0].idempotencyKey = 'forged';
			queue[0].seq = queue[2].seq;
			queue[1].args[0].t = 'edited';
			return [queue[0]];
		};
		const watched = (await goOfflineAndQueue({ persist: store, replay, onReplayError }, three)).map(watch);
		const keys = [...store.map.values()].map((v) => v.idempotencyKey);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => [e.args[0].t, e.idempotencyKey])).toEqual([[1, keys[0]]]);
		expect(watched[0].value).toBe('ok');
		expect(onReplayError.mock.calls.map(([call]) => call.args[0].t)).toEqual([2, 3]);
		expect(storedKeys(store)).toEqual([]);
	});

	it('a null item leaves a call out, also when every item is one', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const some = (await goOfflineAndQueue({ replay: (queue) => queue.map((c) => (c.args[0].t === 2 ? c : null)) }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.args[0].t)).toEqual([2]);
			expect(some.map((w) => w.error?.code ?? w.value)).toEqual(['STALE', 'ok', 'STALE']);

			mod = await loadClient();
			const none = (await goOfflineAndQueue({ replay: (queue) => queue.map(() => null) }, three)).map(watch);
			simulateStatus('open');
			await flush();
			expect(sentCalls()).toEqual([]);
			expect(none.map((w) => w.error?.code)).toEqual(['STALE', 'STALE', 'STALE']);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('undefined items read as a forgotten return: all of them decide nothing, some of them are warned about', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const store = fakeStore();
			// A block body without `return`.
			const none = (await goOfflineAndQueue({ persist: store, replay: (queue) => queue.map((c) => { c.path = 'tasks/add'; }) }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.rpc + ':' + e.args[0].t)).toEqual(['todos/add:1', 'todos/add:2', 'todos/add:3']);
			expect(none.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
			expect(warn.mock.calls.some(([m]) => String(m).includes('none of them is a queued call'))).toBe(true);

			warn.mockClear();
			mod = await loadClient();
			const some = (await goOfflineAndQueue({ replay: (queue) => queue.map((c) => { if (c.args[0].t === 2) return c; }) }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.args[0].t)).toEqual([2]);
			expect(some.map((w) => w.error?.code ?? w.value)).toEqual(['STALE', 'ok', 'STALE']);
			expect(warn.mock.calls.some(([m]) => String(m).includes('2 item(s) that are not queued calls'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("a copy's args are taken when the function answers, and a copy whose args cannot be sent drops only its call", async () => {
		const later = (await goOfflineAndQueue({
			replay: (queue) => {
				const out = queue.map((c) => ({ ...c, args: [{ t: c.args[0].t * 10 }] }));
				queueMicrotask(() => { out[1].args[0].t = 'changed later'; });
				return out;
			}
		}, three.slice(0, 2))).map(watch);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([10, 20]);
		expect(later.map((w) => w.value)).toEqual(['ok', 'ok']);

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			mod = await loadClient();
			const store = fakeStore();
			const onReplayError = vi.fn();
			// The third call is left out on purpose; the first gets args a BigInt spoils.
			const watched = (await goOfflineAndQueue({ persist: store, onReplayError, replay: (queue) => [{ ...queue[0], args: [10n] }, queue[1]] }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.args[0].t)).toEqual([2]);
			expect(watched[0].error).toMatchObject({ code: 'STALE' });
			expect(watched[0].error.cause).toBeInstanceOf(TypeError);
			expect(watched[1].value).toBe('ok');
			expect(watched[2].error).toMatchObject({ code: 'STALE' });
			expect(watched[2].error.cause).toBeUndefined();
			expect(onReplayError).toHaveBeenCalledTimes(2);
			expect(storedKeys(store)).toEqual([]);
			expect(warn.mock.calls.some(([m]) => String(m).includes('offline.replay'))).toBe(false);

			// A sendable copy of a call wins over a spoiled one before it.
			mod = await loadClient();
			const both = (await goOfflineAndQueue({ replay: (queue) => [{ ...queue[0], args: [10n] }, queue[0], queue[1], queue[2]] }, three)).map(watch);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 2, 3]);
			expect(both.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);

			// Its only copy spoiled: still an answer, so what it left out goes too.
			mod = await loadClient();
			const only = (await goOfflineAndQueue({ replay: (queue) => [{ ...queue[0], args: [10n] }] }, three)).map(watch);
			simulateStatus('open');
			await flush();
			expect(sentCalls()).toEqual([]);
			expect(only.map((w) => w.error?.code)).toEqual(['STALE', 'STALE', 'STALE']);
		} finally {
			warn.mockRestore();
		}
	});

	it('a queued call whose stored args are not JSON is dropped before the function decides on the rest', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// A store that hands back what it was given, BigInt and all, as
			// IndexedDB does for a call stored before args were kept as JSON.
			const store = fakeStore(Object.fromEntries([seedEntry('default', 1, 'todos/add', [10n], 'off-big')]));
			const onReplayError = vi.fn();
			// Moves every call it gets to a renamed RPC.
			const replay = vi.fn((queue) => queue.map((c) => ({ ...c, path: 'tasks/add' })));
			mod.configure({ offline: { queue: true, persist: store, replay, onReplayError } });
			await flush(1);
			simulateStatus('disconnected');
			const fresh = watch(mod.__rpc('todos/add')({ t: 'new' }));
			await flush(1);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(replay).toHaveBeenCalledTimes(1);
			expect(replay.mock.calls[0][0].map((c) => c.args[0].t)).toEqual(['new']);
			expect(sentCalls().map((e) => e.rpc + ':' + e.args[0].t)).toEqual(['tasks/add:new']);
			expect(fresh.value).toBe('ok');
			expect(onReplayError).toHaveBeenCalledTimes(1);
			expect(onReplayError.mock.calls[0][1]).toMatchObject({ code: 'STALE' });
			expect(onReplayError.mock.calls[0][1].cause).toBeInstanceOf(TypeError);
			expect(storedKeys(store)).toEqual([]);
			expect(warn.mock.calls.some(([m]) => String(m).includes('offline.replay'))).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	it('an empty answer drops every call', async () => {
		const store = fakeStore();
		const onReplayError = vi.fn();
		const watched = (await goOfflineAndQueue({ persist: store, replay: () => [], onReplayError }, three)).map(watch);
		simulateStatus('open');
		await flush();
		expect(sentCalls()).toEqual([]);
		expect(watched.map((w) => w.error?.code)).toEqual(['STALE', 'STALE', 'STALE']);
		expect(onReplayError).toHaveBeenCalledTimes(3);
		expect(storedKeys(store)).toEqual([]);
	});

	it('an answer that throws while it is read decides nothing and loses no call', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const answers = [
				(queue) => [queue[0], { get resolve() { throw new Error('getter'); } }],
				() => new Proxy([], { get() { throw new Error('trap'); } }),
				(queue) => [{ ...queue[0], get path() { throw new Error('getter'); } }]
			];
			for (const replay of answers) {
				mod = await loadClient();
				const store = fakeStore();
				const watched = (await goOfflineAndQueue({ persist: store, replay }, three)).map(watch);
				simulateStatus('open');
				await flush();
				await respondAll(() => ({ ok: true, data: 'ok' }));
				expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 2, 3]);
				expect(watched.map((w) => w.value)).toEqual(['ok', 'ok', 'ok']);
				expect(storedKeys(store)).toEqual([]);
			}
			expect(warn.mock.calls.filter(([m]) => String(m).includes('could not be read'))).toHaveLength(3);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('offline queue - a call queued while the restore runs', () => {
	const row = (seq) => 'q:default:' + String(seq).padStart(12, '0');
	/** A store seeded with one restored row (seq 7) whose scan waits for `release()`. */
	function gatedStore({ fail = false, extra = {} } = {}) {
		/** @type {(v?: any) => void} */
		let release = () => {};
		const gate = new Promise((r) => { release = r; });
		const store = fakeStore({
			...Object.fromEntries([seedEntry('default', 7, 'todos/add', [{ t: 'restored' }], 'off-restored')]),
			...extra
		});
		const getAll = store.getAll;
		store.getAll = async (prefix) => {
			await gate;
			if (fail) throw new Error('scan failed');
			return getAll(prefix);
		};
		return { store, release: () => release() };
	}

	it('takes seqs past the stored rows, in the order queued, and each settle deletes only its own copy', async () => {
		const { store, release } = gatedStore();
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		const first = watch(mod.__rpc('todos/add')({ t: 'first' }));
		const second = watch(mod.__rpc('todos/add')({ t: 'second' }));
		await flush(1);
		expect(storedKeys(store)).toEqual([row(7)]);
		expect(store.map.get(row(7)).args).toEqual([{ t: 'restored' }]);

		release();
		await flush();
		expect(storedKeys(store)).toEqual([row(7), row(8), row(9)]);
		expect(store.map.get(row(8)).args).toEqual([{ t: 'first' }]);
		expect(store.map.get(row(9)).args).toEqual([{ t: 'second' }]);
		const firstKey = store.map.get(row(8)).idempotencyKey;
		expect(firstKey).not.toBe('off-restored');

		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[0].id, { ok: true, data: 'ok' });
		await flush();
		expect(storedKeys(store)).toEqual([row(8), row(9)]);
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(first.value).toBe('ok');
		expect(second.value).toBe('ok');
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['restored', 'first', 'second']);
		expect(sentCalls()[1].idempotencyKey).toBe(firstKey);
		expect(storedKeys(store)).toEqual([]);
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(9);
	});

	it('a reconnect during the restore replays the restored calls, then the ones queued meanwhile', async () => {
		const { store, release } = gatedStore();
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('todos/add')({ t: 'fresh' }));
		await flush(1);
		simulateStatus('open');
		await flush();
		expect(sentCalls()).toEqual([]);

		release();
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['restored', 'fresh']);
		expect(fresh.value).toBe('ok');
		expect(storedKeys(store)).toEqual([]);
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
		expect(storedKeys(store)).toEqual([row(7), row(8)]);
		expect(store.map.get(row(7)).args).toEqual([{ t: 'restored' }]);
		expect(store.map.get(row(8)).args).toEqual([{ t: 'kept' }]);
		expect(kept.settled).toBe(false);
	});

	it('a call the full queue drops during the restore is a hole below the calls queued after it', async () => {
		const { store, release } = gatedStore();
		mod.configure({ offline: { queue: true, maxQueue: 1, persist: store } });
		simulateStatus('disconnected');
		const dropped = watch(mod.__rpc('todos/add')({ t: 'dropped' }));
		const kept = watch(mod.__rpc('todos/add')({ t: 'kept' }));
		await flush(1);
		expect(dropped.error).toMatchObject({ code: 'QUEUE_FULL' });
		release();
		await flush();
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(kept.value).toBe('ok');
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['restored', 'kept']);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 8, gapDetected: true });
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
		expect(storedKeys(store)).toEqual([row(7), row(8)]);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(2);
	});

	it('a close during the restore rejects the call when its write then fails', async () => {
		const { store, release } = gatedStore();
		const put = store.put;
		store.put = async (key, value) => {
			if (value.args?.[0]?.t === 'fresh') throw new Error('quota exceeded');
			return put(key, value);
		};
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('todos/add')({ t: 'fresh' }));
		await flush(1);
		simulateStatus('failed');
		await flush();
		expect(fresh.settled).toBe(false);

		release();
		await flush();
		expect(fresh.error).toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(storedKeys(store)).toEqual([row(7)]);
	});

	it('a failed restore retry starts a fresh scope and rejects the old in-memory queue', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { store, release } = gatedStore({ fail: true });
			mod.configure({ offline: { queue: true, persist: store } });
			simulateStatus('disconnected');
			const during = watch(mod.__rpc('todos/add')({ t: 'during' }));
			await flush(1);
			release();
			await flush();
			expect(warn.mock.calls.some(([m]) => String(m).includes('could not be read'))).toBe(true);

			mod.configure({ offline: { queue: true, persist: store } });
			const after = watch(mod.__rpc('todos/add')({ t: 'after' }));
			await flush(1);
			expect(store.ops).toEqual([]);
			expect(store.map.get(row(7)).args).toEqual([{ t: 'restored' }]);

			simulateStatus('failed');
			await flush();
			expect(during.error).toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
			expect(after.error).toMatchObject({ code: 'CONNECTION_CLOSED' });
			expect(store.ops).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('a store whose getAll returns no array counts as unreadable', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const store = fakeStore();
			// Iterable, so only the array check can tell it from zero rows.
			store.getAll = async () => 'not rows';
			mod.configure({ offline: { queue: true, persist: store } });
			await flush(1);
			simulateStatus('disconnected');
			mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
			await flush(1);
			expect(store.ops).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('a checkpoint that cannot be read is left alone, and the queue it came with stays stored', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const store = fakeStore({
				...Object.fromEntries([seedEntry('default', 3, 'todos/add', [{ t: 'restored' }], 'off-3')]),
				'c:default': { lastUploadedSeq: 5, gapDetected: true }
			});
			const getAll = store.getAll;
			store.getAll = async (prefix) => {
				if (prefix.startsWith('c:')) throw new Error('read failed');
				return getAll(prefix);
			};
			mod.configure({ offline: { queue: true, persist: store } });
			await flush(1);
			simulateStatus('disconnected');
			const w = watch(mod.__rpc('todos/add')({ t: 'new' }));
			await flush(1);
			expect(storedKeys(store)).toEqual([row(3), row(4)]);
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'ok' }));
			expect(w.value).toBe('ok');
			expect(storedKeys(store)).toEqual([]);
			expect(store.map.get('c:default')).toEqual({ lastUploadedSeq: 5, gapDetected: true });
			expect(store.ops.filter(([op, k]) => op === 'put' && k.startsWith('c:'))).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('a full-queue drop during the restore leaves the stored checkpoint to the restore', async () => {
		const { store, release } = gatedStore({ extra: { 'c:default': { lastUploadedSeq: 9, gapDetected: true } } });
		mod.configure({ offline: { queue: true, maxQueue: 1, persist: store } });
		simulateStatus('disconnected');
		watch(mod.__rpc('todos/add')({ t: 'dropped' }));
		watch(mod.__rpc('todos/add')({ t: 'kept' }));
		await flush(1);
		release();
		await flush();
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 9, gapDetected: true });
		expect(store.map.get('c:default')).toMatchObject({ lastUploadedSeq: 9, gapDetected: true, batchFailedSeq: 9 });
		expect(storedKeys(store)).toEqual([row(7), row(10)]);
	});

	it('a restored call a full queue drops while the checkpoint is read counts once it is', async () => {
		/** @type {(v?: any) => void} */
		let release = () => {};
		const gate = new Promise((r) => { release = r; });
		const store = fakeStore({
			...Object.fromEntries([seedEntry('default', 7, 'todos/add', [{ t: 'restored' }], 'off-7')]),
			'c:default': { lastUploadedSeq: 9, gapDetected: false }
		});
		const getAll = store.getAll;
		store.getAll = async (prefix) => {
			if (prefix.startsWith('c:')) await gate;
			return getAll(prefix);
		};
		mod.configure({ offline: { queue: true, maxQueue: 1, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
		await flush(1);
		expect(storedKeys(store)).toEqual([]);
		release();
		await flush();
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 9, gapDetected: true });
	});

	it('restored rows without a valid seq take it from their key, and their copy goes when they settle', async () => {
		const store = fakeStore({
			'q:default:000000000003': { path: 'todos/add', args: [{ t: 'no-seq' }], queuedAt: Date.now(), idempotencyKey: 'off-3' },
			'q:default:000000000004': { seq: Infinity, path: 'todos/add', args: [{ t: 'bad-seq' }], queuedAt: Date.now(), idempotencyKey: 'off-4' }
		});
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
		await flush(1);
		expect(storedKeys(store)).toEqual([row(3), row(4), row(5)]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.idempotencyKey).slice(0, 2)).toEqual(['off-3', 'off-4']);
		expect(storedKeys(store)).toEqual([]);
	});

	it('a restored row takes its seq from its key, also when its stored seq differs, so its settle deletes it', async () => {
		const store = fakeStore({
			'q:default:000000000005': { seq: 9, path: 'todos/add', args: [{ t: 'moved' }], queuedAt: Date.now(), idempotencyKey: 'off-5' }
		});
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
		await flush(1);
		expect(storedKeys(store)).toEqual([row(5), row(6)]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.idempotencyKey)[0]).toBe('off-5');
		expect(storedKeys(store)).toEqual([]);
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(6);
	});

	it('a persistKey that another key extends with ":" restores only its own rows', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('a', 1, 'todos/add', [{ t: 'mine' }], 'off-mine'),
			seedEntry('a:b', 1, 'todos/add', [{ t: 'theirs-1' }], 'off-theirs-1'),
			seedEntry('a:b', 7, 'todos/add', [{ t: 'theirs-7' }], 'off-theirs-7')
		]));
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'a' } });
		await flush(1);
		let pending;
		mod.pendingMutations.subscribe((n) => { pending = n; });
		expect(pending).toBe(1);
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
		await flush(1);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['mine', 'new']);
		expect(storedKeys(store)).toEqual(['q:a:b:000000000001', 'q:a:b:000000000007']);
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(2);
	});

	it('only rows of exactly the queue key shape are restored, and an unrestorable one still holds its seq', async () => {
		const store = fakeStore({
			'q:default:12': { path: 'todos/add', args: [{ t: 'short' }], queuedAt: Date.now(), idempotencyKey: 'off-short' },
			'q:default:0000000000013': { path: 'todos/add', args: [{ t: 'long' }], queuedAt: Date.now(), idempotencyKey: 'off-long' },
			'q:default:00000000001x': { path: 'todos/add', args: [{ t: 'letter' }], queuedAt: Date.now(), idempotencyKey: 'off-letter' },
			'q:default:000000000000': { path: 'todos/add', args: [{ t: 'zero' }], queuedAt: Date.now(), idempotencyKey: 'off-zero' },
			'q:default:000000000004': { path: 42, args: 'not a call' },
			'q:default:000000000002': { path: 'todos/add', args: [{ t: 'real' }], queuedAt: Date.now(), idempotencyKey: 'off-real' }
		});
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
		await flush(1);
		// Past the unrestorable row 4, so its row is not written over.
		expect(store.map.get(row(4))).toEqual({ path: 42, args: 'not a call' });
		expect(store.map.get(row(5)).args).toEqual([{ t: 'new' }]);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['real', 'new']);
	});

	it('rows a custom store returns outside the scanned prefix are not restored', async () => {
		const store = fakeStore({
			// A persistKey as long as 'default': only the prefix tells the rows apart.
			...Object.fromEntries([seedEntry('another', 1, 'todos/add', [{ t: 'other' }], 'off-other')]),
			...Object.fromEntries([seedEntry('default', 3, 'todos/add', [{ t: 'mine' }], 'off-mine')])
		});
		const getAll = store.getAll;
		// Ignores the prefix it is given, and returns odd rows too.
		store.getAll = async () => [null, { key: 7, value: { path: 'todos/add', args: [{ t: 'number key' }] } }, ...await getAll('')];
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['mine']);
		expect(storedKeys(store)).toEqual(['q:another:000000000001']);
	});

	it('a row that throws while the restore reads it counts as an unreadable queue', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const store = fakeStore(Object.fromEntries([seedEntry('default', 1, 'todos/add', [{ t: 'a' }], 'off-a')]));
			const getAll = store.getAll;
			store.getAll = async (prefix) => {
				const rows = await getAll(prefix);
				if (prefix.startsWith('q:')) rows.push({ key: 'q:default:000000000002', get value() { throw new Error('unreadable'); } });
				return rows;
			};
			mod.configure({ offline: { queue: true, persist: store } });
			await flush(1);
			simulateStatus('disconnected');
			mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
			await flush(1);
			// Nothing is written: the queue goes on in memory.
			expect(storedKeys(store)).toEqual([row(1)]);
			expect(warn.mock.calls.some(([m]) => String(m).includes('the stored queue could not be read'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('a corrupt checkpoint does not stall the numbering', async () => {
		const store = fakeStore({ 'c:default': { lastUploadedSeq: 1e20, gapDetected: false } });
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 'a' }).catch(() => {});
		mod.__rpc('todos/add')({ t: 'b' }).catch(() => {});
		await flush(1);
		expect(storedKeys(store)).toEqual([row(1), row(2)]);
	});

	it('new seqs continue past the last upload once its rows are gone', async () => {
		const store = fakeStore({ 'c:default': { lastUploadedSeq: 5, gapDetected: false } });
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		const call = watch(mod.__rpc('todos/add')({ t: 'new' }));
		await flush(1);
		expect(storedKeys(store)).toEqual([row(6)]);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: false, code: 'VALIDATION', error: 'bad' }));
		expect(call.error).toMatchObject({ code: 'VALIDATION' });
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 5, gapDetected: false });
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

	it('a call a drop put back after an earlier call failed opens the gap when it goes up later', async () => {
		const [p1, p2] = await goOfflineAndQueue({}, [
			['todos/add', [{ t: 'fails' }]],
			['todos/add', [{ t: 'cut' }]]
		]);
		const w1 = watch(p1);
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[0].id, { ok: false, code: 'VALIDATION', error: 'bad' });
		await flush();
		expect(w1.error).toMatchObject({ code: 'VALIDATION' });
		simulateStatus('disconnected');
		await flush();
		expect(mod.offlineCheckpoint().gapDetected).toBe(false);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w2.value).toBe('ok');
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 2, gapDetected: true });
	});

	it('a failure below a call that already went up opens the gap', async () => {
		const [p1, p2] = await goOfflineAndQueue({ replay: 'concurrent' }, [
			['todos/add', [{ t: 'cut' }]],
			['todos/add', [{ t: 'up' }]]
		]);
		const w1 = watch(p1);
		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[1].id, { ok: true, data: 'ok' });
		await flush();
		await expect(p2).resolves.toBe('ok');
		simulateStatus('disconnected');
		await flush();
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 2, gapDetected: false });

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: false, code: 'VALIDATION', error: 'bad' }));
		expect(w1.error).toMatchObject({ code: 'VALIDATION' });
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);
	});

	it('the drain that carries on a cut one does not close the gap the cut one opened', async () => {
		const [p1, p2, p3] = await goOfflineAndQueue({ replay: 'concurrent' }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]],
			['todos/add', [{ t: 3 }]]
		]);
		const w1 = watch(p1);
		watch(p2);
		watch(p3);
		simulateStatus('open');
		await flush();
		const [, s2, s3] = sentCalls();
		simulateRpcResponse(s3.id, { ok: true, data: 'ok' });
		simulateRpcResponse(s2.id, { ok: false, code: 'VALIDATION', error: 'bad' });
		await flush();
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);
		simulateStatus('disconnected');
		await flush();

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w1.value).toBe('ok');
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);

		// A batch after it that goes up clean closes the gap.
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 4 }).catch(() => {});
		await flush(1);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(mod.offlineCheckpoint().gapDetected).toBe(false);
	});

	it('calls that go up after a full queue dropped an older one open the gap', async () => {
		const [dropped, p2, p3] = await goOfflineAndQueue({ maxQueue: 2 }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]],
			['todos/add', [{ t: 3 }]]
		]);
		await expect(dropped).rejects.toMatchObject({ code: 'QUEUE_FULL' });
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		await expect(p2).resolves.toBe('ok');
		await expect(p3).resolves.toBe('ok');
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 3, gapDetected: true });
	});

	it('a full-queue drop while a drain runs still counts when the close cuts that drain', async () => {
		const store = fakeStore();
		const save = mod.__rpc('todos/add');
		let draftsOnDrop = false;
		mod.configure({
			offline: { queue: true, maxQueue: 1, persist: store },
			onDisconnect: () => {
				if (!draftsOnDrop) return;
				save({ t: 'd1' }).catch(() => {});
				save({ t: 'd2' }).catch(() => {});
			}
		});
		simulateStatus('disconnected');
		save({ t: 'a' }).catch(() => {});
		await flush(1);
		simulateStatus('open');
		await flush();
		draftsOnDrop = true;
		// The drop that uses up the last reconnect attempt: 'failed' follows at once.
		simulateStatus('disconnected');
		simulateStatus('failed');
		await flush();

		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['a', 'd2']);
		expect(mod.offlineCheckpoint().gapDetected).toBe(true);
	});

	it('a batch the close cut off carries its failure across a reload', async () => {
		const store = fakeStore();
		const [p1] = await goOfflineAndQueue({ persist: store }, [
			['todos/add', [{ t: 'fails' }]],
			['todos/add', [{ t: 'cut' }]]
		]);
		watch(p1);
		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[0].id, { ok: false, code: 'VALIDATION', error: 'bad' });
		await flush();
		simulateStatus('failed');
		await flush();
		expect(storedKeys(store)).toEqual(['q:default:000000000002']);

		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['cut']);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 2, gapDetected: true });
	});

	it('a page closed while a replay is in flight carries the failure before it to the next page', async () => {
		const store = fakeStore();
		const [p1] = await goOfflineAndQueue({ persist: store }, [
			['todos/add', [{ t: 'fails' }]],
			['todos/add', [{ t: 'in flight' }]]
		]);
		watch(p1);
		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[0].id, { ok: false, code: 'VALIDATION', error: 'bad' });
		await flush();
		expect(sentCalls()).toHaveLength(2);

		// The page goes away with the second replay unanswered.
		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual(['in flight']);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 2, gapDetected: true });
	});

	it('a call queued after a reload is numbered past the seq a carried batch failed at', async () => {
		const store = fakeStore({
			'c:default': { lastUploadedSeq: 0, gapDetected: false, batchFailedSeq: 3, batchClean: false },
			...Object.fromEntries([
				seedEntry('default', 1, 'todos/add', [{ t: 1 }], 'off-1'),
				seedEntry('default', 2, 'todos/add', [{ t: 2 }], 'off-2')
			])
		});
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 'new' }).catch(() => {});
		await flush(1);
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002', 'q:default:000000000004']);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 4, gapDetected: true });
	});

	it('a page closed mid-replay leaves a batch that closes no gap, and the batch after it can', async () => {
		const store = fakeStore({
			'c:default': { lastUploadedSeq: 5, gapDetected: true, batchFailedSeq: null, batchClean: true },
			...Object.fromEntries([
				seedEntry('default', 6, 'todos/add', [{ t: 6 }], 'off-6'),
				seedEntry('default', 7, 'todos/add', [{ t: 7 }], 'off-7')
			])
		});
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		expect(sentCalls()).toHaveLength(1);

		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: store } });
		await flush(1);
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 7, gapDetected: true });

		simulateStatus('disconnected');
		mod.__rpc('todos/add')({ t: 8 }).catch(() => {});
		await flush(1);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 8, gapDetected: false });
	});

	it('a later call failing first does not open a gap below it', async () => {
		const [p1, p2] = await goOfflineAndQueue({ replay: 'concurrent' }, [
			['todos/add', [{ t: 'up' }]],
			['todos/add', [{ t: 'fails' }]]
		]);
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[1].id, { ok: false, code: 'VALIDATION', error: 'bad' });
		await flush();
		simulateRpcResponse(sentCalls()[0].id, { ok: true, data: 'ok' });
		await flush();
		await expect(p1).resolves.toBe('ok');
		expect(w2.error).toMatchObject({ code: 'VALIDATION' });
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 1, gapDetected: false });
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

	it('the same function subscribed twice is two subscriptions', async () => {
		const seen = [];
		const fn = (n) => seen.push(n);
		const first = mod.pendingMutations.subscribe(fn);
		const second = mod.pendingMutations.subscribe(fn);
		first();
		await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]]]);
		expect(seen).toEqual([0, 0, 1]);
		second();
	});

	it('a count set from inside a subscriber reaches the others after it, never under it', async () => {
		mod.configure({ offline: { queue: true } });
		simulateStatus('disconnected');
		const events = [];
		let inside = false;
		mod.pendingMutations.subscribe((n) => {
			if (inside) events.push('re-entered');
			inside = true;
			// Queues a second call while the first one's count is delivered.
			if (n === 1) mod.__rpc('todos/add')({ t: 2 }).catch(() => {});
			inside = false;
		});
		const later = [];
		mod.pendingMutations.subscribe((n) => later.push(n));
		mod.__rpc('todos/add')({ t: 1 }).catch(() => {});
		await flush(1);
		expect(events).toEqual([]);
		expect(later).toEqual([0, 2]);
	});

	it('a count set from inside an uploading subscriber waits until uploading has reached all of its own', async () => {
		const save = mod.__rpc('todos/add');
		await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]]]);
		let saveDraft = false;
		// Saves a draft when an upload stops, as the connection is down.
		mod.uploading.subscribe((v) => {
			if (!v && saveDraft) {
				saveDraft = false;
				save({ t: 'draft' }).catch(() => {});
			}
		});
		const events = [];
		mod.uploading.subscribe((v) => events.push('uploading ' + v));
		mod.pendingMutations.subscribe((n) => events.push('pending ' + n));
		simulateStatus('open');
		await flush();
		saveDraft = true;
		events.length = 0;
		simulateStatus('disconnected');
		await flush();
		expect(events).toEqual(['pending 1', 'uploading false', 'pending 2']);
	});

	it('a subscription ended while a value is delivered is not called with it', async () => {
		const later = [];
		/** @type {() => void} */
		let offLater = () => {};
		mod.pendingMutations.subscribe((n) => { if (n === 1) offLater(); });
		offLater = mod.pendingMutations.subscribe((n) => later.push(n));
		await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]]]);
		expect(later).toEqual([0]);
	});

	it('invalidate runs for every subscription before any is called with the value', async () => {
		const order = [];
		mod.pendingMutations.subscribe(() => order.push('run a'), () => order.push('invalidate a'));
		mod.pendingMutations.subscribe(() => order.push('run b'), () => order.push('invalidate b'));
		order.length = 0;
		await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]]]);
		expect(order).toEqual(['invalidate a', 'invalidate b', 'run a', 'run b']);
	});

	it('a svelte derived over pendingMutations and a store derived from it never sees the two out of step', async () => {
		const { derived } = await import('svelte/store');
		const doubled = derived(mod.pendingMutations, (n) => n * 2);
		const offDoubled = doubled.subscribe(() => {});
		const drift = derived([mod.pendingMutations, doubled], ([n, d]) => d - 2 * n);
		const seen = [];
		const offDrift = drift.subscribe((v) => seen.push(v));
		await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]], ['todos/add', [{ t: 2 }]]]);
		expect(seen).toEqual([0]);
		offDrift();
		offDoubled();
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

	it('custom: merged args that cannot be sent drop the call with the conflict, and the replay goes on', async () => {
		const onReplayError = vi.fn();
		// Reading it throws something whose code cannot be read either.
		const unreadable = new Proxy([], { get() { throw { get code() { throw new Error('no code'); } }; } });
		const [p1, p2] = await goOfflineAndQueue({ conflictResolution: 'custom', onConflict: () => unreadable, onReplayError }, [
			['docs/save', [{ v: 1 }]],
			['docs/save', [{ v: 2 }]]
		]);
		const w1 = watch(p1);
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		let first = true;
		await respondAll(() => {
			if (first) { first = false; return { ok: false, code: 'CONFLICT', error: 'moved' }; }
			return { ok: true, data: 'applied' };
		});
		expect(w1.error).toMatchObject({ code: 'CONFLICT' });
		expect(w2.value).toBe('applied');
		expect(onReplayError).toHaveBeenCalledTimes(1);
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

	it('a socket the adapter replaces with no drop in between cuts the replay on it', async () => {
		const store = fakeStore();
		const [p1, p2] = await goOfflineAndQueue({ persist: store }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]]
		]);
		const w1 = watch(p1);
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		expect(sentCalls()).toHaveLength(1);

		// The adapter closes the socket itself, then a new one replaces it before
		// the old one's close lands, so 'disconnected' never comes.
		simulateClosing();
		simulateStatus('connecting');
		await flush();
		expect(w1.settled).toBe(false);
		expect(sentCalls()).toHaveLength(1);
		expect(storedKeys(store)).toHaveLength(2);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 1, 2]);
		expect(w1.value).toBe('ok');
		expect(w2.value).toBe('ok');
		expect(storedKeys(store)).toEqual([]);
	});

	it('a socket replaced between two replays stops the drain before the next send', async () => {
		const [p1, p2] = await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]], ['todos/add', [{ t: 2 }]]]);
		// App code the first settle runs replaces the socket.
		p1.then(() => simulateStatus('connecting'));
		const w2 = watch(p2);
		simulateStatus('open');
		await flush();
		simulateRpcResponse(sentCalls()[0].id, { ok: true, data: 'ok' });
		await flush();
		expect(sentCalls()).toHaveLength(1);
		expect(w2.settled).toBe(false);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.args[0].t)).toEqual([1, 2]);
		expect(w2.value).toBe('ok');
	});

	it('a socket replaced while the restore is read sends nothing until the new one opens', async () => {
		/** @type {(v?: any) => void} */
		let release = () => {};
		const gate = new Promise((r) => { release = r; });
		const store = fakeStore(Object.fromEntries([seedEntry('default', 1, 'todos/add', [{ t: 'a' }], 'off-a')]));
		const getAll = store.getAll;
		store.getAll = async (prefix) => { await gate; return getAll(prefix); };
		mod.configure({ offline: { queue: true, persist: store } });
		const uploadingSeen = [];
		mod.uploading.subscribe((v) => uploadingSeen.push(v));
		simulateStatus('disconnected');
		simulateStatus('open');
		await flush(1);
		simulateClosing();
		simulateStatus('connecting');
		release();
		await flush();
		expect(sentCalls()).toEqual([]);
		expect(uploadingSeen).toEqual([false]);

		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(sentCalls().map((e) => e.idempotencyKey)).toEqual(['off-a']);
		expect(storedKeys(store)).toEqual([]);
	});

	it('a regular call interrupted as the socket closes rejects and never sends on the new socket', async () => {
		mod.configure({ offline: { queue: true } });
		simulateClosing();
		const w = watch(mod.__rpc('todos/add')({ t: 'live' }));
		await flush(1);
		expect(sentCalls()).toEqual([]);
		simulateStatus('connecting');
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w.error).toMatchObject({ code: 'DISCONNECTED' });
		expect(sentCalls()).toEqual([]);
		expect(adapterQueue).toEqual([]);
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
			'q:default:000000000001': { path: 'todos/add', args: [{ t: 'a' }], queuedAt: Date.now(), idempotencyKey: 'off-a' },
			'q:default:000000000002': { path: 'todos/add', args: [{ t: 'b' }], queuedAt: Date.now(), idempotencyKey: 'off-b' }
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

	it('a restored call a full queue drops is reported to onReplayError', async () => {
		const store = fakeStore(Object.fromEntries([seedEntry('default', 1, 'todos/add', [{ t: 'restored' }], 'off-r')]));
		const onReplayError = vi.fn();
		mod.configure({ offline: { queue: true, maxQueue: 1, persist: store, onReplayError } });
		await flush(1);
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('todos/add')({ t: 'fresh' }));
		await flush(1);
		expect(onReplayError).toHaveBeenCalledTimes(1);
		expect(onReplayError.mock.calls[0][0]).toMatchObject({ path: 'todos/add', args: [{ t: 'restored' }] });
		expect(onReplayError.mock.calls[0][1]).toMatchObject({ code: 'QUEUE_FULL' });
		expect(storedKeys(store)).toEqual(['q:default:000000000002']);
		expect(fresh.settled).toBe(false);
	});

	it('a maxQueue that is not a whole number keeps the call a cut puts back', async () => {
		const [p] = await goOfflineAndQueue({ maxQueue: 0.5 }, [['todos/add', [{ t: 1 }]]]);
		const w = watch(p);
		simulateStatus('open');
		await flush();
		simulateStatus('disconnected');
		await flush();
		expect(w.settled).toBe(false);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w.value).toBe('ok');
	});

	it('the close for good puts back what it cut without trimming, so stored copies stay', async () => {
		const store = fakeStore();
		const save = mod.__rpc('todos/add');
		let draftOnDrop = false;
		mod.configure({
			offline: { queue: true, maxQueue: 1, persist: store },
			onDisconnect: () => {
				if (draftOnDrop) save({ t: 'draft' }).catch(() => {});
			}
		});
		simulateStatus('disconnected');
		const w1 = watch(save({ t: 1 }));
		await flush(1);
		simulateStatus('open');
		await flush();
		draftOnDrop = true;
		// The drop that uses up the last reconnect attempt: 'failed' follows at once.
		simulateStatus('disconnected');
		simulateStatus('failed');
		await flush();
		expect(w1.settled).toBe(false);
		expect(storedKeys(store)).toEqual(['q:default:000000000001', 'q:default:000000000002']);
	});

	it('an onReplayError that queues a call while the queue is full reports once and evicts once', async () => {
		let n = 0;
		const log = mod.__rpc('log/drop');
		const onReplayError = vi.fn(() => { log.fresh({ n: n++ }).catch(() => {}); });
		const [first, second, third] = await goOfflineAndQueue({ maxQueue: 2, onReplayError }, [
			['todos/add', [{ t: 1 }]],
			['todos/add', [{ t: 2 }]],
			['todos/add', [{ t: 3 }]]
		]);
		await expect(first).rejects.toMatchObject({ code: 'QUEUE_FULL' });
		await expect(second).rejects.toMatchObject({ code: 'QUEUE_FULL' });
		expect(onReplayError).toHaveBeenCalledTimes(1);
		const w3 = watch(third);
		let pendingSeen;
		mod.pendingMutations.subscribe((v) => { pendingSeen = v; });
		expect(pendingSeen).toBe(2);
		expect(w3.settled).toBe(false);
	});

	it('a restored call a call made inside onReplayError pushes out is still reported', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('default', 1, 'todos/add', [{ t: 'r1' }], 'off-r1'),
			seedEntry('default', 2, 'todos/add', [{ t: 'r2' }], 'off-r2'),
			seedEntry('default', 3, 'todos/add', [{ t: 'r3' }], 'off-r3')
		]));
		const log = mod.__rpc('log/drop');
		const reported = [];
		const onReplayError = vi.fn((call) => {
			reported.push(call.args[0].t ?? 'log');
			log.fresh({}).catch(() => {});
		});
		mod.configure({ offline: { queue: true, maxQueue: 3, persist: store, onReplayError } });
		await flush(1);
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('todos/add')({ t: 'new' }));
		await flush(1);
		// The new call pushes out r1; the hook's calls push out r2, r3, and then
		// the new call, whose promise reports it.
		expect(reported).toEqual(['r1', 'r2', 'r3']);
		expect(fresh.error).toMatchObject({ code: 'QUEUE_FULL' });
		expect(storedKeys(store).map((k) => store.map.get(k).path)).toEqual(['log/drop', 'log/drop', 'log/drop']);
	});

	it('a maxQueue that is not a number counts as unset', async () => {
		const calls = Array.from({ length: 101 }, (_, i) => ['todos/add', [{ t: i }]]);
		const [first, second] = await goOfflineAndQueue({ maxQueue: 'lots' }, calls);
		await expect(first).rejects.toMatchObject({ code: 'QUEUE_FULL' });
		expect(watch(second).settled).toBe(false);
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

	it('an onReplayError that throws does not stop the drain, and is warned about', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		onTestFinished(() => warn.mockRestore());
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
		expect(warn.mock.calls.some(([m]) => String(m).includes('onReplayError threw'))).toBe(true);
	});

	it('a beforeReplay that throws drops the call as STALE and reports it, never sending it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const store = fakeStore();
			const onReplayError = vi.fn();
			let currentUser = null;
			const beforeReplay = (call) => call.args[0].owner === currentUser.id;
			const [p1, p2] = await goOfflineAndQueue({ persist: store, beforeReplay, onReplayError }, [
				['todos/add', [{ t: 1, owner: 'u1' }]],
				['todos/add', [{ t: 2, owner: 'u1' }]]
			]);
			const w1 = watch(p1);
			const w2 = watch(p2);
			simulateStatus('open');
			await flush();
			expect(sentCalls()).toEqual([]);
			expect(w1.error).toMatchObject({ code: 'STALE' });
			expect(w1.error.cause).toBeInstanceOf(TypeError);
			expect(w2.error).toMatchObject({ code: 'STALE' });
			expect(onReplayError).toHaveBeenCalledTimes(2);
			expect(storedKeys(store)).toEqual([]);
			// Once per replay, naming the cause.
			const warned = warn.mock.calls.filter(([m]) => String(m).includes('beforeReplay threw'));
			expect(warned).toHaveLength(1);
			expect(String(warned[0][0])).toContain(w1.error.cause.message);
		} finally {
			warn.mockRestore();
		}
	});

	it('a beforeReplay that returns a promise drops the call as STALE, never sending it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const unhandled = vi.fn();
			process.on('unhandledRejection', unhandled);
			onTestFinished(() => { process.off('unhandledRejection', unhandled); });
			const store = fakeStore();
			const onReplayError = vi.fn();
			// Would refuse every call, once it settles.
			const beforeReplay = async () => { throw new Error('refused later'); };
			const watched = (await goOfflineAndQueue({ persist: store, beforeReplay, onReplayError }, [
				['todos/add', [{ t: 1 }]],
				['todos/add', [{ t: 2 }]]
			])).map(watch);
			simulateStatus('open');
			await flush();
			await flush();
			expect(unhandled).not.toHaveBeenCalled();
			expect(sentCalls()).toEqual([]);
			expect(watched.map((w) => w.error?.code)).toEqual(['STALE', 'STALE']);
			expect(watched[0].error.message).toMatch(/returned a promise/);
			expect(watched[0].error.cause).toBeUndefined();
			expect(onReplayError).toHaveBeenCalledTimes(2);
			expect(storedKeys(store)).toEqual([]);
			expect(warn.mock.calls.filter(([m]) => String(m).includes('must answer synchronously'))).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	it('a pendingMutations or uploading subscriber that throws breaks neither the queue nor the drain', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		onTestFinished(() => error.mockRestore());
		const throwing = () => {
			let first = true;
			return () => {
				if (first) { first = false; return; }
				throw new Error('subscriber bug');
			};
		};
		mod.pendingMutations.subscribe(throwing());
		mod.uploading.subscribe(throwing());
		// Subscribed after the throwing ones: still told every change.
		const pendingSeen = [];
		mod.pendingMutations.subscribe((n) => pendingSeen.push(n));
		const [p] = await goOfflineAndQueue({}, [['todos/add', [{ t: 1 }]]]);
		const w = watch(p);
		await flush(1);
		expect(w.settled).toBe(false);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(w.value).toBe('ok');
		expect(error.mock.calls.some(([m]) => String(m).includes('subscriber threw'))).toBe(true);
		expect(pendingSeen).toEqual([0, 1, 0]);

		// The next drain still runs.
		simulateStatus('disconnected');
		const second = watch(mod.__rpc('todos/add')({ t: 2 }));
		await flush(1);
		simulateStatus('open');
		await flush();
		await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(second.value).toBe('ok');
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

describe('the IndexedDB store', () => {
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

	it.each(['onclose', 'onversionchange'])('reopens after the database receives %s', async (event) => {
		const idb = fakeIndexedDb();
		vi.stubGlobal('indexedDB', idb);
		const store = mod.createIndexedDbStore();
		await store.put('q:first', { value: 1 });
		if (event === 'onclose') idb.db.close();
		idb.db[event]();
		await store.put('q:second', { value: 2 });
		expect(idb.opens).toBe(2);
		expect(idb.map.get('q:second')).toEqual({ value: 2 });
	});

	it.each(['open', 'read'])('a hung database %s cannot keep queued calls from replaying', async (operation) => {
		vi.useFakeTimers();
		try {
			const request = {};
			vi.stubGlobal('indexedDB', operation === 'open' ? { open: () => request } : fakeIndexedDb({ readHangs: true }));
			mod.configure({ offline: { queue: true, persist: true } });
			simulateStatus('disconnected');
			const pending = mod.__rpc('todos/add')('memory');
			simulateStatus('open');
			await vi.advanceTimersByTimeAsync(6000);
			expect(sentCalls()).toHaveLength(1);
			simulateRpcResponse(sentCalls()[0].id, { ok: true, data: 'saved' });
			await expect(pending).resolves.toBe('saved');
			if (operation === 'open') {
				request.result = { close: vi.fn() };
				request.onsuccess();
				expect(request.result.close).toHaveBeenCalledOnce();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('delete settles once its transaction has committed', async () => {
		const idb = fakeIndexedDb();
		vi.stubGlobal('indexedDB', idb);
		const store = mod.createIndexedDbStore();
		await store.put('q:a', { v: 1 });
		let presentWhenSettled;
		await store.delete('q:a').then(() => { presentWhenSettled = idb.map.has('q:a'); });
		expect(presentWhenSettled).toBe(false);
	});

	it('clear settles once its transaction has committed', async () => {
		const idb = fakeIndexedDb();
		vi.stubGlobal('indexedDB', idb);
		const store = mod.createIndexedDbStore();
		await store.put('q:a', { v: 1 });
		await store.put('q:b', { v: 2 });
		await store.put('c:x', { v: 3 });
		/** @type {string[]} */
		let keysWhenSettled = [];
		await store.clear('q:').then(() => { keysWhenSettled = [...idb.map.keys()]; });
		expect(keysWhenSettled).toEqual(['c:x']);
	});

	it('a delete whose transaction aborts settles after the abort, without rejecting', async () => {
		const idb = fakeIndexedDb({ abortDeletes: true });
		vi.stubGlobal('indexedDB', idb);
		const store = mod.createIndexedDbStore();
		await store.put('q:a', { v: 1 });
		let warnedWhenSettled;
		await expect(store.delete('q:a').then(() => { warnedWhenSettled = warn.mock.calls.length > 0; })).resolves.toBeUndefined();
		expect(warnedWhenSettled).toBe(true);
		expect(idb.map.has('q:a')).toBe(true);
	});

	it('a read that fails rejects', async () => {
		vi.stubGlobal('indexedDB', fakeIndexedDb({ readFails: true }));
		const store = mod.createIndexedDbStore();
		await expect(store.getAll('q:')).rejects.toThrow(/Failed to read/);
		expect(warn).toHaveBeenCalled();
	});

	it('a read whose transaction aborts rejects', async () => {
		vi.stubGlobal('indexedDB', fakeIndexedDb({ abortReads: true }));
		await expect(mod.createIndexedDbStore().getAll('q:')).rejects.toThrow(/AbortError/);
	});

	it('a read when the database cannot open rejects without assuming an empty queue', async () => {
		vi.stubGlobal('indexedDB', fakeIndexedDb({ openFails: true }));
		await expect(mod.createIndexedDbStore().getAll('q:')).rejects.toThrow(/unavailable/);
	});

	it('a restore whose read fails stores nothing for the rest of the page', async () => {
		const idb = fakeIndexedDb();
		vi.stubGlobal('indexedDB', idb);
		await mod.createIndexedDbStore().put('q:default:000000000006', { seq: 6, path: 'todos/add', args: [{ t: 'stored' }], queuedAt: Date.now(), idempotencyKey: 'off-6' });
		const unreadable = fakeIndexedDb({ readFails: true });
		for (const [k, v] of idb.map) unreadable.map.set(k, v);
		vi.stubGlobal('indexedDB', unreadable);

		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: true } });
		simulateStatus('disconnected');
		const w = watch(mod.__rpc('todos/add')({ t: 'new' }));
		await flush(6);
		expect([...unreadable.map.keys()]).toEqual(['q:default:000000000006']);
		simulateStatus('failed');
		await flush();
		expect(w.error).toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(unreadable.map.get('q:default:000000000006').args).toEqual([{ t: 'stored' }]);
	});

	it('a delete when the database cannot open settles without rejecting', async () => {
		vi.stubGlobal('indexedDB', fakeIndexedDb({ openFails: true }));
		const store = mod.createIndexedDbStore();
		await expect(store.delete('q:a')).resolves.toBeUndefined();
		await expect(store.clear('q:')).resolves.toBeUndefined();
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
		// A proxy, which IndexedDB cannot clone: what the test is about.
		expect(() => structuredClone(form)).toThrow();
		mod.configure({ offline: { queue: true, persist: true } });
		simulateStatus('disconnected');
		const p = mod.__rpc('todos/save')(form);
		const w = watch(p);
		// The write waits for the restore's scan, then commits.
		await until(() => queuedRows(idb).length > 0);
		const rows = queuedRows(idb);
		expect(rows).toHaveLength(1);
		expect(rows[0][1].args).toEqual([{ title: 'draft', tags: ['a'] }]);
		expect(warn).not.toHaveBeenCalled();
		simulateStatus('failed');
		await flush();
		expect(w.settled).toBe(false);

		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: true } });
		await until(() => mod.offlinePersistence().status !== 'restoring');
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

	it('a call that cannot be queued does not push the oldest out of a full queue', async () => {
		mod.configure({ offline: { queue: true, maxQueue: 1 } });
		simulateStatus('disconnected');
		const kept = watch(mod.__rpc('todos/save')({ t: 'kept' }));
		const big = watch(mod.__rpc('todos/save').fresh({ count: 1n }));
		await flush(1);
		expect(big.error).toBeInstanceOf(TypeError);
		expect(kept.settled).toBe(false);
		let pendingSeen;
		mod.pendingMutations.subscribe((n) => { pendingSeen = n; });
		expect(pendingSeen).toBe(1);
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


describe('connection observer failures', () => {
	it('rejected async hooks preserve their config receiver and allow replay', async () => {
		mod = await loadClient(true);
		const report = vi.fn();
		vi.stubGlobal('reportError', report);
		const error = new Error('async observer failed');
		const receivers = [];
		const config = {
			offline: { queue: true },
			async onConnect() { receivers.push(this); throw error; },
			async onDisconnect() { receivers.push(this); throw error; }
		};
		try {
			mod.configure(config);
			simulateStatus('disconnected');
			const pending = mod.__rpc('todos/add')('queued');
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'saved' }));
			await expect(pending).resolves.toBe('saved');
			expect(receivers).toEqual([config, config]);
			expect(report.mock.calls).toEqual([[error], [error]]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('throwing hooks preserve offline replay and the shared Svelte notification queue', async () => {
		mod = await loadClient(true);
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const hookError = new Error('observer failed');
		try {
			mod.configure({ offline: { queue: true }, onConnect() { throw hookError; }, onDisconnect() { throw hookError; } });
			const statuses = [];
			const unsubscribe = realStatusStore.subscribe((value) => statuses.push(value));
			const unrelated = writable(0);
			const values = [];
			const stop = unrelated.subscribe((value) => values.push(value));
			simulateStatus('disconnected');
			const pending = mod.__rpc('todos/add')('queued');
			simulateStatus('open');
			await flush();
			await respondAll(() => ({ ok: true, data: 'saved' }));
			await expect(pending).resolves.toBe('saved');
			unrelated.set(1);
			expect(statuses).toEqual(['open', 'disconnected', 'open']);
			expect(values).toEqual([0, 1]);
			expect(log).toHaveBeenCalledTimes(2);
			unsubscribe();
			stop();
		} finally {
			log.mockRestore();
		}
	});
});


describe('offline queue scope changes', () => {
	it('restores the new key and numbers new calls past its stored rows', async () => {
		const store = fakeStore(Object.fromEntries([seedEntry('B', 7, 'stored/B', [], 'b')]));
		const [old] = await goOfflineAndQueue({ persist: store, persistKey: 'A' }, [['queued/A', [1]]]);
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'B' } });
		await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		const fresh = mod.__rpc('new/B')(); fresh.catch(() => {});
		await flush();
		expect(storedKeys(store)).toEqual(['q:A:000000000001', 'q:B:000000000007', 'q:B:000000000008']);
		simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: 'ok' }));
		await expect(fresh).resolves.toBe('ok');
		expect(replayedPaths()).toEqual(['stored/B', 'new/B']);
		expect(storedKeys(store)).toEqual(['q:A:000000000001']);
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(8);
	});

	it('ignores an old restore that finishes after switching key and checkpoint', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('A', 90, 'stored/A', [], 'a'), seedEntry('B', 5, 'stored/B', [], 'b'),
			['c:A', { lastUploadedSeq: 99 }], ['c:B', { lastUploadedSeq: 7 }]
		]));
		const read = store.getAll.bind(store); let finish; const scanned = [];
		store.getAll = (prefix) => { scanned.push(prefix); return prefix === 'q:A:' ? new Promise(resolve => { finish = async () => resolve(await read(prefix)); }) : read(prefix); };
		const [old] = await goOfflineAndQueue({ persist: store, persistKey: 'A' }, [['waiting/A', []]]);
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'B' } });
		await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		const fresh = mod.__rpc('new/B')(); fresh.catch(() => {});
		await flush(); await finish(); await flush();
		expect(scanned).not.toContain('c:A');
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(7);
		expect(store.map.get('q:B:000000000008')?.path).toBe('new/B');
		simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: 'ok' }));
		expect(replayedPaths()).toEqual(['stored/B', 'new/B']);
	});

	it('allows a new scope to drain while a former scope RPC is in flight', async () => {
		const store = fakeStore(Object.fromEntries([seedEntry('B', 1, 'stored/B', [], 'b')]));
		const [first, second] = await goOfflineAndQueue({ persist: store, persistKey: 'A' }, [['old/first', []], ['old/second', []]]);
		simulateStatus('open'); await until(() => sentCalls().length === 1);
		const oldFrame = sentCalls()[0];
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'B' } });
		await expect(first).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		await expect(second).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		await until(() => sentCalls().length === 2);
		expect(replayedPaths()).toEqual(['old/first', 'stored/B']);
		simulateRpcResponse(oldFrame.id, { ok: true, data: 'old applied' }); await flush();
		expect(store.map.has('q:A:000000000001')).toBe(false);
		expect(store.map.has('q:B:000000000001')).toBe(true);
		expect(store.map.has('q:A:000000000002')).toBe(true);
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(0);
		simulateRpcResponse(sentCalls()[1].id, { ok: true, data: 'new applied' }); await flush();
		expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(1);
	});

	it('treats enabling persistence as a queue switch without seq collisions', async () => {
		const [old] = await goOfflineAndQueue({}, [['memory/old', []]]);
		const store = fakeStore(Object.fromEntries([seedEntry('default', 1, 'stored/new', [], 'new')]));
		mod.configure({ offline: { queue: true, persist: store } });
		await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		const current = mod.__rpc('queued/new')(); current.catch(() => {}); await flush();
		expect(store.map.get('q:default:000000000001')?.path).toBe('stored/new');
		expect(store.map.get('q:default:000000000002')?.path).toBe('queued/new');
		simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: null }));
		expect(replayedPaths()).toEqual(['stored/new', 'queued/new']);
	});

	it('retries a failed scan when configured again with the same store', async () => {
		const store = fakeStore(Object.fromEntries([seedEntry('default', 4, 'stored/retry', [], 'retry')]));
		const read = store.getAll.bind(store); let fails = true;
		store.getAll = async (prefix) => { if (fails) throw new Error('temporarily unavailable'); return read(prefix); };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const [old] = await goOfflineAndQueue({ persist: store }, [['memory/failed', []]]); await flush();
			fails = false; mod.configure({ offline: { queue: true, persist: store } });
			await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
			const current = mod.__rpc('queued/retry')(); current.catch(() => {}); await flush();
			expect(store.map.get('q:default:000000000005')?.path).toBe('queued/retry');
			simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: null }));
			expect(replayedPaths()).toEqual(['stored/retry', 'queued/retry']);
		} finally { warn.mockRestore(); }
	});

	it('changing only the store starts its own restore and retains old stored data', async () => {
		const oldStore = fakeStore(); const nextStore = fakeStore(Object.fromEntries([seedEntry('same', 9, 'next/stored', [], 'next')]));
		const [old] = await goOfflineAndQueue({ persist: oldStore, persistKey: 'same' }, [['old/store', []]]);
		mod.configure({ offline: { queue: true, persist: nextStore, persistKey: 'same' } });
		await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		await flush(); simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: null }));
		expect(replayedPaths()).toEqual(['next/stored']);
		expect(storedKeys(oldStore)).toEqual(['q:same:000000000001']);
	});
});


describe('offline scope re-entry', () => {
	it('waits for a prior lifetime write before scanning the same scope again', async () => {
		const store = fakeStore(); const put = store.put.bind(store); let finish;
		store.put = (key, value) => key === 'q:A:000000000001' && !finish
			? new Promise(resolve => { finish = async () => { await put(key, value); resolve(); }; }) : put(key, value);
		const [old] = await goOfflineAndQueue({ persist: store, persistKey: 'A' }, [['old/write', []]]);
		await until(() => !!finish);
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'B' } });
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'A' } });
		await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
		const fresh = mod.__rpc('new/write')(); fresh.catch(() => {});
		await finish(); await flush();
		expect(store.map.get('q:A:000000000001')?.path).toBe('old/write');
		expect(store.map.get('q:A:000000000002')?.path).toBe('new/write');
		simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: null }));
		expect(replayedPaths()).toEqual(['old/write', 'new/write']);
	});

	it('keeps queued callers when the same persistence configuration is repeated', async () => {
		const [queued] = await goOfflineAndQueue({ persist: true, persistKey: 'stable' }, [['same/config', []]]);
		mod.configure({ offline: { queue: true, persist: true, persistKey: 'stable' } });
		simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: 'ok' }));
		await expect(queued).resolves.toBe('ok');
	});
});


it('a late original-scope reply cannot regress its re-entered checkpoint', async () => {
	const store = fakeStore();
	const [old] = await goOfflineAndQueue({ persist: store, persistKey: 'A' }, [['old/checkpoint', []]]);
	simulateStatus('open'); await until(() => sentCalls().length === 1); const oldFrame = sentCalls()[0];
	mod.configure({ offline: { queue: true, persist: store, persistKey: 'B' } });
	await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
	store.map.set('q:A:000000000007', seedEntry('A', 7, 'new/checkpoint', [], 'new')[1]);
	mod.configure({ offline: { queue: true, persist: store, persistKey: 'A', replay: 'concurrent' } });
	await until(() => sentCalls().length >= 3);
	expect(replayedPaths()).toEqual(['old/checkpoint', 'old/checkpoint', 'new/checkpoint']);
	for (const frame of sentCalls().slice(1)) simulateRpcResponse(frame.id, { ok: true, data: null });
	await flush(); expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(7);
	simulateRpcResponse(oldFrame.id, { ok: true, data: 'late' }); await flush();
	expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(7);
	expect(store.map.get('c:A')?.lastUploadedSeq).toBe(7);
});


it('a pending-count callback queues into the new scope only after its restore', async () => {
	const store = fakeStore(Object.fromEntries([seedEntry('B', 5, 'B/stored', [], 'b')]));
	const [old] = await goOfflineAndQueue({ persist: store, persistKey: 'A' }, [['A/old', []]]);
	let armed = false, fresh;
	const stop = mod.pendingMutations.subscribe((count) => {
		if (armed && count === 0) { armed = false; fresh = mod.__rpc('B/from-count')(); fresh.catch(() => {}); }
	});
	armed = true; mod.configure({ offline: { queue: true, persist: store, persistKey: 'B' } });
	await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' }); await flush();
	expect(store.map.get('q:B:000000000006')?.path).toBe('B/from-count');
	stop(); simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: null }));
	await expect(fresh).resolves.toBeNull();
});

it('a beforeReplay scope switch cannot send old work or empty the new queue', async () => {
	const store = fakeStore(Object.fromEntries([seedEntry('B', 4, 'B/stored', [], 'b')]));
	const [old] = await goOfflineAndQueue({ persist: store, persistKey: 'A', beforeReplay() {
		mod.configure({ offline: { queue: true, persist: store, persistKey: 'B' } }); return true;
	} }, [['A/old', []]]);
	simulateStatus('open'); await flush();
	await expect(old).rejects.toMatchObject({ code: 'OFFLINE_SCOPE_CHANGED' });
	await respondAll(() => ({ ok: true, data: null }));
	expect(replayedPaths()).toEqual(['B/stored']);
	expect(mod.offlineCheckpoint().lastUploadedSeq).toBe(4);
});


describe('offline persistence health and isolated value reads', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
	});
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

	it('restores readable IndexedDB rows around a broken value and preserves every key across reloads', async () => {
		const brokenKey = seedEntry('default', 9, 'write', ['broken'], 'broken')[0];
		const idb = fakeIndexedDb({ unreadableKeys: new Set([brokenKey]) });
		for (const row of [seedEntry('default', 2, 'write', ['readable'], 'readable'), seedEntry('default', 9, 'write', ['broken'], 'broken')]) idb.map.set(...row);
		vi.stubGlobal('indexedDB', idb);
		mod.configure({ offline: { queue: true, persist: true } });
		simulateStatus('disconnected');
		const fresh = watch(mod.__rpc('write')('new'));
		await until(() => idb.map.has('q:default:000000000010'));
		expect(idb.map.get('q:default:000000000010').args).toEqual(['new']);
		expect(mod.offlinePersistence()).toEqual({ status: 'degraded', unreadableRows: 1, failedWrites: 0 });
		expect(idb.map.has(brokenKey)).toBe(true);
		mod = await loadClient();
		mod.configure({ offline: { queue: true, persist: true } });
		simulateStatus('disconnected');
		await until(() => mod.offlinePersistence().status !== 'restoring');
		simulateStatus('open');
		await until(() => wire.some(frame => frame.rpc));
		await respondAll(() => ({ ok: true, data: true }));
		await until(() => [...idb.map.keys()].filter(key => key.startsWith('q:')).length === 1);
		expect(wire.filter(frame => frame.rpc).map(frame => frame.args)).toEqual([['readable'], ['new']]);
		expect([...idb.map.keys()].filter(key => key.startsWith('q:'))).toEqual([brokenKey]);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 10, gapDetected: true });
		expect(mod.offlinePersistence().unreadableRows).toBe(1);
		expect(fresh.settled).toBe(false);
	});

	it('a failed key scan disables writes and exposes memory-only health', async () => {
		const store = fakeStore(Object.fromEntries([seedEntry('default', 8, 'write', ['stored'], 'stored')]));
		store.keys = async () => { throw new Error('key scan unavailable'); };
		store.get = async key => store.map.get(key);
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		watch(mod.__rpc('write')('memory'));
		await flush();
		expect(mod.offlinePersistence()).toEqual({ status: 'memory', unreadableRows: 0, failedWrites: 0 });
		expect(storedKeys(store)).toEqual(['q:default:000000000008']);
	});

	it('custom keys/get stores skip unreadable rows without calling a bulk value scan', async () => {
		const store = fakeStore(Object.fromEntries([seedEntry('default', 6, 'write', ['broken'], 'broken')]));
		store.keys = async prefix => [...store.map.keys()].filter(key => key.startsWith(prefix));
		store.get = async () => { throw new Error('bad value'); };
		const getAll = vi.spyOn(store, 'getAll');
		mod.configure({ offline: { queue: true, persist: store } });
		simulateStatus('disconnected');
		watch(mod.__rpc('write')('new'));
		await flush();
		expect(getAll).toHaveBeenCalledWith('c:default');
		expect(getAll).not.toHaveBeenCalledWith('q:default:');
		expect(storedKeys(store)).toEqual(['q:default:000000000006', 'q:default:000000000007']);
		expect(mod.offlinePersistence()).toMatchObject({ status: 'degraded', unreadableRows: 1 });
	});

	it('reports disabled, restoring, ready and failed-write health without exposing mutation data', async () => {
		expect(mod.offlinePersistence().status).toBe('disabled');
		const store = fakeStore();
		let finish;
		store.getAll = () => new Promise(resolve => { finish = resolve; });
		mod.configure({ offline: { queue: true, persist: store } });
		expect(mod.offlinePersistence().status).toBe('restoring');
		finish([]); await flush(1); finish([]); await flush(1);
		expect(mod.offlinePersistence().status).toBe('ready');
		store.put = async () => { throw new Error('quota'); };
		simulateStatus('disconnected'); watch(mod.__rpc('private/write')('private argument')); await flush();
		expect(mod.offlinePersistence()).toEqual({ status: 'degraded', unreadableRows: 0, failedWrites: 1 });
	});
});


it('keeps a mutation queued during beforeReplay when the callback disconnects', async () => {
	const store = fakeStore();
	let added;
	const [first] = await goOfflineAndQueue({ persist: store, beforeReplay() {
		if (!added) { simulateStatus('disconnected'); added = watch(mod.__rpc('during/filter')('new')); }
		return true;
	} }, [['before/filter', ['old']]]);
	simulateStatus('open'); await flush();
	expect(wire.filter(frame => frame.rpc)).toHaveLength(0);
	simulateStatus('open'); await flush();
	await respondAll(() => ({ ok: true, data: 'done' }));
	await expect(first).resolves.toBe('done');
	expect(added.value).toBe('done');
	expect(wire.filter(frame => frame.rpc).map(frame => frame.rpc)).toEqual(['before/filter', 'during/filter']);
	expect(storedKeys(store)).toEqual([]);
});

it('never replays a captured mutation evicted by a reentrant beforeReplay enqueue', async () => {
	const store = fakeStore();
	let added;
	const [first] = await goOfflineAndQueue({ persist: store, maxQueue: 1, beforeReplay() {
		if (!added) { simulateStatus('disconnected'); added = watch(mod.__rpc('during/filter')('replacement')); }
		return true;
	} }, [['before/filter', ['evicted']]]);
	const evicted = watch(first);
	simulateStatus('open'); await flush();
	expect(evicted.error).toMatchObject({ code: 'QUEUE_FULL' });
	simulateStatus('open'); await flush();
	await respondAll(() => ({ ok: true, data: 'done' }));
	expect(added.value).toBe('done');
	expect(wire.filter(frame => frame.rpc).map(frame => frame.rpc)).toEqual(['during/filter']);
});


describe('offline erasure and retention', () => {
	it('clears current queued callers and persisted checkpoint before a reload', async () => {
		const store = fakeStore({ 'c:default': { lastUploadedSeq: 7, gapDetected: true } });
		const [pending] = await goOfflineAndQueue({ persist: store }, [['private/write', ['secret']]]);
		const result = watch(pending);
		await mod.clearOffline(); await flush();
		expect(result.error).toMatchObject({ code: 'OFFLINE_CLEARED' });
		expect([...store.map]).toEqual([]);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 0, gapDetected: false });
		mod = await loadClient(); mod.configure({ offline: { queue: true, persist: store } }); await flush();
		simulateStatus('disconnected'); simulateStatus('open'); await flush();
		expect(wire.filter(frame => frame.rpc)).toEqual([]);
	});

	it('erases an inactive key without erasing sibling namespaces or the active queue', async () => {
		const store = fakeStore(Object.fromEntries([
			seedEntry('A', 1, 'write', ['erase'], 'erase'), seedEntry('A:child', 1, 'write', ['keep child'], 'child'),
			['c:A', { lastUploadedSeq: 1 }], ['c:A:child', { lastUploadedSeq: 3 }]
		]));
		const [pending] = await goOfflineAndQueue({ persist: store, persistKey: 'B' }, [['write', ['keep current']]]);
		const result = watch(pending);
		await mod.clearOffline({ persistKey: 'A' });
		expect(storedKeys(store)).toEqual(['q:A:child:000000000001', 'q:B:000000000001']);
		expect(store.map.get('c:A:child')).toEqual({ lastUploadedSeq: 3 });
		expect(store.map.has('c:A')).toBe(false);
		expect(result.settled).toBe(false);
	});

	it('waits for a pending write and preserves calls queued after clearing starts', async () => {
		const store = fakeStore(); const put = store.put;
		let finish;
		store.put = (key, value) => !finish && key.startsWith('q:') ? new Promise(resolve => { finish = () => resolve(put(key, value)); }) : put(key, value);
		const [old] = await goOfflineAndQueue({ persist: store }, [['write', ['old']]]);
		const result = watch(old); let cleared = false;
		const clearing = mod.clearOffline().then(() => { cleared = true; });
		const fresh = watch(mod.__rpc('write')('new')); await flush();
		expect(cleared).toBe(false);
		finish(); await clearing; await flush();
		expect(result.error.code).toBe('OFFLINE_CLEARED');
		expect(storedKeys(store)).toEqual(['q:default:000000000001']);
		expect(store.map.get('q:default:000000000001').args).toEqual(['new']);
		expect(fresh.settled).toBe(false);
	});

	it('a cleared in-flight response cannot recreate stored state', async () => {
		const store = fakeStore();
		const [pending] = await goOfflineAndQueue({ persist: store }, [['write', ['sent']]]);
		const result = watch(pending);
		simulateStatus('open'); await until(() => wire.some(frame => frame.rpc));
		const sent = wire.find(frame => frame.rpc);
		await mod.clearOffline(); await flush();
		expect(result.error.code).toBe('OFFLINE_CLEARED');
		simulateRpcResponse(sent.id, { ok: true, data: 'late' }); await flush();
		expect([...store.map]).toEqual([]);
		expect(mod.offlineCheckpoint()).toEqual({ lastUploadedSeq: 0, gapDetected: false });
	});

	it('rejects unverified erasure and keeps stored data visibly degraded', async () => {
		const store = fakeStore();
		await goOfflineAndQueue({ persist: store }, [['write', ['retained']]]);
		store.delete = async () => {};
		await expect(mod.clearOffline()).rejects.toMatchObject({ code: 'OFFLINE_CLEAR_FAILED' });
		await flush();
		expect(storedKeys(store)).toHaveLength(1);
		expect(mod.offlinePersistence().status).toBe('memory');
	});

	it('deletes expired rows on restore and numbers new rows past their reserved seq', async () => {
		const expired = seedEntry('default', 9, 'write', ['expired'], 'expired');
		expired[1].queuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
		const store = fakeStore(Object.fromEntries([expired, seedEntry('default', 2, 'write', ['valid'], 'valid')]));
		mod.configure({ offline: { queue: true, persist: store } }); simulateStatus('disconnected');
		watch(mod.__rpc('write')('new')); await flush();
		expect(storedKeys(store)).toEqual(['q:default:000000000002', 'q:default:000000000010']);
		expect(store.map.get('q:default:000000000010').expiresAt - store.map.get('q:default:000000000010').queuedAt).toBe(7 * 24 * 60 * 60 * 1000);
		simulateStatus('open'); await flush(); await respondAll(() => ({ ok: true, data: 'done' }));
		expect(wire.filter(frame => frame.rpc).map(frame => frame.args)).toEqual([['valid'], ['new']]);
	});

	it('applies a finite configured retention to newly stored mutations and validates it', async () => {
		const store = fakeStore();
		await goOfflineAndQueue({ persist: store, retentionMs: 12345 }, [['write', ['new']]]);
		const row = store.map.get('q:default:000000000001');
		expect(row.expiresAt - row.queuedAt).toBe(12345);
		for (const retentionMs of [0, -1, Infinity, NaN]) expect(() => mod.configure({ offline: { persist: store, retentionMs } })).toThrow(/retentionMs/);
	});

	it('clears memory-only queues and validates target keys', async () => {
		const [pending] = await goOfflineAndQueue({}, [['write', ['memory']]]);
		const result = watch(pending);
		await mod.clearOffline(); await flush();
		expect(result.error.code).toBe('OFFLINE_CLEARED');
		await expect(mod.clearOffline({ persistKey: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});


it('database open purges expired retired-account values without replaying them', async () => {
	const expired = seedEntry('retired', 3, 'private/old', ['expired secret'], 'expired');
	expired[1].queuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
	const valid = seedEntry('retired', 4, 'private/old', ['still retained'], 'valid');
	const unreadable = seedEntry('retired', 5, 'private/old', ['unreadable'], 'broken');
	const idb = fakeIndexedDb({ unreadableKeys: new Set([unreadable[0]]) });
	for (const row of [expired, valid, unreadable]) idb.map.set(...row);
	vi.stubGlobal('indexedDB', idb); vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		mod.configure({ offline: { queue: true, persist: true, persistKey: 'current' } });
		simulateStatus('disconnected'); await until(() => mod.offlinePersistence().status !== 'restoring');
		expect(idb.map.has(expired[0])).toBe(false);
		expect(idb.map.has(valid[0])).toBe(true);
		expect(idb.map.has(unreadable[0])).toBe(true);
		expect(mod.offlinePersistence()).toMatchObject({ status: 'degraded', unreadableRows: 1 });
		simulateStatus('open'); await flush();
		expect(wire.filter(frame => frame.rpc)).toEqual([]);
		await mod.clearOffline({ persistKey: 'retired' });
		expect([...idb.map]).toEqual([]);
		expect(mod.offlinePersistence().unreadableRows).toBe(0);
	} finally { warn.mockRestore(); vi.unstubAllGlobals(); }
});

it('an obsolete restore cannot resurrect rows after clearOffline resolves', async () => {
	const seed = seedEntry('default', 7, 'write', ['old'], 'old');
	const store = fakeStore(Object.fromEntries([seed])); const getAll = store.getAll;
	let finish;
	store.getAll = prefix => !finish && prefix.startsWith('q:') ? new Promise(resolve => { finish = () => resolve([{ key: seed[0], value: seed[1] }]); }) : getAll(prefix);
	mod.configure({ offline: { queue: true, persist: store } }); simulateStatus('disconnected');
	await mod.clearOffline(); finish(); await flush();
	expect([...store.map]).toEqual([]);
	simulateStatus('open'); await flush();
	expect(wire.filter(frame => frame.rpc)).toEqual([]);
});

it('expired persisted calls reject before replay even when the page stayed open', async () => {
	const store = fakeStore();
	const [pending] = await goOfflineAndQueue({ persist: store, retentionMs: 60000 }, [['write', ['expired']]]);
	const result = watch(pending); const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
	try {
		simulateStatus('open'); await flush();
		expect(result.error).toMatchObject({ code: 'STALE' });
		expect(wire.filter(frame => frame.rpc)).toEqual([]);
		expect(storedKeys(store)).toEqual([]);
	} finally { clock.mockRestore(); }
});

it('a failed built-in deletion never claims that offline erasure succeeded', async () => {
	const idb = fakeIndexedDb({ abortDeletes: true });
	vi.stubGlobal('indexedDB', idb); vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		await goOfflineAndQueue({ persist: true }, [['write', ['retained']]]);
		await until(() => idb.map.size > 0);
		await expect(mod.clearOffline()).rejects.toMatchObject({ code: 'OFFLINE_CLEAR_FAILED' });
		expect([...idb.map.values()].some(row => row.args?.[0] === 'retained')).toBe(true);
	} finally { warn.mockRestore(); vi.unstubAllGlobals(); }
});


it('open-time retention cannot wait forever for a stalled deletion', async () => {
	vi.useFakeTimers();
	const idb = fakeIndexedDb({ deleteHangs: true });
	const expired = seedEntry('retired', 1, 'write', ['old'], 'old'); expired[1].queuedAt -= 8 * 24 * 60 * 60 * 1000;
	idb.map.set(...expired);
	vi.stubGlobal('indexedDB', idb); vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		mod.configure({ offline: { queue: true, persist: true, persistKey: 'current' } });
		await vi.advanceTimersByTimeAsync(5100);
		expect(mod.offlinePersistence().status).toBe('degraded');
		expect(idb.map.has(expired[0])).toBe(true);
	} finally { warn.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it('a failed global key scan can reopen on a later configure retry', async () => {
	const bad = fakeIndexedDb({ readFails: true });
	vi.stubGlobal('indexedDB', bad); vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		mod.configure({ offline: { queue: true, persist: true } });
		await until(() => mod.offlinePersistence().status !== 'restoring');
		expect(mod.offlinePersistence().status).toBe('memory');
		const good = fakeIndexedDb(); vi.stubGlobal('indexedDB', good);
		mod.configure({ offline: { queue: true, persist: true } }); simulateStatus('disconnected');
		watch(mod.__rpc('write')('recovered')); await until(() => good.map.size > 0);
		expect([...good.map.values()].some(row => row.args?.[0] === 'recovered')).toBe(true);
		expect(mod.offlinePersistence().status).toBe('ready');
	} finally { warn.mockRestore(); vi.unstubAllGlobals(); }
});


it('expiry cleanup cannot reuse a sequence still owned by an older replay', async () => {
 const idb = fakeIndexedDb();
 vi.stubGlobal('indexedDB', idb); vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
 let clock;
 try {
  const [old] = await goOfflineAndQueue({ persist: true, persistKey: 'account', retentionMs: 60000 }, [['write', ['old']]]);
  watch(old);
  await until(() => idb.map.has('q:account:000000000001'));
  simulateStatus('open'); await until(() => wire.some(frame => frame.rpc));
  mod.configure({ offline: { queue: true, persistKey: 'other' } });
  await until(() => mod.offlinePersistence().status !== 'restoring');
  clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
  idb.db.close(); idb.db.onclose();
  mod.configure({ offline: { queue: true, persistKey: 'account' } });
  await until(() => mod.offlinePersistence().status !== 'restoring');
  expect(idb.map.has('q:account:000000000001')).toBe(false);
  simulateStatus('disconnected');
  watch(mod.__rpc('write')('new'));
  await until(() => [...idb.map.values()].some(value => value.args?.[0] === 'new'));
  expect([...idb.map.values()].some(value => value.args?.[0] === 'new')).toBe(true);
  expect(idb.map.get('q:account:000000000002')?.args).toEqual(['new']);
 } finally { clock?.mockRestore(); vi.unstubAllGlobals(); }
});


it('two store instances cannot erase a fresh replacement using a stale expiry read', async () => {
 const expired = seedEntry('account', 1, 'write', ['expired'], 'old');
 expired[1].queuedAt -= 8 * 24 * 60 * 60 * 1000;
 let releaseRead, announceRead;
 const readStarted = new Promise(resolve => { announceRead = resolve; });
 const idb = fakeIndexedDb({ afterGet(key, mode) {
  if (mode === 'readonly' && key === expired[0] && !releaseRead) {
   announceRead(); return new Promise(resolve => { releaseRead = resolve; });
  }
 } });
 idb.map.set(...expired);
 vi.stubGlobal('indexedDB', idb); vi.stubGlobal('IDBKeyRange', { bound: (lower, upper) => ({ lower, upper }) });
 try {
  const first = mod.createIndexedDbStore(); const second = mod.createIndexedDbStore();
  const opening = first.keys('q:account:');
  await Promise.race([opening, readStarted]);
  const fresh = seedEntry('account', 1, 'write', ['fresh'], 'new')[1];
  await second.put(expired[0], fresh);
  releaseRead?.(); await opening;
  expect(idb.map.get(expired[0])?.args).toEqual(['fresh']);
 } finally { releaseRead?.(); vi.unstubAllGlobals(); }
});
