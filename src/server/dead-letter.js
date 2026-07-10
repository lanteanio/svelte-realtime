// @ts-check
// In-memory dead-letter store for undeliverable outbound webhooks. When a
// webhook delivery exhausts its retries (or is blocked by the SSRF gate, loops,
// etc.), `_fireWebhookOut` retains the event here so an operator can inspect it
// and replay it once the endpoint recovers - instead of the event being reported
// then dropped. Opt-in (a DLQ retains attacker-influenced event data): wire it
// with `realtime({ webhooks: { deadLetter: true } })` or
// `configureWebhooks({ deadLetter })`. A cluster deployment passes a durable
// store instance (Redis / Postgres) with the same interface.

import { now } from '../shared/runtime.js';

/**
 * @typedef {object} DeadLetterRecord
 * @property {string} id - Monotonic per-store record id.
 * @property {string} webhookId - The outbound-webhook registration path (for replay lookup).
 * @property {string} topic - The source topic whose publish triggered the webhook.
 * @property {string} event - The event name.
 * @property {unknown} data - The original event payload (needed to replay).
 * @property {number} attempts - Delivery attempts made (0 = a config / gate failure, never sent).
 * @property {string} error - The redacted terminal error message.
 * @property {number} failedAt - Wall-clock ms (runtime seam) when the delivery gave up.
 * @property {string | null} userId - The authoring userId extracted at capture time
 *   by the store's `forgetUserId` option (null when unset or not extractable).
 *   Right-to-erasure attribution: the event payload is app-defined, so the store
 *   cannot tell whose event a record holds without the extractor.
 */

/**
 * Create an in-memory dead-letter store: a bounded, insertion-ordered ring with
 * an optional TTL. The default store. A cluster deployment substitutes a durable
 * store exposing the same methods.
 *
 * @param {{ max?: number, ttlMs?: number }} [options] - `max` caps retained
 *   records (oldest evicted first; default 1000); `ttlMs` drops records older
 *   than the TTL on access (default 0 = no TTL).
 */
export function createDeadLetterStore(options = {}) {
	const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 1000;
	const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 0;
	if (options.forgetUserId !== undefined && typeof options.forgetUserId !== 'function') {
		throw new Error('dead-letter: forgetUserId must be a function ({ topic, event, data }) => userId');
	}
	// Right-to-erasure: a retained event payload is app-defined, so the store
	// cannot tell whose event it holds. When set, this extracts the authoring
	// userId at capture time so `live.forget` can drop the forgotten user's
	// dead-lettered events (else a later replay re-emits them). Unset =>
	// records are not user-purgeable (same contract as the durable stores'
	// forgetUserId option).
	const forgetUserId = options.forgetUserId;
	/** @type {Map<string, DeadLetterRecord>} insertion-ordered */
	const records = new Map();
	let seq = 0;

	// Drop expired records on access. O(n) over a bounded store; webhook failures
	// are rare, so this is never a hot path. No reliance on monotone time - a
	// backward clock jump simply keeps a record a little longer.
	function _expire() {
		if (!ttlMs) return;
		const cutoff = now() - ttlMs;
		for (const [id, rec] of records) {
			if (rec.failedAt < cutoff) records.delete(id);
		}
	}

	return {
		/**
		 * Retain an undeliverable event. Returns the new record id. Evicts the
		 * oldest record when over `max`.
		 * @param {Omit<DeadLetterRecord, 'id'>} rec
		 * @returns {string}
		 */
		add(rec) {
			_expire();
			const id = String(++seq);
			let userId = null;
			if (forgetUserId) {
				try {
					const u = forgetUserId({ topic: rec.topic, event: rec.event, data: rec.data });
					if (typeof u === 'string' && u.length > 0) userId = u;
				} catch { /* extractor best-effort */ }
			}
			/** @type {DeadLetterRecord} */
			const record = {
				id,
				webhookId: rec.webhookId,
				topic: rec.topic,
				event: rec.event,
				data: rec.data,
				attempts: rec.attempts | 0,
				error: rec.error,
				failedAt: typeof rec.failedAt === 'number' ? rec.failedAt : now(),
				userId
			};
			records.set(id, record);
			while (records.size > max) {
				const oldest = records.keys().next().value;
				if (oldest === undefined) break;
				records.delete(oldest);
			}
			return id;
		},

		/** @param {string} id @returns {DeadLetterRecord | null} */
		get(id) {
			_expire();
			return records.get(id) || null;
		},

		/** @param {string} id @returns {boolean} */
		remove(id) {
			return records.delete(id);
		},

		/**
		 * Right-to-erasure purge: drop every record whose capture-time `userId`
		 * stamp matches. Records captured without a `forgetUserId` extractor
		 * carry no stamp and are not user-attributable (documented limitation,
		 * same contract as the durable stores). O(n) over the bounded ring.
		 * The `tenantId` parameter exists for signature parity with the
		 * durable-store seam; the in-memory stamp is already the app's own id.
		 * @param {string | null} _tenantId
		 * @param {string} userId
		 * @returns {number}
		 */
		purgeUser(_tenantId, userId) {
			if (typeof userId !== 'string' || userId.length === 0) return 0;
			let n = 0;
			for (const [id, rec] of records) {
				if (rec.userId === userId) {
					records.delete(id);
					n++;
				}
			}
			return n;
		},

		/**
		 * Count retained records, optionally for one topic.
		 * @param {{ topic?: string }} [filter]
		 * @returns {number}
		 */
		count(filter) {
			_expire();
			if (!filter || filter.topic === undefined) return records.size;
			let n = 0;
			for (const rec of records.values()) if (rec.topic === filter.topic) n++;
			return n;
		},

		/**
		 * List retained records newest-first, optionally for one topic, capped by
		 * `limit` (default 100).
		 * @param {{ topic?: string, limit?: number }} [filter]
		 * @returns {DeadLetterRecord[]}
		 */
		list(filter = {}) {
			_expire();
			const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 100;
			const all = [...records.values()];
			const out = [];
			for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
				if (filter.topic === undefined || all[i].topic === filter.topic) out.push(all[i]);
			}
			return out;
		},

		/**
		 * Counts-only summary: total, per-topic counts, and the oldest / newest
		 * `failedAt`. No event data - cheap and PII-light for a dashboard tile.
		 * @returns {{ total: number, byTopic: Record<string, number>, oldest: number | null, newest: number | null }}
		 */
		summary() {
			_expire();
			/** @type {Record<string, number>} */
			const byTopic = {};
			let oldest = null;
			let newest = null;
			for (const rec of records.values()) {
				byTopic[rec.topic] = (byTopic[rec.topic] || 0) + 1;
				if (oldest === null || rec.failedAt < oldest) oldest = rec.failedAt;
				if (newest === null || rec.failedAt > newest) newest = rec.failedAt;
			}
			return { total: records.size, byTopic, oldest, newest };
		},

		clear() {
			records.clear();
		}
	};
}
