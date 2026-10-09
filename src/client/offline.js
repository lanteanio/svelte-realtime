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

import { randomUuid } from '../client-runtime.js';
import { _offlineQueue, RpcError, _IS_DEV, clientState } from './internal-state.js';
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
/** The checkpoint changed while the restore ran; the restore writes it once done. */
let _checkpointDirty = false;
/** The stored queue was read but its checkpoint could not be: it is left alone for the page. */
let _checkpointUnknown = false;

/**
 * A readable value for the consumer stores, set only by the queue logic. Not
 * a svelte/store writable: a subscriber that throws inside its dispatch
 * leaves svelte/store's shared notification queue stuck, which would stop
 * every store in the app. Here each subscriber is called on its own, and one
 * that throws is reported without keeping the others, or the queue logic that
 * set the value, from running.
 *
 * Otherwise it notifies like a svelte/store writable: every subscription is
 * its own (the same function subscribed twice gets two), `invalidate` runs
 * for all of them before any is called with the value (what keeps a
 * `derived` over it from computing with half-updated inputs), and a value
 * either consumer store sets from inside a subscriber of either is delivered
 * once the current delivery ends, never in the middle of it. A subscriber not
 * yet called with a value that is then replaced gets only the newer one.
 * @template T
 * @param {T} initial
 */
function _consumerStore(initial) {
	/** @type {{ value: T, subscriptions: Set<any> }} */
	const state = { value: initial, subscriptions: new Set() };
	return {
		/**
		 * @param {(v: T) => void} run
		 * @param {() => void} [invalidate]
		 */
		subscribe(run, invalidate) {
			const subscription = { run, invalidate: typeof invalidate === 'function' ? invalidate : () => {}, state };
			state.subscriptions.add(subscription);
			run(state.value);
			return () => { state.subscriptions.delete(subscription); };
		},
		/** @param {T} next */
		set(next) {
			if (next === state.value) return;
			state.value = next;
			const deliver = _deliveries.length === 0;
			for (const subscription of state.subscriptions) {
				_callSubscriber(subscription.invalidate, undefined);
				_deliveries.push(subscription, next);
			}
			if (!deliver) return;
			try {
				for (let i = 0; i < _deliveries.length; i += 2) {
					const subscription = _deliveries[i];
					const v = _deliveries[i + 1];
					if (v === subscription.state.value && subscription.state.subscriptions.has(subscription)) _callSubscriber(subscription.run, v);
				}
			} finally {
				_deliveries.length = 0;
			}
		}
	};
}

/**
 * Subscription and value pairs the consumer stores have yet to deliver, in
 * order. One queue for both, as svelte/store has one for all its stores.
 * @type {any[]}
 */
const _deliveries = [];

/**
 * Call a consumer store subscriber, reporting an error it throws.
 * @param {(v: any) => void} fn
 * @param {any} v
 */
function _callSubscriber(fn, v) {
	try {
		fn(v);
	} catch (err) {
		if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
		else console.error('[svelte-realtime] a pendingMutations or uploading subscriber threw:', err);
	}
}

const _pendingStore = _consumerStore(0);
const _uploadingStore = _consumerStore(false);

/**
 * Live count of queued offline mutations (enqueue, settle, and restore all
 * move it). The consumer surface for "N pending edits" indicators.
 * @type {{ subscribe: (run: (n: number) => void, invalidate?: () => void) => () => void }}
 */
export const pendingMutations = { subscribe: _pendingStore.subscribe };

/**
 * True while a reconnect drain is replaying the queue - the UI backpressure
 * signal ("pause local writes while the upload pipe is busy").
 * @type {{ subscribe: (run: (v: boolean) => void, invalidate?: () => void) => () => void }}
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
 * The seq of a row this queue wrote, from its key, or 0 for a row it did not
 * write: anything but exactly `<prefix><12 digits>`. A row of another
 * persistKey can share the prefix (key `a:b` under the scan for `a`), and a
 * custom store may return rows outside it. The key is what a settle deletes,
 * so the seq comes from it, not from the stored value.
 * @param {unknown} key
 * @param {string} prefix
 * @returns {number}
 */
function _seqOfRowKey(key, prefix) {
	if (typeof key !== 'string' || !key.startsWith(prefix)) return 0;
	const digits = key.slice(prefix.length);
	return /^\d{12}$/.test(digits) ? Number(digits) : 0;
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
 * `gapDetected` is true when the upload order got a hole (the app may want a
 * refetch): a mutation went up while one queued before it failed or was
 * dropped in the same upload batch (see `_batchState`), or a mutation failed
 * below one that had already gone up. It clears when a later upload batch
 * goes up in full, with nothing failing, nothing cut off and nothing left
 * queued.
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
	let rowsRead = false;
	try {
		if (!_store) return;
		const stored = Promise.resolve(_isDurableStore(_store));
		const prefix = 'q:' + _persistKey + ':';
		const rows = _rowsOf(await _store.getAll(prefix));
		/** @type {any[]} */
		const restored = [];
		let maxSeq = 0;
		for (const row of rows) {
			const seq = _seqOfRowKey(row && row.key, prefix);
			if (seq === 0) continue;
			// Held also by a row that cannot be restored: nothing new is written
			// over it.
			if (seq > maxSeq) maxSeq = seq;
			const value = row.value;
			if (!value || typeof value.path !== 'string' || !Array.isArray(value.args)) continue;
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
		}
		rowsRead = true;
		if (maxSeq > _seq) _seq = maxSeq;
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
				// Merged with what a full queue dropped while the restore ran.
				const storedFailedSeq = value.batchFailedSeq === 0 || _validSeq(value.batchFailedSeq) ? value.batchFailedSeq : Infinity;
				_batch = {
					failedSeq: Math.min(storedFailedSeq, _batch.failedSeq),
					clean: value.batchClean !== false && _batch.clean
				};
			}
		}
		// No new seq at or below one that already went up, also once its row
		// is gone: a failure there would read as a hole in the upload order.
		if (_checkpoint.lastUploadedSeq > _seq) _seq = _checkpoint.lastUploadedSeq;
		// Nor at the seq a carried batch failed at: a call queued now comes
		// after it, so its success is a hole.
		if (_batch.failedSeq !== Infinity && _batch.failedSeq > _seq) _seq = _batch.failedSeq;
		// A restored call a full queue dropped meanwhile, below one that went
		// up before the reload, is a hole.
		if (_batch.failedSeq < _checkpoint.lastUploadedSeq && !_checkpoint.gapDetected) {
			_checkpoint.gapDetected = true;
			_checkpointDirty = true;
		}
		read = true;
	} finally {
		if (_store && !read && rowsRead) {
			// The queue was read, so new seqs go past every stored row; only the
			// checkpoint is unknown, and writing it would replace one nobody
			// has seen. It is left alone for the page.
			_checkpointUnknown = true;
			if (_IS_DEV) console.warn('[svelte-realtime] the stored offline upload checkpoint could not be read, so it is not updated for this page; the queue itself is stored as usual.');
		} else if (_store && !read) {
			// What is stored could not be read in full, so any seq could be a
			// stored row's: writing, deleting or checkpointing could destroy a
			// mutation nobody has seen. The queue goes on in memory only.
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
			if (_seq < _batch.failedSeq) {
				_batch.failedSeq = _seq;
				_checkpointDirty = true;
			}
		}
		_restoring = false;
		const waiting = _unstamped;
		_unstamped = [];
		for (const { entry, resolve } of waiting) {
			resolve(entry.settled ? false : _stamp(entry));
		}
		if (_checkpointDirty) {
			_checkpointDirty = false;
			_putCheckpoint();
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
 * @internal The queue's size limit from `offline.maxQueue`: 100 for a falsy
 * value or one that does not convert to a number, otherwise rounded down, to
 * at least one.
 * @param {any} offlineOpts
 * @returns {number}
 */
export function _queueLimit(offlineOpts) {
	const max = offlineOpts?.maxQueue;
	if (!max) return 100;
	const n = Math.floor(Number(max));
	if (Number.isNaN(n)) return 100;
	return Math.max(1, n);
}

/**
 * @internal Tell `offline.onReplayError` about a queued call that will not
 * be applied. An observer: an error it throws is ignored.
 * @param {{ path: string, args: any[], queuedAt: number }} call
 * @param {any} err
 */
export function _notifyReplayError(call, err) {
	const hook = clientState.config.offline?.onReplayError;
	if (typeof hook !== 'function') return;
	try {
		hook(call, err);
	} catch (hookErr) {
		if (_IS_DEV) console.warn('[svelte-realtime] offline.onReplayError threw; the error is ignored. Cause: ' + (hookErr && /** @type {any} */ (hookErr).message ? /** @type {any} */ (hookErr).message : String(hookErr)));
	}
}

/**
 * @internal Drop the oldest queued entries until at most `max` are left,
 * deleting their stored copies, and return them. The caller rejects and
 * reports them with `_settleDropped` once its own queue work is done, and
 * refreshes the pending count.
 * @param {number} max
 * @returns {any[]}
 */
export function _trimQueue(max) {
	/** @type {any[]} */
	const dropped = [];
	while (_offlineQueue.length > Math.max(max, 0)) {
		const entry = _offlineQueue.shift();
		dropped.push(entry);
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
	if (dropped.length > 0) _putCheckpoint();
	return dropped;
}

/** True while a full-queue drop is being reported to onReplayError. */
let _reportingDrops = false;
/**
 * Restored calls dropped while a drop was being reported, reported next.
 * @type {Array<{ entry: any, err: any }>}
 */
let _dropsToReport = [];

/**
 * @internal Reject what `_trimQueue` dropped with QUEUE_FULL and report it to
 * onReplayError. Called once the caller's own queue work is done. A call the
 * hook makes can push out another entry. One whose caller holds its promise
 * is only rejected, so a hook that queues a call cannot keep the queue
 * evicting; a restored one has no promise anyone holds, so it is reported
 * once the current report returns. That ends: each such report takes one
 * restored call out of the queue, and nothing adds restored calls to it.
 * @param {any[]} dropped
 */
export function _settleDropped(dropped) {
	for (const entry of dropped) {
		const err = new RpcError('QUEUE_FULL', 'Offline queue overflow - oldest mutation dropped');
		if (!_reportingDrops) {
			_reportingDrops = true;
			try {
				_reportDrop(entry, err);
				for (let i = 0; i < _dropsToReport.length; i++) _reportDrop(_dropsToReport[i].entry, _dropsToReport[i].err);
			} finally {
				_reportingDrops = false;
				_dropsToReport = [];
			}
		} else if (entry.restored) {
			_dropsToReport.push({ entry, err });
		}
		entry.reject(err);
	}
}

/**
 * @param {any} entry
 * @param {any} err
 */
function _reportDrop(entry, err) {
	_notifyReplayError({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt }, err);
}

/**
 * @internal The upload batch the queue is in: the lowest seq that failed in
 * it (Infinity for none) and whether it is still clean. A drain a lost
 * connection or a closed page cut off hands it to the next one, also on the
 * next page, so the two count as one batch; a full queue dropping its oldest
 * marks it too.
 * @returns {{ failedSeq: number, clean: boolean }}
 */
export function _batchState() {
	return { ..._batch };
}

/**
 * @internal A drain starts replaying its batch. Until it ends, the stored
 * batch reads as cut off, so a page that closes during the replay leaves the
 * next page a batch to carry on, as a lost connection would (a replay in
 * flight may have been applied). The mark is a store write like any other:
 * a page that closes before it lands leaves the stored batch as it was.
 */
export function _beginBatch() {
	if (!_batch.clean) return;
	_batch = { failedSeq: _batch.failedSeq, clean: false };
	_putCheckpoint();
}

/**
 * @internal A call in the drain failed or was dropped. Stored at once, so a
 * page that closes before the drain ends still counts it.
 * @param {number} seq
 */
export function _noteBatchFailure(seq) {
	if (seq >= _batch.failedSeq) return;
	_batch = { failedSeq: seq, clean: _batch.clean };
	_putCheckpoint();
}

/**
 * @internal A drain was cut off: the next one carries on its batch, which is
 * not clean (a replay that was cut off may have been applied).
 * @param {number} failedSeq
 */
export function _carryBatch(failedSeq) {
	// A full queue may have dropped a call while the drain ran.
	_batch = { failedSeq: Math.min(_batch.failedSeq, failedSeq), clean: false };
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
	if (!store || _checkpointUnknown) return;
	// The stored checkpoint is not read yet while the restore runs: writing
	// now would replace it with this page's empty one. The restore writes
	// once it has merged the two.
	if (_restoring) {
		_checkpointDirty = true;
		return;
	}
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
	_reportingDrops = false;
	_dropsToReport = [];
	_checkpointDirty = false;
	_checkpointUnknown = false;
	_pendingStore.set(0);
	_uploadingStore.set(false);
}
