import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import svelteRealtime from '../src/vite.js';

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

// - resolveId ----------------------------------------------------------------

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

// - load (client stubs) ------------------------------------------------------

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
		expect(code).toContain('export const sendMessage = __rpc("chat/sendMessage")');
		expect(code).toContain('export const deleteMessage = __rpc("chat/deleteMessage")');
	});

	it('generates __rpc() stubs for live.volatile() exports', () => {
		setup({
			'cursors.js': `
import { live } from 'svelte-realtime/server';
export const moveCursor = live.volatile(async (ctx, boardId, pos) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:cursors', { ssr: false });

		expect(code).toContain("import { __rpc } from 'svelte-realtime/client'");
		expect(code).toContain('export const moveCursor = __rpc("cursors/moveCursor")');
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
		expect(code).toContain('export const messages = __stream("chat/messages"');
		expect(code).toContain('"merge":"crud"');
		expect(code).toContain('"key":"id"');
		expect(code).toContain('"prepend":true');
		expect(code).toContain("export { empty } from 'svelte-realtime/client'");
	});

	it('generates a SmoothEntity factory wiring command/sync/center for live.smooth() exports', () => {
		setup({
			'board.js': `
import { live } from 'svelte-realtime/server';
import { apply } from './board.shared.js';
export const shape = live.smooth({ topic: (ctx, id) => 'shape:' + id, apply, initial: { x: 0, y: 0 }, topicArgs: 1 });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:board', { ssr: false });

		expect(code).toContain("import { SmoothEntity } from 'svelte-realtime/smooth'");
		expect(code).toContain('_command: __rpc("board/shape/__smooth/command")');
		expect(code).toContain('_sync: __rpc("board/shape/__smooth/sync")');
		expect(code).toContain('_center: __rpc("board/shape/__smooth/center")');
		expect(code).toContain('_shoot: __rpc("board/shape/__smooth/shoot")');
		// The area-of-interest center wires the per-topic RPC into SmoothEntity's
		// third argument (the report fn), bound to the room args.
		expect(code).toContain('new SmoothEntity(channel, status, (center) => shape._center.fireAndForget(...roomArgs, center))');
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
		expect(code).toContain('export const addItem = __rpc("items/addItem")');
		expect(code).toContain('export const items = __stream("items/items"');
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

		expect(code).toContain('export const join = __rpc("rooms/lobby/join")');
	});

	it('generates __upload() stubs for live.upload() exports', () => {
		setup({
			'uploads.js': `
import { live } from 'svelte-realtime/server';
export const avatar = live.upload(async (ctx) => 'ok');
export const document = live.upload(async (ctx, name) => ({ name }), { maxSize: 50 * 1024 * 1024 });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:uploads', { ssr: false });

		expect(code).toContain("import { __upload } from 'svelte-realtime/client'");
		expect(code).toContain('export const avatar = __upload("uploads/avatar")');
		expect(code).toContain('export const document = __upload("uploads/document")');
	});

	it('mixes __binaryRpc and __upload in the same module', () => {
		setup({
			'mixed.js': `
import { live } from 'svelte-realtime/server';
export const small = live.binary(async (ctx, buffer) => 'ok');
export const big = live.upload(async (ctx) => 'ok');
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:mixed', { ssr: false });

		expect(code).toContain('export const small = __binaryRpc("mixed/small")');
		expect(code).toContain('export const big = __upload("mixed/big")');
		expect(code).toContain('__binaryRpc');
		expect(code).toContain('__upload');
	});
});

// - client stub HMR self-accept ---------------------------------------------

describe('client stub HMR self-accept', () => {
	afterEach(teardown);

	it('emits import.meta.hot.accept() for live() exports', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: false });

		expect(code).toContain('import.meta.hot');
		expect(code).toContain('import.meta.hot.accept()');
	});

	it('emits import.meta.hot.accept() for live.stream() exports', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const messages = live.stream('messages', async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: false });

		expect(code).toContain('import.meta.hot.accept()');
	});

	it('emits import.meta.hot.accept() for live.room() exports', () => {
		setup({
			'doc.js': `
import { live } from 'svelte-realtime/server';
export const room = live.room({
  topic: (ctx, id) => 'doc:' + id,
  load: async () => ({ items: [] }),
  presence: true,
  cursors: true
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:doc', { ssr: false });

		expect(code).toContain('import.meta.hot.accept()');
	});

	it('emits import.meta.hot.accept() even when the module has no live exports', () => {
		setup({
			'guard.js': `
import { guard } from 'svelte-realtime/server';
export const _guard = guard((ctx) => !!ctx.user);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:guard', { ssr: false });

		expect(code).toContain('import.meta.hot.accept()');
	});

	it('emits the accept directive after the export statements (so re-evaluation runs them first)', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: false });

		const acceptIdx = code.indexOf('import.meta.hot.accept()');
		const exportIdx = code.indexOf("export const send = __rpc(");
		expect(exportIdx).toBeGreaterThan(-1);
		expect(acceptIdx).toBeGreaterThan(exportIdx);
	});

	it('guards the accept call so the directive is dead code outside dev / Vite', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: false });

		// The accept call must be guarded by the truthy check on import.meta.hot
		// so production builds (where import.meta.hot is undefined) skip it
		// without throwing, and Vite's dead-code elimination strips it from
		// the production bundle entirely.
		expect(code).toMatch(/if\s*\(\s*import\.meta\.hot\s*\)\s*import\.meta\.hot\.accept\(\)/);
	});
});

// - load (SSR) ---------------------------------------------------------------

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

	it('wraps live.flag exports in a readable stub so $flag works during SSR', () => {
		setup({
			'flags.js': `
import { live } from 'svelte-realtime/server';
export const banner = live.flag('flag:banner', false);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:flags', { ssr: true });

		// The raw server export is a flag handle without .subscribe; SSR must
		// shadow it with a readable (static shape, matching the client stub).
		expect(code).toContain('const _banner = readable(undefined);');
		expect(code).toContain('_banner.hydrate = (d) => readable(d);');
		expect(code).toContain('__directCall("flags/banner"');
		expect(code).toContain('export { _banner as banner };');
	});

	it('multiplayer room() stub carries bindDoc returning the view (chainable, like the client)', () => {
		setup({
			'editor.js': `
import { live } from 'svelte-realtime/server';
export const editor = live.multiplayer({
	topic: (ctx, id) => 'editor:' + id,
	init: async () => ({}),
	presence: (ctx) => ({ id: ctx.user?.id }),
	selections: 'crdt'
});
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:editor', { ssr: true });

		// A page calling editor.room(id).bindDoc(doc) at component top level
		// must not crash during SSR; bindDoc chains back to the same view.
		expect(code).toContain('bindDoc: () => _v');
		expect(code).toMatch(/room: \(\) => \{ const _v = \{/);
	});
});

// - registry module ----------------------------------------------------------

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

		expect(code).toContain("import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate, __registerRoomActions, __registerFlag, __registerWebhookOut } from 'svelte-realtime/server'");
		expect(code).toContain('__register("chat/sendMessage"');
		expect(code).toContain('__register("chat/messages"');
		expect(code).toContain('__registerGuard("chat"');
	});

	it('handles multiple modules', () => {
		setup({
			'chat.js': `export const send = live(async () => {});`,
			'admin.js': `export const deleteUser = live(async () => {});`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain('__register("admin/deleteUser"');
		expect(code).toContain('__register("chat/send"');
	});

	it('registers the command, sync, center, and shoot handlers for a live.smooth() export', () => {
		setup({
			'board.js': `
import { live } from 'svelte-realtime/server';
import { apply } from './board.shared.js';
export const shape = live.smooth({ topic: (ctx, id) => 'shape:' + id, apply, initial: { x: 0, y: 0 }, topicArgs: 1 });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain('__register("board/shape/__smooth/command"');
		expect(code).toContain('__register("board/shape/__smooth/sync"');
		expect(code).toContain('__register("board/shape/__smooth/center"');
		expect(code).toContain('m.shape.__smoothCenter');
		// Regression: the shoot RPC must be registered server-side too, or the
		// client's _shoot.fireAndForget() hits an unregistered path and hitTest
		// onHit never fires (the wire path stays dead while sim tests pass).
		expect(code).toContain('__register("board/shape/__smooth/shoot"');
		expect(code).toContain('m.shape.__smoothShoot');
	});

	it('returns empty comment when no live dir exists', () => {
		teardown();
		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain('No live modules found');
	});
});

// - warnings -----------------------------------------------------------------

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

	describe('no-_guard build-time nudge', () => {
		function captureWarns(fn) {
			const warns = [];
			const orig = console.warn;
			console.warn = (...args) => warns.push(args.join(' '));
			try { fn(); } finally { console.warn = orig; }
			return warns;
		}

		it('warns when a module has live() exports but no _guard', () => {
			setup({
				'open.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, msg) => {});
export const sendBeacon = live(async (ctx, beacon) => {});
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:open', { ssr: false }));
			expect(warns.some(w => w.includes('but no _guard'))).toBe(true);
			expect(warns.some(w => w.includes('live.public'))).toBe(true);
			expect(warns.some(w => w.includes('realtime-allow-public'))).toBe(true);
		});

		it('does not warn when _guard is exported', () => {
			setup({
				'gated.js': `
import { live, guard } from 'svelte-realtime/server';
export const _guard = guard((ctx) => ctx.user != null);
export const send = live(async (ctx, msg) => {});
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:gated', { ssr: false }));
			expect(warns.some(w => w.includes('but no _guard'))).toBe(false);
		});

		it('does not warn when the module uses live.public()', () => {
			setup({
				'public.js': `
import { live } from 'svelte-realtime/server';
export const serverTime = live.public(async () => ({ now: Date.now() }));
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:public', { ssr: false }));
			expect(warns.some(w => w.includes('but no _guard'))).toBe(false);
		});

		it('does not warn when the module has a // realtime-allow-public comment', () => {
			setup({
				'opted-out.js': `
// realtime-allow-public
import { live } from 'svelte-realtime/server';
export const ping = live(async () => 'pong');
export const echo = live(async (ctx, msg) => msg);
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:opted-out', { ssr: false }));
			expect(warns.some(w => w.includes('but no _guard'))).toBe(false);
		});

		it('also accepts block-style /* realtime-allow-public */ comments', () => {
			setup({
				'opted-out-block.js': `
/* realtime-allow-public */
import { live } from 'svelte-realtime/server';
export const ping = live(async () => 'pong');
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:opted-out-block', { ssr: false }));
			expect(warns.some(w => w.includes('but no _guard'))).toBe(false);
		});

		it('does not warn when the module has only live.stream exports', () => {
			// Stream-only modules without a guard get the warning too -
			// streams are still authenticated-but-unauthorized handlers.
			setup({
				'stream-only.js': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('items:*', async (ctx) => []);
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:stream-only', { ssr: false }));
			expect(warns.some(w => w.includes('but no _guard'))).toBe(true);
		});

		it('warning names both opt-out paths and the URL', () => {
			setup({
				'verbose.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async () => {});
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:verbose', { ssr: false }));
			const w = warns.find(w => w.includes('but no _guard'));
			expect(w).toBeDefined();
			expect(w).toContain('_guard = guard(');
			expect(w).toContain('live.public(');
			expect(w).toContain('realtime-allow-public');
			expect(w).toContain('https://svti.me/guard');
		});

		it('mixed-shape module: one live() + one live.public() still warns the live()-only handler', () => {
			// With ANY live.public() in the module, we suppress per-module.
			// The audit's design intent: live.public() is module-level intent
			// signal; per-handler discipline is the dev's call.
			setup({
				'mixed.js': `
import { live } from 'svelte-realtime/server';
export const serverTime = live.public(async () => ({ now: Date.now() }));
export const send = live(async (ctx, msg) => {});
`
			});

			const plugin = createPlugin();
			const warns = captureWarns(() => plugin.load('\0live:mixed', { ssr: false }));
			expect(warns.some(w => w.includes('but no _guard'))).toBe(false);
		});
	});
});

// - defineTopics static-analysis warning ------------------------------------

describe('defineTopics static-analysis warning', () => {
	afterEach(teardown);

	function writeTopicsFile(relPath, content) {
		const full = resolve(testRoot, relPath);
		mkdirSync(resolve(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}

	function captureWarns(fn) {
		const warns = [];
		const orig = console.warn;
		console.warn = (...args) => warns.push(args.join(' '));
		try { fn(); } finally { console.warn = orig; }
		return warns;
	}

	it('does not warn when no defineTopics call exists anywhere', () => {
		setup({
			'feed.js': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('legacy:topic', async () => []);
`
		});

		const plugin = createPlugin();
		const warns = captureWarns(() => plugin.load('\0live:__registry', {}));
		expect(warns.some(w => w.includes('not in your TOPICS registry'))).toBe(false);
	});

	it('warns when string-literal topic does not match any registered pattern', () => {
		writeTopicsFile('src/lib/topics.js', `
import { defineTopics } from 'svelte-realtime/server';
export const TOPICS = defineTopics({
  audit: (orgId) => \`audit:\${orgId}\`,
  feed: 'feed:notices'
});
`);
		setup({
			'mystream.js': `
import { live } from 'svelte-realtime/server';
export const wrong = live.stream('mistyped-topic', async () => []);
`
		});

		const plugin = createPlugin();
		const warns = captureWarns(() => plugin.load('\0live:__registry', {}));
		expect(warns.some(w => w.includes("topic 'mistyped-topic' is not in your TOPICS registry"))).toBe(true);
	});

	it('does not warn when literal matches a static-string pattern', () => {
		writeTopicsFile('src/lib/topics.js', `
import { defineTopics } from 'svelte-realtime/server';
export const TOPICS = defineTopics({
  feed: 'feed:notices'
});
`);
		setup({
			'feed.js': `
import { live } from 'svelte-realtime/server';
export const items = live.stream('feed:notices', async () => []);
`
		});

		const plugin = createPlugin();
		const warns = captureWarns(() => plugin.load('\0live:__registry', {}));
		expect(warns.some(w => w.includes('not in your TOPICS registry'))).toBe(false);
	});

	it('does not warn when literal matches an arrow-function template pattern', () => {
		writeTopicsFile('src/lib/topics.js', `
import { defineTopics } from 'svelte-realtime/server';
export const TOPICS = defineTopics({
  audit: (orgId) => \`audit:\${orgId}\`,
  rooms: (orgId, room) => \`room:\${orgId}:\${room}\`
});
`);
		setup({
			'audit.js': `
import { live } from 'svelte-realtime/server';
export const auditFeed = live.stream('audit:org-123', async () => []);
`,
			'rooms.js': `
import { live } from 'svelte-realtime/server';
export const room = live.stream('room:org-1:lobby', async () => []);
`
		});

		const plugin = createPlugin();
		const warns = captureWarns(() => plugin.load('\0live:__registry', {}));
		const offending = warns.filter(w => w.includes('not in your TOPICS registry'));
		expect(offending).toEqual([]);
	});

	it('warns on live.channel() literals using the same registry', () => {
		writeTopicsFile('src/lib/topics.js', `
import { defineTopics } from 'svelte-realtime/server';
export const TOPICS = defineTopics({
  typing: (room) => \`typing:\${room}\`
});
`);
		setup({
			'channel.js': `
import { live } from 'svelte-realtime/server';
export const wrong = live.channel('not-a-channel', { merge: 'presence' });
`
		});

		const plugin = createPlugin();
		const warns = captureWarns(() => plugin.load('\0live:__registry', {}));
		expect(warns.some(w => w.includes("live.channel topic 'not-a-channel'") && w.includes('not in your TOPICS registry'))).toBe(true);
	});

	it('finds defineTopics calls in nested src subdirectories', () => {
		writeTopicsFile('src/server/contracts/topics.js', `
import { defineTopics } from 'svelte-realtime/server';
export const TOPICS = defineTopics({ heartbeat: 'sys:heartbeat' });
`);
		setup({
			'pulse.js': `
import { live } from 'svelte-realtime/server';
export const ok = live.stream('sys:heartbeat', async () => null);
export const bad = live.stream('sys:wrongbeat', async () => null);
`
		});

		const plugin = createPlugin();
		const warns = captureWarns(() => plugin.load('\0live:__registry', {}));
		expect(warns.some(w => w.includes("'sys:heartbeat'"))).toBe(false);
		expect(warns.some(w => w.includes("'sys:wrongbeat'") && w.includes('not in your TOPICS registry'))).toBe(true);
	});
});

// - hooks.ws.js detection ----------------------------------------------------

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

// - resolveId: /@svelte-realtime-registry (Finding 2) ------------------------

describe('resolveId (registry URL)', () => {
	it('resolves /@svelte-realtime-registry to the registry virtual module', () => {
		const plugin = createPlugin();
		expect(plugin.resolveId('/@svelte-realtime-registry')).toBe('\0live:__registry');
	});
});

// - config hook (Finding 2) --------------------------------------------------

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

// - dynamic topics ------------------------------------------------------------

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
		expect(code).toContain('export const roomMessages = __stream("rooms/roomMessages"');
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

		expect(code).toContain('export const items = __stream("items/items"');
		expect(code).not.toContain('true);'); // no isDynamic flag
	});

	// Single-arity ctx-only topic-fn - the secure-by-construction shape for
	// per-user / per-tenant streams. Before the arity-aware fix these were
	// classified as dynamic factories, leaving the natural `myStream.subscribe`
	// call shape with a runtime TypeError. The runtime side already supports
	// the static call (server _callTopicFn passes ctx and ignores empty args);
	// only the plugin classification was wrong.
	it('topic-fn with only a ctx param is treated as static', () => {
		setup({
			'events.js': `
import { live } from 'svelte-realtime/server';
export const myEvents = live.stream(
  (ctx) => 'events:' + ctx.user.id,
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:events', { ssr: false });

		expect(code).toContain('export const myEvents = __stream("events/myEvents"');
		expect(code).not.toContain('true);');
	});

	it('topic-fn with zero params is treated as static', () => {
		setup({
			'global.js': `
import { live } from 'svelte-realtime/server';
export const everyone = live.stream(
  () => 'global',
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:global', { ssr: false });

		expect(code).toContain('export const everyone = __stream("global/everyone"');
		expect(code).not.toContain('true);');
	});

	it('topic-fn named context (instead of ctx) is treated as static', () => {
		setup({
			'a.js': `
import { live } from 'svelte-realtime/server';
export const feed = live.stream(
  (context) => 'feed:' + context.user.id,
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:a', { ssr: false });

		expect(code).toContain('export const feed = __stream("a/feed"');
		expect(code).not.toContain('true);');
	});

	it('topic-fn named _ctx (TS noUnusedParameters) is treated as static', () => {
		setup({
			'b.js': `
import { live } from 'svelte-realtime/server';
export const ping = live.stream(
  (_ctx) => 'ping',
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:b', { ssr: false });

		expect(code).toContain('export const ping = __stream("b/ping"');
		expect(code).not.toContain('true);');
	});

	it('topic-fn typed as LiveContext is treated as static', () => {
		setup({
			'c.ts': `
import { live } from 'svelte-realtime/server';
import type { LiveContext } from 'svelte-realtime/server';
export const inbox = live.stream(
  (ctx: LiveContext) => 'inbox:' + ctx.user.id,
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:c', { ssr: false });

		expect(code).toContain('export const inbox = __stream("c/inbox"');
		expect(code).not.toContain('true);');
	});

	it('async single-arity ctx-only topic-fn is treated as static', () => {
		setup({
			'd.js': `
import { live } from 'svelte-realtime/server';
export const live_inbox = live.stream(
  async (ctx) => 'inbox:' + ctx.user.id,
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:d', { ssr: false });

		expect(code).toContain('export const live_inbox = __stream("d/live_inbox"');
		expect(code).not.toContain('true);');
	});

	it('non-arrow function-expression with ctx param is treated as static', () => {
		setup({
			'e.js': `
import { live } from 'svelte-realtime/server';
export const profile = live.stream(
  function (ctx) { return 'profile:' + ctx.user.id; },
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:e', { ssr: false });

		expect(code).toContain('export const profile = __stream("e/profile"');
		expect(code).not.toContain('true);');
	});

	// Single-param topic-fn where the param is NOT ctx-shaped: the server's
	// arity dispatch interprets this as "user omitted ctx, single client arg".
	// Plugin must agree - emit a dynamic factory so the client passes args.
	it('single non-ctx param is treated as dynamic (omitted-ctx + 1 client arg)', () => {
		setup({
			'f.js': `
import { live } from 'svelte-realtime/server';
export const room = live.stream(
  (roomId) => 'room:' + roomId,
  async (ctx, roomId) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:f', { ssr: false });

		expect(code).toContain('export const room = __stream("f/room"');
		expect(code).toContain('true);');
	});

	// Destructured first param is ambiguous (could be ctx or payload). Match
	// the existing safe fallback in _extractDynamicFactoryParams: stay
	// dynamic so the server's arity dispatch can call fn(payload).
	it('destructured first param stays dynamic (ambiguity fallback)', () => {
		setup({
			'g.js': `
import { live } from 'svelte-realtime/server';
export const feed = live.stream(
  ({ roomId }) => 'feed:' + roomId,
  async (ctx, args) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:g', { ssr: false });

		expect(code).toContain('export const feed = __stream("g/feed"');
		expect(code).toContain('true);');
	});

	// Same arity logic must apply to the .d.ts emission so the typed surface
	// matches the runtime stub. A static stub typed as a factory is the
	// original bug; a static stub typed as StreamStore is the fix.
	it('emits StreamStore (not factory) in .d.ts for single-arity ctx-only topic', () => {
		setup({
			'inbox.ts': `
import { live } from 'svelte-realtime/server';
import type { LiveContext } from 'svelte-realtime/server';
export const inbox = live.stream(
  (ctx: LiveContext) => 'inbox:' + ctx.user.id,
  async (ctx) => [],
  { merge: 'set' }
);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/inbox'");
		// Static shape: bare StreamStore, no `(...) =>` factory wrapper before the &
		expect(content).toMatch(/export const inbox: StreamStore<[^>]+> & \{ load\(/);
		expect(content).not.toMatch(/export const inbox: \([^)]*\) => StreamStore/);
	});
});

// - path traversal (Finding 6) -----------------------------------------------

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

// - Type declarations ---------------------------------------------------------

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
		expect(content).toContain('export const empty: Readable<undefined>');
	});

	it('emits UploadHandle types for live.upload() exports', () => {
		setup({
			'uploads.js': `
import { live } from 'svelte-realtime/server';
export const avatar = live.upload(async (ctx, name) => ({ name }));
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/uploads'");
		expect(content).toContain('UploadHandle');
		expect(content).toContain("import type { UploadHandle } from 'svelte-realtime/client'");
		expect(content).toMatch(/avatar:\s*\(source:\s*Blob\s*\|\s*ArrayBuffer/);
		expect(content).toContain('UploadHandle<any>');
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
		expect(content).toContain("import type { Readable } from 'svelte/store'");
		expect(content).toContain("export const empty: Readable<undefined>");
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
		expect(content).toContain('load(platform: any, options?: { args?: any[]; user?: any; fallback?: any; onError?: (err: any) => void }): Promise<Item[]>');
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
		expect(content).toContain('load(platform: any, options?: { args?: any[]; user?: any; fallback?: any; onError?: (err: any) => void }): Promise<Note[]>');
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
		expect(content).toContain('StreamStore<any> & { load(platform: any, options?: { args?: any[]; user?: any; fallback?: any; onError?: (err: any) => void }): Promise<any> }');
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

	it('types the .load() fallback and onError SSR-degradation options', () => {
		setup({
			'feed.js': `
import { live } from 'svelte-realtime/server';
export const feed = live.stream('feed', async () => []);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain('fallback?: any; onError?: (err: any) => void');
	});
});

// - live.validated() client stubs ---------------------------------

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
		expect(code).toContain('export const submit = __rpc("forms/submit")');
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

// - live.cron() registration --------------------------------------

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

		expect(code).toContain('__registerCron("jobs/refreshStats"');
		expect(code).toContain("import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate, __registerRoomActions, __registerFlag, __registerWebhookOut }");
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
		expect(code).not.toContain('__rpc("cron/tick")")');
		expect(code).not.toContain('__stream("cron/tick")")');
		// Should not warn about unwrapped export
		expect(warns.some(w => w.includes("'tick'") && w.includes('not wrapped'))).toBe(false);
	});
});

// - SSR stubs with .load() ----------------------------------------

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
		expect(code).toContain("_messages.hydrate = (d) => readable(d)");
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
		expect(code).toContain("const _notes = (...args) => { const s = readable(undefined); s.hydrate = (d) => readable(d); return s; }");
		expect(code).toContain('_notes.load = (platform, options) => __directCall("board/notes"');
		expect(code).toContain("export { _notes as notes }");
	});

	it('SSR stub uses static readable shape for ctx-only topic (parity with client stub)', () => {
		// Regression: vite.js's `_isDynamicExport` was updated in 0.5.0-next.8
		// to classify single-arity ctx-only topics as static, but the SSR
		// generator continued to use the older arity-blind regex. Result:
		// client stub said "static StreamStore" while SSR stub said "factory
		// function" - pages compiled against the static shape would call
		// `factory.subscribe(...)` during SSR and crash with "store.subscribe
		// is not a function". This test pins them to agree.
		setup({
			'auth.js': `
import { live } from 'svelte-realtime/server';
export const inbox = live.stream(
	(ctx) => 'inbox:' + ctx.user.id,
	(ctx) => [],
	{ merge: 'crud', key: 'id' }
);
`
		});

		const plugin = createPlugin();

		const ssrCode = plugin.load('\0live:auth', { ssr: true });
		// Static SSR shape: a readable directly, NOT a factory
		expect(ssrCode).toContain("const _inbox = readable(undefined)");
		expect(ssrCode).not.toMatch(/const _inbox = \(\.\.\.args\) =>/);

		const clientCode = plugin.load('\0live:auth', { ssr: false });
		// Static client shape: __stream(path, options) - NO trailing `, true`
		// (which would mark it dynamic). The trailing arg is what
		// _generateClientStubs emits for dynamic exports.
		expect(clientCode).toMatch(/__stream\("auth\/inbox",\s*\{[^}]*\}\);/);
		expect(clientCode).not.toMatch(/__stream\("auth\/inbox",[\s\S]*,\s*true\)/);
	});

	it('SSR stub uses factory shape for ctx + client-arg topic (parity with client stub)', () => {
		// Mirror of the above for the genuinely-dynamic case: when the topic
		// function takes a client arg in addition to ctx, both SSR and client
		// stubs emit factory shape. Single source of truth via
		// `_isDynamicExport`.
		setup({
			'rooms.js': `
import { live } from 'svelte-realtime/server';
export const messages = live.stream(
	(ctx, roomId) => 'room:' + roomId,
	(ctx, roomId) => [],
	{ merge: 'crud', key: 'id' }
);
`
		});

		const plugin = createPlugin();

		const ssrCode = plugin.load('\0live:rooms', { ssr: true });
		expect(ssrCode).toContain("const _messages = (...args) =>");

		const clientCode = plugin.load('\0live:rooms', { ssr: false });
		expect(clientCode).toMatch(/__stream\("rooms\/messages",[\s\S]*,\s*true\);/);
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

	it('static stream SSR stub has .hydrate() that returns readable with data', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const messages = live.stream('messages', async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', { ssr: true });

		expect(code).toContain("_messages.hydrate = (d) => readable(d)");
	});

	it('dynamic stream SSR stub factory returns store with .hydrate()', () => {
		setup({
			'board.js': `
import { live } from 'svelte-realtime/server';
export const notes = live.stream((boardId) => 'notes/' + boardId, async (ctx) => [], { merge: 'crud', key: 'id' });
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:board', { ssr: true });

		expect(code).toContain("s.hydrate = (d) => readable(d)");
	});
});

// - Replay option extraction --------------------------------------

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

// - DevTools injection --------------------------------------------

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

// - live.validated() type declarations ----------------------------

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

// - live.derived() client stubs and registry ---------------------------------

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

		expect(code).toContain('__stream("stats/summary"');
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

		expect(code).toContain('__register("stats/summary"');
		expect(code).toContain('__registerDerived("stats/summary"');
	});

	it('generates dynamic __stream client stub for dynamic derived exports', () => {
		setup({
			'dashboard.js': [
				"import { live } from 'svelte-realtime/server';",
				'export const stats = live.derived(',
				'  (orgId) => ["members:" + orgId, "emails:" + orgId],',
				'  async (ctx, orgId) => {',
				'    return { members: 42, emails: 100 };',
				'  },',
				'  { debounce: 100 }',
				');'
			].join('\n')
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:dashboard', {});

		expect(code).toContain('__stream("dashboard/stats"');
		expect(code).toContain(', true)');
		expect(code).toContain("import { __stream }");
	});

	it('generates SSR factory for dynamic derived', () => {
		setup({
			'dashboard.js': [
				"import { live } from 'svelte-realtime/server';",
				'export const stats = live.derived(',
				'  (orgId) => ["members:" + orgId],',
				'  async (ctx, orgId) => ({ count: 0 })',
				');'
			].join('\n')
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:dashboard', { ssr: true });

		expect(code).toContain('(...args)');
	});
});

// - live.flag() client stubs and registry ------------------------------------

describe('live.flag() vite integration', () => {
	afterEach(teardown);

	it('generates a set-merge __stream client stub for flag exports', () => {
		setup({
			'flags.js': `
import { live } from 'svelte-realtime/server';
export const maintenance = live.flag('flag:maintenance', false);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:flags', { ssr: false });

		expect(code).toContain("import { __stream } from 'svelte-realtime/client'");
		expect(code).toContain('export const maintenance = __stream("flags/maintenance"');
		expect(code).toContain('"merge":"set"');
	});

	it('registers a flag as a plain stream (no __registerDerived)', () => {
		setup({
			'flags.js': `
import { live } from 'svelte-realtime/server';
export const maintenance = live.flag('flag:maintenance', false);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain('__register("flags/maintenance"');
		expect(code).not.toContain('__registerDerived("flags/maintenance"');
	});

	it('emits an eager __registerFlag with the topic and a static initial value', () => {
		setup({
			'flags.js': `
import { live } from 'svelte-realtime/server';
export const maintenance = live.flag('flag:maintenance', false);
export const rollout = live.flag('flag:rollout', 'green');
export const bare = live.flag('flag:bare');
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		// Watcher install is hoisted to registry load (eager), keyed by topic,
		// alongside the lazy stream __register.
		expect(code).toContain('__registerFlag("flag:maintenance", false)');
		expect(code).toContain('__registerFlag("flag:rollout", "green")');
		// A flag with no static initial value still installs the watcher.
		expect(code).toContain('__registerFlag("flag:bare")');
		// __registerFlag must be imported.
		expect(code).toContain('__registerFlag');
	});

	it('omits a non-literal initial value from __registerFlag (watcher still installs)', () => {
		setup({
			'flags.js': `
import { live } from 'svelte-realtime/server';
const computed = Math.random() > 0.5;
export const dynamic = live.flag('flag:dynamic', computed);
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		// Non-literal second arg is not forwarded - the registry never evaluates
		// user expressions - but the watcher install is still emitted.
		expect(code).toContain('__registerFlag("flag:dynamic")');
		expect(code).not.toContain('computed');
	});

	it('emits a StreamStore type for flag exports', () => {
		setup({
			'flags.js': `
import { live } from 'svelte-realtime/server';
export const maintenance = live.flag('flag:maintenance', false);
`
		});

		const plugin = createPlugin();
		plugin.buildStart();

		const content = readFileSync(resolve(liveDir, '$types.d.ts'), 'utf-8');
		expect(content).toContain("declare module '$live/flags'");
		expect(content).toContain('maintenance');
		expect(content).toContain('StreamStore<any>');
	});
});

// - live.room() client stubs -------------------------------------------------

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
		expect(code).toContain('data: __stream("collab/board/__data"');
		expect(code).toContain('presence: __stream("collab/board/__presence"');
		expect(code).toContain('cursors: __stream("collab/board/__cursors"');
		expect(code).toContain('addCard: __rpc("collab/board/__action/addCard")');
		expect(code).toContain('removeCard: __rpc("collab/board/__action/removeCard")');
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

		expect(code).toContain('__register("rooms/chat/__data"');
		expect(code).toContain('__registerRoomActions("rooms/chat"');
	});
});

// - Parser robustness --------------------------------------------------------

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

		expect(code).toContain('send: __rpc("board/board/__action/send")');
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

		expect(code).toContain('presence: __stream("room/game/__presence"');
		expect(code).toContain('move: __rpc("room/game/__action/move")');
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

// - live.channel() client stubs -----------------------------------

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
		expect(code).toContain('__stream("collab/typing"');
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

		expect(code).toContain('__stream("collab/cursors"');
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

		expect(code).toContain('__register("collab/typing"');
	});
});

// - live.webhook() client stubs ----------------------------------------------

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
		expect(code).not.toContain('__rpc("hooks/stripe"');
		expect(code).not.toContain('__stream("hooks/stripe"');
	});
});

describe('live.webhooks.outbound() vite integration', () => {
	afterEach(teardown);

	it('registers outbound webhooks server-side via __registerWebhookOut', () => {
		setup({
			'hooks.js': `
import { live } from 'svelte-realtime/server';
export const notifySlack = live.webhooks.outbound(['alerts'], { url: 'https://hooks.example.com/x' });
`
		});
		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});
		expect(code).toContain('__registerWebhookOut("hooks/notifySlack"');
	});

	it('does not generate a client stub for inbound or outbound webhooks', () => {
		setup({
			'hooks.js': `
import { live } from 'svelte-realtime/server';
export const inHook = live.webhooks.inbound('payments', { verify: ({ body }) => JSON.parse(body), transform: (e) => ({ event: 'created', data: e }) });
export const outHook = live.webhooks.outbound(['alerts'], { url: 'https://hooks.example.com/x' });
`
		});
		const plugin = createPlugin();
		const code = plugin.load('\0live:hooks', {});
		expect(code).not.toContain('__rpc("hooks/inHook"');
		expect(code).not.toContain('__stream("hooks/inHook"');
		expect(code).not.toContain('__rpc("hooks/outHook"');
		expect(code).not.toContain('__stream("hooks/outHook"');
	});
});

// - Schema evolution ----------------------------------------------

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
		expect(code).toContain('__stream("todos/items"');
	});
});

// - Balanced-brace option extraction -----------------------------------------

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

// - Server-side HMR ----------------------------------------------------------

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

// - Import path escaping -----------------------------------------------------

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

// - Codegen path injection ----------------------------------------------

describe('codegen path quoting (hostile module + relative paths)', () => {
	afterEach(teardown);

	it('JSON-quotes RPC module paths in client stubs (no single-quote interpolation)', () => {
		setup({
			'chat.js': `
import { live } from 'svelte-realtime/server';
export const send = live(async (ctx, text) => {});
export const fetch = live(async (ctx) => 'data');
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:chat', {});

		// Pre-fix: __rpc('chat/send'); / __rpc('chat/fetch');
		// Post-fix: __rpc("chat/send"); / __rpc("chat/fetch");
		// The single-quote interpolation form is the BREACH point that lets
		// a path containing `'` escape the literal.
		expect(code).not.toMatch(/__rpc\('/);
		expect(code).toMatch(/__rpc\("chat\/send"\)/);
		expect(code).toMatch(/__rpc\("chat\/fetch"\)/);
	});

	it('JSON-quotes registration paths in the server registry (no single-quote interpolation)', () => {
		setup({
			'foo.js': `
import { live, guard } from 'svelte-realtime/server';
export const _guard = guard(() => {});
export const handler = live(async (ctx) => 'ok');
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		// Pre-fix: __register('foo/handler', ...) / __registerGuard('foo', ...)
		// Post-fix: __register("foo/handler", ...) / __registerGuard("foo", ...)
		expect(code).not.toMatch(/__register\('/);
		expect(code).not.toMatch(/__registerGuard\('/);
		expect(code).toMatch(/__register\("foo\/handler"/);
		expect(code).toMatch(/__registerGuard\("foo"/);
	});

	it('produces parseable JS even when the relative path contains a single quote', () => {
		// Filenames containing `'` are legal on Windows and most Unixes; a
		// hostile dependency or a co-developer's bad rename can introduce
		// one. Pre-fix, that path got dropped verbatim into a single-quoted
		// JS string literal in the generated registry, breaking out into a
		// syntax error at best (build fails) and arbitrary expression at
		// worst (Codex's PoC was an RCE in the generated server bundle).
		setup({
			"weird'name.js": `
import { live } from 'svelte-realtime/server';
export const handler = live(async (ctx) => 'ok');
`
		});

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		// Treat the registry as a freshly-generated script and parse it.
		// Pre-fix this throws a SyntaxError because the embedded `'` ends
		// the string literal early; post-fix it parses cleanly because
		// JSON.stringify wraps the path in `"..."` and escapes inner `"`.
		// Strip the leading ESM `import` statement so the body parses
		// inside `new Function` (which forbids ESM syntax). The lazy
		// `__L` helper line is preserved as part of the body.
		const body = code
			.split('\n')
			.filter((l) => !l.startsWith('import '))
			.join('\n');
		expect(() => new Function(
			'__register', '__registerGuard', '__registerCron',
			'__registerDerived', '__registerEffect', '__registerAggregate',
			'__registerRoomActions',
			body
		)).not.toThrow();
	});
});

// - Duplicate topic detection ------------------------------------------------

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

// - Room sub-handler registry includes module path ---------------------------

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
		expect(code).toContain('__register("rooms/myRoom/__data"');
		expect(code).toContain(', "rooms")');
		expect(code).toContain('__register("rooms/myRoom/__presence"');
		expect(code).toContain('__register("rooms/myRoom/__cursors"');
	});
});
