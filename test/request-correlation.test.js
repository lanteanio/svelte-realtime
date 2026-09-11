import { describe, expect, it, vi } from 'vitest';
import { __register, handleRpc, LiveError } from '../src/server.js';
import { createTestContext } from '../src/testing.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

describe('per-operation request correlation', () => {
	it('mirrors the operation-scoped platform in createTestContext', () => {
		const platform = { requestId: 'connection-test', send() {} };
		const ctx = createTestContext({
			ws: {},
			platform,
			connectionId: 'connection-test',
			requestId: 'operation-test'
		});

		expect(ctx.connectionId).toBe('connection-test');
		expect(ctx.requestId).toBe('operation-test');
		expect(ctx.platform.connectionId).toBe('connection-test');
		expect(ctx.platform.requestId).toBe('operation-test');
		expect(Object.getPrototypeOf(ctx.platform)).toBe(platform);
	});

	it('separates concurrent RPC ids while preserving one connection id', async () => {
		const platform = mockPlatform();
		platform.requestId = 'connection-42';
		const ws = mockWs({ id: 'user-1' });
		const seen = [];
		let release;
		let markBothStarted;
		const gate = new Promise((resolve) => { release = resolve; });
		const bothStarted = new Promise((resolve) => { markBothStarted = resolve; });

		__register('correlation/overlap', async (ctx) => {
			seen.push({
				connectionId: ctx.connectionId,
				requestId: ctx.requestId,
				platformConnectionId: ctx.platform.connectionId,
				platformRequestId: ctx.platform.requestId,
				inheritsSend: ctx.platform.send === platform.send
			});
			if (seen.length === 2) markBothStarted();
			await gate;
			return ctx.requestId;
		});

		handleRpc(ws, toArrayBuffer({ rpc: 'correlation/overlap', id: 'rpc-a', args: [] }), platform);
		handleRpc(ws, toArrayBuffer({ rpc: 'correlation/overlap', id: 'rpc-b', args: [] }), platform);
		await bothStarted;

		expect(seen.sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual([
			{ connectionId: 'connection-42', requestId: 'rpc-a', platformConnectionId: 'connection-42', platformRequestId: 'rpc-a', inheritsSend: true },
			{ connectionId: 'connection-42', requestId: 'rpc-b', platformConnectionId: 'connection-42', platformRequestId: 'rpc-b', inheritsSend: true }
		]);
		release();
		await vi.waitFor(() => expect(platform.sent).toHaveLength(2));
	});

	it('echoes the operation id on a LiveError response', async () => {
		const platform = mockPlatform();
		platform.requestId = 'connection-errors';
		const ws = mockWs();
		__register('correlation/fail', () => {
			throw new LiveError('EXPECTED', 'Nope');
		});

		handleRpc(ws, toArrayBuffer({ rpc: 'correlation/fail', id: 'rpc-failed', args: [] }), platform);
		await vi.waitFor(() => expect(platform.sent).toHaveLength(1));

		expect(platform.sent[0].data).toEqual({
			id: 'rpc-failed',
			ok: false,
			code: 'EXPECTED',
			error: 'Nope',
			requestId: 'rpc-failed'
		});
	});

	it('replaces an unbounded envelope id and echoes the same safe id on failure', async () => {
		const platform = mockPlatform();
		const ws = mockWs();
		let handlerRequestId;
		__register('correlation/bounded', (ctx) => {
			handlerRequestId = ctx.requestId;
			throw new LiveError('EXPECTED', 'Nope');
		});

		const oversizedId = 'x'.repeat(129);
		handleRpc(ws, toArrayBuffer({ rpc: 'correlation/bounded', id: oversizedId, args: [] }), platform);
		await vi.waitFor(() => expect(platform.sent).toHaveLength(1));

		expect(handlerRequestId).toMatch(/^[!-~]{1,128}$/);
		expect(handlerRequestId).not.toBe(oversizedId);
		expect(platform.sent[0].data.requestId).toBe(handlerRequestId);
	});

	it('echoes each failed batch operation id independently', async () => {
		const platform = mockPlatform();
		const ws = mockWs();
		__register('correlation/batch-fail', () => { throw new LiveError('EXPECTED', 'Nope'); });

		handleRpc(ws, toArrayBuffer({
			batch: [
				{ rpc: 'correlation/batch-fail', id: 'batch-a', args: [] },
				{ rpc: 'correlation/batch-fail', id: 'batch-b', args: [] }
			]
		}), platform);
		await vi.waitFor(() => expect(platform.sent).toHaveLength(1));

		expect(platform.sent[0].data.batch.map((item) => item.requestId)).toEqual(['batch-a', 'batch-b']);
	});
});
