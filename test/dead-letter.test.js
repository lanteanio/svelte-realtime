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
import { monotonicNow, setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { _fireWebhookOut } from '../src/server/webhook-out.js';
import { state, _webhookOutById } from '../src/server/state.js';
import { setOperationalEventSink } from '../src/shared/diagnostic.js';

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

	it('forget tombstone: drops a record whose delivery raced a purge; keeps a new one and other users', () => {
		const s = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
		// live.forget(u1) runs against an empty store, setting a tombstone.
		expect(s.purgeUser(null, 'u1')).toBe(0);
		// A delivery that STARTED before the forget now fails and would be captured.
		// Its payload is the erased user's, so it must be dropped (returns null).
		const dropped = s.add({ webhookId: 'w', topic: 'orders', event: 'created', data: { author: 'u1', body: 'PII' }, attempts: 3, error: 'x', failedAt: Date.now(), startedAt: 1000 });
		expect(dropped).toBeNull();
		expect(s.count()).toBe(0);
		// A genuinely NEW u1 delivery that started AFTER the forget is retained.
		const later = Date.now() + 3600000;
		const kept = s.add({ webhookId: 'w', topic: 'orders', event: 'created', data: { author: 'u1', body: 'new' }, attempts: 3, error: 'x', failedAt: later + 1, startedAt: later });
		expect(kept).not.toBeNull();
		expect(s.count()).toBe(1);
		// A different user's in-flight delivery is unaffected by u1's tombstone.
		const other = s.add({ webhookId: 'w', topic: 'orders', event: 'created', data: { author: 'u2', body: 'x' }, attempts: 3, error: 'x', failedAt: Date.now(), startedAt: 1000 });
		expect(other).not.toBeNull();
		expect(s.count()).toBe(2);
	});

	it('forget tombstone uses MONOTONIC time: a backward wall-clock step cannot resurrect an in-flight delivery', () => {
		let mono = 1000;
		let wall = 1000; // wall and monotonic aligned at delivery start
		setRuntimeEnv({ clock: { now: () => wall, monotonic: () => mono, wallEpoch: () => wall } });
		try {
			const s = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
			const startedAt = monotonicNow(); // 1000 - an in-flight delivery's start
			// A backward NTP step drags WALL below the delivery's start while MONOTONIC
			// keeps advancing; live.forget(u1) runs now.
			wall = 500;   // stepped back, below the wall time the delivery started at
			mono = 2000;  // monotonic moves forward
			s.purgeUser(null, 'u1'); // monotonic tomb = 2000 (a wall tomb would be 500)
			// The in-flight delivery fails and is captured. A wall tombstone (500 >= 1000)
			// is FALSE and would RETAIN the erased user's PII; monotonic (2000 >= 1000) drops it.
			const dropped = s.add({ webhookId: 'w', topic: 'o', event: 'e', data: { author: 'u1', body: 'PII' }, attempts: 3, error: 'x', failedAt: wall, startedAt });
			expect(dropped).toBeNull();
			expect(s.count()).toBe(0);
			// A genuinely NEW u1 delivery that starts AFTER the purge (monotonic 3000) is
			// still kept - the drop is scoped to in-flight deliveries, and monotonic's
			// sub-ms precision keeps a just-after start distinct from the purge instant
			// (the ~1s-cached wall clock could otherwise collide them and over-drop it).
			mono = 3000;
			const kept = s.add({ webhookId: 'w', topic: 'o', event: 'e', data: { author: 'u1', body: 'new' }, attempts: 3, error: 'x', failedAt: wall, startedAt: monotonicNow() });
			expect(kept).not.toBeNull();
			expect(s.count()).toBe(1);
		} finally {
			resetRuntimeEnv();
		}
	});

	it('forget tombstone: without a forgetUserId extractor, records are unattributable and never tombstone-dropped', () => {
		const s = createDeadLetterStore(); // no extractor
		s.purgeUser(null, 'u1');
		const id = s.add({ webhookId: 'w', topic: 'orders', event: 'created', data: { author: 'u1' }, attempts: 1, error: 'x', failedAt: Date.now(), startedAt: 1000 });
		expect(id).not.toBeNull(); // unattributable -> retained (documented limitation)
		expect(s.count()).toBe(1);
	});
});

describe('createDeadLetterStore - tenant-scoped erasure', () => {
	const rec = (topic, author, extra = {}) => ({ webhookId: 'w', topic, event: 'e', data: { author }, attempts: 3, error: 'x', failedAt: Date.now(), ...extra });

	it('purges only records whose topic is inside the tenant scope', () => {
		const s = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
		const a = s.add(rec('@t/a/orders', 'u1'));
		const b = s.add(rec('@t/b/orders', 'u1'));
		const plain = s.add(rec('orders', 'u1'));
		const other = s.add(rec('@t/a/orders', 'u2'));
		// A tenant id that is a prefix of another tenant's id does not reach it.
		const prefixed = s.add(rec('@t/ab/orders', 'u1'));
		expect(s.purgeUser('a', 'u1')).toBe(1);
		expect(s.get(a)).toBeNull();
		expect(s.get(b)).not.toBeNull();
		expect(s.get(plain)).not.toBeNull();
		expect(s.get(other)).not.toBeNull();
		expect(s.get(prefixed)).not.toBeNull();
		// The null scope reaches untenanted topics only.
		expect(s.purgeUser(null, 'u1')).toBe(1);
		expect(s.get(plain)).toBeNull();
		expect(s.get(b)).not.toBeNull();
		expect(s.get(prefixed)).not.toBeNull();
	});

	it('a purge tombstone suppresses late captures only inside its own tenant scope', () => {
		const s = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
		expect(s.purgeUser('a', 'u1')).toBe(0);
		// In flight across the purge, same tenant: dropped.
		expect(s.add(rec('@t/a/orders', 'u1', { startedAt: 0 }))).toBeNull();
		// Equal userId, other tenant or untenanted: retained.
		expect(s.add(rec('@t/b/orders', 'u1', { startedAt: 0 }))).not.toBeNull();
		expect(s.add(rec('orders', 'u1', { startedAt: 0 }))).not.toBeNull();
		expect(s.count()).toBe(2);
		// A null-scope purge tombstones untenanted captures and leaves tenants alone.
		s.purgeUser(null, 'u2');
		expect(s.add(rec('orders', 'u2', { startedAt: 0 }))).toBeNull();
		expect(s.add(rec('@t/a/orders', 'u2', { startedAt: 0 }))).not.toBeNull();
	});

	it('keeps tombstones apart for user ids that contain delimiter characters', () => {
		const s = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
		// A joined scope+user key would let tenant "a" + user "b" collide with the
		// untenanted user "a<NUL>b"; the scopes must stay separate.
		s.purgeUser('a', 'b');
		const sep = String.fromCharCode(0);
		expect(s.add(rec('orders', 'a' + sep + 'b', { startedAt: 0 }))).not.toBeNull();
		expect(s.add(rec('orders', 'a/b', { startedAt: 0 }))).not.toBeNull();
	});

	it('rejects a non-string tenant id', () => {
		const s = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
		expect(() => s.purgeUser(/** @type {any} */ (5), 'u1')).toThrow();
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

	it('_fireWebhookOut threads the delivery start time into the store (for the forget tombstone)', async () => {
		const store = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
		let capturedRec = null;
		const origAdd = store.add.bind(store);
		store.add = (rec) => { capturedRec = rec; return origAdd(rec); };
		configureWebhooks({ deadLetter: store });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { author: 'u1' }, null);
		expect(capturedRec).not.toBeNull();
		expect(typeof capturedRec.startedAt).toBe('number');
		expect(capturedRec.startedAt).toBeGreaterThan(0);
		// startedAt is a MONOTONIC stamp (the step-immune forget tombstone reads it),
		// captured at delivery start, so it is at or before the current monotonic time.
		// failedAt is a separate WALL stamp (operator-facing record age) and is NOT
		// comparable to startedAt across clock domains.
		expect(capturedRec.startedAt).toBeLessThanOrEqual(monotonicNow());
		expect(typeof capturedRec.failedAt).toBe('number');
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

describe('replayDeadLetter - bounded calls', () => {
	beforeEach(reset);
	const OK = 'ok';     // transform opt-out: replay "delivers" without a socket
	const BAD = 'bad';   // loopback url: SSRF-blocked, replay fails and keeps the record
	function seed(kinds) {
		configureWebhooks({ deadLetter: createDeadLetterStore({ max: 5000 }) });
		_webhookOutById.set(OK, { id: OK, config: { url: 'http://example.com/x', transform: () => null } });
		_webhookOutById.set(BAD, { id: BAD, config: { url: 'http://127.0.0.1:9/x' } });
		const store = getDeadLetter();
		return { store, ids: kinds.map((kind) => store.add({ webhookId: kind, topic: 't', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 })) };
	}

	it('replays at most 100 records by default; calling again continues with what remains', async () => {
		const { store } = seed(Array(250).fill(OK));
		const first = await replayDeadLetter({ topic: 't' });
		expect(first.total).toBe(100);
		expect(first.replayed).toBe(100);
		expect(first.results).toHaveLength(100);
		expect('next' in first).toBe(false);
		expect(store.count()).toBe(150);
		const second = await replayDeadLetter({ topic: 't', limit: 1000 });
		expect(second.replayed).toBe(150);
		expect(store.count()).toBe(0);
	});

	it('bounds a call even when the store returns more than the limit', async () => {
		const { store } = seed(Array(5).fill(OK));
		const list = store.list.bind(store);
		store.list = (filter) => list({ ...filter, limit: 1000 });
		const out = await replayDeadLetter({ topic: 't', limit: 2 });
		expect(out.total).toBe(2);
		expect(store.count()).toBe(3);
	});

	it('limits a dry run without removing anything', async () => {
		const { store } = seed([OK, OK, OK]);
		const out = await replayDeadLetter({ topic: 't', dryRun: true, limit: 2 });
		expect(out.results.map((r) => r.status)).toEqual(['would-replay', 'would-replay']);
		expect(store.count()).toBe(3);
	});

	it('replays named ids only, within the topic', async () => {
		const { store, ids } = seed([OK, OK, OK]);
		store.add({ webhookId: OK, topic: 'other', event: 'e', data: 1, attempts: 3, error: 'x', failedAt: 1 });
		const out = await replayDeadLetter({ topic: 't', ids: [ids[0], ids[2], 'missing'] });
		expect(out.results.map((r) => r.id).sort()).toEqual([ids[0], ids[2]].sort());
		expect(store.count()).toBe(2);
	});

	it('keeps failed records at the head; named ids reach the records behind them, ignoring limit', async () => {
		const { store, ids } = seed([OK, OK, BAD, BAD, BAD]);
		for (let call = 0; call < 2; call++) {
			const out = await replayDeadLetter({ topic: 't', limit: 3 });
			expect(out.results.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
			expect(out.replayed).toBe(0);
		}
		const out = await replayDeadLetter({ topic: 't', ids: [ids[0], ids[1]], limit: 1 });
		expect(out.replayed).toBe(2);
		expect(store.count()).toBe(3);
	});

	it('rejects an out-of-range limit, an oversized or malformed id list, and a bad initiator', async () => {
		seed([OK]);
		for (const opts of [
			{ limit: 1001 }, { limit: 0 }, { limit: 1.5 }, { limit: '10' },
			{ ids: Array.from({ length: 1001 }, (_, i) => String(i)) }, { ids: 'x' }, { ids: [1] }, { ids: [''] },
			{ initiator: '' }, { initiator: 'x'.repeat(129) }
		]) {
			await expect(replayDeadLetter(/** @type {any} */ (opts))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		}
		expect(getDeadLetter().count()).toBe(1);
	});

	it('reports the initiator and counts as an operational event', async () => {
		seed([OK, BAD, OK]);
		const events = [];
		const restore = setOperationalEventSink((record) => { events.push(record); });
		try {
			await replayDeadLetter({ topic: 't', initiator: 'nightly-job', limit: 2 });
		} finally {
			restore();
		}
		expect(events).toContainEqual(expect.objectContaining({
			event: 'webhook.dead-letter.replayed',
			attributes: { initiator: 'nightly-job', dryRun: false, byIds: false, total: 2, replayed: 1, removed: 1, failed: 1, unregistered: 0 }
		}));
	});

	it('admin replay honours limit, audits as admin, and answers 400 on bad input', async () => {
		seed([OK, OK, OK]);
		const admin = adminFor(() => true);
		const events = [];
		const restore = setOperationalEventSink((record) => { events.push(record); });
		let first;
		try {
			const res = await admin(new Request('http://x/__realtime/dlq/t/replay', { method: 'POST', body: JSON.stringify({ limit: 2 }) }));
			expect(res.status).toBe(200);
			first = await res.json();
		} finally {
			restore();
		}
		expect(first.total).toBe(2);
		expect(events).toContainEqual(expect.objectContaining({ event: 'webhook.dead-letter.replayed', attributes: expect.objectContaining({ initiator: 'admin' }) }));
		for (const body of [{ limit: 5000 }, { ids: 'x' }, { limit: 'all' }]) {
			const bad = await admin(new Request('http://x/__realtime/dlq/t/replay', { method: 'POST', body: JSON.stringify(body) }));
			expect(bad.status).toBe(400);
		}
		expect(getDeadLetter().count()).toBe(1);
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
