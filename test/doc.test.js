// CRDT documents: live.doc()/live.map()/live.array() registration, the
// sync/update/close handlers, the {read, write, comment} access record
// (boolean widening and enforcement on the update path), the close
// drain, HMR record survival, and the vite codegen surfaces. The replica
// authority and wire codec live in the adapter and are tested there; these
// tests inject a scripted runtime through the _setCrdtRuntime seam and
// assert the orchestration contract around it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
	live,
	handleRpc,
	__register,
	close,
	_setCrdtRuntime,
	_resetCrdt,
	_prepareHmr,
	_restoreHmr,
	_crdtLoadError,
	LiveError
} from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { WS_SUBSCRIPTIONS } from 'svelte-adapter-uws/testing';
import { mockPlatform } from './helpers/mock-platform.js';
import { enforceClusterPublishPolicy } from './helpers/cluster-publish-policy.js';
import svelteRealtime from '../src/vite.js';
import { _purgeCrdtDocs } from '../src/server/crdt.js';
import { REALTIME_ERROR_IDS, realtimeErrorDefinition } from '../src/error-registry.js';
import * as Y from 'yjs';
import { createCrdtAuthority, normalizeCrdtAccess } from 'svelte-adapter-uws/plugins/crdt/replica';
import { createCrdtWireCodec, CRDT_TOPIC_PREFIX } from 'svelte-adapter-uws/plugins/crdt';

const textEncoder = new TextEncoder();
const toArrayBuffer = (obj) => textEncoder.encode(JSON.stringify(obj)).buffer;

let _id = 0;

/** Invoke a registered handler and return the RPC reply payload. */
async function call(ws, platform, path, args) {
	const before = platform.sent.length;
	handleRpc(ws, toArrayBuffer({ rpc: path, id: 'c' + ++_id, args }), platform);
	await vi.advanceTimersByTimeAsync(1);
	return platform.sent[before]?.data;
}

/** Invoke a no-reply handler (update/close) and let it settle. */
async function fire(ws, platform, path, args) {
	handleRpc(ws, toArrayBuffer({ rpc: path, args }), platform);
	await vi.advanceTimersByTimeAsync(1);
}

/** The boolean-widening / partial-record normalization the adapter ships. */
function normalizeAccess(value) {
	if (value !== null && typeof value === 'object') {
		return { read: !!value.read, write: !!value.write, comment: !!value.comment };
	}
	const b = !!value;
	return { read: b, write: b, comment: b };
}

/**
 * A scripted CRDT runtime: records every orchestration call and serves
 * canned diff/vector bytes, so the tests pin exactly what realtime asks of
 * the authority and what it does with the answers.
 */
function fakeRuntime(overrides = {}) {
	const calls = { acquire: [], release: [], apply: [], diff: [], stateVector: [], destroyed: 0 };
	const loaded = new Set();
	// Capture the persist hooks realtime passes so a test can drive a store
	// through the real store closure (the leader-gating lives there).
	let persist = null;
	const authority = {
		_persist: () => persist,
		acquire(topic) {
			calls.acquire.push(topic);
			if (overrides.acquire) return overrides.acquire(topic);
			loaded.add(topic);
			return Promise.resolve();
		},
		release(topic) {
			calls.release.push(topic);
		},
		applyUpdate(topic, bytes) {
			calls.apply.push({ topic, bytes });
			if (overrides.applyUpdate) return overrides.applyUpdate(topic, bytes);
			return new Uint8Array(bytes);
		},
		diff(topic, sv) {
			calls.diff.push({ topic, sv });
			return new Uint8Array([1, 2, 3]);
		},
		stateVector(topic) {
			calls.stateVector.push(topic);
			return new Uint8Array([9]);
		},
		has(topic) {
			return loaded.has(topic);
		},
		destroy() {
			calls.destroyed++;
		}
	};
	return {
		calls,
		authority,
		mod: {
			CRDT_TOPIC_PREFIX: '__crdt:',
			normalizeCrdtAccess: normalizeAccess,
			createCrdtAuthority: (opts) => { persist = opts && opts.persist; return authority; },
			createCrdtWireCodec: () => ({ capability: 'crdt.protocol:1', schemaVersion: 1, encode: () => null })
		}
	};
}

/**
 * A fake cluster coordinator (the shape realtime detects as platform.crdt):
 * records relayed updates and sync requests, exposes the handlers realtime
 * registers so a test can drive inbound relay, and scripts acquirePersist.
 */
function fakeCrdtCluster(overrides = {}) {
	const calls = { relayed: [], syncRequested: [], syncReplied: [], acquirePersist: [] };
	let handlers = null;
	return {
		calls,
		instanceId: 'fake-instance',
		onMessage(h) { handlers = h; },
		deliverUpdate(declKey, topic, bytes) { if (handlers && handlers.onUpdate) handlers.onUpdate(declKey, topic, bytes); },
		deliverSyncRequest(declKey, topic, sv, from) { if (handlers && handlers.onSyncRequest) handlers.onSyncRequest(declKey, topic, sv, from); },
		deliverSyncReply(declKey, topic, bytes) { if (handlers && handlers.onSyncReply) handlers.onSyncReply(declKey, topic, bytes); },
		relayUpdate(declKey, topic, bytes) { calls.relayed.push({ declKey, topic, bytes }); },
		requestSync(declKey, topic, sv) { calls.syncRequested.push({ declKey, topic, sv }); },
		sendSyncReply(declKey, topic, bytes, to) { calls.syncReplied.push({ declKey, topic, bytes, to }); },
		acquirePersist(topic) {
			calls.acquirePersist.push(topic);
			if (overrides.acquirePersist) return overrides.acquirePersist(topic);
			return Promise.resolve(true);
		},
		...(overrides.acquirePersistDetailed
			? {
					acquirePersistDetailed(topic) {
						(calls.acquirePersistDetailed ??= []).push(topic);
						return overrides.acquirePersistDetailed(topic);
					}
				}
			: {})
	};
}

/** A mock platform extended with recording wire methods. */
function wirePlatform() {
	const p = mockPlatform();
	p.wirePublished = [];
	p.unsubscribed = [];
	p.publishWire = (topic, event, data, codec, options) => {
		p.wirePublished.push({ topic, event, data, options });
		return true;
	};
	p.unsubscribe = (ws, topic) => {
		p.unsubscribed.push(topic);
	};
	enforceClusterPublishPolicy(p);
	return p;
}

function registerDoc(moduleName, docExport) {
	__register(moduleName + '/board/__doc/sync', docExport.__docSync, moduleName);
	__register(moduleName + '/board/__doc/update', docExport.__docUpdate, moduleName);
	__register(moduleName + '/board/__doc/close', docExport.__docClose, moduleName);
}

let moduleSeq = 0;

function declareBoard(extra = {}) {
	const name = 'doc' + ++moduleSeq;
	const board = live.doc({
		// the seq in the topic keys a fresh declaration record per test
		topic: (ctx, roomId) => 'board' + moduleSeq + ':' + roomId,
		topicArgs: 1,
		...extra
	});
	registerDoc(name, board);
	return { name, board, topic: (roomId) => 'board' + moduleSeq + ':' + roomId };
}

describe('live.doc config validation', () => {
	it('rejects malformed configs eagerly', () => {
		expect(() => live.doc()).toThrow('config object');
		expect(() => live.doc({})).toThrow('topic');
		expect(() => live.doc({ topic: 't', guard: 'x' })).toThrow('guard');
		expect(() => live.doc({ topic: 't', persist: 5 })).toThrow('persist');
		expect(() => live.doc({ topic: 't', debounceWait: -1 })).toThrow('debounceWait');
		expect(() => live.doc({ topic: 't', snapshotEvery: 'lots' })).toThrow('snapshotEvery');
	});

	it('marks the export with its kind for the codegen surfaces', () => {
		expect(live.doc({ topic: 'a' + ++moduleSeq }).__docKind).toBe('doc');
		expect(live.map({ topic: 'b' + ++moduleSeq }).__docKind).toBe('map');
		expect(live.array({ topic: 'c' + ++moduleSeq }).__docKind).toBe('array');
		expect(live.map({ topic: 'd' + ++moduleSeq }).__isDoc).toBe(true);
	});
});

describe('live.doc sync', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setCrdtRuntime(rt.mod);
	});
	afterEach(() => {
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	it('loads the replica, subscribes the socket, and returns the exchange', async () => {
		const { name, topic } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		const res = await call(ws, platform, name + '/board/__doc/sync', ['r1', [0]]);
		expect(res.ok).toBe(true);
		expect(res.data.topic).toBe(topic('r1'));
		expect(typeof res.data.t).toBe('number');
		expect(res.data.access).toEqual({ read: true, write: true, comment: true });
		expect(res.data.diff).toEqual([1, 2, 3]);
		expect(res.data.sv).toEqual([9]);
		expect(ws.isSubscribed('__crdt:' + topic('r1'))).toBe(true);
		expect(rt.calls.acquire).toEqual([topic('r1')]);
		expect(rt.calls.diff[0].sv).toEqual([0]); // the client vector reached the diff
	});

	it('widens a boolean guard and enforces a record guard', async () => {
		const { name } = declareBoard({ guard: () => true });
		const res = await call(mockWs({ id: 'u1' }), wirePlatform(), name + '/board/__doc/sync', ['r1', []]);
		expect(res.data.access).toEqual({ read: true, write: true, comment: true });

		const ro = declareBoard({ guard: () => ({ read: true }) });
		const res2 = await call(mockWs({ id: 'u2' }), wirePlatform(), ro.name + '/board/__doc/sync', ['r1', []]);
		expect(res2.data.access).toEqual({ read: true, write: false, comment: false });
	});

	it('denies the sync when the guard refuses read', async () => {
		const { name } = declareBoard({ guard: () => false });
		const res = await call(mockWs({ id: 'u1' }), wirePlatform(), name + '/board/__doc/sync', ['r1', []]);
		expect(res.ok).toBe(false);
		expect(res.code).toBe('FORBIDDEN');
		expect(rt.calls.acquire).toHaveLength(0); // denied before any load
	});

	it('propagates a throwing guard before resolving anything', async () => {
		const { name } = declareBoard({
			guard: async (ctx, roomId) => {
				if (roomId === 'locked') throw new Error('denied');
				return true;
			}
		});
		const res = await call(mockWs({ id: 'u1' }), wirePlatform(), name + '/board/__doc/sync', ['locked', []]);
		expect(res.ok).toBe(false);
		expect(rt.calls.acquire).toHaveLength(0);
	});

	it('does not double-acquire on a re-sync from the same socket, but refreshes access', async () => {
		let writeAllowed = true;
		const { name } = declareBoard({ guard: () => ({ read: true, write: writeAllowed }) });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		const first = await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		expect(first.data.access.write).toBe(true);
		writeAllowed = false; // a downgrade lands at the next sync
		const second = await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		expect(second.data.access.write).toBe(false);
		expect(rt.calls.acquire).toHaveLength(1);
		expect(rt.calls.release).toHaveLength(0);
	});

	it('surfaces a subscribe denial and releases the acquired reference', async () => {
		const { name } = declareBoard();
		const platform = wirePlatform();
		platform.checkSubscribe = () => 'FORBIDDEN';
		const res = await call(mockWs({ id: 'u1' }), platform, name + '/board/__doc/sync', ['r1', []]);
		expect(res.ok).toBe(false);
		expect(res.code).toBe('FORBIDDEN');
		expect(rt.calls.acquire).toHaveLength(1);
		expect(rt.calls.release).toHaveLength(1);
	});

	it('records the wire topic in the adapter registry when the platform has no subscribe', async () => {
		const { name, topic } = declareBoard();
		const platform = wirePlatform();
		delete platform.subscribe;
		const ws = mockWs({ id: 'u1', [WS_SUBSCRIPTIONS]: new Set() });
		const res = await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		expect(res.ok).toBe(true);
		expect(ws.getUserData()[WS_SUBSCRIPTIONS].has('__crdt:' + topic('r1'))).toBe(true);
	});

	it('refuses a sync at the subscription cap when the platform has no subscribe', async () => {
		const { name } = declareBoard();
		const platform = wirePlatform();
		delete platform.subscribe;
		const full = new Set(Array.from({ length: 65536 }, (_, i) => 'held:' + i));
		const ws = mockWs({ id: 'u1', [WS_SUBSCRIPTIONS]: full });
		const res = await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
		expect(res.error).toContain('RATE_LIMITED');
		expect(rt.calls.acquire).toHaveLength(1);
		expect(rt.calls.release).toHaveLength(1);
		expect(full.size).toBe(65536);
	});

	it('reports a failed replica load as an actionable INTERNAL error', async () => {
		_resetCrdt();
		const failing = fakeRuntime({ acquire: () => Promise.reject(new Error('db down')) });
		_setCrdtRuntime(failing.mod);
		const { name } = declareBoard();
		const res = await call(mockWs({ id: 'u1' }), wirePlatform(), name + '/board/__doc/sync', ['r1', []]);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('document load failed');
		expect(res.error).toContain('db down');
	});

	it('releases the reference when the socket closed mid-sync', async () => {
		let resolveAcquire;
		_resetCrdt();
		const gated = fakeRuntime({ acquire: () => new Promise((r) => { resolveAcquire = r; }) });
		_setCrdtRuntime(gated.mod);
		const { name } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		handleRpc(ws, toArrayBuffer({ rpc: name + '/board/__doc/sync', id: 'c' + ++_id, args: ['r1', []] }), platform);
		await vi.advanceTimersByTimeAsync(1);
		close(ws, { platform }); // the socket dies while the load is pending
		resolveAcquire();
		await vi.advanceTimersByTimeAsync(1);
		const res = platform.sent[platform.sent.length - 1]?.data;
		expect(res.ok).toBe(false);
		expect(gated.calls.acquire).toHaveLength(1);
		expect(gated.calls.release).toHaveLength(1); // no leaked reference
	});
});

describe('live.doc update path', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setCrdtRuntime(rt.mod);
	});
	afterEach(() => {
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	it('applies an authorized update and fans it out excluding the sender', async () => {
		const { name, topic } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [5, 6, 7]]);
		expect(rt.calls.apply).toEqual([{ topic: topic('r1'), bytes: [5, 6, 7] }]);
		expect(platform.wirePublished).toHaveLength(1);
		const pub = platform.wirePublished[0];
		expect(pub.topic).toBe('__crdt:' + topic('r1'));
		expect(pub.event).toBe('crdt');
		expect(pub.data).toEqual({ op: 'update', bytes: [5, 6, 7] });
		expect(pub.options.excludeWs).toBe(ws);
	});

	it('drops an update from a connection that never synced', async () => {
		const { name } = declareBoard();
		const synced = mockWs({ id: 'u1' });
		const stranger = mockWs({ id: 'u2' });
		const platform = wirePlatform();
		await call(synced, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(stranger, platform, name + '/board/__doc/update', ['r1', [1]]);
		expect(rt.calls.apply).toHaveLength(0);
		expect(platform.wirePublished).toHaveLength(0);
	});

	it('drops an update from a read-only connection (the current guard gates it)', async () => {
		const { name } = declareBoard({ guard: () => ({ read: true }) });
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [1]]);
		expect(rt.calls.apply).toHaveLength(0);
		expect(platform.wirePublished).toHaveLength(0);
	});

	it('drops an update for a different document than the one synced', async () => {
		const { name } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(ws, platform, name + '/board/__doc/update', ['r2', [1]]);
		expect(rt.calls.apply).toHaveLength(0);
	});

	it('does not fan out when the authority rejects the bytes', async () => {
		_resetCrdt();
		const rejecting = fakeRuntime({ applyUpdate: () => null });
		_setCrdtRuntime(rejecting.mod);
		const { name } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [255]]);
		expect(rejecting.calls.apply).toHaveLength(1);
		expect(platform.wirePublished).toHaveLength(0);
	});

	it('falls back to a JSON publish on a platform without publishWire', async () => {
		const { name, topic } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform(); // no publishWire
		enforceClusterPublishPolicy(platform);
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [5]]);
		const pub = platform.published.find((p) => p.topic === '__crdt:' + topic('r1'));
		expect(pub).toBeDefined();
		expect(pub.data).toEqual({ op: 'update', bytes: [5] });
	});
});

describe('live.doc close and drain', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setCrdtRuntime(rt.mod);
	});
	afterEach(() => {
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	it('releases one mount on __doc/close and unsubscribes the wire topic', async () => {
		const { name, topic } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(ws, platform, name + '/board/__doc/close', ['r1']);
		expect(rt.calls.release).toEqual([topic('r1')]);
		expect(platform.unsubscribed).toEqual(['__crdt:' + topic('r1')]);
		// a second close is a no-op (the reference is already gone)
		await fire(ws, platform, name + '/board/__doc/close', ['r1']);
		expect(rt.calls.release).toHaveLength(1);
		// updates after close are unauthorized again
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [1]]);
		expect(rt.calls.apply).toHaveLength(0);
	});

	it('releases every held document on socket close', async () => {
		const { name, topic } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await call(ws, platform, name + '/board/__doc/sync', ['r2', []]);
		close(ws, { platform });
		expect(rt.calls.release.sort()).toEqual([topic('r1'), topic('r2')].sort());
	});

	it('ignores updates arriving after the socket close', async () => {
		const { name } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		close(ws, { platform });
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [1]]);
		expect(rt.calls.apply).toHaveLength(0);
	});
});

describe('live.doc mount counting (several stores, one connection, one document)', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setCrdtRuntime(rt.mod);
	});
	afterEach(() => {
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	it('holds one reference across two mounts; the first close keeps the survivor live', async () => {
		const { name, topic } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		// Two distinct client stores (distinct mount ids) on one connection
		// resolve to the same document.
		await call(ws, platform, name + '/board/__doc/sync', ['r1', [], 11]);
		await call(ws, platform, name + '/board/__doc/sync', ['r1', [], 22]);
		expect(rt.calls.acquire).toEqual([topic('r1')]); // one reference, not two

		// First store closes: the document stays subscribed and authorized.
		await fire(ws, platform, name + '/board/__doc/close', ['r1', 11]);
		expect(rt.calls.release).toHaveLength(0);
		expect(platform.unsubscribed).toHaveLength(0);
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [9]]);
		expect(rt.calls.apply).toHaveLength(1); // the survivor still writes

		// Last store closes: now the reference releases and the topic unsubscribes.
		await fire(ws, platform, name + '/board/__doc/close', ['r1', 22]);
		expect(rt.calls.release).toEqual([topic('r1')]);
		expect(platform.unsubscribed).toEqual(['__crdt:' + topic('r1')]);
	});

	it('releases the surplus reference when two first-syncs race a slow load', async () => {
		const acquires = [];
		const gate = [];
		_resetCrdt();
		const gated = fakeRuntime({ acquire: (t) => new Promise((r) => { acquires.push(t); gate.push(r); }) });
		_setCrdtRuntime(gated.mod);
		const { name, topic } = declareBoard();
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		// Two syncs dispatched before either's acquire resolves: both observe
		// no slot yet, so both acquire.
		handleRpc(ws, toArrayBuffer({ rpc: name + '/board/__doc/sync', id: 'c' + ++_id, args: ['r1', [], 11] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: name + '/board/__doc/sync', id: 'c' + ++_id, args: ['r1', [], 22] }), platform);
		await vi.advanceTimersByTimeAsync(1);
		expect(acquires.length).toBe(2); // both acquired against the coalesced load
		gate.forEach((r) => r());
		await vi.advanceTimersByTimeAsync(1);
		// Exactly one net reference survives (the second registration released
		// its surplus); both mounts share the one slot.
		expect(gated.calls.release).toHaveLength(1);
		await fire(ws, platform, name + '/board/__doc/close', ['r1', 11]);
		expect(gated.calls.release).toHaveLength(1); // survivor keeps it
		await fire(ws, platform, name + '/board/__doc/close', ['r1', 22]);
		expect(gated.calls.release).toHaveLength(2); // last mount releases
		expect(gated.calls.release[1]).toBe(topic('r1'));
	});
});

describe('live.doc declaration hygiene', () => {
	let rt;
	let warnSpy;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setCrdtRuntime(rt.mod);
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	it('warns when two live declarations share one string topic', () => {
		live.doc({ topic: 'shared-topic-xyz' });
		expect(warnSpy).not.toHaveBeenCalled();
		live.map({ topic: 'shared-topic-xyz' });
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain('share the topic');
	});

	it('does not leak a reference for a ws-less (direct) sync', async () => {
		const { board } = declareBoard();
		const platform = wirePlatform();
		// A direct server-side invocation has ctx.ws == null (the shape
		// __directCall builds): the exchange snapshot is served but nothing is
		// held, so the just-acquired reference releases instead of leaking.
		const reply = await board.__docSync({ platform, ws: null }, 'r1', []);
		expect(reply.topic).toBe('board' + moduleSeq + ':r1');
		expect(rt.calls.acquire).toHaveLength(1);
		expect(rt.calls.release).toEqual(rt.calls.acquire); // acquired then released
	});
});

describe('live.doc cluster wiring (platform.crdt)', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setCrdtRuntime(rt.mod);
	});
	afterEach(() => {
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	/** A platform carrying a fake cluster coordinator. */
	function clusterPlatform(crdt) {
		const p = wirePlatform();
		p.crdt = crdt;
		return p;
	}

	it('relays an applied update to peers (declKey, topic, bytes as number[])', async () => {
		const { name, topic } = declareBoard();
		const crdt = fakeCrdtCluster();
		const ws = mockWs({ id: 'u1' });
		const platform = clusterPlatform(crdt);
		await call(ws, platform, name + '/board/__doc/sync', ['r1', []]);
		await fire(ws, platform, name + '/board/__doc/update', ['r1', [5, 6, 7]]);
		expect(crdt.calls.relayed).toHaveLength(1);
		const relayed = crdt.calls.relayed[0];
		expect(relayed.topic).toBe(topic('r1'));
		expect(relayed.bytes).toEqual([5, 6, 7]); // number[], not a Uint8Array
		expect(Array.isArray(relayed.bytes)).toBe(true);
	});

	it('requests a cold-join sync once per cold load and wires the relay loop once', async () => {
		const { name, topic } = declareBoard();
		const crdt = fakeCrdtCluster();
		const ws = mockWs({ id: 'u1' });
		const platform = clusterPlatform(crdt);
		await call(ws, platform, name + '/board/__doc/sync', ['r1', [4]]);
		expect(crdt.calls.syncRequested).toHaveLength(1);
		expect(crdt.calls.syncRequested[0]).toMatchObject({ topic: topic('r1') });
		// A re-sync of the same held mount does NOT re-request (not a cold load).
		await call(ws, platform, name + '/board/__doc/sync', ['r1', [4]]);
		expect(crdt.calls.syncRequested).toHaveLength(1);
	});

	// String topics give a predictable declKey ('topic:' + the string), so a
	// test can deliver an inbound relay frame keyed exactly as the record
	// registered it.
	let stringSeq = 0;
	function declareStringBoard(extra = {}) {
		const t = 'sboard' + ++stringSeq;
		const board = live.doc({ topic: t, ...extra });
		const n = 'sdoc' + stringSeq;
		registerDoc(n, board);
		return { name: n, board, topic: t, declKey: 'topic:' + t };
	}

	it('applies a peer-relayed update to the local replica and fans it out (no exclude)', async () => {
		const { name, topic, declKey } = declareStringBoard();
		const crdt = fakeCrdtCluster();
		const ws = mockWs({ id: 'u1' });
		const platform = clusterPlatform(crdt);
		await call(ws, platform, name + '/board/__doc/sync', []);
		const beforeApply = rt.calls.apply.length;
		const beforePub = platform.wirePublished.length;
		crdt.deliverUpdate(declKey, topic, [8, 9]);
		expect(rt.calls.apply).toHaveLength(beforeApply + 1);
		expect(rt.calls.apply[beforeApply]).toEqual({ topic, bytes: [8, 9] });
		// Fanned out locally with no excludeWs (the originator is on a peer).
		expect(platform.wirePublished).toHaveLength(beforePub + 1);
		expect(platform.wirePublished[beforePub].options).toEqual({ seq: false });
	});

	it('ignores a peer-relayed update for a document this instance does not hold', async () => {
		const { name } = declareStringBoard();
		const crdt = fakeCrdtCluster();
		const ws = mockWs({ id: 'u1' });
		const platform = clusterPlatform(crdt);
		await call(ws, platform, name + '/board/__doc/sync', []);
		const beforeApply = rt.calls.apply.length;
		crdt.deliverUpdate('topic:some-other-doc', 'some-other-doc', [1]);
		expect(rt.calls.apply).toHaveLength(beforeApply); // not held: ignored
	});

	it('answers a peer sync request from the local replica when it holds the topic', async () => {
		const { name, topic, declKey } = declareStringBoard();
		const crdt = fakeCrdtCluster();
		const ws = mockWs({ id: 'u1' });
		const platform = clusterPlatform(crdt);
		await call(ws, platform, name + '/board/__doc/sync', []);
		crdt.deliverSyncRequest(declKey, topic, [3], 'peer-1');
		expect(crdt.calls.syncReplied).toHaveLength(1);
		expect(crdt.calls.syncReplied[0]).toMatchObject({ topic, to: 'peer-1', bytes: [1, 2, 3] });
		// A request for an unheld document is a safe no-op.
		crdt.deliverSyncRequest('topic:not-held', 'not-held', [0], 'peer-2');
		expect(crdt.calls.syncReplied).toHaveLength(1);
	});

	it('leader-gates the persist store: writes when it holds the lease, skips when it does not', async () => {
		const stores = [];
		const persist = { load: async () => null, store: (t, b) => { stores.push({ t, b }); } };

		// Lease granted -> the app store runs.
		const granted = declareStringBoard({ persist });
		const crdtYes = fakeCrdtCluster({ acquirePersist: () => Promise.resolve(true) });
		await call(mockWs({ id: 'u1' }), clusterPlatform(crdtYes), granted.name + '/board/__doc/sync', []);
		await rt.authority._persist().store(granted.topic, new Uint8Array([1]));
		expect(crdtYes.calls.acquirePersist).toEqual([granted.topic]);
		// The lease holder writes the replica's state after the lease (the
		// scripted authority's full-state diff), not the bytes handed in.
		expect(stores).toEqual([{ t: granted.topic, b: new Uint8Array([1, 2, 3]) }]);

		// Lease denied (another instance is the writer) -> the app store is skipped.
		stores.length = 0;
		const denied = declareStringBoard({ persist });
		const crdtNo = fakeCrdtCluster({ acquirePersist: () => Promise.resolve(false) });
		await call(mockWs({ id: 'u2' }), clusterPlatform(crdtNo), denied.name + '/board/__doc/sync', []);
		await rt.authority._persist().store(denied.topic, new Uint8Array([2]));
		expect(crdtNo.calls.acquirePersist).toEqual([denied.topic]);
		expect(stores).toEqual([]); // skipped: the lease holder persists
	});

	it('a Redis error from acquirePersist propagates so the schedule retries', async () => {
		const persist = { load: async () => null, store: () => {} };
		const errored = declareStringBoard({ persist });
		const crdt = fakeCrdtCluster({ acquirePersist: () => Promise.reject(new Error('redis down')) });
		await call(mockWs({ id: 'u1' }), clusterPlatform(crdt), errored.name + '/board/__doc/sync', []);
		await expect(rt.authority._persist().store(errored.topic, new Uint8Array([1]))).rejects.toThrow('redis down');
	});
});

describe('live.doc cluster persistence and sync replies (real replica)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		_setCrdtRuntime({ createCrdtAuthority, normalizeCrdtAccess, createCrdtWireCodec, CRDT_TOPIC_PREFIX });
	});
	afterEach(() => {
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	let seq = 0;
	function declare(extra = {}) {
		const t = 'pboard' + ++seq;
		const board = live.doc({ topic: t, ...extra });
		const n = 'pdoc' + seq;
		registerDoc(n, board);
		return { name: n, topic: t, declKey: 'topic:' + t };
	}

	/** One client edit as Yjs update bytes. */
	function edit(key, value, base) {
		const doc = new Y.Doc();
		if (base) Y.applyUpdate(doc, base);
		const sv = Y.encodeStateVector(doc);
		doc.getMap('m').set(key, value);
		return Y.encodeStateAsUpdate(doc, sv);
	}
	function decode(...updates) {
		const doc = new Y.Doc();
		for (const u of updates) Y.applyUpdate(doc, new Uint8Array(u));
		return doc.getMap('m').toJSON();
	}

	/** A lease whose first grant the test releases by hand. */
	function heldLease() {
		let grant;
		const first = new Promise((resolve) => { grant = resolve; });
		let calls = 0;
		const crdt = fakeCrdtCluster({ acquirePersist: () => (++calls === 1 ? first : Promise.resolve(true)) });
		return { crdt, grant: () => grant(true) };
	}

	it('persists the replica state after the lease, including what merged while waiting for it', async () => {
		const stores = [];
		const { name, topic, declKey } = declare({
			snapshotEvery: 1,
			persist: { load: async () => null, store: (t, b) => { stores.push(Array.from(b)); } }
		});
		const { crdt, grant } = heldLease();
		const platform = wirePlatform();
		platform.crdt = crdt;
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/board/__doc/sync', []);
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('a', 1))]);
		expect(crdt.calls.acquirePersist).toEqual([topic]);
		// A peer's edit lands while the first write waits for the lease.
		crdt.deliverUpdate(declKey, topic, Array.from(edit('b', 2)));
		grant();
		await vi.advanceTimersByTimeAsync(1);
		expect(stores.length).toBeGreaterThanOrEqual(1);
		expect(decode(stores[0])).toEqual({ a: 1, b: 2 });
	});

	it('prints a failed store without onError under its stable error ID', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const { name, topic } = declare({
				snapshotEvery: 1,
				persist: { load: async () => null, store: () => { throw new Error('disk full'); } }
			});
			const { crdt, grant } = heldLease();
			const platform = wirePlatform();
			platform.crdt = crdt;
			const ws = mockWs({ id: 'u1' });
			await call(ws, platform, name + '/board/__doc/sync', []);
			await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('a', 1))]);
			grant();
			await vi.advanceTimersByTimeAsync(1);
			const definition = realtimeErrorDefinition(REALTIME_ERROR_IDS.DOC_PERSIST);
			const line = errSpy.mock.calls.find(([message]) => String(message).startsWith(definition.messagePrefix));
			expect(line, 'persist failure line').toBeDefined();
			expect(line[0]).toContain('store for "' + topic + '"');
			expect(line[0]).toContain('[' + definition.id + '] See: ' + definition.help);
			expect(line[1]).toBeInstanceOf(Error);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('does not persist a document erased while its write waited for the lease', async () => {
		const stores = [];
		const { name, topic } = declare({
			snapshotEvery: 1,
			persist: { load: async () => null, store: (t, b) => { stores.push(Array.from(b)); } }
		});
		const { crdt, grant } = heldLease();
		const platform = wirePlatform();
		platform.crdt = crdt;
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/board/__doc/sync', []);
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('secret', 1))]);
		expect(crdt.calls.acquirePersist).toEqual([topic]);
		expect(_purgeCrdtDocs([topic])).toBe(1);
		grant();
		await vi.advanceTimersByTimeAsync(1);
		expect(stores).toEqual([]);
	});

	/**
	 * A document whose stored snapshot the test can replace, as the previous
	 * lease holder would, and a detailed lease that reports the scripted
	 * results in order (the last one repeats).
	 */
	async function handover(leases, { storeImpl, onError } = {}) {
		const state = { stored: null, loads: 0, stores: [], signals: [], loadGate: null, loadError: null };
		const { name, topic, declKey } = declare({
			snapshotEvery: 1,
			...(onError ? { onError } : {}),
			persist: {
				load: async (t, info) => {
					state.loads++;
					state.signals.push(info && info.signal);
					if (state.loadGate) await state.loadGate;
					if (state.loadError) throw state.loadError;
					return state.stored;
				},
				store: (t, b) => {
					if (storeImpl) storeImpl(state);
					state.stored = new Uint8Array(b);
					state.stores.push(Array.from(b));
				}
			}
		});
		let n = 0;
		const crdt = fakeCrdtCluster({ acquirePersistDetailed: async () => leases[Math.min(n++, leases.length - 1)] });
		const platform = wirePlatform();
		platform.crdt = crdt;
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/board/__doc/sync', []);
		return { state, crdt, platform, ws, name, topic, declKey };
	}

	it('a fresh lease merges the stored snapshot, so an edit only the previous writer held survives the handover', async () => {
		const { state, crdt, platform, ws, name, topic } = await handover([{ acquired: true, fresh: true }, { acquired: true, fresh: false }]);
		expect(state.loads).toBe(1);
		// The previous writer stored an edit whose relay never reached this replica.
		const lost = edit('x', 1);
		state.stored = lost;
		const published = platform.wirePublished.length;
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('y', 2))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.loads).toBe(2);
		expect(decode(state.stored)).toEqual({ x: 1, y: 2 });
		// Local subscribers and peers receive what the merge added.
		const merged = platform.wirePublished.slice(published).map((p) => decode(p.data.bytes));
		expect(merged).toContainEqual({ x: 1 });
		expect(crdt.calls.relayed.map((r) => decode(r.bytes))).toContainEqual({ x: 1 });
		expect(crdt.calls.acquirePersistDetailed).toContain(topic);
		expect(crdt.calls.acquirePersist).toEqual([]);
		// The merge load gets the write's abort signal.
		expect(state.signals[1]).toBeInstanceOf(AbortSignal);
		expect(state.signals[1].aborted).toBe(false);
		// A renewal of the same lease does not reload the snapshot.
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('z', 3, state.stored))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.loads).toBe(2);
		expect(decode(state.stored)).toEqual({ x: 1, y: 2, z: 3 });
	});

	it('a renewed lease writes the replica state without reloading the snapshot', async () => {
		const { state, platform, ws, name } = await handover([{ acquired: true, fresh: false }]);
		state.stored = edit('x', 1);
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('y', 2))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.loads).toBe(1);
		expect(decode(state.stored)).toEqual({ y: 2 });
	});

	it('keeps the merge pending after a failed write, though the lease reports fresh only once', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const lost = edit('x', 1);
			let fail = true;
			const { state, platform, ws, name } = await handover(
				[{ acquired: true, fresh: true }, { acquired: true, fresh: false }],
				{
					storeImpl: (s) => {
						if (!fail) return;
						fail = false;
						// The previous writer stores once more before this write fails.
						s.stored = edit('w', 4, lost);
						throw new Error('disk full');
					}
				}
			);
			state.stored = lost;
			await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('y', 2))]);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(state.loads).toBe(3);
			expect(decode(state.stored)).toEqual({ w: 4, x: 1, y: 2 });
		} finally {
			errSpy.mockRestore();
		}
	});

	it('a failed merge load blocks the write, names the read, and merges once the read recovers', async () => {
		const errors = [];
		const { state, platform, ws, name } = await handover(
			[{ acquired: true, fresh: true }, { acquired: true, fresh: false }],
			{ onError: (err, info) => errors.push({ err, info }) }
		);
		state.stored = edit('x', 1);
		const cause = new Error('replica read timeout');
		state.loadError = cause;
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('y', 2))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.stores).toEqual([]);
		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors[0].err.message).toContain('Could not load the stored snapshot');
		expect(errors[0].err.cause).toBe(cause);
		state.loadError = null;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(decode(state.stored)).toEqual({ x: 1, y: 2 });
	});

	it('an erasure during the merge load aborts the load and writes nothing', async () => {
		const { state, platform, ws, name, topic } = await handover([{ acquired: true, fresh: true }]);
		state.stored = edit('x', 1);
		let release;
		state.loadGate = new Promise((resolve) => { release = resolve; });
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('secret', 2))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.loads).toBe(2);
		expect(_purgeCrdtDocs([topic])).toBe(1);
		expect(state.signals[1].aborted).toBe(true);
		release();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(state.stores).toEqual([]);
		expect(platform.wirePublished.map((p) => p.data && p.data.bytes).filter(Boolean).map((b) => decode(b))).not.toContainEqual({ x: 1 });
	});

	it('an erasure drops a pending merge, so the document joined again does not reload for it', async () => {
		const { state, platform, name, topic } = await handover([{ acquired: true, fresh: true }, { acquired: true, fresh: false }]);
		const ws = mockWs({ id: 'u1' });
		state.loadError = new Error('read down');
		await call(ws, platform, name + '/board/__doc/sync', []);
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('y', 2))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(_purgeCrdtDocs([topic])).toBe(1);
		state.loadError = null;
		state.stored = null;
		const loadsBefore = state.loads;
		const again = mockWs({ id: 'u2' });
		await call(again, platform, name + '/board/__doc/sync', []);
		expect(state.loads).toBe(loadsBefore + 1);
		await fire(again, platform, name + '/board/__doc/update', [Array.from(edit('z', 3))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.loads).toBe(loadsBefore + 1);
		expect(decode(state.stored)).toEqual({ z: 3 });
	});

	it('does not merge or write when the detailed lease is denied', async () => {
		const { state, platform, ws, name } = await handover([{ acquired: false, fresh: false }]);
		state.stored = edit('x', 1);
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(edit('y', 2))]);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.loads).toBe(1);
		expect(state.stores).toEqual([]);
	});

	it('fans out only what a peer sync reply adds and nothing for a reply it already holds', async () => {
		const { name, topic, declKey } = declare();
		const crdt = fakeCrdtCluster();
		const platform = wirePlatform();
		platform.crdt = crdt;
		const ws = mockWs({ id: 'u1' });
		await call(ws, platform, name + '/board/__doc/sync', []);
		const a = edit('a', 1);
		await fire(ws, platform, name + '/board/__doc/update', [Array.from(a)]);
		const published = platform.wirePublished.length;

		// The peer answers with state this replica already has.
		crdt.deliverSyncReply(declKey, topic, Array.from(a));
		expect(platform.wirePublished).toHaveLength(published);

		// A reply carrying old and new state fans out only the new part.
		const b = edit('b', 2, a);
		const both = new Y.Doc();
		Y.applyUpdate(both, a);
		Y.applyUpdate(both, b);
		crdt.deliverSyncReply(declKey, topic, Array.from(Y.encodeStateAsUpdate(both)));
		expect(platform.wirePublished).toHaveLength(published + 1);
		const sent = platform.wirePublished.at(-1);
		expect(sent.options).toEqual({ seq: false });
		expect(decode(sent.data.bytes)).toEqual({ b: 2 });
		expect(decode(a, sent.data.bytes)).toEqual({ a: 1, b: 2 });

		// A reply that only deletes still reaches local subscribers.
		const editor = new Y.Doc();
		Y.applyUpdate(editor, Y.encodeStateAsUpdate(both));
		const sv = Y.encodeStateVector(editor);
		editor.getMap('m').delete('a');
		crdt.deliverSyncReply(declKey, topic, Array.from(Y.encodeStateAsUpdate(editor, sv)));
		expect(platform.wirePublished).toHaveLength(published + 2);
		expect(decode(Y.encodeStateAsUpdate(both), platform.wirePublished.at(-1).data.bytes)).toEqual({ b: 2 });
	});
});

describe('live.doc HMR survival', () => {
	let rt;
	beforeEach(() => {
		vi.useFakeTimers();
		rt = fakeRuntime();
		_setCrdtRuntime(rt.mod);
	});
	afterEach(() => {
		_resetCrdt();
		_setCrdtRuntime(null);
		vi.useRealTimers();
	});

	it('keeps the live replicas across a hot reload and re-attaches by key', async () => {
		const topicString = 'hmr-board' + ++moduleSeq;
		const name = 'docHmr' + moduleSeq;
		const board = live.doc({ topic: topicString });
		registerDoc(name, board);
		const ws = mockWs({ id: 'u1' });
		const platform = wirePlatform();
		await call(ws, platform, name + '/board/__doc/sync', [[]]);
		expect(rt.calls.acquire).toEqual([topicString]);

		// Hot reload: registries clear, the document records survive.
		const snap = _prepareHmr();
		expect(rt.calls.destroyed).toBe(0);
		_restoreHmr(snap);

		// The re-imported module re-declares the same topic: the new export
		// re-attaches to the surviving record - same authority instance, no
		// second authority construction, and the held reference still drains.
		const board2 = live.doc({ topic: topicString });
		registerDoc(name, board2);
		await fire(ws, platform, name + '/board/__doc/update', [[5]]);
		expect(rt.calls.apply).toHaveLength(1); // the ORIGINAL authority applied it
		close(ws, { platform });
		expect(rt.calls.release).toEqual([topicString]);
	});
});

describe('crdt load-error classification', () => {
	it('a missing module surfaces as version skew', () => {
		for (const code of ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']) {
			const e = _crdtLoadError(Object.assign(new Error('not found'), { code }));
			expect(e).toBeInstanceOf(LiveError);
			expect(e.code).toBe('INTERNAL');
			expect(e.message).toContain('svelte-adapter-uws 0.6.0-next.25');
		}
	});

	it('any other failure surfaces as itself', () => {
		const e = _crdtLoadError(new Error('syntax error in plugin'));
		expect(e.message).toContain('syntax error in plugin');
		expect(e.message).not.toContain('0.6.0-next.25');
	});
});

// ---------------------------------------------------------------------------
// Codegen: the vite plugin detects live.doc/map/array exports and emits the
// client namespace, the SSR stub, the registry lines, and the typegen entry.
// ---------------------------------------------------------------------------

const testRoot = resolve(import.meta.dirname, '__doc_fixtures__');
const liveDir = resolve(testRoot, 'src/live');

function setup(files = {}) {
	mkdirSync(liveDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(resolve(liveDir, name), content);
	}
}

function teardown() {
	if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
}

function createPlugin(opts = {}) {
	const plugin = svelteRealtime({ dir: 'src/live', ...opts });
	plugin.configResolved({ root: testRoot, build: {} });
	return plugin;
}

const DOC_SOURCE = `
import { live } from 'svelte-realtime/server';
export const board = live.doc({
  topic: (ctx, boardId) => 'board:' + boardId,
  topicArgs: 1
});
export const cards = live.map({ topic: 'cards' });
export const todos = live.array({ topic: 'todos' });
`;

describe('live.doc vite integration', () => {
	afterEach(teardown);

	it('generates the doc namespaces with send paths and kind-named factories', () => {
		setup({ 'board.js': DOC_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:board', {});
		expect(code).toContain("import { _acquireDoc } from 'svelte-realtime/doc';");
		expect(code).toContain("import { createCrdtChannel } from 'svelte-adapter-uws/plugins/crdt/channel';");
		expect(code).toContain('_sync: __rpc("board/board/__doc/sync")');
		expect(code).toContain('_update: __rpc("board/board/__doc/update")');
		expect(code).toContain('_close: __rpc("board/board/__doc/close")');
		expect(code).toContain('doc(...args)');
		expect(code).toContain('map(...args)');
		expect(code).toContain('array(...args)');
		// updates ride the reliable no-reply send, never the volatile drop tier
		expect(code).toContain('_update.send(...args, bytes)');
		expect(code).not.toContain('_update.fireAndForget');
	});

	it('registers the three send paths in the build registry', () => {
		setup({ 'board.js': DOC_SOURCE });
		const plugin = createPlugin();
		const registry = plugin.load('\0live:__registry', { ssr: true });
		for (const exp of ['board', 'cards', 'todos']) {
			expect(registry).toContain('board/' + exp + '/__doc/sync');
			expect(registry).toContain('board/' + exp + '/__doc/update');
			expect(registry).toContain('board/' + exp + '/__doc/close');
		}
		expect(registry).toContain('__docSync');
		expect(registry).toContain('__docUpdate');
		expect(registry).toContain('__docClose');
	});

	it('emits an inert SSR namespace per kind', () => {
		setup({ 'board.js': DOC_SOURCE });
		const plugin = createPlugin();
		const code = plugin.load('\0live:board', { ssr: true });
		expect(code).toContain('doc: () => __ssrDocHandle()');
		expect(code).toContain('map: () => __ssrDocMap()');
		expect(code).toContain('array: () => __ssrDocArray()');
		expect(code).not.toContain('createCrdtChannel');
	});
});
