import type { Readable } from 'svelte/store';
import type { WSEvent } from 'svelte-adapter-uws/client';

/**
 * A store that always holds `undefined`. Use as a fallback for conditional
 * streams so you don't need to import `readable` from `svelte/store`:
 *
 * ```svelte
 * import { todos, empty } from '$live/todos';
 * const items = $derived(user ? todos(orgId) : empty);
 * ```
 */
export const empty: Readable<undefined>;

/**
 * Typed error for RPC failures.
 * Contains a `code` field for programmatic handling.
 */
export class RpcError extends Error {
	code: string;
	/** Structured validation issues (present when code === 'VALIDATION'). */
	issues?: Array<{ path: string[]; message: string }>;
	constructor(code: string, message?: string);
}

/**
 * Create a callable RPC function for a given path.
 * Used by generated client stubs - not called directly by users.
 *
 * @param path - RPC path (e.g. `'chat/sendMessage'`)
 * @returns An async function that sends the RPC and returns the result
 *
 * @internal
 */
export function __rpc(path: string): ((...args: any[]) => Promise<any>) & {
	/** Bypass deduplication - always send a fresh request. */
	fresh: (...args: any[]) => Promise<any>;
	/**
	 * Attach per-call options. Returns a callable bound to those options.
	 *
	 * - `idempotencyKey` is forwarded in the wire envelope; the server-side
	 *   handler must be wrapped with `live.idempotent({...})` for the key
	 *   to take effect. Calls made via `.with({ idempotencyKey })` dedup
	 *   against each other within a microtask under that key, independent
	 *   of the default `(path, args)` dedup.
	 * - `timeout` overrides the global RPC timeout (default 30s) for this
	 *   call only. Use for known-slow queries; the call waits up to
	 *   `timeout` ms before rejecting with `RpcError('TIMEOUT', ...)`.
	 *   Per-call `timeout` is ignored inside `batch(fn)` - the
	 *   batch-level timer governs all collected calls there.
	 *
	 * Calling `.with({})` (or omitting both options) returns the base
	 * callable unchanged.
	 *
	 * @example
	 * ```js
	 * // Idempotent retry
	 * const key = crypto.randomUUID();
	 * await createOrder.with({ idempotencyKey: key })(payload);
	 *
	 * // Long-running query: wait up to 2 minutes
	 * const report = await generateReport.with({ timeout: 120_000 })(params);
	 *
	 * // Both at once
	 * await charge.with({ idempotencyKey: 'k1', timeout: 90_000 })(payload);
	 * ```
	 */
	with: (opts: { idempotencyKey?: string; timeout?: number }) => (...args: any[]) => Promise<any>;
	/**
	 * Bind this RPC to a stream store as an optimistic mutation. Two
	 * call shapes:
	 *
	 * - **Direct**: `rpc.createOptimistic(store, callArgs, change)` runs
	 *   immediately and returns the asyncOp's result Promise. Equivalent
	 *   to `store.mutate(() => rpc(...callArgs), wrapped)` where `wrapped`
	 *   forwards `callArgs` into a `(current, args)` callback so users
	 *   don't have to capture them in a closure at the call site.
	 * - **Curried**: `rpc.createOptimistic(store, change)` returns a
	 *   `(...callArgs) => Promise` callable bound to that store +
	 *   change. Useful when one optimistic-update setup applies to many
	 *   call sites with different args.
	 *
	 * @example
	 * ```js
	 * import { sendMessage, messages } from '$live/chat';
	 *
	 * // Direct form - one-shot
	 * await sendMessage.createOptimistic(
	 *   messages,
	 *   ['Hello!'],
	 *   (current, args) => [...current, { id: tempId(), text: args[0] }]
	 * );
	 *
	 * // Curried form - bind once, call many times
	 * const optimisticSend = sendMessage.createOptimistic(
	 *   messages,
	 *   (current, args) => [...current, { id: tempId(), text: args[0] }]
	 * );
	 * await optimisticSend('Hi');
	 * await optimisticSend('There');
	 * ```
	 */
	createOptimistic: {
		(
			store: { mutate: (asyncOp: () => Promise<any>, change: any) => Promise<any> },
			callArgs: any[],
			optimisticChange:
				| ((current: any, args: any[]) => any)
				| { event: string; data: any }
		): Promise<any>;
		(
			store: { mutate: (asyncOp: () => Promise<any>, change: any) => Promise<any> },
			optimisticChange:
				| ((current: any, args: any[]) => any)
				| { event: string; data: any }
		): (...callArgs: any[]) => Promise<any>;
	};
	/**
	 * Send a fire-and-forget RPC. Returns `void` synchronously - no Promise,
	 * no pending entry, no timeout, no devtools-pending. The wire frame is
	 * `{rpc, args}` with no `id` field; the server runs the full handler
	 * chain but does not write a response. Errors are silently dropped on
	 * the wire.
	 *
	 * Pair with `live.volatile(fn)` server-side. Use for high-frequency
	 * one-way RPCs - cursor moves, drag updates, typing indicators,
	 * telemetry beacons, heartbeats.
	 *
	 * Safety:
	 * - Offline: silent no-op (no offline queue).
	 * - Backpressure: dropped when `conn.bufferedAmount` exceeds the
	 *   configured `volatileBackpressureBytes` (default 4 MB);
	 *   `__devtools.volatileDropped` ticks.
	 * - Inside `batch()`: throws in dev, no-op in prod.
	 *
	 * @example
	 * ```js
	 * import { moveCursor } from '$live/cursors';
	 * moveCursor.fireAndForget('board-1', { x, y });
	 * ```
	 */
	fireAndForget: (...args: any[]) => void;
	/**
	 * Send a RELIABLE no-reply RPC. Same `{rpc, args}` no-`id` wire frame as
	 * `fireAndForget`, but with NO drop tiers: not dropped while offline (the
	 * frame queues and flushes FIFO on reconnect) and not dropped under WS
	 * backpressure. For one-way sends whose payloads are precious rather than
	 * lossy-by-contract (a CRDT document update is the canonical case).
	 *
	 * Pair with `live.volatile(fn)` server-side. Inside `batch()`: throws in
	 * dev, no-op in prod (one-way sends bypass batching by design).
	 */
	send: (...args: any[]) => void;
};

/**
 * Create a reactive stream store for a given path.
 * Used by generated client stubs - not called directly by users.
 *
 * The store value is:
 * - `undefined` while loading
 * - The initial data once loaded
 * - Automatically updated with live pub/sub events
 *
 * Errors never replace the store value. On failure, the last known data
 * is preserved and the error is available via the `.error` store.
 *
 * @param path - Stream path (e.g. `'chat/messages'`)
 * @param options - Merge strategy and options
 *
 * @internal
 */
/**
 * A reactive stream store with live update merging, optimistic updates,
 * SSR hydration, and cursor-based pagination.
 */
export interface StreamStore<T = any> extends Readable<T> {
	/**
	 * Reactive store holding the current error, or null when healthy.
	 * Errors never replace the data store value.
	 *
	 * Carries typed `code` for subscribe-denials surfaced by the
	 * adapter's `denials` store: `'UNAUTHENTICATED'`, `'FORBIDDEN'`,
	 * `'INVALID_TOPIC'`, `'RATE_LIMITED'`, or any custom string the
	 * server's `subscribe` hook returned. RPC failures (timeouts,
	 * connection drops, server-side `LiveError` throws) carry their
	 * own canonical codes (`TIMEOUT`, `DISCONNECTED`, etc.) on the
	 * same store.
	 *
	 * @example
	 * ```svelte
	 * <script>
	 *   import { auditFeed } from '$live/audit';
	 *   const err = auditFeed.error;
	 * </script>
	 *
	 * {#if $err?.code === 'UNAUTHENTICATED'}
	 *   <p>Please sign in to view audit history.</p>
	 * {:else if $err?.code === 'FORBIDDEN'}
	 *   <p>You don't have access to this organization's audit log.</p>
	 * {:else if $err?.code === 'RATE_LIMITED'}
	 *   <p>Too many requests. Please wait a moment.</p>
	 * {:else if $err}
	 *   <p>Audit feed unavailable: {$err.message}</p>
	 * {/if}
	 * ```
	 */
	readonly error: Readable<RpcError | null>;
	/** Reactive store holding the connection status: 'loading', 'connected', 'reconnecting', or 'error'. */
	readonly status: Readable<'loading' | 'connected' | 'reconnecting' | 'error'>;
	/** Apply an instant UI update. Returns a rollback function. */
	optimistic(event: string, data: any): () => void;
	/**
	 * Apply an optimistic update + run an async operation with auto-rollback.
	 * The optimistic change applies synchronously; the asyncOp runs after.
	 * On success, returns the asyncOp's result and leaves the store as-is
	 * (the server's confirming event will reconcile via the merge strategy).
	 * On failure, the optimistic change is rolled back and the rejection
	 * propagates to the caller.
	 *
	 * Two patterns for the optimistic change:
	 *
	 * 1. Event-based (uses the stream's merge strategy):
	 *    `{ event: 'created', data: { id: tempId(), title: 'X' } }`
	 *
	 * 2. Free-form mutator (bypasses merge strategy; full control):
	 *    `(current) => current.filter(t => t.id !== 'foo')`
	 *    The mutator receives a copy of the current value. It can mutate
	 *    and return undefined, OR return a new value.
	 *
	 * @example
	 * ```js
	 * // Event-based: server's confirming `created` event replaces the placeholder.
	 * const todo = await todos.mutate(
	 *   () => createTodo({ title: 'Buy milk' }),
	 *   { event: 'created', data: { id: tempId(), title: 'Buy milk' } }
	 * );
	 * ```
	 *
	 * @example
	 * ```js
	 * // Free-form: arbitrary local change with auto-rollback.
	 * await todos.mutate(
	 *   () => removeTodo('foo'),
	 *   (current) => current.filter(t => t.id !== 'foo')
	 * );
	 * ```
	 *
	 * Replay-safety: snapshot/restore. Concurrent optimistic mutations or
	 * interleaved server events on the same stream can lose state on
	 * rollback. The typical client-generated-UUID pattern with `crud` merge
	 * works correctly because the server event REPLACES the placeholder via
	 * key match, so no rollback conflict arises in practice.
	 *
	 * Snapshot is shallow (slice for arrays). Top-level shape changes
	 * (push, pop, filter, splice) are rolled back cleanly; in-place
	 * mutations of individual items (e.g. `draft[0].name = 'x'`) are NOT,
	 * because the snapshot array and the draft array share item references.
	 * To mutate an item field, replace the whole item:
	 * `draft[i] = { ...draft[i], name: 'x' }`.
	 */
	mutate<R>(
		asyncOp: () => Promise<R> | R,
		optimisticChange:
			| { event: string; data: any }
			| ((current: T) => T | void)
	): Promise<R>;
	/**
	 * Stream-side counterpart to `rpc.createOptimistic`. Equivalent to
	 * calling `rpc.createOptimistic(this, callArgs, change)`. Reads more
	 * naturally when the call site is stream-focused and the RPC is the
	 * variable being passed in.
	 *
	 * @example
	 * ```js
	 * import { sendMessage, messages } from '$live/chat';
	 *
	 * await messages.createOptimistic(
	 *   sendMessage,
	 *   ['Hello!'],
	 *   (current, args) => [...current, { id: tempId(), text: args[0] }]
	 * );
	 * ```
	 */
	createOptimistic(
		rpc: { createOptimistic: Function },
		callArgs: any[],
		optimisticChange:
			| ((current: T, args: any[]) => T | void)
			| { event: string; data: any }
	): Promise<any>;
	/** Pre-populate with SSR data to avoid loading spinners. */
	hydrate(initialData: T): StreamStore<T>;
	/** Load the next page of data (cursor-based pagination). */
	loadMore(...extraArgs: any[]): Promise<boolean>;
	/** Whether more pages are available for loading. */
	readonly hasMore: boolean;
	/** Enable history tracking for undo/redo. */
	enableHistory(maxSize?: number): void;
	/** Undo the last change. */
	undo(): void;
	/** Redo the last undone change. */
	redo(): void;
	/** Whether there are entries to undo. */
	readonly canUndo: boolean;
	/** Whether there are entries to redo. */
	readonly canRedo: boolean;
	/** Pause history recording. Events still apply but no snapshots are saved. */
	pauseHistory(): void;
	/** Resume history recording. Records current state as a snapshot. */
	resumeHistory(): void;
	/** Return a wrapper store that only activates when `condition` is truthy. Accepts a boolean, a Svelte store, or a getter function. Getter functions are evaluated once at subscribe time; for reactivity, pass a store. */
	when(condition: boolean | Readable<any> | (() => any)): Readable<T | undefined>;
	/**
	 * Svelte 5: return a reactive object backed by this store's value.
	 *
	 * Internally calls `fromStore` from `svelte/store`: the returned object
	 * exposes a single `current` getter; reading `current` inside an effect
	 * or component subscribes via Svelte's `createSubscriber` for
	 * fine-grained reactivity, and reading it outside an effect
	 * synchronously returns the latest value.
	 *
	 * Throws under Svelte 4 (where `fromStore` is not exported). Apps still
	 * on Svelte 4 should use the existing `Readable<T>` interface via the
	 * `$store` auto-subscribe syntax.
	 *
	 * @example
	 * ```svelte
	 * <script>
	 *   import { todos } from '$live/todos';
	 *   const items = todos.rune();
	 * </script>
	 *
	 * <p>{items.current?.length ?? 0} items</p>
	 * {#each items.current ?? [] as todo}<li>{todo.title}</li>{/each}
	 * ```
	 */
	rune(): { readonly current: T };
	/**
	 * Project each item of the stream's array through `fn`. Returns a mapped
	 * store with the same `{ subscribe, rune, map }` shape as the source,
	 * so it composes with `$`-prefix auto-subscription, with `.rune()`
	 * for Svelte 5 fine-grained reactivity, and chains via further `.map()`.
	 *
	 * Semantics match the documented `($stream ?? []).map(fn)` pattern:
	 * a null or undefined source emits `[]`; an array source emits
	 * `source.map(fn)`; a non-array source emits `[]` after a dev-mode
	 * console.warn (set-merge streams and paginated wrappers are not
	 * arrays at the top level - users should `.map()` over the array
	 * field themselves).
	 *
	 * Avoids the `$derived(() => ...)` footgun: the value is a store, not a
	 * function reference, so no rune-helper confusion is possible.
	 *
	 * @example
	 * ```svelte
	 * <script>
	 *   import { todos } from '$live/todos';
	 *   const titles = todos.map(t => t.title);
	 * </script>
	 *
	 * {#each $titles as title}<li>{title}</li>{/each}
	 * ```
	 */
	map<U>(fn: (item: T extends (infer Item)[] ? Item : any) => U): MappedStore<U>;
}

/**
 * The return value of `StreamStore.map(fn)`. Composes the same way as the
 * source: subscribe via `$` auto-subscription, project further via `.map`,
 * or read reactively in Svelte 5 via `.rune()`.
 */
export interface MappedStore<U> extends Readable<U[]> {
	/** Svelte 5: return a reactive object backed by the mapped value. See `StreamStore.rune`. */
	rune(): { readonly current: U[] };
	/** Chain another projection. Same composability as `StreamStore.map`. */
	map<V>(fn: (item: U) => V): MappedStore<V>;
}

export function __stream(
	path: string,
	options?: {
		merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor';
		key?: string;
		prepend?: boolean;
		max?: number;
		replay?: boolean;
	},
	isDynamic?: false
): StreamStore;

export function __stream(
	path: string,
	options: {
		merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor';
		key?: string;
		prepend?: boolean;
		max?: number;
		replay?: boolean;
	} | undefined,
	isDynamic: true
): (...args: any[]) => StreamStore;

/**
 * Build the reserved field-surface members of a generated `live.multiplayer()`
 * namespace: the empty `typing` / `locks` / `selections` / `reactions` views
 * and the no-op `setTyping` / `acquireLock` / `releaseLock` / `setSelection` /
 * `react` methods. The codegen spreads the result into the namespace object and
 * adds the live `data` / `presence` / `cursors` / `status` / `move` /
 * `reportViewport` members on top.
 *
 * @internal
 */
export function __mpFields(): Record<string, any>;

/**
 * Group multiple RPC calls into a single WebSocket frame.
 * All calls are sent together and responses come back in one frame.
 *
 * @param fn - Function that returns an array of RPC call promises
 * @param options - Optional: `{ sequential: true }` to run in order on the server
 * @returns Array of results in the same order as the calls
 *
 * @example
 * ```js
 * import { batch } from 'svelte-realtime/client';
 * import { addTodo, assignUser } from '$live/boards';
 *
 * const [todo, user] = await batch(() => [
 *   addTodo('Buy milk'),
 *   assignUser(todoId, userId)
 * ]);
 * ```
 */
export function batch<T extends Promise<any>[]>(
	fn: () => [...T],
	options?: { sequential?: boolean }
): Promise<{ [K in keyof T]: Awaited<T[K]> }>;

/**
 * Create a callable binary RPC function for a given path.
 * Sends the first argument as raw binary and remaining args as JSON in a header.
 * Used by generated client stubs for `live.binary()` exports.
 *
 * @param path - RPC path (e.g. `'upload/avatar'`)
 * @returns A function that sends binary data over WebSocket
 *
 * @internal
 */
export function __binaryRpc(path: string): (buffer: ArrayBuffer | ArrayBufferView, ...args: any[]) => Promise<any>;

/**
 * Progress event payload emitted by `UploadHandle.on('progress', ...)`.
 */
export interface UploadProgress {
	/** Bytes sent so far. */
	sent: number;
	/** Total bytes if known (Blob/Buffer); undefined for ReadableStream. */
	total: number | undefined;
	/** 0..1 if total known; undefined otherwise. */
	percent: number | undefined;
	/** Chunks sent so far. */
	chunks: number;
	/** Smoothed throughput over the last ~1s, in bytes/sec. */
	bytesPerSec: number;
}

/**
 * Handle returned by an upload call. Thenable (`await handle`), event
 * emitter (`handle.on(...)`), and abortable (`handle.cancel()`).
 *
 * Promise-shaped: `await handle` resolves with the server's return value
 * or rejects with `RpcError`. Codes seen at this layer:
 *   - `CANCELLED`            - caller cancelled (or AbortSignal aborted)
 *   - `DISCONNECTED`         - WS closed mid-upload
 *   - `CONNECTION_CLOSED`    - WS terminated before start
 *   - `SOURCE_ERROR`         - the source iterator threw
 *   - any code from the server (`PAYLOAD_TOO_LARGE`, `NOT_FOUND`, ...)
 */
export interface UploadHandle<T = any> extends Promise<T> {
	/** Bytes sent so far. */
	readonly sent: number;
	/** Total bytes if known (Blob/Buffer); undefined for ReadableStream. */
	readonly total: number | undefined;
	/** Chunks sent so far. */
	readonly chunks: number;
	/** 0..1 if total known; undefined otherwise. */
	readonly progress: number | undefined;
	/** Smoothed throughput over the last ~1s, in bytes/sec. */
	readonly bytesPerSec: number;
	/** Numeric streamId (uint32 client-assigned). */
	readonly streamId: number;
	/** 8-char hex matching server-side `ctx.upload.id`. */
	readonly streamIdHex: string;

	/**
	 * Subscribe to a handle event. Returns an unsubscribe function.
	 */
	on(event: 'progress', cb: (payload: UploadProgress) => void): () => void;
	on(event: 'complete', cb: (result: T) => void): () => void;
	on(event: 'error', cb: (err: RpcError) => void): () => void;
	on(event: 'cancel', cb: (reason: string | undefined) => void): () => void;

	/**
	 * Cancel the upload. Sends a control frame to the server (best-effort)
	 * and rejects the promise with `RpcError('CANCELLED')`. Idempotent.
	 *
	 * Compose with `AbortController`:
	 *   `ac.signal.addEventListener('abort', () => handle.cancel())`
	 */
	cancel(reason?: string): void;
}

/**
 * Create a callable upload function for a given path. The returned function
 * takes `(source, ...args)` and returns an `UploadHandle`.
 *
 * Source types: `Blob` / `File` / `ArrayBuffer` / any `ArrayBufferView` /
 * `ReadableStream<Uint8Array>`. Args are forwarded positionally to the
 * server-side `live.upload(handler)` after `ctx`.
 *
 * Used by generated client stubs for `live.upload()` exports.
 *
 * @param path - RPC path (e.g. `'uploads/avatar'`)
 *
 * @internal
 */
export function __upload<T = any>(path: string): (
	source: Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
	...args: any[]
) => UploadHandle<T>;

/**
 * Configure client-side connection hooks.
 *
 * @example
 * ```js
 * import { configure } from 'svelte-realtime/client';
 *
 * configure({
 *   onConnect() { console.log('Connected'); },
 *   onDisconnect() { console.log('Disconnected'); }
 * });
 * ```
 */
/**
 * An entry in the offline mutation queue.
 */
export interface OfflineEntry {
	path: string;
	args: any[];
	queuedAt: number;
	resolve: Function;
	reject: Function;
}

export function configure(config: {
	/**
	 * Full WebSocket URL to connect to. Enables cross-origin and native app usage
	 * (Svelte Native, React Native, standalone clients). When set, the default
	 * same-origin URL is bypassed entirely.
	 * @example 'wss://my-app.com/ws'
	 */
	url?: string;
	/**
	 * Run an HTTP preflight before each WebSocket upgrade so cookies set by the
	 * server's `authenticate` hook ride a normal HTTP response (not a 101 Switching
	 * Protocols frame). Required behind Cloudflare Tunnel and other strict edge
	 * proxies that silently drop `Set-Cookie` on WebSocket upgrades.
	 *
	 * Pass `true` to use the default `/__ws/auth` path, or a string to override it
	 * (must match the adapter's `websocket.authPath` option).
	 *
	 * Requires `svelte-adapter-uws` >= 0.4.12 and an `authenticate` export in
	 * `src/hooks.ws.{js,ts}`.
	 *
	 * @default false
	 * @example configure({ auth: true })
	 */
	auth?: boolean | string;
	/** Called when the WebSocket connection opens (not on initial connect, only reconnects). */
	onConnect?(): void;
	/** Called when the WebSocket connection closes. */
	onDisconnect?(): void;
	/** Default RPC timeout in ms; per-call `.with({ timeout })` overrides. @default 30000 */
	timeout?: number;
	/**
	 * Stream resume-grace window in ms. When the last subscriber of a stream
	 * unsubs, the WS subscription is released immediately but the data model
	 * (currentValue, seq, version, cursor) is kept for this long. A new
	 * subscribe within the window resumes from the retained cursor so the
	 * server can fill the gap from its replay buffer (or fromSeq, or
	 * truncated -> full rehydrate) instead of cold-rehydrating. Covers
	 * pause/resume UIs and browser back/forward navigation. Set to 0 to
	 * disable the grace window.
	 * @default 60000
	 */
	resumeGraceMs?: number;
	/**
	 * Maximum connection-downtime for which a still-subscribed stream trusts
	 * its retained replay cursor across a reconnect. A brief socket bounce
	 * resumes from the retained seq (the server gap-fills from its replay
	 * buffer); after an outage longer than this - a backgrounded tab, a device
	 * sleep, a tunnel drop - the stream drops the cursor and takes a full
	 * rehydrate, since the server may have pruned data by time in a way the seq
	 * alone does not reveal. Set to 0 to always rehydrate on reconnect.
	 * Independent of `resumeGraceMs`, which bounds the unsubscribe-retention
	 * window (a different axis).
	 * @default 60000
	 */
	resumeMaxCursorAgeMs?: number;
	/**
	 * Opt-in protocol/contract version, an integer the app bumps only on a
	 * BREAKING wire/contract change. Declare it identically here and in
	 * `realtime({ protocolVersion })` on the server (one shared constant). The
	 * client advertises it once on connect; a server running a higher version
	 * replies with a one-shot notice that surfaces the `health` store as
	 * `'outdated'` and logs a dev console warning, so a long-lived client running
	 * a stale bundle after a breaking deploy knows to reload. Omit to leave the
	 * signal off.
	 */
	protocolVersion?: number;
	/**
	 * `WS.bufferedAmount` threshold (in bytes) at which `.fireAndForget()`
	 * sends are dropped silently and `__devtools.volatileDropped` ticks.
	 * Sized for 120Hz cursor + drag traffic; raise it if your app
	 * legitimately bursts above 4 MB of in-flight volatile traffic,
	 * lower it on mobile-constrained targets where the OS send buffer
	 * is tighter.
	 * @default 4_194_304 (4 MB)
	 */
	volatileBackpressureBytes?: number;
	/**
	 * Enable the dev-mode publish-rate hint: a one-shot console warning logged
	 * when an inbound stream's frame rate crosses the high-frequency threshold,
	 * suggesting `coalesceBy` / `volatile`. Set `false` to silence it.
	 * Production builds strip the hint entirely, so this flag only has an effect
	 * in development.
	 * @default true
	 */
	publishRateHint?: boolean;
	/** Offline mutation queue configuration. */
	offline?: {
		/** Enable queuing RPCs when disconnected. */
		queue?: boolean;
		/** Maximum queue size before oldest entries are dropped. @default 100 */
		maxQueue?: number;
		/** Replay strategy on reconnect: 'sequential' (default), 'concurrent' (10-at-a-time), or a custom filter function. 'batch' is accepted as an alias for 'concurrent'. */
		replay?: 'sequential' | 'concurrent' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]);
		/** Filter function called before replaying each queued call. Return false to drop. */
		beforeReplay?(call: { path: string; args: any[]; queuedAt: number }): boolean;
		/** Called when a replayed call fails. */
		onReplayError?(call: { path: string; args: any[]; queuedAt: number }, error: any): void;
	};
}): void;

/**
 * Register a handler for point-to-point signals.
 * Signals are sent by `ctx.signal(userId, event, data)` on the server.
 *
 * The userId must match the one used by `enableSignals()` on the server,
 * because the server publishes to `__signal:${userId}`.
 *
 * @param userId - The current user's id (must match server-side enableSignals)
 * @param callback - Called with (event, data) for each received signal
 * @returns Unsubscribe function
 *
 * @example
 * ```js
 * import { onSignal } from 'svelte-realtime/client';
 *
 * const unsub = onSignal(currentUser.id, (event, data) => {
 *   if (event === 'call:offer') showIncomingCall(data);
 * });
 * ```
 */
export function onSignal(userId: string, callback: (event: string, data: any) => void): () => void;
/** @deprecated Pass userId as the first argument so the topic matches the server. */
export function onSignal(callback: (event: string, data: any) => void): () => void;

/**
 * Register a handler for a server-initiated push event. The server calls
 * `live.push({ userId }, event, data)` and awaits a reply; the value
 * returned (sync or async) is sent back as the reply. Throwing rejects
 * the server-side promise.
 *
 * Multiple events register independently. Calling `onPush` again with the
 * same event name replaces the previous handler. The returned function
 * unregisters the handler if it is still the active one.
 *
 * Internally backed by the adapter's `onRequest`; the realtime client
 * multiplexes by event name so apps install one handler per event without
 * overwriting each other.
 *
 * @returns Unsubscribe function.
 *
 * @example
 * ```svelte
 * <script>
 *   import { onPush } from 'svelte-realtime/client';
 *
 *   onPush('confirm-delete', async ({ itemId }) => {
 *     return { confirmed: confirm(`Delete item ${itemId}?`) };
 *   });
 * </script>
 * ```
 */
export function onPush<TData = any, TReply = any>(
	event: string,
	handler: (data: TData) => TReply | Promise<TReply>
): () => void;

/**
 * Combine multiple stores into a single derived store.
 * When any source updates, the combining function re-runs.
 *
 * @example
 * ```js
 * import { combine } from 'svelte-realtime/client';
 * import { orders, inventory } from '$live/dashboard';
 *
 * const dashboard = combine(orders, inventory, (o, i) => ({
 *   pendingOrders: o?.filter(x => x.status === 'pending').length ?? 0,
 *   lowStock: i?.filter(x => x.qty < 10) ?? []
 * }));
 * ```
 */
export function combine<A, B, R>(a: Readable<A>, b: Readable<B>, fn: (a: A, b: B) => R): Readable<R>;
export function combine<A, B, C, R>(a: Readable<A>, b: Readable<B>, c: Readable<C>, fn: (a: A, b: B, c: C) => R): Readable<R>;
export function combine<A, B, C, D, R>(a: Readable<A>, b: Readable<B>, c: Readable<C>, d: Readable<D>, fn: (a: A, b: B, c: C, d: D) => R): Readable<R>;
export function combine<A, B, C, D, E, R>(a: Readable<A>, b: Readable<B>, c: Readable<C>, d: Readable<D>, e: Readable<E>, fn: (a: A, b: B, c: C, d: D, e: E) => R): Readable<R>;
export function combine<A, B, C, D, E, F, R>(a: Readable<A>, b: Readable<B>, c: Readable<C>, d: Readable<D>, e: Readable<E>, f: Readable<F>, fn: (a: A, b: B, c: C, d: D, e: E, f: F) => R): Readable<R>;
export function combine(...args: [...Readable<any>[], (...values: any[]) => any]): Readable<any>;

/**
 * Dev-mode instrumentation data.
 * `null` in production builds (tree-shaken).
 */
export const __devtools: {
	history: Array<{
		path: string;
		args: any[];
		ok: boolean;
		result: any;
		duration: number;
		time: number;
	}>;
	streams: Map<string, { path: string; topic: string | null; subCount: number }>;
	pending: Map<string, { path: string; args: any[]; startTime: number }>;
} | null;

/**
 * Reactive derived topic subscription that auto-switches when a source store changes.
 * Re-exported from `svelte-adapter-uws/client`.
 *
 * @param topicFn - Function that computes the topic from the store value
 * @param store - Readable store whose value drives the topic
 *
 * @example
 * ```svelte
 * <script>
 *   import { onDerived } from 'svelte-realtime/client';
 *   const messages = onDerived((id) => `room:${id}`, roomId);
 * </script>
 * ```
 */
export function onDerived<T = unknown>(
	topicFn: (value: T) => string,
	store: Readable<T>
): Readable<WSEvent | null>;

/**
 * Discriminated union describing the cause of the most recent non-open
 * connection-status transition. The `kind` field tells you whether the
 * failure came from a WebSocket close frame (`'ws-close'`, with a numeric
 * `code`) or from the HTTP auth preflight (`'auth-preflight'`, with an
 * HTTP `status`). Re-exported from `svelte-adapter-uws/client`.
 *
 * - `TERMINAL` - server permanently rejected the client (1008 / 4401 / 4403). Retry loop stopped.
 * - `EXHAUSTED` - `maxReconnectAttempts` hit; the network never recovered.
 * - `THROTTLE` - server signalled rate-limiting (4429). Reconnect still scheduled, jumped ahead in the backoff curve.
 * - `RETRY` - normal transient drop (1006 abnormal, network blip, server restart). Reconnect in progress.
 * - `AUTH` - auth preflight (`{ auth: true }`) failed before the WebSocket was opened. 4xx is terminal; 5xx and network errors retry.
 */
export type Failure =
	| { kind: 'ws-close'; class: 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' | 'RETRY'; code: number; reason: string }
	| { kind: 'auth-preflight'; class: 'AUTH'; status: number; reason: string };

/**
 * The `class` field of a `Failure`. Re-exported from
 * `svelte-adapter-uws/client` for apps that need to type a switch over
 * the failure class without importing the full union.
 */
export type FailureClass = 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' | 'RETRY' | 'AUTH';

/**
 * Cause of the most recent non-open status transition. `null` while
 * connected, or before any failure has occurred. Set on TERMINAL /
 * THROTTLE / RETRY close codes, on the reconnect cap being exhausted
 * (`'EXHAUSTED'`), and on auth-preflight failures (`'AUTH'`). Cleared
 * on the next successful `'open'`. NOT set on an intentional `close()`
 * call - `failure === null` paired with the underlying status of
 * `'failed'` is the deliberately-ended state.
 *
 * Pair with the connection status to render targeted UI per failure
 * cause: "Session expired" for `class: 'TERMINAL'`, "Server is busy"
 * for `'THROTTLE'`, generic "Reconnecting" for `'RETRY'`, etc.
 *
 * Re-exported from `svelte-adapter-uws/client`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { failure } from 'svelte-realtime/client';
 *   import { status } from 'svelte-adapter-uws/client';
 * </script>
 *
 * {#if $failure?.class === 'TERMINAL'}
 *   <p class="error">Session expired. <a href="/login">Sign in again</a></p>
 * {:else if $failure?.class === 'EXHAUSTED'}
 *   <button onclick={() => location.reload()}>Reconnect</button>
 * {:else if $failure?.class === 'THROTTLE'}
 *   <p class="warn">Server is busy, retrying shortly...</p>
 * {:else if $failure?.class === 'AUTH'}
 *   <p class="error">Could not authenticate (HTTP {$failure.status})</p>
 * {:else if $status === 'disconnected'}
 *   <span>Reconnecting...</span>
 * {/if}
 * ```
 */
export const failure: Readable<Failure | null>;

/**
 * Reactive store holding the connection status. Re-exported from
 * `svelte-adapter-uws/client`. The generated `live.multiplayer()` namespace
 * exposes this as its `status` view.
 */
export const status: Readable<string>;

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
 * seed - to get the identical draw sequence on the client, the server, and every
 * replay. The same generator `live.smooth`'s `apply` receives as `ctx.rng`.
 */
export function createSharedRandom(seed?: number): SharedRandom;

/**
 * Deterministic `hsl(...)` color for a stable user key. The same key yields
 * the same color on the server and on every client, so server-rendered markup
 * and the first client paint agree without a hydration mismatch. Use it to
 * stamp a per-user color on a roster or cursor entry.
 */
export function colorForKey(key: string): string;
/** Raw deterministic hue (0..359) for a stable user key. */
export function hueForKey(key: string): number;

/**
 * Reactive store that emits `true` when every active stream has
 * finished loading (or errored) and `false` while at least one is
 * fetching or recovering. Initial value is `true` (no streams yet).
 *
 * Useful for rendering a single page-level loading state instead of
 * per-stream spinners, and for detecting "all streams have caught up
 * after a reconnect" - watch for a `false -> true` transition while
 * the adapter's connection status is `'open'`.
 *
 * Streams contribute to the in-flight count from their first
 * subscriber until they reach `'connected'` or `'error'`. A stream
 * with no consumers does not count.
 *
 * @example
 * ```svelte
 * <script>
 *   import { quiescent } from 'svelte-realtime/client';
 *   import { auditFeed, presence, reactions } from '$live/dashboard';
 *   const a = auditFeed.subscribe(/ * ... * /);
 * </script>
 *
 * {#if !$quiescent}
 *   <Spinner />
 * {/if}
 * <Dashboard />
 * ```
 *
 * @example
 * ```js
 * // Detect "we just caught up after a reconnect"
 * import { quiescent } from 'svelte-realtime/client';
 * import { status } from 'svelte-adapter-uws/client';
 *
 * let prev = true;
 * let sawDisconnect = false;
 * status.subscribe((s) => { if (s !== 'open') sawDisconnect = true; });
 * quiescent.subscribe((q) => {
 *   if (q && !prev && sawDisconnect) {
 *     sawDisconnect = false;
 *     console.log('reconnected and all streams caught up');
 *   }
 *   prev = q;
 * });
 * ```
 */
export const quiescent: Readable<boolean>;

/**
 * Reactive store reflecting the realtime system's health, sourced from
 * `degraded` / `recovered` events on the `__realtime` system topic.
 * Initial value is `'healthy'`; flips to `'degraded'` on a server-
 * published `degraded` event, back to `'healthy'` on `recovered`.
 *
 * Used to render a "real-time updates paused - reconnecting" banner
 * when the upstream pub/sub bus's circuit breaker trips. The
 * extensions package's `createPubSubBus` publishes these events on
 * the default `__realtime` channel; this store surfaces them on the
 * client without wiring the topic by hand.
 *
 * Subscription is lazy: the realtime client only subscribes to
 * `__realtime` once a consumer first subscribes to this store. Apps
 * that never read `health` pay no cost for the subscription.
 *
 * The store deliberately exposes only the state, not the underlying
 * payload. Apps that need richer detail (reason, timestamp, etc.)
 * can listen to the topic directly:
 * `import { on } from 'svelte-adapter-uws/client'; on('__realtime').subscribe(...)`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { health } from 'svelte-realtime/client';
 * </script>
 *
 * {#if $health === 'degraded'}
 *   <Banner severity="warn">Real-time updates paused, reconnecting...</Banner>
 * {/if}
 * ```
 */
export const health: Readable<'healthy' | 'degraded' | 'outdated'>;

/** The precomputed client mitigation a degradation policy attached to the `degraded` event. */
export interface DegradationMitigation {
	/** Stream topics to treat as unavailable while degraded. */
	streams?: string[];
	/** RPC paths to treat as unavailable while degraded. */
	rpcs?: string[];
	/** How long (ms) to hold off before retrying. */
	retryAfterMs?: number;
	/** Ready-to-render notice text. */
	bannerCopy?: string;
}

/** The recovered-event hint a degradation policy attached. */
export interface DegradationRecovery {
	refetch?: boolean;
	clearCache?: boolean;
	bannerCopy?: string;
}

/**
 * Richer companion to `health`: the server-pushed degradation detail. `active` tracks
 * the server breaker state (not the local flow / smooth / crdt inputs that also move
 * `health`); `mitigation` carries the precomputed client action while degraded;
 * `recovery` carries the recovered-event hint. Sourced from the same `__realtime`
 * system events; when the degraded event was pushed with a jitter window, this store
 * updates after this client's local de-herd delay. Additive - `health` stays a string.
 *
 * @example
 * ```svelte
 * <script>
 *   import { degradation } from 'svelte-realtime/client';
 * </script>
 *
 * {#if $degradation.active && $degradation.mitigation}
 *   <Banner severity="warn">{$degradation.mitigation.bannerCopy}</Banner>
 * {/if}
 * ```
 */
export const degradation: Readable<{ active: boolean; mitigation: DegradationMitigation | null; recovery: DegradationRecovery | null }>;
