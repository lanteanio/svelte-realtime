import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { writable, readable } from 'svelte/store';

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

const tick = () => new Promise((r) => setTimeout(r, 0));
const sockets = () => MockWebSocket.sockets;
const rpcFrames = (ws) => ws.frames().filter((f) => f.rpc !== undefined);
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
});

afterEach(() => {
	// Stops the adapter's timers. When the test already closed its connection
	// this builds and closes a fresh one, which is harmless.
	adapter.connect().close();
});

afterAll(() => {
	globalThis.WebSocket = savedWebSocket;
	if (savedWindow === undefined) delete globalThis.window;
	else globalThis.window = savedWindow;
});

/** Open the connection with one answered RPC, so the client is bound to it. */
async function openWithRpc() {
	const call = client.__rpc('warm/up')('x');
	await tick();
	const ws = sockets()[0];
	answer(ws, rpcFrames(ws)[0], { ok: true, data: 'ok' });
	await expect(call).resolves.toBe('ok');
	return ws;
}

/** Subscribe a stream and answer its subscribe with `topic`. */
async function loadedStream(ws, path, topic) {
	const store = client.__stream(path, { merge: 'crud', key: 'id' });
	const values = [];
	const errors = [];
	store.error.subscribe((e) => errors.push(e));
	const unsub = store.subscribe((v) => values.push(v));
	await tick();
	const sub = rpcFrames(ws).find((f) => f.rpc === path);
	answer(ws, sub, { ok: true, data: [{ id: 1 }], topic, merge: 'crud', key: 'id' });
	await tick();
	return { store, values, errors, unsub };
}


describe('explicit connection replacement (real adapter)', () => {
	it('revives RPCs without an implicit socket between close and connect', async () => {
		await openWithRpc();
		adapter.connect().close();
		await expect(client.__rpc('closed/call')()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(sockets()).toHaveLength(1);
		adapter.connect();
		const call = client.__rpc('new/call')();
		await tick();
		expect(sockets()).toHaveLength(2);
		const ws = sockets()[1];
		expect(rpcFrames(ws).map(f => f.rpc)).toContain('new/call');
		answer(ws, rpcFrames(ws).find(f => f.rpc === 'new/call'), { ok: true, data: 'new' });
		await expect(call).resolves.toBe('new');
	});

	it('recovers when close and connect happen inside another store notification', async () => {
		await openWithRpc();
		const trigger = writable(false);
		const off = trigger.subscribe(value => {
			if (!value) return;
			adapter.connect().close();
			adapter.connect();
		});
		trigger.set(true); off();
		const call = client.__rpc('sync/new')(); await tick();
		const ws = sockets()[1];
		answer(ws, rpcFrames(ws).find(f => f.rpc === 'sync/new'), { ok: true, data: 'recovered' });
		await expect(call).resolves.toBe('recovered');
	});

	it('reloads mounted streams and clears the terminal error', async () => {
		const old = await openWithRpc();
		const stream = await loadedStream(old, 'items/list', 'items');
		adapter.connect().close();
		expect(stream.errors.at(-1).code).toBe('CONNECTION_CLOSED');
		adapter.connect(); await tick();
		const ws = sockets()[1];
		await expect.poll(() => rpcFrames(ws).find(f => f.rpc === 'items/list')).toBeTruthy();
		answer(ws, rpcFrames(ws).find(f => f.rpc === 'items/list'), { ok: true, data: [{ id: 2 }], topic: 'items', merge: 'crud', key: 'id' });
		expect(stream.errors.at(-1)).toBeNull();
		ws.receive({ topic: 'items', event: 'created', data: { id: 3 } });
		await tick();
		expect(stream.values.at(-1)).toEqual([{ id: 2 }, { id: 3 }]);
		stream.unsub();
	});

	it('follows late signals, health, push handlers and stream listeners after close', async () => {
		await openWithRpc(); adapter.connect().close();
		const signal = vi.fn(), push = vi.fn(v => v + 1), connected = vi.fn();
		const offSignal = client.onSignal('user', signal), offPush = client.onPush('ask', push);
		let health; const offHealth = client.health.subscribe(v => { health = v; });
		client.configure({ onConnect: connected });
		const stream = client.__stream('late/list', { merge: 'set' });
		let error; const offError = stream.error.subscribe(v => { error = v; });
		const off = stream.subscribe(() => {});
		expect(error.code).toBe('CONNECTION_CLOSED');
		expect(sockets()).toHaveLength(1);
		adapter.connect(); await tick();
		const ws = sockets()[1];
		await expect.poll(() => rpcFrames(ws).find(f => f.rpc === 'late/list')).toBeTruthy();
		answer(ws, rpcFrames(ws).find(f => f.rpc === 'late/list'), { ok: true, data: [], topic: 'late', merge: 'set' });
		ws.receive({ topic: '__signal:user', event: 'notify', data: 5 });
		ws.receive({ topic: '__realtime', event: 'degraded', data: {} });
		ws.receive({ type: 'request', ref: 'r1', event: 'ask', data: 5 });
		await tick();
		expect(signal).toHaveBeenCalledWith('notify', 5);
		expect(health).toBe('degraded'); expect(push).toHaveBeenCalledWith(5);
		expect(connected).toHaveBeenCalled(); expect(error).toBeNull();
		off(); offError(); offSignal(); offPush(); offHealth();
	});

	it('does not create a socket when first accessed after an adapter close', async () => {
		adapter.connect(); await tick(); adapter.connect().close();
		await expect(client.__rpc('late/call')()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(sockets()).toHaveLength(1);
		adapter.connect(); const call = client.__rpc('late/call')(); await tick();
		const ws = sockets()[1]; answer(ws, rpcFrames(ws)[0], { ok: true, data: 9 });
		await expect(call).resolves.toBe(9);
	});
});
