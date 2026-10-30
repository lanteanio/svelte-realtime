import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

/** A full collection, so heap readings compare what is still reachable. */
function gc() {
	if (!globalThis.gc) {
		setFlagsFromString('--expose-gc');
		globalThis.gc = runInNewContext('gc');
	}
	globalThis.gc();
}
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

let api, admission;
beforeEach(async () => {
	vi.resetModules();
	api = await import('../src/server.js');
	admission = await import('../src/server/rpc-admission.js');
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	// The first call of a fresh module resolves the lazy registry and yields
	// once; warm it so the calls under test are admitted in arrival order.
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

/** Fake timers, with the deadline ticker the warm-up started on real ones stopped. */
function fakeTime() {
	vi.useFakeTimers();
	admission._resetRpcAdmission();
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const text = (path, id, args = []) => toArrayBuffer({ rpc: path, id, args });

/**
 * A handler that holds every call until `open()` and records the ctx of each
 * call it is running. `another()` makes one more function on the same gate,
 * for a second route.
 */
function gated() {
	let open;
	const gate = new Promise(resolve => { open = resolve; });
	const running = new Set();
	const make = () => api.live(async (ctx) => {
		running.add(ctx);
		try { await gate; return 'done'; } finally { running.delete(ctx); }
	});
	return { handler: make(), another: make, running, open: () => open() };
}

/** The reply each correlation id got, in arrival order. */
function replies(platform) {
	const out = new Map();
	for (const row of platform.sent) if (row.topic === '__rpc' && row.data && row.data.ok !== undefined) out.set(row.event, row.data);
	return out;
}

describe('a gated handler under a flood of arrivals', () => {
	for (const arrivals of [1000, 5000, 20000]) {
		it(`bounds ${arrivals} arrivals at the route cap, queues 256 and refuses the rest at once`, async () => {
			const { handler, running, open } = gated();
			api.__register('flood/slow', handler);
			const platform = mockPlatform();
			// Spread over enough sockets that the connection scope never binds.
			const sockets = Array.from({ length: Math.ceil(arrivals / 10) }, (_, i) => mockWs({ id: 'u' + i }));
			for (let i = 0; i < arrivals; i++) api.handleRpc(sockets[i % sockets.length], text('flood/slow', 'c' + i), platform);
			await settle();

			expect(running.size).toBe(256);
			const snap = admission._rpcAdmissionSnapshot();
			expect(snap.active).toBe(256);
			expect(snap.queued).toBe(256);
			const refused = [...replies(platform).values()];
			expect(refused).toHaveLength(arrivals - 512);
			for (const reply of refused) {
				expect(reply).toMatchObject({ ok: false, code: 'OVERLOADED', reason: 'queue_full', scope: 'global' });
			}

			open();
			await settle();
			await settle();
			expect(running.size).toBe(0);
			const answered = [...replies(platform).values()];
			expect(answered).toHaveLength(arrivals);
			expect(answered.filter(r => r.ok === true)).toHaveLength(512);
			expect(admission._rpcAdmissionSnapshot()).toMatchObject({ active: 0, queued: 0 });
		});
	}

	it('keeps the retained heap flat as arrivals grow', async () => {
		// Each call carries 4 KB of arguments. Admitted, the worker retains
		// 512 calls whatever arrives; without admission it retains every one,
		// about 80 MB more at 20000 than at 1000.
		const payload = 'x'.repeat(4096);
		const held = [];
		const platform = { ...mockPlatform(), send() { return 1; } };
		for (const arrivals of [1000, 20000]) {
			const { handler, open } = gated();
			const path = 'flood/flat' + arrivals;
			api.__register(path, handler);
			let sockets = Array.from({ length: Math.ceil(arrivals / 10) }, (_, i) => mockWs({ id: 'u' + i }));
			gc();
			const before = process.memoryUsage().heapUsed;
			for (let i = 0; i < arrivals; i++) api.handleRpc(sockets[i % sockets.length], text(path, 'c' + i, [payload]), platform);
			await settle();
			sockets = null;
			gc();
			held.push(process.memoryUsage().heapUsed - before);
			open();
			await settle();
			await settle();
		}
		expect(held[1] - held[0]).toBeLessThan(8 * 1024 * 1024);
	});

	it('bounds the worker at globalConcurrent across routes', async () => {
		const { another, running, open } = gated();
		for (let r = 0; r < 5; r++) api.__register('flood/r' + r, another());
		const platform = mockPlatform();
		const sockets = Array.from({ length: 400 }, (_, i) => mockWs({ id: 'u' + i }));
		for (let i = 0; i < 2000; i++) api.handleRpc(sockets[i % 400], text('flood/r' + (i % 5), 'c' + i), platform);
		await settle();
		expect(running.size).toBe(1024);
		const refused = [...replies(platform).values()];
		expect(refused).toHaveLength(2000 - 1024 - 256);
		expect(refused.every(r => r.reason === 'queue_full' && r.scope === 'global')).toBe(true);
		open();
		await settle();
		await settle();
		expect(replies(platform).size).toBe(2000);
	});
});

describe('scope order and the disabled queue', () => {
	it('names the connection, then the route, then the global scope as the limit', async () => {
		api.configureRpc({ perConnectionConcurrent: 2, perRouteConcurrent: 3, globalConcurrent: 4, maxQueue: 0 });
		const { handler, another, open } = gated();
		api.__register('order/a', handler);
		api.__register('order/b', another());
		const platform = mockPlatform();
		const one = mockWs({ id: 'one' });
		const two = mockWs({ id: 'two' });
		const three = mockWs({ id: 'three' });
		api.handleRpc(one, text('order/a', '1'), platform);
		api.handleRpc(one, text('order/a', '2'), platform);
		// The connection is full first, although the route still has room.
		api.handleRpc(one, text('order/a', '3'), platform);
		api.handleRpc(two, text('order/a', '4'), platform);
		// Route a is full (3), the connection two has room.
		api.handleRpc(two, text('order/a', '5'), platform);
		api.handleRpc(three, text('order/b', '6'), platform);
		// Route b has room, but the worker holds 4.
		api.handleRpc(three, text('order/b', '7'), platform);
		await settle();
		const got = replies(platform);
		expect(got.get('3')).toMatchObject({ code: 'OVERLOADED', reason: 'concurrency_limit', scope: 'connection', error: 'Too many concurrent calls' });
		expect(got.get('5')).toMatchObject({ code: 'OVERLOADED', reason: 'concurrency_limit', scope: 'route' });
		expect(got.get('7')).toMatchObject({ code: 'OVERLOADED', reason: 'concurrency_limit', scope: 'global' });
		expect(got.size).toBe(3);
		open();
		await settle();
		await settle();
		expect(replies(platform).size).toBe(7);
	});

	it('a refused call takes nothing: the next call still fits', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		const { handler, open } = gated();
		api.__register('order/one', handler);
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('order/one', 'a'), platform);
		for (let i = 0; i < 10; i++) api.handleRpc(ws, text('order/one', 'r' + i), platform);
		await settle();
		expect(admission._rpcAdmissionSnapshot().active).toBe(1);
		open();
		await settle();
		await settle();
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
		api.__register('order/one', api.live(async () => 'again'));
		api.handleRpc(ws, text('order/one', 'b'), platform);
		await settle();
		expect(replies(platform).get('b')).toMatchObject({ ok: true, data: 'again' });
	});

	it('starts a queued call when a permit comes back', async () => {
		api.configureRpc({ perConnectionConcurrent: 1 });
		const { handler, running, open } = gated();
		api.__register('order/queue', handler);
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('order/queue', 'a'), platform);
		api.handleRpc(ws, text('order/queue', 'b'), platform);
		await settle();
		expect(running.size).toBe(1);
		expect(admission._rpcAdmissionSnapshot().queued).toBe(1);
		open();
		await settle();
		await settle();
		expect(replies(platform).get('b')).toMatchObject({ ok: true });
	});
});

describe('route options', () => {
	it('a route perRouteConcurrent overrides the default', async () => {
		api.configureRpc({ maxQueue: 0 });
		let open;
		const gate = new Promise(resolve => { open = resolve; });
		api.__register('route/narrow', api.live(async () => { await gate; return 1; }, { perRouteConcurrent: 2 }));
		const platform = mockPlatform();
		for (let i = 0; i < 4; i++) api.handleRpc(mockWs({ id: 'u' + i }), text('route/narrow', 'n' + i), platform);
		await settle();
		const got = replies(platform);
		expect(got.size).toBe(2);
		expect(got.get('n2')).toMatchObject({ code: 'OVERLOADED', scope: 'route' });
		open();
		await settle();
		await settle();
	});

	it('one function registered under two paths is one route', async () => {
		api.configureRpc({ maxQueue: 0 });
		let open;
		const gate = new Promise(resolve => { open = resolve; });
		const shared = api.live(async () => { await gate; return 1; }, { perRouteConcurrent: 1 });
		api.__register('route/first', shared);
		api.__register('route/second', shared);
		const platform = mockPlatform();
		api.handleRpc(mockWs({ id: 'a' }), text('route/first', 'f'), platform);
		api.handleRpc(mockWs({ id: 'b' }), text('route/second', 's'), platform);
		await settle();
		expect(replies(platform).get('s')).toMatchObject({ code: 'OVERLOADED', scope: 'route' });
		open();
		await settle();
	});

	it('reads a route option through a wrapper', async () => {
		api.configureRpc({ maxQueue: 0 });
		let open;
		const gate = new Promise(resolve => { open = resolve; });
		const inner = api.live(async () => { await gate; return 1; }, { perRouteConcurrent: 1 });
		api.__register('route/wrapped', api.live.rateLimit({ points: 100, window: 1000 }, inner));
		const platform = mockPlatform();
		api.handleRpc(mockWs({ id: 'a' }), text('route/wrapped', 'w1'), platform);
		api.handleRpc(mockWs({ id: 'b' }), text('route/wrapped', 'w2'), platform);
		await settle();
		expect(replies(platform).get('w2')).toMatchObject({ code: 'OVERLOADED', scope: 'route' });
		open();
		await settle();
	});

	it('perRouteConcurrent 0 lifts the route bound', async () => {
		api.configureRpc({ perRouteConcurrent: 1, maxQueue: 0 });
		let open;
		const gate = new Promise(resolve => { open = resolve; });
		api.__register('route/open', api.live(async () => { await gate; return 1; }, { perRouteConcurrent: 0 }));
		const platform = mockPlatform();
		for (let i = 0; i < 5; i++) api.handleRpc(mockWs({ id: 'u' + i }), text('route/open', 'o' + i), platform);
		await settle();
		expect(replies(platform).size).toBe(0);
		expect(admission._rpcAdmissionSnapshot().active).toBe(5);
		open();
		await settle();
	});

	it('rejects a bad route option at declaration', () => {
		expect(() => api.live(async () => 1, { perRouteConcurrent: -1 })).toThrow(/perRouteConcurrent must be a non-negative integer/);
		expect(() => api.live(async () => 1, { perRouteConcurrent: 1.5 })).toThrow(/perRouteConcurrent/);
		expect(() => api.live.stream('t', async () => [], { perRouteConcurrent: Infinity })).toThrow(/perRouteConcurrent/);
		expect(() => api.live.binary(async () => 1, { perRouteConcurrent: NaN })).toThrow(/perRouteConcurrent/);
	});
});

describe('option validation', () => {
	it('fails loudly on a bad value at startup', () => {
		for (const bad of [-1, 1.5, Infinity, NaN, '8', null]) {
			expect(() => api.realtime({ rpc: { perConnectionConcurrent: bad } })).toThrow(/rpc\.perConnectionConcurrent must be a non-negative integer/);
		}
		expect(() => api.realtime({ rpc: { globalConcurrent: -5 } })).toThrow(/rpc\.globalConcurrent/);
		expect(() => api.realtime({ rpc: { maxQueue: Infinity } })).toThrow(/rpc\.maxQueue/);
		expect(() => api.realtime({ rpc: { timeout: 2147483648 } })).toThrow(/rpc\.timeout must be a non-negative integer up to 2147483647/);
		expect(() => api.realtime({ rpc: { perRouteLimit: 4 } })).toThrow(/unsupported field: perRouteLimit/);
		expect(() => api.realtime({ rpc: 'fast' })).toThrow(/must be an object/);
	});

	it('takes defaults for omitted keys and 0 to disable a limit', () => {
		api.realtime({ rpc: { globalConcurrent: 0 } });
		expect(admission._rpcAdmissionSnapshot().config).toEqual({ perConnectionConcurrent: 32, perConnectionQueue: 32, perRouteConcurrent: 256, globalConcurrent: 0, maxQueue: 256, timeout: 30000 });
		api.configureRpc(null);
		expect(admission._rpcAdmissionSnapshot().config).toEqual(admission.RPC_ADMISSION_DEFAULTS);
	});
});

describe('deadline and abort signal', () => {
	it('fires ctx.abortSignal at the route timeout and keeps the permit until the handler settles', async () => {
		fakeTime();
		let seen;
		let finish;
		api.__register('deadline/slow', api.live(async (ctx) => {
			seen = ctx.abortSignal;
			await new Promise(resolve => { finish = resolve; });
			return seen.aborted;
		}, { timeout: 1000 }));
		const platform = mockPlatform();
		api.handleRpc(mockWs({ id: 'u' }), text('deadline/slow', 'd'), platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen).toBeInstanceOf(AbortSignal);
		expect(seen.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(999);
		expect(seen.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(251);
		expect(seen.aborted).toBe(true);
		expect(seen.reason).toMatchObject({ code: 'TIMEOUT' });
		// The handler ignores the signal: it still holds its own permit.
		expect(admission._rpcAdmissionSnapshot().active).toBe(1);
		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
		expect(replies(platform).get('d')).toMatchObject({ ok: true, data: true });
	});

	it('a handler that ignores its signal holds only its own permit', async () => {
		fakeTime();
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0, timeout: 500 });
		api.__register('deadline/stuck', api.live(() => new Promise(() => {})));
		api.__register('deadline/quick', api.live(async () => 'ok'));
		const platform = mockPlatform();
		const stuck = mockWs({ id: 'stuck' });
		api.handleRpc(stuck, text('deadline/stuck', 's'), platform);
		await vi.advanceTimersByTimeAsync(2000);
		// Its connection stays full past the deadline...
		api.handleRpc(stuck, text('deadline/quick', 's2'), platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(replies(platform).get('s2')).toMatchObject({ code: 'OVERLOADED', scope: 'connection' });
		// ...and nobody else is held up.
		api.handleRpc(mockWs({ id: 'other' }), text('deadline/quick', 'q'), platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(replies(platform).get('q')).toMatchObject({ ok: true, data: 'ok' });
	});

	it('fires the signal when the connection closes', async () => {
		let seen;
		let finish;
		api.__register('deadline/close', api.live(async (ctx) => {
			seen = ctx.abortSignal;
			await new Promise(resolve => { finish = resolve; });
			return 1;
		}));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('deadline/close', 'c'), platform);
		await settle();
		expect(seen.aborted).toBe(false);
		api.close(ws, { platform });
		expect(seen.aborted).toBe(true);
		expect(seen.reason).toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(admission._rpcAdmissionSnapshot().active).toBe(1);
		finish();
		await settle();
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	});

	it('drops a queued call whose deadline passes and answers it OVERLOADED', async () => {
		fakeTime();
		api.configureRpc({ perConnectionConcurrent: 1, timeout: 500 });
		let finish;
		api.__register('deadline/hold', api.live(() => new Promise(resolve => { finish = resolve; })));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('deadline/hold', 'first'), platform);
		api.handleRpc(ws, text('deadline/hold', 'waiting'), platform);
		await vi.advanceTimersByTimeAsync(0);
		expect(admission._rpcAdmissionSnapshot().queued).toBe(1);
		await vi.advanceTimersByTimeAsync(800);
		expect(replies(platform).get('waiting')).toMatchObject({ ok: false, code: 'OVERLOADED', reason: 'concurrency_limit', scope: 'connection', error: 'The call waited past its deadline' });
		expect(admission._rpcAdmissionSnapshot().queued).toBe(0);
		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	});

	it('drops a queued call when its connection closes', async () => {
		api.configureRpc({ perConnectionConcurrent: 1 });
		let finish;
		let ran = 0;
		api.__register('deadline/q', api.live(() => { ran++; return new Promise(resolve => { finish = resolve; }); }));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('deadline/q', 'a'), platform);
		api.handleRpc(ws, text('deadline/q', 'b'), platform);
		await settle();
		api.close(ws, { platform });
		expect(admission._rpcAdmissionSnapshot().queued).toBe(0);
		await settle();
		// Nobody can read the reply; it is not an admission refusal either.
		expect(replies(platform).get('b')).toMatchObject({ ok: false, code: 'CONNECTION_CLOSED' });
		finish();
		await settle();
		expect(ran).toBe(1);
	});

	it('gives work outside a wire call a signal that never fires', async () => {
		let seen;
		api.__register('deadline/direct', api.live(async (ctx) => { seen = ctx.abortSignal; return 1; }));
		await api.__directCall('deadline/direct', [], mockPlatform());
		expect(seen).toBeInstanceOf(AbortSignal);
		expect(seen.aborted).toBe(false);
	});

	it('timeout 0 gives calls no deadline', async () => {
		fakeTime();
		api.configureRpc({ timeout: 0 });
		let seen;
		api.__register('deadline/none', api.live(async (ctx) => { seen = ctx.abortSignal; await new Promise(() => {}); }));
		api.handleRpc(mockWs({ id: 'u' }), text('deadline/none', 'n'), mockPlatform());
		await vi.advanceTimersByTimeAsync(120000);
		expect(seen.aborted).toBe(false);
	});
});

describe('other call shapes', () => {
	it('a stream holds its permit only while it subscribes', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		api.__register('shape/feed', api.live.stream('shape-feed', async () => [{ id: 1 }]));
		api.__register('shape/after', api.live(async () => 'after'));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, toArrayBuffer({ rpc: 'shape/feed', id: 's', args: [], stream: true }), platform);
		await settle();
		await settle();
		expect(replies(platform).get('s')).toMatchObject({ ok: true });
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
		api.handleRpc(ws, text('shape/after', 'a'), platform);
		await settle();
		expect(replies(platform).get('a')).toMatchObject({ ok: true, data: 'after' });
	});

	it('a stream subscribe over the cap is refused with OVERLOADED', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		let finish;
		api.__register('shape/hold', api.live(() => new Promise(resolve => { finish = resolve; })));
		api.__register('shape/feed', api.live.stream('shape-feed2', async () => []));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('shape/hold', 'h'), platform);
		api.handleRpc(ws, toArrayBuffer({ rpc: 'shape/feed', id: 's', args: [], stream: true }), platform);
		await settle();
		expect(replies(platform).get('s')).toMatchObject({ ok: false, code: 'OVERLOADED', scope: 'connection' });
		finish();
		await settle();
	});

	it('sheds a fire-and-forget call silently and counts it', async () => {
		const counters = new Map();
		api.live.metrics({
			counter({ name }) { const rows = []; counters.set(name, rows); return { inc(labels) { rows.push(labels); } }; },
			histogram() { return { observe() {} }; },
			gauge() { return { inc() {}, dec() {}, set() {} }; }
		});
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		let finish;
		let runs = 0;
		api.__register('shape/move', api.live.volatile(() => { runs++; return new Promise(resolve => { finish = resolve; }); }));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, toArrayBuffer({ rpc: 'shape/move', args: [] }), platform);
		api.handleRpc(ws, toArrayBuffer({ rpc: 'shape/move', args: [] }), platform);
		await settle();
		expect(runs).toBe(1);
		expect(platform.sent.filter(row => row.topic === '__rpc')).toHaveLength(0);
		expect(counters.get('svelte_realtime_rpc_errors_total')).toEqual([{ path: 'shape/move', code: 'OVERLOADED' }]);
		expect(counters.get('svelte_realtime_rpc_overloaded_total')).toEqual([{ path: 'shape/move', reason: 'concurrency_limit', scope: 'connection' }]);
		finish();
		await settle();
	});

	it('admits binary calls and answers a refused one OVERLOADED', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		let finish;
		api.__register('shape/bin', api.live.binary(() => new Promise(resolve => { finish = resolve; })));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		const frame = (id) => {
			const header = new TextEncoder().encode(JSON.stringify({ rpc: 'shape/bin', id }));
			const bytes = new Uint8Array(3 + header.length + 4);
			new DataView(bytes.buffer).setUint16(1, header.length);
			bytes.set(header, 3);
			return bytes.buffer;
		};
		api.handleRpc(ws, frame('b1'), platform);
		api.handleRpc(ws, frame('b2'), platform);
		await settle();
		expect(replies(platform).get('b2')).toMatchObject({ ok: false, code: 'OVERLOADED', reason: 'concurrency_limit', scope: 'connection' });
		finish('x');
		await settle();
		expect(replies(platform).get('b1')).toMatchObject({ ok: true });
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	});

	it('does not count uploads against RPC admission', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		api.__register('shape/upload', api.live.upload(async () => { await gate; return 'ok'; }));
		api.__register('shape/ping', api.live(async () => 'pong'));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		const json = new TextEncoder().encode(JSON.stringify({ rpc: 'shape/upload', args: [] }));
		const open = new ArrayBuffer(12 + json.length);
		const view = new DataView(open);
		view.setUint8(0, 0x01);
		view.setUint8(1, 0x01);
		view.setUint32(2, 5, false);
		view.setUint32(6, 0, false);
		view.setUint16(10, json.length, false);
		new Uint8Array(open).set(json, 12);
		api.handleRpc(ws, open, platform);
		await settle();
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
		api.handleRpc(ws, text('shape/ping', 'p'), platform);
		await settle();
		expect(replies(platform).get('p')).toMatchObject({ ok: true, data: 'pong' });
		release();
	});

	it('releases the permit of a handler a middleware answered early once the handler settles', async () => {
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
		let finish;
		api.live.middleware(async (_ctx, next) => {
			const run = next();
			run.catch(() => {});
			return { ok: false, code: 'TIMEOUT', error: 'answered early' };
		});
		api.__register('shape/mw', api.live(() => new Promise(resolve => { finish = resolve; })));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		api.handleRpc(ws, text('shape/mw', 'm1'), platform);
		await settle();
		expect(replies(platform).get('m1')).toMatchObject({ code: 'TIMEOUT' });
		expect(admission._rpcAdmissionSnapshot().active).toBe(1);
		finish();
		await settle();
		expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	});
});

describe('metrics', () => {
	it('samples in-flight and queued gauges per route', async () => {
		fakeTime();
		const gauges = new Map();
		api.live.metrics({
			counter() { return { inc() {} }; },
			histogram() { return { observe() {} }; },
			gauge({ name }) { const rows = []; gauges.set(name, rows); return { inc() {}, dec() {}, set(labels, value) { rows.push([labels?.path, value]); } }; }
		});
		api.configureRpc({ perConnectionConcurrent: 2 });
		const { handler, open } = gated();
		api.__register('gauge/slow', handler);
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		for (let i = 0; i < 5; i++) api.handleRpc(ws, text('gauge/slow', 'g' + i), platform);
		await vi.advanceTimersByTimeAsync(0);
		// Calls move counters only; the sampler writes them.
		expect(gauges.get('svelte_realtime_rpc_inflight').some(([path]) => path === 'gauge/slow')).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(gauges.get('svelte_realtime_rpc_inflight').at(-1)).toEqual(['gauge/slow', 2]);
		expect(gauges.get('svelte_realtime_rpc_queued').at(-1)).toEqual(['gauge/slow', 3]);
		const writes = gauges.get('svelte_realtime_rpc_inflight').length;
		await vi.advanceTimersByTimeAsync(1000);
		// Unchanged counts are not written again.
		expect(gauges.get('svelte_realtime_rpc_inflight')).toHaveLength(writes);
		open();
		await vi.advanceTimersByTimeAsync(1000);
		expect(gauges.get('svelte_realtime_rpc_inflight').at(-1)).toEqual(['gauge/slow', 0]);
		expect(gauges.get('svelte_realtime_rpc_queued').at(-1)).toEqual(['gauge/slow', 0]);
	});

	it('counts a refusal as an OVERLOADED error and by reason and scope', async () => {
		const counters = new Map();
		api.live.metrics({
			counter({ name }) { const rows = []; counters.set(name, rows); return { inc(labels) { rows.push(labels); } }; },
			histogram() { return { observe() {} }; },
			gauge() { return { inc() {}, dec() {}, set() {} }; }
		});
		api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 1 });
		const { handler, open } = gated();
		api.__register('gauge/full', handler);
		const platform = mockPlatform();
		const ws = mockWs({ id: 'u' });
		for (let i = 0; i < 3; i++) api.handleRpc(ws, text('gauge/full', 'f' + i), platform);
		await settle();
		expect(counters.get('svelte_realtime_rpc_errors_total')).toEqual([{ path: 'gauge/full', code: 'OVERLOADED' }]);
		expect(counters.get('svelte_realtime_rpc_overloaded_total')).toEqual([{ path: 'gauge/full', reason: 'queue_full', scope: 'global' }]);
		for (const rows of counters.values()) for (const labels of rows) for (const value of Object.values(labels || {})) expect(value).not.toBe('');
		open();
		await settle();
		await settle();
	});
});
