import { describe, it, expect } from 'vitest';
import { runLiveSim, replayLiveSim, runLiveSimSwarm } from '../src/sim.js';

describe('runLiveSim', () => {
	it('runs the default scenario clean: RPC echo + stream fan-out converge', async () => {
		const r = await runLiveSim({ seed: 'clean-1', clients: 3, events: 4 });
		expect(r.invariantViolations).toEqual([]);
		expect(r.metrics.clients).toBe(3);
		expect(r.metrics.rpcChecks).toBe(3);
		expect(r.finalState.topics).toEqual(['feed']);
		// Every subscriber received the same 4 events.
		expect(r.clientFrames.map((f) => f.length)).toEqual([4, 4, 4]);
		expect(JSON.stringify(r.clientFrames[1])).toBe(JSON.stringify(r.clientFrames[0]));
		expect(JSON.stringify(r.clientFrames[2])).toBe(JSON.stringify(r.clientFrames[0]));
	});

	it('flags an RPC mismatch as an invariant violation', async () => {
		const scenario = async (api, opts) => {
			const c = api.connect({ userId: 'u0' });
			const v = await c.call('sim/echo', { n: 1 });
			api.expect(v, { n: 999 }, 'wrong-on-purpose'); // deliberately wrong expectation
			void opts;
		};
		const r = await runLiveSim({ seed: 'mismatch', scenario });
		expect(r.invariantViolations.some((v) => v.category === 'live.rpc-mismatch')).toBe(true);
	});

	it('is deterministic: two runs of a seed produce identical state and frames', async () => {
		const a = await runLiveSim({ seed: 'det-1', clients: 4, events: 6 });
		const b = await runLiveSim({ seed: 'det-1', clients: 4, events: 6 });
		expect(b.finalState).toEqual(a.finalState);
		expect(b.clientFrames).toEqual(a.clientFrames);
		expect(b.metrics).toEqual(a.metrics);
	});

	it('replayLiveSim reproduces a clean run', async () => {
		const original = await runLiveSim({ seed: 'replay-1' });
		expect((await replayLiveSim(original)).reproduced).toBe(true);
	});

	it('drops every publish under chaos dropRate 1 yet all subscribers stay converged', async () => {
		const r = await runLiveSim({ seed: 'chaos-1', clients: 3, events: 5, chaos: { dropRate: 1 } });
		// Every publish was dropped (all-or-nothing), so every subscriber missed the
		// same events and the streams are still identical - convergence holds.
		expect(r.metrics.chaosDropped).toBe(5);
		expect(r.clientFrames.map((f) => f.length)).toEqual([0, 0, 0]);
		expect(r.invariantViolations).toEqual([]);
		expect((await replayLiveSim(r)).reproduced).toBe(true);
	});

	it('reproduces a partially-chaotic run bit-for-bit', async () => {
		const r = await runLiveSim({ seed: 'chaos-2', clients: 3, events: 12, chaos: { dropRate: 0.5 } });
		expect(r.invariantViolations).toEqual([]); // convergence holds under partial drop
		expect((await replayLiveSim(r)).reproduced).toBe(true);
	});
});

describe('runLiveSimSwarm', () => {
	it('runs a clean swarm and reports all passed', async () => {
		const { summary, runs } = await runLiveSimSwarm({ count: 6, startSeed: 1 });
		expect(summary.total).toBe(6);
		expect(summary.passed).toBe(6);
		expect(summary.failed).toBe(0);
		expect(summary.firstFailingSeed).toBeNull();
		expect(summary.ok).toBe(true);
		expect(runs.map((r) => r.seed)).toEqual(['1', '2', '3', '4', '5', '6']);
		for (const r of runs) expect(r.fingerprint).toMatch(/^[0-9a-f]{8}$/);
	});

	it('is deterministic across two swarms', async () => {
		const a = await runLiveSimSwarm({ count: 4, startSeed: 10 });
		const b = await runLiveSimSwarm({ count: 4, startSeed: 10 });
		expect(b.runs).toEqual(a.runs);
		expect(b.summary).toEqual(a.summary);
	});

	it('buggify:on enables a chaos drop yet convergence still holds; fingerprints change', async () => {
		const on = await runLiveSimSwarm({ count: 4, startSeed: 1, buggify: 'on', faultProfile: { dropRate: 0.5 } });
		const off = await runLiveSimSwarm({ count: 4, startSeed: 1 });
		expect(on.runs.every((r) => r.buggified)).toBe(true);
		expect(on.summary.ok).toBe(true);
		expect(on.runs.some((r, i) => r.fingerprint !== off.runs[i].fingerprint)).toBe(true);
	});

	it('buggify:random faults a reproducible, non-trivial subset', async () => {
		const a = await runLiveSimSwarm({ count: 16, startSeed: 1, buggify: 'random', faultProfile: { dropRate: 0.5 }, buggifyProbability: 0.5 });
		const b = await runLiveSimSwarm({ count: 16, startSeed: 1, buggify: 'random', faultProfile: { dropRate: 0.5 }, buggifyProbability: 0.5 });
		expect(a.summary.buggified).toBeGreaterThan(0);
		expect(a.summary.buggified).toBeLessThan(16);
		expect(b.runs.map((r) => r.buggified)).toEqual(a.runs.map((r) => r.buggified));
		expect(a.summary.ok).toBe(true);
	});

	it('re-checks determinism at checkRatio 1 and all reproduce', async () => {
		const { summary, runs } = await runLiveSimSwarm({ count: 4, startSeed: 1, checkRatio: 1 });
		expect(summary.determinismChecks).toBe(4);
		expect(summary.determinismFailures).toBe(0);
		expect(runs.every((r) => r.reproduced === true)).toBe(true);
	});
});
