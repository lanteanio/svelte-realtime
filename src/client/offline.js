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
import { _offlineQueue } from './internal-state.js';
import { resolveOfflineStore } from './offline-store.js';

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
 * The current upload checkpoint for the configured queue:
 * `lastUploadedSeq` is the highest enqueue seq that replayed successfully;
 * `gapDetected` is true when a later mutation succeeded while an earlier one
 * failed (a hole in the upload order - the app may want a refetch), clearing
 * on the next fully-clean drain.
 * @returns {{ lastUploadedSeq: number, gapDetected: boolean }}
 */
export function offlineCheckpoint() {
	return { ..._checkpoint };
}

/**
 * @internal Configure persistence from `configure({ offline })`. Called by
 * misc.js. Re-running configure with a different persistKey re-targets the
 * scan prefix; entries already in memory keep replaying regardless.
 * @param {any} offlineOpts
 */
export function _configureOfflinePersistence(offlineOpts) {
	if (!offlineOpts) return;
	if (offlineOpts.persistKey !== undefined && (typeof offlineOpts.persistKey !== 'string' || offlineOpts.persistKey.length === 0)) {
		throw new Error('[svelte-realtime] offline.persistKey must be a non-empty string');
	}
	if (!offlineOpts.persist) return;
	_store = resolveOfflineStore(offlineOpts.persist);
	_persistKey = offlineOpts.persistKey ?? 'default';
	if (!_rehydratePromise) {
		_rehydratePromise = _rehydrate().catch(() => {});
	}
}

/**
 * One-shot rehydrate: restore persisted entries into the FRONT of the
 * in-memory queue in seq order, restore the seq counter past their max, and
 * load the checkpoint. Restored entries have no promise holders (the page
 * reloaded), so their settle surfaces only through onReplayError/onConflict.
 */
async function _rehydrate() {
	if (!_store) return;
	const rows = await _store.getAll('q:' + _persistKey + ':');
	/** @type {any[]} */
	const restored = [];
	for (const { value } of rows) {
		if (!value || typeof value.path !== 'string' || !Array.isArray(value.args)) continue;
		restored.push({
			path: value.path,
			args: value.args,
			queuedAt: typeof value.queuedAt === 'number' ? value.queuedAt : 0,
			resolve: () => {},
			reject: () => {},
			idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined,
			timeout: typeof value.timeout === 'number' ? value.timeout : undefined,
			seq: typeof value.seq === 'number' ? value.seq : 0,
			restored: true
		});
		if (typeof value.seq === 'number' && value.seq > _seq) _seq = value.seq;
	}
	if (restored.length > 0) {
		restored.sort((a, b) => a.seq - b.seq);
		_offlineQueue.unshift(...restored);
		_bumpPending();
	}
	const cp = await _store.getAll(_checkpointKey());
	for (const { key, value } of cp) {
		if (key === _checkpointKey() && value && typeof value.lastUploadedSeq === 'number') {
			_checkpoint = { lastUploadedSeq: value.lastUploadedSeq, gapDetected: !!value.gapDetected };
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
 * Called by rpc.js right after the queue push.
 * @param {any} entry
 */
export function _enqueuePersist(entry) {
	entry.seq = ++_seq;
	if (entry.idempotencyKey === undefined || entry.idempotencyKey === null) {
		entry.idempotencyKey = 'off-' + randomUuid();
	}
	if (_store) {
		void _store.put(_entryKey(entry.seq), {
			seq: entry.seq,
			path: entry.path,
			args: entry.args,
			queuedAt: entry.queuedAt,
			idempotencyKey: entry.idempotencyKey,
			timeout: entry.timeout
		}).catch(() => {});
	}
	_bumpPending();
}

/**
 * @internal Settle one entry's durability: drop the persisted copy and, on a
 * successful replay, advance (and persist) the checkpoint. `hadEarlierFailure`
 * flags the gap condition - a success landing after an earlier seq failed.
 * @param {any} entry
 * @param {boolean} success
 * @param {boolean} [hadEarlierFailure]
 */
export function _settlePersist(entry, success, hadEarlierFailure) {
	if (_store && typeof entry.seq === 'number' && entry.seq > 0) {
		void _store.delete(_entryKey(entry.seq)).catch(() => {});
	}
	if (success && typeof entry.seq === 'number') {
		if (entry.seq > _checkpoint.lastUploadedSeq) _checkpoint.lastUploadedSeq = entry.seq;
		if (hadEarlierFailure) _checkpoint.gapDetected = true;
		if (_store) void _store.put(_checkpointKey(), { ..._checkpoint }).catch(() => {});
	}
}

/**
 * @internal A drain finished with zero failures and an empty queue: the
 * upload order has no holes any more.
 */
export function _clearGapIfClean() {
	if (_checkpoint.gapDetected && _offlineQueue.length === 0) {
		_checkpoint.gapDetected = false;
		if (_store) void _store.put(_checkpointKey(), { ..._checkpoint }).catch(() => {});
	}
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
	_pendingStore.set(0);
	_uploadingStore.set(false);
}
