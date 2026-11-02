import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { live, realtime, __register, _resetLifecycle } from '../server.js';
import { registry } from './state.js';
import { monotonicNow, setTimer } from '../shared/runtime.js';
import { _crdtDecls, _crdtDeclRegistrations } from './crdt.js';

let running = false;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function isLoopback(address) {
	if (address === '127.0.0.1') return true;
	if (typeof address !== 'string') return false;
	try {
		const normalized = new URL('http://[' + address + ']/').hostname;
		return normalized === '[::1]' || normalized === '[::ffff:7f00:1]';
	} catch { return false; }
}
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}
function rngFor(seed) {
	let state = parseInt(sha256(seed).slice(0, 8), 16);
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}
function shuffle(values, rng) {
	const result = values.slice();
	for (let index = result.length - 1; index > 0; index--) {
		const other = Math.floor(rng() * (index + 1));
		[result[index], result[other]] = [result[other], result[index]];
	}
	return result;
}
function packageInfo(entry) {
	const path = fileURLToPath(import.meta.resolve(entry));
	let directory = dirname(path);
	while (directory !== parse(directory).root) {
		try {
			const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
			if (pkg.name && pkg.version) return { name: pkg.name, version: pkg.version, entrySha256: sha256(readFileSync(path)) };
		} catch (error) { if (error.code !== 'ENOENT') throw error; }
		directory = dirname(directory);
	}
	throw new Error('Cannot resolve package provenance for ' + entry);
}
function provenance() {
	const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
	return {
		node: process.versions.node,
		realtime: { name: pkg.name, version: pkg.version },
		adapter: packageInfo('svelte-adapter-uws/plugins/crdt/replica'),
		yjs: packageInfo('yjs'),
		sources: Object.fromEntries(['sim-crdt.js', 'crdt.js', 'dispatch.js'].map(name => [name, sha256(readFileSync(new URL(name, import.meta.url)))]))
	};
}
async function until(read, label) {
	const deadline = monotonicNow() + 10000;
	while (monotonicNow() < deadline) {
		const result = read();
		if (result) return result;
		await new Promise(resolve => setTimer(resolve, 1));
	}
	throw new Error('CRDT oracle timed out waiting for ' + label);
}
function snapshot(doc) {
	return { map: canonical(doc.getMap('values').toJSON()), array: doc.getArray('items').toArray(), text: doc.getText('text').toString() };
}

/** Run in an isolated Node process: it owns a test server and document registry entries. */
export async function runCrdtConvergence(config = {}) {
	const seed = String(config.seed ?? 'realtime-crdt-0');
	const replicas = config.replicas ?? 3;
	const operations = config.operations ?? 48;
	const fault = config.fault ?? 'reorder-duplicate';
	if (!Number.isSafeInteger(replicas) || replicas < 2 || replicas > 8) throw new RangeError('replicas must be an integer from 2 to 8');
	if (!Number.isSafeInteger(operations) || operations < replicas || operations > 512) throw new RangeError('operations must be an integer from replicas to 512');
	if (!['ordered', 'reorder-duplicate', 'drop-update', 'corrupt-update'].includes(fault)) throw new TypeError('unknown CRDT fault mode');
	if (running) throw new Error('CRDT convergence runs must be awaited one at a time');
	running = true;
	const rng = rngFor(seed);
	const topic = 'crdt-oracle:' + sha256(seed).slice(0, 16);
	const paths = ['sync', 'update', 'close'].map(name => 'crdt-oracle/' + name);
	const saved = paths.map(path => registry.get(path));
	const peers = [], updates = [], model = [], trace = [];
	let server, executed = 0, requests = 0, faulted = 0;
	try {
		const declaration = live.doc({ topic, guard: () => true, persistOnEmpty: false });
		for (const [index, handler] of [declaration.__docSync, declaration.__docUpdate, declaration.__docClose].entries()) __register(paths[index], live.public(handler));
		_resetLifecycle();
		server = await createTestServer({
			wsPath: '/crdt-oracle/' + randomBytes(24).toString('hex'), // determinism-allow: unpredictable network admission path, excluded from the seeded result
			handler: realtime({ upgrade: ({ remoteAddress }) => isLoopback(remoteAddress) ? {} : false })
		});
		for (let index = 0; index < replicas; index++) {
			const doc = new Y.Doc();
			doc.clientID = 100 + index;
			const peer = { doc, socket: new WebSocket(server.wsUrl), frames: [], calls: 0, updates: [], live: [], winner: null };
			peers.push(peer);
			peer.socket.addEventListener('message', event => {
				const frame = JSON.parse(String(event.data));
				peer.frames.push(frame);
				if (frame.topic === '__crdt:' + topic && frame.data?.op === 'update') peer.updates.push(Uint8Array.from(frame.data.bytes));
			});
			await until(() => peer.socket.readyState === WebSocket.OPEN, 'native socket');
			const reply = await call(peer, paths[0], [[], index + 1]);
			Y.applyUpdate(doc, Uint8Array.from(reply.diff));
			doc.on('update', (bytes, origin) => { if (origin !== 'delivery') updates.push({ actor: index, bytes }); });
		}
		for (let index = 0; index < operations; index++) {
			const actor = index < replicas ? index : Math.floor(rng() * replicas);
			const peer = peers[actor];
			const item = { id: 'edit-' + index, value: Math.floor(rng() * 1000000), character: String.fromCodePoint(0x1000 + index) };
			const removed = peer.live.length >= 3 ? peer.live[0] : null;
			peer.doc.transact(() => {
				peer.doc.getMap('values').set(item.id, item.value);
				peer.doc.getMap('values').set('winner', item.value);
				peer.doc.getArray('items').push([item.id]);
				peer.doc.getText('text').insert(0, item.character);
				if (removed) {
					peer.doc.getMap('values').delete(removed.id);
					peer.doc.getArray('items').delete(0, 1);
					peer.doc.getText('text').delete(peer.live.length, 1);
				}
			});
			if (removed) peer.live.shift();
			peer.live.push(item);
			peer.winner = item.value;
			model.push({ actor, item, removed: removed?.id ?? null });
			executed++;
		}
		if (updates.length !== executed) throw new Error('Each executed transaction must produce one genuine Yjs update');
		const order = updates.map((_update, index) => index);
		let schedule = fault === 'ordered' ? order : shuffle(order.concat(order.filter(index => index % 3 === 0)), rng);
		for (const index of schedule) {
			const update = updates[index];
			if (index === updates.length - 1 && fault === 'drop-update') { faulted++; trace.push({ index, outcome: 'dropped' }); continue; }
			const corrupt = index === updates.length - 1 && fault === 'corrupt-update';
			if (corrupt) faulted++;
			await call(peers[update.actor], paths[1], [corrupt ? [255] : Array.from(update.bytes)]);
			requests++;
			trace.push({ index, outcome: corrupt ? 'corrupted' : 'sent' });
		}
		// Each socket's own RPC answer is a transport barrier for its received frames.
		const replies = [];
		for (let index = 0; index < peers.length; index++) replies.push(await call(peers[index], paths[0], [[], index + 1]));
		for (const peer of peers) {
			const deliveries = fault === 'ordered' ? peer.updates : shuffle(peer.updates.concat(peer.updates.filter((_bytes, index) => index % 4 === 0)), rng);
			for (const bytes of deliveries) Y.applyUpdate(peer.doc, bytes, 'delivery');
		}
		const authority = new Y.Doc();
		let authoritative;
		try { Y.applyUpdate(authority, Uint8Array.from(replies[0].diff)); authoritative = snapshot(authority); } finally { authority.destroy(); }
		const retainedById = new Map();
		const winners = new Map();
		for (const operation of model) {
			retainedById.set(operation.item.id, operation.item);
			if (operation.removed) retainedById.delete(operation.removed);
			winners.set(operation.actor, operation.item.value);
		}
		const retained = [...retainedById.values()];
		// Writers share no remote history while editing. Concurrent runs order
		// by their fixed actor IDs; appends keep local order and prepends reverse it.
		const byActor = Array.from({ length: replicas }, () => []);
		for (const operation of model) {
			if (operation.removed) byActor[operation.actor].shift();
			byActor[operation.actor].push(operation.item);
		}
		const expected = {
			map: canonical({ ...Object.fromEntries(retained.map(item => [item.id, item.value])), winner: winners.get(replicas - 1) }),
			array: byActor.flatMap(items => items.map(item => item.id)),
			text: byActor.flatMap(items => items.slice().reverse().map(item => item.character)).join('')
		};
		const actual = [authoritative, ...peers.map(peer => snapshot(peer.doc))];
		const failures = [];
		for (const [replica, value] of actual.entries()) {
			if (JSON.stringify(value.map) !== JSON.stringify(expected.map)) failures.push({ replica, invariant: 'map-state' });
			if (JSON.stringify(value.array) !== JSON.stringify(expected.array)) failures.push({ replica, invariant: 'array-state' });
			if (value.text !== expected.text) failures.push({ replica, invariant: 'text-state' });
			if (JSON.stringify(value) !== JSON.stringify(authoritative)) failures.push({ replica, invariant: 'replica-equality' });
		}
		return { ok: failures.length === 0, seed, fault, executed, replicas, generatedUpdates: updates.length, updateRequests: requests,
			faulted, deliveries: peers.reduce((count, peer) => count + peer.updates.length, 0), failures, expected, actual,
			trace, digest: sha256(JSON.stringify(canonical({ expected, actual, trace }))), provenance: provenance() };
	} finally {
		for (const peer of peers) { peer.socket.close(); peer.doc.destroy(); }
		try { await server?.close(); } finally {
			const key = 'topic:' + topic;
			_crdtDecls.get(key)?.authority?.destroy();
			_crdtDecls.delete(key);
			_crdtDeclRegistrations.delete(key);
			for (let index = 0; index < paths.length; index++) {
				if (saved[index]) registry.set(paths[index], saved[index]); else registry.delete(paths[index]);
			}
			running = false;
		}
	}
}
async function call(peer, path, args) {
	const id = 'oracle-' + peer.calls++;
	peer.socket.send(JSON.stringify({ rpc: path, id, args }));
	const reply = await until(() => peer.frames.find(frame => frame.topic === '__rpc' && frame.event === id), 'document RPC');
	if (!reply.data.ok) throw new Error('CRDT oracle RPC refused: ' + reply.data.code);
	return reply.data.data;
}
