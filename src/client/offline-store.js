// Durable persistence seam for the offline mutation queue: a tiny async
// key-value contract with an IndexedDB implementation (the browser's
// persistent structured storage - the only thing that survives a reload) and
// an in-memory fallback (SSR, node tests, storage-denied browsers). The queue
// logic in misc.js/rpc.js talks ONLY to the contract, so tests inject a fake
// with zero DOM dependencies and the determinism guard sees no raw
// clock/timer/random usage (ids and stamps come from the caller).
//
// Failure posture: persistence is an UPGRADE to the in-memory queue, never a
// dependency. Every method swallows storage errors after a one-time dev warn
// - a broken/blocked IndexedDB (private windows, storage pressure, corrupted
// profiles) must degrade to exactly the pre-persistence behavior, not break
// the queue.

import { _IS_DEV } from './internal-state.js';

const DB_NAME = 'svelte-realtime';
const STORE_NAME = 'offline';

let _storageWarned = false;
function _warnStorage(err) {
	if (_IS_DEV && !_storageWarned) {
		_storageWarned = true;
		console.warn(
			'[svelte-realtime] offline persistence unavailable; the queue continues in-memory only (mutations will not survive a reload). Cause: ' +
			(err && err.message ? err.message : String(err))
		);
	}
}

/**
 * @typedef {Object} OfflineStore
 * @property {(prefix: string) => Promise<Array<{ key: string, value: any }>>} getAll - Every entry whose key starts with `prefix`, key-sorted.
 * @property {(key: string, value: any) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 * @property {(prefix: string) => Promise<void>} clear - Delete every entry whose key starts with `prefix`.
 */

/**
 * In-memory store: the SSR / node / fallback implementation. Same contract,
 * process lifetime only.
 * @returns {OfflineStore}
 */
export function createMemoryStore() {
	const map = new Map();
	return {
		async getAll(prefix) {
			const out = [];
			for (const [key, value] of map) {
				if (key.startsWith(prefix)) out.push({ key, value });
			}
			out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
			return out;
		},
		async put(key, value) {
			map.set(key, value);
		},
		async delete(key) {
			map.delete(key);
		},
		async clear(prefix) {
			for (const key of [...map.keys()]) {
				if (key.startsWith(prefix)) map.delete(key);
			}
		}
	};
}

/**
 * IndexedDB store. Opens the database lazily on first use (never at module
 * load - SSR imports this file). All failures degrade to no-ops after the
 * one-time dev warn.
 * @returns {OfflineStore}
 */
export function createIndexedDbStore() {
	/** @type {Promise<IDBDatabase | null> | null} */
	let dbPromise = null;

	function open() {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise((resolve) => {
			try {
				const req = indexedDB.open(DB_NAME, 1);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => { _warnStorage(req.error); resolve(null); };
				req.onblocked = () => { _warnStorage(new Error('open blocked')); resolve(null); };
			} catch (err) {
				_warnStorage(err);
				resolve(null);
			}
		});
		return dbPromise;
	}

	/**
	 * Run one operation on the object store; resolves `fallback` on any failure.
	 * @param {IDBTransactionMode} mode
	 * @param {(store: IDBObjectStore) => IDBRequest} fn
	 * @param {any} fallback
	 */
	async function run(mode, fn, fallback) {
		const db = await open();
		if (!db) return fallback;
		return new Promise((resolve) => {
			try {
				const tx = db.transaction(STORE_NAME, mode);
				const req = fn(tx.objectStore(STORE_NAME));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => { _warnStorage(req.error); resolve(fallback); };
			} catch (err) {
				_warnStorage(err);
				resolve(fallback);
			}
		});
	}

	return {
		async getAll(prefix) {
			// Key-range scan over the prefix: [prefix, prefix + U+FFFF]. Keys are
			// ASCII-constructed by the queue, so the sentinel upper bound is safe.
			const db = await open();
			if (!db) return [];
			return new Promise((resolve) => {
				try {
					const tx = db.transaction(STORE_NAME, 'readonly');
					const store = tx.objectStore(STORE_NAME);
					const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
					const out = [];
					const req = store.openCursor(range);
					req.onsuccess = () => {
						const cursor = req.result;
						if (cursor) {
							out.push({ key: String(cursor.key), value: cursor.value });
							cursor.continue();
						} else {
							resolve(out);
						}
					};
					req.onerror = () => { _warnStorage(req.error); resolve([]); };
				} catch (err) {
					_warnStorage(err);
					resolve([]);
				}
			});
		},
		async put(key, value) {
			await run('readwrite', (store) => store.put(value, key), undefined);
		},
		async delete(key) {
			await run('readwrite', (store) => store.delete(key), undefined);
		},
		async clear(prefix) {
			const db = await open();
			if (!db) return;
			await new Promise((resolve) => {
				try {
					const tx = db.transaction(STORE_NAME, 'readwrite');
					const store = tx.objectStore(STORE_NAME);
					const req = store.delete(IDBKeyRange.bound(prefix, prefix + '\uffff'));
					req.onsuccess = () => resolve(undefined);
					req.onerror = () => { _warnStorage(req.error); resolve(undefined); };
				} catch (err) {
					_warnStorage(err);
					resolve(undefined);
				}
			});
		}
	};
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
