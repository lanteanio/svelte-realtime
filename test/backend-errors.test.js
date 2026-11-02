import { afterEach, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

const marker = 'private-backend-context-marker';
let server, restoreSink;
const encoder = new TextEncoder();

afterEach(() => {
	server?._resetCrdt();
	restoreSink?.();
	server = null; restoreSink = null;
	vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function setup(mode = 'production') {
	vi.resetModules(); vi.stubEnv('NODE_ENV', mode);
	server = await import('../src/server.js');
	const { setOperationalEventSink } = await import('../src/shared/diagnostic.js');
	const records = [];
	restoreSink = setOperationalEventSink(record => { records.push(record); });
	return { records, onError: vi.fn() };
}

async function reply(handler, observation) {
	server.__register('private/read', server.live.public(handler));
	const ws = mockWs({ id: 'member' }), platform = mockPlatform();
	server.handleRpc(ws, encoder.encode(JSON.stringify({ rpc: 'private/read', id: 'private-call', args: [[], 1] })).buffer, platform, { onError: observation.onError });
	await vi.waitFor(() => expect(platform.sent.find(frame => frame.topic === '__rpc')?.data).toBeDefined());
	return platform.sent.find(frame => frame.topic === '__rpc').data;
}

function assertPrivate(response, observation, cause) {
	expect(response).toMatchObject({ id: 'private-call', ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
	expect(JSON.stringify(response)).not.toContain(marker);
	expect(response).not.toHaveProperty('params');
	expect(response).not.toHaveProperty('details');
	expect(observation.onError).toHaveBeenCalledTimes(1);
	const [path, error, ctx] = observation.onError.mock.calls[0];
	expect(path).toBe('private/read'); expect(ctx.requestId).toBe('private-call');
	expect(error).not.toBeInstanceOf(server.LiveError);
	expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({ value: cause, enumerable: false });
	const diagnostic = observation.records.find(record => record.event === 'rpc.execution.non-live-error');
	expect(diagnostic).toMatchObject({ component: 'server.rpc', dataClass: 'application', attributes: { path, requestId: 'private-call' } });
	expect(JSON.stringify(diagnostic)).not.toContain(marker);
	expect(diagnostic.attributes.error.message.length).toBeLessThan(160);
}

it.each(['production', 'development'])('masks actual persistence errors and correlates their server observer in %s', async mode => {
	const observation = await setup(mode), cause = new Error(marker);
	const doc = server.live.doc({ topic: 'private-errors', guard: () => true, persistOnEmpty: false,
		persist: { load: async () => { throw cause; } }, onError: vi.fn() });
	assertPrivate(await reply(doc.__docSync, observation), observation, cause);
});

it('does not trust a LiveError thrown by document persistence as public policy', async () => {
	const observation = await setup();
	const cause = new server.LiveError('INTERNAL', marker, { params: { private: marker }, details: marker });
	const doc = server.live.doc({ topic: 'private-typed-errors', guard: () => true, persistOnEmpty: false,
		persist: { load: async () => { throw cause; } }, onError: vi.fn() });
	assertPrivate(await reply(doc.__docSync, observation), observation, cause);
});

it.each([null, undefined, marker])('masks non-Error persistence rejection %s', async cause => {
	const observation = await setup();
	const doc = server.live.doc({ topic: 'private-untyped-errors', guard: () => true, persistOnEmpty: false,
		persist: { load: async () => { throw cause; } }, onError: vi.fn() });
	assertPrivate(await reply(doc.__docSync, observation), observation, cause);
});

it.each(['_crdtLoadError', '_smoothLoadError'])('masks unexpected %s failures without reading their message', async classify => {
	const observation = await setup();
	const cause = Object.defineProperty({}, 'message', { get: vi.fn(() => { throw new Error(marker); }) });
	const error = server[classify](cause);
	assertPrivate(await reply(server.live(() => { throw error; }), observation), observation, cause);
	expect(Object.getOwnPropertyDescriptor(cause, 'message').get).not.toHaveBeenCalled();
});

it.each(['_crdtLoadError', '_smoothLoadError'])('contains a throwing error-code getter in %s', async classify => {
	const observation = await setup();
	const cause = Object.defineProperty({}, 'code', { get() { throw new server.LiveError('INTERNAL', marker); } });
	const error = server[classify](cause);
	assertPrivate(await reply(server.live(() => { throw error; }), observation), observation, cause);
});

it('preserves explicitly public application LiveErrors', async () => {
	const observation = await setup();
	const response = await reply(server.live(() => { throw new server.LiveError('FORBIDDEN', 'Public refusal', { params: { action: 'read' } }); }), observation);
	expect(response).toMatchObject({ ok: false, code: 'FORBIDDEN', error: 'Public refusal', params: { action: 'read' } });
	expect(observation.onError).not.toHaveBeenCalled();
});
