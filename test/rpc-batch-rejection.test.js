import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';
import { MAX_RPC_BATCH_CALLS } from '../src/shared/rpc-limits.js';

let api, admission, lifecycle, state, server, socket, release;
beforeEach(async () => {
	vi.resetModules();
	api = await import('../src/server.js');
	admission = await import('../src/server/rpc-admission.js');
	lifecycle = await import('../src/server/lifecycle.js');
	({ state } = await import('../src/server/state.js'));
});
afterEach(async () => {
	release?.();
	release = null;
	socket?.close();
	socket = null;
	await server?.close();
	server = null;
	vi.restoreAllMocks();
	admission._resetRpcAdmission();
	lifecycle._resetLifecycle();
});

it.each([51, 85000])('rejects %i entries with one fixed-size response and no element reads', async count => {
	const frame = toArrayBuffer({ batch: Array.from({ length: count }, () => ({ id: 'x' })) });
	if (count === 85000) expect(frame.byteLength).toBeGreaterThan(900000);
	expect(frame.byteLength).toBeLessThan(1024 * 1024);
	const parse = JSON.parse;
	let reads = 0;
	vi.spyOn(JSON, 'parse').mockImplementation(text => {
		const value = parse(text);
		if (Array.isArray(value.batch)) value.batch = new Proxy(value.batch, {
			get(target, key, receiver) {
				if (key !== 'length') reads++;
				return Reflect.get(target, key, receiver);
			}
		});
		return value;
	});
	const platform = mockPlatform();
	const beforeExecute = vi.fn();
	expect(api.handleRpc(mockWs(), frame, platform, { beforeExecute })).toBe(true);
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	expect(reads).toBe(0);
	expect(beforeExecute).toHaveBeenCalledTimes(1);
	expect(beforeExecute.mock.calls[0].slice(1)).toEqual(['__batch__', []]);
	expect(platform.sent[0].data).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
	expect(platform.sent[0].data.batch).toBeUndefined();
	expect(JSON.stringify(platform.sent[0]).length).toBeLessThan(512);
});

it('charges oversized rejection to connection admission before running the hook', async () => {
	api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
	const held = new Promise(resolve => { release = resolve; });
	const beforeExecute = vi.fn(() => held);
	const platform = mockPlatform();
	const ws = mockWs();
	const frame = toArrayBuffer({ batch: Array.from({ length: 51 }, () => ({ id: 'x' })) });
	api.handleRpc(ws, frame, platform, { beforeExecute });
	await vi.waitFor(() => expect(beforeExecute).toHaveBeenCalledTimes(1));
	api.handleRpc(ws, frame, platform, { beforeExecute });
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	expect(platform.sent[0].data.code).toBe('OVERLOADED');
	expect(beforeExecute).toHaveBeenCalledTimes(1);
	release();
	await vi.waitFor(() => expect(platform.sent).toHaveLength(2));
	expect(platform.sent[1].data.code).toBe('INVALID_REQUEST');
	expect(admission._rpcAdmissionSnapshot().active).toBe(0);
});

it('preserves all correlation IDs in a valid maximum-size batch', async () => {
	api.configureRpc({ perConnectionConcurrent: 0 });
	api.__register('limits/echo', api.live((ctx, value) => value));
	const platform = mockPlatform();
	const batch = Array.from({ length: MAX_RPC_BATCH_CALLS }, (_, index) => ({ rpc: 'limits/echo', id: 'call-' + index, args: [index] }));
	api.handleRpc(mockWs(), toArrayBuffer({ batch }), platform);
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	expect(platform.sent[0].data.batch.map(result => ({ id: result.id, ok: result.ok, data: result.data })))
		.toEqual(batch.map((call, index) => ({ id: call.id, ok: true, data: index })));
});

it('preserves a rate refusal and releases its admission place', async () => {
	api.configureRpc({ perConnectionConcurrent: 1, maxQueue: 0 });
	const platform = mockPlatform();
	const ws = mockWs();
	const beforeExecute = vi.fn(() => { throw new api.LiveError('RATE_LIMITED', 'Wait'); });
	api.handleRpc(ws, toArrayBuffer({ batch: Array.from({ length: 51 }, () => ({ id: 'x' })) }), platform, { beforeExecute });
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	expect(platform.sent[0].data).toMatchObject({ ok: false, code: 'RATE_LIMITED', error: 'Wait' });
	expect(admission._rpcAdmissionSnapshot().active).toBe(0);
	api.__register('limits/after', api.live(() => 'ok'));
	api.handleRpc(ws, toArrayBuffer({ rpc: 'limits/after', id: 'after' }), platform);
	await vi.waitFor(() => expect(platform.sent).toHaveLength(2));
	expect(platform.sent[1].data).toMatchObject({ ok: true, data: 'ok' });
});

it('applies the protocol gate before oversized-batch admission', async () => {
	state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
	const platform = mockPlatform();
	const beforeExecute = vi.fn();
	api.handleRpc(mockWs(), toArrayBuffer({ batch: new Array(51).fill(null) }), platform, { beforeExecute });
	await vi.waitFor(() => expect(platform.sent.find(frame => frame.event === '__batch')).toBeTruthy());
	expect(platform.sent.find(frame => frame.event === '__batch').data.code).toBe('PROTOCOL_MISMATCH');
	expect(beforeExecute).not.toHaveBeenCalled();
	expect(admission._rpcAdmissionSnapshot().active).toBe(0);
});

it('drains an admitted envelope hook while rejecting later work at shutdown', async () => {
	const held = new Promise(resolve => { release = resolve; });
	const beforeExecute = vi.fn(() => held);
	const platform = mockPlatform();
	const ws = mockWs();
	const frame = toArrayBuffer({ batch: new Array(51).fill(null) });
	api.handleRpc(ws, frame, platform, { beforeExecute });
	await vi.waitFor(() => expect(beforeExecute).toHaveBeenCalledTimes(1));
	const drain = lifecycle._runShutdown({ platform });
	expect(lifecycle.inFlightCount()).toBe(1);
	api.handleRpc(ws, frame, platform, { beforeExecute });
	expect(platform.sent[0].data.code).toBe('UNAVAILABLE');
	expect(beforeExecute).toHaveBeenCalledTimes(1);
	release();
	expect((await drain).drained).toBe(true);
	expect(lifecycle.inFlightCount()).toBe(0);
	expect(admission._rpcAdmissionSnapshot().active).toBe(0);
});

it('removes a queued oversized envelope when its connection closes', async () => {
	api.configureRpc({ perConnectionConcurrent: 1, perConnectionQueue: 1, maxQueue: 1 });
	const held = new Promise(resolve => { release = resolve; });
	const beforeExecute = vi.fn(() => held);
	const platform = mockPlatform();
	const ws = mockWs();
	const frame = toArrayBuffer({ batch: new Array(51).fill(null) });
	api.handleRpc(ws, frame, platform, { beforeExecute });
	api.handleRpc(ws, frame, platform, { beforeExecute });
	expect(admission._rpcAdmissionSnapshot().queued).toBe(1);
	api.close(ws, { platform });
	await vi.waitFor(() => expect(platform.sent.some(row => row.data.code === 'CONNECTION_CLOSED')).toBe(true));
	expect(beforeExecute).toHaveBeenCalledTimes(1);
	expect(admission._rpcAdmissionSnapshot().queued).toBe(0);
	release();
	await vi.waitFor(() => expect(admission._rpcAdmissionSnapshot().active).toBe(0));
});

it('contains a throwing error observer and hides an ordinary hook error', async () => {
	const platform = mockPlatform();
	const onError = vi.fn(() => { throw new Error('Observer failed'); });
	api.handleRpc(mockWs(), toArrayBuffer({ batch: new Array(51).fill(null) }), platform, {
		beforeExecute() { throw new Error('PRIVATE'); }, onError
	});
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	expect(platform.sent[0].data).toMatchObject({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
	expect(JSON.stringify(platform.sent)).not.toContain('PRIVATE');
	expect(onError).toHaveBeenCalledTimes(1);
	expect(admission._rpcAdmissionSnapshot().active).toBe(0);
});

it('sends a bounded denial for a near-limit payload over a native socket', async () => {
	server = await createTestServer({ maxPayloadLength: 1024 * 1024, handler: {
		message(ws, ctx) { if (!ctx.isBinary && ctx.msg === undefined) api.handleRpc(ws, ctx.data, server.platform); },
		close: api.close
	} });
	socket = new WebSocket(server.wsUrl);
	const received = [];
	socket.addEventListener('message', event => {
		const frame = JSON.parse(String(event.data));
		if (frame.topic === '__rpc' && frame.event === '__batch') received.push(String(event.data));
	});
	await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.OPEN));
	socket.send(JSON.stringify({ batch: Array.from({ length: 85000 }, () => ({ id: 'x' })) }));
	await vi.waitFor(() => expect(received).toHaveLength(1));
	expect(received[0].length).toBeLessThan(512);
	expect(JSON.parse(received[0]).data.code).toBe('INVALID_REQUEST');
});
