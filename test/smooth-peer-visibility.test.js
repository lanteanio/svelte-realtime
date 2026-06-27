// Peer visibility for live.smooth() against a REAL adapter: a uWS server
// (createTestServer) carries realtime's RPC handler, and three real WebSocket
// clients exercise the live publishWire fan-out end to end. A commanded entity's
// update must reach every OTHER subscriber - a binary frame to a capability peer,
// a JSON envelope to a plain peer - while the author is excluded from its own
// echo (noEcho) and receives only its acknowledgement.
//
// The in-process smooth suite drives a recording mock platform, so realtime's
// tick never walks a real per-subscriber binary fan-out there. This is the guard
// that the fan-out actually reaches peers - the regression the binary fan-out
// work builds on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import {
	createSmoothAuthority,
	createSmoothWireCodec,
	SMOOTH_TOPIC_PREFIX,
	SMOOTH_CAPABILITY
} from 'svelte-adapter-uws/plugins/smooth';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('svelte-adapter-uws/testing') : {};

// The real authority + binary codec from the installed adapter, in the shape
// _setSmoothRuntime expects (so live.smooth() runs against the genuine wire).
const realRuntime = { createSmoothAuthority, createSmoothWireCodec, SMOOTH_TOPIC_PREFIX };

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
function declareShape(extra = {}) {
	const name = 'pv' + ++moduleSeq;
	const shape = live.smooth({
		topic: (ctx, roomId) => 'arena:' + roomId,
		topicArgs: 1,
		apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y + (cmd.dy || 0) }),
		initial: { x: 0, y: 0 },
		...extra
	});
	__register(name + '/shape/__smooth/sync', shape.__smoothSync, name);
	__register(name + '/shape/__smooth/command', shape.__smoothCommand, name);
	return name;
}

/**
 * A real WebSocket client (Node's global WHATWG WebSocket) that records every
 * inbound frame, advertises capabilities, and sends realtime RPCs.
 */
async function connectClient(url, caps) {
	const ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	const frames = { json: [], binary: [] };
	ws.addEventListener('message', (e) => {
		if (typeof e.data === 'string') {
			try { frames.json.push(JSON.parse(e.data)); } catch { /* ignore non-JSON */ }
		} else {
			frames.binary.push(new Uint8Array(e.data));
		}
	});
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	await sleep(50); // capability advertisement settles before any subscribe
	let rpcSeq = 0;
	return {
		ws,
		frames,
		rpc(path, args) {
			const id = 'r' + ++rpcSeq;
			ws.send(JSON.stringify({ rpc: path, id, args }));
			return id;
		},
		reply(id) {
			return frames.json.find((m) => m.topic === '__rpc' && m.event === id);
		},
		updates(topic) {
			return frames.json.filter((m) => m.topic === topic && m.event === 'update');
		},
		acks(topic) {
			return frames.json.filter((m) => m.topic === topic && m.event === 'ack');
		}
	};
}

describeUWS('live.smooth peer visibility against a real adapter', () => {
	let server;
	let clients;

	beforeEach(async () => {
		clients = [];
		_setSmoothRuntime(realRuntime);
		server = await createTestServer({
			handler: {
				// Mirror production: the adapter's message hook drives realtime's RPC
				// dispatcher. RPC frames ({"rpc":...}) are not the test server's
				// pre-parsed {"type":...} control frames, so they arrive with msg
				// undefined - forward those raw bytes to handleRpc. The built-in
				// {type:'hello'} capability handshake is consumed by the test server.
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

	it('delivers a commanded update to every other subscriber and excludes the author', async () => {
		const name = declareShape({ tickMs: 25 });
		const wireTopic = SMOOTH_TOPIC_PREFIX + 'arena:r1';

		const author = await connectClient(server.wsUrl); // JSON-only author
		const binPeer = await connectClient(server.wsUrl, [SMOOTH_CAPABILITY]); // binary peer
		const jsonPeer = await connectClient(server.wsUrl); // plain peer
		clients.push(author, binPeer, jsonPeer);

		// All three sync: subscribe to the wire topic and bind their entity.
		const aSync = author.rpc(name + '/shape/__smooth/sync', ['r1']);
		const bSync = binPeer.rpc(name + '/shape/__smooth/sync', ['r1']);
		const jSync = jsonPeer.rpc(name + '/shape/__smooth/sync', ['r1']);
		await until(() => author.reply(aSync) && binPeer.reply(bSync) && jsonPeer.reply(jSync));

		const youA = author.reply(aSync).data.data.you;
		expect(youA).toBeTruthy();

		// The author commands its entity one tick of movement.
		author.rpc(name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 5, dy: 0 } }]]);

		// The plain peer receives the author's update on the wire topic, as JSON.
		// The same single `data` object feeds both wire formats, so this JSON
		// content match is the content check for both peers; binary-encoding
		// fidelity is the adapter's own smooth-codec suite.
		await until(() => jsonPeer.updates(wireTopic).length >= 1);
		const upd = jsonPeer.updates(wireTopic)[0];
		expect(upd.data.key).toBe(youA);
		expect(upd.data.data.x).toBe(5);

		// The capability peer receives the binary fan-out for the same publish: a
		// real 0x03 topic frame, proving the binary egress (the publishWire codec
		// path) reached the capable subscriber.
		await until(() => binPeer.frames.binary.length >= 1);
		expect(binPeer.frames.binary[0][0]).toBe(0x03);

		// The author is excluded from its own echo: it gets its acknowledgement but
		// no update at all (the broadcast publishes only the one moved entity, with
		// the author's own socket excluded). The shape declares no onMissing, so the
		// entity emits exactly one commanded update and no server-motion echo.
		await until(() => author.acks(wireTopic).length >= 1);
		expect(author.updates(wireTopic).length).toBe(0);
	});

	it('delivers an in-range update per subscriber with interest on, and excludes the author', async () => {
		// Interest on routes delivery through the per-subscriber relevancy walk
		// (sendWire / send) instead of the shared broadcast - a distinct binary
		// egress. All three entities seed at {0,0}, well inside radius 100, so the
		// author's moved entity is relevant to both peers.
		const name = declareShape({
			tickMs: 25,
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		const wireTopic = SMOOTH_TOPIC_PREFIX + 'arena:r1';

		const author = await connectClient(server.wsUrl); // JSON-only author
		const binPeer = await connectClient(server.wsUrl, [SMOOTH_CAPABILITY]); // binary peer
		const jsonPeer = await connectClient(server.wsUrl); // plain peer
		clients.push(author, binPeer, jsonPeer);

		const aSync = author.rpc(name + '/shape/__smooth/sync', ['r1']);
		const bSync = binPeer.rpc(name + '/shape/__smooth/sync', ['r1']);
		const jSync = jsonPeer.rpc(name + '/shape/__smooth/sync', ['r1']);
		await until(() => author.reply(aSync) && binPeer.reply(bSync) && jsonPeer.reply(jSync));
		const youA = author.reply(aSync).data.data.you;
		expect(youA).toBeTruthy();

		author.rpc(name + '/shape/__smooth/command', ['r1', [{ id: 1, cmd: { dx: 5, dy: 0 } }]]);

		// The plain peer is delivered the author's moved entity (per-subscriber).
		await until(() => jsonPeer.updates(wireTopic).some((m) => m.data.key === youA));
		const upd = jsonPeer.updates(wireTopic).find((m) => m.data.key === youA);
		expect(upd.data.data.x).toBe(5);

		// The capability peer is delivered it as a binary frame (the sendWire path).
		await until(() => binPeer.frames.binary.length >= 1);
		expect(binPeer.frames.binary[0][0]).toBe(0x03);

		// The author's own entity is suppressed for the author (noEcho own-key
		// suppression in the relevancy walk). It may receive its peers' first-sight
		// catch-up frames, but never an update for its OWN key.
		await until(() => author.acks(wireTopic).length >= 1);
		expect(author.updates(wireTopic).filter((m) => m.data.key === youA).length).toBe(0);
	});
});
