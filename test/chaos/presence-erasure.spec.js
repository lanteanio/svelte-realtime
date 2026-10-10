import { test, expect } from '@playwright/test';
import { chaosRun, readContext } from './run-context.js';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { live, configureForget, _resetForget } from '../../src/server.js';
import { _presenceRef } from '../../src/server/state.js';
import { _resetOwnerForTests, _ownerGet } from '../../src/server/room-owner.js';

const require = createRequire(new URL('../fixture/package.json', import.meta.url));
const Redis = require('ioredis');
const { redisUrl } = readContext(chaosRun());

for (const fault of ['none', 'before', 'after', 'malformed']) {
	test(`strict erasure on real Redis Lua: ${fault} response failure`, async () => {
		const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
		const topic = 'erasure:' + randomUUID();
		const presenceKey = '__live-presence:' + topic;
		const ownerKey = '__live-room-owner:' + topic;
		const changes = [], published = [];
		const platform = { redis: Object.create(redis), publish: (...args) => published.push(args) };
		try {
			_resetForget(); _presenceRef.clear(); _resetOwnerForTests();
			const room = live.room({ topic: () => topic, init: async () => [], presence: ctx => ({ name: ctx.user.id }),
				owner: true, onOwnerChange: change => changes.push(change) });
			for (const id of ['alice', 'bob', 'carol']) {
				await room.__dataStream.__onSubscribe({ user: { id }, platform, publish() {}, _publishWire() {} }, topic, []);
			}
			// Other replicas hold the same identity. Erasure removes that identity
			// rather than repeating a one-replica decrement after an uncertain reply.
			await redis.hincrby(presenceKey, 'c:alice', 4);
			await redis.hincrby(ownerKey, 'n:alice', 4);
			configureForget({ platform });
			let attempted = false;
			platform.redis.eval = async (...args) => {
				if (!attempted && fault !== 'none') {
					attempted = true;
					if (fault === 'before') throw new Error('before send');
					await redis.eval(...args);
					if (fault === 'after') throw new Error('lost reply');
					return false;
				}
				return redis.eval(...args);
			};
			if (fault !== 'none') await expect(live.forget('alice')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
			await live.forget('alice');
			expect(await _ownerGet(platform, topic)).toBe('bob');
			const owner = await redis.hgetall(ownerKey);
			expect(owner['n:alice']).toBeUndefined(); expect(owner['j:alice']).toBeUndefined();
			expect(owner['n:bob']).toBe('1'); expect(owner['n:carol']).toBe('1');
			expect(await redis.hget(presenceKey, 'd:alice')).toBeNull();
			expect(_presenceRef.has(topic + '\0alice')).toBe(false);
			expect(changes.filter(change => change.reason === 'succeeded')).toHaveLength(fault === 'none' || fault === 'before' ? 1 : 0);
			expect(published.some(([wireTopic, event, data]) => wireTopic === topic + ':owner' && event === 'set' && data.key === 'bob')).toBe(true);
			await live.forget('bob'); expect(await _ownerGet(platform, topic)).toBe('carol');
			await live.forget('carol'); expect(await redis.hgetall(ownerKey)).toEqual({});
		} finally {
			await redis.del(presenceKey, ownerKey);
			await redis.quit();
			_resetForget(); _presenceRef.clear(); _resetOwnerForTests();
		}
	});
}
