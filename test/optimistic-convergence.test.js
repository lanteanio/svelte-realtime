import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOptimisticConvergence, createReplicaNetwork } from './helpers/optimistic-convergence.js';

const requestedSeed = process.env.REALTIME_CLIENT_SEED;
const coverage = { modes: new Set(), events: new Set(), phases: new Set(), functional: new Set(), accepted: new Set(), sizes: new Set() };
const seeds = requestedSeed ? [requestedSeed] : Array.from({ length: 24 }, (_, index) => 'svti-client-sim-' + index);
afterEach(() => { vi.useRealTimers(); });

describe('optimistic replica convergence', () => {
	it.each(seeds)('converges to server authority for seed %s', async seed => {
		const result = await runOptimisticConvergence(seed);
		coverage.sizes.add(result.actual.length);
		for (const operation of result.plan.flat()) {
			coverage.events.add(operation.event); coverage.functional.add(operation.functional); coverage.accepted.add(operation.accepted);
		}
		for (const event of result.trace) { if (event.mode) coverage.modes.add(event.mode); if (event.phase) coverage.phases.add(event.phase); }
	}, 30000);
	it.skipIf(!!requestedSeed)('covers every recovery, mutation and settlement category in its corpus', () => {
		expect([...coverage.modes].sort()).toEqual(['delta', 'full', 'replay', 'unchanged']);
		expect([...coverage.events].sort()).toEqual(['created', 'deleted', 'updated']);
		expect([...coverage.phases].sort()).toEqual(['after-snapshot', 'before-reconnect', 'before-snapshot']);
		expect(coverage.functional.size).toBe(2); expect(coverage.accepted.size).toBe(2);
		expect([...coverage.sizes].sort()).toEqual([2, 3, 4]);
	});
	it('replays a seed with identical operations, interleavings and values', async () => {
		const first = await runOptimisticConvergence('svti-client-replay-0');
		expect(await runOptimisticConvergence('svti-client-replay-0')).toEqual(first);
	}, 30000);
	it('rejects a stale replica when reconnect recovery is omitted', async () => {
		await expect(runOptimisticConvergence('svti-client-missing-recovery', { omitRecovery: true })).rejects.toThrow(/differs from server authority/);
	}, 30000);
});


describe('delta with an optimistic created row', () => {
	it.each([true, false])('keeps the authoritative row after mutation settles (accepted: %s)', async accepted => {
		const net = await createReplicaNetwork('delta-baseline');
		let settle;
		try {
			const client = await net.replica(0);
			client.answer(client.request().id, { data: [], seq: 0 });
			const result = new Promise((resolve, reject) => { settle = () => accepted ? resolve() : reject(new Error('rejected')); });
			const done = client.store.mutate(() => result, { event: 'created', data: { id: 'row', value: 1 } }).catch(() => {});
			await net.reconnect();
			client.answer(client.request().id, { delta: true, data: [{ id: 'row', value: 9 }], seq: 1 });
			settle(); await done;
			expect(client.value()).toEqual([{ id: 'row', value: 9 }]);
		} finally { settle?.(); await net.close(); }
	});
});
