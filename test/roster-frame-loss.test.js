// The multiplayer roster views (`others`, `cursors`) read the room's presence
// and cursor streams. A repeated or overtaken frame must not change what they
// show, and a lost one must not leave a departed member or a ghost cursor
// behind: the relay gap marker re-snapshots each stream and the views take the
// replacement. Runs the real stream client and the installed adapter client
// over a scripted socket, with the shipped room rune compiled for the browser.

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

const SHIPPED_RUNE_PATH = resolve(import.meta.dirname, '../src/client-multiplayer.svelte.js');
const SHIPPED_COLOR_PATH = resolve(import.meta.dirname, '../src/shared/color.js');
const SVELTE_CLIENT_REACTIVITY = pathToFileURL(resolve(import.meta.dirname, '..', 'node_modules', 'svelte', 'src', 'reactivity', 'index-client.js')).href;
const SVELTE_CLIENT_INDEX = pathToFileURL(resolve(import.meta.dirname, '..', 'node_modules', 'svelte', 'src', 'index-client.js')).href;
const runeProbeRoot = resolve(import.meta.dirname, '__roster_frame_loss_rune__');
let probeCounter = 0;

/** Compile the shipped room rune for the browser and import it. */
async function loadRoomRune() {
	mkdirSync(runeProbeRoot, { recursive: true });
	const probeDir = mkdtempSync(resolve(runeProbeRoot, 'probe-'));
	writeFileSync(resolve(probeDir, 'color.js'), readFileSync(SHIPPED_COLOR_PATH, 'utf8'));
	const source = readFileSync(SHIPPED_RUNE_PATH, 'utf8')
		.replace(/(['"])\.\/shared\/color\.js\1/g, "'./color.js'")
		.replace(/(['"])\.\/client\.js\1/g, JSON.stringify(pathToFileURL(resolve(SHIPPED_RUNE_PATH, '..', 'client.js')).href));
	const { js } = compileModule(source, { filename: 'client-multiplayer.svelte.js', generate: 'client' });
	const out = resolve(probeDir, 'client-multiplayer.js');
	writeFileSync(out, js.code
		.replace(/(['"])svelte\/reactivity\1/g, JSON.stringify(SVELTE_CLIENT_REACTIVITY))
		.replace(/from (['"])svelte\1/g, 'from ' + JSON.stringify(SVELTE_CLIENT_INDEX)));
	return (await import(pathToFileURL(out).href + '?t=' + ++probeCounter)).MultiplayerRoom;
}

const savedWebSocket = globalThis.WebSocket;
const savedWindow = globalThis.window;

/** @type {any} */
let adapter;
/** @type {any} */
let client;
/** @type {any} */
let MultiplayerRoom;

const tick = () => new Promise((r) => setTimeout(r, 0));
const subscribes = (ws, path) => ws.frames().filter((f) => f.rpc === path && f.stream === true);
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
	MultiplayerRoom ??= await loadRoomRune();
});

afterEach(() => {
	adapter.connect().close();
});

afterAll(() => {
	globalThis.WebSocket = savedWebSocket;
	if (savedWindow === undefined) delete globalThis.window;
	else globalThis.window = savedWindow;
	if (existsSync(runeProbeRoot)) rmSync(runeProbeRoot, { recursive: true, force: true });
});

/** A room view over real presence and cursor streams, both loaded. */
async function loadedRoom(presence, cursors) {
	const room = new MultiplayerRoom({
		me: 'me',
		presence: client.__stream('board/__presence', { merge: 'presence' }),
		cursors: client.__stream('board/__cursors', { merge: 'cursor' }),
		status: client.status,
		move: () => {}
	});
	await tick();
	await tick();
	const ws = MockWebSocket.sockets[0];
	answer(ws, subscribes(ws, 'board/__presence')[0], { ok: true, data: presence, topic: 'board:presence', merge: 'presence' });
	answer(ws, subscribes(ws, 'board/__cursors')[0], { ok: true, data: cursors, topic: 'board:cursors', merge: 'cursor' });
	await tick();
	return { room, ws };
}

const keys = (list) => list.map((e) => e.key).sort();

describe('roster views over streams that lose, repeat or reorder frames', () => {
	it('others keeps one entry for a repeated join and drops a member whose leave was lost', async () => {
		const { room, ws } = await loadedRoom([
			{ key: 'me', data: { name: 'Me' } },
			{ key: 'ann', data: { name: 'Ann' } }
		], []);
		expect(keys(room.others)).toEqual(['ann']);

		const join = { topic: 'board:presence', event: 'join', data: { key: 'bob', data: { name: 'Bob' } } };
		ws.receive(join);
		ws.receive(join);
		await tick();
		expect(keys(room.others)).toEqual(['ann', 'bob']);

		// Lost: ann left and cat joined.
		ws.receive({ topic: '__replay:board:presence', event: 'gap', data: { lost: 2 } });
		await tick();
		const again = subscribes(ws, 'board/__presence');
		expect(again).toHaveLength(2);
		expect(again[1].seq).toBeUndefined();
		answer(ws, again[1], { ok: true, data: [
			{ key: 'me', data: { name: 'Me' } },
			{ key: 'bob', data: { name: 'Bob' } },
			{ key: 'cat', data: { name: 'Cat' } }
		], topic: 'board:presence', merge: 'presence' });
		await tick();
		expect(keys(room.others)).toEqual(['bob', 'cat']);
		room.destroy();
	});

	it('cursors stay on the newest sample and lose a cursor whose remove was lost', async () => {
		const { room, ws } = await loadedRoom([], [{ key: 'ann', x: 0, y: 0, _p: 'pa', _n: 1 }]);
		expect(room.cursors.map((c) => [c.key, c.x])).toEqual([['ann', 0]]);

		const sample = (n, x) => ws.receive({ topic: 'board:cursors', event: 'update', data: { key: 'ann', x, y: 0, _p: 'pa', _n: n } });
		sample(3, 30);
		sample(3, 30);
		sample(2, 20);
		await tick();
		expect(room.cursors.map((c) => [c.key, c.x])).toEqual([['ann', 30]]);

		ws.receive({ topic: 'board:cursors', event: 'update', data: { key: 'bob', x: 5, y: 5, _p: 'pb', _n: 1 } });
		await tick();
		expect(keys(room.cursors)).toEqual(['ann', 'bob']);

		// Lost: ann's cursor was removed.
		ws.receive({ topic: '__replay:board:cursors', event: 'gap', data: { lost: 1 } });
		await tick();
		const again = subscribes(ws, 'board/__cursors');
		expect(again).toHaveLength(2);
		expect(again[1].seq).toBeUndefined();
		answer(ws, again[1], { ok: true, data: [{ key: 'bob', x: 6, y: 6, _p: 'pb', _n: 2 }], topic: 'board:cursors', merge: 'cursor' });
		await tick();
		expect(room.cursors.map((c) => [c.key, c.x])).toEqual([['bob', 6]]);
		room.destroy();
	});
});
