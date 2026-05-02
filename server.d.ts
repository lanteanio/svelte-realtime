import type { Platform, WebSocket } from 'svelte-adapter-uws';

/**
 * Context passed to `live.cron()` functions.
 * No `user` or `ws` since cron jobs run outside a connection.
 */
export interface CronContext {
	/** The platform API (publish, send, topic helpers). */
	platform: Platform;
	/** Shorthand for `platform.publish` -- delegates to whatever platform was passed in. */
	publish: Platform['publish'];
	/** Throttled publish -- sends at most once per `ms` milliseconds. */
	throttle(topic: string, event: string, data: any, ms: number): void;
	/** Debounced publish -- sends after `ms` milliseconds of silence. */
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
export interface LiveContext<UserData = unknown> {
	/** User data attached during the WebSocket upgrade handshake. */
	user: UserData;
	/** The raw WebSocket connection. */
	ws: WebSocket<UserData>;
	/** The platform API (publish, send, topic helpers). */
	platform: Platform;
	/** Shorthand for `platform.publish` -- delegates to whatever platform was passed in. */
	publish: Platform['publish'];
	/** Cursor value sent by the client for paginated stream requests. `null` if not paginated. */
	cursor: any;
	/** Throttled publish -- sends at most once per `ms` milliseconds. */
	throttle(topic: string, event: string, data: any, ms: number): void;
	/** Debounced publish -- sends after `ms` milliseconds of silence. */
	debounce(topic: string, event: string, data: any, ms: number): void;
	/** Send a point-to-point signal to a specific user. */
	signal(userId: string, event: string, data: any): void;
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
	 * `svelte-adapter-uws-extensions/task-runner` -- structured-log against
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
}

/**
 * Options for `live.stream()`.
 */
export interface StreamOptions {
	/**
	 * Merge strategy for live updates.
	 * - `'crud'` -- append/update/delete by key (default)
	 * - `'latest'` -- ring buffer of last N events
	 * - `'set'` -- replace entire value
	 * - `'presence'` -- presence join/leave tracking by key
	 * - `'cursor'` -- cursor position tracking by key
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
	 * Return `false` to deny the subscription with an "Access denied" error.
	 * For per-event filtering, use `pipe.filter()`.
	 */
	filter?(ctx: LiveContext<any>): boolean;

	/**
	 * Subscribe-time access predicate (alias for `filter`).
	 * Use `live.access` helpers to build predicates.
	 */
	access?(ctx: LiveContext<any>): boolean;

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
	 *   1. Replay buffer (bounded, fast) -- if `replay: true` is set.
	 *   2. `delta.fromSeq(clientSeq)` -- this hook.
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
	 * BEFORE topic resolution -- prevents topic injection via malformed
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
	 * Mark this stream as volatile -- intentionally fire-and-forget. Wire-level
	 * "drop on backpressure" is the adapter's default behavior (uWS skips any
	 * subscriber whose outbound buffer is over `maxBackpressure`, default
	 * 64 KB), so volatile is mostly an intent declaration. The realtime side
	 * uses it to disable per-event seq stamping for this topic, which means
	 * a reconnect carrying `lastSeenSeq` won't try to backfill the gaps. That
	 * is correct for typing indicators, cursor positions, telemetry pings,
	 * and other streams where a missed frame is simply gone.
	 *
	 * Cannot combine with `coalesceBy` (latest-value-wins requires a queue;
	 * volatile drops on backpressure -- the two are different intents).
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
	 * Every publish to the topic resets the watchdog -- a publish is
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
	 * `onError` setter -- per-stream observers fire alongside the
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
	 * Called when a message is not an RPC request.
	 * Use for mixing RPC with custom message handling.
	 */
	onUnhandled?(ws: WebSocket<any>, data: ArrayBuffer, platform: Platform): void;
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
export type TopicEntry = string | ((...args: any[]) => string);

/**
 * The map type accepted by `defineTopics` -- a record of name -> entry.
 */
export type TopicMap = Record<string, TopicEntry>;

/**
 * The map returned by `defineTopics` -- the input map plus two
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
	 * Register the connection in the push registry. Anonymous connections
	 * (identify(ws) returning null/undefined) are silently skipped.
	 */
	open(ws: any, ctx: { platform: any }): void;
	/**
	 * Deregister the connection from the push registry. Looks up the userId
	 * via the reverse index so it works even when getUserData has been
	 * cleared. Only removes the entry if this exact ws is still the
	 * registered one (handles fast device-swap sequences correctly).
	 */
	close(ws: any): void;
};

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
	 * Channels have no initFn -- clients subscribe and receive live events immediately.
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
	 * Register a global middleware that runs before per-module guards for every RPC/stream call.
	 * Middleware receives `(ctx, next)` -- call `next()` to continue the chain.
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
	 * Wrap a stream with a server-side gate predicate.
	 * If the predicate returns false, the client receives a graceful no-op
	 * (`{ data: null, gated: true }`) instead of an error.
	 *
	 * @param predicate - Synchronous function checked before subscribing
	 * @param fn - The stream function to gate
	 *
	 * @example
	 * ```js
	 * export const betaFeed = live.gate(
	 *   (ctx) => ctx.user?.flags?.includes('beta'),
	 *   live.stream('beta-feed', async (ctx) => db.betaFeed.latest(50))
	 * );
	 * ```
	 */
	function gate<T extends Function>(
		predicate: (ctx: LiveContext<any>, ...args: any[]) => boolean,
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
	 * `platform.pressure.topPublishers` directly -- the underlying counters
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
	 * so the next caller re-runs.
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
	 * Lock contract: any object exposing `withLock(key, fn)` matching the
	 * adapter's Lock plugin. The default in-process lock is created lazily;
	 * pass a custom one for distributed mutex via Redis (`SET NX PX`) or any
	 * other backing store.
	 */
	interface Lock {
		withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
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
			},
		fn: T
	): T;

	/**
	 * Configure how the push registry extracts the userId from a connecting
	 * WebSocket. Defaults to reading
	 * `ws.getUserData()?.user_id ?? ws.getUserData()?.userId`. Pass `null` to
	 * restore the default.
	 *
	 * The identify function may return `null` or `undefined` for anonymous
	 * connections, in which case `pushHooks.open` skips registration.
	 *
	 * @example
	 * ```js
	 * import { live } from 'svelte-realtime/server';
	 *
	 * live.configurePush({ identify: (ws) => ws.getUserData()?.account?.id });
	 * ```
	 */
	function configurePush(
		config: { identify: (ws: any) => string | null | undefined } | null
	): void;

	/**
	 * Send a server-initiated request to a connected user and await the reply.
	 * Routes through the push registry populated by `pushHooks.open` /
	 * `pushHooks.close`, so the user must have an active connection on this
	 * server instance.
	 *
	 * Returns whatever the client's `onPush(event, handler)` returns. Throws
	 * `LiveError('NOT_FOUND')` if no connection is registered for the userId.
	 * Propagates `Error('request timed out')` from the underlying platform
	 * primitive when the client does not reply within `timeoutMs` (default
	 * 5000), and `Error('connection closed')` if the WebSocket closes before
	 * reply.
	 *
	 * Multi-device users see most-recent-connection-wins routing. Cluster-wide
	 * push (any instance routing to any user's ws) requires the connection
	 * registry primitive in the extensions package.
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
	 * // hooks.ws.js -- wire the registry once:
	 * import { pushHooks } from 'svelte-realtime/server';
	 * export const open = pushHooks.open;
	 * export const close = pushHooks.close;
	 * ```
	 */
	function push<TReply = unknown>(
		target: { userId: string },
		event: string,
		data?: unknown,
		options?: { timeoutMs?: number }
	): Promise<TReply>;

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
	 * // Return a value -- published as 'set' automatically
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
	 * Create a real-time incremental aggregation over a source topic.
	 *
	 * @param source - Topic to watch
	 * @param reducers - Field definitions with init/reduce/compute functions
	 * @param options - Output topic, optional snapshot, debounce
	 *
	 * @example
	 * ```js
	 * export const orderStats = live.aggregate('orders', {
	 *   count: { init: () => 0, reduce: (acc, event) => event === 'created' ? acc + 1 : acc },
	 *   avgValue: { compute: (state) => state.count > 0 ? state.total / state.count : 0 }
	 * }, { topic: 'order-stats' });
	 * ```
	 */
	function aggregate(
		source: string,
		reducers: Record<string, {
			init?(): any;
			reduce?(acc: any, event: string, data: any): any;
			compute?(state: Record<string, any>): any;
		}>,
		options: {
			topic: string;
			snapshot?(): Promise<Record<string, any>>;
			debounce?: number;
		}
	): Function;

	/**
	 * Create a server-side reactive side effect.
	 * Effects fire when source topics publish. Fire-and-forget -- no data, no topic.
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
	 * Opt-in Prometheus metrics integration.
	 * Accepts a MetricsRegistry from `svelte-adapter-uws-extensions/prometheus`
	 * and instruments RPC calls, stream subscriptions, and cron executions.
	 *
	 * Zero overhead if never called.
	 *
	 * @param registry - A MetricsRegistry instance with counter(), histogram(), gauge()
	 *
	 * @example
	 * ```js
	 * import { createRegistry } from 'svelte-adapter-uws-extensions/prometheus';
	 * live.metrics(createRegistry());
	 * ```
	 */
	function metrics(registry: any): void;

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
		/** OR logic: any predicate returning true allows the subscription. Args are forwarded so `org`/`user` predicates compose. */
		any(...predicates: Array<(ctx: LiveContext<any>, ...args: any[]) => boolean>): (ctx: LiveContext<any>, ...args: any[]) => boolean;
		/** AND logic: all predicates must return true. Args are forwarded so `org`/`user` predicates compose. */
		all(...predicates: Array<(ctx: LiveContext<any>, ...args: any[]) => boolean>): (ctx: LiveContext<any>, ...args: any[]) => boolean;
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
	__presenceStream?: any;
	__cursorStream?: any;
	__actions?: Record<string, any>;
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
 * A stream transform step created by `pipe.filter`, `pipe.sort`, etc.
 */
export interface PipeTransform {
	transformInit?(data: any[], ctx: LiveContext<any>): any[] | Promise<any[]>;
	transformEvent?(ctx: LiveContext<any>, event: string, data: any): boolean;
}

/**
 * Compose stream transforms that apply to initial data and live events.
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
	/** Filter items from initial data and drop non-matching live events. */
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
 * - `{ authenticated: true }` -- throws `UNAUTHENTICATED` unless
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
 * EXCEPT when thrown from a guard -- those are auto-classified
 * (see `guard()`).
 *
 * The framework recognises and emits these standard codes:
 *
 * - `UNAUTHENTICATED` -- caller has no user identity. From guards or
 *   access predicates failing with `ctx.user == null`.
 * - `FORBIDDEN` -- caller is identified but lacks permission. From guards
 *   or access predicates failing with `ctx.user != null`.
 * - `RATE_LIMITED` -- request rejected by `live.rateLimit({...})`.
 * - `VALIDATION` -- input rejected by `live.validated(schema, ...)`.
 * - `OVERLOADED` -- subscribe rejected by `live.stream({ classOfService })`
 *   under pressure.
 * - `CONFLICT` -- a request with the same idempotency key is already
 *   in flight (multi-instance store only).
 * - `SERVICE_UNAVAILABLE` -- circuit breaker open.
 * - `NOT_FOUND` -- live function not registered at the requested path.
 * - `INVALID_REQUEST` -- malformed envelope or args.
 * - `INTERNAL_ERROR` -- non-LiveError throw from a handler (NOT a guard).
 *
 * Code strings are user-extensible -- throw your own (e.g. `INSUFFICIENT_FUNDS`)
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
 *   (back-compat). The presence of the key opts in -- the value
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
 * Call this in your `open` hook if you use `live.cron()`.
 */
export function setCronPlatform(platform: Platform): void;

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
 * Handle a WebSocket close event. Fires `onUnsubscribe` lifecycle hooks
 * for stream functions that define them.
 *
 * Re-export from your `hooks.ws.js`:
 * ```js
 * export { close } from 'svelte-realtime/server';
 * ```
 */
export function close(
	ws: WebSocket<any>,
	ctx: { platform: Platform }
): void;
