// The lag-compensation ring: per-entity position history, bracket-interpolated
// rewind (never extrapolate), the teleport-abort guard, the out-of-window fail-safe,
// candidate-gated rewind, and the pure ray-vs-shape narrowphase helpers. The ring
// takes its timestamps from the caller, so every case here is deterministic.

import { describe, it, expect } from 'vitest';
import { createLagComp, rayCircleHit, rayAabbHit } from '../src/server/lagcomp.js';
import { createMonotonicClock } from '../src/server/monoclock.js';

/** A catalog entry whose state carries an {x,y}; position() reads it back. */
const at = (key, x, y, extra = {}) => ({ key, state: { x, y, ...extra } });
const position = (s) => (s && s.hidden ? null : { x: s.x, y: s.y });
const mk = (opts = {}) => createLagComp({ position, tickMs: 50, maxRewindMs: 1000, ...opts });

describe('lag-comp ring: record + bracket-interpolated sample', () => {
	it('interpolates linearly between the two bracketing records', () => {
		const ring = mk();
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 100, 40)], 1050);
		const s = ring.sample('a', 1025); // halfway
		expect(s.x).toBeCloseTo(50);
		expect(s.y).toBeCloseTo(20);
		expect(s.fallback).toBe(false);
	});

	it('returns the snap-to-previous STATE while lerping position', () => {
		const ring = mk();
		ring.record([at('a', 0, 0, { crouch: true })], 1000);
		ring.record([at('a', 100, 0, { crouch: false })], 1050);
		const s = ring.sample('a', 1040); // closest at-or-before is t=1000 (crouch:true)
		expect(s.x).toBeCloseTo(80);
		expect(s.state.crouch).toBe(true); // stance is snap-to-previous, not lerped
	});

	it('clamps to the newest record at or after now (never extrapolates forward)', () => {
		const ring = mk();
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 100, 0)], 1050);
		const s = ring.sample('a', 9999); // far future
		expect(s.x).toBe(100);
		expect(s.fallback).toBe(false); // current state is what the shooter saw
	});

	it('fails safe to current state (fallback) when the rewind is older than maxRewindMs', () => {
		const ring = mk({ maxRewindMs: 1000 });
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 50, 0)], 2000);
		const s = ring.sample('a', 900); // 2000 - 900 = 1100 > 1000
		expect(s.x).toBe(50); // newest, not the oldest marker
		expect(s.fallback).toBe(true);
	});

	it('fails safe (fallback) when the rewind predates the oldest held record', () => {
		const ring = mk();
		for (let i = 0; i < 5; i++) ring.record([at('a', i * 10, 0)], 1000 + i * 50); // 1000..1200
		const s = ring.sample('a', 950); // before oldest (1000), still inside the 1000ms window
		expect(s.x).toBe(40); // newest (t=1200), not the oldest
		expect(s.fallback).toBe(true);
	});

	it('returns null for an entity with no history', () => {
		const ring = mk();
		expect(ring.sample('ghost', 1000)).toBeNull();
	});

	it('skips a null-position (always-visible) entity from the ring', () => {
		const ring = mk();
		ring.record([at('a', 0, 0), { key: 'g', state: { hidden: true } }], 1000);
		expect(ring.size).toBe(1);
		expect(ring.sample('g', 1000)).toBeNull();
	});
});

describe('lag-comp ring: teleport-abort', () => {
	it('aborts (returns null) when the bracketing pair straddles a jump over the threshold', () => {
		const ring = mk({ teleportThreshold: 50 });
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 300, 0)], 1050); // jump of 300 > 50
		expect(ring.sample('a', 1025)).toBeNull();
	});

	it('does not abort for movement within the threshold', () => {
		const ring = mk({ teleportThreshold: 50 });
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 30, 0)], 1050); // jump of 30 < 50
		expect(ring.sample('a', 1025).x).toBeCloseTo(15);
	});

	it('never aborts when no teleportThreshold is configured', () => {
		const ring = mk(); // threshold off
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 9999, 0)], 1050);
		expect(ring.sample('a', 1025)).not.toBeNull();
	});
});

describe('lag-comp ring: discontinuity (death / respawn) guard', () => {
	it('refuses to LERP across a death gap, even with no teleportThreshold set', () => {
		const ring = mk({ tickMs: 50 }); // gapMs = 100, teleport guard OFF (default)
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 10, 0)], 1050);
		// Dead for 300ms: a null-position record is skipped, leaving a gap in the ring.
		ring.record([at('a', 0, 0, { hidden: true })], 1100);
		ring.record([at('a', 0, 0, { hidden: true })], 1300);
		ring.record([at('a', 500, 0)], 1350); // respawn far away -> resume after the gap
		// A rewind INTO the dead interval must MISS, not interpolate a phantom from the
		// corpse (10,0) toward the spawn (500,0). The teleport-distance guard is off,
		// so only the time-gap discontinuity catches this.
		expect(ring.sample('a', 1200)).toBe(null);
		// A rewind BEFORE the death still interpolates normally.
		const before = ring.sample('a', 1025);
		expect(before).not.toBe(null);
		expect(before.x).toBeCloseTo(5);
		// A rewind at the respawn clamps to it.
		expect(ring.sample('a', 1350).x).toBe(500);
	});

	it('does not flag normal tick-spaced records as a discontinuity', () => {
		const ring = mk({ tickMs: 50 });
		ring.record([at('a', 0, 0)], 1000);
		ring.record([at('a', 30, 0)], 1050);
		ring.record([at('a', 60, 0)], 1100);
		const s = ring.sample('a', 1075); // mid second interval, no gap
		expect(s).not.toBe(null);
		expect(s.x).toBeCloseTo(45);
	});
});

describe('lag-comp ring: eviction + rewind(candidateKeys)', () => {
	it('keeps recent history correct after the ring wraps past capacity', () => {
		const ring = mk(); // cap ~ 23 at tickMs 50 / window 1000
		for (let i = 0; i < 60; i++) ring.record([at('a', i * 10, 0)], 1000 + i * 50);
		// newest is i=59 (t=3950, x=590); a recent rewind still interpolates correctly.
		const s = ring.sample('a', 3925); // between i=58 (t=3900,x=580) and i=59 (t=3950,x=590)
		expect(s.x).toBeCloseTo(585);
		expect(s.fallback).toBe(false);
	});

	it('rewind() returns only candidate entities that have a servable history', () => {
		const ring = mk({ teleportThreshold: 50 });
		ring.record([at('a', 0, 0), at('b', 0, 0), at('c', 0, 0)], 1000);
		ring.record([at('a', 20, 0), at('b', 20, 0), at('c', 500, 0)], 1050); // c teleports
		// candidate set names a,b,c,ghost; ghost has no history, c teleport-aborts.
		const world = ring.rewind(['a', 'b', 'c', 'ghost'], 1025);
		expect([...world.keys()].sort()).toEqual(['a', 'b']);
		expect(world.get('a').x).toBeCloseTo(10);
	});

	it('rewind() excludes an entity outside the candidate set (default-deny)', () => {
		const ring = mk();
		ring.record([at('a', 0, 0), at('secret', 0, 0)], 1000);
		ring.record([at('a', 20, 0), at('secret', 20, 0)], 1050);
		const world = ring.rewind(['a'], 1025); // 'secret' not a candidate
		expect([...world.keys()]).toEqual(['a']);
	});

	it('remove() and reset() drop rings', () => {
		const ring = mk();
		ring.record([at('a', 0, 0), at('b', 0, 0)], 1000);
		expect(ring.size).toBe(2);
		ring.remove('a');
		expect(ring.size).toBe(1);
		ring.reset();
		expect(ring.size).toBe(0);
	});
});

describe('lag-comp ring: rewindWithin (rewound candidate gate)', () => {
	it('keeps only candidates within the gate radius of the center at the rewind instant', () => {
		const ring = mk();
		ring.record([at('near', 0, 0), at('far', 0, 0)], 1000);
		ring.record([at('near', 50, 0), at('far', 800, 0)], 1050);
		// At t=1025: near -> (25,0), far -> (400,0). Center (0,0), radius 100 -> only 'near'.
		const world = ring.rewindWithin(['near', 'far'], 1025, 0, 0, 100 * 100);
		expect([...world.keys()]).toEqual(['near']);
		expect(world.get('near').x).toBeCloseTo(25);
	});

	it('gates against the position at the rewind instant, not the current position', () => {
		const ring = mk();
		// 'mover' was inside the gate early and drifted out by the latest record.
		ring.record([at('mover', 20, 0)], 1000);
		ring.record([at('mover', 400, 0)], 1050);
		// Rewound to t=1000 it is at (20,0): inside radius 100 of the origin -> kept,
		// even though its CURRENT position (400,0) is well outside.
		const inGate = ring.rewindWithin(['mover'], 1000, 0, 0, 100 * 100);
		expect([...inGate.keys()]).toEqual(['mover']);
		// Rewound to t=1050 it is at (400,0): outside the gate -> dropped.
		const outGate = ring.rewindWithin(['mover'], 1050, 0, 0, 100 * 100);
		expect([...outGate.keys()]).toEqual([]);
	});

	it('still drops no-history and discontinuity candidates inside the radius', () => {
		const ring = mk({ tickMs: 50 }); // gapMs = 100
		ring.record([at('a', 10, 0)], 1000);
		ring.record([at('a', 10, 0, { hidden: true })], 1100);
		ring.record([at('a', 10, 0, { hidden: true })], 1300);
		ring.record([at('a', 10, 0)], 1350); // resume after a death gap
		// 'a' sits inside the radius the whole time, but a rewind into the dead interval
		// still returns null from sample() -> excluded; 'ghost' has no history -> excluded.
		const world = ring.rewindWithin(['a', 'ghost'], 1200, 0, 0, 1000 * 1000);
		expect([...world.keys()]).toEqual([]);
	});

	it('rewind() is rewindWithin with an unbounded radius (every servable candidate)', () => {
		const ring = mk();
		ring.record([at('a', 0, 0), at('b', 9999, 0)], 1000);
		ring.record([at('a', 20, 0), at('b', 9999, 0)], 1050);
		// No gate -> both kept regardless of distance from any center.
		const world = ring.rewind(['a', 'b'], 1025);
		expect([...world.keys()].sort()).toEqual(['a', 'b']);
	});
});

describe('lag-comp ring keyed through the monotonic clock (wall backstep safety)', () => {
	// The smooth tick keys the ring through createMonotonicClock (record at mono(t)),
	// so a server wall-clock step cannot feed the ring a timestamp older than its
	// newest. This drives the same record sequence a tick would, including a backstep.
	it('a wall backstep does not corrupt a pre-backstep rewind', () => {
		const clock = createMonotonicClock();
		const ring = mk({ tickMs: 20, maxRewindMs: 200 });
		// Forward ticks: the target slides along the ray.
		ring.record([at('t', 0, 0)], clock.mono(1000));
		ring.record([at('t', 100, 0)], clock.mono(1020));
		ring.record([at('t', 200, 0)], clock.mono(1040));
		// The server wall clock steps BACK to 940 (NTP / live-migration). The tick keys
		// the record through the clock, so it lands at the clamped monotonic time (the
		// held cursor 1040), NOT 940 - the ring axis stays monotonic.
		const mBack = clock.mono(940);
		expect(mBack).toBe(1040);
		ring.record([at('t', 300, 0)], mBack);
		// A rewind to a pre-backstep instant still interpolates the correct historical
		// position - no garbage bracket from a non-monotonic timestamp.
		const s = ring.sample('t', 1010); // mono 1010, between the 1000 and 1020 records
		expect(s.x).toBeCloseTo(50);
		expect(s.fallback).toBe(false);
	});

	it('once wall catches back up, records advance again past the held cursor', () => {
		const clock = createMonotonicClock();
		const ring = mk({ tickMs: 20, maxRewindMs: 500 });
		ring.record([at('t', 0, 0)], clock.mono(1000));
		ring.record([at('t', 100, 0)], clock.mono(1040));
		ring.record([at('t', 200, 0)], clock.mono(960)); // backstep -> held at 1040
		// Wall climbs back: 960 -> 1000 is +40 from the clamped point -> mono 1080.
		const m = clock.mono(1000);
		expect(m).toBe(1080);
		ring.record([at('t', 300, 0)], m);
		// The newest record (mono 1080) clamps a present-time rewind to the live state.
		expect(ring.sample('t', 1080).x).toBe(300);
	});
});

describe('lag-comp narrowphase: rayCircleHit', () => {
	it('hits a circle ahead on the ray at the near intersection', () => {
		const h = rayCircleHit(0, 0, 1, 0, 100, 50, 0, 10);
		expect(h.dist).toBeCloseTo(40);
		expect(h.point.x).toBeCloseTo(40);
	});
	it('misses when the perpendicular distance exceeds the radius', () => {
		expect(rayCircleHit(0, 0, 1, 0, 100, 50, 50, 10)).toBeNull();
	});
	it('misses a circle entirely behind the origin', () => {
		expect(rayCircleHit(0, 0, 1, 0, 100, -50, 0, 10)).toBeNull();
	});
	it('misses a circle beyond maxDist', () => {
		expect(rayCircleHit(0, 0, 1, 0, 100, 200, 0, 10)).toBeNull();
	});
	it('hits at distance 0 when the origin is inside the circle', () => {
		const h = rayCircleHit(0, 0, 1, 0, 100, 0, 0, 10);
		expect(h.dist).toBe(0);
	});
});

describe('lag-comp narrowphase: rayAabbHit', () => {
	it('hits a box ahead on the ray at the entry face', () => {
		const h = rayAabbHit(0, 0, 1, 0, 100, 50, 0, 20, 20);
		expect(h.dist).toBeCloseTo(40); // box spans x in [40,60]
		expect(h.point.x).toBeCloseTo(40);
	});
	it('misses a box offset off the ray axis', () => {
		expect(rayAabbHit(0, 0, 1, 0, 100, 50, 50, 20, 20)).toBeNull();
	});
	it('misses a box beyond maxDist', () => {
		expect(rayAabbHit(0, 0, 1, 0, 30, 50, 0, 20, 20)).toBeNull();
	});
});
