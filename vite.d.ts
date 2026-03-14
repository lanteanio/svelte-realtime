import type { Plugin } from 'vite';

export interface SvelteRealtimeOptions {
	/**
	 * Directory containing live modules.
	 * @default 'src/live'
	 */
	dir?: string;

	/**
	 * Generate `$types.d.ts` in the live directory for typed `$live/` imports.
	 * Strips the `ctx` parameter from live functions and wraps streams in `Readable<T>`.
	 * @default true
	 */
	typedImports?: boolean;

	/**
	 * Enable the in-browser DevTools overlay in dev mode.
	 * Toggle with Ctrl+Shift+L. Shows active streams, pending RPCs, and connection status.
	 * Stripped from production builds.
	 * @default true
	 */
	devtools?: boolean;
}

/**
 * Vite plugin for svelte-realtime.
 *
 * Resolves `$live/` imports to virtual modules:
 * - On the server (SSR): re-exports the real module from `src/live/`
 * - On the client: generates lightweight stubs that call `__rpc()` / `__stream()`
 *
 * @example
 * ```js
 * // vite.config.js
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import uws from 'svelte-adapter-uws/vite';
 * import realtime from 'svelte-realtime/vite';
 *
 * export default { plugins: [sveltekit(), uws(), realtime()] };
 * ```
 */
export default function svelteRealtime(options?: SvelteRealtimeOptions): Plugin;
