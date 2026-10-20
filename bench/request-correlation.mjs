// Run with: node bench/request-correlation.mjs
// Compare full context construction and inherited platform reads. The direct
// reference is a cost floor: it cannot carry an isolated operation request id.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'src/server/ctx.js');
const source = readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n')
	.replaceAll(/from '(\.[^']+)'/g, (_, name) => `from '${pathToFileURL(resolve(dirname(sourcePath), name)).href}'`);
const projection = 'contextPlatform = { __proto__: platform, requestId, connectionId };';
if (source.split(projection).length !== 2) throw new Error('Context projection changed; update the benchmark variants.');
const variants = {
	'operation-fields': source,
	'descriptor-projection': source.replace(projection, `contextPlatform = Object.create(platform);
		Object.defineProperties(contextPlatform, {
			requestId: { value: requestId, enumerable: true },
			connectionId: { value: connectionId, enumerable: true }
		});`),
	'direct-reference': source.replace(projection, 'contextPlatform = platform;')
};
const helpers = { publish() {}, batch() {} };
const platforms = Array.from({ length: 32 }, (_, index) => ({ requestId: 'socket-' + index, counter: index, send() {} }));
const user = { id: 'user' };
const ws = {};
const iterations = 100_000;
const entries = [];
let checksum = 0;
for (const [name, code] of Object.entries(variants)) {
	const { _buildCtx } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
	const run = () => {
		for (let i = 0; i < iterations; i++) {
			const ctx = _buildCtx(user, ws, platforms[i % platforms.length], helpers, null, undefined, 'operation');
			checksum += ctx.platform.counter + ctx.requestId.length;
		}
	};
	for (let i = 0; i < 3; i++) run();
	entries.push({ name, run, samples: [] });
}
for (let round = 0; round < 9; round++) {
	for (const entry of (round % 2 ? [...entries].reverse() : entries)) {
		const start = performance.now();
		entry.run();
		entry.samples.push((performance.now() - start) * 1e6 / iterations);
	}
}
console.log(`Node ${process.version}; ${platforms.length} platforms; ${iterations} calls per sample`);
for (const entry of entries) {
	entry.samples.sort((a, b) => a - b);
	console.log(`${entry.name}: median ${entry.samples[4].toFixed(1)} ns, minimum ${entry.samples[0].toFixed(1)} ns`);
}
console.log(`checksum: ${checksum}`);
