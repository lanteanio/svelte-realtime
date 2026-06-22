// @ts-check
import { now as runtimeNow, setTimer, clearTimer } from '../shared/runtime.js';
import { assert } from '../shared/assert.js';
import { LiveError } from './live-error.js';
import { _tenantKey } from './tenant.js';

/** @type {{ acquire: (key: string, ttlSec: number) => Promise<any> } | null} */
let _defaultIdempotencyStore = null;

/**
 * Lazy in-process idempotency store. Three-state acquire matching the contract
 * of `createIdempotencyStore` from svelte-adapter-uws-extensions, so swapping
 * the default for a multi-instance backend is a one-line change.
 * Bounded by maxEntries; lazy-sweeps expired records every 30s.
 */
function _createInMemoryIdempotencyStore({ maxEntries = 10000 } = {}) {
	/** @type {Map<string, { value: any, expiresAt: number }>} */
	const results = new Map();
	/** @type {Map<string, Promise<any>>} */
	const inflight = new Map();
	let lastSweep = runtimeNow();

	return {
		async acquire(key, ttlSec) {
			const now = runtimeNow();
			if (now - lastSweep >= 30000) {
				lastSweep = now;
				for (const [k, e] of results) {
					if (e.expiresAt <= now) results.delete(k);
				}
			}
			const cached = results.get(key);
			if (cached) {
				if (cached.expiresAt > now) return { result: cached.value };
				results.delete(key);
			}
			while (inflight.has(key)) {
				try { await inflight.get(key); } catch {}
				const re = results.get(key);
				if (re && re.expiresAt > runtimeNow()) return { result: re.value };
			}
			let resolveInflight;
			let rejectInflight;
			const promise = new Promise((res, rej) => { resolveInflight = res; rejectInflight = rej; });
			// Suppress unhandled-rejection logs when there are no waiters at the
			// moment a handler aborts. Real awaiters attach their own handlers
			// via `await inflight.get(key)`.
			promise.catch(() => {});
			inflight.set(key, promise);
			if (results.size >= maxEntries) {
				const drop = Math.max(1, Math.floor(maxEntries * 0.1));
				let i = 0;
				for (const k of results.keys()) {
					results.delete(k);
					if (++i >= drop) break;
				}
			}
			const ttlMs = ttlSec * 1000;
			return {
				acquired: true,
				async commit(value) {
					if (ttlMs > 0) results.set(key, { value, expiresAt: runtimeNow() + ttlMs });
					inflight.delete(key);
					if (resolveInflight) resolveInflight(value);
				},
				async abort() {
					inflight.delete(key);
					if (rejectInflight) rejectInflight(new Error('ABORTED'));
				}
			};
		}
	};
}

function _getDefaultIdempotencyStore() {
	if (_defaultIdempotencyStore) return _defaultIdempotencyStore;
	_defaultIdempotencyStore = _createInMemoryIdempotencyStore();
	return _defaultIdempotencyStore;
}

/**
 * Reset the default in-process idempotency store. Tests only.
 * @internal
 */
export function _resetIdempotencyStore() {
	_defaultIdempotencyStore = null;
}

/**
 * Per-key serialization primitive. Mirrors the algorithm in the adapter's
 * Lock plugin (per-key FIFO waiter queue) inline to preserve server.js's
 * no-imports profile. Custom Lock instances passed via `live.lock({ lock })`
 * just need to expose `withLock(key, fn, opts?)` matching the adapter's
 * contract.
 *
 * The `opts.maxWaitMs` field, when set, rejects a queued waiter with a typed
 * `LOCK_TIMEOUT` error if it does not acquire the lock within that many
 * milliseconds. The current holder is not interrupted; only the waiting
 * caller gives up. Subsequent waiters on the same key are unaffected and
 * continue in their original order (`advance` skips cancelled entries).
 *
 * @returns {{ withLock: <T>(key: string, fn: () => T | Promise<T>, opts?: { maxWaitMs?: number }) => Promise<T>, held: (key: string) => boolean, size: () => number, clear: () => void }}
 */
function _createInMemoryLock() {
	/**
	 * @typedef {Object} _Waiter
	 * @property {() => any | Promise<any>} fn
	 * @property {(value: any) => void} resolve
	 * @property {(err: Error) => void} reject
	 * @property {ReturnType<typeof setTimeout> | null} timer
	 * @property {boolean} cancelled
	 */
	/** @type {Map<string, { running: boolean, queue: Array<_Waiter> }>} */
	const states = new Map();

	function advance(key, state) {
		while (state.queue.length > 0) {
			const waiter = /** @type {_Waiter} */ (state.queue.shift());
			// lock.waiter invariant: every queued waiter has resolve+reject
			// captured at push time. Mismatch indicates corrupted queue state.
			assert(typeof waiter.resolve === 'function' && typeof waiter.reject === 'function', 'realtime/lock.waiter.shape', { hasResolve: typeof waiter.resolve === 'function', hasReject: typeof waiter.reject === 'function' });
			if (waiter.cancelled) continue;
			if (waiter.timer != null) {
				clearTimer(waiter.timer);
				waiter.timer = null;
			}
			runHead(key, state, waiter.fn).then(waiter.resolve, waiter.reject);
			return;
		}
		state.running = false;
		states.delete(key);
	}

	async function runHead(key, state, fn) {
		try {
			return await fn();
		} finally {
			advance(key, state);
		}
	}

	return {
		withLock(key, fn, opts) {
			if (typeof key !== 'string' || key.length === 0) {
				return Promise.reject(new Error('lock: key must be a non-empty string'));
			}
			if (typeof fn !== 'function') {
				return Promise.reject(new Error('lock: fn must be a function'));
			}
			const maxWaitMs = opts && opts.maxWaitMs;
			if (maxWaitMs != null) {
				if (typeof maxWaitMs !== 'number' || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
					return Promise.reject(new Error('lock: maxWaitMs must be a non-negative finite number'));
				}
			}

			let state = states.get(key);
			if (!state) {
				state = { running: false, queue: [] };
				states.set(key, state);
			}

			if (!state.running) {
				state.running = true;
				return runHead(key, state, fn);
			}

			return new Promise((resolve, reject) => {
				/** @type {_Waiter} */
				const waiter = { fn, resolve, reject, timer: null, cancelled: false };
				if (maxWaitMs != null) {
					waiter.timer = setTimer(() => {
						if (waiter.cancelled) return;
						waiter.cancelled = true;
						waiter.timer = null;
						const err = /** @type {Error & { code: string, key: string, maxWaitMs: number }} */ (
							new Error("lock: timed out after " + maxWaitMs + "ms waiting for key '" + key + "'")
						);
						err.code = 'LOCK_TIMEOUT';
						err.key = key;
						err.maxWaitMs = maxWaitMs;
						reject(err);
					}, maxWaitMs);
				}
				state.queue.push(waiter);
			});
		},
		held(key) { return states.has(key); },
		size() { return states.size; },
		clear() {
			for (const state of states.values()) {
				for (const waiter of state.queue) {
					if (waiter.cancelled) continue;
					waiter.cancelled = true;
					if (waiter.timer != null) {
						clearTimer(waiter.timer);
						waiter.timer = null;
					}
					const err = /** @type {Error & { code: string }} */ (new Error('lock: cleared'));
					err.code = 'LOCK_CLEARED';
					waiter.reject(err);
				}
			}
			states.clear();
		}
	};
}

/** @type {ReturnType<typeof _createInMemoryLock> | null} */
let _defaultLock = null;

function _getDefaultLock() {
	if (_defaultLock) return _defaultLock;
	_defaultLock = _createInMemoryLock();
	return _defaultLock;
}

/**
 * Reset the default in-process lock. Tests only.
 * @internal
 */
export function _resetLock() {
	if (_defaultLock) _defaultLock.clear();
	_defaultLock = null;
}

/**
 * Allowed config-object fields per wrapper. Kept in sync with the JSDoc of
 * each wrapper's config parameter; any unknown field at the call site
 * throws with a "did you mean..." hint mapped from `_*_CONFIG_HINTS`.
 *
 * Why this matters: `live.idempotent` uses `keyFrom` while `live.lock` uses
 * `key`; without unknown-field validation, a caller mirroring the other
 * helper's shape would silently fall through to the default code path
 * (idempotent: no key -> bypass cache; lock: no key -> different error).
 * Either way the caller's intended one-per-key guarantee silently breaks.
 * The hint table converts a 20-min debug into a 2-second eye-scan.
 */
const _IDEMPOTENT_CONFIG_FIELDS = ['keyFrom', 'store', 'ttl'];
const _IDEMPOTENT_CONFIG_HINTS = {
	key: "live.lock uses 'key' but live.idempotent uses 'keyFrom' (the names diverged historically)"
};
const _LOCK_CONFIG_FIELDS = ['key', 'lock', 'maxWaitMs'];
const _LOCK_CONFIG_HINTS = {
	keyFrom: "live.idempotent uses 'keyFrom' but live.lock uses 'key' (which accepts a string OR a function)"
};

/**
 * Throw on any field in `cfg` not in `allowed`. Suggestions from `hints`
 * (when present) include a one-line cross-helper note for the common
 * "I mirrored the wrong helper's shape" case.
 *
 * @param {string} helperName e.g. 'live.idempotent'
 * @param {Record<string, any>} cfg The user's config object.
 * @param {string[]} allowed
 * @param {Record<string, string>} hints
 */
function _assertConfigShape(helperName, cfg, allowed, hints) {
	for (const k of Object.keys(cfg)) {
		if (allowed.includes(k)) continue;
		const hint = hints[k];
		const suffix = hint ? ' Hint: ' + hint + '.' : '';
		throw new Error(
			'[svelte-realtime] ' + helperName + ": unknown config field '" + k +
			"'. Allowed: " + allowed.join(', ') + '.' + suffix
		);
	}
}

/**
 * Wrap an RPC handler with idempotency: identical calls (by key) return the
 * cached result without re-running the handler. Composes with live(),
 * live.validated(), live.rateLimit(), etc.
 *
 * The key is derived from `config.keyFrom(ctx, ...args)` if provided, otherwise
 * from the client envelope's `idempotencyKey` (set via the client's
 * `rpc.with({ idempotencyKey })` helper). When neither is present, the call
 * runs as if the wrapper were absent.
 *
 * Only successful results are cached. A throwing handler aborts the slot so
 * the next caller re-runs.
 *
 * Default store is in-process (bounded). For multi-instance deployments,
 * pass `store: createIdempotencyStore(redis)` from svelte-adapter-uws-extensions.
 *
 * @param {{ keyFrom?: (ctx: any, ...args: any[]) => string | null | undefined, store?: { acquire: (key: string, ttlSec: number) => Promise<any> }, ttl?: number }} config
 * @param {Function} fn Handler function (ctx, ...args)
 * @returns {Function}
 */
const _liveIdempotent = function idempotent(config, fn) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.idempotent(config, fn) requires a handler function');
	}
	const cfg = config || {};
	_assertConfigShape('live.idempotent', cfg, _IDEMPOTENT_CONFIG_FIELDS, _IDEMPOTENT_CONFIG_HINTS);
	if (cfg.keyFrom !== undefined && typeof cfg.keyFrom !== 'function') {
		throw new Error('[svelte-realtime] live.idempotent: keyFrom must be a function');
	}
	if (cfg.store !== undefined && (cfg.store === null || typeof cfg.store.acquire !== 'function')) {
		throw new Error('[svelte-realtime] live.idempotent: store must implement acquire(key, ttlSec)');
	}
	if (cfg.ttl !== undefined && (typeof cfg.ttl !== 'number' || cfg.ttl < 0)) {
		throw new Error('[svelte-realtime] live.idempotent: ttl must be a non-negative number of seconds');
	}
	const ttlSec = typeof cfg.ttl === 'number' ? cfg.ttl : 172800;
	const keyFrom = cfg.keyFrom || null;
	const customStore = cfg.store || null;

	const wrapper = async function idempotentWrapper(ctx, ...args) {
		const userKey = keyFrom ? keyFrom(ctx, ...args) : ctx._idempotencyKey;
		if (!userKey) return fn(ctx, ...args);
		// Cap key length at 256 bytes - matches isValidWireTopic and
		// keeps the cache key from growing into a per-attacker memory
		// pressure or a Redis/Postgres B-tree depth amplifier.
		if (typeof userKey !== 'string' || userKey.length > 256) {
			throw new LiveError(
				'INVALID_REQUEST',
				'idempotencyKey must be a string no longer than 256 characters'
			);
		}
		// Namespace the cache key by registered RPC path so the same
		// userKey across different RPCs lands in different slots, then by the
		// connection's tenant (when one is resolved) so the same key under two
		// tenants can NEVER share a slot - the framework auto-scopes the security
		// boundary; the app's keyFrom no longer has to encode the tenant. The
		// tenant segment is first and `\0`-delimited (a validated tenant id has no
		// `\0`), so it stays unambiguous. Null tenant -> unchanged.
		const path = /** @type {any} */ (wrapper).__idempotencyPath;
		const key = _tenantKey(ctx.tenantId, path ? 'rpc:' + path + ':' + userKey : userKey);
		const store = customStore || _getDefaultIdempotencyStore();
		const slot = await store.acquire(key, ttlSec);
		if (slot && slot.acquired) {
			try {
				const data = await fn(ctx, ...args);
				await slot.commit(data);
				return data;
			} catch (err) {
				try { await slot.abort(); } catch {}
				throw err;
			}
		}
		if (slot && slot.pending) {
			throw new LiveError('CONFLICT', 'A request with this idempotency key is already in progress');
		}
		return slot.result;
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isIdempotent = true;
	/** @type {any} */ (wrapper).__idempotency = { keyFrom, store: customStore, ttl: ttlSec };
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Wrap an RPC handler with per-key serialization. Concurrent calls that
 * resolve to the same lock key run one at a time in FIFO order; calls on
 * different keys run in parallel. Composes with `live()`,
 * `live.validated()`, `live.idempotent()`, etc.
 *
 * The key is derived per-call: pass a string for a static lock, or a
 * function `(ctx, ...args) => string | null | undefined` to derive it
 * from the caller's context. A null / undefined key bypasses the lock
 * (the handler runs unguarded for that call).
 *
 * Default lock is in-process and bounded only by your active key set.
 * For multi-instance deployments, pass `lock: createDistributedLock(...)`
 * from `svelte-adapter-uws-extensions/redis/lock`. Any object that
 * exposes `withLock(key, fn, opts?)` matching the adapter's Lock contract
 * works.
 *
 * Pass `maxWaitMs` (in the config-object form) to bound how long a queued
 * caller will wait before giving up. On timeout, the wrapper rejects with
 * `LiveError('LOCK_TIMEOUT', ...)` so the client receives a typed error
 * with `.code === 'LOCK_TIMEOUT'`. The current holder's handler is not
 * interrupted; only the waiting caller gives up. Subsequent waiters on
 * the same key are unaffected and continue in their original order.
 *
 * Use for cron-ish triggers, expensive recompute, single-flight cache
 * fills, and atomic read-modify-write on shared records.
 *
 * @example
 * ```js
 * export const recomputeLeaderboard = live.lock(
 *   (ctx) => `leaderboard:${ctx.user.organization_id}`,
 *   async (ctx) => {
 *     const rows = await db.expensive.recompute(ctx.user.organization_id);
 *     ctx.publish(`org:${ctx.user.organization_id}:leaderboard`, 'set', rows);
 *     return rows;
 *   }
 * );
 * ```
 *
 * @example
 * ```js
 * // Bounded wait: clients calling while the lock is busy give up after 5s
 * // with LiveError('LOCK_TIMEOUT') instead of waiting indefinitely.
 * export const settleInvoice = live.lock(
 *   { key: (ctx, id) => `invoice:${id}`, maxWaitMs: 5000 },
 *   async (ctx, id) => settle(id)
 * );
 * ```
 *
 * @param {string | ((ctx: any, ...args: any[]) => string | null | undefined) | { key: string | ((ctx: any, ...args: any[]) => string | null | undefined), lock?: { withLock: (key: string, fn: () => any, opts?: { maxWaitMs?: number }) => Promise<any> }, maxWaitMs?: number }} keyOrConfig
 * @param {Function} fn Handler function (ctx, ...args)
 * @returns {Function}
 */
const _liveLock = function lock(keyOrConfig, fn) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.lock(keyOrConfig, fn) requires a handler function');
	}
	let keyFrom;
	let customLock = null;
	let maxWaitMs;
	if (typeof keyOrConfig === 'string') {
		const staticKey = keyOrConfig;
		if (staticKey.length === 0) {
			throw new Error('[svelte-realtime] live.lock: key string must be non-empty');
		}
		keyFrom = () => staticKey;
	} else if (typeof keyOrConfig === 'function') {
		keyFrom = keyOrConfig;
	} else if (keyOrConfig && typeof keyOrConfig === 'object') {
		const cfg = keyOrConfig;
		_assertConfigShape('live.lock', cfg, _LOCK_CONFIG_FIELDS, _LOCK_CONFIG_HINTS);
		if (typeof cfg.key === 'string') {
			const staticKey = cfg.key;
			if (staticKey.length === 0) {
				throw new Error('[svelte-realtime] live.lock: key string must be non-empty');
			}
			keyFrom = () => staticKey;
		} else if (typeof cfg.key === 'function') {
			keyFrom = cfg.key;
		} else {
			throw new Error('[svelte-realtime] live.lock: config.key must be a string or function');
		}
		if (cfg.lock !== undefined) {
			if (!cfg.lock || typeof cfg.lock.withLock !== 'function') {
				throw new Error('[svelte-realtime] live.lock: lock must implement withLock(key, fn)');
			}
			customLock = cfg.lock;
		}
		if (cfg.maxWaitMs !== undefined) {
			if (typeof cfg.maxWaitMs !== 'number' || !Number.isFinite(cfg.maxWaitMs) || cfg.maxWaitMs < 0) {
				throw new Error('[svelte-realtime] live.lock: maxWaitMs must be a non-negative finite number');
			}
			maxWaitMs = cfg.maxWaitMs;
		}
	} else {
		throw new Error('[svelte-realtime] live.lock: first argument must be a key string, key function, or config object');
	}

	const lockOpts = maxWaitMs != null ? { maxWaitMs } : undefined;

	const wrapper = async function lockedWrapper(ctx, ...args) {
		const rawKey = keyFrom(ctx, ...args);
		if (rawKey == null || rawKey === '') return fn(ctx, ...args);
		if (typeof rawKey !== 'string') {
			throw new Error('[svelte-realtime] live.lock: key resolver must return a string (or null/undefined to bypass)');
		}
		// Tenant-scope the lock key so two tenants whose resolvers return the same
		// string (e.g. 'leaderboard') hold INDEPENDENT locks - the framework owns
		// the isolation, not app discipline. Null tenant -> unchanged.
		const key = _tenantKey(ctx.tenantId, rawKey);
		const lockInst = customLock || _getDefaultLock();
		try {
			return await lockInst.withLock(key, () => fn(ctx, ...args), lockOpts);
		} catch (err) {
			if (err && /** @type {any} */ (err).code === 'LOCK_TIMEOUT' && !(err instanceof LiveError)) {
				const wrapped = new LiveError('LOCK_TIMEOUT', /** @type {Error} */ (err).message);
				/** @type {any} */ (wrapped).key = /** @type {any} */ (err).key;
				/** @type {any} */ (wrapped).maxWaitMs = /** @type {any} */ (err).maxWaitMs;
				throw wrapped;
			}
			throw err;
		}
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isLocked = true;
	/** @type {any} */ (wrapper).__lockConfig = { keyFrom, lock: customLock, maxWaitMs };
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

export function installIdempotency(live) {
	live.idempotent = _liveIdempotent;
	live.lock = _liveLock;
}
