import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { writable, readable } from 'svelte/store';

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	/** @type {MockWebSocket[]} */
	static sockets = [];
	static autoOpen = true;

	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		/** @type {any[]} */
		this.sent = [];
		MockWebSocket.sockets.push(this);
		queueMicrotask(() => { if (MockWebSocket.autoOpen) this.open(); });
	}

	open() {
		if (this.readyState !== MockWebSocket.CONNECTING) return;
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.();
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
	MockWebSocket.autoOpen = false;
	globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
	globalThis.window = /** @type {any} */ ({
		location: { protocol: 'http:', host: 'localhost:5173' },
		addEventListener() {},
		removeEventListener() {}
	});
	adapter = await import('svelte-adapter-uws/client');
	client = await import('../src/client.js');
	adapter.connect({ reconnectInterval: 1, maxReconnectInterval: 1 });
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
	sockets()[0].open();
	await tick();
	const ws = sockets()[0];
	answer(ws, rpcFrames(ws)[0], { ok: true, data: 'ok' });
	await expect(call).resolves.toBe('ok');
	return ws;
}

const until = async (condition) => {
	for (let i = 0; i < 200 && !condition(); i++) await tick();
	expect(condition()).toBe(true);
};
const calls = {
	regular: () => client.__rpc('save')('value'),
	fresh: () => client.__rpc('save').fresh('value'),
	options: () => client.__rpc('save').with({ idempotencyKey: 'same' })('value'),
	singleBatch: () => client.batch(() => [client.__rpc('save')('value')]),
	batch: () => client.batch(() => [client.__rpc('save')('one'), client.__rpc('save')('two')]),
	binary: () => client.__binaryRpc('save')(new Uint8Array([1]))
};
const sentRequests = ws => ws.sent.filter(frame => typeof frame !== 'string' || JSON.parse(frame).rpc || JSON.parse(frame).batch);
const answerRequests = ws => {
	for (const frame of sentRequests(ws)) {
		if (typeof frame !== 'string') {
			const bytes = new Uint8Array(frame);
			const header = JSON.parse(new TextDecoder().decode(bytes.subarray(3, 3 + (bytes[1] << 8) + bytes[2])));
			answer(ws, header, { ok: true, data: 'ok' });
		} else {
			const request = JSON.parse(frame);
			if (request.batch) ws.receive({ topic: '__rpc', event: '__batch', data: { batch: request.batch.map(call => ({ id: call.id, ok: true, data: 'ok' })) } });
			else answer(ws, request, { ok: true, data: 'ok' });
		}
	}
};

describe('RPC frame ownership with the real adapter', () => {
	for (const [kind, call] of Object.entries(calls)) {
		it(`${kind} never sends after rejecting a call made while the socket is closing`, async () => {
			const ws = await openWithRpc();
			MockWebSocket.autoOpen = true;
			ws.sent.length = 0;
			ws.readyState = MockWebSocket.CLOSING;
			const promise = call();
			const rejected = expect(promise).rejects.toMatchObject({ code: 'DISCONNECTED' });
			ws.serverClose(1006);
			await rejected;
			await until(() => sockets().length === 2 && sockets()[1].readyState === MockWebSocket.OPEN);
			expect(sentRequests(ws)).toEqual([]);
			expect(sentRequests(sockets()[1])).toEqual([]);
		});
		it(`${kind} waits through an initial failed connection and sends once on open`, async () => {
			MockWebSocket.autoOpen = false;
			const promise = call();
			let settled = false;
			promise.then(() => { settled = true; }, () => { settled = true; });
			const first = sockets()[0];
			first.serverClose(1006);
			await until(() => sockets().length === 2);
			expect(settled).toBe(false);
			const second = sockets()[1];
			second.open();
			expect(sentRequests(second)).toHaveLength(1);
			answerRequests(second);
			await promise;
			expect(settled).toBe(true);
		});
	}
	it('removes a timed out unsent call before the first open', async () => {
		MockWebSocket.autoOpen = false;
		const promise = client.__rpc('save').with({ timeout: 10 })('value');
		await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
		sockets()[0].open();
		expect(sentRequests(sockets()[0])).toEqual([]);
	});
});
