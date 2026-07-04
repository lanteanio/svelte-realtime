// @ts-check
import { connect as _connect, on, status, onRequest as _adapterOnRequest } from 'svelte-adapter-uws/client';
import { now } from '../client-runtime.js';
import { clientState, RpcError, _offlineQueue } from './internal-state.js';
import { _sendRpc } from './rpc.js';
import { _ensureHealthSubscription } from './health.js';

/**
 * @typedef {{ path: string, args: any[], queuedAt: number, resolve: Function, reject: Function, idempotencyKey?: string, timeout?: number }} OfflineEntry
 */

/** @type {boolean} */
let _configListenerAttached = false;

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
 * `resumeMaxCursorAgeMs` (default 60000) bounds how long a still-subscribed
 * stream trusts its retained replay cursor across a reconnect. A brief socket
 * bounce resumes from the retained seq (the server gap-fills); after an outage
 * longer than this - a backgrounded tab, a device sleep, a tunnel drop - the
 * stream drops the cursor and takes a full rehydrate, since the server may
 * have pruned data by time in a way the seq alone does not reveal. Set to 0 to
 * always rehydrate on reconnect. Independent of `resumeGraceMs`.
 *
 * `volatileBackpressureBytes` (default 4 MB) is the `WS.bufferedAmount`
 * threshold at which `.fireAndForget()` sends are dropped silently and
 * `__devtools.volatileDropped` increments. Sized for 120Hz cursor + drag
 * traffic; raise it if your app legitimately bursts above 4 MB of in-flight
 * volatile traffic, lower it on mobile-constrained targets where the OS
 * send buffer is tighter.
 *
 * `publishRateHint` (default enabled in dev) controls the one-shot console
 * hint logged when an inbound stream's frame rate crosses the high-frequency
 * threshold. Set `false` to silence it. Production builds strip the hint
 * regardless, so this only matters in development.
 *
 * `protocolVersion` is an opt-in integer the app bumps only on a BREAKING
 * wire/contract change, declared identically here and in `realtime({ protocolVersion })`
 * on the server (one shared constant). The client advertises it once on connect; a
 * server running a higher version replies with a one-shot `protocol-stale` notice,
 * which surfaces the `health` store as `'outdated'` and logs a dev console warning so
 * a long-lived client running a stale bundle after a breaking deploy knows to reload.
 * Omit it to leave the signal off.
 *
 * @param {{ url?: string, auth?: boolean | string, onConnect?: () => void, onDisconnect?: () => void, timeout?: number, resumeGraceMs?: number, resumeMaxCursorAgeMs?: number, volatileBackpressureBytes?: number, publishRateHint?: boolean, protocolVersion?: number, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void } }} config
 */
export function configure(config) {
	clientState.config = config;

	// Mirror the server's realtime({ protocolVersion }) integer validation so the
	// shared-constant contract is symmetric and a typo (null / float) cannot quietly
	// advertise a bad version that latches the client to a permanent 'outdated'.
	if (config.protocolVersion !== undefined && !Number.isInteger(config.protocolVersion)) {
		throw new Error('[svelte-realtime] configure({ protocolVersion }): must be an integer');
	}

	if (config.url !== undefined || config.auth !== undefined) {
		/** @type {{ url?: string, auth?: boolean | string }} */
		const connectArgs = {};
		if (config.url !== undefined) connectArgs.url = config.url;
		if (config.auth !== undefined) connectArgs.auth = config.auth;
		_connect(connectArgs);
	}

	// Protocol-compat signal opt-in: ensure the __realtime listener is active so a
	// server `protocol-stale` notice is observed (health -> 'outdated' + dev warn)
	// even if the app never reads the `health` store directly. Idempotent. MUST run
	// AFTER the url/auth `_connect(connectArgs)` above: _ensureHealthSubscription
	// calls `_connect()` with no args, and the FIRST _connect call fixes the
	// endpoint - so creating the listener's connection before the configured one
	// would pin the default same-origin URL and make the adapter ignore url/auth.
	if (config.protocolVersion !== undefined) _ensureHealthSubscription();

	if (!_configListenerAttached) {
		_configListenerAttached = true;
		let isFirst = true;
		status.subscribe((s) => {
			if (isFirst) { isFirst = false; return; }
			if (s === 'open') {
				clientState.isOffline = false;
				// Advertise the baked protocol version once per (re)connect, before any
				// queued RPC, so the server can compare and signal staleness early.
				if (clientState.config.protocolVersion !== undefined) {
					try { _connect().sendQueued({ type: 'proto', v: clientState.config.protocolVersion }); } catch { /* no connection handle yet */ }
				}
				if (clientState.config.onConnect) clientState.config.onConnect();
				_drainOfflineQueue();
			}
			if (s === 'disconnected' || s === 'failed') {
				clientState.isOffline = true;
				if (clientState.config.onDisconnect) clientState.config.onDisconnect();
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

	const offlineOpts = clientState.config.offline;
	const beforeReplay = offlineOpts?.beforeReplay;
	const onReplayError = offlineOpts?.onReplayError;
	const maxAge = offlineOpts?.maxAge || 0;
	const nowMs = now();

	// Filter the queue
	/** @type {OfflineEntry[]} */
	let queue = [];
	for (const entry of _offlineQueue) {
		if (maxAge > 0 && nowMs - entry.queuedAt > maxAge) {
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
