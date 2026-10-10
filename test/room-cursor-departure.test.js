import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, configureForget, _resetForget } from '../src/server.js';
import { state, _presenceRef } from '../src/server/state.js';
import { _clusterPresenceAcquire, _clusterPresenceRelease, _removeCursorIfDeparted } from '../src/server/presence.js';
import { createTestEnv } from '../src/testing.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';

describe('cursor samples follow room membership departures', () => {
	let env, originalCap, clients;
	beforeEach(() => {
		vi.useFakeTimers();
		env = createTestEnv();
		clients = new Set();
		const connect = env.connect;
		env.connect = (...args) => {
			const client = connect(...args);
			const disconnect = client.disconnect;
			clients.add(client);
			client.disconnect = () => { if (clients.delete(client)) disconnect(); };
			return client;
		};
		originalCap = state.maxPresenceRef;
		env.register('board', {
			room: live.multiplayer({
				topic: (ctx, id) => 'cursor-board:' + id,
				topicArgs: 1,
				presence: ctx => ({ name: ctx.user.id }),
				cursors: true
			})
		});
	});
	afterEach(async () => {
		for (const client of clients) client.disconnect();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5001);
		expect(_presenceRef.size).toBe(0);
		env.cleanup();
		state.maxPresenceRef = originalCap;
		state.presenceRefWarnFired = false;
		_resetForget();
		_resetTenantResolver();
		vi.useRealTimers();
	});

	async function join(id) {
		const client = env.connect({ id });
		const stream = client.subscribe('board/room/__data', 'one');
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.error).toBeNull();
		expect(stream.topic).toBe('cursor-board:one');
		return client;
	}

	async function watch(id) {
		const client = env.connect({ id });
		const stream = client.subscribe('board/room/__cursors', 'one');
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.value).toEqual([]);
		return stream;
	}

	it('removes the departed cursor from every peer after the membership grace', async () => {
		const alice = await join('alice');
		const bob = await watch('bob');
		const carol = await watch('carol');
		await alice.call('board/room/__cursor/move', 'one', { x: 3, y: 4 });
		for (const peer of [bob, carol]) expect(peer.value).toEqual([expect.objectContaining({ key: 'alice', x: 3, y: 4 })]);
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(4999);
		for (const peer of [bob, carol]) expect(peer.value).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2);
		for (const peer of [bob, carol]) {
			expect(peer.value).toEqual([]);
			expect(peer.events.filter(e => e.event === 'remove')).toEqual([{ event: 'remove', data: { key: 'alice' } }]);
		}
	});

	it('keeps the cursor while another tab of that identity remains joined', async () => {
		const alice = await join('alice');
		const secondTab = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(bob.value).toHaveLength(1);
		expect(bob.events.some(e => e.event === 'remove')).toBe(false);
		secondTab.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(bob.value).toEqual([]);
	});

	it('keeps the cursor when the cluster still holds the identity on another replica', async () => {
		let count = 1;
		const remove = vi.fn(async () => 2);
		env.platform.redis = {
			hset: async () => 1,
			hincrby: async (key, field, by) => (count += by),
			expire: async () => 1,
			hdel: remove
		};
		const alice = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(count).toBe(1);
		expect(remove).not.toHaveBeenCalled();
		expect(bob.value).toHaveLength(1);
		expect(bob.events.some(e => e.event === 'remove')).toBe(false);
	});

	it('removes the old room cursor when another room evicts its departing member', async () => {
		state.maxPresenceRef = 1;
		const alice = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(0);
		env.register('other', { room: live.room({ topic: () => 'other-room', init: async () => [], presence: ctx => ({ name: ctx.user.id }) }) });
		const newcomer = env.connect({ id: 'newcomer' });
		const data = newcomer.subscribe('other/room/__data');
		await vi.advanceTimersByTimeAsync(0);
		expect(data.topic).toBe('other-room');
		expect(bob.value).toEqual([]);
		expect(bob.events.filter(e => e.event === 'remove')).toHaveLength(1);
	});

	it('removes the cursor during erasure through the normal forget entry point', async () => {
		const alice = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		configureForget({ platform: env.platform, store: { purgeUser: async () => 0 } });
		await live.forget('alice');
		expect(bob.value).toEqual([]);
		expect(bob.events.filter(e => e.event === 'remove')).toHaveLength(1);
	});

	async function simple(owner = false) {
		env.register('simple', { room: live.multiplayer({ topic: () => 'simple-room', cursors: true, owner }) });
		const alice = env.connect({ id: 'alice' });
		if (owner) {
			const data = alice.subscribe('simple/room/__data');
			await vi.advanceTimersByTimeAsync(0);
			expect(data.error).toBeNull();
		}
		const bob = env.connect({ id: 'bob' });
		const cursors = bob.subscribe('simple/room/__cursors');
		await vi.advanceTimersByTimeAsync(0);
		return { alice, cursors };
	}

	for (const owner of [false, true]) {
		it(`removes ${owner ? 'owner-only' : 'subscription-free'} cursor samples after socket close`, async () => {
			const { alice, cursors } = await simple(owner);
			await alice.call('simple/room/__cursor/move', { x: 9 });
			expect(cursors.value).toEqual([expect.objectContaining({ key: 'alice', x: 9 })]);
			alice.disconnect();
			await vi.advanceTimersByTimeAsync(5001);
			expect(cursors.value).toEqual([]);
		});
	}

	it('retains a subscription-free publisher while its other tab remains connected', async () => {
		const { alice, cursors } = await simple();
		const second = env.connect({ id: 'alice' });
		await alice.call('simple/room/__cursor/move', { x: 1 });
		await second.call('simple/room/__cursor/reportViewport', { x: 2 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(cursors.value).toHaveLength(1);
		second.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(cursors.value).toEqual([]);
	});

	it('erases subscription-free publisher identity retained by a connected socket', async () => {
		const { alice, cursors } = await simple();
		await alice.call('simple/room/__cursor/move', { x: 9 });
		const ref = _presenceRef.get('\0cursors:simple-room\0alice');
		configureForget({ platform: env.platform, store: { purgeUser: async () => 0 } });
		await live.forget('alice');
		expect(ref).toMatchObject({ cursorKey: null, data: null, count: 0, gone: true });
		expect(cursors.value).toEqual([]);
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(cursors.events.filter(e => e.event === 'remove')).toHaveLength(1);
	});

	it('evicts a departing subscription-free publisher through the shared room cap', async () => {
		state.maxPresenceRef = 1;
		const { alice, cursors } = await simple();
		await alice.call('simple/room/__cursor/move', { x: 9 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(0);
		const newcomer = env.connect({ id: 'newcomer' });
		const data = newcomer.subscribe('board/room/__data', 'two');
		await vi.advanceTimersByTimeAsync(0);
		expect(data.topic).toBe('cursor-board:two');
		expect([..._presenceRef].map(([key, ref]) => [key, ref.count, !!ref.timer, !!ref.leaving, !!ref.erasure])).toEqual([['cursor-board:two\0newcomer', 1, false, false, false]]);
		expect(cursors.value).toEqual([]);
	});

	it('does not publish a late first sample after the publisher socket closes', async () => {
		const { alice, cursors } = await simple();
		let entered, resume, released = 0;
		const started = new Promise(resolve => { entered = resolve; });
		const gate = new Promise(resolve => { resume = resolve; });
		env.platform.redis = { hset: async () => 1, hincrby: async (key, field, by) => {
			if (by === 1) { entered(); await gate; return 1; }
			released++;
			return 0;
		}, expire: async () => 1, hdel: async () => 2 };
		const moving = alice.call('simple/room/__cursor/move', { x: 9 }).catch(() => {});
		await started;
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(released).toBe(0);
		expect(_presenceRef.get('\0cursors:simple-room\0alice').leaving).toBeTruthy();
		resume();
		await moving;
		await vi.advanceTimersByTimeAsync(5001);
		expect(cursors.events.some(e => e.event === 'update')).toBe(false);
		expect(_presenceRef.has('\0cursors:simple-room\0alice')).toBe(false);
	});

	for (const cursorFirst of [false, true]) for (const cursorClosesFirst of [false, true]) {
		it(`shares a topic with membership (cursor joins first: ${cursorFirst}, closes first: ${cursorClosesFirst})`, async () => {
			let leaves = 0;
			env.register('shared', {
				members: live.room({ topic: () => 'shared-room', init: async () => [], presence: ctx => ({ name: ctx.user.id }), owner: true, onLeave: () => { leaves++; } }),
				pointers: live.multiplayer({ topic: () => 'shared-room', cursors: true })
			});
			const member = env.connect({ id: 'alice' });
			const publisher = env.connect({ id: 'alice' });
			const peer = env.connect({ id: 'bob' });
			const cursors = peer.subscribe('shared/pointers/__cursors');
			const presence = peer.subscribe('shared/members/__presence');
			const owner = peer.subscribe('shared/members/__owner');
			await vi.advanceTimersByTimeAsync(0);
			const join = async () => { member.subscribe('shared/members/__data'); await vi.advanceTimersByTimeAsync(0); };
			const move = () => publisher.call('shared/pointers/__cursor/move', { x: 9 });
			if (cursorFirst) { await move(); await join(); } else { await join(); await move(); }
			await move();
			expect(_presenceRef.get('shared-room\0alice').count).toBe(1);
			expect(_presenceRef.get('\0cursors:shared-room\0alice').count).toBe(1);
			expect(presence.value).toEqual([{ key: 'alice', data: { name: 'alice' } }]);
			expect(owner.value.key).toBe('alice');
			(cursorClosesFirst ? publisher : member).disconnect();
			await vi.advanceTimersByTimeAsync(5001);
			expect(_presenceRef.has('shared-room\0alice')).toBe(cursorClosesFirst);
			expect(_presenceRef.has('\0cursors:shared-room\0alice')).toBe(!cursorClosesFirst);
			expect(presence.value.length).toBe(cursorClosesFirst ? 1 : 0);
			expect(owner.value?.key ?? null).toBe(cursorClosesFirst ? 'alice' : null);
			expect(leaves).toBe(cursorClosesFirst ? 0 : 1);
			expect(cursors.value).toHaveLength(1);
			(cursorClosesFirst ? member : publisher).disconnect();
			await vi.advanceTimersByTimeAsync(5001);
			expect(presence.value).toEqual([]);
			expect(cursors.value).toEqual([]);
			expect(owner.value?.key ?? null).toBeNull();
		});
	}

	it('keeps cursor-only Redis counters separate from data membership', async () => {
		const rows = new Map();
		const field = (hash, key) => hash + ':' + key;
		env.platform.redis = {
			hset: async (hash, key, value) => (rows.set(field(hash, key), value), 1),
			hsetnx: async (hash, key, value) => { const k=field(hash,key); if (rows.has(k)) return 0; rows.set(k,value); return 1; },
			hget: async (hash, key) => rows.get(field(hash,key)) ?? null,
			hincrby: async (hash, key, by) => { const k=field(hash,key), n=Number(rows.get(k)||0)+by; rows.set(k,n); return n; },
			hdel: async (hash, ...keys) => keys.reduce((n,key) => n + Number(rows.delete(field(hash,key))), 0),
			expire: async () => 1
		};
		const { alice } = await simple();
		await alice.call('simple/room/__cursor/move', { x: 1 });
		env.register('roster', { room: live.room({ topic: () => 'simple-room', init: async () => [], presence: ctx => ({ name: ctx.user.id }) }) });
		const member = env.connect({ id: 'alice' });
		member.subscribe('roster/room/__data');
		await vi.advanceTimersByTimeAsync(0);
		expect(rows.get('__live-presence:simple-room:c:alice')).toBe(1);
		expect(rows.get('__live-presence:\0cursors:simple-room:c:alice')).toBe(1);
		expect(JSON.parse(rows.get('__live-presence:simple-room:d:alice'))).toEqual({ name: 'alice' });
		member.disconnect(); alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(rows.size).toBe(0);
	});


	it('retries erased cursor control storage after its retained routing fields are scrubbed', async () => {
		const { alice, cursors } = await simple();
		await alice.call('simple/room/__cursor/move', { x: 9 });
		const ref = _presenceRef.get('\0cursors:simple-room\0alice');
		let fail = true;
		const deletes = [];
		env.platform.redis = { hincrby: async () => 0, hdel: async (hash) => { deletes.push(hash); if (fail) throw Error('offline'); return 2; } };
		configureForget({ platform: env.platform, store: { purgeUser: async () => 0 } });
		await expect(live.forget('alice')).rejects.toBeTruthy();
		expect(ref).toMatchObject({ cursorKey: null, cursorTopic: null, gone: true });
		fail = false;
		await live.forget('alice');
		expect(deletes).toEqual(['__live-presence:\0cursors:simple-room', '__live-presence:\0cursors:simple-room']);
		expect(cursors.value).toEqual([]);
		expect(_presenceRef.has('\0cursors:simple-room\0alice')).toBe(false);
	});

	it('keeps a departing member sample while a cursor-only publisher remains on another replica', async () => {
		let count = 0;
		env.platform.redis = {
			hset: async () => 1, hincrby: async (hash, key, by) => count += by, expire: async () => 1, hdel: async () => 2,
			hget: async (hash, key) => hash === '__live-presence:\0cursors:cursor-board:one' && key === 'c:alice' ? '1' : null
		};
		const alice = await join('alice'); const cursors = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 9 });
		alice.disconnect(); await vi.advanceTimersByTimeAsync(5001);
		expect(count).toBe(0);
		expect(cursors.value).toHaveLength(1);
	});

	it('keeps a standalone sample while the same identity owns membership on another replica', async () => {
		let count = 0;
		env.platform.redis = {
			hset: async () => 1, hincrby: async (hash, key, by) => count += by, expire: async () => 1, hdel: async () => 2,
			hget: async (hash, key) => hash === '__live-room-owner:simple-room' && key === 'n:alice' ? '1' : null
		};
		const { alice, cursors } = await simple();
		await alice.call('simple/room/__cursor/move', { x: 9 });
		alice.disconnect(); await vi.advanceTimersByTimeAsync(5001);
		expect(count).toBe(0);
		expect(cursors.value).toHaveLength(1);
	});


	it('erases only the selected tenant control counters and routes removal to its wire topic', async () => {
		_setTenantResolver(user => user.tenantId ?? null);
		env.register('tenant', { room: live.multiplayer({ topic: () => 'tenant-room', cursors: true }) });
		const peers = [];
		for (const tenantId of [null, 'one', 'two']) {
			const alice = env.connect({ id: 'alice', tenantId });
			const bob = env.connect({ id: 'bob', tenantId });
			const cursors = bob.subscribe('tenant/room/__cursors');
			await vi.advanceTimersByTimeAsync(0);
			await alice.call('tenant/room/__cursor/move', { x: 9 });
			expect(cursors.value).toHaveLength(1);
			peers.push(cursors);
		}
		configureForget({ platform: env.platform, store: { purgeUser: async () => 0 } });
		await live.forget('alice', { tenantId: 'one' });
		expect(peers.map(peer => peer.value.length)).toEqual([1, 0, 1]);
		expect(_presenceRef.has('\0cursors:@t/one/tenant-room\0alice')).toBe(false);
		expect(_presenceRef.has('\0cursors:@t/two/tenant-room\0alice')).toBe(true);
		await live.forget('alice');
		expect(peers.map(peer => peer.value.length)).toEqual([0, 0, 1]);
	});


	it('does not remove a new member sample after an old publisher waits on Redis', async () => {
		let entered, resume, gated = false;
		const started = new Promise(resolve => { entered = resolve; });
		const gate = new Promise(resolve => { resume = resolve; });
		const counts = new Map();
		env.platform.redis = {
			hset: async () => 1, expire: async () => 1, hdel: async () => 2,
			hincrby: async (hash, key, by) => { const n=(counts.get(hash)||0)+by; counts.set(hash,n); return n; },
			hget: async (hash, key) => {
				if (hash === '__live-presence:simple-room' && !gated) { gated = true; entered(); await gate; return null; }
				return counts.get(hash) ?? null;
			}
		};
		const { alice, cursors } = await simple();
		await alice.call('simple/room/__cursor/move', { x: 1 });
		alice.disconnect(); await vi.advanceTimersByTimeAsync(5001); await started;
		env.register('new', { room: live.multiplayer({ topic: () => 'simple-room', presence: ctx => ({ name: ctx.user.id }), cursors: true }) });
		const member = env.connect({ id: 'alice' });
		member.subscribe('new/room/__data'); await vi.advanceTimersByTimeAsync(0);
		await member.call('new/room/__cursor/move', { x: 2 });
		expect(cursors.value[0].x).toBe(2);
		resume(); await vi.advanceTimersByTimeAsync(0);
		expect(cursors.value[0]?.x).toBe(2);
		expect(cursors.events.some(event => event.event === 'remove')).toBe(false);
	});

	for (const controlLoss of ['release', 'expiry']) for (const ending of ['disconnect', 'forget']) {
		it(`cleans a remote cursor after control ${controlLoss} when a cursor-unaware member ends by ${ending}`, async () => {
			const hashes = new Map();
			const hash = key => { if (!hashes.has(key)) hashes.set(key, new Map()); return hashes.get(key); };
			env.platform.redis = {
				hget: async (key, field) => hashes.get(key)?.get(field) ?? null,
				hgetall: async key => Object.fromEntries(hashes.get(key) || []),
				hset: async (key, field, value) => { hash(key).set(field, String(value)); return 1; },
				hincrby: async (key, field, by) => { const next = Number(hash(key).get(field) || 0) + by; hash(key).set(field, String(next)); return next; },
				hdel: async (key, ...fields) => fields.reduce((n, field) => n + Number(hashes.get(key)?.delete(field) || false), 0),
				expire: async () => 1
			};
			env.register('remote', {
				members: live.room({ topic: () => 'remote-shared', init: () => [], owner: true }),
				pointers: live.multiplayer({ topic: () => 'remote-shared', cursors: true })
			});
			const member = env.connect({ id: 'alice' }), peer = env.connect({ id: 'bob' });
			member.subscribe('remote/members/__data');
			const cursors = peer.subscribe('remote/pointers/__cursors');
			await vi.advanceTimersByTimeAsync(0);
			expect(_presenceRef.get('remote-shared\0alice').cursors).toBe(false);
			// A foreign replica acquires only shared counters and broadcasts its
			// sample. It has no cursor ref in this process's membership map.
			await _clusterPresenceAcquire(env.platform, '\0cursors:remote-shared', 'alice', null);
			env.platform.publish('remote-shared:cursors', 'update', { key: 'alice', x: 5 }, { seq: false });
			expect(cursors.value).toEqual([{ key: 'alice', x: 5 }]);
			if (controlLoss === 'release') await _clusterPresenceRelease(env.platform, '\0cursors:remote-shared', 'alice');
			else hashes.delete('__live-presence:\0cursors:remote-shared');
			await _removeCursorIfDeparted(env.platform, 'remote-shared', 'alice');
			expect(cursors.value).toHaveLength(1);
			expect(await env.platform.redis.hget('__live-presence:\0cursors:remote-shared', 'd:alice')).toBeNull();
			if (ending === 'forget') await live.forget('alice');
			else { member.disconnect(); await vi.advanceTimersByTimeAsync(5001); }
			expect(cursors.value).toEqual([]);
			expect(cursors.events.filter(e => e.event === 'remove')).toEqual([{ event: 'remove', data: { key: 'alice' } }]);
		});
	}

});
