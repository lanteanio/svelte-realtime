// @ts-check
//
// Bench for the ctx.publish hot path. Measures raw throughput of the
// helper closure returned by _getCtxHelpers, both for the default
// pass-through path and (when present) for the coalesceBy fan-out path.
//
// Run with: node bench/publish.js
//

import { live, __register, handleRpc } from '../server.js';

const textEncoder = new TextEncoder();

function createMockWs(userData) {
	const subs = new Set();
	return {
		getUserData: () => userData,
		subscribe(topic) { subs.add(topic); return true; },
		unsubscribe(topic) { subs.delete(topic); return true; },
		isSubscribed(topic) { return subs.has(topic); },
		getTopics() { return [...subs]; },
		_subs: subs
	};
}

function createMockPlatform() {
	return {
		connections: 1,
		published: 0,
		coalesced: 0,
		publish() { this.published++; return true; },
		send() { return 1; },
		sendCoalesced() { this.coalesced++; return true; },
		sendTo() { return 0; },
		subscribers() { return 0; },
		topic() { return { publish: () => true }; }
	};
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

// We need the helpers internally; the cleanest route is via a registered
// live function that publishes. Each handleRpc -> handler pays one
// publish call.
const publisher = live(async (ctx) => {
	ctx.publish('plain:topic', 'updated', { v: 1 });
	return 0;
});
__register('bench/publish', publisher);

async function benchPublishViaRpc() {
	const ws = createMockWs({ id: 'u1' });
	const platform = createMockPlatform();

	for (let i = 0; i < 1000; i++) {
		const buf = textEncoder.encode(JSON.stringify({ rpc: 'bench/publish', id: 'w' + i, args: [] })).buffer;
		platform.send = () => 1;
		handleRpc(ws, buf, platform);
	}
	await new Promise(r => setTimeout(r, 50));

	const iterations = 100_000;
	const bufs = [];
	for (let i = 0; i < iterations; i++) {
		bufs.push(textEncoder.encode(JSON.stringify({ rpc: 'bench/publish', id: String(i), args: [] })).buffer);
	}
	platform.published = 0;
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		await new Promise(resolve => {
			platform.send = () => { resolve(); return 1; };
			handleRpc(ws, bufs[i], platform);
		});
	}
	platform.send = () => 1;
	const ms = performance.now() - start;
	const nsPerOp = (ms * 1e6) / iterations;

	console.log('--- handleRpc -> handler -> ctx.publish (plain topic, no coalesce registry hit) ---');
	console.log(`  ${formatNs(nsPerOp)}/op  (${formatOps(iterations / (ms / 1000))})`);
	console.log(`  publish calls: ${platform.published}, coalesced: ${platform.coalesced}`);
	console.log();
}

console.log('svelte-realtime publish microbench');
console.log('='.repeat(50));
console.log();

await benchPublishViaRpc();

console.log('Done.');
