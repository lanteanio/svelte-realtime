// @ts-check
//
// Offline-queue durability + consumer surface: persistence write-through
// (IndexedDB behind the offline-store seam), the per-queue upload checkpoint,
// and the two reactive consumer stores (`pendingMutations`, `uploading`).
// The queue ARRAY stays `_offlineQueue` in internal-state.js (rpc.js enqueues,
// misc.js drains); this module owns everything that makes it durable and
// observable. Persistence is opt-in (`configure({ offline: { persist } })`)
// and always an upgrade: every storage call is fire-and-forget best-effort,
// so a broken store degrades to exactly the in-memory behavior.

import { writable } from 'svelte/store';
import { randomUuid } from '../client-runtime.js';
import { _offlineQueue, RpcError, _IS_DEV } from './internal-state.js';
import { resolveOfflineStore, _isDurableStore } from './offline-store.js';

/** @type {import('./offline-store.js').OfflineStore | null} */
let _store = null;
/** @type {string} */
let _persistKey = 'default';
/** Monotone per-queue sequence; restored entries advance it past their max. */
let _seq = 0;
/** @type {{ lastUploadedSeq: number, gapDetected: boolean }} */
let _checkpoint = { lastUploadedSeq: 0, gapDetected: false };
/** @type {Promise<void> | null} Resolves when the one-shot rehydrate finished (null = persistence off). */
let _rehydratePromise = null;
/** True while the restore runs (the queue scan, then the checkpoint read). */
let _restoring = false;
/**
 * Entries queued while the restore runs, waiting for a seq.
 * @type {Array<{ entry: any, resolve: (stored: boolean | Promise<boolean> | undefined) => void }>}
 */
let _unstamped = [];
/** The stored queue could not be read, so the store is not used again in this page. */
let _scanFailed = false;
/**
 * The upload batch in progress (see `_batchState`). Stored with the
 * checkpoint, outside what `offlineCheckpoint()` returns.
 * @type {{ failedSeq: number, clean: boolean }}
 */
let _batch = { failedSeq: Infinity, clean: true };
/** A full queue dropped a call queued during the restore, before it had a seq. */
let _droppedUnnumbered = false;

const _pendingStore = writable(0);
const _uploadingStore = writable(false);

/**
 * Live count of queued offline mutations (enqueue, settle, and restore all
 * move it). The consumer surface for "N pending edits" indicators.
 * @type {{ subscribe: (fn: (n: number) => void) => () => void }}
 */
export const pendingMutations = { subscribe: _pendingStore.subscribe };

/**
 * True while a reconnect drain is replaying the queue - the UI backpressure
 * signal ("pause local writes while the upload pipe is busy").
 * @type {{ subscribe: (fn: (v: boolean) => void) => () => void }}
 */
export const uploading = { subscribe: _uploadingStore.subscribe };

/** @internal Recompute the pending count from the live queue. */
export function _bumpPending() {
	_pendingStore.set(_offlineQueue.length);
}

/** @internal @param {boolean} v */
export function _setUploading(v) {
	_uploadingStore.set(v);
}

function _entryKey(seq) {
	// Zero-padded so string key order == numeric seq order (the store scans
	// key ranges; IndexedDB compares keys lexicographically).
	return 'q:' + _persistKey + ':' + String(seq).padStart(12, '0');
}

function _checkpointKey() {
	return 'c:' + _persistKey;
}

/**
 * A seq the queue could have written: a positive integer that fits the
 * 12-digit key. Anything else in a stored row or checkpoint is corrupt.
 * @param {unknown} seq
 * @returns {seq is number}
 */
function _validSeq(seq) {
	return Number.isInteger(seq) && /** @type {number} */ (seq) > 0 && /** @type {number} */ (seq) < 1e12;
}

/**
 * What a store's `getAll` answered, as rows; anything but an array counts as
 * a read that failed.
 * @param {unknown} rows
 * @returns {any[]}
 */
function _rowsOf(rows) {
	if (!Array.isArray(rows)) throw new Error('[svelte-realtime] offline store getAll did not return an array');
	return rows;
}

/**
 * The seq a row key was written under (`q:<persistKey>:<12 digits>`), or 0.
 * @param {unknown} key
 * @returns {number}
 */
function _seqFromKey(key) {
	const m = /:(\d{12})$/.exec(String(key));
	return m ? Number(m[1]) : 0;
}

/**
 * One call to the store. A custom store that throws instead of returning a
 * rejected promise is treated the same, so a storage failure never escapes
 * into the queue logic around it.
 * @param {() => any} call
 * @returns {Promise<any>}
 */
function _storeCall(call) {
	return new Promise((resolve) => resolve(call()));
}

/**
 * The current upload checkpoint for the configured queue:
 * `lastUploadedSeq` is the highest enqueue seq that replayed successfully;
 * `gapDetected` is true when a mutation went up while one queued before it
 * failed (a hole in the upload order - the app may want a refetch), clearing
 * on the next fully-clean drain.
 * @returns {{ lastUploadedSeq: number, gapDetected: boolean }}
 */
export function offlineCheckpoint() {
	return { ..._checkpoint };
}

/**
 * @internal Configure persistence from `configure({ offline })`. Called by
 * misc.js. The restore runs once, for the scope configured first; a later
 * persistKey or store applies to writes from then on, with nothing restored
 * for it, and entries already in memory keep replaying regardless.
 * @param {any} offlineOpts
 */
export function _configureOfflinePersistence(offlineOpts) {
	if (!offlineOpts) return;
	if (offlineOpts.persistKey !== undefined && (typeof offlineOpts.persistKey !== 'string' || offlineOpts.persistKey.length === 0)) {
		throw new Error('[svelte-realtime] offline.persistKey must be a non-empty string');
	}
	if (!offlineOpts.persist) return;
	const store = resolveOfflineStore(offlineOpts.persist);
	if (_scanFailed) return;
	_store = store;
	_persistKey = offlineOpts.persistKey ?? 'default';
	if (!_rehydratePromise) {
		_restoring = true;
		_rehydratePromise = _rehydrate().catch(() => {});
	}
}

/**
 * One-shot rehydrate: restore persisted entries into the FRONT of the
 * in-memory queue in seq order, restore the seq counter past their max, and
 * load the checkpoint. Restored entries have no promise holders (the page
 * reloaded), so their settle surfaces only through onReplayError/onConflict.
 * Entries queued meanwhile get their seq and their write once the counter is
 * past the stored rows, before the promise a drain awaits resolves.
 */
async function _rehydrate() {
	let read = false;
	try {
		if (!_store) return;
		const stored = Promise.resolve(_isDurableStore(_store));
		const rows = _rowsOf(await _store.getAll('q:' + _persistKey + ':'));
		/** @type {any[]} */
		const restored = [];
		for (const row of rows) {
			const value = row && row.value;
			if (!value || typeof value.path !== 'string' || !Array.isArray(value.args)) continue;
			// The row key carries the seq the row was written under.
			const seq = _validSeq(value.seq) ? value.seq : _seqFromKey(row.key);
			restored.push({
				path: value.path,
				args: value.args,
				queuedAt: typeof value.queuedAt === 'number' ? value.queuedAt : 0,
				resolve: () => {},
				reject: () => {},
				idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined,
				timeout: typeof value.timeout === 'number' ? value.timeout : undefined,
				seq,
				restored: true,
				stored
			});
			if (seq > _seq) _seq = seq;
		}
		if (restored.length > 0) {
			restored.sort((a, b) => a.seq - b.seq);
			_offlineQueue.unshift(...restored);
			_bumpPending();
		}
		const cp = _rowsOf(await _store.getAll(_checkpointKey()));
		for (const row of cp) {
			const value = row && row.value;
			if (row && row.key === _checkpointKey() && value && (value.lastUploadedSeq === 0 || _validSeq(value.lastUploadedSeq))) {
				_checkpoint = { lastUploadedSeq: value.lastUploadedSeq, gapDetected: !!value.gapDetected };
				_batch = {
					failedSeq: value.batchFailedSeq === 0 || _validSeq(value.batchFailedSeq) ? value.batchFailedSeq : Infinity,
					clean: value.batchClean !== false
				};
			}
		}
		// No new seq at or below one that already went up, also once its row
		// is gone: a failure there would read as a hole in the upload order.
		if (_checkpoint.lastUploadedSeq > _seq) _seq = _checkpoint.lastUploadedSeq;
		read = true;
	} finally {
		if (_store && !read) {
			// What is stored could not be read in full, so any seq could be a
			// stored row's and the stored checkpoint is unknown: writing,
			// deleting or checkpointing could destroy what nobody has seen. The
			// queue goes on in memory only.
			_scanFailed = true;
			_store = null;
			if (_IS_DEV) console.warn('[svelte-realtime] offline persistence unavailable: the stored queue could not be read, so queued mutations stay in memory for this page (they will not survive a reload).');
		}
		// The entries queued during the restore get their seq and their write,
		// in the order they were queued; one settled meanwhile (dropped by a
		// full queue) is never written, and counts as failing just above the
		// restored calls.
		if (_droppedUnnumbered) {
			_droppedUnnumbered = false;
			if (_seq < _batch.failedSeq) _batch.failedSeq = _seq;
		}
		_restoring = false;
		const waiting = _unstamped;
		_unstamped = [];
		for (const { entry, resolve } of waiting) {
			resolve(entry.settled ? false : _stamp(entry));
		}
	}
}

/**
 * @internal Await the one-shot rehydrate (no-op when persistence is off), so
 * a reconnect drain never races the restore and replays a half-loaded queue.
 */
export function _offlineReady() {
	return _rehydratePromise || Promise.resolve();
}

/**
 * @internal Stamp durability fields onto a freshly-enqueued entry and
 * write it through: a monotone seq, a synthesized idempotency key when the
 * caller supplied none (so a replay after reload ALWAYS dedups server-side -
 * a mutation that reached the server before the crash answers with its
 * original result instead of applying twice), and the persisted copy.
 * Called by rpc.js right after the queue push. `entry.stored` settles to
 * whether the write left a copy that outlives the page. While the restore
 * runs, the seq and the write wait for it: the next free seq is not known
 * until the stored rows are read, and a seq one of them holds would make the
 * write overwrite it.
 * @param {any} entry
 */
export function _enqueuePersist(entry) {
	if (entry.idempotencyKey === undefined || entry.idempotencyKey === null) {
		entry.idempotencyKey = 'off-' + randomUuid();
	}
	if (_restoring) {
		entry.stored = new Promise((resolve) => { _unstamped.push({ entry, resolve }); });
	} else {
		const stored = _stamp(entry);
		if (stored) entry.stored = stored;
	}
	_bumpPending();
}

/**
 * Stamp the entry's seq and write it through when persistence is on.
 * @param {any} entry
 * @returns {Promise<boolean> | undefined} Whether the write left a copy that outlives the page.
 */
function _stamp(entry) {
	entry.seq = ++_seq;
	if (!_store) return undefined;
	const store = _store;
	const durable = _isDurableStore(store);
	const value = {
		seq: entry.seq,
		path: entry.path,
		args: entry.args,
		queuedAt: entry.queuedAt,
		idempotencyKey: entry.idempotencyKey,
		timeout: entry.timeout
	};
	return _storeCall(() => store.put(_entryKey(entry.seq), value))
		.then(() => durable, () => false);
}

/**
 * @internal Settle one entry's durability: drop the persisted copy and, on a
 * successful replay, advance (and persist) the checkpoint. The gap opens
 * when the upload order gets a hole: a success with `hadEarlierFailure` (an
 * entry queued before it failed), or a failure below a seq that already
 * went up.
 * @param {any} entry
 * @param {boolean} success
 * @param {boolean} [hadEarlierFailure]
 */
export function _settlePersist(entry, success, hadEarlierFailure) {
	entry.settled = true;
	if (_store && typeof entry.seq === 'number' && entry.seq > 0) {
		const store = _store;
		void _storeCall(() => store.delete(_entryKey(entry.seq))).catch(() => {});
	}
	if (typeof entry.seq !== 'number') return;
	if (success) {
		if (entry.seq > _checkpoint.lastUploadedSeq) _checkpoint.lastUploadedSeq = entry.seq;
		if (hadEarlierFailure) _checkpoint.gapDetected = true;
		_putCheckpoint();
	} else if (entry.seq < _checkpoint.lastUploadedSeq && !_checkpoint.gapDetected) {
		_checkpoint.gapDetected = true;
		_putCheckpoint();
	}
}

/**
 * @internal Drop the oldest queued entries until at most `max` are left, each
 * rejected with QUEUE_FULL and its stored copy deleted. The caller refreshes
 * the pending count.
 * @param {number} max
 */
export function _trimQueue(max) {
	let dropped = false;
	while (_offlineQueue.length > Math.max(max, 0)) {
		const entry = _offlineQueue.shift();
		dropped = true;
		entry.reject(new RpcError('QUEUE_FULL', 'Offline queue overflow - oldest mutation dropped'));
		_settlePersist(entry, false);
		// What is queued after it goes up later: holes in the batch's order.
		if (typeof entry.seq === 'number') {
			if (entry.seq < _batch.failedSeq) _batch.failedSeq = entry.seq;
		} else {
			// Queued during the restore: numbered, it would have come right
			// after the restored calls and below every call queued after it.
			_droppedUnnumbered = true;
		}
	}
	if (dropped) _putCheckpoint();
}

/**
 * @internal The upload batch the queue is in: the lowest seq that failed in
 * it (Infinity for none) and whether it is still clean. A drain the
 * connection cut off hands it to the next one, so the two count as one
 * batch; a full queue dropping its oldest marks it too.
 * @returns {{ failedSeq: number, clean: boolean }}
 */
export function _batchState() {
	return { ..._batch };
}

/**
 * @internal A drain was cut off: the next one carries on its batch.
 * @param {number} failedSeq
 */
export function _carryBatch(failedSeq) {
	_batch = { failedSeq, clean: false };
	_putCheckpoint();
}

/** @internal A drain replayed its whole batch: the next one starts afresh. */
export function _endBatch() {
	if (_batch.failedSeq === Infinity && _batch.clean) return;
	_batch = { failedSeq: Infinity, clean: true };
	_putCheckpoint();
}

/**
 * @internal The connection closed for good, which says nothing about whether
 * a queued mutation should apply: a session that expired while offline closes
 * it too. A mutation with a stored copy stays queued, its call pending, and
 * the copy replays on a later page load. One without (persistence off, an
 * in-memory store, a write that failed) can never be sent, so it rejects with
 * `makeError()`; one whose write is still running is decided when it ends.
 * @param {() => Error} makeError
 */
export function _closeOfflineQueue(makeError) {
	for (const entry of [..._offlineQueue]) _keepIfStored(entry, makeError);
}

/**
 * @internal `_closeOfflineQueue` for one queued entry.
 * @param {any} entry
 * @param {() => Error} makeError
 */
export function _keepIfStored(entry, makeError) {
	if (entry.stored === undefined) {
		_dropClosed(entry, makeError);
		return;
	}
	entry.stored.then((/** @type {boolean} */ stored) => {
		if (!stored) _dropClosed(entry, makeError);
	});
}

/**
 * @param {any} entry
 * @param {() => Error} makeError
 */
function _dropClosed(entry, makeError) {
	const i = _offlineQueue.indexOf(entry);
	if (i === -1) return;
	_offlineQueue.splice(i, 1);
	_bumpPending();
	entry.reject(makeError());
}

/**
 * @internal A drain finished with zero failures and an empty queue: the
 * upload order has no holes any more.
 */
export function _clearGapIfClean() {
	if (_checkpoint.gapDetected && _offlineQueue.length === 0) {
		_checkpoint.gapDetected = false;
		_putCheckpoint();
	}
}

function _putCheckpoint() {
	const store = _store;
	if (!store) return;
	const value = {
		..._checkpoint,
		batchFailedSeq: _batch.failedSeq === Infinity ? null : _batch.failedSeq,
		batchClean: _batch.clean
	};
	void _storeCall(() => store.put(_checkpointKey(), value)).catch(() => {});
}

/**
 * Reset the offline durability state. Tests only.
 * @internal
 */
export function _resetOffline() {
	_store = null;
	_persistKey = 'default';
	_seq = 0;
	_checkpoint = { lastUploadedSeq: 0, gapDetected: false };
	_rehydratePromise = null;
	_restoring = false;
	_unstamped = [];
	_scanFailed = false;
	_batch = { failedSeq: Infinity, clean: true };
	_droppedUnnumbered = false;
	_pendingStore.set(0);
	_uploadingStore.set(false);
}
