// @ts-check

/**
 * Injectable runtime environment for the clock, RNG, and timers.
 *
 * Framework code reads time, randomness, and schedules timers exclusively
 * through the named helpers exported here instead of touching `Date.now`,
 * `Math.random`, `crypto`, or `setTimeout` directly. In production the helpers
 * bind the native primitives with zero measurable overhead (a single read over
 * one frozen, never-swapped environment object - V8 keeps the shape monomorphic
 * and inlines straight through to the native calls). A controlled simulation or
 * test harness can swap in seeded virtual implementations so the same code runs
 * deterministically.
 *
 * The env shape and the exported helper names are kept byte-identical with the
 * sibling adapter and extensions copies so the three never drift.
 *
 * @module svelte-realtime/shared/runtime
 */

import { performance } from 'node:perf_hooks';
import { randomUUID, randomBytes as cryptoRandomBytes } from 'node:crypto';

// The default clock keeps the proven 1Hz-cached wall clock (a single variable
// read per call - the current hot-path cost) plus a monotonic source for
// duration math. The refresher is unref'd so it never holds the loop open.
let cachedNow = Date.now();
const _refresher = setInterval(() => { cachedNow = Date.now(); }, 1000);
if (_refresher && _refresher.unref) _refresher.unref();

// Snapshot at load: the wall time at performance.now() === 0. Adding
// performance.now() yields a monotonic ms-since-epoch value immune to clock steps.
const _processStartEpoch = Date.now() - performance.now();

// One frozen environment object, one stable hidden class. In production
// `current === defaultEnv` for the whole process lifetime (no override ever
// installs), so V8 sees a monomorphic shape and inlines the helpers to the
// native primitives - zero measurable overhead on the hot path.
const defaultEnv = Object.freeze({
	clock: Object.freeze({
		now: () => cachedNow,                                   // wall, ~1s precision, cheap
		monotonic: () => _processStartEpoch + performance.now(), // strictly-forward duration math
		wallEpoch: () => Date.now()                             // exact wall clock; process-identity baseline
	}),
	rng: Object.freeze({
		float: () => Math.random(),
		u32: () => (Math.random() * 0x100000000) >>> 0,
		uuid: () => randomUUID(),
		bytes: (n) => cryptoRandomBytes(n)
	}),
	timers: Object.freeze({
		set: (cb, ms, ...a) => setTimeout(cb, ms, ...a),
		setInterval: (cb, ms, ...a) => setInterval(cb, ms, ...a),
		setImmediate: (cb, ...a) => setImmediate(cb, ...a),
		clear: (h) => clearTimeout(h),
		clearInterval: (h) => clearInterval(h),
		queueMicrotask: (cb) => queueMicrotask(cb)
	}),
	tz: undefined // effective timezone for cron evaluation; undefined = real local TZ
});

let current = defaultEnv;

// The named helpers are the ONLY thing framework code imports. Each is a
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
 * production unless explicitly forced, so a stray call can never swap the clock
 * under a live deployment. A partial env merges over the native defaults, so a
 * harness can override just the clock and keep native rng / timers.
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
		throw new Error('runtime: setRuntimeEnv refused in production (pass { force: true } only inside a controlled simulation harness)');
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
