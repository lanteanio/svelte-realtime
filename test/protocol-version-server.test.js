import { describe, it, expect, afterEach } from 'vitest';
import { message, createMessage, realtime } from '../src/server.js';
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
	afterEach(() => { state.serverProtocolVersion = undefined; });

	it('realtime({ protocolVersion }) sets the server version and rejects non-integers', () => {
		realtime({ protocolVersion: 5 });
		expect(state.serverProtocolVersion).toBe(5);
		state.serverProtocolVersion = undefined;
		expect(() => realtime({ protocolVersion: 1.5 })).toThrow(/integer/);
		expect(() => realtime({ protocolVersion: 'x' })).toThrow(/integer/);
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
});
