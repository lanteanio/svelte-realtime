import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { live, realtime, __register, _prepareHmr, _resetCrdt, _resetLifecycle } from '../src/server.js';
import { _crdtDecls } from '../src/server/crdt.js';

let server, record;
let id = 0;
const sockets = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for document mount boundary');
		await sleep(1);
	}
}
async function connect() {
	const socket = new WebSocket(server.wsUrl);
	const calls = new Map();
	socket.addEventListener('message', event => {
		const frame = JSON.parse(String(event.data));
		if (frame.topic !== '__rpc') return;
		const pending = calls.get(frame.event);
		if (pending) {
			calls.delete(frame.event);
			clearTimeout(pending.timer);
			pending.resolve(frame.data);
		}
	});
	sockets.push(socket);
	await until(() => socket.readyState === WebSocket.OPEN);
	return { socket, calls };
}
async function setup(guard = () => true) {
	_resetLifecycle();
	const board = live.doc({ topic: (_ctx, room) => 'mount-board:' + room, guard, persistOnEmpty: false });
	for (const [suffix, handler] of [['sync', board.__docSync], ['update', board.__docUpdate], ['close', board.__docClose]]) {
		__register('mount-budget/' + suffix, live.public(handler));
	}
	server = await createTestServer({ handler: realtime() });
	return connect();
}
async function call(peer, suffix, room, mountId) {
	const requestId = 'mount-check-' + id++;
	const result = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			peer.calls.delete(requestId);
			reject(new Error('Timed out waiting for document mount reply ' + requestId));
		}, 3000);
		peer.calls.set(requestId, { resolve, timer });
		try {
			peer.socket.send(JSON.stringify({ rpc: 'mount-budget/' + suffix, id: requestId,
				args: suffix === 'sync' ? [room, [], mountId] : [room, mountId] }));
		} catch (error) {
			clearTimeout(timer);
			peer.calls.delete(requestId);
			reject(error);
		}
	});
	if (!record) record = [..._crdtDecls.values()][0];
	return result;
}
function gateSubscriptions() {
	const subscribe = server.platform.subscribe;
	const pending = [];
	server.platform.subscribe = function (...args) {
		return new Promise(resolve => { pending.push(() => resolve(subscribe.apply(this, args))); });
	};
	return {
		pending,
		release() { server.platform.subscribe = subscribe; for (const resolve of pending.splice(0)) resolve(); }
	};
}
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await server?.close();
	server = undefined;
	record = undefined;
	_resetCrdt();
	_prepareHmr();
});

it('bounds distinct document mounts while re-sync and other connections remain usable', async () => {
	const peer = await setup();
	for (let mount = 1; mount <= 128; mount++) expect((await call(peer, 'sync', 'one', mount)).ok).toBe(true);
	expect(await call(peer, 'sync', 'one', 129)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
	expect((await call(peer, 'sync', 'one', 128)).ok).toBe(true);
	const other = await connect();
	expect((await call(other, 'sync', 'one', 1)).ok).toBe(true);
	expect(server.platform.subscribers('__crdt:mount-board:one')).toBe(2);
	expect((await call(other, 'close', 'one', 1)).ok).toBe(true);
	expect((await call(peer, 'close', 'one', 1)).ok).toBe(true);
	expect((await call(peer, 'sync', 'one', 129)).ok).toBe(true);
	// Repeated close cannot manufacture another mount slot.
	expect((await call(peer, 'close', 'one', 1)).ok).toBe(true);
	expect(await call(peer, 'sync', 'one', 130)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
	for (let mount = 2; mount <= 129; mount++) expect((await call(peer, 'close', 'one', mount)).ok).toBe(true);
	expect(record.authority.has('mount-board:one')).toBe(false);
	expect(server.platform.subscribers('__crdt:mount-board:one')).toBe(0);
});

it('concurrent syncs cannot overbook the last per-document mount slot', async () => {
	const peer = await setup();
	for (let mount = 1; mount <= 127; mount++) expect((await call(peer, 'sync', 'one', mount)).ok).toBe(true);
	const gate = gateSubscriptions();
	const refused = [];
	const waiting = Array.from({ length: 8 }, (_, index) => call(peer, 'sync', 'one', 128 + index).then(reply => {
		if (!reply.ok) refused.push(reply);
		return reply;
	}));
	let attempts;
	try {
		await until(() => gate.pending.length + refused.length === 8);
		expect(gate.pending).toHaveLength(1);
		expect(refused.map(reply => reply.code)).toEqual(Array(7).fill('RATE_LIMITED'));
	} finally { gate.release(); attempts = await Promise.all(waiting); }
	expect(attempts.filter(reply => reply.ok)).toHaveLength(1);
	expect(attempts.filter(reply => reply.code === 'RATE_LIMITED')).toHaveLength(7);
	const admitted = 128 + attempts.findIndex(reply => reply.ok);
	for (let mount = 1; mount <= 127; mount++) await call(peer, 'close', 'one', mount);
	await call(peer, 'close', 'one', admitted);
	expect(record.authority.has('mount-board:one')).toBe(false);
	expect(server.platform.subscribers('__crdt:mount-board:one')).toBe(0);
});

it('a read-only sync invalidates pending writes before its excess mount is refused', async () => {
	let mode = 'allow', pending;
	const peer = await setup(() => {
		if (mode === 'wait') return new Promise(resolve => { pending = resolve; });
		return { read: true, write: mode !== 'readonly' };
	});
	for (let mount = 1; mount <= 128; mount++) expect((await call(peer, 'sync', 'one', mount)).ok).toBe(true);
	const draft = new Y.Doc(), replica = new Y.Doc();
	try {
		draft.getMap('root').set('stale', 1);
		mode = 'wait';
		const older = call(peer, 'update', 'one', Array.from(Y.encodeStateAsUpdate(draft)));
		await until(() => pending);
		mode = 'readonly';
		expect(await call(peer, 'sync', 'one', 129)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
		pending({ read: true, write: true });
		await older;
		mode = 'allow';
		const result = await call(peer, 'sync', 'one', 1);
		expect(result.ok).toBe(true);
		Y.applyUpdate(replica, Uint8Array.from(result.data.diff));
		expect(replica.getMap('root').toJSON()).toEqual({});
	} finally { draft.destroy(); replica.destroy(); }
});

it('counts duplicate pending mount IDs once at capacity and retires both claims', async () => {
	const peer = await setup();
	for (let mount = 1; mount <= 127; mount++) expect((await call(peer, 'sync', 'one', mount)).ok).toBe(true);
	const gate = gateSubscriptions(), refused = [];
	const waiting = [128, 128, 129].map(mount => call(peer, 'sync', 'one', mount).then(reply => {
		if (!reply.ok) refused.push(reply);
		return reply;
	}));
	let attempts;
	try {
		await until(() => gate.pending.length + refused.length === 3);
		expect(gate.pending).toHaveLength(2);
		expect(refused.map(reply => reply.code)).toEqual(['RATE_LIMITED']);
	} finally { gate.release(); attempts = await Promise.all(waiting); }
	expect(attempts.filter(reply => reply.ok)).toHaveLength(2);
	for (let mount = 1; mount <= 128; mount++) await call(peer, 'close', 'one', mount);
	expect(record.authority.has('mount-board:one')).toBe(false);
	expect(server.platform.subscribers('__crdt:mount-board:one')).toBe(0);
});

it('a cancelled pending mount keeps its budget until the admission work settles', async () => {
	const peer = await setup();
	for (let mount = 1; mount <= 127; mount++) expect((await call(peer, 'sync', 'one', mount)).ok).toBe(true);
	const gate = gateSubscriptions();
	const pending = call(peer, 'sync', 'one', 128);
	try {
		await until(() => gate.pending.length === 1);
		await call(peer, 'close', 'one', 128);
		expect(await call(peer, 'sync', 'one', 129)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
	} finally { gate.release(); }
	expect(await pending).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect((await call(peer, 'sync', 'one', 129)).ok).toBe(true);
	for (let mount = 1; mount <= 127; mount++) await call(peer, 'close', 'one', mount);
	await call(peer, 'close', 'one', 129);
	expect(record.authority.has('mount-board:one')).toBe(false);
	expect(server.platform.subscribers('__crdt:mount-board:one')).toBe(0);
});

it('bounds aggregate mounts and rolls back rejected new-document reservations', async () => {
	const peer = await setup();
	for (let room = 0; room < 8; room++) {
		for (let mount = 1; mount <= 128 - (room === 7 ? 1 : 0); mount++) {
			expect((await call(peer, 'sync', String(room), mount)).ok).toBe(true);
		}
	}
	const rooms = Array.from({ length: 8 }, (_, index) => 'new-' + index);
	const gate = gateSubscriptions();
	const refused = [];
	const waiting = rooms.map(room => call(peer, 'sync', room, 1).then(reply => {
		if (!reply.ok) refused.push(reply);
		return reply;
	}));
	let attempts;
	try {
		await until(() => gate.pending.length + refused.length === 8);
		expect(gate.pending).toHaveLength(1);
		expect(refused.map(reply => reply.code)).toEqual(Array(7).fill('RATE_LIMITED'));
	} finally { gate.release(); attempts = await Promise.all(waiting); }
	expect(attempts.filter(reply => reply.ok)).toHaveLength(1);
	expect(attempts.filter(reply => reply.code === 'RATE_LIMITED')).toHaveLength(7);
	for (let index = 0; index < rooms.length; index++) {
		expect(record.authority.has('mount-board:' + rooms[index])).toBe(attempts[index].ok);
		expect(server.platform.subscribers('__crdt:mount-board:' + rooms[index])).toBe(attempts[index].ok ? 1 : 0);
	}
	expect((await call(peer, 'sync', '0', 1)).ok).toBe(true);
	expect(await call(peer, 'sync', 'over-budget', 1)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
	await call(peer, 'close', '0', 1);
	expect((await call(peer, 'sync', 'freed-budget', 1)).ok).toBe(true);
	const other = await connect();
	expect((await call(other, 'sync', 'over-budget', 1)).ok).toBe(true);
}, 15000);
