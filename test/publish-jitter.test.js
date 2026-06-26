import { describe, it, expect, beforeEach } from 'vitest';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { mockPlatform } from './helpers/mock-platform.js';

describe('ctx.publish { jitterMs } (de-herd, server side)', () => {
	let platform;
	let ctx;
	beforeEach(() => {
		platform = mockPlatform();
		// Force the direct publish path (no batch coalescing) so `published` is
		// populated synchronously for the assertions.
		delete platform.publishBatched;
		ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
	});

	it('passes a valid jitterMs through to platform.publish', () => {
		ctx.publish('room', 'reroute', { x: 1 }, { jitterMs: 5000 });
		expect(platform.published.length).toBe(1);
		expect(platform.published[0].options.jitterMs).toBe(5000);
	});

	it('rejects a non-finite or out-of-range jitterMs and publishes nothing', () => {
		expect(() => ctx.publish('room', 'e', {}, { jitterMs: -1 })).toThrow(/jitterMs/);
		expect(() => ctx.publish('room', 'e', {}, { jitterMs: 60001 })).toThrow(/60000/);
		expect(() => ctx.publish('room', 'e', {}, { jitterMs: NaN })).toThrow(/jitterMs/);
		expect(() => ctx.publish('room', 'e', {}, { jitterMs: 'soon' })).toThrow(/jitterMs/);
		expect(platform.published.length).toBe(0);
	});

	it('jitterMs 0 / absent publishes immediately (the no-op default)', () => {
		ctx.publish('room', 'e', { a: 1 });
		ctx.publish('room', 'e', { a: 2 }, { jitterMs: 0 });
		expect(platform.published.length).toBe(2);
	});
});
