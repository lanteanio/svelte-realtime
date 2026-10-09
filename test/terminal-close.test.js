// A connection closed for good, driven through the real adapter client: its
// connect(), close(), status store and terminal close codes, over a mock
// WebSocket. Every adapter path that reports 'failed' also drops the
// connection for good, and after close() anything that reaches the adapter's
// connect(), on() or status would build a new connection, so each test counts
// the sockets the client opened.

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

describe('connection closed for good (real adapter client)', () => {
	it('close() rejects the RPC in flight and every later call, opening no socket', async () => {
		const ws = await openWithRpc();
		const rpc = client.__rpc('chat/send');
		const inFlight = rpc('hi');
		await tick();
		expect(rpcFrames(ws).map((f) => f.rpc)).toContain('chat/send');
		const bound = adapter.connect();
		const sendQueued = vi.spyOn(bound, 'sendQueued');

		bound.close();
		await expect(inFlight).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await expect(rpc('again')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await expect(client.batch(() => [rpc('a'), rpc('b')])).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		rpc.fireAndForget('volatile');
		rpc.send('reliable');
		await tick();

		expect(sockets()).toHaveLength(1);
		expect(sendQueued).not.toHaveBeenCalled();
	});

	it('a terminal close code from the server ends the client the same way', async () => {
		const ws = await openWithRpc();
		const inFlight = client.__rpc('chat/send')('hi');
		await tick();

		ws.serverClose(4401, 'session expired');
		await expect(inFlight).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await expect(client.__rpc('chat/send')('again')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
	});

	it('the drop that uses up the last reconnect attempt ends the client after rejecting with DISCONNECTED', async () => {
		// Options only apply to the connection that creates the singleton.
		adapter.connect({ maxReconnectAttempts: 0 });
		const { pending } = await import('../src/client/internal-state.js');
		const ws = await openWithRpc();
		const inFlight = client.__rpc('chat/send')('hi');
		const store = client.__stream('board/items', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await tick();
		expect(pending.size).toBe(2);

		// A plain drop: 'disconnected', then 'failed' in the same tick.
		ws.serverClose(1006, 'network');
		await expect(inFlight).rejects.toMatchObject({ code: 'DISCONNECTED' });
		await expect(client.__rpc('chat/send')('again')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await tick();
		// The stream subscribe the drop left unanswered is not kept.
		expect(pending.size).toBe(0);
		unsub();
	});

	it('a live stream keeps its data and shows CONNECTION_CLOSED', async () => {
		const ws = await openWithRpc();
		const { values, errors, unsub } = await loadedStream(ws, 'board/items', 'board:1');
		expect(values.at(-1)).toEqual([{ id: 1 }]);

		adapter.connect().close();
		expect(values.at(-1)).toEqual([{ id: 1 }]);
		expect(errors.filter(Boolean).map((e) => e.code)).toEqual(['CONNECTION_CLOSED']);
		unsub();
	});

	it('releasing a stream after close() sends nothing and opens no socket', async () => {
		const ws = await openWithRpc();
		const { unsub } = await loadedStream(ws, 'board/items', 'board:2');
		const bound = adapter.connect();
		const send = vi.spyOn(bound, 'send');
		bound.close();

		unsub();
		await tick();
		expect(sockets()).toHaveLength(1);
		expect(send).not.toHaveBeenCalled();
	});

	it('a stream mounted after close() shows CONNECTION_CLOSED and opens no socket', async () => {
		await openWithRpc();
		adapter.connect().close();

		const store = client.__stream('board/items', { merge: 'crud', key: 'id' });
		let error = null;
		store.error.subscribe((e) => { error = e; });
		const unsub = store.subscribe(() => {});
		await tick();
		expect(error?.code).toBe('CONNECTION_CLOSED');
		unsub();
		await tick();
		expect(sockets()).toHaveLength(1);
	});

	// configure() is the only thing that touched the connection before the
	// close: every later call reaches the closed connection, never a new one.
	it.each([
		['an RPC', () => { client.__rpc('a/rpc')('x').catch(() => {}); }],
		['a binary RPC', () => { client.__binaryRpc('a/bin')(new ArrayBuffer(4)).catch(() => {}); }],
		['a batch', () => { client.batch(() => [client.__rpc('a/batch')('x')]).catch(() => {}); }],
		['a stream mount', () => { client.__stream('a/stream', { merge: 'crud', key: 'id' }).subscribe(() => {})(); }],
		['an upload', () => { client.__upload('a/upload')(new ArrayBuffer(4)).catch(() => {}); }],
		['onSignal', () => { client.onSignal('user-1', () => {})(); }],
		['onPush', () => { client.onPush('evt', () => {})(); }],
		['the health store', () => { client.health.subscribe(() => {})(); }],
		['the status store', () => {
			let s;
			client.status.subscribe((v) => { s = v; })();
			expect(s).toBe('failed');
		}],
		['the failure store', () => { client.failure.subscribe(() => {})(); }],
		['onDerived', () => { client.onDerived((id) => 'room:' + id, readable('a')).subscribe(() => {})(); }],
		['configure() with a url', () => { client.configure({ url: 'ws://localhost:5173/ws' }); }]
	])('%s after close() opens no socket', async (_name, call) => {
		client.configure({ timeout: 5_000 });
		await tick();
		expect(sockets()).toHaveLength(1);
		adapter.connect().close();

		call();
		await tick();
		expect(sockets()).toHaveLength(1);
	});

	it('an onDisconnect callback that calls an RPC already sees the connection closed', async () => {
		/** @type {Promise<any>[]} */
		const calls = [];
		let n = 0;
		client.configure({ onDisconnect() { calls.push(client.__rpc('session/bye')(++n)); } });
		await openWithRpc();
		const bound = adapter.connect();
		const sendQueued = vi.spyOn(bound, 'sendQueued');

		bound.close();
		expect(sockets()).toHaveLength(1);
		expect(calls).toHaveLength(1);
		await expect(calls[0]).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(sendQueued).not.toHaveBeenCalled();
	});

	it('code reacting to the error of a stream that was loading gets CONNECTION_CLOSED and sends nothing', async () => {
		await openWithRpc();
		const store = client.__stream('board/items', { merge: 'crud', key: 'id' });
		/** @type {Promise<any>[]} */
		const calls = [];
		store.error.subscribe((e) => { if (e) calls.push(client.__rpc('log/error')(e.code)); });
		const unsub = store.subscribe(() => {});
		await tick();
		expect(calls).toHaveLength(0);
		const bound = adapter.connect();
		const sendQueued = vi.spyOn(bound, 'sendQueued');

		bound.close();
		expect(sockets()).toHaveLength(1);
		expect(calls).toHaveLength(1);
		await expect(calls[0]).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(sendQueued).not.toHaveBeenCalled();
		unsub();
	});

	// Store subscribers notified while 'failed' is dispatched run after it (the
	// svelte/store queue), but an upload's event listeners are called on the spot.
	it('an upload error listener that makes a call already sees the connection closed', async () => {
		await openWithRpc();
		const handle = client.__upload('files/put')(new Uint8Array([1, 2, 3]).buffer);
		handle.catch(() => {});
		/** @type {string | null} */
		let code = null;
		handle.on('error', () => {
			client.__rpc('log/upload')('failed').catch((/** @type {any} */ e) => { code = e.code; });
		});
		await tick();

		adapter.connect().close();
		await tick();
		await expect(handle).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(code).toBe('CONNECTION_CLOSED');
		expect(sockets()).toHaveLength(1);
	});

	it('a call made while a close() inside a store update is still being delivered opens no socket', async () => {
		await openWithRpc();
		const session = writable(/** @type {string | null} */ ('alice'));
		/** @type {Promise<any>[]} */
		const calls = [];
		session.subscribe((user) => { if (user === null) adapter.connect().close(); });
		// Runs in the same notification pass, before 'failed' reaches the client.
		session.subscribe((user) => { if (user === null) calls.push(client.__rpc('audit/logout')()); });

		session.set(null);
		expect(sockets()).toHaveLength(1);
		expect(calls).toHaveLength(1);
		await expect(calls[0]).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
	});

	it('configure() with a url while a close() inside a store update is still being delivered opens no socket', async () => {
		await openWithRpc();
		const session = writable(/** @type {string | null} */ ('alice'));
		session.subscribe((user) => { if (user === null) adapter.connect().close(); });
		// Runs in the same notification pass, before 'failed' reaches the client.
		session.subscribe((user) => { if (user === null) client.configure({ url: 'ws://localhost:5173/ws' }); });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			session.set(null);
			await tick();
			expect(sockets()).toHaveLength(1);
			expect(warn.mock.calls.some((c) => String(c[0]).includes('configure({ url, auth }) is ignored'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('a stream resumed from its grace window while a close() inside a store update is still being delivered never counts as in flight', async () => {
		const ws = await openWithRpc();
		const { store, errors, unsub } = await loadedStream(ws, 'board/grace', 'board');
		unsub();
		await tick();
		/** @type {boolean[]} */
		const settledSeen = [];
		client.quiescent.subscribe((v) => settledSeen.push(v));
		const session = writable(/** @type {string | null} */ ('alice'));
		/** @type {(() => void) | null} */
		let resumed = null;
		session.subscribe((user) => { if (user === null) adapter.connect().close(); });
		// Runs in the same notification pass, before 'failed' reaches the client.
		session.subscribe((user) => { if (user === null) resumed = store.subscribe(() => {}); });

		session.set(null);
		await tick();
		expect(settledSeen).not.toContain(false);
		expect(errors.filter(Boolean).map((e) => e.code)).toEqual(['CONNECTION_CLOSED']);
		expect(sockets()).toHaveLength(1);
		resumed?.();
	});

	it('an auth preflight the server refuses ends the client without opening a socket', async () => {
		const savedFetch = globalThis.fetch;
		globalThis.fetch = /** @type {any} */ (async () => ({ ok: false, status: 401, statusText: 'Unauthorized' }));
		try {
			client.configure({ auth: true });
			const call = client.__rpc('chat/send')('hi');
			await expect(call).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
			await expect(client.__rpc('chat/send')('again')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
			expect(sockets()).toHaveLength(0);
		} finally {
			globalThis.fetch = savedFetch;
		}
	});

	it('a call from an adapter status subscriber that runs before the client opens no socket', async () => {
		/** @type {Promise<any>[]} */
		const calls = [];
		adapter.status.subscribe((s) => { if (s === 'failed') calls.push(client.__rpc('audit/closed')()); });
		await openWithRpc();

		adapter.connect().close();
		expect(sockets()).toHaveLength(1);
		expect(calls).toHaveLength(1);
		await expect(calls[0]).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
	});

	it('creates its connection the way the adapter stores do, so connect() options passed later still warn', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await openWithRpc();
			adapter.connect({ path: '/other' });
			expect(warn.mock.calls.some((c) => String(c[0]).includes('connect() was called with options'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});
