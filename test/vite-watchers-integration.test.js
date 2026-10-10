import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import svelteRealtime from '../src/vite.js';

it('keeps nested repositories isolated while actual Vite add and unlink reload owned handlers', async () => {
	const root = mkdtempSync(join(tmpdir(), 'realtime-vite-integration-'));
	const source = fileURLToPath(new URL('../src/', import.meta.url));
	const liveDir = join(root, 'src/live');
	mkdirSync(liveDir, { recursive: true });
	const moduleSource = "import { live } from 'svelte-realtime/server'; export const send = live(async () => 'ready');";
	writeFileSync(join(liveDir, 'chat.js'), moduleSource);
	let server;
	const errors = [];
	try {
		server = await createServer({
			root, configFile: false, cacheDir: join(root, '.vite'),
			customLogger: { info() {}, warn() {}, warnOnce() {}, error(message) { errors.push(message); }, clearScreen() {}, hasErrorLogged() { return false; }, hasWarned: false },
			server: { host: '127.0.0.1', port: 0, fs: { allow: [root, resolve(source, '..')] } },
			optimizeDeps: { noDiscovery: true },
			resolve: { alias: {
				'svelte-realtime/server': join(source, 'server.js'),
				'svelte-realtime/client': join(source, 'client.js')
			} },
			plugins: [svelteRealtime({ devtools: false, typedImports: false })]
		});
		await server.listen();
		const runtime = await server.ssrLoadModule('svelte-realtime/server');
		const paths = () => runtime.introspect({ handlers: true }).handlers.paths;
		await expect.poll(paths, { timeout: 10000 }).toEqual(['chat/send']);
		const loaded = [];
		const load = server.ssrLoadModule.bind(server);
		server.ssrLoadModule = async (...args) => { loaded.push(args[0]); return load(...args); };
		const foreign = join(root, '.claude/worktrees/other/src/live/foreign.js');
		mkdirSync(resolve(foreign, '..'), { recursive: true });
		await new Promise((resolve, reject) => {
			const finish = (error) => {
				clearTimeout(timer);
				server.watcher.off('add', added);
				error ? reject(error) : resolve();
			};
			const added = file => { if (file.replaceAll('\\', '/') === foreign.replaceAll('\\', '/')) finish(); };
			const timer = setTimeout(() => finish(new Error('Nested file was not observed by the Vite watcher')), 10000);
			server.watcher.on('add', added);
			try { writeFileSync(foreign, moduleSource); } catch (error) { finish(error); }
		});
		// Drain watcher callbacks before inspecting the SSR work they scheduled.
		await new Promise(resolve => setImmediate(resolve));
		expect(loaded).not.toContain('/@svelte-realtime-registry');
		expect(paths()).toEqual(['chat/send']);
		writeFileSync(join(liveDir, 'chat.js'), moduleSource.replace('const send', 'const updated'));
		await expect.poll(paths, { timeout: 10000 }).toEqual(['chat/updated']);
		const owned = join(liveDir, 'added.js');
		writeFileSync(owned, moduleSource);
		await expect.poll(paths, { timeout: 10000 }).toEqual(['added/send', 'chat/updated']);
		unlinkSync(owned);
		await expect.poll(paths, { timeout: 10000 }).toEqual(['chat/updated']);
		expect(errors).toEqual([]);
	} finally {
		await server?.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);
