// The "smooth" devtools tab is pull-based: a live `live.smooth` view registers
// a `() => channel.stats()` accessor, and the panel calls it on its refresh
// tick. These tests cover the registry contract (the panel render is a dev-only
// DOM overlay, untested like the rest of devtools.js).

import { describe, it, expect, beforeEach } from 'vitest';
import { __devtools, _devtoolsSmoothRegister } from '../src/client/devtools-instrument.js';

describe('_devtoolsSmoothRegister (smooth devtools tab)', () => {
	beforeEach(() => {
		if (__devtools) __devtools.smooth.clear();
	});

	it('registers a stats accessor the panel can pull, and the unregister drops it', () => {
		if (!__devtools) return; // production build: instrumentation is compiled out
		const snap = {
			topic: 's:r1', self: 'me', overflowed: false, unacked: 2, windowCap: 256,
			lastDivergence: 1.5, correcting: true, interpDelayMs: 100, clockSynced: true, remoteCount: 3
		};
		const off = _devtoolsSmoothRegister(() => snap);
		expect(__devtools.smooth.size).toBe(1);
		const [accessor] = [...__devtools.smooth];
		expect(accessor()).toBe(snap);
		off();
		expect(__devtools.smooth.size).toBe(0);
	});

	it('keeps multiple channels independent', () => {
		if (!__devtools) return;
		const offA = _devtoolsSmoothRegister(() => ({ topic: 'a' }));
		const offB = _devtoolsSmoothRegister(() => ({ topic: 'b' }));
		expect(__devtools.smooth.size).toBe(2);
		offA();
		expect(__devtools.smooth.size).toBe(1);
		expect([...__devtools.smooth][0]()).toEqual({ topic: 'b' });
		offB();
		expect(__devtools.smooth.size).toBe(0);
	});

	it('the unregister is idempotent and safe to call twice', () => {
		if (!__devtools) return;
		const off = _devtoolsSmoothRegister(() => null);
		off();
		expect(() => off()).not.toThrow();
		expect(__devtools.smooth.size).toBe(0);
	});
});
