import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { realtime, onShutdown } from '../src/server.js';
import { _enterInFlight, _exitInFlight, _resetLifecycle } from '../src/server/lifecycle.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { setOperationalEventSink } from '../src/shared/diagnostic.js';

let records;
let removeSink;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	setRuntimeEnv({ clock: { monotonic: () => Date.now() } });
	_resetLifecycle();
	records = [];
	removeSink = setOperationalEventSink(record => records.push(record));
});
afterEach(() => {
	removeSink();
	_resetLifecycle();
	resetRuntimeEnv();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('returns the clean drain outcome and delivers it before teardown', async () => {
	let observed;
	onShutdown(ctx => {
		observed = ctx.drain;
		expect(records).toHaveLength(1);
	});
	const result = await realtime().shutdown({ platform: {} });
	expect(result).toEqual({ drained: true, timedOut: false, remaining: 0, elapsedMs: 0 });
	expect(observed).toBe(result);
	expect(Object.isFrozen(result)).toBe(true);
	expect(records[0]).toMatchObject({ event: 'shutdown.drain.completed', severity: 'info', attributes: result });
});

it('reports the exhausted budget before teardown can settle remaining work', async () => {
	_enterInFlight();
	onShutdown(ctx => { expect(ctx.drain.remaining).toBe(1); _exitInFlight(); }, { drainMs: 40 });
	const hooks = realtime();
	const first = hooks.shutdown({ platform: {} });
	expect(hooks.shutdown({ platform: {} })).toBe(first);
	await vi.advanceTimersByTimeAsync(40);
	expect(await first).toEqual({ drained: false, timedOut: true, remaining: 1, elapsedMs: 40 });
	expect(records[0]).toMatchObject({ event: 'shutdown.drain.timed-out', severity: 'warn', attributes: await first });
	expect(records).toHaveLength(1);
});

it('distinguishes a settled handler from an expired budget', async () => {
	_enterInFlight();
	onShutdown(() => {}, { drainMs: 100 });
	const pending = realtime().shutdown({ platform: {} });
	await vi.advanceTimersByTimeAsync(17);
	_exitInFlight();
	await vi.advanceTimersByTimeAsync(8);
	expect(await pending).toEqual({ drained: true, timedOut: false, remaining: 0, elapsedMs: 25 });
});

it('reports a zero-budget timeout immediately', async () => {
	_enterInFlight();
	onShutdown(() => {}, { drainMs: 0 });
	expect(await realtime().shutdown({ platform: {} })).toEqual({ drained: false, timedOut: true, remaining: 1, elapsedMs: 0 });
	expect(vi.getTimerCount()).toBe(0);
});

it('continues teardown when the diagnostic sink and console fallback fail', async () => {
	removeSink();
	removeSink = setOperationalEventSink(() => { throw new Error('sink failed'); });
	vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('console failed'); });
	const handler = vi.fn();
	onShutdown(handler);
	await expect(realtime().shutdown({ platform: {} })).resolves.toMatchObject({ drained: true });
	expect(handler).toHaveBeenCalledOnce();
});

it('gives every teardown handler the original immutable drain outcome', async () => {
	let observed;
	onShutdown(ctx => { ctx.drain = { drained: false }; });
	onShutdown(ctx => { observed = ctx.drain; });
	const result = await realtime().shutdown({ platform: {} });
	expect(observed).toBe(result);
	expect(observed.drained).toBe(true);
});
