// @ts-check
import { live, close, unsubscribe, handleRpc } from '../server.js';
import { wallEpoch, setTimer, clearTimer } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _validSegmentRe } from './validate.js';
import { _IS_DEV } from './env.js';
import { state, _presenceRef } from './state.js';
import { _clusterPresenceAcquire, _clusterPresenceRelease, _clusterPresenceList } from './presence.js';
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
		key: keyField = 'id'
	} = config;

	/** @type {any} */ (topicFn).__topicUsesCtx = true;

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
		onSubscribe: presenceFn ? async (ctx, topic) => {
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
		onUnsubscribe: presenceFn ? (ctx, topic) => {
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
