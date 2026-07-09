// DST golden-set regression gate (buildSimGoldens / checkSimGoldens). The unit
// block drives the pure comparator with synthetic swarm results (no full sim);
// the integration block runs BOTH real deterministic swarms over their committed
// corpora and asserts every fingerprint still matches HEAD (the actual gate),
// plus a portability re-run.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSimGoldens, checkSimGoldens, runLiveSimSwarm, runSmoothSimSwarm } from '../src/sim.js';

const digest = (over = {}) => ({ violations: 0, fatals: 0, uncaught: 0, violationCategories: [], buggified: false, ...over });

function mkRun(seed, fingerprint, over = {}) {
	return { seed: String(seed), ok: true, buggified: false, fingerprint, violations: 0, fatals: 0, uncaught: 0, violationCategories: [], reproduced: null, ...over };
}
function mkSwarm(runs, summaryOver = {}) {
	return { summary: { buggify: 'off', gitCommit: null, ...summaryOver }, runs };
}
function mkGolden(entries, over = {}) {
	return { schemaVersion: 1, gitCommit: null, recordedAt: null, swarm: { buggify: 'off' }, entries, ...over };
}

describe('checkSimGoldens', () => {
	const baseEntries = [
		{ seed: '1', weight: 1, fingerprint: 'aaaaaaaa', digest: digest() },
		{ seed: '2', weight: 1, fingerprint: 'bbbbbbbb', digest: digest() },
		{ seed: '10', weight: 1, fingerprint: 'cccccccc', digest: digest() }
	];

	it('passes with driftWeight 0 when every fingerprint matches', () => {
		const report = checkSimGoldens(mkGolden(baseEntries), mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'bbbbbbbb'), mkRun('10', 'cccccccc')]));
		expect(report.ok).toBe(true);
		expect(report.driftWeight).toBe(0);
		expect(report.counts).toEqual({ changed: 0, missing: 0, added: 0, matched: 3 });
	});

	it('fails when a weight-1 seed drifts, carrying both fingerprints for triage', () => {
		const report = checkSimGoldens(mkGolden(baseEntries), mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'DIFFERENT'), mkRun('10', 'cccccccc')]));
		expect(report.ok).toBe(false);
		expect(report.driftWeight).toBe(1);
		expect(report.drifts[0]).toMatchObject({ seed: '2', kind: 'changed' });
		expect(report.drifts[0].golden.fingerprint).toBe('bbbbbbbb');
		expect(report.drifts[0].actual.fingerprint).toBe('DIFFERENT');
	});

	it('a weight-0 (watch-list) seed drifting is reported but never gates', () => {
		const golden = mkGolden([
			{ seed: '1', weight: 1, fingerprint: 'aaaaaaaa', digest: digest() },
			{ seed: '2', weight: 0, fingerprint: 'bbbbbbbb', digest: digest() }
		]);
		const report = checkSimGoldens(golden, mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'DRIFTED')]));
		expect(report.ok).toBe(true);
		expect(report.driftWeight).toBe(0);
		expect(report.drifts).toHaveLength(1);
	});

	it('tolerates drift up to maxDriftWeight and fails above it', () => {
		const golden = mkGolden([
			{ seed: '1', weight: 2, fingerprint: 'aaaaaaaa', digest: digest() },
			{ seed: '2', weight: 3, fingerprint: 'bbbbbbbb', digest: digest() }
		]);
		const swarm = mkSwarm([mkRun('1', 'X'), mkRun('2', 'bbbbbbbb')]);
		expect(checkSimGoldens(golden, swarm, { maxDriftWeight: 2 }).ok).toBe(true);
		expect(checkSimGoldens(golden, swarm, { maxDriftWeight: 1 }).ok).toBe(false);
	});

	it('classifies a seed absent from the run as missing (gates), an extra run seed as added (never gates)', () => {
		const report = checkSimGoldens(mkGolden(baseEntries), mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('10', 'cccccccc'), mkRun('99', 'zzzz')]));
		expect(report.ok).toBe(false);
		expect(report.counts.missing).toBe(1);
		expect(report.counts.added).toBe(1);
		expect(report.drifts.find((d) => d.seed === '2')).toMatchObject({ kind: 'missing', actual: null });
	});

	it('fails on a swarm-config mismatch (incomparable fingerprints)', () => {
		const report = checkSimGoldens(
			mkGolden(baseEntries, { swarm: { buggify: 'off' } }),
			mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'bbbbbbbb'), mkRun('10', 'cccccccc')], { buggify: 'random' })
		);
		expect(report.ok).toBe(false);
		expect(report.configMismatch).toMatch(/buggify mode differs/);
	});
});

describe('buildSimGoldens', () => {
	it('projects a swarm into a numeric-sorted corpus that round-trips through checkSimGoldens', () => {
		const swarm = mkSwarm([mkRun('10', 'ffff', { buggified: true }), mkRun('2', 'eeee'), mkRun('1', 'dddd')], { gitCommit: 'abc123' });
		const corpus = buildSimGoldens(swarm, { swarm: { buggify: 'off' }, recordedAt: '2026-01-01T00:00:00.000Z' });
		expect(corpus.schemaVersion).toBe(1);
		expect(corpus.gitCommit).toBe('abc123');
		expect(corpus.entries.map((e) => e.seed)).toEqual(['1', '2', '10']);
		expect(checkSimGoldens(corpus, swarm).ok).toBe(true);
	});

	it('honors per-seed weight overrides', () => {
		const corpus = buildSimGoldens(mkSwarm([mkRun('1', 'aaaa'), mkRun('2', 'bbbb')]), { weights: { 2: 0 } });
		expect(corpus.entries.find((e) => e.seed === '2').weight).toBe(0);
		expect(corpus.entries.find((e) => e.seed === '1').weight).toBe(1);
	});
});

// The real gate: run each committed corpus's config through its deterministic
// swarm and assert every fingerprint still matches HEAD. If this fails, either
// a real regression landed or an intentional behavior change needs re-blessing
// (`npm run sim:golden -- --update`).
describe('DST golden corpora match HEAD', () => {
	const CORPORA = [
		{ url: new URL('./dst-goldens/live-dispatch.golden.json', import.meta.url), run: runLiveSimSwarm, hasFaultProfile: true },
		{ url: new URL('./dst-goldens/smooth-lagcomp.golden.json', import.meta.url), run: runSmoothSimSwarm, hasFaultProfile: false }
	];

	for (const { url, run, hasFaultProfile } of CORPORA) {
		const corpus = JSON.parse(readFileSync(url, 'utf8'));
		const name = url.pathname.split('/').pop();

		it(`${name}: every committed fingerprint reproduces at HEAD`, async () => {
			const swarm = corpus.swarm || {};
			const result = await run({
				seeds: corpus.entries.map((e) => e.seed),
				buggify: swarm.buggify,
				buggifyProbability: swarm.buggifyProbability,
				...(hasFaultProfile && swarm.faultProfile !== undefined && { faultProfile: swarm.faultProfile }),
				base: swarm.base
			});
			const report = checkSimGoldens(corpus, result);
			if (!report.ok) {
				const detail = report.configMismatch || report.drifts.slice(0, 5).map((d) => `${d.seed}:${d.kind}`).join(', ');
				throw new Error(`${name} drifted (driftWeight ${report.driftWeight}): ${detail}. Re-bless with \`npm run sim:golden -- --update\` if intentional.`);
			}
			expect(report.counts.matched).toBe(corpus.entries.length);
		}, 60000);
	}

	it('smooth-lagcomp: two swarms produce byte-identical fingerprints (portability)', async () => {
		const corpus = JSON.parse(readFileSync(CORPORA[1].url, 'utf8'));
		const swarm = corpus.swarm || {};
		const cfg = {
			seeds: corpus.entries.slice(0, 12).map((e) => e.seed),
			buggify: swarm.buggify,
			buggifyProbability: swarm.buggifyProbability,
			base: swarm.base
		};
		const a = await runSmoothSimSwarm(cfg);
		const b = await runSmoothSimSwarm(cfg);
		expect(a.runs.map((r) => r.fingerprint)).toEqual(b.runs.map((r) => r.fingerprint));
	}, 60000);
});
