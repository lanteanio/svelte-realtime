import { afterEach, expect, it, vi } from 'vitest';
import { live, _resetIdempotencyStore } from '../src/server.js';

afterEach(() => _resetIdempotencyStore());
for (const ttl of [1.5, NaN, Infinity, -Infinity, -1, '1']) {
	it(`rejects invalid idempotency TTL ${String(ttl)} during registration`, () => {
		const acquire = vi.fn();
		for (const store of [undefined, { acquire }]) {
			expect(() => live.idempotent({ ttl, ...(store ? { store } : {}) }, async () => 'value')).toThrow(/ttl.*non-negative integer/);
		}
		expect(acquire).not.toHaveBeenCalled();
	});
}
it('keeps zero TTL as a cache-write bypass', async () => {
	const work = vi.fn(async () => 'value');
	const fn = live.idempotent({ ttl: 0, keyFrom: () => 'same' }, work);
	await expect(fn({ user: { id: 'member' } })).resolves.toBe('value');
	await expect(fn({ user: { id: 'member' } })).resolves.toBe('value');
	expect(work).toHaveBeenCalledTimes(2);
});
it('accepts an integer TTL and caches successful work', async () => {
	const work = vi.fn(async () => 'value');
	const fn = live.idempotent({ ttl: 1, keyFrom: () => 'same' }, work);
	await expect(fn({ user: { id: 'member' } })).resolves.toBe('value');
	await expect(fn({ user: { id: 'member' } })).resolves.toBe('value');
	expect(work).toHaveBeenCalledOnce();
});
