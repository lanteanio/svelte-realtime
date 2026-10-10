import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, configureForget, _resetForget } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { WRAPPED_FOR_REPLAY } from '../src/server/replay-routing.js';
import { _presenceRef } from '../src/server/state.js';
import { _resetOwnerForTests } from '../src/server/room-owner.js';
import { _setTenantResolver, _resetTenantResolver, _tenantTopic } from '../src/server/tenant.js';

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

describe('forget updates connected room peers', () => {
	let env, clients, published, originalPublish;
	beforeEach(() => {
		vi.useFakeTimers(); _resetForget(); _resetOwnerForTests();
		env = createTestEnv(); clients = [];
		originalPublish = env.platform.publish;
		published = vi.spyOn(env.platform, 'publish');
		env.register('board', { room: live.room({
			topic: () => 'forget-board', init: () => [], presence: ctx => ({ name: ctx.user.id }), owner: true
		}) });
	});
	afterEach(async () => {
		published.mockImplementation(originalPublish);
		for (const client of clients) client.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		for (const ref of _presenceRef.values()) if (ref.timer) clearTimeout(ref.timer);
		_presenceRef.clear(); env.cleanup(); _resetForget(); _resetOwnerForTests(); _resetTenantResolver();
		vi.useRealTimers();
	});
	async function connect(id, tenantId = null, path = 'board/room') {
		const client = env.connect({ id, tenantId }); clients.push(client);
		const data = client.subscribe(path + '/__data');
		await vi.advanceTimersByTimeAsync(0); expect(data.error).toBeNull();
		return client;
	}
	async function watch(client) {
		const roster = client.subscribe('board/room/__presence');
		const owner = client.subscribe('board/room/__owner');
		await vi.advanceTimersByTimeAsync(0);
		expect(roster.error).toBeNull(); expect(owner.error).toBeNull();
		return { roster, owner };
	}

	it.each([false, true])('uses the captured platform for roster and owner erasure with Redis=%s', async cluster => {
		if (cluster) env.platform.redis = fakeRedis();
		await connect('alice'); const bob = await connect('bob');
		const { roster, owner } = await watch(bob);
		expect(roster.value.map(row => row.key).sort()).toEqual(['alice', 'bob']);
		expect(owner.value.key).toBe('alice'); published.mockClear();
		await expect(live.forget('alice')).resolves.toMatchObject({ surfaces: { presence: 1 } });
		expect(roster.value.map(row => row.key)).toEqual(['bob']);
		expect(owner.value).toEqual({ key: 'bob', reason: 'succeeded' });
		expect(published).toHaveBeenCalledWith('forget-board:presence', 'leave', { key: 'alice' }, { seq: false });
		expect(published).toHaveBeenCalledWith('forget-board:owner', 'set', { key: 'bob', reason: 'succeeded' }, { seq: false });
		if (cluster) {
			expect(await env.platform.redis.hget('__live-presence:forget-board', 'd:alice')).toBeNull();
			expect(await env.platform.redis.hget('__live-room-owner:forget-board', 'n:alice')).toBeNull();
			expect(await env.platform.redis.hget('__live-room-owner:forget-board', 'o')).toBe('bob');
		}
	});

	it('publishes only inside the erased tenant while keeping sibling and unscoped rosters', async () => {
		_setTenantResolver(user => user.tenantId ?? null);
		const watchers = [];
		for (const tenant of ['one', 'two', null]) {
			await connect('alice', tenant); const bob = await connect('bob', tenant); watchers.push(await watch(bob));
		}
		published.mockClear(); await live.forget('alice', { tenantId: 'one' });
		expect(watchers[0].roster.value.map(row => row.key)).toEqual(['bob']);
		for (const peer of watchers.slice(1)) {
			expect(peer.roster.value.map(row => row.key).sort()).toEqual(['alice', 'bob']); expect(peer.owner.value.key).toBe('alice');
		}
		expect(published.mock.calls.map(call => call[0])).toEqual([
			_tenantTopic('one', 'forget-board') + ':presence', _tenantTopic('one', 'forget-board') + ':cursors', _tenantTopic('one', 'forget-board') + ':owner'
		]);
	});

	it.each(['leave', 'owner'])('retains a scrubbed retry target when the %s publication rejects', async failure => {
		await connect('alice'); const bob = await connect('bob'); const { roster, owner } = await watch(bob);
		const completed = vi.fn();
		published.mockImplementation((topic, event, data, options) => {
			if ((failure === 'leave' && event === 'leave') || (failure === 'owner' && topic.endsWith(':owner'))) return Promise.reject(new Error('publication unavailable'));
			return originalPublish(topic, event, data, options);
		});
		await expect(live.forget('alice', { onForget: completed })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(completed).not.toHaveBeenCalled();
		expect(_presenceRef.get('forget-board\0alice')).toMatchObject({ data: null, count: 0, gone: true });
		published.mockImplementation(originalPublish);
		await expect(live.forget('alice')).resolves.toMatchObject({ ok: true });
		expect(roster.value.map(row => row.key)).toEqual(['bob']); expect(owner.value.key).toBe('bob');
		expect(_presenceRef.has('forget-board\0alice')).toBe(false);
	});

	it('fails missing publication capability and permits retry with an explicit platform', async () => {
		await connect('alice'); const bob = await connect('bob'); const { roster } = await watch(bob);
		const ref = _presenceRef.get('forget-board\0alice'); ref.platform = null;
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(ref).toMatchObject({ data: null, count: 0, gone: true });
		expect(roster.value.some(row => row.key === 'alice')).toBe(true);
		configureForget({ platform: env.platform });
		await live.forget('alice'); expect(roster.value.map(row => row.key)).toEqual(['bob']);
	});

	it('uses the captured Redis even when an explicit publication platform has none', async () => {
		env.platform.redis = fakeRedis();
		await connect('alice'); const bob = await connect('bob'); const { roster, owner } = await watch(bob);
		configureForget({ platform: { publish: (...args) => env.platform.publish(...args) } });
		await live.forget('alice');
		expect(await env.platform.redis.hget('__live-presence:forget-board', 'd:alice')).toBeNull();
		expect(await env.platform.redis.hget('__live-room-owner:forget-board', 'n:alice')).toBeNull();
		expect(roster.value.map(row => row.key)).toEqual(['bob']); expect(owner.value.key).toBe('bob');
	});

	it('erases subscription-free cursor publishers through their captured Redis and publish handle', async () => {
		env.platform.redis = fakeRedis();
		env.register('drawing', { room: live.multiplayer({ topic: () => 'drawing-board', cursors: true }) });
		const alice = env.connect({ id: 'alice' }), bob = env.connect({ id: 'bob' }); clients.push(alice, bob);
		const cursors = bob.subscribe('drawing/room/__cursors'); await vi.advanceTimersByTimeAsync(0);
		await alice.call('drawing/room/__cursor/move', { x: 3 }); expect(cursors.value).toHaveLength(1);
		await live.forget('alice'); expect(cursors.value).toEqual([]);
		expect(await env.platform.redis.hget('__live-presence:\0cursors:drawing-board', 'c:alice')).toBeNull();
		expect(published).toHaveBeenCalledWith('drawing-board:cursors', 'remove', { key: 'alice' }, { seq: false });
	});
	it.each(['synchronous', 'asynchronous'])('retries an owner replay publication after %s failure without bare fallback', async mode => {
		let broken = false;
		env.platform.replay = { publish: (_platform, topic, event, data) => {
			if (broken) {
				if (mode === 'synchronous') throw new Error('replay unavailable');
				return Promise.reject(new Error('replay unavailable'));
			}
			return originalPublish(topic, event, data, { seq: false });
		} };
		await connect('alice'); const bob = await connect('bob'); const { owner } = await watch(bob);
		const completed = vi.fn(); published.mockClear(); broken = true;
		await expect(live.forget('alice', { onForget: completed })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(completed).not.toHaveBeenCalled(); expect(owner.value.key).toBe('alice');
		expect(published.mock.calls.filter(([topic]) => topic.endsWith(':owner'))).toEqual([]);
		expect(_presenceRef.get('forget-board\0alice')).toMatchObject({ data: null, gone: true, erasure: { ownerDone: false } });
		broken = false; await live.forget('alice');
		expect(owner.value.key).toBe('bob'); expect(_presenceRef.has('forget-board\0alice')).toBe(false);
	});

	it.each([false, true])('does not complete or audit until owner replay publication settles (wrapped=%s)', async wrapped => {
		let hold = false, release, entered;
		const gate = new Promise(resolve => { release = resolve; });
		const started = new Promise(resolve => { entered = resolve; });
		const route = (topic, event, data, options) => {
			if (hold && topic.endsWith(':owner')) { entered(); return gate.then(() => originalPublish(topic, event, data, options)); }
			return originalPublish(topic, event, data, options);
		};
		const replay = vi.fn((_platform, topic, event, data) => route(topic, event, data, { seq: false }));
		env.platform.replay = { publish: replay };
		if (wrapped) { env.platform[WRAPPED_FOR_REPLAY] = true; published.mockImplementation(route); }
		await connect('alice'); const bob = await connect('bob'); const { owner } = await watch(bob);
		hold = true; const completed = vi.fn(); let settled = false;
		const forgetting = live.forget('alice', { onForget: completed }).then(result => { settled = true; return result; });
		await started; await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false); expect(completed).not.toHaveBeenCalled(); expect(owner.value.key).toBe('alice');
		release(); await forgetting;
		expect(owner.value.key).toBe('bob'); expect(completed).toHaveBeenCalledOnce();
		if (wrapped) expect(replay).not.toHaveBeenCalled();
	});

	it('retries strict erasure after a concurrently retiring publisher rejects', async () => {
		env.platform.redis = fakeRedis();
		env.register('drawing', { room: live.multiplayer({ topic: () => 'drawing-board', cursors: true }) });
		const alice = env.connect({ id: 'alice' }), bob = env.connect({ id: 'bob' }); clients.push(alice, bob);
		const cursors = bob.subscribe('drawing/room/__cursors'); await vi.advanceTimersByTimeAsync(0);
		await alice.call('drawing/room/__cursor/move', { x: 3 });
		let release, entered, blocked = true;
		const gate = new Promise(resolve => { release = resolve; });
		const started = new Promise(resolve => { entered = resolve; });
		const read = env.platform.redis.hget.getMockImplementation();
		env.platform.redis.hget.mockImplementation(async (key, field) => {
			if (blocked && key === '__live-presence:drawing-board') { entered(); await gate; }
			return read(key, field);
		});
		published.mockImplementation((topic, event, data, options) => {
			if (event === 'remove') throw new Error('departure publication unavailable');
			return originalPublish(topic, event, data, options);
		});
		alice.disconnect(); vi.advanceTimersByTime(5001); await started;
		const ref = _presenceRef.get('\0cursors:drawing-board\0alice'); expect(ref.leaving).toBeTruthy();
		const erasing = live.forget('alice'); const failed = expect(erasing).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		await vi.advanceTimersByTimeAsync(0); expect(ref.erasure).toBeTruthy();
		blocked = false; release(); await failed;
		expect(cursors.value).toHaveLength(1); expect(_presenceRef.has('\0cursors:drawing-board\0alice')).toBe(true);
		published.mockImplementation(originalPublish);
		await expect(live.forget('alice')).resolves.toMatchObject({ ok: true });
		expect(cursors.value).toEqual([]); expect(_presenceRef.has('\0cursors:drawing-board\0alice')).toBe(false);
	});

});
