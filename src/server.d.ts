import type { Platform, WebSocket } from 'svelte-adapter-uws';

/** A reseedable deterministic generator: the same seed yields the same draws. */
export interface SharedRandom {
	/** Restart the stream from a new seed. */
	reseed(seed: number): void;
	/** A draw in [0, 1). */
	float(): number;
	/** A draw over the full unsigned 32-bit range. */
	u32(): number;
}

/**
 * Create a reseedable deterministic generator (re-exported from the adapter's
 * smooth plugin). Reseed from a stable id - a command id, an entity id, a world
 * seed - to get the identical draw sequence on the server, the client, and every
 * replay. The same generator `live.smooth`'s `apply` receives as `ctx.rng`.
 */
export function createSharedRandom(seed?: number): SharedRandom;

/**
 * Context passed to `live.cron()` functions.
 * No `user` or `ws` since cron jobs run outside a connection.
 */
export interface CronContext {
	/** The platform API (publish, send, topic helpers). */
	platform: Platform;
	/** Shorthand for `platform.publish` - delegates to whatever platform was passed in. */
	publish: Platform['publish'];
	/**
	 * Publish a value to a topic at most once per `ms` milliseconds.
	 * The latest value always arrives (trailing edge). Outbound publish
	 * helper - does NOT gate handler execution. For per-key handler gating
	 * use `ctx.skip(key, ms)`.
	 */
	publishThrottled(topic: string, event: string, data: any, ms: number): void;
	/**
	 * Publish a value to a topic after `ms` milliseconds of silence. Outbound
	 * publish helper - does NOT gate handler execution. For per-key handler
	 * gating use `ctx.skip(key, ms)`.
	 */
	publishDebounced(topic: string, event: string, data: any, ms: number): void;
	/**
	 * @deprecated Renamed to `publishThrottled`. The old name reads like a
	 * handler gate, but it is a publish helper. For per-key handler gating
	 * use `ctx.skip(key, ms)`. Kept as a soft-deprecated alias indefinitely;
	 * a one-time dev warning fires on first call.
	 */
	throttle(topic: string, event: string, data: any, ms: number): void;
	/**
	 * @deprecated Renamed to `publishDebounced`. The old name reads like a
	 * handler gate, but it is a publish helper. For per-key handler gating
	 * use `ctx.skip(key, ms)`. Kept as a soft-deprecated alias indefinitely;
	 * a one-time dev warning fires on first call.
	 */
	debounce(topic: string, event: string, data: any, ms: number): void;
	/** Send a point-to-point signal to a specific user. */
	signal(userId: string, event: string, data: any): void;
	/**
	 * Correlation id from the adapter platform. May be `undefined` for cron
	 * platforms that don't set one. See `LiveContext.requestId` for the
	 * RPC-handler shape.
	 */
	requestId: string | undefined;
}

/**
 * Context passed to every `live()` and `live.stream()` function.
 */
/**
 * A publisher scoped to a specific tenant - returned by `ctx.tenant(id)` (the
 * explicit cross-tenant escape) and exposed on the `live.tenant(id)` handle. The
 * topic is prefixed to the tenant's wire namespace exactly once.
 */
export interface TenantScope {
	/** The target tenant id. */
	tenantId: string;
	/** Publish into the target tenant's scope. Refuses `__`-prefixed topics. */
	publish(topic: string, event: string, data: any, options?: any): any;
}

/**
 * Server-side handle returned by `live.tenant(id, config)`. For use OUTSIDE a
 * request handler; inside one prefer `ctx.tenant(id)`.
 */
export interface TenantHandle {
	/** The validated tenant id. */
	id: string;
	/** The registered config object (quota / metrics / breaker), or `null`. */
	config: any;
	/** Publish into this tenant's scope using the active server platform. */
	publish(topic: string, event: string, data: any, options?: any): any;
}

export interface LiveContext<UserData = unknown> {
	/** User data attached during the WebSocket upgrade handshake. */
	user: UserData;
	/** The raw WebSocket connection. */
	ws: WebSocket<UserData>;
	/** The platform API (publish, send, topic helpers). */
	platform: Platform;
	/** Shorthand for `platform.publish` - delegates to whatever platform was passed in. */
	publish: Platform['publish'];
	/** Cursor value sent by the client for paginated stream requests. `null` if not paginated. */
	cursor: any;
	/**
	 * Publish a value to a topic at most once per `ms` milliseconds.
	 * The latest value always arrives (trailing edge). Outbound publish
	 * helper - does NOT gate handler execution. For per-key handler gating
	 * use `ctx.skip(key, ms)`.
	 */
	publishThrottled(topic: string, event: string, data: any, ms: number): void;
	/**
	 * Publish a value to a topic after `ms` milliseconds of silence. Outbound
	 * publish helper - does NOT gate handler execution. For per-key handler
	 * gating use `ctx.skip(key, ms)`.
	 */
	publishDebounced(topic: string, event: string, data: any, ms: number): void;
	/**
	 * @deprecated Renamed to `publishThrottled`. The old name reads like a
	 * handler gate, but it is a publish helper. For per-key handler gating
	 * use `ctx.skip(key, ms)`. Kept as a soft-deprecated alias indefinitely;
	 * a one-time dev warning fires on first call.
	 */
	throttle(topic: string, event: string, data: any, ms: number): void;
	/**
	 * @deprecated Renamed to `publishDebounced`. The old name reads like a
	 * handler gate, but it is a publish helper. For per-key handler gating
	 * use `ctx.skip(key, ms)`. Kept as a soft-deprecated alias indefinitely;
	 * a one-time dev warning fires on first call.
	 */
	debounce(topic: string, event: string, data: any, ms: number): void;
	/**
	 * Send a point-to-point signal to a specific user. Keyed by `userId` and NOT
	 * tenant-scoped (the client keys its `onSignal` store on the logical
	 * `__signal:<userId>` topic): under multi-tenancy use globally-unique user ids
	 * so signals stay isolated.
	 */
	signal(userId: string, event: string, data: any): void;
	/**
	 * The connection's server-trusted tenant id, or `null` when no tenant resolver
	 * is configured (`realtime({ tenant })`). When set, the framework auto-scopes
	 * every topic and key by it. Never read off the wire - resolved from the
	 * authenticated `user`.
	 */
	tenantId: string | null;
	/**
	 * A publisher scoped to ANOTHER tenant - the explicit cross-tenant escape for
	 * an admin / system handler that must publish into a different tenant. Validates
	 * the target id; refuses `__`-prefixed (framework-internal) topics.
	 */
	tenant(id: string): TenantScope;
	/**
	 * Per-key handler gate. Returns `true` to skip the call (key is within
	 * its cooldown window), `false` to run it (no entry, or window elapsed).
	 * Pair with an early `return` inside the handler body.
	 *
	 * State is per-replica - this is a CPU/DB shed, not a cluster-wide rate
	 * limit. For cross-replica gating use `live.rateLimit({ store: 'redis' })`
	 * or `redis/ratelimit` from svelte-adapter-uws-extensions.
	 *
	 * Throws `LiveError('INVALID_ARG', ...)` if `key` isn't a string or `ms`
	 * isn't a positive finite number. Capped at 5000 active entries with
	 * fail-open semantics on overflow (returns `false`, dev-warns once).
	 *
	 * @example
	 * ```js
	 * export const moveNote = live(async (ctx, noteId, x, y) => {
	 *   if (ctx.skip(`move:${noteId}`, 16)) return;  // drop calls within 16ms
	 *   await dbUpdateNote(noteId, x, y);
	 *   ctx.publish(TOPICS.notes, 'updated', { noteId, x, y });
	 * });
	 * ```
	 */
	skip(key: string, ms: number): boolean;
	/**
	 * Pressure-aware shed check. Returns `true` if a request of the given
	 * class of service should be shed under current `platform.pressure`.
	 *
	 * Returns `false` when admission has not been configured via
	 * `live.admission({...})`, or when no `platform.pressure` snapshot is
	 * available. Throws if `className` is not a registered class (typo defense).
	 *
	 * @example
	 * ```js
	 * export default live(async (ctx, input) => {
	 *   if (ctx.shed('background')) throw new LiveError('OVERLOADED', 'try again later');
	 *   return await heavyWork(input);
	 * });
	 * ```
	 */
	shed(className: string): boolean;
	/**
	 * Correlation id from the adapter platform. The adapter assigns one per
	 * WebSocket connection (stable across all events on that connection)
	 * and per HTTP request, honoring an inbound `X-Request-ID` header when
	 * present. Threaded through the adapter's hooks, the realtime layer's
	 * `ctx`, and (when used) downstream task-runner work via
	 * `svelte-adapter-uws-extensions/task-runner` - structured-log against
	 * it to correlate every step of one request without piping the value
	 * through your handler signatures.
	 *
	 * @example
	 * ```js
	 * export default live(async (ctx, input) => {
	 *   log.info({ requestId: ctx.requestId, userId: ctx.user?.id }, 'order received');
	 *   const order = await db.orders.create(input);
	 *   return order;
	 * });
	 * ```
	 *
	 * On platforms that don't set `requestId` (some test mocks, custom
	 * platform shims), this falls through as `undefined`. In production
	 * against `svelte-adapter-uws@^0.5.0-next.4` it's always a string.
	 */
	requestId: string | undefined;

	/**
	 * Current wall-clock time in epoch milliseconds, read through the
	 * injectable runtime clock the adapter platform exposes (falling back to
	 * the framework's own runtime clock on older adapters / mock platforms).
	 * Prefer this over `Date.now()` inside a handler/loader so a seeded
	 * simulation harness can replay time-dependent behavior exactly.
	 *
	 * @example
	 * ```js
	 * export default live((ctx) => ({ at: ctx.now() }));
	 * ```
	 */
	now: () => number;

	/**
	 * Randomness read through the injectable runtime RNG the adapter platform
	 * exposes (falling back to the framework's own runtime RNG on older
	 * adapters / mock platforms). Prefer this over `Math.random()` /
	 * `crypto.randomUUID()` inside a handler/loader so a seeded simulation
	 * harness can reproduce random-dependent output.
	 *
	 * @example
	 * ```js
	 * export default live((ctx) => ({ id: ctx.random.uuid() }));
	 * ```
	 */
	random: {
		/** Uniform float in [0, 1), like `Math.random()`. */
		float(): number;
		/** Unsigned 32-bit integer. */
		u32(): number;
		/** RFC 4122 v4 UUID string. */
		uuid(): string;
		/** `n` cryptographically-strong random bytes. */
		bytes(n: number): Uint8Array;
	};

	/**
	 * A hybrid logical clock stamp for events that must order consistently
	 * across workers (or across a coarse / briefly-backward wall clock).
	 *
	 * - `wall` is a non-decreasing wall-clock value in epoch milliseconds; it
	 *   never moves backward, so a same-millisecond or backward clock read
	 *   holds the previous value.
	 * - `logical` is a tiebreaker that resets to `0` whenever `wall` advances
	 *   and increments when two stamps share a millisecond, making the
	 *   `(wall, logical)` pair a strict per-process ordering.
	 * - `nodeId` is a short, stable per-process identity; in clustered mode it
	 *   is effectively the worker identity.
	 *
	 * Comes from the adapter platform's injectable runtime when present, so a
	 * seeded simulation harness can replay causally-ordered behavior exactly;
	 * older adapters and mock platforms fall back to the framework's own
	 * runtime-backed stamp of the same shape.
	 *
	 * @example
	 * ```js
	 * export default live((ctx) => ({ stamp: ctx.hlc() }));
	 * ```
	 */
	hlc: () => { wall: number; logical: number; nodeId: string };

	/**
	 * Lag-compensated evaluation against the room's recorded state history.
	 * Available inside the actions of a `live.room()` (or `live.multiplayer()`)
	 * that declares a `history` config; anywhere else it throws a
	 * `VALIDATION` `LiveError` with guidance.
	 *
	 * The eval function receives the snapshot recorded closest at-or-before
	 * `commandTime` (the client-stamped moment the player acted, passed as an
	 * ordinary action argument) plus a `meta` record: `time` (the snapshot's
	 * wall time), `age` (how far back the rewind reached, ms), and `fallback`
	 * (`true` when the requested rewind could not be served and current state
	 * was used instead - an empty ring, a command older than the history
	 * window, or a nested compensate call). A missing or non-finite
	 * `commandTime` evaluates against current state with `fallback: false`.
	 *
	 * Client-supplied times are trusted only inside the window the server
	 * itself recorded: a rewind can never reach past `history.maxAgeMs`, and
	 * anything unservable falls back to current state - never the oldest
	 * marker. The stamp is compared against the server's wall clock, so it
	 * must share the server's epoch within the window budget: derive it from
	 * a server-synced clock rather than a raw device clock when client
	 * clocks cannot be trusted to be NTP-accurate.
	 *
	 * The eval function is ordinary action code: publishes inside it are
	 * delivered immediately, exactly like publishes anywhere else in an
	 * action. The recommended pattern is evaluate first, publish from the
	 * result.
	 *
	 * @example
	 * ```js
	 * actions: {
	 *   async shoot(ctx, gameId, targetId, firedAt) {
	 *     const result = await ctx.compensate(firedAt, (state, meta) => {
	 *       const target = state.players[targetId];
	 *       return { hit: hitscan(state.players[ctx.user.id], target), rewoundMs: meta.age };
	 *     });
	 *     if (result.hit) ctx.publish('hit', { by: ctx.user.id, target: targetId });
	 *     return result;
	 *   }
	 * }
	 * ```
	 */
	compensate: <R>(
		commandTime: number | null | undefined,
		evalFn: (state: any, meta: CompensateMeta) => R | Promise<R>,
		options?: CompensateOptions
	) => Promise<R>;

	/**
	 * Arm the room's single pending alarm (live.alarm). Available only inside a
	 * `live.stream` (or `live.room`) declared with an `{ alarm: { onAlarm } }`
	 * config; calling it elsewhere throws. `at` is an absolute epoch-ms time. When
	 * it arrives the framework runs `onAlarm` with a fresh server ctx - even if
	 * every client has disconnected. Exactly one alarm per room: calling again
	 * replaces the pending one. A past `at` fires on the next tick.
	 *
	 * Durable across restart + cluster single-fire when a store + leader are wired
	 * via `configureAlarm`; in-memory (survives the room going idle within the
	 * process) otherwise.
	 *
	 * @example
	 * ```js
	 * // TTL-style cleanup: refresh on activity, fire if untouched for 30 days.
	 * ctx.setAlarm(Date.now() + 30 * 24 * 60 * 60 * 1000);
	 * ```
	 */
	setAlarm: (at: number) => void;

	/** The room's pending alarm time (epoch-ms), or `null` if none is set. */
	getAlarm: () => number | null;

	/** Cancel the room's pending alarm, if any. */
	deleteAlarm: () => void;
}

/**
 * Snapshot metadata handed to a `ctx.compensate()` eval function.
 */
export interface CompensateMeta {
	/** Wall time (epoch ms) of the snapshot the eval function received. */
	time: number;
	/** How far back the rewind reached, in milliseconds (`0` for current state). */
	age: number;
	/**
	 * `true` when a requested rewind could not be served and current state was
	 * evaluated instead (empty ring, command older than the history window, or
	 * a nested compensate call).
	 */
	fallback: boolean;
}

/**
 * Options for `ctx.compensate()`.
 */
export interface CompensateOptions {
	/**
	 * Skip the ring lookup when the command time is within this many
	 * milliseconds of now and evaluate a fresh capture of current state
	 * instead - fresh commands see fresh state. Semantic, not a perf knob:
	 * the fresh path still pays one capture.
	 * @default 0
	 */
	tolerance?: number;
}

/**
 * History config for `live.room()` / `live.multiplayer()`: a bounded,
 * per-topic ring of app-captured state snapshots backing `ctx.compensate()`.
 * The app owns what a snapshot contains; the framework owns the ring.
 */
export interface RoomHistoryConfig {
	/**
	 * Snapshot of the room's authoritative state, recorded after every
	 * successful action on the room. Receives only the room-identifying
	 * arguments - deliberately no ctx: a snapshot is served to EVERY room
	 * member's later evaluations, so it must be room-global, and an API that
	 * cannot see the acting user cannot accidentally record one user's
	 * private view into state another user will read. Return plain data
	 * (objects/arrays) synchronously - the framework freezes each snapshot
	 * (deeply in dev, so accidental mutation throws at the mutation site).
	 * Capture every field your evaluation (and any client prediction
	 * reconciliation) reads: position-only snapshots are sufficient for
	 * hitscan but not for replaying movement.
	 */
	capture: (...roomArgs: any[]) => any;
	/** Ring capacity in snapshots per room topic. @default 300 */
	maxEntries?: number;
	/**
	 * Rewind window in milliseconds: entries older than this are evicted and
	 * unreachable. Production game servers run 500-2000ms; longer windows
	 * widen the advantage a high-latency client gets against moving targets.
	 * @default 2000
	 */
	maxAgeMs?: number;
	/** Concurrently-tracked room topics; least-recently-used is evicted. @default 100 */
	maxTopics?: number;
}

/**
 * Options for `live.stream()`.
 */
export interface StreamAlarmConfig {
	/**
	 * Runs when a handler's `ctx.setAlarm(at)` reaches its scheduled time - with a
	 * fresh server ctx, even if every client has disconnected. `ctx.publish(event,
	 * data)` inside it publishes to this room; `ctx.setAlarm(...)` re-arms it.
	 */
	onAlarm: (ctx: LiveContext) => void | Promise<void>;
}

/**
 * Redaction mode for a single field in a {@link PiiRedactConfig}.
 *
 * - `omit` - delete the key.
 * - `mask` - replace the value with `'***'` regardless of type.
 * - `hash` - replace the value with a short stable HMAC-SHA256 pseudonym
 *   (join-without-identity for analytics); requires `hashSalt`.
 */
export type PiiRedactMode = 'omit' | 'mask' | 'hash';

/**
 * Declarative form of the `piiRedact` stream option.
 *
 * Field rules are matched by key NAME at ANY nesting depth. `defaults`
 * (default `true`) additionally strips the built-in sensitive-key set
 * (token/secret/password/auth/session/cookie/jwt/credential) via omit;
 * explicit `fields` entries always win over the default strip. `hashSalt` is
 * required when any field uses `'hash'` - it keys the pseudonym so it is
 * stable across restarts and cluster instances yet not reversible.
 */
export interface PiiRedactRules {
	fields?: Record<string, PiiRedactMode>;
	defaults?: boolean;
	hashSalt?: string;
}

/**
 * Configuration for the `piiRedact` stream option (uniform wire-egress
 * redaction). Either `true` (strip the default sensitive-key set), a custom
 * `(data) => projection` redactor, or declarative {@link PiiRedactRules}.
 */
export type PiiRedactConfig = true | ((data: any) => any) | PiiRedactRules;

export interface StreamOptions {
	/**
	 * Per-room alarm (live.alarm). When set, a handler can call `ctx.setAlarm(at)`
	 * to schedule a one-shot wake-up that runs `onAlarm` at time `at`, even if the
	 * room has gone idle. Exactly one pending alarm per room. Durable + cluster
	 * single-fire when a store + leader are wired via `configureAlarm`.
	 */
	alarm?: StreamAlarmConfig;

	/**
	 * Merge strategy for live updates.
	 * - `'crud'` - append/update/delete by key (default)
	 * - `'latest'` - ring buffer of last N events
	 * - `'set'` - replace entire value
	 * - `'presence'` - presence join/leave tracking by key
	 * - `'cursor'` - cursor position tracking by key
	 * @default 'crud'
	 */
	merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor';

	/**
	 * Key field for `crud` merge mode.
	 * @default 'id'
	 */
	key?: string;

	/**
	 * Prepend new items instead of appending (crud mode only).
	 * @default false
	 */
	prepend?: boolean;

	/**
	 * Maximum items to keep. When the buffer exceeds this size, the oldest
	 * items are dropped. Works with `crud` and `latest` merge strategies.
	 *
	 * For `latest`, defaults to 50. For `crud`, defaults to 0 (unlimited).
	 */
	max?: number;

	/**
	 * Enable seq-based replay for gap-free reconnection.
	 * Requires the replay extension from svelte-adapter-uws-extensions.
	 * @default false
	 */
	replay?: boolean | { size?: number };

	/**
	 * Called when a client subscribes to this stream.
	 * Receives the context and resolved topic string.
	 */
	onSubscribe?(ctx: LiveContext<any>, topic: string): void | Promise<void>;

	/**
	 * Called when a client disconnects from this stream. Fires for both
	 * static and dynamic topics.
	 *
	 * `remainingSubscribers` is the count of OTHER WebSockets still
	 * holding a realtime-stream subscription to this topic after the
	 * current one drops. Use it to tear down upstream resources when
	 * the last subscriber leaves:
	 *
	 * ```js
	 * live.stream(
	 *   (ctx, room) => `feed:${room}`,
	 *   loader,
	 *   {
	 *     onSubscribe: (ctx, topic) => startUpstream(topic),
	 *     onUnsubscribe: (ctx, topic, remaining) => {
	 *       if (remaining === 0) stopUpstream(topic);
	 *     }
	 *   }
	 * );
	 * ```
	 *
	 * The hook fires once per logical subscription on the dropping
	 * connection (mirroring the per-sub `onSubscribe` firings). Every
	 * firing for one drain sees the same `remainingSubscribers` value.
	 */
	onUnsubscribe?(ctx: LiveContext<any>, topic: string, remainingSubscribers: number): void | Promise<void>;

	/**
	 * Subscribe-time access predicate. Checked once when a client subscribes.
	 * Return `false` (or a `Promise` resolving to `false`) to deny the
	 * subscription with an "Access denied" error. The framework awaits the
	 * return before inspecting it, so async predicates that consult a DB
	 * or session store are safe. For per-event filtering, use `pipe.filter()`.
	 */
	filter?(ctx: LiveContext<any>): boolean | Promise<boolean>;

	/**
	 * Subscribe-time access predicate (alias for `filter`). Sync or async.
	 * Use `live.access` helpers to build predicates.
	 */
	access?(ctx: LiveContext<any>): boolean | Promise<boolean>;

	/**
	 * Schema version number. Increment when the data shape changes.
	 * Clients send their version on reconnect; the server applies migrations if behind.
	 */
	version?: number;

	/**
	 * Migration functions keyed by the version to migrate FROM.
	 * E.g., `{ 1: (item) => ({ ...item, newField: 'default' }) }` migrates v1 to v2.
	 */
	migrate?: Record<number, (item: any) => any>;

	/**
	 * Delta sync configuration for efficient reconnection. Two orthogonal modes:
	 *
	 * - **Schema-version delta** (`version` + `diff`): client sends its
	 *   `version`; server compares and sends only the items that changed
	 *   since that version. Useful when the data shape has a coarse
	 *   version stamp (e.g., a `last_modified_at` aggregate).
	 *
	 * - **Seq-based delta** (`fromSeq`): the user-provided bridge for the
	 *   middle tier of three-tier reconnect. When the bounded replay buffer
	 *   cannot satisfy the gap (clientSeq is older than the oldest entry),
	 *   the server calls `fromSeq(clientSeq)` to fetch missed events from
	 *   the durable store (e.g., Postgres). Resolution order:
	 *
	 *   1. Replay buffer (bounded, fast) - if `replay: true` is set.
	 *   2. `delta.fromSeq(clientSeq)` - this hook.
	 *   3. Full rehydrate via the loader (always safe).
	 *
	 *   Returning `null`/`undefined` falls through to rehydrate. Returning
	 *   `[]` means "nothing missed" (no-op for the client). Each event
	 *   should carry a `seq` field so the client's `_lastSeq` advances.
	 */
	delta?: {
		/** Return the current version/hash of the data. Must be fast. */
		version?(): any | Promise<any>;
		/** Return only the items that changed since `sinceVersion`. Return null to force full refetch. */
		diff?(sinceVersion: any): any[] | Promise<any[] | null> | null;
		/**
		 * Bridge tier for seq-based reconnect. Called when the replay buffer
		 * cannot satisfy a gap. Returns the events the client missed, or
		 * `null`/`undefined` to fall through to full rehydrate.
		 *
		 * @example
		 * ```js
		 * delta: {
		 *   fromSeq: async (sinceSeq) => db.audit
		 *     .where('seq', '>', sinceSeq)
		 *     .orderBy('seq', 'asc')
		 *     .get()
		 * }
		 * ```
		 */
		fromSeq?(sinceSeq: number): any[] | null | undefined | Promise<any[] | null | undefined>;
	};

	/**
	 * Schema validating the stream's arguments. Runs at subscribe time
	 * BEFORE topic resolution - prevents topic injection via malformed
	 * dynamic-topic args. Accepts any Standard Schema-compatible schema
	 * (https://standardschema.dev/), Zod, ArkType, Valibot v1+, etc.
	 *
	 * Schema validates the WHOLE args tuple (use `z.tuple([...])` or the
	 * equivalent in your schema library). Validated/coerced args reach
	 * the topic function and the loader.
	 *
	 * Validation failures reject the subscribe with code `VALIDATION` and
	 * a populated `issues` array, matching the `live.validated()` shape.
	 *
	 * @example
	 * ```js
	 * import { z } from 'zod';
	 * export const auditFeed = live.stream(
	 *   (ctx, orgId) => `audit:${orgId}`,
	 *   async (ctx, orgId) => loadFeed(orgId),
	 *   { args: z.tuple([z.string().uuid()]) }
	 * );
	 * ```
	 */
	args?: any;

	/**
	 * Class of service for pressure-aware shedding. Names a class registered
	 * via `live.admission({ classes })`. When the adapter reports pressure
	 * matching the class's rule, new subscribes to this stream are rejected
	 * with `OVERLOADED`. Existing subscribers are unaffected.
	 *
	 * @example
	 * ```js
	 * export const browseList = live.stream('browse:list', loader, {
	 *   merge: 'crud',
	 *   classOfService: 'background'   // shed first under any pressure
	 * });
	 * ```
	 */
	classOfService?: string;

	/**
	 * Server-side projection applied to BOTH the initial loader result
	 * AND every subsequent live publish for this stream's topic. Lets
	 * you ship a wide row from the database and emit a narrow shape on
	 * the wire (typically 80-90% payload reduction on data-heavy streams).
	 *
	 * Applied per-item for array data (covers `crud`, `latest`,
	 * `presence`, `cursor` merges) and to the whole value for non-array
	 * data (covers `set` merge). Paginated loader responses
	 * (`{ data, hasMore, cursor }`) transform `.data` only.
	 *
	 * Must be synchronous. Runs before `coalesceBy` reads the wire data
	 * (note: `coalesceBy` itself reads the ORIGINAL pre-transform data,
	 * so the key extractor sees the un-projected fields it was written
	 * against).
	 *
	 * @example
	 * ```js
	 * export const auditFeed = live.stream(
	 *   (ctx, orgId) => `audit:${orgId}`,
	 *   async (ctx, orgId) => db.auditRows.recent(orgId, 50),
	 *   {
	 *     merge: 'crud', key: 'id',
	 *     transform: (row) => ({
	 *       id: row.record_id,
	 *       op: row.operation,
	 *       at: row.changed_at
	 *     })
	 *   }
	 * );
	 * ```
	 */
	transform?(data: any): any;

	/**
	 * PII / sensitive-field redaction applied to this stream's wire egress,
	 * UNIFORMLY for every subscriber. Redaction runs immediately AFTER
	 * `transform` and BEFORE the data reaches the replay buffer or the
	 * fan-out, so raw PII never rests in the replay store and resume/gap-fill
	 * cannot leak it. It applies on every egress path: the initial load, live
	 * publishes, server-pushed reloads (stale / invalidation), and replay.
	 *
	 * For per-audience differences (admins see a field, members do not),
	 * compose with `guard` + separate streams - redaction here is uniform by
	 * design, which is what preserves native fan-out and the redact-before-
	 * buffer guarantee.
	 *
	 * Fail-closed: a throwing redactor drops the publish (or nulls the initial
	 * data) rather than broadcasting un-redacted fields. Field rules match by
	 * key NAME at any nesting depth.
	 *
	 * - `true` - strip the default sensitive-key set
	 *   (token/secret/password/auth/session/cookie/jwt/credential), omit mode.
	 * - `(data) => projection` - a custom redactor (use for scalar payloads).
	 * - `{ fields, defaults?, hashSalt? }` - declarative per-field modes.
	 *
	 * @example
	 * ```js
	 * live.stream(topic, loader, {
	 *   piiRedact: { fields: { email: 'mask', ssn: 'omit', userId: 'hash' }, hashSalt: env.PII_SALT }
	 * });
	 * ```
	 */
	piiRedact?: PiiRedactConfig;

	/**
	 * Coalesce-key extractor for publishes to this stream's topic.
	 *
	 * When set, every `ctx.publish(topic, event, data)` for this topic fans
	 * out via the adapter's per-socket `sendCoalesced` instead of broadcasting
	 * via `publish`. Each subscriber holds at most one pending message per
	 * `(topic, coalesceBy(data))` key: if a newer publish for the same key
	 * arrives before the previous frame drains to the wire, the older value
	 * is dropped in place. Latest value wins.
	 *
	 * Use for high-frequency latest-value streams (auction prices, cursor
	 * positions, presence state, scrub positions). For at-least-once delivery
	 * leave this option unset.
	 *
	 * The extractor must be synchronous and total (no throws on valid data).
	 * Returning `null` or `undefined` collapses to a single per-topic key.
	 *
	 * Subscribers tracked via the standard stream subscribe path are
	 * fanned-out automatically. Manual `ws.subscribe()` to a coalescing
	 * topic is unsupported.
	 *
	 * @example
	 * ```js
	 * export const auctionPrice = live.stream(
	 *   (ctx, auctionId) => `auction:${auctionId}`,
	 *   async (ctx, auctionId) => loadCurrentPrice(auctionId),
	 *   { merge: 'set', coalesceBy: (data) => data.auctionId }
	 * );
	 * ```
	 */
	coalesceBy?(data: any): string | number | null | undefined;

	/**
	 * Mark this stream as volatile - intentionally fire-and-forget. Wire-level
	 * "drop on backpressure" is the adapter's default behavior (uWS skips any
	 * subscriber whose outbound buffer is over `maxBackpressure`, default
	 * 64 KB), so volatile is mostly an intent declaration. The realtime side
	 * uses it to disable per-event seq stamping for this topic, which means
	 * a reconnect carrying `lastSeenSeq` won't try to backfill the gaps. That
	 * is correct for typing indicators, cursor positions, telemetry pings,
	 * and other streams where a missed frame is simply gone.
	 *
	 * Cannot combine with `coalesceBy` (latest-value-wins requires a queue;
	 * volatile drops on backpressure - the two are different intents).
	 * Cannot combine with `replay` (volatile messages aren't buffered for
	 * resume).
	 *
	 * @example
	 * ```js
	 * export const cursors = live.stream(
	 *   (ctx, roomId) => `room:${roomId}:cursors`,
	 *   loader,
	 *   { merge: 'cursor', volatile: true }
	 * );
	 * ```
	 */
	volatile?: boolean;

	/**
	 * Per-topic staleness watchdog. If the topic is silent (no
	 * `ctx.publish` to it) for `staleAfterMs`, the realtime layer
	 * re-runs this stream's loader and broadcasts the result as a
	 * `refreshed` event. The client merges `refreshed` as a full-state
	 * replacement across every merge strategy.
	 *
	 * Watchdog state is per-topic, not per-subscriber. Multiple
	 * subscribers to the same topic share one timer; the timer arms on
	 * the first subscribe for the topic and clears when the last
	 * subscriber leaves. The reload uses the first subscriber's `ctx`
	 * and `args`, which is correct for shared topics (the loader's
	 * output is identical regardless of which subscriber's ctx triggers
	 * it).
	 *
	 * Every publish to the topic resets the watchdog - a publish is
	 * proof the topic is live. If the reload's loader throws, `onError`
	 * fires (if configured) and the watchdog re-arms; transient
	 * failures don't leave the topic permanently stale.
	 *
	 * Useful for streams whose underlying source can quietly stop
	 * emitting (a CDC connection drops, a polling loop stalls, an
	 * upstream cache evicts the key). Pairs naturally with `onError`
	 * for observability into the reload itself.
	 *
	 * Must be a positive finite number of milliseconds.
	 *
	 * @example
	 * ```js
	 * export const auditFeed = live.stream(
	 *   (ctx, orgId) => `audit:${orgId}`,
	 *   async (ctx, orgId) => loadAudit(orgId),
	 *   {
	 *     merge: 'crud',
	 *     key: 'id',
	 *     staleAfterMs: 30_000,
	 *     onError: (err, ctx, topic) => log.warn({ err, topic }, 'audit reload failed')
	 *   }
	 * );
	 * ```
	 */
	staleAfterMs?: number;

	/**
	 * Topic pattern(s) that invalidate this stream's cached load. When a
	 * `ctx.publish` (or any broadcast) hits a matching topic, the loader is
	 * re-run and a `refreshed` event is broadcast to subscribers. A single
	 * glob-style pattern, or an array of them.
	 */
	invalidateOn?: string | string[];

	/**
	 * Per-stream error observer. Called when the loader throws, on
	 * either the initial subscribe path, the staleness-driven reload
	 * (if `staleAfterMs` is configured), or the `.load()` SSR path.
	 * Receives the thrown error, the `ctx` available at the call site,
	 * and the resolved topic string when available.
	 *
	 * Observer-only: errors thrown inside `onError` are silently
	 * swallowed so a buggy logger never breaks the original error path.
	 * The original error continues to propagate to the caller (or, on
	 * stale-reload, drives the timer re-arm). Sibling to the global
	 * `onError` setter - per-stream observers fire alongside the
	 * global one, not instead of it.
	 *
	 * Apps that want a topic-scoped degraded signal can `ctx.publish`
	 * a `__system:<topic>` event from inside the handler:
	 *
	 * ```js
	 * onError: (err, ctx, topic) => {
	 *   ctx.publish(`__system:${topic}`, 'degraded', { reason: err.message });
	 * }
	 * ```
	 *
	 * Existing 2-argument `(err, ctx) => void` handlers continue to
	 * work; the `topic` arg is silently ignored.
	 */
	onError?(err: unknown, ctx: LiveContext<any>, topic?: string): void | Promise<void>;
}

/**
 * Options for `handleRpc()`.
 */
export interface HandleRpcOptions {
	/**
	 * Optional async hook that runs after the guard but before the live function.
	 * Throw `LiveError` to reject the call.
	 * Use for rate limiting, logging, metrics.
	 */
	beforeExecute?(ws: WebSocket<any>, rpcPath: string, args: any[]): Promise<void> | void;

	/**
	 * Called when an RPC handler throws a non-LiveError.
	 * Use for error reporting (Sentry, logging, etc.).
	 */
	onError?(path: string, error: unknown, ctx: LiveContext<any>): void;

	/**
	 * Maximum nesting depth allowed in an inbound RPC envelope. Envelopes
	 * whose parsed JSON has any descendant deeper than this are dropped at
	 * ingress (the same path as malformed JSON). Defense in depth against
	 * downstream handlers / instrumentation that recursively walk the
	 * parsed object and would stack-overflow on pathological depth.
	 *
	 * The adapter's `maxPayloadLength` (default 1 MB) is the primary cap
	 * - it bounds the bytes `JSON.parse` ever sees. This is a second
	 * line of defense for the post-parse shape.
	 *
	 * @default 64
	 */
	maxEnvelopeDepth?: number;
}

/**
 * Options for `createMessage()`.
 */
export interface CreateMessageOptions {
	/**
	 * Transform the platform before passing to `handleRpc`.
	 * Use for wrapping with Redis pub/sub bus.
	 *
	 * @example
	 * ```js
	 * createMessage({ platform: (p) => bus.wrap(p) })
	 * ```
	 */
	platform?(platform: Platform): Platform;

	/**
	 * Optional async hook that runs before each RPC call.
	 * Throw `LiveError` to reject.
	 */
	beforeExecute?(ws: WebSocket<any>, rpcPath: string, args: any[]): Promise<void> | void;

	/**
	 * Called when an RPC handler throws a non-LiveError.
	 * Use for error reporting (Sentry, logging, etc.).
	 */
	onError?(path: string, error: unknown, ctx: LiveContext<any>): void;

	/**
	 * Called when a non-RPC text frame parses as a JSON object envelope.
	 * The framework runs `TextDecoder + JSON.parse` once (or, when the
	 * adapter already parsed the frame for its own control-message routing,
	 * uses the adapter-forwarded value directly - one parse total), and
	 * hands the parsed value to this callback.
	 *
	 * Dispatch by `msg.type` inside the callback. Plugin-layer hooks
	 * (`cursor.hooks.message`, future presence/typing) consume the parsed
	 * value so user wiring doesn't re-parse on every frame.
	 *
	 * Frames that don't look like a JSON object (first byte not `{`),
	 * fail to parse, or sit at nesting depth greater than `maxJsonDepth`,
	 * fall through to `onUnhandled` with the original raw bytes.
	 *
	 * The adapter's `websocket.maxPayloadLength` already bounds the bytes
	 * `JSON.parse` ever sees, so there's no separate size cap here.
	 *
	 * @example
	 * ```js
	 * createMessage({
	 *   onJsonMessage(ws, msg, platform) {
	 *     if (msg.type === 'cursor') cursor.hooks.message(ws, { data: msg, platform });
	 *     else if (msg.type === 'presence-snapshot') presence.hooks.message(ws, { data: msg, platform });
	 *   }
	 * })
	 * ```
	 */
	onJsonMessage?(ws: WebSocket<any>, msg: any, platform: Platform): void;

	/**
	 * Maximum nesting depth allowed in a parsed `onJsonMessage` envelope.
	 * Frames deeper than this fall through to `onUnhandled` unparsed.
	 * Mirrors `handleRpc`'s `maxEnvelopeDepth` semantics; same default.
	 *
	 * @default 64
	 */
	maxJsonDepth?: number;

	/**
	 * Called when a message is not an RPC request and either no
	 * `onJsonMessage` is set, or the frame is binary / non-JSON / parses
	 * to a non-object / exceeds `maxJsonDepth`.
	 * Use for mixing RPC with custom message handling.
	 */
	onUnhandled?(ws: WebSocket<any>, data: ArrayBuffer, platform: Platform): void;
}

/**
 * Shape accepted by `live.metrics()`. Any object matching this contract works
 * (hand-rolled, prom-client adapter, or the `createMetrics()` registry from
 * `svelte-adapter-uws-extensions/prometheus` wrapped to forward options as
 * positional args - see the README "Prometheus metrics" section).
 */
export interface MetricsRegistry {
	counter(opts: { name: string; help: string; labelNames?: string[] }): {
		inc(labels?: Record<string, string | number>): void;
	};
	histogram(opts: { name: string; help: string; labelNames?: string[]; buckets?: number[] }): {
		observe(labels: Record<string, string | number>, valueSeconds: number): void;
	};
	gauge(opts: { name: string; help: string; labelNames?: string[] }): {
		inc(): void;
		dec(): void;
	};
}

/**
 * Mark a function as RPC-callable over WebSocket.
 *
 * The first argument is always `ctx: LiveContext`. Additional arguments
 * come from the client call.
 *
 * @example
 * ```js
 * export const sendMessage = live(async (ctx, text) => {
 *   const msg = await db.messages.insert({ userId: ctx.user.id, text });
 *   ctx.publish('messages', 'created', msg);
 *   return msg;
 * });
 * ```
 */
export function live<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(fn: T): T;

/**
 * The shape of a single entry on a `defineTopics` map: either a static
 * string or a function returning a string from one or more args.
 */
/**
 * Privacy configuration for `live.aggregate({ privacy })` - k-anonymity
 * suppression and differential-privacy noise on the published aggregate.
 */
export interface AggregatePrivacyConfig {
	/** k-anonymity threshold: minimum distinct contributors before the aggregate publishes. Default 5. */
	k?: number;
	/** Differential-privacy budget; smaller epsilon = more noise = more privacy. Default 1.0. */
	epsilon?: number;
	/** Failure probability for the Gaussian mechanism. Default 1e-5. */
	delta?: number;
	/** L1 (Laplace) / L2 (Gaussian) sensitivity of the aggregate. Default 1. */
	sensitivity?: number;
	/** Noise distribution. Default 'laplace'. */
	noise?: 'laplace' | 'gaussian';
	/**
	 * 'suppress' = k-anonymity only; 'perturb' = noise only; 'hybrid' = both.
	 * Default 'hybrid'. 'suppress' and 'hybrid' require `contributor`.
	 */
	strategy?: 'suppress' | 'perturb' | 'hybrid';
	/**
	 * Extracts the contributor identity from each source event, used to count
	 * the k-anonymity cohort. Required for 'suppress' / 'hybrid'.
	 */
	contributor?(data: any): string | number;
	/** Restrict noise to these numeric field names (default: all numeric fields). */
	fields?: string[];
}

/**
 * Time-window specification for `live.aggregate({ windows })`. Three
 * discriminated variants, matching the three semantic models the
 * primitive supports.
 */
export type WindowSpec =
	| {
		type: 'lifetime';
		/** Per-window debounce override (defaults to the aggregate's top-level `debounce`). */
		debounce?: number;
	}
	| {
		type: 'tumbling';
		/** Boundary-anchored period. Resets at the configured `tz`'s natural boundary. */
		period: 'minute' | 'hour' | 'daily' | 'monthly';
		/** IANA time zone for boundary calculation. Default 'UTC'. */
		tz?: string;
		debounce?: number;
	}
	| {
		type: 'tumbling';
		/** Fixed-duration tumbling. Resets every `durationMs` from `anchor`. */
		durationMs: number;
		/** Epoch-ms anchor for boundary alignment. Default 0 (UTC epoch). */
		anchor?: number;
		debounce?: number;
	}
	| {
		type: 'sliding';
		/** Total window duration in milliseconds. */
		durationMs: number;
		/** Hop interval in milliseconds. Bucket count = ceil(durationMs / slideMs). */
		slideMs: number;
		debounce?: number;
	};

/**
 * Cluster-wide leader gate consumer signature for `live.aggregate`
 * (reserved for a future `configureAggregate({ leader })` symmetric to
 * `configureCron`). Exported for forward-compat type stability.
 */
export type AggregateLeader = () => boolean;

/**
 * Built-in `combine(...buckets)` helpers for sliding-window reducers.
 * Pass any of these as `combine` on a reducer to recombine per-bucket
 * state across hop boundaries. Hand-roll your own for non-trivial
 * reducer shapes (top-K, percentile sketches, etc.).
 *
 * @example
 * ```js
 * import { combineCounts } from 'svelte-realtime/server';
 *
 * counts: {
 *   init: () => ({}),
 *   reduce: (acc, event, data) => ({ ...acc, [data.id]: (acc[data.id] ?? 0) + 1 }),
 *   combine: combineCounts
 * }
 * ```
 */
export const combineSum: (...buckets: number[]) => number;
export const combineMax: (...buckets: number[]) => number;
export const combineMin: (...buckets: number[]) => number;
export const combineCounts: (...buckets: Array<Record<string, number> | undefined>) => Record<string, number>;
export const combineMerge: <T extends object>(...buckets: Array<T | undefined>) => T;

/**
 * Deterministic `hsl(...)` color for a stable user key. The same key yields
 * the same color on the server and on every client, so server-rendered markup
 * and the first client paint agree without a hydration mismatch.
 */
export function colorForKey(key: string): string;
/** Raw deterministic hue (0..359) for a stable user key. */
export function hueForKey(key: string): number;

/**
 * Maximum number of hop buckets a single sliding window may allocate.
 * Sliding state is `O(bucketCount * per-bucket state)`. Default 1000;
 * override via test setup.
 */
export const MAX_AGGREGATE_BUCKETS: number;

/**
 * Maximum entries in the per-userId connection registry that backs
 * `live.push({ userId })` / `live.notify`. Saturation behaviour is
 * WARN-once and skip new registrations; existing entries continue to
 * route. Default 10,000,000.
 */
export const MAX_PUSH_REGISTRY: number;

/**
 * Maximum entries in the in-memory presence-ref map that backs
 * `live.room({ presence })` on the single-instance / dev path. When
 * `platform.presence.list` is wired (e.g. via the Redis presence
 * extension), this cap is bypassed. Saturation behaviour is WARN-once
 * and skip new entries. Default 1,000,000.
 */
export const MAX_PRESENCE_REF: number;

export type TopicEntry = string | ((...args: any[]) => string);

/**
 * The map type accepted by `defineTopics` - a record of name -> entry.
 */
export type TopicMap = Record<string, TopicEntry>;

/**
 * The map returned by `defineTopics` - the input map plus two
 * non-enumerable metadata properties used by tooling and docs.
 */
export type DefinedTopics<M extends TopicMap> = M & {
	readonly __patterns: Record<keyof M, string>;
	readonly __definedTopics: true;
};

/**
 * Centralize topic patterns so stream definitions and any out-of-band
 * consumers (SQL triggers, NOTIFY shapes, doc generators, devtools)
 * reference one source of truth. Each entry is either a string (a
 * static topic) or a function returning a string from one or more
 * args (a dynamic topic).
 *
 * The returned object exposes the same entries the input did, plus
 * `__patterns` (a map of `name -> pattern string` derived by calling
 * each function with sentinel placeholders matching its arity) and
 * `__definedTopics: true` (a runtime marker for tooling).
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
 * // Stream definition uses the same source of truth:
 * import { TOPICS } from '$lib/topics';
 * export const auditFeed = live.stream(
 *   (ctx, orgId) => TOPICS.audit(orgId),
 *   loadAudit
 * );
 *
 * // Documentation / SQL comment generation:
 * TOPICS.__patterns
 * // => { audit: 'audit:{arg0}', security: 'security:{arg0}',
 * //      feed: 'feed:{arg0}:{arg1}', systemNotices: 'system:notices' }
 * ```
 */
export function defineTopics<M extends TopicMap>(map: M): DefinedTopics<M>;

/**
 * Hook functions to wire from `hooks.ws.js` so `live.push({ userId })` can
 * route to the right WebSocket. `open` registers the connection; `close`
 * deregisters it.
 *
 * Compose with other hooks by calling `pushHooks.open(ws, ctx)` /
 * `pushHooks.close(ws)` from within your own handlers.
 *
 * @example
 * ```js
 * // hooks.ws.js
 * import { pushHooks } from 'svelte-realtime/server';
 *
 * export const open = pushHooks.open;
 * export const close = pushHooks.close;
 * ```
 */
export const pushHooks: {
	/**
	 * Register the connection in the push registries. A connection with no
	 * userId (identify(ws) -> null/undefined) is skipped for userId routing but
	 * may still register a sessionId (sessionIdentify(ws)), and vice versa - the
	 * two registries are independent.
	 */
	open(ws: any, ctx: { platform: any }): void;
	/**
	 * Adapter close hook. Drains the per-userId AND per-sessionId push registries
	 * AND the realtime stream-subscription bookkeeping (ws-counts, silent-topic
	 * watchdogs, `__onUnsubscribe` callbacks) when the adapter passes a `ctx` - a
	 * single `export const close = pushHooks.close` covers all of them with no
	 * separate wiring needed. Falls back to push-only behavior when called
	 * directly without `ctx` (test setups, custom flows). Looks up each id via its
	 * reverse index so it works even when `getUserData` has been cleared. Only
	 * removes a registry entry if this exact ws is still the registered one
	 * (handles fast device-swap / resume sequences correctly).
	 */
	close(ws: any, ctx?: { platform: any; subscriptions?: Set<string> | string[] }): void;
};

/**
 * Options for `live.upload()`.
 */
export interface UploadOptions {
	/**
	 * Hard cap on total bytes per upload. Bytes received past this point
	 * abort the upload with `LiveError('PAYLOAD_TOO_LARGE')`.
	 * @default 104857600 (100 MB)
	 */
	maxSize?: number;

	/**
	 * Maximum concurrent uploads per WebSocket connection. Excess upload
	 * starts reject with `LiveError('OVERLOADED')`.
	 * @default 4
	 */
	maxConcurrentPerSession?: number;

	/**
	 * Global cap on concurrent uploads across the worker. Default unset
	 * (unbounded); set a value to enable capacity protection at the
	 * worker scope.
	 */
	maxConcurrentTotal?: number;

	/**
	 * Backpressure cap. Chunks queued ahead of the handler's draining
	 * are bounded to this count; overflow aborts with
	 * `LiveError('FLOW_BACKPRESSURE')`.
	 * @default 64
	 */
	maxBufferedChunks?: number;

	/**
	 * Re-run the module guard against the live `ctx` every N bytes
	 * received past the last re-auth. On rejection the upload aborts
	 * with the guard's error code (`UNAUTHENTICATED` / `FORBIDDEN`)
	 * and the consumer observes `ctx.signal.aborted`.
	 *
	 * Default unset: the guard runs once at chunk-0 only. Pass a byte
	 * threshold (e.g. `5 * 1024 * 1024`) for long uploads where the
	 * user's session can be revoked mid-stream. Reauth runs as a fire-
	 * and-forget task off the chunk-receive path; concurrent reauths on
	 * the same upload are coalesced.
	 */
	reauthEvery?: number;
}

/**
 * Context passed to `live.upload()` handlers. Extends `LiveContext` with
 * three streaming-only fields.
 */
export interface UploadContext<UserData = unknown> extends LiveContext<UserData> {
	/** Async iterable yielding `Uint8Array` chunks in arrival order. */
	stream: AsyncIterable<Uint8Array>;
	/**
	 * Aborts on client cancel, WS disconnect, `maxSize` exceeded,
	 * `maxBufferedChunks` overflow, or a `reauthEvery` rejection.
	 */
	signal: AbortSignal;
	/** 8-char hex id matching the client-side `UploadHandle.streamIdHex`. */
	upload: { id: string };
}

export namespace live {
	/**
	 * Mark a function as a stream provider with a static topic.
	 *
	 * @param topic - Pub/sub topic name
	 * @param initFn - Function that returns the initial data
	 * @param options - Merge strategy and options
	 *
	 * @example
	 * ```js
	 * export const messages = live.stream('messages', async (ctx) => {
	 *   return db.messages.latest(50);
	 * }, { merge: 'crud', key: 'id', prepend: true });
	 * ```
	 */
	function stream<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(
		topic: string,
		initFn: T,
		options?: StreamOptions
	): T;

	/**
	 * Mark a function as a stream provider with a dynamic topic.
	 *
	 * The topic function receives the same context and arguments as the init function,
	 * enabling per-entity streams (e.g., per-room, per-user).
	 *
	 * @param topicFn - Function that computes the topic from context and arguments
	 * @param initFn - Function that returns the initial data
	 * @param options - Merge strategy and options
	 *
	 * @example
	 * ```js
	 * export const roomMessages = live.stream(
	 *   (ctx, roomId) => 'chat:' + roomId,
	 *   async (ctx, roomId) => db.messages.forRoom(roomId),
	 *   { merge: 'crud', key: 'id' }
	 * );
	 * ```
	 */
	function stream<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(
		topicFn: (ctx: LiveContext<any>, ...args: any[]) => string,
		initFn: T,
		options?: StreamOptions
	): T;

	/**
	 * Create an ephemeral pub/sub channel with no database initialization.
	 * Channels have no initFn - clients subscribe and receive live events immediately.
	 *
	 * @param topic - Static topic string
	 * @param options - Merge strategy and options
	 *
	 * @example
	 * ```js
	 * export const typing = live.channel('typing:lobby', { merge: 'presence' });
	 * ```
	 */
	function channel(
		topic: string,
		options?: { merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor'; key?: string; max?: number }
	): Function;

	/**
	 * Create an ephemeral pub/sub channel with a dynamic topic.
	 *
	 * @param topicFn - Function that computes the topic
	 * @param options - Merge strategy and options
	 *
	 * @example
	 * ```js
	 * export const cursors = live.channel(
	 *   (ctx, docId) => 'cursors:' + docId,
	 *   { merge: 'cursor' }
	 * );
	 * ```
	 */
	function channel(
		topicFn: (ctx: LiveContext<any>, ...args: any[]) => string,
		options?: { merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor'; key?: string; max?: number }
	): Function;

	/**
	 * Mark a function as a binary RPC handler.
	 * The handler receives `(ctx, buffer, ...jsonArgs)` where buffer is the raw ArrayBuffer.
	 *
	 * @param fn - Handler function (ctx, buffer, ...jsonArgs)
	 *
	 * @example
	 * ```js
	 * export const uploadAvatar = live.binary(async (ctx, buffer, filename) => {
	 *   await storage.put(filename, buffer);
	 *   return { url: `/avatars/${filename}` };
	 * });
	 * ```
	 */
	function binary<T extends (ctx: LiveContext<any>, buffer: ArrayBuffer, ...args: any[]) => any>(
		fn: T
	): T;

	/**
	 * Mark a function as a streaming upload handler.
	 *
	 * The handler consumes `ctx.stream` (an async iterable of `Uint8Array`
	 * chunks), can react to `ctx.signal` for cancel / disconnect / cap-
	 * exceeded events, and returns a JSON-serialisable result when done.
	 * The Vite plugin generates a client stub returning `UploadHandle<T>`
	 * (see `svelte-realtime/client`).
	 *
	 * Use `live.upload` over `live.binary` when:
	 * - the file or payload is multi-megabyte
	 * - you want progress / cancellation
	 * - you need bounded server memory rather than "buffer the whole
	 *   thing then call the handler"
	 *
	 * Errors thrown from the handler propagate to the client as
	 * `RpcError`. Throw `LiveError(code, message)` for typed codes;
	 * `ctx.publish('__*', ...)` from a handler throws
	 * `LiveError('INVALID_TOPIC')` because `__`-prefixed topics are
	 * reserved for framework-internal channels (use `ctx.platform.publish`
	 * directly if a handler genuinely needs to broadcast on one).
	 *
	 * @param fn - Handler function. Receives an `UploadContext` plus
	 *             positional args forwarded from the client call.
	 * @param options - Optional caps and re-auth controls.
	 *
	 * @example
	 * ```js
	 * export const avatar = live.upload(async (ctx, name, mime) => {
	 *   if (!ctx.user) throw new LiveError('UNAUTHENTICATED');
	 *   for await (const chunk of ctx.stream) {
	 *     ctx.signal.throwIfAborted();
	 *     await sink.write(chunk);
	 *   }
	 *   return { url: `/uploads/${name}` };
	 * }, {
	 *   maxSize: 50 * 1024 * 1024,
	 *   reauthEvery: 5 * 1024 * 1024
	 * });
	 * ```
	 */
	function upload<T extends (ctx: UploadContext<any>, ...args: any[]) => any>(
		fn: T,
		options?: UploadOptions
	): T;

	/**
	 * Register a global middleware that runs before per-module guards for every RPC/stream call.
	 * Middleware receives `(ctx, next)` - call `next()` to continue the chain.
	 * Throw a LiveError to reject the call.
	 *
	 * @param fn - Middleware function
	 *
	 * @example
	 * ```js
	 * live.middleware(async (ctx, next) => {
	 *   const start = Date.now();
	 *   const result = await next();
	 *   console.log(`RPC took ${Date.now() - start}ms`);
	 *   return result;
	 * });
	 * ```
	 */
	function middleware(fn: (ctx: LiveContext<any>, next: () => Promise<any>) => Promise<any>): void;

	/**
	 * Mark a handler as fire-and-forget (volatile). The server still runs
	 * the full middleware / guard / rate-limit / validation chain, but does
	 * NOT write a response frame back. The matching client surface is
	 * `rpc.fireAndForget(...args)`, which sends a no-id wire frame and
	 * returns void synchronously.
	 *
	 * Use for high-frequency one-way RPCs where the caller has no reply
	 * to await: cursor moves, drag updates, typing indicators, telemetry
	 * beacons, heartbeats.
	 *
	 * Errors on a volatile call still run through the handler's error
	 * path (metrics, server logs) but are not transmitted - per the
	 * fire-and-forget contract.
	 *
	 * @param fn - Handler function (ctx, ...args)
	 *
	 * @example
	 * ```js
	 * export const moveCursor = live.volatile(async (ctx, boardId, pos) => {
	 *   cursor.update(ctx.ws, `board:${boardId}`, pos, ctx.platform);
	 * });
	 *
	 * // Client:
	 * moveCursor.fireAndForget('board-1', { x: 100, y: 200 });
	 * ```
	 */
	function volatile<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(fn: T): T;

	/**
	 * Mark a live function (RPC, stream, or channel) as deprecated. Additive -
	 * wrap any registered handler and the marker composes with its other markers.
	 * The server sends a one-shot `deprecation` signal on the first response to
	 * each connection for the deprecated path; the client surfaces it as a single
	 * dev-mode console warning (no per-call overhead, no production cost).
	 *
	 * @param fn - the handler to mark (any live function)
	 * @param options - `message` (why/what changed), `since` (version deprecated
	 *   in), `use` (replacement path to point callers at), `removeBy` (when it
	 *   will be removed); all optional free-form strings.
	 *
	 * @example
	 * ```js
	 * export const legacyFeed = live.deprecate(
	 *   live.stream('legacy-feed', async (ctx) => loadFeed(ctx)),
	 *   { since: '0.6', use: 'feed', removeBy: '0.7' }
	 * );
	 * ```
	 */
	function deprecate<T extends Function>(
		fn: T,
		options?: { message?: string; since?: string; use?: string; removeBy?: string }
	): T;

	/**
	 * Wrap a stream with a server-side gate predicate.
	 * If the predicate returns false (or a `Promise` resolving to false),
	 * the client receives a graceful no-op (`{ data: null, gated: true }`)
	 * instead of an error.
	 *
	 * @param predicate - Function checked before subscribing. Sync or async;
	 *                    the framework awaits the return.
	 * @param fn - The stream function to gate
	 *
	 * @example
	 * ```js
	 * export const betaFeed = live.gate(
	 *   async (ctx) => (await getFlags(ctx.user))?.includes('beta'),
	 *   live.stream('beta-feed', async (ctx) => db.betaFeed.latest(50))
	 * );
	 * ```
	 */
	function gate<T extends Function>(
		predicate: (ctx: LiveContext<any>, ...args: any[]) => boolean | Promise<boolean>,
		fn: T
	): T;

	/**
	 * Declarative per-function rate limiting.
	 * Wraps a live() function with a sliding window rate limiter.
	 *
	 * @param config - Rate limit configuration
	 * @param fn - Handler function (ctx, ...args)
	 *
	 * @example
	 * ```js
	 * export const sendMessage = live.rateLimit({ points: 5, window: 10000 }, async (ctx, text) => {
	 *   const msg = await db.messages.insert({ userId: ctx.user.id, text });
	 *   ctx.publish('messages', 'created', msg);
	 *   return msg;
	 * });
	 * ```
	 */
	function rateLimit<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(
		config: {
			/** Maximum number of calls allowed within the window. */
			points: number;
			/** Time window in milliseconds. */
			window: number;
			/** Custom key function. Defaults to `ctx.user.id`. */
			key?(ctx: LiveContext<any>): string;
		},
		fn: T
	): T;

	/**
	 * Configure registry-level rate limits. The default rule applies to every
	 * RPC path that doesn't have its own per-handler `live.rateLimit(...)`
	 * wrapping; per-path overrides and per-path opt-outs (`exempt`) layer on top.
	 *
	 * Resolution order per RPC call:
	 *   1. Path is in `exempt` -> no rate limit.
	 *   2. Path has a per-handler `live.rateLimit(...)` wrapping -> per-handler
	 *      rule applies (registry is bypassed entirely for that path).
	 *   3. Path is in `overrides` -> override rule applies.
	 *   4. `default` is set -> default rule applies.
	 *   5. Otherwise -> no rate limit.
	 *
	 * Stream subscribes are NOT rate-limited by this primitive (subscribe-rate
	 * shaping is the adapter's concern). Pass `null` to clear the registry.
	 *
	 * @example
	 * ```js
	 * // hooks.ws.js or a startup module
	 * live.rateLimits({
	 *   default: { points: 200, window: 10_000 },
	 *   overrides: {
	 *     'chat/sendMessage': { points: 50, window: 10_000 },
	 *     'orders/create':    { points: 5,  window: 60_000 }
	 *   },
	 *   exempt: ['presence/moveCursor', 'cursor/move']
	 * });
	 * ```
	 */
	function rateLimits(config: {
		default?: { points: number; window: number } | null;
		overrides?: Record<string, { points: number; window: number }>;
		exempt?: string[];
	} | null): void;

	/**
	 * Configure the dev-mode publish-rate warning. Off in production builds
	 * regardless of configuration; on in development with sensible defaults.
	 *
	 * When enabled, every connected platform is sampled at `intervalMs`
	 * (default 5000 ms). The first time a topic's measured publish rate
	 * exceeds `threshold` (default 200 events/sec), a one-shot
	 * `console.warn` fires pointing at the `coalesceBy` documentation. One
	 * warning per topic per process. The sampler reads
	 * `platform.pressure.topPublishers` directly - the underlying counters
	 * are already maintained by the adapter, so the cost in development is
	 * a single `setInterval` per platform with no additional per-publish
	 * overhead.
	 *
	 * Pass `false` to disable entirely (useful for noisy dev environments
	 * or for CLI tools that mount `live()` without a UI). Pass `true` (or
	 * call without arguments) to re-enable. Pass an object to override
	 * threshold or interval; either field can be omitted to keep its
	 * current value.
	 *
	 * @example
	 * ```js
	 * // Quiet the warning for a CLI script that doesn't need it
	 * live.publishRateWarning(false);
	 *
	 * // Lower the bar for a noisier environment
	 * live.publishRateWarning({ threshold: 50 });
	 *
	 * // Sample more frequently
	 * live.publishRateWarning({ threshold: 200, intervalMs: 1000 });
	 * ```
	 */
	function publishRateWarning(
		config?: false | true | { threshold?: number; intervalMs?: number }
	): void;

	/**
	 * Configure the dev-mode silent-topic warning. When a stream subscribes
	 * to a topic and no events arrive within `thresholdMs` (default 30000),
	 * the framework logs a one-shot `console.warn` naming the topic and
	 * the common causes - missing `pg_notify` trigger, missing
	 * handler-side `ctx.publish()`, or an intentionally low-traffic topic
	 * the user can suppress.
	 *
	 * Off in production builds regardless of configuration; on by default
	 * in development. Topics starting with `__` (system topics like
	 * `__realtime`, `__signal:*`, `__custom`) are skipped automatically;
	 * users only need to populate `suppress` for application topics that
	 * are intentionally quiet.
	 *
	 * Pass `false` to disable entirely (useful for CI runs or for CLI
	 * tools that mount `live()` without subscribing). Pass `true` (or
	 * call without arguments) to re-enable. Pass an object to override
	 * threshold or per-topic suppression list; either field can be
	 * omitted to keep its current value.
	 *
	 * @example
	 * ```js
	 * // Disable globally
	 * live.silentTopicWarning(false);
	 *
	 * // Lower the bar for a noisier insight (5s instead of 30s)
	 * live.silentTopicWarning({ thresholdMs: 5000 });
	 *
	 * // Suppress per-topic for known-quiet streams
	 * live.silentTopicWarning({ suppress: ['admin:audit', 'cron:reports'] });
	 * ```
	 */
	function silentTopicWarning(
		config?: false | true | { thresholdMs?: number; suppress?: string[] }
	): void;

	/**
	 * Three-state idempotency store contract. Compatible with `createIdempotencyStore`
	 * from `svelte-adapter-uws-extensions` (Redis + Postgres backends).
	 */
	interface IdempotencyStore {
		acquire(key: string, ttlSec: number): Promise<
			| { acquired: true; commit(value: any): Promise<void>; abort(): Promise<void> }
			| { pending: true }
			| { result: any }
		>;
	}

	/**
	 * Wrap an RPC handler with idempotency. Identical calls (matched by key)
	 * return the cached result without re-running the handler. Composes with
	 * `live()`, `live.validated()`, `live.rateLimit()`, etc.
	 *
	 * The key is derived from `config.keyFrom(ctx, ...args)` if provided, otherwise
	 * from the client envelope's `idempotencyKey` (set on the client via
	 * `rpc.with({ idempotencyKey })`). When neither is present the call runs
	 * as if the wrapper were absent.
	 *
	 * Only successful results are cached. A throwing handler aborts the slot
	 * so the next caller re-runs. Reusing the same key with a DIFFERENT request
	 * payload throws `LiveError('IDEMPOTENCY_KEY_REUSED')` instead of returning
	 * the first call's result (a genuine idempotent retry must carry the same
	 * body); the framework fingerprints the request args to detect the mismatch.
	 *
	 * Default store is in-process and bounded. For multi-instance deployments,
	 * pass `store: createIdempotencyStore(redis)` from
	 * `svelte-adapter-uws-extensions/idempotency`.
	 *
	 * @param config - Idempotency configuration
	 * @param fn - Handler function (ctx, ...args)
	 *
	 * @example
	 * ```js
	 * // Server-derived key, default in-memory store, 24h TTL
	 * export const createOrder = live.idempotent(
	 *   {
	 *     keyFrom: (ctx, input) => `order:${ctx.user.id}:${input.clientOrderId}`,
	 *     ttl: 24 * 3600
	 *   },
	 *   live.validated(OrderSchema, async (ctx, input) => createOrder(ctx, input))
	 * );
	 * ```
	 *
	 * @example
	 * ```js
	 * // Client-supplied key, multi-instance store
	 * import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/idempotency';
	 * const store = createIdempotencyStore(redis);
	 *
	 * export const charge = live.idempotent(
	 *   { store },
	 *   async (ctx, input) => stripe.charge(input)
	 * );
	 *
	 * // Client
	 * await charge.with({ idempotencyKey: crypto.randomUUID() })(payload);
	 * ```
	 */
	function idempotent<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(
		config: {
			/** Derive the idempotency key from the call. Returning a falsy value disables idempotency for that call. */
			keyFrom?(ctx: LiveContext<any>, ...args: any[]): string | null | undefined;
			/** Idempotency store. Defaults to a bounded in-process map. */
			store?: IdempotencyStore;
			/** Cache TTL in seconds. Defaults to 172800 (48 hours). */
			ttl?: number;
		},
		fn: T
	): T;

	/**
	 * Lock contract: any object exposing `withLock(key, fn, opts?)` matching
	 * the adapter's Lock plugin. The default in-process lock is created
	 * lazily; pass a custom one for distributed mutex via Redis
	 * (`SET NX PX`) or any other backing store.
	 *
	 * The `opts.maxWaitMs` field, when set, rejects a queued caller with a
	 * typed `LOCK_TIMEOUT` error if it does not acquire within that many
	 * milliseconds. Custom Lock implementations are expected to honor it
	 * (or ignore it for backends where bounded-wait does not apply).
	 */
	interface Lock {
		withLock<T>(
			key: string,
			fn: () => T | Promise<T>,
			opts?: { maxWaitMs?: number }
		): Promise<T>;
	}

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
	 * Default lock is in-process. For multi-instance deployments, pass
	 * `lock: createDistributedLock(redis)` from
	 * `svelte-adapter-uws-extensions/redis/lock` (or any object exposing
	 * `withLock(key, fn)` matching the contract).
	 *
	 * Use for cron-ish triggers, expensive recompute, single-flight cache
	 * fills, and atomic read-modify-write on shared records.
	 *
	 * @example
	 * ```js
	 * // Per-org leaderboard recompute: only one in-flight recompute per org
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
	 * // Static key (single global section)
	 * export const rebuildSearchIndex = live.lock(
	 *   'search-index-rebuild',
	 *   async (ctx) => { ... }
	 * );
	 * ```
	 *
	 * @example
	 * ```js
	 * // Distributed lock (multi-instance) via the extensions package
	 * import { createDistributedLock } from 'svelte-adapter-uws-extensions/redis/lock';
	 * const distributedLock = createDistributedLock(redis);
	 *
	 * export const settleInvoice = live.lock(
	 *   { key: (ctx, id) => `invoice:${id}`, lock: distributedLock },
	 *   live.validated(InvoiceIdSchema, async (ctx, id) => settle(id))
	 * );
	 * ```
	 *
	 * @example
	 * ```js
	 * // Bounded wait: queued callers reject with LiveError('LOCK_TIMEOUT')
	 * // after 5s instead of waiting indefinitely behind a slow holder.
	 * export const recomputeReport = live.lock(
	 *   { key: (ctx, id) => `report:${id}`, maxWaitMs: 5000 },
	 *   async (ctx, id) => rebuild(id)
	 * );
	 * ```
	 */
	function lock<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(
		keyOrConfig:
			| string
			| ((ctx: LiveContext<any>, ...args: any[]) => string | null | undefined)
			| {
				key:
					| string
					| ((ctx: LiveContext<any>, ...args: any[]) => string | null | undefined);
				lock?: Lock;
				/**
				 * When set, queued callers waiting for this lock are rejected
				 * with `LiveError('LOCK_TIMEOUT', ...)` after this many
				 * milliseconds. The current holder is not interrupted; only
				 * the waiting caller gives up. Subsequent waiters on the same
				 * key continue in their original order.
				 */
				maxWaitMs?: number;
			},
		fn: T
	): T;

	/**
	 * Structural shape of the cluster-routing registry consumed by
	 * `live.push`. The `ConnectionRegistry` exported by
	 * `svelte-adapter-uws-extensions/redis/registry` conforms to this; any
	 * other registry implementation is accepted as long as it exposes a
	 * compatible `request(...)` method. Typed structurally so this package
	 * does not take a hard dependency on the extensions package.
	 */
	interface PushRemoteRegistry {
		request<TReply = unknown>(
			target: string,
			event: string,
			data?: unknown,
			options?: { timeoutMs?: number }
		): Promise<TReply>;
		/**
		 * Optional cluster-routed request/reply keyed by an app session id.
		 * When present (the extensions connection registry created with a
		 * `sessionIdentify` option exposes it), `live.push({ sessionId })` /
		 * `live.notify({ sessionId })` route cluster-wide; absent, the
		 * sessionId target stays single-instance.
		 */
		requestSession?<TReply = unknown>(
			target: string,
			event: string,
			data?: unknown,
			options?: { timeoutMs?: number }
		): Promise<TReply>;
	}

	/**
	 * Configure the push registry. Accepts two independent fields:
	 *
	 * - `identify` - override how `pushHooks.open` extracts the userId
	 *   from a connecting WebSocket. Defaults to reading
	 *   `ws.getUserData()?.user_id ?? ws.getUserData()?.userId`. May return
	 *   `null` / `undefined` for anonymous connections, in which case
	 *   `pushHooks.open` skips registration. Pass `null` to clear an
	 *   override and restore the default.
	 *
	 * - `sessionIdentify` - override how `pushHooks.open` extracts the
	 *   sessionId for `live.push({ sessionId })` / `live.notify({ sessionId })`
	 *   routing. Defaults to reading
	 *   `ws.getUserData()?.session_id ?? ws.getUserData()?.sessionId`.
	 *   Independent of `identify`: a connection may register under a userId,
	 *   a sessionId, both, or neither. Pass `null` to clear.
	 *
	 * - `remoteRegistry` - wire a cluster-routing registry so `live.push`
	 *   can reach users connected to other instances. When the userId is
	 *   not registered locally, `live.push` falls through to
	 *   `remoteRegistry.request(userId, ...)`. If the registry also exposes
	 *   `requestSession(sessionId, ...)` (the extensions connection registry
	 *   created with a `sessionIdentify` option does), `live.push({ sessionId })`
	 *   / `live.notify({ sessionId })` route cluster-wide too; otherwise the
	 *   sessionId target stays single-instance. Pass `null` to clear.
	 *
	 * At least one of `identify` / `sessionIdentify` / `remoteRegistry` must be
	 * provided per call; passing `{}` is a runtime error and rejected here at
	 * compile time. Pass `null` (in place of the whole config object) to clear
	 * all slots at once.
	 *
	 * @example
	 * ```js
	 * import { live } from 'svelte-realtime/server';
	 *
	 * // Custom userData shape:
	 * live.configurePush({ identify: (ws) => ws.getUserData()?.account?.id });
	 *
	 * // Route by session for resume-aware push:
	 * live.configurePush({ sessionIdentify: (ws) => ws.getUserData()?.sid });
	 *
	 * // Wire cluster routing:
	 * import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';
	 * const registry = createConnectionRegistry(redis, { identify: (ws) => ws.getUserData()?.userId });
	 * live.configurePush({ remoteRegistry: registry });
	 * ```
	 */
	function configurePush(
		config:
			| { identify: ((ws: any) => string | null | undefined) | null; sessionIdentify?: ((ws: any) => string | null | undefined) | null; remoteRegistry?: PushRemoteRegistry | null }
			| { identify?: ((ws: any) => string | null | undefined) | null; sessionIdentify: ((ws: any) => string | null | undefined) | null; remoteRegistry?: PushRemoteRegistry | null }
			| { identify?: ((ws: any) => string | null | undefined) | null; sessionIdentify?: ((ws: any) => string | null | undefined) | null; remoteRegistry: PushRemoteRegistry | null }
			| null
	): void;

	/**
	 * Right-to-erasure (GDPR Article 17): purge every trace of a user across the
	 * framework's in-memory state and any wired durable store, scoped to one
	 * tenant. A connection-less SERVER action - it is not reachable from the
	 * wire, so the app owns the "should this user be erased" authorization at the
	 * call site. Erases data at rest; it does NOT disconnect the user (do that
	 * from `onForget` or your own socket handling if the session should end too).
	 *
	 * In-memory surfaces purged: the push registry, presence refs (grace timer
	 * cleared, cluster roster decremented when a platform is wired), rate-limit
	 * buckets, and idempotency cached results (via a per-user reverse index - the
	 * opaque cache key cannot be substring-matched). Durable cluster rows
	 * (Redis / Postgres) are erased through the `store.purgeUser` seam wired via
	 * `configureForget({ store })`; the promise resolves ONLY after the durable
	 * store confirms (resolving early would be a compliance lie). A durable
	 * failure rejects with `LiveError('FORGET_STORE_FAILED')` so the incomplete
	 * erasure can be retried.
	 *
	 * `tenantId` is server-trusted: pass it from your own context (`ctx.tenantId`
	 * or your own logic), never straight off the wire. Defaults to `null`
	 * (single-tenant). `mode`/`cascade` are reserved for the durable store.
	 *
	 * Note: the push routing registry is keyed by raw userId with no tenant
	 * segment (it assumes globally-unique userIds), so in a multi-tenant
	 * deployment that reuses userIds across tenants, a forget can clear another
	 * tenant's push routing entry for the same userId. That entry is routing
	 * state only (no data/PII) and self-heals on the user's next connect. All
	 * other surfaces are tenant-scoped.
	 *
	 * The result carries per-surface counts for the trusted server caller. If you
	 * re-expose forget to untrusted clients, map the result to a constant shape
	 * so a 0-vs-N `rowsAffected` does not become a user-existence oracle.
	 *
	 * @example
	 * ```js
	 * // In an admin RPC handler, after your own authz check:
	 * const res = await live.forget(targetUserId, {
	 *   tenantId: ctx.tenantId,
	 *   onForget: ({ userIdHash, tenantId, rowsAffected }) =>
	 *     auditLog.write({ action: 'erasure', userIdHash, tenantId, rowsAffected })
	 * });
	 * ```
	 */
	function forget(
		userId: string,
		opts?: {
			tenantId?: string | null;
			cascade?: any;
			mode?: 'delete' | 'anonymize';
			onForget?: (record: {
				userIdHash: string;
				tenantId: string | null;
				cascade: any;
				rowsAffected: number;
				surfaces: Record<string, number>;
				at: number;
			}) => void;
		}
	): Promise<ForgetResult>;

	/**
	 * Send a server-initiated request to a connected user and await the reply.
	 * Routes through the push registry populated by `pushHooks.open` /
	 * `pushHooks.close`, so the user must have an active connection on this
	 * server instance.
	 *
	 * Returns whatever the client's `onPush(event, handler)` returns.
	 *
	 * **Error surface (all `LiveError` with discriminating `.code`):**
	 *
	 * - `VALIDATION` - bad target / event / options / timeoutMs at the call site.
	 * - `NOT_FOUND` - no connection is registered for the userId
	 *   (and no `remoteRegistry` is configured).
	 * - `TIMEOUT` - the client did not reply within `timeoutMs` (default 5000).
	 *   Message text preserves the underlying primitive's wording (`'request
	 *   timed out'`) so substring callers continue to match while migrating
	 *   to `err.code === 'TIMEOUT'`.
	 *
	 * Other rejection sources pass through unchanged: a recipient handler that
	 * throws (caller-defined error), `Error('connection closed')` from the
	 * adapter when the ws closes mid-flight, or any non-timeout error from a
	 * configured `remoteRegistry`.
	 *
	 * Multi-device users see most-recent-connection-wins routing. Cluster-wide
	 * push (any instance routing to any user's ws) requires the connection
	 * registry primitive in the extensions package.
	 *
	 * Target by `{ sessionId }` instead of `{ userId }` to route to a specific
	 * session's connection (resume-aware: a reconnecting session keeps its id and
	 * the push follows it to the live socket). Exactly one target key is required.
	 * sessionId routing is single-instance today (the cluster registry is
	 * userId-keyed).
	 *
	 * For fire-and-forget delivery (no reply expected), use `live.notify`
	 * instead. `live.push({ timeoutMs: 0 })` rejects with
	 * `LiveError('VALIDATION')` - `timeoutMs` must be a positive finite
	 * number on this primitive.
	 *
	 * Requires `svelte-adapter-uws` >= 0.5.0-next.4 for `platform.request`.
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
	 * // hooks.ws.js - wire the registry once:
	 * import { pushHooks } from 'svelte-realtime/server';
	 * export const open = pushHooks.open;
	 * export const close = pushHooks.close;
	 * ```
	 */
	function push<TReply = unknown>(
		target: { userId: string } | { sessionId: string },
		event: string,
		data?: unknown,
		options?: { timeoutMs?: number }
	): Promise<TReply>;
	/**
	 * Topic target: broadcast a request to EVERY subscriber of `topic` (this
	 * instance) and aggregate the replies. Partial success - a subscriber that
	 * times out / errors / closed lands in `errors`, never failing the whole
	 * call. Single-instance today (the cross-instance broadcast is a separate
	 * extensions primitive). Needs `svelte-adapter-uws >= 0.6.0-next.39`.
	 */
	function push<TReply = unknown>(
		target: { topic: string },
		event: string,
		data?: unknown,
		options?: { timeoutMs?: number }
	): Promise<{ replies: TReply[]; errors: Array<{ message: string }>; count: number; delivered: number }>;

	/**
	 * Send a server-initiated event to a connected user without awaiting
	 * a reply. The fire-and-forget counterpart to `live.push`.
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
	 * caller-side semantics. When the adapter ships a true no-reply
	 * primitive, the internals swap without changing this caller API.
	 *
	 * **Don't use `live.push({ timeoutMs: 0 })` for fire-and-forget.** It
	 * throws synchronously (timeoutMs must be positive). Wrapping the
	 * throw in `.catch(() => {})` silently swallows it - the push never
	 * fires, the recipient never sees anything, no diagnostic anywhere.
	 * Use `live.notify` instead.
	 *
	 * Validation throws SYNCHRONOUSLY for programming errors (bad target,
	 * empty event name) - those are bugs at the call site, not request-
	 * scoped failures, and you want them surfaced loud.
	 *
	 * @example
	 * ```js
	 * // Inside an upload completion handler:
	 * live.notify({ userId: upload.userId }, 'upload:complete', { id: upload.id });
	 * // Fire-and-forget. Returns immediately. If the user is offline,
	 * // silently drops - they'll see the result on next page load.
	 * ```
	 */
	function notify(
		target: { userId: string } | { sessionId: string } | { topic: string },
		event: string,
		data?: unknown
	): Promise<void>;

	/**
	 * Mark a function as RPC-callable with schema validation.
	 * Validates args[0] against the schema before calling fn.
	 * Supports any [Standard Schema](https://standardschema.dev/)-compatible schema,
	 * including Zod, ArkType, Valibot v1+, and others.
	 *
	 * @param schema - Zod, ArkType, Valibot, or any Standard Schema-compatible schema
	 * @param fn - Handler function (ctx, validatedInput, ...rest)
	 *
	 * @example
	 * ```js
	 * import { z } from 'zod';
	 * const SendSchema = z.object({ text: z.string().min(1) });
	 * export const send = live.validated(SendSchema, async (ctx, input) => {
	 *   // input is validated and typed
	 * });
	 * ```
	 *
	 * @example
	 * ```js
	 * import { type } from 'arktype';
	 * const SendSchema = type({ text: 'string>0' });
	 * export const send = live.validated(SendSchema, async (ctx, input) => {
	 *   // works with any Standard Schema-compatible validator
	 * });
	 * ```
	 */
	function validated<S, T extends (ctx: LiveContext<any>, input: any, ...args: any[]) => any>(
		schema: S,
		fn: T
	): T;

	/**
	 * Create a server-side scheduled function that publishes to a topic on a cron schedule.
	 *
	 * The function receives a `ctx` object with `publish`, `throttle`, `debounce`, and `signal`.
	 * If the function returns a value, it is published as a `set` event on the topic.
	 * If the function returns `undefined`, no automatic publish happens (use `ctx.publish` instead).
	 *
	 * @param schedule - Cron expression (5 fields: minute hour day month weekday)
	 * @param topic - Topic to publish results to
	 * @param fn - Async function to run on schedule
	 *
	 * @example
	 * ```js
	 * // Return a value - published as 'set' automatically
	 * export const refreshStats = live.cron('*\/5 * * * *', 'stats', async () => {
	 *   return db.stats();
	 * });
	 *
	 * // Use ctx.publish for fine-grained control (e.g. crud streams)
	 * export const cleanup = live.cron('0 * * * *', 'boards', async (ctx) => {
	 *   const stale = await listStaleBoards();
	 *   for (const board of stale) {
	 *     await deleteBoard(board.board_id);
	 *     ctx.publish('boards', 'deleted', { board_id: board.board_id });
	 *   }
	 * });
	 * ```
	 */
	function cron<T extends ((ctx: CronContext) => any) | (() => any)>(
		schedule: string,
		topic: string,
		fn: T
	): T;

	/**
	 * Declare a server-side feature flag exposed as a readable stream.
	 *
	 * A flag is a thin wrapper over `live.stream`: it declares a
	 * `merge: 'set'` topic carrying the flag value, and any `.set(value)`
	 * pushes the new value to every subscriber. On the client,
	 * `$live/<module>` exposes the export as a readable store carrying the
	 * current value.
	 *
	 * Flags are cluster-consistent by default: a single-entry shared replay
	 * buffer is enabled, so `.set()` writes the cluster-shared buffer and a
	 * subscriber that connects fresh - to any replica, including one that
	 * never set the flag locally - is served the cluster-latest value.
	 * Already-subscribed clients stay in sync across the cluster as `.set()`
	 * relays the update. Pass a custom `replay` object to size the buffer, or
	 * `replay: false` to opt out (single-process apps lose nothing, since the
	 * locally cached value is authoritative in one process).
	 *
	 * `.set(value)` publishes through the framework-owned platform (the same
	 * path as the top-level `publish()` helper), so the new value reaches
	 * every local subscriber and relays across the cluster when a bus is
	 * wired. Call it from any server context after the platform has been
	 * captured. `.get()` reads the current value on the server synchronously;
	 * an internal watcher - installed when the registry module loads, the same
	 * lifecycle that activates `live.effect` watchers - keeps it fresh from boot
	 * within a tick of any inbound `set` on a running replica, without waiting
	 * for the flag module's first local import. `getLatest()` reads the
	 * cluster-latest value asynchronously from the shared buffer for the strict
	 * read on a replica that booted after the last `set` and has not yet
	 * received any inbound `set`.
	 *
	 * @param topic - Topic carrying the flag value
	 * @param initialValue - Value served to subscribers before the first `.set`
	 * @param options - Optional `replay` to size the shared buffer, or `replay: false` to opt out
	 *
	 * @example
	 * ```js
	 * // src/live/flags.js
	 * export const maintenance = live.flag('flag:maintenance', false);
	 *
	 * export const toggleMaintenance = live(async (ctx, on) => {
	 *   maintenance.set(on);
	 * });
	 * ```
	 */
	function flag<V = any>(
		topic: string,
		initialValue?: V,
		options?: { replay?: boolean | { size?: number } }
	): Function & { set(value: V): any; get(): V; getLatest(): Promise<V> };

	/**
	 * Create a real-time incremental aggregation over a source topic.
	 *
	 * @param source - Topic to watch
	 * @param reducers - Field definitions with init/reduce/compute (and `combine` when using sliding windows)
	 * @param options - Output topic, optional snapshot, debounce, optional `windows`
	 *
	 * @example
	 * ```js
	 * // Single-state aggregate (no windows)
	 * export const orderStats = live.aggregate('orders', {
	 *   count: { init: () => 0, reduce: (acc, event) => event === 'created' ? acc + 1 : acc },
	 *   avgValue: { compute: (state) => state.count > 0 ? state.total / state.count : 0 }
	 * }, { topic: 'order-stats' });
	 * ```
	 *
	 * @example
	 * ```js
	 * // Windowed aggregate - emits one output topic per window:
	 * //   events:view:topk:last10min, events:view:topk:today,
	 * //   events:view:topk:thisMonth, events:view:topk:lifetime
	 * import { combineCounts } from 'svelte-realtime/server';
	 *
	 * export const trending = live.aggregate('events:view', {
	 *   counts: {
	 *     init: () => ({}),
	 *     reduce: (acc, event, data) => event === 'viewed'
	 *       ? { ...acc, [data.itemId]: (acc[data.itemId] ?? 0) + 1 }
	 *       : acc,
	 *     combine: combineCounts // required for sliding windows
	 *   },
	 *   top: {
	 *     compute: (state) => Object.entries(state.counts)
	 *       .sort((a, b) => b[1] - a[1])
	 *       .slice(0, 10)
	 *       .map(([itemId, count]) => ({ itemId, count }))
	 *   }
	 * }, {
	 *   topic: 'events:view:topk',
	 *   windows: {
	 *     last10min: { type: 'sliding', durationMs: 600_000, slideMs: 30_000 },
	 *     today:     { type: 'tumbling', period: 'daily', tz: 'UTC' },
	 *     thisMonth: { type: 'tumbling', period: 'monthly', tz: 'UTC' },
	 *     lifetime:  { type: 'lifetime' }
	 *   }
	 * });
	 *
	 * // Client-side: subscribe to whichever windows you care about
	 * import { trending } from '$live/topk';
	 * $: rows = $trending.last10min?.top ?? [];
	 * ```
	 */
	function aggregate(
		source: string,
		reducers: Record<string, {
			init?(): any;
			reduce?(acc: any, event: string, data: any): any;
			compute?(state: Record<string, any>): any;
			combine?(...buckets: any[]): any;
		}>,
		options: {
			topic: string;
			/**
			 * Optional snapshot for the single-state form, OR (when `windows`
			 * is set) a fallback restore for a window literally named
			 * `lifetime`. For multi-window snapshots, prefer `snapshots`.
			 */
			snapshot?(): Promise<Record<string, any>>;
			/**
			 * Per-window snapshot loaders. Keyed by window name (must match
			 * a key in `windows`). Each is awaited in parallel during
			 * registration; failure is silent (logs only) so a missing
			 * snapshot never blocks boot. Sliding windows are not
			 * snapshot-restorable (the bucket ring's hop boundaries are
			 * tied to wall-clock time and would not survive a restart
			 * coherently); pass tumbling and lifetime here.
			 */
			snapshots?: Record<string, () => Promise<Record<string, any>>>;
			/**
			 * Default debounce in milliseconds for output publishes.
			 * Per-window override available via `WindowSpec.debounce`.
			 */
			debounce?: number;
			/**
			 * Optional time-windowing. When set, the aggregate maintains
			 * one state slice per declared window, emits one output topic
			 * per window at `${topic}:${windowName}`, and the client
			 * stub becomes a namespace object keyed by window name. Omit
			 * for the single-state form (existing behavior, unchanged).
			 */
			windows?: Record<string, WindowSpec>;
			/**
			 * Privacy layer: k-anonymity suppression and/or differential-privacy
			 * noise on the published aggregate. Default off. `strategy` 'suppress'
			 * withholds the aggregate until at least `k` distinct contributors
			 * (counted via `contributor(data)`) have fed the window - holding the
			 * last published value, never a null/marker. 'perturb' adds zero-mean
			 * Laplace / Gaussian noise to numeric fields. 'hybrid' (default) does
			 * both. Noise is seeded by (topic, window) so every cluster replica
			 * emits identical noise.
			 */
			privacy?: AggregatePrivacyConfig;
		}
	): Function;

	/**
	 * Create a server-side reactive side effect.
	 * Effects fire when source topics publish. Fire-and-forget - no data, no topic.
	 *
	 * @param sources - Topic names to watch
	 * @param fn - Async function called on each matching publish
	 * @param options - Debounce settings
	 *
	 * @example
	 * ```js
	 * export const orderNotifications = live.effect(['orders'], async (event, data, platform) => {
	 *   if (event === 'created') {
	 *     await email.send(data.userEmail, 'Order confirmed', templates.orderConfirm(data));
	 *   }
	 * });
	 * ```
	 */
	function effect(
		sources: string[],
		fn: (event: string, data: any, platform: Platform) => void | Promise<void>,
		options?: { debounce?: number }
	): Function;

	/**
	 * Create a server-side computed stream that recomputes when any source topic publishes.
	 *
	 * Static form: pass an array of topic names to watch.
	 * Dynamic form: pass a function that receives runtime args and returns topic names.
	 *
	 * @param sources - Topic names to watch, or a factory function that receives runtime args
	 * @param fn - Async function that computes the derived value
	 * @param options - Merge mode and debounce settings
	 *
	 * @example
	 * ```js
	 * // Static sources
	 * export const summary = live.derived(['orders', 'inventory'], async () => {
	 *   return { totalOrders: await db.orders.count(), totalItems: await db.inventory.count() };
	 * });
	 *
	 * // Dynamic sources (parameterized)
	 * export const stats = live.derived(
	 *   (orgId) => [`memberships:${orgId}`, `emails:${orgId}`],
	 *   async (ctx, orgId) => {
	 *     return { members: await countMembers(orgId), emails: await countEmails(orgId) };
	 *   },
	 *   { debounce: 100 }
	 * );
	 * ```
	 */
	function derived<T extends (...args: any[]) => any>(
		sources: (...args: any[]) => string[],
		fn: T,
		options?: { merge?: string; debounce?: number }
	): T;
	function derived<T extends () => any>(
		sources: string[],
		fn: T,
		options?: { merge?: string; debounce?: number }
	): T;

	/**
	 * Create a collaborative room that bundles data stream, presence, cursors, and scoped RPC.
	 *
	 * @param config - Room configuration
	 *
	 * @example
	 * ```js
	 * export const board = live.room({
	 *   topic: (ctx, boardId) => 'board:' + boardId,
	 *   init: async (ctx, boardId) => db.boards.get(boardId),
	 *   presence: (ctx) => ({ name: ctx.user.name }),
	 *   cursors: true,
	 *   actions: {
	 *     addCard: async (ctx, title) => { ... }
	 *   }
	 * });
	 * ```
	 */
	function room(config: RoomConfig): RoomExport;

	/**
	 * Bundle the collaborative surfaces (live cursors and presence) into one
	 * declaration whose codegen produces a connection-aware client object.
	 * Reuses the room sub-stream machinery for the `data` / `presence` /
	 * `cursors` streams, then adds the `status` connection store and the
	 * `move` / `reportViewport` cursor methods on the client. The cursor
	 * methods publish a keyed update to the room's cursor sub-topic, so the
	 * `cursors` stream reflects every connected client's position.
	 *
	 * @example
	 * ```js
	 * export const board = live.multiplayer({
	 *   topic: (ctx, id) => 'board:' + id,
	 *   presence: (ctx) => ({ id: ctx.user.id, name: ctx.user.name }),
	 *   cursors: true
	 * });
	 * ```
	 */
	function multiplayer(config: MultiplayerConfig): MultiplayerExport;

	/**
	 * Declare a topic of smoothed (predicted / reconciled) entities. The app
	 * writes ONE pure `apply(state, command, ctx)` in a plain shared module;
	 * the server runs it on an authoritative tick and the component constructs
	 * the view with the same import, so prediction and authority can never
	 * drift. Each connected identity owns exactly one entity per topic; a
	 * client can only ever send commands, never state.
	 *
	 * @example
	 * ```js
	 * import { apply } from './board.shared.js';
	 *
	 * export const shape = live.smooth({
	 *   topic: (ctx, boardId) => 'shape:' + boardId,
	 *   apply,
	 *   initial: { x: 0, y: 0 }
	 * });
	 * ```
	 */
	function smooth(config: SmoothConfig): SmoothExport;

	/**
	 * Declare a conflict-free shared document with named containers. Every
	 * client holds a local replica: reads never await the network, writes
	 * apply immediately (no pending state), and concurrent edits from any
	 * number of peers merge to the same value on every replica. Reconnects
	 * and offline sessions reconcile through one idempotent state-vector
	 * exchange. The guard resolves to a per-document `{read, write, comment}`
	 * access record (a boolean return widens to all three rights).
	 *
	 * @example
	 * ```js
	 * export const board = live.doc({
	 *   topic: (ctx, boardId) => 'board:' + boardId,
	 *   guard: ({ user }) => ({ read: user != null, write: isEditor(user) }),
	 *   persist: {
	 *     load: (topic) => db.loadSnapshot(topic),
	 *     store: (topic, bytes) => db.saveSnapshot(topic, bytes)
	 *   }
	 * });
	 * ```
	 */
	function doc(config: DocConfig): DocExport;

	/**
	 * Declare a conflict-free shared map: `live.doc` sugar whose
	 * component-side store IS the keyed container. Same options as
	 * {@link doc}.
	 */
	function map(config: DocConfig): DocExport;

	/**
	 * Declare a conflict-free shared list: `live.doc` sugar whose
	 * component-side store IS the ordered container. Same options as
	 * {@link doc}.
	 */
	function array(config: DocConfig): DocExport;

	/**
	 * Create a webhook-to-stream bridge.
	 * The returned handler can be used in a SvelteKit +server.js POST endpoint.
	 *
	 * @param topic - Topic to publish events to
	 * @param config - Verification and transformation functions
	 *
	 * @example
	 * ```js
	 * export const stripeEvents = live.webhook('payments', {
	 *   verify: ({ body, headers }) => stripe.webhooks.constructEvent(body, headers['stripe-signature'], secret),
	 *   transform: (event) => ({ event: event.type, data: event.data.object })
	 * });
	 * ```
	 */
	function webhook(topic: string, config: WebhookConfig): WebhookHandler;

	/**
	 * Webhook namespace. `live.webhooks.inbound` is `live.webhook` (bridge an
	 * external HTTP webhook into a topic). `live.webhooks.outbound` fires an
	 * outbound HTTP webhook when any source topic publishes - leader-gated,
	 * retried, optionally HMAC-signed, with an `idempotency-key` header and a
	 * built-in SSRF guard on the target URL. The flat `live.webhook` stays as a
	 * back-compat alias for the inbound form.
	 */
	const webhooks: {
		inbound(topic: string, config: WebhookConfig): WebhookHandler;
		outbound(sources: string[], config: OutboundWebhookConfig): OutboundWebhookHandler;
	};

	/**
	 * Opt-in Prometheus metrics integration. Instruments RPC calls, stream
	 * subscriptions, and cron executions. Zero overhead if never called.
	 *
	 * Call once at server start (e.g. the top of `src/hooks.ws.{js,ts}`).
	 * See the README "Prometheus metrics" section for a working example
	 * that pairs this with `createMetrics()` from
	 * `svelte-adapter-uws-extensions/prometheus`.
	 *
	 * @param registry - Object matching the {@link MetricsRegistry} shape
	 *
	 * @example
	 * ```js
	 * import { createMetrics } from 'svelte-adapter-uws-extensions/prometheus';
	 *
	 * const metrics = createMetrics();
	 * live.metrics({
	 *   counter:   ({ name, help, labelNames }) => metrics.counter(name, help, labelNames),
	 *   histogram: ({ name, help, labelNames }) => metrics.histogram(name, help, labelNames),
	 *   gauge:     ({ name, help, labelNames }) => metrics.gauge(name, help, labelNames)
	 * });
	 * ```
	 */
	function metrics(registry: MetricsRegistry): void;

	/**
	 * One of the four pressure reasons emitted by the adapter, in fixed
	 * precedence order: `MEMORY` > `PUBLISH_RATE` > `SUBSCRIBERS` > `NONE`.
	 */
	type PressureReason = 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY';

	/**
	 * Snapshot shape returned by `platform.pressure`. Mirrors the
	 * `PressureSnapshot` interface from svelte-adapter-uws.
	 */
	interface PressureSnapshot {
		active: boolean;
		subscriberRatio: number;
		publishRate: number;
		memoryMB: number;
		reason: PressureReason;
	}

	/**
	 * Configure pressure-aware admission control. Each named class maps to
	 * either an array of pressure reasons (shed when `platform.pressure.reason`
	 * is in the array) or a `(snapshot) => boolean` predicate.
	 *
	 * Once configured, `ctx.shed(className)` evaluates the matching rule
	 * against the current `platform.pressure`, and any
	 * `live.stream({ classOfService })` auto-rejects new subscribes under
	 * matching pressure with the `OVERLOADED` code.
	 *
	 * Pass `null` to clear (tests).
	 *
	 * Zero overhead when never called: `ctx.shed` returns `false` and
	 * `classOfService` is a no-op.
	 *
	 * @example
	 * ```js
	 * live.admission({
	 *   classes: {
	 *     critical:    [],                                          // never shed
	 *     interactive: ['MEMORY'],                                  // shed only on memory pressure
	 *     background:  ['MEMORY', 'PUBLISH_RATE', 'SUBSCRIBERS']    // shed on any pressure
	 *   }
	 * });
	 * ```
	 */
	function admission(config: {
		classes: Record<string, PressureReason[] | ((snapshot: PressureSnapshot) => boolean)>;
	} | null): void;

	/**
	 * Wrap a stream initFn call with a circuit breaker.
	 * When the breaker is open, returns the fallback value or throws SERVICE_UNAVAILABLE.
	 *
	 * @param options - Circuit breaker instance and optional fallback
	 * @param fn - The stream initFn to wrap
	 *
	 * @example
	 * ```js
	 * export const messages = live.breaker(
	 *   { breaker: cb, fallback: [] },
	 *   live.stream('messages', async (ctx) => db.messages.latest(50))
	 * );
	 * ```
	 */
	function breaker<T extends Function>(
		options: { breaker: any; fallback?: any },
		fn: T
	): T;

	/**
	 * Declare a tenant and (optionally) its config, returning a server-side handle
	 * for use OUTSIDE a request handler (a background job, a scheduled task).
	 *
	 * Tenant isolation is automatic and opt-in via `realtime({ tenant })`; inside a
	 * handler `ctx.tenant(id).publish(...)` is the cross-tenant escape. This factory
	 * validates `id`, records `config` (quota / metrics / breaker settings consumed
	 * by the cluster extensions - the realtime core does not enforce it), and exposes
	 * a `publish` that targets the tenant's scope using the active server platform.
	 *
	 * @param id - tenant id ([a-zA-Z0-9_-], at most 64 chars)
	 * @param config - opt-in per-tenant config carrier (not enforced by the core)
	 *
	 * @example
	 * ```js
	 * const acme = live.tenant('acme', { quota: { messagesPerSec: 100 } });
	 * acme.publish('maintenance', 'scheduled', { at: '02:00' });
	 * ```
	 */
	function tenant(id: string, config?: Record<string, any>): TenantHandle;

	/**
	 * Declarative access control helpers for subscribe-time gating.
	 * For per-event filtering, use `pipe.filter()`.
	 */
	const access: {
		/** Only allow subscription if `ctx.user[field]` is present. Default field: `'id'`. */
		owner(field?: string): (ctx: LiveContext<any>) => boolean;
		/** Role-based access: map role names to boolean or predicate. */
		role(map: Record<string, true | ((ctx: LiveContext<any>) => boolean)>): (ctx: LiveContext<any>) => boolean;
		/** Only allow subscription if `ctx.user.teamId` is present. */
		team(): (ctx: LiveContext<any>) => boolean;
		/**
		 * Org-scoped access: an extracted value (default arg 0) must equal
		 * `ctx.user.organization_id` (default field). Returns false when
		 * `ctx.user` is null. Closes authorization-bypass holes around
		 * per-org streams and RPCs without per-handler boilerplate.
		 *
		 * @example
		 * ```js
		 * live.stream(
		 *   (ctx, orgId) => `audit:${orgId}`,
		 *   loader,
		 *   { access: live.access.org() }
		 * );
		 * ```
		 */
		org(opts?: {
			/** Extract the value to compare against. Default: arg 0. */
			from?: (ctx: LiveContext<any>, ...args: any[]) => any;
			/** Field on `ctx.user` that holds the org id. Default: `'organization_id'`. */
			orgField?: string;
		}): (ctx: LiveContext<any>, ...args: any[]) => boolean;
		/**
		 * User-scoped access: an extracted value (default arg 0) must equal
		 * `ctx.user.user_id` (default field, matching `[table]_id`
		 * convention). Returns false when `ctx.user` is null. Use for
		 * resources that MUST belong to the calling user (private inbox,
		 * personal settings).
		 *
		 * @example
		 * ```js
		 * live.stream(
		 *   (ctx, userId) => `inbox:${userId}`,
		 *   loader,
		 *   { access: live.access.user() }
		 * );
		 * ```
		 */
		user(opts?: {
			/** Extract the value to compare against. Default: arg 0. */
			from?: (ctx: LiveContext<any>, ...args: any[]) => any;
			/** Field on `ctx.user` to compare to. Default: `'user_id'`. */
			userField?: string;
		}): (ctx: LiveContext<any>, ...args: any[]) => boolean;
		/**
		 * OR logic: any predicate returning true allows the subscription.
		 * Args are forwarded so `org` / `user` predicates compose. Sub-predicates
		 * may be sync OR async; each is awaited in order. Returns a Promise<boolean>
		 * (the runtime awaits the top-level predicate, so this composes with
		 * `live.stream({ access })`, `pipe.filter()`, and `live.gate(...)`).
		 */
		any(...predicates: Array<(ctx: LiveContext<any>, ...args: any[]) => boolean | Promise<boolean>>): (ctx: LiveContext<any>, ...args: any[]) => Promise<boolean>;
		/**
		 * AND logic: all predicates must return true. Args are forwarded so
		 * `org` / `user` predicates compose. Sub-predicates may be sync OR async;
		 * each is awaited in order. Returns a Promise<boolean>.
		 */
		all(...predicates: Array<(ctx: LiveContext<any>, ...args: any[]) => boolean | Promise<boolean>>): (ctx: LiveContext<any>, ...args: any[]) => Promise<boolean>;
	};

	/**
	 * Wrap a live function with an authorization predicate. Throws when
	 * the predicate returns false: `UNAUTHENTICATED` if `ctx.user` is
	 * null, `FORBIDDEN` otherwise. Predicate may be sync or async.
	 *
	 * For STREAMS, prefer the `access` option on `live.stream({ access: ... })`
	 * so the gate fires before subscribe-side bookkeeping. Use `live.scoped`
	 * for RPC handlers, where there is no `access` option.
	 *
	 * Composes with `live.validated`, `live.rateLimit`, and other wrappers.
	 *
	 * @example
	 * ```js
	 * export const updateOrg = live.scoped(
	 *   live.access.org({ from: (ctx, input) => input.orgId }),
	 *   live.validated(schema, async (ctx, input) => updateOrg(input))
	 * );
	 * ```
	 */
	function scoped<T extends (ctx: LiveContext<any>, ...args: any[]) => any>(
		predicate: (ctx: LiveContext<any>, ...args: Parameters<T> extends [any, ...infer R] ? R : any[]) => boolean | Promise<boolean>,
		fn: T
	): T;
}

/**
 * Room configuration for `live.room()`.
 */
export interface RoomConfig {
	/** Function that computes the room topic from context and args. */
	topic: (ctx: LiveContext<any>, ...args: any[]) => string;
	/** Function that returns initial data for the room. */
	init: (ctx: LiveContext<any>, ...args: any[]) => Promise<any>;
	/** Function that returns presence data for the connecting user. */
	presence?: (ctx: LiveContext<any>) => any;
	/** Enable cursor tracking. Pass `true` or `{ throttle: ms }`. */
	cursors?: boolean | { throttle?: number };
	/** Room-scoped RPC actions. */
	actions?: Record<string, (ctx: LiveContext<any>, ...args: any[]) => any>;
	/** Guard function run before data access and actions. */
	guard?: (ctx: LiveContext<any>, ...args: any[]) => void | Promise<void>;
	/** Called when a user joins the room. */
	onJoin?: (ctx: LiveContext<any>, ...args: any[]) => void | Promise<void>;
	/** Called when a user leaves the room. */
	onLeave?: (ctx: LiveContext<any>, topic: string) => void | Promise<void>;
	/** Merge strategy for the data stream. @default 'crud' */
	merge?: string;
	/** Key field for the data stream. @default 'id' */
	key?: string;
	/** Number of room-identifying args the topic function expects (excluding ctx). Required when topic uses rest params and actions are defined. @default topicFn.length - 1 */
	topicArgs?: number;
	/**
	 * Record a bounded history of app-captured state snapshots (one per
	 * successful action) and enable `ctx.compensate()` inside this room's
	 * actions. Requires `actions`.
	 */
	history?: RoomHistoryConfig;
	/**
	 * Per-room metadata for a lobby browser, resolved once when a room opens
	 * (its first subscriber arrives). Providing it opts the room into
	 * enumeration, so the generated `<export>.rooms()` lists the active rooms,
	 * each `{ args, count, meta }`. Receives the room-identifying args. A throwing
	 * `meta` never blocks the room (the room still appears, with empty meta).
	 */
	meta?: (...args: any[]) => any;
	/**
	 * Opt into room enumeration without per-room metadata (a count-only lobby).
	 * Implied by `meta`. @default false
	 */
	enumerable?: boolean;
}

/**
 * Return type of `live.room()`.
 */
export interface RoomExport {
	__isRoom: true;
	__dataStream: any;
	__topicFn: Function;
	__hasPresence: boolean;
	__hasCursors: boolean;
	__hasRooms: boolean;
	__presenceStream?: any;
	__cursorStream?: any;
	/** The enumeration stream (active rooms) when the room opts into enumeration. */
	__roomsStream?: any;
	/** The one-shot enumeration snapshot RPC backing `rooms().list()`. */
	__roomsSync?: any;
	/**
	 * Bind the enumeration identity to the export's stable module path so cluster
	 * replicas of one export share a Redis roster and pub/sub topic. Called by the
	 * registration path; present only on an enumerable room.
	 */
	__setEnumId?: (id: string) => void;
	__actions?: Record<string, any>;
}

/**
 * Configuration for `live.multiplayer()`. Mirrors `RoomConfig` and adds the
 * reserved field-surface declarations.
 */
export interface MultiplayerConfig {
	/** Function that computes the room topic from context and args. */
	topic: (ctx: LiveContext<any>, ...args: any[]) => string;
	/** Initial data for the room's data stream. Defaults to an empty list. */
	init?: (ctx: LiveContext<any>, ...args: any[]) => Promise<any>;
	/** Presence payload for the connecting user. Drives the roster. */
	presence?: (ctx: LiveContext<any>) => any;
	/** Enable cursor tracking. Pass `true` or `{ throttle: ms }`. */
	cursors?: boolean | { throttle?: number };
	/** Room-scoped RPC actions on the data stream. */
	actions?: Record<string, (ctx: LiveContext<any>, ...args: any[]) => any>;
	/** Guard run before data access and actions. */
	guard?: (ctx: LiveContext<any>, ...args: any[]) => void | Promise<void>;
	/** Called when a user joins. */
	onJoin?: (ctx: LiveContext<any>, ...args: any[]) => void | Promise<void>;
	/** Called when a user leaves. */
	onLeave?: (ctx: LiveContext<any>, topic: string) => void | Promise<void>;
	/** Merge strategy for the data stream. @default 'crud' */
	merge?: string;
	/** Key field for the data stream. @default 'id' */
	key?: string;
	/** Number of room-identifying args the topic function expects (excluding ctx). */
	topicArgs?: number;
	/**
	 * Record a bounded history of app-captured state snapshots (one per
	 * successful action) and enable `ctx.compensate()` inside this room's
	 * actions. Requires `actions`.
	 */
	history?: RoomHistoryConfig;
	/** Enable a typing-indicator surface published onto the room presence roster. */
	typing?: boolean;
	/**
	 * Enable advisory lock surfaces by key. These are collaborative awareness
	 * locks (a holder announces intent), published onto the presence roster, not
	 * distributed mutual exclusion.
	 */
	locks?: string[];
	/** Enable an ephemeral reactions surface on a dedicated reactions stream. */
	reactions?: boolean;
	/** Enable a remote-selection surface. Offset-mode ranges are published onto the presence roster. */
	selections?: 'offset' | 'crdt';
}

/**
 * Return type of `live.multiplayer()`. A superset of `RoomExport`.
 */
export interface MultiplayerExport extends RoomExport {
	__isMultiplayer: true;
	/** Presence-field send handler: publishes a keyed field delta onto the room presence topic. */
	__presenceUpdate?: any;
	/** Reactions sub-stream: a bounded append ring on the room reactions topic. */
	__reactionStream?: any;
	/** Reaction send handler: publishes an ephemeral reaction onto the room reactions topic. */
	__reactionEmit?: any;
	__fields: {
		typing: boolean;
		locks: string[] | null;
		reactions: boolean;
		selections: 'offset' | 'crdt' | null;
	};
}

/**
 * Configuration for `live.smooth()`.
 */
export interface SmoothConfig {
	/** Topic name, or a function computing it from context and room args. */
	topic: string | ((ctx: any, ...args: any[]) => string);
	/**
	 * The shared simulation step: pure `(state, command, ctx) -> state`.
	 * Reconciliation replays commands, so one-shot side effects must guard on
	 * `ctx.firstTime`, and randomness must come from `ctx.rng` (reseeded per
	 * command id - identical on prediction, replay, and the server).
	 */
	apply: (state: any, command: any, ctx: { firstTime: boolean; rng: { reseed(seed: number): void; float(): number; u32(): number } }) => any;
	/** Starting state for a new entity: a value, or `(key) => state`. */
	initial: any | ((key: string) => any);
	/** Guard run before sync and commands. Throw to deny, same shape as room guards. */
	guard?: (ctx: any, ...args: any[]) => any;
	/**
	 * Per-tick continuation for entities with no queued commands - the hook
	 * for genuinely simulated entities that keep moving between inputs.
	 * Omitted, an idle entity holds position and costs nothing.
	 */
	onMissing?: (state: any, lastCommand: any) => any;
	/** Authoritative tick interval in milliseconds. @default 50 */
	tickMs?: number;
	/**
	 * Suppress echoing an owner's own commanded updates in broadcasts - the
	 * acknowledgement carries the owner's copy. `onMissing` motion has no
	 * acknowledgement and always broadcasts to the owner too. @default true
	 */
	noEcho?: boolean;
	/** Per-entity command queue bound (an integer of at least 1). @default 1024 */
	queueCap?: number;
	/** Number of room-identifying args the topic function expects (excluding ctx). @default topicFn.length - 1 */
	topicArgs?: number;
	/**
	 * Opt-in area-of-interest culling for an uncapped lobby: each subscriber is
	 * delivered only the entities inside its area of interest (near entities every
	 * tick, fringe entities at a throttled cadence) instead of the whole board.
	 * Off by default - the broadcast-all path is byte-identical without it.
	 */
	interest?: SmoothInterestConfig;
	/**
	 * Opt-in server-rewind lag compensation: the server resolves `view.shoot(cmd)`
	 * against the world as the shooter saw it, rewinding each candidate to the
	 * instant the shooter rendered it. Requires `interest` - the shooter's
	 * replicated set (per-client relevancy membership, or its cell subscription
	 * under `interest.cells`) is the candidate-security gate: you cannot hit what
	 * was never replicated to the shooter. Off by default.
	 */
	hitTest?: SmoothHitTestConfig;
	/**
	 * Opt-in server logic hook, run on the ticking instance (the topic owner on a
	 * cluster) once per authoritative tick, after the command drain and before the
	 * broadcast - so reads see the tick's settled states and every write
	 * broadcasts atomically with it. `world` is the scoped authority view
	 * (forces, deaths, respawns, scripted movers, server entities); `t` is the
	 * tick's wall stamp (the same stamp acknowledgements carry). Return `true` to
	 * request the next tick even with no entity motion - the heartbeat for
	 * time-based logic like respawn timers (ticking is otherwise demand-armed and
	 * stops when everything rests). A throwing hook never kills the tick. Off by
	 * default; requires svelte-adapter-uws >= 0.6.0-next.47.
	 */
	onTick?: (world: SmoothWorld, t: number) => void | boolean;
	/**
	 * The topic's wire views: app-owned codec pairs applied at the CLIENT wire
	 * boundary and nowhere else. `state` packs every state the clients receive
	 * (tick updates, acknowledgements, the sync roster) into a compact
	 * JSON-serializable form - a rich simulation state stops paying
	 * verbose-JSON prices per entity per tick; `command` is the inverse for
	 * inbound commands and shots, unpacked at the RPC entry (a malformed
	 * packed command is dropped, never applied). Everything internal - the
	 * authority, lag compensation, interest culling, the cluster relay, the
	 * warm-handoff snapshot - runs on the full state; each instance packs
	 * independently at its own client edge. The client channel must declare
	 * the SAME pairs (share the module, like `apply`); requires
	 * svelte-adapter-uws >= 0.6.0-next.49 for the client-side unpack. Off by
	 * default - the wire carries the raw values, byte-identical.
	 */
	wire?: {
		state?: { pack: (state: any) => any; unpack: (packed: any) => any };
		command?: { pack: (cmd: any) => any; unpack: (packed: any) => any };
	};
}

/**
 * The scoped authority view handed to `onTick` - the server-side world surface
 * for game logic. It is a hook, not a game runtime: reads and writes on the
 * topic's entities, nothing else. Server entities share the key space with
 * client identities - give them their own namespace (e.g. an `npc:` prefix), or
 * a client whose identity matches a server key would take the entity over at
 * sync.
 */
export interface SmoothWorld {
	/** The entity's authoritative state, or undefined. Treat as read-only - use `set` to change it. */
	get(key: string): any;
	/** Every entity's `{ key, state }` - the post-drain snapshot of this tick. */
	catalog(): Array<{ key: string; state: any }>;
	/**
	 * REPLACE an entity's state (a teleport, a respawn, a scripted placement):
	 * broadcasts this tick, wakes `onMissing` so simulation continues from the
	 * new state. The discontinuous counterpart of `applyTo`. False for an
	 * unknown key.
	 */
	set(key: string, state: any): boolean;
	/**
	 * Run a command through the shared `apply` (a knockback impulse, damage) -
	 * the same semantics as the shoot context's `applyTo`: no acknowledgement, a
	 * non-commanded update the owner receives. Applies on the NEXT tick
	 * (commands land on drains). False for an unknown key.
	 */
	applyTo(key: string, command: any): boolean;
	/**
	 * Create a SERVER entity - no connection owns it; it starts active so
	 * `onMissing` drives it from its first tick, and it lives until `remove`.
	 * Omitting `initialState` seeds it like a client entity (a warm-handoff
	 * snapshot state when one is pending, else the declared `initial(key)`).
	 * For an existing key this is a read (it never rebinds). Returns the state.
	 */
	ensure(key: string, initialState?: any): any;
	/** Remove an entity with the full departure broadcast. False for an unknown key. */
	remove(key: string): boolean;
}

/** A 2D point in the topic's own position units. */
export interface SmoothPoint {
	x: number;
	y: number;
}

/**
 * Area-of-interest culling config for `live.smooth({ interest })`.
 */
export interface SmoothInterestConfig {
	/** Cull radius, in the topic's position units (required, positive). */
	radius: number;
	/**
	 * Where an entity is, for culling. Return `null` to make it always-visible
	 * (a flag, an objective). Required.
	 */
	position: (state: any) => SmoothPoint | null;
	/**
	 * Ascending level-of-detail bands: within `within` units, send every `rate`
	 * ticks (the outer band's edge is the cull radius). `rate` is an integer >= 1.
	 * Does not apply in cells mode (cell fan-out has no per-subscriber cadence).
	 */
	lod?: Array<{ within: number; rate: number }>;
	/**
	 * Spatial-grid cell size, in position units (positive). Per-client mode: a
	 * tuning knob for the internal cull index. Cells mode: the side length of the
	 * cell topics the world is gridded into. @default 256 in cells mode
	 */
	cell?: number;
	/**
	 * Population-scale mode: area-of-interest becomes SUBSCRIPTION to grid-cell
	 * topics instead of a per-subscriber server-side cull. Each changed entity is
	 * published once to its cell's topic and fans out natively (egress is
	 * O(cells), not O(subscribers)); the server subscribes each socket to the
	 * cell block covering its view. Requires svelte-adapter-uws >= 0.6.0-next.46.
	 * @default false
	 */
	cells?: boolean;
	/**
	 * Server-side gate on reported area-of-interest centers (`view.reportCenter`).
	 * On a server-authoritative game topic an ungated report is a radar cheat: a
	 * modified client can center replication anywhere on the map. `'any'`
	 * (default) keeps reports ungated - the right default for self-selecting
	 * surfaces (cursors, canvases, dashboards). `'own-entity'` clamps any
	 * connection that owns a POSITIONED entity to that entity: its reports are
	 * rejected, a previously-accepted override turns inert the moment the entity
	 * exists, and only a connection with no positioned entity (a spectator /
	 * free-cam, e.g. a state whose `position` resolves null) may report. A
	 * callback decides per report - return `false` to reject, `true` to accept,
	 * or a point to substitute (clamp instead of reject); it must be synchronous,
	 * and a throw or malformed verdict rejects (a broken policy never widens
	 * replication). A rejected report behaves like no report: the own-entity
	 * center applies and any stale override is dropped. Clearing a center (a
	 * null report) is always allowed. Applies identically in per-client and
	 * cells mode, evaluated on the instance that receives the report.
	 * @default 'any'
	 */
	centerPolicy?:
		| 'any'
		| 'own-entity'
		| ((ctx: LiveContext<any>, center: SmoothPoint, ownPos: SmoothPoint | null) => boolean | SmoothPoint);
	/** Reserved per-client bandwidth ceiling - accepted but inert in this version. */
	budget?: number;
}

/**
 * The per-shot context passed to `hitTest.onHit` and `hitTest.resolve`. Built
 * once per shot (not per target); its primitives are authoritative.
 */
export interface SmoothShotCtx {
	/** The shooter's identity key. */
	identity: string;
	/** The composed platform. */
	platform: any;
	/**
	 * Apply a server-initiated command to any entity authoritatively (a hit
	 * dropping a victim's health). The victim still receives the change through the
	 * normal broadcast, so its own prediction is undisturbed. Returns whether the
	 * entity existed.
	 */
	applyTo(victimKey: string, command: any): boolean;
	/**
	 * Signal a discrete one-shot event on the `view.onEvent` channel, broadcast
	 * after the shot resolves. `opts.key` overrides the event key (default: the
	 * shooter's key).
	 */
	emitEvent(type: string, data?: any, opts?: { key?: string }): void;
}

/** A target as handed to `hitTest.onHit` / `hitTest.resolve`, rewound to the shot instant. */
export interface SmoothHitTarget {
	/** The target entity's key. */
	key: string;
	/** The target's rewound position. */
	pos: SmoothPoint;
	/** The target's rewound state (the time-correct stance). */
	state: any;
}

/**
 * Server-rewind lag-compensation config for `live.smooth({ hitTest })`. Requires
 * `interest` in either mode - the shooter's replicated set (per-client relevancy
 * membership, or its cell subscription under `interest.cells`) is the candidate
 * security gate. Provide exactly one narrowphase (`hitbox` or `resolve`).
 */
export interface SmoothHitTestConfig {
	/** The shot ray, resolved from the shooter's command and current state. */
	shot: {
		type: 'ray';
		/** Ray origin in position units. */
		origin: (command: any, state: any) => SmoothPoint;
		/** Ray direction: an angle in radians, or a (non-unit) `{ x, y }` vector. */
		dir: (command: any, state: any) => number | SmoothPoint;
		/** Maximum ray distance (positive). */
		maxDist: number;
	};
	/**
	 * Declarative narrowphase: a circle or an axis-aligned box per target.
	 * Provide this or `resolve`.
	 */
	hitbox?: { shape: 'circle'; radius: number } | { shape: 'aabb'; w: number; h: number };
	/**
	 * Custom narrowphase escape hatch (provide this or `hitbox`). The `shot.dir`
	 * here is a unit vector. Return a hit `{ dist, point }` (finite `dist`) or
	 * `null`/`undefined` for a miss; `target.state` is the time-correct rewound stance.
	 */
	resolve?: (
		shot: { origin: SmoothPoint; dir: SmoothPoint; maxDist: number },
		target: SmoothHitTarget,
		ctx: SmoothShotCtx
	) => { dist: number; point: SmoothPoint } | null | undefined;
	/**
	 * The consequence, run nearest-first for each entity the ray passes through.
	 * Return `{ stop: true }` to stop at the nearest (no penetration). May be async.
	 */
	onHit: (
		ctx: SmoothShotCtx,
		target: SmoothHitTarget,
		info: { dist: number; point: SmoothPoint; fraction: number; rewindAt: number; fallback: boolean }
	) => { stop?: boolean } | void | Promise<{ stop?: boolean } | void>;
	/** Broadphase cull tuning. `cone` is a cosine in `[-1, 1]`. */
	broadphase?: { maxDist?: number; cone?: number };
	/**
	 * Position the rewind and candidate gate read; defaults to `interest.position`.
	 * A custom function in a different coordinate space disables the rewind-instant
	 * candidate gate (it falls back to receipt-time membership).
	 */
	position?: (state: any) => SmoothPoint | null;
	/**
	 * The furthest back any shot may rewind, in milliseconds - the security-critical
	 * defender-protection cap (a latency-faker can at most look like a real player at
	 * this latency). Keep it at or above one interpolation delay (~`2 x tickMs`).
	 * @default 100
	 */
	maxRewindMs?: number;
	/**
	 * Distance guard (position units): abort the rewind for a candidate whose path
	 * jumps more than this across the rewind bracket. Off by default - the always-on
	 * gap guard already covers death/respawn.
	 */
	teleportThreshold?: number;
	/**
	 * Opt-in per-shot observability signal (anti-cheat). Called once per resolved
	 * shot; a throwing hook never affects the shot. Off by default.
	 */
	detectionHook?: (info: {
		identity: string;
		minUplink: number | null;
		maxUplink: number | null;
		reach: number;
		interpDelay: number;
		divergence: number;
	}) => void;
	/**
	 * Opt-in, off by default. A graded benefit-of-the-doubt for a defender that broke
	 * line of sight to the shooter in flight: a candidate visible to the shooter at the
	 * rewind instant but occluded by `min(now, rewindAt + allowanceMs)` (it reached cover
	 * within the window) is dropped from the shot - it cannot be hit. The app owns
	 * occlusion via `exposure(shooterState, targetState)` (the framework has positions, not
	 * visibility). Strictly subtractive: it can only ever turn a hit into a miss, never the
	 * reverse, so it never helps a shooter. A throwing hook fails safe to no grace. Bounded
	 * by `allowanceMs`, so it only relaxes `maxRewindMs` toward the present, never past it.
	 */
	defenderAllowance?: {
		exposure: (shooterState: any, targetState: any) => boolean;
		allowanceMs: number;
	};
}

/**
 * Return type of `live.smooth()`.
 */
export interface SmoothExport {
	__isSmooth: true;
	/** Sync handler: subscribes the socket, ensures the entity, returns the catalog basis. */
	__smoothSync: any;
	/** Command handler: enqueues an owner's command batch for the authoritative tick. */
	__smoothCommand: any;
}

/**
 * Configuration for `live.doc()` / `live.map()` / `live.array()`.
 */
export interface DocConfig {
	/** Topic name, or a function computing it from context and room args. */
	topic: string | ((ctx: any, ...args: any[]) => string);
	/**
	 * Per-connection per-document access. Return a boolean (widened to all
	 * three rights) or a `{read, write, comment}` record; a missing right is
	 * `false`, so `{read: true}` means read-only. Throwing denies like any
	 * guard. The record is cached for the life of the subscription and
	 * re-resolved on every sync, so a downgrade applies at the next sync.
	 * `comment` is carried for the rich-text marks layer and grants nothing
	 * extra yet.
	 */
	guard?: (ctx: any, ...args: any[]) => any;
	/**
	 * Durable persistence hooks - the app owns the I/O, the framework owns
	 * the schedule. `load` returns the stored full-state bytes for a cold
	 * topic (or null for a brand-new document); `store` persists the
	 * compacted full-state bytes. Omit for a purely in-memory document.
	 */
	persist?: {
		load?: (topic: string) => Promise<Uint8Array | number[] | null | undefined> | Uint8Array | number[] | null | undefined;
		store?: (topic: string, bytes: Uint8Array) => Promise<void> | void;
	};
	/** Persist this long after the last edit (ms). @default 2000 */
	debounceWait?: number;
	/** Force a persist at least this often during sustained editing (ms). @default 10000 */
	debounceMaxWait?: number;
	/** Compact (full-state store) every N updates. @default 200 */
	snapshotEvery?: number;
	/** Run a final store when the last subscriber leaves. @default true */
	persistOnEmpty?: boolean;
	/** CRDT garbage collection on the server replica. @default true */
	gc?: boolean;
	/** Observe persist I/O failures (the schedule retries; this is the operator signal). */
	onError?: (err: unknown, info: { topic: string; op: 'load' | 'store' }) => void;
	/** Number of room-identifying args the topic function expects (excluding ctx). @default topicFn.length - 1 */
	topicArgs?: number;
}

/**
 * Return type of `live.doc()` / `live.map()` / `live.array()`.
 */
export interface DocExport {
	__isDoc: true;
	/** Which factory the component-side namespace exposes. */
	__docKind: 'doc' | 'map' | 'array';
	/** Sync handler: runs the guard, loads + subscribes, returns the state-vector exchange. */
	__docSync: any;
	/** Update handler: merges an authorized update and fans it out. */
	__docUpdate: any;
	/** Close handler: releases one mount's replica reference before socket close. */
	__docClose: any;
}

/**
 * Webhook configuration for `live.webhook()`.
 */
export interface WebhookConfig {
	/** Verify the incoming request. Throw to reject. */
	verify(req: { body: string; headers: Record<string, string> }): any;
	/** Transform the verified event. Return null to ignore. */
	transform(event: any): { event: string; data: any } | null;
}

/**
 * Return type of `live.webhook()`.
 */
export interface WebhookHandler {
	__isWebhook: true;
	/** Handle an incoming webhook request. */
	handle(req: { body: string; headers: Record<string, string>; platform: Platform }): Promise<{ status: number; body?: string }>;
}

/**
 * Configuration for `live.webhooks.outbound()`.
 */
export interface OutboundWebhookConfig {
	/**
	 * Destination URL, or a function computing it per event. SSRF-checked
	 * (strict by default): a static url is validated at definition time, a
	 * dynamic url at fire time.
	 */
	url: string | ((event: string, data: any) => string | Promise<string>);
	/**
	 * Build the POST body from the event. Return `null`/`undefined` to skip
	 * sending. Default: `{ event, data }`.
	 */
	transform?: (event: string, data: any) => any;
	/**
	 * HMAC-SHA256 secret. When set, each request carries
	 * `x-webhook-signature: sha256=<hex>` over the body so the receiver can
	 * authenticate it.
	 */
	secret?: string;
	/**
	 * Override the `idempotency-key` header. Default: a content hash of
	 * `(topic, event, body)`, stable across retries and a leader-transition
	 * double-fire so receivers can dedup to effectively-once.
	 */
	idempotencyKey?: (event: string, data: any) => string;
	/** Retry policy. Default: 3 attempts, 100ms initial backoff, x2, 5s cap. */
	retry?: {
		attempts?: number;
		initialDelayMs?: number;
		maxDelayMs?: number;
		backoffMultiplier?: number;
	};
	/**
	 * Absolute per-attempt timeout in milliseconds, covering DNS, connect, TTFB
	 * and body. @default 10000
	 */
	timeoutMs?: number;
	/**
	 * Maximum number of redirect hops to follow. Every hop is re-run through the
	 * full SSRF gate (scheme + range + DNS-pin), so a redirect to a private host,
	 * a non-http(s) scheme, an https->http downgrade, a loop, or hop-cap overflow
	 * ends delivery with a reported failure. Set `0` to refuse all redirects.
	 * @default 5
	 */
	maxRedirects?: number;
	/**
	 * Per-callback timeout in milliseconds for `transform` / the dynamic `url` /
	 * `validateUrl` / `resolve` / `idempotencyKey`, so a hung callback cannot
	 * pile up pending deliveries. @default 10000
	 */
	callbackTimeoutMs?: number;
	/**
	 * SSRF posture for the built-in guard.
	 * - `'strict'` (default): block private/loopback/metadata literals, resolve
	 *   every DNS name and block if any address is private, and pin the
	 *   connection to the validated address (closing DNS rebinding).
	 * - `'allowlist'`: as strict, plus the hostname must be in `allow`.
	 * - `'off'`: skip the range checks and the DNS pin (the http(s) scheme gate
	 *   still applies) - the explicit, reviewable opt-out for a trusted endpoint.
	 * @default 'strict'
	 */
	urlMode?: 'strict' | 'allowlist' | 'off';
	/** Allowlisted hostnames when `urlMode: 'allowlist'`. */
	allow?: string[];
	/**
	 * Additional URL restriction, applied as a logical AND on top of the
	 * built-in guard on the initial URL and on every redirect hop. It can only
	 * NARROW the allowed set, never widen it: returning `true` does not re-open a
	 * host the range check blocked. May be async (it is awaited). To reach a
	 * specific private endpoint, pair `urlMode: 'off'` (which relaxes the ranges)
	 * with a `validateUrl` that allows exactly that host.
	 */
	validateUrl?: (url: string) => boolean | Promise<boolean>;
	/**
	 * Custom DNS resolver for the SSRF pin (strict/allowlist mode), receiving the
	 * hostname and returning one address or an array of addresses. Defaults to
	 * `node:dns` lookup of all addresses. Every resolved address is range-checked
	 * and the connection is pinned to it, so supplying a hardened resolver (or
	 * one that returns a private address) is how DNS rebinding is defended and
	 * tested.
	 */
	resolve?: (hostname: string) => string | string[] | Promise<string | string[]>;
	/**
	 * Called when delivery fails (after retries are exhausted, or on a blocked
	 * URL / bad payload / blocked redirect). `attempts` is how many HTTP attempts
	 * were made. The error never contains the secret, the signature, or URL
	 * credentials. May return a promise (it is detached, not awaited).
	 */
	onFailure?: (err: Error, event: string, data: any, attempts: number) => void | Promise<void>;
}

/**
 * Return type of `live.webhooks.outbound()` (an opaque server-only marker;
 * nothing is generated for the client).
 */
export interface OutboundWebhookHandler {
	__isWebhookOut: true;
}

/**
 * A stream transform step created by `pipe.filter`, `pipe.sort`, etc.
 * Each step contributes a `transformInit(data, ctx)` function that runs
 * once per subscription against the loader's initial data. For per-event
 * projection, use the `transform` option on `live.stream({ transform })`.
 */
export interface PipeTransform {
	transformInit?(data: any[], ctx: LiveContext<any>): any[] | Promise<any[]>;
}

/**
 * Compose stream transforms that apply to the initial data load. For
 * per-event projection on live publishes, use the `transform` option on
 * `live.stream({ transform })` instead.
 *
 * @param stream - The stream function to wrap
 * @param transforms - Transform steps
 *
 * @example
 * ```js
 * export const notifications = pipe(
 *   live.stream('notifications', async (ctx) => db.notifications.all()),
 *   pipe.filter((ctx, item) => !item.dismissed),
 *   pipe.sort('createdAt', 'desc'),
 *   pipe.limit(20)
 * );
 * ```
 */
export function pipe<T extends Function>(stream: T, ...transforms: PipeTransform[]): T;
export namespace pipe {
	/** Filter items from initial data. Does NOT apply to live events. */
	function filter(predicate: (ctx: LiveContext<any>, item: any) => boolean): PipeTransform;
	/** Sort initial data by a field. */
	function sort(field: string, direction?: 'asc' | 'desc'): PipeTransform;
	/** Cap initial data to N items. */
	function limit(n: number): PipeTransform;
	/** Enrich each item by resolving a field via an async function. */
	function join(field: string, resolver: (value: any) => Promise<any>, as: string): PipeTransform;
}

/**
 * Create a per-module guard that runs before every `live()` in the same module.
 *
 * Accepts middleware functions (variadic) and/or a single declarative
 * options object as the first argument:
 *
 * - `{ authenticated: true }` - throws `UNAUTHENTICATED` unless
 *   `ctx.user` is non-null. Cheaper to write than the equivalent
 *   function and harder to forget.
 *
 * Function-style middleware composes: `guard({ authenticated: true }, customCheck)`
 * runs the auth check first, then `customCheck(ctx)`. If any throws,
 * the chain stops.
 *
 * Bare `Error`s thrown from a guard are auto-classified to a typed
 * `LiveError`: `UNAUTHENTICATED` when `ctx.user` is null, `FORBIDDEN`
 * otherwise. Throw `new LiveError('FORBIDDEN', '...')` directly when
 * you want a specific code or message.
 *
 * @example
 * ```js
 * // Declarative
 * export const _guard = guard({ authenticated: true });
 *
 * // Imperative
 * export const _guard = guard((ctx) => {
 *   if (!ctx.user) throw new Error('login required');                            // -> UNAUTHENTICATED
 *   if (ctx.user.role !== 'admin') throw new LiveError('FORBIDDEN', 'Admin only');
 * });
 *
 * // Composed
 * export const _guard = guard(
 *   { authenticated: true },
 *   (ctx) => { if (ctx.user.role !== 'admin') throw new LiveError('FORBIDDEN'); }
 * );
 * ```
 */
export function guard(
	...parts: Array<((ctx: LiveContext<any>) => void | Promise<void>) | { authenticated?: boolean }>
): (ctx: LiveContext<any>) => void | Promise<void>;

/**
 * Typed error that propagates `code` and `message` to the client.
 * Use this for expected errors (auth failures, validation, etc.).
 * Raw `Error` throws are caught and replaced with a generic `INTERNAL_ERROR`,
 * EXCEPT when thrown from a guard - those are auto-classified
 * (see `guard()`).
 *
 * The framework recognises and emits these standard codes:
 *
 * - `UNAUTHENTICATED` - caller has no user identity. From guards or
 *   access predicates failing with `ctx.user == null`.
 * - `FORBIDDEN` - caller is identified but lacks permission. From guards
 *   or access predicates failing with `ctx.user != null`.
 * - `RATE_LIMITED` - request rejected by `live.rateLimit({...})`.
 * - `VALIDATION` - input rejected by `live.validated(schema, ...)`.
 * - `OVERLOADED` - subscribe rejected by `live.stream({ classOfService })`
 *   under pressure.
 * - `CONFLICT` - a request with the same idempotency key is already
 *   in flight (multi-instance store only).
 * - `SERVICE_UNAVAILABLE` - circuit breaker open.
 * - `NOT_FOUND` - live function not registered at the requested path,
 *   or `live.push({ userId })` cannot find an active connection.
 * - `TIMEOUT` - `live.push` did not receive a reply within `timeoutMs`.
 * - `INVALID_REQUEST` - malformed envelope or args.
 * - `INVALID_TOPIC` - `ctx.publish()` called with a `__`-prefixed topic
 *   (those are reserved for framework-internal channels; use
 *   `ctx.platform.publish` directly if you genuinely need to broadcast
 *   on one).
 * - `INTERNAL_ERROR` - non-LiveError throw from a handler (NOT a guard).
 *
 * Code strings are user-extensible - throw your own (e.g. `INSUFFICIENT_FUNDS`)
 * and the client receives them as-is via `RpcError.code`.
 */
export class LiveError extends Error {
	code: string;
	constructor(code: string, message?: string);
}

/**
 * Check whether a raw WebSocket message is an RPC request and handle it.
 *
 * Returns `true` if the message was an RPC request (handled), `false` otherwise
 * (pass through to your own logic).
 *
 * @param ws - The WebSocket connection
 * @param data - Raw message data from the adapter's message hook
 * @param platform - The platform API
 * @param options - Optional hooks (beforeExecute)
 *
 * @example
 * ```js
 * export function message(ws, { data, platform }) {
 *   if (handleRpc(ws, data, platform)) return;
 *   // custom non-RPC handling here
 * }
 * ```
 */
export function handleRpc(
	ws: WebSocket<any>,
	data: ArrayBuffer,
	platform: Platform,
	options?: HandleRpcOptions
): boolean;

/**
 * Ready-made message hook for zero-config RPC routing.
 *
 * Signature matches the adapter's `message` hook exactly.
 * Just re-export it from your `hooks.ws.js`.
 *
 * @example
 * ```js
 * export { message } from 'svelte-realtime/server';
 * ```
 */
export function message(
	ws: WebSocket<any>,
	ctx: { data: ArrayBuffer; isBinary?: boolean; platform: Platform }
): void;

/**
 * Create a custom message hook with options baked in.
 *
 * @example
 * ```js
 * export const message = createMessage({
 *   platform: (p) => bus.wrap(p),
 *   async beforeExecute(ws, rpcPath) {
 *     const { allowed } = await limiter.consume(ws);
 *     if (!allowed) throw new LiveError('RATE_LIMITED', 'Too many requests');
 *   }
 * });
 * ```
 */
export function createMessage(
	options?: CreateMessageOptions
): (ws: WebSocket<any>, ctx: { data: ArrayBuffer; isBinary?: boolean; platform: Platform }) => void;

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
 * @example
 * ```js
 * // +page.server.js
 * import { auditFeed, presence, reactions } from '$live/dashboard';
 *
 * export async function load({ locals, platform }) {
 *   const [audit, presenceData, reacts] = await Promise.all([
 *     auditFeed.load(platform, {
 *       user: locals.user,
 *       args: [locals.user.organization_id],
 *       fallback: [],
 *       onError: (err) => locals.log.error({ err }, 'audit feed SSR failed')
 *     }),
 *     presence.load(platform, { user: locals.user, fallback: {} }),
 *     reactions.load(platform, { user: locals.user, fallback: [] })
 *   ]);
 *   return { audit, presenceData, reacts };
 * }
 * ```
 *
 * @param path - RPC path (e.g. 'chat/messages')
 * @param args - Arguments to pass (excluding ctx)
 * @param platform - The platform API
 * @param options - Optional config: user, fallback, onError
 *
 * @internal
 */
export function __directCall(
	path: string,
	args: any[],
	platform: Platform,
	options?: {
		user?: any;
		args?: any[];
		/**
		 * Value to return if the loader throws. Presence of the key opts
		 * into fallback behavior (the value itself can be anything,
		 * including null / undefined / arrays / objects).
		 */
		fallback?: any;
		/**
		 * Called with the caught error before the fallback is returned.
		 * Errors thrown by `onError` itself are silently swallowed so
		 * an observer hook never breaks SSR.
		 */
		onError?: (err: any) => void;
	}
): Promise<any>;

/**
 * Capture a platform reference for cron jobs.
 *
 * **Recommended call site (svelte-adapter-uws >= 0.5.0-next.15):** the
 * `init({ platform })` hook in `hooks.ws.js`. The adapter fires `init`
 * exactly once per worker after the listen socket is bound and before
 * any `upgrade` / `open` / `message` hook runs, so the cron tick has a
 * platform from the very first scheduled fire.
 *
 * **Legacy / fallback call site:** the `open(ws, platform)` hook. Works
 * but the platform is only captured on the first WebSocket connection,
 * so cron ticks during the boot-to-first-connect window are no-ops and
 * surface a single (deduped) warning.
 *
 * In clustered deployments, every worker captures its own platform
 * independently. To get single-fire-across-the-cluster semantics for
 * cron jobs, also wire a leader gate via
 * `configureCron({ leader })`.
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
 * export function init({ platform }: { platform: Platform }) {
 *     setCronPlatform(platform);
 * }
 * ```
 */
export function setCronPlatform(platform: Platform): void;

/**
 * Configure cron behavior across the cluster.
 *
 * The `leader` field is the cluster-mode opt-in. Without it, every
 * worker fires every registered cron job on every matching tick (the
 * single-process default; correct for dev and non-clustered apps). With
 * it, only the worker whose `leader()` returns `true` for a given tick
 * proceeds to evaluate per-job schedules and fire jobs.
 *
 * `leader` is called synchronously at the top of every cron tick and
 * must be cheap (a cached boolean read). The canonical implementation
 * lives in `svelte-adapter-uws-extensions/redis/leader`, which
 * maintains a Redis SETNX lease in the background and exposes the
 * cached state as `leader.isLeader`. svelte-realtime intentionally does
 * not bundle the leader implementation; the cluster transport (Redis
 * or otherwise) is the extensions package's domain.
 *
 * Pass `null` (in place of the whole config object) to clear the
 * leader and revert to "every worker fires" behavior.
 *
 * Failure modes:
 * - `leader()` throwing is treated as fail-closed: this worker skips
 *   the tick and a metric `cron{status:'leader-error'}` increments,
 *   plus a `console.error` line in dev. Better to miss a tick than to
 *   double-fire because the leader-election machinery is broken.
 * - `leader()` returning a non-boolean falsy value (e.g. `undefined`)
 *   is treated as "not leader" - skip the tick.
 *
 * **Cluster fan-out (`bus`).** With a leader configured, only the
 * elected worker fires. By default that publish reaches uWS subscribers
 * on the leader's worker only - subscribers on other instances see
 * nothing because no other worker independently produced the publish.
 * The `bus` option plugs in the extensions-package pubsub bus
 * (`svelte-adapter-uws-extensions/redis/pubsub` or
 * `redis/sharded-pubsub`) so the leader's cron publishes relay to
 * every cluster instance. Each cron fire wraps the captured platform
 * with `bus.wrap(platform)` for both the auto-publish path AND the
 * cron handler's `ctx.publish`. Mirror of
 * `live.configurePush({ remoteRegistry })`. svelte-realtime stays
 * cluster-transport-agnostic; the bus type is structural
 * (`{ wrap(platform): wrapped }`) - any pubsub primitive that exposes
 * a wrap method works.
 *
 * Setting `leader` without `bus` emits a single dev warning at
 * `configureCron` time pointing at this footgun: cluster intent
 * declared, cluster fan-out missing.
 *
 * @example
 * ```js
 * // src/hooks.ws.js (adapter next.15+, clustered deployment)
 * import { setCronPlatform, configureCron } from 'svelte-realtime/server';
 * import { createLeader } from 'svelte-adapter-uws-extensions/redis/leader';
 * import { createPubSubBus } from 'svelte-adapter-uws-extensions/redis/pubsub';
 *
 * const leader = createLeader(redis);
 * const bus = createPubSubBus(redis);
 *
 * export async function init({ platform }: { platform: Platform }) {
 *     await bus.activate(platform);
 *     setCronPlatform(platform);
 *     configureCron({ leader: leader.isLeader, bus });
 * }
 *
 * export async function shutdown() {
 *     await leader.stop();
 *     await bus.deactivate();
 * }
 * ```
 */
export function configureCron(
	config:
		| {
			leader?: (() => boolean) | null;
			bus?: { wrap(platform: any): any } | null;
		}
		| null
): void;

/**
 * Opaque-to-the-store resolver metadata persisted with an alarm so a cross-restart
 * recovery poll can re-find its handler (`path` is the stream's RPC registry key;
 * the in-memory `onAlarm` closure is gone after a restart). The store treats it as
 * an opaque blob.
 */
export interface AlarmMeta {
	path?: string;
	tenantId?: string | null;
}

/** A due alarm returned by `AlarmStore.due(nowMs)` for the recovery poll. */
export interface AlarmDue {
	topic: string;
	at: number;
	meta?: AlarmMeta | null;
}

/**
 * A durable alarm store backing `live.alarm` across restarts + a cluster. The
 * in-memory default uses live process timers (an alarm survives the room going
 * idle within the process, but not a restart); a durable store persists
 * `{topic, at, meta}` so an alarm survives a restart and - paired with a `leader` -
 * fires exactly once cluster-wide. The Postgres / Redis implementations live in
 * `svelte-adapter-uws-extensions` (`createAlarmStore`).
 */
export interface AlarmStore {
	/** Persist (or replace) the alarm for `topic`, due at epoch-ms `at`. */
	set(topic: string, at: number, meta?: AlarmMeta | null): void | Promise<void>;
	/**
	 * Remove the alarm for `topic`. Returns whether THIS call removed a present row -
	 * the atomic claim that guarantees single-fire between the precise in-memory timer
	 * and the recovery poll. (`void` is treated as a successful claim for back-compat.)
	 */
	delete(topic: string): boolean | void | Promise<boolean | void>;
	/**
	 * Optional. Return the alarms whose `at <= nowMs` (the recovery poll reads this on
	 * the leader to fire alarms an instance left behind when it restarted before its
	 * in-memory timer ran). Omit it and cross-restart recovery is disabled; in-memory
	 * timers still fire while the process lives.
	 */
	due?(nowMs: number): AlarmDue[] | Promise<AlarmDue[]>;
}

/**
 * Configure `live.alarm`. `store` plugs a durable cluster store into the seam so
 * alarms survive a restart; `leader` gates firing to one instance (so an alarm
 * fires exactly once cluster-wide), mirroring `configureCron({ leader })`; `pollMs`
 * (default 15000) sets the recovery-poll cadence. All optional. Pass `null` to
 * clear store + leader and reset the cadence. With neither store nor leader,
 * `live.alarm` runs single-instance in-memory - correct for dev and a single box.
 */
export function configureAlarm(
	config:
		| {
			store?: AlarmStore | null;
			leader?: (() => boolean) | null;
			pollMs?: number;
		}
		| null
): void;

/**
 * The resolved result of a `live.forget` cascade.
 */
export interface ForgetResult {
	/**
	 * Always `true` on a completed cascade. A constant-shape field so the result
	 * cannot be turned into a user-existence oracle by a caller who re-exposes it.
	 */
	ok: true;
	/** Wall-clock ms the cascade resolved (routed through the runtime seam). */
	at: number;
	/**
	 * Total entries/rows removed across every in-memory surface plus the durable
	 * store. Zero when the user had no data. Returned to the trusted server
	 * caller; map to a constant shape before exposing to untrusted clients.
	 */
	rowsAffected: number;
	/** Per-surface removal counts (in-memory descriptors plus `durable`). */
	surfaces: Record<string, number>;
}

/**
 * Durable right-to-erasure store: erases a user's durable cluster rows. The
 * extensions `createForgetStore(...)` builds one; the realtime layer never
 * imports it - it only duck-types `purgeUser`.
 */
export interface ForgetStore {
	purgeUser(tenantId: string | null, userId: string, cascade: any): Promise<number | Record<string, number>>;
}

/**
 * Configure `live.forget`. `store` plugs a durable cluster store into the
 * erasure cascade (its `purgeUser` runs after the in-memory surfaces and the
 * promise waits for it); `platform` supplies the Redis handle the presence purge
 * needs to decrement the cluster roster. Both optional. Pass `null` to clear
 * both. With neither, `live.forget` purges in-memory state only - correct for a
 * single instance.
 */
export function configureForget(
	config:
		| {
			store?: ForgetStore | null;
			platform?: any;
		}
		| null
): void;

/**
 * Register a live function. Called by the Vite-generated registry module.
 * @internal
 */
export function __register(path: string, fn: Function, modulePath?: string): void;

/**
 * Register a module guard. Called by the Vite-generated registry module.
 * @internal
 */
export function __registerGuard(modulePath: string, fn: Function): void;

/**
 * Register a cron job. Called by the Vite-generated registry module.
 * @internal
 */
export function __registerCron(path: string, fn: Function): void;

/**
 * Register a derived stream. Called by the Vite-generated registry module.
 * @internal
 */
export function __registerDerived(path: string, fn: Function): void;

/**
 * Register an effect. Called by the Vite-generated registry module.
 * @internal
 */
export function __registerEffect(path: string, fn: Function): void;

/**
 * Register an aggregate. Called by the Vite-generated registry module.
 * @internal
 */
export function __registerAggregate(path: string, fn: Function): void;

/**
 * Install a flag's refresh watcher eagerly at registry-module load, keyed by
 * topic, so a server-side `.get()` reflects cluster-latest sets from boot
 * without waiting for the flag module's first local import. Called by the
 * Vite-generated registry module.
 * @internal
 */
export function __registerFlag(topic: string, initialValue?: any): void;

/**
 * Register room actions lazily. Called by the Vite-generated registry module.
 * @internal
 */
export function __registerRoomActions(basePath: string, loader: Function): void;

/**
 * Activate derived stream listeners after platform is available.
 * Wraps `platform.publish` to detect source topic events and trigger recomputation.
 */
export function _activateDerived(platform: Platform): void;

/**
 * Clear all cron timers and registry entries.
 * Called during HMR to prevent orphan intervals.
 */
export function _clearCron(): void;

/**
 * Run all matching cron jobs for the current minute. Exported for testing.
 */
export function _tickCron(): Promise<void>;

/**
 * Set a global error handler for server-side errors (cron, effects, derived).
 * Without this, errors are logged in dev and silently swallowed in production.
 *
 * @param handler - Receives the path and the thrown error
 *
 * @example
 * ```js
 * onError((path, error) => {
 *   sentry.captureException(error, { tags: { live: path } });
 * });
 * ```
 */
export function onError(handler: (path: string, error: unknown) => void): void;

/** @deprecated Use `onError()` instead. */
export function onCronError(handler: (path: string, error: unknown) => void): void;

/**
 * Subscribe a WebSocket to its user's signal topic.
 * Call in your `open` hook to enable signal delivery.
 *
 * @example
 * ```js
 * import { enableSignals } from 'svelte-realtime/server';
 * export function open(ws) { enableSignals(ws); }
 * ```
 */
export function enableSignals(ws: WebSocket<any>, options?: { idField?: string }): void;

/**
 * Handle a real-time topic unsubscribe event. Fires onUnsubscribe lifecycle
 * hooks for the stream function that owns the topic.
 *
 * Re-export from your `hooks.ws.js`:
 * ```js
 * export { unsubscribe } from 'svelte-realtime/server';
 * ```
 */
export function unsubscribe(
	ws: WebSocket<any>,
	topic: string,
	ctx: { platform: Platform }
): void;

/**
 * Handle a WebSocket close event. Drains stream-subscription bookkeeping
 * (per-topic ws-counts, silent-topic watchdogs), fires `onUnsubscribe`
 * lifecycle hooks for stream functions that define them, AND drains the
 * per-userId push registry. A single re-export from `hooks.ws.js` covers
 * both stream and push cleanup; no separate `pushHooks.close` wiring is
 * needed.
 *
 * Re-export from your `hooks.ws.js`:
 * ```js
 * export { close } from 'svelte-realtime/server';
 * ```
 *
 * Or, if you already wire `pushHooks.close` (which now routes through
 * this same function under the hood), keep that - both shapes work
 * and produce identical cleanup.
 */
export function close(
	ws: WebSocket<any>,
	ctx: { platform: Platform; subscriptions?: Set<string> | string[] }
): void;

// ---------------------------------------------------------------------------
// Cluster wiring + realtime() convenience factory
// ---------------------------------------------------------------------------

/**
 * Cluster bus contract. Any object exposing `wrap(platform)` matches.
 * The canonical implementation is `redisBus()` from
 * `svelte-adapter-uws-extensions/redis/pubsub`; sharded-pubsub and
 * test buses conform to the same shape.
 */
export interface ClusterBus {
	wrap(platform: Platform): Platform;
}

/**
 * Configure the process-wide cluster bus. One declaration of cluster
 * intent reaches every framework publish surface in lockstep: RPC
 * `ctx.publish` (auto-wrapped by `message` / `createMessage`), cron
 * tick publishes, the reactive watcher publish wrap (`live.effect`,
 * `live.derived`, `live.aggregate`, `live.webhook`), and the top-level
 * `publish()` helper.
 *
 * Pass `null` to clear and revert to single-replica behaviour.
 *
 * `configureCron({ bus })` is equivalent for the bus field - they
 * write the same backing state. Most apps reach for
 * `realtime({ bus, leader })` instead and never call this directly.
 */
export function setBus(bus: ClusterBus | null): void;

/** Read the process-wide bus, or `null` when none is configured. */
export function getBus(): ClusterBus | null;

/**
 * Read the framework-owned composed platform - the same reference
 * handed to every reactive handler. Returns `null` before the adapter's
 * `init({ platform })` hook has captured it on this worker.
 */
export function getPlatform(): Platform | null;

/**
 * Publish from outside a framework handler (e.g. a `+server.js` HTTP
 * handler). Routes through the composed platform so the publish reaches
 * every local subscriber, fires every reactive watcher, and relays to
 * other cluster instances when a bus is wired. Throws when called
 * before the platform has been captured.
 */
export function publish(topic: string, event: string, data?: unknown, options?: unknown): void;

/**
 * Configuration accepted by `realtime()`.
 */
export interface RealtimeConfig {
	/**
	 * Cluster bus. Pass `redisBus()` or any object exposing
	 * `wrap(platform)` to enable cluster fan-out. Omit (or pass `null`)
	 * for single-replica.
	 */
	bus?: ClusterBus | null;
	/**
	 * Cluster leader gate for cron's "exactly once across the cluster"
	 * semantics. Pass `redisLeader().isLeader` (or any function returning
	 * the current leader status). Omit for single-replica or for the
	 * "every worker fires" default.
	 */
	leader?: (() => boolean) | null;
	/**
	 * Optional `upgrade` hook handed straight back out as part of the
	 * returned hook set. Lets you write a single one-import-one-
	 * destructure `hooks.ws.js`. Omit and export your own `upgrade`
	 * separately if you prefer.
	 */
	upgrade?: (...args: any[]) => any;
	/**
	 * Optional error handler for cron / effect / derived failures.
	 * Equivalent to calling `onError(handler)`.
	 */
	onError?: (path: string, error: unknown) => void;
	/**
	 * Opt-in multi-tenancy resolver. Maps the authenticated user
	 * (`ws.getUserData()`) to a server-trusted tenant id, or `null`/`undefined`
	 * for an unscoped connection. When set, the framework derives `ctx.tenantId`
	 * and auto-scopes every topic and key so two tenants can never share a stream,
	 * roster, room, document, idempotency slot, lock, rate-limit bucket, or signal.
	 * The id is validated to `[a-zA-Z0-9_-]` (<= 64 chars) and is NEVER read off the
	 * wire. Omit for the single-tenant, zero-cost default.
	 */
	tenant?: ((user: any) => string | null | undefined) | null;
	/**
	 * Opt-in admin / observability plane. When set, `realtime()` returns an
	 * `admin(request)` handler (a Web `Request` -> `Response` router) for the
	 * reserved `/__realtime/*` path - today `GET /__realtime/introspect` serves the
	 * {@link introspect} snapshot (with `?handlers=true` / `?topics=true` opt-ins).
	 *
	 * The route is **fail-closed**: with no `admin` configured there is no handler
	 * at all, and when configured EVERY request runs `requires(request)` before any
	 * data is gathered - only a strict `true` admits (a non-true return or a thrown
	 * error denies with 403). Mount the handler yourself (a SvelteKit `+server.js`
	 * re-exporting it) or let the adapter wire the reserved path to it.
	 */
	admin?: { requires: (request: Request) => boolean | Promise<boolean> } | null;

	/**
	 * Outbound-webhook plane. `webhooks.deadLetter` enables the dead-letter store
	 * that retains UNDELIVERABLE outbound-webhook events (retry-exhausted,
	 * SSRF-blocked, etc.) for admin inspection and replay, instead of reporting
	 * then dropping them. Off by default (a DLQ retains attacker-influenced event
	 * data). `true` uses the default in-memory store; a store instance gives a
	 * cluster shared durable store; `false`/`null` disables. Equivalent to
	 * `configureWebhooks({ deadLetter })`.
	 */
	webhooks?: { deadLetter?: boolean | DeadLetterStore | null } | null;
	/**
	 * Opt-in protocol/contract version, an integer the app bumps only on a BREAKING
	 * wire/contract change. Declare it identically here and in client `configure({
	 * protocolVersion })` (one shared constant). A connecting client advertises its
	 * baked version; when this server's version is higher (an older, incompatible
	 * client bundle running against a freshly-deployed server), that one connection
	 * receives a `protocol-stale` notice so it can prompt a reload. Unset (default)
	 * leaves the signal off entirely.
	 */
	protocolVersion?: number;
}

/** A retained, undeliverable outbound-webhook event. */
export interface DeadLetterRecord {
	/** Monotonic per-store record id. */
	id: string;
	/** The outbound-webhook registration path (used to replay it). */
	webhookId: string;
	/** The source topic whose publish triggered the webhook. */
	topic: string;
	/** The event name. */
	event: string;
	/** The original event payload (needed to replay). */
	data: unknown;
	/** Delivery attempts made (0 = a config / gate failure, never sent). */
	attempts: number;
	/** The redacted terminal error message. */
	error: string;
	/** Wall-clock ms when the delivery gave up. */
	failedAt: number;
}

/** Storage interface for dead-lettered outbound-webhook events. */
export interface DeadLetterStore {
	add(rec: Omit<DeadLetterRecord, 'id'>): string;
	get(id: string): DeadLetterRecord | null;
	remove(id: string): boolean;
	count(filter?: { topic?: string }): number;
	list(filter?: { topic?: string; limit?: number }): DeadLetterRecord[];
	summary(): { total: number; byTopic: Record<string, number>; oldest: number | null; newest: number | null };
	clear(): void;
}

/**
 * Create the default in-memory dead-letter store: a bounded, insertion-ordered
 * ring with an optional TTL. A cluster deployment substitutes a durable store
 * (Redis / Postgres) exposing the same interface.
 */
export function createDeadLetterStore(options?: { max?: number; ttlMs?: number }): DeadLetterStore;

/**
 * Configure the outbound-webhook plane. `deadLetter: true` enables the default
 * in-memory dead-letter store; a store instance wires a custom/cluster store;
 * `false`/`null` disables capture (the default). Also wired from
 * `realtime({ webhooks })`.
 */
export function configureWebhooks(config?: { deadLetter?: boolean | DeadLetterStore | null }): void;

/** The configured dead-letter store, or `null` when capture is off. */
export function getDeadLetter(): DeadLetterStore | null;

/**
 * Replay dead-lettered outbound-webhook events. Re-attempts delivery for each
 * matching record via its original webhook (by id); a successful re-fire removes
 * the record. `dryRun` reports what would replay (and whether each webhook is
 * still registered) without sending or removing.
 */
export function replayDeadLetter(opts?: { topic?: string; ids?: string[]; dryRun?: boolean }): Promise<{
	dryRun: boolean;
	total: number;
	replayed: number;
	removed: number;
	results: Array<{ id: string; ok: boolean; status: string; error?: string }>;
}>;

/**
 * Shape returned by `realtime()`. Spread into `hooks.ws.js` exports.
 * `upgrade` is present only when the caller passed one in the config.
 */
export interface RealtimeHooks {
	open(ws: any, ctx: { platform: Platform }): void;
	close(ws: any, ctx: { platform: Platform; subscriptions?: Set<string> | string[] }): void;
	message(ws: any, ctx: { data: ArrayBuffer; platform: Platform }): void;
	init(ctx: { platform: Platform }): void;
	/**
	 * Graceful shutdown. The adapter calls this once on SIGTERM, before it
	 * closes the listen socket and flushes the open WebSockets. Drains
	 * in-flight RPC / SSR / cron work (rejecting new calls with `UNAVAILABLE`)
	 * up to the `onShutdown` drain budget, then runs registered `onShutdown`
	 * handlers in order. Idempotent; zero-config (drains even with no handler).
	 */
	shutdown(ctx: { platform: Platform }): Promise<void>;
	upgrade?: (...args: any[]) => any;
	/**
	 * Admin / observability request handler (a Web `Request` -> `Response` router
	 * for `/__realtime/*`). Present only when the caller passed `admin` in the
	 * config. Fail-closed: every request runs the configured `requires` auth check
	 * before any data is gathered.
	 */
	admin?: (request: Request) => Promise<Response>;
}

/**
 * One-call setup that wires every framework seam from a single
 * declaration of cluster intent. Returns the standard adapter hook
 * set so `hooks.ws.js` is a one-import-one-destructure file.
 *
 * Single-replica:
 * ```js
 * import { realtime } from 'svelte-realtime/server';
 * export const { open, close, message, init, shutdown } = realtime();
 * export function upgrade({ cookies }) { ... }
 * ```
 *
 * Cluster:
 * ```js
 * import { realtime } from 'svelte-realtime/server';
 * import { redisBus, redisLeader } from 'svelte-adapter-uws-extensions/redis';
 * export const { open, close, message, init, shutdown } = realtime({
 *   bus: redisBus(),
 *   leader: redisLeader().isLeader,
 * });
 * export function upgrade({ cookies }) { ... }
 * ```
 *
 * Handler-level code is byte-identical between the two modes; the only
 * difference is whether `bus` and `leader` are passed at the top.
 */
export function realtime(config?: RealtimeConfig): RealtimeHooks;

/**
 * Register a teardown handler run during graceful shutdown, after in-flight
 * work has drained. Handlers run in registration order and receive the same
 * `{ platform }` the adapter passes the `shutdown` hook. A throwing handler is
 * logged and ignored so one failure cannot abort the rest. Use this for
 * app-level teardown that the framework owns the timing of - releasing a
 * leader lease, deactivating a cluster bus, flushing a buffer:
 *
 * ```js
 * // src/hooks.ws.js
 * import { realtime, onShutdown } from 'svelte-realtime/server';
 * export const { open, close, message, init, shutdown } = realtime({ bus, leader: leader.isLeader });
 * onShutdown(async () => { await leader.stop(); await bus.deactivate(); }, { drainMs: 3000 });
 * ```
 *
 * `drainMs` is the in-flight drain budget before handlers run (the largest
 * across all registrations wins; default 5000ms). Keep it well under the
 * adapter's `SHUTDOWN_TIMEOUT` (default 30s), which is the hard cap.
 *
 * @returns an unregister function.
 */
export function onShutdown(
	handler: (ctx: { platform: Platform }) => void | Promise<void>,
	options?: { drainMs?: number }
): () => void;

/**
 * A structured, PII-free snapshot of the server's live dispatch state - counts
 * and code structure only (no user identifiers, no presence rosters). Returned
 * by {@link introspect}. The admin route (`/__realtime`) serves this behind a
 * mandatory auth gate; the primitive itself is usable standalone.
 */
export interface RealtimeIntrospection {
	/** True once a graceful shutdown drain has started. */
	shuttingDown: boolean;
	/** Server handlers currently settling (RPC / cron in flight). */
	inFlight: number;
	handlers: {
		/** Total registered live.X handlers. */
		total: number;
		/** Base-kind counts (mutually exclusive; `lazy` = not yet resolved). */
		byKind: { rpc: number; stream: number; channel: number; upload: number; binary: number; lazy: number } | null;
		/** Overlay-flag counts (a handler can carry several). */
		modifiers: { deprecated: number; rateLimited: number; idempotent: number; volatile: number } | null;
		/** Registered handler paths - only present when called with `{ handlers: true }`. */
		paths?: string[];
	};
	topics: {
		/** Topics with at least one subscriber. */
		active: number;
		/** Total subscriber count across all topics. */
		subscribers: number;
		/** Top 20 topics by subscriber count - only present when called with `{ topics: true }`. */
		top?: Array<{ topic: string; subscribers: number }>;
	};
	/**
	 * Transport-layer snapshot from the adapter platform (connection count,
	 * backpressure posture, protection level, payload cap, invariant counters).
	 * PII-free, always included when the adapter provides `platform.introspect`;
	 * `null` on older adapters or before `init({ platform })` ran.
	 */
	transport: {
		connections: number;
		closedWsAborts: number;
		protection: 'normal' | 'elevated' | 'siege';
		maxPayloadLength: number;
		pressure: {
			active: boolean;
			reason: string;
			value: number;
			subscriberRatio: number;
			publishRate: number;
			memoryMB: number;
		};
		assertions: Record<string, number>;
	} | null;
	/** Push registry sizes (unique users / sessions with a live connection). */
	push: { users: number; sessions: number };
	cron: { jobs: number; running?: number; schedulerActive?: boolean; secondResolution?: boolean };
	reactive: { derived: number; effect: number; aggregate: number; watchedTopics: number };
	capacity: { rateLimitBuckets: number; throttles: number; debounces: number; presenceRefs: number; lazyQueue: number };
	/** Configured tenants. */
	tenants: number;
	/** Whether Prometheus metrics are wired (`live.metrics(...)`). */
	metrics: boolean;
	/** Whether admission control is configured (`live.admission(...)`). */
	admission: boolean;
}

/**
 * Snapshot the server's live dispatch state for admin / observability - a pure,
 * PII-free read over the in-memory registries (counts + code structure, never
 * user identifiers). By default paths and topic names are omitted (counts only);
 * opt into them with `{ handlers: true }` (registered paths) and `{ topics: true }`
 * (the top 20 topics by subscriber count). Useful standalone; the `/__realtime`
 * admin route serves it behind a mandatory auth gate.
 */
export function introspect(options?: { handlers?: boolean; topics?: boolean }): RealtimeIntrospection;
