// @ts-check
import { assert, wireAssertionMetrics } from './shared/assert.js';
import { safeAssign as _safeAssignSnapshot } from './shared/safe-assign.js';
import {
	now as runtimeNow,
	monotonicNow,
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
export { assert, getAssertionCounters, _resetAssertCounters } from './shared/assert.js';
export { colorForKey, hueForKey } from './shared/color.js';

const textDecoder = new TextDecoder();

// Runtime-backed RNG fallback for ctx.random when the adapter platform does
// not expose its own injectable RNG (older adapters, mock platforms). Shape
// matches the adapter's platform.random so a loader/handler reads one stable
// interface regardless of which side supplies it. Frozen singleton so the
// fallback object identity never changes.
const _runtimeRandom = Object.freeze({
	float: randomFloat,
	u32: randomU32,
	uuid: randomUuid,
	bytes: randomBytes
});

// Runtime-backed hybrid logical clock fallback for ctx.hlc when the adapter
// platform does not project its own (older adapters, mock platforms). Same
// {wall, logical, nodeId} shape and non-decreasing wall + logical-tiebreaker
// rule the adapter uses, but sourced from this framework's own runtime clock
// and RNG so a seeded simulation harness reproduces the stamps. nodeId is
// assigned once per process from the runtime RNG.
const _localHlcNodeId = randomUuid().slice(0, 8);
let _localHlcLastWall = 0;
let _localHlcLogical = 0;
function _localHlc() {
	const w = runtimeNow();
	if (w > _localHlcLastWall) {
		_localHlcLastWall = w;
		_localHlcLogical = 0;
	} else {
		_localHlcLogical += 1;
	}
	return { wall: _localHlcLastWall, logical: _localHlcLogical, nodeId: _localHlcNodeId };
}

const _validPathRe = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/;
const _validSegmentRe = /^[a-zA-Z0-9_]+$/;

/**
 * Max accepted length for a userId that flows into a topic name via
 * `__signal:${userId}` / `__push:${userId}` and similar server-built
 * system topics. 256 chars is generous for any realistic identifier
 * (UUIDs, opaque session tokens, prefixed-by-tenant ids) without
 * bloating log lines or stressing the adapter's wire-topic budget.
 */
const _MAX_USER_ID_LENGTH = 256;

/**
 * Validate that a userId is safe to interpolate into a system topic
 * name. Returns `null` if valid, otherwise a short error reason string
 * suitable for embedding in a thrown LiveError / Error message.
 *
 * Server-side helpers that build `__signal:${userId}` / `__push:${userId}`
 * topic names from caller-supplied identifiers go through this gate so
 * malformed identifiers (control bytes, CR/LF, NUL, quotes, backslash,
 * empty, non-string, oversized) cannot poison the topic namespace,
 * corrupt log lines, or escape the system-topic prefix into the
 * user-topic space. Non-ASCII bytes are allowed for parity with the
 * adapter's `allowNonAsciiTopics` opt-in; the server-side builder
 * trusts identifier shapes set by upgrade hooks.
 *
 * @param {unknown} userId
 * @returns {string | null}
 */
function _validUserIdReason(userId) {
	if (typeof userId !== 'string') return 'userId must be a string (got ' + (typeof userId) + ')';
	if (userId.length === 0) return 'userId must be non-empty';
	if (userId.length > _MAX_USER_ID_LENGTH) return 'userId exceeds maximum length ' + _MAX_USER_ID_LENGTH + ' (got ' + userId.length + ')';
	for (let i = 0; i < userId.length; i++) {
		const c = userId.charCodeAt(i);
		// Reject ASCII C0 controls (0x00-0x1F), DEL (0x7F), and the two
		// characters the adapter's wire-topic validator forbids:
		// 0x22 (double-quote), 0x5C (backslash).
		if (c < 0x20 || c === 0x7F || c === 0x22 || c === 0x5C) {
			return 'userId contains invalid character at index ' + i + ' (charCode ' + c + ')';
		}
	}
	return null;
}

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

// Mutable internal copies: the public `export const` values above are the
// canonical defaults; tests use `_setCapsForTest` to lower them for fast
// saturation scenarios. Production never touches these.
let _maxPushRegistry = MAX_PUSH_REGISTRY;
let _topicWsCountsWarnThreshold = TOPIC_WS_COUNTS_WARN_THRESHOLD;
let _silentTopicWarnDedupMax = SILENT_TOPIC_WARN_DEDUP_MAX;
let _publishRateWarnDedupMax = PUBLISH_RATE_WARN_DEDUP_MAX;
let _maxPresenceRef = MAX_PRESENCE_REF;

/**
 * Override capacity caps for testing. Pass any subset of the cap names
 * (omit `MAX_` / `_THRESHOLD` / `_MAX` suffix; use `pushRegistry`,
 * `topicWsCountsWarn`, `silentTopicWarnDedup`, `publishRateWarnDedup`,
 * `presenceRef`). Pair with `_resetCapsForTest()` in afterEach.
 * @internal
 * @param {{ pushRegistry?: number, topicWsCountsWarn?: number, silentTopicWarnDedup?: number, publishRateWarnDedup?: number, presenceRef?: number }} overrides
 */
export function _setCapsForTest(overrides) {
	if (overrides.pushRegistry !== undefined) _maxPushRegistry = overrides.pushRegistry;
	if (overrides.topicWsCountsWarn !== undefined) _topicWsCountsWarnThreshold = overrides.topicWsCountsWarn;
	if (overrides.silentTopicWarnDedup !== undefined) _silentTopicWarnDedupMax = overrides.silentTopicWarnDedup;
	if (overrides.publishRateWarnDedup !== undefined) _publishRateWarnDedupMax = overrides.publishRateWarnDedup;
	if (overrides.presenceRef !== undefined) _maxPresenceRef = overrides.presenceRef;
	if (overrides.uploadPendingMaxAggregate !== undefined) _UPLOAD_PENDING_MAX_AGGREGATE = overrides.uploadPendingMaxAggregate;
}

/**
 * Restore capacity caps to their default values.
 * @internal
 */
export function _resetCapsForTest() {
	_maxPushRegistry = MAX_PUSH_REGISTRY;
	_topicWsCountsWarnThreshold = TOPIC_WS_COUNTS_WARN_THRESHOLD;
	_silentTopicWarnDedupMax = SILENT_TOPIC_WARN_DEDUP_MAX;
	_publishRateWarnDedupMax = PUBLISH_RATE_WARN_DEDUP_MAX;
	_maxPresenceRef = MAX_PRESENCE_REF;
	_presenceRefWarnFired = false;
	_UPLOAD_PENDING_MAX_AGGREGATE = 64 * 1024 * 1024;
	_pendingUploadBytes = 0;
}

/** @type {Map<string, Function>} */
const registry = new Map();

/** @type {Map<string, Function>} */
const guards = new Map();

/** @type {Set<Function>} Streams with onUnsubscribe hooks (for iterating static matches in close) */
const _streamsWithUnsubscribe = new Set();

/**
 * Tag a topic function with __topicUsesCtx by inspecting its first parameter name.
 *
 * Auto-detects only named ctx params: ctx, context, _ctx → __topicUsesCtx = true.
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
		// Destructured, rest, empty, or unrecognized → leave unset
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

/**
 * Per-userId connection registry. Source of truth for `live.push({ userId })`
 * routing. Populated by `pushHooks.open`, drained by `pushHooks.close`.
 * Stores the platform alongside the ws so the wrapper can call
 * `platform.request(ws, ...)` without separate threading.
 *
 * Last-write-wins on multi-device: a second connection by the same user
 * replaces the first as the push target. Older connections still receive
 * topic publishes via their own subscriptions; only push routing flips.
 * Cluster-wide push (any instance routing to any user's ws) is a separate
 * primitive in the extensions package.
 * @type {Map<string, { ws: any, platform: any }>}
 */
const _pushRegistry = new Map();

/**
 * Reverse index from ws back to its registered userId. Used by
 * `pushHooks.close` to deregister without re-running identify(ws),
 * which may not be reliable on close (some platforms clear userData).
 * WeakMap so sockets remain GC-eligible if close is missed.
 * @type {WeakMap<object, string>}
 */
const _wsToPushUserId = new WeakMap();

/** One-shot flag for the MAX_PUSH_REGISTRY warning. Reset by `_resetPushRegistry`. */
let _pushRegistryWarnFired = false;

/** One-shot flag for the TOPIC_WS_COUNTS_WARN_THRESHOLD warning. Reset by `_resetTopicWsCounts`. */
let _topicWsCountsWarnFired = false;

/** One-shot flag for the MAX_PRESENCE_REF saturation warning. Reset by `_resetCapsForTest`. */
let _presenceRefWarnFired = false;

/** @type {((ws: any) => string | null | undefined) | null} */
let _pushIdentify = null;

/**
 * Default identify: read user_id then userId from ws.getUserData().
 * Returns undefined for anonymous connections (skipped by pushHooks.open).
 * @param {any} ws
 * @returns {string | null | undefined}
 */
function _defaultPushIdentify(ws) {
	let data;
	try { data = ws.getUserData?.(); } catch { return undefined; }
	if (!data) return undefined;
	return data.user_id != null ? data.user_id : data.userId;
}

function _getPushIdentify() {
	return _pushIdentify || _defaultPushIdentify;
}

/**
 * Per-topic set of WebSockets currently holding at least one realtime
 * stream subscription. Maintained as the source of truth for the
 * `remainingSubscribers` argument the realtime layer passes to
 * `__onUnsubscribe(ctx, topic, remainingSubscribers)` - apps use this
 * to decide "should I tear down the upstream feed?" once the count
 * hits zero. Distinct from the adapter's own ws.isSubscribed bookkeeping
 * because it tracks realtime-stream subscriptions specifically (not
 * arbitrary `on(topic)` topic listeners).
 * @type {Map<string, Set<object>>}
 */
const _topicWsCounts = new Map();

/**
 * Per-topic staleness watchdog. When a stream is configured with
 * `staleAfterMs`, the realtime layer arms a timer on first subscribe
 * for the topic. Every publish to the topic resets the timer (a
 * publish proves the topic is live). When the timer fires, the
 * realtime layer re-runs the stream's loader and broadcasts the new
 * data as a `refreshed` event; the client merges it as a full-state
 * replacement across every merge strategy.
 *
 * Captured ctx, args, fn, and platform reference are taken from the
 * FIRST subscriber for the topic. Subsequent subscribers do not
 * replace these (any subscriber's ctx works for a shared loader call
 * since the topic identifies the data scope). When the topic's
 * subscriber count drops to zero the watchdog clears; a new subscriber
 * after that captures a fresh ctx.
 *
 * @type {Map<string, {
 *   timerId: ReturnType<typeof setTimeout>,
 *   staleAfterMs: number,
 *   fn: Function,
 *   ctx: any,
 *   args: any[],
 *   platform: any,
 *   onError: Function | null,
 *   reloading: boolean
 * }>}
 */
const _topicStaleWatch = new Map();

/**
 * Per-process state for the dev-mode silent-topic warning. Arms a one-shot
 * timer on the first subscribe to a topic; if no event arrives within
 * `thresholdMs`, logs a warning suggesting common causes (missing pg_notify
 * trigger, missing handler-side publish, intentionally low-traffic topic).
 *
 * Hard-gated to development. Production-side cost: one boolean check on
 * the publish hot path, constant-folded out by Vite/Rollup when
 * `process.env.NODE_ENV === 'production'`.
 *
 * Shape mirrors `_topicStaleWatch` (per-topic timer + flags); the watchdog
 * fires once per topic per process and dedupes via `_silentTopicWarned`
 * so re-subscribes after a warn don't re-fire.
 */
const _silentTopicConfig = {
	enabled: true,
	thresholdMs: 30000,
	/** @type {Set<string>} */
	suppress: new Set()
};

/** @type {Map<string, { timerId: ReturnType<typeof setTimeout>, sawEvent: boolean }>} */
const _silentTopicWatch = new Map();

/** @type {Set<string>} Topics already warned about; prevents re-warning across re-subscribe cycles. */
const _silentTopicWarned = new Set();

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

/**
 * Per-topic coalesce registry. When a stream registered with `coalesceBy`
 * is subscribed, its topic is recorded here along with the live set of
 * subscriber sockets. The publish helper uses this to decide between
 * `platform.publish` (default broadcast) and per-socket
 * `platform.sendCoalesced` fan-out.
 *
 * Hot-path cost on the default (no-coalesce) branch: one Map.get on an
 * almost-always-empty map. See bench/publish.js for numbers.
 *
 * @type {Map<string, { coalesceBy: Function, onError: Function | null, ws: Set<any> }>}
 */
const _topicCoalesce = new Map();

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

/**
 * Per-topic transform registry. When a stream registered with `transform`
 * is subscribed, its topic is recorded here. The publish helper applies
 * the transform once per publish, BEFORE platform.publish (or the
 * sendCoalesced fan-out), so subscribers see the projected wire shape.
 *
 * Refcounted by ws-topic contributions - evicted when the last
 * subscriber leaves so HMR-changed stream definitions can re-register.
 *
 * Each entry also carries the registering stream's `onError` reference
 * (if configured). The publish helper wraps the transform call in
 * try/catch and routes throws to that observer; without an observer,
 * the throw propagates as before. First subscriber-for-topic wins on
 * `onError` selection (same rule as for `transform` itself).
 *
 * @type {Map<string, { transform: Function, onError: Function | null, refcount: number }>}
 */
const _topicTransform = new Map();

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

/**
 * Per-topic volatile registry. When a stream registered with `volatile: true`
 * is subscribed, its topic is recorded here. The publish helper translates
 * `volatile` topics + per-call `options.volatile === true` into the adapter's
 * `seq: false` per-event option, so seq stamping is skipped for these
 * messages - a reconnect carrying `lastSeenSeq` won't try to backfill them.
 *
 * Wire-level "drop on backpressure" behavior is the adapter's job:
 * platform.publish / platform.publishBatched / platform.send all skip a
 * subscriber whose outbound buffer is over the configured maxBackpressure
 * threshold (default 64 KB). This registry only governs seq stamping and
 * intent declaration on the realtime side.
 *
 * Refcounted by ws-topic contributions, mirroring the transform registry.
 * @type {Map<string, { refcount: number }>}
 */
const _topicVolatile = new Map();

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
 * Per-topic invalidation registry. When a stream is registered with
 * `invalidateOn: '<pattern>'`, an entry is created here keyed by the
 * pattern's compiled regex. The publish helper checks every publish
 * against these patterns and triggers a loader re-run for any stream
 * whose pattern matches the publish topic. Distinct from the stale
 * watchdog (timer-driven) - this one is event-driven.
 *
 * Each watcher stores everything `_staleReload` needs to re-execute the
 * loader: stream topic, init fn (with stashed __streamTransform /
 * __streamOnError), captured ctx + args, and the platform reference
 * for the publish path.
 *
 * @type {Map<string, { regex: RegExp, watchers: Array<{
 *   topic: string,
 *   fn: any,
 *   ctx: any,
 *   args: any[],
 *   platform: any,
 *   onError: Function | null,
 *   reloading: boolean
 * }> }>}
 */
const _topicInvalidationWatch = new Map();

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
 * Arm the silent-topic watchdog for a topic on its first subscriber.
 * Skips system topics (`__`-prefixed: `__realtime`, `__signal:*`, etc.)
 * which are intentionally quiet until something publishes. Skips topics
 * the user has explicitly suppressed and topics already warned about.
 * Idempotent per topic; second-sub-on-same-topic is a no-op.
 *
 * @param {string} topic
 */
export function _armSilentTopicWatch(topic) {
	if (!_IS_DEV) return;
	if (!_silentTopicConfig.enabled) return;
	if (_silentTopicWatch.has(topic)) return;
	if (_silentTopicWarned.has(topic)) return;
	if (_silentTopicConfig.suppress.has(topic)) return;
	if (topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) return;
	const entry = {
		sawEvent: false,
		timerId: setTimer(() => {
			const e = _silentTopicWatch.get(topic);
			if (!e || e.sawEvent) return;
			if (_silentTopicWarned.size >= _silentTopicWarnDedupMax && !_silentTopicWarned.has(topic)) {
				const oldest = _silentTopicWarned.values().next().value;
				if (oldest !== undefined) _silentTopicWarned.delete(oldest);
			}
			_silentTopicWarned.add(topic);
			console.warn(
				"[svelte-realtime] Topic '" + topic + "' has subscribers but no events arrived within " +
				_silentTopicConfig.thresholdMs + "ms.\n" +
				"  Common causes:\n" +
				"    - missing pg_notify trigger on the underlying table\n" +
				"    - no ctx.publish() call in the relevant handler\n" +
				"    - intentionally low-traffic topic (extend threshold or suppress)\n" +
				"  Configure: live.silentTopicWarning({ thresholdMs: 60000 })\n" +
				"  Suppress:  live.silentTopicWarning({ suppress: ['" + topic + "'] })\n" +
				"  Disable:   live.silentTopicWarning(false)\n" +
				"  See: https://svti.me/silent-topic"
			);
		}, _silentTopicConfig.thresholdMs)
	};
	if (typeof (/** @type {any} */ (entry.timerId).unref) === 'function') {
		/** @type {any} */ (entry.timerId).unref();
	}
	_silentTopicWatch.set(topic, entry);
}

/**
 * Mark a topic as having seen an event. Called from the publish-helper
 * closure on every publish. Once an event arrives, the watchdog is
 * disarmed for that topic for the lifetime of the process (the warning
 * never fires for a topic that has been live).
 *
 * @param {string} topic
 */
function _observeSilentTopicPublish(topic) {
	const entry = _silentTopicWatch.get(topic);
	if (!entry) return;
	entry.sawEvent = true;
	clearTimer(entry.timerId);
	_silentTopicWatch.delete(topic);
}

/**
 * Clear the silent-topic watchdog when the last subscriber leaves the
 * topic. Mirrors `_unregisterStaleWatch`. No-op when no watchdog exists.
 *
 * @param {string} topic
 */
function _disarmSilentTopicWatch(topic) {
	const entry = _silentTopicWatch.get(topic);
	if (!entry) return;
	clearTimer(entry.timerId);
	_silentTopicWatch.delete(topic);
}

/** Reset the silent-topic watchdog state. Tests only. @internal */
export function _resetSilentTopicWarning() {
	for (const entry of _silentTopicWatch.values()) clearTimer(entry.timerId);
	_silentTopicWatch.clear();
	_silentTopicWarned.clear();
	_silentTopicConfig.enabled = true;
	_silentTopicConfig.thresholdMs = 30000;
	_silentTopicConfig.suppress.clear();
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

/** @type {WeakMap<any, { publish: Function, publishThrottled: Function, publishDebounced: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function, skip: Function }>} */
const _ctxHelpersCache = new WeakMap();

/** @type {boolean} */
const _IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Dev-warn dedup: one-time "ctx.throttle is deprecated" warning. */
let _throttleDeprecatedWarned = false;
/** Dev-warn dedup: one-time "ctx.debounce is deprecated" warning. */
let _debounceDeprecatedWarned = false;
/** Dev-warn dedup: per-helper bad-args warning. Keys: 'publishThrottled', 'publishDebounced', 'throttle', 'debounce'. */
/** @type {Record<string, boolean>} */
const _publishHelperBadArgsWarned = Object.create(null);
/** Dev-warn dedup: one-time "ctx.skip gate map at capacity" warning. */
let _skipGateCapWarned = false;

/**
 * Topics declared with `live.stream(..., { replay: true })`. Populated at
 * declaration time for static topics and at first-subscribe time for
 * dynamic-topic factories (when the topic resolves). When a publish to one
 * of these topics happens (from `ctx.publish`, cron auto-publish, derived /
 * aggregate, anywhere), the framework auto-routes through
 * `platform.replay.publish(...)` so the buffer captures it for gap-fill on
 * resume -- regardless of which seam (RPC / cron / etc.) the publisher
 * sits on. Pre-fix, only publishes that flowed through a user-managed
 * `wrapWithReplay` proxy reached the buffer; cron-published events bypassed
 * it silently because the cron platform was captured separately.
 *
 * @type {Set<string>}
 */
const _replayEligibleTopics = new Set();

/**
 * Dev-warn dedup for "stream declared replay: true but the adapter does
 * not expose `platform.replay`" misconfigurations. Per-topic so each
 * misconfigured topic surfaces once; the warning includes the install
 * pointer for the replay extension. Cleared by `_resetReplayRouting()`
 * for tests.
 *
 * @type {Set<string>}
 */
const _replayMissingWarned = new Set();

/**
 * Public well-known marker: a user-managed platform proxy that already
 * routes replay-eligible publishes through `platform.replay.publish(...)`
 * itself can opt out of the framework's auto-routing by setting this
 * symbol-keyed property to `true`. Without the marker, the framework's
 * `_publish` would call `platform.replay.publish(platform, ...)`, which
 * internally calls `platform.publish(topic, event, data)` -- the user
 * proxy's intercept would then call `replay.publish(target, ...)` again,
 * doubling the Redis write. The marker lets the framework defer to the
 * user proxy in that case.
 *
 * Most users should drop their bespoke `wrapWithReplay` proxy and let the
 * framework own routing; the marker is a back-compat escape hatch.
 */
export const WRAPPED_FOR_REPLAY = Symbol.for('svelte-realtime.wrapped-for-replay');

/**
 * Register a topic as replay-eligible. Called from `live.stream` declaration
 * for static topics, and from `_executeStreamRpc` for dynamic topics on first
 * subscribe. Idempotent; a topic registered twice stays in the set once.
 *
 * @param {string} topic
 */
function _registerReplayTopic(topic) {
	if (typeof topic === 'string' && topic.length > 0) {
		_replayEligibleTopics.add(topic);
	}
}

/**
 * Replay-route a publish through `platform.replay.publish(...)` when the
 * topic is in the replay-eligible registry AND the platform exposes a
 * `replay` surface. Returns `true` when the publish was routed (caller
 * should NOT fall back to `platform.publish` -- replay.publish handles the
 * local broadcast internally) and `false` when it was not (caller should
 * call its own publish path: bare `platform.publish`, batched, or
 * coalesced).
 *
 * Skips routing when:
 * - The topic is not registered as replay-eligible.
 * - The adapter exposes no `platform.replay` (replay extension not
 *   installed). A one-time dev warn fires per topic so the misconfig is
 *   visible during development.
 * - The platform is marked `[WRAPPED_FOR_REPLAY] = true` (a user-managed
 *   proxy is already routing replay; framework defers).
 *
 * Failures inside `replay.publish` are logged in dev and otherwise
 * swallowed -- the local broadcast still happens via the extension's own
 * fallback, and we don't want a Redis hiccup to crash the publisher.
 *
 * @param {any} platform
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @returns {boolean} true if routed through replay, false if caller should fall back
 */
function _maybeReplayPublish(platform, topic, event, data) {
	if (!_replayEligibleTopics.has(topic)) return false;
	const replay = platform && /** @type {any} */ (platform).replay;
	if (!replay || typeof replay.publish !== 'function') {
		if (_IS_DEV && !_replayMissingWarned.has(topic)) {
			_replayMissingWarned.add(topic);
			console.warn(
				"[svelte-realtime] live.stream('" + topic + "', ..., { replay: true }) is declared but " +
				"the adapter exposes no `platform.replay` -- the bounded replay buffer is not engaged " +
				"and clients will not receive missed events on resume. Install the replay extension " +
				"(svelte-adapter-uws-extensions/redis/replay or postgres/replay) and wire it via " +
				"`platform.replay = createReplay(redisClient)` so `platform.replay` is exposed. " +
				"Warned once per topic per session."
			);
		}
		return false;
	}
	if (/** @type {any} */ (platform)[WRAPPED_FOR_REPLAY]) return false;
	try {
		const ret = replay.publish(platform, topic, event, data);
		if (ret && typeof ret.then === 'function') {
			ret.catch((err) => {
				if (_IS_DEV) {
					console.warn(
						"[svelte-realtime] replay.publish('" + topic + "') failed:",
						err
					);
				}
			});
		}
	} catch (err) {
		if (_IS_DEV) {
			console.warn(
				"[svelte-realtime] replay.publish('" + topic + "') threw synchronously:",
				err
			);
		}
		// On sync throw the local broadcast didn't happen; fall back to
		// platform.publish so subscribers still receive the event live.
		return false;
	}
	return true;
}

/**
 * Reset replay-routing state. Tests only.
 * @internal
 */
export function _resetReplayRouting() {
	_replayEligibleTopics.clear();
	_replayMissingWarned.clear();
}

/**
 * Per-process state for the dev-mode publish-rate warning. Sampler is lazy:
 * activated on the first ctx-helpers cache miss per platform, runs at the
 * configured interval, reads `platform.pressure.topPublishers` (already
 * computed by the adapter sampler), and emits one warn per topic per
 * process when a topic is over threshold. Production has zero cost --
 * `_IS_DEV` is constant-folded so the activation branch is dead code.
 */
const _publishRateConfig = {
	enabled: true,
	threshold: 200,
	intervalMs: 5000
};
/** @type {Set<string>} */
const _publishRateWarned = new Set();
/** @type {WeakMap<any, ReturnType<typeof setInterval>>} */
const _publishRateSamplers = new WeakMap();
/**
 * Bumped by `_resetPublishRateWarning` and by `live.publishRateWarning(false)`.
 * Each sampler captures its activation-time epoch and self-clears on the next
 * fire when the epoch no longer matches. Pattern used in place of the prior
 * strong-reference `Set<platform>` because that Set held every dev-mode
 * platform alive across the process lifetime, defeating the WeakMap above and
 * leaking the platform + all captured helpers/closures on every per-call
 * wrap pattern (e.g. cron tick wrapping a fresh `bus.wrap(platform)` per fire).
 */
let _publishRateEpoch = 0;

/**
 * Activate the dev-mode publish-rate warning sampler for one platform.
 * Idempotent per platform identity. Safe to call from any code path that
 * sees a platform reference for the first time. Production has zero cost
 * (returns immediately on the `_IS_DEV` gate). Exported with an
 * underscore prefix so tests can drive activation deterministically
 * without going through the async RPC path.
 *
 * The sampler closure must NOT strongly capture `platform`. Node's timer
 * queue holds the `setInterval` Timer alive until clearInterval fires; if
 * the closure captured `platform` directly, every platform ever passed in
 * would stay reachable forever, leaking the entire helpers+closures graph.
 * The `WeakRef` wrapper here breaks that retention: on each tick the
 * sampler derefs, and a null deref (platform GC'd elsewhere) self-clears
 * the timer. Net effect: at most one stale tick after platform GC, then
 * the entry vanishes.
 *
 * @param {any} platform
 */
export function _activatePublishRateWarning(platform) {
	if (!_IS_DEV) return;
	if (!_publishRateConfig.enabled) return;
	if (_publishRateSamplers.has(platform)) return;
	if (typeof platform?.pressure !== 'object' || platform.pressure === null) return;
	const platformRef = new WeakRef(platform);
	const epoch = _publishRateEpoch;
	const sampler = setIntervalTimer(() => {
		// Self-clear on disable / reset / platform-GC. Any of the three
		// makes the sampler stale; clearInterval here lets Node drop the
		// Timer from the queue on the next event-loop turn.
		if (!_publishRateConfig.enabled || epoch !== _publishRateEpoch) {
			clearIntervalTimer(sampler);
			return;
		}
		const p = platformRef.deref();
		if (!p) {
			clearIntervalTimer(sampler);
			return;
		}
		const top = p.pressure?.topPublishers;
		if (!Array.isArray(top)) return;
		for (const entry of top) {
			if (!entry || typeof entry.topic !== 'string') continue;
			if (entry.messagesPerSec < _publishRateConfig.threshold) continue;
			if (_publishRateWarned.has(entry.topic)) continue;
			if (_publishRateWarned.size >= _publishRateWarnDedupMax) {
				const oldest = _publishRateWarned.values().next().value;
				if (oldest !== undefined) _publishRateWarned.delete(oldest);
			}
			_publishRateWarned.add(entry.topic);
			// Suppress the hint when the user has already chosen one of the
			// two natural mitigations for this topic. Both registries are
			// populated on subscribe; if either has the topic, the user knows
			// it's high-frequency and picked their tool.
			if (_topicCoalesce.has(entry.topic) || _topicVolatile.has(entry.topic)) continue;
			console.warn(
				`[svelte-realtime] Topic '${entry.topic}' is publishing ` +
				`${Math.round(entry.messagesPerSec)} events/sec.\n` +
				`  For high-frequency streams, consider one of:\n` +
				`    live.stream(topic, loader, { coalesceBy: (data) => data.userId })  // latest-value-wins, queued per subscriber\n` +
				`    live.stream(topic, loader, { volatile: true })                     // drop on backpressure, best-effort\n` +
				`  See: https://svti.me/highfreq`
			);
		}
	}, _publishRateConfig.intervalMs);
	if (typeof sampler.unref === 'function') sampler.unref();
	_publishRateSamplers.set(platform, sampler);
}

/**
 * Reset the dev-mode publish-rate warning state. Tests only. Clears the
 * one-shot warned set and bumps the per-process epoch so every existing
 * sampler self-clears on its next fire. Stale samplers stop within one
 * `intervalMs` of the reset (default 5s); a same-platform re-activation
 * after reset gets a fresh sampler because the old WeakMap entry's
 * sampler will self-clear on its next tick and never write state again.
 *
 * If a test needs synchronous teardown (e.g. to assert no extra warns
 * fire after reset within the same tick), call this AND assert that
 * `_publishRateConfig.enabled` is false; samplers short-circuit on the
 * disabled flag without doing any work.
 */
export function _resetPublishRateWarning() {
	_publishRateWarned.clear();
	_publishRateEpoch++;
}

/**
 * Get cached ctx helper methods for a platform.
 * Avoids creating new closures on every RPC call.
 * @param {import('svelte-adapter-uws').Platform} platform
 * @returns {{ publish: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function }}
 */
function _getCtxHelpers(platform) {
	let helpers = _ctxHelpersCache.get(platform);
	if (!helpers) {
		if (_IS_DEV) _activatePublishRateWarning(platform);
		// Per-platform microtask-scoped batch buffer. Every ctx.publish() that
		// can route through platform.publishBatched (no per-topic coalesce or
		// sendCoalesced fanout) is queued here; the buffer drains in one
		// queueMicrotask and is handed to the adapter as a single batched
		// frame, fanning out as one WebSocket frame per subscriber. The
		// adapter handles capability negotiation and per-event fallback for
		// non-batch-capable subscribers, so the call is always safe.
		/** @type {Array<{ topic: string, event: string, data: any, options: any }> | null} */
		let pendingBatch = null;
		const _hasBatched = typeof /** @type {any} */ (platform).publishBatched === 'function';
		const _flushBatch = () => {
			const batch = pendingBatch;
			pendingBatch = null;
			if (batch && batch.length > 0) /** @type {any} */ (platform).publishBatched(batch);
		};
		const publish = function publish(topic, event, data, options) {
			// Reserve the `__` prefix for framework-internal channels
			// (`__signal:userId`, `__rpc`, `__upload`, plugin `__presence:*` /
			// `__group:*` / `__replay:*`). User code that publishes to those
			// channels can spoof framework-internal frames; combined with the
			// wire-side block on subscribing to system topics, the only
			// legitimate publisher of internal channels is the framework
			// itself via the lower-level `platform.publish(...)`. Apps that
			// genuinely need to broadcast on a `__`-prefixed topic should
			// reach for the unwrapped `platform.publish` directly so the
			// intent is explicit at the call site.
			if (typeof topic === 'string' && topic.length >= 2 && topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
				throw new LiveError(
					'INVALID_TOPIC',
					"ctx.publish() refuses '__'-prefixed topics; those are reserved for " +
					'framework-internal channels. Use platform.publish(...) directly if ' +
					'you genuinely need to broadcast on a system channel.'
				);
			}
			// Volatile option translation. Per-call `options.volatile` or a
			// topic registered as volatile turns into `seq: false` on the wire
			// so reconnect with `lastSeenSeq` won't try to backfill the gap.
			// Wire-level drop-on-backpressure is the adapter's job
			// (uWS maxBackpressure auto-skips backpressured subscribers); this
			// only governs seq stamping and intent declaration. The check
			// short-circuits when no caller passes volatile and no stream
			// registered it - no alloc on the common case.
			let finalOptions = options;
			if ((options && options.volatile) || (_topicVolatile.size > 0 && _topicVolatile.has(topic))) {
				finalOptions = { ...(options || {}), seq: false };
			}
			// Reset the staleness watchdog: a publish proves the topic is
			// live, so the silence clock restarts. The size check makes
			// this free for apps that don't use staleAfterMs.
			if (_topicStaleWatch.size > 0) _resetStaleTimer(topic);
			// Mark the topic as live for the silent-topic dev warning.
			// One Map.size check on the publish hot path; constant-folded
			// in production builds via the _IS_DEV gate when the registry
			// is never armed.
			if (_silentTopicWatch.size > 0) _observeSilentTopicPublish(topic);
			// Topic-driven invalidation: every publish whose topic matches
			// a registered `invalidateOn` pattern triggers a loader re-run
			// for the watching stream. Skipped for `refreshed` events --
			// those are emitted BY the reload itself, so honoring them
			// would loop. Size-zero short-circuit keeps this free for apps
			// that don't use the feature.
			if (_topicInvalidationWatch.size > 0 && event !== 'refreshed') {
				for (const entry of _topicInvalidationWatch.values()) {
					// Literal-prefix fast-fail: cheap startsWith filters the
					// majority of unrelated patterns before we touch the
					// regex engine. For `prefix*` patterns the regex is
					// equivalent to startsWith + at-least-one-more-char, so
					// we skip it entirely on the common case.
					if (entry.prefix && !topic.startsWith(entry.prefix)) continue;
					if (entry.prefixOnly) {
						if (topic.length <= entry.prefix.length) continue;
					} else if (!entry.regex.test(topic)) continue;
					for (const watcher of entry.watchers) _invalidationReload(watcher);
				}
			}
			// Fast path: no per-topic feature registry hits and adapter exposes
			// publishBatched -> queue for microtask flush. The cross-worker
			// relay already coalesces per-microtask postMessages; this lifts
			// the same idea to the wire level so subscribers receive ONE frame
			// per microtask containing every event they're entitled to.
			if (_topicCoalesce.size === 0 && _topicTransform.size === 0) {
				// Replay-eligible topics route through `platform.replay.publish`
				// so the bounded buffer captures the event for gap-fill on
				// resume. The replay extension calls `platform.publish`
				// internally, so the local broadcast still happens. Cannot
				// batch through publishBatched in this case -- the extension's
				// per-call write is what stamps the seq envelope.
				if (_maybeReplayPublish(platform, topic, event, data)) return true;
				if (!_hasBatched) return platform.publish(topic, event, data, finalOptions);
				if (!pendingBatch) {
					pendingBatch = [];
					microtask(_flushBatch);
				}
				pendingBatch.push({ topic, event, data, options: finalOptions });
				return true;
			}
			const c = _topicCoalesce.get(topic);
			const t = _topicTransform.get(topic);
			// coalesceBy reads the ORIGINAL data (before transform) so the key
			// extractor sees the un-projected fields it was written against.
			// Throws are routed to the registered stream's onError (if any),
			// dropping the publish silently. Without an observer, the throw
			// propagates so apps that haven't opted into the observer pattern
			// still see failures.
			let coalesceKey;
			if (c) {
				try {
					coalesceKey = c.coalesceBy(data);
				} catch (err) {
					if (c.onError) {
						try { c.onError(err, null, topic); } catch {}
						return false;
					}
					throw err;
				}
			}
			// Transform produces the wire data once - applied here, before
			// fan-out, so every subscriber sees the same projected shape.
			// Throws are routed to the registered stream's onError (if any).
			// With an observer set, the publish is dropped silently (return
			// false) - transform failure means the wire data is invalid, so
			// fanning out wouldn't help. Without an observer, the throw
			// propagates so apps that haven't opted into the observer pattern
			// still see failures.
			let wireData;
			if (t) {
				try {
					wireData = t.transform(data);
				} catch (err) {
					if (t.onError) {
						try { t.onError(err, null, topic); } catch {}
						return false;
					}
					throw err;
				}
			} else {
				wireData = data;
			}
			if (!c) {
				// Transform-only topic: stays on the queued batched path,
				// unless replay-eligible -- then route per-call so the
				// extension can stamp the seq envelope before broadcast.
				if (_maybeReplayPublish(platform, topic, event, wireData)) return true;
				if (!_hasBatched) return platform.publish(topic, event, wireData, finalOptions);
				if (!pendingBatch) {
					pendingBatch = [];
					microtask(_flushBatch);
				}
				pendingBatch.push({ topic, event, data: wireData, options: finalOptions });
				return true;
			}
			// coalesceBy topic: per-ws sendCoalesced replacement. Distinct
			// adapter primitive (latest-value-wins per-ws-per-key); not folded
			// into publishBatched because the two have incompatible wire
			// shapes (separate per-subscriber Map vs shared batched frame).
			const fullKey = topic + '\0' + (coalesceKey == null ? '' : coalesceKey);
			let last = true;
			for (const ws of c.ws) {
				last = platform.sendCoalesced(ws, { key: fullKey, topic, event, data: wireData });
			}
			return last;
		};
		helpers = {
			publish,
			publishThrottled: (...args) => {
				_checkPublishHelperArgs('publishThrottled', args);
				return _throttlePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			publishDebounced: (...args) => {
				_checkPublishHelperArgs('publishDebounced', args);
				return _debouncePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			throttle: (...args) => {
				if (_IS_DEV && !_throttleDeprecatedWarned) {
					_throttleDeprecatedWarned = true;
					console.warn(
						'[svelte-realtime] ctx.throttle is deprecated -- rename to ctx.publishThrottled. ' +
						'The old name reads like a handler gate, but it is a 4-arg publish helper. ' +
						'For per-key handler gating use ctx.skip(key, ms); the publish-helper behaviour ' +
						'is unchanged. This warning fires once per process.\n' +
						'  See: https://svti.me/publish-throttled'
					);
				}
				_checkPublishHelperArgs('throttle', args);
				return _throttlePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			debounce: (...args) => {
				if (_IS_DEV && !_debounceDeprecatedWarned) {
					_debounceDeprecatedWarned = true;
					console.warn(
						'[svelte-realtime] ctx.debounce is deprecated -- rename to ctx.publishDebounced. ' +
						'The old name reads like a handler gate, but it is a 4-arg publish helper. ' +
						'For per-key handler gating use ctx.skip(key, ms); the publish-helper behaviour ' +
						'is unchanged. This warning fires once per process.\n' +
						'  See: https://svti.me/publish-debounced'
					);
				}
				_checkPublishHelperArgs('debounce', args);
				return _debouncePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			signal: (userId, event, data) => {
				const reason = _validUserIdReason(userId);
				if (reason !== null) throw new LiveError('INVALID_USER_ID', 'ctx.signal: ' + reason);
				return platform.publish('__signal:' + userId, event, data);
			},
			batch: (messages) => platform.batch ? platform.batch(messages) : messages.forEach((m) => publish(m.topic, m.event, m.data, m.options)),
			shed: (className) => _shouldShed(platform, className),
			skip: (key, ms) => _skipGate(key, ms)
		};
		_ctxHelpersCache.set(platform, helpers);
	}
	return helpers;
}

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
			if (_topicWsCounts.size >= _topicWsCountsWarnThreshold && !_topicWsCountsWarnFired) {
				_topicWsCountsWarnFired = true;
				console.warn(
					"[svelte-realtime] topic-subscribers index reached TOPIC_WS_COUNTS_WARN_THRESHOLD=" + _topicWsCountsWarnThreshold + " distinct topics.\n" +
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
	if (_metricsInstruments) _metricsInstruments.streamGauge.inc();
}

/**
 * Record RPC metrics for any exit path. Call exactly once per RPC.
 * @param {string} path
 * @param {string} code - error code, or empty string for success
 * @param {number} startTime - from monotonicNow(), or 0 to skip duration
 */
function _recordRpcMetrics(path, code, startTime) {
	if (!_metricsInstruments) return;
	const status = code ? 'error' : 'ok';
	_metricsInstruments.rpcCount.inc({ path, status });
	if (code) _metricsInstruments.rpcErrors.inc({ path, code });
	if (startTime) _metricsInstruments.rpcDuration.observe({ path }, (monotonicNow() - startTime) / 1000);
}

/** @type {WeakSet<object>} Sockets currently in rollback (skips grace period in presence) */
const _rollingBack = new WeakSet();

function _rollbackStreamSubscribe(ws, topic, fn, ctx) {
	try { ws.unsubscribe(topic); } catch {}
	if (_metricsInstruments) _metricsInstruments.streamGauge.dec();
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
 * Build a ctx object with a stable V8 hidden class.
 * All call sites must use this factory to ensure monomorphic property access.
 * Same property count, same order, same types at each slot -> single hidden class.
 * @param {any} user
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ publish: Function, publishThrottled: Function, publishDebounced: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function, skip: Function }} helpers
 * @param {any} cursor
 * @param {string | null} [idempotencyKey] Envelope-supplied idempotency key, or null. Internal use only.
 * @returns {any}
 */
function _buildCtx(user, ws, platform, helpers, cursor, idempotencyKey) {
	return {
		user,
		ws,
		platform,
		publish: helpers.publish,
		cursor,
		publishThrottled: helpers.publishThrottled,
		publishDebounced: helpers.publishDebounced,
		throttle: helpers.throttle,
		debounce: helpers.debounce,
		signal: helpers.signal,
		batch: helpers.batch,
		shed: helpers.shed,
		skip: helpers.skip,
		requestId: platform.requestId,
		// Clock and RNG come from the adapter platform's injectable runtime when
		// present, so a loader/handler reads the same swappable source a seeded
		// harness controls (ctx.now(), ctx.random.uuid(), etc.). Older adapters
		// and mock platforms without them fall back to the framework's own
		// runtime helpers, so the surface is always populated.
		now: (platform && platform.now) || runtimeNow,
		random: (platform && platform.random) || _runtimeRandom,
		// Hybrid logical clock for events that must order consistently across
		// workers (or across a coarse / briefly-backward wall clock). Comes
		// from the adapter platform when it projects one, so a loader/handler
		// reads the same swappable source a seeded harness controls; older
		// adapters and mock platforms fall back to the framework's own
		// runtime-backed stamp of the same {wall, logical, nodeId} shape.
		hlc: (platform && platform.hlc) || _localHlc,
		_idempotencyKey: idempotencyKey || null
	};
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

/** @type {Map<string, { prev: number, curr: number, windowStart: number, windowMs: number }>} */
const _rateLimits = new Map();

/** @type {number} */
let _rateLimitLastSweep = runtimeNow();

/** Hard cap on rate limit buckets to prevent memory exhaustion */
const _RATE_LIMIT_MAX = 5000;

/**
 * Sliding-window rate-limit bucket consume. Mutates the shared `_rateLimits` map.
 * Returns `{ ok: true }` on accept, `{ ok: false, retryAfter }` on reject.
 * Throws `LiveError('RATE_LIMITED', ...)` only when bucket-cap is exhausted
 * (memory-pressure escape hatch). Shared by per-handler `live.rateLimit` and
 * registry `live.rateLimits` configs.
 *
 * @param {string} bucketKey
 * @param {number} points
 * @param {number} windowMs
 * @returns {{ ok: boolean, retryAfter?: number }}
 */
function _consumeRateLimitBucket(bucketKey, points, windowMs) {
	const now = runtimeNow();

	// Lazy sweep: prune stale entries every 30s, sweep all entries
	if (now - _rateLimitLastSweep > 30000) {
		_rateLimitLastSweep = now;
		for (const [k, bucket] of _rateLimits) {
			if (now - bucket.windowStart >= bucket.windowMs * 2) {
				_rateLimits.delete(k);
			}
		}
	}

	let bucket = _rateLimits.get(bucketKey);

	// Hard cap on new buckets only - existing identities always pass through
	if (!bucket && _rateLimits.size >= _RATE_LIMIT_MAX) {
		for (const [k, b] of _rateLimits) {
			if (now - b.windowStart >= b.windowMs * 2) _rateLimits.delete(k);
		}
		if (_rateLimits.size >= _RATE_LIMIT_MAX) {
			throw new LiveError('RATE_LIMITED', 'Too many concurrent rate-limit identities');
		}
	}
	if (!bucket) {
		bucket = { prev: 0, curr: 0, windowStart: now, windowMs };
		_rateLimits.set(bucketKey, bucket);
	}

	// Rotate windows if needed
	const elapsed = now - bucket.windowStart;
	if (elapsed >= windowMs * 2) {
		bucket.prev = 0;
		bucket.curr = 0;
		bucket.windowStart = now;
	} else if (elapsed >= windowMs) {
		bucket.prev = bucket.curr;
		bucket.curr = 0;
		bucket.windowStart += windowMs;
	}

	// Estimate count in sliding window using weighted average
	const windowElapsed = now - bucket.windowStart;
	const weight = Math.max(0, 1 - windowElapsed / windowMs);
	const estimated = bucket.prev * weight + bucket.curr;

	if (estimated >= points) {
		return { ok: false, retryAfter: Math.ceil(windowMs - windowElapsed) };
	}

	bucket.curr++;
	return { ok: true };
}

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
 * Dev-mode warn dedup for fire-and-forget calls against non-volatile
 * handlers. Bounded so a script-driven barrage doesn't anchor unbounded
 * memory; first 256 distinct paths warn once each, then quiet.
 * @type {Set<string>}
 */
const _volatileWarnSet = new Set();
const _VOLATILE_WARN_CAP = 256;

/**
 * Wraps a live() function with a sliding window rate limiter.
 *
 * @param {{ points: number, window: number, key?: (ctx: any) => string }} config
 * @param {Function} fn - Handler function (ctx, ...args)
 * @returns {Function}
 */
live.rateLimit = function rateLimit(config, fn) {
	const { points, window: windowMs } = config;
	const keyFn = config.key || ((ctx) => _getIdentityKey(ctx));

	const wrapper = async function rateLimitedWrapper(ctx, ...args) {
		const userKey = keyFn(ctx);
		const bucketKey = /** @type {any} */ (wrapper).__rateLimitPath + '\0' + userKey;
		const result = _consumeRateLimitBucket(bucketKey, points, windowMs);
		if (!result.ok) {
			const err = new LiveError('RATE_LIMITED', 'Too many requests');
			/** @type {any} */ (err).retryAfter = result.retryAfter;
			throw err;
		}
		return fn(ctx, ...args);
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isRateLimited = true;
	/** @type {any} */ (wrapper).__rateLimitPath = '';
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Registry-level rate-limit config: default applies to every RPC path that
 * doesn't have a per-handler `live.rateLimit(...)` wrapper, with per-path
 * overrides and per-path opt-outs. Stream subscribes are not rate-limited
 * by this primitive.
 *
 * @type {{ default: { points: number, window: number } | null, overrides: Map<string, { points: number, window: number }>, exempt: Set<string> } | null}
 */
let _rateLimitConfig = null;

/**
 * Configure registry-level rate limits. Pass `null` to clear.
 *
 * @example
 * live.rateLimits({
 *   default: { points: 200, window: 10_000 },
 *   overrides: {
 *     'chat/sendMessage': { points: 50, window: 10_000 },
 *     'orders/create':    { points: 5,  window: 60_000 }
 *   },
 *   exempt: ['presence/moveCursor', 'cursor/move']
 * });
 *
 * Resolution order (per RPC call):
 *   1. Path is in `exempt` -> no rate limit.
 *   2. Path has a per-handler `live.rateLimit(...)` wrapping -> per-handler
 *      rule applies (this registry is bypassed entirely for that path).
 *   3. Path is in `overrides` -> override config applies.
 *   4. `default` is set -> default applies.
 *   5. Otherwise -> no rate limit.
 *
 * @param {{ default?: { points: number, window: number } | null, overrides?: Record<string, { points: number, window: number }>, exempt?: string[] } | null} config
 */
live.rateLimits = function rateLimits(config) {
	if (config === null) {
		_rateLimitConfig = null;
		return;
	}
	if (!config || typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.rateLimits: config must be an object or null');
	}
	const validateRule = (rule, label) => {
		if (!rule || typeof rule !== 'object') throw new Error(`[svelte-realtime] live.rateLimits: ${label} must be an object`);
		if (typeof rule.points !== 'number' || rule.points <= 0) throw new Error(`[svelte-realtime] live.rateLimits: ${label}.points must be a positive number`);
		if (typeof rule.window !== 'number' || rule.window <= 0) throw new Error(`[svelte-realtime] live.rateLimits: ${label}.window must be a positive number (ms)`);
	};
	const def = config.default ? { points: config.default.points, window: config.default.window } : null;
	if (def) validateRule(def, 'default');
	const overrides = new Map();
	if (config.overrides) {
		if (typeof config.overrides !== 'object') throw new Error('[svelte-realtime] live.rateLimits: overrides must be an object keyed by path');
		for (const [path, rule] of Object.entries(config.overrides)) {
			validateRule(rule, `overrides[${path}]`);
			overrides.set(path, { points: rule.points, window: rule.window });
		}
	}
	const exempt = new Set();
	if (config.exempt) {
		if (!Array.isArray(config.exempt)) throw new Error('[svelte-realtime] live.rateLimits: exempt must be an array of paths');
		for (const p of config.exempt) {
			if (typeof p !== 'string') throw new Error('[svelte-realtime] live.rateLimits: exempt entries must be strings');
			exempt.add(p);
		}
	}
	_rateLimitConfig = { default: def, overrides, exempt };
};

/**
 * Resolve the registry-level rate-limit rule for a given path, or null if none.
 * Returns null if the path is exempt OR no default/override is configured.
 * Caller is responsible for skipping when the handler has its own per-handler
 * rate-limit wrapper (`fn.__isRateLimited`).
 * @param {string} path
 * @returns {{ points: number, window: number } | null}
 */
function _resolveRegistryRateLimit(path) {
	if (!_rateLimitConfig) return null;
	if (_rateLimitConfig.exempt.has(path)) return null;
	const override = _rateLimitConfig.overrides.get(path);
	if (override) return override;
	return _rateLimitConfig.default;
}

/** Test-only reset of the registry rate-limit config. */
export function _resetRateLimits() {
	_rateLimitConfig = null;
	_rateLimits.clear();
}

/**
 * Configure the dev-mode publish-rate warning. Pass `false` to disable
 * entirely; pass `{ threshold, intervalMs }` to override the defaults
 * (200 events/sec, sampled every 5000 ms). Pass `true` (or omit args
 * entirely; default is on) to re-enable with current settings.
 *
 * The warning fires once per topic per process when a topic's measured
 * publish rate (read from `platform.pressure.topPublishers`) crosses the
 * threshold within a sample window. Hard-gated to development builds --
 * production has zero cost regardless of configuration.
 *
 * @example
 * // Disable entirely (e.g. CLI tooling that uses live() without a UI):
 * live.publishRateWarning(false);
 *
 * @example
 * // Lower the bar for noisier insight:
 * live.publishRateWarning({ threshold: 50 });
 *
 * @example
 * // Sample more frequently (5s default is conservative):
 * live.publishRateWarning({ threshold: 200, intervalMs: 1000 });
 *
 * @param {false | true | { threshold?: number, intervalMs?: number }} [config]
 */
live.publishRateWarning = function publishRateWarning(config) {
	if (config === false) {
		_publishRateConfig.enabled = false;
		// Existing samplers self-clear on their next fire via the
		// `_publishRateConfig.enabled` check at the top of the callback.
		// Bumping the epoch is belt-and-suspenders: a sampler whose
		// callback is in flight when the flag flips still sees the
		// epoch mismatch on its NEXT scheduled fire. Worst case is one
		// stale interval (default 5s) before the timer goes idle.
		_publishRateEpoch++;
		return;
	}
	if (config === undefined || config === true) {
		_publishRateConfig.enabled = true;
		return;
	}
	if (typeof config !== 'object' || config === null) {
		throw new Error('[svelte-realtime] live.publishRateWarning: config must be true, false, or an object');
	}
	if (config.threshold !== undefined) {
		if (typeof config.threshold !== 'number' || config.threshold <= 0 || !Number.isFinite(config.threshold)) {
			throw new Error('[svelte-realtime] live.publishRateWarning: threshold must be a positive finite number (events/sec)');
		}
		_publishRateConfig.threshold = config.threshold;
	}
	if (config.intervalMs !== undefined) {
		if (typeof config.intervalMs !== 'number' || config.intervalMs <= 0 || !Number.isFinite(config.intervalMs)) {
			throw new Error('[svelte-realtime] live.publishRateWarning: intervalMs must be a positive finite number (ms)');
		}
		_publishRateConfig.intervalMs = config.intervalMs;
	}
	_publishRateConfig.enabled = true;
};

/**
 * Configure the dev-mode silent-topic warning. When a stream subscribes to a
 * topic and no events arrive within `thresholdMs`, log a one-shot warning
 * naming the topic and the common causes (missing pg_notify trigger,
 * missing handler-side `ctx.publish()`, intentionally low-traffic topic).
 *
 * Pass `false` to disable; pass `true` (or omit args) to re-enable with
 * current settings; pass `{ thresholdMs?, suppress? }` to override.
 * `suppress` is an array of topic strings the warning will skip
 * unconditionally (use for topics you know are intentionally quiet).
 *
 * Topics starting with `__` (system topics: `__realtime`, `__signal:*`,
 * `__custom`) are always skipped automatically; you don't need to add
 * them to `suppress`.
 *
 * Hard-gated to development. Production has zero cost regardless of
 * configuration: the activation gate (`_IS_DEV`) is constant-folded by
 * Vite/Rollup so the watchdog state is never touched.
 *
 * @example
 * // Disable globally (e.g. in CI where stream emptiness is expected):
 * live.silentTopicWarning(false);
 *
 * @example
 * // Lower the bar for noisier insight:
 * live.silentTopicWarning({ thresholdMs: 5000 });
 *
 * @example
 * // Suppress per-topic for known-quiet streams:
 * live.silentTopicWarning({ suppress: ['admin:audit', 'cron:reports'] });
 *
 * @param {false | true | { thresholdMs?: number, suppress?: string[] }} [config]
 */
live.silentTopicWarning = function silentTopicWarning(config) {
	if (config === false) {
		_silentTopicConfig.enabled = false;
		// Disable takes effect immediately: clear any armed timers.
		for (const entry of _silentTopicWatch.values()) clearTimer(entry.timerId);
		_silentTopicWatch.clear();
		return;
	}
	if (config === undefined || config === true) {
		_silentTopicConfig.enabled = true;
		return;
	}
	if (typeof config !== 'object' || config === null) {
		throw new Error('[svelte-realtime] live.silentTopicWarning: config must be true, false, or an object');
	}
	if (config.thresholdMs !== undefined) {
		if (typeof config.thresholdMs !== 'number' || config.thresholdMs <= 0 || !Number.isFinite(config.thresholdMs)) {
			throw new Error('[svelte-realtime] live.silentTopicWarning: thresholdMs must be a positive finite number');
		}
		_silentTopicConfig.thresholdMs = config.thresholdMs;
	}
	if (config.suppress !== undefined) {
		if (!Array.isArray(config.suppress)) {
			throw new Error('[svelte-realtime] live.silentTopicWarning: suppress must be an array of topic strings');
		}
		for (const topic of config.suppress) {
			if (typeof topic !== 'string') {
				throw new Error('[svelte-realtime] live.silentTopicWarning: suppress entries must be strings');
			}
		}
		_silentTopicConfig.suppress = new Set(config.suppress);
	}
	_silentTopicConfig.enabled = true;
};

/** @type {{ acquire: (key: string, ttlSec: number) => Promise<any> } | null} */
let _defaultIdempotencyStore = null;

/**
 * Lazy in-process idempotency store. Three-state acquire matching the contract
 * of `createIdempotencyStore` from svelte-adapter-uws-extensions, so swapping
 * the default for a multi-instance backend is a one-line change.
 * Bounded by maxEntries; lazy-sweeps expired records every 30s.
 */
function _createInMemoryIdempotencyStore({ maxEntries = 10000 } = {}) {
	/** @type {Map<string, { value: any, expiresAt: number }>} */
	const results = new Map();
	/** @type {Map<string, Promise<any>>} */
	const inflight = new Map();
	let lastSweep = runtimeNow();

	return {
		async acquire(key, ttlSec) {
			const now = runtimeNow();
			if (now - lastSweep >= 30000) {
				lastSweep = now;
				for (const [k, e] of results) {
					if (e.expiresAt <= now) results.delete(k);
				}
			}
			const cached = results.get(key);
			if (cached) {
				if (cached.expiresAt > now) return { result: cached.value };
				results.delete(key);
			}
			while (inflight.has(key)) {
				try { await inflight.get(key); } catch {}
				const re = results.get(key);
				if (re && re.expiresAt > runtimeNow()) return { result: re.value };
			}
			let resolveInflight;
			let rejectInflight;
			const promise = new Promise((res, rej) => { resolveInflight = res; rejectInflight = rej; });
			// Suppress unhandled-rejection logs when there are no waiters at the
			// moment a handler aborts. Real awaiters attach their own handlers
			// via `await inflight.get(key)`.
			promise.catch(() => {});
			inflight.set(key, promise);
			if (results.size >= maxEntries) {
				const drop = Math.max(1, Math.floor(maxEntries * 0.1));
				let i = 0;
				for (const k of results.keys()) {
					results.delete(k);
					if (++i >= drop) break;
				}
			}
			const ttlMs = ttlSec * 1000;
			return {
				acquired: true,
				async commit(value) {
					if (ttlMs > 0) results.set(key, { value, expiresAt: runtimeNow() + ttlMs });
					inflight.delete(key);
					if (resolveInflight) resolveInflight(value);
				},
				async abort() {
					inflight.delete(key);
					if (rejectInflight) rejectInflight(new Error('ABORTED'));
				}
			};
		}
	};
}

function _getDefaultIdempotencyStore() {
	if (_defaultIdempotencyStore) return _defaultIdempotencyStore;
	_defaultIdempotencyStore = _createInMemoryIdempotencyStore();
	return _defaultIdempotencyStore;
}

/**
 * Reset the default in-process idempotency store. Tests only.
 * @internal
 */
export function _resetIdempotencyStore() {
	_defaultIdempotencyStore = null;
}

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

/**
 * Per-key serialization primitive. Mirrors the algorithm in the adapter's
 * Lock plugin (per-key FIFO waiter queue) inline to preserve server.js's
 * no-imports profile. Custom Lock instances passed via `live.lock({ lock })`
 * just need to expose `withLock(key, fn, opts?)` matching the adapter's
 * contract.
 *
 * The `opts.maxWaitMs` field, when set, rejects a queued waiter with a typed
 * `LOCK_TIMEOUT` error if it does not acquire the lock within that many
 * milliseconds. The current holder is not interrupted; only the waiting
 * caller gives up. Subsequent waiters on the same key are unaffected and
 * continue in their original order (`advance` skips cancelled entries).
 *
 * @returns {{ withLock: <T>(key: string, fn: () => T | Promise<T>, opts?: { maxWaitMs?: number }) => Promise<T>, held: (key: string) => boolean, size: () => number, clear: () => void }}
 */
function _createInMemoryLock() {
	/**
	 * @typedef {Object} _Waiter
	 * @property {() => any | Promise<any>} fn
	 * @property {(value: any) => void} resolve
	 * @property {(err: Error) => void} reject
	 * @property {ReturnType<typeof setTimeout> | null} timer
	 * @property {boolean} cancelled
	 */
	/** @type {Map<string, { running: boolean, queue: Array<_Waiter> }>} */
	const states = new Map();

	function advance(key, state) {
		while (state.queue.length > 0) {
			const waiter = /** @type {_Waiter} */ (state.queue.shift());
			// lock.waiter invariant: every queued waiter has resolve+reject
			// captured at push time. Mismatch indicates corrupted queue state.
			assert(typeof waiter.resolve === 'function' && typeof waiter.reject === 'function', 'realtime/lock.waiter.shape', { hasResolve: typeof waiter.resolve === 'function', hasReject: typeof waiter.reject === 'function' });
			if (waiter.cancelled) continue;
			if (waiter.timer != null) {
				clearTimer(waiter.timer);
				waiter.timer = null;
			}
			runHead(key, state, waiter.fn).then(waiter.resolve, waiter.reject);
			return;
		}
		state.running = false;
		states.delete(key);
	}

	async function runHead(key, state, fn) {
		try {
			return await fn();
		} finally {
			advance(key, state);
		}
	}

	return {
		withLock(key, fn, opts) {
			if (typeof key !== 'string' || key.length === 0) {
				return Promise.reject(new Error('lock: key must be a non-empty string'));
			}
			if (typeof fn !== 'function') {
				return Promise.reject(new Error('lock: fn must be a function'));
			}
			const maxWaitMs = opts && opts.maxWaitMs;
			if (maxWaitMs != null) {
				if (typeof maxWaitMs !== 'number' || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
					return Promise.reject(new Error('lock: maxWaitMs must be a non-negative finite number'));
				}
			}

			let state = states.get(key);
			if (!state) {
				state = { running: false, queue: [] };
				states.set(key, state);
			}

			if (!state.running) {
				state.running = true;
				return runHead(key, state, fn);
			}

			return new Promise((resolve, reject) => {
				/** @type {_Waiter} */
				const waiter = { fn, resolve, reject, timer: null, cancelled: false };
				if (maxWaitMs != null) {
					waiter.timer = setTimer(() => {
						if (waiter.cancelled) return;
						waiter.cancelled = true;
						waiter.timer = null;
						const err = /** @type {Error & { code: string, key: string, maxWaitMs: number }} */ (
							new Error("lock: timed out after " + maxWaitMs + "ms waiting for key '" + key + "'")
						);
						err.code = 'LOCK_TIMEOUT';
						err.key = key;
						err.maxWaitMs = maxWaitMs;
						reject(err);
					}, maxWaitMs);
				}
				state.queue.push(waiter);
			});
		},
		held(key) { return states.has(key); },
		size() { return states.size; },
		clear() {
			for (const state of states.values()) {
				for (const waiter of state.queue) {
					if (waiter.cancelled) continue;
					waiter.cancelled = true;
					if (waiter.timer != null) {
						clearTimer(waiter.timer);
						waiter.timer = null;
					}
					const err = /** @type {Error & { code: string }} */ (new Error('lock: cleared'));
					err.code = 'LOCK_CLEARED';
					waiter.reject(err);
				}
			}
			states.clear();
		}
	};
}

/** @type {ReturnType<typeof _createInMemoryLock> | null} */
let _defaultLock = null;

function _getDefaultLock() {
	if (_defaultLock) return _defaultLock;
	_defaultLock = _createInMemoryLock();
	return _defaultLock;
}

/**
 * Reset the default in-process lock. Tests only.
 * @internal
 */
export function _resetLock() {
	if (_defaultLock) _defaultLock.clear();
	_defaultLock = null;
}

/**
 * Allowed config-object fields per wrapper. Kept in sync with the JSDoc of
 * each wrapper's config parameter; any unknown field at the call site
 * throws with a "did you mean..." hint mapped from `_*_CONFIG_HINTS`.
 *
 * Why this matters: `live.idempotent` uses `keyFrom` while `live.lock` uses
 * `key`; without unknown-field validation, a caller mirroring the other
 * helper's shape would silently fall through to the default code path
 * (idempotent: no key -> bypass cache; lock: no key -> different error).
 * Either way the caller's intended one-per-key guarantee silently breaks.
 * The hint table converts a 20-min debug into a 2-second eye-scan.
 */
const _IDEMPOTENT_CONFIG_FIELDS = ['keyFrom', 'store', 'ttl'];
const _IDEMPOTENT_CONFIG_HINTS = {
	key: "live.lock uses 'key' but live.idempotent uses 'keyFrom' (the names diverged historically)"
};
const _LOCK_CONFIG_FIELDS = ['key', 'lock', 'maxWaitMs'];
const _LOCK_CONFIG_HINTS = {
	keyFrom: "live.idempotent uses 'keyFrom' but live.lock uses 'key' (which accepts a string OR a function)"
};

/**
 * Throw on any field in `cfg` not in `allowed`. Suggestions from `hints`
 * (when present) include a one-line cross-helper note for the common
 * "I mirrored the wrong helper's shape" case.
 *
 * @param {string} helperName e.g. 'live.idempotent'
 * @param {Record<string, any>} cfg The user's config object.
 * @param {string[]} allowed
 * @param {Record<string, string>} hints
 */
function _assertConfigShape(helperName, cfg, allowed, hints) {
	for (const k of Object.keys(cfg)) {
		if (allowed.includes(k)) continue;
		const hint = hints[k];
		const suffix = hint ? ' Hint: ' + hint + '.' : '';
		throw new Error(
			'[svelte-realtime] ' + helperName + ": unknown config field '" + k +
			"'. Allowed: " + allowed.join(', ') + '.' + suffix
		);
	}
}

/**
 * Wrap an RPC handler with idempotency: identical calls (by key) return the
 * cached result without re-running the handler. Composes with live(),
 * live.validated(), live.rateLimit(), etc.
 *
 * The key is derived from `config.keyFrom(ctx, ...args)` if provided, otherwise
 * from the client envelope's `idempotencyKey` (set via the client's
 * `rpc.with({ idempotencyKey })` helper). When neither is present, the call
 * runs as if the wrapper were absent.
 *
 * Only successful results are cached. A throwing handler aborts the slot so
 * the next caller re-runs.
 *
 * Default store is in-process (bounded). For multi-instance deployments,
 * pass `store: createIdempotencyStore(redis)` from svelte-adapter-uws-extensions.
 *
 * @param {{ keyFrom?: (ctx: any, ...args: any[]) => string | null | undefined, store?: { acquire: (key: string, ttlSec: number) => Promise<any> }, ttl?: number }} config
 * @param {Function} fn Handler function (ctx, ...args)
 * @returns {Function}
 */
live.idempotent = function idempotent(config, fn) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.idempotent(config, fn) requires a handler function');
	}
	const cfg = config || {};
	_assertConfigShape('live.idempotent', cfg, _IDEMPOTENT_CONFIG_FIELDS, _IDEMPOTENT_CONFIG_HINTS);
	if (cfg.keyFrom !== undefined && typeof cfg.keyFrom !== 'function') {
		throw new Error('[svelte-realtime] live.idempotent: keyFrom must be a function');
	}
	if (cfg.store !== undefined && (cfg.store === null || typeof cfg.store.acquire !== 'function')) {
		throw new Error('[svelte-realtime] live.idempotent: store must implement acquire(key, ttlSec)');
	}
	if (cfg.ttl !== undefined && (typeof cfg.ttl !== 'number' || cfg.ttl < 0)) {
		throw new Error('[svelte-realtime] live.idempotent: ttl must be a non-negative number of seconds');
	}
	const ttlSec = typeof cfg.ttl === 'number' ? cfg.ttl : 172800;
	const keyFrom = cfg.keyFrom || null;
	const customStore = cfg.store || null;

	const wrapper = async function idempotentWrapper(ctx, ...args) {
		const userKey = keyFrom ? keyFrom(ctx, ...args) : ctx._idempotencyKey;
		if (!userKey) return fn(ctx, ...args);
		// Cap key length at 256 bytes - matches isValidWireTopic and
		// keeps the cache key from growing into a per-attacker memory
		// pressure or a Redis/Postgres B-tree depth amplifier.
		if (typeof userKey !== 'string' || userKey.length > 256) {
			throw new LiveError(
				'INVALID_REQUEST',
				'idempotencyKey must be a string no longer than 256 characters'
			);
		}
		// Namespace the cache key by registered RPC path so the same
		// userKey across different RPCs lands in different slots.
		// Custom keyFrom callbacks must still encode tenant scope
		// explicitly - the framework cannot guess the app's tenant
		// shape - but path-scoping closes the cross-RPC class.
		const path = /** @type {any} */ (wrapper).__idempotencyPath;
		const key = path ? 'rpc:' + path + ':' + userKey : userKey;
		const store = customStore || _getDefaultIdempotencyStore();
		const slot = await store.acquire(key, ttlSec);
		if (slot && slot.acquired) {
			try {
				const data = await fn(ctx, ...args);
				await slot.commit(data);
				return data;
			} catch (err) {
				try { await slot.abort(); } catch {}
				throw err;
			}
		}
		if (slot && slot.pending) {
			throw new LiveError('CONFLICT', 'A request with this idempotency key is already in progress');
		}
		return slot.result;
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isIdempotent = true;
	/** @type {any} */ (wrapper).__idempotency = { keyFrom, store: customStore, ttl: ttlSec };
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Wrap an RPC handler with per-key serialization. Concurrent calls that
 * resolve to the same lock key run one at a time in FIFO order; calls on
 * different keys run in parallel. Composes with `live()`,
 * `live.validated()`, `live.idempotent()`, etc.
 *
 * The key is derived per-call: pass a string for a static lock, or a
 * function `(ctx, ...args) => string | null | undefined` to derive it
 * from the caller's context. A null / undefined key bypasses the lock
 * (the handler runs unguarded for that call).
 *
 * Default lock is in-process and bounded only by your active key set.
 * For multi-instance deployments, pass `lock: createDistributedLock(...)`
 * from `svelte-adapter-uws-extensions/redis/lock`. Any object that
 * exposes `withLock(key, fn, opts?)` matching the adapter's Lock contract
 * works.
 *
 * Pass `maxWaitMs` (in the config-object form) to bound how long a queued
 * caller will wait before giving up. On timeout, the wrapper rejects with
 * `LiveError('LOCK_TIMEOUT', ...)` so the client receives a typed error
 * with `.code === 'LOCK_TIMEOUT'`. The current holder's handler is not
 * interrupted; only the waiting caller gives up. Subsequent waiters on
 * the same key are unaffected and continue in their original order.
 *
 * Use for cron-ish triggers, expensive recompute, single-flight cache
 * fills, and atomic read-modify-write on shared records.
 *
 * @example
 * ```js
 * export const recomputeLeaderboard = live.lock(
 *   (ctx) => `leaderboard:${ctx.user.organization_id}`,
 *   async (ctx) => {
 *     const rows = await db.expensive.recompute(ctx.user.organization_id);
 *     ctx.publish(`org:${ctx.user.organization_id}:leaderboard`, 'set', rows);
 *     return rows;
 *   }
 * );
 * ```
 *
 * @example
 * ```js
 * // Bounded wait: clients calling while the lock is busy give up after 5s
 * // with LiveError('LOCK_TIMEOUT') instead of waiting indefinitely.
 * export const settleInvoice = live.lock(
 *   { key: (ctx, id) => `invoice:${id}`, maxWaitMs: 5000 },
 *   async (ctx, id) => settle(id)
 * );
 * ```
 *
 * @param {string | ((ctx: any, ...args: any[]) => string | null | undefined) | { key: string | ((ctx: any, ...args: any[]) => string | null | undefined), lock?: { withLock: (key: string, fn: () => any, opts?: { maxWaitMs?: number }) => Promise<any> }, maxWaitMs?: number }} keyOrConfig
 * @param {Function} fn Handler function (ctx, ...args)
 * @returns {Function}
 */
live.lock = function lock(keyOrConfig, fn) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.lock(keyOrConfig, fn) requires a handler function');
	}
	let keyFrom;
	let customLock = null;
	let maxWaitMs;
	if (typeof keyOrConfig === 'string') {
		const staticKey = keyOrConfig;
		if (staticKey.length === 0) {
			throw new Error('[svelte-realtime] live.lock: key string must be non-empty');
		}
		keyFrom = () => staticKey;
	} else if (typeof keyOrConfig === 'function') {
		keyFrom = keyOrConfig;
	} else if (keyOrConfig && typeof keyOrConfig === 'object') {
		const cfg = keyOrConfig;
		_assertConfigShape('live.lock', cfg, _LOCK_CONFIG_FIELDS, _LOCK_CONFIG_HINTS);
		if (typeof cfg.key === 'string') {
			const staticKey = cfg.key;
			if (staticKey.length === 0) {
				throw new Error('[svelte-realtime] live.lock: key string must be non-empty');
			}
			keyFrom = () => staticKey;
		} else if (typeof cfg.key === 'function') {
			keyFrom = cfg.key;
		} else {
			throw new Error('[svelte-realtime] live.lock: config.key must be a string or function');
		}
		if (cfg.lock !== undefined) {
			if (!cfg.lock || typeof cfg.lock.withLock !== 'function') {
				throw new Error('[svelte-realtime] live.lock: lock must implement withLock(key, fn)');
			}
			customLock = cfg.lock;
		}
		if (cfg.maxWaitMs !== undefined) {
			if (typeof cfg.maxWaitMs !== 'number' || !Number.isFinite(cfg.maxWaitMs) || cfg.maxWaitMs < 0) {
				throw new Error('[svelte-realtime] live.lock: maxWaitMs must be a non-negative finite number');
			}
			maxWaitMs = cfg.maxWaitMs;
		}
	} else {
		throw new Error('[svelte-realtime] live.lock: first argument must be a key string, key function, or config object');
	}

	const lockOpts = maxWaitMs != null ? { maxWaitMs } : undefined;

	const wrapper = async function lockedWrapper(ctx, ...args) {
		const key = keyFrom(ctx, ...args);
		if (key == null || key === '') return fn(ctx, ...args);
		if (typeof key !== 'string') {
			throw new Error('[svelte-realtime] live.lock: key resolver must return a string (or null/undefined to bypass)');
		}
		const lockInst = customLock || _getDefaultLock();
		try {
			return await lockInst.withLock(key, () => fn(ctx, ...args), lockOpts);
		} catch (err) {
			if (err && /** @type {any} */ (err).code === 'LOCK_TIMEOUT' && !(err instanceof LiveError)) {
				const wrapped = new LiveError('LOCK_TIMEOUT', /** @type {Error} */ (err).message);
				/** @type {any} */ (wrapped).key = /** @type {any} */ (err).key;
				/** @type {any} */ (wrapped).maxWaitMs = /** @type {any} */ (err).maxWaitMs;
				throw wrapped;
			}
			throw err;
		}
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isLocked = true;
	/** @type {any} */ (wrapper).__lockConfig = { keyFrom, lock: customLock, maxWaitMs };
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Optional remote-registry surface used by `live.push` when the userId
 * is not registered on this instance. The connection registry in
 * `svelte-adapter-uws-extensions/redis/registry` conforms to this shape;
 * pass it via `live.configurePush({ remoteRegistry })` to enable
 * cluster-routed push.
 *
 * @type {{ request: (target: string, event: string, data?: any, options?: { timeoutMs?: number }) => Promise<any> } | null}
 */
let _remoteRegistry = null;

/**
 * Configure the push registry. Accepts two independent fields:
 *
 * - `identify` - override how `pushHooks.open` extracts the userId
 *   from a connecting WebSocket. Defaults to reading
 *   `ws.getUserData()?.user_id ?? ws.getUserData()?.userId`. Pass a
 *   function to override; pass `null` (in `config.identify`) to clear.
 * - `remoteRegistry` - an object with a
 *   `request(userId, event, data, options)` method. When supplied,
 *   `live.push({ userId })` falls back to `remoteRegistry.request(...)`
 *   if the userId is not registered on this instance, enabling
 *   cluster-routed push. Pass `null` to clear.
 *
 * The whole-config form `null` clears both slots.
 *
 * **Recommended call site (svelte-adapter-uws >= 0.5.0-next.15):** the
 * `init({ platform })` hook in `hooks.ws.js`, alongside
 * `setCronPlatform`. The Redis client is typically already connected by
 * the time `init` fires, and the hook completes before any `upgrade` /
 * `open` runs - so the cluster-routing path is wired before the first
 * request can reach `live.push`. Calling at module top-level also works
 * but is brittle if your Redis client is created inside an async setup
 * function or behind a module that imports lazily.
 *
 * @param {{ identify?: ((ws: any) => string | null | undefined) | null, remoteRegistry?: { request: Function } | null } | null} config
 *
 * @example
 * ```js
 * // src/hooks.ws.js (recommended call site, adapter next.15+)
 * import { live } from 'svelte-realtime/server';
 * import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';
 *
 * export function init({ platform }) {
 *     const registry = createConnectionRegistry(redis, { identify: (ws) => ws.getUserData()?.userId });
 *     live.configurePush({ remoteRegistry: registry });
 * }
 * ```
 *
 * @example
 * ```js
 * // Identify-only override (no cluster routing). Module top-level is
 * // fine for this case - no async setup involved.
 * import { live } from 'svelte-realtime/server';
 * live.configurePush({ identify: (ws) => ws.getUserData()?.account?.id });
 * ```
 */
live.configurePush = function configurePush(config) {
	if (config === null) {
		_pushIdentify = null;
		_remoteRegistry = null;
		return;
	}
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.configurePush: config must be an object or null');
	}
	if (config.identify === undefined && config.remoteRegistry === undefined) {
		throw new Error('[svelte-realtime] live.configurePush: config must include at least one of identify or remoteRegistry');
	}
	if (config.identify !== undefined) {
		if (config.identify === null) {
			_pushIdentify = null;
		} else if (typeof config.identify !== 'function') {
			throw new Error('[svelte-realtime] live.configurePush: identify must be a function or null');
		} else {
			_pushIdentify = config.identify;
		}
	}
	if (config.remoteRegistry !== undefined) {
		if (config.remoteRegistry === null) {
			_remoteRegistry = null;
		} else if (typeof config.remoteRegistry !== 'object' || typeof config.remoteRegistry.request !== 'function') {
			throw new Error('[svelte-realtime] live.configurePush: remoteRegistry must expose a .request(userId, event, data, options) method');
		} else {
			_remoteRegistry = config.remoteRegistry;
		}
	}
};

/**
 * Hook functions to wire from `hooks.ws.js` so `live.push({ userId })` can
 * route to the right WebSocket. `open` registers the connection in the
 * push registry; `close` deregisters it.
 *
 * @example
 * ```js
 * // hooks.ws.js
 * import { pushHooks } from 'svelte-realtime/server';
 *
 * export const open = pushHooks.open;
 * export const close = pushHooks.close;
 * ```
 *
 * Compose with other hooks by calling pushHooks.open / pushHooks.close
 * inside your own handlers.
 */
export const pushHooks = {
	/**
	 * Register the connection in the push registry. Reads identify(ws)
	 * (defaulting to ws.getUserData()?.user_id / userId) and stores the
	 * { ws, platform } pair keyed by userId. Anonymous connections
	 * (identify returning null/undefined) are silently skipped.
	 *
	 * @param {any} ws
	 * @param {{ platform: any }} ctx
	 */
	open(ws, ctx) {
		if (!ctx || !ctx.platform) {
			throw new Error('[svelte-realtime] pushHooks.open: missing platform on hook context');
		}
		const userId = _getPushIdentify()(ws);
		if (userId == null || userId === '') return;
		const reason = _validUserIdReason(userId);
		if (reason !== null) {
			throw new Error('[svelte-realtime] pushHooks.open: ' + reason + '. identify(ws) must return a non-empty userId string that is safe to embed in a topic name (no control chars / CR / LF / NUL / quotes / backslash, max ' + _MAX_USER_ID_LENGTH + ' chars), or null / undefined for anonymous connections.');
		}
		if (!_pushRegistry.has(userId) && _pushRegistry.size >= _maxPushRegistry) {
			if (!_pushRegistryWarnFired) {
				_pushRegistryWarnFired = true;
				console.warn(
					"[svelte-realtime] push registry reached MAX_PUSH_REGISTRY=" + _maxPushRegistry +
					"; new userIds will not be registered for `live.push({ userId })` until existing entries clear.\n" +
					"  This usually indicates push registrations are not being released on disconnect.\n" +
					"  Check that hooks.ws.js wires `pushHooks.close` and that the upstream identify(ws) is stable per-user.\n" +
					"  See: https://svti.me/push-registry"
				);
			}
			return;
		}
		_pushRegistry.set(userId, { ws, platform: ctx.platform });
		_wsToPushUserId.set(ws, userId);
	},
	/**
	 * Adapter close hook. Drains both the per-userId push registry AND
	 * the realtime stream-subscription bookkeeping (per-topic ws-counts,
	 * silent-topic watchdogs, `__onUnsubscribe` callbacks). Routes through
	 * the module-scope `close` when the adapter passes a `ctx` - which it
	 * always does in production - so a single
	 * `export const close = pushHooks.close` re-export from hooks.ws.js
	 * covers both concerns. Falls back to push-only behavior when called
	 * directly without `ctx` (test setups, custom flows) so the historical
	 * one-arg signature keeps working.
	 *
	 * @param {any} ws
	 * @param {{ platform: any, subscriptions?: any } | undefined} [ctx]
	 */
	close(ws, ctx) {
		if (ctx) {
			// Realtime close drains both stream subscriptions and the push
			// registry. Idempotent across repeat calls and across users
			// who compose pushHooks.close + the realtime close manually --
			// a second pass finds nothing to remove.
			close(ws, ctx);
			return;
		}
		// Direct one-arg call (legacy, tests, custom flows): drain the
		// push registry only. The stream-subscription bookkeeping path
		// requires `ctx.platform` for `__onUnsubscribe` callbacks; without
		// it, the safe behavior is "do what the original signature did."
		const userId = _wsToPushUserId.get(ws);
		if (userId == null) return;
		_wsToPushUserId.delete(ws);
		const entry = _pushRegistry.get(userId);
		// push-registry invariant: if userId was tracked in _wsToPushUserId,
		// the registry should still have an entry for that userId (possibly
		// pointing at a different ws if the user reconnected on another
		// device). Missing entry means an external mutation cleared it.
		assert(entry !== undefined, 'realtime/push-registry.entry-tracked', { userIdLen: userId.length });
		if (entry && entry.ws === ws) _pushRegistry.delete(userId);
	}
};

/**
 * Send a server-initiated request to a connected user and await the reply.
 *
 * Lookup order:
 * 1. **Remote registry (when configured)** - the optional `remoteRegistry`
 *    set via `live.configurePush({ remoteRegistry })` is the cluster-wide
 *    source of truth for "which instance currently owns this userId" (most-
 *    recently-opened wins via the registry's last-write-wins userToInstance
 *    map). `live.push` delegates to `remoteRegistry.request(userId, ...)`
 *    so the recipient is deterministic regardless of which instance the
 *    caller runs on. The registry's own self-targeting short-circuit
 *    (`registry.js: ownerInstanceId === instanceId`) means no extra Redis
 *    hop when the canonical owner IS this instance -- single-tab
 *    performance is unchanged.
 * 2. **Local registry (fallback)** - the per-userId Map populated by
 *    `pushHooks.open` / `pushHooks.close`. When no `remoteRegistry` is
 *    configured (single-instance dev), this is the only path. When a
 *    `remoteRegistry` IS configured, the local entry is used only as a
 *    best-effort fallback on the brief race window where `pushHooks.open`
 *    has populated the local map but the cluster pub/sub event has not
 *    yet propagated to this instance's index.
 *
 * Returns whatever the client's `onPush(event, handler)` returns.
 *
 * Error surface (all `LiveError` with discriminating `.code`):
 * - `VALIDATION` - bad target / event / options / timeoutMs at the call site.
 * - `NOT_FOUND` - no connection registered for the userId (and no
 *   `remoteRegistry` is configured).
 * - `TIMEOUT` - the recipient did not reply within `timeoutMs`. Wraps
 *   the underlying `'request timed out'` Error from the adapter (and
 *   any remote-registry shape that rejects with the same wording);
 *   message text is preserved verbatim on `.message` and the original
 *   error on `.cause`.
 *
 * Other rejection sources pass through unchanged: a recipient handler
 * that throws (caller-defined error), `Error('connection closed')`
 * from the adapter when the ws closes mid-flight, or any non-timeout
 * error from a configured `remoteRegistry` (e.g. an offline rejection
 * when the user has no active connection cluster-wide).
 *
 * Multi-device users see most-recent-connection-wins routing within
 * each instance, and cluster-wide most-recent-wins via the registry's
 * Redis hash.
 *
 * Requires `svelte-adapter-uws` >= 0.5.0-next.4 for `platform.request`.
 *
 * @param {{ userId: string }} target
 * @param {string} event
 * @param {any} [data]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 *
 * @example
 * ```js
 * // Inside an admin RPC handler:
 * const reply = await live.push(
 *   { userId: 'u-123' },
 *   'confirm-delete',
 *   { itemId: 42 },
 *   { timeoutMs: 30_000 }
 * );
 * if (reply.confirmed) await actuallyDelete(42);
 * ```
 *
 * @example
 * ```js
 * // hooks.ws.js - wire the local registry once:
 * import { pushHooks } from 'svelte-realtime/server';
 * export const open = pushHooks.open;
 * export const close = pushHooks.close;
 * ```
 *
 * @example
 * ```js
 * // For cluster routing, also wire the extensions connection registry:
 * import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';
 * const registry = createConnectionRegistry(redis, { identify: (ws) => ws.getUserData()?.userId });
 * live.configurePush({ remoteRegistry: registry });
 * ```
 */
live.push = async function push(target, event, data, options) {
	if (!target || typeof target !== 'object') {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: target must be an object like { userId }');
	}
	if (typeof event !== 'string' || event.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: event must be a non-empty string');
	}
	if (options !== undefined && options !== null) {
		if (typeof options !== 'object') {
			throw new LiveError('VALIDATION', '[svelte-realtime] live.push: options must be an object');
		}
		if (options.timeoutMs !== undefined) {
			if (typeof options.timeoutMs !== 'number' || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
				throw new LiveError('VALIDATION', '[svelte-realtime] live.push: options.timeoutMs must be a positive finite number. For fire-and-forget delivery, use `live.notify(target, event, data)` instead.');
			}
		}
	}

	const targetKeys = Object.keys(target);
	const extraKeys = targetKeys.filter((k) => k !== 'userId');
	if (extraKeys.length > 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: unsupported target keys: ' + extraKeys.join(', '));
	}
	const userId = /** @type {any} */ (target).userId;
	if (typeof userId !== 'string' || userId.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: target.userId must be a non-empty string');
	}

	// Cluster-first when a remoteRegistry is configured: the registry's
	// userToInstance map is the cluster-wide canonical-owner truth (most-
	// recent open wins per its last-write-wins applyOpenEvent). The
	// registry's own self-targeting short-circuit means no extra Redis
	// hop when the canonical owner is THIS instance -- single-tab perf
	// is unchanged. Multi-tab same-user across instances now routes
	// deterministically to the cluster-canonical recipient regardless of
	// which instance the caller runs on, matching the documented
	// "cluster-wide most-recent-wins" contract above.
	//
	// On a brief registry-offline race (fresh local open whose cluster
	// pub/sub event has not yet propagated to this instance's index),
	// fall back to the local entry so the just-opened user does not see
	// a NOT_FOUND for their own push.
	const localEntry = _pushRegistry.get(userId);
	if (_remoteRegistry) {
		try {
			return await _remoteRegistry.request(userId, event, data, options || undefined);
		} catch (err) {
			if (localEntry && _isRegistryOfflineError(err)) {
				// fall through to local fast path below
			} else {
				throw _translatePushError(err);
			}
		}
	}
	if (localEntry) {
		if (typeof localEntry.platform.request !== 'function') {
			throw new Error('[svelte-realtime] live.push: platform.request is not available; requires svelte-adapter-uws >= 0.5.0-next.4');
		}
		try {
			return await localEntry.platform.request(localEntry.ws, event, data, options || undefined);
		} catch (err) {
			throw _translatePushError(err);
		}
	}
	throw new LiveError('NOT_FOUND', "no active connection for userId '" + userId + "'");
};

/**
 * Translate a low-level push delivery error into the typed LiveError
 * surface. Today this only catches deadline expiry from the adapter's
 * `platform.request` (`new Error('request timed out')`) and from
 * remote-registry shapes that use the same "timed out" wording, and
 * rethrows as `LiveError('TIMEOUT', ...)` so callers can discriminate
 * via `err.code` instead of substring-matching `err.message`. Other
 * errors (connection-closed, handler-thrown, registry offline, etc.)
 * pass through unchanged so caller-defined error shapes are preserved.
 *
 * Already-typed `LiveError` rejections (e.g. `NOT_FOUND` from a remote
 * registry) also pass through unchanged.
 *
 * Message text is preserved verbatim on the wrapped error so any
 * existing substring callers continue to match while they migrate to
 * the structured code. The original error is attached as `.cause`.
 *
 * @param {unknown} err
 * @returns {unknown}
 */
function _translatePushError(err) {
	if (err instanceof LiveError) return err;
	const msg = err && typeof (/** @type {any} */ (err).message) === 'string'
		? /** @type {any} */ (err).message
		: '';
	if (msg && /timed out/i.test(msg)) {
		const wrapped = new LiveError('TIMEOUT', msg);
		/** @type {any} */ (wrapped).cause = err;
		return wrapped;
	}
	return err;
}

/**
 * Detect the "cluster has no entry for this userId" rejection from a
 * configured remoteRegistry. Used by live.push / live.notify to decide
 * whether to fall back to a (potentially fresher) local registry entry
 * during the brief propagation race after `pushHooks.open` writes to
 * Redis + publishes the event but the subscriber index hasn't yet
 * applied it on the current instance.
 *
 * Conservatively substring-matches "offline" -- the extensions
 * registry's exact wording is `registry.request: target user "..." is
 * offline`, and the project's existing test fixtures throw bare
 * `Error('offline')`. Other cluster errors (recipient handler throw,
 * timeout) are real signals and NOT eligible for local fallback so
 * caller-defined error shapes propagate intact.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function _isRegistryOfflineError(err) {
	const msg = err && typeof (/** @type {any} */ (err).message) === 'string'
		? /** @type {any} */ (err).message
		: '';
	return /offline/i.test(msg);
}

/**
 * Bounded internal timeout for the wire-level request that backs
 * `live.notify`. The caller doesn't await the reply - this only
 * controls how long the adapter's per-request tracker holds the entry
 * before reclaiming it. Long enough that a slow client roundtrip
 * doesn't leak; short enough that the tracker doesn't accumulate stale
 * entries under high notify volume. 1s is a deliberate "small but
 * sufficient" pick - can switch to a true noReply primitive in a
 * future adapter bump without changing the live.notify caller API.
 */
const _NOTIFY_INTERNAL_TIMEOUT_MS = 1000;

/**
 * Send a server-initiated event to a connected user without awaiting a
 * reply. The fire-and-forget counterpart to `live.push`.
 *
 * **When to use which:**
 * - `live.push(target, event, data, { timeoutMs })` - request/reply.
 *   You await a value back from the client's `onPush(event, handler)`.
 *   `timeoutMs` controls how long you wait. Throws on offline user,
 *   timeout, client handler error.
 * - `live.notify(target, event, data)` - fire-and-forget. The client's
 *   `onPush(event, handler)` still fires (same wire path), but the
 *   handler's return value is discarded and the call resolves without
 *   waiting for it. Returns `Promise<void>` that resolves once the
 *   envelope is dispatched. Never rejects in normal operation: an
 *   offline user, a remote-registry failure, a client handler that
 *   throws - all silent. The caller chose `notify` exactly because
 *   they don't want to deal with delivery state.
 *
 * Wire shape is identical to `live.push` today; the difference is
 * caller-side semantics (no await, no error surface). When the
 * adapter ships a true no-reply primitive, the internal implementation
 * swaps without changing this caller API.
 *
 * **Don't use `live.push({ timeoutMs: 0 })` for fire-and-forget.** It
 * throws synchronously (timeoutMs must be positive). Wrapping the
 * throw in `.catch(() => {})` silently swallows it - the push never
 * fires, the recipient never sees anything, no diagnostic anywhere.
 * Use `live.notify` instead.
 *
 * @param {{ userId: string }} target
 * @param {string} event
 * @param {any} [data]
 * @returns {Promise<void>}
 *
 * @example
 * ```js
 * // Inside an upload completion handler:
 * live.notify({ userId: upload.userId }, 'upload:complete', { id: upload.id });
 * // Fire-and-forget. Returns immediately. If the user is offline,
 * // silently drops - they'll see the result on next page load.
 * ```
 *
 * @example
 * ```js
 * // Server-side (cron-driven) progress notifications:
 * for (const userId of activeUsers) {
 *   live.notify({ userId }, 'price:tick', { symbol, price });
 * }
 * // No accumulating timeouts to manage; no `Promise.all` rejection
 * // boundary if some users are offline.
 * ```
 */
live.notify = function notify(target, event, data) {
	if (!target || typeof target !== 'object') {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: target must be an object like { userId }');
	}
	if (typeof event !== 'string' || event.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: event must be a non-empty string');
	}
	const targetKeys = Object.keys(target);
	const extraKeys = targetKeys.filter((k) => k !== 'userId');
	if (extraKeys.length > 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: unsupported target keys: ' + extraKeys.join(', '));
	}
	const userId = /** @type {any} */ (target).userId;
	if (typeof userId !== 'string' || userId.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: target.userId must be a non-empty string');
	}

	// Cluster-first when a remoteRegistry is configured -- same rationale
	// as live.push above: the cluster registry's canonical-owner truth
	// routes deterministically to the most-recently-opened ws regardless
	// of caller instance. Self-target short-circuit keeps single-tab perf
	// unchanged. Multi-tab same-user across instances correctly reaches
	// the cluster-canonical recipient instead of the caller-local one.
	//
	// Fire-and-forget contract is preserved: any delivery failure
	// (offline, timeout, client handler throw, remote registry error)
	// is silent. The local fallback on registry-offline is a UX-only
	// optimization for the brief propagation race after a fresh open.
	const localEntry = _pushRegistry.get(userId);
	if (_remoteRegistry) {
		try {
			const p = _remoteRegistry.request(userId, event, data, { timeoutMs: _NOTIFY_INTERNAL_TIMEOUT_MS });
			if (localEntry) {
				// Brief registry-offline race after a fresh local open:
				// the cluster pub/sub event has not yet propagated, the
				// cluster rejects with "is offline", but the local
				// registry already has a valid entry. Fall back so the
				// user does not silently drop their own first notify.
				p.catch((err) => {
					if (_isRegistryOfflineError(err)) _deliverLocalNotify(localEntry);
				});
			} else {
				p.catch(() => { /* silent: fire-and-forget contract */ });
			}
		} catch {
			// Sync throw from registry shape; try local as best-effort.
			if (localEntry) _deliverLocalNotify(localEntry);
		}
		return Promise.resolve();
	}
	if (localEntry) _deliverLocalNotify(localEntry);
	// Offline + no cluster routing: silent no-op. The caller chose
	// notify; "we couldn't reach the user" isn't an error in this
	// contract - they'll see the result next time they load.
	return Promise.resolve();

	function _deliverLocalNotify(entry) {
		if (typeof entry.platform.request !== 'function') {
			// Same versioning constraint as live.push - platform.request
			// requires svelte-adapter-uws >= 0.5.0-next.4. Stay silent in
			// production: notify is fire-and-forget; a missing platform
			// primitive shouldn't surface at the call site as a sync throw.
			if (_IS_DEV) {
				console.warn('[svelte-realtime] live.notify: platform.request is not available; requires svelte-adapter-uws >= 0.5.0-next.4. Notify dispatch silently no-op.\n  See: https://svti.me/migration');
			}
			return;
		}
		try {
			entry.platform.request(entry.ws, event, data, { timeoutMs: _NOTIFY_INTERNAL_TIMEOUT_MS })
				.catch(() => {
					// Discarded by design: notify never surfaces delivery
					// state to the caller. Timeout, client handler error,
					// connection close - all silent.
				});
		} catch {
			// platform.request can throw synchronously on a torn-down ws.
			// Same fire-and-forget contract: silent.
		}
	}
};

/**
 * Reset the push registry, identify config, and remote registry binding.
 * Tests only.
 * @internal
 */
export function _resetPushRegistry() {
	_pushRegistry.clear();
	_pushIdentify = null;
	_remoteRegistry = null;
	_pushRegistryWarnFired = false;
}

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

/** @type {Map<string, { schedule: number[], fn: Function, topic: string }>} */
const cronRegistry = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let _cronInterval = null;

/**
 * Sticky-once-set: flips to true when a 6-field schedule (sub-minute
 * resolution) gets registered. Causes `_ensureCronInterval` to use a
 * 1-second tick instead of 60s. Never flips back inside a process
 * lifetime; cleared by `_clearCron` (HMR + tests).
 */
let _cronAt1Hz = false;

/**
 * Set of cron paths whose previous invocation has not yet finished.
 * Single-flight guard: a tick that matches a path already in this set
 * skips with a `cronCount{status:'skipped'}` metric increment instead
 * of running concurrently. Cleared by `_clearCron`.
 * @type {Set<string>}
 */
const _cronRunning = new Set();

/** @type {import('svelte-adapter-uws').Platform | null} */
let _cronPlatform = null;

/**
 * Process-wide leader gate for cron. When set, every tick consults
 * `_cronLeader()` before invoking any registered job; if it returns
 * falsy, the tick exits without firing. `null` means "no gate" - every
 * worker fires every job (the single-process default; correct behavior
 * for non-clustered deployments and dev).
 *
 * Configured via `configureCron({ leader })`. The canonical
 * cluster-mode implementation lives in
 * `svelte-adapter-uws-extensions/redis/leader` (Redis-lease-based
 * elect-and-renew); svelte-realtime stays cluster-agnostic here so it
 * does not pull in a Redis dependency.
 *
 * @type {(() => boolean) | null}
 */
let _cronLeader = null;

/**
 * Process-wide cluster bus. Single source of truth consulted by every
 * publish surface in the framework (RPC `ctx.publish`, cron tick,
 * reactive watchers' publish wrap, top-level `publish()` helper). When
 * set, outbound publishes relay to other cluster instances via
 * `bus.wrap(platform).publish`; inbound relays from other instances
 * arrive through the bus's own subscriber and are broadcast on this
 * instance via the wrapped surrogate's `publish`.
 *
 * Written by `setBus(bus)`, `configureCron({ bus })`, and the
 * `realtime({ bus })` factory. Read via `getBus()` and consulted at
 * publish-time by every framework seam so a single declaration of
 * deployment intent covers all of them. Without a bus, every seam
 * publishes locally (the single-replica default).
 *
 * Composition discipline: `bus.wrap(...)` is applied at publish time
 * over a snapshot of the raw adapter publish (the "surrogate"). The
 * reactive seam mutates `platform.publish` to a `derivedPublish` that
 * routes through the wrapped surrogate when a bus is configured, so
 * the same publish call fires reactive watchers AND relays to the
 * cluster in one step. Inbound relays from other instances arrive via
 * the wrapped surrogate's publish (which runs the local broadcast + the
 * watcher fan-out without re-relaying), so derived / effect /
 * aggregate handlers on receiving instances see the cross-cluster
 * stream the same way they see local publishes.
 *
 * @type {{ wrap: (platform: any) => any } | null}
 */
let _bus = null;
/**
 * Legacy alias retained so the existing `_cronBus` references in the
 * cron tick read the canonical bus without surgery. Always equal to
 * `_bus` (the setter writes both in lockstep). Treat as read-only.
 */
let _cronBus = null;

/**
 * Write the process-wide bus. Validated like `configureCron({ bus })`
 * - must expose `.wrap(platform)` or be `null`. Mirrored into the
 * legacy `_cronBus` alias so the existing cron tick keeps reading the
 * canonical value without surgery. Bumps `_busEpoch` so memoized
 * `bus.wrap(...)` caches (per-platform, computed lazily by the
 * reactive wrap and the RPC message hooks) invalidate on swap.
 * @param {{ wrap: (platform: any) => any } | null} bus
 */
function _setBus(bus) {
	if (bus !== null && (typeof bus !== 'object' || typeof bus.wrap !== 'function')) {
		throw new Error('[svelte-realtime] setBus: bus must expose a .wrap(platform) method or be null');
	}
	_bus = bus;
	_cronBus = bus;
	_busEpoch++;
}

/** Read the process-wide bus (or null when no cluster intent is wired). */
function _getBus() {
	return _bus;
}

/**
 * Monotonic counter bumped on every bus swap. Used by per-platform
 * `bus.wrap(...)` caches to detect "the bus changed under me, re-wrap"
 * without holding a strong reference to the old bus.
 */
let _busEpoch = 0;

/**
 * One-shot flag for the "configureCron leader without bus" warning.
 * Setting `leader` declares cluster intent; not also wiring a bus
 * means leader-only cron ticks fan out only on the leader's worker,
 * which is almost certainly a config bug. Reset by `_clearCron` so
 * HMR / tests get a fresh slate.
 */
let _cronClusterWarnFired = false;

/**
 * One-shot flag for the "cron fired but no platform captured" warning.
 * Without dedup, a 6-field schedule + an idle server produces a per-second
 * stream of identical warnings until the first WS connection (or, post
 * adapter `init` hook wiring, the boot of the first worker). Reset by
 * `_clearCron` so HMR / tests get a fresh slate. Reset to false the
 * moment a platform is captured, so a subsequent platform-loss (today
 * impossible, but defensive) re-arms the warning once.
 */
let _cronPlatformWarnFired = false;

/** @type {((path: string, error: unknown) => void) | null} */
let _serverErrorHandler = null;

/**
 * Set a global error handler for server-side errors (cron, effects, derived).
 * Without this, errors are logged in dev and silently swallowed in production.
 * @param {(path: string, error: unknown) => void} handler
 */
export function onError(handler) {
	_serverErrorHandler = handler;
}

/** @deprecated Use onError() instead. */
export function onCronError(handler) {
	_serverErrorHandler = handler;
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

/** @type {Map<string, { sources: string[], fn: Function, topic: string, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
const derivedRegistry = new Map();

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

/** @type {Map<Function, object>} O(1) lookup from fn reference to dynamic derived registry entry */
const _dynamicDerivedByFn = new Map();

/** @type {import('svelte-adapter-uws').Platform | null} Captured platform for dynamic derived recomputation */
let _derivedPlatform = null;

/** @type {boolean} Whether _activateDerived has been called at least once */
let _activateDerivedCalled = false;

/** @type {boolean} Whether the missing _activateDerived warning has already fired */
let _warnedActivateDerived = false;

/** @type {Map<string, { sources: string[], fn: Function, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
const effectRegistry = new Map();

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

/** @type {Map<string, { source: string, reducers: any, topic: string, state: any, snapshot: Function | null, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
const aggregateRegistry = new Map();
/** @type {Map<string, any>} Topic-keyed lookup for aggregates */
const _aggregateByTopic = new Map();

/** @type {Map<string, Set<any>>} Source topic -> derived entries that watch it */
const _derivedBySource = new Map();

/** @type {Map<string, Set<any>>} Source topic -> effect entries that watch it */
const _effectBySource = new Map();

/** @type {Map<string, Set<any>>} Source topic -> aggregate entries that watch it */
const _aggregateBySource = new Map();

/** @type {Set<string>} All source topics watched by derived/effect/aggregate for fast bail-out */
const _watchedTopics = new Set();

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
 * Compute the public-facing state for one window. For lifetime/tumbling
 * windows this is just `_computeAggregateState(winState.state, reducers)`.
 * For sliding windows the per-bucket state is collapsed via each reducer's
 * `combine` first, then `compute` runs against the combined result.
 *
 * @param {any} winState
 * @param {Record<string, any>} reducers
 * @returns {any}
 */
function _computeWindowState(winState, reducers) {
	if (winState.type === 'sliding') {
		const merged = {};
		for (const [field, r] of Object.entries(reducers)) {
			if (r.combine) {
				const slices = winState.buckets.map(b => b?.[field]);
				merged[field] = r.combine(...slices);
			} else if (r.init) {
				merged[field] = r.init();
			}
		}
		return _computeAggregateState(merged, reducers);
	}
	return _computeAggregateState(winState.state, reducers);
}

/**
 * Compute aggregate state including computed fields.
 * @param {any} state
 * @param {Record<string, any>} reducers
 * @returns {any}
 */
function _computeAggregateState(state, reducers) {
	const result = { ...state };
	for (const [field, r] of Object.entries(reducers)) {
		if (r.compute) {
			result[field] = r.compute(result);
		}
	}
	return result;
}

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
 * Honors `_cronPlatform` first (the captured publish path used by cron
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
	const platform = _cronPlatform;
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
/**
 * Per topic+userId presence tracking.
 *  - `count`: number of active subscriptions for this user in this room.
 *  - `timer`: pending grace-period leave (or null).
 *  - `data`: the user-supplied presence payload (`presenceFn(ctx)` result),
 *    held so the presence stream's init can reconstruct the roster from
 *    in-memory state when `platform.presence.list` isn't wired (zero-config
 *    dev path). Production wires a cluster-aware `platform.presence` and
 *    bypasses this fallback. Memory: bounded by `_PRESENCE_REF_MAX`; entries
 *    are dropped on the grace-timer expiry or under cap eviction.
 * @type {Map<string, { count: number, timer: ReturnType<typeof setTimeout> | null, data: any }>}
 */
const _presenceRef = new Map();

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

/** @type {WeakMap<object, string>} Stable guest ID per connection for anonymous users */
const _guestIds = new WeakMap();
let _guestIdCounter = 0;

/**
 * Get a stable identity key for a connection. Uses ctx.user.id (or the
 * Postgres-convention `user_id` / camelCase `userId` aliases) if present,
 * otherwise assigns a unique guest ID that persists for the connection
 * lifetime. The id-key probe order mirrors `_defaultPushIdentify` so apps
 * that expose `user_id` in their session shape rate-limit per-user instead
 * of falling back to the per-connection bucket.
 * @param {any} ctx
 * @returns {string}
 */
export function _getIdentityKey(ctx) {
	const u = ctx.user;
	if (u) {
		const id = u.id ?? u.user_id ?? u.userId;
		if (id !== undefined && id !== null) return String(id);
	}
	if (!ctx.ws) return 'anon';
	let guestId = _guestIds.get(ctx.ws);
	if (!guestId) {
		guestId = '__guest_' + (++_guestIdCounter).toString(36);
		_guestIds.set(ctx.ws, guestId);
	}
	return guestId;
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
async function _clusterPresenceRelease(platform, topic, key) {
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

			if (_presenceRef.size >= _maxPresenceRef) {
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
				if (_presenceRef.size >= _maxPresenceRef) {
					if (!_presenceRefWarnFired) {
						_presenceRefWarnFired = true;
						console.warn(
							"[svelte-realtime] presence-ref map reached MAX_PRESENCE_REF=" + _maxPresenceRef +
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
				try {
					return await fn(ctx, ...args);
				} finally {
					ctx.publish = originalPublish;
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
		topicArgs: config.topicArgs
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

/** @type {{ rpcCount?: any, rpcDuration?: any, rpcErrors?: any, streamGauge?: any, cronCount?: any, cronErrors?: any, assertions?: any } | null} */
let _metricsInstruments = null;

/** Valid pressure reasons accepted in admission rules. Mirrors the adapter's PressureReason enum. */
const _PRESSURE_REASONS = new Set(['NONE', 'PUBLISH_RATE', 'SUBSCRIBERS', 'MEMORY']);

/** @type {{ classes: Record<string, string[] | ((snapshot: any) => boolean)> } | null} */
let _admissionConfig = null;

/**
 * Configure pressure-aware admission control. Each named class maps to
 * either an array of pressure reasons (shed when `platform.pressure.reason`
 * is in the array) or a `(snapshot) => boolean` predicate (shed when truthy).
 *
 * Once configured, `ctx.shed(className)` evaluates the rule against the
 * current `platform.pressure` snapshot, and any `live.stream({ classOfService })`
 * auto-rejects new subscribes under matching pressure with `OVERLOADED`.
 *
 * Pass `null` to clear (tests).
 *
 * Zero overhead when never called: `ctx.shed` returns `false` and
 * `classOfService` is a no-op.
 *
 * @param {{ classes: Record<string, string[] | ((snapshot: any) => boolean)> } | null} config
 */
live.admission = function admission(config) {
	if (config === null || config === undefined) { _admissionConfig = null; return; }
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.admission: config must be an object or null');
	}
	if (!config.classes || typeof config.classes !== 'object') {
		throw new Error('[svelte-realtime] live.admission: config.classes must be an object');
	}
	const classes = {};
	for (const [name, rule] of Object.entries(config.classes)) {
		if (Array.isArray(rule)) {
			for (const r of rule) {
				if (!_PRESSURE_REASONS.has(r)) {
					throw new Error(
						`[svelte-realtime] live.admission: class '${name}' has unknown pressure reason '${r}'. ` +
						`Valid: ${[..._PRESSURE_REASONS].join(', ')}`
					);
				}
			}
			classes[name] = rule;
		} else if (typeof rule === 'function') {
			classes[name] = rule;
		} else {
			throw new Error(
				`[svelte-realtime] live.admission: class '${name}' must be an array of pressure reasons or a (snapshot) => boolean predicate`
			);
		}
	}
	_admissionConfig = { classes };
};

/**
 * Reset the admission configuration. Tests only.
 * @internal
 */
export function _resetAdmission() {
	_admissionConfig = null;
}

/**
 * Evaluate whether a request of the given class should be shed under
 * current pressure. Returns `true` to shed, `false` to admit.
 *
 * - No admission configured -> always admit.
 * - No `platform.pressure` snapshot -> always admit (no signal to act on).
 * - Class not configured -> throws (typo defense).
 *
 * @param {any} platform
 * @param {string} className
 * @returns {boolean}
 */
function _shouldShed(platform, className) {
	if (!_admissionConfig) return false;
	const rule = _admissionConfig.classes[className];
	if (rule === undefined) {
		const known = Object.keys(_admissionConfig.classes).join(', ') || '<none>';
		throw new Error(`[svelte-realtime] ctx.shed: unknown class '${className}'. Configured: ${known}`);
	}
	const snapshot = platform && platform.pressure;
	if (!snapshot) return false;
	if (typeof rule === 'function') return !!rule(snapshot);
	return rule.includes(snapshot.reason);
}

/**
 * Opt-in Prometheus metrics integration. Instruments RPC calls, stream
 * subscriptions, and cron executions. Zero overhead if never called.
 *
 * Call once at server start (e.g. the top of `src/hooks.ws.{js,ts}`).
 *
 * The registry is any object exposing:
 *   counter({ name, help, labelNames }) -> { inc(labels?) }
 *   histogram({ name, help, labelNames }) -> { observe(labels, valueSeconds) }
 *   gauge({ name, help }) -> { inc(), dec() }
 *
 * See the README "Prometheus metrics" section for a working example that
 * pairs this with `createMetrics()` from `svelte-adapter-uws-extensions/prometheus`.
 *
 * @param {any} registry - Object with counter, histogram, and gauge factories
 */
live.metrics = function metrics(registry) {
	_metricsInstruments = {
		rpcCount: registry.counter({ name: 'svelte_realtime_rpc_total', help: 'Total RPC calls', labelNames: ['path', 'status'] }),
		rpcDuration: registry.histogram({ name: 'svelte_realtime_rpc_duration_seconds', help: 'RPC call duration', labelNames: ['path'] }),
		rpcErrors: registry.counter({ name: 'svelte_realtime_rpc_errors_total', help: 'Total RPC errors', labelNames: ['path', 'code'] }),
		streamGauge: registry.gauge({ name: 'svelte_realtime_stream_subscriptions', help: 'Active stream subscriptions' }),
		cronCount: registry.counter({ name: 'svelte_realtime_cron_total', help: 'Total cron executions', labelNames: ['path', 'status'] }),
		cronErrors: registry.counter({ name: 'svelte_realtime_cron_errors_total', help: 'Total cron errors', labelNames: ['path'] }),
		assertions: registry.counter({ name: 'svelte_realtime_assertion_violations_total', help: 'Production-assertion violations by category', labelNames: ['category'] })
	};
	wireAssertionMetrics((category) => _metricsInstruments.assertions.inc({ category }));
};

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
/**
 * Tracks platforms whose `publish` has been swapped to `derivedPublish`
 * by `_wrapPlatformPublish`. WeakSet so per-connection platform clones
 * inherit the mutation via prototype chain without forcing the base
 * platform to live longer than the adapter intends - entries clear
 * naturally when the platform itself becomes GC-eligible. The WeakSet
 * is the single source of truth for "is this platform's publish path
 * framework-owned?" - consulted by `_ensureWrap` (the universal idempotent
 * installer), referenced indirectly by every publish surface (RPC, cron,
 * reactive, top-level `publish()`).
 *
 * @type {WeakSet<object>}
 */
const _activatedPlatforms = new WeakSet();

/**
 * Universal install point for the framework's publish wrap. Idempotent
 * against `_activatedPlatforms`, safe under HMR, called from every site
 * that captures or first sees a platform reference:
 * - `setCronPlatform(platform)` - call from `realtime().init` or
 *   directly from `hooks.ws.js`'s `init({ platform })`.
 * - `_activateDerived(platform)` - same call site, alternative entry.
 * - The default `message` hook + `createMessage` returned hook - first
 *   message per platform installs the wrap, so apps that wire only
 *   `setBus(bus)` and re-export `message` (no init hook, no
 *   `_activateDerived` call) still get cluster routing on first RPC.
 *
 * Single install site eliminates the entire class of "outer wrap stacks
 * on inner wrap" bugs: there is only ONE `bus.wrap(...)` call in the
 * whole framework (inside `_wrapPlatformPublish`'s `_refreshBusCache`)
 * and it's composed with everything else (reactive watchers, batched
 * fast path, replay routing) at publish time via the mutated
 * `derivedPublish` / `derivedPublishBatched`.
 *
 * @param {any} platform
 */
function _ensureWrap(platform) {
	if (!platform) return;
	// svelte-adapter-uws hands hooks a per-connection platform created via
	// Object.create(basePlatform). Wrapping that per-connection object would
	// leave every other connection's inherited publish / publishBatched
	// untouched, because their lookups walk the prototype chain to the
	// original base. Resolve to the base prototype so the wrap is visible
	// to all connections that share it. Test mocks pass plain objects whose
	// proto is Object.prototype - in that case wrap the object itself.
	const target = _resolveWrapTarget(platform);
	if (_activatedPlatforms.has(target)) return;
	_activatedPlatforms.add(target);
	_wrapPlatformPublish(target);
}

export function _activateDerived(platform) {
	_derivedPlatform = platform;
	_activateDerivedCalled = true;
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

/**
 * Install the publish wrap retroactively if `_activateDerived(platform)`
 * was called against an empty registry and a registration has now landed
 * to populate one. Idempotent: if the wrap is already installed (or no
 * platform was ever activated), this is a no-op. Called from every
 * registration path that populates a `_*BySource` index, including the
 * dynamic-derived bind path.
 *
 * Without this hook, registrations that resolve via the lazy queue
 * (which drains on first cron tick / RPC) - or via direct
 * `__registerXxx(path, fn)` calls in dev-mode SSR fallback - would
 * leave the platform unwrapped, and the very first publish from a
 * cron firehose / startup task / autonomous worker would silently
 * miss every watcher (aggregate / effect / static derived). Manifests
 * as empty leaderboards and `silentTopicWarning` after 30s.
 */
function _maybeLateActivate() {
	if (!_derivedPlatform) return;
	_ensureWrap(_derivedPlatform);
}

/**
 * Walk one prototype hop to find the platform object that OWNS `publish`,
 * so the wrap applies to every per-connection clone created via
 * Object.create(basePlatform). Falls back to the input when there is no
 * useful prototype (test mocks).
 * @param {any} p
 */
function _resolveWrapTarget(p) {
	const proto = Object.getPrototypeOf(p);
	if (proto && proto !== Object.prototype && typeof proto.publish === 'function') {
		return proto;
	}
	return p;
}

function _wrapPlatformPublish(platform) {

	const originalPublish = platform.publish.bind(platform);
	const originalPublishBatched = typeof /** @type {any} */ (platform).publishBatched === 'function'
		? /** @type {any} */ (platform).publishBatched.bind(platform)
		: null;

	// Memoized bus-wrapped surrogate. Recomputed when the process-wide
	// bus changes (detected via `_busEpoch`). The surrogate's `publish`
	// is `derivedPublishLocal` (local broadcast + watcher fan-out, no
	// re-relay), so inbound bus deliveries fire watchers on the
	// receiving instance without bouncing the message back out onto the
	// bus. The wrapped surrogate's `publish` (set up by the extension's
	// `bus.wrap`) does relay + delegate-to-surrogate; outbound publishes
	// from user code go through `derivedPublish` below, which routes via
	// this cache when a bus is configured.
	let _cachedBusEpoch = -1;
	/** @type {((topic: string, event: string, data: any, opts?: any) => any) | null} */
	let _busPublish = null;
	/** @type {((batch: any) => any) | null} */
	let _busPublishBatched = null;
	function _refreshBusCache() {
		if (_cachedBusEpoch === _busEpoch) return;
		_cachedBusEpoch = _busEpoch;
		const bus = _getBus();
		if (!bus) {
			_busPublish = null;
			_busPublishBatched = null;
			return;
		}
		// Surrogate holds derivedPublishLocal as its publish so inbound
		// cluster relays still fire reactive watchers on this instance
		// but do not bounce back out. Spread carries the rest of the
		// platform surface (subscribe, send, redis, replay, ...) so the
		// extensions's bus.wrap sees a complete platform shape.
		/** @type {any} */
		const surrogate = Object.assign(Object.create(Object.getPrototypeOf(platform)), platform);
		surrogate.publish = derivedPublishLocal;
		if (originalPublishBatched) surrogate.publishBatched = derivedPublishBatchedLocal;
		const wrapped = bus.wrap(surrogate);
		_busPublish = typeof wrapped.publish === 'function' ? wrapped.publish.bind(wrapped) : null;
		_busPublishBatched = typeof /** @type {any} */ (wrapped).publishBatched === 'function'
			? /** @type {any} */ (wrapped).publishBatched.bind(wrapped)
			: null;
	}

	let _publishDepth = 0;

	function fireWatchers(topic, event, data) {
		if (!_watchedTopics.has(topic)) return;

		// Guard against infinite recursion (aggregate publishes back through this wrapper)
		if (_publishDepth > 8) return;
		_publishDepth++;

		// Check if any derived stream watches this topic
		const derivedEntries = _derivedBySource.get(topic);
		if (derivedEntries) {
			for (const entry of derivedEntries) {
				if (entry.debounce > 0) {
					if (entry.timer) clearTimer(entry.timer);
					entry.timer = setTimer(() => {
						entry.timer = null;
						_recomputeDerived(entry, platform);
					}, entry.debounce);
				} else {
					_recomputeDerived(entry, platform);
				}
			}
		}

		// Fire matching effects
		const effectEntries = _effectBySource.get(topic);
		if (effectEntries) {
			for (const entry of effectEntries) {
				if (entry.debounce > 0) {
					if (entry.timer) clearTimer(entry.timer);
					entry.timer = setTimer(() => {
						entry.timer = null;
						_fireEffect(entry, event, data, platform);
					}, entry.debounce);
				} else {
					// Fire-and-forget: don't block the publish path
					Promise.resolve().then(() => _fireEffect(entry, event, data, platform));
				}
			}
		}

		// Run matching aggregates
		const aggregateEntries = _aggregateBySource.get(topic);
		if (aggregateEntries) {
			for (const entry of aggregateEntries) {
				if (entry.windowed) {
					// Windowed branch: each window holds its own state slice
					// (or hop-bucket array for sliding) and publishes to its
					// own output topic. Per-window debounce overrides the
					// aggregate-level default.
					for (const win of entry.windowStates.values()) {
						if (win.type === 'sliding') {
							const bucket = win.buckets[win.bucketIndex];
							for (const [field, reducer] of entry._reducerEntries) {
								if (reducer.reduce) {
									bucket[field] = reducer.reduce(bucket[field], event, data);
								}
							}
						} else {
							for (const [field, reducer] of entry._reducerEntries) {
								if (reducer.reduce) {
									win.state[field] = reducer.reduce(win.state[field], event, data);
								}
							}
						}
						const computed = _computeWindowState(win, entry.reducers);
						const winRef = win;
						if (winRef.debounce > 0) {
							if (winRef.timer) clearTimer(winRef.timer);
							winRef.timer = setTimer(() => {
								winRef.timer = null;
								platform.publish(winRef.outputTopic, 'set', computed);
							}, winRef.debounce);
						} else {
							platform.publish(winRef.outputTopic, 'set', computed);
						}
					}
					continue;
				}

				// Apply reducers (single-state)
				for (const [field, reducer] of entry._reducerEntries) {
					if (reducer.reduce) {
						entry.state[field] = reducer.reduce(entry.state[field], event, data);
					}
				}

				const computed = _computeAggregateState(entry.state, entry.reducers);

				if (entry.debounce > 0) {
					if (entry.timer) clearTimer(entry.timer);
					entry.timer = setTimer(() => {
						entry.timer = null;
						platform.publish(entry.topic, 'set', computed);
					}, entry.debounce);
				} else {
					platform.publish(entry.topic, 'set', computed);
				}
			}
		}

		_publishDepth--;
	}

	// Inner publish used by the bus-wrap surrogate. Does the local
	// broadcast + watcher fan-out but NEVER relays - relay is the
	// outer `derivedPublish`'s job (via the wrapped surrogate). This
	// is also what runs when an inbound message arrives from another
	// instance, so cluster-relayed events fire derived / effect /
	// aggregate watchers on the receiving instance.
	function derivedPublishLocal(topic, event, data, opts) {
		const result = originalPublish(topic, event, data, opts);
		fireWatchers(topic, event, data);
		return result;
	}

	function derivedPublishBatchedLocal(batch) {
		const result = originalPublishBatched ? originalPublishBatched(batch) : undefined;
		if (Array.isArray(batch) && _watchedTopics.size > 0) {
			for (const item of batch) {
				if (!item || typeof item.topic !== 'string') continue;
				fireWatchers(item.topic, item.event, item.data);
			}
		}
		return result;
	}

	// Outbound user-facing publish. When a bus is configured, routes
	// through the wrapped surrogate so the publish both broadcasts
	// locally (with watchers) and relays to the cluster in one step.
	// Without a bus, identical to the legacy local-only path.
	platform.publish = function derivedPublish(topic, event, data, opts) {
		_refreshBusCache();
		if (_busPublish) return _busPublish(topic, event, data, opts);
		return derivedPublishLocal(topic, event, data, opts);
	};

	if (originalPublishBatched) {
		// Wrap publishBatched too: ctx.publish takes the batched fast path
		// (queueMicrotask + platform.publishBatched) when no coalesce / transform
		// is registered, which is the default with the uWS adapter. Without
		// this wrap, derived / effect / aggregate watchers never fire on
		// publishes from the batched path - they only fire from the unbatched
		// platform.publish path that some test mocks happen to use.
		/** @type {any} */ (platform).publishBatched = function derivedPublishBatched(batch) {
			_refreshBusCache();
			if (_busPublishBatched) return _busPublishBatched(batch);
			return derivedPublishBatchedLocal(batch);
		};
	}
}

/**
 * Recompute a derived stream and publish the result.
 * For dynamic instances, entry.args holds the runtime args and a ctx is built from the platform.
 * @param {{ fn: Function, topic: string, args?: any[] }} entry
 * @param {import('svelte-adapter-uws').Platform} platform
 */
async function _recomputeDerived(entry, platform) {
	try {
		let result;
		if (entry.args) {
			const _h = _getCtxHelpers(platform);
			const ctx = _buildCtx(entry.user || null, null, platform, _h, null);
			result = await entry.fn(ctx, ...entry.args);
		} else {
			result = await entry.fn();
		}
		platform.publish(entry.topic, 'set', result);
	} catch (err) {
		if (_serverErrorHandler) {
			try { _serverErrorHandler('derived', err); } catch {}
		} else if (_IS_DEV) {
			console.error(`[svelte-realtime] Derived stream '${entry.topic}' error:`, err, '\n  See: https://svti.me/derived');
		}
	}
}

/**
 * Activate a dynamic derived instance for a resolved topic.
 * Wires the instance's resolved sources into _derivedBySource so publishes trigger recomputation.
 * @param {Function} fn - The derived compute function
 * @param {string} resolvedTopic - The resolved output topic (e.g. '__derived:5:org_123')
 * @param {any} [user] - The subscribing client's user data, used for ctx during recomputation
 */
function _activateDynamicDerived(fn, resolvedTopic, user) {
	const entry = _dynamicDerivedByFn.get(fn);
	if (!entry) return;

	const existing = entry.instances.get(resolvedTopic);
	if (existing) {
		existing.refCount++;
		return;
	}

	// Late activation: if _activateDerived returned early before dynamic
	// entries existed, wrap platform.publish now that we have something
	// to watch. Shared with the static aggregate / effect / derived
	// registration paths via `_maybeLateActivate`.
	_maybeLateActivate();

	const topicArgs = /** @type {any} */ (fn).__derivedTopicArgs;
	const args = topicArgs && topicArgs.get(resolvedTopic);
	if (!args) return;

	const resolvedSources = entry.sourceFactory(...args);
	if (!Array.isArray(resolvedSources) || resolvedSources.length === 0) {
		if (_IS_DEV) {
			console.warn(`[svelte-realtime] Dynamic derived sourceFactory returned empty sources for topic '${resolvedTopic}'\n  See: https://svti.me/derived`);
		}
		return;
	}

	const instance = {
		fn: entry.fn,
		args,
		topic: resolvedTopic,
		resolvedSources,
		debounce: entry.debounce,
		timer: null,
		refCount: 1,
		user: user || null
	};

	entry.instances.set(resolvedTopic, instance);

	for (const src of resolvedSources) {
		let set = _derivedBySource.get(src);
		if (!set) { set = new Set(); _derivedBySource.set(src, set); }
		set.add(instance);
		_watchedTopics.add(src);
	}
}

/**
 * Deactivate a dynamic derived instance when the last subscriber disconnects.
 * Removes the instance from _derivedBySource and cleans up.
 * @param {Function} fn - The derived compute function
 * @param {string} resolvedTopic - The resolved output topic
 */
function _deactivateDynamicDerived(fn, resolvedTopic) {
	const entry = _dynamicDerivedByFn.get(fn);
	if (!entry) return;

	const instance = entry.instances.get(resolvedTopic);
	if (!instance) return;

	instance.refCount--;
	if (instance.refCount > 0) return;

	if (instance.timer) clearTimer(instance.timer);

	for (const src of instance.resolvedSources) {
		const set = _derivedBySource.get(src);
		if (set) {
			set.delete(instance);
			if (set.size === 0) {
				_derivedBySource.delete(src);
				if (!_effectBySource.has(src) && !_aggregateBySource.has(src)) {
					_watchedTopics.delete(src);
				}
			}
		}
	}

	entry.instances.delete(resolvedTopic);
	const topicArgs = /** @type {any} */ (fn).__derivedTopicArgs;
	if (topicArgs) topicArgs.delete(resolvedTopic);
}

/**
 * Fire an effect handler. Errors are caught and routed to the error handler.
 * @param {{ fn: Function }} entry
 * @param {string} event
 * @param {any} data
 * @param {import('svelte-adapter-uws').Platform} platform
 */
async function _fireEffect(entry, event, data, platform) {
	try {
		await entry.fn(event, data, platform);
	} catch (err) {
		if (_serverErrorHandler) {
			try { _serverErrorHandler('effect', err); } catch {}
		} else if (_IS_DEV) {
			console.error('[svelte-realtime] Effect error:', err);
		}
	}
}

/**
 * Register a cron job. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerCron(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'cron', path, loader: fn });
		_ensureCronInterval();
		return;
	}
	const parsed = /** @type {any} */ (fn).__cronParsed;
	const topic = /** @type {any} */ (fn).__cronTopic;
	if (!parsed || !topic) return;
	cronRegistry.set(path, { schedule: parsed, fn, topic });
	// 6-field schedule means seconds-precision firing is required.
	// Upgrade the tick to 1 Hz once any such schedule registers.
	if (parsed.length === 6) _upgradeCronTo1Hz();
	_ensureCronInterval();
}

/**
 * Capture a platform reference for cron jobs.
 *
 * **Recommended call site (svelte-adapter-uws >= 0.5.0-next.15):** the
 * `init({ platform })` hook in `hooks.ws.js`. The adapter fires `init`
 * exactly once per worker after the listen socket is bound and before
 * any `upgrade` / `open` / `message` hook can run, so the cron tick has
 * a platform from the very first scheduled fire and no
 * "fired but no platform captured" warning is possible.
 *
 * **Legacy / fallback call site:** the `open(ws, platform)` hook. Works
 * but the platform is only captured on the first WebSocket connection,
 * so cron ticks during the boot-to-first-connect window are no-ops and
 * surface a single (deduped) warning. Migrate to `init` when you bump
 * the adapter to next.15+.
 *
 * In clustered deployments (CLUSTER_MODE=reuseport on Linux, or
 * acceptor mode on Windows/macOS / multi-replica Docker), `init` fires
 * once per worker - so every worker captures its own platform and
 * every worker's cron tick fires every job in parallel by default. To
 * get single-fire semantics across the cluster, also wire a leader gate
 * via `configureCron({ leader })` (see that function's docs for
 * the canonical extensions-package implementation).
 *
 * @param {import('svelte-adapter-uws').Platform} platform
 *
 * @example
 * ```js
 * // src/hooks.ws.js (adapter next.15+)
 * import { setCronPlatform, pushHooks, message, upgrade } from 'svelte-realtime/server';
 *
 * export { upgrade, message };
 * export const open = pushHooks.open;
 * export const close = pushHooks.close;
 *
 * export function init({ platform }) {
 *     setCronPlatform(platform);
 * }
 * ```
 */
export function setCronPlatform(platform) {
	_cronPlatform = platform;
	// Re-arm the dedup so a subsequent platform-loss (defensive only --
	// platform never goes null in practice) gets one fresh warning.
	_cronPlatformWarnFired = false;
	// Install the framework's publish wrap here too: pure-cron apps that
	// never call `_activateDerived` (no reactive primitives wired) still
	// need cluster routing when a bus is configured. The wrap is idempotent
	// via `_activatedPlatforms`, so when `realtime().init` calls both
	// `setCronPlatform` and `_activateDerived` the second call is a no-op.
	if (platform) _ensureWrap(platform);
}

/**
 * Configure cron behavior across the cluster.
 *
 * Currently exposes a single field, `leader`, which gates whether this
 * worker fires its registered cron jobs. Without a leader configured,
 * every worker fires every job on every matching tick - the correct
 * single-process default, and the only sane default for dev. In
 * clustered deployments (whether SO_REUSEPORT on Linux with N kernel
 * workers per replica, or N replicas with internal acceptor-mode
 * cluster on Windows / macOS, or both compounded) this is almost never
 * what you want for "send the daily summary email at 9am" - you want
 * exactly one fire across the cluster, regardless of how many JS heaps
 * are ticking.
 *
 * The `leader` function is consulted at the top of every tick. If it
 * returns falsy, the tick exits without firing any job. The expected
 * call shape is synchronous and very cheap (a boolean read from a
 * cached state); the canonical implementation is in
 * `svelte-adapter-uws-extensions/redis/leader`, which maintains a
 * background Redis SETNX lease (acquire-and-renew) and exposes the
 * cached "am I the leader right now" state as a synchronous getter.
 * svelte-realtime intentionally does not bundle the leader
 * implementation - the cluster transport (Redis or otherwise) is the
 * extensions package's domain, and pulling Redis into the realtime
 * layer would force a dependency on every consumer including
 * single-process apps that do not need it.
 *
 * Pass `null` (in place of the whole config object) to clear the
 * leader and revert to "every worker fires" behavior.
 *
 * @param {{ leader?: (() => boolean) | null } | null} config
 *
 * @example
 * ```js
 * // src/hooks.ws.js (adapter next.15+, clustered deployment)
 * import { setCronPlatform, configureCron } from 'svelte-realtime/server';
 * import { createLeader } from 'svelte-adapter-uws-extensions/redis/leader';
 *
 * const leader = createLeader(redis);
 *
 * export function init({ platform }) {
 *     setCronPlatform(platform);
 *     configureCron({ leader: leader.isLeader });
 * }
 *
 * export async function shutdown() {
 *     // Best-effort lease release so a sibling can take over within
 *     // renewMs (default 10s) instead of waiting for the full lease.
 *     await leader.stop();
 * }
 * ```
 *
 * @example
 * ```js
 * // Tests / single-process: no configureCron call needed; the default
 * // "fires on every worker" is exactly right.
 * ```
 */
export function configureCron(config) {
	if (config === null) {
		_cronLeader = null;
		_setBus(null);
		return;
	}
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] configureCron: config must be an object or null');
	}
	if (config.leader === undefined && config.bus === undefined) {
		throw new Error('[svelte-realtime] configureCron: config must include at least one of leader or bus');
	}
	if (config.leader !== undefined) {
		if (config.leader === null) {
			_cronLeader = null;
		} else if (typeof config.leader !== 'function') {
			throw new Error('[svelte-realtime] configureCron: leader must be a function or null');
		} else {
			_cronLeader = config.leader;
		}
	}
	if (config.bus !== undefined) {
		// Routes through `_setBus` so the canonical `_bus` (consulted by
		// the reactive wrap, the RPC auto-wrap, and the top-level
		// `publish()` helper) stays in lockstep with the legacy
		// `_cronBus` alias - one declaration of cluster intent covers
		// every framework seam, not just cron.
		if (config.bus !== null && (typeof config.bus !== 'object' || typeof config.bus.wrap !== 'function')) {
			throw new Error('[svelte-realtime] configureCron: bus must expose a .wrap(platform) method or be null');
		}
		_setBus(config.bus);
	}
	// Diagnostic: cluster intent (leader) without cluster fan-out (bus)
	// is almost always a misconfig. Leader-only cron ticks publish on the
	// leader worker only - subscribers on non-leader instances see
	// nothing. The user typically wants both wired together. Warn once
	// per process so the same hot-reload cycle doesn't spam.
	if (_IS_DEV && _cronLeader !== null && _cronBus === null && !_cronClusterWarnFired) {
		console.warn(
			"[svelte-realtime] configureCron({ leader }) was set without a `bus`. " +
			"Leader-only cron ticks publish on the elected worker only - " +
			"subscribers on other cluster instances will not see them. " +
			"Wire `bus` from svelte-adapter-uws-extensions/redis/pubsub or " +
			"sharded-pubsub:\n" +
			"  configureCron({ leader: leader.isLeader, bus });\n" +
			"  See: https://svti.me/cluster-cron"
		);
		_cronClusterWarnFired = true;
	}
}

/** @type {ReturnType<typeof setTimeout> | null} */
let _cronStartupTimer = null;

function _ensureCronInterval() {
	if (_cronInterval) return;
	// Set sentinel immediately to prevent duplicate timers from concurrent calls
	_cronInterval = /** @type {any} */ (-1);
	_cronInterval = setIntervalTimer(_tickCron, _cronAt1Hz ? 1000 : 60000);
	// Run an initial tick after a short delay to catch jobs on startup
	_cronStartupTimer = setTimer(_tickCron, 1000);
}

/**
 * Switch the cron interval to 1 Hz (called when the first sub-minute
 * job is registered). Sticky: subsequent calls are no-ops, and the
 * tick stays at 1 Hz for the rest of the process lifetime even if all
 * 6-field jobs are torn down. Cleared by `_clearCron` for HMR.
 */
function _upgradeCronTo1Hz() {
	if (_cronAt1Hz) return;
	_cronAt1Hz = true;
	if (_cronInterval && _cronInterval !== /** @type {any} */ (-1)) {
		clearIntervalTimer(_cronInterval);
		_cronInterval = setIntervalTimer(_tickCron, 1000);
	}
}

/**
 * Queue of deferred registrations for cron/derived/effect/aggregate/room-actions.
 * Populated when lazy loaders are passed to __registerCron, __registerDerived, etc.
 * Resolved on first RPC call or cron tick via _resolveAllLazy().
 * @type {Array<{ type: string, path: string, loader: Function }>}
 */
const _lazyQueue = [];

/** @type {Promise<void> | null} */
let _lazyInitPromise = null;

/** @type {boolean} Set to true once all lazy entries have been resolved */
let _lazyResolved = false;

/**
 * Resolve all deferred (lazy) cron/derived/effect/aggregate/room-action registrations.
 * Safe to call multiple times - only the first call does work, concurrent callers
 * await the same promise.
 */
async function _resolveAllLazy() {
	if (_lazyResolved) return;
	if (_lazyInitPromise) return _lazyInitPromise;
	if (_lazyQueue.length === 0) { _lazyResolved = true; return; }
	_lazyInitPromise = (async () => {
		const queue = _lazyQueue.splice(0);
		for (const { type, path, loader } of queue) {
			try {
				const fn = await loader();
				if (!fn) continue;
				switch (type) {
					case 'cron':
						__registerCron(path, fn);
						break;
					case 'derived':
						__register(path, fn);
						__registerDerived(path, fn);
						break;
					case 'effect':
						__registerEffect(path, fn);
						break;
					case 'aggregate':
						__register(path, fn);
						__registerAggregate(path, fn);
						break;
					case 'room-actions': {
						const modulePath = path.substring(0, path.lastIndexOf('/'));
						if (/** @type {any} */ (fn).__actions) {
							for (const [k, v] of Object.entries(/** @type {any} */ (fn).__actions)) {
								if (_validSegmentRe.test(k)) {
									__register(path + '/__action/' + k, v, modulePath);
								}
							}
						}
						break;
					}
				}
			} catch (err) {
				console.error(`[svelte-realtime] Failed to resolve lazy registration for '${path}':`, err);
			}
		}
		_lazyResolved = true;
	})();
	return _lazyInitPromise;
}

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
 * Clear all cron timers. Called during HMR to prevent orphan intervals,
 * and from afterEach in tests. Also resets the sticky-1Hz flag, the
 * single-flight set, and the platform-missing warn-once flag so the
 * next registration round starts fresh.
 *
 * `_cronPlatform` and `_cronLeader` are intentionally NOT cleared: both
 * are user-provided refs captured once per process lifetime (typically
 * from the adapter's `init` hook), and clearing them would force every
 * HMR cycle to re-acquire them. Tests that need to swap a leader can
 * call `configureCron({ leader: null })` between cases.
 */
export function _clearCron() {
	if (_cronInterval) {
		clearIntervalTimer(_cronInterval);
		_cronInterval = null;
	}
	if (_cronStartupTimer) {
		clearTimer(_cronStartupTimer);
		_cronStartupTimer = null;
	}
	cronRegistry.clear();
	_cronAt1Hz = false;
	_cronRunning.clear();
	_cronPlatformWarnFired = false;
	_cronClusterWarnFired = false;
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
		hadCron: _cronInterval !== null,
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

	// Clear orphaned throttle/debounce timers to prevent stale platform.publish refs
	for (const [, entry] of _throttles) clearTimer(entry.timer);
	_throttles.clear();
	for (const [, timer] of _debounces) clearTimer(timer);
	_debounces.clear();

	// Clear cron timers (but keep _cronPlatform - it stays valid across HMR)
	_clearCron();

	// Clear lazy queue and reset lazy init state
	_lazyQueue.length = 0;
	_lazyInitPromise = null;
	_lazyResolved = false;

	// Clear all registries and lookup maps
	registry.clear();
	guards.clear();
	derivedRegistry.clear();
	effectRegistry.clear();
	aggregateRegistry.clear();
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
	_activateDerivedCalled = false;
	_warnedActivateDerived = false;

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
}

// English short weekday names mapped to the 0-6 (Sunday=0) convention the
// cron weekday field matches against, identical to the historical getDay()
// numbering. Pinning the formatter locale to 'en-US' keeps these names stable
// regardless of the host locale.
const _CRON_WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Extract the cron date parts (second, minute, hour, day, month 1-12,
 * weekday 0-6 Sunday=0) for an epoch-ms reference, formatted in the given
 * IANA time zone. Passing `undefined` for the zone uses the host system zone,
 * which preserves the historical local-time cron behavior. The numeric
 * epoch-ms is handed straight to Intl - no intermediate Date is constructed,
 * so a seeded clock plus a pinned zone makes the parts fully reproducible.
 *
 * @param {number} ms - epoch milliseconds
 * @param {string | undefined} tz - IANA zone, or undefined for the system zone
 * @returns {{ second: number, minute: number, hour: number, day: number, month: number, weekday: number }}
 */
function _cronDateParts(ms, tz) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric', month: 'numeric', day: 'numeric',
		hour: 'numeric', minute: 'numeric', second: 'numeric',
		weekday: 'short',
		hour12: false
	});
	const parts = fmt.formatToParts(ms);
	const get = (k) => Number(parts.find(p => p.type === k)?.value);
	let hour = get('hour');
	if (hour === 24) hour = 0; // some Intl impls render midnight as 24
	const wd = parts.find(p => p.type === 'weekday')?.value;
	return {
		second: get('second'),
		minute: get('minute'),
		hour,
		day: get('day'),
		month: get('month'),
		weekday: _CRON_WEEKDAY_INDEX[wd] ?? 0
	};
}

export async function _tickCron() {
	if (!_lazyResolved) await _resolveAllLazy();

	// Cluster-mode leader gate. Default (no leader configured) is "every
	// worker fires" - correct for single-process and dev. With a leader
	// wired via `configureCron({ leader })` (canonical implementation
	// in svelte-adapter-uws-extensions/redis/leader), only the
	// elected worker proceeds to evaluate the per-job schedule match.
	// The leader call must be cheap and synchronous; the extensions
	// implementation maintains the lease in the background and exposes
	// the "am I leader right now" state as a cached boolean read.
	if (_cronLeader !== null) {
		let isLeader;
		try {
			isLeader = _cronLeader();
		} catch (err) {
			// A throwing leader fn is a configuration bug; fail closed
			// (do not fire) and surface the cause in dev. Fail-closed is
			// the safe default: better to skip a tick than to double-fire
			// a job because the leader-election machinery is broken.
			if (_IS_DEV) {
				console.error('[svelte-realtime] configureCron leader function threw; skipping tick:', err, '\n  See: https://svti.me/cron');
			}
			if (_metricsInstruments) _metricsInstruments.cronCount.inc({ path: '*', status: 'leader-error' });
			return;
		}
		if (!isLeader) {
			if (_metricsInstruments) _metricsInstruments.cronCount.inc({ path: '*', status: 'not-leader' });
			return;
		}
	}

	// Extract the wall-clock date parts the schedule matches against by
	// formatting the runtime epoch-ms through Intl in the effective time zone,
	// without constructing a Date. The effective zone is the system zone by
	// default (preserving the historical local-time cron behavior); a seeded
	// simulation harness pins it (e.g. 'UTC') so the same epoch-ms always
	// yields the same parts. The schedule math below is unchanged - only the
	// parts extraction is now Intl + time-zone based.
	const { second, minute, hour, day, month, weekday } = _cronDateParts(
		runtimeNow(),
		effectiveTimeZone() || undefined
	);

	for (const [path, entry] of cronRegistry) {
		const schedule = entry.schedule;
		const isSixField = schedule.length === 6;

		// 5-field schedules at 1 Hz tick: only fire at second :00 of the
		// matching minute, otherwise they would re-fire 60 times during
		// any matching minute. At the 60s tick this branch is skipped --
		// the tick spacing already enforces once-per-minute granularity.
		if (!isSixField && _cronAt1Hz && second !== 0) continue;

		let sf, mf, hf, df, monthf, wf;
		if (isSixField) {
			[sf, mf, hf, df, monthf, wf] = schedule;
			if (!_cronFieldMatch(sf, second)) continue;
		} else {
			[mf, hf, df, monthf, wf] = schedule;
		}
		if (!_cronFieldMatch(mf, minute)) continue;
		if (!_cronFieldMatch(hf, hour)) continue;
		if (!_cronFieldMatch(df, day)) continue;
		if (!_cronFieldMatch(monthf, month)) continue;
		if (!_cronFieldMatch(wf, weekday)) continue;

		// Single-flight: a tick that matches a job whose previous run is
		// still in flight skips with a 'skipped' metric label instead of
		// invoking it again. Surfaces overlap to ops without breaking the
		// invariant that one cron path runs at most once concurrently.
		if (_cronRunning.has(path)) {
			if (_metricsInstruments) _metricsInstruments.cronCount.inc({ path, status: 'skipped' });
			continue;
		}
		_cronRunning.add(path);

		// Match - run the job
		(async () => {
			try {
				if (!_cronPlatform) {
					// Warn at most once per process lifetime. Without dedup,
					// a 6-field schedule + idle server emits this line every
					// second across the boot-to-first-connect window,
					// drowning out other diagnostics. Reset by `_clearCron`
					// (HMR / tests) and by `setCronPlatform` so a fresh
					// capture re-arms the warning if platform later goes
					// missing again (defensive only - platform is sticky
					// across HMR by design, but we don't want to assume).
					if (_IS_DEV && !_cronPlatformWarnFired) {
						console.warn(`[svelte-realtime] Cron registered but no platform captured. Wire setCronPlatform(platform) from your hooks.ws.js init({ platform }) hook (svelte-adapter-uws >= 0.5.0-next.15) or from your open(ws, platform) hook on older adapters.\n  See: https://svti.me/cron`);
						_cronPlatformWarnFired = true;
					}
					return;
				}
				// Cluster fan-out is the framework's publish wrap's job
				// now (one wrap site for the whole framework, installed
				// by `_ensureWrap` from `setCronPlatform`). The cron tick
				// uses the captured `_cronPlatform` directly - its
				// `publish` is `derivedPublish`, which consults the
				// process-wide bus at publish time. No outer `bus.wrap(...)`
				// here, which eliminates the 0.5.6 double-relay class of
				// bugs by construction.
				const cronPub = _cronPlatform;
				const _h = _getCtxHelpers(cronPub);
				const ctx = _buildCtx(null, null, cronPub, _h, null);
				const result = await entry.fn(ctx);
				if (result !== undefined) {
					// Same auto-replay routing as ctx.publish: cron-published
					// events to a replay-eligible topic flow through
					// `platform.replay.publish` so the buffer captures them
					// and reconnecting clients can replay missed ticks.
					if (!_maybeReplayPublish(cronPub, entry.topic, 'set', result)) {
						cronPub.publish(entry.topic, 'set', result);
					}
				}
				if (_metricsInstruments) _metricsInstruments.cronCount.inc({ path, status: 'ok' });
			} catch (err) {
				if (_metricsInstruments) {
					_metricsInstruments.cronCount.inc({ path, status: 'error' });
					_metricsInstruments.cronErrors.inc({ path });
				}
				if (_serverErrorHandler) {
					_serverErrorHandler(path, err);
				} else if (_IS_DEV) {
					console.error(`[svelte-realtime] Cron '${path}' error:`, err, '\n  See: https://svti.me/cron');
				}
			} finally {
				_cronRunning.delete(path);
			}
		})();
	}
}

/**
 * Parse a 5- or 6-field cron expression into an array of field matchers.
 * 5-field form is `minute hour day month weekday` (fires at second `:00`
 * of each matching minute). 6-field form prepends `seconds` (Quartz /
 * node-cron convention) and unlocks sub-minute schedules; once any
 * 6-field schedule is registered the cron tick adapts to 1 Hz so the
 * seconds field is honored.
 *
 * Supports: *, N, N-M, N,M, and *\/N in every field.
 * @param {string} expr
 * @returns {any[]}
 */
function _parseCron(expr) {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5 && parts.length !== 6) {
		throw new Error(`[svelte-realtime] Invalid cron expression '${expr}' - expected 5 fields (minute hour day month weekday) or 6 fields (seconds minute hour day month weekday)\n  See: https://svti.me/cron`);
	}
	// Map each part to its semantic field index. 5-field input shifts
	// by one (no seconds) so fields land at indices 1..5; 6-field input
	// uses indices 0..5 directly.
	const offset = parts.length === 5 ? 1 : 0;
	return parts.map((field, idx) => _parseCronField(field, idx + offset));
}

/** Max values per cron field index: seconds, minute, hour, day, month, weekday */
const _CRON_RANGES = [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/**
 * Parse a single cron field with validation.
 * Returns null for '*' (match all), or a Set of allowed values,
 * or { step: N } for step expressions.
 * @param {string} field
 * @param {number} idx - Semantic field index (0=seconds, 1=minute, 2=hour, 3=day, 4=month, 5=weekday)
 * @returns {any}
 */
function _parseCronField(field, idx) {
	const [min, max] = _CRON_RANGES[idx] || [0, 59];

	if (field === '*') return null;

	if (field.startsWith('*/')) {
		const step = parseInt(field.slice(2), 10);
		if (!Number.isFinite(step) || step < 1) {
			throw new Error(`[svelte-realtime] Invalid cron step '${field}' - step must be a positive integer\n  See: https://svti.me/cron`);
		}
		return { step };
	}

	if (field.includes('-') && !field.includes(',')) {
		const parts = field.split('-');
		const a = parseInt(parts[0], 10);
		const b = parseInt(parts[1], 10);
		if (!Number.isFinite(a) || !Number.isFinite(b) || a < min || b > max || a > b) {
			throw new Error(`[svelte-realtime] Invalid cron range '${field}' - values must be ${min}-${max}\n  See: https://svti.me/cron`);
		}
		const vals = new Set();
		for (let i = a; i <= b; i++) vals.add(i);
		return vals;
	}

	if (field.includes(',')) {
		const nums = field.split(',').map(s => {
			const n = parseInt(s, 10);
			if (!Number.isFinite(n) || n < min || n > max) {
				throw new Error(`[svelte-realtime] Invalid cron value '${s}' in '${field}' - must be ${min}-${max}\n  See: https://svti.me/cron`);
			}
			return n;
		});
		return new Set(nums);
	}

	const n = parseInt(field, 10);
	if (!Number.isFinite(n) || n < min || n > max) {
		throw new Error(`[svelte-realtime] Invalid cron value '${field}' - must be ${min}-${max}\n  See: https://svti.me/cron`);
	}
	return new Set([n]);
}

/**
 * Check if a value matches a cron field matcher.
 * @param {any} matcher
 * @param {number} value
 * @returns {boolean}
 */
function _cronFieldMatch(matcher, value) {
	if (matcher === null) return true; // * matches all
	if (matcher.step) return value % matcher.step === 0;
	return matcher.has(value);
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
 * Create a per-module guard. Accepts middleware functions (variadic) and/or
 * a single declarative options object as the first argument:
 *
 * - `{ authenticated: true }` - throws UNAUTHENTICATED unless `ctx.user`
 *   is non-null. Cheaper to write than the equivalent function and harder
 *   to forget.
 *
 * Function-style middleware composes: `guard({ authenticated: true }, customCheck)`
 * runs the auth check first, then `customCheck(ctx)`. If any throws, the
 * chain stops. Bare-error throws are auto-classified to LiveError
 * (UNAUTHENTICATED if no user, FORBIDDEN otherwise) at the call site.
 *
 * @param {...(Function | { authenticated?: boolean })} parts
 * @returns {Function}
 */
export function guard(...parts) {
	const fns = [];
	for (const part of parts) {
		if (typeof part === 'function') {
			fns.push(part);
			continue;
		}
		if (part && typeof part === 'object') {
			if (part.authenticated === true) {
				fns.push(_guardAuthenticated);
			}
			continue;
		}
		throw new Error('[svelte-realtime] guard() accepts middleware functions or an options object');
	}
	if (fns.length === 0) {
		throw new Error('[svelte-realtime] guard() requires at least one function or option');
	}
	if (fns.length === 1) {
		/** @type {any} */ (fns[0]).__isGuard = true;
		return fns[0];
	}
	const composite = async (ctx) => {
		for (const fn of fns) {
			await fn(ctx);
		}
	};
	/** @type {any} */ (composite).__isGuard = true;
	return composite;
}

async function _guardAuthenticated(ctx) {
	if (!ctx || ctx.user == null) {
		throw new LiveError('UNAUTHENTICATED', 'Authentication required');
	}
}

/**
 * Run a per-module guard with auto-classification of non-LiveError throws.
 *
 * - LiveError thrown by the guard -> propagated as-is (caller-controlled
 *   code AND message reach the client).
 * - Bare Error / non-Error thrown -> wrapped as
 *   `LiveError(UNAUTHENTICATED, 'Authentication required')` when
 *   `ctx.user` is null, otherwise `LiveError(FORBIDDEN, 'Access denied')`.
 *   The original error is preserved on `.cause` for server-side logging
 *   but is NOT propagated to the client (avoids accidentally leaking
 *   internal details like a DB error message through a guard).
 *
 * Net: a guard can `throw new Error('whatever')` and the client sees a
 * 4xx-class typed error instead of `INTERNAL_ERROR` (5xx), without any
 * raw error text reaching the wire. To surface a specific reason, throw
 * `new LiveError('FORBIDDEN', 'Account suspended')` directly.
 *
 * @param {Function} guardFn
 * @param {any} ctx
 */
async function _runGuard(guardFn, ctx) {
	try {
		await guardFn(ctx);
	} catch (err) {
		if (err instanceof LiveError) throw err;
		const code = ctx && ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
		const msg = code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied';
		const wrapped = new LiveError(code, msg);
		/** @type {any} */ (wrapped).cause = err;
		throw wrapped;
	}
}

/**
 * Typed error that propagates code to the client.
 */
export class LiveError extends Error {
	/**
	 * @param {string} code
	 * @param {string} [message]
	 */
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

/**
 * Default maximum nesting depth allowed in an inbound RPC envelope.
 * Anything deeper than this is rejected at ingress. 64 is well past any
 * realistic application shape (typical envelopes nest one or two levels
 * deep for `{args: [...]}` and an args payload) but well short of where
 * any host-app recursive walker would stack-overflow. Override per-call
 * via `handleRpc(ws, data, platform, { maxEnvelopeDepth })`.
 */
const _DEFAULT_MAX_ENVELOPE_DEPTH = 64;

/**
 * Iterative depth walk over a parsed JSON value. Returns true when the
 * value (or any descendant) sits at a nesting depth greater than `max`.
 * Stack-based so a pathological depth cannot itself stack-overflow the
 * checker. Short-circuits on the first over-depth descendant found.
 *
 * @param {unknown} root
 * @param {number} max
 */
function exceedsEnvelopeDepth(root, max) {
	if (root === null || typeof root !== 'object') return false;
	/** @type {Array<{ obj: any, depth: number }>} */
	const stack = [{ obj: root, depth: 1 }];
	while (stack.length > 0) {
		const { obj, depth } = /** @type {{ obj: any, depth: number }} */ (stack.pop());
		if (depth > max) return true;
		if (Array.isArray(obj)) {
			for (let i = 0; i < obj.length; i++) {
				const v = obj[i];
				if (v !== null && typeof v === 'object') stack.push({ obj: v, depth: depth + 1 });
			}
		} else {
			for (const k of Object.keys(obj)) {
				const v = obj[k];
				if (v !== null && typeof v === 'object') stack.push({ obj: v, depth: depth + 1 });
			}
		}
	}
	return false;
}

/**
 * Check whether a raw WebSocket message is an RPC request and handle it.
 *
 * @param {any} ws
 * @param {ArrayBuffer} data - Raw message data from the adapter message hook
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void, maxEnvelopeDepth?: number }} [options]
 * @returns {boolean} true if the message was an RPC request
 */
export function handleRpc(ws, data, platform, options) {
	// Auto-capture platform for cron jobs
	if (!_cronPlatform && cronRegistry.size > 0) _cronPlatform = platform;

	// Fast path: only process ArrayBuffer
	if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return false;
	const bytes = new Uint8Array(data);

	// Binary RPC: byte[0] = 0x00, byte[1-2] = header length (uint16 BE)
	if (bytes[0] === 0x00 && data.byteLength > 3) {
		const headerLen = (bytes[1] << 8) | bytes[2];
		if (headerLen > 0 && 3 + headerLen <= data.byteLength) {
			try {
				const headerJson = textDecoder.decode(data.slice(3, 3 + headerLen));
				const header = JSON.parse(headerJson);
				if (typeof header.rpc === 'string' && typeof header.id === 'string') {
					const payload = data.slice(3 + headerLen);
					_executeBinaryRpc(ws, header, payload, platform, options);
					return true;
				}
			} catch (err) {
				if (_IS_DEV) {
					console.warn('[svelte-realtime] Failed to parse binary RPC header:', err, '\n  See: https://svti.me/binary');
				}
			}
		}
		return false;
	}

	// Upload chunk: byte[0] = 0x01 (live.upload streaming)
	if (bytes[0] === _UPLOAD_FRAME_CHUNK) {
		_handleUploadChunkFrame(ws, data, platform, options);
		return true;
	}

	// Upload control: byte[0] = 0x02 (cancel etc)
	if (bytes[0] === _UPLOAD_FRAME_CONTROL) {
		_handleUploadControlFrame(ws, data, platform);
		return true;
	}

	// Text RPC: must start with {"r or {"b
	if (data.byteLength < 10) return false;
	// byte[0] = '{' (0x7B), byte[1] = '"' (0x22)
	if (bytes[0] !== 0x7B) return false;
	// byte[2] = 'r' (0x72) for RPC, or 'b' (0x62) for batch
	if (bytes[2] !== 0x72 && bytes[2] !== 0x62) return false;

	/** @type {any} */
	let msg;
	try {
		msg = JSON.parse(textDecoder.decode(data));
	} catch {
		return false;
	}

	// Post-parse depth cap. The adapter's `maxPayloadLength` (default 1 MB)
	// already bounds the bytes JSON.parse ever sees, so this is defense
	// in depth against downstream handlers / instrumentation that recursively
	// walk the parsed object and could stack-overflow on pathological depth.
	// Iterative stack so the check itself never overflows.
	const maxEnvelopeDepth = (options && options.maxEnvelopeDepth) || _DEFAULT_MAX_ENVELOPE_DEPTH;
	if (exceedsEnvelopeDepth(msg, maxEnvelopeDepth)) {
		return false;
	}

	// Batch request: {"batch": [...]}
	if (Array.isArray(msg.batch)) {
		_executeBatch(ws, msg, platform, options);
		return true;
	}

	if (typeof msg.rpc !== 'string') return false;

	// Volatile (fire-and-forget) RPC: frames with no `id` field signal
	// "no reply expected". Server runs the full handler chain but skips
	// the response emit. The wire shape (id absent) is the contract; the
	// matching client surface is `rpc.fireAndForget(...)` plus the
	// `live.volatile()` server-side marker.
	if (msg.id === undefined) {
		if (msg.rpc.length === 0) return false;
		_executeVolatileRpc(ws, msg, platform, options);
		return true;
	}

	if (typeof msg.id !== 'string') return false;

	// envelope.shape invariant: rpc and id must be non-empty for routing
	assert(msg.rpc.length > 0 && msg.id.length > 0, 'realtime/handleRpc.envelope.non-empty', { rpcLen: msg.rpc.length, idLen: msg.id.length });

	// Validated as RPC - handle asynchronously, return true synchronously
	_executeRpc(ws, msg, platform, options);
	return true;
}

/**
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[], stream?: boolean, seq?: number, version?: any }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
async function _executeRpc(ws, msg, platform, options) {
	const result = await _executeSingleRpc(ws, msg, platform, options);
	_respond(ws, platform, msg.id, result);
}

/**
 * Execute a fire-and-forget RPC. Runs the full handler chain (middleware,
 * guards, rate limits, validation) but does NOT write a response frame.
 * `msg.id` is absent on the wire; an internal correlation id is synthesized
 * so metrics, devtools, and `_executeSingleRpc`'s response shape stay
 * uniform without leaking onto the wire.
 *
 * Dev-mode warns once per non-volatile handler that receives a fire-and-forget
 * call (bounded by `_VOLATILE_WARN_CAP` distinct paths) so accidental
 * `.fireAndForget()` calls against handlers that have a meaningful return
 * value surface in the server log.
 *
 * @param {any} ws
 * @param {{ rpc: string, args?: any[] }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
async function _executeVolatileRpc(ws, msg, platform, options) {
	if (_IS_DEV) {
		const path = msg.rpc;
		const fn = await _resolveRegistryEntry(path);
		if (fn && !_hasVolatileMarker(fn) && !_volatileWarnSet.has(path)) {
			if (_volatileWarnSet.size < _VOLATILE_WARN_CAP) _volatileWarnSet.add(path);
			console.warn(
				`[svelte-realtime] handler '${path}' received a fire-and-forget call but is not marked live.volatile(). ` +
				"Errors will be silently dropped (no reply is sent). Wrap the handler with live.volatile() to make this intent explicit.\n  See: https://svti.me/volatile"
			);
		}
	}
	/** @type {any} */ (msg).id = '__volatile';
	await _executeSingleRpc(ws, /** @type {any} */ (msg), platform, options);
	// No _respond - fire-and-forget contract.
}

/**
 * Walk the `__wrappedFn` chain produced by `live.rateLimit` / `live.idempotent`
 * / `live.breaker` / `live.validated` / `live.lock` to find an inner
 * `__volatileRpc` marker. Lets users wrap a `live.volatile(handler)` core
 * with any combination of the other markers in any order without tripping
 * the dev-mode "not marked volatile" warning. Bounded walk (depth 8) so a
 * pathological cycle cannot loop forever.
 * @param {any} fn
 */
function _hasVolatileMarker(fn) {
	let cur = fn;
	for (let i = 0; cur && i < 8; i++) {
		if (cur.__volatileRpc) return true;
		cur = cur.__wrappedFn;
	}
	return false;
}

/**
 * Execute a batch of RPC calls. Supports parallel (default) and sequential modes.
 *
 * @param {any} ws
 * @param {{ batch: Array<{ rpc: string, id: string, args?: any[], stream?: boolean }>, sequential?: boolean }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
async function _executeBatch(ws, msg, platform, options) {
	const { batch, sequential } = msg;
	const _batchMetricsStart = _metricsInstruments ? monotonicNow() : 0;

	if (batch.length > 50) {
		_recordRpcMetrics('__batch__', 'INVALID_REQUEST', _batchMetricsStart);
		_respond(ws, platform, '__batch', {
			batch: [{ id: '', ok: false, code: 'INVALID_REQUEST', error: 'Batch exceeds maximum of 50 calls' }]
		});
		return;
	}

	if (!_lazyResolved) await _resolveAllLazy();

	/** @type {Array<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>} */
	let results;

	if (sequential) {
		results = new Array(batch.length);
		for (let i = 0; i < batch.length; i++) {
			const call = batch[i];
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				results[i] = { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' };
				continue;
			}
			results[i] = await _executeSingleRpc(ws, call, platform, options);
		}
	} else {
		results = await Promise.all(batch.map((call) => {
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				return { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' };
			}
			return _executeSingleRpc(ws, call, platform, options);
		}));
	}

	_respond(ws, platform, '__batch', { batch: results });
}

/**
 * Stream branch of `_executeSingleRpc`: validate args, gate, resolve topic,
 * subscribe, run optional channel/delta/replay/seq-delta short-circuits, run
 * the loader, apply transform/migration, build the response envelope.
 *
 * Mutates `subscribedRef.topic` on successful subscribe so the caller's
 * catch block can roll the subscription back if a later step throws. May
 * itself throw inside `fn(ctx, ...streamArgs)`; that bubbles up to the
 * caller's catch.
 *
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {Function} fn
 * @param {any} ctx
 * @param {any[]} args
 * @param {{ id: string, seq?: number, schemaVersion?: number, version?: any }} msg
 * @param {{ topic: any }} subscribedRef
 * @returns {Promise<any>}
 */
async function _executeStreamRpc(ws, platform, fn, ctx, args, msg, subscribedRef) {
	const { id, seq: clientSeq, schemaVersion: clientSchemaVersion } = msg;

	// Validate args BEFORE topic resolution - prevents topic injection
	// via malformed dynamic-topic args (e.g. `audit:${orgId}` with
	// orgId crafted to escape the topic namespace). The validated
	// tuple is bound to a stream-branch-local `let` to keep the
	// outer `args` const for the non-stream path's V8 inline cache.
	let streamArgs = args;
	const argsSchema = /** @type {any} */ (fn).__streamArgs;
	if (argsSchema) {
		const result = _validate(argsSchema, streamArgs);
		if (!result.ok) {
			const err = { id, ok: false, code: 'VALIDATION', error: result.message };
			/** @type {any} */ (err).issues = result.issues;
			return err;
		}
		if (Array.isArray(result.data)) streamArgs = result.data;
	}

	if (/** @type {any} */ (fn).__isGated) {
		const predicate = /** @type {any} */ (fn).__gatePredicate;
		// Await the predicate so an async predicate that returns `false`
		// is denied correctly. A sync predicate is awaited just the same
		// (await unwraps non-Promise values transparently).
		if (!(await predicate(ctx, ...streamArgs))) {
			return { id, ok: true, data: null, gated: true };
		}
	}

	const rawTopic = /** @type {any} */ (fn).__streamTopic;
	const topic = typeof rawTopic === 'function' ? _callTopicFn(rawTopic, ctx, streamArgs) : rawTopic;
	if (typeof topic === 'string' && topic.startsWith('__')) {
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Reserved topic prefix' };
	}
	const streamOpts = /** @type {any} */ (fn).__streamOptions;
	const replayOpts = /** @type {any} */ (fn).__replay;
	// Dynamic-topic stream registration: when the topic is resolved per
	// subscribe (factory form), register the resolved topic so subsequent
	// publishers (cron, derived, RPC) auto-route through replay. Static
	// topics already registered at declaration time in `live.stream`.
	if (replayOpts && typeof rawTopic === 'function' && typeof topic === 'string') {
		_registerReplayTopic(topic);
	}

	const streamFilter = /** @type {any} */ (fn).__streamFilter;
	if (streamFilter && !(await streamFilter(ctx, ...streamArgs))) {
		const code = ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
		return { id, ok: false, code, error: code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
	}

	const classOfService = /** @type {any} */ (fn).__classOfService;
	if (classOfService && _admissionConfig) {
		try {
			if (_shouldShed(platform, classOfService)) {
				return { id, ok: false, code: 'OVERLOADED', error: `Stream class '${classOfService}' shed under pressure` };
			}
		} catch (err) {
			return { id, ok: false, code: 'INVALID_REQUEST', error: /** @type {Error} */ (err).message };
		}
	}

	// Wire-level subscribe gate + atomic subscribe. `platform.subscribe`
	// runs the adapter's `subscribe` / `subscribeBatch` hook chain,
	// enforces `MAX_SUBSCRIPTIONS_PER_CONNECTION`, and updates the
	// adapter-side per-connection subscription state (the `subs` Set,
	// `totalSubscriptions` counter, and the close-hook's
	// `ctx.subscriptions` parameter). Without going through this path,
	// the loader would run, deliver initial data, and the room's
	// __onSubscribe would publish a 'join' before the adapter's hook
	// fires (which only fires on the client's follow-on subscribe-batch
	// wire frame, AFTER the stream RPC returns), AND the resulting
	// subscription would be invisible to the adapter's observability
	// surface (close-hook subscriptions set, per-conn cap). The
	// optional-chain on `platform.subscribe` keeps older adapters
	// working: if the method isn't there, we fall back to raw
	// `ws.subscribe` and only the in-realtime gates (`__streamFilter`,
	// `live.room({ guard })`) remain the stream-RPC access checks.
	let _subscribeDenial = null;
	try {
		if (typeof platform.subscribe === 'function') {
			_subscribeDenial = await platform.subscribe(ws, topic);
		} else {
			ws.subscribe(topic);
		}
	} catch {
		return { id, ok: false, code: 'CONNECTION_CLOSED', error: 'WebSocket closed' };
	}
	if (_subscribeDenial) {
		return { id, ok: false, code: _subscribeDenial, error: _subscribeDenial === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
	}
	_trackStreamSub(ws, topic, fn);
	subscribedRef.topic = topic;

	if (/** @type {any} */ (fn).__onSubscribe) {
		try { await /** @type {any} */ (fn).__onSubscribe(ctx, topic); } catch {}
	}

	if (/** @type {any} */ (fn).__isDerived && !_activateDerivedCalled && !_warnedActivateDerived) {
		if (_IS_DEV) {
			_warnedActivateDerived = true;
			console.warn('[svelte-realtime] live.derived() subscribed but _activateDerived(platform) was never called. Derived streams will not receive live updates.\n  Call _activateDerived(platform) in your WebSocket open hook.\n  See: https://svti.me/derived');
		}
	}

	// Channel fast-path
	if (/** @type {any} */ (fn).__isChannel) {
		const emptyValue = streamOpts.merge === 'set' ? null : [];
		return { id, ok: true, data: emptyValue, topic, merge: streamOpts.merge, key: streamOpts.key, max: streamOpts.max, channel: true };
	}

	// Delta sync
	const deltaOpts = /** @type {any} */ (fn).__delta;
	const clientVersion = msg.version;
	if (deltaOpts && clientVersion !== undefined && deltaOpts.version && deltaOpts.diff) {
		try {
			const currentVersion = await deltaOpts.version();
			if (currentVersion === clientVersion) {
				return { id, ok: true, data: [], topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, unchanged: true, version: currentVersion };
			}
			const diff = await deltaOpts.diff(clientVersion);
			if (diff !== null && diff !== undefined) {
				return { id, ok: true, data: diff, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, delta: true, version: currentVersion };
			}
		} catch {}
	}

	// Replay (bounded recent buffer)
	if (replayOpts && typeof clientSeq === 'number' && platform.replay) {
		try {
			const missed = await platform.replay.since(topic, clientSeq);
			if (missed) {
				const currentSeq = await platform.replay.seq(topic);
				return { id, ok: true, data: missed, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, seq: currentSeq, replay: true };
			}
		} catch {}
	}

	// Flag fresh-subscribe seeding (cluster-latest on cold connect). A
	// fresh subscribe omits `seq`, so the seq-gated block above is skipped
	// and the loader would otherwise return this replica's locally-cached
	// value. For a flag backed by shared replay, read the whole buffer
	// (size:1 => one `set` envelope) and serve it through the same
	// `replay: true` array response the seq-gated block uses, so a fresh
	// connect to a replica that never set the flag locally still gets the
	// cluster-latest value. Gated strictly on `__isFlag` so non-flag replay
	// streams (crud/latest, whose loaders intentionally hit the DB on a
	// fresh subscribe) keep loader-only fresh-subscribe behavior. Empty
	// buffer (no `.set()` anywhere yet) falls through to the loader.
	if (replayOpts && platform.replay && typeof clientSeq === 'undefined' && /** @type {any} */ (fn).__isFlag) {
		try {
			const missed = await platform.replay.since(topic, 0);
			if (Array.isArray(missed) && missed.length > 0) {
				const currentSeq = await platform.replay.seq(topic);
				return { id, ok: true, data: missed, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, seq: currentSeq, replay: true };
			}
		} catch {}
	}

	// Seq-delta (user-provided bridge for older-than-buffer reconnects)
	if (deltaOpts && typeof deltaOpts.fromSeq === 'function' && typeof clientSeq === 'number') {
		try {
			const events = await deltaOpts.fromSeq(clientSeq);
			if (Array.isArray(events)) {
				let respSeq;
				if (events.length > 0) {
					const last = events[events.length - 1];
					if (last && typeof last.seq === 'number') respSeq = last.seq;
				}
				if (respSeq === undefined && platform.replay) {
					try { respSeq = await platform.replay.seq(topic); } catch {}
				}
				const deltaResp = {
					id, ok: true, data: events, topic,
					merge: streamOpts.merge, key: streamOpts.key,
					prepend: streamOpts.prepend, max: streamOpts.max,
					replay: true
				};
				if (respSeq !== undefined) deltaResp.seq = respSeq;
				return deltaResp;
			}
		} catch {}
	}

	let result;
	try {
		result = await fn(ctx, ...streamArgs);
	} catch (err) {
		const streamOnError = /** @type {any} */ (fn).__streamOnError;
		if (streamOnError) {
			try { await streamOnError(err, ctx, topic); } catch {}
		}
		throw err;
	}

	// Arm the staleness watchdog now that the loader succeeded.
	// Idempotent per topic, so multi-subscriber streams only ever
	// run one watchdog regardless of how many subscribers join.
	if (/** @type {any} */ (fn).__streamStaleAfterMs) {
		_registerStaleWatch(topic, fn, ctx, streamArgs, platform);
	}

	// Arm the topic-invalidation watcher(s). Same first-wins
	// idempotence story as the stale watchdog - duplicate
	// (pattern, topic) registrations are a no-op inside
	// _registerInvalidationWatch.
	if (/** @type {any} */ (fn).__streamInvalidateOn) {
		_registerInvalidationWatch(topic, fn, ctx, streamArgs, platform);
	}

	const isPaginated = result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result;
	let resultData = isPaginated ? result.data : result;

	// Apply transform to initial data: per-item for arrays
	// (crud/latest/presence/cursor merge), whole-value for non-arrays
	// (set merge). Live-event transforms run separately at publish time.
	const initTransform = /** @type {any} */ (fn).__streamTransform;
	if (initTransform && resultData != null) {
		resultData = _applyInitTransform(initTransform, resultData);
	}

	// Schema migration
	const serverVersion = /** @type {any} */ (fn).__streamVersion;
	const migrateFns = /** @type {any} */ (fn).__streamMigrate;
	if (serverVersion !== undefined && migrateFns && typeof clientSchemaVersion === 'number' && clientSchemaVersion < serverVersion) {
		resultData = _migrateData(resultData, clientSchemaVersion, serverVersion, migrateFns);
	}

	const response = {
		id, ok: true, data: resultData, topic, merge: streamOpts.merge,
		key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max,
		hasMore: undefined, cursor: undefined, seq: undefined,
		version: undefined, schemaVersion: undefined, replay: undefined,
		derived: /** @type {any} */ (fn).__isDerived || undefined
	};

	if (isPaginated) {
		response.hasMore = result.hasMore;
		if (result.cursor !== undefined) response.cursor = result.cursor;
	}
	if (replayOpts && platform.replay) {
		try { response.seq = await platform.replay.seq(topic); } catch {}
	}
	if (typeof clientSeq === 'number') response.replay = false;
	if (deltaOpts && deltaOpts.version) {
		try { response.version = await deltaOpts.version(); } catch {}
	}
	if (serverVersion !== undefined) response.schemaVersion = serverVersion;

	return response;
}

/**
 * Execute a single RPC call and return the result (used by batch and single execution).
 *
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[], stream?: boolean }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 * @returns {Promise<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>}
 */
async function _executeSingleRpc(ws, msg, platform, options) {
	const { rpc: path, id, args: rawArgs, stream: isStream, cursor: clientCursor } = msg;
	const _metricsStart = _metricsInstruments ? monotonicNow() : 0;

	if (!_validPathRe.test(path)) {
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Invalid path' };
	}

	if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
		_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' };
	}

	if (!_lazyResolved) await _resolveAllLazy();

	const args = rawArgs || [];
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		if (_IS_DEV) {
			console.warn(`[svelte-realtime] RPC call to '${path}' - no such live function registered\n  See: https://svti.me/rpc`);
		}
		_recordRpcMetrics(path, 'NOT_FOUND', _metricsStart);
		return { id, ok: false, code: 'NOT_FOUND', error: 'Not found' };
	}

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(ws.getUserData(), ws, platform, _h, clientCursor !== undefined ? clientCursor : null, msg.idempotencyKey);
	const _subscribedRef = { topic: null };

	try {
		const _result = await _runWithMiddleware(ctx, async () => {
		const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
		const guardFn = await _resolveGuard(modulePath);
		if (guardFn) await _runGuard(guardFn, ctx);

		if (options?.beforeExecute) {
			await options.beforeExecute(ws, path, args);
		}

		if (isStream && /** @type {any} */ (fn).__isStream) {
			return await _executeStreamRpc(ws, platform, fn, ctx, args, msg, _subscribedRef);
		} else {
			// Registry-level rate limit. Per-handler `live.rateLimit(...)`
			// wraps fn directly and runs its own check inside the wrapper, so
			// we skip the registry check when __isRateLimited is set --
			// "explicit per-handler wins over central config".
			if (_rateLimitConfig && !(/** @type {any} */ (fn).__isRateLimited)) {
				const rule = _resolveRegistryRateLimit(path);
				if (rule) {
					const userKey = _getIdentityKey(ctx);
					const r = _consumeRateLimitBucket(path + '\0' + userKey, rule.points, rule.window);
					if (!r.ok) {
						/** @type {any} */
						const out = { id, ok: false, code: 'RATE_LIMITED', error: 'Too many requests' };
						out.retryAfter = r.retryAfter;
						return out;
					}
				}
			}
			const result = await fn(ctx, ...args);
			return { id, ok: true, data: result };
		}
		}); // end _runWithMiddleware
		_recordRpcMetrics(path, (_result && _result.ok === false) ? (_result.code || 'UNKNOWN') : '', _metricsStart);
		return _result;
	} catch (err) {
		if (_subscribedRef.topic) _rollbackStreamSubscribe(ws, _subscribedRef.topic, fn, ctx);
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart);
		if (err instanceof LiveError) {
			/** @type {any} */
			const result = { id, ok: false, code: err.code, error: err.message };
			if (/** @type {any} */ (err).issues) result.issues = /** @type {any} */ (err).issues;
			return result;
		}
		if (options?.onError) {
			try { options.onError(path, err, ctx); } catch {}
		}
		if (_IS_DEV) {
			console.warn(
				`[svelte-realtime] '${path}' threw a non-LiveError:`,
				err,
				'\nUse throw new LiveError(code, message) for client-visible errors. Raw errors are hidden from clients.\n  See: https://svti.me/errors'
			);
			console.error(`[svelte-realtime] Error in '${path}':`, err);
		}
		return { id, ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' };
	}
}

/**
 * Execute a binary RPC call.
 *
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[] }} header
 * @param {ArrayBuffer} payload - Raw binary data
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: Function, onError?: Function }} [options]
 */
async function _executeBinaryRpc(ws, header, payload, platform, options) {
	const { rpc: path, id, args: extraArgs } = header;
	const _metricsStart = _metricsInstruments ? monotonicNow() : 0;

	if (!_validPathRe.test(path)) {
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Invalid path' });
		return;
	}

	if (extraArgs !== undefined && !Array.isArray(extraArgs)) {
		_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' });
		return;
	}

	if (!_lazyResolved) await _resolveAllLazy();
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		_recordRpcMetrics(path, 'NOT_FOUND', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'NOT_FOUND', error: 'Not found' });
		return;
	}

	if (!/** @type {any} */ (fn).__isBinary) {
		_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Not a binary endpoint' });
		return;
	}

	const maxBinarySize = /** @type {any} */ (fn).__maxBinarySize || 10485760;
	if (payload.byteLength > maxBinarySize) {
		_recordRpcMetrics(path, 'PAYLOAD_TOO_LARGE', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'Binary payload exceeds size limit' });
		return;
	}

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(ws.getUserData(), ws, platform, _h, null);

	try {
		await _runWithMiddleware(ctx, async () => {
			const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
			const guardFn = await _resolveGuard(modulePath);
			if (guardFn) await _runGuard(guardFn, ctx);

			if (options?.beforeExecute) {
				await options.beforeExecute(ws, path, [payload, ...(extraArgs || [])]);
			}

			const result = await fn(ctx, payload, ...(extraArgs || []));
			_respond(ws, platform, id, { ok: true, data: result });
		});
		_recordRpcMetrics(path, '', _metricsStart);
	} catch (err) {
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart);
		if (err instanceof LiveError) {
			_respond(ws, platform, id, { ok: false, code: err.code, error: err.message });
		} else {
			if (options?.onError) {
				try { options.onError(path, err, ctx); } catch {}
			}
			if (_IS_DEV) {
				console.error(`[svelte-realtime] Error in binary '${path}':`, err, '\n  See: https://svti.me/binary');
			}
			_respond(ws, platform, id, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
		}
	}
}

// - Streaming uploads (live.upload) -----------------------------------------
//
// Wire format (client -> server):
//
//   Chunk frame (byte[0] = 0x01):
//     [0]      0x01 - chunk marker
//     [1]      flags
//                bit 0: hasArgs   (set on chunk 0 only)
//                bit 1: isLast
//                bits 2-7: reserved (must be 0)
//     [2..5]   streamId, big-endian uint32
//     [6..9]   seq, big-endian uint32 (0-indexed)
//     [10..]   if hasArgs:
//                [10..11] argsLen, big-endian uint16
//                [12..12+argsLen-1] argsJson UTF-8: { rpc: path, args: [...] }
//                [12+argsLen..] payload bytes
//              else:
//                [10..] payload bytes
//
//   Control frame (byte[0] = 0x02):
//     [0]      0x02 - control marker
//     [1]      ctrlType (0x10 = client cancel)
//     [2..5]   streamId
//     [6..]    type-specific payload
//
// Wire format (server -> client):
//   platform.send(ws, '__upload', streamIdHex, payload) where payload is one of:
//     { ok: true, data: <handler return> }
//     { ok: false, code, error }
//
// Per-chunk overhead is 10 bytes (12 + argsLen on chunk 0). For 64KB chunks
// that's 0.015% overhead.

const _UPLOAD_FRAME_CHUNK = 0x01;
const _UPLOAD_FRAME_CONTROL = 0x02;
const _UPLOAD_CTRL_CANCEL = 0x10;
const _UPLOAD_FLAG_HAS_ARGS = 0x01;
const _UPLOAD_FLAG_IS_LAST = 0x02;
const _UPLOAD_FLAG_RESERVED_MASK = 0xFC;

// Caps applied during the brief 'pending' window between chunk-0 arriving
// and the handler being resolved. Three boundaries on memory:
//   - _UPLOAD_PENDING_MAX_CHUNKS bounds queue depth for tiny chunks.
//   - _UPLOAD_PENDING_MAX_SIZE bounds total bytes per stream.
//   - _UPLOAD_PENDING_MAX_AGGREGATE bounds total bytes across ALL streams
//     in the pending phase, so an attacker cannot multiply per-stream
//     caps by opening many concurrent connections / streamIds. Apps
//     with large legitimate concurrent uploads can raise it via
//     _setUploadCapsForTest in tests, or via a future runtime knob.
// Once the handler is resolved, per-handler caps in __uploadOptions take over.
const _UPLOAD_PENDING_MAX_CHUNKS = 64;
const _UPLOAD_PENDING_MAX_SIZE = 16 * 1024 * 1024;
let _UPLOAD_PENDING_MAX_AGGREGATE = 64 * 1024 * 1024;
let _pendingUploadBytes = 0;

/**
 * Per-WS upload registry. WeakMap so connections that GC before close()
 * don't leak entries.
 * @type {WeakMap<any, Map<number, any>>}
 */
const _wsUploads = new WeakMap();

/** Global counter for `maxConcurrentTotal` enforcement. */
let _totalActiveUploads = 0;

/**
 * Cached `platform.maxPayloadLength` from whichever adapter is in use.
 * Constant per-process, so we capture it the first time we see a platform
 * with the field. Piggybacked onto the first upload response per WS so
 * clients can compute an optimal chunk size automatically.
 */
let _uploadMaxFrameSize = 0;

/** Per-WS set: clients that have already received the `__cap` hint. */
const _informedAboutUploadCap = new WeakSet();

function _captureUploadMaxFrameSize(platform) {
	if (_uploadMaxFrameSize > 0) return;
	if (platform && typeof platform.maxPayloadLength === 'number' && platform.maxPayloadLength > 0) {
		_uploadMaxFrameSize = platform.maxPayloadLength;
	}
}

/** @internal Reset auto-discovery cache. Test-only. */
export function _resetUploadAutoDiscovery() {
	_uploadMaxFrameSize = 0;
}

function _streamIdHex(streamId) {
	return (streamId >>> 0).toString(16).padStart(8, '0');
}

function _respondUpload(ws, platform, streamId, payload) {
	_captureUploadMaxFrameSize(platform);
	let envelope = payload;
	let willInform = false;
	if (_uploadMaxFrameSize > 0 && !_informedAboutUploadCap.has(ws)) {
		envelope = { ...payload, __cap: _uploadMaxFrameSize };
		willInform = true;
	}
	try {
		platform.send(ws, '__upload', _streamIdHex(streamId), envelope);
		if (willInform) _informedAboutUploadCap.add(ws);
	} catch {
		// Closed connection - same swallow as _respond
	}
}

/**
 * Parse an upload chunk frame. Returns null if the frame is malformed.
 *
 * @param {ArrayBuffer} data
 */
function _parseUploadChunkFrame(data) {
	const byteLength = data.byteLength;
	if (byteLength < 10) return null;

	const view = new DataView(data);
	const flags = view.getUint8(1);

	// Reject any frame with reserved bits set so future versions can use them
	// without breaking old clients (clients should send 0 for unknown bits).
	if ((flags & _UPLOAD_FLAG_RESERVED_MASK) !== 0) return null;

	const hasArgs = (flags & _UPLOAD_FLAG_HAS_ARGS) !== 0;
	const isLast = (flags & _UPLOAD_FLAG_IS_LAST) !== 0;
	const streamId = view.getUint32(2, false);
	const seq = view.getUint32(6, false);

	// Stream-shape invariant: chunk 0 carries the args header, later chunks don't.
	if (seq === 0 && !hasArgs) return null;
	if (seq !== 0 && hasArgs) return null;

	let payloadOffset = 10;
	let argsHeader = null;

	if (hasArgs) {
		if (byteLength < 12) return null;
		const argsLen = view.getUint16(10, false);
		if (argsLen === 0) return null;
		payloadOffset = 12 + argsLen;
		if (byteLength < payloadOffset) return null;
		try {
			const argsJson = textDecoder.decode(new Uint8Array(data, 12, argsLen));
			argsHeader = JSON.parse(argsJson);
		} catch {
			return null;
		}
	}

	const payload = byteLength > payloadOffset ? data.slice(payloadOffset) : null;
	return { hasArgs, isLast, streamId, seq, argsHeader, payload };
}

/**
 * Parse an upload control frame. Returns null if malformed.
 *
 * @param {ArrayBuffer} data
 */
function _parseUploadControlFrame(data) {
	if (data.byteLength < 6) return null;
	const view = new DataView(data);
	return {
		ctrlType: view.getUint8(1),
		streamId: view.getUint32(2, false)
	};
}

/**
 * Create the async-iterable wrapper that the upload handler consumes via
 * `for await (const chunk of ctx.stream)`.
 *
 * Wires `ctrl.signal` so any abort (cancel, disconnect, cap exceeded)
 * causes a pending `next()` to reject and clears the queue.
 *
 * @param {AbortController} ctrl
 */
function _createUploadStream(ctrl) {
	/** @type {Uint8Array[]} */
	const queue = [];
	/** @type {{ resolve: Function, reject: Function } | null} */
	let pending = null;
	let done = false;
	/** @type {Error | null} */
	let error = null;

	function _resolveNext(value, isDone) {
		if (!pending) return;
		const r = pending; pending = null;
		r.resolve({ value, done: isDone });
	}
	function _rejectNext(err) {
		if (!pending) return;
		const r = pending; pending = null;
		r.reject(err);
	}

	function push(chunk) {
		if (done) return;
		if (pending) { _resolveNext(chunk, false); return; }
		queue.push(chunk);
	}

	function end() {
		if (done) return;
		done = true;
		if (pending && queue.length === 0) _resolveNext(undefined, true);
	}

	function abort(err) {
		if (done) return;
		done = true;
		error = err;
		queue.length = 0;
		_rejectNext(err);
	}

	const onAbort = () => {
		const reason = ctrl.signal.reason;
		const err = reason instanceof Error
			? reason
			: new LiveError('CANCELLED', typeof reason === 'string' ? reason : 'upload cancelled');
		abort(err);
	};
	if (ctrl.signal.aborted) onAbort();
	else ctrl.signal.addEventListener('abort', onAbort, { once: true });

	const stream = {
		next() {
			if (queue.length > 0) {
				return Promise.resolve({ value: queue.shift(), done: false });
			}
			if (error) return Promise.reject(error);
			if (done) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve, reject) => { pending = { resolve, reject }; });
		},
		return() {
			done = true;
			queue.length = 0;
			_resolveNext(undefined, true);
			return Promise.resolve({ value: undefined, done: true });
		},
		throw(err) {
			abort(err);
			return Promise.reject(err);
		},
		[Symbol.asyncIterator]() { return this; }
	};

	return {
		stream,
		push,
		end,
		abort,
		get queueLength() { return queue.length; }
	};
}

/**
 * Release pre-handler-resolution bytes attributed to an upload back to
 * the aggregate accumulator. Idempotent: zeros _pendingAggBytes after
 * release so a second call is a no-op. Called on transition out of
 * the pending phase and on every cleanup path that might short-circuit
 * the normal pending -> running transition.
 */
function _releasePendingUploadBytes(upload) {
	if (!upload || !upload._pendingAggBytes) return;
	_pendingUploadBytes = Math.max(0, _pendingUploadBytes - upload._pendingAggBytes);
	upload._pendingAggBytes = 0;
}

/**
 * Remove an upload from the registry and decrement the global counter.
 * Idempotent.
 */
function _cleanupUpload(ws, perWs, streamId) {
	if (!perWs) return;
	const upload = perWs.get(streamId);
	if (!upload) return;
	_releasePendingUploadBytes(upload);
	perWs.delete(streamId);
	if (perWs.size === 0) _wsUploads.delete(ws);
	_totalActiveUploads = Math.max(0, _totalActiveUploads - 1);
}

/**
 * Synchronously create a pending upload entry. The entry is registered in the
 * per-WS map BEFORE the async start path begins so subsequent chunks arriving
 * during setup are queued (in `pendingChunks`) instead of dropped.
 *
 * Phase transitions: 'pending' -> 'running' (after handler resolved) -> 'settled'.
 * 'settled' is also reachable directly from 'pending' on capacity rejection,
 * disconnect, or cancellation before the handler starts.
 */
function _createUploadEntry(ws, perWs, streamId, platform) {
	/** @type {any} */
	const upload = {
		streamId,
		phase: 'pending',
		pendingChunks: [],
		expectedSeq: 0,
		bytesReceived: 0,
		options: null,
		streamWrap: null,
		ctrl: null,
		// Re-auth state. Populated by `_startUpload` once the guard has
		// resolved when `live.upload({ reauthEvery })` opt-in is set; left
		// unset (0 / null) for legacy uploads so the chunk pump's cheap
		// numeric check stays a single comparison on the hot path.
		_reauthEvery: 0,
		_reauthGuardFn: null,
		_reauthCtx: null,
		_lastReauthBytes: 0,
		_reauthInflight: null,
		fail(code, error) {
			if (upload.phase === 'settled') return;
			upload.phase = 'settled';
			if (upload.ctrl) {
				try { upload.ctrl.abort(new LiveError(code, error)); } catch {}
			}
			_respondUpload(ws, platform, streamId, { ok: false, code, error });
			_cleanupUpload(ws, perWs, streamId);
		}
	};
	return upload;
}

/**
 * Handle a 0x01 upload chunk frame.
 *
 * @param {any} ws
 * @param {ArrayBuffer} data
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: Function, onError?: Function }} [options]
 */
function _handleUploadChunkFrame(ws, data, platform, options) {
	const parsed = _parseUploadChunkFrame(data);
	if (!parsed) {
		if (_IS_DEV) console.warn('[svelte-realtime] Malformed upload chunk frame; dropping\n  See: https://svti.me/uploads');
		return;
	}

	const { isLast, streamId, seq, argsHeader, payload } = parsed;
	let perWs = _wsUploads.get(ws);

	if (seq === 0) {
		if (perWs && perWs.has(streamId)) {
			_respondUpload(ws, platform, streamId, {
				ok: false, code: 'INVALID_REQUEST', error: 'streamId already active'
			});
			return;
		}
		// Aggregate pre-handler-resolution memory cap. Reject chunk-0
		// BEFORE allocating the pending entry so the registry does not
		// even hold a record of the rejected upload. Worst-case attack
		// pre-fix: N concurrent WS opening streamId 0 with a 16 MB
		// payload each = 16 * N MB held until a handler resolves, with
		// no handler-side cap able to fire. Post-fix: aggregate is
		// bounded by _UPLOAD_PENDING_MAX_AGGREGATE regardless of N.
		const initialBytes = payload ? payload.byteLength : 0;
		if (_pendingUploadBytes + initialBytes > _UPLOAD_PENDING_MAX_AGGREGATE) {
			_respondUpload(ws, platform, streamId, {
				ok: false, code: 'OVERLOADED',
				error: 'pending-upload aggregate buffer cap exceeded; retry shortly'
			});
			return;
		}
		if (!perWs) { perWs = new Map(); _wsUploads.set(ws, perWs); }

		const upload = _createUploadEntry(ws, perWs, streamId, platform);
		upload.bytesReceived = initialBytes;
		upload.expectedSeq = 1;
		upload.pendingChunks.push({ payload, isLast });
		upload._pendingAggBytes = initialBytes;
		_pendingUploadBytes += initialBytes;
		perWs.set(streamId, upload);
		_totalActiveUploads++;

		_startUpload(ws, perWs, streamId, upload, argsHeader, platform, options);
		return;
	}

	const upload = perWs?.get(streamId);
	if (!upload || upload.phase === 'settled') {
		// Late chunk for an upload that already finished or was cancelled.
		// Drop silently - common race when the handler returns early.
		return;
	}

	if (seq !== upload.expectedSeq) {
		upload.fail('INVALID_REQUEST', `out-of-order chunk: expected ${upload.expectedSeq}, got ${seq}`);
		return;
	}
	upload.expectedSeq = seq + 1;

	const payloadLen = payload ? payload.byteLength : 0;
	if (payloadLen > 0) upload.bytesReceived += payloadLen;

	if (upload.phase === 'pending') {
		// Bound memory while the handler is being resolved.
		if (upload.bytesReceived > _UPLOAD_PENDING_MAX_SIZE) {
			upload.fail('PAYLOAD_TOO_LARGE', 'upload exceeds limit during start');
			return;
		}
		if (upload.pendingChunks.length >= _UPLOAD_PENDING_MAX_CHUNKS) {
			upload.fail('FLOW_BACKPRESSURE', 'too many chunks queued during upload start');
			return;
		}
		// Aggregate cap also applies to follow-on chunks while pending.
		// upload.fail() releases the bytes via _releasePendingUploadBytes.
		if (_pendingUploadBytes + payloadLen > _UPLOAD_PENDING_MAX_AGGREGATE) {
			upload.fail('OVERLOADED', 'pending-upload aggregate buffer cap exceeded');
			return;
		}
		upload.pendingChunks.push({ payload, isLast });
		upload._pendingAggBytes += payloadLen;
		_pendingUploadBytes += payloadLen;
		return;
	}

	// Running phase
	if (upload.bytesReceived > upload.options.maxSize) {
		upload.fail('PAYLOAD_TOO_LARGE', 'upload exceeds maxSize');
		return;
	}
	if (payloadLen > 0) {
		if (upload.streamWrap.queueLength >= upload.options.maxBufferedChunks) {
			upload.fail('FLOW_BACKPRESSURE', 'upload buffer overflow - handler not draining fast enough');
			return;
		}
		upload.streamWrap.push(new Uint8Array(payload));
	}
	// reauthEvery: re-run the module guard against the live ctx whenever
	// the upload crosses a configured byte threshold. The check is
	// fire-and-forget because the receive path is sync and the guard is
	// async; if the guard rejects, upload.fail aborts the stream and the
	// handler observes the abort signal. A re-auth already in flight is
	// honored to avoid running parallel guards on the same ctx (the most
	// recent one is what matters; the sync byte counter does the
	// scheduling).
	if (upload._reauthEvery > 0 && upload._reauthGuardFn && !upload._reauthInflight) {
		const sinceLast = upload.bytesReceived - upload._lastReauthBytes;
		if (sinceLast >= upload._reauthEvery) {
			upload._lastReauthBytes = upload.bytesReceived;
			upload._reauthInflight = (async () => {
				try {
					await _runGuard(upload._reauthGuardFn, upload._reauthCtx);
				} catch (err) {
					if (upload.phase !== 'settled') {
						const code = (err && /** @type {any} */ (err).code) || 'UNAUTHENTICATED';
						const msg = (err && /** @type {any} */ (err).message) || 'reauth failed';
						upload.fail(code, msg);
					}
				} finally {
					upload._reauthInflight = null;
				}
			})();
		}
	}
	if (isLast) upload.streamWrap.end();
}

/**
 * Handle a 0x02 upload control frame.
 *
 * @param {any} ws
 * @param {ArrayBuffer} data
 * @param {import('svelte-adapter-uws').Platform} platform
 */
function _handleUploadControlFrame(ws, data, platform) {
	const parsed = _parseUploadControlFrame(data);
	if (!parsed) {
		if (_IS_DEV) console.warn('[svelte-realtime] Malformed upload control frame; dropping\n  See: https://svti.me/uploads');
		return;
	}

	const { ctrlType, streamId } = parsed;
	const perWs = _wsUploads.get(ws);
	const upload = perWs?.get(streamId);

	if (ctrlType === _UPLOAD_CTRL_CANCEL) {
		if (!upload || upload.phase === 'settled') return;
		upload.fail('CANCELLED', 'upload cancelled by client');
		return;
	}

	if (_IS_DEV) {
		console.warn(`[svelte-realtime] Unknown upload control type 0x${ctrlType.toString(16)} for stream ${_streamIdHex(streamId)}\n  See: https://svti.me/uploads`);
	}
}

/**
 * Resolve the registered live.upload handler, transition the upload from
 * 'pending' to 'running', drain queued chunks, and drive the handler with the
 * async-iterable. All response paths route through `upload.fail()` or the
 * success branch exactly once (guarded by `upload.phase`).
 *
 * @param {any} ws
 * @param {Map<number, any>} perWs
 * @param {number} streamId
 * @param {any} upload - pre-registered pending entry from _handleUploadChunkFrame
 * @param {any} argsHeader - parsed { rpc, args } from chunk 0
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: Function, onError?: Function }} [options]
 */
async function _startUpload(ws, perWs, streamId, upload, argsHeader, platform, options) {
	const _metricsStart = _metricsInstruments ? monotonicNow() : 0;
	let path = '';
	/** @type {any} */ let ctx = null;

	try {
		if (!argsHeader || typeof argsHeader.rpc !== 'string') {
			_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
			upload.fail('INVALID_REQUEST', 'missing rpc path');
			return;
		}

		path = argsHeader.rpc;
		const args = Array.isArray(argsHeader.args) ? argsHeader.args : [];

		if (!_validPathRe.test(path)) {
			_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
			upload.fail('INVALID_REQUEST', 'Invalid path');
			return;
		}

		if (!_lazyResolved) await _resolveAllLazy();
		if (upload.phase === 'settled') return;

		const fn = await _resolveRegistryEntry(path);
		if (upload.phase === 'settled') return;

		if (!fn) {
			_recordRpcMetrics(path, 'NOT_FOUND', _metricsStart);
			upload.fail('NOT_FOUND', 'Not found');
			return;
		}
		if (!/** @type {any} */ (fn).__isUpload) {
			_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
			upload.fail('INVALID_REQUEST', 'Not an upload endpoint');
			return;
		}

		const uploadOptions = /** @type {any} */ (fn).__uploadOptions;

		// Capacity caps. perWs and _totalActiveUploads already include this
		// upload, so subtract one to count "others".
		let othersInSession = 0;
		for (const e of perWs.values()) if (e !== upload) othersInSession++;
		if (othersInSession >= uploadOptions.maxConcurrentPerSession) {
			_recordRpcMetrics(path, 'TOO_MANY_UPLOADS', _metricsStart);
			upload.fail('TOO_MANY_UPLOADS', 'too many concurrent uploads on this session');
			return;
		}
		if (_totalActiveUploads - 1 >= uploadOptions.maxConcurrentTotal) {
			_recordRpcMetrics(path, 'TOO_MANY_UPLOADS', _metricsStart);
			upload.fail('TOO_MANY_UPLOADS', 'too many concurrent uploads');
			return;
		}
		if (upload.bytesReceived > uploadOptions.maxSize) {
			_recordRpcMetrics(path, 'PAYLOAD_TOO_LARGE', _metricsStart);
			upload.fail('PAYLOAD_TOO_LARGE', 'upload exceeds maxSize');
			return;
		}

		// Transition to running phase and create the live iterable.
		upload.options = uploadOptions;
		upload.ctrl = new AbortController();
		upload.streamWrap = _createUploadStream(upload.ctrl);
		upload.phase = 'running';

		// The bytes are now under the user's per-handler maxSize cap, not
		// the pre-handler aggregate cap. Release the aggregate accounting
		// here so other concurrent uploads can use the budget.
		_releasePendingUploadBytes(upload);

		// Drain chunks queued during the pending phase into the live stream.
		const drained = upload.pendingChunks;
		upload.pendingChunks = null;
		for (let i = 0; i < drained.length; i++) {
			const c = drained[i];
			if (c.payload && c.payload.byteLength > 0) {
				upload.streamWrap.push(new Uint8Array(c.payload));
			}
			if (c.isLast) upload.streamWrap.end();
		}

		const _h = _getCtxHelpers(platform);
		ctx = _buildCtx(ws.getUserData(), ws, platform, _h, null);
		ctx.stream = upload.streamWrap.stream;
		ctx.signal = upload.ctrl.signal;
		ctx.upload = { id: _streamIdHex(streamId) };

		await _runWithMiddleware(ctx, async () => {
			const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
			const guardFn = await _resolveGuard(modulePath);
			if (guardFn) await _runGuard(guardFn, ctx);

			// Capture guard + ctx for reauthEvery so the chunk pump can
			// re-run the same gate against the live ctx without re-resolving
			// the module path. Stored on the upload entry so the receive
			// path can fire it from a non-async context.
			if (uploadOptions.reauthEvery > 0 && guardFn) {
				upload._reauthGuardFn = guardFn;
				upload._reauthCtx = ctx;
				upload._reauthEvery = uploadOptions.reauthEvery;
				upload._lastReauthBytes = upload.bytesReceived;
			}

			if (options?.beforeExecute) {
				await options.beforeExecute(ws, path, args);
			}

			const result = await fn(ctx, ...args);
			if (upload.phase !== 'settled') {
				upload.phase = 'settled';
				_respondUpload(ws, platform, streamId, { ok: true, data: result });
			}
		});
		_recordRpcMetrics(path, '', _metricsStart);
	} catch (err) {
		if (upload.phase !== 'settled') {
			upload.phase = 'settled';
			const code = err instanceof LiveError ? err.code : 'INTERNAL_ERROR';
			_recordRpcMetrics(path || '__invalid__', code, _metricsStart);
			if (err instanceof LiveError) {
				_respondUpload(ws, platform, streamId, { ok: false, code: err.code, error: err.message });
			} else {
				if (options?.onError) {
					try { options.onError(path, err, ctx); } catch {}
				}
				if (_IS_DEV) console.error(`[svelte-realtime] Error in upload '${path}':`, err, '\n  See: https://svti.me/uploads');
				_respondUpload(ws, platform, streamId, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
			}
		} else {
			_recordRpcMetrics(path || '__invalid__', err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart);
		}
		// Make sure any pending for-await wakes up if we exited via throw.
		if (upload.ctrl && !upload.ctrl.signal.aborted) {
			try { upload.ctrl.abort(err instanceof Error ? err : new Error(String(err))); } catch {}
		}
	} finally {
		_cleanupUpload(ws, perWs, streamId);
	}
}

/**
 * Drain in-flight uploads owned by `ws`. Called from `close()`.
 * Each upload's signal is aborted so the handler's `for await` wakes up
 * and any cleanup the user wired runs. No response is sent (the WS is closed).
 *
 * @param {any} ws
 */
function _drainUploadsOnClose(ws) {
	const perWs = _wsUploads.get(ws);
	if (!perWs) return;
	for (const upload of perWs.values()) {
		if (upload.phase === 'settled') continue;
		upload.phase = 'settled';
		if (upload.ctrl) {
			try { upload.ctrl.abort(new LiveError('DISCONNECTED', 'connection closed')); } catch {}
		}
		_totalActiveUploads = Math.max(0, _totalActiveUploads - 1);
	}
	_wsUploads.delete(ws);
}

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
	// double-bump counter). The audit calls this out as a bug-causing-bug:
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

// - Throttle / Debounce infrastructure ----------------------------------------

/** Hard cap on throttle/debounce entries to prevent memory exhaustion */
const _THROTTLE_DEBOUNCE_MAX = 5000;

/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, lastData: any, lastEvent: string, platform: any, lastRun: number }>} */
const _throttles = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const _debounces = new Map();

/**
 * Throttle a publish to a topic. Sends at most once per `ms` milliseconds.
 * The last value always arrives (trailing edge).
 *
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {number} ms - Throttle interval in milliseconds
 */
function _throttlePublish(platform, topic, event, data, ms) {
	const entityKey = data && typeof data === 'object' && data.key !== undefined ? '\0' + data.key : '';
	const key = topic + '\0' + event + entityKey;
	const existing = _throttles.get(key);
	const now = runtimeNow();

	if (!existing) {
		if (_throttles.size >= _THROTTLE_DEBOUNCE_MAX) {
			// At capacity - publish immediately without a trailing-edge timer
			// so data is never silently dropped
			platform.publish(topic, event, data);
			return;
		}
		platform.publish(topic, event, data);
		_throttles.set(key, {
			timer: setTimer(() => {
				const entry = _throttles.get(key);
				if (entry && entry.lastData !== undefined) {
					platform.publish(topic, event, entry.lastData);
				}
				_throttles.delete(key);
			}, ms),
			lastData: undefined,
			lastEvent: event,
			lastRun: now
		});
		return;
	}

	// Subsequent calls within the window - store for trailing edge
	existing.lastData = data;
	existing.lastEvent = event;
}

/**
 * Debounce a publish to a topic. Only sends after `ms` milliseconds of silence.
 *
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {number} ms - Debounce interval in milliseconds
 */
function _debouncePublish(platform, topic, event, data, ms) {
	const entityKey = data && typeof data === 'object' && data.key !== undefined ? '\0' + data.key : '';
	const key = topic + '\0' + event + entityKey;
	const existing = _debounces.get(key);
	if (existing) clearTimer(existing);

	if (!existing && _debounces.size >= _THROTTLE_DEBOUNCE_MAX) {
		// At capacity - publish immediately instead of evicting an active timer
		platform.publish(topic, event, data);
		return;
	}

	_debounces.set(key, setTimer(() => {
		_debounces.delete(key);
		platform.publish(topic, event, data);
	}, ms));
}

/**
 * Per-key gate state. Each entry is a setTimeout handle that self-deletes
 * the key when its cooldown window elapses. Shape mirrors `_throttles` /
 * `_debounces` so memory accounting and cap semantics are uniform.
 *
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const _skipGates = new Map();

/**
 * Per-key rate gate. Returns `true` to skip the call (key is within its
 * cooldown window), `false` to run it (no entry, or window elapsed). The
 * caller pairs this with an early `return` inside an RPC handler:
 *
 *     export const moveNote = live(async (ctx, noteId, x, y) => {
 *       if (ctx.skip(`move:${noteId}`, 16)) return;  // drop calls within 16ms
 *       await dbUpdateNote(noteId, x, y);
 *       ctx.publish(TOPICS.notes, 'updated', { noteId, x, y });
 *     });
 *
 * Pairs with `ctx.shed` semantically (both return `true` to early-return),
 * so call sites read uniformly. Different from `ctx.publishThrottled` /
 * `ctx.publishDebounced` which schedule outbound publishes - `ctx.skip`
 * gates the inbound handler body.
 *
 * **Memory:** capped at `_THROTTLE_DEBOUNCE_MAX` (5000) entries. When the
 * cap is hit, the gate fails open (returns `false`, does NOT stamp a new
 * entry) so a runaway dynamic-key generator (e.g. spraying unique keys to
 * exhaust the map) cannot silently start blocking legitimate calls. The
 * first cap-hit fires a one-shot dev warning so operators see the issue.
 *
 * **Cluster:** state is per-replica. Each replica that received an RPC
 * call evaluates `ctx.skip` against its local map; the gate is a CPU/DB
 * shed, not a cluster-wide ratelimit. For cross-replica gating use
 * `live.rateLimit({ store: 'redis' })` or `redis/ratelimit`.
 *
 * @param {string} key
 * @param {number} ms
 * @returns {boolean} `true` to skip the call; `false` to run it
 */
function _skipGate(key, ms) {
	if (typeof key !== 'string') {
		throw new LiveError('INVALID_ARG', 'ctx.skip: key must be a string (got ' + (typeof key) + ')');
	}
	if (typeof ms !== 'number' || !(ms > 0) || !Number.isFinite(ms)) {
		throw new LiveError('INVALID_ARG', 'ctx.skip: ms must be a positive finite number (got ' + String(ms) + ')');
	}
	if (_skipGates.has(key)) return true;
	if (_skipGates.size >= _THROTTLE_DEBOUNCE_MAX) {
		if (_IS_DEV && !_skipGateCapWarned) {
			_skipGateCapWarned = true;
			console.warn(
				'[svelte-realtime] ctx.skip: gate map at capacity (' + _THROTTLE_DEBOUNCE_MAX + ' entries). ' +
				'Falling open - calls are no longer being gated. Check for runaway dynamic-key generation ' +
				'(e.g. unique-per-request keys).\n' +
				'  See: https://svti.me/skip-gate'
			);
		}
		return false;
	}
	_skipGates.set(key, setTimer(() => { _skipGates.delete(key); }, ms));
	return false;
}

/**
 * Dev-only sanity check for `ctx.publishThrottled` / `ctx.publishDebounced`
 * (and the deprecated `ctx.throttle` / `ctx.debounce` aliases). Logs a
 * one-time warning per helper name when args don't match the publish-
 * helper shape `(topic: string, event: string, data: any, ms: number > 0)`.
 *
 * The misuse pattern is calling `ctx.throttle('move:id', 50)` thinking it
 * gates a handler - it doesn't, it's a 4-arg publish helper. The warning
 * points at `ctx.skip(key, ms)` as the actual gate primitive.
 *
 * Production silently continues (no throw) so existing buggy deployments
 * don't crash on adapter upgrade; the dev warning surfaces the issue at
 * code-change time, not at runtime.
 *
 * @param {string} name - bare helper name (e.g. `'publishThrottled'`)
 * @param {ReadonlyArray<unknown>} args - the call's argument list
 */
function _checkPublishHelperArgs(name, args) {
	if (!_IS_DEV) return;
	if (_publishHelperBadArgsWarned[name]) return;
	const ok = args.length >= 4
		&& typeof args[0] === 'string'
		&& typeof args[1] === 'string'
		&& typeof args[3] === 'number'
		&& /** @type {number} */ (args[3]) > 0
		&& Number.isFinite(/** @type {number} */ (args[3]));
	if (ok) return;
	_publishHelperBadArgsWarned[name] = true;
	console.warn(
		'[svelte-realtime] ctx.' + name + ' called with bad args -- expected ' +
		'(topic: string, event: string, data: any, ms: number > 0). Got ' +
		'argc=' + args.length + ', topic=' + (typeof args[0]) +
		', event=' + (typeof args[1]) +
		', ms=' + (typeof args[3] === 'number' ? String(args[3]) : typeof args[3]) + '. ' +
		'ctx.' + name + ' is a publish helper, not a handler gate. ' +
		'For per-key handler gating use ctx.skip(key, ms); for handler-wide rate ' +
		'limiting use live.rateLimit().\n' +
		'  See: https://svti.me/publish-helper-args'
	);
}

/**
 * Send an RPC response to a single client.
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} correlationId
 * @param {Record<string, any>} payload
 */
/**
 * Apply schema migration functions to data.
 * Chains migrations from clientVersion to serverVersion.
 * @param {any} data
 * @param {number} fromVersion
 * @param {number} toVersion
 * @param {Record<number, (item: any) => any>} migrateFns
 * @returns {any}
 */
function _migrateData(data, fromVersion, toVersion, migrateFns) {
	if (Array.isArray(data)) {
		return data.map(item => _migrateItem(item, fromVersion, toVersion, migrateFns));
	}
	return _migrateItem(data, fromVersion, toVersion, migrateFns);
}

/**
 * Apply chained migrations to a single item.
 * @param {any} item
 * @param {number} fromVersion
 * @param {number} toVersion
 * @param {Record<number, (item: any) => any>} migrateFns
 * @returns {any}
 */
function _migrateItem(item, fromVersion, toVersion, migrateFns) {
	let result = item;
	for (let v = fromVersion; v < toVersion; v++) {
		const fn = migrateFns[v];
		if (fn) {
			result = fn(result);
		} else if (_IS_DEV) {
			console.warn(`[svelte-realtime] Missing migration function for version ${v} -> ${v + 1}\n  See: https://svti.me/schema`);
		}
	}
	return result;
}

function _respond(ws, platform, correlationId, payload) {
	if (_IS_DEV) {
		// Estimate size without double-serialization.
		const data = payload.data;
		if ((Array.isArray(data) && data.length > 5000) || (typeof data === 'string' && data.length > 800_000)) {
			console.warn(
				`[svelte-realtime] RPC response for '${correlationId}' contains ${data.length} items - ` +
				"large responses may exceed maxPayloadLength (default 1 MB; raise `websocket.maxPayloadLength` in svelte.config.js if needed).\n  See: https://svti.me/adapter-config"
			);
		}
	}
	try {
		const result = platform.send(ws, '__rpc', correlationId, payload);
		if (result === 0 && _IS_DEV) {
			console.warn(
				`[svelte-realtime] RPC response was not delivered (backpressure or closed connection)`
			);
		}
	} catch (err) {
		// uWS throws when accessing a closed WebSocket - expected during mid-RPC disconnect.
		if (_IS_DEV) {
			console.warn(`[svelte-realtime] RPC response for '${correlationId}' could not be delivered (client likely disconnected)`);
		}
	}
}

/**
 * Execute a live function directly (in-process), without WebSocket.
 * Used by SSR load functions to call live functions server-side.
 *
 * Opt-in `fallback` / `onError` for partial-degradation:
 * - When `fallback` is set in `options`, ANY error thrown during
 *   execution (loader, validation, guard, filter) is caught,
 *   `onError` is invoked with the error if provided, and the
 *   `fallback` value is returned in place of the loader's result.
 * - When `fallback` is NOT in `options`, errors propagate as before
 *   (back-compat). The presence of the key opts in - the value
 *   itself can be anything (empty array, sentinel object, even
 *   `null` or `undefined`).
 *
 * Apps wire `fallback` per-stream so a single failed loader on a
 * multi-stream page renders an empty placeholder rather than taking
 * down the entire `+page.server.js` `load()`.
 *
 * @param {string} path - RPC path (e.g. 'chat/messages')
 * @param {any[]} args - Arguments to pass (excluding ctx)
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ user?: any, fallback?: any, onError?: (err: any) => void }} [options]
 * @returns {Promise<any>}
 */
export async function __directCall(path, args, platform, options) {
	const hasFallback = options ? ('fallback' in options) : false;
	const fallback = hasFallback ? options.fallback : undefined;
	const onError = options && typeof options.onError === 'function' ? options.onError : null;

	try {
		return await _runDirectCall(path, args, platform, options);
	} catch (err) {
		if (!hasFallback) throw err;
		if (onError) {
			try { onError(err); } catch {}
		}
		return fallback;
	}
}

async function _runDirectCall(path, args, platform, options) {
	if (!_lazyResolved) await _resolveAllLazy();
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		throw new LiveError('NOT_FOUND', `Live function '${path}' not found`);
	}

	// Distinguish "user explicitly passed (even as null)" from "user omitted".
	// Omitted + guarded stream is almost always a load() bug - throw a
	// descriptive Error so the SSR overlay surfaces the fix immediately.
	const userExplicit = options ? ('user' in options) : false;
	const userValue = userExplicit ? options.user : null;

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(userValue, null, platform, _h, null);

	// Run global middleware chain, then guard, then execution
	return _runWithMiddleware(ctx, async () => {
	// Run module guard
	const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
	const guardFn = await _resolveGuard(modulePath);
	if (guardFn) {
		if (!userExplicit) {
			throw new Error(
				`[svelte-realtime] '${path}' has a guard but .load() was called without a user.\n` +
				`  Pass it explicitly:    stream.load(platform, { user: locals.user })\n` +
				`  Or opt into anonymous: stream.load(platform, { user: null })\n` +
				`  See: https://svti.me/ssr`
			);
		}
		await _runGuard(guardFn, ctx);
	}

	if (/** @type {any} */ (fn).__isStream) {
		const argsSchema = /** @type {any} */ (fn).__streamArgs;
		if (argsSchema) {
			const result = _validate(argsSchema, args);
			if (!result.ok) {
				const err = new LiveError('VALIDATION', result.message);
				/** @type {any} */ (err).issues = result.issues;
				throw err;
			}
			args = Array.isArray(result.data) ? result.data : args;
		}

		if (/** @type {any} */ (fn).__isGated) {
			const predicate = /** @type {any} */ (fn).__gatePredicate;
			// Await for parity with the wire-level path: an async predicate
			// that returns `false` would otherwise produce a truthy Promise
			// here and be treated as "allow".
			if (!(await predicate(ctx, ...args))) return null;
		}
		const streamFilter = /** @type {any} */ (fn).__streamFilter;
		if (streamFilter && !(await streamFilter(ctx, ...args))) {
			const code = ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
			throw new LiveError(code, code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied');
		}
		let result;
		try {
			result = await fn(ctx, ...args);
		} catch (err) {
			const streamOnError = /** @type {any} */ (fn).__streamOnError;
			if (streamOnError) {
				// Best-effort: resolve the topic for the error-handler so apps
				// can log per-topic. Topic-resolution errors are swallowed.
				let topic;
				try {
					const rawTopic = /** @type {any} */ (fn).__streamTopic;
					topic = typeof rawTopic === 'function' ? _callTopicFn(rawTopic, ctx, args) : rawTopic;
				} catch {}
				try { await streamOnError(err, ctx, topic); } catch {}
			}
			throw err;
		}
		const initTransform = /** @type {any} */ (fn).__streamTransform;
		if (initTransform && result != null) {
			// Match the WS subscribe path: paginated responses transform .data only.
			if (result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result) {
				result = { ...result, data: _applyInitTransform(initTransform, result.data) };
			} else {
				result = _applyInitTransform(initTransform, result);
			}
		}
		return result;
	}

	return fn(ctx, ...args);
	});
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
			if (_metricsInstruments) _metricsInstruments.streamGauge.dec();
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
					if (_metricsInstruments) _metricsInstruments.streamGauge.dec();
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
 * One-shot dev-mode flag for the "createMessage({ platform: callback })
 * is redundant" warning. A user-supplied `platform` callback in
 * `createMessage` was the pre-0.5.6 way to wire bus.wrap into the RPC
 * hook. With 0.5.7+ the framework installs a single publish wrap on the
 * adapter platform (via `_ensureWrap`, called from
 * `setCronPlatform` / `_activateDerived` / first message), and that
 * wrap is the sole `bus.wrap(...)` site. A manual callback that wraps
 * with `bus.wrap` stacks an outer relay on top of the inner one and
 * double-delivers every RPC publish to other replicas. We can't detect
 * the manual-wrap case from the callback's output (user-built wraps
 * don't carry our sentinel), but the input platform is the activated
 * adapter platform, so we warn at receive time when both conditions
 * hold. Module-level so a user creating multiple message hooks sees
 * one warning total.
 */
let _manualPlatformCallbackWarnFired = false;

/**
 * Reset the one-shot dev-warn flag for tests. Production deployments
 * don't need this - the warning is meant to fire once per process and
 * the flag never needs resetting outside test isolation.
 */
export function _resetManualPlatformCallbackWarn() {
	_manualPlatformCallbackWarnFired = false;
}

/**
 * Ready-made message hook. Re-export from hooks.ws.js for zero-config
 * RPC routing.
 *
 * First call per platform installs the framework's publish wrap via
 * `_ensureWrap` (idempotent), so apps that wire `setBus(bus)` and
 * re-export `message` but never call `_activateDerived` /
 * `setCronPlatform` themselves still get cluster routing on first
 * RPC. Subsequent calls are no-ops on the wrap path. Without a bus,
 * the wrap's per-publish overhead is one function call plus a
 * `Map.has` check on an empty Map - well below noise.
 *
 * Signature matches the adapter's message hook exactly.
 *
 * @param {any} ws
 * @param {{ data: ArrayBuffer, platform: import('svelte-adapter-uws').Platform }} ctx
 */
export function message(ws, { data, platform }) {
	_ensureWrap(platform);
	handleRpc(ws, data, platform);
}

/**
 * Create a custom message hook with options baked in.
 *
 * @param {{ platform?: (p: import('svelte-adapter-uws').Platform) => import('svelte-adapter-uws').Platform, beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void, onJsonMessage?: (ws: any, msg: any, platform: import('svelte-adapter-uws').Platform) => void, maxJsonDepth?: number, onUnhandled?: (ws: any, data: ArrayBuffer, platform: import('svelte-adapter-uws').Platform) => void }} [options]
 * @returns {(ws: any, ctx: { data: ArrayBuffer, msg?: any, platform: import('svelte-adapter-uws').Platform }) => void}
 */
export function createMessage(options) {
	if (!options) return message;

	const { platform: transformPlatform, beforeExecute, onError, onJsonMessage, onUnhandled } = options;
	const maxJsonDepth = (options && /** @type {any} */ (options).maxJsonDepth) || _DEFAULT_MAX_ENVELOPE_DEPTH;

	/** @type {any} */
	const rpcOpts = {};
	if (beforeExecute) rpcOpts.beforeExecute = beforeExecute;
	if (onError) rpcOpts.onError = onError;
	const hasRpcOpts = beforeExecute || onError;

	return function customMessage(ws, ctx) {
		const { data, platform } = ctx;
		// `msg` is forwarded by svelte-adapter-uws when it JSON-parsed the
		// frame for control-message routing but no control type matched.
		// Undefined on older adapter versions / binary / prefix-miss / parse-
		// fail / non-object. See svelte-adapter-uws MessageContext docs.
		const forwardedMsg = /** @type {any} */ (ctx).msg;
		// Install the framework's publish wrap on the platform (idempotent
		// per platform). After this returns, `platform.publish` is
		// `derivedPublish`, which is the single bus-routing site for the
		// whole framework. Done BEFORE any transform callback so the
		// callback sees the wrapped publish path (correct ordering for
		// non-bus transforms like metrics instrumentation; double-wrap
		// detected and warned for legacy bus.wrap callbacks).
		_ensureWrap(platform);
		let p;
		if (transformPlatform) {
			// Dev-only nudge: a `platform` callback against an
			// already-activated platform with a process-wide bus wired
			// almost always means a legacy `(p) => bus.wrap(p)` callback
			// is layered on top of `derivedPublish`'s inner bus.wrap,
			// which double-relays every RPC publish. Warn once per
			// process; users with a non-bus transform (e.g. metrics
			// instrumentation) can ignore.
			if (_IS_DEV
				&& !_manualPlatformCallbackWarnFired
				&& _getBus()
			) {
				_manualPlatformCallbackWarnFired = true;
				console.warn(
					"[svelte-realtime] createMessage({ platform: callback }) is redundant when `setBus(...)` is wired: " +
					"the framework already routes ctx.publish through the bus, so a manual `bus.wrap(p)` callback double-relays every RPC publish to other replicas. " +
					"Drop the `platform` option to fix. If your callback does a non-bus transform (e.g. metrics) you can ignore this warning.\n" +
					"  See: https://svti.me/cluster-relay"
				);
			}
			p = transformPlatform(platform);
		} else {
			p = platform;
		}
		const handled = handleRpc(ws, data, p, hasRpcOpts ? rpcOpts : undefined);
		if (handled) return;

		// JSON-envelope dispatch. Plugin-layer frames (cursor `{type:'cursor',...}`,
		// future presence-snapshot, typing indicators, etc.) reach a single
		// callback with the parsed value, so user wiring doesn't re-parse on
		// every frame.
		//
		// Two-tier lookup:
		// 1) Fast path - if the adapter already parsed for control routing,
		//    use the forwarded `msg` directly (one parse total).
		// 2) Fallback - if the adapter didn't forward (older adapter version,
		//    frame > 8 KiB, or first byte not `{"ty`), parse here.
		//
		// `exceedsEnvelopeDepth` mirrors `handleRpc`'s defense-in-depth against
		// host walkers; deeper-than-cap envelopes fall through to `onUnhandled`
		// with raw bytes so callers can log without crashing.
		//
		// The adapter's `maxPayloadLength` (default 1 MB) already bounds the
		// bytes `JSON.parse` ever sees - no separate size cap needed here.
		if (onJsonMessage) {
			/** @type {any} */
			let dispatchMsg;
			if (forwardedMsg !== undefined && forwardedMsg !== null && typeof forwardedMsg === 'object') {
				if (!exceedsEnvelopeDepth(forwardedMsg, maxJsonDepth)) {
					dispatchMsg = forwardedMsg;
				}
				// Adapter forwarded an envelope but depth busted -> skip fallback
				// (re-parsing the same bytes would produce the same too-deep object).
			} else if (data instanceof ArrayBuffer && data.byteLength >= 2) {
				const bytes = new Uint8Array(data);
				if (bytes[0] === 0x7B /* '{' */) {
					try {
						const parsed = JSON.parse(textDecoder.decode(data));
						if (parsed !== null && typeof parsed === 'object' && !exceedsEnvelopeDepth(parsed, maxJsonDepth)) {
							dispatchMsg = parsed;
						}
					} catch { /* fall through to onUnhandled */ }
				}
			}
			if (dispatchMsg !== undefined) {
				onJsonMessage(ws, dispatchMsg, p);
				return;
			}
		}

		if (onUnhandled) {
			onUnhandled(ws, data, p);
		}
	};
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
	return _derivedPlatform || _cronPlatform || null;
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
		_serverErrorHandler = onError;
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
