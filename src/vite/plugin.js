// @ts-check
import { existsSync } from 'fs';
import { resolve, relative, sep } from 'path';
import { VIRTUAL_PREFIX, REGISTRY_ID } from './constants.js';
import { _fileCache, _codeCache, _warnedExports, _readCached } from './source-cache.js';
import { _writeTypeDeclarations } from './codegen-types.js';
import { _checkHooksFile, _buildTopicsRegistry, _generateRegistry, _resolveFile, _findLiveFiles } from './codegen-registry.js';
import { _generateSsrStubs } from './codegen-ssr.js';
import { _generateClientStubs } from './codegen-client.js';
import { _loadRegistryDirect, _hmrReloadRegistry } from './hmr.js';

/**
 * Vite plugin for svelte-realtime.
 * Resolves `$live/` imports to virtual modules with auto-generated client stubs.
 *
 * @param {{ dir?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function svelteRealtime(options) {
	const dir = options?.dir || 'src/live';
	/** @type {string} */
	let root = '';
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

	return {
		name: 'svelte-realtime',

		configResolved(config) {
			root = config.root;
			liveDir = resolve(root, dir);
			isSsr = !!config.build?.ssr;
			isDev = config.command === 'serve';
			_fileCache.clear();
				_codeCache.clear();
				_warnedExports.clear();
		},

		buildStart() {
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

		resolveId(id) {
			if (id === REGISTRY_ID) return REGISTRY_ID;
			if (id === '/@svelte-realtime-registry') return REGISTRY_ID;
			if (id.startsWith('$live/')) {
				const modulePath = id.slice(6); // strip '$live/'
				return VIRTUAL_PREFIX + modulePath;
			}
			return null;
		},

		load(id, loadOptions) {
			const ssr = loadOptions?.ssr ?? isSsr;

			// Registry module
			if (id === REGISTRY_ID) {
				const srcDir = resolve(root, 'src');
				const topicsRegistry = _buildTopicsRegistry(srcDir, liveDir);
				return _generateRegistry(liveDir, dir, topicsRegistry);
			}

			// $live/ virtual module
			if (id.startsWith(VIRTUAL_PREFIX)) {
				const modulePath = id.slice(VIRTUAL_PREFIX.length);
				const filePath = _resolveFile(liveDir, modulePath);

				if (!filePath) {
					this.error(`[svelte-realtime] Could not resolve $live/${modulePath} - file not found in ${dir}/`);
					return null;
				}

				// Code gen cache: avoid re-parsing when source content hasn't changed
				const cacheKey = (ssr ? 'ssr:' : 'client:') + filePath;
				const source = _readCached(filePath);
				const cached = _codeCache.get(cacheKey);
				if (cached && cached.content === source) {
					return cached.code;
				}

				let code;
				if (ssr) {
					code = _generateSsrStubs(filePath, modulePath);
				} else {
					code = _generateClientStubs(filePath, modulePath, dir);
				}

				_codeCache.set(cacheKey, { content: source, code });
				return code;
			}

			return null;
		},

		config(config, { command }) {
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
				const ext = config.build.rollupOptions.external;
				const svelteRealtimeRe = /^svelte-realtime(\/.*)?$/;
				if (Array.isArray(ext)) {
					ext.push(svelteRealtimeRe);
				} else if (typeof ext === 'string' || ext instanceof RegExp || typeof ext === 'function') {
					config.build.rollupOptions.external = [ext, svelteRealtimeRe];
				} else {
					config.build.rollupOptions.external = [svelteRealtimeRe];
				}
			}
		},

		configureServer(server) {
			// Inject devtools script into HTML responses (works with SvelteKit + traditional Vite)
			if (devtools) {
				const devtoolsScript = `<script type="module">
import { __devtools } from 'svelte-realtime/client';
if (__devtools) window.__svelte_realtime_devtools = __devtools;
import('svelte-realtime/devtools');
</script>`;
				server.middlewares.use((_req, res, next) => {
					const originalEnd = res.end;
					/** @type {any} */
					const _res = res;
					_res.end = function (/** @type {any} */ chunk, /** @type {any} */ ...args) {
						const contentType = res.getHeader('content-type');
						if (typeof contentType === 'string' && contentType.includes('text/html') && chunk) {
							const html = typeof chunk === 'string' ? chunk : chunk.toString();
							if (html.includes('</body>')) {
								chunk = html.replace('</body>', devtoolsScript + '</body>');
								res.removeHeader('content-length');
							} else if (html.includes('</head>')) {
								chunk = html.replace('</head>', devtoolsScript + '</head>');
								res.removeHeader('content-length');
							}
						}
						return originalEnd.call(this, chunk, ...args);
					};
					next();
				});
			}

			// On first transform, load the registry to populate server-side state
			let registryLoaded = false;

			server.httpServer?.once('listening', async () => {
				if (registryLoaded) return;
				registryLoaded = true;

				if (!existsSync(liveDir)) return;

				try {
					const code = _generateRegistry(liveDir, dir);
					// Use a temporary virtual module to load the registry
					const tempId = '/@svelte-realtime-registry';
					server.moduleGraph.ensureEntryFromUrl(tempId);
					await server.ssrLoadModule(tempId).catch(() => {
						// Fallback: try to load modules individually
						_loadRegistryDirect(server, liveDir, dir);
					});
				} catch {
					_loadRegistryDirect(server, liveDir, dir);
				}

				// Pre-warm virtual modules to eliminate cold-start waterfall
				try {
					const files = _findLiveFiles(liveDir);
					for (const file of files) {
						const rel = relative(liveDir, file).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
						server.warmupRequest(VIRTUAL_PREFIX + rel).catch(() => {});
					}
				} catch {}
			});

			// Watch for new or deleted files in src/live/ - these don't trigger
			// handleHotUpdate since they're not in the module graph yet (add) or
			// have already been removed (unlink).
			for (const event of ['add', 'unlink']) {
				server.watcher.on(event, async (file) => {
					file = file.split(sep).join('/');
					if (!file.includes('/' + dir + '/') && !file.startsWith(dir + '/')) return;
					if (!/\.[jt]s$/.test(file) || file.endsWith('.d.ts') || file.endsWith('.test.js') || file.endsWith('.test.ts')) return;

					_fileCache.clear();
				_codeCache.clear();
				_warnedExports.clear();

					if (typedImports) {
						_writeTypeDeclarations(liveDir, dir);
					}

					const rel = relative(liveDir, file).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
					await _hmrReloadRegistry(server, liveDir, dir, rel);
				});
			}
		},

		async handleHotUpdate({ file, server }) {
			if (!file.startsWith(liveDir)) return;
			_fileCache.delete(file);
			_codeCache.delete('client:' + file);
			_codeCache.delete('ssr:' + file);

			// Regenerate type declarations on file change
			if (typedImports) {
				_writeTypeDeclarations(liveDir, dir);
			}

			const rel = relative(liveDir, file)
				.replace(/\\/g, '/')
				.replace(/\.[jt]s$/, '');

			// Server-side HMR: invalidate the changed module so Vite re-executes it
			const ssrMods = server.moduleGraph.getModulesByFile(file);
			if (ssrMods) {
				for (const m of ssrMods) server.moduleGraph.invalidateModule(m);
			}

			// Re-register all server handlers
			await _hmrReloadRegistry(server, liveDir, dir, rel);

			// Client-side: invalidate the virtual module so the browser picks up new stubs
			const mod = server.moduleGraph.getModuleById(VIRTUAL_PREFIX + rel);
			if (mod) {
				server.moduleGraph.invalidateModule(mod);
				return [mod];
			}
		},

		transformIndexHtml() {
			// Devtools injection handled via configureServer middleware (works with SvelteKit)
			return [];
		}
	};
}
