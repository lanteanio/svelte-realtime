import { expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import realtime from '../src/vite.js';

it.each(['installed', 'linked'])('shares live handlers between %s Node and SSR imports through hot updates', async layout => {
	const root = mkdtempSync(join(tmpdir(), 'realtime-server-runtime-'));
	const packageRoot = fileURLToPath(new URL('../', import.meta.url));
	const installed = layout === 'installed' ? join(root, 'node_modules/svelte-realtime') : join(root, 'linked-package');
	mkdirSync(join(root, 'src/live'), { recursive: true });
	mkdirSync(installed, { recursive: true });
	cpSync(join(packageRoot, 'src'), join(installed, 'src'), { recursive: true });
	cpSync(join(packageRoot, 'package.json'), join(installed, 'package.json'));
	if (layout === 'linked') {
		mkdirSync(join(root, 'node_modules'));
		symlinkSync(installed, join(root, 'node_modules/svelte-realtime'), 'junction');
	}
	symlinkSync(join(packageRoot, 'node_modules'), join(installed, 'node_modules'), 'junction');
	const file = join(root, 'src/live/count.js');
	const source = name => `// realtime-allow-public\nimport { live } from 'svelte-realtime'; export const ${name} = live.public(() => '${name}');`;
	writeFileSync(file, source('before'));
	writeFileSync(join(root, 'src/hooks.ws.js'), "export { message, close, unsubscribe, __directCall as call, __register as register } from 'svelte-realtime/server';");
	writeFileSync(join(root, 'src/bare.js'), "export { __register as register } from 'svelte-realtime';");
	let server;
	try {
		const plugin = realtime({ typedImports: false, devtools: false });
		server = await createServer({ root, configFile: false, logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [root, packageRoot] } },
			optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['svelte-realtime'] }, plugins: [plugin] });
		await server.listen();
		const hooks = await server.ssrLoadModule('/src/hooks.ws.js');
		const bare = await server.ssrLoadModule('/src/bare.js');
		expect(bare.register).toBe(hooks.register);
		expect(await hooks.call('count/before', [], { user: { id: 'test' } })).toBe('before');
		// Node application code and Vite-loaded hooks must see the same
		// registered handlers, including after an importer stays cached.
		// Bypass Vitest's transformer for the linked layout, as application Node code does.
		const native = createRequire(import.meta.url)(join(installed, 'src/server.js'));
		expect(await native.__directCall('count/before', [], { user: { id: 'test' } })).toBe('before');
		const rune = await server.pluginContainer.resolveId('svelte-realtime/multiplayer', join(root, 'src/entry.js'), { ssr: true });
		expect(rune?.external).not.toBe(true);
		writeFileSync(file, source('after'));
		await plugin.handleHotUpdate({ file, server });
		expect(await hooks.call('count/after', [], { user: { id: 'test' } })).toBe('after');
		expect(await native.__directCall('count/after', [], { user: { id: 'test' } })).toBe('after');
		await expect(hooks.call('count/before', [], { user: { id: 'test' } })).rejects.toThrow();
		// A filesystem watcher can observe truncation before writeFile fills
		// the file, then coalesce the completed write into the same event.
		writeFileSync(file, '');
		server.watcher.emit('change', file);
		await new Promise(resolve => setTimeout(resolve, 30));
		writeFileSync(file, source('repaired'));
		await expect.poll(() => native.__directCall('count/repaired', [], { user: { id: 'test' } }).catch(() => null), { timeout: 5000 }).toBe('repaired');
		const added = join(root, 'src/live/added.js');
		writeFileSync(added, '');
		server.watcher.emit('add', added);
		await new Promise(resolve => setTimeout(resolve, 30));
		writeFileSync(added, source('created'));
		await expect.poll(() => native.__directCall('added/created', [], { user: { id: 'test' } }).catch(() => null), { timeout: 5000 }).toBe('created');
		// A file deliberately left empty must still unregister its handlers.
		writeFileSync(file, '');
		server.watcher.emit('change', file);
		await expect.poll(() => native.__directCall('count/repaired', [], { user: { id: 'test' } }).then(() => true, () => false), { timeout: 5000 }).toBe(false);
		unlinkSync(added);
		server.watcher.emit('unlink', added);
		await expect.poll(() => native.__directCall('added/created', [], { user: { id: 'test' } }).then(() => true, () => false), { timeout: 5000 }).toBe(false);
	} finally {
		await server?.close();
		const dependencies = join(installed, 'node_modules');
		if (existsSync(dependencies)) unlinkSync(dependencies);
		if (layout === 'linked') {
			const packageLink = join(root, 'node_modules/svelte-realtime');
			if (existsSync(packageLink)) unlinkSync(packageLink);
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);
