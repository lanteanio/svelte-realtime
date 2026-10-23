// @ts-check
import { existsSync, readFileSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { relative, resolve, sep } from 'path';
import { _findLiveFiles } from './codegen-registry.js';
import { _generateClientStubs } from './codegen-client.js';
import { _runeSubpathError } from './svelte-version.js';

export const CLIENT_DEP = 'svelte-realtime/client';
export const DEVTOOLS_DEPS = [CLIENT_DEP, 'svelte-realtime/devtools'];
/**
 * The svelte-adapter-uws entry points the realtime client modules import.
 * An optimized realtime client bundles them; a realtime served from source
 * imports them on the first page load.
 */
export const ADAPTER_CLIENT_DEPS = ['svelte-adapter-uws/client', 'svelte-adapter-uws/plugins/smooth/random'];

const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;
const BARE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*['"]([^'"./][^'"]*)['"]/g;

/**
 * The packages the generated client modules of the app's live directory
 * import. Which ones depends on the export kinds the modules declare (a
 * smoothed entity, a CRDT document, a multiplayer or enumerable room), so the
 * modules are generated here the way the browser will request them. Their
 * warnings are left to that request, and a module whose rune features the
 * installed Svelte cannot run contributes nothing: its request fails with the
 * error that says so.
 * @param {string} liveDir
 * @param {string} dir
 * @param {number | undefined} reconcileIntervalMs
 * @param {{ major: number, minor: number, version: string } | null} svelte
 * @returns {string[]}
 */
export function _generatedClientImports(liveDir, dir, reconcileIntervalMs, svelte) {
	/** @type {Set<string>} */
	const found = new Set();
	const warn = console.warn;
	console.warn = () => {};
	try {
		for (const file of _findLiveFiles(liveDir)) {
			const modulePath = relative(liveDir, file).split(sep).join('/').replace(/\.(?:[jt]s|mjs)$/, '');
			let code;
			try {
				code = _generateClientStubs(file, modulePath, dir, reconcileIntervalMs);
			} catch {
				continue;
			}
			if (_runeSubpathError(code, modulePath, svelte)) continue;
			for (const m of code.matchAll(BARE_IMPORT_RE)) found.add(m[1]);
		}
	} finally {
		console.warn = warn;
	}
	return [...found];
}

/**
 * Whether every package the module at `file` imports resolves from it. A
 * module that imports a missing optional peer (the CRDT channel imports yjs)
 * would fail the whole optimizer run.
 * @param {string} file
 */
function importsResolve(file) {
	let code;
	try {
		code = readFileSync(file, 'utf8');
	} catch {
		return false;
	}
	const from = createRequire(file);
	for (const m of code.matchAll(BARE_IMPORT_RE)) {
		if (m[1].startsWith('node:')) continue;
		try {
			from.resolve(m[1]);
		} catch {
			return false;
		}
	}
	return true;
}

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
 * same id. The packages generated modules import for the export kinds the
 * app declares are the app's own imports: a realtime subpath
 * among them is added like the realtime entry points, any other package when
 * it and everything its entry module imports resolve from the app root, so a
 * missing optional peer cannot fail the optimizer run. Nothing is added that
 * Vite would not discover on its own: not with discovery off, not an
 * excluded id, and not the imports of an excluded svelte-realtime under
 * node_modules. Called with the resolved client options, after every plugin
 * and environment hook has adjusted them.
 * @param {string} root
 * @param {{ include?: string[], exclude?: string[], noDiscovery?: boolean, disabled?: boolean | 'build' | 'dev' }} optimizeDeps
 * @param {boolean} preserveSymlinks
 * @param {readonly string[]} ids
 * @param {() => readonly string[]} [generatedImports] the packages generated modules import
 * @param {readonly string[]} [sourceIds]
 */
export function _includeGeneratedDeps(root, optimizeDeps, preserveSymlinks, ids, generatedImports = () => [], sourceIds = ADAPTER_CLIENT_DEPS) {
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
	const generated = generatedImports();
	const add = resolvesInstalled(fromRoot, CLIENT_DEP, preserveSymlinks)
		? [...ids, ...generated.filter(id => packageName(id) === 'svelte-realtime')]
		: sourceIds.filter(id => resolvesInstalled(fromRealtime, id, preserveSymlinks) && resolvesInstalled(fromRoot, id, preserveSymlinks));
	for (const id of generated) {
		if (packageName(id) === 'svelte-realtime' || !resolvesInstalled(fromRoot, id, preserveSymlinks)) continue;
		if (importsResolve(fromRoot.resolve(id))) add.push(id);
	}
	const include = (optimizeDeps.include ??= []);
	for (const id of add) {
		if (!excluded(exclude, id) && !include.includes(id)) include.push(id);
	}
}
