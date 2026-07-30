// The lag-compensation ("deterministic netcode") sim: a seeded latency-varying shot
// stream resolved against a moving board must reproduce every hit bit-for-bit under
// one seed. These tests prove (a) the runner resolves real hits and upholds the per-
// shot domain invariants, (b) the determinism gate reproduces a clean run, (c) the
// gate is NOT vacuously green - a planted non-determinism is caught, and (d) the swarm
// stays green and deterministic across many seeds, including the faultMode paths.

import { describe, it, expect } from 'vitest';
import { runSmoothSim, replaySmoothSim, runSmoothSimSwarm, DEFAULT_SMOOTH_SEED } from '../src/sim.js';

describe('runSmoothSim', () => {
	it('resolves hits over a moving board and upholds the per-shot invariants', async () => {
		const r = await runSmoothSim({ seed: 'hit-1' });
		expect(r.metrics.hits).toBeGreaterThan(0);
		expect(r.invariantViolations).toEqual([]);
		for (const h of r.hitLog) {
			expect(h.fraction).toBeGreaterThanOrEqual(0);
			expect(h.fraction).toBeLessThanOrEqual(1);
			expect(Number.isFinite(h.dist)).toBe(true);
			expect(Number.isFinite(h.px)).toBe(true);
			expect(Number.isFinite(h.py)).toBe(true);
		}
		// Every shot's rewind instant stays within the favor-shooter window.
		for (const s of r.shotResults) {
			if (s.dropped) continue;
			expect(s.reach).toBeLessThanOrEqual(r.config.maxRewindMs + 1e-9);
			expect(s.rewindAt).toBeLessThanOrEqual(s.nowMono + 1e-9);
			expect(s.rewindAt).toBeGreaterThanOrEqual(s.nowMono - r.config.maxRewindMs - 1e-9);
		}
	});

	it('reproduces a run bit-for-bit under the same seed', async () => {
		const first = await runSmoothSim({ seed: 'det-1' });
		const replay = await replaySmoothSim(first);
		expect(replay.reproduced).toBe(true);
		expect(replay.hitLog).toEqual(first.hitLog);
		expect(replay.shotResults).toEqual(first.shotResults);
		expect(replay.finalState).toEqual(first.finalState);
	});

	it('two independent runs of one seed agree (no leaked global state)', async () => {
		const a = await runSmoothSim({ seed: 'det-2' });
		const b = await runSmoothSim({ seed: 'det-2' });
		expect(b.hitLog).toEqual(a.hitLog);
		expect(b.metrics).toEqual(a.metrics);
	});

	it('CATCHES a planted non-determinism (the gate is not vacuously green)', async () => {
		// A tap whose return value advances on every call folds a different value into
		// each pass's hit log, so a re-run of the SAME seed must diverge. If the gate
		// only ever returned "reproduced", this would pass silently - it must not.
		let calls = 0;
		const tap = () => ++calls;
		const first = await runSmoothSim({ seed: 'taint-1', shots: 12, entities: 6, onHitTap: tap });
		expect(first.metrics.hits).toBeGreaterThan(0); // the taint only bites when a hit lands
		const replay = await replaySmoothSim(first);
		expect(replay.reproduced).toBe(false);
	});

	it('stays deterministic and invariant-clean under faultMode (teleport + over-window lag)', async () => {
		const r = await runSmoothSim({ seed: 'bug-1', faultMode: true });
		expect(r.invariantViolations).toEqual([]);
		// Non-vacuous on the faultMode path too: shots still land hits (the rewound
		// narrowphase is exercised), so the determinism compare is never empty == empty.
		expect(r.metrics.hits).toBeGreaterThan(0);
		const replay = await replaySmoothSim(r);
		expect(replay.reproduced).toBe(true);
	});

	it('the zero-config run is itself reproducible', async () => {
		const a = await runSmoothSim();
		const b = await runSmoothSim();
		expect(a.seed).toBe(DEFAULT_SMOOTH_SEED);
		expect(b.hitLog).toEqual(a.hitLog);
	});
});

describe('runSmoothSimSwarm', () => {
	it('a clean swarm is all green with the shared swarm summary shape', async () => {
		const s = await runSmoothSimSwarm({ count: 40, checkRatio: 0.25 });
		expect(s.summary.total).toBe(40);
		expect(s.summary.failed).toBe(0);
		expect(s.summary.determinismFailures).toBe(0);
		expect(s.summary.ok).toBe(true);
		expect(s.summary.determinismChecks).toBeGreaterThan(0);
		expect(s.runs).toHaveLength(40);
		expect(s.runs.every((r) => r.ok)).toBe(true);
		// Non-vacuous and broadly so: most seeds land hits, so a broad gate collapse that
		// left a single outlier green would still be caught (not merely sum > 0).
		expect(s.runs.filter((r) => r.hits > 0).length).toBeGreaterThan(s.runs.length / 2);
	});

	it('faultMode=random keeps every seed deterministic and clean', async () => {
		const s = await runSmoothSimSwarm({ count: 40, faultMode: 'random', checkRatio: 0.5 });
		expect(s.summary.ok).toBe(true);
		expect(s.summary.faulted).toBeGreaterThan(0);
		expect(s.summary.determinismFailures).toBe(0);
		// The faulted runs collectively land hits - their determinism check is not
		// silently passing on empty hit logs.
		expect(s.runs.filter((r) => r.faulted).reduce((n, r) => n + r.hits, 0)).toBeGreaterThan(0);
	});

	it('the same seeds fingerprint identically across two swarm runs', async () => {
		const a = await runSmoothSimSwarm({ seeds: [1, 2, 3, 4, 5] });
		const b = await runSmoothSimSwarm({ seeds: [1, 2, 3, 4, 5] });
		expect(b.runs.map((r) => r.fingerprint)).toEqual(a.runs.map((r) => r.fingerprint));
	});

	it('an explicit seeds list maps one run per seed', async () => {
		const s = await runSmoothSimSwarm({ seeds: ['x', 'y', 'z'] });
		expect(s.runs.map((r) => r.seed)).toEqual(['x', 'y', 'z']);
		expect(s.summary.total).toBe(3);
	});
});
