import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, handleRpc, unsubscribe, close } from '../src/server.js';
import { _presenceRef, _pendingSubscribeHooks } from '../src/server/state.js';
import { _ownerGet } from '../src/server/room-owner.js';
import { createTestEnv } from '../src/testing.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}

function fakeRedis(beforeIncrement) {
	const hashes = new Map();
	const hash = key => { if (!hashes.has(key)) hashes.set(key, new Map()); return hashes.get(key); };
	return {
		hget: async (key, field) => hashes.get(key)?.get(field) ?? null,
		hgetall: async key => Object.fromEntries(hashes.get(key) || []),
		hset: async (key, field, value) => { hash(key).set(field, String(value)); return 1; },
		hincrby: async (key, field, delta) => {
			await beforeIncrement(key, field, delta);
			const value = Number(hash(key).get(field) || 0) + delta;
			hash(key).set(field, String(value));
			return value;
		},
		hdel: async (key, ...fields) => fields.reduce((n, field) => n + Number(hashes.get(key)?.delete(field) || false), 0),
		expire: async () => 1
	};
}

describe('room drains wait for pending subscribe hooks', () => {
	let env, gate, entered, block, room;
	const sockets = [];
	beforeEach(() => {
		vi.useFakeTimers();
		env = createTestEnv();
		gate = deferred();
		entered = deferred();
		block = () => false;
		env.platform.redis = fakeRedis(async (key, field, delta) => {
			if (block(key, field, delta)) { entered.resolve(); await gate.promise; }
		});
		room = live.room({
			topic: () => 'pending-room',
			init: async () => [],
			enumerable: true,
			owner: true,
			presence: ctx => ({ name: ctx.user.id })
		});
		env.register('pending', { room });
	});
	afterEach(async () => {
		gate.resolve();
		for (const ws of sockets.splice(0)) close(ws, { platform: env.platform });
		await vi.advanceTimersByTimeAsync(5001);
		env.cleanup();
		vi.useRealTimers();
	});
	function join(id) {
		const ws = mockWs({ id });
		sockets.push(ws);
		handleRpc(ws, toArrayBuffer({ rpc: 'pending/room/__data', id, args: [], stream: true }), env.platform);
		return ws;
	}
	function leave(ws, mode) {
		if (mode === 'close') close(ws, { platform: env.platform });
		else {
			ws.unsubscribe('pending-room');
			unsubscribe(ws, 'pending-room', { platform: env.platform });
		}
	}

	for (const mode of ['unsubscribe', 'close']) {
		for (const phase of ['enumeration', 'ownership']) {
			it(mode + ' drains a join awaiting ' + phase, async () => {
				block = (key, field, delta) => delta === 1 && (phase === 'enumeration'
					? key.startsWith('__live-rooms:') : key.startsWith('__live-room-owner:') && field === 'n:alice');
				const alice = join('alice');
				await entered.promise;
				leave(alice, mode);
				await vi.advanceTimersByTimeAsync(6000);
				gate.resolve();
				await vi.advanceTimersByTimeAsync(0);
				expect(_pendingSubscribeHooks.has(alice)).toBe(false);
				await vi.advanceTimersByTimeAsync(5001);
				expect(_presenceRef.has('pending-room\0alice')).toBe(false);
				expect(await _ownerGet(env.platform, 'pending-room')).toBeNull();
				expect(await env.platform.redis.hgetall('__live-presence:pending-room')).toEqual({});
				expect(await room.__roomsStream({ platform: env.platform, tenantId: null })).toEqual([]);
			});
		}
	}

	it('passes ownership to a remaining peer after the pending owner departs', async () => {
		block = (key, field, delta) => key.startsWith('__live-presence:') && field === 'c:alice' && delta === 1;
		const alice = join('alice');
		await entered.promise;
		join('bob');
		await vi.advanceTimersByTimeAsync(0);
		expect(await _ownerGet(env.platform, 'pending-room')).toBe('alice');
		leave(alice, 'close');
		await vi.advanceTimersByTimeAsync(6000);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(5001);
		expect(_presenceRef.has('pending-room\0alice')).toBe(false);
		expect(_presenceRef.get('pending-room\0bob').count).toBe(1);
		expect(await _ownerGet(env.platform, 'pending-room')).toBe('bob');
		expect((await room.__roomsStream({ platform: env.platform, tenantId: null }))[0].count).toBe(1);
	});

	it('keeps a later peer in the local room index while an earlier drain waits', async () => {
		delete env.platform.redis;
		const onSubscribe = room.__dataStream.__onSubscribe;
		room.__dataStream.__onSubscribe = async (...args) => {
			await onSubscribe(...args);
			if (args[0].user.id === 'alice') { entered.resolve(); await gate.promise; }
		};
		const alice = join('alice');
		await entered.promise;
		leave(alice, 'unsubscribe');
		join('bob');
		await vi.advanceTimersByTimeAsync(0);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(5001);
		expect(_presenceRef.has('pending-room\0alice')).toBe(false);
		expect((await room.__roomsStream({ platform: env.platform, tenantId: null }))[0].count).toBe(1);
		expect(await _ownerGet(env.platform, 'pending-room')).toBe('bob');
	});

	it('drains a rejected application subscribe hook and leaves another topic independent', async () => {
		const events = [];
		env.register('application', {
			slow: live.stream('slow', async () => [], {
				onSubscribe: async () => { entered.resolve(); await gate.promise; events.push('slow joined'); throw new Error('join failed'); },
				onUnsubscribe: () => events.push('slow left')
			}),
			fast: live.stream('fast', async () => [], { onUnsubscribe: () => events.push('fast left') })
		});
		const ws = mockWs({ id: 'alice' });
		sockets.push(ws);
		handleRpc(ws, toArrayBuffer({ rpc: 'application/slow', id: 'slow', args: [], stream: true }), env.platform);
		await entered.promise;
		handleRpc(ws, toArrayBuffer({ rpc: 'application/fast', id: 'fast', args: [], stream: true }), env.platform);
		await vi.advanceTimersByTimeAsync(0);
		close(ws, { platform: env.platform });
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(['fast left']);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(['fast left', 'slow joined', 'slow left']);
		expect(_pendingSubscribeHooks.has(ws)).toBe(false);
	});

	it('registers before a synchronous subscribe hook closes its own socket', async () => {
		const events = [];
		env.register('reentrant', { room: live.stream('reentrant', () => [], {
			onSubscribe(ctx) {
				expect(_pendingSubscribeHooks.has(ctx.ws)).toBe(true);
				close(ctx.ws, { platform: env.platform });
				events.push('joined');
			},
			onUnsubscribe() { events.push('left'); }
		}) });
		const ws = mockWs({ id: 'alice' });
		sockets.push(ws);
		handleRpc(ws, toArrayBuffer({ rpc: 'reentrant/room', id: 'join', stream: true }), env.platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(['joined', 'left']);
		expect(_pendingSubscribeHooks.has(ws)).toBe(false);
	});
});
