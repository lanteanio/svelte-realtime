// live.aggregate({ privacy }): k-anonymity suppression + differential-privacy
// noise. Unit-tests the privacy module (validation, k-anon gate, noise math,
// determinism) plus the gate helper that the aggregate publish sites call.

import { describe, it, expect, afterEach } from 'vitest';
import {
	_normalizeAggregatePrivacy,
	_applyAggregatePrivacy,
	_gateAggregate
} from '../src/server/differential-privacy.js';
import { live, __registerAggregate, _activateDerived, _resetAggregates } from '../src/server.js';
import { mockPlatform } from './helpers/mock-platform.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('_normalizeAggregatePrivacy', () => {
	it('fills defaults (k=5, epsilon=1, hybrid, laplace)', () => {
		const cfg = _normalizeAggregatePrivacy({ contributor: (d) => d.u }, 'topic');
		expect(cfg.k).toBe(5);
		expect(cfg.epsilon).toBe(1.0);
		expect(cfg.strategy).toBe('hybrid');
		expect(cfg.noise).toBe('laplace');
	});

	it('returns null when privacy is absent', () => {
		expect(_normalizeAggregatePrivacy(undefined, 't')).toBeNull();
		expect(_normalizeAggregatePrivacy(null, 't')).toBeNull();
	});

	it('requires a contributor for suppress / hybrid (k-anon needs to count)', () => {
		expect(() => _normalizeAggregatePrivacy({ strategy: 'suppress' }, 't')).toThrow(/contributor/);
		expect(() => _normalizeAggregatePrivacy({ strategy: 'hybrid' }, 't')).toThrow(/contributor/);
		// perturb is noise-only: no contributor needed.
		expect(() => _normalizeAggregatePrivacy({ strategy: 'perturb' }, 't')).not.toThrow();
	});

	it('validates shapes', () => {
		expect(() => _normalizeAggregatePrivacy({ strategy: 'nope', contributor: (d) => d }, 't')).toThrow(/strategy/);
		expect(() => _normalizeAggregatePrivacy({ noise: 'pink', contributor: (d) => d }, 't')).toThrow(/noise/);
		expect(() => _normalizeAggregatePrivacy({ k: 0, contributor: (d) => d }, 't')).toThrow(/positive/);
		expect(() => _normalizeAggregatePrivacy({ epsilon: -1, contributor: (d) => d }, 't')).toThrow(/positive/);
		expect(() => _normalizeAggregatePrivacy({ contributor: 5 }, 't')).toThrow(/contributor must be a function/);
		expect(() => _normalizeAggregatePrivacy({ strategy: 'perturb', fields: 'x' }, 't')).toThrow(/fields/);
	});

	it('sorts fields for stable draw order', () => {
		const cfg = _normalizeAggregatePrivacy({ strategy: 'perturb', fields: ['z', 'a', 'm'] }, 't');
		expect(cfg.fields).toEqual(['a', 'm', 'z']);
	});
});

describe('_applyAggregatePrivacy - k-anonymity', () => {
	const cfg = _normalizeAggregatePrivacy({ k: 5, strategy: 'suppress', contributor: (d) => d.u }, 't');

	it('suppresses below k (holds last value, never null)', () => {
		const r = _applyAggregatePrivacy({ count: 42 }, 4, 'seed', cfg);
		expect(r.suppress).toBe(true);
		expect('value' in r).toBe(false);  // no marker, no null - just held
	});

	it('publishes at/above k', () => {
		const r = _applyAggregatePrivacy({ count: 42 }, 5, 'seed', cfg);
		expect(r.suppress).toBe(false);
		expect(r.value).toEqual({ count: 42 });  // suppress strategy adds NO noise
	});

	it('perturb never suppresses regardless of cohort size', () => {
		const p = _normalizeAggregatePrivacy({ strategy: 'perturb' }, 't');
		expect(_applyAggregatePrivacy({ count: 1 }, 0, 'seed', p).suppress).toBe(false);
	});
});

describe('_applyAggregatePrivacy - differential-privacy noise', () => {
	const cfg = _normalizeAggregatePrivacy({ strategy: 'perturb', epsilon: 1, sensitivity: 1 }, 't');

	it('is deterministic: same seed -> identical noise (cross-replica identity)', () => {
		const a = _applyAggregatePrivacy({ count: 100, sum: 50 }, 99, 'tenant t 1700', cfg);
		const b = _applyAggregatePrivacy({ count: 100, sum: 50 }, 99, 'tenant t 1700', cfg);
		expect(a.value).toEqual(b.value);
		// And it actually moved the value (noise applied).
		expect(a.value.count).not.toBe(100);
	});

	it('differs per seed (per topic / per window)', () => {
		const a = _applyAggregatePrivacy({ count: 100 }, 99, 'seedA', cfg).value.count;
		const b = _applyAggregatePrivacy({ count: 100 }, 99, 'seedB', cfg).value.count;
		expect(a).not.toBe(b);
	});

	it('only perturbs finite numeric fields', () => {
		const r = _applyAggregatePrivacy({ count: 10, label: 'hot', ok: true, nan: NaN }, 99, 's', cfg).value;
		expect(r.label).toBe('hot');
		expect(r.ok).toBe(true);
		expect(Number.isNaN(r.nan)).toBe(true);   // NaN left untouched
		expect(typeof r.count).toBe('number');
	});

	it('Laplace noise is approximately zero-mean over many windows', () => {
		let acc = 0;
		const N = 4000;
		for (let i = 0; i < N; i++) {
			acc += _applyAggregatePrivacy({ v: 1000 }, 99, 'topic ' + i, cfg).value.v - 1000;
		}
		expect(Math.abs(acc / N)).toBeLessThan(5);   // mean noise near 0 (scale=1)
	});

	it('Gaussian noise is approximately zero-mean over many windows', () => {
		const g = _normalizeAggregatePrivacy({ strategy: 'perturb', noise: 'gaussian', epsilon: 1, delta: 1e-5 }, 't');
		let acc = 0;
		const N = 4000;
		for (let i = 0; i < N; i++) {
			acc += _applyAggregatePrivacy({ v: 1000 }, 99, 'g ' + i, g).value.v - 1000;
		}
		expect(Math.abs(acc / N)).toBeLessThan(10);
	});

	it('respects the fields allow-list', () => {
		const f = _normalizeAggregatePrivacy({ strategy: 'perturb', fields: ['a'] }, 't');
		const r = _applyAggregatePrivacy({ a: 10, b: 20 }, 99, 's', f).value;
		expect(r.a).not.toBe(10);   // noised
		expect(r.b).toBe(20);       // not in the allow-list, untouched
	});
});

describe('_gateAggregate', () => {
	it('is a pass-through no-op when privacy is absent', () => {
		const holder = { privacy: null };
		const r = _gateAggregate(holder, { count: 7 }, 't');
		expect(r).toEqual({ publish: true, value: { count: 7 } });
	});

	it('uses cohort.size for the k check and updates _lastWire on a pass', () => {
		const privacy = _normalizeAggregatePrivacy({ k: 3, strategy: 'suppress', contributor: (d) => d.u }, 't');
		const holder = { privacy, cohort: new Set(['a', 'b']), _windowStart: 0, _lastWire: { count: 0 } };
		// 2 < 3 -> suppressed, _lastWire unchanged.
		expect(_gateAggregate(holder, { count: 9 }, 't').publish).toBe(false);
		expect(holder._lastWire).toEqual({ count: 0 });
		// add a third distinct contributor -> passes, _lastWire advances.
		holder.cohort.add('c');
		const r = _gateAggregate(holder, { count: 9 }, 't');
		expect(r.publish).toBe(true);
		expect(holder._lastWire).toEqual({ count: 9 });
	});

	it('counts the union across sliding bucketCohorts', () => {
		const privacy = _normalizeAggregatePrivacy({ k: 3, strategy: 'suppress', contributor: (d) => d.u }, 't');
		const holder = { privacy, bucketCohorts: [new Set(['a', 'b']), new Set(['b', 'c'])], _windowStart: 0, _lastWire: {} };
		// union {a,b,c} = 3 >= k -> publishes.
		expect(_gateAggregate(holder, { count: 1 }, 't').publish).toBe(true);
	});
});

describe('live.aggregate({ privacy }) - through the real engine', () => {
	afterEach(() => { _resetAggregates(); });

	const counter = () => ({ count: { init: () => 0, reduce: (c) => c + 1 } });

	it('suppresses the aggregate below k, then publishes once the cohort reaches k', async () => {
		const agg = live.aggregate('orders-kanon', counter(), {
			topic: 'count-kanon',
			privacy: { k: 3, strategy: 'suppress', contributor: (d) => d.user }
		});
		__registerAggregate('agg/kanon', agg);
		const platform = mockPlatform();
		_activateDerived(platform);

		// Two distinct contributors: below k=3 -> the aggregate output is withheld.
		platform.publish('orders-kanon', 'created', { user: 'a' });
		platform.publish('orders-kanon', 'created', { user: 'b' });
		await tick();
		expect(platform.published.find((p) => p.topic === 'count-kanon')).toBeUndefined();

		// Third DISTINCT contributor reaches k -> the aggregate publishes.
		platform.publish('orders-kanon', 'created', { user: 'c' });
		await tick();
		const pub = platform.published.find((p) => p.topic === 'count-kanon');
		expect(pub).toBeDefined();
		expect(pub.data.count).toBe(3);   // suppress strategy adds no noise
	});

	it('the initial-load loader serves the gated value, not the live below-k aggregate', async () => {
		const agg = live.aggregate('orders-loader', counter(), {
			topic: 'count-loader',
			privacy: { k: 5, strategy: 'suppress', contributor: (d) => d.user }
		});
		__registerAggregate('agg/loader', agg);
		const platform = mockPlatform();
		_activateDerived(platform);
		platform.publish('orders-loader', 'created', { user: 'a' });
		platform.publish('orders-loader', 'created', { user: 'b' });
		await tick();
		// A fresh subscribe (the loader) must NOT reveal the below-k live count (2).
		const initial = await agg();
		expect(initial.count).toBe(0);
	});

	it('repeat contributors do not advance the cohort (distinct count, not event count)', async () => {
		const agg = live.aggregate('orders-distinct', counter(), {
			topic: 'count-distinct',
			privacy: { k: 3, strategy: 'suppress', contributor: (d) => d.user }
		});
		__registerAggregate('agg/distinct', agg);
		const platform = mockPlatform();
		_activateDerived(platform);
		// 5 events but only 2 distinct users -> still below k=3 -> withheld.
		for (const user of ['a', 'a', 'b', 'a', 'b']) platform.publish('orders-distinct', 'created', { user });
		await tick();
		expect(platform.published.find((p) => p.topic === 'count-distinct')).toBeUndefined();
	});
});
