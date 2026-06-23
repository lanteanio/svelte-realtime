import { describe, it, expect } from 'vitest';
import { createSharedRandom as fromServer } from '../src/server.js';
import { createSharedRandom as fromAdapter } from 'svelte-adapter-uws/plugins/smooth/random';

// createSharedRandom is the adapter's per-command generator (the one `live.smooth`'s
// apply receives as `ctx.rng`). svelte-realtime re-exports it so app code can draw the
// same reproducible randomness outside apply. It must be the SAME function - a forked
// copy could drift from the authority/predictor and break prediction parity.
describe('createSharedRandom re-export (single source)', () => {
	it('the server surface re-exports the adapter generator (same reference)', () => {
		expect(fromServer).toBe(fromAdapter);
	});

	it('is a working reseedable PRNG', () => {
		const a = fromServer(42);
		const b = fromServer(42);
		expect([a.u32(), a.u32(), a.u32()]).toEqual([b.u32(), b.u32(), b.u32()]);
		a.reseed(7);
		const c = fromServer(7);
		expect(a.float()).toBe(c.float());
	});
});
