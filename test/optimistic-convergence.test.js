import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { createReplicaNetwork, openFuzzWire, runSchedule, scheduleArbitrary } from './helpers/optimistic-convergence.js';

// REALTIME_CLIENT_SEED (and REALTIME_CLIENT_PATH, both printed by a failure)
// replay one failing run and its shrink path.
const seed = process.env.REALTIME_CLIENT_SEED ? Number(process.env.REALTIME_CLIENT_SEED) : 20261022;
const path = process.env.REALTIME_CLIENT_PATH || undefined;
const numRuns = Number(process.env.REALTIME_CLIENT_RUNS || 200);
afterEach(() => { vi.useRealTimers(); });

describe('optimistic replica convergence', () => {
	it.each(['crud', 'set', 'presence'])('every replica converges to the server value under %s merge', async merge => {
		const net = await openFuzzWire();
		const seen = { recoveries: new Set(), lost: 0, refused: 0, committed: 0 };
		try {
			await fc.assert(fc.asyncProperty(scheduleArbitrary(merge), async schedule => {
				const result = await runSchedule(net, merge, schedule);
				for (const event of result.trace) if (event.answer !== undefined) seen.recoveries.add(event.mode);
				for (const outcome of result.mutations) {
					if (outcome === 'ok') seen.committed++;
					else if (outcome === 'DISCONNECTED') seen.lost++;
					else if (outcome === 'REFUSED') seen.refused++;
				}
			}), { seed, path, numRuns, endOnFailure: !!path });
		} finally { await net.close(); }
		// The generator reaches every recovery form and every settlement.
		if (!path) {
			expect([...seen.recoveries].sort()).toEqual(merge === 'crud' ? ['delta', 'full', 'replay'] : ['full', 'replay']);
			expect(seen.committed).toBeGreaterThan(0);
			expect(seen.lost).toBeGreaterThan(0);
			expect(seen.refused).toBeGreaterThan(0);
		}
	}, 120000);

	// Shrunk counterexamples: a success applied its change again over server
	// state written after it.
	it.each([
		['crud', 'a function change after a later write to its row', { replicas: 2, initial: [], steps: [
			{ t: 'mutate', r: 0, op: { kind: 'fn', key: 0 }, accept: true },
			{ t: 'mutate', r: 0, op: { kind: 'create', key: 0 }, accept: true },
			{ t: 'server', op: { kind: 'upsert', key: 0 } }
		] }],
		['set', 'a set after another replica set the value', { replicas: 2, initial: [], steps: [
			{ t: 'mutate', r: 0, op: { kind: 'set', key: 0 }, accept: true },
			{ t: 'mutate', r: 1, op: { kind: 'set', key: 0 }, accept: true },
			{ t: 'server', op: { kind: 'set', key: 0 } }
		] }]
	])('%s: %s converges', async (merge, _name, schedule) => {
		const net = await openFuzzWire();
		try {
			const result = await runSchedule(net, merge, schedule);
			expect(result.actual.every(value => JSON.stringify(value) === JSON.stringify(result.expected))).toBe(true);
		} finally { await net.close(); }
	});

	// A write the replicas miss while reconnecting reaches them only through
	// the resubscribe answer: without it the oracle must report the replica.
	const missedWrite = { replicas: 2, initial: [0], steps: [
		{ t: 'bounce' },
		{ t: 'server', op: { kind: 'upsert', key: 1 } },
		{ t: 'server', op: { kind: 'delete', key: 0 } }
	] };
	it('rejects a stale replica when reconnect recovery is omitted', async () => {
		const net = await openFuzzWire();
		try {
			await expect(runSchedule(net, 'crud', missedWrite, { omitRecovery: true })).rejects.toThrow(/differs from the server/);
			// The same schedule with recovery answered converges.
			const result = await runSchedule(net, 'crud', missedWrite);
			expect(result.actual).toEqual([result.expected, result.expected]);
		} finally { await net.close(); }
	});

	it('replays a seed with identical schedules, settlements and values', async () => {
		const options = { seed, numRuns: 8 };
		const schedules = fc.sample(scheduleArbitrary('crud'), options);
		expect(fc.sample(scheduleArbitrary('crud'), options)).toEqual(schedules);
		// Request ids differ between runs on one wire; everything else repeats.
		const strip = result => ({ ...result, trace: result.trace.map(({ answer, ...rest }) => rest) });
		const net = await openFuzzWire();
		try {
			for (const schedule of schedules) {
				const first = strip(await runSchedule(net, 'crud', schedule));
				expect(strip(await runSchedule(net, 'crud', schedule))).toEqual(first);
			}
		} finally { await net.close(); }
	}, 60000);
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
