// @ts-check
//
// Benchmarks for the volatile (fire-and-forget) RPC path on the server side.
// Run with: node bench/volatile.js
//          (or `node --expose-gc bench/volatile.js` to enable heap-diff bench)
//
// Caveat: the headline win for volatile RPC is on the CLIENT, not the server.
// Client-side, `.fireAndForget()` skips: id allocation, Promise allocation,
// dedup-map entry, pending-Map entry, timer allocation, devtools-pending
// entry, and the dedup `queueMicrotask(delete)` per call - the bulk of the
// per-call cost. Server-side, the only saving is skipping `_respond()` (one
// platform.send call plus the response envelope object). This bench measures
// the server-side saving since that is what we can drive from Node without a
// browser harness; treat it as a floor for the total improvement.
//
// Measures:
// 1. handleRpc dispatch overhead: id-bearing (awaited) vs volatile (drained)
//    at the SAME effective concurrency (one in flight at a time).
// 2. Heap allocation diff: same iteration count on both paths, snapshot the
//    heap post-loop after a forced gc.

import { live, handleRpc, __register } from '../server.js';

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

function encodeIdBearing(path, id, args) {
	return textEncoder.encode(JSON.stringify({ rpc: path, id, args })).buffer;
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

function formatBytes(bytes) {
	if (Math.abs(bytes) < 1024) return bytes.toFixed(0) + ' B';
	if (Math.abs(bytes) < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
	return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Identical handler bodies on both paths. The wire shape is the only
// per-call difference (id present + _respond fires vs id absent + no response).
const idFn = live(async (_ctx, value) => value);
__register('bench/echo-id', idFn);

const volFn = live.volatile(async (_ctx, _value) => undefined);
__register('bench/echo-volatile', volFn);

/**
 * Sequential one-in-flight dispatch. Both paths drive the SAME concurrency
 * model (await round-trip), so the wallclock diff is purely the per-dispatch
 * difference (handleRpc parse + route + optional _respond). For the volatile
 * path we instrument the handler to signal completion since the wire has no
 * response.
 */
async function benchDispatchOverhead() {
	const ws = createMockWs({ id: 'u1' });
	const platform = createMockPlatform();
	const iterations = 50_000;

	// Warm up both paths
	for (let i = 0; i < 1000; i++) {
		handleRpc(ws, encodeIdBearing('bench/echo-id', 'w' + i, ['x']), platform);
		handleRpc(ws, encodeVolatile('bench/echo-volatile', ['x']), platform);
	}
	await new Promise((r) => setTimeout(r, 100));

	// Re-register volatile handler with a completion signal so we can drive
	// one-in-flight semantics for both paths.
	let volResolver = null;
	const volWithSignal = live.volatile(async (_ctx, _value) => {
		if (volResolver) volResolver();
		return undefined;
	});
	__register('bench/echo-volatile', volWithSignal);

	const idBufs = new Array(iterations);
	const volBufs = new Array(iterations);
	for (let i = 0; i < iterations; i++) {
		idBufs[i] = encodeIdBearing('bench/echo-id', String(i), ['x']);
		volBufs[i] = encodeVolatile('bench/echo-volatile', ['x']);
	}

	// id-bearing path: wait for _respond callback
	const idStart = performance.now();
	for (let i = 0; i < iterations; i++) {
		await new Promise((resolve) => {
			platform.send = () => { resolve(); return 1; };
			handleRpc(ws, idBufs[i], platform);
		});
	}
	platform.send = () => 1;
	const idMs = performance.now() - idStart;
	const idNs = (idMs * 1e6) / iterations;

	// volatile path: wait for handler-resolver signal
	const volStart = performance.now();
	for (let i = 0; i < iterations; i++) {
		await new Promise((resolve) => {
			volResolver = resolve;
			handleRpc(ws, volBufs[i], platform);
		});
	}
	volResolver = null;
	const volMs = performance.now() - volStart;
	const volNs = (volMs * 1e6) / iterations;

	console.log('--- handleRpc dispatch overhead (one in flight) ---');
	console.log(`id-bearing (with _respond):  ${formatNs(idNs)}/op  (${formatOps(iterations / (idMs / 1000))})`);
	console.log(`volatile (no _respond):      ${formatNs(volNs)}/op  (${formatOps(iterations / (volMs / 1000))})`);
	const speedup = idNs / volNs;
	if (speedup >= 1) {
		console.log(`Volatile is ${speedup.toFixed(2)}x faster (saves ${formatNs(idNs - volNs)}/call)`);
	} else {
		console.log(`Volatile is ${(1 / speedup).toFixed(2)}x slower in this bench (noise; the synchronous _respond is shorter than the resolver microtask in this harness)`);
	}
	console.log();
}

/**
 * Heap retention diff. Both paths run the same number of iterations and the
 * same handler body; the only difference is `_respond()` on the id-bearing
 * path. The transient envelope object and platform.send call (+ its return-
 * value handling) drain to gc; what is retained is residual closure / Map
 * state. The retained delta is expected to be near zero on both sides since
 * neither path holds state across calls; the value of this bench is the
 * confirmation, not a headline number.
 */
async function benchHeapAllocations() {
	if (typeof global.gc !== 'function') {
		console.log('--- Heap allocation diff (skipped) ---');
		console.log('Re-run with `node --expose-gc bench/volatile.js` to enable.');
		console.log();
		return;
	}

	const ws = createMockWs({ id: 'u1' });
	const platform = createMockPlatform();
	const iterations = 50_000;

	const idBufs = new Array(iterations);
	const volBufs = new Array(iterations);
	for (let i = 0; i < iterations; i++) {
		idBufs[i] = encodeIdBearing('bench/echo-id', String(i), ['x']);
		volBufs[i] = encodeVolatile('bench/echo-volatile', ['x']);
	}

	// id-bearing
	global.gc();
	await new Promise((r) => setTimeout(r, 50));
	global.gc();
	const idBefore = process.memoryUsage().heapUsed;

	for (let i = 0; i < iterations; i++) {
		await new Promise((resolve) => {
			platform.send = () => { resolve(); return 1; };
			handleRpc(ws, idBufs[i], platform);
		});
	}
	platform.send = () => 1;

	global.gc();
	const idAfter = process.memoryUsage().heapUsed;
	const idDelta = idAfter - idBefore;

	// volatile - re-register with signal
	let volResolver = null;
	const volWithSignal = live.volatile(async () => { if (volResolver) volResolver(); });
	__register('bench/echo-volatile', volWithSignal);

	global.gc();
	await new Promise((r) => setTimeout(r, 50));
	global.gc();
	const volBefore = process.memoryUsage().heapUsed;

	for (let i = 0; i < iterations; i++) {
		await new Promise((resolve) => {
			volResolver = resolve;
			handleRpc(ws, volBufs[i], platform);
		});
	}
	volResolver = null;

	global.gc();
	const volAfter = process.memoryUsage().heapUsed;
	const volDelta = volAfter - volBefore;

	console.log('--- Heap retained delta after ' + iterations.toLocaleString() + ' dispatches ---');
	console.log(`id-bearing retained:    ${formatBytes(idDelta)}`);
	console.log(`volatile retained:      ${formatBytes(volDelta)}`);
	console.log(`Both should be near zero (no per-call state retained on either side).`);
	console.log();
}

console.log('svelte-realtime volatile (fire-and-forget) RPC benchmarks');
console.log('='.repeat(60));
console.log();

await benchDispatchOverhead();
await benchHeapAllocations();

console.log('Done.');
