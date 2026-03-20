// @ts-check
//
// Benchmarks for svelte-realtime overhead.
// Run with: node bench/rpc.js
//
// Measures:
// 1. RPC dispatch overhead (handleRpc parse + registry + ctx + execute + respond)
//    vs calling the function directly
// 2. Stream merge throughput (ops/sec for each merge strategy at various array sizes)
//

import { live, LiveError, handleRpc, __register } from '../server.js';

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
		topic(t) {
			return {
				publish: () => true,
				created: () => true,
				updated: () => true,
				deleted: () => true,
				set: () => true,
			};
		},
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

// ---------------------------------------------------------------------------
// 1. RPC dispatch overhead
// ---------------------------------------------------------------------------

const echoFn = live(async (_ctx, value) => value);
__register('bench/echo', echoFn);

async function benchRpcDispatch() {
	const ws = createMockWs({ id: 'user1' });
	const platform = createMockPlatform();

	// Warm up
	for (let i = 0; i < 1000; i++) {
		const buf = encodeRpc('bench/echo', String(i), ['hello']);
		handleRpc(ws, buf, platform);
	}
	// Wait for all warmup handlers to settle
	await new Promise(r => setTimeout(r, 50));

	// Measure direct function call
	const directIterations = 500_000;
	const ctx = {
		user: ws.getUserData(),
		ws,
		platform,
		publish: platform.publish,
		cursor: null,
		throttle: () => {},
		debounce: () => {},
		signal: () => {},
		batch: () => {}
	};

	const directStart = performance.now();
	for (let i = 0; i < directIterations; i++) {
		await echoFn(ctx, 'hello');
	}
	const directMs = performance.now() - directStart;
	const directNsPerOp = (directMs * 1e6) / directIterations;

	// Measure handleRpc dispatch sequentially (same concurrency as direct calls).
	// Each iteration sends one RPC and waits for the response before sending the next.
	const dispatchIterations = 100_000;
	const bufs = [];
	for (let i = 0; i < dispatchIterations; i++) {
		bufs.push(encodeRpc('bench/echo', String(i), ['hello']));
	}

	const dispatchStart = performance.now();
	for (let i = 0; i < dispatchIterations; i++) {
		await new Promise(resolve => {
			platform.send = () => { resolve(); return 1; };
			handleRpc(ws, bufs[i], platform);
		});
	}
	platform.send = () => 1;
	const dispatchMs = performance.now() - dispatchStart;
	const dispatchNsPerOp = (dispatchMs * 1e6) / dispatchIterations;

	console.log('--- RPC dispatch overhead ---');
	console.log(`Direct function call:     ${formatNs(directNsPerOp)}/op  (${formatOps(directIterations / (directMs / 1000))})`);
	console.log(`handleRpc dispatch:       ${formatNs(dispatchNsPerOp)}/op  (${formatOps(dispatchIterations / (dispatchMs / 1000))})`);
	console.log(`Overhead per call:        ~${formatNs(dispatchNsPerOp - directNsPerOp)}`);
	console.log(`Overhead ratio:           ${(dispatchNsPerOp / directNsPerOp).toFixed(1)}x`);
	console.log();
}

// ---------------------------------------------------------------------------
// 2. Stream merge throughput
// ---------------------------------------------------------------------------

// Simulate the merge logic from client.js without store/subscriber overhead.
// This isolates the merge algorithm performance.

function benchCrudMerge(arraySize) {
	const key = 'id';
	let arr = Array.from({ length: arraySize }, (_, i) => ({ id: i, text: 'item ' + i }));
	// Build index map (mirrors client.js _rebuildIndex)
	const index = new Map();
	for (let i = 0; i < arr.length; i++) index.set(arr[i][key], i);

	function rebuildIndex() {
		index.clear();
		for (let i = 0; i < arr.length; i++) index.set(arr[i][key], i);
	}

	const iterations = 100_000;
	const start = performance.now();

	for (let i = 0; i < iterations; i++) {
		const op = i % 3;
		if (op === 0) {
			// created
			const item = { id: arraySize + i, text: 'new' };
			const idx = index.get(item[key]);
			if (idx !== undefined) {
				arr[idx] = item;
			} else {
				index.set(item[key], arr.length);
				arr.push(item);
			}
		} else if (op === 1) {
			// updated
			const targetId = i % arraySize;
			const item = { id: targetId, text: 'updated' };
			const idx = index.get(item[key]);
			if (idx !== undefined) arr[idx] = item;
		} else {
			// deleted (swap-remove) -- then re-add to keep size stable
			const targetId = i % arraySize;
			const idx = index.get(targetId);
			if (idx !== undefined) {
				index.delete(targetId);
				const last = arr.length - 1;
				if (idx < last) {
					const swapped = arr[last];
					arr[idx] = swapped;
					index.set(swapped[key], idx);
				}
				arr.length = last;
			}
			index.set(targetId, arr.length);
			arr.push({ id: targetId, text: 'restored' });
		}
		arr = arr.slice();
	}

	const ms = performance.now() - start;
	return { iterations, ms, opsPerSec: iterations / (ms / 1000) };
}

function benchLatestMerge(maxItems) {
	let arr = [];
	const iterations = 200_000;
	const start = performance.now();

	for (let i = 0; i < iterations; i++) {
		arr.push({ id: i, value: i });
		if (arr.length > maxItems) {
			arr.splice(0, arr.length - maxItems);
		}
		arr = arr.slice();
	}

	const ms = performance.now() - start;
	return { iterations, ms, opsPerSec: iterations / (ms / 1000) };
}

function benchSetMerge() {
	let value = null;
	const iterations = 1_000_000;
	const data = Array.from({ length: 100 }, (_, i) => ({ id: i, value: i }));
	const start = performance.now();

	for (let i = 0; i < iterations; i++) {
		value = data[i % data.length];
	}

	const ms = performance.now() - start;
	return { iterations, ms, opsPerSec: iterations / (ms / 1000) };
}

function benchPresenceMerge(arraySize) {
	let arr = Array.from({ length: arraySize }, (_, i) => ({ key: 'user' + i, name: 'User ' + i }));
	const index = new Map();
	for (let i = 0; i < arr.length; i++) index.set(arr[i].key, i);

	function rebuildIndex() {
		index.clear();
		for (let i = 0; i < arr.length; i++) index.set(arr[i].key, i);
	}

	const iterations = 100_000;
	const start = performance.now();

	for (let i = 0; i < iterations; i++) {
		const op = i % 3;
		if (op === 0 || op === 1) {
			// join (upsert)
			const item = { key: 'user' + (i % arraySize), name: 'Updated ' + i };
			const idx = index.get(item.key);
			if (idx !== undefined) {
				arr[idx] = item;
			} else {
				index.set(item.key, arr.length);
				arr.push(item);
			}
		} else {
			// leave (swap-remove) then re-join to keep size stable
			const targetKey = 'user' + (i % arraySize);
			const idx = index.get(targetKey);
			if (idx !== undefined) {
				index.delete(targetKey);
				const last = arr.length - 1;
				if (idx < last) {
					const swapped = arr[last];
					arr[idx] = swapped;
					index.set(swapped.key, idx);
				}
				arr.length = last;
			}
			index.set(targetKey, arr.length);
			arr.push({ key: targetKey, name: 'Rejoined' });
		}
		arr = arr.slice();
	}

	const ms = performance.now() - start;
	return { iterations, ms, opsPerSec: iterations / (ms / 1000) };
}

function benchCursorMerge(arraySize) {
	let arr = Array.from({ length: arraySize }, (_, i) => ({ key: 'conn' + i, x: 0, y: 0 }));
	const index = new Map();
	for (let i = 0; i < arr.length; i++) index.set(arr[i].key, i);

	const iterations = 200_000;
	const start = performance.now();

	for (let i = 0; i < iterations; i++) {
		// update (most common for cursors)
		const item = { key: 'conn' + (i % arraySize), x: i, y: i * 2 };
		const idx = index.get(item.key);
		if (idx !== undefined) {
			arr[idx] = item;
		} else {
			index.set(item.key, arr.length);
			arr.push(item);
		}
		arr = arr.slice();
	}

	const ms = performance.now() - start;
	return { iterations, ms, opsPerSec: iterations / (ms / 1000) };
}

async function benchMergeStrategies() {
	console.log('--- Stream merge throughput ---');
	console.log();

	const sizes = [10, 100, 1000];

	console.log('crud merge:');
	for (const size of sizes) {
		const r = benchCrudMerge(size);
		console.log(`  ${size} items:`.padEnd(16) + formatOps(r.opsPerSec).padStart(14) + `  (${r.ms.toFixed(0)}ms for ${(r.iterations / 1000)}K ops)`);
	}
	console.log();

	console.log('latest merge:');
	for (const max of [50, 100, 500]) {
		const r = benchLatestMerge(max);
		console.log(`  max ${max}:`.padEnd(16) + formatOps(r.opsPerSec).padStart(14) + `  (${r.ms.toFixed(0)}ms for ${(r.iterations / 1000)}K ops)`);
	}
	console.log();

	console.log('set merge:');
	{
		const r = benchSetMerge();
		console.log(`  replace:`.padEnd(16) + formatOps(r.opsPerSec).padStart(14) + `  (${r.ms.toFixed(0)}ms for ${(r.iterations / 1000)}K ops)`);
	}
	console.log();

	console.log('presence merge:');
	for (const size of [10, 50, 200]) {
		const r = benchPresenceMerge(size);
		console.log(`  ${size} users:`.padEnd(16) + formatOps(r.opsPerSec).padStart(14) + `  (${r.ms.toFixed(0)}ms for ${(r.iterations / 1000)}K ops)`);
	}
	console.log();

	console.log('cursor merge:');
	for (const size of [5, 20, 100]) {
		const r = benchCursorMerge(size);
		console.log(`  ${size} cursors:`.padEnd(16) + formatOps(r.opsPerSec).padStart(14) + `  (${r.ms.toFixed(0)}ms for ${(r.iterations / 1000)}K ops)`);
	}
	console.log();
}

// ---------------------------------------------------------------------------
// 3. handleRpc fast-path rejection (non-RPC messages)
// ---------------------------------------------------------------------------

async function benchFastReject() {
	const ws = createMockWs({ id: 'user1' });
	const platform = createMockPlatform();

	// Various non-RPC payloads
	const nonRpc = [
		textEncoder.encode('plain text message').buffer,
		textEncoder.encode('{"type":"custom","data":123}').buffer,
		new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer,
		textEncoder.encode('{"some":"json","not":"rpc"}').buffer,
	];

	const iterations = 500_000;
	const start = performance.now();

	for (let i = 0; i < iterations; i++) {
		handleRpc(ws, nonRpc[i & 3], platform);
	}

	const ms = performance.now() - start;
	const nsPerOp = (ms * 1e6) / iterations;

	console.log('--- Fast-path rejection (non-RPC messages) ---');
	console.log(`Non-RPC rejection:        ${formatNs(nsPerOp)}/op  (${formatOps(iterations / (ms / 1000))})`);
	console.log();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('svelte-realtime benchmarks');
console.log('='.repeat(50));
console.log();

await benchFastReject();
await benchRpcDispatch();
await benchMergeStrategies();

console.log('Done.');
