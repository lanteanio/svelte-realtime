// @ts-check
import { connect as _connect } from 'svelte-adapter-uws/client';
import { now, microtask, setTimer, clearTimer } from '../client-runtime.js';
import { __devtools, _devtoolsStart, _devtoolsEnd, _devtoolsVolatileSent } from './devtools-instrument.js';
import { ensureListener, ensureDisconnectListener, _getTimeout } from './connection.js';
import { clientState, RpcError, pending, _nextId, _dedupMap, _dedupCoalesceWarned, _isDev, _IS_DEV, _textEncoder, _getBinaryFrame, _offlineQueue, _publishRateHintWarned, _publishRateWindows, _PUBLISH_RATE_HINT_THRESHOLD, _PUBLISH_RATE_HINT_WINDOW_MS, _PUBLISH_RATE_HINT_DEDUP_MAX } from './internal-state.js';
import { _enqueuePersist, _settlePersist } from './offline.js';

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
 * Count one inbound frame for a topic and, if its measured rate crosses the
 * high-frequency threshold, emit a one-shot dev hint. Counterpart to the
 * server-side sampler: same threshold (200), same `coalesceBy` / `volatile`
 * suggestions, same `svti.me/highfreq` link. The server reads rates the
 * adapter pre-computes; the client has none, so it counts frames over a fixed
 * window and derives the rate locally.
 *
 * Suppressed when the stream was declared with `coalesceBy` - that is the user
 * already choosing the latest-value-wins mitigation, so the hint would be
 * noise. (There is no client-side `volatile` declaration to read; `volatile`
 * is a per-call RPC concern, not a stream option, so only `coalesceBy`
 * suppresses here.) Opt out entirely with `configure({ publishRateHint: false })`.
 *
 * The whole function is dead code in production: the only caller is gated by
 * the `import.meta.env`-folded `_IS_DEV` const, and this body re-checks it so a
 * direct call from a test still no-ops under a production build.
 *
 * @param {string} topic - the stream path (the identity available at dispatch)
 * @param {any} options - the per-stream options object (read for `coalesceBy`)
 */
export function _maybeHintPublishRate(topic, options) {
	if (!_IS_DEV) return;
	if (clientState.config.publishRateHint === false) return;
	if (_publishRateHintWarned.has(topic)) return;
	// A declared-coalesced stream already picked latest-value-wins, so the hint
	// would be noise: skip the counting work entirely, mirroring the server which
	// marks such topics handled up front.
	if (options && options.coalesceBy) return;

	const nowMs = now();
	let win = _publishRateWindows.get(topic);
	if (win === undefined) {
		_publishRateWindows.set(topic, { start: nowMs, count: 1 });
		return;
	}
	win.count++;
	const elapsed = nowMs - win.start;
	if (elapsed < _PUBLISH_RATE_HINT_WINDOW_MS) return;

	// Window closed: derive events/sec and reset for the next window. A short
	// final window (e.g. the stream unsubscribed mid-window) still scales to a
	// per-second rate, so a genuine burst is not under-counted.
	const rate = (win.count * 1000) / elapsed;
	win.start = nowMs;
	win.count = 0;

	if (rate < _PUBLISH_RATE_HINT_THRESHOLD) return;

	if (_publishRateHintWarned.size >= _PUBLISH_RATE_HINT_DEDUP_MAX) {
		const oldest = _publishRateHintWarned.values().next().value;
		if (oldest !== undefined) _publishRateHintWarned.delete(oldest);
	}
	_publishRateHintWarned.add(topic);
	// The window counter is never re-read once a topic has warned (the warned
	// set short-circuits at the top), so drop it to keep the window map bounded
	// by live unwarned topics, mirroring the server sampler's symmetry.
	_publishRateWindows.delete(topic);
	console.warn(
		`[svelte-realtime] Topic '${topic}' is receiving ` +
		`${Math.round(rate)} events/sec.\n` +
		`  For high-frequency streams, consider one of:\n` +
		`    live.stream(topic, loader, { coalesceBy: (data) => data.userId })  // latest-value-wins, queued per subscriber\n` +
		`    live.stream(topic, loader, { volatile: true })                     // drop on backpressure, best-effort\n` +
		`  See: https://svti.me/highfreq`
	);
}

/**
 * Reset the dev-mode client publish-rate hint state. Tests only. Clears the
 * one-shot warned set and the per-topic window counters so a previously seen
 * topic can warn again.
 * @internal
 */
export function _resetClientPublishRateWarning() {
	_publishRateHintWarned.clear();
	_publishRateWindows.clear();
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
		if (!clientState.batchCollector) {
			const dedupKey = _buildDedupKey(path, args);
			const existing = _dedupMap.get(dedupKey);
			if (existing) {
				_warnCoalesceOnce(path);
				return existing;
			}

			const promise = _sendRpc(path, args);
			_dedupMap.set(dedupKey, promise);
			microtask(() => _dedupMap.delete(dedupKey));
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
		if (clientState.terminated) return;
		// Mirror to devtools here too, not only on the backpressure branch below.
		// The panel assigns the WHOLE counter rather than incrementing, so an offline
		// drop that bumped `_volatileDropped` silently was invisible until the next
		// backpressure drop, at which point the field jumped by every offline drop
		// accumulated since. The counter covers all drop reasons; so must the mirror.
		if (clientState.isOffline) {
			_volatileDropped++;
			if (__devtools) __devtools.volatileDropped = _volatileDropped;
			return;
		}
		if (clientState.batchCollector) {
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
		const cap = clientState.config.volatileBackpressureBytes || _DEFAULT_VOLATILE_BACKPRESSURE_BYTES;
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
	 * Send a RELIABLE no-reply RPC. Returns `void` synchronously like
	 * `fireAndForget`, with the same `{rpc, args}` no-`id` wire frame - but
	 * with NO drop tiers: not dropped while offline (the frame queues and
	 * flushes FIFO on reconnect) and not dropped under WS backpressure (the
	 * socket buffer absorbs the burst). For one-way sends whose payloads are
	 * precious rather than lossy-by-contract - a CRDT document update is the
	 * canonical case: a silently dropped edit would desync the document until
	 * the next reconnect, where a buffered burst merely arrives late.
	 *
	 * Pair with `live.volatile(fn)` server-side (no response is written).
	 * Inside `batch()` the dev-mode throw matches `fireAndForget` - one-way
	 * sends bypass batching by design.
	 *
	 * @param {...any} args - Arguments forwarded to the handler
	 * @returns {void}
	 */
	rpcCall.send = function sendReliable(...args) {
		if (clientState.terminated) return;
		if (clientState.batchCollector) {
			if (_IS_DEV) {
				throw new Error(
					`[svelte-realtime] '${path}'.send() cannot be used inside batch() - one-way RPCs bypass batching.\n  See: https://svti.me/volatile`
				);
			}
			return;
		}
		ensureListener();
		ensureDisconnectListener();
		_devtoolsVolatileSent(path, args);
		_connect().sendQueued({ rpc: path, args });
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
			if (!clientState.batchCollector && idempotencyKey) {
				const dedupKey = path + '\0K' + idempotencyKey;
				const existing = _dedupMap.get(dedupKey);
				if (existing) {
					_warnCoalesceOnce(path);
					return existing;
				}
				const promise = _sendRpc(path, args, idempotencyKey, timeout);
				_dedupMap.set(dedupKey, promise);
				microtask(() => _dedupMap.delete(dedupKey));
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

let _mpStubNoteFired = false;

/**
 * Build the namespace-level field-surface fallbacks of a generated
 * `live.multiplayer()` namespace: the `typing` / `locks` / `selections` /
 * `reactions` views (empty) and the `setTyping` / `acquireLock` / `releaseLock`
 * / `setSelection` / `react` methods. The live collaborative field surface lives
 * on the room instance returned by `namespace.room(...args)`, where the views
 * are reactive projections of the presence roster and the methods publish onto
 * it. These namespace-level members are the no-room fallback: reading a view
 * yields empty state and calling a method off the room is a safe no-op that
 * emits one dev-only note (so a render loop does not spam the console) pointing
 * the caller at `room(...)`.
 *
 * Spread into the generated namespace object: the live `data` / `presence` /
 * `cursors` / `status` / `move` / `reportViewport` members and the room actions
 * are added by the codegen and override nothing here.
 *
 * @returns {Record<string, any>}
 */
export function __mpFields() {
	const note = (method) => {
		if (_mpStubNoteFired) return;
		_mpStubNoteFired = true;
		if (typeof console !== 'undefined' && console.warn) {
			console.warn(
				`[svelte-realtime] multiplayer.${method}() off the room is a no-op; call it on the room instance from namespace.room(...args) to publish.\n  See: https://svti.me/multiplayer`
			);
		}
	};
	return {
		typing: [],
		locks: {},
		selections: {},
		reactions: [],
		setTyping() { note('setTyping'); },
		acquireLock() { note('acquireLock'); },
		releaseLock() { note('releaseLock'); },
		setSelection() { note('setSelection'); },
		react() { note('react'); }
	};
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
export function _sendRpc(path, args, idempotencyKey, timeout) {
	ensureListener();
	ensureDisconnectListener();

	// Fast-fail if connection is permanently dead
	if (clientState.terminated) {
		return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
	}

	if (typeof process === 'undefined' || (typeof import.meta !== 'undefined' && import.meta.env?.DEV)) {
		_checkArgs(path, args);
	}

	// Offline queue: if disconnected and queue is enabled, defer the call
	if (clientState.isOffline && clientState.config.offline?.queue && !clientState.batchCollector) {
		const maxQueue = clientState.config.offline.maxQueue || 100;
		return new Promise((resolve, reject) => {
			if (_offlineQueue.length >= maxQueue) {
				// Drop oldest
				const dropped = _offlineQueue.shift();
				if (dropped) {
					dropped.reject(new RpcError('QUEUE_FULL', 'Offline queue overflow - oldest mutation dropped'));
					_settlePersist(dropped, false);
				}
			}
			const entry = { path, args, queuedAt: now(), resolve, reject, idempotencyKey, timeout };
			_offlineQueue.push(entry);
			// Durability write-through: stamps the monotone seq, synthesizes an
			// idempotency key when absent (replay-after-reload dedups
			// server-side), and persists when configured.
			_enqueuePersist(entry);
		});
	}

	const id = _nextId();

	// If inside a batch() call, collect instead of sending. The batch-level
	// timer governs all collected calls; per-call `timeout` is intentionally
	// dropped here (documented limitation).
	if (clientState.batchCollector) {
		clientState.batchCollector.push(idempotencyKey ? { rpc: path, id, args, idempotencyKey } : { rpc: path, id, args });
		// Batched calls used to be invisible in DevTools entirely: this branch
		// returns before the `_devtoolsStart` below, and stored the RAW resolve and
		// reject, so nothing sent inside `batch()` ever reached the pending map or
		// the history ring. Not a leak - nothing was started - but a real hole in
		// the panel, since batching is exactly where bulk app traffic lives.
		_devtoolsStart(path, id, args);
		return new Promise((resolve, reject) => {
			pending.set(id, {
				resolve(v) { _devtoolsEnd(id, true, v); resolve(v); },
				reject(e) { _devtoolsEnd(id, false, e); reject(e); },
				timer: null
			});
		});
	}

	// `_connect()` runs FIRST. It can throw - `connection.js` wraps its own call in
	// a try/catch for exactly that (not callable yet under SSR) - and registering
	// with devtools beforehand would strand a pending entry, with its captured
	// args, that nothing can ever sweep: no timer is armed until below.
	const conn = _connect();
	_devtoolsStart(path, id, args);
	const effectiveTimeout = timeout || _getTimeout();
	// Sleep-detect threshold scales with the effective timeout so longer
	// timeouts don't misfire as SLEEP_TIMEOUT. Floor at 90s preserves the
	// original heuristic for the 30s default case.
	const sleepThreshold = Math.max(effectiveTimeout * 3, 90000);

	return new Promise((resolve, reject) => {
		const _startTime = now();
		const timer = setTimer(() => {
			if (now() - _startTime > sleepThreshold) {
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
		if (clientState.terminated) {
			return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
		}
		ensureListener();
		ensureDisconnectListener();

		const id = _nextId();

		// `_connect()` first - see the note in `_sendRpc`. A throw here before the
		// devtools registration would strand an unsweepable pending entry.
		const conn = _connect();
		_devtoolsStart(path, id, args);

		return new Promise((resolve, reject) => {
			const _startTime = now();
			const timer = setTimer(() => {
				if (now() - _startTime > 90000) {
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
				clearTimer(timer);
				// `reject` here is the raw executor reject, NOT the instrumented wrapper
				// stored on the pending entry, and `pending` is the RPC map rather than
				// `__devtools.pending`. Without an explicit end the devtools ring never
				// learns this call settled and keeps the entry - with its args - for the
				// life of the page. The timeout branches above are the same shape and
				// stay correct the same way: by calling `_devtoolsEnd` explicitly, NOT
				// by going through the wrapper. Any new bail-out here owes one too.
				const err = new RpcError('PAYLOAD_TOO_LARGE', 'Binary RPC header exceeds 65535 bytes');
				_devtoolsEnd(id, false, err);
				reject(err);
				return;
			}
			// A DETACHED buffer (the payload was transferred to a worker - hash a File
			// off-thread, then upload it) throws here. Unguarded, the throw escapes the
			// executor as a bare TypeError with no `code`, breaking the binary-RPC error
			// contract, and leaves the pending entry with its timer armed: 30s later the
			// sweeper writes a FABRICATED TIMEOUT record for a call that was never sent.
			let bufBytes;
			try {
				bufBytes = ArrayBuffer.isView(buffer)
					? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
					: new Uint8Array(buffer);
			} catch {
				pending.delete(id);
				clearTimer(timer);
				const err = new RpcError('INVALID_REQUEST', 'Binary RPC payload is detached (transferred) and cannot be sent');
				_devtoolsEnd(id, false, err);
				reject(err);
				return;
			}
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

/**
 * Group multiple RPC calls into a single WebSocket frame.
 * Returns an array of results in the same order as the calls.
 *
 * @param {() => Promise<any>[]} fn - Function that returns an array of RPC call promises
 * @param {{ sequential?: boolean }} [options]
 * @returns {Promise<any[]>}
 */
export function batch(fn, options) {
	if (clientState.terminated) {
		return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
	}
	ensureListener();
	ensureDisconnectListener();

	// Collect RPC calls during fn() execution
	clientState.batchCollector = [];
	/** @type {any} */
	let promises;
	try {
		promises = fn();
	} catch (err) {
		// Clean up collector and any pending entries on synchronous throw
		const collected = clientState.batchCollector;
		clientState.batchCollector = null;
		if (collected) {
			for (const call of collected) {
				const entry = pending.get(call.id);
				if (entry) {
					pending.delete(call.id);
					if (entry.timer) clearTimer(entry.timer);
				}
			}
		}
		throw err;
	}
	const collected = clientState.batchCollector;
	clientState.batchCollector = null;

	if (collected.length === 0) return Promise.resolve([]);

	if (collected.length > 50) {
		for (const call of collected) {
			const entry = pending.get(call.id);
			if (entry) {
				pending.delete(call.id);
				if (entry.timer) clearTimer(entry.timer);
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
		const _startTime = now();
		const sleepThreshold = Math.max(effectiveTimeout * 3, 90000);
		const timer = setTimer(() => {
			const entry = pending.get(call.id);
			if (!entry) return;
			pending.delete(call.id);
			if (now() - _startTime > sleepThreshold) {
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
	const _batchStartTime = now();
	const batchTimer = setTimer(() => {
		if (now() - _batchStartTime > 90000) {
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
	return Promise.all(promises).finally(() => clearTimer(batchTimer));
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
