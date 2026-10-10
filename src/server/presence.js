// @ts-check
import { _presenceRef } from './state.js';
import { clearTimer } from '../shared/runtime.js';
import { _topicInTenant } from './tenant.js';
import { _ownerPurge, _ownerEmit } from './room-owner.js';
import { _maybeReplayPublish, _registerReplayTopic } from './replay-routing.js';
import { _platformPublish, UNSEQUENCED } from './publish-helpers.js';
import { safeAssign } from '../shared/safe-assign.js';

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
 * BYTES, not `String.length`: the Lua twin measures `#encoded` (bytes) and a
 * JS `.length` is UTF-16 code units, so a value of 4-byte characters would let
 * the in-memory path (the default, zero-config, no-redis path) admit roughly 4x
 * what the cluster path admits. One unit or the two diverge.
 *
 * @param {string} curJson serialized entry before the merge
 * @param {string} nextJson serialized entry after the merge
 */
function _presenceMergeWithinCap(curJson, nextJson) {
	const nextBytes = Buffer.byteLength(nextJson, 'utf8');
	return nextBytes <= _PRESENCE_ENTRY_MAX_BYTES || nextBytes <= Buffer.byteLength(curJson, 'utf8');
}

// Atomic sticky-field merge into a roster entry's data field, gated on the
// entry still being present. KEYS[1] = the roster hash; ARGV = count field,
// data field, the JSON delta (null value = delete the field), the TTL, the
// entry byte cap. Returns 0 (and writes nothing) when the count field is
// gone, so a release that lands between a read and a write cannot resurrect
// a phantom data row with no count. Returns 2 (and writes nothing) when the
// merged entry would exceed the byte cap without shrinking the entry.
// One round-trip; the JS fallback below covers a redis without scripting.
export const _PRESENCE_MERGE_SCRIPT =
	"if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end\n" +
	"local raw = redis.call('HGET', KEYS[1], ARGV[2])\n" +
	"local cur = {}\n" +
	"if raw then local ok, parsed = pcall(cjson.decode, raw); if ok and type(parsed) == 'table' then cur = parsed end end\n" +
	"local delta = cjson.decode(ARGV[3])\n" +
	"for k, v in pairs(delta) do if v == cjson.null then cur[k] = nil else cur[k] = v end end\n" +
	"local encoded; if next(cur) == nil then encoded = '{}' else encoded = cjson.encode(cur) end\n" +
	"if #encoded > tonumber(ARGV[5]) and (not raw or #encoded > #raw) then return 2 end\n" +
	"redis.call('HSET', KEYS[1], ARGV[2], encoded)\n" +
	"redis.call('EXPIRE', KEYS[1], ARGV[4])\n" +
	"return 1";

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
 * @returns {((wireTopic: string, event: string, data: any) => void) | null}
 */
export function _ownerReplayPublisher(platform) {
	if (!platform) return null;
	return (wireTopic, event, data) => {
		if (platform.replay) _registerReplayTopic(wireTopic);
		if (!_maybeReplayPublish(platform, wireTopic, event, data)) _platformPublish(platform, wireTopic, event, data, UNSEQUENCED);
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
	const ownerPublish = publishLeave || _ownerReplayPublisher(platform) || (() => {});
	const targets = [];
	// Mark every target synchronously: a later ref's grace timer must not erase
	// its retry ownership while an earlier ref waits for Redis.
	for (const [refKey, ref] of _presenceRef) {
		const sep = refKey.lastIndexOf('\0');
		if (sep < 0 || refKey.slice(sep + 1) !== userId) continue;
		const topic = refKey.slice(0, sep);
		if (!_topicInTenant(tenantId, topic)) continue;
		if (ref.timer) { clearTimer(ref.timer); ref.timer = null; }
		ref.gone = true;
		ref.count = 0;
		ref.data = null;
		ref.erasure ??= { presenceDone: false, ownerDone: false, ownerUnconfirmed: false, pending: null };
		targets.push({ refKey, ref, topic });
	}
	let removed = 0;
	let failed = false;
	for (const { refKey, ref, topic } of targets) {
		const progress = ref.erasure;
		if (!progress.pending) {
			progress.pending = Promise.resolve().then(async () => {
				if (ref.joining) await ref.joining;
				if (ref.leaving) await ref.leaving;
				let incomplete = false;
				if (!progress.presenceDone) {
					try {
						const redis = platform && platform.redis;
						if (redis && typeof redis.hincrby === 'function') {
							// HDEL is idempotent even if Redis applied a previous attempt
							// whose response never reached this process.
							const count = await redis.hdel(_PRESENCE_KEY_PREFIX + topic, 'c:' + userId, 'd:' + userId);
							if (!Number.isSafeInteger(count) || count < 0) throw new Error('Presence erasure was not confirmed');
						}
						progress.presenceDone = true;
						if (publishLeave) { try { publishLeave(topic + ':presence', 'leave', { key: userId }, UNSEQUENCED); } catch { /* best-effort */ } }
					} catch { incomplete = true; }
				}
				if (!progress.ownerDone) {
					try {
						const { owner, change } = await _ownerPurge(platform, topic, userId);
						progress.ownerDone = true;
						if (change) _ownerEmit(topic, tenantId, change, ownerPublish);
						else if (progress.ownerUnconfirmed) _ownerEmit(topic, tenantId, {
							owner, previous: null, reason: owner === null ? 'vacated' : 'succeeded', _hook: null
						}, ownerPublish);
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
 * The forward `update` publish has already been sent by the caller; this merge
 * only carries the sticky subset onto the roster entry so a subscriber who
 * loads the roster after the update still sees the field. An entry only exists
 * once presence has been set, so a missing entry (no live roster row) is a
 * no-op: there is nothing to stamp the field onto. The merged entry is capped
 * at `_PRESENCE_ENTRY_MAX_BYTES` serialized (growth beyond the cap is dropped;
 * a merge that shrinks the entry always applies).
 *
 * @param {any} platform
 * @param {string} topic
 * @param {string} key
 * @param {Record<string, any>} delta
 */
export async function _clusterPresenceMerge(platform, topic, key, delta) {
	// In-memory roster (the no-redis snapshot path reads ref.data by reference).
	const ref = _presenceRef.get(topic + '\0' + key);
	if (ref && ref.data && typeof ref.data === 'object') {
		const next = { ...ref.data };
		for (const k of Object.keys(delta)) {
			if (delta[k] == null) delete next[k]; else next[k] = delta[k];
		}
		// Apply only within the entry byte cap; a merge that shrinks
		// the entry always applies so a release can never be pinned by the cap.
		let nextJson, curJson;
		// `?? null` / `?? ''`: JSON.stringify RETURNS undefined (it does not throw)
		// for a value whose toJSON yields undefined, and Buffer.byteLength would
		// then throw out of the merge.
		try { nextJson = JSON.stringify(next) ?? null; } catch { nextJson = null; }
		try { curJson = JSON.stringify(ref.data) ?? ''; } catch { curJson = ''; }
		if (nextJson !== null && _presenceMergeWithinCap(curJson, nextJson)) ref.data = next;
	}
	// Cluster roster (the redis snapshot path reads the 'd:'+key JSON field).
	const redis = platform && platform.redis;
	if (!redis) return;
	const hKey = _PRESENCE_KEY_PREFIX + topic;
	const dataField = 'd:' + key;
	const countField = 'c:' + key;
	// Preferred path: one atomic server-side merge gated on the count field, so a
	// concurrent release cannot leave a phantom data row behind.
	if (typeof redis.eval === 'function') {
		try {
			await redis.eval(
				_PRESENCE_MERGE_SCRIPT, 1, hKey, countField, dataField,
				JSON.stringify(delta), String(_PRESENCE_TTL_SEC), String(_PRESENCE_ENTRY_MAX_BYTES)
			);
		} catch { /* redis blip: in-memory already merged; forward update already sent */ }
		return;
	}
	// Fallback for a redis without scripting: read, merge, then re-check the
	// count still exists right before the write to narrow the same race.
	if (typeof redis.hget !== 'function') return;
	try {
		const raw = await redis.hget(hKey, dataField);
		if (raw == null) return; // no live entry yet: nothing to carry the field
		let cur; try { cur = JSON.parse(raw); } catch { return; }
		if (cur == null || typeof cur !== 'object') cur = {};
		for (const k of Object.keys(delta)) {
			if (delta[k] == null) delete cur[k]; else cur[k] = delta[k];
		}
		const encoded = JSON.stringify(cur);
		if (!_presenceMergeWithinCap(raw, encoded)) return;
		if (typeof redis.hexists === 'function' && !(await redis.hexists(hKey, countField))) return;
		await redis.hset(hKey, dataField, encoded);
		try { await redis.expire(hKey, _PRESENCE_TTL_SEC); } catch { /* best-effort */ }
	} catch { /* redis blip: in-memory already merged; forward update already sent */ }
}
