// @ts-check
import { copyErrorMetadata } from './shared/error-metadata.js';
import { hasErrorBrand, RPC_ERROR_BRAND, LIVE_ERROR_BRAND } from './shared/error-brand.js';
// The shared hooks file runs in the browser too, so import the two error
// classes directly rather than through the client and server entries.
import { RpcError } from './client/rpc-error.js';
import { LiveError } from './server/live-error.js';

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
 * @param {Record<string, { encode: (value: any) => any, decode: (encoded: any) => any }>} [extras]
 * @returns {Record<string, { encode: (value: any) => any, decode: (encoded: any) => any }>}
 */
export function realtimeTransport(extras) {
	const base = {
		RpcError: {
			encode: (value) => hasErrorBrand(value, RPC_ERROR_BRAND) && [value.code, value.message, /** @type {any} */ (value).issues, copyErrorMetadata(value)],
			decode: ([code, message, issues, metadata]) => {
				const err = new RpcError(code, message, metadata);
				if (issues !== undefined) /** @type {any} */ (err).issues = issues;
				return err;
			}
		},
		LiveError: {
			encode: (value) => hasErrorBrand(value, LIVE_ERROR_BRAND) && [value.code, value.message, copyErrorMetadata(value)],
			decode: ([code, message, metadata]) => new LiveError(code, message, metadata)
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
