import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { live, realtime, __register, _prepareHmr, _restoreHmr, _resetCrdt, _resetLifecycle } from '../src/server.js';
import { _crdtDecls } from '../src/server/crdt.js';

let server;
let nextId = 0;
const sockets = [];
const documents = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for document test boundary');
		await sleep(1);
	}
}
function register(config) {
	const board = live.doc({ topic: 'authorization-board', persistOnEmpty: false, ...config });
	for (const [suffix, handler] of [['sync', board.__docSync], ['update', board.__docUpdate], ['close', board.__docClose]]) {
		__register('authorization/board/' + suffix, live.public(handler));
	}
	return board;
}
async function connect() {
	const socket = new WebSocket(server.wsUrl);
	const replies = new Map();
	const frames = [];
	socket.addEventListener('message', event => {
		const frame = JSON.parse(String(event.data));
		if (frame.topic === '__rpc') replies.set(frame.event, frame.data);
		else if (frame.topic?.startsWith('__crdt:')) frames.push(frame);
	});
	sockets.push(socket);
	await until(() => socket.readyState === WebSocket.OPEN);
	return { socket, replies, frames };
}
async function call(peer, suffix, args) {
	const id = 'document-check-' + nextId++;
	peer.socket.send(JSON.stringify({ rpc: 'authorization/board/' + suffix, id, args }));
	await until(() => peer.replies.has(id));
	return peer.replies.get(id);
}
async function setup(guard, extra = {}) {
	_resetLifecycle();
	register({ guard, ...extra });
	server = await createTestServer({ handler: realtime() });
	const writer = await connect();
	const observer = await connect();
	expect((await call(writer, 'sync', [[], 1])).ok).toBe(true);
	expect((await call(observer, 'sync', [[], 1])).ok).toBe(true);
	const draft = new Y.Doc();
	documents.push(draft);
	return { writer, observer, draft };
}
async function firstSyncServer(guard, extra = {}) {
	_resetLifecycle();
	register({ guard, ...extra });
	server = await createTestServer({ handler: realtime() });
	return connect();
}
function gateNextSubscription() {
	const subscribe = server.platform.subscribe;
	let release, first = true;
	server.platform.subscribe = function (...args) {
		const result = subscribe.apply(this, args);
		if (!first) return result;
		first = false;
		return new Promise(resolve => { release = () => { server.platform.subscribe = subscribe; resolve(result); }; });
	};
	return { ready: () => !!release, release: () => release() };
}
function deferredReadGuard() {
	const entered = new WeakSet(), pending = [];
	let gated = true;
	return {
		pending,
		guard(ctx) {
			if (!gated) return true;
			if (!entered.has(ctx)) { entered.add(ctx); return true; }
			return new Promise(resolve => { pending.push(resolve); });
		},
		allow() { gated = false; },
		releaseAll() { for (const resolve of pending) resolve(true); }
	};
}
function edit(doc, key, value) {
	const vector = Y.encodeStateVector(doc);
	doc.getMap('root').set(key, value);
	return Array.from(Y.encodeStateAsUpdate(doc, vector));
}
async function read(peer, args = [[], 1]) {
	const response = await call(peer, 'sync', args);
	expect(response.ok).toBe(true);
	const result = new Y.Doc();
	try {
		Y.applyUpdate(result, Uint8Array.from(response.data.diff));
		return result.getMap('root').toJSON();
	} finally { result.destroy(); }
}
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await server?.close();
	server = undefined;
	for (const doc of documents.splice(0)) doc.destroy();
	_resetCrdt();
	_prepareHmr();
});

it('rechecks current write rights without requiring a client-controlled resync', async () => {
	let write = true;
	const stored = [];
	const { writer, observer, draft } = await setup(() => ({ read: true, write }), {
		persist: { store: (_topic, bytes) => { stored.push(Array.from(bytes)); } },
		snapshotEvery: 1,
		debounceWait: 0,
		debounceMaxWait: 0
	});
	expect((await call(writer, 'update', [edit(draft, 'approved', 1)])).ok).toBe(true);
	expect(await read(observer)).toEqual({ approved: 1 });
	await until(() => stored.length > 0);
	const deliveries = observer.frames.length;
	const writes = stored.length;
	write = false;
	expect((await call(writer, 'update', [edit(draft, 'revoked', 2)])).ok).toBe(true);
	expect(await read(observer)).toEqual({ approved: 1 });
	expect(observer.frames.length).toBe(deliveries);
	expect(stored.length).toBe(writes);
	write = true;
	// A fresh independent writer update proves the authority still accepts work.
	const fresh = new Y.Doc(); documents.push(fresh);
	expect((await call(writer, 'update', [edit(fresh, 'restored', 3)])).ok).toBe(true);
	expect(await read(observer)).toEqual({ approved: 1, restored: 3 });
});

it('a newer denial invalidates an older pending permission check', async () => {
	let pending;
	let delayed = false;
	let write = true;
	const { writer, observer, draft } = await setup(() => delayed
		? new Promise(resolve => { pending = resolve; }) : { read: true, write });
	delayed = true;
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending);
	delayed = false;
	write = false;
	expect((await call(writer, 'update', [edit(draft, 'denied', 2)])).ok).toBe(true);
	pending({ read: true, write: true });
	expect((await older).ok).toBe(true);
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it('an old permission check cannot write after its mount was released and replaced', async () => {
	let pending;
	let delayed = false;
	const { writer, observer, draft } = await setup(() => delayed
		? new Promise(resolve => { pending = resolve; }) : true);
	delayed = true;
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending);
	expect((await call(writer, 'close', [1])).ok).toBe(true);
	delayed = false;
	expect((await call(writer, 'sync', [[], 2])).ok).toBe(true);
	pending(true);
	expect((await older).ok).toBe(true);
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it('a pending write cannot outlive a replacement declaration with a denying guard', async () => {
	let pending;
	let delayed = false;
	const { writer, observer, draft } = await setup(() => delayed
		? new Promise(resolve => { pending = resolve; }) : true);
	delayed = true;
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending);
	_prepareHmr();
	register({ guard: () => ({ read: true, write: false }) });
	pending(true);
	await older;
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it('a permission check settling after socket close cannot publish or change the authority', async () => {
	let pending;
	let delayed = false;
	const { writer, observer, draft } = await setup(() => delayed
		? new Promise(resolve => { pending = resolve; }) : true);
	delayed = true;
	writer.socket.send(JSON.stringify({ rpc: 'authorization/board/update', id: 'closing-write', args: [edit(draft, 'stale', 1)] }));
	await until(() => pending);
	writer.socket.close();
	await until(() => writer.socket.readyState === WebSocket.CLOSED);
	delayed = false;
	pending(true);
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it('a superseded first sync cannot install an older guard after a replacement declaration', async () => {
	let pending;
	_resetLifecycle();
	register({ guard: () => new Promise(resolve => { pending = resolve; }) });
	server = await createTestServer({ handler: realtime() });
	const writer = await connect();
	const first = call(writer, 'sync', [[], 1]);
	await until(() => pending);
	_prepareHmr();
	register({ guard: () => ({ read: true, write: false }) });
	pending(true);
	expect(await first).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect((await call(writer, 'sync', [[], 1])).data.access.write).toBe(false);
	const draft = new Y.Doc(); documents.push(draft);
	await call(writer, 'update', [edit(draft, 'denied', 1)]);
	expect(await read(writer)).toEqual({});
});

it('removed declarations refuse pending writes and rollback restores their current policy', async () => {
	let pending;
	let delayed = false;
	const { writer, observer, draft } = await setup(() => delayed
		? new Promise(resolve => { pending = resolve; }) : true);
	delayed = true;
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending);
	const previous = _prepareHmr();
	delayed = false;
	pending(true);
	await older;
	_restoreHmr(previous);
	expect(await read(observer)).toEqual({});
	const fresh = new Y.Doc(); documents.push(fresh);
	expect((await call(writer, 'update', [edit(fresh, 'recovered', 2)])).ok).toBe(true);
	expect(await read(observer)).toEqual({ recovered: 2 });
});

it('a removed first-sync declaration stays absent until an explicit rollback restores it', async () => {
	let pending;
	let delayed = true;
	_resetLifecycle();
	register({ guard: () => delayed ? new Promise(resolve => { pending = resolve; }) : true });
	server = await createTestServer({ handler: realtime() });
	const writer = await connect();
	const first = call(writer, 'sync', [[], 1]);
	await until(() => pending);
	const previous = _prepareHmr();
	delayed = false;
	pending(true);
	expect(await first).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(_crdtDecls.size).toBe(0);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
	_restoreHmr(previous);
	expect((await call(writer, 'sync', [[], 1])).ok).toBe(true);
	const draft = new Y.Doc(); documents.push(draft);
	expect((await call(writer, 'update', [edit(draft, 'recovered', 1)])).ok).toBe(true);
	expect(await read(writer)).toEqual({ recovered: 1 });
});

it('a declaration replaced during a real authority load cannot install an old read grant', async () => {
	let release, delayed = true;
	const writer = await firstSyncServer(() => true, { persist: {
		load: () => delayed ? new Promise(resolve => { release = resolve; }) : null
	} });
	const first = call(writer, 'sync', [[], 99]);
	await until(() => release);
	const previous = _prepareHmr();
	register({ guard: () => false });
	delayed = false;
	release(null);
	expect(await first).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(_crdtDecls.get('topic:authorization-board').authority.has('authorization-board')).toBe(false);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
	_restoreHmr(previous);
	expect((await call(writer, 'sync', [[], 1])).ok).toBe(true);
});

it('a declaration replaced during native subscription rolls back the uncommitted mount', async () => {
	const writer = await firstSyncServer(() => true);
	const gate = gateNextSubscription();
	const first = call(writer, 'sync', [[], 99]);
	await until(gate.ready);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(1);
	_prepareHmr();
	register({ guard: () => false });
	gate.release();
	expect(await first).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	const record = _crdtDecls.get('topic:authorization-board');
	expect(record.authority.has('authorization-board')).toBe(false);
	expect(record.accessByWs.get([...server.wsConnections][0])).toBeUndefined();
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
});

it('an old first sync preserves a newer successful same-topic mount during rollback', async () => {
	const writer = await firstSyncServer(() => true);
	const gate = gateNextSubscription();
	const first = call(writer, 'sync', [[], 99]);
	await until(gate.ready);
	_prepareHmr();
	register({ guard: () => true });
	expect((await call(writer, 'sync', [[], 2])).ok).toBe(true);
	gate.release();
	expect(await first).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	const record = _crdtDecls.get('topic:authorization-board');
	expect(record.authority.has('authorization-board')).toBe(true);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(1);
	await call(writer, 'close', [99]);
	expect(record.authority.has('authorization-board')).toBe(true);
	await call(writer, 'close', [2]);
	expect(record.authority.has('authorization-board')).toBe(false);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
});

it('an existing slot closed during subscription cannot be recreated without an acquire', async () => {
	const { writer, observer } = await setup(() => true);
	const gate = gateNextSubscription();
	const pending = call(writer, 'sync', [[], 2]);
	await until(gate.ready);
	await call(writer, 'close', [1]);
	gate.release();
	expect(await pending).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(1);
	await call(observer, 'close', [1]);
	expect(_crdtDecls.get('topic:authorization-board').authority.has('authorization-board')).toBe(false);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
});

it('an old existing-slot sync preserves a healthy replacement slot and its reference', async () => {
	const { writer, observer } = await setup(() => true);
	const gate = gateNextSubscription();
	const pending = call(writer, 'sync', [[], 2]);
	await until(gate.ready);
	await call(writer, 'close', [1]);
	expect((await call(writer, 'sync', [[], 3])).ok).toBe(true);
	gate.release();
	expect(await pending).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	const record = _crdtDecls.get('topic:authorization-board');
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(2);
	await call(writer, 'close', [2]);
	await call(observer, 'close', [1]);
	expect(record.authority.has('authorization-board')).toBe(true);
	await call(writer, 'close', [3]);
	expect(record.authority.has('authorization-board')).toBe(false);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
});

it('read access is rechecked after asynchronous native subscription', async () => {
	let allowed = true;
	const writer = await firstSyncServer(() => ({ read: allowed, write: allowed }));
	const gate = gateNextSubscription();
	const first = call(writer, 'sync', [[], 1]);
	await until(gate.ready);
	allowed = false;
	gate.release();
	expect(await first).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
	expect(_crdtDecls.get('topic:authorization-board').authority.has('authorization-board')).toBe(false);
	expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
});

it.each(['deny', 'throw', 'final-deny', 'final-throw'])('a newer %s sync invalidates an older pending write permission', async refusal => {
	let mode = 'allow', pending, syncChecks = 0;
	const { writer, observer, draft } = await setup(() => {
		if (mode === 'wait') return new Promise(resolve => { pending = resolve; });
		if (mode === 'deny') return false;
		if (mode === 'throw') throw new Error('Current access unavailable');
		if (mode.startsWith('final-')) {
			if (++syncChecks === 1) return true;
			if (mode === 'final-throw') throw new Error('Final access unavailable');
			return false;
		}
		return true;
	});
	mode = 'wait';
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending);
	mode = refusal;
	expect((await call(writer, 'sync', [[], 1])).ok).toBe(false);
	pending(true);
	await older;
	mode = 'allow';
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it('an explicit subscription permission refusal invalidates the pending document write', async () => {
	let waiting = false, pending;
	const { writer, observer, draft } = await setup(() => waiting
		? new Promise(resolve => { pending = resolve; }) : true);
	waiting = true;
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending);
	waiting = false;
	const subscribe = server.platform.subscribe;
	server.platform.subscribe = () => 'FORBIDDEN';
	expect(await call(writer, 'sync', [[], 1])).toMatchObject({ ok: false, code: 'FORBIDDEN' });
	server.platform.subscribe = subscribe;
	pending(true);
	await older;
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it('a denied dynamic sync never evaluates its topic factory or discards another document policy', async () => {
	let denyA = false, waitB = false, pending;
	const resolved = [];
	const writer = await firstSyncServer((_ctx, room) => {
		if (room === 'A' && denyA) return false;
		if (room === 'B' && waitB) return new Promise(resolve => { pending = resolve; });
		return true;
	}, { topic: (_ctx, room) => {
		resolved.push(room);
		if (room === 'A' && denyA) throw new Error('Denied topic factory evaluated');
		return 'authorization-board:' + room;
	} });
	expect((await call(writer, 'sync', ['A', [], 1])).ok).toBe(true);
	expect((await call(writer, 'sync', ['B', [], 1])).ok).toBe(true);
	const beforeA = resolved.filter(room => room === 'A').length;
	const draft = new Y.Doc(); documents.push(draft);
	waitB = true;
	const authorized = call(writer, 'update', ['B', edit(draft, 'approved', 1)]);
	await until(() => pending);
	denyA = true;
	expect(await call(writer, 'sync', ['A', [], 1])).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
	expect(resolved.filter(room => room === 'A')).toHaveLength(beforeA);
	waitB = false;
	pending(true);
	expect((await authorized).ok).toBe(true);
	expect(await read(writer, ['B', [], 1])).toEqual({ approved: 1 });
	denyA = false;
	expect(await read(writer, ['A', [], 1])).toEqual({});
});

it('each newer sync refusal requires a fresh stable permission decision', async () => {
	let mode = 'allow';
	const pending = [];
	const { writer, observer, draft } = await setup(() => {
		if (mode === 'wait') return new Promise(resolve => { pending.push(resolve); });
		return mode === 'allow';
	});
	mode = 'wait';
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending.length === 1);
	mode = 'deny';
	expect((await call(writer, 'sync', [[], 1])).ok).toBe(false);
	mode = 'wait';
	pending[0](true);
	await until(() => pending.length === 2);
	mode = 'deny';
	expect((await call(writer, 'sync', [[], 1])).ok).toBe(false);
	pending[1](true);
	await older;
	mode = 'allow';
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it('connection cancellation ends a pending permission recheck without publication', async () => {
	let mode = 'allow';
	const pending = [], contexts = [];
	const { writer, observer, draft } = await setup(ctx => {
		if (mode === 'wait') return new Promise(resolve => { pending.push(resolve); contexts.push(ctx); });
		return mode === 'allow';
	});
	mode = 'wait';
	writer.socket.send(JSON.stringify({ rpc: 'authorization/board/update', id: 'cancelled-recheck', args: [edit(draft, 'stale', 1)] }));
	await until(() => pending.length === 1);
	mode = 'deny';
	expect((await call(writer, 'sync', [[], 1])).ok).toBe(false);
	mode = 'wait';
	pending[0](true);
	await until(() => pending.length === 2);
	writer.socket.close();
	await until(() => writer.socket.readyState === WebSocket.CLOSED);
	expect(contexts[1].abortSignal.aborted).toBe(true);
	mode = 'allow';
	pending[1](true);
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});

it.each([1, 2])('a denied sibling preserves a still-pending mount and native delivery (mount %s)', async secondMount => {
	const access = deferredReadGuard();
	const writer = await firstSyncServer(access.guard);
	const first = call(writer, 'sync', [[], 1]);
	let second;
	try {
		await until(() => access.pending.length === 1);
		second = call(writer, 'sync', [[], secondMount]);
		await until(() => access.pending.length === 2);
		access.pending[0](false);
		expect((await first).ok).toBe(false);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(1);
		access.allow();
		access.pending[1](true);
		expect((await second).ok).toBe(true);
		const observer = await connect();
		expect((await call(observer, 'sync', [[], 1])).ok).toBe(true);
		const draft = new Y.Doc(); documents.push(draft);
		expect((await call(observer, 'update', [edit(draft, 'delivered', 1)])).ok).toBe(true);
		await until(() => writer.frames.some(frame => frame.data?.op === 'update'));
		const record = _crdtDecls.get('topic:authorization-board');
		expect(record.authority.has('authorization-board')).toBe(true);
		await call(writer, 'close', [secondMount]);
		await call(observer, 'close', [1]);
		expect(record.authority.has('authorization-board')).toBe(false);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
	} finally { access.releaseAll(); await Promise.allSettled([first, second]); }
});

it('the last denied duplicate sync releases its reference and native membership', async () => {
	const access = deferredReadGuard();
	const writer = await firstSyncServer(access.guard);
	const first = call(writer, 'sync', [[], 1]);
	let second;
	try {
		await until(() => access.pending.length === 1);
		second = call(writer, 'sync', [[], 1]);
		await until(() => access.pending.length === 2);
		access.pending[0](false);
		expect((await first).ok).toBe(false);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(1);
		access.pending[1](false);
		expect((await second).ok).toBe(false);
		const record = _crdtDecls.get('topic:authorization-board');
		expect(record.authority.has('authorization-board')).toBe(false);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
		access.allow();
		expect((await call(writer, 'sync', [[], 3])).ok).toBe(true);
		await call(writer, 'close', [3]);
		expect(record.authority.has('authorization-board')).toBe(false);
	} finally { access.releaseAll(); await Promise.allSettled([first, second]); }
});

it('retiring a pre-reset sync cannot remove a new pending owner membership or reference', async () => {
	const old = deferredReadGuard(), current = deferredReadGuard();
	const writer = await firstSyncServer(old.guard);
	const first = call(writer, 'sync', [[], 1]);
	let second;
	try {
		await until(() => old.pending.length === 1);
		_resetCrdt();
		register({ guard: current.guard });
		second = call(writer, 'sync', [[], 2]);
		await until(() => current.pending.length === 1);
		old.pending[0](false);
		expect((await first).ok).toBe(false);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(1);
		current.allow();
		current.pending[0](true);
		expect((await second).ok).toBe(true);
		const record = _crdtDecls.get('topic:authorization-board');
		expect(record.authority.has('authorization-board')).toBe(true);
		await call(writer, 'close', [2]);
		expect(record.authority.has('authorization-board')).toBe(false);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
	} finally { old.releaseAll(); current.releaseAll(); await Promise.allSettled([first, second]); }
});

it.each([false, true])('closing a pending mount retires its claim and preserves a replacement (reopen=%s)', async reopen => {
	const access = deferredReadGuard();
	const writer = await firstSyncServer(access.guard);
	const first = call(writer, 'sync', [[], 99]);
	try {
		await until(() => access.pending.length === 1);
		await call(writer, 'close', [99]);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(0);
		access.allow();
		if (reopen) expect((await call(writer, 'sync', [[], 99])).ok).toBe(true);
		access.pending[0](true);
		expect(await first).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
		const record = _crdtDecls.get('topic:authorization-board');
		expect(record.authority.has('authorization-board')).toBe(reopen);
		expect(server.platform.subscribers('__crdt:authorization-board')).toBe(reopen ? 1 : 0);
		if (reopen) await call(writer, 'close', [99]);
		expect(record.authority.has('authorization-board')).toBe(false);
	} finally { access.releaseAll(); await Promise.allSettled([first]); }
});

it('a rejected guard invalidates older pending permission checks', async () => {
	let pending;
	let mode = 'allow';
	const { writer, observer, draft } = await setup(() => {
		if (mode === 'delay') return new Promise(resolve => { pending = resolve; });
		if (mode === 'reject') throw new Error('Current policy unavailable');
		return true;
	});
	mode = 'delay';
	const older = call(writer, 'update', [edit(draft, 'stale', 1)]);
	await until(() => pending);
	mode = 'reject';
	expect((await call(writer, 'update', [edit(draft, 'denied', 2)])).ok).toBe(false);
	pending(true);
	await older;
	mode = 'allow';
	expect(await read(observer)).toEqual({});
	expect(observer.frames).toEqual([]);
});
