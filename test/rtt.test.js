// Server-anchored latency tracker: the per-connection round-trip estimator that
// bounds how far back a shot may rewind. Pure (time passed in), so these tests
// drive it with explicit wall stamps - no timers.

import { describe, it, expect } from 'vitest';
import { createRttTracker } from '../src/server/rtt.js';

describe('rtt tracker (server-anchored latency)', () => {
	it('returns null before any sample', () => {
		const t = createRttTracker();
		expect(t.maxUplink()).toBe(null);
		expect(t.minUplink()).toBe(null);
	});

	it('tracks the max and min uplink over recent samples', () => {
		const t = createRttTracker();
		t.sample(20, 1000);
		t.sample(50, 1010);
		t.sample(10, 1020);
		expect(t.maxUplink()).toBe(50);
		expect(t.minUplink()).toBe(10);
	});

	it('ignores negative and non-finite samples', () => {
		const t = createRttTracker();
		t.sample(-5, 1000);
		t.sample(Infinity, 1000);
		t.sample(NaN, 1000);
		expect(t.maxUplink()).toBe(null);
		expect(t.minUplink()).toBe(null);
	});

	it('the min is the un-inflatable floor: an inflated sample raises max but never lowers min', () => {
		const t = createRttTracker();
		t.sample(20, 1000); // honest
		t.sample(500, 1010); // a stale-ackT inflation attempt
		expect(t.minUplink()).toBe(20); // delay only adds: the floor holds
		expect(t.maxUplink()).toBe(500);
	});

	it('rotates buckets so an old extreme ages out of the window', () => {
		const t = createRttTracker({ bucketMs: 100, buckets: 2 });
		t.sample(200, 0);
		expect(t.maxUplink()).toBe(200);
		// 250ms later rotates past both buckets, clearing the one the 200 lived in.
		t.sample(30, 250);
		expect(t.maxUplink()).toBe(30);
		expect(t.minUplink()).toBe(30);
	});

	it('keeps an extreme that is still inside the window', () => {
		const t = createRttTracker({ bucketMs: 100, buckets: 4 });
		t.sample(200, 0);
		t.sample(30, 150); // one bucket later, still in the 4x100ms window
		expect(t.maxUplink()).toBe(200);
		expect(t.minUplink()).toBe(30);
	});
});
