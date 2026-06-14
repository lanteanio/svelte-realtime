// @ts-check
//
// Benchmark for the multiplayer cursor send path on the server side.
// Run with: node bench/multiplayer-cursor.js
//
// live.multiplayer's __cursorMove / __presenceUpdate / __reactionEmit are
// volatile RPCs that fire on every pointer move (tens of hertz per connected
// user), so their server-side dispatch is a genuine hot path. Each call routes
// through handleRpc -> the volatile handler -> _publishCursor, which resolves
// the room's :cursors topic and publishes a keyed frame. This measures that
// end-to-end per-call cost so the per-publish path is covered by a number, not
// an assertion.

import { live, handleRpc, __register } from '../src/server.js';

const textEncoder = new TextEncoder();

function createMockWs(userData) {
	return {
		getUserData: () => userData,
		subscribe() { return true; },
		unsubscribe() { return true; },
		isSubscribed() { return false; }
	};
}

function createMockPlatform() {
	return {
		connections: 1,
		publish() { return true; },
		send() { return 1; },
		sendTo() { return 0; },
		subscribers() { return 0; },
		topic() {
			return {
				publish: () => true,
				created: () => true,
				updated: () => true,
				deleted: () => true,
				set: () => true
			};
		}
	};
}

function encodeVolatile(path, args) {
	return textEncoder.encode(JSON.stringify({ rpc: path, args })).buffer;
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

// A representative multiplayer room: one room-identifying arg, presence on,
// cursors on. __cursorMove is created unconditionally.
const mp = live.multiplayer({
	topic: (_ctx, roomId) => `room:${roomId}`,
	init: async () => [],
	presence: () => ({ name: 'u' }),
	cursors: true,
	topicArgs: 1
});
__register('bench/cursor', /** @type {any} */ (mp).__cursorMove);

async function benchCursorMove() {
	const ws = createMockWs({ id: 'u1' });
	const platform = createMockPlatform();
	const iterations = 50_000;
	const trials = 9;

	const bufs = new Array(iterations);
	for (let i = 0; i < iterations; i++) {
		bufs[i] = encodeVolatile('bench/cursor', ['room1', { x: i & 1023, y: (i >> 1) & 1023 }]);
	}

	let resolver = null;
	platform.publish = () => { if (resolver) resolver(); return true; };

	// Warm up.
	for (let i = 0; i < 5000; i++) {
		await new Promise((resolve) => { resolver = resolve; handleRpc(ws, bufs[i % bufs.length], platform); });
	}

	// Many trials; the MINIMUM time per trial is the cleanest estimate of true
	// cost on a noisy machine (interruptions only ever add time).
	const opsPerSec = [];
	for (let t = 0; t < trials; t++) {
		const start = performance.now();
		for (let i = 0; i < iterations; i++) {
			await new Promise((resolve) => { resolver = resolve; handleRpc(ws, bufs[i], platform); });
		}
		const ms = performance.now() - start;
		opsPerSec.push(iterations / (ms / 1000));
	}
	resolver = null;

	opsPerSec.sort((a, b) => a - b);
	const best = opsPerSec[opsPerSec.length - 1];
	const median = opsPerSec[Math.floor(opsPerSec.length / 2)];

	console.log('--- multiplayer __cursorMove dispatch (one in flight) ---');
	console.log(`best:   ${formatNs(1e9 / best)}/call  (${formatOps(best)})`);
	console.log(`median: ${formatNs(1e9 / median)}/call  (${formatOps(median)})`);
	console.log();
}

console.log('svelte-realtime multiplayer cursor-send benchmark');
console.log('='.repeat(60));
console.log();
await benchCursorMove();
console.log('Done.');
