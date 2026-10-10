import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, configureAlarm, _resetAlarms } from '../src/server.js';
import { _bindAlarmCtx, _pollAlarms } from '../src/server/alarm.js';
import { state, registry } from '../src/server/state.js';
import { _runShutdown, _resetLifecycle, inFlightCount } from '../src/server/lifecycle.js';
import { setOperationalEventSink } from '../src/shared/diagnostic.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { memoryAlarmStore } from './helpers/alarm-store.js';

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
const topic = 'room:retained';
const meta = { path: 'rooms/retained', tenantId: null };

describe('durable alarm execution retention', () => {
	let savedPlatform, store, ctx, fired, restoreSink, diagnostics;
	beforeEach(() => {
		_resetLifecycle();
		diagnostics = [];
		restoreSink = setOperationalEventSink(record => diagnostics.push(record));
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
		restoreSink();
		vi.useRealTimers();
	});

	it.each(['claim', 'complete', 'fail', 'getExecution', 'executions', 'requeue'])('rejects a store missing %s while retaining the prior valid configuration', async method => {
		const incomplete = { ...store }; delete incomplete[method];
		expect(() => configureAlarm({ store: incomplete })).toThrow('must retain executions');
		await ctx.setAlarm(10010); await vi.advanceTimersByTimeAsync(10);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('exposes explicit non-durable alarm identity in memory mode', async () => {
		configureAlarm(null);
		await ctx.setAlarm(10010); await vi.advanceTimersByTimeAsync(10);
		const alarm = fired.mock.calls[0][0].alarm;
		expect(alarm).toEqual({ at: 10010, firedAt: 10010, lateMs: 0, recovered: false, generation: null, attempt: 1, idempotencyKey: null });
		expect(Object.isFrozen(alarm)).toBe(true);
	});

	it('retains an explicit requeue without dispatch when the store omits due()', async () => {
		delete store.due;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try { configureAlarm({ store }); } finally { warn.mockRestore(); }
		fired.mockRejectedValueOnce(new Error('failed'));
		await ctx.setAlarm(10010); await vi.advanceTimersByTimeAsync(10);
		expect(await store.requeue(topic, '1', 1, { at: 10010 })).toBe(true);
		await vi.advanceTimersByTimeAsync(200000); await _pollAlarms();
		expect(fired).toHaveBeenCalledTimes(1);
		expect(store.get(topic)).toMatchObject({ generation: '1', at: 10010 });
	});

	it('dispatches an explicit requeue only on an eligible recovery poll', async () => {
		fired.mockRejectedValueOnce(new Error('failed'));
		await ctx.setAlarm(10010); await vi.advanceTimersByTimeAsync(10);
		let leader = false;
		configureAlarm({ store, leader: () => leader, pollMs: 5000 });
		expect(await store.requeue(topic, '1', 1, { at: 10010 })).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fired).toHaveBeenCalledTimes(1);
		leader = true;
		await vi.advanceTimersByTimeAsync(4999);
		expect(fired).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fired).toHaveBeenCalledTimes(2);
		expect(fired.mock.calls[1][0].alarm).toMatchObject({ recovered: true, generation: '1', attempt: 2 });
	});

	for (const recovered of [false, true]) {
		it(`retains a failed ${recovered ? 'recovery' : 'precise'} execution and retries its stable identity explicitly`, async () => {
			fired.mockRejectedValueOnce(new Error('private callback payload'));
			if (recovered) { store.seed(topic, 9999, meta); await _pollAlarms(); }
			else { await ctx.setAlarm(10010); await vi.advanceTimersByTimeAsync(10); }
			expect(fired).toHaveBeenCalledTimes(1);
			expect(store.get(topic)).toBeNull();
			const execution = store.getExecution(topic, '1');
			expect(execution).toMatchObject({ topic, generation: '1', attempt: 1, status: 'failed', errorClass: 'handler', meta });
			expect(JSON.stringify(execution)).not.toContain('private callback payload');
			expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'alarm.execution.failed', dataClass: 'operational', attributes: { errorClass: 'handler', durable: true } }));
			expect(JSON.stringify(diagnostics)).not.toContain('private callback payload');
			const first = fired.mock.calls[0][0].alarm;
			expect(first).toMatchObject({ generation: '1', attempt: 1, idempotencyKey: JSON.stringify([topic, '1']) });
			await _pollAlarms();
			expect(fired).toHaveBeenCalledTimes(1);
			expect(store.executions().items).toEqual([execution]);
			expect(await store.requeue(topic, '1', 1, { at: 10000 })).toBe(true);
			await _pollAlarms();
			expect(fired).toHaveBeenCalledTimes(2);
			expect(fired.mock.calls[1][0].alarm).toMatchObject({ generation: '1', attempt: 2, idempotencyKey: first.idempotencyKey });
			expect(store.getExecution(topic, '1')).toBeNull();
			expect(store.get(topic)).toBeNull();
		});
	}

	it('retains a failed old execution independently of a newer schedule', async () => {
		const entered = deferred(), release = deferred();
		fired.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error('failed'); });
		store.seed(topic, 9999, meta);
		const polling = _pollAlarms();
		await entered.promise;
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'claimed', attempt: 1 });
		await ctx.setAlarm(12000);
		release.resolve();
		await polling;
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'failed', attempt: 1 });
		expect(await store.requeue(topic, '1', 1, { at: 10000 })).toBe(false);
		expect(store.get(topic)).toMatchObject({ generation: '2', at: 12000 });
		await ctx.deleteAlarm();
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'failed' });
	});

	it('keeps the original claim when writing failure metadata rejects', async () => {
		fired.mockRejectedValue(new Error('handler failed'));
		store.fail = async () => { throw new Error('store unavailable'); };
		store.seed(topic, 9999, meta);
		await _pollAlarms();
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'claimed', attempt: 1, meta });
		await _pollAlarms();
		expect(fired).toHaveBeenCalledTimes(1);
		expect(await store.requeue(topic, '1', 1, { at: 10000 })).toBe(false);
	});

	it('retains uncertain completion for explicit abandoned-worker recovery', async () => {
		const complete = store.complete;
		store.complete = async () => { throw new Error('acknowledgement lost'); };
		store.seed(topic, 9999, meta);
		await _pollAlarms();
		expect(fired).toHaveBeenCalledTimes(1);
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'claimed', attempt: 1 });
		expect(await store.requeue(topic, '1', 1, { at: 10000 })).toBe(false);
		store.complete = complete;
		expect(await store.requeue(topic, '1', 1, { at: 10000, allowAbandoned: true })).toBe(true);
		await _pollAlarms();
		expect(fired).toHaveBeenCalledTimes(2);
		expect(fired.mock.calls[1][0].alarm.idempotencyKey).toBe(fired.mock.calls[0][0].alarm.idempotencyKey);
		expect(store.getExecution(topic, '1')).toBeNull();
	});

	it('does not repeat a callback when completion committed but its reply was lost', async () => {
		const complete = store.complete;
		store.complete = async (...args) => { complete(...args); throw new Error('reply lost'); };
		store.seed(topic, 9999, meta);
		await _pollAlarms();
		expect(store.getExecution(topic, '1')).toBeNull();
		await _pollAlarms();
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('allows only one callback across concurrent recovery snapshots', async () => {
		const entered = deferred(), release = deferred();
		fired.mockImplementation(async () => { entered.resolve(); await release.promise; });
		store.seed(topic, 9999, meta);
		const first = _pollAlarms(), second = _pollAlarms();
		await entered.promise;
		expect(fired).toHaveBeenCalledTimes(1);
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'claimed', attempt: 1 });
		release.resolve();
		await Promise.all([first, second]);
		expect(store.getExecution(topic, '1')).toBeNull();
	});

	it('fences a late old completion from a manually restarted attempt', async () => {
		const entered = [deferred(), deferred()], release = [deferred(), deferred()];
		fired.mockImplementation(async alarmCtx => {
			const index = alarmCtx.alarm.attempt - 1;
			entered[index].resolve();
			await release[index].promise;
		});
		store.seed(topic, 9999, meta);
		const first = _pollAlarms();
		await entered[0].promise;
		expect(await store.requeue(topic, '1', 1, { at: 10000, allowAbandoned: true })).toBe(true);
		const second = _pollAlarms();
		await entered[1].promise;
		release[0].resolve();
		await first;
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'claimed', attempt: 2 });
		release[1].resolve();
		await second;
		expect(store.getExecution(topic, '1')).toBeNull();
	});

	it('waits for durable completion acknowledgement before shutdown finishes', async () => {
		const entered = deferred(), release = deferred();
		const complete = store.complete;
		store.complete = async (...args) => { entered.resolve(); await release.promise; return complete(...args); };
		store.seed(topic, 9999, meta);
		const polling = _pollAlarms();
		await entered.promise;
		expect(inFlightCount()).toBe(1);
		let drained = false;
		const shutdown = _runShutdown({ platform: state.cronPlatform }).then(result => { drained = true; return result; });
		await vi.advanceTimersByTimeAsync(25);
		expect(drained).toBe(false);
		expect(store.getExecution(topic, '1')).toMatchObject({ status: 'claimed' });
		release.resolve();
		await polling;
		await vi.advanceTimersByTimeAsync(25);
		expect((await shutdown).drained).toBe(true);
		expect(store.getExecution(topic, '1')).toBeNull();
	});
});
