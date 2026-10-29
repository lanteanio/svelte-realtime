// Bounded reactive fan-out: an effect or outbound webhook that stalls holds a
// bounded number of handler calls in flight and a bounded queue behind them,
// with a declared overflow policy; a derived stream never runs two computes at
// once and settles on the latest source state. Everything is driven through
// the real publish path of a test environment.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { live, onError, configureWebhooks, getDeadLetter, __registerWebhookOut, _prepareHmr, setOperationalEventSink } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { state } from '../src/server/state.js';

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
		const fx = setupEffect({ debounce: 1, maxConcurrent: 1, maxQueued: 1 });
		captureErrors();
		for (let round = 0; round < 4; round++) {
			fx.publish(round);
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(fx.started).toEqual([0]);
		await fx.drain();
		expect(fx.started).toEqual([0, 1]);
	});

	it('a handler that throws synchronously frees its slot', async () => {
		captureErrors();
		const seen = [];
		const effect = live.effect(['orders'], (event, data) => {
			seen.push(data.i);
			throw new Error('boom');
		}, { maxConcurrent: 1, maxQueued: 10 });
		env = createTestEnv();
		env.register('jobs', { notify: effect });
		for (let i = 0; i < 5; i++) env.platform.publish('orders', 'created', { i });
		await flush(30);
		expect(seen).toEqual([0, 1, 2, 3, 4]);
	});

	it('validates the limit options at declaration', () => {
		const fn = () => {};
		expect(() => live.effect(['a'], fn, { maxConcurrent: 0 })).toThrow(/maxConcurrent must be an integer >= 1/);
		expect(() => live.effect(['a'], fn, { maxConcurrent: 1.5 })).toThrow(/maxConcurrent/);
		expect(() => live.effect(['a'], fn, { maxQueued: -1 })).toThrow(/maxQueued must be an integer >= 0/);
		expect(() => live.effect(['a'], fn, { overflow: 'drop' })).toThrow(/overflow must be 'reject' or 'coalesce'/);
		expect(() => live.effect(['a'], fn, { overflow: 'coalesce', maxQueued: 0 })).toThrow(/coalesce.*maxQueued/);
	});

	it('a burst of flag sets settles on the newest value', async () => {
		const flag = live.flag('feature:burst', 0);
		env = createTestEnv();
		env.register('flags', { burst: flag });
		for (let i = 1; i <= 20000; i++) env.platform.publish('feature:burst', 'set', i);
		await flush();
		expect(flag.get()).toBe(20000);
	});
});

describe('reactive work metrics', () => {
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

	it('counts coalesced events and keeps flag watchers out of the series', async () => {
		const registry = fakeRegistry();
		live.metrics(registry);
		const fx = setupEffect({ maxConcurrent: 1, maxQueued: 1, overflow: 'coalesce' });
		live.flag('feature:metered', 0);
		for (let i = 1; i <= 10; i++) env.platform.publish('feature:metered', 'set', i);
		for (let i = 1; i <= 4; i++) fx.publish(i);
		await flush();
		expect(registry.counters.get('svelte_realtime_background_total{"kind":"effect","result":"coalesced"}')).toBe(2);
		await fx.drain();
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
	it('a stalled endpoint holds at most the default 8 deliveries in flight', async () => {
		const ep = await heldEndpoint();
		env = createTestEnv();
		env.register('hooks', {});
		__registerWebhookOut('hooks/orders', live.webhooks.outbound(['orders'], { url: ep.url, urlMode: 'off', retry: { attempts: 1 } }));
		for (let i = 0; i < 30; i++) env.platform.publish('orders', 'created', { i });
		await ep.wait(() => ep.received >= 8);
		await new Promise((r) => setTimeout(r, 50));
		expect(ep.received).toBe(8);
		await ep.drain(30);
		expect(ep.received).toBe(30);
		expect(ep.maxOpen).toBe(8);
	}, 20000);

	it('an overflowed delivery is reported as OVERLOADED and dead-lettered', async () => {
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
		const records = getDeadLetter().list({ topic: 'orders' });
		expect(records.map((r) => r.data.i).sort()).toEqual([3, 4, 5]);
		expect(records.every((r) => r.webhookId === 'hooks/orders' && r.attempts === 0 && r.error.includes('at its limit'))).toBe(true);
		// onFailure is the per-event report, so the global handler stays quiet.
		expect(errors).toEqual([]);
		expect(events.filter((e) => e.event === 'webhook.delivery.overflow')).toHaveLength(1);
		await ep.drain(3);
		expect(ep.received).toBe(3);
		expect(ep.maxOpen).toBe(1);
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
