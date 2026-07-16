// @ts-check
import { now as runtimeNow, monotonicNow, setTimer, clearTimer } from '../shared/runtime.js';
import { assert } from '../shared/assert.js';
import { LiveError } from './live-error.js';
import { _tenantKey } from './tenant.js';
import { _getAuthenticatedId } from './identity.js';
import { createHash } from 'node:crypto';

// Reserved keys for the cached-value envelope that carries the request
// fingerprint. The read path detects the envelope by `_FP` being a string, so
// the key is deliberately namespaced and uncommon; a user result that uses this
// exact key would be treated as the envelope.
const _FP = '__srk_idem_fp';
const _VAL = '__srk_idem_v';

// Forget-tombstone grace window (ms). A commit is dropped when its slot was
// acquired at-or-before the user's last purge PLUS this window - not merely
// at-or-before it. Acquire and purge times are sub-ms MONOTONIC stamps, so
// without an explicit grace a duplicate re-acquiring microseconds after the
// purge would slip past and re-cache the erased user. 1000ms reproduces the
// coarse ~1s over-drop the old 1Hz cached-wall clock produced implicitly (a
// duplicate re-acquiring within the same wall tick as the purge was dropped).
const _IDEMPOTENCY_FORGET_GRACE_MS = 1000;

/**
 * Deterministic stable serialization: object keys sorted recursively so two
 * payloads differing only in key order fingerprint identically. Wire args are
 * JSON values, so only JSON types appear.
 * @param {any} v
 * @returns {string}
 */
function _stableStringify(v) {
	if (v === null || typeof v !== 'object') {
		const s = JSON.stringify(v);
		return s === undefined ? 'null' : s;
	}
	if (Array.isArray(v)) {
		let out = '[';
		for (let i = 0; i < v.length; i++) out += (i ? ',' : '') + _stableStringify(v[i]);
		return out + ']';
	}
	const keys = Object.keys(v).sort();
	let out = '{';
	for (let i = 0; i < keys.length; i++) {
		if (i) out += ',';
		out += JSON.stringify(keys[i]) + ':' + _stableStringify(v[keys[i]]);
	}
	return out + '}';
}

/**
 * Fingerprint the request args so a replayed idempotency key carrying a
 * DIFFERENT payload is caught (a typed error) instead of silently returning the
 * first request's cached result. A correctness guard, not a security boundary:
 * the slot key is already namespaced by RPC path + tenant, plus the caller's
 * authenticated identity on the envelope path (see the key construction below).
 * Best-effort - an args shape that cannot be canonically serialized returns null
 * and the check is skipped.
 * @param {any[]} args
 * @returns {string | null}
 */
function _fingerprintArgs(args) {
	try {
		return createHash('sha256').update(_stableStringify(args)).digest('hex').slice(0, 32);
	} catch {
		return null;
	}
}

/**
 * Non-privileged, stable fingerprint of a caller's authenticated identity, folded
 * into the cache key so a client-supplied idempotency key cannot become an
 * authz-bypass. Hashed (not the raw id) so the user id never lands in a Redis /
 * Postgres key or a slow-log; fixed length so the key budget is bounded. A string
 * input cannot make `createHash` throw, so this always returns a segment for an
 * authenticated user (fail-closed: identity scoping is never silently skipped).
 * @param {string} id
 * @returns {string}
 */
function _fingerprintIdentity(id) {
	return createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
}

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
	// Right-to-erasure reverse index. Idempotency cache keys are opaque
	// (RPC path + tenant + a sha256 identity fingerprint), so `live.forget`
	// cannot find a user's keys by substring without risking a collision miss
	// or an over-delete - a security hole. Instead the store records, for each
	// committed key, the tenant-scoped user key it belongs to (supplied by the
	// caller via `acquire`'s `meta.user`), so forget can drop exactly that
	// user's entries. The inverse map keeps every single-key drop (sweep,
	// maxEntries eviction, commit, abort) O(1) so the index never leaks
	// references to already-evicted keys.
	/** @type {Map<string, Set<string>>} tenant-scoped user key -> cache keys */
	const userKeys = new Map();
	/** @type {Map<string, string>} cache key -> tenant-scoped user key */
	const keyUser = new Map();
	// Forget tombstones: the most recent purge time per tenant-scoped user key,
	// stamped in MONOTONIC time (step-immune, sub-ms). A slot acquired at-or-before
	// its user's last purge (plus the grace window) must NOT cache on commit
	// - otherwise an idempotent RPC that was already in flight when `live.forget`
	// ran would re-cache the forgotten user's freshly-computed result for the
	// full TTL (a residual-PII window invisible to a purge that scans only
	// already-committed keys). Monotonic time closes an NTP-backward-step hole a
	// wall stamp carried: a backward wall step could drag the purge time below the
	// in-flight acquire time and let the commit through. The explicit grace window
	// reproduces the coarse ~1s over-drop the old cached-wall clock gave implicitly
	// (a duplicate re-acquiring in the same wall tick as the purge was dropped),
	// now that both stamps are sub-ms. Swept with the 30s result sweep so the map
	// stays bounded to recent erasures.
	/** @type {Map<string, number>} tenant-scoped user key -> last purge monotonic ms */
	const purgedAt = new Map();
	let lastSweep = runtimeNow();

	function _indexAdd(cacheKey, idemUser) {
		if (!idemUser) return;
		keyUser.set(cacheKey, idemUser);
		let set = userKeys.get(idemUser);
		if (!set) { set = new Set(); userKeys.set(idemUser, set); }
		set.add(cacheKey);
	}
	function _indexDrop(cacheKey) {
		const idemUser = keyUser.get(cacheKey);
		if (idemUser === undefined) return;
		keyUser.delete(cacheKey);
		const set = userKeys.get(idemUser);
		if (set) { set.delete(cacheKey); if (set.size === 0) userKeys.delete(idemUser); }
	}

	return {
		async acquire(key, ttlSec, meta) {
			const now = runtimeNow();
			// Snapshot the acquire time at ARRIVAL (MONOTONIC), before the inflight
			// wait loop below. A duplicate that parks waiting for an in-flight sibling
			// must keep its true arrival time as `acquiredAt`: if it re-stamped after
			// the wait, a duplicate that arrived BEFORE a concurrent live.forget but
			// re-ran after it (once the racing sibling was dropped) would slip past the
			// tombstone drop and re-cache the erased user. Reading it here, next to the
			// wall `now`, mirrors how the dead-letter store threads its true start time.
			const acquiredAt = monotonicNow();
			if (now - lastSweep >= 30000) {
				lastSweep = now;
				for (const [k, e] of results) {
					if (e.expiresAt <= now) { results.delete(k); _indexDrop(k); }
				}
				// Drop tombstones older than the sweep window: any slot that was
				// in flight across a purge has long since committed, so the
				// tombstone has done its job and a new request may cache again.
				// Tombstone times are MONOTONIC, so age them against monotonicNow()
				// (never the wall `now` above - mixing domains would mis-drop a
				// tombstone across an NTP step).
				const monoCutoff = monotonicNow() - 30000;
				for (const [u, t] of purgedAt) {
					if (t < monoCutoff) purgedAt.delete(u);
				}
			}
			const cached = results.get(key);
			if (cached) {
				if (cached.expiresAt > now) return { result: cached.value };
				results.delete(key);
				_indexDrop(key);
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
					_indexDrop(k);
					if (++i >= drop) break;
				}
			}
			// The tenant-scoped user key this committed result belongs to, if the
			// caller is authenticated (forget reverse index). Anonymous calls pass
			// no user and stay unindexed. `meta` carries the raw { user, tenant } so
			// a durable backend can denormalize them into separate columns; the
			// in-memory index folds them into one key matching live.forget.
			const idemUser = meta && typeof meta.user === 'string' ? _tenantKey(meta.tenant, meta.user) : null;
			const ttlMs = ttlSec * 1000;
			return {
				acquired: true,
				async commit(value) {
					// Drop the cache write if this user was purged at-or-after this
					// slot was acquired (within the grace window): the request was in
					// flight when live.forget ran, so caching its result would
					// resurrect the forgotten user. Both stamps are MONOTONIC so a
					// backward wall step cannot let the commit through; the grace
					// window also drops a duplicate that re-acquires just after the
					// purge, matching the old cached-wall over-drop.
					const tomb = idemUser !== null ? purgedAt.get(idemUser) : undefined;
					const forgotten = tomb !== undefined && tomb + _IDEMPOTENCY_FORGET_GRACE_MS >= acquiredAt;
					if (ttlMs > 0 && !forgotten) {
						results.set(key, { value, expiresAt: runtimeNow() + ttlMs });
						_indexAdd(key, idemUser);
					}
					inflight.delete(key);
					if (resolveInflight) resolveInflight(value);
				},
				async abort() {
					inflight.delete(key);
					_indexDrop(key);
					if (rejectInflight) rejectInflight(new Error('ABORTED'));
				}
			};
		},
		/**
		 * Right-to-erasure: drop every cached + in-flight entry recorded under a
		 * tenant-scoped user key. Returns the number of cached results removed.
		 * @param {string} idemUser tenant-scoped user key (`_tenantKey(tenantId, userId)`)
		 * @returns {number}
		 */
		purgeUser(idemUser) {
			// Tombstone first: any commit for this user that races this purge (a
			// request already in flight when forget ran) is dropped on commit, so
			// it cannot re-cache the erased user. Recorded even when the user has
			// no committed keys yet - the in-flight request may commit moments later.
			// MONOTONIC (step-immune, sub-ms): a backward wall step could otherwise
			// stamp the purge below an in-flight acquire and let the commit through,
			// re-caching the erased user's PII for the full TTL.
			purgedAt.set(idemUser, monotonicNow());
			const set = userKeys.get(idemUser);
			if (!set) return 0;
			let n = 0;
			for (const k of set) {
				if (results.delete(k)) n++;
				inflight.delete(k);
				keyUser.delete(k);
			}
			userKeys.delete(idemUser);
			return n;
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
 * Right-to-erasure for the default in-process idempotency store: drop every
 * cached + in-flight entry recorded under a tenant-scoped user key. No-op when
 * no default store has been created yet, or when the active store predates the
 * reverse index (a custom/durable store handles its own erasure through the
 * `live.forget` store seam). Called by the forget descriptor table.
 * @param {string} idemUser tenant-scoped user key (`_tenantKey(tenantId, userId)`)
 * @returns {number} cached results removed
 * @internal
 */
export function _purgeIdempotencyUser(idemUser) {
	const store = /** @type {any} */ (_defaultIdempotencyStore);
	if (!store || typeof store.purgeUser !== 'function') return 0;
	return store.purgeUser(idemUser);
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
 * The cache slot is automatically isolated by RPC path and by the connection's
 * tenant, so the same key across different RPCs or tenants never collides. When
 * the key comes from the client ENVELOPE (no `keyFrom`), it is ALSO isolated by
 * the caller's authenticated identity, so one user can never receive another
 * user's cached result by sending the same key - a client-controlled key is not
 * an authz bypass. The `keyFrom` path is app-owned: encode `ctx.user` into the
 * returned key yourself for per-user idempotency, or omit it for a deliberately
 * shared slot. Anonymous callers are not identity-scoped (the key is used as-is).
 *
 * Only successful results are cached. A throwing handler aborts the slot so
 * the next caller re-runs. Reusing the same key with a DIFFERENT request
 * payload throws `LiveError('IDEMPOTENCY_KEY_REUSED')` rather than silently
 * returning the first call's result (a true idempotent retry must carry the
 * same body); the framework fingerprints the request args to detect this.
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
		// Identity-scope the CLIENT-SUPPLIED envelope key (the keyFrom path is
		// app-owned - the app encodes identity there if it wants per-user, and a
		// deliberately shared key must keep working). The client controls the
		// envelope key, so two different users sending the SAME key under the same
		// RPC + tenant would otherwise collide in one slot and the second caller
		// would receive the first's cached result - a cross-user leak / authz
		// bypass. Folding a non-privileged fingerprint of the authenticated user id
		// into the key gives each user their own slot, structurally. Anonymous
		// callers (no authenticated id) are unchanged - a constant segment, so a
		// client-random key still dedupes as before; a deliberately shared key
		// across anonymous users stays the app's concern. Legacy entries (old key
		// shape) cold-miss once and age out.
		// The caller's authenticated identity (null for anonymous). Folded into
		// the envelope key for per-user slotting (below) and recorded under the
		// user for `live.forget` right-to-erasure (further down).
		const uid = _getAuthenticatedId(ctx);
		let scopedKey = userKey;
		if (!keyFrom && uid !== null) {
			scopedKey = _fingerprintIdentity(uid) + '\0' + userKey;
		}
		// Namespace the cache key by registered RPC path so the same
		// userKey across different RPCs lands in different slots, then by the
		// connection's tenant (when one is resolved) so the same key under two
		// tenants can NEVER share a slot - the framework auto-scopes the security
		// boundary; the app's keyFrom no longer has to encode the tenant. The
		// tenant segment is first and `\0`-delimited (a validated tenant id has no
		// `\0`), so it stays unambiguous. Null tenant -> unchanged.
		const path = /** @type {any} */ (wrapper).__idempotencyPath;
		const key = _tenantKey(ctx.tenantId, path ? 'rpc:' + path + ':' + scopedKey : scopedKey);
		// Fingerprint the request payload so a replayed key carrying a DIFFERENT
		// body is rejected, not silently answered with the first call's result.
		const fp = _fingerprintArgs(args);
		const store = customStore || _getDefaultIdempotencyStore();
		// Pass the raw (user, tenant) so the store can record this entry under the
		// user for live.forget right-to-erasure - the in-memory store folds them
		// into a key matching `_tenantKey(tenantId, userId)`, a durable backend
		// denormalizes them into columns. Anonymous callers pass nothing.
		const slot = await store.acquire(key, ttlSec, uid !== null ? { user: uid, tenant: ctx.tenantId } : undefined);
		if (slot && slot.acquired) {
			let data;
			try {
				data = await fn(ctx, ...args);
			} catch (err) {
				// PRE-COMMIT handler failure: nothing was recorded, so release the
				// slot and let a legitimate retry run the handler again.
				try { await slot.abort(); } catch {}
				throw err;
			}
			// Handler succeeded; its effect has run. A commit failure now is
			// AMBIGUOUS - the store may have durably applied the record and only
			// lost the acknowledgement, or it may have rejected before writing.
			// Aborting here would delete a possibly-committed record and let a
			// retry re-run the handler and DOUBLE-APPLY the effect, so the commit
			// is deliberately OUTSIDE the abort scope. The slot is left intact for
			// the store to reconcile, and the caller gets a typed
			// IDEMPOTENCY_COMMIT_UNKNOWN so it reconciles rather than blindly retrying.
			try {
				// Wrap the result with its request fingerprint (skipped only when the
				// args could not be serialized). The envelope is opaque to the store
				// and is unwrapped before it ever reaches the caller.
				await slot.commit(fp != null ? { [_FP]: fp, [_VAL]: data } : data);
			} catch (err) {
				const unknown = new LiveError(
					'IDEMPOTENCY_COMMIT_UNKNOWN',
					'the idempotency record could not be confirmed committed after the handler ran; the effect may have applied - reconcile before retrying rather than re-running'
				);
				/** @type {any} */ (unknown).cause = err;
				throw unknown;
			}
			return data;
		}
		if (slot && slot.pending) {
			throw new LiveError('CONFLICT', 'A request with this idempotency key is already in progress');
		}
		const cached = slot.result;
		if (cached !== null && typeof cached === 'object' && typeof (/** @type {any} */ (cached)[_FP]) === 'string') {
			if (fp != null && /** @type {any} */ (cached)[_FP] !== fp) {
				throw new LiveError(
					'IDEMPOTENCY_KEY_REUSED',
					'idempotency key reused with a different request payload; the same key must always carry the same request'
				);
			}
			return (/** @type {any} */ (cached))[_VAL];
		}
		// Legacy/raw cached value (a pre-upgrade entry, a store that does not
		// round-trip the envelope, or unserializable args): return as-is.
		return cached;
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
