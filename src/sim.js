// Deterministic simulation for the realtime live.X dispatch.
//
// Unlike the adapter sim (which models the uWS event loop) and the extensions
// sim (which models the cross-instance store relay), the realtime layer runs
// in-process over a mock platform: live RPCs resolve and stream publishes fan
// out synchronously. So a seed - a seeded clock + RNG installed on the runtime
// seam, plus the seeded chaos drop - makes a run reproducible bit-for-bit.
//
// It drives the RPC + stream publish/subscribe path. Cron/timer-driven
// scenarios are out of scope: the test harness's cron uses real timers, so a
// seeded virtual scheduler would be needed to make them deterministic, which
// this path deliberately avoids.
//
// Builds on the public `svelte-realtime/testing` harness (createTestEnv) rather
// than re-implementing dispatch, so it exercises the exact production register
// -> call -> publish path.
//
// Public subpath: svelte-realtime/sim.

import { setRuntimeEnv, resetRuntimeEnv } from './shared/runtime.js';
import { createTestEnv } from './testing.js';
import { live } from './server.js';

// The lag-compensation ("deterministic netcode") sim drives the smooth shot-resolution
// path rather than the RPC / stream path, so it lives in its own module; re-exported
// here so the whole realtime DST surface is one import (svelte-realtime/sim).
export { runSmoothSim, replaySmoothSim, runSmoothSimSwarm, DEFAULT_SMOOTH_SEED } from './server/sim-smooth.js';

/** A fixed default seed so the zero-config run is itself reproducible. */
export const DEFAULT_LIVE_SEED = 'svti-live-sim-0';

/** A fixed virtual wall-clock baseline so any seam clock read is reproducible. */
export const FIXED_EPOCH = 1_700_000_000_000;

// FNV-1a 32-bit string hash -> mulberry32. Same family as the adapter/extensions
// sim cores, so a string seed yields a reproducible draw stream.
function seededRng(seed) {
	let h = 2166136261 >>> 0;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
	let a = h >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Install a seeded, fixed-clock env on the realtime runtime seam so any
// ctx.now / ctx.random in the dispatch is reproducible. Partial env (clock +
// rng); timers stay default since the sim drives no cron/timer path. force:true
// because a run may execute under NODE_ENV=production in CI.
function installSeam(rng) {
	setRuntimeEnv({
		clock: { now: () => FIXED_EPOCH, monotonic: () => FIXED_EPOCH, wallEpoch: () => FIXED_EPOCH },
		rng: {
			float: () => rng(),
			u32: () => (rng() * 0x100000000) >>> 0,
			uuid: () => {
				let u = '';
				for (let i = 0; i < 8; i++) u += ((rng() * 16) | 0).toString(16);
				return 'sim-' + u;
			},
			bytes: (n) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (rng() * 256) & 0xff; return o; }
		}
	}, { force: true });
}

// Drain the microtask queue so async stream-init replies (which set the
// stream's topic and claim its event callback) and publish fan-out settle.
// Deterministic - microtask ordering is fixed - and introduces no timer
// primitive, so it stays inside the determinism seam.
async function flush() {
	for (let k = 0; k < 16; k++) await Promise.resolve();
}

/**
 * The default sim module: an echo RPC and a `feed` stream. Kept dependency-free
 * so a zero-config run exercises the RPC + stream fan-out path.
 */
function defaultModule() {
	return {
		echo: live(async (ctx, x) => x),
		feed: live.stream('feed', async () => [], { merge: 'crud', key: 'id' })
	};
}

/**
 * The default scenario: connect `clients` clients, echo a value from each
 * (RPC round-trip), subscribe each to the `feed` stream, then publish `events`
 * items to the feed topic so the fan-out is exercised.
 */
async function defaultScenario(api, opts) {
	const clients = [];
	for (let i = 0; i < opts.clients; i++) clients.push(api.connect({ userId: 'u' + i }));

	for (let i = 0; i < clients.length; i++) {
		const v = await clients[i].call('sim/echo', { i });
		api.expect(v, { i }, 'echo-' + i);
	}

	const streams = clients.map((c) => c.subscribe('sim/feed'));
	// The stream-init reply (async live.stream initFn) resolves on a microtask;
	// drain it so each stream's topic is set and its event callback is claimed
	// before publishing.
	await api.flush();
	const topic = streams[0] && streams[0].topic;
	if (topic) {
		for (let n = 0; n < opts.events; n++) api.publish(topic, 'created', { id: n, n });
	}
	await api.flush();
}

/**
 * Run one realtime simulation.
 *
 * @param {{
 *   seed?: string,
 *   clients?: number,
 *   events?: number,
 *   chaos?: { dropRate: number } | null,
 *   module?: () => Record<string, any>,
 *   scenario?: (api: any, opts: { clients: number, events: number }) => void | Promise<void>,
 *   gitCommit?: string
 * }} [config]
 * @returns {Promise<any>} a LiveSimResult
 */
export async function runLiveSim(config = {}) {
	const seed = config.seed ?? DEFAULT_LIVE_SEED;
	const clients = config.clients ?? 3;
	const events = config.events ?? 5;
	const chaos = config.chaos ?? null;
	const moduleFactory = config.module || defaultModule;
	const scenario = config.scenario || defaultScenario;

	const rng = seededRng(seed);
	installSeam(rng);

	const env = createTestEnv(chaos ? { chaos: { dropRate: chaos.dropRate, seed } } : undefined);
	try {
		env.register('sim', moduleFactory());

		/** @type {Array<{ category: string, context: any }>} */
		const violations = [];
		const seen = new Set();
		function recordViolation(category, context) {
			const key = category + ':' + JSON.stringify(context);
			if (!seen.has(key)) { seen.add(key); violations.push({ category, context }); }
		}

		/** @type {Array<{ topic: string | null, events: any[] }>} */
		const recordedStreams = [];
		let rpcChecks = 0;

		const api = {
			now: () => FIXED_EPOCH,
			rng,
			connect(userData) {
				const c = env.connect(userData);
				return {
					call: (path, ...args) => c.call(path, ...args),
					subscribe: (path, ...args) => { const s = c.subscribe(path, ...args); recordedStreams.push(s); return s; },
					disconnect: () => c.disconnect()
				};
			},
			publish: (topic, event, data) => env.platform.publish(topic, event, data),
			flush,
			/** Assert an RPC result; a mismatch is an invariant violation. */
			expect(actual, expected, label) {
				rpcChecks++;
				if (JSON.stringify(actual) !== JSON.stringify(expected)) {
					recordViolation('live.rpc-mismatch', { label, expected, actual });
				}
			}
		};

		await scenario(api, { clients, events });
		await flush();

		// Invariant: every set of streams subscribed to the SAME topic converged
		// on the identical event sequence. publish is all-or-nothing (a chaos drop
		// is missed by every subscriber equally), so a divergence between two
		// subscribers of one topic is a real fan-out bug, not expected loss.
		/** @type {Map<string, string[]>} topic -> per-subscriber JSON event seq */
		const byTopic = new Map();
		for (const s of recordedStreams) {
			const t = s.topic;
			if (!t) continue;
			const seq = JSON.stringify(s.events.map((e) => ({ event: e.event, data: e.data })));
			if (!byTopic.has(t)) byTopic.set(t, []);
			byTopic.get(t).push(seq);
		}
		for (const [topic, seqs] of byTopic) {
			for (let i = 1; i < seqs.length; i++) {
				if (seqs[i] !== seqs[0]) { recordViolation('live.stream-divergence', { topic, subscriber: i }); break; }
			}
		}

		// Deterministic, sorted structural snapshot for the replay self-gate.
		const topics = [...byTopic.keys()].sort();
		const finalState = {
			topics,
			perTopic: topics.map((t) => ({ topic: t, subscribers: byTopic.get(t).length, events: JSON.parse(byTopic.get(t)[0]).length })),
			rpcChecks
		};

		return {
			seed,
			gitCommit: config.gitCommit ?? (typeof process !== 'undefined' ? process.env.GIT_COMMIT : null) ?? null,
			config: { clients, events, chaos: chaos || null },
			invariantViolations: violations,
			metrics: { clients, events, rpcChecks, chaosDropped: env.chaos.dropped },
			clientFrames: recordedStreams.map((s) => s.events.map((e) => ({ event: e.event, data: e.data }))),
			finalState,
			_module: config.module,
			_scenario: config.scenario,
			_seedConfig: config
		};
	} finally {
		env.cleanup();
		resetRuntimeEnv();
	}
}

/**
 * Re-run a reproducer and assert the same outcome (the determinism self-gate).
 * @param {any} reproducer a result from runLiveSim
 */
export async function replayLiveSim(reproducer) {
	const cfg = {
		...(reproducer._seedConfig || {}),
		seed: reproducer.seed,
		module: reproducer._module,
		scenario: reproducer._scenario,
		gitCommit: reproducer.gitCommit
	};
	const result = await runLiveSim(cfg);
	result.reproduced =
		JSON.stringify(result.invariantViolations) === JSON.stringify(reproducer.invariantViolations) &&
		JSON.stringify(result.finalState) === JSON.stringify(reproducer.finalState) &&
		JSON.stringify(result.clientFrames) === JSON.stringify(reproducer.clientFrames) &&
		JSON.stringify(result.metrics) === JSON.stringify(reproducer.metrics);
	return result;
}

// - Seed swarm ---------------------------------------------------------------
// Self-contained (not a shared engine imported from the adapter): the installed
// adapter is a published package, so importing an unpublished engine would block
// local verification and couple publish order. Mirrors the adapter / extensions
// swarm contract.

/**
 * Structural fingerprint (the "unseed"): an 8-hex-char FNV-1a digest of the
 * byte-stable result fields. Same seed -> same fingerprint.
 * @param {any} result a runLiveSim result
 */
function liveFingerprint(result) {
	const canonical = JSON.stringify({
		finalState: result.finalState,
		invariantViolations: result.invariantViolations,
		clientFrames: result.clientFrames,
		metrics: result.metrics
	});
	let h = 2166136261 >>> 0;
	for (let i = 0; i < canonical.length; i++) { h ^= canonical.charCodeAt(i); h = Math.imul(h, 16777619); }
	return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Run a swarm of seeds against the realtime sim. Same contract as the adapter's
 * runSimSwarm: a seed range (`count`/`startSeed`) or explicit `seeds`, a
 * `buggify` knob (off/on/random) that enables a chaos drop (`faultProfile.dropRate`,
 * default 0.2) on the publish path, and `checkRatio` for a determinism re-check.
 * Chaos drop is all-or-nothing, so convergence still holds under it - a violation
 * is a real bug. Returns `{ summary, runs }`.
 *
 * @param {{
 *   seeds?: Array<string | number>, count?: number, startSeed?: number,
 *   base?: object, buggify?: 'off' | 'on' | 'random', faultProfile?: { dropRate?: number },
 *   buggifyProbability?: number, checkRatio?: number, gitCommit?: string,
 *   onResult?: (run: any, index: number) => void
 * }} [config]
 */
export async function runLiveSimSwarm(config = {}) {
	const base = config.base || {};
	const buggify = config.buggify || 'off';
	const buggifyProbability = config.buggifyProbability ?? 0.25;
	const checkRatio = config.checkRatio ?? 0;
	const dropRate = (config.faultProfile && config.faultProfile.dropRate) ?? 0.2;

	let seeds;
	if (Array.isArray(config.seeds)) {
		seeds = config.seeds.map(String);
	} else {
		const startSeed = Number.isInteger(config.startSeed) ? config.startSeed : 1;
		const count = Number.isInteger(config.count) ? config.count : 50;
		seeds = [];
		for (let i = 0; i < count; i++) seeds.push(String(startSeed + i));
	}

	const runs = [];
	const failingSeeds = [];
	const determinismFailingSeeds = [];
	let determinismChecks = 0;
	let gitCommit = config.gitCommit ?? base.gitCommit ?? null;

	for (let i = 0; i < seeds.length; i++) {
		const seed = seeds[i];

		let buggified = buggify === 'on';
		if (buggify === 'random') buggified = seededRng(seed + ':buggify')() < buggifyProbability;
		const chaos = buggified ? { dropRate } : (base.chaos || null);

		const result = await runLiveSim({ ...base, seed, chaos });
		if (gitCommit === null && result.gitCommit) gitCommit = result.gitCommit;

		const failed = result.invariantViolations.length > 0;

		let reproduced = null;
		if (checkRatio > 0 && seededRng(seed + ':check')() < checkRatio) {
			determinismChecks++;
			reproduced = (await replayLiveSim(result)).reproduced === true;
			if (!reproduced) determinismFailingSeeds.push(seed);
		}

		const run = {
			seed,
			ok: !failed && reproduced !== false,
			buggified,
			fingerprint: liveFingerprint(result),
			violations: result.invariantViolations.length,
			fatals: 0,
			uncaught: 0,
			violationCategories: [...new Set(result.invariantViolations.map((v) => v.category))].sort(),
			reproduced
		};
		runs.push(run);
		if (failed) failingSeeds.push(seed);
		if (config.onResult) config.onResult(run, i);
	}

	const determinismFailures = determinismFailingSeeds.length;
	return {
		summary: {
			total: seeds.length,
			passed: runs.filter((r) => r.ok).length,
			failed: failingSeeds.length,
			firstFailingSeed: failingSeeds.length ? failingSeeds[0] : null,
			failingSeeds,
			buggify,
			buggified: runs.filter((r) => r.buggified).length,
			determinismChecks,
			determinismFailures,
			determinismFailingSeeds,
			gitCommit,
			ok: failingSeeds.length === 0 && determinismFailures === 0
		},
		runs
	};
}

// - Golden-set regression gate ------------------------------------------------
// The swarms above prove each seed reproduces ITSELF; these pin the fingerprints
// to a COMMITTED baseline, so a code change that deterministically alters sim
// behavior (which self-reproduction passes unnoticed) fails loudly against the
// corpus. Self-contained mirrors of the adapter's buildSimGoldens/checkSimGoldens
// contract (same corpus schema, same report shape) for the same reason the swarm
// is: importing the engine from the installed adapter would couple publish order.
// Generic over any swarm result with the shared run shape, so ONE pair serves
// both the live-dispatch swarm and the smooth lag-compensation swarm.

/**
 * Numeric-aware seed comparator: "2" sorts before "10". Numeric seeds sort
 * ahead of non-numeric ones, which sort lexically. Keeps the committed golden
 * corpus and the drift report in a stable, human-scannable order.
 * @param {string|number} a
 * @param {string|number} b
 */
function compareSeeds(a, b) {
	const na = Number(a);
	const nb = Number(b);
	const aNum = Number.isFinite(na);
	const bNum = Number.isFinite(nb);
	if (aNum && bNum) return na - nb || String(a).localeCompare(String(b));
	if (aNum) return -1;
	if (bNum) return 1;
	return String(a).localeCompare(String(b));
}

/**
 * Project a swarm result (`runLiveSimSwarm` or `runSmoothSimSwarm`) into a
 * committable golden corpus: one entry per seed carrying the structural
 * fingerprint the swarm already stamped plus a small digest for triage, and
 * corpus-level metadata (the swarm config the fingerprints are only comparable
 * under). Pure - no clock, no environment, no fingerprint recomputation - so it
 * stays inside the determinism seam; a runner outside the seam stamps
 * recordedAt / gitCommit.
 *
 * Entries are sorted by seed (numeric-aware) so the committed file has a stable,
 * reviewable diff. A per-seed weight (default 1) sets how much that seed's drift
 * counts against the gate budget; weight 0 is a watch-list seed (recorded and
 * reported on drift, but never fails the gate).
 *
 * @param {{ summary: any, runs: any[] }} swarmResult
 * @param {{ weights?: Record<string, number>, gitCommit?: string|null, recordedAt?: string|null, swarm?: object|null }} [opts]
 */
export function buildSimGoldens(swarmResult, opts = {}) {
	const weights = opts.weights || {};
	const entries = swarmResult.runs.map((r) => ({
		seed: String(r.seed),
		weight: weights[r.seed] ?? weights[String(r.seed)] ?? 1,
		fingerprint: r.fingerprint,
		digest: {
			violations: r.violations,
			fatals: r.fatals,
			uncaught: r.uncaught,
			violationCategories: r.violationCategories,
			buggified: r.buggified
		}
	}));
	entries.sort((a, b) => compareSeeds(a.seed, b.seed));
	return {
		schemaVersion: 1,
		gitCommit: opts.gitCommit ?? swarmResult.summary?.gitCommit ?? null,
		recordedAt: opts.recordedAt ?? null,
		swarm: opts.swarm ?? null,
		entries
	};
}

/**
 * Compare a golden corpus against a fresh swarm result, weighting each drifted
 * seed by its recorded weight. Pure. The runner runs exactly the corpus seeds
 * under the corpus config, so an entry is matched (fingerprint identical),
 * changed (fingerprint differs - deterministic behavior moved), or missing
 * (seed absent from the run); a seed present in the run but absent from the
 * corpus is counted as 'added' but never gates. driftWeight is the summed
 * weight over {changed, missing}; the gate passes when there is no config
 * mismatch and driftWeight is within maxDriftWeight (default 0 - any drift on
 * a weighted seed fails). An intentional behavior change is blessed by
 * regenerating the corpus, whose diff is the reviewable record of what moved.
 *
 * @param {any} golden a corpus from {@link buildSimGoldens}
 * @param {{ summary: any, runs: any[] }} swarmResult
 * @param {{ maxDriftWeight?: number }} [opts]
 */
export function checkSimGoldens(golden, swarmResult, opts = {}) {
	const maxDriftWeight = opts.maxDriftWeight ?? 0;
	const actual = new Map();
	for (const r of swarmResult.runs) actual.set(String(r.seed), r);

	// The corpus fingerprints are comparable only to a run produced under the
	// same swarm config - the buggify mode above all, since it decides which
	// seeds are faulted. A mismatch means the runner ran the wrong config; fail
	// loudly rather than silently comparing incomparable fingerprints.
	let configMismatch = null;
	const gBuggify = golden.swarm ? golden.swarm.buggify : undefined;
	const aBuggify = swarmResult.summary ? swarmResult.summary.buggify : undefined;
	if (gBuggify !== undefined && gBuggify !== null && aBuggify !== undefined && gBuggify !== aBuggify) {
		configMismatch = "buggify mode differs: corpus recorded '" + gBuggify + "', run used '" + aBuggify +
			"' - fingerprints are not comparable; regenerate the corpus or fix the runner config";
	}

	const drifts = [];
	let changed = 0;
	let missing = 0;
	let matched = 0;
	let totalWeight = 0;
	let driftWeight = 0;
	for (const entry of golden.entries) {
		const w = entry.weight ?? 1;
		totalWeight += w;
		const a = actual.get(String(entry.seed));
		if (!a) {
			missing++;
			driftWeight += w;
			drifts.push({ seed: entry.seed, weight: w, kind: 'missing', golden: { fingerprint: entry.fingerprint, digest: entry.digest }, actual: null });
			continue;
		}
		if (a.fingerprint === entry.fingerprint) {
			matched++;
		} else {
			changed++;
			driftWeight += w;
			drifts.push({
				seed: entry.seed,
				weight: w,
				kind: 'changed',
				golden: { fingerprint: entry.fingerprint, digest: entry.digest },
				actual: {
					fingerprint: a.fingerprint,
					digest: { violations: a.violations, fatals: a.fatals, uncaught: a.uncaught, violationCategories: a.violationCategories, buggified: a.buggified }
				}
			});
		}
	}

	let added = 0;
	const goldenSeeds = new Set(golden.entries.map((e) => String(e.seed)));
	for (const r of swarmResult.runs) if (!goldenSeeds.has(String(r.seed))) added++;

	drifts.sort((x, y) => (y.weight - x.weight) || compareSeeds(x.seed, y.seed));
	const ok = configMismatch === null && driftWeight <= maxDriftWeight;
	return { ok, totalWeight, driftWeight, maxDriftWeight, drifts, configMismatch, counts: { changed, missing, added, matched } };
}
