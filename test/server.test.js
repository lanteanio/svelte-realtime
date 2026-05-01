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
	_tickCron,
	__registerCron,
	setCronPlatform,
	onCronError,
	onError,
	close,
	unsubscribe,
	enableSignals,
	pipe,
	_resetIdempotencyStore,
	_resetCoalesceRegistry
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

		expect(capturedUser.id).toBe('user1');
		expect(capturedUser.name).toBe('Alice');
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

	it('ctx.signal is available in batch path', async () => {
		let capturedSignal;
		const fn = live(async (ctx, x) => { capturedSignal = ctx.signal; return x; });
		__register('batch/sig', fn);

		const data = toArrayBuffer({
			batch: [{ rpc: 'batch/sig', id: 'bs1', args: [1] }]
		});
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 20));

		expect(typeof capturedSignal).toBe('function');
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

// -- Path validation ----------------------------------------------------------

describe('handleRpc() path validation', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('rejects paths with traversal characters', async () => {
		const data = toArrayBuffer({ rpc: '../../etc/passwd', id: 'pv1', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
	});

	it('rejects single-segment paths', async () => {
		const data = toArrayBuffer({ rpc: 'onlyone', id: 'pv2', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
	});

	it('rejects paths with special characters', async () => {
		const data = toArrayBuffer({ rpc: 'foo/bar;rm -rf', id: 'pv3', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
	});

	it('allows valid multi-segment paths', async () => {
		const fn = live(async () => 'ok');
		__register('valid/path', fn);
		const data = toArrayBuffer({ rpc: 'valid/path', id: 'pv4', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(true);
	});

	it('allows deeply nested paths with underscores', async () => {
		const fn = live(async () => 'ok');
		__register('admin/users/__action/delete_user', fn);
		const data = toArrayBuffer({ rpc: 'admin/users/__action/delete_user', id: 'pv5', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(true);
	});

	it('allows hyphenated module names in paths', async () => {
		const fn = live(async () => 'ok');
		__register('email-queue/queueStats', fn);
		const data = toArrayBuffer({ rpc: 'email-queue/queueStats', id: 'pv7', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(true);
	});

	it('rejects invalid paths in batch entries', async () => {
		const data = toArrayBuffer({
			batch: [{ rpc: '../bad/path', id: 'pv6', args: [] }]
		});
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 20));
		const batch = platform.sent[0].data.batch;
		expect(batch[0].ok).toBe(false);
		expect(batch[0].code).toBe('INVALID_REQUEST');
	});
});

// -- Binary payload size limit ------------------------------------------------

describe('handleRpc() binary payload size', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('rejects binary payloads exceeding maxSize', async () => {
		const fn = live.binary(async (ctx, buffer) => 'ok', { maxSize: 100 });
		__register('bin/limited', fn);

		const header = JSON.stringify({ rpc: 'bin/limited', id: 'bs1' });
		const headerBytes = new TextEncoder().encode(header);
		const payload = new Uint8Array(200); // exceeds 100-byte limit
		const frame = new Uint8Array(3 + headerBytes.length + payload.length);
		frame[0] = 0x00;
		frame[1] = (headerBytes.length >> 8) & 0xFF;
		frame[2] = headerBytes.length & 0xFF;
		frame.set(headerBytes, 3);
		frame.set(payload, 3 + headerBytes.length);

		handleRpc(ws, frame.buffer, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('PAYLOAD_TOO_LARGE');
	});

	it('allows binary payloads within maxSize', async () => {
		const fn = live.binary(async (ctx, buffer) => ({ size: buffer.byteLength }), { maxSize: 500 });
		__register('bin/ok', fn);

		const header = JSON.stringify({ rpc: 'bin/ok', id: 'bs2' });
		const headerBytes = new TextEncoder().encode(header);
		const payload = new Uint8Array(100); // within limit
		const frame = new Uint8Array(3 + headerBytes.length + payload.length);
		frame[0] = 0x00;
		frame[1] = (headerBytes.length >> 8) & 0xFF;
		frame[2] = headerBytes.length & 0xFF;
		frame.set(headerBytes, 3);
		frame.set(payload, 3 + headerBytes.length);

		handleRpc(ws, frame.buffer, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual({ size: 100 });
	});
});

// -- Dynamic topic prefix guard -----------------------------------------------

describe('handleRpc() dynamic topic guard', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('rejects dynamic topics that resolve to __ prefix', async () => {
		const stream = live.stream(
			(ctx, name) => '__signal:' + name,
			async () => [],
			{ merge: 'crud', key: 'id' }
		);
		__register('topic/guard', stream);

		const data = toArrayBuffer({ rpc: 'topic/guard', id: 'tg1', args: ['attack'], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
		expect(platform.sent[0].data.error).toBe('Reserved topic prefix');
	});

	it('allows dynamic topics without __ prefix', async () => {
		const stream = live.stream(
			(ctx, room) => 'chat:' + room,
			async () => [{ id: 1 }],
			{ merge: 'crud', key: 'id' }
		);
		__register('topic/ok', stream);

		const data = toArrayBuffer({ rpc: 'topic/ok', id: 'tg2', args: ['lobby'], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.topic).toBe('chat:lobby');
	});

	it('rejects static stream topics with __ prefix at registration', () => {
		expect(() => {
			live.stream('__internal:stats', async () => ({ count: 0 }), { merge: 'set' });
		}).toThrow(/reserved prefix/);
	});

	it('rejects static channel topics with __ prefix at registration', () => {
		expect(() => {
			live.channel('__internal:typing', { merge: 'presence' });
		}).toThrow(/reserved prefix/);
	});

	it('rejects dynamic topics with __ prefix at subscribe time', async () => {
		const stream = live.stream(
			() => '__internal:stats',
			async () => ({ count: 0 }),
			{ merge: 'set' }
		);
		__register('topic/dynres', stream);

		const data = toArrayBuffer({ rpc: 'topic/dynres', id: 'tg3', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
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

	it('passes through when Standard Schema validates successfully', async () => {
		const schema = {
			'~standard': {
				version: 1,
				vendor: 'mock',
				validate(input) {
					if (input && typeof input.text === 'string') {
						return { value: { text: input.text.trim() } };
					}
					return { issues: [{ message: 'text is required', path: [{ key: 'text' }] }] };
				}
			}
		};

		const handler = live.validated(schema, async (ctx, input) => {
			return { received: input.text };
		});
		__register('val/std-ok', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'val/std-ok', id: 'vs1', args: [{ text: '  hello  ' }] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(true);
		expect(response.data.data).toEqual({ received: 'hello' });
	});

	it('rejects with VALIDATION code and issues on Standard Schema failure', async () => {
		const schema = {
			'~standard': {
				version: 1,
				vendor: 'mock',
				validate(input) {
					return {
						issues: [{ message: 'name is too short', path: [{ key: 'name' }] }]
					};
				}
			}
		};

		const handler = live.validated(schema, async (ctx, input) => input);
		__register('val/std-fail', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'val/std-fail', id: 'vs2', args: [{ name: '' }] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(false);
		expect(response.data.code).toBe('VALIDATION');
		expect(response.data.issues).toEqual([{ path: ['name'], message: 'name is too short' }]);
	});

	it('rejects async Standard Schema validators', async () => {
		const schema = {
			'~standard': {
				version: 1,
				vendor: 'mock',
				validate(input) {
					return Promise.resolve({ value: input });
				}
			}
		};

		const handler = live.validated(schema, async (ctx, input) => input);
		__register('val/std-async', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'val/std-async', id: 'vs3', args: [{ text: 'hi' }] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(false);
		expect(response.data.code).toBe('VALIDATION');
		expect(response.data.issues[0].message).toBe('Async schema not supported');
	});

	it('prefers ~standard over .safeParse when both exist', async () => {
		const schema = {
			'~standard': {
				version: 1,
				vendor: 'mock',
				validate(input) {
					return { value: { text: input.text, via: 'standard' } };
				}
			},
			safeParse(input) {
				return { success: true, data: { text: input.text, via: 'zod' } };
			}
		};

		const handler = live.validated(schema, async (ctx, input) => {
			return input;
		});
		__register('val/std-priority', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'val/std-priority', id: 'vs4', args: [{ text: 'hello' }] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0];
		expect(response.data.ok).toBe(true);
		expect(response.data.data).toEqual({ text: 'hello', via: 'standard' });
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

	it('warns in dev when guard runs with ctx.user = null', async () => {
		const guardFn = (ctx) => {};
		guardFn.__isGuard = true;
		__registerGuard('dc-nullwarn', guardFn);

		const handler = live(async (ctx) => 'ok');
		__register('dc-nullwarn/action', handler);

		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const platform = mockPlatform();
		await __directCall('dc-nullwarn/action', [], platform);

		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining('.load() is calling guard')
		);
		spy.mockRestore();
	});

	it('does not warn when user is provided', async () => {
		const guardFn = (ctx) => {};
		guardFn.__isGuard = true;
		__registerGuard('dc-nowarn', guardFn);

		const handler = live(async (ctx) => 'ok');
		__register('dc-nowarn/action', handler);

		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const platform = mockPlatform();
		await __directCall('dc-nowarn/action', [], platform, { user: { id: 1 } });

		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
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

	describe('ctx and auto-publish', () => {
		afterEach(() => {
			_clearCron();
		});

		it('passes ctx with publish to cron function', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let receivedCtx = null;
			const fn = live.cron('* * * * *', 'test-topic', async (ctx) => {
				receivedCtx = ctx;
			});
			__registerCron('test/ctx-cron', fn);
			await _tickCron();
			expect(receivedCtx).not.toBeNull();
			expect(typeof receivedCtx.publish).toBe('function');
			expect(typeof receivedCtx.throttle).toBe('function');
			expect(typeof receivedCtx.debounce).toBe('function');
			expect(typeof receivedCtx.signal).toBe('function');
			expect(receivedCtx.platform).toBe(platform);
		});

		it('auto-publishes return value as set event', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const fn = live.cron('* * * * *', 'auto-topic', async () => {
				return { count: 42 };
			});
			__registerCron('test/auto-publish', fn);
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			const pub = platform.published.find(p => p.topic === 'auto-topic');
			expect(pub).toBeDefined();
			expect(pub.event).toBe('set');
			expect(pub.data).toEqual({ count: 42 });
		});

		it('skips auto-publish when function returns undefined', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const fn = live.cron('* * * * *', 'skip-topic', async (ctx) => {
				ctx.publish('skip-topic', 'deleted', { id: 1 });
				// return undefined -> no auto-publish
			});
			__registerCron('test/skip-publish', fn);
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			const pubs = platform.published.filter(p => p.topic === 'skip-topic');
			expect(pubs).toHaveLength(1);
			expect(pubs[0].event).toBe('deleted');
			expect(pubs[0].data).toEqual({ id: 1 });
		});

		it('ctx.publish works for crud-style events', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const fn = live.cron('* * * * *', 'boards', async (ctx) => {
				ctx.publish('boards', 'deleted', { board_id: 'a' });
				ctx.publish('boards', 'deleted', { board_id: 'b' });
			});
			__registerCron('test/crud-cron', fn);
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			const pubs = platform.published.filter(p => p.topic === 'boards');
			expect(pubs).toHaveLength(2);
			expect(pubs[0]).toEqual({ topic: 'boards', event: 'deleted', data: { board_id: 'a' }, options: undefined });
			expect(pubs[1]).toEqual({ topic: 'boards', event: 'deleted', data: { board_id: 'b' }, options: undefined });
		});

		it('backwards compatible -- no-arg cron still works', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const fn = live.cron('* * * * *', 'compat-topic', async () => {
				return 'hello';
			});
			__registerCron('test/compat', fn);
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			const pub = platform.published.find(p => p.topic === 'compat-topic');
			expect(pub).toBeDefined();
			expect(pub.event).toBe('set');
			expect(pub.data).toBe('hello');
		});
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
	it('does not fire onUnsubscribe when socket was not subscribed to the topic', () => {
		let fired = false;
		const streamFn = live.stream('unrelated-topic', async (ctx) => [], {
			merge: 'crud',
			key: 'id',
			onUnsubscribe() { fired = true; }
		});
		__register('close/unrelated', streamFn);

		const ws = mockWs();
		// ws is NOT subscribed to 'unrelated-topic'
		const platform = mockPlatform();

		close(ws, { platform });

		expect(fired).toBe(false);
	});

	it('fires onUnsubscribe for dynamic topic streams when socket has matching topics', async () => {
		let firedTopics = [];
		const topicFn = (ctx, roomId) => `room-${roomId}`;
		const streamFn = live.stream(topicFn, async (ctx) => [], {
			merge: 'crud',
			key: 'id',
			onUnsubscribe(ctx, topic) { firedTopics.push(topic); }
		});
		__register('close/dynamic', streamFn);

		const ws = mockWs();
		const platform = mockPlatform();

		// Subscribe through the RPC path so dynamic subscriptions are tracked
		handleRpc(ws, toArrayBuffer({ rpc: 'close/dynamic', id: 'd1', args: ['abc'], stream: true }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'close/dynamic', id: 'd2', args: ['def'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		ws.subscribe('__signal:u1'); // internal topic, should be skipped

		close(ws, { platform });
		await new Promise(r => setTimeout(r, 0));

		expect(firedTopics).toContain('room-abc');
		expect(firedTopics).toContain('room-def');
		expect(firedTopics).not.toContain('__signal:u1');
	});

	it('does not fire onUnsubscribe for unrelated dynamic streams', async () => {
		let firedA = [];
		let firedB = [];
		const streamA = live.stream((ctx, id) => `chat-${id}`, async () => [], {
			merge: 'crud', key: 'id',
			onUnsubscribe(ctx, topic) { firedA.push(topic); }
		});
		const streamB = live.stream((ctx, id) => `presence-${id}`, async () => [], {
			merge: 'crud', key: 'id',
			onUnsubscribe(ctx, topic) { firedB.push(topic); }
		});
		__register('close/chatA', streamA);
		__register('close/presB', streamB);

		const ws = mockWs();
		const platform = mockPlatform();

		// Subscribe chat stream only
		handleRpc(ws, toArrayBuffer({ rpc: 'close/chatA', id: 'c1', args: ['123'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		close(ws, { platform });
		await new Promise(r => setTimeout(r, 0));

		expect(firedA).toEqual(['chat-123']);
		expect(firedB).toEqual([]);
	});

	it('fires onUnsubscribe for static topic streams on close', async () => {
		let unsubTopic;
		const streamFn = live.stream('close-topic', async (ctx) => [], {
			merge: 'crud',
			key: 'id',
			onUnsubscribe(ctx, topic) { unsubTopic = topic; }
		});
		__register('close/items', streamFn);

		const ws = mockWs();
		ws.subscribe('close-topic');
		const platform = mockPlatform();

		close(ws, { platform });
		await new Promise(r => setTimeout(r, 0));

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

	it('ctx.signal is available in binary path', async () => {
		let capturedSignal;
		const handler = live.binary(async (ctx, buffer) => {
			capturedSignal = ctx.signal;
			return { ok: true };
		});
		__register('bin/sigtest', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		const header = JSON.stringify({ rpc: 'bin/sigtest', id: 'bns1' });
		const headerBytes = new TextEncoder().encode(header);
		const payload = new Uint8Array([0x01]);
		const frame = new Uint8Array(3 + headerBytes.length + payload.length);
		frame[0] = 0x00;
		frame[1] = (headerBytes.length >> 8) & 0xFF;
		frame[2] = headerBytes.length & 0xFF;
		frame.set(headerBytes, 3);
		frame.set(payload, 3 + headerBytes.length);

		handleRpc(ws, frame.buffer, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(typeof capturedSignal).toBe('function');
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
	it('owner() checks ctx.user[field] is present', () => {
		const filter = live.access.owner('id');
		expect(filter({ user: { id: 'u1' } })).toBe(true);
		expect(filter({ user: {} })).toBe(false);
		expect(filter({ user: null })).toBe(false);
	});

	it('owner() defaults to "id" field', () => {
		const filter = live.access.owner();
		expect(filter({ user: { id: 'u1' } })).toBe(true);
		expect(filter({ user: {} })).toBe(false);
	});

	it('role() checks ctx.user.role in map', () => {
		const filter = live.access.role({
			admin: true,
			viewer: (ctx) => ctx.user.level >= 2
		});
		expect(filter({ user: { role: 'admin' } })).toBe(true);
		expect(filter({ user: { role: 'viewer', level: 3 } })).toBe(true);
		expect(filter({ user: { role: 'viewer', level: 1 } })).toBe(false);
		expect(filter({ user: { role: 'guest' } })).toBe(false);
		expect(filter({ user: {} })).toBe(false);
	});

	it('team() checks ctx.user.teamId is present', () => {
		const filter = live.access.team();
		expect(filter({ user: { teamId: 't1' } })).toBe(true);
		expect(filter({ user: {} })).toBe(false);
	});

	it('any() returns true if any predicate matches', () => {
		const filter = live.access.any(
			live.access.owner(),
			live.access.role({ admin: true })
		);
		expect(filter({ user: { id: 'u1' } })).toBe(true);
		expect(filter({ user: { role: 'admin' } })).toBe(true);
		expect(filter({ user: { role: 'viewer' } })).toBe(false);
	});

	it('all() returns true only if all predicates match', () => {
		const filter = live.access.all(
			live.access.owner(),
			live.access.role({ admin: true })
		);
		expect(filter({ user: { id: 'u1', role: 'admin' } })).toBe(true);
		expect(filter({ user: { id: 'u1', role: 'viewer' } })).toBe(false);
	});
});

// -- Phase 26/32: live.stream with filter/access option ----------------------

describe('live.stream() with filter/access', () => {
	it('stores filter function from filter option', () => {
		const filterFn = (ctx) => true;
		const fn = live.stream('filtered', async () => [], { filter: filterFn });
		expect(fn.__streamFilter).toBe(filterFn);
	});

	it('stores filter function from access option (alias)', () => {
		const accessFn = live.access.owner();
		const fn = live.stream('accessed', async () => [], { access: accessFn });
		expect(fn.__streamFilter).toBe(accessFn);
	});

	it('access takes priority over filter', () => {
		const accessFn = (ctx) => true;
		const filterFn = (ctx) => false;
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

import { __registerDerived, _activateDerived, _prepareHmr } from '../server.js';

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

// -- Dynamic live.derived() --------------------------------------------------

describe('dynamic live.derived()', () => {
	it('marks function with __derivedDynamic and __derivedSourceFactory', () => {
		const sourceFactory = (orgId) => [`members:${orgId}`, `emails:${orgId}`];
		const fn = live.derived(sourceFactory, async (ctx, orgId) => ({ total: 0 }));
		expect(fn.__isDerived).toBe(true);
		expect(fn.__isStream).toBe(true);
		expect(fn.__isLive).toBe(true);
		expect(fn.__derivedDynamic).toBe(true);
		expect(fn.__derivedSourceFactory).toBe(sourceFactory);
		expect(fn.__derivedSources).toBeUndefined();
		expect(fn.__streamOptions.merge).toBe('set');
	});

	it('generates a function topic instead of a string', () => {
		const fn = live.derived(
			(orgId) => [`members:${orgId}`],
			async (ctx, orgId) => ({ count: 0 })
		);
		expect(typeof fn.__streamTopic).toBe('function');
		const resolved = fn.__streamTopic('org_123');
		expect(typeof resolved).toBe('string');
		expect(resolved).toContain('org_123');
	});

	it('different args produce different topics', () => {
		const fn = live.derived(
			(orgId) => [`members:${orgId}`],
			async (ctx, orgId) => ({ count: 0 })
		);
		const t1 = fn.__streamTopic('org_1');
		const t2 = fn.__streamTopic('org_2');
		expect(t1).not.toBe(t2);
	});

	it('avoids topic collision when args contain separator characters', () => {
		const fn = live.derived(
			(a, b) => [`src:${a}:${b}`],
			async (ctx, a, b) => ({ a, b })
		);
		const t1 = fn.__streamTopic('org:123', 'feature');
		const t2 = fn.__streamTopic('org', '123:feature');
		expect(t1).not.toBe(t2);
	});

	it('sets __onSubscribe and __onUnsubscribe hooks', () => {
		const fn = live.derived(
			(orgId) => [`members:${orgId}`],
			async (ctx, orgId) => ({ count: 0 })
		);
		expect(typeof fn.__onSubscribe).toBe('function');
		expect(typeof fn.__onUnsubscribe).toBe('function');
	});

	it('accepts custom debounce', () => {
		const fn = live.derived(
			(orgId) => [`members:${orgId}`],
			async (ctx, orgId) => [],
			{ debounce: 300 }
		);
		expect(fn.__derivedDebounce).toBe(300);
	});
});

describe('dynamic derived activation', () => {
	it('recomputes when resolved source publishes', async () => {
		let callCount = 0;
		const fn = live.derived(
			(orgId) => [`members:${orgId}`],
			async (ctx, orgId) => {
				callCount++;
				return { orgId, count: callCount };
			}
		);

		__registerDerived('test/dynamicDerived', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		// Resolve the topic (simulates what _callTopicFn does during RPC)
		const resolvedTopic = fn.__streamTopic('org_42');

		// Activate the instance (simulates __onSubscribe hook)
		fn.__onSubscribe({}, resolvedTopic);

		// Publish on the resolved source
		platform.publish('members:org_42', 'created', { id: 1 });

		await new Promise(r => setTimeout(r, 30));

		const derivedPubs = platform.published.filter(p => p.topic === resolvedTopic);
		expect(derivedPubs.length).toBeGreaterThanOrEqual(1);
		const last = derivedPubs[derivedPubs.length - 1];
		expect(last.event).toBe('set');
		expect(last.data.orgId).toBe('org_42');
		expect(last.data.count).toBeGreaterThan(0);
	});

	it('multiple subscribers share one instance', async () => {
		let callCount = 0;
		const fn = live.derived(
			(orgId) => [`members:${orgId}`],
			async (ctx, orgId) => {
				callCount++;
				return { count: callCount };
			}
		);

		__registerDerived('test/dynamicDerivedShared', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		const resolvedTopic = fn.__streamTopic('org_shared');

		// Two subscribers activate for the same topic
		fn.__onSubscribe({}, resolvedTopic);
		fn.__onSubscribe({}, resolvedTopic);

		// First unsubscribe should not clean up (refCount > 0)
		fn.__onUnsubscribe({}, resolvedTopic);

		// Source publish should still trigger recomputation
		callCount = 0;
		platform.publish('members:org_shared', 'updated', {});

		await new Promise(r => setTimeout(r, 30));

		const derivedPubs = platform.published.filter(p => p.topic === resolvedTopic);
		expect(derivedPubs.length).toBeGreaterThanOrEqual(1);

		// Second unsubscribe cleans up
		fn.__onUnsubscribe({}, resolvedTopic);

		// Now the source topic should no longer trigger recomputation
		const pubsBefore = platform.published.filter(p => p.topic === resolvedTopic).length;
		platform.publish('members:org_shared', 'updated', {});
		await new Promise(r => setTimeout(r, 30));
		const pubsAfter = platform.published.filter(p => p.topic === resolvedTopic).length;
		expect(pubsAfter).toBe(pubsBefore);
	});

	it('different args create independent instances', async () => {
		let lastOrgId = null;
		const fn = live.derived(
			(orgId) => [`events:${orgId}`],
			async (ctx, orgId) => {
				lastOrgId = orgId;
				return { orgId };
			}
		);

		__registerDerived('test/dynamicDerivedIndependent', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		const topicA = fn.__streamTopic('A');
		const topicB = fn.__streamTopic('B');

		fn.__onSubscribe({}, topicA);
		fn.__onSubscribe({}, topicB);

		// Publishing to org A's source should only recompute A
		platform.publish('events:A', 'created', {});
		await new Promise(r => setTimeout(r, 30));

		const pubsA = platform.published.filter(p => p.topic === topicA && p.event === 'set');
		const pubsB = platform.published.filter(p => p.topic === topicB && p.event === 'set');
		expect(pubsA.length).toBeGreaterThanOrEqual(1);
		expect(pubsB.length).toBe(0);
	});

	it('debounces per-instance', async () => {
		let callCount = 0;
		const fn = live.derived(
			(orgId) => [`items:${orgId}`],
			async (ctx, orgId) => {
				callCount++;
				return { count: callCount };
			},
			{ debounce: 50 }
		);

		__registerDerived('test/dynamicDerivedDebounce', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		const topic = fn.__streamTopic('org_debounce');
		fn.__onSubscribe({}, topic);

		// Rapid-fire 5 publishes
		callCount = 0;
		for (let i = 0; i < 5; i++) {
			platform.publish('items:org_debounce', 'updated', {});
		}

		await new Promise(r => setTimeout(r, 120));

		const derivedPubs = platform.published.filter(p => p.topic === topic && p.event === 'set');
		// Should have debounced to a single recomputation
		expect(derivedPubs.length).toBe(1);
	});

	it('cleanup removes sources from _watchedTopics', async () => {
		const fn = live.derived(
			(orgId) => [`cleanup_src:${orgId}`],
			async (ctx, orgId) => ({ orgId })
		);

		__registerDerived('test/dynamicDerivedCleanup', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		const topic = fn.__streamTopic('org_cleanup');
		fn.__onSubscribe({}, topic);

		// Source topic should trigger recomputation
		platform.publish('cleanup_src:org_cleanup', 'updated', {});
		await new Promise(r => setTimeout(r, 30));
		const pubsBefore = platform.published.filter(p => p.topic === topic && p.event === 'set').length;
		expect(pubsBefore).toBeGreaterThanOrEqual(1);

		// Unsubscribe
		fn.__onUnsubscribe({}, topic);

		// Publishing to the same source should not trigger recomputation
		const totalBefore = platform.published.filter(p => p.topic === topic && p.event === 'set').length;
		platform.publish('cleanup_src:org_cleanup', 'updated', {});
		await new Promise(r => setTimeout(r, 30));
		const totalAfter = platform.published.filter(p => p.topic === topic && p.event === 'set').length;
		expect(totalAfter).toBe(totalBefore);
	});
});

describe('lazy __registerDerived sets _hasDynamicDerived', () => {
	it('_activateDerived wraps platform.publish when only lazy derived entries exist', async () => {
		const lazyLoader = async () => {
			return live.derived(
				(orgId) => [`lazy_src:${orgId}`],
				async (ctx, orgId) => ({ orgId })
			);
		};
		lazyLoader.__lazy = true;

		__registerDerived('test/lazyDerived', lazyLoader);

		const platform = mockPlatform();
		_activateDerived(platform);

		// platform.publish should have been wrapped (not the raw mock)
		// Verify by checking that the function is no longer the original
		expect(platform.publish.name).toBe('derivedPublish');
	});
});

describe('derived recomputation receives subscriber user data', () => {
	it('ctx.user is populated from the subscribing client during recomputation', async () => {
		let capturedUser = undefined;
		const fn = live.derived(
			(orgId) => [`user_src:${orgId}`],
			async (ctx, orgId) => {
				capturedUser = ctx.user;
				return { orgId };
			}
		);

		__registerDerived('test/derivedUser', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		const resolvedTopic = fn.__streamTopic('org_99');
		const fakeUser = { id: 'user_1', organization_id: 'org_99' };
		fn.__onSubscribe({ user: fakeUser }, resolvedTopic);

		platform.publish('user_src:org_99', 'updated', {});
		await new Promise(r => setTimeout(r, 30));

		expect(capturedUser).toEqual(fakeUser);
	});

	it('ctx.user is null when no user was provided at subscribe time', async () => {
		let capturedUser = undefined;
		const fn = live.derived(
			(orgId) => [`nulluser_src:${orgId}`],
			async (ctx, orgId) => {
				capturedUser = ctx.user;
				return { orgId };
			}
		);

		__registerDerived('test/derivedNullUser', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		const resolvedTopic = fn.__streamTopic('org_77');
		fn.__onSubscribe({}, resolvedTopic);

		platform.publish('nulluser_src:org_77', 'updated', {});
		await new Promise(r => setTimeout(r, 30));

		expect(capturedUser).toBeNull();
	});

	it('static derived recomputation still works without user context', async () => {
		let callCount = 0;
		const fn = live.derived(['static_user_src'], async () => {
			callCount++;
			return { count: callCount };
		});

		__registerDerived('test/staticDerivedNoUser', fn);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('static_user_src', 'updated', {});
		await new Promise(r => setTimeout(r, 30));

		const pubs = platform.published.filter(p => p.topic === fn.__streamTopic && p.event === 'set');
		expect(pubs.length).toBeGreaterThanOrEqual(1);
		expect(pubs[0].data.count).toBe(1);
	});
});

describe('missing _activateDerived warning', () => {
	it('warns in dev mode when derived stream is subscribed without _activateDerived', async () => {
		_prepareHmr();

		const derivedFn = live.derived(['warn_src'], async () => ({ ok: true }));
		__register('test/warnDerived', derivedFn);
		__registerDerived('test/warnDerived', derivedFn);

		const ws = mockWs({ id: 'warn_user' });
		const platform = mockPlatform();

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const buf = toArrayBuffer({ rpc: 'test/warnDerived', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise(r => setTimeout(r, 30));

		const derivedWarnings = warnSpy.mock.calls.filter(
			c => typeof c[0] === 'string' && c[0].includes('_activateDerived')
		);
		expect(derivedWarnings.length).toBe(1);
		expect(derivedWarnings[0][0]).toContain('live.derived()');

		warnSpy.mockRestore();
	});

	it('does not warn when _activateDerived was called', async () => {
		_prepareHmr();

		const derivedFn = live.derived(['nowarn_src'], async () => ({ ok: true }));
		__register('test/noWarnDerived', derivedFn);
		__registerDerived('test/noWarnDerived', derivedFn);

		const ws = mockWs({ id: 'nowarn_user' });
		const platform = mockPlatform();
		_activateDerived(platform);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const buf = toArrayBuffer({ rpc: 'test/noWarnDerived', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise(r => setTimeout(r, 30));

		const derivedWarnings = warnSpy.mock.calls.filter(
			c => typeof c[0] === 'string' && c[0].includes('_activateDerived')
		);
		expect(derivedWarnings.length).toBe(0);

		warnSpy.mockRestore();
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
			},
			topicArgs: 1
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

	it('responds immediately via handleRpc with empty data and channel flag', async () => {
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
		expect(platform.sent[0].data.channel).toBe(true);
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
		expect(platform.sent[0].data.channel).toBe(true);
	});
});

// -- derived stream RPC response -----------------------------------------------

describe('derived stream handleRpc response', () => {
	it('includes derived: true in the response', async () => {
		const derivedFn = live.derived(['source1'], async () => {
			return { total: 99 };
		});
		__register('test/derivedRpc', derivedFn);
		__registerDerived('test/derivedRpc', derivedFn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const buf = toArrayBuffer({ rpc: 'test/derivedRpc', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent.length).toBe(1);
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual({ total: 99 });
		expect(platform.sent[0].data.derived).toBe(true);
	});

	it('uses stream path as topic instead of __derived: prefix', async () => {
		const derivedFn = live.derived(['src'], async () => ({ v: 1 }));

		// Before registration, topic uses the auto-generated __derived: prefix
		expect(derivedFn.__streamTopic).toMatch(/^__derived:/);

		__register('test/derivedTopic', derivedFn);
		__registerDerived('test/derivedTopic', derivedFn);

		// After registration, topic is overridden to the stream path
		expect(derivedFn.__streamTopic).toBe('test/derivedTopic');

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const buf = toArrayBuffer({ rpc: 'test/derivedTopic', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.topic).toBe('test/derivedTopic');
	});

	it('dynamic derived uses path-based topic with args', async () => {
		const derivedFn = live.derived(
			(orgId) => [`src:${orgId}`],
			async (ctx, orgId) => ({ orgId })
		);
		__register('test/dynamicTopic', derivedFn);
		__registerDerived('test/dynamicTopic', derivedFn);

		const resolved = derivedFn.__streamTopic('org_99');
		expect(resolved).toContain('test/dynamicTopic');
		expect(resolved).toContain('org_99');
		expect(resolved).not.toContain('__derived');
	});

	it('non-derived stream does not include derived flag', async () => {
		const fn = live.stream('test/regularTopic', async () => [{ id: 1 }], { merge: 'crud', key: 'id' });
		__register('test/regularStream', fn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const buf = toArrayBuffer({ rpc: 'test/regularStream', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent.length).toBe(1);
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.derived).toBeUndefined();
	});

	it('non-derived stream with __ prefix is still rejected', async () => {
		const fn = async () => [{ id: 1 }];
		fn.__isStream = true;
		fn.__isLive = true;
		fn.__streamTopic = '__internal:secret';
		fn.__streamOptions = { merge: 'crud', key: 'id' };
		__register('test/reservedTopic', fn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const buf = toArrayBuffer({ rpc: 'test/reservedTopic', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
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

	it('gate is enforced in batch (single-rpc) execution path', async () => {
		const stream = live.stream('batch-gate-feed', async (ctx) => [{ id: 1 }], { merge: 'crud' });
		const gated = live.gate((ctx) => false, stream);
		__register('bgate/feed', gated);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({
			batch: [
				{ rpc: 'bgate/feed', id: 'bg1', args: [], stream: true }
			]
		});
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const batch = platform.sent[0]?.data?.batch;
		expect(batch).toBeDefined();
		expect(batch[0].ok).toBe(true);
		expect(batch[0].data).toBeNull();
		expect(batch[0].gated).toBe(true);
	});
});

// -- Stream filter/access enforcement -----------------------------------------

describe('stream filter/access', () => {
	it('denies subscription when filter returns false', async () => {
		const stream = live.stream('secret-feed', async (ctx) => [{ id: 1 }], {
			merge: 'crud',
			key: 'id',
			access: (ctx) => ctx.user?.admin === true
		});
		__register('filtered/feed', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'filtered/feed', id: 'f1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(false);
		expect(response.code).toBe('FORBIDDEN');
		expect(response.error).toBe('Access denied');
		expect(ws.isSubscribed('secret-feed')).toBe(false);
	});

	it('allows subscription when filter returns true', async () => {
		const stream = live.stream('open-feed', async (ctx) => [{ id: 1 }], {
			merge: 'crud',
			key: 'id',
			access: (ctx) => ctx.user?.admin === true
		});
		__register('filtered/open', stream);

		const ws = mockWs({ id: 'u1', admin: true });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'filtered/open', id: 'f2', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data).toEqual([{ id: 1 }]);
		expect(ws.isSubscribed('open-feed')).toBe(true);
	});

	it('filter/access is also enforced in batch path', async () => {
		const stream = live.stream('batch-secret', async (ctx) => [{ id: 1 }], {
			merge: 'crud',
			key: 'id',
			filter: (ctx) => false
		});
		__register('bfilter/secret', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({
			batch: [
				{ rpc: 'bfilter/secret', id: 'bf1', args: [], stream: true }
			]
		});
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const batch = platform.sent[0]?.data?.batch;
		expect(batch[0].ok).toBe(false);
		expect(batch[0].code).toBe('FORBIDDEN');
		expect(batch[0].error).toBe('Access denied');
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

// -- 0.4.0: unsubscribe() hook ------------------------------------------------

describe('unsubscribe()', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'u1' });
		platform = mockPlatform();
	});

	it('fires onUnsubscribe on explicit topic unsubscribe', async () => {
		const unsubSpy = vi.fn();
		const stream = live.stream('items', async () => [{ id: 1 }], { onUnsubscribe: unsubSpy });
		__register('unsub/items', stream);

		// Subscribe via RPC
		const data = toArrayBuffer({ rpc: 'unsub/items', id: 'u1', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		// Real-time unsubscribe for the topic
		unsubscribe(ws, 'items', { platform });
		await new Promise(r => setTimeout(r, 0));
		expect(unsubSpy).toHaveBeenCalledTimes(1);
		expect(unsubSpy.mock.calls[0][1]).toBe('items');
	});

	it('close() does not double-fire after real-time unsubscribe', async () => {
		const unsubSpy = vi.fn();
		const stream = live.stream('items2', async () => [{ id: 1 }], { onUnsubscribe: unsubSpy });
		__register('unsub/items2', stream);

		const data = toArrayBuffer({ rpc: 'unsub/items2', id: 'u2', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		// Fire real-time unsubscribe, then close
		unsubscribe(ws, 'items2', { platform });
		await new Promise(r => setTimeout(r, 0));
		close(ws, { platform, subscriptions: new Set(['items2']) });
		await new Promise(r => setTimeout(r, 0));

		// Should only have been called once (by unsubscribe, not again by close)
		expect(unsubSpy).toHaveBeenCalledTimes(1);
	});

	it('close() still fires for topics not unsubscribed via unsubscribe()', async () => {
		const unsubSpy = vi.fn();
		const stream = live.stream('items3', async () => [{ id: 1 }], { onUnsubscribe: unsubSpy });
		__register('unsub/items3', stream);

		const data = toArrayBuffer({ rpc: 'unsub/items3', id: 'u3', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		// Close without prior unsubscribe
		close(ws, { platform, subscriptions: new Set(['items3']) });
		await new Promise(r => setTimeout(r, 0));
		expect(unsubSpy).toHaveBeenCalledTimes(1);
	});
});

// -- 0.4.0: close() with ctx.subscriptions ------------------------------------

describe('close() with ctx.subscriptions', () => {
	it('uses subscriptions Set from ctx instead of ws.getTopics()', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const unsubSpy = vi.fn();
		const stream = live.stream('closetopic', async () => [{ id: 1 }], { onUnsubscribe: unsubSpy });
		__register('closet/items', stream);

		const data = toArrayBuffer({ rpc: 'closet/items', id: 'c1', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		// Pass subscriptions as a Set (adapter 0.4.0 style)
		close(ws, { platform, subscriptions: new Set(['closetopic']) });
		await new Promise(r => setTimeout(r, 0));
		expect(unsubSpy).toHaveBeenCalledTimes(1);
	});
});

// -- 0.4.0: ctx.batch ---------------------------------------------------------

describe('ctx.batch', () => {
	it('ctx.batch calls platform.batch with messages', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const batchSpy = vi.spyOn(platform, 'batch');

		let capturedBatch;
		const handler = live(async (ctx) => {
			capturedBatch = ctx.batch;
			ctx.batch([
				{ topic: 't1', event: 'set', data: 1 },
				{ topic: 't2', event: 'set', data: 2 }
			]);
			return 'ok';
		});
		__register('batchtest/run', handler);

		const data = toArrayBuffer({ rpc: 'batchtest/run', id: 'b1', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(typeof capturedBatch).toBe('function');
		expect(batchSpy).toHaveBeenCalledTimes(1);
		expect(batchSpy.mock.calls[0][0]).toHaveLength(2);
	});
});

// -- 0.4.0: live.breaker() ----------------------------------------------------

describe('live.breaker()', () => {
	it('returns fallback when circuit is open', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();

		const openBreaker = { isOpen: () => true, success: vi.fn(), failure: vi.fn() };
		const stream = live.stream('breaker-topic', live.breaker(
			{ breaker: openBreaker, fallback: [] },
			async () => [{ id: 1, name: 'should not reach' }]
		));
		__register('breaker/items', stream);

		const data = toArrayBuffer({ rpc: 'breaker/items', id: 'br1', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.data).toEqual([]);
	});

	it('throws SERVICE_UNAVAILABLE when circuit is open and no fallback', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();

		const openBreaker = { isOpen: () => true, success: vi.fn(), failure: vi.fn() };
		const handler = live(live.breaker({ breaker: openBreaker }, async () => 'ok'));
		__register('breaker/nofb', handler);

		const data = toArrayBuffer({ rpc: 'breaker/nofb', id: 'br2', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(false);
		expect(response.code).toBe('SERVICE_UNAVAILABLE');
	});

	it('calls success() on successful execution', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();

		const breaker = { isOpen: () => false, success: vi.fn(), failure: vi.fn() };
		const handler = live(live.breaker({ breaker }, async () => 'ok'));
		__register('breaker/ok', handler);

		const data = toArrayBuffer({ rpc: 'breaker/ok', id: 'br3', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(breaker.success).toHaveBeenCalledTimes(1);
		expect(breaker.failure).not.toHaveBeenCalled();
	});
});

// -- 0.4.0: live.room() .hooks property ---------------------------------------

describe('live.room() .hooks', () => {
	it('room export has a .hooks property with message, close, unsubscribe', () => {
		const room = live.room({
			topic: (ctx) => 'room:test',
			init: async () => []
		});

		expect(room.hooks).toBeDefined();
		expect(typeof room.hooks.message).toBe('function');
		expect(typeof room.hooks.close).toBe('function');
		expect(typeof room.hooks.unsubscribe).toBe('function');
	});
});

// -- live.validated() rejects unrecognized schemas ----------------------------

describe('live.validated() schema rejection', () => {
	it('rejects calls when schema type is unrecognized', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const handler = live.validated({ notASchema: true }, async (ctx, input) => input);
		__register('val/bad', handler);

		const data = toArrayBuffer({ rpc: 'val/bad', id: 'v1', args: ['test'] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(false);
		expect(response.code).toBe('VALIDATION');
	});
});

// -- throttle/debounce per-entity keying --------------------------------------

describe('throttle per-entity keying', () => {
	it('does not collapse throttled publishes for different data.key values', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();

		let capturedCtx;
		const handler = live(async (ctx) => {
			capturedCtx = ctx;
			ctx.throttle('cursors', 'update', { key: 'user1', x: 10 }, 100);
			ctx.throttle('cursors', 'update', { key: 'user2', x: 20 }, 100);
			return 'ok';
		});
		__register('thr/multi', handler);

		const data = toArrayBuffer({ rpc: 'thr/multi', id: 't1', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		// Both publishes should have gone through (different entity keys)
		const cursorPublishes = platform.published.filter(p => p.topic === 'cursors');
		expect(cursorPublishes.length).toBe(2);
		expect(cursorPublishes[0].data.key).toBe('user1');
		expect(cursorPublishes[1].data.key).toBe('user2');
	});
});

// -- live.metrics() -----------------------------------------------------------

describe('live.metrics()', () => {
	it('is a function on the live namespace', () => {
		expect(typeof live.metrics).toBe('function');
	});

	it('instruments RPC calls with counter and histogram', async () => {
		const counters = {};
		const histograms = {};
		const gauges = {};
		const registry = {
			counter(opts) { const vals = []; counters[opts.name] = vals; return { inc(labels) { vals.push(labels); } }; },
			histogram(opts) { const vals = []; histograms[opts.name] = vals; return { observe(labels, v) { vals.push({ ...labels, v }); } }; },
			gauge(opts) { const g = { val: 0 }; gauges[opts.name] = g; return { inc() { g.val++; }, dec() { g.val--; } }; }
		};
		live.metrics(registry);

		const ws = mockWs({ id: 'metrics-user' });
		const platform = mockPlatform();
		const fn = live(async () => 'hello');
		__register('metrics/echo', fn);

		handleRpc(ws, toArrayBuffer({ rpc: 'metrics/echo', id: 'm1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const rpcCounts = counters['svelte_realtime_rpc_total'];
		expect(rpcCounts.length).toBeGreaterThan(0);
		expect(rpcCounts.some(l => l.path === 'metrics/echo' && l.status === 'ok')).toBe(true);

		const durations = histograms['svelte_realtime_rpc_duration_seconds'];
		expect(durations.length).toBeGreaterThan(0);
		expect(durations.some(l => l.path === 'metrics/echo')).toBe(true);

		// Reset so other tests are not affected
		live.metrics({ counter: () => ({ inc() {} }), histogram: () => ({ observe() {} }), gauge: () => ({ inc() {}, dec() {} }) });
	});

	it('increments stream gauge on subscribe', async () => {
		let gaugeVal = 0;
		const registry = {
			counter() { return { inc() {} }; },
			histogram() { return { observe() {} }; },
			gauge() { return { inc() { gaugeVal++; }, dec() { gaugeVal--; } }; }
		};
		live.metrics(registry);

		const ws = mockWs({ id: 'metrics-stream-user' });
		const platform = mockPlatform();
		const stream = live.stream('metrics-items', async () => []);
		__register('metrics/items', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'metrics/items', id: 'ms1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(gaugeVal).toBeGreaterThanOrEqual(1);

		// Reset
		live.metrics({ counter: () => ({ inc() {} }), histogram: () => ({ observe() {} }), gauge: () => ({ inc() {}, dec() {} }) });
	});
});

// -- onError / onCronError alias ----------------------------------------------

describe('onError()', () => {
	it('is exported as a function', () => {
		expect(typeof onError).toBe('function');
	});

	it('onCronError is an alias for onError', () => {
		expect(typeof onCronError).toBe('function');
	});
});

// -- _copyStreamMeta via live.gate and pipe -----------------------------------

describe('metadata propagation', () => {
	it('live.gate copies all stream metadata including version and migrate', () => {
		const initFn = async () => [];
		const stream = live.stream('meta-test', initFn, {
			merge: 'crud',
			key: 'uid',
			replay: { size: 100 },
			version: 3,
			migrate: { 2: (item) => item }
		});

		const gated = live.gate(() => true, stream);
		expect(gated.__isStream).toBe(true);
		expect(gated.__streamTopic).toBe('meta-test');
		expect(gated.__streamOptions.merge).toBe('crud');
		expect(gated.__replay).toEqual({ size: 100 });
		expect(gated.__streamVersion).toBe(3);
		expect(gated.__streamMigrate).toBeDefined();
		expect(gated.__isGated).toBe(true);
	});

	it('pipe copies all stream metadata', () => {
		const initFn = async () => [];
		const stream = live.stream('pipe-meta', initFn, {
			merge: 'crud',
			key: 'id',
			access: (ctx) => true
		});

		const piped = pipe(stream, pipe.limit(10));
		expect(piped.__isStream).toBe(true);
		expect(piped.__streamTopic).toBe('pipe-meta');
		expect(piped.__streamFilter).toBeDefined();
	});
});

// -- __directCall access/filter/gate enforcement ------------------------------

describe('__directCall stream enforcement', () => {
	it('returns null for gated streams when predicate fails', async () => {
		const stream = live.stream('dc-gate-topic', async (ctx) => [{ id: 1 }], { merge: 'crud' });
		const gated = live.gate(() => false, stream);
		__register('dcgate/feed', gated);

		const platform = mockPlatform();
		const result = await __directCall('dcgate/feed', [], platform);
		expect(result).toBeNull();
	});

	it('throws FORBIDDEN when stream filter rejects', async () => {
		const stream = live.stream('dc-filter-topic', async (ctx) => [{ id: 1 }], {
			merge: 'crud',
			access: (ctx) => ctx.user?.admin === true
		});
		__register('dcfilter/feed', stream);

		const platform = mockPlatform();
		await expect(__directCall('dcfilter/feed', [], platform)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
	});

	it('allows gated stream when predicate passes', async () => {
		const stream = live.stream('dc-gate-ok', async (ctx) => [{ id: 1 }], { merge: 'crud' });
		const gated = live.gate(() => true, stream);
		__register('dcgate/ok', gated);

		const platform = mockPlatform();
		const result = await __directCall('dcgate/ok', [], platform);
		expect(result).toEqual([{ id: 1 }]);
	});
});

// -- Room guard enforcement on presence/cursor sub-streams --------------------

describe('room guard on sub-streams', () => {
	it('presence stream runs guard and rejects unauthorized access', async () => {
		const calls = [];
		const room = live.room({
			topic: (ctx, roomId) => 'guarded-room:' + roomId,
			init: async (ctx, roomId) => [],
			presence: (ctx) => ({ name: 'test' }),
			guard: async (ctx) => {
				calls.push('guard');
				throw new LiveError('FORBIDDEN', 'No access');
			}
		});

		__register('roomguard/myroom/__presence', room.__presenceStream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'roomguard/myroom/__presence', id: 'rg1', args: ['room1'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toContain('guard');
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(false);
		expect(response.code).toBe('FORBIDDEN');
	});

	it('cursor stream runs guard and rejects unauthorized access', async () => {
		const room = live.room({
			topic: (ctx, roomId) => 'cursor-guard-room:' + roomId,
			init: async (ctx, roomId) => [],
			cursors: true,
			guard: async (ctx) => {
				throw new LiveError('FORBIDDEN', 'No access');
			}
		});

		__register('roomguard/cursors/__cursors', room.__cursorStream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'roomguard/cursors/__cursors', id: 'rc1', args: ['room1'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(false);
		expect(response.code).toBe('FORBIDDEN');
	});
});

// -- Topic function ctx handling -----------------------------------------------

describe('topic function ctx handling', () => {
	it('no-ctx topic fn resolves correctly', async () => {
		let receivedArg;
		const stream = live.stream(
			(boardId) => {
				receivedArg = boardId;
				return 'notes/' + boardId;
			},
			async (ctx) => [{ id: 1 }],
			{ merge: 'crud' }
		);
		__register('topicfn/noctx', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/noctx', id: 'tn1', args: ['board42'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('notes/board42');
		expect(receivedArg).toBe('board42');
	});

	it('ctx-only topic fn (zero user args) resolves correctly', async () => {
		let receivedCtx;
		const stream = live.stream(
			(ctx) => {
				receivedCtx = ctx;
				return 'user:' + ctx.user.id;
			},
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/ctxonly', stream);

		const ws = mockWs({ id: 'u5' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/ctxonly', id: 'tc1', args: [], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('user:u5');
		expect(receivedCtx).toBeDefined();
		expect(receivedCtx.user.id).toBe('u5');
	});

	it('ctx + args topic fn (standard pattern) resolves correctly', async () => {
		let receivedCtx, receivedRoom;
		const stream = live.stream(
			(ctx, roomId) => {
				receivedCtx = ctx;
				receivedRoom = roomId;
				return 'room:' + roomId;
			},
			async (ctx) => [{ id: 1 }],
			{ merge: 'crud' }
		);
		__register('topicfn/ctxargs', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/ctxargs', id: 'ta1', args: ['lobby'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('room:lobby');
		expect(receivedCtx.user.id).toBe('u1');
		expect(receivedRoom).toBe('lobby');
	});

	it('room topic with default param always receives ctx', async () => {
		let receivedCtx;
		const room = live.room({
			topic: (ctx, roomId = 'default') => {
				receivedCtx = ctx;
				return 'room:' + roomId;
			},
			init: async (ctx, roomId) => [{ id: 1 }]
		});
		__register('topicfn/roomdef/__data', room.__dataStream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/roomdef/__data', id: 'rd1', args: ['myroom'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('room:myroom');
		expect(receivedCtx).toBeDefined();
		expect(receivedCtx.user).toBeDefined();
	});

	it('no-ctx channel topic resolves correctly', async () => {
		let receivedArg;
		const ch = live.channel(
			(docId) => {
				receivedArg = docId;
				return 'cursors:' + docId;
			},
			{ merge: 'cursor' }
		);
		__register('topicfn/channel', ch);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/channel', id: 'ch1', args: ['doc99'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('cursors:doc99');
		expect(receivedArg).toBe('doc99');
	});
});

// -- Cron field validation ----------------------------------------------------

describe('cron field validation', () => {
	it('rejects */0 step', () => {
		expect(() => __registerCron('cron/bad0', live.cron('*/0 * * * *', 'bad', async () => {})))
			.toThrow('step must be a positive integer');
	});

	it('rejects non-numeric step', () => {
		expect(() => __registerCron('cron/badfoo', live.cron('*/foo * * * *', 'bad', async () => {})))
			.toThrow('step must be a positive integer');
	});

	it('rejects out-of-range minute', () => {
		expect(() => __registerCron('cron/big', live.cron('99 * * * *', 'bad', async () => {})))
			.toThrow('must be 0-59');
	});

	it('rejects out-of-range hour', () => {
		expect(() => __registerCron('cron/bighour', live.cron('0 25 * * *', 'bad', async () => {})))
			.toThrow('must be 0-23');
	});

	it('accepts valid cron expressions', () => {
		expect(() => __registerCron('cron/valid', live.cron('*/5 0-12 1,15 1-6 0', 'ok', async () => {})))
			.not.toThrow();
	});
});

// -- ctx.throttle / ctx.debounce via RPC --------------------------------------

describe('ctx.throttle and ctx.debounce', () => {
	it('throttle publishes immediately on first call', async () => {
		const handler = live(async (ctx, text) => {
			ctx.throttle('throttle-topic', 'updated', { text }, 1000);
			return 'ok';
		});
		__register('thr/send', handler);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'thr/send', id: 'th1', args: ['hello'] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const pub = platform.published.find(p => p.topic === 'throttle-topic');
		expect(pub).toBeDefined();
		expect(pub.data).toEqual({ text: 'hello' });
	});

	it('debounce delays publish until silence', async () => {
		const handler = live(async (ctx, text) => {
			ctx.debounce('debounce-topic', 'updated', { text }, 50);
			return 'ok';
		});
		__register('deb/send', handler);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'deb/send', id: 'db1', args: ['world'] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		// Not yet published (debounce pending)
		expect(platform.published.find(p => p.topic === 'debounce-topic')).toBeUndefined();

		await new Promise((r) => setTimeout(r, 80));
		// Now published after debounce window
		const pub = platform.published.find(p => p.topic === 'debounce-topic');
		expect(pub).toBeDefined();
		expect(pub.data).toEqual({ text: 'world' });
	});
});

// -- Room action _guard enforcement -------------------------------------------

describe('room action _guard enforcement', () => {
	it('file-level guard runs before room action via __register modulePath', async () => {
		const order = [];
		const guardFn = (ctx) => { order.push('file-guard'); throw new LiveError('FORBIDDEN', 'No access'); };
		guardFn.__isGuard = true;
		__registerGuard('guarded_room', guardFn);

		const room = live.room({
			topic: (ctx, roomId) => 'gr:' + roomId,
			init: async (ctx) => [],
			actions: {
				send: async (ctx, text) => { order.push('action'); return 'ok'; }
			},
			topicArgs: 1
		});

		// Simulate what _resolveAllLazy does for room actions
		for (const [k, v] of Object.entries(room.__actions)) {
			__register('guarded_room/myRoom/__action/' + k, v, 'guarded_room');
		}

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'guarded_room/myRoom/__action/send', id: 'ra1', args: ['hello'] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(false);
		expect(response.code).toBe('FORBIDDEN');
		expect(order).toEqual(['file-guard']);
	});
});

// -- Room action rate-limit path isolation ------------------------------------

describe('room action rate-limit isolation', () => {
	it('rate-limited room actions get separate bucket keys', async () => {
		const room = live.room({
			topic: (ctx, roomId) => 'rl:' + roomId,
			init: async (ctx) => [],
			actions: {
				actionA: live.rateLimit({ points: 1, window: 60000 }, async (ctx) => 'a'),
				actionB: live.rateLimit({ points: 1, window: 60000 }, async (ctx) => 'b')
			},
			topicArgs: 1
		});

		// Register with distinct action paths
		__register('rlroom/r1/__action/actionA', room.__actions.actionA, 'rlroom');
		__register('rlroom/r1/__action/actionB', room.__actions.actionB, 'rlroom');

		const ws = mockWs({ id: 'rl-user1' });
		const platform = mockPlatform();

		// Call actionA -- should succeed (first call)
		handleRpc(ws, toArrayBuffer({ rpc: 'rlroom/r1/__action/actionA', id: 'rla1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);

		// Call actionB -- should ALSO succeed (different action, different bucket)
		handleRpc(ws, toArrayBuffer({ rpc: 'rlroom/r1/__action/actionB', id: 'rla2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1]?.data.ok).toBe(true);
	});
});

// -- Topic fn with defaulted/rest no-ctx params -------------------------------

describe('topic fn with defaulted/rest no-ctx params', () => {
	it('defaulted no-ctx param resolves correctly', async () => {
		let receivedArg;
		const stream = live.stream(
			(roomId = 'lobby') => {
				receivedArg = roomId;
				return 'room:' + roomId;
			},
			async (ctx) => [{ id: 1 }],
			{ merge: 'crud' }
		);
		__register('topicfn/defnoctx', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/defnoctx', id: 'dn1', args: ['arena'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('room:arena');
		expect(receivedArg).toBe('arena');
	});

	it('rest-only no-ctx param resolves correctly', async () => {
		let receivedParts;
		const stream = live.stream(
			(...parts) => {
				receivedParts = parts;
				return 'path:' + parts.join('/');
			},
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/restnoctx', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/restnoctx', id: 'rn1', args: ['a', 'b'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('path:a/b');
		expect(receivedParts).toEqual(['a', 'b']);
	});

	it('defaulted no-ctx channel param resolves correctly', async () => {
		let receivedArg;
		const ch = live.channel(
			(docId = 'main') => {
				receivedArg = docId;
				return 'doc:' + docId;
			},
			{ merge: 'set' }
		);
		__register('topicfn/defchannel', ch);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'topicfn/defchannel', id: 'dch1', args: ['draft'], stream: true });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('doc:draft');
		expect(receivedArg).toBe('draft');
	});
});

// -- validated(rateLimit(...)) bucket isolation --------------------------------

describe('validated(rateLimit(...)) bucket isolation', () => {
	it('two validated+rate-limited RPCs get separate buckets', async () => {
		const schema = { safeParse: (v) => ({ success: true, data: v }) };

		const handlerA = live.validated(schema, live.rateLimit(
			{ points: 1, window: 60000 },
			async (ctx, input) => 'a:' + input
		));
		const handlerB = live.validated(schema, live.rateLimit(
			{ points: 1, window: 60000 },
			async (ctx, input) => 'b:' + input
		));

		__register('composed/actionA', handlerA);
		__register('composed/actionB', handlerB);

		const ws = mockWs({ id: 'composed-user' });
		const platform = mockPlatform();

		// Call actionA -- should succeed
		handleRpc(ws, toArrayBuffer({ rpc: 'composed/actionA', id: 'ca1', args: ['x'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);

		// Call actionB -- should ALSO succeed (different path, different bucket)
		handleRpc(ws, toArrayBuffer({ rpc: 'composed/actionB', id: 'ca2', args: ['y'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1]?.data.ok).toBe(true);
	});
});

// -- Room presence/cursor topic resolution ------------------------------------

describe('room presence/cursor topic resolution', () => {
	it('presence stream resolves correct topic with room args', async () => {
		const room = live.room({
			topic: (ctx, roomId) => 'proom:' + roomId,
			init: async (ctx, roomId) => [],
			presence: (ctx) => ({ name: 'test' })
		});
		__register('pres/chat/__presence', room.__presenceStream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'pres/chat/__presence', id: 'pt1', args: ['abc'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('proom:abc:presence');
	});

	it('cursor stream resolves correct topic with room args', async () => {
		const room = live.room({
			topic: (ctx, roomId) => 'croom:' + roomId,
			init: async (ctx, roomId) => [],
			cursors: true
		});
		__register('curs/chat/__cursors', room.__cursorStream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'curs/chat/__cursors', id: 'ct1', args: ['xyz'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('croom:xyz:cursors');
	});
});

// -- ctx-aware dynamic topics with rest/default params ------------------------

describe('ctx-aware dynamic topics with rest/default params', () => {
	it('(ctx, ...parts) resolves correctly', async () => {
		let receivedParts;
		const stream = live.stream(
			(ctx, ...parts) => {
				receivedParts = parts;
				return 'path:' + parts.join('/');
			},
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/ctxrest', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/ctxrest', id: 'cr1', args: ['a', 'b'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('path:a/b');
		expect(receivedParts).toEqual(['a', 'b']);
	});

	it('(ctx, roomId = "lobby") resolves correctly', async () => {
		let receivedRoom;
		const stream = live.stream(
			(ctx, roomId = 'lobby') => {
				receivedRoom = roomId;
				return 'room:' + roomId;
			},
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/ctxdef', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/ctxdef', id: 'cd1', args: ['arena'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('room:arena');
		expect(receivedRoom).toBe('arena');
	});
});

// -- Room action validated(rateLimit(...)) bucket isolation --------------------

describe('room action validated(rateLimit(...)) bucket isolation', () => {
	it('two room actions with validated+rateLimit get separate buckets', async () => {
		const schema = { safeParse: (v) => ({ success: true, data: v }) };

		const room = live.room({
			topic: (ctx, roomId) => 'rlvroom:' + roomId,
			init: async (ctx) => [],
			actions: {
				alpha: live.validated(schema, live.rateLimit(
					{ points: 1, window: 60000 },
					async (ctx, input) => 'alpha:' + input
				)),
				beta: live.validated(schema, live.rateLimit(
					{ points: 1, window: 60000 },
					async (ctx, input) => 'beta:' + input
				))
			},
			topicArgs: 1
		});

		__register('rlvroom/r1/__action/alpha', room.__actions.alpha, 'rlvroom');
		__register('rlvroom/r1/__action/beta', room.__actions.beta, 'rlvroom');

		const ws = mockWs({ id: 'rlv-user' });
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'rlvroom/r1/__action/alpha', id: 'rlv1', args: ['r1', 'x'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);

		handleRpc(ws, toArrayBuffer({ rpc: 'rlvroom/r1/__action/beta', id: 'rlv2', args: ['r1', 'y'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1]?.data.ok).toBe(true);
	});
});

// -- Room action topic arg slicing --------------------------------------------

describe('room action topic arg slicing', () => {
	it('action payload args do not leak into room topic', async () => {
		let resolvedTopic;
		const room = live.room({
			topic: (ctx, boardId, sectionId) => {
				resolvedTopic = 'board:' + boardId + ':' + sectionId;
				return resolvedTopic;
			},
			init: async (ctx, boardId, sectionId) => [],
			actions: {
				addCard: async (ctx, boardId, sectionId, title) => title
			},
			topicArgs: 2
		});

		__register('argsroom/r/__action/addCard', room.__actions.addCard, 'argsroom');

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'argsroom/r/__action/addCard', id: 'as1', args: ['b1', 's2', 'My Card'] }), platform);

		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);
		expect(resolvedTopic).toBe('board:b1:s2');
	});
});

// -- ctx alias / destructured / typed topic params ----------------------------

describe('ctx alias and destructured topic params', () => {
	it('(c, roomId) => ... uses fn.length heuristic (not rejected)', async () => {
		let receivedC;
		const stream = live.stream(
			(c, roomId) => { receivedC = c; return 'alias:' + roomId; },
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/alias', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/alias', id: 'al1', args: ['room7'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('alias:room7');
		expect(receivedC).toBeDefined();
		expect(receivedC.user).toBeDefined();
	});

	it('destructured ({ user }, roomId) => ... is detected as ctx-aware', async () => {
		let receivedUser;
		const stream = live.stream(
			({ user }, roomId) => { receivedUser = user; return 'destr:' + roomId; },
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/destr', stream);

		const ws = mockWs({ id: 'u9' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/destr', id: 'ds1', args: ['room8'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('destr:room8');
		expect(receivedUser.id).toBe('u9');
	});

	it('destructured non-ctx ({ roomId }) => ... is NOT treated as ctx-aware', async () => {
		let receivedArg;
		const stream = live.stream(
			({ roomId }) => { receivedArg = roomId; return 'room:' + roomId; },
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/destrnoctx', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/destrnoctx', id: 'dnc1', args: [{ roomId: 'abc' }], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('room:abc');
		expect(receivedArg).toBe('abc');
	});

	it('destructured ctx with defaults requires explicit opt-in via __topicUsesCtx', async () => {
		let receivedUser, receivedRoom;
		const fallback = { user: { id: 'fallback' } };
		const topicFn = ({ user } = fallback, roomId) => { receivedUser = user; receivedRoom = roomId; return 'dctx:' + roomId; };
		topicFn.__topicUsesCtx = true;
		const stream = live.stream(
			topicFn,
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/defdestrctx', stream);

		const ws = mockWs({ id: 'u7' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/defdestrctx', id: 'ddc1', args: ['lobby'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('dctx:lobby');
		expect(receivedUser.id).toBe('u7');
		expect(receivedRoom).toBe('lobby');
	});

	it('destructured ctx channel with defaults requires explicit opt-in', async () => {
		let receivedUser, receivedDoc;
		const fallback = { user: { id: 'fallback' } };
		const topicFn = ({ user } = fallback, docId) => { receivedUser = user; receivedDoc = docId; return 'cdctx:' + docId; };
		topicFn.__topicUsesCtx = true;
		const ch = live.channel(
			topicFn,
			{ merge: 'set' }
		);
		__register('topicfn/defdestrch', ch);

		const ws = mockWs({ id: 'u8' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/defdestrch', id: 'ddc2', args: ['draft'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('cdctx:draft');
		expect(receivedUser.id).toBe('u8');
		expect(receivedDoc).toBe('draft');
	});

	it('destructured payload with ctx-like names ({ user, roomId }) uses payload not ctx', async () => {
		let receivedUser, receivedRoom;
		const stream = live.stream(
			({ user, roomId }) => { receivedUser = user; receivedRoom = roomId; return 'mixed:' + roomId; },
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/mixeddestr', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/mixeddestr', id: 'md1', args: [{ user: 'alice', roomId: 'r1' }], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('mixed:r1');
		expect(receivedUser).toBe('alice');
		expect(receivedRoom).toBe('r1');
	});
});

// -- topicArgs required for ambiguous room topics with actions -----------------

describe('topicArgs required for rooms with actions', () => {
	it('throws when actions are defined without topicArgs', () => {
		expect(() => live.room({
			topic: (ctx, roomId) => 'room:' + roomId,
			init: async (ctx) => [],
			actions: { send: async (ctx) => 'ok' }
		})).toThrow('topicArgs');
	});

	it('throws for defaulted topic params without topicArgs', () => {
		expect(() => live.room({
			topic: (ctx, boardId, sectionId = 'main') => 'board:' + boardId + ':' + sectionId,
			init: async (ctx) => [],
			actions: { send: async (ctx) => 'ok' }
		})).toThrow('topicArgs');
	});

	it('throws for rest topic params without topicArgs', () => {
		expect(() => live.room({
			topic: (ctx, ...parts) => 'room:' + parts.join('/'),
			init: async (ctx) => [],
			actions: { send: async (ctx) => 'ok' }
		})).toThrow('topicArgs');
	});

	it('works with explicit topicArgs on defaulted room topic', async () => {
		let resolvedTopic;
		const room = live.room({
			topic: (ctx, boardId, sectionId = 'main') => {
				resolvedTopic = 'board:' + boardId + ':' + sectionId;
				return resolvedTopic;
			},
			init: async (ctx) => [],
			actions: { addCard: async (ctx, boardId, sectionId, title) => title },
			topicArgs: 2
		});

		__register('taroom/r/__action/addCard', room.__actions.addCard, 'taroom');

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'taroom/r/__action/addCard', id: 'ta1', args: ['b1', 's2', 'My Card'] }), platform);

		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);
		expect(resolvedTopic).toBe('board:b1:s2');
	});

	it('topicArgs: 0 prevents payload args from leaking into topic', async () => {
		let resolvedTopic;
		const room = live.room({
			topic: (ctx) => {
				resolvedTopic = 'inbox:' + ctx.user.id;
				return resolvedTopic;
			},
			init: async (ctx) => [],
			actions: { send: async (ctx, message) => message },
			topicArgs: 0
		});

		__register('ta0room/r/__action/send', room.__actions.send, 'ta0room');

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'ta0room/r/__action/send', id: 'ta01', args: ['hello'] }), platform);

		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);
		expect(resolvedTopic).toBe('inbox:u1');
	});

	it('rejects non-integer topicArgs', () => {
		expect(() => live.room({
			topic: (ctx) => 'room',
			init: async () => [],
			topicArgs: 1.5
		})).toThrow('non-negative integer');
	});

	it('rejects negative topicArgs', () => {
		expect(() => live.room({
			topic: (ctx) => 'room',
			init: async () => [],
			topicArgs: -1
		})).toThrow('non-negative integer');
	});
});

// -- Topic function must return string ----------------------------------------

describe('topic function validation', () => {
	it('rejects async topic functions at definition time', () => {
		expect(() => live.stream(
			async (ctx, roomId) => 'room:' + roomId,
			async (ctx) => [],
			{ merge: 'crud' }
		)).toThrow('must not be async');
	});

	it('rejects async channel topic functions at definition time', () => {
		expect(() => live.channel(
			async (ctx, docId) => 'doc:' + docId,
			{ merge: 'set' }
		)).toThrow('must not be async');
	});

	it('rejects non-string topic at call time', async () => {
		const stream = live.stream(
			(ctx) => 42,
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/nonstr', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/nonstr', id: 'ns1', args: [], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(false);
		expect(response.code).toBe('INVALID_REQUEST');
	});
});

// -- Topic fn with defaults and fn.length heuristic --------------------------

describe('topic fn with defaults uses fn.length heuristic', () => {
	it('defaulted param uses fn.length (no source parsing)', async () => {
		let receivedArg;
		const stream = live.stream(
			(roomId = 'a,b') => { receivedArg = roomId; return 'r:' + roomId; },
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/strcomma', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/strcomma', id: 'sc1', args: ['test'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('r:test');
		expect(receivedArg).toBe('test');
	});

	it('single-param arrow without parens resolves correctly', async () => {
		let receivedArg;
		const stream = live.stream(
			roomId => { receivedArg = roomId; return ['x', roomId].join(','); },
			async (ctx) => [],
			{ merge: 'crud' }
		);
		__register('topicfn/noparen', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/noparen', id: 'np1', args: ['y'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('x,y');
		expect(receivedArg).toBe('y');
	});

	it('defaulted channel param uses fn.length (no source parsing)', async () => {
		let receivedArg;
		const ch = live.channel(
			(docId = 'a,b') => { receivedArg = docId; return 'doc:' + docId; },
			{ merge: 'set' }
		);
		__register('topicfn/chstrcomma', ch);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'topicfn/chstrcomma', id: 'csc1', args: ['draft'], stream: true }), platform);

		await new Promise((r) => setTimeout(r, 10));
		const response = platform.sent[0]?.data;
		expect(response.ok).toBe(true);
		expect(response.topic).toBe('doc:draft');
		expect(receivedArg).toBe('draft');
	});
});

// -- Rate limit bucket cap with existing identity -----------------------------

describe('rate limit bucket cap with existing identity', () => {
	it('existing identity passes, new identity rejected when map is full', async () => {
		const fn = live.rateLimit({ points: 10000, window: 60000 }, async (ctx) => 'ok');
		fn.__rateLimitPath = 'test/capcap';

		// Fill until the cap is hit (prior tests may have leftover buckets)
		let filled = 0;
		try {
			for (let i = 0; i < 6000; i++) {
				await fn({ user: { id: 'cap' + i } });
				filled++;
			}
		} catch {
			// Expected: cap reached
		}
		expect(filled).toBeGreaterThan(0);
		expect(filled).toBeLessThanOrEqual(5000);

		// Repeat call for an existing identity must still work
		const result = await fn({ user: { id: 'cap0' } });
		expect(result).toBe('ok');

		// New identity should be rejected
		try {
			await fn({ user: { id: 'definitely-new-' + Date.now() } });
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err.code).toBe('RATE_LIMITED');
		}
	});
});

// -- live.idempotent() --------------------------------------------------------

describe('live.idempotent()', () => {
	beforeEach(() => {
		_resetIdempotencyStore();
	});

	it('marks the wrapper with __isLive and __isIdempotent', () => {
		const handler = live.idempotent({ keyFrom: () => 'k' }, async () => 'ok');
		expect(handler.__isLive).toBe(true);
		expect(handler.__isIdempotent).toBe(true);
		expect(typeof handler.__idempotency).toBe('object');
		expect(handler.__idempotency.ttl).toBe(172800);
	});

	it('runs handler when no key is available (no keyFrom, no envelope key)', async () => {
		let calls = 0;
		const handler = live.idempotent({}, async (ctx, x) => { calls++; return x * 2; });
		__register('idem/nokey', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/nokey', id: '1', args: [3] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/nokey', id: '2', args: [3] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(2);
		expect(platform.sent[0].data).toMatchObject({ ok: true, data: 6 });
		expect(platform.sent[1].data).toMatchObject({ ok: true, data: 6 });
	});

	it('caches the result when keyFrom returns a key (sequential calls)', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: (ctx, x) => `op:${x}` },
			async (ctx, x) => { calls++; return x * 10; }
		);
		__register('idem/keyfrom', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/keyfrom', id: '1', args: [4] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/keyfrom', id: '2', args: [4] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
		expect(platform.sent[0].data).toMatchObject({ ok: true, data: 40, id: '1' });
		expect(platform.sent[1].data).toMatchObject({ ok: true, data: 40, id: '2' });
	});

	it('uses envelope idempotencyKey when keyFrom is absent', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{},
			async (ctx, x) => { calls++; return x + 1; }
		);
		__register('idem/envelope', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const key = 'env-key-1';

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/envelope', id: 'a', args: [10], idempotencyKey: key }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/envelope', id: 'b', args: [10], idempotencyKey: key }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
		expect(platform.sent[0].data.data).toBe(11);
		expect(platform.sent[1].data.data).toBe(11);
	});

	it('keyFrom takes precedence over envelope idempotencyKey', async () => {
		const seen = [];
		const handler = live.idempotent(
			{ keyFrom: (ctx, x) => `from:${x}` },
			async (ctx, x) => { seen.push(x); return x; }
		);
		__register('idem/precedence', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Different envelope keys, same keyFrom-derived key -> single execution
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/precedence', id: '1', args: [7], idempotencyKey: 'env-X' }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/precedence', id: '2', args: [7], idempotencyKey: 'env-Y' }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(seen).toEqual([7]);
	});

	it('different keys -> separate cache entries', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: (ctx, x) => `k:${x}` },
			async (ctx, x) => { calls++; return x; }
		);
		__register('idem/distinct', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/distinct', id: '1', args: [1] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/distinct', id: '2', args: [2] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/distinct', id: '3', args: [1] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(2);
		expect(platform.sent[0].data.data).toBe(1);
		expect(platform.sent[1].data.data).toBe(2);
		expect(platform.sent[2].data.data).toBe(1);
	});

	it('does NOT cache thrown errors (next call re-runs)', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: () => 'flaky' },
			async () => {
				calls++;
				if (calls === 1) throw new LiveError('INTERNAL_ERROR', 'boom');
				return 'ok';
			}
		);
		__register('idem/flaky', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/flaky', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/flaky', id: '2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(2);
		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[1].data.ok).toBe(true);
		expect(platform.sent[1].data.data).toBe('ok');
	});

	it('caches an undefined result (acquired flag is the discriminant, not result presence)', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: () => 'undef' },
			async () => { calls++; return undefined; }
		);
		const ws = mockWs();
		const platform = mockPlatform();
		__register('idem/undef', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/undef', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/undef', id: '2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
	});

	it('concurrent calls with the same key share one handler invocation', async () => {
		let calls = 0;
		let resolveInner;
		const innerPromise = new Promise((r) => { resolveInner = r; });
		const handler = live.idempotent(
			{ keyFrom: () => 'concurrent' },
			async () => { calls++; await innerPromise; return 'shared'; }
		);
		const ws = mockWs();
		const platform = mockPlatform();
		__register('idem/concurrent', handler);

		// Fire two requests synchronously; both enter idempotency before commit.
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/concurrent', id: '1', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/concurrent', id: '2', args: [] }), platform);

		// Yield to let both reach the inflight wait.
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toBe(1);

		resolveInner('shared');
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
		expect(platform.sent.length).toBe(2);
		expect(platform.sent[0].data.data).toBe('shared');
		expect(platform.sent[1].data.data).toBe('shared');
	});

	it('TTL=0 disables caching (handler re-runs on every call)', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: () => 'zero', ttl: 0 },
			async () => { calls++; return 'ok'; }
		);
		const ws = mockWs();
		const platform = mockPlatform();
		__register('idem/zero', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/zero', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/zero', id: '2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// ttl=0 -> entry expires immediately. Each call should re-run.
		expect(calls).toBe(2);
	});

	it('uses a custom store when provided (default not consulted)', async () => {
		const acquireCalls = [];
		const customStore = {
			async acquire(key, ttl) {
				acquireCalls.push({ key, ttl });
				return { result: 'from-custom-store' };
			}
		};
		const handler = live.idempotent(
			{ keyFrom: () => 'custom-key', store: customStore, ttl: 60 },
			async () => 'from-handler-never-runs'
		);
		const ws = mockWs();
		const platform = mockPlatform();
		__register('idem/custom', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/custom', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(acquireCalls).toEqual([{ key: 'custom-key', ttl: 60 }]);
		expect(platform.sent[0].data.data).toBe('from-custom-store');
	});

	it('throws CONFLICT when store returns pending', async () => {
		const customStore = { async acquire() { return { pending: true }; } };
		const handler = live.idempotent(
			{ keyFrom: () => 'p', store: customStore },
			async () => 'never'
		);
		const ws = mockWs();
		const platform = mockPlatform();
		__register('idem/pending', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/pending', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('CONFLICT');
	});

	it('composes with live.validated() (validation runs first)', async () => {
		const schema = {
			safeParse(input) {
				if (input && typeof input.x === 'number') return { success: true, data: input };
				return { success: false, error: { issues: [{ path: ['x'], message: 'required' }] } };
			}
		};
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: (ctx, input) => `v:${input.x}` },
			live.validated(schema, async (ctx, input) => { calls++; return input.x * 2; })
		);
		const ws = mockWs();
		const platform = mockPlatform();
		__register('idem/composed', handler);

		// Bad input -> validation rejects, no cache entry
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/composed', id: '1', args: [{}] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.code).toBe('VALIDATION');

		// Good input -> handler runs, caches
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/composed', id: '2', args: [{ x: 5 }] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/composed', id: '3', args: [{ x: 5 }] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
		expect(platform.sent[1].data.data).toBe(10);
		expect(platform.sent[2].data.data).toBe(10);
	});

	it('rejects invalid config at registration time', () => {
		expect(() => live.idempotent({ keyFrom: 'not-a-function' }, async () => 'ok'))
			.toThrow(/keyFrom must be a function/);
		expect(() => live.idempotent({ store: { foo: 'bar' } }, async () => 'ok'))
			.toThrow(/store must implement acquire/);
		expect(() => live.idempotent({ ttl: -1 }, async () => 'ok'))
			.toThrow(/ttl must be a non-negative number/);
		expect(() => live.idempotent({}, 'not a function'))
			.toThrow(/requires a handler function/);
	});
});

// -- live.stream({ coalesceBy }) ----------------------------------------------

describe('live.stream({ coalesceBy })', () => {
	beforeEach(() => {
		_resetCoalesceRegistry();
	});

	it('rejects non-function coalesceBy at registration', () => {
		expect(() => live.stream('coal/bad', async () => [], { coalesceBy: 'nope' }))
			.toThrow(/coalesceBy must be a function/);
	});

	it('default stream (no coalesceBy) publishes via platform.publish', async () => {
		const stream = live.stream('coal/plain', async () => [{ id: 1 }], { merge: 'crud', key: 'id' });
		__register('coal/plain', stream);

		const handler = live(async (ctx) => { ctx.publish('coal/plain', 'updated', { id: 1, v: 2 }); return 'ok'; });
		__register('coal/pub-plain', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/plain', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/pub-plain', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.published).toHaveLength(1);
		expect(platform.coalesced).toHaveLength(0);
	});

	it('coalescing stream publishes via sendCoalesced once subscribed', async () => {
		const stream = live.stream('coal/topic', async () => null, {
			merge: 'set',
			coalesceBy: (data) => data.k
		});
		__register('coal/topic', stream);

		const handler = live(async (ctx) => {
			ctx.publish('coal/topic', 'updated', { k: 'a', v: 1 });
			return 'ok';
		});
		__register('coal/pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Before subscribe: publish falls through to platform.publish
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/pub', id: 'p0', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.published).toHaveLength(1);
		expect(platform.coalesced).toHaveLength(0);
		platform.reset();

		// Subscribe via the stream RPC path
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/topic', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		// After subscribe: publish goes through sendCoalesced
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.published).toHaveLength(0);
		expect(platform.coalesced).toHaveLength(1);
		expect(platform.coalesced[0].topic).toBe('coal/topic');
		expect(platform.coalesced[0].event).toBe('updated');
		expect(platform.coalesced[0].data).toEqual({ k: 'a', v: 1 });
		expect(platform.coalesced[0].key).toBe('coal/topic\0a');
	});

	it('fans out one sendCoalesced per subscribed ws', async () => {
		const stream = live.stream('coal/multi', async () => null, {
			merge: 'set',
			coalesceBy: (data) => data.k
		});
		__register('coal/multi', stream);

		const handler = live(async (ctx) => {
			ctx.publish('coal/multi', 'updated', { k: 'x', v: 7 });
			return 'ok';
		});
		__register('coal/multi-pub', handler);

		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		const ws3 = mockWs({ id: 'u3' });
		const platform = mockPlatform();

		for (const w of [ws1, ws2, ws3]) {
			handleRpc(w, toArrayBuffer({ rpc: 'coal/multi', id: 's', args: [], stream: true }), platform);
			await new Promise((r) => setTimeout(r, 5));
		}
		platform.reset();

		handleRpc(ws1, toArrayBuffer({ rpc: 'coal/multi-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(3);
		const wsRefs = platform.coalesced.map(c => c.ws);
		expect(wsRefs).toContain(ws1);
		expect(wsRefs).toContain(ws2);
		expect(wsRefs).toContain(ws3);
		// All share the same key/topic/event/data
		for (const c of platform.coalesced) {
			expect(c.key).toBe('coal/multi\0x');
			expect(c.topic).toBe('coal/multi');
			expect(c.event).toBe('updated');
		}
	});

	it('null/undefined coalesceBy result collapses to a single per-topic key', async () => {
		const stream = live.stream('coal/nullkey', async () => null, {
			merge: 'set',
			coalesceBy: () => null
		});
		__register('coal/nullkey', stream);

		const handler = live(async (ctx) => { ctx.publish('coal/nullkey', 'updated', { v: 1 }); return 'ok'; });
		__register('coal/nullkey-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/nullkey', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/nullkey-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(1);
		expect(platform.coalesced[0].key).toBe('coal/nullkey\0');
	});

	it('unsubscribe(ws, topic) removes the ws from the coalesce set', async () => {
		const stream = live.stream('coal/unsub', async () => null, {
			merge: 'set',
			coalesceBy: (d) => d.k
		});
		__register('coal/unsub', stream);

		const handler = live(async (ctx) => { ctx.publish('coal/unsub', 'updated', { k: 'a' }); return 'ok'; });
		__register('coal/unsub-pub', handler);

		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		const platform = mockPlatform();

		for (const w of [ws1, ws2]) {
			handleRpc(w, toArrayBuffer({ rpc: 'coal/unsub', id: 's', args: [], stream: true }), platform);
			await new Promise((r) => setTimeout(r, 5));
		}
		platform.reset();

		unsubscribe(ws1, 'coal/unsub', { platform });

		handleRpc(ws2, toArrayBuffer({ rpc: 'coal/unsub-pub', id: 'p', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Only ws2 receives the coalesced message
		expect(platform.coalesced).toHaveLength(1);
		expect(platform.coalesced[0].ws).toBe(ws2);
	});

	it('close(ws) drops all of that ws\'s coalesce subscriptions', async () => {
		const stream = live.stream('coal/close', async () => null, {
			merge: 'set',
			coalesceBy: (d) => d.k
		});
		__register('coal/close', stream);

		const handler = live(async (ctx) => { ctx.publish('coal/close', 'updated', { k: 'a' }); return 'ok'; });
		__register('coal/close-pub', handler);

		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		const platform = mockPlatform();

		for (const w of [ws1, ws2]) {
			handleRpc(w, toArrayBuffer({ rpc: 'coal/close', id: 's', args: [], stream: true }), platform);
			await new Promise((r) => setTimeout(r, 5));
		}
		platform.reset();

		close(ws1, { platform });

		handleRpc(ws2, toArrayBuffer({ rpc: 'coal/close-pub', id: 'p', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(1);
		expect(platform.coalesced[0].ws).toBe(ws2);

		// Closing the last subscriber should leave the topic with no fan-out
		// targets: subsequent publish falls back to platform.publish.
		close(ws2, { platform });
		platform.reset();

		handleRpc(ws1, toArrayBuffer({ rpc: 'coal/close-pub', id: 'p2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(0);
		expect(platform.published).toHaveLength(1);
	});

	it('repeated subscribes from the same ws do not double-count in the set', async () => {
		const stream = live.stream('coal/repeat', async () => null, {
			merge: 'set',
			coalesceBy: (d) => d.k
		});
		__register('coal/repeat', stream);

		const handler = live(async (ctx) => { ctx.publish('coal/repeat', 'updated', { k: 'a' }); return 'ok'; });
		__register('coal/repeat-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Three subscribes from one ws -> Set still has just one entry
		for (let i = 0; i < 3; i++) {
			handleRpc(ws, toArrayBuffer({ rpc: 'coal/repeat', id: 's' + i, args: [], stream: true }), platform);
			await new Promise((r) => setTimeout(r, 5));
		}
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/repeat-pub', id: 'p', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(1);
	});

	it('different keys produce different sendCoalesced keys', async () => {
		const stream = live.stream('coal/keys', async () => null, {
			merge: 'set',
			coalesceBy: (d) => d.k
		});
		__register('coal/keys', stream);

		const handler = live(async (ctx, k) => { ctx.publish('coal/keys', 'updated', { k, v: 1 }); return 'ok'; });
		__register('coal/keys-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/keys', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/keys-pub', id: 'p1', args: ['a'] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/keys-pub', id: 'p2', args: ['b'] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(2);
		expect(platform.coalesced[0].key).toBe('coal/keys\0a');
		expect(platform.coalesced[1].key).toBe('coal/keys\0b');
	});

	it('rolls back coalesce registration when init throws', async () => {
		const stream = live.stream('coal/throws', async () => { throw new LiveError('INTERNAL_ERROR', 'boom'); }, {
			merge: 'set',
			coalesceBy: (d) => d.k
		});
		__register('coal/throws', stream);

		const handler = live(async (ctx) => { ctx.publish('coal/throws', 'updated', { k: 'a' }); return 'ok'; });
		__register('coal/throws-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throws', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// init failed -> rollback should have unregistered the coalesce entry
		platform.reset();
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throws-pub', id: 'p', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(0);
		expect(platform.published).toHaveLength(1);
	});
});

// -- Three-tier reconnect ----------------------------------------------------

describe('three-tier reconnect (replay -> delta.fromSeq -> rehydrate)', () => {
	it('rejects non-function delta.fromSeq at registration', () => {
		expect(() => live.stream('tt/bad', async () => [], { delta: { fromSeq: 'nope' } }))
			.toThrow(/delta\.fromSeq must be a function/);
	});

	it('rejects non-object delta at registration', () => {
		expect(() => live.stream('tt/bad2', async () => [], { delta: 'nope' }))
			.toThrow(/delta must be an object/);
	});

	it('tier 1: replay buffer satisfies the gap (fromSeq not called)', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		const missed = [{ event: 'created', data: { id: 2, seq: 4 } }];
		platform.replay = {
			seq: async () => 5,
			since: async (topic, sinceSeq) => sinceSeq < 5 ? missed : null
		};
		const fromSeqCalls = [];
		const stream = live.stream('tt/replay-wins', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', replay: true,
			delta: { fromSeq: async (s) => { fromSeqCalls.push(s); return [{ event: 'created', data: { id: 99 } }]; } }
		});
		__register('tt/replay-wins', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'tt/replay-wins', id: 't1', args: [], stream: true, seq: 3 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.replay).toBe(true);
		expect(response.data).toBe(missed);
		expect(response.seq).toBe(5);
		expect(fromSeqCalls).toEqual([]);
	});

	it('tier 2: replay returns null (truncated) -> delta.fromSeq fills the gap', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform.replay = {
			seq: async () => 100,
			since: async () => null   // truncated
		};
		const dbEvents = [
			{ event: 'created', data: { id: 5 }, seq: 50 },
			{ event: 'updated', data: { id: 5, name: 'X' }, seq: 60 }
		];
		const fromSeqCalls = [];
		const stream = live.stream('tt/seq-delta', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', replay: true,
			delta: { fromSeq: async (s) => { fromSeqCalls.push(s); return dbEvents; } }
		});
		__register('tt/seq-delta', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'tt/seq-delta', id: 't2', args: [], stream: true, seq: 3 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.replay).toBe(true);
		expect(response.data).toBe(dbEvents);
		expect(response.seq).toBe(60);   // last event's seq wins
		expect(fromSeqCalls).toEqual([3]);
	});

	it('tier 2: response.seq falls back to platform.replay.seq when events lack seq fields', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform.replay = {
			seq: async () => 99,
			since: async () => null
		};
		const stream = live.stream('tt/no-event-seq', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', replay: true,
			delta: { fromSeq: async () => [{ event: 'created', data: { id: 7 } }] }
		});
		__register('tt/no-event-seq', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'tt/no-event-seq', id: 't3', args: [], stream: true, seq: 3 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.replay).toBe(true);
		expect(response.seq).toBe(99);
	});

	it('tier 2: empty array means "nothing missed" (no-op for client)', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform.replay = {
			seq: async () => 10,
			since: async () => null
		};
		const stream = live.stream('tt/empty-delta', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', replay: true,
			delta: { fromSeq: async () => [] }
		});
		__register('tt/empty-delta', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'tt/empty-delta', id: 't4', args: [], stream: true, seq: 3 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.replay).toBe(true);
		expect(response.data).toEqual([]);
		expect(response.seq).toBe(10);
	});

	it('tier 3: delta.fromSeq returns null -> falls through to full rehydrate', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform.replay = {
			seq: async () => 100,
			since: async () => null
		};
		const stream = live.stream('tt/null-delta', async () => [{ id: 1, name: 'fresh' }], {
			merge: 'crud', key: 'id', replay: true,
			delta: { fromSeq: async () => null }
		});
		__register('tt/null-delta', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'tt/null-delta', id: 't5', args: [], stream: true, seq: 3 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.replay).not.toBe(true);
		expect(response.data).toEqual([{ id: 1, name: 'fresh' }]);
	});

	it('tier 3: delta.fromSeq throws -> falls through to full rehydrate', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform.replay = {
			seq: async () => 100,
			since: async () => null
		};
		const stream = live.stream('tt/throws-delta', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', replay: true,
			delta: { fromSeq: async () => { throw new Error('db down'); } }
		});
		__register('tt/throws-delta', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'tt/throws-delta', id: 't6', args: [], stream: true, seq: 3 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.replay).not.toBe(true);
		expect(response.data).toEqual([{ id: 1 }]);
	});

	it('seq-delta is skipped when client did not send seq (cold subscribe)', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		const fromSeqCalls = [];
		const stream = live.stream('tt/cold', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id',
			delta: { fromSeq: async (s) => { fromSeqCalls.push(s); return []; } }
		});
		__register('tt/cold', stream);

		// No `seq` in envelope -> first-time subscribe, full rehydrate
		handleRpc(ws, toArrayBuffer({ rpc: 'tt/cold', id: 't7', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(fromSeqCalls).toEqual([]);
		expect(response.data).toEqual([{ id: 1 }]);
	});

	it('seq-delta works without replay opts (no platform.replay needed)', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		// No platform.replay set
		const dbEvents = [{ event: 'created', data: { id: 9 }, seq: 12 }];
		const stream = live.stream('tt/no-replay', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id',
			delta: { fromSeq: async () => dbEvents }
		});
		__register('tt/no-replay', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'tt/no-replay', id: 't8', args: [], stream: true, seq: 0 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const response = platform.sent[0].data;
		expect(response.replay).toBe(true);
		expect(response.data).toBe(dbEvents);
		expect(response.seq).toBe(12);
	});

	it('legacy version-delta (unchanged + diff) still composes alongside fromSeq', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		const stream = live.stream('tt/both', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id',
			delta: {
				version: async () => 7,
				diff: async () => [{ id: 99, _delta: true }],
				fromSeq: async () => [{ event: 'created', data: { id: 200 }, seq: 50 }]
			}
		});
		__register('tt/both', stream);

		// Client sends version=7 -> unchanged short-circuit, fromSeq not called
		handleRpc(ws, toArrayBuffer({ rpc: 'tt/both', id: 't9', args: [], stream: true, version: 7, seq: 1 }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const r1 = platform.sent[0].data;
		expect(r1.unchanged).toBe(true);
		expect(r1.version).toBe(7);
	});
});
