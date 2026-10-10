import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, configureForget, _resetForget } from '../src/server.js';
import { _presenceRef, state } from '../src/server/state.js';
import { _resetOwnerForTests, _ownerGet } from '../src/server/room-owner.js';
import { _clusterPresenceList } from '../src/server/presence.js';
import { _tenantTopic } from '../src/server/tenant.js';

function fakeRedis() {
	const hashes = new Map();
	const hash = key => { if (!hashes.has(key)) hashes.set(key, new Map()); return hashes.get(key); };
	return {
		hget: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
		hgetall: vi.fn(async key => Object.fromEntries(hashes.get(key) || [])),
		hset: vi.fn(async (key, field, value) => { hash(key).set(field, String(value)); return 1; }),
		hincrby: vi.fn(async (key, field, delta) => { const next = Number(hash(key).get(field) || 0) + delta; hash(key).set(field, String(next)); return next; }),
		hdel: vi.fn(async (key, ...fields) => fields.reduce((n, field) => n + Number(hashes.get(key)?.delete(field) || false), 0)),
		expire: vi.fn(async () => 1)
	};
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
	const redis = fakeRedis();
	const publish = vi.fn();
	const platform = { redis, publish };
	const changes = vi.fn();
	const room = live.room({ topic: (_ctx, id) => 'room:' + id, topicArgs: 1, init: async () => [],
		presence: ctx => ({ name: ctx.user.id }), owner: true, onOwnerChange: changes });
	const context = (id, tenantId = null) => ({ user: { id }, ws: {}, tenantId, platform, publish, _publishWire: publish });
	const join = async (id, name = 'one', tenant = null) => {
		const ctx = context(id, tenant);
		await room.__dataStream.__onSubscribe(ctx, _tenantTopic(tenant, 'room:' + name), [name]);
		return ctx;
	};
	const durable = vi.fn(async () => 0);
	configureForget({ platform, store: { purgeUser: durable } });
	return { redis, platform, room, changes, publish, context, join, durable };
}
beforeEach(() => { _resetForget(); _presenceRef.clear(); _resetOwnerForTests(); });
afterEach(() => { for (const ref of _presenceRef.values()) if (ref.timer) clearTimeout(ref.timer); _presenceRef.clear(); _resetOwnerForTests(); _resetForget(); vi.useRealTimers(); });

describe('presence erasure confirmation and retry', () => {
	it.each(['before', 'after'])('retains a scrubbed retry target when roster deletion fails %s applying', async when => {
		const env = setup();
		const alice = await env.join('alice');
		await env.join('bob');
		expect(env.room.__isMember(null, 'room:one', 'alice', alice.ws)).toBe(true);
		const remove = env.redis.hdel.getMockImplementation();
		let broken = true;
		env.redis.hdel.mockImplementation(async (key, ...fields) => {
			if (broken && key === '__live-presence:room:one') {
				if (when === 'after') await remove(key, ...fields);
				throw new Error('unconfirmed delete');
			}
			return remove(key, ...fields);
		});
		const completed = vi.fn();
		await expect(live.forget('alice', { onForget: completed })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(completed).not.toHaveBeenCalled();
		expect(env.durable).toHaveBeenCalledOnce();
		expect(_presenceRef.get('room:one\0alice')).toMatchObject({ count: 0, data: null, gone: true });
		expect(env.room.__isMember(null, 'room:one', 'alice', alice.ws)).toBe(false);
		expect(await _clusterPresenceList(null, 'room:one')).toEqual([{ key: 'bob', data: { name: 'bob' } }]);
		expect(await _ownerGet(env.platform, 'room:one')).toBe('bob');
		await env.room.__dataStream.__onUnsubscribe(alice, 'room:one', 1);
		await expect(env.join('alice')).rejects.toMatchObject({ code: 'FORBIDDEN' });
		broken = false;
		await expect(live.forget('alice')).resolves.toMatchObject({ ok: true, surfaces: { presence: 1 } });
		expect(_presenceRef.has('room:one\0alice')).toBe(false);
		expect(await env.redis.hgetall('__live-presence:room:one')).toEqual({ 'c:bob': '1', 'd:bob': '{"name":"bob"}' });
		expect(env.redis.hincrby.mock.calls.filter(([, , delta]) => delta < 0)).toEqual([]);
		expect(env.changes.mock.calls.filter(([change]) => change.reason === 'succeeded')).toHaveLength(1);
	});

	it('retries owner cleanup after roster cleanup succeeds and ownership deletion fails', async () => {
		const env = setup();
		await env.join('alice'); await env.join('bob');
		const remove = env.redis.hdel.getMockImplementation();
		let broken = true;
		env.redis.hdel.mockImplementation((key, ...fields) => {
			if (broken && key === '__live-room-owner:room:one') throw new Error('owner unavailable');
			return remove(key, ...fields);
		});
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(await env.redis.hget('__live-presence:room:one', 'd:alice')).toBeNull();
		expect(await _ownerGet(env.platform, 'room:one')).toBe('alice');
		broken = false;
		await expect(live.forget('alice')).resolves.toMatchObject({ ok: true });
		expect(await _ownerGet(env.platform, 'room:one')).toBe('bob');
		expect(await env.redis.hget('__live-room-owner:room:one', 'n:alice')).toBeNull();
	});

	it('repairs a lost owner-write reply without repeating the authoritative succession', async () => {
		const env = setup(); await env.join('alice'); await env.join('bob');
		const write = env.redis.hset.getMockImplementation();
		let lost = true;
		env.redis.hset.mockImplementation(async (key, field, value) => {
			const result = await write(key, field, value);
			if (lost && key === '__live-room-owner:room:one' && field === 'o') { lost = false; throw new Error('reply lost'); }
			return result;
		});
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(await _ownerGet(env.platform, 'room:one')).toBe('bob');
		env.redis.hset.mockClear(); env.publish.mockClear();
		await live.forget('alice');
		expect(env.redis.hset.mock.calls.filter(([, field]) => field === 'o')).toEqual([]);
		expect(env.publish.mock.calls.map(call => call.slice(0, 3))).toContainEqual(['room:one:owner', 'set', { key: 'bob', reason: 'succeeded' }]);
		expect(env.changes.mock.calls.filter(([change]) => change.reason === 'succeeded')).toHaveLength(0);
	});

	it.each([undefined, false, NaN, -1])('does not confirm malformed roster deletion result %s', async result => {
		const env = setup(); await env.join('alice');
		const remove = env.redis.hdel.getMockImplementation();
		env.redis.hdel.mockImplementation((key, ...fields) => key.startsWith('__live-presence:') ? result : remove(key, ...fields));
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(_presenceRef.has('room:one\0alice')).toBe(true);
	});

	it('continues other refs and scopes retry targets to the requested tenant', async () => {
		const env = setup();
		await env.join('alice', 'broken', 'one'); await env.join('alice', 'healthy', 'one'); await env.join('alice', 'broken', 'two');
		const brokenKey = '__live-presence:' + _tenantTopic('one', 'room:broken');
		const remove = env.redis.hdel.getMockImplementation();
		env.redis.hdel.mockImplementation((key, ...fields) => { if (key === brokenKey) throw new Error('down'); return remove(key, ...fields); });
		await expect(live.forget('alice', { tenantId: 'one' })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(_presenceRef.has(_tenantTopic('one', 'room:healthy') + '\0alice')).toBe(false);
		expect(await env.redis.hget('__live-presence:' + _tenantTopic('one', 'room:healthy'), 'd:alice')).toBeNull();
		expect(_presenceRef.get(_tenantTopic('two', 'room:broken') + '\0alice').data).toEqual({ name: 'alice' });
	});

	it('removes the identity across replicas for known rooms without decrementing uncertain counts', async () => {
		const env = setup();
		await env.join('alice'); await env.join('bob');
		await env.redis.hincrby('__live-presence:room:one', 'c:alice', 3);
		await env.redis.hincrby('__live-room-owner:room:one', 'n:alice', 3);
		await live.forget('alice');
		expect(await env.redis.hget('__live-presence:room:one', 'd:alice')).toBeNull();
		expect(await env.redis.hget('__live-room-owner:room:one', 'j:alice')).toBeNull();
		expect(await _ownerGet(env.platform, 'room:one')).toBe('bob');
	});

	it('waits for an in-flight join before confirming erasure and suppresses its late join publication', async () => {
		const env = setup();
		const gate = deferred(); const entered = deferred();
		const incr = env.redis.hincrby.getMockImplementation();
		env.redis.hincrby.mockImplementation(async (...args) => {
			if (args[0] === '__live-presence:room:one') { entered.resolve(); await gate.promise; }
			return incr(...args);
		});
		const joining = env.join('alice'); await entered.promise;
		const erasing = live.forget('alice');
		await Promise.resolve(); gate.resolve();
		await Promise.all([joining, erasing]);
		expect(await env.redis.hgetall('__live-presence:room:one')).toEqual({});
		expect(_presenceRef.has('room:one\0alice')).toBe(false);
		expect(env.publish.mock.calls.filter(([, event]) => event === 'join')).toEqual([]);
	});

	it('retains a disconnect already awaiting Redis so concurrent erasure can retry its failed release', async () => {
		vi.useFakeTimers();
		const env = setup(); const alice = await env.join('alice'); await env.join('bob');
		const gate = deferred(); const entered = deferred();
		const incr = env.redis.hincrby.getMockImplementation();
		env.redis.hincrby.mockImplementation(async (...args) => {
			if (args[0] === '__live-presence:room:one' && args[2] < 0) { entered.resolve(); await gate.promise; throw new Error('lost release'); }
			return incr(...args);
		});
		await env.room.__dataStream.__onUnsubscribe(alice, 'room:one', 1);
		vi.advanceTimersByTime(5001); await entered.promise;
		const erasing = live.forget('alice');
		await Promise.resolve(); gate.resolve(); await erasing;
		expect(await env.redis.hget('__live-presence:room:one', 'd:alice')).toBeNull();
		expect(_presenceRef.has('room:one\0alice')).toBe(false);
	});

	it('keeps failed cleanup within the existing ref cap and cannot evict it as a grace timer', async () => {
		const env = setup(); await env.join('alice');
		const cap = state.maxPresenceRef; state.maxPresenceRef = 1;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const remove = env.redis.hdel.getMockImplementation();
		env.redis.hdel.mockImplementation((key, ...fields) => { if (key.startsWith('__live-presence:')) throw new Error('down'); return remove(key, ...fields); });
		try {
			await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
			await env.join('bob', 'other');
			expect(_presenceRef.size).toBe(1);
			expect(_presenceRef.get('room:one\0alice').gone).toBe(true);
		} finally { state.maxPresenceRef = cap; state.presenceRefWarnFired = false; warn.mockRestore(); }
	});

	it('coalesces concurrent same-identity joins while cap eviction awaits Redis', async () => {
		const env = setup(); const alice = await env.join('alice');
		await env.room.__dataStream.__onUnsubscribe(alice, 'room:one', 0);
		const cap = state.maxPresenceRef; state.maxPresenceRef = 1;
		const gate = deferred(); const entered = deferred();
		const incr = env.redis.hincrby.getMockImplementation();
		env.redis.hincrby.mockImplementation(async (...args) => {
			if (args[0] === '__live-presence:room:one' && args[2] < 0) { entered.resolve(); await gate.promise; }
			return incr(...args);
		});
		try {
			const first = env.join('bob', 'two'); await entered.promise;
			const second = env.join('bob', 'two');
			await Promise.resolve(); gate.resolve(); await Promise.all([first, second]);
			expect(_presenceRef.get('room:two\0bob').count).toBe(2);
			expect(await env.redis.hget('__live-presence:room:two', 'c:bob')).toBe('1');
			expect(await env.redis.hget('__live-room-owner:room:two', 'n:bob')).toBe('1');
		} finally { gate.resolve(); state.maxPresenceRef = cap; state.presenceRefWarnFired = false; }
	});

	it('shares an active erasure attempt across concurrent callers', async () => {
		const env = setup(); await env.join('alice'); await env.join('bob');
		const gate = deferred(); const entered = deferred();
		const remove = env.redis.hdel.getMockImplementation();
		env.redis.hdel.mockImplementation(async (key, ...fields) => {
			if (key === '__live-presence:room:one' && fields.includes('d:alice')) { entered.resolve(); await gate.promise; }
			return remove(key, ...fields);
		});
		const first = live.forget('alice'); await entered.promise;
		const second = live.forget('alice'); await Promise.resolve(); gate.resolve();
		await Promise.all([first, second]);
		expect(env.redis.hdel.mock.calls.filter(([key, ...fields]) => key === '__live-presence:room:one' && fields.includes('d:alice'))).toHaveLength(1);
		expect(env.changes.mock.calls.filter(([change]) => change.reason === 'succeeded')).toHaveLength(1);
	});
});
