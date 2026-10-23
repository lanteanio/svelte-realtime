// @ts-check
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { createRequire } from 'module';
import { dirname, relative, resolve, sep } from 'path';
import { _findLiveFiles } from './codegen-registry.js';
import { _generateClientStubs } from './codegen-client.js';
import { _runeSubpathError } from './svelte-version.js';
import { REALTIME_ERROR_IDS, realtimeErrorMessage } from '../error-registry.js';

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
// The import and re-export lines the client code generator writes. The
// clause before `from` holds only bindings, so a user's string literal that
// the generator copies into the module never reads as one.
const GENERATED_IMPORT_RE = /^(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s+)?'([^'\n]+)';$/gm;
// The export kinds whose generated code imports more than the realtime
// client. A module without one is not generated here.
const RUNTIME_EXPORT_RE = /export\s+const\s+[\w$]+\s*=\s*live\.(?:smooth|doc|map|array|multiplayer|room)\s*\(/;

/**
 * The imports found per live file, kept across dev server restarts in one
 * process and reused while the file's size and modification time stay put.
 * @type {Map<string, { mtimeMs: number, size: number, key: string, imports: string[] }>}
 */
const importCache = new Map();

/**
 * The packages the generated client modules of the app's live directory
 * import. Which ones depends on the export kinds the modules declare (a
 * smoothed entity, a CRDT document, a multiplayer or enumerable room), so the
 * modules that declare one are generated here the way the browser will
 * request them. Their warnings are left to that request, and a module whose
 * rune features the installed Svelte cannot run contributes nothing: its
 * request fails with the error that says so.
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
		const key = dir + '\0' + reconcileIntervalMs + '\0' + (svelte ? svelte.version : '');
		for (const file of _findLiveFiles(liveDir)) {
			let stat;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			let cached = importCache.get(file);
			if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size || cached.key !== key) {
				cached = { mtimeMs: stat.mtimeMs, size: stat.size, key, imports: fileImports(liveDir, file, dir, reconcileIntervalMs, svelte) };
				importCache.set(file, cached);
			}
			for (const id of cached.imports) found.add(id);
		}
	} finally {
		console.warn = warn;
	}
	return [...found];
}

/**
 * @param {string} liveDir
 * @param {string} file
 * @param {string} dir
 * @param {number | undefined} reconcileIntervalMs
 * @param {{ major: number, minor: number, version: string } | null} svelte
 * @returns {string[]}
 */
function fileImports(liveDir, file, dir, reconcileIntervalMs, svelte) {
	try {
		if (!RUNTIME_EXPORT_RE.test(readFileSync(file, 'utf8'))) return [];
		const modulePath = relative(liveDir, file).split(sep).join('/').replace(/\.(?:[jt]s|mjs)$/, '');
		const code = _generateClientStubs(file, modulePath, dir, reconcileIntervalMs);
		if (_runeSubpathError(code, modulePath, svelte)) return [];
		return [...code.matchAll(GENERATED_IMPORT_RE)].map(m => m[1]);
	} catch {
		return [];
	}
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

/**
 * The version of the package `name` that `file` belongs to, or null.
 * @param {string} file
 * @param {string} name
 */
function packageVersion(file, name) {
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		const manifest = resolve(dir, 'package.json');
		if (existsSync(manifest)) {
			try {
				const data = JSON.parse(readFileSync(manifest, 'utf8'));
				if (data.name === name) return typeof data.version === 'string' ? data.version : null;
			} catch {
				return null;
			}
		}
		if (dirname(dir) === dir) return null;
	}
}

/** @type {Set<string>} The version pairs already warned about in this process. */
const warnedSkew = new Set();

/**
 * Warn once per process and version pair when the linked svelte-realtime and
 * the app resolve different versions of the package of `id`.
 * @param {NodeJS.Require} fromRealtime
 * @param {NodeJS.Require} fromRoot
 * @param {string} id
 */
function warnVersionSkew(fromRealtime, fromRoot, id) {
	const name = packageName(id);
	const fileRealtime = realpathSync(fromRealtime.resolve(id));
	const fileRoot = realpathSync(fromRoot.resolve(id));
	if (fileRealtime === fileRoot) return;
	const realtimeVersion = packageVersion(fileRealtime, name);
	const appVersion = packageVersion(fileRoot, name);
	if (realtimeVersion === null || appVersion === null || realtimeVersion === appVersion) return;
	const key = realtimeVersion + '\0' + appVersion;
	if (warnedSkew.has(key)) return;
	warnedSkew.add(key);
	console.warn('[svelte-realtime] ' + realtimeErrorMessage(REALTIME_ERROR_IDS.ADAPTER_VERSION_SKEW,
		': svelte-realtime resolves ' + name + ' ' + realtimeVersion + ', the app ' + appVersion +
		". The dev server serves the app's copy to both; a build resolves svelte-realtime's own copy."));
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
 * Vite discovers when the browser requests them. Vite bundles the app's
 * resolution and hands it to every importer of the same id, so an entry is
 * added when the realtime source and the app both resolve it into
 * node_modules. Discovery would hand out one copy by id as well, so a
 * different version on the two sides changes nothing about which copy runs
 * in development; it gets a warning, since a build resolves the realtime
 * source's own copy.
 *
 * The packages generated modules import for the export kinds the app
 * declares are the app's own imports. A realtime subpath among them is added
 * like the realtime entry points. A package the realtime source imports too
 * is added on the same terms as above, so a realtime that runs the adapter
 * from source keeps a single client instance. Any package is added only when
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
	/** @param {string} id */
	const sharedWithRealtime = (id) => resolvesInstalled(fromRealtime, id, preserveSymlinks)
		&& resolvesInstalled(fromRoot, id, preserveSymlinks);
	/** @param {string} id */
	const realtimeImports = (id) => {
		try {
			fromRealtime.resolve(id);
			return true;
		} catch {
			return false;
		}
	};
	const generated = generatedImports();
	const installed = resolvesInstalled(fromRoot, CLIENT_DEP, preserveSymlinks);
	const add = installed
		? [...ids, ...generated.filter(id => packageName(id) === 'svelte-realtime')]
		: sourceIds.filter(sharedWithRealtime);
	// An excluded entry is loaded by each side from its own copy.
	const shared = installed ? undefined : add.find(id => !excluded(exclude, id));
	if (shared) warnVersionSkew(fromRealtime, fromRoot, shared);
	for (const id of generated) {
		if (packageName(id) === 'svelte-realtime') continue;
		if (realtimeImports(id) ? !sharedWithRealtime(id) : !resolvesInstalled(fromRoot, id, preserveSymlinks)) continue;
		if (importsResolve(fromRoot.resolve(id))) add.push(id);
	}
	const include = (optimizeDeps.include ??= []);
	for (const id of add) {
		if (!excluded(exclude, id) && !include.includes(id)) include.push(id);
	}
}
