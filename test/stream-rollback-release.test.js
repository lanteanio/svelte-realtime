import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, WS_SUBSCRIPTIONS } from 'svelte-adapter-uws/testing';
import { live, realtime, handleRpc, LiveError, __register, _prepareHmr, _resetLifecycle } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what = 'expected socket outcome') {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

describe('failed stream admission releases adapter membership', () => {
	let server, socket, frames, serverSocket, gates;

	async function start(extraHooks = {}) {
		server = await createTestServer({ handler: { ...realtime(), ...extraHooks } });
		socket = new WebSocket(server.wsUrl);
		socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') frames.push(JSON.parse(data)); });
		await new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', reject, { once: true });
		});
	}
	const reply = id => frames.find(f => f.topic === '__rpc' && f.event === id && typeof f.data?.ok === 'boolean')?.data;
	const control = (type, ref) => frames.find(f => f.type === type && f.ref === ref);
	const delivered = topic => frames.filter(f => f.topic === topic).map(f => f.data);
	function stream(rpc, id, args) { socket.send(JSON.stringify({ rpc, id, args, stream: true, attach: true })); }
	function held(topic) { return serverSocket.getUserData()[WS_SUBSCRIPTIONS].has(topic); }

	beforeEach(() => { frames = []; gates = []; serverSocket = null; _resetLifecycle(); });
	afterEach(async () => {
		for (const gate of gates) gate.resolve();
		socket?.close();
		await server?.close();
		server = null; socket = null;
		_prepareHmr();
	});

	it('lets the same socket resubscribe after a loader throws and receive live frames', async () => {
		const topic = 'rollback:feed';
		__register('rollback/feed', live.public(live.stream(topic, async (ctx, fail) => {
			serverSocket = ctx.ws;
			if (fail) throw new Error('loader refused');
			return [];
		}, { merge: 'latest' })));
		await start();
		stream('rollback/feed', 'refused', [true]);
		await until(() => reply('refused')?.ok === false);
		expect(held(topic)).toBe(false);
		expect(server.platform.subscribers(topic)).toBe(0);

		stream('rollback/feed', 'retry', [false]);
		await until(() => reply('retry')?.ok === true);
		expect(held(topic)).toBe(true);
		server.platform.publish(topic, 'set', { id: 'delivered' });
		await until(() => delivered(topic).length > 0);
		expect(delivered(topic)).toEqual([{ id: 'delivered' }]);
	});

	it('keeps an admitted independent stream on the same topic subscribed when another one fails', async () => {
		const topic = 'rollback:shared';
		const gate = deferred(); gates.push(gate);
		let entered = false;
		__register('rollback/failing', live.public(live.stream(topic, async (ctx) => {
			serverSocket = ctx.ws;
			entered = true;
			await gate.promise;
			throw new Error('loader refused');
		}, { merge: 'latest' })));
		__register('rollback/healthy', live.public(live.stream(topic, async () => [], { merge: 'latest' })));
		await start();
		stream('rollback/failing', 'a', []);
		await until(() => entered, 'the failing loader');
		stream('rollback/healthy', 'b', []);
		await until(() => reply('b')?.ok === true);
		gate.resolve();
		await until(() => reply('a')?.ok === false);

		expect(held(topic)).toBe(true);
		expect(serverSocket.isSubscribed(topic)).toBe(true);
		server.platform.publish(topic, 'set', { id: 'survivor' });
		await until(() => delivered(topic).length > 0);
		expect(delivered(topic)).toEqual([{ id: 'survivor' }]);
	});

	it('leaves a stream still awaiting the subscribe hook free to complete after another one fails', async () => {
		const topic = 'rollback:pending';
		const hookGate = deferred(); gates.push(hookGate);
		let hookCalls = 0, hookParked = false;
		__register('rollback/failing', live.public(live.stream(topic, async (ctx) => {
			serverSocket = ctx.ws;
			throw new Error('loader refused');
		}, { merge: 'latest' })));
		__register('rollback/healthy', live.public(live.stream(topic, async () => [], { merge: 'latest' })));
		await start({
			async subscribe() {
				// The first admission parks in the hook; the second passes,
				// lands, and has its loader fail while the first still waits.
				if (++hookCalls === 1) { hookParked = true; await hookGate.promise; }
				return true;
			}
		});
		stream('rollback/healthy', 'b', []);
		await until(() => hookParked, 'the parked admission');
		stream('rollback/failing', 'a', []);
		await until(() => reply('a')?.ok === false);
		expect(held(topic)).toBe(false);
		hookGate.resolve();
		await until(() => reply('b') !== undefined);
		expect(reply('b')).toMatchObject({ ok: true });
		expect(held(topic)).toBe(true);
		server.platform.publish(topic, 'set', { id: 'after-hook' });
		await until(() => delivered(topic).length > 0);
		expect(delivered(topic)).toEqual([{ id: 'after-hook' }]);
	});

	it('leaves no grant behind for a raw subscribe after a guarded loader refuses', async () => {
		// A topic the client learns from an authorized call, a loader that
		// refuses once access is withdrawn, and raw wire subscribes probing
		// whether a refused admission left the topic granted.
		const topic = 'checkin:9f86d081884c7d65';
		let allowed = true;
		__register('scanner/checkins', live.public(live.stream(() => topic, async (ctx) => {
			serverSocket = ctx.ws;
			if (!allowed) throw new LiveError('FORBIDDEN', 'Access denied');
			return [];
		}, { merge: 'latest' })));
		await start();

		// 1. The authorized stream subscribe names the topic.
		stream('scanner/checkins', 'authorized', []);
		await until(() => reply('authorized')?.ok === true);
		expect(server.platform.subscribers(topic)).toBe(1);
		// 2. Access is withdrawn.
		allowed = false;
		// 3. Wire unsubscribe, then wait until nothing is subscribed.
		socket.send(JSON.stringify({ type: 'unsubscribe', topic }));
		await until(() => server.platform.subscribers(topic) === 0, 'the unsubscribe');
		// 4. A raw subscribe to the old topic is refused.
		socket.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
		await until(() => control('subscribe-denied', 1) || control('subscribed', 1));
		expect(control('subscribe-denied', 1)).toMatchObject({ reason: 'FORBIDDEN' });
		// 5. A fresh guarded stream subscribe is refused by its loader.
		stream('scanner/checkins', 'refused', []);
		await until(() => reply('refused') !== undefined);
		expect(reply('refused')).toMatchObject({ ok: false });
		// 6. A raw subscribe to the same topic is still refused.
		socket.send(JSON.stringify({ type: 'subscribe', topic, ref: 2 }));
		await until(() => control('subscribe-denied', 2) || control('subscribed', 2));
		expect(control('subscribed', 2)).toBeUndefined();
		expect(control('subscribe-denied', 2)).toMatchObject({ reason: 'FORBIDDEN' });
		expect(held(topic)).toBe(false);
		expect(server.platform.subscribers(topic)).toBe(0);
	});
});

describe('admission resumed after another stream released the membership', () => {
	afterEach(() => { _prepareHmr(); });

	it('admits again instead of tracking a subscription the socket no longer holds', async () => {
		_resetLifecycle();
		const topic = 'rollback:window';
		const failGate = deferred();
		__register('rollback/failing', live.public(live.stream(topic, async () => { await failGate.promise; throw new Error('loader refused'); })));
		__register('rollback/healthy', live.public(live.stream(topic, async () => [])));
		// Native membership is a set, not a count: one unsubscribe ends it.
		const ws = mockWs({ id: 'u1' });
		const native = new Set();
		ws.subscribe = (t) => { native.add(t); return true; };
		ws.unsubscribe = (t) => { native.delete(t); return true; };
		ws.isSubscribed = (t) => native.has(t);
		const platform = mockPlatform();
		const admit = platform.subscribe;
		let calls = 0;
		const failed = deferred();
		// The second admission lands its membership, then stays suspended until
		// the first stream's rollback has released it: the continuation of an
		// admission that resolved just before a sibling's rollback ran.
		platform.subscribe = async (sock, t) => {
			const denial = await admit.call(platform, sock, t);
			if (++calls === 2) { failGate.resolve(); await failed.promise; }
			return denial;
		};
		const origSend = platform.send;
		platform.send = function (sock, t, event, data) {
			if (t === '__rpc' && event === 'a' && data?.ok === false) failed.resolve();
			return origSend.apply(this, arguments);
		};
		handleRpc(ws, toArrayBuffer({ rpc: 'rollback/failing', id: 'a', args: [], stream: true }), platform);
		await until(() => calls === 1, 'the first admission');
		handleRpc(ws, toArrayBuffer({ rpc: 'rollback/healthy', id: 'b', args: [], stream: true }), platform);
		await until(() => platform.sent.some(r => r.topic === '__rpc' && r.event === 'b' && r.data?.ok !== undefined), 'the healthy reply');
		expect(platform.sent.find(r => r.event === 'b' && r.data?.ok !== undefined).data.ok).toBe(true);
		expect(ws.isSubscribed(topic)).toBe(true);
		expect(calls).toBe(3);
	});
});
