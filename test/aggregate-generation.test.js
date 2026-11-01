import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { live, realtime, __register, handleRpc, __directCall, __registerAggregate, _activateDerived, _resetAggregates, configureForget, _resetForget, setCronPlatform, _prepareHmr, _restoreHmr } from '../src/server.js';
import { aggregateRegistry, registry, state } from '../src/server/state.js';
import { _purgeAggregateCohorts } from '../src/server/reactive.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function memoryStore(namespace = 'aggregate-test') {
	let sequence = 0n;
	const values = new Map();
	const token = value => ({ namespace, sequence: String(value) });
	return {
		namespace,
		issueErasure: vi.fn(async () => token(++sequence)),
		readGeneration: vi.fn(async topic => token(values.get(topic) || 0n)),
		advanceGeneration: vi.fn(async (topic, next) => {
			const value = BigInt(next.sequence);
			if (value > sequence) throw new Error('unissued token');
			if (value > (values.get(topic) || 0n)) values.set(topic, value);
			return token(values.get(topic));
		})
	};
}
const fields = { count: { init: () => 0, reduce: value => value + 1, combine: (...parts) => parts.reduce((a, b) => a + b, 0) } };
function setup(options = {}, reducers = fields) {
	const fn = live.aggregate('source', reducers, { topic: 'output', forget: 'reset', privacy: { strategy: 'perturb', epsilon: 1, sensitivity: 1 }, ...options });
	__registerAggregate('aggregate/generation', fn);
	const platform = mockPlatform();
	_activateDerived(platform); setCronPlatform(platform); configureForget({ platform });
	const loaders = fn.__windowStreams ? Object.values(fn.__windowStreams) : [fn];
	return { fn, loaders, platform, entry: aggregateRegistry.get('aggregate/generation'), add: () => platform.publish('source', 'add', {}), output: () => platform.published.filter(value => value.topic.startsWith('output')).map(value => value.data) };
}
beforeEach(() => { _resetAggregates(); _resetForget(); realtime({ privacySecret: 'generation-test-secret', aggregateGenerationStore: null }); });
afterEach(() => { _resetAggregates(); _resetForget(); registry.delete('generation/output'); realtime({ aggregateGenerationStore: null }); state.cronPlatform = null; state.privacySecret = null; vi.useRealTimers(); });

describe('aggregate reset generations', () => {
	it('shares a durable generation between independent workers and a newly joined worker', async () => {
		const store = memoryStore(), workers = [];
		function start() {
			const worker = new Worker(new URL('./helpers/aggregate-generation-worker.mjs', import.meta.url));
			workers.push(worker); const pending = new Map(); let nextId = 0;
			worker.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
			worker.on('message', async message => {
				if (message.store) {
					const { id, method, args } = message.store;
					try { worker.postMessage({ storeResult: { id, value: await store[method](...args) } }); }
					catch { worker.postMessage({ storeResult: { id, error: 'Store unavailable' } }); }
				} else {
					const waiter = pending.get(message.id); pending.delete(message.id);
					if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value);
				}
			});
			return (operation, token) => new Promise((resolve, reject) => {
				const id = ++nextId; pending.set(id, { resolve, reject }); worker.postMessage({ id, operation, token });
			});
		}
		try {
			const first = start(), second = start(); await Promise.all([first('ready'), second('ready')]);
			const original = await first('add'); await second('add');
			await first('erase', await store.issueErasure());
			const shared = await store.issueErasure(); await Promise.all([first('erase', shared), second('erase', shared)]);
			const values = await Promise.all([first('add'), second('add')]); expect(values[0]).toEqual(values[1]); expect(values[0]).not.toEqual(original);
			const joined = start(); await joined('ready'); expect(await joined('add')).toEqual(values[0]);
			await Promise.all([first('erase', shared), second('erase', shared)]);
			expect(await first('add')).toEqual(await second('add'));
		} finally { await Promise.all(workers.map(worker => worker.terminate())); }
	});
	it('changes the worker-local noise after resetting an aggregate', async () => {
		const env = setup(); env.add(); const before = env.output().at(-1);
		await live.forget('person'); env.add();
		expect(env.output().at(-1)).not.toEqual(before);
	});
	it('separates worker-local generations from every durable namespace', async () => {
		let env = setup(); await live.forget('person'); env.add(); const local = env.output().at(-1);
		_resetAggregates(); const store = memoryStore('local'); realtime({ aggregateGenerationStore: store }); env = setup(); await env.fn();
		await live.forget('person', { aggregateErasure: await store.issueErasure() }); env.add(); expect(env.output().at(-1)).not.toEqual(local);
	});
	it('waits for durable bootstrap before publishing or loading', async () => {
		const store = memoryStore(), read = deferred(); store.readGeneration.mockReturnValue(read.promise);
		realtime({ aggregateGenerationStore: store }); const env = setup();
		let loaded = false; const load = env.fn().then(() => { loaded = true; });
		env.add(); await Promise.resolve();
		expect(env.output()).toEqual([]); expect(loaded).toBe(false);
		read.resolve({ namespace: store.namespace, sequence: '0' }); await load;
		env.add(); expect(env.output()).toHaveLength(1);
	});
	it('reuses a persisted generation after restart and does not reset twice for one token', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store });
		let env = setup(); await env.fn(); env.add(); const old = env.output().at(-1);
		const aggregateErasure = await store.issueErasure(); await live.forget('person', { aggregateErasure });
		env.add(); const current = env.output().at(-1); expect(current).not.toEqual(old);
		await live.forget('person', { aggregateErasure }); expect(env.entry.state.count).toBe(1);
		_resetAggregates(); env = setup(); await env.fn(); env.add();
		expect(env.output().at(-1)).toEqual(current);
	});
	it('requires a shared, issued identity only for the configured store', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn();
		for (const aggregateErasure of [undefined, 'person', { namespace: 'other', sequence: '1' }, { namespace: store.namespace, sequence: '01' }, { namespace: store.namespace, sequence: '0' }, { namespace: store.namespace, sequence: '340282366920938463463374607431768211456' }]) {
			await expect(live.forget('person', { aggregateErasure })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		}
		expect(store.advanceGeneration).not.toHaveBeenCalled();
	});
	it('keeps a failed reset closed and retries the same durable identity', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn(); env.add();
		const aggregateErasure = await store.issueErasure(); store.advanceGeneration.mockRejectedValueOnce(new Error('unavailable'));
		await expect(live.forget('person', { aggregateErasure })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		const count = env.output().length; env.add(); expect(env.output()).toHaveLength(count);
		await expect(env.fn()).rejects.toThrow();
		await live.forget('person', { aggregateErasure }); env.add(); expect(env.entry.state.count).toBe(1);
	});
	it('coalesces overlapping resets without losing the higher identity', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn(); env.add();
		const first = await store.issueErasure(), second = await store.issueErasure(), pending = deferred();
		const advance = store.advanceGeneration.getMockImplementation();
		store.advanceGeneration.mockImplementationOnce(async (topic, token) => { await pending.promise; return advance(topic, token); });
		const one = live.forget('person', { aggregateErasure: first });
		await vi.waitFor(() => expect(store.advanceGeneration).toHaveBeenCalledOnce());
		const two = live.forget('other', { aggregateErasure: second });
		await new Promise(resolve => setImmediate(resolve)); env.add(); pending.resolve(); await Promise.all([one, two]);
		expect(await store.readGeneration('output')).toEqual(second); expect(env.entry.state.count).toBe(0);
		env.add(); await live.forget('person', { aggregateErasure: first }); expect(env.entry.state.count).toBe(1);
	});
	it('fences late snapshot hydration during a persisted reset for every window', async () => {
		vi.useFakeTimers(); const store = memoryStore(); realtime({ aggregateGenerationStore: store });
		const snapshot = deferred(), read = vi.fn(() => snapshot.promise); const env = setup({ snapshots: { lifetime: read, minute: read }, windows: {
			lifetime: { type: 'lifetime' }, minute: { type: 'tumbling', durationMs: 60000 }, recent: { type: 'sliding', durationMs: 3000, slideMs: 1000 }
		} });
		await env.entry._persistedGeneration.bootstrap; await Promise.resolve(); expect(read).toHaveBeenCalledTimes(2);
		const oldLoads = env.loaders.map(load => load());
		const aggregateErasure = await store.issueErasure(); await live.forget('person', { aggregateErasure });
		expect(await Promise.all(oldLoads)).toEqual([{ count: 0 }, { count: 0 }, { count: 0 }]);
		snapshot.resolve({ count: 200 }); await Promise.resolve(); await Promise.resolve();
		for (const load of env.loaders) expect(await load()).toEqual({ count: 0 });
	});
	it('ignores bootstrap results that arrive after a completed erasure', async () => {
		const store = memoryStore(), old = deferred(); store.readGeneration.mockReturnValueOnce(old.promise);
		realtime({ aggregateGenerationStore: store }); const env = setup(), loading = env.fn();
		const aggregateErasure = await store.issueErasure(); await live.forget('person', { aggregateErasure });
		expect(await loading).toEqual({ count: 0 }); const generation = env.entry._noiseGeneration;
		old.resolve({ namespace: store.namespace, sequence: '0' }); await Promise.resolve(); await Promise.resolve();
		expect(env.entry._noiseGeneration).toBe(generation); env.add(); expect(env.output()).toHaveLength(2);
	});
	it('does not publish a late successful advance after its configured timeout', async () => {
		vi.useFakeTimers(); const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn(); env.add();
		configureForget({ timeoutMs: 10 }); const aggregateErasure = await store.issueErasure(), late = deferred();
		const advance = store.advanceGeneration.getMockImplementation(); store.advanceGeneration.mockImplementationOnce(async (topic, token) => { await late.promise; return advance(topic, token); });
		const failed = expect(live.forget('person', { aggregateErasure })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		await vi.advanceTimersByTimeAsync(11); await failed; const outputs = env.output().length;
		let settled = false;
		const retry = expect(live.forget('person', { aggregateErasure })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' }).then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(true); await retry; expect(store.advanceGeneration).toHaveBeenCalledOnce();
		late.resolve(); await vi.advanceTimersByTimeAsync(1); env.add(); expect(env.output()).toHaveLength(outputs);
		await expect(env.fn()).rejects.toThrow('Aggregate generation reset failed');
		await live.forget('person', { aggregateErasure }); expect(await env.fn()).toEqual({ count: 0 });
	});
	it('cannot reopen from a late advance resolved by the next erasure surface', async () => {
		vi.useFakeTimers(); const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn(); env.add();
		const aggregateErasure = await store.issueErasure(), late = deferred(); store.advanceGeneration.mockReturnValueOnce(late.promise);
		configureForget({ timeoutMs: 10, store: { purgeUser: async () => { late.resolve(aggregateErasure); return 0; } } });
		const count = env.output().length;
		const erasure = expect(live.forget('person', { tenantId: null, aggregateErasure })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		await vi.advanceTimersByTimeAsync(11); await erasure;
		expect(env.output()).toHaveLength(count); await expect(env.fn()).rejects.toThrow('Aggregate generation reset failed');
	});
	it('keeps all window timers and debounced output closed while storage is pending', async () => {
		vi.useFakeTimers(); vi.setSystemTime(120000); const store = memoryStore(); realtime({ aggregateGenerationStore: store });
		const env = setup({ debounce: 20, windows: { lifetime: { type: 'lifetime' }, minute: { type: 'tumbling', durationMs: 1000 }, recent: { type: 'sliding', durationMs: 3000, slideMs: 1000 } } });
		await Promise.all(env.loaders.map(load => load())); env.add();
		const aggregateErasure = await store.issueErasure(), pending = deferred(); store.advanceGeneration.mockReturnValueOnce(pending.promise);
		const reset = live.forget('person', { aggregateErasure }); await vi.advanceTimersByTimeAsync(2500);
		env.add(); expect(env.output()).toEqual([]);
		pending.resolve(aggregateErasure); await reset; expect(env.output()).toEqual([{ count: 0 }, { count: 0 }, { count: 0 }]);
		await vi.advanceTimersByTimeAsync(30); expect(env.output()).toHaveLength(3);
	});
	it('coalesces a reentrant newer erasure started by a reset initializer', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); let nested, duringReset = false;
		const first = await store.issueErasure(), second = await store.issueErasure();
		const env = setup({}, { count: { ...fields.count, init: () => {
			if (duringReset) { duringReset = false; nested = _purgeAggregateCohorts('other', undefined, undefined, second); }
			return 0;
		} } });
		await env.fn(); env.add(); duringReset = true;
		await live.forget('person', { aggregateErasure: first }); await nested;
		expect(await store.readGeneration('output')).toEqual(second); expect(env.entry.state).toEqual({ count: 0 });
		expect(env.output().slice(1)).toEqual([{ count: 0 }]);
	});
	it('rejects an old publication resumed from an application reducer', async () => {
		let erase = false; const env = setup({}, { count: { ...fields.count, reduce: value => {
			if (erase) { erase = false; _purgeAggregateCohorts('person'); }
			return value + 1;
		} } });
		env.add(); erase = true; env.add(); expect(env.entry.state).toEqual({ count: 0 });
		expect(env.output().slice(1)).toEqual([{ count: 0 }]);
	});
	it('does not overwrite a newer reset with an older initializer result', async () => {
		let nested = false; const env = setup({}, { count: { ...fields.count, init: () => {
			if (nested) { nested = false; _purgeAggregateCohorts('other'); return 200; }
			return 0;
		} } });
		env.add(); nested = true; await expect(live.forget('person')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(env.entry.state).toEqual({ count: 0 }); expect(env.output().slice(1)).toEqual([{ count: 0 }]);
	});
	it.each(['reset', 'retain'])('does not re-add an erased contributor after a %s callback (single and windows)', async forget => {
		for (const windows of [undefined, { lifetime: { type: 'lifetime' }, minute: { type: 'tumbling', durationMs: 60000 }, recent: { type: 'sliding', durationMs: 3000, slideMs: 1000 } }]) {
			_resetAggregates(); let erase = true;
			const env = setup({ forget, windows, privacy: { k: 2, strategy: 'suppress', contributor: value => {
				if (erase) { erase = false; _purgeAggregateCohorts('erased'); }
				return value.id;
			} } });
			env.platform.publish('source', 'add', { id: 'erased' });
			const holders = env.entry.windowStates ? [...env.entry.windowStates.values()] : [env.entry];
			for (const holder of holders) {
				const cohorts = holder.bucketCohorts || [holder.cohort];
				expect(cohorts.some(cohort => cohort.has('erased'))).toBe(false);
			}
			const before = env.output().length; env.platform.publish('source', 'add', { id: 'new' });
			expect(env.output()).toHaveLength(before);
		}
	});
	it.each([false, true])('waits when loader computation starts an erasure (windowed: %s)', async windowed => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const token = await store.issueErasure(), pending = deferred();
		let erase = false, reset;
		const env = setup({ privacy: undefined, ...(windowed ? { windows: { lifetime: { type: 'lifetime' } } } : {}) }, {
			count: fields.count, mirror: { compute: value => { if (erase) { erase = false; reset = _purgeAggregateCohorts('erased', undefined, undefined, token); } return value.count; } }
		});
		const loader = env.loaders[0]; await loader(); env.add(); store.advanceGeneration.mockReturnValueOnce(pending.promise);
		erase = true; let result; const loading = loader().then(value => { result = value; });
		await vi.waitFor(() => expect(store.advanceGeneration).toHaveBeenCalledOnce()); expect(result).toBeUndefined();
		pending.resolve(token); await reset; await loading; expect(result).toEqual({ count: 0, mirror: 0 });
	});
	it.each([false, true])('refuses an aggregate RPC result erased before actual emission (windowed: %s)', async windowed => {
		let erase = false;
		const env = setup({ privacy: undefined, ...(windowed ? { windows: { lifetime: { type: 'lifetime' } } } : {}) }, {
			count: fields.count, mirror: { compute: value => {
				if (erase) { erase = false; queueMicrotask(() => _purgeAggregateCohorts('erased')); } return value.count;
			} }
		});
		env.add(); __register('generation/output', env.loaders[0]); erase = true;
		handleRpc(mockWs({ id: 'reader' }), toArrayBuffer({ rpc: 'generation/output', id: 'query', stream: true, args: [] }), env.platform);
		await vi.waitFor(() => expect(env.platform.sent.some(item => item.data?.id === 'query')).toBe(true));
		const reply = env.platform.sent.find(item => item.data?.id === 'query').data;
		expect(reply).toMatchObject({ ok: false, code: 'UNAVAILABLE' }); expect(reply).not.toHaveProperty('data');
		expect(env.output().at(-1)).toEqual({ count: 0, mirror: 0 });
	});
	it.each([false, true])('refuses erased SSR results and uses the configured fallback (windowed: %s)', async windowed => {
		let erase = false;
		const env = setup({ privacy: undefined, ...(windowed ? { windows: { lifetime: { type: 'lifetime' } } } : {}) }, {
			count: fields.count, mirror: { compute: value => {
				if (erase) { erase = false; queueMicrotask(() => _purgeAggregateCohorts('erased')); } return value.count;
			} }
		});
		env.add(); __register('generation/output', env.loaders[0]); erase = true;
		await expect(__directCall('generation/output', [], env.platform)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
		env.add(); erase = true;
		await expect(__directCall('generation/output', [], env.platform, { fallback: 'unavailable' })).resolves.toBe('unavailable');
	});
	it('does not overwrite a newer reset from a tumbling initializer', async () => {
		vi.useFakeTimers(); vi.setSystemTime(0); let erase = false;
		const env = setup({ privacy: undefined, windows: { minute: { type: 'tumbling', durationMs: 1000 } } }, { count: { ...fields.count, init: () => {
			if (erase) { erase = false; _purgeAggregateCohorts('erased'); return 200; } return 0;
		} } });
		env.add(); erase = true; await vi.advanceTimersByTimeAsync(1000);
		expect(await env.loaders[0]()).toEqual({ count: 0 });
	});
	it('stops a sliding callback when its computation starts a newer reset', async () => {
		vi.useFakeTimers(); vi.setSystemTime(0); let erase = false;
		const env = setup({ windows: { recent: { type: 'sliding', durationMs: 2000, slideMs: 1000 } } }, { count: { ...fields.count, combine: (...parts) => {
			if (erase) { erase = false; _purgeAggregateCohorts('erased'); return 200; } return parts.reduce((a, b) => a + b, 0);
		} } });
		env.add(); const before = env.output().length; erase = true; await vi.advanceTimersByTimeAsync(1000);
		expect(env.output().slice(before)).toEqual([{ count: 0 }]);
	});
	it('keeps the generation independent of local window clocks and reset history', async () => {
		vi.useFakeTimers(); const store = memoryStore(); realtime({ aggregateGenerationStore: store });
		const windows = { lifetime: { type: 'lifetime' }, minute: { type: 'tumbling', durationMs: 60000 }, recent: { type: 'sliding', durationMs: 3000, slideMs: 1000 } };
		let env = setup({ windows }); await Promise.all(env.loaders.map(load => load()));
		for (let i = 0; i < 3; i++) await live.forget('person', { aggregateErasure: await store.issueErasure() });
		const shared = await store.issueErasure(); await live.forget('person', { aggregateErasure: shared });
		const generation = [...env.entry.windowStates.values()].map(holder => holder._noiseGeneration);
		_resetAggregates(); vi.setSystemTime(Date.now() + 3600001); env = setup({ windows });
		await Promise.all(env.loaders.map(load => load())); await live.forget('person', { aggregateErasure: shared });
		expect([...env.entry.windowStates.values()].map(holder => holder._noiseGeneration)).toEqual(generation);
	});
	it('holds malformed or backwards store results closed without exposing exception data', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn();
		const aggregateErasure = await store.issueErasure(); store.advanceGeneration.mockResolvedValueOnce({ namespace: store.namespace, sequence: '0' });
		await expect(live.forget('person', { aggregateErasure })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		await expect(env.fn()).rejects.toThrow('Aggregate generation reset failed');
		store.advanceGeneration.mockRejectedValueOnce(new Error('private identity'));
		await expect(live.forget('person', { aggregateErasure })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		await expect(env.fn()).rejects.toThrow('Aggregate generation reset failed');
	});
	it('accepts the normal registration-before-configuration startup order', async () => {
		const env = setup(); const store = memoryStore(); realtime({ aggregateGenerationStore: store });
		await env.fn(); expect(store.readGeneration).toHaveBeenCalledWith('output');
	});
	it('restarts an imported snapshot after configuration and ignores its earlier result', async () => {
		const earlier = deferred(), current = deferred(); const snapshot = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(current.promise);
		const env = setup({ snapshot, privacy: undefined }); const store = memoryStore(); realtime({ aggregateGenerationStore: store });
		await env.entry._persistedGeneration.bootstrap; await Promise.resolve(); expect(snapshot).toHaveBeenCalledTimes(2);
		earlier.resolve({ count: 200 }); current.resolve({ count: 3 }); expect(await env.fn()).toEqual({ count: 3 });
	});
	it('reads the durable generation again when restoring a failed module reload', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn(); env.add();
		const old = env.output().at(-1), snapshot = _prepareHmr(); const token = await store.issueErasure(); await store.advanceGeneration('output', token);
		_restoreHmr(snapshot); await env.fn(); env.add(); expect(env.output().at(-1)).not.toEqual(old);
		expect(store.readGeneration).toHaveBeenCalledTimes(2);
	});
	it('keeps bootstrap failures closed and sanitizes the loader error', async () => {
		const store = memoryStore(); store.readGeneration.mockRejectedValueOnce(new Error('private identity'));
		realtime({ aggregateGenerationStore: store }); const env = setup();
		await expect(env.fn()).rejects.toThrow('Aggregate generation bootstrap failed'); env.add(); expect(env.output()).toEqual([]);
	});
	it('reopens successfully reset aggregates when a different holder cannot be erased', async () => {
		const store = memoryStore(); realtime({ aggregateGenerationStore: store }); const env = setup(); await env.fn();
		const other = live.aggregate('source', fields, { topic: 'other' }); __registerAggregate('aggregate/other', other);
		const holders = { done: new Set(), failed: new Set(), never: new Set(), known: new Set(), scoped: false };
		await expect(_purgeAggregateCohorts('person', env.platform, holders, await store.issueErasure())).rejects.toThrow('Aggregate erasure incomplete');
		expect(await env.fn()).toEqual({ count: 0 }); env.add(); expect(env.entry.state.count).toBe(1);
	});
	it('refuses changing the store after aggregate use', () => {
		const env = setup(); env.add(); expect(() => realtime({ aggregateGenerationStore: memoryStore() })).toThrow(/before.*register/i);
	});
});
