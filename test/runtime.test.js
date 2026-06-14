import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	now,
	monotonicNow,
	wallEpoch,
	randomFloat,
	randomU32,
	randomUuid,
	randomBytes,
	setTimer,
	setIntervalTimer,
	setImmediateTimer,
	clearTimer,
	clearIntervalTimer,
	microtask,
	effectiveTimeZone,
	setRuntimeEnv,
	resetRuntimeEnv,
	getRuntimeEnv
} from '../src/shared/runtime.js';

describe('shared/runtime', () => {
	afterEach(() => {
		resetRuntimeEnv();
	});

	describe('default helpers return native-equivalent values', () => {
		it('now() returns a wall-clock ms value close to Date.now()', () => {
			const before = Date.now();
			const value = now();
			const after = Date.now();
			expect(typeof value).toBe('number');
			// The default clock is cached at ~1Hz, so allow generous slack below.
			expect(value).toBeGreaterThanOrEqual(before - 1100);
			expect(value).toBeLessThanOrEqual(after + 100);
		});

		it('monotonicNow() is strictly forward and near current wall epoch', () => {
			const a = monotonicNow();
			const b = monotonicNow();
			expect(typeof a).toBe('number');
			expect(b).toBeGreaterThanOrEqual(a);
			expect(Math.abs(a - Date.now())).toBeLessThan(5000);
		});

		it('wallEpoch() tracks Date.now() exactly (no 1Hz cache)', () => {
			const before = Date.now();
			const value = wallEpoch();
			const after = Date.now();
			expect(value).toBeGreaterThanOrEqual(before);
			expect(value).toBeLessThanOrEqual(after);
		});

		it('randomFloat() returns a float in [0, 1)', () => {
			for (let i = 0; i < 100; i++) {
				const f = randomFloat();
				expect(f).toBeGreaterThanOrEqual(0);
				expect(f).toBeLessThan(1);
			}
		});

		it('randomU32() returns an unsigned 32-bit integer', () => {
			for (let i = 0; i < 100; i++) {
				const u = randomU32();
				expect(Number.isInteger(u)).toBe(true);
				expect(u).toBeGreaterThanOrEqual(0);
				expect(u).toBeLessThanOrEqual(0xffffffff);
			}
		});

		it('randomUuid() returns a valid v4 uuid string', () => {
			const id = randomUuid();
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		});

		it('randomBytes(n) returns a Buffer of length n', () => {
			const buf = randomBytes(16);
			expect(Buffer.isBuffer(buf)).toBe(true);
			expect(buf.length).toBe(16);
		});

		it('effectiveTimeZone() is undefined by default (real local TZ)', () => {
			expect(effectiveTimeZone()).toBeUndefined();
		});

		it('setTimer / clearTimer wrap native setTimeout / clearTimeout', async () => {
			await new Promise((resolve, reject) => {
				const h = setTimer(resolve, 0);
				expect(h).toBeTruthy();
				// A second timer we immediately clear must never fire.
				const doomed = setTimer(() => reject(new Error('cleared timer fired')), 1);
				clearTimer(doomed);
			});
		});

		it('setIntervalTimer / clearIntervalTimer wrap native interval primitives', async () => {
			await new Promise((resolve) => {
				let ticks = 0;
				const h = setIntervalTimer(() => {
					ticks++;
					if (ticks >= 2) {
						clearIntervalTimer(h);
						resolve();
					}
				}, 1);
			});
		});

		it('setImmediateTimer wraps native setImmediate', async () => {
			await new Promise((resolve) => {
				setImmediateTimer(resolve);
			});
		});

		it('microtask schedules a microtask', async () => {
			await new Promise((resolve) => {
				microtask(resolve);
			});
		});
	});

	describe('setRuntimeEnv', () => {
		it('installs a partial env (fake clock with a fixed now())', () => {
			setRuntimeEnv({ clock: { now: () => 123456 } });
			expect(now()).toBe(123456);
		});

		it('merges a partial env over native defaults (clock override leaves rng/timers native)', () => {
			setRuntimeEnv({ clock: { now: () => 999 } });
			// Overridden field reflects the fake clock.
			expect(now()).toBe(999);
			// Non-overridden clock fields fall through to native behavior.
			expect(typeof monotonicNow()).toBe('number');
			expect(Math.abs(wallEpoch() - Date.now())).toBeLessThan(2000);
			// rng stays native.
			const f = randomFloat();
			expect(f).toBeGreaterThanOrEqual(0);
			expect(f).toBeLessThan(1);
			expect(randomUuid()).toMatch(/^[0-9a-f-]{36}$/);
			expect(randomBytes(8).length).toBe(8);
		});

		it('merges a partial rng env, leaving clock and timers native', () => {
			setRuntimeEnv({ rng: { float: () => 0.5, u32: () => 7 } });
			expect(randomFloat()).toBe(0.5);
			expect(randomU32()).toBe(7);
			// Non-overridden rng fields stay native.
			expect(randomUuid()).toMatch(/^[0-9a-f-]{36}$/);
			// clock stays native (close to Date.now()).
			expect(Math.abs(wallEpoch() - Date.now())).toBeLessThan(2000);
		});

		it('installs a virtual timers env that the timer helpers route through', () => {
			const calls = [];
			setRuntimeEnv({
				timers: {
					set: (cb, ms) => { calls.push(['set', ms]); return 'fake-handle'; },
					clear: (h) => { calls.push(['clear', h]); }
				}
			});
			const handle = setTimer(() => {}, 250);
			expect(handle).toBe('fake-handle');
			clearTimer(handle);
			expect(calls).toEqual([['set', 250], ['clear', 'fake-handle']]);
		});

		it('overrides tz only when the property is present', () => {
			setRuntimeEnv({ tz: 'UTC' });
			expect(effectiveTimeZone()).toBe('UTC');
			// A subsequent env without tz falls back to the native default (undefined).
			setRuntimeEnv({ clock: { now: () => 1 } });
			expect(effectiveTimeZone()).toBeUndefined();
		});

		it('returns the newly installed frozen environment', () => {
			const env = setRuntimeEnv({ clock: { now: () => 42 } });
			expect(env).toBe(getRuntimeEnv());
			expect(Object.isFrozen(env)).toBe(true);
		});

		describe('production guard', () => {
			let prevNodeEnv;
			beforeEach(() => {
				prevNodeEnv = process.env.NODE_ENV;
				process.env.NODE_ENV = 'production';
			});
			afterEach(() => {
				if (prevNodeEnv === undefined) {
					delete process.env.NODE_ENV;
				} else {
					process.env.NODE_ENV = prevNodeEnv;
				}
			});

			it('THROWS in production without { force: true }', () => {
				expect(() => setRuntimeEnv({ clock: { now: () => 0 } })).toThrow(/refused in production/);
				// The active env must be untouched after a refused swap.
				expect(getRuntimeEnv()).toBe(getRuntimeEnv());
				expect(now()).not.toBe(0);
			});

			it('SUCCEEDS in production with { force: true }', () => {
				const env = setRuntimeEnv({ clock: { now: () => 0 } }, { force: true });
				expect(now()).toBe(0);
				expect(env).toBe(getRuntimeEnv());
			});
		});
	});

	describe('resetRuntimeEnv', () => {
		it('restores native behavior after a swap', () => {
			setRuntimeEnv({ clock: { now: () => 5 }, rng: { float: () => 0.1 } });
			expect(now()).toBe(5);
			expect(randomFloat()).toBe(0.1);

			resetRuntimeEnv();
			expect(Math.abs(now() - Date.now())).toBeLessThan(2000);
			const f = randomFloat();
			expect(f).not.toBe(0.1);
			expect(f).toBeGreaterThanOrEqual(0);
			expect(f).toBeLessThan(1);
		});
	});

	describe('getRuntimeEnv', () => {
		it('reflects the active env after a swap', () => {
			const before = getRuntimeEnv();
			const installed = setRuntimeEnv({ clock: { now: () => 314 } });
			const after = getRuntimeEnv();
			expect(after).toBe(installed);
			expect(after).not.toBe(before);
			expect(after.clock.now()).toBe(314);
		});
	});

	describe('monomorphic shape', () => {
		it('keeps the active env a frozen object with the same key shape after a swap', () => {
			const expectShape = (env) => {
				expect(Object.isFrozen(env)).toBe(true);
				expect(Object.keys(env).sort()).toEqual(['clock', 'rng', 'timers', 'tz']);
				expect(Object.isFrozen(env.clock)).toBe(true);
				expect(Object.keys(env.clock).sort()).toEqual(['monotonic', 'now', 'wallEpoch']);
				expect(Object.isFrozen(env.rng)).toBe(true);
				expect(Object.keys(env.rng).sort()).toEqual(['bytes', 'float', 'u32', 'uuid']);
				expect(Object.isFrozen(env.timers)).toBe(true);
				expect(Object.keys(env.timers).sort()).toEqual([
					'clear', 'clearInterval', 'queueMicrotask', 'set', 'setImmediate', 'setInterval'
				]);
			};

			expectShape(getRuntimeEnv());
			setRuntimeEnv({ clock: { now: () => randomUUID().length } });
			expectShape(getRuntimeEnv());
			resetRuntimeEnv();
			expectShape(getRuntimeEnv());
		});
	});
});
