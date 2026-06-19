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
	const calls = { ensure: [], enqueue: [], drains: 0, removeWs: 0 };
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
		drain() {
			calls.drains++;
			return drainQueue.length > 0 ? drainQueue.shift() : { updates: [], acks: [], events: [], idle: true };
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
