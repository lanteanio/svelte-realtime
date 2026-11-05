/**
 * A single SvelteKit transport entry. `encode` runs during server-side
 * serialization; return a JSON-serializable representation of the value,
 * or a falsy value to signal "not this type" (so SvelteKit can try other
 * transports). `decode` runs during client-side hydration to reconstruct
 * the original value.
 */
export interface TransportEntry {
	encode(value: unknown): unknown;
	decode(encoded: any): unknown;
}

/**
 * Map of type-name to `{ encode, decode }` entry, matching SvelteKit's
 * `transport` hook signature.
 */
export type TransportMap = Record<string, TransportEntry>;

/**
 * SvelteKit `transport` hook preset that registers serialization for
 * `RpcError` and `LiveError` across the SSR / client boundary.
 *
 * An error that a `load` function or form action returns inside its data
 * reaches the browser as the same class with its `code`, `params` and
 * `details`. Without this, SvelteKit cannot serialize the instance and the
 * request fails. A `load` that throws goes through SvelteKit's
 * `handleError` hook instead, which decides what `+error.svelte` receives.
 *
 * Wire from the shared `src/hooks.js` (NOT `hooks.server.js`) - both
 * the server's `encode` and the client's `decode` need to be visible
 * during build, and SvelteKit's transport hook is a shared-context
 * primitive.
 *
 * @example
 * ```js
 * // src/hooks.js
 * import { realtimeTransport } from 'svelte-realtime/hooks';
 *
 * export const transport = realtimeTransport();
 * ```
 *
 * @example
 * ```js
 * // Compose with app-defined types (user entries win on key conflict):
 * import { realtimeTransport } from 'svelte-realtime/hooks';
 * import { Vector } from '$lib/geometry';
 *
 * export const transport = realtimeTransport({
 *   Vector: {
 *     encode: (v) => v instanceof Vector && [v.x, v.y],
 *     decode: ([x, y]) => new Vector(x, y)
 *   }
 * });
 * ```
 *
 * @param extras Additional transport entries to merge alongside the
 *   built-in `RpcError` and `LiveError` registrations. User entries
 *   win on key conflict - override the defaults if your app needs
 *   different serialization for either of them.
 */
export function realtimeTransport(extras?: TransportMap): TransportMap;
