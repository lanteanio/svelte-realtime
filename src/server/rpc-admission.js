// @ts-check
import { setIntervalTimer, clearIntervalTimer } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { state } from './state.js';

// Occupancy admission for wire RPCs, after the frame parsed and its path
// resolved to a registered function. A call holds one permit in each of three
// scopes - its connection, its route and the worker - from admission until its
// handler settles. A call that finds a scope full waits in one bounded FIFO
// shared by the worker, in which one connection holds a bounded share; a full
// queue (or a disabled one) refuses it at once. The vocabulary is the
// adapter's established-message admission: the reasons are
// `concurrency_limit` and `queue_full`, every limit is per worker, and a limit
// of 0 is disabled.
//
// The unsaturated path is three compares and three counters: the route's
// record hangs off its registered function, the connection's record sits in a
// slot on the socket's user data (declared at open, like the adapter's own
// per-connection slots), and the worker's count is a module integer. A closed
// connection's count is pushed past every cap, so the same compares refuse it.
//
// A call's deadline is counted in ticks of RPC_DEADLINE_TICK_MS from the tick
// it arrived in. The ticker runs while calls run, wait or hold a deadline, and
// stops on the first tick that finds none, so an idle worker has no timer. A
// call's `ctx.abortSignal` is created when the handler first reads it; its
// controller then joins the connection's running calls and the bucket of its
// deadline tick, and the ticker aborts what is in a bucket when its tick
// arrives, so the signal fires within one tick after the deadline. When the call settles, its
// controller leaves both and is never aborted afterwards. A handler that never
// reads the signal allocates nothing for it. A permit is released when the
// handler settles, never when its signal fires: a handler that ignores the
// signal keeps holding its own permit and nothing else.

/** The limits a worker starts with. */
export const RPC_ADMISSION_DEFAULTS = Object.freeze({
	perConnectionConcurrent: 32,
	perConnectionQueue: 32,
	perRouteConcurrent: 256,
	globalConcurrent: 1024,
	maxQueue: 256,
	timeout: 30000
});

const _KEYS = new Set(Object.keys(RPC_ADMISSION_DEFAULTS));
const _MAX_TIMEOUT_MS = 2147483647;
/** Deadline resolution: a signal fires at most this long after its deadline. */
export const RPC_DEADLINE_TICK_MS = 250;
/** A disabled limit compares as this, so the admit check needs no branch for 0. */
const _UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** @type {typeof RPC_ADMISSION_DEFAULTS} */
let _config = RPC_ADMISSION_DEFAULTS;
let _connCap = RPC_ADMISSION_DEFAULTS.perConnectionConcurrent;
let _connQueueCap = RPC_ADMISSION_DEFAULTS.perConnectionQueue;
let _globalCap = RPC_ADMISSION_DEFAULTS.globalConcurrent;

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

/** Apply `_config` to the module caps and every known route, and start what now fits. */
function _applyConfig() {
	_connCap = _config.perConnectionConcurrent || _UNBOUNDED;
	_connQueueCap = _config.perConnectionQueue || _UNBOUNDED;
	_globalCap = _config.globalConcurrent || _UNBOUNDED;
	for (const route of _routes.values()) _applyRoute(route);
	if (_queue.length !== 0) _drain();
}

/**
 * Configure RPC admission for this worker. Omitted keys take their defaults;
 * `null` restores every default. Each limit is a non-negative integer and 0
 * disables it: `maxQueue: 0` refuses a call that cannot start at once,
 * `timeout: 0` gives calls no deadline.
 *
 * @param {{ perConnectionConcurrent?: number, perConnectionQueue?: number, perRouteConcurrent?: number, globalConcurrent?: number, maxQueue?: number, timeout?: number } | null | undefined} options
 */
export function configureRpc(options) {
	if (options === null || options === undefined) {
		_config = RPC_ADMISSION_DEFAULTS;
		_applyConfig();
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
		perConnectionQueue: read('perConnectionQueue'),
		perRouteConcurrent: read('perRouteConcurrent'),
		globalConcurrent: read('globalConcurrent'),
		maxQueue: read('maxQueue'),
		timeout: read('timeout', _MAX_TIMEOUT_MS)
	});
	_applyConfig();
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
 * @property {string} path - the first path the function was registered under
 * @property {number | undefined} ownLimit - the function's own `perRouteConcurrent`
 * @property {number | undefined} ownTimeout - the function's own `timeout`
 * @property {number} cap - concurrent calls of this route; a disabled limit is unbounded
 * @property {number} ticks - deadline in ticks, 0 for no deadline
 * @property {number} active
 * @property {number} queued
 * @property {string} label - the gauge label, the path folded to a bounded length
 */

/**
 * @typedef {object} RpcConn
 * @property {number} active - calls running; Infinity once closed
 * @property {object | undefined} ws - the socket the record belongs to
 * @property {number} queued - calls waiting in the queue
 * @property {boolean} closed
 * @property {Map<any, RpcCallSignal> | null} calls - running calls whose handler read its signal, by ctx
 */

/**
 * @typedef {object} RpcCallSignal
 * @property {AbortController} ctrl
 * @property {number} deadline - its deadline tick, -1 for none
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
 * @property {'connection' | 'route' | 'global'} scope - the scope that was full when it queued
 * @property {number} deadline - its deadline tick, -1 for none
 * @property {(result: RpcConn | RpcRejection) => void} resolve
 */

/** Where a registered function keeps its route record. */
export const RPC_ROUTE = Symbol('svelte-realtime.rpc.route');

/** @type {Map<string, RpcRoute>} */
const _routes = new Map();
/**
 * Where a socket's user data keeps its admission record. `Symbol.for`, like
 * the adapter's own per-connection slots, so a bundled and a loaded copy of
 * this module agree on it.
 */
export const RPC_CONNECTION = Symbol.for('svelte-realtime.rpc.connection');
/**
 * A closed connection's running count. Every cap, an unbounded one included,
 * is a finite integer, so no call of it fits; decrements leave it unchanged.
 */
const _CLOSED_COUNT = Infinity;
/** Records of sockets whose user data cannot carry the slot (not an extensible object). @type {WeakMap<object, RpcConn>} */
const _unslotted = new WeakMap();
let _active = 0;
/** Signals created and not yet retired or fired, for tests and introspection. */
let _openSignals = 0;
/** @type {QueuedCall[]} */
const _queue = [];
/** Running calls whose signal was read, by deadline tick. @type {Map<number, Set<RpcConn>>} */
const _buckets = new Map();
/** The deadline clock, in ticks of RPC_DEADLINE_TICK_MS. Read it to stamp a call's arrival. */
export let rpcTick = 0;
/** @type {any} */
let _ticker = null;

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
const _CONNECTION_QUEUE_FULL = _rejection('queue_full', 'connection', false);
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

/** @param {RpcRoute} route */
function _applyRoute(route) {
	const limit = route.ownLimit !== undefined ? route.ownLimit : _config.perRouteConcurrent;
	const timeout = route.ownTimeout !== undefined ? route.ownTimeout : _config.timeout;
	route.cap = limit || _UNBOUNDED;
	route.ticks = timeout === 0 ? 0 : Math.ceil(timeout / RPC_DEADLINE_TICK_MS) + 1;
}

/**
 * Give a registered function its route record. Registration calls this, so a
 * call reads the record with one property load. The record belongs to the
 * path: a function registered again (a development reload) takes over the
 * path's counts. A function registered under a second path keeps its first
 * record, so the two paths share one bound.
 * @param {string} path
 * @param {Function} fn
 * @returns {RpcRoute}
 */
export function _rpcRoute(path, fn) {
	const own = /** @type {any} */ (fn)[RPC_ROUTE];
	if (own !== undefined) return own;
	let route = _routes.get(path);
	if (route === undefined) {
		// The same length fold as every other RPC series label.
		const label = path.length <= 96 ? path : '__toolong__';
		route = { path, ownLimit: undefined, ownTimeout: undefined, cap: 0, ticks: 0, active: 0, queued: 0, label };
		_routes.set(path, route);
	}
	route.ownLimit = _routeOption(fn, '__perRouteConcurrent');
	route.ownTimeout = _routeOption(fn, '__rpcTimeout');
	_applyRoute(route);
	if (Object.isExtensible(fn)) Object.defineProperty(fn, RPC_ROUTE, { value: route, writable: true, configurable: true });
	return route;
}

/** @returns {RpcConn} */
/** @param {object} [ws] @returns {RpcConn} */
function _newConn(ws) {
	return { active: 0, queued: 0, closed: false, calls: null, ws };
}

/**
 * Declare a socket's admission slot on its user data. The open hook calls
 * this, so a call reads its connection's record with one property load; a
 * connection opened without the hook gets its slot on its first call. The
 * slot is not enumerable, so a copy of the user data does not carry it.
 * A record a closed socket left on the same object is replaced, and `fresh`
 * replaces any record: the open hook passes it, since a socket at open is new.
 * Only an own slot counts; one inherited through the prototype is never used.
 * @param {any} user - the socket's user data
 * @param {object} [ws]
 * @param {boolean} [fresh]
 * @returns {RpcConn}
 */
export function _openRpcConnection(user, ws, fresh = false) {
	if (user !== null && typeof user === 'object') {
		const own = Object.prototype.hasOwnProperty.call(user, RPC_CONNECTION) ? user[RPC_CONNECTION] : undefined;
		if (own !== undefined && !fresh && !own.closed) return own;
		const conn = _newConn(ws);
		if (Object.isExtensible(user)) {
			Object.defineProperty(user, RPC_CONNECTION, { value: conn, writable: true, enumerable: false, configurable: true });
			return conn;
		}
		if (ws) _unslotted.set(ws, conn);
		return conn;
	}
	if (fresh && ws) _unslotted.delete(ws);
	if (!ws) return _newConn();
	let conn = fresh ? undefined : _unslotted.get(ws);
	if (conn === undefined) {
		conn = _newConn(ws);
		_unslotted.set(ws, conn);
	}
	return conn;
}

/**
 * The admission record of a socket, from its user data's slot.
 * @param {any} user
 * @param {object} ws
 * @returns {RpcConn}
 */
function _connOf(user, ws) {
	if (user !== null && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, RPC_CONNECTION)) return user[RPC_CONNECTION];
	return _unslotted.get(ws) || _openRpcConnection(user, ws);
}

/**
 * The first full scope, in the order connection, route, global; null when
 * the call may start.
 * @param {RpcConn} conn
 * @param {RpcRoute} route
 * @returns {'connection' | 'route' | 'global' | null}
 */
function _blocked(conn, route) {
	if (conn.active >= _connCap) return 'connection';
	if (route.active >= route.cap) return 'route';
	if (_active >= _globalCap) return 'global';
	return null;
}

/**
 * Admit a call of `route` from `ws`, whose user data is `user`, that
 * arrived at deadline tick `arrived`. Returns the connection's record (the
 * permit) when the call may start now, a rejection when it is refused, or a
 * promise of either when it waits in the queue. A rejected call holds
 * nothing, and a call of a closed connection is always refused.
 * @param {any} user
 * @param {object} ws
 * @param {RpcRoute} route
 * @param {number} arrived - `rpcTick` when the call arrived
 * @param {RpcConn} [opened] - a record just opened for this socket
 * @returns {RpcConn | RpcRejection | Promise<RpcConn | RpcRejection>}
 */
export function _admitRpc(user, ws, route, arrived, opened) {
	let conn = opened || user?.[RPC_CONNECTION];
	if (conn === undefined) conn = _connOf(user, ws);
	if (conn.active < _connCap && route.active < route.cap && _active < _globalCap) {
		conn.active++;
		route.active++;
		_active++;
		if (_ticker === null) _startTicker();
		return conn;
	}
	if (conn.closed) {
		// A late call of the socket that closed is refused. A record a closed
		// socket left on user data now held by another socket is replaced.
		if (conn.ws === ws) return _CLOSED_WAITING;
		return _admitRpc(user, ws, route, arrived, _openRpcConnection(user, ws, true));
	}
	const scope = /** @type {'connection' | 'route' | 'global'} */ (_blocked(conn, route));
	if (_config.maxQueue === 0) return _LIMITED[scope];
	if (conn.queued >= _connQueueCap) return _CONNECTION_QUEUE_FULL;
	if (_queue.length >= _config.maxQueue) return _QUEUE_FULL;
	conn.queued++;
	route.queued++;
	const deadline = route.ticks === 0 ? -1 : arrived + route.ticks;
	if (deadline !== -1 && _ticker === null) _startTicker();
	return new Promise((resolve) => {
		_queue.push({ conn, route, scope, deadline, resolve });
	});
}

/**
 * The handler of an admitted call settled: give its permits back and start
 * what the queue can now run. `ctx` is the call's context when its handler
 * read the signal, else null; its signal is then retired and never fires.
 * @param {RpcRoute} route
 * @param {RpcConn} conn
 * @param {any} opened
 */
export function _releaseRpc(route, conn, opened) {
	conn.active--;
	route.active--;
	_active--;
	if (opened !== null) _retireCall(opened, conn);
	if (_queue.length !== 0) _drain();
}

/**
 * A handler read `ctx.abortSignal` for the first time: create its
 * controller and register it for its deadline and its connection's close.
 * @param {any} ctx
 * @param {RpcConn} conn
 * @param {number} deadline - its deadline tick, -1 for none
 * @returns {AbortSignal}
 */
export function _openCallSignal(ctx, conn, deadline) {
	const ctrl = new AbortController();
	if (conn.closed) {
		ctrl.abort(new LiveError('CONNECTION_CLOSED', 'The connection closed'));
	} else if (deadline !== -1 && deadline <= rpcTick) {
		ctrl.abort(new LiveError('TIMEOUT', 'The call passed its deadline'));
	} else {
		_openSignals++;
		(conn.calls || (conn.calls = new Map())).set(ctx, { ctrl, deadline });
		if (deadline !== -1) {
			let bucket = _buckets.get(deadline);
			if (bucket === undefined) {
				bucket = new Set();
				_buckets.set(deadline, bucket);
			}
			bucket.add(conn);
			if (_ticker === null) _startTicker();
		}
	}
	return ctrl.signal;
}

/**
 * Take a settled call's controller out of its connection, so neither its
 * deadline nor its connection's close fires it.
 * @param {any} ctx
 * @param {RpcConn} conn
 */
function _retireCall(ctx, conn) {
	if (conn.calls?.delete(ctx)) _openSignals--;
}

/** Start queued calls, oldest first, while their scopes have room. */
function _drain() {
	for (let i = 0; i < _queue.length;) {
		const entry = _queue[i];
		if (_blocked(entry.conn, entry.route) !== null) { i++; continue; }
		_queue.splice(i, 1);
		const { conn, route } = entry;
		conn.queued--;
		route.queued--;
		conn.active++;
		route.active++;
		_active++;
		entry.resolve(conn);
	}
}

/**
 * Take a queued call out with its rejection.
 * @param {number} index
 * @param {RpcRejection} rejection
 */
function _dropQueued(index, rejection) {
	const [entry] = _queue.splice(index, 1);
	entry.conn.queued--;
	entry.route.queued--;
	entry.resolve(rejection);
}

/**
 * The connection closed: refuse its later calls, fire the signals its running
 * calls read and drop its queued calls. Running calls keep their permits until
 * their handlers settle. A socket that never called still gets a closed
 * record, so a call that resolves its path after the close cannot open one.
 * @param {any} user - the socket's user data
 * @param {object} ws
 */
export function _closeRpcConnection(user, ws) {
	const conn = _connOf(user, ws);
	if (conn.closed) return;
	conn.closed = true;
	conn.active = _CLOSED_COUNT;
	for (let i = _queue.length - 1; i >= 0; i--) {
		if (_queue[i].conn === conn) _dropQueued(i, _CLOSED_WAITING);
	}
	const calls = conn.calls;
	conn.calls = null;
	if (calls !== null) {
		for (const call of calls.values()) {
			_openSignals--;
			call.ctrl.abort(new LiveError('CONNECTION_CLOSED', 'The connection closed'));
		}
	}
	if (_queue.length !== 0) _drain();
}

function _startTicker() {
	_ticker = setIntervalTimer(_onTick, RPC_DEADLINE_TICK_MS);
	if (_ticker && _ticker.unref) _ticker.unref();
}

function _onTick() {
	const tick = ++rpcTick;
	const bucket = _buckets.get(tick);
	if (bucket !== undefined) {
		_buckets.delete(tick);
		// A bucket names the connections with a call due now; a call that
		// settled since has left its connection's map and is not fired.
		for (const conn of bucket) {
			const calls = conn.calls;
			if (calls === null) continue;
			for (const [ctx, call] of calls) {
				if (call.deadline !== tick) continue;
				calls.delete(ctx);
				_openSignals--;
				call.ctrl.abort(new LiveError('TIMEOUT', 'The call passed its deadline'));
			}
		}
	}
	let deadlines = false;
	for (let i = _queue.length - 1; i >= 0; i--) {
		const entry = _queue[i];
		if (entry.deadline === -1) continue;
		if (entry.deadline <= tick) _dropQueued(i, _EXPIRED[_blocked(entry.conn, entry.route) || entry.scope]);
		else deadlines = true;
	}
	if (_buckets.size === 0 && !deadlines && _active === 0) {
		clearIntervalTimer(_ticker);
		_ticker = null;
	}
}

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** How often the in-flight and queued gauges are sampled while metrics are installed. */
export const RPC_GAUGE_SAMPLE_MS = 1000;
/** @type {any} */
let _sampler = null;
/** What each gauge label last got, so an unchanged value is not written again. @type {Map<string, { active: number, queued: number }>} */
const _shown = new Map();

// The gauges are sampled, not written per call: a call only moves its
// counters, and the sampler writes each label whose sums changed since its
// last write. Routes whose paths fold to one label add up under it. A scrape
// sees values at most one sample old.
export function _sampleRpcGauges() {
	const mi = state.metricsInstruments;
	if (!mi) return;
	const inflight = typeof mi.rpcInflight?.set === 'function' ? mi.rpcInflight : null;
	const queued = typeof mi.rpcQueued?.set === 'function' ? mi.rpcQueued : null;
	/** @type {Map<string, { active: number, queued: number }>} */
	const sums = new Map();
	for (const route of _routes.values()) {
		const sum = sums.get(route.label);
		if (sum === undefined) sums.set(route.label, { active: route.active, queued: route.queued });
		else {
			sum.active += route.active;
			sum.queued += route.queued;
		}
	}
	for (const [path, sum] of sums) {
		const shown = _shown.get(path);
		const labels = { path };
		if (inflight && shown?.active !== sum.active) inflight.set(labels, sum.active);
		if (queued && shown?.queued !== sum.queued) queued.set(labels, sum.queued);
		_shown.set(path, sum);
	}
}

/** Start sampling the gauges, for `live.metrics()` installing them. */
export function _publishRpcGauges() {
	_shown.clear();
	_sampleRpcGauges();
	if (_sampler !== null) clearIntervalTimer(_sampler);
	_sampler = setIntervalTimer(_sampleRpcGauges, RPC_GAUGE_SAMPLE_MS);
	if (_sampler && _sampler.unref) _sampler.unref();
}

/** Current totals, for tests and introspection. */
export function _rpcAdmissionSnapshot() {
	const routes = {};
	for (const [path, route] of _routes) routes[path] = { active: route.active, queued: route.queued, cap: route.cap };
	return { active: _active, queued: _queue.length, config: _config, routes, openSignals: _openSignals, ticking: _ticker !== null };
}

/**
 * Forget every count, queue and timer, and restore the defaults. Route
 * records stay attached to their functions with their counts zeroed. Tests
 * only.
 */
export function _resetRpcAdmission() {
	_config = RPC_ADMISSION_DEFAULTS;
	for (const route of _routes.values()) {
		route.active = 0;
		route.queued = 0;
	}
	_queue.length = 0;
	_applyConfig();
	_active = 0;
	_openSignals = 0;
	_buckets.clear();
	_shown.clear();
	if (_ticker !== null) clearIntervalTimer(_ticker);
	_ticker = null;
	if (_sampler !== null) clearIntervalTimer(_sampler);
	_sampler = null;
}
