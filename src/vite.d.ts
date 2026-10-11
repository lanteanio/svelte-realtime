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

	/** Client settings shared by generated live.doc(), live.map(), and live.array() channels. */
	crdt?: {
		/**
		 * Background state-vector reconciliation interval in milliseconds.
		 * Zero disables it; invalid values use the adapter default.
		 * Finite intervals are capped at 2147483647 ms before reaching the adapter. @default 30000
		 */
		reconcileIntervalMs?: number;
	};
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

/** Options for declaration generation before a typecheck-only command. */
export interface GenerateTypesOptions {
	/** Project root, resolved from the working directory. Defaults to process.cwd(). */
	root?: string;
	/** Live module directory relative to root, matching the Vite plugin's dir. Defaults to 'src/live'. */
	dir?: string;
}

/**
 * Synchronously write $types.d.ts for all $live imports without running a build
 * or executing live modules. Reads current files on every call, removes stale
 * declarations when no live modules remain, and preserves unchanged output.
 * Does not load Vite configuration; pass the same dir used by the plugin.
 * Include the generated file in your typecheck and run this before svelte-check.
 */
export function generateTypes(options?: GenerateTypesOptions): void;
