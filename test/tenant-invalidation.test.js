import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { live, _resetInvalidationWatch } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';
import { _topicInvalidationWatch } from '../src/server/state.js';

describe('stream invalidation tenant boundaries', () => {
	let env;
	beforeEach(() => {
		_resetInvalidationWatch();
		_setTenantResolver(user => user.org ?? null);
		env = createTestEnv();
	});
	afterEach(() => {
		env.cleanup();
		_resetInvalidationWatch();
		_resetTenantResolver();
	});

	for (const pattern of ['control', 'control*', '*', 'con*rol', 'control.[v1]', '@*', '@t*']) {
		it('matches logical ' + pattern + ' only in the publishing tenant', async () => {
			const topic = pattern === 'control.[v1]' ? pattern : pattern === 'control*' ? 'control:update' : pattern === '@*' ? '@control' : pattern === '@t*' ? '@thing' : 'control';
			const calls = new Map();
			env.register('feed', {
				read: live.stream('feed', async ctx => {
					const tenant = ctx.tenantId ?? 'unscoped';
					const count = (calls.get(tenant) || 0) + 1;
					calls.set(tenant, count);
					return { tenant, count };
				}, { merge: 'set', invalidateOn: pattern }),
				publish: live(ctx => ctx.publish(topic, 'changed', {})),
				publishOther: live((ctx, tenant) => ctx.tenant(tenant).publish(topic, 'changed', {}))
			});
			const peers = [null, 'a', 'aa'].map(org => env.connect({ id: 'reader', org }));
			const streams = peers.map(peer => peer.subscribe('feed/read'));
			await nextTurn();
			expect(streams.map(stream => stream.value?.count)).toEqual([1, 1, 1]);
			await peers[1].call('feed/publish');
			await nextTurn();
			expect(streams.map(stream => stream.value?.count)).toEqual([1, 2, 1]);
			await peers[0].call('feed/publish');
			await nextTurn();
			expect(streams.map(stream => stream.value?.count)).toEqual([2, 2, 1]);
			await peers[1].call('feed/publishOther', 'aa');
			await nextTurn();
			expect(streams.map(stream => stream.value?.count)).toEqual([2, 2, 2]);
			peers[1].disconnect();
			await nextTurn();
			await peers[0].call('feed/publishOther', 'a');
			await nextTurn();
			expect(calls.get('a')).toBe(2);
			peers[0].disconnect();
			peers[2].disconnect();
			await nextTurn();
			expect(_topicInvalidationWatch.size).toBe(0);
		});
	}
});
