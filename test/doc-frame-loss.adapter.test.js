// A document replica that loses, repeats or reorders update frames converges
// on the server's document. CRDT merges are idempotent and commutative, so a
// repeated or reordered update needs no sequence check; a lost one is
// recovered by the state-vector exchange, either when a later update arrives
// that depends on it or, for a lost update nothing depends on, by the
// background reconcile. Runs the real client, the adapter's document channel
// and the adapter's test server, with a second raw connection as the writer
// and a socket in front of the reader that drops, repeats and holds frames.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { compileModule } from 'svelte/compiler';
import * as Y from 'yjs';
import { installLossyWebSocket, frameTopic } from './helpers/lossy-websocket.js';

const lossy = installLossyWebSocket();
const { createTestServer } = await import('svelte-adapter-uws/testing');
const { connect } = await import('svelte-adapter-uws/client');
const { createCrdtChannel } = await import('svelte-adapter-uws/plugins/crdt/channel');
const { live, realtime, __register, _prepareHmr, _resetCrdt } = await import('../src/server.js');
const { __rpc, status } = await import('../src/client.js');

const SHIPPED_RUNE_PATH = resolve(import.meta.dirname, '../src/client-doc.svelte.js');
const CLIENT_REACTIVITY = resolve(import.meta.dirname, '../node_modules/svelte/src/reactivity/index-client.js');
const runeProbeRoot = resolve(import.meta.dirname, '__doc_frame_loss_rune__');

/** Compile the shipped document runes for the browser and import them. */
async function loadDocRunes() {
	mkdirSync(runeProbeRoot, { recursive: true });
	const probeDir = mkdtempSync(resolve(runeProbeRoot, 'probe-'));
	writeFileSync(resolve(probeDir, 'client.js'), 'export function _setCrdtDegraded() {}\n');
	const { js } = compileModule(readFileSync(SHIPPED_RUNE_PATH, 'utf8'), { filename: 'client-doc.svelte.js', generate: 'client' });
	const out = resolve(probeDir, 'client-doc.js');
	writeFileSync(out, js.code.replace("'svelte/reactivity'", JSON.stringify(pathToFileURL(CLIENT_REACTIVITY).href)));
	return import(pathToFileURL(out).href);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}

/** A document update frame on its way to the reader: binary, or the JSON fallback. */
const isDocFrame = (event) => typeof event.data !== 'string' || (frameTopic(event) || '').startsWith('__crdt:');

let server, conn, runes;
let docSeq = 0;
const writers = [];
const views = [];

beforeAll(async () => {
	_resetCrdt();
	runes = await loadDocRunes();
	server = await createTestServer({ handler: realtime() });
	conn = connect({ url: server.wsUrl });
});

afterEach(() => {
	lossy.link.inbound = null;
	for (const v of views.splice(0)) v.destroy();
	for (const w of writers.splice(0)) w.close();
});

afterAll(async () => {
	conn?.close();
	await server?.close();
	_resetCrdt();
	_prepareHmr();
	lossy.restore();
	if (existsSync(runeProbeRoot)) rmSync(runeProbeRoot, { recursive: true, force: true });
});

/** Register a fresh document and return its RPC base path. */
function declare() {
	const n = ++docSeq;
	const board = live.doc({ topic: 'frame-loss-' + n });
	const name = 'lossdoc' + n;
	__register(name + '/board/__doc/sync', board.__docSync, name);
	__register(name + '/board/__doc/update', board.__docUpdate, name);
	__register(name + '/board/__doc/close', board.__docClose, name);
	return name + '/board';
}

/**
 * Mount the document map the way the generated client stub does. `synced()`
 * counts the sync exchanges that have answered.
 */
async function mount(base, reconcileIntervalMs) {
	const call = __rpc(base + '/__doc/sync');
	let answered = 0;
	const sync = (sv, mountId) => call(sv, mountId).finally(() => { answered++; });
	const update = __rpc(base + '/__doc/update');
	const close = __rpc(base + '/__doc/close');
	const view = runes._acquireDoc(base, 'map', () => createCrdtChannel({
		reconcileIntervalMs,
		transport: {
			sendUpdate: (bytes) => update.send(bytes),
			sync: (sv, mountId) => sync(sv, mountId),
			close: (mountId) => close.send(mountId)
		}
	}), status);
	views.push(view);
	await until(() => view.synced, 'the reader to sync');
	return { view, synced: () => answered };
}

/** A second connection, outside the lossy socket, that edits the document. */
async function writer(base) {
	const ws = new lossy.Native(server.wsUrl);
	ws.binaryType = 'arraybuffer';
	const replies = new Map();
	ws.addEventListener('message', (e) => {
		if (typeof e.data !== 'string') return;
		const msg = JSON.parse(e.data);
		if (msg.topic === '__rpc') replies.set(msg.event, msg.data);
	});
	await new Promise((done, fail) => {
		ws.addEventListener('open', done, { once: true });
		ws.addEventListener('error', fail, { once: true });
	});
	writers.push(ws);
	const doc = new Y.Doc();
	ws.send(JSON.stringify({ rpc: base + '/__doc/sync', id: 'w-sync', args: [Array.from(Y.encodeStateVector(doc)), 1] }));
	await until(() => replies.has('w-sync'), 'the writer to sync');
	const diff = replies.get('w-sync').data?.diff;
	if (diff && diff.length > 0) Y.applyUpdate(doc, Uint8Array.from(diff));
	return {
		set(key, value) {
			const before = Y.encodeStateVector(doc);
			doc.getMap('root').set(key, value);
			ws.send(JSON.stringify({ rpc: base + '/__doc/update', args: [Array.from(Y.encodeStateAsUpdate(doc, before))] }));
		}
	};
}

/** A reader and a writer that already agree on `{ a: 1 }`. */
async function agreed(reconcileIntervalMs) {
	const base = declare();
	const { view, synced } = await mount(base, reconcileIntervalMs);
	const w = await writer(base);
	w.set('a', 1);
	await until(() => view.get('a') === 1, 'the first edit');
	return { view, w, synced };
}

/** Lose the next document frame; the result reads the sync count at the loss, or null before it. */
function loseNext(synced) {
	let at = null;
	lossy.link.inbound = (event, deliver) => {
		if (at === null && isDocFrame(event)) { at = synced(); return; }
		deliver();
	};
	return () => at;
}

describe('document frames lost, repeated or reordered on the way to a reader', () => {
	it('a lost update that a later one depends on is fetched by the state-vector exchange', async () => {
		const { view, w, synced } = await agreed(0);
		const lost = loseNext(synced);
		w.set('b', 2);
		await until(() => lost() !== null, 'the update frame to be lost');
		// No background reconcile runs here, so nothing else can bring it.
		await sleep(30);
		expect(view.has('b')).toBe(false);
		w.set('c', 3);
		await until(() => view.get('b') === 2 && view.get('c') === 3, 'the lost update to be recovered');
		expect(view.toJSON()).toEqual({ a: 1, b: 2, c: 3 });
	});

	it('a lost update nothing depends on is fetched by the background reconcile', async () => {
		const { view, w, synced } = await agreed(150);
		const lost = loseNext(synced);
		w.set('b', 2);
		await until(() => lost() !== null, 'the update frame to be lost');
		await until(() => view.get('b') === 2, 'the reconcile to recover the update');
		// The frame never arrived, so only a sync answered after the loss brought it.
		expect(synced()).toBeGreaterThan(/** @type {number} */ (lost()));
		expect(view.toJSON()).toEqual({ a: 1, b: 2 });
	});

	it('a repeated update applies once', async () => {
		const { view, w } = await agreed(0);
		let repeated = 0;
		lossy.link.inbound = (event, deliver) => {
			deliver();
			if (isDocFrame(event)) { repeated++; deliver(); }
		};
		w.set('a', 2);
		w.set('b', 1);
		await until(() => view.get('b') === 1, 'both edits');
		await sleep(30);
		expect(repeated).toBe(2);
		expect(view.toJSON()).toEqual({ a: 2, b: 1 });
	});

	it('an update that overtakes the one it depends on waits for it and both apply', async () => {
		const { view, w } = await agreed(0);
		let held = null;
		let swapped = false;
		lossy.link.inbound = (event, deliver) => {
			if (swapped || !isDocFrame(event)) return deliver();
			if (held === null) { held = deliver; return; }
			swapped = true;
			deliver();
			held();
		};
		w.set('b', 2);
		w.set('c', 3);
		await until(() => swapped && view.get('c') === 3, 'both edits');
		expect(view.toJSON()).toEqual({ a: 1, b: 2, c: 3 });
	});
});
