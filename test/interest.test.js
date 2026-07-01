// The relevancy layer on top of the spatial grid: per-subscriber radius cull,
// the whole-board safety default for an uncentered subscriber, always-visible
// passthrough, the reported-center override, and the level-of-detail cadence
// (near every tick / fringe throttled, with first-sight + band-crossing always
// delivered and hysteresis at the ring edges). Determinism: identical inputs and
// tick produce an identical relevancy relation, with no RNG anywhere.

import { describe, it, expect } from 'vitest';
import { createInterestState } from '../src/server/interest.js';

/** Mirror interest.js's FNV-1a so the test can assert the exact staggered cadence. */
function hashKey(key) {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
/** The set of ticks (within [0, rate)) on which `key` is due at send-rate `rate`. */
function staggerSlot(key, rate) {
	return hashKey(key) % rate;
}

/** A catalog entry whose state carries an {x,y}; position() reads it back. */
function at(key, x, y) {
	return { key, state: { x, y } };
}
const position = (s) => (s && s.global ? null : { x: s.x, y: s.y });
const keysOf = (set) => [...set].sort();

describe('interest relevancy', () => {
	it('culls to entities within radius, including the subscriber own entity at the center', () => {
		const state = createInterestState({ radius: 100, position });
		// 'A' is both a subscriber and an entity at the origin -> its own position is the center.
		const catalog = [at('A', 0, 0), at('b', 50, 0), at('c', 200, 0)];
		const rel = state.compute(catalog, ['A'], 0);
		expect(keysOf(rel.get('A'))).toEqual(['A', 'b']); // c is 200 away, outside r=100
	});

	it('delivers the whole board to a subscriber with no own entity and no reported center', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('a', 0, 0), at('b', 50, 0), at('c', 999, 0)];
		const rel = state.compute(catalog, ['spectator'], 0);
		expect(keysOf(rel.get('spectator'))).toEqual(['a', 'b', 'c']);
	});

	it('a reported center overrides the own-entity default', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('A', 0, 0), at('b', 50, 0), at('c', 500, 0)];
		// Without a report, A sees A + b. Report a center at c's position -> A sees only c.
		state.reportCenter('A', 500, 0);
		const rel = state.compute(catalog, ['A'], 0);
		expect(keysOf(rel.get('A'))).toEqual(['c']);
		// Clearing the report reverts to the own-entity center.
		state.clearCenter('A');
		const rel2 = state.compute(catalog, ['A'], 0);
		expect(keysOf(rel2.get('A'))).toEqual(['A', 'b']);
	});

	it('an always-visible (null-position) entity is delivered regardless of distance', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('A', 0, 0), at('far', 9999, 0), { key: 'flag', state: { global: true } }];
		const rel = state.compute(catalog, ['A'], 0);
		expect(keysOf(rel.get('A'))).toEqual(['A', 'flag']); // far is out of range; flag is always-visible
	});

	it('a near entity sends on every change; a fringe entity throttles to its band cadence', () => {
		const state = createInterestState({
			radius: 1000,
			position,
			lod: [{ within: 100, rate: 1 }, { within: 1000, rate: 4 }]
		});
		const farSlot = staggerSlot('far', 4);
		// A fresh catalog each tick: the moving entities present a NEW state object
		// each tick (the authority hands back a new object only on an actual move),
		// while staying inside their bands. A holds the centre at the origin.
		const tickCatalog = (t) => [at('A', 0, 0), at('near', 50 + (t % 2), 0), at('far', 500 + (t % 2), 0)];

		// Tick 0 is a first sight for both -> both delivered.
		expect(keysOf(state.compute(tickCatalog(0), ['A'], 0).get('A'))).toContain('far');

		// Over a full band period the near entity is present on every move; the fringe
		// entity is present exactly on its staggered slot (and absent otherwise).
		for (let t = 1; t <= 8; t++) {
			const rel = state.compute(tickCatalog(t), ['A'], t).get('A');
			expect(rel.has('near')).toBe(true); // band 0, rate 1, moved -> every tick
			expect(rel.has('far')).toBe(t % 4 === farSlot);
		}
	});

	it('delivers an idle entity a subscriber moves into range of (first-sight catch-up, no update of its own)', () => {
		// The critical case a green suite missed: X is stationary far away; A walks
		// toward it. X never changes its state object, so it produces no "update" -
		// yet the moment X enters A's radius it must be marked for delivery, so A is
		// caught up to X's current position instead of rendering it at a stale spot.
		const state = createInterestState({ radius: 100, position });
		const X = { x: 1000, y: 0 }; // one stable object - X never moves
		const cat = (ax) => [{ key: 'A', state: { x: ax, y: 0 } }, { key: 'X', state: X }];
		expect(state.compute(cat(0), ['A'], 0).get('A').has('X')).toBe(false); // 1000 away
		expect(state.compute(cat(500), ['A'], 1).get('A').has('X')).toBe(false); // 500 away
		expect(state.compute(cat(950), ['A'], 2).get('A').has('X')).toBe(true); // 50 away -> first-sight
		// Still in range next tick but unchanged and already delivered -> not re-sent.
		expect(state.compute(cat(950), ['A'], 3).get('A').has('X')).toBe(false);
	});

	it('an entity entering range is delivered on the first tick it is in range', () => {
		const state = createInterestState({
			radius: 1000,
			position,
			lod: [{ within: 100, rate: 1 }, { within: 1000, rate: 4 }]
		});
		// 'late' starts far outside, then steps into the fringe band on a tick that
		// is NOT its staggered slot - first-sight must still deliver it.
		const farSlot = staggerSlot('late', 4);
		const offSlot = (farSlot + 1) % 4;
		const out = [at('A', 0, 0), at('late', 5000, 0)];
		const ins = [at('A', 0, 0), at('late', 500, 0)];
		state.compute(out, ['A'], 0); // late out of range
		const rel = state.compute(ins, ['A'], offSlot).get('A'); // enters on a non-due tick
		expect(rel.has('late')).toBe(true);
	});

	it('an entity crossing into a nearer band is delivered on the crossing tick, off-cadence', () => {
		// Three bands so the crossing target is itself throttled (rate 3): this
		// isolates "a band change forces a delivery" from "band 0 is rate 1 anyway".
		const state = createInterestState({
			radius: 1000,
			position,
			lod: [{ within: 100, rate: 1 }, { within: 400, rate: 3 }, { within: 1000, rate: 6 }]
		});
		// 'mover' sits in the outer band (rate 6), then crosses into the middle band
		// (rate 3) on a tick that is NOT its middle-band slot - the band change alone
		// must deliver it.
		const slot3 = staggerSlot('mover', 3);
		const off3 = (slot3 + 1) % 3;
		const tick = off3 === 0 ? 3 : off3; // > 0 (tick 0 was first sight) and not slot3
		const outer = [at('A', 0, 0), at('mover', 700, 0)];
		const middle = [at('A', 0, 0), at('mover', 250, 0)];
		state.compute(outer, ['A'], 0); // first sight in the outer band
		expect(tick % 3).not.toBe(slot3); // guard: the crossing tick is genuinely off-cadence
		const rel = state.compute(middle, ['A'], tick).get('A');
		expect(rel.has('mover')).toBe(true);
	});

	it('hysteresis keeps an entity hovering on a band edge from flipping bands', () => {
		const state = createInterestState({
			radius: 1000,
			position,
			lod: [{ within: 100, rate: 1 }, { within: 1000, rate: 4 }]
		});
		// Band 0 outer edge is 100; its 10% hysteresis margin pushes the move-out
		// threshold to 110. An entity oscillating between 95 and 105 stays in band 0
		// (rate 1), so it is present on EVERY tick. Were it flipping to band 1
		// (rate 4) it would be absent on most ticks.
		const hover = (d) => [at('A', 0, 0), at('h', d, 0)];
		state.compute(hover(95), ['A'], 0); // settle in band 0
		for (let t = 1; t <= 6; t++) {
			const d = t % 2 === 0 ? 105 : 95; // straddle the edge, within the margin
			expect(state.compute(hover(d), ['A'], t).get('A').has('h')).toBe(true);
		}
		// Past the margin (130 > 110) it genuinely demotes to band 1 and throttles.
		const slot = staggerSlot('h', 4);
		const off = slot === 1 ? 2 : 1;
		// Two off-slot ticks in band 1: a real demotion drops it on at least one.
		state.compute(hover(130), ['A'], off);
		const dropped = !state.compute(hover(130), ['A'], off + 4).get('A').has('h');
		expect(dropped).toBe(true);
	});

	it('forgets a departed subscriber so a re-entry is a fresh first-sight', () => {
		const state = createInterestState({
			radius: 1000,
			position,
			lod: [{ within: 100, rate: 1 }, { within: 1000, rate: 4 }]
		});
		const catalog = [at('A', 0, 0), at('far', 500, 0)];
		const slot = staggerSlot('far', 4);
		const off = (slot + 1) % 4;
		state.compute(catalog, ['A'], 0); // A tracks 'far' in band 1
		state.compute(catalog, ['other'], 1); // A absent -> its band state is pruned
		// A returns on an off-slot tick; without pruning 'far' would be throttled
		// out, but the cleared state makes it a first-sight again -> delivered.
		expect(state.compute(catalog, ['A'], off).get('A').has('far')).toBe(true);
	});

	it('releaseSubscriber drops a subscriber center and band state explicitly', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('A', 0, 0), at('b', 50, 0)];
		state.reportCenter('A', 9999, 0); // a far reported center -> A sees nothing nearby
		expect(keysOf(state.compute(catalog, ['A'], 0).get('A'))).toEqual([]);
		state.releaseSubscriber('A');
		// Center gone -> A reverts to its own-entity center and sees A + b again.
		expect(keysOf(state.compute(catalog, ['A'], 0).get('A'))).toEqual(['A', 'b']);
	});

	it('is deterministic: identical inputs and tick produce an identical relation', () => {
		const make = () => createInterestState({
			radius: 1000,
			position,
			lod: [{ within: 100, rate: 1 }, { within: 1000, rate: 4 }]
		});
		const catalog = [];
		const subscribers = [];
		for (let i = 0; i < 40; i++) {
			const key = 's' + i;
			catalog.push(at(key, (i * 137) % 2000, (i * 311) % 2000));
			if (i % 3 === 0) subscribers.push(key);
		}
		const a = make();
		const b = make();
		for (let t = 0; t < 5; t++) {
			const ra = a.compute(catalog, subscribers, t);
			const rb = b.compute(catalog, subscribers, t);
			expect([...ra.keys()].sort()).toEqual([...rb.keys()].sort());
			for (const id of ra.keys()) {
				expect(keysOf(ra.get(id))).toEqual(keysOf(rb.get(id)));
			}
		}
	});

	it('matches the flat cull when the catalog crosses the index threshold', () => {
		// Above INDEX_CROSSOVER (512) compute builds the spatial index; the relation
		// must still be exactly the in-radius set (the grid test proves index==flat;
		// this proves the relevancy layer drives it correctly at scale).
		const state = createInterestState({ radius: 300, position });
		const catalog = [at('A', 0, 0)];
		for (let i = 0; i < 600; i++) catalog.push(at('e' + i, (i * 17) % 4000, (i * 53) % 4000));
		const rel = state.compute(catalog, ['A'], 0).get('A');
		// Independently compute the expected in-radius set by brute force.
		const expected = ['A'];
		for (let i = 0; i < 600; i++) {
			const x = (i * 17) % 4000, y = (i * 53) % 4000;
			if (x * x + y * y <= 300 * 300) expected.push('e' + i);
		}
		expect(keysOf(rel)).toEqual(expected.sort());
	});
});

describe('getCandidates (lag-comp candidate set)', () => {
	it('returns the FULL in-range membership, including a stationary entity the deltas drop', () => {
		const state = createInterestState({ radius: 100, position });
		// Same state references on both ticks: tick 1 is first-sight (delivered),
		// tick 2 sees state === prevSent so the delta is empty - but the entity is
		// still in range, so it must remain a candidate.
		const a = at('A', 0, 0);
		const b = at('b', 50, 0);
		const catalog = [a, b];
		const rel1 = state.compute(catalog, ['A'], 0);
		expect(keysOf(rel1.get('A'))).toEqual(['A', 'b']); // first sight delivers both
		const rel2 = state.compute(catalog, ['A'], 1);
		expect(keysOf(rel2.get('A'))).toEqual([]); // nothing moved -> empty delta
		// The candidate set is unchanged: a stationary in-range target is still hittable.
		expect([...state.getCandidates('A')].sort()).toEqual(['A', 'b']);
	});

	it('drops an entity from the candidate set once it leaves range', () => {
		const state = createInterestState({ radius: 100, position });
		state.compute([at('A', 0, 0), at('b', 50, 0)], ['A'], 0);
		expect([...state.getCandidates('A')].sort()).toEqual(['A', 'b']);
		// b moves out of radius -> pruned from the in-range membership.
		state.compute([at('A', 0, 0), at('b', 500, 0)], ['A'], 1);
		expect([...state.getCandidates('A')].sort()).toEqual(['A']);
	});

	it('includes always-visible (null-position) entities as candidates', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('A', 0, 0), { key: 'g', state: { global: true } }];
		state.compute(catalog, ['A'], 0);
		expect([...state.getCandidates('A')].sort()).toEqual(['A', 'g']);
	});

	it('returns undefined for an unknown subscriber', () => {
		const state = createInterestState({ radius: 100, position });
		state.compute([at('A', 0, 0)], ['A'], 0);
		expect(state.getCandidates('nobody')).toBeUndefined();
	});

	it('a whole-board subscriber (no center) has the whole board as candidates', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('a', 0, 0), at('b', 50, 0), at('c', 999, 0)];
		state.compute(catalog, ['spectator'], 0);
		expect([...state.getCandidates('spectator')].sort()).toEqual(['a', 'b', 'c']);
	});
});

describe('candidatesAt (lag-comp candidate broadphase)', () => {
	it('exposes the cull radius the shoot handler gates against', () => {
		expect(createInterestState({ radius: 250, position }).radius).toBe(250);
	});

	it('returns the entity keys whose last-tick position is within the query radius', () => {
		const state = createInterestState({ radius: 100, position });
		state.compute([at('A', 0, 0), at('b', 50, 0), at('c', 300, 0)], ['A'], 0);
		// The query radius is independent of the cull radius (it is the shot broadphase).
		expect(state.candidatesAt(0, 0, 120).sort()).toEqual(['A', 'b']); // c at 300 is out
		expect(state.candidatesAt(0, 0, 400).sort()).toEqual(['A', 'b', 'c']); // wider pulls c
	});

	it('recovers an entity that has left a subscriber in-range membership (the departed shell)', () => {
		const state = createInterestState({ radius: 100, position });
		state.compute([at('A', 0, 0), at('b', 50, 0)], ['A'], 0);
		expect([...state.getCandidates('A')].sort()).toEqual(['A', 'b']);
		// b drifts out of A's interest radius -> pruned from the membership set...
		state.compute([at('A', 0, 0), at('b', 200, 0)], ['A'], 1);
		expect([...state.getCandidates('A')].sort()).toEqual(['A']);
		// ...but candidatesAt still finds it near its last-tick position. This is the
		// broadphase the rewound gate relies on to recover a target that drifted out
		// mid-flight (the receipt-time set no longer lists it, the geometry still does).
		expect(state.candidatesAt(0, 0, 300).sort()).toEqual(['A', 'b']);
	});

	it('excludes always-visible (ring-less) entities from the broadphase', () => {
		const state = createInterestState({ radius: 100, position });
		state.compute([at('A', 0, 0), { key: 'flag', state: { global: true } }], ['A'], 0);
		// 'flag' has a null position -> never a position-based hit candidate.
		expect(state.candidatesAt(0, 0, 100000)).toEqual(['A']);
	});

	it('returns empty before the first compute and after reset', () => {
		const state = createInterestState({ radius: 100, position });
		expect(state.candidatesAt(0, 0, 1000)).toEqual([]);
		state.compute([at('A', 0, 0), at('b', 50, 0)], ['A'], 0);
		expect(state.candidatesAt(0, 0, 100).sort()).toEqual(['A', 'b']);
		state.reset();
		expect(state.candidatesAt(0, 0, 100)).toEqual([]);
	});

	it('matches the flat broadphase above the index threshold', () => {
		// Above INDEX_CROSSOVER (512) compute builds the spatial index; candidatesAt must
		// query it to the same set the flat scan would produce.
		const state = createInterestState({ radius: 300, position });
		const catalog = [at('A', 0, 0)];
		for (let i = 0; i < 600; i++) catalog.push(at('e' + i, (i * 17) % 4000, (i * 53) % 4000));
		state.compute(catalog, ['A'], 0); // 601 entities -> indexed path
		const got = state.candidatesAt(0, 0, 500).sort();
		const expected = [];
		for (const e of catalog) {
			const p = position(e.state);
			if (p && p.x * p.x + p.y * p.y <= 500 * 500) expected.push(e.key);
		}
		expect(got).toEqual(expected.sort());
	});
});

describe('send cadence (lag-comp interpolation-delay estimate)', () => {
	it('seeds the delay at twice the tick rate for an unknown subscriber', () => {
		const state = createInterestState({ radius: 100, position });
		expect(state.interpDelayMs('nobody', 20)).toBe(40); // clamp(2*20, 32, 250)
	});

	it('a tick-rate cadence holds the delay at twice the tick (the dense path stays put)', () => {
		const state = createInterestState({ radius: 100, position });
		for (let t = 1000; t <= 1200; t += 20) state.noteSend('A', t, 20);
		expect(state.interpDelayMs('A', 20)).toBe(40); // every-tick sends -> no widening
	});

	it('a sparse cadence widens the delay toward twice the send interval', () => {
		const sparse = createInterestState({ radius: 100, position });
		const dense = createInterestState({ radius: 100, position });
		for (let t = 1000, i = 0; i < 20; i++, t += 80) sparse.noteSend('A', t, 20); // every 4 ticks
		for (let t = 1000, i = 0; i < 20; i++, t += 20) dense.noteSend('A', t, 20); // every tick
		expect(dense.interpDelayMs('A', 20)).toBe(40);
		expect(sparse.interpDelayMs('A', 20)).toBeGreaterThan(120); // toward clamp(2*80,..)=160
		expect(sparse.interpDelayMs('A', 20)).toBeLessThan(160);
	});

	it('clamps to the 32ms floor for a very fast tick', () => {
		const state = createInterestState({ radius: 100, position });
		expect(state.interpDelayMs('nobody', 10)).toBe(32); // 2*10 = 20 < 32
	});

	it('clamps to the 250ms ceiling for a very sparse cadence', () => {
		const state = createInterestState({ radius: 100, position });
		for (let t = 1000, i = 0; i < 60; i++, t += 500) state.noteSend('A', t, 20);
		expect(state.interpDelayMs('A', 20)).toBe(250); // 2*~500 -> ceiling
	});

	it('a repeated send stamp does not perturb the cadence', () => {
		const state = createInterestState({ radius: 100, position });
		state.noteSend('A', 1000, 20);
		state.noteSend('A', 1020, 20);
		state.noteSend('A', 1020, 20); // d = 0 -> skipped
		state.noteSend('A', 1020, 20);
		expect(state.interpDelayMs('A', 20)).toBe(40);
	});

	it('ignores an out-of-range gap (a long pause is not a cadence signal)', () => {
		const state = createInterestState({ radius: 100, position });
		state.noteSend('A', 1000, 20);
		state.noteSend('A', 1020, 20);
		state.noteSend('A', 5000, 20); // d = 3980 >= 2000 -> skipped
		expect(state.interpDelayMs('A', 20)).toBe(40);
	});

	it('releases a widened delay slowly on a densify (rise at once, fall no faster than the client)', () => {
		const state = createInterestState({ radius: 100, position });
		let t = 1000;
		// Sparse (100ms interval) drives the delay wide; the rise is instant (attack).
		for (let i = 0; i < 30; i++, t += 100) state.noteSend('A', t, 20);
		expect(state.interpDelayMs('A', 20)).toBeGreaterThan(150); // toward clamp(2*100,..) = 200
		// Densify to the tick rate. After a short dense run the delay must NOT snap to the
		// dense target (40): it releases at most ~3% of the elapsed wall, mirroring the
		// client's appliedDelay slew-down, so a re-densifying target's reach cannot retract
		// ahead of the client and drop honest shots.
		for (let i = 0; i < 5; i++, t += 20) state.noteSend('A', t, 20);
		expect(state.interpDelayMs('A', 20)).toBeGreaterThan(150); // still wide, not snapped
		// Partway through it is releasing - below the wide value, still above the dense target.
		for (let i = 0; i < 100; i++, t += 20) state.noteSend('A', t, 20);
		const mid = state.interpDelayMs('A', 20);
		expect(mid).toBeGreaterThan(40);
		expect(mid).toBeLessThan(150);
		// After a long dense run it settles at the dense target.
		for (let i = 0; i < 2000; i++, t += 20) state.noteSend('A', t, 20);
		expect(state.interpDelayMs('A', 20)).toBeCloseTo(40, 5);
	});

	it('forgets a subscriber cadence on release and on reset', () => {
		const state = createInterestState({ radius: 100, position });
		for (let t = 1000, i = 0; i < 10; i++, t += 80) state.noteSend('A', t, 20);
		expect(state.interpDelayMs('A', 20)).toBeGreaterThan(40);
		state.releaseSubscriber('A');
		expect(state.interpDelayMs('A', 20)).toBe(40); // back to the seed fallback
		for (let t = 1000, i = 0; i < 10; i++, t += 80) state.noteSend('B', t, 20);
		state.reset();
		expect(state.interpDelayMs('B', 20)).toBe(40);
	});
});

describe('snapshotFor (the interest-scoped join snapshot)', () => {
	it('scopes the catalog to the radius around the own-entity center, keeping always-visible entities', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('A', 0, 0), at('near', 50, 0), at('far', 500, 0), { key: 'flag', state: { global: true } }];
		const keys = state.snapshotFor('A', catalog).map((e) => e.key).sort();
		expect(keys).toEqual(['A', 'flag', 'near']); // far is outside r=100
	});

	it('a reported center drives the scope, and the own entity is ALWAYS included (the reconciliation basis)', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('A', 0, 0), at('near', 50, 0), at('remote', 5000, 0)];
		// A free-cam spectator watching 5000 units away: the roster is scoped to the
		// watched area, but A's own entity must never fall out of its own snapshot.
		state.reportCenter('A', 5000, 0);
		const keys = state.snapshotFor('A', catalog).map((e) => e.key).sort();
		expect(keys).toEqual(['A', 'remote']);
	});

	it('delivers the whole catalog to a subscriber with no resolvable center (over-deliver polarity)', () => {
		const state = createInterestState({ radius: 100, position });
		const catalog = [at('a', 0, 0), at('b', 9999, 0)];
		expect(state.snapshotFor('spectator', catalog)).toBe(catalog);
		// An own entity whose position is null (always-visible) resolves no center either.
		const withNull = [{ key: 'A', state: { global: true } }, at('b', 9999, 0)];
		expect(state.snapshotFor('A', withNull)).toBe(withNull);
	});

	it('a throwing position() is treated as always-visible, never aborting the join', () => {
		const state = createInterestState({ radius: 100, position: (s) => { if (s.boom) throw new Error('bad'); return { x: s.x, y: s.y }; } });
		const catalog = [{ key: 'A', state: { x: 0, y: 0 } }, { key: 'b', state: { boom: true } }, { key: 'far', state: { x: 500, y: 0 } }];
		const keys = state.snapshotFor('A', catalog).map((e) => e.key).sort();
		expect(keys).toEqual(['A', 'b']);
	});

	it('does not perturb the retained candidatesAt snapshot (no shared scratch)', () => {
		const state = createInterestState({ radius: 100, position });
		// A compute pass retains its positions for the between-tick broadphase.
		state.compute([at('A', 0, 0), at('b', 50, 0)], ['A'], 0);
		expect(state.candidatesAt(0, 0, 100).sort()).toEqual(['A', 'b']);
		// A join against a DIFFERENT catalog (an entity moved, another joined) must
		// not rewrite the retained snapshot the shoot broadphase still reads.
		state.snapshotFor('A', [at('A', 0, 0), at('b', 9000, 0), at('c', 10, 0)]);
		expect(state.candidatesAt(0, 0, 100).sort()).toEqual(['A', 'b']);
	});
});
