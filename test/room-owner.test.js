import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { live, _presenceRefForTest } from '../src/server.js';
import { _resetOwnerForTests, _ownerGet, _ownerOnJoin, _ownerOnLeave } from '../src/server/room-owner.js';
import { _purgePresenceUser } from '../src/server/presence.js';
import { _extractRoomInfo, _extractMultiplayerInfo } from '../src/vite/extract-options.js';
import { state } from '../src/server/state.js';
import { _maybeReplayPublish, _resetReplayRouting } from '../src/server/replay-routing.js';

// ---------------------------------------------------------------------------
// Room ownership: `live.room({ owner: true })` tracks a per-room owner role.
// The first member to join claims it; when the owner leaves (after the
// presence grace window) the role passes deterministically to the
// longest-joined remaining member; an emptied room clears it. The handoff is
// observable on the `:owner` sub-topic and via the onOwnerChange hook.
//
// Tests drive the room's data-stream subscribe/unsubscribe hooks directly
// (the same harness the presence and enumeration suites use) with hand-built
// ctx objects. Cluster behavior runs on a Map-backed fake-redis stub shared
// across two platform objects modeling two instances - no Docker, no real
// Redis - with an `eval` that emulates the owner transition scripts, plus a
// scriptless variant that exercises the plain-hash-command fallback.
// ---------------------------------------------------------------------------

const flushAsync = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

/** Build a subscriber ctx: identity, platform, and a capture publish. */
function mkCtx(id, pub, platform) {
	return { user: { id }, platform: platform || {}, publish: pub, _publishWire: pub };
}

function mkRoom(extra = {}) {
	return live.room({
		topic: (ctx, id) => 'game:' + id,
		topicArgs: 1,
		init: async () => [],
		owner: true,
		...extra
	});
}

beforeEach(() => {
	_resetOwnerForTests();
	_presenceRefForTest().clear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('live.room owner - declaration', () => {
	it('is off by default: a plain room carries no owner surface', () => {
		const game = live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [] });
		expect(game.__hasOwner).toBe(false);
		expect(game.__ownerStream).toBeUndefined();
	});

	it('stamps the marker and the owner stream when enabled', () => {
		const game = mkRoom();
		expect(game.__hasOwner).toBe(true);
		expect(typeof game.__ownerStream).toBe('function');
		expect(game.__ownerStream.__streamOptions.merge).toBe('set');
	});

	it('rejects a non-boolean owner', () => {
		expect(() => mkRoom({ owner: 'yes' })).toThrow('owner must be true or false');
	});

	it('rejects a non-function onOwnerChange and one without owner: true', () => {
		expect(() => mkRoom({ onOwnerChange: 5 })).toThrow('onOwnerChange must be a function');
		expect(() =>
			live.room({ topic: (ctx, id) => 'g:' + id, topicArgs: 1, init: async () => [], onOwnerChange: () => {} })
		).toThrow('onOwnerChange requires owner: true');
	});

	it('rejects ownerOnly without owner, without actions, non-array, and unknown names', () => {
		expect(() =>
			live.room({ topic: (ctx, id) => 'g:' + id, topicArgs: 1, init: async () => [], ownerOnly: ['x'] })
		).toThrow('ownerOnly requires owner: true');
		expect(() => mkRoom({ ownerOnly: ['x'] })).toThrow('ownerOnly requires actions');
		expect(() => mkRoom({ ownerOnly: 'start', actions: { start: async () => {} } })).toThrow('array of action names');
		expect(() => mkRoom({ ownerOnly: ['stop'], actions: { start: async () => {} } })).toThrow("unknown action 'stop'");
	});

	it('passes through live.multiplayer()', () => {
		const board = live.multiplayer({
			topic: (ctx, id) => 'board:' + id,
			topicArgs: 1,
			owner: true
		});
		expect(board.__hasOwner).toBe(true);
		expect(typeof board.__ownerStream).toBe('function');
	});
});

describe('live.room owner - first-joiner delivery (flag-shaped :owner stream)', () => {
	beforeEach(() => { _resetReplayRouting(); });
	afterEach(() => { _resetReplayRouting(); });

	function replayPlatform() {
		const published = [];
		return {
			_published: published,
			replay: {
				publish: (_p, topic, event, data) => { published.push({ topic, event, data }); return Promise.resolve(); },
				since: async () => [],
				seq: async () => 0
			}
		};
	}

	it('declares the :owner stream flag-shaped so a fresh/racing subscriber can be seeded the latest owner', () => {
		const game = mkRoom();
		// merge:'set' single latest value, plus the replay/flag markers that route the
		// ownership emit into the shared buffer and serve it to a fresh/racing connect.
		expect(game.__ownerStream.__streamOptions.merge).toBe('set');
		expect(game.__ownerStream.__replay).toEqual({ size: 1 });
		expect(game.__ownerStream.__isFlag).toBe(true);
		expect(game.__ownerStream.__implicitReplay).toBe(true);
	});

	it('a cluster join registers the :owner topic so the ownership emit reaches the replay buffer', async () => {
		const game = mkRoom();
		const ds = game.__dataStream;
		const platform = replayPlatform();
		const pub = [];
		await ds.__onSubscribe(mkCtx('alice', (t, e, d) => pub.push({ t, e, d }), platform), 'game:7', [7]);
		// The join registered game:7:owner as replay-eligible (platform.replay present),
		// so the ownership publish now routes into the buffer for fresh-subscribe seeding.
		const routed = _maybeReplayPublish(platform, 'game:7:owner', 'set', { key: 'alice', reason: 'claimed' });
		expect(routed).toBe(true);
		expect(platform._published).toContainEqual({ topic: 'game:7:owner', event: 'set', data: { key: 'alice', reason: 'claimed' } });
	});

	it('a single-process join does not mark :owner replay-eligible (no spurious replay-extension warning)', async () => {
		const game = mkRoom();
		const ds = game.__dataStream;
		const pub = [];
		// No platform.replay -> single process. The join must NOT register :owner, so
		// _maybeReplayPublish stays inert and never warns about a replay extension the
		// app never opted into.
		await ds.__onSubscribe(mkCtx('alice', (t, e, d) => pub.push({ t, e, d }), {}), 'game:7', [7]);
		expect(_maybeReplayPublish({}, 'game:7:owner', 'set', { key: 'alice', reason: 'claimed' })).toBe(false);
	});
});

describe('live.room owner - single instance', () => {
	it('the first joiner claims; later joiners change nothing', async () => {
		const game = mkRoom();
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		await ds.__onSubscribe(mkCtx('alice', cap), 'game:7', [7]);
		await ds.__onSubscribe(mkCtx('bob', cap), 'game:7', [7]);
		expect(pub).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: 'alice', reason: 'claimed' } }
		]);
	});

	it('succession passes to the longest-joined remaining member after the grace window', async () => {
		vi.useFakeTimers();
		const changes = [];
		const game = mkRoom({ onOwnerChange: (c) => changes.push(c) });
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		const alice = mkCtx('alice', cap);
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(mkCtx('bob', cap), 'game:7', [7]);
		await ds.__onSubscribe(mkCtx('carol', cap), 'game:7', [7]);
		pub.length = 0;

		await ds.__onUnsubscribe(alice, 'game:7', 2);
		expect(pub).toEqual([]); // grace window: nothing yet
		await vi.advanceTimersByTimeAsync(5001);
		await flushAsync();
		expect(pub).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'succeeded' } }
		]);
		expect(changes).toEqual([
			{ topic: 'game:7', owner: 'alice', previous: null, reason: 'claimed' },
			{ topic: 'game:7', owner: 'bob', previous: 'alice', reason: 'succeeded' }
		]);
	});

	it('a non-owner leaving changes nothing', async () => {
		vi.useFakeTimers();
		const game = mkRoom();
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		await ds.__onSubscribe(mkCtx('alice', cap), 'game:7', [7]);
		const bob = mkCtx('bob', cap);
		await ds.__onSubscribe(bob, 'game:7', [7]);
		pub.length = 0;
		await ds.__onUnsubscribe(bob, 'game:7', 1);
		await vi.advanceTimersByTimeAsync(5001);
		await flushAsync();
		expect(pub).toEqual([]);
	});

	it('an emptied room vacates the role and the next joiner claims fresh', async () => {
		vi.useFakeTimers();
		const changes = [];
		const game = mkRoom({ onOwnerChange: (c) => changes.push(c) });
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		const alice = mkCtx('alice', cap);
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onUnsubscribe(alice, 'game:7', 0);
		await vi.advanceTimersByTimeAsync(5001);
		await flushAsync();
		expect(pub.at(-1)).toEqual({ topic: 'game:7:owner', event: 'set', data: { key: null, reason: 'vacated' } });
		expect(changes.at(-1)).toEqual({ topic: 'game:7', owner: null, previous: 'alice', reason: 'vacated' });

		pub.length = 0;
		await ds.__onSubscribe(mkCtx('bob', cap), 'game:7', [7]);
		expect(pub).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'claimed' } }
		]);
	});

	it('a reconnect inside the grace window keeps ownership (no handoff)', async () => {
		vi.useFakeTimers();
		const game = mkRoom();
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		const alice = mkCtx('alice', cap);
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(mkCtx('bob', cap), 'game:7', [7]);
		pub.length = 0;

		await ds.__onUnsubscribe(alice, 'game:7', 1);
		await vi.advanceTimersByTimeAsync(3000);
		await ds.__onSubscribe(alice, 'game:7', [7]); // back before grace expiry
		await vi.advanceTimersByTimeAsync(10000);
		await flushAsync();
		expect(pub).toEqual([]);
		expect(await _ownerGet(undefined, 'game:7')).toBe('alice');
	});

	it('a second tab closing does not run succession (per-identity refcount)', async () => {
		vi.useFakeTimers();
		const game = mkRoom();
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		const alice = mkCtx('alice', cap);
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(alice, 'game:7', [7]); // second tab
		pub.length = 0;
		await ds.__onUnsubscribe(alice, 'game:7', 1);
		await vi.advanceTimersByTimeAsync(5001);
		await flushAsync();
		expect(pub).toEqual([]);
		expect(await _ownerGet(undefined, 'game:7')).toBe('alice');
	});

	it('tracks membership without a presence function and stays out of the roster', async () => {
		const game = mkRoom(); // no presence config
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		await ds.__onSubscribe(mkCtx('alice', cap), 'game:7', [7]);
		// The owner claim is the ONLY publish - no presence join rides the wire.
		expect(pub.map((p) => p.topic)).toEqual(['game:7:owner']);
		expect(game.__presenceStream).toBeUndefined();
	});

	it('composes with presence: both surfaces publish on the same join', async () => {
		const game = mkRoom({ presence: (ctx) => ({ name: ctx.user.id }) });
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		await ds.__onSubscribe(mkCtx('alice', cap), 'game:7', [7]);
		expect(pub).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: 'alice', reason: 'claimed' } },
			{ topic: 'game:7:presence', event: 'join', data: { key: 'alice', data: { name: 'alice' } } }
		]);
	});

	it('the owner stream snapshot loader returns the current owner (reason null)', async () => {
		const game = mkRoom();
		const ds = game.__dataStream;
		const cap = () => {};
		await ds.__onSubscribe(mkCtx('alice', cap), 'game:7', [7]);
		const value = await game.__ownerStream({ platform: {} }, 7);
		expect(value).toEqual({ key: 'alice', reason: null });
		const empty = await game.__ownerStream({ platform: {} }, 99);
		expect(empty).toEqual({ key: null, reason: null });
	});

	it('an eviction sweep runs the departed owner succession', async () => {
		vi.useFakeTimers();
		const game = mkRoom();
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		const alice = mkCtx('alice', cap);
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(mkCtx('bob', cap), 'game:7', [7]);
		await ds.__onUnsubscribe(alice, 'game:7', 1); // grace timer armed
		pub.length = 0;

		const originalMax = state.maxPresenceRef;
		state.maxPresenceRef = 1;
		try {
			// The next join sweeps graced entries; alice's release must run her
			// succession instead of leaving a stale owner until the roster TTL.
			await ds.__onSubscribe(mkCtx('carol', cap), 'game:7', [7]);
			await flushAsync();
		} finally {
			state.maxPresenceRef = originalMax;
		}
		expect(pub).toContainEqual({ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'succeeded' } });
	});
});

describe('live.room owner - actions', () => {
	function mkActionRoom(extra = {}) {
		return mkRoom({
			actions: {
				start: async (ctx, id) => 'started:' + id,
				whoami: async (ctx, id) => ({ owner: await ctx.owner(), isOwner: await ctx.isOwner() }),
				handoff: async (ctx, id, to) => ctx.transferOwner(to)
			},
			ownerOnly: ['start'],
			...extra
		});
	}

	it('ownerOnly rejects a non-owner and an ownerless room, allows the owner', async () => {
		const game = mkActionRoom();
		const ds = game.__dataStream;
		const cap = () => {};
		const alice = mkCtx('alice', cap);
		const bob = mkCtx('bob', cap);

		// Nobody joined: fail closed.
		await expect(game.__actions.start(alice, 7)).rejects.toMatchObject({ code: 'FORBIDDEN' });

		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(bob, 'game:7', [7]);
		await expect(game.__actions.start(bob, 7)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(game.__actions.start(alice, 7)).resolves.toBe('started:7');
	});

	it('ctx.owner() and ctx.isOwner() read the room scoped to the action args', async () => {
		const game = mkActionRoom();
		const ds = game.__dataStream;
		const cap = () => {};
		const alice = mkCtx('alice', cap);
		const bob = mkCtx('bob', cap);
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(bob, 'game:7', [7]);
		expect(await game.__actions.whoami(alice, 7)).toEqual({ owner: 'alice', isOwner: true });
		expect(await game.__actions.whoami(bob, 7)).toEqual({ owner: 'alice', isOwner: false });
		// The helpers are shadowed per call and restored afterwards.
		expect(alice.owner).toBeUndefined();
		expect(alice.isOwner).toBeUndefined();
		expect(alice.transferOwner).toBeUndefined();
	});

	it('ctx.transferOwner hands off to a member, refuses non-owners, non-members, and self', async () => {
		const changes = [];
		const game = mkActionRoom({ onOwnerChange: (c) => changes.push(c) });
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		const alice = mkCtx('alice', cap);
		const bob = mkCtx('bob', cap);
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(bob, 'game:7', [7]);
		pub.length = 0;

		expect(await game.__actions.handoff(bob, 7, 'alice')).toBe(false); // not the owner
		expect(await game.__actions.handoff(alice, 7, 'mallory')).toBe(false); // not a member
		expect(await game.__actions.handoff(alice, 7, 'alice')).toBe(false); // self
		expect(pub).toEqual([]);

		expect(await game.__actions.handoff(alice, 7, 'bob')).toBe(true);
		await flushAsync();
		expect(pub).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'transferred' } }
		]);
		expect(changes.at(-1)).toEqual({ topic: 'game:7', owner: 'bob', previous: 'alice', reason: 'transferred' });
		// The gate follows the transfer: bob may now start, alice may not.
		await expect(game.__actions.start(bob, 7)).resolves.toBe('started:7');
		await expect(game.__actions.start(alice, 7)).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
});

// ---------------------------------------------------------------------------
// Cluster: a Map-backed fake-redis stub shared by two platform objects. The
// `eval` emulates the three owner transition scripts (join / leave /
// transfer) with the same atomic-per-call semantics real Redis scripting
// gives; the scriptless variant drops eval so the plain-command fallback
// path runs instead.
// ---------------------------------------------------------------------------

function makeOwnerFakeRedis({ scripting = true } = {}) {
	/** @type {Map<string, Map<string, string>>} */
	const hashes = new Map();
	const h = (k) => {
		let m = hashes.get(k);
		if (!m) { m = new Map(); hashes.set(k, m); }
		return m;
	};
	const incr = (k, field, by) => {
		const m = h(k);
		const next = (m.has(field) ? parseInt(m.get(field), 10) : 0) + by;
		m.set(field, String(next));
		return next;
	};
	const base = {
		async hget(k, field) {
			const m = hashes.get(k);
			const v = m && m.get(field);
			return v === undefined ? null : v;
		},
		async hset(k, field, value) {
			const m = h(k);
			const isNew = m.has(field) ? 0 : 1;
			m.set(field, String(value));
			return isNew;
		},
		async hgetall(k) {
			const m = hashes.get(k);
			if (!m) return {};
			const out = {};
			for (const [f, v] of m) out[f] = v;
			return out;
		},
		async hincrby(k, field, by) {
			return incr(k, field, by);
		},
		async hdel(k, ...fields) {
			const m = hashes.get(k);
			if (!m) return 0;
			let n = 0;
			for (const f of fields) { if (m.delete(f)) n++; }
			return n;
		},
		async expire() { return 1; },
		_hashes: hashes
	};
	if (!scripting) return base;
	return {
		...base,
		async eval(script, _numKeys, hKey, ...argv) {
			const m = h(hKey);
			const get = (f) => (m.has(f) ? m.get(f) : null);
			const pickSuccessor = () => {
				let best = null;
				let bestSeq = Infinity;
				for (const [f, v] of m) {
					if (!f.startsWith('j:')) continue;
					const cand = f.slice(2);
					const s = parseInt(v, 10);
					if (s < bestSeq || (s === bestSeq && (best === null || cand < best))) { best = cand; bestSeq = s; }
				}
				return best;
			};
			if (script.includes("'claimed'")) {
				const k = argv[0];
				incr(hKey, 'n:' + k, 1);
				if (get('j:' + k) === null) m.set('j:' + k, String(incr(hKey, 'q', 1)));
				const o = get('o');
				if (o !== null && get('j:' + o) !== null) return [o, '', ''];
				m.set('o', k);
				return [k, 'claimed', o === null ? '' : o];
			}
			if (script.includes("'succeeded'")) {
				const k = argv[0];
				const n = incr(hKey, 'n:' + k, -1);
				if (n > 0) return [get('o') || '', '', ''];
				m.delete('n:' + k);
				m.delete('j:' + k);
				const o = get('o');
				if (o === null || o !== k) return [o === null ? '' : o, '', ''];
				const best = pickSuccessor();
				if (best !== null) { m.set('o', best); return [best, 'succeeded', k]; }
				m.delete('o');
				m.delete('q');
				return ['', 'vacated', k];
			}
			// transfer
			const [from, to] = argv;
			const o = get('o');
			if (o === null || o !== from) return [o === null ? '' : o, '', ''];
			if (get('j:' + to) === null) return [o, '', ''];
			m.set('o', to);
			return [to, 'transferred', from];
		}
	};
}

function clusterHarness(redis, extra = {}) {
	const game = mkRoom(extra);
	const ds = game.__dataStream;
	const pubA = [];
	const pubB = [];
	const platformA = { redis };
	const platformB = { redis };
	const capA = (topic, event, data) => pubA.push({ topic, event, data });
	const capB = (topic, event, data) => pubB.push({ topic, event, data });
	return {
		game,
		ds,
		pubA,
		pubB,
		platformA,
		platformB,
		ctxA: (id) => mkCtx(id, capA, platformA),
		ctxB: (id) => mkCtx(id, capB, platformB)
	};
}

describe('live.room owner - cluster (two instances over shared fake redis)', () => {
	it('claims once cluster-wide; both instances read the same owner', async () => {
		const redis = makeOwnerFakeRedis();
		const { ds, pubA, pubB, platformA, platformB, ctxA, ctxB } = clusterHarness(redis);
		await ds.__onSubscribe(ctxA('alice'), 'game:7', [7]);
		await ds.__onSubscribe(ctxB('bob'), 'game:7', [7]);
		expect(pubA.filter((p) => p.topic === 'game:7:owner')).toHaveLength(1);
		expect(pubB.filter((p) => p.topic === 'game:7:owner')).toHaveLength(0);
		expect(await _ownerGet(platformA, 'game:7')).toBe('alice');
		expect(await _ownerGet(platformB, 'game:7')).toBe('alice');
	});

	it('succession is decided once, by the instance that released the owner, in cross-replica join order', async () => {
		vi.useFakeTimers();
		const redis = makeOwnerFakeRedis();
		const changes = [];
		const { ds, pubA, pubB, ctxA, ctxB } = clusterHarness(redis, { onOwnerChange: (c) => changes.push(c) });
		const alice = ctxA('alice');
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(ctxB('bob'), 'game:7', [7]); // joined second, on the OTHER instance
		await ds.__onSubscribe(ctxA('carol'), 'game:7', [7]);
		pubA.length = 0;
		pubB.length = 0;

		await ds.__onUnsubscribe(alice, 'game:7', 2);
		await vi.advanceTimersByTimeAsync(5001);
		await flushAsync();
		// Instance A observed the release, so A alone announces; bob (lowest
		// join sequence) inherits even though he lives on instance B.
		expect(pubA).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'succeeded' } }
		]);
		expect(pubB).toEqual([]);
		expect(changes.filter((c) => c.reason === 'succeeded')).toHaveLength(1);
	});

	it('the same identity counted across instances releases only on the last one', async () => {
		// Driven through the module directly: two real processes each hold
		// their own local gate, which a single test process cannot model
		// through the room hooks (the shared ref map collapses the identity).
		const redis = makeOwnerFakeRedis();
		const pA = { redis };
		const pB = { redis };
		expect((await _ownerOnJoin(pA, 'game:7', 'alice', null))?.reason).toBe('claimed');
		expect(await _ownerOnJoin(pB, 'game:7', 'alice', null)).toBeNull(); // same identity, second instance
		expect(await _ownerOnJoin(pB, 'game:7', 'bob', null)).toBeNull();

		expect(await _ownerOnLeave(pA, 'game:7', 'alice')).toBeNull(); // still connected on B
		expect(await _ownerGet(pB, 'game:7')).toBe('alice');

		const change = await _ownerOnLeave(pB, 'game:7', 'alice'); // the last instance releases
		expect(change).toMatchObject({ owner: 'bob', previous: 'alice', reason: 'succeeded' });
	});

	it('heals a stale owner on the next join', async () => {
		const redis = makeOwnerFakeRedis();
		const { ds, pubB, platformB, ctxA, ctxB } = clusterHarness(redis);
		await ds.__onSubscribe(ctxA('alice'), 'game:7', [7]);
		// Simulate a crashed replica's orphan: the owner's membership fields
		// vanish (TTL edge) but the role field survives.
		redis._hashes.get('__live-room-owner:game:7').delete('j:alice');
		redis._hashes.get('__live-room-owner:game:7').delete('n:alice');

		await ds.__onSubscribe(ctxB('bob'), 'game:7', [7]);
		expect(pubB).toContainEqual({ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'claimed' } });
		expect(await _ownerGet(platformB, 'game:7')).toBe('bob');
	});

	it('a leave for a topic this replica never joined touches nothing on redis', async () => {
		const redis = makeOwnerFakeRedis();
		await _ownerOnLeave({ redis }, 'game:foreign', 'alice');
		expect(redis._hashes.has('__live-room-owner:game:foreign')).toBe(false);
	});

	it('a stray orphaned count never suppresses a rejoin claim', async () => {
		// A crashed replica can leave a count behind with no membership row and
		// no owner. The identity's next join must still allocate its sequence
		// and claim - membership is verified per join, never inferred from the
		// count.
		const redis = makeOwnerFakeRedis();
		const p = { redis };
		redis._hashes.set('__live-room-owner:game:7', new Map([['n:alice', '1']]));
		const change = await _ownerOnJoin(p, 'game:7', 'alice', null);
		expect(change).toMatchObject({ owner: 'alice', previous: null, reason: 'claimed' });
		expect(await _ownerGet(p, 'game:7')).toBe('alice');
	});
});

describe('live.room owner - cluster without scripting (fallback path)', () => {
	it('claim, succession, and vacate run on plain hash commands', async () => {
		vi.useFakeTimers();
		const redis = makeOwnerFakeRedis({ scripting: false });
		const { ds, pubA, pubB, platformA, ctxA, ctxB } = clusterHarness(redis);
		const alice = ctxA('alice');
		const bob = ctxB('bob');
		await ds.__onSubscribe(alice, 'game:7', [7]);
		await ds.__onSubscribe(bob, 'game:7', [7]);
		expect(await _ownerGet(platformA, 'game:7')).toBe('alice');
		pubA.length = 0;
		pubB.length = 0;

		await ds.__onUnsubscribe(alice, 'game:7', 1);
		await vi.advanceTimersByTimeAsync(5001);
		await flushAsync();
		expect(pubA).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'succeeded' } }
		]);

		await ds.__onUnsubscribe(bob, 'game:7', 0);
		await vi.advanceTimersByTimeAsync(5001);
		await flushAsync();
		expect(pubB).toEqual([
			{ topic: 'game:7:owner', event: 'set', data: { key: null, reason: 'vacated' } }
		]);
	});
});

describe('live.room owner - forget purge', () => {
	it('purging the owner runs succession', async () => {
		const changes = [];
		const game = mkRoom({
			presence: (ctx) => ({ name: ctx.user.id }),
			onOwnerChange: (c) => changes.push(c)
		});
		const ds = game.__dataStream;
		const pub = [];
		const cap = (topic, event, data) => pub.push({ topic, event, data });
		await ds.__onSubscribe(mkCtx('alice', cap), 'game:7', [7]);
		await ds.__onSubscribe(mkCtx('bob', cap), 'game:7', [7]);
		pub.length = 0;

		const removed = await _purgePresenceUser(null, null, 'alice', cap);
		await flushAsync();
		expect(removed).toBe(1);
		expect(pub).toContainEqual({ topic: 'game:7:owner', event: 'set', data: { key: 'bob', reason: 'succeeded' } });
		expect(changes.at(-1)).toEqual({ topic: 'game:7', owner: 'bob', previous: 'alice', reason: 'succeeded' });
	});
});

describe('owner codegen extraction', () => {
	it('_extractRoomInfo reads the owner knob', () => {
		const src = `
export const game = live.room({
  topic: (ctx, id) => 'game:' + id,
  topicArgs: 1,
  init: async () => [],
  owner: true
});
export const plain = live.room({
  topic: (ctx, id) => 'p:' + id,
  init: async () => []
});
`;
		expect(_extractRoomInfo(src, 'game').hasOwner).toBe(true);
		expect(_extractRoomInfo(src, 'plain').hasOwner).toBe(false);
	});

	it('_extractMultiplayerInfo reads the owner knob', () => {
		const src = `
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  owner: true
});
`;
		expect(_extractMultiplayerInfo(src, 'board').hasOwner).toBe(true);
	});
});
