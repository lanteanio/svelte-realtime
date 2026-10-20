import { test, expect } from '@playwright/test';
import { chaosRun, readContext } from './run-context.js';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { live } from '../../src/server.js';
import { _presenceRef } from '../../src/server/state.js';

// Sticky presence fields (locks, selections) merged into a member's roster row
// on a real Redis, through the data-stream subscribe and the presence update
// RPC. The merge script runs here; the unit suite only has a stand-in for it.

const require = createRequire(new URL('../fixture/package.json', import.meta.url));
const Redis = require('ioredis');
const { redisUrl } = readContext(chaosRun());

async function joinedRoom(redis, presence) {
	const id = randomUUID();
	const topic = 'merge:' + id;
	const room = live.multiplayer({ topic: (ctx, roomId) => 'merge:' + roomId, init: async () => [], presence, locks: true, selections: true, typing: true, topicArgs: 1 });
	const frames = [];
	const ctx = { user: { id: 'alice' }, ws: {}, platform: { redis }, publish: (t, e, d) => { if (e === 'update') frames.push(d); }, _publishWire() {} };
	await room.__dataStream.__onSubscribe(ctx, topic, [id]);
	return { room, ctx, id, topic, frames, hKey: '__live-presence:' + topic };
}

test('a sticky merge leaves the presence payload bytes untouched on real Redis', async () => {
	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
	const payload = { name: 'A', tags: [], nested: { list: [] }, n: 0.1 + 0.2, big: 12345678901234567, url: 'a/b' };
	const { room, ctx, id, topic, hKey } = await joinedRoom(redis, () => payload);
	try {
		expect(await redis.hget(hKey, 'd:alice')).toBe(JSON.stringify(payload));
		await room.__presenceUpdate(ctx, id, { 'lock:title': true, selection: { anchor: 1, head: 2 } });
		expect(await redis.hget(hKey, 'd:alice')).toBe(JSON.stringify({ ...payload, 'lock:title': true, selection: { anchor: 1, head: 2 } }));
		await room.__presenceUpdate(ctx, id, { 'lock:title': null, selection: null });
		expect(await redis.hget(hKey, 'd:alice')).toBe(JSON.stringify(payload));
	} finally {
		await room.__dataStream.__onUnsubscribe(ctx, topic, 0);
		await redis.del(hKey);
		await redis.quit();
		_presenceRef.clear();
	}
});

test('sticky fields on a primitive payload are refused on real Redis and stay off the frame', async () => {
	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
	const { room, ctx, id, topic, frames, hKey } = await joinedRoom(redis, () => 'Alice');
	try {
		await room.__presenceUpdate(ctx, id, { 'lock:title': true, typing: true });
		expect(await redis.hget(hKey, 'd:alice')).toBe('"Alice"');
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ key: 'alice', typing: true });
		expect(frames[0]).not.toHaveProperty('lock:title');
	} finally {
		await room.__dataStream.__onUnsubscribe(ctx, topic, 0);
		await redis.del(hKey);
		await redis.quit();
		_presenceRef.clear();
	}
});

test('a value the entry cap refuses on real Redis stays off the frame while its release applies', async () => {
	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
	const { room, ctx, id, topic, frames, hKey } = await joinedRoom(redis, () => ({}));
	try {
		const fill = {};
		for (let i = 0; i < 16; i++) fill['lock:a' + i] = 'v'.repeat(1000);
		await room.__presenceUpdate(ctx, id, fill);
		await room.__presenceUpdate(ctx, id, { 'lock:a0': null, 'lock:x': 'w'.repeat(1000), 'lock:y': 'w'.repeat(1000) });
		const live_ = {};
		for (const frame of frames) {
			for (const [k, v] of Object.entries(frame)) {
				if (!k.startsWith('lock:')) continue;
				if (v === null) delete live_[k]; else live_[k] = v;
			}
		}
		const row = JSON.parse(await redis.hget(hKey, 'd:alice'));
		expect(row).toEqual(live_);
		expect(row).not.toHaveProperty('lock:a0');
		expect(row).not.toHaveProperty('lock:x');
	} finally {
		await room.__dataStream.__onUnsubscribe(ctx, topic, 0);
		await redis.del(hKey);
		await redis.quit();
		_presenceRef.clear();
	}
});

test('two replicas merging the same member on real Redis keep both fields', async () => {
	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
	const other = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
	const { room, ctx, id, topic, hKey } = await joinedRoom(redis, () => ({ name: 'A' }));
	try {
		await room.__presenceUpdate(ctx, id, { 'lock:a': true });
		// The other replica's write lands between this replica's merges.
		const row = JSON.parse(await other.hget(hKey, 'd:alice'));
		await other.hset(hKey, 'd:alice', JSON.stringify({ ...row, 'lock:b': true }));
		await room.__presenceUpdate(ctx, id, { 'lock:c': true });
		expect(JSON.parse(await redis.hget(hKey, 'd:alice'))).toEqual({ name: 'A', 'lock:a': true, 'lock:b': true, 'lock:c': true });
	} finally {
		await room.__dataStream.__onUnsubscribe(ctx, topic, 0);
		await redis.del(hKey);
		await redis.quit();
		await other.quit();
		_presenceRef.clear();
	}
});


test('cached unchanged deltas follow remote writes and refresh the roster lifetime on real Redis', async () => {
	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
	const other = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
	const { room, ctx, id, topic, hKey, frames } = await joinedRoom(redis, () => ({ name: 'A' }));
	try {
		await room.__presenceUpdate(ctx, id, { 'lock:a': true });
		await other.hset(hKey, 'd:alice', JSON.stringify({ name: 'A', 'lock:a': false, 'lock:b': true }));
		await room.__presenceUpdate(ctx, id, { 'lock:b': null });
		expect(JSON.parse(await redis.hget(hKey, 'd:alice'))).toEqual({ name: 'A', 'lock:a': false });
		await room.__presenceUpdate(ctx, id, { 'lock:a': true });
		expect(JSON.parse(await redis.hget(hKey, 'd:alice'))).toEqual({ name: 'A', 'lock:a': true });
		await redis.expire(hKey, 60);
		await room.__presenceUpdate(ctx, id, { 'lock:a': true });
		expect(await redis.ttl(hKey)).toBeGreaterThan(3500);
		const fill = {};
		for (let i = 0; i < 16; i++) fill['lock:f' + i] = 'v'.repeat(1000);
		await room.__presenceUpdate(ctx, id, fill);
		const row = JSON.parse(await other.hget(hKey, 'd:alice'));
		delete row['lock:f0'];
		await other.hset(hKey, 'd:alice', JSON.stringify(row));
		const delta = { 'lock:new': 'w'.repeat(1000) };
		await room.__presenceUpdate(ctx, id, delta);
		expect(frames.at(-1)).toMatchObject(delta);
		expect(JSON.parse(await redis.hget(hKey, 'd:alice'))).toEqual({ ...row, ...delta });
		expect(_presenceRef.get(topic + '\0alice').data).toEqual({ ...row, ...delta });
	} finally {
		await room.__dataStream.__onUnsubscribe(ctx, topic, 0);
		await redis.del(hKey);
		await redis.quit();
		await other.quit();
		_presenceRef.clear();
	}
});
