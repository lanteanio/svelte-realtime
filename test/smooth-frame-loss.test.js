// Smoothed entities ride unsequenced frames that each carry an entity's whole
// state. A lost remove has no successor, so the entity stays until a resync,
// which must rebuild the remote set from the server's roster instead of
// merging into it. Runs the shipped view and the installed adapter channel
// over the adapter client and a scripted socket; the sync reply stands in for
// the server's roster.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { compileModule } from 'svelte/compiler';

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

	/** The network drops the socket. */
	serverClose(code, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const SHIPPED_RUNE_PATH = resolve(import.meta.dirname, '../src/client-smooth.svelte.js');
const runeProbeRoot = resolve(import.meta.dirname, '__smooth_frame_loss_rune__');
let probeCounter = 0;

/** Compile the shipped view with its health and devtools imports stubbed. */
async function loadSmoothEntity() {
	mkdirSync(runeProbeRoot, { recursive: true });
	const probeDir = mkdtempSync(resolve(runeProbeRoot, 'probe-'));
	writeFileSync(resolve(probeDir, 'client.js'), 'export function _setSmoothDegraded() {}\n');
	mkdirSync(resolve(probeDir, 'client'), { recursive: true });
	writeFileSync(resolve(probeDir, 'client', 'devtools-instrument.js'), 'export function _devtoolsSmoothRegister() { return () => {}; }\n');
	const { js } = compileModule(readFileSync(SHIPPED_RUNE_PATH, 'utf8'), { filename: 'client-smooth.svelte.js', generate: 'client' });
	const out = resolve(probeDir, 'client-smooth.js');
	writeFileSync(out, js.code);
	return (await import(pathToFileURL(out).href + '?t=' + ++probeCounter)).SmoothEntity;
}

const savedWebSocket = globalThis.WebSocket;
const savedWindow = globalThis.window;

/** @type {any} */
let adapter;
/** @type {any} */
let createSmoothChannel;
/** @type {any} */
let SmoothEntity;
/** @type {any} */
let view;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}

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
	({ createSmoothChannel } = await import('svelte-adapter-uws/plugins/smooth/client'));
	SmoothEntity ??= await loadSmoothEntity();
	adapter.connect({ reconnectInterval: 20, maxReconnectInterval: 50 });
});

afterEach(() => {
	view?.destroy();
	view = null;
	adapter.connect().close();
});

afterAll(() => {
	globalThis.WebSocket = savedWebSocket;
	if (savedWindow === undefined) delete globalThis.window;
	else globalThis.window = savedWindow;
	if (existsSync(runeProbeRoot)) rmSync(runeProbeRoot, { recursive: true, force: true });
});

const TOPIC = '__smooth:arena';

/** A view whose sync reply is the `roster` the test holds as the server's. */
async function mountView(roster) {
	const server = { roster, syncs: 0 };
	const channel = createSmoothChannel({
		apply: (state) => state,
		initial: { x: 0, y: 0 },
		transport: {
			sendCommand() {},
			sync: async () => {
				server.syncs++;
				return { topic: 'arena', t: Date.now(), you: 'me', ack: 0, states: server.roster.map((e) => ({ ...e })) };
			}
		}
	});
	view = new SmoothEntity(channel, adapter.status);
	await until(() => server.syncs > 0 && view.remote.size === roster.length, 'the first sync');
	return { server, ws: MockWebSocket.sockets[0] };
}

const update = (ws, key, state) => ws.receive({ topic: TOPIC, event: 'update', data: { key, data: state }, t: Date.now() });

describe('smoothed entities after a lost remove', () => {
	it('a resync drops an entity whose remove was lost', async () => {
		const { server, ws } = await mountView([{ key: 'ann', state: { x: 0, y: 0 } }]);
		update(ws, 'bob', { x: 5, y: 5 });
		await until(() => view.remote.has('bob'), 'bob to appear');
		// bob left; the remove never arrived.
		server.roster = [{ key: 'ann', state: { x: 0, y: 0 } }];
		await sleep(40);
		expect(view.remote.has('bob')).toBe(true);
		view.resync();
		await until(() => !view.remote.has('bob'), 'the resync to drop bob');
		expect([...view.remote.keys()]).toEqual(['ann']);
	});

	it('a reconnect rebuilds the remote set from the roster, not on top of the old one', async () => {
		const { server, ws } = await mountView([{ key: 'ann', state: { x: 0, y: 0 } }]);
		update(ws, 'bob', { x: 5, y: 5 });
		await until(() => view.remote.has('bob'), 'bob to appear');
		// While the socket is down bob leaves and cat joins.
		ws.serverClose(1006);
		server.roster = [{ key: 'ann', state: { x: 0, y: 0 } }, { key: 'cat', state: { x: 2, y: 2 } }];
		await until(() => MockWebSocket.sockets.length === 2 && server.syncs >= 2, 'the reconnect sync');
		await until(() => view.remote.has('cat'), 'cat to appear');
		await sleep(40);
		expect([...view.remote.keys()].sort()).toEqual(['ann', 'cat']);
	});
});
