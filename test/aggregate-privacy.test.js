// live.aggregate({ privacy }): k-anonymity suppression + differential-privacy
// noise. Unit-tests the privacy module (validation, k-anon gate, noise math,
// determinism) plus the gate helper that the aggregate publish sites call.

import { describe, it, expect, afterEach } from 'vitest';
import {
	_normalizeAggregatePrivacy,
	_applyAggregatePrivacy,
	_gateAggregate,
	_cohortAdd
} from '../src/server/differential-privacy.js';
import { createSharedRandom } from 'svelte-adapter-uws/plugins/smooth/random';
import { state } from '../src/server/state.js';
import { live, realtime, __registerAggregate, __registerDerived, _activateDerived, _resetAggregates } from '../src/server.js';
import { mockPlatform } from './helpers/mock-platform.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

// Operator privacy secret (stands in for `realtime({ privacySecret })`).
const SECRET = 'test-privacy-secret';

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

	it('rejects delta >= 1 (the Gaussian sigma goes NaN)', () => {
		expect(() => _normalizeAggregatePrivacy({ strategy: 'perturb', noise: 'gaussian', delta: 1.5 }, 't')).toThrow(/delta must be < 1/);
		expect(() => _normalizeAggregatePrivacy({ strategy: 'perturb', noise: 'gaussian', delta: 1e-6 }, 't')).not.toThrow();
	});
});

describe('_cohortAdd (bounded + fail-soft)', () => {
	it('caps the Set at k (gate only needs size >= k)', () => {
		const s = new Set();
		for (let i = 0; i < 1000; i++) _cohortAdd(s, 'user-' + i, 5);
		expect(s.size).toBe(5);
	});

	it('skips a null/undefined contributor id (does not collapse the cohort)', () => {
		const s = new Set();
		_cohortAdd(s, undefined, 5);
		_cohortAdd(s, null, 5);
		expect(s.size).toBe(0);
		_cohortAdd(s, 'real', 5);
		expect(s.size).toBe(1);
	});
});

describe('Laplace noise is always finite (clamped tail)', () => {
	it('never returns Infinity/NaN across many seeds', () => {
		const cfg = _normalizeAggregatePrivacy({ strategy: 'perturb', epsilon: 0.01, sensitivity: 1 }, 't');
		for (let i = 0; i < 5000; i++) {
			const v = _applyAggregatePrivacy({ x: 0 }, 99, 'seed ' + i, cfg, SECRET).value.x;
			expect(Number.isFinite(v)).toBe(true);
		}
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
		expect(_applyAggregatePrivacy({ count: 1 }, 0, 'seed', p, SECRET).suppress).toBe(false);
	});
});

describe('_applyAggregatePrivacy - differential-privacy noise', () => {
	const cfg = _normalizeAggregatePrivacy({ strategy: 'perturb', epsilon: 1, sensitivity: 1 }, 't');

	it('is deterministic: same seed + secret -> identical noise (cross-replica identity)', () => {
		const a = _applyAggregatePrivacy({ count: 100, sum: 50 }, 99, 'tenant t 1700', cfg, SECRET);
		const b = _applyAggregatePrivacy({ count: 100, sum: 50 }, 99, 'tenant t 1700', cfg, SECRET);
		expect(a.value).toEqual(b.value);
		// And it actually moved the value (noise applied).
		expect(a.value.count).not.toBe(100);
	});

	it('differs per seed (per topic / per window)', () => {
		const a = _applyAggregatePrivacy({ count: 100 }, 99, 'seedA', cfg, SECRET).value.count;
		const b = _applyAggregatePrivacy({ count: 100 }, 99, 'seedB', cfg, SECRET).value.count;
		expect(a).not.toBe(b);
	});

	it('only perturbs finite numeric fields', () => {
		const r = _applyAggregatePrivacy({ count: 10, label: 'hot', ok: true, nan: NaN }, 99, 's', cfg, SECRET).value;
		expect(r.label).toBe('hot');
		expect(r.ok).toBe(true);
		expect(Number.isNaN(r.nan)).toBe(true);   // NaN left untouched
		expect(typeof r.count).toBe('number');
	});

	it('Laplace noise is approximately zero-mean over many windows', () => {
		let acc = 0;
		const N = 4000;
		for (let i = 0; i < N; i++) {
			acc += _applyAggregatePrivacy({ v: 1000 }, 99, 'topic ' + i, cfg, SECRET).value.v - 1000;
		}
		expect(Math.abs(acc / N)).toBeLessThan(5);   // mean noise near 0 (scale=1)
	});

	it('Gaussian noise is approximately zero-mean over many windows', () => {
		const g = _normalizeAggregatePrivacy({ strategy: 'perturb', noise: 'gaussian', epsilon: 1, delta: 1e-5 }, 't');
		let acc = 0;
		const N = 4000;
		for (let i = 0; i < N; i++) {
			acc += _applyAggregatePrivacy({ v: 1000 }, 99, 'g ' + i, g, SECRET).value.v - 1000;
		}
		expect(Math.abs(acc / N)).toBeLessThan(10);
	});

	it('respects the fields allow-list', () => {
		const f = _normalizeAggregatePrivacy({ strategy: 'perturb', fields: ['a'] }, 't');
		const r = _applyAggregatePrivacy({ a: 10, b: 20 }, 99, 's', f, SECRET).value;
		expect(r.a).not.toBe(10);   // noised
		expect(r.b).toBe(20);       // not in the allow-list, untouched
	});
});

// The noise seed is keyed by the operator privacySecret (HMAC-SHA256
// over tenant|topic|windowStart). Without the secret a subscriber could
// recompute the exact draws and subtract them; with it they cannot.
describe('_applyAggregatePrivacy - keyed noise seed', () => {
	const cfg = _normalizeAggregatePrivacy({ strategy: 'perturb', epsilon: 1, sensitivity: 1 }, 'metrics:revenue');

	it('REFUSES to draw noise without a secret (fail loud, never removable noise)', () => {
		expect(() => _applyAggregatePrivacy({ count: 1 }, 99, 't 0', cfg)).toThrow(/privacySecret/);
		expect(() => _applyAggregatePrivacy({ count: 1 }, 99, 't 0', cfg, null)).toThrow(/privacySecret/);
		expect(() => _applyAggregatePrivacy({ count: 1 }, 99, 't 0', cfg, '')).toThrow(/privacySecret/);
	});

	it('a different secret draws different noise; the same secret reproduces it', () => {
		const a = _applyAggregatePrivacy({ v: 1000 }, 99, 't 0', cfg, 'secret-a').value.v;
		const b = _applyAggregatePrivacy({ v: 1000 }, 99, 't 0', cfg, 'secret-b').value.v;
		expect(a).not.toBe(b);
		expect(_applyAggregatePrivacy({ v: 1000 }, 99, 't 0', cfg, 'secret-a').value.v).toBe(a);
	});

	it('an attacker recomputing the OLD public seed (FNV-1a + mulberry32) no longer recovers the truth', () => {
		const trueState = { totalRevenue: 100000.42, orders: 4317, refunds: 87 };
		const seedStr = '' + ' ' + 'metrics:revenue' + ' ' + 0;
		const gated = _applyAggregatePrivacy({ ...trueState }, Number.POSITIVE_INFINITY, seedStr, cfg, SECRET);

		// The pre-fix public derivation, exactly as a subscriber would recompute it.
		let h = 0x811c9dc5;
		for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 0x01000193); }
		const gen = createSharedRandom(h >>> 0);
		const scale = cfg.sensitivity / cfg.epsilon;
		const attackerNoise = {};
		for (const f of Object.keys(trueState).sort()) {
			const u = gen.float() - 0.5;
			attackerNoise[f] = -scale * Math.sign(u) * Math.log(Math.max(1 - 2 * Math.abs(u), 1e-12));
		}
		// Subtracting the recomputed "noise" must NOT yield the true state.
		let exact = true;
		for (const f of Object.keys(trueState)) {
			if (Math.abs((gated.value[f] - attackerNoise[f]) - trueState[f]) > 1e-9) exact = false;
		}
		expect(exact).toBe(false);
	});

	it('suppress-only strategies still need no secret (k-anonymity draws no noise)', () => {
		const sup = _normalizeAggregatePrivacy({ k: 2, strategy: 'suppress', contributor: (d) => d.u }, 't');
		expect(_applyAggregatePrivacy({ count: 3 }, 2, 's', sup).value).toEqual({ count: 3 });
	});
});

describe('_gateAggregate', () => {
	afterEach(() => { state.privacySecret = null; });

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

	it('reads state.privacySecret: throws for a noise strategy when unset, gates when set', () => {
		const privacy = _normalizeAggregatePrivacy({ strategy: 'perturb' }, 't');
		const holder = { privacy, _windowStart: 0, _lastWire: {} };
		expect(() => _gateAggregate(holder, { count: 5 }, 't')).toThrow(/privacySecret/);
		state.privacySecret = SECRET;
		const r = _gateAggregate(holder, { count: 5 }, 't');
		expect(r.publish).toBe(true);
		expect(r.value.count).not.toBe(5); // keyed noise applied
	});
});

describe('realtime({ privacySecret })', () => {
	afterEach(() => { state.privacySecret = null; });

	it('stores the secret on shared state; rejects a bad shape', () => {
		expect(state.privacySecret).toBeNull();
		realtime({ privacySecret: SECRET });
		expect(state.privacySecret).toBe(SECRET);
		expect(() => realtime({ privacySecret: '' })).toThrow(/privacySecret.*non-empty string/);
		expect(() => realtime({ privacySecret: /** @type {any} */ (42) })).toThrow(/privacySecret.*non-empty string/);
	});
});

describe('live.aggregate({ privacy }) - through the real engine', () => {
	afterEach(() => { _resetAggregates(); state.privacySecret = null; });

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

	// The failure has to land at INIT. A perturb aggregate would throw on its
	// first publish anyway, but a hybrid one suppresses below k and would only
	// throw at the arbitrary later moment its cohort first reaches k - which is
	// how a misconfigured deploy reaches production unnoticed.
	for (const strategy of ['perturb', 'hybrid']) {
		it(`a ${strategy} aggregate refuses to ACTIVATE without privacySecret`, () => {
			const agg = live.aggregate('orders-' + strategy, counter(), {
				topic: 'count-' + strategy,
				privacy: { strategy, epsilon: 1, sensitivity: 1, k: 2, contributor: (d) => d.user }
			});
			__registerAggregate('agg/' + strategy, agg);
			expect(() => _activateDerived(mockPlatform())).toThrow(/privacySecret/);
		});
	}

	// A 32-byte block yields 5 draws. Gaussian takes 2 per field, so 6 fields
	// needs 3 blocks - the counter-mode refill is what makes this a stream rather
	// than a 256-bit one-shot, and nothing else exercises it.
	it('expands past one block: many fields stay deterministic and independently noised', () => {
		const wide = {};
		for (let i = 0; i < 12; i++) wide['f' + i] = 1000;
		const cfg = _normalizeAggregatePrivacy({ strategy: 'perturb', noise: 'gaussian', epsilon: 1, sensitivity: 1 }, 'wide');

		const a = _applyAggregatePrivacy(wide, Infinity, 't 0', cfg, SECRET);
		const b = _applyAggregatePrivacy(wide, Infinity, 't 0', cfg, SECRET);
		// Same seed material -> byte-identical vector (cross-replica determinism),
		// across the block boundary as well as within the first block.
		expect(a.value).toEqual(b.value);

		const vals = Object.values(a.value);
		expect(vals.every((v) => Number.isFinite(v))).toBe(true);
		// Every field is noised, and the draws past the first block are not a
		// repeat of the ones inside it.
		expect(new Set(vals).size).toBe(vals.length);

		// A different secret gives a different vector all the way through.
		const c = _applyAggregatePrivacy(wide, Infinity, 't 0', cfg, SECRET + '-other');
		expect(c.value).not.toEqual(a.value);
	});

	it('a suppress-only aggregate activates fine without a secret', () => {
		const agg = live.aggregate('orders-suppress-only', counter(), {
			topic: 'count-suppress-only',
			privacy: { k: 2, strategy: 'suppress', contributor: (d) => d.user }
		});
		__registerAggregate('agg/suppress-only', agg);
		expect(() => _activateDerived(mockPlatform())).not.toThrow();
	});

	it('a perturb aggregate publishes keyed noise once privacySecret is configured', async () => {
		const agg = live.aggregate('orders-perturb', counter(), {
			topic: 'count-perturb',
			privacy: { strategy: 'perturb', epsilon: 1, sensitivity: 1 }
		});
		__registerAggregate('agg/perturb', agg);
		realtime({ privacySecret: SECRET });
		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders-perturb', 'created', {});
		await tick();
		const pub = platform.published.find((p) => p.topic === 'count-perturb');
		expect(pub).toBeDefined();
		expect(pub.data.count).not.toBe(1); // true count + keyed noise
	});

	// A publish that throws must not take the reactive layer with it: the depth
	// counter is try/finally-guarded, so a later well-configured publish on an
	// UNRELATED derived stream still fires. Without the guard, nine throws wedge
	// _publishDepth above its ceiling and everything goes silent process-wide.
	it('a throwing watcher does not permanently wedge the reactive layer', async () => {
		const platform = mockPlatform();
		const boom = live.aggregate('boom-src', counter(), {
			topic: 'boom-out',
			privacy: { strategy: 'perturb', epsilon: 1, sensitivity: 1 }
		});
		__registerAggregate('agg/boom', boom);
		let recomputes = 0;
		const ok = live.derived(['ok-src'], async () => { recomputes++; return { n: recomputes }; });
		__registerDerived('agg/ok', ok);

		// Activate WITH a secret so init passes, then pull it out from under the
		// running server: every subsequent aggregate publish now throws out of the
		// privacy gate, which is the real escape path through fireWatchers.
		realtime({ privacySecret: SECRET });
		_activateDerived(platform);
		state.privacySecret = null;

		let threw = 0;
		// Far more than the recursion ceiling (8), so a leaked counter is certain.
		for (let i = 0; i < 12; i++) {
			try { platform.publish('boom-src', 'created', {}); } catch { threw++; }
		}
		// Precondition: the throws actually happened, or this proves nothing.
		expect(threw).toBe(12);
		await tick();

		// An UNRELATED derived stream must still recompute. Without the
		// try/finally the depth counter is stuck above its ceiling and every
		// watcher in the process is silently dead from here on.
		platform.publish('ok-src', 'updated', { v: 1 });
		await tick();
		expect(recomputes).toBeGreaterThan(0);
	});
});
