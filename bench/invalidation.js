// @ts-check
//
// Bench for the _topicInvalidationWatch publish hot path. Measures the
// per-publish cost when N invalidateOn patterns are registered. The OLD
// implementation called regex.test on every entry; the NEW one fast-fails
// with topic.startsWith and skips the regex entirely on `prefix*` shapes.
//
// Three scenarios:
//   1. baseline: zero registered watchers (size-zero short-circuit)
//   2. miss-all: N watchers registered, publish topic matches none of them
//   3. hit-one:  N watchers registered, publish topic matches exactly one
//
// Run with: node bench/invalidation.js
//

import { live, __register, handleRpc, _resetInvalidationWatch } from '../server.js';

const textEncoder = new TextEncoder();

function createMockWs(userData) {
	const subs = new Set();
	return {
		getUserData: () => userData,
		subscribe(topic) { subs.add(topic); return true; },
		unsubscribe(topic) { subs.delete(topic); return true; },
		isSubscribed(topic) { return subs.has(topic); },
		getTopics() { return [...subs]; }
	};
}

function createMockPlatform() {
	return {
		connections: 1,
		published: 0,
		publish() { this.published++; return true; },
		send() { return 1; },
		sendCoalesced() { return true; },
		sendTo() { return 0; },
		subscribers() { return 0; }
	};
}

function formatNs(ns) {
	if (ns < 1000) return ns.toFixed(0) + 'ns';
	if (ns < 1e6) return (ns / 1000).toFixed(1) + 'us';
	return (ns / 1e6).toFixed(2) + 'ms';
}

function formatOps(ops) {
	if (ops >= 1e6) return (ops / 1e6).toFixed(2) + 'M ops/s';
	if (ops >= 1e3) return (ops / 1e3).toFixed(1) + 'K ops/s';
	return ops.toFixed(0) + ' ops/s';
}

const N_PATTERNS = 20;
const ITERATIONS = 200_000;

async function runScenario(label, setup, publishTopic) {
	_resetInvalidationWatch();

	// Each scenario uses its own publisher so the registry doesn't carry
	// state between runs. We register N stream functions that each carry
	// their own invalidateOn patterns (forces the registry to populate).
	for (let i = 0; i < N_PATTERNS; i++) {
		const stream = live.stream(`bench/sink-${i}`, async () => [], {
			merge: 'crud',
			key: 'id',
			invalidateOn: [setup(i)]
		});
		__register(`bench/sink-${i}`, stream);
	}

	const publisher = live(async (ctx) => {
		ctx.publish(publishTopic, 'updated', { id: 1 });
		return 0;
	});
	__register('bench/inv-pub', publisher);

	const ws = createMockWs({ id: 'u1' });
	const platform = createMockPlatform();

	// Subscribe to all the streams so the watchers are armed (init runs).
	for (let i = 0; i < N_PATTERNS; i++) {
		const buf = textEncoder.encode(JSON.stringify({ rpc: `bench/sink-${i}`, id: 'sub' + i, args: [], stream: true })).buffer;
		await new Promise(resolve => {
			platform.send = () => { resolve(); return 1; };
			handleRpc(ws, buf, platform);
		});
	}
	platform.send = () => 1;

	// Warmup
	for (let i = 0; i < 1000; i++) {
		const buf = textEncoder.encode(JSON.stringify({ rpc: 'bench/inv-pub', id: 'w' + i, args: [] })).buffer;
		handleRpc(ws, buf, platform);
	}
	await new Promise(r => setTimeout(r, 50));

	const bufs = [];
	for (let i = 0; i < ITERATIONS; i++) {
		bufs.push(textEncoder.encode(JSON.stringify({ rpc: 'bench/inv-pub', id: String(i), args: [] })).buffer);
	}

	platform.published = 0;
	const start = performance.now();
	for (let i = 0; i < ITERATIONS; i++) {
		await new Promise(resolve => {
			platform.send = () => { resolve(); return 1; };
			handleRpc(ws, bufs[i], platform);
		});
	}
	platform.send = () => 1;
	const ms = performance.now() - start;
	const nsPerOp = (ms * 1e6) / ITERATIONS;
	const opsPerSec = ITERATIONS / (ms / 1000);

	console.log(`--- ${label} ---`);
	console.log(`  ${formatNs(nsPerOp)}/op  (${formatOps(opsPerSec)})`);
	console.log(`  publish calls observed: ${platform.published}`);
	console.log();
}

console.log('svelte-realtime invalidation-watch microbench');
console.log('='.repeat(50));
console.log(`  patterns: ${N_PATTERNS}, iterations: ${ITERATIONS}`);
console.log();

_resetInvalidationWatch();
{
	const publisher = live(async (ctx) => {
		ctx.publish('plain:topic', 'updated', { v: 1 });
		return 0;
	});
	__register('bench/baseline-pub', publisher);
	const ws = createMockWs({ id: 'u1' });
	const platform = createMockPlatform();
	for (let i = 0; i < 1000; i++) {
		const buf = textEncoder.encode(JSON.stringify({ rpc: 'bench/baseline-pub', id: 'w' + i, args: [] })).buffer;
		handleRpc(ws, buf, platform);
	}
	await new Promise(r => setTimeout(r, 50));
	const bufs = [];
	for (let i = 0; i < ITERATIONS; i++) {
		bufs.push(textEncoder.encode(JSON.stringify({ rpc: 'bench/baseline-pub', id: String(i), args: [] })).buffer);
	}
	platform.published = 0;
	const start = performance.now();
	for (let i = 0; i < ITERATIONS; i++) {
		await new Promise(resolve => {
			platform.send = () => { resolve(); return 1; };
			handleRpc(ws, bufs[i], platform);
		});
	}
	const ms = performance.now() - start;
	const nsPerOp = (ms * 1e6) / ITERATIONS;
	console.log('--- baseline-true: 0 watchers, size-zero short-circuit ---');
	console.log(`  ${formatNs(nsPerOp)}/op  (${formatOps(ITERATIONS / (ms / 1000))})`);
	console.log();
}

await runScenario(
	`miss-all: ${N_PATTERNS} prefix* watchers, topic matches none`,
	(i) => `audit-${i}:*`,
	'unrelated:topic'
);

await runScenario(
	`hit-one: ${N_PATTERNS} prefix* watchers, topic matches one`,
	(i) => `audit-${i}:*`,
	'audit-7:user/42'
);

console.log('Done.');
