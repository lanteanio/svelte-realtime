// The outbound-webhook dead-letter queue: the in-memory store, capture on a
// terminal delivery failure, replay (dry-run / confirm / unregistered), and the
// admin /dlq commands. Delivery itself is exercised without network: an
// SSRF-blocked loopback url fails the gate terminally (no socket), and a
// transform that opts out resolves a replay as "delivered" (nothing to send).

import { describe, it, expect, beforeEach } from 'vitest';
import {
	createDeadLetterStore,
	configureWebhooks,
	getDeadLetter,
	replayDeadLetter,
	realtime
} from '../src/server.js';
import { _fireWebhookOut } from '../src/server/webhook-out.js';
import { state, _webhookOutById } from '../src/server/state.js';

const adminFor = (requires) => /** @type {any} */ (realtime({ admin: { requires } })).admin;

function reset() {
	configureWebhooks({ deadLetter: false });
	_webhookOutById.clear();
}

describe('createDeadLetterStore', () => {
	it('adds, gets, counts, lists newest-first, removes', () => {
		const s = createDeadLetterStore();
		const id1 = s.add({ webhookId: 'w1', topic: 't', event: 'e', data: { n: 1 }, attempts: 3, error: 'boom', failedAt: 100 });
		const id2 = s.add({ webhookId: 'w1', topic: 't', event: 'e', data: { n: 2 }, attempts: 3, error: 'boom', failedAt: 200 });
		expect(s.count()).toBe(2);
		expect(s.get(id1).data).toEqual({ n: 1 });
		const list = s.list();
		expect(list[0].id).toBe(id2); // newest first
		expect(s.remove(id1)).toBe(true);
		expect(s.get(id1)).toBeNull();
		expect(s.count()).toBe(1);
	});

	it('filters by topic and summarizes', () => {
		const s = createDeadLetterStore();
		s.add({ webhookId: 'w', topic: 'a', event: 'e', data: 1, attempts: 1, error: 'x', failedAt: 10 });
		s.add({ webhookId: 'w', topic: 'a', event: 'e', data: 2, attempts: 1, error: 'x', failedAt: 20 });
		s.add({ webhookId: 'w', topic: 'b', event: 'e', data: 3, attempts: 1, error: 'x', failedAt: 30 });
		expect(s.count({ topic: 'a' })).toBe(2);
		expect(s.list({ topic: 'b' })).toHaveLength(1);
		const sum = s.summary();
		expect(sum.total).toBe(3);
		expect(sum.byTopic).toEqual({ a: 2, b: 1 });
		expect(sum.oldest).toBe(10);
		expect(sum.newest).toBe(30);
	});

	it('evicts the oldest beyond max', () => {
		const s = createDeadLetterStore({ max: 2 });
		s.add({ webhookId: 'w', topic: 't', event: 'e', data: 1, attempts: 1, error: 'x', failedAt: 1 });
		const keep = s.add({ webhookId: 'w', topic: 't', event: 'e', data: 2, attempts: 1, error: 'x', failedAt: 2 });
		const newest = s.add({ webhookId: 'w', topic: 't', event: 'e', data: 3, attempts: 1, error: 'x', failedAt: 3 });
		expect(s.count()).toBe(2);
		const ids = s.list().map((r) => r.id);
		expect(ids).toContain(keep);
		expect(ids).toContain(newest);
	});
});

describe('webhook dead-letter capture', () => {
	beforeEach(reset);

	const failingEntry = { id: 'test/wh', config: { url: 'http://127.0.0.1:9/blocked' } }; // loopback -> SSRF-blocked

	it('captures an undeliverable event when a store is configured', async () => {
		configureWebhooks({ deadLetter: true });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 7 }, null);
		const store = getDeadLetter();
		const recs = store.list({ topic: 'orders' });
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({ webhookId: 'test/wh', topic: 'orders', event: 'created' });
		expect(recs[0].data).toEqual({ id: 7 });
		expect(typeof recs[0].error).toBe('string');
		expect(recs[0].error).toContain('SSRF');
	});

	it('does not capture when no store is configured (off by default)', async () => {
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 7 }, null);
		expect(getDeadLetter()).toBeNull();
	});

	it('accepts an explicit store instance', () => {
		const custom = createDeadLetterStore();
		configureWebhooks({ deadLetter: custom });
		expect(getDeadLetter()).toBe(custom);
	});
});

describe('replayDeadLetter', () => {
	beforeEach(reset);

	it('dry-run reports would-replay without sending or removing', async () => {
		configureWebhooks({ deadLetter: true });
		const store = getDeadLetter();
		_webhookOutById.set('w', { id: 'w', config: { url: 'http://127.0.0.1:9/x' } });
		store.add({ webhookId: 'w', topic: 't', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });
		const out = await replayDeadLetter({ topic: 't', dryRun: true });
		expect(out.dryRun).toBe(true);
		expect(out.total).toBe(1);
		expect(out.replayed).toBe(0);
		expect(out.results[0].status).toBe('would-replay');
		expect(store.count()).toBe(1); // not removed
	});

	it('removes a record when replay succeeds (transform opt-out = nothing to deliver)', async () => {
		configureWebhooks({ deadLetter: true });
		const store = getDeadLetter();
		_webhookOutById.set('w', { id: 'w', config: { url: 'http://example.com/x', transform: () => null } });
		store.add({ webhookId: 'w', topic: 't', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });
		const out = await replayDeadLetter({ topic: 't' });
		expect(out.replayed).toBe(1);
		expect(out.removed).toBe(1);
		expect(out.results[0].status).toBe('replayed');
		expect(store.count()).toBe(0);
	});

	it('keeps a record when replay fails again', async () => {
		configureWebhooks({ deadLetter: true });
		const store = getDeadLetter();
		_webhookOutById.set('w', { id: 'w', config: { url: 'http://127.0.0.1:9/x' } }); // SSRF-blocked again
		store.add({ webhookId: 'w', topic: 't', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });
		const out = await replayDeadLetter({ topic: 't' });
		expect(out.replayed).toBe(0);
		expect(out.results[0].status).toBe('failed');
		expect(store.count()).toBe(1); // kept
	});

	it('reports webhook-unregistered when the webhook no longer exists', async () => {
		configureWebhooks({ deadLetter: true });
		const store = getDeadLetter();
		store.add({ webhookId: 'gone', topic: 't', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });
		const out = await replayDeadLetter({ topic: 't' });
		expect(out.results[0].status).toBe('webhook-unregistered');
		expect(store.count()).toBe(1);
	});

	it('is a no-op when capture is off', async () => {
		const out = await replayDeadLetter({});
		expect(out).toMatchObject({ total: 0, replayed: 0, removed: 0, results: [] });
	});
});

describe('admin /dlq commands', () => {
	beforeEach(reset);

	it('GET /dlq summarizes; GET /dlq/<topic> lists; reports enabled:false when off', async () => {
		const admin = adminFor(() => true);
		// off
		const off = await admin(new Request('http://x/__realtime/dlq'));
		expect(off.status).toBe(200);
		expect(await off.json()).toMatchObject({ enabled: false, total: 0 });
		// on, with a record
		configureWebhooks({ deadLetter: true });
		getDeadLetter().add({ webhookId: 'w', topic: 'orders', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });
		const sum = await admin(new Request('http://x/__realtime/dlq'));
		expect(await sum.json()).toMatchObject({ enabled: true, total: 1, byTopic: { orders: 1 } });
		const list = await admin(new Request('http://x/__realtime/dlq/orders'));
		const body = await list.json();
		expect(body.count).toBe(1);
		expect(body.records[0]).toMatchObject({ topic: 'orders', event: 'e' });
	});

	it('POST /dlq/<topic>/replay runs a dry-run', async () => {
		configureWebhooks({ deadLetter: true });
		_webhookOutById.set('w', { id: 'w', config: { url: 'http://127.0.0.1:9/x' } });
		getDeadLetter().add({ webhookId: 'w', topic: 'orders', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });
		const admin = adminFor(() => true);
		const res = await admin(new Request('http://x/__realtime/dlq/orders/replay', {
			method: 'POST',
			body: JSON.stringify({ dryRun: true })
		}));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ dryRun: true, total: 1, results: [{ status: 'would-replay' }] });
	});

	it('rejects the wrong method (405)', async () => {
		const admin = adminFor(() => true);
		expect((await admin(new Request('http://x/__realtime/dlq', { method: 'POST' }))).status).toBe(405);
		expect((await admin(new Request('http://x/__realtime/dlq/t/replay'))).status).toBe(405); // GET on replay
	});

	it('still runs the fail-closed auth gate before any DLQ command', async () => {
		configureWebhooks({ deadLetter: true });
		const admin = adminFor(() => false);
		expect((await admin(new Request('http://x/__realtime/dlq'))).status).toBe(403);
	});

	it('is mount-prefix agnostic for DLQ paths', async () => {
		configureWebhooks({ deadLetter: true });
		const admin = adminFor(() => true);
		const res = await admin(new Request('http://x/__ops/dlq'));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ enabled: true });
	});
});

// A cluster store (Redis / Postgres) exposes the same interface but ASYNC. The
// capture, replay, and admin paths must await it. This fake async store proves
// the retrofit works without a real backend.
describe('async (cluster-shaped) dead-letter store', () => {
	beforeEach(reset);

	const asyncWrap = (s) => ({
		add: (r) => Promise.resolve(s.add(r)),
		get: (id) => Promise.resolve(s.get(id)),
		remove: (id) => Promise.resolve(s.remove(id)),
		count: (f) => Promise.resolve(s.count(f)),
		list: (f) => Promise.resolve(s.list(f)),
		summary: () => Promise.resolve(s.summary()),
		clear: () => Promise.resolve(s.clear())
	});

	it('captures through an async add (fire-and-forget)', async () => {
		const inner = createDeadLetterStore();
		configureWebhooks({ deadLetter: asyncWrap(inner) });
		await _fireWebhookOut({ id: 'w', config: { url: 'http://127.0.0.1:9/x' } }, 'orders', 'created', { id: 1 }, null);
		await new Promise((r) => setTimeout(r, 0)); // let the async add settle
		expect(inner.count()).toBe(1);
	});

	it('serves admin GET /dlq and POST replay through an async store', async () => {
		const inner = createDeadLetterStore();
		configureWebhooks({ deadLetter: asyncWrap(inner) });
		_webhookOutById.set('w', { id: 'w', config: { url: 'http://example.com/x', transform: () => null } });
		await inner.add({ webhookId: 'w', topic: 'orders', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });

		const admin = adminFor(() => true);
		const sum = await admin(new Request('http://x/__realtime/dlq'));
		expect(await sum.json()).toMatchObject({ enabled: true, total: 1 });

		const replay = await admin(new Request('http://x/__realtime/dlq/orders/replay', { method: 'POST', body: '{}' }));
		expect(await replay.json()).toMatchObject({ replayed: 1, removed: 1 });
		expect(inner.count()).toBe(0);
	});
});
