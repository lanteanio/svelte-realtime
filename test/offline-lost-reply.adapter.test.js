// A queued call whose replay reached the server but whose answer was lost
// with the connection goes up again on the next connection under the same
// idempotency key, so the server applies it once. Runs the real client, the
// installed adapter client and the adapter's test server, with a socket in
// front of the client that loses the answer.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installLossyWebSocket, frameTopic } from './helpers/lossy-websocket.js';

const lossy = installLossyWebSocket();
const { createTestServer } = await import('svelte-adapter-uws/testing');
const { connect } = await import('svelte-adapter-uws/client');
const { live, realtime, __register, _prepareHmr, _resetLifecycle } = await import('../src/server.js');
const client = await import('../src/client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}

let server, conn;

beforeAll(async () => {
	_resetLifecycle();
	server = await createTestServer({ handler: realtime() });
	conn = connect({ url: server.wsUrl, reconnectInterval: 20, maxReconnectInterval: 50 });
});

afterAll(async () => {
	conn?.close();
	await server?.close();
	_prepareHmr();
	lossy.restore();
});

describe('offline replay over a connection that loses the answer', () => {
	it('sends the call again under its idempotency key and the server applies it once', async () => {
		let runs = 0;
		__register('replayed/add', live.idempotent({}, async () => {
			runs++;
			return 'added';
		}));
		client.configure({ offline: { queue: true } });

		client.simulateOffline();
		const saved = client.__rpc('replayed/add')({ id: 1 });

		// The first answer to the replay is lost, and the connection with it.
		let lost = false;
		lossy.link.inbound = (event, deliver) => {
			if (!lost && frameTopic(event) === '__rpc' && JSON.parse(event.data).data?.data === 'added') {
				lost = true;
				setTimeout(() => { client.simulateOffline(); client.resumeOnline(); }, 0);
				return;
			}
			deliver();
		};
		client.resumeOnline();

		await expect(saved).resolves.toBe('added');
		expect(lost).toBe(true);
		expect(runs).toBe(1);
		const sends = lossy.link.sent.filter((f) => f.rpc === 'replayed/add');
		expect(sends).toHaveLength(2);
		expect(typeof sends[0].idempotencyKey).toBe('string');
		expect(sends[1].idempotencyKey).toBe(sends[0].idempotencyKey);
	});
});
