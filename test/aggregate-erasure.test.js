import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, __registerAggregate, _activateDerived, _resetAggregates, configureForget, _resetForget, setCronPlatform } from '../src/server.js';
import { aggregateRegistry, state } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';

const reducers = () => ({ byUser: { init: () => ({}), reduce: (acc, _event, value) => { acc[value.id] = value.email; return acc; }, combine: (...parts) => Object.assign({}, ...parts) } });
function setup(options = {}, fields = reducers()) {
	const fn = live.aggregate('source', fields, { topic: 'output', ...options });
	__registerAggregate('aggregate/one', fn);
	const platform = mockPlatform();
	_activateDerived(platform); setCronPlatform(platform);
	const durable = vi.fn(async () => 0);
	configureForget({ platform, store: { purgeUser: durable } });
	return { fn, platform, durable, entry: aggregateRegistry.get('aggregate/one'), add: (id = 'alice') => platform.publish('source', 'added', { id, email: id + '@private.test' }) };
}
beforeEach(() => { _resetAggregates(); _resetForget(); });
afterEach(() => { _resetAggregates(); _resetForget(); state.cronPlatform = null; vi.useRealTimers(); });

describe('aggregate erasure contract', () => {
	it('reports incomplete arbitrary reducer state without explicit reset policy and still runs durable cleanup', async () => {
		const env = setup({ privacy: { k: 2, strategy: 'suppress', contributor: value => value.id } });
		env.add('first'); env.add('second'); env.add('alice');
		expect(env.entry.cohort.has('alice')).toBe(false);
		expect(env.entry.state.byUser.alice).toBe('alice@private.test');
		const completed = vi.fn();
		await expect(live.forget('alice', { onForget: completed })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(completed).not.toHaveBeenCalled(); expect(env.durable).toHaveBeenCalledOnce();
	});

	it('resets all reducer and held output copies even for an untracked contributor', async () => {
		const env = setup({ forget: 'reset', privacy: { k: 2, strategy: 'suppress', contributor: value => value.id } });
		env.add('first'); env.add('second'); env.add('alice');
		await live.forget('alice');
		expect(env.entry.state).toEqual({ byUser: {} });
		expect(env.entry._lastWire).toEqual({ byUser: {} });
		expect([...env.entry.cohort]).toEqual([]);
		expect(await env.fn()).toEqual({ byUser: {} });
		expect(env.fn.__aggregateInitState).toBeUndefined();
		expect(env.platform.published.filter(value => value.topic === 'output').at(-1).data).toEqual({ byUser: {} });
	});

	it('isolates initial seed objects from mutation and prevents a reset resurrecting them', async () => {
		const seed = {};
		const env = setup({ forget: 'reset' }, { byUser: { ...reducers().byUser, init: () => seed } });
		env.add();
		expect(seed).toEqual({});
		await live.forget('alice');
		expect(await env.fn()).toEqual({ byUser: {} });
		expect(seed).toEqual({});
	});

	it('clears pending debounced payloads before they can publish erased contributions', async () => {
		vi.useFakeTimers();
		const env = setup({ forget: 'reset', debounce: 100 }); env.add();
		await live.forget('alice');
		await vi.advanceTimersByTimeAsync(150);
		expect(env.platform.published.filter(value => value.topic === 'output').map(value => value.data)).toEqual([{ byUser: {} }]);
	});

	it('clears lifetime, tumbling, every sliding bucket, and privacy wire copies', async () => {
		vi.useFakeTimers();
		const env = setup({ forget: 'reset', debounce: 200, windows: {
			lifetime: { type: 'lifetime' }, minute: { type: 'tumbling', durationMs: 60000 }, recent: { type: 'sliding', durationMs: 3000, slideMs: 1000 }
		}, privacy: { k: 2, strategy: 'suppress', contributor: value => value.id } });
		env.add('alice'); env.add('bob'); await vi.advanceTimersByTimeAsync(1000); env.add('alice');
		await live.forget('alice');
		for (const [name, win] of env.entry.windowStates) {
			if (win.buckets) { for (const bucket of win.buckets) expect(bucket).toEqual({ byUser: {} }); }
			else expect(win.state).toEqual({ byUser: {} });
			expect(win._lastWire).toEqual({ byUser: {} });
			if (win.cohort) expect(win.cohort.size).toBe(0);
			if (win.bucketCohorts) expect(win.bucketCohorts.every(cohort => cohort.size === 0)).toBe(true);
			expect(await env.fn.__windowStreams[name]()).toEqual({ byUser: {} });
		}
		const before = env.platform.published.length;
		await vi.advanceTimersByTimeAsync(1500);
		expect(JSON.stringify(env.platform.published.slice(before))).not.toContain('private.test');
	});

	it.each([false, true])('discards a snapshot resolving after erasure (windowed: %s)', async windowed => {
		let finish;
		const snapshot = () => new Promise(resolve => { finish = resolve; });
		const env = setup({ forget: 'reset', snapshot, ...(windowed ? { windows: { lifetime: { type: 'lifetime' } } } : {}) });
		const oldHydration = env.entry._hydrationPromise;
		await live.forget('alice');
		finish({ byUser: { alice: 'alice@private.test' } }); await oldHydration;
		const loader = windowed ? env.fn.__windowStreams.lifetime : env.fn;
		expect(await loader()).toEqual({ byUser: {} });
	});

	it.each([false, true])('preserves non-reset hydration and pending output (windowed: %s)', async windowed => {
		vi.useFakeTimers();
		let finish;
		const snapshot = () => new Promise(resolve => { finish = resolve; });
		const fields = { count: { init: () => 0, reduce: value => value + 1 } };
		const env = setup({ snapshot, debounce: 50, ...(windowed ? { windows: { lifetime: { type: 'lifetime' } } } : {}) }, fields);
		const hydration = env.entry._hydrationPromise;
		const generation = env.entry._generation;
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(env.entry._hydrationPromise).toBe(hydration);
		expect(env.entry._generation).toBe(generation);
		finish({ count: 10 }); await hydration;
		const loader = windowed ? env.fn.__windowStreams.lifetime : env.fn;
		expect(await loader()).toEqual({ count: 10 });
		env.add();
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		await vi.advanceTimersByTimeAsync(50);
		expect(env.platform.published.at(-1).data).toEqual({ count: 11 });
	});

	it.each([false, true])('retains explicitly non-personal values and removes contributor identity (windowed: %s)', async windowed => {
		let finish;
		const snapshot = () => new Promise(resolve => { finish = resolve; });
		const fields = { count: { init: () => 0, reduce: value => value + 1 } };
		const env = setup({ forget: 'retain', snapshot, privacy: { k: 2, strategy: 'suppress', contributor: value => value.id }, ...(windowed ? { windows: { lifetime: { type: 'lifetime' } } } : {}) }, fields);
		const hydration = env.entry._hydrationPromise;
		env.add();
		await expect(live.forget('alice')).resolves.toMatchObject({ ok: true });
		expect(env.entry._hydrationPromise).toBe(hydration);
		finish({ count: 20 }); await hydration;
		const holder = windowed ? env.entry.windowStates.get('lifetime') : env.entry;
		expect(holder.state).toEqual({ count: 20 });
		expect(holder.cohort.size).toBe(0);
	});

	it('continues other aggregates and permits retry after initializer failure', async () => {
		let fail = false;
		const env = setup({ forget: 'reset' }, { byUser: { ...reducers().byUser, init: () => { if (fail) throw new Error('unavailable'); return {}; } } });
		const second = live.aggregate('source', reducers(), { topic: 'other', forget: 'reset' });
		__registerAggregate('aggregate/two', second);
		env.add(); fail = true;
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(await second()).toEqual({ byUser: {} }); expect(env.durable).toHaveBeenCalledOnce();
		fail = false; await expect(live.forget('alice')).resolves.toMatchObject({ ok: true });
		expect(await env.fn()).toEqual({ byUser: {} });
	});

	it('rejects uncopyable state when reset cannot prove initial seed isolation', async () => {
		let invalid = false;
		const env = setup({ forget: 'reset' }, { byUser: { ...reducers().byUser, init: () => invalid ? { callback() {} } : {} } });
		env.add(); invalid = true;
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		invalid = false; await expect(live.forget('alice')).resolves.toMatchObject({ ok: true });
	});

	it('does not fold reentrant source updates from reset initializers', async () => {
		let duringReset = null;
		const env = setup({ forget: 'reset' }, { byUser: { ...reducers().byUser, init: () => { duringReset?.(); return {}; } } });
		env.add(); duringReset = () => env.add('alice');
		await live.forget('alice'); duringReset = null;
		expect(await env.fn()).toEqual({ byUser: {} });
		expect(env.platform.published.filter(value => value.topic === 'output').at(-1).data).toEqual({ byUser: {} });
	});

	it('rejects shared-memory seeds instead of retaining a writable alias', () => {
		const seed = { bytes: new SharedArrayBuffer(4) };
		expect(() => setup({ forget: 'reset' }, { byUser: { init: () => seed } })).toThrow();
	});

	it('copies shared-buffer views without retaining shared backing memory', async () => {
		const bytes = new Uint8Array(new SharedArrayBuffer(4));
		const env = setup({ forget: 'reset' }, { bytes: { init: () => bytes, reduce: acc => { acc[0] = 42; return acc; } } });
		env.add();
		expect(bytes[0]).toBe(0);
		await live.forget('alice');
		expect((await env.fn()).bytes[0]).toBe(0);
	});

	it('continues other windows after reset publication fails and retries cleanly', async () => {
		const env = setup({ forget: 'reset', windows: { first: { type: 'lifetime' }, second: { type: 'lifetime' } } });
		env.add();
		const published = env.platform.publish;
		let fail = true;
		env.platform.publish = (topic, ...args) => {
			if (fail && topic === 'output:first') throw new Error('transport unavailable');
			return published(topic, ...args);
		};
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(env.durable).toHaveBeenCalledOnce();
		expect(env.platform.published.filter(row => row.topic === 'output:second').at(-1).data).toEqual({ byUser: {} });
		fail = false;
		await expect(live.forget('alice')).resolves.toMatchObject({ surfaces: { aggregateCohorts: 2 } });
		env.add('bob');
		expect(await env.fn.__windowStreams.first()).toEqual({ byUser: { bob: 'bob@private.test' } });
	});

	it('publishes the reset through the captured reactive platform without a cron or forget platform', async () => {
		const fn = live.aggregate('direct-source', reducers(), { topic: 'direct-output', forget: 'reset' });
		__registerAggregate('aggregate/direct', fn);
		const platform = mockPlatform();
		_activateDerived(platform);
		setCronPlatform(null);
		configureForget({ store: { purgeUser: async () => 0 } });
		platform.publish('direct-source', 'added', { id: 'alice', email: 'alice@private.test' });
		await live.forget('alice');
		expect(platform.published.filter(row => row.topic === 'direct-output').at(-1).data).toEqual({ byUser: {} });
	});

	it('validates the explicit policy', () => {
		expect(() => live.aggregate('source', reducers(), { topic: 'output', forget: 'ignore' })).toThrow(/forget/);
	});
});
