import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { live, _resetForget, _resetIdempotencyStore } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

describe('idempotency erasure across long-running requests', () => {
	let env, clock, entered, release, calls, alice, bob;
	beforeEach(() => {
		_resetIdempotencyStore();
		_resetForget();
		clock = 1000;
		setRuntimeEnv({ clock: { now: () => clock, monotonic: () => clock, wallEpoch: () => clock } });
		env = createTestEnv();
		entered = deferred();
		release = deferred();
		calls = new Map();
		env.register('work', {
			run: live.idempotent({ keyFrom: (ctx, key) => ctx.user.id + ':' + key }, async (ctx, key) => {
				const id = ctx.user.id + ':' + key;
				const count = (calls.get(id) || 0) + 1;
				calls.set(id, count);
				if (id === 'alice:slow' && count === 1) { entered.resolve(); await release.promise; }
				return { count };
			})
		});
		alice = env.connect({ id: 'alice' });
		bob = env.connect({ id: 'bob' });
	});
	afterEach(() => {
		release.resolve();
		env.cleanup();
		_resetIdempotencyStore();
		_resetForget();
		resetRuntimeEnv();
	});

	for (const duplicate of [false, true]) {
		it(`does not cache erased work after the tombstone sweep${duplicate ? ' including a waiting duplicate' : ''}`, async () => {
			const first = alice.call('work/run', 'slow');
			await entered.promise;
			const waiting = duplicate ? alice.call('work/run', 'slow') : null;
			await nextTurn();
			clock = 2000;
			await live.forget('alice');
			clock = 100000;
			await bob.call('work/run', 'trigger-sweep');
			release.resolve();
			await first;
			await waiting;
			const after = await alice.call('work/run', 'slow');
			expect(after).toEqual({ count: duplicate ? 3 : 2 });
			expect(await alice.call('work/run', 'slow')).toEqual(after);
			expect(calls.get('alice:slow')).toBe(duplicate ? 3 : 2);
		});
	}

	it('retains an active user fence when their last older cached result expires', async () => {
		await alice.call('work/run', 'expired');
		const first = alice.call('work/run', 'slow');
		await entered.promise;
		clock = 200000000;
		await bob.call('work/run', 'expire-old-result');
		await live.forget('alice');
		clock += 100000;
		await bob.call('work/run', 'sweep-tombstone');
		release.resolve();
		await first;
		expect(await alice.call('work/run', 'slow')).toEqual({ count: 2 });
	});

	it('allows fresh work after the grace window while preserving the older request fence', async () => {
		const first = alice.call('work/run', 'slow');
		await entered.promise;
		clock = 2000;
		await live.forget('alice');
		clock = 100000;
		const fresh = await alice.call('work/run', 'fresh');
		expect(await alice.call('work/run', 'fresh')).toEqual(fresh);
		expect(calls.get('alice:fresh')).toBe(1);
		release.resolve();
		await first;
		expect(await alice.call('work/run', 'slow')).toEqual({ count: 2 });
		expect(await alice.call('work/run', 'fresh')).toEqual(fresh);
	});
});
