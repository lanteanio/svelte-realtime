// @ts-check
import { derived } from 'svelte/store';
import { __devtools, _devtoolsConnectionStatus, _devtoolsConnectionFailure } from './devtools-instrument.js';
import { connect as _connect, status as _adapterStatus } from 'svelte-adapter-uws/client';
import { now, clearTimer } from '../client-runtime.js';
import { clientState, RpcError, pending, pendingUploads, _IS_DEV, _connectionLost } from './internal-state.js';
import { _closeOfflineQueue } from './offline.js';

/**
 * The adapter connection this client is bound to. Everything the client does
 * with the adapter goes through it: sends, topic stores, the status store,
 * the request handler. The adapter's own `connect()`, `on()` and `status`
 * build a new connection, and a new socket, whenever none exists, which is
 * the case once `close()` has run. Through the bound connection a call made
 * after a close for good only reaches the closed connection, whose stores
 * report 'failed' and whose sends go nowhere.
 * @type {any}
 */
let _bound = null;

/**
 * The bound connection, binding it (and attaching the status listener, so a
 * close for good is seen) on first use.
 * @returns {any}
 */
export function _conn() {
	if (_bound === null) ensureDisconnectListener();
	return _bound;
}

/** @type {boolean} */
let listenerAttached = false;

/**
 * Dev-warn dedup for server-signaled deprecations: at most one warning per
 * deprecated path per session. The server sends the `deprecation` signal once
 * per connection; this set also suppresses a re-warn after a reconnect.
 * @type {Set<string>}
 */
const _deprecationWarned = new Set();

/**
 * Surface a server `deprecation` signal (from a `live.deprecate`-marked handler)
 * as a single dev-mode console warning. Dead code in production (gated on the
 * `import.meta.env`-folded `_IS_DEV`).
 * @param {{ path: string, message?: string, since?: string, use?: string, removeBy?: string } | undefined} dep
 */
function _warnDeprecation(dep) {
	if (!_IS_DEV || !dep || !dep.path || _deprecationWarned.has(dep.path)) return;
	_deprecationWarned.add(dep.path);
	let msg = `'${dep.path}' is deprecated`;
	if (dep.since) msg += ` (since ${dep.since})`;
	if (dep.message) msg += `: ${dep.message}`;
	if (dep.use) msg += `\n  Use '${dep.use}' instead.`;
	if (dep.removeBy) msg += `\n  Scheduled for removal in ${dep.removeBy}.`;
	console.warn('[svelte-realtime] ' + msg);
}

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

export function _registerTopicErrorSetter(topic, setError) {
	let set = _streamErrorByTopic.get(topic);
	if (!set) { set = new Set(); _streamErrorByTopic.set(topic, set); }
	set.add(setError);
}

export function _unregisterTopicErrorSetter(topic, setError) {
	const set = _streamErrorByTopic.get(topic);
	if (!set) return;
	set.delete(setError);
	if (set.size === 0) _streamErrorByTopic.delete(topic);
}

/**
 * Attach the subscribe-denial listener once. Routes each adapter denial
 * (`{topic, reason, ref}`) to the per-topic error setters registered by
 * stream stores, so apps see a typed `error.code` (the denial reason)
 * instead of the generic `INTERNAL_ERROR` the framework's earlier error
 * mapping produced.
 */
export function ensureDenialsListener() {
	if (denialsListenerAttached) return;
	const denials = _conn().denials;
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

const _DEFAULT_TIMEOUT = 30000;

/** @returns {number} Configured or default RPC timeout in ms */
export function _getTimeout() {
	return clientState.config.timeout || _DEFAULT_TIMEOUT;
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
export function _getResumeGraceMs() {
	const v = clientState.config.resumeGraceMs;
	if (typeof v === 'number' && v >= 0) return v;
	return _DEFAULT_RESUME_GRACE_MS;
}

const _DEFAULT_RESUME_MAX_CURSOR_AGE_MS = 60000;

/**
 * Maximum connection-downtime in ms for which a live stream still trusts its
 * retained replay cursor on reconnect. A socket that bounces briefly resumes
 * from the retained seq/version so the server gap-fills from its replay
 * buffer; but after a long outage (a backgrounded tab, a device sleep, a
 * tunnel drop) the cursor can be stale in a way seq alone does not reveal -
 * the server may have pruned data by TIME while the seq is still within the
 * ring - so a gap-fill would silently miss it. Beyond this bound the stream
 * drops its cursor and takes a full rehydrate instead. Set to 0 to always
 * rehydrate on reconnect; a very large value restores the old trust-the-seq
 * behavior. Independent of `resumeGraceMs` (which bounds the unsubscribe
 * retention window, a different axis).
 *
 * @returns {number}
 */
export function _getResumeMaxCursorAgeMs() {
	const v = clientState.config.resumeMaxCursorAgeMs;
	if (typeof v === 'number' && v >= 0) return v;
	return _DEFAULT_RESUME_MAX_CURSOR_AGE_MS;
}

/**
 * Attach the __rpc topic listener once.
 * Listens for RPC responses and resolves/rejects the matching pending promise.
 */
export function ensureListener() {
	if (listenerAttached) return;
	const store = _conn().on('__rpc');
	listenerAttached = true;
	store.subscribe((envelope) => {
		if (!envelope) return;
		const { event: correlationId, data } = envelope;

		// Batch response
		if (correlationId === '__batch' && data?.batch) {
			for (const result of data.batch) {
				const entry = pending.get(result.id);
				if (!entry) continue;
				pending.delete(result.id);
				if (entry.timer) clearTimer(entry.timer);
				if (result.ok) {
					entry.resolve(entry.stream ? result : result.data);
					_warnDeprecation(result.deprecation);
				} else {
					entry.reject(new RpcError(result.code || 'UNKNOWN', result.error || 'Unknown error'));
				}
			}
			return;
		}

		// Single response
		const entry = pending.get(correlationId);
		if (!entry) return;
		// Early attach for a stream subscribe: the server names the wire topic
		// before it subscribes the socket, so the stream can install its
		// listener ahead of the first live frame. The subscribe itself is still
		// pending (its response follows, possibly inside a batch), so the entry
		// and its timer stay.
		if (data && data.attach === true) {
			if (entry.stream && typeof entry.attach === 'function') entry.attach(data.topic);
			return;
		}
		pending.delete(correlationId);
		if (entry.timer) clearTimer(entry.timer);

		if (data && data.ok) {
			entry.resolve(entry.stream ? data : data.data);
			_warnDeprecation(data.deprecation);
		} else if (data) {
			const err = new RpcError(data.code || 'UNKNOWN', data.error || 'Unknown error');
			if (data.issues) /** @type {any} */ (err).issues = data.issues;
			entry.reject(err);
		}
	});
}

/**
 * Attach the connection status listener once, binding the connection if
 * nothing has yet. It is the first realtime listener on the status store, so
 * it sees 'failed' before the others.
 *
 * - 'disconnected' rejects pending requests with DISCONNECTED, except unsent
 *   RPCs parked in their own pending entries: those keep waiting within their
 *   existing timeout. Uploads are drained. The adapter reconnects unless the
 *   drop used up the last attempt, in which case 'failed' follows at once.
 * - 'failed' means closed for good (an explicit close, a terminal close code,
 *   an auth preflight failure or exhausted retries; the adapter reports
 *   nothing else for that connection afterwards). The client is `terminated`
 *   from then on and settles what it still holds with CONNECTION_CLOSED.
 * - 'connecting' while a socket was up means the adapter replaced it with no
 *   'disconnected' in between. Every sent non-stream request is rejected with
 *   DISCONNECTED; stream subscribes and parked, unsent RPCs keep waiting.
 *
 * RPC frames never enter the adapter's send queue. A non-queuing send that
 * returns false while status still says open drops the frame; its request
 * waits for disconnection or its existing timeout to reject it.
 *
 * `clientState.socketUp` follows whether a socket is up ('open' or
 * 'suspended'); the offline drain starts only while one is.
 *
 * Also detects the Cloudflare-Tunnel "Set-Cookie on 101" symptom: repeated
 * fast open->close cycles with no time spent in the open state.
 */
export function ensureDisconnectListener() {
	if (disconnectListenerAttached) return;
	// Bind the connection. If none exists yet it is created the way the
	// adapter's own stores create one, implicitly, so the adapter still warns
	// when options passed to a later connect() cannot apply; connect() without
	// options then returns it. Marked attached only once bound, so a throw here
	// is retried by the next call.
	_adapterStatus.subscribe(() => {})();
	_bound = _connect();
	disconnectListenerAttached = true;
	if (__devtools) _bound.failure?.subscribe(_devtoolsConnectionFailure);

	let lastOpenAt = 0;
	let fastCloseCount = 0;
	let cfTunnelWarned = false;

	_bound.status.subscribe((s) => {
		if (__devtools) _devtoolsConnectionStatus(s);
		if (s === 'failed') {
			// Before anything that can run app code: a call it makes must see it.
			clientState.terminated = true;
			_settleClosedForGood();
		} else if (s === 'disconnected') {
			clientState.socketUp = false;
			for (const [id, entry] of pending) {
				// Calls made before an open still own their frames and may wait
				// through failed connection attempts, bounded by their timeout.
				if (entry.rpcWaiting) continue;
				pending.delete(id);
				if (entry.timer) clearTimer(entry.timer);
				entry.reject(_connectionLost('DISCONNECTED', 'WebSocket connection lost'));
			}
			_drainPendingUploadsOnDisconnect();
		}
		if (s === 'disconnected' || s === 'failed') {

			if (lastOpenAt > 0) {
				const openDuration = now() - lastOpenAt;
				lastOpenAt = 0;
				if (openDuration < 1000) {
					fastCloseCount++;
					if (fastCloseCount >= 2 && !cfTunnelWarned && !clientState.config.auth) {
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
		if (s === 'open') lastOpenAt = now();
		// A backgrounded tab's socket ('suspended') is still up and carries frames.
		const up = s === 'open' || s === 'suspended';
		if (up && !clientState.socketUp) {
			clientState.socketUp = true;
			// Advertise before waking request-owned frames or any later status
			// subscribers can send application work through strict admission.
			if (clientState.config.protocolVersion !== undefined) {
				try { _bound.send({ type: 'proto', v: clientState.config.protocolVersion }); } catch { /* transport can close during the transition */ }
			}
			// Entries parked while the socket was down (a stream subscribe whose
			// stream moved on, its request possibly still in the adapter's send
			// queue) start waiting for their answer now.
			for (const entry of pending.values()) {
				if (typeof entry.wake === 'function') entry.wake();
			}
		} else if (!up) {
			if (clientState.socketUp && s === 'connecting') {
				// The adapter replaced a socket it was closing, with no
				// 'disconnected' in between. Calls already sent on that socket
				// cannot receive an answer; unsent calls still own their frames.
				for (const [id, entry] of pending) {
					if (entry.stream || entry.rpcWaiting) continue;
					pending.delete(id);
					if (entry.timer) clearTimer(entry.timer);
					entry.reject(_connectionLost('DISCONNECTED', 'WebSocket connection replaced'));
				}
			}
			clientState.socketUp = false;
		}
	});
}

/**
 * Whether the bound connection has closed for good, reading its status store
 * now. Unlike `clientState.terminated` this already holds while the store is
 * still to deliver 'failed' (a close() made inside another store's update
 * defers that delivery). For cold paths only.
 * @returns {boolean}
 */
export function _closedForGoodNow() {
	if (clientState.terminated) return true;
	if (_bound === null) return false;
	let s;
	_bound.status.subscribe((/** @type {string} */ v) => { s = v; })();
	return s === 'failed';
}

/** @returns {RpcError} */
export function _connectionClosedError() {
	return _connectionLost('CONNECTION_CLOSED', 'Connection permanently closed');
}

/**
 * The connection closed for good: settle every request and upload with
 * CONNECTION_CLOSED, and the offline queue as `_closeOfflineQueue` says. A
 * stream subscribe rejected here releases what it held without sending, so
 * nothing is left waiting for an answer that cannot come.
 */
function _settleClosedForGood() {
	for (const [id, entry] of pending) {
		pending.delete(id);
		if (entry.timer) clearTimer(entry.timer);
		entry.reject(_connectionClosedError());
	}
	if (pendingUploads.size > 0) {
		for (const handle of [...pendingUploads.values()]) handle._settle(false, _connectionClosedError());
	}
	_closeOfflineQueue(_connectionClosedError);
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
 * The status store of the bound connection. Subscribing binds first, so the
 * client's own status listener runs before any subscriber made here (a call
 * made on 'failed' already fails fast), and subscribing after a close for good
 * reports 'failed' instead of building a new connection.
 * @type {import('svelte/store').Readable<'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed'>}
 */
export const status = {
	subscribe(fn) {
		return _conn().status.subscribe(fn);
	}
};

/**
 * The failure store of the bound connection (see `status`).
 * @type {import('svelte/store').Readable<any>}
 */
export const failure = {
	subscribe(fn) {
		return _conn().failure.subscribe(fn);
	}
};

/**
 * The adapter's `onDerived`, with its topic stores on the bound connection
 * (see `status`).
 * @template T
 * @param {(value: T) => string} topicFn
 * @param {import('svelte/store').Readable<T>} store
 * @returns {import('svelte/store').Readable<any>}
 */
export function onDerived(topicFn, store) {
	return derived(store, ($value, set) => {
		if ($value == null) {
			set(null);
			return;
		}
		return _conn().on(topicFn($value)).subscribe(set);
	}, null);
}
