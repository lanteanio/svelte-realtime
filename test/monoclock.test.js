// The monotonic clock that keys the lag-compensation ring: forward wall passes
// through 1:1 (zero offset, byte-identical normal operation), a wall backstep is
// clamped so the axis never decreases, and the accumulated offset (the value the
// shot handler adds to a client render-time) equals the absorbed backstep. Pure:
// every reading comes from the caller, so each case is deterministic.

import { describe, it, expect } from 'vitest';
import { createMonotonicClock } from '../src/server/monoclock.js';

describe('monotonic clock (wall backstep guard)', () => {
	it('passes a forward wall through 1:1 with zero offset (normal operation)', () => {
		const c = createMonotonicClock();
		expect(c.mono(1000)).toBe(1000);
		expect(c.mono(1020)).toBe(1020);
		expect(c.mono(1040)).toBe(1040);
		expect(c.offset()).toBe(0); // mono == wall, no correction
	});

	it('returns the same value for a repeated wall reading (no drift)', () => {
		const c = createMonotonicClock();
		c.mono(1000);
		expect(c.mono(1000)).toBe(1000);
		expect(c.mono(1000)).toBe(1000);
		expect(c.offset()).toBe(0);
	});

	it('clamps a backstep: the monotonic value never decreases', () => {
		const c = createMonotonicClock();
		c.mono(1000);
		c.mono(1050);
		expect(c.mono(900)).toBe(1050); // a 150ms NTP backstep is held, not 900
		// forward progress then resumes from the held cursor (900 -> 920 is +20)
		expect(c.mono(920)).toBe(1070);
	});

	it('the offset equals the absorbed backstep and persists as wall catches up', () => {
		const c = createMonotonicClock();
		c.mono(1000);
		c.mono(1050);
		c.mono(900); // backstep of 150 -> offset 150
		expect(c.offset()).toBe(150);
		// mono and wall now advance together, so the offset is unchanged.
		expect(c.mono(1000)).toBe(1150);
		expect(c.offset()).toBe(150);
	});

	it('accumulates multiple backsteps into the offset', () => {
		const c = createMonotonicClock();
		c.mono(1000);
		c.mono(800); // back 200 -> offset 200
		expect(c.offset()).toBe(200);
		c.mono(900); // forward 100 -> cursor 1100, offset still 200
		expect(c.offset()).toBe(200);
		c.mono(700); // back 200 -> cursor held 1100, offset 400
		expect(c.offset()).toBe(400);
	});

	it('reports a zero offset before any reading', () => {
		expect(createMonotonicClock().offset()).toBe(0);
	});

	it('reset() returns to the never-read state (no clamp memory)', () => {
		const c = createMonotonicClock();
		c.mono(1000);
		c.mono(2000);
		c.reset();
		expect(c.mono(500)).toBe(500); // fresh init, the earlier 2000 does not clamp
		expect(c.offset()).toBe(0);
	});
});
