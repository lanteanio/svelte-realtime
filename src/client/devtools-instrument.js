// @ts-check
import { now, setTimer, clearTimer } from '../client-runtime.js';

// - DevTools instrumentation (non-production only) ---------------------------

/**
 * Default key names whose values are replaced with `'[REDACTED]'` when
 * explicitly unsafe payload capture is enabled. Case-insensitive match
 * against the ENTIRE key (substring match would over-redact). Apps can
 * override or extend via `__devtools.redactKeys = new Set([...])`; entries are
 * normalized to lowercase at the top of each redaction walk, so a mixed-case
 * entry like `'paymentMethod'` matches.
 */
const _DEFAULT_REDACT_KEYS = new Set([
	'password', 'token', 'apikey', 'api_key', 'secret', 'authorization',
	'cookie', 'sessionid', 'session_id', 'csrf', 'csrftoken', 'csrf_token'
]);

const _MAX_STREAM_EVENTS = 20;

const _DEVTOOLS_VOLATILE_MAX = 100;
let _unsafeCapturePayloads = false;
let _clearedEvents = new Map();
let _clearExpiry = null;
let _clearDeadline = 0;

function _forgetClearedEvents() {
 _clearedEvents.clear();
 if (_clearExpiry !== null) clearTimer(_clearExpiry);
 _clearExpiry = null;
 _clearDeadline = 0;
}


/**
 * @type {{
 *   clear: () => void,
 *   clearEvents: () => void,
 *   undoClearEvents: () => void,
 *   undoClearCount: number,
 *   connection: { state: string, since: number, failure: any },
 *   history: any[],
 *   streams: Map<string, any>,
 *   pending: Map<string, any>,
 *   volatile: any[],
 *   volatileDropped: number,
 *   redactKeys: Set<string>,
 *   unsafeCapturePayloads: boolean,
 *   paused: boolean,
 *   smooth: Set<() => any>
 * } | null}
 */
export const __devtools = (import.meta.env?.DEV === true && !import.meta.env?.PROD)
	? {
		clear: _clearCaptures,
		clearEvents: _clearEvents,
		undoClearEvents: _undoClearEvents,
		get undoClearCount() {
			if (_clearDeadline && now() >= _clearDeadline) _forgetClearedEvents();
			let count = 0;
			for (const { events } of _clearedEvents.values()) count += events.length;
			return count;
		},
		connection: { state: 'idle', since: now(), failure: null },
		history: new Array(50).fill(null),
		streams: new Map(),
		pending: new Map(),
		volatile: new Array(_DEVTOOLS_VOLATILE_MAX).fill(null),
		volatileDropped: 0,
		redactKeys: new Set(_DEFAULT_REDACT_KEYS),
		get unsafeCapturePayloads() {
			return _unsafeCapturePayloads;
		},
		set unsafeCapturePayloads(value) {
			_unsafeCapturePayloads = value === true;
			if (_unsafeCapturePayloads) return;
			_clearCaptures();
		},
		paused: true,
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
 * Metadata-only description used by default. It never reads an object
 * property value or retains a field name (although it may enumerate names to
 * count own fields), so credentials remain absent even when they use an
 * unexpected key or sit in a bare string. Every reflection step is guarded:
 * even a revoked Proxy degrades to metadata instead of escaping into the RPC
 * path this instrumentation observes.
 * @param {any} value
 * @returns {{ dataClass: 'confidential', captured: false, type: string, length?: number, fields?: number }}
 */
function _devtoolsMetadata(value) {
	const type = value === null ? 'null' : typeof value;
	try {
		if (value === null) return { dataClass: 'confidential', captured: false, type };
		if (type === 'string') {
			return { dataClass: 'confidential', captured: false, type, length: value.length };
		}
		if (Array.isArray(value)) {
			let length;
			try { length = value.length; } catch {}
			return {
				dataClass: 'confidential',
				captured: false,
				type: 'array',
				...(typeof length === 'number' ? { length } : {})
			};
		}
		if (type === 'object') {
			let fields;
			try { fields = Object.keys(value).length; } catch {}
			return {
				dataClass: 'confidential',
				captured: false,
				type,
				...(typeof fields === 'number' ? { fields } : {})
			};
		}
		return { dataClass: 'confidential', captured: false, type };
	} catch {
		// `Array.isArray` itself throws for a revoked Proxy. Preserve only the
		// primitive `typeof` result, which is safe even after revocation.
		return { dataClass: 'confidential', captured: false, type };
	}
}

/** @param {any[]} args @returns {any[]} */
function _devtoolsCaptureArgs(args) {
	try {
		if (!__devtools || !__devtools.unsafeCapturePayloads) {
			return args.map((value) => _devtoolsMetadata(value));
		}
		return _devtoolsRedact(args, __devtools.redactKeys, 0, new WeakSet());
	} catch {
		// Instrumentation is observational. A hostile argument container or
		// mutable redaction configuration must never change call semantics.
		return ['[unreadable]'];
	}
}

/** @param {string | null} topic @returns {string | null} */
function _devtoolsCaptureTopic(topic) {
	if (topic === null || !__devtools || __devtools.unsafeCapturePayloads) return topic;
	return '[topic omitted; chars=' + topic.length + ']';
}

/**
 * Record a fire-and-forget RPC send for devtools. Send-only - there is no
 * matching completion event because the wire shape carries no `id` and the
 * server never replies. Ring buffer is bounded (`_DEVTOOLS_VOLATILE_MAX`,
 * drop-oldest) so a high-frequency 60-120Hz mover can't anchor unbounded
 * dev-mode memory. Args retain metadata only by default. With the explicit
 * unsafe opt-in they pass through the shared key redactor before storage.
 * @param {string} path
 * @param {any[]} args
 */
export function _devtoolsVolatileSent(path, args) {
	if (!__devtools) return;
	__devtools.volatile[_devtoolsVolatileIdx] = {
		path,
		args: _devtoolsCaptureArgs(args),
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
	try {
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
	} catch {
		// Reflection on a Proxy can throw at `Array.isArray`, iteration,
		// `Object.keys`, slicing, or property access. Unsafe capture may retain
		// values by explicit opt-in, but it still must not alter application
		// behavior; collapse an unreadable subtree to a fixed sentinel.
		return '[unreadable]';
	}
}

/** Ring buffer index for devtools history (O(1) insertion, no array.shift) */
let _devtoolsHistoryIdx = 0;
let _devtoolsSeq = 0;
const _DEVTOOLS_HISTORY_MAX = 50;

/**
 * Record an RPC call start for devtools. Args retain metadata only by default;
 * the explicit unsafe opt-in applies the same key redactor as stream events.
 * @param {string} path
 * @param {string} id
 * @param {any[]} args
 */
export function _devtoolsStart(path, id, args) {
	if (!__devtools) return;
	__devtools.pending.set(id, {
		path,
		args: _devtoolsCaptureArgs(args),
		startTime: now()
	});
}

/**
 * Capture a settled RPC result. The default returns metadata only; the
 * branches below are reached only after unsafe payload capture is enabled.
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
	try {
		if (result instanceof Error) return true;
		if (!result || typeof result !== 'object') return false;
		return typeof result.message === 'string' && 'stack' in result;
	} catch {
		return false;
	}
}

function _devtoolsResult(result, ok, payloadsCleared) {
	if (!__devtools) return result;
	if (payloadsCleared || !__devtools.unsafeCapturePayloads) {
		const metadata = _devtoolsMetadata(result);
		if (ok !== false) return metadata;
		const rawName = _safeRead(result, 'name');
		const rawCode = _safeRead(result, 'code');
		return {
			...metadata,
			errorName: typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(rawName)
				? rawName
				: 'Error',
			code: typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
				? rawCode
				: 'UNKNOWN'
		};
	}
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
		let enumerableKeys;
		try { enumerableKeys = Object.keys(/** @type {any} */ (result)); }
		catch { return '[unreadable]'; }
		for (const k of enumerableKeys) {
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
 * Record an RPC call completion for devtools. The safe default stores
 * metadata; unsafe capture stores key-redacted values.
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
		result: _devtoolsResult(result, ok, entry.payloadsCleared),
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
			topic: _devtoolsCaptureTopic(topic),
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
 * Record a pub/sub event arrival for devtools. The safe default pushes
 * metadata to the bounded ring; unsafe capture pushes a key-redacted,
 * depth/array-capped snapshot. Skips capture when paused.
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
	const captured = data === undefined
		? undefined
		: (__devtools.unsafeCapturePayloads
			? _devtoolsRedact(data, __devtools.redactKeys, 0, new WeakSet())
			: _devtoolsMetadata(data));
	e.recentEvents.push({ event: eventType, data: captured, ts: e.lastEventTime });
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
	if (!err) {
		e.error = null;
		return;
	}
	const rawCode = _safeRead(err, 'code');
	const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
		? rawCode
		: 'UNKNOWN';
	if (!__devtools.unsafeCapturePayloads) {
		e.error = { code, message: '[message omitted]' };
		return;
	}
	const rawMessage = _safeRead(err, 'message');
	let message = typeof rawMessage === 'string' && rawMessage ? rawMessage : 'Unknown stream error';
	if (typeof rawMessage !== 'string') {
		try { message = String(err); } catch {}
	}
	e.error = { code, message };
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

/** @param {string} state */
export function _devtoolsConnectionStatus(state) {
 if (!__devtools) return;
 const connection = __devtools.connection;
 const lost = state === 'disconnected' || state === 'failed';
 const wasLost = connection.state === 'disconnected' || connection.state === 'failed';
 // A disconnect can be followed immediately by exhausted retries. Keep the
 // metadata-only errors recorded between those two states of the same loss.
 if ((lost && (!wasLost || _unsafeCapturePayloads)) || ((connection.state === 'open' || connection.state === 'suspended') && state === 'connecting')) __devtools.clear();
 if (connection.state !== state) {
  connection.state = state;
  connection.since = now();
 }
 if (state === 'open') connection.failure = null;
}

/** Retain stable failure metadata without close text or authentication details.
 * @param {any} failure
 */
export function _devtoolsConnectionFailure(failure) {
 if (!__devtools) return;
 if (!failure) { __devtools.connection.failure = null; return; }
 const kind = _safeRead(failure, 'kind');
 const category = _safeRead(failure, 'class');
 const code = _safeRead(failure, 'code');
 const status = _safeRead(failure, 'status');
 __devtools.connection.failure = {
  kind: kind === 'ws-close' || kind === 'auth-preflight' ? kind : 'unknown',
  class: ['TERMINAL', 'EXHAUSTED', 'THROTTLE', 'RETRY', 'AUTH', 'DRAIN'].includes(category) ? category : 'UNKNOWN',
  ...(Number.isInteger(code) ? { code } : {}),
  ...(Number.isInteger(status) ? { status } : {})
 };
}

function _clearEvents() {
 if (!__devtools) return;
 _forgetClearedEvents();
 for (const [path, stream] of __devtools.streams) {
  const events = stream.recentEvents;
  stream.recentEvents = [];
  if (events.length) _clearedEvents.set(path, { events, target: stream.recentEvents });
 }
 if (_clearedEvents.size) {
  _clearDeadline = now() + 30000;
  _clearExpiry = setTimer(_forgetClearedEvents, 30000);
 }
}

function _undoClearEvents() {
 if (!__devtools || !__devtools.undoClearCount) return;
 for (const [path, saved] of _clearedEvents) {
  const stream = __devtools.streams.get(path);
  if (!stream || stream.recentEvents !== saved.target) continue;
  stream.recentEvents = [...saved.events, ...stream.recentEvents].slice(-_MAX_STREAM_EVENTS);
 }
 _forgetClearedEvents();
}

function _clearCaptures() {
 if (!__devtools) return;
 _unsafeCapturePayloads = false;
 __devtools.paused = true;
 _forgetClearedEvents();
 __devtools.history.fill(null);
 // Keep correlation and timing so a later settlement remains observable.
 for (const entry of __devtools.pending.values()) {
  entry.args = [];
  entry.payloadsCleared = true;
 }
 __devtools.volatile.fill(null);
 for (const stream of __devtools.streams.values()) {
  if (stream.topic !== null) stream.topic = '[topic omitted]';
  if (stream.error) stream.error = { code: stream.error.code, message: '[message omitted]' };
  stream.recentEvents = [];
 }
 if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
  window.dispatchEvent(new Event('svelte-realtime-devtools-clear'));
 }
}
