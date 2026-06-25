// @ts-check
import { now } from '../client-runtime.js';

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
 *   paused: boolean,
 *   smooth: Set<() => any>
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
		paused: false,
		// Live smoothed-channel telemetry accessors (the "smooth" tab). Pull-based:
		// each entry is a `() => channel.stats()` the panel calls on its refresh
		// tick, so a smooth view costs nothing until the panel is open. The smooth
		// view registers on construct and drops its accessor on destroy.
		smooth: new Set()
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
export function _devtoolsVolatileSent(path, args) {
	if (!__devtools) return;
	__devtools.volatile[_devtoolsVolatileIdx] = {
		path,
		args,
		time: now(),
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
export function _devtoolsStart(path, id, args) {
	if (!__devtools) return;
	__devtools.pending.set(id, { path, args, startTime: now() });
}

/**
 * Record an RPC call completion for devtools.
 * @param {string} id
 * @param {boolean} ok
 * @param {any} result
 */
export function _devtoolsEnd(id, ok, result) {
	if (!__devtools) return;
	const entry = __devtools.pending.get(id);
	if (!entry) return;
	__devtools.pending.delete(id);
	const record = {
		path: entry.path,
		args: entry.args,
		ok,
		result,
		duration: now() - entry.startTime,
		time: now(),
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
export function _devtoolsStream(path, topic, subCount, merge) {
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
export function _devtoolsStreamEvent(path, eventType, data) {
	if (!__devtools) return;
	const e = __devtools.streams.get(path);
	if (!e) return;
	e.lastEventTime = now();
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
export function _devtoolsStreamError(path, err) {
	if (!__devtools) return;
	const e = __devtools.streams.get(path);
	if (!e) return;
	e.error = err ? { code: err.code || 'UNKNOWN', message: err.message || String(err) } : null;
}

/**
 * Register a smoothed channel's telemetry accessor for the devtools "smooth"
 * tab. `statsFn` returns the channel's `stats()` snapshot (or `undefined` on an
 * adapter too old to expose it). Pull-based: the panel calls the accessor on its
 * refresh tick, so a registered channel costs nothing until the panel is open.
 * Returns an unregister function (a no-op in production); the smooth view pushes
 * it onto its teardown list, so the accessor is dropped on destroy.
 * @param {() => any} statsFn
 * @returns {() => void}
 */
export function _devtoolsSmoothRegister(statsFn) {
	if (!__devtools) return () => {};
	__devtools.smooth.add(statsFn);
	return () => { if (__devtools) __devtools.smooth.delete(statsFn); };
}
