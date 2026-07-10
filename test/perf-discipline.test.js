// The performance-discipline pack: cohort-stratified RPC metrics (never
// trust the aggregate), per-subsystem performance budgets with drift
// tracking, the push-not-poll helper (live.poll works but nudges once toward
// the push primitives), the pause-aware lifeline /metrics snapshot on the
// admin route, and the recorded-response test fixtures.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { live } from '../src/server.js';
import { state } from '../src/server/state.js';
import { _recordRpcMetrics } from '../src/server/metrics.js';
import { _createAdminHandler } from '../src/server/admin.js';
import { recordResponse, replayResponse, clearRecordedResponses } from '../src/testing.js';

/** A minimal registry fake recording every instrument operation. */
function fakeRegistry() {
	const series = new Map(); // name -> [{op, labels, value?}]
	const record = (name) => (op) => (labels, value) => {
		let list = series.get(name);
		if (!list) { list = []; series.set(name, list); }
		list.push({ op, labels, value });
	};
	const reg = {
		series,
		counter: ({ name }) => ({ inc: record(name)('inc') }),
		histogram: ({ name }) => ({ observe: record(name)('observe') }),
		gauge: ({ name }) => ({ inc: record(name)('inc'), dec: record(name)('dec'), set: record(name)('set') }),
		serialize: vi.fn(async () => '# fake metrics output\nup 1\n')
	};
	return reg;
}

function fakeWs(userData) {
	return { getUserData: () => userData };
}

afterEach(() => {
	state.metricsInstruments = null;
	state.metricsLifeline = undefined;
	clearRecordedResponses();
	vi.useRealTimers();
});

describe('cohort-stratified metrics', () => {
	it('labels the RPC series by the classifier cohort, cached per connection', () => {
		const reg = fakeRegistry();
		let calls = 0;
		live.metrics(reg, { cohort: (ud) => { calls++; return ud.deviceClass; } });

		const ws = fakeWs({ deviceClass: 'mobile-3g' });
		_recordRpcMetrics('todos/add', '', 1, ws);
		_recordRpcMetrics('todos/add', 'INTERNAL', 1, ws);

		const counts = reg.series.get('svelte_realtime_rpc_total');
		expect(counts[0].labels).toEqual({ path: 'todos/add', status: 'ok', cohort: 'mobile-3g' });
		expect(counts[1].labels).toEqual({ path: 'todos/add', status: 'error', cohort: 'mobile-3g' });
		expect(reg.series.get('svelte_realtime_rpc_errors_total')[0].labels).toMatchObject({ cohort: 'mobile-3g' });
		expect(reg.series.get('svelte_realtime_rpc_duration_seconds')[0].labels).toMatchObject({ cohort: 'mobile-3g' });
		// Classified ONCE per connection, not per call.
		expect(calls).toBe(1);
	});

	it('a missing socket or throwing classifier reads as the unknown cohort', () => {
		const reg = fakeRegistry();
		live.metrics(reg, { cohort: () => { throw new Error('bad'); } });
		_recordRpcMetrics('x', '', 0, undefined);
		_recordRpcMetrics('x', '', 0, fakeWs({}));
		const counts = reg.series.get('svelte_realtime_rpc_total');
		expect(counts[0].labels.cohort).toBe('unknown');
		expect(counts[1].labels.cohort).toBe('unknown');
	});

	it('bounds distinct cohorts (overflow folds into other)', () => {
		const reg = fakeRegistry();
		let n = 0;
		live.metrics(reg, { cohort: () => 'cohort-' + (n++) });
		for (let i = 0; i < 20; i++) _recordRpcMetrics('x', '', 0, fakeWs({}));
		const cohorts = reg.series.get('svelte_realtime_rpc_total').map((s) => s.labels.cohort);
		expect(new Set(cohorts).size).toBeLessThanOrEqual(17); // 16 distinct + 'other'
		expect(cohorts).toContain('other');
	});

	it('without the option the series stay unlabeled (byte-identical to before)', () => {
		const reg = fakeRegistry();
		live.metrics(reg);
		_recordRpcMetrics('x', '', 0, fakeWs({}));
		expect(reg.series.get('svelte_realtime_rpc_total')[0].labels).toEqual({ path: 'x', status: 'ok' });
	});

	it('validates the classifier', () => {
		expect(() => live.metrics(fakeRegistry(), { cohort: 'nope' })).toThrow(/cohort/);
	});
});

describe('live.perfBudget', () => {
	it('declares the budget, observes actuals, and counts overruns', () => {
		const reg = fakeRegistry();
		live.metrics(reg);
		const budget = live.perfBudget('tick', 10);

		expect(reg.series.get('svelte_realtime_perf_budget_seconds')[0]).toMatchObject({ op: 'set', labels: { subsystem: 'tick' }, value: 0.01 });

		budget.track(5);
		budget.track(25);
		const actuals = reg.series.get('svelte_realtime_perf_actual_seconds');
		expect(actuals.map((a) => a.value)).toEqual([0.005, 0.025]);
		const exceeded = reg.series.get('svelte_realtime_perf_budget_exceeded_total');
		expect(exceeded).toHaveLength(1);
		expect(exceeded[0].labels).toEqual({ subsystem: 'tick' });
	});

	it('measure() times a sync fn and an async fn (rejections still tracked)', async () => {
		const reg = fakeRegistry();
		live.metrics(reg);
		const budget = live.perfBudget('db', 1000);

		expect(budget.measure(() => 42)).toBe(42);
		await expect(budget.measure(async () => 'ok')).resolves.toBe('ok');
		await expect(budget.measure(async () => { throw new Error('x'); })).rejects.toThrow('x');
		expect(reg.series.get('svelte_realtime_perf_actual_seconds')).toHaveLength(3);
	});

	it('requires live.metrics first and validates its arguments', () => {
		state.metricsInstruments = null;
		expect(() => live.perfBudget('tick', 10)).toThrow(/live\.metrics/);
		const reg = fakeRegistry();
		live.metrics(reg);
		expect(() => live.perfBudget('', 10)).toThrow(/subsystem/);
		expect(() => live.perfBudget('tick', 0)).toThrow(/budgetMs/);
	});
});

describe('live.poll (push, not poll)', () => {
	it('polls on the interval, survives a throwing tick, and stops cleanly', async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			let ticks = 0;
			const stop = live.poll(() => {
				ticks++;
				if (ticks === 1) throw new Error('tick failure');
			}, 100);
			await vi.advanceTimersByTimeAsync(350);
			expect(ticks).toBe(3);
			stop();
			stop(); // idempotent
			await vi.advanceTimersByTimeAsync(500);
			expect(ticks).toBe(3);
			// The one-time dev nudge toward the push primitives fired.
			expect(warn.mock.calls.some((c) => String(c[0]).includes('push'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('validates its arguments', () => {
		expect(() => live.poll('nope', 100)).toThrow(/fn/);
		expect(() => live.poll(() => {}, 0)).toThrow(/intervalMs/);
	});
});

describe('lifeline /metrics (pause-aware scrape)', () => {
	function adminReq(path) {
		return new Request('http://localhost/__realtime' + path, { method: 'GET' });
	}

	it('serves the pre-serialized snapshot with its age header', async () => {
		const reg = fakeRegistry();
		live.metrics(reg, { lifeline: { intervalMs: 100 } });
		// The immediate render is async; let it settle.
		await new Promise((r) => setTimeout(r, 0));

		const handler = _createAdminHandler({ requires: () => true });
		const res = await handler(adminReq('/metrics'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/plain');
		expect(res.headers.get('x-snapshot-age-ms')).toMatch(/^\d+$/);
		expect(await res.text()).toContain('# fake metrics output');
		// The scrape did NOT trigger a serialize - it read the snapshot.
		expect(reg.serialize).toHaveBeenCalledTimes(1);
	});

	it('answers 503 with guidance when the lifeline is not enabled', async () => {
		const handler = _createAdminHandler({ requires: () => true });
		const res = await handler(adminReq('/metrics'));
		expect(res.status).toBe(503);
		expect((await res.json()).hint).toContain('lifeline');
	});

	it('requires a serializable registry and validates the interval', () => {
		expect(() => live.metrics({ counter: () => ({ inc() {} }), histogram: () => ({ observe() {} }), gauge: () => ({ inc() {}, dec() {} }) }, { lifeline: true })).toThrow(/serialize/);
		expect(() => live.metrics(fakeRegistry(), { lifeline: { intervalMs: 10 } })).toThrow(/intervalMs/);
	});
});

describe('recorded-response fixtures', () => {
	it('replays a deep copy per call and fails loudly on unknown refs', () => {
		recordResponse('todos/list@happy', { ok: true, data: [{ id: 1, title: 'x' }] });
		const a = replayResponse('todos/list@happy');
		a.data[0].title = 'mutated';
		const b = replayResponse('todos/list@happy');
		expect(b.data[0].title).toBe('x');
		expect(() => replayResponse('nope')).toThrow(/no recorded response/);
	});

	it('clears one ref or all, and validates inputs', () => {
		recordResponse('a', 1);
		recordResponse('b', 2);
		clearRecordedResponses('a');
		expect(() => replayResponse('a')).toThrow();
		expect(replayResponse('b')).toBe(2);
		clearRecordedResponses();
		expect(() => replayResponse('b')).toThrow();
		expect(() => recordResponse('', 1)).toThrow(/ref/);
		expect(() => recordResponse('c', { x: 1n })).toThrow(/JSON-serializable/);
	});
});
