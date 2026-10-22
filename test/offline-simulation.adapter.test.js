import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// The real adapter client over a scripted WebSocket: simulateOffline() and
// resumeOnline() reach the adapter's own pause, and the realtime client sees
// it as a dropped network.

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

	close(code = 1000, reason = '') {
		if (this.readyState === MockWebSocket.CLOSED) return;
		this.readyState = MockWebSocket.CLOSED;
		queueMicrotask(() => this.onclose?.({ code, reason }));
	}

	frames() {
		return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d)).flatMap((f) => f.batch || [f]);
	}

	receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const savedWebSocket = globalThis.WebSocket;
const savedWindow = globalThis.window;
let adapter, client;

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
	adapter.connect().close();
});

afterAll(() => {
	globalThis.WebSocket = savedWebSocket;
	if (savedWindow === undefined) delete globalThis.window;
	else globalThis.window = savedWindow;
});

describe('simulateOffline() and resumeOnline() (real adapter)', () => {
	it('queues and persists a call while paused, then restores the stream and replays the call on resume', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = client.createMemoryStore();
		client.configure({ offline: { queue: true, persist: store, persistKey: 'user-1' } });
		const statuses = [];
		const offStatus = client.status.subscribe((s) => statuses.push(s));
		const items = client.__stream('items/list', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = items.subscribe((v) => values.push(v));
		await tick();
		const first = sockets()[0];
		answer(first, rpcFrames(first).find((f) => f.rpc === 'items/list'), { ok: true, data: [{ id: 1 }], topic: 'items', merge: 'crud', key: 'id' });
		await tick();
		expect(values.at(-1)).toEqual([{ id: 1 }]);

		client.simulateOffline();
		await tick();
		expect(statuses.at(-1)).toBe('disconnected');
		expect(first.readyState).toBe(MockWebSocket.CLOSED);

		const saved = client.__rpc('items/add')({ id: 2 });
		let pendingCount;
		client.pendingMutations.subscribe((n) => { pendingCount = n; })();
		expect(pendingCount).toBe(1);
		await tick();
		const rows = await store.getAll('');
		expect(rows.some((row) => JSON.stringify(row.value).includes('items/add'))).toBe(true);
		// Paused: nothing reconnects, however long it waits.
		await new Promise((r) => setTimeout(r, 50));
		expect(sockets()).toHaveLength(1);

		client.resumeOnline();
		await tick();
		await tick();
		expect(sockets()).toHaveLength(2);
		const second = sockets()[1];
		// The stream resubscribes after its reconnect jitter.
		let resubscribe;
		for (let i = 0; i < 50 && !resubscribe; i++) {
			await new Promise((r) => setTimeout(r, 10));
			resubscribe = rpcFrames(second).find((f) => f.rpc === 'items/list');
		}
		expect(resubscribe).toBeTruthy();
		answer(second, resubscribe, { ok: true, data: [{ id: 1 }, { id: 3 }], topic: 'items', merge: 'crud', key: 'id' });
		await tick();
		expect(values.at(-1)).toEqual([{ id: 1 }, { id: 3 }]);
		second.receive({ topic: 'items', event: 'created', data: { id: 4 } });
		expect(values.at(-1)).toEqual([{ id: 1 }, { id: 3 }, { id: 4 }]);

		// The queued call replays on the new socket with its idempotency key.
		let replay;
		for (let i = 0; i < 10 && !replay; i++) {
			await tick();
			replay = rpcFrames(second).find((f) => f.rpc === 'items/add');
		}
		expect(replay.args).toEqual([{ id: 2 }]);
		expect(typeof replay.idempotencyKey).toBe('string');
		answer(second, replay, { ok: true, data: 'added' });
		await expect(saved).resolves.toBe('added');
		await tick();
		client.pendingMutations.subscribe((n) => { pendingCount = n; })();
		expect(pendingCount).toBe(0);
		expect((await store.getAll('')).some((row) => JSON.stringify(row.value).includes('items/add'))).toBe(false);
		expect(statuses.filter((s) => s === 'failed')).toEqual([]);
		expect(warn.mock.calls.flat().join(' ')).not.toContain('Cloudflare');
		unsub();
		offStatus();
	});

	it('repeated calls are harmless and resume does nothing on a live connection', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const call = client.__rpc('warm/up')();
		await tick();
		answer(sockets()[0], rpcFrames(sockets()[0])[0], { ok: true, data: 'ok' });
		await call;
		client.resumeOnline();
		await tick();
		expect(sockets()).toHaveLength(1);
		client.simulateOffline();
		client.simulateOffline();
		await tick();
		client.resumeOnline();
		client.resumeOnline();
		await tick();
		await tick();
		expect(sockets()).toHaveLength(2);
		// Pausing a socket that just opened, again and again, is not the
		// proxy symptom the fast-close diagnostic looks for.
		for (let i = 0; i < 3; i++) {
			client.simulateOffline();
			await tick();
			client.resumeOnline();
			await tick();
			await tick();
		}
		expect(sockets()).toHaveLength(5);
		expect(warn.mock.calls.flat().join(' ')).not.toContain('Cloudflare');
	});
});
