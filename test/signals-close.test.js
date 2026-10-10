import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { enableSignals } from '../src/server.js';

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

describe('enableSignals after asynchronous connection setup', () => {
	let server, client;
	afterEach(async () => {
		client?.close();
		await server?.close();
	});

	it('ignores a real native socket that closed while its open hook awaited setup', async () => {
		const opened = deferred(), resume = deferred(), completed = deferred(), closed = deferred();
		let failure;
		server = await createTestServer({ handler: {
			upgrade() { return { id: 'alice' }; },
			async open(ws) {
				opened.resolve();
				await resume.promise;
				try { enableSignals(ws); } catch (error) { failure = error; }
				completed.resolve();
			},
			close() { closed.resolve(); }
		} });
		client = new WebSocket(server.wsUrl);
		await opened.promise;
		await new Promise((resolve, reject) => {
			if (client.readyState === WebSocket.OPEN) return resolve();
			client.addEventListener('open', resolve, { once: true });
			client.addEventListener('error', reject, { once: true });
		});
		client.close();
		await closed.promise;
		resume.resolve();
		await completed.promise;
		expect(failure).toBeUndefined();
	});

	it('contains a subscription failure after reading user data', () => {
		expect(() => enableSignals({
			getUserData: () => ({ id: 'alice' }),
			subscribe() { throw new Error('WebSocket is closed'); }
		})).not.toThrow();
	});

	it('still rejects invalid user ids on live sockets', () => {
		let subscribed = false;
		expect(() => enableSignals({
			getUserData: () => ({ id: 'bad\nid' }),
			subscribe() { subscribed = true; }
		})).toThrow('enableSignals');
		expect(subscribed).toBe(false);
	});
});
