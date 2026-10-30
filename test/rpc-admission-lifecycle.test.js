import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

let api, admission;
beforeEach(async () => {
	vi.resetModules();
	api = await import('../src/server.js');
	admission = await import('../src/server/rpc-admission.js');
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	// Resolve the lazy registry once, so calls are admitted in arrival order.
	api.__register('warm/up', api.live(() => 0));
	api.handleRpc(mockWs({ id: 'warm' }), text('warm/up', 'warm'), mockPlatform());
	await settle();
}, 30000);
afterEach(() => {
	admission._resetRpcAdmission();
	api._resetMiddleware?.();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Fake timers, with any ticker started on real ones stopped. */
function fakeTime() {
	vi.useFakeTimers();
	admission._resetRpcAdmission();
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const text = (path, id, args = []) => toArrayBuffer({ rpc: path, id, args });

function replies(platform) {
	const out = new Map();
	for (const row of platform.sent) if (row.topic === '__rpc' && row.data && row.data.ok !== undefined) out.set(row.event, row.data);
	return out;
}

function gated() {
	let open;
	const gate = new Promise(resolve => { open = resolve; });
	const running = new Set();
	const handler = api.live(async (ctx) => {
		running.add(ctx);
		try { await gate; return 'done'; } finally { running.delete(ctx); }
	});
	return { handler, running, open: () => open() };
}

describe('per-call abort signal', () => {
	it('a call that settled never fires its signal, on the deadline or the close', async () => {
		fakeTime();
		const fired = [];
		api.__register('signal/quick', api.live(async (ctx) => {
			ctx.abortSignal.addEventListener('abort', () => fired.push('quick'));
			return 1;
		}, { timeout: 500 }));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('signal/quick', 'a'), platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(replies(platform).get('a')).toMatchObject({ ok: true });
		expect(admission._rpcAdmissionSnapshot().pendingSignals).toBe(0);
		await vi.advanceTimersByTimeAsync(2000);
		api.close(ws, { platform });
		expect(fired).toEqual([]);
	});

	it('gives each call its own signal: two calls in one window both see their abort', async () => {
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		const seen = [];
		const signals = [];
		api.__register('signal/two', api.live(async (ctx, name) => {
			signals.push(ctx.abortSignal);
			ctx.abortSignal.onabort = () => seen.push(name);
			await gate;
			return name;
		}));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('signal/two', 'a', ['first']), platform);
		api.handleRpc(ws, text('signal/two', 'b', ['second']), platform);
		await settle();
		expect(signals[0]).not.toBe(signals[1]);
		api.close(ws, { platform });
		expect(seen.sort()).toEqual(['first', 'second']);
		release();
		await settle();
	});

	it('allocates no controller for a handler that never reads the signal', async () => {
		api.__register('signal/unread', api.live(async () => 1));
		const platform = mockPlatform();
		for (let i = 0; i < 50; i++) api.handleRpc(mockWs({ id: 'u' + i }), text('signal/unread', 'n' + i), platform);
		await settle();
		expect(admission._rpcAdmissionSnapshot()).toMatchObject({ pendingSignals: 0, buckets: 0 });
	});

	it('keeps controllers and listeners flat across calls with timeout 0', async () => {
		api.configureRpc({ timeout: 0 });
		const signals = new Set();
		api.__register('signal/open', api.live(async (ctx) => {
			signals.add(ctx.abortSignal);
			ctx.abortSignal.addEventListener('abort', () => {});
			return 1;
		}));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		const warnings = [];
		const onWarning = (warning) => warnings.push(warning.name);
		process.on('warning', onWarning);
		try {
			for (let i = 0; i < 40; i++) {
				api.handleRpc(ws, text('signal/open', 'o' + i), platform);
				await settle();
			}
		} finally {
			process.off('warning', onWarning);
		}
		// One controller per call and none kept once its call settled, so no
		// signal collects more than its own call's listeners.
		expect(signals.size).toBe(40);
		expect(admission._rpcAdmissionSnapshot()).toMatchObject({ pendingSignals: 0, buckets: 0 });
		expect(warnings.filter(name => name === 'MaxListenersExceededWarning')).toEqual([]);
	});

	it('fires a signal first read after the deadline at once', async () => {
		fakeTime();
		let finish;
		let late;
		api.__register('signal/late', api.live(async (ctx) => {
			await new Promise(resolve => { finish = resolve; });
			late = ctx.abortSignal;
			return 1;
		}, { timeout: 300 }));
		api.handleRpc(mockWs({ id: 'u' }), text('signal/late', 'l'), mockPlatform());
		await vi.advanceTimersByTimeAsync(1000);
		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(late.aborted).toBe(true);
		expect(late.reason).toMatchObject({ code: 'TIMEOUT' });
	});

	it('closing one socket leaves another socket with the same user data alone', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		const user = { id: 'shared' };
		const one = { ...mockWs({}), getUserData: () => user };
		const two = { ...mockWs({}), getUserData: () => user };
		const signals = {};
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		api.__register('signal/shared', api.live(async (ctx, name) => { signals[name] = ctx.abortSignal; await gate; return name; }));
		const platform = mockPlatform();
		api.handleRpc(one, text('signal/shared', 'a', ['one']), platform);
		// Each socket is its own connection for the cap too.
		api.handleRpc(two, text('signal/shared', 'b', ['two']), platform);
		await settle();
		expect(replies(platform).size).toBe(0);
		api.close(one, { platform });
		expect(signals.one.aborted).toBe(true);
		expect(signals.two.aborted).toBe(false);
		release();
		await settle();
	});
});

describe('per-connection queue', () => {
	it('holds at most perConnectionQueue calls of one connection and refuses the rest with queue_full', async () => {
		const { handler, running, open } = gated();
		api.__register('conn/many', handler);
		const platform = mockPlatform();
		const ws = mockWs({ id: 'tab' });
		for (let i = 0; i < 256; i++) api.handleRpc(ws, text('conn/many', 'm' + i), platform);
		await settle();
		expect(running.size).toBe(32);
		expect(admission._rpcAdmissionSnapshot().queued).toBe(32);
		const refused = [...replies(platform).values()];
		expect(refused).toHaveLength(256 - 64);
		expect(refused.every(r => r.code === 'OVERLOADED' && r.reason === 'queue_full' && r.scope === 'connection')).toBe(true);
		// The worker queue keeps room for everyone else.
		const other = mockWs({ id: 'other' });
		for (let i = 0; i < 40; i++) api.handleRpc(other, text('conn/many', 'x' + i), platform);
		await settle();
		expect(admission._rpcAdmissionSnapshot().queued).toBe(32 + 8);
		open();
		await settle();
		await settle();
	});

	it('perConnectionQueue 0 lifts the per-connection queue bound', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, perConnectionQueue: 0 });
		const { handler, open } = gated();
		api.__register('conn/open', handler);
		const platform = mockPlatform();
		const ws = mockWs({ id: 'tab' });
		for (let i = 0; i < 100; i++) api.handleRpc(ws, text('conn/open', 'q' + i), platform);
		await settle();
		expect(admission._rpcAdmissionSnapshot().queued).toBe(99);
		open();
		await settle();
		await settle();
	});

	it('rejects a bad perConnectionQueue at startup', () => {
		expect(() => api.realtime({ rpc: { perConnectionQueue: -1 } })).toThrow(/rpc\.perConnectionQueue must be a non-negative integer/);
	});

	it('runs a parallel batch above the connection cap without refusing it', async () => {
		let concurrent = 0;
		let peak = 0;
		api.__register('conn/batched', api.live(async () => {
			concurrent++;
			peak = Math.max(peak, concurrent);
			await new Promise(resolve => setTimeout(resolve, 5));
			concurrent--;
			return 1;
		}));
		const platform = mockPlatform();
		const batch = Array.from({ length: 50 }, (_, i) => ({ rpc: 'conn/batched', id: 'b' + i, args: [] }));
		api.handleRpc(mockWs({ id: 'u' }), toArrayBuffer({ batch }), platform);
		await new Promise(resolve => setTimeout(resolve, 150));
		const reply = platform.sent.find(row => row.event === '__batch')?.data.batch;
		expect(reply).toHaveLength(50);
		expect(reply.every(r => r.ok === true)).toBe(true);
		expect(peak).toBe(32);
	});
});

describe('release on every exit', () => {
	it('releases the permit when the guard throws', async () => {
		api.__registerGuard('guarded', api.guard(() => { throw new api.LiveError('FORBIDDEN', 'no'); }));
		api.__register('guarded/call', api.live(async () => 1));
		const platform = mockPlatform();
		api.handleRpc(mockWs({ id: 'u' }), text('guarded/call', 'g'), platform);
		await settle();
		expect(replies(platform).get('g')).toMatchObject({ code: 'FORBIDDEN' });
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	});

	it('releases the permit when a stream loader throws', async () => {
		api.__register('loader/broken', api.live.stream('broken-topic', async () => { throw new api.LiveError('NOT_FOUND', 'gone'); }));
		const platform = mockPlatform();
		api.handleRpc(mockWs({ id: 'u' }), toArrayBuffer({ rpc: 'loader/broken', id: 's', args: [], stream: true }), platform);
		await settle();
		await settle();
		expect(replies(platform).get('s')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	});

	it('keeps the counts of a path whose function is registered again while calls run', async () => {
		api.configureRpc({ maxQueue: 0 });
		let finish;
		api.__register('reload/path', api.live(() => new Promise(resolve => { finish = resolve; }), { perRouteConcurrent: 1 }));
		const platform = mockPlatform();
		api.handleRpc(mockWs({ id: 'a' }), text('reload/path', 'r1'), platform);
		await settle();
		api.__register('reload/path', api.live(async () => 'new', { perRouteConcurrent: 1 }));
		api.handleRpc(mockWs({ id: 'b' }), text('reload/path', 'r2'), platform);
		await settle();
		// The reloaded function inherits the running call's place.
		expect(replies(platform).get('r2')).toMatchObject({ code: 'OVERLOADED', scope: 'route' });
		finish();
		await settle();
		api.handleRpc(mockWs({ id: 'c' }), text('reload/path', 'r3'), platform);
		await settle();
		expect(replies(platform).get('r3')).toMatchObject({ ok: true, data: 'new' });
		expect(admission._rpcAdmissionSnapshot().routes['reload/path'].active).toBe(0);
	});

	it('releases a binary call a middleware answered early once its handler settles', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		let finish;
		api.live.middleware(async (_ctx, next) => {
			next().catch(() => {});
			return { ok: false, code: 'TIMEOUT', error: 'answered early' };
		});
		api.__register('mw/bin', api.live.binary(() => new Promise(resolve => { finish = resolve; })));
		const platform = mockPlatform();
		const header = new TextEncoder().encode(JSON.stringify({ rpc: 'mw/bin', id: 'b1' }));
		const bytes = new Uint8Array(3 + header.length + 2);
		new DataView(bytes.buffer).setUint16(1, header.length);
		bytes.set(header, 3);
		api.handleRpc(mockWs({ id: 'u' }), bytes.buffer, platform);
		await settle();
		expect(replies(platform).get('b1')).toMatchObject({ code: 'TIMEOUT' });
		expect(admission._rpcAdmissionSnapshot().active).toBe(1);
		finish();
		await settle();
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	});

	it('raising a limit starts calls already waiting', async () => {
		api.configureRpc({ perConnectionConcurrent: 1 });
		const { handler, running, open } = gated();
		api.__register('raise/me', handler);
		const ws = mockWs({ id: 'u' });
		for (let i = 0; i < 3; i++) api.handleRpc(ws, text('raise/me', 'r' + i), mockPlatform());
		await settle();
		expect(running.size).toBe(1);
		api.configureRpc({ perConnectionConcurrent: 3 });
		await settle();
		expect(running.size).toBe(3);
		open();
		await settle();
	});
});
