// Dead-letter capture keys and receipts: a keyed add is a single write no
// matter how often it is retried, the record id is the receipt every retry
// gets back, a key reused for different content is a typed conflict, and a key
// is held only as long as its record.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createDeadLetterStore, configureWebhooks, getDeadLetter, setOperationalEventSink } from '../src/server.js';
import { _fireWebhookOut } from '../src/server/webhook-out.js';
import { _webhookOutById } from '../src/server/state.js';

const rec = (over = {}) => ({ webhookId: 'w', topic: 'orders', event: 'created', data: { id: 1, author: 'u1' }, attempts: 3, error: 'x', failedAt: 1, ...over });
const failingEntry = { id: 'test/wh', config: { url: 'http://127.0.0.1:9/blocked' } }; // loopback -> SSRF-blocked

function reset() {
	configureWebhooks({ deadLetter: false });
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

	it('gives concurrent identical adds one record and the same receipt', async () => {
		const s = createDeadLetterStore();
		const ids = await Promise.all([1, 2, 3].map(() => Promise.resolve().then(() => s.add(rec({ key: 'same' })))));
		expect(new Set(ids).size).toBe(1);
		expect(s.count()).toBe(1);
	});

	it('treats objects with reordered keys as the same content', () => {
		const s = createDeadLetterStore();
		const a = s.add(rec({ key: 'k', data: { b: 2, a: { y: 1, x: [1, { q: 1, p: 2 }] } } }));
		const b = s.add(rec({ key: 'k', data: { a: { x: [1, { p: 2, q: 1 }], y: 1 }, b: 2 } }));
		expect(b).toBe(a);
	});

	it('rejects the same key with different content as a typed conflict and keeps the original', () => {
		const s = createDeadLetterStore();
		const id = s.add(rec({ key: 'k' }));
		for (const change of [{ data: { id: 2, author: 'u1' } }, { event: 'updated' }, { topic: 'other' }, { webhookId: 'w2' }]) {
			expect(() => s.add(rec({ key: 'k', ...change }))).toThrow(expect.objectContaining({ code: 'DEAD_LETTER_KEY_CONFLICT' }));
		}
		expect(s.count()).toBe(1);
		expect(s.get(id).data).toEqual({ id: 1, author: 'u1' });
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
		const c = s.add(rec({ key: 'k', data: { changed: true } })); // no conflict once released
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

	it('derives the key from the delivery identity as sha256 over canonical JSON', async () => {
		const seen = [];
		const s = createDeadLetterStore();
		const add = s.add.bind(s);
		s.add = (r) => { seen.push(r); return add(r); };
		configureWebhooks({ deadLetter: s });
		await _fireWebhookOut(failingEntry, '@t/acme/orders', 'created', { b: [2, { d: null, c: 3 }], a: 1 }, null);
		const expected = createHash('sha256')
			.update('["test/wh","@t/acme/orders","created",{"a":1,"b":[2,{"c":3,"d":null}]}]')
			.digest('hex');
		expect(seen).toHaveLength(1);
		expect(seen[0].key).toBe(expected);
		expect(s.list()[0].key).toBe(expected);
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

	it('does not retry a key conflict', async () => {
		const events = [];
		setOperationalEventSink((e) => events.push(e));
		let calls = 0;
		const s = createDeadLetterStore();
		configureWebhooks({ deadLetter: { ...s, add: () => { calls++; throw Object.assign(new Error('conflict'), { code: 'DEAD_LETTER_KEY_CONFLICT' }); } } });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 1 }, null);
		expect(calls).toBe(1);
		expect(events.filter((e) => e.event === 'webhook.dead-letter.persist-failed')).toHaveLength(1);
	});

	it('keeps one record for the same failed delivery captured twice', async () => {
		configureWebhooks({ deadLetter: true });
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 7 }, null);
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 7 }, null);
		await _fireWebhookOut(failingEntry, 'orders', 'created', { id: 8 }, null);
		expect(getDeadLetter().count()).toBe(2);
	});
});
