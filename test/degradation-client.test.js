import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/client-runtime.js';

// Minimal mock of the adapter client: capture the `__realtime` subscriber so the test
// can deliver degraded/recovered frames; `connect` returns null (no flow-control input).
const H = vi.hoisted(() => ({ cb: null }));
vi.mock('svelte-adapter-uws/client', () => ({
	on: (topic) => ({ subscribe: (fn) => { if (topic === '__realtime') H.cb = fn; return () => { H.cb = null; }; } }),
	connect: () => null
}));

import { health, degradation, _resetHealth } from '../src/client/health.js';

const deliver = (env) => { if (H.cb) H.cb(env); };

describe('degradation store (mitigation consumer)', () => {
	beforeEach(() => { _resetHealth(); H.cb = null; });
	afterEach(() => resetRuntimeEnv());

	// Envelopes are the POST-dispatchEvent shape the realtime client actually
	// receives: the mitigation / recovery ride in `data` (the publish data arg) and
	// the de-herd window is the top-level `j` the adapter forwards.
	it('surfaces the mitigation from a degraded event and flips health', () => {
		let d;
		let h;
		const u1 = degradation.subscribe((v) => { d = v; });
		const u2 = health.subscribe((v) => { h = v; });
		deliver({ event: 'degraded', data: { at: 1, mitigation: { bannerCopy: 'Read-only', retryAfterMs: 4000 } } });
		expect(d).toEqual({ active: true, mitigation: { bannerCopy: 'Read-only', retryAfterMs: 4000 }, recovery: null });
		expect(h).toBe('degraded');
		u1(); u2();
	});

	it('clears on recovered and carries the recovery hint', () => {
		let d;
		let h;
		const u1 = degradation.subscribe((v) => { d = v; });
		const u2 = health.subscribe((v) => { h = v; });
		deliver({ event: 'degraded', data: { mitigation: { bannerCopy: 'x' } } });
		deliver({ event: 'recovered', data: { recovery: { refetch: true, bannerCopy: 'Back online' } } });
		expect(d).toEqual({ active: false, mitigation: null, recovery: { refetch: true, bannerCopy: 'Back online' } });
		expect(h).toBe('healthy');
		u1(); u2();
	});

	it('a degraded event with no mitigation still flips active (mitigation null)', () => {
		let d;
		const u = degradation.subscribe((v) => { d = v; });
		deliver({ event: 'degraded', data: { at: 1 } });
		expect(d).toEqual({ active: true, mitigation: null, recovery: null });
		u();
	});

	it('honors the de-herd window: a jittered degraded event defers the store update', () => {
		let fired = null;
		setRuntimeEnv(
			{ rng: { float: () => 0.5 }, timers: { set: (cb) => { fired = cb; return 1; }, clear: () => { fired = null; } } },
			{ force: true }
		);
		let d;
		const u = degradation.subscribe((v) => { d = v; });
		deliver({ event: 'degraded', j: 1000, data: { mitigation: { bannerCopy: 'x' } } });
		expect(d.active).toBe(false); // deferred by the client's own delay, not yet applied
		expect(typeof fired).toBe('function');
		fired(); // fire the de-herd timer
		expect(d.active).toBe(true);
		expect(d.mitigation).toEqual({ bannerCopy: 'x' }); // and the mitigation surfaced from `data`
		u();
	});
});
