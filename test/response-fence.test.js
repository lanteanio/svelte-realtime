import { expect, it } from 'vitest';
import { live, handleRpc, __register, __directCall } from '../src/server.js';
import { _setResponseFence } from '../src/server/response-fence.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

let sequence = 0;
async function response(platform, event) {
	for (let i = 0; i < 100; i++) {
		const result = platform.sent.find(message => message.event === event);
		if (result) return result.data;
		await new Promise(resolve => setTimeout(resolve, 1));
	}
	throw Error('RPC response did not arrive');
}

it.each(['single', 'parallel', 'sequential'])('rejects invalidated response state at the actual %s send', async mode => {
	const path = 'fenced-response-' + ++sequence + '/read', platform = mockPlatform(), ws = mockWs({ id: 'user' });
	let current = true;
	__register(path, live(ctx => {
		_setResponseFence(ctx, () => current, { code: 'UNAVAILABLE', error: 'State changed; retry' });
		queueMicrotask(() => { current = false; });
		return { value: 'obsolete' };
	}), path);
	const call = { rpc: path, id: 'fenced', args: [] };
	const message = mode === 'single' ? call : { batch: [call], sequential: mode === 'sequential' };
	handleRpc(ws, new TextEncoder().encode(JSON.stringify(message)).buffer, platform);
	const answer = await response(platform, mode === 'single' ? 'fenced' : '__batch');
	const result = mode === 'single' ? answer : answer.batch[0];
	expect(result).toMatchObject({ id: 'fenced', ok: false, code: 'UNAVAILABLE', error: 'State changed; retry', requestId: 'fenced' });
	expect(result).not.toHaveProperty('data');
});

it('checks an earlier result again after a later sequential call changes its state', async () => {
	const path = 'fenced-sequence-' + ++sequence, platform = mockPlatform(), ws = mockWs({ id: 'user' });
	let generation = 0;
	__register(path + '/read', live(ctx => {
		const captured = generation;
		_setResponseFence(ctx, () => generation === captured);
		_setResponseFence(ctx, () => true);
		return 1;
	}), path);
	__register(path + '/change', live(() => { generation++; return 2; }), path);
	handleRpc(ws, new TextEncoder().encode(JSON.stringify({ batch: [
		{ rpc: path + '/read', id: 'read', args: [] }, { rpc: path + '/change', id: 'change', args: [] }
	], sequential: true })).buffer, platform);
	const answer = await response(platform, '__batch');
	expect(answer.batch[0]).toMatchObject({ id: 'read', ok: false, code: 'UNAVAILABLE' });
	expect(answer.batch[0]).not.toHaveProperty('data');
	expect(answer.batch[1]).toMatchObject({ id: 'change', ok: true, data: 2 });
});

it('leaves direct loaders without an execution context usable', () => {
	expect(() => _setResponseFence(undefined, () => false)).not.toThrow();
	expect(() => _setResponseFence(null, () => false)).not.toThrow();
});

it('preserves a response condition through binary RPC dispatch', async () => {
	const path = 'fenced-binary-' + ++sequence + '/read', platform = mockPlatform(), ws = mockWs({ id: 'user' });
	let current = true;
	__register(path, live.binary(ctx => {
		_setResponseFence(ctx, () => current);
		queueMicrotask(() => { current = false; });
		return { value: 'obsolete' };
	}), path);
	const header = new TextEncoder().encode(JSON.stringify({ rpc: path, id: 'binary-fence' }));
	const frame = new Uint8Array(3 + header.length);
	frame[1] = header.length >> 8; frame[2] = header.length & 255; frame.set(header, 3);
	handleRpc(ws, frame.buffer, platform);
	const answer = await response(platform, 'binary-fence');
	expect(answer).toMatchObject({ ok: false, code: 'UNAVAILABLE', requestId: 'binary-fence' });
	expect(answer).not.toHaveProperty('data');
});

it('checks primitive direct-call results after asynchronous completion and honors fallback', async () => {
	const path = 'fenced-direct-' + ++sequence + '/read', platform = mockPlatform();
	__register(path, live(ctx => {
		let current = true;
		_setResponseFence(ctx, () => current);
		queueMicrotask(() => { current = false; });
		return 1;
	}), path);
	await expect(__directCall(path, [], platform)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
	expect(await __directCall(path, [], platform, { fallback: 0 })).toBe(0);
});

it.each(['single', 'batch', 'binary'])('keeps the sanitized operation id on a late %s failure', async mode => {
	const path = 'fenced-correlation-' + ++sequence + '/read', platform = mockPlatform(), ws = mockWs({ id: 'user' });
	const id = 'correlation-'.repeat(30);
	let expected;
	const handler = ctx => { expected = ctx.requestId; _setResponseFence(ctx, () => false); return 1; };
	__register(path, mode === 'binary' ? live.binary(handler) : live(handler), path);
	const call = { rpc: path, id, args: [] };
	let buffer;
	if (mode === 'binary') {
		const header = new TextEncoder().encode(JSON.stringify(call));
		const frame = new Uint8Array(3 + header.length);
		frame[1] = header.length >> 8; frame[2] = header.length & 255; frame.set(header, 3); buffer = frame.buffer;
	} else buffer = new TextEncoder().encode(JSON.stringify(mode === 'batch' ? { batch: [call] } : call)).buffer;
	handleRpc(ws, buffer, platform);
	const answer = await response(platform, mode === 'batch' ? '__batch' : id);
	const result = mode === 'batch' ? answer.batch[0] : answer;
	expect(expected).not.toBe(id);
	expect(result.requestId).toBe(expected);
});
