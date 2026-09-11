import { describe, it, expect, afterEach } from 'vitest';
import { message, createMessage, realtime, __register } from '../src/server.js';
import { state } from '../src/server/state.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

// The connect-time protocol-compat signal, server half: a client advertises its
// baked protocol version once on connect as { type: 'proto', v }, and a server
// declared with a HIGHER protocolVersion (an older client bundle against a newer
// server) replies with a one-shot, unicast `protocol-stale` notice.

/** Build the (data, msg) pair the adapter forwards for a control frame. */
function protoFrame(v) {
	const msg = { type: 'proto', v };
	return { data: toArrayBuffer(JSON.stringify(msg)), msg };
}

const staleSends = (platform) => platform.sent.filter((s) => s.event === 'protocol-stale');

describe('protocol-compat signal: server gate', () => {
	afterEach(() => {
		state.serverProtocolVersion = undefined;
		state.serverProtocolPolicy = undefined;
	});

	it('realtime({ protocolVersion }) sets the server version and rejects non-integers', () => {
		realtime({ protocolVersion: 5 });
		expect(state.serverProtocolVersion).toBe(5);
		state.serverProtocolVersion = undefined;
		expect(() => realtime({ protocolVersion: 1.5 })).toThrow(/integer/);
		expect(() => realtime({ protocolVersion: 'x' })).toThrow(/integer/);
	});

	it('validates the coordinated range policy', () => {
		realtime({ protocolVersion: { current: 4, minimum: 2, onMismatch: 'reject' } });
		expect(state.serverProtocolPolicy).toEqual({ current: 4, minimum: 2, onMismatch: 'reject' });
		expect(() => realtime({ protocolVersion: { current: 1, minimum: 2, onMismatch: 'reject' } })).toThrow(/minimum/);
		expect(() => realtime({ protocolVersion: { current: 2, minimum: 1, onMismatch: 'close' } })).toThrow(/notify.*reject/);
		expect(() => realtime({ protocolVersion: { current: 2.5, minimum: 1, onMismatch: 'reject' } })).toThrow(/safe integer/);
	});

	it('sends protocol-stale to a client older than the server', () => {
		state.serverProtocolVersion = 2;
		const ws = mockWs({ id: 'old' });
		const platform = mockPlatform();
		const { data, msg } = protoFrame(1);
		message(ws, { data, platform, msg });
		const stale = staleSends(platform);
		expect(stale).toHaveLength(1);
		expect(stale[0].topic).toBe('__realtime');
		expect(stale[0].data).toEqual({ server: 2, client: 1 });
		expect(stale[0].ws).toBe(ws);
	});

	it('is silent when the client matches the server', () => {
		state.serverProtocolVersion = 2;
		const ws = mockWs({ id: 'cur' });
		const platform = mockPlatform();
		const { data, msg } = protoFrame(2);
		message(ws, { data, platform, msg });
		expect(staleSends(platform)).toHaveLength(0);
	});

	it('is silent when the client is ahead of the server', () => {
		state.serverProtocolVersion = 2;
		const ws = mockWs({ id: 'ahead' });
		const platform = mockPlatform();
		const { data, msg } = protoFrame(3);
		message(ws, { data, platform, msg });
		expect(staleSends(platform)).toHaveLength(0);
	});

	it('is off entirely when the server declared no protocolVersion', () => {
		// state.serverProtocolVersion stays undefined (default)
		const ws = mockWs({ id: 'noopt' });
		const platform = mockPlatform();
		const { data, msg } = protoFrame(1);
		message(ws, { data, platform, msg });
		expect(staleSends(platform)).toHaveLength(0);
	});

	it('signals a stale client at most once per connection', () => {
		state.serverProtocolVersion = 2;
		const ws = mockWs({ id: 'dup' });
		const platform = mockPlatform();
		const { data, msg } = protoFrame(1);
		message(ws, { data, platform, msg });
		message(ws, { data, platform, msg });
		expect(staleSends(platform)).toHaveLength(1);
	});

	it('targets only the stale connection and never broadcasts', () => {
		state.serverProtocolVersion = 2;
		const wsOld = mockWs({ id: 'old' });
		const wsCur = mockWs({ id: 'cur' });
		const platform = mockPlatform();
		message(wsOld, { ...protoFrame(1), platform });
		message(wsCur, { ...protoFrame(2), platform });
		const stale = staleSends(platform);
		expect(stale).toHaveLength(1);
		expect(stale[0].ws).toBe(wsOld);
		// Unicast only - never a publish broadcast that would tell every client.
		expect(platform.published.filter((p) => p.event === 'protocol-stale')).toHaveLength(0);
	});

	it('the createMessage hook (cluster / rate-limited path) also runs the gate', () => {
		state.serverProtocolVersion = 2;
		const leaked = [];
		const hook = createMessage({ onJsonMessage: (ws, m) => leaked.push(m) });
		const ws = mockWs({ id: 'cm' });
		const platform = mockPlatform();
		const { data, msg } = protoFrame(1);
		hook(ws, { data, msg, platform });
		// The gate fired (protocol-stale unicast) AND the proto frame did not leak to
		// the app's onJsonMessage callback.
		expect(staleSends(platform)).toHaveLength(1);
		expect(staleSends(platform)[0].data).toEqual({ server: 2, client: 1 });
		expect(leaked).toHaveLength(0);
	});

	it.each([
		['baseline admits the matching client under notify', { current: 2, minimum: 2, onMismatch: 'notify' }, 2, null],
		['range-expand keeps the previous client admitted', { current: 3, minimum: 2, onMismatch: 'notify' }, 2, null],
		['client-cutover admits the current client', { current: 3, minimum: 2, onMismatch: 'reject' }, 3, null],
		['minimum-cutover rejects the retired client after raising minimum', { current: 3, minimum: 3, onMismatch: 'reject' }, 2, 'too-old'],
		['rollback rejects the newer client against the restored server', { current: 2, minimum: 2, onMismatch: 'reject' }, 3, 'too-new']
	])('%s', async (_name, policy, advertised, expectedReason) => {
		state.serverProtocolVersion = policy.current;
		state.serverProtocolPolicy = policy;
		let executed = 0;
		__register('protocol-policy/echo', async () => { executed++; return 'ok'; });
		const ws = mockWs({ id: String(advertised) });
		const platform = mockPlatform();
		message(ws, { ...protoFrame(advertised), platform });
		message(ws, {
			data: toArrayBuffer({ rpc: 'protocol-policy/echo', id: 'call-' + advertised, args: [] }),
			platform
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const response = platform.sent.find((entry) => entry.event === 'call-' + advertised);
		if (expectedReason === null) {
			expect(executed).toBe(1);
			expect(response?.data).toMatchObject({ ok: true, data: 'ok' });
			expect(platform.sent.filter((entry) => entry.event === 'protocol-mismatch')).toHaveLength(0);
		} else {
			expect(executed).toBe(0);
			expect(response?.data).toMatchObject({
				ok: false,
				code: 'PROTOCOL_MISMATCH',
				protocol: { reason: expectedReason, server: { current: policy.current, minimum: policy.minimum }, client: advertised }
			});
			expect(platform.sent.filter((entry) => entry.event === 'protocol-mismatch')).toHaveLength(1);
		}
	});

	it('rejects an RPC with a typed missing-advertisement response before handler execution', async () => {
		state.serverProtocolVersion = 3;
		state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
		let executed = 0;
		__register('protocol-policy/missing', async () => { executed++; });
		const ws = mockWs({ id: 'missing' });
		const platform = mockPlatform();
		message(ws, {
			data: toArrayBuffer({ rpc: 'protocol-policy/missing', id: 'missing-id', args: [] }),
			platform
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(executed).toBe(0);
		expect(platform.sent.find((entry) => entry.event === 'missing-id')?.data)
			.toMatchObject({ ok: false, code: 'PROTOCOL_MISMATCH', protocol: { reason: 'missing', client: null } });
	});

	it('contains every batch member with a typed mismatch before any handler executes', async () => {
		state.serverProtocolVersion = 3;
		state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
		let executed = 0;
		__register('protocol-policy/batch-a', async () => { executed++; });
		__register('protocol-policy/batch-b', async () => { executed++; });
		const ws = mockWs({ id: 'batch-mismatch' });
		const platform = mockPlatform();
		message(ws, { ...protoFrame(1), platform });
		message(ws, {
			data: toArrayBuffer({
				batch: [
					{ rpc: 'protocol-policy/batch-a', id: 'batch-a', args: [] },
					{ rpc: 'protocol-policy/batch-b', id: 'batch-b', args: [] }
				]
			}),
			platform
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const batch = platform.sent.find((entry) => entry.event === '__batch')?.data?.batch;
		expect(executed).toBe(0);
		expect(batch).toHaveLength(2);
		expect(batch.map((entry) => entry.code)).toEqual(['PROTOCOL_MISMATCH', 'PROTOCOL_MISMATCH']);
		expect(batch.map((entry) => entry.protocol.reason)).toEqual(['too-old', 'too-old']);
	});

	it('returns typed binary and upload rejections without entering application handlers', async () => {
		state.serverProtocolVersion = 3;
		state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
		let binaryExecuted = 0;
		__register('protocol-policy/binary', Object.assign(
			async () => { binaryExecuted++; },
			{ __isLive: true, __isBinary: true }
		));
		const ws = mockWs({ id: 'binary-upload-mismatch' });
		const platform = mockPlatform();
		message(ws, { ...protoFrame(1), platform });

		const headerBytes = new TextEncoder().encode(JSON.stringify({
			rpc: 'protocol-policy/binary', id: 'binary-id', args: []
		}));
		const binary = new Uint8Array(3 + headerBytes.length + 1);
		binary[0] = 0x00;
		binary[1] = (headerBytes.length >> 8) & 0xff;
		binary[2] = headerBytes.length & 0xff;
		binary.set(headerBytes, 3);
		binary[binary.length - 1] = 7;
		message(ws, { data: binary.buffer, platform });

		const upload = new ArrayBuffer(10);
		const uploadView = new DataView(upload);
		uploadView.setUint8(0, 0x01);
		uploadView.setUint32(2, 7, false);
		message(ws, { data: upload, platform });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(binaryExecuted).toBe(0);
		expect(platform.sent.find((entry) => entry.event === 'binary-id')?.data)
			.toMatchObject({ ok: false, code: 'PROTOCOL_MISMATCH', protocol: { reason: 'too-old' } });
		expect(platform.sent.find((entry) => entry.topic === '__upload' && entry.event === '00000007')?.data)
			.toMatchObject({ ok: false, code: 'PROTOCOL_MISMATCH', protocol: { reason: 'too-old' } });
	});

	it('notify policy reports the mismatch but leaves the staged call lane open', async () => {
		state.serverProtocolVersion = 3;
		state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'notify' };
		let executed = 0;
		__register('protocol-policy/notify', async () => { executed++; return 'observed'; });
		const ws = mockWs({ id: 'notify' });
		const platform = mockPlatform();
		message(ws, { ...protoFrame(1), platform });
		message(ws, {
			data: toArrayBuffer({ rpc: 'protocol-policy/notify', id: 'notify-id', args: [] }),
			platform
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(executed).toBe(1);
		expect(platform.sent.find((entry) => entry.event === 'notify-id')?.data).toMatchObject({ ok: true, data: 'observed' });
		expect(platform.sent.find((entry) => entry.event === 'protocol-mismatch')?.data)
			.toMatchObject({ code: 'PROTOCOL_MISMATCH', action: 'notify', reason: 'too-old' });
	});

	it('strict mismatch contains custom JSON dispatch as well as RPC handlers', () => {
		state.serverProtocolVersion = 3;
		state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
		const leaked = [];
		const hook = createMessage({ onJsonMessage: (_ws, value) => leaked.push(value) });
		const ws = mockWs({ id: 'custom' });
		const platform = mockPlatform();
		hook(ws, { ...protoFrame(1), platform });
		const msg = { type: 'application-plugin', value: 1 };
		hook(ws, { data: toArrayBuffer(JSON.stringify(msg)), msg, platform });
		expect(leaked).toHaveLength(0);
	});
});
