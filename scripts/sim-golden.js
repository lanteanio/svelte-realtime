// DST golden-set regression gate for the realtime sims. The seed swarms prove
// each interleaving is internally deterministic (a seed reproduces its own
// fingerprint); this gate pins those fingerprints to a COMMITTED baseline so a
// code change that deterministically alters sim behavior - which the swarm's
// self-reproduce check passes unnoticed, since a deterministic change still
// reproduces itself - fails loudly against the corpus. Intentional changes are
// blessed by regenerating the corpus (`--update`); the committed diff is the
// reviewable record of exactly what moved.
//
// Lives under scripts/, outside the determinism seam, so it may read the clock
// and environment. The pure comparison lives in src/sim.js (buildSimGoldens /
// checkSimGoldens). Mirrors the adapter's scripts/sim-golden.js contract.
//
// Usage:
//   node scripts/sim-golden.js            verify HEAD against the committed corpora (gate; exit 1 on drift)
//   node scripts/sim-golden.js --update   regenerate + bless the corpora (refuses to write a broken/nondeterministic swarm)
//
// One corpus per sim: the live-dispatch swarm (RPC + stream fan-out under a
// seeded chaos drop) and the smooth lag-compensation swarm (the shot-resolution
// path, buggify widening lag + arming a teleport). Each corpus records the swarm
// knobs its fingerprints are only comparable under; verify re-runs exactly the
// corpus seeds under exactly the corpus config.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { runLiveSimSwarm, runSmoothSimSwarm, buildSimGoldens, checkSimGoldens } from '../src/sim.js';

const CONFIGS = [
	{
		name: 'live-dispatch',
		file: 'test/dst-goldens/live-dispatch.golden.json',
		run: runLiveSimSwarm,
		swarm: { count: 40, startSeed: 1, buggify: 'random', buggifyProbability: 0.25, faultProfile: { dropRate: 0.2 }, base: {} }
	},
	{
		name: 'smooth-lagcomp',
		file: 'test/dst-goldens/smooth-lagcomp.golden.json',
		run: runSmoothSimSwarm,
		swarm: { count: 40, startSeed: 1, buggify: 'random', buggifyProbability: 0.25, base: {} }
	}
];

const update = process.argv.includes('--update');
const gitCommit = process.env.GIT_COMMIT || null;

// Build a corpus in memory WITHOUT writing. Returns the built corpus on a clean
// swarm, or null (with a reason logged) when the swarm is not clean - so
// --update can be all-or-nothing: no corpus is written unless EVERY config's
// swarm is clean, and a half-broken tree never blesses one config while
// refusing another.
async function buildCorpus(cfg) {
	// checkRatio 1 re-runs EVERY seed through the replay self-gate: a seed that
	// does not reproduce is a determinism regression and must not enter the corpus.
	const { summary, runs } = await cfg.run({ ...cfg.swarm, checkRatio: 1, gitCommit });
	if (!summary.ok) {
		console.error(
			`sim-golden --update ${cfg.name}: swarm is not clean ` +
			`(${summary.failed} failing seed(s), ${summary.determinismFailures} determinism regression(s)).`
		);
		return null;
	}
	return buildSimGoldens({ summary, runs }, {
		gitCommit,
		recordedAt: new Date().toISOString(),
		swarm: {
			buggify: cfg.swarm.buggify,
			buggifyProbability: cfg.swarm.buggifyProbability,
			...(cfg.swarm.faultProfile !== undefined && { faultProfile: cfg.swarm.faultProfile }),
			base: cfg.swarm.base
		}
	});
}

async function verify(cfg) {
	let corpus;
	try {
		corpus = JSON.parse(readFileSync(cfg.file, 'utf8'));
	} catch (err) {
		console.error(`sim-golden ${cfg.name}: cannot read corpus ${cfg.file} (${err.message}). Run \`npm run sim:golden -- --update\` to generate it.`);
		return false;
	}
	const swarm = corpus.swarm || {};
	// Run EXACTLY the corpus seeds under EXACTLY the corpus config.
	const { summary, runs } = await cfg.run({
		seeds: corpus.entries.map((e) => e.seed),
		buggify: swarm.buggify,
		buggifyProbability: swarm.buggifyProbability,
		...(swarm.faultProfile !== undefined && { faultProfile: swarm.faultProfile }),
		base: swarm.base,
		gitCommit
	});
	const report = checkSimGoldens(corpus, { summary, runs });
	if (report.ok) {
		console.log(`sim-golden ${cfg.name}: OK - ${report.counts.matched}/${corpus.entries.length} fingerprints match (totalWeight ${report.totalWeight}).`);
		return true;
	}
	console.error(`sim-golden ${cfg.name}: DRIFT - driftWeight ${report.driftWeight} > ${report.maxDriftWeight} (${report.counts.changed} changed, ${report.counts.missing} missing).`);
	if (report.configMismatch) console.error(`  config mismatch: ${report.configMismatch}`);
	for (const d of report.drifts.slice(0, 10)) {
		if (d.kind === 'missing') {
			console.error(`  seed ${d.seed} (w${d.weight}): MISSING from run`);
		} else {
			console.error(`  seed ${d.seed} (w${d.weight}): ${d.golden.fingerprint} -> ${d.actual.fingerprint}` +
				`  (violations ${d.golden.digest.violations}->${d.actual.digest.violations}, categories [${d.golden.digest.violationCategories.join(',')}]->[${d.actual.digest.violationCategories.join(',')}])`);
		}
	}
	if (report.drifts.length > 10) console.error(`  ... and ${report.drifts.length - 10} more`);
	console.error(`  If this change is intentional, re-bless with \`npm run sim:golden -- --update\` and commit the corpus diff.`);
	return false;
}

if (update) {
	// Atomic all-or-nothing bless: build EVERY corpus first, and only write once
	// all are clean. A single non-clean swarm refuses the whole update, so a
	// half-broken tree never leaves one corpus freshly blessed while another is
	// refused (which would be committed together off a broken tree).
	const built = [];
	for (const cfg of CONFIGS) built.push({ cfg, corpus: await buildCorpus(cfg) });
	if (built.some((b) => b.corpus === null)) {
		console.error('sim-golden --update: REFUSING to write any corpus - fix the tree, then re-run. No files were touched.');
		process.exit(1);
	}
	for (const { cfg, corpus } of built) {
		mkdirSync(dirname(cfg.file), { recursive: true });
		writeFileSync(cfg.file, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
		console.log(`sim-golden --update ${cfg.name}: wrote ${corpus.entries.length} golden(s) to ${cfg.file}`);
	}
	console.log('sim-golden: corpora regenerated.');
} else {
	let allOk = true;
	for (const cfg of CONFIGS) allOk = (await verify(cfg)) && allOk;
	if (!allOk) process.exit(1);
	console.log('sim-golden: all corpora match HEAD.');
}
