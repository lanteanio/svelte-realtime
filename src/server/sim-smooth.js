// Deterministic simulation for the server-rewind lag compensation ("deterministic
// netcode"): a recorded, latency-varying shot stream resolved against a moving
// board must reproduce every hit - target, distance, rewind instant, impact point -
// bit for bit under the same seed. A divergence between two passes of one seed is a
// real determinism bug (a real-clock read, a Map-iteration-order dependence, an
// uninitialised float); the swarm runs thousands of randomized worlds and asserts
// the property holds on every one.
//
// Faithful by construction: it drives the EXACT production resolution functions -
// `_smoothEdgeMeasure` (server-measured reach + the replay defense + the per-
// connection round-trip tracker), `_smoothRewindAt` (the favor-shooter clamp), and
// `_smoothResolveShot` (the candidate gate, the rewound-world narrowphase, the
// nearest-first onHit) - over a record built by the same `_smoothRecord` the handlers
// use, with the real `createLagComp` ring, `createMonotonicClock` axis,
// `createInterestState` relevancy pass, and `createRttTracker`. Nothing is
// re-implemented; only the entity authority (the adapter's concern, out of this repo)
// and the transport are scripted, neither of which carries the lag-comp determinism.
//
// Each tick mirrors the real smooth tick's lag-comp-relevant orchestration: move the
// board, run the interest relevancy pass on a moving tick, note the per-subscriber
// send cadence (so the interpolation-delay estimate is real), and record the post-
// move catalog into the ring on the monotonic axis. Then a seeded shot stream fires
// through the real measure -> clamp -> resolve path. No timer simulation is needed:
// ticks and shots are driven directly with explicit wall stamps, exactly as the
// armed tick and the shoot handler would supply them - and the seam closes the timer
// primitive (below), so a hit arming the demand tick can never schedule real wall-
// clock work mid-run.
//
// Out of scope: the injected victim consequence is not drained/applied (the sim never
// re-ticks after a shot), so the determinism property covers the rewind + resolve +
// onHit path, not the subsequent authoritative apply of the injected command.
//
// Public subpath: svelte-realtime/sim.

import { setRuntimeEnv, resetRuntimeEnv } from '../shared/runtime.js';
import {
	_smoothRegister,
	_smoothRecord,
	_smoothEdgeMeasure,
	_smoothRewindAt,
	_smoothResolveShot,
	_resetSmooth
} from './smooth.js';

/** A fixed default seed so the zero-config run is itself reproducible. */
export const DEFAULT_SMOOTH_SEED = 'svti-smooth-sim-0';

/** A fixed virtual wall-clock baseline so any seam clock read is reproducible.
 *  Module-local: the public `/sim` subpath already exposes a FIXED_EPOCH from sim.js. */
const FIXED_EPOCH = 1_700_000_000_000;

// FNV-1a 32-bit string hash -> mulberry32. Same family as the adapter / extensions /
// realtime sim cores, so a string seed yields a reproducible draw stream.
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

// Install a seeded, fixed-clock env on the runtime seam. The resolution path takes
// every timestamp as a caller argument, so the seeded clock + rng are hygiene rather
// than the determinism source - that comes from seed -> rng -> explicit stamps. The
// timer primitive IS load-bearing, though: a hit arms the demand tick via setTimer, and
// the sim drives ticks itself, so a real setTimeout firing mid-run would double-record
// the ring. Closing set/clear to no-ops (queueMicrotask stays native, the async flow
// needs it) makes that structurally impossible. force:true because a run may execute
// under NODE_ENV=production in CI.
function installSeam(rng) {
	setRuntimeEnv({
		clock: { now: () => FIXED_EPOCH, monotonic: () => FIXED_EPOCH, wallEpoch: () => FIXED_EPOCH },
		rng: {
			float: () => rng(),
			u32: () => (rng() * 0x100000000) >>> 0,
			uuid: () => { let u = ''; for (let i = 0; i < 8; i++) u += ((rng() * 16) | 0).toString(16); return 'sim-' + u; },
			bytes: (n) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (rng() * 256) & 0xff; return o; }
		},
		timers: { set: () => 1, setInterval: () => 1, setImmediate: () => 1, clear: () => {}, clearInterval: () => {} }
	}, { force: true });
}

// A scripted smooth runtime: a Map-backed entity authority (the sim is the only
// writer of entity state, so movement is driven directly via `_set` rather than the
// adapter's command drain) plus a stub wire codec. Mirrors the authority contract
// `_smoothRecord` / `_smoothResolveShot` exercise (ensure / get / inject / catalog).
function createSimSmoothRuntime() {
	return {
		SMOOTH_TOPIC_PREFIX: '__smooth:',
		createSmoothAuthority() {
			const entities = new Map();
			let injected = 0;
			return {
				ensure(key, ws, initial) {
					let e = entities.get(key);
					if (e === undefined) { e = { state: initial, ws, lastAckedId: 0 }; entities.set(key, e); }
					return { state: e.state, lastAckedId: e.lastAckedId };
				},
				get(key) { return entities.get(key); },
				enqueue() { return true; },
				inject(key) { if (entities.has(key)) { injected++; return true; } return false; },
				drain() { return { updates: [], acks: [], events: [], idle: true }; },
				remove(key) { return entities.delete(key); },
				removeWs(ws) { const r = []; for (const [k, e] of entities) if (e.ws === ws) { entities.delete(k); r.push(k); } return r; },
				catalog() { return [...entities].map(([key, e]) => ({ key, state: e.state })); },
				get size() { return entities.size; },
				// Sim-only: set an entity's state directly (the driven board move). A fresh
				// state object each move so the interest change-detector (state !== sent) fires.
				_set(key, ws, state) {
					let e = entities.get(key);
					if (e === undefined) { e = { state, ws, lastAckedId: 0 }; entities.set(key, e); } else { e.state = state; }
				},
				get _injected() { return injected; }
			};
		},
		createSmoothWireCodec() {
			return { capability: 'smooth.protocol:1', schemaVersion: 1, encode: () => null, state: { onAttach: () => null, onDetach: () => {} } };
		}
	};
}

// A recording platform: the hit-event broadcast lands here (the determinism signal is
// the hit log; the event count is a secondary fingerprint field). subscribe never denies.
function recordingPlatform() {
	const events = [];
	return {
		events,
		publish() { return true; },
		subscribe() { return undefined; },
		publishWire(topic, event, data) { events.push({ topic, event, data }); return true; },
		sendWire() { return 1; }
	};
}

/**
 * Run one lag-compensation simulation: build a moving board, fire a seeded latency-
 * varying shot stream, and capture the resolved hits plus the per-shot reach / rewind
 * measurements. Asserts the per-shot domain invariants (bounded reach, no future or
 * out-of-window rewind, a real [0,1] ray fraction) inline; the two-pass determinism
 * check is the swarm's `checkRatio` re-run.
 *
 * @param {{
 *   seed?: string,
 *   entities?: number,
 *   ticks?: number,
 *   shots?: number,
 *   tickMs?: number,
 *   maxRewindMs?: number,
 *   radius?: number,
 *   faultMode?: boolean,
 *   onHitTap?: (target: any, info: any) => any,
 *   gitCommit?: string
 * }} [config] `faultMode` widens the shot lag past the favor-shooter reach and teleports
 *   a target into the rewindable window late in the run, exercising the reach clamp, the
 *   over-window fallback, and the ring's teleport guard - paths the determinism property
 *   must survive too. `onHitTap` folds an extra value into each hit record (a test hook
 *   to prove the harness catches a planted non-determinism).
 * @returns {Promise<any>} a SmoothSimResult
 */
export async function runSmoothSim(config = {}) {
	const seed = config.seed ?? DEFAULT_SMOOTH_SEED;
	const entityCount = Math.max(2, config.entities ?? 5);
	const ticks = Math.max(2, config.ticks ?? 12);
	const shots = Math.max(1, config.shots ?? 8);
	const tickMs = config.tickMs ?? 50;
	const maxRewindMs = config.maxRewindMs ?? 1000;
	const radius = config.radius ?? 1000;
	const faulted = config.faultMode === true;
	const onHitTap = typeof config.onHitTap === 'function' ? config.onHitTap : null;

	const rng = seededRng(seed);
	installSeam(rng);
	_resetSmooth();

	/** @type {Array<{ category: string, context: any }>} */
	const violations = [];
	const seen = new Set();
	const recordViolation = (category, context) => {
		const k = category + ':' + JSON.stringify(context);
		if (!seen.has(k)) { seen.add(k); violations.push({ category, context }); }
	};

	/** @type {any[]} */
	const hitLog = [];
	/** @type {any[]} */
	const shotResults = [];

	try {
		const SHOOTER = 'u0';
		const targets = [];
		for (let i = 1; i < entityCount; i++) targets.push('u' + i);

		// The shape: a circle hitbox + a ray shot + an interest cull. teleportThreshold
		// is armed only under faultMode so the OFF path stays the common (always-on gap
		// guard) geometry. Declared through the real `live.smooth` normalizer so the cfg
		// (including the hitTest.position -> interest.position default the ring-space gate
		// keys on) is exactly what production builds.
		const shape = _smoothRegister({
			topic: (ctx, roomId) => 'shape:' + roomId,
			topicArgs: 1,
			apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y + (cmd.dy || 0) }),
			initial: { x: 0, y: 0 },
			tickMs,
			interest: {
				radius,
				position: (s) => (s && Number.isFinite(s.x) && Number.isFinite(s.y) ? { x: s.x, y: s.y } : null),
				lod: [{ within: radius * 0.1, rate: 1 }, { within: radius, rate: 3 }]
			},
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: radius * 2 },
				maxRewindMs,
				teleportThreshold: faulted ? radius * 0.5 : undefined,
				onHit: (ctx, target, info) => {
					const entry = {
						key: target.key,
						dist: info.dist,
						fraction: info.fraction,
						rewindAt: info.rewindAt,
						fallback: info.fallback,
						px: info.point.x,
						py: info.point.y
					};
					if (onHitTap) entry.tap = onHitTap(target, info);
					hitLog.push(entry);
					ctx.applyTo(target.key, { damage: 10 });
					ctx.emitEvent('hit', { key: target.key });
				}
			}
		});
		const cfg = shape.__smoothCfg;
		const name = 'shape:' + seed;

		const platform = recordingPlatform();
		const rt = createSimSmoothRuntime();
		const rec = _smoothRecord(name, cfg, platform, rt);
		const auth = /** @type {any} */ (rec.authority);

		// The shooter is the topic's local subscriber (so getCandidates(SHOOTER) is
		// populated by the relevancy pass). A stable ws object across the whole run so
		// the per-connection round-trip tracker (keyed by ws) accumulates shot to shot.
		const shooterWs = { id: SHOOTER };
		rec.registry.set(SHOOTER, shooterWs);

		// Spawn: the shooter holds station at the origin; targets scatter along +x near
		// the y=0 ray (so an aimed shot can strike them) within the cull radius, each with
		// a modest seeded velocity (small enough that the rewound position stays inside the
		// 30u hitbox for an in-window shot, so honest hits actually resolve).
		const pos = new Map();
		const spawn = new Map();
		const vel = new Map();
		auth._set(SHOOTER, shooterWs, { x: 0, y: 0 });
		pos.set(SHOOTER, { x: 0, y: 0 });
		for (const k of targets) {
			const p = { x: 100 + rng() * (radius * 0.7), y: (rng() - 0.5) * 40 };
			pos.set(k, p);
			spawn.set(k, { x: p.x, y: p.y });
			vel.set(k, { vx: (rng() - 0.5) * 6, vy: (rng() - 0.5) * 6 });
			auth._set(k, { id: k }, p);
		}

		// Drive the ticks. Mirrors the real smooth tick's lag-comp-relevant work: relevancy
		// on a moving tick, noteSend per delivered non-self subscriber, ring record EVERY
		// tick on the monotonic axis.
		for (let t = 0; t < ticks; t++) {
			const wall = FIXED_EPOCH + t * tickMs;
			for (const k of targets) {
				const p = pos.get(k);
				const v = vel.get(k);
				let nx = p.x + v.vx;
				let ny = p.y + v.vy;
				// A late teleport (faultMode only), placed inside the rewindable window so a
				// reach-clamped shot rewinds into the straddling bracket and the ring's
				// teleport guard fires (the jump exceeds teleportThreshold, so sample returns
				// null and the target is excluded - deterministically).
				if (faulted && k === targets[0] && t === ticks - 2) { nx += radius; ny += radius; }
				const np = { x: nx, y: ny };
				pos.set(k, np);
				auth._set(k, { id: k }, np);
			}
			const catalog = auth.catalog();
			// A moving tick (targets always move here) runs the relevancy pass.
			rec.interest.compute(catalog, rec.registry.keys(), rec.interestTick++);
			const relevancy = rec.interest.relevancy;
			for (const identity of rec.registry.keys()) {
				const relSet = relevancy ? relevancy.get(identity) : undefined;
				let delivered = false;
				if (relSet) for (const key of relSet) if (key !== identity) { delivered = true; break; }
				if (delivered) rec.interest.noteSend(identity, wall, rec.tickMs * rec.broadcastEvery);
			}
			rec.lagComp.record(catalog, rec.monoClock.mono(wall));
		}

		// Fire the shot stream. rt (the client render-time) is non-decreasing so the replay
		// defense never legitimately drops; ackT trails `now` by a seeded round trip so the
		// measured uplink - and the reach it drives - evolves shot to shot. Aim is taken at
		// the target's position at the (approximate) rewind instant so honest shots resolve.
		let prevRt = -Infinity;
		const lastTick = FIXED_EPOCH + (ticks - 1) * tickMs;
		const sp = pos.get(SHOOTER);
		for (let i = 0; i < shots; i++) {
			const now = lastTick + (i + 1) * tickMs;
			const tk = targets[Math.floor(rng() * targets.length)];
			// A modest lag (in window, under the typical reach) on the common path so the
			// rewind lands near `rt`; faultMode widens it past the reach to exercise the clamp.
			const lag = faulted ? Math.floor(rng() * (maxRewindMs * 0.9)) : Math.floor(rng() * 140);
			let rtStamp = now - lag;
			if (rtStamp < prevRt) rtStamp = prevRt;
			prevRt = rtStamp;
			// The target's recorded position at the tick nearest the render-time: the rewind
			// resolves against the ring near there, so aiming at it produces honest hits (a
			// small seeded jitter yields the occasional clean miss).
			const tickOfRt = Math.max(0, Math.min(ticks - 1, Math.round((rtStamp - FIXED_EPOCH) / tickMs)));
			const tp0 = ringPosAt(spawn, vel, tk, tickOfRt);
			const base = Math.atan2(tp0.y - sp.y, tp0.x - sp.x);
			const aim = base + (rng() - 0.5) * 0.04;
			const uplink = Math.floor(rng() * 100);
			const ackT = now - uplink * 2;
			const payload = { cmd: { aim }, rt: rtStamp, ackT };
			const ctx = { ws: shooterWs, platform };

			const m = _smoothEdgeMeasure(rec, ctx, payload, SHOOTER, now);
			if (m === null) { shotResults.push({ shot: i, dropped: true }); continue; }
			if (!(m.reach <= maxRewindMs + 1e-9)) recordViolation('smooth.reach-exceeds-cap', { shot: i, reach: m.reach });
			const rewindAt = _smoothRewindAt(m.nowMono, m.reach, m.rewindAge);
			if (!(rewindAt <= m.nowMono + 1e-9)) recordViolation('smooth.rewind-future', { shot: i });
			if (!(rewindAt >= m.nowMono - maxRewindMs - 1e-9)) recordViolation('smooth.rewind-beyond-window', { shot: i });

			const before = hitLog.length;
			await _smoothResolveShot(rec, name, SHOOTER, auth.get(SHOOTER), platform, m.cmd, rewindAt, m.nowMono);
			for (let h = before; h < hitLog.length; h++) {
				const e = hitLog[h];
				if (!(e.fraction >= -1e-9 && e.fraction <= 1 + 1e-9)) recordViolation('smooth.fraction-range', { shot: i, fraction: e.fraction });
				if (!Number.isFinite(e.dist)) recordViolation('smooth.dist-nonfinite', { shot: i });
			}
			shotResults.push({
				shot: i,
				dropped: false,
				reach: m.reach,
				rewindAge: m.rewindAge === null ? null : m.rewindAge,
				nowMono: m.nowMono,
				rewindAt,
				hits: hitLog.length - before
			});
		}

		const finalState = {
			entities: entityCount,
			ticks,
			shots,
			injected: auth._injected,
			events: platform.events.length,
			hitCount: hitLog.length
		};

		return {
			seed,
			gitCommit: config.gitCommit ?? (typeof process !== 'undefined' ? process.env.GIT_COMMIT : null) ?? null,
			config: { entities: entityCount, ticks, shots, tickMs, maxRewindMs, radius, faultMode: faulted },
			invariantViolations: violations,
			metrics: {
				entities: entityCount,
				ticks,
				shots,
				hits: hitLog.length,
				dropped: shotResults.filter((s) => s.dropped).length,
				injected: auth._injected,
				events: platform.events.length
			},
			hitLog,
			shotResults,
			finalState,
			_seedConfig: config
		};
	} finally {
		_resetSmooth();
		resetRuntimeEnv();
	}
}

// The target's ring-recorded position at tick `k`: the tick loop records the post-move
// catalog, so after tick `k` the entity sits at `spawn + vel * (k + 1)`. Used only to
// aim a shot near where the target was at the rewind instant (so honest shots resolve);
// never fed into the resolution itself, so its precision only affects hit yield, not
// determinism. The faultMode teleport perturbs one target past this closed form, which
// only costs that shot a miss.
function ringPosAt(spawn, vel, key, k) {
	const s = spawn.get(key);
	const v = vel.get(key);
	return { x: s.x + v.vx * (k + 1), y: s.y + v.vy * (k + 1) };
}

/**
 * Re-run a reproducer under the same seed + config and assert the same outcome (the
 * determinism self-gate). Sets `reproduced` true only when every byte-stable field
 * matches.
 * @param {any} reproducer a result from runSmoothSim
 */
export async function replaySmoothSim(reproducer) {
	const cfg = { ...(reproducer._seedConfig || {}), seed: reproducer.seed, gitCommit: reproducer.gitCommit };
	const result = await runSmoothSim(cfg);
	result.reproduced =
		JSON.stringify(result.invariantViolations) === JSON.stringify(reproducer.invariantViolations) &&
		JSON.stringify(result.finalState) === JSON.stringify(reproducer.finalState) &&
		JSON.stringify(result.hitLog) === JSON.stringify(reproducer.hitLog) &&
		JSON.stringify(result.shotResults) === JSON.stringify(reproducer.shotResults) &&
		JSON.stringify(result.metrics) === JSON.stringify(reproducer.metrics);
	return result;
}

/**
 * Structural fingerprint: an 8-hex-char FNV-1a digest of the byte-stable
 * result fields. Same seed -> same fingerprint.
 * @param {any} result a runSmoothSim result
 */
function smoothFingerprint(result) {
	const canonical = JSON.stringify({
		finalState: result.finalState,
		invariantViolations: result.invariantViolations,
		hitLog: result.hitLog,
		shotResults: result.shotResults,
		metrics: result.metrics
	});
	let h = 2166136261 >>> 0;
	for (let i = 0; i < canonical.length; i++) { h ^= canonical.charCodeAt(i); h = Math.imul(h, 16777619); }
	return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Run a swarm of seeds against the lag-compensation sim. Same contract as the adapter /
 * realtime swarms: a seed range (`count`/`startSeed`) or explicit `seeds`, a `faultMode`
 * knob (off/on/random) that widens the shot lag and arms a mid-run teleport, and
 * `checkRatio` for the two-pass determinism re-check. An invariant violation or a non-
 * reproduced re-check fails the seed. Returns `{ summary, runs }`.
 *
 * @param {{
 *   seeds?: Array<string | number>, count?: number, startSeed?: number,
 *   base?: object, faultMode?: 'off' | 'on' | 'random', faultProbability?: number,
 *   checkRatio?: number, gitCommit?: string, onResult?: (run: any, index: number) => void
 * }} [config]
 */
export async function runSmoothSimSwarm(config = {}) {
	const base = config.base || {};
	const faultMode = config.faultMode || 'off';
	const faultProbability = config.faultProbability ?? 0.25;
	const checkRatio = config.checkRatio ?? 0;

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

		let faulted = faultMode === 'on';
		if (faultMode === 'random') faulted = seededRng(seed + ':faultmode')() < faultProbability;

		const result = await runSmoothSim({ ...base, seed, faultMode: faulted });
		if (gitCommit === null && result.gitCommit) gitCommit = result.gitCommit;

		const failed = result.invariantViolations.length > 0;

		let reproduced = null;
		if (checkRatio > 0 && seededRng(seed + ':check')() < checkRatio) {
			determinismChecks++;
			reproduced = (await replaySmoothSim(result)).reproduced === true;
			if (!reproduced) determinismFailingSeeds.push(seed);
		}

		const run = {
			seed,
			ok: !failed && reproduced !== false,
			faulted,
			fingerprint: smoothFingerprint(result),
			violations: result.invariantViolations.length,
			fatals: 0,
			uncaught: 0,
			violationCategories: [...new Set(result.invariantViolations.map((v) => v.category))].sort(),
			reproduced,
			hits: result.metrics.hits
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
			faultMode,
			faulted: runs.filter((r) => r.faulted).length,
			determinismChecks,
			determinismFailures,
			determinismFailingSeeds,
			gitCommit,
			ok: failingSeeds.length === 0 && determinismFailures === 0
		},
		runs
	};
}
