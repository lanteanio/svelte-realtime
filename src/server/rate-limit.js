// @ts-check
import { now as runtimeNow } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _getIdentityKey } from './identity.js';
import { _rateLimits } from './state.js';

/** @type {number} */
let _rateLimitLastSweep = runtimeNow();

/** Hard cap on rate limit buckets to prevent memory exhaustion */
const _RATE_LIMIT_MAX = 5000;

/**
 * Sliding-window rate-limit bucket consume. Mutates the shared `_rateLimits` map.
 * Returns `{ ok: true }` on accept, `{ ok: false, retryAfter }` on reject.
 * Throws `LiveError('RATE_LIMITED', ...)` only when bucket-cap is exhausted
 * (memory-pressure escape hatch). Shared by per-handler `live.rateLimit` and
 * registry `live.rateLimits` configs.
 *
 * @param {string} bucketKey
 * @param {number} points
 * @param {number} windowMs
 * @returns {{ ok: boolean, retryAfter?: number }}
 */
export function _consumeRateLimitBucket(bucketKey, points, windowMs) {
	const now = runtimeNow();

	// Lazy sweep: prune stale entries every 30s, sweep all entries
	if (now - _rateLimitLastSweep > 30000) {
		_rateLimitLastSweep = now;
		for (const [k, bucket] of _rateLimits) {
			if (now - bucket.windowStart >= bucket.windowMs * 2) {
				_rateLimits.delete(k);
			}
		}
	}

	let bucket = _rateLimits.get(bucketKey);

	// Hard cap on new buckets only - existing identities always pass through
	if (!bucket && _rateLimits.size >= _RATE_LIMIT_MAX) {
		for (const [k, b] of _rateLimits) {
			if (now - b.windowStart >= b.windowMs * 2) _rateLimits.delete(k);
		}
		if (_rateLimits.size >= _RATE_LIMIT_MAX) {
			throw new LiveError('RATE_LIMITED', 'Too many concurrent rate-limit identities');
		}
	}
	if (!bucket) {
		bucket = { prev: 0, curr: 0, windowStart: now, windowMs };
		_rateLimits.set(bucketKey, bucket);
	}

	// Rotate windows if needed
	const elapsed = now - bucket.windowStart;
	if (elapsed >= windowMs * 2) {
		bucket.prev = 0;
		bucket.curr = 0;
		bucket.windowStart = now;
	} else if (elapsed >= windowMs) {
		bucket.prev = bucket.curr;
		bucket.curr = 0;
		bucket.windowStart += windowMs;
	}

	// Estimate count in sliding window using weighted average
	const windowElapsed = now - bucket.windowStart;
	const weight = Math.max(0, 1 - windowElapsed / windowMs);
	const estimated = bucket.prev * weight + bucket.curr;

	if (estimated >= points) {
		return { ok: false, retryAfter: Math.ceil(windowMs - windowElapsed) };
	}

	bucket.curr++;
	return { ok: true };
}

/**
 * Wraps a live() function with a sliding window rate limiter.
 *
 * @param {{ points: number, window: number, key?: (ctx: any) => string }} config
 * @param {Function} fn - Handler function (ctx, ...args)
 * @returns {Function}
 */
const _liveRateLimit = function rateLimit(config, fn) {
	const { points, window: windowMs } = config;
	const keyFn = config.key || ((ctx) => _getIdentityKey(ctx));

	const wrapper = async function rateLimitedWrapper(ctx, ...args) {
		const userKey = keyFn(ctx);
		const bucketKey = /** @type {any} */ (wrapper).__rateLimitPath + '\0' + userKey;
		const result = _consumeRateLimitBucket(bucketKey, points, windowMs);
		if (!result.ok) {
			const err = new LiveError('RATE_LIMITED', 'Too many requests');
			/** @type {any} */ (err).retryAfter = result.retryAfter;
			throw err;
		}
		return fn(ctx, ...args);
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isRateLimited = true;
	/** @type {any} */ (wrapper).__rateLimitPath = '';
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Registry-level rate-limit config: default applies to every RPC path that
 * doesn't have a per-handler `live.rateLimit(...)` wrapper, with per-path
 * overrides and per-path opt-outs. Stream subscribes are not rate-limited
 * by this primitive.
 *
 * @type {{ default: { points: number, window: number } | null, overrides: Map<string, { points: number, window: number }>, exempt: Set<string> } | null}
 */
export let _rateLimitConfig = null;

/**
 * Configure registry-level rate limits. Pass `null` to clear.
 *
 * @example
 * live.rateLimits({
 *   default: { points: 200, window: 10_000 },
 *   overrides: {
 *     'chat/sendMessage': { points: 50, window: 10_000 },
 *     'orders/create':    { points: 5,  window: 60_000 }
 *   },
 *   exempt: ['presence/moveCursor', 'cursor/move']
 * });
 *
 * Resolution order (per RPC call):
 *   1. Path is in `exempt` -> no rate limit.
 *   2. Path has a per-handler `live.rateLimit(...)` wrapping -> per-handler
 *      rule applies (this registry is bypassed entirely for that path).
 *   3. Path is in `overrides` -> override config applies.
 *   4. `default` is set -> default applies.
 *   5. Otherwise -> no rate limit.
 *
 * @param {{ default?: { points: number, window: number } | null, overrides?: Record<string, { points: number, window: number }>, exempt?: string[] } | null} config
 */
const _liveRateLimits = function rateLimits(config) {
	if (config === null) {
		_rateLimitConfig = null;
		return;
	}
	if (!config || typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.rateLimits: config must be an object or null');
	}
	const validateRule = (rule, label) => {
		if (!rule || typeof rule !== 'object') throw new Error(`[svelte-realtime] live.rateLimits: ${label} must be an object`);
		if (typeof rule.points !== 'number' || rule.points <= 0) throw new Error(`[svelte-realtime] live.rateLimits: ${label}.points must be a positive number`);
		if (typeof rule.window !== 'number' || rule.window <= 0) throw new Error(`[svelte-realtime] live.rateLimits: ${label}.window must be a positive number (ms)`);
	};
	const def = config.default ? { points: config.default.points, window: config.default.window } : null;
	if (def) validateRule(def, 'default');
	const overrides = new Map();
	if (config.overrides) {
		if (typeof config.overrides !== 'object') throw new Error('[svelte-realtime] live.rateLimits: overrides must be an object keyed by path');
		for (const [path, rule] of Object.entries(config.overrides)) {
			validateRule(rule, `overrides[${path}]`);
			overrides.set(path, { points: rule.points, window: rule.window });
		}
	}
	const exempt = new Set();
	if (config.exempt) {
		if (!Array.isArray(config.exempt)) throw new Error('[svelte-realtime] live.rateLimits: exempt must be an array of paths');
		for (const p of config.exempt) {
			if (typeof p !== 'string') throw new Error('[svelte-realtime] live.rateLimits: exempt entries must be strings');
			exempt.add(p);
		}
	}
	_rateLimitConfig = { default: def, overrides, exempt };
};

/**
 * Resolve the registry-level rate-limit rule for a given path, or null if none.
 * Returns null if the path is exempt OR no default/override is configured.
 * Caller is responsible for skipping when the handler has its own per-handler
 * rate-limit wrapper (`fn.__isRateLimited`).
 * @param {string} path
 * @returns {{ points: number, window: number } | null}
 */
export function _resolveRegistryRateLimit(path) {
	if (!_rateLimitConfig) return null;
	if (_rateLimitConfig.exempt.has(path)) return null;
	const override = _rateLimitConfig.overrides.get(path);
	if (override) return override;
	return _rateLimitConfig.default;
}

/** Test-only reset of the registry rate-limit config. */
export function _resetRateLimits() {
	_rateLimitConfig = null;
	_rateLimits.clear();
}

export function installRateLimit(live) {
	live.rateLimit = _liveRateLimit;
	live.rateLimits = _liveRateLimits;
}
