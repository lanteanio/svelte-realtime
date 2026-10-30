// The background work metrics schema: one set of series for cron, alarm,
// poll, derived, effect, outbound webhook and dead-letter work, recorded
// through each primitive's real entry point.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import {
	live, BACKGROUND_METRICS, __registerCron, _clearCron, _tickCron, setCronPlatform, configureCron, configureAlarm, _resetAlarms,
	__registerWebhookOut, _prepareHmr, onError, setOperationalEventSink, configureWebhooks, replayDeadLetter, getDeadLetter
} from '../src/server.js';
import { _bindAlarmCtx } from '../src/server/alarm.js';
import { _fireWebhookOut, _deadLetterCapturesSettled } from '../src/server/webhook-out.js';
import { createTestEnv } from '../src/testing.js';
import { state, registry as liveRegistry, _webhookOutById } from '../src/server/state.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { _resetBackgroundMetrics } from '../src/server/background-metrics.js';
import { createMetrics } from 'svelte-adapter-uws-extensions/prometheus';
import { mockPlatform } from './helpers/mock-platform.js';

const flush = async (n = 16) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

function fakeRegistry() {
	const defs = [];
	const counters = new Map();
	const observed = [];
	const gauges = new Map();
	const labelSets = [];
	const sets = [];
	const key = (name, labels) => name + JSON.stringify(labels || {});
	return {
		defs, counters, observed, gauges, labelSets, sets,
		count(name, labels) { return counters.get(key(name, labels)) || 0; },
		gauge(def) {
			defs.push({ type: 'gauge', ...def });
			return { inc() {}, dec() {}, set(labels, v) { labelSets.push([def.name, labels]); sets.push(def.name); gauges.set(key(def.name, labels), v); } };
		},
		counter(def) {
			defs.push({ type: 'counter', ...def });
			return { inc(labels) { labelSets.push([def.name, labels]); const k = key(def.name, labels); counters.set(k, (counters.get(k) || 0) + 1); } };
		},
		histogram(def) {
			defs.push({ type: 'histogram', ...def });
			return { observe(labels, v) { labelSets.push([def.name, labels]); observed.push({ name: def.name, labels, v }); } };
		}
	};
}

let metrics;
let env = null;
let server = null;
beforeEach(() => {
	metrics = fakeRegistry();
	live.metrics(metrics);
});
afterEach(async () => {
	env?.cleanup();
	env = null;
	_prepareHmr();
	_clearCron();
	configureCron(null);
	configureWebhooks({ deadLetter: false });
	onError(null);
	setOperationalEventSink(null);
	resetRuntimeEnv();
	if (server) await server.close();
	server = null;
	// Every series this file recorded carries only the closed label sets.
	for (const [name, labels] of metrics.labelSets) {
		if (!name.startsWith('svelte_realtime_background_')) continue;
		const withResult = name === BACKGROUND_METRICS.total.name || name === BACKGROUND_METRICS.duration.name;
		expect(Object.keys(labels).sort()).toEqual(withResult ? ['kind', 'result'] : ['kind']);
		expect(BACKGROUND_METRICS.kinds).toContain(labels.kind);
		if (withResult) expect(BACKGROUND_METRICS.results).toContain(labels.result);
	}
	state.metricsInstruments = null;
	_resetBackgroundMetrics();
});

const total = (kind, result) => metrics.count(BACKGROUND_METRICS.total.name, { kind, result });
const durations = (kind, result) => metrics.observed.filter((o) => o.name === BACKGROUND_METRICS.duration.name && o.labels.kind === kind && o.labels.result === result);
const gauge = (name, kind) => metrics.gauges.get(name + JSON.stringify({ kind }));
const INFLIGHT = BACKGROUND_METRICS.inflight.name;
const QUEUED = BACKGROUND_METRICS.queued.name;
const AGE = BACKGROUND_METRICS.oldestAge.name;
const EXHAUSTED = BACKGROUND_METRICS.retriesExhausted.name;

describe('cron', () => {
	it('counts runs by result with a duration, and an overlapping tick as skipped', async () => {
		const platform = mockPlatform();
		setCronPlatform(platform);
		let release;
		let calls = 0;
		__registerCron('jobs/slow', live.cron('* * * * *', 'cron:slow', () => { calls++; return new Promise((r) => { release = r; }); }));
		__registerCron('jobs/bad', live.cron('* * * * *', 'cron:bad', async () => { throw new Error('nope'); }));
		onError(() => {});
		setOperationalEventSink(() => {});
		await _tickCron();
		await flush();
		expect(gauge(INFLIGHT, 'cron')).toBe(1);
		await _tickCron();
		await flush();
		expect(calls).toBe(1);
		expect(total('cron', 'skipped')).toBe(1);
		expect(total('cron', 'error')).toBe(2);
		release(undefined);
		await flush();
		expect(total('cron', 'ok')).toBe(1);
		expect(durations('cron', 'ok')).toHaveLength(1);
		expect(durations('cron', 'error')).toHaveLength(2);
		expect(gauge(INFLIGHT, 'cron')).toBe(0);
	});

	it('counts a tick that finds no platform as skipped', async () => {
		const saved = state.cronPlatform;
		state.cronPlatform = null;
		const fn = vi.fn();
		__registerCron('jobs/early', live.cron('* * * * *', 'cron:early', fn));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await _tickCron();
			await flush();
		} finally {
			warn.mockRestore();
			state.cronPlatform = saved;
		}
		expect(fn).not.toHaveBeenCalled();
		expect(total('cron', 'skipped')).toBe(1);
		expect(durations('cron', 'skipped')).toHaveLength(0);
	});
});

describe('alarm', () => {
	const topic = 'room:metered';
	const meta = { path: 'rooms/metered', tenantId: null };
	let saved;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(10000);
		saved = state.cronPlatform;
		state.cronPlatform = mockPlatform();
		setOperationalEventSink(() => {});
	});
	afterEach(() => {
		_resetAlarms();
		configureAlarm(null);
		state.cronPlatform = saved;
		liveRegistry.delete(meta.path);
		vi.useRealTimers();
	});

	it('counts handler runs and failures', async () => {
		let fail = false;
		const onAlarm = () => { if (fail) throw new Error('nope'); };
		liveRegistry.set(meta.path, live.stream(topic, () => ({}), { alarm: { onAlarm } }));
		const ctx = {};
		_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm, ...meta });
		await ctx.setAlarm(10010);
		await vi.advanceTimersByTimeAsync(10);
		fail = true;
		await ctx.setAlarm(10030);
		await vi.advanceTimersByTimeAsync(20);
		expect(total('alarm', 'ok')).toBe(1);
		expect(total('alarm', 'error')).toBe(1);
		expect(durations('alarm', 'ok')).toHaveLength(1);
		expect(durations('alarm', 'error')).toHaveLength(1);
		expect(gauge(INFLIGHT, 'alarm')).toBe(0);
	});

	it('counts an alarm past its misfire window as skipped', async () => {
		const onAlarm = vi.fn();
		liveRegistry.set(meta.path, live.stream(topic, () => ({}), { alarm: { onAlarm } }));
		const ctx = {};
		_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm, misfireMs: 5, ...meta });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await ctx.setAlarm(9000);
		await vi.advanceTimersByTimeAsync(1);
		warn.mockRestore();
		expect(onAlarm).not.toHaveBeenCalled();
		expect(total('alarm', 'skipped')).toBe(1);
	});

	it('counts an alarm that finds no platform as skipped', async () => {
		const onAlarm = vi.fn();
		liveRegistry.set(meta.path, live.stream(topic, () => ({}), { alarm: { onAlarm } }));
		const ctx = {};
		_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm, ...meta });
		state.cronPlatform = null;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await ctx.setAlarm(10010);
		await vi.advanceTimersByTimeAsync(10);
		warn.mockRestore();
		expect(onAlarm).not.toHaveBeenCalled();
		expect(total('alarm', 'skipped')).toBe(1);
		expect(gauge(INFLIGHT, 'alarm')).toBe(0);
	});
});

describe('poll', () => {
	it('counts ticks that return, reject and throw', async () => {
		vi.useFakeTimers();
		setOperationalEventSink(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let tick = 0;
		const stop = live.poll(() => {
			tick++;
			if (tick === 2) return Promise.reject(new Error('async'));
			if (tick === 3) throw new Error('sync');
			return tick === 4 ? Promise.resolve() : undefined;
		}, 10);
		await vi.advanceTimersByTimeAsync(45);
		stop();
		warn.mockRestore();
		vi.useRealTimers();
		expect(total('poll', 'ok')).toBe(2);
		expect(total('poll', 'error')).toBe(2);
		expect(durations('poll', 'ok')).toHaveLength(2);
		expect(gauge(INFLIGHT, 'poll')).toBe(0);
	});
});

describe('derived', () => {
	it('counts recomputes by result', async () => {
		let fail = false;
		const derived = live.derived(['src'], async () => { if (fail) throw new Error('nope'); return 1; });
		env = createTestEnv();
		env.register('stats', { derived });
		setOperationalEventSink(() => {});
		const stream = env.connect().subscribe('stats/derived');
		await stream.waitFor((v) => v === 1);
		const before = total('derived', 'ok');
		env.platform.publish('src', 'set', 1);
		await flush();
		fail = true;
		env.platform.publish('src', 'set', 2);
		await flush();
		expect(total('derived', 'ok')).toBe(before + 1);
		expect(total('derived', 'error')).toBe(1);
		expect(durations('derived', 'error')).toHaveLength(1);
		expect(gauge(INFLIGHT, 'derived')).toBe(0);
	});
});

describe('effect', () => {
	it('counts handler results and reports the age of the oldest waiting call', async () => {
		let mono = 1000;
		setRuntimeEnv({ clock: { monotonic: () => mono } });
		vi.useFakeTimers();
		try {
			await countsAndAge(() => mono, (v) => { mono = v; });
		} finally {
			vi.useRealTimers();
		}
	});

	async function countsAndAge(getMono, setMono) {
		setOperationalEventSink(() => {});
		onError(() => {});
		const waiting = [];
		const effect = live.effect(['orders'], (event, data) => {
			if (data.i === 0) throw new Error('nope');
			return new Promise((resolve) => waiting.push(resolve));
		}, { maxConcurrent: 1 });
		env = createTestEnv();
		env.register('jobs', { notify: effect });
		for (let i = 0; i < 4; i++) env.platform.publish('orders', 'created', { i });
		await flush();
		expect(total('effect', 'error')).toBe(1);
		expect(gauge(INFLIGHT, 'effect')).toBe(1);
		expect(gauge(QUEUED, 'effect')).toBe(2);
		// The oldest call has waited 1.5 s when the next sample runs.
		setMono(getMono() + 1500);
		await vi.advanceTimersByTimeAsync(1000);
		expect(gauge(AGE, 'effect')).toBe(1.5);
		for (let rounds = 0; rounds < 10; rounds++) {
			for (const release of waiting.splice(0)) release();
			await flush();
		}
		expect(total('effect', 'ok')).toBe(3);
		expect(durations('effect', 'ok')).toHaveLength(3);
		expect(gauge(QUEUED, 'effect')).toBe(0);
		expect(gauge(INFLIGHT, 'effect')).toBe(0);
		expect(gauge(AGE, 'effect')).toBe(0);
	}

	it('writes the running and waiting gauges once per microtask, not once per call', async () => {
		const effect = live.effect(['burst'], () => {});
		env = createTestEnv();
		env.register('jobs', { burst: effect });
		await flush();
		metrics.sets.length = 0;
		for (let i = 0; i < 200; i++) env.platform.publish('burst', 'created', i);
		await flush();
		expect(total('effect', 'ok')).toBe(200);
		expect(gauge(INFLIGHT, 'effect')).toBe(0);
		// A flush writes each running kind and each queue kind once.
		expect(metrics.sets.length).toBeLessThan(40);
	});

	it('reads no clock for effect work while metrics are off', async () => {
		state.metricsInstruments = null;
		let reads = 0;
		const real = performance.now.bind(performance);
		setRuntimeEnv({ clock: { monotonic: () => { reads++; return real(); } } });
		const releases = [];
		const effect = live.effect(['quiet'], () => new Promise((r) => releases.push(r)), { maxConcurrent: 1 });
		env = createTestEnv();
		env.register('jobs', { quiet: effect });
		const run = async (topic) => {
			reads = 0;
			for (let i = 0; i < 3; i++) env.platform.publish(topic, 'created', i);
			for (let i = 0; i < 4; i++) {
				await flush();
				for (const release of releases.splice(0)) release();
			}
			return reads;
		};
		await run('quiet');
		const plain = await run('other');
		// Three calls: one runs at once, two wait in the queue.
		expect(await run('quiet')).toBe(plain);
	});
});

describe('outbound webhook and dead-letter queue', () => {
	async function endpoint(statusRef) {
		const srv = createServer((req, res) => {
			req.on('data', () => {});
			req.on('end', () => { res.writeHead(statusRef.status); res.end(); });
		});
		await new Promise((r) => srv.listen(0, '127.0.0.1', r));
		server = { close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
		return `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/hook`;
	}

	// Each delivery watches its own topic: a registration outlives _prepareHmr.
	let seq = 0;
	async function deliver(url, retry) {
		const failures = [];
		const topic = 'orders:' + seq++;
		env = createTestEnv();
		env.register('hooks', {});
		__registerWebhookOut('hooks/' + topic, live.webhooks.outbound([topic], {
			url, urlMode: 'off', retry, onFailure: (err, event, data, attempts) => failures.push(attempts)
		}));
		env.platform.publish(topic, 'created', { i: 1 });
		for (let i = 0; i < 200 && total('webhook', 'ok') + total('webhook', 'error') === 0; i++) await new Promise((r) => setTimeout(r, 5));
		return { failures, path: 'hooks/' + topic };
	}

	it('counts a delivery that used every attempt as exhausted', async () => {
		setOperationalEventSink(() => {});
		const { failures } = await deliver(await endpoint({ status: 500 }), { attempts: 2, initialDelayMs: 1, maxDelayMs: 2 });
		expect(failures).toEqual([2]);
		expect(total('webhook', 'error')).toBe(1);
		expect(metrics.count(EXHAUSTED, { kind: 'webhook' })).toBe(1);
		expect(durations('webhook', 'error')).toHaveLength(1);
	}, 10000);

	it('does not count a permanent client error as exhausted', async () => {
		setOperationalEventSink(() => {});
		const { failures } = await deliver(await endpoint({ status: 400 }), { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 });
		expect(failures).toEqual([1]);
		expect(total('webhook', 'error')).toBe(1);
		expect(metrics.count(EXHAUSTED, { kind: 'webhook' })).toBe(0);
	}, 10000);

	it('counts a delivered event as ok', async () => {
		await deliver(await endpoint({ status: 200 }), { attempts: 1 });
		expect(total('webhook', 'ok')).toBe(1);
		expect(durations('webhook', 'ok')).toHaveLength(1);
		expect(gauge(INFLIGHT, 'webhook')).toBe(0);
	}, 10000);

	it('reports the built-in dead-letter depth and age, and counts replays', async () => {
		setOperationalEventSink(() => {});
		configureWebhooks({ deadLetter: true });
		expect(gauge(QUEUED, 'dlq')).toBe(0);
		const status = { status: 500 };
		const { path } = await deliver(await endpoint(status), { attempts: 1 });
		expect(gauge(QUEUED, 'dlq')).toBe(1);
		expect(gauge(AGE, 'dlq')).toBeGreaterThanOrEqual(0);
		status.status = 200;
		const out = await replayDeadLetter();
		expect(out.replayed).toBe(1);
		expect(total('dlq', 'ok')).toBe(1);
		expect(durations('dlq', 'ok')).toHaveLength(1);
		expect(gauge(QUEUED, 'dlq')).toBe(0);
		expect(gauge(INFLIGHT, 'dlq')).toBe(0);

		status.status = 500;
		getDeadLetter().add({ webhookId: path, topic: 't', event: 'e', data: {}, attempts: 1, error: 'x' });
		getDeadLetter().add({ webhookId: 'hooks/gone', topic: 't', event: 'e', data: {}, attempts: 1, error: 'x' });
		await replayDeadLetter();
		expect(total('dlq', 'error')).toBe(1);
		expect(total('dlq', 'skipped')).toBe(1);
		await replayDeadLetter({ dryRun: true });
		expect(total('dlq', 'skipped')).toBe(1);
		_webhookOutById.delete(path);

		// A store that is not the built-in one owns the dlq depth and age, so the
		// built-in store's last values are cleared once and then left alone.
		getDeadLetter().add({ webhookId: 'hooks/gone', topic: 't', event: 'e', data: {}, attempts: 1, error: 'x' });
		configureWebhooks({ deadLetter: true });
		expect(gauge(QUEUED, 'dlq')).toBeGreaterThan(0);
		configureWebhooks({ deadLetter: { add() { return 'x'; }, get() { return null; }, remove() { return false; }, list() { return []; }, count() { return 0; }, summary() { return { total: 0, byTopic: {}, oldest: null, newest: null }; } } });
		expect(gauge(QUEUED, 'dlq')).toBe(0);
		expect(gauge(AGE, 'dlq')).toBe(0);
		const writes = metrics.sets.length;
		configureWebhooks({ deadLetter: false });
		expect(metrics.labelSets.slice(-(metrics.sets.length - writes)).filter(([, l]) => l.kind === 'dlq')).toEqual([]);
	}, 10000);

	const blocked = { id: 'test/blocked', config: { url: 'http://127.0.0.1:9/blocked' } }; // loopback -> SSRF-blocked

	it('reports the dead-letter depth when a repeated keyed write lands', async () => {
		setOperationalEventSink(() => {});
		configureWebhooks({ deadLetter: true });
		const store = getDeadLetter();
		const add = store.add.bind(store);
		let lose = true;
		store.add = (rec) => {
			if (lose) { lose = false; return Promise.reject(new Error('connection reset')); }
			return add(rec);
		};
		await _fireWebhookOut(blocked, 'orders', 'created', { id: 1 }, null);
		await _deadLetterCapturesSettled();
		expect(store.count()).toBe(1);
		expect(gauge(QUEUED, 'dlq')).toBe(1);
	}, 10000);

	it('keeps a dead-letter write when the metrics registry throws', async () => {
		const events = [];
		setOperationalEventSink((e) => events.push(e));
		configureWebhooks({ deadLetter: true });
		const gaugeOf = metrics.gauge;
		let broken = false;
		live.metrics({ ...metrics, gauge(def) { const g = gaugeOf(def); return { ...g, set(...args) { if (broken) throw new Error('registry down'); return g.set(...args); } }; } });
		broken = true;
		try {
			await expect(_fireWebhookOut(blocked, 'orders', 'created', { id: 1 }, null)).resolves.not.toThrow();
		} finally {
			broken = false;
		}
		expect(getDeadLetter().count()).toBe(1);
		expect(events.filter((e) => e.event === 'webhook.dead-letter.persist-failed')).toHaveLength(0);
	}, 10000);
});

describe('schema', () => {
	it('registers exactly the exported descriptors', () => {
		const background = metrics.defs.filter((d) => d.name.startsWith('svelte_realtime_background_'));
		const s = BACKGROUND_METRICS;
		const plain = (d) => ({ type: d.type, name: d.name, help: d.help, labelNames: [...d.labelNames] });
		expect(background).toEqual([
			plain(s.total),
			{ ...plain(s.duration), buckets: [...s.duration.buckets] },
			plain(s.inflight),
			plain(s.queued),
			plain(s.oldestAge),
			plain(s.retriesExhausted)
		]);
	});

	it('keeps the vocabularies closed and the descriptors frozen', () => {
		expect(BACKGROUND_METRICS.kinds).toEqual(['cron', 'alarm', 'poll', 'derived', 'effect', 'webhook', 'dlq', 'job', 'task']);
		expect(BACKGROUND_METRICS.results).toEqual(['ok', 'error', 'timeout', 'skipped', 'rejected', 'coalesced']);
		expect(BACKGROUND_METRICS.duration.buckets).toEqual([0.001, 0.005, 0.025, 0.1, 0.25, 1, 2.5, 10, 30, 60, 300, 900, 3600]);
		const frozen = (v) => Object.isFrozen(v) && Object.values(v).every((x) => typeof x !== 'object' || frozen(x));
		expect(frozen(BACKGROUND_METRICS)).toBe(true);
	});

	it('shares one registry with a second producer of the same descriptors', () => {
		const registry = createMetrics({ maxBuckets: BACKGROUND_METRICS.duration.buckets.length });
		live.metrics({
			counter: ({ name, help, labelNames }) => registry.counter(name, help, labelNames),
			histogram: ({ name, help, labelNames, buckets }) => registry.histogram(name, help, { labelNames, buckets }),
			gauge: ({ name, help, labelNames }) => registry.gauge(name, help, labelNames)
		});
		const s = BACKGROUND_METRICS;
		const jobs = registry.counter(s.total.name, s.total.help, [...s.total.labelNames]);
		const runs = registry.histogram(s.duration.name, s.duration.help, { labelNames: [...s.duration.labelNames], buckets: [...s.duration.buckets] });
		jobs.inc({ kind: 'job', result: 'ok' });
		runs.observe({ kind: 'job', result: 'ok' }, 0.2);
		state.metricsInstruments.backgroundTotal.inc({ kind: 'cron', result: 'ok' });
		const text = registry.serialize();
		expect(text).toContain('svelte_realtime_background_total{kind="job",result="ok"} 1');
		expect(text).toContain('svelte_realtime_background_total{kind="cron",result="ok"} 1');
		expect(text).toContain('svelte_realtime_background_duration_seconds_bucket{kind="job",result="ok",le="0.25"} 1');
	});

	it('matches the contract table in docs/background-metrics.md', () => {
		const doc = readFileSync(new URL('../docs/background-metrics.md', import.meta.url), 'utf8');
		for (const key of ['total', 'duration', 'inflight', 'queued', 'oldestAge', 'retriesExhausted']) {
			const d = BACKGROUND_METRICS[key];
			const row = '| `' + d.name + '` | ' + d.type + ' | ' + d.labelNames.map((l) => '`' + l + '`').join(', ') + ' | ' + d.help + ' |';
			expect(doc).toContain(row);
		}
		expect(doc).toContain(BACKGROUND_METRICS.duration.buckets.join(', '));
		for (const kind of BACKGROUND_METRICS.kinds) expect(doc).toContain('| `' + kind + '` |');
		for (const result of BACKGROUND_METRICS.results) expect(doc).toContain('| `' + result + '` |');
	});
});
