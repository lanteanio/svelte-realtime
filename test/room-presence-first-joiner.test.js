// Regression for the presence self-delivery race, driven through the REAL
// dispatch path. The client batches a room's data-stream and :presence
// sub-stream subscribes into ONE wire frame, and the batch executes its items
// in parallel: the :presence loader's shared-roster read can beat the
// data-join's cluster acquire (an owner room delays the acquire further behind
// the owner join's redis round-trips), and the acquire's live 'join' can hit
// the socket before the client registers the :presence store. Pre-fix, the
// joiner's own entry was missing from the snapshot AND the live event - on a
// cluster (platform.redis) every member saw everyone except themselves.
//
// The fix sequences the joiner's own roster entry into the :presence subscribe
// RESPONSE via the per-socket claim barrier (see room-owner.js), exactly like
// the owner first-joiner delivery. These tests feed the exact batch frame to
// handleRpc and assert the delivered response.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, unsubscribe } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';
import { inFlightCount } from '../src/server/lifecycle.js';

const textEncoder = new TextEncoder();
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Minimal Map-backed stand-in for the raw ioredis hash commands the cluster
// presence/rooms helpers call (one shared instance = one cluster-shared Redis).
function makeFakeRedis() {
	const hashes = new Map();
	const get = (h) => {
		let m = hashes.get(h);
		if (!m) { m = new Map(); hashes.set(h, m); }
		return m;
	};
	return {
		hashes,
		async hget(h, field) {
			const m = hashes.get(h);
			const v = m && m.get(field);
			return v === undefined ? null : v;
		},
		async hset(h, field, value) {
			const m = get(h);
			const isNew = m.has(field) ? 0 : 1;
			m.set(field, String(value));
			return isNew;
		},
		async hgetall(h) {
			const m = hashes.get(h);
			if (!m) return {};
			const out = {};
			for (const [k, v] of m) out[k] = v;
			return out;
		},
		async hincrby(h, field, by) {
			const m = get(h);
			const cur = m.has(field) ? parseInt(m.get(field), 10) : 0;
			const next = cur + by;
			m.set(field, String(next));
			return next;
		},
		async hdel(h, ...fields) {
			const m = hashes.get(h);
			if (!m) return 0;
			let n = 0;
			for (const f of fields) { if (m.delete(f)) n++; }
			return n;
		},
		async hexists(h, field) {
			const m = hashes.get(h);
			return m && m.has(field) ? 1 : 0;
		},
		async expire() { return 1; }
	};
}

// The demo-lobbies shape: dynamic topic + enumeration + ownership + presence.
function ownerLobbyModule() {
	return {
		lobby: live.room({
			topic: (ctx, id) => 'tbl:' + id,
			topicArgs: 1,
			init: async () => [],
			meta: (id) => ({ name: 'Table ' + id, cap: 8 }),
			enumerable: true,
			owner: true,
			presence: (ctx) => ({ name: ctx.user.name })
		})
	};
}

// The plain-chat shape: presence only. The same guarantee must hold - the
// acquire winning the race today is a timing accident, not a contract.
function plainRoomModule() {
	return {
		chat: live.room({
			topic: (ctx, id) => 'chat:' + id,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user.name })
		})
	};
}

function openConn(env, userData) {
	const responses = new Map();
	const topics = new Set();
	const ws = {
		getUserData: () => userData,
		subscribe: (t) => { topics.add(t); return true; },
		unsubscribe: (t) => { topics.delete(t); return true; },
		isSubscribed: (t) => topics.has(t),
		getTopics: () => [...topics],
		_onSend: (topic, event, data) => { if (topic === '__rpc') responses.set(event, data); }
	};
	env.platform.connections++;
	return { ws, responses };
}

async function sendBatch(env, conn, calls) {
	handleRpc(conn.ws, textEncoder.encode(JSON.stringify({ batch: calls })).buffer, env.platform);
	await settle();
	const batchResp = conn.responses.get('__batch');
	const byId = {};
	if (batchResp && Array.isArray(batchResp.batch)) {
		for (const r of batchResp.batch) byId[r.id] = r;
	}
	return byId;
}

const joinBatch = (base, id) => [
	{ rpc: base + '/__data', id: 'd', args: [id], stream: true },
	{ rpc: base + '/__presence', id: 'p', args: [id], stream: true }
];

describe('live.room presence - first-joiner self delivery (real dispatch, batched subscribe)', () => {
	let env, redis, published;

	beforeEach(() => {
		env = createTestEnv();
		redis = makeFakeRedis();
		env.platform.redis = redis;
		published = [];
		const origPublish = env.platform.publish;
		env.platform.publish = (topic, event, data, opts) => {
			published.push({ topic, event, data });
			return origPublish(topic, event, data, opts);
		};
		env.register('game', ownerLobbyModule());
		env.register('talk', plainRoomModule());
	});

	afterEach(() => {
		env.cleanup();
	});

	it('owner room: the first joiner sees ITSELF in its :presence subscribe response', async () => {
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		const res = await sendBatch(env, alice, [
			...joinBatch('game/lobby', 51),
			{ rpc: 'game/lobby/__owner', id: 'o', args: [51], stream: true }
		]);
		expect(res.p.ok).toBe(true);
		expect(res.p.data).toEqual([{ key: 'alice', data: { name: 'Alice' } }]);
		// The paired owner delivery still holds alongside the presence barrier.
		expect(res.o.data).toEqual({ key: 'alice', reason: 'claimed' });
	});

	it('owner room: a second joiner sees BOTH members in its snapshot', async () => {
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		await sendBatch(env, alice, joinBatch('game/lobby', 52));
		const bob = openConn(env, { id: 'bob', name: 'Bob' });
		const res = await sendBatch(env, bob, joinBatch('game/lobby', 52));
		expect(res.p.ok).toBe(true);
		const keys = res.p.data.map((e) => e.key).sort();
		expect(keys).toEqual(['alice', 'bob']);
	});

	it('plain presence room (no owner): the same self guarantee holds', async () => {
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		const res = await sendBatch(env, alice, joinBatch('talk/chat', 'general'));
		expect(res.p.ok).toBe(true);
		expect(res.p.data).toEqual([{ key: 'alice', data: { name: 'Alice' } }]);
	});

	it('a lone :presence viewer (no paired data-join) is NOT injected into the roster', async () => {
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		await sendBatch(env, alice, joinBatch('game/lobby', 7));
		const viewer = openConn(env, { id: 'watcher', name: 'Watcher' });
		const res = await sendBatch(env, viewer, [
			{ rpc: 'game/lobby/__presence', id: 'p', args: [7], stream: true }
		]);
		expect(res.p.ok).toBe(true);
		expect(res.p.data.map((e) => e.key)).toEqual(['alice']);
	});

	it('a departed member is not resurrected by a stale claim slot: data-only join, leave, then a lone :presence subscribe on the SAME socket', async () => {
		// The data-join opens (and resolves) the self-delivery barrier even
		// when its batch carries no :presence subscribe. That settled slot must
		// not outlive the membership - the unsubscribe drain clears it - or
		// this later lone :presence subscribe would consume it and inject the
		// departed member into the roster.
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		await sendBatch(env, alice, [
			{ rpc: 'game/lobby/__data', id: 'd', args: [61], stream: true }
		]);
		unsubscribe(alice.ws, 'tbl:61', { platform: env.platform });
		// The presence release runs behind the 5s grace timer; the barrier
		// clear is immediate. Wait past the grace so the roster is empty too.
		await new Promise((r) => setTimeout(r, 5200));
		const res = await sendBatch(env, alice, [
			{ rpc: 'game/lobby/__presence', id: 'p', args: [61], stream: true }
		]);
		expect(res.p.ok).toBe(true);
		expect(res.p.data).toEqual([]);
	}, 10_000);

	it('a vacated owner claim is not served from a stale slot: data-only join, leave, then a lone :owner subscribe on the SAME socket', async () => {
		// Same stale-slot class on the owner barrier (present since the owner
		// first-joiner delivery shipped): the data-only join resolves the owner
		// claim slot, nobody consumes it, alice leaves and the room empties.
		// The later lone :owner subscribe must read the shared store (vacated),
		// never the stale first-claim.
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		await sendBatch(env, alice, [
			{ rpc: 'game/lobby/__data', id: 'd', args: [62], stream: true }
		]);
		unsubscribe(alice.ws, 'tbl:62', { platform: env.platform });
		await new Promise((r) => setTimeout(r, 5200));
		const res = await sendBatch(env, alice, [
			{ rpc: 'game/lobby/__owner', id: 'o', args: [62], stream: true }
		]);
		expect(res.o.ok).toBe(true);
		expect(res.o.data).toEqual({ key: null, reason: null });
	}, 10_000);

	it('no platform.redis: the in-memory fallback still carries the joiner (batched)', async () => {
		delete env.platform.redis;
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		const res = await sendBatch(env, alice, joinBatch('game/lobby', 3));
		expect(res.p.ok).toBe(true);
		expect(res.p.data).toEqual([{ key: 'alice', data: { name: 'Alice' } }]);
	});

	it('enum registry: a leave with the socket still open decrements the shared count and publishes updated', async () => {
		// Companion regression for the release path: the framework decrements
		// the cluster roster and publishes the delta when the adapter fires the
		// realtime unsubscribe hook (an app that overrides the hook must chain
		// it - see README).
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		await sendBatch(env, alice, joinBatch('game/lobby', 9));
		const bob = openConn(env, { id: 'bob', name: 'Bob' });
		await sendBatch(env, bob, joinBatch('game/lobby', 9));

		published.length = 0;
		unsubscribe(bob.ws, 'tbl:9', { platform: env.platform });
		unsubscribe(bob.ws, 'tbl:9:presence', { platform: env.platform });
		await settle(50);

		const rooms = redis.hashes.get('__live-rooms:game/lobby');
		expect(rooms && rooms.get('c:tbl:9')).toBe('1');
		const upd = published.find((p) => p.topic === 'rooms-enum:game/lobby' && p.event === 'updated');
		expect(upd).toBeDefined();
		expect(upd.data.count).toBe(1);
	});
});

// The claim barrier a room's DATA-stream subscribe opens (owner + presence) MUST
// be settled on EVERY early return, not just the happy path. The data subscribe
// and its paired :owner / :presence subscribe race in one parallel batch; if the
// DATA subscribe is DENIED (a MAX_SUBSCRIPTIONS boundary race, or a per-topic
// subscribe hook that authorizes the sub-stream but refuses the data topic), the
// barrier was already opened at dispatch topic-resolution but the data item
// returns before the settle. Pre-fix, the paired sub-stream loader awaited that
// never-resolved barrier forever: Promise.all never settled, so the WHOLE batch
// response was never sent, and the hung item leaked its in-flight count (which
// blocks the graceful-shutdown drain). These drive the real dispatch path.
describe('live.room claim barriers - a denied data subscribe settles the barrier (no batch hang)', () => {
	let env, redis;

	beforeEach(() => {
		env = createTestEnv();
		redis = makeFakeRedis();
		env.platform.redis = redis;
		env.register('game', ownerLobbyModule());
		env.register('talk', plainRoomModule());
	});

	afterEach(() => {
		env.cleanup();
	});

	// Deny exactly the DATA wire topic; allow its sub-streams (:presence/:owner).
	function denyDataTopic(dataTopic) {
		env.platform.subscribe = async (ws, topic) => {
			if (topic === dataTopic) return 'FORBIDDEN';
			try { ws.subscribe(topic); } catch { return 'CONNECTION_CLOSED'; }
			return null;
		};
	}

	it('presence room: a denied data subscribe still returns the batch (denial + empty roster), not a hang', async () => {
		denyDataTopic('tbl:70');
		const before = inFlightCount();
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		const res = await sendBatch(env, alice, joinBatch('game/lobby', 70));
		// The batch RESPONDED at all: pre-fix the :presence loader awaited the
		// never-settled barrier and no __batch was ever sent (res would be empty).
		expect(res.d).toBeDefined();
		expect(res.d.ok).toBe(false);
		expect(res.d.code).toBe('FORBIDDEN');
		expect(res.p).toBeDefined();
		expect(res.p.ok).toBe(true);
		// No self injected: the data-join was denied, so the roster is empty.
		expect(res.p.data).toEqual([]);
		// The in-flight counter was released (pre-fix the hung item leaked it).
		expect(inFlightCount()).toBe(before);
	});

	it('owner room: a denied data subscribe still returns the :owner snapshot (vacated), not a hang', async () => {
		denyDataTopic('tbl:71');
		const before = inFlightCount();
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		const res = await sendBatch(env, alice, [
			{ rpc: 'game/lobby/__data', id: 'd', args: [71], stream: true },
			{ rpc: 'game/lobby/__owner', id: 'o', args: [71], stream: true }
		]);
		expect(res.d).toBeDefined();
		expect(res.d.ok).toBe(false);
		expect(res.o).toBeDefined();
		expect(res.o.ok).toBe(true);
		expect(res.o.data).toEqual({ key: null, reason: null });
		expect(inFlightCount()).toBe(before);
	});

	it('plain presence room (no owner): a denied data subscribe still returns the batch', async () => {
		denyDataTopic('chat:general');
		const alice = openConn(env, { id: 'alice', name: 'Alice' });
		const res = await sendBatch(env, alice, joinBatch('talk/chat', 'general'));
		expect(res.d.ok).toBe(false);
		expect(res.p.ok).toBe(true);
		expect(res.p.data).toEqual([]);
	});

	it('a guarded room: a data-join whose guard THROWS settles the barrier, so a later lone :presence on the SAME socket does not hang', async () => {
		// The room guard denies by THROWING (not returning false), so a guarded
		// data-join throws past the early-return settles to the outer catch with
		// the barrier still open. The paired sub-stream loaders throw on the same
		// guard before awaiting, so this batch does not hang - but without the
		// outer-catch settle the open barrier outlives the failed join (no
		// subscribe = no unsubscribe drain to clear it), and a LATER lone
		// :presence subscribe on the same socket awaits it forever.
		let allow = false;
		env.register('gate', {
			hall: live.room({
				topic: (ctx, id) => 'hall:' + id,
				init: async () => [],
				owner: true,
				presence: (ctx) => ({ name: ctx.user.name }),
				guard: () => { if (!allow) throw new Error('denied'); }
			})
		});
		const before = inFlightCount();
		const alice = openConn(env, { id: 'alice', name: 'Alice' });

		// Guarded join is denied: both items error (the guard throws in each).
		const denied = await sendBatch(env, alice, joinBatch('gate/hall', 5));
		expect(denied.d).toBeDefined();
		expect(denied.d.ok).toBe(false);
		expect(denied.p.ok).toBe(false);

		// Guard now allows; a lone :presence subscribe on the SAME socket must
		// respond (pre-fix it awaited the stale open barrier from the denied join).
		allow = true;
		const res = await sendBatch(env, alice, [
			{ rpc: 'gate/hall/__presence', id: 'p', args: [5], stream: true }
		]);
		expect(res.p).toBeDefined();
		expect(res.p.ok).toBe(true);
		expect(inFlightCount()).toBe(before);
	});
});
