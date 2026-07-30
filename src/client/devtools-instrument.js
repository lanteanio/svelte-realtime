// @ts-check
import { now } from '../client-runtime.js';

// - DevTools instrumentation (non-production only) ---------------------------

/**
 * Default key names whose values are replaced with `'[REDACTED]'` when
 * captured into the per-stream payload preview. Case-insensitive match
 * against the ENTIRE key (substring match would over-redact). Apps can
 * override or extend via `__devtools.redactKeys = new Set([...])`; entries are
 * normalized to lowercase at the top of each redaction walk, so a mixed-case
 * entry like `'paymentMethod'` matches. (This used to claim normalization
 * happened in `_devtoolsStreamEvent`, which never did any - so only the payload
 * key was lowercased and a mixed-case entry silently never matched.)
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
 * dev-mode memory. Args are redacted before storage, exactly as stream-event
 * payloads are, so a `login({ password })` send never lands in the ring in
 * plaintext.
 * @param {string} path
 * @param {any[]} args
 */
export function _devtoolsVolatileSent(path, args) {
	if (!__devtools) return;
	__devtools.volatile[_devtoolsVolatileIdx] = {
		path,
		args: _devtoolsRedact(args, __devtools.redactKeys, 0, new WeakSet()),
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
function _devtoolsRedact(value, redactKeys, depth, seen, dropStack) {
	// Normalize the KEY SET to lowercase once, at the top of each walk. Only the
	// payload key was being lowercased, so the match was case-insensitive on one
	// side only: the documented extension `__devtools.redactKeys.add('paymentMethod')`
	// never fired, because the lookup asked for 'paymentmethod'. The defaults all
	// happen to be lowercase, which is why this held together. Rebuilt per capture
	// rather than cached, because the set is app-mutable at any time and is small.
	if (depth === 0) {
		let allLower = true;
		for (const k of redactKeys) { if (typeof k !== 'string' || k !== k.toLowerCase()) { allLower = false; break; } }
		if (!allLower) {
			const lowered = new Set();
			for (const k of redactKeys) lowered.add(String(k).toLowerCase());
			redactKeys = lowered;
		}
	}
	if (depth > 5) return '[depth-cap]';
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[cycle]';
	seen.add(value);
	if (Array.isArray(value)) {
		const out = value.slice(0, 50).map((v) => _devtoolsRedact(v, redactKeys, depth + 1, seen, dropStack));
		if (value.length > 50) out.push('[+' + (value.length - 50) + ' more]');
		return out;
	}
	const out = /** @type {Record<string, any>} */ ({});
	for (const k of Object.keys(value)) {
		// Within an ERROR result, drop `stack` at EVERY depth, not just the top.
		// An error chain (`err.cause.stack`) or a back-reference (`err.self === err`)
		// otherwise walks straight past a top-level-only drop and puts the trace in
		// the ring anyway. Confined to error results so an ordinary RPC returning a
		// field called `stack` is left alone.
		if (dropStack && k === 'stack') continue;
		if (redactKeys.has(k.toLowerCase())) {
			out[k] = '[REDACTED]';
		} else {
			// Guarded: ANY own key may be a throwing accessor (a cross-realm error, a
			// source-map hook, a locked-down realm). This walk runs inside the settle
			// path, BEFORE the RPC's own `reject`, so an escaping throw would leave
			// the caller's promise permanently unsettled - a hang, not a lost log line.
			let v;
			try { v = value[k]; } catch { out[k] = '[unreadable]'; continue; }
			out[k] = _devtoolsRedact(v, redactKeys, depth + 1, seen, dropStack);
		}
	}
	return out;
}

/** Ring buffer index for devtools history (O(1) insertion, no array.shift) */
let _devtoolsHistoryIdx = 0;
let _devtoolsSeq = 0;
const _DEVTOOLS_HISTORY_MAX = 50;

/**
 * Record an RPC call start for devtools. Args are redacted before storage
 * (the same redactor the stream-event path applies), so credential-carrying
 * calls like `login({ password })` never sit in the pending map in plaintext.
 * @param {string} path
 * @param {string} id
 * @param {any[]} args
 */
export function _devtoolsStart(path, id, args) {
	if (!__devtools) return;
	__devtools.pending.set(id, {
		path,
		args: _devtoolsRedact(args, __devtools.redactKeys, 0, new WeakSet()),
		startTime: now()
	});
}

/**
 * Redact a settled RPC result for storage.
 *
 * An Error needs its own branch: `message` and `stack` are own but NON-enumerable,
 * so the generic key walk (which uses Object.keys) would silently drop them and a
 * failed call would land in the history ring with no reason attached - the one
 * thing you open devtools to read. `message` is lifted explicitly; `stack` is
 * deliberately not kept.
 *
 * LIMIT, stated plainly: redaction is key-based, so it can only blank a VALUE
 * sitting under a matching key. A bare string carries no keys, so an error
 * message is stored verbatim - if your server echoes user input into an error
 * ("invalid password 'hunter2'"), that text reaches the devtools capture. Do not
 * read the explicit lift below as sanitising it.
 *
 * `name`, `message` and `code` bypass the redactor when they are own-NON-enumerable,
 * since the spread cannot see them. On a real `Error`, `name` comes off the
 * prototype and so bypasses it every time.
 * @param {any} result
 * @param {boolean} [ok] - settlement outcome; the error branch runs only for a REJECTION
 */
/**
 * Read one property without ever throwing. Used for the explicit lifts below.
 * @param {any} obj
 * @param {string} key
 * @returns {any}
 */
function _safeRead(obj, key) {
	try { return obj[key]; } catch { return undefined; }
}

/**
 * Is this worth lifting `name`/`code`/`message` off? A real `Error` answers
 * immediately. Anything else is duck-typed for the cross-realm case, and that
 * probe has to READ `message` - which on a hand-built or cross-realm error may
 * be a throwing accessor. `stack` is probed by PRESENCE (`in`) rather than by
 * reading it, so a lazy or hostile `stack` getter is never invoked here, and the
 * whole probe is guarded: it runs before the RPC's own `reject`, so a throw
 * escaping it would leave the caller's promise permanently unsettled.
 * @param {any} result
 * @returns {boolean}
 */
function _isErrorShaped(result) {
	if (result instanceof Error) return true;
	if (!result || typeof result !== 'object') return false;
	try {
		return typeof result.message === 'string' && 'stack' in result;
	} catch {
		return false;
	}
}

function _devtoolsResult(result, ok) {
	if (!__devtools) return result;
	const keys = __devtools.redactKeys;
	// Gated on `ok === false`. Shape alone is not enough: a SUCCESSFUL call may
	// legitimately resolve to error-shaped data (an error-log row is the obvious
	// one - `{ id, message, stack, level }`), and treating that as an error would
	// silently delete a field the server really returned, which is the one thing
	// the panel must not do.
	//
	// `message` duck-typed rather than `instanceof Error`: an error from another
	// realm (worker, iframe) fails the instanceof and would silently fall to the
	// generic walk that drops the message - the exact bug this branch exists for.
	if (ok === false && _isErrorShaped(result)) {
		// Built from own ENUMERABLE keys rather than a rest destructure. A rest
		// destructure reads `stack` to bind it, and on a real Error that is a lazy
		// V8 accessor: it would format a trace on every rejected call just to throw
		// it away (a whole reconnect storm's worth, since every pending call is
		// rejected at once), and if a source-map hook or a locked-down realm made
		// that read THROW, it would throw here - before the RPC's own `reject` runs,
		// leaving the caller's promise permanently unsettled. `Object.keys` never
		// touches a non-enumerable `stack`, so nothing is read that the guard above
		// has not already read.
		const extras = /** @type {Record<string, any>} */ ({});
		for (const k of Object.keys(/** @type {any} */ (result))) {
			if (k === 'stack') continue;
			try { extras[k] = /** @type {any} */ (result)[k]; } catch { extras[k] = '[unreadable]'; }
		}
		return {
			name: _safeRead(result, 'name'),
			code: _safeRead(result, 'code'),
			message: _safeRead(result, 'message'),
			// Own enumerable extras (e.g. an RpcError's `issues`) still walk
			// normally, and land LAST so a redacted value always wins over the
			// explicit lifts above. `dropStack` is on, so a nested `cause.stack` or
			// a back-reference cannot smuggle the trace back in below the top level.
			..._devtoolsRedact(extras, keys, 0, new WeakSet(), true)
		};
	}
	return _devtoolsRedact(result, keys, 0, new WeakSet());
}

/**
 * Record an RPC call completion for devtools. The result is redacted before
 * it lands in the history ring; the args were already redacted at start.
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
		result: _devtoolsResult(result, ok),
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
	// NOT redacted, and it cannot be: redaction is key-based and an error message
	// is a bare string. This is the one devtools field the panel renders, so a
	// server error that echoes user input ("invalid password 'hunter2'") is
	// captured verbatim. Documented as a limitation rather than papered over with
	// a redactor call that would be a no-op on a string.
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
