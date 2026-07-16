// @ts-check
import { live, close, unsubscribe, handleRpc } from '../server.js';
import { wallEpoch, setTimer, clearTimer } from '../shared/runtime.js';
import { _runGuard } from './dispatch.js';
import { LiveError } from './live-error.js';
import { _validSegmentRe } from './validate.js';
import { _IS_DEV } from './env.js';
import { state, _presenceRef } from './state.js';
import { _clusterPresenceAcquire, _clusterPresenceRelease, _clusterPresenceList } from './presence.js';
import { _clusterRoomsAcquire, _clusterRoomsRelease, _clusterRoomsList, _stableEnumId, _ENUM_TOPIC_PREFIX } from './rooms-cluster.js';
import { _resolveHistoryConfig, _createHistoryStore, _freezeSnapshot } from './history-compensation.js';
import { _getIdentityKey } from './identity.js';
import { _tenantTopic, _tenantKey, _stripTenantTopic } from './tenant.js';
import { _registerEnumGate, _seedEnumVisibility } from './rooms-gate.js';
import { _ownerOnJoin, _ownerOnLeave, _ownerTransfer, _ownerGet, _ownerEmit, _ownerClaimResolve, _ownerClaimAwait, _presenceClaimResolve, _presenceClaimAwait, _claimBarriersClear } from './room-owner.js';
import { _registerReplayTopic } from './replay-routing.js';
import { _bindAlarmCtx } from './alarm.js';

// Seam: the shared topic-fn resolver (_callTopicFn) and the rollback marker
// set (_rollingBack) stay in server.js - the staying stream-subscribe rollback
// path writes _rollingBack and the room onUnsubscribe reads it. Set at init
// (mirrors installSmooth).
let _callTopicFn, _rollingBack;
export function installRoom(seams) {
	_callTopicFn = seams.callTopicFn;
	_rollingBack = seams.rollingBack;
}

/**
 * Create a collaborative room that bundles data stream, presence, cursors, and room-scoped RPC.
 *
 * @param {{ topic: (ctx: any, ...args: any[]) => string, init: (ctx: any, ...args: any[]) => Promise<any>, presence?: (ctx: any) => any, cursors?: boolean | { throttle?: number }, actions?: Record<string, Function>, guard?: Function, onJoin?: Function, onLeave?: Function, merge?: string, key?: string }} config
 * @returns {any}
 */

// Per-export enumeration topic counter. It seeds a unique default id before the
// registry binds the stable one: `__setEnumId` (called from the registration
// path with the export's module path) swaps in a cluster-stable id so two
// replicas of one export agree on both the pub/sub topic and the Redis roster
// key. The client always reaches the stream through the generated path, never
// the raw string, so the default counter is invisible to apps.
let _roomsEnumSeq = 0;

export const _roomRegister = function room(config) {
	const {
		topic: topicFn,
		init: initFn,
		presence: presenceFn,
		cursors: cursorConfig,
		actions,
		guard: guardFn,
		onJoin,
		onLeave,
		merge: mergeMode = 'crud',
		key: keyField = 'id',
		meta: metaFn,
		enumerable: enumerableFlag,
		owner: ownerFlag,
		ownerOnly,
		onOwnerChange,
		alarm: alarmCfg
	} = config;

	if (alarmCfg !== undefined) {
		if (typeof alarmCfg !== 'object' || alarmCfg === null || typeof alarmCfg.onAlarm !== 'function') {
			throw new Error('[svelte-realtime] live.room() alarm must be an object { onAlarm: (ctx) => {...} } - the handler that runs when ctx.setAlarm fires.');
		}
		if (alarmCfg.misfireMs !== undefined && (typeof alarmCfg.misfireMs !== 'number' || !Number.isFinite(alarmCfg.misfireMs) || alarmCfg.misfireMs < 0)) {
			throw new Error('[svelte-realtime] live.room() alarm.misfireMs must be a non-negative finite number (ms of tolerated lateness before a fire is skipped).');
		}
	}

	/** @type {any} */ (topicFn).__topicUsesCtx = true;

	// Room enumeration (opt-in: a `meta` function or `enumerable`). When on, a
	// per-export registry tracks which of this room's topics currently have
	// subscribers (and how many), so `game.rooms()` can render a live lobby
	// browser. Off by default - a room without it installs no registry hooks and
	// no enumeration stream, so it is byte-identical to before.
	//
	// `enumerable` also accepts a predicate `(ctx, room) => boolean` that makes
	// visibility per-caller: it runs with the requesting connection's ctx
	// against each room - in the snapshot and, via the enumeration gate, on
	// every live delta per subscriber - and a room it denies never reaches that
	// caller's wire (no existence, no count, no meta).
	if (metaFn !== undefined && typeof metaFn !== 'function') {
		throw new Error('[svelte-realtime] live.room() meta must be a function (args) => ({ ... })\n  See: https://svti.me/rooms');
	}
	if (enumerableFlag !== undefined && typeof enumerableFlag !== 'boolean' && typeof enumerableFlag !== 'function') {
		throw new Error('[svelte-realtime] live.room() enumerable must be true, false, or a predicate (ctx, room) => boolean\n  See: https://svti.me/rooms');
	}
	const isEnumerable = enumerableFlag === true || typeof enumerableFlag === 'function' || typeof metaFn === 'function';
	const listPredicate = typeof enumerableFlag === 'function' ? enumerableFlag : null;

	// Room ownership (opt-in: `owner: true`). The first member to join a room
	// holds the owner role; when the owner leaves (after the presence grace
	// window) the role passes deterministically to the longest-joined remaining
	// member; an emptied room clears it. The handoff is observable on the
	// room's `:owner` sub-stream and via the onOwnerChange hook, which fires
	// exactly once cluster-wide (on the replica that performed the change).
	// Off by default - a room without it installs no owner bookkeeping.
	if (ownerFlag !== undefined && typeof ownerFlag !== 'boolean') {
		throw new Error('[svelte-realtime] live.room() owner must be true or false\n  See: https://svti.me/rooms');
	}
	const ownerEnabled = ownerFlag === true;
	if (onOwnerChange !== undefined && typeof onOwnerChange !== 'function') {
		throw new Error('[svelte-realtime] live.room() onOwnerChange must be a function (change) => void\n  See: https://svti.me/rooms');
	}
	if (onOwnerChange && !ownerEnabled) {
		throw new Error('[svelte-realtime] live.room() onOwnerChange requires owner: true - without owner tracking the hook would never fire.\n  See: https://svti.me/rooms');
	}
	/** @type {Set<string> | null} */
	let ownerGatedActions = null;
	if (ownerOnly !== undefined) {
		if (!ownerEnabled) {
			throw new Error('[svelte-realtime] live.room() ownerOnly requires owner: true\n  See: https://svti.me/rooms');
		}
		if (!Array.isArray(ownerOnly) || ownerOnly.some((n) => typeof n !== 'string')) {
			throw new Error('[svelte-realtime] live.room() ownerOnly must be an array of action names\n  See: https://svti.me/rooms');
		}
		if (!config.actions) {
			throw new Error('[svelte-realtime] live.room() ownerOnly requires actions\n  See: https://svti.me/rooms');
		}
		for (const n of ownerOnly) {
			if (typeof config.actions[n] !== 'function') {
				throw new Error(`[svelte-realtime] live.room() ownerOnly names unknown action '${n}' - a typo here would silently leave the action ungated.\n  See: https://svti.me/rooms`);
			}
		}
		ownerGatedActions = new Set(ownerOnly);
	}

	// Number of room-identifying args the topic function expects (excluding ctx).
	// Used by room actions to separate room args from action-specific payload.
	let _roomArgCount = Math.max(0, topicFn.length - 1);
	if (config.topicArgs !== undefined) {
		if (!Number.isInteger(config.topicArgs) || config.topicArgs < 0) {
			throw new Error(`[svelte-realtime] live.room() topicArgs must be a non-negative integer, got ${config.topicArgs}\n  See: https://svti.me/rooms`);
		}
		_roomArgCount = config.topicArgs;
	} else if (actions) {
		throw new Error(
			`[svelte-realtime] live.room() with actions requires 'topicArgs'. ` +
			`Set topicArgs to the number of room-identifying args (excluding ctx).\n  See: https://svti.me/rooms`
		);
	}

	// Action history for lag compensation. Opt-in: without a `history` config
	// the action wrapper below is unchanged and ctx.compensate stays the
	// loud-error default. Recording only ever happens on action execution, so
	// history on a room with no actions is dead config and rejected here.
	const historyCfg = config.history !== undefined ? _resolveHistoryConfig(config.history) : null;
	if (historyCfg && !actions) {
		throw new Error(
			`[svelte-realtime] live.room() history requires actions - snapshots are recorded after each action, so a room with no actions would never record.\n  See: https://svti.me/rooms`
		);
	}
	const historyStore = historyCfg ? _createHistoryStore(historyCfg) : null;
	let _captureWarned = false;

	/**
	 * The live ctx.compensate for this room's actions: clamp the
	 * client-stamped command time against the ring and hand the eval function
	 * the matching snapshot. Client-stamped time is trusted only inside the
	 * window the server itself recorded; everything else fails safe to
	 * current state. The eval function is ordinary action code - publishes
	 * inside it are immediate, exactly like publishes anywhere else in an
	 * action (interposing a queue on the shared ctx.publish slot would
	 * corrupt delivery under concurrent compensate calls on one ctx).
	 *
	 * @param {string} roomTopic
	 * @param {any} ctx
	 * @param {any[]} roomArgs
	 * @param {number | null | undefined} commandTime
	 * @param {(state: any, meta: { time: number, age: number, fallback: boolean }) => any} evalFn
	 * @param {{ tolerance?: number } | undefined} options
	 */
	async function _runCompensate(roomTopic, ctx, roomArgs, commandTime, evalFn, options) {
		if (typeof evalFn !== 'function') {
			throw new LiveError('VALIDATION', 'ctx.compensate requires an eval function: ctx.compensate(commandTime, (state, meta) => ...)');
		}
		const tolerance = options && typeof options.tolerance === 'number' && options.tolerance > 0 ? options.tolerance : 0;
		const t = wallEpoch();
		let entry = null;
		let fallback = false;
		if (ctx._compensateDepth > 0) {
			// A compensate already in flight on this ctx - nested inside an
			// eval function, or concurrent within one action: no nested
			// rewind, evaluate against current state.
			fallback = true;
		} else if (typeof commandTime === 'number' && Number.isFinite(commandTime) && t - commandTime > tolerance) {
			entry = /** @type {NonNullable<typeof historyStore>} */ (historyStore).lookup(roomTopic, commandTime, t);
			// A rewind the ring cannot serve (empty, or older than the age
			// window) evaluates against current state - never the oldest
			// marker, or stale commands would hit ancient positions.
			if (entry === null) fallback = true;
		}
		let state;
		let meta;
		if (entry !== null) {
			state = entry.state;
			meta = { time: entry.time, age: t - entry.time, fallback: false };
		} else {
			// Fresh capture: no/invalid command time, within tolerance, or a
			// rewind that fell back. A throw here propagates - the app's own
			// capture is the state source and must be loud when broken.
			state = _freezeSnapshot(/** @type {NonNullable<typeof historyCfg>} */ (historyCfg).capture(...roomArgs));
			meta = { time: t, age: 0, fallback };
		}
		// A depth counter, not a boolean: increment/decrement commutes, so
		// the guard survives any interleaving - sibling nested calls, and
		// concurrent compensates whose evals resolve out of order (a saved
		// boolean restored out of order would leak the in-flight flag).
		ctx._compensateDepth++;
		try {
			return await evalFn(state, meta);
		} finally {
			ctx._compensateDepth--;
		}
	}

	const roomExport = {};

	// Enumeration registry: which of this room's topics currently have
	// subscribers, with a subscriber count and the `meta` captured at the moment
	// the topic gained its first subscriber. Keyed by the logical data topic and
	// PARTITIONED BY TENANT, so one tenant's lobby snapshot can never enumerate
	// another tenant's rooms (the in-memory mirror of the per-tenant Redis roster
	// key). The null-tenant partition is the original single Map - byte-identical
	// behavior with no tenant resolver configured. This is the single-replica path
	// (no `platform.redis`): the snapshot is `Array.from(<partition>.values())`.
	// When `platform.redis` is wired the hooks route through the shared Redis
	// roster instead (see rooms-cluster.js) so the count and snapshot span the
	// whole cluster; these Maps are then unused.
	const roomsIndexByTenant = new Map();
	const _roomsIndexFor = (tenantId) => {
		const key = tenantId || '';
		let idx = roomsIndexByTenant.get(key);
		if (!idx) { idx = new Map(); roomsIndexByTenant.set(key, idx); }
		return idx;
	};
	// `enumId` is the stable per-export identity (the Redis roster key); `enumTopic`
	// is the pub/sub channel the deltas ride and clients subscribe to. Both default
	// to a process-local id and are re-bound by `__setEnumId` at registration so
	// every replica of one export agrees. `let`, because the publish closures and
	// the stream's topic must both follow the re-bind.
	let enumId = 'rooms:' + ++_roomsEnumSeq;
	let enumTopic = _ENUM_TOPIC_PREFIX + enumId;

	// Resolve meta once, when a room opens. A throwing meta never blocks the room
	// (the entry still appears, with empty meta); a frozen copy keeps a later
	// reader from mutating the registry through the snapshot.
	const _roomMeta = (args) => {
		if (typeof metaFn !== 'function') return undefined;
		try {
			const m = metaFn(...args);
			return m && typeof m === 'object' ? Object.freeze({ ...m }) : m;
		} catch {
			return {};
		}
	};
	// A platform whose redis client can host the shared roster: it must expose
	// every hash op the cluster helpers use. Decided uniformly so the sub/unsub
	// writes and the snapshot read never split between Redis and the in-memory Map
	// (a client with some ops but not others falls back to in-memory consistently).
	const _clusterRedis = (ctx) => {
		const r = ctx && ctx.platform && ctx.platform.redis;
		return r && typeof r.hincrby === 'function' && typeof r.hgetall === 'function'
			&& typeof r.hdel === 'function' && typeof r.hget === 'function' ? r : null;
	};
	// First subscriber opens the room (created); later subscribers bump the count
	// (updated). `args` is the room-identifying args of the topic, forwarded by
	// the stream subscribe path as the hook's 3rd argument. With `platform.redis`
	// the count and the open/close decision are cluster-wide (the shared roster);
	// without it the closure-local per-tenant registry keeps the original single-
	// replica behavior, byte-identical. `meta(args)` is resolved lazily - only by
	// the opener - so it still runs exactly once per open on either path.
	const _enumOnSub = async (ctx, topic, args) => {
		const safeArgs = Array.isArray(args) ? args.slice() : [];
		// The hook receives the WIRE data topic (the dispatch chokepoint prefixed it
		// under a tenant). The roster field, the in-memory key, and the delta payload
		// all use the LOGICAL data topic so the snapshot the app sees matches the
		// single-tenant shape; isolation comes from a tenant-scoped roster identity
		// (the Redis hash key / the in-memory partition) and a tenant-scoped delta
		// channel, so two tenants on the same export can never share a count or see
		// each other's rooms. All three reduce to the originals when there is no
		// tenant. `_publishWire` is the raw, non-prefixing publish: the channel is
		// already the wire topic here, so it must not be prefixed a second time.
		const dataTopic = _stripTenantTopic(ctx.tenantId, topic);
		const rosterId = _tenantKey(ctx.tenantId, enumId);
		const channel = _tenantTopic(ctx.tenantId, enumTopic);
		// A per-caller predicate gates the channel BEFORE this delta is
		// published, so the origin instance can never broadcast it raw - even
		// when no local lobby viewer has registered the gate via subscribe.
		if (listPredicate) _registerEnumGate(channel, listPredicate);
		if (_clusterRedis(ctx)) {
			const res = await _clusterRoomsAcquire(ctx.platform, rosterId, dataTopic, safeArgs, () => _roomMeta(safeArgs));
			if (!res) return;
			ctx._publishWire(channel, res.isFirst ? 'created' : 'updated', { topic: dataTopic, args: res.args, count: res.count, meta: res.meta });
			return;
		}
		const idx = _roomsIndexFor(ctx.tenantId);
		let entry = idx.get(dataTopic);
		if (entry === undefined) {
			entry = { topic: dataTopic, args: safeArgs, count: 1, meta: _roomMeta(safeArgs) };
			idx.set(dataTopic, entry);
			// Publish a snapshot copy, not the live entry - the registry mutates
			// `count` in place, so a delta must capture its value at this moment.
			ctx._publishWire(channel, 'created', { ...entry });
		} else {
			entry.count++;
			ctx._publishWire(channel, 'updated', { ...entry });
		}
	};
	// The last subscriber to leave closes the room (deleted); otherwise the count
	// drops. On the cluster path the count is the shared running total and isLast
	// is the cluster-wide 1->0; on the single-replica path it drops to the
	// authoritative remaining count the unsubscribe hook supplies.
	const _enumOnUnsub = async (ctx, topic, remainingSubscribers) => {
		// Same tenant scoping as the subscribe path: the disconnect/unsubscribe ctx
		// carries the connection's tenant so the release decrements the SAME roster
		// the acquire bumped and the delta rides the SAME prefixed channel the
		// lobby subscribed to. (server.js builds the unsub/close ctx with tenantId
		// and _publishWire for exactly this.)
		const dataTopic = _stripTenantTopic(ctx.tenantId, topic);
		const rosterId = _tenantKey(ctx.tenantId, enumId);
		const channel = _tenantTopic(ctx.tenantId, enumTopic);
		// Same pre-publish gating as the subscribe hook (see _enumOnSub).
		if (listPredicate) _registerEnumGate(channel, listPredicate);
		if (_clusterRedis(ctx)) {
			const res = await _clusterRoomsRelease(ctx.platform, rosterId, dataTopic);
			if (!res) return;
			if (res.isLast) ctx._publishWire(channel, 'deleted', { topic: dataTopic });
			else ctx._publishWire(channel, 'updated', { topic: dataTopic, args: res.args, count: res.count, meta: res.meta });
			return;
		}
		const idx = _roomsIndexFor(ctx.tenantId);
		const entry = idx.get(dataTopic);
		if (entry === undefined) return;
		if (remainingSubscribers <= 0) {
			idx.delete(dataTopic);
			ctx._publishWire(channel, 'deleted', { topic: dataTopic });
		} else {
			entry.count = remainingSubscribers;
			ctx._publishWire(channel, 'updated', { ...entry });
		}
	};

	// Classified guard runner shared by every room surface. Routing through
	// _runGuard gives a bare-throwing room guard the same uniform 4xx pair as
	// module guards (cause kept server-side) instead of a distinguishable
	// INTERNAL_ERROR; an app-thrown LiveError keeps its own code and message.
	const runRoomGuard = guardFn
		? (ctx, args) => _runGuard((c) => guardFn(c, ...args), ctx)
		: null;

	const dataStream = live.stream(topicFn, async function roomInit(ctx, ...args) {
		// The pre-subscribe filter below already ran the guard for a wire
		// subscribe (and stamped the ctx); this loader-stage run covers the
		// paths with no filter - `.load()` and the stale-reload re-run.
		if (runRoomGuard && !(/** @type {any} */ (ctx))._roomGuardRan) await runRoomGuard(ctx, args);
		const result = await initFn(ctx, ...args);
		// onJoin runs after successful init so a failed init doesn't leave orphaned side effects
		if (onJoin) {
			try { await onJoin(ctx, ...args); } catch {}
		}
		return result;
	}, {
		merge: mergeMode,
		key: keyField,
		alarm: alarmCfg,
		onSubscribe: (presenceFn || isEnumerable || ownerEnabled) ? async (ctx, topic, args) => {
			// Enumeration is best-effort and must never suppress the presence join
			// below - the two are independent concerns sharing one hook.
			if (isEnumerable) { try { await _enumOnSub(ctx, topic, args); } catch { /* enum is best-effort */ } }
			// Membership tracking (the ref map below) serves both presence and
			// ownership; a room with either keeps it, a room with neither skips it.
			if (!presenceFn && !ownerEnabled) return;
			const userId = _getIdentityKey(ctx);
			const refKey = topic + '\0' + userId;

			let ref = _presenceRef.get(refKey);
			if (ref) {
				// Cancel pending grace leave if reconnecting
				if (ref.timer) { clearTimer(ref.timer); ref.timer = null; }
				ref.count++;
				// Refresh LRU position so active entries survive eviction
				_presenceRef.delete(refKey);
				_presenceRef.set(refKey, ref);
				// A reconnect still resolves the self-delivery barrier so a paired
				// :presence loader in this batch never waits on the dispatch settle.
				if (presenceFn) _presenceClaimResolve(ctx.ws, topic, { key: userId, data: ref.data });
				return;
			}

			if (_presenceRef.size >= state.maxPresenceRef) {
				for (const [k, r] of _presenceRef) {
					if (r.timer) {
						clearTimer(r.timer);
						const [t, u] = k.split('\0');
						// Cluster release runs eagerly here too: an evicted entry
						// would otherwise leak a phantom counter on Redis. A null
						// payload marks an entry whose presence acquire never ran
						// (an owner-only room's membership ref) - skip the paired
						// release for those.
						if (r.data != null) {
							_clusterPresenceRelease(ctx.platform, t, u).then((res) => {
								if (res.isLast) {
									// `t` is the wire data topic (the ref-map key is wire); publish raw
									// so the `:presence` sub-topic is not prefixed a second time.
									ctx._publishWire(t + ':presence', 'leave', { key: u });
								}
							}).catch(() => {});
						}
						// The sweep spans every room's entries, so the owner release
						// runs unconditionally; a topic without owner tracking is a
						// cheap no-op inside the helper, and an owner-tracking topic
						// evicted here must run its succession or the departed owner
						// would linger until the roster TTL.
						_ownerOnLeave(ctx.platform, t, u).then((change) => {
							if (change) _ownerEmit(t, ctx.tenantId, change, ctx._publishWire);
						}).catch(() => {});
						if (onLeave) {
							Promise.resolve().then(() => onLeave(ctx, t)).catch(() => {});
						}
						_presenceRef.delete(k);
					}
				}
				if (_presenceRef.size >= state.maxPresenceRef) {
					if (!state.presenceRefWarnFired) {
						state.presenceRefWarnFired = true;
						console.warn(
							"[svelte-realtime] presence-ref map reached MAX_PRESENCE_REF=" + state.maxPresenceRef +
							"; new joiners will not appear in any subscriber's roster until existing entries clear.\n" +
							"  For multi-instance deploys, wire `platform.redis` (raw ioredis client) so the cluster-shared Redis presence is bypasses the in-memory cap.\n" +
							"  See: https://svti.me/presence"
						);
					}
					return;
				}
			}

			// Compute presence payload BEFORE storing the ref so the in-memory
			// fallback in the presence stream's init can reconstruct the roster
			// even when this user's join was published before they subscribed
			// to the :presence topic. An owner-only room stores a null payload:
			// the entry drives membership transitions but never appears in a
			// roster (the presence list skips null data).
			const presenceData = presenceFn ? presenceFn(ctx) : null;
			_presenceRef.set(refKey, { count: 1, timer: null, data: presenceData });
			// Sequence the joiner's OWN roster entry into the paired :presence
			// subscribe response (see room-owner.js): the batch runs its items in
			// parallel, so the :presence loader's shared-roster read can beat the
			// cluster acquire below (an owner room delays it further behind the
			// owner join's round-trips), and the acquire's live 'join' can hit the
			// socket before the client registers the :presence store - dropped,
			// and the joiner never sees itself. Resolved BEFORE the owner join so
			// the loader never waits on those round-trips.
			if (presenceData) _presenceClaimResolve(ctx.ws, topic, { key: userId, data: presenceData });
			// Ownership join runs at the same identity 0->1 transition presence
			// acquires on, and is independently best-effort: an owner failure
			// must never suppress the presence join below (and vice versa).
			if (ownerEnabled) {
				let ownerValue = null;
				try {
					const change = await _ownerOnJoin(ctx.platform, topic, userId, onOwnerChange);
					if (change) {
						// Seed the owner replay buffer before the emit so a racing first-joiner
						// subscribe reads the just-claimed owner from the buffer. Registering the
						// wire :owner topic here (not only at owner-stream subscribe) closes the
						// window where the emit would run before that subscribe registered it.
						// Only when the replay extension is wired; single-process needs neither.
						if (ctx.platform && ctx.platform.replay) _registerReplayTopic(topic + ':owner');
						// Fan the change out to EXISTING subscribers (and across the cluster)
						// via the :owner topic. The FIRST-JOINER's own store, however, is
						// seeded by the claim barrier below - sequenced into that socket's
						// :owner subscribe RESPONSE - so it never depends on this emit winning
						// the race against its own subscribe-ack (an earlier deferred-unicast
						// attempt did, and lost). A redundant same-value 'set' reaching the
						// first joiner later is an idempotent merge:'set' no-op.
						_ownerEmit(topic, ctx.tenantId, change, ctx._publishWire);
						if (change.owner) ownerValue = { key: change.owner, reason: change.reason };
					}
				} catch { /* owner is best-effort */ }
				// Sequence the claimed owner into the paired :owner subscribe response
				// (see room-owner.js): the loader awaits this. A null value (no claim on
				// this join, a reconnect, or a throw) makes the loader read the shared
				// store, so a non-first subscriber still sees the current owner.
				_ownerClaimResolve(ctx.ws, topic, ownerValue);
			}
			// Cluster transition: bump shared count; only the first replica to
			// reach 1 publishes 'join'. With no platform.redis the helper
			// returns isFirst=true unconditionally, matching the in-memory path.
			if (presenceData) {
				const { isFirst } = await _clusterPresenceAcquire(ctx.platform, topic, userId, presenceData);
				if (isFirst) {
					// `topic` is the wire data topic; publish raw (no second prefix).
					ctx._publishWire(topic + ':presence', 'join', { key: userId, data: presenceData });
				}
			}
		} : undefined,
		onUnsubscribe: (presenceFn || isEnumerable || ownerEnabled) ? async (ctx, topic, remainingSubscribers) => {
			if (isEnumerable) { try { await _enumOnUnsub(ctx, topic, remainingSubscribers); } catch { /* enum is best-effort */ } }
			if (!presenceFn && !ownerEnabled) return;
			// Drop this socket's claim barriers for the room the moment its
			// data-stream subscription drains: a slot from a join that never
			// paired with an :owner / :presence subscribe in its own batch must
			// not outlive the membership, or a later lone sub-stream subscribe
			// on this socket would consume the stale claim.
			_claimBarriersClear(ctx.ws, topic);
			const userId = _getIdentityKey(ctx);
			const refKey = topic + '\0' + userId;

			const ref = _presenceRef.get(refKey);
			if (!ref) return;

			ref.count--;
			if (ref.count > 0) return;

			// The final release for this identity: presence publishes 'leave'
			// when the cluster count hits 0, and ownership runs its succession
			// at the same transition. Both are independently best-effort.
			const releaseIdentity = () => {
				if (presenceFn) {
					_clusterPresenceRelease(ctx.platform, topic, userId).then((res) => {
						if (res.isLast) {
							ctx._publishWire(topic + ':presence', 'leave', { key: userId });
						}
					}).catch(() => {});
				}
				if (ownerEnabled) {
					_ownerOnLeave(ctx.platform, topic, userId).then((change) => {
						if (change) _ownerEmit(topic, ctx.tenantId, change, ctx._publishWire);
					}).catch(() => {});
				}
				if (onLeave) {
					Promise.resolve().then(() => onLeave(ctx, topic)).catch(() => {});
				}
			};

			// On rollback (failed stream init), skip grace and release
			// immediately. Cluster release decides whether this was the LAST
			// subscriber across the cluster - only then do we publish 'leave'.
			if (ctx.ws && _rollingBack.has(ctx.ws)) {
				if (ref.timer) clearTimer(ref.timer);
				_presenceRef.delete(refKey);
				releaseIdentity();
				return;
			}

			ref.timer = setTimer(() => {
				_presenceRef.delete(refKey);
				releaseIdentity();
			}, 5000);
		} : undefined
	});

	// Pre-subscribe guard: the loader-stage guard above runs AFTER
	// `platform.subscribe` and AFTER the `__onSubscribe` hook has published
	// the enumeration delta and the presence join, so a denied joiner would
	// momentarily perturb the public rooms list and roster before rollback.
	// Exposing the guard as the stream filter runs it before any of that; it
	// stamps the request ctx so the loader skips the duplicate run.
	if (runRoomGuard) {
		/** @type {any} */ (dataStream).__streamFilter = async (ctx, ...args) => {
			await runRoomGuard(ctx, args);
			/** @type {any} */ (ctx)._roomGuardRan = true;
			return true;
		};
	}

	/** @type {any} */ (roomExport).__isRoom = true;
	/** @type {any} */ (roomExport).__dataStream = dataStream;
	/** @type {any} */ (roomExport).__topicFn = topicFn;
	/** @type {any} */ (roomExport).__hasPresence = !!presenceFn;
	/** @type {any} */ (roomExport).__hasCursors = !!cursorConfig;
	/** @type {any} */ (roomExport).__cursorThrottle = typeof cursorConfig === 'object' ? cursorConfig.throttle || 50 : 50;
	/** @type {any} */ (roomExport).__hasRooms = isEnumerable;
	/** @type {any} */ (roomExport).__hasOwner = ownerEnabled;
	// The public export carries __hasOwner for codegen, but dispatch resolves a
	// room subscribe to the DATA-stream handler (registered at <room>/__data) and
	// reads __hasOwner off THAT fn to open the first-joiner owner-claim barrier.
	// It is a different object than roomExport, so the flag must live on it too or
	// the barrier never opens (and the sequenced owner snapshot silently no-ops).
	/** @type {any} */ (dataStream).__hasOwner = ownerEnabled;
	// Same object-identity lesson for the presence self-delivery barrier:
	// dispatch opens it off the DATA-stream handler's flag, not the export's.
	/** @type {any} */ (dataStream).__hasPresence = !!presenceFn;

	// Enumeration stream (opt-in): one per-export stream whose snapshot is the
	// active-rooms registry and whose live deltas (created/updated/deleted, fed by
	// the data-stream subscribe hooks above) merge into the client's lobby view,
	// keyed by topic. `__roomsSync` backs the one-shot `.list()` (snapshot, no
	// subscription). The snapshot is cluster-wide when `platform.redis` is wired
	// (the shared roster), else the local registry - the live deltas, which ride
	// the publish bus cluster-wide for free, take over from there.
	if (isEnumerable) {
		const _roomsSnapshot = async (ctx) => {
			// Read only the requesting connection's tenant partition / roster key, so
			// a lobby viewer enumerates its own tenant's rooms and never another's.
			let list = null;
			if (_clusterRedis(ctx)) {
				list = await _clusterRoomsList(ctx.platform, _tenantKey(ctx.tenantId, enumId));
			}
			if (!list) list = Array.from(_roomsIndexFor(ctx.tenantId).values(), (e) => ({ ...e }));
			if (!listPredicate) return list;
			// Per-caller visibility: the predicate runs with the REQUESTING
			// connection's ctx against each room, on the local and the cluster
			// snapshot alike, so a denied room never appears in this caller's
			// lobby - not its existence, not its count, not its meta. A throw
			// denies that one room (fail closed) without aborting the rest.
			const visible = [];
			for (const room of list) {
				let ok = false;
				try {
					const r = listPredicate(ctx, room);
					ok = (r && typeof r.then === 'function') ? !!(await r) : !!r;
				} catch {
					ok = false;
				}
				if (ok) visible.push(room);
			}
			// Seed the connection's shown set with what this snapshot revealed,
			// so the delta gate can later revoke exactly these rooms and no
			// others. `.load()` / `.list()` run with no socket and skip it.
			if (ctx.ws) _seedEnumVisibility(ctx.ws, _tenantTopic(ctx.tenantId, enumTopic), visible.map((r) => r.topic));
			return visible;
		};
		const roomsStream = live.stream(
			enumTopic,
			_roomsSnapshot,
			{ merge: 'crud', key: 'topic' }
		);
		if (listPredicate) {
			// Gate the subscriber's tenant channel BEFORE the wire subscribe
			// happens (the stream filter runs ahead of platform.subscribe in the
			// dispatch path), so a delta can never race a brand-new subscriber
			// onto a not-yet-gated channel. Always allows; it exists for the
			// registration side effect.
			/** @type {any} */ (roomsStream).__streamFilter = (ctx) => {
				_registerEnumGate(_tenantTopic(ctx.tenantId, enumTopic), listPredicate);
				return true;
			};
		}
		/** @type {any} */ (roomExport).__roomsStream = roomsStream;
		/** @type {any} */ (roomExport).__roomsSync = live(_roomsSnapshot);
		// Re-bind the enumeration identity to the export's stable module path so
		// every replica agrees on the pub/sub topic and the Redis roster key.
		// Called from the registration path (production codegen, the test harness,
		// and HMR) after this stream exists; it must follow BOTH the stream's
		// subscribe topic and the publish closures' `enumTopic`, or deltas and
		// subscribers would diverge. The registration always runs before the first
		// subscribe (dispatch resolves the lazy registry before reading the
		// stream's topic), so a subscriber never attaches to the default id.
		/** @type {any} */ (roomExport).__setEnumId = (id) => {
			if (typeof id !== 'string' || id.length === 0) return;
			// Bound the id so `enumTopic` stays under the wire/bus 256-char cap - an
			// over-long module path would otherwise make the cluster bus silently
			// drop this export's deltas. Verbatim for every realistic path.
			enumId = _stableEnumId(id);
			enumTopic = _ENUM_TOPIC_PREFIX + enumId;
			/** @type {any} */ (roomExport).__roomsStream.__streamTopic = enumTopic;
		};
	}

	// Registration-path base-module-path capture for durable alarm recovery: an
	// action-armed alarm binds to the data stream's registry key (<base>/__data)
	// so a cross-restart poll re-resolves onAlarm. Chains an enumerable room's
	// __setEnumId so both the enum re-bind and the capture run. Registration
	// (codegen / test harness / HMR) calls it once before the first subscribe.
	let roomBasePath = null;
	if (alarmCfg) {
		const _prevSetEnumId = /** @type {any} */ (roomExport).__setEnumId;
		/** @type {any} */ (roomExport).__setEnumId = (id) => {
			if (typeof id === 'string' && id.length > 0) roomBasePath = id;
			if (_prevSetEnumId) _prevSetEnumId(id);
		};
	}

	// Presence stream (if enabled)
	if (presenceFn) {
		/** @type {any} */ (roomExport).__presenceStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':presence',
			async (ctx, ...args) => {
				if (runRoomGuard) await runRoomGuard(ctx, args);
				// The roster is keyed by the WIRE data topic (the data-stream's
				// onSubscribe acquired it with the tenant-prefixed topic), so the
				// loader must prefix the same way or a tenant would read an empty /
				// wrong roster. Null tenant -> unchanged.
				const dataTopic = _tenantTopic(ctx.tenantId, topicFn(ctx, ...args));
				// Cluster-shared roster when `platform.redis` is wired; falls
				// back to the local _presenceRef iteration otherwise. The
				// loader reconstructs the roster even when this user's join
				// was published before they subscribed to :presence (the live
				// merge takes over from here).
				const roster = await _clusterPresenceList(ctx.platform, dataTopic);
				// First-joiner self delivery: if this socket's paired data-join is
				// acquiring presence in this same batch, sequence its own entry into
				// this snapshot - the shared-roster read above can run before that
				// acquire lands, and the acquire's live 'join' can reach the socket
				// before the client registers this store. A lone presence viewer
				// (no paired data-join) resolves undefined and is never injected.
				const self = await _presenceClaimAwait(ctx.ws, dataTopic);
				if (self && self.data != null && !roster.some((e) => e.key === self.key)) {
					roster.push({ key: self.key, data: self.data });
				}
				return roster;
			},
			{ merge: 'presence' }
		);
	}

	// Owner stream (if enabled): the room's current owner as a small live
	// value on the `:owner` sub-topic. The snapshot loader reads the shared
	// store (Redis when wired, the local map otherwise) so a late joiner sees
	// the current owner immediately; handoff events replace the value in
	// place (merge 'set'). `reason` describes the transition that produced
	// the value ('claimed' | 'succeeded' | 'transferred' | 'vacated'); a
	// snapshot is not a transition, so it carries null.
	if (ownerEnabled) {
		/** @type {any} */ (roomExport).__ownerStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':owner',
			async (ctx, ...args) => {
				if (runRoomGuard) await runRoomGuard(ctx, args);
				// The owner store is keyed by the WIRE data topic (the data
				// stream's onSubscribe joined with the tenant-prefixed topic),
				// so the loader must prefix the same way. Null tenant -> unchanged.
				const dataTopic = _tenantTopic(ctx.tenantId, topicFn(ctx, ...args));
				// First-joiner delivery: if this socket's paired data-join is claiming
				// ownership in this same batch, return the CLAIMED owner as the snapshot -
				// sequenced strictly after the claim, so it rides the very response the
				// client registers the :owner store from (no racing second frame). A
				// non-first / lone subscribe (no in-flight claim) reads the shared store.
				const claimed = await _ownerClaimAwait(ctx.ws, dataTopic);
				if (claimed) return { key: claimed.key, reason: claimed.reason };
				return { key: await _ownerGet(ctx.platform, dataTopic), reason: null };
			},
			// Flag-shaped delivery: one latest value, seeded to any fresh or racing
			// subscriber from the shared replay buffer, so the first joiner of an owner
			// room observes the ownership its own join just claimed even when that claim
			// (performed on the data stream) races this owner-stream subscribe. The
			// buffer engages only when the replay extension is wired; the __implicitReplay
			// gate in dispatch keeps single-process apps from registering the topic or
			// warning about a replay extension they never opted into.
			{ merge: 'set', replay: { size: 1 } }
		);
		/** @type {any} */ (roomExport).__ownerStream.__isFlag = true;
		/** @type {any} */ (roomExport).__ownerStream.__implicitReplay = true;
	}

	// Cursor stream (if enabled)
	if (cursorConfig) {
		/** @type {any} */ (roomExport).__cursorStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':cursors',
			async (ctx, ...args) => {
				if (runRoomGuard) await runRoomGuard(ctx, args);
				return [];
			},
			{ merge: 'cursor' }
		);
	}

	// Room-scoped actions
	if (actions) {
		/** @type {any} */ (roomExport).__actions = {};
		for (const [name, fn] of Object.entries(actions)) {
			if (!_validSegmentRe.test(name)) {
				if (_IS_DEV) {
					console.warn(`[svelte-realtime] Room action '${name}' contains invalid characters (only a-z, A-Z, 0-9, _ allowed) - skipped\n  See: https://svti.me/rooms`);
				}
				continue;
			}
			const wrappedAction = live(async function roomAction(ctx, ...args) {
				if (runRoomGuard) await runRoomGuard(ctx, args);
				const roomArgs = args.slice(0, _roomArgCount);
				const roomTopic = _callTopicFn(topicFn, ctx, roomArgs);
				// The publish shadow feeds the LOGICAL roomTopic to the (scoped) wrapper
				// so it is prefixed exactly once. The lag-compensation history ring is a
				// per-topic store, so its key must be the WIRE topic or two tenants on the
				// same room id would share one ring (cross-tenant state read). Null tenant
				// -> wireRoomTopic === roomTopic, byte-identical.
				const wireRoomTopic = _tenantTopic(ctx.tenantId, roomTopic);
				if (alarmCfg) {
					// ctx.setAlarm/getAlarm/deleteAlarm inside a room action arm the room's
					// single pending alarm, keyed by the wire room topic. Durable recovery
					// re-resolves onAlarm from the data stream's registry entry (<base>/__data);
					// an unregistered room stays in-memory only. Bound per call, so no restore
					// is needed (the ctx is discarded after the handler returns).
					_bindAlarmCtx(ctx, {
						wireTopic: wireRoomTopic,
						onAlarm: alarmCfg.onAlarm,
						path: roomBasePath ? roomBasePath + '/__data' : undefined,
						tenantId: ctx.tenantId,
						misfireMs: alarmCfg.misfireMs
					});
				}
				// Owner-gated actions check the CURRENT owner right before the
				// handler runs; no owner (unclaimed / vacated / store blip) denies
				// - fail closed, an owner-only action never runs ownerless.
				if (ownerGatedActions && ownerGatedActions.has(name)) {
					const currentOwner = await _ownerGet(ctx.platform, wireRoomTopic);
					if (currentOwner === null || currentOwner !== _getIdentityKey(ctx)) {
						throw new LiveError('FORBIDDEN', `Room action '${name}' is owner-only`);
					}
				}
				const originalPublish = ctx.publish;
				ctx.publish = (event, data) => originalPublish(roomTopic, event, data);
				const originalOwner = ctx.owner;
				const originalIsOwner = ctx.isOwner;
				const originalTransferOwner = ctx.transferOwner;
				if (ownerEnabled) {
					// Room-scoped ownership helpers, shadowed like ctx.publish so an
					// action reads and hands off ownership without knowing the topic.
					ctx.owner = () => _ownerGet(ctx.platform, wireRoomTopic);
					ctx.isOwner = async () => {
						const o = await _ownerGet(ctx.platform, wireRoomTopic);
						return o !== null && o === _getIdentityKey(ctx);
					};
					ctx.transferOwner = async (to) => {
						if (typeof to !== 'string' || to.length === 0) return false;
						const change = await _ownerTransfer(ctx.platform, wireRoomTopic, _getIdentityKey(ctx), to);
						if (change) _ownerEmit(wireRoomTopic, ctx.tenantId, change, ctx._publishWire);
						return change !== null;
					};
				}
				const restoreOwnerHelpers = () => {
					if (ownerEnabled) {
						ctx.owner = originalOwner;
						ctx.isOwner = originalIsOwner;
						ctx.transferOwner = originalTransferOwner;
					}
				};
				if (historyStore === null) {
					try {
						return await fn(ctx, ...args);
					} finally {
						ctx.publish = originalPublish;
						restoreOwnerHelpers();
					}
				}
				const originalCompensate = ctx.compensate;
				ctx.compensate = (commandTime, evalFn, options) =>
					_runCompensate(wireRoomTopic, ctx, roomArgs, commandTime, evalFn, options);
				try {
					const result = await fn(ctx, ...args);
					// Record AFTER the action succeeds: the post-action state is
					// what subscribers are about to see, and a failed action
					// must leave no marker. Capture failures are contained (the
					// action's own result already exists) and warn once.
					try {
						historyStore.record(
							wireRoomTopic,
							_freezeSnapshot(/** @type {NonNullable<typeof historyCfg>} */ (historyCfg).capture(...roomArgs)),
							wallEpoch()
						);
					} catch (err) {
						if (!_captureWarned) {
							_captureWarned = true;
							console.error('[svelte-realtime] history capture threw; suppressing further capture errors for this room:', err);
						}
					}
					return result;
				} finally {
					ctx.publish = originalPublish;
					ctx.compensate = originalCompensate;
					restoreOwnerHelpers();
				}
			});
			/** @type {any} */ (wrappedAction).__wrappedFn = fn;
			/** @type {any} */ (roomExport).__actions[name] = wrappedAction;
		}
	}

	// Convenience .hooks property for one-liner wiring in hooks.ws.js:
	// export const { subscribe, unsubscribe, message, close } = myRoom.hooks;
	/** @type {any} */ (roomExport).hooks = {
		message(ws, ctx) {
			handleRpc(ws, ctx.data, ctx.platform);
		},
		close(ws, ctx) {
			close(ws, ctx);
		},
		unsubscribe: unsubscribe
	};

	return roomExport;
};
