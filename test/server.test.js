import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	live,
	guard,
	LiveError,
	handleRpc,
	message,
	createMessage,
	__register,
	__registerGuard,
	__registerEffect,
	__registerAggregate,
	__directCall,
	_activateDerived,
	_clearCron,
	onCronError,
	close,
	enableSignals,
	pipe
} from '../server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

// -- live() -------------------------------------------------------------------

describe('live()', () => {
	it('returns the original function with __isLive = true', () => {
		const fn = (ctx) => 'hello';
		const result = live(fn);
		expect(result).toBe(fn);
		expect(result.__isLive).toBe(true);
	});
});

// -- live.stream() ------------------------------------------------------------

describe('live.stream()', () => {
	it('attaches stream metadata', () => {
		const initFn = async (ctx) => [];
		const result = live.stream('messages', initFn, { merge: 'crud', key: 'id', prepend: true });
		expect(result).toBe(initFn);
		expect(result.__isStream).toBe(true);
		expect(result.__isLive).toBe(true);
		expect(result.__streamTopic).toBe('messages');
		expect(result.__streamOptions).toEqual({ merge: 'crud', key: 'id', prepend: true });
	});

	it('uses default options when none provided', () => {
		const initFn = async (ctx) => [];
		const result = live.stream('items', initFn);
		expect(result.__streamOptions).toEqual({ merge: 'crud', key: 'id' });
	});
});

// -- guard() ------------------------------------------------------------------

describe('guard()', () => {
	it('returns the function with __isGuard = true (single arg)', () => {
		const fn = (ctx) => {};
		const result = guard(fn);
		expect(result).toBe(fn);
		expect(result.__isGuard).toBe(true);
	});

	it('accepts multiple middleware functions (variadic)', async () => {
		const order = [];
		const g = guard(
			(ctx) => { order.push('a'); },
			(ctx) => { order.push('b'); },
			(ctx) => { order.push('c'); }
		);
		expect(g.__isGuard).toBe(true);
		await g({});
		expect(order).toEqual(['a', 'b', 'c']);
	});

	it('stops chain when a middleware throws', async () => {
		const order = [];
		const g = guard(
			(ctx) => { order.push('first'); },
			() => { throw new LiveError('FORBIDDEN', 'Nope'); },
			(ctx) => { order.push('should not run'); }
		);
		await expect(g({})).rejects.toThrow('Nope');
		expect(order).toEqual(['first']);
	});

	it('earlier middleware can enrich ctx for later ones', async () => {
		let captured;
		const g = guard(
			(ctx) => { ctx.permissions = ['read', 'write']; },
			(ctx) => { captured = ctx.permissions; }
		);
		await g({});
		expect(captured).toEqual(['read', 'write']);
	});

	it('guard factories (functions returning functions) work', async () => {
		const requireRole = (role) => (ctx) => {
			if (ctx.user?.role !== role) throw new LiveError('FORBIDDEN', `${role} required`);
		};
		const g = guard(
			(ctx) => { if (!ctx.user) throw new LiveError('UNAUTHORIZED'); },
			requireRole('admin')
		);
		await expect(g({ user: { role: 'admin' } })).resolves.toBeUndefined();
		await expect(g({ user: { role: 'viewer' } })).rejects.toThrow('admin required');
	});
});

// -- LiveError ----------------------------------------------------------------

describe('LiveError', () => {
	it('propagates code and message', () => {
		const err = new LiveError('UNAUTHORIZED', 'Login required');
		expect(err.code).toBe('UNAUTHORIZED');
		expect(err.message).toBe('Login required');
		expect(err).toBeInstanceOf(Error);
	});

	it('uses code as message when no message given', () => {
		const err = new LiveError('NOT_FOUND');
		expect(err.message).toBe('NOT_FOUND');
	});
});

// -- handleRpc() --------------------------------------------------------------

describe('handleRpc()', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1', name: 'Alice' });
		platform = mockPlatform();
	});

	it('returns false for non-RPC messages (plain string data)', () => {
		const data = toArrayBuffer({ type: 'subscribe', topic: 'test' });
		expect(handleRpc(ws, data, platform)).toBe(false);
	});

	it('returns false for binary data', () => {
		const buf = new Uint8Array([0x00, 0x01, 0x02]).buffer;
		expect(handleRpc(ws, buf, platform)).toBe(false);
	});

	it('returns false for non-ArrayBuffer', () => {
		expect(handleRpc(ws, 'hello', platform)).toBe(false);
	});

	it('returns false for too-small messages', () => {
		const data = toArrayBuffer({});
		expect(handleRpc(ws, data, platform)).toBe(false);
	});

	it('returns true and responds for valid RPC calls', async () => {
		const handler = live(async (ctx, text) => ({ id: 1, text }));
		__register('chat/send', handler);

		const data = toArrayBuffer({ rpc: 'chat/send', id: 'a1', args: ['hello'] });
		const result = handleRpc(ws, data, platform);

		expect(result).toBe(true);

		// Wait for async execution
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent).toHaveLength(1);
		expect(platform.sent[0].topic).toBe('__rpc');
		expect(platform.sent[0].event).toBe('a1');
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual({ id: 1, text: 'hello' });
	});

	it('returns NOT_FOUND for unknown paths', async () => {
		const data = toArrayBuffer({ rpc: 'unknown/fn', id: 'b1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('NOT_FOUND');
	});

	it('returns INVALID_REQUEST for non-array args', async () => {
		const handler = live(async (ctx) => 'ok');
		__register('test/valid', handler);

		const data = toArrayBuffer({ rpc: 'test/valid', id: 'c1', args: 'not-array' });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
	});

	it('runs guard before handler', async () => {
		const order = [];
		const guardFn = guard((ctx) => { order.push('guard'); });
		const handler = live(async (ctx) => { order.push('handler'); return 'ok'; });

		__registerGuard('guarded', guardFn);
		__register('guarded/action', handler);

		const data = toArrayBuffer({ rpc: 'guarded/action', id: 'd1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(order).toEqual(['guard', 'handler']);
		expect(platform.sent[0].data.ok).toBe(true);
	});

	it('guard rejection prevents handler execution', async () => {
		const guardFn = guard(() => { throw new LiveError('FORBIDDEN', 'Nope'); });
		const handler = live(async (ctx) => 'should not run');

		__registerGuard('blocked', guardFn);
		__register('blocked/action', handler);

		const data = toArrayBuffer({ rpc: 'blocked/action', id: 'e1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
	});

	it('returns INTERNAL_ERROR for unexpected throws (no leak)', async () => {
		const handler = live(async () => { throw new Error('secret db error'); });
		__register('err/leak', handler);

		const data = toArrayBuffer({ rpc: 'err/leak', id: 'f1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INTERNAL_ERROR');
		expect(platform.sent[0].data.error).toBe('Internal server error');
		// Must NOT contain the actual error message
		expect(JSON.stringify(platform.sent[0].data)).not.toContain('secret db error');
	});

	it('LiveError propagates code and message to client', async () => {
		const handler = live(async () => { throw new LiveError('VALIDATION', 'Bad input'); });
		__register('err/live', handler);

		const data = toArrayBuffer({ rpc: 'err/live', id: 'g1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('VALIDATION');
		expect(platform.sent[0].data.error).toBe('Bad input');
	});

	it('ctx.publish delegates to the passed-in platform', async () => {
		const handler = live(async (ctx, topic) => {
			ctx.publish(topic, 'created', { id: 1 });
			return 'ok';
		});
		__register('pub/test', handler);

		const data = toArrayBuffer({ rpc: 'pub/test', id: 'h1', args: ['items'] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.published).toHaveLength(1);
		expect(platform.published[0]).toEqual({
			topic: 'items',
			event: 'created',
			data: { id: 1 },
			options: undefined
		});
	});

	it('wrapped platform: ctx.publish calls the wrapper', async () => {
		const wrappedPlatform = mockPlatform();
		const handler = live(async (ctx) => {
			ctx.publish('t', 'e', 'd');
			return 'ok';
		});
		__register('wrap/test', handler);

		const data = toArrayBuffer({ rpc: 'wrap/test', id: 'i1', args: [] });
		handleRpc(ws, data, wrappedPlatform);

		await new Promise((r) => setTimeout(r, 10));

		// Published through the wrapped platform, not the original
		expect(wrappedPlatform.published).toHaveLength(1);
		expect(platform.published).toHaveLength(0);
	});

	it('beforeExecute hook runs and can reject', async () => {
		const handler = live(async () => 'should not run');
		__register('rate/test', handler);

		const data = toArrayBuffer({ rpc: 'rate/test', id: 'j1', args: [] });
		handleRpc(ws, data, platform, {
			async beforeExecute(ws, rpcPath, args) {
				throw new LiveError('RATE_LIMITED', 'Slow down');
			}
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('RATE_LIMITED');
	});

	it('beforeExecute not provided: no overhead', async () => {
		const handler = live(async () => 'fast');
		__register('fast/test', handler);

		const data = toArrayBuffer({ rpc: 'fast/test', id: 'k1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toBe('fast');
	});

	it('ctx.user returns ws.getUserData()', async () => {
		let capturedUser;
		const handler = live(async (ctx) => { capturedUser = ctx.user; return 'ok'; });
		__register('user/test', handler);

		const data = toArrayBuffer({ rpc: 'user/test', id: 'l1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(capturedUser).toEqual({ id: 'user1', name: 'Alice' });
	});

	it('handles args with no args field (defaults to empty array)', async () => {
		let capturedArgs;
		const handler = live(async (ctx, ...args) => { capturedArgs = args; return 'ok'; });
		__register('noargs/test', handler);

		const data = toArrayBuffer({ rpc: 'noargs/test', id: 'm1' });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(capturedArgs).toEqual([]);
	});
});

// -- Stream RPC ---------------------------------------------------------------

describe('handleRpc() stream', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('subscribes to topic BEFORE calling initFn', async () => {
		const order = [];
		const initFn = async (ctx) => {
			order.push('init');
			return [{ id: 1 }];
		};
		const stream = live.stream('orders', initFn, { merge: 'crud', key: 'id' });
		__register('stream/orders', stream);

		// Intercept subscribe to track order
		const origSub = ws.subscribe;
		ws.subscribe = (topic) => { order.push('subscribe:' + topic); return origSub(topic); };

		const data = toArrayBuffer({ rpc: 'stream/orders', id: 's1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(order).toEqual(['subscribe:orders', 'init']);
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.topic).toBe('orders');
		expect(platform.sent[0].data.merge).toBe('crud');
		expect(platform.sent[0].data.data).toEqual([{ id: 1 }]);
	});
});

// -- Dynamic topics -----------------------------------------------------------

describe('handleRpc() dynamic topic', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('evaluates dynamic topic function with ctx and args', async () => {
		const initFn = async (ctx, roomId) => [{ id: 1, room: roomId }];
		const stream = live.stream(
			(ctx, roomId) => 'chat:' + roomId,
			initFn,
			{ merge: 'crud', key: 'id' }
		);
		__register('rooms/messages', stream);

		const data = toArrayBuffer({ rpc: 'rooms/messages', id: 'dt1', args: ['room-42'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(ws.isSubscribed('chat:room-42')).toBe(true);
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.topic).toBe('chat:room-42');
		expect(platform.sent[0].data.data).toEqual([{ id: 1, room: 'room-42' }]);
	});

	it('static string topic still works unchanged', async () => {
		const initFn = async (ctx) => [{ id: 1 }];
		const stream = live.stream('static-topic', initFn, { merge: 'crud', key: 'id' });
		__register('static/items', stream);

		const data = toArrayBuffer({ rpc: 'static/items', id: 'dt2', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(ws.isSubscribed('static-topic')).toBe(true);
		expect(platform.sent[0].data.topic).toBe('static-topic');
	});
});

// -- message hook -------------------------------------------------------------

describe('message', () => {
	it('matches adapter message hook signature', () => {
		expect(typeof message).toBe('function');
		expect(message.length).toBe(2);
	});

	it('routes RPC messages to handleRpc', async () => {
		const handler = live(async () => 'via-message');
		__register('msg/test', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'msg/test', id: 'n1', args: [] });

		message(ws, { data, platform });

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.data).toBe('via-message');
	});

	it('does not throw for non-RPC messages', () => {
		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ type: 'custom', payload: 123 });

		expect(() => message(ws, { data, platform })).not.toThrow();
		expect(platform.sent).toHaveLength(0);
	});
});

// -- createMessage() ----------------------------------------------------------

describe('createMessage()', () => {
	it('no args: behaves like message', async () => {
		const hook = createMessage();
		expect(hook).toBe(message);
	});

	it('platform option: transforms platform', async () => {
		const transformed = mockPlatform();
		const hook = createMessage({
			platform: () => transformed
		});

		const handler = live(async (ctx) => {
			ctx.publish('t', 'e', 'd');
			return 'ok';
		});
		__register('cm/platform', handler);

		const ws = mockWs();
		const original = mockPlatform();
		const data = toArrayBuffer({ rpc: 'cm/platform', id: 'o1', args: [] });

		hook(ws, { data, platform: original });

		await new Promise((r) => setTimeout(r, 10));

		// Publish went through transformed platform
		expect(transformed.published).toHaveLength(1);
		// Response sent via transformed platform
		expect(transformed.sent).toHaveLength(1);
	});

	it('beforeExecute option: passed through', async () => {
		let hookCalled = false;
		const hook = createMessage({
			async beforeExecute(ws, path, args) {
				hookCalled = true;
			}
		});

		const handler = live(async () => 'ok');
		__register('cm/before', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'cm/before', id: 'p1', args: [] });

		hook(ws, { data, platform });

		await new Promise((r) => setTimeout(r, 10));

		expect(hookCalled).toBe(true);
	});

	it('onUnhandled option: called for non-RPC messages', () => {
		let unhandledData;
		const hook = createMessage({
			onUnhandled(ws, data, platform) {
				unhandledData = data;
			}
		});

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ custom: true });

		hook(ws, { data, platform });

		expect(unhandledData).toBe(data);
	});

	it('onUnhandled not called for RPC messages', async () => {
		let unhandledCalled = false;
		const hook = createMessage({
			onUnhandled() { unhandledCalled = true; }
		});

		const handler = live(async () => 'ok');
		__register('cm/norpc', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'cm/norpc', id: 'q1', args: [] });

		hook(ws, { data, platform });

		await new Promise((r) => setTimeout(r, 10));

		expect(unhandledCalled).toBe(false);
	});

	it('combined options: platform + beforeExecute', async () => {
		const transformed = mockPlatform();
		let beforePath;

		const hook = createMessage({
			platform: () => transformed,
			async beforeExecute(ws, path) {
				beforePath = path;
			}
		});

		const handler = live(async () => 'combined');
		__register('cm/combo', handler);

		const ws = mockWs();
		const original = mockPlatform();
		const data = toArrayBuffer({ rpc: 'cm/combo', id: 'r1', args: [] });

		hook(ws, { data, platform: original });

		await new Promise((r) => setTimeout(r, 10));

		expect(beforePath).toBe('cm/combo');
		expect(transformed.sent[0].data.data).toBe('combined');
	});
});

// -- Batch RPC ----------------------------------------------------------------

describe('handleRpc() batch', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('processes batch of 3 RPCs and sends single response', async () => {
		const fn1 = live(async (ctx, x) => x * 2);
		const fn2 = live(async (ctx, x) => x + 10);
		const fn3 = live(async (ctx) => 'hello');
		__register('batch/double', fn1);
		__register('batch/add', fn2);
		__register('batch/greet', fn3);

		const data = toArrayBuffer({
			batch: [
				{ rpc: 'batch/double', id: 'b1', args: [5] },
				{ rpc: 'batch/add', id: 'b2', args: [3] },
				{ rpc: 'batch/greet', id: 'b3', args: [] }
			]
		});
		const result = handleRpc(ws, data, platform);
		expect(result).toBe(true);

		await new Promise((r) => setTimeout(r, 20));

		expect(platform.sent).toHaveLength(1);
		const response = platform.sent[0];
		expect(response.event).toBe('__batch');
		expect(response.data.batch).toHaveLength(3);
		expect(response.data.batch[0]).toEqual({ id: 'b1', ok: true, data: 10 });
		expect(response.data.batch[1]).toEqual({ id: 'b2', ok: true, data: 13 });
		expect(response.data.batch[2]).toEqual({ id: 'b3', ok: true, data: 'hello' });
	});

	it('handles partial failure in batch', async () => {
		const fn1 = live(async (ctx) => 'ok');
		const fn2 = live(async (ctx) => { throw new LiveError('FAIL', 'oops'); });
		__register('bpf/ok', fn1);
		__register('bpf/fail', fn2);

		const data = toArrayBuffer({
			batch: [
				{ rpc: 'bpf/ok', id: 'c1', args: [] },
				{ rpc: 'bpf/fail', id: 'c2', args: [] }
			]
		});
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		const batch = platform.sent[0].data.batch;
		expect(batch[0].ok).toBe(true);
		expect(batch[0].data).toBe('ok');
		expect(batch[1].ok).toBe(false);
		expect(batch[1].code).toBe('FAIL');
	});

	it('sequential mode runs in order', async () => {
		const order = [];
		const fn1 = live(async (ctx) => { order.push('first'); return 1; });
		const fn2 = live(async (ctx) => { order.push('second'); return 2; });
		__register('seq/a', fn1);
		__register('seq/b', fn2);

		const data = toArrayBuffer({
			batch: [
				{ rpc: 'seq/a', id: 'd1', args: [] },
				{ rpc: 'seq/b', id: 'd2', args: [] }
			],
			sequential: true
		});
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		expect(order).toEqual(['first', 'second']);
		const batch = platform.sent[0].data.batch;
		expect(batch[0].data).toBe(1);
		expect(batch[1].data).toBe(2);
	});
});

// -- Batch validation ---------------------------------------------------------

describe('handleRpc() batch validation', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('rejects batches exceeding 50 calls', async () => {
		const calls = [];
		for (let i = 0; i < 51; i++) {
			calls.push({ rpc: 'x/y', id: `id${i}`, args: [] });
		}
		const data = toArrayBuffer({ batch: calls });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		expect(platform.sent).toHaveLength(1);
		expect(platform.sent[0].data.batch[0].ok).toBe(false);
		expect(platform.sent[0].data.batch[0].code).toBe('INVALID_REQUEST');
		expect(platform.sent[0].data.batch[0].error).toContain('50');
	});

	it('rejects malformed batch entries (missing rpc)', async () => {
		const data = toArrayBuffer({
			batch: [
				{ id: 'e1', args: [] },
				{ rpc: 'batch/greet', id: 'e2', args: [] }
			]
		});
		const fn = live(async (ctx) => 'hello');
		__register('batch/greet', fn);
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		const batch = platform.sent[0].data.batch;
		expect(batch[0].ok).toBe(false);
		expect(batch[0].code).toBe('INVALID_REQUEST');
		expect(batch[1].ok).toBe(true);
		expect(batch[1].data).toBe('hello');
	});

	it('rejects malformed batch entries (missing id)', async () => {
		const data = toArrayBuffer({
			batch: [
				{ rpc: 'batch/greet', args: [] }
			]
		});
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		const batch = platform.sent[0].data.batch;
		expect(batch[0].ok).toBe(false);
		expect(batch[0].code).toBe('INVALID_REQUEST');
	});

	it('handles null entries in batch', async () => {
		const data = toArrayBuffer({
			batch: [null, { rpc: 'batch/greet', id: 'f1', args: [] }]
		});
		const fn = live(async (ctx) => 'ok');
		__register('batch/greet', fn);
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		const batch = platform.sent[0].data.batch;
		expect(batch[0].ok).toBe(false);
		expect(batch[1].ok).toBe(true);
	});

	it('batch validation works in sequential mode', async () => {
		const data = toArrayBuffer({
			batch: [
				{ id: 'g1', args: [] },
				{ rpc: 'batch/greet', id: 'g2', args: [] }
			],
			sequential: true
		});
		const fn = live(async (ctx) => 'ok');
		__register('batch/greet', fn);
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		const batch = platform.sent[0].data.batch;
		expect(batch[0].ok).toBe(false);
		expect(batch[0].code).toBe('INVALID_REQUEST');
		expect(batch[1].ok).toBe(true);
	});
});

// -- Batch dev-mode warnings --------------------------------------------------

describe('handleRpc() batch dev warnings', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('logs dev warning for non-LiveError throws in batch', async () => {
		const handler = live(async () => { throw new Error('secret'); });
		__register('bwarn/fail', handler);

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		const data = toArrayBuffer({
			batch: [{ rpc: 'bwarn/fail', id: 'w1', args: [] }]
		});
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 20));

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('non-LiveError'),
			expect.anything(),
			expect.any(String)
		);

		const batch = platform.sent[0].data.batch;
		expect(batch[0].ok).toBe(false);
		expect(batch[0].code).toBe('INTERNAL_ERROR');
		// Must NOT leak the actual error
		expect(batch[0].error).toBe('Internal server error');

		warn.mockRestore();
		error.mockRestore();
	});
});

// -- Payload size warning -----------------------------------------------------

describe('payload size warning', () => {
	it('warns when RPC response payload exceeds 12KB', async () => {
		const ws = mockWs();
		const platform = mockPlatform();

		// Generate a large response (> 12KB)
		const bigData = 'x'.repeat(13000);
		const handler = live(async () => bigData);
		__register('big/test', handler);

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const data = toArrayBuffer({ rpc: 'big/test', id: 'sz1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('maxPayloadLength')
		);
		warn.mockRestore();
	});
});

// -- platform.send() return value ---------------------------------------------

describe('platform.send() return value', () => {
	it('warns when send returns 0 (dev mode)', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform.send = () => 0; // Simulate backpressure/closed

		const handler = live(async () => 'ok');
		__register('bp/test', handler);

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const data = toArrayBuffer({ rpc: 'bp/test', id: 'z1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('not delivered')
		);
		warn.mockRestore();
	});
});

// -- live.validated() (Phase 12) ----------------------------------------------

describe('live.validated()', () => {
	it('passes through when schema validates successfully (Zod-like)', async () => {
		const schema = {
			safeParse(input) {
				if (input && typeof input.text === 'string') {
					return { success: true, data: input };
				}
				return {
					success: false,
					error: { issues: [{ path: ['text'], message: 'Required' }] }
				};
			}
		};

		const handler = live.validated(schema, async (ctx, input) => {
			return { received: input.text };
		});
		__register('val/send', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'val/send', id: 'v1', args: [{ text: 'hello' }] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(true);
		expect(response.data.data).toEqual({ received: 'hello' });
	});

	it('rejects with VALIDATION code and issues on failure', async () => {
		const schema = {
			safeParse(input) {
				return {
					success: false,
					error: { issues: [{ path: ['name'], message: 'Too short' }] }
				};
			}
		};

		const handler = live.validated(schema, async (ctx, input) => input);
		__register('val/fail', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'val/fail', id: 'v2', args: [{ name: '' }] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(false);
		expect(response.data.code).toBe('VALIDATION');
		expect(response.data.issues).toEqual([{ path: ['name'], message: 'Too short' }]);
	});

	it('marks the wrapper function with __isLive and __isValidated', () => {
		const schema = { safeParse: () => ({ success: true, data: {} }) };
		const handler = live.validated(schema, async () => {});
		expect(handler.__isLive).toBe(true);
		expect(handler.__isValidated).toBe(true);
		expect(handler.__schema).toBe(schema);
	});
});

// -- __directCall() (Phase 11) ------------------------------------------------

describe('__directCall()', () => {
	it('calls a registered live function directly without WebSocket', async () => {
		const handler = live(async (ctx, name) => ({ greeting: `Hello ${name}` }));
		__register('greet/hello', handler);

		const platform = mockPlatform();
		const result = await __directCall('greet/hello', ['World'], platform);
		expect(result).toEqual({ greeting: 'Hello World' });
	});

	it('throws NOT_FOUND for unregistered paths', async () => {
		const platform = mockPlatform();
		await expect(__directCall('missing/fn', [], platform)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
	});

	it('runs the module guard before calling the function', async () => {
		const order = [];
		const guardFn = (ctx) => { order.push('guard'); };
		guardFn.__isGuard = true;
		__registerGuard('guarded', guardFn);

		const handler = live(async (ctx) => { order.push('handler'); return 'ok'; });
		__register('guarded/action', handler);

		const platform = mockPlatform();
		await __directCall('guarded/action', [], platform);
		expect(order).toEqual(['guard', 'handler']);
	});

	it('passes user data from options into ctx', async () => {
		let receivedUser;
		const handler = live(async (ctx) => { receivedUser = ctx.user; return 'ok'; });
		__register('dc/user', handler);

		const platform = mockPlatform();
		await __directCall('dc/user', [], platform, { user: { id: 42, name: 'Alice' } });
		expect(receivedUser).toEqual({ id: 42, name: 'Alice' });
	});

	it('calls stream initFn and returns data without subscribing', async () => {
		const streamFn = live.stream('dc-items', async (ctx) => [{ id: 1, name: 'Item' }]);
		__register('dc/items', streamFn);

		const platform = mockPlatform();
		const result = await __directCall('dc/items', [], platform);
		expect(result).toEqual([{ id: 1, name: 'Item' }]);
	});
});

// -- live.cron() (Phase 14) ---------------------------------------------------

describe('live.cron()', () => {
	it('marks function with cron metadata', () => {
		const fn = live.cron('*/5 * * * *', 'stats', async () => ({ count: 42 }));
		expect(fn.__isCron).toBe(true);
		expect(fn.__cronSchedule).toBe('*/5 * * * *');
		expect(fn.__cronTopic).toBe('stats');
		expect(fn.__cronParsed).toHaveLength(5);
	});

	it('parses wildcard fields as null', () => {
		const fn = live.cron('* * * * *', 'all', async () => {});
		expect(fn.__cronParsed).toEqual([null, null, null, null, null]);
	});

	it('parses step fields', () => {
		const fn = live.cron('*/10 */2 * * *', 'steps', async () => {});
		expect(fn.__cronParsed[0]).toEqual({ step: 10 });
		expect(fn.__cronParsed[1]).toEqual({ step: 2 });
	});

	it('parses range fields', () => {
		const fn = live.cron('0 9-17 * * *', 'range', async () => {});
		expect(fn.__cronParsed[1]).toBeInstanceOf(Set);
		expect(fn.__cronParsed[1].has(9)).toBe(true);
		expect(fn.__cronParsed[1].has(17)).toBe(true);
		expect(fn.__cronParsed[1].has(18)).toBe(false);
	});

	it('parses list fields', () => {
		const fn = live.cron('0,15,30,45 * * * *', 'list', async () => {});
		expect(fn.__cronParsed[0]).toBeInstanceOf(Set);
		expect(fn.__cronParsed[0].has(0)).toBe(true);
		expect(fn.__cronParsed[0].has(15)).toBe(true);
		expect(fn.__cronParsed[0].has(30)).toBe(true);
		expect(fn.__cronParsed[0].has(45)).toBe(true);
	});

	it('throws on invalid cron expression', () => {
		expect(() => live.cron('* *', 'bad', async () => {})).toThrow('expected 5 fields');
	});
});

// -- Replay / seq handling (Phase 15) -----------------------------------------

describe('replay stream response', () => {
	it('includes seq in response when replay is enabled and platform supports it', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform.replay = {
			seq: async (topic) => 42,
			since: async (topic, seq) => null
		};

		const streamFn = live.stream('replay-items', async (ctx) => [{ id: 1 }], { merge: 'crud', key: 'id', replay: true });
		__register('rp/items', streamFn);

		const data = toArrayBuffer({ rpc: 'rp/items', id: 'rp1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(true);
		expect(response.data.seq).toBe(42);
	});

	it('sends replay events when client provides seq and replay is available', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		const missedEvents = [
			{ event: 'created', data: { id: 2, name: 'New' } }
		];
		platform.replay = {
			seq: async () => 5,
			since: async (topic, seq) => seq < 5 ? missedEvents : null
		};

		const streamFn = live.stream('replay-events', async (ctx) => [{ id: 1 }], { merge: 'crud', key: 'id', replay: true });
		__register('rp/events', streamFn);

		const data = toArrayBuffer({ rpc: 'rp/events', id: 'rp2', args: [], stream: true, seq: 3 });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(true);
		expect(response.data.replay).toBe(true);
		expect(response.data.data).toBe(missedEvents);
		expect(response.data.seq).toBe(5);
	});
});

// -- Issues propagation -------------------------------------------------------

describe('issues propagation', () => {
	it('propagates issues array from LiveError to client response', async () => {
		const handler = live(async (ctx) => {
			const err = new LiveError('VALIDATION', 'Invalid input');
			err.issues = [{ path: ['email'], message: 'Invalid email' }];
			throw err;
		});
		__register('issues/test', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'issues/test', id: 'is1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(false);
		expect(response.data.issues).toEqual([{ path: ['email'], message: 'Invalid email' }]);
	});
});

// -- Phase 16: _clearCron() ---------------------------------------------------

describe('_clearCron()', () => {
	it('is a callable function', () => {
		expect(typeof _clearCron).toBe('function');
		_clearCron(); // should not throw
	});
});

// -- Phase 16: onCronError() --------------------------------------------------

describe('onCronError()', () => {
	it('is a callable function', () => {
		expect(typeof onCronError).toBe('function');
		onCronError(() => {}); // should not throw
	});
});

// -- Phase 18: onError hook ---------------------------------------------------

describe('handleRpc() onError', () => {
	it('calls onError when a non-LiveError is thrown', async () => {
		const handler = live(async () => { throw new Error('db crash'); });
		__register('onerr/test', handler);

		let errorPath, errorObj;
		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'onerr/test', id: 'oe1', args: [] });

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		handleRpc(ws, data, platform, {
			onError(path, err, ctx) {
				errorPath = path;
				errorObj = err;
			}
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(errorPath).toBe('onerr/test');
		expect(errorObj).toBeInstanceOf(Error);
		expect(errorObj.message).toBe('db crash');

		warn.mockRestore();
		error.mockRestore();
	});

	it('does not call onError for LiveError (expected errors)', async () => {
		const handler = live(async () => { throw new LiveError('FORBIDDEN', 'No'); });
		__register('onerr/live', handler);

		let called = false;
		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'onerr/live', id: 'oe2', args: [] });

		handleRpc(ws, data, platform, {
			onError() { called = true; }
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(called).toBe(false);
		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
	});
});

// -- Phase 18: createMessage with onError -------------------------------------

describe('createMessage() with onError', () => {
	it('passes onError through to handleRpc', async () => {
		const handler = live(async () => { throw new Error('boom'); });
		__register('cm/onerr', handler);

		let errorPath;
		const hook = createMessage({
			onError(path) { errorPath = path; }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'cm/onerr', id: 'coe1', args: [] });

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		hook(ws, { data, platform });

		await new Promise((r) => setTimeout(r, 10));

		expect(errorPath).toBe('cm/onerr');

		warn.mockRestore();
		error.mockRestore();
	});
});

// -- Phase 19: Stream pagination ----------------------------------------------

describe('handleRpc() stream pagination', () => {
	it('passes through hasMore and cursor from paginated initFn response', async () => {
		const ws = mockWs();
		const platform = mockPlatform();

		const streamFn = live.stream('pag-items', async (ctx) => {
			return { data: [{ id: 1 }, { id: 2 }], hasMore: true, cursor: 'abc123' };
		}, { merge: 'crud', key: 'id' });
		__register('pag/items', streamFn);

		const data = toArrayBuffer({ rpc: 'pag/items', id: 'pg1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.ok).toBe(true);
		expect(response.data).toEqual([{ id: 1 }, { id: 2 }]);
		expect(response.hasMore).toBe(true);
		expect(response.cursor).toBe('abc123');
	});

	it('regular array return works as before (no hasMore)', async () => {
		const ws = mockWs();
		const platform = mockPlatform();

		const streamFn = live.stream('pag-plain', async (ctx) => {
			return [{ id: 1 }];
		}, { merge: 'crud', key: 'id' });
		__register('pag/plain', streamFn);

		const data = toArrayBuffer({ rpc: 'pag/plain', id: 'pg2', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.ok).toBe(true);
		expect(response.data).toEqual([{ id: 1 }]);
		expect(response.hasMore).toBeUndefined();
	});

	it('ctx.cursor is available from client request', async () => {
		const ws = mockWs();
		const platform = mockPlatform();

		let receivedCursor;
		const streamFn = live.stream('pag-cursor', async (ctx) => {
			receivedCursor = ctx.cursor;
			return [{ id: 3 }];
		}, { merge: 'crud', key: 'id' });
		__register('pag/cursor', streamFn);

		const data = toArrayBuffer({ rpc: 'pag/cursor', id: 'pg3', args: [], stream: true, cursor: 'xyz' });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(receivedCursor).toBe('xyz');
	});
});

// -- Phase 20: Stream lifecycle hooks -----------------------------------------

describe('live.stream() lifecycle hooks', () => {
	it('fires onSubscribe after ws.subscribe', async () => {
		const ws = mockWs();
		const platform = mockPlatform();

		let subscribedTopic;
		const streamFn = live.stream('lh-topic', async (ctx) => [], {
			merge: 'crud',
			key: 'id',
			onSubscribe(ctx, topic) { subscribedTopic = topic; }
		});
		__register('lh/items', streamFn);

		const data = toArrayBuffer({ rpc: 'lh/items', id: 'lh1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(subscribedTopic).toBe('lh-topic');
		expect(ws.isSubscribed('lh-topic')).toBe(true);
	});
});

// -- Phase 20: close() -------------------------------------------------------

describe('close()', () => {
	it('fires onUnsubscribe for static topic streams on close', () => {
		let unsubTopic;
		const streamFn = live.stream('close-topic', async (ctx) => [], {
			merge: 'crud',
			key: 'id',
			onUnsubscribe(ctx, topic) { unsubTopic = topic; }
		});
		__register('close/items', streamFn);

		const ws = mockWs();
		const platform = mockPlatform();

		close(ws, { platform });

		expect(unsubTopic).toBe('close-topic');
	});
});

// -- Phase 21: Global middleware ----------------------------------------------

describe('live.middleware()', () => {
	it('runs before guard and handler', async () => {
		const order = [];
		live.middleware(async (ctx, next) => {
			order.push('middleware');
			return next();
		});

		const guardFn = guard((ctx) => { order.push('guard'); });
		const handler = live(async (ctx) => { order.push('handler'); return 'ok'; });

		__registerGuard('mw', guardFn);
		__register('mw/test', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'mw/test', id: 'mw1', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(order).toEqual(['middleware', 'guard', 'handler']);
		expect(platform.sent[0].data.ok).toBe(true);
	});
});

// -- Phase 22: Binary RPC ----------------------------------------------------

describe('handleRpc() binary', () => {
	it('handles binary RPC frames', async () => {
		let receivedBuffer;
		const handler = live.binary(async (ctx, buffer, filename) => {
			receivedBuffer = buffer;
			return { size: buffer.byteLength, name: filename };
		});
		__register('bin/upload', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Build binary frame: 0x00 + uint16 header length + JSON header + binary payload
		const header = JSON.stringify({ rpc: 'bin/upload', id: 'bn1', args: ['photo.jpg'] });
		const headerBytes = new TextEncoder().encode(header);
		const payload = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG magic bytes
		const frame = new Uint8Array(3 + headerBytes.length + payload.length);
		frame[0] = 0x00;
		frame[1] = (headerBytes.length >> 8) & 0xFF;
		frame[2] = headerBytes.length & 0xFF;
		frame.set(headerBytes, 3);
		frame.set(payload, 3 + headerBytes.length);

		const result = handleRpc(ws, frame.buffer, platform);
		expect(result).toBe(true);

		await new Promise((r) => setTimeout(r, 10));

		expect(receivedBuffer).toBeInstanceOf(ArrayBuffer);
		expect(receivedBuffer.byteLength).toBe(4);
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual({ size: 4, name: 'photo.jpg' });
	});

	it('rejects binary call to non-binary endpoint', async () => {
		const handler = live(async (ctx) => 'regular');
		__register('bin/regular', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		const header = JSON.stringify({ rpc: 'bin/regular', id: 'bn2' });
		const headerBytes = new TextEncoder().encode(header);
		const frame = new Uint8Array(3 + headerBytes.length);
		frame[0] = 0x00;
		frame[1] = (headerBytes.length >> 8) & 0xFF;
		frame[2] = headerBytes.length & 0xFF;
		frame.set(headerBytes, 3);

		handleRpc(ws, frame.buffer, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
	});

	it('live.binary marks function metadata', () => {
		const fn = live.binary(async (ctx, buf) => {});
		expect(fn.__isLive).toBe(true);
		expect(fn.__isBinary).toBe(true);
	});
});

// -- Phase 27: Throttle / Debounce -------------------------------------------

describe('ctx.throttle and ctx.debounce', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('ctx.throttle publishes immediately on first call', async () => {
		const handler = live(async (ctx, data) => {
			ctx.throttle('t1', 'updated', data, 100);
			return 'ok';
		});
		__register('throttle/test', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'throttle/test', id: 't1', args: [{ val: 1 }] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		const publishes = platform.published.filter(p => p.topic === 't1');
		expect(publishes.length).toBe(1);
		expect(publishes[0].data).toEqual({ val: 1 });
	});

	it('ctx.throttle sends trailing edge after interval', async () => {
		const handler = live(async (ctx, data) => {
			ctx.throttle('t2', 'updated', data, 100);
			return 'ok';
		});
		__register('throttle/trailing', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'throttle/trailing', id: 'tt1', args: [{ val: 1 }] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		handleRpc(ws, toArrayBuffer({ rpc: 'throttle/trailing', id: 'tt2', args: [{ val: 2 }] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		handleRpc(ws, toArrayBuffer({ rpc: 'throttle/trailing', id: 'tt3', args: [{ val: 3 }] }), platform);
		await vi.advanceTimersByTimeAsync(100);

		const publishes = platform.published.filter(p => p.topic === 't2');
		// First call immediate + trailing edge with last value
		expect(publishes.length).toBe(2);
		expect(publishes[0].data).toEqual({ val: 1 });
		expect(publishes[1].data).toEqual({ val: 3 });
	});

	it('ctx.debounce waits for silence before publishing', async () => {
		const handler = live(async (ctx, data) => {
			ctx.debounce('d1', 'updated', data, 50);
			return 'ok';
		});
		__register('debounce/test', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'debounce/test', id: 'd1', args: [{ val: 1 }] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		handleRpc(ws, toArrayBuffer({ rpc: 'debounce/test', id: 'd2', args: [{ val: 2 }] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		// Should not have published yet
		const early = platform.published.filter(p => p.topic === 'd1');
		expect(early.length).toBe(0);

		await vi.advanceTimersByTimeAsync(60);

		const publishes = platform.published.filter(p => p.topic === 'd1');
		expect(publishes.length).toBe(1);
		expect(publishes[0].data).toEqual({ val: 2 });
	});
});

// -- Phase 26/32: live.access helpers ----------------------------------------

describe('live.access', () => {
	it('owner() checks data[field] === ctx.user.id', () => {
		const filter = live.access.owner('userId');
		expect(filter({ user: { id: 'u1' } }, 'created', { userId: 'u1' })).toBe(true);
		expect(filter({ user: { id: 'u2' } }, 'created', { userId: 'u1' })).toBe(false);
		expect(filter({ user: { id: 'u1' } }, 'created', null)).toBeFalsy();
	});

	it('role() checks ctx.user.role in map', () => {
		const filter = live.access.role({
			admin: true,
			viewer: (ctx, data) => data.public === true
		});
		expect(filter({ user: { role: 'admin' } }, 'created', {})).toBe(true);
		expect(filter({ user: { role: 'viewer' } }, 'created', { public: true })).toBe(true);
		expect(filter({ user: { role: 'viewer' } }, 'created', { public: false })).toBe(false);
		expect(filter({ user: { role: 'guest' } }, 'created', {})).toBe(false);
		expect(filter({ user: {} }, 'created', {})).toBe(false);
	});

	it('team() checks data[field] === ctx.user.teamId', () => {
		const filter = live.access.team('teamId');
		expect(filter({ user: { teamId: 't1' } }, 'created', { teamId: 't1' })).toBe(true);
		expect(filter({ user: { teamId: 't2' } }, 'created', { teamId: 't1' })).toBe(false);
	});

	it('any() returns true if any predicate matches', () => {
		const filter = live.access.any(
			live.access.owner('userId'),
			live.access.role({ admin: true })
		);
		expect(filter({ user: { id: 'u1' } }, 'created', { userId: 'u1' })).toBe(true);
		expect(filter({ user: { role: 'admin' } }, 'created', {})).toBe(true);
		expect(filter({ user: { id: 'u2', role: 'viewer' } }, 'created', { userId: 'u1' })).toBe(false);
	});

	it('all() returns true only if all predicates match', () => {
		const filter = live.access.all(
			live.access.owner('userId'),
			live.access.role({ admin: true })
		);
		expect(filter({ user: { id: 'u1', role: 'admin' } }, 'created', { userId: 'u1' })).toBe(true);
		expect(filter({ user: { id: 'u1', role: 'viewer' } }, 'created', { userId: 'u1' })).toBe(false);
	});
});

// -- Phase 26/32: live.stream with filter/access option ----------------------

describe('live.stream() with filter/access', () => {
	it('stores filter function from filter option', () => {
		const filterFn = (ctx, event, data) => true;
		const fn = live.stream('filtered', async () => [], { filter: filterFn });
		expect(fn.__streamFilter).toBe(filterFn);
	});

	it('stores filter function from access option (alias)', () => {
		const accessFn = live.access.owner('userId');
		const fn = live.stream('accessed', async () => [], { access: accessFn });
		expect(fn.__streamFilter).toBe(accessFn);
	});

	it('access takes priority over filter', () => {
		const accessFn = (ctx, event, data) => true;
		const filterFn = (ctx, event, data) => false;
		const fn = live.stream('priority', async () => [], { access: accessFn, filter: filterFn });
		expect(fn.__streamFilter).toBe(accessFn);
	});
});

// -- Phase 30: live.derived() ------------------------------------------------

describe('live.derived()', () => {
	it('marks function with __isDerived and __isStream', () => {
		const fn = live.derived(['orders', 'inventory'], async () => ({ total: 0 }));
		expect(fn.__isDerived).toBe(true);
		expect(fn.__isStream).toBe(true);
		expect(fn.__isLive).toBe(true);
		expect(fn.__derivedSources).toEqual(['orders', 'inventory']);
		expect(fn.__streamOptions.merge).toBe('set');
	});

	it('accepts custom merge mode and debounce', () => {
		const fn = live.derived(['a'], async () => [], { merge: 'crud', debounce: 200 });
		expect(fn.__streamOptions.merge).toBe('crud');
		expect(fn.__derivedDebounce).toBe(200);
	});

	it('generates a unique topic per derived stream', () => {
		const fn1 = live.derived(['a'], async () => 1);
		const fn2 = live.derived(['b'], async () => 2);
		expect(fn1.__streamTopic).toBeDefined();
		expect(fn2.__streamTopic).toBeDefined();
		expect(fn1.__streamTopic).not.toBe(fn2.__streamTopic);
	});
});

// -- Phase 30: _activateDerived + __registerDerived --------------------------

import { __registerDerived, _activateDerived } from '../server.js';

describe('derived stream activation', () => {
	it('recomputes and publishes when source topic publishes', async () => {
		let counter = 0;
		const derivedFn = live.derived(['source1'], async () => {
			counter++;
			return { count: counter };
		});

		__registerDerived('test/derived', derivedFn);

		const platform = mockPlatform();
		_activateDerived(platform);

		// Publish on source topic should trigger recomputation
		platform.publish('source1', 'updated', { val: 1 });

		// Wait for async recomputation
		await new Promise(r => setTimeout(r, 20));

		const derivedPublishes = platform.published.filter(p => p.topic === derivedFn.__streamTopic);
		expect(derivedPublishes.length).toBeGreaterThanOrEqual(1);
		expect(derivedPublishes[derivedPublishes.length - 1].event).toBe('set');
		expect(derivedPublishes[derivedPublishes.length - 1].data.count).toBe(counter);
	});
});

// -- Phase 24: live.room() ---------------------------------------------------

describe('live.room()', () => {
	it('creates a room export with __isRoom and sub-streams', () => {
		const room = live.room({
			topic: (ctx, roomId) => 'room:' + roomId,
			init: async (ctx, roomId) => [{ id: 1, text: 'hello' }],
			presence: (ctx) => ({ name: ctx.user?.name }),
			cursors: true,
			actions: {
				addItem: async (ctx, text) => ({ id: 2, text })
			}
		});

		expect(room.__isRoom).toBe(true);
		expect(room.__dataStream).toBeDefined();
		expect(room.__dataStream.__isStream).toBe(true);
		expect(room.__hasPresence).toBe(true);
		expect(room.__hasCursors).toBe(true);
		expect(room.__presenceStream).toBeDefined();
		expect(room.__cursorStream).toBeDefined();
		expect(room.__actions).toBeDefined();
		expect(room.__actions.addItem.__isLive).toBe(true);
	});

	it('works without presence, cursors, or actions', () => {
		const room = live.room({
			topic: (ctx) => 'simple',
			init: async (ctx) => []
		});

		expect(room.__isRoom).toBe(true);
		expect(room.__dataStream).toBeDefined();
		expect(room.__hasPresence).toBe(false);
		expect(room.__hasCursors).toBe(false);
		expect(room.__presenceStream).toBeUndefined();
		expect(room.__cursorStream).toBeUndefined();
		expect(room.__actions).toBeUndefined();
	});

	it('data stream uses configured merge mode', () => {
		const room = live.room({
			topic: (ctx) => 'custom',
			init: async (ctx) => [],
			merge: 'latest',
			key: 'sku'
		});

		expect(room.__dataStream.__streamOptions.merge).toBe('latest');
		expect(room.__dataStream.__streamOptions.key).toBe('sku');
	});
});

// -- Phase 31: live.webhook() ------------------------------------------------

describe('live.webhook()', () => {
	it('creates a webhook handler with metadata', () => {
		const wh = live.webhook('payments', {
			verify: ({ body, headers }) => JSON.parse(body),
			transform: (event) => ({ event: event.type, data: event.data })
		});

		expect(wh.__isWebhook).toBe(true);
		expect(wh.__webhookTopic).toBe('payments');
		expect(typeof wh.handle).toBe('function');
	});

	it('handle() verifies and publishes', async () => {
		const platform = mockPlatform();
		const wh = live.webhook('events', {
			verify: ({ body }) => JSON.parse(body),
			transform: (event) => ({ event: 'created', data: event })
		});

		const result = await wh.handle({
			body: '{"id":1,"type":"order"}',
			headers: {},
			platform
		});

		expect(result.status).toBe(200);
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].topic).toBe('events');
		expect(platform.published[0].event).toBe('created');
		expect(platform.published[0].data).toEqual({ id: 1, type: 'order' });
	});

	it('handle() returns 400 when verify throws', async () => {
		const wh = live.webhook('events', {
			verify: () => { throw new Error('bad signature'); },
			transform: (e) => ({ event: 'x', data: e })
		});

		const result = await wh.handle({
			body: 'invalid',
			headers: {},
			platform: mockPlatform()
		});

		expect(result.status).toBe(400);
	});

	it('handle() returns 200 with Ignored when transform returns null', async () => {
		const platform = mockPlatform();
		const wh = live.webhook('events', {
			verify: ({ body }) => JSON.parse(body),
			transform: () => null
		});

		const result = await wh.handle({
			body: '{"type":"ignored"}',
			headers: {},
			platform
		});

		expect(result.status).toBe(200);
		expect(result.body).toBe('Ignored');
		expect(platform.published).toHaveLength(0);
	});
});

// -- Phase 33: Delta sync (server side) --------------------------------------

describe('delta sync in streams', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('stores delta config on stream function', () => {
		const deltaConfig = {
			version: () => 'v1',
			diff: (since) => []
		};
		const fn = live.stream('delta-test', async () => [], { delta: deltaConfig });
		expect(fn.__delta).toBe(deltaConfig);
	});

	it('responds with unchanged when version matches', async () => {
		const fn = live.stream('delta-unchanged', async () => [{ id: 1 }], {
			delta: {
				version: () => 'v42',
				diff: () => []
			}
		});
		__register('delta/items', fn);

		const data = toArrayBuffer({ rpc: 'delta/items', id: 'du1', args: [], stream: true, version: 'v42' });
		handleRpc(ws, data, platform);

		await new Promise(r => setTimeout(r, 20));

		const response = platform.sent.find(s => s.event === 'du1');
		expect(response).toBeDefined();
		expect(response.data.ok).toBe(true);
		expect(response.data.unchanged).toBe(true);
		expect(response.data.version).toBe('v42');
		expect(response.data.data).toEqual([]);
	});

	it('responds with delta diff when version differs', async () => {
		const fn = live.stream('delta-diff', async () => [{ id: 1 }, { id: 2 }], {
			delta: {
				version: () => 'v2',
				diff: (since) => [{ id: 2, name: 'updated' }]
			}
		});
		__register('delta/diff', fn);

		const data = toArrayBuffer({ rpc: 'delta/diff', id: 'dd1', args: [], stream: true, version: 'v1' });
		handleRpc(ws, data, platform);

		await new Promise(r => setTimeout(r, 20));

		const response = platform.sent.find(s => s.event === 'dd1');
		expect(response).toBeDefined();
		expect(response.data.ok).toBe(true);
		expect(response.data.delta).toBe(true);
		expect(response.data.version).toBe('v2');
		expect(response.data.data).toEqual([{ id: 2, name: 'updated' }]);
	});

	it('falls back to full refetch when diff returns null', async () => {
		const fn = live.stream('delta-fallback', async () => [{ id: 1 }, { id: 2 }], {
			delta: {
				version: () => 'v3',
				diff: () => null
			}
		});
		__register('delta/fallback', fn);

		const data = toArrayBuffer({ rpc: 'delta/fallback', id: 'df1', args: [], stream: true, version: 'v1' });
		handleRpc(ws, data, platform);

		await new Promise(r => setTimeout(r, 20));

		const response = platform.sent.find(s => s.event === 'df1');
		expect(response).toBeDefined();
		expect(response.data.ok).toBe(true);
		expect(response.data.delta).toBeUndefined();
		expect(response.data.unchanged).toBeUndefined();
		expect(response.data.data).toEqual([{ id: 1 }, { id: 2 }]);
		// Full refetch should still include version
		expect(response.data.version).toBe('v3');
	});

	it('includes version in full refetch when no client version sent', async () => {
		const fn = live.stream('delta-full', async () => [{ id: 1 }], {
			delta: {
				version: () => 'v5',
				diff: () => []
			}
		});
		__register('delta/full', fn);

		// No version field in request -- full refetch
		const data = toArrayBuffer({ rpc: 'delta/full', id: 'dful1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise(r => setTimeout(r, 20));

		const response = platform.sent.find(s => s.event === 'dful1');
		expect(response).toBeDefined();
		expect(response.data.ok).toBe(true);
		expect(response.data.data).toEqual([{ id: 1 }]);
		expect(response.data.version).toBe('v5');
	});
});

// -- Phase 28: Test utilities ------------------------------------------------

import { createTestEnv } from '../test.js';

describe('createTestEnv()', () => {
	let env;

	beforeEach(() => {
		env = createTestEnv();
	});

	afterEach(() => {
		env.cleanup();
	});

	it('register + call a live function', async () => {
		const greet = live(async (ctx, name) => `Hello, ${name}!`);
		env.register('greet', { greet });

		const client = env.connect({ id: 'u1' });
		const result = await client.call('greet/greet', 'World');
		expect(result).toBe('Hello, World!');
	});

	it('call rejects with LiveError for errors', async () => {
		const fail = live(async () => { throw new LiveError('FORBIDDEN', 'No access'); });
		env.register('fail', { fail });

		const client = env.connect({ id: 'u1' });
		await expect(client.call('fail/fail')).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: 'No access'
		});
	});

	it('subscribe returns stream value', async () => {
		const items = live.stream('test-items', async () => [{ id: 1, text: 'a' }]);
		env.register('items', { items });

		const client = env.connect({ id: 'u1' });
		const stream = client.subscribe('items/items');

		// Wait for the value
		await new Promise(r => setTimeout(r, 20));

		expect(stream.value).toEqual([{ id: 1, text: 'a' }]);
		expect(stream.topic).toBe('test-items');
	});

	it('subscribe receives pub/sub events', async () => {
		const items = live.stream('pubsub-items', async () => []);
		env.register('ps', { items });

		const client = env.connect({ id: 'u1' });
		const stream = client.subscribe('ps/items');

		await new Promise(r => setTimeout(r, 20));

		// Publish an event on the stream's topic
		env.platform.publish('pubsub-items', 'created', { id: 1, text: 'new' });

		await new Promise(r => setTimeout(r, 20));

		expect(stream.events.length).toBe(1);
		expect(stream.events[0].event).toBe('created');
		expect(stream.events[0].data).toEqual({ id: 1, text: 'new' });
	});

	it('binary call works', async () => {
		const upload = live.binary(async (ctx, buffer, filename) => {
			return { size: buffer.byteLength, filename };
		});
		env.register('upload', { upload });

		const client = env.connect({ id: 'u1' });
		const buf = new Uint8Array([1, 2, 3, 4]).buffer;
		const result = await client.binary('upload/upload', buf, 'test.bin');
		expect(result).toEqual({ size: 4, filename: 'test.bin' });
	});

	it('guard is registered and enforced', async () => {
		const _guard = guard((ctx) => {
			if (!ctx.user?.admin) throw new LiveError('FORBIDDEN');
		});
		const action = live(async (ctx) => 'ok');
		env.register('guarded', { _guard, action });

		const admin = env.connect({ admin: true });
		expect(await admin.call('guarded/action')).toBe('ok');

		const user = env.connect({ admin: false });
		await expect(user.call('guarded/action')).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('disconnect prevents further calls', async () => {
		const fn = live(async () => 'ok');
		env.register('dc', { fn });

		const client = env.connect({ id: 'u1' });
		client.disconnect();
		await expect(client.call('dc/fn')).rejects.toThrow('Disconnected');
	});

	it('tracks platform.connections count', () => {
		expect(env.platform.connections).toBe(0);
		const c1 = env.connect({ id: 'u1' });
		const c2 = env.connect({ id: 'u2' });
		expect(env.platform.connections).toBe(2);
		c1.disconnect();
		expect(env.platform.connections).toBe(1);
	});
});

// -- Phase 35: live.channel() -------------------------------------------------

describe('live.channel()', () => {
	it('sets __isChannel, __isStream and __isLive flags', () => {
		const ch = live.channel('typing:lobby', { merge: 'presence' });
		expect(ch.__isChannel).toBe(true);
		expect(ch.__isStream).toBe(true);
		expect(ch.__isLive).toBe(true);
	});

	it('sets stream topic and options', () => {
		const ch = live.channel('cursors:doc1', { merge: 'cursor', key: 'userId' });
		expect(ch.__streamTopic).toBe('cursors:doc1');
		expect(ch.__streamOptions).toEqual({ merge: 'cursor', key: 'userId' });
	});

	it('uses default options (merge: set, key: id)', () => {
		const ch = live.channel('events');
		expect(ch.__streamOptions).toEqual({ merge: 'set', key: 'id' });
	});

	it('supports dynamic topic function', () => {
		const ch = live.channel((ctx, roomId) => 'typing:' + roomId, { merge: 'presence' });
		expect(typeof ch.__streamTopic).toBe('function');
		expect(ch.__streamTopic({}, 'room1')).toBe('typing:room1');
	});

	it('responds immediately via handleRpc with empty data', async () => {
		const ch = live.channel('typing:lobby', { merge: 'presence' });
		__register('test/typing', ch);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const buf = toArrayBuffer({ rpc: 'test/typing', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent.length).toBe(1);
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual([]);
		expect(platform.sent[0].data.topic).toBe('typing:lobby');
		expect(platform.sent[0].data.merge).toBe('presence');
		expect(ws._topics.has('typing:lobby')).toBe(true);
	});

	it('returns null for set merge channels', async () => {
		const ch = live.channel('status');
		__register('test/status', ch);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const buf = toArrayBuffer({ rpc: 'test/status', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.data).toBe(null);
		expect(platform.sent[0].data.merge).toBe('set');
	});
});

// -- Phase 37: live.rateLimit() -----------------------------------------------

describe('live.rateLimit()', () => {
	it('sets __isLive and __isRateLimited flags', () => {
		const fn = live.rateLimit({ points: 5, window: 10000 }, async (ctx) => 'ok');
		expect(fn.__isLive).toBe(true);
		expect(fn.__isRateLimited).toBe(true);
	});

	it('allows calls within the rate limit', async () => {
		const fn = live.rateLimit({ points: 3, window: 10000 }, async (ctx, text) => text);
		fn.__rateLimitPath = 'test/limited';

		const ctx = { user: { id: 'user1' } };
		expect(await fn(ctx, 'a')).toBe('a');
		expect(await fn(ctx, 'b')).toBe('b');
		expect(await fn(ctx, 'c')).toBe('c');
	});

	it('throws RATE_LIMITED when limit exceeded', async () => {
		const fn = live.rateLimit({ points: 2, window: 10000 }, async (ctx) => 'ok');
		fn.__rateLimitPath = 'test/limited2';

		const ctx = { user: { id: 'user2' } };
		await fn(ctx);
		await fn(ctx);

		try {
			await fn(ctx);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err.code).toBe('RATE_LIMITED');
			expect(err.retryAfter).toBeGreaterThan(0);
		}
	});

	it('different users have independent limits', async () => {
		const fn = live.rateLimit({ points: 1, window: 10000 }, async (ctx) => 'ok');
		fn.__rateLimitPath = 'test/limited3';

		const ctx1 = { user: { id: 'a' } };
		const ctx2 = { user: { id: 'b' } };

		await fn(ctx1);
		await fn(ctx2); // should not throw -- different user
	});

	it('custom key function is used', async () => {
		const fn = live.rateLimit(
			{ points: 1, window: 10000, key: (ctx) => ctx.ip },
			async (ctx) => 'ok'
		);
		fn.__rateLimitPath = 'test/limited4';

		const ctx = { ip: '1.2.3.4', user: { id: 'user3' } };
		await fn(ctx);

		try {
			await fn(ctx);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err.code).toBe('RATE_LIMITED');
		}
	});

	it('works through handleRpc', async () => {
		const fn = live.rateLimit({ points: 1, window: 10000 }, async (ctx, msg) => msg);
		__register('rl/send', fn);

		const ws = mockWs({ id: 'rl_user' });
		const platform = mockPlatform();

		// First call: succeeds
		handleRpc(ws, toArrayBuffer({ rpc: 'rl/send', id: '1', args: ['hi'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(true);

		// Second call: rate limited
		handleRpc(ws, toArrayBuffer({ rpc: 'rl/send', id: '2', args: ['hi2'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1].data.ok).toBe(false);
		expect(platform.sent[1].data.code).toBe('RATE_LIMITED');
	});
});

// -- Phase 38: live.effect() --------------------------------------------------

describe('live.effect()', () => {
	it('sets __isEffect flag and metadata', () => {
		const fn = live.effect(['orders'], async (event, data) => {});
		expect(fn.__isEffect).toBe(true);
		expect(fn.__effectSources).toEqual(['orders']);
	});

	it('fires when a source topic publishes', async () => {
		const calls = [];
		const fn = live.effect(['orders'], async (event, data, platform) => {
			calls.push({ event, data });
		});
		__registerEffect('test/orderNotify', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders', 'created', { id: 1, total: 99 });
		await new Promise((r) => setTimeout(r, 10));

		expect(calls.length).toBe(1);
		expect(calls[0].event).toBe('created');
		expect(calls[0].data).toEqual({ id: 1, total: 99 });
	});

	it('does not fire for non-matching topics', async () => {
		const calls = [];
		const fn = live.effect(['orders'], async (event, data) => {
			calls.push({ event, data });
		});
		__registerEffect('test/orderNotify2', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('users', 'created', { id: 1 });
		await new Promise((r) => setTimeout(r, 10));

		expect(calls.length).toBe(0);
	});

	it('effect errors do not crash the publish path', async () => {
		const fn = live.effect(['orders'], async () => {
			throw new Error('boom');
		});
		__registerEffect('test/crashyEffect', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		// Should not throw
		platform.publish('orders', 'created', { id: 1 });
		await new Promise((r) => setTimeout(r, 10));
	});

	it('watches multiple topics', async () => {
		const calls = [];
		const fn = live.effect(['orders', 'inventory'], async (event, data) => {
			calls.push({ event, data });
		});
		__registerEffect('test/multiEffect', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders', 'created', { id: 1 });
		platform.publish('inventory', 'updated', { id: 2 });
		await new Promise((r) => setTimeout(r, 10));

		expect(calls.length).toBe(2);
	});
});

// -- Phase 43: live.signal() --------------------------------------------------

describe('live.signal()', () => {
	it('ctx.signal publishes to __signal:{userId} topic', async () => {
		const fn = live(async (ctx, targetId, msg) => {
			ctx.signal(targetId, 'dm', { text: msg });
			return 'sent';
		});
		__register('sig/send', fn);

		const ws = mockWs({ id: 'sender' });
		const platform = mockPlatform();
		const buf = toArrayBuffer({ rpc: 'sig/send', id: '1', args: ['recipient1', 'hello'] });
		handleRpc(ws, buf, platform);

		await new Promise((r) => setTimeout(r, 10));

		// Check that the platform.publish was called with the signal topic
		const signalPub = platform.published.find(p => p.topic === '__signal:recipient1');
		expect(signalPub).toBeDefined();
		expect(signalPub.event).toBe('dm');
		expect(signalPub.data).toEqual({ text: 'hello' });
	});

	it('enableSignals subscribes ws to its signal topic', () => {
		const ws = mockWs({ id: 'user42' });
		enableSignals(ws);
		expect(ws._topics.has('__signal:user42')).toBe(true);
	});

	it('enableSignals with custom idField', () => {
		const ws = mockWs({ odooId: 'abc' });
		enableSignals(ws, { idField: 'odooId' });
		expect(ws._topics.has('__signal:abc')).toBe(true);
	});

	it('enableSignals does nothing if no user id', () => {
		const ws = mockWs({});
		enableSignals(ws);
		expect(ws._topics.size).toBe(0);
	});
});

// -- Phase 39: live.aggregate() -----------------------------------------------

describe('live.aggregate()', () => {
	it('sets aggregate metadata', () => {
		const fn = live.aggregate('orders', {
			count: { init: () => 0, reduce: (acc, event) => event === 'created' ? acc + 1 : acc }
		}, { topic: 'order-stats' });

		expect(fn.__isAggregate).toBe(true);
		expect(fn.__isStream).toBe(true);
		expect(fn.__streamTopic).toBe('order-stats');
		expect(fn.__aggregateSource).toBe('orders');
	});

	it('updates state via reducers when source publishes', async () => {
		const fn = live.aggregate('orders', {
			count: {
				init: () => 0,
				reduce: (acc, event) => event === 'created' ? acc + 1 : event === 'deleted' ? acc - 1 : acc
			},
			total: {
				init: () => 0,
				reduce: (acc, event, data) => event === 'created' ? acc + (data.amount || 0) : acc
			}
		}, { topic: 'order-stats' });

		__register('agg/stats', fn);
		__registerAggregate('agg/stats', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders', 'created', { id: 1, amount: 50 });
		platform.publish('orders', 'created', { id: 2, amount: 30 });
		platform.publish('orders', 'deleted', { id: 1 });

		// Check published aggregate state
		const statsPubs = platform.published.filter(p => p.topic === 'order-stats');
		expect(statsPubs.length).toBe(3);
		const lastState = statsPubs[2].data;
		expect(lastState.count).toBe(1);
		expect(lastState.total).toBe(80);
	});

	it('computed fields derive from other fields', async () => {
		const fn = live.aggregate('orders', {
			count: { init: () => 0, reduce: (acc, event) => event === 'created' ? acc + 1 : acc },
			total: { init: () => 0, reduce: (acc, event, data) => event === 'created' ? acc + data.amount : acc },
			avg: { compute: (state) => state.count > 0 ? state.total / state.count : 0 }
		}, { topic: 'computed-stats' });

		__register('agg/computed', fn);
		__registerAggregate('agg/computed', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders', 'created', { id: 1, amount: 100 });
		platform.publish('orders', 'created', { id: 2, amount: 200 });

		const statsPubs = platform.published.filter(p => p.topic === 'computed-stats');
		const lastState = statsPubs[statsPubs.length - 1].data;
		expect(lastState.avg).toBe(150);
	});
});

// -- Phase 40: live.gate() ----------------------------------------------------

describe('live.gate()', () => {
	it('sets gate metadata on the wrapped function', () => {
		const stream = live.stream('beta-feed', async (ctx) => [], { merge: 'latest' });
		const gated = live.gate((ctx) => ctx.user?.beta === true, stream);

		expect(gated.__isGated).toBe(true);
		expect(typeof gated.__gatePredicate).toBe('function');
		expect(gated.__isStream).toBe(true);
		expect(gated.__isLive).toBe(true);
		expect(gated.__streamTopic).toBe('beta-feed');
	});

	it('returns gated response when predicate returns false', async () => {
		const stream = live.stream('beta-feed', async (ctx) => [{ id: 1, title: 'secret' }], { merge: 'crud' });
		const gated = live.gate((ctx) => false, stream);
		__register('gate/feed', gated);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'gate/feed', id: 'g1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data).toBeNull();
		expect(response.gated).toBe(true);
	});

	it('delegates normally when predicate returns true', async () => {
		const stream = live.stream('beta-feed', async (ctx) => [{ id: 1, title: 'public' }], { merge: 'crud' });
		const gated = live.gate((ctx) => true, stream);
		__register('gate/ok', gated);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'gate/ok', id: 'g2', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data).toEqual([{ id: 1, title: 'public' }]);
		expect(response.gated).toBeUndefined();
	});

	it('gate predicate receives ctx and args', async () => {
		const calls = [];
		const stream = live.stream('gate-args', async (ctx) => [], { merge: 'set' });
		const gated = live.gate((ctx, roomId) => {
			calls.push({ userId: ctx.user.id, roomId });
			return false;
		}, stream);
		__register('gate/args', gated);

		const ws = mockWs({ id: 'u42' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'gate/args', id: 'g3', args: ['room-7'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		expect(calls.length).toBe(1);
		expect(calls[0].userId).toBe('u42');
		expect(calls[0].roomId).toBe('room-7');
	});
});

// -- Phase 41: pipe() ---------------------------------------------------------

describe('pipe()', () => {
	it('preserves stream metadata on piped function', () => {
		const stream = live.stream('items', async (ctx) => [], { merge: 'crud', key: 'id' });
		const piped = pipe(stream, pipe.filter((ctx, item) => item.active));

		expect(piped.__isStream).toBe(true);
		expect(piped.__isLive).toBe(true);
		expect(piped.__streamTopic).toBe('items');
		expect(piped.__streamOptions.merge).toBe('crud');
	});

	it('pipe.filter() removes items from initial data', async () => {
		const stream = live.stream('items', async (ctx) => [
			{ id: 1, active: true },
			{ id: 2, active: false },
			{ id: 3, active: true }
		], { merge: 'crud', key: 'id' });

		const piped = pipe(stream, pipe.filter((ctx, item) => item.active));
		const result = await piped({});
		expect(result).toEqual([
			{ id: 1, active: true },
			{ id: 3, active: true }
		]);
	});

	it('pipe.sort() sorts initial data', async () => {
		const stream = live.stream('items', async (ctx) => [
			{ id: 1, name: 'banana' },
			{ id: 2, name: 'apple' },
			{ id: 3, name: 'cherry' }
		], { merge: 'crud', key: 'id' });

		const piped = pipe(stream, pipe.sort('name', 'asc'));
		const result = await piped({});
		expect(result.map(i => i.name)).toEqual(['apple', 'banana', 'cherry']);
	});

	it('pipe.sort() desc order', async () => {
		const stream = live.stream('items', async (ctx) => [
			{ id: 1, score: 10 },
			{ id: 2, score: 30 },
			{ id: 3, score: 20 }
		], { merge: 'crud', key: 'id' });

		const piped = pipe(stream, pipe.sort('score', 'desc'));
		const result = await piped({});
		expect(result.map(i => i.score)).toEqual([30, 20, 10]);
	});

	it('pipe.limit() caps the data', async () => {
		const stream = live.stream('items', async (ctx) => [
			{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }
		], { merge: 'crud', key: 'id' });

		const piped = pipe(stream, pipe.limit(3));
		const result = await piped({});
		expect(result.length).toBe(3);
		expect(result[2].id).toBe(3);
	});

	it('pipe.join() enriches items with resolved data', async () => {
		const userNames = { u1: 'Alice', u2: 'Bob' };
		const stream = live.stream('posts', async (ctx) => [
			{ id: 1, authorId: 'u1' },
			{ id: 2, authorId: 'u2' }
		], { merge: 'crud', key: 'id' });

		const piped = pipe(stream, pipe.join('authorId', async (id) => userNames[id], 'authorName'));
		const result = await piped({});
		expect(result[0].authorName).toBe('Alice');
		expect(result[1].authorName).toBe('Bob');
	});

	it('multiple transforms compose in order', async () => {
		const stream = live.stream('items', async (ctx) => [
			{ id: 1, score: 5, active: true },
			{ id: 2, score: 15, active: false },
			{ id: 3, score: 25, active: true },
			{ id: 4, score: 10, active: true },
			{ id: 5, score: 20, active: true }
		], { merge: 'crud', key: 'id' });

		const piped = pipe(
			stream,
			pipe.filter((ctx, item) => item.active),
			pipe.sort('score', 'desc'),
			pipe.limit(2)
		);

		const result = await piped({});
		expect(result.length).toBe(2);
		expect(result[0].score).toBe(25);
		expect(result[1].score).toBe(20);
	});
});

// -- Phase 42: Schema Evolution -----------------------------------------------

describe('schema evolution', () => {
	it('stores version and migrate metadata on stream function', () => {
		const fn = live.stream('todos', async (ctx) => [], {
			merge: 'crud', key: 'id',
			version: 3,
			migrate: {
				1: (item) => ({ ...item, priority: 'medium' }),
				2: (item) => ({ ...item, completed: item.done ?? false })
			}
		});
		expect(fn.__streamVersion).toBe(3);
		expect(typeof fn.__streamMigrate[1]).toBe('function');
		expect(typeof fn.__streamMigrate[2]).toBe('function');
	});

	it('applies migration when client version is behind server', async () => {
		const fn = live.stream('todos', async (ctx) => [
			{ id: 1, text: 'Buy milk' },
			{ id: 2, text: 'Cook dinner' }
		], {
			merge: 'crud', key: 'id',
			version: 2,
			migrate: {
				1: (item) => ({ ...item, priority: item.priority ?? 'medium' })
			}
		});
		__register('schema/todos', fn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'schema/todos', id: 's1', args: [], stream: true, schemaVersion: 1 });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data[0].priority).toBe('medium');
		expect(response.data[1].priority).toBe('medium');
		expect(response.schemaVersion).toBe(2);
	});

	it('chains migrations from v1 to v3', async () => {
		const fn = live.stream('todos', async (ctx) => [
			{ id: 1, text: 'Test', done: true }
		], {
			merge: 'crud', key: 'id',
			version: 3,
			migrate: {
				1: (item) => ({ ...item, priority: item.priority ?? 'medium' }),
				2: (item) => {
					const { done, ...rest } = item;
					return { ...rest, completed: done ?? false };
				}
			}
		});
		__register('schema/chain', fn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'schema/chain', id: 's2', args: [], stream: true, schemaVersion: 1 });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data[0].priority).toBe('medium');
		expect(response.data[0].completed).toBe(true);
		expect(response.data[0].done).toBeUndefined();
	});

	it('no migration when versions match', async () => {
		const migrateSpy = vi.fn((item) => ({ ...item, extra: true }));
		const fn = live.stream('todos', async (ctx) => [
			{ id: 1, text: 'Test' }
		], {
			merge: 'crud', key: 'id',
			version: 2,
			migrate: { 1: migrateSpy }
		});
		__register('schema/match', fn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'schema/match', id: 's3', args: [], stream: true, schemaVersion: 2 });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data[0].extra).toBeUndefined();
		expect(migrateSpy).not.toHaveBeenCalled();
	});

	it('no migration when no schemaVersion sent by client', async () => {
		const migrateSpy = vi.fn((item) => ({ ...item, extra: true }));
		const fn = live.stream('todos', async (ctx) => [
			{ id: 1, text: 'Test' }
		], {
			merge: 'crud', key: 'id',
			version: 2,
			migrate: { 1: migrateSpy }
		});
		__register('schema/nosv', fn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'schema/nosv', id: 's4', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data[0].extra).toBeUndefined();
		expect(migrateSpy).not.toHaveBeenCalled();
	});
});
