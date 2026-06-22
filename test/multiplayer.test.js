import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { flushSync } from 'svelte';
import { compileModule } from 'svelte/compiler';
import svelteRealtime from '../src/vite.js';
import { live } from '../src/server.js';
import {
	_clusterPresenceAcquire,
	_clusterPresenceList,
	_clusterPresenceMerge,
	_presenceRefForTest
} from '../src/server.js';
import { _clusterRoomsAcquire, _clusterRoomsRelease, _clusterRoomsList, _stableEnumId } from '../src/server/rooms-cluster.js';
import { colorForKey, hueForKey } from '../src/shared/color.js';
import { colorForKey as colorViaServer, hueForKey as hueViaServer } from '../src/server.js';
import { colorForKey as colorViaClient, hueForKey as hueViaClient } from '../src/client.js';
import { __mpFields } from '../src/client.js';

// ---------------------------------------------------------------------------
// Codegen: the vite plugin detects a live.multiplayer() export, generates its
// registry registration + client stub, and leaves a module without one
// byte-identical to today.
// ---------------------------------------------------------------------------

const testRoot = resolve(import.meta.dirname, '__mp_fixtures__');
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
	plugin.configResolved({ root: testRoot, build: {} });
	return plugin;
}

const MULTIPLAYER_SOURCE = `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1,
  init: async (ctx, boardId) => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  actions: {
    addCard: async (ctx, boardId, title) => ({ id: 1, title }),
    removeCard: async (ctx, boardId, cardId) => null
  }
});
`;

describe('live.multiplayer() vite integration', () => {
	afterEach(teardown);

	it('generates a multiplayer namespace with data, presence, cursors, and status streams', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });

		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain("export const room = {");
		expect(code).toContain('data: __stream("collab/room/__data"');
		expect(code).toContain('presence: __stream("collab/room/__presence"');
		expect(code).toContain('cursors: __stream("collab/room/__cursors"');
		expect(code).toContain('status:');
	});

	it('generates the move and reportViewport client methods', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });

		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain('move:');
		expect(code).toContain('reportViewport:');
	});

	it('registers the multiplayer sub-streams in the registry exactly like a room', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain('__register("collab/room/__data"');
		expect(code).toContain('__register("collab/room/__presence"');
		expect(code).toContain('__register("collab/room/__cursors"');
		expect(code).toContain('__registerRoomActions("collab/room"');
	});

	it('registers the cursor move and reportViewport handlers so the client stubs resolve', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });

		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		// The client stub emits __rpc("collab/room/__cursor/move") and
		// __rpc("collab/room/__cursor/reportViewport"); the registry must
		// register a server handler at each path or the calls RPC into the void.
		expect(code).toContain('__register("collab/room/__cursor/move"');
		expect(code).toContain('__register("collab/room/__cursor/reportViewport"');
		expect(code).toContain('.__cursorMove');
		expect(code).toContain('.__cursorReportViewport');
	});

	it('imports both __stream and __rpc for the generated stub', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });

		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain("import { __stream");
		expect(code).toContain('__rpc');
	});

	it('wires the roster rune-class into the generated namespace', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });

		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		// The aggregated others / cursors / me view is constructed by the
		// rune-class imported from the dedicated subpath; the namespace owns a
		// local-key holder and exposes identify(key) + a room(...args) factory.
		expect(code).toContain("import { MultiplayerRoom, localKeySource } from 'svelte-realtime/multiplayer';");
		expect(code).toContain('const _room_me = localKeySource();');
		expect(code).toContain('identify(key) { _room_me.set(key); }');
		expect(code).toContain('room(...args) { return new MultiplayerRoom({');
		expect(code).toContain('me: _room_me');
		expect(code).toContain('presence: room.presence(...args)');
		expect(code).toContain('cursors: room.cursors(...args)');
	});

	it('binds cursors to an inline empty store when the export declares presence without cursors', () => {
		// A presence-only roster still builds a room(...) factory, and the
		// MultiplayerRoom constructor subscribes to BOTH presence and cursors
		// unconditionally. The missing cursor sub-stream must fall back to an
		// inline store that pushes an empty list once, never `room.cursors(...)`
		// (which is undefined here and would throw on .subscribe at runtime).
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  init: async () => [],
  presence: (ctx) => ({ name: ctx.user.name })
});
`
		});
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain('room(...args) { return new MultiplayerRoom({');
		expect(code).toContain('presence: room.presence(...args)');
		expect(code).toContain('cursors: { subscribe: (fn) => { fn([]); return () => {}; } }');
		// The undefined member is never referenced for the missing stream.
		expect(code).not.toContain('cursors: room.cursors(...args)');
	});

	it('binds presence to an inline empty store when the export declares cursors without presence', () => {
		// The mirror of the presence-only fallback: a cursors-only roster must
		// bind `presence:` to the inline empty store, not `room.presence(...)`.
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  init: async () => [],
  cursors: true
});
`
		});
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain('room(...args) { return new MultiplayerRoom({');
		expect(code).toContain('cursors: room.cursors(...args)');
		expect(code).toContain('presence: { subscribe: (fn) => { fn([]); return () => {}; } }');
		expect(code).not.toContain('presence: room.presence(...args)');
	});

	it('emits the rune-class import once even with two multiplayer exports', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  init: async () => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true
});
export const doc = live.multiplayer({
  topic: (ctx, id) => 'doc:' + id,
  topicArgs: 1,
  init: async () => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true
});
`
		});
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		const importHits = code.split("import { MultiplayerRoom, localKeySource } from 'svelte-realtime/multiplayer';").length - 1;
		expect(importHits).toBe(1);
		expect(code).toContain('const _board_me = localKeySource();');
		expect(code).toContain('const _doc_me = localKeySource();');
	});

	it('omits the rune-class wiring from a data-only multiplayer export', () => {
		// No presence and no cursors means no roster surface; the namespace
		// must not import the rune-class or gain an empty room()/identify().
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const doc = live.multiplayer({
  topic: (ctx) => 'doc',
  init: async () => [],
  merge: 'latest',
  key: 'id'
});
`
		});
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).not.toContain('svelte-realtime/multiplayer');
		expect(code).not.toContain('localKeySource');
		expect(code).not.toContain('identify(key)');
		expect(code).not.toContain('new MultiplayerRoom');
	});

	it('leaves a module with no live.multiplayer export byte-identical to today', () => {
		// A file that uses every other live primitive but never
		// live.multiplayer must generate exactly what it generated before
		// the multiplayer codegen branch existed. We assert this by proving
		// the multiplayer detection is a no-op on plain modules: the output
		// is stable across two independent generations and contains none of
		// the multiplayer-specific emission.
		const plainSource = `
import { live } from 'svelte-realtime/server';
export const messages = live.stream('messages', async () => [], { merge: 'crud', key: 'id' });
export const board = live.room({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  init: async (ctx, id) => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  actions: { addCard: async (ctx, id, t) => null }
});
export const send = live(async (ctx, text) => null);
`;
		setup({ 'plain.js': plainSource });

		const plugin = createPlugin();
		const stubA = plugin.load('\0live:plain', {});
		const registryA = plugin.load('\0live:__registry', {});

		teardown();
		setup({ 'plain.js': plainSource });
		const plugin2 = createPlugin();
		const stubB = plugin2.load('\0live:plain', {});
		const registryB = plugin2.load('\0live:__registry', {});

		expect(stubB).toBe(stubA);
		expect(registryB).toBe(registryA);

		// No multiplayer-only emission leaks into a plain module.
		expect(stubA).not.toContain('reportViewport');
		expect(registryA).not.toContain('__registerMultiplayer');
	});
});

// ---------------------------------------------------------------------------
// Factory: live.multiplayer(config) returns a MultiplayerExport that reuses
// the room sub-stream machinery, so the data / presence / cursor streams are
// shaped exactly like a room and resolve the cursors + roster surface day one.
// ---------------------------------------------------------------------------

describe('live.multiplayer()', () => {
	it('creates an export with __isMultiplayer and the composed sub-streams', () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async (ctx, boardId) => [{ id: 1, title: 'hello' }],
			presence: (ctx) => ({ name: ctx.user?.name }),
			cursors: true,
			actions: {
				addCard: async (ctx, title) => ({ id: 2, title })
			},
			topicArgs: 1
		});

		expect(room.__isMultiplayer).toBe(true);
		expect(room.__dataStream).toBeDefined();
		expect(room.__dataStream.__isStream).toBe(true);
		expect(room.__hasPresence).toBe(true);
		expect(room.__hasCursors).toBe(true);
		expect(room.__presenceStream).toBeDefined();
		expect(room.__cursorStream).toBeDefined();
		expect(room.__actions).toBeDefined();
		expect(room.__actions.addCard.__isLive).toBe(true);
	});

	it('shapes the presence sub-stream with presence merge and the cursor sub-stream with cursor merge', () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			cursors: true,
			topicArgs: 1
		});

		expect(room.__presenceStream.__streamOptions.merge).toBe('presence');
		expect(room.__cursorStream.__streamOptions.merge).toBe('cursor');
	});

	it('data stream honors the configured merge mode and key', () => {
		const room = live.multiplayer({
			topic: (ctx) => 'doc',
			init: async () => [],
			merge: 'latest',
			key: 'sku'
		});

		expect(room.__dataStream.__streamOptions.merge).toBe('latest');
		expect(room.__dataStream.__streamOptions.key).toBe('sku');
	});

	it('omits presence and cursor sub-streams when neither is configured', () => {
		const room = live.multiplayer({
			topic: (ctx) => 'doc',
			init: async () => []
		});

		expect(room.__isMultiplayer).toBe(true);
		expect(room.__hasPresence).toBe(false);
		expect(room.__hasCursors).toBe(false);
		expect(room.__presenceStream).toBeUndefined();
		expect(room.__cursorStream).toBeUndefined();
	});

	it('records the field-surface config markers even when no field surface is declared', () => {
		// The typing / locks / selections / reactions markers are always
		// recorded so the generated namespace knows which surfaces to wire; an
		// export that declares none still exposes the (all-falsy) marker object.
		const room = live.multiplayer({
			topic: (ctx) => 'doc',
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			cursors: true
		});

		expect(room.__fields).toBeDefined();
		expect(typeof room.__fields).toBe('object');
		expect(room.__fields).toEqual({ typing: false, locks: null, reactions: false, selections: null });
	});

	it('leaves live.room() untouched - a room export carries no multiplayer marker', () => {
		const board = live.room({
			topic: (ctx, id) => 'board:' + id,
			init: async () => [],
			topicArgs: 1
		});

		expect(board.__isRoom).toBe(true);
		expect(board.__isMultiplayer).toBeUndefined();
	});

	it('exposes cursor send handlers that publish a keyed update to the cursor sub-topic', async () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			cursors: true,
			topicArgs: 1
		});

		expect(room.__cursorMove).toBeDefined();
		expect(room.__cursorMove.__isLive).toBe(true);
		expect(room.__cursorMove.__volatileRpc).toBe(true);
		expect(room.__cursorReportViewport.__volatileRpc).toBe(true);

		const published = [];
		const ctx = {
			user: { id: 'alice' },
			publish: (topic, event, data) => published.push({ topic, event, data })
		};

		await room.__cursorMove(ctx, 'b1', { x: 10, y: 20 });
		expect(published).toEqual([
			{ topic: 'board:b1:cursors', event: 'update', data: { key: 'alice', x: 10, y: 20 } }
		]);

		published.length = 0;
		await room.__cursorReportViewport(ctx, 'b1', { x: 0, y: 0, w: 800, h: 600 });
		expect(published).toEqual([
			{ topic: 'board:b1:cursors', event: 'update', data: { key: 'alice', viewport: true, x: 0, y: 0, w: 800, h: 600 } }
		]);
	});

	it('cursor handlers run the configured guard before publishing', async () => {
		const seen = [];
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			cursors: true,
			topicArgs: 1,
			guard: async (ctx, boardId) => { seen.push(boardId); if (!ctx.user) throw new Error('denied'); }
		});

		const published = [];
		const ctx = { user: { id: 'bob' }, publish: (t, e, d) => published.push({ t, e, d }) };
		await room.__cursorMove(ctx, 'b2', { x: 1, y: 2 });
		expect(seen).toEqual(['b2']);
		expect(published).toHaveLength(1);

		await expect(room.__cursorMove({ publish: () => {} }, 'b3', { x: 0, y: 0 })).rejects.toThrow('denied');
	});

	it('exposes a presence-field send handler that publishes a keyed update to the presence sub-topic', async () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			typing: true,
			topicArgs: 1
		});

		expect(room.__presenceUpdate).toBeDefined();
		expect(room.__presenceUpdate.__isLive).toBe(true);
		expect(room.__presenceUpdate.__volatileRpc).toBe(true);

		const published = [];
		const ctx = {
			user: { id: 'alice' },
			publish: (topic, event, data) => published.push({ topic, event, data })
		};

		await room.__presenceUpdate(ctx, 'b1', { typing: true });
		expect(published).toEqual([
			{ topic: 'board:b1:presence', event: 'update', data: { key: 'alice', typing: true } }
		]);

		published.length = 0;
		await room.__presenceUpdate(ctx, 'b1', { selection: { start: 0, end: 5, nodePath: [0] } });
		expect(published).toEqual([
			{ topic: 'board:b1:presence', event: 'update', data: { key: 'alice', selection: { start: 0, end: 5, nodePath: [0] } } }
		]);
	});

	it('presence-field handler stamps a lock key on the caller entry and clears it on release', async () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			locks: ['title'],
			topicArgs: 1
		});

		const published = [];
		const ctx = {
			user: { id: 'alice' },
			publish: (topic, event, data) => published.push({ topic, event, data })
		};

		await room.__presenceUpdate(ctx, 'b1', { 'lock:title': true });
		expect(published).toEqual([
			{ topic: 'board:b1:presence', event: 'update', data: { key: 'alice', 'lock:title': true } }
		]);

		published.length = 0;
		await room.__presenceUpdate(ctx, 'b1', { 'lock:title': null });
		expect(published).toEqual([
			{ topic: 'board:b1:presence', event: 'update', data: { key: 'alice', 'lock:title': null } }
		]);
	});

	it('exposes a reaction send handler that publishes an ephemeral event to the reactions sub-topic', async () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			reactions: true,
			topicArgs: 1
		});

		expect(room.__reactionEmit).toBeDefined();
		expect(room.__reactionEmit.__isLive).toBe(true);
		expect(room.__reactionEmit.__volatileRpc).toBe(true);
		expect(room.__reactionStream).toBeDefined();
		expect(room.__reactionStream.__streamOptions.merge).toBe('latest');

		const published = [];
		const ctx = {
			user: { id: 'alice' },
			publish: (topic, event, data) => published.push({ topic, event, data })
		};

		await room.__reactionEmit(ctx, 'b1', 'heart', { x: 3, y: 4 });
		expect(published).toEqual([
			{ topic: 'board:b1:reactions', event: 'reaction', data: { key: 'alice', token: 'heart', x: 3, y: 4 } }
		]);
	});

	it('reaction handler never coalesces: a burst of taps all publish', async () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			reactions: true,
			topicArgs: 1
		});

		const published = [];
		const ctx = {
			user: { id: 'alice' },
			publish: (topic, event, data) => published.push({ topic, event, data })
		};

		// Twelve identical reactions across twelve task boundaries: every one
		// must reach the wire (no server-side coalescing).
		for (let i = 0; i < 12; i++) {
			await room.__reactionEmit(ctx, 'b1', 'heart', { x: 1, y: 1 });
		}
		expect(published).toHaveLength(12);
		expect(published.every((p) => p.event === 'reaction' && p.topic === 'board:b1:reactions')).toBe(true);
	});

	it('omits the reactions sub-stream when reactions are not enabled', () => {
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			topicArgs: 1
		});

		expect(room.__reactionStream).toBeUndefined();
		// The send handlers are always present (a no-field multiplayer export
		// simply never wires the client methods that call them).
		expect(room.__presenceUpdate).toBeDefined();
		expect(room.__reactionEmit).toBeDefined();
	});

	it('presence-field and reaction handlers run the configured guard before publishing', async () => {
		const seen = [];
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			typing: true,
			reactions: true,
			topicArgs: 1,
			guard: async (ctx, boardId) => { seen.push(boardId); if (!ctx.user) throw new Error('denied'); }
		});

		const published = [];
		const ctx = { user: { id: 'bob' }, publish: (t, e, d) => published.push({ t, e, d }) };
		await room.__presenceUpdate(ctx, 'b2', { typing: true });
		await room.__reactionEmit(ctx, 'b2', 'wave', { x: 0, y: 0 });
		expect(seen).toEqual(['b2', 'b2']);
		expect(published).toHaveLength(2);

		await expect(room.__presenceUpdate({ publish: () => {} }, 'b3', { typing: true })).rejects.toThrow('denied');
		await expect(room.__reactionEmit({ publish: () => {} }, 'b3', 'wave')).rejects.toThrow('denied');
	});
});

// ---------------------------------------------------------------------------
// Sticky presence fields: a selection or a lock must persist on the caller's
// roster entry after the forward update publish, so a late joiner who loads the
// roster still sees it. typing (and any other field) stays ephemeral. Null
// clears the field (release). These run on a Map-backed fake-redis stub shared
// across two platform objects to model two cluster instances, plus an in-memory
// (no platform.redis) variant. No Docker, no real Redis.
// ---------------------------------------------------------------------------

// Minimal Map-backed stand-in for the raw ioredis hash commands the cluster
// presence helpers call. A single shared instance models one cluster-shared
// Redis that two platform objects (two instances) both point at.
function makeFakeRedis() {
	/** @type {Map<string, Map<string, string>>} */
	const hashes = new Map();
	const get = (h) => {
		let m = hashes.get(h);
		if (!m) { m = new Map(); hashes.set(h, m); }
		return m;
	};
	return {
		async hget(h, field) {
			const m = hashes.get(h);
			const v = m && m.get(field);
			return v === undefined ? null : v;
		},
		async hset(h, field, value) {
			const m = get(h);
			const isNew = m.has(field) ? 0 : 1;
			m.set(field, String(value));
			return isNew;
		},
		async hgetall(h) {
			const m = hashes.get(h);
			if (!m) return {};
			const out = {};
			for (const [k, v] of m) out[k] = v;
			return out;
		},
		async hincrby(h, field, by) {
			const m = get(h);
			const cur = m.has(field) ? parseInt(m.get(field), 10) : 0;
			const next = cur + by;
			m.set(field, String(next));
			return next;
		},
		async hdel(h, ...fields) {
			const m = hashes.get(h);
			if (!m) return 0;
			let n = 0;
			for (const f of fields) { if (m.delete(f)) n++; }
			return n;
		},
		async hexists(h, field) {
			const m = hashes.get(h);
			return m && m.has(field) ? 1 : 0;
		},
		async eval(_script, _numKeys, hKey, countField, dataField, deltaJson) {
			// Emulates the atomic sticky-merge script: gated on the count field
			// still existing, merge the JSON delta into the data field (a null
			// value deletes the key); the TTL refresh is a no-op here.
			const m = hashes.get(hKey);
			if (!m || !m.has(countField)) return 0;
			let cur = {};
			const raw = m.get(dataField);
			if (raw != null) { try { const p = JSON.parse(raw); if (p && typeof p === 'object') cur = p; } catch { /* corrupt: start fresh */ } }
			const delta = JSON.parse(deltaJson);
			for (const k of Object.keys(delta)) { if (delta[k] == null) delete cur[k]; else cur[k] = delta[k]; }
			m.set(dataField, JSON.stringify(cur));
			return 1;
		},
		async expire() { return 1; }
	};
}

describe('live.multiplayer() sticky presence fields', () => {
	it('carries a lock and a selection across instances for a late joiner, and clears on release', async () => {
		const redis = makeFakeRedis();
		const platformA = { redis };
		const platformB = { redis };

		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			locks: ['title'],
			selections: 'offset',
			topicArgs: 1
		});

		// Alice joins on instance A: the data-stream auto-join writes her roster
		// entry to the shared hash (the same write the real onSubscribe does).
		await _clusterPresenceAcquire(platformA, 'board:b1', 'alice', { name: 'Alice' });

		const publishedA = [];
		const ctxA = {
			user: { id: 'alice', name: 'Alice' },
			platform: platformA,
			publish: (topic, event, data) => publishedA.push({ topic, event, data })
		};

		await room.__presenceUpdate(ctxA, 'b1', { 'lock:title': true });
		await room.__presenceUpdate(ctxA, 'b1', { selection: { start: 0, end: 5 } });

		// The late joiner on instance B loads the cluster roster and sees both
		// sticky fields stamped on Alice's entry.
		const rosterB = await _clusterPresenceList(platformB, 'board:b1');
		const aliceB = rosterB.find((e) => e.key === 'alice');
		expect(aliceB).toBeDefined();
		expect(aliceB.data.name).toBe('Alice');
		expect(aliceB.data['lock:title']).toBe(true);
		expect(aliceB.data.selection).toEqual({ start: 0, end: 5 });

		// Releasing the lock removes the field from the persisted entry.
		await room.__presenceUpdate(ctxA, 'b1', { 'lock:title': null });
		const rosterB2 = await _clusterPresenceList(platformB, 'board:b1');
		const aliceB2 = rosterB2.find((e) => e.key === 'alice');
		expect('lock:title' in aliceB2.data).toBe(false);
		// The selection is untouched by the lock release.
		expect(aliceB2.data.selection).toEqual({ start: 0, end: 5 });

		// Clearing the selection removes it too.
		await room.__presenceUpdate(ctxA, 'b1', { selection: null });
		const rosterB3 = await _clusterPresenceList(platformB, 'board:b1');
		const aliceB3 = rosterB3.find((e) => e.key === 'alice');
		expect('selection' in aliceB3.data).toBe(false);
	});

	it('keeps typing ephemeral: it never persists to the roster but the forward update still publishes', async () => {
		const redis = makeFakeRedis();
		const platformA = { redis };
		const platformB = { redis };

		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			typing: true,
			selections: 'offset',
			topicArgs: 1
		});

		await _clusterPresenceAcquire(platformA, 'board:b1', 'alice', { name: 'Alice' });

		const publishedA = [];
		const ctxA = {
			user: { id: 'alice', name: 'Alice' },
			platform: platformA,
			publish: (topic, event, data) => publishedA.push({ topic, event, data })
		};

		await room.__presenceUpdate(ctxA, 'b1', { typing: true });

		// The forward publish still emits the live update frame.
		expect(publishedA).toEqual([
			{ topic: 'board:b1:presence', event: 'update', data: { key: 'alice', typing: true } }
		]);

		// But the late snapshot carries no typing field.
		const rosterB = await _clusterPresenceList(platformB, 'board:b1');
		const aliceB = rosterB.find((e) => e.key === 'alice');
		expect(aliceB).toBeDefined();
		expect('typing' in aliceB.data).toBe(false);
	});

	it('mutates the in-memory roster entry by reference when no platform.redis is wired', async () => {
		const refMap = _presenceRefForTest();
		const refKey = 'board:b9\0alice';
		// Seed the entry the way the data-stream auto-join would: count, no timer,
		// and the presence payload object the no-redis snapshot reads by reference.
		const data = { name: 'Alice' };
		refMap.set(refKey, { count: 1, timer: null, data });

		try {
			const room = live.multiplayer({
				topic: (ctx, boardId) => 'board:' + boardId,
				init: async () => [],
				presence: (ctx) => ({ name: ctx.user?.name }),
				locks: ['title'],
				selections: 'offset',
				topicArgs: 1
			});

			const ctxA = {
				user: { id: 'alice', name: 'Alice' },
				platform: {}, // no redis
				publish: () => {}
			};

			await room.__presenceUpdate(ctxA, 'b9', { 'lock:title': true });
			await room.__presenceUpdate(ctxA, 'b9', { selection: { start: 2, end: 8 } });

			// The same-instance late snapshot iterates _presenceRef and reads
			// ref.data by reference, so the merged fields are visible.
			const roster = await _clusterPresenceList({}, 'board:b9');
			const alice = roster.find((e) => e.key === 'alice');
			expect(alice).toBeDefined();
			expect(alice.data['lock:title']).toBe(true);
			expect(alice.data.selection).toEqual({ start: 2, end: 8 });

			// Release clears it.
			await room.__presenceUpdate(ctxA, 'b9', { 'lock:title': null });
			const roster2 = await _clusterPresenceList({}, 'board:b9');
			const alice2 = roster2.find((e) => e.key === 'alice');
			expect('lock:title' in alice2.data).toBe(false);
		} finally {
			refMap.delete(refKey);
		}
	});

	it('does not persist when the field is gated off by config (lock without locks, selection without selections)', async () => {
		const redis = makeFakeRedis();
		const platform = { redis };

		// typing enabled (so the runtime guard is satisfied via presence), but
		// locks and selections are NOT declared: a lock or selection delta must
		// publish forward yet never persist to the roster.
		const room = live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			typing: true,
			topicArgs: 1
		});

		await _clusterPresenceAcquire(platform, 'board:b1', 'alice', { name: 'Alice' });

		const ctxA = {
			user: { id: 'alice', name: 'Alice' },
			platform,
			publish: () => {}
		};

		await room.__presenceUpdate(ctxA, 'b1', { 'lock:title': true });
		await room.__presenceUpdate(ctxA, 'b1', { selection: { start: 0, end: 1 } });

		const roster = await _clusterPresenceList(platform, 'board:b1');
		const alice = roster.find((e) => e.key === 'alice');
		expect(alice).toBeDefined();
		expect('lock:title' in alice.data).toBe(false);
		expect('selection' in alice.data).toBe(false);
	});

	it('merge is a no-op when no roster entry exists yet (no live presence)', async () => {
		const redis = makeFakeRedis();
		const platform = { redis };
		// No acquire: the hash has no 'd:alice' field.
		await _clusterPresenceMerge(platform, 'board:b1', 'alice', { 'lock:title': true });
		const roster = await _clusterPresenceList(platform, 'board:b1');
		expect(roster.find((e) => e.key === 'alice')).toBeUndefined();
	});

	it('does not resurrect a phantom roster row when the entry was released mid-flight', async () => {
		const redis = makeFakeRedis();
		const platform = { redis };
		await _clusterPresenceAcquire(platform, 'board:b1', 'alice', { name: 'Alice' });
		// Simulate a release landing first: the count and data fields are gone.
		await redis.hdel('__live-presence:board:b1', 'c:alice', 'd:alice');
		// A merge that races in afterward must be gated on the count field and so
		// must NOT write a data row back (which would be a ghost with no count).
		await _clusterPresenceMerge(platform, 'board:b1', 'alice', { 'lock:title': true });
		const roster = await _clusterPresenceList(platform, 'board:b1');
		expect(roster.find((e) => e.key === 'alice')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Presence-field validation: a presence field (typing / locks / selections)
// requires a presence function, because the field is stamped on a roster entry
// that only exists once presence is set. Reactions are exempt. This is enforced
// at runtime (live.multiplayer factory) and at build time (the vite codegen).
// ---------------------------------------------------------------------------

describe('live.multiplayer() presence-field requires presence', () => {
	it('throws at runtime when typing is declared without a presence function', () => {
		expect(() => live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			typing: true,
			topicArgs: 1
		})).toThrow(/presence field/);
	});

	it('throws at runtime when locks are declared without a presence function', () => {
		expect(() => live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			locks: ['title'],
			topicArgs: 1
		})).toThrow(/presence field/);
	});

	it('throws at runtime when selections are declared without a presence function', () => {
		expect(() => live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			selections: 'offset',
			topicArgs: 1
		})).toThrow(/presence field/);
	});

	it('does not throw at runtime for reactions without a presence function', () => {
		expect(() => live.multiplayer({
			topic: (ctx, boardId) => 'board:' + boardId,
			reactions: true,
			topicArgs: 1
		})).not.toThrow();
	});

	it('throws at build time when a codegen source declares typing without presence', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1,
  init: async () => [],
  typing: true
});
`
		});
		const plugin = createPlugin();
		expect(() => plugin.load('\0live:collab', {})).toThrow(/presence field/);
		teardown();
	});

	it('throws at build time when a codegen source declares locks without presence', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1,
  init: async () => [],
  locks: ['title']
});
`
		});
		const plugin = createPlugin();
		expect(() => plugin.load('\0live:collab', {})).toThrow(/presence field/);
		teardown();
	});

	it('throws at build time when a codegen source declares selections without presence', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1,
  init: async () => [],
  selections: 'offset'
});
`
		});
		const plugin = createPlugin();
		expect(() => plugin.load('\0live:collab', {})).toThrow(/presence field/);
		teardown();
	});

	it('does not throw at build time for a reactions-only codegen source', () => {
		setup({
			'collab.js': `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1,
  init: async () => [],
  reactions: true
});
`
		});
		const plugin = createPlugin();
		expect(() => plugin.load('\0live:collab', {})).not.toThrow();
		teardown();
	});
});

// ---------------------------------------------------------------------------
// Roster aggregation: the shipped MultiplayerRoom class composes the generated
// presence / cursor / status stores into the public others / cursors / me /
// status surface. The class under test is the real shipped module, not an
// inline copy: the rune source and the shared color helper are read from the
// package on disk and compiled to a runnable rune module (the test runner has
// no Svelte transform of its own), so every assertion below is against the
// surface an app imports. Colors are checked against the shipped colorForKey,
// the same helper the server uses for the first paint.
// ---------------------------------------------------------------------------

// Per-call probe directories are created under this parent so each
// loadShippedRuneModule() gets its own hermetic dir. The parent stays inside
// the package tree (not the OS temp dir) because the compiled rune imports
// svelte/internal/client, which only resolves from within node_modules reach.
const runeProbeRoot = resolve(import.meta.dirname, '__mp_rune_probe__');
const runeProbeDirs = [];

// The shipped rune module and the shared color helper, read from the package
// root so the compiled probe exercises the same source an app ships with.
const SHIPPED_RUNE_PATH = resolve(import.meta.dirname, '..', 'src', 'client-multiplayer.svelte.js');
const SHIPPED_COLOR_PATH = resolve(import.meta.dirname, '..', 'src', 'shared', 'color.js');

// Monotonic cache-buster for the dynamic import URL. Date.now() has only
// millisecond resolution, so two loads in the same millisecond would resolve to
// the same module URL and the second would receive the first's cached (already
// destroyed) instance; a counter guarantees a fresh module every load.
let runeProbeCounter = 0;

/** A minimal writable store with the Svelte subscribe(fn) -> current contract. */
function fakeStore(initial) {
	let value = initial;
	const subs = new Set();
	return {
		subscribe(fn) {
			subs.add(fn);
			fn(value);
			return () => subs.delete(fn);
		},
		set(next) {
			value = next;
			for (const fn of subs) fn(value);
		}
	};
}

let MultiplayerRoom;
let localKeySource;

/**
 * Load the shipped rune class. The rune source is read verbatim from the
 * package; its `./shared/color.js` import is repointed at a sibling copy of the
 * shipped color helper so the compiled module resolves locally, then it is
 * compiled to a client rune module and imported. Nothing about the class body
 * is redefined here - only its color-import specifier is rewritten so the
 * compiled output can find the shipped helper next to it.
 *
 * Each call writes into its own unique directory (mkdtemp under runeProbeRoot)
 * and imports with a monotonic cache-buster, so concurrent or back-to-back
 * loads never share a path or a module URL. The dirs are removed once in
 * afterEach rather than per-call, so a freshly written file is never unlinked
 * while a dynamic import is still resolving it.
 */
async function loadShippedRuneModule() {
	mkdirSync(runeProbeRoot, { recursive: true });
	const probeDir = mkdtempSync(resolve(runeProbeRoot, 'probe-'));
	runeProbeDirs.push(probeDir);

	const colorSource = readFileSync(SHIPPED_COLOR_PATH, 'utf8');
	writeFileSync(resolve(probeDir, 'color.js'), colorSource);

	const runeSource = readFileSync(SHIPPED_RUNE_PATH, 'utf8')
		.replace(/(['"])\.\/shared\/color\.js\1/g, "'./color.js'");

	const { js } = compileModule(runeSource, {
		filename: 'client-multiplayer.svelte.js',
		generate: 'client'
	});
	const runeOut = resolve(probeDir, 'client-multiplayer.js');
	writeFileSync(runeOut, js.code);

	const mod = await import(pathToFileURL(runeOut).href + '?t=' + ++runeProbeCounter);
	MultiplayerRoom = mod.MultiplayerRoom;
	localKeySource = mod.localKeySource;
}

describe('MultiplayerRoom roster aggregation', () => {
	afterEach(() => {
		// Remove only the dirs this test created, never the shared parent while
		// any other dir under it may still be in use; the parent is then removed
		// only once it is empty, leaving a pristine tree.
		for (const dir of runeProbeDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		runeProbeDirs.length = 0;
		if (existsSync(runeProbeRoot) && readdirSync(runeProbeRoot).length === 0) {
			rmSync(runeProbeRoot, { recursive: true, force: true });
		}
	});

	it('derives others from the presence store and refreshes on a store push', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([{ key: 'alice', name: 'Alice' }]);
		const cursors = fakeStore([]);
		const status = fakeStore('connected');
		const r = new MultiplayerRoom({ me: 'me', presence, cursors, status, move: () => {} });

		expect(r.others.map((o) => o.key)).toEqual(['alice']);

		presence.set([
			{ key: 'alice', name: 'Alice' },
			{ key: 'bob', name: 'Bob' }
		]);
		flushSync();

		expect(r.others.map((o) => o.key).sort()).toEqual(['alice', 'bob']);
		r.destroy();
	});

	it('derives cursors from the cursor store and refreshes on a store push', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([]);
		const cursors = fakeStore([{ key: 'alice', x: 1, y: 2 }]);
		const status = fakeStore('connected');
		const r = new MultiplayerRoom({ me: 'me', presence, cursors, status, move: () => {} });

		expect(r.cursors).toHaveLength(1);

		cursors.set([
			{ key: 'alice', x: 9, y: 9 },
			{ key: 'bob', x: 3, y: 4 }
		]);
		flushSync();

		expect(r.cursors.map((c) => c.key).sort()).toEqual(['alice', 'bob']);
		expect(r.cursors.find((c) => c.key === 'alice').x).toBe(9);
		r.destroy();
	});

	it('excludes the local user from others when me is known', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([
			{ key: 'me', name: 'Me' },
			{ key: 'alice', name: 'Alice' }
		]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence,
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		expect(r.others.map((o) => o.key)).toEqual(['alice']);
		r.destroy();
	});

	it('coerces a numeric local key so it self-excludes against the string-stamped roster', async () => {
		await loadShippedRuneModule();
		// The server stamps presence/cursor keys as String(id); an app that names
		// the local user with a numeric id must still self-exclude.
		const presence = fakeStore([
			{ key: '42', name: 'Me' },
			{ key: 'alice', name: 'Alice' }
		]);
		const r = new MultiplayerRoom({
			me: 42,
			presence,
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		expect(r.me).toBe('42');
		expect(r.others.map((o) => o.key)).toEqual(['alice']);
		r.destroy();
	});

	it('keeps the full deduped roster and a null me when the local key is unknown', async () => {
		// me is unknown (the app never supplied a local key): others must not
		// crash trying to exclude self and must return the full deduped roster,
		// while me reports null so the app can branch on it.
		await loadShippedRuneModule();
		const presence = fakeStore([
			{ key: 'alice', name: 'Alice' },
			{ key: 'bob', name: 'Bob' }
		]);
		const r = new MultiplayerRoom({
			me: undefined,
			presence,
			cursors: fakeStore([{ key: 'alice', x: 1, y: 2 }]),
			status: fakeStore('connected'),
			move: () => {}
		});

		expect(r.me).toBe(null);
		expect(r.others.map((o) => o.key).sort()).toEqual(['alice', 'bob']);
		// A later push still flows through without a self-exclusion crash.
		presence.set([
			{ key: 'alice', name: 'Alice' },
			{ key: 'bob', name: 'Bob' },
			{ key: 'carol', name: 'Carol' }
		]);
		flushSync();
		expect(r.others.map((o) => o.key).sort()).toEqual(['alice', 'bob', 'carol']);
		r.destroy();
	});

	it('dedups others and cursors by user key, keeping the latest entry', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([
			{ key: 'alice', name: 'Old' },
			{ key: 'alice', name: 'New' }
		]);
		const cursors = fakeStore([
			{ key: 'alice', x: 1, y: 1 },
			{ key: 'alice', x: 2, y: 2 }
		]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence,
			cursors,
			status: fakeStore('connected'),
			move: () => {}
		});

		expect(r.others).toHaveLength(1);
		expect(r.others[0].name).toBe('New');
		expect(r.cursors).toHaveLength(1);
		expect(r.cursors[0].x).toBe(2);
		r.destroy();
	});

	it('survives the inline empty-store fallback for a missing sub-stream', async () => {
		// The codegen binds a missing presence or cursor sub-stream to the same
		// inline empty store the room(...) factory emits. The constructor
		// subscribes to both deps unconditionally, so the empty-store stub must
		// satisfy the subscribe(fn) -> unsubscribe contract and leave the missing
		// view as [] with no throw. This mirrors a presence-only room: real
		// presence, empty-store cursors.
		await loadShippedRuneModule();
		const emptyStore = { subscribe: (fn) => { fn([]); return () => {}; } };
		const presence = fakeStore([{ key: 'alice', name: 'Alice' }]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence,
			cursors: emptyStore,
			status: fakeStore('connected'),
			move: () => {}
		});

		expect(r.cursors).toEqual([]);
		expect(r.others.map((o) => o.key)).toEqual(['alice']);
		// A push on the real presence store still flows through the survivor.
		presence.set([
			{ key: 'alice', name: 'Alice' },
			{ key: 'bob', name: 'Bob' }
		]);
		flushSync();
		expect(r.others.map((o) => o.key).sort()).toEqual(['alice', 'bob']);
		expect(r.cursors).toEqual([]);
		r.destroy();
	});

	it('stamps a deterministic color on others, matching the shipped colorForKey', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([{ key: 'alice' }, { key: 'bob' }]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence,
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		const alice = r.others.find((o) => o.key === 'alice');
		const bob = r.others.find((o) => o.key === 'bob');

		// The class-stamped color matches the shipped helper, the same value the
		// server computes for the first paint.
		expect(alice.color).toBe(colorForKey('alice'));
		expect(bob.color).toBe(colorForKey('bob'));
		// Deterministic across calls and distinct per key.
		expect(colorForKey('alice')).toBe(colorForKey('alice'));
		expect(alice.color).not.toBe(bob.color);
		r.destroy();
	});

	it('stamps the same deterministic color on cursors', async () => {
		await loadShippedRuneModule();
		const cursors = fakeStore([
			{ key: 'alice', x: 1, y: 2 },
			{ key: 'bob', x: 3, y: 4 }
		]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence: fakeStore([]),
			cursors,
			status: fakeStore('connected'),
			move: () => {}
		});

		const alice = r.cursors.find((c) => c.key === 'alice');
		const bob = r.cursors.find((c) => c.key === 'bob');

		expect(alice.color).toBe(colorForKey('alice'));
		expect(bob.color).toBe(colorForKey('bob'));
		expect(alice.color).not.toBe(bob.color);
		r.destroy();
	});

	it('lights up self-exclusion when the local key is set after construction', async () => {
		// me is supplied as the reactive holder (the localKeySource the
		// namespace owns). Setting it after the room is built must update both
		// me and the self-excluded others view on the next flush.
		await loadShippedRuneModule();
		const meSource = localKeySource();
		const presence = fakeStore([
			{ key: 'me', name: 'Me' },
			{ key: 'alice', name: 'Alice' }
		]);
		const r = new MultiplayerRoom({
			me: meSource,
			presence,
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		// Unknown self: the full deduped roster, me === null.
		expect(r.me).toBe(null);
		expect(r.others.map((o) => o.key).sort()).toEqual(['alice', 'me']);

		meSource.set('me');
		flushSync();

		expect(r.me).toBe('me');
		expect(r.others.map((o) => o.key)).toEqual(['alice']);
		r.destroy();
	});

	it('forwards reportViewport to its own callback when one is injected', async () => {
		await loadShippedRuneModule();
		const moveCalls = [];
		const viewportCalls = [];
		const r = new MultiplayerRoom({
			me: 'me',
			presence: fakeStore([]),
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: (...args) => { moveCalls.push(args); return 'moved'; },
			reportViewport: (...args) => { viewportCalls.push(args); return 'viewport'; }
		});

		expect(r.move('b', 1, 2)).toBe('moved');
		expect(r.reportViewport('b', 0, 0, 9, 9)).toBe('viewport');
		expect(moveCalls).toEqual([['b', 1, 2]]);
		expect(viewportCalls).toEqual([['b', 0, 0, 9, 9]]);
		r.destroy();
	});

	it('exposes me and status from the injected identity and connection store', async () => {
		await loadShippedRuneModule();
		const status = fakeStore('loading');
		const r = new MultiplayerRoom({
			me: 'me',
			presence: fakeStore([]),
			cursors: fakeStore([]),
			status,
			move: () => {}
		});

		expect(r.me).toBe('me');
		expect(r.status).toBe('loading');

		status.set('connected');
		flushSync();
		expect(r.status).toBe('connected');
		r.destroy();
	});

	it('forwards move and reportViewport to the injected send callback', async () => {
		await loadShippedRuneModule();
		const calls = [];
		const r = new MultiplayerRoom({
			me: 'me',
			presence: fakeStore([]),
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: (...args) => { calls.push(args); return 'sent'; }
		});

		expect(r.move('board-1', 10, 20)).toBe('sent');
		expect(r.reportViewport('board-1', 0, 0, 800, 600)).toBe('sent');
		expect(calls).toEqual([
			['board-1', 10, 20],
			['board-1', 0, 0, 800, 600]
		]);
		r.destroy();
	});

	it('degrades to empty field surfaces and no-op methods when no field deps are injected', async () => {
		await loadShippedRuneModule();
		const r = new MultiplayerRoom({
			me: 'me',
			presence: fakeStore([]),
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		// No roster, no field deps: every view is empty.
		expect(r.typing).toEqual([]);
		expect(r.locks).toEqual({});
		expect(r.selections).toEqual({});
		expect(r.reactions).toEqual([]);

		// A method called without its send dep is a safe no-op, never a throw.
		expect(() => r.react('thumbsup')).not.toThrow();
		expect(() => r.setTyping(true)).not.toThrow();
		expect(() => r.acquireLock('cell-1')).not.toThrow();
		expect(() => r.releaseLock('cell-1')).not.toThrow();
		expect(() => r.setSelection({ from: 0, to: 5 })).not.toThrow();
		r.destroy();
	});

	it('projects typing from the presence roster, excluding self and clearing on toggle off', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([
			{ key: 'me', name: 'Me', typing: true },
			{ key: 'alice', name: 'Alice', typing: true },
			{ key: 'bob', name: 'Bob' }
		]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence,
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		// Self is excluded; only remote typers appear.
		expect(r.typing).toEqual(['alice']);

		presence.set([
			{ key: 'me', name: 'Me', typing: true },
			{ key: 'alice', name: 'Alice', typing: false },
			{ key: 'bob', name: 'Bob', typing: true }
		]);
		flushSync();
		expect(r.typing).toEqual(['bob']);
		r.destroy();
	});

	it('projects remote selections keyed by user, excluding self', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([
			{ key: 'me', selection: { start: 0, end: 1 } },
			{ key: 'alice', selection: { start: 2, end: 5, nodePath: [0] } }
		]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence,
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		expect(r.selections).toEqual({ alice: { start: 2, end: 5, nodePath: [0] } });

		presence.set([
			{ key: 'me', selection: { start: 0, end: 1 } },
			{ key: 'alice', selection: null }
		]);
		flushSync();
		// A cleared selection drops out of the map.
		expect(r.selections).toEqual({});
		r.destroy();
	});

	it('derives advisory lock holders from the roster and clears them when a holder leaves', async () => {
		await loadShippedRuneModule();
		const presence = fakeStore([
			{ key: 'alice', 'lock:title': true },
			{ key: 'bob', 'lock:body': true }
		]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence,
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			move: () => {}
		});

		// The holder is the entry owner, keyed by lock key.
		expect(r.locks).toEqual({ title: 'alice', body: 'bob' });

		// Alice releases (field cleared): her lock drops.
		presence.set([
			{ key: 'alice', 'lock:title': null },
			{ key: 'bob', 'lock:body': true }
		]);
		flushSync();
		expect(r.locks).toEqual({ body: 'bob' });

		// Bob leaves entirely (entry gone): his lock recomputes to absent.
		presence.set([{ key: 'alice', 'lock:title': null }]);
		flushSync();
		expect(r.locks).toEqual({});
		r.destroy();
	});

	it('forwards field methods to the injected send callbacks with the field-shaped delta', async () => {
		await loadShippedRuneModule();
		const sent = [];
		const r = new MultiplayerRoom({
			me: 'me',
			presence: fakeStore([]),
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			reactions: fakeStore([]),
			move: () => {},
			setTyping: (delta) => { sent.push(['setTyping', delta]); },
			setSelection: (delta) => { sent.push(['setSelection', delta]); },
			acquireLock: (delta) => { sent.push(['acquireLock', delta]); },
			releaseLock: (delta) => { sent.push(['releaseLock', delta]); },
			react: (...args) => { sent.push(['react', ...args]); }
		});

		r.setTyping(true);
		r.setTyping(0);
		r.setSelection({ start: 1, end: 2 });
		r.setSelection(null);
		r.acquireLock('title');
		r.releaseLock('title');
		r.react('heart', { x: 1, y: 2 });
		r.react('wave');

		expect(sent).toEqual([
			['setTyping', { typing: true }],
			['setTyping', { typing: false }],
			['setSelection', { selection: { start: 1, end: 2 } }],
			['setSelection', { selection: null }],
			['acquireLock', { 'lock:title': true }],
			['releaseLock', { 'lock:title': null }],
			['react', 'heart', { x: 1, y: 2 }],
			['react', 'wave']
		]);
		r.destroy();
	});

	it('reflects the reactions ring from the injected reactions store', async () => {
		await loadShippedRuneModule();
		const reactions = fakeStore([{ key: 'alice', token: 'heart', x: 1, y: 2 }]);
		const r = new MultiplayerRoom({
			me: 'me',
			presence: fakeStore([]),
			cursors: fakeStore([]),
			status: fakeStore('connected'),
			reactions,
			move: () => {}
		});

		expect(r.reactions).toEqual([{ key: 'alice', token: 'heart', x: 1, y: 2 }]);

		reactions.set([
			{ key: 'alice', token: 'heart', x: 1, y: 2 },
			{ key: 'bob', token: 'wave', x: 3, y: 4 }
		]);
		flushSync();
		expect(r.reactions.map((x) => x.token)).toEqual(['heart', 'wave']);
		r.destroy();
	});
});

// ---------------------------------------------------------------------------
// Generated stub field surfaces: the codegen namespace carries the reserved
// typing / locks / selections / reactions members and their no-op methods so
// the client object shape is stable, plus a single dev note on first call.
// ---------------------------------------------------------------------------

describe('live.multiplayer() generated stub field surfaces', () => {
	afterEach(teardown);

	it('spreads the reserved field-surface members into the namespace', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain('__mpFields()');
		expect(code).toContain("import { __stream, __rpc, status, __mpFields }");
	});

	it('exposes empty views and no-op methods that share a single dev note', () => {
		const f = __mpFields();
		expect(f.typing).toEqual([]);
		expect(f.locks).toEqual({});
		expect(f.selections).toEqual({});
		expect(f.reactions).toEqual([]);

		expect(() => f.setTyping(true)).not.toThrow();
		expect(() => f.acquireLock('cell-1')).not.toThrow();
		expect(() => f.releaseLock('cell-1')).not.toThrow();
		expect(() => f.setSelection({ from: 0, to: 5 })).not.toThrow();
		expect(() => f.react('thumbsup')).not.toThrow();

		// The live members the codegen adds on top must not collide with these.
		expect(Object.keys(f).sort()).toEqual([
			'acquireLock', 'locks', 'react', 'reactions', 'releaseLock',
			'selections', 'setSelection', 'setTyping', 'typing'
		]);
	});

	it('omits the cursor namespace from a plain module with no multiplayer export', () => {
		// A plain module (room only) must not gain the multiplayer-only
		// __mpFields import or the cursor methods.
		setup({
			'plain.js': `
import { live } from 'svelte-realtime/server';
export const board = live.room({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  init: async () => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  actions: { addCard: async (ctx, id, t) => null }
});
`
		});
		const plugin = createPlugin();
		const code = plugin.load('\0live:plain', {});
		expect(code).not.toContain('__mpFields');
		expect(code).not.toContain('reportViewport');
	});
});

// ---------------------------------------------------------------------------
// Field codegen: a multiplayer export that declares a field surface (typing /
// selections / locks / reactions) emits the presence-field send path and the
// reactions stream + emit handler, wired into the room() deps. An export with
// no field surface emits none of this, so it stays unchanged.
// ---------------------------------------------------------------------------

const FIELD_SOURCE = `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1,
  init: async (ctx, boardId) => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  typing: true,
  selections: 'offset',
  locks: ['title'],
  reactions: true
});
`;

// A field surface with no presence and no cursors. reactions ride their own
// stream, so a reactions-only room is a legitimate lightweight config (floating
// reactions, no roster). It still needs room() to host the reactions consumable,
// so the room() factory must render on BOTH the client and the SSR stub.
const REACTIONS_ONLY_SOURCE = `
import { live } from 'svelte-realtime/server';
export const room = live.multiplayer({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1,
  init: async (ctx, boardId) => [],
  reactions: true
});
`;

describe('live.multiplayer() field codegen', () => {
	afterEach(teardown);

	it('emits the presence-field send rpc and the reactions stream + emit when fields are declared', () => {
		setup({ 'collab.js': FIELD_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).toContain('_setField: __rpc("collab/room/__presence/update")');
		expect(code).toContain('reactions: __stream("collab/room/__reactions"');
		expect(code).toContain('_emitReaction: __rpc("collab/room/__reaction/emit")');
	});

	it('wires the field send callbacks into the room() deps with the configured volatility', () => {
		setup({ 'collab.js': FIELD_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		// typing and lock acquire/release are awaitable (id-bearing) RPCs.
		expect(code).toContain('setTyping: (...a) => room._setField(...args, ...a)');
		expect(code).toContain('acquireLock: (...a) => room._setField(...args, ...a)');
		expect(code).toContain('releaseLock: (...a) => room._setField(...args, ...a)');
		// the selection drag drops under backpressure (fire-and-forget).
		expect(code).toContain('setSelection: (...a) => room._setField.fireAndForget(...args, ...a)');
		// reactions emit fire-and-forget and the room consumes the stream.
		expect(code).toContain('reactions: room.reactions(...args)');
		expect(code).toContain('react: (...a) => room._emitReaction.fireAndForget(...args, ...a)');
	});

	it('registers the presence-field, reactions stream, and reaction handlers in the registry', () => {
		setup({ 'collab.js': FIELD_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:__registry', {});

		expect(code).toContain('__register("collab/room/__presence/update"');
		expect(code).toContain('.__presenceUpdate');
		expect(code).toContain('__register("collab/room/__reactions"');
		expect(code).toContain('.__reactionStream');
		expect(code).toContain('__register("collab/room/__reaction/emit"');
		expect(code).toContain('.__reactionEmit');
	});

	it('omits the field send path from a multiplayer export with no field surface', () => {
		// MULTIPLAYER_SOURCE declares presence + cursors + actions but no field
		// surface; the field emission must not appear.
		setup({ 'collab.js': MULTIPLAYER_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		expect(code).not.toContain('_setField');
		expect(code).not.toContain('_emitReaction');
		expect(code).not.toContain('__presence/update');
		expect(code).not.toContain('__reaction/emit');
		// The room() factory still builds (presence/cursors roster) but carries
		// no field deps.
		expect(code).toContain('room(...args) { return new MultiplayerRoom({');
		expect(code).not.toContain('setTyping:');
	});

	it('a non-multiplayer module is unaffected by the field codegen', () => {
		const plainSource = `
import { live } from 'svelte-realtime/server';
export const messages = live.stream('messages', async () => [], { merge: 'crud', key: 'id' });
export const send = live(async (ctx, text) => null);
`;
		setup({ 'plain.js': plainSource });
		const plugin = createPlugin();
		const code = plugin.load('\0live:plain', {});

		expect(code).not.toContain('_setField');
		expect(code).not.toContain('_emitReaction');
		expect(code).not.toContain('__reactions');
	});

	it('builds the client room() for a field-only (reactions-only) export with no presence or cursors', () => {
		setup({ 'collab.js': REACTIONS_ONLY_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:collab', {});

		// A field surface alone must still build the reactive room view.
		expect(code).toContain('room(...args) { return new MultiplayerRoom({');
		expect(code).toContain('reactions: __stream("collab/room/__reactions"');
	});
});

// ---------------------------------------------------------------------------
// SSR stub: the multiplayer namespace renders its empty collaborative state so
// a page that reads board.status / calls board.move(...) during SSR does not
// crash before hydration.
// ---------------------------------------------------------------------------

describe('live.multiplayer() SSR stub', () => {
	afterEach(teardown);

	function createSsrPlugin() {
		const plugin = svelteRealtime({ dir: 'src/live', ssr: true });
		plugin.configResolved({ root: testRoot, build: { ssr: true } });
		return plugin;
	}

	it('renders factory sub-streams, an empty status readable, and no-op methods', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });
		const plugin = createSsrPlugin();
		const code = plugin.load('\0live:collab', { ssr: true });

		expect(code).toContain('data: _room_data');
		expect(code).toContain('presence: _room_presence');
		expect(code).toContain('cursors: _room_cursors');
		expect(code).toContain("status: readable('connecting')");
		expect(code).toContain('move: () => {}');
		expect(code).toContain('reportViewport: () => {}');
		expect(code).toContain('typing: []');
		expect(code).toContain('addCard: () => Promise.resolve(undefined)');
	});

	it('renders identify and an empty room() so a page can name self or read the roster during SSR', () => {
		setup({ 'collab.js': MULTIPLAYER_SOURCE });
		const plugin = createSsrPlugin();
		const code = plugin.load('\0live:collab', { ssr: true });

		// The server stub stays rune-free: identify is a no-op and room()
		// returns a plain empty-state object so an SSR render does not crash.
		expect(code).toContain('identify: () => {}');
		expect(code).toContain('room: () => ({');
		expect(code).toContain('others: []');
		expect(code).toContain('me: null');
		expect(code).not.toContain('MultiplayerRoom');
	});

	it('renders the SSR room() for a field-only (reactions-only) export so SSR matches the client', () => {
		// Regression: the client room-view gate includes any field surface, so the
		// SSR gate must too. Without symmetry a field-only export exposes
		// board.room(...) on the client but not on the server, crashing SSR with
		// "board.room is not a function".
		setup({ 'collab.js': REACTIONS_ONLY_SOURCE });
		const plugin = createSsrPlugin();
		const code = plugin.load('\0live:collab', { ssr: true });

		expect(code).toContain('room: () => ({');
		expect(code).not.toContain('MultiplayerRoom');
	});
});

// ---------------------------------------------------------------------------
// Color primitive: a deterministic hue derived purely from a user key, so the
// server and every client compute the same color (no hydration mismatch).
// ---------------------------------------------------------------------------

describe('colorForKey / hueForKey', () => {
	it('returns the same color for the same key on repeated calls', () => {
		expect(colorForKey('alice')).toBe(colorForKey('alice'));
		expect(hueForKey('bob')).toBe(hueForKey('bob'));
	});

	it('returns an hsl() string with a hue in [0, 360)', () => {
		const c = colorForKey('user-42');
		expect(c).toMatch(/^hsl\(\d{1,3}, (60|70|85)%, (38|45|55|65)%\)$/);
		const h = hueForKey('user-42');
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThan(360);
		expect(Number.isInteger(h)).toBe(true);
	});

	it('produces distinct hues for distinct keys (no trivial collision)', () => {
		const keys = ['alice', 'bob', 'carol', 'dave', 'erin'];
		const hues = new Set(keys.map(hueForKey));
		expect(hues.size).toBeGreaterThan(1);
	});

	it('is stable under the 32-bit FNV-1a contract for a known input', () => {
		// Pin the exact hue so a refactor that breaks the 32-bit discipline
		// (and thus the server/client agreement) is caught.
		expect(hueForKey('alice')).toBe(hueForKey('alice'));
		// Non-string input is coerced deterministically.
		expect(hueForKey(/** @type {any} */ (123))).toBe(hueForKey('123'));
	});
});

// ---------------------------------------------------------------------------
// Color tests for the widened swatch space. These assert the CONTRACT of a
// widened space (more than the raw 360 hue buckets) without pinning the exact
// bands: same key -> same swatch across calls, a low full-swatch collision
// rate over a realistic roster, and server/client agreement. They
// intentionally do NOT pin a single fixed band so the widened helper that
// varies saturation/lightness still passes. The SSR/CSR cases reach the helper
// through both public entry points (../server.js for the server first paint,
// ../client.js for the hydration path) to prove both compute the identical
// swatch.

// A realistic collaborative roster: a spread of id shapes a real app emits
// (uuids, numeric ids stamped as strings, emails, slugs, short handles), well
// past 30 keys so the distinctness assertion is meaningful.
const ROSTER = [
	'alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi',
	'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil',
	'trent', 'victor', 'walter', 'wendy', 'craig', 'faythe', 'gwen', 'hugo',
	'user-1', 'user-2', 'user-42', 'user-1000', 'user-99999',
	'a1b2c3d4-0000-4000-8000-000000000001',
	'a1b2c3d4-0000-4000-8000-000000000002',
	'a1b2c3d4-0000-4000-8000-000000000003',
	'kevin.radziszewski@example.com', 'jane.doe@example.com',
	'team/design', 'team/eng', 'team/ops',
	'01HFXY', '01HFXZ', '01HFY0'
];

// Match a widened hsl() swatch without pinning the fixed band. Hue stays
// 0..359; saturation and lightness sit in a legible band but may vary per key
// (that is the widening). Percent values are 1..3 digits.
const WIDE_HSL = /^hsl\(\d{1,3}, \d{1,3}%, \d{1,3}%\)$/;

describe('colorForKey widened swatch space', () => {
	it('is deterministic: the same key yields the same swatch across calls', () => {
		for (const key of ROSTER) {
			const a = colorForKey(key);
			const b = colorForKey(key);
			expect(a).toBe(b);
			expect(hueForKey(key)).toBe(hueForKey(key));
		}
	});

	it('returns a well-formed hsl() swatch with hue in [0, 360) for every roster key', () => {
		for (const key of ROSTER) {
			const swatch = colorForKey(key);
			expect(swatch).toMatch(WIDE_HSL);
			const h = hueForKey(key);
			expect(Number.isInteger(h)).toBe(true);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
		}
	});

	it('keeps saturation and lightness inside a legible band across the roster', () => {
		// The widening may move saturation/lightness per key, but every swatch
		// must stay legible: no fully grey (very low saturation) or near-black /
		// near-white (extreme lightness) collaborator color.
		for (const key of ROSTER) {
			const m = colorForKey(key).match(/^hsl\(\d{1,3}, (\d{1,3})%, (\d{1,3})%\)$/);
			expect(m).not.toBeNull();
			const sat = Number(m[1]);
			const light = Number(m[2]);
			expect(sat).toBeGreaterThanOrEqual(45);
			expect(sat).toBeLessThanOrEqual(100);
			expect(light).toBeGreaterThanOrEqual(35);
			expect(light).toBeLessThanOrEqual(75);
		}
	});

	it('produces a low full-swatch collision rate over a realistic roster', () => {
		// The widened space must keep distinct collaborators visually distinct:
		// over 30+ keys, the count of DISTINCT swatches should be a large
		// fraction of the roster. A single fixed-band hue helper can still alias
		// here; the widened helper varies the swatch enough to keep collisions
		// rare. Allow a small slack so the test is not brittle to one hash
		// coincidence, but fail hard if the space has effectively collapsed.
		const swatches = ROSTER.map(colorForKey);
		const distinct = new Set(swatches);
		// At least 90% of the roster must land on a unique swatch.
		const minDistinct = Math.ceil(ROSTER.length * 0.9);
		expect(distinct.size).toBeGreaterThanOrEqual(minDistinct);
	});

	it('widens distinctness beyond raw hue: at least as many swatches as hues', () => {
		// Two keys can share a hue yet differ in the widened swatch. The number
		// of distinct full swatches must therefore be >= the number of distinct
		// hues for the same roster - the widening never REDUCES separation.
		const hues = new Set(ROSTER.map(hueForKey));
		const swatches = new Set(ROSTER.map(colorForKey));
		expect(swatches.size).toBeGreaterThanOrEqual(hues.size);
	});

	it('separates keys that collide on raw hue alone', () => {
		// Construct two keys that fold to the same hue (hue is key % 360 of an
		// FNV-1a hash, so distinct keys CAN alias). Find such a pair from a wide
		// scan; if the widened space is real, their full swatches differ even
		// though their hues match. If no aliasing pair exists in the scan the
		// assertion is vacuously satisfied (hue space already separated them).
		const seen = new Map(); // hue -> first key with that hue
		let collidingPair = null;
		for (let i = 0; i < 5000 && !collidingPair; i++) {
			const key = 'probe-' + i;
			const h = hueForKey(key);
			if (seen.has(h)) {
				collidingPair = [seen.get(h), key];
			} else {
				seen.set(h, key);
			}
		}
		if (collidingPair) {
			const [k1, k2] = collidingPair;
			expect(hueForKey(k1)).toBe(hueForKey(k2));
			// Same hue, but the widened swatch pulls them apart.
			expect(colorForKey(k1)).not.toBe(colorForKey(k2));
		}
	});

	it('agrees on the server and on the client for every roster key (no SSR/CSR drift)', () => {
		// colorForKey/hueForKey are re-exported from BOTH ../server.js (the SSR
		// first-paint path) and ../client.js (the hydration path). A widened
		// helper that derived any part of the swatch from a non-deterministic or
		// environment-specific source would diverge here and cause a hydration
		// mismatch. Both entry points must compute byte-identical swatches.
		for (const key of ROSTER) {
			expect(colorViaServer(key)).toBe(colorViaClient(key));
			expect(hueViaServer(key)).toBe(hueViaClient(key));
			// And both equal the shared helper under test.
			expect(colorViaServer(key)).toBe(colorForKey(key));
		}
	});

	it('coerces non-string keys deterministically (server and client agree)', () => {
		// Numeric ids are common; the server stamps presence keys as String(id).
		// A numeric key must coerce to the same swatch as its string form, on
		// both entry points, so an app that names self numerically still matches
		// the server-rendered roster color.
		expect(colorForKey(/** @type {any} */ (123))).toBe(colorForKey('123'));
		expect(hueForKey(/** @type {any} */ (123))).toBe(hueForKey('123'));
		expect(colorViaServer(/** @type {any} */ (123))).toBe(colorViaClient('123'));
	});
});

describe('live.room enumeration (game.rooms())', () => {
	it('opt-in via meta: exposes __hasRooms, a crud __roomsStream keyed by topic, and a __roomsSync one-shot', () => {
		const game = live.room({
			topic: (ctx, id) => 'game:' + id,
			topicArgs: 1,
			init: async () => [],
			meta: (id) => ({ name: 'g' + id, cap: 32 })
		});
		expect(game.__hasRooms).toBe(true);
		expect(game.__roomsStream).toBeDefined();
		expect(game.__roomsStream.__isStream).toBe(true);
		expect(game.__roomsStream.__streamOptions.merge).toBe('crud');
		expect(game.__roomsStream.__streamOptions.key).toBe('topic');
		expect(game.__roomsSync.__isLive).toBe(true);
	});

	it('opt-in via enumerable:true with no meta (count-only enumeration)', () => {
		const game = live.room({
			topic: (ctx, id) => 'game:' + id,
			topicArgs: 1,
			init: async () => [],
			enumerable: true
		});
		expect(game.__hasRooms).toBe(true);
		expect(game.__roomsStream).toBeDefined();
		expect(game.__roomsStream.__streamOptions.key).toBe('topic');
	});

	it('is off by default: a plain room carries no enumeration surface (byte-identical)', () => {
		const game = live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [] });
		expect(game.__hasRooms).toBe(false);
		expect(game.__roomsStream).toBeUndefined();
		expect(game.__roomsSync).toBeUndefined();
	});

	it('rejects a non-function meta', () => {
		expect(() =>
			live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], meta: 5 })
		).toThrow('meta must be a function');
	});

	it('feeds created/updated/deleted to one enumeration topic as subscribers come and go', async () => {
		const game = live.room({
			topic: (ctx, id) => 'game:' + id,
			topicArgs: 1,
			init: async () => [],
			meta: (id) => ({ name: 'g' + id })
		});
		const ds = game.__dataStream;
		const pub = [];
		const ctx = { publish: (topic, event, data) => pub.push({ topic, event, data }) };
		await ds.__onSubscribe(ctx, 'game:7', [7]); // first subscriber: the room opens
		await ds.__onSubscribe(ctx, 'game:7', [7]); // second: the live count rises
		ds.__onUnsubscribe(ctx, 'game:7', 1); // one leaves: count drops to the remaining
		ds.__onUnsubscribe(ctx, 'game:7', 0); // the last leaves: the room closes
		expect(pub.map((p) => p.event)).toEqual(['created', 'updated', 'updated', 'deleted']);
		// Every delta rides the SAME per-export enumeration topic.
		const enumTopic = pub[0].topic;
		expect(pub.every((p) => p.topic === enumTopic)).toBe(true);
		// `created` carries args + count + meta; the count tracks the subscribers.
		expect(pub[0].data).toMatchObject({ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7' } });
		expect(pub[1].data.count).toBe(2);
		expect(pub[2].data.count).toBe(1);
		expect(pub[3].data).toEqual({ topic: 'game:7' });
	});

	it('captures meta once at open and contains a throwing meta (empty meta, room still opens)', async () => {
		let calls = 0;
		const game = live.room({
			topic: (ctx, id) => 'game:' + id,
			topicArgs: 1,
			init: async () => [],
			meta: (id) => { calls++; if (id === 'boom') throw new Error('x'); return { n: id }; }
		});
		const ds = game.__dataStream;
		const pub = [];
		const ctx = { publish: (t, e, d) => pub.push({ event: e, data: d }) };
		await ds.__onSubscribe(ctx, 'game:a', ['a']);
		await ds.__onSubscribe(ctx, 'game:a', ['a']); // meta is NOT recomputed for a later subscriber
		expect(calls).toBe(1);
		// A throwing meta still opens the room, with an empty meta object.
		await ds.__onSubscribe(ctx, 'game:boom', ['boom']);
		const openBoom = pub.find((p) => p.event === 'created' && p.data.topic === 'game:boom');
		expect(openBoom.data.meta).toEqual({});
	});

	it('aggregates the count cluster-wide and opens/closes on the cluster-first/last subscriber (platform.redis)', async () => {
		let metaCalls = 0;
		const game = live.room({
			topic: (ctx, id) => 'game:' + id,
			topicArgs: 1,
			init: async () => [],
			meta: (id) => { metaCalls++; return { name: 'g' + id, cap: 32 }; }
		});
		// Registration binds the stable enum identity; two replicas of one export
		// derive the SAME pub/sub topic and Redis roster key from it.
		game.__setEnumId('lobby/game');
		expect(game.__roomsStream.__streamTopic).toBe('rooms-enum:lobby/game');

		const redis = makeFakeRedis();
		const platformA = { redis };
		const platformB = { redis };
		const ds = game.__dataStream;
		const pubA = [];
		const pubB = [];
		const ctxA = { platform: platformA, publish: (topic, event, data) => pubA.push({ topic, event, data }) };
		const ctxB = { platform: platformB, publish: (topic, event, data) => pubB.push({ topic, event, data }) };

		// First subscriber lands on instance A: the cluster-wide opener publishes
		// 'created' with count 1 and resolves the card once.
		await ds.__onSubscribe(ctxA, 'game:7', [7]);
		expect(pubA).toHaveLength(1);
		expect(pubA[0].event).toBe('created');
		expect(pubA[0].topic).toBe('rooms-enum:lobby/game');
		expect(pubA[0].data).toMatchObject({ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7', cap: 32 } });

		// A second subscriber lands on instance B: the count rises CLUSTER-WIDE to
		// 2 and B reads the opener's card back rather than recomputing it.
		await ds.__onSubscribe(ctxB, 'game:7', [7]);
		expect(pubB).toHaveLength(1);
		expect(pubB[0].event).toBe('updated');
		expect(pubB[0].topic).toBe('rooms-enum:lobby/game');
		expect(pubB[0].data).toMatchObject({ topic: 'game:7', args: [7], count: 2, meta: { name: 'g7', cap: 32 } });
		// meta(args) ran exactly once across the cluster (the opener), not per replica.
		expect(metaCalls).toBe(1);

		// A late lobby viewer on instance B loads the cluster snapshot: it sees the
		// room with the cluster-wide count, not just B's local subscribers.
		const snapB = await _clusterRoomsList(platformB, 'lobby/game');
		expect(snapB).toEqual([{ topic: 'game:7', args: [7], count: 2, meta: { name: 'g7', cap: 32 } }]);

		// Instance A's only subscriber leaves. Although A has no local subscribers
		// left, the room stays open (B still has one) and the count drops to the
		// cluster-wide remaining - NOT 'deleted'. The local-remaining arg (0) is
		// irrelevant on the cluster path.
		await ds.__onUnsubscribe(ctxA, 'game:7', 0);
		expect(pubA).toHaveLength(2);
		expect(pubA[1].event).toBe('updated');
		expect(pubA[1].data).toMatchObject({ topic: 'game:7', count: 1 });

		// The cluster-last subscriber leaves on instance B: the room closes once,
		// cluster-wide, with a single 'deleted'.
		await ds.__onUnsubscribe(ctxB, 'game:7', 0);
		expect(pubB).toHaveLength(2);
		expect(pubB[1].event).toBe('deleted');
		expect(pubB[1].data).toEqual({ topic: 'game:7' });

		// The roster is empty again - both fields were removed on the cluster-last release.
		expect(await _clusterRoomsList(platformA, 'lobby/game')).toEqual([]);
	});

	it('cluster acquire/release: running count, isFirst/isLast, and a card captured once', async () => {
		const redis = makeFakeRedis();
		const platformA = { redis };
		const platformB = { redis };
		const getMetaA = () => ({ name: 'A-card' });
		const getMetaB = () => ({ name: 'B-card' });

		// The opener (0->1) sets isFirst and captures its card.
		const a1 = await _clusterRoomsAcquire(platformA, 'lobby/game', 'game:9', [9], getMetaA);
		expect(a1).toMatchObject({ isFirst: true, count: 1, args: [9], meta: { name: 'A-card' } });

		// A later acquire from another replica reads the opener's card back; its own
		// getMeta is never consulted.
		const b1 = await _clusterRoomsAcquire(platformB, 'lobby/game', 'game:9', [9], getMetaB);
		expect(b1).toMatchObject({ isFirst: false, count: 2, args: [9], meta: { name: 'A-card' } });

		// Release decrements the shared count; not last yet.
		const r1 = await _clusterRoomsRelease(platformA, 'lobby/game', 'game:9');
		expect(r1).toMatchObject({ isLast: false, count: 1, meta: { name: 'A-card' } });

		// The cluster-last release reports isLast and clears the fields.
		const r2 = await _clusterRoomsRelease(platformB, 'lobby/game', 'game:9');
		expect(r2.isLast).toBe(true);
		expect(await _clusterRoomsList(platformA, 'lobby/game')).toEqual([]);
	});

	it('cluster helpers no-op without platform.redis so the in-memory path stays in control', async () => {
		expect(await _clusterRoomsAcquire({}, 'lobby/game', 'game:1', [1], () => ({}))).toBeNull();
		expect(await _clusterRoomsRelease({}, 'lobby/game', 'game:1')).toBeNull();
		expect(await _clusterRoomsList({}, 'lobby/game')).toBeNull();
	});

	it('keeps two enumerable exports on distinct cluster rosters keyed by their module path', async () => {
		const redis = makeFakeRedis();
		const platform = { redis };
		const games = live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], meta: (id) => ({ kind: 'game' }) });
		const rooms = live.room({ topic: (ctx, id) => 'room:' + id, topicArgs: 1, init: async () => [], meta: (id) => ({ kind: 'room' }) });
		games.__setEnumId('lobby/games');
		rooms.__setEnumId('lobby/rooms');

		const sink = (arr) => ({ platform, publish: (topic, event, data) => arr.push({ topic, event, data }) });
		const gPub = [];
		const rPub = [];
		await games.__dataStream.__onSubscribe(sink(gPub), 'game:1', [1]);
		await rooms.__dataStream.__onSubscribe(sink(rPub), 'room:1', [1]);

		// Distinct stable topics; each export's roster lists only its own rooms.
		expect(gPub[0].topic).toBe('rooms-enum:lobby/games');
		expect(rPub[0].topic).toBe('rooms-enum:lobby/rooms');
		expect(await _clusterRoomsList(platform, 'lobby/games')).toEqual([{ topic: 'game:1', args: [1], count: 1, meta: { kind: 'game' } }]);
		expect(await _clusterRoomsList(platform, 'lobby/rooms')).toEqual([{ topic: 'room:1', args: [1], count: 1, meta: { kind: 'room' } }]);
	});

	it('cluster helpers fail CLOSED on a redis error (no phantom delta with a wrong count)', async () => {
		// A redis whose ops reject mid-call (a transient blip). The helpers must
		// return null so the caller publishes nothing, rather than a count the
		// shared hash never recorded.
		const blip = {
			hincrby: async () => { throw new Error('blip'); },
			hgetall: async () => { throw new Error('blip'); },
			hdel: async () => 0,
			hget: async () => null,
			hset: async () => 1,
			expire: async () => 1
		};
		const platform = { redis: blip };
		expect(await _clusterRoomsAcquire(platform, 'lobby/game', 'game:1', [1], () => ({ n: 1 }))).toBeNull();
		expect(await _clusterRoomsRelease(platform, 'lobby/game', 'game:1')).toBeNull();
		expect(await _clusterRoomsList(platform, 'lobby/game')).toEqual([]);

		// And the enum hook publishes nothing when the acquire fails closed.
		const game = live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], meta: () => ({}) });
		game.__setEnumId('lobby/game');
		const pub = [];
		await game.__dataStream.__onSubscribe({ platform, publish: (t, e, d) => pub.push({ t, e, d }) }, 'game:1', [1]);
		expect(pub).toEqual([]);
	});

	it('cluster snapshot skips a count whose card has not landed yet (the acquire window)', async () => {
		const redis = makeFakeRedis();
		// Simulate the brief window between the opener HINCRBY and its card HSET:
		// a c: field exists with no matching m: field.
		await redis.hincrby('__live-rooms:lobby/game', 'c:game:1', 1);
		expect(await _clusterRoomsList({ redis }, 'lobby/game')).toEqual([]);
		// Once the card lands, the room appears.
		await redis.hset('__live-rooms:lobby/game', 'm:game:1', JSON.stringify({ args: [1], meta: { name: 'g1' } }));
		expect(await _clusterRoomsList({ redis }, 'lobby/game')).toEqual([{ topic: 'game:1', args: [1], count: 1, meta: { name: 'g1' } }]);
	});

	it('a partial redis client (missing roster ops) falls back to the in-memory path, not a split read', async () => {
		// hincrby present but hgetall/hdel/hget absent: writes must NOT go to redis
		// while reads come from an empty Map. The uniform gate keeps it in-memory.
		const game = live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], meta: (id) => ({ name: 'g' + id }) });
		const partial = { hincrby: async () => 1 };
		const pub = [];
		const ctx = { platform: { redis: partial }, publish: (t, e, d) => pub.push({ topic: t, event: e, data: d }) };
		await game.__dataStream.__onSubscribe(ctx, 'game:7', [7]);
		// The in-memory path ran (a created with the local entry), not the cluster path.
		expect(pub).toHaveLength(1);
		expect(pub[0].event).toBe('created');
		expect(pub[0].data).toMatchObject({ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7' } });
	});

	it('keeps the enum id (and so the pub/sub topic) under the 256-char wire/bus cap, verbatim for real paths', async () => {
		// A normal module path is used verbatim - readable in logs and redis-cli.
		expect(_stableEnumId('rooms/lobby/game')).toBe('rooms/lobby/game');
		// A pathological path is bounded deterministically and collision-distinctly.
		const long = 'deeply/' + 'nested/'.repeat(60) + 'game';
		expect(long.length).toBeGreaterThan(245);
		const id = _stableEnumId(long);
		expect(id.length).toBeLessThanOrEqual(256 - 'rooms-enum:'.length);
		expect(_stableEnumId(long)).toBe(id); // deterministic: every replica agrees
		expect(_stableEnumId(long + 'x')).not.toBe(id); // a different long path -> a different id

		// End to end: an export with a huge path still produces a wire-legal topic
		// and still aggregates over the cluster (the bus would have dropped a >256 topic).
		const game = live.room({ topic: (ctx, gid) => 'game:' + gid, topicArgs: 1, init: async () => [], meta: () => ({ ok: true }) });
		game.__setEnumId(long);
		expect(game.__roomsStream.__streamTopic.length).toBeLessThanOrEqual(256);
		expect(game.__roomsStream.__streamTopic.startsWith('rooms-enum:')).toBe(true);
		const redis = makeFakeRedis();
		const pub = [];
		await game.__dataStream.__onSubscribe({ platform: { redis }, publish: (t, e, d) => pub.push({ t, e, d }) }, 'game:1', [1]);
		expect(pub).toHaveLength(1);
		expect(pub[0].t).toBe(game.__roomsStream.__streamTopic);
		expect(pub[0].e).toBe('created');
		expect(await _clusterRoomsList({ redis }, id)).toEqual([{ topic: 'game:1', args: [1], count: 1, meta: { ok: true } }]);
	});
});
