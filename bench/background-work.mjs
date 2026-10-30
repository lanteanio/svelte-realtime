// Run with Node 24+: node bench/background-work.mjs [root]
// BENCH_ROUNDS (default 5) and BENCH_ONLY=effect-sync:off,... narrow a run.
// Measures effect dispatch (sync and async handlers) and outbound webhook
// delivery to a local endpoint, each with live.metrics off and on. `root`
// points at another checkout's package root to compare two trees.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, Agent } from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(import.meta.url);
const [variant, rootArg] = process.argv.slice(2);
const SCENARIOS = ['effect-sync', 'effect-async', 'webhook'];

if (!variant || !variant.includes(':')) {
	const root = resolve(variant || resolve(here, '../..'));
	const rounds = Number(process.env.BENCH_ROUNDS) || 5;
	const only = process.env.BENCH_ONLY ? process.env.BENCH_ONLY.split(',') : null;
	const rows = {};
	for (let round = 0; round < rounds; round++) {
		for (const scenario of SCENARIOS) {
			for (const metrics of ['off', 'on']) {
				if (only && !only.includes(scenario + ':' + metrics)) continue;
				const key = scenario + ':' + metrics;
				const child = spawnSync(process.execPath, [here, key, root], { encoding: 'utf8' });
				if (child.status !== 0) throw new Error(child.stderr || child.stdout);
				(rows[key] ||= []).push(Number(child.stdout.trim()));
			}
		}
	}
	console.log('root: ' + root);
	for (const key of Object.keys(rows)) {
		const sorted = rows[key].sort((a, b) => a - b);
		console.log(key.padEnd(20) + ' median ' + sorted[sorted.length >> 1].toFixed(0).padStart(7) + ' ns/event   (' + sorted.map((v) => v.toFixed(0)).join(', ') + ')');
	}
} else {
	const [scenario, metricsMode] = variant.split(':');
	const root = pathToFileURL(resolve(rootArg) + '/').href;
	const server = await import(root + 'src/server.js');
	const { createTestEnv } = await import(root + 'src/testing.js');
	const { createMetrics } = await import('svelte-adapter-uws-extensions/prometheus');
	const { live } = server;
	server.setOperationalEventSink(() => {});
	server.onError(() => {});
	if (metricsMode === 'on') {
		const m = createMetrics();
		live.metrics({
			counter: ({ name, help, labelNames }) => m.counter(name, help, labelNames),
			histogram: ({ name, help, labelNames, buckets }) => m.histogram(name, help, { labelNames, buckets }),
			gauge: ({ name, help, labelNames }) => m.gauge(name, help, labelNames)
		});
	}
	const env = createTestEnv();
	const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

	let ns;
	if (scenario === 'webhook') {
		let received = 0;
		const srv = createServer({ keepAlive: true }, (req, res) => {
			req.resume();
			req.on('end', () => { received++; res.writeHead(200); res.end(); });
		});
		await new Promise((r) => srv.listen(0, '127.0.0.1', r));
		const url = 'http://127.0.0.1:' + srv.address().port + '/hook';
		env.register('hooks', {});
		server.__registerWebhookOut('hooks/bench', live.webhooks.outbound(['bench'], { url, urlMode: 'off', retry: { attempts: 1 } }));
		const run = async (n) => {
			const target = received + n;
			for (let i = 0; i < n; i++) env.platform.publish('bench', 'created', { i });
			while (received < target) await new Promise((r) => setImmediate(r));
		};
		await run(500);
		const n = 4000;
		const start = performance.now();
		await run(n);
		ns = (performance.now() - start) * 1e6 / n;
		srv.closeAllConnections();
		srv.close();
	} else {
		let calls = 0;
		const fn = scenario === 'effect-sync'
			? () => { calls++; }
			: () => { calls++; return Promise.resolve(); };
		env.register('bench', { effect: live.effect(['bench'], fn) });
		const run = async (n) => {
			for (let i = 0; i < n; i++) {
				env.platform.publish('bench', 'created', i);
				if ((i & 63) === 63) await flush();
			}
			await flush();
		};
		await run(20000);
		calls = 0;
		const n = 200000;
		const start = performance.now();
		await run(n);
		ns = (performance.now() - start) * 1e6 / n;
		assert.equal(calls, n);
	}
	env.cleanup();
	process.stdout.write(String(ns));
	process.exit(0);
}
