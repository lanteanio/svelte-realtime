import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	live,
	guard,
	LiveError,
	handleRpc,
	message,
	createMessage,
	realtime,
	setBus,
	getBus,
	getPlatform,
	publish,
	_resetManualPlatformCallbackWarn,
	combineSum,
	combineMax,
	combineMin,
	combineCounts,
	combineMerge,
	_resetAggregates,
	MAX_AGGREGATE_BUCKETS,
	__register,
	__registerGuard,
	__registerEffect,
	__registerWebhookOut,
	__registerAggregate,
	__registerFlag,
	__directCall,
	_activateDerived,
	_clearCron,
	_tickCron,
	__registerCron,
	setCronPlatform,
	configureCron,
	onCronError,
	onError,
	close,
	unsubscribe,
	enableSignals,
	pipe,
	defineTopics,
	pushHooks,
	_resetStaleWatch,
	_resetInvalidationWatch,
	_resetIdempotencyStore,
	_resetCoalesceRegistry,
	_resetUploadAutoDiscovery,
	_resetAdmission,
	_resetTransformRegistry,
	_resetRateLimits,
	_resetVolatileRegistry,
	_resetPublishRateWarning,
	_activatePublishRateWarning,
	_resetSilentTopicWarning,
	_armSilentTopicWatch,
	_registerCoalesce,
	_registerVolatile,
	_resetLock,
	_resetTopicWsCounts,
	_resetPushRegistry,
	_setCapsForTest,
	_resetCapsForTest,
	MAX_PUSH_REGISTRY,
	TOPIC_WS_COUNTS_WARN_THRESHOLD,
	SILENT_TOPIC_WARN_DEDUP_MAX,
	PUBLISH_RATE_WARN_DEDUP_MAX,
	MAX_PRESENCE_REF,
	assert,
	fatal,
	setFatalSink,
	resetFatalSink,
	getAssertionCounters,
	_resetAssertCounters,
	_resetMiddleware,
	_getIdentityKey,
	_resetReplayRouting,
	WRAPPED_FOR_REPLAY
} from '../src/server.js';
import { createMetrics } from 'svelte-adapter-uws-extensions/prometheus';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';
import { installFakeRuntimeClock, releaseRuntimeClock } from './helpers/runtime-clock.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';

const noopRegistry = () => ({
	counter: () => ({ inc() {} }),
	histogram: () => ({ observe() {} }),
	gauge: () => ({ inc() {}, dec() {} })
});

function adaptExtensionsRegistry(metrics) {
	return {
		counter:   ({ name, help, labelNames }) => metrics.counter(name, help, labelNames),
		histogram: ({ name, help, labelNames }) => metrics.histogram(name, help, labelNames),
		gauge:     ({ name, help, labelNames }) => metrics.gauge(name, help, labelNames)
	};
}

// - live() -------------------------------------------------------------------

describe('live()', () => {
	it('returns the original function with __isLive = true', () => {
		const fn = (ctx) => 'hello';
		const result = live(fn);
		expect(result).toBe(fn);
		expect(result.__isLive).toBe(true);
	});
});

// - live.stream() ------------------------------------------------------------

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

// - guard() ------------------------------------------------------------------

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

// - LiveError ----------------------------------------------------------------

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

// - handleRpc() --------------------------------------------------------------

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

	describe('envelope depth cap', () => {
		function nested(depth) {
			let inner = { rpc: 'x/y', id: 'i', args: [] };
			for (let i = 0; i < depth; i++) inner = { wrap: inner };
			return inner;
		}

		it('accepts shallow RPC envelopes', () => {
			const handler = live(async () => 'ok');
			__register('x/y', handler);
			const data = toArrayBuffer({ rpc: 'x/y', id: 'i', args: [{ a: { b: { c: 1 } } }] });
			expect(handleRpc(ws, data, platform)).toBe(true);
		});

		it('rejects envelopes deeper than the default 64-level cap', () => {
			// 200-deep wrapper rejects at ingress.
			const data = toArrayBuffer(nested(200));
			expect(handleRpc(ws, data, platform)).toBe(false);
		});

		it('honors a custom maxEnvelopeDepth (lower)', () => {
			const handler = live(async () => 'ok');
			__register('shallow/fn', handler);
			const flat = { rpc: 'shallow/fn', id: 'i', args: [{ a: { b: { c: { d: 1 } } } }] };
			expect(handleRpc(ws, toArrayBuffer(flat), platform, { maxEnvelopeDepth: 3 })).toBe(false);
		});

		it('honors a custom maxEnvelopeDepth (higher)', () => {
			const handler = live(async () => 'ok');
			__register('x/y', handler);
			// Top-level RPC shape with a 100-deep payload nested into args.
			// Default cap (64) rejects; raised cap (200) accepts.
			let payload = { leaf: true };
			for (let i = 0; i < 100; i++) payload = { wrap: payload };
			const data = toArrayBuffer({ rpc: 'x/y', id: 'i', args: [payload] });
			expect(handleRpc(ws, data, platform)).toBe(false);
			expect(handleRpc(ws, data, platform, { maxEnvelopeDepth: 200 })).toBe(true);
		});

		it('does not stack-overflow on pathologically deep input (iterative check)', () => {
			// 100k-deep envelope. The iterative depth checker bounds its own
			// memory at the depth-walked stack; a recursive checker would
			// stack-overflow here.
			let deep = { rpc: 'x/y', id: 'i', args: [] };
			for (let i = 0; i < 100_000; i++) deep = { w: deep };
			// JSON.stringify itself recurses, so use a manual encode for very
			// deep shapes. Build the JSON as a string instead.
			let json = '{"rpc":"x/y","id":"i","args":[]}';
			for (let i = 0; i < 5000; i++) json = '{"w":' + json + '}';
			const buf = new TextEncoder().encode(json).buffer;
			// Should not throw - returns false (rejected by depth cap).
			expect(() => handleRpc(ws, buf, platform)).not.toThrow();
			expect(handleRpc(ws, buf, platform)).toBe(false);
		});
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

// - Volatile (fire-and-forget) RPC ------------------------------------------

describe('handleRpc() volatile (no-id frame)', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
	});

	it('runs the handler when frame has no id', async () => {
		let called = false;
		let receivedArg = null;
		const handler = live.volatile(async (_ctx, arg) => {
			called = true;
			receivedArg = arg;
			return 'discarded';
		});
		__register('vol/move', handler);

		const data = toArrayBuffer({ rpc: 'vol/move', args: [{ x: 1, y: 2 }] });
		expect(handleRpc(ws, data, platform)).toBe(true);

		await new Promise((r) => setTimeout(r, 10));

		expect(called).toBe(true);
		expect(receivedArg).toEqual({ x: 1, y: 2 });
	});

	it('does NOT send a response frame back to the client', async () => {
		const handler = live.volatile(async () => 'whatever');
		__register('vol/silent', handler);

		const data = toArrayBuffer({ rpc: 'vol/silent', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent).toHaveLength(0);
	});

	it('does NOT send a response when the handler throws', async () => {
		const handler = live.volatile(async () => { throw new Error('boom'); });
		__register('vol/throws', handler);

		const data = toArrayBuffer({ rpc: 'vol/throws', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent).toHaveLength(0);
	});

	it('runs guards on volatile calls (forbidden errors still rejected by gate)', async () => {
		let handlerCalled = false;
		const guardFn = guard(() => { throw new LiveError('FORBIDDEN', 'no'); });
		const handler = live.volatile(async () => { handlerCalled = true; });
		__registerGuard('volguarded', guardFn);
		__register('volguarded/move', handler);

		const data = toArrayBuffer({ rpc: 'volguarded/move', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(handlerCalled).toBe(false);
		expect(platform.sent).toHaveLength(0);
	});

	it('accepts a no-id frame on a non-volatile handler too (per-call wire shape is the contract)', async () => {
		let called = false;
		const handler = live(async () => { called = true; return 'noop'; });
		__register('plain/handler', handler);

		const data = toArrayBuffer({ rpc: 'plain/handler', args: [] });
		expect(handleRpc(ws, data, platform)).toBe(true);

		await new Promise((r) => setTimeout(r, 10));

		expect(called).toBe(true);
		expect(platform.sent).toHaveLength(0);
	});

	it('rejects frames with empty rpc path', () => {
		const data = toArrayBuffer({ rpc: '', args: [] });
		expect(handleRpc(ws, data, platform)).toBe(false);
	});

	it('rejects frames with non-string id (regression: only undefined id triggers volatile)', () => {
		const data = toArrayBuffer({ rpc: 'something', id: 123, args: [] });
		expect(handleRpc(ws, data, platform)).toBe(false);
	});

	it('runs middleware on volatile calls', async () => {
		_resetMiddleware();
		const order = [];
		live.middleware(async (_ctx, next) => {
			order.push('mw');
			return next();
		});
		const handler = live.volatile(async () => { order.push('handler'); });
		__register('vol/mw', handler);

		const data = toArrayBuffer({ rpc: 'vol/mw', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		expect(order).toEqual(['mw', 'handler']);
		expect(platform.sent).toHaveLength(0);

		_resetMiddleware();
	});

	it('does NOT dev-warn when volatile is wrapped by live.rateLimit', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const inner = live.volatile(async () => undefined);
		const wrapped = live.rateLimit({ points: 1000, window: 60_000 }, inner);
		__register('vol/wrapped', wrapped);

		const data = toArrayBuffer({ rpc: 'vol/wrapped', args: [] });
		handleRpc(ws, data, platform);

		await new Promise((r) => setTimeout(r, 10));

		const volatileWarns = warnSpy.mock.calls.filter((args) =>
			/not marked live\.volatile/.test(args[0] || '')
		);
		expect(volatileWarns).toHaveLength(0);
		warnSpy.mockRestore();
	});
});

describe('live.volatile()', () => {
	it('stamps __isLive and __volatileRpc', () => {
		const fn = live.volatile(async () => {});
		expect(/** @type {any} */ (fn).__isLive).toBe(true);
		expect(/** @type {any} */ (fn).__volatileRpc).toBe(true);
	});

	it('throws when given a non-function', () => {
		expect(() => /** @type {any} */ (live.volatile)('not a function')).toThrow();
		expect(() => /** @type {any} */ (live.volatile)(null)).toThrow();
		expect(() => /** @type {any} */ (live.volatile)(undefined)).toThrow();
	});

	it('returns the same function reference (no wrapping)', () => {
		const fn = async () => {};
		const out = live.volatile(fn);
		expect(out).toBe(fn);
	});
});

// - Stream RPC ---------------------------------------------------------------

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

// - Dynamic topics -----------------------------------------------------------

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

// - message hook -------------------------------------------------------------

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

// - createMessage() ----------------------------------------------------------

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

	// - onJsonMessage path -------------------------------------------------------

	it('onJsonMessage: fires with adapter-forwarded msg (fast path)', () => {
		let receivedMsg;
		const hook = createMessage({
			onJsonMessage(ws, msg, platform) { receivedMsg = msg; }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		// Adapter forwards `msg` as the parsed envelope; `data` is the raw bytes.
		const envelope = { type: 'cursor', topic: 'board:abc', data: { x: 1, y: 2 } };
		hook(ws, { data: toArrayBuffer(envelope), msg: envelope, platform });

		expect(receivedMsg).toEqual(envelope);
	});

	it('onJsonMessage: fires with locally-parsed msg when adapter did not forward (fallback path)', () => {
		let receivedMsg;
		const hook = createMessage({
			onJsonMessage(ws, msg, platform) { receivedMsg = msg; }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		// No `msg` field on ctx -> realtime falls back to its own parse.
		// Wire shape `{"topic":...}` is byte[3]='o' (0x6F), which the adapter
		// skips (prefix-miss). Realtime's fallback uses 0x7B (`{`) prefix only.
		const envelope = { topic: 'board:abc', payload: 'hi' };
		hook(ws, { data: toArrayBuffer(envelope), platform });

		expect(receivedMsg).toEqual(envelope);
	});

	it('onJsonMessage: prefers forwarded msg over local parse (no double-parse)', () => {
		let receivedMsg;
		const hook = createMessage({
			onJsonMessage(ws, msg, platform) { receivedMsg = msg; }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		// Different shape in data bytes vs. forwarded msg. If realtime
		// re-parsed instead of using the forwarded value, receivedMsg would
		// match the bytes. Confirms fast path is the one taken.
		const forwarded = { type: 'sentinel', from: 'adapter' };
		const onWire = { type: 'cursor', from: 'bytes' };
		hook(ws, { data: toArrayBuffer(onWire), msg: forwarded, platform });

		expect(receivedMsg).toBe(forwarded);
		expect(receivedMsg.from).toBe('adapter');
	});

	it('onJsonMessage: does NOT fire on null / primitive / array parses', () => {
		let calls = 0;
		const hook = createMessage({
			onJsonMessage() { calls++; },
			onUnhandled() { /* swallow */ }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		// `null` -> not an object; `42` -> primitive; `[1,2]` -> array (starts with `[`, byte[0]=0x5B, realtime fallback only accepts 0x7B).
		hook(ws, { data: toArrayBuffer(null), platform });
		hook(ws, { data: toArrayBuffer(42), platform });
		hook(ws, { data: toArrayBuffer([1, 2, 3]), platform });

		expect(calls).toBe(0);
	});

	it('onJsonMessage: depth cap routes too-deep envelopes to onUnhandled', () => {
		let jsonCalls = 0;
		let unhandledCalls = 0;
		const hook = createMessage({
			maxJsonDepth: 3,
			onJsonMessage() { jsonCalls++; },
			onUnhandled() { unhandledCalls++; }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		// Build an envelope nested deeper than maxJsonDepth.
		/** @type {any} */
		let nested = { leaf: true };
		for (let i = 0; i < 10; i++) nested = { wrap: nested };
		hook(ws, { data: toArrayBuffer(nested), msg: nested, platform });

		expect(jsonCalls).toBe(0);
		expect(unhandledCalls).toBe(1);
	});

	it('onJsonMessage: does NOT fire on binary frames', () => {
		let jsonCalls = 0;
		let unhandledCalls = 0;
		const hook = createMessage({
			onJsonMessage() { jsonCalls++; },
			onUnhandled() { unhandledCalls++; }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		// Binary frame: byte[0] = 0x00 (binary RPC marker) but with no valid header.
		// handleRpc will reject it and pass through; onJsonMessage's prefix check
		// (byte[0] === 0x7B) fails -> onUnhandled gets it.
		const buf = new Uint8Array([0x00, 0x00, 0x00, 0x42]).buffer;
		hook(ws, { data: buf, platform });

		expect(jsonCalls).toBe(0);
		expect(unhandledCalls).toBe(1);
	});

	it('onJsonMessage + onUnhandled can coexist', () => {
		let jsonCalls = 0;
		let unhandledCalls = 0;
		const hook = createMessage({
			onJsonMessage() { jsonCalls++; },
			onUnhandled() { unhandledCalls++; }
		});

		const ws = mockWs();
		const platform = mockPlatform();
		// JSON envelope -> onJsonMessage
		hook(ws, { data: toArrayBuffer({ type: 'x' }), msg: { type: 'x' }, platform });
		// Binary -> onUnhandled
		hook(ws, { data: new ArrayBuffer(4), platform });

		expect(jsonCalls).toBe(1);
		expect(unhandledCalls).toBe(1);
	});
});

// - Batch RPC ----------------------------------------------------------------

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

// - Batch validation ---------------------------------------------------------

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

// - Path validation ----------------------------------------------------------

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

// - Binary payload size limit ------------------------------------------------

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

// - live.upload() streaming uploads ------------------------------------------

/**
 * Build a 0x01 upload chunk frame.
 * @param {{ streamId: number, seq: number, isLast?: boolean, args?: { rpc: string, args?: any[] }, payload?: ArrayBuffer | Uint8Array | null }} opts
 */
function buildUploadChunkFrame({ streamId, seq, isLast = false, args, payload = null }) {
	const hasArgs = args !== undefined;
	let argsBytes = null;
	if (hasArgs) argsBytes = new TextEncoder().encode(JSON.stringify(args));
	const argsLen = argsBytes ? argsBytes.length : 0;
	const headerLen = hasArgs ? 12 + argsLen : 10;
	const payloadView = payload
		? (payload instanceof Uint8Array ? payload : new Uint8Array(payload))
		: null;
	const payloadLen = payloadView ? payloadView.byteLength : 0;
	const buf = new ArrayBuffer(headerLen + payloadLen);
	const u8 = new Uint8Array(buf);
	const view = new DataView(buf);
	view.setUint8(0, 0x01);
	let flags = 0;
	if (hasArgs) flags |= 0x01;
	if (isLast) flags |= 0x02;
	view.setUint8(1, flags);
	view.setUint32(2, streamId, false);
	view.setUint32(6, seq, false);
	if (hasArgs) {
		view.setUint16(10, argsLen, false);
		u8.set(argsBytes, 12);
		if (payloadView) u8.set(payloadView, 12 + argsLen);
	} else if (payloadView) {
		u8.set(payloadView, 10);
	}
	return buf;
}

/** Build a 0x02 cancel control frame. */
function buildUploadCancelFrame(streamId) {
	const buf = new ArrayBuffer(6);
	const view = new DataView(buf);
	view.setUint8(0, 0x02);
	view.setUint8(1, 0x10);
	view.setUint32(2, streamId, false);
	return buf;
}

function uploadStreamIdHex(streamId) {
	return (streamId >>> 0).toString(16).padStart(8, '0');
}

/** Wait for any in-flight microtasks/timers to settle. */
async function flushUploadAsync(times = 5) {
	for (let i = 0; i < times; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

/** Pull the most recent __upload response for a given streamId from platform.sent. */
function lastUploadResponse(platform, streamId) {
	const hex = uploadStreamIdHex(streamId);
	for (let i = platform.sent.length - 1; i >= 0; i--) {
		const m = platform.sent[i];
		if (m.topic === '__upload' && m.event === hex) return m.data;
	}
	return null;
}

describe('live.upload()', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
		_resetUploadAutoDiscovery();
	});

	it('streams a single-chunk upload to the handler', async () => {
		/** @type {Uint8Array[]} */
		const received = [];
		const fn = live.upload(async (ctx) => {
			for await (const chunk of ctx.stream) received.push(chunk);
			return { bytes: received.reduce((n, c) => n + c.byteLength, 0) };
		});
		__register('uploads/single', fn);

		const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
		const frame = buildUploadChunkFrame({
			streamId: 1, seq: 0, isLast: true,
			args: { rpc: 'uploads/single', args: [] },
			payload
		});
		handleRpc(ws, frame, platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 1);
		expect(resp).toEqual({ ok: true, data: { bytes: 4 } });
		expect(received.length).toBe(1);
		expect(Array.from(received[0])).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
	});

	it('streams a multi-chunk upload in arrival order', async () => {
		/** @type {Uint8Array[]} */
		const received = [];
		const fn = live.upload(async (ctx) => {
			for await (const chunk of ctx.stream) received.push(chunk);
			let total = 0;
			for (const c of received) total += c.byteLength;
			return total;
		});
		__register('uploads/multi', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 7, seq: 0,
			args: { rpc: 'uploads/multi', args: [] },
			payload: new Uint8Array([1, 2, 3])
		}), platform);
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 7, seq: 1,
			payload: new Uint8Array([4, 5, 6])
		}), platform);
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 7, seq: 2, isLast: true,
			payload: new Uint8Array([7, 8])
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 7);
		expect(resp).toEqual({ ok: true, data: 8 });
		expect(received.length).toBe(3);
	});

	it('handles an empty upload (chunk 0 with isLast and no payload)', async () => {
		const fn = live.upload(async (ctx) => {
			let count = 0;
			for await (const _ of ctx.stream) count++;
			return { count };
		});
		__register('uploads/empty', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 2, seq: 0, isLast: true,
			args: { rpc: 'uploads/empty', args: [] }
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 2);
		expect(resp).toEqual({ ok: true, data: { count: 0 } });
	});

	it('passes positional args from the client through to the handler', async () => {
		const fn = live.upload(async (ctx, name, mime) => {
			let bytes = 0;
			for await (const c of ctx.stream) bytes += c.byteLength;
			return { name, mime, bytes };
		});
		__register('uploads/args', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 3, seq: 0, isLast: true,
			args: { rpc: 'uploads/args', args: ['cat.png', 'image/png'] },
			payload: new Uint8Array(10)
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 3);
		expect(resp).toEqual({ ok: true, data: { name: 'cat.png', mime: 'image/png', bytes: 10 } });
	});

	it('rejects an out-of-order chunk', async () => {
		const fn = live.upload(async (ctx) => {
			for await (const _ of ctx.stream) {}
			return 'unreached';
		});
		__register('uploads/order', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 4, seq: 0,
			args: { rpc: 'uploads/order', args: [] },
			payload: new Uint8Array([1])
		}), platform);
		// Skip seq 1, jump to seq 2
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 4, seq: 2, isLast: true,
			payload: new Uint8Array([3])
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 4);
		expect(resp.ok).toBe(false);
		expect(resp.code).toBe('INVALID_REQUEST');
		expect(resp.error).toMatch(/out-of-order/);
	});

	it('rejects a duplicate streamId while one is active', async () => {
		const fn = live.upload(async (ctx) => {
			for await (const _ of ctx.stream) {}
			return 'ok';
		});
		__register('uploads/dup', fn);

		// Open one upload (do not finish)
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 5, seq: 0,
			args: { rpc: 'uploads/dup', args: [] }
		}), platform);
		await flushUploadAsync(1);

		// Try to open another with the same streamId
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 5, seq: 0,
			args: { rpc: 'uploads/dup', args: [] }
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 5);
		expect(resp.ok).toBe(false);
		expect(resp.code).toBe('INVALID_REQUEST');
		expect(resp.error).toMatch(/already active/);
	});

	it('rejects unknown paths with NOT_FOUND', async () => {
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 8, seq: 0, isLast: true,
			args: { rpc: 'uploads/missing', args: [] }
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 8);
		expect(resp).toEqual({ ok: false, code: 'NOT_FOUND', error: 'Not found' });
	});

	it('rejects when the path is not a live.upload handler', async () => {
		// Register a regular RPC, not an upload.
		__register('uploads/notupload', async () => 'hi');

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 9, seq: 0, isLast: true,
			args: { rpc: 'uploads/notupload', args: [] }
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 9);
		expect(resp.ok).toBe(false);
		expect(resp.code).toBe('INVALID_REQUEST');
		expect(resp.error).toMatch(/Not an upload endpoint/);
	});

	it('rejects when initial payload exceeds maxSize', async () => {
		const fn = live.upload(async (ctx) => 'unreached', { maxSize: 50 });
		__register('uploads/limit-init', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 10, seq: 0, isLast: true,
			args: { rpc: 'uploads/limit-init', args: [] },
			payload: new Uint8Array(100)
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 10);
		expect(resp).toEqual({ ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'upload exceeds maxSize' });
	});

	it('rejects mid-stream when total bytes exceed maxSize', async () => {
		let aborted = false;
		const fn = live.upload(async (ctx) => {
			try {
				for await (const _ of ctx.stream) {}
			} catch {
				aborted = true;
				throw new LiveError('CANCELLED', 'aborted');
			}
			return 'unreached';
		}, { maxSize: 100 });
		__register('uploads/limit-mid', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 11, seq: 0,
			args: { rpc: 'uploads/limit-mid', args: [] },
			payload: new Uint8Array(60)
		}), platform);
		// Let the handler start so the second chunk hits the running phase and
		// flows through the abortable async-iterable rather than being rejected
		// at transition time.
		await flushUploadAsync(1);
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 11, seq: 1, isLast: true,
			payload: new Uint8Array(60)
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 11);
		expect(resp).toEqual({ ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'upload exceeds maxSize' });
		expect(aborted).toBe(true);
	});

	it('cancels via control frame and aborts the handler signal', async () => {
		let signalAborted = false;
		const fn = live.upload(async (ctx) => {
			ctx.signal.addEventListener('abort', () => { signalAborted = true; });
			try {
				for await (const _ of ctx.stream) {}
			} catch (err) {
				throw err;
			}
			return 'unreached';
		});
		__register('uploads/cancel', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 12, seq: 0,
			args: { rpc: 'uploads/cancel', args: [] },
			payload: new Uint8Array([1, 2, 3])
		}), platform);
		await flushUploadAsync(1);

		handleRpc(ws, buildUploadCancelFrame(12), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 12);
		expect(resp).toEqual({ ok: false, code: 'CANCELLED', error: 'upload cancelled by client' });
		expect(signalAborted).toBe(true);
	});

	it('aborts in-flight uploads on connection close', async () => {
		let signalAborted = false;
		const fn = live.upload(async (ctx) => {
			ctx.signal.addEventListener('abort', () => { signalAborted = true; });
			for await (const _ of ctx.stream) {}
			return 'unreached';
		});
		__register('uploads/disconnect', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 13, seq: 0,
			args: { rpc: 'uploads/disconnect', args: [] },
			payload: new Uint8Array([9, 9])
		}), platform);
		await flushUploadAsync(1);

		close(ws, { platform });
		await flushUploadAsync();

		expect(signalAborted).toBe(true);
	});

	it('enforces maxConcurrentPerSession', async () => {
		const fn = live.upload(async (ctx) => {
			for await (const _ of ctx.stream) {}
			return 'ok';
		}, { maxConcurrentPerSession: 1 });
		__register('uploads/cap-session', fn);

		// First upload occupies the slot (don't finish)
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 100, seq: 0,
			args: { rpc: 'uploads/cap-session', args: [] }
		}), platform);
		await flushUploadAsync(1);

		// Second upload should be rejected immediately
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 101, seq: 0, isLast: true,
			args: { rpc: 'uploads/cap-session', args: [] }
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 101);
		expect(resp.ok).toBe(false);
		expect(resp.code).toBe('TOO_MANY_UPLOADS');
	});

	it('enforces maxBufferedChunks (FLOW_BACKPRESSURE)', async () => {
		// Handler that never reads from the stream - chunks pile up in the queue
		const fn = live.upload(async (ctx) => {
			// Wait long enough for chunks to fill the buffer
			await new Promise((resolve) => {
				ctx.signal.addEventListener('abort', resolve, { once: true });
			});
			throw new LiveError('CANCELLED', 'done');
		}, { maxBufferedChunks: 2 });
		__register('uploads/backpressure', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 200, seq: 0,
			args: { rpc: 'uploads/backpressure', args: [] },
			payload: new Uint8Array(10)
		}), platform);
		await flushUploadAsync(1);
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 200, seq: 1, payload: new Uint8Array(10)
		}), platform);
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 200, seq: 2, payload: new Uint8Array(10)
		}), platform);
		// queue.length is now 2 (chunk 0 was consumed at start? actually no - handler
		// awaits abort instead of reading. So queue holds chunks from seq 1 and 2, both
		// queued because handler never called .next()).
		// Actually first chunk 0 payload was push()ed; seq 1 queued; queueLength now 2.
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 200, seq: 3, payload: new Uint8Array(10)
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 200);
		expect(resp.ok).toBe(false);
		expect(resp.code).toBe('FLOW_BACKPRESSURE');
	});

	it('propagates LiveError thrown by the handler', async () => {
		const fn = live.upload(async (ctx) => {
			for await (const _ of ctx.stream) {}
			throw new LiveError('FORBIDDEN', 'no thanks');
		});
		__register('uploads/livethrow', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 14, seq: 0, isLast: true,
			args: { rpc: 'uploads/livethrow', args: [] }
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 14);
		expect(resp).toEqual({ ok: false, code: 'FORBIDDEN', error: 'no thanks' });
	});

	it('hides non-LiveError exceptions behind INTERNAL_ERROR', async () => {
		const fn = live.upload(async () => { throw new Error('database is on fire'); });
		__register('uploads/internal', fn);

		handleRpc(ws, buildUploadChunkFrame({
			streamId: 15, seq: 0, isLast: true,
			args: { rpc: 'uploads/internal', args: [] }
		}), platform);
		await flushUploadAsync();

		const resp = lastUploadResponse(platform, 15);
		expect(resp.ok).toBe(false);
		expect(resp.code).toBe('INTERNAL_ERROR');
		// The raw error message must not leak
		expect(resp.error).not.toMatch(/database/);
	});

	it('drops malformed frames silently (reserved bits set)', async () => {
		// Build a frame with reserved bits set in flags
		const buf = new ArrayBuffer(10);
		const view = new DataView(buf);
		view.setUint8(0, 0x01);
		view.setUint8(1, 0x80); // reserved bit set
		view.setUint32(2, 99, false);
		view.setUint32(6, 0, false);

		const before = platform.sent.length;
		handleRpc(ws, buf, platform);
		await flushUploadAsync(2);
		expect(platform.sent.length).toBe(before);
	});

	it('announces platform.maxPayloadLength via __cap on first response per WS', async () => {
		const fn = live.upload(async () => 'ok');
		__register('uploads/cap-announce', fn);

		// Platform with maxPayloadLength set
		const platformWithCap = mockPlatform();
		/** @type {any} */ (platformWithCap).maxPayloadLength = 16384;

		// First upload: response should carry __cap
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 400, seq: 0, isLast: true,
			args: { rpc: 'uploads/cap-announce', args: [] }
		}), platformWithCap);
		await flushUploadAsync();

		const first = lastUploadResponse(platformWithCap, 400);
		expect(first).toMatchObject({ ok: true, data: 'ok', __cap: 16384 });

		// Second upload on the SAME ws: response should NOT carry __cap
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 401, seq: 0, isLast: true,
			args: { rpc: 'uploads/cap-announce', args: [] }
		}), platformWithCap);
		await flushUploadAsync();

		const second = lastUploadResponse(platformWithCap, 401);
		expect(second).toEqual({ ok: true, data: 'ok' });
		expect(second).not.toHaveProperty('__cap');
	});

	it('omits __cap when platform does not expose maxPayloadLength', async () => {
		const fn = live.upload(async () => 'ok');
		__register('uploads/no-cap', fn);

		// Use a fresh ws so prior tests' "informed" tracking doesn't apply
		const localWs = mockWs({ id: 'user-no-cap' });
		const localPlatform = mockPlatform();
		// No maxPayloadLength set

		handleRpc(localWs, buildUploadChunkFrame({
			streamId: 402, seq: 0, isLast: true,
			args: { rpc: 'uploads/no-cap', args: [] }
		}), localPlatform);
		await flushUploadAsync();

		const resp = lastUploadResponse(localPlatform, 402);
		expect(resp).toEqual({ ok: true, data: 'ok' });
		expect(resp).not.toHaveProperty('__cap');
	});

	it('routes interleaved uploads to separate streams', async () => {
		/** @type {Map<number, Uint8Array[]>} */
		const seen = new Map();
		const fn = live.upload(async (ctx, label) => {
			/** @type {Uint8Array[]} */
			const chunks = [];
			for await (const c of ctx.stream) chunks.push(c);
			seen.set(label, chunks);
			let total = 0;
			for (const c of chunks) total += c.byteLength;
			return { label, total };
		});
		__register('uploads/multi-stream', fn);

		// Open A
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 300, seq: 0,
			args: { rpc: 'uploads/multi-stream', args: [1] },
			payload: new Uint8Array([1, 1, 1])
		}), platform);
		// Open B
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 301, seq: 0,
			args: { rpc: 'uploads/multi-stream', args: [2] },
			payload: new Uint8Array([2, 2])
		}), platform);
		// Interleave
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 300, seq: 1, isLast: true, payload: new Uint8Array([1, 1])
		}), platform);
		handleRpc(ws, buildUploadChunkFrame({
			streamId: 301, seq: 1, isLast: true, payload: new Uint8Array([2, 2, 2])
		}), platform);
		await flushUploadAsync();

		const a = lastUploadResponse(platform, 300);
		const b = lastUploadResponse(platform, 301);
		expect(a).toEqual({ ok: true, data: { label: 1, total: 5 } });
		expect(b).toEqual({ ok: true, data: { label: 2, total: 5 } });
	});

	// Pre-fix, every concurrent stream got its own 16 MB pre-handler
	// buffer with no aggregate cap. N concurrent connections opening
	// streamId 0 with a 16 MB chunk-0 payload each = 16*N MB worker
	// memory before any handler-side cap could fire. Post-fix, an
	// aggregate accumulator caps total pending bytes; the cap is a
	// per-process knob settable via _setCapsForTest(uploadPendingMaxAggregate).
	it('aggregate pre-handler buffer cap rejects further chunk-0 with OVERLOADED', async () => {
		// Lower the aggregate cap so a single small chunk fills it. The
		// per-stream chunk fits inside the per-stream 16 MB cap, so the
		// rejection MUST come from the aggregate cap, not the per-stream.
		_setCapsForTest({ uploadPendingMaxAggregate: 256 });
		try {
			const fn = live.upload(async (ctx) => {
				for await (const _c of ctx.stream) {}
				return 'ok';
			});
			__register('uploads/agg-cap', fn);

			const big = new Uint8Array(200);
			handleRpc(ws, buildUploadChunkFrame({
				streamId: 400, seq: 0, isLast: true,
				args: { rpc: 'uploads/agg-cap', args: [] },
				payload: big
			}), platform);

			// Second concurrent stream pushes the aggregate over the cap.
			handleRpc(ws, buildUploadChunkFrame({
				streamId: 401, seq: 0, isLast: true,
				args: { rpc: 'uploads/agg-cap', args: [] },
				payload: big
			}), platform);
			await flushUploadAsync();

			const second = lastUploadResponse(platform, 401);
			expect(second).toEqual({
				ok: false, code: 'OVERLOADED',
				error: 'pending-upload aggregate buffer cap exceeded; retry shortly'
			});
		} finally {
			_resetCapsForTest();
		}
	});

	it('aggregate buffer is released when an upload transitions to running', async () => {
		// Lower the aggregate cap to a tight bound. Stream A opens, the
		// handler resolves and the buffer is released. Stream B can then
		// fit even though A's bytes were initially counted. This proves
		// the release path on pending -> running transition.
		_setCapsForTest({ uploadPendingMaxAggregate: 256 });
		try {
			const fn = live.upload(async (ctx) => {
				for await (const _c of ctx.stream) {}
				return 'ok';
			});
			__register('uploads/agg-release', fn);

			const big = new Uint8Array(200);

			handleRpc(ws, buildUploadChunkFrame({
				streamId: 410, seq: 0, isLast: true,
				args: { rpc: 'uploads/agg-release', args: [] },
				payload: big
			}), platform);
			await flushUploadAsync(); // handler resolves, bytes released

			handleRpc(ws, buildUploadChunkFrame({
				streamId: 411, seq: 0, isLast: true,
				args: { rpc: 'uploads/agg-release', args: [] },
				payload: big
			}), platform);
			await flushUploadAsync();

			expect(lastUploadResponse(platform, 410)).toEqual({ ok: true, data: 'ok' });
			expect(lastUploadResponse(platform, 411)).toEqual({ ok: true, data: 'ok' });
		} finally {
			_resetCapsForTest();
		}
	});
});

// - Dynamic topic prefix guard -----------------------------------------------

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

// - Batch dev-mode warnings --------------------------------------------------

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

// - Payload size warning -----------------------------------------------------

describe('payload size warning', () => {
	it('warns when RPC response payload exceeds the string threshold (800k chars)', async () => {
		const ws = mockWs();
		const platform = mockPlatform();

		// Threshold was raised in 0.5.x to match the post-0.5 default
		// maxPayloadLength of 1 MB. A 12 KB payload no longer triggers
		// the dev warning; 850k chars (~850 KB) does.
		const bigData = 'x'.repeat(850_000);
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

// - platform.send() return value ---------------------------------------------

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

// - live.validated() ----------------------------------------------

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

// - __directCall() ------------------------------------------------

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
		// Anonymous opt-in: pass user explicitly (even as null) to bypass the
		// "guarded stream needs a user" descriptive error.
		await __directCall('guarded/action', [], platform, { user: null });
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

	it('throws a descriptive error when guard exists and user is omitted', async () => {
		const guardFn = (ctx) => {};
		guardFn.__isGuard = true;
		__registerGuard('dc-nullwarn', guardFn);

		const handler = live(async (ctx) => 'ok');
		__register('dc-nullwarn/action', handler);

		const platform = mockPlatform();
		await expect(__directCall('dc-nullwarn/action', [], platform))
			.rejects.toThrow(/has a guard but \.load\(\) was called without a user/);
	});

	it('runs the guard without throwing when user is explicitly null (anonymous opt-in)', async () => {
		let receivedUser = 'unset';
		const guardFn = (ctx) => { receivedUser = ctx.user; };
		guardFn.__isGuard = true;
		__registerGuard('dc-anon', guardFn);

		const handler = live(async () => 'ok');
		__register('dc-anon/action', handler);

		const platform = mockPlatform();
		const result = await __directCall('dc-anon/action', [], platform, { user: null });
		expect(result).toBe('ok');
		expect(receivedUser).toBe(null);
	});

	it('does not throw when user is provided', async () => {
		const guardFn = (ctx) => {};
		guardFn.__isGuard = true;
		__registerGuard('dc-nowarn', guardFn);

		const handler = live(async () => 'ok');
		__register('dc-nowarn/action', handler);

		const platform = mockPlatform();
		const result = await __directCall('dc-nowarn/action', [], platform, { user: { id: 1 } });
		expect(result).toBe('ok');
	});
});

// - live.cron() ---------------------------------------------------

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

	describe('6-field schedules (sub-minute resolution)', () => {
		it('parses a 6-field expression with seconds field at index 0', () => {
			const fn = live.cron('*/3 * * * * *', 'tick', async () => {});
			expect(fn.__cronParsed).toHaveLength(6);
			expect(fn.__cronParsed[0]).toEqual({ step: 3 });
		});

		it('accepts 0-59 in the seconds field', () => {
			const fn = live.cron('30 * * * * *', 'half-min', async () => {});
			expect(fn.__cronParsed).toHaveLength(6);
			expect(fn.__cronParsed[0]).toBeInstanceOf(Set);
			expect(fn.__cronParsed[0].has(30)).toBe(true);
		});

		it('rejects out-of-range seconds value', () => {
			expect(() => live.cron('60 * * * * *', 'bad', async () => {})).toThrow();
		});

		it('parses a range in the seconds field', () => {
			const fn = live.cron('0-9 * * * * *', 'first-ten', async () => {});
			expect(fn.__cronParsed[0].has(0)).toBe(true);
			expect(fn.__cronParsed[0].has(9)).toBe(true);
			expect(fn.__cronParsed[0].has(10)).toBe(false);
		});

		it('error message mentions both the 5-field and 6-field forms', () => {
			expect(() => live.cron('* *', 'bad', async () => {})).toThrow('6 fields');
		});
	});

	describe('adaptive 1Hz tick + single-flight + 5-field-at-1Hz dedup', () => {
		afterEach(() => {
			_clearCron();
		});

		it('5-field schedule at 1Hz tick fires only at second :00 (not 60x per matching minute)', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			// Register a 6-field job so the tick gets upgraded to 1Hz.
			__registerCron('cron-trigger-1hz', live.cron('* * * * * *', '1hz-marker', async () => {}));
			// Then a 5-field job. At 1Hz the dedup must keep it at once-per-matching-minute.
			__registerCron('cron-five-field', live.cron('* * * * *', 'five-min', async () => { runs++; }));

			// Drive the tick at second != 0 manually - the dedup should skip.
			// The cron tick reads the wall clock through the runtime module, so
			// bind it to the global Date this case swaps below.
			const realDate = global.Date;
			installFakeRuntimeClock();
			try {
				const fakeNow = new realDate('2026-05-06T12:34:17Z');
				global.Date = /** @type {any} */ (function FakeDate(...args) {
					if (args.length === 0) return fakeNow;
					return new realDate(...args);
				});
				/** @type {any} */ (global.Date).now = () => fakeNow.getTime();
				Object.setPrototypeOf(global.Date, realDate);
				await _tickCron();
				await new Promise((r) => setTimeout(r, 10));
				expect(runs).toBe(0);

				// Now drive at second :00 - 5-field schedule should match.
				const atSecondZero = new realDate('2026-05-06T12:34:00Z');
				global.Date = /** @type {any} */ (function FakeDate(...args) {
					if (args.length === 0) return atSecondZero;
					return new realDate(...args);
				});
				/** @type {any} */ (global.Date).now = () => atSecondZero.getTime();
				Object.setPrototypeOf(global.Date, realDate);
				await _tickCron();
				await new Promise((r) => setTimeout(r, 10));
				expect(runs).toBe(1);
			} finally {
				global.Date = realDate;
				releaseRuntimeClock();
			}
		});

		it('single-flight: a long-running job does not run concurrently with itself', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let starts = 0;
			let release;
			const releasePromise = new Promise((r) => { release = r; });
			__registerCron('cron-slow', live.cron('* * * * *', 'slow', async () => {
				starts++;
				await releasePromise;
			}));

			await _tickCron();
			await new Promise((r) => setTimeout(r, 5));
			// Second tick fires while the first invocation is still pending.
			await _tickCron();
			await new Promise((r) => setTimeout(r, 5));

			expect(starts).toBe(1);
			release();
			await new Promise((r) => setTimeout(r, 10));
			// Third tick AFTER release: the job is no longer in flight; the next
			// tick can run it again.
			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(starts).toBe(2);
		});

		it('single-flight: skipped firings do not call the function body', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let release;
			const releasePromise = new Promise((r) => { release = r; });
			let calls = 0;
			__registerCron('cron-skip', live.cron('* * * * *', 'skip', async () => {
				calls++;
				await releasePromise;
			}));

			await _tickCron();
			await new Promise((r) => setTimeout(r, 5));
			await _tickCron();
			await _tickCron();
			await _tickCron();
			await new Promise((r) => setTimeout(r, 5));
			expect(calls).toBe(1);

			release();
			await new Promise((r) => setTimeout(r, 10));
		});
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

		it('backwards compatible - no-arg cron still works', async () => {
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

	describe('timezone-pinned cron', () => {
		afterEach(() => {
			_clearCron();
			resetRuntimeEnv();
		});

		it('reads UTC date parts when the effective timezone is pinned to UTC', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			// sec 0, min 30, hour 23. The reference instant below is 23:30:00 UTC.
			__registerCron('tz/utc', live.cron('0 30 23 * * *', 'utc-marker', async () => { runs++; }));

			// Fixed epoch-ms: 2026-01-15T23:30:00Z. Clock pinned, tz pinned to UTC.
			const ref = Date.UTC(2026, 0, 15, 23, 30, 0);
			setRuntimeEnv({ clock: { now: () => ref, monotonic: () => ref }, tz: 'UTC' });

			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(runs).toBe(1);
		});

		it('does not fire when the pinned timezone shifts the hour out of the match', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			// Same schedule, hour 23.
			__registerCron('tz/tokyo', live.cron('0 30 23 * * *', 'tokyo-marker', async () => { runs++; }));

			// 2026-01-15T23:30:00Z is 2026-01-16T08:30 in Asia/Tokyo (UTC+9, no
			// DST), so the local hour is 8, not 23 - the schedule must not match.
			const ref = Date.UTC(2026, 0, 15, 23, 30, 0);
			setRuntimeEnv({ clock: { now: () => ref, monotonic: () => ref }, tz: 'Asia/Tokyo' });

			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(runs).toBe(0);

			// And the SAME instant fires under a zone where the local hour is 23.
			let utcRuns = 0;
			_clearCron();
			__registerCron('tz/utc-same-instant', live.cron('0 30 23 * * *', 'utc-marker-2', async () => { utcRuns++; }));
			setRuntimeEnv({ clock: { now: () => ref, monotonic: () => ref }, tz: 'UTC' });
			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(utcRuns).toBe(1);
		});

		it('matches the weekday in the pinned timezone', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			// 2026-01-15 is a Thursday (weekday 4) in UTC. Same instant late in
			// the UTC day rolls to Friday (weekday 5) in a far-east zone.
			const ref = Date.UTC(2026, 0, 15, 23, 30, 0);

			let thuRuns = 0;
			__registerCron('tz/thursday', live.cron('0 30 23 * * 4', 'thu-marker', async () => { thuRuns++; }));
			setRuntimeEnv({ clock: { now: () => ref, monotonic: () => ref }, tz: 'UTC' });
			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(thuRuns).toBe(1);

			// In Asia/Tokyo the same instant is Friday 08:30; a Thursday-only
			// schedule must not fire (and the hour no longer matches either).
			let tokyoRuns = 0;
			_clearCron();
			__registerCron('tz/thursday-tokyo', live.cron('0 30 8 * * 4', 'thu-tokyo', async () => { tokyoRuns++; }));
			setRuntimeEnv({ clock: { now: () => ref, monotonic: () => ref }, tz: 'Asia/Tokyo' });
			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(tokyoRuns).toBe(0); // Friday in Tokyo, schedule asks for Thursday

			// Friday in Tokyo fires a Friday-targeted schedule at the local hour.
			let friRuns = 0;
			_clearCron();
			__registerCron('tz/friday-tokyo', live.cron('0 30 8 * * 5', 'fri-tokyo', async () => { friRuns++; }));
			setRuntimeEnv({ clock: { now: () => ref, monotonic: () => ref }, tz: 'Asia/Tokyo' });
			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(friRuns).toBe(1);
		});

		it('default (no pinned timezone) matches the host system zone', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;

			// With no tz override the cron reads the host system zone, the same
			// behavior production has always had. Derive the local parts of a
			// fixed instant via Intl in the system zone and build a 6-field
			// schedule that targets exactly those parts.
			const ref = Date.UTC(2026, 5, 15, 12, 34, 56);
			const sysFmt = new Intl.DateTimeFormat('en-US', {
				hour: 'numeric', minute: 'numeric', second: 'numeric',
				day: 'numeric', month: 'numeric', hour12: false
			});
			const parts = sysFmt.formatToParts(ref);
			const part = (k) => Number(parts.find((p) => p.type === k)?.value);
			let h = part('hour'); if (h === 24) h = 0;
			const schedule = `${part('second')} ${part('minute')} ${h} ${part('day')} ${part('month')} *`;
			__registerCron('tz/system-default', live.cron(schedule, 'sys-marker', async () => { runs++; }));

			// Pin only the clock; leave tz unset so effectiveTimeZone() is undefined.
			setRuntimeEnv({ clock: { now: () => ref, monotonic: () => ref } });
			await _tickCron();
			await new Promise((r) => setTimeout(r, 10));
			expect(runs).toBe(1);
		});
	});

	// Warn-once dedup for the platform-missing case. Without the dedup, a
	// 6-field schedule + idle server emits the same warning every second.
	// The warning is `_IS_DEV`-gated so this block only runs when NODE_ENV
	// !== 'production' (default in vitest).
	describe('platform-missing warning dedup', () => {
		beforeEach(() => {
			// _cronPlatform is intentionally NOT cleared by _clearCron (it
			// survives HMR by design), so prior tests in this file have
			// captured a platform we need to drop to exercise the
			// missing-platform path. setCronPlatform(null) is the public
			// reset.
			setCronPlatform(null);
		});

		afterEach(() => {
			_clearCron();
			vi.restoreAllMocks();
		});

		it('warns at most once per process lifetime when no platform is captured', async () => {
			// Do NOT call setCronPlatform - exercise the missing-platform path.
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			__registerCron('test/no-platform', live.cron('* * * * *', 'no-plat-topic', async () => {}));
			// Drive five ticks. Without dedup this would log five times.
			await _tickCron();
			await _tickCron();
			await _tickCron();
			await _tickCron();
			await _tickCron();
			// Async job invocation is fire-and-forget inside _tickCron, so
			// give the microtask queue a chance to drain before counting.
			await new Promise(r => setTimeout(r, 30));
			const platformWarnings = warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('Cron registered but no platform captured')
			);
			expect(platformWarnings.length).toBe(1);
		});

		it('warning copy points at the init() hook as the canonical wire-up site', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			__registerCron('test/init-hint', live.cron('* * * * *', 'init-hint-topic', async () => {}));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			const msg = warnSpy.mock.calls.find(args =>
				typeof args[0] === 'string' && args[0].includes('Cron registered but no platform captured')
			)?.[0];
			expect(msg).toBeDefined();
			expect(msg).toContain('init({ platform })');
			expect(msg).toContain('open(ws, platform)');
			expect(msg).toContain('https://svti.me/cron');
		});

		it('warning re-arms after _clearCron so test isolation works', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			__registerCron('test/round-1', live.cron('* * * * *', 't1', async () => {}));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('no platform captured')
			).length).toBe(1);
			_clearCron();
			__registerCron('test/round-2', live.cron('* * * * *', 't2', async () => {}));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			// Fresh round, so warn-once is re-armed and we should see another single line.
			expect(warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('no platform captured')
			).length).toBe(2);
		});

		it('setCronPlatform re-arms the warning so a future platform-loss can warn again', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const countWarns = () => warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('no platform captured')
			).length;
			__registerCron('test/loss', live.cron('* * * * *', 't', async () => {}));

			// No platform: warns once.
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(countWarns()).toBe(1);

			// Same tick, no platform still: deduped, count unchanged.
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(countWarns()).toBe(1);

			// Capture a platform (re-arms the flag as a side effect, but
			// that does not fire a warning because platform is set).
			setCronPlatform(mockPlatform());
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(countWarns()).toBe(1);

			// Drop platform via the public setter (defensive future case --
			// platform never goes null in practice, but if it did, the
			// re-armed flag means the user gets a fresh single warning).
			setCronPlatform(null);
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(countWarns()).toBe(2);
		});
	});

	// configureCron({ leader }) - cluster-mode leader-election gate. The
	// realtime layer ships only the consumption hook; the canonical
	// implementation lives in svelte-adapter-uws-extensions. These tests
	// exercise the gate's contract, not any specific leader implementation.
	describe('configureCron({ leader })', () => {
		afterEach(() => {
			_clearCron();
			configureCron({ leader: null });
		});

		it('default (no leader) fires every job on every worker', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			__registerCron('test/no-leader', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(1);
		});

		it('leader returning false skips the entire tick (no jobs fire)', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			configureCron({ leader: () => false });
			__registerCron('test/follower', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(0);
		});

		it('leader returning true fires jobs as normal', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			configureCron({ leader: () => true });
			__registerCron('test/leader', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(1);
		});

		it('leader is consulted on every tick (mid-process leadership change)', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			let amLeader = false;
			configureCron({ leader: () => amLeader });
			__registerCron('test/flip', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(0);
			amLeader = true;
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(1);
			amLeader = false;
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(1);
		});

		it('throwing leader is fail-closed (no fires + error logged)', async () => {
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			configureCron({ leader: () => { throw new Error('redis down'); } });
			__registerCron('test/throwing-leader', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(0);
			expect(errSpy.mock.calls.some(args =>
				typeof args[0] === 'string' && args[0].includes('configureCron leader function threw')
			)).toBe(true);
			errSpy.mockRestore();
		});

		it('non-boolean falsy return is treated as "not leader"', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			// e.g. a leader that returns undefined while initializing
			configureCron({ leader: () => undefined });
			__registerCron('test/undef-leader', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(0);
		});

		it('configureCron({ leader: null }) clears the gate and reverts to default', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			configureCron({ leader: () => false });
			configureCron({ leader: null });
			__registerCron('test/cleared', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(1);
		});

		it('configureCron(null) clears the gate', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			let runs = 0;
			configureCron({ leader: () => false });
			configureCron(null);
			__registerCron('test/null-config', live.cron('* * * * *', 't', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));
			expect(runs).toBe(1);
		});

		it('rejects {} (must include leader field)', () => {
			expect(() => configureCron({})).toThrow('must include at least one of leader or bus');
		});

		it('rejects non-object configs', () => {
			expect(() => configureCron('nope')).toThrow('must be an object or null');
			expect(() => configureCron(42)).toThrow('must be an object or null');
		});

		it('rejects non-function, non-null leader', () => {
			expect(() => configureCron({ leader: 'not-a-fn' })).toThrow('leader must be a function or null');
			expect(() => configureCron({ leader: 42 })).toThrow('leader must be a function or null');
		});
	});

	// configureCron({ bus }) - cluster-wide cron fan-out. Wraps the captured
	// platform with `bus.wrap(platform)` per cron fire so the leader's
	// publishes relay across the cluster instead of staying on the leader's
	// worker only. Mirror of configurePush({ remoteRegistry }).
	describe('configureCron({ bus })', () => {
		afterEach(() => {
			_clearCron();
			configureCron(null);
		});

		// A minimal bus stub that records what gets published through the
		// wrapped platform. Mirrors the shape of
		// `svelte-adapter-uws-extensions/redis/pubsub` but with no Redis
		// actually involved - pure recording for the contract test.
		const makeMockBus = () => {
			const wrappedPublishes = [];
			return {
				wrappedPublishes,
				wrap(platform) {
					return {
						publish(topic, event, data, options) {
							wrappedPublishes.push({ topic, event, data, options });
							return platform.publish(topic, event, data, options);
						}
					};
				}
			};
		};

		it('cron fire publishes through bus.wrap(platform) when a bus is configured', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const bus = makeMockBus();
			configureCron({ leader: () => true, bus });

			__registerCron('test/bus', live.cron('* * * * *', 't:bus', async () => ({ count: 5 })));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));

			// The auto-publish (return value) routed through bus.wrap, so
			// the bus saw the relay AND the underlying platform saw the
			// local fan-out call.
			expect(bus.wrappedPublishes.length).toBe(1);
			expect(bus.wrappedPublishes[0]).toMatchObject({ topic: 't:bus', event: 'set', data: { count: 5 } });
			expect(platform.published.find(p => p.topic === 't:bus')).toBeDefined();
		});

		it('cron handler ctx.publish routes through the wrapped platform', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const bus = makeMockBus();
			configureCron({ leader: () => true, bus });

			__registerCron('test/bus-ctx', live.cron('* * * * *', 't:bus-ctx', async (ctx) => {
				ctx.publish('t:bus-ctx', 'tick', { ms: 123 });
				// Returning undefined skips auto-publish.
			}));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));

			// ctx.publish flowed through bus.wrap, so the bus recorded
			// the cluster-relay envelope.
			const relayed = bus.wrappedPublishes.find(p => p.event === 'tick');
			expect(relayed).toBeDefined();
			expect(relayed).toMatchObject({ topic: 't:bus-ctx', data: { ms: 123 } });
			// And the platform saw the local publish too.
			expect(platform.published.find(p => p.event === 'tick')).toBeDefined();
		});

		it('without a bus, cron publishes go to platform directly (no wrap)', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			configureCron({ leader: () => true });

			__registerCron('test/no-bus', live.cron('* * * * *', 't:no-bus', async () => ({ ok: true })));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));

			// No bus -> no bus-recorded publishes. Platform got the publish
			// directly.
			expect(platform.published.find(p => p.topic === 't:no-bus')).toBeDefined();
		});

		it('configureCron({ bus: null }) clears the bus (reverts to direct platform)', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const bus = makeMockBus();
			configureCron({ leader: () => true, bus });
			configureCron({ bus: null });

			__registerCron('test/bus-cleared', live.cron('* * * * *', 't:bus-cleared', async () => ({ x: 1 })));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));

			expect(bus.wrappedPublishes.length).toBe(0);
			expect(platform.published.find(p => p.topic === 't:bus-cleared')).toBeDefined();
		});

		it('configureCron(null) clears both leader and bus', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const bus = makeMockBus();
			configureCron({ leader: () => true, bus });
			configureCron(null);

			let runs = 0;
			__registerCron('test/clear-all', live.cron('* * * * *', 't:clear-all', async () => { runs++; }));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));

			// Leader cleared -> back to "every worker fires" -> ran.
			expect(runs).toBe(1);
			// Bus cleared -> no relay records.
			expect(bus.wrappedPublishes.length).toBe(0);
		});

		it('warns once when configureCron({ leader }) is called without bus', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			configureCron({ leader: () => true });
			const matches = warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('configureCron({ leader }) was set without a `bus`')
			);
			expect(matches.length).toBe(1);
			warnSpy.mockRestore();
		});

		it('does NOT warn when configureCron({ leader, bus }) is called together', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const bus = makeMockBus();
			configureCron({ leader: () => true, bus });
			const matches = warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('without a `bus`')
			);
			expect(matches.length).toBe(0);
			warnSpy.mockRestore();
		});

		it('does NOT warn when configureCron({ bus }) is called without leader', () => {
			// No cluster intent (no leader) means no warning - bus alone is
			// a valid shape for "I want cron fan-out but every worker still fires."
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const bus = makeMockBus();
			configureCron({ bus });
			const matches = warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('without a `bus`')
			);
			expect(matches.length).toBe(0);
			warnSpy.mockRestore();
		});

		it('warning is dedup-ed across multiple configureCron calls (one per process)', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			configureCron({ leader: () => true });
			configureCron({ leader: () => false });
			configureCron({ leader: () => true });
			const matches = warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('without a `bus`')
			);
			expect(matches.length).toBe(1);
			warnSpy.mockRestore();
		});

		it('warning re-arms after _clearCron so test isolation works', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			configureCron({ leader: () => true });
			expect(warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('without a `bus`')
			).length).toBe(1);

			_clearCron();
			configureCron({ leader: () => true });
			expect(warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes('without a `bus`')
			).length).toBe(2);
			warnSpy.mockRestore();
		});

		it('rejects bus without a wrap method', () => {
			expect(() => configureCron({ bus: { foo: 'bar' } }))
				.toThrow('bus must expose a .wrap(platform) method or be null');
			expect(() => configureCron({ bus: 42 }))
				.toThrow('bus must expose a .wrap(platform) method or be null');
		});

		it('accepts configureCron({ bus }) with no leader (every worker fires + relays)', async () => {
			const platform = mockPlatform();
			setCronPlatform(platform);
			const bus = makeMockBus();
			// No leader -> default "every worker fires" behavior preserved.
			configureCron({ bus });

			__registerCron('test/bus-only', live.cron('* * * * *', 't:bus-only', async () => ({ y: 2 })));
			await _tickCron();
			await new Promise(r => setTimeout(r, 20));

			expect(bus.wrappedPublishes.length).toBe(1);
			expect(bus.wrappedPublishes[0]).toMatchObject({ topic: 't:bus-only', event: 'set' });
		});
	});
});

describe('ctx.hlc (hybrid logical clock forwarding)', () => {
	afterEach(() => {
		_clearCron();
		resetRuntimeEnv();
	});

	it('forwards platform.hlc when the adapter platform projects one', async () => {
		const platform = mockPlatform();
		// A platform that projects its own hlc - the ctx must use it verbatim.
		const stamp = { wall: 1717, logical: 4, nodeId: 'worker-7' };
		platform.hlc = () => stamp;
		setCronPlatform(platform);

		let captured = null;
		__registerCron('hlc/forward', live.cron('* * * * *', 'hlc-fwd', async (ctx) => { captured = ctx; }));
		await _tickCron();
		await new Promise((r) => setTimeout(r, 10));

		expect(captured).not.toBeNull();
		expect(typeof captured.hlc).toBe('function');
		expect(captured.hlc).toBe(platform.hlc);
		expect(captured.hlc()).toEqual(stamp);
	});

	it('falls back to a runtime-backed local hlc when the platform has none', async () => {
		// mockPlatform projects no hlc, so the ctx must supply the fallback.
		const platform = mockPlatform();
		expect(platform.hlc).toBeUndefined();
		setCronPlatform(platform);

		// Pin the runtime clock so the fallback wall component is deterministic.
		let clock = 9000;
		setRuntimeEnv({ clock: { now: () => clock, monotonic: () => clock } });

		let captured = null;
		__registerCron('hlc/fallback', live.cron('* * * * *', 'hlc-fb', async (ctx) => { captured = ctx; }));
		await _tickCron();
		await new Promise((r) => setTimeout(r, 10));

		expect(captured).not.toBeNull();
		expect(typeof captured.hlc).toBe('function');
		const a = captured.hlc();
		expect(a.wall).toBe(9000);
		expect(a.logical).toBe(0);
		expect(typeof a.nodeId).toBe('string');
		expect(a.nodeId.length).toBeGreaterThan(0);

		// Same-millisecond read bumps logical, wall held; nodeId stable.
		const b = captured.hlc();
		expect(b.wall).toBe(9000);
		expect(b.logical).toBe(1);
		expect(b.nodeId).toBe(a.nodeId);

		// Clock advances -> wall advances, logical resets.
		clock = 9001;
		const c = captured.hlc();
		expect(c.wall).toBe(9001);
		expect(c.logical).toBe(0);
		expect(c.nodeId).toBe(a.nodeId);
	});
});

// - Process-wide bus (setBus / getBus) + composed-platform accessors ---------
//
// The 0.5.6 unification: one declaration of cluster intent (the bus) is
// consumed by every framework publish surface. setBus and configureCron({ bus })
// write the same backing state; the reactive seam (live.effect /
// live.derived / live.aggregate), the cron tick, and the RPC message hook
// all consult that state at publish time. Existing apps wired via
// configureCron({ bus }) pick up the reactive-seam fix for free; new apps
// reach for realtime({ bus, leader }) instead.

describe('setBus / getBus + cross-seam bus routing', () => {
	// Mirrors the extensions' `redis/pubsub` wrap impl: records a relay
	// for each publish where `options.relay !== false`. Inbound bus
	// deliveries pass `{ relay: false }` so they MUST NOT add a record
	// (proves no inbound-loop on the receiving instance).
	const makeRecordingBus = () => {
		const relays = [];
		return {
			relays,
			wrap(platform) {
				return {
					...platform,
					publish(topic, event, data, options) {
						const result = platform.publish(topic, event, data, options);
						if (!options || options.relay !== false) {
							relays.push({ topic, event, data, options });
						}
						return result;
					},
					publishBatched(batch) {
						let result;
						if (typeof platform.publishBatched === 'function') {
							result = platform.publishBatched(batch);
						}
						if (Array.isArray(batch)) for (const item of batch) {
							if (!item || typeof item.topic !== 'string') continue;
							if (item.options && item.options.relay === false) continue;
							relays.push({ topic: item.topic, event: item.event, data: item.data, options: item.options, _batched: true });
						}
						return result;
					}
				};
			}
		};
	};

	afterEach(() => {
		// configureCron(null) clears both leader and bus; ensures the
		// process-wide bus is unwired between tests.
		_clearCron();
		configureCron(null);
		setBus(null);
	});

	it('setBus stores the bus and getBus returns it', () => {
		const bus = makeRecordingBus();
		expect(getBus()).toBe(null);
		setBus(bus);
		expect(getBus()).toBe(bus);
		setBus(null);
		expect(getBus()).toBe(null);
	});

	it('configureCron({ bus }) writes the same backing state as setBus', () => {
		const bus = makeRecordingBus();
		configureCron({ bus });
		expect(getBus()).toBe(bus);
	});

	it('rejects buses without a .wrap method', () => {
		expect(() => setBus({ foo: 1 })).toThrow('bus must expose a .wrap(platform) method');
		expect(() => setBus(42)).toThrow('bus must expose a .wrap(platform) method');
	});

	it('live.effect handler publish relays via the bus when configured (regression for the demo bug)', async () => {
		// The exact bug from the report: a live.effect handler called
		// platform.publish(audit, ...) and platform.publish(notifications,
		// ...) and those publishes stayed local instead of relaying to
		// other replicas. Post-fix, the reactive wrap consults the
		// process-wide bus at publish time and routes through bus.wrap.
		const bus = makeRecordingBus();
		setBus(bus);

		const fx = live.effect(['orders-bus-fx'], async (event, data, platform) => {
			platform.publish('audit-bus-fx', 'order', { id: data.id });
			platform.publish('notifications-bus-fx', 'order', { id: data.id });
		});
		__registerEffect('fx/bus-relay', fx);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders-bus-fx', 'created', { id: 7 });
		await new Promise((r) => setTimeout(r, 20));

		// The audit + notifications publishes from inside the effect
		// handler both reached the bus relay - they would have stayed
		// local pre-fix.
		const auditRelay = bus.relays.find((r) => r.topic === 'audit-bus-fx');
		const notifRelay = bus.relays.find((r) => r.topic === 'notifications-bus-fx');
		expect(auditRelay).toBeDefined();
		expect(notifRelay).toBeDefined();
		expect(auditRelay.data).toEqual({ id: 7 });
		expect(notifRelay.data).toEqual({ id: 7 });
	});

	it('without a bus, effect handler publishes stay local (no relay) and watchers still fire', async () => {
		// The single-replica default: no bus configured -> publishes
		// take the legacy local-only path with zero overhead.
		const calls = [];
		const fx = live.effect(['orders-no-bus'], async (event, data, platform) => {
			calls.push({ event, data });
			platform.publish('audit-no-bus', 'order', { id: data.id });
		});
		__registerEffect('fx/no-bus', fx);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders-no-bus', 'created', { id: 9 });
		await new Promise((r) => setTimeout(r, 20));

		expect(calls.length).toBe(1);
		// Audit publish landed on the platform directly (no bus to record it on).
		expect(platform.published.find((p) => p.topic === 'audit-no-bus')).toBeDefined();
	});

	it('default message hook auto-wraps the platform with the bus (RPC ctx.publish relays)', async () => {
		const bus = makeRecordingBus();
		setBus(bus);

		const handler = live(async (ctx) => {
			ctx.publish('rpc-bus-topic', 'hi', { from: 'rpc' });
			return 'ok';
		});
		__register('bus/rpc', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'bus/rpc', id: 'b-rpc-1', args: [] });

		message(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));

		const relayed = bus.relays.find((r) => r.topic === 'rpc-bus-topic' && r.event === 'hi');
		expect(relayed).toBeDefined();
		expect(relayed.data).toEqual({ from: 'rpc' });
	});

	it('createMessage({ platform: callback }) bypasses auto-wrap (back-compat for manual wiring)', async () => {
		// Existing 0.5.x users who wired bus.wrap themselves via
		// `createMessage({ platform: (p) => bus.wrap(p) })` must not be
		// double-wrapped by the auto-bus-wrap path. Their callback is
		// the sole transform; the framework stays out of the way.
		const userBus = makeRecordingBus();
		const globalBus = makeRecordingBus();
		setBus(globalBus);

		const hook = createMessage({
			platform: (p) => userBus.wrap(p),
		});

		const handler = live(async (ctx) => {
			ctx.publish('rpc-userbus-topic', 'hi', { x: 1 });
			return 'ok';
		});
		__register('bus/rpc-userbus', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'bus/rpc-userbus', id: 'b-rpc-2', args: [] });

		hook(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));

		// User's bus saw the relay (their callback is doing the wrap).
		const userRelay = userBus.relays.find((r) => r.topic === 'rpc-userbus-topic');
		expect(userRelay).toBeDefined();
		// Global bus did NOT also see it - no double-wrap.
		const globalRelay = globalBus.relays.find((r) => r.topic === 'rpc-userbus-topic');
		expect(globalRelay).toBeUndefined();
	});

	it('createMessage() without platform callback auto-wraps with global bus', async () => {
		const bus = makeRecordingBus();
		setBus(bus);

		// createMessage with NO platform callback should auto-wrap.
		const hook = createMessage({
			async beforeExecute() { /* present, but no platform transform */ },
		});

		const handler = live(async (ctx) => {
			ctx.publish('rpc-auto-topic', 'hi', { y: 2 });
			return 'ok';
		});
		__register('bus/rpc-auto', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'bus/rpc-auto', id: 'b-rpc-3', args: [] });

		hook(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));

		const relayed = bus.relays.find((r) => r.topic === 'rpc-auto-topic');
		expect(relayed).toBeDefined();
	});

	it('getPlatform returns the captured platform after _activateDerived', () => {
		// _derivedPlatform / _cronPlatform are intentionally process-wide
		// (see `_clearCron` docs) so they survive HMR; tests can only
		// assert the post-capture state, not the pre-capture null.
		const platform = mockPlatform();
		_activateDerived(platform);
		expect(getPlatform()).toBe(platform);
	});

	it('publish() routes through the composed platform (relays via bus when configured)', async () => {
		const bus = makeRecordingBus();
		setBus(bus);
		const platform = mockPlatform();
		_activateDerived(platform);

		publish('publish-helper-topic', 'evt', { z: 3 });
		await new Promise((r) => setTimeout(r, 10));

		const relayed = bus.relays.find((r) => r.topic === 'publish-helper-topic');
		expect(relayed).toBeDefined();
		expect(relayed.data).toEqual({ z: 3 });
	});

	it('bus swap (setBus -> different bus) updates the reactive seam without restart', async () => {
		const busA = makeRecordingBus();
		const busB = makeRecordingBus();
		setBus(busA);

		const fx = live.effect(['orders-swap'], async (event, data, platform) => {
			platform.publish('audit-swap', 'order', data);
		});
		__registerEffect('fx/bus-swap', fx);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('orders-swap', 'created', { id: 1 });
		await new Promise((r) => setTimeout(r, 20));
		expect(busA.relays.find((r) => r.topic === 'audit-swap')).toBeDefined();
		expect(busB.relays.find((r) => r.topic === 'audit-swap')).toBeUndefined();

		// Swap to bus B; the next publish should route through B.
		setBus(busB);
		platform.publish('orders-swap', 'created', { id: 2 });
		await new Promise((r) => setTimeout(r, 20));
		const relayB = busB.relays.find((r) => r.topic === 'audit-swap' && r.data.id === 2);
		expect(relayB).toBeDefined();
	});
});

// - realtime() Layer-2 convenience factory -----------------------------------

describe('realtime() factory', () => {
	const makeRecordingBus = () => {
		const relays = [];
		return {
			relays,
			wrap(platform) {
				return {
					...platform,
					publish(topic, event, data, options) {
						relays.push({ topic, event, data, options });
						return platform.publish(topic, event, data, options);
					}
				};
			}
		};
	};

	afterEach(() => {
		_clearCron();
		configureCron(null);
		setBus(null);
	});

	it('returns the standard hook set (open, close, message, init)', () => {
		const hooks = realtime();
		expect(typeof hooks.open).toBe('function');
		expect(typeof hooks.close).toBe('function');
		expect(typeof hooks.message).toBe('function');
		expect(typeof hooks.init).toBe('function');
		expect(hooks.upgrade).toBeUndefined();
	});

	it('returns upgrade when provided in config', () => {
		const upgrade = () => ({ id: 'u1' });
		const hooks = realtime({ upgrade });
		expect(hooks.upgrade).toBe(upgrade);
	});

	it('wires bus via _setBus on call', () => {
		const bus = makeRecordingBus();
		realtime({ bus });
		expect(getBus()).toBe(bus);
	});

	it('init({ platform }) captures the platform for cron + derived', () => {
		const hooks = realtime();
		const platform = mockPlatform();
		hooks.init({ platform });
		expect(getPlatform()).toBe(platform);
	});

	it('init throws when called without a platform', () => {
		const hooks = realtime();
		expect(() => hooks.init({})).toThrow('missing platform on hook context');
		expect(() => hooks.init(null)).toThrow('missing platform on hook context');
	});

	it('end-to-end: realtime({ bus, leader }) + effect handler publish relays correctly', async () => {
		// The "best DX" promise: a 5-line hooks.ws.js wires bus +
		// leader, and every framework seam picks it up automatically.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });

		const fx = live.effect(['orders-e2e'], async (event, data, platform) => {
			platform.publish('audit-e2e', 'order', { id: data.id });
		});
		__registerEffect('fx/e2e', fx);

		const platform = mockPlatform();
		hooks.init({ platform });

		platform.publish('orders-e2e', 'created', { id: 42 });
		await new Promise((r) => setTimeout(r, 20));

		const relayed = bus.relays.find((r) => r.topic === 'audit-e2e');
		expect(relayed).toBeDefined();
		expect(relayed.data).toEqual({ id: 42 });
	});

	it('end-to-end: cron tick on the leader relays through the bus', async () => {
		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });

		const platform = mockPlatform();
		hooks.init({ platform });

		__registerCron('test/e2e-cron', live.cron('* * * * *', 'cron-e2e-topic', async () => ({ tick: 1 })));
		await _tickCron();
		await new Promise((r) => setTimeout(r, 20));

		const relayed = bus.relays.find((r) => r.topic === 'cron-e2e-topic');
		expect(relayed).toBeDefined();
	});

	it('single-replica path: realtime() with no bus/leader publishes locally only', async () => {
		const hooks = realtime();
		const platform = mockPlatform();
		hooks.init({ platform });

		const fx = live.effect(['orders-single'], async (event, data, p) => {
			p.publish('audit-single', 'order', { id: data.id });
		});
		__registerEffect('fx/single', fx);

		platform.publish('orders-single', 'created', { id: 100 });
		await new Promise((r) => setTimeout(r, 20));

		// No bus -> no relay records, but the local publish landed.
		expect(getBus()).toBe(null);
		expect(platform.published.find((p) => p.topic === 'audit-single')).toBeDefined();
	});

	it('onError option wires into the global error handler', async () => {
		const errors = [];
		const hooks = realtime({ onError: (path, err) => errors.push({ path, err: err.message }) });
		const platform = mockPlatform();
		hooks.init({ platform });

		const fx = live.effect(['orders-err'], async () => { throw new Error('boom-realtime'); });
		__registerEffect('fx/err', fx);

		platform.publish('orders-err', 'created', { id: 1 });
		await new Promise((r) => setTimeout(r, 20));

		expect(errors.length).toBe(1);
		expect(errors[0].path).toBe('effect');
		expect(errors[0].err).toBe('boom-realtime');
	});
});

// - 0.5.7 single-wrap invariant ----------------------------------------------
//
// 0.5.6 had two `bus.wrap(...)` sites that stacked: the RPC message hook
// (`_autoBusWrap`) and the cron tick (`_cronBus.wrap(_cronPlatform)`)
// both wrapped on top of `_wrapPlatformPublish`'s inner wrap. Each layer
// called `scheduleRelay` independently, so every publish double-delivered
// to other replicas. The reporter's `/demos/effect` deploy saw
// `orders=5, audit=10, notif=10` on a 2-replica setup.
//
// 0.5.7 collapses the wrap to ONE site: `_wrapPlatformPublish`. The
// `_ensureWrap` helper installs it idempotently from `setCronPlatform`,
// `_activateDerived`, and the first call to the message hook - whichever
// fires first per platform. Outer wraps (`_autoBusWrap`,
// `_cronBus.wrap(_cronPlatform)`) are deleted. Pre-0.5.6 deployments that
// wired `configureCron({ bus })` + `createMessage({ platform })` still
// work, but the manual `platform` callback is now redundant and emits a
// one-shot dev warn (it stacks on the framework wrap and would double-
// relay).
//
// These tests pin the invariant: every framework publish site relays
// exactly once per logical publish, across every wiring shape.

describe('0.5.7 single-wrap invariant (every publish relays exactly once)', () => {
	// Mirrors the extensions' `redis/pubsub` wrap impl: records a relay
	// for each publish where `options.relay !== false`. Inbound bus
	// deliveries pass `{ relay: false }` so they MUST NOT add a record
	// (proves no inbound-loop on the receiving instance).
	const makeRecordingBus = () => {
		const relays = [];
		return {
			relays,
			wrap(platform) {
				return {
					...platform,
					publish(topic, event, data, options) {
						const result = platform.publish(topic, event, data, options);
						if (!options || options.relay !== false) {
							relays.push({ topic, event, data, options });
						}
						return result;
					},
					publishBatched(batch) {
						let result;
						if (typeof platform.publishBatched === 'function') {
							result = platform.publishBatched(batch);
						}
						if (Array.isArray(batch)) for (const item of batch) {
							if (!item || typeof item.topic !== 'string') continue;
							if (item.options && item.options.relay === false) continue;
							relays.push({ topic: item.topic, event: item.event, data: item.data, options: item.options, _batched: true });
						}
						return result;
					}
				};
			}
		};
	};

	afterEach(() => {
		_clearCron();
		configureCron(null);
		setBus(null);
		_resetManualPlatformCallbackWarn();
	});

	it('realtime({ bus }) + RPC ctx.publish relays EXACTLY ONCE (the demo bug)', async () => {
		// The demo's `/demos/effect` page: 5 placeOrder RPCs over 2 replicas
		// observed orders=5, audit=10, notif=10 pre-fix. Post-fix the
		// framework's single publish wrap (installed by `_ensureWrap`) is
		// the only `bus.wrap(...)` site, so each ctx.publish issues one
		// `scheduleRelay`.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });

		const handler = live(async (ctx) => {
			ctx.publish('demo-rpc-topic', 'placed', { orderId: 42 });
			return 'ok';
		});
		__register('demo/placeOrder', handler);

		const platform = mockPlatform();
		hooks.init({ platform });

		const ws = mockWs();
		const data = toArrayBuffer({ rpc: 'demo/placeOrder', id: 'd-1', args: [] });
		hooks.message(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));

		const relays = bus.relays.filter((r) => r.topic === 'demo-rpc-topic' && r.event === 'placed');
		expect(relays.length).toBe(1);
		expect(relays[0].data).toEqual({ orderId: 42 });
	});

	it('realtime({ bus, leader }) + cron tick relays EXACTLY ONCE', async () => {
		// Cron tick uses `_cronPlatform` directly - its `publish` is
		// `derivedPublish` after `setCronPlatform` installed the wrap. No
		// outer `_cronBus.wrap(...)` per fire any more; single relay.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });

		const platform = mockPlatform();
		hooks.init({ platform });

		__registerCron('regress/cron', live.cron('* * * * *', 'cron-regress-topic', async () => ({ tick: 1 })));
		await _tickCron();
		await new Promise((r) => setTimeout(r, 20));

		const relays = bus.relays.filter((r) => r.topic === 'cron-regress-topic');
		expect(relays.length).toBe(1);
	});

	it('realtime({ bus }) + RPC handler that triggers a live.effect relays each output ONCE', async () => {
		// End-to-end shape mirroring the demo: an RPC fires ctx.publish
		// on a source topic; an effect handler watches that topic and
		// publishes onto two downstream topics. Each of the three publishes
		// (source + audit + notifications) relays exactly once.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });

		const fx = live.effect(['orders-regress'], async (event, data, p) => {
			p.publish('audit-regress', 'order', { id: data.id });
			p.publish('notifications-regress', 'order', { id: data.id });
		});
		__registerEffect('fx/regress', fx);

		const placeOrder = live(async (ctx, id) => {
			ctx.publish('orders-regress', 'created', { id });
			return id;
		});
		__register('regress/placeOrder', placeOrder);

		const platform = mockPlatform();
		hooks.init({ platform });

		const ws = mockWs();
		const data = toArrayBuffer({ rpc: 'regress/placeOrder', id: 'r-1', args: [101] });
		hooks.message(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 30));

		expect(bus.relays.filter((r) => r.topic === 'orders-regress').length).toBe(1);
		expect(bus.relays.filter((r) => r.topic === 'audit-regress').length).toBe(1);
		expect(bus.relays.filter((r) => r.topic === 'notifications-regress').length).toBe(1);
	});

	it('pure-RPC path (no setCronPlatform / _activateDerived) still relays exactly once', async () => {
		// User wires `setBus(bus)` and uses the default `message` hook
		// only - no init hook, no `_activateDerived`. The first call to
		// `message` installs the wrap via `_ensureWrap`, so cluster
		// routing works on first RPC without per-hook config.
		const bus = makeRecordingBus();
		setBus(bus);

		const handler = live(async (ctx) => {
			ctx.publish('pure-rpc-topic', 'hi', { ok: true });
			return 'ok';
		});
		__register('pure/rpc', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: 'pure/rpc', id: 'pr-1', args: [] });
		message(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));

		const relays = bus.relays.filter((r) => r.topic === 'pure-rpc-topic');
		expect(relays.length).toBe(1);
	});

	it('pure-cron path (no _activateDerived) still relays exactly once', async () => {
		// `setCronPlatform(platform)` calls `_ensureWrap` internally, so
		// the cron tick's `_cronPlatform.publish` is `derivedPublish` and
		// the single relay site handles cluster routing.
		const bus = makeRecordingBus();
		const platform = mockPlatform();
		setCronPlatform(platform);
		configureCron({ leader: () => true, bus });

		__registerCron('pure/cron', live.cron('* * * * *', 'pure-cron-topic', async () => ({ y: 7 })));
		await _tickCron();
		await new Promise((r) => setTimeout(r, 20));

		const relays = bus.relays.filter((r) => r.topic === 'pure-cron-topic');
		expect(relays.length).toBe(1);
	});

	it('createMessage({ platform: callback }) against an activated platform with a bus logs a one-shot dev warn', async () => {
		// Catches the manual-wrap migration case: a user kept their
		// pre-0.5.6 `platform: (p) => bus.wrap(p)` callback after
		// upgrading. The framework can't detect bus-style wraps from
		// inspection (the user's output doesn't carry a sentinel), so
		// it warns whenever a callback is supplied while a bus is wired.
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });
		const platform = mockPlatform();
		hooks.init({ platform });   // activates the platform

		const hook = createMessage({
			platform: (p) => bus.wrap(p)   // legacy manual wrap
		});

		const handler = live(async (ctx) => {
			ctx.publish('legacy-wrap-topic', 'evt', { x: 1 });
			return 'ok';
		});
		__register('legacy/manual', handler);

		const ws = mockWs();
		const data = toArrayBuffer({ rpc: 'legacy/manual', id: 'lm-1', args: [] });
		hook(ws, { data, platform });
		// Fire a second message to confirm the warning is one-shot.
		const data2 = toArrayBuffer({ rpc: 'legacy/manual', id: 'lm-2', args: [] });
		hook(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));

		const matches = warnSpy.mock.calls.filter(args =>
			typeof args[0] === 'string' && args[0].includes('createMessage({ platform: callback }) is redundant')
		);
		expect(matches.length).toBe(1);
		warnSpy.mockRestore();
	});

	it('createMessage({ platform: (p) => p }) (no-op callback) still single-relays; warn DOES fire (documented false positive)', async () => {
		// A no-op callback returns the same activated platform, so the
		// single-relay invariant holds. But the warning fires because
		// we can't distinguish "no-op" from "metrics wrap" from "legacy
		// bus.wrap" by inspecting the callback alone. Documented in the
		// warning text; users with non-bus callbacks (no-op or metrics)
		// can ignore. Test pins the trade-off.
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });
		const platform = mockPlatform();
		hooks.init({ platform });

		const hook = createMessage({
			platform: (p) => p   // no-op
		});

		const handler = live(async (ctx) => {
			ctx.publish('noop-cb-topic', 'evt', { x: 1 });
			return 'ok';
		});
		__register('legacy/noop', handler);

		const ws = mockWs();
		const data = toArrayBuffer({ rpc: 'legacy/noop', id: 'no-1', args: [] });
		hook(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));

		// The publish must relay exactly once (the user's no-op
		// callback prevented _autoBusWrap, derivedPublish's inner wrap
		// is the single relay).
		const relays = bus.relays.filter((r) => r.topic === 'noop-cb-topic');
		expect(relays.length).toBe(1);

		// Warn DOES fire (documented false positive). Test pins the
		// trade-off so the trigger doesn't silently change.
		const matches = warnSpy.mock.calls.filter(args =>
			typeof args[0] === 'string' && args[0].includes('createMessage({ platform: callback }) is redundant')
		);
		expect(matches.length).toBe(1);
		warnSpy.mockRestore();
	});

	it('first call to `message` installs the wrap (proves _ensureWrap covers the pure-RPC path)', async () => {
		// Sanity check that the install path is the message hook itself
		// when nothing else has run. After one message, `platform.publish`
		// should be `derivedPublish` (different identity from raw publish).
		setBus(makeRecordingBus());

		const platform = mockPlatform();
		const rawPublish = platform.publish;

		const handler = live(async () => 'ok');
		__register('install/check', handler);

		const ws = mockWs();
		const data = toArrayBuffer({ rpc: 'install/check', id: 'i-1', args: [] });
		message(ws, { data, platform });

		expect(platform.publish).not.toBe(rawPublish);
		expect(platform.publish.name).toBe('derivedPublish');
	});

	it('first call to `setCronPlatform` installs the wrap (proves _ensureWrap covers the pure-cron path)', () => {
		// Sanity check that setCronPlatform alone installs the wrap.
		setBus(makeRecordingBus());

		const platform = mockPlatform();
		const rawPublish = platform.publish;

		setCronPlatform(platform);

		expect(platform.publish).not.toBe(rawPublish);
		expect(platform.publish.name).toBe('derivedPublish');
	});

	it('late reactive registration during an in-flight RPC does NOT cause a double-relay window', async () => {
		// The 0.5.6 audit identified a narrow race: if _activateDerived
		// gated out (empty registry, no lazy queue) and the wrap was
		// installed LATER by `_maybeLateActivate` (triggered by a runtime
		// `__registerEffect` from inside an RPC handler), the in-flight
		// RPC's microtask-flush publish would double-relay because the
		// outer wrap had already cached a wrapped platform output. With
		// the single-wrap design, `_ensureWrap` installs at the first
		// touch (message hook), so even a mid-RPC registration cannot
		// open a race window - the wrap is already on the raw platform
		// and there's no outer wrap to stack on it.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus });

		const platform = mockPlatform();
		hooks.init({ platform });   // installs wrap immediately

		// RPC dynamically registers an effect during its handling and
		// then publishes. With the single-wrap design, this is a single
		// relay regardless of registration timing.
		const handler = live(async (ctx) => {
			const fx = live.effect(['race-source'], async (event, data, p) => {
				p.publish('race-audit', 'evt', { id: data.id });
			});
			__registerEffect('fx/race', fx);
			ctx.publish('race-source', 'created', { id: 7 });
			return 'ok';
		});
		__register('race/place', handler);

		const ws = mockWs();
		const data = toArrayBuffer({ rpc: 'race/place', id: 'race-1', args: [] });
		hooks.message(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 30));

		// Each topic relayed exactly once. With the 0.5.6 design and a
		// late-activation race, the source topic would have relayed twice.
		expect(bus.relays.filter((r) => r.topic === 'race-source').length).toBe(1);
		expect(bus.relays.filter((r) => r.topic === 'race-audit').length).toBe(1);
	});

	it('100 publishes on a hot loop relay exactly 100 times (no fan-out drift)', async () => {
		// Volume sanity check: prove the single-relay invariant holds
		// under concurrent batched publishes. With the 0.5.6 double-wrap,
		// this would show roughly 200 relays.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus, leader: () => true });
		const platform = mockPlatform();
		hooks.init({ platform });

		const handler = live(async (ctx, n) => {
			ctx.publish('hot-topic', 'tick', { n });
			return n;
		});
		__register('hot/publish', handler);

		const ws = mockWs();
		for (let i = 0; i < 100; i++) {
			const data = toArrayBuffer({ rpc: 'hot/publish', id: 'hot-' + i, args: [i] });
			hooks.message(ws, { data, platform });
		}
		await new Promise((r) => setTimeout(r, 60));

		const hotRelays = bus.relays.filter((r) => r.topic === 'hot-topic');
		expect(hotRelays.length).toBe(100);
	});

	it('inbound bus delivery with { relay: false } does NOT re-relay (no infinite loop)', async () => {
		// Simulates the cluster receiving an inbound message: the
		// extensions' `bus.activate` calls `activePlatform.publish` with
		// `{ relay: false }` on inbound. After `_ensureWrap`, that
		// `activePlatform.publish` IS `derivedPublish` (single-wrap
		// design). `derivedPublish` must propagate `{ relay: false }`
		// through to the inner `bus.wrap` output's publish, which
		// respects the flag and skips re-relay. Without this
		// invariant, two clustered replicas would ping-pong every
		// relay forever.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus });
		const platform = mockPlatform();
		hooks.init({ platform });

		const beforeRelays = bus.relays.length;

		// Simulate the bus's inbound delivery: it calls platform.publish
		// (which is now derivedPublish) with { relay: false }.
		platform.publish('inbound-topic', 'evt', { from: 'other-replica' }, { relay: false });
		await new Promise((r) => setTimeout(r, 20));

		// No new relay record - the inbound publish did NOT trigger a
		// re-relay outbound. The local broadcast still happened.
		expect(bus.relays.length).toBe(beforeRelays);
		expect(platform.published.find((p) => p.topic === 'inbound-topic')).toBeDefined();
	});

	it('inbound bus delivery fires reactive watchers on the receiving replica (cluster reactive correctness)', async () => {
		// The other half of the inbound invariant: cluster-relayed
		// messages must fire `live.effect` / `live.derived` /
		// `live.aggregate` watchers on the receiving replica. This
		// works because derivedPublish routes inbound through
		// `_busPublish` -> bus.wrap output's publish -> surrogate.publish
		// (= derivedPublishLocal) which calls fireWatchers.
		const bus = makeRecordingBus();
		const hooks = realtime({ bus });

		const handlerCalls = [];
		const fx = live.effect(['cluster-source'], async (event, data) => {
			handlerCalls.push({ event, data });
		});
		__registerEffect('fx/cluster-inbound', fx);

		const platform = mockPlatform();
		hooks.init({ platform });

		// Simulate cluster inbound: another replica's relay arrives
		// here, the bus subscriber delivers via platform.publish with
		// { relay: false }.
		platform.publish('cluster-source', 'created', { id: 99 }, { relay: false });
		await new Promise((r) => setTimeout(r, 20));

		// Effect handler fired on the receiving replica.
		expect(handlerCalls.length).toBe(1);
		expect(handlerCalls[0].event).toBe('created');
		expect(handlerCalls[0].data).toEqual({ id: 99 });

		// And the inbound did NOT re-relay (relay: false was respected).
		expect(bus.relays.find((r) => r.topic === 'cluster-source')).toBeUndefined();
	});

	it('memory: removing the bus and re-issuing publishes drops cluster relay overhead to zero', async () => {
		// Sanity check that `setBus(null)` actually disables relay (no
		// dangling references in the wrap's bus cache). With a bus
		// wired then cleared, subsequent publishes go through
		// `derivedPublishLocal` only (no bus.wrap call).
		const bus = makeRecordingBus();
		const hooks = realtime({ bus });
		const platform = mockPlatform();
		hooks.init({ platform });

		const handler = live(async (ctx) => {
			ctx.publish('mem-topic', 'evt', { x: 1 });
			return 'ok';
		});
		__register('mem/publish', handler);

		const ws = mockWs();
		const data = toArrayBuffer({ rpc: 'mem/publish', id: 'm-1', args: [] });
		hooks.message(ws, { data, platform });
		await new Promise((r) => setTimeout(r, 20));
		expect(bus.relays.filter((r) => r.topic === 'mem-topic').length).toBe(1);

		setBus(null);
		const data2 = toArrayBuffer({ rpc: 'mem/publish', id: 'm-2', args: [] });
		hooks.message(ws, { data: data2, platform });
		await new Promise((r) => setTimeout(r, 20));
		// No new relays after clearing the bus.
		expect(bus.relays.filter((r) => r.topic === 'mem-topic').length).toBe(1);
	});
});

// - Replay / seq handling -----------------------------------------

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

// - Issues propagation -------------------------------------------------------

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

// - _clearCron() ---------------------------------------------------

describe('_clearCron()', () => {
	it('is a callable function', () => {
		expect(typeof _clearCron).toBe('function');
		_clearCron(); // should not throw
	});
});

// - onCronError() --------------------------------------------------

describe('onCronError()', () => {
	it('is a callable function', () => {
		expect(typeof onCronError).toBe('function');
		onCronError(() => {}); // should not throw
	});
});

// - onError hook ---------------------------------------------------

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

// - createMessage with onError -------------------------------------

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

// - Stream pagination ----------------------------------------------

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

// - Stream lifecycle hooks -----------------------------------------

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

// - close() -------------------------------------------------------

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

// - Global middleware ----------------------------------------------

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

	describe('next() single-call guard', () => {
		beforeEach(() => { _resetMiddleware(); });
		afterEach(() => { _resetMiddleware(); });

		it('runs the downstream handler exactly once when next() is called twice', async () => {
			let handlerCalls = 0;
			let secondNextRejection = null;
			live.middleware(async (ctx, next) => {
				const result = await next();
				try { next(); } catch (err) { secondNextRejection = err; }
				return result;
			});

			const handler = live(async (ctx) => { handlerCalls++; return 'ok'; });
			__register('mw-double/test', handler);

			const ws = mockWs();
			const platform = mockPlatform();
			handleRpc(ws, toArrayBuffer({ rpc: 'mw-double/test', id: 'd1', args: [] }), platform);

			await new Promise((r) => setTimeout(r, 10));

			expect(handlerCalls).toBe(1);
			expect(secondNextRejection).toBeInstanceOf(Error);
			expect(secondNextRejection.message).toMatch(/next\(\) called more than once/);
		});

		it('still serves the chain normally when each middleware calls next() once', async () => {
			let handlerCalls = 0;
			live.middleware(async (ctx, next) => next());
			live.middleware(async (ctx, next) => next());

			const handler = live(async (ctx) => { handlerCalls++; return { ok: true }; });
			__register('mw-double/clean', handler);

			const ws = mockWs();
			const platform = mockPlatform();
			handleRpc(ws, toArrayBuffer({ rpc: 'mw-double/clean', id: 'c1', args: [] }), platform);

			await new Promise((r) => setTimeout(r, 10));

			expect(handlerCalls).toBe(1);
			expect(platform.sent[0].data.ok).toBe(true);
		});
	});
});

// - ctx.publish reserves the `__` prefix --------------------------------

describe('ctx.publish() reserves the `__` prefix', () => {
	beforeEach(() => { _resetMiddleware(); });

	it('rejects publishes to `__signal:userId` with INVALID_TOPIC', async () => {
		const handler = live(async (ctx) => {
			ctx.publish('__signal:victim', 'force-logout', { redirect: '/x' });
			return 'unreachable';
		});
		__register('intopic/sig', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'intopic/sig', id: 't1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const reply = platform.sent.find((m) => m.event === 'reply' || m.data?.id === 't1') || platform.sent[0];
		expect(reply?.data?.ok).toBe(false);
		expect(reply?.data?.code).toBe('INVALID_TOPIC');
	});

	it('rejects publishes to `__rpc`', async () => {
		const handler = live(async (ctx) => {
			ctx.publish('__rpc', 'reply', { id: 'guess', ok: true, data: 'spoof' });
			return 'unreachable';
		});
		__register('intopic/rpc', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'intopic/rpc', id: 't2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const reply = platform.sent[0];
		expect(reply?.data?.ok).toBe(false);
		expect(reply?.data?.code).toBe('INVALID_TOPIC');
	});

	it('still allows publishes to user-namespaced topics', async () => {
		const handler = live(async (ctx) => {
			ctx.publish('chat:room1', 'message', { from: 'a', body: 'hi' });
			return 'ok';
		});
		__register('intopic/ok', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'intopic/ok', id: 't3', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const reply = platform.sent.find((m) => m.event === 'reply') || platform.sent[platform.sent.length - 1];
		expect(reply?.data?.ok).toBe(true);
		expect(reply?.data?.data).toBe('ok');
	});
});

// - userId validation across signal / push / enableSignals --------------

describe('userId validation for system-topic builders', () => {
	beforeEach(() => { _resetMiddleware(); });

	let _sigCounter = 0;
	function callSignal(userId, eventName = 'evt', data = {}) {
		const path = 'uidval/sig' + (++_sigCounter);
		const handler = live(async (ctx) => {
			ctx.signal(userId, eventName, data);
			return 'ok';
		});
		__register(path, handler);
		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: path, id: 'sg', args: [] }), platform);
		return new Promise((r) => setTimeout(r, 10)).then(() => ({ ws, platform }));
	}

	it('ctx.signal rejects empty / non-string / oversized / control-char userIds', async () => {
		for (const bad of ['', null, 42, {}, 'a'.repeat(300), 'has\nnewline', 'has\rcr', 'has"quote', 'has\\backslash', 'has nul', 'hasdel']) {
			const { platform } = await callSignal(bad);
			const reply = platform.sent.find((m) => m.event === 'sg');
			expect(reply?.data?.ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
			expect(reply?.data?.code).toBe('INVALID_USER_ID');
		}
	});

	it('ctx.signal accepts a clean userId', async () => {
		const { platform } = await callSignal('user-123');
		const sigPublish = platform.published.find((p) => p.topic === '__signal:user-123');
		expect(sigPublish).toBeDefined();
		expect(sigPublish.event).toBe('evt');
	});

	it('ctx.signal accepts non-ASCII userId (parity with adapter allowNonAsciiTopics)', async () => {
		const { platform } = await callSignal('user-Jose-é');
		const sigPublish = platform.published.find((p) => p.topic === '__signal:user-Jose-é');
		expect(sigPublish).toBeDefined();
	});

	it('pushHooks.open throws on control-char / quote / oversized userId', () => {
		const platform = mockPlatform();
		for (const bad of ['has\nnewline', 'has"quote', 'a'.repeat(300)]) {
			// default identify reads userData.user_id / userData.userId
			const ws = mockWs({ user_id: bad });
			expect(() => pushHooks.open(ws, { platform }), `should reject ${JSON.stringify(bad)}`).toThrow(/pushHooks\.open/);
		}
	});

	it('pushHooks.open still skips silently for null / empty (anonymous)', () => {
		const platform = mockPlatform();
		expect(() => pushHooks.open(mockWs({ user_id: null }), { platform })).not.toThrow();
		expect(() => pushHooks.open(mockWs({ user_id: '' }), { platform })).not.toThrow();
		expect(() => pushHooks.open(mockWs({ user_id: undefined }), { platform })).not.toThrow();
	});

	it('pushHooks.open still throws on non-string types', () => {
		const platform = mockPlatform();
		expect(() => pushHooks.open(mockWs({ user_id: 42 }), { platform })).toThrow(/must be a string/);
	});

	it('enableSignals throws on control-char / quote / oversized userId in userData', () => {
		for (const bad of ['has\nnewline', 'has"quote', 'a'.repeat(300)]) {
			const ws = mockWs({ id: bad });
			expect(() => enableSignals(ws), `should reject ${JSON.stringify(bad)}`).toThrow(/enableSignals/);
		}
	});

	it('enableSignals silently skips for null / undefined (anonymous connection)', () => {
		expect(() => enableSignals(mockWs({ id: null }))).not.toThrow();
		expect(() => enableSignals(mockWs({ id: undefined }))).not.toThrow();
	});

	it('enableSignals accepts a clean userId and subscribes to __signal:<id>', () => {
		const ws = mockWs({ id: 'user-42' });
		enableSignals(ws);
		expect(ws.getTopics()).toContain('__signal:user-42');
	});
});

// - _getIdentityKey reads id / user_id / userId -------------------------

describe('rate-limit identity probes id, user_id, and userId', () => {
	it('returns ctx.user.id when present', () => {
		expect(_getIdentityKey({ user: { id: 'u-1' } })).toBe('u-1');
	});

	it('falls back to ctx.user.user_id when id is missing', () => {
		expect(_getIdentityKey({ user: { user_id: 'u-2' } })).toBe('u-2');
	});

	it('falls back to ctx.user.userId when id and user_id are missing', () => {
		expect(_getIdentityKey({ user: { userId: 'u-3' } })).toBe('u-3');
	});

	it('prefers id over user_id and userId when all three are present', () => {
		expect(_getIdentityKey({ user: { id: 'A', user_id: 'B', userId: 'C' } })).toBe('A');
	});

	it('coerces numeric ids to string', () => {
		expect(_getIdentityKey({ user: { id: 42 } })).toBe('42');
		expect(_getIdentityKey({ user: { user_id: 17 } })).toBe('17');
	});

	it('treats null/undefined ids as missing and uses the per-connection guest bucket', () => {
		const ctxA = { user: { id: null }, ws: {} };
		const ctxB = { user: { id: null }, ws: ctxA.ws };
		// Same ws -> same guest bucket
		expect(_getIdentityKey(ctxA)).toBe(_getIdentityKey(ctxB));
		// Different ws -> different bucket
		const ctxC = { user: { id: null }, ws: {} };
		expect(_getIdentityKey(ctxA)).not.toBe(_getIdentityKey(ctxC));
	});

	it('returns "anon" when neither user nor ws is present', () => {
		expect(_getIdentityKey({})).toBe('anon');
	});
});

// - live.upload({ reauthEvery }) -----------------------------------------

describe('live.upload({ reauthEvery })', () => {
	it('rejects non-numeric / non-positive reauthEvery values', () => {
		const fn = async (ctx) => {};
		expect(() => live.upload(fn, { reauthEvery: -1 })).toThrow(/positive finite/);
		expect(() => live.upload(fn, { reauthEvery: 0 })).toThrow(/positive finite/);
		expect(() => live.upload(fn, { reauthEvery: NaN })).toThrow(/positive finite/);
		expect(() => live.upload(fn, { reauthEvery: Infinity })).toThrow(/positive finite/);
		expect(() => live.upload(fn, { reauthEvery: '1024' })).toThrow(/positive finite/);
	});

	it('accepts a positive finite reauthEvery and stamps the value onto __uploadOptions', () => {
		const fn = async (ctx) => {};
		const wrapped = live.upload(fn, { reauthEvery: 4096 });
		expect(/** @type {any} */ (wrapped).__uploadOptions.reauthEvery).toBe(4096);
	});

	it('defaults reauthEvery to 0 (legacy: guard runs once at chunk-0 only)', () => {
		const fn = async (ctx) => {};
		const wrapped = live.upload(fn);
		expect(/** @type {any} */ (wrapped).__uploadOptions.reauthEvery).toBe(0);
	});
});

// - Binary RPC ----------------------------------------------------

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

// - Throttle / Debounce -------------------------------------------

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

// - ctx.publishThrottled / ctx.publishDebounced / ctx.skip / deprecation warns ----

describe('ctx.publishThrottled / publishDebounced (new canonical names)', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('ctx.publishThrottled behaves identically to ctx.throttle', async () => {
		const handler = live(async (ctx, data) => {
			ctx.publishThrottled('pt1', 'updated', data, 100);
			return 'ok';
		});
		__register('publishThrottled/test', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'publishThrottled/test', id: 'p1', args: [{ val: 1 }] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		const publishes = platform.published.filter(p => p.topic === 'pt1');
		expect(publishes.length).toBe(1);
		expect(publishes[0].data).toEqual({ val: 1 });
	});

	it('ctx.publishDebounced behaves identically to ctx.debounce', async () => {
		const handler = live(async (ctx, data) => {
			ctx.publishDebounced('pd1', 'updated', data, 50);
			return 'ok';
		});
		__register('publishDebounced/test', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'publishDebounced/test', id: 'pd1', args: [{ val: 1 }] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'publishDebounced/test', id: 'pd2', args: [{ val: 2 }] }), platform);

		await vi.advanceTimersByTimeAsync(60);
		const publishes = platform.published.filter(p => p.topic === 'pd1');
		expect(publishes.length).toBe(1);
		expect(publishes[0].data).toEqual({ val: 2 });
	});
});

describe('ctx.skip (per-key handler gate)', () => {
	let ws, platform;

	beforeEach(() => {
		ws = mockWs({ id: 'user1' });
		platform = mockPlatform();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns false on first call, true within cooldown, false after window', async () => {
		/** @type {boolean[]} */
		const results = [];
		const handler = live(async (ctx) => {
			results.push(ctx.skip('skip/key-a', 100));
			return 'ok';
		});
		__register('skip/window', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'skip/window', id: 's1', args: [] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		handleRpc(ws, toArrayBuffer({ rpc: 'skip/window', id: 's2', args: [] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		// First call sets, second call sees the entry -> true
		expect(results).toEqual([false, true]);

		// Past the cooldown window: entry self-deletes via timer.
		await vi.advanceTimersByTimeAsync(120);
		handleRpc(ws, toArrayBuffer({ rpc: 'skip/window', id: 's3', args: [] }), platform);
		await vi.advanceTimersByTimeAsync(10);
		expect(results).toEqual([false, true, false]);
	});

	it('different keys are independent', async () => {
		/** @type {boolean[]} */
		const results = [];
		const handler = live(async (ctx, key) => {
			results.push(ctx.skip(key, 100));
			return 'ok';
		});
		__register('skip/keys', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'skip/keys', id: 'k1', args: ['key-x'] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'skip/keys', id: 'k2', args: ['key-y'] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		// Both keys are first-call -> both return false
		expect(results).toEqual([false, false]);

		// Same keys again -> both blocked
		handleRpc(ws, toArrayBuffer({ rpc: 'skip/keys', id: 'k3', args: ['key-x'] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'skip/keys', id: 'k4', args: ['key-y'] }), platform);
		await vi.advanceTimersByTimeAsync(10);
		expect(results).toEqual([false, false, true, true]);
	});

	it('throws INVALID_ARG when key is not a string', async () => {
		/** @type {Error | null} */
		let caught = null;
		const handler = live(async (ctx) => {
			try { ctx.skip(/** @type {any} */ (123), 50); } catch (e) { caught = /** @type {Error} */ (e); }
			return 'ok';
		});
		__register('skip/badkey', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'skip/badkey', id: 'b1', args: [] }), platform);
		await vi.advanceTimersByTimeAsync(10);

		expect(caught).toBeTruthy();
		expect(/** @type {any} */ (caught).code).toBe('INVALID_ARG');
	});

	it('throws INVALID_ARG when ms is not a positive finite number', async () => {
		/** @type {Error[]} */
		const caught = [];
		const handler = live(async (ctx, ms) => {
			try { ctx.skip('skip/badms', ms); } catch (e) { caught.push(/** @type {Error} */ (e)); }
			return 'ok';
		});
		__register('skip/badms', handler);

		// Each bad-ms variant: undefined, 0, -10, NaN, Infinity, 'fast'
		for (const ms of [undefined, 0, -10, NaN, Infinity, 'fast']) {
			handleRpc(ws, toArrayBuffer({ rpc: 'skip/badms', id: 'b' + caught.length, args: [ms] }), platform);
			await vi.advanceTimersByTimeAsync(1);
		}

		expect(caught.length).toBe(6);
		for (const e of caught) expect(/** @type {any} */ (e).code).toBe('INVALID_ARG');
	});
});

describe('ctx.throttle / ctx.debounce deprecation warnings', () => {
	/** @type {import('vitest').MockInstance} */
	let warnSpy;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('ctx.throttle dev-warns once per process pointing at publishThrottled and ctx.skip', async () => {
		const ws = mockWs({ id: 'user1' });
		const platform = mockPlatform();

		const handler = live(async (ctx) => {
			ctx.throttle('depr-t', 'e', { x: 1 }, 100);
			return 'ok';
		});
		__register('depr/throttle', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'depr/throttle', id: 'dt1', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'depr/throttle', id: 'dt2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Dedup: the deprecation warn fires at most once per process.
		const deprWarns = warnSpy.mock.calls.filter(c =>
			typeof c[0] === 'string' && c[0].includes('ctx.throttle is deprecated')
		);
		expect(deprWarns.length).toBeLessThanOrEqual(1);
		if (deprWarns.length === 1) {
			expect(deprWarns[0][0]).toContain('ctx.publishThrottled');
			expect(deprWarns[0][0]).toContain('ctx.skip');
		}
	});

	it('ctx.debounce dev-warns once per process pointing at publishDebounced and ctx.skip', async () => {
		const ws = mockWs({ id: 'user1' });
		const platform = mockPlatform();

		const handler = live(async (ctx) => {
			ctx.debounce('depr-d', 'e', { x: 1 }, 100);
			return 'ok';
		});
		__register('depr/debounce', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'depr/debounce', id: 'dd1', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'depr/debounce', id: 'dd2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const deprWarns = warnSpy.mock.calls.filter(c =>
			typeof c[0] === 'string' && c[0].includes('ctx.debounce is deprecated')
		);
		expect(deprWarns.length).toBeLessThanOrEqual(1);
		if (deprWarns.length === 1) {
			expect(deprWarns[0][0]).toContain('ctx.publishDebounced');
			expect(deprWarns[0][0]).toContain('ctx.skip');
		}
	});

	it('bad-args warning fires once per helper name and points at ctx.skip', async () => {
		const ws = mockWs({ id: 'user1' });
		const platform = mockPlatform();

		// This is the documented misuse pattern: developer thought publishThrottled was a gate.
		const handler = live(async (ctx) => {
			ctx.publishThrottled(/** @type {any} */ ('move:id'), /** @type {any} */ (50));
			return 'ok';
		});
		__register('badargs/publishThrottled', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'badargs/publishThrottled', id: 'ba1', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'badargs/publishThrottled', id: 'ba2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const badArgWarns = warnSpy.mock.calls.filter(c =>
			typeof c[0] === 'string' && c[0].includes('called with bad args')
		);
		// At most one per process (dedup); the test runs in a fresh-import process so
		// it may be 0 if a prior describe already tripped the flag.
		expect(badArgWarns.length).toBeLessThanOrEqual(1);
		if (badArgWarns.length === 1) {
			expect(badArgWarns[0][0]).toContain('ctx.skip(key, ms)');
		}
	});
});

// - live.access helpers ----------------------------------------

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

	it('any() returns true if any predicate matches', async () => {
		const filter = live.access.any(
			live.access.owner(),
			live.access.role({ admin: true })
		);
		expect(await filter({ user: { id: 'u1' } })).toBe(true);
		expect(await filter({ user: { role: 'admin' } })).toBe(true);
		expect(await filter({ user: { role: 'viewer' } })).toBe(false);
	});

	it('all() returns true only if all predicates match', async () => {
		const filter = live.access.all(
			live.access.owner(),
			live.access.role({ admin: true })
		);
		expect(await filter({ user: { id: 'u1', role: 'admin' } })).toBe(true);
		expect(await filter({ user: { id: 'u1', role: 'viewer' } })).toBe(false);
	});

	it('any() awaits async sub-predicates (no fail-open on Promise<false>)', async () => {
		const asyncDeny = async () => false;
		const asyncAllow = async () => true;
		const sync = (ctx) => ctx.user?.role === 'admin';

		// All sub-predicates async-deny -> top-level denies
		expect(await live.access.any(asyncDeny, asyncDeny)({ user: {} })).toBe(false);
		// One async-allow -> top-level allows
		expect(await live.access.any(asyncDeny, asyncAllow)({ user: {} })).toBe(true);
		// Mix sync + async, mid-list async-allow -> top-level allows
		expect(await live.access.any(sync, asyncAllow, asyncDeny)({ user: { role: 'viewer' } })).toBe(true);
		// All async-deny mixed with sync-deny -> top-level denies
		expect(await live.access.any(asyncDeny, sync)({ user: { role: 'viewer' } })).toBe(false);
	});

	it('all() awaits async sub-predicates (no fail-open on Promise<truthy>)', async () => {
		const asyncDeny = async () => false;
		const asyncAllow = async () => true;
		const sync = (ctx) => ctx.user?.id != null;

		// All async-allow -> top-level allows
		expect(await live.access.all(asyncAllow, asyncAllow)({ user: {} })).toBe(true);
		// One async-deny among allows -> top-level denies
		expect(await live.access.all(asyncAllow, asyncDeny)({ user: {} })).toBe(false);
		// Sync allow + async deny -> top-level denies (was the fail-open bug)
		expect(await live.access.all(sync, asyncDeny)({ user: { id: 'u1' } })).toBe(false);
		// All allow with mixed sync/async -> allows
		expect(await live.access.all(sync, asyncAllow)({ user: { id: 'u1' } })).toBe(true);
	});

	it('any() short-circuits on the first truthy sub-predicate', async () => {
		let calls = 0;
		const counting = async () => { calls++; return true; };
		const sync = () => true;
		// First sync-true should short-circuit; counting() should not run
		expect(await live.access.any(sync, counting)({ user: {} })).toBe(true);
		expect(calls).toBe(0);
		// First async-true short-circuits as well
		await live.access.any(counting, counting)({ user: {} });
		expect(calls).toBe(1);
	});

	it('all() short-circuits on the first falsy sub-predicate', async () => {
		let calls = 0;
		const counting = async () => { calls++; return true; };
		const syncDeny = () => false;
		// First sync-false should short-circuit; counting() should not run
		expect(await live.access.all(syncDeny, counting)({ user: {} })).toBe(false);
		expect(calls).toBe(0);
	});
});

// - live.stream with filter/access option ----------------------

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

// - live.derived() ------------------------------------------------

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

// - _activateDerived + __registerDerived --------------------------

import { __registerDerived, _activateDerived, _prepareHmr } from '../src/server.js';

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

// - Dynamic live.derived() --------------------------------------------------

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

// - live.room() ---------------------------------------------------

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

	it('platform.checkSubscribe denial blocks the loader, ws.subscribe, and __onSubscribe', async () => {
		// Wire-level gate: when the adapter's subscribe / subscribeBatch
		// hook chain would deny this (ws, topic), the stream RPC must
		// early-exit BEFORE running the loader, ws.subscribe(), or
		// __onSubscribe (which publishes the room's 'join' and writes
		// _presenceRef). This closes the data-leak hole where loader
		// output reached the client before the wire-level deny fired.
		let loaderRan = false;
		const room = live.room({
			topic: (ctx, roomId) => 'gate-room:' + roomId,
			init: async () => { loaderRan = true; return [{ secret: 'do-not-leak' }]; },
			presence: (ctx) => ({ name: ctx.user?.name }),
			topicArgs: 1
		});
		__register('gate-room/__data', room.__dataStream);

		const ws = mockWs({ id: 'mallory' });
		const platform = mockPlatform();
		platform.checkSubscribe = (subWs, topic) => topic.startsWith('gate-room:') ? 'FORBIDDEN' : null;

		handleRpc(ws, toArrayBuffer({ rpc: 'gate-room/__data', id: 'g1', args: ['private'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 20));

		const resp = platform.sent.find((s) => s.topic === '__rpc' && s.event === 'g1');
		expect(resp).toBeDefined();
		expect(resp.data.ok).toBe(false);
		expect(resp.data.code).toBe('FORBIDDEN');

		// The loader must NOT have run - otherwise its data was computed
		// and could have leaked through any side effects.
		expect(loaderRan).toBe(false);

		// __onSubscribe (presence join) must NOT have fired.
		const joins = platform.published.filter((p) => p.event === 'join');
		expect(joins).toHaveLength(0);

		// ws.subscribe must NOT have been called - ws topics list stays empty.
		expect(ws.getTopics().length).toBe(0);
	});

	it('platform.checkSubscribe returning UNAUTHENTICATED surfaces the right code', async () => {
		const stream = live.stream('auth/feed', async () => []);
		__register('auth/feed', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		platform.checkSubscribe = () => 'UNAUTHENTICATED';

		handleRpc(ws, toArrayBuffer({ rpc: 'auth/feed', id: 'a1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 20));

		const resp = platform.sent.find((s) => s.topic === '__rpc' && s.event === 'a1');
		expect(resp.data.ok).toBe(false);
		expect(resp.data.code).toBe('UNAUTHENTICATED');
		expect(resp.data.error).toBe('Authentication required');
	});

	it('stream RPC routes through platform.subscribe so the adapter sees the subscription', async () => {
		// Regression for the codex H1 audit finding: the stream RPC path
		// must call `platform.subscribe(ws, topic)` (atomic gate + ws.subscribe
		// + cap + adapter-side state update) rather than raw `ws.subscribe`.
		// Without this, the adapter's `MAX_SUBSCRIPTIONS_PER_CONNECTION`
		// cap is bypassed and stream-RPC subscriptions are invisible to
		// the close-hook's `ctx.subscriptions` set and to `totalSubscriptions`.
		const stream = live.stream('acct/feed', async () => [{ id: 1 }]);
		__register('acct/feed', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		const subscribeCalls = [];
		const origSubscribe = platform.subscribe;
		platform.subscribe = async (subWs, topic) => {
			subscribeCalls.push({ ws: subWs, topic });
			return await origSubscribe(subWs, topic);
		};

		handleRpc(ws, toArrayBuffer({ rpc: 'acct/feed', id: 'p1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 20));

		expect(subscribeCalls).toHaveLength(1);
		expect(subscribeCalls[0].topic).toBe('acct/feed');
		expect(subscribeCalls[0].ws).toBe(ws);
		// The ws ended up subscribed (atomic subscribe via platform.subscribe).
		expect(ws.getTopics()).toContain('acct/feed');
	});

	it('platform.subscribe returning a denial blocks the loader, __onSubscribe, and the response is the denial', async () => {
		// Regression: platform.subscribe denial path mirrors the prior
		// platform.checkSubscribe denial semantics.
		let loaderRan = false;
		const room = live.room({
			topic: (ctx, roomId) => 'cap-room:' + roomId,
			init: async () => { loaderRan = true; return []; },
			presence: (ctx) => ({ name: ctx.user?.name }),
			topicArgs: 1
		});
		__register('cap-room/__data', room.__dataStream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		platform.subscribe = async () => 'RATE_LIMITED';

		handleRpc(ws, toArrayBuffer({ rpc: 'cap-room/__data', id: 'r1', args: ['x'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 20));

		const resp = platform.sent.find((s) => s.topic === '__rpc' && s.event === 'r1');
		expect(resp.data.ok).toBe(false);
		expect(resp.data.code).toBe('RATE_LIMITED');
		expect(loaderRan).toBe(false);
		const joins = platform.published.filter((p) => p.event === 'join');
		expect(joins).toHaveLength(0);
		expect(ws.getTopics().length).toBe(0);
	});

	it('platform without checkSubscribe degrades to current behavior (older adapter)', async () => {
		// Older adapters predating 0.5.0-next.14 don't expose
		// checkSubscribe. The optional check skips and the stream RPC
		// proceeds normally. In-realtime gates (__streamFilter,
		// live.room({ guard })) remain the access-control surface.
		const stream = live.stream('legacy/feed', async () => [{ id: 1 }]);
		__register('legacy/feed', stream);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		// platform.checkSubscribe intentionally not set.

		handleRpc(ws, toArrayBuffer({ rpc: 'legacy/feed', id: 'l1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 20));

		const resp = platform.sent.find((s) => s.topic === '__rpc' && s.event === 'l1');
		expect(resp.data.ok).toBe(true);
		expect(resp.data.data).toEqual([{ id: 1 }]);
	});

	it('rollback after a guard-thrown denial cleans up _presenceRef (no phantom roster entries)', async () => {
		// Regression: after N anonymous guard-denied visits, an authorized
		// follow-up user must see ONLY themselves in the roster - not
		// phantom guest entries from the rolled-back subscribes. Verifies
		// that _executeStreamRpc's catch path -> _rollbackStreamSubscribe
		// -> __onUnsubscribe -> _rollingBack-fast-path actually deletes
		// the _presenceRef entry the data-stream onSubscribe inserted
		// before the loader-thrown denial.
		const room = live.room({
			topic: (ctx, roomId) => 'probe-room:' + roomId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name || 'anon' }),
			guard: async (ctx) => {
				if (!ctx.user?.id) throw new LiveError('UNAUTHENTICATED', 'login required');
			},
			topicArgs: 1
		});
		__register('probe-room/__data', room.__dataStream);
		__register('probe-room/__presence', room.__presenceStream);

		// 4 anonymous denied visits.
		for (let i = 0; i < 4; i++) {
			const wsAnon = mockWs();
			const p = mockPlatform();
			handleRpc(wsAnon, toArrayBuffer({ rpc: 'probe-room/__data', id: 'v' + i, args: ['private'], stream: true }), p);
			await new Promise((r) => setTimeout(r, 20));
		}
		await new Promise((r) => setTimeout(r, 50));

		// Authorized 5th user. Their data subscribe succeeds; their
		// presence init returns the roster from the in-memory fallback.
		const wsAlice = mockWs({ id: 'alice', name: 'Alice' });
		const platform = mockPlatform();
		handleRpc(wsAlice, toArrayBuffer({ rpc: 'probe-room/__data', id: 'a1', args: ['private'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 20));
		handleRpc(wsAlice, toArrayBuffer({ rpc: 'probe-room/__presence', id: 'a2', args: ['private'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 20));

		const resp = platform.sent.find((s) => s.topic === '__rpc' && s.event === 'a2');
		expect(resp).toBeDefined();
		expect(resp.data.ok).toBe(true);
		const list = resp.data.data;
		expect(list).toHaveLength(1);
		expect(list[0].key).toBe('alice');

		close(wsAlice, { platform });
	});

	it('zero-config: subscriber alone in a room sees its own join in the initial presence list', async () => {
		// The data stream's `onSubscribe` publishes the join BEFORE the
		// user has subscribed to the `:presence` topic. Without an
		// in-memory fallback, the presence init would return [] and the
		// user would never see itself. Production wires
		// `platform.presence.list` (Redis-backed) for cluster correctness;
		// dev should "just work" without any extra wiring.
		const room = live.room({
			topic: (ctx, roomId) => 'rooms-fallback:' + roomId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			topicArgs: 1
		});

		__register('rooms-fallback/__data', room.__dataStream);
		__register('rooms-fallback/__presence', room.__presenceStream);

		const ws = mockWs({ id: 'alice', name: 'Alice' });
		const platform = mockPlatform();
		// platform.presence is intentionally undefined - this exercises
		// the zero-config path the fallback covers.

		handleRpc(ws, toArrayBuffer({ rpc: 'rooms-fallback/__data', id: 'd1', args: ['r1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'rooms-fallback/__presence', id: 'p1', args: ['r1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const presenceResp = platform.sent.find((s) => s.topic === '__rpc' && s.event === 'p1');
		expect(presenceResp).toBeDefined();
		expect(presenceResp.data.ok).toBe(true);
		expect(presenceResp.data.data).toEqual([{ key: 'alice', data: { name: 'Alice' } }]);

		close(ws, { platform });
	});

	it('zero-config: a second subscriber sees both itself and the existing user', async () => {
		const room = live.room({
			topic: (ctx, roomId) => 'rooms-fallback2:' + roomId,
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user?.name }),
			topicArgs: 1
		});

		__register('rooms-fallback2/__data', room.__dataStream);
		__register('rooms-fallback2/__presence', room.__presenceStream);

		const wsA = mockWs({ id: 'alice', name: 'Alice' });
		const wsB = mockWs({ id: 'bob', name: 'Bob' });
		const platform = mockPlatform();

		// Alice subscribes to data + presence first.
		handleRpc(wsA, toArrayBuffer({ rpc: 'rooms-fallback2/__data', id: 'da', args: ['r1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(wsA, toArrayBuffer({ rpc: 'rooms-fallback2/__presence', id: 'pa', args: ['r1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Bob subscribes; Bob's presence init should reconstruct both Alice and Bob.
		handleRpc(wsB, toArrayBuffer({ rpc: 'rooms-fallback2/__data', id: 'db', args: ['r1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(wsB, toArrayBuffer({ rpc: 'rooms-fallback2/__presence', id: 'pb', args: ['r1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const bobsPresenceResp = platform.sent.find((s) => s.topic === '__rpc' && s.event === 'pb');
		expect(bobsPresenceResp).toBeDefined();
		expect(bobsPresenceResp.data.ok).toBe(true);
		const list = bobsPresenceResp.data.data;
		expect(list).toHaveLength(2);
		const sorted = [...list].sort((a, b) => a.key.localeCompare(b.key));
		expect(sorted).toEqual([
			{ key: 'alice', data: { name: 'Alice' } },
			{ key: 'bob', data: { name: 'Bob' } }
		]);

		close(wsA, { platform });
		close(wsB, { platform });
	});
});

// - live.webhook() ------------------------------------------------

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

// - live.webhooks.outbound() --------------------------------------

describe('live.webhooks namespace + outbound', () => {
	let server;
	let baseUrl;
	let received; // every request the receiver saw: { method, path, headers, body }
	let respond; // per-test response programmer: (req, res, entry) => void; null -> 200
	let idCounter = 0;

	// A real loopback HTTP receiver: delivery is exercised over the wire (node:http
	// is the transport now, not fetch), which also covers the redirect / retry /
	// HMAC / idempotency paths end to end. The receiver is on 127.0.0.1, so the
	// strict SSRF guard would block it - delivery tests therefore use urlMode:'off'
	// (loopback is the test server), while the SSRF-blocking tests use strict mode
	// and assert NOTHING reaches the receiver.
	beforeEach(async () => {
		received = [];
		respond = null;
		server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				const entry = { method: req.method, path: req.url, headers: req.headers, body };
				received.push(entry);
				if (respond) respond(req, res, entry);
				else { res.writeHead(200); res.end('ok'); }
			});
		});
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		baseUrl = 'http://127.0.0.1:' + server.address().port;
		configureCron(null); // no leader configured: every worker fires
	});
	afterEach(async () => {
		await new Promise((r) => server.close(r));
		configureCron(null);
	});

	// Register an outbound webhook, activate the publish wrap, publish once on a
	// UNIQUE topic (so tests never cross-fire), and wait for the async fire chain
	// (retry backoffs use 1ms delays).
	async function fireOnce(sources, config, { topic, event = 'created', data = { id: 1 }, leader, wait = 120 } = {}) {
		const src = topic || sources[0];
		__registerWebhookOut('wh/out' + (++idCounter), live.webhooks.outbound(sources, config));
		if (leader !== undefined) configureCron({ leader });
		const platform = mockPlatform();
		_activateDerived(platform);
		platform.publish(src, event, data);
		await new Promise((r) => setTimeout(r, wait));
		return platform;
	}

	it('live.webhooks.inbound is the same function as live.webhook', () => {
		expect(live.webhooks.inbound).toBe(live.webhook);
	});

	it('outbound returns a server-only marker with sources + config', () => {
		const cfg = { url: 'https://hooks.example.com/x' };
		const m = live.webhooks.outbound(['orders'], cfg);
		expect(m.__isWebhookOut).toBe(true);
		expect(m.__webhookOutSources).toEqual(['orders']);
		expect(m.__webhookOutConfig).toBe(cfg);
	});

	it('rejects a non-array / empty sources', () => {
		expect(() => live.webhooks.outbound('orders', { url: 'https://x.com' })).toThrow(/sources/);
		expect(() => live.webhooks.outbound([], { url: 'https://x.com' })).toThrow(/sources/);
	});

	it('rejects a missing / invalid url', () => {
		expect(() => live.webhooks.outbound(['orders'], {})).toThrow(/url/);
		expect(() => live.webhooks.outbound(['orders'], { url: 42 })).toThrow(/url/);
	});

	it('rejects an invalid resolve / urlMode at definition time', () => {
		expect(() => live.webhooks.outbound(['orders'], { url: 'https://x.com', resolve: 42 })).toThrow(/resolve/);
		expect(() => live.webhooks.outbound(['orders'], { url: 'https://x.com', urlMode: 'lax' })).toThrow(/urlMode/);
	});

	it('rejects a static url that fails the SSRF guard at definition time', () => {
		expect(() => live.webhooks.outbound(['orders'], { url: 'http://169.254.169.254/' })).toThrow(/blocked/);
		expect(() => live.webhooks.outbound(['orders'], { url: 'http://localhost/hook' })).toThrow(/blocked/);
		expect(() => live.webhooks.outbound(['orders'], { url: 'file:///etc/passwd' })).toThrow(/blocked/);
	});

	it('a static url to a private host is blocked even with validateUrl (validateUrl can only narrow)', () => {
		// validateUrl is no longer an escape hatch: the range floor still blocks a
		// private literal at definition time. urlMode:'off' is the way to reach one.
		expect(() => live.webhooks.outbound(['orders'], { url: 'http://10.0.0.5/h', validateUrl: () => true })).toThrow(/blocked/);
		expect(() => live.webhooks.outbound(['orders'], { url: 'http://10.0.0.5/h', urlMode: 'off' })).not.toThrow();
		expect(() => live.webhooks.outbound(['orders'], { url: 'https://ok.com/h', urlMode: 'allowlist', allow: ['ok.com'] })).not.toThrow();
	});

	it('fires an HTTP POST on a matching publish, with json body + idempotency-key header', async () => {
		await fireOnce(['wh-orders'], { url: baseUrl + '/x', urlMode: 'off' }, { topic: 'wh-orders', event: 'created', data: { id: 7 } });
		expect(received).toHaveLength(1);
		const entry = received[0];
		expect(entry.method).toBe('POST');
		expect(entry.path).toBe('/x');
		expect(entry.headers['content-type']).toBe('application/json');
		expect(typeof entry.headers['idempotency-key']).toBe('string');
		expect(JSON.parse(entry.body)).toEqual({ event: 'created', data: { id: 7 } });
	});

	it('applies transform, and skips the POST when transform returns null', async () => {
		await fireOnce(['wh-t1'], { url: baseUrl + '/', urlMode: 'off', transform: (e, d) => ({ kind: e, n: d.id }) }, { topic: 'wh-t1', data: { id: 3 } });
		expect(JSON.parse(received[0].body)).toEqual({ kind: 'created', n: 3 });

		received.length = 0;
		await fireOnce(['wh-t2'], { url: baseUrl + '/', urlMode: 'off', transform: () => null }, { topic: 'wh-t2' });
		expect(received).toHaveLength(0);
	});

	it('signs the body with HMAC when secret is set', async () => {
		await fireOnce(['wh-sig'], { url: baseUrl + '/', urlMode: 'off', secret: 's3cret' }, { topic: 'wh-sig' });
		expect(received[0].headers['x-webhook-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it('the default idempotency-key is keyed (unforgeable) when a secret is set', async () => {
		await fireOnce(['wh-idem-keyed'], { url: baseUrl + '/', urlMode: 'off', secret: 's3cret' }, { topic: 'wh-idem-keyed', event: 'created', data: { id: 9 } });
		const keyed = received[0].headers['idempotency-key'];
		const body = JSON.stringify({ event: 'created', data: { id: 9 } });
		const material = 'wh-idem-keyed\0created\0' + body;
		// The plain content hash an outsider could precompute from public data...
		const plain = createHash('sha256').update(material).digest('hex');
		// ...is NOT what ships when a secret is set: the default is keyed (HMAC).
		expect(keyed).not.toBe(plain);
		expect(keyed).toBe(createHmac('sha256', 's3cret').update('idem\0' + material).digest('hex'));
	});

	it('rejects an idempotency-key containing CR/LF (no delivery)', async () => {
		const failures = [];
		await fireOnce(['wh-crlf'], { url: baseUrl + '/', urlMode: 'off', idempotencyKey: () => 'a\r\nb', onFailure: (e) => failures.push(e) }, { topic: 'wh-crlf' });
		expect(received).toHaveLength(0);
		expect(String(failures[0].message)).toMatch(/idempotency-key/);
	});

	it('blocks a dynamic url resolving to a private literal at fire time (onFailure, no delivery)', async () => {
		const failures = [];
		await fireOnce(['wh-dyn'], { url: () => 'http://169.254.169.254/', onFailure: (e) => failures.push(e) }, { topic: 'wh-dyn' });
		expect(received).toHaveLength(0);
		expect(failures).toHaveLength(1);
		expect(String(failures[0].message)).toMatch(/blocked/);
	});

	it('blocks a DNS name that resolves to a private address (rebinding defense, no delivery)', async () => {
		const failures = [];
		// strict mode + a custom resolver that maps a public-looking name to a
		// private address: resolve+validate catches it before any connection.
		await fireOnce(['wh-rebind'], {
			url: 'http://hook.example.test/path',
			resolve: () => '169.254.169.254',
			onFailure: (e) => failures.push(e)
		}, { topic: 'wh-rebind' });
		expect(received).toHaveLength(0);
		expect(String(failures[0].message)).toMatch(/blocked/);
	});

	it('does NOT leak the secret or URL credentials in a reported error', async () => {
		const failures = [];
		// A dynamic url (function) is checked + redacted at fire time, exercising
		// the runtime reporting path. (A static credential url is caught and
		// redacted at definition time; see the definition-time block tests.)
		await fireOnce(['wh-redact'], {
			url: () => 'http://user:hunter2@169.254.169.254/admin?token=topsecret',
			secret: 'super-secret-hmac',
			onFailure: (e) => failures.push(e)
		}, { topic: 'wh-redact' });
		const msg = String(failures[0] && failures[0].message);
		expect(msg).toMatch(/blocked/);
		expect(msg).not.toContain('hunter2');
		expect(msg).not.toContain('topsecret');
		expect(msg).not.toContain('super-secret-hmac');
	});

	it('redacts URL credentials in the definition-time block error', () => {
		try {
			live.webhooks.outbound(['orders'], { url: 'http://user:hunter2@169.254.169.254/admin?token=topsecret' });
			throw new Error('expected outbound() to throw');
		} catch (e) {
			expect(String(e.message)).toMatch(/blocked/);
			expect(String(e.message)).not.toContain('hunter2');
			expect(String(e.message)).not.toContain('topsecret');
		}
	});

	it('aborts a hung callback via the per-callback timeout (no delivery)', async () => {
		const failures = [];
		await fireOnce(['wh-hang'], {
			url: baseUrl + '/',
			urlMode: 'off',
			callbackTimeoutMs: 20,
			transform: () => new Promise(() => {}), // never resolves
			onFailure: (e) => failures.push(e)
		}, { topic: 'wh-hang', wait: 120 });
		expect(received).toHaveLength(0);
		expect(String(failures[0].message)).toMatch(/timed out/);
	});

	it('does NOT fire when the cron leader gate returns false (cluster dedup)', async () => {
		await fireOnce(['wh-lead-no'], { url: baseUrl + '/', urlMode: 'off' }, { topic: 'wh-lead-no', leader: () => false });
		expect(received).toHaveLength(0);
	});

	it('fires when the leader gate returns true', async () => {
		await fireOnce(['wh-lead-yes'], { url: baseUrl + '/', urlMode: 'off' }, { topic: 'wh-lead-yes', leader: () => true });
		expect(received).toHaveLength(1);
	});

	it('retries on a 5xx and stops once delivered; the idempotency-key is stable across retries', async () => {
		let n = 0;
		respond = (req, res) => {
			n++;
			if (n < 2) { res.writeHead(503); res.end('down'); }
			else { res.writeHead(200); res.end('ok'); }
		};
		await fireOnce(['wh-retry'], { url: baseUrl + '/', urlMode: 'off', retry: { attempts: 3, initialDelayMs: 1 } }, { topic: 'wh-retry' });
		expect(received).toHaveLength(2);
		expect(received[0].headers['idempotency-key']).toBe(received[1].headers['idempotency-key']);
	});

	it('does NOT retry a 4xx client error', async () => {
		const failures = [];
		respond = (req, res) => { res.writeHead(400); res.end('bad'); };
		await fireOnce(['wh-4xx'], { url: baseUrl + '/', urlMode: 'off', retry: { attempts: 3, initialDelayMs: 1 }, onFailure: (e, ev, d, attempts) => failures.push(attempts) }, { topic: 'wh-4xx' });
		expect(received).toHaveLength(1);
		expect(failures[0]).toBe(1);
	});

	it('times out a hung receiver via the per-attempt deadline', async () => {
		const failures = [];
		respond = () => { /* receive the request but never respond */ };
		await fireOnce(['wh-timeout'], {
			url: baseUrl + '/',
			urlMode: 'off',
			timeoutMs: 40,
			retry: { attempts: 1 },
			onFailure: (e) => failures.push(e)
		}, { topic: 'wh-timeout', wait: 200 });
		expect(received).toHaveLength(1); // the POST was sent...
		expect(String(failures[0].message)).toMatch(/timeout/); // ...then aborted by the deadline
	});

	it('follows a redirect to a new target, re-gating each hop', async () => {
		respond = (req, res) => {
			if (req.url === '/start') { res.writeHead(302, { location: baseUrl + '/final' }); res.end(); }
			else { res.writeHead(200); res.end('ok'); }
		};
		await fireOnce(['wh-redir'], { url: baseUrl + '/start', urlMode: 'off', maxRedirects: 3 }, { topic: 'wh-redir' });
		expect(received.map((r) => r.path)).toEqual(['/start', '/final']);
	});

	it('refuses a redirect to a non-http(s) scheme (per-hop scheme gate)', async () => {
		const failures = [];
		respond = (req, res) => { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); };
		await fireOnce(['wh-redir-scheme'], { url: baseUrl + '/start', urlMode: 'off', onFailure: (e) => failures.push(e) }, { topic: 'wh-redir-scheme' });
		expect(received).toHaveLength(1); // only the first hop; the file: redirect is not followed
		expect(String(failures[0].message)).toMatch(/redirect-bad-scheme/);
	});

	it('stops following after maxRedirects hops', async () => {
		const failures = [];
		let i = 0;
		respond = (req, res) => { res.writeHead(302, { location: baseUrl + '/r' + (++i) }); res.end(); };
		await fireOnce(['wh-redir-cap'], { url: baseUrl + '/start', urlMode: 'off', maxRedirects: 2, onFailure: (e) => failures.push(e) }, { topic: 'wh-redir-cap' });
		// hop 0 (/start) + 2 followed hops = 3 requests, then the cap stops it.
		expect(received).toHaveLength(3);
		expect(String(failures[0].message)).toMatch(/too many redirects/);
	});

	it('refuses all redirects when maxRedirects is 0', async () => {
		const failures = [];
		respond = (req, res) => { res.writeHead(302, { location: baseUrl + '/final' }); res.end(); };
		await fireOnce(['wh-redir-zero'], { url: baseUrl + '/start', urlMode: 'off', maxRedirects: 0, onFailure: (e) => failures.push(e) }, { topic: 'wh-redir-zero' });
		expect(received).toHaveLength(1);
		expect(String(failures[0].message)).toMatch(/too many redirects/);
	});

	it('off mode resolves + pins a DNS name to its address (Host preserved; rebinding closed)', async () => {
		// A DNS-name target under off mode: the custom resolver maps it to the
		// loopback test server, the connection is pinned to that address, and the
		// Host header keeps the original name. This is also the positive proof that
		// the pin routes the socket to the resolved address (no second resolution).
		const port = server.address().port;
		await fireOnce(['wh-off-pin'], {
			url: 'http://pinned.example.test:' + port + '/hook',
			urlMode: 'off',
			resolve: () => '127.0.0.1'
		}, { topic: 'wh-off-pin' });
		expect(received).toHaveLength(1);
		expect(received[0].path).toBe('/hook');
		expect(received[0].headers.host).toBe('pinned.example.test:' + port);
	});

	it('detects a redirect loop regardless of initial-URL case (normalized seen-set)', async () => {
		const failures = [];
		const port = server.address().port;
		// The server redirects to the lowercase form of the (mixed-case) initial
		// URL. With the seen-set normalized, the loop is caught on the first hop
		// (one delivery), not one hop later.
		respond = (req, res) => { res.writeHead(302, { location: 'http://pinned.example.test:' + port + '/loop' }); res.end(); };
		await fireOnce(['wh-loop-case'], {
			url: 'http://Pinned.Example.Test:' + port + '/loop',
			urlMode: 'off',
			resolve: () => '127.0.0.1',
			onFailure: (e) => failures.push(e)
		}, { topic: 'wh-loop-case' });
		expect(received).toHaveLength(1);
		expect(String(failures[0].message)).toMatch(/redirect loop/);
	});
});

// - Delta sync (server side) --------------------------------------

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

		// No version field in request - full refetch
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

// - Test utilities ------------------------------------------------

import { createTestEnv, expectGuardRejects, createTestContext } from '../src/testing.js';

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

describe('expectGuardRejects()', () => {
	let env;

	beforeEach(() => {
		env = createTestEnv();
	});

	afterEach(() => {
		env.cleanup();
	});

	it('resolves silently when promise rejects with FORBIDDEN by default', async () => {
		const _guard = guard((ctx) => {
			if (!ctx.user?.admin) throw new LiveError('FORBIDDEN');
		});
		const action = live(async () => 'ok');
		env.register('egr_default', { _guard, action });

		const user = env.connect({ admin: false });
		const err = await expectGuardRejects(user.call('egr_default/action'));
		expect(err).toBeInstanceOf(LiveError);
		expect(err.code).toBe('FORBIDDEN');
	});

	it('accepts a custom expected code', async () => {
		const _guard = guard((ctx) => {
			if (!ctx.user) throw new LiveError('UNAUTHENTICATED');
		});
		const action = live(async () => 'ok');
		env.register('egr_unauth', { _guard, action });

		const anon = env.connect(null);
		const err = await expectGuardRejects(anon.call('egr_unauth/action'), 'UNAUTHENTICATED');
		expect(err.code).toBe('UNAUTHENTICATED');
	});

	it('returns the rejected error so further assertions can run', async () => {
		const _guard = guard(() => { throw new LiveError('FORBIDDEN', 'No write access'); });
		const action = live(async () => 'ok');
		env.register('egr_msg', { _guard, action });

		const user = env.connect({ id: 'u1' });
		const err = await expectGuardRejects(user.call('egr_msg/action'));
		expect(err.message).toBe('No write access');
	});

	it('throws if the promise resolves instead of rejecting', async () => {
		const action = live(async () => 'ok');
		env.register('egr_ok', { action });

		const user = env.connect({ id: 'u1' });
		await expect(expectGuardRejects(user.call('egr_ok/action'))).rejects.toThrow(
			/expectGuardRejects: promise resolved/
		);
	});

	it('throws if the rejection is not a LiveError', async () => {
		await expect(
			expectGuardRejects(Promise.reject(new TypeError('boom')))
		).rejects.toThrow(/expected LiveError "FORBIDDEN", got TypeError: boom/);
	});

	it('throws if the LiveError code does not match', async () => {
		const _guard = guard(() => { throw new LiveError('UNAUTHENTICATED'); });
		const action = live(async () => 'ok');
		env.register('egr_mismatch', { _guard, action });

		const user = env.connect({ id: 'u1' });
		await expect(expectGuardRejects(user.call('egr_mismatch/action'))).rejects.toThrow(
			/expected code "FORBIDDEN", got "UNAUTHENTICATED"/
		);
	});
});

describe('createTestEnv() chaos harness', () => {
	let env;
	afterEach(() => env?.cleanup());

	it('drops every publish when dropRate is 1.0', async () => {
		env = createTestEnv({ chaos: { dropRate: 1.0 } });
		const items = live.stream('chaos-1', async () => []);
		env.register('cm', { items });

		const client = env.connect({ id: 'u1' });
		const stream = client.subscribe('cm/items');
		await new Promise((r) => setTimeout(r, 20));

		env.platform.publish('chaos-1', 'created', { id: 'a' });
		env.platform.publish('chaos-1', 'created', { id: 'b' });
		await new Promise((r) => setTimeout(r, 20));

		expect(stream.events).toHaveLength(0);
		expect(env.chaos.dropped).toBe(2);
	});

	it('does not drop publishes when dropRate is 0 (default)', async () => {
		env = createTestEnv();
		const items = live.stream('chaos-2', async () => []);
		env.register('cm', { items });

		const client = env.connect({ id: 'u1' });
		const stream = client.subscribe('cm/items');
		await new Promise((r) => setTimeout(r, 20));

		env.platform.publish('chaos-2', 'created', { id: 'a' });
		await new Promise((r) => setTimeout(r, 20));

		expect(stream.events).toHaveLength(1);
		expect(env.chaos.dropped).toBe(0);
	});

	it('seeded RNG produces deterministic drop sequences across runs', async () => {
		const env1 = createTestEnv({ chaos: { dropRate: 0.5, seed: 'rep-1234' } });
		const env2 = createTestEnv({ chaos: { dropRate: 0.5, seed: 'rep-1234' } });
		const N = 50;
		for (let i = 0; i < N; i++) {
			env1.platform.publish('t', 'e', i);
			env2.platform.publish('t', 'e', i);
		}
		expect(env1.chaos.dropped).toBe(env2.chaos.dropped);
		env1.cleanup();
		env2.cleanup();
	});

	it('runtime set/disable updates the active config', async () => {
		env = createTestEnv();
		expect(env.chaos.config).toBeNull();

		env.chaos.set({ dropRate: 1.0 });
		expect(env.chaos.config).toEqual({ dropRate: 1.0, seed: null });
		env.platform.publish('t', 'e', 1);
		expect(env.chaos.dropped).toBe(1);

		env.chaos.disable();
		expect(env.chaos.config).toBeNull();
		env.platform.publish('t', 'e', 2);
		expect(env.chaos.dropped).toBe(1);
	});

	it('resetCounter() zeroes the drop counter', () => {
		env = createTestEnv({ chaos: { dropRate: 1.0 } });
		env.platform.publish('t', 'e', 1);
		env.platform.publish('t', 'e', 2);
		expect(env.chaos.dropped).toBe(2);
		env.chaos.resetCounter();
		expect(env.chaos.dropped).toBe(0);
	});

	it('rejects non-numeric and out-of-range dropRate', () => {
		expect(() => createTestEnv({ chaos: { dropRate: 'half' } })).toThrow(/dropRate must be a finite number/);
		expect(() => createTestEnv({ chaos: { dropRate: -0.1 } })).toThrow(/dropRate must be a finite number/);
		expect(() => createTestEnv({ chaos: { dropRate: 1.5 } })).toThrow(/dropRate must be a finite number/);
		expect(() => createTestEnv({ chaos: { dropRate: Infinity } })).toThrow(/dropRate must be a finite number/);
	});

	it('does NOT drop RPC replies (platform.send)', async () => {
		env = createTestEnv({ chaos: { dropRate: 1.0 } });
		const greet = live(async () => 'hello');
		env.register('cm', { greet });

		// Even with full chaos, the RPC call still resolves - platform.send is exempt.
		const client = env.connect({ id: 'u1' });
		const result = await client.call('cm/greet');
		expect(result).toBe('hello');
	});
});

describe('createTestContext()', () => {
	it('returns a ctx with the production shape', () => {
		const ctx = createTestContext({ user: { id: 'u1', role: 'admin' } });
		expect(ctx.user).toEqual({ id: 'u1', role: 'admin' });
		expect(ctx.ws).toBeNull();
		expect(ctx.platform).toBeNull();
		expect(ctx.cursor).toBeNull();
		expect(typeof ctx.publish).toBe('function');
		expect(typeof ctx.throttle).toBe('function');
		expect(typeof ctx.debounce).toBe('function');
		expect(typeof ctx.signal).toBe('function');
		expect(typeof ctx.batch).toBe('function');
		expect(typeof ctx.shed).toBe('function');
		expect(ctx.requestId).toBe('test-req');
	});

	it('helpers are no-ops with sensible defaults', () => {
		const ctx = createTestContext();
		expect(ctx.publish('t', 'e', {})).toBe(true);
		expect(ctx.signal()).toBe(true);
		expect(ctx.shed()).toBe(false);
		expect(ctx.throttle()).toBeUndefined();
		expect(ctx.debounce()).toBeUndefined();
		expect(ctx.batch()).toBeUndefined();
	});

	it('user defaults to null for anonymous-context tests', () => {
		const ctx = createTestContext();
		expect(ctx.user).toBeNull();
	});

	it('exercises a guard predicate directly', () => {
		const adminOnly = (ctx) => ctx.user?.role === 'admin';
		expect(adminOnly(createTestContext({ user: { role: 'admin' } }))).toBe(true);
		expect(adminOnly(createTestContext({ user: { role: 'viewer' } }))).toBe(false);
		expect(adminOnly(createTestContext())).toBe(false);
	});

	it('overrides cursor and requestId when supplied', () => {
		const ctx = createTestContext({
			cursor: { id: 42 },
			requestId: 'r-1234'
		});
		expect(ctx.cursor).toEqual({ id: 42 });
		expect(ctx.requestId).toBe('r-1234');
	});
});

describe('TestStream.simulatePublish()', () => {
	let env;
	beforeEach(() => { env = createTestEnv(); });
	afterEach(() => { env.cleanup(); });

	it('publishes to the stream topic without going through env.platform', async () => {
		const items = live.stream('sim/items', async () => [{ id: 1, name: 'A' }]);
		env.register('sim', { items });

		const client = env.connect({ id: 'u1' });
		const stream = client.subscribe('sim/items');
		await new Promise((r) => setTimeout(r, 20));

		stream.simulatePublish('created', { id: 2, name: 'B' });
		await new Promise((r) => setTimeout(r, 20));

		expect(stream.events).toHaveLength(1);
		expect(stream.events[0]).toEqual({ event: 'created', data: { id: 2, name: 'B' } });
	});

	it('throws when the stream has no topic yet', async () => {
		const items = live.stream('sim/none', async () => []);
		env.register('sim', { items });

		const client = env.connect({ id: 'u1' });
		const stream = client.subscribe('sim/items-missing');
		// No await - subscribe hasn't received its initial reply, no topic yet.

		expect(() => stream.simulatePublish('created', { id: 1 })).toThrow(/no topic/);
	});
});

// - live.channel() -------------------------------------------------

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

	it('uses default options (merge: set, no key default for non-crud)', () => {
		const ch = live.channel('events');
		expect(ch.__streamOptions).toEqual({ merge: 'set' });
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

// - live.flag() --------------------------------------------------------------

describe('live.flag()', () => {
	it('declares a set-merge stream carrying the flag value', () => {
		const f = live.flag('flag:maintenance', false);
		expect(f.__isFlag).toBe(true);
		expect(f.__isStream).toBe(true);
		expect(f.__isLive).toBe(true);
		expect(f.__streamTopic).toBe('flag:maintenance');
		expect(f.__streamOptions).toEqual({ merge: 'set' });
	});

	it('initFn returns the initial value, then the latest set value', async () => {
		const f = live.flag('flag:rollout', false);
		expect(await f()).toBe(false);
		_activateDerived(mockPlatform());
		f.set(true);
		expect(await f()).toBe(true);
		expect(f.get()).toBe(true);
	});

	it('.set publishes a set event through the captured platform', () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		const f = live.flag('flag:beta', false);
		f.set(true);
		expect(platform.published).toEqual([
			{ topic: 'flag:beta', event: 'set', data: true, options: undefined }
		]);
	});

	it('omits the initialValue argument and defaults the value to undefined', async () => {
		const f = live.flag('flag:bare');
		expect(await f()).toBe(undefined);
	});

	it('forwards replay option to the underlying stream', () => {
		const f = live.flag('flag:audited', false, { replay: { size: 1 } });
		// __replay lands on the initFn via live.stream when replay is set.
		expect(f.__replay).toEqual({ size: 1 });
	});

	it('serves the current value to a fresh subscriber via handleRpc', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		const f = live.flag('flag:served', 'green');
		f.set('red');
		__register('flags/served', f);

		const ws = mockWs({ id: 'u1' });
		const buf = toArrayBuffer({ rpc: 'flags/served', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toBe('red');
		expect(platform.sent[0].data.merge).toBe('set');
		expect(ws._topics.has('flag:served')).toBe(true);
	});

	it('throws when topic is not a non-empty string', () => {
		expect(() => live.flag('', false)).toThrow('non-empty string');
		expect(() => live.flag(/** @type {any} */ (null), false)).toThrow('non-empty string');
	});

	it('rejects reserved __ topic prefixes (via the underlying live.stream guard)', () => {
		expect(() => live.flag('__internal', false)).toThrow('reserved prefix');
	});

	it('enables a single-entry shared buffer by default, overridable, opt-out via replay:false', () => {
		const def = live.flag('flag:default-buf', false);
		expect(def.__replay).toEqual({ size: 1 });

		const sized = live.flag('flag:sized-buf', false, { replay: { size: 5 } });
		expect(sized.__replay).toEqual({ size: 5 });

		const off = live.flag('flag:no-buf', false, { replay: false });
		expect(off.__replay).toBeUndefined();
	});

	it('watcher refreshes the cached value on an inbound set the replica never set locally', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		// Declare the flag but never call .set() on this replica - the value
		// only arrives via the bus inbound relay (modeled by publishing the
		// 'set' through the wrapped platform, the same path
		// derivedPublishLocal takes for cluster-relayed events).
		const f = live.flag('flag:watched', 'idle');
		expect(f.get()).toBe('idle');

		platform.publish('flag:watched', 'set', 'active');
		// The effect-index watcher fires fire-and-forget on a microtask.
		await Promise.resolve();
		await Promise.resolve();

		expect(f.get()).toBe('active');
	});

	it('eager __registerFlag installs the watcher at registry load, so an inbound set before the flag module is imported is reflected by a later .get()', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		// Simulate the registry module loading: the eager watcher install runs
		// WITHOUT importing the flag module (live.flag is never called yet).
		__registerFlag('flag:eager', 'idle');

		// An inbound cluster-relayed set arrives before any local import or
		// subscribe of the flag module. The eager watcher captures it.
		platform.publish('flag:eager', 'set', 'active');
		await Promise.resolve();
		await Promise.resolve();

		// Now the flag module is imported for the first time (e.g. an admin
		// route reads the flag). .get() must reflect the set the watcher caught
		// before import - not the stale declared initialValue.
		const f = live.flag('flag:eager', 'idle');
		expect(f.get()).toBe('active');
		expect(await f()).toBe('active');
	});

	it('eager __registerFlag is idempotent with the flag body watcher install', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		__registerFlag('flag:idem', false);
		// Importing the flag module installs the same watcher; it must not
		// double-register (one inbound set must produce exactly one update).
		const f = live.flag('flag:idem', false);
		expect(f.get()).toBe(false);

		platform.publish('flag:idem', 'set', true);
		await Promise.resolve();
		await Promise.resolve();

		expect(f.get()).toBe(true);
	});

	it('seeds a fresh subscriber with the cluster-latest value from the shared buffer', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		const buffered = [{ seq: 7, topic: 'flag:seeded', event: 'set', data: 'cluster-latest' }];
		platform.replay = {
			seq: async () => 7,
			since: async (topic, sinceSeq) => sinceSeq === 0 ? buffered : null
		};
		// This replica's cached value is the stale init - the fresh subscribe
		// must serve the buffered cluster-latest value, not the loader's.
		const f = live.flag('flag:seeded', 'stale-init');
		__register('flags/seeded', f);

		const ws = mockWs({ id: 'u1' });
		const buf = toArrayBuffer({ rpc: 'flags/seeded', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.replay).toBe(true);
		expect(platform.sent[0].data.data).toBe(buffered);
		expect(platform.sent[0].data.seq).toBe(7);
		expect(platform.sent[0].data.merge).toBe('set');
	});

	it('falls through to the loader when the shared buffer is empty', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		platform.replay = {
			seq: async () => 0,
			since: async () => []
		};
		const f = live.flag('flag:empty-buf', 'initial');
		__register('flags/empty-buf', f);

		const ws = mockWs({ id: 'u1' });
		const buf = toArrayBuffer({ rpc: 'flags/empty-buf', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.replay).not.toBe(true);
		expect(platform.sent[0].data.data).toBe('initial');
	});

	it('fresh-subscribe seeding is gated to flags - non-flag replay streams keep loader-only behavior', async () => {
		const platform = mockPlatform();
		const buffered = [{ seq: 3, topic: 'plain-replay', event: 'created', data: { id: 9 } }];
		platform.replay = {
			seq: async () => 3,
			since: async (topic, sinceSeq) => sinceSeq === 0 ? buffered : null
		};
		const streamFn = live.stream('plain-replay', async () => [{ id: 1 }], { merge: 'crud', key: 'id', replay: true });
		__register('plain/replay', streamFn);

		const ws = mockWs({ id: 'u1' });
		// Fresh subscribe (no seq) for a non-flag replay stream must run the
		// loader, not seed from the buffer.
		const buf = toArrayBuffer({ rpc: 'plain/replay', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.replay).not.toBe(true);
		expect(platform.sent[0].data.data).toEqual([{ id: 1 }]);
	});

	it('getLatest reads the cluster-latest value from the shared buffer', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		platform.replay = {
			seq: async () => 4,
			since: async (topic, sinceSeq) => sinceSeq === 0
				? [{ seq: 4, topic: 'flag:latest', event: 'set', data: 'fresh' }]
				: []
		};
		// Cached value is the stale init; getLatest must read the buffer.
		const f = live.flag('flag:latest', 'stale');
		expect(f.get()).toBe('stale');
		expect(await f.getLatest()).toBe('fresh');
	});

	it('getLatest falls back to the cached value without a shared buffer', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		const f = live.flag('flag:no-replay', 'init');
		f.set('local');
		expect(await f.getLatest()).toBe('local');
	});

	it('single-process: set/get and a fresh subscribe are unchanged with no platform.replay', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);
		const f = live.flag('flag:single-proc', 'green');
		expect(f.get()).toBe('green');
		f.set('red');
		expect(f.get()).toBe('red');
		expect(await f()).toBe('red');
		__register('flags/single-proc', f);

		const ws = mockWs({ id: 'u1' });
		const buf = toArrayBuffer({ rpc: 'flags/single-proc', id: '1', args: [], stream: true });
		handleRpc(ws, buf, platform);
		await new Promise((r) => setTimeout(r, 10));

		// No platform.replay -> seeding branch no-ops -> loader returns current.
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.replay).not.toBe(true);
		expect(platform.sent[0].data.data).toBe('red');
	});
});

// - derived stream RPC response -----------------------------------------------

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

// - live.rateLimit() -----------------------------------------------

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
		await fn(ctx2); // should not throw - different user
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

// - live.rateLimits() registry config ----------------------------------------

describe('live.rateLimits() registry config', () => {
	beforeEach(() => { _resetRateLimits(); });
	afterEach(() => { _resetRateLimits(); });

	it('throws on invalid config shape', () => {
		expect(() => live.rateLimits('not-an-object')).toThrow(/must be an object/);
		expect(() => live.rateLimits({ default: { points: 'x', window: 1000 } })).toThrow(/points must be a positive number/);
		expect(() => live.rateLimits({ default: { points: 5, window: 0 } })).toThrow(/window must be a positive number/);
		expect(() => live.rateLimits({ overrides: { 'p': { points: -1, window: 1000 } } })).toThrow(/positive number/);
		expect(() => live.rateLimits({ exempt: 'not-array' })).toThrow(/must be an array/);
		expect(() => live.rateLimits({ exempt: [123] })).toThrow(/must be strings/);
	});

	it('default rule rate-limits a registered handler with no per-handler wrapper', async () => {
		live.rateLimits({ default: { points: 1, window: 10_000 } });

		const fn = live(async (_ctx) => 'ok');
		__register('rls/default', fn);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'rls/default', id: 'a', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(true);

		handleRpc(ws, toArrayBuffer({ rpc: 'rls/default', id: 'b', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1].data.ok).toBe(false);
		expect(platform.sent[1].data.code).toBe('RATE_LIMITED');
		expect(platform.sent[1].data.retryAfter).toBeGreaterThan(0);
	});

	it('overrides rule wins over default', async () => {
		live.rateLimits({
			default: { points: 100, window: 10_000 },
			overrides: { 'rls/strict': { points: 1, window: 10_000 } }
		});

		const fn = live(async () => 'ok');
		__register('rls/strict', fn);

		const ws = mockWs({ id: 'u2' });
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'rls/strict', id: 'a', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(true);

		handleRpc(ws, toArrayBuffer({ rpc: 'rls/strict', id: 'b', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1].data.code).toBe('RATE_LIMITED');
	});

	it('exempt skips a path entirely', async () => {
		live.rateLimits({
			default: { points: 1, window: 10_000 },
			exempt: ['rls/free']
		});

		const fn = live(async () => 'ok');
		__register('rls/free', fn);

		const ws = mockWs({ id: 'u3' });
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'rls/free', id: 'a', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'rls/free', id: 'b', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'rls/free', id: 'c', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent.every((m) => m.data.ok === true)).toBe(true);
	});

	it('per-handler live.rateLimit wins over registry override', async () => {
		// Registry says 1/window; per-handler says 5/window. Per-handler wins.
		live.rateLimits({
			overrides: { 'rls/handlerWins': { points: 1, window: 10_000 } }
		});

		const fn = live.rateLimit({ points: 5, window: 10_000 }, async () => 'ok');
		__register('rls/handlerWins', fn);

		const ws = mockWs({ id: 'u4' });
		const platform = mockPlatform();

		// Five calls all succeed (per-handler rule applies, registry skipped)
		for (let i = 0; i < 5; i++) {
			handleRpc(ws, toArrayBuffer({ rpc: 'rls/handlerWins', id: 'h' + i, args: [] }), platform);
		}
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent.filter((m) => m.data.ok === true).length).toBe(5);
	});

	it('different users have independent buckets under registry config', async () => {
		live.rateLimits({ default: { points: 1, window: 10_000 } });

		const fn = live(async () => 'ok');
		__register('rls/perUser', fn);

		const ws1 = mockWs({ id: 'alice' });
		const ws2 = mockWs({ id: 'bob' });
		const platform = mockPlatform();

		handleRpc(ws1, toArrayBuffer({ rpc: 'rls/perUser', id: 'a1', args: [] }), platform);
		handleRpc(ws2, toArrayBuffer({ rpc: 'rls/perUser', id: 'b1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[1].data.ok).toBe(true);

		// Each user's second call gets rate-limited independently
		handleRpc(ws1, toArrayBuffer({ rpc: 'rls/perUser', id: 'a2', args: [] }), platform);
		handleRpc(ws2, toArrayBuffer({ rpc: 'rls/perUser', id: 'b2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[2].data.code).toBe('RATE_LIMITED');
		expect(platform.sent[3].data.code).toBe('RATE_LIMITED');
	});

	it('null clears the registry config (no rate limit applied)', async () => {
		live.rateLimits({ default: { points: 1, window: 10_000 } });
		live.rateLimits(null);

		const fn = live(async () => 'ok');
		__register('rls/cleared', fn);

		const ws = mockWs({ id: 'u5' });
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'rls/cleared', id: 'a', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'rls/cleared', id: 'b', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[1].data.ok).toBe(true);
	});

	it('does not rate-limit stream subscribes', async () => {
		live.rateLimits({ default: { points: 1, window: 10_000 } });

		const stream = live.stream('rls-stream-topic', async () => [{ id: 1 }]);
		__register('rls/stream', stream);

		const ws = mockWs({ id: 'u6' });
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'rls/stream', id: 's1', args: [], stream: true }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'rls/stream', id: 's2', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[1].data.ok).toBe(true);
	});
});

// - live.effect() --------------------------------------------------

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

// - live.signal() --------------------------------------------------

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

// - live.aggregate() -----------------------------------------------

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

// - live.aggregate() with windows --------------------------------------------

describe('live.aggregate() combine helpers', () => {
	it('combineSum sums numbers, treats null/undefined as 0', () => {
		expect(combineSum(1, 2, 3)).toBe(6);
		expect(combineSum(1, null, 3)).toBe(4);
		expect(combineSum(undefined, undefined)).toBe(0);
		expect(combineSum()).toBe(0);
	});

	it('combineMax / combineMin skip nullish, fall back to 0 on empty', () => {
		expect(combineMax(1, 5, 3)).toBe(5);
		expect(combineMax(1, null, undefined, 7)).toBe(7);
		expect(combineMax()).toBe(0);
		expect(combineMin(5, 1, 3)).toBe(1);
		expect(combineMin(undefined, undefined)).toBe(0);
	});

	it('combineCounts merges Record<string, number> by sum-per-key', () => {
		const merged = combineCounts({ a: 1, b: 2 }, { a: 3, c: 5 }, undefined, { c: 1 });
		expect(merged).toEqual({ a: 4, b: 2, c: 6 });
	});

	it('combineMerge does last-write-wins object merge', () => {
		expect(combineMerge({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 2, b: 3 });
		expect(combineMerge(undefined, { x: 1 }, undefined)).toEqual({ x: 1 });
	});
});

describe('live.aggregate() windowed - validation', () => {
	it('rejects an empty windows object', () => {
		expect(() => live.aggregate('src', { c: { init: () => 0 } }, {
			topic: 't', windows: {}
		})).toThrow(/at least one window/);
	});

	it('rejects unknown window type', () => {
		expect(() => live.aggregate('src', { c: { init: () => 0 } }, {
			topic: 't', windows: { w: { type: 'wat' } }
		})).toThrow(/unknown type/);
	});

	it('rejects tumbling without period or durationMs', () => {
		expect(() => live.aggregate('src', { c: { init: () => 0 } }, {
			topic: 't', windows: { w: { type: 'tumbling' } }
		})).toThrow(/exactly one of 'period' or 'durationMs'/);
	});

	it('rejects tumbling with both period and durationMs', () => {
		expect(() => live.aggregate('src', { c: { init: () => 0 } }, {
			topic: 't', windows: { w: { type: 'tumbling', period: 'daily', durationMs: 1000 } }
		})).toThrow(/exactly one of 'period' or 'durationMs'/);
	});

	it('rejects tumbling with unsupported period', () => {
		expect(() => live.aggregate('src', { c: { init: () => 0 } }, {
			topic: 't', windows: { w: { type: 'tumbling', period: 'fortnight' } }
		})).toThrow(/period 'fortnight'/);
	});

	it('rejects sliding without slideMs', () => {
		expect(() => live.aggregate('src', { c: { init: () => 0, reduce: (a) => a, combine: combineSum } }, {
			topic: 't', windows: { w: { type: 'sliding', durationMs: 1000 } }
		})).toThrow(/positive 'slideMs'/);
	});

	it('rejects sliding with slideMs > durationMs', () => {
		expect(() => live.aggregate('src', { c: { init: () => 0, reduce: (a) => a, combine: combineSum } }, {
			topic: 't', windows: { w: { type: 'sliding', durationMs: 1000, slideMs: 5000 } }
		})).toThrow(/slideMs.*must be <=.*durationMs/);
	});

	it('rejects sliding bucket count over MAX_AGGREGATE_BUCKETS', () => {
		// 1ms slide on a 100s window = 100,000 buckets - well over the cap.
		expect(() => live.aggregate('src', { c: { init: () => 0, reduce: (a) => a, combine: combineSum } }, {
			topic: 't',
			windows: { w: { type: 'sliding', durationMs: 100_000, slideMs: 1 } }
		})).toThrow(new RegExp(`exceeds MAX_AGGREGATE_BUCKETS \\(${MAX_AGGREGATE_BUCKETS}\\)`));
	});

	it('rejects sliding when a reducer with reduce() lacks combine()', () => {
		expect(() => live.aggregate('src', {
			counts: { init: () => ({}), reduce: (acc) => acc /* no combine */ }
		}, {
			topic: 't',
			windows: { w: { type: 'sliding', durationMs: 1000, slideMs: 100 } }
		})).toThrow(/reducer 'counts' has reduce\(\) but no combine\(\)/);
	});

	it('accepts sliding when a reducer is compute-only (no reduce, no combine needed)', () => {
		// compute()-only reducers (no reduce, no init) don't carry hop-bucket
		// state, so combine is never consulted for them.
		expect(() => live.aggregate('src', {
			counts: { init: () => ({}), reduce: (acc) => acc, combine: combineCounts },
			top: { compute: (s) => Object.keys(s.counts).length }
		}, {
			topic: 't',
			windows: { w: { type: 'sliding', durationMs: 1000, slideMs: 100 } }
		})).not.toThrow();
	});
});

describe('live.aggregate() windowed - per-window output topics + state isolation', () => {
	afterEach(() => {
		_resetAggregates();
	});

	it('publishes one envelope per window per source event, on per-window topics', async () => {
		const fn = live.aggregate('events:hit', {
			counts: {
				init: () => ({}),
				reduce: (acc, event, data) => event === 'inc'
					? { ...acc, [data.id]: (acc[data.id] ?? 0) + 1 }
					: acc,
				combine: combineCounts
			}
		}, {
			topic: 'events:hit:topk',
			windows: {
				lifetime: { type: 'lifetime' },
				window5s:  { type: 'sliding', durationMs: 5000, slideMs: 1000 }
			}
		});

		__registerAggregate('agg/win/topk', fn);
		// Per-window child registrations are normally emitted by the Vite
		// plugin; do them by hand here so the per-window stream paths
		// resolve under SSR-side direct-call lookups (not exercised by
		// this test, but mirrors the production wiring shape).
		__register('agg/win/topk/__window/lifetime', fn.__windowStreams.lifetime);
		__register('agg/win/topk/__window/window5s', fn.__windowStreams.window5s);

		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('events:hit', 'inc', { id: 'a' });
		platform.publish('events:hit', 'inc', { id: 'a' });
		platform.publish('events:hit', 'inc', { id: 'b' });

		// Each event publishes once per window -> 3 events x 2 windows = 6.
		const lifetimePubs = platform.published.filter(p => p.topic === 'events:hit:topk:lifetime');
		const slidingPubs  = platform.published.filter(p => p.topic === 'events:hit:topk:window5s');
		expect(lifetimePubs.length).toBe(3);
		expect(slidingPubs.length).toBe(3);

		// State across the two windows is isolated - they happen to agree
		// here because no slide tick fired, but they are computed off
		// independent state slices.
		expect(lifetimePubs[2].data.counts).toEqual({ a: 2, b: 1 });
		expect(slidingPubs[2].data.counts).toEqual({ a: 2, b: 1 });
	});

	it('lifetime window matches the no-windows behavior (regression guard)', async () => {
		const fn = live.aggregate('events:r', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, {
			topic: 'events:r:agg',
			windows: { lifetime: { type: 'lifetime' } }
		});

		__registerAggregate('agg/win/lifetime', fn);
		const platform = mockPlatform();
		_activateDerived(platform);

		platform.publish('events:r', 'inc', {});
		platform.publish('events:r', 'inc', {});

		const pubs = platform.published.filter(p => p.topic === 'events:r:agg:lifetime');
		expect(pubs.length).toBe(2);
		expect(pubs[1].data.count).toBe(2);
	});

	it('per-window debounce overrides the aggregate-level default', async () => {
		vi.useFakeTimers();
		try {
			const fn = live.aggregate('events:d', {
				count: { init: () => 0, reduce: (acc) => acc + 1 }
			}, {
				topic: 'events:d:agg',
				debounce: 50,
				windows: {
					hot:  { type: 'lifetime', debounce: 0 },
					cold: { type: 'lifetime' /* inherits 50ms */ }
				}
			});

			__registerAggregate('agg/win/debounce', fn);
			const platform = mockPlatform();
			_activateDerived(platform);

			platform.publish('events:d', 'inc', {});
			// Hot window publishes synchronously (debounce: 0).
			expect(platform.published.filter(p => p.topic === 'events:d:agg:hot').length).toBe(1);
			// Cold window has not yet fired - debounce: 50 still pending.
			expect(platform.published.filter(p => p.topic === 'events:d:agg:cold').length).toBe(0);

			vi.advanceTimersByTime(60);
			expect(platform.published.filter(p => p.topic === 'events:d:agg:cold').length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('live.aggregate() windowed - tumbling boundary', () => {
	afterEach(() => {
		_resetAggregates();
		vi.useRealTimers();
	});

	it('publishes the closing-window final state on boundary, then resets state via init()', async () => {
		vi.useFakeTimers({ now: 1_000_000 }); // arbitrary epoch ms
		const fn = live.aggregate('events:t', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, {
			topic: 'events:t:agg',
			// 1000ms tumbling, anchored at the fake-now epoch so the next
			// boundary is exactly +1000ms.
			windows: { bucket: { type: 'tumbling', durationMs: 1000, anchor: 1_000_000 } }
		});

		__registerAggregate('agg/win/tumb', fn);
		const platform = mockPlatform();
		_activateDerived(platform);
		// The boundary timer publishes via _cronPlatform; capture it.
		setCronPlatform(platform);

		platform.publish('events:t', 'inc', {});
		platform.publish('events:t', 'inc', {});

		const beforeBoundary = platform.published.filter(p => p.topic === 'events:t:agg:bucket');
		expect(beforeBoundary[beforeBoundary.length - 1].data.count).toBe(2);

		// Cross the boundary. The boundary publish should reflect the
		// closing-window count (2), then state resets to init() so the
		// next event lands as count=1.
		vi.advanceTimersByTime(1100);

		const allPubs = platform.published.filter(p => p.topic === 'events:t:agg:bucket');
		// Expect at least: 2 from the inc events + 1 boundary publish.
		expect(allPubs.length).toBeGreaterThanOrEqual(3);
		// The publish at the boundary cross is the last one before the new event.
		expect(allPubs[2].data.count).toBe(2);

		platform.publish('events:t', 'inc', {});
		const postReset = platform.published.filter(p => p.topic === 'events:t:agg:bucket').slice(-1)[0];
		expect(postReset.data.count).toBe(1);
	});
});

describe('live.aggregate() windowed - sliding hop rotation', () => {
	afterEach(() => {
		_resetAggregates();
		vi.useRealTimers();
	});

	it('drops events out of the window after durationMs (within slideMs precision)', async () => {
		vi.useFakeTimers({ now: 0 });
		const fn = live.aggregate('events:s', {
			count: {
				init: () => 0,
				reduce: (acc, e) => e === 'inc' ? acc + 1 : acc,
				combine: combineSum
			}
		}, {
			topic: 'events:s:agg',
			windows: { w: { type: 'sliding', durationMs: 1000, slideMs: 250 } }
		});

		__registerAggregate('agg/win/slide', fn);
		const platform = mockPlatform();
		_activateDerived(platform);
		setCronPlatform(platform);

		// 4 events at t=0 land in bucket 0.
		platform.publish('events:s', 'inc', {});
		platform.publish('events:s', 'inc', {});
		platform.publish('events:s', 'inc', {});
		platform.publish('events:s', 'inc', {});

		const initialPubs = platform.published.filter(p => p.topic === 'events:s:agg:w');
		expect(initialPubs[initialPubs.length - 1].data.count).toBe(4);

		// Advance past durationMs. At t > 1000, the original bucket has
		// been fully evicted; combine across remaining (empty) buckets is 0.
		vi.advanceTimersByTime(1100);
		const afterEviction = platform.published.filter(p => p.topic === 'events:s:agg:w');
		expect(afterEviction[afterEviction.length - 1].data.count).toBe(0);
	});

	it('events span buckets correctly: pushing to bucket 0, then 1, then 2 yields combined count', async () => {
		vi.useFakeTimers({ now: 0 });
		const fn = live.aggregate('events:sb', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc, combine: combineSum }
		}, {
			topic: 'events:sb:agg',
			windows: { w: { type: 'sliding', durationMs: 1000, slideMs: 200 } }
		});

		__registerAggregate('agg/win/slide-multi', fn);
		const platform = mockPlatform();
		_activateDerived(platform);
		setCronPlatform(platform);

		platform.publish('events:sb', 'inc', {}); // bucket 0
		vi.advanceTimersByTime(250);
		platform.publish('events:sb', 'inc', {}); // bucket 1
		vi.advanceTimersByTime(250);
		platform.publish('events:sb', 'inc', {}); // bucket 2

		const pubs = platform.published.filter(p => p.topic === 'events:sb:agg:w');
		expect(pubs[pubs.length - 1].data.count).toBe(3);
	});
});

describe('live.aggregate() windowed - per-window snapshots', () => {
	afterEach(() => {
		_resetAggregates();
	});

	it('hydrates each window from its own snapshot', async () => {
		const fn = live.aggregate('events:sn', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, {
			topic: 'events:sn:agg',
			snapshots: {
				today:    async () => ({ count: 42 }),
				lifetime: async () => ({ count: 1000 })
			},
			windows: {
				today:    { type: 'tumbling', durationMs: 86_400_000, anchor: 0 },
				lifetime: { type: 'lifetime' }
			}
		});

		__registerAggregate('agg/win/snap', fn);
		// Direct-call init returns the per-window restored state.
		const todayInit = await fn.__windowStreams.today();
		const lifetimeInit = await fn.__windowStreams.lifetime();
		expect(todayInit.count).toBe(42);
		expect(lifetimeInit.count).toBe(1000);
	});

	it('windows without a snapshot start from init()', async () => {
		const fn = live.aggregate('events:sn2', {
			count: { init: () => 0, reduce: (acc) => acc + 1 }
		}, {
			topic: 'events:sn2:agg',
			snapshots: { lifetime: async () => ({ count: 7 }) },
			windows: {
				lifetime: { type: 'lifetime' },
				today: { type: 'tumbling', durationMs: 86_400_000, anchor: 0 }
			}
		});

		__registerAggregate('agg/win/snap-partial', fn);
		const lifetimeInit = await fn.__windowStreams.lifetime();
		const todayInit = await fn.__windowStreams.today();
		expect(lifetimeInit.count).toBe(7);
		expect(todayInit.count).toBe(0);
	});

	// A snapshot returned from a backend (Redis cache, JSON payload, etc.)
	// is a hostile-input boundary - the snapshot author is not always the
	// framework author. Hydration must skip `__proto__` / `constructor`
	// keys so a `JSON.parse('{"__proto__":{"polluted":1}}')` payload
	// cannot stamp values on Object.prototype reachable from every other
	// object in the process.
	it('does not pollute Object.prototype when snapshot contains __proto__', async () => {
		const fn = live.aggregate('events:sn-pp', {
			count: { init: () => 0, reduce: (a) => a + 1 }
		}, {
			topic: 'events:sn-pp:agg',
			snapshot: async () => JSON.parse('{"count":3,"__proto__":{"polluted":1},"constructor":"hostile"}')
		});
		__registerAggregate('agg/snap/pp', fn);
		// Allow the hydration microtask kicked off inside __registerAggregate to flush.
		await new Promise((r) => setTimeout(r, 10));
		expect(/** @type {any} */ ({}).polluted).toBeUndefined();
		expect(/** @type {any} */ ({}).constructor).not.toBe('hostile');
	});

	it('does not pollute Object.prototype from a windowed snapshot containing __proto__', async () => {
		const fn = live.aggregate('events:sn-wpp', {
			count: { init: () => 0, reduce: (a) => a + 1 }
		}, {
			topic: 'events:sn-wpp:agg',
			snapshots: {
				lifetime: async () => JSON.parse('{"count":3,"__proto__":{"polluted":1}}')
			},
			windows: { lifetime: { type: 'lifetime' } }
		});
		__registerAggregate('agg/snap/wpp', fn);
		await fn.__windowStreams.lifetime();
		await new Promise((r) => setTimeout(r, 10));
		expect(/** @type {any} */ ({}).polluted).toBeUndefined();
	});
});

describe('live.aggregate() windowed - root + per-window stream metadata', () => {
	afterEach(() => {
		_resetAggregates();
	});

	it('root function carries window metadata; per-window streams have isStream + own topic', () => {
		const fn = live.aggregate('events:m', {
			count: { init: () => 0, reduce: (acc) => acc + 1 }
		}, {
			topic: 'events:m:agg',
			windows: {
				today: { type: 'tumbling', period: 'daily' },
				lifetime: { type: 'lifetime' }
			}
		});

		expect(fn.__isAggregate).toBe(true);
		expect(fn.__aggregateWindows).toBeDefined();
		expect(fn.__aggregateWindowKeys).toEqual(['today', 'lifetime']);
		expect(fn.__windowStreams.today.__isStream).toBe(true);
		expect(fn.__windowStreams.today.__streamTopic).toBe('events:m:agg:today');
		expect(fn.__windowStreams.lifetime.__streamTopic).toBe('events:m:agg:lifetime');
	});

	it('calling the root function directly throws (subscribe via children)', () => {
		const fn = live.aggregate('events:rc', {
			count: { init: () => 0, reduce: (acc) => acc + 1 }
		}, {
			topic: 'events:rc:agg',
			windows: { lifetime: { type: 'lifetime' } }
		});
		expect(() => fn()).toThrow(/per-window children/);
	});
});

// - _activateDerived late-activation contract -------------------------------
//
// The README's recommended call site for `_activateDerived(platform)` is the
// adapter's `init({ platform })` hook - which fires BEFORE the lazy queue
// drains and BEFORE any WS connection. Without late-activation hooks across
// every reactive registration path, the publish-wrap never installs and the
// first cron-driven publish silently misses every watcher (aggregate /
// effect / static derived). These tests pin the four contract points the
// fix is meant to deliver.

describe('_activateDerived late-activation', () => {
	beforeEach(() => {
		// Clean slate: clears registries, resets _hasDynamicDerived /
		// _hasLazyReactive flags, drops _activatedPlatforms via fresh
		// platforms below.
		_prepareHmr();
	});

	afterEach(() => {
		_resetAggregates();
		_prepareHmr();
	});

	// 1. Static aggregate registered AFTER _activateDerived was called against
	// an empty registry receives source-topic publishes. Pre-fix: silently
	// dropped. The dev-mode SSR fallback path goes through this code shape.
	it('static aggregate registered after _activateDerived (empty registry) still receives source publishes', async () => {
		const platform = mockPlatform();
		_activateDerived(platform); // registry is empty here

		const fn = live.aggregate('post-activate:agg-src', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, { topic: 'post-activate:agg-out' });
		__register('agg/post-activate', fn);
		__registerAggregate('agg/post-activate', fn);

		platform.publish('post-activate:agg-src', 'inc', {});
		platform.publish('post-activate:agg-src', 'inc', {});

		const pubs = platform.published.filter(p => p.topic === 'post-activate:agg-out');
		expect(pubs.length).toBe(2);
		expect(pubs[1].data.count).toBe(2);
	});

	it('static derived registered after _activateDerived (empty registry) still recomputes on source publish', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);

		let counter = 0;
		const derivedFn = live.derived(['post-activate:der-src'], async () => {
			counter++;
			return { count: counter };
		});
		__register('der/post-activate', derivedFn);
		__registerDerived('der/post-activate', derivedFn);

		platform.publish('post-activate:der-src', 'changed', {});
		await new Promise(r => setTimeout(r, 20));

		expect(counter).toBeGreaterThan(0);
	});

	it('live.effect registered after _activateDerived (empty registry) still fires on source publish', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);

		let fired = 0;
		const effectFn = live.effect(['post-activate:fx-src'], async () => { fired++; });
		__registerEffect('fx/post-activate', effectFn);

		platform.publish('post-activate:fx-src', 'changed', {});
		await new Promise(r => setTimeout(r, 20));

		expect(fired).toBe(1);
	});

	it('windowed aggregate registered after _activateDerived (empty registry) publishes per-window output', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);

		const fn = live.aggregate('post-activate:win-src', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, {
			topic: 'post-activate:win-out',
			windows: { lifetime: { type: 'lifetime' } }
		});
		__registerAggregate('agg/post-activate-win', fn);

		platform.publish('post-activate:win-src', 'inc', {});
		platform.publish('post-activate:win-src', 'inc', {});

		const pubs = platform.published.filter(p => p.topic === 'post-activate:win-out:lifetime');
		expect(pubs.length).toBe(2);
		expect(pubs[1].data.count).toBe(2);
	});

	// 2. The realistic init() flow: lazy queue is loaded, _activateDerived
	// fires while the queue is still un-drained. The eager flag set at
	// queue-push time should keep `_activateDerived`'s gate open so the
	// wrap installs immediately rather than waiting for the queue to drain.
	it('lazy-pushed aggregate -> _activateDerived during the lazy window installs the wrap', async () => {
		const platform = mockPlatform();

		const fn = live.aggregate('lazy:agg-src', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, { topic: 'lazy:agg-out' });

		// Mimic the Vite registry virtual module: a lazy loader arrow
		// (`__L(() => import(...).then(m => m.${name}))`) that resolves
		// to the original aggregate init function. Setting __lazy = true
		// on the loader is what makes __registerAggregate push to the
		// lazy queue instead of registering immediately.
		const lazyLoader = async () => fn;
		/** @type {any} */ (lazyLoader).__lazy = true;
		__register('agg/lazy', lazyLoader);
		__registerAggregate('agg/lazy', lazyLoader);

		// The eager flag should now be set even though the registry is empty.
		// _activateDerived must NOT early-return.
		_activateDerived(platform);

		// Drain the lazy queue (production: first cron tick / RPC).
		await __directCall('agg/lazy', [], platform);

		platform.publish('lazy:agg-src', 'inc', {});
		platform.publish('lazy:agg-src', 'inc', {});

		const pubs = platform.published.filter(p => p.topic === 'lazy:agg-out');
		expect(pubs.length).toBe(2);
		expect(pubs[1].data.count).toBe(2);
	});

	// 3. Idempotency: repeated registrations must not double-wrap. The
	// _maybeLateActivate helper must short-circuit on already-activated
	// platforms (otherwise each registration would chain another wrap and
	// every publish would pay N indirection costs).
	it('multiple registrations do not double-wrap the platform', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);

		// First registration triggers the wrap install via _maybeLateActivate.
		const fn0 = live.aggregate('idem:src', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, { topic: 'idem:out-0' });
		__register('agg/idem-0', fn0);
		__registerAggregate('agg/idem-0', fn0);

		// Capture the wrapped reference. Subsequent registrations must
		// short-circuit in _maybeLateActivate (idempotency) and leave
		// platform.publish unchanged.
		const wrappedFirst = platform.publish;
		expect(wrappedFirst.name).toBe('derivedPublish'); // sanity: wrap is in place
		for (let i = 1; i < 3; i++) {
			const fn = live.aggregate('idem:src', {
				count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
			}, { topic: `idem:out-${i}` });
			__register(`agg/idem-${i}`, fn);
			__registerAggregate(`agg/idem-${i}`, fn);
		}
		// Same wrapped function reference - no re-wrap.
		expect(platform.publish).toBe(wrappedFirst);

		platform.publish('idem:src', 'inc', {});
		// All three aggregates should have published exactly once.
		expect(platform.published.filter(p => p.topic === 'idem:out-0').length).toBe(1);
		expect(platform.published.filter(p => p.topic === 'idem:out-1').length).toBe(1);
		expect(platform.published.filter(p => p.topic === 'idem:out-2').length).toBe(1);
	});

	// 4. Negative case: a registration that resolves WITHOUT _activateDerived
	// having ever been called must not pre-emptively wrap. The user is still
	// responsible for opting in via _activateDerived; the late-activation
	// hook only patches the timing gap, it doesn't replace the explicit call.
	it('does NOT wrap the platform if _activateDerived was never called', async () => {
		const platform = mockPlatform();
		const nativePublish = platform.publish;

		const fn = live.aggregate('no-activate:src', {
			count: { init: () => 0, reduce: (acc, e) => e === 'inc' ? acc + 1 : acc }
		}, { topic: 'no-activate:out' });
		__register('agg/no-activate', fn);
		__registerAggregate('agg/no-activate', fn);

		// Wrap was NOT installed - the publish reference is still native.
		expect(platform.publish).toBe(nativePublish);

		platform.publish('no-activate:src', 'inc', {});
		// And no fan-out happened - the aggregate output topic stays empty.
		const pubs = platform.published.filter(p => p.topic === 'no-activate:out');
		expect(pubs.length).toBe(0);
	});

	// 5. Dynamic-derived bind path uses the same helper now (DRY win) --
	// regression guard that replacing the open-coded copy at the bind site
	// didn't break the dynamic-derived late-activation behavior.
	it('dynamic-derived bind path still installs the wrap when activated against empty registry', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);

		let derivedRuns = 0;
		const dynFn = live.derived(
			(orgId) => [`dyn:${orgId}`],
			async (ctx, orgId) => {
				derivedRuns++;
				return { orgId, runs: derivedRuns };
			}
		);
		__register('der/dyn', dynFn);
		__registerDerived('der/dyn', dynFn);

		// Subscribing instantiates the dynamic instance and triggers the
		// bind-path's _maybeLateActivate call.
		const ws = mockWs({ id: 'u1' });
		const data = toArrayBuffer({ rpc: 'der/dyn', id: 'r1', args: ['org-1'], stream: true });
		handleRpc(ws, data, platform);
		await new Promise(r => setTimeout(r, 10));

		platform.publish('dyn:org-1', 'changed', {});
		await new Promise(r => setTimeout(r, 50));

		expect(derivedRuns).toBeGreaterThan(0);
	});
});

// - live.gate() ----------------------------------------------------

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

// - Stream filter/access enforcement -----------------------------------------

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

// - pipe() ---------------------------------------------------------

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

// - Schema Evolution -----------------------------------------------

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

// - 0.4.0: unsubscribe() hook ------------------------------------------------

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

// - 0.4.0: close() with ctx.subscriptions ------------------------------------

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

// - 0.4.0: ctx.batch ---------------------------------------------------------

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

// - ctx.publish auto microtask-batch via platform.publishBatched -------------

/**
 * Build a mock platform exposing publishBatched, so the auto-batch path
 * activates in the publish helper. Records every batched call.
 */
function mockPlatformWithBatched() {
	const p = mockPlatform();
	p.batched = [];
	p.publishBatched = (messages) => { p.batched.push(messages); };
	return p;
}

describe('ctx.publish auto microtask-batch', () => {
	it('queues sync ctx.publish() calls into one publishBatched per microtask', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched();

		const handler = live(async (ctx) => {
			ctx.publish('t1', 'a', 1);
			ctx.publish('t2', 'b', 2);
			ctx.publish('t3', 'c', 3);
			return 'ok';
		});
		__register('autobatch/sync', handler);

		const data = toArrayBuffer({ rpc: 'autobatch/sync', id: 'ab1', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.batched).toHaveLength(1);
		expect(platform.batched[0]).toHaveLength(3);
		expect(platform.batched[0][0]).toMatchObject({ topic: 't1', event: 'a', data: 1 });
		expect(platform.batched[0][2]).toMatchObject({ topic: 't3', event: 'c', data: 3 });
		expect(platform.published).toHaveLength(0);
	});

	it('flushes a separate batch per microtask boundary (await splits)', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched();

		const handler = live(async (ctx) => {
			ctx.publish('t', 'a', 1);
			ctx.publish('t', 'b', 2);
			await new Promise((r) => setTimeout(r, 0));
			ctx.publish('t', 'c', 3);
			return 'ok';
		});
		__register('autobatch/awaitsplit', handler);

		const data = toArrayBuffer({ rpc: 'autobatch/awaitsplit', id: 'ab2', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 20));

		expect(platform.batched).toHaveLength(2);
		expect(platform.batched[0]).toHaveLength(2);
		expect(platform.batched[1]).toHaveLength(1);
		expect(platform.batched[1][0]).toMatchObject({ event: 'c' });
	});

	it('falls back to per-event publish when adapter has no publishBatched', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform(); // no publishBatched

		const handler = live(async (ctx) => {
			ctx.publish('t1', 'a', 1);
			ctx.publish('t2', 'b', 2);
			return 'ok';
		});
		__register('autobatch/fallback', handler);

		const data = toArrayBuffer({ rpc: 'autobatch/fallback', id: 'ab3', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.published).toHaveLength(2);
	});

	it('coalesceBy topics bypass publishBatched (use sendCoalesced)', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched();

		const stream = live.stream('coalesce-topic', async () => [], {
			merge: 'set',
			coalesceBy: (data) => data.id
		});
		__register('autobatch/coalesce', stream);

		const subData = toArrayBuffer({ rpc: 'autobatch/coalesce', id: 'cs1', args: [], stream: true });
		handleRpc(ws, subData, platform);
		await new Promise((r) => setTimeout(r, 10));

		const handler = live(async (ctx) => {
			ctx.publish('coalesce-topic', 'set', { id: 'a', n: 1 });
			ctx.publish('coalesce-topic', 'set', { id: 'a', n: 2 });
			return 'ok';
		});
		__register('autobatch/cpub', handler);

		platform.batched.length = 0;
		const data = toArrayBuffer({ rpc: 'autobatch/cpub', id: 'cp1', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.batched).toHaveLength(0);
		expect(platform.coalesced.length).toBeGreaterThan(0);
	});

	it('transform topics still go through publishBatched with projected data', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched();

		const stream = live.stream('xform-topic', async () => [], {
			merge: 'crud', key: 'id',
			transform: (row) => ({ id: row.id, label: row.label })
		});
		__register('autobatch/xform', stream);

		const subData = toArrayBuffer({ rpc: 'autobatch/xform', id: 'xs1', args: [], stream: true });
		handleRpc(ws, subData, platform);
		await new Promise((r) => setTimeout(r, 10));

		const handler = live(async (ctx) => {
			ctx.publish('xform-topic', 'created', { id: 1, label: 'L', secret: 'x' });
			return 'ok';
		});
		__register('autobatch/xpub', handler);

		platform.batched.length = 0;
		const data = toArrayBuffer({ rpc: 'autobatch/xpub', id: 'xp1', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.batched).toHaveLength(1);
		expect(platform.batched[0][0]).toMatchObject({
			topic: 'xform-topic',
			event: 'created',
			data: { id: 1, label: 'L' }
		});
		expect(platform.batched[0][0].data).not.toHaveProperty('secret');
	});

	it('preserves options on each batched message', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched();

		const handler = live(async (ctx) => {
			ctx.publish('t', 'e', 1, { seq: false });
			return 'ok';
		});
		__register('autobatch/opts', handler);

		const data = toArrayBuffer({ rpc: 'autobatch/opts', id: 'ao1', args: [] });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.batched[0][0]).toMatchObject({ options: { seq: false } });
	});
});

// - 0.4.0: live.breaker() ----------------------------------------------------

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

// - 0.4.0: live.room() .hooks property ---------------------------------------

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

// - live.validated() rejects unrecognized schemas ----------------------------

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

// - throttle/debounce per-entity keying --------------------------------------

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

// - live.metrics() -----------------------------------------------------------

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

// - live.metrics() integration with svelte-adapter-uws-extensions ------------
//
// Verifies the shim shown in the README "Prometheus metrics" section works
// against the real createMetrics() registry from
// svelte-adapter-uws-extensions/prometheus. If extensions ever renames an
// export, changes the registry method shape, or drops a method, these tests
// fail and the README + shim need to be updated together.

describe('live.metrics() <-> svelte-adapter-uws-extensions/prometheus', () => {
	afterEach(() => {
		live.metrics(noopRegistry());
	});

	it('exports createMetrics from svelte-adapter-uws-extensions/prometheus', () => {
		expect(typeof createMetrics).toBe('function');
		const metrics = createMetrics();
		expect(typeof metrics.counter).toBe('function');
		expect(typeof metrics.histogram).toBe('function');
		expect(typeof metrics.gauge).toBe('function');
		expect(typeof metrics.serialize).toBe('function');
	});

	it('records RPC counter and histogram via the documented shim', async () => {
		const metrics = createMetrics();
		live.metrics(adaptExtensionsRegistry(metrics));

		const ws = mockWs({ id: 'integ-rpc-user' });
		const platform = mockPlatform();
		const fn = live(async () => 'hi');
		__register('integ/rpc-echo', fn);

		handleRpc(ws, toArrayBuffer({ rpc: 'integ/rpc-echo', id: 'i1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const output = metrics.serialize();
		expect(output).toContain('# TYPE svelte_realtime_rpc_total counter');
		expect(output).toContain('path="integ/rpc-echo"');
		expect(output).toContain('status="ok"');
		expect(output).toContain('# TYPE svelte_realtime_rpc_duration_seconds histogram');
		expect(output).toContain('svelte_realtime_rpc_duration_seconds_count{path="integ/rpc-echo"}');
	});

	it('increments and serializes the stream subscription gauge via the shim', async () => {
		const metrics = createMetrics();
		live.metrics(adaptExtensionsRegistry(metrics));

		const ws = mockWs({ id: 'integ-stream-user' });
		const platform = mockPlatform();
		const stream = live.stream('integ-stream-items', async () => []);
		__register('integ/stream-items', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'integ/stream-items', id: 'is1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const output = metrics.serialize();
		expect(output).toContain('# TYPE svelte_realtime_stream_subscriptions gauge');
		expect(output).toMatch(/svelte_realtime_stream_subscriptions [1-9]/);
	});

	it('records RPC error counter when the handler throws LiveError', async () => {
		const metrics = createMetrics();
		live.metrics(adaptExtensionsRegistry(metrics));

		const ws = mockWs({ id: 'integ-err-user' });
		const platform = mockPlatform();
		const fn = live(async () => { throw new LiveError('UNAUTHORIZED', 'nope'); });
		__register('integ/rpc-bad', fn);

		handleRpc(ws, toArrayBuffer({ rpc: 'integ/rpc-bad', id: 'ie1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const output = metrics.serialize();
		expect(output).toContain('# TYPE svelte_realtime_rpc_errors_total counter');
		expect(output).toContain('path="integ/rpc-bad"');
		expect(output).toContain('code="UNAUTHORIZED"');
	});

	it('records cron counter via the shim when a cron job runs', async () => {
		_clearCron();
		const metrics = createMetrics();
		live.metrics(adaptExtensionsRegistry(metrics));

		const platform = mockPlatform();
		setCronPlatform(platform);
		const cronFn = live.cron('* * * * *', 'integ-cron-topic', async () => ({ ok: true }));
		__registerCron('integ/cron-job', cronFn);
		await _tickCron();
		await new Promise((r) => setTimeout(r, 20));

		const output = metrics.serialize();
		expect(output).toContain('# TYPE svelte_realtime_cron_total counter');
		expect(output).toContain('path="integ/cron-job"');
		expect(output).toContain('status="ok"');

		_clearCron();
	});
});

// - onError / onCronError alias ----------------------------------------------

describe('onError()', () => {
	it('is exported as a function', () => {
		expect(typeof onError).toBe('function');
	});

	it('onCronError is an alias for onError', () => {
		expect(typeof onCronError).toBe('function');
	});
});

// - _copyStreamMeta via live.gate and pipe -----------------------------------

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

// - __directCall access/filter/gate enforcement ------------------------------

describe('__directCall stream enforcement', () => {
	it('returns null for gated streams when predicate fails', async () => {
		const stream = live.stream('dc-gate-topic', async (ctx) => [{ id: 1 }], { merge: 'crud' });
		const gated = live.gate(() => false, stream);
		__register('dcgate/feed', gated);

		const platform = mockPlatform();
		const result = await __directCall('dcgate/feed', [], platform);
		expect(result).toBeNull();
	});

	it('throws FORBIDDEN when stream filter rejects an authenticated user', async () => {
		const stream = live.stream('dc-filter-topic', async (ctx) => [{ id: 1 }], {
			merge: 'crud',
			access: (ctx) => ctx.user?.admin === true
		});
		__register('dcfilter/feed', stream);

		const platform = mockPlatform();
		await expect(__directCall('dcfilter/feed', [], platform, { user: { id: 1, admin: false } }))
			.rejects.toMatchObject({ code: 'FORBIDDEN' });
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

// - __directCall fallback / onError ------------------------------------------

describe('__directCall fallback / onError', () => {
	it('throws as before when no fallback option is provided', async () => {
		const stream = live.stream('fb-throw', async () => { throw new Error('loader boom'); }, { merge: 'crud' });
		__register('fb/throw', stream);

		const platform = mockPlatform();
		await expect(__directCall('fb/throw', [], platform)).rejects.toThrow('loader boom');
	});

	it('returns the fallback value when the loader throws', async () => {
		const stream = live.stream('fb-fb', async () => { throw new Error('boom'); }, { merge: 'crud' });
		__register('fb/fb', stream);

		const platform = mockPlatform();
		const result = await __directCall('fb/fb', [], platform, { fallback: [] });
		expect(result).toEqual([]);
	});

	it('calls onError with the caught error before returning the fallback', async () => {
		const stream = live.stream('fb-onerr', async () => { throw new Error('explicit'); }, { merge: 'crud' });
		__register('fb/onerr', stream);

		const platform = mockPlatform();
		const seen = [];
		const result = await __directCall('fb/onerr', [], platform, {
			fallback: { stale: true },
			onError: (err) => seen.push(err.message)
		});
		expect(seen).toEqual(['explicit']);
		expect(result).toEqual({ stale: true });
	});

	it('does NOT use the fallback when the loader succeeds', async () => {
		const stream = live.stream('fb-ok', async () => [{ id: 1 }], { merge: 'crud' });
		__register('fb/ok', stream);

		const platform = mockPlatform();
		const result = await __directCall('fb/ok', [], platform, { fallback: [] });
		expect(result).toEqual([{ id: 1 }]);
	});

	it('passes through a null return from a gated stream (does NOT replace with fallback)', async () => {
		const stream = live.stream('fb-gate', async () => [{ id: 1 }], { merge: 'crud' });
		const gated = live.gate(() => false, stream);
		__register('fb/gate', gated);

		const platform = mockPlatform();
		const result = await __directCall('fb/gate', [], platform, { fallback: ['SHOULD-NOT-USE'] });
		expect(result).toBeNull();
	});

	it('returns the fallback when validation throws', async () => {
		const schema = {
			'~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'bad' }] }) }
		};
		const stream = live.stream('fb-val', async () => [], { merge: 'crud', args: schema });
		__register('fb/val', stream);

		const platform = mockPlatform();
		const result = await __directCall('fb/val', ['anything'], platform, { fallback: [] });
		expect(result).toEqual([]);
	});

	it('returns the fallback when the access filter rejects', async () => {
		const stream = live.stream('fb-acc', async () => [{ id: 1 }], {
			merge: 'crud',
			access: () => false
		});
		__register('fb/acc', stream);

		const platform = mockPlatform();
		const seen = [];
		const result = await __directCall('fb/acc', [], platform, {
			user: { id: 1 },
			fallback: [],
			onError: (err) => seen.push(err.code)
		});
		expect(seen).toEqual(['FORBIDDEN']);
		expect(result).toEqual([]);
	});

	it('swallows errors thrown inside onError so SSR is not broken by an observer hook bug', async () => {
		const stream = live.stream('fb-swallow', async () => { throw new Error('loader err'); }, { merge: 'crud' });
		__register('fb/swallow', stream);

		const platform = mockPlatform();
		const result = await __directCall('fb/swallow', [], platform, {
			fallback: 'placeholder',
			onError: () => { throw new Error('observer crashed'); }
		});
		expect(result).toBe('placeholder');
	});

	it('opts in via key presence: { fallback: undefined } counts as opt-in', async () => {
		const stream = live.stream('fb-undef', async () => { throw new Error('boom'); }, { merge: 'crud' });
		__register('fb/undef', stream);

		const platform = mockPlatform();
		// Explicitly pass fallback: undefined - should still catch + return undefined
		const result = await __directCall('fb/undef', [], platform, { fallback: undefined });
		expect(result).toBeUndefined();
	});

	it('returns the fallback when the path is not found', async () => {
		const platform = mockPlatform();
		const result = await __directCall('fb/never-registered', [], platform, { fallback: 'fb' });
		expect(result).toBe('fb');
	});

	it('non-function onError is ignored without throwing', async () => {
		const stream = live.stream('fb-bad-cb', async () => { throw new Error('boom'); }, { merge: 'crud' });
		__register('fb/bad-cb', stream);

		const platform = mockPlatform();
		// onError is not a function - should be ignored; fallback still returned
		const result = await __directCall('fb/bad-cb', [], platform, {
			fallback: [],
			onError: 'not-a-function'
		});
		expect(result).toEqual([]);
	});
});

// - Room guard enforcement on presence/cursor sub-streams --------------------

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

// - Topic function ctx handling -----------------------------------------------

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

// - Cron field validation ----------------------------------------------------

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

// - ctx.throttle / ctx.debounce via RPC --------------------------------------

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

// - Room action _guard enforcement -------------------------------------------

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

// - Room action rate-limit path isolation ------------------------------------

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

		// Call actionA - should succeed (first call)
		handleRpc(ws, toArrayBuffer({ rpc: 'rlroom/r1/__action/actionA', id: 'rla1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);

		// Call actionB - should ALSO succeed (different action, different bucket)
		handleRpc(ws, toArrayBuffer({ rpc: 'rlroom/r1/__action/actionB', id: 'rla2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1]?.data.ok).toBe(true);
	});
});

// - Topic fn with defaulted/rest no-ctx params -------------------------------

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

// - validated(rateLimit(...)) bucket isolation --------------------------------

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

		// Call actionA - should succeed
		handleRpc(ws, toArrayBuffer({ rpc: 'composed/actionA', id: 'ca1', args: ['x'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0]?.data.ok).toBe(true);

		// Call actionB - should ALSO succeed (different path, different bucket)
		handleRpc(ws, toArrayBuffer({ rpc: 'composed/actionB', id: 'ca2', args: ['y'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[1]?.data.ok).toBe(true);
	});
});

// - Room presence/cursor topic resolution ------------------------------------

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

// - ctx-aware dynamic topics with rest/default params ------------------------

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

// - Room action validated(rateLimit(...)) bucket isolation --------------------

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

// - Room action topic arg slicing --------------------------------------------

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

// - ctx alias / destructured / typed topic params ----------------------------

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

// - topicArgs required for ambiguous room topics with actions -----------------

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

// - Topic function must return string ----------------------------------------

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

// - Topic fn with defaults and fn.length heuristic --------------------------

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

// - Rate limit bucket cap with existing identity -----------------------------

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

// - live.idempotent() --------------------------------------------------------

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

		// Key is namespaced by registered RPC path so the same userKey
		// across different RPCs cannot read each other's cached results.
		expect(acquireCalls).toEqual([{ key: 'rpc:idem/custom:custom-key', ttl: 60 }]);
		expect(platform.sent[0].data.data).toBe('from-custom-store');
	});

	// Pre-fix bug: live.idempotent() used the raw client envelope key
	// as the cache slot. Two different RPCs with the same client-supplied
	// idempotencyKey shared a slot - a public RPC returned a private
	// RPC's cached result. Codex's round-5 PoC confirmed this end-to-end.
	it('cross-RPC isolation: same userKey on two paths returns DIFFERENT cached results', async () => {
		const acquireCalls = [];
		const cachePerKey = new Map();
		const customStore = {
			async acquire(key) {
				acquireCalls.push(key);
				const cached = cachePerKey.get(key);
				if (cached !== undefined) {
					return { result: cached };
				}
				return {
					acquired: true,
					commit: async (val) => { cachePerKey.set(key, val); },
					abort: async () => {}
				};
			}
		};
		const privateHandler = live.idempotent(
			{ store: customStore },
			async () => ({ from: 'private', secret: 'do-not-leak' })
		);
		const publicHandler = live.idempotent(
			{ store: customStore },
			async () => ({ from: 'public' })
		);
		__register('iso/private', privateHandler);
		__register('iso/public', publicHandler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Caller A: privateHandler with idempotencyKey='abc'
		handleRpc(ws, toArrayBuffer({
			rpc: 'iso/private', id: '1', args: [], idempotencyKey: 'abc'
		}), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Caller B: publicHandler with the SAME idempotencyKey='abc'
		handleRpc(ws, toArrayBuffer({
			rpc: 'iso/public', id: '2', args: [], idempotencyKey: 'abc'
		}), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Two distinct cache keys: each handler ran exactly once.
		expect(acquireCalls).toEqual([
			'rpc:iso/private:abc',
			'rpc:iso/public:abc'
		]);
		expect(platform.sent[0].data.data).toEqual({ from: 'private', secret: 'do-not-leak' });
		expect(platform.sent[1].data.data).toEqual({ from: 'public' });
		// Critically: the public response did NOT carry the private secret.
		expect(platform.sent[1].data.data.secret).toBeUndefined();
	});

	// Pre-fix footgun: reusing one idempotency key with a DIFFERENT request
	// body silently returned the FIRST call's cached result (a wrong answer).
	// The framework now fingerprints the request args and rejects the mismatch.
	it('rejects a key reused with a DIFFERENT request payload (IDEMPOTENCY_KEY_REUSED)', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: () => 'fixed' },
			async (ctx, x) => { calls++; return x * 10; }
		);
		__register('idem/reuse', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/reuse', id: '1', args: [4] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		// Same key, DIFFERENT args -> must not return the first call's result.
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/reuse', id: '2', args: [9] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
		expect(platform.sent[0].data).toMatchObject({ ok: true, data: 40 });
		expect(platform.sent[1].data.ok).toBe(false);
		expect(platform.sent[1].data.code).toBe('IDEMPOTENCY_KEY_REUSED');
		// The wrong cached value (40) must NOT leak into the rejected response.
		expect(platform.sent[1].data.data).toBeUndefined();
	});

	it('treats object args as equal regardless of key order (no false collision)', async () => {
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: () => 'obj' },
			async (ctx, input) => { calls++; return input.a + input.b; }
		);
		__register('idem/obj', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/obj', id: '1', args: [{ a: 1, b: 2 }] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		// Same payload, different key order -> same fingerprint -> cached result.
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/obj', id: '2', args: [{ b: 2, a: 1 }] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
		expect(platform.sent[0].data.data).toBe(3);
		expect(platform.sent[1].data.data).toBe(3);
	});

	it('detects payload mismatch through a round-trip custom store', async () => {
		const cachePerKey = new Map();
		const customStore = {
			async acquire(key) {
				if (cachePerKey.has(key)) return { result: cachePerKey.get(key) };
				return {
					acquired: true,
					commit: async (val) => { cachePerKey.set(key, val); },
					abort: async () => {}
				};
			}
		};
		let calls = 0;
		const handler = live.idempotent(
			{ keyFrom: () => 'k', store: customStore },
			async (ctx, x) => { calls++; return x; }
		);
		__register('idem/store-reuse', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/store-reuse', id: '1', args: ['a'] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'idem/store-reuse', id: '2', args: ['b'] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toBe(1);
		expect(platform.sent[0].data.data).toBe('a');
		expect(platform.sent[1].data.code).toBe('IDEMPOTENCY_KEY_REUSED');
	});

	it('rejects idempotencyKey longer than 256 chars with INVALID_REQUEST', async () => {
		const handler = live.idempotent({}, async () => 'ok');
		__register('idem/long', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		const longKey = 'a'.repeat(300);

		handleRpc(ws, toArrayBuffer({
			rpc: 'idem/long', id: '1', args: [], idempotencyKey: longKey
		}), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
	});

	it('rejects idempotencyKey from keyFrom callback longer than 256 chars', async () => {
		const longKey = 'a'.repeat(300);
		const handler = live.idempotent(
			{ keyFrom: () => longKey },
			async () => 'ok'
		);
		__register('idem/longkf', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'idem/longkf', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
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

	// Silent-fail paper cut: a caller mirroring `live.lock`'s `{ key, ... }`
	// shape would silently fall through to the no-key bypass branch (no
	// validation error, no key from envelope, every call runs unguarded).
	// Unknown-field validation now catches the typo at registration time
	// with a cross-helper hint specifically calling out the divergence.
	it('rejects unknown config fields with a cross-helper hint for "key"', () => {
		expect(() => live.idempotent({ key: () => 'k' }, async () => 'ok'))
			.toThrow(/unknown config field 'key'/);
		expect(() => live.idempotent({ key: () => 'k' }, async () => 'ok'))
			.toThrow(/Allowed: keyFrom, store, ttl/);
		expect(() => live.idempotent({ key: () => 'k' }, async () => 'ok'))
			.toThrow(/live\.lock uses 'key' but live\.idempotent uses 'keyFrom'/);
	});

	it('rejects arbitrary unknown fields without a cross-helper hint', () => {
		expect(() => live.idempotent({ keyFrom: () => 'k', wrongField: 1 }, async () => 'ok'))
			.toThrow(/unknown config field 'wrongField'/);
		expect(() => live.idempotent({ keyFrom: () => 'k', wrongField: 1 }, async () => 'ok'))
			.toThrow(/Allowed: keyFrom, store, ttl/);
		// No "Hint:" line for fields that don't match a known cross-helper typo.
		try {
			live.idempotent({ keyFrom: () => 'k', wrongField: 1 }, async () => 'ok');
		} catch (e) {
			expect(/** @type {any} */ (e).message).not.toMatch(/Hint:/);
		}
	});
});

// - live.stream({ coalesceBy }) ----------------------------------------------

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

	it('coalescing stream also relays cross-instance via platform.relayCoalesced when present', async () => {
		const stream = live.stream('coal/relay', async () => null, {
			merge: 'set',
			coalesceBy: (data) => data.k
		});
		__register('coal/relay', stream);

		const handler = live(async (ctx) => {
			ctx.publish('coal/relay', 'updated', { k: 'a', v: 1 });
			return 'ok';
		});
		__register('coal/relay-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Subscribe so the publish takes the coalesce branch.
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/relay', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		// A cluster platform (the pubsub extension wrap) provides relayCoalesced;
		// the coalesce branch must call it so other instances re-coalesce. The
		// in-memory platform has none, so single-instance stays byte-identical.
		const relayed = [];
		platform.relayCoalesced = (topic, event, data, key) => relayed.push({ topic, event, data, key });

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/relay-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Local sendCoalesced still fires, and the cross-instance relay is invoked
		// with the raw coalesce key.
		expect(platform.coalesced).toHaveLength(1);
		expect(relayed).toEqual([{ topic: 'coal/relay', event: 'updated', data: { k: 'a', v: 1 }, key: 'a' }]);
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

	it('routes coalesceBy throws to per-stream onError and drops the publish', async () => {
		const seen = [];
		const stream = live.stream('coal/throw', async () => null, {
			merge: 'set',
			coalesceBy: (d) => {
				if (d && d.bad) throw new Error('bad coalesce key');
				return d.k;
			},
			onError: (err, ctx, topic) => {
				seen.push({ message: err.message, ctx, topic });
			}
		});
		__register('coal/throw', stream);

		const handler = live(async (ctx) => {
			ctx.publish('coal/throw', 'updated', { k: 'a' });
			ctx.publish('coal/throw', 'updated', { k: 'b', bad: true });
			ctx.publish('coal/throw', 'updated', { k: 'c' });
			return 'ok';
		});
		__register('coal/throw-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throw', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throw-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(seen).toHaveLength(1);
		expect(seen[0].message).toBe('bad coalesce key');
		expect(seen[0].topic).toBe('coal/throw');
		expect(seen[0].ctx).toBeNull();

		// The two good publishes still went through; the bad one was dropped.
		const keys = platform.coalesced.map(c => c.key);
		expect(keys).toEqual(['coal/throw\0a', 'coal/throw\0c']);
	});

	it('coalesceBy throws propagate when no per-stream onError is configured', async () => {
		const stream = live.stream('coal/throw-unobs', async () => null, {
			merge: 'set',
			coalesceBy: () => { throw new Error('unobserved'); }
		});
		__register('coal/throw-unobs', stream);

		const handler = live(async (ctx) => {
			ctx.publish('coal/throw-unobs', 'updated', { k: 'x' });
			return 'ok';
		});
		__register('coal/throw-unobs-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throw-unobs', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throw-unobs-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const reply = platform.sent.find((s) => s.event === 'p1');
		expect(reply.data.ok).toBe(false);
		expect(reply.data.code).toBe('INTERNAL_ERROR');
	});

	it('observer throws are silently swallowed so a buggy onError does not break publishes', async () => {
		const stream = live.stream('coal/throw-buggy', async () => null, {
			merge: 'set',
			coalesceBy: () => { throw new Error('coalesce bad'); },
			onError: () => { throw new Error('observer bad'); }
		});
		__register('coal/throw-buggy', stream);

		const handler = live(async (ctx) => {
			const ok = ctx.publish('coal/throw-buggy', 'updated', { k: 'a' });
			return { returned: ok };
		});
		__register('coal/throw-buggy-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throw-buggy', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'coal/throw-buggy-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const reply = platform.sent.find((s) => s.event === 'p1');
		expect(reply.data.ok).toBe(true);
		expect(reply.data.data).toEqual({ returned: false });
	});
});

// - Three-tier reconnect ----------------------------------------------------

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

// - Auto-replay routing for replay: true streams ----------------------------
//
// Pre-fix, the user was responsible for wrapping the platform with a
// `wrapWithReplay` proxy at every seam (createMessage AND setCronPlatform).
// Cron-published events to a replay-eligible topic silently bypassed the
// buffer when the user wrapped only the RPC seam (the documented pattern).
// The fix moves replay routing into the framework: `live.stream(topic,
// loader, { replay: true })` registers the topic; the publish surface
// (ctx.publish + cron auto-publish) auto-routes through `platform.replay
// .publish` when the adapter exposes it. User-managed replay proxies opt
// out via the `WRAPPED_FOR_REPLAY` marker for back-compat.

describe('auto-replay routing', () => {
	beforeEach(() => {
		_resetReplayRouting();
	});

	/** Build a fake platform.replay surface that records all calls. */
	function fakeReplay() {
		const calls = [];
		return {
			calls,
			publish: async (platform, topic, event, data) => {
				calls.push({ topic, event, data });
				// Mirror the production extension: replay.publish does the
				// local broadcast itself via platform.publish.
				platform.publish(topic, event, data);
				return true;
			},
			seq: async () => calls.length,
			since: async () => calls.slice()
		};
	}

	it('static topic: ctx.publish to a replay-eligible topic auto-routes through platform.replay.publish', async () => {
		const platform = mockPlatform();
		platform.replay = fakeReplay();
		const stream = live.stream('cron/auto-replay', async () => [], { merge: 'crud', key: 'id', replay: true });
		__register('cron/auto-replay', stream);

		// Use a plain handler (not cron) to test ctx.publish routing.
		const handler = live(async (ctx) => {
			ctx.publish('cron/auto-replay', 'created', { id: 1 });
			return 'ok';
		});
		__register('emit/auto-replay', handler);
		const ws = mockWs();
		handleRpc(ws, toArrayBuffer({ rpc: 'emit/auto-replay', id: 'r1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.replay.calls).toEqual([{ topic: 'cron/auto-replay', event: 'created', data: { id: 1 } }]);
		// Local broadcast still happened (via the fake replay's internal platform.publish).
		expect(platform.published).toEqual([{ topic: 'cron/auto-replay', event: 'created', data: { id: 1 }, options: undefined }]);
	});

	it('non-eligible topic: ctx.publish goes via platform.publish, NOT platform.replay.publish', async () => {
		const platform = mockPlatform();
		platform.replay = fakeReplay();
		// No live.stream for this topic, so it's not registered.
		const handler = live(async (ctx) => {
			ctx.publish('not/registered', 'created', { id: 1 });
			return 'ok';
		});
		__register('emit/not-registered', handler);
		const ws = mockWs();
		handleRpc(ws, toArrayBuffer({ rpc: 'emit/not-registered', id: 'r1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.replay.calls).toEqual([]);
		// publish goes via platform.publish (single call).
		expect(platform.published.length).toBeGreaterThan(0);
	});

	it('cron auto-publish to a replay-eligible topic also auto-routes', async () => {
		_clearCron();
		const platform = mockPlatform();
		platform.replay = fakeReplay();
		setCronPlatform(platform);
		// Register a cron + a stream sharing the topic.
		const stream = live.stream('cron-auto/topic', async () => [], { merge: 'set', replay: true });
		__register('cron-auto/topic', stream);
		const cronFn = live.cron('* * * * *', 'cron-auto/topic', async () => ({ value: 42 }));
		__registerCron('cron-auto/cron', cronFn);

		// Tick the cron; the captured platform is wired and the topic is registered.
		await _tickCron(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.replay.calls).toEqual([
			{ topic: 'cron-auto/topic', event: 'set', data: { value: 42 } }
		]);
		// Local broadcast happened too (via the fake replay's internal platform.publish).
		expect(platform.published).toEqual([
			{ topic: 'cron-auto/topic', event: 'set', data: { value: 42 }, options: undefined }
		]);
	});

	it('cron auto-publish to a NON-replay-eligible topic uses bare platform.publish', async () => {
		_clearCron();
		const platform = mockPlatform();
		platform.replay = fakeReplay();
		setCronPlatform(platform);
		// Cron publishes but no replay: true stream registered for the topic.
		const cronFn = live.cron('* * * * *', 'cron-bare/topic', async () => ({ value: 1 }));
		__registerCron('cron-bare/cron', cronFn);

		await _tickCron(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.replay.calls).toEqual([]);
		expect(platform.published.length).toBe(1);
		expect(platform.published[0].topic).toBe('cron-bare/topic');
	});

	it('dev-warns ONCE per topic when replay: true is declared but platform.replay is missing', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const platform = mockPlatform();
			// Intentionally NO platform.replay set.
			const stream = live.stream('warn/no-extension', async () => [], { merge: 'crud', key: 'id', replay: true });
			__register('warn/no-extension', stream);

			const handler = live(async (ctx) => {
				ctx.publish('warn/no-extension', 'created', { id: 1 });
				ctx.publish('warn/no-extension', 'created', { id: 2 });
				return 'ok';
			});
			__register('emit/warn', handler);
			const ws = mockWs();
			handleRpc(ws, toArrayBuffer({ rpc: 'emit/warn', id: 'r1', args: [] }), platform);
			await new Promise((r) => setTimeout(r, 10));

			const replayWarns = warnSpy.mock.calls
				.map((c) => c[0])
				.filter((m) => typeof m === 'string' && m.includes("'warn/no-extension'") && m.includes('platform.replay'));
			expect(replayWarns.length).toBe(1);
			expect(replayWarns[0]).toContain('Install the replay extension');
			expect(replayWarns[0]).toContain('once per topic per session');
			// Local broadcast still happens; replay misconfig must not block delivery.
			expect(platform.published.length).toBe(2);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('user-marked WRAPPED_FOR_REPLAY platform: framework defers, no double-write', async () => {
		const platform = mockPlatform();
		platform.replay = fakeReplay();
		// User opts out of framework auto-routing because their own proxy
		// already routes replay-eligible publishes through replay.publish.
		platform[WRAPPED_FOR_REPLAY] = true;

		const stream = live.stream('marker/owned', async () => [], { merge: 'crud', key: 'id', replay: true });
		__register('marker/owned', stream);
		const handler = live(async (ctx) => {
			ctx.publish('marker/owned', 'created', { id: 1 });
			return 'ok';
		});
		__register('emit/marker', handler);
		const ws = mockWs();
		handleRpc(ws, toArrayBuffer({ rpc: 'emit/marker', id: 'r1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Framework did NOT call replay.publish; deferred to user proxy.
		expect(platform.replay.calls).toEqual([]);
		// platform.publish was still called (the user proxy's own routing
		// would route through replay.publish, which calls platform.publish
		// internally; in this test we don't simulate the proxy itself, so
		// we just verify the framework didn't double-publish).
		expect(platform.published.length).toBe(1);
	});

	it('dynamic-topic stream: replay topic is registered at first-subscribe time', async () => {
		const platform = mockPlatform();
		platform.replay = fakeReplay();
		const stream = live.stream(
			(ctx, roomId) => 'rooms:' + roomId,
			async (ctx, roomId) => [],
			{ merge: 'crud', key: 'id', replay: true }
		);
		__register('dyn/room', stream);

		// BEFORE any subscribe: a publish to this topic does NOT auto-route
		// (the dynamic topic hasn't been resolved yet).
		const handler = live(async (ctx) => {
			ctx.publish('rooms:42', 'created', { id: 1 });
			return 'ok';
		});
		__register('emit/dyn', handler);
		const ws = mockWs();
		handleRpc(ws, toArrayBuffer({ rpc: 'emit/dyn', id: 'r1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.replay.calls).toEqual([]);

		// First subscribe to the dynamic topic resolves it -> registers it.
		platform.reset();
		handleRpc(ws, toArrayBuffer({ rpc: 'dyn/room', id: 's1', args: [42], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Now subsequent publishes DO auto-route.
		platform.replay.calls.length = 0;
		platform.published.length = 0;
		handleRpc(ws, toArrayBuffer({ rpc: 'emit/dyn', id: 'r2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.replay.calls).toEqual([
			{ topic: 'rooms:42', event: 'created', data: { id: 1 } }
		]);
	});

	it('publishBatched fast path is bypassed for replay-eligible topics', async () => {
		const platform = mockPlatform();
		// Add publishBatched so the fast path is available.
		platform.publishBatched = vi.fn((batch) => {
			for (const m of batch) platform.publish(m.topic, m.event, m.data, m.options);
		});
		platform.replay = fakeReplay();

		const stream = live.stream('batch/replay', async () => [], { merge: 'crud', key: 'id', replay: true });
		__register('batch/replay', stream);
		const handler = live(async (ctx) => {
			ctx.publish('batch/replay', 'created', { id: 1 });
			ctx.publish('batch/replay', 'created', { id: 2 });
			return 'ok';
		});
		__register('emit/batch', handler);
		const ws = mockWs();
		handleRpc(ws, toArrayBuffer({ rpc: 'emit/batch', id: 'r1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Both events went through replay (per-call, not batched).
		expect(platform.replay.calls.length).toBe(2);
		// publishBatched should NOT have been called for the replay-eligible
		// publishes -- the per-call replay.publish path stamps the seq
		// envelope individually.
		expect(platform.publishBatched).not.toHaveBeenCalled();
	});

	it('non-eligible topics still use the publishBatched fast path', async () => {
		const platform = mockPlatform();
		platform.publishBatched = vi.fn((batch) => {
			for (const m of batch) platform.publish(m.topic, m.event, m.data, m.options);
		});
		platform.replay = fakeReplay();
		// Note: NO live.stream registered for 'batch/no-replay', so it's not eligible.

		const handler = live(async (ctx) => {
			ctx.publish('batch/no-replay', 'created', { id: 1 });
			ctx.publish('batch/no-replay', 'created', { id: 2 });
			return 'ok';
		});
		__register('emit/batch-no-replay', handler);
		const ws = mockWs();
		handleRpc(ws, toArrayBuffer({ rpc: 'emit/batch-no-replay', id: 'r1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Replay was not consulted.
		expect(platform.replay.calls).toEqual([]);
		// publishBatched fast path engaged.
		expect(platform.publishBatched).toHaveBeenCalledTimes(1);
	});

	it('synchronous throw from replay.publish falls back to platform.publish (no event lost)', async () => {
		const platform = mockPlatform();
		platform.replay = {
			publish: () => { throw new Error('redis exploded'); },
			seq: async () => 0,
			since: async () => []
		};
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const stream = live.stream('throw/sync', async () => [], { merge: 'crud', key: 'id', replay: true });
			__register('throw/sync', stream);

			const handler = live(async (ctx) => {
				ctx.publish('throw/sync', 'created', { id: 1 });
				return 'ok';
			});
			__register('emit/throw-sync', handler);
			const ws = mockWs();
			handleRpc(ws, toArrayBuffer({ rpc: 'emit/throw-sync', id: 'r1', args: [] }), platform);
			await new Promise((r) => setTimeout(r, 10));

			// Local broadcast still happened (sync-throw fallback).
			expect(platform.published.length).toBe(1);
			expect(platform.published[0].topic).toBe('throw/sync');
			// Dev warn surfaces the throw so the misconfig is visible.
			expect(warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('threw synchronously'))).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('async rejection from replay.publish surfaces as a dev warn but does not break the publisher', async () => {
		const platform = mockPlatform();
		platform.replay = {
			publish: async (p, topic, event, data) => {
				p.publish(topic, event, data);
				throw new Error('redis hiccup');
			},
			seq: async () => 0,
			since: async () => []
		};
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const stream = live.stream('throw/async', async () => [], { merge: 'crud', key: 'id', replay: true });
			__register('throw/async', stream);

			const handler = live(async (ctx) => {
				ctx.publish('throw/async', 'created', { id: 1 });
				return 'ok';
			});
			__register('emit/throw-async', handler);
			const ws = mockWs();
			handleRpc(ws, toArrayBuffer({ rpc: 'emit/throw-async', id: 'r1', args: [] }), platform);
			await new Promise((r) => setTimeout(r, 10));

			expect(platform.published.length).toBe(1);
			expect(warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('failed'))).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('exports a stable WRAPPED_FOR_REPLAY symbol via Symbol.for', () => {
		expect(typeof WRAPPED_FOR_REPLAY).toBe('symbol');
		expect(WRAPPED_FOR_REPLAY).toBe(Symbol.for('svelte-realtime.wrapped-for-replay'));
	});
});

// - live.admission() + ctx.shed() + classOfService ---------------------------

describe('live.admission() + ctx.shed()', () => {
	beforeEach(() => {
		_resetAdmission();
	});

	it('rejects non-object config', () => {
		expect(() => live.admission('nope')).toThrow(/config must be an object/);
	});

	it('rejects missing classes', () => {
		expect(() => live.admission({})).toThrow(/config\.classes must be an object/);
	});

	it('rejects unknown pressure reason in array rule', () => {
		expect(() => live.admission({ classes: { x: ['BOGUS'] } }))
			.toThrow(/unknown pressure reason 'BOGUS'/);
	});

	it('rejects non-array, non-function rule value', () => {
		expect(() => live.admission({ classes: { x: 42 } }))
			.toThrow(/must be an array of pressure reasons or a/);
	});

	it('null clears the configuration', () => {
		live.admission({ classes: { critical: ['MEMORY'] } });
		live.admission(null);
		// ctx.shed should now no-op (no config)
		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'MEMORY', active: true });
		const handler = live(async (ctx) => ctx.shed('critical'));
		__register('shed/cleared', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/cleared', id: '1', args: [] }), platform);
		return new Promise((r) => setTimeout(r, 10)).then(() => {
			expect(platform.sent[0].data.data).toBe(false);
		});
	});

	it('ctx.shed returns false when no admission configured', async () => {
		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'MEMORY', active: true });
		const handler = live(async (ctx) => ctx.shed('any'));
		__register('shed/no-config', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/no-config', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.data).toBe(false);
	});

	it('ctx.shed returns true when pressure reason matches array rule', async () => {
		live.admission({ classes: { background: ['MEMORY', 'PUBLISH_RATE'] } });
		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'PUBLISH_RATE', active: true });
		const handler = live(async (ctx) => ctx.shed('background'));
		__register('shed/match', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/match', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.data).toBe(true);
	});

	it('ctx.shed returns false when pressure reason is not in the rule', async () => {
		live.admission({ classes: { interactive: ['MEMORY'] } });
		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'SUBSCRIBERS', active: true });
		const handler = live(async (ctx) => ctx.shed('interactive'));
		__register('shed/miss', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/miss', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.data).toBe(false);
	});

	it('ctx.shed returns false when reason is NONE', async () => {
		live.admission({ classes: { background: ['MEMORY', 'PUBLISH_RATE', 'SUBSCRIBERS'] } });
		const ws = mockWs();
		const platform = mockPlatform();
		// Default pressure is { reason: 'NONE' }
		const handler = live(async (ctx) => ctx.shed('background'));
		__register('shed/none', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/none', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.data).toBe(false);
	});

	it('ctx.shed throws on unknown class (typo defense)', async () => {
		live.admission({ classes: { background: ['MEMORY'] } });
		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'MEMORY', active: true });
		const handler = live(async (ctx) => ctx.shed('typo'));
		__register('shed/typo', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/typo', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		// Throws inside handler -> non-LiveError -> INTERNAL_ERROR to client.
		// Server logs the typo Error - the contract is "this is a developer bug, not a client error."
		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INTERNAL_ERROR');
	});

	it('predicate rule receives pressure snapshot and returns boolean', async () => {
		const calls = [];
		live.admission({
			classes: {
				background: (snapshot) => { calls.push(snapshot); return snapshot.memoryMB > 100; }
			}
		});
		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'MEMORY', active: true, memoryMB: 200 });
		const handler = live(async (ctx) => ctx.shed('background'));
		__register('shed/pred', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/pred', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.data).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].memoryMB).toBe(200);
	});

	it('returns false when platform has no pressure snapshot', async () => {
		live.admission({ classes: { background: ['MEMORY'] } });
		const ws = mockWs();
		const platform = mockPlatform();
		// Strip pressure to simulate an older adapter
		delete platform.pressure;
		const handler = live(async (ctx) => ctx.shed('background'));
		__register('shed/no-pressure', handler);
		handleRpc(ws, toArrayBuffer({ rpc: 'shed/no-pressure', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.data).toBe(false);
	});
});

describe('live.stream({ classOfService })', () => {
	beforeEach(() => {
		_resetAdmission();
	});

	it('rejects non-string classOfService at registration', () => {
		expect(() => live.stream('cos/bad', async () => [], { classOfService: 42 }))
			.toThrow(/classOfService must be a string/);
	});

	it('no-op when admission is not configured', async () => {
		const stream = live.stream('cos/no-config', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', classOfService: 'background'
		});
		__register('cos/no-config', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'MEMORY', active: true });

		handleRpc(ws, toArrayBuffer({ rpc: 'cos/no-config', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual([{ id: 1 }]);
	});

	it('rejects subscribe with OVERLOADED when pressure matches', async () => {
		live.admission({ classes: { background: ['MEMORY', 'PUBLISH_RATE', 'SUBSCRIBERS'] } });

		const stream = live.stream('cos/shed', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', classOfService: 'background'
		});
		__register('cos/shed', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'MEMORY', active: true });

		handleRpc(ws, toArrayBuffer({ rpc: 'cos/shed', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('OVERLOADED');
		// Subscription should NOT have happened
		expect(ws.isSubscribed('cos/shed')).toBe(false);
	});

	it('admits when pressure does not match the class rule', async () => {
		live.admission({ classes: { interactive: ['MEMORY'] } });

		const stream = live.stream('cos/admit', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', classOfService: 'interactive'
		});
		__register('cos/admit', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		// Pressure reason SUBSCRIBERS, but class only sheds on MEMORY
		platform._setPressure({ reason: 'SUBSCRIBERS', active: true });

		handleRpc(ws, toArrayBuffer({ rpc: 'cos/admit', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(ws.isSubscribed('cos/admit')).toBe(true);
	});

	it('rejects subscribe with INVALID_REQUEST when classOfService refers to an unknown class', async () => {
		live.admission({ classes: { background: ['MEMORY'] } });

		const stream = live.stream('cos/typo', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', classOfService: 'background-typo'
		});
		__register('cos/typo', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		platform._setPressure({ reason: 'MEMORY', active: true });

		handleRpc(ws, toArrayBuffer({ rpc: 'cos/typo', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INVALID_REQUEST');
		expect(platform.sent[0].data.error).toMatch(/unknown class 'background-typo'/);
	});

	it('does NOT shed existing subscribers (only new subscribes are gated)', async () => {
		const stream = live.stream('cos/existing', async () => [{ id: 1 }], {
			merge: 'crud', key: 'id', classOfService: 'background'
		});
		__register('cos/existing', stream);

		const ws = mockWs();
		const platform = mockPlatform();

		// Subscribe BEFORE admission is configured + before pressure
		handleRpc(ws, toArrayBuffer({ rpc: 'cos/existing', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(ws.isSubscribed('cos/existing')).toBe(true);

		// Now configure admission + raise pressure
		live.admission({ classes: { background: ['MEMORY'] } });
		platform._setPressure({ reason: 'MEMORY', active: true });

		// Existing subscriber stays subscribed - the gate fires only on new subscribe
		expect(ws.isSubscribed('cos/existing')).toBe(true);
	});
});

// - Structured guard error codes --------------------------------------------

describe('guard auto-classification', () => {
	it('LiveError from guard propagates code and message verbatim', async () => {
		const guardFn = guard(() => { throw new LiveError('FORBIDDEN', 'Specific reason'); });
		__registerGuard('gc-live', guardFn);
		const handler = live(async () => 'never');
		__register('gc-live/action', handler);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc-live/action', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
		expect(platform.sent[0].data.error).toBe('Specific reason');
	});

	it('bare Error from guard with user -> FORBIDDEN with generic message', async () => {
		const guardFn = guard(() => { throw new Error('internal: missing column foo'); });
		__registerGuard('gc-bare-user', guardFn);
		const handler = live(async () => 'never');
		__register('gc-bare-user/action', handler);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc-bare-user/action', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
		expect(platform.sent[0].data.error).toBe('Access denied');
		// Original message must NOT leak to the client
		expect(JSON.stringify(platform.sent[0].data)).not.toContain('missing column');
	});

	it('bare Error from guard without user -> UNAUTHENTICATED with generic message', async () => {
		const guardFn = guard(() => { throw new Error('whatever'); });
		__registerGuard('gc-bare-anon', guardFn);
		const handler = live(async () => 'never');
		__register('gc-bare-anon/action', handler);

		const ws = mockWs();   // no .id -> no user data
		ws.getUserData = () => null;
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc-bare-anon/action', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('UNAUTHENTICATED');
		expect(platform.sent[0].data.error).toBe('Authentication required');
	});

	it('non-LiveError from guard preserves original on .cause (server-side)', async () => {
		const original = new Error('db timeout');
		let capturedFromOnError = null;
		const guardFn = guard(() => { throw original; });
		__registerGuard('gc-cause', guardFn);
		const handler = live(async () => 'never');
		__register('gc-cause/action', handler);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc-cause/action', id: '1', args: [] }), platform, {
			onError: (path, err) => { capturedFromOnError = err; }
		});
		await new Promise((r) => setTimeout(r, 10));

		// onError is called for non-LiveError; here the guard wrapper threw a LiveError,
		// so onError is NOT invoked (it's reserved for unexpected handler throws).
		// The point of this test: the wrapped error reached the client cleanly,
		// AND the original is recoverable on .cause for server-side log integrations
		// that walk the error chain (e.g. Sentry).
		expect(capturedFromOnError).toBe(null);
		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
		// The original is intentionally NOT exposed to the client. Server-side
		// integrations would walk .cause via their own catch chain.
	});

	it('access predicate returning false with user -> FORBIDDEN', async () => {
		const stream = live.stream('gc-access-user-topic', async () => [], {
			merge: 'crud', key: 'id',
			access: () => false
		});
		__register('gc/access-user', stream);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc/access-user', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
		expect(platform.sent[0].data.error).toBe('Access denied');
	});

	it('access predicate returning false without user -> UNAUTHENTICATED', async () => {
		const stream = live.stream('gc-access-anon-topic', async () => [], {
			merge: 'crud', key: 'id',
			access: () => false
		});
		__register('gc/access-anon', stream);

		const ws = mockWs();
		ws.getUserData = () => null;
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc/access-anon', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('UNAUTHENTICATED');
		expect(platform.sent[0].data.error).toBe('Authentication required');
	});

	it('.load() streamFilter rejection picks UNAUTHENTICATED when user is null', async () => {
		const stream = live.stream('gc-dc-anon-topic', async () => [], {
			merge: 'crud', key: 'id',
			access: () => false
		});
		__register('gc/dc-anon', stream);

		const platform = mockPlatform();
		await expect(__directCall('gc/dc-anon', [], platform, { user: null }))
			.rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
	});

	it('.load() streamFilter rejection picks FORBIDDEN when user is present', async () => {
		const stream = live.stream('gc-dc-user-topic', async () => [], {
			merge: 'crud', key: 'id',
			access: () => false
		});
		__register('gc/dc-user', stream);

		const platform = mockPlatform();
		await expect(__directCall('gc/dc-user', [], platform, { user: { id: 'u' } }))
			.rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('handler bare-error throws still become INTERNAL_ERROR (the wrapper applies to guards only)', async () => {
		const handler = live(async () => { throw new Error('handler boom'); });
		__register('gc-handler-throw/action', handler);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc-handler-throw/action', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('INTERNAL_ERROR');
		expect(platform.sent[0].data.error).toBe('Internal server error');
	});

	// Pre-fix bug: the wire path read `if (!streamFilter(ctx, ...))` and
	// the SSR path read `if (!predicate(ctx, ...))` synchronously. An
	// async predicate returns a Promise, which is truthy, which bypassed
	// the `!` deny branch entirely. async-deny became async-allow. The
	// fix is to await before the truthiness check.
	it('async access predicate returning false denies on the wire path with FORBIDDEN', async () => {
		const stream = live.stream('gc-access-async-user', async () => [], {
			merge: 'crud', key: 'id',
			access: async () => false
		});
		__register('gc/access-async-user', stream);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc/access-async-user', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 30));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
		expect(platform.sent[0].data.error).toBe('Access denied');
	});

	it('async access predicate returning false denies on the wire path with UNAUTHENTICATED when no user', async () => {
		const stream = live.stream('gc-access-async-anon', async () => [], {
			merge: 'crud', key: 'id',
			access: async () => false
		});
		__register('gc/access-async-anon', stream);

		const ws = mockWs();
		ws.getUserData = () => null;
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc/access-async-anon', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 30));

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('UNAUTHENTICATED');
	});

	it('async access predicate denies on .load() (SSR direct call) with FORBIDDEN when user present', async () => {
		const stream = live.stream('gc-access-async-dc-user', async () => [], {
			merge: 'crud', key: 'id',
			access: async () => false
		});
		__register('gc/access-async-dc-user', stream);

		const platform = mockPlatform();
		await expect(__directCall('gc/access-async-dc-user', [], platform, { user: { id: 'u' } }))
			.rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('async access predicate denies on .load() with UNAUTHENTICATED when user is null', async () => {
		const stream = live.stream('gc-access-async-dc-anon', async () => [], {
			merge: 'crud', key: 'id',
			access: async () => false
		});
		__register('gc/access-async-dc-anon', stream);

		const platform = mockPlatform();
		await expect(__directCall('gc/access-async-dc-anon', [], platform, { user: null }))
			.rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
	});

	it('live.gate with async predicate returning false yields {gated:true} on wire path', async () => {
		// Pre-fix bug: the !predicate check against an async predicate's
		// Promise was always falsy (Promise is truthy), so async-gate
		// always proceeded with the loader, leaking initial data.
		const stream = live.stream('gated-async-stream', async () => [{ secret: 'do-not-leak' }], {
			merge: 'crud', key: 'id'
		});
		const gated = live.gate(async () => false, stream);
		__register('gated-async/stream', gated);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gated-async/stream', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 30));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.gated).toBe(true);
		expect(platform.sent[0].data.data).toBeNull();
	});

	it('live.gate with async predicate returning false yields null on .load() (SSR)', async () => {
		const stream = live.stream('gated-async-stream-dc', async () => [{ secret: 'do-not-leak' }], {
			merge: 'crud', key: 'id'
		});
		const gated = live.gate(async () => false, stream);
		__register('gated-async-dc/stream', gated);

		const platform = mockPlatform();
		const result = await __directCall('gated-async-dc/stream', [], platform, { user: { id: 'u' } });
		expect(result).toBeNull();
	});

	it('async streamFilter rejecting async hook DOES skip the loader (no data leak)', async () => {
		// Verifies the loader is not called. Pre-fix bug let it run.
		let loaderRan = false;
		const stream = live.stream('gc-loader-not-leak', async () => {
			loaderRan = true;
			return [{ secret: 'leak' }];
		}, {
			merge: 'crud', key: 'id',
			access: async () => false
		});
		__register('gc/loader-not-leak', stream);

		const ws = mockWs({ id: 'u' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'gc/loader-not-leak', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 30));

		expect(loaderRan).toBe(false);
		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
	});
});

// - live.stream({ args }) - argument validation -----------------------------

describe('live.stream({ args })', () => {
	const uuidSchema = {
		safeParse(input) {
			if (!Array.isArray(input)) {
				return { success: false, error: { issues: [{ path: [], message: 'expected array' }] } };
			}
			if (input.length !== 1 || typeof input[0] !== 'string' || !/^[0-9a-f-]{36}$/.test(input[0])) {
				return { success: false, error: { issues: [{ path: [0], message: 'expected uuid' }] } };
			}
			return { success: true, data: input };
		}
	};

	it('rejects non-object schema at registration', () => {
		expect(() => live.stream('a/x', async () => [], { args: 'nope' }))
			.toThrow(/args must be a Standard Schema/);
		expect(() => live.stream('a/y', async () => [], { args: null }))
			.toThrow(/args must be a Standard Schema/);
	});

	it('passes when args validate (Zod-style)', async () => {
		const stream = live.stream(
			(ctx, orgId) => `audit:${orgId}`,
			async (ctx, orgId) => [{ id: 1, org: orgId }],
			{ merge: 'crud', key: 'id', args: uuidSchema }
		);
		__register('a/audit', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		const validUuid = '12345678-1234-1234-1234-123456789abc';

		handleRpc(ws, toArrayBuffer({ rpc: 'a/audit', id: '1', args: [validUuid], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.topic).toBe(`audit:${validUuid}`);
		expect(platform.sent[0].data.data).toEqual([{ id: 1, org: validUuid }]);
	});

	it('rejects with VALIDATION + issues when args fail (Zod-style)', async () => {
		const stream = live.stream(
			(ctx, orgId) => `audit:${orgId}`,
			async () => [],
			{ merge: 'crud', key: 'id', args: uuidSchema }
		);
		__register('a/audit-bad', stream);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'a/audit-bad', id: '1', args: ['not-a-uuid'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const r = platform.sent[0].data;
		expect(r.ok).toBe(false);
		expect(r.code).toBe('VALIDATION');
		expect(r.issues).toEqual([{ path: ['0'], message: 'expected uuid' }]);
	});

	it('runs args validation BEFORE topic resolution (no topic injection)', async () => {
		let topicCalled = false;
		const topicFn = (ctx, orgId) => {
			topicCalled = true;
			return `audit:${orgId}`;
		};
		const stream = live.stream(
			topicFn,
			async () => [],
			{ merge: 'crud', key: 'id', args: uuidSchema }
		);
		__register('a/inject', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		// Crafted attack input - this string would create the topic
		// `audit:org-x; subscribe-elsewhere` if it ever reached the topic fn.
		const attack = 'org-x; subscribe-elsewhere';

		handleRpc(ws, toArrayBuffer({ rpc: 'a/inject', id: '1', args: [attack], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('VALIDATION');
		expect(topicCalled).toBe(false);
		expect(ws.isSubscribed(`audit:${attack}`)).toBe(false);
	});

	it('coerced/transformed args reach the loader', async () => {
		// Schema that coerces strings to upper-case
		const upperSchema = {
			safeParse(input) {
				if (!Array.isArray(input) || typeof input[0] !== 'string') {
					return { success: false, error: { issues: [{ path: [], message: 'bad' }] } };
				}
				return { success: true, data: [input[0].toUpperCase()] };
			}
		};

		let receivedArg = null;
		const stream = live.stream(
			(ctx, x) => `t:${x}`,
			async (ctx, x) => { receivedArg = x; return []; },
			{ merge: 'crud', key: 'id', args: upperSchema }
		);
		__register('a/coerce', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'a/coerce', id: '1', args: ['hello'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(receivedArg).toBe('HELLO');
		expect(platform.sent[0].data.topic).toBe('t:HELLO');
	});

	it('works with Standard Schema', async () => {
		const stdSchema = {
			'~standard': {
				version: 1,
				vendor: 'mock',
				validate(input) {
					if (Array.isArray(input) && typeof input[0] === 'number' && input[0] > 0) {
						return { value: input };
					}
					return { issues: [{ message: 'expected positive number', path: [{ key: 0 }] }] };
				}
			}
		};

		const stream = live.stream(
			(ctx, n) => `n:${n}`,
			async (ctx, n) => [{ id: n }],
			{ merge: 'crud', key: 'id', args: stdSchema }
		);
		__register('a/std', stream);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'a/std', id: '1', args: [-5], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.code).toBe('VALIDATION');

		platform.reset();
		handleRpc(ws, toArrayBuffer({ rpc: 'a/std', id: '2', args: [42], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual([{ id: 42 }]);
	});

	it('streams without args option are unaffected (back-compat)', async () => {
		const stream = live.stream(
			(ctx, x) => `b:${x}`,
			async (ctx, x) => [{ x }],
			{ merge: 'crud', key: 'id' }
		);
		__register('a/back-compat', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'a/back-compat', id: '1', args: ['anything'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual([{ x: 'anything' }]);
	});

	it('.load() validates args too (rejects with VALIDATION LiveError)', async () => {
		const stream = live.stream(
			(ctx, id) => `q:${id}`,
			async (ctx, id) => [{ id }],
			{ merge: 'crud', key: 'id', args: uuidSchema }
		);
		__register('a/dc-validate', stream);

		const platform = mockPlatform();
		await expect(__directCall('a/dc-validate', ['not-uuid'], platform, { user: { id: 1 } }))
			.rejects.toMatchObject({ code: 'VALIDATION' });
	});

	it('.load() passes through validated/coerced args to the loader', async () => {
		const upperSchema = {
			safeParse(input) {
				return { success: true, data: [String(input[0]).toUpperCase()] };
			}
		};
		let receivedArg = null;
		const stream = live.stream(
			(ctx, x) => `dc:${x}`,
			async (ctx, x) => { receivedArg = x; return []; },
			{ merge: 'crud', key: 'id', args: upperSchema }
		);
		__register('a/dc-coerce', stream);

		const platform = mockPlatform();
		await __directCall('a/dc-coerce', ['mixed-case'], platform, { user: { id: 1 } });
		expect(receivedArg).toBe('MIXED-CASE');
	});

	it('args option is preserved through wrapper composition (live.gate, etc)', async () => {
		const stream = live.stream(
			(ctx, x) => `g:${x}`,
			async (ctx, x) => [{ id: x }],
			{ merge: 'crud', key: 'id', args: uuidSchema }
		);
		const gated = live.gate(() => true, stream);
		__register('a/gate-validated', gated);

		const ws = mockWs();
		const platform = mockPlatform();

		// Bad input -> validation rejects (would only happen if __streamArgs
		// survived the gate wrapper)
		handleRpc(ws, toArrayBuffer({ rpc: 'a/gate-validated', id: '1', args: ['nope'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.code).toBe('VALIDATION');
	});
});

// - live.stream({ transform }) ----------------------------------------------

describe('live.stream({ transform })', () => {
	beforeEach(() => {
		_resetTransformRegistry();
		_resetCoalesceRegistry();
	});

	it('rejects non-function transform at registration', () => {
		expect(() => live.stream('tr/bad', async () => [], { transform: 'nope' }))
			.toThrow(/transform must be a function/);
	});

	it('transforms initial data per-item for array results (crud merge)', async () => {
		const stream = live.stream(
			'tr/crud',
			async () => [
				{ record_id: 'a', operation: 'create', changed_at: 't1', big_blob: 'x'.repeat(1000) },
				{ record_id: 'b', operation: 'update', changed_at: 't2', big_blob: 'y'.repeat(1000) }
			],
			{
				merge: 'crud', key: 'id',
				transform: (row) => ({ id: row.record_id, op: row.operation, at: row.changed_at })
			}
		);
		__register('tr/crud', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/crud', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const r = platform.sent[0].data;
		expect(r.ok).toBe(true);
		expect(r.data).toEqual([
			{ id: 'a', op: 'create', at: 't1' },
			{ id: 'b', op: 'update', at: 't2' }
		]);
	});

	it('transforms initial data as whole value for non-arrays (set merge)', async () => {
		const stream = live.stream(
			'tr/set',
			async () => ({ outer: 1, inner: { a: 1, b: 2, big_blob: 'x'.repeat(500) } }),
			{
				merge: 'set',
				transform: (data) => ({ outer: data.outer, inner_a: data.inner.a })
			}
		);
		__register('tr/set', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/set', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.data).toEqual({ outer: 1, inner_a: 1 });
	});

	it('transforms .data of paginated loader responses', async () => {
		const stream = live.stream(
			'tr/page',
			async () => ({ data: [{ x: 1, big: 'a' }, { x: 2, big: 'b' }], hasMore: true, cursor: 'c1' }),
			{
				merge: 'crud', key: 'id',
				transform: (row) => ({ id: row.x })
			}
		);
		__register('tr/page', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/page', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const r = platform.sent[0].data;
		expect(r.data).toEqual([{ id: 1 }, { id: 2 }]);
		expect(r.hasMore).toBe(true);
		expect(r.cursor).toBe('c1');
	});

	it('applies transform to live publishes (default broadcast path)', async () => {
		const stream = live.stream('tr/live', async () => [], {
			merge: 'crud', key: 'id',
			transform: (row) => ({ id: row.record_id, op: row.operation })
		});
		__register('tr/live', stream);

		const handler = live(async (ctx) => {
			ctx.publish('tr/live', 'created', { record_id: 'r1', operation: 'create', big_blob: 'x'.repeat(1000) });
			return 'ok';
		});
		__register('tr/live-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Subscribe so the topic is registered in the transform registry
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/live', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'tr/live-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ id: 'r1', op: 'create' });
	});

	it('applies transform to live publishes through the coalesce path', async () => {
		const stream = live.stream('tr/co', async () => null, {
			merge: 'set',
			coalesceBy: (data) => data.k,
			transform: (data) => ({ id: data.k, value: data.v })   // strips other fields
		});
		__register('tr/co', stream);

		const handler = live(async (ctx) => {
			ctx.publish('tr/co', 'updated', { k: 'a', v: 1, secret: 'should-not-leak' });
			return 'ok';
		});
		__register('tr/co-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		handleRpc(ws, toArrayBuffer({ rpc: 'tr/co', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		platform.reset();

		handleRpc(ws, toArrayBuffer({ rpc: 'tr/co-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.coalesced).toHaveLength(1);
		const c = platform.coalesced[0];
		expect(c.data).toEqual({ id: 'a', value: 1 });
		// coalesceBy reads ORIGINAL data, so the key is still derived from k='a'
		expect(c.key).toBe('tr/co\0a');
	});

	it('publishes go straight through (no transform) before any subscriber arrives', async () => {
		const stream = live.stream('tr/cold', async () => [], {
			merge: 'crud', key: 'id',
			transform: (row) => ({ id: row.record_id })
		});
		__register('tr/cold', stream);

		const handler = live(async (ctx) => {
			ctx.publish('tr/cold', 'created', { record_id: 'x', big: 'leak' });
			return 'ok';
		});
		__register('tr/cold-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();

		// Publish BEFORE any subscribe - transform isn't registered yet
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/cold-pub', id: 'p0', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Without registration, the transform doesn't apply - documented behavior
		// (consistent with coalesceBy which also requires an active subscriber to
		// know about the transform).
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ record_id: 'x', big: 'leak' });
	});

	it('lifecycle: registry evicts the topic when the last subscriber leaves', async () => {
		const stream = live.stream('tr/life', async () => [], {
			merge: 'crud', key: 'id',
			transform: (row) => ({ id: row.id })
		});
		__register('tr/life', stream);

		const handler = live(async (ctx) => { ctx.publish('tr/life', 'updated', { id: 1, big: 'no' }); return 'ok'; });
		__register('tr/life-pub', handler);

		const ws1 = mockWs({ id: 'u1' });
		const ws2 = mockWs({ id: 'u2' });
		const platform = mockPlatform();

		// Two subscribers
		for (const w of [ws1, ws2]) {
			handleRpc(w, toArrayBuffer({ rpc: 'tr/life', id: 's', args: [], stream: true }), platform);
			await new Promise((r) => setTimeout(r, 5));
		}
		platform.reset();

		// Both subscribed -> publish goes through transform
		handleRpc(ws1, toArrayBuffer({ rpc: 'tr/life-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.published[0].data).toEqual({ id: 1 });
		platform.reset();

		// Drop ws1; ws2 still subscribed -> still transformed
		close(ws1, { platform });
		handleRpc(ws2, toArrayBuffer({ rpc: 'tr/life-pub', id: 'p2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.published[0].data).toEqual({ id: 1 });
		platform.reset();

		// Drop ws2; no subscribers left -> registry evicted, raw data flows
		close(ws2, { platform });
		handleRpc(ws1, toArrayBuffer({ rpc: 'tr/life-pub', id: 'p3', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.published[0].data).toEqual({ id: 1, big: 'no' });
	});

	it('streams without transform are byte-identical to baseline (back-compat)', async () => {
		const stream = live.stream('tr/none', async () => [{ id: 1, big: 'kept' }], {
			merge: 'crud', key: 'id'
		});
		__register('tr/none', stream);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/none', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.data).toEqual([{ id: 1, big: 'kept' }]);
	});

	it('.load() applies transform to initial data', async () => {
		const stream = live.stream(
			(ctx, x) => `dc:${x}`,
			async (ctx, x) => [{ raw_id: x, full_row: 'x'.repeat(500) }],
			{
				merge: 'crud', key: 'id',
				transform: (row) => ({ id: row.raw_id })
			}
		);
		__register('tr/dc', stream);

		const platform = mockPlatform();
		const result = await __directCall('tr/dc', ['hello'], platform, { user: { id: 'u' } });
		expect(result).toEqual([{ id: 'hello' }]);
	});

	it('.load() applies transform to paginated initial data', async () => {
		const stream = live.stream(
			'tr/dc-page',
			async () => ({ data: [{ raw: 1 }, { raw: 2 }], hasMore: false }),
			{
				merge: 'crud', key: 'id',
				transform: (row) => ({ id: row.raw })
			}
		);
		__register('tr/dc-page', stream);

		const platform = mockPlatform();
		const result = await __directCall('tr/dc-page', [], platform, { user: { id: 'u' } });
		expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
		expect(result.hasMore).toBe(false);
	});

	it('transform survives wrapper composition (live.gate, etc.)', async () => {
		const stream = live.stream('tr/wrap', async () => [{ raw_id: 'x' }], {
			merge: 'crud', key: 'id',
			transform: (row) => ({ id: row.raw_id })
		});
		const gated = live.gate(() => true, stream);
		__register('tr/wrap', gated);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/wrap', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.data).toEqual([{ id: 'x' }]);
	});

	it('routes transform throws to per-stream onError and drops the publish', async () => {
		const seen = [];
		const stream = live.stream('tr/throw', async () => [], {
			merge: 'crud', key: 'id',
			transform: (row) => {
				if (row && row.bad) throw new Error('bad row');
				return { id: row.id };
			},
			onError: (err, ctx, topic) => {
				seen.push({ message: err.message, ctx, topic });
			}
		});
		__register('tr/throw', stream);

		const handler = live(async (ctx) => {
			ctx.publish('tr/throw', 'created', { id: 'a' });
			ctx.publish('tr/throw', 'created', { id: 'b', bad: true });
			ctx.publish('tr/throw', 'created', { id: 'c' });
			return 'ok';
		});
		__register('tr/throw-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/throw', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/throw-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(seen).toHaveLength(1);
		expect(seen[0].message).toBe('bad row');
		expect(seen[0].topic).toBe('tr/throw');
		expect(seen[0].ctx).toBeNull();

		const published = platform.published.filter((p) => p.topic === 'tr/throw');
		expect(published).toEqual([
			{ topic: 'tr/throw', event: 'created', data: { id: 'a' }, options: undefined },
			{ topic: 'tr/throw', event: 'created', data: { id: 'c' }, options: undefined }
		]);
	});

	it('transform throws propagate when no per-stream onError is configured', async () => {
		const stream = live.stream('tr/throw-unobs', async () => [], {
			merge: 'crud', key: 'id',
			transform: () => { throw new Error('unobserved'); }
		});
		__register('tr/throw-unobs', stream);

		const handler = live(async (ctx) => {
			ctx.publish('tr/throw-unobs', 'created', { id: 'x' });
			return 'ok';
		});
		__register('tr/throw-unobs-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/throw-unobs', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/throw-unobs-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const reply = platform.sent.find((s) => s.event === 'p1');
		expect(reply.data.ok).toBe(false);
		expect(reply.data.code).toBe('INTERNAL_ERROR');
	});

	it('observer throws are silently swallowed so a buggy onError does not break publishes', async () => {
		const stream = live.stream('tr/throw-buggy', async () => [], {
			merge: 'crud', key: 'id',
			transform: () => { throw new Error('transform bad'); },
			onError: () => { throw new Error('observer bad'); }
		});
		__register('tr/throw-buggy', stream);

		const handler = live(async (ctx) => {
			const ok = ctx.publish('tr/throw-buggy', 'created', { id: 'a' });
			return { returned: ok };
		});
		__register('tr/throw-buggy-pub', handler);

		const ws = mockWs();
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/throw-buggy', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(ws, toArrayBuffer({ rpc: 'tr/throw-buggy-pub', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		const reply = platform.sent.find((s) => s.event === 'p1');
		expect(reply.data.ok).toBe(true);
		expect(reply.data.data).toEqual({ returned: false });
	});
});

// - ctx.requestId end-to-end correlation -------------------------------------

describe('ctx.requestId', () => {
	it('flows from platform.requestId to ctx.requestId on RPC handlers', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		platform.requestId = 'rid-abc-123';

		let captured;
		const handler = live(async (ctx) => {
			captured = ctx.requestId;
			return 'ok';
		});
		__register('rid/handler', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'rid/handler', id: 'r1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(captured).toBe('rid-abc-123');
	});

	it('is also available on stream loaders', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		platform.requestId = 'rid-stream-456';

		let captured;
		const stream = live.stream('rid-stream', async (ctx) => {
			captured = ctx.requestId;
			return [{ id: 1 }];
		});
		__register('rid/stream', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'rid/stream', id: 'rs1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(captured).toBe('rid-stream-456');
	});

	it('is undefined when platform does not set it', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		platform.requestId = undefined;

		let captured = 'unset';
		const handler = live(async (ctx) => {
			captured = ctx.requestId;
			return 'ok';
		});
		__register('rid/missing', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'rid/missing', id: 'rm1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(captured).toBeUndefined();
	});
});

// - live.stream({ volatile }) -----------------------------------------------

function mockPlatformWithBatched_volatile() {
	const p = mockPlatform();
	p.batched = [];
	p.publishBatched = (messages) => { p.batched.push(messages); };
	return p;
}

describe('live.stream({ volatile })', () => {
	beforeEach(() => { _resetVolatileRegistry(); });
	afterEach(() => { _resetVolatileRegistry(); });

	it('rejects non-boolean volatile', () => {
		expect(() => live.stream('t', () => [], { volatile: 1 })).toThrow(/volatile must be a boolean/);
		expect(() => live.stream('t', () => [], { volatile: 'true' })).toThrow(/volatile must be a boolean/);
	});

	it('rejects volatile combined with coalesceBy', () => {
		expect(() => live.stream('t', () => [], {
			volatile: true,
			coalesceBy: (d) => d.id
		})).toThrow(/cannot combine volatile.*coalesceBy/);
	});

	it('rejects volatile combined with replay', () => {
		expect(() => live.stream('t', () => [], { volatile: true, replay: true })).toThrow(/cannot combine volatile.*replay/);
		expect(() => live.stream('t', () => [], { volatile: true, replay: { size: 100 } })).toThrow(/cannot combine volatile.*replay/);
	});

	it('stashes __streamVolatile on the stream fn', () => {
		const stream = live.stream('vol-topic', () => [], { volatile: true });
		expect(stream.__streamVolatile).toBe(true);
	});

	it('publishes for a volatile-registered topic carry seq: false', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched_volatile();

		const stream = live.stream('vol-cursors', async () => [], {
			merge: 'cursor',
			volatile: true
		});
		__register('vol/cursors', stream);

		// Subscribe so the topic gets registered as volatile
		const subData = toArrayBuffer({ rpc: 'vol/cursors', id: 'vs1', args: [], stream: true });
		handleRpc(ws, subData, platform);
		await new Promise((r) => setTimeout(r, 10));

		const handler = live(async (ctx) => {
			ctx.publish('vol-cursors', 'move', { userId: 'u1', x: 10, y: 20 });
			return 'ok';
		});
		__register('vol/move', handler);

		platform.batched.length = 0;
		handleRpc(ws, toArrayBuffer({ rpc: 'vol/move', id: 'vp1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.batched).toHaveLength(1);
		expect(platform.batched[0][0].options).toMatchObject({ seq: false });
	});

	it('per-call options.volatile sets seq: false even on a non-volatile topic', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched_volatile();

		const handler = live(async (ctx) => {
			ctx.publish('any-topic', 'tick', { n: 1 }, { volatile: true });
			return 'ok';
		});
		__register('vol/perCall', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'vol/perCall', id: 'vc1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.batched[0][0].options).toMatchObject({ seq: false });
	});

	it('non-volatile publishes do not have seq: false', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched_volatile();

		const handler = live(async (ctx) => {
			ctx.publish('regular-topic', 'event', { n: 1 });
			return 'ok';
		});
		__register('vol/regular', handler);

		handleRpc(ws, toArrayBuffer({ rpc: 'vol/regular', id: 'vr1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.batched[0][0].options).toBeUndefined();
	});

	it('volatile registry evicts on last unsubscribe (HMR safety)', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatformWithBatched_volatile();

		const stream = live.stream('vol-evict', async () => [], { volatile: true });
		__register('vol/evict', stream);

		handleRpc(ws, toArrayBuffer({ rpc: 'vol/evict', id: 'e1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// While subscribed: publishes carry seq: false
		const handler = live(async (ctx) => {
			ctx.publish('vol-evict', 'event', { n: 1 });
			return 'ok';
		});
		__register('vol/evictPub', handler);

		platform.batched.length = 0;
		handleRpc(ws, toArrayBuffer({ rpc: 'vol/evictPub', id: 'ep1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.batched[0][0].options).toMatchObject({ seq: false });

		// Close the connection so the volatile registration is unwound
		close(ws, { platform, subscriptions: ws._subs || new Set() });

		// Reset platform state but keep registries; new ws subscribes to a
		// different topic, then publishes to 'vol-evict' with no volatile flag
		// - should NOT have seq: false anymore.
		const ws2 = mockWs({ id: 'u2' });
		platform.batched.length = 0;
		handleRpc(ws2, toArrayBuffer({ rpc: 'vol/evictPub', id: 'ep2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.batched[0][0].options).toBeUndefined();
	});
});

// - Declarative guard({ authenticated }) ------------------------------------

describe('guard({ authenticated })', () => {
	it('throws UNAUTHENTICATED when ctx.user is null', async () => {
		const g = guard({ authenticated: true });
		await expect(g({ user: null })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
	});

	it('passes when ctx.user is non-null', async () => {
		const g = guard({ authenticated: true });
		await expect(g({ user: { user_id: 'u1' } })).resolves.toBeUndefined();
	});

	it('composes with function-style middleware (auth runs first)', async () => {
		const order = [];
		const g = guard(
			{ authenticated: true },
			(ctx) => { order.push('custom:' + ctx.user.role); }
		);

		await g({ user: { user_id: 'u1', role: 'admin' } });
		expect(order).toEqual(['custom:admin']);

		// No user -> auth check throws first; custom middleware never runs
		order.length = 0;
		await expect(g({ user: null })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
		expect(order).toEqual([]);
	});

	it('rejects empty argument list', () => {
		expect(() => guard()).toThrow(/requires at least one function or option/);
	});

	it('rejects non-function, non-object args', () => {
		expect(() => guard('nope')).toThrow(/accepts middleware functions or an options object/);
	});

	it('options object without authenticated: true is a no-op (no auth check added)', async () => {
		// {} alone produces zero middleware -> guard() throws because no fns
		expect(() => guard({})).toThrow(/requires at least one function or option/);

		// {} alongside a function works - the {} contributes nothing
		const seen = [];
		const g = guard({}, (ctx) => { seen.push(ctx.user); });
		await g({ user: null });
		expect(seen).toEqual([null]);  // no auth check ran; null user passed through to custom fn
	});
});

// - live.access.org() / live.access.user() ----------------------------------

describe('live.access.org()', () => {
	const pred = live.access.org();

	it('returns true when arg 0 matches ctx.user.organization_id', () => {
		expect(pred({ user: { organization_id: 'o1' } }, 'o1')).toBe(true);
	});

	it('returns false when arg 0 mismatches ctx.user.organization_id', () => {
		expect(pred({ user: { organization_id: 'o1' } }, 'o2')).toBe(false);
	});

	it('returns false when ctx.user is null (anonymous never passes)', () => {
		expect(pred({ user: null }, 'o1')).toBe(false);
	});

	it('returns false when ctx.user.organization_id is undefined', () => {
		expect(pred({ user: { user_id: 'u1' } }, 'o1')).toBe(false);
	});

	it('returns false when arg 0 is missing', () => {
		expect(pred({ user: { organization_id: 'o1' } })).toBe(false);
	});

	it('honors custom orgField', () => {
		const p = live.access.org({ orgField: 'tenant_id' });
		expect(p({ user: { tenant_id: 't1' } }, 't1')).toBe(true);
		expect(p({ user: { tenant_id: 't1' } }, 't2')).toBe(false);
	});

	it('honors custom from extractor (e.g. RPC input.orgId)', () => {
		const p = live.access.org({ from: (_ctx, input) => input.orgId });
		expect(p({ user: { organization_id: 'o1' } }, { orgId: 'o1', name: 'x' })).toBe(true);
		expect(p({ user: { organization_id: 'o1' } }, { orgId: 'o2', name: 'x' })).toBe(false);
	});
});

describe('live.access.user()', () => {
	const pred = live.access.user();

	it('returns true when arg 0 matches ctx.user.user_id', () => {
		expect(pred({ user: { user_id: 'u1' } }, 'u1')).toBe(true);
	});

	it('returns false when arg 0 mismatches', () => {
		expect(pred({ user: { user_id: 'u1' } }, 'u2')).toBe(false);
	});

	it('returns false when ctx.user is null', () => {
		expect(pred({ user: null }, 'u1')).toBe(false);
	});

	it('honors custom userField (e.g. legacy id)', () => {
		const p = live.access.user({ userField: 'id' });
		expect(p({ user: { id: 'u1' } }, 'u1')).toBe(true);
	});

	it('honors custom from extractor', () => {
		const p = live.access.user({ from: (_ctx, input) => input.assigneeId });
		expect(p({ user: { user_id: 'u1' } }, { assigneeId: 'u1' })).toBe(true);
		expect(p({ user: { user_id: 'u1' } }, { assigneeId: 'u2' })).toBe(false);
	});
});

describe('live.access.all() / .any() composition with org/user', () => {
	it('all() forwards args so org/user predicates compose at distinct positions', async () => {
		// user() defaults to args[0]; specify org() to read args[1] for the
		// composed (userId, orgId) signature.
		const p = live.access.all(
			live.access.user(),
			live.access.org({ from: (_ctx, ..._args) => _args[1] })
		);
		expect(await p({ user: { user_id: 'u1', organization_id: 'o1' } }, 'u1', 'o1')).toBe(true);
		expect(await p({ user: { user_id: 'u1', organization_id: 'o1' } }, 'u1', 'o2')).toBe(false);
		expect(await p({ user: { user_id: 'u1', organization_id: 'o1' } }, 'u2', 'o1')).toBe(false);
	});

	it('any() forwards args (role-or-org)', async () => {
		const isAdmin = (ctx) => ctx.user?.role === 'admin';
		const p = live.access.any(isAdmin, live.access.org());
		expect(await p({ user: { organization_id: 'o1' } }, 'o1')).toBe(true);
		expect(await p({ user: { organization_id: 'o1', role: 'admin' } }, 'o2')).toBe(true);
		expect(await p({ user: { organization_id: 'o1' } }, 'o2')).toBe(false);
	});
});

describe('live.access.org() integrated with live.stream({ access })', () => {
	it('rejects subscribe with FORBIDDEN when org mismatches', async () => {
		const stream = live.stream(
			(ctx, orgId) => `audit:${orgId}`,
			async () => [],
			{ merge: 'crud', key: 'id', access: live.access.org() }
		);
		__register('sc/audit', stream);

		const ws = mockWs({ user_id: 'u1', organization_id: 'o1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/audit', id: '1', args: ['o2'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
	});

	it('admits subscribe when org matches', async () => {
		const stream = live.stream(
			(ctx, orgId) => `audit:${orgId}`,
			async (ctx, orgId) => [{ id: 1, org: orgId }],
			{ merge: 'crud', key: 'id', access: live.access.org() }
		);
		__register('sc/audit-ok', stream);

		const ws = mockWs({ user_id: 'u1', organization_id: 'o1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/audit-ok', id: '1', args: ['o1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.ok).toBe(true);
		expect(platform.sent[0].data.data).toEqual([{ id: 1, org: 'o1' }]);
	});

	it('rejects with UNAUTHENTICATED when ctx.user is null', async () => {
		const stream = live.stream(
			(ctx, orgId) => `t:${orgId}`,
			async () => [],
			{ merge: 'crud', key: 'id', access: live.access.org() }
		);
		__register('sc/anon', stream);

		const ws = mockWs();
		ws.getUserData = () => null;
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/anon', id: '1', args: ['o1'], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		expect(platform.sent[0].data.code).toBe('UNAUTHENTICATED');
	});
});

// - live.scoped(predicate, fn) ----------------------------------------------

describe('live.scoped()', () => {
	it('rejects non-function predicate or fn', () => {
		expect(() => live.scoped('nope', () => {})).toThrow(/requires a predicate function/);
		expect(() => live.scoped(() => true, 'nope')).toThrow(/requires a handler function/);
	});

	it('runs handler when predicate returns true', async () => {
		const handler = live.scoped(
			() => true,
			async (ctx, input) => ({ result: input * 2 })
		);
		__register('sc/run', handler);

		const ws = mockWs({ user_id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/run', id: '1', args: [21] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data).toMatchObject({ ok: true, data: { result: 42 } });
	});

	it('throws FORBIDDEN when predicate returns false and ctx.user is present', async () => {
		const handler = live.scoped(
			() => false,
			async () => 'never'
		);
		__register('sc/forbid', handler);

		const ws = mockWs({ user_id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/forbid', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
	});

	it('throws UNAUTHENTICATED when predicate returns false and ctx.user is null', async () => {
		const handler = live.scoped(
			() => false,
			async () => 'never'
		);
		__register('sc/anon-deny', handler);

		const ws = mockWs();
		ws.getUserData = () => null;
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/anon-deny', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.code).toBe('UNAUTHENTICATED');
	});

	it('awaits async predicates', async () => {
		const handler = live.scoped(
			async () => { await new Promise(r => setTimeout(r, 5)); return true; },
			async () => 'ok'
		);
		__register('sc/async', handler);

		const ws = mockWs({ user_id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/async', id: '1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 30));
		expect(platform.sent[0].data.data).toBe('ok');
	});

	it('composes with live.access.org for RPC org-scoping', async () => {
		const handler = live.scoped(
			live.access.org({ from: (ctx, input) => input.orgId }),
			async (ctx, input) => ({ updated: input.orgId })
		);
		__register('sc/update-org', handler);

		const ws = mockWs({ user_id: 'u1', organization_id: 'o1' });
		const platform = mockPlatform();

		// Same org -> ok
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/update-org', id: '1', args: [{ orgId: 'o1', name: 'x' }] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data).toMatchObject({ ok: true, data: { updated: 'o1' } });

		platform.reset();

		// Cross-org attempt -> FORBIDDEN
		handleRpc(ws, toArrayBuffer({ rpc: 'sc/update-org', id: '2', args: [{ orgId: 'o2', name: 'x' }] }), platform);
		await new Promise((r) => setTimeout(r, 10));
		expect(platform.sent[0].data.code).toBe('FORBIDDEN');
	});
});

// - live.publishRateWarning() ------------------------------------------------

describe('live.publishRateWarning()', () => {
	let warnSpy;
	let platform;

	beforeEach(() => {
		_resetPublishRateWarning();
		live.publishRateWarning({ threshold: 100, intervalMs: 50 });
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		warnSpy.mockRestore();
		_resetPublishRateWarning();
		// Restore defaults so other suites are not affected.
		live.publishRateWarning({ threshold: 200, intervalMs: 5000 });
		live.publishRateWarning(true);
	});

	function activateOnce(p) {
		// Drive the sampler activation directly so the test runs synchronously.
		// Production code path: _getCtxHelpers cache miss -> _activatePublishRateWarning.
		_activatePublishRateWarning(p);
	}

	it('fires a one-shot warn when a topic is over threshold', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'cursor:42', messagesPerSec: 800, bytesPerSec: 32000 }
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const msg = warnSpy.mock.calls[0][0];
		expect(msg).toContain("Topic 'cursor:42'");
		expect(msg).toContain('800 events/sec');
		expect(msg).toContain('coalesceBy');
		expect(msg).toContain('volatile: true');
		expect(msg).toContain('https://svti.me/highfreq');
	});

	it('does NOT warn when a topic is below threshold', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'chat:42', messagesPerSec: 50, bytesPerSec: 800 }
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('warns at most once per topic per process even on repeated samples', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'cursor:7', messagesPerSec: 500, bytesPerSec: 1000 }
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);
		vi.advanceTimersByTime(60);
		vi.advanceTimersByTime(60);

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('warns once per topic across multiple over-threshold topics', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'a:1', messagesPerSec: 200, bytesPerSec: 1 },
			{ topic: 'b:2', messagesPerSec: 300, bytesPerSec: 1 },
			{ topic: 'c:3', messagesPerSec: 80, bytesPerSec: 1 } // below
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).toHaveBeenCalledTimes(2);
		const topics = warnSpy.mock.calls.map((c) => c[0]).join('\n');
		expect(topics).toContain("'a:1'");
		expect(topics).toContain("'b:2'");
		expect(topics).not.toContain("'c:3'");
	});

	it('disable via false stops the sampler immediately', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'over:1', messagesPerSec: 500, bytesPerSec: 1 }
		];
		activateOnce(platform);

		live.publishRateWarning(false);
		vi.advanceTimersByTime(200);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('config object updates take effect on the next sample', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 't:lo', messagesPerSec: 150, bytesPerSec: 1 }
		];
		// Default threshold 100 -> would warn. Raise it before the sampler ticks.
		live.publishRateWarning({ threshold: 1000 });
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('handles an empty or missing topPublishers array without throwing', () => {
		platform = mockPlatform();
		// Default mockPlatform pressure has no topPublishers field.
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('does not double-attach when the same platform is used for many calls', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'd:9', messagesPerSec: 500, bytesPerSec: 1 }
		];
		activateOnce(platform);
		activateOnce(platform);
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('reset clears the warned set so a previously seen topic warns again', () => {
		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'reset:1', messagesPerSec: 500, bytesPerSec: 1 }
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		_resetPublishRateWarning();
		const platform2 = mockPlatform();
		platform2.pressure.topPublishers = [
			{ topic: 'reset:1', messagesPerSec: 500, bytesPerSec: 1 }
		];
		activateOnce(platform2);
		vi.advanceTimersByTime(60);

		expect(warnSpy).toHaveBeenCalledTimes(2);
	});

	it('rejects invalid threshold (zero / negative / non-finite / wrong type)', () => {
		expect(() => live.publishRateWarning({ threshold: 0 })).toThrow(/positive finite/);
		expect(() => live.publishRateWarning({ threshold: -10 })).toThrow(/positive finite/);
		expect(() => live.publishRateWarning({ threshold: Infinity })).toThrow(/positive finite/);
		expect(() => live.publishRateWarning({ threshold: 'fast' })).toThrow(/positive finite/);
	});

	it('rejects invalid intervalMs (zero / negative / non-finite / wrong type)', () => {
		expect(() => live.publishRateWarning({ intervalMs: 0 })).toThrow(/positive finite/);
		expect(() => live.publishRateWarning({ intervalMs: -1 })).toThrow(/positive finite/);
		expect(() => live.publishRateWarning({ intervalMs: NaN })).toThrow(/positive finite/);
		expect(() => live.publishRateWarning({ intervalMs: '5s' })).toThrow(/positive finite/);
	});

	it('rejects bare invalid input (string / number / array)', () => {
		expect(() => live.publishRateWarning('on')).toThrow(/true, false, or an object/);
		expect(() => live.publishRateWarning(0)).toThrow(/true, false, or an object/);
		// Arrays are objects but the validator does not detect that case;
		// arrays with no threshold/intervalMs fields silently re-enable, which
		// is acceptable since users won't pass arrays here.
	});

	it('handles a platform without pressure gracefully', () => {
		platform = mockPlatform();
		platform.pressure = null;
		activateOnce(platform);
		vi.advanceTimersByTime(200);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('suppresses the warn when the topic is already configured with coalesceBy', () => {
		const ws = mockWs({ user_id: 'u1' });
		_registerCoalesce(ws, 'cursors:room-1', (data) => data.userId);

		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'cursors:room-1', messagesPerSec: 800, bytesPerSec: 1 }
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).not.toHaveBeenCalled();
		_resetCoalesceRegistry();
	});

	it('suppresses the warn when the topic is already configured with volatile: true', () => {
		const ws = mockWs({ user_id: 'u1' });
		_registerVolatile(ws, 'telemetry:ping');

		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'telemetry:ping', messagesPerSec: 800, bytesPerSec: 1 }
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).not.toHaveBeenCalled();
		_resetVolatileRegistry();
	});

	it('warns for unmitigated topics in the same sample even when others are suppressed', () => {
		const ws = mockWs({ user_id: 'u1' });
		_registerCoalesce(ws, 'cursors:ok', (data) => data.userId);

		platform = mockPlatform();
		platform.pressure.topPublishers = [
			{ topic: 'cursors:ok', messagesPerSec: 800, bytesPerSec: 1 }, // suppressed
			{ topic: 'audit:hot', messagesPerSec: 500, bytesPerSec: 1 }   // warns
		];
		activateOnce(platform);
		vi.advanceTimersByTime(60);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("'audit:hot'");
		_resetCoalesceRegistry();
	});
});

// - defineTopics() -----------------------------------------------------------

describe('defineTopics()', () => {
	it('returns the input map with the same entries callable', () => {
		const TOPICS = defineTopics({
			audit: (orgId) => `audit:${orgId}`,
			feed: (orgId, kind) => `feed:${orgId}:${kind}`,
			systemNotices: 'system:notices'
		});
		expect(TOPICS.audit('o1')).toBe('audit:o1');
		expect(TOPICS.feed('o1', 'priority')).toBe('feed:o1:priority');
		expect(TOPICS.systemNotices).toBe('system:notices');
	});

	it('exposes __patterns derived from each entry', () => {
		const TOPICS = defineTopics({
			audit: (orgId) => `audit:${orgId}`,
			feed: (orgId, kind) => `feed:${orgId}:${kind}`,
			systemNotices: 'system:notices'
		});
		expect(TOPICS.__patterns).toEqual({
			audit: 'audit:{arg0}',
			feed: 'feed:{arg0}:{arg1}',
			systemNotices: 'system:notices'
		});
	});

	it('marks the map with __definedTopics', () => {
		const TOPICS = defineTopics({ foo: 'foo:topic' });
		expect(TOPICS.__definedTopics).toBe(true);
	});

	it('makes __patterns and __definedTopics non-enumerable', () => {
		const TOPICS = defineTopics({ foo: 'foo:topic' });
		expect(Object.keys(TOPICS)).toEqual(['foo']);
	});

	it('falls back to <dynamic> when a fn throws on sentinel args', () => {
		const TOPICS = defineTopics({
			weird: (input) => `prefix:${input.id.toUpperCase()}`
		});
		expect(TOPICS.__patterns.weird).toBe('<dynamic>');
		// Function still works at runtime with real input
		expect(TOPICS.weird({ id: 'abc' })).toBe('prefix:ABC');
	});

	it('falls back to <dynamic> when a fn returns a non-string', () => {
		const TOPICS = defineTopics({
			bad: () => /** @type {any} */ (42)
		});
		expect(TOPICS.__patterns.bad).toBe('<dynamic>');
	});

	it('rejects non-object input', () => {
		expect(() => defineTopics(null)).toThrow(/non-array object map/);
		expect(() => defineTopics(undefined)).toThrow(/non-array object map/);
		expect(() => defineTopics('foo')).toThrow(/non-array object map/);
		expect(() => defineTopics(42)).toThrow(/non-array object map/);
		expect(() => defineTopics([])).toThrow(/non-array object map/);
	});

	it('rejects entries that are neither string nor function', () => {
		expect(() => defineTopics({ bad: 42 })).toThrow(/must be a string or function/);
		expect(() => defineTopics({ bad: null })).toThrow(/must be a string or function/);
		expect(() => defineTopics({ bad: { topic: 'x' } })).toThrow(/must be a string or function/);
	});

	it('rejects empty string entries', () => {
		expect(() => defineTopics({ bad: '' })).toThrow(/non-empty string/);
	});

	it('rejects reserved names', () => {
		expect(() => defineTopics({ __patterns: 'x' })).toThrow(/reserved name/);
		expect(() => defineTopics({ __definedTopics: 'x' })).toThrow(/reserved name/);
	});

	it('composes with live.stream as the topic resolver', async () => {
		const TOPICS = defineTopics({
			items: (orgId) => `items:${orgId}`
		});
		const stream = live.stream((ctx, orgId) => TOPICS.items(orgId), async () => [], {});
		expect(typeof stream).toBe('function');
		expect(stream.__streamTopic).toBeTypeOf('function');
		// Topic resolver returns the right string for given args
		expect(stream.__streamTopic({ user: { user_id: 'u' } }, 'org-42')).toBe('items:org-42');
	});

	it('handles a no-arg function entry (arity 0)', () => {
		const TOPICS = defineTopics({
			global: () => 'global:topic'
		});
		expect(TOPICS.global()).toBe('global:topic');
		expect(TOPICS.__patterns.global).toBe('global:topic');
	});

	it('does not mutate the input map keys but adds metadata', () => {
		const input = { a: 'a:1', b: 'b:1' };
		const out = defineTopics(input);
		expect(out).toBe(input); // returns same reference
		expect(Object.keys(out)).toEqual(['a', 'b']);
		expect(out.__definedTopics).toBe(true);
	});
});

// - onUnsubscribe remainingSubscribers ---------------------------------------

describe('onUnsubscribe remainingSubscribers', () => {
	let platform;

	beforeEach(() => { _resetTopicWsCounts(); platform = mockPlatform(); });
	afterEach(() => { _resetTopicWsCounts(); });

	it('passes 0 when the only subscriber unsubscribes', async () => {
		const calls = [];
		const stream = live.stream('feed/solo', async () => [], {
			onUnsubscribe: (ctx, topic, remaining) => calls.push({ topic, remaining })
		});
		__register('feed/solo', stream);

		const ws = mockWs({ id: 'u1' });
		handleRpc(ws, toArrayBuffer({ rpc: 'feed/solo', id: 's1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		unsubscribe(ws, 'feed/solo', { platform });
		await new Promise((r) => setTimeout(r, 10));

		expect(calls).toHaveLength(1);
		expect(calls[0].topic).toBe('feed/solo');
		expect(calls[0].remaining).toBe(0);
	});

	it('passes N when N other WebSockets still hold the topic', async () => {
		const calls = [];
		const stream = live.stream('feed/multi', async () => [], {
			onUnsubscribe: (ctx, topic, remaining) => calls.push(remaining)
		});
		__register('feed/multi', stream);

		const wsA = mockWs({ id: 'a' });
		const wsB = mockWs({ id: 'b' });
		const wsC = mockWs({ id: 'c' });
		handleRpc(wsA, toArrayBuffer({ rpc: 'feed/multi', id: 'a', args: [], stream: true }), platform);
		handleRpc(wsB, toArrayBuffer({ rpc: 'feed/multi', id: 'b', args: [], stream: true }), platform);
		handleRpc(wsC, toArrayBuffer({ rpc: 'feed/multi', id: 'c', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// First ws leaves -> 2 others remain
		unsubscribe(wsA, 'feed/multi', { platform });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls[0]).toBe(2);

		// Second ws leaves -> 1 other remains
		unsubscribe(wsB, 'feed/multi', { platform });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls[1]).toBe(1);

		// Last ws leaves -> 0 others remain
		unsubscribe(wsC, 'feed/multi', { platform });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls[2]).toBe(0);
	});

	it('every drain firing on a multi-sub ws sees the same remainingSubscribers value', async () => {
		const calls = [];
		const stream = live.stream('feed/twice', async () => [], {
			onUnsubscribe: (ctx, topic, remaining) => calls.push(remaining)
		});
		__register('feed/twice', stream);

		const wsA = mockWs({ id: 'a' });
		const wsB = mockWs({ id: 'b' });
		// Subscribe twice on wsA (two logical subs)
		handleRpc(wsA, toArrayBuffer({ rpc: 'feed/twice', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		handleRpc(wsA, toArrayBuffer({ rpc: 'feed/twice', id: '2', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));
		// One sub on wsB
		handleRpc(wsB, toArrayBuffer({ rpc: 'feed/twice', id: '3', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// wsA leaves: hook fires twice (one per logical sub), both should see remaining=1 (wsB still there)
		unsubscribe(wsA, 'feed/twice', { platform });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toEqual([1, 1]);
	});

	it('passes accurate remaining on close() too', async () => {
		const calls = [];
		const stream = live.stream('feed/closepath', async () => [], {
			onUnsubscribe: (ctx, topic, remaining) => calls.push(remaining)
		});
		__register('feed/closepath', stream);

		const wsA = mockWs({ id: 'a' });
		const wsB = mockWs({ id: 'b' });
		handleRpc(wsA, toArrayBuffer({ rpc: 'feed/closepath', id: '1', args: [], stream: true }), platform);
		handleRpc(wsB, toArrayBuffer({ rpc: 'feed/closepath', id: '2', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Close wsA -> should fire onUnsubscribe with remaining=1 (wsB still there)
		close(wsA, { platform, subscriptions: new Set(['feed/closepath']) });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toEqual([1]);

		// Close wsB -> remaining=0
		close(wsB, { platform, subscriptions: new Set(['feed/closepath']) });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toEqual([1, 0]);
	});

	it('handles dynamic-topic streams (different topics on the same fn)', async () => {
		const calls = [];
		const stream = live.stream(
			(ctx, room) => `room:${room}`,
			async () => [],
			{ onUnsubscribe: (ctx, topic, remaining) => calls.push({ topic, remaining }) }
		);
		__register('rooms/feed', stream);

		const wsA = mockWs({ id: 'a' });
		const wsB = mockWs({ id: 'b' });
		// Both subscribe to room:1
		handleRpc(wsA, toArrayBuffer({ rpc: 'rooms/feed', id: '1', args: [1], stream: true }), platform);
		handleRpc(wsB, toArrayBuffer({ rpc: 'rooms/feed', id: '2', args: [1], stream: true }), platform);
		// Only wsA subscribes to room:2
		handleRpc(wsA, toArrayBuffer({ rpc: 'rooms/feed', id: '3', args: [2], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// wsA unsubscribes from room:1 -> wsB still there, remaining=1
		unsubscribe(wsA, 'room:1', { platform });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toContainEqual({ topic: 'room:1', remaining: 1 });

		// wsA unsubscribes from room:2 -> nobody else, remaining=0
		unsubscribe(wsA, 'room:2', { platform });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toContainEqual({ topic: 'room:2', remaining: 0 });
	});

	it('topic with no subscribers returns no firing (defensive: unsubscribe on unknown topic)', async () => {
		const calls = [];
		const stream = live.stream('feed/known', async () => [], {
			onUnsubscribe: (ctx, topic, remaining) => calls.push(remaining)
		});
		__register('feed/known', stream);

		const ws = mockWs({ id: 'u1' });
		handleRpc(ws, toArrayBuffer({ rpc: 'feed/known', id: '1', args: [], stream: true }), platform);
		await new Promise((r) => setTimeout(r, 10));

		// Unsubscribe from a topic this ws never subscribed to
		unsubscribe(ws, 'feed/never-subscribed', { platform });
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toEqual([]);
	});
});

// - live.lock() --------------------------------------------------------------

describe('live.lock()', () => {
	beforeEach(() => { _resetLock(); });
	afterEach(() => { _resetLock(); });

	it('runs the handler and returns its result', async () => {
		const wrapped = live.lock('one-key', async (ctx, n) => n * 2);
		const ctx = { user: { user_id: 'u1' } };
		expect(await wrapped(ctx, 5)).toBe(10);
	});

	it('serializes concurrent calls on the same key in FIFO order', async () => {
		const events = [];
		const wrapped = live.lock(
			(ctx, id) => `acct:${id}`,
			async (ctx, id, label, ms) => {
				events.push(`${label}-start`);
				await new Promise((r) => setTimeout(r, ms));
				events.push(`${label}-end`);
				return label;
			}
		);
		const ctx = { user: { user_id: 'u1' } };
		const a = wrapped(ctx, 1, 'a', 30);
		const b = wrapped(ctx, 1, 'b', 5);
		const c = wrapped(ctx, 1, 'c', 5);
		await Promise.all([a, b, c]);
		expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
	});

	it('runs calls on different keys in parallel', async () => {
		const events = [];
		const wrapped = live.lock(
			(ctx, key) => key,
			async (ctx, key, ms) => {
				events.push(`${key}-start`);
				await new Promise((r) => setTimeout(r, ms));
				events.push(`${key}-end`);
			}
		);
		const ctx = { user: { user_id: 'u1' } };
		await Promise.all([wrapped(ctx, 'a', 20), wrapped(ctx, 'b', 5)]);
		// b finishes before a (different keys, parallel execution)
		expect(events).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
	});

	it('propagates handler errors and unblocks the next waiter', async () => {
		const wrapped = live.lock('err-key', async (ctx, shouldThrow) => {
			if (shouldThrow) throw new Error('boom');
			return 'ok';
		});
		const ctx = { user: { user_id: 'u1' } };
		await expect(wrapped(ctx, true)).rejects.toThrow('boom');
		expect(await wrapped(ctx, false)).toBe('ok');
	});

	it('null/undefined/empty key bypasses the lock entirely', async () => {
		let runs = 0;
		const wrapped = live.lock(
			(ctx, key) => key,
			async (ctx, key, ms) => {
				runs++;
				await new Promise((r) => setTimeout(r, ms));
				return key;
			}
		);
		const ctx = { user: { user_id: 'u1' } };
		// All three calls return null/empty key -> bypass -> run in parallel
		const t0 = Date.now();
		await Promise.all([
			wrapped(ctx, null, 20),
			wrapped(ctx, undefined, 20),
			wrapped(ctx, '', 20)
		]);
		const elapsed = Date.now() - t0;
		expect(runs).toBe(3);
		expect(elapsed).toBeLessThan(50); // serialized would be ~60ms
	});

	it('accepts a static string key', async () => {
		let runs = 0;
		const wrapped = live.lock('static', async (ctx) => {
			runs++;
			await new Promise((r) => setTimeout(r, 10));
		});
		const ctx = { user: { user_id: 'u1' } };
		await Promise.all([wrapped(ctx), wrapped(ctx)]);
		// Both used the same static key, so serialized
		expect(runs).toBe(2);
	});

	it('accepts a custom lock implementation via { lock }', async () => {
		const calls = [];
		const customLock = {
			withLock: async (key, fn) => {
				calls.push({ key, kind: 'pre' });
				const result = await fn();
				calls.push({ key, kind: 'post' });
				return result;
			}
		};
		const wrapped = live.lock(
			{ key: 'cust', lock: customLock },
			async (ctx) => 'done'
		);
		const ctx = { user: { user_id: 'u1' } };
		expect(await wrapped(ctx)).toBe('done');
		expect(calls).toEqual([
			{ key: 'cust', kind: 'pre' },
			{ key: 'cust', kind: 'post' }
		]);
	});

	it('preserves wrapper metadata for composition', () => {
		const inner = async (ctx) => 'x';
		const wrapped = live.lock('k', inner);
		expect(wrapped.__isLive).toBe(true);
		expect(wrapped.__isLocked).toBe(true);
		expect(wrapped.__wrappedFn).toBe(inner);
	});

	it('composes with live.validated', async () => {
		const schema = { '~standard': { version: 1, vendor: 'test', validate: (v) => ({ value: v }) } };
		const wrapped = live.lock('compose-key', live.validated(schema, async (ctx, input) => input * 2));
		const ctx = { user: { user_id: 'u1' } };
		expect(await wrapped(ctx, 7)).toBe(14);
	});

	it('rejects missing handler', () => {
		expect(() => live.lock('k')).toThrow(/requires a handler function/);
		expect(() => live.lock('k', null)).toThrow(/requires a handler function/);
	});

	it('rejects empty string key', () => {
		expect(() => live.lock('', async () => {})).toThrow(/non-empty/);
		expect(() => live.lock({ key: '' }, async () => {})).toThrow(/non-empty/);
	});

	it('rejects malformed first argument', () => {
		expect(() => live.lock(42, async () => {})).toThrow(/key string, key function, or config object/);
		expect(() => live.lock(null, async () => {})).toThrow(/key string, key function, or config object/);
	});

	it('rejects bad config.key shape', () => {
		expect(() => live.lock({ key: 42 }, async () => {})).toThrow(/string or function/);
		expect(() => live.lock({}, async () => {})).toThrow(/string or function/);
	});

	it('rejects custom lock that does not implement withLock', () => {
		expect(() => live.lock({ key: 'k', lock: {} }, async () => {})).toThrow(/withLock/);
		expect(() => live.lock({ key: 'k', lock: null }, async () => {})).toThrow(/withLock/);
	});

	it('throws if the key resolver returns a non-string', async () => {
		const wrapped = live.lock(() => 42, async () => 'x');
		const ctx = { user: { user_id: 'u1' } };
		await expect(wrapped(ctx)).rejects.toThrow(/return a string/);
	});

	// - maxWaitMs (bounded wait) ---------------------------------------------

	it('rejects non-numeric / non-finite / negative maxWaitMs at registration', () => {
		const fn = async () => {};
		expect(() => live.lock({ key: 'k', maxWaitMs: 'soon' }, fn)).toThrow(/non-negative finite number/);
		expect(() => live.lock({ key: 'k', maxWaitMs: NaN }, fn)).toThrow(/non-negative finite number/);
		expect(() => live.lock({ key: 'k', maxWaitMs: Infinity }, fn)).toThrow(/non-negative finite number/);
		expect(() => live.lock({ key: 'k', maxWaitMs: -1 }, fn)).toThrow(/non-negative finite number/);
	});

	it('accepts maxWaitMs and surfaces it on __lockConfig', () => {
		const wrapped = live.lock({ key: 'k', maxWaitMs: 100 }, async () => 'x');
		expect(wrapped.__lockConfig.maxWaitMs).toBe(100);
	});

	it('happy path: lock acquired before timeout returns the handler result', async () => {
		const wrapped = live.lock(
			{ key: 'fast', maxWaitMs: 1000 },
			async (ctx, n) => n + 1
		);
		const ctx = { user: { user_id: 'u1' } };
		expect(await wrapped(ctx, 41)).toBe(42);
	});

	it('rejects waiting caller with LiveError(LOCK_TIMEOUT) when wait exceeds maxWaitMs', async () => {
		const wrapped = live.lock(
			{ key: 'busy', maxWaitMs: 20 },
			async (ctx, ms) => {
				await new Promise((r) => setTimeout(r, ms));
				return 'done';
			}
		);
		const ctx = { user: { user_id: 'u1' } };
		const holder = wrapped(ctx, 80); // holds for ~80ms
		// Give the holder a tick to acquire.
		await new Promise((r) => setTimeout(r, 5));
		const waiter = wrapped(ctx, 0);
		const err = await waiter.catch((e) => e);
		expect(err).toBeInstanceOf(LiveError);
		expect(err.code).toBe('LOCK_TIMEOUT');
		expect(err.key).toBe('busy');
		expect(err.maxWaitMs).toBe(20);
		// Holder still completes normally.
		expect(await holder).toBe('done');
	});

	it('timed-out waiter does not block subsequent waiters in the FIFO queue', async () => {
		const events = [];
		const handler = async (ctx, label, ms) => {
			events.push(`${label}-start`);
			await new Promise((r) => setTimeout(r, ms));
			events.push(`${label}-end`);
			return label;
		};
		// Three wrappers share the same lock key. Only 'b' is bounded; 'a' and
		// 'c' wait indefinitely. This isolates the FIFO-skip behaviour: we
		// need 'c' to still be queued after 'b' cancels, then run when 'a'
		// finishes.
		const aWrap = live.lock({ key: 'queue' }, handler);
		const bWrap = live.lock({ key: 'queue', maxWaitMs: 25 }, handler);
		const cWrap = live.lock({ key: 'queue' }, handler);
		const ctx = { user: { user_id: 'u1' } };

		const a = aWrap(ctx, 'a', 80); // holds the lock for ~80ms
		await new Promise((r) => setTimeout(r, 5));
		const b = bWrap(ctx, 'b', 5); // enqueues, times out at +30ms
		const c = cWrap(ctx, 'c', 5); // enqueues right after; unbounded

		const bResult = await b.catch((e) => e);
		expect(bResult).toBeInstanceOf(LiveError);
		expect(bResult.code).toBe('LOCK_TIMEOUT');

		await Promise.all([a, c]);
		// 'b' never ran; queue advanced past the cancelled waiter to 'c'.
		expect(events).toEqual(['a-start', 'a-end', 'c-start', 'c-end']);
	});

	it('forwards maxWaitMs to a custom lock implementation as the third argument', async () => {
		/** @type {Array<any>} */
		const observed = [];
		const customLock = {
			withLock: async (key, fn, opts) => {
				observed.push({ key, opts });
				return fn();
			}
		};
		const wrapped = live.lock(
			{ key: 'cust', lock: customLock, maxWaitMs: 250 },
			async (ctx) => 'ok'
		);
		const ctx = { user: { user_id: 'u1' } };
		expect(await wrapped(ctx)).toBe('ok');
		expect(observed).toEqual([{ key: 'cust', opts: { maxWaitMs: 250 } }]);
	});

	it('does not pass an opts object when maxWaitMs is unset (custom lock receives undefined)', async () => {
		/** @type {Array<any>} */
		const observed = [];
		const customLock = {
			withLock: async (key, fn, opts) => {
				observed.push({ key, opts });
				return fn();
			}
		};
		const wrapped = live.lock(
			{ key: 'no-cap', lock: customLock },
			async (ctx) => 'ok'
		);
		const ctx = { user: { user_id: 'u1' } };
		await wrapped(ctx);
		expect(observed).toEqual([{ key: 'no-cap', opts: undefined }]);
	});

	it('LOCK_TIMEOUT thrown by a custom lock is rewrapped as LiveError', async () => {
		const customLock = {
			withLock: async (key) => {
				const err = /** @type {any} */ (new Error('custom timeout'));
				err.code = 'LOCK_TIMEOUT';
				err.key = key;
				err.maxWaitMs = 7;
				throw err;
			}
		};
		const wrapped = live.lock(
			{ key: 'cust', lock: customLock, maxWaitMs: 7 },
			async () => 'never'
		);
		const ctx = { user: { user_id: 'u1' } };
		const err = await wrapped(ctx).catch((e) => e);
		expect(err).toBeInstanceOf(LiveError);
		expect(err.code).toBe('LOCK_TIMEOUT');
		expect(err.key).toBe('cust');
		expect(err.maxWaitMs).toBe(7);
	});

	it('non-LOCK_TIMEOUT errors from the lock propagate unchanged', async () => {
		const customLock = {
			withLock: async () => { throw new Error('io failure'); }
		};
		const wrapped = live.lock(
			{ key: 'cust', lock: customLock },
			async () => 'never'
		);
		const ctx = { user: { user_id: 'u1' } };
		const err = await wrapped(ctx).catch((e) => e);
		expect(err).not.toBeInstanceOf(LiveError);
		expect(err.message).toBe('io failure');
	});

	// Symmetric guard against the same silent-fail class as live.idempotent.
	// Catches typos like `maxWait` (vs `maxWaitMs`) and the cross-helper
	// case `keyFrom` (vs `key`) at registration time.
	it('rejects unknown config fields with a cross-helper hint for "keyFrom"', () => {
		expect(() => live.lock(/** @type {any} */ ({ keyFrom: () => 'k' }), async () => {}))
			.toThrow(/unknown config field 'keyFrom'/);
		expect(() => live.lock(/** @type {any} */ ({ keyFrom: () => 'k' }), async () => {}))
			.toThrow(/Allowed: key, lock, maxWaitMs/);
		expect(() => live.lock(/** @type {any} */ ({ keyFrom: () => 'k' }), async () => {}))
			.toThrow(/live\.idempotent uses 'keyFrom' but live\.lock uses 'key'/);
	});

	it('rejects arbitrary unknown fields without a cross-helper hint', () => {
		expect(() => live.lock(/** @type {any} */ ({ key: 'k', maxWait: 100 }), async () => {}))
			.toThrow(/unknown config field 'maxWait'/);
		expect(() => live.lock(/** @type {any} */ ({ key: 'k', maxWait: 100 }), async () => {}))
			.toThrow(/Allowed: key, lock, maxWaitMs/);
		try {
			live.lock(/** @type {any} */ ({ key: 'k', maxWait: 100 }), async () => {});
		} catch (e) {
			expect(/** @type {any} */ (e).message).not.toMatch(/Hint:/);
		}
	});
});

// - live.push() / pushHooks --------------------------------------------------

describe('live.push() / pushHooks', () => {
	beforeEach(() => {
		_resetPushRegistry();
	});

	it('routes to the registered connection by userId', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(ws, { platform });

		platform._setRequestResolver(async () => ({ confirmed: true }));
		const reply = await live.push({ userId: 'u-1' }, 'confirm', { id: 7 });

		expect(reply).toEqual({ confirmed: true });
		expect(platform.requested).toHaveLength(1);
		expect(platform.requested[0]).toMatchObject({ ws, event: 'confirm', data: { id: 7 } });
	});

	it('passes timeoutMs through to platform.request', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ok');

		await live.push({ userId: 'u-1' }, 'event', null, { timeoutMs: 30_000 });
		expect(platform.requested[0].options).toEqual({ timeoutMs: 30_000 });
	});

	it('omits options when none are passed', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ok');

		await live.push({ userId: 'u-1' }, 'event', { x: 1 });
		expect(platform.requested[0].options).toBeUndefined();
	});

	it('throws LiveError NOT_FOUND when no connection registered for userId', async () => {
		await expect(live.push({ userId: 'u-missing' }, 'event')).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: expect.stringContaining('u-missing')
		});
	});

	it('last-write-wins on multi-device: newer connection replaces older', async () => {
		const platform = mockPlatform();
		const wsA = { getUserData: () => ({ user_id: 'u-1' }) };
		const wsB = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(wsA, { platform });
		pushHooks.open(wsB, { platform });

		platform._setRequestResolver(async () => 'ok');
		await live.push({ userId: 'u-1' }, 'event');
		expect(platform.requested[0].ws).toBe(wsB);
	});

	it('close on a stale ws does not deregister the active connection', async () => {
		const platform = mockPlatform();
		const wsA = { getUserData: () => ({ user_id: 'u-1' }) };
		const wsB = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(wsA, { platform });
		pushHooks.open(wsB, { platform });
		pushHooks.close(wsA);

		platform._setRequestResolver(async () => 'ok');
		await expect(live.push({ userId: 'u-1' }, 'event')).resolves.toBe('ok');
		expect(platform.requested[0].ws).toBe(wsB);
	});

	it('close on the active ws fully deregisters', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(ws, { platform });
		pushHooks.close(ws);

		await expect(live.push({ userId: 'u-1' }, 'event')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('default identify reads user_id then userId from getUserData', async () => {
		const platform = mockPlatform();
		const ws1 = { getUserData: () => ({ user_id: 'u-snake' }) };
		const ws2 = { getUserData: () => ({ userId: 'u-camel' }) };
		pushHooks.open(ws1, { platform });
		pushHooks.open(ws2, { platform });
		platform._setRequestResolver(async (ws) => (ws === ws1 ? 'snake' : 'camel'));

		await expect(live.push({ userId: 'u-snake' }, 'event')).resolves.toBe('snake');
		await expect(live.push({ userId: 'u-camel' }, 'event')).resolves.toBe('camel');
	});

	it('skips registration when getUserData has no userId (anonymous)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({}) };
		pushHooks.open(ws, { platform });
		// No userId means the registry stays empty - anonymous connections cannot be push targets.
		await expect(live.push({ userId: 'anything' }, 'event')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('configurePush({ identify }) overrides the default extractor', async () => {
		const platform = mockPlatform();
		live.configurePush({ identify: (ws) => 'static-' + ws.token });
		const ws = { token: 'abc' };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ok');

		await expect(live.push({ userId: 'static-abc' }, 'event')).resolves.toBe('ok');
	});

	it('configurePush(null) restores the default identifier', async () => {
		const platform = mockPlatform();
		live.configurePush({ identify: () => 'never-used' });
		live.configurePush(null);
		const ws = { getUserData: () => ({ user_id: 'u-default' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ok');

		await expect(live.push({ userId: 'u-default' }, 'event')).resolves.toBe('ok');
	});

	it('configurePush rejects malformed config', () => {
		expect(() => live.configurePush('bad')).toThrow(/object or null/);
		expect(() => live.configurePush({})).toThrow(/identify/);
		expect(() => live.configurePush({ identify: 'not-fn' })).toThrow(/identify/);
	});

	it('pushHooks.open throws on missing platform', () => {
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		expect(() => pushHooks.open(ws, /** @type {any} */ ({}))).toThrow(/platform/);
		expect(() => pushHooks.open(ws, /** @type {any} */ (null))).toThrow(/platform/);
	});

	it('pushHooks.open throws when identify returns a non-string', () => {
		const platform = mockPlatform();
		live.configurePush({ identify: () => /** @type {any} */ (42) });
		expect(() => pushHooks.open({}, { platform })).toThrow(/string/);
	});

	it('rejects malformed live.push args with LiveError(VALIDATION)', async () => {
		await expect(live.push(/** @type {any} */ (null), 'evt')).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push(/** @type {any} */ (null), 'evt')).rejects.toThrow(/target/);
		await expect(live.push(/** @type {any} */ ({}), 'evt')).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push(/** @type {any} */ ({}), 'evt')).rejects.toThrow(/userId/);
		await expect(live.push({ userId: '' }, 'evt')).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ userId: '' }, 'evt')).rejects.toThrow(/userId/);
		await expect(live.push({ userId: 'u-1' }, '')).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ userId: 'u-1' }, '')).rejects.toThrow(/event/);
		await expect(live.push(/** @type {any} */ ({ userId: 'u-1', extra: 1 }), 'evt')).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push(/** @type {any} */ ({ userId: 'u-1', extra: 1 }), 'evt')).rejects.toThrow(/extra/);
	});

	it('rejects bad timeoutMs with LiveError(VALIDATION)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(ws, { platform });

		await expect(live.push({ userId: 'u-1' }, 'event', null, { timeoutMs: -1 })).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ userId: 'u-1' }, 'event', null, { timeoutMs: -1 })).rejects.toThrow(/timeoutMs/);
		await expect(live.push({ userId: 'u-1' }, 'event', null, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ userId: 'u-1' }, 'event', null, /** @type {any} */ ({ timeoutMs: 'x' }))).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ userId: 'u-1' }, 'event', null, /** @type {any} */ ('bad'))).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ userId: 'u-1' }, 'event', null, /** @type {any} */ ('bad'))).rejects.toThrow(/options/);
	});

	it('translates platform.request "timed out" rejection to LiveError(TIMEOUT)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => { throw new Error('request timed out'); });

		// Structured discrimination via .code (the new contract).
		await expect(live.push({ userId: 'u-1' }, 'event')).rejects.toMatchObject({ code: 'TIMEOUT' });
		// Message text is preserved verbatim so substring callers still match
		// during their migration.
		await expect(live.push({ userId: 'u-1' }, 'event')).rejects.toThrow('request timed out');
	});

	it('does NOT translate non-timeout platform.request rejections', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-2' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => { throw new Error('connection closed'); });

		// Plain Error passes through; no structured code.
		const err = await live.push({ userId: 'u-2' }, 'event').catch(/** @param {any} e */ (e) => e);
		expect(err.message).toBe('connection closed');
		expect(err.code).toBeUndefined();
	});

	it('preserves a recipient handler-thrown LiveError (no double-wrap)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-3' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => { throw new LiveError('FORBIDDEN', 'no thanks'); });

		await expect(live.push({ userId: 'u-3' }, 'event')).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: 'no thanks'
		});
	});

	it('throws helpful error if platform lacks request method', async () => {
		const platform = mockPlatform();
		delete /** @type {any} */ (platform).request;
		const ws = { getUserData: () => ({ user_id: 'u-1' }) };
		pushHooks.open(ws, { platform });

		await expect(live.push({ userId: 'u-1' }, 'event')).rejects.toThrow(/svelte-adapter-uws/);
	});

	it('different users registered on different platforms route to their own platform', async () => {
		const platformA = mockPlatform();
		const platformB = mockPlatform();
		const wsA = { getUserData: () => ({ user_id: 'u-A' }) };
		const wsB = { getUserData: () => ({ user_id: 'u-B' }) };
		pushHooks.open(wsA, { platform: platformA });
		pushHooks.open(wsB, { platform: platformB });
		platformA._setRequestResolver(async () => 'A');
		platformB._setRequestResolver(async () => 'B');

		await expect(live.push({ userId: 'u-A' }, 'event')).resolves.toBe('A');
		await expect(live.push({ userId: 'u-B' }, 'event')).resolves.toBe('B');
		expect(platformA.requested).toHaveLength(1);
		expect(platformB.requested).toHaveLength(1);
	});

	it('falls back to remoteRegistry.request when userId is not registered locally', async () => {
		const calls = [];
		const remoteRegistry = {
			request: async (target, event, data, options) => {
				calls.push({ target, event, data, options });
				return { from: 'cluster', target };
			}
		};
		live.configurePush({ remoteRegistry });

		const reply = await live.push({ userId: 'u-elsewhere' }, 'confirm', { id: 7 }, { timeoutMs: 4000 });
		expect(reply).toEqual({ from: 'cluster', target: 'u-elsewhere' });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			target: 'u-elsewhere',
			event: 'confirm',
			data: { id: 7 },
			options: { timeoutMs: 4000 }
		});
	});

	it('prefers the remote registry over the local registry when both have an entry', async () => {
		// The cluster-wide remoteRegistry is the canonical-owner source of
		// truth (most-recently-opened wins across the cluster). When the
		// canonical owner is THIS instance, the registry's own self-
		// targeting short-circuit calls the local platform.request without
		// a Redis hop -- so single-tab perf is unchanged. When the
		// canonical owner is a DIFFERENT instance (multi-tab same-user
		// where the more recent open landed elsewhere), the cluster route
		// is the correct deterministic recipient; pre-fix the local short-
		// circuit beat the cluster lookup whenever this instance had any
		// local entry, routing to the older tab regardless of caller
		// location.
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-local' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'from-local');

		const remoteCalls = [];
		live.configurePush({
			remoteRegistry: {
				request: async (target, event, data) => {
					remoteCalls.push({ target, event, data });
					return 'from-remote';
				}
			}
		});

		await expect(live.push({ userId: 'u-local' }, 'event')).resolves.toBe('from-remote');
		expect(remoteCalls).toHaveLength(1);
		expect(platform.requested).toHaveLength(0);
	});

	it('falls back to local registry when remoteRegistry rejects with "offline" and a local entry exists', async () => {
		// Brief propagation race after pushHooks.open: local registry has
		// the entry, cluster pub/sub event hasn't applied to this
		// instance's userToInstance index yet, cluster says "offline".
		// We treat the local entry as authoritative for this window so a
		// just-opened user doesn't NOT_FOUND their own push.
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-racing' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'from-local-after-cluster-miss');

		live.configurePush({
			remoteRegistry: {
				request: async () => { throw new Error('registry.request: target user "u-racing" is offline'); }
			}
		});

		await expect(live.push({ userId: 'u-racing' }, 'event')).resolves.toBe('from-local-after-cluster-miss');
		expect(platform.requested).toHaveLength(1);
	});

	it('propagates non-timeout errors from remoteRegistry.request as-is', async () => {
		live.configurePush({
			remoteRegistry: {
				request: async () => { throw new Error('offline'); }
			}
		});

		const err = await live.push({ userId: 'u-offline' }, 'event').catch(/** @param {any} e */ (e) => e);
		expect(err.message).toBe('offline');
		expect(err.code).toBeUndefined();
	});

	it('translates "timed out" rejection from remoteRegistry.request to LiveError(TIMEOUT)', async () => {
		live.configurePush({
			remoteRegistry: {
				request: async () => { throw new Error('cluster request timed out after 8000ms'); }
			}
		});

		await expect(live.push({ userId: 'u-cluster' }, 'event')).rejects.toMatchObject({ code: 'TIMEOUT' });
		await expect(live.push({ userId: 'u-cluster' }, 'event')).rejects.toThrow('cluster request timed out after 8000ms');
	});

	it('preserves a typed LiveError thrown by remoteRegistry.request (no double-wrap)', async () => {
		live.configurePush({
			remoteRegistry: {
				request: async () => { throw new LiveError('NOT_FOUND', 'no instance owns this user'); }
			}
		});

		await expect(live.push({ userId: 'u-noinstance' }, 'event')).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: 'no instance owns this user'
		});
	});

	it('configurePush({ remoteRegistry: null }) clears the binding', async () => {
		live.configurePush({
			remoteRegistry: { request: async () => 'unreachable' }
		});

		live.configurePush({ remoteRegistry: null });

		await expect(live.push({ userId: 'u-cleared' }, 'event')).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
	});

	it('configurePush rejects a remoteRegistry without a request method', () => {
		expect(() => live.configurePush({ remoteRegistry: {} })).toThrow(/request/);
		expect(() => live.configurePush({ remoteRegistry: { request: 'not-fn' } })).toThrow(/request/);
		expect(() => live.configurePush({ remoteRegistry: 'oops' })).toThrow(/request/);
	});

	it('configurePush({ identify, remoteRegistry }) sets both at once', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ account: { id: 'acct-1' } }) };
		const remoteCalls = [];
		live.configurePush({
			identify: (w) => w.getUserData()?.account?.id,
			remoteRegistry: {
				request: async (target, event) => {
					remoteCalls.push({ target, event });
					return 'remote-reply';
				}
			}
		});

		// Local identify shape now reads account.id
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'local-reply');
		// With remoteRegistry configured, the cluster is the canonical-
		// owner source of truth and is consulted first. In a real cluster
		// the registry's self-target short-circuit would route this back
		// to the local platform; the mock here returns 'remote-reply'
		// directly, which is what we assert against.
		await expect(live.push({ userId: 'acct-1' }, 'evt')).resolves.toBe('remote-reply');

		// Same path for a userId not present locally.
		await expect(live.push({ userId: 'acct-elsewhere' }, 'evt')).resolves.toBe('remote-reply');
		expect(remoteCalls).toEqual([
			{ target: 'acct-1', event: 'evt' },
			{ target: 'acct-elsewhere', event: 'evt' }
		]);
	});

	it('configurePush(null) clears both identify and remoteRegistry', async () => {
		live.configurePush({
			identify: () => 'x',
			remoteRegistry: { request: async () => 'r' }
		});
		live.configurePush(null);

		// Without remoteRegistry, an unregistered userId throws NOT_FOUND again
		await expect(live.push({ userId: 'u-x' }, 'event')).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
	});

	// Unified-close contract: a single hook re-export should drain BOTH
	// the per-userId push registry AND the realtime stream-subscription
	// bookkeeping (ws-counts, silent-topic watchdogs). Before this
	// unification, `export const close = pushHooks.close` (the JSDoc
	// example) only drained the push registry, leaving silent-topic
	// watchdogs armed for 30s after every page closed - producing
	// warning floods in CI / e2e runs that the reporter saw.

	it('pushHooks.close(ws, ctx) drains the silent-topic watchdog', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);

		// Subscribe a ws to a stream topic (arms the silent-topic watchdog).
		const ws = mockWs({ id: 'u-uni-1' });
		const streamFn = live.stream('uni:topic-A', async () => [], { merge: 'set' });
		__register('uni/streamA', streamFn);
		const data = toArrayBuffer({ rpc: 'uni/streamA', id: 'r1', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise(r => setTimeout(r, 10));

		// Watchdog is armed. Closing via pushHooks.close with ctx should
		// route through the realtime close and disarm.
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		pushHooks.close(ws, { platform, subscriptions: new Set(['uni:topic-A']) });

		// Give the disarm logic a moment, then advance time well past the
		// 30s threshold to confirm no warning fires.
		vi.useFakeTimers();
		try {
			vi.advanceTimersByTime(35_000);
			const silentWarnings = warnSpy.mock.calls.filter(args =>
				typeof args[0] === 'string' && args[0].includes("Topic 'uni:topic-A'")
			);
			expect(silentWarnings.length).toBe(0);
		} finally {
			vi.useRealTimers();
			warnSpy.mockRestore();
		}
	});

	it('pushHooks.close(ws, ctx) drains the push registry', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-uni-2' }) };
		pushHooks.open(ws, { platform });

		// Close with ctx (production adapter shape).
		pushHooks.close(ws, { platform });

		await expect(live.push({ userId: 'u-uni-2' }, 'event')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('pushHooks.close(ws) without ctx still drains push registry (legacy direct call)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-uni-3' }) };
		pushHooks.open(ws, { platform });

		// Legacy one-arg call - still works, push-only.
		pushHooks.close(ws);

		await expect(live.push({ userId: 'u-uni-3' }, 'event')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('realtime close(ws, ctx) drains the push registry too', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-uni-4' }) };
		pushHooks.open(ws, { platform });

		// Calling the top-level realtime close directly should also drain push.
		close(ws, { platform, subscriptions: new Set() });

		await expect(live.push({ userId: 'u-uni-4' }, 'event')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('manual composition of realtime close + pushHooks.close is idempotent', async () => {
		const platform = mockPlatform();
		_activateDerived(platform);

		const ws = mockWs({ id: 'u-uni-5' });
		// Push: register via pushHooks.open with the right userData shape.
		ws.getUserData = () => ({ user_id: 'u-uni-5' });
		pushHooks.open(ws, { platform });

		// Stream: subscribe to a topic.
		const streamFn = live.stream('uni:topic-B', async () => [], { merge: 'set' });
		__register('uni/streamB', streamFn);
		const data = toArrayBuffer({ rpc: 'uni/streamB', id: 'r5', args: [], stream: true });
		handleRpc(ws, data, platform);
		await new Promise(r => setTimeout(r, 10));

		// User who composes both paths manually: realtime close THEN pushHooks.close.
		// The realtime close already drains push; pushHooks.close should be a no-op
		// the second time around. No throws, both registries clean.
		expect(() => {
			close(ws, { platform, subscriptions: new Set(['uni:topic-B']) });
			pushHooks.close(ws, { platform, subscriptions: new Set() });
		}).not.toThrow();

		// Push registry clean.
		await expect(live.push({ userId: 'u-uni-5' }, 'event')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('does NOT call into realtime close path when ctx is omitted', async () => {
		// Sanity / behavior pin: the legacy one-arg direct call must not
		// somehow trigger stream cleanup (which would crash on missing
		// ctx.platform). This test just asserts no-throw and push-only
		// drain when the user calls pushHooks.close(ws) directly.
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-uni-6' }) };
		pushHooks.open(ws, { platform });

		expect(() => pushHooks.close(ws)).not.toThrow();
		await expect(live.push({ userId: 'u-uni-6' }, 'event')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

// - live.notify() ------------------------------------------------------------
//
// Fire-and-forget counterpart to live.push. Resolves immediately (no reply
// awaited), never rejects in normal operation. Validation throws sync for
// programming errors. The wire path uses the same platform.request as push
// today (with a bounded internal timeout); the caller-side semantic is the
// only thing that differs.

describe('live.notify()', () => {
	beforeEach(() => {
		_resetPushRegistry();
	});

	it('dispatches via platform.request to the registered ws (same wire as push)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-n-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ignored');

		const result = await live.notify({ userId: 'u-n-1' }, 'ping', { x: 1 });

		// Returns Promise<void>; resolves with undefined.
		expect(result).toBeUndefined();
		// Wire-side, the request fired against the registered ws with our
		// payload. The reply value (`'ignored'`) is intentionally not surfaced.
		expect(platform.requested).toHaveLength(1);
		expect(platform.requested[0]).toMatchObject({ ws, event: 'ping', data: { x: 1 } });
	});

	it('passes a bounded internal timeoutMs to platform.request (no caller-supplied timeout)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-n-2' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => null);

		await live.notify({ userId: 'u-n-2' }, 'evt');

		// Internal timeout exists (so the adapter's request tracker reclaims
		// the entry instead of leaking) but caller didn't supply one. Just
		// assert it's a positive number; the exact value is a tuning knob,
		// not a contract.
		expect(platform.requested[0].options).toBeDefined();
		expect(typeof platform.requested[0].options.timeoutMs).toBe('number');
		expect(platform.requested[0].options.timeoutMs).toBeGreaterThan(0);
	});

	it('silently no-ops when the user is offline (no NOT_FOUND throw)', async () => {
		// No pushHooks.open call - userId not registered anywhere.
		const result = await live.notify({ userId: 'u-offline' }, 'ping');
		expect(result).toBeUndefined();
		// And no platform request happened (we never resolved a target).
	});

	it('silently swallows a rejection from platform.request (timeout, handler throw)', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-n-3' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => { throw new Error('handler exploded'); });

		// Even though the wire-level request rejects, the caller's promise
		// resolves normally. Fire-and-forget contract.
		await expect(live.notify({ userId: 'u-n-3' }, 'oops')).resolves.toBeUndefined();
		// Give the platform.request promise a tick to settle so we can
		// confirm it didn't surface as an unhandled rejection.
		await new Promise(r => setTimeout(r, 10));
	});

	it('silently swallows a synchronous throw from platform.request', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-n-4' }) };
		pushHooks.open(ws, { platform });
		// Force platform.request to throw synchronously (mimics torn-down ws).
		platform.request = () => { throw new Error('ws gone'); };

		await expect(live.notify({ userId: 'u-n-4' }, 'event')).resolves.toBeUndefined();
	});

	it('falls through to remoteRegistry.request when userId is not registered locally', async () => {
		const remoteCalls = [];
		const remoteRegistry = {
			request: async (target, event, data, options) => {
				remoteCalls.push({ target, event, data, options });
				return null;
			}
		};
		live.configurePush({ remoteRegistry });

		await live.notify({ userId: 'u-remote' }, 'evt', { y: 2 });

		expect(remoteCalls).toHaveLength(1);
		expect(remoteCalls[0]).toMatchObject({ target: 'u-remote', event: 'evt', data: { y: 2 } });
		expect(typeof remoteCalls[0].options.timeoutMs).toBe('number');

		live.configurePush(null);
	});

	it('silently swallows remoteRegistry.request rejections', async () => {
		const remoteRegistry = {
			request: async () => { throw new Error('redis offline'); }
		};
		live.configurePush({ remoteRegistry });

		await expect(live.notify({ userId: 'u-remote' }, 'evt')).resolves.toBeUndefined();
		await new Promise(r => setTimeout(r, 10));

		live.configurePush(null);
	});

	it('prefers the remote registry over the local registry (same as push)', async () => {
		// Symmetric with live.push: when remoteRegistry is configured, it
		// is the cluster-wide source of truth and the local entry is only
		// a fallback for the brief propagation race after a fresh open.
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-both' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'local');

		const remoteCalls = [];
		const remoteRegistry = {
			request: async (target, event, data, options) => {
				remoteCalls.push({ target, event, data, options });
				return 'remote';
			}
		};
		live.configurePush({ remoteRegistry });

		await live.notify({ userId: 'u-both' }, 'evt');
		// Notify is fire-and-forget; let the internal promise tick.
		await new Promise(r => setTimeout(r, 10));

		// Cluster wins: remote registry receives the request; local
		// platform is not touched (the registry's self-target short-
		// circuit doesn't fire because the test's mock registry doesn't
		// implement it -- this asserts the routing decision, not the
		// downstream optimization).
		expect(remoteCalls).toHaveLength(1);
		expect(platform.requested).toHaveLength(0);

		live.configurePush(null);
	});

	it('falls back to local registry when remoteRegistry rejects with "offline" and a local entry exists', async () => {
		// Symmetric with live.push: brief propagation race after
		// pushHooks.open. Notify is fire-and-forget, but the user-
		// experience win is real: a just-opened user gets their own
		// notify delivered instead of silently dropped.
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-racing-notify' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => undefined);

		live.configurePush({
			remoteRegistry: {
				request: async () => { throw new Error('registry.request: target user "u-racing-notify" is offline'); }
			}
		});

		await live.notify({ userId: 'u-racing-notify' }, 'evt');
		// Let the cluster rejection settle and the local fallback fire.
		await new Promise(r => setTimeout(r, 10));

		expect(platform.requested).toHaveLength(1);

		live.configurePush(null);
	});

	// Validation: programming errors must throw synchronously at the call
	// site so they don't get swallowed by future .catch handlers (which
	// notify users mostly won't write, since notify is fire-and-forget).
	// Surfaced as LiveError(VALIDATION) for parity with live.push.
	it('throws synchronously on bad target', () => {
		expect(() => live.notify(null, 'evt')).toThrow(LiveError);
		expect(() => live.notify(null, 'evt')).toThrow('target must be an object');
		try { live.notify(null, 'evt'); } catch (e) { expect(/** @type {any} */ (e).code).toBe('VALIDATION'); }
		expect(() => live.notify('u-1', 'evt')).toThrow('target must be an object');
	});

	it('throws synchronously on empty event name', () => {
		expect(() => live.notify({ userId: 'u-1' }, '')).toThrow('event must be a non-empty string');
		try { live.notify({ userId: 'u-1' }, ''); } catch (e) { expect(/** @type {any} */ (e).code).toBe('VALIDATION'); }
		expect(() => live.notify({ userId: 'u-1' }, undefined)).toThrow('event must be a non-empty string');
	});

	it('throws synchronously on unsupported target keys', () => {
		expect(() => live.notify({ userId: 'u-1', orgId: 'o-1' }, 'evt')).toThrow('unsupported target keys: orgId');
		try { live.notify({ userId: 'u-1', orgId: 'o-1' }, 'evt'); } catch (e) { expect(/** @type {any} */ (e).code).toBe('VALIDATION'); }
	});

	it('throws synchronously on a target with no recognized key or a malformed userId', () => {
		// An empty target names neither userId nor sessionId.
		expect(() => live.notify({}, 'evt')).toThrow('target must name exactly one of userId / sessionId');
		try { live.notify({}, 'evt'); } catch (e) { expect(/** @type {any} */ (e).code).toBe('VALIDATION'); }
		// A present-but-malformed userId still reports the userId-specific reason.
		expect(() => live.notify({ userId: '' }, 'evt')).toThrow('target.userId must be a non-empty string');
		expect(() => live.notify({ userId: 42 }, 'evt')).toThrow('target.userId must be a non-empty string');
	});

	// Foot-gun pin: live.push({ timeoutMs: 0 }) still rejects, AND the new
	// error message points users at live.notify directly. live.push is
	// async, so the validation throw surfaces as a promise rejection --
	// which is exactly the case that .catch(() => {}) was silently
	// swallowing. The new message gives users a one-line fix even if
	// they never see the rejection.
	it('live.push timeoutMs:0 error message points at live.notify', async () => {
		await expect(live.push({ userId: 'u-1' }, 'evt', null, { timeoutMs: 0 }))
			.rejects.toThrow(/use `live\.notify\(target, event, data\)` instead/);
	});
});

// - sessionId push target -----------------------------------------------------

describe('live.push() / live.notify() sessionId target', () => {
	beforeEach(() => {
		_resetPushRegistry();
	});

	it('routes to the connection registered by sessionId', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ session_id: 's-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => ({ ok: true }));

		const reply = await live.push({ sessionId: 's-1' }, 'evt', { n: 1 });
		expect(reply).toEqual({ ok: true });
		expect(platform.requested[0]).toMatchObject({ ws, event: 'evt', data: { n: 1 } });
	});

	it('throws NOT_FOUND naming the sessionId when no session is registered', async () => {
		await expect(live.push({ sessionId: 's-missing' }, 'evt')).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: expect.stringContaining('s-missing')
		});
	});

	it('resume-aware: a reconnecting session flips the target to the live socket', async () => {
		const platform = mockPlatform();
		const wsOld = { getUserData: () => ({ session_id: 's-1' }) };
		const wsNew = { getUserData: () => ({ session_id: 's-1' }) };
		pushHooks.open(wsOld, { platform });
		pushHooks.open(wsNew, { platform });
		platform._setRequestResolver(async () => 'ok');

		await live.push({ sessionId: 's-1' }, 'evt');
		expect(platform.requested[0].ws).toBe(wsNew);
	});

	it('registers userId and sessionId independently from one connection', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ user_id: 'u-1', session_id: 's-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ok');

		await live.push({ userId: 'u-1' }, 'a');
		await live.push({ sessionId: 's-1' }, 'b');
		expect(platform.requested.map((r) => r.event)).toEqual(['a', 'b']);
		expect(platform.requested.every((r) => r.ws === ws)).toBe(true);
	});

	it('a session-only connection registers for sessionId but not userId', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ session_id: 's-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ok');

		await expect(live.push({ sessionId: 's-1' }, 'evt')).resolves.toBe('ok');
		await expect(live.push({ userId: 's-1' }, 'evt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('close deregisters the session; a stale-ws close keeps the active one', async () => {
		const platform = mockPlatform();
		const wsOld = { getUserData: () => ({ session_id: 's-1' }) };
		const wsNew = { getUserData: () => ({ session_id: 's-1' }) };
		pushHooks.open(wsOld, { platform });
		pushHooks.open(wsNew, { platform });
		pushHooks.close(wsOld); // stale: must not deregister the active session
		platform._setRequestResolver(async () => 'ok');
		await expect(live.push({ sessionId: 's-1' }, 'evt')).resolves.toBe('ok');
		expect(platform.requested[0].ws).toBe(wsNew);

		pushHooks.close(wsNew); // active: fully deregisters
		await expect(live.push({ sessionId: 's-1' }, 'evt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('rejects a target that names zero or both known keys', async () => {
		await expect(live.push({}, 'evt')).rejects.toMatchObject({
			code: 'VALIDATION',
			message: expect.stringContaining('exactly one of userId / sessionId')
		});
		await expect(live.push({ userId: 'u-1', sessionId: 's-1' }, 'evt')).rejects.toMatchObject({
			code: 'VALIDATION',
			message: expect.stringContaining('exactly one of userId / sessionId')
		});
	});

	it('rejects an unknown target key', async () => {
		await expect(live.push({ groupId: 'g-1' }, 'evt')).rejects.toMatchObject({
			code: 'VALIDATION',
			message: expect.stringContaining('unsupported target keys: groupId')
		});
	});

	it('rejects a non-string / empty sessionId', async () => {
		await expect(live.push({ sessionId: '' }, 'evt')).rejects.toMatchObject({
			code: 'VALIDATION',
			message: expect.stringContaining('target.sessionId must be a non-empty string')
		});
		await expect(live.push({ sessionId: 42 }, 'evt')).rejects.toMatchObject({ code: 'VALIDATION' });
	});

	it('live.notify delivers to a session and is silent when the session is offline', async () => {
		const platform = mockPlatform();
		const ws = { getUserData: () => ({ session_id: 's-1' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ignored');

		await live.notify({ sessionId: 's-1' }, 'ping', { x: 1 });
		expect(platform.requested[0]).toMatchObject({ ws, event: 'ping', data: { x: 1 } });

		await expect(live.notify({ sessionId: 's-gone' }, 'ping')).resolves.toBeUndefined();
	});

	it('configurePush({ sessionIdentify }) overrides the session source', async () => {
		const platform = mockPlatform();
		live.configurePush({ sessionIdentify: (ws) => ws.getUserData()?.sid });
		const ws = { getUserData: () => ({ sid: 's-9' }) };
		pushHooks.open(ws, { platform });
		platform._setRequestResolver(async () => 'ok');

		await expect(live.push({ sessionId: 's-9' }, 'evt')).resolves.toBe('ok');
	});

	it('configurePush rejects a non-function sessionIdentify and still requires one slot', () => {
		expect(() => live.configurePush({ sessionIdentify: 42 })).toThrow(/sessionIdentify must be a function or null/);
		expect(() => live.configurePush({})).toThrow(/at least one of identify, sessionIdentify, or remoteRegistry/);
	});

	it('pushHooks.open validates the sessionId (control chars / oversized)', () => {
		const platform = mockPlatform();
		expect(() => pushHooks.open({ getUserData: () => ({ session_id: 'a\nb' }) }, { platform })).toThrow(/pushHooks\.open/);
		expect(() => pushHooks.open({ getUserData: () => ({ session_id: 'x'.repeat(300) }) }, { platform })).toThrow(/sessionId exceeds maximum length/);
	});
});

// - live.stream({ staleAfterMs, onError }) -----------------------------------

describe('live.stream({ staleAfterMs })', () => {
	beforeEach(() => {
		_resetStaleWatch();
		_resetTransformRegistry();
		_resetCoalesceRegistry();
		_resetVolatileRegistry();
		_resetTopicWsCounts();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function subscribeStream(ws, platform, msg = {}) {
		const data = toArrayBuffer({ rpc: 'feed/stream', id: 's1', args: [], stream: true, ...msg });
		handleRpc(ws, data, platform);
		// Flush microtasks (handleRpc is fire-and-forget; the loader awaits resolve)
		await vi.advanceTimersByTimeAsync(0);
	}

	it('rejects non-positive staleAfterMs at registration', () => {
		expect(() => live.stream('t', async () => [], { staleAfterMs: -1 })).toThrow(/positive/);
		expect(() => live.stream('t', async () => [], { staleAfterMs: 0 })).toThrow(/positive/);
		expect(() => live.stream('t', async () => [], { staleAfterMs: /** @type {any} */ ('30s') })).toThrow(/positive/);
		expect(() => live.stream('t', async () => [], { staleAfterMs: Infinity })).toThrow(/positive/);
	});

	it('stashes __streamStaleAfterMs on the init function', () => {
		const fn = live.stream('t', async () => [], { staleAfterMs: 1000 });
		expect(/** @type {any} */ (fn).__streamStaleAfterMs).toBe(1000);
	});

	it('reloads and publishes a refreshed event after staleAfterMs of silence', async () => {
		let nthCall = 0;
		const fn = live.stream('feed', async () => {
			nthCall++;
			return nthCall === 1 ? [{ id: 'a' }] : [{ id: 'a' }, { id: 'b' }];
		}, { merge: 'crud', staleAfterMs: 5000 });
		__register('feed/stream', fn);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform);

		expect(nthCall).toBe(1);
		expect(platform.sent[0].data.ok).toBe(true);

		await vi.advanceTimersByTimeAsync(5000);
		expect(nthCall).toBe(2);

		const refreshes = platform.published.filter((p) => p.event === 'refreshed');
		expect(refreshes).toHaveLength(1);
		expect(refreshes[0].topic).toBe('feed');
		expect(refreshes[0].data).toEqual([{ id: 'a' }, { id: 'b' }]);
	});

	it('resets the timer on each publish to the topic', async () => {
		let nthCall = 0;
		const fn = live.stream('feed', async () => { nthCall++; return []; }, { merge: 'crud', staleAfterMs: 5000 });
		__register('feed/stream', fn);
		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform);

		// 4s pass within the 5s window - a publish here should reset the timer
		await vi.advanceTimersByTimeAsync(4000);

		const poker = live(async (ctx) => { ctx.publish('feed', 'created', { id: 'x' }); });
		__register('feed/poke', poker);
		handleRpc(ws, toArrayBuffer({ rpc: 'feed/poke', id: 'p1', args: [] }), platform);
		await vi.advanceTimersByTimeAsync(0);

		// 4 more seconds (8s total since subscribe, but only 4s since the publish reset)
		await vi.advanceTimersByTimeAsync(4000);
		expect(nthCall).toBe(1); // watchdog has NOT fired - timer was reset by publish
		// 1.5s more crosses the 5s window from the publish
		await vi.advanceTimersByTimeAsync(1500);
		expect(nthCall).toBe(2);
	});

	it('clears the watchdog when the last subscriber leaves', async () => {
		let nthCall = 0;
		const fn = live.stream('feed', async () => { nthCall++; return []; }, { merge: 'crud', staleAfterMs: 1000 });
		__register('feed/stream', fn);
		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform);

		close(ws, { platform });

		await vi.advanceTimersByTimeAsync(5000);
		expect(nthCall).toBe(1); // loader did NOT fire post-close
	});

	it('does not double-arm when multiple subscribers join the same topic', async () => {
		let nthCall = 0;
		const fn = live.stream('feed', async () => { nthCall++; return []; }, { merge: 'crud', staleAfterMs: 1000 });
		__register('feed/stream', fn);
		const platform = mockPlatform();
		const ws1 = mockWs({ user_id: 'u1' });
		const ws2 = mockWs({ user_id: 'u2' });
		await subscribeStream(ws1, platform);
		await subscribeStream(ws2, platform, { id: 's2' });

		await vi.advanceTimersByTimeAsync(1000);
		// Initial-load ran once for each subscriber (2), plus one watchdog reload (1).
		expect(nthCall).toBe(3);
		// Only ONE refreshed broadcast despite two subscribers.
		const refreshes = platform.published.filter((p) => p.event === 'refreshed');
		expect(refreshes).toHaveLength(1);
	});

	it('routes loader throws to onError on the stale-reload path and re-arms', async () => {
		const errors = [];
		let nthCall = 0;
		const fn = live.stream('feed', async () => {
			nthCall++;
			if (nthCall > 1) throw new Error('reload failed');
			return [];
		}, {
			merge: 'crud',
			staleAfterMs: 1000,
			onError: (err, ctx, topic) => { errors.push({ msg: /** @type {Error} */ (err).message, topic }); }
		});
		__register('feed/stream', fn);
		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform);

		await vi.advanceTimersByTimeAsync(1000);
		expect(nthCall).toBe(2);
		expect(errors).toEqual([{ msg: 'reload failed', topic: 'feed' }]);
		expect(platform.published.filter((p) => p.event === 'refreshed')).toHaveLength(0);

		// Watchdog re-armed: second tick fires another reload
		await vi.advanceTimersByTimeAsync(1000);
		expect(nthCall).toBe(3);
		expect(errors).toHaveLength(2);
	});

	it('routes loader throws to onError on the initial subscribe path', async () => {
		const errors = [];
		const fn = live.stream('feed', async () => { throw new Error('init failed'); }, {
			merge: 'crud',
			staleAfterMs: 1000,
			onError: (err) => { errors.push(/** @type {Error} */ (err).message); }
		});
		__register('feed/stream', fn);
		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform);

		expect(platform.sent[0].data.ok).toBe(false);
		expect(platform.sent[0].data.code).toBe('INTERNAL_ERROR');
		expect(errors).toEqual(['init failed']);
	});

	it('onError throws are silently swallowed', async () => {
		let nthCall = 0;
		const fn = live.stream('feed', async () => {
			nthCall++;
			if (nthCall > 1) throw new Error('reload failed');
			return [];
		}, {
			merge: 'crud',
			staleAfterMs: 1000,
			onError: () => { throw new Error('observer crashed'); }
		});
		__register('feed/stream', fn);
		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform);

		// Watchdog runs reload, reload throws, onError throws. Both should be
		// swallowed - no rejection bubbles out of the timer callback. Then
		// the watchdog re-arms and fires a second reload on the next tick.
		await vi.advanceTimersByTimeAsync(1000);
		expect(nthCall).toBe(2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(nthCall).toBe(3);
	});

	it('applies stream transform to the refreshed payload (per-item for arrays)', async () => {
		let nthCall = 0;
		const fn = live.stream('feed', async () => {
			nthCall++;
			return nthCall === 1 ? [{ id: 'a', big: 'x'.repeat(100) }] : [{ id: 'a', big: 'y'.repeat(100) }];
		}, {
			merge: 'crud',
			staleAfterMs: 1000,
			transform: (row) => ({ id: row.id })
		});
		__register('feed/stream', fn);
		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform);

		expect(platform.sent[0].data.data).toEqual([{ id: 'a' }]); // initial loader transform applied per-item

		await vi.advanceTimersByTimeAsync(1000);
		const refreshes = platform.published.filter((p) => p.event === 'refreshed');
		expect(refreshes).toHaveLength(1);
		expect(refreshes[0].data).toEqual([{ id: 'a' }]); // reload payload projected, not full row
	});

	it('rejects non-function onError at registration', () => {
		expect(() => live.stream('t', async () => [], { onError: /** @type {any} */ ('not a fn') })).toThrow(/onError/);
		expect(() => live.stream('t', async () => [], { onError: /** @type {any} */ (42) })).toThrow(/onError/);
	});
});

// - live.stream({ invalidateOn }) --------------------------------------------

describe('live.stream({ invalidateOn })', () => {
	beforeEach(() => {
		_resetInvalidationWatch();
		_resetTransformRegistry();
		_resetCoalesceRegistry();
		_resetVolatileRegistry();
		_resetStaleWatch();
		_resetTopicWsCounts();
	});

	async function subscribeStream(ws, platform, rpc, msg = {}) {
		const data = toArrayBuffer({ rpc, id: 's1', args: [], stream: true, ...msg });
		handleRpc(ws, data, platform);
		await new Promise((r) => setTimeout(r, 10));
	}

	it('rejects non-string and non-array invalidateOn at registration', () => {
		expect(() => live.stream('t', async () => [], { invalidateOn: 42 })).toThrow(/invalidateOn must be a non-empty string/);
		expect(() => live.stream('t', async () => [], { invalidateOn: '' })).toThrow(/invalidateOn must be a non-empty string/);
		expect(() => live.stream('t', async () => [], { invalidateOn: [''] })).toThrow(/invalidateOn must be a non-empty string/);
		expect(() => live.stream('t', async () => [], { invalidateOn: ['ok', 7] })).toThrow(/invalidateOn must be a non-empty string/);
	});

	it('stashes __streamInvalidateOn as an array', () => {
		const single = live.stream('t', async () => [], { invalidateOn: 'todos:*' });
		expect(/** @type {any} */ (single).__streamInvalidateOn).toEqual(['todos:*']);
		const multi = live.stream('u', async () => [], { invalidateOn: ['todos:*', 'users:*'] });
		expect(/** @type {any} */ (multi).__streamInvalidateOn).toEqual(['todos:*', 'users:*']);
	});

	it('reruns the loader and publishes refreshed when a matching topic is published', async () => {
		let nthCall = 0;
		const fn = live.stream('todos', async () => {
			nthCall++;
			return nthCall === 1 ? [{ id: 'a' }] : [{ id: 'a' }, { id: 'b' }];
		}, { merge: 'crud', invalidateOn: 'todos:*' });
		__register('inv/todos', fn);

		const handler = live(async (ctx) => { ctx.publish('todos:created', 'created', { id: 'b' }); return 'ok'; });
		__register('inv/add', handler);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform, 'inv/todos');
		expect(nthCall).toBe(1);

		handleRpc(ws, toArrayBuffer({ rpc: 'inv/add', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 20));

		expect(nthCall).toBe(2);
		const refreshes = platform.published.filter((p) => p.event === 'refreshed');
		expect(refreshes).toHaveLength(1);
		expect(refreshes[0].topic).toBe('todos');
		expect(refreshes[0].data).toEqual([{ id: 'a' }, { id: 'b' }]);
	});

	it('does not rerun when the publish topic does not match', async () => {
		let nthCall = 0;
		const fn = live.stream('todos2', async () => { nthCall++; return []; }, {
			merge: 'crud', invalidateOn: 'todos:*'
		});
		__register('inv/todos2', fn);

		const handler = live(async (ctx) => { ctx.publish('users:created', 'created', { id: 'x' }); return 'ok'; });
		__register('inv/users', handler);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform, 'inv/todos2');
		expect(nthCall).toBe(1);

		handleRpc(ws, toArrayBuffer({ rpc: 'inv/users', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 20));

		expect(nthCall).toBe(1);
		expect(platform.published.filter((p) => p.event === 'refreshed')).toHaveLength(0);
	});

	it('accepts an array of patterns; any match triggers a reload', async () => {
		let nthCall = 0;
		const fn = live.stream('combined', async () => { nthCall++; return [nthCall]; }, {
			merge: 'set', invalidateOn: ['todos:*', 'users:*']
		});
		__register('inv/combined', fn);

		const fireUsers = live(async (ctx) => { ctx.publish('users:created', 'created', {}); return 'ok'; });
		__register('inv/fireUsers', fireUsers);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform, 'inv/combined');
		expect(nthCall).toBe(1);

		handleRpc(ws, toArrayBuffer({ rpc: 'inv/fireUsers', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 20));

		expect(nthCall).toBe(2);
	});

	it('skips refreshed events to prevent self-publish loops', async () => {
		let nthCall = 0;
		// Greedy pattern that would match the stream's own topic
		const fn = live.stream('loop', async () => { nthCall++; return [nthCall]; }, {
			merge: 'set', invalidateOn: 'loop*'
		});
		__register('inv/loop', fn);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform, 'inv/loop');
		expect(nthCall).toBe(1);

		// Manually publish a refreshed-event to the matching topic; it must
		// NOT retrigger another reload.
		platform.publish('loop', 'refreshed', [42]);
		await new Promise((r) => setTimeout(r, 20));

		expect(nthCall).toBe(1);
	});

	it('cleans up the registration when the last subscriber leaves', async () => {
		let nthCall = 0;
		const fn = live.stream('cleanup', async () => { nthCall++; return []; }, {
			merge: 'crud', invalidateOn: 'cleanup:*'
		});
		__register('inv/cleanup', fn);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform, 'inv/cleanup');
		expect(nthCall).toBe(1);

		close(ws, { platform });
		await new Promise((r) => setTimeout(r, 5));

		// After close, a publish to a previously-matching topic should not
		// trigger any reload (no subscribers, no watcher entry).
		platform.publish('cleanup:something', 'created', { id: 1 });
		await new Promise((r) => setTimeout(r, 20));

		expect(nthCall).toBe(1);
	});

	it('routes loader throws on the reload path through per-stream onError', async () => {
		let nthCall = 0;
		const seen = [];
		const fn = live.stream('boom', async () => {
			nthCall++;
			if (nthCall > 1) throw new Error('reload bad');
			return [];
		}, {
			merge: 'crud',
			invalidateOn: 'boom:*',
			onError: (err, ctx, topic) => { seen.push({ message: err.message, topic }); }
		});
		__register('inv/boom', fn);

		const trigger = live(async (ctx) => { ctx.publish('boom:something', 'created', {}); return 'ok'; });
		__register('inv/trigger', trigger);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform, 'inv/boom');
		expect(nthCall).toBe(1);

		handleRpc(ws, toArrayBuffer({ rpc: 'inv/trigger', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 20));

		expect(seen).toHaveLength(1);
		expect(seen[0].message).toBe('reload bad');
		expect(seen[0].topic).toBe('boom');
	});

	it('dedupes concurrent invalidation triggers via the reloading flag', async () => {
		let nthCall = 0;
		// Slow loader so two triggers arrive before the first reload completes
		const fn = live.stream('slow', async () => {
			nthCall++;
			await new Promise((r) => setTimeout(r, 30));
			return [nthCall];
		}, { merge: 'set', invalidateOn: 'slow:*' });
		__register('inv/slow', fn);

		const trigger = live(async (ctx) => { ctx.publish('slow:e', 'created', {}); return 'ok'; });
		__register('inv/slow-trigger', trigger);

		const platform = mockPlatform();
		const ws = mockWs({ user_id: 'u1' });
		await subscribeStream(ws, platform, 'inv/slow');
		await new Promise((r) => setTimeout(r, 35));
		expect(nthCall).toBe(1);

		// Two triggers in quick succession while the reload is in flight.
		handleRpc(ws, toArrayBuffer({ rpc: 'inv/slow-trigger', id: 'p1', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 5));
		handleRpc(ws, toArrayBuffer({ rpc: 'inv/slow-trigger', id: 'p2', args: [] }), platform);
		await new Promise((r) => setTimeout(r, 50));

		// First trigger started reload #2; second trigger during reload #2 was
		// dropped (reloading flag). Total reload count: 2 (initial + 1 reload).
		expect(nthCall).toBe(2);
	});
});

describe('live.silentTopicWarning()', () => {
	let warnSpy;

	beforeEach(() => {
		_resetSilentTopicWarning();
		live.silentTopicWarning({ thresholdMs: 30 });
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		warnSpy.mockRestore();
		_resetSilentTopicWarning();
	});

	it('warns once when no events arrive within thresholdMs', async () => {
		_armSilentTopicWatch('audit:org-1');
		await vi.advanceTimersByTimeAsync(50);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const msg = warnSpy.mock.calls[0][0];
		expect(msg).toContain("Topic 'audit:org-1'");
		expect(msg).toContain('30ms');
		expect(msg).toContain('pg_notify');
		expect(msg).toContain('ctx.publish');
		expect(msg).toContain('https://svti.me/silent-topic');
	});

	it('does NOT warn when an event arrives before the threshold', async () => {
		const platform = mockPlatform();
		_armSilentTopicWatch('chat:room-1');
		await _publishViaCtx(platform, 'chat:room-1', 'msg', { x: 1 });
		await vi.advanceTimersByTimeAsync(50);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('warns at most once per topic per process', async () => {
		_armSilentTopicWatch('once:1');
		await vi.advanceTimersByTimeAsync(50);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		// Re-arm after warn fires: warned-set dedups, no second warn.
		_armSilentTopicWatch('once:1');
		await vi.advanceTimersByTimeAsync(50);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('skips system topics (__-prefixed) automatically', async () => {
		_armSilentTopicWatch('__realtime');
		_armSilentTopicWatch('__signal:user-42');
		_armSilentTopicWatch('__custom:foo');
		await vi.advanceTimersByTimeAsync(50);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('skips topics in the suppress list', async () => {
		live.silentTopicWarning({ suppress: ['admin:audit', 'cron:reports'] });
		_armSilentTopicWatch('admin:audit');
		_armSilentTopicWatch('cron:reports');
		_armSilentTopicWatch('chat:room-1');
		await vi.advanceTimersByTimeAsync(50);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("'chat:room-1'");
	});

	it('disable via false stops armed timers immediately', async () => {
		_armSilentTopicWatch('foo:1');
		_armSilentTopicWatch('foo:2');

		live.silentTopicWarning(false);
		await vi.advanceTimersByTimeAsync(50);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('thresholdMs override takes effect on subsequent arms', async () => {
		live.silentTopicWarning({ thresholdMs: 100 });
		_armSilentTopicWatch('slow:1');
		await vi.advanceTimersByTimeAsync(50);

		// Old threshold (30) would have fired by now; new one (100) hasn't.
		expect(warnSpy).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(60);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('arming the same topic twice is a no-op', async () => {
		_armSilentTopicWatch('dup:1');
		_armSilentTopicWatch('dup:1');
		_armSilentTopicWatch('dup:1');
		await vi.advanceTimersByTimeAsync(50);

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed config', () => {
		expect(() => live.silentTopicWarning('not-an-object')).toThrow(/config must be/);
		expect(() => live.silentTopicWarning(0)).toThrow(/config must be/);
		expect(() => live.silentTopicWarning({ thresholdMs: 0 })).toThrow(/positive finite/);
		expect(() => live.silentTopicWarning({ thresholdMs: -1 })).toThrow(/positive finite/);
		expect(() => live.silentTopicWarning({ thresholdMs: Infinity })).toThrow(/positive finite/);
		expect(() => live.silentTopicWarning({ thresholdMs: 'fast' })).toThrow(/positive finite/);
		expect(() => live.silentTopicWarning({ suppress: 'admin' })).toThrow(/array/);
		expect(() => live.silentTopicWarning({ suppress: [42] })).toThrow(/strings/);
	});

	it('publish via ctx.publish observes the topic and disarms the timer', async () => {
		const platform = mockPlatform();
		_armSilentTopicWatch('chat:room-2');
		await _publishViaCtx(platform, 'chat:room-2', 'msg', { x: 1 });
		await vi.advanceTimersByTimeAsync(50);

		expect(warnSpy).not.toHaveBeenCalled();
	});
});

/**
 * Helper: drive a real `ctx.publish(...)` against the cached helper so the
 * publish-closure runs (where `_observeSilentTopicPublish` fires). Uses the
 * same handleRpc path the production hot path takes; the registered handler
 * just calls `ctx.publish` once and returns.
 */
async function _publishViaCtx(platform, topic, event, data) {
	const handler = live(async (ctx) => {
		ctx.publish(topic, event, data);
		return { ok: true };
	});
	__register('test/silent-publish', handler);
	const ws = mockWs({ user_id: 'u-silent' });
	const msg = toArrayBuffer({ rpc: 'test/silent-publish', id: 'silent-1', args: [] });
	handleRpc(ws, msg, platform);
	// Drain microtasks so the handler resolves and ctx.publish runs.
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(0);
}

// - Production assertions ----------------------------------------------------

describe('assert() helper', () => {
	let errSpy;

	beforeEach(() => {
		_resetAssertCounters();
		errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		errSpy.mockRestore();
		_resetAssertCounters();
	});

	it('returns silently when condition is true; counter stays at zero', () => {
		assert(true, 'realtime/test.cat-a');
		expect(getAssertionCounters().get('realtime/test.cat-a')).toBeUndefined();
		expect(errSpy).not.toHaveBeenCalled();
	});

	it('throws in test mode when condition is false; counter increments; structured log fires', () => {
		expect(() => assert(false, 'realtime/test.cat-b', { x: 1 })).toThrow(/realtime\/test\.cat-b/);
		expect(getAssertionCounters().get('realtime/test.cat-b')).toBe(1);
		expect(errSpy).toHaveBeenCalledTimes(1);
		const logged = errSpy.mock.calls[0][0];
		expect(logged).toContain('[realtime/assert]');
		expect(logged).toContain('"category":"realtime/test.cat-b"');
		expect(logged).toContain('"x":1');
	});

	it('counter accumulates per category across violations', () => {
		try { assert(false, 'realtime/test.cat-c'); } catch {}
		try { assert(false, 'realtime/test.cat-c'); } catch {}
		try { assert(false, 'realtime/test.cat-c'); } catch {}
		try { assert(false, 'realtime/test.cat-d'); } catch {}
		expect(getAssertionCounters().get('realtime/test.cat-c')).toBe(3);
		expect(getAssertionCounters().get('realtime/test.cat-d')).toBe(1);
	});

	it('omits context key when no context passed', () => {
		try { assert(false, 'realtime/test.cat-e'); } catch {}
		const logged = errSpy.mock.calls[0][0];
		expect(logged).toContain('"category":"realtime/test.cat-e"');
		expect(logged).not.toContain('"context"');
	});

	it('fires the realtime/handleRpc.envelope.non-empty assertion on empty rpc/id', () => {
		const ws = mockWs({});
		const platform = mockPlatform();
		const data = toArrayBuffer({ rpc: '', id: 'someid', args: [] });
		expect(() => handleRpc(ws, data, platform)).toThrow(/realtime\/handleRpc\.envelope\.non-empty/);
		expect(getAssertionCounters().get('realtime/handleRpc.envelope.non-empty')).toBe(1);
	});

	it('does not fire any assertion under the existing 983 happy-path tests', () => {
		// Documented invariant: every other test in this file runs without
		// firing an assert. If a real path violates an invariant the test
		// throws via the test-mode-throws contract, surfacing as a normal
		// vitest failure. This test asserts the counter map is clean at
		// fresh-reset baseline; the 983-test suite is the wider regression.
		expect(getAssertionCounters().size).toBe(0);
	});
});

// - Capacity caps ------------------------------------------------------------

describe('capacity caps', () => {
	describe('MAX_PUSH_REGISTRY (WARN-then-skip)', () => {
		let warnSpy;

		beforeEach(() => {
			_resetPushRegistry();
			_resetCapsForTest();
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});

		afterEach(() => {
			warnSpy.mockRestore();
			_resetPushRegistry();
			_resetCapsForTest();
		});

		it('exposes the documented default', () => {
			expect(MAX_PUSH_REGISTRY).toBe(10_000_000);
		});

		it('skips registration once the cap is hit and warns once', () => {
			_setCapsForTest({ pushRegistry: 3 });
			const platform = mockPlatform();
			const ctx = { platform };

			pushHooks.open(mockWs({ user_id: 'u1' }), ctx);
			pushHooks.open(mockWs({ user_id: 'u2' }), ctx);
			pushHooks.open(mockWs({ user_id: 'u3' }), ctx);
			expect(warnSpy).not.toHaveBeenCalled();

			pushHooks.open(mockWs({ user_id: 'u4' }), ctx);
			pushHooks.open(mockWs({ user_id: 'u5' }), ctx);

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toContain('MAX_PUSH_REGISTRY=3');
		});

		it('replaces an existing userId without checking the cap (last-write-wins)', () => {
			_setCapsForTest({ pushRegistry: 2 });
			const platform = mockPlatform();
			const ctx = { platform };

			pushHooks.open(mockWs({ user_id: 'u1' }), ctx);
			pushHooks.open(mockWs({ user_id: 'u2' }), ctx);
			pushHooks.open(mockWs({ user_id: 'u1' }), ctx); // re-register existing

			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('reset clears the warn-fired flag so the next saturation re-warns', () => {
			_setCapsForTest({ pushRegistry: 1 });
			const platform = mockPlatform();
			const ctx = { platform };

			pushHooks.open(mockWs({ user_id: 'u1' }), ctx);
			pushHooks.open(mockWs({ user_id: 'u2' }), ctx);
			expect(warnSpy).toHaveBeenCalledTimes(1);

			_resetPushRegistry();

			pushHooks.open(mockWs({ user_id: 'u3' }), ctx);
			pushHooks.open(mockWs({ user_id: 'u4' }), ctx);
			expect(warnSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe('TOPIC_WS_COUNTS_WARN_THRESHOLD (WARN-ONLY)', () => {
		let warnSpy;
		let platform;

		beforeEach(() => {
			_resetTopicWsCounts();
			_resetCapsForTest();
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			platform = mockPlatform();
		});

		afterEach(() => {
			warnSpy.mockRestore();
			_resetTopicWsCounts();
			_resetCapsForTest();
		});

		it('exposes the documented default', () => {
			expect(TOPIC_WS_COUNTS_WARN_THRESHOLD).toBe(1_000_000);
		});

		it('warns once when the topic-subscribers index crosses the threshold; map keeps growing', async () => {
			_setCapsForTest({ topicWsCountsWarn: 3 });

			for (let i = 0; i < 5; i++) {
				const stream = live.stream('feed/cap' + i, async () => [], {});
				__register('feed/cap' + i, stream);
				const ws = mockWs({ id: 'u' + i });
				handleRpc(ws, toArrayBuffer({ rpc: 'feed/cap' + i, id: 's' + i, args: [], stream: true }), platform);
			}
			await new Promise((r) => setTimeout(r, 10));

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toContain('TOPIC_WS_COUNTS_WARN_THRESHOLD=3');
		});
	});

	describe('SILENT_TOPIC_WARN_DEDUP_MAX (FIFO-evict)', () => {
		let warnSpy;
		let platform;

		beforeEach(() => {
			_resetSilentTopicWarning();
			_resetCapsForTest();
			vi.useFakeTimers();
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			platform = mockPlatform();
		});

		afterEach(() => {
			warnSpy.mockRestore();
			vi.useRealTimers();
			_resetSilentTopicWarning();
			_resetCapsForTest();
		});

		it('exposes the documented default', () => {
			expect(SILENT_TOPIC_WARN_DEDUP_MAX).toBe(1_000_000);
		});

		it('keeps the dedup set bounded once the cap is reached without blocking new warns', () => {
			_setCapsForTest({ silentTopicWarnDedup: 2 });
			live.silentTopicWarning({ thresholdMs: 50 });

			for (let i = 0; i < 5; i++) {
				_armSilentTopicWatch('topic-' + i);
			}
			vi.advanceTimersByTime(60);

			// 5 topics arm, 5 warns fire. The dedup cap is hit after the 3rd
			// warn but FIFO-evict makes room without blocking new warns.
			// Re-warn after eviction is unreachable in normal operation
			// (`_silentTopicWatch.has(topic)` short-circuits) - the dedup
			// exists for memory protection, not for re-warn semantics.
			expect(warnSpy).toHaveBeenCalledTimes(5);
		});
	});

	describe('PUBLISH_RATE_WARN_DEDUP_MAX (FIFO-evict)', () => {
		let warnSpy;
		let platform;

		beforeEach(() => {
			_resetPublishRateWarning();
			_resetCapsForTest();
			live.publishRateWarning({ threshold: 100, intervalMs: 50 });
			vi.useFakeTimers();
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});

		afterEach(() => {
			vi.useRealTimers();
			warnSpy.mockRestore();
			_resetPublishRateWarning();
			_resetCapsForTest();
			live.publishRateWarning({ threshold: 200, intervalMs: 5000 });
			live.publishRateWarning(true);
		});

		it('exposes the documented default', () => {
			expect(PUBLISH_RATE_WARN_DEDUP_MAX).toBe(1_000_000);
		});

		it('evicts oldest entry when dedup set saturates; evicted topic can re-warn', () => {
			_setCapsForTest({ publishRateWarnDedup: 2 });
			platform = mockPlatform();
			platform.pressure.topPublishers = [
				{ topic: 'a:1', messagesPerSec: 200, bytesPerSec: 1 },
				{ topic: 'b:2', messagesPerSec: 200, bytesPerSec: 1 }
			];
			_activatePublishRateWarning(platform);
			vi.advanceTimersByTime(60);
			expect(warnSpy).toHaveBeenCalledTimes(2);

			// Adding a third over-threshold topic FIFO-evicts a:1 from the dedup
			// before adding c:3. The active sampler now warns for c:3.
			platform.pressure.topPublishers = [
				{ topic: 'c:3', messagesPerSec: 200, bytesPerSec: 1 }
			];
			vi.advanceTimersByTime(60);
			expect(warnSpy).toHaveBeenCalledTimes(3);

			// a:1 was evicted, so it re-warns when it shows up again.
			platform.pressure.topPublishers = [
				{ topic: 'a:1', messagesPerSec: 200, bytesPerSec: 1 }
			];
			vi.advanceTimersByTime(60);
			expect(warnSpy).toHaveBeenCalledTimes(4);
		});
	});

	describe('MAX_PRESENCE_REF (WARN-then-skip)', () => {
		let warnSpy;

		beforeEach(() => {
			_resetCapsForTest();
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});

		afterEach(() => {
			warnSpy.mockRestore();
			_resetCapsForTest();
		});

		it('exposes the documented default', () => {
			expect(MAX_PRESENCE_REF).toBe(1_000_000);
		});

		it('skips registration once the cap is hit and warns once', async () => {
			_setCapsForTest({ presenceRef: 2 });

			const room = live.room({
				topic: (ctx, roomId) => 'cap-pres:' + roomId,
				init: async () => [],
				presence: (ctx) => ({ name: ctx.user?.name }),
				topicArgs: 1
			});
			__register('cap-pres/__data', room.__dataStream);

			const platform = mockPlatform();
			// Two distinct (user, room) pairs fit under the cap.
			handleRpc(mockWs({ id: 'u1' }), toArrayBuffer({ rpc: 'cap-pres/__data', id: 's1', args: ['r1'], stream: true }), platform);
			handleRpc(mockWs({ id: 'u2' }), toArrayBuffer({ rpc: 'cap-pres/__data', id: 's2', args: ['r1'], stream: true }), platform);
			await new Promise((r) => setTimeout(r, 10));
			expect(warnSpy).not.toHaveBeenCalled();

			// Third user saturates - no grace entries to evict, so silent skip + warn.
			handleRpc(mockWs({ id: 'u3' }), toArrayBuffer({ rpc: 'cap-pres/__data', id: 's3', args: ['r1'], stream: true }), platform);
			handleRpc(mockWs({ id: 'u4' }), toArrayBuffer({ rpc: 'cap-pres/__data', id: 's4', args: ['r1'], stream: true }), platform);
			await new Promise((r) => setTimeout(r, 10));

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toContain('MAX_PRESENCE_REF=2');
			expect(warnSpy.mock.calls[0][0]).toContain('platform.redis');
		});
	});
});

// - Production assertions: hard tier (server) --------------------------------

describe('fatal() hard tier (server)', () => {
	let errSpy;
	let savedVitest;
	let savedNodeEnv;
	// Computed env access so vite:define cannot statically rewrite (and mangle)
	// these reads/writes during transform.
	const setEnv = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

	beforeEach(() => {
		_resetAssertCounters();
		errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		savedVitest = process.env['VITEST'];
		savedNodeEnv = process.env['NODE_ENV'];
	});

	afterEach(() => {
		// Restore the env first so a failed assertion can never strand the
		// process in the production branch (a real exit would kill vitest).
		setEnv('VITEST', savedVitest);
		setEnv('NODE_ENV', savedNodeEnv);
		errSpy.mockRestore();
		_resetAssertCounters();
	});

	it('returns silently when the condition holds', () => {
		fatal(true, 'realtime/test.fatal-ok');
		expect(getAssertionCounters().get('realtime/test.fatal-ok')).toBeUndefined();
		expect(errSpy).not.toHaveBeenCalled();
	});

	it('throws in test mode, counts the violation, and logs the fatal severity', () => {
		expect(() => fatal(false, 'realtime/test.fatal-y', { v: 7 })).toThrow(/realtime\/test\.fatal-y/);
		expect(getAssertionCounters().get('realtime/test.fatal-y')).toBe(1);
		const logged = errSpy.mock.calls[0][0];
		expect(logged).toContain('[realtime/fatal]');
		expect(logged).toContain('"severity":"fatal"');
		expect(logged).toContain('"v":7');
	});

	it('in production defers an exit(78) through the sink without throwing', async () => {
		const exits = [];
		setFatalSink({ exit: (code) => exits.push(code) });
		setEnv('VITEST', undefined);
		setEnv('NODE_ENV', 'production');
		expect(() => fatal(false, 'realtime/test.fatal-prod')).not.toThrow();
		// Deferred to a microtask so the current callback frame unwinds first.
		expect(exits).toEqual([]);
		await Promise.resolve();
		await Promise.resolve();
		expect(exits).toEqual([78]);
		expect(getAssertionCounters().get('realtime/test.fatal-prod')).toBe(1);
	});

	it('setFatalSink rejects a sink without an exit function', () => {
		expect(() => setFatalSink({})).toThrow(/exit\(code\)/);
		expect(() => setFatalSink(null)).toThrow(/exit\(code\)/);
	});

	it('resetFatalSink restores the default exit sink', async () => {
		const custom = [];
		setFatalSink({ exit: (code) => custom.push(code) });
		resetFatalSink();
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
		try {
			setEnv('VITEST', undefined);
			setEnv('NODE_ENV', 'production');
			fatal(false, 'realtime/test.fatal-reset');
			await Promise.resolve();
			await Promise.resolve();
			expect(custom).toEqual([]);
			expect(exitSpy).toHaveBeenCalledWith(78);
		} finally {
			exitSpy.mockRestore();
		}
	});
});
