// Bounded reactive fan-out: an effect or outbound webhook that stalls holds a
// bounded number of handler calls in flight and a bounded queue behind them,
// with a declared overflow policy; a derived stream never runs two computes at
// once and settles on the latest source state. Everything is driven through
// the real publish path of a test environment.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { live, onError, configureWebhooks, getDeadLetter, createDeadLetterStore, __registerWebhookOut, __registerFlag, _prepareHmr, setOperationalEventSink } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { state } from '../src/server/state.js';
import { _resetBackgroundMetrics } from '../src/server/background-metrics.js';

const flush = async (n = 12) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

let env = null;
let server = null;
afterEach(async () => {
	env?.cleanup();
	env = null;
	_prepareHmr();
	onError(null);
	setOperationalEventSink(null);
	configureWebhooks({ deadLetter: false });
	state.metricsInstruments = null;
	_resetBackgroundMetrics();
	if (server) await server.close();
	server = null;
});

/** An effect whose every call waits until released. */
function stalledEffect(options) {
	const started = [];
	const waiting = [];
	const effect = live.effect(['orders'], (event, data) => {
		started.push(data.i);
		return new Promise((resolve) => waiting.push(resolve));
	}, options);
	return {
		effect, started, waiting,
		/** Release every call until the effect goes quiet. */
		async drain() {
			await flush();
			for (let rounds = 0; waiting.length && rounds < 100000; rounds++) {
				for (const release of waiting.splice(0)) release();
				await flush();
			}
		}
	};
}

function setupEffect(options) {
	const probe = stalledEffect(options);
	env = createTestEnv();
	env.register('jobs', { notify: probe.effect });
	const publish = (i) => env.platform.publish('orders', 'created', { i });
	return { ...probe, publish };
}

function captureErrors() {
	const errors = [];
	onError((path, err) => errors.push({ path, err }));
	const events = [];
	setOperationalEventSink((record) => events.push(record));
	return { errors, events };
}

function fakeRegistry() {
	const gauges = new Map();
	const counters = new Map();
	const defs = [];
	const key = (name, labels) => name + JSON.stringify(labels || {});
	return {
		gauges, counters, defs,
		counter(def) { defs.push(def); return { inc(labels) { const k = key(def.name, labels); counters.set(k, (counters.get(k) || 0) + 1); } }; },
		histogram(def) { defs.push(def); return { observe() {} }; },
		gauge(def) { defs.push(def); return { inc() {}, dec() {}, set(labels, v) { gauges.set(key(def.name, labels), v); } }; }
	};
}

describe('live.effect concurrency and queue limits', () => {
	it.each([1000, 5000, 20000])('a stalled effect holds at most the default limits for %i publishes', async (count) => {
		const { errors } = captureErrors();
		const fx = setupEffect();
		for (let i = 0; i < count; i++) fx.publish(i);
		await flush();
		// 32 calls in flight, the rest waits in the queue or is rejected.
		expect(fx.started.length).toBe(Math.min(count, 32));
		await fx.drain();
		const accepted = Math.min(count, 32 + 10000);
		expect(fx.started.length).toBe(accepted);
		// Calls start in publish order.
		expect(fx.started.every((v, i) => v === i)).toBe(true);
		const overloaded = errors.filter((e) => e.err?.code === 'OVERLOADED');
		// One report per overflow episode, not one per rejected publish.
		expect(overloaded.length).toBe(count > accepted ? 1 : 0);
		if (overloaded.length) expect(overloaded[0].path).toBe('effect');
	}, 60000);

	it('rejects past maxQueued in FIFO order and reports the episode once', async () => {
		const { errors, events } = captureErrors();
		const fx = setupEffect({ maxConcurrent: 2, maxQueued: 3 });
		for (let i = 1; i <= 8; i++) fx.publish(i);
		await flush();
		expect(fx.started).toEqual([1, 2]);
		await fx.drain();
		expect(fx.started).toEqual([1, 2, 3, 4, 5]);
		expect(errors).toHaveLength(1);
		expect(errors[0].err.code).toBe('OVERLOADED');
		const overflow = events.filter((e) => e.event === 'reactive.effect.overflow');
		expect(overflow).toHaveLength(1);
		expect(overflow[0]).toMatchObject({ severity: 'warn', attributes: { effect: 'jobs/notify', maxConcurrent: 2, maxQueued: 3 } });
		const ended = events.filter((e) => e.event === 'reactive.effect.overflow.ended');
		expect(ended).toHaveLength(1);
		expect(ended[0].attributes).toMatchObject({ effect: 'jobs/notify', rejected: 3 });

		// A later burst after the queue drained is a new episode.
		for (let i = 9; i <= 15; i++) fx.publish(i);
		await fx.drain();
		expect(fx.started.slice(5)).toEqual([9, 10, 11, 12, 13]);
		expect(errors).toHaveLength(2);
	});

	it('ends an overflow episode once the queue is back to half its limit, without draining', async () => {
		const { errors, events } = captureErrors();
		const fx = setupEffect({ maxConcurrent: 1, maxQueued: 4 });
		const release = async () => { fx.waiting.shift()(); await flush(); };
		const ended = () => events.filter((e) => e.event === 'reactive.effect.overflow.ended').map((e) => e.attributes.rejected);
		// One running, four waiting, two rejected.
		for (let i = 1; i <= 7; i++) fx.publish(i);
		await flush();
		expect(errors).toHaveLength(1);
		await release();
		// Three waiting: the queue has room, but the episode goes on, so a
		// rejection now is not reported again.
		fx.publish(8);
		fx.publish(9);
		await flush();
		expect(errors).toHaveLength(1);
		await release();
		expect(ended()).toEqual([]);
		await release();
		// Two waiting: half of maxQueued ends the episode.
		expect(ended()).toEqual([3]);
		// The handler never caught up, yet the next overflow is a new episode.
		for (let i = 10; i <= 13; i++) fx.publish(i);
		await flush();
		expect(errors).toHaveLength(2);
		expect(events.filter((e) => e.event === 'reactive.effect.overflow')).toHaveLength(2);
		await fx.drain();
		expect(ended()).toEqual([3, 2]);
	});

	it("overflow: 'coalesce' keeps the newest event in place of the newest waiting one", async () => {
		const { errors } = captureErrors();
		const fx = setupEffect({ maxConcurrent: 1, maxQueued: 1, overflow: 'coalesce' });
		for (let i = 1; i <= 10; i++) fx.publish(i);
		await fx.drain();
		expect(fx.started).toEqual([1, 10]);
		expect(errors).toEqual([]);
	});

	it('maxQueued: 0 runs only what fits the concurrency limit', async () => {
		const fx = setupEffect({ maxConcurrent: 1, maxQueued: 0 });
		captureErrors();
		for (let i = 1; i <= 4; i++) fx.publish(i);
		await fx.drain();
		expect(fx.started).toEqual([1]);
	});

	it('a queued call runs in the async context of its own publish', async () => {
		const als = new AsyncLocalStorage();
		const seen = [];
		const waiting = [];
		const effect = live.effect(['orders'], (event, data) => {
			seen.push([data.i, als.getStore()]);
			return new Promise((resolve) => waiting.push(resolve));
		}, { maxConcurrent: 1 });
		env = createTestEnv();
		env.register('jobs', { notify: effect });
		for (let i = 0; i < 4; i++) als.run('publish-' + i, () => env.platform.publish('orders', 'created', { i }));
		for (let rounds = 0; rounds < 10; rounds++) {
			await flush();
			for (const release of waiting.splice(0)) release();
		}
		expect(seen).toEqual([0, 1, 2, 3].map((i) => [i, 'publish-' + i]));
	});

	it('Infinity restores unbounded fan-out', async () => {
		const fx = setupEffect({ maxConcurrent: Infinity });
		for (let i = 0; i < 100; i++) fx.publish(i);
		await flush();
		expect(fx.started).toHaveLength(100);
		await fx.drain();
	});

	it('a debounced effect is bounded by the same limits', async () => {
		vi.useFakeTimers();
		try {
			const fx = setupEffect({ debounce: 1, maxConcurrent: 1, maxQueued: 1 });
			captureErrors();
			for (let round = 0; round < 4; round++) {
				fx.publish(round);
				await vi.advanceTimersByTimeAsync(5);
			}
			expect(fx.started).toEqual([0]);
			await fx.drain();
			expect(fx.started).toEqual([0, 1]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a handler that throws or rejects frees its slot and is reported', async () => {
		const { errors, events } = captureErrors();
		const seen = [];
		const effect = live.effect(['orders'], (event, data) => {
			seen.push(data.i);
			if (data.i % 2) return Promise.reject(new Error('boom ' + data.i));
			throw new Error('boom ' + data.i);
		}, { maxConcurrent: 1, maxQueued: 10 });
		env = createTestEnv();
		env.register('jobs', { notify: effect });
		for (let i = 0; i < 5; i++) env.platform.publish('orders', 'created', { i });
		await flush(30);
		expect(seen).toEqual([0, 1, 2, 3, 4]);
		expect(errors.map((e) => [e.path, e.err.message])).toEqual([0, 1, 2, 3, 4].map((i) => ['effect', 'boom ' + i]));
		expect(events.filter((e) => e.event === 'reactive.effect.failed')).toHaveLength(5);
	});

	it('a thenable whose then throws or calls back twice fails or settles once', async () => {
		const { errors } = captureErrors();
		const registry = fakeRegistry();
		live.metrics(registry);
		const count = (result) => registry.counters.get('svelte_realtime_background_total{"kind":"effect","result":"' + result + '"}');
		const seen = [];
		const held = [];
		const effect = live.effect(['orders'], (event, data) => {
			seen.push(data.i);
			if (data.i === 0) return { then() { throw new Error('bad then'); } };
			if (data.i === 1) return { get then() { throw new Error('bad getter'); } };
			if (data.i === 2) return { then(ok, fail) { ok(); ok(); fail(new Error('late')); } };
			if (data.i >= 5) return new Promise((resolve) => held.push(resolve));
			return Promise.resolve();
		}, { maxConcurrent: 1 });
		env = createTestEnv();
		env.register('jobs', { notify: effect });
		for (let i = 0; i < 5; i++) env.platform.publish('orders', 'created', { i });
		await flush(40);
		expect(seen).toEqual([0, 1, 2, 3, 4]);
		expect(errors.map((e) => e.err.message)).toEqual(['bad then', 'bad getter']);
		expect([count('ok'), count('error')]).toEqual([3, 2]);
		expect(registry.gauges.get('svelte_realtime_background_inflight{"kind":"effect"}')).toBe(0);
		// The lane is intact: two more calls still run one at a time.
		env.platform.publish('orders', 'created', { i: 5 });
		env.platform.publish('orders', 'created', { i: 6 });
		await flush();
		expect(seen.slice(5)).toEqual([5]);
		held.shift()();
		await flush();
		expect(seen.slice(5)).toEqual([5, 6]);
		held.shift()();
		await flush();
		expect(registry.gauges.get('svelte_realtime_background_inflight{"kind":"effect"}')).toBe(0);
	});

	it('a call that never settles gives its slot back at its deadline, once', async () => {
		vi.useFakeTimers();
		try {
			await neverSettlesOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	async function neverSettlesOnce() {
		const { errors, events } = captureErrors();
		const registry = { counter: () => ({ inc(l) { if (l.kind === 'effect') counts[l.result] = (counts[l.result] || 0) + 1; } }), histogram: () => ({ observe() {} }), gauge: () => ({ set() {} }) };
		const counts = {};
		live.metrics(registry);
		const fx = setupEffect({ maxConcurrent: 1, timeoutMs: 400 });
		for (let i = 1; i <= 3; i++) fx.publish(i);
		await flush();
		expect(fx.started).toEqual([1]);
		// Deadline ticks every 100 ms; call 1 started in tick 0 and goes at tick 5.
		await vi.advanceTimersByTimeAsync(499);
		expect(fx.started).toEqual([1]);
		await vi.advanceTimersByTimeAsync(1);
		// Call 1 hung past its deadline: call 2 has its slot, call 3 waits.
		expect(fx.started).toEqual([1, 2]);
		expect(counts.timeout).toBe(1);
		const late = fx.waiting.shift();
		late();
		await flush();
		// The late settlement of call 1 frees nothing: call 3 still waits for call 2.
		expect(fx.started).toEqual([1, 2]);
		expect(counts.ok).toBeUndefined();
		fx.waiting.shift()();
		await flush();
		expect(fx.started).toEqual([1, 2, 3]);
		fx.waiting.shift()();
		await flush();
		expect(counts.ok).toBe(2);
		const timeouts = errors.filter((e) => e.err?.code === 'TIMEOUT');
		expect(timeouts).toHaveLength(1);
		expect(timeouts[0]).toMatchObject({ path: 'effect' });
		expect(events.filter((e) => e.event === 'reactive.effect.timeout').map((e) => e.attributes)).toEqual([{ effect: 'jobs/notify', timeoutMs: 400, released: 1, abandoned: 1 }]);
	}

	it('caps the calls released at their deadline at maxConcurrent', async () => {
		vi.useFakeTimers();
		try {
			const { errors, events } = captureErrors();
			const registry = fakeRegistry();
			live.metrics(registry);
			const inflight = () => registry.gauges.get('svelte_realtime_background_inflight{"kind":"effect"}');
			const fx = setupEffect({ maxConcurrent: 2, maxQueued: 4, timeoutMs: 400 });
			for (let i = 1; i <= 6; i++) fx.publish(i);
			await flush();
			expect(fx.started).toEqual([1, 2]);
			// Calls 1 and 2 hang past their deadline: their slots go to 3 and 4,
			// and all four handlers are still running.
			await vi.advanceTimersByTimeAsync(500);
			expect(fx.started).toEqual([1, 2, 3, 4]);
			expect(inflight()).toBe(4);
			// Calls 3 and 4 hang too. Four calls alive is twice maxConcurrent,
			// so 5 and 6 wait instead of piling up more.
			await vi.advanceTimersByTimeAsync(500);
			expect(fx.started).toEqual([1, 2, 3, 4]);
			expect(inflight()).toBe(4);
			expect(events.filter((e) => e.event === 'reactive.effect.timeout').map((e) => e.attributes.abandoned)).toEqual([2, 4]);
			// Each abandoned call that finally settles lets one waiting call start.
			fx.waiting.shift()();
			await flush();
			expect(fx.started).toEqual([1, 2, 3, 4, 5]);
			fx.waiting.shift()();
			await flush();
			expect(fx.started).toEqual([1, 2, 3, 4, 5, 6]);
			expect(inflight()).toBe(4);
			expect(errors.filter((e) => e.err?.code === 'TIMEOUT')).toHaveLength(2);
			await fx.drain();
			expect(inflight()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('releases a hung call between timeoutMs and 1.25 x timeoutMs, 30000 by default', async () => {
		vi.useFakeTimers();
		try {
			captureErrors();
			const fx = setupEffect({ maxConcurrent: 2 });
			fx.publish(1);
			await flush();
			// Call 2 starts late in the deadline period call 1 started in.
			await vi.advanceTimersByTimeAsync(7000);
			fx.publish(2);
			fx.publish(3);
			await flush();
			expect(fx.started).toEqual([1, 2]);
			// Call 2 keeps its slot for its full 30000 ms.
			await vi.advanceTimersByTimeAsync(29999);
			expect(fx.started).toEqual([1, 2]);
			// Call 1 is released by 37500 ms, 1.25 x timeoutMs after it started.
			await vi.advanceTimersByTimeAsync(501);
			expect(fx.started).toEqual([1, 2, 3]);
			await fx.drain();
		} finally {
			vi.useRealTimers();
		}
	});

	it('timeoutMs: Infinity keeps a pending call in its slot', async () => {
		vi.useFakeTimers();
		try {
			const fx = setupEffect({ maxConcurrent: 1, timeoutMs: Infinity });
			fx.publish(1);
			fx.publish(2);
			await flush();
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			expect(fx.started).toEqual([1]);
			await fx.drain();
		} finally {
			vi.useRealTimers();
		}
	});

	it('validates the limit options at declaration', () => {
		const fn = () => {};
		for (const timeoutMs of [0, 99, 100.5, '1000', 2147483648, -1]) {
			expect(() => live.effect(['a'], fn, { timeoutMs })).toThrow(/timeoutMs must be an integer from 100 to 2147483647/);
		}
		expect(() => live.effect(['a'], fn, { timeoutMs: 100 })).not.toThrow();
		expect(() => live.effect(['a'], fn, { maxConcurrent: 0 })).toThrow(/maxConcurrent must be an integer >= 1/);
		expect(() => live.effect(['a'], fn, { maxConcurrent: 1.5 })).toThrow(/maxConcurrent/);
		expect(() => live.effect(['a'], fn, { maxQueued: -1 })).toThrow(/maxQueued must be an integer >= 0/);
		expect(() => live.effect(['a'], fn, { overflow: 'drop' })).toThrow(/overflow must be 'reject' or 'coalesce'/);
		expect(() => live.effect(['a'], fn, { overflow: 'coalesce', maxQueued: 0 })).toThrow(/coalesce.*maxQueued/);
	});

});

describe('reactive work metrics', () => {
	it('reports in-flight, queued and overflow counts with closed labels', async () => {
		const registry = fakeRegistry();
		live.metrics(registry);
		captureErrors();
		const fx = setupEffect({ maxConcurrent: 2, maxQueued: 3 });
		for (let i = 1; i <= 8; i++) fx.publish(i);
		await flush();
		expect(registry.gauges.get('svelte_realtime_background_inflight{"kind":"effect"}')).toBe(2);
		expect(registry.gauges.get('svelte_realtime_background_queued{"kind":"effect"}')).toBe(3);
		expect(registry.counters.get('svelte_realtime_background_total{"kind":"effect","result":"rejected"}')).toBe(3);
		await fx.drain();
		expect(registry.gauges.get('svelte_realtime_background_inflight{"kind":"effect"}')).toBe(0);
		expect(registry.gauges.get('svelte_realtime_background_queued{"kind":"effect"}')).toBe(0);

		const byName = Object.fromEntries(registry.defs.map((d) => [d.name, d.labelNames]));
		expect(byName.svelte_realtime_background_inflight).toEqual(['kind']);
		expect(byName.svelte_realtime_background_queued).toEqual(['kind']);
		expect(byName.svelte_realtime_background_total).toEqual(['kind', 'result']);
	});

	it('counts coalesced events', async () => {
		const registry = fakeRegistry();
		live.metrics(registry);
		const fx = setupEffect({ maxConcurrent: 1, maxQueued: 1, overflow: 'coalesce' });
		for (let i = 1; i <= 4; i++) fx.publish(i);
		await flush();
		expect(registry.counters.get('svelte_realtime_background_total{"kind":"effect","result":"coalesced"}')).toBe(2);
		await fx.drain();
	});

	it('keeps flag watchers out of the effect series', async () => {
		const registry = fakeRegistry();
		live.metrics(registry);
		const flag = live.flag('feature:metered', 0);
		__registerFlag('feature:metered', 0);
		env = createTestEnv();
		env.register('flags', { metered: flag });
		for (let i = 1; i <= 10; i++) env.platform.publish('feature:metered', 'set', i);
		await flush();
		// The watcher ran for every set, and none of its runs is an effect call.
		expect(flag.get()).toBe(10);
		expect([...registry.counters.keys()].filter((k) => k.includes('"kind":"effect"'))).toEqual([]);
	});

	it('tracks derived computes in flight', async () => {
		const registry = fakeRegistry();
		live.metrics(registry);
		let release;
		let value = 0;
		const derived = live.derived(['src'], () => value === 0 ? 0 : new Promise((r) => { release = () => r(value); }));
		env = createTestEnv();
		env.register('stats', { derived });
		const stream = env.connect().subscribe('stats/derived');
		await stream.waitFor((v) => v === 0);
		value = 1;
		env.platform.publish('src', 'set', 1);
		await flush();
		expect(registry.gauges.get('svelte_realtime_background_inflight{"kind":"derived"}')).toBe(1);
		release();
		await stream.waitFor((v) => v === 1);
		expect(registry.gauges.get('svelte_realtime_background_inflight{"kind":"derived"}')).toBe(0);
	});
});

describe('live.derived under a recompute storm', () => {
	it.each([false, true])('runs one compute at a time and ends on the latest value (dynamic: %s)', async (dynamic) => {
		let value = 0;
		let running = 0;
		let maxRunning = 0;
		let computes = 0;
		const pending = [];
		const compute = () => {
			computes++;
			if (value === 0) return 0;
			running++;
			maxRunning = Math.max(maxRunning, running);
			const snapshot = value;
			return new Promise((resolve) => pending.push(() => { running--; resolve(snapshot); }));
		};
		const derived = dynamic ? live.derived(() => ['src'], compute) : live.derived(['src'], compute);
		env = createTestEnv();
		env.register('stats', { derived });
		const stream = env.connect().subscribe('stats/derived');
		await stream.waitFor((v) => v === 0);
		const before = computes;
		for (let i = 1; i <= 1000; i++) {
			value = i;
			env.platform.publish('src', 'set', i);
			if (i % 100 === 0) {
				await flush();
				pending.shift()?.();
			}
		}
		for (let rounds = 0; pending.length && rounds < 100; rounds++) {
			pending.shift()();
			await flush();
		}
		await stream.waitFor((v) => v === 1000);
		expect(maxRunning).toBe(1);
		// Each released compute leaves at most one follow-up behind it.
		expect(computes - before).toBeLessThanOrEqual(12);
		const values = stream.events.map((e) => e.data);
		expect(values[values.length - 1]).toBe(1000);
		// Never an older result after a newer one.
		for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
	});
});

/** A loopback endpoint that holds every request until released. */
async function heldEndpoint() {
	const held = [];
	let open = 0;
	let maxOpen = 0;
	let received = 0;
	const srv = createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', () => {
			received++;
			open++;
			maxOpen = Math.max(maxOpen, open);
			held.push(() => { open--; res.writeHead(200); res.end(); });
		});
	});
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const port = /** @type {any} */ (srv.address()).port;
	server = { close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
	const wait = async (pred) => {
		for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
	};
	return {
		url: `http://127.0.0.1:${port}/hook`,
		get received() { return received; },
		get maxOpen() { return maxOpen; },
		held, wait,
		async drain(total) {
			for (let i = 0; i < 400 && received < total; i++) {
				for (const release of held.splice(0)) release();
				await new Promise((r) => setTimeout(r, 5));
			}
			for (const release of held.splice(0)) release();
		}
	};
}

describe('live.webhooks.outbound bulkhead', () => {
	it('a stalled endpoint holds at most the default 64 deliveries in flight', async () => {
		const ep = await heldEndpoint();
		env = createTestEnv();
		env.register('hooks', {});
		__registerWebhookOut('hooks/orders', live.webhooks.outbound(['orders'], { url: ep.url, urlMode: 'off', retry: { attempts: 1 } }));
		for (let i = 0; i < 100; i++) env.platform.publish('orders', 'created', { i });
		await ep.wait(() => ep.received >= 64);
		await new Promise((r) => setTimeout(r, 50));
		expect(ep.received).toBe(64);
		await ep.drain(100);
		expect(ep.received).toBe(100);
		expect(ep.maxOpen).toBe(64);
	}, 20000);

	it('an overflowed delivery is reported as OVERLOADED and kept out of the dead-letter store', async () => {
		const ep = await heldEndpoint();
		const { errors, events } = captureErrors();
		configureWebhooks({ deadLetter: true });
		const failures = [];
		env = createTestEnv();
		env.register('hooks', {});
		__registerWebhookOut('hooks/orders', live.webhooks.outbound(['orders'], {
			url: ep.url, urlMode: 'off', retry: { attempts: 1 },
			maxConcurrent: 1, maxQueued: 2,
			onFailure: (err, event, data, attempts) => failures.push({ code: err.code, data, attempts })
		}));
		for (let i = 0; i < 6; i++) env.platform.publish('orders', 'created', { i });
		await flush();
		expect(failures).toEqual([3, 4, 5].map((i) => ({ code: 'OVERLOADED', data: { i }, attempts: 0 })));
		expect(getDeadLetter().list({ topic: 'orders' })).toEqual([]);
		// onFailure is the per-event report, so the global handler stays quiet.
		expect(errors).toEqual([]);
		expect(events.filter((e) => e.event === 'webhook.delivery.overflow')).toHaveLength(1);
		await ep.drain(3);
		expect(ep.received).toBe(3);
		expect(ep.maxOpen).toBe(1);
	}, 20000);

	it('an overflow burst does not evict failed deliveries from the dead-letter store', async () => {
		const ep = await heldEndpoint();
		const failing = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(500); res.end(); }); });
		await new Promise((r) => failing.listen(0, '127.0.0.1', r));
		const closeHeld = server.close;
		server = { close: async () => { failing.closeAllConnections?.(); await new Promise((r) => failing.close(r)); await closeHeld(); } };
		captureErrors();
		configureWebhooks({ deadLetter: createDeadLetterStore({ max: 3 }) });
		env = createTestEnv();
		env.register('hooks', {});
		__registerWebhookOut('hooks/billing', live.webhooks.outbound(['billing'], {
			url: `http://127.0.0.1:${/** @type {any} */ (failing.address()).port}/hook`, urlMode: 'off', retry: { attempts: 1 }, onFailure: () => {}
		}));
		__registerWebhookOut('hooks/orders', live.webhooks.outbound(['orders'], {
			url: ep.url, urlMode: 'off', retry: { attempts: 1 }, maxConcurrent: 1, maxQueued: 0, onFailure: () => {}
		}));
		env.platform.publish('billing', 'charged', { id: 'b1' });
		await ep.wait(() => getDeadLetter().count() === 1);
		for (let i = 0; i < 20; i++) env.platform.publish('orders', 'created', { i });
		await flush();
		expect(getDeadLetter().list().map((r) => r.data)).toEqual([{ id: 'b1' }]);
		await ep.drain(1);
	}, 20000);

	it('without onFailure the global handler hears the episode once', async () => {
		const ep = await heldEndpoint();
		const { errors } = captureErrors();
		env = createTestEnv();
		env.register('hooks', {});
		__registerWebhookOut('hooks/orders', live.webhooks.outbound(['orders'], {
			url: ep.url, urlMode: 'off', retry: { attempts: 1 }, maxConcurrent: 1, maxQueued: 0
		}));
		for (let i = 0; i < 5; i++) env.platform.publish('orders', 'created', { i });
		await flush();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ path: 'webhook', err: { code: 'OVERLOADED' } });
		await ep.drain(1);
	}, 20000);

	it('validates the limit options at declaration', () => {
		const base = { url: 'https://example.com/hook' };
		expect(() => live.webhooks.outbound(['a'], { ...base, maxConcurrent: 0 })).toThrow(/maxConcurrent must be an integer >= 1/);
		expect(() => live.webhooks.outbound(['a'], { ...base, maxQueued: 'x' })).toThrow(/maxQueued must be an integer >= 0/);
	});
});
