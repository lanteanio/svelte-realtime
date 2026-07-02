// The topic's wire views (`config.wire`): states pack at every client wire
// boundary (tick updates, acknowledgements, the sync roster), commands unpack
// at the RPC entry before anything downstream sees them, and a malformed
// packed command is dropped, never applied. Uses the scripted-runtime harness
// from smooth.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { _resetTenantResolver } from '../src/server/tenant.js';

const textEncoder = new TextEncoder();
const toArrayBuffer = (obj) => textEncoder.encode(JSON.stringify(obj)).buffer;

let _id = 0;

async function call(ws, platform, path, args) {
	const before = platform.sent.length;
	handleRpc(ws, toArrayBuffer({ rpc: path, id: 'c' + ++_id, args }), platform);
	await vi.advanceTimersByTimeAsync(1);
	return platform.sent[before]?.data;
}

function fakeRuntime() {
	const entities = new Map();
	const calls = { enqueue: [] };
	let drainQueue = [];
	const authority = {
		ensure(key, ws, initial) {
			let e = entities.get(key);
			if (e === undefined) {
				e = { state: initial, ws, lastAckedId: 0 };
				entities.set(key, e);
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
			return drainQueue.length > 0 ? drainQueue.shift() : { updates: [], acks: [], events: [], idle: true };
		},
		remove(key) {
			return entities.delete(key);
		},
		removeWs() {
			return [];
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

function wirePlatform() {
	const p = mockPlatform();
	p.wirePublished = [];
	p.wireSent = [];
	p.publishWire = (topic, event, data, codec, options) => {
		p.wirePublished.push({ topic, event, data, options });
		return true;
	};
	p.sendWire = (ws, topic, event, data) => {
		p.wireSent.push({ ws, topic, event, data });
		return 1;
	};
	return p;
}

// The app's wire views: a state {x,y} rides as [x,y]; a command {dx,dy}
// rides as [dx,dy]. Distinct shapes so a value that skipped its codec is
// unmistakable.
const stateWire = {
	pack: (s) => [s.x, s.y],
	unpack: (a) => ({ x: a[0], y: a[1] })
};
const commandWire = {
	pack: (c) => [c.dx || 0, c.dy || 0],
	unpack: (a) => {
		if (!Array.isArray(a) || a.length !== 2) throw new Error('bad command record');
		return { dx: a[0], dy: a[1] };
	}
};

function registerSmooth(moduleName, smoothExport) {
	__register(moduleName + '/shape/__smooth/sync', smoothExport.__smoothSync, moduleName);
	__register(moduleName + '/shape/__smooth/command', smoothExport.__smoothCommand, moduleName);
	__register(moduleName + '/shape/__smooth/center', smoothExport.__smoothCenter, moduleName);
	__register(moduleName + '/shape/__smooth/shoot', smoothExport.__smoothShoot, moduleName);
}

let moduleSeq = 0;

function declareShape(extra = {}) {
	const name = 'wv' + ++moduleSeq;
	const shape = live.smooth({
		topic: (ctx, roomId) => 'shape:' + roomId,
		topicArgs: 1,
		apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y + (cmd.dy || 0) }),
		initial: { x: 0, y: 0 },
		wire: { state: stateWire, command: commandWire },
		...extra
	});
	registerSmooth(name, shape);
	return { name, shape };
}

describe('live.smooth wire config validation', () => {
	const base = { topic: 't', apply: () => ({}), initial: {} };
	it('rejects a non-object wire', () => {
		expect(() => live.smooth({ ...base, wire: 5 })).toThrow('wire');
		expect(() => live.smooth({ ...base, wire: null })).toThrow('wire');
	});
	it('rejects a half codec pair', () => {
		expect(() => live.smooth({ ...base, wire: { state: { pack() {} } } })).toThrow('wire.state');
		expect(() => live.smooth({ ...base, wire: { command: { unpack() {} } } })).toThrow('wire.command');
	});
	it('accepts an empty wire object as off', () => {
		expect(() => live.smooth({ ...base, wire: {} })).not.toThrow();
	});
});

describe('live.smooth wire views', () => {
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

	it('returns the sync roster packed', async () => {
		const { name } = declareShape();
		const ws = mockWs({ id: 'u1' });
		const res = await call(ws, wirePlatform(), name + '/shape/__smooth/sync', ['r1']);
		expect(res.ok).toBe(true);
		expect(res.data.states).toEqual([{ key: 'u1', state: [0, 0] }]);
	});

	it('publishes tick updates and sends acks packed', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 5, y: 2 }, ws, commanded: true }],
			acks: [{ ws, id: 1, state: { x: 5, y: 2 } }],
			idle: true
		});
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: [5, 2] }]]);
		await vi.advanceTimersByTimeAsync(20);
		const update = platform.wirePublished.find((f) => f.event === 'update');
		expect(update.data).toEqual({ key: 'u1', data: [5, 2] });
		const ack = platform.wireSent.find((f) => f.event === 'ack');
		expect(ack.data.state).toEqual([5, 2]);
		expect(ack.data.id).toBe(1);
	});

	it('unpacks the command batch before the authority sees it', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		await call(ws, wirePlatform(), name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: [3, 4] }, { id: 2, cmd: [1, 0] }]]);
		expect(rt.calls.enqueue.length).toBe(1);
		expect(rt.calls.enqueue[0].batch).toEqual([
			{ id: 1, cmd: { dx: 3, dy: 4 } },
			{ id: 2, cmd: { dx: 1, dy: 0 } }
		]);
	});

	it('drops a malformed packed command and applies the rest', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		await call(ws, wirePlatform(), name + '/shape/__smooth/command', ['r1', [
			{ id: 1, cmd: 'garbage' },
			{ id: 2, cmd: [2, 2] },
			null,
			{ cmd: [9, 9] }
		]]);
		expect(rt.calls.enqueue.length).toBe(1);
		expect(rt.calls.enqueue[0].batch).toEqual([{ id: 2, cmd: { dx: 2, dy: 2 } }]);
	});

	it('drops an all-malformed batch without touching the authority', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const ws = mockWs({ id: 'u1' });
		await call(ws, wirePlatform(), name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: 'garbage' }]]);
		expect(rt.calls.enqueue.length).toBe(0);
	});

	it('leaves the wire byte-identical without a wire config', async () => {
		const name = 'wvoff' + ++moduleSeq;
		const shape = live.smooth({
			topic: (ctx, roomId) => 'shape:' + roomId,
			topicArgs: 1,
			apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y }),
			initial: { x: 0, y: 0 },
			tickMs: 20
		});
		registerSmooth(name, shape);
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		const res = await call(ws, platform, name + '/shape/__smooth/sync', ['r1']);
		expect(res.data.states).toEqual([{ key: 'u1', state: { x: 0, y: 0 } }]);
		rt.queueDrain({
			updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws, commanded: true }],
			acks: [{ ws, id: 1, state: { x: 1, y: 0 } }],
			idle: true
		});
		await call(ws, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		await vi.advanceTimersByTimeAsync(20);
		const update = platform.wirePublished.find((f) => f.event === 'update');
		expect(update.data).toEqual({ key: 'u1', data: { x: 1, y: 0 } });
		const ack = platform.wireSent.find((f) => f.event === 'ack');
		expect(ack.data.state).toEqual({ x: 1, y: 0 });
	});
});
