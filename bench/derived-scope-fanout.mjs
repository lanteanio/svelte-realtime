// Run with Node 24+: node bench/derived-scope-fanout.mjs
// Measures real derived dispatch to 1,000 custom-scope subscribers. The uncached
// loader variant rebuilds the public scope context for every authorization check.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!mode) {
	for (const variant of ['cached', 'uncached', 'uncached', 'cached']) {
		const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), variant], { encoding: 'utf8' });
		if (child.status !== 0) throw new Error(child.stderr || child.stdout);
		console.log(child.stdout.trim());
	}
} else {
	assert.ok(mode === 'cached' || mode === 'uncached');
	let replacements = 0;
	if (mode === 'uncached') registerHooks({ load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		if (!url.endsWith('/src/server/reactive.js')) return result;
		const source = String(result.source);
		const start = source.indexOf('ctx = subscriber.scopeCtx;');
		const end = source.indexOf('ctx.trace = platform?.trace ?? null;', start);
		assert.ok(start >= 0 && end > start, 'scope cache block must exist');
		replacements++;
		return { ...result, source: source.slice(0, start) +
			'ctx = _buildCtx(user || null, ws, platform, _getCtxHelpers(platform), null);' +
			source.slice(end + 'ctx.trace = platform?.trace ?? null;'.length) };
	} });
	const { live, _prepareHmr } = await import('../src/server.js');
	const { createTestEnv } = await import('../src/testing.js');
	const env = createTestEnv();
	const streams = [];
	let generation = 0, scopeChecks = 0;
	try {
		const derived = live.derived(() => ['bench-source'], () => generation, {
			scopeKey: ctx => { scopeChecks++; return ctx.user.group; }
		});
		env.register('bench', { derived });
		for (let i = 0; i < 1000; i++) {
			const stream = env.connect({ id: String(i), group: 'shared' }).subscribe('bench/derived');
			await stream.waitFor(() => true);
			streams.push(stream);
		}
		assert.equal(new Set(streams.map(stream => stream.topic)).size, 1);
		async function sample(iterations) {
			for (const stream of streams) stream.events.length = 0;
			scopeChecks = 0;
			const start = performance.now();
			for (let i = 0; i < iterations; i++) {
				generation++;
				env.platform.publish('bench-source', 'set', generation);
				for (let j = 0; j < 4; j++) await Promise.resolve();
			}
			const ns = (performance.now() - start) * 1e6 / iterations;
			assert.equal(scopeChecks, iterations * 1001, 'each delivery rechecks every recipient');
			for (const stream of streams) {
				assert.equal(stream.events.length, iterations, 'every source event reaches every subscriber');
				assert.equal(stream.value, generation, 'the latest computed result is delivered');
			}
			return ns;
		}
		await sample(100);
		const samples = [];
		for (let i = 0; i < 9; i++) samples.push(await sample(100));
		samples.sort((a, b) => a - b);
		assert.equal(replacements, mode === 'uncached' ? 1 : 0);
		console.log(JSON.stringify({ mode, subscribers: 1000, eventsPerSample: 100, samples: 9,
			medianNs: samples[4], minNs: samples[0], maxNs: samples[8], node: process.version }));
	} finally { env.cleanup(); _prepareHmr(); }
}
