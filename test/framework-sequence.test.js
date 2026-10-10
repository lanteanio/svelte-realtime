import { afterEach, describe, expect, it } from 'vitest';
import { live } from '../src/server.js';
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
