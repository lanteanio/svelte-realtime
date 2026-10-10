import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import * as smooth from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, close, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { _smoothTopics } from '../src/server/smooth.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
	const deadline = Date.now() + 4000;
	while (!check()) {
		if (Date.now() > deadline) throw Error('Timed out waiting for smooth socket result');
		await sleep(5);
	}
}
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
let server, clients, sockets, gates, sequence = 0;
const topic = 'rollback-room';
const wireTopic = smooth.SMOOTH_TOPIC_PREFIX + topic;
const pingPath = 'smooth-rollback/ping';
beforeEach(async () => {
	clients = []; sockets = []; gates = [];
	_setSmoothRuntime(smooth);
	__register(pingPath, live(() => true), 'smooth-rollback');
	server = await createTestServer({ handler: {
		open(ws) { sockets.push(ws); },
		message(ws, ctx) {
			if (!ctx.isBinary && ctx.msg === undefined) handleRpc(ws, ctx.data, server.platform);
		},
		close(ws, ctx) { close(ws, ctx); }
	} });
});
afterEach(async () => {
	for (const gate of gates) gate.resolve();
	await Promise.all(clients.map(client => new Promise((resolve, reject) => {
		if (client.ws.readyState === WebSocket.CLOSED) return resolve();
		const timer = setTimeout(() => reject(Error('Socket did not close')), 2000);
		client.ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
		client.ws.close();
	})));
	await server?.close();
	_resetSmooth(); _setSmoothRuntime(null);
});
function shape(initial, extra = {}) {
	const name = 'smooth-rollback-' + ++sequence;
	const value = live.smooth({ topic, tickMs: 10, initial, apply: (state, cmd) => ({ x: state.x + cmd.dx, y: 0 }), ...extra });
	__register(name + '/sync', value.__smoothSync, name);
	__register(name + '/command', value.__smoothCommand, name);
	return name;
}
async function connect() {
	const ws = new WebSocket(server.wsUrl);
	const json = [];
	ws.addEventListener('message', ({ data }) => { if (typeof data === 'string') json.push(JSON.parse(data)); });
	const client = { ws, json, native: null };
	clients.push(client);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	await until(() => sockets.length >= clients.length);
	client.native = sockets[clients.length - 1];
	return client;
}
async function rpc(client, path, args = []) {
	const id = 'rollback-' + ++sequence;
	client.ws.send(JSON.stringify({ rpc: path, id, args }));
	await until(() => client.json.some(frame => frame.topic === '__rpc' && frame.event === id));
	return client.json.find(frame => frame.topic === '__rpc' && frame.event === id).data;
}
const updates = client => client.json.filter(frame => frame.topic === wireTopic && frame.event === 'update');
function gateSubscribe(select) {
	const base = server.platform.subscribe.bind(server.platform);
	const gate = deferred(); gates.push(gate);
	let entered = 0;
	server.platform.subscribe = async (ws, name) => {
		const result = await base(ws, name);
		if (select(ws, name)) { entered++; await gate.promise; }
		return result;
	};
	return { ...gate, entered: () => entered };
}
async function move(name, author, peer, id) {
	await rpc(author, name + '/command', [[{ id, cmd: { dx: 2 } }]]);
	await until(() => updates(peer).some(frame => frame.data.data.x === id * 2));
}

describe('failed smooth sync against the installed adapter', () => {
	for (const asyncSubscribe of [false, true]) {
		it(`rolls back initial failure, excludes the refused peer, and permits retry (async subscribe: ${asyncSubscribe})`, async () => {
			let fail = true;
			const name = shape(() => { if (fail) throw Error('initial refused'); return { x: 0, y: 0 }; });
			const refused = await connect();
			let gate;
			if (asyncSubscribe) gate = gateSubscribe(ws => ws === refused.native);
			const pending = rpc(refused, name + '/sync');
			if (gate) { await until(() => gate.entered() === 1); gate.resolve(); }
			expect((await pending).ok).toBe(false);
			expect(refused.native.isSubscribed(wireTopic)).toBe(false);
			expect(_smoothTopics.has(topic)).toBe(false);
			fail = false;
			const author = await connect(), peer = await connect();
			expect((await rpc(author, name + '/sync')).ok).toBe(true);
			expect((await rpc(peer, name + '/sync')).ok).toBe(true);
			await move(name, author, peer, 1);
			await rpc(refused, pingPath); // An ordered wire barrier follows the publication.
			expect(updates(refused)).toEqual([]);
			expect((await rpc(refused, name + '/sync')).ok).toBe(true);
			await move(name, author, refused, 2);
		});
	}
	it('preserves an already accepted membership and entity when a resync initial throws', async () => {
		let fail = false;
		const name = shape(() => { if (fail) throw Error('resync refused'); return { x: 0, y: 0 }; });
		const accepted = await connect(), author = await connect();
		const first = await rpc(accepted, name + '/sync');
		await rpc(author, name + '/sync');
		const rec = _smoothTopics.get(topic), entity = rec.authority.get(first.data.you);
		fail = true;
		expect((await rpc(accepted, name + '/sync')).ok).toBe(false);
		expect(accepted.native.isSubscribed(wireTopic)).toBe(true);
		expect(rec.authority.get(first.data.you)).toBe(entity);
		await move(name, author, accepted, 1);
	});
	it('keeps the shared record while another socket is awaiting subscribe', async () => {
		let fail = true;
		const name = shape(() => { if (fail) throw Error('initial refused'); return { x: 0, y: 0 }; });
		const refused = await connect(), pendingPeer = await connect();
		const gate = gateSubscribe(ws => ws === pendingPeer.native);
		const pending = rpc(pendingPeer, name + '/sync');
		await until(() => gate.entered() === 1);
		const rec = _smoothTopics.get(topic);
		expect((await rpc(refused, name + '/sync')).ok).toBe(false);
		expect(_smoothTopics.get(topic)).toBe(rec);
		fail = false; gate.resolve();
		expect((await pending).ok).toBe(true);
		expect(_smoothTopics.get(topic)).toBe(rec);
		const author = await connect(); await rpc(author, name + '/sync');
		await move(name, author, pendingPeer, 1);
	});
	it('does not roll back a successful overlapping sync on the same socket', async () => {
		let initialCalls = 0;
		const name = shape(() => { if (++initialCalls === 2) throw Error('late initial refused'); return { x: 0, y: 0 }; });
		const peer = await connect();
		let subscribeCalls = 0;
		const gate = gateSubscribe(ws => ws === peer.native && ++subscribeCalls === 1);
		const first = rpc(peer, name + '/sync');
		await until(() => gate.entered() === 1);
		expect((await rpc(peer, name + '/sync')).ok).toBe(true);
		gate.resolve(); expect((await first).ok).toBe(false);
		expect(peer.native.isSubscribed(wireTopic)).toBe(true);
		const author = await connect(); await rpc(author, name + '/sync');
		await move(name, author, peer, 1);
	});
	it('releases an inert cluster owner and its registry after initial failure', async () => {
		const releaseOwner = vi.fn();
		server.platform.smooth = { acquireOwner: async () => true, releaseOwner };
		let fail = true;
		const name = shape(() => { if (fail) throw Error('cluster initial refused'); return { x: 0, y: 0 }; });
		const peer = await connect();
		expect((await rpc(peer, name + '/sync')).ok).toBe(false);
		expect(peer.native.isSubscribed(wireTopic)).toBe(false);
		expect(_smoothTopics.has(topic)).toBe(false);
		expect(releaseOwner).toHaveBeenCalledWith(wireTopic);
		fail = false;
		const retry = await rpc(peer, name + '/sync');
		expect(retry.ok).toBe(true);
		expect(_smoothTopics.get(topic).registry.get(retry.data.you)).toBe(peer.native);
	});
	it('preserves a live cluster member when another socket with the same identity fails initial', async () => {
		server.platform.smooth = { acquireOwner: async () => true, releaseOwner() {} };
		let fail = false;
		const name = shape(() => { if (fail) throw Error('replacement refused'); return { x: 0, y: 0 }; });
		const accepted = await connect(), refused = await connect();
		accepted.native.getUserData().id = 'shared-user'; refused.native.getUserData().id = 'shared-user';
		await rpc(accepted, name + '/sync');
		const rec = _smoothTopics.get(topic), entity = rec.authority.get('shared-user');
		fail = true;
		expect((await rpc(refused, name + '/sync')).ok).toBe(false);
		expect(refused.native.isSubscribed(wireTopic)).toBe(false);
		expect(rec.registry.get('shared-user')).toBe(accepted.native);
		expect(rec.authority.get('shared-user')).toBe(entity);
	});
	it('keeps a parked join in the same record when the last accepted socket closes', async () => {
		const name = shape({ x: 0, y: 0 });
		const accepted = await connect(), pendingPeer = await connect();
		await rpc(accepted, name + '/sync');
		const rec = _smoothTopics.get(topic);
		const gate = gateSubscribe(ws => ws === pendingPeer.native);
		const pending = rpc(pendingPeer, name + '/sync');
		await until(() => gate.entered() === 1);
		const closed = new Promise(resolve => accepted.ws.addEventListener('close', resolve, { once: true }));
		accepted.ws.close(); await closed;
		expect(_smoothTopics.get(topic)).toBe(rec);
		gate.resolve(); expect((await pending).ok).toBe(true);
		expect(_smoothTopics.get(topic)).toBe(rec);
		const author = await connect(); await rpc(author, name + '/sync');
		await move(name, author, pendingPeer, 1);
	});
	for (const sameIdentity of [false, true]) {
	it(`settles only the closing non-owner join (same identity: ${sameIdentity})`, async () => {
		let handlers;
		const requests = [], relayLeave = vi.fn();
		server.platform.smooth = {
			instanceId: 'edge', acquireOwner: async () => false, relayLeave,
			onMessage(value) { handlers = value; },
			requestSync(wire, identity, origin, corr) { requests.push({ wire, identity, corr }); }
		};
		const name = shape({ x: 0, y: 0 });
		const closing = await connect(), remaining = await connect();
		if (sameIdentity) { closing.native.getUserData().id = 'shared-pending'; remaining.native.getUserData().id = 'shared-pending'; }
		closing.ws.send(JSON.stringify({ rpc: name + '/sync', id: 'closing-sync', args: [] }));
		await until(() => requests.length === 1);
		const pending = rpc(remaining, name + '/sync');
		await until(() => requests.length === 2);
		const rec = _smoothTopics.get(topic);
		const closed = new Promise(resolve => closing.ws.addEventListener('close', resolve, { once: true }));
		closing.ws.close(); await closed;
		await until(() => rec.pendingSync.size === 1);
		expect(relayLeave).toHaveBeenCalledTimes(sameIdentity ? 0 : 1);
		expect(_smoothTopics.get(topic)).toBe(rec);
		expect(rec.pendingSync.size).toBe(1);
		const request = requests[1];
		handlers.onSyncReply(request.wire, request.corr, { ack: 0, states: [] });
		expect((await pending).ok).toBe(true);
		expect(rec.registry.get(request.identity)).toBe(remaining.native);
		if (!sameIdentity) expect(relayLeave.mock.calls[0][1]).toBe(requests[0].identity);
	});

	}
	for (const clustered of [false, true]) {
		it('rolls back throwing wire packing without taking an existing entity (clustered: ' + clustered + ')', async () => {
			if (clustered) server.platform.smooth = { acquireOwner: async () => true, releaseOwner() {} };
			let fail = true;
			const name = shape({ x: 0, y: 0 }, { tickMs: 60000, wire: { state: {
				pack(state) { if (fail) throw Error('packing refused'); return state; }, unpack: state => state
			} } });
			const accepted = await connect(); accepted.native.getUserData().id = 'shared-pack';
			expect((await rpc(accepted, name + '/sync')).ok).toBe(false);
			expect(accepted.native.isSubscribed(wireTopic)).toBe(false);
			expect(_smoothTopics.has(topic)).toBe(false);
			fail = false; expect((await rpc(accepted, name + '/sync')).ok).toBe(true);
			await rpc(accepted, name + '/command', [[{ id: 1, cmd: { dx: 2 } }]]);
			const rec = _smoothTopics.get(topic), entity = rec.authority.get('shared-pack');
			const queue = entity.queue.slice();
			fail = true;
			expect((await rpc(accepted, name + '/sync')).ok).toBe(false);
			expect(accepted.native.isSubscribed(wireTopic)).toBe(true);
			const refused = await connect(); refused.native.getUserData().id = 'shared-pack';
			expect((await rpc(refused, name + '/sync')).ok).toBe(false);
			expect(refused.native.isSubscribed(wireTopic)).toBe(false);
			expect(rec.authority.get('shared-pack')).toBe(entity);
			expect(entity.ws).toBe(accepted.native);
			expect(entity.queue).toEqual(queue);
			if (clustered) expect(rec.registry.get('shared-pack')).toBe(accepted.native);
		});
	}
	it('releases a rejected non-owner reply without dropping an accepted same-identity subscriber', async () => {
		let handlers, fail = true;
		const relayLeave = vi.fn();
		server.platform.smooth = {
			instanceId: 'edge', acquireOwner: async () => false, relayLeave,
			onMessage(value) { handlers = value; },
			requestSync(wire, identity, origin, corr) {
				queueMicrotask(() => handlers.onSyncReply(wire, corr, { ack: 0, states: [{ key: identity, state: { x: 0, y: 0 } }] }));
			}
		};
		const name = shape({ x: 0, y: 0 }, { wire: { state: {
			pack(state) { if (fail) throw Error('packing refused'); return state; }, unpack: state => state
		} } });
		const accepted = await connect(); accepted.native.getUserData().id = 'shared-pack';
		expect((await rpc(accepted, name + '/sync')).ok).toBe(false);
		expect(accepted.native.isSubscribed(wireTopic)).toBe(false);
		expect(_smoothTopics.has(topic)).toBe(false);
		expect(relayLeave).toHaveBeenCalledTimes(1);
		fail = false; expect((await rpc(accepted, name + '/sync')).ok).toBe(true);
		const rec = _smoothTopics.get(topic);
		fail = true;
		const refused = await connect(); refused.native.getUserData().id = 'shared-pack';
		expect((await rpc(refused, name + '/sync')).ok).toBe(false);
		expect(refused.native.isSubscribed(wireTopic)).toBe(false);
		expect(rec.registry.get('shared-pack')).toBe(accepted.native);
		expect(relayLeave).toHaveBeenCalledTimes(1);
	});

});
