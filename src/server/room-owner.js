// @ts-check
import { _stripTenantTopic } from './tenant.js';

// Per-room owner role with deterministic succession.
//
// A room with `owner: true` tracks which member currently holds the owner
// role. The first member to join a room claims it; when the owner leaves
// (after the presence grace window), the role passes to the longest-joined
// remaining member; when the room empties, the role clears. Join order is
// the succession order: every member gets a monotonically increasing join
// sequence when it enters the room, and the successor is always the live
// member with the lowest sequence (ties are impossible - the allocator is
// atomic - but a lexicographic key comparison backstops the JS fallback).
//
// Ownership is a property of the room, not of the cluster: it is distinct
// from cluster leadership (configureCron's leader), which elects one
// INSTANCE. The owner is one MEMBER, keyed by the same identity key
// presence uses (the authenticated user id, or a per-connection guest id).
// An authenticated owner therefore survives a reconnect inside the grace
// window; a guest owner does not survive a socket swap - its old identity
// leaves and succession runs, which is the correct self-healing behavior.
//
// Storage:
// - Single instance: a module-local Map (topic -> { owner, seq, members }).
// - Cluster (`platform.redis`): one Redis HASH per topic, key
//   `__live-room-owner:{topic}` with fields
//     'o'       -> current owner identity key
//     'q'       -> join-sequence allocator
//     'j:{key}' -> the member's join sequence
//     'n:{key}' -> cluster-wide connection count for the identity
//   The hash carries the same idle TTL as the presence roster and refreshes
//   on join/leave activity. All decisions run in a single Lua script per
//   transition, so concurrent joins and leaves on different replicas
//   serialize on Redis and exactly ONE replica observes each ownership
//   change - that replica publishes the handoff event and fires the
//   onOwnerChange hook, so the change is decided and announced once
//   cluster-wide. A redis client without scripting falls back to plain
//   hash commands with the same shape (races narrowed, not eliminated).
//
// Failure philosophy: fail CLOSED. A Redis blip during a transition makes
// that transition a no-op (no false claim, no double owner); the next join
// self-heals a stale or missing owner (the join script re-claims when the
// recorded owner has no live membership). Counts orphaned by a crashed
// replica are TTL-bounded, exactly like the presence roster's accepted
// residual.
//
// Determinism: no clock, no RNG, no timers. Sequences come from the local
// counter or Redis HINCRBY; the grace window is presence's (room.js owns
// the timer).

const _OWNER_KEY_PREFIX = '__live-room-owner:';
const _OWNER_TTL_SEC = 3600;

// First-joiner owner delivery, sequenced (not timed).
//
// The first-and-only member of an owner room claims ownership on its DATA
// stream subscribe (`_ownerOnJoin`), while the client's owner value comes from
// the paired `:owner` sub-stream subscribe. Those are two subscribes in one wire
// batch on one socket, resolved by two independent async chains; a value emitted
// off the data-join (a live publish, or a deferred unicast) can reach the socket
// BEFORE the client has registered the `:owner` topic store from that stream's
// subscribe response, and is then dropped - the pre-claim `null` snapshot wins.
// A timer cannot fix this: the subscribe response lags behind its own replay
// round-trips by a variable amount, so no fixed delay orders after it.
//
// The fix SEQUENCES the value into the subscribe response itself: a per-(socket,
// wire-topic) barrier is opened synchronously when the data-stream subscribe
// resolves its topic (dispatch, in the batch's synchronous prefix, before any
// loader body runs), the data-join RESOLVES it with the claimed owner, and the
// `:owner` loader AWAITS it and returns that value as its snapshot. The client
// registers the store from a response that already carries the owner - there is
// no racing second frame. A `null` resolution (a late joiner that claimed
// nothing, a reconnect, a hook that threw) makes the loader read the shared
// store instead, so a non-first subscriber still sees the current owner.
//
// Determinism preserved: a plain resolved Promise, no clock/RNG/timer. Keyed in
// a WeakMap by the socket so a disconnect drops any unconsumed barrier for free.
/** @type {WeakMap<any, Map<string, { promise: Promise<any>, resolve: (v: any) => void, expected: boolean, settled: boolean }>>} */
const _ownerClaimByWs = new WeakMap();

// The same barrier machinery serves the `:presence` sub-stream's first-joiner
// self delivery: the data-join's presence acquire races the paired `:presence`
// loader inside one parallel subscribe batch (the acquire's shared-roster write
// - delayed further by the owner join's round-trips in an owner room - can land
// AFTER the loader's roster read), and the acquire's live 'join' can hit the
// socket before the client registers the `:presence` store, so the joiner never
// sees itself. Slots are keyed per (socket, wire data topic) with a `\0`
// namespace suffix separating the presence barrier from the owner barrier on
// the same topic (a validated wire topic contains no `\0`).
const _PRESENCE_CLAIM_NS = '\0presence';

function _ownerClaimSlot(ws, key, create) {
	if (!ws) return undefined;
	let m = _ownerClaimByWs.get(ws);
	if (!m) {
		if (!create) return undefined;
		m = new Map();
		_ownerClaimByWs.set(ws, m);
	}
	let slot = m.get(key);
	if (!slot && create) {
		/** @type {(v: any) => void} */
		let resolve = () => {};
		const promise = new Promise((r) => { resolve = r; });
		slot = { promise, resolve, expected: false, settled: false };
		m.set(key, slot);
	}
	return slot;
}

function _claimBeginKey(ws, key) {
	const slot = _ownerClaimSlot(ws, key, true);
	if (slot) slot.expected = true;
}

function _claimResolveKey(ws, key, value) {
	const slot = _ownerClaimSlot(ws, key, true);
	if (slot && !slot.settled) {
		slot.settled = true;
		slot.resolve(value ?? null);
	}
}

async function _claimAwaitKey(ws, key) {
	const slot = _ownerClaimSlot(ws, key, false);
	if (!slot || !slot.expected) return undefined;
	const value = await slot.promise;
	const m = _ownerClaimByWs.get(ws);
	if (m) { m.delete(key); if (m.size === 0) _ownerClaimByWs.delete(ws); }
	return value && value.key != null ? value : undefined;
}

/**
 * Open the claim barrier for a socket's owner-room data-stream subscribe. Called
 * synchronously at dispatch topic-resolution (before the paired `:owner` loader
 * can run this batch), so `expected` is set when that loader checks. Idempotent.
 * @param {any} ws
 * @param {string} topic wire data topic
 */
export function _ownerClaimBegin(ws, topic) {
	_claimBeginKey(ws, topic);
}

/**
 * Resolve the barrier with the claimed owner (first write wins). The data-join
 * calls this with `{ key, reason }` after `_ownerOnJoin`; dispatch calls it with
 * `null` after the subscribe hook as a settle, so an early-return/throw path
 * never leaves the `:owner` loader waiting.
 * @param {any} ws
 * @param {string} topic wire data topic
 * @param {{ key: string, reason: string } | null} value
 */
export function _ownerClaimResolve(ws, topic, value) {
	_claimResolveKey(ws, topic, value);
}

/**
 * The `:owner` loader's read: if a data-join for this socket+room is in flight
 * this batch (barrier opened), await its claimed owner and return it; otherwise
 * (a late/lone subscribe with no fresh claim) return undefined so the caller
 * reads the shared store. Consumes the barrier so a later resubscribe is clean.
 * @param {any} ws
 * @param {string} topic wire data topic
 * @returns {Promise<{ key: string, reason: string } | undefined>}
 */
export async function _ownerClaimAwait(ws, topic) {
	return _claimAwaitKey(ws, topic);
}

/**
 * Open the presence self-delivery barrier for a socket's presence-room
 * data-stream subscribe. Called synchronously at dispatch topic-resolution
 * (before the paired `:presence` loader can run this batch), so `expected` is
 * set when that loader checks. Idempotent.
 * @param {any} ws
 * @param {string} topic wire data topic
 */
export function _presenceClaimBegin(ws, topic) {
	_claimBeginKey(ws, topic + _PRESENCE_CLAIM_NS);
}

/**
 * Resolve the barrier with the joiner's own roster entry. The data-join calls
 * this with `{ key, data }` the moment the presence payload exists (before the
 * shared-roster acquire lands); dispatch calls it with `null` after the
 * subscribe hook as a settle, so an early-return/throw path never leaves the
 * `:presence` loader waiting.
 * @param {any} ws
 * @param {string} topic wire data topic
 * @param {{ key: string, data: any } | null} value
 */
export function _presenceClaimResolve(ws, topic, value) {
	_claimResolveKey(ws, topic + _PRESENCE_CLAIM_NS, value);
}

/**
 * The `:presence` loader's read: if a data-join for this socket+room is in
 * flight this batch (barrier opened), await its roster entry so the snapshot
 * can carry the joiner's own presence even when the shared-roster write has
 * not landed yet; otherwise (a lone presence viewer with no paired data-join)
 * return undefined so the roster is served as read. Consumes the barrier.
 * @param {any} ws
 * @param {string} topic wire data topic
 * @returns {Promise<{ key: string, data: any } | undefined>}
 */
export async function _presenceClaimAwait(ws, topic) {
	return _claimAwaitKey(ws, topic + _PRESENCE_CLAIM_NS);
}

/**
 * Drop any claim barriers a socket holds for a room's wire data topic - the
 * owner slot and the presence slot. Called when the socket's data-stream
 * subscription for the topic drains: a slot left by a data-join that never
 * paired with a sub-stream subscribe in its own batch must not outlive the
 * membership, or a LATER lone :owner / :presence subscribe on the same socket
 * would consume the stale claim (a departed member injected into the roster,
 * a long-vacated first-claim served as the owner snapshot).
 * @param {any} ws
 * @param {string} topic wire data topic
 */
export function _claimBarriersClear(ws, topic) {
	if (!ws) return;
	const m = _ownerClaimByWs.get(ws);
	if (!m) return;
	m.delete(topic);
	m.delete(topic + _PRESENCE_CLAIM_NS);
	if (m.size === 0) _ownerClaimByWs.delete(ws);
}

/** Reset all in-flight claim barriers (tests only). @internal */
export function _resetOwnerClaimsForTests() {
	// A WeakMap has no clear(); tests create fresh ws objects per case, so stale
	// entries are unreachable. This exists for symmetry with _resetOwnerForTests.
}

/**
 * Local per-topic owner state. In single-instance mode it is authoritative:
 * `members` maps each identity to its join sequence and `owner`/`seq` carry
 * the role and the allocator. In cluster mode Redis is authoritative and
 * `members` maps each identity to the number of join transitions THIS
 * process performed - the gate that keeps eviction/purge sweeps from
 * touching topics this room never joined (and from creating garbage hashes
 * on Redis) while every real transition still reaches the shared script.
 * @type {Map<string, { owner: string | null, seq: number, members: Map<string, number>, hook: Function | null }>}
 */
const _ownerRooms = new Map();

/** Reset all owner state (tests only). @internal */
export function _resetOwnerForTests() {
	_ownerRooms.clear();
}

// The same capability gate the room's cluster helpers use: every hash op the
// owner transitions need must exist, or the topic falls back to the local Map
// consistently (never half Redis, half memory).
const _ownerRedis = (platform) => {
	const r = platform && platform.redis;
	return r && typeof r.hincrby === 'function' && typeof r.hgetall === 'function'
		&& typeof r.hdel === 'function' && typeof r.hget === 'function' ? r : null;
};

// Join transition. Bumps the identity's cluster count, records the join
// sequence when the identity has none (kept across reconnect-within-grace
// because leave never ran; re-allocated on a true rejoin), and claims the
// owner role when the room has none - or when the recorded owner has no
// live membership (the self-heal for a stale owner left behind by a blip
// or TTL edge). Membership and owner liveness are verified on EVERY join,
// never inferred from the count: a stray count orphaned by a crashed
// replica must not suppress the sequence allocation or the claim.
// Returns {owner, reason, previous} - reason '' means no ownership change.
const _OWNER_JOIN_SCRIPT =
	"local k = ARGV[1]\n" +
	"redis.call('HINCRBY', KEYS[1], 'n:' .. k, 1)\n" +
	"redis.call('EXPIRE', KEYS[1], ARGV[2])\n" +
	"if redis.call('HGET', KEYS[1], 'j:' .. k) == false then\n" +
	"  local s = redis.call('HINCRBY', KEYS[1], 'q', 1)\n" +
	"  redis.call('HSET', KEYS[1], 'j:' .. k, s)\n" +
	"end\n" +
	"local o = redis.call('HGET', KEYS[1], 'o')\n" +
	"if o and redis.call('HGET', KEYS[1], 'j:' .. o) ~= false then return {o, '', ''} end\n" +
	"redis.call('HSET', KEYS[1], 'o', k)\n" +
	"return {k, 'claimed', o or ''}";

// Leave transition. Drops the identity's cluster count; on its 1->0 removes
// the membership and, when the departing member held the owner role, picks
// the successor: the remaining member with the lowest join sequence (key
// comparison as a pure backstop). An emptied room clears the role and the
// allocator so a future room starts fresh.
const _OWNER_LEAVE_SCRIPT =
	"local k = ARGV[1]\n" +
	"local n = redis.call('HINCRBY', KEYS[1], 'n:' .. k, -1)\n" +
	"if n > 0 then\n" +
	"  redis.call('EXPIRE', KEYS[1], ARGV[2])\n" +
	"  return {redis.call('HGET', KEYS[1], 'o') or '', '', ''}\n" +
	"end\n" +
	"redis.call('HDEL', KEYS[1], 'n:' .. k, 'j:' .. k)\n" +
	"local o = redis.call('HGET', KEYS[1], 'o')\n" +
	"if not o or o ~= k then\n" +
	"  redis.call('EXPIRE', KEYS[1], ARGV[2])\n" +
	"  return {o or '', '', ''}\n" +
	"end\n" +
	"local all = redis.call('HGETALL', KEYS[1])\n" +
	"local best = nil\n" +
	"local bestSeq = nil\n" +
	"for i = 1, #all, 2 do\n" +
	"  local f = all[i]\n" +
	"  if string.sub(f, 1, 2) == 'j:' then\n" +
	"    local cand = string.sub(f, 3)\n" +
	"    local s = tonumber(all[i + 1])\n" +
	"    if bestSeq == nil or s < bestSeq or (s == bestSeq and cand < best) then\n" +
	"      best = cand\n" +
	"      bestSeq = s\n" +
	"    end\n" +
	"  end\n" +
	"end\n" +
	"if best then\n" +
	"  redis.call('HSET', KEYS[1], 'o', best)\n" +
	"  redis.call('EXPIRE', KEYS[1], ARGV[2])\n" +
	"  return {best, 'succeeded', k}\n" +
	"end\n" +
	"redis.call('HDEL', KEYS[1], 'o', 'q')\n" +
	"return {'', 'vacated', k}";

// Explicit transfer: a compare-and-set from the current owner to a live
// member. Refused (no change) when the caller no longer holds the role or
// the target is not in the room.
const _OWNER_TRANSFER_SCRIPT =
	"local from = ARGV[1]\n" +
	"local to = ARGV[2]\n" +
	"local o = redis.call('HGET', KEYS[1], 'o')\n" +
	"if not o or o ~= from then return {o or '', '', ''} end\n" +
	"if redis.call('HGET', KEYS[1], 'j:' .. to) == false then return {o, '', ''} end\n" +
	"redis.call('HSET', KEYS[1], 'o', to)\n" +
	"redis.call('EXPIRE', KEYS[1], ARGV[3])\n" +
	"return {to, 'transferred', from}";

/**
 * Normalize a script/fallback result triple into a change record, or null
 * when the transition changed nothing (reason empty) or blipped.
 * @param {any} res
 * @returns {{ owner: string | null, previous: string | null, reason: string } | null}
 */
const _asChange = (res) => {
	if (!res || !Array.isArray(res) || !res[1]) return null;
	return {
		owner: res[0] === '' || res[0] == null ? null : String(res[0]),
		previous: res[2] === '' || res[2] == null ? null : String(res[2]),
		reason: String(res[1])
	};
};

/**
 * Run one of the owner scripts, preferring atomic server-side scripting and
 * falling back to plain hash commands for a redis without `eval`. The
 * fallback mirrors the script's reads and writes in order, so the shape is
 * identical; only the atomicity narrows (matching the presence-merge
 * fallback's contract). Any redis error returns null - fail closed.
 * @param {any} redis
 * @param {string} script
 * @param {string} hKey
 * @param {string[]} argv
 * @returns {Promise<any>}
 */
async function _runOwnerScript(redis, script, hKey, argv) {
	if (typeof redis.eval === 'function') {
		try { return await redis.eval(script, 1, hKey, ...argv); } catch { return null; }
	}
	try {
		const ttl = script === _OWNER_TRANSFER_SCRIPT ? argv[2] : argv[1];
		const expire = async () => { if (typeof redis.expire === 'function') { try { await redis.expire(hKey, ttl); } catch { /* best-effort */ } } };
		if (script === _OWNER_JOIN_SCRIPT) {
			const k = argv[0];
			await redis.hincrby(hKey, 'n:' + k, 1);
			await expire();
			if ((await redis.hget(hKey, 'j:' + k)) == null) {
				const s = await redis.hincrby(hKey, 'q', 1);
				await redis.hset(hKey, 'j:' + k, String(s));
			}
			const o = await redis.hget(hKey, 'o');
			if (o != null && o !== '' && (await redis.hget(hKey, 'j:' + o)) != null) return [o, '', ''];
			await redis.hset(hKey, 'o', k);
			return [k, 'claimed', o == null ? '' : o];
		}
		if (script === _OWNER_LEAVE_SCRIPT) {
			const k = argv[0];
			const n = await redis.hincrby(hKey, 'n:' + k, -1);
			if (n > 0) { await expire(); return [(await redis.hget(hKey, 'o')) || '', '', '']; }
			await redis.hdel(hKey, 'n:' + k, 'j:' + k);
			const o = await redis.hget(hKey, 'o');
			if (o == null || o === '' || o !== k) { await expire(); return [o == null ? '' : o, '', '']; }
			const all = await redis.hgetall(hKey);
			let best = null;
			let bestSeq = Infinity;
			for (const field of Object.keys(all)) {
				if (field.length < 3 || field[0] !== 'j' || field[1] !== ':') continue;
				const cand = field.slice(2);
				const s = parseInt(all[field], 10);
				if (s < bestSeq || (s === bestSeq && (best === null || cand < best))) { best = cand; bestSeq = s; }
			}
			if (best !== null) { await redis.hset(hKey, 'o', best); await expire(); return [best, 'succeeded', k]; }
			await redis.hdel(hKey, 'o', 'q');
			return ['', 'vacated', k];
		}
		// transfer
		const from = argv[0];
		const to = argv[1];
		const o = await redis.hget(hKey, 'o');
		if (o == null || o === '' || o !== from) return [o == null ? '' : o, '', ''];
		if ((await redis.hget(hKey, 'j:' + to)) == null) return [o, '', ''];
		await redis.hset(hKey, 'o', to);
		await expire();
		return [to, 'transferred', from];
	} catch {
		return null;
	}
}

/**
 * Membership join for an owner-tracking room. Called by the room's
 * subscribe hook at the identity's local 0->1 transition (the same point
 * presence acquires). Returns the ownership change this join caused, or
 * null when nothing changed.
 * @param {any} platform
 * @param {string} topic wire data topic
 * @param {string} key identity key
 * @param {Function | null | undefined} hook the room's onOwnerChange
 * @returns {Promise<{ owner: string | null, previous: string | null, reason: string, _hook: Function | null } | null>}
 */
export async function _ownerOnJoin(platform, topic, key, hook) {
	let entry = _ownerRooms.get(topic);
	if (!entry) {
		entry = { owner: null, seq: 0, members: new Map(), hook: hook || null };
		_ownerRooms.set(topic, entry);
	} else if (hook && !entry.hook) {
		entry.hook = hook;
	}
	const redis = _ownerRedis(platform);
	if (redis) {
		entry.members.set(key, (entry.members.get(key) || 0) + 1);
		const change = _asChange(await _runOwnerScript(redis, _OWNER_JOIN_SCRIPT, _OWNER_KEY_PREFIX + topic, [key, String(_OWNER_TTL_SEC)]));
		return change ? { ...change, _hook: entry.hook } : null;
	}
	if (entry.members.has(key)) return null;
	entry.members.set(key, ++entry.seq);
	if (entry.owner !== null && entry.members.has(entry.owner)) return null;
	const previous = entry.owner;
	entry.owner = key;
	return { owner: key, previous, reason: 'claimed', _hook: entry.hook };
}

/**
 * Membership leave for an owner-tracking room. Called at the identity's
 * final release (grace expiry, rollback, eviction, or forget-purge). A
 * topic or key this replica never joined is a no-op, which is what makes
 * the global eviction/purge sweeps safe to route through here. Returns the
 * ownership change this leave caused (succession or vacation), or null.
 * @param {any} platform
 * @param {string} topic wire data topic
 * @param {string} key identity key
 * @returns {Promise<{ owner: string | null, previous: string | null, reason: string, _hook: Function | null } | null>}
 */
export async function _ownerOnLeave(platform, topic, key) {
	const entry = _ownerRooms.get(topic);
	if (!entry || !entry.members.has(key)) return null;
	const hook = entry.hook;
	const redis = _ownerRedis(platform);
	if (redis) {
		const local = entry.members.get(key) || 0;
		if (local <= 1) {
			entry.members.delete(key);
			if (entry.members.size === 0) _ownerRooms.delete(topic);
		} else {
			entry.members.set(key, local - 1);
		}
		const change = _asChange(await _runOwnerScript(redis, _OWNER_LEAVE_SCRIPT, _OWNER_KEY_PREFIX + topic, [key, String(_OWNER_TTL_SEC)]));
		return change ? { ...change, _hook: hook } : null;
	}
	entry.members.delete(key);
	if (entry.owner !== key) {
		if (entry.members.size === 0) _ownerRooms.delete(topic);
		return null;
	}
	let best = null;
	let bestSeq = Infinity;
	for (const [k, s] of entry.members) {
		if (s < bestSeq || (s === bestSeq && (best === null || k < best))) { best = k; bestSeq = s; }
	}
	if (best !== null) {
		entry.owner = best;
		return { owner: best, previous: key, reason: 'succeeded', _hook: hook };
	}
	_ownerRooms.delete(topic);
	return { owner: null, previous: key, reason: 'vacated', _hook: hook };
}

/**
 * Explicit owner handoff: compare-and-set from the current owner to a live
 * member of the room. Returns the change, or null when refused (the caller
 * no longer holds the role, the target is not a member, or self-transfer).
 * @param {any} platform
 * @param {string} topic wire data topic
 * @param {string} from the caller's identity key (must hold the role)
 * @param {string} to the target identity key (must be a member)
 * @returns {Promise<{ owner: string | null, previous: string | null, reason: string, _hook: Function | null } | null>}
 */
export async function _ownerTransfer(platform, topic, from, to) {
	if (from === to) return null;
	const entry = _ownerRooms.get(topic);
	const hook = entry ? entry.hook : null;
	const redis = _ownerRedis(platform);
	if (redis) {
		const change = _asChange(await _runOwnerScript(redis, _OWNER_TRANSFER_SCRIPT, _OWNER_KEY_PREFIX + topic, [from, to, String(_OWNER_TTL_SEC)]));
		return change ? { ...change, _hook: hook } : null;
	}
	if (!entry || entry.owner !== from || !entry.members.has(to)) return null;
	entry.owner = to;
	return { owner: to, previous: from, reason: 'transferred', _hook: hook };
}

/**
 * Read the room's current owner identity key, or null when the room has
 * none (never claimed, vacated, or a Redis blip - fail closed, never a
 * stale guess).
 * @param {any} platform
 * @param {string} topic wire data topic
 * @returns {Promise<string | null>}
 */
export async function _ownerGet(platform, topic) {
	const redis = _ownerRedis(platform);
	if (redis) {
		try {
			const o = await redis.hget(_OWNER_KEY_PREFIX + topic, 'o');
			return o == null || o === '' ? null : String(o);
		} catch {
			return null;
		}
	}
	const entry = _ownerRooms.get(topic);
	return entry ? entry.owner : null;
}

/**
 * Announce an ownership change: publish the handoff event on the room's
 * `:owner` sub-topic (the wire topic is already tenant-prefixed, so the
 * publish must be the raw non-prefixing one) and fire the room's
 * onOwnerChange hook with the LOGICAL topic. Both are fired only by the
 * replica that performed the change, so the announcement is single-fire
 * cluster-wide; the event itself rides the pub/sub bus to every replica's
 * subscribers.
 * @param {string} topic wire data topic
 * @param {string | null | undefined} tenantId
 * @param {{ owner: string | null, previous: string | null, reason: string, _hook: Function | null }} change
 * @param {(topic: string, event: string, data: any) => void} publishFn raw wire publish
 */
export function _ownerEmit(topic, tenantId, change, publishFn) {
	try { publishFn(topic + ':owner', 'set', { key: change.owner, reason: change.reason }); } catch { /* publish best-effort */ }
	const hook = change._hook;
	if (typeof hook === 'function') {
		const logical = _stripTenantTopic(tenantId, topic);
		Promise.resolve().then(() => hook({ topic: logical, owner: change.owner, previous: change.previous, reason: change.reason })).catch(() => { /* app hook must not break the transition */ });
	}
}
