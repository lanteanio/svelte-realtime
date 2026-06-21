// Smoothed entities: live.smooth() registration, the sync/command handlers,
// the authoritative tick orchestration (drain -> publish updates -> send
// acks), close-path entity removal, and the vite codegen surfaces. The
// authority/codec machinery itself lives in the adapter and is tested there;
// these tests inject a scripted runtime through the _setSmoothRuntime seam
// and assert the orchestration contract around it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
	live,
	handleRpc,
	__register,
	close,
	_setSmoothRuntime,
	_setSmoothSpecifierForTest,
	_resetSmooth,
	_prepareHmr,
	_restoreHmr,
	_smoothLoadError,
	LiveError
} from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import svelteRealtime from '../src/vite.js';
// Internal record map, for asserting a topic record is reclaimed (same module
// instance server.js uses - ESM dedupes the import).
import { _smoothTopics } from '../src/server/smooth.js';

const textEncoder = new TextEncoder();
const toArrayBuffer = (obj) => textEncoder.encode(JSON.stringify(obj)).buffer;

let _id = 0;

/** Invoke a registered handler and return the RPC reply payload. */
async function call(ws, platform, path, args) {
	const before = platform.sent.length;
	handleRpc(ws, toArrayBuffer({ rpc: path, id: 'c' + ++_id, args }), platform);
	await vi.advanceTimersByTimeAsync(1);
	return platform.sent[before]?.data;
}

/**
 * A scripted smooth runtime: records every orchestration call and returns
 * canned drain results, so the tests pin exactly what realtime asks of the
 * authority and what it does with the answers.
 */
function fakeRuntime() {
	const entities = new Map();
	const calls = { ensure: [], enqueue: [], drains: 0, removeWs: 0, inject: [] };
	let drainQueue = [];
	const authority = {
		ensure(key, ws, initial) {
			calls.ensure.push({ key, initial });
			let e = entities.get(key);
			if (e === undefined) {
				e = { state: initial, ws, lastAckedId: 0 };
				entities.set(key, e);
			} else if (e.ws !== ws) {
				e.ws = ws;
				e.lastAckedId = 0;
			}
			return { state: e.state, lastAckedId: e.lastAckedId };
		},
		get(key) {
			return entities.get(key);
		},
		enqueue(key, batch) {
			calls.enqueue.push({ key, batch });
			return true;
		},
		inject(key, cmd) {
			// Mirror the real authority: a server-initiated command is accepted only
			// for a live entity (unknown key -> false, the cue the caller uses to skip
			// arming). The drained effect is scripted via queueDrain in the test.
			calls.inject.push({ key, cmd });
			return entities.has(key);
		},
		drain() {
			calls.drains++;
			const result = drainQueue.length > 0 ? drainQueue.shift() : { updates: [], acks: [], events: [], idle: true };
			// The real authority advances each entity's state during the drain, so a
			// post-drain catalog() reflects this tick's updates. Mirror that here so the
			// interest relevancy pass (which reads catalog() after drain) sees the moved
			// states, not the stale initial.
			for (const u of (result.updates || [])) {
				const e = entities.get(u.key);
				if (e) e.state = u.state;
			}
			return result;
		},
		remove(key) {
			return entities.delete(key);
		},
		removeWs(ws) {
			calls.removeWs++;
			const removed = [];
			for (const [k, e] of entities) {
				if (e.ws === ws) {
					entities.delete(k);
					removed.push(k);
				}
			}
			return removed;
		},
		catalog() {
			return [...entities].map(([key, e]) => ({ key, state: e.state }));
		},
		get size() {
			return entities.size;
		}
	};
	return {
		calls,
		entities,
		queueDrain(result) {
			drainQueue.push(result);
		},
		mod: {
			SMOOTH_TOPIC_PREFIX: '__smooth:',
			createSmoothAuthority: () => authority,
			createSmoothWireCodec: () => ({
				capability: 'smooth.protocol:1',
				schemaVersion: 1,
				encode: () => null,
				state: { onAttach: () => null, onDetach: () => {} }
			})
		}
	};
}

/** A mock platform extended with recording wire methods. */
function wirePlatform() {
	const p = mockPlatform();
	p.wirePublished = [];
	p.wireSent = [];
	p.publishWire = (topic, event, data, codec, options) => {
		p.wirePublished.push({ topic, event, data, options });
		return true;
	};
	p.sendWire = (ws, topic, event, data, codec) => {
		p.wireSent.push({ ws, topic, event, data });
		return 1;
	};
	return p;
}

function registerSmooth(moduleName, smoothExport) {
	__register(moduleName + '/shape/__smooth/sync', smoothExport.__smoothSync, moduleName);
	__register(moduleName + '/shape/__smooth/command', smoothExport.__smoothCommand, moduleName);
	__register(moduleName + '/shape/__smooth/center', smoothExport.__smoothCenter, moduleName);
	__register(moduleName + '/shape/__smooth/shoot', smoothExport.__smoothShoot, moduleName);
}

let moduleSeq = 0;

function declareShape(extra = {}) {
	const name = 'sm' + ++moduleSeq;
	const shape = live.smooth({
		topic: (ctx, roomId) => 'shape:' + roomId,
		topicArgs: 1,
		apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y + (cmd.dy || 0) }),
		initial: { x: 0, y: 0 },
		...extra
	});
	registerSmooth(name, shape);
	return { name, shape };
}

describe('live.smooth config validation', () => {
	it('rejects a missing config object', () => {
		expect(() => live.smooth()).toThrow('config object');
	});
	it('rejects a missing topic', () => {
		expect(() => live.smooth({ apply: () => ({}), initial: {} })).toThrow('topic');
	});
	it('rejects a missing apply', () => {
		expect(() => live.smooth({ topic: 't', initial: {} })).toThrow('apply');
	});
	it('rejects a missing initial', () => {
		expect(() => live.smooth({ topic: 't', apply: () => ({}) })).toThrow('initial');
	});
	it('rejects a non-function onMissing', () => {
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, onMissing: 5 })).toThrow('onMissing');
	});
	it('rejects a non-positive tickMs', () => {
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, tickMs: 0 })).toThrow('tickMs');
	});
	it('rejects a queueCap that is not an integer of at least 1', () => {
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, queueCap: 0 })).toThrow('queueCap');
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, queueCap: 1.5 })).toThrow('queueCap');
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, queueCap: Infinity })).toThrow('queueCap');
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, queueCap: '64' })).toThrow('queueCap');
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, queueCap: 1 })).not.toThrow();
	});
});

describe('live.smooth sync', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('subscribes the socket, ensures the entity, and returns the catalog basis', async () => {
		const { name } = declareShape();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		const res = await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		expect(res.ok).toBe(true);
		expect(res.data.topic).toBe('shape:r1');
		expect(typeof res.data.t).toBe('number');
		expect(res.data.you).toBe('u1');
		expect(res.data.ack).toBe(0);
		expect(res.data.states).toEqual([{ key: 'u1', state: { x: 0, y: 0 } }]);
		expect(ws.isSubscribed('__smooth:shape:r1')).toBe(true);
		expect(rt.calls.ensure).toHaveLength(1);
	});

	it('resolves a function-shaped initial per entity key', async () => {
		const { name } = declareShape({ initial: (key) => ({ x: 0, y: 0, who: key }) });
		const res = await call(mockWs({ id: 'u2' }), wirePlatform(), name + '/shape/__smooth/sync', ['r1']);
		expect(res.data.states).toEqual([{ key: 'u2', state: { x: 0, y: 0, who: 'u2' } }]);
	});

	it('surfaces a subscribe denial as an error reply', async () => {
		const { name } = declareShape();
		const platform = wirePlatform();
		platform.checkSubscribe = () => 'FORBIDDEN';
		const res = await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(res.ok).toBe(false);
		expect(res.code).toBe('FORBIDDEN');
	});

	it('runs the guard before resolving anything', async () => {
		const { name } = declareShape({
			guard: async (ctx, roomId) => {
				if (roomId === 'locked') throw new Error('denied');
			}
		});
		const res = await call(mockWs({ id: 'u1' }), wirePlatform(), name + '/shape/__smooth/sync', ['locked']);
		expect(res.ok).toBe(false);
	});

});

describe('live.smooth without the adapter smooth plugin', () => {
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		_setSmoothSpecifierForTest(null);
	});

	it('reports an actionable error instead of a resolution crash', async () => {
		// Force the lazy plugin import to reject (bogus specifier) so this
		// exercises the load-failure path regardless of whether the installed
		// adapter ships the smooth plugin.
		_setSmoothRuntime(null);
		_setSmoothSpecifierForTest('svelte-adapter-uws/plugins/__smooth_absent__');
		const { name } = declareShape();
		const platform = wirePlatform();
		handleRpc(mockWs({ id: 'u1' }), toArrayBuffer({ rpc: name + '/shape/__smooth/sync', id: 'c' + ++_id, args: ['r1'] }), platform);
		const deadline = Date.now() + 2000;
		while (platform.sent.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5));
		}
		const res = platform.sent[0]?.data;
		expect(res).toBeDefined();
		expect(res.ok).toBe(false);
		expect(res.error).toContain('svelte-adapter-uws');
	});

	it('a runtime injected while the real import is in flight is not clobbered by its settlement', async () => {
		_setSmoothRuntime(null);
		const local = fakeRuntime();
		const { name } = declareShape();
		const platform = wirePlatform();
		const ws = mockWs({ id: 'u1' });
		// Kick off a sync against the real lazy loader (the import of the
		// adapter subpath rejects in this repo), then inject the scripted
		// runtime before that import settles. The pending sync and every
		// later call must ride the injected runtime - the late rejection
		// must neither error the sync nor reinstate the loader.
		handleRpc(ws, toArrayBuffer({ rpc: name + '/shape/__smooth/sync', id: 'c' + ++_id, args: ['r1'] }), platform);
		_setSmoothRuntime(local.mod);
		const deadline = Date.now() + 2000;
		while (platform.sent.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5));
		}
		const res = platform.sent[0]?.data;
		expect(res).toBeDefined();
		expect(res.ok).toBe(true);
		expect(res.data.states).toEqual([{ key: 'u1', state: { x: 0, y: 0 } }]);
		expect(local.calls.ensure).toHaveLength(1);

		// A later sync still rides the injected runtime.
		handleRpc(mockWs({ id: 'u2' }), toArrayBuffer({ rpc: name + '/shape/__smooth/sync', id: 'c' + ++_id, args: ['r1'] }), platform);
		while (platform.sent.length < 2 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5));
		}
		const res2 = platform.sent[1]?.data;
		expect(res2).toBeDefined();
		expect(res2.ok).toBe(true);
		expect(local.calls.ensure).toHaveLength(2);
	});
});

describe('smooth load-error classification', () => {
	it('a missing module surfaces as version skew', () => {
		for (const code of ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']) {
			const e = _smoothLoadError(Object.assign(new Error('not found'), { code }));
			expect(e).toBeInstanceOf(LiveError);
			expect(e.code).toBe('INTERNAL');
			expect(e.message).toContain('svelte-adapter-uws 0.6.0-next.24');
		}
	});

	it('any other failure surfaces as itself, never as version skew', () => {
		const broken = _smoothLoadError(new SyntaxError('Unexpected token'));
		expect(broken).toBeInstanceOf(LiveError);
		expect(broken.message).toContain('Unexpected token');
		expect(broken.message).not.toContain('0.6.0-next.24');
		const weird = _smoothLoadError('plain string rejection');
		expect(weird.message).toContain('plain string rejection');
		const empty = _smoothLoadError(undefined);
		expect(empty.message).toContain('failed to load');
	});
});

describe('live.smooth commands and the authoritative tick', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('ensures on first command, enqueues, drains on the tick, publishes with sender exclusion, and acks the owner', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 5, y: 0 }, ws, commanded: true }],
			acks: [{ key: 'u1', ws, id: 3, state: { x: 5, y: 0 } }],
			idle: true
		});

		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 3, cmd: { dx: 5 } }]]);
		expect(rt.calls.ensure).toHaveLength(1);
		expect(rt.calls.enqueue).toEqual([{ key: 'u1', batch: [{ id: 3, cmd: { dx: 5 } }] }]);
		expect(rt.calls.drains).toBe(0);

		await vi.advanceTimersByTimeAsync(20);
		expect(rt.calls.drains).toBe(1);
		expect(platform.wirePublished).toHaveLength(1);
		expect(platform.wirePublished[0].topic).toBe('__smooth:shape:r1');
		expect(platform.wirePublished[0].event).toBe('update');
		expect(platform.wirePublished[0].data).toEqual({ key: 'u1', data: { x: 5, y: 0 } });
		expect(platform.wirePublished[0].options).toEqual({ excludeWs: ws });
		expect(platform.wireSent).toHaveLength(1);
		expect(platform.wireSent[0].event).toBe('ack');
		expect(platform.wireSent[0].data.id).toBe(3);
		expect(platform.wireSent[0].data.state).toEqual({ x: 5, y: 0 });
		expect(typeof platform.wireSent[0].data.t).toBe('number');
	});

	it('publishes without exclusion when noEcho is off', async () => {
		const { name } = declareShape({ tickMs: 20, noEcho: false });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({ updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws, commanded: true }], acks: [], idle: true });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		await vi.advanceTimersByTimeAsync(20);
		expect(platform.wirePublished[0].options).toBeUndefined();
	});

	it('excludes only commanded updates - onMissing motion reaches its owner', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const owner = mockWs({ id: 'u1' });
		const drifter = mockWs({ id: 'u2' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [
				{ key: 'u1', state: { x: 5, y: 0 }, ws: owner, commanded: true },
				{ key: 'u2', state: { x: 7, y: 0 }, ws: drifter, commanded: false }
			],
			acks: [],
			idle: true
		});
		await call(owner, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 5 } }]]);
		await vi.advanceTimersByTimeAsync(20);
		expect(platform.wirePublished).toHaveLength(2);
		// Commanded: the acknowledgement is the owner's copy, so the owner is excluded.
		expect(platform.wirePublished[0].data).toEqual({ key: 'u1', data: { x: 5, y: 0 } });
		expect(platform.wirePublished[0].options).toEqual({ excludeWs: owner });
		// onMissing motion produced no acknowledgement, so the owner must hear the broadcast.
		expect(platform.wirePublished[1].data).toEqual({ key: 'u2', data: { x: 7, y: 0 } });
		expect(platform.wirePublished[1].options).toBeUndefined();
	});

	it('publishes drain events author-excluded, except toAuthor and global which reach the author', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const owner = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [],
			acks: [],
			events: [
				// A normal owner-authored event: the owner drew it optimistically, so exclude its echo.
				{ type: 'shot', key: '3:0', data: { dir: 'N' }, id: 3, opts: null, ws: owner, commanded: true },
				// toAuthor: the owner must receive the authoritative copy.
				{ type: 'hit', key: '3:1', data: { dmg: 10 }, id: 3, opts: { toAuthor: true }, ws: owner, commanded: true },
				// global: the author needs the broadcast too (forward-compat for interest culling).
				{ type: 'kill', key: '3:2', data: { who: 'u2' }, id: 3, opts: { global: true }, ws: owner, commanded: true }
			],
			idle: true
		});
		await call(owner, platform, name + '/shape/__smooth/command', ['r1', [{ id: 3, cmd: { fire: true } }]]);
		await vi.advanceTimersByTimeAsync(20);
		const evs = platform.wirePublished.filter((p) => p.event === 'event');
		expect(evs).toHaveLength(3);
		// The wire data carries only {type,key,data,id} - never ws/commanded/opts.
		expect(evs[0].data).toEqual({ type: 'shot', key: '3:0', data: { dir: 'N' }, id: 3 });
		expect(evs[0].options).toEqual({ excludeWs: owner }); // normal: author-excluded
		expect(evs[1].data).toEqual({ type: 'hit', key: '3:1', data: { dmg: 10 }, id: 3 });
		expect(evs[1].options).toBeUndefined(); // toAuthor: reaches the author
		expect(evs[2].data).toEqual({ type: 'kill', key: '3:2', data: { who: 'u2' }, id: 3 });
		expect(evs[2].options).toBeUndefined(); // global: reaches the author
	});

	it('does not author-exclude events when noEcho is off', async () => {
		const { name } = declareShape({ tickMs: 20, noEcho: false });
		const owner = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [],
			acks: [],
			events: [{ type: 'shot', key: '1:0', data: {}, id: 1, opts: null, ws: owner, commanded: true }],
			idle: true
		});
		await call(owner, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { fire: true } }]]);
		await vi.advanceTimersByTimeAsync(20);
		const ev = platform.wirePublished.find((p) => p.event === 'event');
		expect(ev.options).toBeUndefined();
	});

	it('falls back to plain publish/send on a platform without the wire methods', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 2, y: 0 }, ws }],
			acks: [{ key: 'u1', ws, id: 1, state: { x: 2, y: 0 } }],
			idle: true
		});
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 2 } }]]);
		const sentBefore = platform.sent.length;
		await vi.advanceTimersByTimeAsync(20);
		const update = platform.published.find((p) => p.event === 'update');
		expect(update).toBeDefined();
		expect(update.options).toEqual({ compress: false });
		const ack = platform.sent.slice(sentBefore).find((s) => s.event === 'ack');
		expect(ack).toBeDefined();
	});

	it('re-arms the tick while the drain reports pending work and stops once idle', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({ updates: [], acks: [], idle: false });
		rt.queueDrain({ updates: [], acks: [], idle: true });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		expect(rt.calls.drains).toBe(1);
		await vi.advanceTimersByTimeAsync(20);
		expect(rt.calls.drains).toBe(2);
		await vi.advanceTimersByTimeAsync(100);
		expect(rt.calls.drains).toBe(2);
	});

	it('ignores commands from a socket that does not own the entity', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const owner = mockWs({ id: 'u1' });
		const intruder = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(owner, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(intruder, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 9 } }]]);
		expect(rt.calls.enqueue).toHaveLength(0);
	});

	it('a second socket takes ownership by syncing', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const first = mockWs({ id: 'u1' });
		const second = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(first, platform, name + '/shape/__smooth/sync', ['r1']);
		const res = await call(second, platform, name + '/shape/__smooth/sync', ['r1']);
		expect(res.data.ack).toBe(0);
		await call(second, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		expect(rt.calls.enqueue).toHaveLength(1);
	});

	it('ignores a malformed command batch', async () => {
		const { name } = declareShape();
		const platform = wirePlatform();
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/command', ['r1', 'nope']);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/command', ['r1', []]);
		expect(rt.calls.enqueue).toHaveLength(0);
	});
});

describe('live.smooth socket close during in-flight handlers', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('a sync that resumes after its socket closed errors instead of creating a ghost entity', async () => {
		let releaseGuard;
		const gate = new Promise((r) => { releaseGuard = r; });
		const { name } = declareShape({ guard: () => gate });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		handleRpc(ws, toArrayBuffer({ rpc: name + '/shape/__smooth/sync', id: 'c' + ++_id, args: ['r1'] }), platform);
		await vi.advanceTimersByTimeAsync(1);
		expect(platform.sent).toHaveLength(0);

		close(ws, { platform });
		releaseGuard();
		await vi.advanceTimersByTimeAsync(1);

		const res = platform.sent[0]?.data;
		expect(res).toBeDefined();
		expect(res.ok).toBe(false);
		expect(res.code).toBe('CONNECTION_CLOSED');
		expect(rt.entities.size).toBe(0);

		// A fresh sync from a live socket sees an empty catalog plus itself -
		// no ghost survived the race.
		const fresh = await call(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(fresh.ok).toBe(true);
		expect(fresh.data.states).toEqual([{ key: 'u2', state: { x: 0, y: 0 } }]);
	});

	it('a command that resumes after its socket closed bails without ensuring or enqueueing', async () => {
		let releaseGuard;
		const gate = new Promise((r) => { releaseGuard = r; });
		const { name } = declareShape({ guard: () => gate });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		handleRpc(ws, toArrayBuffer({ rpc: name + '/shape/__smooth/command', id: 'c' + ++_id, args: ['r1', [{ id: 1, cmd: { dx: 1 } }]] }), platform);
		await vi.advanceTimersByTimeAsync(1);

		close(ws, { platform });
		releaseGuard();
		await vi.advanceTimersByTimeAsync(1);

		expect(rt.calls.ensure).toHaveLength(0);
		expect(rt.calls.enqueue).toHaveLength(0);
		expect(rt.entities.size).toBe(0);
	});

	it('a dead socket cannot steal ownership from a live tab through a resumed sync', async () => {
		let releaseGuard;
		let gate = null;
		const { name } = declareShape({
			tickMs: 20,
			guard: () => (gate !== null ? gate : undefined)
		});
		const live1 = mockWs({ id: 'u1' });
		const dying = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(live1, platform, name + '/shape/__smooth/sync', ['r1']);

		gate = new Promise((r) => { releaseGuard = r; });
		handleRpc(dying, toArrayBuffer({ rpc: name + '/shape/__smooth/sync', id: 'c' + ++_id, args: ['r1'] }), platform);
		await vi.advanceTimersByTimeAsync(1);
		close(dying, { platform });
		releaseGuard();
		await vi.advanceTimersByTimeAsync(1);

		// The live tab still owns the entity: its commands keep flowing.
		gate = null;
		await call(live1, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		expect(rt.calls.enqueue).toHaveLength(1);
	});
});

describe('live.smooth close drain', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('removes the closing socket entities, broadcasts departures, and drops the emptied record', async () => {
		const { name } = declareShape();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		expect(rt.entities.size).toBe(1);

		close(ws, { platform });
		expect(rt.calls.removeWs).toBeGreaterThan(0);
		expect(rt.entities.size).toBe(0);
		const removeFrame = platform.wirePublished.find((p) => p.event === 'remove');
		expect(removeFrame).toBeDefined();
		expect(removeFrame.data).toEqual({ key: 'u1' });
		expect(removeFrame.topic).toBe('__smooth:shape:r1');
	});

	it('the tick self-heals an entity bound to a closed socket: removed and broadcast, never acked', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ghost = mockWs({ id: 'u1' });
		const alive = mockWs({ id: 'u2' });
		const platform = wirePlatform();
		await call(alive, platform, name + '/shape/__smooth/sync', ['r1']);

		close(ghost, { platform });
		const removeWsBaseline = rt.calls.removeWs;
		// An entity that slipped past the close drain and stayed bound to the
		// closed socket - exactly what the per-ack liveness check must catch.
		rt.entities.set('u1', { state: { x: 9, y: 9 }, ws: ghost, lastAckedId: 0 });
		rt.queueDrain({
			updates: [],
			acks: [
				{ key: 'u1', ws: ghost, id: 5, state: { x: 9, y: 9 } },
				{ key: 'u2', ws: alive, id: 1, state: { x: 0, y: 0 } }
			],
			idle: true
		});

		await call(alive, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);

		expect(rt.calls.removeWs).toBeGreaterThan(removeWsBaseline);
		expect(rt.entities.has('u1')).toBe(false);
		const removeFrame = platform.wirePublished.find((p) => p.event === 'remove');
		expect(removeFrame).toBeDefined();
		expect(removeFrame.data).toEqual({ key: 'u1' });
		// The live owner is still acked; the ghost never is.
		const acks = platform.wireSent.filter((s) => s.event === 'ack');
		expect(acks).toHaveLength(1);
		expect(acks[0].ws).toBe(alive);
	});
});

describe('live.smooth across HMR', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('snapshots and clears smooth records, cancels armed ticks, and restores on failed re-import', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		expect(rt.calls.drains).toBe(0);

		const snap = _prepareHmr();
		expect(snap.smooth).toBeDefined();
		expect(snap.smooth.size).toBe(1);
		expect(snap.smooth.has('shape:r1')).toBe(true);

		// The armed tick was cancelled along with the registry snapshot.
		await vi.advanceTimersByTimeAsync(200);
		expect(rt.calls.drains).toBe(0);

		// The live map emptied: a close drain finds no record to walk.
		const removeWsBaseline = rt.calls.removeWs;
		close(mockWs({ id: 'probe' }), { platform });
		expect(rt.calls.removeWs).toBe(removeWsBaseline);

		_restoreHmr(snap);

		// The restored record re-arms on the next enqueue and drains again.
		rt.queueDrain({ updates: [], acks: [], idle: true });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 2, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		expect(rt.calls.drains).toBe(1);

		// The entity survived the round trip: a fresh sync sees it in the catalog.
		const res = await call(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(res.ok).toBe(true);
		expect(res.data.states).toEqual(
			expect.arrayContaining([{ key: 'u1', state: { x: 0, y: 0 } }])
		);
	});
});

// ---------------------------------------------------------------------------
// Codegen: the vite plugin detects a live.smooth() export and emits the
// client namespace, the SSR stub, the registry lines, and the typegen entry.
// ---------------------------------------------------------------------------

const testRoot = resolve(import.meta.dirname, '__smooth_fixtures__');
const liveDir = resolve(testRoot, 'src/live');

function setup(files = {}) {
	mkdirSync(liveDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
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

const SMOOTH_SOURCE = `
import { live } from 'svelte-realtime/server';
import { apply } from './board.shared.js';
export const shape = live.smooth({
  topic: (ctx, boardId) => 'shape:' + boardId,
  topicArgs: 1,
  apply,
  initial: { x: 0, y: 0 }
});
`;

const SHARED_SOURCE = `export function apply(state, command) { return state; }`;

describe('live.smooth() vite integration', () => {
	afterEach(teardown);

	it('generates the smooth namespace with send paths and the view factory', () => {
		setup({ 'board.js': SMOOTH_SOURCE, 'board.shared.js': SHARED_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:board', {});
		expect(code).toContain('export const shape = {');
		expect(code).toContain('_command: __rpc("board/shape/__smooth/command")');
		expect(code).toContain('_sync: __rpc("board/shape/__smooth/sync")');
		expect(code).toContain("import { SmoothEntity } from 'svelte-realtime/smooth';");
		expect(code).toContain("import { createSmoothChannel } from 'svelte-adapter-uws/plugins/smooth/client';");
		expect(code).toContain('smooth(...args)');
		expect(code).toContain('_command.fireAndForget(...roomArgs, batch)');
		// The app apply travels at the factory call site, never through the
		// generated module - the stub must not serialize functions.
		expect(code).not.toContain('apply:');
	});

	it('registers the command and sync paths in the build registry', () => {
		setup({ 'board.js': SMOOTH_SOURCE, 'board.shared.js': SHARED_SOURCE });
		const plugin = createPlugin();
		const registry = plugin.load('\0live:__registry', {});
		expect(registry).toContain('board/shape/__smooth/command');
		expect(registry).toContain('board/shape/__smooth/sync');
		expect(registry).toContain('__smoothCommand');
		expect(registry).toContain('__smoothSync');
	});

	it('emits an inert SSR namespace whose factory echoes the initial state', () => {
		setup({ 'board.js': SMOOTH_SOURCE, 'board.shared.js': SHARED_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:board', { ssr: true });
		expect(code).toContain('smooth:');
		expect(code).toContain("status: readable('connecting')");
		expect(code).toContain('o.initial');
		// The inert view mirrors the live surface so an isomorphic component
		// calling view.onEvent during SSR gets a no-op that returns a disposer.
		expect(code).toContain('onEvent: () => () => {}');
		expect(code).not.toContain('createSmoothChannel');
	});
});

/**
 * A scripted smooth cluster coordinator (the `platform.smooth` surface): records
 * every relay call and exposes `emit.*` to drive the inbound handlers, so the
 * tests pin exactly what the realtime layer forwards and how it reacts to a
 * peer's frame - the cluster analog of fakeRuntime() scripting the authority.
 */
function scriptedSmoothCluster(opts = {}) {
	const calls = {
		relayCommand: [], requestSync: [], sendSyncReply: [],
		relayBroadcast: [], relayAck: [], relayLeave: [],
		acquireOwner: [], renewOwner: [], releaseOwner: [],
		writeSnapshot: [], readSnapshot: []
	};
	let handlers = null;
	let owner = opts.owner !== undefined ? opts.owner : true;
	let resolveReadFn = null;
	const cluster = {
		instanceId: opts.instanceId || 'A',
		onMessage(h) { handlers = h; },
		relayCommand(...a) { calls.relayCommand.push(a); },
		requestSync(...a) { calls.requestSync.push(a); },
		sendSyncReply(...a) { calls.sendSyncReply.push(a); },
		relayBroadcast(...a) { calls.relayBroadcast.push(a); },
		relayAck(...a) { calls.relayAck.push(a); },
		relayLeave(...a) { calls.relayLeave.push(a); },
		async acquireOwner(t) { calls.acquireOwner.push(t); return owner; },
		async renewOwner(t) { calls.renewOwner.push(t); return opts.renew !== undefined ? opts.renew : true; },
		async releaseOwner(t) { calls.releaseOwner.push(t); return true; },
		async writeSnapshot(t, payload) { calls.writeSnapshot.push([t, payload]); },
		async readSnapshot(t) {
			calls.readSnapshot.push(t);
			const val = opts.snapshot !== undefined ? opts.snapshot : null;
			if (opts.deferRead) return new Promise((res) => { resolveReadFn = () => res(val); });
			return val;
		}
	};
	return {
		cluster,
		calls,
		setOwner(v) { owner = v; },
		resolveRead() { if (resolveReadFn) resolveReadFn(); },
		emit: {
			command: (...a) => handlers.onCommand(...a),
			sync: (...a) => handlers.onSync(...a),
			syncReply: (...a) => handlers.onSyncReply(...a),
			broadcast: (...a) => handlers.onBroadcast(...a),
			ack: (...a) => handlers.onAck(...a),
			leave: (...a) => handlers.onLeave(...a)
		}
	};
}

describe('live.smooth cluster (platform.smooth)', () => {
	const WT = '__smooth:shape:r1';
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	/** Fire an RPC without awaiting the reply (for handlers that suspend on a relay). */
	function fire(ws, platform, path, args) {
		handleRpc(ws, toArrayBuffer({ rpc: path, id: 'k' + ++_id, args }), platform);
	}

	function clusterPlatform(sc) {
		const platform = wirePlatform();
		platform.smooth = sc.cluster;
		return platform;
	}

	it('owner sync acquires the lease, ensures locally, and returns the catalog basis', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const res = await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(sc.calls.acquireOwner).toEqual([WT]);
		expect(rt.calls.ensure).toHaveLength(1);
		expect(res.data.you).toBe('u1');
		expect(res.data.states).toEqual([{ key: 'u1', state: { x: 0, y: 0 } }]);
		expect(sc.calls.requestSync).toHaveLength(0); // the owner answers itself
	});

	it('an interest owner culls its own local subscribers and still relays every update', async () => {
		const { name } = declareShape({
			tickMs: 20,
			initial: (key) => ({ A: { x: 0, y: 0 }, B: { x: 500, y: 0 } }[key] || { x: 0, y: 0 }),
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const wsA = mockWs({ id: 'A' });
		const wsB = mockWs({ id: 'B' });
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsB, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({
			updates: [
				{ key: 'A', state: { x: 1, y: 0 }, ws: wsA, commanded: false },
				{ key: 'B', state: { x: 501, y: 0 }, ws: wsB, commanded: false }
			],
			acks: [],
			idle: true
		});
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		// Local delivery is culled per subscriber (no shared publishWire updates).
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
		const sent = platform.wireSent.filter((s) => s.event === 'update');
		expect(sent.filter((s) => s.ws === wsA).map((s) => s.data.key)).toEqual(['A']);
		expect(sent.filter((s) => s.ws === wsB).map((s) => s.data.key)).toEqual(['B']);
		// Every update is still relayed cross-instance (the non-owner over-delivers
		// to its own locals in this version - safe, never under-delivers).
		const relayed = sc.calls.relayBroadcast.filter((a) => a[1] === 'update').map((a) => a[2].key);
		expect(relayed.sort()).toEqual(['A', 'B']);
	});

	it('non-owner sync forwards a request and resolves with the owner reply', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const before = platform.sent.length;
		fire(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		expect(sc.calls.requestSync).toHaveLength(1);
		const [wireTopic, identity, originInstance, corr] = sc.calls.requestSync[0];
		expect([wireTopic, identity, originInstance]).toEqual([WT, 'u2', 'B']);
		sc.emit.syncReply(WT, corr, { ack: 9, states: [{ key: 'u1', state: { x: 1, y: 2 } }] });
		await vi.advanceTimersByTimeAsync(1);
		const reply = platform.sent[before]?.data;
		expect(reply.data.ack).toBe(9);
		expect(reply.data.states).toEqual([{ key: 'u1', state: { x: 1, y: 2 } }]);
		expect(rt.calls.ensure).toHaveLength(0); // a non-owner never ensures locally
	});

	it('non-owner sync degrades to an empty basis when the owner does not reply', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false });
		const platform = clusterPlatform(sc);
		const before = platform.sent.length;
		fire(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		expect(sc.calls.requestSync).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2000); // past the sync timeout
		const reply = platform.sent[before]?.data;
		expect(reply.data.ack).toBe(0);
		expect(reply.data.states).toEqual([]);
	});

	it('forwards a command to the owner when this instance is not the owner', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		fire(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
		await call(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		expect(sc.calls.relayCommand).toEqual([[WT, 'u2', 'B', [{ id: 1, cmd: { dx: 1 } }]]]);
		expect(rt.calls.enqueue).toHaveLength(0); // a non-owner does not tick locally
	});

	it('owner tick relays each broadcast with a monotonic per-topic seq; the local-author ack stays local', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 5, y: 0 }, ws, commanded: true }],
			acks: [{ key: 'u1', ws, id: 3, state: { x: 5, y: 0 } }],
			events: [{ type: 'shot', key: '3:0', data: {}, id: 3, opts: null, ws, commanded: true }],
			idle: true
		});
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 3, cmd: { dx: 5 } }]]);
		await vi.advanceTimersByTimeAsync(20);
		// Local emit: the owner's own client is excluded from its own update/event.
		const localUpdate = platform.wirePublished.find((p) => p.event === 'update');
		expect(localUpdate.options).toEqual({ excludeWs: ws });
		// Relay: update then event, each with the next seq; a native author needs
		// no cross-instance exclude (it is on no other instance).
		expect(sc.calls.relayBroadcast.map((r) => [r[1], r[3], r[4]])).toEqual([
			['update', undefined, 0],
			['event', undefined, 1]
		]);
		// The owner's own client ack is delivered locally, never relayed.
		expect(sc.calls.relayAck).toHaveLength(0);
		expect(platform.wireSent.filter((s) => s.event === 'ack')).toHaveLength(1);
	});

	it('owner enqueues a forwarded command (dropping already-acked ids) and relays its ack + update back', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true, instanceId: 'A' });
		const platform = clusterPlatform(sc);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']); // A owns + wires handlers
		sc.emit.command(WT, 'u2', 'B', [{ id: 5, cmd: { dx: 9 } }]);
		expect(rt.calls.ensure.some((e) => e.key === 'u2')).toBe(true); // surrogate ensured
		expect(rt.calls.enqueue).toContainEqual({ key: 'u2', batch: [{ id: 5, cmd: { dx: 9 } }] });
		// A redelivery of an already-acked id is dropped, not re-applied.
		rt.entities.get('u2').lastAckedId = 5;
		sc.emit.command(WT, 'u2', 'B', [{ id: 5, cmd: {} }, { id: 4, cmd: {} }]);
		expect(rt.calls.enqueue.filter((e) => e.key === 'u2')).toHaveLength(1);
		// On the tick, the remote client's ack relays back to its instance and the
		// update relays excluding the remote author identity.
		const surrogate = rt.entities.get('u2').ws;
		rt.queueDrain({
			updates: [{ key: 'u2', state: { x: 9, y: 0 }, ws: surrogate, commanded: true }],
			acks: [{ key: 'u2', ws: surrogate, id: 5, state: { x: 9, y: 0 } }],
			idle: true
		});
		await vi.advanceTimersByTimeAsync(20);
		expect(sc.calls.relayAck).toHaveLength(1);
		expect(sc.calls.relayAck[0].slice(0, 3)).toEqual([WT, 'u2', 'B']);
		expect(sc.calls.relayAck[0][3].id).toBe(5);
		const upRelay = sc.calls.relayBroadcast.find((r) => r[1] === 'update');
		expect(upRelay[3]).toBe('u2'); // relay excludes the remote author identity
	});

	it('re-emits a relayed broadcast to local subscribers, excluding only a local author', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false });
		const platform = clusterPlatform(sc);
		const sub = mockWs({ id: 'viewer' });
		fire(sub, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
		// Author is the local subscriber -> excluded.
		sc.emit.broadcast(WT, 'update', { key: 'a', data: { x: 1 } }, 'viewer', 0, 'A');
		// Author is on another instance -> nobody local excluded.
		sc.emit.broadcast(WT, 'update', { key: 'b', data: { x: 2 } }, 'elsewhere', 1, 'A');
		const ups = platform.wirePublished.filter((p) => p.event === 'update');
		expect(ups).toHaveLength(2);
		expect(ups[0].options).toEqual({ excludeWs: sub });
		expect(ups[1].options).toBeUndefined();
	});

	it('delivers a relayed ack to the registered local socket', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false });
		const platform = clusterPlatform(sc);
		const sub = mockWs({ id: 'u2' });
		fire(sub, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.ack(WT, 'u2', { id: 7, state: { x: 1 }, t: 123 });
		const ack = platform.wireSent.find((s) => s.event === 'ack');
		expect(ack.ws).toBe(sub);
		expect(ack.data.id).toBe(7);
	});

	it('drops a redelivered or regressing broadcast seq, and resets the watermark on an owner change', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false });
		const platform = clusterPlatform(sc);
		fire(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
		const ev = (key, seq, owner) => sc.emit.broadcast(WT, 'event', { type: 'x', key, data: {}, id: 1 }, undefined, seq, owner);
		ev('1:0', 5, 'A');
		ev('1:1', 5, 'A'); // duplicate seq -> dropped
		ev('1:2', 3, 'A'); // regressing seq -> dropped
		expect(platform.wirePublished.filter((p) => p.event === 'event')).toHaveLength(1);
		// A new owner restarts the seq counter; the watermark resets so its lower
		// seqs are NOT dropped.
		ev('2:0', 0, 'B');
		expect(platform.wirePublished.filter((p) => p.event === 'event')).toHaveLength(2);
	});

	it('relays a leave to the owner when a local subscriber closes (non-owner)', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u2' });
		fire(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
		close(ws, { platform });
		expect(sc.calls.relayLeave).toEqual([[WT, 'u2', 'B']]);
	});

	it('owner drops a remote client surrogate and broadcasts the removal on leave', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		sc.emit.command(WT, 'u2', 'B', [{ id: 1, cmd: {} }]); // ensures the surrogate
		expect(rt.entities.has('u2')).toBe(true);
		sc.emit.leave(WT, 'u2', 'B');
		expect(rt.entities.has('u2')).toBe(false);
		const remove = sc.calls.relayBroadcast.find((r) => r[1] === 'remove');
		expect(remove[2]).toEqual({ key: 'u2' });
	});

	it('renews the ownership lease from the tick while owning', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({ updates: [], acks: [], idle: false });
		rt.queueDrain({ updates: [], acks: [], idle: true });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(40);
		expect(sc.calls.renewOwner).toContain(WT);
	});

	it('keeps renewing the lease while holding an IDLE entity (does not stop when the drain goes idle)', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		// No queued drains: every drain reports idle while the entity is still held.
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		const after1 = sc.calls.renewOwner.length;
		expect(after1).toBeGreaterThanOrEqual(1);
		// The tick must keep firing across renew intervals despite being idle, or
		// the lease would silently expire under a live owner.
		await vi.advanceTimersByTimeAsync(6500);
		expect(sc.calls.renewOwner.length).toBeGreaterThan(after1);
	});

	it('a non-owner sync that closes mid-flight resolves (no hang) and relays a leave', async () => {
		const { name } = declareShape();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u2' });
		const before = platform.sent.length;
		fire(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		expect(sc.calls.requestSync).toHaveLength(1); // suspended awaiting the owner reply
		close(ws, { platform }); // forgets the record while the sync is in flight
		await vi.advanceTimersByTimeAsync(1);
		// The suspended handler resumed (its pending sync was resolved, not orphaned),
		// hit its liveness re-check, and errored - it did NOT hang.
		const res = platform.sent[before]?.data;
		expect(res).toBeDefined();
		expect(res.ok).toBe(false);
		expect(res.code).toBe('CONNECTION_CLOSED');
		expect(sc.calls.relayLeave).toEqual([[WT, 'u2', 'B']]);
	});

	it('a demoted owner (failed renew) stops ticking and relaying', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true, renew: false }); // the renew fails -> demotion
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({ updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws, commanded: true }], acks: [], idle: false });
		rt.queueDrain({ updates: [{ key: 'u1', state: { x: 2, y: 0 }, ws, commanded: true }], acks: [], idle: false });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20); // tick 1: relays (still owned), renew fires -> false -> demote
		const afterTick1 = sc.calls.relayBroadcast.length;
		expect(afterTick1).toBeGreaterThanOrEqual(1);
		expect(sc.calls.renewOwner.length).toBeGreaterThanOrEqual(1);
		await vi.advanceTimersByTimeAsync(80); // subsequent ticks must bail: no new relays
		expect(sc.calls.relayBroadcast.length).toBe(afterTick1);
	});

	it('reclaims a demoted owner that holds only remote surrogates (no local subscriber)', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true, renew: false }); // renew fails -> demotion
		const platform = clusterPlatform(sc);
		const local = mockWs({ id: 'u1' });
		await call(local, platform, name + '/shape/__smooth/sync', ['r1']); // owner, local u1
		// A remote client commands -> the owner mints a surrogate entity for it.
		sc.emit.command(WT, 'remoteUser', 'B', [{ id: 1, cmd: {} }]);
		expect(rt.entities.has('remoteUser')).toBe(true);
		// The only LOCAL subscriber leaves: the record is retained (a remote
		// surrogate still lives) and keeps ticking/renewing - registry now empty.
		close(local, { platform });
		expect(_smoothTopics.has('shape:r1')).toBe(true);
		// A failed renew demotes it. With no local subscriber there is no future
		// close to reclaim it, so the demotion path must forget it now (else leak).
		await vi.advanceTimersByTimeAsync(20);
		expect(_smoothTopics.has('shape:r1')).toBe(false);
	});

	it('a relayed frame resolves to a record RE-CREATED after HMR (no stale wire index)', async () => {
		const { name, shape } = declareShape();
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		// A local subscriber 'u1' on the pre-reload record.
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		// HMR success path: the topics map is cleared and the snapshot discarded; the
		// module re-registers its exports and a fresh sync builds a NEW record object
		// for the same topic (this is the case a stale separate index would break -
		// the FAILED-reimport restore path reuses the same object and masks the bug).
		_prepareHmr();
		registerSmooth(name, shape); // the re-import re-registers the same export
		await call(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		// A relayed ack for 'u2' must route to the NEW record (which registered u2).
		// A stale index pointing at the discarded pre-reload record - where only u1
		// was registered - would drop the ack, so this discriminates the fix.
		sc.emit.ack(WT, 'u2', { id: 5, state: { x: 0, y: 0 }, t: 1 });
		const ack = platform.wireSent.find((s) => s.event === 'ack');
		expect(ack).toBeDefined();
		expect(ack.data.id).toBe(5);
	});

	// --- Warm-handoff snapshot opt-in (live.smooth({ snapshot: true })) ---

	it('owner sync with snapshot on seeds the entity from the recovered state', async () => {
		const { name } = declareShape({ snapshot: true });
		const sc = scriptedSmoothCluster({ owner: true, snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }] });
		const platform = clusterPlatform(sc);
		const res = await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(sc.calls.readSnapshot).toEqual([WT]); // read once, on acquire
		// The recovered state seeds the entity instead of the declared initial {x:0,y:0}.
		expect(rt.calls.ensure).toEqual([{ key: 'u1', initial: { x: 7, y: 9 } }]);
		expect(res.data.states).toEqual([{ key: 'u1', state: { x: 7, y: 9 } }]);
	});

	it('seeds a roster member when its client re-binds; reads the snapshot once per tenure', async () => {
		const { name } = declareShape({ snapshot: true });
		const sc = scriptedSmoothCluster({
			owner: true,
			snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }, { key: 'u2', state: { x: 1, y: 2 } }]
		});
		const platform = clusterPlatform(sc);
		// u1 syncs first: owner acquires, reads the snapshot, seeds u1.
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		// u2 syncs next on the SAME owner: no second read, but u2 still seeds from
		// the pending snapshot the moment it binds.
		await call(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(sc.calls.readSnapshot).toEqual([WT]); // once per tenure, not per sync
		expect(rt.calls.ensure).toEqual([
			{ key: 'u1', initial: { x: 7, y: 9 } },
			{ key: 'u2', initial: { x: 1, y: 2 } }
		]);
	});

	it('a key absent from the snapshot falls back to the declared initial', async () => {
		const { name } = declareShape({ snapshot: true });
		const sc = scriptedSmoothCluster({ owner: true, snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }] });
		const platform = clusterPlatform(sc);
		// u2 is not in the snapshot -> it starts from the declared initial.
		await call(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(rt.calls.ensure).toEqual([{ key: 'u2', initial: { x: 0, y: 0 } }]);
	});

	it('snapshot off (the default) never reads a snapshot and seeds the declared initial', async () => {
		const { name } = declareShape(); // no snapshot opt-in
		const sc = scriptedSmoothCluster({ owner: true, snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }] });
		const platform = clusterPlatform(sc);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(sc.calls.readSnapshot).toEqual([]); // never read
		expect(rt.calls.ensure).toEqual([{ key: 'u1', initial: { x: 0, y: 0 } }]); // declared initial
	});

	it('the owner tick debounce-writes the catalog snapshot when snapshot is on', async () => {
		const { name } = declareShape({ snapshot: true, tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']); // ensures u1 -> authority non-empty
		// A command arms the tick (a cluster owner then re-arms every tick).
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		await vi.advanceTimersByTimeAsync(20); // one owned tick
		expect(sc.calls.writeSnapshot).toHaveLength(1);
		const [topic, payload] = sc.calls.writeSnapshot[0];
		expect(topic).toBe(WT);
		expect(payload).toEqual([{ key: 'u1', state: { x: 0, y: 0 } }]); // the catalog
	});

	it('snapshot off: the owner tick never writes a snapshot', async () => {
		const { name } = declareShape({ tickMs: 20 }); // no snapshot
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(40);
		expect(sc.calls.writeSnapshot).toEqual([]);
	});

	it('a re-acquire after demotion re-reads the snapshot fresh', async () => {
		const { name } = declareShape({ snapshot: true, tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true, renew: false, snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }] });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']); // tenure 1: reads the snapshot
		expect(sc.calls.readSnapshot).toHaveLength(1);
		// A command arms the tick; on it the renew fails -> the owner is demoted and
		// drops its snapshot state. A local subscriber remains, so the record is kept.
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		// The same client re-syncs and re-acquires: snapshotLoaded was reset, so the
		// new tenure reads the snapshot again rather than reusing the stale pending.
		sc.setOwner(true);
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		expect(sc.calls.readSnapshot).toHaveLength(2);
	});

	it('a concurrent sync during a pending snapshot read still seeds from the snapshot (barrier, not a race)', async () => {
		const { name } = declareShape({ snapshot: true });
		const sc = scriptedSmoothCluster({
			owner: true,
			deferRead: true,
			snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }, { key: 'u2', state: { x: 1, y: 2 } }]
		});
		const platform = clusterPlatform(sc);
		// u1's sync acquires and suspends on the in-flight readSnapshot.
		fire(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		// u2 syncs WHILE the read is in flight: it must await the same read, not seed
		// from `initial` (the pre-fix bug seeded u2 to spawn here).
		fire(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		expect(sc.calls.readSnapshot).toHaveLength(1); // ONE shared read for both
		sc.resolveRead();
		await vi.advanceTimersByTimeAsync(1);
		expect(rt.calls.ensure).toEqual([
			{ key: 'u1', initial: { x: 7, y: 9 } },
			{ key: 'u2', initial: { x: 1, y: 2 } }
		]);
	});

	it('a relay sync during a pending snapshot read is not answered from initial (ownership is unpublished until ready)', async () => {
		const { name } = declareShape({ snapshot: true });
		const sc = scriptedSmoothCluster({ owner: true, deferRead: true, snapshot: [{ key: 'remote', state: { x: 5, y: 5 } }] });
		const platform = clusterPlatform(sc);
		fire(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']); // acquires, suspends on the read
		await vi.advanceTimersByTimeAsync(1);
		// A relay sync for a remote client arrives mid-read: rec.owned is still false,
		// so it is ignored rather than answered with an initial-seeded basis.
		sc.emit.sync(WT, 'remote', 'B', 'corr-1');
		expect(rt.calls.ensure.filter((e) => e.key === 'remote')).toHaveLength(0);
		expect(sc.calls.sendSyncReply).toHaveLength(0);
		sc.resolveRead();
		await vi.advanceTimersByTimeAsync(1);
		// Once ownership is published a fresh relay sync seeds the remote from the snapshot.
		sc.emit.sync(WT, 'remote', 'B', 'corr-2');
		expect(rt.calls.ensure).toContainEqual({ key: 'remote', initial: { x: 5, y: 5 } });
	});

	it('the owner re-persists not-yet-rebound recovered entities (the snapshot write unions catalog + pending)', async () => {
		const { name } = declareShape({ snapshot: true, tickMs: 20 });
		const sc = scriptedSmoothCluster({
			owner: true,
			snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }, { key: 'gone', state: { x: 4, y: 4 } }]
		});
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']); // u1 re-binds; 'gone' stays pending
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]); // arms the tick
		await vi.advanceTimersByTimeAsync(20);
		expect(sc.calls.writeSnapshot).toHaveLength(1);
		const payload = sc.calls.writeSnapshot[0][1];
		// The live entity AND the still-pending recovered one are both persisted, so a
		// second failover before 'gone' reconnects still recovers it.
		expect(payload).toContainEqual({ key: 'u1', state: { x: 7, y: 9 } }); // catalog (re-bound, live)
		expect(payload).toContainEqual({ key: 'gone', state: { x: 4, y: 4 } }); // pending (not yet rebound)
	});

	it('a sync-observed demotion (acquireOwner returns false) resets the snapshot so a re-acquire re-reads', async () => {
		const { name } = declareShape({ snapshot: true });
		const sc = scriptedSmoothCluster({ owner: true, snapshot: [{ key: 'u1', state: { x: 7, y: 9 } }] });
		const platform = clusterPlatform(sc);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']); // tenure 1: reads (1)
		expect(sc.calls.readSnapshot).toHaveLength(1);
		// The lease is lost; a new client's sync observes acquireOwner === false.
		sc.setOwner(false);
		fire(mockWs({ id: 'u2' }), platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		// The lease frees again and a sync re-acquires: it must read a FRESH snapshot
		// rather than reuse the prior tenure's pending set.
		sc.setOwner(true);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']); // tenure 2: reads (2)
		expect(sc.calls.readSnapshot).toHaveLength(2);
	});
});

describe('live.smooth interest validation', () => {
	const base = { topic: 't', apply: () => ({}), initial: {} };
	it('rejects a non-object interest', () => {
		expect(() => live.smooth({ ...base, interest: 5 })).toThrow('interest must be an object');
	});
	it('requires a positive radius', () => {
		expect(() => live.smooth({ ...base, interest: {} })).toThrow('interest.radius');
		expect(() => live.smooth({ ...base, interest: { radius: 0, position: () => null } })).toThrow('interest.radius');
	});
	it('requires a position function', () => {
		expect(() => live.smooth({ ...base, interest: { radius: 100 } })).toThrow('interest.position');
	});
	it('rejects a non-positive cell', () => {
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: () => null, cell: 0 } })).toThrow('interest.cell');
	});
	it('rejects malformed lod bands', () => {
		const p = () => null;
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, lod: [] } })).toThrow('interest.lod');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, lod: [{ within: 100, rate: 0 }] } })).toThrow('rate');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, lod: [{ within: 100, rate: 1.5 }] } })).toThrow('rate');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, lod: [{ within: -5, rate: 1 }] } })).toThrow('within');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, lod: [{ within: 200, rate: 1 }, { within: 100, rate: 2 }] } })).toThrow('ascending');
	});
	it('accepts a well-formed interest config', () => {
		expect(() => live.smooth({
			...base,
			interest: { radius: 500, position: (s) => ({ x: s.x, y: s.y }), lod: [{ within: 100, rate: 1 }, { within: 500, rate: 4 }], budget: 1000 }
		})).not.toThrow();
	});
});

describe('live.smooth hitTest validation (lag compensation)', () => {
	const position = (s) => ({ x: s.x, y: s.y });
	const base = { topic: 't', apply: () => ({}), initial: {}, interest: { radius: 500, position } };
	const shot = { type: 'ray', origin: () => ({ x: 0, y: 0 }), dir: () => 0, maxDist: 1000 };
	const onHit = () => {};

	it('rejects a non-object hitTest', () => {
		expect(() => live.smooth({ ...base, hitTest: 5 })).toThrow('hitTest must be an object');
	});
	it('requires interest (the candidate set is the security gate)', () => {
		expect(() => live.smooth({
			topic: 't', apply: () => ({}), initial: {},
			hitTest: { shot, onHit, hitbox: { shape: 'circle', radius: 10 } }
		})).toThrow('hitTest requires interest');
	});
	it('requires an onHit function', () => {
		expect(() => live.smooth({ ...base, hitTest: { shot, hitbox: { shape: 'circle', radius: 10 } } })).toThrow('onHit');
	});
	it('requires a ray shot', () => {
		expect(() => live.smooth({ ...base, hitTest: { onHit, hitbox: { shape: 'circle', radius: 10 } } })).toThrow('hitTest.shot');
		expect(() => live.smooth({ ...base, hitTest: { onHit, shot: { type: 'cone' }, hitbox: { shape: 'circle', radius: 10 } } })).toThrow('hitTest.shot');
		expect(() => live.smooth({ ...base, hitTest: { onHit, shot: { type: 'ray', origin: 1, dir: () => 0, maxDist: 1 }, hitbox: { shape: 'circle', radius: 10 } } })).toThrow('origin and shot.dir');
		expect(() => live.smooth({ ...base, hitTest: { onHit, shot: { type: 'ray', origin: () => ({}), dir: () => 0, maxDist: 0 }, hitbox: { shape: 'circle', radius: 10 } } })).toThrow('maxDist');
	});
	it('requires a hitbox OR a resolve function', () => {
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit } })).toThrow('hitbox (declarative) or a resolve function');
	});
	it('rejects a malformed hitbox', () => {
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'blob' } } })).toThrow("'circle' or 'aabb'");
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'circle' } } })).toThrow('positive radius');
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'aabb', w: 0, h: 10 } } })).toThrow('positive w and h');
	});
	it('rejects a malformed maxRewindMs / teleportThreshold / broadphase', () => {
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'circle', radius: 10 }, maxRewindMs: 0 } })).toThrow('maxRewindMs');
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'circle', radius: 10 }, teleportThreshold: -1 } })).toThrow('teleportThreshold');
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'circle', radius: 10 }, broadphase: { cone: 2 } } })).toThrow('cone');
	});
	it('accepts a well-formed declarative hitTest', () => {
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'circle', radius: 24 }, teleportThreshold: 300 } })).not.toThrow();
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, hitbox: { shape: 'aabb', w: 20, h: 40 } } })).not.toThrow();
	});
	it('accepts the resolve escape hatch without a hitbox', () => {
		expect(() => live.smooth({ ...base, hitTest: { shot, onHit, resolve: () => null, broadphase: { maxDist: 1500, cone: 0.707 } } })).not.toThrow();
	});
});

describe('live.smooth interest (area-of-interest culling)', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	// A and B own entities 500 apart; with radius 100 neither is in the other's
	// area of interest, so each must see only its own entity's updates.
	const posOf = { A: { x: 0, y: 0 }, B: { x: 500, y: 0 } };
	function declareInterest(extra = {}) {
		return declareShape({
			tickMs: 20,
			initial: (key) => ({ ...(posOf[key] || { x: 0, y: 0 }) }),
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) },
			...extra
		});
	}
	const updatesSent = (platform) => platform.wireSent.filter((s) => s.event === 'update');
	const updatesPublished = (platform) => platform.wirePublished.filter((p) => p.event === 'update');

	it('delivers each subscriber only the updates inside its area of interest, via the per-subscriber wire', async () => {
		const { name } = declareInterest();
		const wsA = mockWs({ id: 'A' });
		const wsB = mockWs({ id: 'B' });
		const platform = wirePlatform();
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsB, platform, name + '/shape/__smooth/sync', ['r1']);
		// onMissing-style motion (commanded: false) so each owner receives its own.
		rt.queueDrain({
			updates: [
				{ key: 'A', state: { x: 1, y: 0 }, ws: wsA, commanded: false },
				{ key: 'B', state: { x: 501, y: 0 }, ws: wsB, commanded: false }
			],
			acks: [],
			idle: true
		});
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);

		// Interest-on routes updates through the per-subscriber wire, never the
		// shared publishWire fan-out.
		expect(updatesPublished(platform)).toHaveLength(0);
		const sent = updatesSent(platform);
		const toA = sent.filter((s) => s.ws === wsA);
		const toB = sent.filter((s) => s.ws === wsB);
		expect(toA).toHaveLength(1);
		expect(toA[0].data).toEqual({ key: 'A', data: { x: 1, y: 0 } });
		expect(toB).toHaveLength(1);
		expect(toB[0].data).toEqual({ key: 'B', data: { x: 501, y: 0 } });
	});

	it('suppresses an owner own commanded update (the ack is its copy) but delivers onMissing motion', async () => {
		const { name } = declareInterest();
		const wsA = mockWs({ id: 'A' });
		const platform = wirePlatform();
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({
			updates: [{ key: 'A', state: { x: 2, y: 0 }, ws: wsA, commanded: true }],
			acks: [],
			idle: true
		});
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		// Own commanded update is echo-suppressed and no one else is in range.
		expect(updatesSent(platform)).toHaveLength(0);

		// An onMissing (non-commanded) update for the same owner IS delivered to it.
		rt.queueDrain({
			updates: [{ key: 'A', state: { x: 3, y: 0 }, ws: wsA, commanded: false }],
			acks: [],
			idle: true
		});
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 2, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		const sent = updatesSent(platform);
		expect(sent).toHaveLength(1);
		expect(sent[0].ws).toBe(wsA);
		expect(sent[0].data).toEqual({ key: 'A', data: { x: 3, y: 0 } });
	});

	it('delivers an idle in-range entity to a subscriber that moved toward it, from the catalog (not this tick updates)', async () => {
		const { name } = declareShape({
			tickMs: 20,
			initial: (key) => ({ A: { x: 0, y: 0 }, X: { x: 1000, y: 0 } }[key] || { x: 0, y: 0 }),
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		const wsA = mockWs({ id: 'A' });
		const wsX = mockWs({ id: 'X' });
		const platform = wirePlatform();
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']); // A at 0
		await call(wsX, platform, name + '/shape/__smooth/sync', ['r1']); // X at 1000 (out of A's range)
		// This tick ONLY A moves (to 950, now 50 from X). X is idle - no update of its own.
		rt.queueDrain({
			updates: [{ key: 'A', state: { x: 950, y: 0 }, ws: wsA, commanded: false }],
			acks: [],
			idle: true
		});
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		// A must receive X's CURRENT state (from the catalog) - first-sight catch-up -
		// even though X produced no update this tick. The old (updates-only) cull dropped it.
		const toA = updatesSent(platform).filter((s) => s.ws === wsA);
		const xToA = toA.find((s) => s.data.key === 'X');
		expect(xToA).toBeDefined();
		expect(xToA.data.data).toEqual({ x: 1000, y: 0 });
	});

	it('leaves discrete events on the shared broadcast (unculled) even for an out-of-range entity', async () => {
		const { name } = declareInterest();
		const wsA = mockWs({ id: 'A' });
		const wsB = mockWs({ id: 'B' });
		const platform = wirePlatform();
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsB, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({
			updates: [],
			acks: [],
			events: [{ type: 'boom', key: 'B', data: { n: 1 }, id: 1, opts: null, ws: wsB, commanded: false }],
			idle: true
		});
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		const events = platform.wirePublished.filter((p) => p.event === 'event');
		expect(events).toHaveLength(1);
		expect(events[0].data).toEqual({ type: 'boom', key: 'B', data: { n: 1 }, id: 1 });
	});

	it('a topic without interest keeps the shared publishWire fan-out (byte-identical)', async () => {
		const { name } = declareShape({ tickMs: 20 }); // no interest
		const ws = mockWs({ id: 'A' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [{ key: 'A', state: { x: 1, y: 0 }, ws, commanded: false }],
			acks: [],
			idle: true
		});
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(1);
		expect(platform.wireSent.filter((s) => s.event === 'update')).toHaveLength(0);
	});

	it('a reported smooth-center overrides the own-entity center and recomputes on a still board', async () => {
		const { name } = declareInterest();
		const wsA = mockWs({ id: 'A' });
		const wsB = mockWs({ id: 'B' });
		const platform = wirePlatform();
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']); // A at 0
		await call(wsB, platform, name + '/shape/__smooth/sync', ['r1']); // B at 500 (out of A's own-entity AoI)
		// A reports a center at B's position. NOTHING moves this tick - the dirty
		// flag must still force a relevancy pass, and A is caught up to B from the
		// catalog (first-sight) despite no update.
		await call(wsA, platform, name + '/shape/__smooth/center', ['r1', { x: 500, y: 0 }]);
		await vi.advanceTimersByTimeAsync(20);
		const toAKeys = () => updatesSent(platform).filter((s) => s.ws === wsA).map((s) => s.data.key);
		expect(toAKeys()).toContain('B'); // A now sees B via the reported center
		const bToA = updatesSent(platform).filter((s) => s.ws === wsA && s.data.key === 'B')[0];
		expect(bToA.data.data).toEqual({ x: 500, y: 0 });

		// Clearing the center reverts A to its own-entity center; B leaves A's AoI.
		platform.wireSent.length = 0;
		await call(wsA, platform, name + '/shape/__smooth/center', ['r1', null]);
		await vi.advanceTimersByTimeAsync(20);
		expect(toAKeys()).not.toContain('B');
	});

	it('drops a departed subscriber from the registry and interest state on close', async () => {
		const { name } = declareInterest();
		const wsA = mockWs({ id: 'A' });
		const platform = wirePlatform();
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		const rec = _smoothTopics.get('shape:r1');
		expect(rec.registry.has('A')).toBe(true);
		close(wsA, { platform });
		await vi.advanceTimersByTimeAsync(1);
		// The record is reclaimed once its last entity leaves; if it survives (other
		// entities), the departed identity must at least be gone from the registry.
		const after = _smoothTopics.get('shape:r1');
		if (after) expect(after.registry.has('A')).toBe(false);
		else expect(after).toBeUndefined();
	});
});

describe('live.smooth lag-compensated shoot', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(10000);
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	// The default consequence: drop the victim's health authoritatively and signal
	// the hit, stopping after the first target (penetration off).
	const baseOnHit = (ctx, target) => {
		ctx.applyTo(target.key, { damage: 25 });
		ctx.emitEvent('hit', { victim: target.key, by: ctx.identity }, { key: target.key, toAuthor: true });
		return { stop: true };
	};

	function hitShape(onHit = baseOnHit, htExtra = {}) {
		return declareShape({
			tickMs: 20,
			interest: { radius: 1000, position: (s) => ({ x: s.x, y: s.y }) },
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: 2000 },
				onHit,
				...htExtra
			}
		});
	}

	// Arm a tick whose scripted drain positions `key` at `state`, so the tick
	// records that position into the lag-comp ring and recomputes interest
	// relevancy. Returns the wall time the tick fired at (the ring timestamp).
	async function moveTick(platform, ws, cmdPath, key, state) {
		await call(ws, platform, cmdPath, ['r1', [{ id: 1, cmd: { step: 1 } }]]);
		rt.queueDrain({ updates: [{ key, state, ws, commanded: true }], acks: [], idle: false });
		await vi.advanceTimersByTimeAsync(20);
		return Date.now();
	}

	function paths(name) {
		return {
			sync: name + '/shape/__smooth/sync',
			cmd: name + '/shape/__smooth/command',
			shoot: name + '/shape/__smooth/shoot'
		};
	}

	it('resolves a hit in the ray path: applies damage via the authority and broadcasts the hit', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });

		const drainsBefore = rt.calls.drains;
		const eventsBefore = platform.wirePublished.filter((w) => w.event === 'event').length;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);

		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
		const hitEvents = platform.wirePublished.filter((w) => w.event === 'event');
		expect(hitEvents).toHaveLength(eventsBefore + 1);
		expect(hitEvents[hitEvents.length - 1].data.type).toBe('hit');
		expect(hitEvents[hitEvents.length - 1].data.key).toBe('u2');
		expect(hitEvents[hitEvents.length - 1].data.data).toEqual({ victim: 'u2', by: 'u1' });
		// The hit armed a tick so the injected damage drains and broadcasts.
		await vi.advanceTimersByTimeAsync(20);
		expect(rt.calls.drains).toBeGreaterThan(drainsBefore);
	});

	it('misses an entity off the ray path (no damage, no hit event)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 500 }); // well off the y=0 ray

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([]);
		expect(platform.wirePublished.filter((w) => w.event === 'event')).toHaveLength(0);
	});

	it('cannot hit an entity outside the shooter candidate set (credo-5 default-deny)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// u2 sits ON the ray and within maxDist (2000), but BEYOND the interest radius
		// (1000). The candidate gate is evaluated at the rewind instant: dist(shooter, u2)
		// = 1500 > radius, so the membership gate (now geometric at rewindAt) drops it. The
		// shot misses for the transmit-bit reason - u2 was never replicated to u1 - just
		// enforced by the rewindAt distance test rather than ray geometry (the ray would hit).
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 1500, y: 0 });

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('rewinds to where the target was: a hit at render-time that would miss against the current position', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		const tHit = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 }); // on the ray
		const tMiss = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 300 }); // moved off it

		// Rewound to when the target was on the ray -> hit.
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tHit }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);

		// Same shot against the current (moved) position -> miss.
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tMiss }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('advertises lc:1 on a hitTest topic and omits it without one (byte-identical off)', async () => {
		const hit = hitShape();
		const plain = declareShape();
		const platform = wirePlatform();
		const onSync = await call(mockWs({ id: 'u1' }), platform, hit.name + '/shape/__smooth/sync', ['r1']);
		const offSync = await call(mockWs({ id: 'u9' }), platform, plain.name + '/shape/__smooth/sync', ['r2']);
		expect(onSync.data.lc).toBe(1);
		expect('lc' in offSync.data).toBe(false);
	});

	it('a shot on a topic without hitTest is inert', async () => {
		const { name } = declareShape();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		// The RPC exists for every smooth topic, but a topic with no ring no-ops it.
		await call(ws1, platform, name + '/shape/__smooth/shoot', ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('orders hits nearest-first and stops after the first when onHit returns stop', async () => {
		const order = [];
		const { name } = hitShape((ctx, target) => {
			order.push(target.key);
			ctx.applyTo(target.key, { damage: 25 });
			return { stop: true };
		});
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		const ws3 = mockWs({ id: 'u3' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await call(ws3, platform, p.sync, ['r1']);
		await moveTick(platform, ws3, p.cmd, 'u3', { x: 200, y: 0 }); // farther
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 }); // nearer

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		// Nearest first, and stop halts before the farther one.
		expect(order).toEqual(['u2']);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('penetrates every candidate on the ray when onHit does not stop', async () => {
		const order = [];
		const { name } = hitShape((ctx, target) => {
			order.push(target.key);
			ctx.applyTo(target.key, { damage: 10 });
			// no stop -> penetration
		});
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		const ws3 = mockWs({ id: 'u3' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await call(ws3, platform, p.sync, ['r1']);
		await moveTick(platform, ws3, p.cmd, 'u3', { x: 200, y: 0 });
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(order).toEqual(['u2', 'u3']); // nearest-first, both hit
		expect(rt.calls.inject).toEqual([
			{ key: 'u2', cmd: { damage: 10 } },
			{ key: 'u3', cmd: { damage: 10 } }
		]);
	});

	it('does not false-miss a target centred just past maxDist but struck on its near edge', async () => {
		// Center at 120 is beyond maxDist (100), but the circle's near edge at 90 is in
		// range, so the ray hits. A broadphase that culls by center distance alone would
		// wrongly drop it; the cull must allow one hitbox-reach past maxDist.
		const { name } = declareShape({
			tickMs: 20,
			interest: { radius: 5000, position: (s) => ({ x: s.x, y: s.y }) },
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: 100 },
				onHit: baseOnHit
			}
		});
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 120, y: 0 });

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('rejects a strictly-older renderTime (stale-lineup replay defense)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });

		const fireRt = Date.now();
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: fireRt }]);
		expect(rt.calls.inject).toHaveLength(1);
		// A captured shot resent with an OLDER render-time (re-resolving a stale enemy
		// lineup) is dropped - a real rendered instant only advances.
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: fireRt - 50 }]);
		expect(rt.calls.inject).toHaveLength(1);
	});

	it('admits a same-instant burst: pellets sharing one render-time all resolve', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });

		// A shotgun fires N pellets in one frame; every pellet carries the same
		// render-time. The replay guard must admit the equal stamp (only an OLDER one
		// is a replay), so all pellets resolve.
		const burstRt = Date.now();
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: burstRt }]);
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: burstRt }]);
		expect(rt.calls.inject).toHaveLength(2);
	});

	it('holds a low-latency shooter (fresh ackT) to its measured reach, not the full window', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// On the ray only in the oldest records; off it since.
		const tOnRay = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 300 });
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 300 });
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 300 });

		// A fresh ackT (echoing the latest server stamp) measures ~zero uplink, so the
		// reach is just the server-derived interp (~40ms at tickMs 20) - far short of
		// the ~84ms back where the target was on the ray. The renderTime is clamped to
		// the tight window edge (off-ray) -> MISS. The same renderTime with no ackT
		// (the prior test's full-window behaviour) would reach back and hit.
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tOnRay, ackT: Date.now() }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('clamps a hostile far-past renderTime to the window (fails safe to current state)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });

		// A renderTime a year in the past is clamped into the window; the rewind
		// resolves against the newest record (current position), still on the ray,
		// so the hit lands - never a crash, never a stale resolution.
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: 1 }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('does not drop honest shots as replays after a server wall backstep', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		const tHit = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 }); // on the ray
		// A first honest shot latches the replay floor at the pre-step render-time.
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tHit }]);
		expect(rt.calls.inject).toHaveLength(1);

		// The server wall clock steps BACK (NTP / live-migration) by less than the rewind
		// window. The monotonic ring axis is held, so the rewind survives; the replay floor
		// lives on that same axis, so the client's HONEST render-time - which re-syncs DOWN
		// to the stepped wall - is not mistaken for a stale-lineup replay. (On the raw axis
		// the stepped-down stamp would read as older than the latch and be dropped.)
		vi.setSystemTime(tHit - 50);
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tHit - 50 }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('rewound gate: hits a target that left the shooter area of interest mid-flight (honest miss fixed)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// u2 is on the ray and inside the shooter's interest (radius 1000) at the render
		// instant the shot is stamped with...
		const tOnRay = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		// ...then drifts far outside the interest before the shot arrives, so the
		// receipt-time membership no longer lists it. The pre-gate code (getCandidates at
		// receipt) would find an empty candidate set and silently miss; the rewound gate
		// recovers u2 via the broadphase and gates it in (in-range + on the ray at rewindAt).
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 1500, y: 0 });
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tOnRay }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('rewound gate: denies a target that entered the area of interest only after the shot (over-permissive hit fixed)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// At the render instant the shot is stamped with, u2 sits on the ray-line but
		// OUTSIDE the shooter's interest (radius 1000) - it was never replicated then...
		const tOutside = await moveTick(platform, ws2, p.cmd, 'u2', { x: 1500, y: 0 });
		// ...and only entered the interest afterward. A receipt-time gate would rewind the
		// now-in-range u2 to (1500,0), on the ray within maxDist, and wrongly hit. The
		// rewound gate denies it: it was outside the interest at the instant fired.
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tOutside }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('falls back to receipt-time membership when hitTest.position uses a different coordinate space than interest', async () => {
		// interest.position is in "feet"; a custom hitTest.position scales by 100 (a
		// different coordinate space). The geometric rewindAt gate compares ring positions
		// against the interest radius, so it is sound only when the ring records the
		// interest position. With a divergent hitTest.position it must NOT gate in the
		// mismatched space - doing so would test dist 50000 against radius 1000 and wrongly
		// drop a legitimately in-range target. It falls back to the receipt-time membership.
		const { name } = declareShape({
			tickMs: 20,
			interest: { radius: 1000, position: (s) => ({ x: s.x, y: s.y }) },
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x * 100, y: sh.y * 100 }), dir: (cmd) => cmd.aim, maxDist: 1e9 },
				position: (s) => ({ x: s.x * 100, y: s.y * 100 }),
				onHit: baseOnHit
			}
		});
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// u2 is well within the interest radius by feet (500 < 1000) and on the ray. Its
		// scaled hitTest position is (50000,0); a space-mixed gate against the feet radius
		// (1000) would drop it. The fallback keeps it - it is in the receipt-time membership.
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 500, y: 0 });
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});
});
