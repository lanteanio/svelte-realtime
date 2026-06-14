// @ts-check

// Cross-section mutable server state, kept in one module instance so the modules
// server.js is split into all read and write the same values.
//
// Two mechanisms, chosen by binding kind:
//   - Maps / Sets / Arrays are exported as live `const` bindings. They are only
//     ever mutated in place (.set / .delete / .push / .length = 0), never
//     reassigned, so every importing module observes the same mutations through
//     the shared binding.
//   - Reassignable scalars live as properties on the exported `state` holder. An
//     ESM import binding is read-only at the consumer, but a property of an
//     imported const object can be read AND written from any module, so
//     `state.x = v` works across the split where a bare `export let` would not.

/* -------------------------------------------------------------------------- *
 * Shared collections (mutated in place; never reassigned)                     *
 * -------------------------------------------------------------------------- */

/** @type {Map<string, Function>} */
export const registry = new Map();

/** @type {Map<string, Function>} */
export const guards = new Map();

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
export const _topicWsCounts = new Map();

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
export const _topicStaleWatch = new Map();

/** @type {Map<string, { timerId: ReturnType<typeof setTimeout>, sawEvent: boolean }>} */
export const _silentTopicWatch = new Map();

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
export const _topicCoalesce = new Map();

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
export const _topicTransform = new Map();

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
export const _topicVolatile = new Map();

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
export const _topicInvalidationWatch = new Map();

/** @type {WeakMap<any, { publish: Function, publishThrottled: Function, publishDebounced: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function, skip: Function }>} */
export const _ctxHelpersCache = new WeakMap();

/** @type {Map<string, { prev: number, curr: number, windowStart: number, windowMs: number }>} */
export const _rateLimits = new Map();

/** @type {Map<string, { schedule: number[], fn: Function, topic: string }>} */
export const cronRegistry = new Map();

/** @type {Map<string, { sources: string[], fn: Function, topic: string, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
export const derivedRegistry = new Map();

/** @type {Map<string, { sources: string[], fn: Function, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
export const effectRegistry = new Map();

/** @type {Map<string, { source: string, reducers: any, topic: string, state: any, snapshot: Function | null, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
export const aggregateRegistry = new Map();

/** @type {Map<string, any>} Topic-keyed lookup for aggregates */
export const _aggregateByTopic = new Map();

/**
 * Queue of deferred registrations for cron/derived/effect/aggregate/room-actions.
 * Populated when lazy loaders are passed to __registerCron, __registerDerived, etc.
 * Resolved on first RPC call or cron tick via _resolveAllLazy().
 * @type {Array<{ type: string, path: string, loader: Function }>}
 */
export const _lazyQueue = [];

/**
 * Per topic+userId presence tracking.
 *  - `count`: number of active subscriptions for this user in this room.
 *  - `timer`: pending grace-period leave (or null).
 *  - `data`: the user-supplied presence payload (`presenceFn(ctx)` result),
 *    held so the presence stream's init can reconstruct the roster from
 *    in-memory state when `platform.presence.list` isn't wired (zero-config
 *    dev path). Production wires a cluster-aware `platform.presence` and
 *    bypasses this fallback. Memory: bounded by `MAX_PRESENCE_REF`; entries
 *    are dropped on the grace-timer expiry or under cap eviction.
 * @type {Map<string, { count: number, timer: ReturnType<typeof setTimeout> | null, data: any }>}
 */
export const _presenceRef = new Map();

/** @type {Map<Function, object>} O(1) lookup from fn reference to dynamic derived registry entry */
export const _dynamicDerivedByFn = new Map();

/** @type {Map<string, Set<any>>} Source topic -> derived entries that watch it */
export const _derivedBySource = new Map();

/** @type {Map<string, Set<any>>} Source topic -> effect entries that watch it */
export const _effectBySource = new Map();

/** @type {Map<string, Set<any>>} Source topic -> outbound-webhook entries that watch it */
export const _webhookOutBySource = new Map();

/** @type {Map<string, Set<any>>} Source topic -> aggregate entries that watch it */
export const _aggregateBySource = new Map();

/** @type {Set<string>} All source topics watched by derived/effect/aggregate for fast bail-out */
export const _watchedTopics = new Set();

/* -------------------------------------------------------------------------- *
 * Reassignable cross-section scalars (holder properties)                      *
 * -------------------------------------------------------------------------- */

export const state = {
	/**
	 * Global handler for server-side errors (cron, effects, derived, webhook
	 * delivery, dispatch). Set via onError(); null until configured.
	 * @type {((path: string, error: unknown) => void) | null}
	 */
	serverErrorHandler: null,

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
	bus: null,

	/**
	 * Mirror of `state.bus` for the cron tick: the bus setter writes both in
	 * lockstep so the cron path reads the canonical bus directly. Always equal
	 * to `state.bus`. Treat as read-only.
	 * @type {{ wrap: (platform: any) => any } | null}
	 */
	cronBus: null,

	/**
	 * Monotonic counter bumped on every bus swap. Used by per-platform
	 * `bus.wrap(...)` caches to detect "the bus changed under me, re-wrap"
	 * without holding a strong reference to the old bus.
	 * @type {number}
	 */
	busEpoch: 0,

	/** @type {import('svelte-adapter-uws').Platform | null} */
	cronPlatform: null,

	/** @type {import('svelte-adapter-uws').Platform | null} Captured platform for dynamic derived recomputation */
	derivedPlatform: null,

	/** @type {boolean} Whether _activateDerived has been called at least once. */
	activateDerivedCalled: false,

	/** @type {boolean} Whether the missing-_activateDerived warning has already fired (one-shot). */
	warnedActivateDerived: false,

	/** @type {boolean} One-shot dedup for the "createMessage({ platform: callback }) is redundant" dev-warn. */
	manualPlatformCallbackWarnFired: false,

	/** @type {{ rpcCount?: any, rpcDuration?: any, rpcErrors?: any, streamGauge?: any, cronCount?: any, cronErrors?: any, assertions?: any } | null} */
	metricsInstruments: null,

	/** @type {{ classes: Record<string, string[] | ((snapshot: any) => boolean)> } | null} */
	admissionConfig: null,

	/** @type {((ws: any) => string | null | undefined) | null} */
	pushIdentify: null,

	/**
	 * One-shot flag for the MAX_PRESENCE_REF saturation warning. Reset by
	 * `_resetCapsForTest`.
	 * @type {boolean}
	 */
	presenceRefWarnFired: false,

	/**
	 * Aggregate cap (bytes) across all in-flight upload buffers before the
	 * handler resolves. Mutable so `_setCapsForTest` can lower it; restored by
	 * `_resetCapsForTest`.
	 * @type {number}
	 */
	UPLOAD_PENDING_MAX_AGGREGATE: 64 * 1024 * 1024,

	/**
	 * Running total of bytes buffered across all pre-resolution uploads. Reset
	 * to 0 by `_resetCapsForTest`.
	 * @type {number}
	 */
	pendingUploadBytes: 0,

	// The five cap shadows below are placeholders: server.js seeds them at
	// module-init from the public cap constants (MAX_PUSH_REGISTRY etc.) so the
	// canonical default lives in exactly one place. Tests lower them via
	// `_setCapsForTest` and restore via `_resetCapsForTest`.

	/** @type {number} */
	maxPushRegistry: 10_000_000,

	/** @type {number} */
	topicWsCountsWarnThreshold: 1_000_000,

	/** @type {number} */
	silentTopicWarnDedupMax: 1_000_000,

	/** @type {number} */
	publishRateWarnDedupMax: 1_000_000,

	/** @type {number} */
	maxPresenceRef: 1_000_000
};
