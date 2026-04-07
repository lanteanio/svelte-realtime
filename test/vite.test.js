import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import svelteRealtime from '../vite.js';

const testRoot = resolve(import.meta.dirname, '__fixtures__');
const liveDir = resolve(testRoot, 'src/live');

function setup(files = {}) {
	mkdirSync(liveDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const dir = resolve(liveDir, name.includes('/') ? name.substring(0, name.lastIndexOf('/')) : '');
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(liveDir, name), content);
	}
}

function teardown() {
	if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
}

function createPlugin(opts = {}) {
	const plugin = svelteRealtime({ dir: 'src/live', ...opts });
	// Simulate Vite calling configResolved
	plugin.configResolved({
		root: testRoot,
		build: {}
	});
	return plugin;
}

// -- resolveId ----------------------------------------------------------------

describe('resolveId', () => {
	it('resolves $live/chat to virtual module ID', () => {
		const plugin = createPlugin();
		expect(plugin.resolveId('$live/chat')).toBe('\0live:chat');
	});

	it('resolves $live/rooms/lobby to virtual module ID', () => {
		const plugin = createPlugin();
		expect(plugin.resolveId('$live/rooms/lobby')).toBe('\0live:rooms/lobby');
	});

	it('resolves registry ID', () => {
		const plugin = createPlugin();
		expect(plugin.resolveId('\0live:__registry')).toBe('\0live:__registry');
	});

	it('returns null for non-$live imports', () => {
		const plugin = createPlugin();
		expect(plugin.resolveId('svelte')).toBeNull();
		expect(plugin.resolveId('$lib/utils')).toBeNull();
	});
});

// -- load (client stubs) ------------------------------------------------------

describe('load (client stubs)', () => {
	afterEach(teardown);

	it('generates __rpc() stubs for live() exports', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const sendMessage = live(async (ctx, text) => {});
export const deleteMessage = live(async (ctx, id) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: false });

		expect(code).toContain("import { __rpc } from 'svelte-realtime/client'");
		expect(code).toContain("export const sendMessage = __rpc('chat/sendMessage')");
		expect(code).toContain("export const deleteMessage = __rpc('chat/deleteMessage')");
	});

	it('generates __stream() stubs for live.stream() exports', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const messages = live.stream('messages', async (ctx) => {}, { merge: 'crud', key: 'id', prepend: true });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: false });

		expect(code).toContain("import { __stream } from 'svelte-realtime/client'");
		expect(code).toContain("export const messages = __stream('chat/messages'");
		expect(code).toContain('"merge":"crud"');
		expect(code).toContain('"key":"id"');
		expect(code).toContain('"prepend":true');
	});

	it('generates mixed __rpc and __stream stubs', () => {
		setup({
			'items.js': `
import { live } from 'svelte-realtime/server';
export const addItem = live(async (ctx, name) => {});
export const items = live.stream('items', async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:items', { ssr: false });

		expect(code).toContain('__rpc');
		expect(code).toContain('__stream');
		expect(code).toContain("export const addItem = __rpc('items/addItem')");
		expect(code).toContain("export const items = __stream('items/items'");
	});

	it('handles nested directories', () => {
		setup({
			'rooms/lobby.js': `
import { live } from 'svelte-realtime/server';
export const join = live(async (ctx) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:rooms/lobby', { ssr: false });

		expect(code).toContain("export const join = __rpc('rooms/lobby/join')");
	});
});

// -- load (SSR) ---------------------------------------------------------------

describe('load (SSR)', () => {
	afterEach(teardown);

	it('re-exports from real server module', () => {
		setup({
			'chat.js': `export const sendMessage = live(async (ctx) => {});`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: true });

		expect(code).toContain('export * from ');
		expect(code).toContain('chat.js');
	});
});

// -- registry module ----------------------------------------------------------

describe('registry module', () => {
	afterEach(teardown);

	it('imports and registers all live exports', () => {
		setup({
			'chat.js': `
import { live, guard } from 'svelte-realtime/server';
export const _guard = guard((ctx) => {});
export const sendMessage = live(async (ctx) => {});
export const messages = live.stream('messages', async (ctx) => []);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain("import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate, __registerRoomActions } from 'svelte-realtime/server'");
		expect(code).toContain("__register('chat/sendMessage'");
		expect(code).toContain("__register('chat/messages'");
		expect(code).toContain("__registerGuard('chat'");
	});

	it('handles multiple modules', () => {
		setup({
			'chat.js': `export const send = live(async () => {});`,
			'admin.js': `export const deleteUser = live(async () => {});`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain("__register('admin/deleteUser'");
		expect(code).toContain("__register('chat/send'");
	});

	it('returns empty comment when no live dir exists', () => {
		teardown();
		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain('No live modules found');
	});
});

// -- warnings -----------------------------------------------------------------

describe('warnings', () => {
	afterEach(teardown);

	it('warns on empty modules', () => {
		setup({
			'empty.js': `// nothing here`
		});

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.load('\0live:empty', { ssr: false });

		console.warn = origWarn;

		expect(warns.some(w => w.includes('no live() or live.stream() exports'))).toBe(true);
	});

	it('warns on non-live exports', () => {
		setup({
			'mixed.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async () => {});
export const helperFn = () => {};
`
		});

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.load('\0live:mixed', { ssr: false });

		console.warn = origWarn;

		expect(warns.some(w => w.includes("'helperFn'") && w.includes('not wrapped in live()'))).toBe(true);
	});
});

// -- hooks.ws.js detection ----------------------------------------------------

describe('hooks.ws.js detection', () => {
	afterEach(teardown);

	it('warns when live modules exist but src/hooks.ws.js is missing', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.buildStart();

		console.warn = origWarn;

		expect(warns.some(w => w.includes('no src/hooks.ws.js') && w.includes('WebSocket RPC will not work'))).toBe(true);
	});

	it('warns when hooks.ws.js exists but has no message export', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});
		// Write hooks.ws.js without message export
		mkdirSync(resolve(testRoot, 'src'), { recursive: true });
		writeFileSync(resolve(testRoot, 'src/hooks.ws.js'), `
export function upgrade({ cookies }) {
  return {};
}
`);

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.buildStart();

		console.warn = origWarn;

		expect(warns.some(w => w.includes('does not export') && w.includes('message'))).toBe(true);
	});

	it('does not warn when hooks.ws.js has re-exported message', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});
		mkdirSync(resolve(testRoot, 'src'), { recursive: true });
		writeFileSync(resolve(testRoot, 'src/hooks.ws.js'), `
export { message } from 'svelte-realtime/server';
export function upgrade() { return {}; }
`);

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.buildStart();

		console.warn = origWarn;

		expect(warns.some(w => w.includes('hooks.ws'))).toBe(false);
	});

	it('does not warn when hooks.ws.ts exists with message export', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});
		mkdirSync(resolve(testRoot, 'src'), { recursive: true });
		writeFileSync(resolve(testRoot, 'src/hooks.ws.ts'), `
export { message } from 'svelte-realtime/server';
export function upgrade() { return {}; }
`);

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.buildStart();

		console.warn = origWarn;

		expect(warns.some(w => w.includes('hooks.ws'))).toBe(false);
	});

	it('does not warn when no live modules exist', () => {
		teardown(); // no src/live/ at all

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.buildStart();

		console.warn = origWarn;

		// Should get the "no live modules found" warning, NOT the hooks.ws warning
		expect(warns.some(w => w.includes('hooks.ws'))).toBe(false);
	});

	it('accepts custom message handler defined in hooks.ws.js', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});
		mkdirSync(resolve(testRoot, 'src'), { recursive: true });
		writeFileSync(resolve(testRoot, 'src/hooks.ws.js'), `
import { createMessage } from 'svelte-realtime/server';
export const message = createMessage({ onError: console.error });
export function upgrade() { return {}; }
`);

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.buildStart();

		console.warn = origWarn;

		expect(warns.some(w => w.includes('hooks.ws'))).toBe(false);
	});
});

// -- resolveId: /@svelte-realtime-registry (Finding 2) ------------------------

describe('resolveId (registry URL)', () => {
	it('resolves /@svelte-realtime-registry to the registry virtual module', () => {
		const plugin = createPlugin();
		expect(plugin.resolveId('/@svelte-realtime-registry')).toBe('\0live:__registry');
	});
});

// -- config hook (Finding 2) --------------------------------------------------

describe('config hook', () => {
	it('injects registry when input is an object', () => {
		const plugin = createPlugin();
		const config = { build: { ssr: true, rollupOptions: { input: { index: 'src/index.js' } } } };
		plugin.config(config, { command: 'build' });
		expect(config.build.rollupOptions.input['__live-registry']).toBe('\0live:__registry');
		expect(config.build.rollupOptions.input.index).toBe('src/index.js');
	});

	it('injects registry when input is a string', () => {
		const plugin = createPlugin();
		const config = { build: { ssr: true, rollupOptions: { input: 'src/index.js' } } };
		plugin.config(config, { command: 'build' });
		expect(config.build.rollupOptions.input).toEqual({
			index: 'src/index.js',
			'__live-registry': '\0live:__registry'
		});
	});

	it('injects registry when input is an array', () => {
		const plugin = createPlugin();
		const config = { build: { ssr: true, rollupOptions: { input: ['src/a.js', 'src/b.js'] } } };
		plugin.config(config, { command: 'build' });
		expect(config.build.rollupOptions.input).toEqual({
			entry0: 'src/a.js',
			entry1: 'src/b.js',
			'__live-registry': '\0live:__registry'
		});
	});

	it('injects registry when rollupOptions is missing', () => {
		const plugin = createPlugin();
		const config = { build: { ssr: true } };
		plugin.config(config, { command: 'build' });
		expect(config.build.rollupOptions.input).toEqual({
			'__live-registry': '\0live:__registry'
		});
	});

	it('does nothing for non-SSR builds', () => {
		const plugin = createPlugin();
		const config = { build: { rollupOptions: { input: { index: 'src/index.js' } } } };
		plugin.config(config, { command: 'build' });
		expect(config.build.rollupOptions.input['__live-registry']).toBeUndefined();
	});
});

// -- dynamic topics (Phase 8) -------------------------------------------------

describe('dynamic topic detection', () => {
	afterEach(teardown);

	it('generates function wrapper for dynamic topic streams', () => {
		setup({
			'rooms.js': `
import { live } from 'svelte-realtime/server';
export const roomMessages = live.stream(
  (ctx, roomId) => 'chat:' + roomId,
  async (ctx, roomId) => [],
  { merge: 'crud', key: 'id' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:rooms', { ssr: false });

		expect(code).toContain('__stream');
		expect(code).toContain('true'); // isDynamic flag
		expect(code).toContain("export const roomMessages = __stream('rooms/roomMessages'");
	});

	it('static topic streams are NOT marked as dynamic', () => {
		setup({
			'items.js': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('items', async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:items', { ssr: false });

		expect(code).toContain("export const items = __stream('items/items'");
		expect(code).not.toContain('true);'); // no isDynamic flag
	});
});

// -- path traversal (Finding 6) -----------------------------------------------

describe('path traversal prevention', () => {
	afterEach(teardown);

	it('rejects $live/ imports that escape the live directory', () => {
		setup({
			'chat.js': `export const send = live(async () => {});`
		});

		const plugin = createPlugin();
		// Attach a mock error method (Vite's plugin context)
		let errorMsg = null;
		plugin.error = (msg) => { errorMsg = msg; };

		const code = plugin.load('\0live:../../package', { ssr: false });

		// Should not have generated any stubs (file not found due to confinement)
		expect(errorMsg).not.toBeNull();
		expect(errorMsg).toContain('Could not resolve');
	});
});

// -- Type declarations (Phase 5) ----------------------------------------------

describe('type declarations', () => {
	afterEach(teardown);

	it('generates $types.d.ts on buildStart for JS files with any types', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const sendMessage = live(async (ctx, text) => {});
export const messages = live.stream('messages', async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const typesPath = resolve(liveDir, '$types.d.ts');
		expect(existsSync(typesPath)).toBe(true);

		const content = readFileSync(typesPath, 'utf-8');
		expect(content).toContain("declare module '$live/chat'");
		expect(content).toContain('sendMessage');
		expect(content).toContain('(...args: any[]) => Promise<any>');
		expect(content).toContain('messages');
		expect(content).toContain('StreamStore<any>');
	});

	it('generates typed declarations for TS files (strips ctx param)', () => {
		setup({
			'chat.ts': `
import { live, LiveError } from 'svelte-realtime/server';
import type { LiveContext } from 'svelte-realtime/server';

export const sendMessage = live(async (ctx: LiveContext, text: string, roomId: number): Promise<{ id: number }> => {
  return { id: 1 };
});
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/chat'");
		expect(content).toContain('sendMessage');
		expect(content).toContain('text: string');
		expect(content).toContain('roomId: number');
		// Should NOT contain ctx
		expect(content).not.toContain('ctx:');
		expect(content).toContain('Promise<{ id: number }>');
	});

	it('falls back to generic args for destructured ctx topic param', () => {
		setup({
			'feed.ts': `
import { live } from 'svelte-realtime/server';

export const feed = live.stream(
  ({ user }, roomId: string) => 'feed:' + roomId,
  async (ctx, roomId: string) => [],
  { merge: 'crud' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/feed'");
		expect(content).toContain('...args: any[]');
		expect(content).not.toContain('{ user }');
	});

	it('falls back to generic args for destructured payload topic param', () => {
		setup({
			'rooms.ts': `
import { live } from 'svelte-realtime/server';

export const room = live.stream(
  ({ roomId }: { roomId: string }) => 'room:' + roomId,
  async (ctx) => [],
  { merge: 'crud' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/rooms'");
		expect(content).toContain('...args: any[]');
	});

	it('falls back to generic args for destructured param with ctx-like names', () => {
		setup({
			'mixed.ts': `
import { live } from 'svelte-realtime/server';

export const mixed = live.stream(
  ({ user, roomId }: { user: string, roomId: string }) => 'mixed:' + roomId,
  async (ctx) => [],
  { merge: 'crud' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/mixed'");
		expect(content).toContain('...args: any[]');
		expect(content).not.toContain('{ user');
	});

	it('handles default string containing comma without generating broken type', () => {
		setup({
			'commas.ts': `
import { live } from 'svelte-realtime/server';

export const feed = live.stream(
  (roomId: string = 'a,b') => 'r:' + roomId,
  async (ctx) => [],
  { merge: 'crud' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/commas'");
		expect(content).not.toContain("b')");
		expect(content).toContain('roomId');
	});

	it('comparison operator in default does not swallow later params', () => {
		setup({
			'cmp.ts': `
import { live } from 'svelte-realtime/server';

export const feed = live.stream(
  (roomId = 1 < 2 ? 'yes' : 'no', docId: string) => 'r:' + docId,
  async (ctx) => [],
  { merge: 'crud' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/cmp'");
		expect(content).toContain('docId');
	});

	it('generic type annotation is still handled correctly', () => {
		setup({
			'generic.ts': `
import { live } from 'svelte-realtime/server';

export const feed = live.stream(
  (ctx: { items: Map<string, number> }, docId: string) => 'r:' + docId,
  async (ctx) => [],
  { merge: 'crud' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/generic'");
		expect(content).toContain('docId');
	});

	it('extracts stream return types from TS files', () => {
		setup({
			'items.ts': `
import { live } from 'svelte-realtime/server';
import type { LiveContext } from 'svelte-realtime/server';

interface Item { id: number; name: string; }

export const items = live.stream('items', async (ctx: LiveContext): Promise<Item[]> => {
  return [];
}, { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/items'");
		expect(content).toContain('StreamStore<Item[] | undefined | { error: RpcError }>');
	});

	it('handles mixed RPC and stream exports', () => {
		setup({
			'board.js': `
import { live } from 'svelte-realtime/server';
export const addCard = live(async (ctx, text) => {});
export const cards = live.stream('cards', async (ctx) => [], { merge: 'crud' });
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain('addCard');
		expect(content).toContain('cards');
		expect(content).toContain('StreamStore');
	});

	it('handles multiple modules', () => {
		setup({
			'chat.js': `export const send = live(async (ctx) => {});`,
			'admin.js': `export const ban = live(async (ctx) => {});`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/chat'");
		expect(content).toContain("declare module '$live/admin'");
	});

	it('skips generation when typedImports is false', () => {
		setup({
			'chat.js': `export const send = live(async (ctx) => {});`
		});

		const plugin = createPlugin({ typedImports: false });
		plugin.buildStart();

		expect(existsSync(resolve(liveDir, '$types.d.ts'))).toBe(false);
	});

	it('handles nested directories', () => {
		setup({
			'rooms/lobby.js': `
import { live } from 'svelte-realtime/server';
export const join = live(async (ctx) => {});
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/rooms/lobby'");
	});

	it('imports StreamStore from svelte-realtime/client for stream exports', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const messages = live.stream('messages', async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("StreamStore");
		expect(content).toContain("from 'svelte-realtime/client'");
		expect(content).not.toContain("from 'svelte/store'");
	});

	it('generates .load() type on static stream declarations', () => {
		setup({
			'items.ts': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('items', async (ctx): Promise<Item[]> => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain('StreamStore<Item[] | undefined | { error: RpcError }>');
		expect(content).toContain('load(platform: any, options?: { args?: any[] }): Promise<Item[]>');
	});

	it('generates .load() type on dynamic stream declarations', () => {
		setup({
			'board.ts': `
import { live } from 'svelte-realtime/server';
export const notes = live.stream(
  (ctx, boardId: string) => 'notes:' + boardId,
  async (ctx, boardId: string): Promise<Note[]> => [],
  { merge: 'crud', key: 'id' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain('(boardId: string) => StreamStore<Note[] | undefined | { error: RpcError }>');
		expect(content).toContain('load(platform: any, options?: { args?: any[] }): Promise<Note[]>');
	});

	it('generates .load() type on JS stream declarations', () => {
		setup({
			'feed.js': `
import { live } from 'svelte-realtime/server';
export const feed = live.stream('feed', async (ctx) => [], { merge: 'latest' });
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain('StreamStore<any> & { load(platform: any, options?: { args?: any[] }): Promise<any> }');
	});

	it('generates .load() type on channel declarations', () => {
		setup({
			'events.js': `
import { live } from 'svelte-realtime/server';
export const notifications = live.channel('notifications');
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain('StreamStore<any> & { load(platform: any');
	});
});

// -- live.validated() client stubs (Phase 12) ---------------------------------

describe('live.validated() stubs', () => {
	afterEach(teardown);

	it('generates __rpc() stub for live.validated() export', () => {
		setup({
			'forms.js': `
import { live } from 'svelte-realtime/server';
export const submit = live.validated(schema, async (ctx, input) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:forms', { ssr: false });

		expect(code).toContain("import { __rpc } from 'svelte-realtime/client'");
		expect(code).toContain("export const submit = __rpc('forms/submit')");
	});

	it('does not duplicate when both live() and live.validated() match same name', () => {
		setup({
			'dedup.js': `
import { live } from 'svelte-realtime/server';
export const action = live.validated(schema, async (ctx, input) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:dedup', { ssr: false });

		const count = (code.match(/export const action/g) || []).length;
		expect(count).toBe(1);
	});

	it('does not warn about live.validated() exports being unwrapped', () => {
		setup({
			'nowarn.js': `
import { live } from 'svelte-realtime/server';
export const send = live.validated(schema, async (ctx, input) => {});
`
		});

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		plugin.load('\0live:nowarn', { ssr: false });

		console.warn = origWarn;

		expect(warns.some(w => w.includes("'send'") && w.includes('not wrapped'))).toBe(false);
	});
});

// -- live.cron() registration (Phase 14) --------------------------------------

describe('live.cron() registration', () => {
	afterEach(teardown);

	it('generates __registerCron call in registry', () => {
		setup({
			'jobs.js': `
import { live } from 'svelte-realtime/server';
export const refreshStats = live.cron('*/5 * * * *', 'stats', async () => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain("__registerCron('jobs/refreshStats'");
		expect(code).toContain("import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate, __registerRoomActions }");
	});

	it('does not generate client stub for cron exports', () => {
		setup({
			'cron.js': `
import { live } from 'svelte-realtime/server';
export const tick = live.cron('* * * * *', 'tick', async () => {});
`
		});

		const warns = [];
		const origWarn = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));

		const plugin = createPlugin();
		const code = plugin.load('\0live:cron', { ssr: false });

		console.warn = origWarn;

		// Cron should not have an __rpc or __stream stub
		expect(code).not.toContain("__rpc('cron/tick')");
		expect(code).not.toContain("__stream('cron/tick')");
		// Should not warn about unwrapped export
		expect(warns.some(w => w.includes("'tick'") && w.includes('not wrapped'))).toBe(false);
	});
});

// -- SSR stubs with .load() (Phase 11) ----------------------------------------

describe('SSR stubs with .load()', () => {
	afterEach(teardown);

	it('generates .load() wrapper for stream exports in SSR mode', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const messages = live.stream('messages', async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: true });

		expect(code).toContain("import { readable } from 'svelte/store'");
		expect(code).toContain("import { __directCall } from 'svelte-realtime/server'");
		expect(code).toContain("const _messages = readable(undefined)");
		expect(code).toContain('_messages.load = (platform, options) => __directCall("chat/messages"');
		expect(code).toContain("export { _messages as messages }");
	});

	it('wraps dynamic streams as functions returning readable() in SSR mode', () => {
		setup({
			'board.js': `
import { live } from 'svelte-realtime/server';
export const notes = live.stream((boardId) => 'notes/' + boardId, async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:board', { ssr: true });

		expect(code).toContain("import { readable } from 'svelte/store'");
		expect(code).toContain("const _notes = (...args) => readable(undefined)");
		expect(code).toContain('_notes.load = (platform, options) => __directCall("board/notes"');
		expect(code).toContain("export { _notes as notes }");
	});

	it('simple re-export when module has no streams', () => {
		setup({
			'rpc.js': `
import { live } from 'svelte-realtime/server';
export const doThing = live(async (ctx) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:rpc', { ssr: true });

		expect(code).toContain('export * from ');
		expect(code).not.toContain('__directCall');
	});
});

// -- Replay option extraction (Phase 15) --------------------------------------

describe('replay option extraction', () => {
	afterEach(teardown);

	it('includes replay in client stub options when replay: true', () => {
		setup({
			'replay.js': `
import { live } from 'svelte-realtime/server';
export const feed = live.stream('feed', async (ctx) => [], { merge: 'latest', max: 50, replay: true });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:replay', { ssr: false });

		expect(code).toContain('"replay":true');
	});

	it('does not include replay when replay: false', () => {
		setup({
			'norep.js': `
import { live } from 'svelte-realtime/server';
export const feed = live.stream('feed', async (ctx) => [], { merge: 'latest', replay: false });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:norep', { ssr: false });

		expect(code).not.toContain('"replay"');
	});
});

// -- DevTools injection (Phase 13) --------------------------------------------

describe('devtools injection', () => {
	it('injects devtools middleware in dev mode via configureServer', () => {
		const plugin = svelteRealtime({ dir: 'src/live' });
		plugin.configResolved({ root: testRoot, build: {}, command: 'serve' });

		const middlewares = [];
		const mockServer = {
			middlewares: { use: (fn) => middlewares.push(fn) },
			httpServer: { once: () => {} },
			watcher: { on: () => {} },
		};
		plugin.configureServer.call({ load: () => {} }, mockServer);

		// Should have registered at least one middleware (devtools injection)
		expect(middlewares.length).toBeGreaterThan(0);
	});

	it('transformIndexHtml returns empty (devtools handled via middleware)', () => {
		const plugin = svelteRealtime({ dir: 'src/live' });
		plugin.configResolved({ root: testRoot, build: {}, command: 'serve' });

		const result = plugin.transformIndexHtml();
		expect(result).toEqual([]);
	});

	it('does not inject devtools middleware when disabled', () => {
		const plugin = svelteRealtime({ dir: 'src/live', devtools: false });
		plugin.configResolved({ root: testRoot, build: {}, command: 'serve' });

		const middlewares = [];
		const mockServer = {
			middlewares: { use: (fn) => middlewares.push(fn) },
			httpServer: { once: () => {} },
			watcher: { on: () => {} },
		};
		plugin.configureServer.call({ load: () => {} }, mockServer);

		// No devtools middleware, only the watcher setup
		// (configureServer only adds middleware when devtools is enabled)
		expect(middlewares).toHaveLength(0);
	});
});

// -- live.validated() type declarations (Phase 12) ----------------------------

describe('live.validated() type declarations', () => {
	afterEach(teardown);

	it('includes validated exports in type declarations', () => {
		setup({
			'forms.js': `
import { live } from 'svelte-realtime/server';
export const submit = live.validated(schema, async (ctx, input) => {});
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/forms'");
		expect(content).toContain('submit');
	});
});

// -- live.derived() client stubs and registry ---------------------------------

describe('live.derived() vite integration', () => {
	afterEach(teardown);

	it('generates __stream client stub for derived exports', () => {
		setup({
			'stats.js': `
import { live } from 'svelte-realtime/server';
export const summary = live.derived(['orders', 'inventory'], async () => {
  return { total: 0 };
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:stats', {});

		expect(code).toContain("__stream('stats/summary'");
		expect(code).toContain("import { __stream }");
	});

	it('registers derived in registry with __registerDerived', () => {
		setup({
			'stats.js': `
import { live } from 'svelte-realtime/server';
export const summary = live.derived(['orders', 'inventory'], async () => {
  return { total: 0 };
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain("__register('stats/summary'");
		expect(code).toContain("__registerDerived('stats/summary'");
	});
});

// -- live.room() client stubs -------------------------------------------------

describe('live.room() vite integration', () => {
	afterEach(teardown);

	it('generates room namespace with data stream and actions', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const board = live.room({
  topic: (ctx, boardId) => 'board:' + boardId,
  init: async (ctx, boardId) => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  actions: {
    addCard: async (ctx, title) => ({ id: 1, title }),
    removeCard: async (ctx, cardId) => null
  }
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain("export const board = {");
		expect(code).toContain("data: __stream('collab/board/__data'");
		expect(code).toContain("presence: __stream('collab/board/__presence'");
		expect(code).toContain("cursors: __stream('collab/board/__cursors'");
		expect(code).toContain("addCard: __rpc('collab/board/__action/addCard')");
		expect(code).toContain("removeCard: __rpc('collab/board/__action/removeCard')");
	});

	it('registers room sub-streams in registry', () => {
		setup({
			'rooms.js': `
import { live } from 'svelte-realtime/server';
export const chat = live.room({
  topic: (ctx, id) => 'room:' + id,
  init: async (ctx, id) => [],
  actions: {
    send: async (ctx, text) => null
  }
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain("__register('rooms/chat/__data'");
		expect(code).toContain("__registerRoomActions('rooms/chat'");
	});
});

// -- Parser robustness --------------------------------------------------------

describe('parser edge cases', () => {
	afterEach(teardown);

	it('handles quoted keys in stream options', () => {
		setup({
			'items.js': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('items', async () => [], { 'merge': 'latest', 'key': 'slug', 'max': 5 });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:items', {});

		expect(code).toContain('"merge":"latest"');
		expect(code).toContain('"key":"slug"');
		expect(code).toContain('"max":5');
	});

	it('handles hyphenated key values', () => {
		setup({
			'docs.js': `
import { live } from 'svelte-realtime/server';
export const docs = live.stream('docs', async () => [], { merge: 'crud', key: 'client-id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:docs', {});

		expect(code).toContain('"key":"client-id"');
	});

	it('does not extract actions from nested objects', () => {
		setup({
			'board.js': `
import { live } from 'svelte-realtime/server';
export const board = live.room({
  topic: (ctx, id) => 'board:' + id,
  init: async (ctx, id) => ({ text: 'presence:', actions: { fake: true } }),
  actions: {
    send: async (ctx, text) => null
  }
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:board', {});

		expect(code).toContain("send: __rpc('board/board/__action/send')");
		expect(code).not.toContain('fake');
	});

	it('handles quoted room config keys', () => {
		setup({
			'room.js': `
import { live } from 'svelte-realtime/server';
export const game = live.room({
  topic: (ctx, id) => 'game:' + id,
  init: async (ctx, id) => [],
  'presence': (ctx) => ({ name: ctx.user.name }),
  'actions': {
    move: async (ctx, pos) => null
  }
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:room', {});

		expect(code).toContain("presence: __stream('room/game/__presence'");
		expect(code).toContain("move: __rpc('room/game/__action/move')");
	});

	it('extracts room merge/key from quoted keys', () => {
		setup({
			'rk.js': `
import { live } from 'svelte-realtime/server';
export const board = live.room({
  topic: (ctx, id) => 'board:' + id,
  init: async (ctx, id) => [],
  'merge': 'set',
  'key': 'board-id'
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:rk', {});

		expect(code).toContain('"merge":"set"');
		expect(code).toContain('"key":"board-id"');
	});
});

// -- live.channel() client stubs (Phase 35) -----------------------------------

describe('live.channel() vite integration', () => {
	afterEach(teardown);

	it('generates __stream client stubs for static channel', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const typing = live.channel('typing:lobby', { merge: 'presence' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain("import { __stream } from 'svelte-realtime/client'");
		expect(code).toContain("__stream('collab/typing'");
		expect(code).toContain('"merge":"presence"');
	});

	it('generates __stream with isDynamic for dynamic channel', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const cursors = live.channel((ctx, docId) => 'cursors:' + docId, { merge: 'cursor', key: 'userId' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain("__stream('collab/cursors'");
		expect(code).toContain(', true)');
		expect(code).toContain('"merge":"cursor"');
		expect(code).toContain('"key":"userId"');
	});

	it('registers channel in the registry', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const typing = live.channel('typing:lobby', { merge: 'presence' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain("__register('collab/typing'");
	});
});

// -- live.webhook() client stubs ----------------------------------------------

describe('live.webhook() vite integration', () => {
	afterEach(teardown);

	it('does not generate client stub for webhook exports', () => {
		setup({
			'hooks.js': `
import { live } from 'svelte-realtime/server';
export const stripe = live.webhook('payments', {
  verify: ({ body, headers }) => JSON.parse(body),
  transform: (event) => ({ event: event.type, data: event.data })
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:hooks', {});

		// Webhook should NOT produce client stubs
		expect(code).not.toContain("__rpc('hooks/stripe'");
		expect(code).not.toContain("__stream('hooks/stripe'");
	});
});

// -- Schema evolution (Phase 42) ----------------------------------------------

describe('schema evolution', () => {
	afterEach(teardown);

	it('includes version in client stub options', () => {
		setup({
			'todos.js': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('todos', async (ctx) => [], {
  merge: 'crud', key: 'id', version: 3,
  migrate: {
    1: (item) => ({ ...item, priority: 'medium' }),
    2: (item) => ({ ...item, completed: false })
  }
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:todos', {});

		expect(code).toContain('"version":3');
		expect(code).toContain("__stream('todos/items'");
	});
});

// -- Balanced-brace option extraction -----------------------------------------

describe('stream option extraction with nested braces', () => {
	afterEach(teardown);

	it('extracts options correctly when init function body contains nested objects', () => {
		setup({
			'nested.js': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('items', async (ctx) => {
  const config = { local: true, nested: { deep: 1 } };
  return db.query(config);
}, { merge: 'set', key: 'item_id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:nested', { ssr: false });

		expect(code).toContain('"merge":"set"');
		expect(code).toContain('"key":"item_id"');
	});
});

// -- Server-side HMR ----------------------------------------------------------

describe('handleHotUpdate (server-side HMR)', () => {
	afterEach(teardown);

	function createMockServer() {
		const invalidated = [];
		const modulesById = new Map();
		const modulesByFile = new Map();
		const ssrModules = new Map();
		// Default: svelte-realtime/server returns HMR stubs
		ssrModules.set('svelte-realtime/server', {
			_prepareHmr: () => ({}),
			_restoreHmr: () => {},
		});
		ssrModules.set('/@svelte-realtime-registry', {});
		return {
			invalidated,
			modulesById,
			modulesByFile,
			ssrModules,
			moduleGraph: {
				getModuleById(id) { return modulesById.get(id) || null; },
				getModulesByFile(file) { return modulesByFile.get(file) || null; },
				invalidateModule(mod) { invalidated.push(mod); },
			},
			async ssrLoadModule(id) {
				const result = ssrModules.get(id);
				if (result instanceof Error) throw result;
				return result || {};
			},
		};
	}

	it('invalidates the registry virtual module on src/live/ file change', async () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const server = createMockServer();

		const registryMod = { id: '\0live:__registry' };
		const clientMod = { id: '\0live:chat' };
		server.modulesById.set('\0live:__registry', registryMod);
		server.modulesById.set('\0live:chat', clientMod);

		const chatFile = resolve(liveDir, 'chat.js');
		const result = await plugin.handleHotUpdate({ file: chatFile, server });

		expect(server.invalidated).toContain(registryMod);
		expect(server.invalidated).toContain(clientMod);
		expect(result).toEqual([clientMod]);
	});

	it('invalidates SSR modules by file path', async () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const server = createMockServer();
		const chatFile = resolve(liveDir, 'chat.js');

		const ssrMod = { id: chatFile };
		server.modulesByFile.set(chatFile, new Set([ssrMod]));

		await plugin.handleHotUpdate({ file: chatFile, server });

		expect(server.invalidated).toContain(ssrMod);
	});

	it('calls _prepareHmr before re-importing and does not call _restoreHmr on success', async () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const server = createMockServer();
		const chatFile = resolve(liveDir, 'chat.js');

		let prepared = false;
		let restored = false;
		server.ssrModules.set('svelte-realtime/server', {
			_prepareHmr: () => { prepared = true; return {}; },
			_restoreHmr: () => { restored = true; },
		});

		await plugin.handleHotUpdate({ file: chatFile, server });

		expect(prepared).toBe(true);
		expect(restored).toBe(false);
	});

	it('calls _restoreHmr when registry re-import fails', async () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const chatFile = resolve(liveDir, 'chat.js');

		let restored = false;
		const snap = { test: true };
		let loadCount = 0;

		const server = {
			moduleGraph: {
				getModuleById() { return null; },
				getModulesByFile() { return null; },
				invalidateModule() {},
			},
			async ssrLoadModule(id) {
				loadCount++;
				// First call: svelte-realtime/server (succeeds)
				if (loadCount === 1) {
					return {
						_prepareHmr: () => snap,
						_restoreHmr: (s) => { restored = true; expect(s).toBe(snap); },
					};
				}
				// Second call: registry re-import (fails)
				throw new Error('Syntax error in chat.js');
			},
		};

		const errors = [];
		const origError = console.error;
		console.error = (...args) => errors.push(args.join(' '));

		await plugin.handleHotUpdate({ file: chatFile, server });

		console.error = origError;

		expect(restored).toBe(true);
		expect(errors.some(e => e.includes('HMR failed'))).toBe(true);
		expect(errors.some(e => e.includes('Previous handlers restored'))).toBe(true);
	});

	it('ignores files outside liveDir', async () => {
		setup({
			'chat.js': `export const send = live(async () => {});`
		});

		const plugin = createPlugin();
		const server = createMockServer();

		const result = await plugin.handleHotUpdate({
			file: '/some/other/file.js',
			server,
		});

		expect(result).toBeUndefined();
		expect(server.invalidated).toHaveLength(0);
	});
});

// -- Import path escaping -----------------------------------------------------

describe('import path escaping', () => {
	afterEach(teardown);

	it('escapes single quotes in generated import paths', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		// The generated import path should be JSON.stringify'd (double-quoted)
		// so it never breaks if the path contains quotes
		expect(code).not.toContain("import('");
		expect(code).toContain('import("');
	});
});

// -- Duplicate topic detection ------------------------------------------------

describe('duplicate topic detection', () => {
	afterEach(teardown);

	it('throws when two streams use the same static topic', () => {
		setup({
			'a.js': `
import { live } from 'svelte-realtime/server';
export const feed1 = live.stream('same-topic', async () => [], { merge: 'crud' });
`,
			'b.js': `
import { live } from 'svelte-realtime/server';
export const feed2 = live.stream('same-topic', async () => [], { merge: 'crud' });
`
		});

		const plugin = createPlugin();
		expect(() => plugin.load('\0live:__registry', {})).toThrow('Duplicate stream topic');
	});

	it('throws when a stream uses a reserved __ prefix', () => {
		setup({
			'bad.js': `
import { live } from 'svelte-realtime/server';
export const feed = live.stream('__reserved', async () => [], { merge: 'crud' });
`
		});

		const plugin = createPlugin();
		expect(() => plugin.load('\0live:__registry', {})).toThrow('reserved');
	});
});

// -- Room sub-handler registry includes module path ---------------------------

describe('room sub-handler module path', () => {
	afterEach(teardown);

	it('passes module path to __register for room sub-handlers', () => {
		setup({
			'rooms.js': `
import { live } from 'svelte-realtime/server';
export const myRoom = live.room({
	topic: (ctx, id) => 'room:' + id,
	init: async (ctx, id) => [],
	presence: (ctx) => ({ name: 'test' }),
	cursors: true
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		// Room sub-handlers should get explicit module path 'rooms' (not 'rooms/myRoom')
		expect(code).toContain("__register('rooms/myRoom/__data'");
		expect(code).toContain(", 'rooms')");
		expect(code).toContain("__register('rooms/myRoom/__presence'");
		expect(code).toContain("__register('rooms/myRoom/__cursors'");
	});
});
