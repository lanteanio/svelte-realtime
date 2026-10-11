import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { live, __registerCron, setCronPlatform, configureCron, _clearCron, _tickCron } from '../src/server.js';
import { _stopCronScheduler, _cronIntrospect } from '../src/server/cron-engine.js';
import { resetRuntimeEnv, setRuntimeEnv } from '../src/shared/runtime.js';
import { _resetLazy } from '../src/server/lazy.js';
import { _lazyQueue } from '../src/server/state.js';

const origin = Date.UTC(2026, 0, 1);
let wall, lag, timers;
function installClock() {
	wall = origin + 123; lag = 900; timers = new Map();
	const arm = (callback, delay, interval = false) => {
		const handle = { callback, due: wall + delay, delay, interval, unref() {} };
		timers.set(handle, handle); return handle;
	};
	setRuntimeEnv({ tz: 'UTC', clock: {
		wallEpoch: () => wall, now: () => Math.floor((wall - lag) / 1000) * 1000, monotonic: () => wall
	}, timers: {
		set: (fn, ms) => arm(fn, ms), clear: h => timers.delete(h),
		setInterval: (fn, ms) => arm(fn, ms, true), clearInterval: h => timers.delete(h)
	} });
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function wake(lateness = 0) {
	const next = [...timers.values()].sort((a, b) => a.due - b.due)[0];
	expect(next, 'scheduler must remain armed').toBeDefined();
	wall = Math.max(wall, next.due) + lateness;
	if (next.interval) next.due = wall + next.delay;
	else timers.delete(next);
	await next.callback(); await flush(); return next;
}
function register(path, schedule, calls) {
	__registerCron(path, live.cron(schedule, path, () => { calls.push(wall - origin); }));
}

beforeEach(() => {
	_clearCron(); configureCron({ leader: null }); _resetLazy(); _lazyQueue.length = 0;
	installClock(); setCronPlatform({ publish() {} });
});
afterEach(() => { configureCron({ leader: null }); _clearCron(); _lazyQueue.length = 0; _resetLazy(); resetRuntimeEnv(); });

describe('cron wall-clock boundaries', () => {
	it.each(['follower', 'error'])('does not replay a minute observed before gaining leadership from %s', async (mode) => {
		let leader = false;
		configureCron({ leader: () => {
			if (!leader && mode === 'error') throw new Error('Lease unavailable');
			return leader;
		} });
		const minutes = [], seconds = [];
		register('minutes', '* * * * *', minutes);
		register('seconds', '* * * * * *', seconds);
		await wake();
		wall = origin + 15000;
		leader = true;
		await wake();
		expect(minutes).toEqual([]);
		expect(seconds).toEqual([15000]);
		wall = origin + 60000;
		await wake();
		expect(minutes).toEqual([60000]);
	});

	it('evaluates each matching minute once despite repeated timer drift and cached-clock lag', async () => {
		const calls = []; register('minutes', '* * * * *', calls);
		for (let i = 0; i < 122; i++) { lag = i % 2 ? 900 : 100; await wake(500); }
		expect(calls.map(at => Math.floor(at / 60000))).toEqual(Array.from({ length: 122 }, (_, i) => i));
	});

	it('evaluates each second once when startup overlaps an aligned wakeup', async () => {
		const calls = []; register('seconds', '* * * * * *', calls);
		for (let i = 0; i < 82; i++) await wake(400);
		expect(calls.map(at => Math.floor(at / 1000))).toEqual(Array.from({ length: 81 }, (_, i) => i + 1));
	});

	it('coalesces a long pause independently for minute and second schedules', async () => {
		const minutes = [], seconds = [];
		register('minutes', '* * * * *', minutes); register('seconds', '* * * * * *', seconds);
		await wake(); wall = origin + 122500; await wake();
		expect(minutes.map(at => Math.floor(at / 60000))).toEqual([0, 2]);
		expect(seconds.map(at => Math.floor(at / 1000))).toEqual([1, 122]);
		await wake();
		expect(minutes).toHaveLength(2); expect(seconds.at(-1)).toBe(123000);
	});

	it('ignores an already delivered callback without firing or adding another timer', async () => {
		const calls = []; register('minutes', '* * * * *', calls);
		const callback = (await wake()).callback;
		const armed = [...timers.keys()]; await callback(); await flush();
		expect(calls).toHaveLength(1); expect([...timers.keys()]).toEqual(armed);
	});

	it('does not repeat evaluated minutes or seconds after wall-clock rollback', async () => {
		const minutes = [], seconds = [];
		register('minutes', '* * * * *', minutes); register('seconds', '* * * * * *', seconds);
		wall = origin + 122000; await wake();
		const callback = [...timers.values()].sort((a, b) => a.due - b.due)[0];
		timers.delete(callback); wall = origin + 61000; await callback.callback(); await flush();
		expect(minutes.map(at => Math.floor(at / 60000))).toEqual([2]);
		expect(seconds.map(at => Math.floor(at / 1000))).toEqual([122]);
		wall = origin + 180000; await wake();
		expect(minutes.map(at => Math.floor(at / 60000))).toEqual([2, 3]);
		expect(seconds.map(at => Math.floor(at / 1000))).toEqual([122, 180]);
	});

	it('upgrades minute scheduling without repeating its evaluated slot or honoring canceled callbacks', async () => {
		const minutes = [], seconds = []; register('minutes', '* * * * *', minutes);
		await wake(); const stale = [...timers.values()][0];
		register('seconds', '* * * * * *', seconds);
		await stale.callback(); await flush();
		expect(timers.size).toBe(1); expect(_cronIntrospect().secondResolution).toBe(true);
		await wake(); expect(minutes).toHaveLength(1); expect(seconds).toHaveLength(1);
	});

	it('stops queued callbacks without rearming and resets slot ownership for a fresh registration', async () => {
		const first = []; register('minutes', '* * * * *', first);
		const stale = [...timers.values()]; _stopCronScheduler();
		for (const timer of stale) await timer.callback();
		expect(timers.size).toBe(0); expect(first).toEqual([]);
		expect(_cronIntrospect().schedulerActive).toBe(false);
		_clearCron(); const fresh = []; register('minutes', '* * * * *', fresh);
		await wake(); expect(fresh).toHaveLength(1);
	});

	it.each([[false, false], [false, true], [true, false], [true, true]])('rechecks lazy startup ownership with stopped=%s and seconds=%s', async (stopped, seconds) => {
		let resolve; const calls = [];
		const loader = () => new Promise(r => { resolve = r; }); loader.__lazy = true;
		__registerCron('lazy', loader);
		const startup = [...timers.values()].sort((a, b) => a.due - b.due)[0];
		timers.delete(startup); wall = startup.due;
		const pending = startup.callback(); await flush();
		wall = origin + 122500;
		if (stopped) _stopCronScheduler();
		resolve(live.cron(seconds ? '* * * * * *' : '* * * * *', 'lazy', () => { calls.push(wall - origin); }));
		await pending; await flush();
		expect(calls).toEqual(stopped ? [] : [122500]);
		if (stopped) expect(timers.size).toBe(0);
	});

	it('keeps explicit manual ticks forceable within one minute', async () => {
		const calls = []; register('minutes', '* * * * *', calls);
		await _tickCron(); await flush(); await _tickCron(); await flush();
		expect(calls).toHaveLength(2);
	});
});
