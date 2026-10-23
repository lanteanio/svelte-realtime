// @ts-check
import { existsSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';

export const CLIENT_DEP = 'svelte-realtime/client';
export const DEVTOOLS_DEPS = [CLIENT_DEP, 'svelte-realtime/devtools'];

/**
 * Add the realtime entry points that only generated modules import to the
 * client's dependency optimization, so Vite optimizes them before the first
 * page load. Vite's dependency scan skips virtual modules, so it would meet
 * them only when the warmup or the browser requests those modules, optimize
 * again and reload every open page. Vite never discovers a package it serves
 * from source (linked outside node_modules, or excluded), and with discovery
 * off it optimizes only what it is told to, so those setups are left as
 * configured: an optimized client next to source modules that import
 * `./client.js` directly would run two client instances. Called with the
 * resolved client options, after every plugin and environment hook has
 * adjusted them.
 * @param {string} root
 * @param {{ include?: string[], exclude?: string[], noDiscovery?: boolean, disabled?: boolean | 'build' | 'dev' }} optimizeDeps
 * @param {boolean} preserveSymlinks
 * @param {readonly string[]} ids
 */
export function _includeGeneratedDeps(root, optimizeDeps, preserveSymlinks, ids) {
	if (optimizeDeps.noDiscovery || optimizeDeps.disabled === true || optimizeDeps.disabled === 'dev') return;
	const exclude = optimizeDeps.exclude ?? [];
	if (exclude.includes('svelte-realtime')) return;
	const fromRoot = createRequire(resolve(root, 'package.json'));
	let entry;
	try {
		entry = realpathSync(fromRoot.resolve(CLIENT_DEP));
	} catch {
		return;
	}
	// Vite discovers only what it resolves into node_modules. It follows a
	// link to its target unless preserveSymlinks keeps the link's own path.
	const installed = preserveSymlinks
		? !!fromRoot.resolve.paths('svelte-realtime')?.some(dir => existsSync(resolve(dir, 'svelte-realtime', 'package.json')))
		: /[\\/]node_modules[\\/]/.test(entry);
	if (!installed) return;
	const include = (optimizeDeps.include ??= []);
	for (const id of ids) {
		if (!exclude.includes(id) && !include.includes(id)) include.push(id);
	}
}
