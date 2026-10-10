import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import svelteRealtime from '../src/vite.js';

let root, liveDir;
const flush = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'realtime-vite-watch-'));
	liveDir = join(root, 'src/live');
	mkdirSync(liveDir, { recursive: true });
	writeFileSync(join(liveDir, 'chat.js'), 'export const send = live(async () => {});');
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function fixture(options = {}) {
	const plugin = svelteRealtime({ typedImports: false, devtools: false, ...options });
	plugin.configResolved({ root, command: 'serve', build: {} });
	const runtime = { _prepareHmr: vi.fn(() => ({})), _restoreHmr: vi.fn() };
	const registry = { id: '\0live:__registry' };
	const server = {
		watcher: new EventEmitter(), httpServer: new EventEmitter(),
		middlewares: { use() {} },
		moduleGraph: {
			ensureEntryFromUrl: vi.fn(async () => registry),
			getModuleById: vi.fn(id => id === registry.id ? registry : null),
			getModulesByFile: vi.fn(() => new Set()),
			invalidateModule: vi.fn()
		},
		ssrLoadModule: vi.fn(async id => id === 'svelte-realtime/server' ? runtime : {}),
		warmupRequest: vi.fn(async () => {})
	};
	plugin.configureServer(server);
	return { plugin, server, runtime, start: () => server.httpServer.listeners('listening')[0]() };
}

it.each(['add', 'unlink'])('ignores foreign and adjacent live directories on %s', async event => {
	const { server, start } = fixture();
	await start(); server.ssrLoadModule.mockClear();
	const listener = server.watcher.listeners(event)[0];
	for (const file of [
		join(root, '.claude/worktrees/other/src/live/chat.js'),
		join(root, 'src/live-other/chat.js'),
		join(root, '../other/src/live/chat.js'),
		join(root, 'src/live/../../other/src/live/chat.js')
	]) await listener(file.replaceAll('\\', '/'));
	expect(server.ssrLoadModule).not.toHaveBeenCalled();
});
it.each(['add', 'unlink'])('reloads an owned nested module on %s', async event => {
	const { server, runtime, start } = fixture();
	await start(); server.ssrLoadModule.mockClear();
	await server.watcher.listeners(event)[0](join(liveDir, 'rooms/chat.ts').replaceAll('\\', '/'));
	expect(runtime._prepareHmr).toHaveBeenCalledOnce();
	expect(server.ssrLoadModule).toHaveBeenCalledWith('/@svelte-realtime-registry');
});
it('ignores an adjacent live prefix in ordinary hot updates', async () => {
	const { plugin, server } = fixture();
	await plugin.handleHotUpdate({ file: liveDir + '-other/chat.js', server });
	expect(server.ssrLoadModule).not.toHaveBeenCalled();
});
it('keeps nested worktree hooks outside the parent registry transform', () => {
	const { plugin } = fixture();
	expect(plugin.transform('export const message = () => {};', join(root, '.claude/worktrees/other/src/hooks.ws.js'), { ssr: true })).toBeNull();
	expect(plugin.transform('export const message = () => {};', join(root, 'src/hooks.ws.js'), { ssr: true }).code).toContain('/@svelte-realtime-registry');
});
it('serializes add, unlink and ordinary edits through the same registry queue', async () => {
	const { plugin, server, runtime, start } = fixture();
	await start(); server.ssrLoadModule.mockClear();
	let release;
	const held = new Promise(resolve => { release = resolve; });
	let imports = 0;
	server.ssrLoadModule.mockImplementation(async id => {
		if (id === 'svelte-realtime/server') return runtime;
		if (++imports === 1) await held;
		return {};
	});
	const first = server.watcher.listeners('add')[0](join(liveDir, 'one.js'));
	await flush();
	const removed = server.watcher.listeners('unlink')[0](join(liveDir, 'two.js'));
	const changed = plugin.handleHotUpdate({ file: join(liveDir, 'chat.js'), server });
	await flush();
	expect(runtime._prepareHmr).toHaveBeenCalledTimes(1);
	expect(imports).toBe(1);
	release();
	await Promise.all([first, removed, changed]);
	expect(runtime._prepareHmr).toHaveBeenCalledTimes(3);
	expect(imports).toBe(3);
});
it('waits for cold registry initialization before handling file additions', async () => {
	const { server, runtime, start } = fixture();
	let release;
	const held = new Promise(resolve => { release = resolve; });
	let imports = 0;
	server.ssrLoadModule.mockImplementation(async id => {
		if (id === 'svelte-realtime/server') return runtime;
		if (++imports === 1) await held;
		return {};
	});
	const initial = start();
	await flush();
	const change = server.watcher.listeners('add')[0](join(liveDir, 'new.js'));
	await flush();
	expect(runtime._prepareHmr).not.toHaveBeenCalled();
	release(); await Promise.all([initial, change]);
	expect(runtime._prepareHmr).toHaveBeenCalledOnce();
});
it('contains a failed preparation and still processes the next edit', async () => {
	const { server, runtime, start } = fixture();
	await start();
	runtime._prepareHmr.mockImplementationOnce(() => { throw new ReferenceError('Server module is not initialized'); });
	await expect(server.watcher.listeners('add')[0](join(liveDir, 'new.js'))).resolves.toBeUndefined();
	await server.watcher.listeners('unlink')[0](join(liveDir, 'new.js'));
	expect(runtime._prepareHmr).toHaveBeenCalledTimes(2);
	expect(console.error).toHaveBeenCalled();
});

it('contains asynchronous watcher failures without poisoning later work', async () => {
	const { server, runtime, start } = fixture();
	await start();
	server.moduleGraph.invalidateModule.mockImplementationOnce(() => { throw new Error('Registry invalidation failed'); });
	await expect(server.watcher.listeners('add')[0](join(liveDir, 'new.js'))).resolves.toBeUndefined();
	await server.watcher.listeners('unlink')[0](join(liveDir, 'new.js'));
	expect(runtime._prepareHmr).toHaveBeenCalledOnce();
	expect(console.error).toHaveBeenCalled();
});
it('awaits fallback registration before a queued reload can clear it', async () => {
	const { server, runtime, start } = fixture();
	let release;
	const held = new Promise(resolve => { release = resolve; });
	let registries = 0;
	const register = vi.fn();
	runtime.__register = register;
	server.ssrLoadModule.mockImplementation(async id => {
		if (id === 'svelte-realtime/server') return runtime;
		if (id === '/@svelte-realtime-registry' && ++registries === 1) throw new Error('Cold registry load failed');
		if (id === join(liveDir, 'chat.js')) { await held; return { send: { __isLive: true } }; }
		return {};
	});
	const initial = start(); await flush();
	const change = server.watcher.listeners('add')[0](join(liveDir, 'new.js'));
	await flush();
	expect(runtime._prepareHmr).not.toHaveBeenCalled();
	release(); await Promise.all([initial, change]);
	expect(register).toHaveBeenCalledOnce();
	expect(runtime._prepareHmr).toHaveBeenCalledOnce();
});

it('folds pre-listening edits into fresh startup registration and declarations', async () => {
	const { plugin, server, runtime, start } = fixture({ typedImports: true });
	plugin.buildStart();
	writeFileSync(join(liveDir, 'chat.js'), 'export const updated = live(async () => {});');
	writeFileSync(join(liveDir, 'added.js'), 'export const other = live(async () => {});');
	await server.watcher.listeners('add')[0](join(liveDir, 'added.js'));
	await plugin.handleHotUpdate({ file: join(liveDir, 'chat.js'), server });
	expect(runtime._prepareHmr).not.toHaveBeenCalled();
	await start();
	const declarations = readFileSync(join(liveDir, '$types.d.ts'), 'utf8');
	expect(declarations).toContain('updated');
	expect(declarations).toContain('$live/added');
	expect(plugin.load('\0live:__registry', { ssr: true })).toContain('chat/updated');
});
