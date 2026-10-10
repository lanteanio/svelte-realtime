import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, handleRpc, unsubscribe, close, configureForget, _resetForget } from '../src/server.js';
import { _presenceRef, state } from '../src/server/state.js';
import { _ownerGet } from '../src/server/room-owner.js';
import { createTestEnv } from '../src/testing.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

describe('room subscriptions release only acquired membership refs', () => {
	let env, room, originalCap, heldInit;
	const sockets = [];
	beforeEach(() => {
		vi.useFakeTimers();
		env = createTestEnv();
		originalCap = state.maxPresenceRef;
		room = live.room({
			topic: (ctx, id) => 'refs:' + id,
			init: async (ctx) => ctx.user.delayInit ? await heldInit : [],
			owner: true,
			presence: (ctx) => {
				if (ctx.user.failPresence) throw new Error('presence unavailable');
				return { name: ctx.user.id };
			}
		});
		env.register('refs', { room });
	});
	afterEach(async () => {
		for (const ws of sockets.splice(0)) close(ws, { platform: env.platform });
		await vi.advanceTimersByTimeAsync(5001);
		env.cleanup();
		state.maxPresenceRef = originalCap;
		state.presenceRefWarnFired = false;
		_resetForget();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function join(id, failPresence = false, roomId = 'one') {
		const ws = mockWs({ id, failPresence });
		sockets.push(ws);
		handleRpc(ws, toArrayBuffer({ rpc: 'refs/room/__data', id: 'join', args: [roomId], stream: true }), env.platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(ws.isSubscribed('refs:' + roomId)).toBe(true);
		return ws;
	}

	async function leave(ws, mode) {
		if (mode === 'close') close(ws, { platform: env.platform });
		else {
			ws.unsubscribe('refs:one');
			unsubscribe(ws, 'refs:one', { platform: env.platform });
		}
		await vi.advanceTimersByTimeAsync(5001);
	}

	it('releases every successful logical subscription held by one socket', async () => {
		const ws = await join('alice');
		handleRpc(ws, toArrayBuffer({ rpc: 'refs/room/__data', id: 'again', args: ['one'], stream: true }), env.platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(_presenceRef.get('refs:one\0alice').count).toBe(2);
		await leave(ws, 'close');
		expect(_presenceRef.has('refs:one\0alice')).toBe(false);
	});

	it('scrubs a forgotten socket ref in place and preserves a later membership when it closes', async () => {
		const oldSocket = await join('alice');
		const oldRef = _presenceRef.get('refs:one\0alice');
		expect(oldRef.data).toEqual({ name: 'alice' });
		configureForget({ platform: env.platform, store: { purgeUser: async () => 0 } });
		await live.forget('alice');
		expect(oldRef).toMatchObject({ data: null, count: 0, gone: true });
		expect(_presenceRef.has('refs:one\0alice')).toBe(false);
		const newSocket = await join('alice');
		const newRef = _presenceRef.get('refs:one\0alice');
		expect(newRef).not.toBe(oldRef);
		await leave(oldSocket, 'close');
		expect(_presenceRef.get('refs:one\0alice')).toBe(newRef);
		expect(newRef.count).toBe(1);
		expect(await _ownerGet(env.platform, 'refs:one')).toBe('alice');
		await leave(newSocket, 'close');
		expect(_presenceRef.has('refs:one\0alice')).toBe(false);
	});

	for (const mode of ['unsubscribe', 'close']) {
		it('a capacity-limited join cannot release another connection on ' + mode, async () => {
			state.maxPresenceRef = 1;
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const blocker = await join('blocker', false, 'full');
			const refused = await join('alice');
			expect(_presenceRef.has('refs:one\0alice')).toBe(false);
			close(blocker, { platform: env.platform });
			await vi.advanceTimersByTimeAsync(5001);
			expect(_presenceRef.size).toBe(0);
			const member = await join('alice');
			const ref = _presenceRef.get('refs:one\0alice');
			expect(ref.count).toBe(1);
			await leave(refused, mode);
			expect(_presenceRef.get('refs:one\0alice')).toBe(ref);
			expect(ref.count).toBe(1);
			expect(await _ownerGet(env.platform, 'refs:one')).toBe('alice');
			expect(member.isSubscribed('refs:one')).toBe(true);
			await leave(member, 'unsubscribe');
			expect(_presenceRef.has('refs:one\0alice')).toBe(false);
		});

		it('a throwing presence function cannot release another connection on ' + mode, async () => {
			const refused = await join('alice', true);
			expect(_presenceRef.has('refs:one\0alice')).toBe(false);
			const member = await join('alice');
			const ref = _presenceRef.get('refs:one\0alice');
			await leave(refused, mode);
			expect(_presenceRef.get('refs:one\0alice')).toBe(ref);
			expect(ref.count).toBe(1);
			expect(await _ownerGet(env.platform, 'refs:one')).toBe('alice');
			await leave(member, 'unsubscribe');
			expect(_presenceRef.has('refs:one\0alice')).toBe(false);
		});
	}

	it('rollback of an uncounted attempt preserves a later join on the same socket', async () => {
		state.maxPresenceRef = 1;
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const blocker = await join('blocker', false, 'full');
		let rejectInit;
		heldInit = new Promise((resolve, reject) => { rejectInit = reject; });
		const ws = mockWs({ id: 'alice', delayInit: true });
		sockets.push(ws);
		handleRpc(ws, toArrayBuffer({ rpc: 'refs/room/__data', id: 'refused', args: ['one'], stream: true }), env.platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(_presenceRef.has('refs:one\0alice')).toBe(false);
		close(blocker, { platform: env.platform });
		await vi.advanceTimersByTimeAsync(5001);
		ws.getUserData().delayInit = false;
		handleRpc(ws, toArrayBuffer({ rpc: 'refs/room/__data', id: 'accepted', args: ['one'], stream: true }), env.platform);
		await vi.advanceTimersByTimeAsync(0);
		const ref = _presenceRef.get('refs:one\0alice');
		expect(ref.count).toBe(1);
		rejectInit(new Error('initialization failed'));
		await vi.advanceTimersByTimeAsync(5001);
		expect(_presenceRef.get('refs:one\0alice')).toBe(ref);
		expect(ref.count).toBe(1);
		expect(await _ownerGet(env.platform, 'refs:one')).toBe('alice');
		await leave(ws, 'close');
		expect(_presenceRef.has('refs:one\0alice')).toBe(false);
	});
});
