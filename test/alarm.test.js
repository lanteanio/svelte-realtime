// live.alarm: per-room durable alarm primitive. v1 = realtime in-memory scheduler
// + store seam. Tests the alarm mechanism via _bindAlarmCtx (the same binding the
// stream loader-dispatch establishes) + the option validation + the ctx defaults.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, configureAlarm, _resetAlarms } from '../src/server.js';
import { _bindAlarmCtx, _pollAlarms } from '../src/server/alarm.js';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { state, registry } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe('live.alarm', () => {
	let platform;
	let savedCron;
	beforeEach(() => {
		savedCron = state.cronPlatform;
		platform = mockPlatform();
		state.cronPlatform = platform;
	});
	afterEach(() => {
		_resetAlarms();
		configureAlarm(null);
		state.cronPlatform = savedCron;
	});

	function alarmCtx(wireTopic, onAlarm) {
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		_bindAlarmCtx(ctx, { wireTopic, onAlarm });
		return ctx;
	}

	it('set / get / delete the room alarm', () => {
		const ctx = alarmCtx('room:1', () => {});
		expect(ctx.getAlarm()).toBeNull();
		const at = Date.now() + 100000;
		ctx.setAlarm(at);
		expect(ctx.getAlarm()).toBe(at);
		ctx.deleteAlarm();
		expect(ctx.getAlarm()).toBeNull();
	});

	it('ctx.setAlarm/deleteAlarm throw outside an alarm-enabled stream; getAlarm returns null', () => {
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		expect(() => ctx.setAlarm(Date.now() + 1000)).toThrow(/alarm/i);
		expect(() => ctx.deleteAlarm()).toThrow(/alarm/i);
		expect(ctx.getAlarm()).toBeNull();
	});

	it('rejects a non-finite at', () => {
		const ctx = alarmCtx('room:bad', () => {});
		expect(() => ctx.setAlarm(NaN)).toThrow(/finite/);
		expect(() => ctx.setAlarm('soon')).toThrow(/finite/);
		expect(() => ctx.setAlarm(Infinity)).toThrow(/finite/);
	});

	it('fires onAlarm at the scheduled time with no subscribers', async () => {
		let fired = 0;
		const ctx = alarmCtx('room:fire', () => { fired++; });
		ctx.setAlarm(Date.now() + 5);
		await tick(30);
		expect(fired).toBe(1);
	});

	it('is one-shot: after firing the alarm is gone and does not re-fire', async () => {
		let fired = 0;
		const ctx = alarmCtx('room:once', () => { fired++; });
		ctx.setAlarm(Date.now() + 5);
		await tick(30);
		expect(fired).toBe(1);
		expect(ctx.getAlarm()).toBeNull();
		await tick(20);
		expect(fired).toBe(1);
	});

	it('one alarm per room: setAlarm replaces the pending one', async () => {
		let which = 0;
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		_bindAlarmCtx(ctx, { wireTopic: 'room:replace', onAlarm: () => { which = 1; } });
		ctx.setAlarm(Date.now() + 5);
		_bindAlarmCtx(ctx, { wireTopic: 'room:replace', onAlarm: () => { which = 2; } });
		ctx.setAlarm(Date.now() + 5); // replaces - the first timer must be cancelled
		await tick(30);
		expect(which).toBe(2);
	});

	it('deleteAlarm before the fire cancels it', async () => {
		let fired = 0;
		const ctx = alarmCtx('room:cancel', () => { fired++; });
		ctx.setAlarm(Date.now() + 15);
		ctx.deleteAlarm();
		await tick(35);
		expect(fired).toBe(0);
	});

	it('onAlarm receives a fresh ctx that can re-arm (TTL refresh) and publish to its room', async () => {
		let runs = 0;
		let sawPublish = false;
		const ctx = alarmCtx('room:rearm', (c) => {
			runs++;
			expect(typeof c.publish).toBe('function');
			expect(typeof c.setAlarm).toBe('function');
			c.publish('ping', { runs }); // room-scoped publish, must not throw
			sawPublish = true;
			if (runs === 1) c.setAlarm(Date.now() + 5); // re-arm once
		});
		ctx.setAlarm(Date.now() + 5);
		await tick(40);
		expect(runs).toBe(2); // fired, re-armed inside onAlarm, fired again
		expect(sawPublish).toBe(true);
	});

	it('a past at fires on the next tick (fire-ASAP, not an error)', async () => {
		let fired = 0;
		const ctx = alarmCtx('room:past', () => { fired++; });
		ctx.setAlarm(Date.now() - 10000);
		await tick(20);
		expect(fired).toBe(1);
	});

	it('a far-future alarm (> the ~24.8-day setTimeout cap) does not fire early and stays pending', async () => {
		// Regression for the setTimeout 32-bit-delay clamp: a delay > 2^31-1 ms is
		// clamped to ~0 and would fire almost immediately. The scheduler must hop
		// toward the real deadline instead.
		let fired = 0;
		const ctx = alarmCtx('room:far', () => { fired++; });
		const at = Date.now() + 40 * 24 * 60 * 60 * 1000; // 40 days
		ctx.setAlarm(at);
		await tick(40);
		expect(fired).toBe(0); // must NOT fire immediately
		expect(ctx.getAlarm()).toBe(at); // still pending toward the real deadline
	});

	describe('cluster leader gate', () => {
		it('a non-leader does not fire', async () => {
			configureAlarm({ leader: () => false });
			let fired = 0;
			const ctx = alarmCtx('room:noleader', () => { fired++; });
			ctx.setAlarm(Date.now() + 5);
			await tick(30);
			expect(fired).toBe(0);
		});

		it('the leader fires', async () => {
			configureAlarm({ leader: () => true });
			let fired = 0;
			const ctx = alarmCtx('room:leader', () => { fired++; });
			ctx.setAlarm(Date.now() + 5);
			await tick(30);
			expect(fired).toBe(1);
		});

		it('a throwing leader fails closed (no fire)', async () => {
			configureAlarm({ leader: () => { throw new Error('boom'); } });
			let fired = 0;
			const ctx = alarmCtx('room:leadererr', () => { fired++; });
			ctx.setAlarm(Date.now() + 5);
			await tick(30);
			expect(fired).toBe(0);
		});
	});

	describe('store seam', () => {
		it('mirrors set/delete to a wired durable store', () => {
			const ops = [];
			configureAlarm({ store: { set: (t, at) => ops.push(['set', t, at]), delete: (t) => ops.push(['delete', t]), due: () => [] } });
			const ctx = alarmCtx('room:store', () => {});
			const at = Date.now() + 100000;
			ctx.setAlarm(at);
			ctx.deleteAlarm();
			expect(ops).toEqual([['set', 'room:store', at], ['delete', 'room:store']]);
		});

		it('passes the resolver meta (path/tenantId) to store.set', () => {
			let captured;
			configureAlarm({ store: { set: (t, at, meta) => { captured = meta; }, delete: () => true, due: () => [] } });
			const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
			_bindAlarmCtx(ctx, { wireTopic: '@t/acme/room:7', onAlarm: () => {}, path: 'rooms/messages', tenantId: 'acme' });
			ctx.setAlarm(Date.now() + 1000);
			expect(captured).toEqual({ path: 'rooms/messages', tenantId: 'acme' });
		});
	});

	describe('durable recovery poll', () => {
		// A minimal in-memory durable store: topic -> { at, meta }. delete() returns
		// the atomic-claim boolean; due() returns rows with at <= now.
		function memStore() {
			const rows = new Map();
			return {
				rows,
				set: (t, at, meta) => { rows.set(t, { at, meta: meta ?? null }); },
				delete: (t) => { const had = rows.has(t); rows.delete(t); return had; },
				due: (now) => [...rows.entries()].filter(([, r]) => r.at <= now).map(([t, r]) => ({ topic: t, at: r.at, meta: r.meta }))
			};
		}

		const registered = [];
		function registerAlarmStream(path, onAlarm) {
			const fn = live.stream('topic:' + path, () => ({}), { alarm: { onAlarm } });
			registry.set(path, fn);
			registered.push(path);
			return fn;
		}
		afterEach(() => { for (const p of registered) registry.delete(p); registered.length = 0; });

		it('fires an orphaned due alarm by re-resolving onAlarm from the persisted path', async () => {
			let fired = null;
			registerAlarmStream('rooms/orphan', (c) => { fired = c; });
			const store = memStore();
			configureAlarm({ store });
			// Simulate an alarm armed before a restart: only the durable row exists
			// (no in-memory _pending entry anywhere), already overdue.
			store.set('room:orphan', Date.now() - 1000, { path: 'rooms/orphan', tenantId: null });
			await _pollAlarms();
			expect(fired).not.toBeNull();
			expect(typeof fired.publish).toBe('function');
			expect(store.rows.has('room:orphan')).toBe(false); // claimed (single-fire)
		});

		it('skips a topic still live in _pending (the owner timer fires it)', async () => {
			let pollFired = 0;
			registerAlarmStream('rooms/live', () => { pollFired++; });
			const store = memStore();
			configureAlarm({ store });
			// Arm a live future in-memory alarm (stays in _pending)...
			const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
			_bindAlarmCtx(ctx, { wireTopic: 'room:live', onAlarm: () => {}, path: 'rooms/live', tenantId: null });
			ctx.setAlarm(Date.now() + 100000);
			// ...but desync the durable row to overdue so due() returns it.
			store.rows.set('room:live', { at: Date.now() - 1000, meta: { path: 'rooms/live' } });
			await _pollAlarms();
			expect(pollFired).toBe(0); // poll deferred to the live timer
			expect(store.rows.has('room:live')).toBe(true); // not claimed by the poll
		});

		it('does not fire when the claim is lost (delete returns false)', async () => {
			let fired = 0;
			registerAlarmStream('rooms/claimed', () => { fired++; });
			const store = {
				set: () => {}, due: () => [{ topic: 'room:claimed', at: Date.now() - 1, meta: { path: 'rooms/claimed' } }],
				delete: () => false // another instance already claimed it
			};
			configureAlarm({ store });
			await _pollAlarms();
			expect(fired).toBe(0);
		});

		it('garbage-collects a stale row whose stream was removed (claims, never fires)', async () => {
			const store = memStore();
			configureAlarm({ store });
			store.set('room:gone', Date.now() - 1000, { path: 'rooms/does-not-exist' });
			await _pollAlarms();
			expect(store.rows.has('room:gone')).toBe(false); // claimed + dropped, can't accumulate
		});

		it('the recovery poll is leader-gated', async () => {
			let fired = 0;
			registerAlarmStream('rooms/gated', () => { fired++; });
			const store = memStore();
			store.set('room:gated', Date.now() - 1000, { path: 'rooms/gated' });

			configureAlarm({ store, leader: () => false });
			await _pollAlarms();
			expect(fired).toBe(0); // non-leader does not sweep
			expect(store.rows.has('room:gated')).toBe(true);

			configureAlarm({ store, leader: () => true });
			await _pollAlarms();
			expect(fired).toBe(1); // leader recovers it
			expect(store.rows.has('room:gated')).toBe(false);
		});

		it('a store without due() runs no poll and does not throw', async () => {
			let fired = 0;
			registerAlarmStream('rooms/nodue', () => { fired++; });
			configureAlarm({ store: { set: () => {}, delete: () => true } });
			await _pollAlarms(); // guarded: no due -> no-op
			expect(fired).toBe(0);
		});
	});

	describe('live.stream alarm option', () => {
		it('accepts a valid alarm config and marks __streamOptions.alarm', () => {
			const onAlarm = () => {};
			const s = live.stream('room:opt', () => ({}), { alarm: { onAlarm } });
			expect(s.__streamOptions.alarm.onAlarm).toBe(onAlarm);
		});

		it('rejects a malformed alarm config at declaration time', () => {
			expect(() => live.stream('room:bad1', () => ({}), { alarm: {} })).toThrow(/onAlarm/);
			expect(() => live.stream('room:bad2', () => ({}), { alarm: { onAlarm: 'nope' } })).toThrow(/onAlarm/);
			expect(() => live.stream('room:bad3', () => ({}), { alarm: 42 })).toThrow(/alarm/);
		});
	});

	describe('configureAlarm validation', () => {
		it('rejects a bad store / leader and requires at least one field', () => {
			expect(() => configureAlarm({})).toThrow(/at least one/);
			expect(() => configureAlarm({ store: {} })).toThrow(/store must implement/);
			expect(() => configureAlarm({ leader: 'x' })).toThrow(/leader must be a function/);
			expect(() => configureAlarm(42)).toThrow(/object or null/);
			expect(() => configureAlarm(null)).not.toThrow();
		});
	});
});
