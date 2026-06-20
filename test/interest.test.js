// The K4 relevancy layer on top of the spatial grid: per-subscriber radius cull,
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

describe('interest relevancy (K4)', () => {
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

describe('getCandidates (K2 candidate set)', () => {
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
