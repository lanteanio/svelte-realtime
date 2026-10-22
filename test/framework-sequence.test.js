import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	live,
	__registerCron,
	__registerAggregate,
	_tickCron,
	_clearCron,
	_activateDerived,
	_resetAggregates,
	_prepareHmr,
	setCronPlatform,
	configureForget,
	_resetForget
} from '../src/server.js';
import { _throttles, _debounces } from '../src/server/publish-helpers.js';
import { state } from '../src/server/state.js';
import { _purgePresenceUser } from '../src/server/presence.js';
import { createTestEnv } from '../src/testing.js';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { enforceClusterPublishPolicy } from './helpers/cluster-publish-policy.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 30));
let env;
afterEach(() => { env?.cleanup(); env = undefined; });

describe('framework frames on a multi-worker adapter', () => {
	it('delivers user signals without a per-worker sequence counter', () => {
		const platform = mockPlatform();
		enforceClusterPublishPolicy(platform);
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		expect(ctx.signal('alice', 'notice', { unread: 2 })).toBe(true);
		expect(platform.published).toEqual([{
			topic: '__signal:alice', event: 'notice', data: { unread: 2 }, options: { seq: false }
		}]);
	});

	it('keeps application publish sequence choices explicit', () => {
		const platform = mockPlatform();
		enforceClusterPublishPolicy(platform);
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		expect(() => ctx.publish('app', 'set', 1)).toThrow(/clustered publish/);
		ctx.publish('app', 'set', 2, { seq: 17, relay: false });
		expect(platform.published[0].options).toEqual({ seq: 17, relay: false });
	});

	it('delivers room membership, cursor, presence fields and reactions to peers', async () => {
		env = createTestEnv();
		enforceClusterPublishPolicy(env.platform);
		env.register('collab', { board: live.multiplayer({
			topic: (ctx, id) => 'board:' + id, topicArgs: 1,
			init: async () => [], presence: ctx => ({ name: ctx.user.name }),
			cursors: true, typing: true, reactions: true, owner: true,
			actions: {
				handoff: (ctx, id, to) => ctx.transferOwner(to),
				write: ctx => ctx.publish('created', { id: 'note' })
			}
		}) });
		const alice = env.connect({ id: 'alice', name: 'Alice' });
		const bob = env.connect({ id: 'bob', name: 'Bob' });
		const roster = bob.subscribe('collab/board/__presence', 'a');
		const cursors = bob.subscribe('collab/board/__cursors', 'a');
		const reactions = bob.subscribe('collab/board/__reactions', 'a');
		const owner = bob.subscribe('collab/board/__owner', 'a');
		await settle();
		const data = alice.subscribe('collab/board/__data', 'a');
		await settle();
		expect(roster.value.map(row => row.key)).toEqual(['alice']);
		expect(owner.value.key).toBe('alice');
		await alice.call('collab/board/__action/write', 'a');
		await settle();
		expect(data.value).toEqual([{ id: 'note' }]);
		await alice.call('collab/board/__cursor/move', 'a', { x: 4, y: 8 });
		await alice.call('collab/board/__presence/update', 'a', { typing: true });
		await alice.call('collab/board/__reaction/emit', 'a', 'wave');
		await settle();
		expect(cursors.value).toEqual([expect.objectContaining({ key: 'alice', x: 4, y: 8 })]);
		expect(roster.value).toEqual([expect.objectContaining({ key: 'alice', typing: true })]);
		expect(reactions.value).toEqual([expect.objectContaining({ key: 'alice', token: 'wave' })]);
		bob.subscribe('collab/board/__data', 'a');
		await settle();
		await alice.call('collab/board/__action/handoff', 'a', 'bob');
		await settle();
		expect(owner.value).toEqual({ key: 'bob', reason: 'transferred' });
		await _purgePresenceUser(env.platform, null, 'bob', _getCtxHelpers(env.platform).publish);
		await settle();
		expect(roster.value.map(row => row.key)).toEqual(['alice']);
		expect(owner.value.key).toBe('alice');
	});

	it('delivers feature flag values without a replay extension', async () => {
		env = createTestEnv();
		enforceClusterPublishPolicy(env.platform);
		const enabled = live.flag('feature:enabled', false);
		env.register('flags', { enabled });
		const value = env.connect({ id: 'alice' }).subscribe('flags/enabled');
		await settle();
		expect(value.value).toBe(false);
		enabled.set(true);
		await settle();
		expect(value.value).toBe(true);
	});
});

describe('framework-owned publishes declare no sequence', () => {
	const optionsFor = (platform, topic) => platform.published.filter(p => p.topic === topic).map(p => p.options);

	afterEach(() => {
		_clearCron();
		setCronPlatform(null);
		_resetAggregates();
		_prepareHmr();
		_throttles.clear();
		_debounces.clear();
		vi.useRealTimers();
	});

	function enforcedPlatform() {
		const platform = mockPlatform();
		enforceClusterPublishPolicy(platform);
		return platform;
	}

	it('publishes a cron tick result', async () => {
		const platform = enforcedPlatform();
		setCronPlatform(platform);
		__registerCron('seq/tick', live.cron('* * * * *', 'seq:cron', () => ({ n: 1 })));
		await _tickCron();
		await settle();
		expect(optionsFor(platform, 'seq:cron')).toEqual([{ seq: false }]);
	});

	for (const debounce of [0, 20]) {
		it('publishes aggregate recomputes and window boundaries (debounce ' + debounce + ')', async () => {
			vi.useFakeTimers();
			const platform = enforcedPlatform();
			const reducers = { count: { init: () => 0, reduce: acc => acc + 1 } };
			__registerAggregate('seq/agg', live.aggregate('seq:src', reducers, { topic: 'seq:agg', debounce }));
			__registerAggregate('seq/win', live.aggregate('seq:src', reducers, {
				topic: 'seq:win', debounce, windows: { m: { type: 'tumbling', period: 'minute' } }
			}));
			_activateDerived(platform);
			setCronPlatform(platform);
			platform.publish('seq:src', 'add', {}, { seq: false });
			await vi.advanceTimersByTimeAsync(debounce);
			expect(optionsFor(platform, 'seq:agg')).toEqual([{ seq: false }]);
			expect(optionsFor(platform, 'seq:win:m')).toEqual([{ seq: false }]);
			// The window boundary publishes from its own timer.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(optionsFor(platform, 'seq:win:m').length).toBeGreaterThan(1);
			expect(optionsFor(platform, 'seq:win:m').every(o => o?.seq === false)).toBe(true);
		});
	}

	it('publishes the clean value of an aggregate reset by erasure', async () => {
		const platform = enforcedPlatform();
		const reducers = { users: { init: () => ({}), reduce: (acc, _event, value) => ({ ...acc, [value.id]: true }) } };
		__registerAggregate('seq/erase', live.aggregate('seq:people', reducers, { topic: 'seq:erase', forget: 'reset' }));
		_activateDerived(platform);
		setCronPlatform(platform);
		configureForget({ platform, store: { purgeUser: async () => 0 } });
		try {
			platform.publish('seq:people', 'added', { id: 'alice' }, { seq: false });
			await live.forget('alice', { tenantId: null });
			expect(platform.published.filter(p => p.topic === 'seq:erase').map(p => [p.data, p.options]))
				.toEqual([[{ users: { alice: true } }, { seq: false }], [{ users: {} }, { seq: false }]]);
		} finally {
			_resetForget();
		}
	});

	for (const debounce of [0, 20]) {
		it('delivers derived recomputes (debounce ' + debounce + ')', async () => {
			let value = 0;
			env = createTestEnv();
			enforceClusterPublishPolicy(env.platform);
			env.register('stats', { total: live.derived(['seq:source'], () => value, { debounce }) });
			const stream = env.connect().subscribe('stats/total');
			await stream.waitFor(v => v === 0);
			value = 5;
			env.platform.publish('seq:source', 'set', 5, { seq: false });
			await stream.waitFor(v => v === 5);
		});
	}

	it('delivers invalidateOn reloads', async () => {
		let loads = 0;
		env = createTestEnv();
		enforceClusterPublishPolicy(env.platform);
		env.register('feed', {
			read: live.stream('seq:feed', async () => ({ loads: ++loads }), { merge: 'set', invalidateOn: 'seq:control' }),
			touch: live(ctx => ctx.publish('seq:control', 'changed', {}, { seq: false }))
		});
		const client = env.connect();
		const stream = client.subscribe('feed/read');
		await stream.waitFor(v => v?.loads === 1);
		await client.call('feed/touch');
		await stream.waitFor(v => v?.loads === 2);
	});

	it('delivers staleAfterMs reloads', async () => {
		vi.useFakeTimers();
		let loads = 0;
		env = createTestEnv();
		enforceClusterPublishPolicy(env.platform);
		env.register('feed', { read: live.stream('seq:stale', async () => ({ loads: ++loads }), { merge: 'set', staleAfterMs: 1000 }) });
		const stream = env.connect().subscribe('feed/read');
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.value).toEqual({ loads: 1 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(stream.value).toEqual({ loads: 2 });
	});

	it('publishes inbound webhook events', async () => {
		const platform = enforcedPlatform();
		const hook = live.webhook('seq:payments', {
			verify: ({ body }) => JSON.parse(body),
			transform: event => ({ event: 'paid', data: event })
		});
		expect(await hook.handle({ body: '{"id":1}', headers: {}, platform })).toMatchObject({ status: 200 });
		expect(optionsFor(platform, 'seq:payments')).toEqual([{ seq: false }]);
	});

	it('publishes throttled leading and trailing edges', async () => {
		vi.useFakeTimers();
		const platform = enforcedPlatform();
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		ctx.publishThrottled('seq:throttle', 'set', 1, 50);
		ctx.publishThrottled('seq:throttle', 'set', 2, 50);
		await vi.advanceTimersByTimeAsync(50);
		expect(platform.published.filter(p => p.topic === 'seq:throttle').map(p => [p.data, p.options]))
			.toEqual([[1, { seq: false }], [2, { seq: false }]]);
	});

	it('publishes debounced trailing edges', async () => {
		vi.useFakeTimers();
		const platform = enforcedPlatform();
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		ctx.publishDebounced('seq:debounce', 'set', 1, 50);
		ctx.publishDebounced('seq:debounce', 'set', 2, 50);
		await vi.advanceTimersByTimeAsync(50);
		expect(platform.published.filter(p => p.topic === 'seq:debounce').map(p => [p.data, p.options]))
			.toEqual([[2, { seq: false }]]);
	});

	it('publishes immediately at throttle and debounce capacity', () => {
		const platform = enforcedPlatform();
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		for (let i = 0; i < 5000; i++) {
			_throttles.set('fill' + i, { timer: null, lastData: undefined, lastEvent: 'set', platform, lastRun: 0 });
			_debounces.set('fill' + i, null);
		}
		ctx.publishThrottled('seq:full', 'set', 1, 50);
		ctx.publishDebounced('seq:full', 'set', 2, 50);
		expect(platform.published.filter(p => p.topic === 'seq:full').map(p => [p.data, p.options]))
			.toEqual([[1, { seq: false }], [2, { seq: false }]]);
	});
});

function fakeRedis() {
	const hashes = new Map();
	const hash = key => { if (!hashes.has(key)) hashes.set(key, new Map()); return hashes.get(key); };
	return {
		hget: async (key, field) => hashes.get(key)?.get(field) ?? null,
		hgetall: async key => Object.fromEntries(hashes.get(key) || []),
		hset: async (key, field, value) => { hash(key).set(field, String(value)); return 1; },
		hincrby: async (key, field, delta) => {
			const value = Number(hash(key).get(field) || 0) + delta;
			hash(key).set(field, String(value));
			return value;
		},
		hdel: async (key, ...fields) => fields.reduce((n, field) => n + Number(hashes.get(key)?.delete(field) || false), 0),
		expire: async () => 1
	};
}

describe('room frames on a multi-worker adapter', () => {
	afterEach(() => vi.useRealTimers());

	for (const redis of [false, true]) {
		it('delivers rooms list created, updated and deleted deltas (' + (redis ? 'redis' : 'single replica') + ')', async () => {
			env = createTestEnv();
			if (redis) env.platform.redis = fakeRedis();
			enforceClusterPublishPolicy(env.platform);
			env.register('lobby', { room: live.room({ topic: (ctx, id) => 'seq-room:' + id, topicArgs: 1, init: async () => [], enumerable: true }) });
			const lobby = env.connect({ id: 'viewer' }).subscribe('lobby/room/__rooms');
			await settle();
			const alice = env.connect({ id: 'alice' });
			const bob = env.connect({ id: 'bob' });
			alice.subscribe('lobby/room/__data', 'a');
			await settle();
			expect(lobby.value).toEqual([expect.objectContaining({ topic: 'seq-room:a', count: 1 })]);
			bob.subscribe('lobby/room/__data', 'a');
			await settle();
			expect(lobby.value).toEqual([expect.objectContaining({ topic: 'seq-room:a', count: 2 })]);
			bob.disconnect();
			await settle();
			expect(lobby.value).toEqual([expect.objectContaining({ topic: 'seq-room:a', count: 1 })]);
			alice.disconnect();
			await settle();
			expect(lobby.value).toEqual([]);
		});
	}

	it('delivers the presence leave after the grace period', async () => {
		vi.useFakeTimers();
		env = createTestEnv();
		enforceClusterPublishPolicy(env.platform);
		env.register('chat', { room: live.room({ topic: (ctx, id) => 'seq-chat:' + id, topicArgs: 1, init: async () => [], presence: ctx => ({ name: ctx.user.id }) }) });
		const bob = env.connect({ id: 'bob' });
		const roster = bob.subscribe('chat/room/__presence', 'a');
		const alice = env.connect({ id: 'alice' });
		alice.subscribe('chat/room/__data', 'a');
		await vi.advanceTimersByTimeAsync(10);
		expect(roster.value.map(row => row.key)).toEqual(['alice']);
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(roster.value).toEqual([]);
	});

	it('delivers the presence leave of a departing member evicted at the presence cap', async () => {
		vi.useFakeTimers();
		const cap = state.maxPresenceRef;
		state.maxPresenceRef = 1;
		try {
			env = createTestEnv();
			enforceClusterPublishPolicy(env.platform);
			env.register('chat', { room: live.room({ topic: (ctx, id) => 'seq-cap:' + id, topicArgs: 1, init: async () => [], presence: ctx => ({ name: ctx.user.id }) }) });
			const bob = env.connect({ id: 'bob' });
			const roster = bob.subscribe('chat/room/__presence', 'a');
			const alice = env.connect({ id: 'alice' });
			alice.subscribe('chat/room/__data', 'a');
			await vi.advanceTimersByTimeAsync(10);
			expect(roster.value.map(row => row.key)).toEqual(['alice']);
			alice.disconnect();
			await vi.advanceTimersByTimeAsync(0);
			// A newcomer in another room needs the slot, so alice's grace ends early.
			env.connect({ id: 'carol' }).subscribe('chat/room/__data', 'b');
			await vi.advanceTimersByTimeAsync(10);
			expect(roster.value).toEqual([]);
		} finally {
			state.maxPresenceRef = cap;
			state.presenceRefWarnFired = false;
			await vi.advanceTimersByTimeAsync(10_000);
		}
	});
});
