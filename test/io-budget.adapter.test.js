import { afterEach, expect, it } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { createReplay } from 'svelte-adapter-uws/plugins/replay';
import { connect } from 'svelte-adapter-uws/client';
import { get } from 'svelte/store';
import { live, realtime, __register, __registerDerived, _prepareHmr, _resetLifecycle } from '../src/server.js';
import { __stream, __rpc } from '../src/client.js';

// lowering a budget is welcome any time; RAISING one is a design decision that
// needs a recorded reason, not a number edit.
function assertScaleInvariant(name, small, large) {
	if (!(small > 0)) throw new Error(name + ': no measured work');
	if (large !== small) throw new Error(name + ': scaled from ' + small + ' to ' + large);
}

const sockets = [];
let server, connection;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
	const deadline = performance.now() + 5000;
	while (performance.now() < deadline) {
		const result = read();
		if (result) return result;
		await sleep(2);
	}
	throw new Error('Timed out waiting for ' + label);
}
async function cleanup() {
	connection?.close();
	connection = null;
	for (const peer of sockets.splice(0)) peer.socket.close();
	await server?.close();
	server = null;
	_prepareHmr();
}
afterEach(cleanup);

async function start() {
	await cleanup();
	_resetLifecycle();
	server = await createTestServer({ handler: realtime() });
}

async function openPeer() {
	const peer = { socket: new WebSocket(server.wsUrl), frames: [], raw: [], calls: 0 };
	sockets.push(peer);
	peer.socket.addEventListener('message', event => {
		const frame = JSON.parse(event.data);
		peer.raw.push(frame);
		peer.frames.push(...(frame.type === 'batch' ? frame.events : [frame]));
	});
	await until(() => peer.socket.readyState === WebSocket.OPEN, 'native socket');
	peer.socket.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
	return peer;
}
async function rpc(peer, path, args = [], stream = false, options = {}) {
	const id = 'call-' + peer.calls++;
	peer.socket.send(JSON.stringify({ rpc: path, id, args, stream, ...options }));
	const response = await until(() => peer.frames.find(frame => frame.topic === '__rpc' && frame.event === id), path);
	expect(response.data.ok).toBe(true);
	return response.data;
}

async function countBurst(subscribers, mutations, fault) {
	await start();
	const counts = { batches: 0, entries: 0, serializations: 0, publishes: 0 };
	const nativeBatch = server.platform.publishBatched;
	const nativePublish = server.platform.publish;
	server.platform.publishBatched = (entries, options) => {
		counts.entries += entries.length;
		if (fault === 'split-batch') {
			for (const entry of entries) { counts.batches++; nativeBatch([entry], options); }
			return;
		}
		counts.batches++;
		if (fault === 'per-recipient') {
			for (const ws of recipients) for (const entry of entries) server.platform.send(ws, entry.topic, entry.event, entry.data);
			return;
		}
		return nativeBatch(entries, options);
	};
	server.platform.publish = (...args) => { counts.publishes++; return nativePublish(...args); };
	const recipients = [];
	const subscribe = server.platform.subscribe;
	server.platform.subscribe = async (ws, ...args) => {
		const result = await subscribe(ws, ...args);
		if (!result && !recipients.includes(ws)) recipients.push(ws);
		return result;
	};
	__register('budget/feed', live.public(live.stream('budget:feed', () => 0, { merge: 'set' })));
	__register('budget/burst', live.public(live((ctx, count) => {
		for (let value = 1; value <= count; value++) {
			ctx.publish('budget:feed', 'set', { toJSON() { counts.serializations++; return { value }; } });
		}
		return count;
	})));
	const peers = [];
	for (let index = 0; index < subscribers; index++) {
		const peer = await openPeer();
		await rpc(peer, 'budget/feed', [], true);
		peers.push(peer);
	}
	await rpc(peers[0], 'budget/burst', [mutations]);
	await until(() => peers.every(peer => peer.frames.filter(frame => frame.topic === 'budget:feed').length === mutations), 'all mutations');
	for (const peer of peers) expect(peer.frames.filter(frame => frame.topic === 'budget:feed').map(frame => frame.data.value)).toEqual(Array.from({ length: mutations }, (_, index) => index + 1));
	return { ...counts, transportFrames: peers.reduce((sum, peer) => sum + peer.raw.filter(frame => frame.type === 'batch' || frame.topic === 'budget:feed').length, 0) };
}

it.each([1, 6])('measures a burst with %s subscribers', async subscribers => {
	const result = await countBurst(subscribers, 6);
	expect(result).toEqual({ batches: 1, entries: 6, serializations: 6, publishes: 0, transportFrames: subscribers });
});

it.each([1, 6])('one tick emits one native batch for %s mutations', async mutations => {
	expect(await countBurst(1, mutations)).toEqual({ batches: 1, entries: mutations, serializations: mutations, publishes: 0, transportFrames: 1 });
});

it('six times the subscribers do not multiply payload serialization', async () => {
	const small = await countBurst(1, 6);
	const large = await countBurst(6, 6);
	assertScaleInvariant('payload serialization', small.serializations, large.serializations);
	expect(large.serializations).toBe(6);
	// This work really is per recipient. The same detector must refuse it.
	expect(() => assertScaleInvariant('recipient delivery', small.transportFrames, large.transportFrames)).toThrow('scaled from 1 to 6');
});

it('detects lost batching while every native peer still receives every value', async () => {
	const result = await countBurst(1, 6, 'split-batch');
	expect(result.transportFrames).toBe(6);
	expect(() => assertScaleInvariant('batch calls', 1, result.batches)).toThrow('scaled from 1 to 6');
});

it('detects per-recipient serialization through actual native sends', async () => {
	const result = await countBurst(6, 1, 'per-recipient');
	expect(result.transportFrames).toBe(6);
	expect(() => assertScaleInvariant('payload serialization', 1, result.serializations)).toThrow('scaled from 1 to 6');
});

it('refuses an unexercised scaling fixture', () => {
	expect(() => assertScaleInvariant('payload serialization', 0, 0)).toThrow('no measured work');
});

async function countDerivations(subscribers) {
	await start();
	let source = 0, computes = 0;
	const derived = live.public(live.derived(['budget:source'], () => { computes++; return source * 2; }));
	__registerDerived('budget/double', derived);
	__register('budget/double', derived);
	__register('budget/change', live.public(live(ctx => { source++; ctx.publish('budget:source', 'set', source); return source; })));
	const peers = [];
	for (let index = 0; index < subscribers; index++) {
		const peer = await openPeer();
		await rpc(peer, 'budget/double', [], true);
		peers.push(peer);
	}
	computes = 0;
	for (let value = 1; value <= 6; value++) {
		await rpc(peers[0], 'budget/change');
		await until(() => peers.every(peer => peer.frames.some(frame => frame.topic === 'budget/double' && frame.data === value * 2)), 'derived value');
	}
	return computes;
}

it('derives once per source mutation regardless of subscriber count', async () => {
	const small = await countDerivations(1);
	const large = await countDerivations(6);
	expect(small).toBe(6);
	assertScaleInvariant('derived recomputation', small, large);
});

async function countNoopNotifications(versioned) {
	await start();
	const path = versioned ? 'budget/ordered' : 'budget/unordered';
	__register(path, live.public(live.stream('budget:rows', () => [{ id: 1, rev: 1, value: 7 }], {
		merge: 'crud', key: 'id', ...(versioned ? { rowVersion: 'rev' } : {})
	})));
	__register('budget/barrier', live.public(live(() => true)));
	connection = connect({ url: server.wsUrl });
	const stream = __stream(path, { merge: 'crud', key: 'id', ...(versioned ? { rowVersion: 'rev' } : {}) });
	let notifications = 0;
	const off = stream.subscribe(() => { notifications++; });
	try {
		await until(() => get(stream)?.length === 1, 'client snapshot');
		notifications = 0;
		for (let index = 0; index < 6; index++) server.platform.publish('budget:rows', 'updated', { id: 1, rev: 1, value: 7 }, { seq: false });
		// The answer arrives after all six updates on this same connection.
		await __rpc('budget/barrier')();
		expect(get(stream)).toEqual([{ id: 1, rev: 1, value: 7 }]);
		return notifications;
	} finally { off(); }
}

it('an unchanged versioned client row emits zero value notifications', async () => {
	expect(await countNoopNotifications(true)).toBe(0);
});

it('detects lost row deduplication with the real client and unchanged final data', async () => {
	const notifications = await countNoopNotifications(false);
	expect(notifications).toBe(6);
	expect(() => { if (notifications !== 0) throw new Error('no-op emitted ' + notifications); }).toThrow('no-op emitted 6');
});

it.each([false, true])('an unchanged server set prevents stale optimistic graduation (accepted=%s)', async accepted => {
	await start();
	const path = 'budget/optimistic-' + accepted;
	__register(path, live.public(live.stream('budget:optimistic', () => 0, { merge: 'set' })));
	let started = false, finish;
	const gate = new Promise(resolve => { finish = resolve; });
	__register('budget/persist', live.public(live(async () => {
		started = true;
		await gate;
		if (!accepted) throw new Error('Write refused');
		return true;
	})));
	__register('budget/barrier', live.public(live(() => true)));
	connection = connect({ url: server.wsUrl });
	const stream = __stream(path, { merge: 'set' });
	const off = stream.subscribe(() => {});
	let operation;
	try {
		await until(() => get(stream) === 0, 'optimistic baseline');
		operation = stream.mutate(() => __rpc('budget/persist')(), { event: 'set', data: 9 }).catch(() => false);
		await until(() => started, 'pending write');
		expect(get(stream)).toBe(9);
		server.platform.publish('budget:optimistic', 'set', 0, { seq: false });
		await __rpc('budget/barrier')();
		expect(get(stream)).toBe(9);
		finish();
		await operation;
		expect(get(stream)).toBe(0);
	} finally { finish(); await operation; off(); }
});

it.each([false, true])('a stale versioned CRUD row stays silent during an optimistic write (accepted=%s)', async accepted => {
	await start();
	const path = 'budget/pending-ordered-' + accepted;
	__register(path, live.public(live.stream('budget:pending-ordered', () => [{ id: 1, rev: 1, value: 7 }], {
		merge: 'crud', key: 'id', rowVersion: 'rev'
	})));
	let started = false, finish;
	const gate = new Promise(resolve => { finish = resolve; });
	__register('budget/persist-row', live.public(live(async () => {
		started = true;
		await gate;
		if (!accepted) throw new Error('Write refused');
		return true;
	})));
	__register('budget/barrier', live.public(live(() => true)));
	connection = connect({ url: server.wsUrl });
	const stream = __stream(path, { merge: 'crud', key: 'id', rowVersion: 'rev' });
	let notifications = 0;
	const off = stream.subscribe(() => { notifications++; });
	let operation;
	try {
		await until(() => get(stream)?.length === 1, 'versioned optimistic baseline');
		operation = stream.mutate(() => __rpc('budget/persist-row')(), {
			event: 'updated', data: { id: 1, rev: 2, value: 9 }
		}).catch(() => false);
		await until(() => started, 'pending versioned write');
		expect(get(stream)).toEqual([{ id: 1, rev: 2, value: 9 }]);
		notifications = 0;
		for (let index = 0; index < 6; index++) server.platform.publish('budget:pending-ordered', 'updated', { id: 1, rev: 1, value: -1 }, { seq: false });
		await __rpc('budget/barrier')();
		expect(get(stream)).toEqual([{ id: 1, rev: 2, value: 9 }]);
		expect(notifications).toBe(0);
		finish();
		expect(await operation).toBe(accepted);
		expect(get(stream)).toEqual([accepted ? { id: 1, rev: 2, value: 9 } : { id: 1, rev: 1, value: 7 }]);
	} finally { finish(); await operation; off(); }
});

it('native reconnect replays only mutations after the held cursor', async () => {
	await start();
	let loads = 0;
	__register('budget/resume', live.public(live.stream('budget:resume', () => { loads++; return 0; }, { merge: 'set', replay: true })));
	__register('budget/save', live.public(live((ctx, value) => { ctx.publish('budget:resume', 'set', value); return value; })));
	server.platform.replay = createReplay({ size: 20 });
	const peer = await openPeer();
	await rpc(peer, 'budget/resume', [], true);
	for (let value = 1; value <= 6; value++) await rpc(peer, 'budget/save', [value]);
	await until(() => peer.frames.filter(frame => frame.topic === 'budget:resume').length === 6, 'held mutations');
	const cursor = peer.frames.filter(frame => frame.topic === 'budget:resume').at(-1).seq;
	expect(cursor).toBe(6);
	peer.socket.close();
	await until(() => peer.socket.readyState === WebSocket.CLOSED, 'disconnect');
	const fresh = await openPeer();
	const held = await rpc(fresh, 'budget/resume', [], true, { seq: cursor });
	expect(held).toMatchObject({ replay: true, seq: 6, data: [] });
	const missed = await rpc(fresh, 'budget/resume', [], true, { seq: 3 });
	expect(missed.replay).toBe(true);
	expect(missed.data.map(entry => [entry.seq, entry.data])).toEqual([[4, 4], [5, 5], [6, 6]]);
	expect(loads).toBe(1);
});
