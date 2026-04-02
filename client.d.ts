import type { Readable } from 'svelte/store';
import type { WSEvent } from 'svelte-adapter-uws/client';

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
};

/**
 * Create a reactive stream store for a given path.
 * Used by generated client stubs -- not called directly by users.
 *
 * The store value is:
 * - `undefined` while loading
 * - The initial data once loaded
 * - Automatically updated with live pub/sub events
 * - `{ error: RpcError }` if the initial fetch fails
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
