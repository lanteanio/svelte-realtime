// @ts-check
//
// `live.forget(userId, opts)`: right-to-erasure. A connection-less server
// action (a sibling of `live.cron` / `live.push`) that purges every trace of a
// user across the framework's in-memory state AND any wired durable store,
// scoped to one tenant. It is NOT reachable from the wire - the app calls it
// from trusted server code, so the app owns the "should this user be erased"
// authorization at the call site. It erases data at rest; it does not forcibly
// disconnect the user (do that from the `onForget` hook or your own socket
// handling if you want the session to end too).
//
// The cascade is a DESCRIPTOR TABLE: one auditable list of `{ name, run }`
// entries, so the purge surface is reviewable in one place and a test fails if
// a known user-keyed in-memory store has no descriptor (forget-completeness -
// a missed store is residual PII). Durable cluster stores (Redis / Postgres)
// ride the pluggable `store` seam, exactly like `live.alarm({ store })` /
// `live.idempotent({ store })`; the realtime layer never imports the durable
// store, it only duck-types `store.purgeUser`.

import { _IS_DEV } from './env.js';
import { wallEpoch } from '../shared/runtime.js';
import { _enterInFlight, _exitInFlight } from './lifecycle.js';
import { _validTenantId, _tenantKey } from './tenant.js';
import { _validIdReason, _MAX_USER_ID_LENGTH } from './validate.js';
import { LiveError } from './live-error.js';
import { createHash } from 'node:crypto';
import { _purgePushUser } from './push.js';
import { _purgePresenceUser, _ownerReplayPublisher } from './presence.js';
import { _purgeRateLimitUser } from './rate-limit.js';
import { _purgeIdempotencyUser } from './idempotency.js';
import { _purgeSmoothUser } from './smooth.js';
import { _purgeAggregateCohorts } from './reactive.js';
import { _purgeCrdtDocs } from './crdt.js';
import { _ownerEmit } from './room-owner.js';
import { state } from './state.js';

/**
 * Optional durable forget store (default null = in-memory state only). A wired
 * store erases the user's durable cluster rows (Redis registry / presence /
 * cursor / session / idempotency, Postgres idempotency, ...). Duck-typed:
 * `purgeUser(tenantId, userId, cascade)` returns rows removed as a number, a
 * per-store breakdown object, OR the richer owner-succession envelope
 * `{ rowsAffected?, ownerSuccessions? }`. The envelope (detected by an
 * `ownerSuccessions` array) carries the `:owner` changes the store's cluster-wide
 * owner eviction produced for rooms this instance could not resolve locally (a
 * remote-only room, or an identity still connected elsewhere whose local
 * connection-count never reached zero here); realtime publishes each so live
 * subscribers and resumers see the successor rather than the erased owner. Each
 * entry is `{ topic, owner, reason }` (owner null + reason 'vacated' when the room
 * emptied). The extensions `createForgetStore(...)` builds one; the realtime layer
 * never imports it. Set via `configureForget({ store })`.
 * @type {{ purgeUser: (tenantId: string | null, userId: string, cascade: any) => Promise<number | Record<string, number> | { rowsAffected?: number | Record<string, number>, ownerSuccessions?: Array<{ topic: string, owner: string | null, reason: string }> }> } | null}
 */
let _forgetStore = null;

/**
 * Optional platform (default null). Needed only for the cluster presence-roster
 * release leg of the in-memory presence purge (it reads `platform.redis`).
 * Single-instance deployments leave it null. Set via `configureForget({ platform })`.
 * @type {any}
 */
let _forgetPlatform = null;

/**
 * Configure the forget subsystem. `store` plugs a durable cluster store into the
 * erasure cascade; `platform` supplies the Redis handle the presence purge needs
 * to decrement the cluster roster. Both optional; `null` clears both.
 *
 * @param {{ store?: { purgeUser: Function } | null, platform?: any } | null} config
 */
export function configureForget(config) {
	if (config === null) { _forgetStore = null; _forgetPlatform = null; return; }
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] configureForget: config must be an object or null');
	}
	if (config.store === undefined && config.platform === undefined) {
		throw new Error('[svelte-realtime] configureForget: config must include at least one of store or platform');
	}
	if (config.store !== undefined) {
		if (config.store !== null && (typeof config.store !== 'object' || typeof config.store.purgeUser !== 'function')) {
			throw new Error('[svelte-realtime] configureForget: store must implement purgeUser(tenantId, userId, cascade)');
		}
		_forgetStore = config.store;
	}
	if (config.platform !== undefined) {
		_forgetPlatform = config.platform;
	}
}

/**
 * PII-free fingerprint of a userId for the audit hook - a forget record must
 * never carry the raw id it is erasing (credo rule 5). Matches the idempotency
 * identity fingerprint (sha256, 32 hex chars).
 * @param {string} userId
 * @returns {string}
 */
function _hashUserId(userId) {
	return createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
}

/**
 * The in-memory purge surface: one auditable descriptor per user-keyed store the
 * framework holds in process. Each `run(tenantId, userId, cascade)` returns the
 * count it removed (sync or async). Adding a new user-keyed in-memory store
 * without a descriptor here trips the completeness test. Durable stores are NOT
 * listed here - they ride the `store.purgeUser` seam.
 * @type {Array<{ name: string, run: (tenantId: string | null, userId: string, cascade: any) => number | Promise<number> }>}
 */
const _descriptors = [
	{ name: 'push', run: (_t, u) => _purgePushUser(u) },
	// Presence release publishes no immediate `leave` event in v1 (publishLeave
	// is null): the local ref is deleted and the cluster roster decremented, so
	// new reads are correct; current subscribers see the leave when the user's
	// socket disconnects. A connection-less leave broadcast is a follow-up.
	{ name: 'presence', run: (t, u) => _purgePresenceUser(_forgetPlatform, t, u, null) },
	{ name: 'rateLimit', run: (t, u) => _purgeRateLimitUser(t, u) },
	{ name: 'idempotency', run: (t, u) => _purgeIdempotencyUser(_tenantKey(t, u)) },
	// Smooth/game state: the subscriber registry (identity -> ws, whose RTT
	// tracker - a measured-latency fingerprint - rides the same entry),
	// cross-instance surrogates, interest state (reported center = a literal
	// user location, LOD memory, send cadence), and the lag-comp movement
	// ring when the entity key is the identity.
	{ name: 'smooth', run: (_t, u) => _purgeSmoothUser(u) },
	// The webhook dead-letter queue retains full event payloads on delivery
	// exhaustion. Purge rides the store's own purgeUser (the in-memory store
	// stamps a capture-time userId via its forgetUserId extractor; the durable
	// stores implement the same contract). A store without purgeUser - or
	// records captured without an extractor - cannot attribute events to a
	// user and reports 0 (the documented limitation, never a silent lie).
	{ name: 'webhookDeadLetter', run: (t, u) => {
		const dl = state.webhookDeadLetter;
		return dl && typeof dl.purgeUser === 'function' ? dl.purgeUser(t, u) : 0;
	} },
	// k-anonymity cohorts: withdraw the user from every live aggregate's
	// contributor set so the k-gate re-evaluates without them (reducer state
	// is non-invertible by design; the cohort governs publication).
	{ name: 'aggregateCohorts', run: (_t, u) => _purgeAggregateCohorts(u) }
];

/**
 * The descriptor names, for the completeness test (a known user-keyed store
 * must appear here).
 * @internal
 * @returns {string[]}
 */
export function _forgetSurfaceNames() {
	return _descriptors.map((d) => d.name);
}

/**
 * @typedef {Object} ForgetResult
 * @property {true} ok - Always true on a completed cascade (a constant-shape
 *   field so the result cannot be turned into an existence oracle by callers who
 *   re-expose it to clients).
 * @property {number} at - Wall-clock ms the cascade resolved.
 * @property {number} rowsAffected - Total entries/rows removed across every
 *   surface + the durable store. Zero when the user had no data. Returned to the
 *   trusted server caller; if you re-expose forget to untrusted clients, map the
 *   result to a constant shape so 0-vs-N does not reveal user existence.
 * @property {Record<string, number>} surfaces - Per-surface removal counts
 *   (in-memory descriptors + `durable`).
 */

/**
 * Publish the `:owner` successions a durable store reported from its cluster-wide
 * owner eviction. Each is a wire `:owner` `set` for the room's successor (or a
 * `vacated` null), routed through the same replay path a room succession uses so
 * live subscribers update and a resuming client gap-fills the successor. Runs on
 * the forgetting instance; a malformed entry or a missing platform is skipped.
 * The `onOwnerChange` SERVER hook is deliberately NOT fired here - it is bound to
 * a room's local join state (its `_ownerRooms` entry), which the forgetting
 * instance need not hold (a remote-only room, a dedicated erasure runner), so only
 * the cluster-safe wire announcement is emitted; the hook still fires for a
 * locally-resolved succession on the instance that holds the room.
 * @param {string | null} tenantId
 * @param {any[]} successions
 * @returns {number} well-formed entries announced (each publish is best-effort:
 *   a throwing platform swallows inside `_ownerEmit` and still counts)
 */
function _publishOwnerSuccessions(tenantId, successions) {
	const publish = _ownerReplayPublisher(_forgetPlatform);
	if (!publish) return 0;
	let n = 0;
	for (const s of successions) {
		if (!s || typeof s.topic !== 'string' || s.topic.length === 0) continue;
		const owner = typeof s.owner === 'string' ? s.owner : null;
		const reason = typeof s.reason === 'string' ? s.reason : 'succeeded';
		_ownerEmit(s.topic, tenantId, { owner, previous: null, reason, _hook: null }, publish);
		n++;
	}
	return n;
}

const _liveForget = async function forget(userId, opts) {
	if (typeof userId !== 'string' || userId.length === 0) {
		throw new LiveError('INVALID_REQUEST', 'live.forget(userId) requires a non-empty userId string');
	}
	const reason = _validIdReason(userId, 'userId');
	if (reason !== null) {
		throw new LiveError('INVALID_REQUEST', 'live.forget: ' + reason + ' (max ' + _MAX_USER_ID_LENGTH + ' chars)');
	}
	const o = opts || {};
	if (typeof o !== 'object') {
		throw new LiveError('INVALID_REQUEST', 'live.forget(userId, opts): opts must be an object');
	}
	// tenantId is server-trusted: the app passes it from its own context
	// (ctx.tenantId or its own logic), NEVER straight off the wire. Validated to
	// the delimiter-safe charset so it cannot smuggle a `\0` into a scan match.
	const tenantId = o.tenantId == null ? null : _validTenantId(o.tenantId);
	// cascade: `true` (default) runs the standard purge surface; the object
	// form extends it - `{ crdt: [...] }` names whole documents to drop (a
	// forgotten user's CRDT edits are merged with no per-user attribution, so
	// the whole-document drop is the only true erasure; only the app knows
	// which documents the user contributed to). The value is also threaded to
	// every descriptor and the durable store unchanged.
	const cascade = o.cascade === undefined ? true : o.cascade;
	/** @type {string[] | null} */
	let crdtDocs = null;
	if (cascade !== undefined && typeof cascade === 'object' && cascade !== null) {
		if (cascade.crdt !== undefined) {
			if (!Array.isArray(cascade.crdt) || cascade.crdt.some((n) => typeof n !== 'string' || n.length === 0)) {
				throw new LiveError('INVALID_REQUEST', 'live.forget: cascade.crdt must be an array of non-empty document topic names');
			}
			crdtDocs = cascade.crdt;
		}
	} else if (typeof cascade !== 'boolean') {
		throw new LiveError('INVALID_REQUEST', 'live.forget: cascade must be a boolean or an object ({ crdt?: string[] })');
	}
	if (o.onForget !== undefined && typeof o.onForget !== 'function') {
		throw new LiveError('INVALID_REQUEST', 'live.forget: onForget must be a function');
	}

	// Participate in graceful drain so a shutdown waits for an in-progress
	// erasure rather than tearing it down half-applied (same contract as a cron
	// tick / an alarm fire). The `finally` drains exactly once on every exit.
	_enterInFlight();
	try {
		/** @type {Record<string, number>} */
		const surfaces = {};
		let rowsAffected = 0;

		// In-memory descriptors run sequentially: the surface is small, the work
		// is local, and a deterministic order keeps the cascade auditable.
		for (const d of _descriptors) {
			let count = 0;
			try {
				count = await d.run(tenantId, userId, cascade);
			} catch (err) {
				// A single surface failing must not abort the erasure of the
				// others (partial erasure beats none). Record and continue.
				if (_IS_DEV) console.error('[svelte-realtime] live.forget surface "' + d.name + '" threw:', err);
				count = 0;
			}
			const n = typeof count === 'number' && count > 0 ? count : 0;
			surfaces[d.name] = n;
			rowsAffected += n;
		}

		// Whole-document CRDT drops (cascade.crdt): erase the named documents'
		// loaded replicas. Deleting the durably persisted copies is the app's
		// half, in its own persist store.
		if (crdtDocs !== null) {
			let dropped = 0;
			try {
				dropped = _purgeCrdtDocs(crdtDocs);
			} catch (err) {
				if (_IS_DEV) console.error('[svelte-realtime] live.forget cascade.crdt threw:', err);
			}
			surfaces.crdtDocs = dropped;
			rowsAffected += dropped;
		}

		// Durable store: erase the user's cluster rows and WAIT for confirmation -
		// resolving before the durable delete confirms would be a compliance lie
		// (GDPR must wait for durable confirmation). The return shapes are handled
		// below (count, breakdown, or the owner-succession envelope).
		if (_forgetStore) {
			let successions = null;
			try {
				const durable = await _forgetStore.purgeUser(tenantId, userId, cascade);
				// The store may return a total (number), a per-store count
				// breakdown (object), or the owner-succession envelope
				// `{ rowsAffected?, ownerSuccessions? }` - detected by an
				// `ownerSuccessions` array (a plain count breakdown never carries
				// one). Split the counts from the successions; the counts fold as
				// before, the successions publish `:owner` for the rooms the store
				// evicted the user from as owner cluster-wide.
				let counts = durable;
				if (durable && typeof durable === 'object' && Array.isArray(/** @type {any} */ (durable).ownerSuccessions)) {
					successions = /** @type {any} */ (durable).ownerSuccessions;
					counts = /** @type {any} */ (durable).rowsAffected;
				}
				if (typeof counts === 'number') {
					surfaces.durable = counts > 0 ? counts : 0;
					rowsAffected += surfaces.durable;
				} else if (counts && typeof counts === 'object') {
					let sum = 0;
					for (const v of Object.values(counts)) {
						const n = typeof v === 'number' && v > 0 ? v : 0;
						sum += n;
					}
					surfaces.durable = sum;
					rowsAffected += sum;
				} else {
					surfaces.durable = 0;
				}
			} catch (err) {
				// A durable failure is a real erasure failure (an un-purged row is
				// a compliance breach). Surface it to the caller - unlike an
				// in-memory surface, we do NOT swallow it, so the app can retry.
				// Log without the `ownerSuccessions` the store attaches for
				// announcement: those carry SUCCESSOR user ids (other users), which
				// must not reach a log even in dev (credo: no PII in logs). The
				// message + underlying failure reasons stay for debuggability.
				if (_IS_DEV) {
					const logErr = err && typeof err === 'object' && 'ownerSuccessions' in /** @type {any} */ (err)
						? { message: /** @type {any} */ (err).message, failures: /** @type {any} */ (err).failures, partialCounts: /** @type {any} */ (err).partialCounts }
						: err;
					console.error('[svelte-realtime] live.forget durable store.purgeUser threw:', logErr);
				}
				// The store may have COMMITTED some owner successions before a
				// sibling room's transient failure aborted the leg: those evictions
				// are durable and authoritative, so announce them now even though the
				// overall erasure is incomplete and will be retried. The retry
				// re-drives only the failed rooms (a committed room reads o != userId
				// and reports nothing), so each committed succession reaches the
				// `:owner` wire exactly once. Best-effort and fully guarded: a throw
				// here must never mask FORGET_STORE_FAILED (which would tell the caller
				// the partially-failed erasure need not be retried).
				const committed = err && Array.isArray(/** @type {any} */ (err).ownerSuccessions)
					? /** @type {any} */ (err).ownerSuccessions
					: null;
				if (committed && committed.length) {
					try {
						_publishOwnerSuccessions(tenantId, committed);
					} catch (pubErr) {
						if (_IS_DEV) console.error('[svelte-realtime] live.forget announce-on-failure threw:', pubErr);
					}
				}
				throw new LiveError('FORGET_STORE_FAILED', 'live.forget: durable store.purgeUser failed; the erasure is incomplete and must be retried');
			}
			// Publish the store's owner successions AFTER the durable try/catch:
			// the authoritative eviction already committed in the store, so the
			// wire announcement is best-effort by construction and an exotic throw
			// out of it must never misreport as FORGET_STORE_FAILED (which would
			// tell the caller to retry an erasure that succeeded).
			if (successions !== null) {
				surfaces.ownerSuccessions = _publishOwnerSuccessions(tenantId, successions);
			}
		}

		const at = wallEpoch();

		// PII-free audit hook: the app's record of the erasure. Receives a HASHED
		// userId (never the raw id), the tenant, the cascade flag, and the counts.
		// Caught-and-recorded: a throwing hook never aborts a completed erasure.
		const onForget = o.onForget;
		if (onForget) {
			try {
				// Shallow-copy surfaces so a hook that mutates the record cannot
				// alter the value returned to the caller (the same object).
				onForget({ userIdHash: _hashUserId(userId), tenantId, cascade, rowsAffected, surfaces: { ...surfaces }, at });
			} catch (err) {
				if (_IS_DEV) console.error('[svelte-realtime] live.forget onForget hook threw (erasure already completed):', err);
			}
		}

		return { ok: true, at, rowsAffected, surfaces };
	} finally {
		_exitInFlight();
	}
};

/**
 * Attach `live.forget` onto the live object. Mirrors `installPush(live)`.
 * @param {any} live
 */
export function installForget(live) {
	live.forget = _liveForget;
}

/**
 * Reset forget configuration. Tests only.
 * @internal
 */
export function _resetForget() {
	_forgetStore = null;
	_forgetPlatform = null;
}
