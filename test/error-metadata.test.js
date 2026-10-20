import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { copyErrorMetadata } from '../src/shared/error-metadata.js';

let server;
beforeEach(async () => {
	vi.resetModules();
	server = await import('../src/server.js');
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const metadata = { params: { count: 3, field: 'title' }, details: { allowed: ['reader', null], retry: false } };
function frame(kind) {
	const request = { rpc: 'errors/fail', id: 'request', args: [] };
	if (kind === 'text' || kind === 'batch') return new TextEncoder().encode(JSON.stringify(kind === 'batch' ? { batch: [request] } : request)).buffer;
	const header = new TextEncoder().encode(JSON.stringify(request));
	const offset = kind === 'upload' ? 12 : 3;
	const bytes = new Uint8Array(offset + header.length);
	const view = new DataView(bytes.buffer);
	if (kind === 'upload') { bytes[0] = 1; bytes[1] = 3; view.setUint32(2, 1); view.setUint16(10, header.length); }
	else view.setUint16(1, header.length);
	bytes.set(header, offset);
	return bytes.buffer;
}
for (const kind of ['text', 'batch', 'binary', 'upload']) {
	for (const typed of [true, false]) it(`${kind} transports only explicit typed error metadata (typed=${typed})`, async () => {
		const failure = typed ? new server.LiveError('LIMIT', 'Limit is 3', metadata) : Object.assign(new Error('private'), metadata);
		failure.secret = 'never transmit'; failure.cause = new Error('private cause');
		const handler = () => { throw failure; };
		server.__register('errors/fail', kind === 'binary' ? server.live.binary(handler) : kind === 'upload' ? server.live.upload(handler) : server.live(handler));
		const platform = mockPlatform();
		expect(server.handleRpc(mockWs({ id: 'member' }), frame(kind), platform)).toBe(true);
		await vi.waitFor(() => expect(platform.sent.length).toBeGreaterThan(0));
		const wire = JSON.parse(JSON.stringify(platform.sent.at(-1).data));
		const reply = kind === 'batch' ? wire.batch[0] : wire;
		expect(reply).toMatchObject(typed ? { ok: false, code: 'LIMIT', error: 'Limit is 3', ...metadata } : { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
		expect(reply).not.toHaveProperty('secret'); expect(reply).not.toHaveProperty('cause');
		if (!typed) { expect(reply).not.toHaveProperty('params'); expect(reply).not.toHaveProperty('details'); }
		// An older decoder ignores the additive fields and still sees the fallback.
		const legacy = new Error(reply.error); legacy.code = reply.code;
		expect(legacy.message).toBe(typed ? 'Limit is 3' : 'Internal server error');
	});
}
it('copies and freezes JSON metadata without keeping caller-owned objects', () => {
	const input = { params: { count: 3 }, details: ['ok', null, true, 1] };
	const error = new server.LiveError('LIMIT', 'Limit reached', input);
	input.params.count = 99; input.details[0] = 'changed';
	expect(error.params).toEqual({ count: 3 });
	expect(error.details).toEqual(['ok', null, true, 1]);
	expect(Object.isFrozen(error.params)).toBe(true);
});
it('rejects non-JSON metadata without invoking serialization hooks', () => {
	const getter = vi.fn(() => 'secret');
	const cycle = {}; cycle.self = cycle;
	const deep = {}; let cursor = deep; for (let i = 0; i < 10; i++) cursor = cursor.next = {};
	const sparse = []; sparse.length = 2;
	const extra = [1]; extra.extra = 2;
	for (const value of [cycle, deep, sparse, extra, new Date(), Infinity, NaN, 1n, () => {}, Symbol('private'), { toJSON: getter }, Object.defineProperty({}, 'private', { enumerable: true, get: getter })]) {
		expect(copyErrorMetadata({ details: value })).toEqual({});
	}
	expect(copyErrorMetadata(Object.defineProperty({}, 'params', { get: getter }))).toEqual({});
	expect(getter).not.toHaveBeenCalled();
});
it('bounds UTF-8 bytes, node count and parameter shape', () => {
	expect(copyErrorMetadata({ details: 'a'.repeat(4082) }).details).toHaveLength(4082);
	expect(copyErrorMetadata({ details: 'a'.repeat(4083) })).toEqual({});
	expect(copyErrorMetadata({ details: '\u00e9'.repeat(2042) })).toEqual({});
	expect(copyErrorMetadata({ details: Array(128).fill(0) })).toEqual({});
	for (const params of [null, 1, 'bad', []]) expect(copyErrorMetadata({ params })).toEqual({});
	expect(copyErrorMetadata(JSON.parse('{"details":{"__proto__":{"secret":true}}}'))).toEqual({});
});
it('revalidates replaced metadata before transport and keeps the original fallback', async () => {
	const error = new server.LiveError('LIMIT', 'Safe fallback', metadata);
	error.params = { value: 1n };
	server.__register('errors/fail', server.live(() => { throw error; }));
	const platform = mockPlatform();
	server.handleRpc(mockWs({ id: 'member' }), frame('text'), platform);
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	expect(platform.sent[0].data).toMatchObject({ code: 'LIMIT', error: 'Safe fallback' });
	expect(platform.sent[0].data).not.toHaveProperty('params');
});

it('preserves structured errors through direct server calls and hydration', async () => {
	const { realtimeTransport } = await import('../src/hooks.js');
	server.__register('errors/fail', server.live(() => { throw new server.LiveError('LIMIT', 'Limit reached', metadata); }));
	const error = await server.__directCall('errors/fail', [], mockPlatform(), { user: { id: 'member' } }).catch(error => error);
	expect(error).toBeInstanceOf(server.LiveError);
	const hook = realtimeTransport().LiveError;
	expect(hook.decode(hook.encode(error))).toMatchObject({ code: 'LIMIT', ...metadata });
});

it('keeps structured error metadata in the test harness', async () => {
	const { createTestEnv } = await import('../src/testing.js');
	const env = createTestEnv();
	const fail = () => { throw new server.LiveError('LIMIT', 'Limit reached', metadata); };
	env.register('errors', { call: server.live(fail), feed: server.live.stream('errors:feed', fail) });
	const conn = env.connect({ id: 'member' });
	try {
		await expect(conn.call('errors/call')).rejects.toMatchObject({ code: 'LIMIT', ...metadata });
		const feed = conn.subscribe('errors/feed');
		await vi.waitFor(() => expect(feed.error).toBeTruthy());
		expect(feed.error).toMatchObject({ code: 'LIMIT', ...metadata });
	} finally { conn.disconnect(); env.cleanup(); }
});

for (const typed of [true, false]) {
	it('preserves only explicit error metadata when an upload guard runs again (typed=' + typed + ')', async () => {
		const failure = typed ? new server.LiveError('LIMIT', 'Limit is 3', metadata) : Object.assign(new Error('private'), metadata);
		let guardCalls = 0, started, abortReason;
		const running = new Promise(resolve => { started = resolve; });
		server.__registerGuard('errors', server.guard(() => { if (++guardCalls > 1) throw failure; }));
		server.__register('errors/fail', server.live.upload(async ctx => {
			started();
			try { for await (const chunk of ctx.stream) {} }
			catch (error) { abortReason = error; throw error; }
		}, { reauthEvery: 1 }));
		const ws = mockWs({ id: 'member' }), platform = mockPlatform();
		try {
			const first = frame('upload');
			new DataView(first).setUint8(1, 1);
			server.handleRpc(ws, first, platform);
			await running;
			const next = new Uint8Array(11), view = new DataView(next.buffer);
			next[0] = 1; view.setUint32(2, 1); view.setUint32(6, 1);
			server.handleRpc(ws, next.buffer, platform);
			await vi.waitFor(() => expect(platform.sent.some(row => row.topic === '__upload' && row.data.ok === false)).toBe(true));
			await vi.waitFor(() => expect(abortReason).toBeDefined());
			const result = JSON.parse(JSON.stringify(platform.sent.find(row => row.topic === '__upload' && row.data.ok === false).data));
			const expected = typed ? { code: 'LIMIT', ...metadata } : { code: 'FORBIDDEN' };
			expect(result).toMatchObject({ ok: false, ...expected });
			expect(abortReason).toMatchObject(expected);
			expect(result).not.toHaveProperty('cause');
			if (!typed) {
				expect(result.error).toBe('Access denied');
				expect(result).not.toHaveProperty('params');
				expect(result).not.toHaveProperty('details');
			}
		} finally { await server.close(ws, { platform, subscriptions: [] }); }
	});
}
