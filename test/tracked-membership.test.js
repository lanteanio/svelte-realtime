import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, WS_SUBSCRIPTIONS } from 'svelte-adapter-uws/testing';
import { live, handleRpc, enableSignals, __register, _prepareHmr, _resetLifecycle } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}

describe('server-owned membership is recorded in the adapter registry', () => {
	let server, socket, frames, serverSocket;
	async function start(handler) {
		server = await createTestServer({ handler });
		socket = new WebSocket(server.wsUrl);
		socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') frames.push(JSON.parse(data)); });
		await new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', reject, { once: true });
		});
	}
	beforeEach(() => { frames = []; serverSocket = null; _resetLifecycle(); });
	afterEach(async () => {
		socket?.close();
		await server?.close();
		server = null; socket = null;
		_prepareHmr();
	});

	it('subscribes the signal channel through the registry', async () => {
		await start({
			upgrade() { return { id: 'alice' }; },
			open(ws) { serverSocket = ws; enableSignals(ws); }
		});
		await until(() => serverSocket !== null, 'the open hook');
		expect(serverSocket.getUserData()[WS_SUBSCRIPTIONS].has('__signal:alice')).toBe(true);
		server.platform.publish('__signal:alice', 'ping', { n: 1 });
		await until(() => frames.some(f => f.topic === '__signal:alice'), 'the signal');
	});

	it('records a stream subscription when the platform it was handed has no subscribe', async () => {
		const topic = 'tracked:feed';
		__register('tracked/feed', live.public(live.stream(topic, async (ctx, fail) => {
			serverSocket = ctx.ws;
			if (fail) throw new Error('loader refused');
			return [];
		}, { merge: 'latest' })));
		await start({
			message(ws, { data, platform }) {
				// A platform wrapper that forwards publishing but not subscribe.
				const wrapped = Object.create(platform, { subscribe: { value: undefined } });
				handleRpc(ws, data, wrapped);
			}
		});
		const reply = id => frames.find(f => f.topic === '__rpc' && f.event === id && typeof f.data?.ok === 'boolean')?.data;
		socket.send(JSON.stringify({ rpc: 'tracked/feed', id: 'ok', args: [false], stream: true }));
		await until(() => reply('ok'), 'the subscribe reply');
		expect(reply('ok').ok).toBe(true);
		const registry = serverSocket.getUserData()[WS_SUBSCRIPTIONS];
		expect(registry.has(topic)).toBe(true);
		server.platform.publish(topic, 'set', { id: 1 });
		await until(() => frames.some(f => f.topic === topic), 'the live frame');
	});
});

describe('stream subscribe without platform.subscribe at the subscription cap', () => {
	afterEach(() => { _prepareHmr(); });

	it('refuses with RATE_LIMITED and leaves the registry unchanged', async () => {
		_resetLifecycle();
		__register('tracked/capped', live.public(live.stream('tracked:capped', async () => [])));
		const full = new Set(Array.from({ length: 65536 }, (_, i) => 'held:' + i));
		const ws = mockWs({ id: 'u1', [WS_SUBSCRIPTIONS]: full });
		const platform = mockPlatform();
		delete platform.subscribe;
		handleRpc(ws, toArrayBuffer({ rpc: 'tracked/capped', id: 'c', args: [], stream: true }), platform);
		await until(() => platform.sent.some(r => r.event === 'c'), 'the reply');
		expect(platform.sent.find(r => r.event === 'c').data).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
		expect(full.size).toBe(65536);
		expect(full.has('tracked:capped')).toBe(false);
		expect(ws.isSubscribed('tracked:capped')).toBe(false);
	});
});
