// @ts-check

/**
 * Injectable runtime environment for the clock, RNG, and timers - browser build.
 *
 * Browser client code reads time, randomness, and schedules timers exclusively
 * through the named helpers exported here instead of touching `Date.now`,
 * `Math.random`, `crypto`, or `setTimeout` directly. The helper names and the
 * environment shape are kept byte-identical with the node `shared/runtime.js`
 * copy so the two never drift and callers are interchangeable. The difference is
 * the binding: this copy is backed entirely by browser globals (no `node:`
 * imports), so it bundles cleanly for the browser, while a controlled simulation
 * harness running the same client code under node can still swap in seeded
 * virtual implementations via `setRuntimeEnv`.
 *
 * In production the helpers bind the native globals with zero measurable
 * overhead: one read over a frozen, never-swapped environment object that V8
 * keeps monomorphic and inlines straight through to the native calls.
 *
 * @module svelte-realtime/client-runtime
 */

// The browser clock is a direct wall read: the clients never had a 1Hz cache,
// so reading `Date.now()` per call preserves their existing behavior (and lets a
// test's fake-timer Date mock propagate directly). `performance.now()` drives
// monotonic duration math when present, falling back to the wall clock when not.
const _hasPerf = typeof globalThis.performance !== 'undefined' && typeof globalThis.performance.now === 'function';
const _processStartEpoch = _hasPerf ? Date.now() - globalThis.performance.now() : 0;
const _webcrypto = (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : undefined;

// v4-shaped fallback when Web Crypto randomUUID is unavailable (non-secure
// context / old browser). Uses the env RNG so a seeded run still reproduces it.
function _uuidFallback(rngFloat) {
	let out = '';
	for (let i = 0; i < 36; i++) {
		if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
		if (i === 14) { out += '4'; continue; }
		const r = (rngFloat() * 16) | 0;
		out += (i === 19 ? ((r & 0x3) | 0x8) : r).toString(16);
	}
	return out;
}

// One frozen environment object, one stable hidden class. In production
// `current === defaultEnv` for the whole page lifetime (no override ever
// installs), so V8 sees a monomorphic shape and inlines the helpers to the
// native primitives - zero measurable overhead on the hot path.
const defaultEnv = Object.freeze({
	clock: Object.freeze({
		now: () => Date.now(),                                                  // wall, direct read
		monotonic: _hasPerf ? () => _processStartEpoch + globalThis.performance.now() : () => Date.now(), // strictly-forward duration math
		wallEpoch: () => Date.now()                                             // exact wall clock; identity baseline
	}),
	rng: Object.freeze({
		float: () => Math.random(),
		u32: () => (Math.random() * 0x100000000) >>> 0,
		uuid: (_webcrypto && typeof _webcrypto.randomUUID === 'function')
			? () => _webcrypto.randomUUID()
			: () => _uuidFallback(() => Math.random()),
		bytes: (_webcrypto && typeof _webcrypto.getRandomValues === 'function')
			? (n) => _webcrypto.getRandomValues(new Uint8Array(n))
			: (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (Math.random() * 256) | 0; return a; }
	}),
	timers: Object.freeze({
		set: (cb, ms, ...a) => setTimeout(cb, ms, ...a),
		setInterval: (cb, ms, ...a) => setInterval(cb, ms, ...a),
		// No setImmediate in the browser: a zero-delay macrotask is the closest.
		setImmediate: (cb, ...a) => setTimeout(cb, 0, ...a),
		clear: (h) => clearTimeout(h),
		clearInterval: (h) => clearInterval(h),
		queueMicrotask: (typeof globalThis.queueMicrotask === 'function')
			? (cb) => globalThis.queueMicrotask(cb)
			: (cb) => Promise.resolve().then(cb)
	}),
	tz: undefined // effective timezone for cron evaluation; undefined = real local TZ
});

let current = defaultEnv;

// The named helpers are the ONLY thing browser client code imports. Each is a
// one-line read over `current` - monomorphic in prod, inlined by V8.
export const now = () => current.clock.now();
export const monotonicNow = () => current.clock.monotonic();
export const wallEpoch = () => current.clock.wallEpoch();
export const randomFloat = () => current.rng.float();
export const randomU32 = () => current.rng.u32();
export const randomUuid = () => current.rng.uuid();
export const randomBytes = (n) => current.rng.bytes(n);
export const setTimer = (cb, ms, ...a) => current.timers.set(cb, ms, ...a);
export const setIntervalTimer = (cb, ms, ...a) => current.timers.setInterval(cb, ms, ...a);
export const setImmediateTimer = (cb, ...a) => current.timers.setImmediate(cb, ...a);
export const clearTimer = (h) => current.timers.clear(h);
export const clearIntervalTimer = (h) => current.timers.clearInterval(h);
export const microtask = (cb) => current.timers.queueMicrotask(cb);
export const effectiveTimeZone = () => current.tz;

/**
 * Install a virtual environment (the simulator / test harness only). Refuses in
 * a node production build unless explicitly forced, so a stray call can never
 * swap the clock under a live deployment; in a real browser there is no
 * `process` and nothing calls this anyway. A partial env merges over the native
 * defaults, so a harness can override just the clock and keep native rng / timers.
 *
 * @param {object} [env] - Partial environment. Any of `clock`, `rng`, `timers`
 *   may carry a subset of their fields; provided fields override the native
 *   default, omitted fields fall through to native. `tz` overrides only when the
 *   property is present (including an explicit `undefined`).
 * @param {object} [opts]
 * @param {boolean} [opts.force] - Allow the swap even when
 *   `process.env.NODE_ENV === 'production'`. Use only inside a controlled
 *   simulation harness.
 * @returns {object} The newly installed frozen environment.
 */
export function setRuntimeEnv(env, opts) {
	const force = opts && opts.force === true;
	if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production' && !force) {
		throw new Error('client runtime: setRuntimeEnv refused in production (pass { force: true } only inside a controlled simulation harness)');
	}
	current = Object.freeze({
		clock: Object.freeze({ ...defaultEnv.clock, ...(env && env.clock) }),
		rng: Object.freeze({ ...defaultEnv.rng, ...(env && env.rng) }),
		timers: Object.freeze({ ...defaultEnv.timers, ...(env && env.timers) }),
		tz: env && Object.prototype.hasOwnProperty.call(env, 'tz') ? env.tz : defaultEnv.tz
	});
	return current;
}

/**
 * Restore the native environment. Cheap wholesale reassignment (no per-field
 * mutation), so the hidden class stays stable.
 */
export function resetRuntimeEnv() { current = defaultEnv; }

/**
 * Read-only accessor for the active environment (test / sim introspection only).
 * @returns {object} The active frozen environment.
 */
export function getRuntimeEnv() { return current; }
