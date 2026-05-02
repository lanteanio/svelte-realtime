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
 * Used by generated client stubs -- not called directly by users.
 *
 * @param path - RPC path (e.g. `'chat/sendMessage'`)
 * @returns An async function that sends the RPC and returns the result
 *
 * @internal
 */
export function __rpc(path: string): ((...args: any[]) => Promise<any>) & {
	/** Bypass deduplication -- always send a fresh request. */
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
	 *   Per-call `timeout` is ignored inside `batch(fn)` -- the
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
};

/**
 * Create a reactive stream store for a given path.
 * Used by generated client stubs -- not called directly by users.
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
	/** Reactive store holding the current error, or null when healthy. Errors never replace the data store value. */
	readonly error: Readable<RpcError | null>;
	/** Reactive store holding the connection status: 'loading', 'connected', 'reconnecting', or 'error'. */
	readonly status: Readable<'loading' | 'connected' | 'reconnecting' | 'error'>;
	/** Apply an instant UI update. Returns a rollback function. */
	optimistic(event: string, data: any): () => void;
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
 * - `TERMINAL` -- server permanently rejected the client (1008 / 4401 / 4403). Retry loop stopped.
 * - `EXHAUSTED` -- `maxReconnectAttempts` hit; the network never recovered.
 * - `THROTTLE` -- server signalled rate-limiting (4429). Reconnect still scheduled, jumped ahead in the backoff curve.
 * - `RETRY` -- normal transient drop (1006 abnormal, network blip, server restart). Reconnect in progress.
 * - `AUTH` -- auth preflight (`{ auth: true }`) failed before the WebSocket was opened. 4xx is terminal; 5xx and network errors retry.
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
 * call -- `failure === null` paired with the underlying status of
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
