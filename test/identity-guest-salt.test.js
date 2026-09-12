// Anonymous connections get a guest identity minted from a per-process counter.
// Two replicas of one cluster both start that counter at 1, so without a
// per-process salt the first anonymous socket on each replica shares one
// presence key: the shared roster holds a single entry, each side filters it
// out as itself, and neither viewer ever sees the other. The salt is drawn from
// the runtime seam so a simulation with a pinned generator stays reproducible.

import { describe, it, expect, afterEach, vi } from 'vitest';

async function freshProcess(u32) {
	vi.resetModules();
	const runtime = await import('../src/shared/runtime.js');
	runtime.setRuntimeEnv({ rng: { u32: () => u32 } });
	const identity = await import('../src/server/identity.js');
	return { identity, runtime };
}

describe('guest identity salt', () => {
	afterEach(async () => {
		const runtime = await import('../src/shared/runtime.js');
		runtime.resetRuntimeEnv();
		vi.resetModules();
	});

	it('two processes mint different keys for their first anonymous socket', async () => {
		const a = await freshProcess(0x1234abcd);
		const keyA = a.identity._getIdentityKey({ ws: {} });
		const b = await freshProcess(0x7777ffff);
		const keyB = b.identity._getIdentityKey({ ws: {} });
		expect(keyA).toMatch(/^__guest_[0-9a-z]+_1$/);
		expect(keyB).toMatch(/^__guest_[0-9a-z]+_1$/);
		expect(keyA).not.toBe(keyB);
	});

	it('the same seed reproduces the same keys (simulation determinism)', async () => {
		const a = await freshProcess(42);
		const first = a.identity._getIdentityKey({ ws: {} });
		const second = a.identity._getIdentityKey({ ws: {} });
		const b = await freshProcess(42);
		expect(b.identity._getIdentityKey({ ws: {} })).toBe(first);
		expect(b.identity._getIdentityKey({ ws: {} })).toBe(second);
		expect(first).not.toBe(second);
	});

	it('a socket keeps its key for its lifetime and an authenticated id wins over the guest key', async () => {
		const { identity } = await freshProcess(7);
		const ws = {};
		const key = identity._getIdentityKey({ ws });
		expect(identity._getIdentityKey({ ws })).toBe(key);
		expect(identity._getIdentityKey({ ws, user: { id: 'alice' } })).toBe('alice');
	});
});
