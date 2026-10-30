// Dead-letter capture keys and receipts: the capture key is the failed
// delivery's idempotency key, a keyed add is a single write per webhook no
// matter how often it is retried, the record id is the receipt every retry gets
// back, and a key is held only as long as its record.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createDeadLetterStore, configureWebhooks, getDeadLetter, setOperationalEventSink } from '../src/server.js';
import { _fireWebhookOut } from '../src/server/webhook-out.js';
import { _webhookOutById } from '../src/server/state.js';

const rec = (over = {}) => ({ webhookId: 'w', topic: 'orders', event: 'created', data: { id: 1, author: 'u1' }, attempts: 3, error: 'x', failedAt: 1, ...over });
const failingEntry = { id: 'test/wh', config: { url: 'http://127.0.0.1:9/blocked' } }; // loopback -> SSRF-blocked
const adapterKey = (topic, event, body) => createHash('sha256').update(topic + '\0' + event + '\0' + body).digest('hex');

function reset() {
	configureWebhooks({ deadLetter: false, breaker: false });
	_webhookOutById.clear();
}

describe('keyed dead-letter add', () => {
	it('returns the first receipt to a retried add and keeps one record', () => {
		const s = createDeadLetterStore();
		const first = s.add(rec({ key: 'k1' }));
		const retry = s.add(rec({ key: 'k1', attempts: 4, error: 'later', failedAt: 2 }));
		expect(retry).toBe(first);
		expect(s.count()).toBe(1);
		// First write wins for the delivery metadata.
		expect(s.get(first)).toMatchObject({ key: 'k1', attempts: 3, error: 'x', failedAt: 1 });
	});

	it('scopes a key to its webhook and tenant', () => {
		const s = createDeadLetterStore();
		const a = s.add(rec({ key: 'k', topic: '@t/acme/orders' }));
		const b = s.add(rec({ key: 'k', topic: '@t/acme/orders', webhookId: 'w2' }));
		const c = s.add(rec({ key: 'k', topic: '@t/globex/orders' }));
		expect(s.add(rec({ key: 'k', topic: '@t/acme/invoices' }))).toBe(a);
		expect(new Set([a, b, c]).size).toBe(3);
		expect(s.count()).toBe(3);
	});

	it('does not hash or encode the content of a keyed add', () => {
		const s = createDeadLetterStore();
		const id = s.add(rec({ key: 'k', data: { n: 1n } }));
		expect(s.add(rec({ key: 'k', data: { n: 2n } }))).toBe(id);
		expect(s.get(id).data).toEqual({ n: 1n });
	});

	it('rejects a malformed key', () => {
		const s = createDeadLetterStore();
		for (const key of ['', 'x'.repeat(257), 7, {}]) {
			expect(() => s.add(rec({ key }))).toThrow(/key/);
		}
		expect(s.count()).toBe(0);
	});

	it('stores unkeyed records without deduplication, as before', () => {
		const s = createDeadLetterStore();
		const a = s.add(rec());
		const b = s.add(rec());
		expect(a).not.toBe(b);
		expect(s.get(a).key).toBeNull();
		expect(s.count()).toBe(2);
	});

	it('releases a key with its record on remove, eviction and expiry', () => {
		const s = createDeadLetterStore({ max: 1 });
		const a = s.add(rec({ key: 'k' }));
		expect(s.remove(a)).toBe(true);
		const b = s.add(rec({ key: 'k' }));
		expect(b).not.toBe(a);
		s.add(rec({ key: 'other', data: 2 })); // evicts b
		expect(s.get(b)).toBeNull();
		const c = s.add(rec({ key: 'k', data: { changed: true } }));
		expect(s.get(c).data).toEqual({ changed: true });
	});

	it('erasure removes keyed records; a retry of a capture that raced the erasure stays dropped', () => {
		const s = createDeadLetterStore({ forgetUserId: ({ data }) => data.author });
		const delivered = { key: 'k', startedAt: 1 };
		const id = s.add(rec(delivered));
		expect(s.purgeUser(null, 'u1')).toBe(1);
		expect(s.get(id)).toBeNull();
		// The same capture retried after the purge: the tombstone, not the key,
		// decides, so the erased payload is not resurrected.
		expect(s.add(rec(delivered))).toBeNull();
		expect(s.count()).toBe(0);
	});
});

describe('dead-letter capture key', () => {
	beforeEach(reset);
	afterEach(() => { setOperationalEventSink(null); reset(); });

	it('is the idempotency key the adapter derives for the delivery', async () => {
		configureWebhooks({ deadLetter: true });
		const data = { b: [2, { d: null, c: 3 }], a: 1 };
		await _fireWebhookOut(failingEntry, '@t/acme/orders', 'created', data, null);
		const body = JSON.stringify({ event: 'created', data });
		expect(getDeadLetter().list()[0].key).toBe(adapterKey('@t/acme/orders', 'created', body));
	});

	it('is the HMAC key with a secret and the configured key with an idempotencyKey callback', async () => {
		configureWebhooks({ deadLetter: true });
		const secret = 's'.repeat(32);
		await _fireWebhookOut({ id: 'test/signed', config: { ...failingEntry.config, secret } }, 'orders', 'created', { id: 1 }, null);
		const material = 'orders\0created\0' + JSON.stringify({ event: 'created', data: { id: 1 } });
		expect(getDeadLetter().list().find((r) => r.webhookId === 'test/signed').key)
			.toBe(createHmac('sha256', secret).update('idem\0' + material).digest('hex'));
		await _fireWebhookOut({ id: 'test/custom', config: { ...failingEntry.config, idempotencyKey: (_e, d) => 'order-' + d.id } }, 'orders', 'created', { id: 7 }, null);
		expect(getDeadLetter().list().find((r) => r.webhookId === 'test/custom').key).toBe('order-7');
	});

	it('follows the transformed body, so events a receiver sees as one delivery are one record', async () => {
		configureWebhooks({ deadLetter: true });
		const entry = { id: 'test/tx', config: { ...failingEntry.config, transform: (event, d) => ({ event, id: d.id }) } };
		await _fireWebhookOut(entry, 'orders', 'created', { id: 1, seenAt: 1 }, null);
		await _fireWebhookOut(entry, 'orders', 'created', { id: 1, seenAt: 2 }, null);
		expect(getDeadLetter().count()).toBe(1);
		expect(getDeadLetter().list()[0].key).toBe(adapterKey('orders', 'created', JSON.stringify({ event: 'created', id: 1 })));
	});

	it('keeps payloads apart that differ only in an own __proto__ key or a boxed primitive', async () => {
		configureWebhooks({ deadLetter: true });
		await _fireWebhookOut(failingEntry, 'orders', 'created', JSON.parse('{"__proto__":{"admin":true}}'), null);
		await _fireWebhookOut(failingEntry, 'orders', 'created', {}, null);
		await _fireWebhookOut(failingEntry, 'orders', 'created', { n: new Number(1) }, null);
		await _fireWebhookOut(failingEntry, 'orders', 'created', { n: new Number(2) }, null);
		const keys = getDeadLetter().list().map((r) => r.key);
		expect(keys).toHaveLength(4);
		expect(keys.every((k) => typeof k === 'string')).toBe(true);
		expect(new Set(keys).size).toBe(4);
	});

	it('equals the idempotency-key header the receiver got', async () => {
		const seen = [];
		const server = createServer((req, res) => {
			seen.push(req.headers['idempotency-key']);
			req.resume();
			req.on('end', () => { res.writeHead(500); res.end(); });
		});
		const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
		try {
			configureWebhooks({ deadLetter: true });
			const url = `http://127.0.0.1:${port}/hook`;
			const retry = { attempts: 1, initialDelayMs: 1, maxDelayMs: 1 };
			const configs = [
				{ url, urlMode: 'off', retry },
				{ url, urlMode: 'off', retry, secret: 'x'.repeat(32), transform: (event, d) => ({ kind: event, d }) },
				{ url, urlMode: 'off', retry, idempotencyKey: async (_e, d) => 'evt-' + d.id }
			];
			for (const [i, config] of configs.entries()) {
				await _fireWebhookOut({ id: 'test/live' + i, config }, 'orders', 'created', { id: i }, null);
			}
			const keys = configs.map((_, i) => getDeadLetter().list().find((r) => r.webhookId === 'test/live' + i).key);
			expect(seen).toHaveLength(3);
			expect(keys).toEqual(seen);
			expect(keys[2]).toBe('evt-2');
		} finally {
			await new Promise((r) => server.close(r));
		}
	});

	it('derives the key when the delivery failed before the adapter asked for it', async () => {
		configureWebhooks({ deadLetter: true, breaker: { guard() { throw new Error('ejected'); }, success() {}, failure() {} } });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 3 }, null);
		expect(getDeadLetter().list()[0]).toMatchObject({ attempts: 0, key: adapterKey('orders', 'created', JSON.stringify({ event: 'created', data: { id: 3 } })) });
	});

	it('captures unkeyed when the delivery has no usable key', async () => {
		configureWebhooks({ deadLetter: true });
		const entry = { id: 'test/none', config: { ...failingEntry.config, idempotencyKey: () => null } };
		await _fireWebhookOut(entry, 'orders', 'created', { id: 1 }, null);
		await _fireWebhookOut(entry, 'orders', 'created', { id: 1 }, null);
		expect(getDeadLetter().list().map((r) => r.key)).toEqual([null, null]);
	});

	it('retries a lost reply with the same key without duplicating the record', async () => {
		const events = [];
		setOperationalEventSink((e) => events.push(e));
		const inner = createDeadLetterStore();
		const calls = [];
		let lose = true;
		configureWebhooks({ deadLetter: {
			...inner,
			add: async (r) => {
				calls.push(r);
				const id = inner.add(r); // the write commits ...
				if (lose) { lose = false; throw new Error('connection reset'); } // ... but the reply is lost
				return id;
			}
		} });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 1 }, null);
		expect(calls).toHaveLength(2);
		expect(calls[1].key).toBe(calls[0].key);
		expect(inner.count()).toBe(1);
		expect(events.filter((e) => e.event === 'webhook.dead-letter.persist-failed')).toHaveLength(0);
	});

	it('keeps one record for the same delivery captured concurrently', async () => {
		configureWebhooks({ deadLetter: true });
		await Promise.all([1, 2, 3].map(() => _fireWebhookOut(failingEntry, 'orders', 'created', { id: 9 }, null)));
		expect(getDeadLetter().count()).toBe(1);
	});

	it('keeps tenants apart when a custom idempotencyKey callback repeats a value', async () => {
		configureWebhooks({ deadLetter: true });
		const entry = { id: 'test/order-key', config: { ...failingEntry.config, idempotencyKey: (_e, d) => 'order-' + d.id } };
		await _fireWebhookOut(entry, '@t/acme/orders', 'created', { id: 1 }, null);
		await _fireWebhookOut(entry, '@t/globex/orders', 'created', { id: 1 }, null);
		expect(getDeadLetter().count()).toBe(2);
	});

	it('writes once unkeyed and reports it when the idempotencyKey callback never settles', async () => {
		const events = [];
		setOperationalEventSink((e) => events.push(e));
		configureWebhooks({ deadLetter: true });
		const entry = { id: 'test/hung', config: { ...failingEntry.config, callbackTimeoutMs: 30, idempotencyKey: () => new Promise(() => {}) } };
		const done = _fireWebhookOut(entry, 'orders', 'created', { id: 1 }, null);
		const settled = await Promise.race([done.then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
		expect(settled).toBe('done');
		expect(getDeadLetter().list().map((r) => r.key)).toEqual([null]);
		expect(events.filter((e) => e.event === 'webhook.dead-letter.key-unavailable')).toHaveLength(1);
	});

	it('keys with the config the delivery signed with', async () => {
		configureWebhooks({ deadLetter: true });
		const config = { ...failingEntry.config, secret: 'a'.repeat(32) };
		const entry = { id: 'test/rotating', config };
		await _fireWebhookOut(entry, 'orders', 'created', { id: 1 }, null);
		config.secret = 'b'.repeat(32); // a later change to the registered object
		await _fireWebhookOut(entry, 'orders', 'created', { id: 1 }, null);
		expect(getDeadLetter().count()).toBe(1);
	});

	it('keeps one record for the same failed delivery captured twice', async () => {
		configureWebhooks({ deadLetter: true });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 7 }, null);
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 7 }, null);
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 8 }, null);
		expect(getDeadLetter().count()).toBe(2);
	});
});

describe('dead-letter stores without keyed adds', () => {
	beforeEach(reset);
	afterEach(() => { setOperationalEventSink(null); reset(); });

	it('writes once and passes no key when the store does not declare keyed adds', async () => {
		const events = [];
		setOperationalEventSink((e) => events.push(e));
		// A store that ignores keys: every add inserts, and this one commits
		// before its reply is lost.
		const rows = [];
		const calls = [];
		configureWebhooks({ deadLetter: {
			add: async (r) => { calls.push(r); rows.push(r); throw new Error('connection reset'); },
			get: () => null, remove: () => false, count: () => rows.length, list: () => [], summary: () => ({ total: rows.length, byTopic: {}, oldest: null, newest: null }), purgeUser: () => 0
		} });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 1 }, null);
		expect(calls).toHaveLength(1);
		expect(rows).toHaveLength(1);
		expect(calls[0]).not.toHaveProperty('key');
		expect(events.filter((e) => e.event === 'webhook.dead-letter.persist-failed')).toHaveLength(1);
	});

	it('declares keyed adds on the built-in store', () => {
		expect(createDeadLetterStore().keyedAdd).toBe(true);
	});
});
