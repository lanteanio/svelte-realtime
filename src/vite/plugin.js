// @ts-check
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve, relative, sep } from 'path';
import { VIRTUAL_PREFIX, REGISTRY_ID, REGISTRY_PUBLIC_ID, DEVTOOLS_ID, DEVTOOLS_PUBLIC_ID, SERVER_ID, SERVER_PUBLIC_ID } from './constants.js';
import { _fileCache, _codeCache, _warnedExports, _readCached, _readChangedSource } from './source-cache.js';
import { _writeTypeDeclarations } from './codegen-types.js';
import { _checkHooksFile, _buildTopicsRegistry, _generateRegistry, _resolveFile } from './codegen-registry.js';
import { _generateSsrStubs } from './codegen-ssr.js';
import { _generateClientStubs } from './codegen-client.js';
import { _loadRegistryDirect, _hmrReloadRegistry, _loadServerModule, _serverModuleGraph } from './hmr.js';
import { _respellUnder, _canonicalLiveFile, _externalizeRealtime } from './paths.js';
import { _injectDevtools } from './devtools-inject.js';
import { _createRegistryQueue } from './registry-queue.js';
import { _includeGeneratedDeps, _generatedClientImports, CLIENT_DEP, DEVTOOLS_DEPS } from './optimize-deps.js';
import { REALTIME_ERROR_IDS, realtimeErrorMessage } from '../error-registry.js';
import { _installedSvelteVersion, _runeSubpathError } from './svelte-version.js';

/**
 * Vite plugin for svelte-realtime.
 * Resolves `$live/` imports to virtual modules with auto-generated client stubs.
 *
 * @param {import('../vite.js').SvelteRealtimeOptions} [options]
 * @returns {import('vite').Plugin}
 */
export default function svelteRealtime(options) {
	const dir = options?.dir || 'src/live';
	const interval = options?.crdt?.reconcileIntervalMs;
	const reconcileIntervalMs = typeof interval === 'number' && Number.isFinite(interval) && interval >= 0
		? Math.min(interval, 2147483647) : undefined;
	/** @type {string} */
	let root = '';
	/** @type {string | null} */
	let configRoot = null;
	/** @type {string} */
	let liveDir = '';
	/** @type {boolean} */
	let isSsr = false;
	/** @type {boolean} */
	let typedImports = options?.typedImports !== false;
	/** @type {boolean} */
	let devtools = options?.devtools !== false;
	/** @type {boolean} */
	let isDev = false;
	/** @type {{ major: number, minor: number, version: string } | null} */
	let svelteVersion = null;
	let registryStarting = false;
	const enqueueRegistry = _createRegistryQueue();
	// How long the first requests of a dev server wait for the live handlers.
	const STARTUP_HOLD_MS = 10000;
	/**
	 * The live file a reported path names, spelled under liveDir, or null when
	 * the path lies outside it.
	 * @param {string} file
	 */
	const ownedLiveFile = (file) => _canonicalLiveFile(liveDir, resolve(root, file));
	/** @type {Map<string, string>} */
	const handledVersions = new Map();
	/**
	 * Vite watches a module under every spelling it was imported with, so on
	 * Windows one save or delete can arrive once per spelling, and an atomic
	 * rename can report one write as several events. Record the write (its
	 * mtime and content) of a live file, keyed by its liveDir spelling, and
	 * return it, or return null when that write was already handled. A later
	 * save has a new mtime even when its content is unchanged. A file that
	 * exists but cannot be read right now is never treated as handled.
	 * @param {string} file
	 * @param {string | undefined} [source]
	 * @returns {string | null}
	 */
	const claimVersion = (file, source) => {
		let version;
		try {
			const { mtimeMs } = statSync(file);
			version = mtimeMs + '\0' + (source ?? readFileSync(file, 'utf8'));
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
				handledVersions.delete(file);
				return '\0unreadable';
			}
			version = '\0absent';
		}
		if (handledVersions.get(file) === version) return null;
		handledVersions.set(file, version);
		return version;
	};
	/**
	 * Forget a write whose reload did not succeed, so saving it again retries.
	 * @param {string} file
	 * @param {string} version
	 */
	const releaseVersion = (file, version) => {
		if (handledVersions.get(file) === version) handledVersions.delete(file);
	};
	/**
	 * Whether a hook runs for the server graph. Vite 6+ environments carry
	 * the consumer; older Vite passes `ssr` in the hook options.
	 * @param {any} context
	 * @param {{ ssr?: boolean } | undefined} hookOptions
	 * @returns {boolean}
	 */
	const serverGraph = (context, hookOptions) =>
		hookOptions?.ssr ?? (context?.environment ? context.environment.config?.consumer === 'server' : isSsr);
	/** @param {unknown} error */
	const reportRegistryFailure = (error) => {
		console.error('[svelte-realtime] Registry reload failed:', error instanceof Error ? error.message : String(error));
	};

	return {
		name: 'svelte-realtime',

		configResolved(config) {
			// SvelteKit imports routes under the root as the user spelled it, and
			// so does svelte-adapter-uws for hooks in development. Vite 8 realpaths
			// its own root, which on Windows can change the drive letter's case. A
			// live module imported under both spellings would run twice and split
			// server state, so follow the user's spelling when only case differs.
			root = config.root;
			if (process.platform === 'win32' && configRoot && configRoot.split(sep).join('/').toLowerCase() === root.split(sep).join('/').toLowerCase()) {
				root = configRoot;
			}
			liveDir = resolve(root, dir);
			isSsr = !!config.build?.ssr;
			isDev = config.command === 'serve';
			svelteVersion = _installedSvelteVersion(root);
			// Vite otherwise discovers these client entries on the first page
			// load and reloads the page once for each, which can abort the
			// first navigation. Runs before the caches below are cleared, so
			// generating the client modules here leaves no warning recorded.
			if (isDev && !config.isPreview && config.optimizeDeps) {
				_includeGeneratedDeps(config.root, config.optimizeDeps, !!config.resolve?.preserveSymlinks, devtools ? DEVTOOLS_DEPS : [CLIENT_DEP],
					() => _generatedClientImports(liveDir, dir, reconcileIntervalMs, svelteVersion));
			}
			_fileCache.clear();
				_codeCache.clear();
				_warnedExports.clear();
		},

		buildStart() {
			// SvelteKit 3 shares one plugin instance between the client and SSR
			// environments of a build, so config() never sees build.ssr. The
			// Kit 2 SSR build gets the registry through its input in config().
			if (!isDev && !isSsr && this.environment?.name === 'ssr') {
				this.emitFile({ type: 'chunk', id: REGISTRY_ID, fileName: '__live-registry.js' });
			}
			_fileCache.clear();
				_codeCache.clear();
				_warnedExports.clear();
			if (!existsSync(liveDir)) {
				console.warn(
					`[svelte-realtime] Plugin loaded but no live modules found in ${dir}/\n  See: https://svti.me/start`
				);
			} else {
				if (typedImports) {
					_writeTypeDeclarations(liveDir, dir);
				}
				_checkHooksFile(root, liveDir, dir);
			}
		},

		configEnvironment(name, config) {
			if (name !== 'ssr') return;
			// Vite 8 passes a context with the bundler version; Vite 6 passes none.
			const key = this?.meta?.rolldownVersion || config.build?.rolldownOptions ? 'rolldownOptions' : 'rollupOptions';
			// Vite 8 reads rollupOptions only while rolldownOptions is unset, so
			// returning rolldownOptions carries the legacy options along.
			const legacy = key === 'rolldownOptions' && !config.build?.rolldownOptions ? config.build?.rollupOptions : undefined;
			const output = legacy ? { ...legacy } : { external: config.build?.[key]?.external };
			_externalizeRealtime(output);
			// Vite 6 can share build options between environments. Return a new
			// object so the SSR external list cannot leak into the client build.
			return { build: { [key]: output } };
		},

		resolveId(id, importer, resolveOptions) {
			if (id === DEVTOOLS_PUBLIC_ID || id === DEVTOOLS_ID) return DEVTOOLS_ID;
			// The registry is server-only: it enumerates every
			// registered RPC / stream / cron / webhook path and its module URLs
			// disclose the dev machine's absolute paths, so it must never
			// resolve for the client graph - an anonymous HTTP client of a dev
			// server could otherwise fetch it. Mirrors the transform gate below.
			// The server re-export module is server-only too.
			const ssr = serverGraph(this, resolveOptions);
			if (id === REGISTRY_ID || id === REGISTRY_PUBLIC_ID) return ssr ? REGISTRY_ID : null;
			if (id === SERVER_ID) return ssr ? SERVER_ID : null;
			if (id === SERVER_PUBLIC_ID) {
				if (ssr) return SERVER_ID;
				// The development alias for bare `svelte-realtime` applies to every
				// environment. A client-graph import of it, such as a live module in
				// a jsdom test, gets the package's own server entry, as it did before
				// the alias existed; that file is public package code, unlike the
				// registry.
				return this.resolve('svelte-realtime/server', importer, { ...resolveOptions, skipSelf: true });
			}
			if (id.startsWith('$live/')) {
				const modulePath = id.slice(6); // strip '$live/'
				// Shared helper modules (e.g. board.shared.js) are plain modules the app
				// imports on both sides; resolve them to the real file on disk so their
				// non-live exports pass through untouched - no client stub, and no false
				// not-wrapped-in-live() scan. Strip a trailing .js/.ts so _resolveFile finds it.
				if (/\.shared(\.[jt]s)?$/.test(modulePath)) {
					const real = _resolveFile(liveDir, modulePath.replace(/\.[jt]s$/, ''));
					if (real) return real;
				}
				const file = _resolveFile(liveDir, modulePath);
				if (file) return VIRTUAL_PREFIX + relative(liveDir, file).split(sep).join('/').replace(/\.(?:[jt]s|mjs)$/, '');
				return VIRTUAL_PREFIX + modulePath;
			}
			return null;
		},

		load(id, loadOptions) {
			const ssr = serverGraph(this, loadOptions);
			if (id === DEVTOOLS_ID) {
				return isDev && devtools ? "import { __devtools } from 'svelte-realtime/client';\nif (__devtools) window.__svelte_realtime_devtools = __devtools;\nimport('svelte-realtime/devtools');" : '';
			}
			if (id === SERVER_ID) return ssr ? "export * from 'svelte-realtime/server';" : null;

			// Registry module (server graph only).
			if (id === REGISTRY_ID) {
				// This gate - not the resolveId one - is what actually closes client
				// access. Vite skips resolveId whenever a module node already exists
				// in that environment's graph, so a stale client-graph node (or an
				// /@id/-prefixed or query-suffixed request) can carry the id straight
				// here. Do not drop this as redundant.
				if (!ssr) return null;
				const srcDir = resolve(root, 'src');
				const topicsRegistry = _buildTopicsRegistry(srcDir, liveDir);
				return _generateRegistry(liveDir, dir, topicsRegistry, isDev);
			}

			// $live/ virtual module
			if (id.startsWith(VIRTUAL_PREFIX)) {
				let modulePath = id.slice(VIRTUAL_PREFIX.length);
				const filePath = _resolveFile(liveDir, modulePath);

				if (!filePath) {
					this.error(realtimeErrorMessage(
						REALTIME_ERROR_IDS.LIVE_RESOLVE,
						modulePath + ' - file not found in ' + dir + '/'
					));
					return null;
				}
				modulePath = relative(liveDir, filePath).split(sep).join('/').replace(/\.(?:[jt]s|mjs)$/, '');

				// Code gen cache: avoid re-parsing when source content hasn't changed
				const cacheKey = (ssr ? 'ssr:' : 'client:') + filePath;
				const source = _readCached(filePath);
				const cached = _codeCache.get(cacheKey);
				if (cached && cached.content === source && (ssr || cached.reconcileIntervalMs === reconcileIntervalMs)) {
					return cached.code;
				}

				let code;
				if (ssr) {
					code = _generateSsrStubs(filePath, modulePath, dir);
				} else {
					code = _generateClientStubs(filePath, modulePath, dir, reconcileIntervalMs);
					const runeError = _runeSubpathError(code, modulePath, svelteVersion);
					if (runeError) {
						this.error(runeError);
						return null;
					}
				}

				_codeCache.set(cacheKey, { content: source, code, reconcileIntervalMs });
				return code;
			}

			return null;
		},

		transform(code, id, options) {
			// Co-locate the live registry with the WebSocket hooks module in
			// dev. svelte-adapter-uws loads src/hooks.ws.* via ssrLoadModule and
			// binds its `message` handler to whatever `svelte-realtime/server`
			// instance that load produced. On a cold `npm run dev`, Vite's
			// first-run dependency optimization tears down and rebuilds the SSR
			// module graph, so the registry load fired on the server's
			// 'listening' event can land in a DIFFERENT `svelte-realtime/server`
			// instance than the one the adapter's `message` reads - leaving the
			// registry empty and every RPC / stream failing with "no such live
			// function registered" until a restart with a warm cache. Importing
			// the registry FROM the hooks module makes it a dependency in the
			// exact same graph, so the handler and its registrations always share
			// one instance - the first `npm run dev` behaves identically to every
			// one after it. Production builds package the registry as its own
			// SSR chunk (config() for Kit 2, buildStart() for Kit 3), so this
			// dev-only seam never touches built output.
			if (!isDev) return null;
			// Only the server (SSR) graph loads hooks.ws; gating on ssr keeps
			// the server-side registry import out of any client bundle even if
			// a client module ever pulled the hooks file in.
			if (!serverGraph(this, options)) return null;
			const clean = id.split('?')[0].split(sep).join('/');
			// Scope to THIS project's src/hooks.ws.{js,ts,mjs} (root-anchored so a
			// sibling package's hooks file in a monorepo is never rewritten with
			// our registry). Mirrors the .js/.ts/.mjs set the adapter discovers.
			// Windows may report the root under another drive-letter case.
			const rootNorm = root.split(sep).join('/');
			const inRoot = _respellUnder(rootNorm, clean, '/');
			if (!inRoot) return null;
			const hooksPath = inRoot.slice(rootNorm.endsWith('/') ? rootNorm.length : rootNorm.length + 1);
			if (!/^src\/hooks\.ws\.(?:js|ts|mjs)$/.test(hooksPath)) return null;
			if (code.includes(REGISTRY_PUBLIC_ID)) return null;
			return { code: `import '${REGISTRY_PUBLIC_ID}';\n` + code, map: null };
		},

		config(config, { command }) {
			// The root SvelteKit and svelte-adapter-uws use: the configured one
			// or the working directory, as the user spelled it.
			configRoot = config.root ? resolve(config.root) : process.cwd();
			if (command === 'serve') {
				// Keep the server's mutable registry on one Node instance. SSR
				// optimization can change the version query of unbundled package
				// files, leaving old hooks attached to a different runtime.
				config.ssr ??= {};
				if (config.ssr.external !== true) {
					config.ssr.external = [...new Set([...(config.ssr.external ?? []), 'svelte-realtime/server'])];
				}
				// The bare package exports the same server entry. Route it through
				// its re-export module without externalizing client rune subpaths.
				// User aliases retain priority, including custom server replacements.
				config.resolve ??= {};
				const aliases = config.resolve.alias ?? [];
				config.resolve.alias = [
					...(Array.isArray(aliases) ? aliases : Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))),
					{ find: /^svelte-realtime$/, replacement: SERVER_PUBLIC_ID }
				];
			}
			// During SSR build, inject the registry as an additional input
			if (command === 'build' && config.build?.ssr) {
				config.build.rollupOptions ??= {};
				const input = config.build.rollupOptions.input;
				if (typeof input === 'object' && !Array.isArray(input)) {
					input['__live-registry'] = REGISTRY_ID;
				} else if (Array.isArray(input)) {
					const obj = {};
					for (let i = 0; i < input.length; i++) obj[`entry${i}`] = input[i];
					obj['__live-registry'] = REGISTRY_ID;
					config.build.rollupOptions.input = obj;
				} else if (typeof input === 'string') {
					config.build.rollupOptions.input = { index: input, '__live-registry': REGISTRY_ID };
				} else {
					config.build.rollupOptions.input = { '__live-registry': REGISTRY_ID };
				}

				// Keep svelte-realtime imports as bare specifiers so the registry
				// and ws-handler resolve to the same Node module instance at runtime.
				// Without this, Vite rewrites the import to a chunk-relative path,
				// creating a separate module instance with its own registry Map.
				_externalizeRealtime(config.build.rollupOptions);
			}
		},

		configureServer(server) {
			registryStarting = !!server.httpServer;
			// On first transform, load the registry to populate server-side state
			let registryLoaded = false;
			/** @type {Promise<unknown> | null} */
			let startup = null;

			// Load the development tools as a Vite module from every HTML page,
			// streamed or not (works with SvelteKit and plain Vite apps).
			const base = server.config?.base || '/';
			const script = devtools ? '<script type="module" src="' + base + DEVTOOLS_PUBLIC_ID.slice(1) + '"></script>' : null;
			// Hold requests until the startup registry load has finished. The
			// realtime server module imports itself through its submodules, so
			// Vite hands a concurrent importer the partly evaluated instance: a
			// first page load racing the startup load failed with live() or
			// live.stream unavailable until a restart.
			if (script !== null || server.httpServer) {
				server.middlewares.use((_req, res, next) => {
					if (script !== null) _injectDevtools(res, script);
					if (startup === null) return next();
					startup.then(() => next(), () => next());
				});
			}

			server.httpServer?.once('listening', () => {
				if (registryLoaded) return;
				registryLoaded = true;
				registryStarting = false;
				const loading = enqueueRegistry(async () => {
					if (!existsSync(liveDir)) return;
					_fileCache.clear();
					_codeCache.clear();
					_warnedExports.clear();
					if (typedImports) _writeTypeDeclarations(liveDir, dir);
					try {
						await _loadServerModule(server, REGISTRY_PUBLIC_ID);
					} catch {
						await _loadRegistryDirect(server, liveDir, dir);
					}

					// Client warmup here ends Vite's initial dependency crawl before
					// the first page contributes its imports. Let that page start the
					// crawl; configResolved already includes generated client deps.
				}).catch(reportRegistryFailure);
				// A live module whose top level never settles would hold every
				// request forever, so the hold ends after a bound with one warning.
				const held = new Promise(resolve => {
					const timer = setTimeout(() => { // determinism-allow: bounds a Vite development request hold, outside the realtime runtime
						console.warn(`[svelte-realtime] Live handlers are still loading after ${STARTUP_HOLD_MS / 1000} s; serving requests without waiting for them.\n  See: https://svti.me/vite`);
						resolve(undefined);
					}, STARTUP_HOLD_MS);
					// The hold must not keep a closing dev server's process alive.
					timer.unref?.();
					const release = () => {
						clearTimeout(timer); // determinism-allow: pairs the development request hold above
						resolve(undefined);
					};
					loading.then(release);
					server.httpServer?.once('close', release);
				});
				startup = held;
				held.then(() => { if (startup === held) startup = null; });
				return loading;
			});

			// Watch for new or deleted files in src/live/ - these don't trigger
			// handleHotUpdate since they're not in the module graph yet (add) or
			// have already been removed (unlink).
			for (const event of ['add', 'unlink']) {
				server.watcher.on(event, (reported) => {
					const file = ownedLiveFile(reported);
					if (!file) return;
					if (!/\.[jt]s$/.test(file) || file.endsWith('.d.ts') || file.endsWith('.test.js') || file.endsWith('.test.ts')) return;
					// Startup enumeration sees additions made before the listener runs.
					if (registryStarting) return;
					// A rejected watcher listener would end the dev server, so log
					// failures the way Vite's own add and unlink listeners do.
					return enqueueRegistry(async () => { await reloadWrite(server, file, null); }).catch((error) => {
						console.error(`[svelte-realtime] Could not reload live handlers after ${event} of ${reported}:`, error);
					});
				});
			}
		},

		async handleHotUpdate({ file: reported, server, read }) {
			const file = ownedLiveFile(reported);
			if (!file) return;
			// The generated $types.d.ts must never re-enter this handler: the
			// rewrite below would bump its mtime, produce the next change event
			// and loop forever, full-reloading every connected client each time.
			// Returning [] tells Vite the update is handled with no modules
			// affected, so it does not fall back to a full reload.
			if (file.endsWith('.d.ts')) return [];
			// Same non-module filter as the add/unlink watcher.
			if (!/\.[jt]s$/.test(file) || file.endsWith('.test.js') || file.endsWith('.test.ts')) return;
			if (registryStarting) return [];
			return enqueueRegistry(async () => {
				// A repeated event for an already handled write skips the server
				// reload. It runs after that reload in the queue, so its client
				// update never runs ahead of the handlers.
				const reloaded = await reloadWrite(server, file, resolve(root, reported), read);
				// A save whose reload failed updates no module: an SSR update would
				// make Vite reload the whole server graph, and the WebSocket hooks
				// would then load a new runtime without the restored handlers.
				if (reloaded === false) return [];

				// Client-side: invalidate the virtual module so the browser picks up new stubs
				const rel = relative(liveDir, file).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
				const mod = server.moduleGraph.getModuleById(VIRTUAL_PREFIX + rel);
				if (mod) {
					server.moduleGraph.invalidateModule(mod);
					return [mod];
				}
			});
		}
	};

	/**
	 * Reload the server handlers for one write of a live file, unless an
	 * earlier event already handled that write. Runs inside the registry
	 * queue: an event that repeats a write whose reload failed claims the
	 * write again and retries, so a persistent failure logs once per event.
	 * @param {any} server
	 * @param {string} file - The live file, spelled under liveDir
	 * @param {string | null} reported - The path a change event named, or null for add/unlink
	 * @param {() => Promise<string>} [read] Vite's settled source reader for change events
	 * @returns {Promise<boolean | undefined>} Whether the reload registered the handlers; undefined when an earlier event handled this write
	 */
	async function reloadWrite(server, file, reported, read) {
		// Watchers can report truncation before the write has filled the file.
		// Use one settled source for the version, declarations and registry.
		let source;
		try { source = read ? await read() : await _readChangedSource(file); }
		catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
		}
		const version = claimVersion(file, source);
		if (version === null) return;
		let reloaded = false;
		try {
			if (reported === null) {
				_fileCache.clear();
				_codeCache.clear();
				_warnedExports.clear();
			} else {
				_fileCache.delete(file);
				_codeCache.delete('client:' + file);
				_codeCache.delete('ssr:' + file);
			}
			if (source !== undefined) _fileCache.set(file, source);

			// Regenerate type declarations on file change
			if (typedImports) _writeTypeDeclarations(liveDir, dir);

			// Server-side HMR: invalidate the changed module so Vite re-executes
			// it, under each spelling it may have been imported with. An add can
			// name a file the graph still holds: an editor that saves by
			// replacing the file reports unlink and add instead of a change.
			const graph = _serverModuleGraph(server);
			for (const spelling of new Set(reported === null ? [file] : [file, reported])) {
				const ssrMods = graph.getModulesByFile(spelling.split(sep).join('/'));
				if (ssrMods) {
					for (const m of ssrMods) graph.invalidateModule(m);
				}
			}

			// Re-register all server handlers
			const rel = relative(liveDir, file).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
			reloaded = await _hmrReloadRegistry(server, liveDir, dir, rel, file);
		} finally {
			if (!reloaded) releaseVersion(file, version);
		}
		return reloaded;
	}
}
