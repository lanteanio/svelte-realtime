// @ts-check
import { assert, fatal, wireAssertionMetrics } from './shared/assert.js';
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
import { LiveError } from './server/live-error.js';
import { _runtimeRandom, _localHlc } from './server/runtime-fallbacks.js';
import { _validPathRe, _validSegmentRe, _validUserIdReason, _MAX_USER_ID_LENGTH, _DEFAULT_MAX_ENVELOPE_DEPTH, exceedsEnvelopeDepth } from './server/validate.js';
import { createPiiRedactor } from './server/pii-redact.js';
import {
	state,
	registry,
	guards,
	_topicWsCounts,
	_topicStaleWatch,
	_silentTopicWatch,
	_topicCoalesce,
	_topicTransform,
	_topicRedact,
	_declaredRedact,
	_declaredRedactPattern,
	_declaredStreamTopic,
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
	_webhookOutById,
	_aggregateBySource,
	_aggregateByTopic,
	_watchedTopics,
	_dynamicDerivedByFn
} from './server/state.js';
import { _IS_DEV } from './server/env.js';
import { _presenceRefForTest, _clusterPresenceAcquire, _clusterPresenceRelease, _clusterPresenceList, _clusterPresenceMerge } from './server/presence.js';
import { _setTenantResolver, _resolveTenant, _validTenantId, _tenantConfigRegistry, _makeTenantScope } from './server/tenant.js';
import { _parseCron, _cronDateParts, _cronFieldMatch } from './server/cron.js';
import { _throttles, _debounces, _throttlePublish, _debouncePublish, _skipGate, _checkPublishHelperArgs, _redactOrDrop, REDACT_DROP } from './server/publish-helpers.js';
import { _gateAggregate } from './server/differential-privacy.js';
import { _resolveHistoryConfig, _createHistoryStore, _freezeSnapshot, _compensateUnavailable } from './server/history-compensation.js';
import { WRAPPED_FOR_REPLAY, _resetReplayRouting, _registerReplayTopic, _maybeReplayPublish } from './server/replay-routing.js';
import { _recordRpcMetrics, installMetrics } from './server/metrics.js';
import { _shouldShed, _resetAdmission, installAdmission } from './server/admission.js';
import { _getIdentityKey, _getAuthenticatedId } from './server/identity.js';
import { _resetIdempotencyStore, _resetLock, installIdempotency } from './server/idempotency.js';
import { installPush, pushHooks, _resetPushRegistry, _pushRegistry, _wsToPushUserId, _deregisterPushSession } from './server/push.js';
import { installRateLimit, _consumeRateLimitBucket, _resolveRegistryRateLimit, _rateLimitConfig } from './server/rate-limit.js';
export { _resetRateLimits } from './server/rate-limit.js';
import { _setBus, _getBus } from './server/bus.js';
import { _getCtxHelpers, _buildCtx, installCtx } from './server/ctx.js';
import { _ensureWrap, _maybeLateActivate, _activateDynamicDerived, _deactivateDynamicDerived, _computeAggregateState, _computeWindowState, installReactive } from './server/reactive.js';
import { _crdtLoadError, _setCrdtRuntime, _resetCrdt, _crdtRegister, _drainCrdtOnClose, _crdtClosedWs, _crdtDeclRegistrations, installCrdt } from './server/crdt.js';
import { _smoothLoadError, _setSmoothRuntime, _resetSmooth, _setSmoothSpecifierForTest, _smoothRegister, _drainSmoothOnClose, _smoothTopics, _smoothClosedWs, installSmooth } from './server/smooth.js';
import { _resolveAllLazy, _isLazyResolved, _resetLazy, installLazy } from './server/lazy.js';
import { __registerCron, setCronPlatform, configureCron, _clearCron, _tickCron, onCronError, _ensureCronInterval, _getCronLeader, _cronTimerActive, _stopCronScheduler } from './server/cron-engine.js';
export { __registerCron, setCronPlatform, configureCron, _clearCron, _tickCron, onCronError };
import { configureAlarm, _resetAlarms } from './server/alarm.js';
export { configureAlarm, _resetAlarms };
import { configureForget, _resetForget, installForget } from './server/forget.js';
export { configureForget, _resetForget };
import { onShutdown, _runShutdown, _installLifecycle, _resetLifecycle, _isShuttingDown } from './server/lifecycle.js';
export { onShutdown, _resetLifecycle };
import { introspect } from './server/introspect.js';
export { introspect };
import { _createAdminHandler } from './server/admin.js';
// Bind framework-internal background teardown (cron scheduler + stale-reload
// watchdogs) into the graceful-shutdown drain. One-way: lifecycle never imports
// cron-engine / server.js, so this avoids an import cycle.
_installLifecycle(_stopBackgroundWork);
export { _smoothLoadError, _setSmoothRuntime, _resetSmooth, _setSmoothSpecifierForTest };
import { _armSilentTopicWatch, _disarmSilentTopicWatch, _resetSilentTopicWarning, _activatePublishRateWarning, _resetPublishRateWarning, installDevWarnings } from './server/dev-warnings.js';
import { _drainUploadsOnClose, _resetUploadAutoDiscovery, installUpload } from './server/upload.js';
import { _breakerRegister, installBreaker } from './server/breaker.js';
import { _webhookRegister, _webhooksOutboundRegister, configureWebhooks, getDeadLetter, replayDeadLetter } from './server/webhooks.js';
import { createDeadLetterStore } from './server/dead-letter.js';
export { configureWebhooks, getDeadLetter, replayDeadLetter, createDeadLetterStore };
import { _multiplayerRegister, installMultiplayer } from './server/multiplayer.js';
import { _roomRegister, installRoom } from './server/room.js';
import { _flagRegister, _derivedRegister, _effectRegister, _aggregateRegister, installReactiveFamilies } from './server/reactive-families.js';
import { handleRpc, _runGuard, guard, __directCall, message, createMessage, installDispatch } from './server/dispatch.js';
export { handleRpc, guard, __directCall, message, createMessage };
installDispatch({ isLazyResolved: _isLazyResolved, trackStreamSub: _trackStreamSub, rollbackStreamSubscribe: _rollbackStreamSubscribe, registerStaleWatch: _registerStaleWatch, registerInvalidationWatch: _registerInvalidationWatch, resolveRegistryEntry: _resolveRegistryEntry, resolveGuard: _resolveGuard, resolveAllLazy: _resolveAllLazy, runWithMiddleware: _runWithMiddleware, validate: _validate, callTopicFn: _callTopicFn, applyInitTransform: _applyInitTransform });
export { _resetUploadAutoDiscovery };
export { _armSilentTopicWatch, _resetSilentTopicWarning, _activatePublishRateWarning, _resetPublishRateWarning };
export { _crdtLoadError, _setCrdtRuntime, _resetCrdt };
export { pushHooks, _resetPushRegistry };
export { _resetIdempotencyStore, _resetLock };
export { _getIdentityKey, _getAuthenticatedId };
export { _resetAdmission };
export { WRAPPED_FOR_REPLAY, _resetReplayRouting };
export { assert, fatal, setFatalSink, resetFatalSink, getAssertionCounters, _resetAssertCounters } from './shared/assert.js';
export { colorForKey, hueForKey } from './shared/color.js';
import { createShortCode, fnv1a32 } from './shared/short-code.js';
export { LiveError };
export { _presenceRefForTest, _clusterPresenceAcquire, _clusterPresenceList, _clusterPresenceMerge };

// The deterministic shared RNG the smooth simulation seeds per command, re-exported
// so app/game code can draw the same reproducible randomness outside `apply` (world
// generation, spawns, deterministic tests) without importing the adapter subpath.
export { createSharedRandom } from 'svelte-adapter-uws/plugins/smooth/random';

/** One-time dev warning when shortCodes() runs without a configured secret. */
let _shortCodesSecretWarned = false;

/**
 * Mint unguessable, sequential-free short codes from a monotonic counter - the
 * companion to room enumeration for join-by-code and share-link rooms. An app
 * that keys rooms by a sequential id hands out `codes.encode(id)` as the public
 * code and recovers the id with `codes.decode(code)`, so a scanner cannot walk
 * the id space (`?room=1`, `?room=2`, ...) to find or address rooms it was not
 * given a code for. Bijective (collision-free, no lookup table), reversible with
 * your secret, and deterministic across replicas.
 *
 * Pair it with a room `guard`: a code is a hard-to-guess handle, not proof of
 * authorization - `decode` is total over the code space, so validate the
 * decoded id against your store exactly as you would any client-supplied id.
 *
 * @param {{ secret?: string, length?: number, rounds?: number }} [config]
 *   - `secret`: the operator key. STRONGLY recommended: it makes codes stable
 *     across restarts and identical across cluster instances, and it is what
 *     makes the codes unguessable. Without it a per-process random key is used
 *     (fine for a single dev instance; codes then change on restart and differ
 *     per instance) and a one-time dev warning fires.
 *   - `length`: code length in Base62 chars (fixed, zero-padded). Default 6
 *     (~56.8 billion codes); max 8.
 *   - `rounds`: Feistel rounds. Default 4.
 * @returns {{ encode: (n: number) => string, decode: (code: string) => number | null, length: number, space: number }}
 */
export function shortCodes(config) {
	const cfg = config || {};
	let seed;
	if (typeof cfg.secret === 'string' && cfg.secret.length > 0) {
		seed = fnv1a32(cfg.secret);
	} else {
		if (cfg.secret !== undefined && cfg.secret !== null) {
			throw new Error('[svelte-realtime] shortCodes({ secret }): must be a non-empty string');
		}
		seed = randomU32();
		if (_IS_DEV && !_shortCodesSecretWarned) {
			_shortCodesSecretWarned = true;
			console.warn(
				'[svelte-realtime] shortCodes() called without a secret: using a per-process random key.\n' +
				'  Codes will change on restart and differ across cluster instances until you set one.\n' +
				'  Pass a stable operator secret:  shortCodes({ secret: process.env.CODE_SECRET })\n' +
				'  See: https://svti.me/short-codes'
			);
		}
	}
	return createShortCode({ length: cfg.length, seed, rounds: cfg.rounds });
}

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
	if (source.__deprecated) target.__deprecated = source.__deprecated;
	target.__streamTopic = source.__streamTopic;
	target.__streamOptions = source.__streamOptions;
	if (source.__replay) target.__replay = source.__replay;
	if (source.__delta) target.__delta = source.__delta;
	if (source.__onSubscribe) target.__onSubscribe = source.__onSubscribe;
	if (source.__onUnsubscribe) target.__onUnsubscribe = source.__onUnsubscribe;
	if (source.__streamFilter) target.__streamFilter = source.__streamFilter;
	if (source.__streamArgs) target.__streamArgs = source.__streamArgs;
	if (source.__streamTransform) target.__streamTransform = source.__streamTransform;
	if (source.__streamPiiRedact) target.__streamPiiRedact = source.__streamPiiRedact;
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

/** Per-ws set of topics where this ws has contributed a redact refcount.
 *  Mirrors _wsTransformContrib so the unregister side is idempotent + ws-aware. */
const _wsRedactContrib = new WeakMap();

function _registerRedact(ws, topic, redact, onError) {
	let entry = _topicRedact.get(topic);
	if (!entry) {
		entry = { redact, onError: onError || null, refcount: 0 };
		_topicRedact.set(topic, entry);
	}
	entry.refcount++;
	let contrib = _wsRedactContrib.get(ws);
	if (!contrib) { contrib = new Set(); _wsRedactContrib.set(ws, contrib); }
	contrib.add(topic);
}

function _unregisterRedact(ws, topic) {
	const contrib = _wsRedactContrib.get(ws);
	if (!contrib || !contrib.has(topic)) return;
	contrib.delete(topic);
	const entry = _topicRedact.get(topic);
	if (!entry) return;
	entry.refcount--;
	if (entry.refcount <= 0) _topicRedact.delete(topic);
}

/**
 * Reset the per-topic redact registry. Tests only.
 * @internal
 */
export function _resetRedactRegistry() {
	_topicRedact.clear();
	_declaredRedact.clear();
	_declaredRedactPattern.clear();
	_declaredStreamTopic.clear();
	_redactPatternWarned.clear();
}

/** One-shot dedup for the same-pattern differing-redactor collision warning (keyed by pattern). */
const _redactPatternWarned = new Set();

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
	// Graceful shutdown: skip the publish-triggered reload during a drain
	// (an uncounted background loader run; the socket is about to close).
	if (_isShuttingDown()) return;
	if (watcher.reloading) return;
	watcher.reloading = true;
	try {
		const result = await watcher.fn(watcher.ctx, ...watcher.args);
		const initTransform = /** @type {any} */ (watcher.fn).__streamTransform;
		let finalData = (initTransform && result != null) ? _applyInitTransform(initTransform, result) : result;
		const redactor = /** @type {any} */ (watcher.fn).__streamPiiRedact;
		if (redactor && finalData != null) {
			// Fail-closed: a throwing redactor must never broadcast un-redacted
			// reload data, so skip the publish entirely.
			try { finalData = redactor(finalData); } catch { return; }
		}
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
	// Graceful shutdown: do not run the loader or re-arm the timer during a
	// drain. The reload is an uncounted background refresh to about-to-close
	// subscribers, and re-arming would schedule work past the gate.
	if (_isShuttingDown()) return;
	const entry = _topicStaleWatch.get(topic);
	if (!entry) return;
	if (entry.reloading) return;
	entry.reloading = true;
	try {
		const result = await entry.fn(entry.ctx, ...entry.args);
		const initTransform = /** @type {any} */ (entry.fn).__streamTransform;
		let finalData = (initTransform && result != null) ? _applyInitTransform(initTransform, result) : result;
		const redactor = /** @type {any} */ (entry.fn).__streamPiiRedact;
		if (redactor && finalData != null) {
			// Fail-closed (see _invalidationReload): never broadcast un-redacted
			// reload data; skip the publish on a redactor throw.
			try { finalData = redactor(finalData); } catch { return; }
		}
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
 * Stop framework-internal background timers for graceful shutdown: the cron
 * scheduler and the per-topic stale-reload watchdogs. New cron ticks, stale
 * reloads, and invalidation reloads also short-circuit via `_isShuttingDown()`;
 * clearing the stale timers here stops a pending one-shot from firing during
 * the drain window. Wired into the shutdown drain via `_installLifecycle`.
 */
function _stopBackgroundWork() {
	_stopCronScheduler();
	for (const entry of _topicStaleWatch.values()) clearTimer(entry.timerId);
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
	if (isFirstSubForTopic && /** @type {any} */ (fn).__streamPiiRedact) {
		_registerRedact(
			ws,
			topic,
			/** @type {any} */ (fn).__streamPiiRedact,
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
					_unregisterRedact(ws, topic);
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
			// this ws+topic, the wsSet must have tracked this ws. Every path that
			// mutates this index pair (subscribe, rollback, unsubscribe, close)
			// updates the forward owner map and the reverse ws-set together and
			// synchronously, so a mismatch here is not a transient race but a
			// genuine divergence (a missed update or memory corruption) after which
			// delivery on this worker can no longer be trusted. Fail closed:
			// terminate so the supervisor restarts from a clean index instead of
			// silently mis-routing publishes.
			fatal(wsSet.has(ws), 'realtime/subscription.bookkeeping.ws-was-tracked', { topic, wsSetSize: wsSet.size });
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

/** One topic segment for a dynamic-redact pattern placeholder: any run that does not cross the `/` or `:` separators. */
const _REDACT_SEGMENT = '[^/:]+';

/**
 * Compile a derived topic pattern (`chat/{arg0}`, produced by
 * `_deriveTopicPattern` from a factory topic) into a matcher for the
 * dynamic-topic redactor registry. Each run of `{argN}` placeholders becomes a
 * single segment matcher; the literal parts are escaped and the whole is anchored.
 *
 * Returns `null` (the stream gets no cluster-transient coverage - a documented
 * residual, never a leak into OTHER streams) when the matcher would be
 * dangerously broad:
 * - `<dynamic>` - the factory threw on placeholder args (e.g. it reads a ctx
 *   property); it cannot be derived to a literal skeleton.
 * - no `{argN}` placeholder - a constant-returning factory, not a real pattern.
 * - NO leading literal prefix (the pattern starts with a placeholder, e.g.
 *   `{arg1}:{arg2}` from `(ctx, id, kind) => id + ':' + kind`). Its regex would
 *   be `^.+<sep>.+$`, which matches nearly every topic and would redact - or,
 *   with a throwing custom redactor, drop the publishes of - UNRELATED streams
 *   app-wide. A leaked frame for the intended stream is far less harmful than
 *   corrupting every co-located stream, so a variable-first topic is skipped.
 *   Idiomatic dynamic topics carry a namespace prefix (`chat:`, `room/`), which
 *   both anchors the matcher to the stream's own topic space and gives the
 *   publish hot path a `startsWith` short-circuit.
 *
 * Each placeholder matches ONE topic SEGMENT (`[^/:]+`, excluding the `/` and
 * `:` separators), not `.+`. A greedy `.+` would cross separators and match a
 * NESTED co-located topic: `chat/{room}` -> `^chat/.+$` would swallow a
 * non-redact `chat/typing/5`; segment-bounding (`^chat/[^/:]+$`) excludes that
 * multi-segment neighbour. It does NOT, however, exclude a FLAT single-segment
 * neighbour: `chat/typing` still matches `^chat/[^/:]+$`. That collateral is
 * prevented not by the regex but by the resolver: `_matchRedactPattern` skips
 * any topic another stream/channel declared explicitly (the OWNERSHIP guard over
 * `_declaredStreamTopic`), and a pattern match is FAIL-OPEN, so even an
 * UNDECLARED co-located publish is passed through raw (not dropped) when the
 * redactor throws on its foreign shape. So the regex bounds the match to one
 * segment; the resolver guarantees a matched-but-foreign topic is never
 * corrupted or dropped.
 *
 * Residuals (documented, narrow): (a) if a resolved id itself contains `/` or
 * `:` (`chat/a/b`), the never-subscribed cluster-transient publish to it is not
 * matched - its OWN PII, not a neighbour's, and the subscribe-time exact entry
 * still covers it once subscribed; (b) an UNDECLARED ad-hoc publish to a topic
 * in the pattern's namespace under a fields redactor has that field omitted
 * (non-destructive - the message is still delivered); (c) separators other than
 * `/` and `:` (e.g. `-`) are not segment boundaries, so a `chat-{room}` factory
 * beside a `chat-typing-5` topic relies on the ownership guard / fail-open, not
 * the regex, if that neighbour is declared / throws.
 *
 * Adjacent placeholders collapse to one segment so the regex never contains a
 * quadratic `[^/:]+[^/:]+` (a long non-matching topic would otherwise burn CPU
 * on the publish path).
 *
 * @param {string} pattern
 * @returns {{ regex: RegExp, prefix: string } | null}
 */
function _compileRedactPattern(pattern) {
	if (pattern === '<dynamic>') return null;
	const firstPlaceholder = pattern.search(/\{arg\d+\}/);
	if (firstPlaceholder === -1) return null;   // no placeholder -> not a dynamic pattern
	if (firstPlaceholder === 0) return null;    // no leading literal anchor -> would over-match app-wide
	const prefix = pattern.slice(0, firstPlaceholder);
	let body = '';
	for (const tok of pattern.split(/(\{arg\d+\})/)) {
		if (tok === '') continue;
		if (/^\{arg\d+\}$/.test(tok)) { if (!body.endsWith(_REDACT_SEGMENT)) body += _REDACT_SEGMENT; }
		else body += tok.replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
	}
	return { regex: new RegExp('^' + body + '$'), prefix };
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
	const { replay, onSubscribe, onUnsubscribe, filter, access, delta, version, migrate, coalesceBy, classOfService, args: argsSchema, transform, piiRedact, volatile: volatileOpt, staleAfterMs, onError: streamOnError, invalidateOn, ...rest } = options || {};
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
	// piiRedact builds its redactor at declaration time so a bad config throws
	// here, not on the first publish. createPiiRedactor validates the shape
	// (modes, hashSalt) and returns a pure non-mutating (data) => redacted.
	let _piiRedactor;
	if (piiRedact !== undefined) {
		_piiRedactor = createPiiRedactor(piiRedact);
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
	// Per-room alarm (live.alarm). `{ alarm: { onAlarm } }` flows into
	// __streamOptions via `...rest`; validate the shape here so a typo throws at
	// declaration time and the dispatch loader-bind can trust it.
	if (options && options.alarm !== undefined) {
		const _a = options.alarm;
		if (typeof _a !== 'object' || _a === null || typeof _a.onAlarm !== 'function') {
			throw new Error('[svelte-realtime] live.stream alarm must be an object { onAlarm: (ctx) => {...} } - the handler that runs when ctx.setAlarm fires.');
		}
		if (_a.misfireMs !== undefined && (typeof _a.misfireMs !== 'number' || !Number.isFinite(_a.misfireMs) || _a.misfireMs < 0)) {
			throw new Error('[svelte-realtime] live.stream alarm.misfireMs must be a non-negative finite number (ms of tolerated lateness before a fire is skipped).');
		}
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
	// Ownership index: record every STATIC topic (piiRedact or not) so a
	// neighbouring piiRedact factory's derived pattern never claims a topic this
	// stream declared explicitly. See `_declaredStreamTopic`.
	if (typeof topic === 'string') _declaredStreamTopic.add(topic);
	/** @type {any} */ (initFn).__streamOptions = merged;
	if (coalesceBy) /** @type {any} */ (initFn).__coalesceBy = coalesceBy;
	if (argsSchema) /** @type {any} */ (initFn).__streamArgs = argsSchema;
	if (transform) /** @type {any} */ (initFn).__streamTransform = transform;
	if (_piiRedactor) {
		/** @type {any} */ (initFn).__streamPiiRedact = _piiRedactor;
		// Register the redactor at DECLARATION time for static topics so a
		// publish to a replay+piiRedact topic with no current subscriber (cron
		// tick, top-level publish(), reactive recompute, a write before anyone
		// joins) still redacts before the buffer write. The subscribe-time
		// `_topicRedact` registration covers dynamic topics (which only resolve a
		// concrete topic at subscribe, the same moment their replay buffer arms)
		// on THIS instance; the pattern registration below covers the resolved
		// topics this instance never subscribed to (the cluster-transient case).
		if (typeof topic === 'string') {
			_declaredRedact.set(topic, { redact: _piiRedactor, onError: streamOnError || null });
		} else if (typeof topic === 'function') {
			// Dynamic (factory) topic: register the redactor keyed by the derived
			// pattern so a publish to a resolved topic this instance never
			// subscribed to still redacts send-side (before the wire, buffer, and
			// cluster relay). The redactor is uniform per stream, so one pattern
			// entry covers every resolved instance of this topic.
			const _pattern = _deriveTopicPattern(topic);
			const _compiled = _compileRedactPattern(_pattern);
			if (_compiled) {
				// Two distinct factory streams that derive the SAME pattern claim the
				// same topic space; only one redactor can key the pattern, so the
				// later wins and the other stream's redaction is silently lost. That
				// is a leak, so warn once per pattern (dev). Composing the two is
				// unsafe - double-hash would produce pseudonyms inconsistent with the
				// subscribe-path single hash. Dedup by pattern so an HMR reload of one
				// stream (which mints a fresh redactor closure for the same topic)
				// warns at most once rather than on every reload.
				const _prev = _declaredRedactPattern.get(_pattern);
				if (_IS_DEV && _prev && _prev.redact !== _piiRedactor && !_redactPatternWarned.has(_pattern)) {
					_redactPatternWarned.add(_pattern);
					console.warn(
						'[svelte-realtime] piiRedact factory topic pattern "' + _pattern + '" was declared more than ' +
						'once with a different redactor. If these are two distinct streams sharing a topic space, the ' +
						'later declaration wins for redacting resolved topics no local subscriber has claimed - give ' +
						'them distinct topic shapes. (A dev HMR reload of one stream also triggers this and is harmless.)'
					);
				}
				_declaredRedactPattern.set(_pattern, { regex: _compiled.regex, prefix: _compiled.prefix, redact: _piiRedactor, onError: streamOnError || null, failOpen: true });
			}
		}
	}
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
	// Ownership index (see `_declaredStreamTopic`): a static channel topic is an
	// explicit declaration, so a neighbouring piiRedact factory pattern must not
	// claim it - the typing-indicator-beside-chat case is exactly this.
	if (typeof topic === 'string') _declaredStreamTopic.add(topic);
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

/**
 * Mark a live function (RPC, stream, or channel) as deprecated. Additive: wrap
 * any RPC / stream / channel handler - `live.deprecate(live.stream('feed', init), { use: 'feedV2' })`
 * or `live.deprecate(async (ctx) => {...}, { since: '0.6' })` - and the marker
 * composes with the handler's other markers in any wrap order (it is found
 * through the rateLimit / validated / idempotency / lock / breaker chain and the
 * stream re-wrappers alike). The server sends a one-shot `deprecation` signal on
 * the first response to each connection for the deprecated path; the client
 * surfaces it as a single dev-mode console warning. Negligible cost: one small
 * field, sent once per connection per path, and the warning itself is dev-only
 * on the client. NOT wired for `live.upload` handlers (they have no client warn
 * surface; deprecate the upload's caller-facing wrapper or rely on docs/types).
 *
 * @param {Function} fn - the handler to mark (any live function)
 * @param {{ message?: string, since?: string, use?: string, removeBy?: string }} [options]
 *   `message` (why / what changed), `since` (version it was deprecated in),
 *   `use` (the replacement path to point callers at), `removeBy` (when it will
 *   be removed). All optional and free-form strings.
 * @returns {Function} the same `fn`, marked.
 *
 * @example
 * ```js
 * // src/lib/realtime/feed.js
 * import { live } from 'svelte-realtime';
 * export const legacyFeed = live.deprecate(
 *   live.stream('legacy-feed', async (ctx) => loadFeed(ctx)),
 *   { since: '0.6', use: 'feed', removeBy: '0.7', message: 'paginated feed replaces it' }
 * );
 * ```
 */
live.deprecate = function deprecateMarker(fn, options) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.deprecate(fn, options?) requires a handler function');
	}
	/** @type {Record<string, string>} */
	const info = {};
	if (options !== undefined) {
		if (typeof options !== 'object' || options === null) {
			throw new Error('[svelte-realtime] live.deprecate: options must be an object');
		}
		for (const key of ['message', 'since', 'use', 'removeBy']) {
			const v = /** @type {any} */ (options)[key];
			if (v !== undefined) {
				if (typeof v !== 'string') {
					throw new Error(`[svelte-realtime] live.deprecate: ${key} must be a string`);
				}
				info[key] = v;
			}
		}
	}
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__deprecated = info;
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

installForget(live);

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

installReactiveFamilies({ flagCell: _flagCell, installFlagWatcher: _installFlagWatcher, validateWindowSpec: _validateWindowSpec });

// live.flag/derived/effect/aggregate registration bodies live in
// src/server/reactive-families.js; these thin wrappers keep them on the factory.
live.flag = function flag(...args) { return _flagRegister(...args); };

// live.derived: registration body in src/server/reactive-families.js.
live.derived = function derived(...args) { return _derivedRegister(...args); };

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

// live.effect: registration body in src/server/reactive-families.js.
live.effect = function effect(...args) { return _effectRegister(...args); };

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
	// The registration path is the stable webhook id, carried on the entry so a
	// dead-lettered event can be replayed by looking the webhook back up by id.
	const entry = { id: path, sources, config };
	webhookOutRegistry.set(path, entry);
	_webhookOutById.set(path, entry);
	for (const src of sources) {
		let set = _webhookOutBySource.get(src);
		if (!set) { set = new Set(); _webhookOutBySource.set(src, set); }
		set.add(entry);
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


// live.aggregate: registration body in src/server/reactive-families.js.
live.aggregate = function aggregate(...args) { return _aggregateRegister(...args); };

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
	const privacy = /** @type {any} */ (fn).__aggregatePrivacy || null;
	const entry = {
		source, reducers, topic, state: { ...initState }, snapshot, debounce, timer: null,
		_reducerEntries: Object.entries(reducers), _hydrationPromise: null,
		// k-anon / DP privacy state. `cohort` counts distinct contributors (only
		// when a contributor extractor is configured); `_lastWire` holds the last
		// value that passed the gate (initialized to the zero state) so the
		// initial-load loader and a held suppression never expose the live
		// below-k aggregate. `_windowStart` 0 keeps the single-state seed stable.
		privacy,
		cohort: (privacy && privacy.contributor) ? new Set() : null,
		_windowStart: 0,
		_lastWire: privacy ? _computeAggregateState({ ...initState }, reducers) : undefined
	};

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
	const privacy = /** @type {any} */ (fn).__aggregatePrivacy || null;

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
		windowed: true,
		privacy
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

	// Per-window privacy state. cohort (lifetime/tumbling) or bucketCohorts
	// (sliding) count distinct contributors; _windowStart seeds the per-window
	// noise (the tumbling boundary, so each window draws fresh noise); _lastWire
	// holds the last gated value (init = the zero window state) so the loader and
	// a held suppression never reveal the live below-k window.
	if (privacy) {
		for (const win of windowStates.values()) {
			win.privacy = privacy;
			if (win.type === 'sliding') {
				win.bucketCohorts = privacy.contributor ? win.buckets.map(() => new Set()) : null;
			} else {
				win.cohort = privacy.contributor ? new Set() : null;
			}
			// Seed the per-window noise. Tumbling: the boundary (fresh per window).
			// Sliding: the wall-clock slide epoch (fresh per slide, and aligned
			// across replicas which all floor the same clock) so the noise offset
			// does not stay constant for the whole process - a constant offset on a
			// continuously-sliding window lets an observer difference it away.
			// Lifetime / single-state stay 0 (no boundary; the constant-offset
			// continual-observation limit is documented).
			win._windowStart = win.type === 'tumbling'
				? win.nextBoundary
				: (win.type === 'sliding' ? Math.floor(now / win.spec.slideMs) : 0);
			win._lastWire = _computeWindowState(win, reducers);
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
		// A new window is a new k-anonymity cohort and a fresh noise seed.
		if (win.cohort) win.cohort = new Set();
		if (win.privacy) win._windowStart = win.nextBoundary;
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
		// The evicted bucket's contributors leave the k-anonymity cohort too.
		if (win.bucketCohorts) win.bucketCohorts[win.bucketIndex] = new Set();
		// Refresh the noise seed each slide (wall-clock epoch, replica-aligned) so
		// the DP offset does not stay constant for the whole process lifetime.
		if (win.privacy) win._windowStart = Math.floor(runtimeNow() / win.spec.slideMs);
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
	// Privacy gate (k-anon suppress / DP noise) then piiRedact, mirroring the
	// reduce-loop publish in reactive.js so the timer-driven boundary / slide
	// publishes are gated identically.
	const gated = _gateAggregate(win, computed, win.outputTopic);
	if (!gated.publish) return; // below k: hold the last published value
	const wire = _redactOrDrop(win.outputTopic, gated.value);
	if (wire === REDACT_DROP) return;
	platform.publish(win.outputTopic, 'set', wire);
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

installRoom({ callTopicFn: _callTopicFn, rollingBack: _rollingBack });

// live.room builds a collaborative room (data stream, presence, cursors, scoped
// actions); its registration body lives in src/server/room.js. This thin wrapper
// keeps live.room on the factory while the body moved out.
live.room = function room(...args) { return _roomRegister(...args); };

installMultiplayer({ callTopicFn: _callTopicFn });

// live.multiplayer builds a collaborative room namespace; its registration body
// lives in src/server/multiplayer.js. This thin wrapper keeps live.multiplayer
// on the factory while the body moved out.
live.multiplayer = function multiplayer(...args) { return _multiplayerRegister(...args); };

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

installBreaker({ copyStreamMeta: _copyStreamMeta });

// live.breaker wraps a stream initFn with a circuit breaker; the body lives in
// src/server/breaker.js. This thin wrapper keeps live.breaker on the factory
// while the registration body moved out.
live.breaker = function breaker(options, fn) { return _breakerRegister(options, fn); };

/**
 * Declare a tenant and (optionally) its config, returning a server-side handle.
 *
 * Tenant isolation is automatic and OPT-IN via `realtime({ tenant })`: once a
 * resolver is configured, every topic and key is scoped by the connection's
 * server-trusted `ctx.tenantId`, and inside a handler `ctx.tenant(id).publish(...)`
 * is the cross-tenant escape. This factory is a thin complement for code OUTSIDE a
 * request handler:
 * - it validates `id` (the same delimiter-safe, length-bounded charset as the resolver),
 * - it records `config` (quota / metrics / breaker settings) in a global registry
 *   that the deferred quota / metrics slices consume - the realtime core does not
 *   enforce it here, and
 * - it returns a handle whose `.publish(topic, event, data)` targets the tenant's
 *   scope using the active server platform.
 *
 * @param {string} id - tenant id ([a-zA-Z0-9_-], <= 64 chars)
 * @param {object} [config] - opt-in per-tenant config carrier (not enforced by the core)
 * @returns {{ id: string, config: any, publish: (topic: string, event: string, data: any, options?: any) => any }}
 */
live.tenant = function tenant(id, config) {
	const tenantId = _validTenantId(id);
	if (config !== undefined && config !== null) {
		if (typeof config !== 'object' || Array.isArray(config)) {
			throw new LiveError('VALIDATION', 'live.tenant(id, config): config must be a plain object (quota / metrics / breaker settings).');
		}
		_tenantConfigRegistry.set(tenantId, config);
	}
	return {
		id: tenantId,
		// Read live so a later re-declare with new config is reflected.
		get config() { const c = _tenantConfigRegistry.get(tenantId); return c === undefined ? null : c; },
		publish(topic, event, data, options) {
			// Outside a request handler there is no ctx; use the platform the server
			// activated (the same one cron publishes through). Inside a handler prefer
			// ctx.tenant(id).publish, which carries the connection's own platform.
			const platform = state.derivedPlatform || state.cronPlatform;
			if (!platform) {
				throw new LiveError('INTERNAL', 'live.tenant(...).publish requires an active server platform; call it after the realtime server is wired (inside a handler use ctx.tenant(id).publish instead).');
			}
			return _makeTenantScope(_getCtxHelpers(platform).publish, tenantId).publish(topic, event, data, options);
		}
	};
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

	// Clear pending alarm timers (live.alarm); keeps the store/leader config like cron.
	_resetAlarms();

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

// live.webhook bridges an external HTTP webhook into a topic; the body lives in
// src/server/webhooks.js. This thin wrapper keeps live.webhook on the factory.
live.webhook = function webhook(...args) { return _webhookRegister(...args); };

// live.webhooks is the webhook namespace: inbound aliases live.webhook; outbound
// fires leader-gated HTTP webhooks. Both bodies live in src/server/webhooks.js.
live.webhooks = {
	inbound: live.webhook,
	outbound(...args) { return _webhooksOutboundRegister(...args); }
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
	// Point-to-point signals key by the user id you supply, NOT by the tenant: the
	// channel is delivered to the client under `__signal:<userId>` (the client keys
	// its onSignal store on that logical topic and has no way to learn a server-only
	// tenant prefix), so a tenant-scoped channel would silently never reach the
	// client. Under multi-tenancy, use globally-unique user ids (the norm) so signals
	// stay isolated; see the README "Multi-tenancy" note.
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
	// The drain ctx carries the connection's server-trusted tenant so tenant-scoped
	// unsubscribe drains (the room-enumeration roster release + its delta channel)
	// target the right tenant; `_publishWire` is the raw, non-prefixing publish that
	// framework code uses when it already holds a wire topic. `publish` stays the raw
	// helper (the hook topics here are already wire topics). Both reduce to the
	// originals with no tenant resolver configured (tenantId null, _publishWire === publish).
	const _helpers = _getCtxHelpers(platform);
	const unsubCtx = { user, ws, platform, publish: _helpers.publish, cursor: null, tenantId: _resolveTenant(user), _publishWire: _helpers.publish };

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
	_unregisterRedact(ws, topic);
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
	// Carries the connection's tenant + raw wire-publish for tenant-scoped close
	// drains (room-enumeration roster release + delta), exactly like unsubscribe().
	const _helpers = _getCtxHelpers(platform);
	const closeCtx = { user, ws, platform, publish: _helpers.publish, cursor: null, tenantId: _resolveTenant(user), _publishWire: _helpers.publish };

	// Drain tracked stream subscriptions (from the RPC subscribe path)
	if (topicMap) {
		for (const [topic, owners] of topicMap) {
			_unregisterCoalesce(ws, topic);
			_unregisterTransform(ws, topic);
			_unregisterRedact(ws, topic);
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
	// Same drain for the sessionId push registry (independent of the userId one).
	_deregisterPushSession(ws);
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
	// Out-of-band publish (SSR routes, webhooks, scripts) is a first-class wire
	// egress, so it honors piiRedact uniformly. Fail-closed: a throwing redactor
	// drops the publish rather than broadcasting raw PII. Topics with no
	// redactor declared pass through untouched.
	if (_topicRedact.size > 0 || _declaredRedact.size > 0 || _declaredRedactPattern.size > 0) {
		const redacted = _redactOrDrop(topic, data);
		if (redacted === REDACT_DROP) return false;
		data = redacted;
	}
	// Route replay-eligible topics through the replay buffer, exactly like
	// ctx.publish and cron auto-publish. Without this, an out-of-band publish()
	// (SSR route, webhook, script) and a live.flag().set() - which calls this
	// export - would broadcast live but never write the shared buffer or carry an
	// authoritative seq, so a replica that booted after the write, or a subscriber
	// offline during it, would serve/resume stale. A jittered control event keeps
	// the direct path (matching ctx.publish); a topic with no replay registration
	// falls through to the bare publish untouched.
	if (!(options && options.jitterMs > 0) && _maybeReplayPublish(platform, topic, event, data)) return true;
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
	const { bus, leader, upgrade: upgradeFn, onError, tenant, admin, webhooks, protocolVersion, maskNotFound, authorizeWireSubscribe } = cfg;

	// Enumeration-safe unknown-path handling (opt-in): answer a wire RPC to an
	// unregistered path exactly as a guard denial would answer the same caller,
	// so probing cannot separate "exists but forbidden" from "does not exist".
	if (maskNotFound !== undefined) {
		if (typeof maskNotFound !== 'boolean') {
			throw new Error('[svelte-realtime] realtime({ maskNotFound }): must be a boolean');
		}
		state.maskNotFound = maskNotFound;
	}

	// Wire-subscribe authorization (default on). Closes the raw-wire subscribe
	// bypass: a client can only subscribe to a topic the server authorized for it
	// through a stream RPC. Opt out only for a hybrid app that deliberately relies
	// on raw client-initiated adapter subscriptions.
	if (authorizeWireSubscribe !== undefined) {
		if (typeof authorizeWireSubscribe !== 'boolean') {
			throw new Error('[svelte-realtime] realtime({ authorizeWireSubscribe }): must be a boolean');
		}
		state.authorizeWireSubscribe = authorizeWireSubscribe;
	}

	// Protocol-compat signal (opt-in): an integer the app bumps only on a BREAKING
	// wire/contract change. The client advertises its baked version on connect; a
	// client older than this server is sent a one-shot `protocol-stale` notice. Left
	// off (no compare, no signal) when unset.
	if (protocolVersion !== undefined) {
		if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
			throw new Error('[svelte-realtime] realtime({ protocolVersion }): must be an integer');
		}
		state.serverProtocolVersion = protocolVersion;
	}

	if (bus !== undefined) _setBus(bus);
	if (leader !== undefined) configureCron({ leader });
	// Outbound-webhook plane: `webhooks.deadLetter` retains + admin-replays
	// undeliverable events; `webhooks.budget`/`webhooks.breaker` ration retries
	// and eject a failing endpoint. Off unless configured.
	if (webhooks !== undefined) configureWebhooks(webhooks);
	// Multi-tenancy opt-in: a resolver mapping the server-trusted authenticated
	// user (ws.getUserData()) to a tenant id auto-scopes every topic and key.
	// Passing nothing (or null) leaves the framework single-tenant and zero-cost.
	if (tenant !== undefined) _setTenantResolver(tenant);
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
		// Graceful shutdown: the adapter calls this once on SIGTERM, before it
		// closes the listen socket and flushes the WebSockets. Drains in-flight
		// work (rejecting new RPC/SSR/cron with UNAVAILABLE) and runs registered
		// onShutdown() handlers. Idempotent and zero-config (drains even with no
		// handler registered). Composes with an app's own teardown via onShutdown.
		shutdown(ctx) {
			return _runShutdown(ctx);
		},
	};
	if (typeof upgradeFn === 'function') /** @type {any} */ (hooks).upgrade = upgradeFn;
	// Admin / observability plane (opt-in, fail-closed): `admin: { requires }` adds
	// a Web Request -> Response handler for the reserved `/__realtime/*` path. With
	// no `admin` configured there is no handler at all - the route cannot exist
	// without an explicit auth check. Mount it yourself (a SvelteKit `+server.js`
	// re-exporting the hook) or let the adapter wire the reserved path to it.
	if (admin !== undefined && admin !== null) {
		if (typeof admin !== 'object') {
			throw new Error('[svelte-realtime] realtime({ admin }): admin must be an object like { requires: (request) => boolean }');
		}
		/** @type {any} */ (hooks).admin = _createAdminHandler(admin);
	}
	return hooks;
}
