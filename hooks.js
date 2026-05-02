// @ts-check
import { RpcError } from './client.js';
import { LiveError } from './server.js';

/**
 * SvelteKit `transport` hook preset that auto-registers serialization for
 * `RpcError` and `LiveError` across the SSR / client boundary.
 *
 * Without this, a typed error thrown during a `+page.server.js` `load()`
 * arrives at `+error.svelte` as a plain `Error` instance with no `code`
 * field. With it, the typed `code` survives hydration so the error page
 * (and any client-side handler that rethrows the load error) can render
 * targeted UI per cause.
 *
 * Wire from the shared `src/hooks.js` (NOT `hooks.server.js`) -- both
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
 * @param {Record<string, { encode: (value: any) => any, decode: (encoded: any) => any }>} [extras]
 * @returns {Record<string, { encode: (value: any) => any, decode: (encoded: any) => any }>}
 */
export function realtimeTransport(extras) {
	const base = {
		RpcError: {
			encode: (value) => value instanceof RpcError && [value.code, value.message, /** @type {any} */ (value).issues],
			decode: ([code, message, issues]) => {
				const err = new RpcError(code, message);
				if (issues !== undefined) /** @type {any} */ (err).issues = issues;
				return err;
			}
		},
		LiveError: {
			encode: (value) => value instanceof LiveError && [value.code, value.message],
			decode: ([code, message]) => new LiveError(code, message)
		}
	};
	if (!extras) return base;
	if (typeof extras !== 'object') {
		throw new Error('[svelte-realtime] realtimeTransport: extras must be an object map of { encode, decode } entries');
	}
	for (const [name, entry] of Object.entries(extras)) {
		if (!entry || typeof entry.encode !== 'function' || typeof entry.decode !== 'function') {
			throw new Error(`[svelte-realtime] realtimeTransport: extras['${name}'] must be { encode, decode } with both as functions`);
		}
	}
	return { ...base, ...extras };
}
