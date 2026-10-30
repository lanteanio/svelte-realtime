// @ts-check
import { setIntervalTimer, clearIntervalTimer, microtask } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { state } from './state.js';

// Occupancy admission for wire RPCs, after the frame parsed and its path
// resolved to a registered function. A call holds one permit in each of three
// scopes - its connection, its route and the worker - from admission until its
// handler settles. A call that finds a scope full waits in one bounded FIFO
// shared by the worker; a full queue (or a disabled one) refuses it at once.
// The vocabulary is the adapter's established-message admission: the reasons
// are `concurrency_limit` and `queue_full`, every limit is per worker, and a
// limit of 0 is disabled.
//
// Every call also gets an AbortSignal that fires at its deadline or when its
// connection closes. Instead of one controller and one timer per call, calls
// share a controller per connection and deadline tick: a ticker runs every
// _TICK_MS while anything is pending, a call's deadline lands in the tick at
// or after it, and the signal fires between the deadline and one tick past
// it. A connection that keeps calling reuses its controller, so the
// unsaturated path allocates nothing per call. A permit is released when the
// handler settles, never when its signal fires: a handler that ignores the
// signal keeps holding its own permit and nothing else.

/** The limits a worker starts with. */
export const RPC_ADMISSION_DEFAULTS = Object.freeze({
	perConnectionConcurrent: 32,
	perRouteConcurrent: 256,
	globalConcurrent: 1024,
	maxQueue: 256,
	timeout: 30000
});

const _KEYS = new Set(Object.keys(RPC_ADMISSION_DEFAULTS));
const _MAX_TIMEOUT_MS = 2147483647;
/** Deadline resolution: a signal fires at most this long after its deadline. */
const _TICK_MS = 250;

/** @type {typeof RPC_ADMISSION_DEFAULTS} */
let _config = RPC_ADMISSION_DEFAULTS;
/** Bumped on every configuration change so cached routes re-read their limits. */
let _epoch = 0;

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} [max]
 */
function _limit(value, name, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > max) {
		throw new Error(`[svelte-realtime] ${name} must be a non-negative integer${max < Number.MAX_SAFE_INTEGER ? ' up to ' + max : ''} (0 disables it)`);
	}
	return /** @type {number} */ (value);
}

/**
 * Configure RPC admission for this worker. Omitted keys take their defaults;
 * `null` restores every default. Each limit is a non-negative integer and 0
 * disables it: `maxQueue: 0` refuses a call that cannot start at once,
 * `timeout: 0` gives calls no deadline.
 *
 * @param {{ perConnectionConcurrent?: number, perRouteConcurrent?: number, globalConcurrent?: number, maxQueue?: number, timeout?: number } | null | undefined} options
 */
export function configureRpc(options) {
	if (options === null || options === undefined) {
		_config = RPC_ADMISSION_DEFAULTS;
		_epoch++;
		return;
	}
	if (typeof options !== 'object' || Array.isArray(options)) {
		throw new Error('[svelte-realtime] rpc admission options must be an object');
	}
	const unknown = Object.keys(options).filter((key) => !_KEYS.has(key));
	if (unknown.length > 0) {
		throw new Error(`[svelte-realtime] rpc admission options contain unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
	}
	const read = (/** @type {keyof typeof RPC_ADMISSION_DEFAULTS} */ key, max = Number.MAX_SAFE_INTEGER) =>
		options[key] === undefined ? RPC_ADMISSION_DEFAULTS[key] : _limit(options[key], 'rpc.' + key, max);
	_config = Object.freeze({
		perConnectionConcurrent: read('perConnectionConcurrent'),
		perRouteConcurrent: read('perRouteConcurrent'),
		globalConcurrent: read('globalConcurrent'),
		maxQueue: read('maxQueue'),
		timeout: read('timeout', _MAX_TIMEOUT_MS)
	});
	_epoch++;
}

/**
 * Validate a route's `perRouteConcurrent` option at declaration.
 * @param {unknown} value
 * @param {string} where
 */
export function _validateRouteConcurrent(value, where) {
	if (value !== undefined) _limit(value, where + ' perRouteConcurrent');
	return /** @type {number | undefined} */ (value);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RpcRoute
 * @property {string} path
 * @property {Function | null} fn - the registered function the limits were read from
 * @property {number} epoch
 * @property {number} limit - concurrent calls of this route, 0 for no limit
 * @property {number} ticks - deadline in ticks, 0 for no deadline
 * @property {number} active
 * @property {number} queued
 * @property {boolean} dirty - gauges owe a write
 * @property {{ path: string }} labels
 */

/**
 * @typedef {object} RpcSignal
 * @property {AbortController} ctrl
 * @property {AbortSignal} signal - `ctrl.signal`, read once
 * @property {RpcConn} conn
 * @property {number} tick - the deadline tick, -1 for none
 * @property {number} refs - calls holding it, queued or running
 */

/**
 * @typedef {object} RpcConn
 * @property {number} active
 * @property {boolean} closed
 * @property {RpcSignal | null} sig - the signal the next call with the same deadline reuses
 * @property {RpcSignal[]} sigs - every signal not yet fired
 */

/**
 * @typedef {object} RpcRejection
 * @property {'concurrency_limit' | 'queue_full'} reason
 * @property {'connection' | 'route' | 'global'} scope
 * @property {boolean} expired - the call waited past its deadline
 * @property {boolean} closed - the call's connection closed while it waited
 */

/**
 * @typedef {object} QueuedCall
 * @property {RpcConn} conn
 * @property {RpcRoute} route
 * @property {RpcSignal} sig
 * @property {'connection' | 'route' | 'global'} scope
 * @property {(result: RpcSignal | RpcRejection) => void} resolve
 */

/** @type {Map<string, RpcRoute>} */
const _routes = new Map();
/** @type {WeakMap<object, RpcConn>} */
const _conns = new WeakMap();
let _active = 0;
/** @type {QueuedCall[]} */
const _queue = [];
/** @type {Map<number, Set<RpcSignal>>} */
const _buckets = new Map();
let _tick = 0;
/** @type {any} */
let _ticker = null;

const _DEADLINE = new LiveError('TIMEOUT', 'The call passed its deadline');
const _CLOSED = new LiveError('CONNECTION_CLOSED', 'The connection closed');

/** @param {'concurrency_limit' | 'queue_full'} reason @param {'connection' | 'route' | 'global'} scope @param {boolean} expired @param {boolean} [closed] */
const _rejection = (reason, scope, expired, closed = false) => /** @type {RpcRejection} */ (Object.freeze({ reason, scope, expired, closed }));
const _LIMITED = {
	connection: _rejection('concurrency_limit', 'connection', false),
	route: _rejection('concurrency_limit', 'route', false),
	global: _rejection('concurrency_limit', 'global', false)
};
const _EXPIRED = {
	connection: _rejection('concurrency_limit', 'connection', true),
	route: _rejection('concurrency_limit', 'route', true),
	global: _rejection('concurrency_limit', 'global', true)
};
const _QUEUE_FULL = _rejection('queue_full', 'global', false);
const _CLOSED_WAITING = _rejection('concurrency_limit', 'connection', false, true);

/** A signal for work outside a wire call (cron, effects, direct calls); it never fires. */
export const NEVER_ABORTED = new AbortController().signal;

/**
 * Walk the marker chain a wrapper (`live.validated`, `live.rateLimit`, ...)
 * leaves to the function `live()` marked, for the first value of `key`.
 * @param {any} fn
 * @param {string} key
 */
function _routeOption(fn, key) {
	let cur = fn;
	for (let i = 0; cur && i < 8; i++) {
		if (cur[key] !== undefined) return cur[key];
		cur = cur.__wrappedFn;
	}
	return undefined;
}

/**
 * @param {string} path
 * @param {Function} fn
 * @param {RpcRoute | undefined} route
 * @returns {RpcRoute}
 */
function _refreshRoute(path, fn, route) {
	const ownLimit = _routeOption(fn, '__perRouteConcurrent');
	const ownTimeout = _routeOption(fn, '__rpcTimeout');
	const timeout = ownTimeout !== undefined ? ownTimeout : _config.timeout;
	const limit = ownLimit !== undefined ? ownLimit : _config.perRouteConcurrent;
	const ticks = timeout === 0 ? 0 : Math.ceil(timeout / _TICK_MS) + 1;
	if (route === undefined) {
		// The same length fold as every other RPC series label.
		const label = path.length <= 96 ? path : '__toolong__';
		route = { path, fn, epoch: _epoch, limit, ticks, active: 0, queued: 0, dirty: false, labels: Object.freeze({ path: label }) };
		_routes.set(path, route);
	} else {
		route.fn = fn;
		route.epoch = _epoch;
		route.limit = limit;
		route.ticks = ticks;
	}
	return route;
}

/**
 * The admission record of a registered path.
 * @param {string} path
 * @param {Function} fn
 * @returns {RpcRoute}
 */
export function _rpcRoute(path, fn) {
	const route = _routes.get(path);
	if (route !== undefined && route.fn === fn && route.epoch === _epoch) return route;
	return _refreshRoute(path, fn, route);
}

/** @param {object} ws @returns {RpcConn} */
function _conn(ws) {
	let conn = _conns.get(ws);
	if (conn === undefined) {
		conn = { active: 0, closed: false, sig: null, sigs: [] };
		_conns.set(ws, conn);
	}
	return conn;
}

/**
 * The first full scope, in the order connection, route, global; null when
 * the call may start.
 * @param {RpcConn} conn
 * @param {RpcRoute} route
 * @returns {'connection' | 'route' | 'global' | null}
 */
function _blocked(conn, route) {
	const config = _config;
	if (config.perConnectionConcurrent !== 0 && conn.active >= config.perConnectionConcurrent) return 'connection';
	if (route.limit !== 0 && route.active >= route.limit) return 'route';
	if (config.globalConcurrent !== 0 && _active >= config.globalConcurrent) return 'global';
	return null;
}

/**
 * Take a reference on the signal a new call of `route` on `conn` uses.
 * @param {RpcConn} conn
 * @param {RpcRoute} route
 * @returns {RpcSignal}
 */
function _takeSignal(conn, route) {
	if (conn.closed) {
		// A call that resolved its path after its connection closed.
		const ctrl = new AbortController();
		ctrl.abort(_CLOSED);
		return { ctrl, signal: ctrl.signal, conn, tick: -1, refs: 1 };
	}
	const tick = route.ticks === 0 ? -1 : _tick + route.ticks;
	let sig = conn.sig;
	if (sig !== null && sig.tick === tick) {
		sig.refs++;
		return sig;
	}
	if (sig !== null && sig.refs === 0) _dropSignal(sig);
	const ctrl = new AbortController();
	sig = { ctrl, signal: ctrl.signal, conn, tick, refs: 1 };
	conn.sig = sig;
	conn.sigs.push(sig);
	if (tick !== -1) {
		let bucket = _buckets.get(tick);
		if (bucket === undefined) {
			bucket = new Set();
			_buckets.set(tick, bucket);
		}
		bucket.add(sig);
		if (_ticker === null) _startTicker();
	}
	return sig;
}

/** @param {RpcSignal} sig */
function _dropSignal(sig) {
	const conn = sig.conn;
	if (conn.sig === sig) conn.sig = null;
	const at = conn.sigs.indexOf(sig);
	if (at !== -1) conn.sigs.splice(at, 1);
	if (sig.tick !== -1) _buckets.get(sig.tick)?.delete(sig);
}

/** @param {RpcSignal} sig */
function _unrefSignal(sig) {
	if (--sig.refs === 0 && sig.conn.sig !== sig) _dropSignal(sig);
}

/**
 * Admit a call of `route` from `ws`. Returns the call's signal record (its
 * permit) when it may start now, a rejection when it is refused, or a
 * promise of either when it waits in the queue. A rejected call holds
 * nothing.
 * @param {object} ws
 * @param {RpcRoute} route
 * @returns {RpcSignal | RpcRejection | Promise<RpcSignal | RpcRejection>}
 */
export function _admitRpc(ws, route) {
	const conn = _conn(ws);
	const config = _config;
	// The unsaturated path, written out: every scope has room and the
	// connection's current signal has this call's deadline.
	if ((config.perConnectionConcurrent === 0 || conn.active < config.perConnectionConcurrent) &&
		(route.limit === 0 || route.active < route.limit) &&
		(config.globalConcurrent === 0 || _active < config.globalConcurrent)) {
		conn.active++;
		route.active++;
		_active++;
		if (_metered) _touch(route);
		const sig = conn.sig;
		if (sig !== null && sig.tick === (route.ticks === 0 ? -1 : _tick + route.ticks)) {
			sig.refs++;
			return sig;
		}
		return _takeSignal(conn, route);
	}
	const scope = /** @type {'connection' | 'route' | 'global'} */ (_blocked(conn, route));
	if (config.maxQueue === 0) return _LIMITED[scope];
	if (_queue.length >= _config.maxQueue) return _QUEUE_FULL;
	const sig = _takeSignal(conn, route);
	route.queued++;
	if (_metered) _touch(route);
	return new Promise((resolve) => {
		_queue.push({ conn, route, sig, scope, resolve });
	});
}

/**
 * The handler of an admitted call settled: give its permits back and start
 * what the queue can now run.
 * @param {RpcRoute} route
 * @param {RpcSignal} sig
 */
export function _releaseRpc(route, sig) {
	const conn = sig.conn;
	conn.active--;
	route.active--;
	_active--;
	if (--sig.refs === 0 && conn.sig !== sig) _dropSignal(sig);
	if (_metered) _touch(route);
	if (_queue.length !== 0) _drain();
}

/** Start queued calls, oldest first, while their scopes have room. */
function _drain() {
	for (let i = 0; i < _queue.length;) {
		const entry = _queue[i];
		if (_blocked(entry.conn, entry.route) !== null) { i++; continue; }
		_queue.splice(i, 1);
		const { conn, route } = entry;
		route.queued--;
		conn.active++;
		route.active++;
		_active++;
		if (_metered) _touch(route);
		entry.resolve(entry.sig);
	}
}

/**
 * Take a queued call out with its rejection.
 * @param {number} index
 * @param {RpcRejection} rejection
 */
function _dropQueued(index, rejection) {
	const [entry] = _queue.splice(index, 1);
	entry.route.queued--;
	if (_metered) _touch(entry.route);
	_unrefSignal(entry.sig);
	entry.resolve(rejection);
}

/**
 * The connection closed: fire its calls' signals and refuse its queued calls.
 * Running calls keep their permits until their handlers settle.
 * @param {object} ws
 */
export function _closeRpcConnection(ws) {
	const conn = _conns.get(ws);
	if (conn === undefined) return;
	conn.closed = true;
	for (let i = _queue.length - 1; i >= 0; i--) {
		if (_queue[i].conn === conn) _dropQueued(i, _CLOSED_WAITING);
	}
	const sigs = conn.sigs;
	conn.sigs = [];
	conn.sig = null;
	for (const sig of sigs) {
		if (sig.tick !== -1) _buckets.get(sig.tick)?.delete(sig);
		sig.ctrl.abort(_CLOSED);
	}
	if (_queue.length !== 0) _drain();
}

function _startTicker() {
	_ticker = setIntervalTimer(_onTick, _TICK_MS);
	if (_ticker && _ticker.unref) _ticker.unref();
}

function _onTick() {
	_tick++;
	const bucket = _buckets.get(_tick);
	if (bucket !== undefined) {
		_buckets.delete(_tick);
		for (const sig of bucket) {
			const conn = sig.conn;
			if (conn.sig === sig) conn.sig = null;
			const at = conn.sigs.indexOf(sig);
			if (at !== -1) conn.sigs.splice(at, 1);
			sig.ctrl.abort(_DEADLINE);
		}
	}
	for (let i = _queue.length - 1; i >= 0; i--) {
		const entry = _queue[i];
		if (entry.sig.signal.aborted) _dropQueued(i, _EXPIRED[entry.scope]);
	}
	if (_buckets.size === 0 && _queue.length === 0) {
		clearIntervalTimer(_ticker);
		_ticker = null;
	}
}

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** @type {RpcRoute[]} */
const _dirty = [];
/** Whether `live.metrics()` installed the gauges; the hot path reads this flag, not the registry. */
let _metered = false;

/** @param {RpcRoute} route */
function _touch(route) {
	if (route.dirty) return;
	route.dirty = true;
	if (_dirty.push(route) === 1) microtask(_flushGauges);
}

// The in-flight and queued gauges are written once per microtask in which
// they changed, like the background-work gauges: a burst moves the counts
// many times in one turn and only the value a scrape can see matters.
function _flushGauges() {
	const mi = state.metricsInstruments;
	const routes = _dirty.splice(0);
	for (const route of routes) route.dirty = false;
	if (!mi) return;
	const inflight = mi.rpcInflight;
	const queued = mi.rpcQueued;
	for (const route of routes) {
		if (inflight && typeof inflight.set === 'function') inflight.set(route.labels, route.active);
		if (queued && typeof queued.set === 'function') queued.set(route.labels, route.queued);
	}
}

/** Write every route's gauges, for `live.metrics()` installing them while calls already run. */
export function _publishRpcGauges() {
	_metered = true;
	for (const route of _routes.values()) _touch(route);
}

/** Current totals, for tests and introspection. */
export function _rpcAdmissionSnapshot() {
	const routes = {};
	for (const [path, route] of _routes) routes[path] = { active: route.active, queued: route.queued, limit: route.limit };
	return { active: _active, queued: _queue.length, config: _config, routes };
}

/** Forget every count, queue and timer, and restore the defaults. Tests only. */
export function _resetRpcAdmission() {
	_config = RPC_ADMISSION_DEFAULTS;
	_epoch++;
	_routes.clear();
	_active = 0;
	_queue.length = 0;
	_buckets.clear();
	_dirty.length = 0;
	_metered = false;
	if (_ticker !== null) clearIntervalTimer(_ticker);
	_ticker = null;
}
