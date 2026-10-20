// @ts-check
import { _presenceRef, state } from './state.js';
import { clearTimer, setTimer } from '../shared/runtime.js';
import { _topicInTenant } from './tenant.js';
import { _ownerPurge, _ownerEmit } from './room-owner.js';
import { _maybeReplayPublish, _confirmedReplayPublish, _registerReplayTopic } from './replay-routing.js';
import { _platformPublish, UNSEQUENCED } from './publish-helpers.js';
import { safeAssign } from '../shared/safe-assign.js';

// Cursor-only publishers have their own lifetime. A reserved control topic keeps
// their counters separate from data membership while sharing the bounded ref map.
const _cursorPublishers = new WeakMap();
const _cursorClosedWs = new WeakSet();
const _CURSOR_CONTROL_PREFIX = '\0cursors:';
const _cursorControlTopic = topic => _CURSOR_CONTROL_PREFIX + topic;

async function _presenceIdentityActive(platform, topic, key, includeOwner = false) {
	const ref = _presenceRef.get(topic + '\0' + key);
	if (ref && !ref.gone) return true;
	const redis = platform && platform.redis;
	if (!redis || typeof redis.hget !== 'function') return false;
	try {
		if (Number(await redis.hget(_PRESENCE_KEY_PREFIX + topic, 'c:' + key)) > 0) return true;
		return includeOwner && Number(await redis.hget('__live-room-owner:' + topic, 'n:' + key)) > 0;
	}
	catch { return false; }
}

/** Whether a separate cursor-only publisher still owns this identity. */
export function _cursorPublisherActive(platform, topic, key) {
	return _presenceIdentityActive(platform, _cursorControlTopic(topic), key);
}

/**
 * Remove the sample only after both independent identity lifetimes depart.
 * Always send the idempotent removal at that boundary: a cursor-only publisher
 * on another replica may have departed first and lost its control row to cleanup
 * or expiry. This member's config cannot prove that peers hold no cursor sample.
 */
export async function _removeCursorIfDeparted(platform, topic, key, publish) {
	if (await _presenceIdentityActive(platform, topic, key, true)) return;
	if (await _cursorPublisherActive(platform, topic, key)) return;
	// An independent lifetime may join while either Redis read is pending.
	// Recheck both local refs at the final synchronous publish boundary.
	const member = _presenceRef.get(topic + '\0' + key);
	const publisher = _presenceRef.get(_cursorControlTopic(topic) + '\0' + key);
	if ((member && !member.gone) || (publisher && !publisher.gone)) return;
	if (publish) publish(topic + ':cursors', 'remove', { key }, UNSEQUENCED);
	else _platformPublish(platform, topic + ':cursors', 'remove', { key }, UNSEQUENCED);
}

/** Retire a standalone publisher without draining data membership or ownership. */
export function _retireCursorPublisher(refKey, ref, platform) {
	const sep = refKey.lastIndexOf('\0');
	const topic = ref.cursorTopic ?? refKey.slice(_CURSOR_CONTROL_PREFIX.length, sep);
	const key = ref.cursorKey ?? refKey.slice(sep + 1);
	return _retirePresenceRef(refKey, ref, async () => {
		const { isLast } = await _clusterPresenceRelease(platform, _cursorControlTopic(topic), key);
		if (isLast) await _removeCursorIfDeparted(platform, topic, key);
	});
}

function _releaseCursorPublisher(platform, topic, ref) {
	const key = ref.cursorKey, refKey = _cursorControlTopic(topic) + '\0' + key;
	if (key == null || ref.erasure || ref.leaving || _presenceRef.get(refKey) !== ref) return;
	if (--ref.count > 0) return;
	ref.timer = setTimer(() => _retireCursorPublisher(refKey, ref, platform).catch(() => {}), 5000);
}

/** Track the first cursor-only publish; subsequent samples stay synchronous. */
export function _trackCursorPublisher(ctx, topic, key) {
	if (ctx.ws && _cursorClosedWs.has(ctx.ws)) return false;
	const held = ctx.ws && _cursorPublishers.get(ctx.ws)?.get(topic);
	if (held && held.cursorKey === key && !held.gone && !held.joining) return true;
	return _trackCursorPublisherSlow(ctx, topic, key);
}

// Keep deferred-acquire closures off the synchronous sample path.
function _trackCursorPublisherSlow(ctx, topic, key) {
	const ws = ctx.ws;
	if (!ws || !ctx.platform) return true;
	if (_cursorClosedWs.has(ws)) return false;
	let slots = _cursorPublishers.get(ws);
	const held = slots?.get(topic);
	if (held && held.cursorKey === key && !held.gone) {
		return held.joining ? held.joining.then(() => !held.gone && slots.get(topic) === held && !_cursorClosedWs.has(ws)) : true;
	}
	const controlTopic = _cursorControlTopic(topic), refKey = controlTopic + '\0' + key;
	let ref = _presenceRef.get(refKey);
	if (ref?.erasure) return false;
	if (ref?.leaving) return ref.leaving.then(() => _trackCursorPublisher(ctx, topic, key));
	if (!ref && _presenceRef.size >= state.maxPresenceRef) return false;
	if (!slots) { slots = new Map(); _cursorPublishers.set(ws, slots); }
	if (held) _releaseCursorPublisher(ctx.platform, topic, held);
	if (ref) {
		ref.count++;
		if (ref.timer) { clearTimer(ref.timer); ref.timer = null; }
	} else {
		ref = { count: 1, timer: null, data: null, platform: ctx.platform, cursors: true, cursorPublisher: true, cursorKey: key, cursorTopic: topic, joining: null, gone: false };
		_presenceRef.set(refKey, ref);
		ref.joining = _clusterPresenceAcquire(ctx.platform, controlTopic, key, null).then(() => { ref.joining = null; });
	}
	slots.set(topic, ref);
	return ref.joining ? ref.joining.then(() => !ref.gone && slots.get(topic) === ref && !_cursorClosedWs.has(ws)) : true;
}

/** Drain cursor publishers even when the socket never subscribed to a stream. */
export function _closeCursorPublishers(ws, platform) {
	_cursorClosedWs.add(ws);
	const slots = _cursorPublishers.get(ws);
	if (!slots) return;
	_cursorPublishers.delete(ws);
	for (const [topic, ref] of slots) _releaseCursorPublisher(platform, topic, ref);
	slots.clear();
}

/**
 * Direct handle to the in-memory presence-ref map for tests that need to seed
 * or inspect a roster entry without driving a full socket subscribe. Not part
 * of the public surface.
 * @internal
 * @returns {Map<string, { count: number, timer: ReturnType<typeof setTimeout> | null, data: any, joining?: Promise<void> | null }>}
 */
export function _presenceRefForTest() {
	return _presenceRef;
}

/**
 * Cluster-shared presence-ref store. Used by `live.room({ presence })` when
 * `platform.redis` is wired by the host app (raw ioredis-shaped client with
 * hincrby / hset / hdel / hgetall / expire). Falls back to the in-process
 * `_presenceRef` Map when absent, preserving zero-config dev behavior.
 *
 * Storage layout (one Redis HASH per topic):
 *   key:    `__live-presence:{topic}`
 *   fields: 'c:{userKey}' -> integer (cluster-wide subscriber count)
 *           'd:{userKey}' -> JSON-stringified presence data
 *
 * Cluster semantics:
 * - First replica to take a user's count from 0->1 publishes 'join' (cluster-
 *   wide isFirst). Subsequent replicas just increment.
 * - Last replica to take a user's count from 1->0 publishes 'leave'.
 * - Loader returns the full HGETALL view so any replica's new subscriber sees
 *   all users from all replicas, not just the locally-attached ones.
 *
 * Per-replica refcount (multiple tabs of the same user on the same replica)
 * and grace-timer behavior stay in the existing _presenceRef Map. The cluster
 * helpers only fire at the local 0<->1 transitions, so a quick reconnect
 * burst on a single replica doesn't churn the cluster counter.
 */
const _PRESENCE_KEY_PREFIX = '__live-presence:';
const _PRESENCE_TTL_SEC = 3600;

// Bound on a roster entry's serialized size after a sticky merge:
// the entry is rewritten in full per merge and served verbatim to every
// late joiner, so a client must not grow it without limit. A merge that
// SHRINKS the entry always applies, so a release can never be pinned by
// the cap.
const _PRESENCE_ENTRY_MAX_BYTES = 16384;

/**
 * Cap check for a sticky merge: the merged entry must stay under the byte
 * bound, unless the merge shrinks the entry (a release must always apply).
 *
 * Measure UTF-8 bytes on both storage paths. JS `.length` counts UTF-16 code
 * units, which undercounts multibyte characters and admits oversized entries.
 *
 * @param {string} curJson serialized entry before the merge
 * @param {string} nextJson serialized entry after the merge
 */
function _presenceMergeWithinCap(curJson, nextJson) {
	const nextBytes = Buffer.byteLength(nextJson, 'utf8');
	return nextBytes <= _PRESENCE_ENTRY_MAX_BYTES || nextBytes <= Buffer.byteLength(curJson, 'utf8');
}

// Compare-and-set of a roster entry's data field, gated on the entry still
// being present. KEYS[1] = the roster hash; ARGV = count field, data field,
// the row the merge was computed from, the merged row, the TTL. Returns 0 (and
// writes nothing) when the count field is gone, so a release that lands
// between a read and a write cannot resurrect a phantom data row with no
// count. Returns 1 after writing. Returns `{2, current}` (or `{2}` when the
// field is missing) when the row changed since it was read; the caller merges
// again from `current`.
//
// The merge itself runs in JS, never in Lua: lua-cjson re-encodes a decoded
// row lossily (an empty array becomes `{}`, numbers keep 14 significant
// digits, `/` is escaped), and the row is the application's presence payload.
// JSON.parse then JSON.stringify of a row JSON.stringify wrote gives the same
// bytes back, so only the sticky fields change.
export const _PRESENCE_MERGE_SCRIPT =
	"if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end\n" +
	"local raw = redis.call('HGET', KEYS[1], ARGV[2])\n" +
	"if raw ~= ARGV[3] then if raw then return {2, raw} end return {2} end\n" +
	"redis.call('HSET', KEYS[1], ARGV[2], ARGV[4])\n" +
	"redis.call('EXPIRE', KEYS[1], ARGV[5])\n" +
	"return 1";

// Bound on compare-and-set rounds per merge. Only the member's own writes
// (other tabs on other replicas) race a merge, so this is never reached in
// practice; past it the merge gives up as on a Redis failure.
const _PRESENCE_MERGE_ATTEMPTS = 8;

/** Why a sticky merge refused the delta's new values. */
export const _PRESENCE_REFUSED_CAP = 'the roster entry would exceed ' + _PRESENCE_ENTRY_MAX_BYTES + ' bytes serialized';
export const _PRESENCE_REFUSED_PAYLOAD = 'selection and lock fields need an object presence payload';

/**
 * Merge a sticky delta into a serialized roster row. With `stamps` false only
 * the releases apply. Returns the merged row, or the refusal reason: the cap,
 * or a payload that is not a plain object (a string, number, array or null
 * has nowhere to carry a field; the row is left as it is).
 * @param {string} raw
 * @param {Record<string, any>} delta
 * @param {boolean} [stamps]
 * @returns {{ row: string, refused: string | null }}
 */
function _mergePresenceRow(raw, delta, stamps = true) {
	let cur;
	try { cur = JSON.parse(raw); } catch { cur = null; }
	if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
		return { row: raw, refused: stamps && _hasStamp(delta) ? _PRESENCE_REFUSED_PAYLOAD : null };
	}
	for (const k of Object.keys(delta)) {
		if (delta[k] == null) delete cur[k]; else if (stamps) cur[k] = delta[k];
	}
	const row = JSON.stringify(cur);
	if (!stamps || _presenceMergeWithinCap(raw, row)) return { row, refused: null };
	return { row: _mergePresenceRow(raw, delta, false).row, refused: _PRESENCE_REFUSED_CAP };
}

/** @param {Record<string, any>} delta */
function _hasStamp(delta) {
	for (const k of Object.keys(delta)) if (delta[k] != null) return true;
	return false;
}

/**
 * Bump the cluster-wide count for (topic, key). Returns isFirst=true when
 * this acquire took the count from 0 to 1 cluster-wide, signaling that the
 * caller should publish a 'join' event. Falls through to a no-op stub when
 * platform.redis is missing (single-replica dev path).
 */
export async function _clusterPresenceAcquire(platform, topic, key, data) {
	const redis = platform && platform.redis;
	if (!redis || typeof redis.hincrby !== 'function') return { isFirst: true };
	const hKey = _PRESENCE_KEY_PREFIX + topic;
	const countField = 'c:' + key;
	const dataField = 'd:' + key;
	let serialized;
	try { serialized = JSON.stringify(data); } catch { serialized = 'null'; }
	try {
		// Write the data field BEFORE bumping the count. A concurrent
		// `_clusterPresenceList` (e.g. the same user's own :presence stream
		// loader racing the data stream's acquire) reads data fields only;
		// if HINCRBY ran first the loader could observe a count without a
		// data field and return an empty roster, missing the user's own
		// entry. Writing data first guarantees the loader sees the entry
		// as soon as the count is visible.
		//
		// Never over a live member's row, though: the sticky fields (selection,
		// locks) are merged into it, and a second tab landing on another
		// replica would erase them. The first acquirer's payload stands while
		// the member stays, as it does for a second tab on one replica (and a
		// replica that dies holding the member leaves its count behind, so the
		// row then stands until the room goes idle long enough for the roster to
		// expire).
		const wrote = typeof redis.hsetnx === 'function'
			? await redis.hsetnx(hKey, dataField, serialized)
			: (await redis.hset(hKey, dataField, serialized), 1);
		const count = await redis.hincrby(hKey, countField, 1);
		if (count === 1) {
			// A fresh member. A row this acquire did not write is left from an
			// earlier membership whose delete failed, sticky fields and all.
			if (!wrote) await redis.hset(hKey, dataField, serialized);
			await redis.expire(hKey, _PRESENCE_TTL_SEC);
			return { isFirst: true };
		}
		// Refresh TTL on activity so the hash doesn't expire under a busy room.
		try { await redis.expire(hKey, _PRESENCE_TTL_SEC); } catch { /* best-effort */ }
		return { isFirst: false };
	} catch {
		// Redis blip: treat as first so we publish a join. Worst case a duplicate
		// 'join' merges idempotently by key on the client.
		return { isFirst: true };
	}
}

/**
 * Decrement the cluster-wide count for (topic, key). Returns isLast=true when
 * this release took the count from 1 to 0 cluster-wide, signaling that the
 * caller should publish a 'leave' event. Falls through to isLast=true when
 * platform.redis is missing (single-replica dev path treats every grace-timer
 * expiry as the final leave).
 */
export async function _clusterPresenceRelease(platform, topic, key) {
	const redis = platform && platform.redis;
	if (!redis || typeof redis.hincrby !== 'function') return { isLast: true };
	const hKey = _PRESENCE_KEY_PREFIX + topic;
	const countField = 'c:' + key;
	const dataField = 'd:' + key;
	try {
		const count = await redis.hincrby(hKey, countField, -1);
		if (count <= 0) {
			await redis.hdel(hKey, countField, dataField);
			return { isLast: true };
		}
		return { isLast: false };
	} catch {
		// Redis blip: assume last so we publish a leave. A late observer reading
		// HGETALL might still see the stale field until the next acquire repairs
		// the count (or the hash TTL expires).
		return { isLast: true };
	}
}

/**
 * Build the `:owner` publish closure that routes an ownership change through the
 * replay buffer. The `:owner` sub-stream is replay-backed by construction (room.js
 * declares `__replay: { size: 1 }`), but `_maybeReplayPublish` writes the buffer
 * only when THIS instance already registered the topic as replay-eligible (a local
 * claim or a local `:owner` subscribe). A succession driven by a purge on an
 * instance that never held a local `:owner` subscriber - a load-balanced forget
 * request, a dedicated erasure job, or the durable-store owner-succession fan-in -
 * would otherwise advance no buffer, leaving a later resumer or fresh connect to
 * gap-fill the erased owner. Registering here (idempotent, mirroring room.js's
 * claim-time registration) keeps the buffer advanced; `_maybeReplayPublish` still
 * owns the WRAPPED_FOR_REPLAY defer and the sync-throw fallback. Falls back to a
 * bare publish when the topic is not replay-eligible or no replay extension is
 * wired (single-process is unchanged). Null platform -> null (nothing to publish
 * through). Shared by the presence purge and the `live.forget` store fan-in.
 * @param {any} platform
 * @param {boolean} [confirmed] Require replay and bare publication acknowledgement.
 * @returns {((wireTopic: string, event: string, data: any) => any) | null}
 */
export function _ownerReplayPublisher(platform, confirmed = false) {
	if (!platform) return null;
	return (wireTopic, event, data) => {
		if (platform.replay) _registerReplayTopic(wireTopic);
		const replayed = confirmed
			? _confirmedReplayPublish(platform, wireTopic, event, data)
			: _maybeReplayPublish(platform, wireTopic, event, data);
		return replayed || _platformPublish(platform, wireTopic, event, data, UNSEQUENCED);
	};
}

/**
 * Keep a departing ref discoverable until its asynchronous release settles.
 * It grants no membership and serves no payload. A concurrent erasure can take
 * ownership of the ref instead of losing the only known Redis cleanup target.
 * @internal
 */
export function _retirePresenceRef(refKey, ref, release) {
	if (ref.leaving) return ref.leaving;
	ref.gone = true;
	ref.data = null;
	ref.row = null;
	ref.cursorKey = null;
	ref.cursorTopic = null;
	ref.count = 0;
	if (ref.timer) { clearTimer(ref.timer); ref.timer = null; }
	ref.leaving = Promise.resolve().then(async () => {
		if (ref.joining) await ref.joining;
		await release();
	}).finally(() => {
		if (!ref.erasure && _presenceRef.get(refKey) === ref) _presenceRef.delete(refKey);
	});
	return ref.leaving;
}

/**
 * Right-to-erasure: remove a user's presence and owner identity in every known
 * room in this tenant. Scrub payloads and invalidate membership before awaiting
 * storage. Failed refs remain as tombstones in the existing bounded ref map;
 * neither disconnect nor reconnect may consume them before a confirmed retry.
 * Remote-only rooms still require the configured durable erasure store.
 * @param {any} platform
 * @param {string | null} tenantId
 * @param {string} userId
 * @param {((wireTopic: string, event: string, data: any, options?: any) => void) | null} [publishLeave]
 * @returns {Promise<number>} refs whose cleanup was confirmed
 */
export async function _purgePresenceUser(platform, tenantId, userId, publishLeave) {
	if (typeof userId !== 'string' || userId.length === 0) return 0;
	const targets = [];
	// Mark every target synchronously: a later ref's grace timer must not erase
	// its retry ownership while an earlier ref waits for Redis.
	for (const [refKey, ref] of _presenceRef) {
		const sep = refKey.lastIndexOf('\0');
		if (sep < 0 || refKey.slice(sep + 1) !== userId) continue;
		const storageTopic = refKey.slice(0, sep);
		const cursorPublisher = !!ref.cursorPublisher;
		const topic = cursorPublisher ? storageTopic.slice(_CURSOR_CONTROL_PREFIX.length) : storageTopic;
		if (!_topicInTenant(tenantId, topic)) continue;
		if (ref.timer) { clearTimer(ref.timer); ref.timer = null; }
		ref.gone = true;
		ref.count = 0;
		ref.data = null;
		ref.row = null;
		ref.cursorKey = null;
		ref.cursorTopic = null;
		ref.erasure ??= { presenceDone: false, ownerDone: false, ownerUnconfirmed: false, pending: null };
		targets.push({ refKey, ref, topic, storageTopic, cursorPublisher });
	}
	let removed = 0;
	let failed = false;
	for (const { refKey, ref, topic, storageTopic, cursorPublisher } of targets) {
		const progress = ref.erasure;
		if (!progress.pending) {
			progress.pending = Promise.resolve().then(async () => {
				if (ref.joining) await ref.joining;
				// A failed best-effort departure does not confirm erasure. Wait for
				// it to settle, then let the strict idempotent cleanup below retry.
				if (ref.leaving) await ref.leaving.catch(() => {});
				const storagePlatform = ref.platform || platform;
				const publishPlatform = platform || ref.platform;
				const publish = publishLeave || (publishPlatform && typeof publishPlatform.publish === 'function'
					? (wireTopic, event, data, options) => _platformPublish(publishPlatform, wireTopic, event, data, options) : null);
				if (!publish) throw new Error('Presence erasure has no publication platform');
				const ownerPublish = publishLeave || _ownerReplayPublisher(publishPlatform, true);
				let incomplete = false;
				if (!progress.presenceDone) {
					try {
						const redis = storagePlatform && storagePlatform.redis;
						if (redis && typeof redis.hincrby === 'function') {
							// HDEL is idempotent even if Redis applied a previous attempt
							// whose response never reached this process.
							const count = await redis.hdel(_PRESENCE_KEY_PREFIX + storageTopic, 'c:' + userId, 'd:' + userId);
							if (!Number.isSafeInteger(count) || count < 0) throw new Error('Presence erasure was not confirmed');
						}
						if (!cursorPublisher) await publish(topic + ':presence', 'leave', { key: userId }, UNSEQUENCED);
						await publish(topic + ':cursors', 'remove', { key: userId }, UNSEQUENCED);
						progress.presenceDone = true;
					} catch { incomplete = true; }
				}
				if (cursorPublisher) progress.ownerDone = true;
				if (!progress.ownerDone) {
					try {
						const { owner, change } = await _ownerPurge(storagePlatform, topic, userId);
						const announcement = change || (progress.ownerUnconfirmed ? {
							owner, previous: null, reason: owner === null ? 'vacated' : 'succeeded', _hook: null
						} : null);
						if (announcement) {
							let published;
							_ownerEmit(topic, tenantId, announcement, (wireTopic, event, data, options) => {
								published = Promise.resolve().then(() => ownerPublish(wireTopic, event, data, options));
							});
							await published;
						}
						progress.ownerDone = true;
					} catch { progress.ownerUnconfirmed = true; incomplete = true; }
				}
				if (incomplete) throw new Error('Presence or owner erasure could not be confirmed');
				if (_presenceRef.get(refKey) === ref) _presenceRef.delete(refKey);
			}).finally(() => { progress.pending = null; });
		}
		try { await progress.pending; removed++; } catch { failed = true; }
	}
	if (failed) throw new Error('Presence erasure could not be confirmed for every room');
	return removed;
}

/**
 * A roster entry as a subscriber sees it. A room's sticky fields (a
 * multiplayer room's declared selection and locks) are persisted inside the
 * stored payload, but a live field update puts them on the entry beside
 * `data`, which is where the room view reads them, so an entry served from
 * the roster lifts them out to the same place. `isSticky` is the room's own
 * test; a room without one gets `{ key, data }` untouched. Allocates only
 * when the payload carries a sticky field.
 * @param {string} key
 * @param {any} data
 * @param {((field: string) => boolean) | null | undefined} isSticky
 * @returns {Record<string, any>}
 */
export function _presenceRosterEntry(key, data, isSticky) {
	if (!isSticky || data === null || typeof data !== 'object' || Array.isArray(data)) return { key, data };
	/** @type {Record<string, any> | null} */
	let entry = null;
	/** @type {Record<string, any> | null} */
	let payload = null;
	for (const k of Object.keys(data)) {
		if (!isSticky(k)) continue;
		if (entry === null) { entry = {}; payload = safeAssign({}, data); }
		entry[k] = data[k];
		delete /** @type {Record<string, any>} */ (payload)[k];
	}
	if (entry === null) return { key, data };
	entry.key = key;
	entry.data = payload;
	return entry;
}

/**
 * Return the cluster-wide presence roster for a topic as `[{key, data}, ...]`,
 * the payloads as stored. Falls through to the local _presenceRef iteration
 * when platform.redis is missing.
 */
export async function _clusterPresenceList(platform, topic) {
	const redis = platform && platform.redis;
	if (!redis || typeof redis.hgetall !== 'function') {
		const prefix = topic + '\0';
		const out = [];
		for (const [refKey, ref] of _presenceRef) {
			if (!refKey.startsWith(prefix)) continue;
			if (ref.data == null) continue;
			out.push({ key: refKey.slice(prefix.length), data: ref.data });
		}
		return out;
	}
	const hKey = _PRESENCE_KEY_PREFIX + topic;
	try {
		const all = await redis.hgetall(hKey);
		const out = [];
		for (const field of Object.keys(all)) {
			if (field.length < 3 || field[0] !== 'd' || field[1] !== ':') continue;
			const key = field.slice(2);
			try { out.push({ key, data: JSON.parse(all[field]) }); }
			catch { /* skip corrupt entry */ }
		}
		return out;
	} catch {
		return [];
	}
}


/**
 * Merge a sticky presence delta into both roster stores so either snapshot
 * path (the in-memory _presenceRef iteration or the Redis 'd:'+key JSON field)
 * reflects it for a late joiner. A null delta value deletes the field, which is
 * the release path: releaseLock sends `{ 'lock:<k>': null }` and clearing a
 * selection sends `{ selection: null }`.
 *
 * The caller publishes the forward `update` frame only after the merge completes, so
 * it can leave out what the roster refused. Two refusals exist: the merged
 * entry is capped at `_PRESENCE_ENTRY_MAX_BYTES` serialized, and sticky fields
 * sit beside the presence payload's own fields, so a payload that is not a
 * plain object takes none. Either way the delta keeps only its releases
 * (removing fields never grows an entry, so a release can never be pinned by
 * the cap) and the merge returns the reason; the caller then withholds
 * the delta's new values from the frame, so live members and late joiners
 * agree. An entry only exists once presence has been set, so a missing entry
 * (no live roster row) is a no-op: there is nothing to stamp the field onto. A
 * Redis failure resolves null: the frame still goes out, as it would with no
 * roster to agree with.
 *
 * With `platform.redis` wired the Redis row is the roster late joiners read,
 * so its decision governs and the local copy follows it.
 *
 * @param {any} platform
 * @param {string} topic
 * @param {string} key
 * @param {Record<string, any>} delta
 * @returns {string | null | Promise<string | null>} why the delta's new values were refused, or null
 */
export function _clusterPresenceMerge(platform, topic, key, delta) {
	const redis = platform && platform.redis;
	const refKey = topic + '\0' + key;
	// Same test `_clusterPresenceList` uses to pick the roster it serves.
	if (!redis || typeof redis.hgetall !== 'function') return _localPresenceMerge(refKey, delta, true);
	return _mergeRedisPresenceRoster(redis, topic, key, delta, refKey);
}

/**
 * Keep the local merge synchronous; only shared storage introduces a lifetime gap.
 * @param {any} redis
 * @param {string} topic
 * @param {string} key
 * @param {Record<string, any>} delta
 * @param {string} refKey
 * @returns {Promise<string | null>}
 */
async function _mergeRedisPresenceRoster(redis, topic, key, delta, refKey) {
	const ref = _presenceRef.get(refKey);
	const result = await _redisPresenceMerge(redis, topic, key, delta, ref);
	// A reconnect reads this copy. Follow the accepted Redis row, including
	// other replicas' fields and cap decisions, only for this membership.
	if (ref && !ref.gone && _presenceRef.get(refKey) === ref) {
		if (result?.row !== undefined) {
			try { ref.data = JSON.parse(result.row); } catch { /* keep the last valid payload */ }
		} else {
			_localPresenceMerge(refKey, delta, true);
		}
	}
	return result?.refused ?? null;
}

/**
 * Merge into the in-process roster entry. With `stamps` false only the
 * releases apply. Returns why the delta's new values were refused, or null.
 * @param {string} refKey
 * @param {Record<string, any>} delta
 * @param {boolean} stamps
 * @returns {string | null}
 */
function _localPresenceMerge(refKey, delta, stamps) {
	const ref = _presenceRef.get(refKey);
	if (!ref || ref.data == null) return null;
	const data = ref.data;
	if (typeof data !== 'object' || Array.isArray(data)) {
		return stamps && _hasStamp(delta) ? _PRESENCE_REFUSED_PAYLOAD : null;
	}
	const next = { ...data };
	for (const k of Object.keys(delta)) {
		if (delta[k] == null) delete next[k]; else if (stamps) next[k] = delta[k];
	}
	if (!stamps) { ref.data = next; return null; }
	let nextJson, curJson;
	// `?? null` / `?? ''`: JSON.stringify RETURNS undefined (it does not throw)
	// for a value whose toJSON yields undefined, and Buffer.byteLength would
	// then throw out of the merge.
	try { nextJson = JSON.stringify(next) ?? null; } catch { nextJson = null; }
	try { curJson = JSON.stringify(data) ?? ''; } catch { curJson = ''; }
	if (nextJson !== null && _presenceMergeWithinCap(curJson, nextJson)) {
		ref.data = next;
		return null;
	}
	_localPresenceMerge(refKey, delta, false);
	return _PRESENCE_REFUSED_CAP;
}

/**
 * Merge into the Redis roster row ('d:'+key JSON field). Returns the accepted
 * row and any refusal reason (its releases still apply), or null without a row.
 * @param {any} redis
 * @param {string} topic
 * @param {string} key
 * @param {Record<string, any>} delta
 * @param {any} ref the local membership that issued this merge
 * @returns {Promise<{ row: string, refused: string | null } | null>}
 */
async function _redisPresenceMerge(redis, topic, key, delta, ref) {
	const refKey = topic + '\0' + key;
	const hKey = _PRESENCE_KEY_PREFIX + topic;
	const dataField = 'd:' + key;
	const countField = 'c:' + key;
	// Preferred path: a compare-and-set gated on the count field, so a
	// concurrent release cannot leave a phantom data row behind and a
	// concurrent merge from another replica is never overwritten.
	if (typeof redis.eval === 'function') {
		try {
			// The row this replica last wrote or saw for the member saves the
			// read on the usual path; a stale one costs one more round.
			let raw = ref && typeof ref.row === 'string' ? ref.row : await redis.hget(hKey, dataField);
			for (let attempt = 0; attempt < _PRESENCE_MERGE_ATTEMPTS; attempt++) {
				if (ref && (ref.gone || _presenceRef.get(refKey) !== ref)) return null;
				if (raw == null) return null; // no live entry yet: nothing to carry the field
				const { row, refused } = _mergePresenceRow(raw, delta);
				// Even an unchanged row or a refusal must validate the cached
				// input: another replica may have added, removed or replaced fields.
				const res = await redis.eval(
					_PRESENCE_MERGE_SCRIPT, 1, hKey, countField, dataField,
					raw, row, String(_PRESENCE_TTL_SEC)
				);
				if (Array.isArray(res)) {
					raw = res.length > 1 ? String(res[1]) : null;
					continue;
				}
				if (ref && !ref.gone && _presenceRef.get(refKey) === ref) {
					ref.row = Number(res) === 1 ? row : null;
				}
				return Number(res) === 1 ? { row, refused } : null;
			}
			return null;
		} catch { return null; }
	}
	// Fallback for a redis without scripting: read, merge, then re-check the
	// count still exists right before the write to narrow the same race.
	if (typeof redis.hget !== 'function') return null;
	try {
		const raw = await redis.hget(hKey, dataField);
		if (raw == null) return null; // no live entry yet: nothing to carry the field
		const { row, refused } = _mergePresenceRow(raw, delta);
		if (row === raw) return { row, refused };
		if (typeof redis.hexists === 'function' && !(await redis.hexists(hKey, countField))) return null;
		if (ref && (ref.gone || _presenceRef.get(refKey) !== ref)) return null;
		await redis.hset(hKey, dataField, row);
		try { await redis.expire(hKey, _PRESENCE_TTL_SEC); } catch { /* best-effort */ }
		return { row, refused };
	} catch { return null; }
}
