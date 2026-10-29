// @ts-check
// In-memory dead-letter store for undeliverable outbound webhooks. When a
// webhook delivery exhausts its retries (or is blocked by the SSRF gate, loops,
// etc.), `_fireWebhookOut` retains the event here so an operator can inspect it
// and replay it once the endpoint recovers - instead of the event being reported
// then dropped. Opt-in (a DLQ retains attacker-influenced event data): wire it
// with `realtime({ webhooks: { deadLetter: true } })` or
// `configureWebhooks({ deadLetter })`. A cluster deployment passes a durable
// store instance (Redis / Postgres) with the same interface.

import { createHash } from 'node:crypto';
import { now, monotonicNow } from '../shared/runtime.js';
import { _TENANT_TOPIC_NS, _topicInTenant } from './tenant.js';
import { LiveError } from './live-error.js';

// A forget tombstone lives long enough to catch a webhook delivery that was
// already in flight when `live.forget` ran and only fails (and would be
// captured) AFTER the purge swept the store. Sized well above a normal retry
// budget; a single delivery whose total duration (initial attempt + all
// backoff) exceeds this is a narrow documented residual.
const _DEAD_LETTER_TOMBSTONE_MS = 10 * 60 * 1000;

// Tombstone map key for the untenanted scope. A valid tenant id is non-empty, so
// the empty string can never collide with a real tenant.
const _NULL_SCOPE = '';

/**
 * The tenant scope a wire topic belongs to: the tenant id of an `@t/<id>/...`
 * topic, `_NULL_SCOPE` for an untenanted topic, or `undefined` for a malformed
 * `@t/` topic that no scope contains (the same partition `_topicInTenant`
 * draws, so a tombstone lookup and a purge scan always agree).
 * @param {string} topic
 * @returns {string | undefined}
 */
function _topicScope(topic) {
	if (typeof topic !== 'string' || !topic.startsWith(_TENANT_TOPIC_NS)) return _NULL_SCOPE;
	const slash = topic.indexOf('/', _TENANT_TOPIC_NS.length);
	return slash > _TENANT_TOPIC_NS.length ? topic.slice(_TENANT_TOPIC_NS.length, slash) : undefined;
}

const _MAX_KEY_LENGTH = 256;

/** @param {string} _k @param {unknown} v */
function _sortedKeys(_k, v) {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const k of Object.keys(v).sort()) out[k] = /** @type {any} */ (v)[k];
	return out;
}

/**
 * Content fingerprint of a dead-letter capture: lowercase hex SHA-256 over the
 * JSON array `[webhookId, topic, event, data]` with every plain object's keys
 * sorted (JavaScript default sort). The capture path uses it as the record key,
 * so one failed delivery is one record however often its capture is retried or
 * repeated, and a store compares it to tell an identical retry from a
 * conflicting reuse of a key. Durable stores compute the same value from the
 * value they were handed, never from a database round trip. Throws for content
 * JSON cannot encode (a BigInt, a cycle).
 * @param {{ webhookId: string, topic: string, event: string, data: unknown }} rec
 * @returns {string}
 */
export function _deadLetterFingerprint(rec) {
	return createHash('sha256')
		.update(JSON.stringify([rec.webhookId, rec.topic, rec.event, rec.data], _sortedKeys))
		.digest('hex');
}

/** @param {unknown} key */
function _validKey(key) {
	if (typeof key !== 'string' || key.length === 0 || key.length > _MAX_KEY_LENGTH) {
		throw new TypeError('dead-letter: key must be a non-empty string of at most ' + _MAX_KEY_LENGTH + ' characters');
	}
	return key;
}

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
 * @property {{ traceparent: string, tracestate?: string } | null} traceContext
 *   W3C context captured for a later replay.
 * @property {string | null} userId - The authoring userId extracted at capture time
 *   by the store's `forgetUserId` option (null when unset or not extractable).
 *   Right-to-erasure attribution: the event payload is app-defined, so the store
 *   cannot tell whose event a record holds without the extractor.
 * @property {string | null} key - The capture key the record was added under
 *   (null for an unkeyed add). Held only while the record is retained.
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
	/** @type {Map<string, { id: string, fingerprint: string }>} capture key -> its record */
	const keys = new Map();
	let seq = 0;
	// Forget tombstones: the most recent purge time per (tenant scope, authoring
	// userId). A record whose delivery was already in flight when `live.forget`
	// ran (started before the purge, fails after it) is captured by `add` AFTER
	// the purge scanned the store, so without this it would resurrect the
	// forgotten user's event. Mirrors the idempotency store's racing-commit
	// tombstone. Keyed by scope as well as user so erasing a user in one tenant
	// never suppresses a late capture for an equal userId in another tenant.
	// Nested maps rather than a joined string key: an extracted userId is app
	// data and may contain any delimiter. Swept by age so the maps stay bounded
	// to recent erasures.
	/** @type {Map<string, Map<string, number>>} tenant scope -> authoring userId -> last purge time (monotonic ms) */
	const purgedAt = new Map();

	// Drop expired records on access. O(n) over a bounded store; webhook failures
	// are rare, so this is never a hot path. No reliance on monotone time - a
	// backward clock jump simply keeps a record a little longer.
	function _expire() {
		if (!ttlMs) return;
		const cutoff = now() - ttlMs;
		for (const [id, rec] of records) {
			if (rec.failedAt < cutoff) _drop(id, rec);
		}
	}

	// Every removal path goes through here so a key never outlives its record.
	/** @param {string} id @param {DeadLetterRecord} rec */
	function _drop(id, rec) {
		records.delete(id);
		if (rec.key !== null) keys.delete(rec.key);
	}

	// Drop tombstones older than the window: any delivery in flight across such an
	// old purge has long since failed-and-been-dropped or succeeded, so the
	// tombstone has done its job. Keeps the map bounded to recent erasures.
	function _sweepTombstones() {
		if (purgedAt.size === 0) return;
		const cutoff = monotonicNow() - _DEAD_LETTER_TOMBSTONE_MS;
		for (const [scope, users] of purgedAt) {
			for (const [u, t] of users) {
				if (t < cutoff) users.delete(u);
			}
			if (users.size === 0) purgedAt.delete(scope);
		}
	}

	return {
		/**
		 * Retain an undeliverable event. Returns the record id (the receipt), or
		 * `null` when a forget tombstone drops the record (its delivery was in
		 * flight when `live.forget` ran). Evicts the oldest record when over `max`.
		 * With a `key`, the add is idempotent while the keyed record is retained: a
		 * repeat with the same content returns the original id and changes nothing,
		 * and a repeat with different content throws `DEAD_LETTER_KEY_CONFLICT`.
		 * @param {Omit<DeadLetterRecord, 'id' | 'userId' | 'key'> & { key?: string | null, startedAt?: number }} rec
		 *   `startedAt` is the delivery start time as a MONOTONIC stamp (threaded by
		 *   `_fireWebhookOut` via `monotonicNow`); used only for the forget-race
		 *   tombstone, never stored.
		 * @returns {string | null}
		 */
		add(rec) {
			const key = rec.key == null ? null : _validKey(rec.key);
			const fingerprint = key === null ? null : _deadLetterFingerprint(rec);
			_expire();
			_sweepTombstones();
			// Extract the authoring userId FIRST so a forget tombstone can drop a
			// record whose delivery raced a purge. purgeUser scans only records
			// already present, so a late-arriving in-flight capture would otherwise
			// resurrect the forgotten user's event past a confirmed erasure.
			let userId = null;
			if (forgetUserId) {
				try {
					const u = forgetUserId({ topic: rec.topic, event: rec.event, data: rec.data });
					if (typeof u === 'string' && u.length > 0) userId = u;
				} catch { /* extractor best-effort */ }
			}
			if (userId !== null) {
				const scope = _topicScope(rec.topic);
				const tomb = scope === undefined ? undefined : purgedAt.get(scope)?.get(userId);
				// The delivery began at rec.startedAt (a MONOTONIC stamp threaded by
				// `_fireWebhookOut`). A purge at-or-after the delivery start means
				// live.forget ran while this delivery was in flight, so dropping the
				// record completes the erasure (the same at-or-before-acquire test the
				// idempotency store applies to a racing commit). Both sides are monotonic
				// so the comparison is step-immune. A caller that does not thread
				// startedAt falls back to the current monotonic time (never the wall
				// `failedAt`, which would mix clock domains): an unattributed start is
				// treated as "now", so it is not tombstoned - the pre-fix direction for
				// that untraced path, never a raw-PII drop nor a resurrection.
				const startedAt = typeof rec.startedAt === 'number' ? rec.startedAt : monotonicNow();
				if (tomb !== undefined && tomb >= startedAt) return null;
			}
			if (key !== null) {
				const held = keys.get(key);
				if (held !== undefined) {
					if (held.fingerprint === fingerprint) return held.id;
					throw new LiveError('DEAD_LETTER_KEY_CONFLICT', 'dead-letter: the key is already held by a record with different content');
				}
			}
			const id = String(++seq);
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
				traceContext: rec.traceContext ?? null,
				userId,
				key
			};
			records.set(id, record);
			if (key !== null && fingerprint !== null) keys.set(key, { id, fingerprint });
			while (records.size > max) {
				const oldest = records.entries().next().value;
				if (oldest === undefined) break;
				_drop(oldest[0], oldest[1]);
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
			const rec = records.get(id);
			if (rec === undefined) return false;
			_drop(id, rec);
			return true;
		},

		/**
		 * Right-to-erasure purge: drop every record inside the tenant scope whose
		 * capture-time `userId` stamp matches. The scope is the record's topic,
		 * the same rule the durable stores apply: a tenantId matches only topics
		 * under that tenant's `@t/<id>/` namespace, and `null` matches only
		 * untenanted topics, so an equal userId in another tenant survives.
		 * Records captured without a `forgetUserId` extractor carry no stamp and
		 * are not user-attributable (documented limitation, same contract as the
		 * durable stores). O(n) over the bounded ring.
		 * @param {string | null} tenantId
		 * @param {string} userId
		 * @returns {number}
		 */
		purgeUser(tenantId, userId) {
			if (typeof userId !== 'string' || userId.length === 0) return 0;
			if (tenantId != null && typeof tenantId !== 'string') {
				throw new Error('dead-letter: purgeUser tenantId must be a string or null');
			}
			// Same falsy-is-untenanted reading as `_topicInTenant`, so the purge
			// scan and the tombstone always name one scope.
			if (!tenantId) tenantId = null;
			// Tombstone FIRST: a delivery already in flight when this purge runs is
			// captured (add) only after we return, so record the purge time so that
			// late add() drops it. Recorded even with zero matching records - the
			// in-flight delivery may fail moments later. The purge time and the
			// delivery start time are both MONOTONIC (runtime `monotonicNow`): a
			// backward wall-clock step (NTP correction) could otherwise make
			// purgeTime < startedAt and resurrect the erased user's payload, and the
			// ~1s-cached wall clock could stamp a purge and a genuinely-later new
			// delivery identically and over-drop the new one. Monotonic time is
			// step-immune and sub-ms, closing both.
			const scope = tenantId === null ? _NULL_SCOPE : tenantId;
			let users = purgedAt.get(scope);
			if (users === undefined) purgedAt.set(scope, users = new Map());
			users.set(userId, monotonicNow());
			_sweepTombstones();
			let n = 0;
			for (const [id, rec] of records) {
				if (rec.userId === userId && _topicInTenant(tenantId, rec.topic)) {
					_drop(id, rec);
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
			keys.clear();
			purgedAt.clear();
		}
	};
}
