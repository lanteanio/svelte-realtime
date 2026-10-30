// Run with Node 24+: node bench/background-work.mjs [root ...]
// Measures effect dispatch (one sync handler, one async handler, four sync
// handlers on one topic) in bursts of 16 publishes, an async handler in bursts
// of 64 (past the default 32 concurrent calls, so half of each burst waits in
// the effect's queue), and outbound webhook delivery to a local endpoint,
// each with live.metrics off and on. Every root is a package root to compare
// (default: this checkout); runs alternate between roots. Reports the median
// over runs of each run's best pass, in ns per event, for the whole dispatch
// and for the synchronous publish call.
// BENCH_ROUNDS (default 7) and BENCH_ONLY=effect-sync:off,... narrow a run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const SCENARIOS = ['effect-sync', 'effect-async', 'effect-async-burst', 'effect4-sync', 'webhook'];

if (!args[0] || !args[0].includes(':')) {
	const roots = (args.length ? args : [resolve(here, '../..')]).map((r) => resolve(r));
	const rounds = Number(process.env.BENCH_ROUNDS) || 7;
	const only = process.env.BENCH_ONLY ? process.env.BENCH_ONLY.split(',') : null;
	/** @type {Record<string, { total: number[], publish: number[] }>} */
	const rows = {};
	for (let round = 0; round < rounds; round++) {
		for (const scenario of SCENARIOS) {
			for (const metrics of ['off', 'on']) {
				const key = scenario + ':' + metrics;
				if (only && !only.includes(key)) continue;
				for (const root of roots) {
					const child = spawnSync(process.execPath, [here, key, root], { encoding: 'utf8', timeout: 120000 });
					if (child.status !== 0) throw new Error(key + ' ' + root + ': ' + (child.stderr || child.stdout || child.error));
					const [total, publish] = child.stdout.trim().split(' ').map(Number);
					const row = (rows[root + '|' + key] ||= { total: [], publish: [] });
					row.total.push(total);
					row.publish.push(publish);
				}
			}
		}
	}
	const median = (v) => v.sort((a, b) => a - b)[v.length >> 1];
	console.log('scenario'.padEnd(18) + roots.map((r, i) => ('total[' + i + ']').padStart(12) + ('publish[' + i + ']').padStart(12)).join(''));
	for (const scenario of SCENARIOS) {
		for (const metrics of ['off', 'on']) {
			const key = scenario + ':' + metrics;
			if (!rows[roots[0] + '|' + key]) continue;
			console.log(key.padEnd(18) + roots.map((r) => {
				const row = rows[r + '|' + key];
				return median(row.total).toFixed(0).padStart(12) + median(row.publish).toFixed(0).padStart(12);
			}).join(''));
		}
	}
	roots.forEach((r, i) => console.log('[' + i + '] ' + r));
} else {
	const [scenario, metricsMode] = args[0].split(':');
	const root = pathToFileURL(resolve(args[1]) + '/').href;
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
	let total;
	let publish = 0;

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
		// Bursts of 32 that every tree delivers at once, so no tree queues or
		// opens thousands of sockets.
		const run = async (n) => {
			for (let sent = 0; sent < n; sent += 32) {
				const target = received + 32;
				const t0 = performance.now();
				for (let i = 0; i < 32; i++) env.platform.publish('bench', 'created', { i });
				publish += performance.now() - t0;
				const deadline = performance.now() + 10000;
				while (received < target) {
					if (performance.now() > deadline) throw new Error('webhook deliveries stalled');
					await new Promise((r) => setImmediate(r));
				}
			}
		};
		await run(640);
		publish = 0;
		const n = 3200;
		const start = performance.now();
		await run(n);
		total = (performance.now() - start) * 1e6 / n;
		publish = publish * 1e6 / n;
		srv.closeAllConnections();
		srv.close();
	} else {
		let calls = 0;
		const sync = () => { calls++; };
		const handlers = scenario.startsWith('effect-async') ? [() => { calls++; return Promise.resolve(); }]
			: scenario === 'effect4-sync' ? [sync, sync, sync, sync] : [sync];
		const module = {};
		handlers.forEach((fn, i) => { module['effect' + i] = live.effect(['bench'], fn); });
		env.register('bench', module);
		const burst = scenario === 'effect-async-burst' ? 64 : 16;
		const run = async (n) => {
			for (let i = 0; i < n; i += burst) {
				const t0 = performance.now();
				for (let j = 0; j < burst; j++) env.platform.publish('bench', 'created', i + j);
				publish += performance.now() - t0;
				await flush();
			}
			await flush();
		};
		await run(20480);
		// The best of five passes: the cost of the code, not of a GC pause or
		// a scheduler hiccup that lands in one of them.
		total = Infinity;
		let best = Infinity;
		const n = 40960;
		for (let pass = 0; pass < 5; pass++) {
			calls = 0;
			publish = 0;
			const start = performance.now();
			await run(n);
			total = Math.min(total, (performance.now() - start) * 1e6 / n);
			best = Math.min(best, publish * 1e6 / n);
			assert.equal(calls, n * handlers.length);
		}
		publish = best;
	}
	env.cleanup();
	process.stdout.write(total + ' ' + publish);
	process.exit(0);
}
