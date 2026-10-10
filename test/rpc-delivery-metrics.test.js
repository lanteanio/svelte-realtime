import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';
import { MAX_RPC_BATCH_CALLS } from '../src/shared/rpc-limits.js';

let api, counters, socketServer, client, release;
const metric = 'svelte_realtime_rpc_delivery_total';
beforeEach(async () => {
	vi.resetModules();
	api = await import('../src/server.js');
	counters = new Map();
	api.live.metrics({
		counter({ name }) { const rows = []; counters.set(name, rows); return { inc(labels) { rows.push(labels); } }; },
		histogram() { return { observe() {} }; },
		gauge() { return { inc() {}, dec() {} }; }
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
	release?.(); release = null;
	client?.close(); client = null;
	await socketServer?.close(); socketServer = null;
	vi.restoreAllMocks();
});
function binary(request) {
	const header = new TextEncoder().encode(JSON.stringify(request));
	const bytes = new Uint8Array(3 + header.length);
	new DataView(bytes.buffer).setUint16(1, header.length);
	bytes.set(header, 3);
	return bytes.buffer;
}
async function dispatch(platform, request, kind = 'text', ws = mockWs({ id: 'member' })) {
	expect(api.handleRpc(ws, kind === 'binary' ? binary(request) : toArrayBuffer(request), platform)).toBe(true);
	await vi.waitFor(() => expect(counters.get(metric).length).toBeGreaterThan(0));
}
for (const kind of ['text', 'binary']) {
	for (const [result, outcome] of [[1, 'delivered'], [0, 'backpressure'], [2, 'backpressure'], ['throw', 'exception'], ['closed', 'closed']]) {
		it(`records ${kind} transport ${outcome} for send result ${result} independently of execution`, async () => {
			api.__register('delivery/echo', kind === 'binary' ? api.live.binary(() => 'ok') : api.live(() => 'ok'));
			const platform = mockPlatform();
			platform.closedWsAborts = 0;
			platform.send = () => {
				if (result === 'throw') throw new Error('transport refused');
				if (result === 'closed') { platform.closedWsAborts++; return 2; }
				return result;
			};
			await dispatch(platform, { rpc: 'delivery/echo', id: 'one', args: [] }, kind);
			expect(counters.get(metric)).toEqual([{ path: 'delivery/echo', outcome }]);
			expect(counters.get('svelte_realtime_rpc_total')).toEqual([{ path: 'delivery/echo', status: 'ok' }]);
			expect(counters.get('svelte_realtime_rpc_errors_total')).toEqual([]);
		});
	}
}
it('records each batch reply once and bounds malformed and unknown path labels', async () => {
	api.__register('delivery/echo', api.live(() => 'ok'));
	const batch = [{ rpc: 'delivery/echo', id: 'ok' }, null, { rpc: '../bad', id: 'bad' }, ...Array.from({ length: 20 }, (_, i) => ({ rpc: 'missing/' + i, id: 'x' + i }))];
	await dispatch(mockPlatform(), { batch });
	expect(counters.get(metric)).toHaveLength(batch.length);
	expect([...new Set(counters.get(metric).map(row => row.path))].sort()).toEqual(['__invalid__', '__unknown__', 'delivery/echo']);
	expect(counters.get(metric).every(row => row.outcome === 'delivered')).toBe(true);
});
it('counts the final stream reply without counting its early attach', async () => {
	api.__register('delivery/items', api.live.stream('delivery-items', async () => []));
	const platform = mockPlatform();
	await dispatch(platform, { rpc: 'delivery/items', id: 'stream', args: [], stream: true, attach: true });
	expect(platform.sent.filter(row => row.topic === '__rpc')).toHaveLength(2);
	expect(counters.get(metric)).toEqual([{ path: 'delivery/items', outcome: 'delivered' }]);
});
it('does not read transport counters when metrics are disabled', async () => {
	const { state } = await import('../src/server/state.js');
	state.metricsInstruments = null;
	api.__register('delivery/echo', api.live(() => 'ok'));
	const platform = mockPlatform();
	Object.defineProperty(platform, 'closedWsAborts', { get() { throw new Error('unexpected metrics work'); } });
	expect(api.handleRpc(mockWs(), toArrayBuffer({ rpc: 'delivery/echo', id: 'off' }), platform)).toBe(true);
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	expect(counters.get(metric)).toEqual([]);
});
for (const wireCloseHook of [true, false]) it(`observes native successful delivery and closed sends (close hook=${wireCloseHook})`, async () => {
	let entered = false, closed = false;
	const held = new Promise(resolve => { release = resolve; });
	api.__register('delivery/echo', api.live(() => 'received'));
	api.__register('delivery/held', api.live(async () => { entered = true; await held; return 'late'; }));
	socketServer = await createTestServer({ handler: {
		message(ws, ctx) { if (!ctx.isBinary && ctx.msg === undefined) api.handleRpc(ws, ctx.data, socketServer.platform); },
		close(ws, ctx) { if (wireCloseHook) api.close(ws, ctx); closed = true; }
	} });
	client = new WebSocket(socketServer.wsUrl);
	const received = [];
	client.addEventListener('message', event => received.push(JSON.parse(event.data)));
	await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN));
	client.send(JSON.stringify({ rpc: 'delivery/echo', id: 'ok' }));
	await vi.waitFor(() => expect(received.some(row => row.event === 'ok' && row.data.data === 'received')).toBe(true));
	client.send(JSON.stringify({ rpc: 'delivery/held', id: 'held' }));
	await vi.waitFor(() => expect(entered).toBe(true));
	client.close();
	await vi.waitFor(() => expect(closed).toBe(true));
	release();
	await vi.waitFor(() => expect(counters.get(metric)).toHaveLength(2));
	expect(counters.get(metric)).toEqual([{ path: 'delivery/echo', outcome: 'delivered' }, { path: 'delivery/held', outcome: 'closed' }]);
	expect(socketServer.platform.closedWsAborts).toBeGreaterThan(0);
});

it('records oversized batch rejection once under the bounded envelope label', async () => {
	const handler = vi.fn(() => 'unused');
	api.__register('delivery/echo', api.live(handler));
	const platform = mockPlatform();
	await dispatch(platform, { batch: Array.from({ length: MAX_RPC_BATCH_CALLS + 1 }, (_, i) => ({ rpc: 'delivery/echo', id: 'c' + i })) });
	expect(handler).not.toHaveBeenCalled();
	expect(platform.sent).toHaveLength(1);
	expect(platform.sent[0].data.batch).toHaveLength(MAX_RPC_BATCH_CALLS + 1);
	expect(counters.get(metric)).toEqual([{ path: '__batch__', outcome: 'delivered' }]);
});
