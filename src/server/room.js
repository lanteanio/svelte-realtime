// @ts-check
import { live, close, unsubscribe, handleRpc } from '../server.js';
import { wallEpoch, setTimer, clearTimer } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _validSegmentRe } from './validate.js';
import { _IS_DEV } from './env.js';
import { state, _presenceRef } from './state.js';
import { _clusterPresenceAcquire, _clusterPresenceRelease, _clusterPresenceList } from './presence.js';
import { _clusterRoomsAcquire, _clusterRoomsRelease, _clusterRoomsList, _stableEnumId, _ENUM_TOPIC_PREFIX } from './rooms-cluster.js';
import { _resolveHistoryConfig, _createHistoryStore, _freezeSnapshot } from './history-compensation.js';
import { _getIdentityKey } from './identity.js';

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
		enumerable: enumerableFlag
	} = config;

	/** @type {any} */ (topicFn).__topicUsesCtx = true;

	// Room enumeration (opt-in: a `meta` function or `enumerable: true`). When on,
	// a per-export registry tracks which of this room's topics currently have
	// subscribers (and how many), so `game.rooms()` can render a live lobby
	// browser. Off by default - a room without it installs no registry hooks and
	// no enumeration stream, so it is byte-identical to before.
	if (metaFn !== undefined && typeof metaFn !== 'function') {
		throw new Error('[svelte-realtime] live.room() meta must be a function (args) => ({ ... })\n  See: https://svti.me/rooms');
	}
	const isEnumerable = enumerableFlag === true || typeof metaFn === 'function';

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
	// the topic gained its first subscriber. Keyed by the data topic. This is the
	// single-replica path (no `platform.redis`): the snapshot is
	// `Array.from(roomsIndex.values())`. When `platform.redis` is wired the hooks
	// route through the shared Redis roster instead (see rooms-cluster.js) so the
	// count and snapshot span the whole cluster; this Map is then unused.
	const roomsIndex = new Map();
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
	// without it the closure-local `roomsIndex` keeps the original single-replica
	// behavior, byte-identical. `meta(args)` is resolved lazily - only by the
	// opener - so it still runs exactly once per open on either path.
	const _enumOnSub = async (ctx, topic, args) => {
		const safeArgs = Array.isArray(args) ? args.slice() : [];
		if (_clusterRedis(ctx)) {
			const res = await _clusterRoomsAcquire(ctx.platform, enumId, topic, safeArgs, () => _roomMeta(safeArgs));
			if (!res) return;
			ctx.publish(enumTopic, res.isFirst ? 'created' : 'updated', { topic, args: res.args, count: res.count, meta: res.meta });
			return;
		}
		let entry = roomsIndex.get(topic);
		if (entry === undefined) {
			entry = { topic, args: safeArgs, count: 1, meta: _roomMeta(safeArgs) };
			roomsIndex.set(topic, entry);
			// Publish a snapshot copy, not the live entry - the registry mutates
			// `count` in place, so a delta must capture its value at this moment.
			ctx.publish(enumTopic, 'created', { ...entry });
		} else {
			entry.count++;
			ctx.publish(enumTopic, 'updated', { ...entry });
		}
	};
	// The last subscriber to leave closes the room (deleted); otherwise the count
	// drops. On the cluster path the count is the shared running total and isLast
	// is the cluster-wide 1->0; on the single-replica path it drops to the
	// authoritative remaining count the unsubscribe hook supplies.
	const _enumOnUnsub = async (ctx, topic, remainingSubscribers) => {
		if (_clusterRedis(ctx)) {
			const res = await _clusterRoomsRelease(ctx.platform, enumId, topic);
			if (!res) return;
			if (res.isLast) ctx.publish(enumTopic, 'deleted', { topic });
			else ctx.publish(enumTopic, 'updated', { topic, args: res.args, count: res.count, meta: res.meta });
			return;
		}
		const entry = roomsIndex.get(topic);
		if (entry === undefined) return;
		if (remainingSubscribers <= 0) {
			roomsIndex.delete(topic);
			ctx.publish(enumTopic, 'deleted', { topic });
		} else {
			entry.count = remainingSubscribers;
			ctx.publish(enumTopic, 'updated', { ...entry });
		}
	};

	const dataStream = live.stream(topicFn, async function roomInit(ctx, ...args) {
		if (guardFn) await guardFn(ctx, ...args);
		const result = await initFn(ctx, ...args);
		// onJoin runs after successful init so a failed init doesn't leave orphaned side effects
		if (onJoin) {
			try { await onJoin(ctx, ...args); } catch {}
		}
		return result;
	}, {
		merge: mergeMode,
		key: keyField,
		onSubscribe: (presenceFn || isEnumerable) ? async (ctx, topic, args) => {
			// Enumeration is best-effort and must never suppress the presence join
			// below - the two are independent concerns sharing one hook.
			if (isEnumerable) { try { await _enumOnSub(ctx, topic, args); } catch { /* enum is best-effort */ } }
			if (!presenceFn) return;
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
				return;
			}

			if (_presenceRef.size >= state.maxPresenceRef) {
				for (const [k, r] of _presenceRef) {
					if (r.timer) {
						clearTimer(r.timer);
						const [t, u] = k.split('\0');
						// Cluster release runs eagerly here too: an evicted entry
						// would otherwise leak a phantom counter on Redis.
						_clusterPresenceRelease(ctx.platform, t, u).then((res) => {
							if (res.isLast) {
								ctx.publish(t + ':presence', 'leave', { key: u });
							}
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
			// to the :presence topic.
			const presenceData = presenceFn(ctx);
			_presenceRef.set(refKey, { count: 1, timer: null, data: presenceData });
			// Cluster transition: bump shared count; only the first replica to
			// reach 1 publishes 'join'. With no platform.redis the helper
			// returns isFirst=true unconditionally, matching the in-memory path.
			if (presenceData) {
				const { isFirst } = await _clusterPresenceAcquire(ctx.platform, topic, userId, presenceData);
				if (isFirst) {
					ctx.publish(topic + ':presence', 'join', { key: userId, data: presenceData });
				}
			}
		} : undefined,
		onUnsubscribe: (presenceFn || isEnumerable) ? async (ctx, topic, remainingSubscribers) => {
			if (isEnumerable) { try { await _enumOnUnsub(ctx, topic, remainingSubscribers); } catch { /* enum is best-effort */ } }
			if (!presenceFn) return;
			const userId = _getIdentityKey(ctx);
			const refKey = topic + '\0' + userId;

			const ref = _presenceRef.get(refKey);
			if (!ref) return;

			ref.count--;
			if (ref.count > 0) return;

			// On rollback (failed stream init), skip grace and release
			// immediately. Cluster release decides whether this was the LAST
			// subscriber across the cluster - only then do we publish 'leave'.
			if (ctx.ws && _rollingBack.has(ctx.ws)) {
				if (ref.timer) clearTimer(ref.timer);
				_presenceRef.delete(refKey);
				_clusterPresenceRelease(ctx.platform, topic, userId).then((res) => {
					if (res.isLast) {
						ctx.publish(topic + ':presence', 'leave', { key: userId });
					}
				}).catch(() => {});
				if (onLeave) {
					Promise.resolve().then(() => onLeave(ctx, topic)).catch(() => {});
				}
				return;
			}

			ref.timer = setTimer(() => {
				_presenceRef.delete(refKey);
				_clusterPresenceRelease(ctx.platform, topic, userId).then((res) => {
					if (res.isLast) {
						ctx.publish(topic + ':presence', 'leave', { key: userId });
					}
				}).catch(() => {});
				if (onLeave) {
					Promise.resolve().then(() => onLeave(ctx, topic)).catch(() => {});
				}
			}, 5000);
		} : undefined
	});

	/** @type {any} */ (roomExport).__isRoom = true;
	/** @type {any} */ (roomExport).__dataStream = dataStream;
	/** @type {any} */ (roomExport).__topicFn = topicFn;
	/** @type {any} */ (roomExport).__hasPresence = !!presenceFn;
	/** @type {any} */ (roomExport).__hasCursors = !!cursorConfig;
	/** @type {any} */ (roomExport).__cursorThrottle = typeof cursorConfig === 'object' ? cursorConfig.throttle || 50 : 50;
	/** @type {any} */ (roomExport).__hasRooms = isEnumerable;

	// Enumeration stream (opt-in): one per-export stream whose snapshot is the
	// active-rooms registry and whose live deltas (created/updated/deleted, fed by
	// the data-stream subscribe hooks above) merge into the client's lobby view,
	// keyed by topic. `__roomsSync` backs the one-shot `.list()` (snapshot, no
	// subscription). The snapshot is cluster-wide when `platform.redis` is wired
	// (the shared roster), else the local registry - the live deltas, which ride
	// the publish bus cluster-wide for free, take over from there.
	if (isEnumerable) {
		const _roomsSnapshot = async (ctx) => {
			if (_clusterRedis(ctx)) {
				const list = await _clusterRoomsList(ctx.platform, enumId);
				if (list) return list;
			}
			return Array.from(roomsIndex.values(), (e) => ({ ...e }));
		};
		/** @type {any} */ (roomExport).__roomsStream = live.stream(
			enumTopic,
			_roomsSnapshot,
			{ merge: 'crud', key: 'topic' }
		);
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

	// Presence stream (if enabled)
	if (presenceFn) {
		/** @type {any} */ (roomExport).__presenceStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':presence',
			async (ctx, ...args) => {
				if (guardFn) await guardFn(ctx, ...args);
				const dataTopic = topicFn(ctx, ...args);
				// Cluster-shared roster when `platform.redis` is wired; falls
				// back to the local _presenceRef iteration otherwise. The
				// loader reconstructs the roster even when this user's join
				// was published before they subscribed to :presence (the live
				// merge takes over from here).
				return _clusterPresenceList(ctx.platform, dataTopic);
			},
			{ merge: 'presence' }
		);
	}

	// Cursor stream (if enabled)
	if (cursorConfig) {
		/** @type {any} */ (roomExport).__cursorStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':cursors',
			async (ctx, ...args) => {
				if (guardFn) await guardFn(ctx, ...args);
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
				if (guardFn) await guardFn(ctx, ...args);
				const roomArgs = args.slice(0, _roomArgCount);
				const roomTopic = _callTopicFn(topicFn, ctx, roomArgs);
				const originalPublish = ctx.publish;
				ctx.publish = (event, data) => originalPublish(roomTopic, event, data);
				if (historyStore === null) {
					try {
						return await fn(ctx, ...args);
					} finally {
						ctx.publish = originalPublish;
					}
				}
				const originalCompensate = ctx.compensate;
				ctx.compensate = (commandTime, evalFn, options) =>
					_runCompensate(roomTopic, ctx, roomArgs, commandTime, evalFn, options);
				try {
					const result = await fn(ctx, ...args);
					// Record AFTER the action succeeds: the post-action state is
					// what subscribers are about to see, and a failed action
					// must leave no marker. Capture failures are contained (the
					// action's own result already exists) and warn once.
					try {
						historyStore.record(
							roomTopic,
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
