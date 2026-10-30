// A relay-gap marker on __replay:<topic> makes a mounted stream re-snapshot
// its topic. Driven through the real adapter client over a mock WebSocket.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	/** @type {MockWebSocket[]} */
	static sockets = [];

	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		/** @type {any[]} */
		this.sent = [];
		MockWebSocket.sockets.push(this);
		queueMicrotask(() => {
			if (this.readyState !== MockWebSocket.CONNECTING) return;
			this.readyState = MockWebSocket.OPEN;
			this.onopen?.();
		});
	}

	send(data) { this.sent.push(data); }

	/** The client closes the socket: as in a browser, the close event comes later. */
	close(code = 1000, reason = '') {
		if (this.readyState === MockWebSocket.CLOSED) return;
		this.readyState = MockWebSocket.CLOSED;
		queueMicrotask(() => this.onclose?.({ code, reason }));
	}

	/** The server or the network closes the socket. */
	serverClose(code, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	/** Text frames the client sent, parsed. */
	frames() {
		return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
	}

	receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}


const savedWebSocket = globalThis.WebSocket;
const savedWindow = globalThis.window;

/** @type {any} */
let adapter;
/** @type {any} */
let client;
/** @type {any} */
let runtime;

const tick = () => new Promise((r) => setTimeout(r, 0));
const rpcFrames = (ws) => ws.frames().filter((f) => f.rpc !== undefined);
const subscribes = (ws, path) => rpcFrames(ws).filter((f) => f.rpc === path && f.stream === true);
const answer = (ws, frame, data) => ws.receive({ topic: '__rpc', event: frame.id, data });

beforeEach(async () => {
	vi.resetModules();
	MockWebSocket.sockets = [];
	globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
	globalThis.window = /** @type {any} */ ({
		location: { protocol: 'http:', host: 'localhost:5173' },
		addEventListener() {},
		removeEventListener() {}
	});
	adapter = await import('svelte-adapter-uws/client');
	client = await import('../src/client.js');
	runtime = await import('../src/client-runtime.js');
});

afterEach(() => {
	vi.useRealTimers();
	runtime.resetRuntimeEnv();
	adapter.connect().close();
});

afterAll(() => {
	globalThis.WebSocket = savedWebSocket;
	if (savedWindow === undefined) delete globalThis.window;
	else globalThis.window = savedWindow;
});

/** Mount a stream on 'items' and load it with a resume cursor at seq 7. */
async function loadedStream() {
	const store = client.__stream('items/list', { merge: 'crud', key: 'id' });
	let value;
	const off = store.subscribe((v) => { value = v; });
	await tick();
	await tick();
	const ws = MockWebSocket.sockets[0];
	answer(ws, subscribes(ws, 'items/list')[0], { ok: true, data: [{ id: 1 }], topic: 'items', merge: 'crud', key: 'id', seq: 7 });
	await tick();
	expect(value).toEqual([{ id: 1 }]);
	return { ws, off, value: () => value };
}

const gap = (ws, j) => ws.receive(j === undefined
	? { topic: '__replay:items', event: 'gap', data: { lost: 3 } }
	: { topic: '__replay:items', event: 'gap', data: { lost: 3 }, j });

describe('relay gap markers', () => {
	it('re-snapshot the topic without an application handler and converge on the server state', async () => {
		const { ws, off, value } = await loadedStream();
		expect(subscribes(ws, 'items/list')).toHaveLength(1);
		gap(ws);
		gap(ws);
		await tick();
		const again = subscribes(ws, 'items/list');
		// Two markers before the re-snapshot went out: one re-snapshot.
		expect(again).toHaveLength(2);
		// A full snapshot: the resume cursor is no longer trusted.
		expect(again[1].seq).toBeUndefined();
		answer(ws, again[1], { ok: true, data: [{ id: 1 }, { id: 2 }, { id: 3 }], topic: 'items', merge: 'crud', key: 'id', seq: 10 });
		await tick();
		expect(value()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		// Live frames apply again after the re-snapshot.
		ws.receive({ topic: 'items', event: 'created', data: { id: 4 }, seq: 11 });
		await tick();
		expect(value()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
		off();
	});

	it('reloads authoritative state for an external change-source gap marker', async () => {
		const { ws, off } = await loadedStream();
		runtime.setRuntimeEnv({ rng: { float: () => 0 } });
		ws.receive({ topic: 'items', event: '__realtime.gap', data: { source: 'postgres-notify', reason: 'reconnect' }, j: 1000 });
		await tick();
		const resumed = subscribes(ws, 'items/list');
		expect(resumed).toHaveLength(2);
		expect(resumed[1].seq).toBeUndefined();
		off();
	});

	it('a marker that arrives after the re-snapshot was requested gets its own', async () => {
		const { ws, off } = await loadedStream();
		gap(ws);
		await tick();
		expect(subscribes(ws, 'items/list')).toHaveLength(2);
		gap(ws);
		await tick();
		const all = subscribes(ws, 'items/list');
		expect(all).toHaveLength(3);
		expect(all[2].seq).toBeUndefined();
		off();
	});

	it('stagger the re-snapshot inside the marker window and collapse the markers in it', async () => {
		const { ws, off } = await loadedStream();
		runtime.setRuntimeEnv({ rng: { float: () => 0.5 } });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		gap(ws, 1000);
		await vi.advanceTimersByTimeAsync(200);
		gap(ws, 1000);
		// A live frame inside the window moves the cursor past the hole again.
		ws.receive({ topic: 'items', event: 'created', data: { id: 2 }, seq: 8 });
		await vi.advanceTimersByTimeAsync(299);
		expect(subscribes(ws, 'items/list')).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(subscribes(ws, 'items/list')).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(subscribes(ws, 'items/list')).toHaveLength(2);
		expect(subscribes(ws, 'items/list')[1].seq).toBeUndefined();
		off();
	});

	it('a released stream does not re-snapshot, and a marker seen earlier is not replayed to it', async () => {
		const { ws, off } = await loadedStream();
		// Another listener keeps the adapter's store for the marker topic, and
		// with it the last marker, alive across the release.
		const holder = adapter.on('__replay:items').subscribe(() => {});
		runtime.setRuntimeEnv({ rng: { float: () => 0.5 } });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		gap(ws, 1000);
		off();
		await vi.advanceTimersByTimeAsync(1000);
		expect(subscribes(ws, 'items/list')).toHaveLength(1);
		// Subscribed again: one resume, which asks for a full snapshot since
		// the marker arrived after the last one.
		const store = client.__stream('items/list', { merge: 'crud', key: 'id' });
		const off2 = store.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		const resumed = subscribes(ws, 'items/list');
		expect(resumed).toHaveLength(2);
		expect(resumed[1].seq).toBeUndefined();
		answer(ws, resumed[1], { ok: true, data: [{ id: 1 }], topic: 'items', merge: 'crud', key: 'id', seq: 12 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(subscribes(ws, 'items/list')).toHaveLength(2);
		off2();
		holder();
	});

	// The frames a gap lost can be deletes as well as writes: the re-snapshot
	// has to replace the view, not merge into it.
	it('a re-snapshot replaces the view, so a row deleted inside the gap disappears', async () => {
		const { ws, off, value } = await loadedStream();
		ws.receive({ topic: 'items', event: 'created', data: { id: 2 }, seq: 8 });
		await tick();
		expect(value()).toEqual([{ id: 1 }, { id: 2 }]);
		// Lost: seq 9 deleted 2, seq 10 created 3.
		gap(ws);
		await tick();
		const again = subscribes(ws, 'items/list');
		expect(again).toHaveLength(2);
		expect(again[1].seq).toBeUndefined();
		answer(ws, again[1], { ok: true, data: [{ id: 1 }, { id: 3 }], topic: 'items', merge: 'crud', key: 'id', seq: 10 });
		await tick();
		expect(value()).toEqual([{ id: 1 }, { id: 3 }]);
		// The next resume gap-fills from the snapshot's cursor.
		ws.receive({ topic: 'items', event: 'updated', data: { id: 3, v: 1 }, seq: 11 });
		await tick();
		expect(value()).toEqual([{ id: 1 }, { id: 3, v: 1 }]);
		off();
	});

	it('a reordered live frame for another row applies, and a repeated one re-snapshots', async () => {
		const { ws, off, value } = await loadedStream();
		runtime.setRuntimeEnv({ rng: { float: () => 0 } });
		ws.receive({ topic: 'items', event: 'created', data: { id: 2, v: 0 }, seq: 8 });
		// Two publishers' frames crossing on a cluster relay: seq 10 lands before 9.
		ws.receive({ topic: 'items', event: 'updated', data: { id: 1, v: 2 }, seq: 10 });
		ws.receive({ topic: 'items', event: 'updated', data: { id: 2, v: 1 }, seq: 9 });
		await tick();
		expect(value()).toEqual([{ id: 1, v: 2 }, { id: 2, v: 1 }]);
		expect(subscribes(ws, 'items/list')).toHaveLength(1);
		// A sequence seen again is a repeat or a restarted counter: not applied,
		// and the stream re-snapshots without its cursor.
		ws.receive({ topic: 'items', event: 'created', data: { id: 2, v: 0 }, seq: 8 });
		await tick();
		await tick();
		expect(value()).toEqual([{ id: 1, v: 2 }, { id: 2, v: 1 }]);
		const again = subscribes(ws, 'items/list');
		expect(again).toHaveLength(2);
		expect(again[1].seq).toBeUndefined();
		off();
	});

	it('a presence roster drops duplicate and overtaken updates and re-snapshots a lost leave away', async () => {
		const store = client.__stream('room/presence', { merge: 'presence' });
		let value;
		const off = store.subscribe((v) => { value = v; });
		await tick();
		await tick();
		const ws = MockWebSocket.sockets[0];
		answer(ws, subscribes(ws, 'room/presence')[0], {
			ok: true, data: [{ key: 'a', typing: false }, { key: 'b', typing: false }], topic: 'room', merge: 'presence', seq: 1
		});
		await tick();
		const update = (n, typing) => ws.receive({ topic: 'room', event: 'update', data: { key: 'b', typing, _p: 'pb', _n: n } });
		update(2, true);
		update(2, false);
		update(1, false);
		await tick();
		expect(value).toEqual([{ key: 'a', typing: false }, { key: 'b', typing: true }]);
		// Lost: b left, c joined.
		ws.receive({ topic: '__replay:room', event: 'gap', data: { lost: 2 } });
		await tick();
		const again = subscribes(ws, 'room/presence');
		expect(again).toHaveLength(2);
		expect(again[1].seq).toBeUndefined();
		answer(ws, again[1], { ok: true, data: [{ key: 'a', typing: false }, { key: 'c', typing: false }], topic: 'room', merge: 'presence', seq: 4 });
		await tick();
		expect(value).toEqual([{ key: 'a', typing: false }, { key: 'c', typing: false }]);
		off();
	});

	it('a re-snapshot answered from the buffer starts the frame order over', async () => {
		// A flag stream's subscribe without a cursor is answered from its
		// one-entry buffer, as a replay. The buffer restarted, so the order kept
		// from the old sequence must not hold back the new one.
		const store = client.__stream('mode/state', { merge: 'set' });
		let value;
		const off = store.subscribe((v) => { value = v; });
		await tick();
		await tick();
		const ws = MockWebSocket.sockets[0];
		answer(ws, subscribes(ws, 'mode/state')[0], { ok: true, data: { mode: 'a' }, topic: 'mode', merge: 'set', seq: 400 });
		await tick();
		ws.receive({ topic: 'mode', event: 'set', data: { mode: 'b' }, seq: 401 });
		ws.receive({ topic: '__replay:mode', event: 'gap', data: { lost: 1 } });
		await tick();
		const again = subscribes(ws, 'mode/state');
		expect(again).toHaveLength(2);
		expect(again[1].seq).toBeUndefined();
		answer(ws, again[1], { ok: true, data: [{ event: 'set', data: { mode: 'c' }, seq: 2 }], topic: 'mode', merge: 'set', seq: 2, replay: true });
		await tick();
		expect(value).toEqual({ mode: 'c' });
		ws.receive({ topic: 'mode', event: 'set', data: { mode: 'd' }, seq: 3 });
		await tick();
		expect(value).toEqual({ mode: 'd' });
		expect(subscribes(ws, 'mode/state')).toHaveLength(2);
		off();
	});

	it('a set stream takes the re-snapshot value over a value the gap made stale', async () => {
		const store = client.__stream('flag/state', { merge: 'set' });
		let value;
		const off = store.subscribe((v) => { value = v; });
		await tick();
		await tick();
		const ws = MockWebSocket.sockets[0];
		answer(ws, subscribes(ws, 'flag/state')[0], { ok: true, data: { mode: 'a' }, topic: 'flag', merge: 'set', seq: 3 });
		await tick();
		ws.receive({ topic: '__replay:flag', event: 'gap', data: { lost: 1 } });
		await tick();
		const again = subscribes(ws, 'flag/state');
		expect(again).toHaveLength(2);
		expect(again[1].seq).toBeUndefined();
		answer(ws, again[1], { ok: true, data: { mode: 'c' }, topic: 'flag', merge: 'set', seq: 5 });
		await tick();
		expect(value).toEqual({ mode: 'c' });
		off();
	});
});
