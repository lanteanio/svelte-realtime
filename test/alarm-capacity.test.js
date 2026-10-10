import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureAlarm, _resetAlarms, LiveError } from '../src/server.js';
import { _bindAlarmCtx } from '../src/server/alarm.js';
import { resetRuntimeEnv, setRuntimeEnv } from '../src/shared/runtime.js';
import { memoryAlarmStore } from './helpers/alarm-store.js';

const onAlarm = () => {};
function context(topic) {
	const ctx = {};
	_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm });
	return ctx;
}
beforeEach(() => {
	_resetAlarms(); configureAlarm(null);
	setRuntimeEnv({ clock: { wallEpoch: () => 1000 }, timers: { set: () => 0, clear: () => {}, setInterval: () => 0, clearInterval: () => {} } });
});
afterEach(() => { _resetAlarms(); configureAlarm(null); resetRuntimeEnv(); });

describe('alarm registry capacity acknowledgements', () => {
	beforeEach(() => {
		for (let index = 0; index < 100000; index++) context('alarm-cap:' + index).setAlarm(2000);
	});
	it('rejects an in-memory refusal through the returned promise while allowing replacement and cancellation', async () => {
		const refused = context('alarm-cap:overflow');
		let failure;
		expect(() => { failure = refused.setAlarm(3000).catch(error => error); }).not.toThrow();
		expect(await failure).toBeInstanceOf(LiveError);
		expect(await failure).toMatchObject({ code: 'ALARM_CAPACITY' });
		expect(refused.getAlarm()).toBeNull();
		const existing = context('alarm-cap:0');
		await existing.setAlarm(4000); expect(existing.getAlarm()).toBe(4000);
		await existing.deleteAlarm();
		await refused.setAlarm(3000); expect(refused.getAlarm()).toBe(3000);
	});

	it('rejects a durable mutation before generation or storage work without throwing synchronously', async () => {
		const store = memoryAlarmStore();
		store.nextGeneration = vi.fn(store.nextGeneration); store.set = vi.fn(store.set); store.get = vi.fn(store.get);
		configureAlarm({ store });
		const refused = context('alarm-cap:durable-overflow');
		let failure;
		expect(() => { failure = refused.setAlarm(3000).catch(error => error); }).not.toThrow();
		expect(await failure).toBeInstanceOf(LiveError);
		expect(await failure).toMatchObject({ code: 'ALARM_CAPACITY' });
		expect(() => { failure = refused.deleteAlarm().catch(error => error); }).not.toThrow();
		expect(await failure).toMatchObject({ code: 'ALARM_CAPACITY' });
		expect(store.nextGeneration).not.toHaveBeenCalled(); expect(store.set).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled();
		expect(refused.getAlarm()).toBeNull();
		await context('alarm-cap:0').deleteAlarm();
		await refused.setAlarm(3000); expect(refused.getAlarm()).toBe(3000);
		expect(store.nextGeneration).toHaveBeenCalledOnce(); expect(store.set).toHaveBeenCalledOnce();
	});
});

it.each(['memory', 'durable'])('rejects invalid deadlines through the %s mutation promise', async mode => {
	const store = memoryAlarmStore();
	store.nextGeneration = vi.fn(store.nextGeneration); store.set = vi.fn(store.set);
	if (mode === 'durable') configureAlarm({ store });
	const ctx = context('alarm-validation');
	await ctx.setAlarm(2000);
	store.nextGeneration.mockClear(); store.set.mockClear();
	for (const at of [NaN, Infinity, -Infinity, '3000', undefined, null]) {
		let failure;
		expect(() => { failure = ctx.setAlarm(at).catch(error => error); }).not.toThrow();
		expect(await failure).toBeInstanceOf(LiveError);
		expect(await failure).toMatchObject({ code: 'VALIDATION' });
		expect(ctx.getAlarm()).toBe(2000);
	}
	expect(store.nextGeneration).not.toHaveBeenCalled(); expect(store.set).not.toHaveBeenCalled();
});
