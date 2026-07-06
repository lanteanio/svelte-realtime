// Realtime wiring for the outbound-webhook delivery controls: configureWebhooks
// ({ budget, breaker }) installs / validates the collaborators, and
// _fireWebhookOut threads them (keyed by the webhook registration id) into the
// adapter's deliverWebhook. The control MECHANICS are covered by the adapter
// plugin's own suite; here we prove realtime installs and passes them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { createRetryBudget, createWebhookBreaker } from 'svelte-adapter-uws/plugins/webhooks';
import { configureWebhooks, getDeadLetter, realtime } from '../src/server.js';
import { _fireWebhookOut } from '../src/server/webhook-out.js';
import { state } from '../src/server/state.js';

function reset() {
	configureWebhooks({ deadLetter: false, budget: false, breaker: false });
}

/** A scripted loopback server so a delivery has a real socket to reach. */
function makeServer() {
	let handler = (_req, res) => { res.writeHead(200); res.end(); };
	const received = [];
	const server = createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', () => { received.push(req.url); handler(req, res); });
	});
	return {
		received,
		set(h) { handler = h; },
		listen() { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); },
		close() { return new Promise((r) => server.close(r)); }
	};
}

const fastRetry = { attempts: 3, initialDelayMs: 2, maxDelayMs: 4 };

describe('configureWebhooks({ budget, breaker }) wiring', () => {
	beforeEach(reset);

	it('installs the built-in defaults on true', () => {
		configureWebhooks({ budget: true, breaker: true });
		expect(typeof state.webhookBudget.take).toBe('function');
		expect(typeof state.webhookBreaker.guard).toBe('function');
		expect(typeof state.webhookBreaker.success).toBe('function');
		expect(typeof state.webhookBreaker.failure).toBe('function');
	});

	it('accepts explicit instances', () => {
		const budget = createRetryBudget();
		const breaker = createWebhookBreaker();
		configureWebhooks({ budget, breaker });
		expect(state.webhookBudget).toBe(budget);
		expect(state.webhookBreaker).toBe(breaker);
	});

	it('rejects a budget without take() and a breaker missing methods', () => {
		expect(() => configureWebhooks({ budget: {} })).toThrow(/take\(key\) method/);
		expect(() => configureWebhooks({ breaker: { guard() {} } })).toThrow(/guard.*success.*failure/);
	});

	it('false / null disables', () => {
		configureWebhooks({ budget: true, breaker: true });
		configureWebhooks({ budget: false, breaker: null });
		expect(state.webhookBudget).toBeNull();
		expect(state.webhookBreaker).toBeNull();
	});

	it('is also wired from realtime({ webhooks })', () => {
		realtime({ webhooks: { budget: true, breaker: true } });
		expect(state.webhookBudget).not.toBeNull();
		expect(state.webhookBreaker).not.toBeNull();
	});
});

describe('_fireWebhookOut threads the controls into delivery', () => {
	let srv;
	let port;
	beforeEach(async () => {
		reset();
		srv = makeServer();
		port = await srv.listen();
	});
	afterEach(async () => {
		await srv.close();
		reset();
	});

	const entry = (extra) => ({ id: 'orders/wh', config: { url: `http://127.0.0.1:${port}/hook`, urlMode: 'off', ...extra } });

	it('an open breaker ejects the delivery to the DLQ without touching the network', async () => {
		const breaker = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000 });
		breaker.failure(new Error('prior'), 'orders/wh'); // open the endpoint's circuit
		configureWebhooks({ breaker, deadLetter: true });

		await _fireWebhookOut(entry(), 'orders', 'created', { id: 1 }, null);

		expect(srv.received).toHaveLength(0); // fast-failed, no socket
		const recs = getDeadLetter().list({ topic: 'orders' });
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({ webhookId: 'orders/wh', attempts: 0 });
		expect(recs[0].error).toContain('circuit open');
	});

	it('keys the breaker by the webhook registration id', async () => {
		const seen = [];
		const spy = { guard: (k) => seen.push(k), success: () => {}, failure: () => {} };
		configureWebhooks({ breaker: spy });
		await _fireWebhookOut(entry(), 'orders', 'created', {}, null);
		expect(seen).toEqual(['orders/wh']);
	});

	it('records success and heals the breaker on delivery', async () => {
		const breaker = createWebhookBreaker({ failureThreshold: 5, resetMs: 60000 });
		breaker.failure(new Error('x'), 'orders/wh'); // one prior failure, not yet open
		configureWebhooks({ breaker });
		await _fireWebhookOut(entry(), 'orders', 'created', {}, null);
		expect(srv.received).toHaveLength(1);
		expect(breaker.stateOf('orders/wh')).toBe('healthy');
	});

	it('rations retries through the budget, capturing the shortfall', async () => {
		srv.set((_req, res) => { res.writeHead(500); res.end(); });
		const budget = createRetryBudget({ capacity: 1, refillPerSec: 0 }); // one retry, then dry
		configureWebhooks({ budget, deadLetter: true });

		await _fireWebhookOut(entry({ retry: fastRetry }), 'orders', 'created', {}, null);

		expect(srv.received).toHaveLength(2); // 3 attempts allowed, budget stops after 2
		const recs = getDeadLetter().list({ topic: 'orders' });
		expect(recs[0]).toMatchObject({ webhookId: 'orders/wh', attempts: 2 });
	});
});
