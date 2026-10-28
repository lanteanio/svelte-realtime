import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv } from '../src/testing.js';
import { live, LiveError, __directCall, _prepareHmr } from '../src/server.js';
import { RpcError } from '../src/client/internal-state.js';

let env, peer;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const encoder = new TextEncoder();

beforeEach(() => {
	env = createTestEnv();
	peer = env.connect({ id: 'member' });
});
afterEach(() => { peer?.disconnect(); env?.cleanup(); _prepareHmr(); });

function uploadChunk(streamId, rpc) {
	const header = encoder.encode(JSON.stringify({ rpc, args: [] }));
	const frame = new Uint8Array(12 + header.length);
	frame[0] = 1;
	frame[1] = 3;
	new DataView(frame.buffer).setUint32(2, streamId, false);
	new DataView(frame.buffer).setUint32(6, 0, false);
	new DataView(frame.buffer).setUint16(10, header.length, false);
	frame.set(header, 12);
	return frame.buffer;
}

describe('retry error metadata', () => {
	it('exposes retryAfter on text and binary errors', async () => {
		env.register('limited', {
			text: live(() => { throw new LiveError('RATE_LIMITED', 'Slow down', { retryAfter: 125 }); }),
			binary: live.binary(() => { throw new LiveError('RATE_LIMITED', 'Slow down', { retryAfter: 250 }); })
		});
		await expect(peer.call('limited/text')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 125 });
		await expect(peer.binary('limited/binary', new Uint8Array())).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 250 });
	});

	it('preserves retryAfter in batch replies', async () => {
		env.register('limited', { text: live(() => { throw new LiveError('RATE_LIMITED', 'Slow down', { retryAfter: 375 }); }) });
		const replies = [];
		peer.onMessage(message => { if (message.topic === '__rpc') replies.push(message.data); });
		await peer.sendRaw(encoder.encode(JSON.stringify({ batch: [{ rpc: 'limited/text', id: 'batch-one', args: [] }] })).buffer);
		await flush();
		expect(replies).toHaveLength(1);
		expect(replies[0].batch).toEqual([expect.objectContaining({ id: 'batch-one', code: 'RATE_LIMITED', retryAfter: 375 })]);
	});

	it('preserves retryAfter in upload replies', async () => {
		env.register('limited', { upload: live.upload(() => { throw new LiveError('RATE_LIMITED', 'Slow down', { retryAfter: 500 }); }) });
		const replies = [];
		peer.onMessage(message => { if (message.topic === '__upload') replies.push(message.data); });
		await peer.sendRaw(uploadChunk(41, 'limited/upload'));
		await flush();
		expect(replies).toEqual([expect.objectContaining({ code: 'RATE_LIMITED', retryAfter: 500 })]);
	});

	it('exposes the lock key and wait bound in params', async () => {
		let release;
		const held = new Promise(resolve => { release = resolve; });
		env.register('locks', { hold: live.lock({ key: 'shared', maxWaitMs: 5 }, async () => { await held; return true; }) });
		const first = peer.call('locks/hold');
		await flush();
		const other = env.connect({ id: 'other' });
		try {
			await expect(other.call('locks/hold')).rejects.toMatchObject({
				code: 'LOCK_TIMEOUT',
				params: { key: 'shared', maxWaitMs: 5 }
			});
		} finally {
			release();
			await first;
			other.disconnect();
		}
	});

	it('omits every metadata field when retryAfter is invalid', () => {
		for (const retryAfter of [-1, NaN, Infinity, '10']) {
			const error = new RpcError('RATE_LIMITED', 'Slow down', { retryAfter, params: { kept: false } });
			expect(error.retryAfter).toBeUndefined();
			expect(error.params).toBeUndefined();
		}
		const error = new RpcError('RATE_LIMITED', 'Slow down', { retryAfter: 0 });
		expect(error.retryAfter).toBe(0);
		const optional = new RpcError('RATE_LIMITED', 'Slow down', { retryAfter: undefined, params: { kept: true }, details: 'ok' });
		expect(optional).toMatchObject({ params: { kept: true }, details: 'ok' });
		expect(optional.retryAfter).toBeUndefined();
	});

	it('validates middleware retry metadata on direct calls and uploads', async () => {
		live.middleware(async () => ({ ok: false, code: 'RATE_LIMITED', error: 'Slow down', retryAfter: -1, params: { dropped: true } }));
		env.register('limited', {
			text: live(() => true),
			upload: live.upload(() => true)
		});
		const direct = await __directCall('limited/text', [], env.platform).catch(error => error);
		expect(direct).toMatchObject({ code: 'RATE_LIMITED' });
		expect(direct.retryAfter).toBeUndefined();
		expect(direct.params).toBeUndefined();
		const replies = [];
		peer.onMessage(message => { if (message.topic === '__upload') replies.push(message.data); });
		await peer.sendRaw(uploadChunk(42, 'limited/upload'));
		await flush();
		expect(replies).toHaveLength(1);
		expect(replies[0].code).toBe('RATE_LIMITED');
		expect(replies[0].retryAfter).toBeUndefined();
		expect(replies[0].params).toBeUndefined();
	});
});
