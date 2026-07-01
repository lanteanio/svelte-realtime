// Spatial cell-topic interest (interest.cells) for live.smooth() against a REAL
// adapter. In cells mode area-of-interest is SUBSCRIPTION to grid-cell topics, not
// a per-subscriber server-side cull: each changed entity is published to its
// cell's topic via the stateless shared codec (native cohort fan-out), and the
// server subscribes each socket to the cell block covering its view. This proves
// end to end that (1) a co-located peer receives a moved entity on the right cell
// topic (JSON envelope and the binary cohort frame), and (2) a peer whose view is
// elsewhere is NOT subscribed to that cell and receives nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
// Namespace import: the cell-codec exports are new in the adapter, so a stale
// installed adapter (predating the cell codec) must not fail this module's load -
// a namespace access yields undefined and the suite skips (the publish-order
// dependency: adapter ships the cell codec first, then this feature works).
import * as smoothPlugin from 'svelte-adapter-uws/plugins/smooth';
const { createSmoothAuthority, createSmoothWireCodec, SMOOTH_TOPIC_PREFIX } = smoothPlugin;
const createCellWireCodec = smoothPlugin.createCellWireCodec;
const CELL_TOPIC_PREFIX = smoothPlugin.CELL_TOPIC_PREFIX;
const CELL_CAPABILITY = smoothPlugin.CELL_CAPABILITY;
const cellsSupported = typeof createCellWireCodec === 'function';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
// Requires a real uWS server AND an adapter that exports the cell codec.
const describeUWS = (uWS && cellsSupported) ? describe : describe.skip;
const { createTestServer } = uWS ? await import('svelte-adapter-uws/testing') : {};

// The real authority + both codecs from the installed adapter, in the shape
// _setSmoothRuntime expects (so cells mode runs against the genuine wire).
const realRuntime = {
	createSmoothAuthority,
	createSmoothWireCodec,
	createCellWireCodec,
	SMOOTH_TOPIC_PREFIX,
	CELL_TOPIC_PREFIX
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, timeout = 3000, step = 15) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const v = pred();
		if (v) return v;
		if (Date.now() > deadline) throw new Error('until() timed out');
		await sleep(step);
	}
}

let moduleSeq = 0;
function declareCells() {
	const name = 'cl' + ++moduleSeq;
	const shape = live.smooth({
		topic: (ctx, roomId) => 'arena:' + roomId,
		topicArgs: 1,
		apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y + (cmd.dy || 0) }),
		initial: { x: 0, y: 0 },
		interest: { cells: true, radius: 100, cell: 256, position: (s) => ({ x: s.x, y: s.y }) }
	});
	__register(name + '/shape/__smooth/sync', shape.__smoothSync, name);
	__register(name + '/shape/__smooth/command', shape.__smoothCommand, name);
	__register(name + '/shape/__smooth/center', shape.__smoothCenter, name);
	return name;
}

async function connectClient(url, caps) {
	const ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	const frames = { json: [], binary: [] };
	ws.addEventListener('message', (e) => {
		if (typeof e.data === 'string') {
			try { frames.json.push(JSON.parse(e.data)); } catch { /* ignore */ }
		} else {
			frames.binary.push(new Uint8Array(e.data));
		}
	});
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	await sleep(50);
	let rpcSeq = 0;
	return {
		ws,
		frames,
		rpc(path, args) {
			const id = 'r' + ++rpcSeq;
			ws.send(JSON.stringify({ rpc: path, id, args }));
			return id;
		},
		reply(id) { return frames.json.find((m) => m.topic === '__rpc' && m.event === id); },
		cellUpdates(cellTopic, key) {
			return frames.json.filter((m) => m.topic === cellTopic && m.event === 'update' && (!key || m.data.key === key));
		}
	};
}

describeUWS('live.smooth cell-topic interest against a real adapter', () => {
	let server;
	let clients;

	beforeEach(async () => {
		clients = [];
		_setSmoothRuntime(realRuntime);
		server = await createTestServer({
			handler: {
				message(ws, ctx) {
					if (!ctx.isBinary && ctx.msg === undefined) handleRpc(ws, ctx.data, server.platform);
				}
			}
		});
	});

	afterEach(async () => {
		for (const c of clients) { try { c.ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
		_resetSmooth();
		_setSmoothRuntime(null);
	});

	it('delivers a moved entity to a co-located peer on its cell topic (JSON envelope + binary cohort frame)', async () => {
		const name = declareCells();
		// The author moves to {5,0}; floor(5/256)=0, floor(0/256)=0 -> cell "0,0".
		const cellTopic = CELL_TOPIC_PREFIX + 'arena:r1#0,0';

		const author = await connectClient(server.wsUrl);                  // JSON author
		const jsonPeer = await connectClient(server.wsUrl);                // JSON peer, co-located at {0,0}
		const binPeer = await connectClient(server.wsUrl, [CELL_CAPABILITY]); // binary peer, co-located
		clients.push(author, jsonPeer, binPeer);

		const aSync = author.rpc(name + '/shape/__smooth/sync', ['r1']);
		const jSync = jsonPeer.rpc(name + '/shape/__smooth/sync', ['r1']);
		const bSync = binPeer.rpc(name + '/shape/__smooth/sync', ['r1']);
		await until(() => author.reply(aSync) && jsonPeer.reply(jSync) && binPeer.reply(bSync));

		// The sync reply advertises cells mode so the client wires its cell sink.
		expect(author.reply(aSync).data.data.cells).toBe(1);
		const youA = author.reply(aSync).data.data.you;
		expect(youA).toBeTruthy();

		// Server-side cell subscriptions are async (they run the subscribe auth gate),
		// and a real deployment publishes every tick, so drive the author with a short
		// command stream: the co-located peers receive its updates on cell "0,0" once
		// their subscription is live (an entity subscribed at T gets every later tick).
		let cid = 0;
		await until(() => {
			author.rpc(name + '/shape/__smooth/command', ['r1', [{ id: ++cid, cmd: { dx: 1, dy: 0 } }]]);
			return jsonPeer.cellUpdates(cellTopic, youA).length >= 1;
		}, 3000, 40);
		expect(jsonPeer.cellUpdates(cellTopic, youA)[0].data.data.x).toBeGreaterThan(0);

		// The capability peer receives the same publishes as native binary cohort
		// frames (0x03) - the shared fan-out, not a per-subscriber walk.
		await until(() => binPeer.frames.binary.length >= 1);
		expect(binPeer.frames.binary[0][0]).toBe(0x03);
	});

	it('does not deliver a near-cell update to a peer whose reported view is far away', async () => {
		const name = declareCells();
		const cellTopic = CELL_TOPIC_PREFIX + 'arena:r1#0,0';

		const author = await connectClient(server.wsUrl);
		const farPeer = await connectClient(server.wsUrl);
		clients.push(author, farPeer);

		const aSync = author.rpc(name + '/shape/__smooth/sync', ['r1']);
		const fSync = farPeer.rpc(name + '/shape/__smooth/sync', ['r1']);
		await until(() => author.reply(aSync) && farPeer.reply(fSync));
		const youA = author.reply(aSync).data.data.you;
		await sleep(100); // cell subscriptions settle

		// The far peer reports a view centered at {10000, 10000} (cell ~"39,39"),
		// which unsubscribes it from cell "0,0" (well outside the hysteresis keep
		// block around the far center).
		farPeer.rpc(name + '/shape/__smooth/center', ['r1', { x: 10000, y: 10000 }]);
		await sleep(100); // the center report re-subscribes the socket's cell block

		// Positive control: the author is on its own cell "0,0" and DOES receive the
		// update there - so the pipeline works and the far peer's zero below is real.
		let cid = 0;
		await until(() => {
			author.rpc(name + '/shape/__smooth/command', ['r1', [{ id: ++cid, cmd: { dx: 1, dy: 0 } }]]);
			return author.cellUpdates(cellTopic, youA).length >= 1;
		}, 3000, 40);
		await sleep(80); // let any (erroneous) far-peer delivery arrive before asserting zero
		// The far peer, no longer subscribed to "0,0", received no update there.
		expect(farPeer.cellUpdates(cellTopic, youA).length).toBe(0);
		expect(farPeer.frames.binary.length).toBe(0);
	});

	it('scopes the join snapshot to the joiner cell block (roster fanout is not O(all entities))', async () => {
		const name = declareCells();

		// A first entity moves far away into a distant cell block.
		const mover = await connectClient(server.wsUrl);
		clients.push(mover);
		const mSync = mover.rpc(name + '/shape/__smooth/sync', ['r1']);
		await until(() => mover.reply(mSync));
		const youMover = mover.reply(mSync).data.data.you;
		await sleep(80);
		for (let i = 0; i < 20; i++) mover.rpc(name + '/shape/__smooth/command', ['r1', [{ id: i + 1, cmd: { dx: 400, dy: 400 } }]]);
		await sleep(200); // the mover is now thousands of units away (a far cell)

		// A new joiner at the origin: its scoped join snapshot covers only its own
		// cell block, so the far mover is NOT in the roster it receives.
		const joiner = await connectClient(server.wsUrl);
		clients.push(joiner);
		const jSync = joiner.rpc(name + '/shape/__smooth/sync', ['r1']);
		await until(() => joiner.reply(jSync));
		const states = joiner.reply(jSync).data.data.states || [];
		expect(states.map((s) => s.key)).not.toContain(youMover);
	});
});
