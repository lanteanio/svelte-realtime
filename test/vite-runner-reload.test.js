import { expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import realtime from '../src/vite.js';

it('refreshes resolved handlers and guards when the SSR runner reloads a route', async () => {
	const root = mkdtempSync(join(tmpdir(), 'realtime-runner-reload-'));
	const packageRoot = fileURLToPath(new URL('../', import.meta.url));
	const installed = join(root, 'node_modules/svelte-realtime');
	mkdirSync(join(root, 'src/live'), { recursive: true });
	mkdirSync(installed, { recursive: true });
	cpSync(join(packageRoot, 'src'), join(installed, 'src'), { recursive: true });
	cpSync(join(packageRoot, 'package.json'), join(installed, 'package.json'));
	symlinkSync(join(packageRoot, 'node_modules'), join(installed, 'node_modules'), 'junction');
	writeFileSync(join(root, 'src/state.js'), 'export const state = { count: 0, id: Math.random(), allowed: true };\n');
	const liveFile = join(root, 'src/live/count.js');
	const liveSource = `// realtime-allow-public
import { live, guard } from 'svelte-realtime/server';
import { state } from '../state.js';
export const _guard = guard(() => { if (!state.allowed) throw new Error('denied'); });
export const counter = live.stream('reload:counter', () => state.count, { merge: 'set' });
export const derived = live.derived(['reload:source'], () => state.count, { topic: 'reload:derived' });
export const increment = live(() => ++state.count);
export const instance = live(() => state.id);
`;
	writeFileSync(liveFile, liveSource);
	const routeFile = join(root, 'src/route.js');
	writeFileSync(routeFile, "export { state } from './state.js';\n");
	writeFileSync(join(root, 'src/hooks.ws.js'), "export { message, close, unsubscribe, __directCall as call } from 'svelte-realtime/server';\n");
	let server;
	const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		server = await createServer({ root, configFile: false, logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [root, packageRoot] } },
			optimizeDeps: { noDiscovery: true },
			plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: { paths: {} } } }, realtime({ typedImports: false, devtools: false })]
		});
		await server.listen();
		const runner = server.environments.ssr.runner;
		const hooks = await runner.import('/src/hooks.ws.js');
		const context = { user: { id: 'test' } };
		let route = await runner.import('/src/route.js');
		expect(await hooks.call('count/counter', [], {}, context)).toBe(0);
		for (let generation = 0; generation < 3; generation++) {
			expect(await hooks.call('count/increment', [], {}, context)).toBe(1);
			expect(await hooks.call('count/counter', [], {}, context)).toBe(1);
			expect(await hooks.call('count/derived', [], {}, context)).toBe(1);
			const previous = route.state;
			server.environments.ssr.hot.send({ type: 'full-reload', triggeredBy: routeFile });
			await expect.poll(async () => {
				route = await runner.import('/src/route.js');
				return route.state.id;
			}).not.toBe(previous.id);
			expect(route.state.count).toBe(0);
			expect(await hooks.call('count/counter', [], {}, context)).toBe(0);
			expect(await hooks.call('count/derived', [], {}, context)).toBe(0);
			expect(await hooks.call('count/instance', [], {}, context)).toBe(route.state.id);
			previous.allowed = false;
			expect(await hooks.call('count/counter', [], {}, context)).toBe(0);
		}
		// A full SSR reload cannot execute a handler from the discarded graph.
		// A broken module refuses calls until repair adopts fresh state.
		expect(await hooks.call('count/increment', [], {}, context)).toBe(1);
		expect(await hooks.call('count/counter', [], {}, context)).toBe(1);
		for (const source of [liveSource + '\nexport const broken = ;\n', liveSource]) {
			const previous = route.state;
			writeFileSync(liveFile, source);
			const graph = server.environments.ssr.moduleGraph;
			for (const module of graph.getModulesByFile(liveFile.replaceAll('\\', '/')) || []) graph.invalidateModule(module);
			server.environments.ssr.hot.send({ type: 'full-reload', triggeredBy: routeFile });
			await expect.poll(async () => {
				route = await runner.import('/src/route.js');
				return route.state.id;
			}).not.toBe(previous.id);
			if (source === liveSource) {
				expect(await hooks.call('count/counter', [], {}, context)).toBe(0);
				expect(await hooks.call('count/derived', [], {}, context)).toBe(0);
			} else {
				await expect(hooks.call('count/counter', [], {}, context)).rejects.toThrow();
				await expect(hooks.call('count/derived', [], {}, context)).rejects.toThrow();
			}
		}
		expect(await hooks.call('count/instance', [], {}, context)).toBe(route.state.id);
		expect(errors.mock.calls.some(call => String(call[0]).includes('Failed to resolve lazy registration'))).toBe(true);
		route.state.allowed = false;
		await expect(hooks.call('count/counter', [], {}, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
	} finally {
		errors.mockRestore();
		await server?.close();
		const dependencies = join(installed, 'node_modules');
		if (existsSync(dependencies)) unlinkSync(dependencies);
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);

it('a full SSR reload cannot restore a live file removed by a completed registry reload', async () => {
	const root = mkdtempSync(join(tmpdir(), 'realtime-runner-unlink-'));
	const packageRoot = fileURLToPath(new URL('../', import.meta.url));
	const installed = join(root, 'node_modules/svelte-realtime');
	mkdirSync(join(root, 'src/live'), { recursive: true });
	mkdirSync(installed, { recursive: true });
	cpSync(join(packageRoot, 'src'), join(installed, 'src'), { recursive: true });
	cpSync(join(packageRoot, 'package.json'), join(installed, 'package.json'));
	symlinkSync(join(packageRoot, 'node_modules'), join(installed, 'node_modules'), 'junction');
	writeFileSync(join(root, 'src/state.js'), 'export const state = { count: 0, id: Math.random() };\n');
	writeFileSync(join(root, 'src/live/count.js'), "// realtime-allow-public\nimport { live } from 'svelte-realtime/server';\nimport { state } from '../state.js';\nexport const value = live(() => state.count);\n");
	const removed = join(root, 'src/live/extra.js');
	const routeFile = join(root, 'src/route.js');
	writeFileSync(routeFile, "export { state } from './state.js';\n");
	writeFileSync(join(root, 'src/hooks.ws.js'), "export { message, close, unsubscribe, __directCall as call } from 'svelte-realtime/server';\n");
	const plugin = realtime({ typedImports: false, devtools: false });
	let server;
	try {
		server = await createServer({ root, configFile: false, logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [root, packageRoot] } },
			optimizeDeps: { noDiscovery: true },
			plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: { paths: {} } } }, plugin]
		});
		await server.listen();
		const runner = server.environments.ssr.runner;
		const hooks = await runner.import('/src/hooks.ws.js');
		const previous = (await runner.import('/src/route.js')).state;
		const context = { user: { id: 'test' } };
		expect(await hooks.call('count/value', [], {}, context)).toBe(0);
		writeFileSync(removed, "// realtime-allow-public\nimport { live } from 'svelte-realtime/server';\nexport const value = live(() => 'removed value');\n");
		server.watcher.emit('add', removed);
		await plugin.handleHotUpdate({ file: removed, server });
		await expect.poll(() => hooks.call('extra/value', [], {}, context).catch(error => error.code)).toBe('removed value');
		unlinkSync(removed);
		server.watcher.emit('unlink', removed);
		await plugin.handleHotUpdate({ file: removed, server });
		await expect.poll(() => hooks.call('count/value', [], {}, context).catch(error => error.code)).toBe(0);
		await expect(hooks.call('extra/value', [], {}, context)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		server.environments.ssr.hot.send({ type: 'full-reload', triggeredBy: routeFile });
		await expect.poll(async () => (await runner.import('/src/route.js')).state.id).not.toBe(previous.id);
		await expect.poll(() => hooks.call('count/value', [], {}, context).catch(error => error.code)).toBe(0);
		await expect(hooks.call('extra/value', [], {}, context)).rejects.toMatchObject({ code: 'NOT_FOUND' });
	} finally {
		await server?.close();
		const dependencies = join(installed, 'node_modules');
		if (existsSync(dependencies)) unlinkSync(dependencies);
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);

it('a later broken module cannot roll back another module after it accepted writes', async () => {
	const root = mkdtempSync(join(tmpdir(), 'realtime-runner-late-error-'));
	const packageRoot = fileURLToPath(new URL('../', import.meta.url));
	const installed = join(root, 'node_modules/svelte-realtime');
	mkdirSync(join(root, 'src/live'), { recursive: true });
	mkdirSync(installed, { recursive: true });
	cpSync(join(packageRoot, 'src'), join(installed, 'src'), { recursive: true });
	cpSync(join(packageRoot, 'package.json'), join(installed, 'package.json'));
	symlinkSync(join(packageRoot, 'node_modules'), join(installed, 'node_modules'), 'junction');
	writeFileSync(join(root, 'src/state.js'), 'export const state = { count: 0, id: Math.random() };\n');
	writeFileSync(join(root, 'src/live/writes.js'), "import { live } from 'svelte-realtime/server';\nimport { state } from '../state.js';\nexport const increment = live(() => ++state.count);\nexport const value = live(() => state.count);\n");
	const failing = join(root, 'src/live/reads.js');
	writeFileSync(failing, "import { live } from 'svelte-realtime/server';\nexport const value = live(() => 'last working value');\n");
	const routeFile = join(root, 'src/route.js');
	writeFileSync(routeFile, "export { state } from './state.js';\n");
	writeFileSync(join(root, 'src/hooks.ws.js'), "export { message, close, unsubscribe, __directCall as call } from 'svelte-realtime/server';\n");
	let server;
	try {
		server = await createServer({ root, configFile: false, logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [root, packageRoot] } },
			optimizeDeps: { noDiscovery: true },
			plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: { paths: {} } } }, realtime({ typedImports: false, devtools: false })]
		});
		await server.listen();
		const runner = server.environments.ssr.runner;
		const hooks = await runner.import('/src/hooks.ws.js');
		const previous = (await runner.import('/src/route.js')).state;
		const context = { user: { id: 'test' } };
		expect(await hooks.call('writes/increment', [], {}, context)).toBe(1);
		expect(await hooks.call('writes/value', [], {}, context)).toBe(1);
		expect(await hooks.call('reads/value', [], {}, context)).toBe('last working value');
		writeFileSync(failing, 'export const broken = ;\n');
		for (const module of server.environments.ssr.moduleGraph.getModulesByFile(failing.replaceAll('\\', '/')) || []) server.environments.ssr.moduleGraph.invalidateModule(module);
		server.environments.ssr.hot.send({ type: 'full-reload', triggeredBy: routeFile });
		await expect.poll(async () => (await runner.import('/src/route.js')).state.id).not.toBe(previous.id);
		expect(await hooks.call('writes/increment', [], {}, context)).toBe(1);
		expect(await hooks.call('writes/increment', [], {}, context)).toBe(2);
		const failure = await hooks.call('reads/value', [], {}, context).then(value => ({ value }), error => ({ error }));
		expect(await hooks.call('writes/value', [], {}, context)).toBe(2);
		expect(failure.error).toBeDefined();
	} finally {
		await server?.close();
		const dependencies = join(installed, 'node_modules');
		if (existsSync(dependencies)) unlinkSync(dependencies);
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);

it('a route reload adopts a guard added after the cached registration was generated', async () => {
	const root = mkdtempSync(join(tmpdir(), 'realtime-runner-new-guard-'));
	const packageRoot = fileURLToPath(new URL('../', import.meta.url));
	const installed = join(root, 'node_modules/svelte-realtime');
	mkdirSync(join(root, 'src/live'), { recursive: true });
	mkdirSync(installed, { recursive: true });
	cpSync(join(packageRoot, 'src'), join(installed, 'src'), { recursive: true });
	cpSync(join(packageRoot, 'package.json'), join(installed, 'package.json'));
	symlinkSync(join(packageRoot, 'node_modules'), join(installed, 'node_modules'), 'junction');
	writeFileSync(join(root, 'src/state.js'), 'export const state = { reads: 0, id: Math.random() };\n');
	const liveFile = join(root, 'src/live/count.js');
	const source = "// realtime-allow-public\nimport { live, guard } from 'svelte-realtime/server';\nimport { state } from '../state.js';\nexport const value = live(() => { state.reads++; return 'private value'; });\n";
	writeFileSync(liveFile, source);
	const routeFile = join(root, 'src/route.js');
	writeFileSync(routeFile, "export { state } from './state.js';\n");
	writeFileSync(join(root, 'src/hooks.ws.js'), "export { message, close, unsubscribe, __directCall as call } from 'svelte-realtime/server';\n");
	let server;
	try {
		server = await createServer({ root, configFile: false, logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [root, packageRoot] } },
			optimizeDeps: { noDiscovery: true },
			plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: { paths: {} } } }, realtime({ typedImports: false, devtools: false })]
		});
		await server.listen();
		const runner = server.environments.ssr.runner;
		const hooks = await runner.import('/src/hooks.ws.js');
		let route = await runner.import('/src/route.js');
		const context = { user: { id: 'test' } };
		expect(await Promise.all([hooks.call('count/value', [], {}, context), hooks.call('count/value', [], {}, context)])).toEqual(['private value', 'private value']);
		for (const guarded of [true, false]) {
			const previous = route.state;
			writeFileSync(liveFile, source + (guarded ? "export const _guard = guard(() => { throw new Error('denied'); });\n" : ''));
			for (const module of server.environments.ssr.moduleGraph.getModulesByFile(liveFile.replaceAll('\\', '/')) || []) server.environments.ssr.moduleGraph.invalidateModule(module);
			server.environments.ssr.hot.send({ type: 'full-reload', triggeredBy: routeFile });
			await expect.poll(async () => { route = await runner.import('/src/route.js'); return route.state.id; }).not.toBe(previous.id);
			if (guarded) {
				await expect(hooks.call('count/value', [], {}, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
				expect(route.state.reads).toBe(0);
			} else {
				expect(await hooks.call('count/value', [], {}, context)).toBe('private value');
				expect(route.state.reads).toBe(1);
			}
		}
	} finally {
		await server?.close();
		const dependencies = join(installed, 'node_modules');
		if (existsSync(dependencies)) unlinkSync(dependencies);
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);
