// A Vite dev server must not serve the generated live-registry to
// the client graph. An anonymous HTTP client (vite --host, or DNS rebinding
// against a localhost dev server) could otherwise enumerate every registered
// RPC / stream / cron / webhook path and read the dev machine's absolute
// paths via /@fs URLs. The SSR (server) graph must still resolve it - the
// registry load on 'listening' and the hooks.ws co-location import depend on
// it. Verified against a real Vite dev server, both directions.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import svelteRealtime from '../src/vite.js';

const testRoot = resolve(import.meta.dirname, '__registry_dev_fixtures__');

function setup() {
	mkdirSync(resolve(testRoot, 'src/live'), { recursive: true });
	writeFileSync(
		resolve(testRoot, 'src/live/counter.js'),
		`import { live } from 'svelte-realtime/server';
export const increment = live((ctx) => 1);
export const counter = live.stream('count', () => 0, { merge: 'set' });
`
	);
}

function teardown() {
	if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
}

describe('dev server registry exposure', () => {
	afterEach(teardown);

	it('denies the registry to the client graph but still resolves it for SSR', async () => {
		setup();
		const server = await createServer({
			root: testRoot,
			logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0 },
			plugins: [svelteRealtime()]
		});
		try {
			await server.listen();
			const port = server.httpServer.address().port;
			const base = `http://127.0.0.1:${port}`;

			// Client graph, anonymous HTTP: the registry module is not served.
			for (const url of ['/@svelte-realtime-registry', '/@svelte-realtime-registry?import']) {
				const res = await fetch(base + url);
				const body = await res.text();
				expect(res.status).toBe(404);
				expect(body).not.toContain('__register');
				expect(body).not.toContain('counter/increment');
			}

			// SSR graph: the registry still resolves and generates, so the
			// server-side registration paths (listening load, hooks.ws
			// co-location import) keep working.
			const ssr = await server.transformRequest('/@svelte-realtime-registry', { ssr: true });
			expect(ssr).toBeTruthy();
			// (SSR transform wraps the imports, so match the path literals,
			// not the bare `__register("..."` call shape.)
			expect(ssr.code).toContain('"counter/increment"');
			expect(ssr.code).toContain('"counter/counter"');
		} finally {
			await server.close();
		}
	}, 30000);
});
