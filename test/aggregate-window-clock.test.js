// live.aggregate windows against the wall clock. The runtime's cheap `now()` is
// a 1 Hz-refreshed cache that lags the wall clock by up to a second; window
// boundaries, timer delays and noise seeds must come from the exact clock so a
// window closes at its boundary, exactly once, and an event lands in the window
// the wall clock puts it in.
//
// Fake timers drive `Date.now()` (the exact clock). The cached clock is modelled
// with `installCachedClock`: a value refreshed once a second at a fixed phase,
// which is what the production default does.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	live,
	realtime,
	combineSum,
	__registerAggregate,
	_activateDerived,
	_resetAggregates,
	_prepareHmr,
	_restoreHmr,
	setCronPlatform
} from '../src/server.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { state } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';

const SECRET = 'test-privacy-secret';

/** A minute boundary well away from any DST edge. */
const B0 = Date.UTC(2026, 9, 3, 12, 0, 0, 0);

/**
 * Model the production `now()`: refreshed once a second, `phase` ms past each
 * whole second, so it lags the wall clock by up to 999 ms.
 * @param {number} phase
 */
function installCachedClock(phase) {
	setRuntimeEnv({ clock: { now: () => Math.floor((Date.now() - phase) / 1000) * 1000 + phase } });
}

/**
 * Bind the cached clock to the exact one, so a case isolates a defect other
 * than the lag.
 */
function installExactNow() {
	setRuntimeEnv({ clock: { now: () => Date.now() } });
}

/** A platform whose recorded publishes carry the wall time they happened at. */
function timedPlatform() {
	const platform = mockPlatform();
	const raw = platform.publish;
	platform.publish = (topic, event, data, options) => {
		const r = raw(topic, event, data, options);
		platform.published[platform.published.length - 1].at = Date.now();
		return r;
	};
	return platform;
}

function counter() {
	return { count: { init: () => 0, reduce: (acc) => acc + 1 } };
}

function registerTumbling(name, windowSpec) {
	const fn = live.aggregate(`${name}:src`, counter(), {
		topic: `${name}:agg`,
		windows: { w: windowSpec }
	});
	__registerAggregate(`agg/${name}`, fn);
	const platform = timedPlatform();
	_activateDerived(platform);
	setCronPlatform(platform);
	const out = () => platform.published.filter((p) => p.topic === `${name}:agg:w`);
	return { fn, platform, out };
}

afterEach(() => {
	_resetAggregates();
	resetRuntimeEnv();
	vi.useRealTimers();
	state.privacySecret = null;
});

describe('tumbling windows close on the exact clock', () => {
	it('restores window loaders and autonomous timers after a failed module reload', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const fn = live.aggregate('restored:source', {
			count: { init: () => 0, reduce: value => value + 1, combine: (...values) => values.reduce((a, b) => a + b, 0) }
		}, { topic: 'restored:output', windows: {
			minute: { type: 'tumbling', period: 'minute' },
			recent: { type: 'sliding', durationMs: 2000, slideMs: 1000 },
			lifetime: { type: 'lifetime' }
		} });
		__registerAggregate('restored/aggregate', fn);
		const platform = timedPlatform();
		_activateDerived(platform); setCronPlatform(platform);
		platform.publish('restored:source', 'add', {});
		platform.publish('restored:source', 'add', {});
		const snap = _prepareHmr();
		_restoreHmr(snap);
		for (const loader of Object.values(fn.__windowStreams)) expect(await loader()).toEqual({ count: 2 });
		platform.published.length = 0;
		await vi.advanceTimersByTimeAsync(2000);
		expect(platform.published.filter(event => event.topic === 'restored:output:minute').map(event => event.data.count)).toEqual([2]);
		expect(platform.published.filter(event => event.topic === 'restored:output:recent').map(event => event.data.count)).toEqual([2, 0]);
		expect(await fn.__windowStreams.minute()).toEqual({ count: 0 });
		expect(await fn.__windowStreams.recent()).toEqual({ count: 0 });
		expect(await fn.__windowStreams.lifetime()).toEqual({ count: 2 });
		platform.publish('restored:source', 'add', {});
		expect(await fn.__windowStreams.lifetime()).toEqual({ count: 3 });
	});

	it('closes at the boundary, not when the lagging cached clock reaches it', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installCachedClock(300);
		const { platform, out } = registerTumbling('tlate', { type: 'tumbling', period: 'minute' });

		platform.publish('tlate:src', 'inc', {});
		platform.publish('tlate:src', 'inc', {});
		expect(out().length).toBe(2);

		vi.advanceTimersByTime(1999);
		expect(out().length).toBe(2);

		vi.advanceTimersByTime(1);
		expect(out().length).toBe(3);
		expect(out()[2].data.count).toBe(2);
		expect(out()[2].at).toBe(B0);
	});

	it('closes once per boundary: an event just after it stays in the new window', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installCachedClock(300);
		const { platform, out } = registerTumbling('tonce', { type: 'tumbling', period: 'minute' });

		platform.publish('tonce:src', 'inc', {});
		vi.advanceTimersByTime(2000 + 30);
		platform.publish('tonce:src', 'inc', {});
		expect(out().map((p) => p.data.count)).toEqual([1, 1, 1]);

		// The cached clock still reads before B0 when the boundary fires. Nothing
		// may close the same boundary a second time and discard the new window.
		vi.advanceTimersByTime(60_000 - 30 - 1);
		expect(out().length).toBe(3);

		vi.advanceTimersByTime(1);
		expect(out().length).toBe(4);
		expect(out()[3].data.count).toBe(1);
		expect(out()[3].at).toBe(B0 + 60_000);
	});

	it('closes exactly once per period across many periods', () => {
		vi.useFakeTimers({ now: B0 - 500 });
		installCachedClock(700);
		const { platform, out } = registerTumbling('tmany', { type: 'tumbling', durationMs: 1000 });

		for (let i = 0; i < 10; i++) {
			platform.publish('tmany:src', 'inc', {});
			vi.advanceTimersByTime(1000);
		}
		const closes = out().filter((p) => p.at % 1000 === 0);
		expect(closes.map((p) => p.at)).toEqual(Array.from({ length: 10 }, (_, i) => B0 + i * 1000));
		expect(closes.every((p) => p.data.count === 1)).toBe(true);
		expect(out().length).toBe(20);
	});

	it('an event after the boundary opens the new window while the boundary timer is late', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installCachedClock(300);
		const { platform, out } = registerTumbling('tfold', { type: 'tumbling', period: 'minute' });

		platform.publish('tfold:src', 'inc', {});
		platform.publish('tfold:src', 'inc', {});
		vi.advanceTimersByTime(1990);
		// Move the wall clock past the boundary without running timers, as a
		// busy event loop does: the boundary timer is now 15 ms late, and the
		// cached clock still reads before the boundary.
		vi.setSystemTime(B0 + 5);
		platform.publish('tfold:src', 'inc', {});

		expect(out().map((p) => p.data.count)).toEqual([1, 2, 2, 1]);
		expect(out()[2].at).toBe(B0 + 5);

		// The late timer finds the window already closed and does not close it again.
		vi.advanceTimersByTime(5000);
		expect(out().length).toBe(4);
	});

	it('an event after a wall clock jump past the boundary opens the new window', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installCachedClock(300);
		const { platform, out } = registerTumbling('tjump', { type: 'tumbling', period: 'minute' });

		platform.publish('tjump:src', 'inc', {});
		// The wall clock jumps 5 s (a resumed VM, an NTP step); the boundary
		// timer still waits out its own delay.
		vi.setSystemTime(B0 + 3000);
		platform.publish('tjump:src', 'inc', {});

		expect(out().map((p) => p.data.count)).toEqual([1, 1, 1]);
		expect(out()[1].at).toBe(B0 + 3000);
	});

	it('an event far from a boundary does not read the exact clock', () => {
		vi.useFakeTimers({ now: B0 - 30_000 });
		let exactReads = 0;
		setRuntimeEnv({ clock: { now: () => Date.now(), wallEpoch: () => { exactReads++; return Date.now(); } } });
		const { platform, out } = registerTumbling('tcost', { type: 'tumbling', period: 'minute' });

		exactReads = 0;
		for (let i = 0; i < 100; i++) platform.publish('tcost:src', 'inc', {});
		expect(exactReads).toBe(0);

		vi.advanceTimersByTime(30_000 - 40);
		expect(out().length).toBe(100);
		exactReads = 0;
		platform.publish('tcost:src', 'inc', {});
		expect(exactReads).toBe(1);

		// Once the window has closed, the next period starts far again.
		vi.advanceTimersByTime(30_000);
		exactReads = 0;
		for (let i = 0; i < 100; i++) platform.publish('tcost:src', 'inc', {});
		expect(exactReads).toBe(0);
	});

	it('a window registered just before a boundary checks the exact clock at once', () => {
		vi.useFakeTimers({ now: B0 - 20 });
		installCachedClock(300);
		const { platform, out } = registerTumbling('tjust', { type: 'tumbling', period: 'minute' });

		platform.publish('tjust:src', 'inc', {});
		vi.setSystemTime(B0 + 5);
		platform.publish('tjust:src', 'inc', {});

		expect(out().map((p) => p.data.count)).toEqual([1, 1, 1]);
		expect(out()[1].at).toBe(B0 + 5);
	});

	it('a pending debounced publish gives way to the closing publish', () => {
		vi.useFakeTimers({ now: B0 - 10 });
		installExactNow();
		const { platform, out } = registerTumbling('tdeb', { type: 'tumbling', period: 'minute', debounce: 50 });

		platform.publish('tdeb:src', 'inc', {});
		vi.advanceTimersByTime(10);
		expect(out().map((p) => p.data.count)).toEqual([1]);
		expect(out()[0].at).toBe(B0);

		// The debounced value belonged to the closed window; it never lands later.
		vi.advanceTimersByTime(100);
		expect(out().length).toBe(1);
	});

	it('an init() that throws as a window closes is reported once per boundary and keeps the state', () => {
		vi.useFakeTimers({ now: B0 - 500 });
		installExactNow();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			let failing = false;
			let inits = 0;
			const fn = live.aggregate('tinit:src', {
				count: { init: () => { inits++; if (failing) throw new Error('init failed'); return 0; }, reduce: (acc) => acc + 1 }
			}, { topic: 'tinit:agg', windows: { w: { type: 'tumbling', durationMs: 1000 } } });
			__registerAggregate('agg/tinit', fn);
			const platform = timedPlatform();
			_activateDerived(platform);
			setCronPlatform(platform);
			const out = () => platform.published.filter((p) => p.topic === 'tinit:agg:w');

			platform.publish('tinit:src', 'inc', {});
			failing = true;
			inits = 0;
			vi.advanceTimersByTime(5000);
			expect(inits).toBe(5);
			expect(errors.mock.calls.filter((c) => /init\(\) threw/.test(String(c[0]))).length).toBe(5);
			expect(out().map((p) => p.data.count)).toEqual([1, 1, 1, 1, 1, 1]);

			// An event that closes the window is not failed by the error either.
			vi.setSystemTime(Date.now() + 1500);
			expect(() => platform.publish('tinit:src', 'inc', {})).not.toThrow();
			expect(out().map((p) => p.data.count).slice(-2)).toEqual([1, 2]);
		} finally {
			errors.mockRestore();
		}
	});

	it('a window closed by an event re-arms its timer for the next boundary', () => {
		vi.useFakeTimers({ now: B0 - 50_000 });
		installCachedClock(300);
		const { platform, out } = registerTumbling('trearm', { type: 'tumbling', period: 'minute' });

		// The wall clock jumps 95 s; the boundary timer still waits out its own
		// delay and would next wake about 95 s after the new boundary.
		vi.setSystemTime(B0 + 45_000);
		platform.publish('trearm:src', 'inc', {});
		expect(out().map((p) => p.data.count)).toEqual([0, 1]);

		vi.advanceTimersByTime(15_000);
		expect(out().length).toBe(3);
		expect(out()[2].at).toBe(B0 + 60_000);
		expect(out()[2].data.count).toBe(1);
	});

	it('the closing publish of a window closed by an event goes out on that event\'s platform', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const fn = live.aggregate('tplat:src', counter(), { topic: 'tplat:agg', windows: { w: { type: 'tumbling', period: 'minute' } } });
		__registerAggregate('agg/tplat', fn);
		const platform = timedPlatform();
		_activateDerived(platform);
		const cron = timedPlatform();
		setCronPlatform(cron);

		platform.publish('tplat:src', 'inc', {});
		vi.setSystemTime(B0 + 5);
		platform.publish('tplat:src', 'inc', {});

		expect(platform.published.filter((p) => p.topic === 'tplat:agg:w').map((p) => p.data.count)).toEqual([1, 1, 1]);
		expect(cron.published.length).toBe(0);
	});

	for (const order of ['upstream first', 'downstream first']) {
		it(`a downstream window folds the closing state of an upstream window before it closes (${order})`, () => {
			vi.useFakeTimers({ now: B0 - 2000 });
			installExactNow();
			const name = order === 'upstream first' ? 'tchainu' : 'tchaind';
			const upstream = live.aggregate(`${name}:src`, counter(), { topic: `${name}:up`, windows: { m: { type: 'tumbling', period: 'minute' } } });
			const downstream = live.aggregate(`${name}:up:m`, counter(), { topic: `${name}:down`, windows: { m: { type: 'tumbling', period: 'minute' } } });
			if (order === 'upstream first') {
				__registerAggregate(`agg/${name}-up`, upstream);
				__registerAggregate(`agg/${name}-down`, downstream);
			} else {
				__registerAggregate(`agg/${name}-down`, downstream);
				__registerAggregate(`agg/${name}-up`, upstream);
			}
			const platform = timedPlatform();
			_activateDerived(platform);
			setCronPlatform(platform);
			const down = () => platform.published.filter((p) => p.topic === `${name}:down:m`);

			platform.publish(`${name}:src`, 'inc', {});
			platform.publish(`${name}:src`, 'inc', {});
			vi.advanceTimersByTime(2000);

			// Two in-window publishes plus the closing one all belong to the minute
			// that ended: the downstream folds the third (3) and then closes with it.
			const atBoundary = down().filter((p) => p.at === B0);
			expect(atBoundary.map((p) => p.data.count)).toEqual([3, 3]);
			platform.publish(`${name}:src`, 'inc', {});
			expect(down().slice(-1)[0].data.count).toBe(1);
		});
	}

	function activate() {
		const platform = timedPlatform();
		_activateDerived(platform);
		setCronPlatform(platform);
		return platform;
	}
	const minute = { type: 'tumbling', period: 'minute' };

	// The chain cases below close the downstream window with a load after the
	// boundary, before any timer runs, so the upstream window is still open and
	// only the walk can close it first.

	it('a window fed through an aggregate that is not closing gets the upstream closing state first', async () => {
		const B1 = B0 + 60_000;
		vi.useFakeTimers({ now: B1 - 2000 });
		installExactNow();
		// u (minute) -> d (hour, not due at B1) -> e (minute).
		const e = live.aggregate('tind:d:h', counter(), { topic: 'tind:e', windows: { m: minute } });
		__registerAggregate('agg/tind-e', e);
		__registerAggregate('agg/tind-d', live.aggregate('tind:u:m', counter(), { topic: 'tind:d', windows: { h: { type: 'tumbling', period: 'hour' } } }));
		__registerAggregate('agg/tind-u', live.aggregate('tind:src', counter(), { topic: 'tind:u', windows: { m: minute } }));
		const platform = activate();

		platform.publish('tind:src', 'inc', {});
		platform.publish('tind:src', 'inc', {});
		vi.setSystemTime(B1 + 5);
		await e.__windowStreams.m();

		expect(platform.published.filter((p) => p.topic === 'tind:e:m' && p.at === B1 + 5).map((p) => p.data.count)).toEqual([3, 3]);
	});

	it('a window fed through a single-state aggregate gets the upstream closing state first', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const e = live.aggregate('tss:s', counter(), { topic: 'tss:e', windows: { m: minute } });
		__registerAggregate('agg/tss-e', e);
		__registerAggregate('agg/tss-s', live.aggregate('tss:u:m', counter(), { topic: 'tss:s' }));
		__registerAggregate('agg/tss-u', live.aggregate('tss:src', counter(), { topic: 'tss:u', windows: { m: minute } }));
		const platform = activate();

		platform.publish('tss:src', 'inc', {});
		platform.publish('tss:src', 'inc', {});
		vi.setSystemTime(B0 + 5);
		await e.__windowStreams.m();

		expect(platform.published.filter((p) => p.topic === 'tss:e:m' && p.at === B0 + 5).map((p) => p.data.count)).toEqual([3, 3]);
	});

	it('every upstream window closing at or before the boundary closes first, through a chain', async () => {
		vi.useFakeTimers({ now: B0 - 20_000 });
		installExactNow();
		// a (minute) -> b (30 s, closing 15 s before the minute) -> c (minute).
		// After a stall both a and b are due when c closes; c must count b's
		// closing state and, through b's new window, a's.
		const c = live.aggregate('tf1:b:w', counter(), { topic: 'tf1:c', windows: { m: minute } });
		__registerAggregate('agg/tf1-c', c);
		__registerAggregate('agg/tf1-b', live.aggregate('tf1:a:m', counter(), { topic: 'tf1:b', windows: { w: { type: 'tumbling', durationMs: 30_000, anchor: 15_000 } } }));
		__registerAggregate('agg/tf1-a', live.aggregate('tf1:src', counter(), { topic: 'tf1:a', windows: { m: minute } }));
		const platform = activate();

		platform.publish('tf1:src', 'inc', {});
		platform.publish('tf1:src', 'inc', {});
		vi.setSystemTime(B0 + 1000);
		await c.__windowStreams.m();

		expect(platform.published.filter((p) => p.topic === 'tf1:c:m').slice(-1)[0].data.count).toBe(4);
	});

	it('an upstream closing state lets a downstream window with an earlier boundary close first', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		// u closes at :05 past each 10 s; d closes on the hour. After a stall, an
		// event closes u first: d's hour ended before u's window did.
		__registerAggregate('agg/tph2-d', live.aggregate('tph2:u:w', counter(), { topic: 'tph2:d', windows: { h: { type: 'tumbling', period: 'hour' } } }));
		__registerAggregate('agg/tph2-u', live.aggregate('tph2:src', counter(), { topic: 'tph2:u', windows: { w: { type: 'tumbling', durationMs: 10_000, anchor: 5000 } } }));
		const platform = activate();

		platform.publish('tph2:src', 'inc', {});
		platform.publish('tph2:src', 'inc', {});
		vi.setSystemTime(B0 + 6000);
		platform.publish('tph2:src', 'inc', {});

		// d closes its hour with 2, then counts u's closing state and the new
		// event's publish in the next hour.
		expect(platform.published.filter((p) => p.topic === 'tph2:d:h').map((p) => p.data.count)).toEqual([1, 2, 2, 1, 2]);
	});

	it('a downstream window closes before an upstream closing state with a later boundary, while the cached clock lags', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installCachedClock(700);
		// u closes 500 ms after the hour, d on the hour. After a stall a load
		// closes u at B0+600, when the cached clock still reads before B0 and no
		// lead wake has marked d near.
		__registerAggregate('agg/tlag-d', live.aggregate('tlag:u:w', counter(), { topic: 'tlag:d', windows: { h: { type: 'tumbling', period: 'hour' } } }));
		const up = live.aggregate('tlag:src', counter(), { topic: 'tlag:u', windows: { w: { type: 'tumbling', durationMs: 10_000, anchor: 500 } } });
		__registerAggregate('agg/tlag-u', up);
		const platform = activate();

		platform.publish('tlag:src', 'inc', {});
		platform.publish('tlag:src', 'inc', {});
		vi.setSystemTime(B0 + 600);
		await up.__windowStreams.w();

		expect(platform.published.filter((p) => p.topic === 'tlag:d:h').map((p) => p.data.count)).toEqual([1, 2, 2, 1]);
	});

	it('an aggregate that feeds itself still closes its window', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const self = live.aggregate('tself:agg:m', counter(), { topic: 'tself:agg', windows: { m: minute } });
		__registerAggregate('agg/tself', self);
		const platform = activate();

		vi.setSystemTime(B0 + 5);
		await self.__windowStreams.m();
		expect(platform.published.filter((p) => p.topic === 'tself:agg:m').length).toBeGreaterThan(0);
	});

	it('a debounced downstream window does not publish its ended state after closing', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		__registerAggregate('agg/tdb-d', live.aggregate('tdb:up:m', counter(), { topic: 'tdb:down', debounce: 50, windows: { m: minute } }));
		__registerAggregate('agg/tdb-u', live.aggregate('tdb:src', counter(), { topic: 'tdb:up', windows: { m: minute } }));
		const platform = activate();
		const down = () => platform.published.filter((p) => p.topic === 'tdb:down:m');

		platform.publish('tdb:src', 'inc', {});
		platform.publish('tdb:src', 'inc', {});
		vi.advanceTimersByTime(2000 + 200);

		expect(down().map((p) => [p.at - B0, p.data.count])).toEqual([[-1950, 2], [0, 3]]);
	});

	it('an upstream window whose boundary comes after the closing one is left to close on its own', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		// u closes at :05 past each 10 s; d closes on the hour.
		const down = live.aggregate('tph:u:w', counter(), { topic: 'tph:d', windows: { h: { type: 'tumbling', period: 'hour' } } });
		__registerAggregate('agg/tph-d', down);
		__registerAggregate('agg/tph-u', live.aggregate('tph:src', counter(), { topic: 'tph:u', windows: { w: { type: 'tumbling', durationMs: 10_000, anchor: 5000 } } }));
		const platform = activate();
		const d = () => platform.published.filter((p) => p.topic === 'tph:d:h');

		platform.publish('tph:src', 'inc', {});
		platform.publish('tph:src', 'inc', {});
		// The event loop was stuck past both boundaries; the hour closes first.
		vi.setSystemTime(B0 + 6000);
		await down.__windowStreams.h();

		expect(d().map((p) => p.data.count)).toEqual([1, 2, 2]);
	});

	it('an upstream window whose name holds a colon still closes first', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const down = live.aggregate('tcol:up:per:min', counter(), { topic: 'tcol:down', windows: { m: minute } });
		__registerAggregate('agg/tcol-d', down);
		__registerAggregate('agg/tcol-u', live.aggregate('tcol:src', counter(), { topic: 'tcol:up', windows: { 'per:min': minute } }));
		const platform = activate();

		platform.publish('tcol:src', 'inc', {});
		platform.publish('tcol:src', 'inc', {});
		vi.setSystemTime(B0 + 5);
		await down.__windowStreams.m();

		expect(platform.published.filter((p) => p.topic === 'tcol:down:m' && p.at === B0 + 5).map((p) => p.data.count)).toEqual([3, 3]);
	});

	it('a downstream window closed by a load gets the upstream closing state first', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const down = live.aggregate('tlu:up:m', counter(), { topic: 'tlu:down', windows: { m: minute } });
		__registerAggregate('agg/tlu-d', down);
		__registerAggregate('agg/tlu-u', live.aggregate('tlu:src', counter(), { topic: 'tlu:up', windows: { m: minute } }));
		const platform = activate();

		platform.publish('tlu:src', 'inc', {});
		platform.publish('tlu:src', 'inc', {});
		vi.setSystemTime(B0 + 5);
		await down.__windowStreams.m();

		expect(platform.published.filter((p) => p.topic === 'tlu:down:m' && p.at === B0 + 5).map((p) => p.data.count)).toEqual([3, 3]);
	});

	it('a timer that wakes after the clock stepped back stops the exact-clock checks', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		let exactReads = 0;
		setRuntimeEnv({ clock: { now: () => Date.now(), wallEpoch: () => { exactReads++; return Date.now(); } } });
		const { platform } = registerTumbling('tback', { type: 'tumbling', period: 'minute' });

		vi.advanceTimersByTime(1960);
		vi.setSystemTime(B0 - 10_040);
		vi.advanceTimersByTime(40);
		exactReads = 0;
		for (let i = 0; i < 10; i++) platform.publish('tback:src', 'inc', {});
		expect(exactReads).toBe(0);
	});

	it('a falsy anchor anchors fixed-duration windows at 0', () => {
		vi.useFakeTimers({ now: 1500 });
		installExactNow();
		const { out } = registerTumbling('tfalsy', { type: 'tumbling', durationMs: 1000, anchor: '' });

		vi.advanceTimersByTime(500);
		expect(out().map((p) => p.at)).toEqual([2000]);
	});

	it('a window loaded after the boundary serves the new window', async () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const { fn, platform, out } = registerTumbling('tload', { type: 'tumbling', period: 'minute' });

		platform.publish('tload:src', 'inc', {});
		platform.publish('tload:src', 'inc', {});
		vi.setSystemTime(B0 + 5);

		const loaded = await fn.__windowStreams.w();
		expect(loaded.count).toBe(0);
		// Subscribers already on the stream saw the closing state.
		expect(out().map((p) => p.data.count)).toEqual([1, 2, 2]);
	});

	it('a timer that wakes before the boundary (clock stepped back) does not close early', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const { platform, out } = registerTumbling('tearly', { type: 'tumbling', period: 'minute' });

		platform.publish('tearly:src', 'inc', {});
		// Step the wall clock back 3 s. The timer keeps its relative due time, so
		// it now wakes 3 s before the wall-clock boundary.
		vi.setSystemTime(B0 - 5000);
		vi.advanceTimersByTime(2000);
		expect(out().length).toBe(1);

		vi.advanceTimersByTime(2999);
		expect(out().length).toBe(1);
		vi.advanceTimersByTime(1);
		expect(out().length).toBe(2);
		expect(out()[1].at).toBe(B0);
	});
});

describe('tumbling periods across DST changes', () => {
	function closes(name, spec, from, to) {
		const start = Date.parse(from), end = Date.parse(to);
		vi.useFakeTimers({ now: start });
		installExactNow();
		const { out } = registerTumbling(name, spec);
		// A minute at a time, stopping once there are more closes than minutes:
		// a window closing on every tick fails here instead of running for hours.
		for (let t = start; t < end && out().length <= (t - start) / 60_000 + 1; t += 60_000) {
			vi.advanceTimersByTime(Math.min(60_000, end - t));
		}
		return out().map((p) => new Date(p.at).toISOString().slice(0, 16));
	}

	it('New York hours when the clocks go back: the repeated hour is one window', () => {
		expect(closes('dnyh', { type: 'tumbling', period: 'hour', tz: 'America/New_York' }, '2026-11-01T04:30:00Z', '2026-11-01T09:30:00Z'))
			.toEqual(['2026-11-01T05:00', '2026-11-01T07:00', '2026-11-01T08:00', '2026-11-01T09:00']);
	});

	it('New York minutes when the clocks go back still close every minute', () => {
		expect(closes('dnym', { type: 'tumbling', period: 'minute', tz: 'America/New_York' }, '2026-11-01T05:57:30Z', '2026-11-01T06:02:30Z'))
			.toEqual(['2026-11-01T05:58', '2026-11-01T05:59', '2026-11-01T06:00', '2026-11-01T06:01', '2026-11-01T06:02']);
	});

	it('a New York day when the clocks go back lasts 25 hours', () => {
		expect(closes('dnyd', { type: 'tumbling', period: 'daily', tz: 'America/New_York' }, '2026-10-31T12:00:00Z', '2026-11-03T06:00:00Z'))
			.toEqual(['2026-11-01T04:00', '2026-11-02T05:00', '2026-11-03T05:00']);
	});

	it('Berlin hours when the clocks go forward skip the missing hour', () => {
		expect(closes('dbeh', { type: 'tumbling', period: 'hour', tz: 'Europe/Berlin' }, '2026-03-28T23:30:00Z', '2026-03-29T02:30:00Z'))
			.toEqual(['2026-03-29T00:00', '2026-03-29T01:00', '2026-03-29T02:00']);
	});

	it('Chatham hours when the clocks go back across an hour start a window at the change', () => {
		// 03:45 +13:45 becomes 02:45 +12:45 at 14:00Z.
		expect(closes('dchh', { type: 'tumbling', period: 'hour', tz: 'Pacific/Chatham' }, '2026-04-04T13:25:00Z', '2026-04-04T15:30:00Z'))
			.toEqual(['2026-04-04T14:00', '2026-04-04T14:15', '2026-04-04T15:15']);
	});

	it('Berlin minutes when the clocks go forward still close every minute', () => {
		expect(closes('dbem', { type: 'tumbling', period: 'minute', tz: 'Europe/Berlin' }, '2026-03-29T00:57:30Z', '2026-03-29T01:02:30Z'))
			.toEqual(['2026-03-29T00:58', '2026-03-29T00:59', '2026-03-29T01:00', '2026-03-29T01:01', '2026-03-29T01:02']);
	});
});

describe('privacy across a tumbling boundary', () => {
	function registerPrivate(name, privacy) {
		realtime({ privacySecret: SECRET });
		const fn = live.aggregate(`${name}:src`, counter(), {
			topic: `${name}:agg`,
			privacy,
			windows: { w: { type: 'tumbling', period: 'minute' } }
		});
		__registerAggregate(`agg/${name}`, fn);
		const platform = timedPlatform();
		_activateDerived(platform);
		setCronPlatform(platform);
		return { platform, out: () => platform.published.filter((p) => p.topic === `${name}:agg:w`) };
	}

	for (const closer of ['timer', 'event']) {
		it(`a window closed by its ${closer} publishes with its own noise, and the next draws new noise`, () => {
			vi.useFakeTimers({ now: B0 - 2000 });
			installExactNow();
			const { platform, out } = registerPrivate(`pn${closer}`, { strategy: 'perturb', epsilon: 1, sensitivity: 1 });

			platform.publish(`pn${closer}:src`, 'inc', {});
			platform.publish(`pn${closer}:src`, 'inc', {});
			const [v1, v2] = out().map((p) => p.data.count);
			if (closer === 'timer') vi.advanceTimersByTime(2000);
			else { vi.advanceTimersByTime(1990); vi.setSystemTime(B0 + 5); }
			platform.publish(`pn${closer}:src`, 'inc', {});

			const [, , closing, w1] = out().map((p) => p.data.count);
			// Same state, same window seed: the closing value repeats the last one.
			expect(closing).toBe(v2);
			expect(Math.abs((w1 - 1) - (v1 - 1))).toBeGreaterThan(1e-6);
		});
	}

	it('a window whose init() throws keeps its noise along with its state', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			realtime({ privacySecret: SECRET });
			let failing = false;
			const fn = live.aggregate('pinit:src', {
				count: { init: () => { if (failing) throw new Error('init failed'); return 0; }, reduce: (a) => a + 1 }
			}, {
				topic: 'pinit:agg',
				privacy: { strategy: 'perturb', epsilon: 1, sensitivity: 1 },
				windows: { w: { type: 'tumbling', period: 'minute' } }
			});
			__registerAggregate('agg/pinit', fn);
			const platform = timedPlatform();
			_activateDerived(platform);
			setCronPlatform(platform);
			const out = () => platform.published.filter((p) => p.topic === 'pinit:agg:w');

			platform.publish('pinit:src', 'inc', {});
			failing = true;
			vi.advanceTimersByTime(2000 + 3 * 60_000);
			// Same state at every boundary: the same value, never fresh noise to
			// average over.
			const values = out().map((p) => p.data.count);
			expect(values.length).toBe(5);
			expect(new Set(values).size).toBe(1);
		} finally {
			errors.mockRestore();
		}
	});

	it('a window whose init() throws keeps its k-anonymity cohort along with its state', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			let failing = false;
			const fn = live.aggregate('pkeep:src', {
				count: { init: () => { if (failing) throw new Error('init failed'); return 0; }, reduce: (a) => a + 1 }
			}, {
				topic: 'pkeep:agg',
				privacy: { strategy: 'suppress', k: 2, contributor: (d) => d.u },
				windows: { w: { type: 'tumbling', period: 'minute' } }
			});
			__registerAggregate('agg/pkeep', fn);
			const platform = timedPlatform();
			_activateDerived(platform);
			setCronPlatform(platform);
			const out = () => platform.published.filter((p) => p.topic === 'pkeep:agg:w');

			platform.publish('pkeep:src', 'inc', { u: 'a' });
			platform.publish('pkeep:src', 'inc', { u: 'b' });
			failing = true;
			vi.advanceTimersByTime(2000);
			// One contributor after the boundary still clears k: the cohort was kept.
			platform.publish('pkeep:src', 'inc', { u: 'a' });
			expect(out().map((p) => p.data.count)).toEqual([2, 2, 3]);
		} finally {
			errors.mockRestore();
		}
	});

	it('a new window counts its k-anonymity cohort from zero', () => {
		vi.useFakeTimers({ now: B0 - 2000 });
		installExactNow();
		const { platform, out } = registerPrivate('pk', { strategy: 'suppress', k: 2, contributor: (d) => d.u });

		platform.publish('pk:src', 'inc', { u: 'a' });
		expect(out().length).toBe(0);
		platform.publish('pk:src', 'inc', { u: 'b' });
		expect(out().map((p) => p.data.count)).toEqual([2]);
		vi.advanceTimersByTime(2000);
		expect(out().map((p) => p.data.count)).toEqual([2, 2]);

		platform.publish('pk:src', 'inc', { u: 'a' });
		expect(out().length).toBe(2);
	});
});

describe('tumbling windows longer than the timer limit', () => {
	// setTimeout stores its delay in 32 bits: anything over ~24.85 days fires
	// after 1 ms instead, and every month is longer than that. A timer that
	// wakes every millisecond reads the exact clock each time, so counting the
	// reads catches it before the wait is over.
	function installCountingClock() {
		const reads = { n: 0 };
		setRuntimeEnv({ clock: { now: () => Date.now(), wallEpoch: () => { reads.n++; return Date.now(); } } });
		return reads;
	}

	it('a monthly window waits for the month boundary', () => {
		const start = Date.UTC(2026, 9, 1, 0, 0, 0, 1);
		const end = Date.UTC(2026, 10, 1, 0, 0, 0, 0);
		vi.useFakeTimers({ now: start });
		const reads = installCountingClock();
		const { platform, out } = registerTumbling('tmonth', { type: 'tumbling', period: 'monthly', tz: 'UTC' });

		platform.publish('tmonth:src', 'inc', {});
		reads.n = 0;
		vi.advanceTimersByTime(100);
		expect(reads.n).toBe(0);
		expect(out().length).toBe(1);

		vi.advanceTimersByTime(end - start - 100 - 1);
		expect(out().length).toBe(1);
		vi.advanceTimersByTime(1);
		expect(out().length).toBe(2);
		expect(out()[1].data.count).toBe(1);
		expect(out()[1].at).toBe(end);
	});

	it('a fixed-duration window longer than the limit waits for its boundary', () => {
		const duration = 30 * 86_400_000;
		vi.useFakeTimers({ now: 1 });
		const reads = installCountingClock();
		const { platform, out } = registerTumbling('tlong', { type: 'tumbling', durationMs: duration });

		platform.publish('tlong:src', 'inc', {});
		reads.n = 0;
		vi.advanceTimersByTime(100);
		expect(reads.n).toBe(0);
		expect(out().length).toBe(1);
		vi.advanceTimersByTime(duration - 102);
		expect(out().length).toBe(1);
		vi.advanceTimersByTime(1);
		expect(out().length).toBe(2);
		expect(out()[1].at).toBe(duration);
	});
});

describe('tumbling window specs that would close on every tick', () => {
	it('a fixed-duration boundary that rounds onto the current time moves past it', () => {
		// With this anchor and duration, float rounding puts the next boundary
		// exactly on `now`. The clock throws on a spin so the test fails fast.
		const now = 1_790_000_000_072;
		vi.useFakeTimers({ now });
		let reads = 0;
		setRuntimeEnv({ clock: { now: () => Date.now(), wallEpoch: () => { if (++reads > 10_000) throw new Error('spin'); return Date.now(); } } });
		const { out } = registerTumbling('tround', { type: 'tumbling', durationMs: 7.7, anchor: -8.64e15 });

		vi.advanceTimersByTime(77);
		expect(out().length).toBeGreaterThanOrEqual(9);
		expect(out().length).toBeLessThanOrEqual(11);
		for (let i = 1; i < out().length; i++) expect(out()[i].at).toBeGreaterThan(out()[i - 1].at);
	});

	it('refuses an anchor outside the Date range and a duration under 1 ms', () => {
		const define = (spec) => () => live.aggregate('vspec:src', counter(), { topic: 'vspec:agg', windows: { w: { type: 'tumbling', ...spec } } });
		expect(define({ durationMs: 1000, anchor: 1.8e18 })).toThrow(/within the Date range/);
		expect(define({ durationMs: 1000, anchor: -8.64e15 - 1 })).toThrow(/within the Date range/);
		expect(define({ durationMs: 0.5 })).toThrow(/at least 1/);
		expect(define({ durationMs: 1000, anchor: 8.64e15 })).not.toThrow();
		expect(define({ durationMs: 1 })).not.toThrow();
	});
});

describe('sliding window noise is fresh on every slide', () => {
	function registerNoisySliding(name) {
		realtime({ privacySecret: SECRET });
		const fn = live.aggregate(`${name}:src`, {
			count: { init: () => 0, reduce: (acc) => acc + 1, combine: combineSum }
		}, {
			topic: `${name}:agg`,
			privacy: { strategy: 'perturb', epsilon: 1, sensitivity: 1 },
			windows: { w: { type: 'sliding', durationMs: 1000, slideMs: 250 } }
		});
		__registerAggregate(`agg/${name}`, fn);
		const platform = timedPlatform();
		_activateDerived(platform);
		setCronPlatform(platform);
		return () => platform.published.filter((p) => p.topic === `${name}:agg:w`).map((p) => p.data.count);
	}

	it('slides shorter than the cached clock resolution each draw new noise', () => {
		vi.useFakeTimers({ now: B0 });
		installCachedClock(300);
		const values = registerNoisySliding('snoise');

		vi.advanceTimersByTime(250 * 12);
		const v = values();
		expect(v.length).toBe(12);
		expect(new Set(v).size).toBe(v.length);
	});

	it('a clock stepped back between slides never reuses the noise of an earlier slide', () => {
		vi.useFakeTimers({ now: B0 });
		installExactNow();
		const values = registerNoisySliding('sstep');

		vi.advanceTimersByTime(250 * 4);
		vi.setSystemTime(Date.now() - 600);
		vi.advanceTimersByTime(250 * 4);
		const v = values();
		expect(v.length).toBe(8);
		expect(new Set(v).size).toBe(v.length);
	});
});
