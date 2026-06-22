// @ts-check

/**
 * Cluster-shared roster for `live.room` enumeration (`<export>.rooms()`). Used
 * when `platform.redis` is wired by the host app (raw ioredis-shaped client with
 * hincrby / hset / hdel / hgetall / hget / expire). Falls back to the in-process
 * registry in `room.js` when absent, preserving zero-config dev behavior.
 *
 * Storage layout (one Redis HASH per enumerable room export):
 *   key:    `__live-rooms:{enumId}`   (enumId = the export's stable module path)
 *   fields: 'c:{topic}' -> integer (cluster-wide subscriber count for the room)
 *           'm:{topic}' -> JSON `{ args, meta }` (the room's card, captured once)
 *
 * Cluster semantics:
 * - The replica that takes a room's count from 0->1 is the cluster-wide opener:
 *   it captures the card (resolving `meta(args)` once) and publishes 'created'.
 *   Subsequent subscribers anywhere in the cluster just bump the count and read
 *   the opener's card back, so `meta` is resolved once per open cluster-wide.
 * - The replica that takes the count from 1->0 is the cluster-wide closer: it
 *   removes both fields and publishes 'deleted'. Any other release publishes
 *   'updated' with the new cluster-wide count.
 * - The list loader returns the full HGETALL view, so a lobby viewer attached to
 *   any replica sees every replica's active rooms, not just the local ones.
 *
 * The count is the live subscriber count summed across the cluster (each local
 * subscribe is +1, each local unsubscribe -1). Like presence, the hash carries a
 * TTL refreshed on activity so a replica that dies without a clean disconnect
 * cannot leak a phantom count forever - a silent room expires after the window.
 *
 * This is a best-effort, eventually-consistent roster, exactly like the cluster
 * presence store - appropriate for a lobby view, not a transactional ledger:
 * - A Redis error fails CLOSED: the helper returns null and the subscriber is
 *   simply not enumerated this time, rather than publishing a delta with a count
 *   that does not match the shared hash. The count self-corrects on the next
 *   successful op or via the TTL. (Presence fails open because its roster is a
 *   per-user set the client dedupes; a room count is a running sum, so a wrong
 *   count would be visible - hence the difference.)
 * - `meta(args)` is resolved once per open in the common case (only the 0->1
 *   opener resolves it); under a rare concurrent cold-open two replicas may both
 *   resolve it. That is harmless as long as `meta` is a PURE, JSON-serializable
 *   function of `args` - which it must be (it crosses the wire as JSON).
 * - The TTL is refreshed on subscribe/unsubscribe activity, not on reads, so a
 *   room whose membership does not change for the whole window can expire from
 *   the roster and reappear on the next change. A periodic per-replica heartbeat
 *   would remove that idle horizon; it is a deliberate follow-up, not shipped here.
 */
const _ROOMS_KEY_PREFIX = '__live-rooms:';
const _ROOMS_TTL_SEC = 3600;

// The enumeration pub/sub channel is `_ENUM_TOPIC_PREFIX + enumId`. Both the
// adapter wire-topic gate and the cluster bus envelope validator cap a topic at
// 256 chars (svelte-adapter-uws isValidWireTopic / extensions bus-validate
// isValidBusTopic), so an over-long id would make the bus SILENTLY drop the
// cross-instance deltas. `_stableEnumId` keeps the id under that budget.
export const _ENUM_TOPIC_PREFIX = 'rooms-enum:';
const _ENUM_ID_MAX = 256 - _ENUM_TOPIC_PREFIX.length;

// FNV-1a (32-bit), kept in 32-bit unsigned space via Math.imul + >>> 0 so the
// result is identical across engines (every replica must agree), base36 encoded.
function _hash36(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

/**
 * A cluster-stable, bus-safe enumeration id derived from an export's module path
 * (`rel/name`). The path is used verbatim in every realistic case, so the Redis
 * roster key and the pub/sub topic stay human-readable in logs and redis-cli. A
 * pathologically long path - one that would push the `rooms-enum:` topic past the
 * 256-char cap and make the cluster bus silently drop its deltas - is truncated
 * with a deterministic hash suffix: every replica derives the SAME id (so they
 * still agree), the prefix keeps it legible, and the suffix keeps two long paths
 * that share a prefix from colliding.
 *
 * @param {string} path
 * @returns {string}
 */
export function _stableEnumId(path) {
	const id = typeof path === 'string' ? path : String(path);
	if (id.length <= _ENUM_ID_MAX) return id;
	const suffix = '-' + _hash36(id);
	return id.slice(0, _ENUM_ID_MAX - suffix.length) + suffix;
}

/**
 * Read a room's captured card (`{ args, meta }`) back from the hash. Returns
 * null when the field is absent, the client lacks `hget`, or the stored JSON is
 * corrupt - the caller then falls back to the args/meta it already holds.
 * @param {any} redis
 * @param {string} hKey
 * @param {string} metaField
 * @returns {Promise<{ args: any[], meta: any } | null>}
 */
async function _readCard(redis, hKey, metaField) {
	if (typeof redis.hget !== 'function') return null;
	try {
		const raw = await redis.hget(hKey, metaField);
		if (raw == null) return null;
		const parsed = JSON.parse(raw);
		return { args: Array.isArray(parsed.args) ? parsed.args : [], meta: parsed.meta };
	} catch {
		return null;
	}
}

/**
 * Bump the cluster-wide subscriber count for (enumId, topic). On the 0->1
 * transition this replica is the opener: it resolves the card via `getMeta()`
 * (so `meta(args)` runs once per open cluster-wide) and stores it. Otherwise it
 * reads the opener's card back. Returns `{ isFirst, count, args, meta }` - the
 * caller publishes 'created' when isFirst, else 'updated', carrying the cluster
 * count and the authoritative card. Returns null when platform.redis is missing
 * (the caller then uses the in-memory registry).
 *
 * @param {any} platform
 * @param {string} enumId
 * @param {string} topic
 * @param {any[]} args
 * @param {() => any} getMeta - resolves the room card; called only by the opener.
 * @returns {Promise<{ isFirst: boolean, count: number, args: any[], meta: any } | null>}
 */
export async function _clusterRoomsAcquire(platform, enumId, topic, args, getMeta) {
	const redis = platform && platform.redis;
	if (!redis || typeof redis.hincrby !== 'function') return null;
	const hKey = _ROOMS_KEY_PREFIX + enumId;
	const countField = 'c:' + topic;
	const metaField = 'm:' + topic;
	const safeArgs = Array.isArray(args) ? args : [];
	try {
		const count = await redis.hincrby(hKey, countField, 1);
		if (count === 1) {
			// Cluster-wide opener: capture the room card once.
			const meta = typeof getMeta === 'function' ? getMeta() : undefined;
			let serialized;
			try { serialized = JSON.stringify({ args: safeArgs, meta }); }
			catch { serialized = JSON.stringify({ args: [], meta: undefined }); }
			await redis.hset(hKey, metaField, serialized);
			await redis.expire(hKey, _ROOMS_TTL_SEC);
			return { isFirst: true, count, args: safeArgs, meta };
		}
		// A later subscriber: read the opener's captured card so the delta carries
		// the meta resolved once at open, not a recomputed copy.
		const card = await _readCard(redis, hKey, metaField);
		try { await redis.expire(hKey, _ROOMS_TTL_SEC); } catch { /* best-effort */ }
		return {
			isFirst: false,
			count,
			args: card ? card.args : safeArgs,
			meta: card ? card.meta : (typeof getMeta === 'function' ? getMeta() : undefined)
		};
	} catch {
		// Redis blip: fail closed. The increment did not land, so enumerating this
		// subscriber would publish a 'created'/'updated' with a count the shared
		// hash does not hold. Skip it; the count self-corrects on the next
		// successful op or via the TTL.
		return null;
	}
}

/**
 * Decrement the cluster-wide subscriber count for (enumId, topic). On the 1->0
 * transition this replica is the closer: it removes both fields and returns
 * isLast=true (the caller publishes 'deleted'). Otherwise it returns the
 * remaining cluster count plus the room card (the caller publishes 'updated').
 * Returns null when platform.redis is missing.
 *
 * @param {any} platform
 * @param {string} enumId
 * @param {string} topic
 * @returns {Promise<{ isLast: boolean, count: number, args: any[], meta: any } | null>}
 */
export async function _clusterRoomsRelease(platform, enumId, topic) {
	const redis = platform && platform.redis;
	if (!redis || typeof redis.hincrby !== 'function') return null;
	const hKey = _ROOMS_KEY_PREFIX + enumId;
	const countField = 'c:' + topic;
	const metaField = 'm:' + topic;
	try {
		const count = await redis.hincrby(hKey, countField, -1);
		if (count <= 0) {
			await redis.hdel(hKey, countField, metaField);
			return { isLast: true, count: 0, args: [], meta: undefined };
		}
		const card = await _readCard(redis, hKey, metaField);
		try { await redis.expire(hKey, _ROOMS_TTL_SEC); } catch { /* best-effort */ }
		return { isLast: false, count, args: card ? card.args : [], meta: card ? card.meta : undefined };
	} catch {
		// Redis blip: fail closed (no spurious 'deleted'). The decrement did not
		// land, so the count is unchanged; an inflated count is less disruptive
		// than a room that vanishes with players still in it. The next successful
		// op or the TTL reconciles it.
		return null;
	}
}

/**
 * Return the cluster-wide active-rooms snapshot for an export as
 * `[{ topic, args, count, meta }, ...]`. Returns null when platform.redis is
 * missing (the caller then returns the in-memory registry snapshot).
 *
 * @param {any} platform
 * @param {string} enumId
 * @returns {Promise<Array<{ topic: string, args: any[], count: number, meta: any }> | null>}
 */
export async function _clusterRoomsList(platform, enumId) {
	const redis = platform && platform.redis;
	if (!redis || typeof redis.hgetall !== 'function') return null;
	const hKey = _ROOMS_KEY_PREFIX + enumId;
	try {
		const all = await redis.hgetall(hKey);
		/** @type {Map<string, number>} */
		const counts = new Map();
		/** @type {Map<string, { args: any[], meta: any }>} */
		const cards = new Map();
		for (const field of Object.keys(all)) {
			if (field.length < 3 || field[1] !== ':') continue;
			const topic = field.slice(2);
			if (field[0] === 'c') {
				const n = parseInt(all[field], 10);
				if (Number.isFinite(n) && n > 0) counts.set(topic, n);
			} else if (field[0] === 'm') {
				try {
					const parsed = JSON.parse(all[field]);
					cards.set(topic, { args: Array.isArray(parsed.args) ? parsed.args : [], meta: parsed.meta });
				} catch { /* skip corrupt card */ }
			}
		}
		const out = [];
		for (const [topic, count] of counts) {
			const card = cards.get(topic);
			// A count whose card has not landed yet (the brief window between the
			// opener's increment and its card write) is not ready - skip it rather
			// than surface a room with no args/meta; it appears on the next list.
			if (!card) continue;
			out.push({ topic, args: card.args, count, meta: card.meta });
		}
		return out;
	} catch {
		return [];
	}
}
