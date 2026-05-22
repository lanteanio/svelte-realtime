// @ts-check
import { connect as _connect, on, status, denials, onRequest as _adapterOnRequest } from 'svelte-adapter-uws/client';
import { writable, readable } from 'svelte/store';
import { assert } from './shared/assert.js';
export { assert, getAssertionCounters, _resetAssertCounters } from './shared/assert.js';
import { mergeKeyField, rebuildIndex } from './shared/merge.js';
import { sanitizeRowData } from './shared/safe-assign.js';
// Namespace import lets .rune() access fromStore (Svelte 5 only) without
// breaking the module under Svelte 4 - missing exports become undefined,
// not module-load errors.
import * as _svelteStore from 'svelte/store';

/** @type {import('svelte/store').Readable<undefined>} */
export const empty = readable(undefined);

const _textEncoder = new TextEncoder();

/** Dev-mode flag. True when not running under a Vite production build
 * (and true under vitest, where `import.meta.env.PROD` is undefined).
 * Gates dev-only warnings and devtools instrumentation. */
const _IS_DEV = typeof import.meta === 'undefined' || !import.meta.env || !import.meta.env.PROD;

// - Bounded-by-default capacity caps (client side) -------------------------
// Existing caps not re-declared (already enforced at their sites):
//   _historyMax           50    FIFO    per-stream undo/redo
//   _MAX_STREAM_EVENTS    20    FIFO    per-stream devtools event ring
//   _DEVTOOLS_HISTORY_MAX 50    FIFO    devtools call history ring
// See README "Capacity model" for the full taxonomy.

/** Max in-flight optimistic mutations per stream. REJECT on cap: `mutate()` throws synchronously. Bounds the worst-case display-recompute cost during slow-server scenarios. Matches svelte-adapter-uws `MAX_QUEUE_SIZE` (the per-connection client send queue) since both serve as UI-layer in-flight burglar alarms. */
export const MAX_OPTIMISTIC_QUEUE_DEPTH = 1_000;

let _maxOptimisticQueueDepth = MAX_OPTIMISTIC_QUEUE_DEPTH;

/**
 * Override capacity caps for testing.
 * @internal
 * @param {{ optimisticQueueDepth?: number }} overrides
 */
export function _setCapsForTest(overrides) {
	if (overrides.optimisticQueueDepth !== undefined) _maxOptimisticQueueDepth = overrides.optimisticQueueDepth;
}

/**
 * Restore capacity caps to defaults.
 * @internal
 */
export function _resetCapsForTest() {
	_maxOptimisticQueueDepth = MAX_OPTIMISTIC_QUEUE_DEPTH;
}

/** Pre-allocated binary frame buffer for reuse across sequential binary RPC calls */
let _binaryFrameBuffer = /** @type {Uint8Array | null} */ (null);
let _binaryFrameSize = 0;

/**
 * Get a reusable binary frame buffer of at least `size` bytes.
 * Grows by 2x to avoid frequent reallocation.
 * @param {number} size
 * @returns {Uint8Array}
 */
function _getBinaryFrame(size) {
	if (!_binaryFrameBuffer || _binaryFrameSize < size) {
		_binaryFrameSize = Math.max(size, (_binaryFrameSize || 1024) * 2);
		_binaryFrameBuffer = new Uint8Array(_binaryFrameSize);
	}
	return _binaryFrameBuffer;
}

/**
 * RAF-based event batching for high-frequency streams (cursors, presence).
 * In the browser, incoming pub/sub events are queued and flushed once per
 * animation frame, reducing Svelte reactive updates from N-per-event to
 * 1-per-frame. In Node/SSR, events apply synchronously (no DOM to protect).
 */
const _useRAF = typeof window !== 'undefined' && typeof requestAnimationFrame === 'function';

/**
 * Typed error for RPC failures.
 */
export class RpcError extends Error {
	/**
	 * @param {string} code
	 * @param {string} [message]
	 */
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

// Incrementing counter for short correlation IDs, prefixed to avoid cross-tab
// collision. Math.random is the right primitive: this prefix is response-routing
// bookkeeping, not a session token or any value that crosses a trust boundary.
// Not security-relevant; collision-avoidance only.
const _idPrefix = Math.random().toString(36).slice(2, 6);
let idCounter = 0;

/** Generate a unique correlation ID, wrapping the counter before exceeding safe integer range */
function _nextId() {
	if (idCounter >= 0x1FFFFFFFFFFFFF) idCounter = 0;
	return _idPrefix + (idCounter++).toString(36);
}

/** @type {Array<{ rpc: string, id: string, args: any[] }> | null} */
let _batchCollector = null;

/** @type {Map<string, Promise<any>>} */
const _dedupMap = new Map();

/**
 * Per-path "have we warned about microtask dedup coalescing this path
 * in this session?" gate. Dev-only, fires once per RPC path on the
 * first coalesce so a developer running `Promise.allSettled([...rpc(),
 * ...rpc()])` and expecting N parallel wire requests gets a one-line
 * pointer to `rpc.fresh(...)`. Silent thereafter so a button-mash
 * double-click on the same path doesn't spam the console. Stripped
 * in production via the `_isDev()` gate at the call site.
 *
 * @type {Set<string>}
 */
const _dedupCoalesceWarned = new Set();

/**
 * Dev-mode check, mirrored from the `process.env.NODE_ENV` pattern
 * used elsewhere in this file. Cached once at first call so the hot
 * path is a single property read, not a chained typeof + env lookup.
 * @returns {boolean}
 */
let _devGateCached = /** @type {boolean | null} */ (null);
function _isDev() {
	if (_devGateCached !== null) return _devGateCached;
	_devGateCached = (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production');
	return _devGateCached;
}

/**
 * Reset the dedup-coalesce warned set. Tests only.
 * @internal
 */
export function _resetDedupCoalesceWarned() {
	_dedupCoalesceWarned.clear();
	_devGateCached = null;
}

/** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> | null }>} */
const pending = new Map();

/** @type {boolean} */
let listenerAttached = false;

/** @type {boolean} */
let disconnectListenerAttached = false;

/** @type {boolean} */
let denialsListenerAttached = false;

/**
 * Topic -> set of stream-error setters. When the adapter emits a
 * subscribe-denied frame for a topic, every stream subscribed to that
 * topic gets its `error` store populated with a typed `RpcError` whose
 * `code` is the canonical denial reason (`UNAUTHENTICATED` /
 * `FORBIDDEN` / `INVALID_TOPIC` / `RATE_LIMITED`) or any custom string
 * the server's `subscribe` hook returned.
 *
 * @type {Map<string, Set<(err: any) => void>>}
 */
const _streamErrorByTopic = new Map();

/**
 * Quiescence tracking: count of streams currently in `'loading'` or
 * `'reconnecting'` state. The `quiescent` store emits `true` when this
 * counter is zero (no stream is fetching or recovering), and `false`
 * otherwise. A multi-stream page can drop a single loading spinner at
 * the moment all streams have settled, instead of flickering one
 * spinner per stream.
 *
 * Streams self-register in their first-subscribe path (when
 * `fetchAndSubscribe` runs) and self-deregister on cleanup or on
 * settling (`'connected'` / `'error'`).
 */
let _inFlightCount = 0;
const _quiescentStore = writable(true);

function _addInFlight() {
	if (_inFlightCount++ === 0) _quiescentStore.set(false);
}
function _removeInFlight() {
	if (_inFlightCount === 0) return;
	if (--_inFlightCount === 0) _quiescentStore.set(true);
}

/**
 * Reactive store that emits `true` when every active stream has
 * finished loading (or errored) and `false` while at least one is
 * fetching or recovering. Initial value is `true` (no streams yet).
 *
 * Useful for rendering a single page-level loading state instead of
 * per-stream spinners, and for detecting "all streams have caught up
 * after a reconnect" - watch for a `false -> true` transition while
 * the adapter's connection status is `'open'`.
 *
 * @type {import('svelte/store').Readable<boolean>}
 */
export const quiescent = { subscribe: _quiescentStore.subscribe };

/**
 * Reset quiescence tracking. Tests only.
 * @internal
 */
export function _resetQuiescence() {
	_inFlightCount = 0;
	_quiescentStore.set(true);
}

/**
 * System health tracking. Subscribes to the `__realtime` system topic
 * on first consumer of the `health` store and translates server-side
 * `degraded` / `recovered` events into a two-state Readable. The
 * extensions package's pub/sub bus publishes these events when its
 * circuit breaker trips and recovers; the realtime client surfaces
 * them so apps can render a "real-time updates paused" banner without
 * wiring the topic by hand.
 */
const _HEALTH_TOPIC = '__realtime';
const _healthStore = writable(/** @type {'healthy' | 'degraded'} */ ('healthy'));
/** @type {(() => void) | null} */
let _healthUnsub = null;

function _ensureHealthSubscription() {
	if (_healthUnsub) return;
	_healthUnsub = on(_HEALTH_TOPIC).subscribe((envelope) => {
		if (!envelope) return;
		if (envelope.event === 'degraded') _healthStore.set('degraded');
		else if (envelope.event === 'recovered') _healthStore.set('healthy');
	});
}

/**
 * Reactive store reflecting the realtime system health, sourced from
 * `degraded` / `recovered` events published on the `__realtime`
 * topic by the extensions pub/sub bus's circuit breaker. Initial
 * value is `'healthy'`; flips to `'degraded'` on a `degraded` event,
 * back to `'healthy'` on `recovered`.
 *
 * Subscription is lazy: the realtime client subscribes to `__realtime`
 * the first time any consumer subscribes to this store. Apps that
 * never read `health` pay no cost for the subscription.
 *
 * The store deliberately exposes only the state, not the underlying
 * payload. Apps that need richer detail (reason strings, timestamps,
 * etc.) can listen to the topic directly via
 * `import { on } from 'svelte-adapter-uws/client'; on('__realtime')`.
 *
 * @type {import('svelte/store').Readable<'healthy' | 'degraded'>}
 */
export const health = {
	subscribe(fn) {
		_ensureHealthSubscription();
		return _healthStore.subscribe(fn);
	}
};

/**
 * Reset the health store and detach the system-topic subscription.
 * Tests only.
 * @internal
 */
export function _resetHealth() {
	if (_healthUnsub) {
		_healthUnsub();
		_healthUnsub = null;
	}
	_healthStore.set('healthy');
}

function _registerTopicErrorSetter(topic, setError) {
	let set = _streamErrorByTopic.get(topic);
	if (!set) { set = new Set(); _streamErrorByTopic.set(topic, set); }
	set.add(setError);
}

function _unregisterTopicErrorSetter(topic, setError) {
	const set = _streamErrorByTopic.get(topic);
	if (!set) return;
	set.delete(setError);
	if (set.size === 0) _streamErrorByTopic.delete(topic);
}

/**
 * Attach the subscribe-denial listener once. Routes each adapter denial
 * (`{topic, reason, ref}`) to the per-topic error setters registered by
 * stream stores, so apps see a typed `error.code` (the denial reason)
 * instead of the generic `INTERNAL_ERROR` the framework's pre-A6 error
 * mapping produced.
 */
function ensureDenialsListener() {
	if (denialsListenerAttached) return;
	denialsListenerAttached = true;
	denials.subscribe((denial) => {
		if (!denial) return;
		const setters = _streamErrorByTopic.get(denial.topic);
		if (!setters || setters.size === 0) return;
		const code = typeof denial.reason === 'string' && denial.reason
			? denial.reason
			: 'FORBIDDEN';
		const message = `Subscribe to topic '${denial.topic}' denied: ${code}`;
		for (const setError of setters) setError(new RpcError(code, message));
	});
}

/** Terminal close codes that indicate a permanently-dead connection (no retry) */
const _TERMINAL_CODES = new Set([1008, 4401, 4403]);

const _DEFAULT_TIMEOUT = 30000;

/** @returns {number} Configured or default RPC timeout in ms */
function _getTimeout() {
	return _clientConfig.timeout || _DEFAULT_TIMEOUT;
}

const _DEFAULT_RESUME_GRACE_MS = 60000;

/**
 * Stream resume-grace window in ms. When the last subscriber unsubs, the
 * stream releases its WS subscription immediately but keeps the in-memory
 * data model (currentValue, _lastSeq, _lastVersion, _cursor) for this
 * long. A new subscribe() within the window resumes from the retained
 * cursor so the server can fill the gap from its replay buffer instead
 * of cold-rehydrating. Set to 0 to disable the grace window (every
 * cleanup is a full reset).
 *
 * @returns {number}
 */
function _getResumeGraceMs() {
	const v = _clientConfig.resumeGraceMs;
	if (typeof v === 'number' && v >= 0) return v;
	return _DEFAULT_RESUME_GRACE_MS;
}

/** @type {boolean} Whether the connection is permanently dead (terminal close code, exhausted retries, or explicit close) */
let _terminated = false;

/**
 * Attach the __rpc topic listener once.
 * Listens for RPC responses and resolves/rejects the matching pending promise.
 */
function ensureListener() {
	if (listenerAttached) return;
	listenerAttached = true;

	const store = on('__rpc');
	store.subscribe((envelope) => {
		if (!envelope) return;
		const { event: correlationId, data } = envelope;

		// Batch response
		if (correlationId === '__batch' && data?.batch) {
			for (const result of data.batch) {
				const entry = pending.get(result.id);
				if (!entry) continue;
				pending.delete(result.id);
				if (entry.timer) clearTimeout(entry.timer);
				if (result.ok) {
					entry.resolve(entry.stream ? result : result.data);
				} else {
					entry.reject(new RpcError(result.code || 'UNKNOWN', result.error || 'Unknown error'));
				}
			}
			return;
		}

		// Single response
		const entry = pending.get(correlationId);
		if (!entry) return;
		pending.delete(correlationId);
		if (entry.timer) clearTimeout(entry.timer);

		if (data && data.ok) {
			entry.resolve(entry.stream ? data : data.data);
		} else if (data) {
			const err = new RpcError(data.code || 'UNKNOWN', data.error || 'Unknown error');
			if (data.issues) /** @type {any} */ (err).issues = data.issues;
			entry.reject(err);
		}
	});
}

/**
 * Attach a disconnect listener once.
 * Rejects all in-flight RPCs (already sent) with DISCONNECTED.
 * Also detects the Cloudflare-Tunnel "Set-Cookie on 101" symptom: repeated
 * fast open->close cycles with no time spent in the open state.
 */
function ensureDisconnectListener() {
	if (disconnectListenerAttached) return;
	disconnectListenerAttached = true;

	let lastOpenAt = 0;
	let fastCloseCount = 0;
	let cfTunnelWarned = false;

	status.subscribe((s) => {
		if (s === 'disconnected' || s === 'failed') {
			for (const [id, entry] of pending) {
				pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				entry.reject(new RpcError('DISCONNECTED', 'WebSocket connection lost'));
			}
			_drainPendingUploadsOnDisconnect();

			if (lastOpenAt > 0) {
				const openDuration = Date.now() - lastOpenAt;
				lastOpenAt = 0;
				if (openDuration < 1000) {
					fastCloseCount++;
					if (fastCloseCount >= 2 && !cfTunnelWarned && !_clientConfig.auth) {
						cfTunnelWarned = true;
						console.warn(
							'[svelte-realtime] WebSocket opened then closed in ' + openDuration + 'ms ' +
							'with no traffic, repeatedly. This is the classic Cloudflare-Tunnel ' +
							'"Set-Cookie on 101" symptom: the proxy silently drops cookies on ' +
							'WebSocket upgrade responses.\n' +
							'  Fix: add `configure({ auth: true })` on the client and an ' +
							'`authenticate` hook in `hooks.ws.js` (svelte-adapter-uws >= 0.4.12).\n' +
							'  See: https://svti.me/cf-cookies'
						);
					}
				} else {
					fastCloseCount = 0;
				}
			}
		}
		if (s === 'open') {
			_terminated = false;
			lastOpenAt = Date.now();
		}
	});

	// Listen for terminal close via ready() rejection (adapter 0.4.0)
	if (typeof _connect === 'function') {
		try {
			const conn = _connect();
			if (conn && typeof conn.ready === 'function') {
				conn.ready().catch((/** @type {any} */ err) => {
					_terminated = true;
					const errCode = err?.code || 'CONNECTION_CLOSED';
					const errMsg = err?.message || 'Connection permanently closed';
					// Reject all pending RPCs
					for (const [id, entry] of pending) {
						pending.delete(id);
						if (entry.timer) clearTimeout(entry.timer);
						entry.reject(new RpcError(errCode, errMsg));
					}
					// Reject in-flight uploads (terminal close mirrors disconnect)
					if (pendingUploads.size > 0) {
						const snapshot = [...pendingUploads.values()];
						for (const h of snapshot) h._settle(false, new RpcError(errCode, errMsg));
					}
					// Drain offline queue with errors
					for (const entry of _offlineQueue) {
						entry.reject(new RpcError(errCode, errMsg));
					}
					_offlineQueue.length = 0;
				});
			}
		} catch {
			// _connect may not be callable yet (SSR) - that's fine
		}
	}
}

/**
 * Dev-only: warn once per RPC path when the microtask dedup map
 * collapses two or more identical calls into one wire request. Surfaces
 * the silent surprise for stress tests and parallel-fan-out patterns
 * (`Promise.allSettled([...].map(() => rpc()))`) that expect N wire
 * requests but get one. Threshold is 1 (warn on first coalesce);
 * dedup-keyed by path so a button-mash double-click on the same path
 * warns once per session, not on every collapse.
 *
 * @param {string} path
 */
function _warnCoalesceOnce(path) {
	if (!_isDev()) return;
	if (_dedupCoalesceWarned.has(path)) return;
	_dedupCoalesceWarned.add(path);
	console.warn(
		"[svelte-realtime] coalesced two or more identical calls to '" + path +
		"' within one microtask - only one wire request was sent and all callers " +
		"received the same response. Dedup is intentional for accidental double-taps. " +
		"If you wanted N parallel requests (stress test, fan-out), call `.fresh(...args)` " +
		"on the rpc to bypass dedup. Warned once per path per session.\n  See: https://svti.me/dedup"
	);
}

/**
 * Build a dedup key from path and args, avoiding JSON.stringify for common cases.
 * @param {string} path
 * @param {any[]} args
 * @returns {string}
 */
function _buildDedupKey(path, args) {
	if (args.length === 0) return path;
	if (args.length === 1) {
		const a = args[0];
		if (a === null) return path + '\0N';
		if (a === undefined) return path + '\0U';
		const t = typeof a;
		if (t === 'string') return path + '\0S' + a;
		if (t === 'number') return path + '\0#' + a;
		if (t === 'boolean') return path + '\0B' + a;
	}
	return path + '\0' + JSON.stringify(args);
}

/**
 * Create a callable RPC function for a given path.
 * Used by generated client stubs.
 *
 * @param {string} path - e.g. 'chat/sendMessage'
 * @returns {((...args: any[]) => Promise<any>) & { fresh: (...args: any[]) => Promise<any>, with: (opts: { idempotencyKey?: string }) => (...args: any[]) => Promise<any> }}
 */
export function __rpc(path) {
	function rpcCall(...args) {
		// Dedup: coalesce identical calls within the same microtask
		if (!_batchCollector) {
			const dedupKey = _buildDedupKey(path, args);
			const existing = _dedupMap.get(dedupKey);
			if (existing) {
				_warnCoalesceOnce(path);
				return existing;
			}

			const promise = _sendRpc(path, args);
			_dedupMap.set(dedupKey, promise);
			queueMicrotask(() => _dedupMap.delete(dedupKey));
			return promise;
		}
		return _sendRpc(path, args);
	}

	/** Bypass deduplication - always send a fresh request. */
	rpcCall.fresh = function freshCall(...args) {
		return _sendRpc(path, args);
	};

	/**
	 * Send a fire-and-forget RPC. Returns `void` synchronously - no Promise,
	 * no pending entry, no timeout, no devtools-pending. The wire frame is
	 * `{rpc, args}` with no `id` field; the server runs the full handler
	 * chain (middleware, guards, rate limits, validation) but does not
	 * write a response. Errors are silently dropped on the wire.
	 *
	 * Pair with `live.volatile(fn)` server-side. Use for high-frequency
	 * one-way RPCs - cursor moves, drag updates, typing indicators,
	 * telemetry beacons, heartbeats. Skips: `_nextId()`, the Promise
	 * allocation, the dedup map, the pending Map entry, the timer
	 * allocation, the devtools-pending entry.
	 *
	 * Safety:
	 * - **Offline:** silent no-op while disconnected. No offline-queue
	 *   entry. Lossy under disconnect IS the contract.
	 * - **Backpressure:** if `conn.bufferedAmount` exceeds
	 *   `volatileBackpressureBytes` (default 4 MB - see `configure(...)`),
	 *   the send is dropped and the drop counter ticks. Prevents the WS
	 *   send queue from growing unbounded on a stuck connection.
	 * - **Inside `batch()`:** dev-mode throws; production no-op. Volatile
	 *   bypasses batching by design.
	 *
	 * @param {...any} args - Arguments forwarded to the handler
	 * @returns {void}
	 *
	 * @example
	 * ```js
	 * import { moveCursor } from '$live/cursors';
	 * moveCursor.fireAndForget('board-1', { x, y });
	 * ```
	 */
	rpcCall.fireAndForget = function fireAndForget(...args) {
		if (_terminated) return;
		if (_isOffline) { _volatileDropped++; return; }
		if (_batchCollector) {
			if (_IS_DEV) {
				throw new Error(
					`[svelte-realtime] '${path}'.fireAndForget() cannot be used inside batch() - volatile RPCs bypass batching.\n  See: https://svti.me/volatile`
				);
			}
			return;
		}
		ensureListener();
		ensureDisconnectListener();
		const conn = _connect();
		const cap = _clientConfig.volatileBackpressureBytes || _DEFAULT_VOLATILE_BACKPRESSURE_BYTES;
		if (typeof conn.bufferedAmount === 'number' && conn.bufferedAmount > cap) {
			_volatileDropped++;
			if (__devtools) __devtools.volatileDropped = _volatileDropped;
			if (_IS_DEV && !_volatileBackpressureWarned) {
				_volatileBackpressureWarned = true;
				console.warn(
					`[svelte-realtime] volatile RPC '${path}' dropped: WS bufferedAmount (${conn.bufferedAmount} bytes) exceeded volatileBackpressureBytes (${cap}). ` +
					`This warning fires once per session; subsequent drops increment __devtools.volatileDropped silently. ` +
					`Raise the threshold via configure({ volatileBackpressureBytes }) if your app legitimately bursts above 4 MB of in-flight WS traffic.\n  See: https://svti.me/volatile`
				);
			}
			return;
		}
		_devtoolsVolatileSent(path, args);
		conn.sendQueued({ rpc: path, args });
	};

	/**
	 * Attach per-call options. Returns a callable bound to those options.
	 *
	 * - `idempotencyKey` - the server-side handler must be wrapped with
	 *   `live.idempotent({...})` for the key to take effect. Calls bound
	 *   to the same key dedup against each other within a microtask.
	 * - `timeout` - per-RPC override of the global timeout (default 30s).
	 *   Use for known-slow queries; the call waits up to `timeout` ms
	 *   before rejecting with `TIMEOUT`. Per-call `timeout` is ignored
	 *   inside `batch(fn)` (the batch-level timer governs all collected
	 *   calls there).
	 *
	 * Calling with no options returns the base callable unchanged.
	 */
	rpcCall.with = function withOptions(opts) {
		const idempotencyKey = opts && opts.idempotencyKey;
		const timeout = opts && opts.timeout;
		if (!idempotencyKey && !timeout) return rpcCall;
		return function withCall(...args) {
			// Dedup only when an idempotency key is bound. Timeout-only calls
			// bypass dedup - the longer-waiting caller would otherwise be
			// rejected at the shorter call's timeout.
			if (!_batchCollector && idempotencyKey) {
				const dedupKey = path + '\0K' + idempotencyKey;
				const existing = _dedupMap.get(dedupKey);
				if (existing) {
					_warnCoalesceOnce(path);
					return existing;
				}
				const promise = _sendRpc(path, args, idempotencyKey, timeout);
				_dedupMap.set(dedupKey, promise);
				queueMicrotask(() => _dedupMap.delete(dedupKey));
				return promise;
			}
			return _sendRpc(path, args, idempotencyKey, timeout);
		};
	};

	/**
	 * Bind this RPC to a stream store as an optimistic mutation. Equivalent
	 * to `store.mutate(() => rpc(...callArgs), wrapped)` where `wrapped`
	 * forwards `callArgs` into a `(current, args)` callback so tests and
	 * helpers don't have to capture them in a closure.
	 *
	 * Two call shapes:
	 * - **Direct**: `rpc.createOptimistic(store, callArgs, change)` - runs
	 *   immediately, returns the asyncOp's result Promise.
	 * - **Curried**: `rpc.createOptimistic(store, change)` - returns a
	 *   `(...callArgs) => Promise` callable bound to that store + change.
	 *   Useful when one optimistic-update setup applies to many call sites.
	 *
	 * @param {{ mutate: Function }} store - Stream store from `$live/<module>` (must expose `.mutate`)
	 * @param {any[] | ((current: any, args: any[]) => any) | { event: string, data: any }} callArgsOrChange
	 *   In the direct form, the RPC arguments array. In the curried form,
	 *   the optimistic change (function or `{event, data}`).
	 * @param {((current: any, args: any[]) => any) | { event: string, data: any }} [optimisticChange]
	 *   Direct-form only: the optimistic change.
	 * @returns {Promise<any> | ((...callArgs: any[]) => Promise<any>)}
	 *   Direct form returns a Promise; curried form returns a callable.
	 */
	rpcCall.createOptimistic = function createOptimisticCall(store, callArgsOrChange, optimisticChange) {
		if (!store || typeof store.mutate !== 'function') {
			throw new Error('[svelte-realtime] createOptimistic: first argument must be a stream store with a .mutate() method');
		}
		// Curry detection: 2 args means (store, change), return a callable.
		if (arguments.length === 2) {
			const change = callArgsOrChange;
			if (change == null) {
				throw new Error('[svelte-realtime] createOptimistic: optimisticChange is required (use { event, data } or (current, args) => newValue)');
			}
			return function curriedCreateOptimistic(...callArgs) {
				const wrapped = typeof change === 'function'
					? /** @param {any} current */ (current) => /** @type {any} */ (change)(current, callArgs)
					: change;
				return store.mutate(() => rpcCall(...callArgs), wrapped);
			};
		}
		// Direct form: (store, callArgs, change)
		const callArgs = callArgsOrChange;
		if (!Array.isArray(callArgs)) {
			throw new Error('[svelte-realtime] createOptimistic: callArgs must be an array (got ' + (callArgs === null ? 'null' : typeof callArgs) + ')');
		}
		if (optimisticChange == null) {
			throw new Error('[svelte-realtime] createOptimistic: optimisticChange is required (use { event, data } or (current, args) => newValue)');
		}
		const wrapped = typeof optimisticChange === 'function'
			? (current) => optimisticChange(current, callArgs)
			: optimisticChange;
		return store.mutate(() => rpcCall(...callArgs), wrapped);
	};

	return rpcCall;
}

/**
 * Internal: send an RPC request over the WebSocket.
 * @param {string} path
 * @param {any[]} args
 * @param {string} [idempotencyKey] Optional envelope idempotency key. When set, the server-side
 *   `live.idempotent` wrapper uses it to dedup against its store.
 * @param {number} [timeout] Per-RPC timeout override in ms. Falls back to
 *   `configure({ timeout })` then to the 30s default.
 * @returns {Promise<any>}
 */
function _sendRpc(path, args, idempotencyKey, timeout) {
	ensureListener();
	ensureDisconnectListener();

	// Fast-fail if connection is permanently dead
	if (_terminated) {
		return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
	}

	if (typeof process === 'undefined' || (typeof import.meta !== 'undefined' && import.meta.env?.DEV)) {
		_checkArgs(path, args);
	}

	// Offline queue: if disconnected and queue is enabled, defer the call
	if (_isOffline && _clientConfig.offline?.queue && !_batchCollector) {
		const maxQueue = _clientConfig.offline.maxQueue || 100;
		return new Promise((resolve, reject) => {
			if (_offlineQueue.length >= maxQueue) {
				// Drop oldest
				const dropped = _offlineQueue.shift();
				if (dropped) dropped.reject(new RpcError('QUEUE_FULL', 'Offline queue overflow - oldest mutation dropped'));
			}
			_offlineQueue.push({ path, args, queuedAt: Date.now(), resolve, reject, idempotencyKey, timeout });
		});
	}

	const id = _nextId();

	// If inside a batch() call, collect instead of sending. The batch-level
	// timer governs all collected calls; per-call `timeout` is intentionally
	// dropped here (documented limitation).
	if (_batchCollector) {
		_batchCollector.push(idempotencyKey ? { rpc: path, id, args, idempotencyKey } : { rpc: path, id, args });
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject, timer: null });
		});
	}

	_devtoolsStart(path, id, args);
	const conn = _connect();
	const effectiveTimeout = timeout || _getTimeout();
	// Sleep-detect threshold scales with the effective timeout so longer
	// timeouts don't misfire as SLEEP_TIMEOUT. Floor at 90s preserves the
	// original heuristic for the 30s default case.
	const sleepThreshold = Math.max(effectiveTimeout * 3, 90000);

	return new Promise((resolve, reject) => {
		const _startTime = Date.now();
		const timer = setTimeout(() => {
			if (Date.now() - _startTime > sleepThreshold) {
				// Device was sleeping. Clean up the pending entry so it doesn't hang
				// forever - the disconnect listener or reconnect will handle the actual error.
				pending.delete(id);
				_devtoolsEnd(id, false, 'SLEEP_TIMEOUT');
				reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
				return;
			}
			pending.delete(id);
			_devtoolsEnd(id, false, 'TIMEOUT');
			reject(new RpcError('TIMEOUT', `RPC '${path}' timed out after ${Math.round(effectiveTimeout / 1000)}s`));
		}, effectiveTimeout);

		pending.set(id, {
			resolve(v) { _devtoolsEnd(id, true, v); resolve(v); },
			reject(e) { _devtoolsEnd(id, false, e); reject(e); },
			timer
		});
		conn.sendQueued(idempotencyKey ? { rpc: path, id, args, idempotencyKey } : { rpc: path, id, args });
	});
}

/**
 * Create a callable binary RPC function for a given path.
 * Sends the first argument as raw binary and remaining args as JSON in a header.
 *
 * @param {string} path - e.g. 'upload/avatar'
 * @returns {(buffer: ArrayBuffer, ...args: any[]) => Promise<any>}
 */
export function __binaryRpc(path) {
	return function binaryRpcCall(buffer, ...args) {
		if (_terminated) {
			return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
		}
		ensureListener();
		ensureDisconnectListener();

		const id = _nextId();

		_devtoolsStart(path, id, args);
		const conn = _connect();

		return new Promise((resolve, reject) => {
			const _startTime = Date.now();
			const timer = setTimeout(() => {
				if (Date.now() - _startTime > 90000) {
					pending.delete(id);
					_devtoolsEnd(id, false, 'SLEEP_TIMEOUT');
					reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
					return;
				}
				pending.delete(id);
				_devtoolsEnd(id, false, 'TIMEOUT');
				reject(new RpcError('TIMEOUT', `Binary RPC '${path}' timed out after 30s`));
			}, _getTimeout());

			pending.set(id, {
				resolve(v) { _devtoolsEnd(id, true, v); resolve(v); },
				reject(e) { _devtoolsEnd(id, false, e); reject(e); },
				timer
			});

			// Wire format: byte[0] = 0x00, byte[1-2] = header length (uint16 BE), then JSON header, then binary payload
			const header = JSON.stringify({ rpc: path, id, args: args.length > 0 ? args : undefined });
			const headerBytes = _textEncoder.encode(header);
			if (headerBytes.length > 0xFFFF) {
				pending.delete(id);
				clearTimeout(timer);
				reject(new RpcError('PAYLOAD_TOO_LARGE', 'Binary RPC header exceeds 65535 bytes'));
				return;
			}
			const bufBytes = ArrayBuffer.isView(buffer)
				? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
				: new Uint8Array(buffer);
			const size = 3 + headerBytes.length + bufBytes.length;
			const frame = _getBinaryFrame(size);
			frame[0] = 0x00;
			frame[1] = (headerBytes.length >> 8) & 0xFF;
			frame[2] = headerBytes.length & 0xFF;
			frame.set(headerBytes, 3);
			frame.set(bufBytes, 3 + headerBytes.length);

			// Send a view of exactly the right size (frame may be oversized from reuse)
			conn.sendQueued(frame.buffer.slice(0, size));
		});
	};
}

// - Streaming uploads (live.upload) -----------------------------------------
//
// Wire format mirrors the server side:
//
//   Chunk frame (client -> server):
//     [0]      0x01 - chunk marker
//     [1]      flags  (bit 0: hasArgs, bit 1: isLast, bits 2-7: reserved=0)
//     [2..5]   streamId, big-endian uint32
//     [6..9]   seq, big-endian uint32 (0-indexed, contiguous)
//     [10..]   if hasArgs:
//                [10..11] argsLen, big-endian uint16
//                [12..12+argsLen-1] argsJson UTF-8: { rpc, args? }
//                [12+argsLen..] payload bytes
//              else:
//                [10..] payload bytes
//
//   Cancel frame (client -> server):
//     [0]      0x02
//     [1]      0x10 (cancel)
//     [2..5]   streamId
//
// Server -> client uses platform.send(ws, '__upload', streamIdHex, payload)
// where streamIdHex is the 8-char hex of the uint32 streamId. Payload is
// either { ok: true, data } or { ok: false, code, error }.

/** Default wire-frame size in bytes when neither user-configured nor
 * server-discovered. Tuned to fit under `svelte-adapter-uws`'s old default
 * `maxPayloadLength` (16KB) with room for the frame header and args JSON.
 * Discovery via the server's `__cap` hint upgrades this automatically on
 * the first upload response (e.g. to 1MB under the adapter's 0.5.x default).
 *
 * "Frame size" is the maximum wire frame bytes the framework will emit;
 * payload bytes per chunk are derived by subtracting envelope overhead
 * (10 bytes on chunks 1+, `12 + argsLen` on chunk 0). */
const _DEFAULT_UPLOAD_FRAME_SIZE = 12 * 1024;

/** Per-chunk envelope overhead. Chunks 1+ are 10 bytes (frame header).
 * Chunk 0 is 12 bytes (frame header + argsLen uint16) plus the args JSON
 * itself (`argsLen` bytes). Pre-fix, the chunk size knob was used as raw
 * payload bytes per chunk: `frame = chunkSize + overhead` could overflow
 * the adapter's `maxPayloadLength` cap, and the adapter closed the
 * connection with code 1009. Post-fix, the knob is the frame size and
 * the framework subtracts overhead per chunk -- no overflow possible. */
const _UPLOAD_FRAME_HEADER_BYTES = 10;
const _UPLOAD_FRAME_HEADER_WITH_ARGS_BYTES = 12;

/** High-water mark for the WS send queue, in bytes. When `conn.bufferedAmount`
 * (svelte-adapter-uws/client next.19+) exceeds this, the upload pump pauses
 * sending new chunks until the queue drops below `_DEFAULT_UPLOAD_LOW_WATER_MARK`.
 * Keeps the browser send buffer bounded regardless of file size. */
const _DEFAULT_UPLOAD_HIGH_WATER_MARK = 4 * 1024 * 1024;
const _DEFAULT_UPLOAD_LOW_WATER_MARK = 1 * 1024 * 1024;
const _UPLOAD_DRAIN_POLL_MS = 50;

/** Default backpressure threshold for `.fireAndForget()`. When `conn.bufferedAmount`
 * exceeds this, the volatile send is dropped silently and the drop counter
 * ticks. Sized for 120Hz cursor + drag traffic (~24 KB/sec per client on
 * volatile paths): 4 MB gives ~170s of buffer headroom before drops kick
 * in - healthy demos never trip it; a genuinely dead connection does
 * before browser OOM. Override via `configure({ volatileBackpressureBytes })`. */
const _DEFAULT_VOLATILE_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/** Volatile-send drop counter. Incremented when a `.fireAndForget()` call is
 * dropped (offline, backpressure, terminated). Exposed to devtools as
 * `__devtools.volatileDropped`. */
let _volatileDropped = 0;

/** Dev-warn dedup: one-shot warn when the first volatile backpressure drop
 * happens, so apps notice in development that they're hitting the cap. */
let _volatileBackpressureWarned = false;

/** Server-discovered `platform.maxPayloadLength`. Updated whenever an upload
 * response arrives carrying `__cap`. 0 = not yet discovered. */
let _discoveredUploadMaxFrameSize = 0;

/** @type {boolean} Dev-warn dedup: clamp-against-adapter-cap warning. */
let _uploadFrameSizeClampWarned = false;
/** @type {boolean} Dev-warn dedup: deprecated `chunkSize` field warning. */
let _uploadChunkSizeDeprecatedWarned = false;

/**
 * Compute the upload frame size (max wire frame bytes per chunk). Priority:
 *   1. User-configured `configure({ upload: { frameSize } })` (or the
 *      deprecated alias `chunkSize`) -- clamped to the discovered cap.
 *   2. Auto-discovered: the server's `maxPayloadLength`, used as-is. The
 *      framework subtracts envelope overhead per chunk; no 0.9 safety
 *      factor is needed because frame size IS the cap.
 *   3. Conservative default `_DEFAULT_UPLOAD_FRAME_SIZE` (12KB) -- only
 *      used for the very first upload after page load, before discovery.
 *
 * Re-evaluated at every upload start so the SECOND upload picks up the
 * value discovered on the first.
 *
 * **Hard invariant:** the returned frame size never exceeds the discovered
 * adapter cap. User input above the cap is silently clamped down with a
 * one-time dev-mode warning. The adapter would close the connection with
 * code 1009 if any frame exceeded its cap, so the framework enforces this
 * ceiling structurally rather than trusting user input.
 *
 * @returns {number}
 */
function _computeUploadFrameSize() {
	const cfg = _clientConfig.upload;

	// Resolve the user-supplied value, preferring `frameSize` over the
	// deprecated `chunkSize` alias. Warn once per session if the deprecated
	// name is used so existing apps get a migration pointer in dev.
	/** @type {number | undefined} */
	let userFrameSize;
	if (cfg && typeof cfg.frameSize === 'number' && cfg.frameSize > 0) {
		userFrameSize = cfg.frameSize;
	} else if (cfg && typeof cfg.chunkSize === 'number' && cfg.chunkSize > 0) {
		userFrameSize = cfg.chunkSize;
		if (_isDev() && !_uploadChunkSizeDeprecatedWarned) {
			_uploadChunkSizeDeprecatedWarned = true;
			console.warn(
				"[svelte-realtime] configure({ upload: { chunkSize } }) is deprecated -- " +
				"rename to `frameSize`. The new name reflects the actual semantic: maximum " +
				"wire frame size, from which the framework subtracts envelope overhead " +
				"automatically. The value passes through unchanged."
			);
		}
	}

	const discoveredCap = _discoveredUploadMaxFrameSize > 0 ? _discoveredUploadMaxFrameSize : Infinity;

	if (userFrameSize !== undefined) {
		if (userFrameSize > discoveredCap) {
			if (_isDev() && !_uploadFrameSizeClampWarned) {
				_uploadFrameSizeClampWarned = true;
				console.warn(
					"[svelte-realtime] configure({ upload: { frameSize: " + userFrameSize + " } }) " +
					"exceeds the adapter's discovered maxPayloadLength (" + discoveredCap + " bytes); " +
					"clamping to the adapter cap. Without this clamp the adapter would close the " +
					"connection (code 1009). Either lower frameSize or raise the adapter's " +
					"`maxPayloadLength` config to match. Warned once per session."
				);
			}
			return discoveredCap;
		}
		return userFrameSize;
	}

	if (_discoveredUploadMaxFrameSize > 0) return _discoveredUploadMaxFrameSize;
	return _DEFAULT_UPLOAD_FRAME_SIZE;
}

/**
 * Derive the per-chunk payload size from a frame size and the chunk-0
 * args JSON length. The same payload size is used for every chunk in the
 * upload; chunk 0 fills its frame exactly (`payload + 12 + argsLen = frame`)
 * while chunks 1+ leave `2 + argsLen` bytes of frame budget unused. The
 * waste is ~0.01% on a 1MB-cap adapter with typical 100-byte args -- well
 * worth the simplicity of one chunk size for the whole upload.
 *
 * @param {number} frameSize
 * @param {number} argsLen
 * @returns {number}
 */
function _payloadSizeForFrame(frameSize, argsLen) {
	return Math.max(1, frameSize - _UPLOAD_FRAME_HEADER_WITH_ARGS_BYTES - argsLen);
}

/** @internal Reset auto-discovered state and warn dedup flags. Test-only. */
export function _resetUploadAutoDiscovery() {
	_discoveredUploadMaxFrameSize = 0;
	_uploadFrameSizeClampWarned = false;
	_uploadChunkSizeDeprecatedWarned = false;
}

/** @type {Map<number, UploadHandle>} */
const pendingUploads = new Map();

/** @type {boolean} */
let uploadListenerAttached = false;

/** Per-connection counter for client-assigned streamIds. uint32; skips 0
 * because `0` reads as the empty / "no streamId" sentinel in some debug
 * paths. Wraps cleanly past 2^32 via `>>> 0`. */
let _streamIdCounter = 0;
function _nextUploadStreamId() {
	_streamIdCounter = (_streamIdCounter + 1) >>> 0;
	if (_streamIdCounter === 0) _streamIdCounter = 1;
	return _streamIdCounter;
}

function _streamIdHexClient(streamId) {
	return (streamId >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a 0x01 chunk frame.
 *
 * @param {number} streamId
 * @param {number} seq
 * @param {boolean} isLast
 * @param {boolean} hasArgs
 * @param {string | null} argsJson - pre-serialised JSON header for chunk 0
 * @param {Uint8Array | null} payload
 * @returns {ArrayBuffer}
 */
function _encodeUploadChunkFrame(streamId, seq, isLast, hasArgs, argsJson, payload) {
	const argsBytes = hasArgs && argsJson ? _textEncoder.encode(argsJson) : null;
	const argsLen = argsBytes ? argsBytes.length : 0;
	const headerLen = hasArgs ? 12 + argsLen : 10;
	const payloadLen = payload ? payload.byteLength : 0;
	const totalLen = headerLen + payloadLen;

	const buf = new ArrayBuffer(totalLen);
	const u8 = new Uint8Array(buf);
	const view = new DataView(buf);
	view.setUint8(0, 0x01);
	let flags = 0;
	if (hasArgs) flags |= 0x01;
	if (isLast) flags |= 0x02;
	view.setUint8(1, flags);
	view.setUint32(2, streamId >>> 0, false);
	view.setUint32(6, seq >>> 0, false);
	if (hasArgs) {
		view.setUint16(10, argsLen, false);
		if (argsBytes) u8.set(argsBytes, 12);
		if (payload) u8.set(payload, 12 + argsLen);
	} else if (payload) {
		u8.set(payload, 10);
	}
	return buf;
}

/**
 * Build a 0x02 cancel control frame.
 * @param {number} streamId
 * @returns {ArrayBuffer}
 */
function _encodeUploadCancelFrame(streamId) {
	const buf = new ArrayBuffer(6);
	const view = new DataView(buf);
	view.setUint8(0, 0x02);
	view.setUint8(1, 0x10);
	view.setUint32(2, streamId >>> 0, false);
	return buf;
}

/**
 * Returns the total byte length of the source if known, otherwise undefined.
 * Used to drive `progress.total` and `progress.percent`.
 * @param {any} source
 * @returns {number | undefined}
 */
function _uploadSourceTotal(source) {
	if (typeof Blob !== 'undefined' && source instanceof Blob) return source.size;
	if (source instanceof ArrayBuffer) return source.byteLength;
	if (ArrayBuffer.isView(source)) return /** @type {ArrayBufferView} */ (source).byteLength;
	return undefined;
}

/**
 * Async-iterate any supported source as `Uint8Array` chunks of `chunkSize`.
 * Last chunk may be smaller than `chunkSize`. Empty sources yield nothing.
 *
 * Supported: `Blob` / `File`, `ArrayBuffer`, any `ArrayBufferView`,
 * `ReadableStream<Uint8Array>`. Throws `TypeError` for anything else.
 *
 * @param {any} source
 * @param {number} chunkSize
 * @returns {AsyncIterable<Uint8Array>}
 */
async function* _chunkUploadSource(source, chunkSize) {
	if (typeof Blob !== 'undefined' && source instanceof Blob) {
		let offset = 0;
		while (offset < source.size) {
			const slice = source.slice(offset, offset + chunkSize);
			yield new Uint8Array(await slice.arrayBuffer());
			offset += chunkSize;
		}
		return;
	}
	if (source instanceof ArrayBuffer) {
		const view = new Uint8Array(source);
		let offset = 0;
		while (offset < view.byteLength) {
			yield view.subarray(offset, Math.min(offset + chunkSize, view.byteLength));
			offset += chunkSize;
		}
		return;
	}
	if (ArrayBuffer.isView(source)) {
		const u8 = source instanceof Uint8Array
			? source
			: new Uint8Array(/** @type {any} */ (source).buffer, /** @type {any} */ (source).byteOffset, /** @type {any} */ (source).byteLength);
		let offset = 0;
		while (offset < u8.byteLength) {
			yield u8.subarray(offset, Math.min(offset + chunkSize, u8.byteLength));
			offset += chunkSize;
		}
		return;
	}
	if (typeof ReadableStream !== 'undefined' && source instanceof ReadableStream) {
		yield* _chunkReadableStream(source, chunkSize);
		return;
	}
	throw new TypeError('Unsupported upload source: expected Blob, File, ArrayBuffer, ArrayBufferView, or ReadableStream');
}

/**
 * Re-chunk a `ReadableStream<Uint8Array>` to fixed-size chunks. Buffers
 * across reads so the producer's chunk boundaries don't matter.
 * @param {ReadableStream<any>} stream
 * @param {number} chunkSize
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* _chunkReadableStream(stream, chunkSize) {
	const reader = stream.getReader();
	/** @type {Uint8Array[]} */
	const pending = [];
	let pendingBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) {
				throw new TypeError('ReadableStream must yield Uint8Array');
			}
			if (value.byteLength === 0) continue;
			pending.push(value);
			pendingBytes += value.byteLength;

			while (pendingBytes >= chunkSize) {
				const out = new Uint8Array(chunkSize);
				let written = 0;
				while (written < chunkSize) {
					const head = pending[0];
					const remaining = chunkSize - written;
					if (head.byteLength <= remaining) {
						out.set(head, written);
						written += head.byteLength;
						pending.shift();
					} else {
						out.set(head.subarray(0, remaining), written);
						pending[0] = head.subarray(remaining);
						written += remaining;
					}
				}
				pendingBytes -= chunkSize;
				yield out;
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* already released */ }
	}

	if (pendingBytes > 0) {
		const out = new Uint8Array(pendingBytes);
		let written = 0;
		for (const buf of pending) {
			out.set(buf, written);
			written += buf.byteLength;
		}
		yield out;
	}
}

/**
 * Subscribe to the `__upload` topic exactly once. Routes incoming envelopes
 * to the matching pending handle by streamId.
 */
function ensureUploadListener() {
	if (uploadListenerAttached) return;
	uploadListenerAttached = true;

	const store = on('__upload');
	store.subscribe((envelope) => {
		if (!envelope) return;
		// Always update the auto-discovered cap, even for envelopes that
		// don't match a pending handle (late responses after cancel still
		// teach us the server's frame-size cap).
		const data = envelope.data;
		if (data && typeof data.__cap === 'number' && data.__cap > 0) {
			_discoveredUploadMaxFrameSize = data.__cap;
		}
		const streamIdHex = envelope.event;
		const streamId = parseInt(streamIdHex, 16);
		if (!Number.isFinite(streamId)) return;
		const handle = pendingUploads.get(streamId);
		if (!handle) return;
		handle._onServerResponse(data);
	});
}

/**
 * Drive the chunk pump for one upload. Runs as a long-lived async function;
 * caller is `UploadHandle._start()` which wraps it in error handling.
 * @param {UploadHandle} handle
 */
async function _pumpUpload(handle) {
	const argsJson = handle._argsJson;
	const conn = _connect();

	const iter = _chunkUploadSource(handle._source, handle._chunkSize)[Symbol.asyncIterator]();

	let cur = await iter.next();
	if (handle._cancelled || handle._settled) return;

	if (cur.done) {
		// Empty upload: chunk 0 with isLast=true and no payload, hasArgs=true.
		_sendUploadChunk(conn, handle, 0, true, true, argsJson, null);
		return;
	}

	let next = await iter.next();
	let seq = 0;
	while (!handle._cancelled && !handle._settled) {
		const isLast = next.done;
		const hasArgs = seq === 0;
		const payload = cur.value;

		_sendUploadChunk(conn, handle, seq, isLast, hasArgs, hasArgs ? argsJson : null, payload);
		handle._trackProgress(payload.byteLength);

		if (isLast) return;

		// Pace against the WS send queue. With svelte-adapter-uws/client next.19+
		// `conn.bufferedAmount` reflects the underlying browser WebSocket's
		// `bufferedAmount`. If undefined (older adapter), this is a no-op and
		// chunks are queued unbounded (the previous behaviour).
		await _maybePaceUpload(handle, conn);

		cur = next;
		next = await iter.next();
		seq++;
	}
}

/**
 * Wait for the WS send queue to drop below the low-water mark before allowing
 * the pump to send the next chunk. Bails out immediately on cancel, settle,
 * or terminal close. No-op when the adapter doesn't expose `bufferedAmount`.
 *
 * @param {UploadHandle} handle
 * @param {any} conn
 */
async function _maybePaceUpload(handle, conn) {
	if (typeof conn.bufferedAmount !== 'number') return;
	const cfg = _clientConfig.upload;
	const hi = cfg?.highWaterMark ?? _DEFAULT_UPLOAD_HIGH_WATER_MARK;
	if (conn.bufferedAmount <= hi) return;

	const lo = cfg?.lowWaterMark ?? _DEFAULT_UPLOAD_LOW_WATER_MARK;
	while (
		!handle._cancelled &&
		!handle._settled &&
		!_terminated &&
		typeof conn.bufferedAmount === 'number' &&
		conn.bufferedAmount > lo
	) {
		await new Promise((r) => setTimeout(r, _UPLOAD_DRAIN_POLL_MS));
	}
}

/**
 * Encode + send one chunk frame.
 * @param {any} conn
 * @param {UploadHandle} handle
 * @param {number} seq
 * @param {boolean} isLast
 * @param {boolean} hasArgs
 * @param {string | null} argsJson
 * @param {Uint8Array | null} payload
 */
function _sendUploadChunk(conn, handle, seq, isLast, hasArgs, argsJson, payload) {
	const frame = _encodeUploadChunkFrame(handle._streamId, seq, isLast, hasArgs, argsJson, payload);
	conn.sendQueued(frame);
}

/**
 * Handle returned by an upload call. Thenable (`await handle`), event
 * emitter (`handle.on('progress', ...)`), and abortable (`handle.cancel()`).
 *
 * Promise-shaped: `await handle` resolves with the server's return value
 * or rejects with `RpcError`. Codes seen at this layer:
 *   - `CANCELLED`            - caller cancelled (or AbortSignal aborted)
 *   - `DISCONNECTED`         - WS closed mid-upload
 *   - `CONNECTION_CLOSED`    - WS terminated before start
 *   - `SOURCE_ERROR`         - the source iterator threw (filesystem, etc.)
 *   - any code from the server (`PAYLOAD_TOO_LARGE`, `NOT_FOUND`, ...)
 *
 * Events:
 *   - `progress` - { sent, total?, percent?, chunks, bytesPerSec }
 *   - `complete` - the server's return value
 *   - `error`    - the RpcError that caused rejection
 *   - `cancel`   - the cancel reason (only if cancelled, fires before `error`)
 */
class UploadHandle {
	/**
	 * @param {string} path
	 * @param {any} source
	 * @param {any[]} args
	 * @param {{ chunkSize: number, streamId: number, total: number | undefined, argsJson: string }} options
	 */
	constructor(path, source, args, options) {
		this._path = path;
		this._source = source;
		this._args = args;
		this._chunkSize = options.chunkSize;
		this._streamId = options.streamId;
		this._total = options.total;
		this._argsJson = options.argsJson;
		this._sent = 0;
		this._chunks = 0;
		/** @type {Map<string, Set<(payload: any) => void>>} */
		this._listeners = new Map();
		this._settled = false;
		this._cancelled = false;
		/** @type {any} */
		this._cancelReason = null;
		/** @type {{ t: number, bytes: number }[]} */
		this._rateSamples = [];

		/** @type {Promise<any>} */
		this._promise = new Promise((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
		// Unhandled-rejection guard: pre-attach a no-op catch so the user
		// doesn't get a warning if they only listen via `on('error', ...)`.
		this._promise.catch(() => {});

		pendingUploads.set(this._streamId, this);

		// Microtask-deferred start so users can attach listeners + set up
		// cancellation between `const h = avatar(file)` and the first chunk.
		queueMicrotask(() => this._start());
	}

	/** Bytes uploaded so far. */
	get sent() { return this._sent; }
	/** Total bytes if known (Blob/Buffer); undefined for ReadableStream. */
	get total() { return this._total; }
	/** Chunks sent so far. */
	get chunks() { return this._chunks; }
	/** 0..1 if total known; undefined otherwise. */
	get progress() {
		if (this._total == null) return undefined;
		if (this._total === 0) return 1;
		return this._sent / this._total;
	}
	/** Smoothed throughput over the last ~1s, in bytes/sec. */
	get bytesPerSec() {
		if (this._rateSamples.length === 0) return 0;
		const now = Date.now();
		let total = 0;
		for (const s of this._rateSamples) total += s.bytes;
		const span = Math.max(1, now - this._rateSamples[0].t);
		return Math.round(total * 1000 / span);
	}
	/** Numeric streamId (uint32). Hex via `streamIdHex`. */
	get streamId() { return this._streamId; }
	/** 8-char hex matching server-side `ctx.upload.id`. */
	get streamIdHex() { return _streamIdHexClient(this._streamId); }

	/**
	 * Subscribe to a handle event. Returns an unsubscribe function.
	 * Events: 'progress', 'complete', 'error', 'cancel'.
	 * @param {'progress' | 'complete' | 'error' | 'cancel'} event
	 * @param {(payload: any) => void} callback
	 * @returns {() => void}
	 */
	on(event, callback) {
		let set = this._listeners.get(event);
		if (!set) { set = new Set(); this._listeners.set(event, set); }
		set.add(callback);
		return () => { set.delete(callback); };
	}

	/**
	 * Cancel the upload. Sends a control frame to the server (best-effort)
	 * and rejects the promise with `RpcError('CANCELLED')`. Idempotent.
	 *
	 * Compose with `AbortController`:
	 *   `ac.signal.addEventListener('abort', () => handle.cancel())`
	 *
	 * @param {string} [reason]
	 */
	cancel(reason) {
		if (this._settled) return;
		this._cancelled = true;
		this._cancelReason = reason;
		try {
			const conn = _connect();
			conn.sendQueued(_encodeUploadCancelFrame(this._streamId));
		} catch { /* connection may be closed; server will discard the upload */ }
		this._settle(false, new RpcError('CANCELLED', typeof reason === 'string' ? reason : 'upload cancelled'));
	}

	then(onFulfilled, onRejected) {
		return this._promise.then(onFulfilled, onRejected);
	}
	catch(onRejected) {
		return this._promise.catch(onRejected);
	}
	finally(onFinally) {
		return this._promise.finally(onFinally);
	}

	_emit(event, payload) {
		const set = this._listeners.get(event);
		if (!set) return;
		for (const cb of [...set]) {
			try { cb(payload); } catch (err) {
				if (typeof console !== 'undefined') {
					console.error(`[svelte-realtime] upload '${event}' listener threw:`, err, '\n  See: https://svti.me/uploads');
				}
			}
		}
	}

	_settle(ok, payload) {
		if (this._settled) return;
		this._settled = true;
		pendingUploads.delete(this._streamId);
		if (ok) {
			this._emit('complete', payload);
			this._resolve(payload);
		} else {
			if (this._cancelled) this._emit('cancel', this._cancelReason);
			this._emit('error', payload);
			this._reject(payload);
		}
	}

	/** @param {{ ok?: boolean, data?: any, code?: string, error?: string, __cap?: number }} envelope */
	_onServerResponse(envelope) {
		// Auto-discover server's frame-size cap, regardless of settled state
		// so late responses still update the cache for future uploads.
		if (envelope && typeof envelope.__cap === 'number' && envelope.__cap > 0) {
			_discoveredUploadMaxFrameSize = envelope.__cap;
		}
		if (this._settled) return;
		if (envelope && envelope.ok) {
			this._settle(true, envelope.data);
		} else if (envelope) {
			const err = new RpcError(envelope.code || 'UNKNOWN', envelope.error || 'Upload failed');
			this._settle(false, err);
		}
	}

	_onDisconnect() {
		if (this._settled) return;
		this._settle(false, new RpcError('DISCONNECTED', 'WebSocket connection lost'));
	}

	_trackProgress(bytes) {
		this._sent += bytes;
		this._chunks++;
		const now = Date.now();
		this._rateSamples.push({ t: now, bytes });
		while (this._rateSamples.length > 0 && now - this._rateSamples[0].t > 1000) {
			this._rateSamples.shift();
		}
		this._emit('progress', {
			sent: this._sent,
			total: this._total,
			percent: this.progress,
			chunks: this._chunks,
			bytesPerSec: this.bytesPerSec
		});
	}

	async _start() {
		if (this._settled) return;
		if (_terminated) {
			this._settle(false, new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
			return;
		}

		ensureUploadListener();
		ensureDisconnectListener();

		try {
			await _pumpUpload(this);
		} catch (err) {
			if (this._settled) return;
			// Pump errored without a server response - typically a source-iter
			// failure (fs read, ReadableStream throw). Send a cancel so the
			// server doesn't keep waiting for chunks that won't arrive.
			if (!this._cancelled) {
				try {
					const conn = _connect();
					conn.sendQueued(_encodeUploadCancelFrame(this._streamId));
				} catch { /* closed; server cleans up via close hook */ }
			}
			const wrapped = err instanceof RpcError
				? err
				: new RpcError('SOURCE_ERROR', (err && err.message) ? err.message : String(err));
			this._settle(false, wrapped);
		}
	}
}

/**
 * Create a callable upload function for a given path. The returned function
 * takes `(source, ...args)` and returns an `UploadHandle`. Source is any
 * `Blob` / `File` / `ArrayBuffer` / `ArrayBufferView` / `ReadableStream`.
 *
 * Used by Vite-plugin-generated stubs and available for direct use:
 *
 * ```js
 * import { __upload } from 'svelte-realtime/client';
 * const avatar = __upload('routes/avatars/upload/avatar');
 *
 * const handle = avatar(file, 'cat.png', 'image/png');
 * handle.on('progress', (p) => bar.value = p.percent ?? 0);
 * const result = await handle;
 * ```
 *
 * @param {string} path
 * @returns {(source: any, ...args: any[]) => UploadHandle}
 */
export function __upload(path) {
	return function uploadCall(source, ...args) {
		// Pre-compute args JSON + argsLen so the chunk-0 envelope overhead
		// is known statically for the whole upload. This lets us guarantee
		// every wire frame fits inside the adapter's maxPayloadLength cap.
		const argsJson = JSON.stringify({
			rpc: path,
			args: args.length > 0 ? args : undefined
		});
		const argsLen = _textEncoder.encode(argsJson).length;
		const frameSize = _computeUploadFrameSize();
		const chunkSize = _payloadSizeForFrame(frameSize, argsLen);
		const streamId = _nextUploadStreamId();
		const total = _uploadSourceTotal(source);
		return new UploadHandle(path, source, args, { chunkSize, streamId, total, argsJson });
	};
}

/**
 * Drain in-flight uploads on disconnect. Called from `ensureDisconnectListener`.
 */
function _drainPendingUploadsOnDisconnect() {
	if (pendingUploads.size === 0) return;
	const snapshot = [...pendingUploads.values()];
	for (const handle of snapshot) handle._onDisconnect();
}

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
		queueMicrotask(() => {
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
		if (_terminated) {
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
				if (prev.timer) clearTimeout(prev.timer);
			}
			pendingId = null;
		}

		ensureListener();
		ensureDisconnectListener();

		const id = _nextId();
		pendingId = id;
		const conn = _connect();

		const _startTime = Date.now();
		const timer = setTimeout(() => {
			if (Date.now() - _startTime > 90000) {
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
				if (entry.timer) clearTimeout(entry.timer);
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
			clearTimeout(_reconnectTimer);
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
				if (_reconnectTimer) clearTimeout(_reconnectTimer);
				let delay;
				// Reconnect jitter: spread a fleet's reconnect attempts across the
				// window so a server restart does not get a thundering-herd retry
				// spike. Math.random is the right primitive here - jitter does not
				// need crypto-quality entropy. Not security-relevant.
				if (_reconnectAttempts < 2) {
					delay = 20 + Math.floor(Math.random() * 80);
				} else {
					const base = Math.min(1000 * Math.pow(2.2, _reconnectAttempts - 2), 300000);
					delay = Math.floor(base * (0.75 + Math.random() * 0.5));
				}
				_reconnectAttempts++;
				_reconnectTimer = setTimeout(() => {
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
						clearTimeout(_resumeGraceTimer);
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
					queueMicrotask(() => {
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
								_resumeGraceTimer = setTimeout(() => {
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

			if (_optimisticQueue.length >= _maxOptimisticQueueDepth) {
				throw new Error(
					'[svelte-realtime] mutate(): in-flight optimistic queue depth ' +
					_optimisticQueue.length + ' exceeds MAX_OPTIMISTIC_QUEUE_DEPTH=' +
					_maxOptimisticQueueDepth + '. ' +
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
			if (_terminated) {
				throw new RpcError('CONNECTION_CLOSED', 'Connection permanently closed');
			}
			_loadingMore = true;

			ensureListener();
			const id = _nextId();
			const conn = _connect();

			return new Promise((resolve, reject) => {
				const _startTime = Date.now();
				const timer = setTimeout(() => {
					if (Date.now() - _startTime > 90000) {
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

/**
 * Group multiple RPC calls into a single WebSocket frame.
 * Returns an array of results in the same order as the calls.
 *
 * @param {() => Promise<any>[]} fn - Function that returns an array of RPC call promises
 * @param {{ sequential?: boolean }} [options]
 * @returns {Promise<any[]>}
 */
export function batch(fn, options) {
	if (_terminated) {
		return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
	}
	ensureListener();
	ensureDisconnectListener();

	// Collect RPC calls during fn() execution
	_batchCollector = [];
	/** @type {any} */
	let promises;
	try {
		promises = fn();
	} catch (err) {
		// Clean up collector and any pending entries on synchronous throw
		const collected = _batchCollector;
		_batchCollector = null;
		if (collected) {
			for (const call of collected) {
				const entry = pending.get(call.id);
				if (entry) {
					pending.delete(call.id);
					if (entry.timer) clearTimeout(entry.timer);
				}
			}
		}
		throw err;
	}
	const collected = _batchCollector;
	_batchCollector = null;

	if (collected.length === 0) return Promise.resolve([]);

	if (collected.length > 50) {
		for (const call of collected) {
			const entry = pending.get(call.id);
			if (entry) {
				pending.delete(call.id);
				if (entry.timer) clearTimeout(entry.timer);
				entry.reject(new RpcError('INVALID_REQUEST', 'Batch exceeds maximum of 50 calls'));
			}
		}
		return Promise.reject(new RpcError('INVALID_REQUEST', 'Batch exceeds maximum of 50 calls'));
	}

	const conn = _connect();
	const effectiveTimeout = _getTimeout();

	// Batch-of-1: send the bare RPC frame instead of wrapping in a batch
	// envelope. Defensive callers (single writes wrapped in batch() for API
	// symmetry) should not pay envelope cost or the round-trip of a batch
	// response. The collected entry's pending entry was created with
	// timer: null inside the call's __rpc path; attach a per-call timer
	// here so the single call still times out cleanly.
	if (collected.length === 1) {
		const call = collected[0];
		const _startTime = Date.now();
		const sleepThreshold = Math.max(effectiveTimeout * 3, 90000);
		const timer = setTimeout(() => {
			const entry = pending.get(call.id);
			if (!entry) return;
			pending.delete(call.id);
			if (Date.now() - _startTime > sleepThreshold) {
				entry.reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
			} else {
				entry.reject(new RpcError('TIMEOUT', `RPC '${call.rpc}' timed out after ${Math.round(effectiveTimeout / 1000)}s`));
			}
		}, effectiveTimeout);
		const existing = pending.get(call.id);
		if (existing) existing.timer = timer;
		conn.sendQueued(call);
		return Promise.all(promises);
	}

	// Set a batch-level timeout (sleep-aware)
	const _batchStartTime = Date.now();
	const batchTimer = setTimeout(() => {
		if (Date.now() - _batchStartTime > 90000) {
			for (const call of collected) {
				const entry = pending.get(call.id);
				if (entry) {
					pending.delete(call.id);
					entry.reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
				}
			}
			return;
		}
		for (const call of collected) {
			const entry = pending.get(call.id);
			if (entry) {
				pending.delete(call.id);
				entry.reject(new RpcError('TIMEOUT', `Batch timed out after 30s`));
			}
		}
	}, effectiveTimeout);

	// Send all calls as one frame
	const payload = { batch: collected };
	if (options?.sequential) payload.sequential = true;
	conn.sendQueued(payload);

	// Return promise that resolves when all individual promises resolve
	return Promise.all(promises).finally(() => clearTimeout(batchTimer));
}

/**
 * Dev-mode check for non-serializable arguments.
 * @param {string} path
 * @param {any[]} args
 */
function _checkArgs(path, args) {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const t = typeof arg;
		if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') {
			console.warn(
				`[svelte-realtime] RPC '${path}' called with non-JSON-serializable argument at index ${i} (${t}) - this will be lost during transmission\n  See: https://svti.me/rpc`
			);
		}
	}
}

/**
 * @typedef {{ path: string, args: any[], queuedAt: number, resolve: Function, reject: Function, idempotencyKey?: string, timeout?: number }} OfflineEntry
 */

/** @type {{ url?: string, auth?: boolean | string, onConnect?: () => void, onDisconnect?: () => void, timeout?: number, resumeGraceMs?: number, volatileBackpressureBytes?: number, upload?: { frameSize?: number, chunkSize?: number, highWaterMark?: number, lowWaterMark?: number }, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void } }} */
let _clientConfig = {};

/** @type {boolean} */
let _configListenerAttached = false;

/** @type {OfflineEntry[]} */
const _offlineQueue = [];

/** @type {boolean} */
let _isOffline = false;

/** @type {boolean} */
let _replayingQueue = false;

/**
 * Configure client-side connection hooks, RPC timeout, stream resume
 * grace window, and offline queue.
 *
 * `resumeGraceMs` (default 60000) controls how long a stream retains its
 * data model after the last subscriber unsubs. A new subscribe within the
 * window resumes from the retained seq/version/cursor so the server can
 * gap-fill instead of cold-rehydrating. Set to 0 to disable.
 *
 * `volatileBackpressureBytes` (default 4 MB) is the `WS.bufferedAmount`
 * threshold at which `.fireAndForget()` sends are dropped silently and
 * `__devtools.volatileDropped` increments. Sized for 120Hz cursor + drag
 * traffic; raise it if your app legitimately bursts above 4 MB of in-flight
 * volatile traffic, lower it on mobile-constrained targets where the OS
 * send buffer is tighter.
 *
 * @param {{ url?: string, auth?: boolean | string, onConnect?: () => void, onDisconnect?: () => void, timeout?: number, resumeGraceMs?: number, volatileBackpressureBytes?: number, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void } }} config
 */
export function configure(config) {
	_clientConfig = config;

	if (config.url !== undefined || config.auth !== undefined) {
		/** @type {{ url?: string, auth?: boolean | string }} */
		const connectArgs = {};
		if (config.url !== undefined) connectArgs.url = config.url;
		if (config.auth !== undefined) connectArgs.auth = config.auth;
		_connect(connectArgs);
	}

	if (!_configListenerAttached) {
		_configListenerAttached = true;
		let isFirst = true;
		status.subscribe((s) => {
			if (isFirst) { isFirst = false; return; }
			if (s === 'open') {
				_isOffline = false;
				if (_clientConfig.onConnect) _clientConfig.onConnect();
				_drainOfflineQueue();
			}
			if (s === 'disconnected' || s === 'failed') {
				_isOffline = true;
				if (_clientConfig.onDisconnect) _clientConfig.onDisconnect();
			}
		});
	}
}

/**
 * Drain the offline queue on reconnection.
 */
async function _drainOfflineQueue() {
	if (_offlineQueue.length === 0 || _replayingQueue) return;
	_replayingQueue = true;

	const offlineOpts = _clientConfig.offline;
	const beforeReplay = offlineOpts?.beforeReplay;
	const onReplayError = offlineOpts?.onReplayError;
	const maxAge = offlineOpts?.maxAge || 0;
	const now = Date.now();

	// Filter the queue
	/** @type {OfflineEntry[]} */
	let queue = [];
	for (const entry of _offlineQueue) {
		if (maxAge > 0 && now - entry.queuedAt > maxAge) {
			entry.reject(new RpcError('STALE', 'Offline mutation expired'));
			continue;
		}
		if (beforeReplay) {
			const keep = beforeReplay({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt });
			if (!keep) {
				entry.reject(new RpcError('STALE', 'Offline mutation dropped by beforeReplay filter'));
				continue;
			}
		}
		queue.push(entry);
	}
	_offlineQueue.length = 0;

	// Apply custom filter function
	if (typeof offlineOpts?.replay === 'function') {
		queue = offlineOpts.replay(queue);
	}

	// Replay using the configured strategy
	const strategy = offlineOpts?.replay;
	if ((strategy === 'concurrent' || strategy === 'batch') && queue.length > 0) {
		// Concurrent strategy: send queued calls with concurrency limit to avoid flooding
		const concurrency = 10;
		for (let i = 0; i < queue.length; i += concurrency) {
			const chunk = queue.slice(i, i + concurrency);
			const promises = chunk.map(entry => {
				const promise = _sendRpc(entry.path, entry.args, entry.idempotencyKey, entry.timeout);
				promise.then(
					(result) => entry.resolve(result),
					(err) => {
						if (onReplayError) {
							onReplayError({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt }, err);
						}
						entry.reject(err);
					}
				);
				return promise.catch(() => {}); // swallow for Promise.all
			});
			await Promise.all(promises);
		}
	} else {
		// Sequential strategy (default)
		for (const entry of queue) {
			try {
				const result = await _sendRpc(entry.path, entry.args, entry.idempotencyKey, entry.timeout);
				entry.resolve(result);
			} catch (err) {
				if (onReplayError) {
					onReplayError({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt }, err);
				}
				entry.reject(err);
			}
		}
	}

	_replayingQueue = false;
}

/**
 * Combine multiple stores into a single derived store.
 * The combining function receives the current value of each source store
 * and returns the combined value. When any source updates, the function re-runs.
 *
 * @param {...any} args - Source stores followed by a combining function as the last argument
 * @returns {import('svelte/store').Readable<any>}
 */
export function combine(...args) {
	const fn = args.pop();
	const sources = args;

	if (typeof fn !== 'function') {
		throw new Error('combine() requires a combining function as the last argument\n  See: https://svti.me/client');
	}
	if (sources.length < 2) {
		throw new Error('combine() requires at least 2 source stores\n  See: https://svti.me/client');
	}

	const values = new Array(sources.length);
	let subCount = 0;
	/** @type {Set<(v: any) => void>} */
	const subscribers = new Set();
	/** @type {Array<() => void>} */
	let sourceUnsubs = [];
	let currentValue;

	function notify() {
		const next = fn(...values);
		if (next === currentValue) return;
		currentValue = next;
		for (const sub of subscribers) sub(currentValue);
	}

	function startSources() {
		let initializing = true;
		sourceUnsubs = sources.map((source, i) => {
			return source.subscribe((v) => {
				values[i] = v;
				if (!initializing) {
					notify();
				}
			});
		});
		initializing = false;
		// Compute once after all sources have emitted their initial values
		currentValue = fn(...values);
	}

	function stopSources() {
		for (const unsub of sourceUnsubs) unsub();
		sourceUnsubs = [];
	}

	return {
		subscribe(sub) {
			if (subCount++ === 0) {
				startSources();
			}
			subscribers.add(sub);
			sub(currentValue);

			return () => {
				subscribers.delete(sub);
				if (--subCount === 0) {
					stopSources();
				}
			};
		}
	};
}

/**
 * Register a handler for point-to-point signals.
 * Signals are sent by `ctx.signal(userId, event, data)` on the server.
 *
 * The userId must match the one used by `enableSignals()` on the server,
 * because the server publishes to `__signal:${userId}`.
 *
 * @param {string} userId - The current user's id (must match server-side enableSignals)
 * @param {(event: string, data: any) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onSignal(userId, callback) {
	// Support legacy call signature: onSignal(callback)
	if (typeof userId === 'function' && callback === undefined) {
		callback = /** @type {(event: string, data: any) => void} */ (/** @type {unknown} */ (userId));
		userId = '';
	}
	const topic = userId ? ('__signal:' + userId) : '__signal';
	const store = on(topic);
	return store.subscribe((envelope) => {
		if (!envelope) return;
		callback(envelope.event, envelope.data);
	});
}

// - onPush -------------------------------------------------------------------
//
// Multiplexes server-initiated request frames by event name. The adapter's
// onRequest takes a single (event, data) handler; we keep a Map<event, fn>
// and install one shared dispatcher on first registration so apps register
// multiple events without overwriting each other.

/** @type {Map<string, (data: any) => any | Promise<any>>} */
const _pushHandlers = new Map();
/** @type {(() => void) | null} */
let _pushDispatcherUnsub = null;

function _ensurePushDispatcher() {
	if (_pushDispatcherUnsub) return;
	_pushDispatcherUnsub = _adapterOnRequest(async (event, data) => {
		const handler = _pushHandlers.get(event);
		if (!handler) {
			throw new Error("[svelte-realtime] no push handler registered for event '" + event + "'");
		}
		return await handler(data);
	});
}

/**
 * Register a handler for a server-initiated push event. The server calls
 * `live.push({ userId }, event, data)` and awaits a reply; this handler
 * receives the data and the value it returns (sync or async) becomes the
 * reply to the server. Throwing rejects the server-side promise.
 *
 * Multiple events register independently. Calling `onPush` again with the
 * same event name replaces the previous handler. The returned function
 * unregisters the handler if it is still the active one.
 *
 * Internally backed by the adapter's `onRequest`; the realtime client
 * multiplexes by event name so apps install one handler per event without
 * overwriting each other.
 *
 * @param {string} event
 * @param {(data: any) => any | Promise<any>} handler
 * @returns {() => void} Unsubscribe function.
 *
 * @example
 * ```js
 * import { onPush } from 'svelte-realtime/client';
 *
 * onPush('confirm-delete', async ({ itemId }) => {
 *   return { confirmed: confirm('Delete item ' + itemId + '?') };
 * });
 * ```
 */
export function onPush(event, handler) {
	if (typeof event !== 'string' || event.length === 0) {
		throw new Error('[svelte-realtime] onPush: event must be a non-empty string');
	}
	if (typeof handler !== 'function') {
		throw new Error('[svelte-realtime] onPush: handler must be a function');
	}
	_pushHandlers.set(event, handler);
	_ensurePushDispatcher();
	return () => {
		if (_pushHandlers.get(event) === handler) {
			_pushHandlers.delete(event);
			if (_pushHandlers.size === 0 && _pushDispatcherUnsub) {
				_pushDispatcherUnsub();
				_pushDispatcherUnsub = null;
			}
		}
	};
}

/**
 * Reset the push handler registry. Tests only.
 * @internal
 */
export function _resetPushHandlers() {
	_pushHandlers.clear();
	if (_pushDispatcherUnsub) {
		_pushDispatcherUnsub();
		_pushDispatcherUnsub = null;
	}
}

// - DevTools instrumentation (non-production only) ---------------------------

/**
 * Default key names whose values are replaced with `'[REDACTED]'` when
 * captured into the per-stream payload preview. Case-insensitive match
 * against the ENTIRE key (substring match would over-redact). Apps can
 * override or extend via `__devtools.redactKeys = new Set([...])`
 * (normalized to lowercase by `_devtoolsStreamEvent`).
 */
const _DEFAULT_REDACT_KEYS = new Set([
	'password', 'token', 'apikey', 'api_key', 'secret', 'authorization',
	'cookie', 'sessionid', 'session_id', 'csrf', 'csrftoken', 'csrf_token'
]);

const _MAX_STREAM_EVENTS = 20;

const _DEVTOOLS_VOLATILE_MAX = 100;

/**
 * @type {{
 *   history: any[],
 *   streams: Map<string, any>,
 *   pending: Map<string, any>,
 *   volatile: any[],
 *   volatileDropped: number,
 *   redactKeys: Set<string>,
 *   paused: boolean
 * } | null}
 */
export const __devtools = (typeof import.meta !== 'undefined' && !import.meta.env?.PROD)
	? {
		history: new Array(50).fill(null),
		streams: new Map(),
		pending: new Map(),
		volatile: new Array(_DEVTOOLS_VOLATILE_MAX).fill(null),
		volatileDropped: 0,
		redactKeys: new Set(_DEFAULT_REDACT_KEYS),
		paused: false
	}
	: null;

/** Ring buffer index for the devtools volatile send track. */
let _devtoolsVolatileIdx = 0;
let _devtoolsVolatileSeq = 0;

/**
 * Record a fire-and-forget RPC send for devtools. Send-only - there is no
 * matching completion event because the wire shape carries no `id` and the
 * server never replies. Ring buffer is bounded (`_DEVTOOLS_VOLATILE_MAX`,
 * drop-oldest) so a high-frequency 60-120Hz mover can't anchor unbounded
 * dev-mode memory.
 * @param {string} path
 * @param {any[]} args
 */
function _devtoolsVolatileSent(path, args) {
	if (!__devtools) return;
	__devtools.volatile[_devtoolsVolatileIdx] = {
		path,
		args,
		time: Date.now(),
		seq: ++_devtoolsVolatileSeq
	};
	_devtoolsVolatileIdx = (_devtoolsVolatileIdx + 1) % _DEVTOOLS_VOLATILE_MAX;
}

/**
 * Walk a value, replacing matched keys with `'[REDACTED]'`. Caps recursion
 * depth at 5 and array length at 50 so dev-only capture doesn't pin large
 * payload graphs in memory. Tracks visited objects to handle cycles.
 * @param {any} value
 * @param {Set<string>} redactKeys
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {any}
 */
function _devtoolsRedact(value, redactKeys, depth, seen) {
	if (depth > 5) return '[depth-cap]';
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[cycle]';
	seen.add(value);
	if (Array.isArray(value)) {
		const out = value.slice(0, 50).map((v) => _devtoolsRedact(v, redactKeys, depth + 1, seen));
		if (value.length > 50) out.push('[+' + (value.length - 50) + ' more]');
		return out;
	}
	const out = /** @type {Record<string, any>} */ ({});
	for (const k of Object.keys(value)) {
		if (redactKeys.has(k.toLowerCase())) {
			out[k] = '[REDACTED]';
		} else {
			out[k] = _devtoolsRedact(value[k], redactKeys, depth + 1, seen);
		}
	}
	return out;
}

/** Ring buffer index for devtools history (O(1) insertion, no array.shift) */
let _devtoolsHistoryIdx = 0;
let _devtoolsSeq = 0;
const _DEVTOOLS_HISTORY_MAX = 50;

/**
 * Record an RPC call start for devtools.
 * @param {string} path
 * @param {string} id
 * @param {any[]} args
 */
function _devtoolsStart(path, id, args) {
	if (!__devtools) return;
	__devtools.pending.set(id, { path, args, startTime: Date.now() });
}

/**
 * Record an RPC call completion for devtools.
 * @param {string} id
 * @param {boolean} ok
 * @param {any} result
 */
function _devtoolsEnd(id, ok, result) {
	if (!__devtools) return;
	const entry = __devtools.pending.get(id);
	if (!entry) return;
	__devtools.pending.delete(id);
	const record = {
		path: entry.path,
		args: entry.args,
		ok,
		result,
		duration: Date.now() - entry.startTime,
		time: Date.now(),
		seq: ++_devtoolsSeq
	};
	__devtools.history[_devtoolsHistoryIdx] = record;
	_devtoolsHistoryIdx = (_devtoolsHistoryIdx + 1) % _DEVTOOLS_HISTORY_MAX;
}

/**
 * Track an active stream for devtools.
 * @param {string} path
 * @param {string | null} topic
 * @param {number} subCount
 * @param {string} [merge] - merge strategy ('crud' | 'latest' | 'set' | 'presence' | 'cursor')
 */
function _devtoolsStream(path, topic, subCount, merge) {
	if (!__devtools) return;
	if (subCount <= 0) {
		__devtools.streams.delete(path);
	} else {
		const existing = __devtools.streams.get(path);
		__devtools.streams.set(path, {
			path,
			topic,
			subCount,
			merge: merge || existing?.merge || null,
			lastEventTime: existing?.lastEventTime || null,
			lastEvent: existing?.lastEvent || null,
			error: existing?.error || null,
			recentEvents: existing?.recentEvents || []
		});
	}
}

/**
 * Record a pub/sub event arrival for devtools, including a redacted +
 * depth/array-capped snapshot of the payload pushed to a per-stream
 * ring buffer (capped at `_MAX_STREAM_EVENTS`). Skips capture entirely
 * when `__devtools.paused` is true.
 * @param {string} path
 * @param {string} eventType
 * @param {any} [data]
 */
function _devtoolsStreamEvent(path, eventType, data) {
	if (!__devtools) return;
	const e = __devtools.streams.get(path);
	if (!e) return;
	e.lastEventTime = Date.now();
	e.lastEvent = eventType;
	if (__devtools.paused) return;
	const redacted = data === undefined
		? undefined
		: _devtoolsRedact(data, __devtools.redactKeys, 0, new WeakSet());
	e.recentEvents.push({ event: eventType, data: redacted, ts: e.lastEventTime });
	if (e.recentEvents.length > _MAX_STREAM_EVENTS) {
		e.recentEvents.splice(0, e.recentEvents.length - _MAX_STREAM_EVENTS);
	}
}

/**
 * Record (or clear) an error state on a stream for devtools.
 * @param {string} path
 * @param {{ code?: string, message?: string } | null} err
 */
function _devtoolsStreamError(path, err) {
	if (!__devtools) return;
	const e = __devtools.streams.get(path);
	if (!e) return;
	e.error = err ? { code: err.code || 'UNKNOWN', message: err.message || String(err) } : null;
}

/**
 * Re-export `onDerived` from the adapter client.
 * Provides a reactive derived topic subscription that auto-switches when a
 * source store changes. More lightweight than dynamic streams for cases where
 * you just want raw topic events keyed to a store value.
 */
export { onDerived } from 'svelte-adapter-uws/client';

/**
 * Re-export `failure` from the adapter client.
 * Reactive store carrying the cause of the most recent non-open status
 * transition: `{ kind: 'ws-close', class: 'TERMINAL' | 'EXHAUSTED' |
 * 'THROTTLE' | 'RETRY', code, reason }` for WebSocket closes, or
 * `{ kind: 'auth-preflight', class: 'AUTH', status, reason }` for
 * auth-preflight failures. `null` while connected. Cleared on the next
 * successful `'open'`. Not set on intentional `close()`.
 */
export { failure } from 'svelte-adapter-uws/client';
