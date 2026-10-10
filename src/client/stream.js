// @ts-check
import * as _adapterClient from 'svelte-adapter-uws/client';
import { MAX_RPC_BATCH_CALLS, STREAM_BATCH_BYTES } from '../shared/rpc-limits.js';
// Server-managed subscription marking. Older adapters (before the wire-subscribe
// authorization surface) lack it; degrade to a no-op, which leaves the prior
// behavior exactly (the client sends its redundant subscribe frame, and no gate
// is armed to reject it). Guarded once at module load.
const setTopicManaged = typeof _adapterClient.setTopicManaged === 'function'
	? _adapterClient.setTopicManaged
	: () => {};
const _hasManagedMarking = typeof _adapterClient.setTopicManaged === 'function';
const _NO_OPTIMISTIC_KEY = Symbol('no optimistic key');

// The adapter sends the wire unsubscribe when its final local subscription
// is released, including managed topics. Keep an adapter ref while a stream
// or an in-flight subscribe still owns the server membership, so releasing
// the data listener cannot race a later subscribe answer. The adapter also
// counts consumers outside this module and owns the single wire release.
//
// A release frame must never overtake a subscribe the server is still
// handling. The server names a request's wire topic (its attach frame) before
// it subscribes the socket, so an unsubscribe for that topic processed in
// between would either leave the subscription with nothing left to release it
// or cut the subscription of a stream about to bind the topic. Until a sent
// subscribe is named it could be for any topic, so releases wait while one a
// stream still waits for is outstanding, each for at most one RPC timeout;
// once named, the stream that sent it holds a ref on the topic, which keeps
// any other release for it off the wire. A request no stream waits for any
// more is not waited on: its orphan record releases what it subscribed after
// its answer. A page request (`loadMore`) subscribes the socket again too,
// and holds the stream's topic until it is answered.
/** @type {Map<string, { count: number, release: () => void }>} managed adapter refs */
const _managedTopicRefs = new Map();

/** @type {number} Live stream subscribes on the wire whose topic the server has not named yet */
let _unnamedSubscribes = 0;

/** @type {Array<{ topic: string, at: number }>} releases waiting for `_unnamedSubscribes` to drain, oldest first */
const _waitingReleases = [];

/** @type {ReturnType<typeof setTimeout> | null} Sends the oldest waiting release once it has waited a full timeout */
let _waitingTimer = null;

function _managedRefAcquire(t) {
	const held = _managedTopicRefs.get(t);
	if (held) { held.count++; return; }
	setTopicManaged(t);
	const release = _conn().on(t).subscribe(() => {});
	_managedTopicRefs.set(t, { count: 1, release });
}

// Releasing the held adapter ref lets the adapter send the unsubscribe once
// its last consumer leaves. A live unnamed subscribe delays that release.
function _sendManagedRelease(releasedTopic) {
	if (_unnamedSubscribes > 0) {
		// Whichever of those subscribes ends first re-checks the wait and arms
		// the deadline (each ends within a timeout of being sent).
		_waitingReleases.push({ topic: releasedTopic, at: monotonicNow() });
		return;
	}
	_releaseManagedRef(releasedTopic);
}

function _releaseManagedRef(releasedTopic) {
	const held = _managedTopicRefs.get(releasedTopic);
	if (!held || --held.count > 0) return;
	_managedTopicRefs.delete(releasedTopic);
	held.release();
}

function _armWaitingTimer() {
	const wait = _waitingReleases[0].at + _getTimeout() - monotonicNow();
	_waitingTimer = setTimer(() => {
		_waitingTimer = null;
		_releaseWaiting();
	}, wait > 0 ? wait : 0);
}

/**
 * Send the waiting releases once no live subscribe is unnamed, and any that
 * has waited a full timeout regardless: subscribes that keep overlapping
 * must not hold a release back for good. A release sent at its deadline can
 * still reach the server ahead of a subscribe to its topic sent in the last
 * round-trip before it; that is what bounding the wait costs.
 */
function _releaseWaiting() {
	if (_waitingReleases.length === 0) return;
	let due = _waitingReleases.length;
	if (_unnamedSubscribes > 0) {
		const since = monotonicNow() - _getTimeout();
		due = 0;
		while (due < _waitingReleases.length && _waitingReleases[due].at <= since) due++;
	}
	const out = _waitingReleases.splice(0, due);
	if (_waitingTimer !== null && (out.length > 0 || _waitingReleases.length === 0)) {
		clearTimer(_waitingTimer);
		_waitingTimer = null;
	}
	if (_waitingReleases.length > 0 && _waitingTimer === null) _armWaitingTimer();
	for (const w of out) _releaseManagedRef(w.topic);
}

/**
 * A stream subscribe request from the moment it is queued until nobody waits
 * for its answer. `state` is 'queued' (in the microtask batch), 'sent', or
 * 'done' (answered, failed, withdrawn before the batch went out, or handed to
 * an orphan record); `topic` is the wire topic once the server names it.
 * @typedef {{ request: any, state: 'queued' | 'sent' | 'done', topic: string | null }} SubscribeTicket
 */

/**
 * The server named a sent request's wire topic.
 * @param {SubscribeTicket} ticket
 * @param {string} namedTopic
 */
function _subscribeNamed(ticket, namedTopic) {
	if (ticket.topic !== null) return;
	ticket.topic = namedTopic;
	if (ticket.state === 'sent') {
		_unnamedSubscribes--;
		_releaseWaiting();
	}
}

/**
 * Its stream no longer waits for the request: answered, failed, or handed to
 * an orphan record.
 * @param {SubscribeTicket} ticket
 */
function _subscribeDone(ticket) {
	const unnamed = ticket.state === 'sent' && ticket.topic === null;
	ticket.state = 'done';
	if (unnamed) {
		_unnamedSubscribes--;
		_releaseWaiting();
	}
}

/**
 * Keep answering a subscribe (or a `loadMore` page, which subscribes too)
 * whose stream stopped waiting for it: released, timed out, or superseded by
 * a newer subscribe. The server may still subscribe the socket, and nothing
 * else would release that before the socket closes. When the answer arrives,
 * the topic it names is released, and so is the ref the stream handed over
 * with the request; while another local stream holds the topic the release
 * stays off the wire. Without an answer the record gives up one timeout
 * after the socket is up, releasing the topic the attach frame named, if any.
 *
 * A request never named when the socket drops may still be in the adapter's
 * send queue, which goes out on the next open, so on a disconnect such a
 * record lets go of the handed-over ref (a subscription of the dropped
 * socket) and parks until the socket is back. `parked` creates it that way,
 * for a request the disconnect itself rejected. On a connection closed for
 * good ('failed') nothing is kept.
 * @param {string} id
 * @param {SubscribeTicket} ticket
 * @param {string | null} heldTopic - managed ref taken over from the stream
 * @param {boolean} [parked]
 */
function _orphanSubscribe(id, ticket, heldTopic, parked) {
	_subscribeDone(ticket);
	const prev = pending.get(id);
	if (prev && prev.timer) clearTimer(prev.timer);
	/** @param {any} answeredTopic */
	const release = (answeredTopic) => {
		if (_hasManagedMarking && typeof answeredTopic === 'string') {
			_managedRefAcquire(answeredTopic);
			_sendManagedRelease(answeredTopic);
		}
		if (heldTopic) _sendManagedRelease(heldTopic);
	};
	const record = {
		stream: true,
		/** @type {any} */
		timer: null,
		/** @param {string | null | undefined} namedTopic */
		attach(namedTopic) {
			if (namedTopic && ticket.topic === null) ticket.topic = namedTopic;
		},
		/** @param {any} response */
		resolve(response) {
			release(response && response.topic);
		},
		/** @param {any} err */
		reject(err) {
			if (err && err.code === 'DISCONNECTED' && ticket.topic === null) park();
			else release(null);
		},
		/** The socket came back up: start waiting for the answer. */
		wake() {
			if (record.timer === null && pending.get(id) === record) arm();
		}
	};
	const arm = () => {
		record.timer = setTimer(() => {
			record.timer = null;
			if (pending.get(id) === record) pending.delete(id);
			release(ticket.topic);
		}, _getTimeout());
	};
	const park = () => {
		record.timer = null;
		// The handed-over ref named a subscription of the dropped socket; only
		// the answer to a request still queued can subscribe again.
		if (heldTopic) _sendManagedRelease(heldTopic);
		heldTopic = null;
		// The disconnect loop deleted the entry before rejecting it; re-adding
		// it while that loop runs would have it rejected again. A connection
		// closed for good sends nothing more and answers nothing.
		microtask(() => {
			if (!clientState.terminated) pending.set(id, record);
		});
	};
	if (parked) {
		park();
		return;
	}
	if (clientState.terminated) {
		pending.delete(id);
		release(null);
		return;
	}
	pending.set(id, record);
	if (clientState.socketUp) arm();
}
import { writable } from 'svelte/store';
// Namespace import lets .rune() access fromStore (Svelte 5 only) without
// breaking the module under Svelte 4 - missing exports become undefined,
// not module-load errors.
import * as _svelteStore from 'svelte/store';
import { assert } from '../shared/assert.js';
import { mergeKeyField, rebuildIndex } from '../shared/merge.js';
import { sanitizeRowData } from '../shared/safe-assign.js';
import { now, monotonicNow, randomFloat, setTimer, clearTimer, microtask } from '../client-runtime.js';
import { createJitterDispatch } from './jitter-dispatch.js';
import { _devtoolsStream, _devtoolsStreamEvent, _devtoolsStreamError } from './devtools-instrument.js';
import { clientState, RpcError, _IS_DEV, _useRAF, _nextId, pending } from './internal-state.js';
import { _addInFlight, _removeInFlight } from './health.js';
import { _conn, _closedForGoodNow, ensureListener, ensureDisconnectListener, ensureDenialsListener, _getTimeout, _getResumeGraceMs, _getResumeMaxCursorAgeMs, _registerTopicErrorSetter, _unregisterTopicErrorSetter } from './connection.js';
import { _maybeHintPublishRate } from './rpc.js';

/**
 * First-class reactive-stream primitive for Svelte 5 fine-grained reactivity:
 * wrap any store-shaped source (an object with `subscribe`, or a bare
 * subscribe function) into a `{ readonly current }` handle backed by Svelte's
 * `createSubscriber` protocol - only the `$derived` / template expressions
 * that actually READ `.current` re-evaluate when the source updates, and the
 * upstream subscription starts on first read and stops when the last reader's
 * effect tears down.
 *
 * Implemented over `svelte/store`'s `fromStore`, which drives
 * `createSubscriber` internally on Svelte 5.7+ - routing through the store
 * module (a namespace import whose missing exports become `undefined`, not
 * module-load errors) is what keeps this file loadable under the `^4 || ^5`
 * peer range while `svelte/reactivity` itself only exists on 5. Under Svelte
 * 4 this throws with guidance; the `{ subscribe }` store contract is the
 * version-portable baseline.
 *
 * `.rune()` on every stream/mapped store delegates here; the generated $live
 * accessors expose it the same way (`todos.rune()` in a component).
 *
 * @param {{ subscribe: (fn: (value: any) => void) => (() => void) } | ((fn: (value: any) => void) => (() => void))} source
 * @returns {{ readonly current: any }}
 */
export function createReactiveStream(source) {
	if (typeof _svelteStore.fromStore !== 'function') {
		throw new Error(
			'[svelte-realtime] createReactiveStream / .rune() requires Svelte 5 (svelte/store does not export fromStore)'
		);
	}
	const store = typeof source === 'function' ? { subscribe: source } : source;
	if (!store || typeof store.subscribe !== 'function') {
		throw new Error('[svelte-realtime] createReactiveStream requires a store ({ subscribe }) or a subscribe function');
	}
	return _svelteStore.fromStore(/** @type {any} */ (store));
}

/**
 * Microtask-batched stream subscribe RPCs.
 * Coalesces subscribe RPCs within one microtask into bounded batch frames.
 * @type {Array<any> | null}
 */
let _subscribeBatch = null;

/**
 * Publishers remembered per cursor key, or per presence key and field. Every
 * reconnect of one identity publishes under a fresh publisher id, so a
 * long-lived entry accumulates them; only the most recently active can still
 * have a frame in flight, so the least recently active is forgotten first.
 */
const _ORDER_MARKS_MAX = 4;

/**
 * Does a cursor / presence-field frame carry an ordering token? `_p` names the
 * publishing connection and `_n` counts that connection's publishes.
 * @param {any} data
 */
function _isOrdered(data) {
	return typeof data._p === 'string' && typeof data._n === 'number';
}

/**
 * Admit an ordered frame unless its publisher has already delivered this
 * sequence or a later one, and record it as that publisher's newest. Frames
 * from different publishers are never ordered against each other: no clock is
 * shared between two connections, or between the replicas behind them, that
 * could decide it, so they apply in arrival order.
 * @param {Map<string, number>} marks
 * @param {any} data
 * @returns {boolean} false when the frame is superseded
 */
function _admitOrdered(marks, data) {
	const p = data._p;
	const seen = marks.get(p);
	if (seen !== undefined) {
		if (data._n <= seen) return false;
		if (marks.size > 1) marks.delete(p);
	} else if (marks.size >= _ORDER_MARKS_MAX) {
		marks.delete(marks.keys().next().value);
	}
	marks.set(p, data._n);
	return true;
}

/**
 * Queue a stream subscribe RPC to be sent in a batch within the current microtask.
 * If only one request queues, it's sent as a single frame (no batch overhead).
 * @param {SubscribeTicket} ticket
 */
function _batchedSubscribe(ticket) {
	if (!_subscribeBatch) {
		_subscribeBatch = [];
		microtask(_flushSubscribeBatch);
	}
	_subscribeBatch.push(ticket);
}

/** Bound JSON primitive bytes without calling application toJSON/getters. */
function _primitiveJsonBound(value) {
	if (typeof value === 'string') return value.length * 6 + 2;
	if (typeof value === 'number') return 25;
	if (value === null || value === undefined) return 4;
	if (typeof value === 'boolean') return 5;
	return Infinity;
}

/** Complex arguments travel alone so measuring them cannot serialize twice. */
function _subscribeByteBound(request) {
	let bytes = 128 + _primitiveJsonBound(request.rpc) + _primitiveJsonBound(request.id)
		+ _primitiveJsonBound(request.seq) + _primitiveJsonBound(request.version) + _primitiveJsonBound(request.schemaVersion);
	for (const arg of request.args) {
		bytes += _primitiveJsonBound(arg) + 1;
		if (bytes > STREAM_BATCH_BYTES) break;
	}
	return bytes;
}

function _sendSubscribeRange(conn, requests, start, end) {
	if (end <= start) return;
	conn.sendQueued(end - start === 1 ? requests[start]
		: { batch: start === 0 && end === requests.length ? requests : requests.slice(start, end) });
}

/** @type {number} Streams whose last subscriber left and whose cleanup microtask has not run yet */
let _cleanupsPending = 0;

/** @param {boolean} [deferred] */
function _flushSubscribeBatch(deferred) {
	// A stream released in the same tick cleans up in a microtask queued
	// before this one ran: one more hop lets its release frame go out ahead
	// of these subscribes (a room switch leaves the old room before it joins
	// the new one).
	if (_cleanupsPending > 0 && !deferred) {
		microtask(() => _flushSubscribeBatch(true));
		return;
	}
	const queued = _subscribeBatch;
	_subscribeBatch = null;
	if (!queued) return;
	/** @type {any[]} */
	const requests = [];
	for (const ticket of queued) {
		// Settled before the batch went out: its stream let go of it (a
		// subscribe and unsubscribe in one tick, as `get(store)` does), or a
		// disconnect rejected it. The server never sees it.
		if (ticket.state !== 'queued') continue;
		ticket.state = 'sent';
		_unnamedSubscribes++;
		requests.push(ticket.request);
	}
	if (requests.length === 0) return;
	const conn = _conn();
	if (requests.length === 1) {
		conn.sendQueued(requests[0]);
		return;
	}
	// A split can land between a room's data stream and its :owner or
	// :presence subscribe, which the server pairs within one frame; that
	// pairing is soft, and the joiner's own join corrects its view.
	let start = 0;
	let bytes = 11; // {"batch":[]} plus one comma per following entry.
	for (let i = 0; i < requests.length; i++) {
		const bound = _subscribeByteBound(requests[i]);
		if (i > start && (i - start === MAX_RPC_BATCH_CALLS || bytes + bound + 1 > STREAM_BATCH_BYTES)) {
			_sendSubscribeRange(conn, requests, start, i);
			start = i;
			bytes = 11;
		}
		bytes += bound + (i > start ? 1 : 0);
		if (bound > STREAM_BATCH_BYTES) {
			// Keep the transport's existing individual-request size contract.
			_sendSubscribeRange(conn, requests, i, i + 1);
			start = i + 1;
			bytes = 11;
		}
	}
	_sendSubscribeRange(conn, requests, start, requests.length);
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
		// `svelte-realtime/testing/client`) can construct a parallel store
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
 * renders. Used by `svelte-realtime/testing/client`'s `subscribeAt`; not
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
 * projects per-item over the source's array (the
 * `($source ?? []).map(fn)` semantic).
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
			return createReactiveStream(this);
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
 *   `subscribeAt` helper from `svelte-realtime/testing/client`.
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

	// The per-subscription attach lifecycle, distinct from `status` (a health
	// projection): initialized -> attaching -> attached -> detached | failed.
	// `attaching` covers every in-flight subscribe envelope (first attach,
	// reconnect, resume); `attached` means the server confirmed the
	// subscription (the loader response IS the ack - no separate frame
	// exists on the wire); `detached` means the WS handles are released
	// (explicit detach() or the resume-grace release); `failed` tracks the
	// error state until a retry re-enters `attaching`.
	/** @type {'initialized' | 'attaching' | 'attached' | 'detached' | 'failed'} */
	let _phase = 'initialized';
	const _phaseStore = writable(/** @type {'initialized' | 'attaching' | 'attached' | 'detached' | 'failed'} */ ('initialized'));

	function _setPhase(/** @type {'initialized' | 'attaching' | 'attached' | 'detached' | 'failed'} */ p) {
		if (_phase === p) return;
		_phase = p;
		_phaseStore.set(p);
	}

	function _setError(/** @type {RpcError} */ err) {
		_error = err;
		_errorStore.set(err);
		_status = 'error';
		_statusStore.set('error');
		_setPhase('failed');
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

	/** @type {string | null} Managed wire topic this instance holds a `_managedTopicRefs` ref on (see the module-level release machinery). */
	let _managedHeldTopic = null;

	/** @type {(() => void) | null} */
	let statusUnsub = null;

	/** @type {(() => void) | null} Per-stream subscriber that maintains the global in-flight counter. */
	let _quiescenceUnsub = null;
	/** @type {boolean} Whether this stream is currently counted in `_inFlightCount`. */
	let _countedInFlight = false;

	let subCount = 0;
	let pendingId = null;
	/** @type {SubscribeTicket | null} The in-flight subscribe request `pendingId` names */
	let _ticket = null;

	/**
	 * @type {number | null} Wall-clock ms since which the retained replay
	 * cursor may be stale, or null while it is current. Stamped when the
	 * subscription stops delivering (a socket drop the lifecycle listener sees,
	 * before or after its first open) or carried in from a grace release on a
	 * resume; cleared when the cursor is refreshed (an answer, or a reconnect
	 * about to refetch). Lets a reconnect measure how long the cursor has been
	 * stale and rehydrate fully past the trust bound instead of gap-filling
	 * from an outdated seq.
	 */
	let _downAt = null;

	/** @type {boolean} The lifecycle listener has seen an open and the socket is not open now (a hidden tab, an outage) */
	let _listenerDown = false;

	/**
	 * @type {number | null} Wall-clock ms when the WS subscription was released
	 * into the resume-grace window, or null outside it. A resume-from-grace ages
	 * its retained cursor from the EARLIER of this and _downAt (a socket that
	 * dropped before the unsubscribe started aging the cursor sooner), so grace
	 * resumes apply the same cursor time-check as a live reconnect.
	 */
	let _graceStartAt = null;

	/** @type {number | null} Last known sequence number for replay */
	let _lastSeq = null;

	/**
	 * Per-key, per-field publisher marks for presence field updates, so a field
	 * update its publisher already superseded for the SAME field is ignored
	 * while updates to other fields still apply. Cleared on leave, set, and
	 * every snapshot.
	 * @type {Map<any, Map<string, Map<string, number>>>}
	 */
	const _presenceFieldOrder = new Map();

	/**
	 * Presence keys whose entry a field update created before any join for
	 * the key arrived. The join lands on such an entry instead of replacing
	 * it. Cleared on leave, set, refreshed, and every snapshot.
	 * @type {Set<any>}
	 */
	const _presenceSeeded = new Set();

	/**
	 * Per-key marks for a cursor key's OTHER publishers. The held entry is its
	 * own publisher's newest sample, so a key needs marks here only once a
	 * second connection publishes under it (a reconnect, a second tab).
	 * Cleared on remove, set, and every snapshot.
	 * @type {Map<any, Map<string, number>>}
	 */
	const _cursorOrder = new Map();

	/**
	 * Admit a cursor sample against the entry held for its key, keeping the
	 * displaced publisher's mark when a different connection takes over.
	 * With one connection per peer, the common case, this is one comparison
	 * against the held entry and no map is touched.
	 * @param {any} held
	 * @param {any} data
	 * @returns {boolean} false when the sample is superseded
	 */
	function _admitCursor(held, data) {
		if (_isOrdered(data)) {
			if (held._p === data._p && typeof held._n === 'number') return data._n > held._n;
			const marks = _cursorOrder.get(data.key);
			if (marks !== undefined) {
				const seen = marks.get(data._p);
				if (seen !== undefined) {
					if (data._n <= seen) return false;
					// It becomes the held entry, which carries its mark.
					marks.delete(data._p);
				}
			}
		}
		if (_isOrdered(held) && held._p !== data._p) {
			let marks = _cursorOrder.get(data.key);
			if (marks === undefined) {
				marks = new Map();
				_cursorOrder.set(data.key, marks);
			} else if (marks.size >= _ORDER_MARKS_MAX - 1) {
				// The held entry is one of the remembered publishers.
				marks.delete(marks.keys().next().value);
			}
			marks.set(held._p, held._n);
		}
		return true;
	}

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

	/** @type {RpcError | null} The error this stream showed for the close for good */
	let _closedError = null;

	/** @type {number} Consecutive reconnect attempts (reset on successful fetch) */
	let _reconnectAttempts = 0;

	let _warnedMissingKey = false;
	function _warnMissingKey() {
		if (!_IS_DEV || _warnedMissingKey) return;
		_warnedMissingKey = true;
		console.warn('[svelte-realtime] stream ' + path + ' ignored a row missing key "' + mergeKeyField(merge, key) + '". Every row in a keyed stream must carry its key.');
	}

	function _limitRows(value) {
		if (!Array.isArray(value) || merge === 'set' || !max || value.length <= max) return value;
		return prepend && merge !== 'latest' ? value.slice(0, max) : value.slice(-max);
	}

	/** Validate array ingress without modifying the caller's snapshot. */
	function _prepareRows(value) {
		if (!Array.isArray(value)) return value;
		if (merge !== 'set' && merge !== 'latest') {
			const field = mergeKeyField(merge, key);
			if (value.some((row) => row == null || row[field] === undefined)) {
				_warnMissingKey();
				value = value.filter((row) => row != null && row[field] !== undefined);
			}
		}
		return _limitRows(value);
	}

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
	 * Apply one loadMore page to a (value, index) pair and return a fresh
	 * array reference (the index is rebuilt for it in place).
	 *
	 * For keyed merge strategies the page is deduped against the index
	 * first: an entry whose key is already present (typically received
	 * earlier as a live 'created' event and later re-served by the page
	 * slice) replaces the existing row in place instead of being
	 * concatenated. A blind concat would put the same key in the array
	 * twice, and a keyed {#each} throws each_key_duplicate on duplicates
	 * and aborts the render before the DOM commit. A page row supersedes
	 * a plain optimistic row carrying the same key (queue-mode overlays
	 * are instead protected by the caller routing the page to
	 * _serverValue and replaying the queue on top). `set` / `latest` keep
	 * plain concat (no key index exists to dedupe against).
	 *
	 * Keyless rows are ignored with a development warning. The configured max
	 * bounds paged data just as it bounds incoming live data.
	 *
	 * @param {any[]} value
	 * @param {Map<any, number>} index
	 * @param {any[]} page
	 * @returns {any[]}
	 */
	function _appendPage(value, index, page) {
		let base = value;
		let fresh = page;
		if (merge !== 'set' && merge !== 'latest') {
			const k = mergeKeyField(merge, key);
			/** @type {Map<any, number>} key -> position in `fresh`, so a page that repeats a key keeps only its last row */
			const pagePos = new Map();
			fresh = [];
			for (const item of page) {
				const kv = item != null ? item[k] : undefined;
				if (kv === undefined) {
					_warnMissingKey();
					continue;
				}
				const existing = index.get(kv);
				if (existing !== undefined) {
					// Copy before the first in-place write: `value` may be an
					// array the store has already emitted, or - after hydrate() -
					// the caller's own load() data, which must never be mutated.
					// Copy-on-first-write keeps the common no-overlap page free
					// of the extra copy (the concat below already allocates).
					if (base === value) base = value.slice();
					base[existing] = item;
					continue;
				}
				const seen = pagePos.get(kv);
				if (seen !== undefined) {
					fresh[seen] = item;
					continue;
				}
				pagePos.set(kv, fresh.length);
				fresh.push(item);
			}
		}
		const next = _limitRows(prepend ? fresh.concat(base) : base.concat(fresh));
		_rebuildIndexFn(next, index);
		return next;
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

	/** Advance the monotonic resume cursor from an envelope that is not applied. @param {any} envelope */
	function _advanceSeq(envelope) {
		if (envelope && envelope.seq !== undefined && (_lastSeq === null || envelope.seq > _lastSeq)) _lastSeq = envelope.seq;
	}

	/**
	 * Pure functional core of `_applyMerge`. Mutates the supplied `value`,
	 * `index` in place; closure constants
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
	 * @param {boolean} [local] - the change is this client's own optimistic
	 *   change replayed over a copy of the server state for display, not a
	 *   server frame: it applies as given and neither reads nor moves the
	 *   cursor / presence publisher marks, which describe the server state's
	 *   ordering only.
	 * @returns {{ value: any, replaced: boolean, modified: boolean }}
	 *   - `value`: the (possibly new) value reference. May be a fresh
	 *     reference (e.g. after `data` replacement) or the same reference
	 *     that was passed in (after in-place mutation).
	 *   - `replaced`: true when `value` was assigned a fresh reference,
	 *     so the caller does not need to clone before publishing.
	 *   - `modified`: false when the event changed nothing: a `set` whose
	 *     `data` is reference-identical to the prior value, or an ordered
	 *     `cursor` / `presence` update its publisher already superseded;
	 *     true in all other paths.
	 */
	function _applyMergeFn(value, index, envelope, local = false) {
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
			value = _prepareRows(data);
			if (!local) _presenceSeeded.clear();
			if (merge === 'crud' || merge === 'presence' || merge === 'cursor') {
				_rebuildIndexFn(value, index);
			}
			return { value, replaced: true, modified: true };
		}

		if (merge === 'crud') {
			if (data == null || data[key] === undefined) {
				_warnMissingKey();
				return { value, replaced: false, modified: false };
			}
			if (!Array.isArray(value)) { value = []; index.clear(); }

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
			if (event !== 'set' && (data == null || data.key === undefined)) {
				_warnMissingKey();
				return { value, replaced: false, modified: false };
			}
			if (!Array.isArray(value)) { value = []; index.clear(); }
			if (event === 'join') {
				// A join keeps the key's publisher marks: a publisher's sequence
				// runs on across it, so an update that publisher superseded is
				// still stale once the joined entry has replaced the old one.
				const idx = index.get(data.key);
				if (idx !== undefined) {
					if (_presenceSeeded.has(data.key)) {
						// Field updates overtook this join on the way here (the
						// server publishes a member's updates only after its join,
						// but a relay between instances may reorder them) and
						// seeded the entry. Their fields are newer than the join,
						// so they stay on the joined entry.
						value[idx] = { ...data, ...value[idx] };
						if (!local) _presenceSeeded.delete(data.key);
					} else {
						value[idx] = data;
					}
				} else {
					index.set(data.key, value.length);
					value.push(data);
				}
			} else if (event === 'leave') {
				if (!local) {
					_presenceFieldOrder.delete(data.key);
					_presenceSeeded.delete(data.key);
				}
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
				// A delta that overtook its join (no entry yet) seeds an entry
				// without `data`, which the join lands on (see above) and which
				// the multiplayer room views leave out until then.
				const idx = index.get(data.key);
				let fields = data;
				if (!local && _isOrdered(data)) {
					// Ordered delta: apply each field only when its publisher
					// has not already delivered a newer frame for that field, so
					// a reordered pair (`typing: false` behind `typing: true`)
					// cannot park a stale flag. The token itself stays out of the
					// entry, a seeded one included; the entry carries only the
					// presence fields.
					let order = _presenceFieldOrder.get(data.key);
					if (!order) { order = new Map(); _presenceFieldOrder.set(data.key, order); }
					fields = null;
					for (const field in data) {
						if (field === 'key' || field === '_p' || field === '_n') continue;
						let marks = order.get(field);
						if (!marks) { marks = new Map(); order.set(field, marks); }
						if (!_admitOrdered(marks, data)) continue;
						(fields ??= { key: data.key })[field] = data[field];
					}
					if (fields === null) return { value, replaced: false, modified: false };
				}
				if (idx !== undefined) {
					value[idx] = { ...value[idx], ...fields };
				} else {
					index.set(data.key, value.length);
					value.push(fields);
					if (!local) _presenceSeeded.add(data.key);
				}
			} else if (event === 'set') {
				if (!local) {
					_presenceFieldOrder.clear();
					_presenceSeeded.clear();
				}
				value = _prepareRows(data);
				_rebuildIndexFn(value, index);
				return { value, replaced: true, modified: true };
			}
			const limited = max && value.length > max ? _limitRows(value) : value;
			if (limited !== value) {
				_rebuildIndexFn(limited, index);
				return { value: limited, replaced: true, modified: true };
			}
			return { value, replaced: false, modified: true };
		} else if (merge === 'cursor') {
			if (event !== 'set' && (data == null || data.key === undefined)) {
				_warnMissingKey();
				return { value, replaced: false, modified: false };
			}
			if (!Array.isArray(value)) { value = []; index.clear(); }
			if (event === 'update') {
				const idx = index.get(data.key);
				if (idx !== undefined) {
					// Samples carry their publisher's ordering token (`_p`, `_n`).
					// A sample its publisher already superseded is a reordered
					// or re-delivered one: applying it would roll the cursor
					// back to a stale point and leave it there. Frames without
					// a token (an older server) keep the unconditional
					// last-write-wins.
					if (!local && !_admitCursor(value[idx], data)) return { value, replaced: false, modified: false };
					value[idx] = data;
				} else {
					index.set(data.key, value.length);
					value.push(data);
				}
			} else if (event === 'remove') {
				if (!local) _cursorOrder.delete(data.key);
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
				if (!local) _cursorOrder.clear();
				value = _prepareRows(data);
				_rebuildIndexFn(value, index);
				return { value, replaced: true, modified: true };
			}
			const limited = max && value.length > max ? _limitRows(value) : value;
			if (limited !== value) {
				_rebuildIndexFn(limited, index);
				return { value: limited, replaced: true, modified: true };
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
	 * steady-state hot path (queue empty), mutates currentValue / _index
	 * directly. In queue mode (a `mutate(asyncOp, change)`
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
		// Monotonic resume cursor: `_lastSeq` is what a resubscribe sends as
		// `request.seq` for gap-fill, so it must only ADVANCE. A multi-node
		// cluster can deliver two concurrently-published events with inverted
		// seqs (seq is minted atomically but the fan-out order is PUBLISH
		// arrival order); applying them in arrival order is fine - the merge is
		// key-based - but letting the cursor regress would re-deliver the gap
		// on the next reconnect. A fresh session starts from null, and a full
		// rehydrate response reassigns the cursor authoritatively elsewhere.
		if (envelope.seq !== undefined && (_lastSeq === null || envelope.seq > _lastSeq)) _lastSeq = envelope.seq;
		if (_optimisticQueue.length > 0) {
			// optimistic.queue invariant: when queue is non-empty the un-overlaid
			// server state pair (_serverValue, _serverIndex) must be set. Both
			// are paired across mutate-push and _drainQueue.
			assert(_serverValue !== null && _serverIndex !== null, 'realtime/optimistic.queue.serverValue-iff-nonempty', { queueLen: _optimisticQueue.length, hasServerValue: _serverValue !== null, hasServerIndex: _serverIndex !== null });
			const result = _applyMergeFn(_serverValue, /** @type {Map<any, number>} */ (_serverIndex), envelope);
			_serverValue = result.value;
			// Accumulate across one flush: a later no-op event (an identical
			// `set`, a superseded cursor sample) must not hide an earlier
			// modification made in place.
			if (result.modified) _dirty = true;
			_absorbCheck(envelope);
			return false;
		}
		const result = _applyMergeFn(currentValue, _index, envelope);
		currentValue = result.value;
		if (result.modified) _dirty = true;
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
	 * @param {boolean} [local] - replaying over a copy for display: see
	 *   `_applyMergeFn`. A graduation writes the server state and keeps the
	 *   publisher marks in step with it, like a server event.
	 * @returns {any}
	 */
	function _applyChange(value, index, change, local = false) {
		if (typeof change === 'function') {
			const draft = Array.isArray(value)
				? value.slice()
				: (value && typeof value === 'object' ? { ...value } : value);
			const result = change(draft);
			const next = _prepareRows(result === undefined ? draft : result);
			_rebuildIndexFn(next, index);
			return next;
		}
		const r = _applyMergeFn(value, index, change, local);
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
			value = _applyChange(value, index, entry.change, true);
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

		// RAF dedup: for keyed merge strategies, keep only the last idempotent
		// event per key. Two ordered frames from one publisher (cursor updates
		// carry `_p` / `_n`) keep the newer sequence rather than the later
		// arrival, so a burst that arrived reordered within one frame still lands
		// on its newest sample; unordered events keep arrival order.
		if (queue.length > 1 && merge !== 'set' && merge !== 'latest') {
			const keyField = mergeKeyField(merge, key);
			const seen = new Map();
			for (let i = queue.length - 1; i >= 0; i--) {
				if (!_IDEMPOTENT.has(queue[i].event)) continue;
				// A presence `update` carries only the fields that changed, so
				// two of them for one key inside a frame are not substitutes:
				// dropping the older one drops the fields only it carried (a
				// lock release lost behind a typing flag). They are cheap and
				// rare next to cursor samples, and the per-field order guard in
				// the merge already settles their order. Nor are two joins: the
				// first lands on fields an update seeded and the second replaces
				// that entry, so keeping only the second would keep the fields.
				if (merge === 'presence' && (queue[i].event === 'update' || queue[i].event === 'join')) continue;
				const k = queue[i].data?.[keyField];
				if (k !== undefined) {
					const kept = seen.get(k);
					if (kept === undefined) {
						seen.set(k, i);
					} else {
						const later = queue[kept].data;
						const earlier = queue[i].data;
						const laterOrdered = _isOrdered(later);
						if (_isOrdered(earlier) !== laterOrdered) {
							// One ordered, one not (an older server during a
							// rollout): leave both to the merge, which settles
							// them exactly as it would one event at a time.
							continue;
						}
						if (laterOrdered) {
							// Two publishers are not ordered against each other:
							// leave both to the merge, which records each one's
							// mark, so a reordered sample from either that arrives
							// afterwards is still recognised as superseded.
							if (earlier._p !== later._p) continue;
							// One publisher: keep its newer sample, and on a tie
							// (a re-delivery) the first copy, as the merge would.
							if (earlier._n >= later._n) {
								// The dropped later arrival may carry the higher
								// replay seq; keep the resume cursor monotonic
								// regardless of which envelope is applied.
								_advanceSeq(queue[kept]);
								queue[kept] = null;
								seen.set(k, i);
								continue;
							}
						}
						_advanceSeq(queue[i]);
						queue[i] = null;
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
				_jitter.clear();
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

	// De-herd dispatch: defers a frame carrying a jitter window `j` by a local
	// random delay so this client's reaction spreads across the window instead of
	// firing at t+0. Per stream instance (each client rolls its own offset).
	const _jitter = createJitterDispatch(applyEvent);

	/**
	 * Install this stream's live-event listener (idempotent). Inbound frames buffer
	 * until the initial load, then route through the de-herd dispatcher so a jittered
	 * frame staggers. Shared by the normal subscribe path AND the `unchanged`
	 * delta-sync resume path, so the two listener installs can never drift (a prior
	 * copy on the resume path silently bypassed the dispatcher).
	 */
	function _subscribeLive() {
		if (!topic || topicUnsub) return;
		const topicStore = _conn().on(topic);
		topicUnsub = topicStore.subscribe((envelope) => {
			if (!envelope) return;
			if (!initialLoaded) buffer.push(envelope);
			else _jitter.dispatch(envelope);
		});
	}

	/**
	 * Bind this stream to its server-resolved wire topic: mark it server-managed,
	 * hold the managed ref, route topic errors and denials here. Idempotent for
	 * the same topic; a topic switch releases the old one. Shared by the early
	 * attach frame and the subscribe response so the two can never drift.
	 * @param {string | null} nextTopic
	 */
	function _bindTopic(nextTopic) {
		if (topic && topic !== nextTopic) _unregisterTopicErrorSetter(topic, _setError);
		topic = nextTopic || null;
		if (!topic) return;
		// The server subscribes this connection to `topic` itself (the stream
		// RPC runs platform.subscribe after the guard / access filter), so mark
		// it server-managed: the client attaches its dispatch store WITHOUT
		// emitting a redundant subscribe frame, and the reconnect
		// resubscribe-batch skips it. Under wire-subscribe authorization that
		// is what keeps a legitimate reconnect from racing the server's
		// re-subscribe. Must precede _subscribeLive().
		setTopicManaged(topic);
		// Hold an adapter ref across listener replacement and pending requests.
		// A topic switch transfers that ownership to the new wire topic.
		if (_hasManagedMarking && _managedHeldTopic !== topic) {
			if (_managedHeldTopic) _sendManagedRelease(_managedHeldTopic);
			_managedRefAcquire(topic);
			_managedHeldTopic = topic;
		}
		_registerTopicErrorSetter(topic, _setError);
		ensureDenialsListener();
	}

	/** @type {boolean} The in-flight subscribe installed the live listener from an attach frame */
	let _attachInstalledListener = false;
	/** @type {boolean} The in-flight subscribe acquired the managed ref from an attach frame */
	let _attachAcquiredRef = false;

	/**
	 * Undo what an attach frame installed for a subscribe that will never
	 * resolve (rejected, timed out): the live listener (and the frames it
	 * buffered) and the managed ref. Anything held before the fetch stays.
	 * @param {boolean} [keepRef] - hand the ref to the caller instead of releasing it
	 * @returns {string | null} the topic of the ref handed over
	 */
	function _abandonAttach(keepRef) {
		if (_attachInstalledListener && topicUnsub) {
			topicUnsub();
			topicUnsub = null;
			buffer = [];
		}
		let kept = null;
		if (_attachAcquiredRef && _managedHeldTopic) {
			const releasedTopic = _managedHeldTopic;
			_managedHeldTopic = null;
			if (keepRef) kept = releasedTopic;
			else _sendManagedRelease(releasedTopic);
		}
		_attachInstalledListener = false;
		_attachAcquiredRef = false;
		return kept;
	}

	/**
	 * Stop waiting for the in-flight subscribe. A request the batch has not
	 * sent is withdrawn; one already sent is returned for the caller to hand to
	 * an orphan record, since the server may still subscribe the socket.
	 * @returns {{ id: string, ticket: SubscribeTicket } | null}
	 */
	function _dropRequest() {
		const id = pendingId;
		const ticket = _ticket;
		pendingId = null;
		_ticket = null;
		if (!id) return null;
		if (ticket && ticket.state === 'sent') return { id, ticket };
		if (ticket) ticket.state = 'done';
		const entry = pending.get(id);
		if (entry) {
			pending.delete(id);
			if (entry.timer) clearTimer(entry.timer);
		}
		return null;
	}

	/**
	 * Fetch initial data and subscribe to live updates.
	 */
	function fetchAndSubscribe() {
		if (fetching) return;
		ensureListener();
		ensureDisconnectListener();
		// Also while a close() made inside another store's update is still on
		// its way to the client's status listener.
		if (_closedForGoodNow()) {
			_closedForGood();
			return;
		}
		_setPhase('attaching');
		fetching = true;
		initialLoaded = false;
		buffer = [];
		_attachInstalledListener = false;
		_attachAcquiredRef = false;

		// This request supersedes one still in flight (a reconnect or a
		// refetch that did not wait for it).
		if (pendingId) {
			const prev = _dropRequest();
			if (prev) _orphanSubscribe(prev.id, prev.ticket, null);
		}

		const id = _nextId();
		pendingId = id;
		const conn = _conn();

		/** @type {any} */
		const request = { rpc: path, id, args: dynamicArgs || [], stream: true, attach: true };
		if (_lastSeq !== null) request.seq = _lastSeq;
		if (_lastVersion !== undefined) request.version = _lastVersion;
		if (_schemaVersion !== undefined) request.schemaVersion = _schemaVersion;
		/** @type {SubscribeTicket} */
		const ticket = { request, state: 'queued', topic: null };
		_ticket = ticket;

		const _startTime = now();
		const timer = setTimer(() => {
			pendingId = null;
			_ticket = null;
			fetching = false;
			// The server may still answer and subscribe the socket: an orphan
			// record releases that, along with the ref an attach frame took.
			const handedRef = _abandonAttach(true);
			if (ticket.state === 'sent') {
				_orphanSubscribe(id, ticket, handedRef);
			} else {
				ticket.state = 'done';
				pending.delete(id);
				if (handedRef) _sendManagedRelease(handedRef);
			}
			if (now() - _startTime > 90000) {
				_setError(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
				return;
			}
			_setError(new RpcError('TIMEOUT', `Stream '${path}' timed out after 30s`));
		}, _getTimeout());

		pending.set(id, {
			stream: true,
			/**
			 * Early attach: the server named the wire topic before subscribing the
			 * socket. Bind it and install the live listener now, while
			 * `initialLoaded` is still false, so every frame the subscription
			 * delivers ahead of the snapshot lands in `buffer` instead of being
			 * dropped for want of a store. The response then replays the buffer
			 * over the snapshot as it always has.
			 * @param {string | null | undefined} attachTopic
			 */
			attach(attachTopic) {
				if (!attachTopic || pendingId !== id) return;
				const heldBefore = _managedHeldTopic;
				const listenerBefore = topicUnsub;
				_bindTopic(attachTopic);
				_subscribeNamed(ticket, attachTopic);
				_subscribeLive();
				_attachAcquiredRef = heldBefore !== _managedHeldTopic;
				_attachInstalledListener = listenerBefore === null && topicUnsub !== null;
			},
			resolve(response) {
				fetching = false;
				pendingId = null;
				_ticket = null;
				// Bound and settled before any store update runs app code.
				_bindTopic(response.topic || null);
				_subscribeDone(ticket);
				// The answer is the cursor's new baseline: an outage before it no
				// longer ages the cursor. Over a socket the listener counts as down
				// (an answer landing in a hidden tab) staleness runs from here.
				_downAt = _listenerDown ? now() : null;
				_reconnectAttempts = 0;
				_clearError();
				_status = 'connected';
				_statusStore.set('connected');
				_setPhase('attached');
				_attachInstalledListener = false;
				_attachAcquiredRef = false;

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
					_subscribeLive();
					initialLoaded = true;
					// Drain anything buffered between listener attach and now
					if (buffer.length > 0) {
						for (const evt of buffer) _applyMerge(evt);
						if (_optimisticQueue.length > 0) _recomputeDisplay();
						else {
							if (Array.isArray(currentValue)) currentValue = currentValue.slice();
							store.set(currentValue);
						}
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
					if (_optimisticQueue.length > 0) {
						_serverValue = _prepareRows(response.data);
						_rebuildIndexFn(_serverValue, /** @type {Map<any, number>} */ (_serverIndex));
					} else {
						currentValue = _prepareRows(response.data);
					}
					_presenceFieldOrder.clear();
					_presenceSeeded.clear();
					_cursorOrder.clear();
				}

				if (_optimisticQueue.length > 0) currentValue = _replayQueue().value;
				_rebuildIndex();

				if (response.hasMore !== undefined) _hasMore = response.hasMore;
				if (response.cursor !== undefined) _cursor = response.cursor;
				if (response.schemaVersion !== undefined) _schemaVersion = response.schemaVersion;

				// Attach topic listener BEFORE flipping initialLoaded, so events
				// arriving between ws.subscribe(topic) (server-side) and now are buffered.
				_subscribeLive();

				initialLoaded = true;
				if (Array.isArray(currentValue)) currentValue = currentValue.slice();
				store.set(currentValue);
				_recordHistory();

				// Replay buffered messages in batch
				if (buffer.length > 0) {
					for (const evt of buffer) {
						_applyMerge(evt);
					}
					if (_optimisticQueue.length > 0) _recomputeDisplay();
					else {
						if (Array.isArray(currentValue)) currentValue = currentValue.slice();
						store.set(currentValue);
						_recordHistory();
					}
				}
				buffer = [];
			},
			reject(err) {
				fetching = false;
				pendingId = null;
				_ticket = null;
				// A subscribe that attached early and then failed (the server rolled
				// its subscription back) must not keep the listener or the managed
				// ref the attach frame acquired; anything held before this fetch
				// stays, exactly as before.
				_abandonAttach();
				// A disconnect rejects a request that may never have left the
				// adapter's send queue; it goes out on the next open, after this
				// stream has moved on to a fresh subscribe.
				if (err && err.code === 'DISCONNECTED' && ticket.state === 'sent' && ticket.topic === null) {
					_orphanSubscribe(id, ticket, null, true);
				} else {
					_subscribeDone(ticket);
				}
				// The stream's own status listener may have shown the close already.
				// A server can answer a subscribe with CONNECTION_CLOSED too, on a
				// socket that stays open.
				if (clientState.terminated && err && err.code === 'CONNECTION_CLOSED') _closedForGood();
				else _setError(err instanceof RpcError ? err : new RpcError('STREAM_ERROR', err?.message || 'Stream failed'));
			},
			timer
		});

		_batchedSubscribe(ticket);
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
		// A subscribe already sent goes to an orphan record together with the
		// managed ref, which it releases once the server has answered: a frame
		// sent now could reach the server ahead of the subscribe and be undone
		// by it.
		const inFlight = _dropRequest();
		if (inFlight) {
			const handedRef = _managedHeldTopic;
			_managedHeldTopic = null;
			_orphanSubscribe(inFlight.id, inFlight.ticket, handedRef);
		}
		if (topicUnsub) {
			topicUnsub();
			topicUnsub = null;
		}
		// Let go of the held adapter ref once this stream has no pending work.
		if (_managedHeldTopic) {
			const releasedTopic = _managedHeldTopic;
			_managedHeldTopic = null;
			_sendManagedRelease(releasedTopic);
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
		_jitter.clear();
		_bufA.length = 0;
		_bufB.length = 0;
		_activeBuf = _bufA;
		fetching = false;
		_setPhase('detached');
	}

	/**
	 * Drop only the replay/delta cursors so the next fetchAndSubscribe() omits
	 * `seq`/`version` and the server answers with a full rehydrate instead of a
	 * gap-fill. Unlike _resetSession this keeps currentValue and the display
	 * model intact, so a too-stale reconnect refreshes in place with no blank
	 * flash - the full `data` reply replaces the value when it lands.
	 */
	function _dropResumeCursors() {
		_lastSeq = null;
		_lastVersion = undefined;
		_cursor = null;
		_hasMore = false;
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
		_presenceFieldOrder.clear();
		_presenceSeeded.clear();
		_cursorOrder.clear();
		_history = [];
		_historyIndex = -1;
		_reconnectAttempts = 0;
		_lastSeq = null;
		_lastVersion = undefined;
		_schemaVersion = initialSchemaVersion;
		_cursor = null;
		_hasMore = false;
		_loadingMore = false;
		_downAt = null;
		_graceStartAt = null;
		// The phase is owned by the lifecycle transitions ('detached' from the
		// release that precedes every reset, 'attaching' from the next
		// subscribe); the documented machine has no edge back into
		// 'initialized', and stamping it here made a detach flash the
		// not-started state before it settled on 'detached'. 'failed' is the
		// one value this has to clear: it tracks the error state, the release
		// keeps the topic's error setter registered so a denial can still
		// stamp it inside the grace window, and the error itself is cleared
		// just above - a phase reporting a failure with no error to show
		// would outlive it for as long as the store is cached.
		if (_phase === 'failed') _setPhase('detached');
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
	/** @type {(() => void) | null} The internal retain `attach()` holds (a store subscriber that ignores values), so an attached stream needs no UI subscriber */
	let _attachHold = null;
	/** @type {boolean} Set by detach(): the next last-unsubscriber cleanup tears down IMMEDIATELY (no resume grace) and rests in the 'detached' phase */
	let _detachRequested = false;

	/**
	 * Wire up the per-subscribe lifecycle listeners: quiescence tracking
	 * (registers the stream with the global in-flight counter) and the
	 * reconnect-on-open watcher. Shared between first-subscribe and
	 * resume-from-grace so both paths get the same listener setup.
	 * @param {number | null} [agingSince] - when the retained cursor started
	 *   aging: a grace resume carries it until its answer or a reconnect
	 */
	function _attachLifecycleListeners(agingSince) {
		// Fresh baseline: any outage clock from a prior listener generation is
		// stale (that reconnect either completed or the stream released). A
		// grace resume carries its cursor's age instead, so a reconnect before
		// its answer ages the cursor from there.
		_downAt = agingSince ?? null;
		_listenerDown = false;
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
		// (since `_conn()` is lazy on the first subscriber). Filter on 'open'
		// first and track whether we've ever seen one, so the FIRST 'open' is
		// the lifetime baseline rather than treating it as a reconnect bounce.
		let hasOpenedOnce = false;
		let droppedBeforeOpen = false;
		/** True while `status.subscribe` reports the value current at attach. */
		let attaching = true;
		statusUnsub = _conn().status.subscribe((s) => {
			if (s !== 'open') {
				// First step away from a live connection: record when the outage
				// began (once) so the reconnect can measure how stale the retained
				// cursor is. Only after we have opened at least once - the initial
				// pre-open 'connecting' is not an outage.
				if (hasOpenedOnce && _downAt === null) _downAt = now();
				_listenerDown = hasOpenedOnce;
				if (!hasOpenedOnce && (s === 'disconnected' || s === 'failed')) {
					droppedBeforeOpen = true;
					// Ages the retained cursor for the resubscribe below.
					if (_downAt === null) _downAt = now();
				}
				if (s === 'failed') _closedForGood();
				return;
			}
			_listenerDown = false;
			if (!hasOpenedOnce) {
				hasOpenedOnce = true;
				// The first open is the baseline when it is the value reported at
				// attach, or while this stream's subscribe is still on its way.
				// Opening later with nothing in flight, the stream subscribes again
				// as it would after a reconnect if it never loaded (a failed connect
				// rejected its queued request, or it timed out waiting for the
				// socket) or the socket dropped since (it loaded over a socket that
				// opened behind a hidden tab and lost that subscription).
				if (attaching || fetching || (initialLoaded && !droppedBeforeOpen)) return;
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
					// Cursor time-check: if the connection was down longer than a
					// retained cursor is trusted, a seq/version gap-fill could
					// silently miss data the server pruned by time (not by seq).
					// Drop the resume cursor so the server sends a full rehydrate
					// instead of trusting a stale watermark.
					if (_downAt !== null && now() - _downAt > _getResumeMaxCursorAgeMs()) {
						_dropResumeCursors();
					}
					_downAt = null;
					fetchAndSubscribe();
				}, delay);
			}
		});
		attaching = false;
	}

	/**
	 * The connection closed for good: nothing reloads this stream, so a pending
	 * reconnect is dropped and the stream shows why. Its data stays. `.error`
	 * reports it once; a stream that still shows it (subscribed again from its
	 * grace window) only returns to the failed state.
	 */
	function _closedForGood() {
		if (_reconnectTimer) {
			clearTimer(_reconnectTimer);
			_reconnectTimer = null;
		}
		if (_closedError === null || _error !== _closedError) {
			_closedError = new RpcError('CONNECTION_CLOSED', 'Connection permanently closed');
			_setError(_closedError);
			return;
		}
		_status = 'error';
		_statusStore.set('error');
		_setPhase('failed');
		// A first subscribe shows the close before its devtools entry exists.
		_devtoolsStreamError(path, _error);
	}

	return {
		// Stamped metadata so test-affordances like `subscribeAt`
		// (`svelte-realtime/testing/client`) can construct a parallel store
		// at a chosen schemaVersion without needing the user to pass the
		// path string by hand. Not part of the public store contract.
		__streamPath: path,
		__streamOptions: options,
		__streamArgs: dynamicArgs,
		error: { subscribe: _errorStore.subscribe },
		status: { subscribe: _statusStore.subscribe },
		phase: { subscribe: _phaseStore.subscribe },

		/**
		 * Explicitly attach the subscription and resolve once the server has
		 * confirmed it ('attached'), or reject when the attach fails. Holds an
		 * internal retain so the stream stays attached with no UI subscriber;
		 * with the retain in place the auto-reattach machinery (reconnect
		 * resubscribe, resume) keeps re-entering 'attaching' -> 'attached' on
		 * every outage. The "don't publish until fully attached" pattern:
		 * `await store.attach()` before issuing the RPC that publishes - the
		 * server subscribed this connection before the resolve, so delivery is
		 * guaranteed rather than racing the subscribe (events landing between
		 * the server-side subscribe and the resolve are buffered and drained).
		 * Idempotent: an attached stream resolves immediately.
		 * @returns {Promise<void>}
		 */
		attach() {
			if (_attachHold === null) {
				_attachHold = this.subscribe(() => {});
			}
			if (_phase === 'attached') return Promise.resolve();
			// Already failed with no retry in flight (e.g. a FORBIDDEN denial):
			// reject now instead of hanging - the caller decides whether to
			// detach() and re-attach().
			if (_phase === 'failed' && _error !== null) return Promise.reject(_error);
			return new Promise((resolve, reject) => {
				let settled = false;
				const un = _phaseStore.subscribe((p) => {
					if (settled) return;
					if (p === 'attached') {
						settled = true;
						microtask(un);
						resolve();
					} else if (p === 'failed') {
						settled = true;
						microtask(un);
						reject(_error || new RpcError('STREAM_ERROR', `Stream '${path}' failed to attach`));
					}
				});
			});
		},

		/**
		 * Explicitly detach: release the `attach()` retain and, when no other
		 * subscriber remains, tear the subscription down IMMEDIATELY (no
		 * resume-grace retention - detach means "done", not "maybe coming
		 * back"), resting in the 'detached' phase. With live UI subscribers
		 * the stream stays attached on their behalf; detach() then only drops
		 * the retain. A later subscribe()/attach() re-attaches from scratch.
		 */
		detach() {
			if (_attachHold !== null) {
				const hold = _attachHold;
				_attachHold = null;
				// Arm the grace-less teardown ONLY for the unsubscribe this call
				// itself triggers; if other subscribers remain after the hold
				// releases, the flag is cleared below so it can never hijack
				// their eventual last-unsubscribe.
				_detachRequested = true;
				hold();
			}
			if (subCount > 0) _detachRequested = false;
		},

		subscribe(fn) {
			if (subCount++ === 0) {
				if (_pendingCleanup) {
					// Rapid sync resub (same microtask) - cancel the pending cleanup,
					// WS subscription is still attached.
					_pendingCleanup = false;
					_cleanupsPending--;
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
					// Cursor time-check, same rationale as the reconnect path: the
					// retained cursor may be older than the trust bound - the grace
					// idle plus any outage that began before the unsubscribe. Age it
					// from the earlier of the socket drop and the grace release
					// (_attachLifecycleListeners carries it into the new listener
					// generation), and rehydrate fully past the bound instead of
					// gap-filling stale.
					const _agingSince = _downAt !== null ? _downAt : _graceStartAt;
					if (_agingSince !== null && now() - _agingSince > _getResumeMaxCursorAgeMs()) {
						_dropResumeCursors();
					}
					_graceStartAt = null;
					// Flip status back to 'loading' so the newly-attached quiescence
					// subscriber sees us as in-flight while the resume envelope is
					// outstanding (it fires synchronously with the current value).
					// Closed for good, nothing loads: show the close first, so the
					// quiescence subscriber never counts the stream as in flight.
					if (_closedForGoodNow()) _closedForGood();
					else {
						_status = 'loading';
						_statusStore.set('loading');
					}
					_attachLifecycleListeners(_agingSince);
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
					_cleanupsPending++;
					microtask(() => {
						if (!_pendingCleanup) return;
						_pendingCleanup = false;
						_cleanupsPending--;
						if (subCount === 0) {
							if (_detachRequested) {
								// Explicit detach(): tear down NOW - the caller said "done",
								// not "component unmounted, maybe coming back" - and rest in
								// the 'detached' phase (a later subscribe()/attach() re-runs
								// the machine from 'attaching').
								_detachRequested = false;
								cleanup();
								_setPhase('detached');
								return;
							}
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
								// Start (or keep) the cursor-aging clock: a socket that
								// dropped since the last answer, or a resume that was never
								// answered, set _downAt earlier and wins; otherwise aging
								// begins now, at the release.
								_graceStartAt = now();
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

			applyEvent({ event, data });

			return function rollback() {
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

			let optimisticKey = _NO_OPTIMISTIC_KEY;
			if (isEvent) {
				const k = mergeKeyField(merge, key);
				if (k && optimisticChange.data && optimisticChange.data[k] !== undefined) {
					optimisticKey = optimisticChange.data[k];
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
			const conn = _conn();

			return new Promise((resolve, reject) => {
				// The server subscribes the socket again for a page (the request
				// takes the stream path), so the page holds the stream's topic
				// until it is answered: a release in between stays off the wire.
				// A page the stream stops waiting for goes to an orphan record.
				const heldTopic = _hasManagedMarking ? _managedHeldTopic : null;
				if (heldTopic) _managedRefAcquire(heldTopic);
				/** @type {SubscribeTicket} */
				const ticket = { request: null, state: 'done', topic: null };
				const _startTime = now();
				const timer = setTimer(() => {
					_orphanSubscribe(id, ticket, heldTopic);
					_loadingMore = false;
					if (now() - _startTime > 90000) {
						reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
						return;
					}
					reject(new RpcError('TIMEOUT', `loadMore '${path}' timed out after 30s`));
				}, _getTimeout());

				pending.set(id, {
					stream: true,
					resolve(response) {
						// The topic the page subscribed: released unless a stream
						// still holds it (a page asked for after the stream let go
						// of its topic would otherwise keep the socket subscribed).
						if (_hasManagedMarking && typeof response.topic === 'string') {
							_managedRefAcquire(response.topic);
							_sendManagedRelease(response.topic);
						}
						if (heldTopic) _sendManagedRelease(heldTopic);
						_loadingMore = false;
						if (response.hasMore !== undefined) _hasMore = response.hasMore;
						if (response.cursor !== undefined) _cursor = response.cursor;

						// Queue mode: currentValue is a display overlay recomputed
						// from _serverValue on every queue transition, so a page
						// concatenated into currentValue would vanish on the next
						// _recomputeDisplay. Apply the page to the un-overlaid
						// server state and recompute the display instead.
						if (_optimisticQueue.length > 0) {
							if (Array.isArray(response.data) && Array.isArray(_serverValue)) {
								_serverValue = _appendPage(_serverValue, /** @type {Map<any, number>} */ (_serverIndex), response.data);
							} else if (response.data !== undefined) {
								_serverValue = _prepareRows(response.data);
								_rebuildIndexFn(_serverValue, /** @type {Map<any, number>} */ (_serverIndex));
							}
							// A page row must NOT absorb an in-flight queue entry with
							// the same key. A live event means "this change just
							// committed"; a page row only means "this is the row as of
							// the page query", which routinely PREDATES the in-flight
							// mutation. Absorbing it would mark the entry
							// serverConfirmed, so the replay would skip it and settle
							// would never graduate it onto _serverValue - silently
							// discarding a mutation the server accepted. Replaying the
							// queue on top of the page is already duplicate-free: a
							// keyed change whose key is in the index replaces the row
							// rather than appending a second one.
							_recomputeDisplay();
							resolve(_hasMore);
							return;
						}

						if (Array.isArray(response.data) && Array.isArray(currentValue)) {
							currentValue = _appendPage(currentValue, _index, response.data);
						} else if (response.data !== undefined) {
							currentValue = _prepareRows(response.data);
							_rebuildIndex();
						}

						store.set(currentValue);
						resolve(_hasMore);
					},
					reject(err) {
						// A disconnect may have left the request in the adapter's
						// send queue, which goes out on the next open.
						if (err && err.code === 'DISCONNECTED') _orphanSubscribe(id, ticket, heldTopic, true);
						else if (heldTopic) _sendManagedRelease(heldTopic);
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
			currentValue = _prepareRows(initialData);
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
			return createReactiveStream(this);
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
