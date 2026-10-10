// A stream released before the server answered its subscribe still ends with
// the socket unsubscribed. Driven end to end: the real client stream store
// (stream.js, connection.js) talks through a stand-in adapter client to the
// real server dispatch (handleRpc) and the real unsubscribe hook, with every
// frame held in flight until the test delivers it, so a release can be placed
// before, between or after the subscribe's attach frame and answer. The
// server handles one delivered frame at a time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { live, LiveError, unsubscribe as serverUnsubscribe, _presenceRefForTest } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';

const textEncoder = new TextEncoder();
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

let env;
let __stream;
let clientState;
let pending;
let deny;
let ws;

/**
 * Wire state of the one connection: frames each side sent that the other has
 * not received yet, plus the adapter's own send queue for frames handed to
 * sendQueued() while the socket is down. A fresh object per test: a previous
 * test's client modules keep running timers, and they must not reach this
 * test's wire.
 * @type {{ toServer: any[], toClient: any[], adapterQueue: any[], status: string, statusSubs: Set<Function>, clientTopics: Map<string, Set<Function>>, serverTopics: Set<string>, published: any[], connects: number }}
 */
let net;

function setStatus(s) {
	net.status = s;
	for (const fn of [...net.statusSubs]) fn(s);
	// The adapter flushes its send queue after it reports the socket open.
	if (s === 'open') net.toServer.push(...net.adapterQueue.splice(0));
}

beforeEach(async () => {
	vi.resetModules();
	const n = net = {
		toServer: [],
		toClient: [],
		adapterQueue: [],
		status: 'open',
		statusSubs: new Set(),
		clientTopics: new Map(),
		serverTopics: new Set(),
		published: [],
		connects: 0
	};
	const isUp = () => n.status === 'open' || n.status === 'suspended';
	const conn = {
		send: (frame) => { if (isUp()) n.toServer.push(frame); },
		sendQueued: (frame) => { if (isUp()) n.toServer.push(frame); else n.adapterQueue.push(frame); },
		get bufferedAmount() { return 0; }
	};
	const adapterMock = {
		connect: () => { n.connects++; return conn; },
		setTopicManaged: () => {},
		on: (topic) => ({
			subscribe: (fn) => {
				let fns = n.clientTopics.get(topic);
				if (!fns) { fns = new Set(); n.clientTopics.set(topic, fns); }
				fns.add(fn);
				return () => { fns.delete(fn); if (fns.size === 0) { n.clientTopics.delete(topic); if (isUp() && !topic.startsWith('__')) n.toServer.push({ type: 'unsubscribe', topic }); } };
			}
		}),
		onDerived: () => ({ subscribe: () => () => {} }),
		status: { subscribe: (fn) => { n.statusSubs.add(fn); fn(n.status); return () => n.statusSubs.delete(fn); } },
		failure: { subscribe: (fn) => { fn(null); return () => {}; } },
		denials: { subscribe: (fn) => { fn(null); return () => {}; } },
		onRequest: () => () => {}
	};
	// Like the adapter's, the connection object carries the module's topic
	// factory, stores and request hook.
	Object.assign(conn, {
		on: adapterMock.on,
		status: adapterMock.status,
		failure: adapterMock.failure,
		denials: adapterMock.denials,
		onRequest: adapterMock.onRequest
	});
	vi.doMock('svelte-adapter-uws/client', () => adapterMock);
	__stream = (await import('../src/client.js')).__stream;
	({ clientState, pending } = await import('../src/client/internal-state.js'));
	deny = false;

	env = createTestEnv();
	const origPublish = env.platform.publish;
	env.platform.publish = (topic, event, data, opts) => {
		n.published.push({ topic, event, data });
		return origPublish(topic, event, data, opts);
	};
	env.register('collab', {
		board: live.room({
			topic: (ctx, id) => 'board:' + id,
			topicArgs: 1,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user.name })
		})
	});
	env.register('locked', {
		board: live.room({
			topic: (ctx, id) => 'locked:' + id,
			topicArgs: 1,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user.name }),
			guard: () => { if (deny) throw new LiveError('FORBIDDEN', 'Access denied'); }
		})
	});
	ws = {
		getUserData: () => ({ id: 'alice', name: 'Alice' }),
		subscribe: (t) => { n.serverTopics.add(t); return true; },
		unsubscribe: (t) => { n.serverTopics.delete(t); return true; },
		isSubscribed: (t) => n.serverTopics.has(t),
		getTopics: () => [...n.serverTopics],
		_onSend: (topic, event, data) => { n.toClient.push({ topic, event, data }); }
	};
	env.platform.connections++;
});

afterEach(() => {
	vi.useRealTimers();
	env.cleanup();
});

/** Wait, a macrotask turn at a time, until `predicate` holds. */
async function until(predicate) {
	for (let i = 0; i < 10_000; i++) {
		if (predicate()) return;
		await new Promise((r) => setImmediate(r));
	}
	throw new Error('the server never replied');
}

const replyTo = (id, attach) => net.toClient.some((f) => f.topic === '__rpc' && (
	f.event === '__batch'
		? !attach && f.data.batch.some((r) => r.id === id)
		: f.event === id && (f.data && f.data.attach === true) === attach
));

/**
 * Hand the server the next `n` frames, each after it is done with the one
 * before: answered it, or with `upTo: 'attach'`, named its topic, or with
 * `upTo: 'none'`, not waiting at all.
 */
async function deliverToServer(n = Infinity, upTo = 'answer') {
	for (let i = 0; i < n && net.toServer.length > 0; i++) {
		const frame = net.toServer.shift();
		if (frame && frame.type === 'unsubscribe') {
			// What the adapter does with a client unsubscribe frame: drop the
			// socket's subscription, then run the app's unsubscribe hook.
			ws.unsubscribe(frame.topic);
			serverUnsubscribe(ws, frame.topic, { platform: env.platform });
			await ticks();
		} else {
			handleRpc(ws, textEncoder.encode(JSON.stringify(frame)).buffer, env.platform);
			const ids = Array.isArray(frame.batch) ? frame.batch.map((r) => r.id) : [frame.id];
			if (upTo === 'none') await ticks();
			else await until(() => ids.every((id) => replyTo(id, upTo === 'attach')));
		}
	}
}

/** Hand the client everything the server sent so far, in order. */
async function deliverToClient(filter = () => true) {
	const keep = [];
	for (const frame of net.toClient.splice(0)) {
		if (!filter(frame)) { keep.push(frame); continue; }
		const fns = net.clientTopics.get(frame.topic);
		if (fns) for (const fn of [...fns]) fn({ topic: frame.topic, event: frame.event, data: frame.data });
	}
	net.toClient.push(...keep);
	await ticks();
}

const subscribeFrames = () => net.toServer.filter((f) => f && f.stream || (f && Array.isArray(f.batch)));
const unsubscribeFrames = (topic) => net.toServer.filter((f) => f && f.type === 'unsubscribe' && f.topic === topic);
const member = (room, prefix = 'board:') => _presenceRefForTest().get(prefix + room + '\0alice');
const roomData = (room) => __stream('collab/board/__data', { merge: 'crud', key: 'id' }, true)(room);

/** Fake the clock, let the presence grace run out, and report the leaves published for alice. */
async function leavesAfterGrace(room) {
	await vi.advanceTimersByTimeAsync(5001);
	return net.published.filter((p) => p.topic === 'board:' + room + ':presence' && p.event === 'leave' && p.data.key === 'alice');
}

describe('a stream released before its subscribe is answered', () => {
	it('released before the attach frame: the server ends unsubscribed and publishes the leave', async () => {
		const off = roomData('r1').subscribe(() => {});
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		off();
		await ticks();
		// Nothing goes out yet: an unsubscribe ahead of the subscribe would be undone by it.
		expect(unsubscribeFrames('board:r1')).toHaveLength(0);

		await deliverToServer();
		expect(member('r1').count).toBe(1);
		expect(net.serverTopics.has('board:r1')).toBe(true);

		await deliverToClient();
		expect(unsubscribeFrames('board:r1')).toHaveLength(1);

		vi.useFakeTimers();
		await deliverToServer();
		expect(net.serverTopics.has('board:r1')).toBe(false);
		expect(member('r1').count).toBe(0);
		expect(await leavesAfterGrace('r1')).toHaveLength(1);
		expect(member('r1')).toBeUndefined();
	});

	it('released after the attach frame, while the server is still subscribing: the release waits for the answer', async () => {
		const subscribeGate = deferred();
		const origSubscribe = env.platform.subscribe;
		env.platform.subscribe = async (sock, topic) => {
			await subscribeGate.promise;
			return origSubscribe(sock, topic);
		};
		const off = roomData('r2').subscribe(() => {});
		await ticks();
		const { id } = subscribeFrames()[0];
		// The server names the topic and parks in platform.subscribe.
		await deliverToServer(1, 'attach');
		await deliverToClient();
		off();
		await ticks();
		expect(unsubscribeFrames('board:r2')).toHaveLength(0);

		subscribeGate.resolve();
		await until(() => replyTo(id, false));
		expect(member('r2').count).toBe(1);
		await deliverToClient();
		expect(unsubscribeFrames('board:r2')).toHaveLength(1);

		vi.useFakeTimers();
		await deliverToServer();
		expect(net.serverTopics.has('board:r2')).toBe(false);
		expect(await leavesAfterGrace('r2')).toHaveLength(1);
	});

	it('released in the tick it subscribed: no subscribe reaches the server', async () => {
		const store = roomData('r3');
		const off = store.subscribe(() => {});
		off();
		expect(get(store)).toBeUndefined();
		await ticks();
		await settle();
		expect(net.toServer).toEqual([]);
	});

	it('a subscriber that returns before the release still gets the subscribe sent, exactly once', async () => {
		const store = roomData('r4');
		const values = [];
		let off2;
		const off1 = store.subscribe(() => {});
		off1();
		off2 = store.subscribe((v) => values.push(v));
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		await deliverToServer();
		await deliverToClient();
		expect(values.at(-1)).toEqual([]);
		expect(member('r4').count).toBe(1);
		off2();
	});

	it('another live stream on the same wire topic is not unsubscribed by the released one', async () => {
		env.register('feed', {
			a: live.stream('shared:feed', async () => [{ id: 1 }]),
			b: live.stream('shared:feed', async () => [{ id: 1 }])
		});
		const a = __stream('feed/a', { merge: 'crud', key: 'id' });
		const b = __stream('feed/b', { merge: 'crud', key: 'id' });
		const offA = a.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		expect(net.serverTopics.has('shared:feed')).toBe(true);

		const offB = b.subscribe(() => {});
		await ticks();
		offB();
		await ticks();
		await deliverToServer();
		await deliverToClient();
		expect(unsubscribeFrames('shared:feed')).toHaveLength(0);
		expect(net.serverTopics.has('shared:feed')).toBe(true);

		offA();
		await ticks();
		expect(unsubscribeFrames('shared:feed')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('shared:feed')).toBe(false);
	});

	it('a resubscribe sent before the released request is answered keeps its subscription', async () => {
		const store = roomData('r5');
		const off1 = store.subscribe(() => {});
		await ticks();
		off1();
		await ticks();
		const off2 = store.subscribe(() => {});
		await ticks();
		expect(subscribeFrames()).toHaveLength(2);

		// The released request is answered while the new one is still on its way.
		await deliverToServer(1);
		await deliverToClient();
		// A release now could reach the server after the new subscribe and cut it.
		expect(unsubscribeFrames('board:r5')).toHaveLength(0);

		await deliverToServer();
		await deliverToClient();
		await deliverToServer();
		expect(unsubscribeFrames('board:r5')).toHaveLength(0);
		expect(net.serverTopics.has('board:r5')).toBe(true);
		expect(member('r5').count).toBe(2);

		// One release drains both subscribes.
		off2();
		await ticks();
		expect(unsubscribeFrames('board:r5')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('board:r5')).toBe(false);
		expect(member('r5').count).toBe(0);
	});

	it('a subscribe answered after the stream timed out is released', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const store = roomData('r6');
		const errors = [];
		store.error.subscribe((e) => { if (e) errors.push(e.code); });
		const off = store.subscribe(() => {});
		await ticks();
		vi.advanceTimersByTime(30_000);
		expect(errors).toEqual(['TIMEOUT']);

		await deliverToServer();
		expect(member('r6').count).toBe(1);
		await deliverToClient();
		expect(unsubscribeFrames('board:r6')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('board:r6')).toBe(false);
		expect(member('r6').count).toBe(0);
		off();
	});

	it('released while its request sat in the adapter queue across a failed connect: released once the socket is back', async () => {
		setStatus('connecting');
		const off = roomData('r7').subscribe(() => {});
		await ticks();
		expect(net.adapterQueue).toHaveLength(1);
		off();
		await ticks();
		// The connect attempt fails; the queued request stays queued.
		setStatus('disconnected');
		await ticks();
		setStatus('connecting');
		setStatus('open');
		expect(subscribeFrames()).toHaveLength(1);

		await deliverToServer();
		expect(member('r7').count).toBe(1);
		await deliverToClient();
		expect(unsubscribeFrames('board:r7')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('board:r7')).toBe(false);
		expect(member('r7').count).toBe(0);
	});

	it('a stream whose queued request a failed connect rejected subscribes again on open, and keeps that subscription', async () => {
		setStatus('connecting');
		const store = roomData('r8');
		const values = [];
		const off = store.subscribe((v) => values.push(v));
		await ticks();
		setStatus('disconnected');
		await ticks();
		expect(get(store.error)?.code).toBe('DISCONNECTED');
		setStatus('connecting');
		setStatus('open');
		// The queued request goes out on open; the stream sends a fresh one
		// after its reconnect delay.
		await settle(150);
		expect(subscribeFrames()).toHaveLength(2);

		await deliverToServer();
		await deliverToClient();
		await deliverToServer();
		expect(unsubscribeFrames('board:r8')).toHaveLength(0);
		expect(net.serverTopics.has('board:r8')).toBe(true);
		expect(get(store.error)).toBeNull();
		expect(values.at(-1)).toEqual([]);

		off();
		await ticks();
		expect(unsubscribeFrames('board:r8')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('board:r8')).toBe(false);
		expect(member('r8').count).toBe(0);
	});

	it('a subscribe queued for the first open is sent once', async () => {
		setStatus('connecting');
		const store = roomData('r9');
		const values = [];
		const off = store.subscribe((v) => values.push(v));
		await ticks();
		setStatus('open');
		await settle(150);
		expect(subscribeFrames()).toHaveLength(1);
		await deliverToServer();
		await deliverToClient();
		expect(values.at(-1)).toEqual([]);
		off();
	});

	it('a subscribe queued during an outage is sent once when the socket comes back', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		setStatus('disconnected');
		const values = [];
		const off = roomData('r23').subscribe((v) => values.push(v));
		await ticks();
		expect(net.adapterQueue).toHaveLength(1);
		setStatus('connecting');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		await deliverToServer();
		await deliverToClient();
		expect(values.at(-1)).toEqual([]);
		off();
	});

	it('released while offline after a failed connect rejected its request: the late answer is released', async () => {
		setStatus('connecting');
		const off = roomData('r10').subscribe(() => {});
		await ticks();
		setStatus('disconnected');
		await ticks();
		off();
		await ticks();
		setStatus('connecting');
		setStatus('open');
		await settle(150);
		expect(subscribeFrames()).toHaveLength(1);

		await deliverToServer();
		expect(member('r10').count).toBe(1);
		await deliverToClient();
		expect(unsubscribeFrames('board:r10')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('board:r10')).toBe(false);
		expect(member('r10').count).toBe(0);
	});

	it('a superseded subscribe answered after its successor was refused is released', async () => {
		const store = __stream('locked/board/__data', { merge: 'crud', key: 'id' }, true)('r11');
		const off = store.subscribe(() => {});
		await ticks();
		// The tab comes back from the background: the stream subscribes again,
		// superseding the request still in flight.
		setStatus('suspended');
		setStatus('open');
		await settle(150);
		expect(subscribeFrames()).toHaveLength(2);

		await deliverToServer(1);
		expect(member('r11', 'locked:').count).toBe(1);
		deny = true;
		await deliverToServer();
		await deliverToClient();
		expect(get(store.error)?.code).toBe('FORBIDDEN');
		expect(unsubscribeFrames('locked:r11')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('locked:r11')).toBe(false);
		expect(member('r11', 'locked:').count).toBe(0);
		off();
	});

	it('an orphaned request is not given up while the socket is down', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		setStatus('connecting');
		const off = roomData('r12').subscribe(() => {});
		await ticks();
		off();
		await ticks();
		vi.advanceTimersByTime(120_000);
		setStatus('open');
		await deliverToServer();
		await deliverToClient();
		expect(unsubscribeFrames('board:r12')).toHaveLength(1);
	});

	it('an orphaned request the socket lost is given up one timeout after the socket is back', async () => {
		clientState.config.timeout = 40;
		const off = roomData('r13').subscribe(() => {});
		await ticks();
		const { id } = subscribeFrames()[0];
		off();
		await ticks();
		// The request was on the wire when the socket dropped; it is gone.
		net.toServer.length = 0;
		setStatus('disconnected');
		await ticks();
		expect(pending.has(id)).toBe(true);
		await settle(80);
		expect(pending.has(id)).toBe(true);
		setStatus('connecting');
		setStatus('open');
		await settle(80);
		expect(pending.has(id)).toBe(false);
	});

	it('a release waits for another stream\'s subscribe only until the server names its topic', async () => {
		const loaderGate = deferred();
		env.register('slow', { feed: live.stream('slow:feed', async () => { await loaderGate.promise; return []; }) });
		const offRoom = roomData('r15').subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();

		const offFeed = __stream('slow/feed', { merge: 'crud', key: 'id' }).subscribe(() => {});
		await ticks();
		offRoom();
		await ticks();
		// The feed's subscribe is out with no topic named: it could be this one.
		expect(unsubscribeFrames('board:r15')).toHaveLength(0);

		const { id } = subscribeFrames()[0];
		// Its attach frame names another topic; its answer waits on the loader.
		await deliverToServer(1, 'attach');
		await deliverToClient();
		expect(unsubscribeFrames('board:r15')).toHaveLength(1);

		loaderGate.resolve();
		await until(() => replyTo(id, false));
		await deliverToClient();
		offFeed();
	});

	it('a socket behind a hidden tab is up: an orphaned request on it is given up after one timeout', async () => {
		clientState.config.timeout = 40;
		setStatus('suspended');
		const off = roomData('r14').subscribe(() => {});
		await ticks();
		const { id } = subscribeFrames()[0];
		off();
		await ticks();
		expect(pending.has(id)).toBe(true);
		await settle(80);
		expect(pending.has(id)).toBe(false);
	});

	it('a stream resumed within the grace before its first answer subscribes once more, with no reconnect', async () => {
		const store = roomData('r16');
		const statuses = [];
		store.status.subscribe((s) => statuses.push(s));
		const off1 = store.subscribe(() => {});
		await ticks();
		off1();
		await ticks();
		const values = [];
		const off2 = store.subscribe((v) => values.push(v));
		await ticks();
		// Longer than any reconnect delay.
		await settle(150);
		expect(subscribeFrames()).toHaveLength(2);
		expect(statuses).not.toContain('reconnecting');
		await deliverToServer();
		await deliverToClient();
		expect(values.at(-1)).toEqual([]);
		off2();
	});

	it('a batch goes out without the requests held back from it', async () => {
		const offA = roomData('r17').subscribe(() => {});
		const offB = roomData('r18').subscribe(() => {});
		const offC = roomData('r19').subscribe(() => {});
		offB();
		await ticks();
		expect(net.toServer).toHaveLength(1);
		expect(net.toServer[0].batch.map((r) => r.args[0])).toEqual(['r17', 'r19']);
		await deliverToServer();
		await deliverToClient();
		expect(member('r17').count).toBe(1);
		expect(member('r19').count).toBe(1);
		expect(member('r18')).toBeUndefined();
		offA();
		offC();
	});

	it('subscribes in one tick go out in frames of at most 50, and all load', async () => {
		env.register('many', { item: live.stream((ctx, id) => 'item:' + id, async (ctx, id) => [{ id }]) });
		const make = __stream('many/item', { merge: 'crud', key: 'id' }, true);
		const frameSizes = () => net.toServer.map((f) => (f.batch ? f.batch.length : 1));
		for (const [count, sizes] of [[50, [50]], [51, [50, 1]], [101, [50, 50, 1]]]) {
			const values = new Map();
			const offs = [];
			for (let i = 0; i < count; i++) offs.push(make(count + ':' + i).subscribe((v) => values.set(i, v)));
			await ticks();
			expect(frameSizes()).toEqual(sizes);
			await deliverToServer();
			await deliverToClient();
			for (let i = 0; i < count; i++) expect(values.get(i)).toEqual([{ id: count + ':' + i }]);
			for (const off of offs) off();
			await ticks();
			net.toServer.length = 0;
		}
	});

	it('a request a disconnect rejected before the batch went out is not sent', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const off = roomData('r21').subscribe(() => {});
		// Same tick: the request is still in the batch.
		setStatus('disconnected');
		await ticks();
		expect(net.toServer).toEqual([]);
		expect(net.adapterQueue).toEqual([]);
		setStatus('connecting');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		await deliverToServer();
		await deliverToClient();
		expect(member('r21').count).toBe(1);
		off();
	});

	it('a stale queued answer that arrives before the stream subscribes again leaves it with one subscription', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		setStatus('connecting');
		const store = roomData('r20');
		const values = [];
		const off = store.subscribe((v) => values.push(v));
		await ticks();
		setStatus('disconnected');
		await ticks();
		setStatus('connecting');
		setStatus('open');
		// The queued request went out on open and is answered before the
		// stream's reconnect delay runs out; nothing else is in flight, so
		// its release goes out at once.
		expect(subscribeFrames()).toHaveLength(1);
		await deliverToServer();
		await deliverToClient();
		expect(unsubscribeFrames('board:r20')).toHaveLength(1);
		await deliverToServer();
		vi.advanceTimersByTime(200);
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		await deliverToServer();
		await deliverToClient();
		expect(net.serverTopics.has('board:r20')).toBe(true);
		expect(member('r20').count).toBe(1);
		expect(get(store.error)).toBeNull();
		expect(values.at(-1)).toEqual([]);
		off();
	});

	it('a request parked by a disconnect lets go of the ref its stream handed over', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		env.register('feed', {
			a: live.stream('shared:feed', async () => []),
			b: live.stream('shared:feed', async () => [])
		});
		const offA = __stream('feed/a', { merge: 'crud', key: 'id' }).subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		// The tab comes back from the background: the stream subscribes again
		// while it still holds the topic, and is released before the answer.
		setStatus('suspended');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		offA();
		await ticks();
		// The socket drops with that request on the wire.
		net.toServer.length = 0;
		setStatus('disconnected');
		await ticks();
		setStatus('connecting');
		setStatus('open');
		await ticks();
		const offB = __stream('feed/b', { merge: 'crud', key: 'id' }).subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		offB();
		await ticks();
		expect(unsubscribeFrames('shared:feed')).toHaveLength(1);
	});

	it('a page request in flight keeps the release back until it is answered', async () => {
		env.register('paged', {
			feed: live.stream('paged:feed', async (ctx) => ({ data: [{ id: ctx.cursor ? 2 : 1 }], hasMore: !ctx.cursor, cursor: ctx.cursor ? null : 'c1' }))
		});
		const store = __stream('paged/feed', { merge: 'crud', key: 'id' });
		const off = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		// The page request subscribes the socket again; park it before it does.
		const subscribeGate = deferred();
		const origSubscribe = env.platform.subscribe;
		env.platform.subscribe = async (sock, topic) => {
			await subscribeGate.promise;
			return origSubscribe(sock, topic);
		};
		const page = store.loadMore();
		await ticks();
		const { id } = net.toServer[0];
		off();
		await ticks();
		expect(unsubscribeFrames('paged:feed')).toHaveLength(0);
		await deliverToServer(1, 'none');
		subscribeGate.resolve();
		await until(() => replyTo(id, false));
		await deliverToClient();
		expect(await page).toBe(false);
		expect(unsubscribeFrames('paged:feed')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('paged:feed')).toBe(false);
	});

	it('a connection closed for good keeps no orphaned request', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const off1 = roomData('r24').subscribe(() => {});
		await ticks();
		const first = subscribeFrames()[0].id;
		off1();
		await ticks();
		expect(pending.has(first)).toBe(true);
		const connectsAtClose = net.connects;
		setStatus('failed');
		await ticks();
		expect(pending.has(first)).toBe(false);
		// A subscribe after that is never made: nothing queued, nothing waiting.
		const store = roomData('r25');
		let error = null;
		const offError = store.error.subscribe((e) => { error = e; });
		const off2 = store.subscribe(() => {});
		await ticks();
		expect(error?.code).toBe('CONNECTION_CLOSED');
		expect(net.adapterQueue).toHaveLength(0);
		expect(pending.size).toBe(0);
		off2();
		offError();
		vi.advanceTimersByTime(30_000);
		await ticks();
		expect(net.connects).toBe(connectsAtClose);
		expect(net.adapterQueue).toHaveLength(0);
		expect(pending.size).toBe(0);
	});

	it('a release waits for subscribes that keep overlapping for at most one timeout', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
		env.register('slow', { feed: live.stream((ctx, id) => 'slow:' + id, async () => []) });
		const slow = __stream('slow/feed', { merge: 'crud', key: 'id' }, true);
		const offRoom = roomData('r26').subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		// Subscribes the server never names keep arriving.
		const offA = slow('a').subscribe(() => {});
		await ticks();
		vi.advanceTimersByTime(1_000);
		offRoom();
		await ticks();
		expect(unsubscribeFrames('board:r26')).toHaveLength(0);
		vi.advanceTimersByTime(19_000);
		const offB = slow('b').subscribe(() => {});
		await ticks();
		// The first gives up, the second is still out: the release still waits.
		vi.advanceTimersByTime(10_000);
		await ticks();
		expect(unsubscribeFrames('board:r26')).toHaveLength(0);
		// A full timeout after it was asked for, it goes out.
		vi.advanceTimersByTime(1_500);
		await ticks();
		expect(unsubscribeFrames('board:r26')).toHaveLength(1);
		offA();
		offB();
	});

	it('a stream that loaded behind a hidden tab subscribes again on the first open after a drop', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		setStatus('suspended');
		const off = roomData('r27').subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		// The socket drops and comes back while the tab is still hidden.
		setStatus('disconnected');
		setStatus('connecting');
		setStatus('suspended');
		await ticks();
		expect(subscribeFrames()).toHaveLength(0);
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		off();
	});

	it('switching rooms in one tick sends the old room\'s release ahead of the new subscribe', async () => {
		const offA = roomData('r28').subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		const offB = roomData('r29').subscribe(() => {});
		offA();
		await ticks();
		expect(net.toServer.map((f) => (f.type === 'unsubscribe' ? 'leave ' + f.topic : 'join ' + f.args[0]))).toEqual(['leave board:r28', 'join r29']);
		await deliverToServer();
		await deliverToClient();
		// The other order within the tick ends the same way.
		const storeC = roomData('r30');
		offB();
		const offC = storeC.subscribe(() => {});
		await ticks();
		expect(net.toServer.map((f) => (f.type === 'unsubscribe' ? 'leave ' + f.topic : 'join ' + f.args[0]))).toEqual(['leave board:r29', 'join r30']);
		offC();
	});

	it('a subscribe goes out a microtask after it is asked for when nothing is being released', async () => {
		const store = roomData('r32');
		const off1 = store.subscribe(() => {});
		off1();
		const off2 = store.subscribe(() => {});
		await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		net.toServer.length = 0;
		const off3 = roomData('r33').subscribe(() => {});
		await Promise.resolve();
		expect(subscribeFrames()).toHaveLength(1);
		off3();
		await ticks();
		net.toServer.length = 0;
		const off4 = roomData('r34').subscribe(() => {});
		await Promise.resolve();
		expect(subscribeFrames()).toHaveLength(1);
		off2();
		off4();
	});

	/** Load a room view behind a hidden tab, give it a replay cursor, drop the socket for `outageMs`, then show the tab. */
	async function hiddenOutage(room, outageMs) {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		setStatus('suspended');
		const off = roomData(room).subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		for (const fn of [...net.clientTopics.get('board:' + room)]) fn({ topic: 'board:' + room, event: 'created', data: { id: 9 }, seq: 7 });
		setStatus('disconnected');
		setStatus('connecting');
		setStatus('suspended');
		vi.advanceTimersByTime(outageMs);
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		const frames = subscribeFrames();
		off();
		return frames;
	}

	it('the resubscribe on a first open after a long outage drops the stale replay cursor', async () => {
		const frames = await hiddenOutage('r35', 61_000);
		expect(frames).toHaveLength(1);
		expect(frames[0].seq).toBeUndefined();
	});

	it('the resubscribe on a first open after a short outage keeps the replay cursor', async () => {
		const frames = await hiddenOutage('r36', 1_000);
		expect(frames).toHaveLength(1);
		expect(frames[0].seq).toBe(7);
	});

	it('an outage the first open ends without a resubscribe does not age the cursor for a later reconnect', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		// An outage longer than the cursor is trusted, shorter than the RPC timeout.
		clientState.config.resumeMaxCursorAgeMs = 10_000;
		setStatus('disconnected');
		const off = roomData('r38').subscribe(() => {});
		await ticks();
		vi.advanceTimersByTime(15_000);
		setStatus('connecting');
		setStatus('open');
		await deliverToServer();
		await deliverToClient();
		for (const fn of [...net.clientTopics.get('board:r38')]) fn({ topic: 'board:r38', event: 'created', data: { id: 9 }, seq: 7 });
		// A short drop later: the cursor is still good.
		setStatus('disconnected');
		vi.advanceTimersByTime(1_000);
		setStatus('connecting');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		const frames = subscribeFrames();
		expect(frames).toHaveLength(1);
		expect(frames[0].seq).toBe(7);
		off();
	});

	it('a stream resumed from the grace during an outage ages its cursor from the release when it subscribes again', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const store = roomData('r39');
		const off1 = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		for (const fn of [...net.clientTopics.get('board:r39')]) fn({ topic: 'board:r39', event: 'created', data: { id: 9 }, seq: 7 });
		off1();
		await ticks();
		await deliverToServer();
		vi.advanceTimersByTime(10_000);
		setStatus('disconnected');
		vi.advanceTimersByTime(40_000);
		setStatus('connecting');
		// 50s after the release: the cursor is still trusted and rides the resume.
		const off2 = store.subscribe(() => {});
		await ticks();
		expect(net.adapterQueue.at(-1).seq).toBe(7);
		vi.advanceTimersByTime(2_000);
		setStatus('disconnected');
		vi.advanceTimersByTime(48_000);
		setStatus('connecting');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		// 100s after the release: the stream subscribes again without it.
		expect(subscribeFrames().at(-1).seq).toBeUndefined();
		off2();
	});

	/** A view with a replay cursor, released, then resumed behind a hidden tab 50s later and answered there. */
	async function resumedBehindHiddenTab(room) {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const store = roomData(room);
		const off1 = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		for (const fn of [...net.clientTopics.get('board:' + room)]) fn({ topic: 'board:' + room, event: 'created', data: { id: 9 }, seq: 7 });
		off1();
		await ticks();
		await deliverToServer();
		setStatus('suspended');
		vi.advanceTimersByTime(50_000);
		const off2 = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		return { store, off2 };
	}

	it('an answered resume restarts the cursor clock for the next release', async () => {
		const { store, off2 } = await resumedBehindHiddenTab('r43');
		vi.advanceTimersByTime(5_000);
		off2();
		await ticks();
		vi.advanceTimersByTime(7_000);
		const off3 = store.subscribe(() => {});
		await ticks();
		// 62s after the first release, 7s after the second: the cursor rides.
		expect(subscribeFrames().at(-1).seq).toBe(7);
		off3();
	});

	it('an answered resume restarts the cursor clock for the next outage', async () => {
		const { off2 } = await resumedBehindHiddenTab('r44');
		vi.advanceTimersByTime(9_000);
		setStatus('disconnected');
		setStatus('connecting');
		setStatus('suspended');
		vi.advanceTimersByTime(2_000);
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		// A 2s outage, 61s after the first release: the cursor rides.
		expect(subscribeFrames().at(-1).seq).toBe(7);
		off2();
	});

	it('a resume the socket loses before its answer ages its cursor from the release', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const store = roomData('r45');
		const off1 = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		for (const fn of [...net.clientTopics.get('board:r45')]) fn({ topic: 'board:r45', event: 'created', data: { id: 9 }, seq: 7 });
		off1();
		await ticks();
		await deliverToServer();
		vi.advanceTimersByTime(50_000);
		const off2 = store.subscribe(() => {});
		await ticks();
		expect(subscribeFrames().at(-1).seq).toBe(7);
		// Lost with the socket, unanswered: the cursor has not moved since the release.
		net.toServer.length = 0;
		vi.advanceTimersByTime(2_000);
		setStatus('disconnected');
		vi.advanceTimersByTime(10_000);
		setStatus('connecting');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		expect(subscribeFrames().at(-1).seq).toBeUndefined();
		off2();
	});

	it('an answer that lands behind a hidden tab starts the cursor clock there', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const off = roomData('r46').subscribe(() => {});
		await ticks();
		// The tab hides before the answer.
		setStatus('suspended');
		await deliverToServer();
		await deliverToClient();
		for (const fn of [...net.clientTopics.get('board:r46')]) fn({ topic: 'board:r46', event: 'created', data: { id: 9 }, seq: 7 });
		// The page freezes; the socket dies with it and is noticed on wake.
		vi.advanceTimersByTime(61_000);
		setStatus('disconnected');
		setStatus('connecting');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		expect(subscribeFrames().at(-1).seq).toBeUndefined();
		off();
	});

	it('a request its timer settles before the batch went out is not sent', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const store = roomData('r40');
		const off = store.subscribe(() => {});
		// Virtual time runs before the batch microtask.
		vi.advanceTimersByTime(30_000);
		await ticks();
		expect(get(store.error)?.code).toBe('TIMEOUT');
		expect(net.toServer).toEqual([]);
		off();
	});

	it('an unsubscriber called twice does not leave later subscribes waiting a hop', async () => {
		const off1 = roomData('r41').subscribe(() => {});
		off1();
		off1();
		await ticks();
		net.toServer.length = 0;
		const off2 = roomData('r42').subscribe(() => {});
		await Promise.resolve();
		expect(subscribeFrames()).toHaveLength(1);
		off2();
	});

	it('a stream whose subscribe timed out before the socket first opened subscribes again on open', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		setStatus('connecting');
		const store = roomData('r37');
		const values = [];
		const off = store.subscribe((v) => values.push(v));
		await ticks();
		vi.advanceTimersByTime(30_000);
		expect(get(store.error)?.code).toBe('TIMEOUT');
		setStatus('open');
		vi.advanceTimersByTime(200);
		await ticks();
		// The timed-out request goes out on open, and the stream subscribes again.
		expect(subscribeFrames()).toHaveLength(2);
		await deliverToServer();
		await deliverToClient();
		expect(get(store.error)).toBeNull();
		expect(values.at(-1)).toEqual([]);
		expect(unsubscribeFrames('board:r37')).toHaveLength(0);
		expect(net.serverTopics.has('board:r37')).toBe(true);
		off();
	});

	it('a page asked for after the stream let go of its topic is released once answered', async () => {
		const store = pagedFeed('pagedafter');
		const off = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		off();
		await ticks();
		await deliverToServer();
		expect(net.serverTopics.has('pagedafter:feed')).toBe(false);
		// Still within the resume grace, so the cursor is kept: the page goes out.
		const page = store.loadMore();
		await ticks();
		await deliverToServer();
		expect(net.serverTopics.has('pagedafter:feed')).toBe(true);
		await deliverToClient();
		expect(await page).toBe(false);
		expect(unsubscribeFrames('pagedafter:feed')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('pagedafter:feed')).toBe(false);
	});

	function pagedFeed(name) {
		env.register(name, {
			feed: live.stream(name + ':feed', async (ctx) => ({ data: [{ id: ctx.cursor ? 2 : 1 }], hasMore: !ctx.cursor, cursor: ctx.cursor ? null : 'c1' }))
		});
		return __stream(name + '/feed', { merge: 'crud', key: 'id' });
	}

	it('a page answered after it timed out is released', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const store = pagedFeed('pagedlate');
		const off = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		const page = store.loadMore().catch((e) => e.code);
		await ticks();
		off();
		await ticks();
		vi.advanceTimersByTime(30_000);
		expect(await page).toBe('TIMEOUT');
		// The server has not handled the page yet: nothing may go out.
		expect(unsubscribeFrames('pagedlate:feed')).toHaveLength(0);
		await deliverToServer();
		await deliverToClient();
		expect(unsubscribeFrames('pagedlate:feed')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('pagedlate:feed')).toBe(false);
	});

	it('a page a disconnect rejected while queued is released once the socket is back', async () => {
		const store = pagedFeed('pagedq');
		const off = store.subscribe(() => {});
		await ticks();
		await deliverToServer();
		await deliverToClient();
		// The tab hid and the socket is reconnecting when the page is asked for.
		setStatus('connecting');
		const page = store.loadMore().catch((e) => e.code);
		await ticks();
		expect(net.adapterQueue).toHaveLength(1);
		setStatus('disconnected');
		expect(await page).toBe('DISCONNECTED');
		off();
		await ticks();
		setStatus('connecting');
		setStatus('open');
		await ticks();
		// The stream's own release went out while the socket was down; the
		// queued page subscribes the socket again on open.
		await deliverToServer();
		expect(net.serverTopics.has('pagedq:feed')).toBe(true);
		await deliverToClient();
		expect(unsubscribeFrames('pagedq:feed')).toHaveLength(1);
		await deliverToServer();
		expect(net.serverTopics.has('pagedq:feed')).toBe(false);
	});
});


it('stream coalescing keeps large Unicode argument lists under its byte budget and preserves order', async () => {
 env.register('sized', { item: live.stream((ctx, id) => 'sized:' + id, async (ctx, id) => [{ id }]) });
 const make = __stream('sized/item', { merge: 'crud', key: 'id' }, true);
 const padding = '\u79d8\u5bc6'.repeat(2000);
 const values = new Map(); const offs = [];
 for (let i = 0; i < 23; i++) offs.push(make(i, padding).subscribe(value => values.set(i, value)));
 await ticks();
 const frames = subscribeFrames();
 expect(frames.length).toBeGreaterThan(1);
 expect(frames.flatMap(frame => frame.batch || [frame]).map(call => call.args[0])).toEqual(Array.from({ length: 23 }, (_, i) => i));
 for (const frame of frames) expect(textEncoder.encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(64 * 1024);
 await deliverToServer(); await deliverToClient();
 for (let i = 0; i < 23; i++) expect(values.get(i)).toEqual([{ id: i }]);
 for (const off of offs) off();
});

it('complex stream arguments travel alone without an extra toJSON call during coalescing', async () => {
 env.register('custom', { item: live.stream((ctx, value) => 'custom:' + value.id, async (ctx, value) => [value]) });
 const make = __stream('custom/item', { merge: 'crud', key: 'id' }, true);
 let serializations = 0; const offs = [];
 for (let i = 0; i < 3; i++) offs.push(make({ toJSON() { serializations++; return { id: i }; } }).subscribe(() => {}));
 expect(serializations).toBe(3); // Dynamic cache keys, as before.
 await ticks();
 expect(serializations).toBe(3);
 expect(subscribeFrames()).toHaveLength(3);
 expect(subscribeFrames().every(frame => !frame.batch)).toBe(true);
 await deliverToServer(); await deliverToClient();
 expect(serializations).toBe(6); // Each transport serialization runs it once.
 expect(pending.size).toBe(0);
 for (const off of offs) off();
});

it('an oversized incoming stream batch settles every client request without timeouts', async () => {
 const handler = vi.fn(async (ctx, id) => [{ id }]);
 env.register('oversized', { item: live.stream((ctx, id) => 'oversized:' + id, handler) });
 const make = __stream('oversized/item', { merge: 'crud', key: 'id' }, true);
 const outcomes = []; const offs = [];
 for (let i = 0; i < 51; i++) {
  const stream = make(i);
  offs.push(stream.subscribe(() => {}));
  offs.push(stream.error.subscribe(error => { if (error) outcomes.push(error); }));
 }
 await ticks();
 // A previous client or a custom transport may still send an unsplit batch.
 const calls = net.toServer.splice(0).flatMap(frame => frame.batch || [frame]);
 expect(calls).toHaveLength(51);
 net.toServer.push({ batch: calls });
 await deliverToServer(1, 'none'); await deliverToClient();
 expect(pending.size).toBe(0);
 expect(outcomes).toHaveLength(51);
 expect(outcomes.every(error => error.code === 'INVALID_REQUEST')).toBe(true);
 expect(handler).not.toHaveBeenCalled();
 for (const off of offs) off();
});


describe('mapped stream lifecycle', () => {
 it('shares lazy activation and keeps another consumer alive after repeated cleanup', async () => {
  env.register('mapped', { feed: live.stream('mapped:feed', async () => [{ id: 1, name: 'A' }]) });
  const source = __stream('mapped/feed', { merge: 'crud', key: 'id' });
  const mapped = source.map(item => item.name);
  await ticks();
  expect(subscribeFrames()).toHaveLength(0);
  const first = []; const second = [];
  const offFirst = mapped.subscribe(value => first.push(value));
  const offSecond = mapped.subscribe(value => second.push(value));
  await ticks();
  expect(subscribeFrames()).toHaveLength(1);
  await deliverToServer(); await deliverToClient();
  expect(first.at(-1)).toEqual(['A']);
  expect(second.at(-1)).toEqual(['A']);
  offFirst(); offFirst();
  await ticks();
  expect(unsubscribeFrames('mapped:feed')).toHaveLength(0);
  for (const fn of [...net.clientTopics.get('mapped:feed')]) fn({ event: 'created', data: { id: 2, name: 'B' } });
  expect(first.at(-1)).toEqual(['A']);
  expect(second.at(-1)).toEqual(['A', 'B']);
  offSecond();
  await ticks();
  expect(unsubscribeFrames('mapped:feed')).toHaveLength(1);
  await deliverToServer();
  expect(net.serverTopics.has('mapped:feed')).toBe(false);
 });

 it('chains projections once per emission and restarts after the last consumer leaves', async () => {
  env.register('mapped', { feed: live.stream('mapped:chain', async () => [{ id: 1, name: 'Alpha' }]) });
  const source = __stream('mapped/feed', { merge: 'crud', key: 'id' });
  const projectName = vi.fn(item => item.name);
  const projectLength = vi.fn(name => name.length);
  const names = source.map(projectName);
  const lengths = names.map(projectLength);
  const values = []; const other = [];
  const off = lengths.subscribe(value => values.push(value));
  const offOther = lengths.subscribe(value => other.push(value));
  await ticks(); await deliverToServer(); await deliverToClient();
  expect(values.at(-1)).toEqual([5]);
  expect(other.at(-1)).toEqual([5]);
  expect(projectName).toHaveBeenCalledTimes(1);
  expect(projectLength).toHaveBeenCalledTimes(1);
  off(); offOther();
  await ticks(); await deliverToServer();
  expect(net.serverTopics.has('mapped:chain')).toBe(false);
  projectName.mockClear(); projectLength.mockClear();
  const resumed = [];
  const offResumed = lengths.subscribe(value => resumed.push(value));
  await ticks();
  expect(subscribeFrames()).toHaveLength(1);
  await deliverToServer(); await deliverToClient();
  expect(resumed.at(-1)).toEqual([5]);
  expect(projectName).toHaveBeenCalled();
  expect(projectLength).toHaveBeenCalled();
  offResumed();
  await ticks(); await deliverToServer();
  expect(net.serverTopics.has('mapped:chain')).toBe(false);
 });
});


describe('retained pagination cursor', () => {
 it('exposes opaque server cursors without deriving them from live rows and clears omitted next cursors', async () => {
  const cursors = [{ offset: 2, token: 'opaque' }, 'next-page'];
  let page = 0;
  env.register('cursor', { feed: live.stream('cursor:feed', async ctx => {
   if (page) expect(ctx.cursor).toEqual(cursors[page - 1]);
   return { data: [{ id: ++page }], hasMore: page < 3, ...(page < 3 ? { cursor: cursors[page - 1] } : {}) };
  }) });
  const stream = __stream('cursor/feed', { merge: 'crud', key: 'id' });
  expect(stream.cursor).toBeNull();
  expect(Object.getOwnPropertyDescriptor(stream, 'cursor').set).toBeUndefined();
  const seen = []; const off = stream.subscribe(value => seen.push({ value, cursor: stream.cursor }));
  await ticks(); await deliverToServer(); await deliverToClient();
  expect(stream.cursor).toEqual(cursors[0]);
  expect(seen.at(-1).cursor).toEqual(cursors[0]);
  for (const fn of [...net.clientTopics.get('cursor:feed')]) fn({ event: 'created', data: { id: 99 } });
  expect(stream.cursor).toEqual(cursors[0]);
  let loaded = stream.loadMore();
  await deliverToServer(); await deliverToClient(); await loaded;
  expect(stream.cursor).toBe(cursors[1]);
  loaded = stream.loadMore();
  await deliverToServer(); await deliverToClient(); await loaded;
  expect(stream.hasMore).toBe(false);
  expect(stream.cursor).toBeNull();
  expect(seen.at(-1).cursor).toBeNull();
  off();
 });

 it('clears retained pagination when a resumed full snapshot is no longer paginated', async () => {
  clientState.config.resumeGraceMs = 30000;
  let paginated = true;
  env.register('cursor', { feed: live.stream('cursor:resume', async () => paginated ? { data: [{ id: 1 }], hasMore: true, cursor: 'old-page' } : [{ id: 2 }]) });
  const stream = __stream('cursor/feed', { merge: 'crud', key: 'id' });
  let off = stream.subscribe(() => {});
  await ticks(); await deliverToServer(); await deliverToClient();
  expect(stream.cursor).toBe('old-page');
  off(); await ticks(); await deliverToServer();
  expect(stream.cursor).toBe('old-page');
  paginated = false;
  off = stream.subscribe(() => {});
  await ticks(); await deliverToServer(); await deliverToClient();
  expect(stream.hasMore).toBe(false);
  expect(stream.cursor).toBeNull();
  off();
 });

 it.each(['delta', 'replay', 'unchanged'])('preserves the cursor across a %s-only reconnect', async mode => {
  clientState.config.resumeGraceMs = 30000;
  env.register('cursor', { feed: live.stream('cursor:partial', async () => ({ data: [{ id: 1 }], hasMore: true, cursor: 'keep-page' })) });
  const stream = __stream('cursor/feed', { merge: 'crud', key: 'id' });
  let off = stream.subscribe(() => {});
  await ticks(); await deliverToServer(); await deliverToClient();
  off(); await ticks(); await deliverToServer();
  off = stream.subscribe(() => {});
  await ticks(); await deliverToServer();
  // Gap-fill envelopes carry changes, without pagination metadata.
  for (const frame of net.toClient) if (frame.topic === '__rpc' && frame.data.ok === true && !frame.data.attach) {
   delete frame.data.hasMore; delete frame.data.cursor;
   frame.data[mode] = true; frame.data.data = [];
  }
  await deliverToClient();
  expect(stream.cursor).toBe('keep-page');
  expect(stream.hasMore).toBe(true);
  off();
 });

 it('clears the retained cursor when the session is reset after final cleanup', async () => {
  clientState.config.resumeGraceMs = 0;
  env.register('cursor', { feed: live.stream('cursor:reset', async () => ({ data: [{ id: 1 }], hasMore: true, cursor: { offset: 1 } })) });
  const stream = __stream('cursor/feed', { merge: 'crud', key: 'id' });
  const off = stream.subscribe(() => {});
  await ticks(); await deliverToServer(); await deliverToClient();
  expect(stream.cursor).toEqual({ offset: 1 });
  off(); await ticks();
  expect(stream.cursor).toBeNull();
  expect(stream.hasMore).toBe(false);
 });

 it.each([0, ''])('retains a falsy opaque cursor (%j) until cleanup and sends it verbatim', async cursor => {
  clientState.config.resumeGraceMs = 0;
  let first = true;
  env.register('cursor', { feed: live.stream('cursor:falsy', async ctx => {
   if (first) { first = false; return { data: [{ id: 1 }], hasMore: true, cursor }; }
   expect(ctx.cursor).toBe(cursor);
   return { data: [{ id: 2 }], hasMore: false, cursor: null };
  }) });
  const stream = __stream('cursor/feed', { merge: 'crud', key: 'id' });
  const off = stream.subscribe(() => {});
  await ticks(); await deliverToServer(); await deliverToClient();
  expect(stream.cursor).toBe(cursor);
  const loaded = stream.loadMore();
  expect(net.toServer.at(-1)?.cursor).toBe(cursor);
  await deliverToServer(); await deliverToClient(); await loaded;
  expect(stream.cursor).toBeNull();
  off(); await ticks();
  expect(stream.cursor).toBeNull();
  expect(stream.hasMore).toBe(false);
 });
});


describe('stream lifecycle ownership edges', () => {
	it.each([false, true])('repeated cleanup preserves another consumer and later reactivation (dynamic: %s)', async dynamic => {
		env.register('lifetime', { feed: live.stream('lifetime:feed', async () => [{ id: 1 }]) });
		const factory = __stream('lifetime/feed', { merge: 'crud', key: 'id' }, dynamic);
		const stream = dynamic ? factory('same') : factory;
		const first = stream.subscribe(() => {});
		const values = [];
		const second = stream.subscribe(value => values.push(value));
		await ticks(); await deliverToServer(); await deliverToClient();
		first(); first(); await ticks();
		expect(unsubscribeFrames('lifetime:feed')).toHaveLength(0);
		for (const fn of [...net.clientTopics.get('lifetime:feed')]) fn({ event: 'created', data: { id: 2 } });
		expect(values.at(-1)).toEqual([{ id: 1 }, { id: 2 }]);
		second(); second(); await ticks();
		expect(unsubscribeFrames('lifetime:feed')).toHaveLength(1);
		await deliverToServer();
		const again = stream.subscribe(() => {});
		await ticks(); expect(subscribeFrames()).toHaveLength(1);
		await deliverToServer(); await deliverToClient(); again();
	});

	it('repeated cleanup cannot make a still-owned dynamic store evictable', async () => {
		const factory = __stream('cache/lifetime', { merge: 'crud', key: 'id' }, true);
		const stream = factory('held');
		const first = stream.subscribe(() => {}), second = stream.subscribe(() => {});
		first(); first();
		for (let i = 0; i < 1001; i++) factory('other-' + i);
		expect(factory('held')).toBe(stream);
		second(); await ticks();
	});

	it('a synchronous subscribe after detach receives normal grace on its later release', async () => {
		const stream = roomData('lifecycle-detach');
		const attached = stream.attach();
		await ticks(); await deliverToServer(); await deliverToClient(); await attached;
		for (const fn of [...net.clientTopics.get('board:lifecycle-detach')]) fn({ event: 'created', data: { id: 7 }, seq: 7 });
		stream.detach();
		const off = stream.subscribe(() => {});
		await ticks(); expect(unsubscribeFrames('board:lifecycle-detach')).toHaveLength(0);
		off(); await ticks(); await deliverToServer();
		const values = [];
		const resumed = stream.subscribe(value => values.push(value));
		expect(values[0]).toEqual([{ id: 7 }]);
		await ticks(); expect(subscribeFrames().at(-1).seq).toBe(7);
		resumed();
	});

	async function retainedCursor(room, cursorKind = 'seq') {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const stream = roomData(room);
		const values = [];
		const off = stream.subscribe(value => values.push(value));
		await ticks(); await deliverToServer();
		if (cursorKind !== 'seq') for (const frame of net.toClient) if (frame.data?.ok) frame.data.version = 9;
		await deliverToClient();
		for (const fn of [...net.clientTopics.get('board:' + room)]) fn({ event: 'created', data: { id: 7 }, ...(cursorKind === 'version' ? {} : { seq: 7 }) });
		return { stream, values, off };
	}

	it.each([[55_000, 'seq'], [61_000, 'seq'], [61_000, 'version'], [61_000, 'both']])('checks a queued grace cursor at actual open (age: %s, kind: %s)', async (age, kind) => {
		const { stream, off } = await retainedCursor('queued-age-' + age, kind);
		off(); await ticks(); await deliverToServer();
		setStatus('disconnected'); setStatus('connecting');
		vi.advanceTimersByTime(50_000);
		const values = [], resumed = stream.subscribe(value => values.push(value));
		await ticks();
		const queued = net.adapterQueue.at(-1);
		expect(queued.seq).toBe(kind === 'version' ? undefined : 7);
		if (kind !== 'seq') expect(queued.version).toBe(9);
		vi.advanceTimersByTime(age - 50_000);
		setStatus('open'); await ticks();
		const frames = subscribeFrames();
		if (age <= 60_000) {
			expect(frames).toHaveLength(1); expect(frames[0].seq).toBe(7);
		} else {
			expect(frames).toHaveLength(2); expect(frames.at(-1).seq).toBeUndefined(); expect(frames.at(-1).version).toBeUndefined();
			// The adapter already serialized the old queued frame. Its response
			// must only settle its orphan, never become this stream's baseline.
			for (const fn of [...net.clientTopics.get('__rpc')]) fn({ event: queued.id, data: { ok: true, topic: 'board:queued-age-' + age, data: [{ id: 'stale' }], seq: 7 } });
			expect(values.at(-1)).toEqual([{ id: 7 }]);
			net.toServer.splice(net.toServer.indexOf(queued), 1);
		}
		await deliverToServer(); await deliverToClient();
		expect(pending.size).toBe(0);
		expect(get(stream.status)).toBe('connected');
		expect(unsubscribeFrames('board:queued-age-' + age)).toHaveLength(0);
		resumed();
	});

	it('withdraws a stale resume before its batching microtask has sent it', async () => {
		const { stream, off } = await retainedCursor('unsent-age');
		off(); await ticks(); await deliverToServer();
		setStatus('disconnected'); setStatus('connecting'); vi.advanceTimersByTime(50_000);
		const resumed = stream.subscribe(() => {});
		vi.advanceTimersByTime(11_000); setStatus('open'); await ticks();
		expect(subscribeFrames()).toHaveLength(1);
		expect(subscribeFrames()[0].seq).toBeUndefined();
		expect(pending.size).toBe(1);
		await deliverToServer(); await deliverToClient();
		expect(pending.size).toBe(0); resumed();
	});

	it('a stale queued answer after the replacement cannot overwrite or release it', async () => {
		const { stream, off } = await retainedCursor('late-old-age');
		off(); await ticks(); await deliverToServer();
		setStatus('disconnected'); setStatus('connecting'); vi.advanceTimersByTime(50_000);
		const values = [], resumed = stream.subscribe(value => values.push(value));
		await ticks(); const queued = net.adapterQueue.at(-1);
		vi.advanceTimersByTime(11_000); setStatus('open'); await ticks();
		expect(subscribeFrames()).toHaveLength(2);
		net.toServer.splice(net.toServer.indexOf(queued), 1);
		await deliverToServer(); await deliverToClient();
		const current = values.at(-1);
		for (const fn of [...net.clientTopics.get('__rpc')]) fn({ event: queued.id, data: { ok: true, topic: 'board:late-old-age', data: [{ id: 'stale' }], seq: 7 } });
		expect(values.at(-1)).toEqual(current);
		expect(unsubscribeFrames('board:late-old-age')).toHaveLength(0);
		expect(pending.size).toBe(0); resumed();
	});

	it('a reconnect timer firing while down cannot restart the retained cursor age', async () => {
		const { stream, off } = await retainedCursor('timer-age');
		clientState.config.resumeMaxCursorAgeMs = 1000;
		setStatus('disconnected');
		vi.advanceTimersByTime(500);
		setStatus('connecting'); setStatus('open'); setStatus('connecting');
		vi.advanceTimersByTime(200); await ticks();
		expect(net.adapterQueue.at(-1).seq).toBe(7);
		vi.advanceTimersByTime(500);
		setStatus('open'); vi.advanceTimersByTime(200); await ticks();
		expect(subscribeFrames().at(-1).seq).toBeUndefined();
		await deliverToServer(); await deliverToClient();
		expect(get(stream.status)).toBe('connected');
		off();
	});
});


describe('attach-window replay inclusion', () => {
 function emit(topic, envelope) {
  expect(net.clientTopics.has(topic)).toBe(true);
  for (const fn of [...net.clientTopics.get(topic)]) fn({ topic, ...envelope });
 }

 async function resumeReplay(merge, replayed, buffered, responseSeq = 10) {
  clientState.config.resumeGraceMs = 30000;
  const gate = deferred();
  let resuming = false;
  let replayRead = false;
  const topic = 'inclusion:' + merge;
  env.platform.replay = {
   since: async () => { replayRead = true; await gate.promise; return replayed; },
   seq: async () => resuming ? responseSeq : 1
  };
  env.register('inclusion', { feed: live.stream(topic, async () => merge === 'set' ? { owner: 'initial' } : [], { merge, replay: true, max: 50 }) });
  const stream = __stream('inclusion/feed', { merge, max: 50 });
  let off = stream.subscribe(() => {});
  await ticks(); await deliverToServer(); await deliverToClient();
  off(); await ticks(); await deliverToServer();
  resuming = true;
  off = stream.subscribe(() => {});
  await ticks();
  expect(subscribeFrames().at(-1).seq).toBe(1);
  await deliverToServer(1, 'attach'); await deliverToClient();
  await until(() => replayRead);
  for (const envelope of buffered) emit(topic, envelope);
  gate.resolve();
  await until(() => net.toClient.some(frame => frame.data?.replay === true));
  const response = net.toClient.find(frame => frame.data?.replay === true).data;
  expect(response.seq).toBe(responseSeq);
  await deliverToClient();
  const result = get(stream);
  off(); await ticks(); await deliverToServer();
  return result;
 }

 it('deduplicates only exact replay members and keeps intervening and later live sequences', async () => {
  const event = seq => ({ event: 'push', data: { id: seq }, seq });
  const result = await resumeReplay('latest', [event(7), event(9)], [event(7), event(8), event(9), event(10)]);
  expect(result).toEqual([{ id: 7 }, { id: 9 }, { id: 8 }, { id: 10 }]);
 });

 it('does not roll a replayed set value back to an older included live frame', async () => {
  const old = { event: 'set', data: { owner: 'bob' }, seq: 7 };
  const latest = { event: 'set', data: { owner: 'carol' }, seq: 8 };
  expect(await resumeReplay('set', [old, latest], [old])).toEqual({ owner: 'carol' });
 });

 it('keeps a live set published between the replay read and response watermark', async () => {
  const old = { event: 'set', data: { owner: 'bob' }, seq: 7 };
  const latest = { event: 'set', data: { owner: 'carol' }, seq: 8 };
  expect(await resumeReplay('set', [old], [old, latest], 8)).toEqual({ owner: 'carol' });
 });

 it.each([undefined, null, -1, 1.5])('retains unidentifiable replay/live events with sequence %s', async seq => {
  const row = { event: 'push', data: { id: 'same' }, ...(seq === undefined ? {} : { seq }) };
  expect(await resumeReplay('latest', [row], [row])).toEqual([{ id: 'same' }, { id: 'same' }]);
 });

 it.each(['latest', 'set', 'crud'])('keeps loader-window live frames for %s even below the response watermark', async merge => {
  const gate = deferred();
  const topic = 'loader-window:' + merge;
  const snapshot = merge === 'set' ? { owner: 'bob' } : [{ id: 7 }];
  let read = false;
  env.platform.replay = { seq: async () => 8 };
  env.register('inclusion', { feed: live.stream(topic, async () => { read = true; await gate.promise; return snapshot; }, { merge, replay: true, max: 50 }) });
  const stream = __stream('inclusion/feed', { merge, key: 'id', max: 50 });
  const off = stream.subscribe(() => {});
  await ticks(); await deliverToServer(1, 'attach'); await deliverToClient();
  await until(() => read);
  if (merge === 'latest') {
   emit(topic, { event: 'push', data: { id: 7 }, seq: 7 });
   emit(topic, { event: 'push', data: { id: 8 }, seq: 8 });
  } else if (merge === 'set') emit(topic, { event: 'set', data: { owner: 'carol' }, seq: 8 });
  else emit(topic, { event: 'deleted', data: { id: 7 }, seq: 8 });
  gate.resolve();
  await until(() => net.toClient.some(frame => frame.data?.ok && !frame.data.attach));
  await deliverToClient();
  // A loader read and replay watermark are not an atomic snapshot. Keeping
  // every frame preserves live changes; an unkeyed ring can repeat a row.
  expect(get(stream)).toEqual(merge === 'latest' ? [{ id: 7 }, { id: 7 }, { id: 8 }] : merge === 'set' ? { owner: 'carol' } : []);
  off(); await ticks(); await deliverToServer();
 });
});
