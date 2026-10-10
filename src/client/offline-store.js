// Durable persistence seam for the offline mutation queue: a tiny async
// key-value contract with an IndexedDB implementation (the browser's
// persistent structured storage - the only thing that survives a reload) and
// an in-memory fallback (SSR, node tests, storage-denied browsers). The queue
// logic in misc.js/rpc.js talks ONLY to the contract, so tests inject a fake
// with zero DOM dependencies and the determinism guard sees no raw
// clock/timer/random usage (ids and stamps come from the caller).
//
// Failure posture: persistence is an UPGRADE to the in-memory queue, never a
// dependency. A broken/blocked IndexedDB (private windows, storage pressure,
// corrupted profiles) degrades to exactly the pre-persistence behavior after
// a per-operation dev warning instead of breaking the queue: deletes swallow storage
// errors, `put` rejects when nothing was stored, so the queue knows which
// mutations exist only in memory, and `getAll` rejects when it could not
// read, so the queue never writes over rows it has not seen.

import { _IS_DEV } from './internal-state.js';
import { setTimer, clearTimer, now } from '../client-runtime.js';

const DB_NAME = 'svelte-realtime';
const STORE_NAME = 'offline';

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Recognize expiry without inventing an age for a row with no timestamp. */
export function _offlineExpiry(value, retentionMs) {
	const queuedAt = Number.isFinite(value?.queuedAt) ? value.queuedAt : Infinity;
	const storedExpiry = Number.isFinite(value?.expiresAt) ? value.expiresAt : queuedAt + DEFAULT_RETENTION_MS;
	return retentionMs === undefined ? storedExpiry : Math.min(storedExpiry, queuedAt + retentionMs);
}

const STORAGE_TIMEOUT_MS = 5000;
const _storeHealth = new WeakMap();
export function _offlineStoreHealth(store) { return _storeHealth.get(store); }
export function _markOfflineRowsErased(store, keys) {
	const health = _storeHealth.get(store);
	if (health) for (const key of keys) health.unreadable.delete(key);
}
const _storageWarned = new Set();
function _warnStorage(err, operation) {
	if (_IS_DEV && !_storageWarned.has(operation)) {
		_storageWarned.add(operation);
		const consequence = operation === 'write'
			? 'the mutation was not stored and will not survive a reload'
			: operation === 'delete' || operation === 'clear'
				? 'stored mutations may remain and replay after a reload'
				: 'stored mutations could not be read';
		console.warn('[svelte-realtime] offline persistence ' + operation + ' failed; ' + consequence + '. Cause: ' +
			(err && err.message ? err.message : err == null ? 'operation aborted' : String(err)));
	}
}

/**
 * @typedef {Object} OfflineStore
 * @property {(prefix: string) => Promise<Array<{ key: string, value: any }>>} getAll - Every entry whose key starts with `prefix`, key-sorted. Rejects when the entries could not be read.
 * @property {(prefix: string) => Promise<string[]>} [keys] - Optional keys-only scan; pair with get to isolate unreadable values.
 * @property {(key: string) => Promise<any>} [get] - Optional single-value read; rejects when the value cannot be read.
 * @property {(key: string, value: any) => Promise<void>} put - Resolves once the value is stored, rejects when it could not be.
 * @property {(key: string, options: { now: number, retentionMs: number }) => Promise<boolean>} [deleteExpired] - Atomically delete only if the current value is expired; rejects unconfirmed deletion.
 * @property {(key: string) => Promise<void>} delete
 * @property {(prefix: string) => Promise<void>} clear - Delete every entry whose key starts with `prefix`.
 */

/** Stores that keep nothing past the page: a write to one stores nothing durable. */
const _memoryStores = new WeakSet();

/**
 * @internal Whether a successful write to `store` outlives the page.
 * @param {OfflineStore} store
 * @returns {boolean}
 */
export function _isDurableStore(store) {
	return !_memoryStores.has(store);
}

/**
 * In-memory store: the SSR / node / fallback implementation. Same contract,
 * process lifetime only.
 * @returns {OfflineStore}
 */
export function createMemoryStore() {
	const map = new Map();
	const store = {
		async getAll(prefix) {
			const out = [];
			for (const [key, value] of map) {
				if (key.startsWith(prefix)) out.push({ key, value });
			}
			out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
			return out;
		},
		async keys(prefix) { return [...map.keys()].filter(key => key.startsWith(prefix)).sort(); },
		async get(key) { return map.get(key); },
		async put(key, value) {
			map.set(key, value);
		},
		async delete(key) {
			map.delete(key);
		},
		async deleteExpired(key, options) {
			if (_offlineExpiry(map.get(key), options.retentionMs) > options.now) return false;
			return map.delete(key);
		},
		async clear(prefix) {
			for (const key of [...map.keys()]) {
				if (key.startsWith(prefix)) map.delete(key);
			}
		}
	};
	_memoryStores.add(store);
	return store;
}

/**
 * IndexedDB store. Opens the database lazily on first use (never at module
 * load - SSR imports this file). Failures degrade to no-ops after the
 * per-operation dev warning, except that `put` rejects when nothing was stored and
 * `getAll` rejects when a read failed.
 * @returns {OfflineStore}
 */
export function createIndexedDbStore() {
	/** @type {Promise<IDBDatabase | null> | null} */
	let dbPromise = null;
	let cleanupPromise = null;
	const health = { unreadable: new Set(), failedErasure: false };

	function open() {
		if (dbPromise) return dbPromise;
		/** @type {Promise<IDBDatabase | null>} */
		const pending = new Promise((resolve) => {
			let settled = false;
			const finish = (db, err) => {
				if (settled) { if (db) db.close(); return; }
				settled = true;
				clearTimer(timer);
				if (err) _warnStorage(err, 'open');
				resolve(db);
			};
			const timer = setTimer(() => finish(null, new Error('database open timed out')), STORAGE_TIMEOUT_MS);
			try {
				const req = indexedDB.open(DB_NAME, 1);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
				};
				req.onsuccess = () => {
					const db = req.result;
					if (settled) { db.close(); return; }
					db.onclose = () => { if (dbPromise === pending) dbPromise = null; };
					db.onversionchange = () => {
						if (dbPromise === pending) dbPromise = null;
						db.close();
					};
					cleanupPromise = purgeExpired(db).catch(err => {
						if (dbPromise === pending) { dbPromise = null; db.close(); }
						throw err;
					});
					finish(db);
				};
				req.onerror = () => finish(null, req.error || new Error('database open failed'));
				req.onblocked = () => finish(null, new Error('database open blocked'));
			} catch (err) {
				finish(null, err);
			}
		});
		dbPromise = pending;
		void pending.then((db) => { if (!db && dbPromise === pending) dbPromise = null; });
		return pending;
	}

	/**
	 * One read-write transaction. Resolves once it commits and rejects when
	 * the database cannot open or the transaction aborts: a request can
	 * succeed and its transaction still abort after it (a full quota does).
	 * @param {(store: IDBObjectStore) => void} fn
	 * @returns {Promise<void>}
	 */
	async function commit(fn, operation) {
		const db = await open();
		if (!db) throw new Error('[svelte-realtime] offline persistence unavailable');
		await cleanupPromise;
		return commitDb(db, fn, operation);
	}
	async function commitDb(db, fn, operation) {
		await new Promise((resolve, reject) => {
			let settled = false;
			let tx;
			const fail = err => {
				if (settled) return;
				settled = true; clearTimer(timer);
				_warnStorage(err, operation);
				reject(err || new Error('[svelte-realtime] offline store write aborted'));
			};
			const timer = setTimer(() => {
				fail(new Error('database write timed out'));
				try { tx?.abort(); } catch {}
			}, STORAGE_TIMEOUT_MS);
			try {
				tx = db.transaction(STORE_NAME, 'readwrite');
				fn(tx.objectStore(STORE_NAME), tx);
				tx.oncomplete = () => {
					if (settled) return;
					settled = true; clearTimer(timer); resolve(undefined);
				};
				tx.onabort = () => fail(tx.error);
			} catch (err) { fail(err); }
		});
	}

	async function read(prefix, keysOnly = false, exact = false) {
		// Key-range scan over the prefix: [prefix, prefix + U+FFFF]. Keys are
		// ASCII-constructed by the queue, so the sentinel upper bound is safe.
		// An unavailable database is an unreadable queue, not an empty one:
		// a later reopen must never overwrite rows this scan did not see.
		const db = await open();
		if (!db) throw new Error('[svelte-realtime] offline persistence unavailable');
		await cleanupPromise;
		return readDb(db, prefix, keysOnly, exact);
	}
	async function readDb(db, prefix, keysOnly = false, exact = false) {
		return new Promise((resolve, reject) => {
			let settled = false;
			let tx;
			const fail = (err) => {
				if (settled) return;
				settled = true;
				clearTimer(timer);
				if (exact && /^q:.+:\d{12}$/.test(prefix)) health.unreadable.add(prefix);
				_warnStorage(err, 'read');
				reject(err || new Error('[svelte-realtime] offline store read failed'));
			};
			const timer = setTimer(() => {
				fail(new Error('database read timed out'));
				try { tx?.abort(); } catch {}
			}, STORAGE_TIMEOUT_MS);
			try {
				tx = db.transaction(STORE_NAME, 'readonly');
				const store = tx.objectStore(STORE_NAME);
				const range = exact ? null : IDBKeyRange.bound(prefix, prefix + '\uffff');
				const out = [];
				const req = exact ? store.get(prefix) : keysOnly ? store.openKeyCursor(range) : store.openCursor(range);
				req.onsuccess = () => {
					if (settled) return;
					try {
						const result = req.result;
						if (exact) {
							health.unreadable.delete(prefix);
							settled = true; clearTimer(timer); resolve(result); return;
						}
						const cursor = result;
						if (cursor) {
							out.push(keysOnly ? String(cursor.key) : { key: String(cursor.key), value: cursor.value });
							cursor.continue();
						} else {
							settled = true;
							clearTimer(timer);
							resolve(out);
						}
					} catch (err) { fail(err); }
				};
				req.onerror = () => fail(req.error);
				tx.onabort = () => fail(tx.error);
			} catch (err) {
				fail(err);
			}
		});
	}
	async function deleteExpiredDb(db, key, at, retentionMs) {
		let removed = false;
		await commitDb(db, (store, tx) => {
			// The read and conditional deletion share one transaction, so another
			// tab cannot replace the row between its expiry check and deletion.
			const req = store.get(key);
			req.onerror = () => { health.unreadable.add(key); try { tx.abort(); } catch {} };
			req.onsuccess = () => {
				let expiry;
				try { expiry = _offlineExpiry(req.result, retentionMs); }
				catch { health.unreadable.add(key); try { tx.abort(); } catch {} return; }
				health.unreadable.delete(key);
				if (expiry <= at) {
					try { store.delete(key); removed = true; }
					catch { health.failedErasure = true; try { tx.abort(); } catch {} }
				}
			};
		}, 'delete');
		return removed;
	}

	async function purgeExpired(db) {
		health.unreadable.clear();
		health.failedErasure = false;
		try {
			const keys = await readDb(db, 'q:', true);
			const at = now();
			for (let i = 0; i < keys.length; i += 10) {
				await Promise.all(keys.slice(i, i + 10).map(async key => {
					if (!/^q:.+:\d{12}$/.test(key) || Number(key.slice(-12)) === 0) return;
					try { await deleteExpiredDb(db, key, at, undefined); }
					catch { if (!health.unreadable.has(key)) health.failedErasure = true; }
				}));
			}
		} catch (err) { health.failedErasure = true; throw err; }
	}
	const store = {
		getAll(prefix) { return read(prefix); },
		keys(prefix) { return read(prefix, true); },
		get(key) { return read(key, false, true); },
		async deleteExpired(key, options) {
			const db = await open();
			if (!db) throw new Error('[svelte-realtime] offline persistence unavailable');
			await cleanupPromise;
			return deleteExpiredDb(db, key, options.now, options.retentionMs);
		},
		async put(key, value) {
			await commit((store) => { store.put(value, key); }, 'write');
		},
		async delete(key) {
			// Settled once committed or failed; a failure is swallowed.
			await commit((store) => { store.delete(key); }, 'delete').catch(() => {});
		},
		async clear(prefix) {
			await commit((store) => { store.delete(IDBKeyRange.bound(prefix, prefix + '\uffff')); }, 'clear').catch(() => {});
		}
	};
	_storeHealth.set(store, health);
	return store;
}

/**
 * Resolve the configured `offline.persist` option to a store instance:
 * `true` picks IndexedDB when the environment has it (browser) and the
 * in-memory fallback otherwise (SSR renders import client modules; node
 * tests); a custom object is duck-typed as the store itself.
 * @param {boolean | OfflineStore} persist
 * @returns {OfflineStore}
 */
export function resolveOfflineStore(persist) {
	if (persist !== true) {
		if (!persist || typeof persist.getAll !== 'function' || typeof persist.put !== 'function' || typeof persist.delete !== 'function') {
			throw new Error('[svelte-realtime] offline.persist must be true or a store with getAll/put/delete/clear');
		}
		return persist;
	}
	return typeof indexedDB !== 'undefined' ? createIndexedDbStore() : createMemoryStore();
}
