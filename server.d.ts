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
	 * Called when a client disconnects from this stream.
	 * Fires for both static and dynamic topics.
	 */
	onUnsubscribe?(ctx: LiveContext<any>, topic: string): void | Promise<void>;

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
	 * Delta sync configuration for efficient reconnection.
	 * When configured, the server sends only changes since the client's last known version.
	 */
	delta?: {
		/** Return the current version/hash of the data. Must be fast. */
		version(): any | Promise<any>;
		/** Return only the items that changed since `sinceVersion`. Return null to force full refetch. */
		diff(sinceVersion: any): any[] | Promise<any[] | null> | null;
	};
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
 * Shape accepted by `live.metrics()`. Any object matching this contract works
 * (hand-rolled, prom-client adapter, or the `createMetrics()` registry from
 * `svelte-adapter-uws-extensions/prometheus` wrapped to forward options as
 * positional args -- see the README "Prometheus metrics" section).
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
		/** OR logic: any predicate returning true allows the subscription. */
		any(...predicates: Array<(ctx: LiveContext<any>) => boolean>): (ctx: LiveContext<any>) => boolean;
		/** AND logic: all predicates must return true. */
		all(...predicates: Array<(ctx: LiveContext<any>) => boolean>): (ctx: LiveContext<any>) => boolean;
	};
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
 * @example
 * ```js
 * export const _guard = guard((ctx) => {
 *   if (ctx.user?.role !== 'admin') throw new LiveError('FORBIDDEN', 'Admin only');
 * });
 * ```
 */
export function guard(
	...fns: Array<(ctx: LiveContext<any>) => void | Promise<void>>
): (ctx: LiveContext<any>) => void | Promise<void>;

/**
 * Typed error that propagates `code` and `message` to the client.
 * Use this for expected errors (auth failures, validation, etc.).
 * Raw `Error` throws are caught and replaced with a generic `INTERNAL_ERROR`.
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
 * @param path - RPC path (e.g. 'chat/messages')
 * @param args - Arguments to pass (excluding ctx)
 * @param platform - The platform API
 * @param options - Optional user data
 *
 * @internal
 */
export function __directCall(
	path: string,
	args: any[],
	platform: Platform,
	options?: { user?: any }
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
