import { describe, it, expect, afterEach } from 'vitest';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import {
	_setTenantResolver,
	_resetTenantResolver,
	_resolveTenant,
	_validTenantId,
	_tenantTopic,
	_tenantKey,
	_stripTenantTopic
} from '../src/server/tenant.js';
import { _clusterRoomsList } from '../src/server/rooms-cluster.js';
import { live, __register, __registerDerived, handleRpc } from '../src/server.js';
import { state, _derivedBySource } from '../src/server/state.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

afterEach(() => _resetTenantResolver());

/** Build a real ctx (with the tenant wrapper) for a user over a capturing platform. */
function ctxFor(platform, user) {
	return _buildCtx(user, {}, platform, _getCtxHelpers(platform), null, null);
}

/** Minimal ioredis-shaped fake hosting the cluster rooms roster (hash ops only). */
function makeFakeRedis() {
	const hashes = new Map();
	const get = (h) => { let m = hashes.get(h); if (!m) { m = new Map(); hashes.set(h, m); } return m; };
	return {
		async hincrby(h, field, by) { const m = get(h); const cur = m.has(field) ? parseInt(m.get(field), 10) : 0; const next = cur + by; m.set(field, String(next)); return next; },
		async hset(h, field, value) { get(h).set(field, String(value)); return 1; },
		async hget(h, field) { const m = hashes.get(h); const v = m && m.get(field); return v === undefined ? null : v; },
		async hgetall(h) { const m = hashes.get(h); if (!m) return {}; const out = {}; for (const [k, v] of m) out[k] = v; return out; },
		async hdel(h, ...fields) { const m = hashes.get(h); if (!m) return 0; let n = 0; for (const f of fields) if (m.delete(f)) n++; return n; },
		async expire() { return 1; }
	};
}

describe('live.tenant: id validation + prefix helpers', () => {
	it('validates the id charset and rejects delimiter-unsafe ids', () => {
		expect(_validTenantId('org-123')).toBe('org-123');
		expect(_validTenantId('Acme_Co')).toBe('Acme_Co');
		for (const bad of ['', 'a:b', 'a/b', 'a b', 'a\0b', 'a.b', '@t', 5, null, undefined]) {
			expect(() => _validTenantId(/** @type {any} */ (bad))).toThrow();
		}
	});

	it('caps the id length so the wire prefix always fits the 256-char bus cap', () => {
		expect(_validTenantId('a'.repeat(64))).toHaveLength(64); // a UUID (36) fits comfortably
		expect(() => _validTenantId('a'.repeat(65))).toThrow();
	});

	it('prefixes a topic / key only when a tenant is present (pure prepend)', () => {
		expect(_tenantTopic('A', 'game:7')).toBe('@t/A/game:7');
		expect(_tenantTopic(null, 'game:7')).toBe('game:7');
		// Prepend commutes with suffix - the property the room sub-topics rely on.
		expect(_tenantTopic('A', 'game:7') + ':presence').toBe(_tenantTopic('A', 'game:7:presence'));
		expect(_tenantKey('A', 'rpc:checkout:k')).toBe('A\0rpc:checkout:k');
		expect(_tenantKey(null, 'rpc:checkout:k')).toBe('rpc:checkout:k');
	});

	it('strips the tenant prefix back to the logical topic (round trip)', () => {
		expect(_stripTenantTopic('A', '@t/A/game:7')).toBe('game:7');
		expect(_stripTenantTopic('A', _tenantTopic('A', 'game:7'))).toBe('game:7');
		expect(_stripTenantTopic(null, 'game:7')).toBe('game:7'); // no tenant -> unchanged
		// Safe on an already-logical topic, and only strips THIS tenant's prefix.
		expect(_stripTenantTopic('A', 'game:7')).toBe('game:7');
		expect(_stripTenantTopic('A', '@t/B/game:7')).toBe('@t/B/game:7');
	});
});

describe('live.tenant: ctx.tenantId resolution (server-trusted, opt-in)', () => {
	it('is null with no resolver (single-tenant, byte-identical)', () => {
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1', org: 'acme' });
		expect(ctx.tenantId).toBe(null);
		ctx.publish('orders', 'created', { n: 1 });
		expect(p.published[0].topic).toBe('orders'); // no prefix
	});

	it('resolves the tenant from the server-trusted user and scopes publishes', () => {
		_setTenantResolver((user) => user?.org);
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1', org: 'acme' });
		expect(ctx.tenantId).toBe('acme');
		ctx.publish('orders', 'created', { n: 1 });
		expect(p.published[0].topic).toBe('@t/acme/orders');
		// _publishWire is the raw, NON-prefixing publish for framework code that
		// already holds a wire topic (no double-prefix).
		ctx._publishWire('@t/acme/orders:presence', 'join', {});
		expect(p.published[1].topic).toBe('@t/acme/orders:presence');
	});

	it('never reads the tenant from the wire and rejects a bad resolver id loudly', () => {
		_setTenantResolver(() => 'bad:id');
		expect(() => _resolveTenant({})).toThrow(); // a misconfigured resolver fails, not silently disables scoping
	});

	it('isolates two tenants on the SAME logical topic', () => {
		_setTenantResolver((user) => user.org);
		const p = mockPlatform();
		ctxFor(p, { org: 'a' }).publish('dashboard', 'tick', { v: 1 });
		ctxFor(p, { org: 'b' }).publish('dashboard', 'tick', { v: 2 });
		expect(p.published[0].topic).toBe('@t/a/dashboard');
		expect(p.published[1].topic).toBe('@t/b/dashboard');
		expect(p.published[0].topic).not.toBe(p.published[1].topic);
	});
});

describe('live.tenant: ctx.tenant(other) explicit cross-tenant publish', () => {
	it('publishes into another tenant scope from a handler', () => {
		_setTenantResolver((user) => user.org);
		const p = mockPlatform();
		const ctx = ctxFor(p, { org: 'a' });
		ctx.tenant('b').publish('events', 'created', { x: 1 });
		expect(p.published[0].topic).toBe('@t/b/events');
		expect(() => ctx.tenant('bad:id')).toThrow();
		expect(() => ctx.tenant('b').publish('__signal:x', 'e', {})).toThrow();
	});
});

describe('live.tenant: idempotency + lock keys are auto-scoped', () => {
	it('keeps the same idempotency key in distinct slots per tenant', async () => {
		_setTenantResolver((user) => user.org);
		const keys = [];
		const store = {
			async acquire(key) { keys.push(key); return { acquired: true, async commit() {}, async abort() {} }; }
		};
		const handler = live.idempotent({ keyFrom: () => 'order-1', store }, async () => 'ok');
		const p = mockPlatform();
		await handler(ctxFor(p, { org: 'a' }));
		await handler(ctxFor(p, { org: 'b' }));
		expect(keys).toHaveLength(2);
		expect(keys[0].startsWith('a\0')).toBe(true);
		expect(keys[1].startsWith('b\0')).toBe(true);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it('gives two tenants INDEPENDENT locks for the same key', async () => {
		_setTenantResolver((user) => user.org);
		const seen = [];
		const customLock = { async withLock(key, fn) { seen.push(key); return fn(); } };
		const handler = live.lock({ key: () => 'leaderboard', lock: customLock }, async () => 'ok');
		const p = mockPlatform();
		await handler(ctxFor(p, { org: 'a' }));
		await handler(ctxFor(p, { org: 'b' }));
		expect(seen[0].startsWith('a\0')).toBe(true);
		expect(seen[1].startsWith('b\0')).toBe(true);
	});
});

describe('live.tenant: room enumeration is isolated per tenant', () => {
	const orgResolver = (user) => user.org;
	const enumGame = () => {
		const game = live.room({
			topic: (ctx, id) => 'game:' + id,
			topicArgs: 1,
			init: async () => [],
			meta: (id) => ({ name: 'g' + id })
		});
		game.__setEnumId('lobby/game');
		return game;
	};

	it('single-replica: two tenants on the SAME export enumerate only their own rooms', async () => {
		_setTenantResolver(orgResolver);
		const game = enumGame();
		const p = mockPlatform();
		const ctxA = ctxFor(p, { org: 'a' });
		const ctxB = ctxFor(p, { org: 'b' });
		// The dispatch chokepoint hands the hook the WIRE data topic; simulate that.
		await game.__dataStream.__onSubscribe(ctxA, _tenantTopic('a', 'game:7'), [7]);
		await game.__dataStream.__onSubscribe(ctxB, _tenantTopic('b', 'game:9'), [9]);

		// Each tenant's lobby snapshot lists ONLY its own room, with the LOGICAL topic.
		expect(await game.__roomsStream(ctxA)).toEqual([{ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7' } }]);
		expect(await game.__roomsStream(ctxB)).toEqual([{ topic: 'game:9', args: [9], count: 1, meta: { name: 'g9' } }]);

		// The deltas rode DISTINCT per-tenant channels (each tenant's own lobby), and
		// carry the logical topic - never the wire topic, never the other's data.
		expect(p.published.map((m) => m.topic)).toEqual(['@t/a/rooms-enum:lobby/game', '@t/b/rooms-enum:lobby/game']);
		expect(p.published[0].data).toMatchObject({ topic: 'game:7' });
		expect(p.published[1].data).toMatchObject({ topic: 'game:9' });
	});

	it('single-replica: the SAME room id in two tenants stays two independent rooms', async () => {
		_setTenantResolver(orgResolver);
		const game = enumGame();
		const p = mockPlatform();
		const ctxA = ctxFor(p, { org: 'a' });
		const ctxB = ctxFor(p, { org: 'b' });
		// Both tenants open the same logical room id.
		await game.__dataStream.__onSubscribe(ctxA, _tenantTopic('a', 'game:1'), [1]);
		await game.__dataStream.__onSubscribe(ctxB, _tenantTopic('b', 'game:1'), [1]);
		// Each is a fresh 'created' with count 1 - B's open never bumped A's count.
		expect(await game.__roomsStream(ctxA)).toEqual([{ topic: 'game:1', args: [1], count: 1, meta: { name: 'g1' } }]);
		expect(await game.__roomsStream(ctxB)).toEqual([{ topic: 'game:1', args: [1], count: 1, meta: { name: 'g1' } }]);
		expect(p.published.map((m) => m.event)).toEqual(['created', 'created']);
	});

	it('cluster (platform.redis): per-tenant roster keys; one tenant never sees the other', async () => {
		_setTenantResolver(orgResolver);
		const game = enumGame();
		const p = mockPlatform();
		p.redis = makeFakeRedis();
		const ctxA = ctxFor(p, { org: 'a' });
		const ctxB = ctxFor(p, { org: 'b' });
		await game.__dataStream.__onSubscribe(ctxA, _tenantTopic('a', 'game:7'), [7]);
		await game.__dataStream.__onSubscribe(ctxB, _tenantTopic('b', 'game:9'), [9]);

		// The shared roster is partitioned by a tenant-scoped key, so a HGETALL for
		// one tenant can never surface the other's rooms.
		expect(await _clusterRoomsList(p, _tenantKey('a', 'lobby/game'))).toEqual([{ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7' } }]);
		expect(await _clusterRoomsList(p, _tenantKey('b', 'lobby/game'))).toEqual([{ topic: 'game:9', args: [9], count: 1, meta: { name: 'g9' } }]);
		// The shared, un-scoped key holds nothing - no field was ever written there.
		expect(await _clusterRoomsList(p, 'lobby/game')).toEqual([]);

		// And the loader the lobby actually runs reads only the requester's tenant.
		expect(await game.__roomsStream(ctxA)).toEqual([{ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7' } }]);
		expect(await game.__roomsStream(ctxB)).toEqual([{ topic: 'game:9', args: [9], count: 1, meta: { name: 'g9' } }]);
	});

	it('cluster: a disconnect drain releases the SAME tenant roster the open bumped', async () => {
		_setTenantResolver(orgResolver);
		const game = enumGame();
		const p = mockPlatform();
		p.redis = makeFakeRedis();
		const ctxA = ctxFor(p, { org: 'a' });
		await game.__dataStream.__onSubscribe(ctxA, _tenantTopic('a', 'game:7'), [7]);
		expect(await _clusterRoomsList(p, _tenantKey('a', 'lobby/game'))).toHaveLength(1);
		// The unsub hook is driven with the same tenant ctx server.js builds for the
		// drain, so the release lands on the tenant-scoped key and the room closes.
		await game.__dataStream.__onUnsubscribe(ctxA, _tenantTopic('a', 'game:7'), 0);
		expect(await _clusterRoomsList(p, _tenantKey('a', 'lobby/game'))).toEqual([]);
		const last = p.published[p.published.length - 1];
		expect(last.topic).toBe('@t/a/rooms-enum:lobby/game');
		expect(last.event).toBe('deleted');
		expect(last.data).toEqual({ topic: 'game:7' });
	});

	it('no resolver: enumeration is byte-identical (no prefix on channel, roster, or payload)', async () => {
		const game = enumGame();
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1' });
		expect(ctx.tenantId).toBe(null);
		await game.__dataStream.__onSubscribe(ctx, 'game:7', [7]);
		expect(p.published[0].topic).toBe('rooms-enum:lobby/game'); // no @t/ prefix
		expect(p.published[0].data).toMatchObject({ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7' } });
		expect(await game.__roomsStream(ctx)).toEqual([{ topic: 'game:7', args: [7], count: 1, meta: { name: 'g7' } }]);
	});
});

describe('live.tenant: ctx.signal keys by user id (point-to-point delivery contract)', () => {
	it('targets `__signal:<userId>` regardless of tenant (use globally-unique user ids)', () => {
		// Signals are delivered to the client under the logical `__signal:<userId>`
		// topic - the client keys its onSignal store on that and cannot learn a
		// server-only tenant prefix, so the channel is NOT tenant-scoped. Under
		// tenancy, isolation comes from globally-unique user ids (the norm).
		_setTenantResolver((u) => u.org);
		const p = mockPlatform();
		ctxFor(p, { org: 'a' }).signal('alice', 'ping', { n: 1 });
		ctxFor(p, { org: 'b' }).signal('bob', 'ping', { n: 2 });
		expect(p.published[0].topic).toBe('__signal:alice');
		expect(p.published[1].topic).toBe('__signal:bob');
	});

	it('no resolver: byte-identical bare `__signal:<userId>`', () => {
		const p = mockPlatform();
		ctxFor(p, { org: 'a' }).signal('alice', 'ping', {});
		expect(p.published[0].topic).toBe('__signal:alice');
	});
});

describe('live.tenant(id, config) factory', () => {
	it('validates the id, registers the config, and publishes into the tenant scope', () => {
		expect(() => live.tenant('bad:id')).toThrow();
		const p = mockPlatform();
		const saved = state.derivedPlatform;
		state.derivedPlatform = p; // the handle publishes through the active server platform
		try {
			const acme = live.tenant('acme', { quota: { rps: 10 } });
			expect(acme.id).toBe('acme');
			expect(acme.config).toEqual({ quota: { rps: 10 } });
			acme.publish('orders', 'created', { n: 1 });
			expect(p.published[0].topic).toBe('@t/acme/orders'); // scoped to the tenant
			expect(() => acme.publish('__signal:x', 'e', {})).toThrow(); // reserved guard on the logical topic
		} finally {
			state.derivedPlatform = saved;
		}
	});
});

describe('live.tenant: multiplayer cursor is scoped per tenant', () => {
	it('publishes cursor frames on per-tenant `:cursors` channels', async () => {
		_setTenantResolver((u) => u.org);
		const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, topicArgs: 1, cursors: true, presence: () => ({}) });
		const p = mockPlatform();
		await board.__cursorMove(ctxFor(p, { org: 'a', id: 'ua' }), '1', { x: 1, y: 2 });
		await board.__cursorMove(ctxFor(p, { org: 'b', id: 'ub' }), '1', { x: 3, y: 4 });
		expect(p.published.map((m) => m.topic)).toEqual(['@t/a/board:1:cursors', '@t/b/board:1:cursors']);
	});
});

describe('live.tenant: room presence roster + join channel are scoped per tenant', () => {
	it('two tenants in the same room never share a roster or a join channel', async () => {
		_setTenantResolver((u) => u.org);
		const room = live.room({
			topic: (ctx, id) => 'room:' + id,
			topicArgs: 1,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user.name })
		});
		const p = mockPlatform();
		const ctxA = ctxFor(p, { org: 'a', id: 'ua', name: 'Alice' });
		const ctxB = ctxFor(p, { org: 'b', id: 'ub', name: 'Bob' });
		// The data-stream onSubscribe gets the WIRE data topic (dispatch prefixed it).
		await room.__dataStream.__onSubscribe(ctxA, _tenantTopic('a', 'room:1'), [1]);
		await room.__dataStream.__onSubscribe(ctxB, _tenantTopic('b', 'room:1'), [1]);
		// Each join rode its own tenant's `:presence` channel - no double prefix.
		expect(p.published.map((m) => m.topic).sort()).toEqual(['@t/a/room:1:presence', '@t/b/room:1:presence']);
		// Each presence loader reconstructs ONLY its own tenant's roster.
		expect(await room.__presenceStream(ctxA, 1)).toEqual([{ key: 'ua', data: { name: 'Alice' } }]);
		expect(await room.__presenceStream(ctxB, 1)).toEqual([{ key: 'ub', data: { name: 'Bob' } }]);
	});
});

describe('live.tenant: dynamic derived watches its own tenant sources (H3)', () => {
	it('two tenants get distinct instances watching distinct WIRE source topics', () => {
		_setTenantResolver((u) => u.org);
		const fn = live.derived((orgArg) => ['orders:' + orgArg], async () => 0);
		__registerDerived('test/g1-derived', fn);
		const logical = /** @type {any} */ (fn).__streamTopic('shared'); // populates topicArgs
		const p = mockPlatform();
		/** @type {any} */ (fn).__onSubscribe(ctxFor(p, { org: 'a' }), _tenantTopic('a', logical));
		/** @type {any} */ (fn).__onSubscribe(ctxFor(p, { org: 'b' }), _tenantTopic('b', logical));
		// Each tenant watches its OWN wire source; the un-prefixed (cross-tenant)
		// source is never registered, so one tenant's write cannot recompute another's.
		expect(_derivedBySource.has('@t/a/orders:shared')).toBe(true);
		expect(_derivedBySource.has('@t/b/orders:shared')).toBe(true);
		expect(_derivedBySource.has('orders:shared')).toBe(false);
	});
});

describe('live.tenant: unscoped (null-tenant) connections cannot enter the @t/ wire namespace', () => {
	// A null-tenant connection's namespace is "every topic NOT starting with
	// @t/" (_topicInTenant). Before the fix, a client-controlled dynamic topic
	// arg of '@t/<victim>/...' resolved RAW as the wire topic: cross-tenant
	// subscribe AND publish.

	function registerPassThroughStream() {
		// Pass-through factory topic (client arg becomes the topic verbatim),
		// the documented dynamic-topic shape the attack needs.
		__register('feed/view', live.stream(
			(x) => x,
			async (ctx, x) => ['snapshot:' + x],
			{ merge: 'latest' }
		));
	}

	async function subscribe(ws, platform, id, arg) {
		platform.sent.length = 0;
		handleRpc(ws, toArrayBuffer({ rpc: 'feed/view', id, args: [arg], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		return platform.sent[0] && platform.sent[0].data;
	}

	it('rejects a null-tenant subscribe whose resolved topic starts with @t/', async () => {
		_setTenantResolver((user) => (user && typeof user.tid === 'string' ? user.tid : null));
		registerPassThroughStream();
		const platform = mockPlatform();
		const guest = mockWs(); // anonymous -> resolver yields null tenant

		const resp = await subscribe(guest, platform, 'g1', '@t/victim/room1');
		expect(resp.ok).toBe(false);
		expect(resp.code).toBe('INVALID_REQUEST');
		expect(guest.isSubscribed('@t/victim/room1')).toBe(false);
		expect(guest.getTopics()).toEqual([]);
	});

	it('still lets a null-tenant connection subscribe to ordinary topics', async () => {
		_setTenantResolver((user) => (user && typeof user.tid === 'string' ? user.tid : null));
		registerPassThroughStream();
		const platform = mockPlatform();
		const guest = mockWs();

		const resp = await subscribe(guest, platform, 'g2', 'room1');
		expect(resp.ok).toBe(true);
		expect(resp.topic).toBe('room1');
		expect(guest.isSubscribed('room1')).toBe(true);
	});

	it("keeps a scoped tenant's '@t/...' arg wrapped into its OWN namespace", async () => {
		_setTenantResolver((user) => (user && typeof user.tid === 'string' ? user.tid : null));
		registerPassThroughStream();
		const platform = mockPlatform();
		const scoped = mockWs({ id: 'u1', tid: 'tenantB' });

		const resp = await subscribe(scoped, platform, 's1', '@t/tenantA/room1');
		expect(resp.ok).toBe(true);
		// The whole logical topic is prefixed - the socket lands in its own
		// tenant's namespace, never in tenantA's.
		expect(resp.topic).toBe('@t/tenantB/@t/tenantA/room1');
		expect(scoped.isSubscribed('@t/tenantB/@t/tenantA/room1')).toBe(true);
		expect(scoped.isSubscribed('@t/tenantA/room1')).toBe(false);
	});

	it('refuses ctx.publish to an @t/-prefixed topic from an unscoped connection', () => {
		_setTenantResolver((user) => (user && typeof user.tid === 'string' ? user.tid : null));
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'guest1' }); // resolver yields null tenant
		expect(ctx.tenantId).toBe(null);
		expect(() => ctx.publish('@t/victim/room1', 'update', { forged: true })).toThrow(/'@t\/'-prefixed/);
		expect(p.published).toEqual([]);
		// The raw wire helper (framework-internal) is unaffected.
		ctx._publishWire('@t/victim/room1:presence', 'join', {});
		expect(p.published).toHaveLength(1);
	});

	it("keeps a scoped tenant's ctx.publish of '@t/...' inside its own namespace", () => {
		_setTenantResolver((user) => user.org);
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1', org: 'b' });
		ctx.publish('@t/a/room1', 'update', { v: 1 });
		expect(p.published[0].topic).toBe('@t/b/@t/a/room1');
	});

	// ctx.publish is not the only surface that takes a handler-supplied topic.
	// The timer-deferred helpers and the batch list form reach platform.publish
	// too, so each must apply the SAME namespace rule or it becomes the escape
	// hatch. One case per surface, both directions.
	for (const surface of ['publishThrottled', 'publishDebounced', 'throttle', 'debounce']) {
		it(`refuses ctx.${surface} to an @t/-prefixed topic from an unscoped connection`, () => {
			_setTenantResolver((user) => (user && typeof user.tid === 'string' ? user.tid : null));
			const p = mockPlatform();
			const ctx = ctxFor(p, { id: 'guest1' });
			expect(ctx.tenantId).toBe(null);
			expect(() => ctx[surface]('@t/victim/room1', 'update', { forged: true }, 50)).toThrow(/'@t\/'-prefixed/);
			expect(p.published).toEqual([]);
		});

		it(`scopes ctx.${surface} into the connection's own tenant namespace`, async () => {
			_setTenantResolver((user) => user.org);
			const p = mockPlatform();
			const ctx = ctxFor(p, { id: 'u1', org: 'b' });
			// Unique topic per surface: the throttle/debounce registries are keyed
			// by topic+event and shared across these cases.
			const topic = 'room-' + surface;
			ctx[surface](topic, 'update', { v: 1 }, 20);
			// The debounce family is trailing-edge, so it publishes after the delay.
			if (surface.toLowerCase().includes('debounce')) await new Promise((r) => setTimeout(r, 60));
			expect(p.published[0].topic).toBe('@t/b/' + topic);
		});
	}

	// helpers.batch iterates whatever it is handed, so an Array.isArray check
	// alone let a Set or a generator past the namespace rule with its topics
	// untouched - the guard has to cover every iterable shape.
	it('applies the namespace rule to a non-array iterable batch', () => {
		_setTenantResolver((user) => user.org);
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1', org: 'b' });
		ctx.batch(new Set([{ topic: 'room1', event: 'update', data: { v: 1 } }]));
		const topics = (p.batched || p.published).map((m) => m.topic);
		expect(topics).toEqual(['@t/b/room1']);
	});

	it('refuses an @t/-prefixed topic inside a non-array iterable batch', () => {
		_setTenantResolver((user) => (user && typeof user.tid === 'string' ? user.tid : null));
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'guest1' });
		function* gen() { yield { topic: '@t/victim/room1', event: 'update', data: { forged: true } }; }
		expect(() => ctx.batch(gen())).toThrow(/'@t\/'-prefixed/);
		expect(p.published).toEqual([]);
	});

	// The reserved-prefix guard must hold on the DEFAULT single-tenant path too,
	// not only when a resolver happens to be installed - otherwise these surfaces
	// are the way to forge a framework-internal channel on almost every app.
	it('refuses a __-prefixed topic on the deferred surfaces with no tenancy configured', () => {
		_resetTenantResolver();
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1' });
		expect(() => ctx.publishThrottled('__signal:victim', 'evt', { forged: 1 }, 50)).toThrow(/'__'-prefixed/);
		expect(() => ctx.publishDebounced('__signal:victim', 'evt', { forged: 1 }, 50)).toThrow(/'__'-prefixed/);
		expect(() => ctx.batch([{ topic: '__signal:victim', event: 'evt', data: { forged: 1 } }])).toThrow(/'__'-prefixed/);
		expect(p.published).toEqual([]);
	});

	// The `@t/` refusal is deliberately NOT gated on a resolver being configured:
	// the subscribe boundary refuses a resolved `@t/` topic whenever tenantId is
	// null (dispatch.js, `!ctx.tenantId`), tenancy configured or not, and the
	// deferred surfaces match it. That alignment is what keeps turning tenancy ON
	// later a non-breaking change - an app cannot accumulate `@t/`-named topics
	// while single-tenant and then have them re-read as tenant channels. Pinned
	// here because the obvious "fix" is to gate this on _isTenancyEnabled(), which
	// would quietly re-open exactly that trap.
	it('refuses an @t/ topic on the deferred surfaces with no tenancy configured', () => {
		_resetTenantResolver();
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1' });
		for (const surface of ['publishThrottled', 'publishDebounced', 'throttle', 'debounce']) {
			expect(() => ctx[surface]('@t/a/room1', 'update', { v: 1 }, 20)).toThrow(/'@t\/'-prefixed/);
		}
		expect(() => ctx.batch([{ topic: '@t/a/room1', event: 'update', data: { v: 1 } }])).toThrow(/'@t\/'-prefixed/);
		expect(p.published).toEqual([]);
	});

	// The one surface that does NOT refuse it, recorded so the divergence is a
	// known fact rather than a surprise. With no resolver configured ctx.publish
	// stays the bare helper reference (the single-tenant fast path), so it has no
	// per-connection wrapper in which to apply the rule. Harmless in itself - with
	// no tenancy there are no `@t/` channels to reach - and such a topic is
	// unusable anyway because the subscribe side refuses it. Closing it would cost
	// a wrapper frame plus a startsWith on every publish on the default path.
	it('documents ctx.publish as the one surface that accepts @t/ with no tenancy configured', () => {
		_resetTenantResolver();
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1' });
		ctx.publish('@t/a/room1', 'update', { v: 1 });
		expect(p.published.map((m) => m.topic)).toEqual(['@t/a/room1']);
	});

	it('refuses ctx.batch to an @t/-prefixed topic from an unscoped connection', () => {
		_setTenantResolver((user) => (user && typeof user.tid === 'string' ? user.tid : null));
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'guest1' });
		expect(() => ctx.batch([{ topic: '@t/victim/room1', event: 'update', data: { forged: true } }])).toThrow(/'@t\/'-prefixed/);
		expect(p.published).toEqual([]);
	});

	it("scopes ctx.batch into the connection's own tenant namespace", () => {
		_setTenantResolver((user) => user.org);
		const p = mockPlatform();
		const ctx = ctxFor(p, { id: 'u1', org: 'b' });
		ctx.batch([{ topic: 'room1', event: 'update', data: { v: 1 } }]);
		const topics = (p.batched || p.published).map((m) => m.topic);
		expect(topics).toEqual(['@t/b/room1']);
	});
});
