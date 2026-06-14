// @ts-check
//
// Benchmarks for room action history + lag-compensated evaluation.
// Run with: NODE_ENV=production node bench/compensate.js   (the shipped hot path)
//      and: node bench/compensate.js                       (dev mode: deep freeze)
//
// Measures:
// 1. Room action dispatch with NO history config vs with history recording
//    (the per-action cost of capture + freeze + ring append)
// 2. ctx.compensate rewind against a full ring (clamp + binary search + eval)
//    vs the tolerance-gated path (clock read + fresh capture, no search)
//

import { live, handleRpc, __register } from '../src/server.js';

const textEncoder = new TextEncoder();

function createMockWs(userData) {
	return {
		getUserData: () => userData,
		subscribe() { return true; },
		unsubscribe() { return true; },
		isSubscribed() { return false; },
	};
}

function createMockPlatform() {
	return {
		connections: 1,
		publish() { return true; },
		send() { return 1; },
		sendTo() { return 0; },
		subscribers() { return 0; },
	};
}

function encodeRpc(path, id, args) {
	return textEncoder.encode(JSON.stringify({ rpc: path, id, args })).buffer;
}

function formatOps(ops) {
	if (ops >= 1e6) return (ops / 1e6).toFixed(2) + 'M ops/s';
	if (ops >= 1e3) return (ops / 1e3).toFixed(1) + 'K ops/s';
	return ops.toFixed(0) + ' ops/s';
}

function formatNs(ns) {
	if (ns < 1000) return ns.toFixed(0) + 'ns';
	if (ns < 1e6) return (ns / 1000).toFixed(1) + 'us';
	return (ns / 1e6).toFixed(2) + 'ms';
}

// A representative game world: 32 players with position, velocity, facing.
const PLAYERS = 32;
const world = { players: {} };
for (let i = 0; i < PLAYERS; i++) {
	world.players['p' + i] = { pos: { x: i * 10, y: i * 7 }, vel: { x: 1, y: 0 }, facing: 0.5 };
}

function captureWorld() {
	/** @type {Record<string, any>} */
	const players = {};
	for (const id of Object.keys(world.players)) {
		const p = world.players[id];
		players[id] = { pos: { x: p.pos.x, y: p.pos.y }, vel: { x: p.vel.x, y: p.vel.y }, facing: p.facing };
	}
	return { players };
}

const plainRoom = live.room({
	topic: (ctx, id) => 'benchplain:' + id,
	init: async () => [],
	topicArgs: 1,
	actions: { move: async (ctx, id, x) => x }
});

// A wide ring: at bench action rates entries land microseconds apart, so the
// default 300 entries would span only ~1-2ms and a realistic rewind stamp
// would predate the whole ring (correctly fail-safing to current state -
// the probes below prove the measured path). 30k entries spans ~150ms at
// bench rates; the binary search difference is a handful of probe steps.
const HIST_ENTRIES = 30_000;

const historyRoom = live.room({
	topic: (ctx, id) => 'benchhist:' + id,
	init: async () => [],
	topicArgs: 1,
	history: { capture: captureWorld, maxEntries: HIST_ENTRIES },
	actions: {
		move: async (ctx, id, x) => x,
		shoot: async (ctx, id, firedAt, options) =>
			ctx.compensate(firedAt, (state) => Object.keys(state.players).length, options),
		probe: async (ctx, id, firedAt, options) =>
			ctx.compensate(firedAt, (state, meta) => meta.fallback, options)
	}
});

__register('benchplain/r/__action/move', plainRoom.__actions.move);
__register('benchhist/r/__action/move', historyRoom.__actions.move);
__register('benchhist/r/__action/shoot', historyRoom.__actions.shoot);
__register('benchhist/r/__action/probe', historyRoom.__actions.probe);

/**
 * Dispatch `path` sequentially `n` times through handleRpc, resolving each
 * iteration on the response send (the bench/rpc.js measurement pattern).
 * Frames are encoded inside the measured loop - command-time stamps must be
 * fresh relative to the rolling history window, and the encode cost is
 * identical across every variant compared here.
 */
async function dispatchLoop(path, n, argsFor) {
	const ws = createMockWs({ id: 'user1' });
	const platform = createMockPlatform();

	// Warm up
	for (let i = 0; i < Math.min(n, 2000); i++) {
		await new Promise((resolve) => {
			platform.send = () => { resolve(undefined); return 1; };
			handleRpc(ws, encodeRpc(path, 'w' + i, argsFor(i)), platform);
		});
	}

	const start = performance.now();
	for (let i = 0; i < n; i++) {
		await new Promise((resolve) => {
			platform.send = () => { resolve(undefined); return 1; };
			handleRpc(ws, encodeRpc(path, String(i), argsFor(i)), platform);
		});
	}
	const ms = performance.now() - start;
	return (ms * 1e6) / n;
}

const N = 100_000;

const MODE = process.env.NODE_ENV === 'production'
	? 'production (shallow snapshot freeze - the shipped hot path)'
	: 'dev (deep snapshot freeze - expect several times the production cost)';
console.log('mode: ' + MODE);
console.log();
console.log('--- Room action dispatch: history off vs on (' + PLAYERS + '-player capture per action) ---');
const plainNs = await dispatchLoop('benchplain/r/__action/move', N, (i) => ['r', i]);
const histNs = await dispatchLoop('benchhist/r/__action/move', N, (i) => ['r', i]);
console.log(`No history:               ${formatNs(plainNs)}/op  (${formatOps(1e9 / plainNs)})`);
console.log(`History recording:        ${formatNs(histNs)}/op  (${formatOps(1e9 / histNs)})`);
console.log(`Recording cost per call:  ~${formatNs(histNs - plainNs)}`);
console.log();

// Fill the ring before the rewind measurements (move records each call).
{
	const ws = createMockWs({ id: 'user1' });
	const platform = createMockPlatform();
	for (let i = 0; i < HIST_ENTRIES; i++) {
		await new Promise((resolve) => {
			platform.send = () => { resolve(undefined); return 1; };
			handleRpc(ws, encodeRpc('benchhist/r/__action/move', 'fill' + i, ['r', i]), platform);
		});
	}
}

console.log('--- ctx.compensate against a full ring (' + HIST_ENTRIES + ' entries) ---');
// The measured shoots keep recording, so the ring keeps spanning the trailing
// ~150ms; a 50ms-back stamp stays inside it. The probes prove which path each
// variant actually measured.
const hitStamp = () => Date.now() - 50;
const missStamp = () => Date.now() - 60_000;
/** @param {() => any} stamp @param {any} [options] */
async function probePath(stamp, options) {
	const ws = createMockWs({ id: 'probe' });
	const platform = createMockPlatform();
	return await new Promise((resolve) => {
		platform.send = (w, topic, event, payload) => { resolve(payload.data); return 1; };
		handleRpc(ws, encodeRpc('benchhist/r/__action/probe', 'p', ['r', stamp(), options]), platform);
	});
}
console.log(`(path check: hit-stamp fallback=${await probePath(hitStamp)}, miss-stamp fallback=${await probePath(missStamp)})`);
const rewindNs = await dispatchLoop('benchhist/r/__action/shoot', N, () => ['r', hitStamp()]);
const fallbackNs = await dispatchLoop('benchhist/r/__action/shoot', N, () => ['r', missStamp()]);
const toleranceNs = await dispatchLoop('benchhist/r/__action/shoot', N, () => ['r', Date.now(), { tolerance: 1000 }]);
const noStampNs = await dispatchLoop('benchhist/r/__action/shoot', N, () => ['r', null]);
console.log(`Rewind (ring hit):        ${formatNs(rewindNs)}/op  (${formatOps(1e9 / rewindNs)})`);
console.log(`Rewind miss (fallback):   ${formatNs(fallbackNs)}/op  (${formatOps(1e9 / fallbackNs)})`);
console.log(`Tolerance-gated (fresh):  ${formatNs(toleranceNs)}/op  (${formatOps(1e9 / toleranceNs)})`);
console.log(`No command time (fresh):  ${formatNs(noStampNs)}/op  (${formatOps(1e9 / noStampNs)})`);
console.log();
