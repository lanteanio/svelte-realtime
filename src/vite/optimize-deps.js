// @ts-check
import { existsSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';

export const CLIENT_DEP = 'svelte-realtime/client';
export const DEVTOOLS_DEPS = [CLIENT_DEP, 'svelte-realtime/devtools'];
/**
 * The svelte-adapter-uws entry points the realtime client modules import.
 * An optimized realtime client bundles them; a realtime served from source
 * imports them on the first page load.
 */
export const ADAPTER_CLIENT_DEPS = ['svelte-adapter-uws/client', 'svelte-adapter-uws/plugins/smooth/random'];

const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;

/** @param {string} id */
function packageName(id) {
	const parts = id.split('/');
	return id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Whether `id` resolves into a node_modules directory from `from`. Vite
 * follows a link to its target unless preserveSymlinks keeps the link's own
 * path, and it discovers only what resolves into node_modules.
 * @param {NodeJS.Require} from
 * @param {string} id
 * @param {boolean} preserveSymlinks
 */
function resolvesInstalled(from, id, preserveSymlinks) {
	let file;
	try {
		file = realpathSync(from.resolve(id));
	} catch {
		return false;
	}
	if (!preserveSymlinks) return NODE_MODULES_RE.test(file);
	const name = packageName(id);
	return !!from.resolve.paths(name)?.some(dir => existsSync(resolve(dir, name, 'package.json')));
}

/**
 * Vite skips an excluded id and every id of an excluded package.
 * @param {string[]} exclude
 * @param {string} id
 */
function excluded(exclude, id) {
	return exclude.includes(id) || exclude.includes(packageName(id));
}

/**
 * Add the client entry points Vite would otherwise meet only on the first
 * page load to the client's dependency optimization, so Vite optimizes them
 * before that load instead of optimizing again and reloading every open page.
 *
 * An installed svelte-realtime gets the realtime entry points that only
 * generated modules import: Vite's dependency scan skips virtual modules.
 * A svelte-realtime that Vite serves from source (linked outside
 * node_modules) stays served from source: an optimized client next to source
 * modules that import `./client.js` directly would run two client instances.
 * Its client modules still import svelte-adapter-uws from node_modules, which
 * Vite discovers when the browser requests them, so those entries are added
 * when both the realtime source and the app resolve them into node_modules.
 * Vite bundles the app's resolution and hands it to every importer of the
 * same id. Nothing is added that Vite would not discover on its own: not with
 * discovery off, not an excluded id, and not the imports of an excluded
 * svelte-realtime under node_modules. Called with the resolved client
 * options, after every plugin and environment hook has adjusted them.
 * @param {string} root
 * @param {{ include?: string[], exclude?: string[], noDiscovery?: boolean, disabled?: boolean | 'build' | 'dev' }} optimizeDeps
 * @param {boolean} preserveSymlinks
 * @param {readonly string[]} ids
 * @param {readonly string[]} [sourceIds]
 */
export function _includeGeneratedDeps(root, optimizeDeps, preserveSymlinks, ids, sourceIds = ADAPTER_CLIENT_DEPS) {
	if (optimizeDeps.noDiscovery || optimizeDeps.disabled === true || optimizeDeps.disabled === 'dev') return;
	const exclude = optimizeDeps.exclude ?? [];
	const fromRoot = createRequire(resolve(root, 'package.json'));
	let entry;
	try {
		entry = realpathSync(fromRoot.resolve(CLIENT_DEP));
	} catch {
		return;
	}
	const fromRealtime = createRequire(entry);
	const add = resolvesInstalled(fromRoot, CLIENT_DEP, preserveSymlinks)
		? ids
		: sourceIds.filter(id => resolvesInstalled(fromRealtime, id, preserveSymlinks) && resolvesInstalled(fromRoot, id, preserveSymlinks));
	const include = (optimizeDeps.include ??= []);
	for (const id of add) {
		if (!excluded(exclude, id) && !include.includes(id)) include.push(id);
	}
}
