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
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';
import svelteRealtime from '../src/vite.js';
// Internal record map, for asserting a topic record is reclaimed (same module
// instance server.js uses - ESM dedupes the import).
import { _smoothTopics, _resetSmoothFanoutWarning } from '../src/server/smooth.js';

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
	const calls = { ensure: [], enqueue: [], drains: 0, removeWs: 0, inject: [], set: [] };
	let drainQueue = [];
	const authority = {
		ensure(key, ws, initial, opts) {
			calls.ensure.push({ key, initial, ...(opts !== undefined && { opts }) });
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
		set(key, state) {
			// Mirror the real authority: replace + wake; unknown keys ignored.
			const e = entities.get(key);
			if (e === undefined) return false;
			calls.set.push({ key, state });
			e.state = state;
			return true;
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
	it('rejects a non-positive broadcastHz', () => {
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, broadcastHz: 0 })).toThrow('broadcastHz');
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, broadcastHz: -20 })).toThrow('broadcastHz');
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, broadcastHz: NaN })).toThrow('broadcastHz');
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, broadcastHz: '20' })).toThrow('broadcastHz');
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
		_resetTenantResolver();
		vi.useRealTimers();
	});

	it('isolates the smooth record and wire topic per tenant', async () => {
		_setTenantResolver((u) => u.org);
		const { name } = declareShape();
		const wsA = mockWs({ id: 'u1', org: 'a' });
		const wsB = mockWs({ id: 'u2', org: 'b' });
		await call(wsA, wirePlatform(), name + '/shape/__smooth/sync', ['r1']);
		await call(wsB, wirePlatform(), name + '/shape/__smooth/sync', ['r1']);
		// Same logical room id, two tenants -> two distinct records + wire topics; the
		// un-prefixed (shared) record never exists, so no cross-tenant entity/relay.
		expect(_smoothTopics.has('@t/a/shape:r1')).toBe(true);
		expect(_smoothTopics.has('@t/b/shape:r1')).toBe(true);
		expect(_smoothTopics.has('shape:r1')).toBe(false);
		expect(wsA.isSubscribed('__smooth:@t/a/shape:r1')).toBe(true);
		expect(wsB.isSubscribed('__smooth:@t/b/shape:r1')).toBe(true);
		expect(wsA.isSubscribed('__smooth:@t/b/shape:r1')).toBe(false);
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

	it('broadcastHz gates updates to every Nth tick, coalescing skipped motion into the current state', async () => {
		// tickMs 20 = 50 ticks/s; broadcastHz 25 = broadcast every 2nd tick.
		const { name } = declareShape({ tickMs: 20, broadcastHz: 25 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws, commanded: true }],
			acks: [{ key: 'u1', ws, id: 1, state: { x: 1, y: 0 } }],
			idle: false
		});
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 2, y: 0 }, ws, commanded: true }],
			acks: [{ key: 'u1', ws, id: 2, state: { x: 2, y: 0 } }],
			idle: false
		});
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 3, y: 0 }, ws, commanded: true }],
			acks: [{ key: 'u1', ws, id: 3, state: { x: 3, y: 0 } }],
			idle: true
		});
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);

		// Tick 1 (skipped): no update on the wire, but the acknowledgement still
		// went out - the owner's reconciliation never lags behind the gate.
		await vi.advanceTimersByTimeAsync(20);
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
		expect(platform.wireSent).toHaveLength(1);
		expect(platform.wireSent[0].data.id).toBe(1);

		// Tick 2 (send): ONE update carrying the CURRENT state - the skipped
		// tick's motion is coalesced, not replayed and not lost.
		await vi.advanceTimersByTimeAsync(20);
		let ups = platform.wirePublished.filter((p) => p.event === 'update');
		expect(ups).toHaveLength(1);
		expect(ups[0].data).toEqual({ key: 'u1', data: { x: 2, y: 0 } });
		expect(ups[0].options).toEqual({ excludeWs: ws });
		expect(platform.wireSent).toHaveLength(2);

		// Tick 3 (off-cadence but idle): motion stopped, so the final rest state
		// flushes immediately instead of waiting out the gate.
		await vi.advanceTimersByTimeAsync(20);
		ups = platform.wirePublished.filter((p) => p.event === 'update');
		expect(ups).toHaveLength(2);
		expect(ups[1].data).toEqual({ key: 'u1', data: { x: 3, y: 0 } });
		expect(platform.wireSent).toHaveLength(3);
	});

	it('a gated flush carries every mover of the window, each at its current state', async () => {
		const { name } = declareShape({ tickMs: 20, broadcastHz: 25 });
		const w1 = mockWs({ id: 'u1' });
		const w2 = mockWs({ id: 'u2' });
		const platform = wirePlatform();
		// u2 moves only on the skipped tick; u1 moves on both. The flush must
		// carry BOTH - u1 at its newest state, u2 at its last (still-current) one.
		rt.queueDrain({
			updates: [
				{ key: 'u1', state: { x: 1, y: 0 }, ws: w1, commanded: true },
				{ key: 'u2', state: { x: 10, y: 0 }, ws: w2, commanded: false }
			],
			acks: [],
			idle: false
		});
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 2, y: 0 }, ws: w1, commanded: true }],
			acks: [],
			idle: true
		});
		await call(w1, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		// u2 needs an entity for the flush to read its current state from.
		await call(w2, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 10 } }]]);

		await vi.advanceTimersByTimeAsync(20);
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(20);
		const ups = platform.wirePublished.filter((p) => p.event === 'update');
		expect(ups).toHaveLength(2);
		expect(ups[0].data).toEqual({ key: 'u1', data: { x: 2, y: 0 } });
		expect(ups[1].data).toEqual({ key: 'u2', data: { x: 10, y: 0 } });
	});

	it('the flush exclusion follows the LAST motion: trailing onMissing reaches the owner', async () => {
		const { name } = declareShape({ tickMs: 20, broadcastHz: 25 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		// Commanded on the skipped tick (acked), then onMissing on the send tick
		// (no ack): the owner's last ack does NOT carry the final state, so the
		// flushed update must NOT be owner-excluded.
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws, commanded: true }],
			acks: [{ key: 'u1', ws, id: 1, state: { x: 1, y: 0 } }],
			idle: false
		});
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 1, y: 5 }, ws, commanded: false }],
			acks: [],
			idle: true
		});
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		await vi.advanceTimersByTimeAsync(20);
		await vi.advanceTimersByTimeAsync(20);
		const ups = platform.wirePublished.filter((p) => p.event === 'update');
		expect(ups).toHaveLength(1);
		expect(ups[0].data).toEqual({ key: 'u1', data: { x: 1, y: 5 } });
		expect(ups[0].options).toBeUndefined();
	});

	it('a mover removed before the flush is skipped - its departure already broadcast', async () => {
		const { name } = declareShape({ tickMs: 20, broadcastHz: 25 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws, commanded: true }],
			acks: [],
			idle: false
		});
		rt.queueDrain({ updates: [], acks: [], idle: true });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		await vi.advanceTimersByTimeAsync(20); // skipped tick: u1 pends
		rt.entities.delete('u1'); // the entity departs before the send tick
		await vi.advanceTimersByTimeAsync(20); // idle flush: nothing to read, nothing sent
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
	});

	it('interest.budget bounds per-subscriber delivery, and a backpressured socket tightens it', async () => {
		const { name } = declareShape({
			tickMs: 20,
			initial: (key) => ({ A: { x: 0, y: 0 }, B: { x: 10, y: 0 }, C: { x: 20, y: 0 } }[key] || { x: 0, y: 0 }),
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }), budget: 2 }
		});
		const platform = wirePlatform();
		const wsA = mockWs({ id: 'A' });
		const wsB = mockWs({ id: 'B' });
		const wsC = mockWs({ id: 'C' });
		// B's socket is wedged past the transport's shed point: its ceiling floors to 1.
		wsB.getBufferedAmount = () => 2 * 1024 * 1024;
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsB, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsC, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({
			updates: [
				{ key: 'A', state: { x: 1, y: 0 }, ws: wsA, commanded: false },
				{ key: 'B', state: { x: 11, y: 0 }, ws: wsB, commanded: false },
				{ key: 'C', state: { x: 21, y: 0 }, ws: wsC, commanded: false }
			],
			acks: [],
			idle: true
		});
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		const sent = platform.wireSent.filter((s) => s.event === 'update');
		// A (healthy socket): the full budget of 2 - itself and its nearest neighbour.
		expect(sent.filter((s) => s.ws === wsA).map((s) => s.data.key).sort()).toEqual(['A', 'B']);
		// B (congested): floored to 1 - only the nearest entity flows.
		expect(sent.filter((s) => s.ws === wsB).map((s) => s.data.key)).toEqual(['B']);
		// C (healthy): the full budget of 2.
		expect(sent.filter((s) => s.ws === wsC).map((s) => s.data.key).sort()).toEqual(['B', 'C']);
	});

	it('discrete events stay per-tick under the gate', async () => {
		const { name } = declareShape({ tickMs: 20, broadcastHz: 25 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws, commanded: true }],
			acks: [],
			events: [{ type: 'shot', key: '1:0', data: {}, id: 1, opts: null, ws, commanded: true }],
			idle: false
		});
		rt.queueDrain({ updates: [], acks: [], idle: true });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		// The skipped tick withholds the update but fires the one-shot event NOW.
		await vi.advanceTimersByTimeAsync(20);
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
		expect(platform.wirePublished.filter((p) => p.event === 'event')).toHaveLength(1);
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

	it('falls back to plain publish/send on a platform without the wire methods, and warns once', async () => {
		_resetSmoothFanoutWarning();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
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
			// The wire-less platform trips the one-shot dev warning.
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toContain('publishWire');
		} finally {
			warn.mockRestore();
			_resetSmoothFanoutWarning();
		}
	});

	it('warns at most once, and never when the platform provides the wire methods', async () => {
		_resetSmoothFanoutWarning();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// A platform WITH publishWire/sendWire never warns.
			const { name: capable } = declareShape();
			await call(mockWs({ id: 'u1' }), wirePlatform(), capable + '/shape/__smooth/sync', ['r1']);
			expect(warn).not.toHaveBeenCalled();
			// A wire-less platform warns - but only once, however many topics register on it.
			const { name: a } = declareShape();
			const { name: b } = declareShape();
			await call(mockWs({ id: 'u2' }), mockPlatform(), a + '/shape/__smooth/sync', ['r1']);
			await call(mockWs({ id: 'u3' }), mockPlatform(), b + '/shape/__smooth/sync', ['r1']);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
			_resetSmoothFanoutWarning();
		}
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
		relayCommand: [], relayShoot: [], requestSync: [], sendSyncReply: [],
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
		relayShoot(...a) { calls.relayShoot.push(a); },
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
			leave: (...a) => handlers.onLeave(...a),
			shoot: (...a) => handlers.onShoot(...a)
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
		// Every update is still relayed cross-instance (the owner cannot cull per remote
		// subscriber); each receiving instance runs its own cull over its local
		// subscribers - see the non-owner receive-side cull tests below.
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

	it('non-owner culls a relayed update outside a local subscriber AoI and delivers one inside it', async () => {
		const { name } = declareShape({
			tickMs: 20,
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const sub = mockWs({ id: 'viewer' });
		fire(sub, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		// The owner answers with the catalog basis; this seeds the receive-side shadow,
		// including the subscriber's own entity (which resolves its area-of-interest center).
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], {
			ack: 0,
			states: [{ key: 'viewer', state: { x: 0, y: 0 } }]
		});
		await vi.advanceTimersByTimeAsync(1);
		// Two remote-owned entities move: one inside the viewer's AoI, one far outside.
		sc.emit.broadcast(WT, 'update', { key: 'near', data: { x: 40, y: 0 } }, undefined, 0, 'A');
		sc.emit.broadcast(WT, 'update', { key: 'far', data: { x: 500, y: 0 } }, undefined, 1, 'A');
		// Relayed updates are buffered into the shadow, not immediately broadcast.
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(20); // the receive-side cull tick fires
		const sent = platform.wireSent
			.filter((s) => s.event === 'update' && s.ws === sub)
			.map((s) => s.data.key);
		expect(sent).toEqual(['near']); // 'far' is culled; 'viewer' own entity is suppressed
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
	});

	it('non-owner delivers a stationary remote entity present only in the cold-join snapshot (never under-delivers)', async () => {
		const { name } = declareShape({
			tickMs: 20,
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const sub = mockWs({ id: 'viewer' });
		fire(sub, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		// 'stat' is in the snapshot, in range, and never broadcasts a move - without the
		// shadow seed the cull would have no state for it and drop it (an under-delivery).
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], {
			ack: 0,
			states: [
				{ key: 'viewer', state: { x: 0, y: 0 } },
				{ key: 'stat', state: { x: 60, y: 0 } }
			]
		});
		await vi.advanceTimersByTimeAsync(1);
		// A center report arms the cull tick with no entity having moved (a spectator
		// refreshing its view over a still board) - the stationary in-range entity must
		// still be delivered, from the shadow seed (first-sight catch-up).
		await call(sub, platform, name + '/shape/__smooth/center', ['r1', { x: 0, y: 0 }]);
		await vi.advanceTimersByTimeAsync(20);
		const sent = platform.wireSent
			.filter((s) => s.event === 'update' && s.ws === sub)
			.map((s) => s.data.key);
		expect(sent).toContain('stat');
	});

	it('interest off: a non-owner re-emits relayed updates immediately (no receive-side cull, byte-identical)', async () => {
		const { name } = declareShape(); // no interest
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const sub = mockWs({ id: 'viewer' });
		fire(sub, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.broadcast(WT, 'update', { key: 'a', data: { x: 1 } }, undefined, 0, 'A');
		// Immediate shared broadcast, no buffering, no per-socket cull walk.
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(1);
		expect(platform.wireSent.filter((s) => s.event === 'update')).toHaveLength(0);
	});

	it('becoming the owner discards the receive-side shadow and resumes immediate delivery', async () => {
		const { name } = declareShape({
			tickMs: 20,
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const sub = mockWs({ id: 'viewer' });
		fire(sub, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], {
			ack: 0,
			states: [{ key: 'viewer', state: { x: 0, y: 0 } }]
		});
		await vi.advanceTimersByTimeAsync(1);
		// While a non-owner, a relayed in-AoI update is buffered (culled), not published.
		sc.emit.broadcast(WT, 'update', { key: 'near', data: { x: 10, y: 0 } }, undefined, 0, 'A');
		expect(platform.wirePublished.filter((p) => p.event === 'update')).toHaveLength(0);
		// This instance now wins the lease; a fresh sync acquires ownership and discards
		// the shadow (the authoritative catalog supersedes it).
		sc.setOwner(true);
		await call(mockWs({ id: 'owner1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		// As the owner, a further relayed frame (a handoff-overlap straggler) is delivered
		// immediately, not buffered into a now-discarded shadow.
		sc.emit.broadcast(WT, 'update', { key: 'late', data: { x: 5, y: 0 } }, undefined, 5, 'A');
		expect(
			platform.wirePublished.filter((p) => p.event === 'update' && p.data.key === 'late')
		).toHaveLength(1);
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

	it('a fenced owner stands down: releases the lease and stops renewing', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		let fenced = false;
		platform.clockFence = { fenced: () => fenced };
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(40);
		expect(sc.calls.renewOwner.length).toBeGreaterThanOrEqual(1);
		const renewsBefore = sc.calls.renewOwner.length;

		// The fence trips: the next tick demotes through the failed-renew path
		// and proactively releases the lease so a healthy sibling claims
		// immediately instead of waiting out the TTL.
		fenced = true;
		await vi.advanceTimersByTimeAsync(40);
		expect(sc.calls.releaseOwner).toContain(WT);
		await vi.advanceTimersByTimeAsync(200);
		expect(sc.calls.renewOwner.length).toBe(renewsBefore);
	});

	it('an attached-but-healthy clock fence changes nothing', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		platform.clockFence = { fenced: () => false };
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(40);
		expect(sc.calls.renewOwner.length).toBeGreaterThanOrEqual(1);
		expect(sc.calls.releaseOwner).toHaveLength(0);
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

describe('live.smooth cross-node cells (cluster relay of cell topics)', () => {
	const WT = '__smooth:shape:r1';
	const CT = (cell) => '__smoothcell:shape:r1#' + cell;
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

	// radius 100 over a 256 grid: a block at the origin covers cells -1..0 on each
	// axis; an entity at x=600 sits in cell "2,0", outside that block.
	function declareCells() {
		return declareShape({
			tickMs: 20,
			interest: { cells: true, radius: 100, cell: 256, position: (s) => ({ x: s.x, y: s.y }) }
		});
	}

	/** Fire an RPC without awaiting the reply (for handlers that suspend on a relay). */
	function fire(ws, platform, path, args) {
		handleRpc(ws, toArrayBuffer({ rpc: path, id: 'x' + ++_id, args }), platform);
	}

	function clusterPlatform(sc) {
		const platform = wirePlatform();
		platform.smooth = sc.cluster;
		return platform;
	}

	/** Sync a non-owner subscriber and answer the owner request with `states`. */
	async function nonOwnerSync(sc, platform, name, ws, states) {
		const before = platform.sent.length;
		fire(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		const corr = sc.calls.requestSync[sc.calls.requestSync.length - 1][3];
		sc.emit.syncReply(WT, corr, { ack: 0, states });
		await vi.advanceTimersByTimeAsync(1);
		return platform.sent[before]?.data;
	}

	it('the owner relays cell updates and transition removes with the shared broadcast seq', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);

		rt.queueDrain({ updates: [{ key: 'u1', state: { x: 5, y: 0 }, ws, commanded: true }], acks: [], idle: false });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		rt.queueDrain({ updates: [{ key: 'u1', state: { x: 600, y: 0 }, ws, commanded: true }], acks: [], idle: true });
		await vi.advanceTimersByTimeAsync(20);

		const relayed = sc.calls.relayBroadcast.map((r) => [r[0], r[1], r[4]]);
		expect(relayed).toEqual([
			[CT('0,0'), 'update', 0],
			[CT('0,0'), 'remove', 1], // the transition tells the old cell to drop it...
			[CT('2,0'), 'update', 2] // ...and the new cell gets the state
		]);
		expect(sc.calls.relayBroadcast[2][2]).toMatchObject({ key: 'u1', data: { x: 600, y: 0 } });
	});

	it('a non-owner republishes an inbound cell frame to ITS local cell topic, never the base topic', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u2' });
		await nonOwnerSync(sc, platform, name, ws, [{ key: 'u2', state: { x: 0, y: 0 } }]);

		sc.emit.broadcast(CT('0,0'), 'update', { key: 'r9', data: { x: 5, y: 0 }, t: 1 }, undefined, 0, 'OWN');
		const cellPub = platform.published.filter((p) => p.topic === CT('0,0') && p.event === 'update');
		expect(cellPub).toHaveLength(1);
		expect(cellPub[0].data).toEqual({ key: 'r9', data: { x: 5, y: 0 }, t: 1 });
		// Not rebroadcast on the base wire topic, and never re-relayed (no loop).
		expect(platform.wirePublished.filter((p) => p.topic === WT)).toHaveLength(0);
		expect(sc.calls.relayBroadcast).toHaveLength(0);

		// A replayed / regressing seq is dropped by the per-owner watermark.
		sc.emit.broadcast(CT('0,0'), 'update', { key: 'r9', data: { x: 6, y: 0 }, t: 2 }, undefined, 0, 'OWN');
		expect(platform.published.filter((p) => p.topic === CT('0,0') && p.event === 'update')).toHaveLength(1);
	});

	it('an owner ignores an inbound cell frame (no republish of a stale relay)', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		const before = platform.published.length;
		sc.emit.broadcast(CT('0,0'), 'update', { key: 'r9', data: { x: 5, y: 0 }, t: 1 }, undefined, 0, 'OLD');
		expect(platform.published.length).toBe(before);
	});

	it('an owner cluster sync places the joiner cell block (it previously received nothing until first motion)', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: true });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		expect(ws.isSubscribed(CT('all'))).toBe(true);
		expect(ws.isSubscribed(CT('0,0'))).toBe(true);
		expect(ws.isSubscribed(CT('-1,-1'))).toBe(true); // the block covers radius on all sides
	});

	it('a non-owner sync places the block from the owner reply and scopes the client roster to it', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u2' });
		const reply = await nonOwnerSync(sc, platform, name, ws, [
			{ key: 'u2', state: { x: 0, y: 0 } },
			{ key: 'near', state: { x: 50, y: 0 } },
			{ key: 'far', state: { x: 5000, y: 0 } }
		]);
		// Placement from the reply's own entry (the local authority is empty here).
		expect(ws.isSubscribed(CT('all'))).toBe(true);
		expect(ws.isSubscribed(CT('0,0'))).toBe(true);
		// The owner's full catalog is scoped to the joiner's block before it goes out.
		expect(reply.data.states.map((s) => s.key).sort()).toEqual(['near', 'u2']);
		expect(reply.data.cells).toBe(1);
	});

	it('an ack re-places a non-owner subscriber own cell block (the follow has no local tick)', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u2' });
		await nonOwnerSync(sc, platform, name, ws, [{ key: 'u2', state: { x: 0, y: 0 } }]);
		expect(ws.isSubscribed(CT('0,0'))).toBe(true);

		sc.emit.ack(WT, 'u2', { id: 1, state: { x: 600, y: 0 }, t: Date.now() });
		expect(ws.isSubscribed(CT('2,0'))).toBe(true); // moved block
		expect(ws.isSubscribed(CT('-1,0'))).toBe(false); // left cell beyond the keep margin
	});

	it('a relayed cell update for a local identity follows it too (onMissing motion, no ack)', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u2' });
		await nonOwnerSync(sc, platform, name, ws, [{ key: 'u2', state: { x: 0, y: 0 } }]);

		sc.emit.broadcast(CT('0,0'), 'update', { key: 'u2', data: { x: 600, y: 0 }, t: 1 }, undefined, 0, 'OWN');
		expect(ws.isSubscribed(CT('2,0'))).toBe(true);
	});

	it('a reported center on a non-owner scopes the block; clearing re-places from the last-known position', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u2' });
		await nonOwnerSync(sc, platform, name, ws, [{ key: 'u2', state: { x: 0, y: 0 } }]);

		await call(ws, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(ws.isSubscribed(CT('39,39'))).toBe(true);
		expect(ws.isSubscribed(CT('0,0'))).toBe(false); // far outside the keep margin

		// Clearing reverts to the own entity - resolved from lastPos on a non-owner
		// (the local authority holds no entity here).
		await call(ws, platform, name + '/shape/__smooth/center', ['r1', null]);
		expect(ws.isSubscribed(CT('0,0'))).toBe(true);
	});

	it('the cluster close drain releases a departed subscriber cells bookkeeping', async () => {
		const { name } = declareCells();
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws2 = mockWs({ id: 'u2' });
		const ws3 = mockWs({ id: 'u3' });
		await nonOwnerSync(sc, platform, name, ws2, [{ key: 'u2', state: { x: 0, y: 0 } }]);
		await nonOwnerSync(sc, platform, name, ws3, [{ key: 'u3', state: { x: 0, y: 0 } }]);

		const rec = _smoothTopics.get('shape:r1');
		expect(rec.cells.subs.has('u2')).toBe(true);
		close(ws2, { platform });
		await vi.advanceTimersByTimeAsync(1);
		expect(rec.cells.subs.has('u2')).toBe(false);
		expect(rec.cells.lastPos.has('u2')).toBe(false);
		expect(rec.cells.subs.has('u3')).toBe(true); // the survivor keeps its block
	});
});

describe('live.smooth interest.centerPolicy (the center-report gate)', () => {
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

	// A positionless state models a spectator: it owns an entity (every synced
	// connection does) but resolves no position, so it cannot anchor a clamp.
	const posOf = { A: { x: 0, y: 0 }, B: { x: 500, y: 0 } };
	const specPosition = (s) => (s.free ? null : { x: s.x, y: s.y });
	const specInitial = (key) => (key === 'S' ? { free: true } : { ...(posOf[key] || { x: 0, y: 0 }) });

	function declarePolicy(centerPolicy) {
		return declareShape({
			tickMs: 20,
			initial: specInitial,
			interest: { radius: 100, position: specPosition, centerPolicy }
		});
	}

	function declareCellsPolicy(centerPolicy) {
		return declareShape({
			tickMs: 20,
			initial: specInitial,
			interest: { cells: true, radius: 100, cell: 256, position: specPosition, centerPolicy }
		});
	}

	const CT = (cell) => '__smoothcell:shape:r1#' + cell;

	it("preset 'own-entity': a positioned entity owner's report is ignored, a spectator's is honored", async () => {
		const { name } = declarePolicy('own-entity');
		const platform = wirePlatform();
		const wsA = mockWs({ id: 'A' });
		const wsB = mockWs({ id: 'B' });
		const wsS = mockWs({ id: 'S' });
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsB, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsS, platform, name + '/shape/__smooth/sync', ['r1']);
		// A owns a positioned entity at the origin: recentering on B is the radar
		// move and is rejected. S is a spectator: its free-cam report is honored.
		await call(wsA, platform, name + '/shape/__smooth/center', ['r1', { x: 500, y: 0 }]);
		await call(wsS, platform, name + '/shape/__smooth/center', ['r1', { x: 500, y: 0 }]);
		rt.queueDrain({
			updates: [
				{ key: 'B', state: { x: 501, y: 0 }, ws: wsB, commanded: false },
				{ key: 'A', state: { x: 1, y: 0 }, ws: wsA, commanded: false }
			],
			acks: [],
			idle: true
		});
		await call(wsB, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		const to = (ws) => platform.wireSent.filter((s) => s.event === 'update' && s.ws === ws).map((s) => s.data.key);
		expect(to(wsS)).toEqual(['B']); // recentered onto B's area, A's move culled
		// A stays centered on its own entity: B invisible. (S's always-visible
		// spectator entity is caught up to everyone on first sight.)
		expect(to(wsA).sort()).toEqual(['A', 'S']);
		expect(to(wsA)).not.toContain('B');
	});

	it("preset 'own-entity' in cells mode: a player's report cannot move its block, a spectator's can", async () => {
		const { name } = declareCellsPolicy('own-entity');
		const platform = wirePlatform();
		const wsA = mockWs({ id: 'A' });
		const wsS = mockWs({ id: 'S' });
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsS, platform, name + '/shape/__smooth/sync', ['r1']);

		await call(wsA, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(wsA.isSubscribed(CT('39,39'))).toBe(false); // rejected: block stays at the entity
		expect(wsA.isSubscribed(CT('0,0'))).toBe(true);

		await call(wsS, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(wsS.isSubscribed(CT('39,39'))).toBe(true); // spectator free-cam honored
	});

	it('callback: a point substitutes, false rejects and drops the stale override, a throw rejects', async () => {
		let behave = () => true;
		const seen = [];
		const { name } = declareCellsPolicy((ctx, center, ownPos) => {
			seen.push({ center, ownPos });
			return behave();
		});
		const platform = wirePlatform();
		const ws = mockWs({ id: 'A' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);

		// Substitute: the app clamps the far report to a nearer point.
		behave = () => ({ x: 2000, y: 0 });
		await call(ws, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(seen[0].center).toEqual({ x: 10000, y: 10000 });
		expect(seen[0].ownPos).toEqual({ x: 0, y: 0 });
		expect(ws.isSubscribed(CT('7,0'))).toBe(true); // placed at the substituted point
		expect(ws.isSubscribed(CT('39,39'))).toBe(false);

		// Reject: behaves like no report AND drops the previously-accepted override.
		behave = () => false;
		await call(ws, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(ws.isSubscribed(CT('0,0'))).toBe(true); // re-placed from the own entity
		expect(ws.isSubscribed(CT('7,0'))).toBe(false); // the substituted block is gone

		// A throwing policy rejects (fail safe) - the block does not move.
		behave = () => { throw new Error('boom'); };
		await call(ws, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(ws.isSubscribed(CT('39,39'))).toBe(false);
		// A garbage verdict rejects too.
		behave = () => 'yes';
		await call(ws, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(ws.isSubscribed(CT('39,39'))).toBe(false);
	});

	it("a pre-entity report cannot persist as radar once the connection owns an entity ('own-entity')", async () => {
		const { name } = declareCellsPolicy('own-entity');
		const platform = wirePlatform();
		const wsA = mockWs({ id: 'A' });
		const wsC = mockWs({ id: 'C' });
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']); // the record exists

		// C reports before ever syncing: it owns no entity anywhere, so the report
		// is accepted (it IS a spectator at this instant) and the block is placed.
		await call(wsC, platform, name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		expect(wsC.isSubscribed(CT('39,39'))).toBe(true);

		// Then it syncs and owns a positioned entity: the own entity now beats the
		// stored override at every consumption site - the block re-places at the
		// entity and the far subscription is gone. No report-time race to exploit.
		await call(wsC, platform, name + '/shape/__smooth/sync', ['r1']);
		expect(wsC.isSubscribed(CT('0,0'))).toBe(true);
		expect(wsC.isSubscribed(CT('39,39'))).toBe(false);
	});

	it('clearing a center (null report) is allowed under every policy and reverts cleanly', async () => {
		const { name } = declarePolicy('own-entity');
		const platform = wirePlatform();
		const wsA = mockWs({ id: 'A' });
		const wsS = mockWs({ id: 'S' });
		await call(wsA, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(wsS, platform, name + '/shape/__smooth/sync', ['r1']);
		// The spectator narrows its view to B's area, then clears: whole board again.
		await call(wsS, platform, name + '/shape/__smooth/center', ['r1', { x: 500, y: 0 }]);
		rt.queueDrain({ updates: [{ key: 'A', state: { x: 1, y: 0 }, ws: wsA, commanded: false }], acks: [], idle: true });
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		const toS = () => platform.wireSent.filter((s) => s.event === 'update' && s.ws === wsS).map((s) => s.data.key);
		expect(toS()).not.toContain('A'); // A's move is outside the reported area

		await call(wsS, platform, name + '/shape/__smooth/center', ['r1', null]);
		rt.queueDrain({ updates: [{ key: 'A', state: { x: 2, y: 0 }, ws: wsA, commanded: false }], acks: [], idle: true });
		await call(wsA, platform, name + '/shape/__smooth/command', ['r1', [{ id: 2, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
		expect(toS()).toContain('A'); // whole board restored (no resolvable center)
	});
});

describe('live.smooth onTick (the server world hook)', () => {
	let rt;
	// Behavior is swapped per test; the declared hook stays one stable function.
	let tickFn;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(10000);
		rt = fakeRuntime();
		_setSmoothRuntime(rt.mod);
		tickFn = null;
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	function declareWorld(extra = {}) {
		return declareShape({
			tickMs: 20,
			onTick: (world, t) => (tickFn ? tickFn(world, t) : undefined),
			...extra
		});
	}

	/** Arm one tick via a command and run it with the scripted drain result. */
	async function runTick(platform, ws, name, drain) {
		rt.queueDrain(drain || { updates: [], acks: [], events: [], idle: true });
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: ++_id, cmd: {} }]]);
		await vi.advanceTimersByTimeAsync(20);
	}

	it('rejects a non-function onTick at registration', () => {
		expect(() => live.smooth({ topic: 't', apply: () => ({}), initial: {}, onTick: 5 })).toThrow('onTick must be a function');
	});

	it('fails actionably on an adapter authority without the server-entity surface', async () => {
		const { name } = declareWorld();
		delete rt.mod.createSmoothAuthority().set; // simulate an old adapter (shared authority object)
		const platform = wirePlatform();
		const res = await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('requires svelte-adapter-uws');
	});

	it('world.topic names the resolved room, so one hook can key per-room state', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		let seen = null;
		tickFn = (world) => {
			seen = world.topic;
		};
		await runTick(platform, ws, name);
		expect(seen).toBe('shape:r1');
	});

	it('world.set broadcasts the replaced state in the same tick (owner included)', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(ws2, platform, name + '/shape/__smooth/sync', ['r1']);
		tickFn = (world) => {
			expect(world.get('u2')).toEqual({ x: 0, y: 0 }); // post-drain read
			world.set('u2', { x: 9, y: 9 });
		};
		await runTick(platform, ws1, name);
		const sent = platform.wirePublished.filter((p) => p.event === 'update' && p.data.key === 'u2');
		expect(sent).toHaveLength(1);
		expect(sent[0].data.data).toEqual({ x: 9, y: 9 });
		expect(sent[0].options).toBeUndefined(); // non-commanded: the owner receives it
		expect(rt.entities.get('u2').state).toEqual({ x: 9, y: 9 });
	});

	it('world.set on an entity that moved this tick yields ONE frame and an ack with the final state', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		tickFn = (world) => world.set('u1', { x: 50, y: 0 });
		await runTick(platform, ws1, name, {
			updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws: ws1, commanded: true }],
			acks: [{ key: 'u1', ws: ws1, id: 3, state: { x: 1, y: 0 } }],
			idle: true
		});
		const updates = platform.wirePublished.filter((p) => p.event === 'update' && p.data.key === 'u1');
		expect(updates).toHaveLength(1); // overwritten, not doubled
		expect(updates[0].data.data).toEqual({ x: 50, y: 0 });
		const acks = platform.wireSent.filter((s) => s.event === 'ack');
		expect(acks).toHaveLength(1);
		expect(acks[0].data.state).toEqual({ x: 50, y: 0 }); // the ack carries the FINAL state
	});

	it('world.ensure spawns an active server entity, broadcasts it, and is a read for existing keys', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		tickFn = (world) => {
			world.ensure('npc:1', { x: 5, y: 5 });
			world.ensure('npc:2'); // no initialState: seeds via the declared initial
		};
		await runTick(platform, ws1, name);
		await runTick(platform, ws1, name); // second tick re-ensures: must be a read
		const npcEnsures = rt.calls.ensure.filter((e) => e.key.startsWith('npc:'));
		expect(npcEnsures).toHaveLength(2); // one authority.ensure per key, ever
		expect(npcEnsures[0]).toMatchObject({ key: 'npc:1', initial: { x: 5, y: 5 }, opts: { active: true } });
		expect(npcEnsures[1]).toMatchObject({ key: 'npc:2', initial: { x: 0, y: 0 }, opts: { active: true } });
		const spawn = platform.wirePublished.find((p) => p.event === 'update' && p.data.key === 'npc:1');
		expect(spawn.data.data).toEqual({ x: 5, y: 5 });
	});

	it('world.applyTo injects through apply and arms the next tick', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		tickFn = (world) => {
			world.applyTo('u1', { damage: 5 });
			tickFn = null; // once
		};
		await runTick(platform, ws1, name);
		expect(rt.calls.inject).toEqual([{ key: 'u1', cmd: { damage: 5 } }]);
		const drains = rt.calls.drains;
		await vi.advanceTimersByTimeAsync(20); // the injection armed the next tick
		expect(rt.calls.drains).toBe(drains + 1);
	});

	it('world.remove drops the entity with a departure broadcast', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(ws2, platform, name + '/shape/__smooth/sync', ['r1']);
		tickFn = (world) => {
			world.remove('u2');
			tickFn = null;
		};
		await runTick(platform, ws1, name);
		expect(rt.entities.has('u2')).toBe(false);
		expect(platform.wirePublished.some((p) => p.event === 'remove' && p.data.key === 'u2')).toBe(true);
	});

	it('returning true from onTick sustains the tick with no motion (the heartbeat)', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		let beats = 0;
		tickFn = () => ++beats < 3; // request two more ticks, then rest
		await runTick(platform, ws1, name); // beat 1 (idle drain - without the heartbeat this would be the last)
		await vi.advanceTimersByTimeAsync(20); // beat 2
		await vi.advanceTimersByTimeAsync(20); // beat 3 returns false
		const drains = rt.calls.drains;
		await vi.advanceTimersByTimeAsync(40); // no re-arm: ticking stopped
		expect(beats).toBe(3);
		expect(rt.calls.drains).toBe(drains);
	});

	it('a throwing onTick never kills the tick (the drained updates still publish)', async () => {
		const { name } = declareWorld();
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		tickFn = () => {
			throw new Error('boom');
		};
		await runTick(platform, ws1, name, {
			updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws: ws1, commanded: false }],
			acks: [],
			idle: true
		});
		const sent = platform.wirePublished.filter((p) => p.event === 'update' && p.data.key === 'u1');
		expect(sent).toHaveLength(1);
	});

	it('a cluster non-owner never runs onTick (its tick is the receive-side cull)', async () => {
		let ran = 0;
		const { name } = declareShape({
			tickMs: 20,
			initial: () => ({ x: 0, y: 0 }),
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) },
			onTick: () => {
				ran++;
			}
		});
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = wirePlatform();
		platform.smooth = sc.cluster;
		const ws = mockWs({ id: 'u2' });
		handleRpc(ws, toArrayBuffer({ rpc: name + '/shape/__smooth/sync', id: 'w' + ++_id, args: ['r1'] }), platform);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply('__smooth:shape:r1', sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
		// An inbound relayed update arms the non-owner's cull tick - which must
		// return before the drain/hook site.
		sc.emit.broadcast('__smooth:shape:r1', 'update', { key: 'r9', data: { x: 5, y: 0 } }, undefined, 0, 'OWN');
		await vi.advanceTimersByTimeAsync(20);
		expect(ran).toBe(0);
	});

	it('composes with cells mode: a world.set routes to the entity cell topic', async () => {
		const { name } = declareShape({
			tickMs: 20,
			interest: { cells: true, radius: 100, cell: 256, position: (s) => ({ x: s.x, y: s.y }) },
			onTick: (world, t) => (tickFn ? tickFn(world, t) : undefined)
		});
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, name + '/shape/__smooth/sync', ['r1']);
		tickFn = (world) => {
			world.set('u1', { x: 600, y: 0 });
			tickFn = null;
		};
		await runTick(platform, ws1, name);
		const cellPub = platform.published.filter((p) => p.topic === '__smoothcell:shape:r1#2,0' && p.event === 'update');
		expect(cellPub).toHaveLength(1);
		expect(cellPub[0].data.data).toEqual({ x: 600, y: 0 });
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
	it('rejects a malformed budget', () => {
		const p = () => null;
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, budget: 0 } })).toThrow('interest.budget');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, budget: 1.5 } })).toThrow('interest.budget');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, budget: '50' } })).toThrow('interest.budget');
	});
	it('rejects budget combined with cells (no per-subscriber walk to bound)', () => {
		const p = () => null;
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, cells: true, budget: 50 } })).toThrow('cells mode');
	});
	it('validates centerPolicy: presets and a callback pass, anything else is rejected', () => {
		const p = () => null;
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, centerPolicy: 'nope' } })).toThrow('centerPolicy');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, centerPolicy: 5 } })).toThrow('centerPolicy');
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, centerPolicy: 'any' } })).not.toThrow();
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, centerPolicy: 'own-entity' } })).not.toThrow();
		expect(() => live.smooth({ ...base, interest: { radius: 100, position: p, centerPolicy: () => true } })).not.toThrow();
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
	it('accepts hitTest with cell-topic interest (the cell subscription is the candidate gate)', () => {
		expect(() => live.smooth({
			topic: 't', apply: () => ({}), initial: {},
			interest: { cells: true, radius: 500, position },
			hitTest: { shot, onHit, hitbox: { shape: 'circle', radius: 10 } }
		})).not.toThrow();
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

	it('scopes the join snapshot to the joiner area of interest (own entity + in-range + always-visible)', async () => {
		const { name } = declareShape({
			tickMs: 20,
			initial: (key) => (key === 'F' ? { flag: true } : { ...(posOf[key] || { x: 0, y: 0 }) }),
			interest: { radius: 100, position: (s) => (s.flag ? null : { x: s.x, y: s.y }) }
		});
		const platform = wirePlatform();
		await call(mockWs({ id: 'B' }), platform, name + '/shape/__smooth/sync', ['r1']); // far entity at (500,0)
		// F's own entity is always-visible (null position), so F resolves no center
		// and gets the whole board - the over-deliver polarity.
		const resF = await call(mockWs({ id: 'F' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(resF.data.states.map((s) => s.key).sort()).toEqual(['B', 'F']);
		// A joins at the origin: its roster carries itself (the reconciliation
		// basis), the always-visible F, and NOT the out-of-range B.
		const resA = await call(mockWs({ id: 'A' }), platform, name + '/shape/__smooth/sync', ['r1']);
		expect(resA.data.states.map((s) => s.key).sort()).toEqual(['A', 'F']);
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

	it('detectionHook (opt-in) emits the per-shot latency signal and a throwing hook never breaks the shot', async () => {
		const calls = [];
		const { name } = hitShape(baseOnHit, {
			detectionHook: (info) => {
				calls.push(info);
				throw new Error('boom'); // a throwing hook must not affect the shot (observability only)
			}
		});
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now(), ackT: Date.now() }]);
		expect(calls).toHaveLength(1);
		expect(calls[0].identity).toBe('u1');
		expect(typeof calls[0].reach).toBe('number');
		expect(typeof calls[0].divergence).toBe('number');
		expect(calls[0]).toHaveProperty('minUplink');
		expect(calls[0]).toHaveProperty('maxUplink');
		expect(calls[0]).toHaveProperty('interpDelay');
		// The shot still resolved despite the hook throwing.
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	// defenderAllowance (opt-in, off by default): a graded benefit-of-the-doubt for a
	// defender that broke line of sight to the shooter in flight. The app owns occlusion;
	// here exposure() reports "in the open" as |y| < 100. A target visible at the rewind
	// instant but occluded (behind cover) by the present is DROPPED, so the shot misses -
	// favoring the defender that reached cover.
	const exposeByY = (sh, t) => Math.abs(t.y) < 100;

	it('defenderAllowance: a target visible when shot but behind cover now is graced into a miss', async () => {
		const { name } = hitShape(baseOnHit, { defenderAllowance: { exposure: exposeByY, allowanceMs: 5000 } });
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// On the ray and in the open at the instant the shot is stamped with...
		const tThen = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		// ...then reaches cover (|y| >= 100) before the shot resolves.
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 600 });
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tThen }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('defenderAllowance off: the same geometry hits (proving the allowance is the cause)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		const tThen = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 600 });
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tThen }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('defenderAllowance: a target still in the open at the present is NOT graced - it is hit', async () => {
		const { name } = hitShape(baseOnHit, { defenderAllowance: { exposure: exposeByY, allowanceMs: 5000 } });
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		const tThen = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		// Still on the ray and in the open at the present - no cover reached, no grace.
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 200, y: 0 });
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tThen }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('defenderAllowance: a throwing exposure hook fails safe to no grace (the shot still resolves)', async () => {
		const { name } = hitShape(baseOnHit, { defenderAllowance: { exposure: () => { throw new Error('boom'); }, allowanceMs: 5000 } });
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		const tThen = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 });
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 600 });
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tThen }]);
		// Hook threw -> no grace granted -> resolves at the rewind instant (on-ray) -> hit.
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('defenderAllowance never turns a miss into a hit (off-ray when shot, on-ray behind cover at present)', async () => {
		// The defender is OFF the ray when the shot is stamped (a clean miss) but strafes
		// ONTO the ray while ducking behind near cover. exposure here is "visible iff y >= 30"
		// (cover is the near band y < 30, which straddles the aim line at y=0). A position-
		// relocating grace would re-sample u2 onto the ray and fabricate a kill; the strictly
		// -subtractive grace can only drop a candidate, so the clean miss stays a miss.
		const exposeFar = (sh, t) => t.y >= 30;
		const { name } = hitShape(baseOnHit, { defenderAllowance: { exposure: exposeFar, allowanceMs: 5000 } });
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		const tThen = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 50 }); // off-ray, visible
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 10 });               // on-ray, occluded
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tThen }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('defenderAllowance validation: rejects a bad shape, a non-function exposure, a non-positive allowanceMs', () => {
		const base = { topic: 't', apply: () => ({}), initial: { x: 0, y: 0 }, interest: { radius: 1000, position: (s) => ({ x: s.x, y: s.y }) } };
		const ht = { hitbox: { shape: 'circle', radius: 30 }, shot: { type: 'ray', origin: (c, s) => ({ x: s.x, y: s.y }), dir: (c) => c.aim, maxDist: 100 }, onHit: () => {} };
		expect(() => live.smooth({ ...base, hitTest: { ...ht, defenderAllowance: 'x' } })).toThrow('defenderAllowance');
		expect(() => live.smooth({ ...base, hitTest: { ...ht, defenderAllowance: { allowanceMs: 50 } } })).toThrow('exposure');
		expect(() => live.smooth({ ...base, hitTest: { ...ht, defenderAllowance: { exposure: () => true, allowanceMs: 0 } } })).toThrow('allowanceMs');
		expect(() => live.smooth({ ...base, hitTest: { ...ht, defenderAllowance: { exposure: () => true, allowanceMs: 50 } } })).not.toThrow();
	});

	it('a sparsely-served shooter gets the wider reach its render delay needs (LOD-aware interp)', async () => {
		// u1's only neighbour u2 sits in a throttled LOD band, so the server sends u1 a
		// frame only every ~5 ticks. u1's client therefore renders further in the past, and
		// the server - measuring its OWN send cadence - widens the reach to match. A far-back
		// shot that the flat 2*tickMs reach would clamp short (rewinding only into the recent
		// off-ray interval) now reaches the on-ray instant and lands.
		const { name } = declareShape({
			tickMs: 20,
			interest: {
				radius: 2000,
				position: (s) => ({ x: s.x, y: s.y }),
				lod: [{ within: 100, rate: 1 }, { within: 2000, rate: 5 }]
			},
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: 3000 },
				onHit: baseOnHit
			}
		});
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// u2 slides along the ray (y=0) in the throttled band for many ticks, so u1's measured
		// send cadence (every ~5 ticks) widens its estimated render delay well past 2*tick. It
		// stays on the ray through the whole rewind window older than ~60ms back.
		for (let i = 0; i < 36; i++) await moveTick(platform, ws2, p.cmd, 'u2', { x: 500 + i * 10, y: 0 });
		// Then u2 leaves the ray hard for the last ~60ms (3 ticks). A flat 2*tick reach (~40ms)
		// would rewind only into this off-ray interval and miss; the widened reach (~100ms,
		// capped by maxRewindMs) reaches back to where u2 was still on the ray and lands.
		for (let i = 0; i < 3; i++) await moveTick(platform, ws2, p.cmd, 'u2', { x: 860, y: 400 });
		// A far-back render-time clamps to now - reach, so the rewind lands at the reach edge:
		// ~100ms back (on the ray) for the wide cadence, not ~40ms back (off the ray) for a flat
		// estimate. The fresh ackT zeroes the uplink, so the reach is the interpolation leg alone.
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() - 1000, ackT: Date.now() }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('a sparse shooter that self-moves via onMissing is not mis-measured as dense (own frames excluded from cadence)', async () => {
		// Same throttled-LOD sparse shooter as above, but now u1's OWN entity also moves
		// every tick via onMissing (gravity/momentum - a non-commanded own update). The
		// client discards its own frame before its interpolation-delay estimator (it
		// predicts its own entity), so the server must too: if the own frame counted, u1's
		// cadence would read dense (every tick) and the reach would clamp the far-back shot
		// short. With own frames excluded, the cadence stays sparse and the shot lands.
		const { name } = declareShape({
			tickMs: 20,
			interest: {
				radius: 2000,
				position: (s) => ({ x: s.x, y: s.y }),
				lod: [{ within: 100, rate: 1 }, { within: 2000, rate: 5 }]
			},
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: 3000 },
				onHit: baseOnHit
			}
		});
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// Arm the tick and seed the rings (u2 on the ray, in the throttled far band).
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 500, y: 0 });
		// Each tick: u1 self-moves (own onMissing, commanded false) AND u2 slides on the ray.
		// u2 is delivered to u1 only every ~5 ticks (far band); u1's own frame every tick.
		for (let i = 1; i < 36; i++) {
			rt.queueDrain({ updates: [
				{ key: 'u1', state: { x: i, y: 0 }, ws: ws1, commanded: false },
				{ key: 'u2', state: { x: 500 + i * 10, y: 0 }, ws: ws2, commanded: true }
			], acks: [], idle: false });
			await vi.advanceTimersByTimeAsync(20);
		}
		// u2 leaves the ray for the last ~60ms (3 ticks); u1 keeps self-moving.
		for (let i = 0; i < 3; i++) {
			rt.queueDrain({ updates: [
				{ key: 'u1', state: { x: 36 + i, y: 0 }, ws: ws1, commanded: false },
				{ key: 'u2', state: { x: 860, y: 400 }, ws: ws2, commanded: true }
			], acks: [], idle: false });
			await vi.advanceTimersByTimeAsync(20);
		}
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() - 1000, ackT: Date.now() }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
	});

	it('resolves an identical hit stream when a recorded shot sequence is replayed (determinism)', async () => {
		// Replaying a fixed, latency-varying shot stream over a moving board under the same
		// seeded clock must reproduce every hit's target, distance, and rewind instant bit
		// for bit. The whole path - monotonic clock -> per-connection latency tracker ->
		// reach -> rewindAt -> rewound candidate gate -> narrowphase - reads time only
		// through the runtime seam (faked here), and orders candidates through ordered Maps,
		// so it is deterministic. A real-monotonic read or a Map-iteration-order dependence
		// would make the two passes diverge; the static determinism check cannot see either.
		async function pass() {
			_resetSmooth();
			rt = fakeRuntime();
			_setSmoothRuntime(rt.mod);
			vi.setSystemTime(50000);
			const log = [];
			const onHit = (ctx, target, info) => {
				// No stop -> penetration, so every target on the ray is captured in order:
				// the world Map and the nearest-first sort both feed this sequence.
				log.push({
					key: target.key,
					dist: info.dist,
					rewindAt: info.rewindAt,
					fraction: info.fraction,
					fallback: info.fallback,
					px: info.point.x,
					py: info.point.y
				});
				ctx.applyTo(target.key, { damage: 10 });
			};
			// LOD bands so the shooter is served at a throttled (sub-tick) cadence: the
			// send-cadence EWMA carries a non-seed value, so the reach/rewindAt it drives is
			// exercised and pinned by the two-pass equality rather than frozen at the seed.
			// (The slow-release branch is covered deterministically by the cadence unit tests.)
			const { name } = declareShape({
				tickMs: 20,
				interest: {
					radius: 1000,
					position: (s) => ({ x: s.x, y: s.y }),
					lod: [{ within: 50, rate: 1 }, { within: 1000, rate: 3 }]
				},
				hitTest: {
					hitbox: { shape: 'circle', radius: 30 },
					shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: 2000 },
					onHit
				}
			});
			const p = paths(name);
			const platform = wirePlatform();
			const ws1 = mockWs({ id: 'u1' });
			const ws2 = mockWs({ id: 'u2' });
			const ws3 = mockWs({ id: 'u3' });
			await call(ws1, platform, p.sync, ['r1']);
			await call(ws2, platform, p.sync, ['r1']);
			await call(ws3, platform, p.sync, ['r1']);
			// Two targets slide along the ray (y stays 0) over several ticks.
			const ts = [];
			ts.push(await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 }));
			ts.push(await moveTick(platform, ws3, p.cmd, 'u3', { x: 200, y: 0 }));
			ts.push(await moveTick(platform, ws2, p.cmd, 'u2', { x: 110, y: 0 }));
			ts.push(await moveTick(platform, ws3, p.cmd, 'u3', { x: 210, y: 0 }));
			ts.push(await moveTick(platform, ws2, p.cmd, 'u2', { x: 120, y: 0 }));
			// rt is non-decreasing (so the replay defense never drops a shot); ackT varies,
			// so the measured uplink and the resulting reach evolve shot to shot.
			const stream = [
				{ rt: ts[1], ackT: ts[1] },
				{ rt: ts[2], ackT: ts[0] },
				{ rt: ts[3], ackT: ts[1] },
				{ rt: ts[4], ackT: ts[4] }
			];
			for (let i = 0; i < stream.length; i++) {
				log.push({ shot: i });
				await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: stream[i].rt, ackT: stream[i].ackT }]);
			}
			return log;
		}

		const first = await pass();
		const second = await pass();
		expect(second).toEqual(first);
		// The stream must actually resolve hits (not a vacuous empty == empty assertion).
		expect(first.filter((e) => e.key !== undefined).length).toBeGreaterThan(3);
	});
});

describe('live.smooth lag-compensated shoot with cell-topic interest (cells mode)', () => {
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

	const baseOnHit = (ctx, target) => {
		ctx.applyTo(target.key, { damage: 25 });
		ctx.emitEvent('hit', { victim: target.key, by: ctx.identity }, { key: target.key, toAuthor: true });
		return { stop: true };
	};

	// radius 1000 over a 256-unit grid: a subscriber's block spans cells -4..3 on
	// each axis around the origin, so the geometry below can place targets inside
	// and outside the subscription precisely.
	function cellHitShape(onHit = baseOnHit, htExtra = {}) {
		return declareShape({
			tickMs: 20,
			interest: { cells: true, radius: 1000, cell: 256, position: (s) => ({ x: s.x, y: s.y }) },
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: 2000 },
				onHit,
				...htExtra
			}
		});
	}

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
			center: name + '/shape/__smooth/center',
			shoot: name + '/shape/__smooth/shoot'
		};
	}

	it('advertises both lc:1 and cells:1 on sync', async () => {
		const { name } = cellHitShape();
		const res = await call(mockWs({ id: 'u1' }), wirePlatform(), paths(name).sync, ['r1']);
		expect(res.data.lc).toBe(1);
		expect(res.data.cells).toBe(1);
	});

	it('resolves a hit on a target in a subscribed cell: damage via the authority and the hit event', async () => {
		const { name } = cellHitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 }); // cell "0,0", subscribed

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
		const hitEvents = platform.wirePublished.filter((w) => w.event === 'event');
		expect(hitEvents).toHaveLength(1);
		expect(hitEvents[0].data.type).toBe('hit');
		expect(hitEvents[0].data.data).toEqual({ victim: 'u2', by: 'u1' });
	});

	it('cannot hit a target beyond the subscribed block even when it is on the ray (default-deny)', async () => {
		const { name } = cellHitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// On the ray and within maxDist (2000), but in cell "5,0" - outside the
		// shooter's subscribed block (radius 1000 -> cells -4..3) and outside the
		// exact radius at the rewind instant. Never replicated, never hittable.
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 1500, y: 0 });

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([]);
		expect(platform.wirePublished.filter((w) => w.event === 'event')).toHaveLength(0);
	});

	it('gates on receipt-time cell membership alone when the ring space is custom (no rewound-shell fallback)', async () => {
		// A custom hitTest.position (a different function instance) makes the shoot
		// path skip the rewound geometric gate and fall back to pure receipt-time
		// membership - which in cells mode IS the cell subscription.
		const { name } = cellHitShape(baseOnHit, { position: (s) => ({ x: s.x, y: s.y }) });
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		const ws3 = mockWs({ id: 'u3' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		await call(ws3, platform, p.sync, ['r1']);
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 1500, y: 0 }); // unsubscribed cell "5,0"
		await moveTick(platform, ws3, p.cmd, 'u3', { x: 100, y: 0 }); // subscribed cell "0,0"

		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		// The subscribed target resolves; the unsubscribed one is not a candidate.
		expect(rt.calls.inject).toEqual([{ key: 'u3', cmd: { damage: 25 } }]);
	});

	it('rewinds against the ring in cells mode: a render-time hit that would miss the current position', async () => {
		const { name } = cellHitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		const tHit = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 0 }); // on the ray
		const tMiss = await moveTick(platform, ws2, p.cmd, 'u2', { x: 100, y: 300 }); // moved off it

		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tHit }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);

		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tMiss }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('recovers a target that left the shooter block mid-flight (the departed shell), and only then', async () => {
		const { name } = cellHitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		await call(ws1, platform, p.sync, ['r1']);
		await call(ws2, platform, p.sync, ['r1']);
		// In the block (cell "3,0") when the shooter rendered it...
		const tSeen = await moveTick(platform, ws2, p.cmd, 'u2', { x: 900, y: 0 });
		// ...then out of the block (cell "7,0", beyond the radius) while the shot flew.
		await moveTick(platform, ws2, p.cmd, 'u2', { x: 1800, y: 0 });

		// The receipt-time set no longer lists u2, but the broadphase shell around the
		// shooter's rewound position recovers it, and at tSeen it was in range: hit.
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: tSeen }]);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);

		// A present-time shot finds it beyond the exact radius at the rewind instant: miss.
		rt.calls.inject.length = 0;
		await call(ws1, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(rt.calls.inject).toEqual([]);
	});

	it('the cells join snapshot always includes the joiner own entity, even under a far reported center', async () => {
		const { name } = cellHitShape();
		const p = paths(name);
		const platform = wirePlatform();
		const ws1 = mockWs({ id: 'u1' });
		await call(ws1, platform, p.sync, ['r1']);
		// A free-cam center far from the entity scopes the roster to the watched
		// block - but the subscriber's own entity is its reconciliation basis and
		// must survive the scope.
		await call(ws1, platform, p.center, ['r1', { x: 10000, y: 10000 }]);
		const res = await call(ws1, platform, p.sync, ['r1']);
		expect(res.data.states.map((s) => s.key)).toContain('u1');
	});
});

describe('live.smooth forwarded shot (cluster relayShoot / onShoot)', () => {
	const WT = '__smooth:shape:r1';
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

	const baseOnHit = (ctx, target) => {
		ctx.applyTo(target.key, { damage: 25 });
		ctx.emitEvent('hit', { victim: target.key, by: ctx.identity }, { key: target.key });
		return { stop: true };
	};

	function hitShape(htExtra = {}) {
		return declareShape({
			tickMs: 20,
			interest: { radius: 1000, position: (s) => ({ x: s.x, y: s.y }) },
			hitTest: {
				hitbox: { shape: 'circle', radius: 30 },
				shot: { type: 'ray', origin: (cmd, sh) => ({ x: sh.x, y: sh.y }), dir: (cmd) => cmd.aim, maxDist: 2000 },
				onHit: baseOnHit,
				...htExtra
			}
		});
	}

	function paths(name) {
		return { sync: name + '/shape/__smooth/sync', cmd: name + '/shape/__smooth/command', shoot: name + '/shape/__smooth/shoot' };
	}

	function fire(ws, platform, path, args) {
		handleRpc(ws, toArrayBuffer({ rpc: path, id: 'k' + ++_id, args }), platform);
	}

	function clusterPlatform(sc) {
		const platform = wirePlatform();
		platform.smooth = sc.cluster;
		return platform;
	}

	// Bring the shooter onto a NON-owning edge: sync (forwarded to the owner),
	// the owner answers an empty basis, so the local rec exists, is not owned,
	// and has the shooter's socket registered.
	async function edgeSync(sc, platform, ws, p) {
		fire(ws, platform, p.sync, ['r1']);
		await vi.advanceTimersByTimeAsync(1);
		sc.emit.syncReply(WT, sc.calls.requestSync[0][3], { ack: 0, states: [] });
		await vi.advanceTimersByTimeAsync(1);
	}

	it('an edge with no owner-clock basis forwards at the present (rewindAge null) and never touches the authority', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await edgeSync(sc, platform, ws, p);
		await call(ws, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(sc.calls.relayShoot).toHaveLength(1);
		const [wireTopic, identity, originInstance, fwd] = sc.calls.relayShoot[0];
		expect([wireTopic, identity, originInstance]).toEqual([WT, 'u1', 'B']);
		expect(fwd.rewindAge).toBeNull(); // cold start -> resolve at present (favor defender)
		expect(fwd.reach).toBe(100); // the default maxRewindMs window width
		expect(fwd.cmd).toEqual({ aim: 0 });
		expect(rt.calls.inject).toEqual([]); // the edge never resolves locally
	});

	it('an edge with an owner-clock basis forwards bounded DURATIONS only - no absolute timestamp crosses the hop', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await edgeSync(sc, platform, ws, p);
		// Seed the owner-clock basis from an inbound ack carrying the owner's `t`.
		const ownerT = Date.now();
		sc.emit.ack(WT, 'u1', { id: 1, state: { x: 0, y: 0 }, t: ownerT });
		await vi.advanceTimersByTimeAsync(40); // real wall advances; the reconstructed owner-now tracks it
		const rtStamp = Date.now() - 30;
		await call(ws, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: rtStamp, ackT: ownerT }]);
		expect(sc.calls.relayShoot).toHaveLength(1);
		const fwd = sc.calls.relayShoot[0][3];
		// Only durations + the opaque cmd; the wire never carries rt / ackT / t.
		expect(Object.keys(fwd).sort()).toEqual(['cmd', 'reach', 'rewindAge']);
		// rewindAge is a duration on the reconstructed owner axis: edgeOwnerNow - rt.
		// edgeOwnerNow = ownerT + 40 (the wall elapsed since the ack); rt = now - 30 = ownerT + 10.
		expect(fwd.rewindAge).toBe(30);
		expect(typeof fwd.reach).toBe('number');
		expect(fwd.reach).toBeGreaterThan(0);
	});

	it('an edge drops a replayed (older) render-time before it forwards', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await edgeSync(sc, platform, ws, p);
		sc.emit.ack(WT, 'u1', { id: 1, state: { x: 0, y: 0 }, t: Date.now() });
		await vi.advanceTimersByTimeAsync(40);
		const fresh = Date.now() - 10;
		await call(ws, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: fresh, ackT: Date.now() - 50 }]);
		// A captured shot resent with an OLDER render-time: dropped at the edge, never forwarded.
		await call(ws, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: fresh - 25, ackT: Date.now() - 50 }]);
		expect(sc.calls.relayShoot).toHaveLength(1);
	});

	it('the owner resolves a forwarded shot against its own ring and relays the hit back', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const sc = scriptedSmoothCluster({ owner: true, instanceId: 'A' });
		const platform = clusterPlatform(sc);
		// A local owner sync wires the relay handlers and records a target into the ring.
		const ws2 = mockWs({ id: 'u2' });
		await call(ws2, platform, p.sync, ['r1']);
		// A remote shooter `rs` (connected to instance B) gets a surrogate entity here.
		sc.emit.sync(WT, 'rs', 'B', 'c1');
		await call(ws2, platform, p.cmd, ['r1', [{ id: 1, cmd: { step: 1 } }]]);
		rt.queueDrain({ updates: [{ key: 'u2', state: { x: 100, y: 0 }, ws: ws2, commanded: true }], acks: [], idle: false });
		await vi.advanceTimersByTimeAsync(20);
		const eventsBefore = sc.calls.relayBroadcast.filter((a) => a[1] === 'event').length;
		// rs at (0,0) aims +x along the ray; rewindAge 0 resolves at the present.
		sc.emit.shoot(WT, 'rs', 'B', { cmd: { aim: 0 }, reach: 100, rewindAge: 0 });
		await vi.advanceTimersByTimeAsync(1);
		expect(rt.calls.inject).toEqual([{ key: 'u2', cmd: { damage: 25 } }]);
		const relayedEvents = sc.calls.relayBroadcast.filter((a) => a[1] === 'event');
		expect(relayedEvents.length).toBe(eventsBefore + 1);
		expect(relayedEvents[relayedEvents.length - 1][2].type).toBe('hit');
	});

	it('a forwarded shot cannot spoof the shooter identity in the detection hook', async () => {
		const seen = [];
		const { name } = hitShape({ detectionHook: (info) => seen.push(info.identity) });
		const p = paths(name);
		const sc = scriptedSmoothCluster({ owner: true, instanceId: 'A' });
		const platform = clusterPlatform(sc);
		await call(mockWs({ id: 'u2' }), platform, p.sync, ['r1']); // wires the relay handlers
		sc.emit.sync(WT, 'rs', 'B', 'c1'); // the surrogate entity for the remote shooter
		// A forged payload claims a DIFFERENT identity inside the detect block.
		sc.emit.shoot(WT, 'rs', 'B', { cmd: { aim: 0 }, reach: 100, rewindAge: 0, detect: { identity: 'attacker', minUplink: 5, maxUplink: 5, divergence: 0 } });
		await vi.advanceTimersByTimeAsync(1);
		expect(seen).toEqual(['rs']); // the authoritative identity wins, never the forged one
	});

	it('the owner drops a forwarded shot from a shooter with no entity here (favor defender)', async () => {
		const { name } = hitShape();
		const sc = scriptedSmoothCluster({ owner: true, instanceId: 'A' });
		const platform = clusterPlatform(sc);
		// Wire the relay handlers (a local owner sync registers them).
		await call(mockWs({ id: 'u1' }), platform, name + '/shape/__smooth/sync', ['r1']);
		sc.emit.shoot(WT, 'ghost', 'B', { cmd: { aim: 0 }, reach: 100, rewindAge: 0 });
		await vi.advanceTimersByTimeAsync(1);
		expect(rt.calls.inject).toEqual([]);
	});

	it('a non-owner whose coordinator predates relayShoot leaves the shot inert (no throw)', async () => {
		const { name } = hitShape();
		const p = paths(name);
		const sc = scriptedSmoothCluster({ owner: false, instanceId: 'B' });
		delete sc.cluster.relayShoot; // an older extensions build
		const platform = clusterPlatform(sc);
		const ws = mockWs({ id: 'u1' });
		await edgeSync(sc, platform, ws, p);
		await call(ws, platform, p.shoot, ['r1', { cmd: { aim: 0 }, rt: Date.now() }]);
		expect(sc.calls.relayShoot).toHaveLength(0);
		expect(rt.calls.inject).toEqual([]);
	});
});
