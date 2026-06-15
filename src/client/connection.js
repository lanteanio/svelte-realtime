// @ts-check
import { connect as _connect, on, status, denials } from 'svelte-adapter-uws/client';
import { now, clearTimer } from '../client-runtime.js';
import { clientState, RpcError, pending, pendingUploads, _offlineQueue } from './internal-state.js';

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
 * instead of the generic `INTERNAL_ERROR` the framework's pre-A6 error
 * mapping produced.
 */
export function ensureDenialsListener() {
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

/**
 * Attach the __rpc topic listener once.
 * Listens for RPC responses and resolves/rejects the matching pending promise.
 */
export function ensureListener() {
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
				if (entry.timer) clearTimer(entry.timer);
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
		if (entry.timer) clearTimer(entry.timer);

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
export function ensureDisconnectListener() {
	if (disconnectListenerAttached) return;
	disconnectListenerAttached = true;

	let lastOpenAt = 0;
	let fastCloseCount = 0;
	let cfTunnelWarned = false;

	status.subscribe((s) => {
		if (s === 'disconnected' || s === 'failed') {
			for (const [id, entry] of pending) {
				pending.delete(id);
				if (entry.timer) clearTimer(entry.timer);
				entry.reject(new RpcError('DISCONNECTED', 'WebSocket connection lost'));
			}
			_drainPendingUploadsOnDisconnect();

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
		if (s === 'open') {
			clientState.terminated = false;
			lastOpenAt = now();
		}
	});

	// Listen for terminal close via ready() rejection (adapter 0.4.0)
	if (typeof _connect === 'function') {
		try {
			const conn = _connect();
			if (conn && typeof conn.ready === 'function') {
				conn.ready().catch((/** @type {any} */ err) => {
					clientState.terminated = true;
					const errCode = err?.code || 'CONNECTION_CLOSED';
					const errMsg = err?.message || 'Connection permanently closed';
					// Reject all pending RPCs
					for (const [id, entry] of pending) {
						pending.delete(id);
						if (entry.timer) clearTimer(entry.timer);
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
 * Drain in-flight uploads on disconnect. Called from `ensureDisconnectListener`.
 */
function _drainPendingUploadsOnDisconnect() {
	if (pendingUploads.size === 0) return;
	const snapshot = [...pendingUploads.values()];
	for (const handle of snapshot) handle._onDisconnect();
}
