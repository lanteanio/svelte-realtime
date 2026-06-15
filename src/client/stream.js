// @ts-check
import { connect as _connect, on, status } from 'svelte-adapter-uws/client';
import { writable } from 'svelte/store';
// Namespace import lets .rune() access fromStore (Svelte 5 only) without
// breaking the module under Svelte 4 - missing exports become undefined,
// not module-load errors.
import * as _svelteStore from 'svelte/store';
import { assert } from '../shared/assert.js';
import { mergeKeyField, rebuildIndex } from '../shared/merge.js';
import { sanitizeRowData } from '../shared/safe-assign.js';
import { now, randomFloat, setTimer, clearTimer, microtask } from '../client-runtime.js';
import { _devtoolsStream, _devtoolsStreamEvent, _devtoolsStreamError } from './devtools-instrument.js';
import { clientState, RpcError, _IS_DEV, _useRAF, _nextId, pending } from './internal-state.js';
import { _addInFlight, _removeInFlight } from './health.js';
import { ensureListener, ensureDisconnectListener, ensureDenialsListener, _getTimeout, _getResumeGraceMs, _registerTopicErrorSetter, _unregisterTopicErrorSetter } from './connection.js';
import { _maybeHintPublishRate } from './rpc.js';

/**
 * Microtask-batched stream subscribe RPCs.
 * Collects all subscribe RPCs within a single microtask and sends them as one batch frame.
 * @type {Array<any> | null}
 */
let _subscribeBatch = null;

/**
 * Queue a stream subscribe RPC to be sent in a batch within the current microtask.
 * If only one request queues, it's sent as a single frame (no batch overhead).
 * @param {any} request - The subscribe RPC request object
 */
function _batchedSubscribe(request) {
	if (!_subscribeBatch) {
		_subscribeBatch = [];
		microtask(() => {
			const batch = _subscribeBatch;
			_subscribeBatch = null;
			if (!batch || batch.length === 0) return;
			const conn = _connect();
			if (batch.length === 1) {
				conn.sendQueued(batch[0]);
			} else {
				conn.sendQueued({ batch });
			}
		});
	}
	_subscribeBatch.push(request);
}

/** @type {Map<string, { store: any, refCount: number }>} */
const _streamCache = new Map();

/** Hard cap on cached stream instances to prevent memory exhaustion */
const _STREAM_CACHE_MAX = 1000;

/** Overflow dedupe for currently-live stores that couldn't fit in the main cache */
const _streamOverflow = new Map();

/** Set of cache keys with zero refCount, for O(1) eviction instead of full scan */
const _evictable = new Set();

/**
 * Create a reactive stream store for a given path.
 * Used by generated client stubs.
 *
 * When `dynamicArgs` is provided, returns a factory function that creates
 * cached store instances keyed by serialized args.
 *
 * @param {string} path - e.g. 'chat/messages'
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, prepend?: boolean, max?: number }} [options]
 * @param {boolean} [isDynamic] - If true, returns a function that accepts args
 * @returns {import('svelte/store').Readable<any> | ((...args: any[]) => import('svelte/store').Readable<any>)}
 */
export function __stream(path, options, isDynamic) {
	if (isDynamic) {
		const dynamicStream = function dynamicStream(...args) {
			let cacheKey;
			if (args.length === 1) {
				const a = args[0];
				const t = typeof a;
				if (t === 'string' || t === 'number') cacheKey = path + ':' + a;
				else cacheKey = path + ':' + JSON.stringify(args);
			} else {
				cacheKey = path + ':' + JSON.stringify(args);
			}
			const cached = _streamCache.get(cacheKey);
			if (cached) return cached.store;

			// Check overflow dedupe for active stores that didn't fit in the main cache
			const overflow = _streamOverflow.get(cacheKey);
			if (overflow) return overflow.store;

			const store = _createStream(path, options, args);
			const rawSubscribe = store.subscribe.bind(store);

			if (_streamCache.size >= _STREAM_CACHE_MAX) {
				for (const k of _evictable) {
					_streamCache.delete(k);
					_evictable.delete(k);
					if (_streamCache.size < _STREAM_CACHE_MAX) break;
				}
			}

			if (_streamCache.size < _STREAM_CACHE_MAX) {
				_streamCache.set(cacheKey, { store, refCount: 0 });
				_evictable.add(cacheKey);
			} else {
				if (_streamOverflow.size >= _STREAM_CACHE_MAX) {
					for (const [k, e] of _streamOverflow) {
						if (e.refCount <= 0) { _streamOverflow.delete(k); break; }
					}
				}
				_streamOverflow.set(cacheKey, { store, refCount: 0 });
			}

			store.subscribe = function cachedSubscribe(fn) {
				const mainEntry = _streamCache.get(cacheKey);
				if (mainEntry && mainEntry.store === store) {
					mainEntry.refCount++;
					_evictable.delete(cacheKey);
				}
				const overflowEntry = _streamOverflow.get(cacheKey);
				if (overflowEntry && overflowEntry.store === store) overflowEntry.refCount++;

				const unsub = rawSubscribe(fn);
				return () => {
					unsub();
					const mainEntry = _streamCache.get(cacheKey);
					if (mainEntry && mainEntry.store === store && --mainEntry.refCount <= 0) {
						_evictable.add(cacheKey);
					}
					const overflowEntry = _streamOverflow.get(cacheKey);
					if (overflowEntry && overflowEntry.store === store && --overflowEntry.refCount <= 0) {
						_streamOverflow.delete(cacheKey);
					}
				};
			};

			return store;
		};
		// Stamp metadata so test-affordances like `subscribeAt` (from
		// `svelte-realtime/test-client`) can construct a parallel store
		// at a chosen `schemaVersion` without needing the user to pass
		// the path string by hand.
		/** @type {any} */ (dynamicStream).__streamPath = path;
		/** @type {any} */ (dynamicStream).__streamOptions = options;
		/** @type {any} */ (dynamicStream).__streamIsDynamic = true;
		return dynamicStream;
	}
	return _createStream(path, options);
}

/**
 * Test/demo affordance: create a parallel stream store at a chosen
 * client-side `schemaVersion`. Walks the same wire path as a real
 * subscribe - the server sees a normal `subscribe { schemaVersion }`
 * envelope, runs its registered migrate chain forward to the current
 * server version, and returns the migrated payload, which this store
 * renders. Used by `svelte-realtime/test-client`'s `subscribeAt`; not
 * a production primitive.
 *
 * @internal
 * @param {string} path
 * @param {any} options
 * @param {any[] | undefined} dynamicArgs
 * @param {number | undefined} schemaVersion
 * @returns {import('svelte/store').Readable<any>}
 */
export function _createStreamAtSchemaVersion(path, options, dynamicArgs, schemaVersion) {
	return _createStream(path, options, dynamicArgs, schemaVersion);
}

/**
 * Wrap a subscribable in a `{ subscribe, rune, map }` object whose `.map()`
 * projects per-item over the source's array (matching the
 * `($source ?? []).map(fn)` semantic from the plan body).
 *
 * Lifecycle: lazy. Source is subscribed on first downstream consumer and
 * unsubscribed on the last; the projection is recomputed per emission.
 *
 * Used by `StreamStore.map()` and chained from the returned mapped store
 * itself (so `stream.map(a).map(b).rune()` composes cleanly).
 *
 * @template T, U
 * @param {{ subscribe: (fn: (v: any) => void) => () => void }} source
 * @param {(item: T) => U} fn
 * @returns {{ subscribe: (fn: (v: U[]) => void) => () => void, rune: () => { readonly current: U[] }, map: <V>(g: (item: U) => V) => any }}
 */
function _createMappedStore(source, fn) {
	const out = writable(/** @type {any} */ (undefined));
	/** @type {(() => void) | null} */
	let unsub = null;
	let consumers = 0;

	function activate() {
		if (unsub) return;
		unsub = source.subscribe((v) => {
			if (v == null) {
				out.set([]);
			} else if (Array.isArray(v)) {
				out.set(v.map(fn));
			} else {
				if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
					const tname = typeof v === 'object' ? (v.constructor?.name || 'object') : typeof v;
					console.warn(
						`[svelte-realtime] .map() expects an array source; got ${tname}.\n  See: https://svti.me/merge`
					);
				}
				out.set([]);
			}
		});
	}

	function deactivate() {
		if (unsub) {
			unsub();
			unsub = null;
		}
	}

	return {
		subscribe(consumer) {
			if (consumers++ === 0) activate();
			const unsubLocal = out.subscribe(consumer);
			return () => {
				unsubLocal();
				if (--consumers === 0) deactivate();
			};
		},
		rune() {
			if (typeof _svelteStore.fromStore !== 'function') {
				throw new Error(
					'[svelte-realtime] .rune() requires Svelte 5 (svelte/store does not export fromStore)'
				);
			}
			return _svelteStore.fromStore(this);
		},
		map(g) {
			if (typeof g !== 'function') {
				throw new Error('[svelte-realtime] .map(fn): fn must be a function');
			}
			return _createMappedStore(this, g);
		}
	};
}

/**
 * @param {string} path
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, prepend?: boolean, max?: number }} [options]
 * @param {any[]} [dynamicArgs]
 * @returns {any}
 */
/**
 * @param {string} path
 * @param {any} [options]
 * @param {any[]} [dynamicArgs]
 * @param {number} [initialSchemaVersion] Test/demo affordance: pre-seed
 *   the closure-local `_schemaVersion` so the very first subscribe
 *   envelope carries it. Production code never sets this; only the
 *   `subscribeAt` helper from `svelte-realtime/test-client`.
 */
function _createStream(path, options, dynamicArgs, initialSchemaVersion) {
	let merge = options?.merge || 'crud';
	let key = options?.key || 'id';
	let prepend = options?.prepend || false;
	let max = options?.max || (merge === 'latest' ? 50 : 0);

	/** @type {any} */
	let currentValue;
	const store = writable(undefined);

	/** @type {RpcError | null} */
	let _error = null;
	const _errorStore = writable(null);

	/** @type {'loading' | 'connected' | 'reconnecting' | 'error'} */
	let _status = 'loading';
	const _statusStore = writable(/** @type {'loading' | 'connected' | 'reconnecting' | 'error'} */ ('loading'));

	function _setError(/** @type {RpcError} */ err) {
		_error = err;
		_errorStore.set(err);
		_status = 'error';
		_statusStore.set('error');
		_devtoolsStreamError(path, err);
	}

	function _clearError() {
		if (_error !== null) {
			_error = null;
			_errorStore.set(null);
			_devtoolsStreamError(path, null);
		}
	}

	/** @type {string | null} */
	let topic = null;

	/** @type {Array<{ event: string, data: any }>} */
	let buffer = [];

	/** @type {boolean} */
	let initialLoaded = false;

	/** @type {boolean} */
	let fetching = false;

	/** @type {(() => void) | null} */
	let topicUnsub = null;

	/** @type {(() => void) | null} */
	let statusUnsub = null;

	/** @type {(() => void) | null} Per-stream subscriber that maintains the global in-flight counter. */
	let _quiescenceUnsub = null;
	/** @type {boolean} Whether this stream is currently counted in `_inFlightCount`. */
	let _countedInFlight = false;

	let subCount = 0;
	let pendingId = null;


	/** @type {number | null} Last known sequence number for replay */
	let _lastSeq = null;

	/** @type {any} Cursor for pagination (server-provided) */
	let _cursor = null;

	/** @type {boolean} Whether more pages are available */
	let _hasMore = false;

	/** @type {boolean} Whether a loadMore request is in flight */
	let _loadingMore = false;

	/** @type {number | undefined} Schema version from server */
	let _schemaVersion = initialSchemaVersion;

	/** @type {any} Last known version for delta sync */
	let _lastVersion = undefined;

	/** @type {Set<any>} Keys of optimistic entries pending server confirmation */
	const _optimisticKeys = new Set();

	/** @type {Map<any, number>} Key-to-index lookup for keyed merge strategies */
	const _index = new Map();

	/**
	 * Always-on optimistic mutation queue. Each entry holds a pending
	 * `mutate(asyncOp, change)` call: its change spec, the optimistic
	 * key (when extractable from an event-shaped change), and a flag
	 * tracking whether a matching server event has already absorbed it.
	 *
	 * When the queue is non-empty, the stream operates in "queue mode":
	 * server events apply to `_serverValue` (the un-overlaid server state)
	 * rather than `currentValue`, and `currentValue` is recomputed by
	 * replaying the queue against `_serverValue` after each batch. When
	 * the queue drains, `currentValue` becomes equal to `_serverValue`
	 * and queue mode exits.
	 *
	 * @type {Array<{ change: any, optimisticKey: any, serverConfirmed: boolean }>}
	 */
	const _optimisticQueue = [];

	/**
	 * Un-overlaid server-side state when queue mode is active; null
	 * otherwise. Initialized from `currentValue` on the first mutate
	 * push and cleared when the queue drains.
	 * @type {any}
	 */
	let _serverValue = null;

	/**
	 * Index Map parallel to `_index`, but for `_serverValue`. Tracks the
	 * key-to-position mapping used by keyed merge strategies for the
	 * un-overlaid server state.
	 * @type {Map<any, number> | null}
	 */
	let _serverIndex = null;

	/** @type {any[]} Undo/redo history stack */
	let _history = [];
	/** @type {number} Current position in history (-1 = no history) */
	let _historyIndex = -1;
	/** @type {boolean} Whether history tracking is enabled */
	let _historyEnabled = false;
	/** @type {boolean} Whether history recording is paused (events still apply, just no snapshots) */
	let _historyPaused = false;
	/** @type {number} Maximum history entries */
	let _historyMax = 50;

	/** @type {ReturnType<typeof setTimeout> | null} Reconnect debounce timer */
	let _reconnectTimer = null;

	/** @type {number} Consecutive reconnect attempts (reset on successful fetch) */
	let _reconnectAttempts = 0;

	/**
	 * Rebuild a (value, index) pair using the closure's merge / key.
	 * @param {any} value
	 * @param {Map<any, number>} index
	 */
	function _rebuildIndexFn(value, index) {
		rebuildIndex(value, index, merge, key);
	}

	/**
	 * Rebuild the key->index lookup map from currentValue.
	 * Only meaningful for keyed merge strategies (crud, presence, cursor).
	 */
	function _rebuildIndex() {
		rebuildIndex(currentValue, _index, merge, key);
	}

	/**
	 * Record current state in history after a mutation (if history enabled).
	 * Called after currentValue has been updated and a new reference created.
	 */
	function _recordHistory() {
		if (!_historyEnabled || _historyPaused) return;
		// Skip history for large arrays (> 200 items) to avoid excessive memory
		if (Array.isArray(currentValue) && currentValue.length > 200) return;
		// Discard any redo entries after the current position
		if (_historyIndex < _history.length - 1) {
			_history.length = _historyIndex + 1;
		}
		// Snapshot must be a copy since _applyMerge mutates currentValue in place
		const snapshot = Array.isArray(currentValue) ? currentValue.slice() : currentValue;
		_history.push(snapshot);
		if (_history.length > _historyMax) {
			_history.shift();
		}
		_historyIndex = _history.length - 1;
	}

	/**
	 * Apply a merge event in place (mutates currentValue, updates _index).
	 * Does NOT call store.set or _recordHistory.
	 * Returns true if currentValue was replaced with a new reference (no copy needed).
	 * @param {{ event: string, data: any, seq?: number }} envelope
	 * @returns {boolean}
	 */
	/** @type {boolean} Whether _applyMerge has changed currentValue since last flush */
	let _dirty = false;

	/**
	 * Pure functional core of `_applyMerge`. Mutates the supplied `value`,
	 * `index`, and `optimisticKeys` in place; closure constants
	 * (`merge`, `key`, `prepend`, `max`) are captured from the enclosing
	 * stream scope. Does not touch `currentValue`, `_index`, `_lastSeq`,
	 * `_dirty`, the store, or history - the closure wrapper is
	 * responsible for those.
	 *
	 * Lifted out of `_applyMerge` so that future code paths can apply the
	 * same merge semantics to alternative (value, index) pairs (e.g. an
	 * unoverlaid server-side state held alongside the displayed value).
	 *
	 * @param {any} value
	 * @param {Map<any, number>} index
	 * @param {{ event: string, data: any }} envelope
	 * @param {Set<any>} optimisticKeys
	 * @returns {{ value: any, replaced: boolean, modified: boolean }}
	 *   - `value`: the (possibly new) value reference. May be a fresh
	 *     reference (e.g. after `data` replacement) or the same reference
	 *     that was passed in (after in-place mutation).
	 *   - `replaced`: true when `value` was assigned a fresh reference,
	 *     so the caller does not need to clone before publishing.
	 *   - `modified`: false only for the `set` strategy when the incoming
	 *     `data` is reference-identical to the prior value (no-op);
	 *     true in all other paths.
	 */
	function _applyMergeFn(value, index, envelope, optimisticKeys) {
		const { event } = envelope;
		// Defense-in-depth: strip prototype-pollution keys (`__proto__`,
		// `constructor`, `prototype`) from envelope data at ingress for
		// keyed merge strategies. The framework does not currently spread
		// or `Object.assign` stored items, so the live exploit surface is
		// host-app code that later iterates the array. The sanitizer is a
		// no-op (zero allocation) when the danger keys are absent, which
		// is every legitimate envelope.
		const data = (merge === 'crud' || merge === 'presence' || merge === 'cursor')
			? sanitizeRowData(envelope.data)
			: envelope.data;

		if (event === 'refreshed') {
			value = data;
			optimisticKeys.clear();
			if (merge === 'crud' || merge === 'presence' || merge === 'cursor') {
				_rebuildIndexFn(value, index);
			}
			return { value, replaced: true, modified: true };
		}

		if (merge === 'crud') {
			if (!Array.isArray(value)) { value = []; index.clear(); }

			if (data && data[key] !== undefined) {
				optimisticKeys.delete(data[key]);
			}

			if (event === 'created') {
				const idx = index.get(data[key]);
				if (idx !== undefined) {
					value[idx] = data;
				} else if (prepend) {
					value.unshift(data);
					for (const [k, i] of index) index.set(k, i + 1);
					index.set(data[key], 0);
					if (max && value.length > max) {
						const removed = value.splice(max);
						for (const item of removed) index.delete(item[key]);
					}
				} else {
					index.set(data[key], value.length);
					value.push(data);
					if (max && value.length > max) {
						const removed = value.splice(0, value.length - max);
						for (const item of removed) index.delete(item[key]);
						_rebuildIndexFn(value, index);
					}
				}
			} else if (event === 'updated') {
				const idx = index.get(data[key]);
				if (idx !== undefined) value[idx] = data;
			} else if (event === 'deleted') {
				const idx = index.get(data[key]);
				if (idx !== undefined) {
					index.delete(data[key]);
					const last = value.length - 1;
					if (idx < last) {
						const swapped = value[last];
						value[idx] = swapped;
						index.set(swapped[key], idx);
					}
					value.length = last;
				}
			}
			return { value, replaced: false, modified: true };
		} else if (merge === 'latest') {
			if (!Array.isArray(value)) value = [];
			value.push(data);
			if (value.length > max) {
				value = value.slice(-max);
				return { value, replaced: true, modified: true };
			}
			return { value, replaced: false, modified: true };
		} else if (merge === 'presence') {
			if (!Array.isArray(value)) { value = []; index.clear(); }
			if (event === 'join') {
				const idx = index.get(data.key);
				if (idx !== undefined) {
					value[idx] = data;
				} else {
					index.set(data.key, value.length);
					value.push(data);
				}
			} else if (event === 'leave') {
				const idx = index.get(data.key);
				if (idx !== undefined) {
					index.delete(data.key);
					const last = value.length - 1;
					if (idx < last) {
						const swapped = value[last];
						value[idx] = swapped;
						index.set(swapped.key, idx);
					}
					value.length = last;
				}
			} else if (event === 'update') {
				// Field-level delta: shallow-merge the changed fields into the
				// roster entry, preserving the key and the rest of the payload.
				// A delta that races ahead of its join (no entry yet) seeds a
				// transient entry; the authoritative join that follows replaces it
				// with its snapshot, so a raced-ahead field shows briefly and then
				// clears until the next update (acceptable for the rare
				// update-before-join order; normal order is join first).
				const idx = index.get(data.key);
				if (idx !== undefined) {
					value[idx] = { ...value[idx], ...data };
				} else {
					index.set(data.key, value.length);
					value.push(data);
				}
			} else if (event === 'set') {
				value = data;
				_rebuildIndexFn(value, index);
				return { value, replaced: true, modified: true };
			}
			return { value, replaced: false, modified: true };
		} else if (merge === 'cursor') {
			if (!Array.isArray(value)) { value = []; index.clear(); }
			if (event === 'update') {
				const idx = index.get(data.key);
				if (idx !== undefined) {
					value[idx] = data;
				} else {
					index.set(data.key, value.length);
					value.push(data);
				}
			} else if (event === 'remove') {
				const idx = index.get(data.key);
				if (idx !== undefined) {
					index.delete(data.key);
					const last = value.length - 1;
					if (idx < last) {
						const swapped = value[last];
						value[idx] = swapped;
						index.set(swapped.key, idx);
					}
					value.length = last;
				}
			} else if (event === 'set') {
				value = data;
				_rebuildIndexFn(value, index);
				return { value, replaced: true, modified: true };
			}
			return { value, replaced: false, modified: true };
		} else if (merge === 'set') {
			if (data === value) return { value, replaced: true, modified: false };
			value = data;
			return { value, replaced: true, modified: true };
		}
		return { value, replaced: false, modified: false };
	}

	/**
	 * Apply a merge event to the stream's authoritative state. In the
	 * steady-state hot path (queue empty), mutates currentValue / _index /
	 * _optimisticKeys directly. In queue mode (a `mutate(asyncOp, change)`
	 * is in flight), routes to `_serverValue` / `_serverIndex` and runs
	 * the optimistic-absorption check so a server event matching a
	 * queue entry's key is recognised and the entry is graduated. Tracks
	 * `_lastSeq` and `_dirty`. Does NOT call store.set or _recordHistory;
	 * callers handle the publish.
	 *
	 * @param {{ event: string, data: any, seq?: number }} envelope
	 * @returns {boolean} true if currentValue was replaced with a fresh
	 *   reference (caller can skip the defensive `.slice()` before
	 *   publish). Always false in queue mode - caller should recompute
	 *   the display via `_recomputeDisplay()` instead.
	 */
	function _applyMerge(envelope) {
		if (envelope.seq !== undefined) _lastSeq = envelope.seq;
		if (_optimisticQueue.length > 0) {
			// optimistic.queue invariant: when queue is non-empty the un-overlaid
			// server state pair (_serverValue, _serverIndex) must be set. Both
			// are paired across mutate-push and _drainQueue.
			assert(_serverValue !== null && _serverIndex !== null, 'realtime/optimistic.queue.serverValue-iff-nonempty', { queueLen: _optimisticQueue.length, hasServerValue: _serverValue !== null, hasServerIndex: _serverIndex !== null });
			const result = _applyMergeFn(_serverValue, /** @type {Map<any, number>} */ (_serverIndex), envelope, _optimisticKeys);
			_serverValue = result.value;
			_dirty = result.modified;
			_absorbCheck(envelope);
			return false;
		}
		const result = _applyMergeFn(currentValue, _index, envelope, _optimisticKeys);
		currentValue = result.value;
		_dirty = result.modified;
		return result.replaced;
	}

	/**
	 * Mark any queue entries whose `optimisticKey` matches the incoming
	 * server event as `serverConfirmed`. The entry is then skipped during
	 * `_replayQueue`, and on settle the entry is dropped (rather than
	 * graduated) since the server already has the change.
	 *
	 * Only runs for keyed merge strategies (crud, presence, cursor) and
	 * for "additive/idempotent" event names. A server `deleted` matching
	 * an optimistic `created` is NOT treated as confirmation - those
	 * combinations are exotic races and fall through to graduate-on-
	 * success, which is idempotent for crud's index-keyed updates.
	 *
	 * @param {{ event: string, data: any }} envelope
	 */
	function _absorbCheck(envelope) {
		if (_optimisticQueue.length === 0) return;
		const data = envelope.data;
		if (!data || typeof data !== 'object') return;
		const k = mergeKeyField(merge, key);
		if (!k) return;
		const dataKey = data[k];
		if (dataKey === undefined) return;
		let absorbing = false;
		if (merge === 'crud') absorbing = envelope.event === 'created' || envelope.event === 'updated';
		else if (merge === 'presence') absorbing = envelope.event === 'join';
		else if (merge === 'cursor') absorbing = envelope.event === 'update';
		if (!absorbing) return;
		for (const entry of _optimisticQueue) {
			if (entry.optimisticKey === dataKey) entry.serverConfirmed = true;
		}
	}

	/**
	 * Apply one queue entry's change to a (value, index) working pair.
	 * Returns the new value reference (may be the same as the input
	 * when mutated in place). Used by both `_replayQueue` (replay
	 * onto a copy of `_serverValue`) and the success-graduate path
	 * (apply directly onto `_serverValue` / `_serverIndex`).
	 *
	 * For function-shaped changes, the function receives a draft (a
	 * shallow copy for arrays / objects) and may either mutate it in
	 * place (returning undefined) or return a new value. The index is
	 * rebuilt from the resulting value.
	 *
	 * For event-shaped changes, the change is applied via
	 * `_applyMergeFn` - same merge semantics that server events use.
	 *
	 * @param {any} value
	 * @param {Map<any, number>} index
	 * @param {any} change
	 * @returns {any}
	 */
	function _applyChange(value, index, change) {
		if (typeof change === 'function') {
			const draft = Array.isArray(value)
				? value.slice()
				: (value && typeof value === 'object' ? { ...value } : value);
			const result = change(draft);
			const next = result === undefined ? draft : result;
			_rebuildIndexFn(next, index);
			return next;
		}
		const r = _applyMergeFn(value, index, change, _optimisticKeys);
		return r.value;
	}

	/**
	 * Replay the in-flight queue against a fresh copy of `_serverValue`,
	 * skipping `serverConfirmed` entries. Returns the resulting (value,
	 * index) pair. Caller writes them into `currentValue` / `_index`.
	 *
	 * @returns {{ value: any, index: Map<any, number> }}
	 */
	function _replayQueue() {
		let value = Array.isArray(_serverValue) ? _serverValue.slice() : _serverValue;
		const index = new Map(_serverIndex);
		for (const entry of _optimisticQueue) {
			if (entry.serverConfirmed) continue;
			value = _applyChange(value, index, entry.change);
		}
		return { value, index };
	}

	/**
	 * Replay the queue and write the result into `currentValue` / `_index`,
	 * then publish to the store and record history. Called whenever queue
	 * state changes during queue mode (mutate add, mutate settle, server
	 * event arrives).
	 */
	function _recomputeDisplay() {
		const replayed = _replayQueue();
		currentValue = replayed.value;
		_index.clear();
		for (const [k, i] of replayed.index) _index.set(k, i);
		store.set(currentValue);
		_recordHistory();
	}

	/**
	 * Exit queue mode. Promotes `_serverValue` to `currentValue`, clears
	 * the parallel server-state slots, publishes to the store, and
	 * records history. Called when the queue empties after a mutate
	 * settles.
	 */
	function _drainQueue() {
		// drain-precondition invariant: _drainQueue is the queue-mode exit
		// path; callers must only invoke it with an empty queue.
		assert(_optimisticQueue.length === 0, 'realtime/optimistic.queue.drain-precondition', { queueLen: _optimisticQueue.length });
		currentValue = _serverValue;
		_index.clear();
		if (_serverIndex) {
			for (const [k, i] of _serverIndex) _index.set(k, i);
		}
		_serverValue = null;
		_serverIndex = null;
		store.set(currentValue);
		_recordHistory();
	}

	/** Double-buffer swap pattern: two pre-allocated arrays reused every frame */
	let _bufA = [];
	let _bufB = [];
	let _activeBuf = _bufA;

	/** @type {number | null} */
	let _rafId = null;

	/** Idempotent events where the latest value per key wins (safe to dedup) */
	const _IDEMPOTENT = new Set(['updated', 'update', 'join']);

	/**
	 * Flush all queued events in a single batch, then update the store once.
	 * Uses double-buffer swap to avoid allocating new arrays per frame.
	 * Deduplicates idempotent events by entity key within a single frame.
	 */
	function _flushEvents() {
		_rafId = null;
		const queue = _activeBuf;
		_activeBuf = _activeBuf === _bufA ? _bufB : _bufA;
		if (queue.length === 0) return;

		// RAF dedup: for keyed merge strategies, keep only the last idempotent event per key
		if (queue.length > 1 && merge !== 'set' && merge !== 'latest') {
			const keyField = mergeKeyField(merge, key);
			const seen = new Map();
			for (let i = queue.length - 1; i >= 0; i--) {
				if (!_IDEMPOTENT.has(queue[i].event)) continue;
				const k = queue[i].data?.[keyField];
				if (k !== undefined) {
					if (seen.has(k)) {
						queue[i] = null;
					} else {
						seen.set(k, true);
					}
				}
			}
			for (let i = 0; i < queue.length; i++) {
				if (queue[i] !== null) _applyMerge(queue[i]);
			}
		} else {
			for (let i = 0; i < queue.length; i++) {
				_applyMerge(queue[i]);
			}
		}

		queue.length = 0; // Reuse the array, don't allocate a new one
		if (!_dirty) return;
		_dirty = false;
		if (_optimisticQueue.length > 0) {
			_recomputeDisplay();
			return;
		}
		if (Array.isArray(currentValue)) currentValue = currentValue.slice();
		store.set(currentValue);
		_recordHistory();
	}

	/**
	 * Apply a pub/sub event to the store. In the browser, events are queued
	 * and flushed once per animation frame to reduce reactive updates from
	 * N-per-event to 1-per-frame. In Node/SSR, events apply immediately.
	 *
	 * Handles replay end markers from adapter 0.4.0 extensions:
	 * - `{ reqId }` signals replay complete (no action needed)
	 * - `{ reqId, truncated: true }` signals a cache miss; triggers full refetch
	 * @param {{ event: string, data: any }} envelope
	 */
	function applyEvent(envelope) {
		// Replay end marker (adapter 0.4.0 extensions): object with reqId
		if (envelope.data && typeof envelope.data === 'object' && envelope.data.reqId !== undefined) {
			if (envelope.data.truncated === true) {
				// Cache miss - trigger a full refetch (reset seq so we get full data)
				_lastSeq = null;
				if (topicUnsub) { topicUnsub(); topicUnsub = null; }
				initialLoaded = false;
				fetching = false;
				buffer = [];
				fetchAndSubscribe();
			}
			// Non-truncated end marker - replay complete, nothing to do
			return;
		}

		_devtoolsStreamEvent(path, envelope.event, envelope.data);
		if (_IS_DEV) _maybeHintPublishRate(path, options);

		if (_useRAF) {
			_activeBuf.push(envelope);
			if (_rafId === null) {
				_rafId = requestAnimationFrame(_flushEvents);
			}
		} else {
			const replaced = _applyMerge(envelope);
			if (_optimisticQueue.length > 0) {
				_recomputeDisplay();
			} else {
				if (!replaced && Array.isArray(currentValue)) currentValue = currentValue.slice();
				store.set(currentValue);
				_recordHistory();
			}
		}
	}

	/**
	 * Fetch initial data and subscribe to live updates.
	 */
	function fetchAndSubscribe() {
		if (fetching) return;
		if (clientState.terminated) {
			_setError(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
			return;
		}
		fetching = true;
		initialLoaded = false;
		buffer = [];

		// Cancel any previous pending request
		if (pendingId) {
			const prev = pending.get(pendingId);
			if (prev) {
				pending.delete(pendingId);
				if (prev.timer) clearTimer(prev.timer);
			}
			pendingId = null;
		}

		ensureListener();
		ensureDisconnectListener();

		const id = _nextId();
		pendingId = id;
		const conn = _connect();

		const _startTime = now();
		const timer = setTimer(() => {
			if (now() - _startTime > 90000) {
				pending.delete(id);
				pendingId = null;
				fetching = false;
				_setError(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
				return;
			}
			pending.delete(id);
			pendingId = null;
			fetching = false;
			_setError(new RpcError('TIMEOUT', `Stream '${path}' timed out after 30s`));
		}, _getTimeout());

		pending.set(id, {
			stream: true,
			resolve(response) {
				fetching = false;
				pendingId = null;
				_reconnectAttempts = 0;
				_clearError();
				_status = 'connected';
				_statusStore.set('connected');
				if (topic && topic !== response.topic) _unregisterTopicErrorSetter(topic, _setError);
				topic = response.topic || null;
				if (topic) {
					_registerTopicErrorSetter(topic, _setError);
					ensureDenialsListener();
				}

				// Track sequence number for replay
				if (response.seq !== undefined) _lastSeq = response.seq;

				// Track version for delta sync
				if (response.version !== undefined) _lastVersion = response.version;

				// Install server-provided options BEFORE applying diffs/replay,
				// so _applyMerge uses the correct merge strategy and key field.
				if (response.merge) merge = response.merge;
				if (response.key) key = response.key;
				if (response.prepend !== undefined) prepend = response.prepend;
				if (response.max !== undefined) max = response.max;

				// Handle unchanged response (delta sync - nothing changed)
				if (response.unchanged === true) {
					if (topic && !topicUnsub) {
						const topicStore = on(topic);
						topicUnsub = topicStore.subscribe((envelope) => {
							if (!envelope) return;
							if (!initialLoaded) {
								buffer.push(envelope);
							} else {
								applyEvent(envelope);
							}
						});
					}
					initialLoaded = true;
					// Drain anything buffered between listener attach and now
					if (buffer.length > 0) {
						for (const evt of buffer) _applyMerge(evt);
						if (Array.isArray(currentValue)) currentValue = currentValue.slice();
						store.set(currentValue);
						buffer = [];
					}
					return;
				}

				if (response.delta === true && Array.isArray(response.data)) {
					for (const item of response.data) {
						if (item._deleted) {
							_applyMerge({ event: 'deleted', data: item });
						} else {
							const exists = _index.has(item[key]);
							_applyMerge({ event: exists ? 'updated' : 'created', data: item });
						}
					}
				} else if (response.replay === true && Array.isArray(response.data)) {
					for (const evt of response.data) {
						_applyMerge(evt);
					}
				} else if ((response.channel || response.derived) && currentValue !== undefined) {
					// Keep the existing value so the store never flashes to empty.
					// Channels return an empty placeholder; derived streams may
					// return stale data before their sources populate.
				} else {
					currentValue = response.data;
				}

				_rebuildIndex();

				if (response.hasMore !== undefined) _hasMore = response.hasMore;
				if (response.cursor !== undefined) _cursor = response.cursor;
				if (response.schemaVersion !== undefined) _schemaVersion = response.schemaVersion;

				// Attach topic listener BEFORE flipping initialLoaded, so events
				// arriving between ws.subscribe(topic) (server-side) and now are buffered.
				if (topic && !topicUnsub) {
					const topicStore = on(topic);
					topicUnsub = topicStore.subscribe((envelope) => {
						if (!envelope) return;
						if (!initialLoaded) {
							buffer.push(envelope);
						} else {
							applyEvent(envelope);
						}
					});
				}

				initialLoaded = true;
				if (Array.isArray(currentValue)) currentValue = currentValue.slice();
				store.set(currentValue);
				_recordHistory();

				// Replay buffered messages in batch
				if (buffer.length > 0) {
					for (const evt of buffer) {
						_applyMerge(evt);
					}
					if (Array.isArray(currentValue)) currentValue = currentValue.slice();
					store.set(currentValue);
					_recordHistory();
				}
				buffer = [];
			},
			reject(err) {
				fetching = false;
				pendingId = null;
				_setError(err instanceof RpcError ? err : new RpcError('STREAM_ERROR', err?.message || 'Stream failed'));
			},
			timer
		});

		/** @type {any} */
		const request = { rpc: path, id, args: dynamicArgs || [], stream: true };
		if (_lastSeq !== null) request.seq = _lastSeq;
		if (_lastVersion !== undefined) request.version = _lastVersion;
		if (_schemaVersion !== undefined) request.schemaVersion = _schemaVersion;
		_batchedSubscribe(request);
	}

	/**
	 * Tear down WS-level subscription handles, transient flags, and any
	 * in-flight subscribe request. Leaves the in-memory data model
	 * (currentValue, _index, _history, _lastSeq, _lastVersion, _cursor,
	 * _hasMore, _schemaVersion, topic) intact so that a subscribe() call
	 * landing during the resume-grace window can reattach listeners,
	 * call fetchAndSubscribe() with the retained seq/version/cursor, and
	 * let the server fill the gap from its replay buffer (or fromSeq, or
	 * a truncated -> full rehydrate fallback) instead of cold-starting.
	 */
	function _releaseSubscription() {
		if (pendingId) {
			const entry = pending.get(pendingId);
			if (entry) {
				pending.delete(pendingId);
				if (entry.timer) clearTimer(entry.timer);
			}
			pendingId = null;
		}
		if (topicUnsub) {
			topicUnsub();
			topicUnsub = null;
		}
		if (statusUnsub) {
			statusUnsub();
			statusUnsub = null;
		}
		if (_quiescenceUnsub) {
			_quiescenceUnsub();
			_quiescenceUnsub = null;
		}
		if (_countedInFlight) {
			_countedInFlight = false;
			_removeInFlight();
		}
		if (_reconnectTimer) {
			clearTimer(_reconnectTimer);
			_reconnectTimer = null;
		}
		if (_rafId !== null) {
			cancelAnimationFrame(_rafId);
			_rafId = null;
		}
		_bufA.length = 0;
		_bufB.length = 0;
		_activeBuf = _bufA;
		fetching = false;
	}

	/**
	 * Reset the in-memory data model and error state. Runs when the
	 * resume-grace window expires with no new subscriber, or immediately
	 * on cleanup when resumeGraceMs is 0. After this runs, the next
	 * subscribe() is a true cold start.
	 */
	function _resetSession() {
		if (topic) _unregisterTopicErrorSetter(topic, _setError);
		topic = null;
		initialLoaded = false;
		buffer = [];
		currentValue = undefined;
		store.set(undefined);
		_error = null;
		_errorStore.set(null);
		_status = 'loading';
		_statusStore.set('loading');
		_index.clear();
		_history = [];
		_historyIndex = -1;
		_reconnectAttempts = 0;
		_lastSeq = null;
		_lastVersion = undefined;
		_schemaVersion = initialSchemaVersion;
		_cursor = null;
		_hasMore = false;
		_loadingMore = false;
		_devtoolsStream(path, null, 0, merge);
	}

	/**
	 * Full cleanup: release WS handles AND reset session state. Equivalent
	 * to the pre-grace cleanup; used when resumeGraceMs is 0 (opt-out) or
	 * when grace expires.
	 */
	function cleanup() {
		_releaseSubscription();
		_resetSession();
	}

	/** @type {boolean} Whether a microtask-deferred cleanup is pending (handles rapid sync unsub+resub) */
	let _pendingCleanup = false;
	/** @type {ReturnType<typeof setTimeout> | null} Resume-grace expiry timer; non-null while state is being retained for a possible resume */
	let _resumeGraceTimer = null;
	/** @type {boolean} Whether the stream is in the resume-grace window (released WS, retained data) */
	let _inGracePeriod = false;

	/**
	 * Wire up the per-subscribe lifecycle listeners: quiescence tracking
	 * (registers the stream with the global in-flight counter) and the
	 * reconnect-on-open watcher. Shared between first-subscribe and
	 * resume-from-grace so both paths get the same listener setup.
	 */
	function _attachLifecycleListeners() {
		_quiescenceUnsub = _statusStore.subscribe((s) => {
			const inFlight = s === 'loading' || s === 'reconnecting';
			if (inFlight && !_countedInFlight) {
				_countedInFlight = true;
				_addInFlight();
			} else if (!inFlight && _countedInFlight) {
				_countedInFlight = false;
				_removeInFlight();
			}
		});

		// `status.subscribe` fires synchronously with the current value, which
		// for a stream subscribing during page hydration is usually 'connecting'
		// (since `_connect()` is lazy on the first subscriber). Filter on 'open'
		// first and track whether we've ever seen one, so the FIRST 'open' is
		// the lifetime baseline rather than treating it as a reconnect bounce.
		let hasOpenedOnce = false;
		statusUnsub = status.subscribe((s) => {
			if (s !== 'open') return;
			if (!hasOpenedOnce) {
				hasOpenedOnce = true;
				return;
			}
			if (subCount > 0) {
				_status = 'reconnecting';
				_statusStore.set('reconnecting');
				if (_reconnectTimer) clearTimer(_reconnectTimer);
				let delay;
				// Reconnect jitter: spread a fleet's reconnect attempts across the
				// window so a server restart does not get a thundering-herd retry
				// spike. The seeded RNG is the right primitive here - jitter does
				// not need crypto-quality entropy and is not security-relevant -
				// and routing it through the runtime lets a seeded harness replay
				// the backoff schedule exactly.
				if (_reconnectAttempts < 2) {
					delay = 20 + Math.floor(randomFloat() * 80);
				} else {
					const base = Math.min(1000 * Math.pow(2.2, _reconnectAttempts - 2), 300000);
					delay = Math.floor(base * (0.75 + randomFloat() * 0.5));
				}
				_reconnectAttempts++;
				_reconnectTimer = setTimer(() => {
					_reconnectTimer = null;
					if (topicUnsub) {
						topicUnsub();
						topicUnsub = null;
					}
					initialLoaded = false;
					fetching = false;
					buffer = [];
					fetchAndSubscribe();
				}, delay);
			}
		});

		// Surface terminal close as an error on the stream (adapter 0.4.0)
		try {
			const conn = _connect();
			if (conn && typeof conn.ready === 'function') {
				conn.ready().catch((/** @type {any} */ err) => {
					if (subCount > 0) {
						_setError(new RpcError(err?.code || 'CONNECTION_CLOSED', err?.message || 'Connection permanently closed'));
					}
				});
			}
		} catch {}
	}

	return {
		// Stamped metadata so test-affordances like `subscribeAt`
		// (`svelte-realtime/test-client`) can construct a parallel store
		// at a chosen schemaVersion without needing the user to pass the
		// path string by hand. Not part of the public store contract.
		__streamPath: path,
		__streamOptions: options,
		__streamArgs: dynamicArgs,
		error: { subscribe: _errorStore.subscribe },
		status: { subscribe: _statusStore.subscribe },
		subscribe(fn) {
			if (subCount++ === 0) {
				if (_pendingCleanup) {
					// Rapid sync resub (same microtask) - cancel the pending cleanup,
					// WS subscription is still attached.
					_pendingCleanup = false;
				} else if (_inGracePeriod) {
					// Resume during the grace window: WS handles were released but
					// session state (currentValue, _lastSeq, _lastVersion, _cursor)
					// is intact. Re-attach lifecycle listeners and call
					// fetchAndSubscribe(); the retained cursors ride along on the
					// subscribe envelope so the server can fill the gap from its
					// replay buffer (or fromSeq, or truncated -> full rehydrate).
					if (_resumeGraceTimer) {
						clearTimer(_resumeGraceTimer);
						_resumeGraceTimer = null;
					}
					_inGracePeriod = false;
					// Flip status back to 'loading' so the newly-attached quiescence
					// subscriber sees us as in-flight while the resume envelope is
					// outstanding (it fires synchronously with the current value).
					_status = 'loading';
					_statusStore.set('loading');
					_attachLifecycleListeners();
					fetchAndSubscribe();
					_devtoolsStream(path, topic, subCount, merge);
				} else {
					// First subscriber - start the stream
					fetchAndSubscribe();
					_devtoolsStream(path, topic, subCount, merge);
					_attachLifecycleListeners();
				}
			}

			const unsub = store.subscribe(fn);

			return () => {
				unsub();
				if (--subCount === 0) {
					_pendingCleanup = true;
					microtask(() => {
						if (_pendingCleanup && subCount === 0) {
							_pendingCleanup = false;
							const graceMs = _getResumeGraceMs();
							if (graceMs > 0) {
								// Release WS handles immediately (give server back the
								// subscription, stop counting toward quiescence) but
								// retain session state for graceMs to support pause/resume
								// and back/forward navigation patterns. If a new
								// subscribe() lands before the timer fires, it resumes
								// from the retained seq via fetchAndSubscribe.
								_releaseSubscription();
								_inGracePeriod = true;
								_resumeGraceTimer = setTimer(() => {
									_resumeGraceTimer = null;
									_inGracePeriod = false;
									_resetSession();
								}, graceMs);
							} else {
								cleanup();
							}
						}
					});
				}
			};
		},

		/**
		 * Apply an optimistic update to the store immediately.
		 * Returns a rollback function that undoes the change.
		 *
		 * @param {string} event - 'created', 'updated', 'deleted' (crud); 'set' (set); 'push' (latest)
		 * @param {any} data - The data to apply
		 * @returns {() => void} Rollback function
		 */
		optimistic(event, data) {
			const snapshot = Array.isArray(currentValue) ? currentValue.slice() : currentValue;

			if (merge === 'crud') {
				if (data && data[key] !== undefined) {
					_optimisticKeys.add(data[key]);
				}
			}

			applyEvent({ event, data });

			return function rollback() {
				if (merge === 'crud' && data && data[key] !== undefined) {
					_optimisticKeys.delete(data[key]);
				}
				currentValue = snapshot;
				_rebuildIndex();
				store.set(currentValue);
			};
		},

		/**
		 * Apply an optimistic update + run an async operation with auto-rollback.
		 * The optimistic change applies synchronously; the asyncOp runs after.
		 * If the asyncOp resolves, returns its result and leaves the change
		 * baked in (the server's confirming event will reconcile via the
		 * merge strategy). If the asyncOp rejects (or throws), the optimistic
		 * change is rolled back and the rejection propagates to the caller.
		 *
		 * Two patterns for the optimistic change:
		 *
		 * 1. Event-based (uses the stream's merge strategy):
		 *    `{ event: 'created', data: { id: tempId(), title: 'X' } }`
		 *
		 * 2. Free-form mutator (bypasses merge strategy; full control):
		 *    `(current) => current.filter(t => t.id !== 'foo')`
		 *    The mutator receives a copy of the current value. It can mutate
		 *    and return undefined, OR return a new value. Both styles work.
		 *
		 * Replay-safety: pending mutations are tracked in an in-flight
		 * queue and the displayed value is recomputed by replaying the
		 * queue against the un-overlaid server state after every server
		 * event and every settle. Concurrent failures roll back cleanly:
		 * if mutate A and mutate B are both in flight and both fail, the
		 * displayed state returns to the latest server state with no
		 * phantom traces of either A or B. Server events with a key
		 * matching a queue entry's optimistic key absorb the entry, so
		 * the typical "client generates UUID, server confirms with same
		 * id" flow does not flicker.
		 *
		 * Free-form mutators receive a shallow copy of the current value
		 * (slice for arrays, object spread otherwise). Top-level shape
		 * changes (push, pop, filter, splice) participate in replay
		 * cleanly; in-place mutations of individual items
		 * (e.g. `draft[0].name = 'x'`) are NOT isolated - the draft and
		 * the prior items share references. To mutate an item field,
		 * replace the whole item:
		 * `draft[i] = { ...draft[i], name: 'x' }`.
		 *
		 * @template T
		 * @param {() => Promise<T> | T} asyncOp Function returning a promise (or value).
		 * @param {{ event: string, data: any } | ((current: any) => any)} optimisticChange
		 * @returns {Promise<T>}
		 */
		async mutate(asyncOp, optimisticChange) {
			if (typeof asyncOp !== 'function') {
				throw new Error('[svelte-realtime] mutate(asyncOp, optimisticChange): asyncOp must be a function');
			}
			if (optimisticChange == null) {
				throw new Error('[svelte-realtime] mutate(asyncOp, optimisticChange): optimisticChange is required (use { event, data } or (current) => newValue)');
			}
			const isFunction = typeof optimisticChange === 'function';
			const isEvent = !isFunction
				&& typeof optimisticChange === 'object'
				&& typeof optimisticChange.event === 'string';
			if (!isFunction && !isEvent) {
				throw new Error('[svelte-realtime] mutate: optimisticChange must be { event, data } or a function (current) => newValue');
			}

			if (_optimisticQueue.length >= clientState.maxOptimisticQueueDepth) {
				throw new Error(
					'[svelte-realtime] mutate(): in-flight optimistic queue depth ' +
					_optimisticQueue.length + ' exceeds MAX_OPTIMISTIC_QUEUE_DEPTH=' +
					clientState.maxOptimisticQueueDepth + '. ' +
					'Either the server is unresponsive (mutates are not settling) or ' +
					'the call site is firing mutates faster than the server can confirm. ' +
					'Throttle the call site, or check WS health.'
				);
			}

			let optimisticKey = null;
			if (isEvent) {
				const k = mergeKeyField(merge, key);
				if (k && optimisticChange.data && optimisticChange.data[k] !== undefined) {
					optimisticKey = optimisticChange.data[k];
					if (merge === 'crud') _optimisticKeys.add(optimisticKey);
				}
			}

			if (_optimisticQueue.length === 0) {
				// Default to [] for array-merge types when the loader has not
				// resolved yet (currentValue still undefined). Without this,
				// an early-click optimistic change that does e.g.
				// `(current) => [...current, item]` throws synchronously on
				// `[...undefined]`, the mutate rejects, and the user sees
				// nothing land. The eventual loader response replaces
				// currentValue cleanly via the response path, and the still-
				// in-flight optimistic entry replays against the new
				// _serverValue when the server's confirming event arrives.
				const isArrayMerge = merge === 'crud' || merge === 'presence' || merge === 'cursor' || merge === 'latest';
				const baseline = currentValue === undefined && isArrayMerge ? [] : currentValue;
				_serverValue = Array.isArray(baseline) ? baseline.slice() : baseline;
				_serverIndex = new Map(_index);
			}
			const entry = { change: optimisticChange, optimisticKey, serverConfirmed: false };
			_optimisticQueue.push(entry);
			_recomputeDisplay();

			/** @param {boolean} success */
			const settle = (success) => {
				// optimistic.queue invariant: settle is the only consumer that
				// removes its own entry; the queue-replay refactor relies on
				// the entry shape staying intact between push and settle.
				assert(entry.change != null && typeof entry.serverConfirmed === 'boolean', 'realtime/optimistic.queue.entry.shape', { hasChange: entry.change != null, serverConfirmedType: typeof entry.serverConfirmed });
				const idx = _optimisticQueue.indexOf(entry);
				if (idx >= 0) _optimisticQueue.splice(idx, 1);
				if (entry.optimisticKey !== null) _optimisticKeys.delete(entry.optimisticKey);
				if (success && !entry.serverConfirmed) {
					_serverValue = _applyChange(
						_serverValue,
						/** @type {Map<any, number>} */ (_serverIndex),
						entry.change
					);
				}
				if (_optimisticQueue.length === 0) _drainQueue();
				else _recomputeDisplay();
			};

			let value;
			try {
				value = await asyncOp();
			} catch (err) {
				settle(false);
				throw err;
			}
			settle(true);
			return value;
		},

		/**
		 * Stream-side counterpart to `rpc.createOptimistic`. Equivalent to
		 * `rpc.createOptimistic(this, callArgs, change)`, but reads more
		 * naturally when the test or call site is stream-focused and the
		 * RPC is the variable being passed in.
		 *
		 * @param {{ createOptimistic: Function }} rpc - RPC stub from
		 *   `$live/<module>` (or returned by `__rpc()`).
		 * @param {any[]} callArgs - Arguments to forward to the RPC.
		 * @param {((current: any, args: any[]) => any) | { event: string, data: any }} change
		 * @returns {Promise<any>}
		 */
		createOptimistic(rpc, callArgs, change) {
			if (!rpc || typeof rpc.createOptimistic !== 'function') {
				throw new Error('[svelte-realtime] store.createOptimistic: first argument must be an RPC stub with a .createOptimistic method (use the Vite-generated $live/* exports or __rpc()-built callables)');
			}
			return rpc.createOptimistic(this, callArgs, change);
		},

		/**
		 * Load the next page of data (cursor-based pagination).
		 * The server must return `{ data, hasMore, cursor }` for this to work.
		 *
		 * @param {...any} extraArgs - Additional arguments passed to the server initFn
		 * @returns {Promise<boolean>} Whether more pages are available after this load
		 */
		async loadMore(...extraArgs) {
			if (_loadingMore || !_hasMore || !_cursor) return false;
			if (clientState.terminated) {
				throw new RpcError('CONNECTION_CLOSED', 'Connection permanently closed');
			}
			_loadingMore = true;

			ensureListener();
			const id = _nextId();
			const conn = _connect();

			return new Promise((resolve, reject) => {
				const _startTime = now();
				const timer = setTimer(() => {
					if (now() - _startTime > 90000) {
						pending.delete(id);
						_loadingMore = false;
						reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
						return;
					}
					pending.delete(id);
					_loadingMore = false;
					reject(new RpcError('TIMEOUT', `loadMore '${path}' timed out after 30s`));
				}, _getTimeout());

				pending.set(id, {
					stream: true,
					resolve(response) {
						_loadingMore = false;
						if (response.hasMore !== undefined) _hasMore = response.hasMore;
						if (response.cursor !== undefined) _cursor = response.cursor;

						if (Array.isArray(response.data) && Array.isArray(currentValue)) {
							if (prepend) {
								currentValue = response.data.concat(currentValue);
							} else {
								currentValue = currentValue.concat(response.data);
							}
						} else if (response.data !== undefined) {
							currentValue = response.data;
						}

						_rebuildIndex();
						store.set(currentValue);
						resolve(_hasMore);
					},
					reject(err) {
						_loadingMore = false;
						reject(err instanceof RpcError ? err : new RpcError('LOAD_MORE_ERROR', err?.message || 'Load more failed'));
					},
					timer
				});

				conn.sendQueued({
					rpc: path,
					id,
					args: [...(dynamicArgs || []), ...extraArgs],
					stream: true,
					cursor: _cursor
				});
			});
		},

		/**
		 * Whether more pages are available for loading.
		 * @returns {boolean}
		 */
		get hasMore() {
			return _hasMore;
		},

		/**
		 * Pre-populate the stream with SSR data.
		 * On first subscribe, sends the stream RPC to subscribe for live updates
		 * but keeps the SSR data visible (does not reset to undefined).
		 *
		 * @param {any} initialData - Data from the server load function
		 * @returns {{ subscribe: Function, optimistic: Function, hydrate: Function }}
		 */
		hydrate(initialData) {
			// Dev-only shape check: keyed and array-shaped merge strategies
			// (crud, latest, presence, cursor) hand later code an array; if a
			// load() callsite returns the wrong shape (a forgotten `.data`
			// unwrap, an object instead of an array, etc.), the failure surfaces
			// downstream as a confusing TypeError. Warn early with the stream
			// path and merge name so the fix is obvious. Stripped in production.
			if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
				if (initialData != null && merge !== 'set' && !Array.isArray(initialData)) {
					console.warn(
						`[svelte-realtime] hydrate('${path}') merge='${merge}' expects an array, got ` +
						(typeof initialData === 'object' ? initialData.constructor?.name || 'object' : typeof initialData) +
						'.\n  See: https://svti.me/merge'
					);
				}
			}
			currentValue = initialData;
			_rebuildIndex();
			store.set(currentValue);
			return this;
		},

		/**
		 * Enable history tracking for undo/redo.
		 * @param {number} [maxSize] - Maximum history entries (default 50)
		 */
		enableHistory(maxSize) {
			_historyEnabled = true;
			if (maxSize !== undefined) _historyMax = maxSize;
			// Record current state as the baseline
			if (_history.length === 0 && currentValue !== undefined) {
				const snapshot = Array.isArray(currentValue) ? [...currentValue] : currentValue;
				_history.push(snapshot);
				_historyIndex = 0;
			}
		},

		/**
		 * Undo the last change. Restores the previous snapshot.
		 */
		undo() {
			if (!_historyEnabled) {
				_historyEnabled = true;
				// Record baseline snapshot (same as enableHistory)
				if (_history.length === 0 && currentValue !== undefined) {
					const snapshot = Array.isArray(currentValue) ? [...currentValue] : currentValue;
					_history.push(snapshot);
					_historyIndex = 0;
				}
				return;
			}
			if (_historyIndex <= 0) return;
			_historyIndex--;
			currentValue = Array.isArray(_history[_historyIndex])
				? [..._history[_historyIndex]]
				: _history[_historyIndex];
			_rebuildIndex();
			store.set(currentValue);
		},

		/**
		 * Redo the last undone change.
		 */
		redo() {
			if (!_historyEnabled) {
				_historyEnabled = true;
				// Record baseline snapshot (same as enableHistory)
				if (_history.length === 0 && currentValue !== undefined) {
					const snapshot = Array.isArray(currentValue) ? [...currentValue] : currentValue;
					_history.push(snapshot);
					_historyIndex = 0;
				}
				return;
			}
			if (_historyIndex >= _history.length - 1) return;
			_historyIndex++;
			currentValue = Array.isArray(_history[_historyIndex])
				? [..._history[_historyIndex]]
				: _history[_historyIndex];
			_rebuildIndex();
			store.set(currentValue);
		},

		/**
		 * Whether there are entries to undo.
		 * @returns {boolean}
		 */
		get canUndo() {
			return _historyEnabled && _historyIndex > 0;
		},

		/**
		 * Whether there are entries to redo.
		 * @returns {boolean}
		 */
		get canRedo() {
			return _historyEnabled && _historyIndex < _history.length - 1;
		},

		/**
		 * Pause history recording. Events still apply to the store value,
		 * but no snapshots are saved to the undo stack.
		 */
		pauseHistory() {
			_historyPaused = true;
		},

		/**
		 * Resume history recording after a pause.
		 * Records the current value as a snapshot so undo returns to
		 * the state at resume-time rather than before the pause.
		 */
		resumeHistory() {
			if (!_historyPaused) return;
			_historyPaused = false;
			_recordHistory();
		},

		/**
		 * Return a Svelte 5 reactive object backed by this stream's value.
		 *
		 * Internally calls `fromStore` from `svelte/store` (Svelte 5 only):
		 * the returned object exposes a single `current` getter; reading
		 * `current` inside an effect or component subscribes via
		 * `createSubscriber` for fine-grained reactivity, and reading it
		 * outside an effect synchronously returns the latest value.
		 *
		 * Throws under Svelte 4 (where `fromStore` is not exported). Apps
		 * still on Svelte 4 should use the existing `Readable<T>` interface
		 * via the `$store` auto-subscribe syntax.
		 *
		 * @returns {{ readonly current: any }}
		 *
		 * @example
		 * ```svelte
		 * <script>
		 *   import { todos } from '$live/todos';
		 *   const items = todos.rune();
		 * </script>
		 *
		 * <p>{items.current?.length ?? 0} items</p>
		 * {#each items.current ?? [] as todo}<li>{todo.title}</li>{/each}
		 * ```
		 */
		rune() {
			if (typeof _svelteStore.fromStore !== 'function') {
				throw new Error(
					'[svelte-realtime] .rune() requires Svelte 5 (svelte/store does not export fromStore)'
				);
			}
			return _svelteStore.fromStore(this);
		},

		/**
		 * Project each item of the stream's array through `fn`. Returns a
		 * mapped store with the same `{ subscribe, rune, map }` shape as the
		 * source, so it composes both with `$`-prefix auto-subscription
		 * (`$mapped`) and with `.rune()` for Svelte 5 fine-grained
		 * reactivity, and chains via further `.map()` calls.
		 *
		 * Semantics match the documented `($stream ?? []).map(fn)` pattern:
		 * a null or undefined source emits `[]`; an array source emits
		 * `source.map(fn)`; a non-array source emits `[]` after a dev-mode
		 * console.warn (set-merge streams and paginated wrappers are not
		 * arrays at the top level - users should `.map()` over the array
		 * field themselves).
		 *
		 * Avoids the `$derived(() => ...)` footgun: the value is a store,
		 * not a function reference, so no rune-helper confusion is possible.
		 *
		 * @template T, U
		 * @param {(item: T) => U} fn
		 * @returns {{ subscribe: (fn: (v: U[]) => void) => () => void, rune: () => { readonly current: U[] }, map: <V>(g: (item: U) => V) => any }}
		 *
		 * @example
		 * ```svelte
		 * <script>
		 *   import { todos } from '$live/todos';
		 *   const titles = todos.map(t => t.title);
		 * </script>
		 *
		 * {#each $titles as title}<li>{title}</li>{/each}
		 * ```
		 */
		map(fn) {
			if (typeof fn !== 'function') {
				throw new Error('[svelte-realtime] .map(fn): fn must be a function');
			}
			return _createMappedStore(this, fn);
		},

		/**
		 * Return a wrapper store that only activates when `condition` is truthy.
		 * When condition becomes falsy, the underlying subscription is cleaned up.
		 *
		 * Accepts a boolean, a Svelte store (object with .subscribe), or a
		 * getter function (() => boolean). Stores and functions are reactive:
		 * the stream subscribes/unsubscribes as the condition changes.
		 *
		 * @param {boolean | { subscribe: Function } | (() => boolean)} condition
		 * @returns {{ subscribe: Function }}
		 */
		when(condition) {
			const self = this;
			let innerUnsub = null;
			let currentVal = undefined;
			/** @type {Set<(v: any) => void>} */
			const subs = new Set();
			let subCount = 0;
			let active = false;
			/** @type {(() => void) | null} */
			let conditionUnsub = null;

			function activate() {
				if (innerUnsub) return;
				active = true;
				innerUnsub = self.subscribe((v) => {
					currentVal = v;
					for (const s of subs) s(currentVal);
				});
			}

			function deactivate() {
				if (!innerUnsub) return;
				active = false;
				innerUnsub();
				innerUnsub = null;
				currentVal = undefined;
				for (const s of subs) s(currentVal);
			}

			function handleCondition(value) {
				if (value && subCount > 0) {
					activate();
				} else if (!value) {
					deactivate();
				}
			}

			// Determine condition type
			const isStore = condition && typeof condition === 'object' && typeof condition.subscribe === 'function';
			const isFn = typeof condition === 'function';

			return {
				subscribe(fn) {
					if (subCount++ === 0) {
						if (isStore) {
							conditionUnsub = condition.subscribe((v) => handleCondition(v));
						} else if (isFn) {
							// Poll the getter on subscribe. For true reactivity with
							// Svelte 5 $state, users should wrap in $derived or pass a store.
							handleCondition(condition());
						} else if (condition) {
							activate();
						}
					}
					subs.add(fn);
					fn(currentVal);

					return () => {
						subs.delete(fn);
						if (--subCount === 0) {
							deactivate();
							if (conditionUnsub) {
								conditionUnsub();
								conditionUnsub = null;
							}
						}
					};
				}
			};
		}
	};
}
