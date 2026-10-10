import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { live, configureAlarm, _resetAlarms } from '../src/server.js';
import { _bindAlarmCtx, _pollAlarms } from '../src/server/alarm.js';
import { state, registry } from '../src/server/state.js';
import { _runShutdown, _resetLifecycle, inFlightCount } from '../src/server/lifecycle.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { memoryAlarmStore } from './helpers/alarm-store.js';

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

const topic = 'room:durable';
const meta = { path: 'rooms/durable', tenantId: null };

describe('durable alarm generations', () => {
	let savedPlatform, store, fired, ctx;
	beforeEach(() => {
		_resetLifecycle();
		vi.useFakeTimers();
		vi.setSystemTime(10000);
		savedPlatform = state.cronPlatform;
		state.cronPlatform = mockPlatform();
		store = memoryAlarmStore();
		fired = vi.fn();
		registry.set(meta.path, live.stream(topic, () => ({}), { alarm: { onAlarm: fired } }));
		ctx = {};
		_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm: fired, ...meta });
		configureAlarm({ store, pollMs: 100000 });
	});
	afterEach(() => {
		_resetAlarms();
		configureAlarm(null);
		state.cronPlatform = savedPlatform;
		registry.delete(meta.path);
		_resetLifecycle();
		vi.useRealTimers();
	});

	it('rejects legacy topic-only stores instead of silently accepting unfenced claims', () => {
		expect(() => configureAlarm({ store: { set() {}, delete() {} } })).toThrow(/nextGeneration/);
	});

	it('awaits a committed write before arming and propagates storage rejection', async () => {
		const entered = deferred();
		const release = deferred();
		const commit = store.set;
		store.set = async (...args) => { entered.resolve(); await release.promise; return commit(...args); };
		let acknowledged = false;
		const pending = ctx.setAlarm(10010).then(() => { acknowledged = true; });
		await entered.promise;
		await vi.advanceTimersByTimeAsync(20);
		expect(acknowledged).toBe(false);
		expect(ctx.getAlarm()).toBeNull();
		expect(fired).not.toHaveBeenCalled();
		release.resolve();
		await pending;
		await vi.advanceTimersByTimeAsync(0);
		expect(fired).toHaveBeenCalledTimes(1);
		store.set = async () => { throw new Error('write failed'); };
		await expect(ctx.setAlarm(11000)).rejects.toThrow('write failed');
		expect(ctx.getAlarm()).toBeNull();
		store.set = commit;
		await ctx.setAlarm(12000);
		expect(store.get(topic).at).toBe(12000);
	});

	it('keeps an acknowledged timer when a replacement write fails', async () => {
		await ctx.setAlarm(11000);
		store.set = async () => { throw new Error('replacement failed'); };
		await expect(ctx.setAlarm(12000)).rejects.toThrow('replacement failed');
		expect(ctx.getAlarm()).toBe(11000);
		expect(store.get(topic)).toMatchObject({ at: 11000, generation: '1' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(fired).toHaveBeenCalledTimes(1);
		expect(fired.mock.calls[0][0].alarm.at).toBe(11000);
	});

	it('serializes a slow old write before a newer local schedule', async () => {
		const entered = deferred();
		const release = deferred();
		const commit = store.set;
		const calls = [];
		store.set = async (...args) => {
			calls.push(args[1]);
			if (calls.length === 1) { entered.resolve(); await release.promise; }
			return commit(...args);
		};
		const old = ctx.setAlarm(11000);
		await entered.promise;
		const newer = ctx.setAlarm(12000);
		await Promise.resolve();
		expect(calls).toEqual([11000]);
		release.resolve();
		await Promise.all([old, newer]);
		expect(calls).toEqual([11000, 12000]);
		expect(store.get(topic).at).toBe(12000);
		expect(ctx.getAlarm()).toBe(12000);
	});

	it('rejects a delayed old generation after another worker acknowledges a newer write', async () => {
		const entered = deferred();
		const release = deferred();
		const commit = store.set;
		store.set = async (...args) => { entered.resolve(); await release.promise; return commit(...args); };
		const old = ctx.setAlarm(11000);
		const rejected = expect(old).rejects.toThrow(/superseded/);
		await entered.promise;
		const newer = store.nextGeneration(topic);
		expect(commit(topic, 12000, meta, newer)).toBe(true);
		release.resolve();
		await rejected;
		expect(store.get(topic)).toMatchObject({ at: 12000, generation: newer });
		expect(ctx.getAlarm()).toBeNull();
	});

	it('does not consume a replacement between due snapshot and recovery claim', async () => {
		store.seed(topic, 9999, meta);
		const due = store.due(10000);
		const entered = deferred();
		const release = deferred();
		store.due = async () => { entered.resolve(); await release.promise; return due; };
		const polling = _pollAlarms();
		await entered.promise;
		store.seed(topic, 12000, meta);
		release.resolve();
		await polling;
		expect(fired).not.toHaveBeenCalled();
		expect(store.get(topic).at).toBe(12000);
	});

	it('precise timers claim only the generation they armed', async () => {
		await ctx.setAlarm(10010);
		store.seed(topic, 10050, meta);
		await vi.advanceTimersByTimeAsync(10);
		expect(fired).not.toHaveBeenCalled();
		expect(store.get(topic).at).toBe(10050);
		await vi.advanceTimersByTimeAsync(40);
		await _pollAlarms();
		expect(fired).toHaveBeenCalledTimes(1);
		expect(fired.mock.calls[0][0].alarm.at).toBe(10050);
	});

	for (const locallyArmed of [false, true]) {
		it(`cancels only the observed generation with ${locallyArmed ? 'a local timer' : 'a restored row'}`, async () => {
			if (locallyArmed) await ctx.setAlarm(11000);
			else store.seed(topic, 11000, meta);
			const entered = deferred();
			const release = deferred();
			const remove = store.delete;
			store.delete = async (...args) => { entered.resolve(); await release.promise; return remove(...args); };
			let acknowledged = false;
			const cancel = ctx.deleteAlarm().then(() => { acknowledged = true; });
			await entered.promise;
			expect(acknowledged).toBe(false);
			store.seed(topic, 12000, meta);
			release.resolve();
			await cancel;
			expect(store.get(topic).at).toBe(12000);
		});
	}

	it('removes the observed durable row before cancellation resolves', async () => {
		await ctx.setAlarm(11000);
		await ctx.deleteAlarm();
		expect(store.get(topic)).toBeNull();
		expect(ctx.getAlarm()).toBeNull();
	});

	it('propagates cancellation failure and preserves the acknowledged timer', async () => {
		await ctx.setAlarm(11000);
		store.delete = async () => { throw new Error('delete failed'); };
		await expect(ctx.deleteAlarm()).rejects.toThrow('delete failed');
		expect(ctx.getAlarm()).toBe(11000);
		expect(store.get(topic).at).toBe(11000);
	});

	it('retries a failed precise claim without firing before storage confirms it', async () => {
		configureAlarm({ pollMs: 10 });
		const remove = store.claim;
		store.claim = vi.fn().mockRejectedValueOnce(new Error('temporarily unavailable')).mockImplementation(remove);
		await ctx.setAlarm(10010);
		await vi.advanceTimersByTimeAsync(10);
		expect(fired).not.toHaveBeenCalled();
		expect(store.get(topic).generation).toBe('1');
		await vi.advanceTimersByTimeAsync(10);
		expect(fired).toHaveBeenCalledTimes(1);
		expect(store.get(topic)).toBeNull();
		expect(store.claim.mock.calls).toEqual([[topic, '1'], [topic, '1']]);
	});

	it('uses the store that supplied a recovery snapshot when configuration changes', async () => {
		store.seed(topic, 9999, meta);
		const due = store.due(10000);
		const entered = deferred();
		const release = deferred();
		store.due = async () => { entered.resolve(); await release.promise; return due; };
		const polling = _pollAlarms();
		await entered.promise;
		const other = memoryAlarmStore();
		other.seed(topic, 12000, meta);
		configureAlarm({ store: other });
		release.resolve();
		await polling;
		expect(fired).toHaveBeenCalledTimes(1);
		expect(store.get(topic)).toBeNull();
		expect(other.get(topic).at).toBe(12000);
	});

	it('does not restore a live timer after reset while a durable write is pending', async () => {
		const entered = deferred();
		const release = deferred();
		const commit = store.set;
		store.set = async (...args) => { entered.resolve(); await release.promise; return commit(...args); };
		const setting = ctx.setAlarm(10010);
		await entered.promise;
		_resetAlarms();
		release.resolve();
		await setting;
		await vi.advanceTimersByTimeAsync(20);
		expect(fired).not.toHaveBeenCalled();
		expect(ctx.getAlarm()).toBeNull();
		expect(store.get(topic).at).toBe(10010);
	});

	it('recovers a newer due generation despite an older live timer on this worker', async () => {
		await ctx.setAlarm(12000);
		store.seed(topic, 9999, meta);
		await _pollAlarms();
		expect(fired).toHaveBeenCalledTimes(1);
		expect(fired.mock.calls[0][0].alarm.at).toBe(9999);
		await vi.advanceTimersByTimeAsync(2000);
		expect(fired).toHaveBeenCalledTimes(1);
	});
	for (const recovered of [false, true]) {
		it(`drains an awaited ${recovered ? 'recovery' : 'precise'} claim through callback completion`, async () => {
			const entered = deferred();
			const release = deferred();
			const handlerEntered = deferred();
			const handlerRelease = deferred();
			fired.mockImplementation(async () => { handlerEntered.resolve(); await handlerRelease.promise; });
			const remove = store.claim;
			store.claim = async (...args) => { entered.resolve(); await release.promise; return remove(...args); };
			let polling;
			if (recovered) { store.seed(topic, 9999, meta); polling = _pollAlarms(); }
			else { await ctx.setAlarm(10010); await vi.advanceTimersByTimeAsync(10); }
			await entered.promise;
			expect(inFlightCount()).toBe(1);
			let drained = false;
			const shutdown = _runShutdown({ platform: state.cronPlatform }).then(result => { drained = true; return result; });
			await Promise.resolve();
			expect(drained).toBe(false);
			release.resolve();
			await handlerEntered.promise;
			expect(inFlightCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(25);
			expect(drained).toBe(false);
			handlerRelease.resolve();
			await polling;
			await vi.advanceTimersByTimeAsync(25);
			expect((await shutdown).drained).toBe(true);
			expect(fired).toHaveBeenCalledTimes(1);
			expect(inFlightCount()).toBe(0);
		});
	}

});
