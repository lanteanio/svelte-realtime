// @ts-check
import { _presenceRef } from './state.js';
import { clearTimer } from '../shared/runtime.js';
import { _topicInTenant } from './tenant.js';
import { _ownerOnLeave, _ownerEmit } from './room-owner.js';
import { _maybeReplayPublish, _registerReplayTopic } from './replay-routing.js';

/**
 * Direct handle to the in-memory presence-ref map for tests that need to seed
 * or inspect a roster entry without driving a full socket subscribe. Not part
 * of the public surface.
 * @internal
 * @returns {Map<string, { count: number, timer: ReturnType<typeof setTimeout> | null, data: any }>}
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

// Atomic sticky-field merge into a roster entry's data field, gated on the
// entry still being present. KEYS[1] = the roster hash; ARGV = count field,
// data field, the JSON delta (null value = delete the field), the TTL. Returns
// 0 (and writes nothing) when the count field is gone, so a release that lands
// between a read and a write cannot resurrect a phantom data row with no count.
// One round-trip; the JS fallback below covers a redis without scripting.
const _PRESENCE_MERGE_SCRIPT =
	"if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end\n" +
	"local raw = redis.call('HGET', KEYS[1], ARGV[2])\n" +
	"local cur = {}\n" +
	"if raw then local ok, parsed = pcall(cjson.decode, raw); if ok and type(parsed) == 'table' then cur = parsed end end\n" +
	"local delta = cjson.decode(ARGV[3])\n" +
	"for k, v in pairs(delta) do if v == cjson.null then cur[k] = nil else cur[k] = v end end\n" +
	"local encoded; if next(cur) == nil then encoded = '{}' else encoded = cjson.encode(cur) end\n" +
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
		await redis.hset(hKey, dataField, serialized);
		const count = await redis.hincrby(hKey, countField, 1);
		if (count === 1) {
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
		if (!_maybeReplayPublish(platform, wireTopic, event, data)) platform.publish(wireTopic, event, data);
	};
}

/**
 * Right-to-erasure (`live.forget`): drop every presence-ref entry a user holds,
 * scoped to one tenant. Refs are keyed `topic\0userKey`; the userKey is the
 * segment after the LAST `\0` (a validated wire topic and a validated userId
 * each contain no `\0`, so there is exactly one separator). For each match the
 * grace-leave timer is cleared FIRST (entries hold a live setTimeout), the local
 * ref deleted, then - when a platform is wired - the cluster roster is
 * decremented and, if this was the last holder cluster-wide, a `leave` is
 * published so other replicas and subscribers drop the user; otherwise a phantom
 * presence counter lingers in the Redis roster. A custom presence key that is
 * not the userId is not user-addressable and is left untouched.
 * @param {any} platform the configured forget platform, or null for single-instance
 * @param {string | null} tenantId
 * @param {string} userId
 * @param {((wireTopic: string, event: string, data: any) => void) | null} [publishLeave]
 * @returns {Promise<number>} refs removed
 */
export async function _purgePresenceUser(platform, tenantId, userId, publishLeave) {
	if (typeof userId !== 'string' || userId.length === 0) return 0;
	// Owner succession, unlike a presence leave, does NOT self-heal on the
	// forgotten user's later disconnect: the purge already dropped its presence
	// ref, so a subsequent close hits `if (!ref) return` and never re-runs
	// succession. So the `:owner` change must be published even though the forget
	// cascade wires no `publishLeave`. Route it through the platform and, when the
	// replay extension is present, through the `:owner` replay buffer, so live
	// subscribers update AND a resuming or fresh client gap-fills the successor
	// rather than reading the erased owner.
	const _ownerPublish = _ownerReplayPublisher(platform);
	let n = 0;
	for (const [refKey, ref] of [..._presenceRef]) {
		const sep = refKey.lastIndexOf('\0');
		if (sep < 0) continue;
		const topic = refKey.slice(0, sep);
		const key = refKey.slice(sep + 1);
		if (key !== userId) continue;
		if (!_topicInTenant(tenantId, topic)) continue;
		if (ref.timer) { clearTimer(ref.timer); ref.timer = null; }
		_presenceRef.delete(refKey);
		n++;
		if (platform) {
			try {
				const res = await _clusterPresenceRelease(platform, topic, key);
				if (res && res.isLast && publishLeave) {
					try { publishLeave(topic + ':presence', 'leave', { key }); } catch { /* publish best-effort */ }
				}
			} catch { /* cluster release best-effort; the local ref is already gone */ }
		}
		// A purged user must also drop any room-owner role it holds, or the
		// room would keep a forgotten identity as owner until the roster TTL.
		// A topic without owner tracking is a no-op inside the helper.
		try {
			const change = await _ownerOnLeave(platform, topic, key);
			if (change) _ownerEmit(topic, tenantId, change, publishLeave || _ownerPublish || (() => { /* no platform: nothing to publish through */ }));
		} catch { /* owner release best-effort; the membership is already gone */ }
	}
	return n;
}

/**
 * Return the cluster-wide presence roster for a topic as `[{key, data}, ...]`.
 * Falls through to the local _presenceRef iteration when platform.redis is
 * missing.
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
 * no-op: there is nothing to stamp the field onto.
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
		for (const k of Object.keys(delta)) {
			if (delta[k] == null) delete ref.data[k]; else ref.data[k] = delta[k];
		}
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
				JSON.stringify(delta), String(_PRESENCE_TTL_SEC)
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
		if (typeof redis.hexists === 'function' && !(await redis.hexists(hKey, countField))) return;
		await redis.hset(hKey, dataField, JSON.stringify(cur));
		try { await redis.expire(hKey, _PRESENCE_TTL_SEC); } catch { /* best-effort */ }
	} catch { /* redis blip: in-memory already merged; forward update already sent */ }
}
