import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	onShutdown,
	_runShutdown,
	_resetLifecycle,
	_isShuttingDown,
	_enterInFlight,
	_exitInFlight,
	inFlightCount
} from '../src/server/lifecycle.js';
import { __register, handleRpc, _clearCron, realtime, live } from '../src/server.js';
import { _ensureCronInterval, _cronTimerActive } from '../src/server/cron-engine.js';
import { _handleUploadChunkFrame } from '../src/server/upload.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

// RPC responses are written on the dispatch microtask; a macrotask flush is the
// simplest deterministic "let the in-flight handler settle" the tests can use.
const flush = () => new Promise((r) => setTimeout(r, 0));

function callRpc(ws, platform, rpc, id, args) {
	return handleRpc(ws, toArrayBuffer({ rpc, id, args: args || [] }), platform);
}

// Build a chunk-0 upload frame: byte0 = _UPLOAD_FRAME_CHUNK (0x01), byte1 flags
// (HAS_ARGS | IS_LAST = 0x03), streamId @2 (u32 BE), seq @6 (u32 BE) = 0,
// argsLen @10 (u16 BE), the args JSON, then the (empty here) payload.
function uploadChunk0Frame(streamId, argsObj) {
	const argsJson = new TextEncoder().encode(JSON.stringify(argsObj));
	const buf = new ArrayBuffer(12 + argsJson.length);
	const view = new DataView(buf);
	view.setUint8(0, 0x01);
	view.setUint8(1, 0x03);
	view.setUint32(2, streamId, false);
	view.setUint32(6, 0, false);
	view.setUint16(10, argsJson.length, false);
	new Uint8Array(buf).set(argsJson, 12);
	return buf;
}

describe('graceful shutdown - onShutdown + in-flight drain + reject-new', () => {
	afterEach(() => {
		_resetLifecycle();
		_clearCron();
		vi.restoreAllMocks();
	});

	it('onShutdown validates its arguments', () => {
		expect(() => onShutdown(123)).toThrow(/handler must be a function/);
		expect(() => onShutdown(() => {}, null)).toThrow(/options must be an object/);
		expect(() => onShutdown(() => {}, { drainMs: -1 })).toThrow(/non-negative/);
		expect(() => onShutdown(() => {}, { drainMs: 'soon' })).toThrow(/non-negative/);
		expect(() => onShutdown(() => {}, { drainMs: Infinity })).toThrow(/non-negative/);
		expect(() => onShutdown(() => {})).not.toThrow();
		expect(() => onShutdown(() => {}, {})).not.toThrow();
	});

	it('runs registered handlers in order with the { platform } ctx', async () => {
		const platform = mockPlatform();
		const order = [];
		onShutdown((ctx) => { order.push(['a', ctx.platform]); });
		onShutdown(async (ctx) => { order.push(['b', ctx.platform]); });
		await _runShutdown({ platform });
		expect(order).toEqual([['a', platform], ['b', platform]]);
	});

	it('is idempotent - a second shutdown does not re-run handlers', async () => {
		let runs = 0;
		onShutdown(() => { runs++; });
		const p1 = _runShutdown({ platform: mockPlatform() });
		const p2 = _runShutdown({ platform: mockPlatform() });
		expect(p1).toBe(p2); // latched promise
		await p1;
		await _runShutdown({ platform: mockPlatform() });
		expect(runs).toBe(1);
	});

	it('a throwing handler is contained and does not abort the rest', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let secondRan = false;
		onShutdown(() => { throw new Error('boom'); });
		onShutdown(() => { secondRan = true; });
		await expect(_runShutdown({ platform: mockPlatform() })).resolves.toBeUndefined();
		expect(secondRan).toBe(true);
		expect(errSpy).toHaveBeenCalled();
	});

	it('an unregistered handler does not run', async () => {
		let ran = false;
		const off = onShutdown(() => { ran = true; });
		off();
		await _runShutdown({ platform: mockPlatform() });
		expect(ran).toBe(false);
	});

	it('rejects NEW rpc calls with UNAVAILABLE once shutdown has begun', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		__register('shutdown-test/echo', async (ctx, x) => x);

		// Before shutdown: normal success.
		expect(callRpc(ws, platform, 'shutdown-test/echo', 'r1', ['hi'])).toBe(true);
		await flush();
		const before = platform.sent.find((m) => m.event === 'r1');
		expect(before.data.ok).toBe(true);
		expect(before.data.data).toBe('hi');

		await _runShutdown({ platform });
		expect(_isShuttingDown()).toBe(true);

		// After shutdown: the funnel rejects before resolving the handler.
		callRpc(ws, platform, 'shutdown-test/echo', 'r2', ['hi']);
		await flush();
		const after = platform.sent.find((m) => m.event === 'r2');
		expect(after.data.ok).toBe(false);
		expect(after.data.code).toBe('UNAVAILABLE');
	});

	it('waits for an in-flight unit to settle before resolving', async () => {
		const platform = mockPlatform();
		_enterInFlight(); // simulate an RPC mid-handler
		expect(inFlightCount()).toBe(1);

		let resolved = false;
		const p = _runShutdown({ platform }).then(() => { resolved = true; });

		// Default budget is 5s, so while the unit is in-flight the drain must wait.
		await new Promise((r) => setTimeout(r, 60));
		expect(resolved).toBe(false);
		expect(inFlightCount()).toBe(1);

		_exitInFlight(); // the in-flight unit settles
		await p;
		expect(resolved).toBe(true);
	});

	it('caps the drain at drainMs even when work never settles', async () => {
		const platform = mockPlatform();
		let ran = false;
		onShutdown(() => { ran = true; }, { drainMs: 50 });
		_enterInFlight(); // never exits within the budget

		await _runShutdown({ platform }); // must resolve via the 50ms budget, not hang
		expect(ran).toBe(true);
		expect(inFlightCount()).toBe(1); // still in-flight; the budget elapsed
		_exitInFlight();
	});

	it('stops the cron scheduler so no new ticks fire during the drain', async () => {
		_ensureCronInterval();
		expect(_cronTimerActive()).toBe(true);
		await _runShutdown({ platform: mockPlatform() });
		expect(_cronTimerActive()).toBe(false);
	});

	it('realtime() exposes a shutdown hook that drives the drain', async () => {
		const hooks = realtime();
		expect(typeof hooks.shutdown).toBe('function');
		const out = hooks.shutdown({ platform: mockPlatform() });
		expect(out).toBeInstanceOf(Promise);
		await out;
		expect(_isShuttingDown()).toBe(true);
	});

	it('rejects a NEW upload (chunk 0) with UNAVAILABLE once shutdown has begun', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		await _runShutdown({ platform });
		// The gate rejects synchronously via _respondUpload before any handler resolution.
		_handleUploadChunkFrame(ws, uploadChunk0Frame(1, { rpc: 'files/upload', args: [] }), platform, {});
		const resp = platform.sent.find((m) => m.topic === '__upload');
		expect(resp).toBeTruthy();
		expect(resp.data.code).toBe('UNAVAILABLE');
	});

	// The upload handler holds the ONLY in-flight increment for its stream;
	// every exit path must give it back, or each upload permanently inflates
	// the count and every later drain burns its full budget.

	it('a completed upload returns the in-flight count to baseline', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		__register('shutdown-test/upload', live.upload(async (ctx) => {
			let bytes = 0;
			for await (const chunk of ctx.stream) bytes += chunk.byteLength;
			return { bytes };
		}));
		expect(inFlightCount()).toBe(0);
		_handleUploadChunkFrame(ws, uploadChunk0Frame(2, { rpc: 'shutdown-test/upload', args: [] }), platform, {});
		await flush();
		await flush();
		const resp = platform.sent.find((m) => m.topic === '__upload');
		expect(resp.data.ok).toBe(true);
		expect(inFlightCount()).toBe(0);
	});

	it('an upload that fails early (unknown rpc) returns the in-flight count to baseline', async () => {
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		expect(inFlightCount()).toBe(0);
		_handleUploadChunkFrame(ws, uploadChunk0Frame(3, { rpc: 'shutdown-test/missing', args: [] }), platform, {});
		await flush();
		const resp = platform.sent.find((m) => m.topic === '__upload');
		expect(resp.data.ok).toBe(false);
		expect(inFlightCount()).toBe(0);
	});
});
