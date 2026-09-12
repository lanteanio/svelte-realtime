// Regression for the join-window drop, driven through the REAL dispatch path.
//
// A stream subscribe registers the socket for fan-out (platform.subscribe)
// BEFORE its loader runs, and a batch answers only after every item's loader
// resolved. The client learns the wire topic from that response, so every frame
// the subscription delivers in between reaches a socket whose client has no
// store for the topic yet, and the adapter client drops such frames. For a
// presence room that window holds a peer's live 'join' published while this
// socket's roster snapshot was already read: the peer is in neither the
// snapshot nor the live stream, and nothing ever resends it. One side of a pair
// then stays permanently blind to the other.
//
// The server now names the wire topic in an early attach frame, sent BEFORE the
// socket is subscribed, so the client's listener exists for every frame the
// subscription can deliver. These tests park one joiner's loader on an app
// await, let a peer join into the open window, and assert the wire order.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';

const textEncoder = new TextEncoder();
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

function openConn(env, userData, wire) {
	const topics = new Set();
	const ws = {
		getUserData: () => userData,
		subscribe: (t) => { topics.add(t); return true; },
		unsubscribe: (t) => { topics.delete(t); return true; },
		isSubscribed: (t) => topics.has(t),
		getTopics: () => [...topics],
		_onSend: (topic, event, data) => { wire.push({ kind: 'send', to: userData.id, topic, event, data }); }
	};
	env.platform.connections++;
	return { ws, topics };
}

function joinBatch(base, roomId, attach) {
	const item = (rpc, id) => attach ? { rpc, id, args: [roomId], stream: true, attach: true } : { rpc, id, args: [roomId], stream: true };
	return [item(base + '/__data', 'd'), item(base + '/__presence', 'p')];
}

function sendBatch(conn, env, calls) {
	handleRpc(conn.ws, textEncoder.encode(JSON.stringify({ batch: calls })).buffer, env.platform);
}

function batchResponse(wire, userId) {
	const frame = wire.find((w) => w.kind === 'send' && w.to === userId && w.topic === '__rpc' && w.event === '__batch');
	const byId = {};
	if (frame) for (const r of frame.data.batch) byId[r.id] = r;
	return byId;
}

describe('presence join window (real dispatch, batched subscribe)', () => {
	let env, wire, aliceGate;

	beforeEach(() => {
		env = createTestEnv();
		wire = [];
		aliceGate = deferred();
		const origPublish = env.platform.publish;
		env.platform.publish = (topic, event, data, opts) => {
			wire.push({ kind: 'publish', topic, event, data });
			return origPublish(topic, event, data, opts);
		};
		env.register('board', {
			room: live.multiplayer({
				topic: (ctx, id) => 'board:' + id,
				topicArgs: 1,
				// The app await that opens the window: alice's data-join parks here
				// after her :presence sibling has already subscribed and read the
				// roster, while bob's join lands.
				init: (ctx) => (ctx.user.id === 'alice' ? aliceGate.promise : []),
				presence: (ctx) => ({ name: ctx.user.name })
			})
		});
	});

	afterEach(() => {
		aliceGate.resolve([]);
		env.cleanup();
	});

	let roomSeq = 0;

	async function runWindow(attach) {
		const roomId = 'r' + (++roomSeq) + (attach ? 'a' : 'n');
		const wireTopic = 'board:' + roomId + ':presence';
		const alice = openConn(env, { id: 'alice', name: 'Alice' }, wire);
		sendBatch(alice, env, joinBatch('board/room', roomId, attach));
		await settle();
		// Alice's :presence item is past its subscribe and its roster read; her
		// batch is parked on the data-join's init.
		expect(alice.topics.has(wireTopic)).toBe(true);
		expect(batchResponse(wire, 'alice').p).toBeUndefined();

		const bob = openConn(env, { id: 'bob', name: 'Bob' }, wire);
		sendBatch(bob, env, joinBatch('board/room', roomId, attach));
		await settle();
		const bobRes = batchResponse(wire, 'bob');
		expect(bobRes.p.data.map((e) => e.key).sort()).toEqual(['alice', 'bob']);

		aliceGate.resolve([]);
		await settle();
		return { alice, bob, wireTopic, aliceRes: batchResponse(wire, 'alice') };
	}

	it('the peer join is published into the open window and the snapshot lacks it (the drop this fix routes around)', async () => {
		const { aliceRes, wireTopic } = await runWindow(false);
		// Bob's join went out while alice was subscribed and before her batch
		// response left: exactly the frame a client without a store drops.
		const join = wire.findIndex((w) => w.kind === 'publish' && w.topic === wireTopic && w.event === 'join' && w.data.key === 'bob');
		const response = wire.findIndex((w) => w.kind === 'send' && w.to === 'alice' && w.event === '__batch');
		expect(join).toBeGreaterThan(-1);
		expect(response).toBeGreaterThan(join);
		expect(aliceRes.p.data.map((e) => e.key)).toEqual(['alice']);
		// Without the opt-in no attach frame is sent (an older client keeps its wire).
		expect(wire.some((w) => w.kind === 'send' && w.data && w.data.attach === true)).toBe(false);
	});

	it('with attach requested, the attach frame for :presence precedes the subscribe and every frame the subscription delivers', async () => {
		const { aliceRes, wireTopic } = await runWindow(true);
		const attach = wire.findIndex((w) => w.kind === 'send' && w.to === 'alice' && w.event === 'p' && w.data.attach === true && w.data.topic === wireTopic);
		const join = wire.findIndex((w) => w.kind === 'publish' && w.topic === wireTopic && w.event === 'join' && w.data.key === 'bob');
		const response = wire.findIndex((w) => w.kind === 'send' && w.to === 'alice' && w.event === '__batch');
		expect(attach).toBeGreaterThan(-1);
		expect(join).toBeGreaterThan(attach);
		expect(response).toBeGreaterThan(join);
		// The response itself is unchanged: the snapshot still carries what the
		// roster held when it was read; the buffered join fills the rest client-side.
		expect(aliceRes.p.ok).toBe(true);
		expect(aliceRes.p.data.map((e) => e.key)).toEqual(['alice']);
		// The attach frame names the topic and nothing else, and the pending
		// entry stays open for the real response.
		const frame = wire[attach].data;
		expect(Object.keys(frame).sort()).toEqual(['attach', 'topic']);
	});

	it('the attach frame is sent before the socket is subscribed, so no frame can precede it', async () => {
		const wireAtAttach = [];
		const alice = openConn(env, { id: 'alice', name: 'Alice' }, wire);
		const origSubscribe = alice.ws.subscribe;
		alice.ws.subscribe = (t) => {
			if (t === 'board:solo:presence') wireAtAttach.push(...wire.filter((w) => w.kind === 'send' && w.to === 'alice' && w.data && w.data.attach === true));
			return origSubscribe(t);
		};
		sendBatch(alice, env, joinBatch('board/room', 'solo', true));
		await settle();
		aliceGate.resolve([]);
		await settle();
		expect(wireAtAttach.map((w) => w.data.topic)).toContain('board:solo:presence');
	});

	it('a joiner the room guard denies gets no attach frame and no wire subscription, on the data stream and its sub-streams alike', async () => {
		env.register('locked', {
			room: live.multiplayer({
				topic: (ctx, id) => 'locked:' + id,
				topicArgs: 1,
				guard: (ctx) => { if (ctx.user.id !== 'alice') throw new Error('no'); },
				presence: (ctx) => ({ name: ctx.user.name })
			})
		});
		const mallory = openConn(env, { id: 'mallory', name: 'Mallory' }, wire);
		sendBatch(mallory, env, joinBatch('locked/room', 'x', true));
		await settle();
		const res = batchResponse(wire, 'mallory');
		expect(res.d.ok).toBe(false);
		expect(res.p.ok).toBe(false);
		// The guard runs before the subscribe on every stream of the room, so a
		// denied joiner is never subscribed (and rolled back), and is never told
		// the wire topic.
		expect(mallory.topics.size).toBe(0);
		expect(wire.some((w) => w.kind === 'send' && w.to === 'mallory' && w.data && w.data.attach === true)).toBe(false);
	});

	it('a subscribe the adapter denies after the attach frame returns the denial, and the socket is not subscribed', async () => {
		const origSubscribe = env.platform.subscribe;
		env.platform.subscribe = async (ws, topic) => {
			if (ws.getUserData().id === 'mallory') return 'FORBIDDEN';
			return origSubscribe(ws, topic);
		};
		const mallory = openConn(env, { id: 'mallory', name: 'Mallory' }, wire);
		sendBatch(mallory, env, joinBatch('board/room', 'hook', true));
		await settle();
		const res = batchResponse(wire, 'mallory');
		expect(res.d.ok).toBe(false);
		expect(res.d.code).toBe('FORBIDDEN');
		expect(res.p.ok).toBe(false);
		// The attach frame went out first (it precedes the subscribe by design);
		// the client's teardown on the rejected response is what undoes it.
		const attach = wire.findIndex((w) => w.kind === 'send' && w.to === 'mallory' && w.event === 'p' && w.data.attach === true);
		const response = wire.findIndex((w) => w.kind === 'send' && w.to === 'mallory' && w.event === '__batch');
		expect(attach).toBeGreaterThan(-1);
		expect(response).toBeGreaterThan(attach);
		expect(mallory.topics.size).toBe(0);
	});
});
