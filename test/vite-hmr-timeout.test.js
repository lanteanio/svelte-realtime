import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import realtime from '../src/vite.js';

it('bounds caller waits while a late real Vite import stays ahead of every newer registry write', async () => {
	const root = mkdtempSync(join(tmpdir(), 'realtime-hmr-timeout-'));
	const source = fileURLToPath(new URL('../src/', import.meta.url));
	const liveDir = join(root, 'src/live');
	mkdirSync(liveDir, { recursive: true });
	const file = join(liveDir, 'count.js');
	const moduleSource = name => `// realtime-allow-public\nimport { live } from 'svelte-realtime/server'; export const ${name} = live(() => '${name}');`;
	writeFileSync(file, moduleSource('initial'));
	const key = '__realtimeHmr' + randomUUID().replaceAll('-', '');
	let release;
	globalThis[key] = { armed: false, entered: false, promise: new Promise(resolve => { release = resolve; }) };
	let server, clock;
	const pending = [], timers = [];
	const outcomes = [];
	try {
		const plugin = realtime({ devtools: false, typedImports: false });
		const hotUpdate = plugin.handleHotUpdate;
		plugin.handleHotUpdate = (...args) => {
			const work = hotUpdate(...args);
			pending.push(work.catch(() => {}));
			work.then(() => outcomes.push('completed'), error => outcomes.push(error.message));
			return work;
		};
		server = await createServer({ root, configFile: false, cacheDir: join(root, '.vite'), logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0, fs: { allow: [root, resolve(source, '..')] } },
			optimizeDeps: { noDiscovery: true },
			resolve: { alias: { 'svelte-realtime/server': join(source, 'server.js'), 'svelte-realtime/client': join(source, 'client.js') } },
			plugins: [plugin, { name: 'test-held-registry', enforce: 'post', transform(code, id) {
				if (id === '\0live:__registry' && globalThis[key].armed) {
					return `globalThis[${JSON.stringify(key)}].entered = true; await globalThis[${JSON.stringify(key)}].promise;\n` + code;
				}
			} }] });
		await server.listen();
		const runtime = await server.ssrLoadModule('svelte-realtime/server');
		const paths = () => runtime.introspect({ handlers: true }).handlers.paths;
		await expect.poll(paths, { timeout: 10000 }).toEqual(['count/initial']);
		const nativeTimeout = globalThis.setTimeout;
		clock = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay, ...args) => {
			if (delay !== 30000) return nativeTimeout(fn, delay, ...args);
			const handle = nativeTimeout(() => {}, 60000);
			timers.push({ fire: () => fn(...args), handle });
			return handle;
		});
		globalThis[key].armed = true;
		writeFileSync(file, moduleSource('late'));
		await expect.poll(() => globalThis[key].entered, { timeout: 10000 }).toBe(true);
		writeFileSync(file, moduleSource('newer'));
		await expect.poll(() => pending.length).toBe(2);
		expect(timers).toHaveLength(2);
		for (const timer of timers) timer.fire();
		await expect.poll(() => outcomes.length).toBe(2);
		expect(outcomes.every(message => /timed out.*queue.*import/i.test(message))).toBe(true);
		await expect(plugin.handleHotUpdate({ file, server })).rejects.toThrow(/waiting.*import/i);
		expect(paths()).not.toContain('count/newer');
		const log = vi.spyOn(console, 'log');
		release();
		await expect.poll(paths, { timeout: 10000 }).toEqual(['count/late']);
		// The late reload settles after it also loads the edited module; until then
		// the queue still refuses newer work.
		await expect.poll(() => log.mock.calls.some(([line]) => String(line).includes('Hot-reloaded')), { timeout: 10000 }).toBe(true);
		log.mockRestore();
		globalThis[key].armed = false;
		writeFileSync(file, moduleSource('newer') + '\n');
		await expect.poll(paths, { timeout: 10000 }).toEqual(['count/newer']);
		await new Promise(resolve => setImmediate(resolve));
		expect(paths()).toEqual(['count/newer']);
	} finally {
		release();
		await Promise.all(pending);
		clock?.mockRestore();
		for (const timer of timers) clearTimeout(timer.handle);
		await server?.close();
		delete globalThis[key];
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);
