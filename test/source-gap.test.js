import { describe, it, expect, vi } from 'vitest';
import { sourceGap } from '../src/server/source-gap.js';

describe('external source gap signal', () => {
	it('publishes an unsequenced reserved event on the subscribed data topic', () => {
		const platform = { publish: vi.fn(() => true) };
		expect(sourceGap(platform, 'items', { source: 'postgres-notify', reason: 'reconnect', jitterMs: 1000 })).toBe(true);
		expect(platform.publish).toHaveBeenCalledWith('items', '__realtime.gap', { source: 'postgres-notify', reason: 'reconnect' }, { seq: false, jitterMs: 1000 });
	});

	it('returns a refused publish and omits optional diagnostics', () => {
		const platform = { publish: vi.fn(() => false) };
		expect(sourceGap(platform, 'items', { source: 'postgres-notify' })).toBe(false);
		expect(platform.publish).toHaveBeenCalledWith('items', '__realtime.gap', { source: 'postgres-notify' }, { seq: false });
	});

	it('rejects invalid targets and diagnostic fields before publishing', () => {
		const platform = { publish: vi.fn() };
		for (const args of [
			[null, 'items', { source: 'bridge' }],
			[platform, '', { source: 'bridge' }],
			[platform, '__realtime', { source: 'bridge' }],
			[platform, 'items', {}],
			[platform, 'items', { source: ' ' }],
			[platform, 'items', { source: 'bridge', reason: 1 }],
			...[null, -1, 60001, Infinity, -Infinity, NaN, '1000'].map((jitterMs) => [platform, 'items', { source: 'bridge', jitterMs }])
		]) {
			expect(() => sourceGap(...args)).toThrow(TypeError);
		}
		expect(platform.publish).not.toHaveBeenCalled();
		for (const jitterMs of [0, 60000]) {
			sourceGap(platform, 'items', { source: 'bridge', jitterMs });
		}
		expect(platform.publish).toHaveBeenCalledTimes(2);
	});
});
