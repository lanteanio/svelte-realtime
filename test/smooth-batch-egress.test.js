// Batched update egress: on a platform that offers the batched wire fan-out
// (publishWireBatch / sendWireBatch), one tick's updates leave in ONE call -
// per-entry author exclusion riding along - while a single update, a platform
// without the batch surface, or a codec-less record keep the per-entity path
// byte-identical to before. The platform is scripted; what these tests pin is
// WHICH surface the tick hands the updates to and with what entries.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

const textEncoder = new TextEncoder();
const toArrayBuffer = (obj) => textEncoder.encode(JSON.stringify(obj)).buffer;
let _id = 0;

async function call(ws, platform, path, args) {
	handleRpc(ws, toArrayBuffer({ rpc: path, id: 'be' + ++_id, args }), platform);
	await vi.advanceTimersByTimeAsync(1);
}

/** Scripted smooth runtime: Map-backed authority + canned drain results. */
function scriptedRuntime() {
	const entities = new Map();
	let drainQueue = [];
	return {
		entities,
		queueDrain(result) { drainQueue.push(result); },
		mod: {
			SMOOTH_TOPIC_PREFIX: '__smooth:',
			createSmoothAuthority: () => ({
				ensure(key, ws, initial) {
					let e = entities.get(key);
					if (e === undefined) { e = { state: initial, ws, lastAckedId: 0 }; entities.set(key, e); }
					return { state: e.state, lastAckedId: e.lastAckedId };
				},
				get(key) { return entities.get(key); },
				enqueue() { return true; },
				inject(key) { return entities.has(key); },
				drain() {
					const r = drainQueue.length > 0 ? drainQueue.shift() : { updates: [], acks: [], events: [], idle: true };
					for (const u of (r.updates || [])) {
						const e = entities.get(u.key);
						if (e) e.state = u.state;
					}
					return r;
				},
				remove(key) { return entities.delete(key); },
				removeWs(ws) { const out = []; for (const [k, e] of entities) if (e.ws === ws) { entities.delete(k); out.push(k); } return out; },
				catalog() { return [...entities].map(([key, e]) => ({ key, state: e.state })); },
				get size() { return entities.size; }
			}),
			createSmoothWireCodec: () => ({
				capability: 'smooth.protocol:1',
				schemaVersion: 1,
				encode: () => null,
				state: { onAttach: () => null, onDetach: () => {} }
			})
		}
	};
}

/** A wire platform WITH the batched surfaces, all recorded. */
function batchWirePlatform() {
	const p = mockPlatform();
	p.wirePublished = [];
	p.wireSent = [];
	p.batchPublished = [];
	p.batchSent = [];
	p.publishWire = (topic, event, data, codec, options) => { p.wirePublished.push({ topic, event, data, options }); return true; };
	p.sendWire = (ws, topic, event, data) => { p.wireSent.push({ ws, topic, event, data }); return 1; };
	p.publishWireBatch = (topic, event, entries, codec, options) => { p.batchPublished.push({ topic, event, entries, options }); return true; };
	p.sendWireBatch = (ws, topic, event, entries) => { p.batchSent.push({ ws, topic, event, entries }); return 1; };
	return p;
}

/** A wire platform WITHOUT the batched surfaces (an older adapter). */
function legacyWirePlatform() {
	const p = mockPlatform();
	p.wirePublished = [];
	p.wireSent = [];
	p.publishWire = (topic, event, data, codec, options) => { p.wirePublished.push({ topic, event, data, options }); return true; };
	p.sendWire = (ws, topic, event, data) => { p.wireSent.push({ ws, topic, event, data }); return 1; };
	return p;
}

let moduleSeq = 0;

function declareShape(extra = {}) {
	const name = 'be' + ++moduleSeq;
	const shape = live.smooth({
		topic: (ctx, roomId) => 'shape:' + roomId,
		topicArgs: 1,
		apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y + (cmd.dy || 0) }),
		initial: { x: 0, y: 0 },
		...extra
	});
	__register(name + '/shape/__smooth/sync', shape.__smoothSync, name);
	__register(name + '/shape/__smooth/command', shape.__smoothCommand, name);
	__register(name + '/shape/__smooth/center', shape.__smoothCenter, name);
	__register(name + '/shape/__smooth/shoot', shape.__smoothShoot, name);
	return { name, shape };
}

describe('batched update egress (broadcast path)', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = scriptedRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('a multi-update tick leaves as ONE batched fan-out carrying per-entry author exclusion', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const owner = mockWs({ id: 'u1' });
		const drifter = mockWs({ id: 'u2' });
		const platform = batchWirePlatform();
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

		expect(platform.batchPublished).toHaveLength(1);
		const b = platform.batchPublished[0];
		expect(b.event).toBe('update');
		expect(b.entries.map((e) => e.data.key)).toEqual(['u1', 'u2']);
		expect(b.entries.map((e) => e.data.data)).toEqual([{ x: 5, y: 0 }, { x: 7, y: 0 }]);
		// The commanded author's entry excludes its socket (its ack carries the
		// state); onMissing motion excludes nobody - its owner must receive it.
		expect(b.entries[0].excludeWs).toBe(owner);
		expect(b.entries[1].excludeWs).toBeUndefined();
		// Nothing rode the per-entity update path.
		expect(platform.wirePublished.filter((w) => w.event === 'update')).toHaveLength(0);
	});

	it('a single-update tick keeps the per-entity path (no batch call for one frame)', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const owner = mockWs({ id: 'u1' });
		const platform = batchWirePlatform();
		rt.queueDrain({ updates: [{ key: 'u1', state: { x: 1, y: 0 }, ws: owner, commanded: true }], acks: [], idle: true });
		await call(owner, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		await vi.advanceTimersByTimeAsync(20);
		expect(platform.batchPublished).toHaveLength(0);
		const ups = platform.wirePublished.filter((w) => w.event === 'update');
		expect(ups).toHaveLength(1);
		expect(ups[0].data).toEqual({ key: 'u1', data: { x: 1, y: 0 } });
		expect(ups[0].options).toEqual({ excludeWs: owner });
	});

	it('an older platform without the batch surface takes the per-entity path unchanged', async () => {
		const { name } = declareShape({ tickMs: 20 });
		const owner = mockWs({ id: 'u1' });
		const drifter = mockWs({ id: 'u2' });
		const platform = legacyWirePlatform();
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
		const ups = platform.wirePublished.filter((w) => w.event === 'update');
		expect(ups).toHaveLength(2);
		expect(ups[0].options).toEqual({ excludeWs: owner });
		expect(ups[1].options).toBeUndefined();
	});
});

describe('batched update egress (culled per-subscriber path)', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = scriptedRuntime();
		_setSmoothRuntime(rt.mod);
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('each subscriber receives its culled set as ONE batched send', async () => {
		const { name } = declareShape({
			tickMs: 20,
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		const platform = batchWirePlatform();
		const w1 = mockWs({ id: 'u1' });
		const w2 = mockWs({ id: 'u2' });
		const w3 = mockWs({ id: 'u3' });
		await call(w1, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(w2, platform, name + '/shape/__smooth/sync', ['r1']);
		await call(w3, platform, name + '/shape/__smooth/sync', ['r1']);
		rt.queueDrain({
			updates: [
				{ key: 'u1', state: { x: 1, y: 0 }, ws: w1, commanded: true },
				{ key: 'u2', state: { x: 2, y: 0 }, ws: w2, commanded: false },
				{ key: 'u3', state: { x: 3, y: 0 }, ws: w3, commanded: false }
			],
			acks: [],
			idle: true
		});
		await call(w1, platform, name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 1 } }]]);
		await vi.advanceTimersByTimeAsync(20);

		// Every subscriber's culled set (everyone is within the 100 radius)
		// left as one batched send each; u1's own commanded update is
		// suppressed from u1 only.
		expect(platform.batchSent.length).toBeGreaterThanOrEqual(3);
		const byWs = new Map();
		for (const s of platform.batchSent) byWs.set(s.ws, s.entries.map((e) => e.data.key).sort());
		expect(byWs.get(w1)).toEqual(['u2', 'u3']);
		expect(byWs.get(w2)).toEqual(['u1', 'u2', 'u3']);
		expect(byWs.get(w3)).toEqual(['u1', 'u2', 'u3']);
		// No per-entity update sends slipped through for these subscribers.
		expect(platform.wireSent.filter((s) => s.event === 'update')).toHaveLength(0);
	});
});
