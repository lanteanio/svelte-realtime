// @ts-check
import { assert, wireAssertionMetrics } from './shared/assert.js';
import { safeAssign as _safeAssignSnapshot } from './shared/safe-assign.js';
import {
	now as runtimeNow,
	monotonicNow,
	wallEpoch,
	randomFloat,
	randomU32,
	randomUuid,
	randomBytes,
	setTimer,
	setIntervalTimer,
	clearTimer,
	clearIntervalTimer,
	microtask,
	effectiveTimeZone
} from './shared/runtime.js';
import { createHmac, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as nodeDnsLookup } from 'node:dns';
import { checkUrl } from 'svelte-adapter-uws/safe-url';
import { LiveError } from './server/live-error.js';
import { _runtimeRandom, _localHlc } from './server/runtime-fallbacks.js';
import { _validPathRe, _validSegmentRe, _validUserIdReason, _MAX_USER_ID_LENGTH, _DEFAULT_MAX_ENVELOPE_DEPTH, exceedsEnvelopeDepth } from './server/validate.js';
import {
	state,
	registry,
	guards,
	_topicWsCounts,
	_topicStaleWatch,
	_silentTopicWatch,
	_topicCoalesce,
	_topicTransform,
	_topicVolatile,
	_topicInvalidationWatch,
	_ctxHelpersCache,
	_rateLimits,
	cronRegistry,
	derivedRegistry,
	effectRegistry,
	aggregateRegistry,
	_lazyQueue,
	_presenceRef,
	_derivedBySource,
	_effectBySource,
	_webhookOutBySource,
	_aggregateBySource,
	_watchedTopics,
	_dynamicDerivedByFn
} from './server/state.js';
import { _IS_DEV } from './server/env.js';
import { _fireWebhookOut, _redactUrl } from './server/webhook-out.js';
import { _presenceRefForTest, _clusterPresenceAcquire, _clusterPresenceRelease, _clusterPresenceList, _clusterPresenceMerge } from './server/presence.js';
import { _parseCron, _cronDateParts, _cronFieldMatch } from './server/cron.js';
import { _throttles, _debounces, _throttlePublish, _debouncePublish, _skipGate, _checkPublishHelperArgs } from './server/publish-helpers.js';
import { _resolveHistoryConfig, _createHistoryStore, _freezeSnapshot, _compensateUnavailable } from './server/history-compensation.js';
import { WRAPPED_FOR_REPLAY, _resetReplayRouting, _registerReplayTopic, _maybeReplayPublish } from './server/replay-routing.js';
import { _recordRpcMetrics, installMetrics } from './server/metrics.js';
import { _shouldShed, _resetAdmission, installAdmission } from './server/admission.js';
import { _getIdentityKey } from './server/identity.js';
import { _resetIdempotencyStore, _resetLock, installIdempotency } from './server/idempotency.js';
import { installPush, pushHooks, _resetPushRegistry, _pushRegistry, _wsToPushUserId } from './server/push.js';
import { installRateLimit, _consumeRateLimitBucket, _resolveRegistryRateLimit, _rateLimitConfig } from './server/rate-limit.js';
export { _resetRateLimits } from './server/rate-limit.js';
import { _setBus, _getBus } from './server/bus.js';
import { _getCtxHelpers, _buildCtx, installCtx } from './server/ctx.js';
import { _ensureWrap, _maybeLateActivate, _activateDynamicDerived, _deactivateDynamicDerived, _computeAggregateState, _computeWindowState, installReactive } from './server/reactive.js';
import { _crdtLoadError, _setCrdtRuntime, _resetCrdt, _crdtRegister, _drainCrdtOnClose, _crdtClosedWs, _crdtDeclRegistrations, installCrdt } from './server/crdt.js';
import { _smoothLoadError, _setSmoothRuntime, _resetSmooth, _smoothRegister, _drainSmoothOnClose, _smoothTopics, _smoothClosedWs, installSmooth } from './server/smooth.js';
import { _resolveAllLazy, _isLazyResolved, _resetLazy, installLazy } from './server/lazy.js';
import { __registerCron, setCronPlatform, configureCron, _clearCron, _tickCron, onCronError, _ensureCronInterval, _getCronLeader, _cronTimerActive } from './server/cron-engine.js';
export { __registerCron, setCronPlatform, configureCron, _clearCron, _tickCron, onCronError };
export { _smoothLoadError, _setSmoothRuntime, _resetSmooth };
import { _armSilentTopicWatch, _disarmSilentTopicWatch, _resetSilentTopicWarning, _activatePublishRateWarning, _resetPublishRateWarning, installDevWarnings } from './server/dev-warnings.js';
import { _drainUploadsOnClose, _resetUploadAutoDiscovery, installUpload } from './server/upload.js';
import { handleRpc, _runGuard, guard, __directCall, message, createMessage, installDispatch } from './server/dispatch.js';
export { handleRpc, guard, __directCall, message, createMessage };
installDispatch({ isLazyResolved: _isLazyResolved, trackStreamSub: _trackStreamSub, rollbackStreamSubscribe: _rollbackStreamSubscribe, registerStaleWatch: _registerStaleWatch, registerInvalidationWatch: _registerInvalidationWatch, resolveRegistryEntry: _resolveRegistryEntry, resolveGuard: _resolveGuard, resolveAllLazy: _resolveAllLazy, runWithMiddleware: _runWithMiddleware, validate: _validate, callTopicFn: _callTopicFn, applyInitTransform: _applyInitTransform });
export { _resetUploadAutoDiscovery };
export { _armSilentTopicWatch, _resetSilentTopicWarning, _activatePublishRateWarning, _resetPublishRateWarning };
export { _crdtLoadError, _setCrdtRuntime, _resetCrdt };
export { pushHooks, _resetPushRegistry };
export { _resetIdempotencyStore, _resetLock };
export { _getIdentityKey };
export { _resetAdmission };
export { WRAPPED_FOR_REPLAY, _resetReplayRouting };
export { assert, getAssertionCounters, _resetAssertCounters } from './shared/assert.js';
export { colorForKey, hueForKey } from './shared/color.js';
export { LiveError };
export { _presenceRefForTest, _clusterPresenceAcquire, _clusterPresenceList, _clusterPresenceMerge };

const textDecoder = new TextDecoder();

// - Bounded-by-default capacity caps (server side) -------------------------
// Every per-process Map / Set with caller-driven growth is bounded. Numbers
// are deliberately generous - far above any healthy single-instance workload
// - so they catch obvious bugs (subscribe-leak, register-without-deregister)
// without biting real apps. Saturation behavior is one of:
//
//   REJECT      caller gets an explicit error or a silent skip
//   WARN-ONLY   logs once per category; map keeps growing because eviction
//               would corrupt routing
//   FIFO-EVICT  drops oldest insertion-order entries; safe for dedup state
//               where re-warn or duplicate is acceptable
//
// Existing caps not re-declared here (already enforced at their sites):
//   _RATE_LIMIT_MAX        5000    REJECT after stale-sweep (per-identity)
//   _THROTTLE_DEBOUNCE_MAX 5000    fall-back to direct publish (per-key)
//   idempotency maxEntries 10000   FIFO 10% (in-process result store)
//
// See README "Capacity model" for the full taxonomy.

/** Max distinct userIds tracked in the per-process push registry. WARN-then-skip on cap: new registrations are dropped (the connection still works, it just can't be the target of `live.push({ userId })` until existing entries clear). Matches the cluster-scale convention from svelte-adapter-uws-extensions (`MAX_REGISTRY_SESSIONS_PER_INSTANCE`). */
export const MAX_PUSH_REGISTRY = 10_000_000;

/** Threshold for the per-process topic-subscribers index. WARN-ONLY: the map keeps growing because eviction would corrupt subscribe / unsubscribe routing. Surfaces a structured warning the first time the threshold is crossed. Matches svelte-adapter-uws `TOPIC_SEQS_WARN_THRESHOLD`. */
export const TOPIC_WS_COUNTS_WARN_THRESHOLD = 1_000_000;

/** Max distinct topics in the dev-mode silent-topic warning dedup. FIFO-evict on cap: dropping the oldest entry just lets that topic re-warn on its next over-threshold subscribe. Matches svelte-adapter-uws `PUBLISH_WARN_DEDUP_MAX`. */
export const SILENT_TOPIC_WARN_DEDUP_MAX = 1_000_000;

/** Max distinct topics in the dev-mode publish-rate warning dedup. FIFO-evict on cap: dropping the oldest entry just lets that topic re-warn on its next sample tick. Matches svelte-adapter-uws `PUBLISH_WARN_DEDUP_MAX`. */
export const PUBLISH_RATE_WARN_DEDUP_MAX = 1_000_000;

/** Max distinct (user, room) pairs the in-memory presence-ref map holds. FIFO-evict graces first, then WARN-then-skip on cap: new joiners don't get registered, so they're invisible in any subscriber's roster until existing entries clear. Matches the per-process safety-net convention used by the other caps in this section. For multi-instance deploys, wire `platform.presence` (e.g. `svelte-adapter-uws-extensions/presence`) to bypass this map entirely. */
export const MAX_PRESENCE_REF = 1_000_000;

// Seed the mutable cap shadows on the shared state holder from the public
// `export const` caps above (the canonical defaults). Tests lower them via
// `_setCapsForTest` for fast saturation; production never touches them.
state.maxPushRegistry = MAX_PUSH_REGISTRY;
state.topicWsCountsWarnThreshold = TOPIC_WS_COUNTS_WARN_THRESHOLD;
state.silentTopicWarnDedupMax = SILENT_TOPIC_WARN_DEDUP_MAX;
state.publishRateWarnDedupMax = PUBLISH_RATE_WARN_DEDUP_MAX;
state.maxPresenceRef = MAX_PRESENCE_REF;

/**
 * Override capacity caps for testing. Pass any subset of the cap names
 * (omit `MAX_` / `_THRESHOLD` / `_MAX` suffix; use `pushRegistry`,
 * `topicWsCountsWarn`, `silentTopicWarnDedup`, `publishRateWarnDedup`,
 * `presenceRef`). Pair with `_resetCapsForTest()` in afterEach.
 * @internal
 * @param {{ pushRegistry?: number, topicWsCountsWarn?: number, silentTopicWarnDedup?: number, publishRateWarnDedup?: number, presenceRef?: number }} overrides
 */
export function _setCapsForTest(overrides) {
	if (overrides.pushRegistry !== undefined) state.maxPushRegistry = overrides.pushRegistry;
	if (overrides.topicWsCountsWarn !== undefined) state.topicWsCountsWarnThreshold = overrides.topicWsCountsWarn;
	if (overrides.silentTopicWarnDedup !== undefined) state.silentTopicWarnDedupMax = overrides.silentTopicWarnDedup;
	if (overrides.publishRateWarnDedup !== undefined) state.publishRateWarnDedupMax = overrides.publishRateWarnDedup;
	if (overrides.presenceRef !== undefined) state.maxPresenceRef = overrides.presenceRef;
	if (overrides.uploadPendingMaxAggregate !== undefined) state.UPLOAD_PENDING_MAX_AGGREGATE = overrides.uploadPendingMaxAggregate;
}

/**
 * Restore capacity caps to their default values.
 * @internal
 */
export function _resetCapsForTest() {
	state.maxPushRegistry = MAX_PUSH_REGISTRY;
	state.topicWsCountsWarnThreshold = TOPIC_WS_COUNTS_WARN_THRESHOLD;
	state.silentTopicWarnDedupMax = SILENT_TOPIC_WARN_DEDUP_MAX;
	state.publishRateWarnDedupMax = PUBLISH_RATE_WARN_DEDUP_MAX;
	state.maxPresenceRef = MAX_PRESENCE_REF;
	state.presenceRefWarnFired = false;
	state.UPLOAD_PENDING_MAX_AGGREGATE = 64 * 1024 * 1024;
	state.pendingUploadBytes = 0;
}

/** @type {Set<Function>} Streams with onUnsubscribe hooks (for iterating static matches in close) */
const _streamsWithUnsubscribe = new Set();

/**
 * Tag a topic function with __topicUsesCtx by inspecting its first parameter name.
 *
 * Auto-detects only named ctx params: ctx, context, _ctx -> __topicUsesCtx = true.
 * Everything else is left unset, falling back to fn.length in _callTopicFn.
 *
 * If fn.length is wrong (defaults, destructuring with defaults), the user must
 * opt in explicitly by setting fn.__topicUsesCtx = true before registering.
 * live.room already does this for its topic function.
 *
 * @param {Function} fn
 */
function _tagTopicFn(fn) {
	try {
		const src = fn.toString();
		// Bare arrow: ctx => ... or context => ...
		const arrow = src.match(/^\s*([\w$]+)\s*=>/);
		if (arrow) {
			const name = arrow[1];
			if (name === 'ctx' || name === 'context' || name === '_ctx') {
				/** @type {any} */ (fn).__topicUsesCtx = true;
			}
			return;
		}
		// Parenthesized: extract first token inside (...)
		const paren = src.match(/\(\s*([\w$]+)/);
		if (paren) {
			const name = paren[1];
			if (name === 'ctx' || name === 'context' || name === '_ctx') {
				/** @type {any} */ (fn).__topicUsesCtx = true;
			}
		}
		// Destructured, rest, empty, or unrecognized -> leave unset
	} catch {}
}

/**
 * Call a topic factory function, deciding whether to inject ctx.
 *
 * If __topicUsesCtx was set by _tagTopicFn or explicitly, honor it.
 * Otherwise fall back to fn.length vs args.length heuristic.
 *
 * @param {Function} fn
 * @param {any} ctx
 * @param {any[]} args
 * @returns {any}
 */
function _callTopicFn(fn, ctx, args) {
	let result;
	if (fn.__topicUsesCtx === true) result = fn(ctx, ...args);
	else if (fn.__topicUsesCtx === false) result = fn(...args);
	else {
		result = fn.length <= args.length ? fn(...args) : fn(ctx, ...args);
	}
	if (typeof result !== 'string') {
		throw new LiveError('INVALID_REQUEST',
			'Topic function must return a string, got ' + (result && typeof result === 'object' && typeof result.then === 'function' ? 'Promise (topic functions must not be async)' : typeof result)
		);
	}
	return result;
}

/**
 * Per-socket stream ownership. Maps ws -> topic -> [{fn, count}].
 * Each entry tracks a logical stream subscription with its hook function and refcount.
 * Used for gauge tracking, onUnsubscribe dispatch, and rollback.
 * @type {WeakMap<object, Map<string, Array<{fn: Function, count: number}>>>}
 */
const _wsStreamOwners = new WeakMap();

/** One-shot flag for the TOPIC_WS_COUNTS_WARN_THRESHOLD warning. Reset by `_resetTopicWsCounts`. */
let _topicWsCountsWarnFired = false;

/** @type {Array<(ctx: any, next: () => Promise<any>) => Promise<any>>} */
const _globalMiddleware = [];

/**
 * Copy stream metadata from a source function to a wrapper.
 * Single source of truth for all metadata properties - add new fields here.
 * @param {any} target
 * @param {any} source
 */
function _copyStreamMeta(target, source) {
	target.__isStream = source.__isStream;
	target.__isLive = source.__isLive;
	target.__streamTopic = source.__streamTopic;
	target.__streamOptions = source.__streamOptions;
	if (source.__replay) target.__replay = source.__replay;
	if (source.__delta) target.__delta = source.__delta;
	if (source.__onSubscribe) target.__onSubscribe = source.__onSubscribe;
	if (source.__onUnsubscribe) target.__onUnsubscribe = source.__onUnsubscribe;
	if (source.__streamFilter) target.__streamFilter = source.__streamFilter;
	if (source.__streamArgs) target.__streamArgs = source.__streamArgs;
	if (source.__streamTransform) target.__streamTransform = source.__streamTransform;
	if (source.__streamVolatile) target.__streamVolatile = source.__streamVolatile;
	if (source.__streamVersion !== undefined) target.__streamVersion = source.__streamVersion;
	if (source.__streamMigrate) target.__streamMigrate = source.__streamMigrate;
	if (source.__streamStaleAfterMs !== undefined) target.__streamStaleAfterMs = source.__streamStaleAfterMs;
	if (source.__streamOnError) target.__streamOnError = source.__streamOnError;
	if (source.__isChannel) target.__isChannel = source.__isChannel;
	if (source.__isDerived) target.__isDerived = source.__isDerived;
	if (source.__derivedDynamic) {
		target.__derivedDynamic = source.__derivedDynamic;
		target.__derivedSourceFactory = source.__derivedSourceFactory;
		target.__derivedTopicArgs = source.__derivedTopicArgs;
		target.__derivedDebounce = source.__derivedDebounce;
	}
	if (source.__derivedSources) target.__derivedSources = source.__derivedSources;
	if (source.__isGated) {
		target.__isGated = true;
		target.__gatePredicate = source.__gatePredicate;
	}
}

/** @internal Exported only so tests can drive the coalesce registry without a full subscribe round-trip. */
export function _registerCoalesce(ws, topic, coalesceBy, onError) {
	let entry = _topicCoalesce.get(topic);
	if (!entry) {
		entry = { coalesceBy, onError: onError || null, ws: new Set() };
		_topicCoalesce.set(topic, entry);
	}
	entry.ws.add(ws);
}

function _unregisterCoalesce(ws, topic) {
	const entry = _topicCoalesce.get(topic);
	if (!entry) return;
	entry.ws.delete(ws);
	if (entry.ws.size === 0) _topicCoalesce.delete(topic);
}

/** Per-ws set of topics where this ws has contributed a transform refcount.
 *  Lets the unregister side be idempotent and ws-aware. */
const _wsTransformContrib = new WeakMap();

function _registerTransform(ws, topic, transform, onError) {
	let entry = _topicTransform.get(topic);
	if (!entry) {
		entry = { transform, onError: onError || null, refcount: 0 };
		_topicTransform.set(topic, entry);
	}
	entry.refcount++;
	let contrib = _wsTransformContrib.get(ws);
	if (!contrib) { contrib = new Set(); _wsTransformContrib.set(ws, contrib); }
	contrib.add(topic);
}

function _unregisterTransform(ws, topic) {
	const contrib = _wsTransformContrib.get(ws);
	if (!contrib || !contrib.has(topic)) return;
	contrib.delete(topic);
	const entry = _topicTransform.get(topic);
	if (!entry) return;
	entry.refcount--;
	if (entry.refcount <= 0) _topicTransform.delete(topic);
}

/**
 * Reset the per-topic transform registry. Tests only.
 * @internal
 */
export function _resetTransformRegistry() {
	_topicTransform.clear();
}

/** Per-ws set of topics where this ws has contributed a volatile refcount. */
const _wsVolatileContrib = new WeakMap();

/** @internal Exported only so tests can drive the volatile registry without a full subscribe round-trip. */
export function _registerVolatile(ws, topic) {
	let entry = _topicVolatile.get(topic);
	if (!entry) {
		entry = { refcount: 0 };
		_topicVolatile.set(topic, entry);
	}
	entry.refcount++;
	let contrib = _wsVolatileContrib.get(ws);
	if (!contrib) { contrib = new Set(); _wsVolatileContrib.set(ws, contrib); }
	contrib.add(topic);
}

function _unregisterVolatile(ws, topic) {
	const contrib = _wsVolatileContrib.get(ws);
	if (!contrib || !contrib.has(topic)) return;
	contrib.delete(topic);
	const entry = _topicVolatile.get(topic);
	if (!entry) return;
	entry.refcount--;
	if (entry.refcount <= 0) _topicVolatile.delete(topic);
}

/** Reset the per-topic volatile registry. Tests only. @internal */
export function _resetVolatileRegistry() {
	_topicVolatile.clear();
}

/**
 * Convert an `invalidateOn` pattern into a fast matcher. `*` matches any
 * sequence of one or more characters (greedy, including colons); other
 * regex specials are escaped. Patterns must be non-empty strings.
 *
 * Returns the compiled regex along with the literal-prefix and `prefixOnly`
 * flag so the publish hot path can short-circuit without entering the regex
 * engine for the common `prefix*` shape.
 *
 * @param {string} pattern
 * @returns {{ regex: RegExp, prefix: string, prefixOnly: boolean }}
 */
function _compileInvalidatePattern(pattern) {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.+');
	const regex = new RegExp('^' + escaped + '$');
	const firstStar = pattern.indexOf('*');
	const prefix = firstStar === -1 ? pattern : pattern.slice(0, firstStar);
	const lastStar = pattern.lastIndexOf('*');
	const prefixOnly = firstStar !== -1 && lastStar === pattern.length - 1 && firstStar === lastStar;
	return { regex, prefix, prefixOnly };
}

/**
 * Register the invalidation watchers for a stream's first subscriber.
 * No-op when `fn.__streamInvalidateOn` is unset. Idempotent per
 * (pattern, topic) pair: re-subscribing the same stream won't
 * accumulate duplicate watchers.
 *
 * @param {string} topic
 * @param {any} fn
 * @param {any} ctx
 * @param {any[]} args
 * @param {any} platform
 */
function _registerInvalidationWatch(topic, fn, ctx, args, platform) {
	const patterns = fn.__streamInvalidateOn;
	if (!patterns) return;
	const onError = fn.__streamOnError || null;
	for (const p of patterns) {
		let entry = _topicInvalidationWatch.get(p);
		if (!entry) {
			const { regex, prefix, prefixOnly } = _compileInvalidatePattern(p);
			entry = { regex, prefix, prefixOnly, watchers: [] };
			_topicInvalidationWatch.set(p, entry);
		}
		if (entry.watchers.some(w => w.topic === topic && w.fn === fn)) continue;
		entry.watchers.push({ topic, fn, ctx, args, platform, onError, reloading: false });
	}
}

/**
 * Drop a stream's invalidation watchers when its last subscriber
 * leaves. Removes empty pattern entries so the size-zero fast path in
 * the publish helper short-circuits cleanly.
 *
 * @param {string} topic
 * @param {any} fn
 */
function _unregisterInvalidationWatch(topic, fn) {
	const patterns = fn.__streamInvalidateOn;
	if (!patterns) return;
	for (const p of patterns) {
		const entry = _topicInvalidationWatch.get(p);
		if (!entry) continue;
		const idx = entry.watchers.findIndex(w => w.topic === topic && w.fn === fn);
		if (idx >= 0) entry.watchers.splice(idx, 1);
		if (entry.watchers.length === 0) _topicInvalidationWatch.delete(p);
	}
}

/** Reset the per-topic invalidation registry. Tests only. @internal */
export function _resetInvalidationWatch() {
	_topicInvalidationWatch.clear();
}

/**
 * Re-run a stream's loader because an invalidation pattern matched.
 * Mirrors `_staleReload` - captures the same ctx+args, applies the
 * init transform, and broadcasts the result as a `refreshed` event on
 * the stream's own topic. Concurrent triggers are deduped via the
 * `reloading` flag (we never queue or merge them; the next match after
 * the in-flight reload completes will re-run regardless).
 *
 * @param {{ topic: string, fn: any, ctx: any, args: any[], platform: any, onError: Function | null, reloading: boolean }} watcher
 */
async function _invalidationReload(watcher) {
	if (watcher.reloading) return;
	watcher.reloading = true;
	try {
		const result = await watcher.fn(watcher.ctx, ...watcher.args);
		const initTransform = /** @type {any} */ (watcher.fn).__streamTransform;
		const finalData = (initTransform && result != null) ? _applyInitTransform(initTransform, result) : result;
		try { watcher.platform.publish(watcher.topic, 'refreshed', finalData); } catch {}
	} catch (err) {
		if (watcher.onError) {
			try { await watcher.onError(err, watcher.ctx, watcher.topic); } catch {}
		}
	} finally {
		watcher.reloading = false;
	}
}

/**
 * Arm the per-topic stale watchdog if `fn` declares `__streamStaleAfterMs`.
 * Idempotent per topic: if a watchdog already exists (from an earlier
 * subscriber), this is a no-op so we don't replace the captured ctx.
 *
 * @param {string} topic
 * @param {any} fn The stream's init function (with __streamStaleAfterMs / __streamOnError stashed)
 * @param {any} ctx
 * @param {any[]} args
 * @param {any} platform
 */
function _registerStaleWatch(topic, fn, ctx, args, platform) {
	const staleMs = fn.__streamStaleAfterMs;
	if (!staleMs) return;
	if (_topicStaleWatch.has(topic)) return;
	const entry = {
		staleAfterMs: staleMs,
		fn,
		ctx,
		args,
		platform,
		onError: fn.__streamOnError || null,
		reloading: false,
		timerId: setTimer(() => _staleReload(topic), staleMs)
	};
	_topicStaleWatch.set(topic, entry);
}

/**
 * Clear the per-topic stale watchdog. Called when the last subscriber for
 * the topic leaves. No-op when no watchdog exists.
 * @param {string} topic
 */
function _unregisterStaleWatch(topic) {
	const entry = _topicStaleWatch.get(topic);
	if (!entry) return;
	clearTimer(entry.timerId);
	_topicStaleWatch.delete(topic);
}

/**
 * Reset the watchdog timer for a topic. Called from the publish helper on
 * every publish to that topic - a publish proves the topic is live, so
 * the staleness clock restarts.
 * @param {string} topic
 */
function _resetStaleTimer(topic) {
	const entry = _topicStaleWatch.get(topic);
	if (!entry) return;
	clearTimer(entry.timerId);
	entry.timerId = setTimer(() => _staleReload(topic), entry.staleAfterMs);
}

/**
 * Run the stale-reload for a topic: re-invoke the stream's loader with the
 * captured ctx + args, broadcast the new data as a `refreshed` event, and
 * re-arm the timer. Loader throws are routed to the stream's onError if
 * configured; the timer always re-arms so transient failures do not leave
 * the topic in a permanently-stale state.
 *
 * @param {string} topic
 */
async function _staleReload(topic) {
	const entry = _topicStaleWatch.get(topic);
	if (!entry) return;
	if (entry.reloading) return;
	entry.reloading = true;
	try {
		const result = await entry.fn(entry.ctx, ...entry.args);
		const initTransform = /** @type {any} */ (entry.fn).__streamTransform;
		const finalData = (initTransform && result != null) ? _applyInitTransform(initTransform, result) : result;
		try { entry.platform.publish(topic, 'refreshed', finalData); } catch {}
	} catch (err) {
		if (entry.onError) {
			try { await entry.onError(err, entry.ctx, topic); } catch {}
		}
	} finally {
		entry.reloading = false;
		// Re-arm only if this entry is still registered. The last
		// subscriber may have left during the async loader call, in
		// which case _unregisterStaleWatch has already cleared the
		// timer slot.
		const stillThere = _topicStaleWatch.get(topic);
		if (stillThere === entry) {
			stillThere.timerId = setTimer(() => _staleReload(topic), entry.staleAfterMs);
		}
	}
}

/** Reset the per-topic stale-watch registry. Tests only. @internal */
export function _resetStaleWatch() {
	for (const entry of _topicStaleWatch.values()) clearTimer(entry.timerId);
	_topicStaleWatch.clear();
}

/**
 * Apply a transform function to initial-load data. Per-item for arrays
 * (covers crud/latest/presence/cursor merge), whole-value for
 * non-arrays (covers set merge).
 * @param {Function} transform
 * @param {any} data
 * @returns {any}
 */
function _applyInitTransform(transform, data) {
	if (Array.isArray(data)) {
		const out = new Array(data.length);
		for (let i = 0; i < data.length; i++) out[i] = transform(data[i]);
		return out;
	}
	return transform(data);
}

installCtx({
	resetStaleTimer: _resetStaleTimer,
	invalidationReload: _invalidationReload
});

/**
 * Register a stream subscription in the per-socket ownership map.
 * @param {any} ws
 * @param {string} topic
 * @param {Function} fn
 */
function _trackStreamSub(ws, topic, fn) {
	let topicMap = _wsStreamOwners.get(ws);
	if (!topicMap) { topicMap = new Map(); _wsStreamOwners.set(ws, topicMap); }
	let owners = topicMap.get(topic);
	const isFirstSubForTopic = !owners;
	if (!owners) { owners = []; topicMap.set(topic, owners); }
	const existing = owners.find(o => o.fn === fn);
	if (existing) { existing.count++; } else { owners.push({ fn, count: 1 }); }
	if (isFirstSubForTopic) {
		let wsSet = _topicWsCounts.get(topic);
		if (!wsSet) {
			if (_topicWsCounts.size >= state.topicWsCountsWarnThreshold && !_topicWsCountsWarnFired) {
				_topicWsCountsWarnFired = true;
				console.warn(
					"[svelte-realtime] topic-subscribers index reached TOPIC_WS_COUNTS_WARN_THRESHOLD=" + state.topicWsCountsWarnThreshold + " distinct topics.\n" +
					"  Eviction would corrupt subscribe/unsubscribe routing, so the index keeps growing.\n" +
					"  Check for runaway dynamic-topic generation (e.g. per-request topic strings) and prefer aggregating into stable topics.\n" +
					"  See: https://svti.me/topic-cardinality"
				);
			}
			wsSet = new Set();
			_topicWsCounts.set(topic, wsSet);
		}
		wsSet.add(ws);
	}
	if (isFirstSubForTopic && /** @type {any} */ (fn).__coalesceBy) {
		_registerCoalesce(
			ws,
			topic,
			/** @type {any} */ (fn).__coalesceBy,
			/** @type {any} */ (fn).__streamOnError || null
		);
	}
	if (isFirstSubForTopic && /** @type {any} */ (fn).__streamTransform) {
		_registerTransform(
			ws,
			topic,
			/** @type {any} */ (fn).__streamTransform,
			/** @type {any} */ (fn).__streamOnError || null
		);
	}
	if (isFirstSubForTopic && /** @type {any} */ (fn).__streamVolatile) {
		_registerVolatile(ws, topic);
	}
	if (isFirstSubForTopic) _armSilentTopicWatch(topic);
	if (state.metricsInstruments) state.metricsInstruments.streamGauge.inc();
}

/** @type {WeakSet<object>} Sockets currently in rollback (skips grace period in presence) */
const _rollingBack = new WeakSet();

function _rollbackStreamSubscribe(ws, topic, fn, ctx) {
	try { ws.unsubscribe(topic); } catch {}
	if (state.metricsInstruments) state.metricsInstruments.streamGauge.dec();
	const topicMap = _wsStreamOwners.get(ws);
	let removedFromTopic = false;
	if (topicMap) {
		const owners = topicMap.get(topic);
		if (owners) {
			const idx = owners.findIndex(o => o.fn === fn);
			if (idx >= 0) {
				owners[idx].count--;
				if (owners[idx].count <= 0) owners.splice(idx, 1);
				if (owners.length === 0) {
					topicMap.delete(topic);
					_unregisterCoalesce(ws, topic);
					_unregisterTransform(ws, topic);
					_unregisterVolatile(ws, topic);
					removedFromTopic = true;
				}
			}
		}
	}
	let remainingSubscribers = 0;
	if (removedFromTopic) {
		const wsSet = _topicWsCounts.get(topic);
		if (wsSet) {
			// subscription.bookkeeping invariant: if owners.length hit 0 for
			// this ws+topic, the wsSet must have tracked this ws. Mismatch
			// means a stale tracking entry or a double-remove.
			assert(wsSet.has(ws), 'realtime/subscription.bookkeeping.ws-was-tracked', { topic, wsSetSize: wsSet.size });
			wsSet.delete(ws);
			remainingSubscribers = wsSet.size;
			if (wsSet.size === 0) {
				_topicWsCounts.delete(topic);
				_unregisterStaleWatch(topic);
				_unregisterInvalidationWatch(topic, fn);
				_disarmSilentTopicWatch(topic);
			}
		}
	} else {
		const wsSet = _topicWsCounts.get(topic);
		// This ws still owns other subs to this topic; count OTHER ws.
		remainingSubscribers = wsSet ? wsSet.size - (wsSet.has(ws) ? 1 : 0) : 0;
	}
	if (/** @type {any} */ (fn).__onUnsubscribe && ctx) {
		_rollingBack.add(ws);
		Promise.resolve()
			.then(() => /** @type {any} */ (fn).__onUnsubscribe(ctx, topic, remainingSubscribers))
			.catch(() => {})
			.finally(() => _rollingBack.delete(ws));
	}
}

/**
 * Walk a wrapper chain (max depth 10) and stamp the registered RPC path
 * on every rate-limit or idempotency frame. The path stamps let those
 * wrappers namespace their state by RPC path so user-supplied keys
 * cannot collide across different RPCs.
 * @param {any} fn
 * @param {string} path
 */
function _propagateWrapperPath(fn, path) {
	let cur = fn;
	for (let depth = 0; cur && depth < 10; depth++) {
		if (cur.__isRateLimited) cur.__rateLimitPath = path;
		if (cur.__isIdempotent) cur.__idempotencyPath = path;
		cur = cur.__wrappedFn || null;
	}
}

/**
 * Register a live function in the registry.
 * Called by the Vite-generated registry module.
 * Accepts either a live function directly or a lazy loader (tagged with __lazy).
 * @param {string} path
 * @param {Function} fn
 * @param {string} [modulePath] - Explicit module path for guard resolution (used by room sub-handlers)
 */
export function __register(path, fn, modulePath) {
	registry.set(path, fn);
	if (/** @type {any} */ (fn).__lazy) {
		if (modulePath) /** @type {any} */ (fn).__modulePathHint = modulePath;
		return;
	}
	// Cache module path to avoid recomputing substring on every RPC call
	/** @type {any} */ (fn).__modulePath = modulePath || path.substring(0, path.lastIndexOf('/'));
	_propagateWrapperPath(fn, path);
	if (/** @type {any} */ (fn).__isStream && /** @type {any} */ (fn).__onUnsubscribe) {
		_streamsWithUnsubscribe.add(fn);
	}
}

/**
 * Resolve a lazy registry entry. If the entry is a lazy loader (__lazy),
 * dynamically import the module, cache the resolved function, and return it.
 * @param {string} path
 * @returns {Promise<Function | null>}
 */
async function _resolveRegistryEntry(path) {
	const entry = registry.get(path);
	if (!entry) return null;
	if (!/** @type {any} */ (entry).__lazy) return entry;
	const hint = /** @type {any} */ (entry).__modulePathHint;
	const fn = await entry();
	if (!fn) {
		registry.delete(path);
		return null;
	}
	registry.set(path, fn);
	/** @type {any} */ (fn).__modulePath = hint || path.substring(0, path.lastIndexOf('/'));
	_propagateWrapperPath(fn, path);
	if (/** @type {any} */ (fn).__isStream && /** @type {any} */ (fn).__onUnsubscribe) {
		_streamsWithUnsubscribe.add(fn);
	}
	return fn;
}

/**
 * Register a guard for a module.
 * Called by the Vite-generated registry module.
 * Accepts either a guard function directly or a lazy loader (tagged with __lazy).
 * @param {string} modulePath
 * @param {Function} fn
 */
export function __registerGuard(modulePath, fn) {
	guards.set(modulePath, fn);
}

/**
 * Resolve a lazy guard entry.
 * @param {string} modulePath
 * @returns {Promise<Function | null>}
 */
async function _resolveGuard(modulePath) {
	const entry = guards.get(modulePath);
	if (!entry) return null;
	if (!/** @type {any} */ (entry).__lazy) return entry;
	const fn = await entry();
	if (!fn) {
		guards.delete(modulePath);
		return null;
	}
	guards.set(modulePath, fn);
	return fn;
}

/**
 * Mark a function as RPC-callable.
 * @template {Function} T
 * @param {T} fn
 * @returns {T}
 */
export function live(fn) {
	/** @type {any} */ (fn).__isLive = true;
	return fn;
}

/**
 * Disallowed entry names on a `defineTopics` map - these are reserved
 * for tooling metadata. Names are checked at registration time.
 */
const _RESERVED_TOPIC_NAMES = new Set(['__patterns', '__definedTopics']);

/**
 * Derive a documentable pattern string from a topic entry. Strings are
 * returned unchanged. Functions are called with sentinel placeholders
 * matching their declared arity (`{arg0}`, `{arg1}`, ...) so the
 * resulting string reads like a template the user could grep against
 * (`'audit:{arg0}'`). Functions that destructure args or read fields
 * may throw with the sentinels; in that case the pattern falls back
 * to `'<dynamic>'` rather than failing registration.
 *
 * @param {string | ((...args: any[]) => string)} value
 */
function _deriveTopicPattern(value) {
	if (typeof value === 'string') return value;
	const arity = value.length;
	const args = new Array(arity);
	for (let i = 0; i < arity; i++) args[i] = '{arg' + i + '}';
	try {
		const result = value(...args);
		return typeof result === 'string' ? result : '<dynamic>';
	} catch {
		return '<dynamic>';
	}
}

/**
 * Centralize topic patterns in one place so stream definitions and any
 * out-of-band consumers (SQL triggers, Postgres NOTIFY shapes, doc
 * generation, devtools panels) reference one source of truth. Each
 * entry is either a string (a static topic) or a function returning a
 * string from one or more args (a dynamic topic).
 *
 * Returned object exposes the same entries the input did, plus two
 * non-enumerable metadata properties:
 *   - `__definedTopics: true` - runtime marker for tooling.
 *   - `__patterns` - map of `name -> pattern string`, derived from
 *     each entry. Strings pass through; functions are called with
 *     sentinel placeholders matching their arity (`{arg0}`, `{arg1}`,
 *     ...). Useful for generating documentation comments alongside
 *     SQL triggers or for greppable cross-references.
 *
 * @example
 * ```js
 * // src/lib/topics.js
 * import { defineTopics } from 'svelte-realtime/server';
 *
 * export const TOPICS = defineTopics({
 *   audit:    (orgId)       => `audit:${orgId}`,
 *   security: (orgId)       => `security:${orgId}`,
 *   feed:     (orgId, kind) => `feed:${orgId}:${kind}`,
 *   systemNotices: 'system:notices'
 * });
 *
 * // Stream definition references the same source of truth:
 * import { TOPICS } from '$lib/topics';
 * export const auditFeed = live.stream(
 *   (ctx, orgId) => TOPICS.audit(orgId),
 *   loadAudit,
 *   { ... }
 * );
 *
 * // Documentation / SQL comment generation:
 * TOPICS.__patterns
 * // => { audit: 'audit:{arg0}', security: 'security:{arg0}',
 * //      feed: 'feed:{arg0}:{arg1}', systemNotices: 'system:notices' }
 * ```
 *
 * @template {Record<string, string | ((...args: any[]) => string)>} M
 * @param {M} map
 * @returns {M & { readonly __patterns: Record<keyof M, string>, readonly __definedTopics: true }}
 */
export function defineTopics(map) {
	if (!map || typeof map !== 'object' || Array.isArray(map)) {
		throw new Error('[svelte-realtime] defineTopics: requires a non-array object map');
	}
	/** @type {Record<string, string>} */
	const patterns = {};
	for (const name of Object.keys(map)) {
		if (_RESERVED_TOPIC_NAMES.has(name)) {
			throw new Error(`[svelte-realtime] defineTopics: '${name}' is a reserved name`);
		}
		const value = /** @type {any} */ (map)[name];
		if (typeof value !== 'string' && typeof value !== 'function') {
			throw new Error(`[svelte-realtime] defineTopics: '${name}' must be a string or function (got ${typeof value})`);
		}
		if (typeof value === 'string' && value.length === 0) {
			throw new Error(`[svelte-realtime] defineTopics: '${name}' must be a non-empty string`);
		}
		patterns[name] = _deriveTopicPattern(value);
	}
	Object.defineProperty(map, '__patterns', { value: patterns, enumerable: false, writable: false, configurable: false });
	Object.defineProperty(map, '__definedTopics', { value: true, enumerable: false, writable: false, configurable: false });
	return /** @type {any} */ (map);
}

/**
 * Mark a function as a stream provider.
 * Topic can be a static string or a function of (ctx, ...args) => string for dynamic topics.
 * @param {string | Function} topic
 * @param {Function} initFn
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, prepend?: boolean, max?: number, replay?: boolean | { size?: number }, coalesceBy?: (data: any) => string | number | null | undefined }} [options]
 * @returns {Function}
 */
live.stream = function stream(topic, initFn, options) {
	if (typeof topic === 'string' && topic.startsWith('__')) {
		throw new Error(`[svelte-realtime] live.stream topic '${topic}' uses reserved prefix '__'\n  See: https://svti.me/streams`);
	}
	if (typeof topic === 'function') {
		if (topic.constructor?.name === 'AsyncFunction') {
			throw new Error(`[svelte-realtime] live.stream topic function must not be async - topic resolution is synchronous\n  See: https://svti.me/streams`);
		}
		_tagTopicFn(topic);
	}
	const { replay, onSubscribe, onUnsubscribe, filter, access, delta, version, migrate, coalesceBy, classOfService, args: argsSchema, transform, volatile: volatileOpt, staleAfterMs, onError: streamOnError, invalidateOn, ...rest } = options || {};
	if (coalesceBy !== undefined && typeof coalesceBy !== 'function') {
		throw new Error('[svelte-realtime] live.stream coalesceBy must be a function (data) => key');
	}
	if (classOfService !== undefined && typeof classOfService !== 'string') {
		throw new Error('[svelte-realtime] live.stream classOfService must be a string naming a class registered via live.admission()');
	}
	if (argsSchema !== undefined && (argsSchema === null || typeof argsSchema !== 'object')) {
		throw new Error('[svelte-realtime] live.stream args must be a Standard Schema or Zod-compatible schema');
	}
	if (transform !== undefined && typeof transform !== 'function') {
		throw new Error('[svelte-realtime] live.stream transform must be a function (data) => projection');
	}
	if (volatileOpt !== undefined && typeof volatileOpt !== 'boolean') {
		throw new Error('[svelte-realtime] live.stream volatile must be a boolean');
	}
	if (volatileOpt && coalesceBy) {
		throw new Error('[svelte-realtime] live.stream cannot combine volatile: true with coalesceBy - volatile drops on backpressure, coalesceBy keeps the latest value queued. Pick one.');
	}
	if (volatileOpt && replay) {
		throw new Error('[svelte-realtime] live.stream cannot combine volatile: true with replay - volatile messages are intentionally not buffered for resume. Drop replay or drop volatile.');
	}
	if (staleAfterMs !== undefined) {
		if (typeof staleAfterMs !== 'number' || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
			throw new Error('[svelte-realtime] live.stream staleAfterMs must be a positive finite number');
		}
	}
	if (streamOnError !== undefined && typeof streamOnError !== 'function') {
		throw new Error('[svelte-realtime] live.stream onError must be a function (err, ctx, topic) => void');
	}
	let invalidatePatterns = null;
	if (invalidateOn !== undefined) {
		const list = Array.isArray(invalidateOn) ? invalidateOn : [invalidateOn];
		for (const p of list) {
			if (typeof p !== 'string' || p.length === 0) {
				throw new Error('[svelte-realtime] live.stream invalidateOn must be a non-empty string or array of non-empty strings');
			}
		}
		invalidatePatterns = list;
	}
	if (delta !== undefined) {
		if (typeof delta !== 'object' || delta === null) {
			throw new Error('[svelte-realtime] live.stream delta must be an object');
		}
		if (delta.version !== undefined && typeof delta.version !== 'function') {
			throw new Error('[svelte-realtime] live.stream delta.version must be a function');
		}
		if (delta.diff !== undefined && typeof delta.diff !== 'function') {
			throw new Error('[svelte-realtime] live.stream delta.diff must be a function');
		}
		if (delta.fromSeq !== undefined && typeof delta.fromSeq !== 'function') {
			throw new Error('[svelte-realtime] live.stream delta.fromSeq must be a function (sinceSeq) => events[]');
		}
	}
	// `key` only applies to `crud`. `set` and `latest` ignore it; `presence`
	// and `cursor` use a fixed `'key'` field on the data shape. Stamping a
	// default key on those just leaks dead bytes onto every subscribe response.
	const merged = { merge: 'crud', ...rest };
	if (merged.merge === 'crud' && merged.key === undefined) merged.key = 'id';
	if (replay) {
		/** @type {any} */ (initFn).__replay = typeof replay === 'object' ? replay : {};
		// Auto-routing registry: static topics register at declaration time so
		// any publisher (RPC handler, cron tick, derived watcher, etc.) gets
		// auto-routed through `platform.replay.publish` on first publish.
		// Dynamic topics (topic is a function) register at first-subscribe
		// time inside `_executeStreamRpc` when the topic resolves.
		if (typeof topic === 'string') _registerReplayTopic(topic);
	}
	if (delta) /** @type {any} */ (initFn).__delta = delta;
	if (classOfService) /** @type {any} */ (initFn).__classOfService = classOfService;
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = merged;
	if (coalesceBy) /** @type {any} */ (initFn).__coalesceBy = coalesceBy;
	if (argsSchema) /** @type {any} */ (initFn).__streamArgs = argsSchema;
	if (transform) /** @type {any} */ (initFn).__streamTransform = transform;
	if (volatileOpt) /** @type {any} */ (initFn).__streamVolatile = true;
	if (staleAfterMs) /** @type {any} */ (initFn).__streamStaleAfterMs = staleAfterMs;
	if (streamOnError) /** @type {any} */ (initFn).__streamOnError = streamOnError;
	if (invalidatePatterns) /** @type {any} */ (initFn).__streamInvalidateOn = invalidatePatterns;
	if (onSubscribe) /** @type {any} */ (initFn).__onSubscribe = onSubscribe;
	if (onUnsubscribe) /** @type {any} */ (initFn).__onUnsubscribe = onUnsubscribe;
	// Subscribe-time access predicate: (ctx) => boolean
	const filterFn = access || filter;
	if (filterFn) /** @type {any} */ (initFn).__streamFilter = filterFn;
	// Schema versioning
	if (version !== undefined) /** @type {any} */ (initFn).__streamVersion = version;
	if (migrate) /** @type {any} */ (initFn).__streamMigrate = migrate;
	return initFn;
};

/**
 * Create an ephemeral pub/sub channel with no database initialization.
 * Channels have no initFn - clients subscribe to a topic and receive events immediately.
 *
 * @param {string | Function} topic - Static topic string or function (ctx, ...args) => string for dynamic channels
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, max?: number }} [options]
 * @returns {Function}
 */
live.channel = function channel(topic, options) {
	if (typeof topic === 'string' && topic.startsWith('__')) {
		throw new Error(`[svelte-realtime] live.channel topic '${topic}' uses reserved prefix '__'\n  See: https://svti.me/streams`);
	}
	if (typeof topic === 'function') {
		if (topic.constructor?.name === 'AsyncFunction') {
			throw new Error(`[svelte-realtime] live.channel topic function must not be async - topic resolution is synchronous\n  See: https://svti.me/streams`);
		}
		_tagTopicFn(topic);
	}
	const merge = options?.merge || 'set';
	/** @type {any} */
	const merged = { merge };
	if (options?.key !== undefined) merged.key = options.key;
	else if (merge === 'crud') merged.key = 'id';
	if (options?.max !== undefined) merged.max = options.max;
	const emptyValue = (merged.merge === 'set') ? null : [];

	const initFn = async function channelInit() { return emptyValue; };
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__isChannel = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = merged;
	return initFn;
};

/**
 * Mark a function as a binary RPC handler.
 * The first argument after ctx is the raw ArrayBuffer.
 * Remaining arguments are JSON-encoded in a header.
 *
 * @param {Function} fn - Handler function (ctx, buffer, ...jsonArgs)
 * @returns {Function}
 */
live.binary = function binary(fn, options) {
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__isBinary = true;
	if (options?.maxSize) /** @type {any} */ (fn).__maxBinarySize = options.maxSize;
	return fn;
};

/**
 * Register a streaming upload handler. The handler consumes an async-iterable
 * of `Uint8Array` chunks and returns a JSON-serialisable result that's
 * delivered to the client when the stream ends.
 *
 * Handler signature: `async (ctx, ...args) => result`. The standard `ctx`
 * is augmented with:
 *   - `ctx.stream`  - AsyncIterable<Uint8Array> yielding chunks in arrival order
 *   - `ctx.signal`  - AbortSignal that fires on cancel / disconnect / cap exceeded
 *   - `ctx.upload`  - { id: string, total?: number, source: 'file'|'blob'|'buffer'|'stream' }
 *
 * Caps default to: 100MB per upload, 4 concurrent per session, unbounded
 * globally, 64 buffered chunks before flow-control kicks in.
 *
 * @param {(ctx: any, ...args: any[]) => Promise<any>} fn
 * @param {{ maxSize?: number, maxConcurrentPerSession?: number, maxConcurrentTotal?: number, maxBufferedChunks?: number, reauthEvery?: number }} [options]
 * @returns {Function}
 */
live.upload = function upload(fn, options) {
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__isUpload = true;
	// reauthEvery (bytes): when >0, every N bytes received past the last
	// re-auth, the chunk pump re-runs the module guard against the live
	// `ctx` so an upload in flight cannot outlive the session that
	// authorized it (token expiry, explicit logout, role downgrade). The
	// default is unset (legacy behavior: guard runs once at chunk-0 only).
	const reauthEvery = options?.reauthEvery;
	if (reauthEvery !== undefined && (typeof reauthEvery !== 'number' || !(reauthEvery > 0) || !Number.isFinite(reauthEvery))) {
		throw new Error('live.upload: reauthEvery must be a positive finite number of bytes');
	}
	/** @type {any} */ (fn).__uploadOptions = {
		maxSize: options?.maxSize ?? 104857600,
		maxConcurrentPerSession: options?.maxConcurrentPerSession ?? 4,
		maxConcurrentTotal: options?.maxConcurrentTotal ?? Infinity,
		maxBufferedChunks: options?.maxBufferedChunks ?? 64,
		reauthEvery: reauthEvery ?? 0
	};
	return fn;
};

/**
 * Register a global middleware that runs before per-module guards for every RPC/stream call.
 * Middleware receives `(ctx, next)` - call `next()` to continue the chain.
 * Throw a LiveError to reject the call.
 *
 * @param {(ctx: any, next: () => Promise<any>) => Promise<any>} fn
 */
live.middleware = function middleware(fn) {
	_globalMiddleware.push(fn);
};

/** Test-only: clear all registered global middleware. */
export function _resetMiddleware() {
	_globalMiddleware.length = 0;
}

/**
 * Declarative access control helpers for subscribe-time gating.
 * These return predicates compatible with `live.stream({ access: ... })`.
 * Access predicates receive only `ctx` and are checked once at subscription time.
 * For per-event filtering, use `pipe.filter()`.
 */
live.access = {
	/**
	 * Only allow subscription if `ctx.user[field]` is present (authenticated with that field).
	 * For per-user data isolation, use dynamic topics instead: `(ctx) => \`items:\${ctx.user.id}\``.
	 * @param {string} [field] - The field on ctx.user to check (default: 'id')
	 * @returns {(ctx: any) => boolean}
	 */
	owner(field = 'id') {
		return (ctx) => ctx.user?.[field] != null;
	},

	/**
	 * Role-based access: map role names to boolean or predicate.
	 * @param {Record<string, true | ((ctx: any) => boolean)>} map
	 * @returns {(ctx: any) => boolean}
	 */
	role(map) {
		return (ctx) => {
			const role = ctx.user?.role;
			if (!role || !(role in map)) return false;
			const rule = map[role];
			return rule === true ? true : rule(ctx);
		};
	},

	/**
	 * Only allow subscription if `ctx.user.teamId` is present.
	 * For per-team data isolation, use dynamic topics: `(ctx) => \`items:\${ctx.user.teamId}\``.
	 * @returns {(ctx: any) => boolean}
	 */
	team() {
		return (ctx) => ctx.user?.teamId != null;
	},

	/**
	 * Org-scoped access: an extracted value (default arg 0) must equal
	 * `ctx.user[orgField]` (default `'organization_id'`). Returns false
	 * when `ctx.user` is null. Use to close authorization-bypass holes
	 * around per-org streams and RPCs.
	 *
	 * @param {{ from?: (ctx: any, ...args: any[]) => any, orgField?: string }} [opts]
	 * @returns {(ctx: any, ...args: any[]) => boolean}
	 */
	org(opts) {
		const orgField = (opts && opts.orgField) || 'organization_id';
		const from = (opts && opts.from) || ((_ctx, ...args) => args[0]);
		return (ctx, ...args) => {
			const expected = ctx && ctx.user && ctx.user[orgField];
			if (expected == null) return false;
			const actual = from(ctx, ...args);
			return actual != null && actual === expected;
		};
	},

	/**
	 * User-scoped access: an extracted value (default arg 0) must equal
	 * `ctx.user[userField]` (default `'user_id'`, matching `[table]_id`
	 * convention). Returns false when `ctx.user` is null. Use for
	 * streams/RPCs that MUST belong to the calling user (e.g. private
	 * inbox); set `from` for handlers where the relevant id lives in
	 * a non-default position.
	 *
	 * @param {{ from?: (ctx: any, ...args: any[]) => any, userField?: string }} [opts]
	 * @returns {(ctx: any, ...args: any[]) => boolean}
	 */
	user(opts) {
		const userField = (opts && opts.userField) || 'user_id';
		const from = (opts && opts.from) || ((_ctx, ...args) => args[0]);
		return (ctx, ...args) => {
			const expected = ctx && ctx.user && ctx.user[userField];
			if (expected == null) return false;
			const actual = from(ctx, ...args);
			return actual != null && actual === expected;
		};
	},

	/**
	 * OR logic: any predicate returning true allows the subscription.
	 * Args are forwarded so args-aware predicates (`org`, `user`) compose.
	 * Sub-predicates may be sync or async; each is awaited in order so
	 * a Promise<false> correctly denies instead of short-circuiting on a
	 * truthy Promise object.
	 * @param {...((ctx: any, ...args: any[]) => boolean | Promise<boolean>)} predicates
	 * @returns {(ctx: any, ...args: any[]) => Promise<boolean>}
	 */
	any(...predicates) {
		return async (ctx, ...args) => {
			for (const p of predicates) {
				if (await p(ctx, ...args)) return true;
			}
			return false;
		};
	},

	/**
	 * AND logic: all predicates must return true to allow the subscription.
	 * Args are forwarded so args-aware predicates (`org`, `user`) compose.
	 * Sub-predicates may be sync or async; each is awaited in order so
	 * a Promise<false> correctly denies instead of falling through on a
	 * truthy Promise object.
	 * @param {...((ctx: any, ...args: any[]) => boolean | Promise<boolean>)} predicates
	 * @returns {(ctx: any, ...args: any[]) => Promise<boolean>}
	 */
	all(...predicates) {
		return async (ctx, ...args) => {
			for (const p of predicates) {
				if (!(await p(ctx, ...args))) return false;
			}
			return true;
		};
	}
};

/**
 * Declarative per-function rate limiting.
 * Marker wrapper that declares an RPC is intentionally public (no
 * `_guard` required). Returns the inner handler unchanged at runtime;
 * the vite codegen detects `live.public(...)` in source and
 * suppresses the build-time "no _guard" warning for that module.
 *
 * Use per-export to flag handlers that genuinely accept any
 * authenticated client (e.g. server-time, public health probes,
 * unauthenticated read-only endpoints). For module-wide public RPCs,
 * the `// realtime-allow-public` source comment is the lighter
 * alternative.
 *
 * @param {Function} fn - Handler function (ctx, ...args)
 * @returns {Function}
 *
 * @example
 * ```js
 * // src/lib/realtime/health.js
 * import { live } from 'svelte-realtime';
 *
 * export const serverTime = live.public(async () => ({ now: Date.now() }));
 * ```
 */
live.public = function publicMarker(fn) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.public(fn) requires a handler function');
	}
	return fn;
};

/**
 * Mark a handler as fire-and-forget (volatile). The server still runs the
 * full middleware / guard / rate-limit / validation chain, but does NOT
 * write a response frame back. The client calls the handler via
 * `.fireAndForget(...args)`, which sends a no-id wire frame and returns
 * void synchronously.
 *
 * Use for high-frequency one-way RPCs where the caller has no reply to
 * await: cursor moves, drag updates, typing indicators, telemetry beacons,
 * heartbeats. The handler-level marker is intent + documentation; the wire
 * shape (no `id` field) is the actual contract, so calling
 * `.fireAndForget()` on a non-volatile handler also works (server processes
 * it, just skips the reply). The marker exists so reviewers can see at a
 * glance that a handler is intentionally one-way and that errors will not
 * surface to the caller.
 *
 * Errors on a volatile call still run through the handler's error path
 * (metrics, server logs) but are not transmitted - per the fire-and-forget
 * contract. Pair with `live.rateLimit` + `ctx.shed` for admission control;
 * shed volatile calls naturally have no caller to inform.
 *
 * @param {Function} fn - Handler function (ctx, ...args)
 * @returns {Function}
 *
 * @example
 * ```js
 * // src/lib/realtime/cursors.js
 * import { live } from 'svelte-realtime';
 *
 * export const moveCursor = live.volatile(async (ctx, boardId, pos) => {
 *   cursor.update(ctx.ws, `board:${boardId}`, pos, ctx.platform);
 * });
 *
 * // Client:
 * import { moveCursor } from '$live/cursors';
 * moveCursor.fireAndForget('board-1', { x: 100, y: 200 });  // no await, no reply
 * ```
 */
live.volatile = function volatileMarker(fn) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.volatile(fn) requires a handler function');
	}
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__volatileRpc = true;
	return fn;
};

installRateLimit(live);

installDevWarnings(live);

/**
 * Reset the per-topic coalesce registry. Tests only.
 * @internal
 */
export function _resetCoalesceRegistry() {
	_topicCoalesce.clear();
}

/**
 * Reset the per-topic ws subscriber map. Tests only.
 * @internal
 */
export function _resetTopicWsCounts() {
	_topicWsCounts.clear();
	_topicWsCountsWarnFired = false;
}

installIdempotency(live);

installPush(live);

/**
 * Mark a function as RPC-callable with schema validation.
 * Validates args[0] against the schema before calling fn.
 * Supports any Standard Schema-compatible schema (https://standardschema.dev/),
 * including Zod, ArkType, Valibot v1+, and others.
 *
 * @param {any} schema - Zod, ArkType, Valibot, or any Standard Schema-compatible schema
 * @param {Function} fn - Handler function (ctx, validatedInput, ...rest)
 * @returns {Function}
 */
live.validated = function validated(schema, fn) {
	const wrapper = async function validatedWrapper(ctx, ...args) {
		const input = args[0];
		const result = _validate(schema, input);
		if (!result.ok) {
			const err = new LiveError('VALIDATION', result.message);
			/** @type {any} */ (err).issues = result.issues;
			throw err;
		}
		args[0] = result.data;
		return fn(ctx, ...args);
	};
	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isValidated = true;
	/** @type {any} */ (wrapper).__schema = schema;
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Validate input against a Standard Schema-compatible schema, with legacy Zod/Valibot fallbacks.
 * @param {any} schema
 * @param {any} input
 * @returns {{ ok: true, data: any } | { ok: false, message: string, issues: Array<{ path: string[], message: string }> }}
 */
function _validate(schema, input) {
	// Standard Schema: schema exposes `~standard.validate` (https://standardschema.dev/)
	if (schema?.['~standard'] && typeof schema['~standard'].validate === 'function') {
		const result = schema['~standard'].validate(input);
		if (result instanceof Promise) {
			return {
				ok: false,
				message: 'Async schemas are not supported in live.validated(). Use a synchronous schema.',
				issues: [{ path: [], message: 'Async schema not supported' }]
			};
		}
		if (result.issues == null) {
			return { ok: true, data: result.value };
		}
		const issues = result.issues.map((/** @type {any} */ i) => ({
			path: (i.path || []).map((/** @type {any} */ p) => {
				const key = typeof p === 'object' && p !== null && 'key' in p ? p.key : p;
				return key != null ? String(key) : '';
			}).filter((k) => k !== ''),
			message: i.message || 'Validation failed'
		}));
		return { ok: false, message: 'Validation failed', issues };
	}

	// Zod legacy fallback: schema has .safeParse method
	if (typeof schema?.safeParse === 'function') {
		const result = schema.safeParse(input);
		if (result.success) {
			return { ok: true, data: result.data };
		}
		const issues = (result.error?.issues || result.error?.errors || []).map((/** @type {any} */ i) => ({
			path: i.path?.map(String) || [],
			message: i.message || 'Validation failed'
		}));
		return {
			ok: false,
			message: 'Validation failed',
			issues
		};
	}

	// Valibot legacy fallback: schema is passed to a standalone safeParse
	// In Valibot v1, schemas have a ._run or .pipe method
	// Try to use the schema directly as a Valibot schema
	if (schema?._run || schema?.pipe || schema?.type) {
		// Attempt to import valibot's safeParse at call-time
		// Since we can't do static import (it's optional), check if schema has _run
		try {
			const entries = schema._run?.({ typed: false, value: input }, {});
			if (entries && !entries.issues) {
				return { ok: true, data: entries.output ?? input };
			}
			if (entries?.issues) {
				const issues = entries.issues.map((/** @type {any} */ i) => ({
					path: i.path?.map((/** @type {any} */ p) => String(p.key)) || [],
					message: i.message || 'Validation failed'
				}));
				return { ok: false, message: 'Validation failed', issues };
			}
		} catch {
			// Fall through
		}
	}

	// Unknown schema type - reject. Passing unvalidated input through is a security risk.
	return {
		ok: false,
		message: 'Unrecognized schema type passed to live.validated(). Supported: Standard Schema (https://standardschema.dev/), Zod (.safeParse), Valibot (._run).',
		issues: [{ path: [], message: 'Unrecognized schema type' }]
	};
}

/**
 * Set a global error handler for server-side errors (cron, effects, derived).
 * Without this, errors are logged in dev and silently swallowed in production.
 * @param {(path: string, error: unknown) => void} handler
 */
export function onError(handler) {
	state.serverErrorHandler = handler;
}

/**
 * Create a server-side scheduled function that publishes to a topic on a cron schedule.
 *
 * @param {string} schedule - Cron expression (5 fields: minute hour day month weekday)
 * @param {string} topic - Topic to publish results to
 * @param {Function} fn - Async function to run on schedule
 * @returns {Function}
 */
live.cron = function cron(schedule, topic, fn) {
	/** @type {any} */ (fn).__isCron = true;
	/** @type {any} */ (fn).__cronSchedule = schedule;
	/** @type {any} */ (fn).__cronTopic = topic;
	/** @type {any} */ (fn).__cronParsed = _parseCron(schedule);
	return fn;
};

/**
 * Declare a server-side feature flag exposed as a readable stream.
 *
 * A flag is a thin wrapper over `live.stream`: it declares a `merge: 'set'`
 * topic carrying the flag value, and any `.set(value)` pushes the new value
 * to every subscriber. On the client, `$live/<module>` exposes the export as
 * a readable store carrying the current value.
 *
 * Flags are cluster-consistent by default: a single-entry shared replay
 * buffer is enabled, so `.set()` writes the cluster-shared buffer and a
 * subscriber that connects fresh - to any replica, including one that never
 * set the flag locally - is served the cluster-latest value. Already-
 * subscribed clients stay in sync across the cluster as `.set()` relays the
 * update. Pass a custom `replay` object to size the buffer, or
 * `replay: false` to opt out (single-process apps lose nothing, since the
 * locally cached value is authoritative in one process).
 *
 * On every running replica an internal watcher keeps the cached value fresh
 * from boot. The watcher is installed when the registry module loads (the
 * same moment `live.effect` watchers become active), so it does not wait for
 * the flag module's first local import or subscribe: an inbound `set` relayed
 * from any replica updates the cached value within a tick, and the synchronous
 * `.get()` reflects the cluster-latest value on any running instance. For a
 * strict read on a replica that booted AFTER the last `set` and has not yet
 * received any inbound `set` (the watcher only catches post-boot sets), use the
 * asynchronous `getLatest()`, which reads the shared buffer directly.
 *
 * The `.set(value)` method publishes through the framework-owned platform
 * (the same path as the top-level `publish()` helper), so the new value
 * reaches every local subscriber and relays across the cluster when a bus
 * is wired. Call it from any server context after the platform has been
 * captured (RPC handler, cron tick, effect, an admin `+server.js` route).
 *
 * @param {string} topic - Topic carrying the flag value
 * @param {any} [initialValue] - Value served to subscribers before the first `.set`
 * @param {{ replay?: boolean | { size?: number } }} [options]
 * @returns {Function & { set(value: any): any, get(): any, getLatest(): Promise<any> }}
 *
 * @example
 * ```js
 * // src/live/flags.js
 * import { live } from 'svelte-realtime/server';
 * export const maintenance = live.flag('flag:maintenance', false);
 *
 * // Flip it from any handler:
 * export const toggleMaintenance = live(async (ctx, on) => {
 *   maintenance.set(on);
 * });
 * ```
 *
 * ```svelte
 * <script>
 *   import { maintenance } from '$live/flags';
 * </script>
 * {#if $maintenance}<Banner />{/if}
 * ```
 */
live.flag = function flag(topic, initialValue, options) {
	if (typeof topic !== 'string' || topic.length === 0) {
		throw new Error('[svelte-realtime] live.flag topic must be a non-empty string');
	}
	// The flag's value lives in a per-topic cell shared with the eager
	// registry-load watcher (installed by `__registerFlag`). Binding to the
	// cell instead of a private closure variable decouples the value from this
	// module's import: a `set` that arrives before the module is first imported
	// is captured into the cell by the eager watcher, so the first `.get()`
	// after import reads the cluster-latest value rather than a stale init.
	const cell = _flagCell(topic, initialValue);
	const initFn = async function flagInit() { return cell.value; };
	// Replay is ON by default with a single-entry buffer so the flag's
	// topic is replay-eligible at declaration: `.set() -> publish() ->
	// _maybeReplayPublish` writes the cluster-shared buffer, and a fresh
	// subscriber (or a just-booted replica) is served the cluster-latest
	// value through the seeding branch in `_executeStreamRpc`. Pass a
	// custom `replay` object to override the buffer size, or `replay: false`
	// to opt out (single-process apps lose nothing - the cached value is
	// authoritative in one process).
	const streamOpts = { merge: 'set' };
	if (options && options.replay === false) {
		// opt out: leave replay unset
	} else if (options && options.replay) {
		/** @type {any} */ (streamOpts).replay = options.replay;
	} else {
		/** @type {any} */ (streamOpts).replay = { size: 1 };
	}
	const stream = live.stream(topic, initFn, streamOpts);
	/** @type {any} */ (stream).__isFlag = true;
	/**
	 * Read the flag's current value on the server (synchronous). On a running
	 * replica this stays fresh from boot within a tick of any inbound `set` via
	 * the per-topic watcher installed eagerly at registry load (see
	 * `__registerFlag`). For a strict read on a replica that booted after the
	 * last `set` and has not yet received any inbound `set`, use `getLatest()`.
	 */
	/** @type {any} */ (stream).get = function get() { return cell.value; };
	/**
	 * Read the cluster-latest flag value (asynchronous). Reads the shared
	 * replay buffer when one is wired and non-empty; otherwise falls back to
	 * the locally cached value. Serves the strict read-after-cold-boot
	 * case where a replica may not yet have observed the cluster-latest set.
	 */
	/** @type {any} */ (stream).getLatest = async function getLatest() {
		// Resolve the captured platform the same way `.set()` does (via the
		// top-level `publish()` helper), so `getLatest()` reads the shared
		// buffer whether the platform was captured by `_activateDerived` or
		// `setCronPlatform`.
		const platform = getPlatform();
		const replay = platform && /** @type {any} */ (platform).replay;
		if (replay && typeof replay.since === 'function') {
			try {
				const buffered = await replay.since(topic, 0);
				if (Array.isArray(buffered) && buffered.length > 0) {
					const last = buffered[buffered.length - 1];
					if (last && 'data' in last) return last.data;
				}
			} catch {}
		}
		return cell.value;
	};
	/** Publish a new flag value to every subscriber. */
	/** @type {any} */ (stream).set = function set(value) {
		cell.value = value;
		return publish(topic, 'set', value);
	};
	// Ensure the per-topic refresh watcher is installed. This is idempotent
	// with the eager `__registerFlag` install the registry module emits, and
	// covers the cases where a flag module is imported without a generated
	// registry (the dev-mode direct-load fallback, or a flag declared inline
	// in tests).
	_installFlagWatcher(topic);
	return /** @type {any} */ (stream);
};

/**
 * Create a server-side computed stream that recomputes when any source topic publishes.
 *
 * Static form: sources is a string[] of topic names.
 * Dynamic form: sources is a function (...args) => string[] that resolves topics at subscribe time.
 *
 * @param {string[] | Function} sources - Topic names to watch, or a factory that receives runtime args
 * @param {Function} fn - Async function that computes the derived value
 * @param {{ merge?: string, debounce?: number }} [options]
 * @returns {Function}
 */
live.derived = function derived(sources, fn, options) {
	const baseTopic = /** @type {any} */ (fn).__derivedTopic || ('__derived:' + (_derivedIdCounter++));
	const merge = options?.merge || 'set';
	const debounce = options?.debounce || 0;
	const dynamic = typeof sources === 'function';

	/** @type {any} */ (fn).__isDerived = true;
	/** @type {any} */ (fn).__isStream = true;
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__streamOptions = merge === 'crud' ? { merge, key: 'id' } : { merge };
	/** @type {any} */ (fn).__derivedDebounce = debounce;

	if (dynamic) {
		/** @type {any} */ (fn).__derivedDynamic = true;
		/** @type {any} */ (fn).__derivedSourceFactory = sources;
		/** @type {Map<string, any[]>} */
		const topicArgs = new Map();
		const topicFn = (...args) => {
			const t = baseTopic + '~' + args.map(a => String(a).replace(/~/g, '')).join('~');
			topicArgs.set(t, args);
			if (topicArgs.size > 10000) {
				const iter = topicArgs.keys();
				topicArgs.delete(iter.next().value);
			}
			return t;
		};
		/** @type {any} */ (topicFn).__topicUsesCtx = false;
		/** @type {any} */ (fn).__streamTopic = topicFn;
		/** @type {any} */ (fn).__derivedTopicArgs = topicArgs;

		/** @type {any} */ (fn).__onSubscribe = function (_ctx, resolvedTopic) {
			_activateDynamicDerived(fn, resolvedTopic, _ctx && _ctx.user);
		};
		/** @type {any} */ (fn).__onUnsubscribe = function (_ctx, resolvedTopic) {
			_deactivateDynamicDerived(fn, resolvedTopic);
		};
	} else {
		/** @type {any} */ (fn).__streamTopic = baseTopic;
		/** @type {any} */ (fn).__derivedSources = sources;
	}

	return fn;
};

let _derivedIdCounter = 0;

/** @type {boolean} Whether any dynamic derived streams have been registered */
let _hasDynamicDerived = false;

/**
 * Eagerly set to `true` the moment any reactive registration (live.derived,
 * live.effect, live.aggregate - static or dynamic) hits the lazy queue,
 * BEFORE the queue resolves and populates the source-watch indices.
 *
 * Why this exists: `_activateDerived(platform)` early-returns when every
 * source-watch index is empty, to avoid wrapping `platform.publish` for
 * apps that never use the reactive primitives. But the README's
 * recommended call site for `_activateDerived` is `init({ platform })`,
 * which fires BEFORE the lazy queue drains. So at activation time the
 * indices look empty even though registrations are pending. Without this
 * flag, the wrap never installs and the first cron-driven publish (or
 * any publish that fires before the first WS connect) silently bypasses
 * watchers. This eager flag tells `_activateDerived` "registrations are
 * coming, install the wrap now" - and `_maybeLateActivate` covers the
 * symmetric case where activation runs *after* a registration resolves.
 *
 * @type {boolean}
 */
let _hasLazyReactive = false;

/**
 * Create a server-side reactive side effect.
 * Effects fire when source topics publish. They are fire-and-forget - no data, no topic.
 *
 * @param {string[]} sources - Topic names to watch
 * @param {Function} fn - Async function (event, data, platform) called on each matching publish
 * @param {{ debounce?: number }} [options]
 * @returns {Function}
 */
live.effect = function effect(sources, fn, options) {
	const debounce = options?.debounce || 0;
	/** @type {any} */ (fn).__isEffect = true;
	/** @type {any} */ (fn).__effectSources = sources;
	/** @type {any} */ (fn).__effectDebounce = debounce;
	return fn;
};

/**
 * Register an effect. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerEffect(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'effect', path, loader: fn });
		_hasLazyReactive = true;
		return;
	}
	const sources = /** @type {any} */ (fn).__effectSources;
	const debounce = /** @type {any} */ (fn).__effectDebounce || 0;
	if (!sources) return;
	effectRegistry.set(path, { sources, fn, debounce, timer: null });
	for (const src of sources) {
		let set = _effectBySource.get(src);
		if (!set) { set = new Set(); _effectBySource.set(src, set); }
		set.add(effectRegistry.get(path));
		_watchedTopics.add(src);
	}
	_maybeLateActivate();
}

/**
 * Register an outbound webhook. Called by the Vite-generated registry module.
 * Outbound webhooks are effect-like: they watch source topics and fire on
 * publish (leader-gated), so they register into the same watched-topic index.
 * @param {string} path
 * @param {any} fn - The outbound-webhook marker object from `live.webhooks.outbound`.
 */
export function __registerWebhookOut(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'webhookOut', path, loader: fn });
		_hasLazyReactive = true;
		return;
	}
	const sources = /** @type {any} */ (fn).__webhookOutSources;
	const config = /** @type {any} */ (fn).__webhookOutConfig;
	if (!sources || !config) return;
	webhookOutRegistry.set(path, { sources, config });
	for (const src of sources) {
		let set = _webhookOutBySource.get(src);
		if (!set) { set = new Set(); _webhookOutBySource.set(src, set); }
		set.add(webhookOutRegistry.get(path));
		_watchedTopics.add(src);
	}
	_maybeLateActivate();
}

/**
 * Per-topic value cells for `live.flag`. The cell holds the flag's current
 * value and is shared between the flag export's accessors (`get`/`set`/the
 * loader) and the eager refresh watcher installed at registry load. Keying on
 * the topic (rather than the export path) lets the watcher install before the
 * flag module is imported - the value the watcher captures from inbound sets is
 * exactly the value the flag's `.get()` reads once the module is imported.
 * @type {Map<string, { value: any }>}
 */
const _flagCells = new Map();

/**
 * Per-topic refresh watcher entries, so the install is idempotent across the
 * eager registry call and the flag module's own import.
 * @type {Map<string, { sources: string[], fn: Function, debounce: number, timer: ReturnType<typeof setTimeout> | null }>}
 */
const _flagWatchers = new Map();

/**
 * Get (or create) the value cell for a flag topic. A cell created by the eager
 * watcher path may not have a meaningful seed yet; the first caller that knows
 * the declared `initialValue` (the watcher install or the flag body, whichever
 * runs first) seeds it. Inbound sets always overwrite the seed.
 * @param {string} topic
 * @param {any} [initialValue]
 * @returns {{ value: any }}
 */
function _flagCell(topic, initialValue) {
	let cell = _flagCells.get(topic);
	if (!cell) {
		cell = { value: initialValue };
		_flagCells.set(topic, cell);
	} else if (cell.value === undefined && initialValue !== undefined) {
		// Adopt the declared initial value when the cell was created without
		// one (e.g. the eager watcher had no static initialValue to pass).
		cell.value = initialValue;
	}
	return cell;
}

/**
 * Install the per-topic flag refresh watcher into the effect index. Idempotent:
 * one watcher per topic, regardless of how many times this is called. The
 * watcher updates the topic's value cell on every inbound `set`, so a sync
 * `.get()` reflects the cluster-latest value from boot on every running replica.
 *
 * The bus inbound relay reaches `derivedPublishLocal -> fireWatchers(topic,
 * event, data)`, so a `set` originating on any replica updates the cell here
 * (the self-set echo on the origin is idempotent). `_maybeLateActivate()`
 * installs the publish wrap even when the flag is declared before
 * `_activateDerived`.
 * @param {string} topic
 */
function _installFlagWatcher(topic) {
	if (_flagWatchers.has(topic)) return;
	const cell = _flagCell(topic);
	const watcher = {
		sources: [topic],
		fn: function flagWatcher(event, data) { if (event === 'set') cell.value = data; },
		debounce: 0,
		timer: null
	};
	_flagWatchers.set(topic, watcher);
	let watcherSet = _effectBySource.get(topic);
	if (!watcherSet) { watcherSet = new Set(); _effectBySource.set(topic, watcherSet); }
	watcherSet.add(watcher);
	_watchedTopics.add(topic);
	_maybeLateActivate();
}

/**
 * Register a flag's refresh watcher eagerly. Called by the Vite-generated
 * registry module at registry-module load (the same lifecycle that activates
 * `live.effect` watchers), so the watcher is live from server boot on every
 * replica WITHOUT waiting for the flag module's first local import or subscribe.
 *
 * Carries the static topic and (when statically analyzable) the declared
 * `initialValue` so the cell is seeded before any inbound `set`. The flag's
 * `__register` stream entry is emitted alongside this and remains lazy; only the
 * watcher install is hoisted to boot.
 * @param {string} topic
 * @param {any} [initialValue]
 */
export function __registerFlag(topic, initialValue) {
	if (typeof topic !== 'string' || topic.length === 0) return;
	_flagCell(topic, initialValue);
	_installFlagWatcher(topic);
}
/** @type {Map<string, any>} Topic-keyed lookup for aggregates */
const _aggregateByTopic = new Map();

/** @type {Map<string, { sources: string[], config: any }>} path -> outbound webhook entry */
const webhookOutRegistry = new Map();

/**
 * Maximum number of hop buckets a single sliding window may allocate.
 * Sliding state is `O(bucketCount * per-bucket state)`, so a 10-hour
 * sliding window with 1-minute slides already weighs in at 600 buckets;
 * 1000 is a generous default that catches obviously-wrong configs
 * (e.g. 1ms slide on a 1s window) at module load time. Override via
 * `_setCapsForTest` if needed.
 */
export let MAX_AGGREGATE_BUCKETS = 1000;

/**
 * Validate a single window spec at module-load time. Throws on:
 *  - unknown `type`
 *  - tumbling without either `period` or `durationMs`
 *  - tumbling `period` outside the supported set
 *  - sliding without `durationMs` / `slideMs`, or with `slideMs > durationMs`
 *  - sliding bucket count exceeding `MAX_AGGREGATE_BUCKETS`
 *  - sliding without a `combine` field on every reducer that has `reduce`
 *
 * Failing fast at registration is the difference between "the demo never
 * boots and prints a clear stack trace" and "the demo boots and starts
 * silently dropping events into a bucket array that does not exist."
 *
 * @param {string} name
 * @param {any} spec
 * @param {Record<string, any>} reducers
 */
function _validateWindowSpec(name, spec, reducers) {
	if (!spec || typeof spec !== 'object') {
		throw new Error(`[svelte-realtime] live.aggregate window '${name}': spec must be an object`);
	}
	const type = spec.type;
	if (type !== 'lifetime' && type !== 'tumbling' && type !== 'sliding') {
		throw new Error(`[svelte-realtime] live.aggregate window '${name}': unknown type '${type}' (expected 'lifetime', 'tumbling', or 'sliding')`);
	}
	if (type === 'tumbling') {
		const hasPeriod = typeof spec.period === 'string';
		const hasDuration = typeof spec.durationMs === 'number' && spec.durationMs > 0;
		if (hasPeriod === hasDuration) {
			throw new Error(`[svelte-realtime] live.aggregate window '${name}': tumbling spec must have exactly one of 'period' or 'durationMs'`);
		}
		if (hasPeriod && !['minute', 'hour', 'daily', 'monthly'].includes(spec.period)) {
			throw new Error(`[svelte-realtime] live.aggregate window '${name}': tumbling period '${spec.period}' is not supported (expected 'minute' | 'hour' | 'daily' | 'monthly')`);
		}
	}
	if (type === 'sliding') {
		if (typeof spec.durationMs !== 'number' || spec.durationMs <= 0) {
			throw new Error(`[svelte-realtime] live.aggregate window '${name}': sliding requires a positive 'durationMs'`);
		}
		if (typeof spec.slideMs !== 'number' || spec.slideMs <= 0) {
			throw new Error(`[svelte-realtime] live.aggregate window '${name}': sliding requires a positive 'slideMs'`);
		}
		if (spec.slideMs > spec.durationMs) {
			throw new Error(`[svelte-realtime] live.aggregate window '${name}': slideMs (${spec.slideMs}) must be <= durationMs (${spec.durationMs})`);
		}
		const bucketCount = Math.ceil(spec.durationMs / spec.slideMs);
		if (bucketCount > MAX_AGGREGATE_BUCKETS) {
			throw new Error(`[svelte-realtime] live.aggregate window '${name}': sliding bucket count ${bucketCount} exceeds MAX_AGGREGATE_BUCKETS (${MAX_AGGREGATE_BUCKETS}). Increase slideMs or shorten durationMs.`);
		}
		// Sliding requires combine on every reducer that has a reduce(); otherwise
		// the cross-bucket state cannot be recombined. Catch at module load.
		for (const [field, r] of Object.entries(reducers)) {
			if (r.reduce && typeof r.combine !== 'function') {
				throw new Error(`[svelte-realtime] live.aggregate window '${name}' (sliding): reducer '${field}' has reduce() but no combine(). Sliding windows merge state across hop buckets and need an explicit combine. See built-in helpers: combineSum, combineCounts, combineMax, combineMin, combineMerge.`);
			}
		}
	}
}

/**
 * Compute the next boundary timestamp for a tumbling window of the
 * given period in the given IANA time zone (default 'UTC'). Uses
 * `Intl.DateTimeFormat` for zone-correct, DST-correct, leap-day-correct
 * arithmetic without a third-party dependency.
 *
 * @param {number} now - epoch ms reference
 * @param {'minute' | 'hour' | 'daily' | 'monthly'} period
 * @param {string} tz
 * @returns {number} epoch ms of the next boundary > now
 */
function _nextBoundaryForPeriod(now, period, tz = 'UTC') {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric', month: 'numeric', day: 'numeric',
		hour: 'numeric', minute: 'numeric', second: 'numeric',
		hour12: false
	});
	// Intl.DateTimeFormat.formatToParts accepts a numeric epoch-ms directly, so
	// the already-numeric reference is formatted in the target time zone without
	// constructing an intermediate Date.
	const parts = fmt.formatToParts(now);
	const get = (k) => Number(parts.find(p => p.type === k)?.value);
	let y = get('year'), mo = get('month'), d = get('day');
	let h = get('hour'), mi = get('minute');
	if (h === 24) h = 0; // some Intl impls render midnight as 24
	// Compute the wall-clock of the next boundary in the target tz.
	let nextY = y, nextMo = mo, nextD = d, nextH = h, nextMi = mi;
	if (period === 'minute') {
		nextMi = mi + 1;
	} else if (period === 'hour') {
		nextH = h + 1; nextMi = 0;
	} else if (period === 'daily') {
		nextD = d + 1; nextH = 0; nextMi = 0;
	} else { // monthly
		nextMo = mo + 1; nextD = 1; nextH = 0; nextMi = 0;
	}
	// Resolve the wall-clock back to an epoch ms in the target tz by
	// constructing a UTC Date with the wall-clock fields, asking Intl
	// for what tz it would render that as, computing the offset, and
	// subtracting. Two-pass for DST-fall-back correctness (an offset
	// that changes between iso-construction and now).
	const isoMs = Date.UTC(nextY, nextMo - 1, nextD, nextH, nextMi, 0, 0);
	const tzOffsetMs = isoMs - _wallClockUtcInTz(isoMs, tz);
	return isoMs + tzOffsetMs;
}

/**
 * Reverse of the formatter: given a UTC ms reference, what is the same
 * wall-clock (year-month-day-hour-min-sec) but interpreted as if it
 * were in `tz`? Returns the equivalent UTC ms. Used to compute the
 * tz->UTC offset by subtracting from the input.
 *
 * @param {number} ms
 * @param {string} tz
 * @returns {number}
 */
function _wallClockUtcInTz(ms, tz) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric', month: 'numeric', day: 'numeric',
		hour: 'numeric', minute: 'numeric', second: 'numeric',
		hour12: false
	});
	// formatToParts takes the numeric epoch-ms directly; no intermediate Date.
	const parts = fmt.formatToParts(ms);
	const get = (k) => Number(parts.find(p => p.type === k)?.value);
	let h = get('hour'); if (h === 24) h = 0;
	return Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second'), 0);
}

/**
 * Compute the next boundary for a tumbling window of fixed duration
 * anchored at `anchor` (default UTC epoch).
 *
 * @param {number} now - epoch ms
 * @param {number} durationMs
 * @param {number} [anchor]
 * @returns {number}
 */
function _nextBoundaryForDuration(now, durationMs, anchor = 0) {
	const elapsed = now - anchor;
	const periods = Math.floor(elapsed / durationMs) + 1;
	return anchor + periods * durationMs;
}

/**
 * Built-in `combine` helpers for the common reducer shapes. Pass any of
 * these as `combine` on a reducer when using a sliding window:
 *
 * ```js
 * counts: {
 *   init: () => ({}),
 *   reduce: (acc, event, data) => ({ ...acc, [data.id]: (acc[data.id] ?? 0) + 1 }),
 *   combine: combineCounts
 * }
 * ```
 *
 * Hand-roll your own combine for non-trivial reducers (top-K, percentile
 * sketches, custom state shapes). The escape hatch is fully intact.
 */
export const combineSum = (...buckets) => buckets.reduce((s, b) => s + (b ?? 0), 0);
export const combineMax = (...buckets) => {
	let best = -Infinity, seen = false;
	for (const b of buckets) { if (b == null) continue; if (!seen || b > best) { best = b; seen = true; } }
	return seen ? best : 0;
};
export const combineMin = (...buckets) => {
	let best = Infinity, seen = false;
	for (const b of buckets) { if (b == null) continue; if (!seen || b < best) { best = b; seen = true; } }
	return seen ? best : 0;
};
export const combineCounts = (...buckets) => {
	const merged = {};
	for (const b of buckets) {
		if (!b) continue;
		for (const [k, v] of Object.entries(b)) merged[k] = (merged[k] ?? 0) + v;
	}
	return merged;
};
export const combineMerge = (...buckets) => {
	const merged = {};
	for (const b of buckets) { if (b) Object.assign(merged, b); }
	return merged;
};


/**
 * Create a real-time incremental aggregation over a source topic.
 * Each event runs O(1) reducers instead of requerying the database.
 *
 * **Single-state form** (no `windows`): the original behavior. One
 * state slice per reducer field, one output topic, one snapshot.
 *
 * **Windowed form** (`windows: { ... }`): declarative time-windowed
 * aggregation. One state slice per (reducer field x window), per-window
 * output topic at `${topic}:${windowName}`, per-window debounce + snapshot.
 * Supports three window types:
 *
 * - `lifetime` - never resets; equivalent to a single-state aggregate
 *   exposed as a named output for symmetry.
 * - `tumbling` - boundary-anchored. `period: 'minute' | 'hour' | 'daily'
 *   | 'monthly'` resets at the configured tz's natural boundary;
 *   `durationMs + anchor` resets at fixed intervals from a custom epoch.
 *   On boundary cross, the closing window publishes one final pre-reset
 *   state, then state is `init()`-cleared for the new window.
 * - `sliding` - hop-window with `durationMs / slideMs` buckets. Each
 *   event reduces into the current hop; on each slide, drop the oldest
 *   bucket and start a new current bucket. Reducers MUST provide a
 *   `combine(...buckets)` field so cross-bucket state can be recomputed
 *   on each publish; built-in helpers `combineSum`, `combineCounts`,
 *   `combineMax`, `combineMin`, `combineMerge` cover the common shapes.
 *
 * **Cluster mode (important).** Today's aggregate runs on every worker
 * fed by the source topic via the adapter's cluster bus. State converges
 * across workers as long as the source topic fans out to every worker
 * (the default). Sharded source topics (where each worker sees a
 * partition rather than the full firehose) will produce divergent
 * per-worker state and inconsistent per-window publishes. For sharded
 * sources, layer a leader gate later (symmetric to `configureCron({
 * leader })`) - not shipped in this slice.
 *
 * @param {string} source - Topic to watch for events
 * @param {Record<string, { init?: () => any, reduce?: (acc: any, event: string, data: any) => any, compute?: (state: any) => any, combine?: (...buckets: any[]) => any }>} reducers
 * @param {{ topic: string, snapshot?: () => Promise<any>, snapshots?: Record<string, () => Promise<any>>, debounce?: number, windows?: Record<string, any> }} options
 * @returns {Function}
 */
live.aggregate = function aggregate(source, reducers, options) {
	const topic = options.topic;
	const debounce = options?.debounce || 0;
	const windowsSpec = options?.windows || null;

	// Build initial state from init() functions
	const initState = {};
	for (const [field, r] of Object.entries(reducers)) {
		if (r.init) initState[field] = r.init();
	}

	// ---- Windowed form ----
	if (windowsSpec) {
		const windowKeys = Object.keys(windowsSpec);
		if (windowKeys.length === 0) {
			throw new Error('[svelte-realtime] live.aggregate: windows must declare at least one window');
		}
		for (const [name, spec] of Object.entries(windowsSpec)) {
			_validateWindowSpec(name, spec, reducers);
		}

		// The "root" function. It is NOT a stream itself; the per-window
		// streams attached as `__windowStreams` are what the Vite plugin
		// generates client stubs for. Calling the root directly throws --
		// the user's per-window subscribe path is the intended entry.
		const root = function aggregateRoot() {
			throw new Error('[svelte-realtime] Windowed aggregate is not a single stream; subscribe via its per-window children (e.g. `myAggregate.last10min`).');
		};

		/** @type {any} */ (root).__isAggregate = true;
		/** @type {any} */ (root).__isLive = true;
		/** @type {any} */ (root).__aggregateSource = source;
		/** @type {any} */ (root).__aggregateReducers = reducers;
		/** @type {any} */ (root).__aggregateInitState = initState;
		/** @type {any} */ (root).__aggregateBaseTopic = topic;
		/** @type {any} */ (root).__aggregateSnapshot = options?.snapshot || null;
		/** @type {any} */ (root).__aggregateSnapshots = options?.snapshots || null;
		/** @type {any} */ (root).__aggregateDebounce = debounce;
		/** @type {any} */ (root).__aggregateWindows = windowsSpec;
		/** @type {any} */ (root).__aggregateWindowKeys = windowKeys;

		// Build per-window stream functions. Each is registered separately
		// via the Vite plugin's per-window registry lines and exposed on
		// the client as `myAggregate.windowName`.
		const windowStreams = {};
		for (const wn of windowKeys) {
			const outputTopic = `${topic}:${wn}`;
			const perWindowInit = async function aggregatePerWindowInit() {
				const entry = _aggregateByTopic.get(topic);
				if (!entry || !entry.windowStates) {
					return _computeAggregateState(initState, reducers);
				}
				if (entry._hydrationPromise) await entry._hydrationPromise;
				const winState = entry.windowStates.get(wn);
				if (!winState) return _computeAggregateState(initState, reducers);
				return _computeWindowState(winState, reducers);
			};
			/** @type {any} */ (perWindowInit).__isStream = true;
			/** @type {any} */ (perWindowInit).__isLive = true;
			/** @type {any} */ (perWindowInit).__isAggregateWindow = true;
			/** @type {any} */ (perWindowInit).__streamTopic = outputTopic;
			/** @type {any} */ (perWindowInit).__streamOptions = { merge: 'set' };
			/** @type {any} */ (perWindowInit).__aggregateRoot = root;
			/** @type {any} */ (perWindowInit).__aggregateWindowName = wn;
			windowStreams[wn] = perWindowInit;
		}
		/** @type {any} */ (root).__windowStreams = windowStreams;

		return root;
	}

	// ---- Single-state form (existing behavior, untouched) ----
	const initFn = async function aggregateInit() {
		const entry = _aggregateByTopic.get(topic);
		if (entry) {
			// Wait for snapshot hydration to finish before returning state
			if (entry._hydrationPromise) await entry._hydrationPromise;
			return _computeAggregateState(entry.state, reducers);
		}
		return _computeAggregateState(initState, reducers);
	};

	/** @type {any} */ (initFn).__isAggregate = true;
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = { merge: 'set' };
	/** @type {any} */ (initFn).__aggregateSource = source;
	/** @type {any} */ (initFn).__aggregateReducers = reducers;
	/** @type {any} */ (initFn).__aggregateInitState = initState;
	/** @type {any} */ (initFn).__aggregateSnapshot = options?.snapshot || null;
	/** @type {any} */ (initFn).__aggregateDebounce = debounce;
	return initFn;
};

/**
 * Register an aggregate. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerAggregate(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'aggregate', path, loader: fn });
		_hasLazyReactive = true;
		return;
	}
	const windowsSpec = /** @type {any} */ (fn).__aggregateWindows;
	if (windowsSpec) {
		_registerWindowedAggregate(path, fn);
		return;
	}
	const source = /** @type {any} */ (fn).__aggregateSource;
	const reducers = /** @type {any} */ (fn).__aggregateReducers;
	const topic = /** @type {any} */ (fn).__streamTopic;
	const initState = /** @type {any} */ (fn).__aggregateInitState;
	const snapshot = /** @type {any} */ (fn).__aggregateSnapshot;
	const debounce = /** @type {any} */ (fn).__aggregateDebounce || 0;
	if (!source || !topic) return;
	const entry = { source, reducers, topic, state: { ...initState }, snapshot, debounce, timer: null, _reducerEntries: Object.entries(reducers), _hydrationPromise: null };

	if (snapshot) {
		entry._hydrationPromise = (async () => {
			try {
				const snapshotState = await snapshot();
				if (snapshotState && typeof snapshotState === 'object') {
					_safeAssignSnapshot(entry.state, snapshotState);
				}
			} catch {}
			entry._hydrationPromise = null;
		})();
	}

	aggregateRegistry.set(path, entry);
	_aggregateByTopic.set(topic, entry);
	let srcSet = _aggregateBySource.get(source);
	if (!srcSet) { srcSet = new Set(); _aggregateBySource.set(source, srcSet); }
	srcSet.add(entry);
	_watchedTopics.add(source);
	_maybeLateActivate();
}

/**
 * Register a windowed aggregate. Builds one entry that holds N window
 * states (`entry.windowStates: Map<windowName, winState>`), schedules
 * boundary timers (tumbling) and slide timers (sliding), and hydrates
 * each window from its optional per-window snapshot.
 *
 * @param {string} path
 * @param {Function} fn
 */
function _registerWindowedAggregate(path, fn) {
	const source = /** @type {any} */ (fn).__aggregateSource;
	const reducers = /** @type {any} */ (fn).__aggregateReducers;
	const baseTopic = /** @type {any} */ (fn).__aggregateBaseTopic;
	const initState = /** @type {any} */ (fn).__aggregateInitState;
	const snapshots = /** @type {any} */ (fn).__aggregateSnapshots || {};
	const legacySnapshot = /** @type {any} */ (fn).__aggregateSnapshot;
	const debounce = /** @type {any} */ (fn).__aggregateDebounce || 0;
	const windowsSpec = /** @type {any} */ (fn).__aggregateWindows;
	if (!source || !baseTopic || !windowsSpec) return;

	const _reducerEntries = Object.entries(reducers);
	/** @type {Map<string, any>} */
	const windowStates = new Map();
	const entry = {
		source,
		reducers,
		_reducerEntries,
		baseTopic,
		windowStates,
		debounce,
		_hydrationPromise: null,
		windowed: true
	};

	const now = runtimeNow();
	for (const [wn, spec] of Object.entries(windowsSpec)) {
		const outputTopic = `${baseTopic}:${wn}`;
		const winDebounce = (typeof spec.debounce === 'number' && spec.debounce >= 0) ? spec.debounce : debounce;
		if (spec.type === 'lifetime') {
			windowStates.set(wn, {
				type: 'lifetime', spec, name: wn, outputTopic,
				state: { ...initState },
				debounce: winDebounce, timer: null
			});
		} else if (spec.type === 'tumbling') {
			windowStates.set(wn, {
				type: 'tumbling', spec, name: wn, outputTopic,
				state: { ...initState },
				debounce: winDebounce, timer: null,
				boundaryTimer: null,
				nextBoundary: spec.period
					? _nextBoundaryForPeriod(now, spec.period, spec.tz || 'UTC')
					: _nextBoundaryForDuration(now, spec.durationMs, spec.anchor || 0)
			});
		} else if (spec.type === 'sliding') {
			const bucketCount = Math.ceil(spec.durationMs / spec.slideMs);
			const buckets = [];
			for (let i = 0; i < bucketCount; i++) {
				const b = {};
				for (const [field, r] of _reducerEntries) {
					if (r.init) b[field] = r.init();
				}
				buckets.push(b);
			}
			windowStates.set(wn, {
				type: 'sliding', spec, name: wn, outputTopic,
				buckets,
				bucketCount,
				bucketIndex: 0,
				debounce: winDebounce, timer: null,
				slideTimer: null
			});
		}
	}

	// Hydrate per-window snapshots in parallel. Lifetime can also be fed
	// by the legacy `snapshot` option for backwards compat with apps that
	// adopted windows by adding a single `lifetime` slot.
	const hydrationTasks = [];
	for (const [wn, win] of windowStates) {
		const perWindowSnap = snapshots[wn] || (wn === 'lifetime' ? legacySnapshot : null);
		if (!perWindowSnap || win.type === 'sliding') continue;
		hydrationTasks.push((async () => {
			try {
				const s = await perWindowSnap();
				if (s && typeof s === 'object') _safeAssignSnapshot(win.state, s);
			} catch {}
		})());
	}
	if (hydrationTasks.length > 0) {
		entry._hydrationPromise = Promise.all(hydrationTasks).then(() => { entry._hydrationPromise = null; });
	}

	aggregateRegistry.set(path, entry);
	_aggregateByTopic.set(baseTopic, entry);
	let srcSet = _aggregateBySource.get(source);
	if (!srcSet) { srcSet = new Set(); _aggregateBySource.set(source, srcSet); }
	srcSet.add(entry);
	_watchedTopics.add(source);
	_maybeLateActivate();

	// Schedule boundary / slide timers. Captured `entry` lets the timer
	// re-arm itself across multiple boundaries without re-registering.
	for (const win of windowStates.values()) {
		if (win.type === 'tumbling') {
			_scheduleNextBoundary(entry, win);
		} else if (win.type === 'sliding') {
			_scheduleNextSlide(entry, win);
		}
	}
}

/**
 * Arm the boundary timer for a tumbling window. On fire: publish the
 * closing-window final state, reset the per-reducer state via init(),
 * recompute the next boundary, and re-arm. Self-rearming so a window
 * keeps tumbling for the lifetime of the process.
 *
 * @param {any} entry
 * @param {any} win
 */
function _scheduleNextBoundary(entry, win) {
	const delay = Math.max(0, win.nextBoundary - runtimeNow());
	win.boundaryTimer = setTimer(() => {
		win.boundaryTimer = null;
		// Final publish of the closing window so subscribers see the
		// pre-reset state before the new window starts. If a debounce is
		// pending, flush it inline rather than letting the new state
		// race the published value.
		if (win.timer) {
			clearTimer(win.timer);
			win.timer = null;
		}
		_publishWindow(entry, win);
		// Reset state to init() for the new window.
		const fresh = {};
		for (const [field, r] of entry._reducerEntries) {
			if (r.init) fresh[field] = r.init();
		}
		win.state = fresh;
		// Compute the next boundary off the fired-at time, not the current
		// clock, so a slow/blocked event loop does not drift the schedule.
		const now = runtimeNow();
		win.nextBoundary = win.spec.period
			? _nextBoundaryForPeriod(now, win.spec.period, win.spec.tz || 'UTC')
			: _nextBoundaryForDuration(now, win.spec.durationMs, win.spec.anchor || 0);
		_scheduleNextBoundary(entry, win);
	}, delay);
	// Don't keep the event loop alive solely for cron-like tumbling --
	// matches the cron interval's implicit ref behavior; tests / clean
	// shutdown can still kill the timer via `_clearAggregateTimers`.
	if (typeof win.boundaryTimer.unref === 'function') win.boundaryTimer.unref();
}

/**
 * Arm the slide timer for a sliding window. On fire: rotate the ring
 * (advance bucketIndex; init() the new current bucket), publish the
 * post-slide state, re-arm. The publish on every slide is what gives
 * subscribers a smooth-decaying view rather than waiting for the next
 * event after the eviction.
 *
 * @param {any} entry
 * @param {any} win
 */
function _scheduleNextSlide(entry, win) {
	win.slideTimer = setTimer(() => {
		win.slideTimer = null;
		// Advance the ring head and clear the new current bucket.
		win.bucketIndex = (win.bucketIndex + 1) % win.bucketCount;
		const fresh = {};
		for (const [field, r] of entry._reducerEntries) {
			if (r.init) fresh[field] = r.init();
		}
		win.buckets[win.bucketIndex] = fresh;
		// Publish the post-slide combined state so a subscriber sees
		// values dropping out of the window even when no fresh events
		// are arriving.
		if (win.timer) {
			clearTimer(win.timer);
			win.timer = null;
		}
		_publishWindow(entry, win);
		_scheduleNextSlide(entry, win);
	}, win.spec.slideMs);
	if (typeof win.slideTimer.unref === 'function') win.slideTimer.unref();
}

/**
 * Compute and publish a window's current state to its output topic.
 * Honors `state.cronPlatform` first (the captured publish path used by cron
 * and by anything that runs outside an active connection), so boundary
 * and slide timers can publish without an active publish wrapping them.
 *
 * Plain reduce-on-event publishes go through the wrapped
 * `platform.publish` from the source-event handler - that path
 * captures `platform` directly and does not need this fallback.
 *
 * @param {any} entry
 * @param {any} win
 */
function _publishWindow(entry, win) {
	const platform = state.cronPlatform;
	if (!platform) return;
	const computed = _computeWindowState(win, entry.reducers);
	platform.publish(win.outputTopic, 'set', computed);
}

/**
 * Tear down all timers belonging to a windowed aggregate entry. Called
 * from HMR clear and tests.
 *
 * @param {any} entry
 */
function _clearAggregateTimers(entry) {
	if (!entry || !entry.windowStates) return;
	for (const win of entry.windowStates.values()) {
		if (win.timer) { clearTimer(win.timer); win.timer = null; }
		if (win.boundaryTimer) { clearTimer(win.boundaryTimer); win.boundaryTimer = null; }
		if (win.slideTimer) { clearTimer(win.slideTimer); win.slideTimer = null; }
	}
}

/**
 * Test-only helper. Clear every registered aggregate (windowed or
 * single-state) and the source-watch index. Tests that register
 * windowed aggregates should call this in their `afterEach` to prevent
 * boundary / slide timers from leaking across cases.
 */
export function _resetAggregates() {
	for (const e of aggregateRegistry.values()) {
		if (e.timer) clearTimer(e.timer);
		_clearAggregateTimers(e);
	}
	aggregateRegistry.clear();
	_aggregateByTopic.clear();
	for (const [src, set] of _aggregateBySource) {
		// Drop only aggregate entries; effects/derived may share the source.
		if (set.size === 0) {
			_aggregateBySource.delete(src);
			if (!_derivedBySource.has(src) && !_effectBySource.has(src)) {
				_watchedTopics.delete(src);
			}
		}
	}
	// Source-tracked watcher entries are entry-keyed; clearing the
	// registry above already orphaned them. Drop the source map wholesale
	// rather than iterating to keep this cheap and correct.
	_aggregateBySource.clear();
	if (_derivedBySource.size === 0 && _effectBySource.size === 0) {
		_watchedTopics.clear();
	}
}

/**
 * Conditional stream activation. Wraps a stream function with a predicate.
 * If the predicate returns false, responds with a gated (no-op) response.
 *
 * @param {(ctx: any, ...args: any[]) => boolean} predicate
 * @param {Function} fn - The stream function to wrap
 * @returns {Function}
 */
live.gate = function gate(predicate, fn) {
	const wrapper = async function gatedWrapper(ctx, ...args) {
		return fn(ctx, ...args);
	};

	_copyStreamMeta(wrapper, fn);
	/** @type {any} */ (wrapper).__isGated = true;
	/** @type {any} */ (wrapper).__gatePredicate = predicate;

	return wrapper;
};

/**
 * Wrap a live function with an authorization predicate. Throws when the
 * predicate returns false: UNAUTHENTICATED if `ctx.user` is null,
 * FORBIDDEN otherwise. Predicate may be sync or async.
 *
 * For STREAMS, prefer the `access` option on `live.stream({ access: ... })`
 * so the gate fires before subscribe-side bookkeeping. Use `live.scoped`
 * for RPC handlers, where there is no `access` option.
 *
 * Composes with `live.validated`, `live.rateLimit`, and other wrappers.
 *
 * @param {(ctx: any, ...args: any[]) => boolean | Promise<boolean>} predicate
 * @param {Function} fn - Live function to wrap
 * @returns {Function}
 *
 * @example
 * ```js
 * export const updateOrg = live.scoped(
 *   live.access.org({ from: (ctx, input) => input.orgId }),
 *   live.validated(schema, async (ctx, input) => updateOrg(input))
 * );
 * ```
 */
live.scoped = function scoped(predicate, fn) {
	if (typeof predicate !== 'function') {
		throw new Error('[svelte-realtime] live.scoped(predicate, fn) requires a predicate function');
	}
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.scoped(predicate, fn) requires a handler function');
	}
	const wrapper = async function scopedWrapper(ctx, ...args) {
		const ok = await predicate(ctx, ...args);
		if (!ok) {
			const code = ctx && ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
			throw new LiveError(code, code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied');
		}
		return fn(ctx, ...args);
	};
	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isScoped = true;
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	if (/** @type {any} */ (fn).__isStream) {
		_copyStreamMeta(wrapper, fn);
	}
	return wrapper;
};

/**
 * Compose stream transforms that apply to the initial data load. Each
 * transform's `transformInit(data, ctx)` runs once per subscription. For
 * per-event projection on live publishes, use the `transform` option on
 * `live.stream({ transform })` instead.
 *
 * @param {Function} stream - The stream function to wrap
 * @param {...{ transformInit?: Function }} transforms
 * @returns {Function}
 */
export function pipe(stream, ...transforms) {
	const wrapper = async function pipedWrapper(ctx, ...args) {
		let data = await stream(ctx, ...args);

		// Handle paginated responses
		let isPaginated = false;
		let paginationMeta = {};
		if (data && typeof data === 'object' && !Array.isArray(data) && 'data' in data && 'hasMore' in data) {
			isPaginated = true;
			paginationMeta = { hasMore: data.hasMore, cursor: data.cursor };
			data = data.data;
		}

		// Apply each transform to the initial data
		for (const t of transforms) {
			if (t.transformInit) {
				data = await t.transformInit(data, ctx);
			}
		}

		if (isPaginated) {
			return { data, ...paginationMeta };
		}
		return data;
	};

	_copyStreamMeta(wrapper, stream);

	return wrapper;
}

/**
 * Filter transform: removes items that don't match the predicate from
 * the INITIAL data only. For per-event projection on a live stream,
 * use the `transform` option on `live.stream({ transform })` - it
 * fires for both the initial load and every live publish.
 *
 * @param {(ctx: any, item: any) => boolean} predicate
 * @returns {{ transformInit: Function }}
 */
pipe.filter = function pipeFilter(predicate) {
	return {
		transformInit(data, ctx) {
			if (!Array.isArray(data)) return data;
			return data.filter(item => predicate(ctx, item));
		}
	};
};

/**
 * Sort transform: sorts initial data by a field.
 * @param {string} field
 * @param {'asc' | 'desc'} [direction]
 * @returns {{ transformInit: Function }}
 */
pipe.sort = function pipeSort(field, direction = 'asc') {
	return {
		transformInit(data) {
			if (!Array.isArray(data)) return data;
			return [...data].sort((a, b) => {
				const va = a[field], vb = b[field];
				if (va < vb) return direction === 'asc' ? -1 : 1;
				if (va > vb) return direction === 'asc' ? 1 : -1;
				return 0;
			});
		}
	};
};

/**
 * Limit transform: caps the number of initial data items.
 * @param {number} n
 * @returns {{ transformInit: Function }}
 */
pipe.limit = function pipeLimit(n) {
	return {
		transformInit(data) {
			if (!Array.isArray(data)) return data;
			return data.slice(0, n);
		}
	};
};

/**
 * Join transform: enriches each item by resolving a field via an async function.
 * @param {string} field - Field to look up
 * @param {(value: any) => Promise<any>} resolver - Async resolver
 * @param {string} as - Field name to attach the resolved value
 * @returns {{ transformInit: Function }}
 */
pipe.join = function pipeJoin(field, resolver, as) {
	return {
		async transformInit(data) {
			if (!Array.isArray(data)) return data;
			return Promise.all(data.map(async (item) => {
				const resolved = await resolver(item[field]);
				return { ...item, [as]: resolved };
			}));
		}
	};
};

/**
 * Create a collaborative room that bundles data stream, presence, cursors, and room-scoped RPC.
 *
 * @param {{ topic: (ctx: any, ...args: any[]) => string, init: (ctx: any, ...args: any[]) => Promise<any>, presence?: (ctx: any) => any, cursors?: boolean | { throttle?: number }, actions?: Record<string, Function>, guard?: Function, onJoin?: Function, onLeave?: Function, merge?: string, key?: string }} config
 * @returns {any}
 */

live.room = function room(config) {
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

live.multiplayer = function multiplayer(config) {
	const topicFn = config && config.topic;
	if (typeof topicFn !== 'function') {
		throw new Error(
			`[svelte-realtime] live.multiplayer() requires a topic function (ctx, ...args) => string\n  See: https://svti.me/multiplayer`
		);
	}

	// A presence field (typing / locks / selections) is stamped on a roster
	// entry, and a roster entry only exists once presence has been set. Without
	// a presence function there is no entry to carry the field, so the field
	// would publish but never persist for a late joiner. Reactions are exempt:
	// they ride their own ephemeral sub-topic and never touch the roster.
	if ((config.typing || config.locks || config.selections) && typeof config.presence !== 'function') {
		const declared = config.typing ? 'typing' : (config.locks ? 'locks' : 'selections');
		throw new Error(
			`[svelte-realtime] live.multiplayer() declares the '${declared}' presence field but has no presence function. Presence fields are stamped on a roster entry that only exists when presence is set, so add a presence function. Reactions do not require presence.\n  See: https://svti.me/multiplayer`
		);
	}

	// A multiplayer export is a room export with a marker stamped on top. It
	// reuses live.room's sub-stream construction verbatim so the data /
	// presence / cursor streams, the presence-ref auto-join, and the scoped
	// actions are byte-identical to a room. The codegen and the dev-direct
	// loader dispatch on __isRoom for the sub-streams; the __isMultiplayer
	// marker only adds the collaborative client surface.
	const roomExport = live.room({
		topic: topicFn,
		init: config.init ? config.init : async () => [],
		presence: config.presence,
		cursors: config.cursors,
		guard: config.guard,
		onJoin: config.onJoin,
		onLeave: config.onLeave,
		merge: config.merge,
		key: config.key,
		actions: config.actions,
		topicArgs: config.topicArgs,
		history: config.history
	});

	/** @type {any} */ (roomExport).__isMultiplayer = true;

	// Cursor send path. The client `move` / `reportViewport` methods are
	// volatile RPCs (fire-and-forget, lossy under disconnect is the contract)
	// that publish an `update` frame keyed by the caller's identity onto the
	// room's `:cursors` sub-topic - the same topic the cursor stream loads and
	// merges with `merge: 'cursor'`. The leading args identify the room (the
	// same count the topic function and room actions use); the trailing args
	// are the cursor payload, normalized to a flat object the cursor merge can
	// key by `.key`.
	const _cursorArgCount = config.topicArgs !== undefined
		? config.topicArgs
		: Math.max(0, topicFn.length - 1);

	/**
	 * @param {any} ctx
	 * @param {any[]} args
	 * @param {Record<string, any>} extra
	 */
	const _publishCursor = (ctx, args, extra) => {
		const roomArgs = args.slice(0, _cursorArgCount);
		const payload = args.slice(_cursorArgCount);
		const cursorTopic = _callTopicFn(topicFn, ctx, roomArgs) + ':cursors';
		const key = _getIdentityKey(ctx);
		const frame = { key, ...extra };
		const cur = payload[0];
		if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
			Object.assign(frame, cur);
		} else if (payload.length > 0) {
			frame.value = payload.length === 1 ? cur : payload;
		}
		ctx.publish(cursorTopic, 'update', frame);
	};

	const _cursorGuard = config.guard;
	/** @type {any} */ (roomExport).__cursorMove = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishCursor(ctx, args, {});
	});
	/** @type {any} */ (roomExport).__cursorReportViewport = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishCursor(ctx, args, { viewport: true });
	});

	// Presence-field send path. The typing / selection / lock surfaces are
	// presence fields: a caller publishes a delta keyed by its own identity onto
	// the room's `:presence` sub-topic, the same topic the presence stream loads
	// and merges with `merge: 'presence'`. The `update` event shallow-merges the
	// changed fields into the caller's roster entry, so every subscriber's roster
	// gains the new field value. The leading args identify the room (the same
	// count the topic function and cursor send path use); the trailing arg is a
	// flat `{ field: value }` delta object.
	//
	// Locks here are advisory presence locks: each caller stamps `lock:<key>` on
	// its own entry (the server keys the entry by the caller's identity, so the
	// holder is the entry owner), so a plain keyed publish is correct with no
	// arbitration - releasing clears the field, and a leave drops the entry so
	// derived holders recompute. This is awareness, not mutual exclusion.
	/**
	 * @param {any} ctx
	 * @param {any[]} args
	 */
	const _publishPresenceField = (ctx, args) => {
		const roomArgs = args.slice(0, _cursorArgCount);
		const delta = args[_cursorArgCount];
		const presenceTopic = _callTopicFn(topicFn, ctx, roomArgs) + ':presence';
		const key = _getIdentityKey(ctx);
		const frame = { key };
		if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
			Object.assign(frame, delta);
		}
		ctx.publish(presenceTopic, 'update', frame);
	};

	/** @type {any} */ (roomExport).__presenceUpdate = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishPresenceField(ctx, args);
		// Persist the sticky subset onto the roster after the forward publish so a
		// late joiner who loads the roster still sees it. selection (when
		// selections are enabled) and lock:<k> (when locks are enabled) are sticky;
		// typing and everything else stay ephemeral. Reactions ride a separate path.
		const delta = args[_cursorArgCount];
		if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
			const sticky = {};
			for (const k of Object.keys(delta)) {
				if (k === 'selection') { if (config.selections) sticky[k] = delta[k]; }
				else if (k.slice(0, 5) === 'lock:') { if (config.locks) sticky[k] = delta[k]; }
			}
			if (Object.keys(sticky).length > 0) {
				const dataTopic = _callTopicFn(topicFn, ctx, args.slice(0, _cursorArgCount));
				await _clusterPresenceMerge(ctx.platform, dataTopic, _getIdentityKey(ctx), sticky);
			}
		}
	});

	// Reactions are ephemeral events, not roster fields: a reaction is a one-off
	// emote (an emoji at a point), never a sticky value on a presence entry. It
	// rides a dedicated `:reactions` sub-topic as a bare `reaction` event so it
	// is consumed as a bounded, GC-after-render list rather than merged into the
	// roster. ctx.publish never coalesces, so a burst of taps all arrive.
	/**
	 * @param {any} ctx
	 * @param {any[]} args
	 */
	const _publishReaction = (ctx, args) => {
		const roomArgs = args.slice(0, _cursorArgCount);
		const payload = args.slice(_cursorArgCount);
		const reactionTopic = _callTopicFn(topicFn, ctx, roomArgs) + ':reactions';
		const key = _getIdentityKey(ctx);
		const frame = { key, token: payload[0] };
		const at = payload[1];
		if (at && typeof at === 'object' && !Array.isArray(at)) {
			Object.assign(frame, at);
		}
		ctx.publish(reactionTopic, 'reaction', frame);
	};

	/** @type {any} */ (roomExport).__reactionEmit = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishReaction(ctx, args);
	});

	// Reactions sub-stream: a bounded append-only ring (merge 'latest') on the
	// `:reactions` sub-topic. New subscribers start empty (a reaction is a live
	// event, never replayed from a roster), and the client GCs rendered taps so
	// a burst never grows unbounded.
	if (config.reactions) {
		/** @type {any} */ (roomExport).__reactionStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':reactions',
			async (ctx, ...args) => {
				if (_cursorGuard) await _cursorGuard(ctx, ...args);
				return [];
			},
			{ merge: 'latest' }
		);
	}

	// Record the declared field surfaces so the generated namespace knows which
	// methods and reactive views to wire. typing / selections / locks publish
	// onto the room's `:presence` topic; reactions ride the `:reactions` topic.
	/** @type {any} */ (roomExport).__fields = {
		typing: !!config.typing,
		locks: Array.isArray(config.locks) ? config.locks.slice() : (config.locks ? [] : null),
		reactions: !!config.reactions,
		selections: config.selections === 'crdt' ? 'crdt' : (config.selections ? 'offset' : null)
	};

	return roomExport;
};

installSmooth({ callTopicFn: _callTopicFn });

// live.smooth attaches to the exported live(); its machinery lives in
// src/server/smooth.js (loaded lazily). This thin wrapper keeps live.smooth on
// the factory while the registration body moved out.
live.smooth = function smooth(config) { return _smoothRegister(config); };

// `live.doc()` / `live.map()` / `live.array()` declare conflict-free shared
// documents: every client holds a local replica, every local edit applies
// immediately (no pending state), and concurrent edits from any number of
// peers merge to the same value on every replica without a transform step.
// The server keeps the authoritative replica per topic, answers each sync
// with exactly the structs the joiner lacks (a state-vector diff), fans
// inbound updates out to the other subscribers over the reserved CRDT wire
// topic, and schedules durable persistence through the app's `persist`
// hooks. The guard resolves to a per-document `{read, write, comment}`
// access record (a boolean return widens to all three rights); the record is
// cached per connection per document at sync time and every inbound update
// is checked against it.
//
// The heavy machinery (the replica authority, the wire codec, the topic
// prefix) lives in the adapter and is loaded lazily on first use, exactly
// like live.smooth: registration stays synchronous, apps that never declare
// a document never resolve the module (or its CRDT library), and the loader
// doubles as the version gate with an actionable error.

installCrdt({ callTopicFn: _callTopicFn });

/**
 * Declare a conflict-free shared document with named containers.
 *
 * The component constructs its replica from the same export and mutates it
 * directly: every read is local (renderable offline), every write applies
 * immediately and merges everywhere, reconnects and offline sessions
 * reconcile through one idempotent state-vector exchange.
 *
 * ```js
 * // $live/board.js
 * import { live } from 'svelte-realtime';
 *
 * export const board = live.doc({
 *   topic: (ctx, boardId) => `board:${boardId}`,
 *   guard({ user }) {
 *     const role = roleFor(user);
 *     return { read: role !== null, write: role === 'editor' || role === 'owner' };
 *   },
 *   persist: {
 *     load: (topic) => db.loadSnapshot(topic),
 *     store: (topic, bytes) => db.saveSnapshot(topic, bytes)
 *   }
 * });
 * ```
 *
 * Options: `topic` (string or `(ctx, ...args) => string`), `guard?` (returns
 * a boolean - widened to all rights - or a `{read, write, comment}` record;
 * `comment` is carried for the rich-text marks layer and grants nothing
 * extra yet), `persist?` (`load`/`store` hooks - the app owns the I/O, the
 * framework owns the schedule), `debounceWait?` (persist this long after the
 * last edit, default 2000ms), `debounceMaxWait?` (force a persist at least
 * this often under sustained editing, default 10000ms), `snapshotEvery?`
 * (compact every N updates, default 200), `persistOnEmpty?` (final store
 * when the last subscriber leaves, default true), `gc?` (default true),
 * `onError?` (persist I/O failure observer), `topicArgs?` (explicit room-arg
 * count when the topic function's arity cannot express it).
 *
 * @param {{ topic: string | Function, guard?: Function, persist?: { load?: Function, store?: Function }, debounceWait?: number, debounceMaxWait?: number, snapshotEvery?: number, persistOnEmpty?: boolean, gc?: boolean, onError?: Function, topicArgs?: number }} config
 */
live.doc = function doc(config) {
	return _crdtRegister('doc', config);
};

/**
 * Declare a conflict-free shared map: `live.doc` sugar whose component-side
 * store IS the keyed container (`live.map(t)` is `live.doc(t)`'s `'root'`
 * map). Same options as {@link live.doc}.
 * @param {{ topic: string | Function, guard?: Function, persist?: { load?: Function, store?: Function }, debounceWait?: number, debounceMaxWait?: number, snapshotEvery?: number, persistOnEmpty?: boolean, gc?: boolean, onError?: Function, topicArgs?: number }} config
 */
live.map = function map(config) {
	return _crdtRegister('map', config);
};

/**
 * Declare a conflict-free shared list: `live.doc` sugar whose component-side
 * store IS the ordered container (`live.array(t)` is `live.doc(t)`'s `'root'`
 * array). Same options as {@link live.doc}.
 * @param {{ topic: string | Function, guard?: Function, persist?: { load?: Function, store?: Function }, debounceWait?: number, debounceMaxWait?: number, snapshotEvery?: number, persistOnEmpty?: boolean, gc?: boolean, onError?: Function, topicArgs?: number }} config
 */
live.array = function array(config) {
	return _crdtRegister('array', config);
};

installAdmission(live);

installMetrics(live);

/**
 * Wrap a stream initFn call with a circuit breaker.
 * When the breaker is open, returns the fallback value or throws SERVICE_UNAVAILABLE.
 *
 * @param {{ breaker: any, fallback?: any }} options
 * @param {Function} fn - The stream initFn
 * @returns {Function}
 */
live.breaker = function breaker(options, fn) {
	const { breaker: cb, fallback } = options;
	const wrapper = async function breakerWrapper(ctx, ...args) {
		if (cb.isOpen && cb.isOpen()) {
			if (fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
			throw new LiveError('SERVICE_UNAVAILABLE', 'Service temporarily unavailable (circuit open)');
		}
		try {
			const result = await fn(ctx, ...args);
			if (cb.success) cb.success();
			return result;
		} catch (err) {
			if (cb.failure) cb.failure();
			throw err;
		}
	};
	_copyStreamMeta(wrapper, fn);
	return wrapper;
};

/**
 * Register a derived stream. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerDerived(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'derived', path, loader: fn });
		_hasDynamicDerived = true;
		_hasLazyReactive = true;
		return;
	}

	if (/** @type {any} */ (fn).__derivedDynamic) {
		const sourceFactory = /** @type {any} */ (fn).__derivedSourceFactory;
		const debounce = /** @type {any} */ (fn).__derivedDebounce || 0;

		/** @type {Map<string, any[]>} */
		const topicArgs = new Map();
		const topicFn = (...args) => {
			const t = path + '~' + args.map(a => String(a).replace(/~/g, '')).join('~');
			topicArgs.set(t, args);
			if (topicArgs.size > 10000) {
				const iter = topicArgs.keys();
				topicArgs.delete(iter.next().value);
			}
			return t;
		};
		/** @type {any} */ (topicFn).__topicUsesCtx = false;
		/** @type {any} */ (fn).__streamTopic = topicFn;
		/** @type {any} */ (fn).__derivedTopicArgs = topicArgs;

		const entry = {
			sources: null, sourceFactory, fn, topic: topicFn,
			debounce, timer: null, dynamic: true, instances: new Map()
		};
		derivedRegistry.set(path, entry);
		_dynamicDerivedByFn.set(fn, entry);
		_hasDynamicDerived = true;
		return;
	}

	/** @type {any} */ (fn).__streamTopic = path;
	const sources = /** @type {any} */ (fn).__derivedSources;
	const debounce = /** @type {any} */ (fn).__derivedDebounce || 0;
	if (!sources) return;
	derivedRegistry.set(path, { sources, fn, topic: path, debounce, timer: null });
	for (const src of sources) {
		let set = _derivedBySource.get(src);
		if (!set) { set = new Set(); _derivedBySource.set(src, set); }
		set.add(derivedRegistry.get(path));
		_watchedTopics.add(src);
	}
	_maybeLateActivate();
}

/**
 * Activate derived stream listeners. Call after platform is available.
 * Source topics are watched via a simple polling mechanism or should be
 * triggered externally when the platform fires publish.
 * @param {import('svelte-adapter-uws').Platform} platform
 */
installReactive({ cronLeader: _getCronLeader });

export function _activateDerived(platform) {
	state.derivedPlatform = platform;
	state.activateDerivedCalled = true;
	// Install the framework's publish wrap unconditionally. Pre-0.5.7 this
	// was gated on "any reactive primitives registered?" to avoid wrap
	// overhead on apps that didn't use derived/effect/aggregate. With the
	// wrap now also responsible for bus routing (every publish surface
	// consults `_getBus()` via `derivedPublish`), gating would create a
	// window where a publish escapes routing - the late-activation race
	// from the 0.5.6 audit. The per-publish overhead of an empty wrap is
	// one function call plus a `Map.has` check on an empty Map (`O(1)`,
	// branch-predicted to false); the install cost is one closure scope
	// per platform, paid once at init.
	_ensureWrap(platform);
}

installLazy({ registerCron: __registerCron, register: __register, registerDerived: __registerDerived, registerEffect: __registerEffect, registerWebhookOut: __registerWebhookOut, registerAggregate: __registerAggregate });

/**
 * Register room actions lazily. Called by the Vite-generated registry module
 * when a live.room() export needs its __actions registered.
 * @param {string} basePath
 * @param {Function} loader - Lazy loader that resolves to the room export
 */
export function __registerRoomActions(basePath, loader) {
	_lazyQueue.push({ type: 'room-actions', path: basePath, loader });
}

/**
 * Snapshot and clear all registries for HMR. Returns a snapshot that can be
 * passed to `_restoreHmr()` if the re-import fails, so old handlers survive
 * a syntax error in the edited file.
 * @returns {object}
 */
export function _prepareHmr() {
	const snap = {
		registry: new Map(registry),
		guards: new Map(guards),
		cron: new Map(cronRegistry),
		derived: new Map(derivedRegistry),
		effects: new Map(effectRegistry),
		aggregates: new Map(aggregateRegistry),
		smooth: new Map(_smoothTopics),
		hadCron: _cronTimerActive(),
	};

	// Clear debounce timers
	for (const e of derivedRegistry.values()) {
		if (e.timer) clearTimer(e.timer);
		if (e.instances) {
			for (const inst of e.instances.values()) { if (inst.timer) clearTimer(inst.timer); }
		}
	}
	for (const e of effectRegistry.values()) { if (e.timer) clearTimer(e.timer); }
	for (const e of aggregateRegistry.values()) {
		if (e.timer) clearTimer(e.timer);
		_clearAggregateTimers(e);
	}

	// Cancel armed smooth ticks. The records themselves travel in the
	// snapshot: a re-import registers fresh smooth exports whose first
	// sync/command rebuilds records against the edited apply/config, while a
	// failed re-import restores these and the next enqueue re-arms them.
	for (const rec of _smoothTopics.values()) {
		if (rec.timer !== null) clearTimer(rec.timer);
	}

	// Clear orphaned throttle/debounce timers to prevent stale platform.publish refs
	for (const [, entry] of _throttles) clearTimer(entry.timer);
	_throttles.clear();
	for (const [, timer] of _debounces) clearTimer(timer);
	_debounces.clear();

	// Clear cron timers (but keep state.cronPlatform - it stays valid across HMR)
	_clearCron();

	// Clear lazy queue and reset lazy init state
	_lazyQueue.length = 0;
	_resetLazy();

	// Clear all registries and lookup maps
	registry.clear();
	guards.clear();
	derivedRegistry.clear();
	effectRegistry.clear();
	aggregateRegistry.clear();
	_smoothTopics.clear();
	// The document records (_crdtDecls) deliberately survive HMR (they hold
	// unpersisted edits); only the per-load registration counter resets, so a
	// re-imported declaration re-attaches without tripping the
	// duplicate-topic warning.
	_crdtDeclRegistrations.clear();
	_derivedBySource.clear();
	_effectBySource.clear();
	_aggregateBySource.clear();
	_aggregateByTopic.clear();
	_watchedTopics.clear();
	// Drop the flag watcher index so `__registerFlag` reinstalls watchers on
	// the regenerated registry load. The value cells persist across HMR - the
	// flag's cluster-latest value should not reset when an unrelated module is
	// edited - and the reinstalled watcher rebinds to the surviving cell.
	_flagWatchers.clear();
	_streamsWithUnsubscribe.clear();
	_hasDynamicDerived = false;
	_hasLazyReactive = false;
	_dynamicDerivedByFn.clear();
	state.activateDerivedCalled = false;
	state.warnedActivateDerived = false;

	return snap;
}

/**
 * Restore registries from a snapshot produced by `_prepareHmr()`.
 * Called when re-import fails so the server keeps working with old handlers.
 * @param {object} snap
 */
export function _restoreHmr(snap) {
	for (const [k, v] of snap.registry) {
		registry.set(k, v);
		if (/** @type {any} */ (v).__isStream && /** @type {any} */ (v).__onUnsubscribe) {
			_streamsWithUnsubscribe.add(v);
		}
	}
	for (const [k, v] of snap.guards) guards.set(k, v);

	// Restore cron
	for (const [k, v] of snap.cron) cronRegistry.set(k, v);
	if (snap.hadCron && cronRegistry.size > 0) _ensureCronInterval();

	// Restore derived (rebuild source maps from entries)
	for (const [k, v] of snap.derived) {
		v.timer = null;
		derivedRegistry.set(k, v);
		if (v.dynamic) {
			_hasDynamicDerived = true;
			_dynamicDerivedByFn.set(v.fn, v);
			if (v.instances) {
				for (const inst of v.instances.values()) {
					inst.timer = null;
					for (const src of inst.resolvedSources) {
						let set = _derivedBySource.get(src);
						if (!set) { set = new Set(); _derivedBySource.set(src, set); }
						set.add(inst);
						_watchedTopics.add(src);
					}
				}
			}
		} else {
			for (const src of v.sources) {
				let set = _derivedBySource.get(src);
				if (!set) { set = new Set(); _derivedBySource.set(src, set); }
				set.add(v);
				_watchedTopics.add(src);
			}
		}
	}

	// Restore effects
	for (const [k, v] of snap.effects) {
		v.timer = null;
		effectRegistry.set(k, v);
		for (const src of v.sources) {
			let set = _effectBySource.get(src);
			if (!set) { set = new Set(); _effectBySource.set(src, set); }
			set.add(v);
			_watchedTopics.add(src);
		}
	}

	// Restore aggregates
	for (const [k, v] of snap.aggregates) {
		v.timer = null;
		aggregateRegistry.set(k, v);
		_aggregateByTopic.set(v.topic, v);
		let srcSet = _aggregateBySource.get(v.source);
		if (!srcSet) { srcSet = new Set(); _aggregateBySource.set(v.source, srcSet); }
		srcSet.add(v);
		_watchedTopics.add(v.source);
	}

	// Restore smooth topic records. Timers were cancelled in the snapshot
	// pass; nulling the handle here lets the next enqueue re-arm the tick.
	if (snap.smooth) {
		for (const [k, v] of snap.smooth) {
			v.timer = null;
			_smoothTopics.set(k, v);
		}
	}
}

/**
 * Create a webhook-to-stream bridge.
 *
 * Webhooks are server-only utilities; the Vite plugin marks them as known
 * exports (so they are not flagged as "not wrapped in live()") but does NOT
 * generate a SvelteKit `+server.js` endpoint. Wire one yourself by importing
 * the exported handler and calling its `.handle({ body, headers, platform })`
 * inside a POST handler. See README "Webhooks" for the canonical example.
 *
 * @param {string} topic - Topic to publish events to
 * @param {{ verify: (req: { body: string, headers: Record<string, string> }) => any, transform: (event: any) => { event: string, data: any } | null }} config
 * @returns {any}
 */
live.webhook = function webhook(topic, config) {
	const handler = {
		__isWebhook: true,
		__webhookTopic: topic,
		__verify: config.verify,
		__transform: config.transform,

		/**
		 * Handle an incoming webhook request.
		 * Call this from a SvelteKit +server.js POST handler.
		 *
		 * @param {{ body: string, headers: Record<string, string>, platform: any }} req
		 * @returns {{ status: number, body?: string }}
		 */
		async handle(req) {
			let event;
			try {
				event = await config.verify({ body: req.body, headers: req.headers });
			} catch {
				return { status: 400, body: 'Verification failed' };
			}

			const mapped = await config.transform(event);
			if (!mapped) return { status: 200, body: 'Ignored' };

			if (req.platform) {
				req.platform.publish(topic, mapped.event, mapped.data);
			}
			return { status: 200, body: 'OK' };
		}
	};

	return handler;
};

/**
 * Webhook namespace. `live.webhooks.inbound(topic, config)` is `live.webhook`
 * (bridge an external HTTP webhook into a topic). `live.webhooks.outbound(
 * sources, config)` fires an outbound HTTP webhook when any source topic
 * publishes: leader-gated (wire `configureCron({ leader })` for cluster dedup;
 * without a leader every worker fires, same as cron), retried with backoff,
 * optionally HMAC-signed, with an `idempotency-key` header so receivers can
 * dedup to effectively-once. The target URL is SSRF-checked (strict by default)
 * at definition time for a static url and again at fire time for a dynamic url.
 * Both directions are server-only; the flat `live.webhook` stays as a permanent
 * back-compat alias.
 */
live.webhooks = {
	inbound: live.webhook,
	outbound(sources, config) {
		if (!Array.isArray(sources) || sources.length === 0) {
			throw new Error('[svelte-realtime] live.webhooks.outbound: sources must be a non-empty array of topic names');
		}
		if (!config || (typeof config.url !== 'string' && typeof config.url !== 'function')) {
			throw new Error('[svelte-realtime] live.webhooks.outbound: config.url must be a string or a (event, data) => string function');
		}
		if (config.validateUrl !== undefined && typeof config.validateUrl !== 'function') {
			throw new Error('[svelte-realtime] live.webhooks.outbound: validateUrl must be a function');
		}
		if (config.resolve !== undefined && typeof config.resolve !== 'function') {
			throw new Error('[svelte-realtime] live.webhooks.outbound: resolve must be a function');
		}
		if (config.urlMode !== undefined && config.urlMode !== 'strict' && config.urlMode !== 'allowlist' && config.urlMode !== 'off') {
			throw new Error("[svelte-realtime] live.webhooks.outbound: urlMode must be 'strict', 'allowlist', or 'off'");
		}
		// Fail fast on a static url: the always-on scheme gate plus, in
		// strict/allowlist mode, the literal range floor are checked at definition
		// time so a misconfigured endpoint is caught at boot, not on the first
		// event. A custom validateUrl can only narrow the allowed set, so it is
		// not run here (it is awaited at fire time alongside the DNS-resolved
		// re-check); a static url that fails the floor is blocked regardless.
		if (typeof config.url === 'string') {
			const base = checkUrl(config.url, { mode: config.urlMode || 'strict', allow: config.allow });
			if (!base.safe) {
				throw new Error(
					`[svelte-realtime] live.webhooks.outbound: url "${_redactUrl(config.url)}" is blocked (${base.reason}) - it points inside the trust boundary or uses a non-http(s) scheme. ` +
					"Use urlMode: 'allowlist' with allow: [...] for a public host, or urlMode: 'off' with a validateUrl that allows exactly your endpoint to reach a private one."
				);
			}
		}
		return {
			__isWebhookOut: true,
			__webhookOutSources: sources,
			__webhookOutConfig: config
		};
	}
};

installUpload({ resolveAllLazy: _resolveAllLazy, resolveRegistryEntry: _resolveRegistryEntry, resolveGuard: _resolveGuard, runGuard: _runGuard, runWithMiddleware: _runWithMiddleware });

/**
 * Run global middleware chain, then call `handler`.
 * If no middleware is registered, calls handler directly (zero overhead).
 * @param {any} ctx
 * @param {() => Promise<any>} handler
 * @returns {Promise<any>}
 */
function _runWithMiddleware(ctx, handler) {
	if (_globalMiddleware.length === 0) return handler();

	let idx = 0;
	// Each frame creates its own one-shot `next()` closure. Calling `next`
	// twice from the same middleware would re-enter the chain and run the
	// downstream handler twice (double-charge customer, double-send email,
	// double-bump counter). This is a bug-causing-bug:
	// it only fires when a middleware author writes `next().then(() =>
	// next())`, but every release lands shoulder-to-shoulder with new
	// middleware that may exhibit the pattern. Throwing on the second call
	// gives a loud, actionable signal at the call site instead of a silent
	// duplicate side effect.
	function dispatch() {
		if (idx >= _globalMiddleware.length) return handler();
		const fn = _globalMiddleware[idx++];
		let called = false;
		const next = () => {
			if (called) {
				throw new Error(
					'middleware: next() called more than once. Each middleware must call ' +
					'next() at most once; calling it twice would re-enter the chain and ' +
					'run the downstream handler more than once.'
				);
			}
			called = true;
			return dispatch();
		};
		return fn(ctx, next);
	}
	return dispatch();
}

/**
 * Subscribe a WebSocket to its user's signal topic.
 * Call this in your `open` hook to enable `ctx.signal()` delivery.
 *
 * @param {any} ws - The WebSocket connection
 * @param {{ idField?: string }} [options] - Options (defaults to `ws.getUserData().id`)
 */
export function enableSignals(ws, options) {
	const idField = options?.idField || 'id';
	const userData = ws.getUserData();
	const userId = userData?.[idField];
	// null / undefined = anonymous connection, silently skip (no signal
	// subscription wired). This preserves the documented pattern of
	// calling `enableSignals(ws)` unconditionally in the open hook.
	if (userId === undefined || userId === null) return;
	const reason = _validUserIdReason(userId);
	if (reason !== null) {
		throw new Error('[svelte-realtime] enableSignals: ' + reason + '. The userData field "' + idField + '" must be a non-empty string safe to embed in a topic name (no control chars / CR / LF / NUL / quotes / backslash, max ' + _MAX_USER_ID_LENGTH + ' chars), or null / undefined for anonymous connections.');
	}
	ws.subscribe('__signal:' + userId);
}

/**
 * Handle a real-time topic unsubscribe event. Fires onUnsubscribe lifecycle
 * hooks for the stream function that owns the topic.
 *
 * The adapter 0.4.0 calls this when a client's topic reference count reaches zero.
 * Export from hooks.ws.js:
 * ```js
 * export { unsubscribe } from 'svelte-realtime/server';
 * ```
 *
 * @param {any} ws
 * @param {string} topic
 * @param {{ platform: import('svelte-adapter-uws').Platform }} ctx
 */
export function unsubscribe(ws, topic, { platform }) {
	const topicMap = _wsStreamOwners.get(ws);
	if (!topicMap) return;
	const owners = topicMap.get(topic);
	if (!owners || owners.length === 0) return;

	const user = ws.getUserData();
	const unsubCtx = { user, ws, platform, publish: _getCtxHelpers(platform).publish, cursor: null };

	// Compute remaining subscribers AFTER this ws fully drops the topic. The
	// hook fires N times (one per logical sub on this ws) and every firing
	// sees the same `remainingSubscribers` count - the count of OTHER
	// WebSockets still subscribed to this topic via realtime streams.
	const wsSet = _topicWsCounts.get(topic);
	let remainingSubscribers = 0;
	if (wsSet) {
		wsSet.delete(ws);
		remainingSubscribers = wsSet.size;
		if (wsSet.size === 0) {
			_topicWsCounts.delete(topic);
			_unregisterStaleWatch(topic);
			for (const entry of owners) _unregisterInvalidationWatch(topic, entry.fn);
			_disarmSilentTopicWatch(topic);
		}
	}

	// Drain every logical subscriber for this topic
	for (const entry of owners) {
		for (let i = 0; i < entry.count; i++) {
			if (state.metricsInstruments) state.metricsInstruments.streamGauge.dec();
			if (/** @type {any} */ (entry.fn).__onUnsubscribe) {
				Promise.resolve().then(() => /** @type {any} */ (entry.fn).__onUnsubscribe(unsubCtx, topic, remainingSubscribers)).catch(() => {});
			}
		}
	}
	topicMap.delete(topic);
	_unregisterCoalesce(ws, topic);
	_unregisterTransform(ws, topic);
	_unregisterVolatile(ws, topic);

	let fired = _firedUnsubscribes.get(ws);
	if (!fired) { fired = new Set(); _firedUnsubscribes.set(ws, fired); }
	fired.add(topic);
}

/** @type {WeakMap<object, Set<string>>} Topics whose hooks already fired via unsubscribe() */
const _firedUnsubscribes = new WeakMap();

/**
 * Handle a WebSocket close event. Fires onUnsubscribe lifecycle hooks
 * for any stream functions that define them.
 *
 * Call this from your `close` hook in hooks.ws.js:
 * ```js
 * export { close } from 'svelte-realtime/server';
 * ```
 *
 * @param {any} ws
 * @param {{ platform: import('svelte-adapter-uws').Platform }} ctx
 */
export function close(ws, { platform, subscriptions }) {
	// Mark the socket closed before any drain below runs: an in-flight smooth
	// sync/command handler awoken after this call re-checks the mark and bails
	// instead of re-creating an entity the drains can never clean up again.
	_smoothClosedWs.add(ws);
	// Same ghost guard for documents: an in-flight doc sync awoken after this
	// call must not acquire a replica reference no close can ever release.
	_crdtClosedWs.add(ws);

	const topicMap = _wsStreamOwners.get(ws);
	const alreadyFired = _firedUnsubscribes.get(ws);

	const user = ws.getUserData();
	const closeCtx = { user, ws, platform, publish: _getCtxHelpers(platform).publish, cursor: null };

	// Drain tracked stream subscriptions (from the RPC subscribe path)
	if (topicMap) {
		for (const [topic, owners] of topicMap) {
			_unregisterCoalesce(ws, topic);
			_unregisterTransform(ws, topic);
			_unregisterVolatile(ws, topic);
			// Account for this ws leaving the topic's ws-set so the
			// remainingSubscribers count handed to user hooks is accurate.
			const wsSet = _topicWsCounts.get(topic);
			let remainingSubscribers = 0;
			if (wsSet) {
				wsSet.delete(ws);
				remainingSubscribers = wsSet.size;
				if (wsSet.size === 0) {
					_topicWsCounts.delete(topic);
					_unregisterStaleWatch(topic);
					for (const entry of owners) _unregisterInvalidationWatch(topic, entry.fn);
					_disarmSilentTopicWatch(topic);
				}
			}
			if (alreadyFired && alreadyFired.has(topic)) continue;
			for (const entry of owners) {
				for (let i = 0; i < entry.count; i++) {
					if (state.metricsInstruments) state.metricsInstruments.streamGauge.dec();
					if (/** @type {any} */ (entry.fn).__onUnsubscribe) {
						Promise.resolve().then(() => /** @type {any} */ (entry.fn).__onUnsubscribe(closeCtx, topic, remainingSubscribers)).catch(() => {});
					}
				}
			}
		}
	}

	// Also check static-topic streams for manually subscribed topics not tracked via RPC
	const subscribedTopics = subscriptions || (typeof ws.getTopics === 'function' ? ws.getTopics() : null);
	if (subscribedTopics && _streamsWithUnsubscribe.size > 0) {
		const subSet = subscribedTopics instanceof Set ? subscribedTopics : new Set(subscribedTopics);
		for (const fn of [..._streamsWithUnsubscribe]) {
			const rawTopic = /** @type {any} */ (fn).__streamTopic;
			if (typeof rawTopic !== 'string') continue;
			if (!subSet.has(rawTopic)) continue;
			if (alreadyFired && alreadyFired.has(rawTopic)) continue;
			if (topicMap && topicMap.has(rawTopic)) continue; // already handled above
			// Static-topic streams that fell outside the tracked-RPC path:
			// the ws-set may not include them, so remaining defaults to 0.
			const staticWsSet = _topicWsCounts.get(rawTopic);
			const staticRemaining = staticWsSet ? staticWsSet.size : 0;
			Promise.resolve().then(() => /** @type {any} */ (fn).__onUnsubscribe(closeCtx, rawTopic, staticRemaining)).catch(() => {});
		}
	}

	_wsStreamOwners.delete(ws);
	_firedUnsubscribes.delete(ws);

	// Drain in-flight uploads so handlers exit cleanly on disconnect.
	_drainUploadsOnClose(ws);

	// Drain smoothed entities owned by this socket: departures broadcast to
	// the remaining subscribers and emptied topics drop their tick records.
	_drainSmoothOnClose(ws);

	// Release the document replica references this socket held: emptied
	// documents run their final persist-on-empty store and unload.
	_drainCrdtOnClose(ws);

	// Drain the push registry so a single `export { close }` re-export from
	// hooks.ws.js covers BOTH the stream-subscription cleanup that has
	// always lived here AND the per-userId push-registry cleanup that
	// previously required wiring `pushHooks.close` separately. Idempotent
	// against repeat calls - a second pass through finds the entry
	// already removed.
	const pushUserId = _wsToPushUserId.get(ws);
	if (pushUserId != null) {
		_wsToPushUserId.delete(ws);
		const pushEntry = _pushRegistry.get(pushUserId);
		// push-registry invariant: if userId was tracked in _wsToPushUserId,
		// the registry should still have an entry for that userId. Missing
		// entry means an external mutation cleared it.
		assert(pushEntry !== undefined, 'realtime/push-registry.entry-tracked', { userIdLen: pushUserId.length });
		if (pushEntry && pushEntry.ws === ws) _pushRegistry.delete(pushUserId);
	}
}

/**
 * Reset the one-shot dev-warn flag for tests. Production deployments
 * don't need this - the warning is meant to fire once per process and
 * the flag never needs resetting outside test isolation.
 */
export function _resetManualPlatformCallbackWarn() {
	state.manualPlatformCallbackWarnFired = false;
}

// ---------------------------------------------------------------------------
// Cluster wiring: process-wide bus + composed-platform accessors
// ---------------------------------------------------------------------------

/**
 * Configure the process-wide cluster bus. Consumed by every framework
 * publish surface in lockstep: RPC `ctx.publish` (via the `message` /
 * `createMessage` auto-wrap), cron tick publishes, reactive watchers'
 * publish wrap (`live.effect`, `live.derived`, `live.aggregate`,
 * `live.webhook`), and the top-level `publish()` helper. One
 * declaration of cluster intent covers all of them.
 *
 * Pass a bus exposing `.wrap(platform)` (e.g. `redisBus()` from
 * `svelte-adapter-uws-extensions/redis/pubsub`) to enable cluster
 * fan-out. Pass `null` to clear and revert to single-replica behaviour.
 *
 * `configureCron({ bus })` is equivalent to `setBus(bus)` for the bus
 * field - they write the same backing state. Pick whichever reads more
 * naturally at the call site; the typical app uses
 * `realtime({ bus, leader })` instead and never calls either directly.
 *
 * @param {{ wrap: (platform: any) => any } | null} bus
 *
 * @example
 * ```js
 * // hooks.ws.js (Layer 1 / expert wiring)
 * import { setBus, setCronPlatform, _activateDerived, configureCron, message } from 'svelte-realtime/server';
 * import { redisBus, redisLeader } from 'svelte-adapter-uws-extensions/redis';
 *
 * const bus = redisBus();
 * setBus(bus);
 * configureCron({ leader: redisLeader() });
 *
 * export { message };
 * export function init({ platform }) {
 *   setCronPlatform(platform);
 *   _activateDerived(platform);
 * }
 * ```
 */
export function setBus(bus) {
	_setBus(bus);
}

/**
 * Read the process-wide bus, or `null` when none is configured. Useful
 * for diagnostics, conditional cluster-only wiring, and tests.
 *
 * @returns {{ wrap: (platform: any) => any } | null}
 */
export function getBus() {
	return _getBus();
}

/**
 * Read the framework-owned composed platform - the same reference handed
 * to every `live.effect` / `live.derived` / `live.aggregate` handler and
 * threaded through `ctx.platform` in RPC / cron / webhook contexts.
 *
 * Returns `null` before `setCronPlatform(platform)` /
 * `_activateDerived(platform)` / `realtime().init({ platform })` has
 * captured the adapter platform on this worker.
 *
 * Use for publish from outside a framework handler (e.g. a `+server.js`
 * HTTP handler) when you want the same cluster semantics. Most callers
 * should reach for the top-level `publish()` helper instead.
 *
 * @returns {import('svelte-adapter-uws').Platform | null}
 */
export function getPlatform() {
	return state.derivedPlatform || state.cronPlatform || null;
}

/**
 * Publish from outside a framework handler. Routes through the
 * framework-owned composed platform, so the same publish reaches every
 * local subscriber, fires every reactive watcher (`live.effect`,
 * `live.derived`, `live.aggregate`), and relays to other cluster
 * instances when a bus is wired - identical semantics to a publish
 * inside an RPC, cron, or effect handler.
 *
 * Throws when the platform has not yet been captured (called before
 * the adapter's `init({ platform })` hook fires, or in a process where
 * no svelte-realtime wiring ran). For the rare case where you genuinely
 * want a no-op when the platform is absent (e.g. a shared utility
 * that may run in non-realtime contexts), guard with `getPlatform()`.
 *
 * @param {string} topic
 * @param {string} event
 * @param {unknown} data
 * @param {unknown} [options]
 *
 * @example
 * ```js
 * // src/routes/webhooks/+server.js
 * import { publish } from 'svelte-realtime/server';
 *
 * export async function POST({ request }) {
 *   const payload = await request.json();
 *   publish('audit', 'webhook', payload);
 *   return new Response();
 * }
 * ```
 */
export function publish(topic, event, data, options) {
	const platform = getPlatform();
	if (!platform) {
		throw new Error('[svelte-realtime] publish: platform has not been captured yet. Wire `realtime({ ... }).init` (or `setCronPlatform` + `_activateDerived`) from your hooks.ws.js init({ platform }) hook before calling publish() at module scope.');
	}
	return platform.publish(topic, event, data, options);
}

// ---------------------------------------------------------------------------
// realtime() - Layer 2 convenience factory
// ---------------------------------------------------------------------------

/**
 * One-call setup that wires every framework seam from a single
 * declaration of cluster intent. Returns the standard adapter hook
 * set (`open`, `close`, `message`, `init`) plus optional `upgrade`,
 * so `hooks.ws.js` is a one-import-one-destructure file:
 *
 * ```js
 * // src/hooks.ws.js (single-replica)
 * import { realtime } from 'svelte-realtime/server';
 * export const { upgrade, open, close, message, init } = realtime({
 *   upgrade: ({ cookies }) => validate(cookies),
 * });
 * ```
 *
 * ```js
 * // src/hooks.ws.js (cluster)
 * import { realtime } from 'svelte-realtime/server';
 * import { redisBus, redisLeader } from 'svelte-adapter-uws-extensions/redis';
 *
 * export const { upgrade, open, close, message, init } = realtime({
 *   bus: redisBus(),
 *   leader: redisLeader().isLeader,
 *   upgrade: ({ cookies }) => validate(cookies),
 * });
 * ```
 *
 * Handler-level code (`live.rpc`, `live.effect`, `live.derived`,
 * `live.aggregate`, `live.cron`, `live.webhook`, ...) is byte-identical
 * between the two modes - the only difference between single-replica
 * and cluster is whether `bus` and `leader` are passed at the top.
 *
 * `realtime()` is sugar over the existing primitives. Internally it
 * calls `setBus(bus)`, `configureCron({ leader })`,
 * `setCronPlatform(platform)`, and `_activateDerived(platform)` in the
 * right order when the adapter's `init` hook fires. Mixing `realtime()`
 * with direct calls to those primitives is supported - the primitives
 * remain first-class and write the same backing state.
 *
 * @param {{
 *   bus?: { wrap: (platform: any) => any } | null,
 *   leader?: (() => boolean) | null,
 *   upgrade?: (...args: any[]) => any,
 *   onError?: (path: string, error: unknown) => void,
 * }} [config]
 */
export function realtime(config) {
	const cfg = config || {};
	const { bus, leader, upgrade: upgradeFn, onError } = cfg;

	if (bus !== undefined) _setBus(bus);
	if (leader !== undefined) configureCron({ leader });
	if (typeof onError === 'function') {
		// Routes through the existing module-level setter so the
		// behaviour matches a direct `onError(handler)` call - one
		// source of truth for the cron / effect / derived error path.
		state.serverErrorHandler = onError;
	}

	const hooks = {
		open: pushHooks.open,
		close: pushHooks.close,
		message,
		init(ctx) {
			if (!ctx || !ctx.platform) {
				throw new Error('[svelte-realtime] realtime().init: missing platform on hook context (expected adapter init({ platform }) signature)');
			}
			setCronPlatform(ctx.platform);
			_activateDerived(ctx.platform);
		},
	};
	if (typeof upgradeFn === 'function') /** @type {any} */ (hooks).upgrade = upgradeFn;
	return hooks;
}
