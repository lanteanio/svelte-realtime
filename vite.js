// @ts-check
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, relative, dirname, sep, posix } from 'path';

const VIRTUAL_PREFIX = '\0live:';
const REGISTRY_ID = '\0live:__registry';
const LIVE_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\s*\(/g;
const VALIDATED_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.validated\s*\(/g;
const STREAM_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.stream\s*\(/g;
const GUARD_EXPORT_RE = /export\s+const\s+(_guard)\s*=\s*guard\s*\(/g;
const DYNAMIC_STREAM_RE = /export\s+const\s+(\w+)\s*=\s*live\.stream\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
const CRON_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.cron\s*\(/g;
const BINARY_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.binary\s*\(/g;
const DERIVED_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.derived\s*\(/g;
const ROOM_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.room\s*\(/g;
const WEBHOOK_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.webhook\s*\(/g;
const CHANNEL_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.channel\s*\(/g;
const DYNAMIC_CHANNEL_RE = /export\s+const\s+(\w+)\s*=\s*live\.channel\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
const RATE_LIMIT_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.rateLimit\s*\(/g;
const EFFECT_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.effect\s*\(/g;
const AGGREGATE_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.aggregate\s*\(/g;

/** @type {Map<string, string>} Cache file contents to avoid redundant reads within a build cycle */
const _fileCache = new Map();

/**
 * Read a file with caching. Returns cached content if available.
 * @param {string} filePath
 * @returns {string}
 */
function _readCached(filePath) {
	let content = _fileCache.get(filePath);
	if (content === undefined) {
		content = readFileSync(filePath, 'utf-8');
		_fileCache.set(filePath, content);
	}
	return content;
}

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
		enforce: 'pre',

		configResolved(config) {
			root = config.root;
			liveDir = resolve(root, dir);
			isSsr = !!config.build?.ssr;
			isDev = config.command === 'serve';
			_fileCache.clear();
		},

		buildStart() {
			_fileCache.clear();
			if (!existsSync(liveDir)) {
				console.warn(
					`[svelte-realtime] Plugin loaded but no live modules found in ${dir}/`
				);
			} else if (typedImports) {
				_writeTypeDeclarations(liveDir, dir);
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
				return _generateRegistry(liveDir, dir);
			}

			// $live/ virtual module
			if (id.startsWith(VIRTUAL_PREFIX)) {
				const modulePath = id.slice(VIRTUAL_PREFIX.length);
				const filePath = _resolveFile(liveDir, modulePath);

				if (!filePath) {
					this.error(`[svelte-realtime] Could not resolve $live/${modulePath} -- file not found in ${dir}/`);
					return null;
				}

				if (ssr) {
					// SSR: re-export the real server module, add .load() for streams
					return _generateSsrStubs(filePath, modulePath);
				}

				// Client: generate stubs
				return _generateClientStubs(filePath, modulePath, dir);
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
							} else if (html.includes('</head>')) {
								chunk = html.replace('</head>', devtoolsScript + '</head>');
							}
						}
						return originalEnd.call(this, chunk, ...args);
					};
					next();
				});
			}

			// On first transform, load the registry to populate server-side state
			let registryLoaded = false;
			const originalLoad = this.load;

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
			});

			// Watch for new or deleted files in src/live/ -- these don't trigger
			// handleHotUpdate since they're not in the module graph yet (add) or
			// have already been removed (unlink).
			for (const event of ['add', 'unlink']) {
				server.watcher.on(event, async (file) => {
					file = file.split(sep).join('/');
					if (!file.includes('/' + dir + '/') && !file.startsWith(dir + '/')) return;
					if (!/\.[jt]s$/.test(file) || file.endsWith('.d.ts') || file.endsWith('.test.js') || file.endsWith('.test.ts')) return;

					_fileCache.clear();

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

/**
 * Resolve a module path to a real file.
 * @param {string} liveDir
 * @param {string} modulePath
 * @returns {string | null}
 */
function _resolveFile(liveDir, modulePath) {
	const extensions = ['.js', '.ts', '.mjs'];
	for (const ext of extensions) {
		const full = resolve(liveDir, modulePath + ext);
		// Prevent path traversal outside the live directory
		if (!full.startsWith(liveDir + sep)) return null;
		if (existsSync(full)) return full;
	}
	return null;
}

/**
 * Generate SSR stubs for a live module.
 * Re-exports everything from the real module, and adds .load() wrappers for streams.
 * @param {string} filePath
 * @param {string} modulePath
 * @returns {string}
 */
function _generateSsrStubs(filePath, modulePath) {
	const normalized = filePath.split(sep).join(posix.sep);
	const source = _readCached(filePath);

	/** @type {string[]} */
	const storeNames = [];
	/** @type {Set<string>} */
	const dynamicNames = new Set();
	let match;

	// Detect dynamic (function-returning) streams and channels
	for (const re of [DYNAMIC_STREAM_RE, DYNAMIC_CHANNEL_RE]) {
		re.lastIndex = 0;
		while ((match = re.exec(source)) !== null) {
			dynamicNames.add(match[1]);
		}
	}

	// Collect all stream-like exports that need readable() wrappers for SSR
	for (const re of [STREAM_EXPORT_RE, CHANNEL_EXPORT_RE, DERIVED_EXPORT_RE, AGGREGATE_EXPORT_RE]) {
		re.lastIndex = 0;
		while ((match = re.exec(source)) !== null) {
			storeNames.push(match[1]);
		}
	}

	// If no store-like exports, simple re-export
	if (storeNames.length === 0) {
		return `export * from '${normalized}';\n`;
	}

	// Re-export non-stream exports, wrap store-like exports in readable() for SSR $ prefix support
	const lines = [
		`import { readable } from 'svelte/store';`,
		`import { __directCall } from 'svelte-realtime/server';`,
		`export * from '${normalized}';`
	];

	for (const name of storeNames) {
		if (dynamicNames.has(name)) {
			// Dynamic stream: return a readable store from a function so name(args) works during SSR
			lines.push(`const _${name} = (...args) => readable(undefined);`);
			lines.push(`_${name}.load = (platform, options) => __directCall('${modulePath}/${name}', options?.args || [], platform, options);`);
			lines.push(`export { _${name} as ${name} };`);
		} else {
			// Static stream: plain readable store
			lines.push(`const _${name} = readable(undefined);`);
			lines.push(`_${name}.load = (platform, options) => __directCall('${modulePath}/${name}', options?.args || [], platform, options);`);
			lines.push(`export { _${name} as ${name} };`);
		}
	}

	return lines.join('\n') + '\n';
}

/**
 * Generate client stubs for a live module.
 * @param {string} filePath
 * @param {string} modulePath
 * @param {string} dir
 * @returns {string}
 */
function _generateClientStubs(filePath, modulePath, dir) {
	const source = _readCached(filePath);

	/** @type {string[]} */
	const lines = [];
	/** @type {Set<string>} */
	const imports = new Set();
	/** @type {Set<string>} */
	const exportedNames = new Set();
	/** @type {boolean} */
	let hasGuard = false;

	// Detect live() exports
	let match;
	LIVE_EXPORT_RE.lastIndex = 0;
	while ((match = LIVE_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		exportedNames.add(name);
		imports.add('__rpc');
		lines.push(`export const ${name} = __rpc('${modulePath}/${name}');`);
	}

	// Detect live.validated() exports (treated same as live() on the client)
	VALIDATED_EXPORT_RE.lastIndex = 0;
	while ((match = VALIDATED_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__rpc');
			lines.push(`export const ${name} = __rpc('${modulePath}/${name}');`);
		}
	}

	// Detect live.rateLimit() exports (treated same as live() on the client)
	RATE_LIMIT_EXPORT_RE.lastIndex = 0;
	while ((match = RATE_LIMIT_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__rpc');
			lines.push(`export const ${name} = __rpc('${modulePath}/${name}');`);
		}
	}

	// Detect live.stream() exports — check for dynamic vs static topic
	/** @type {Set<string>} */
	const dynamicStreams = new Set();
	DYNAMIC_STREAM_RE.lastIndex = 0;
	while ((match = DYNAMIC_STREAM_RE.exec(source)) !== null) {
		dynamicStreams.add(match[1]);
	}

	STREAM_EXPORT_RE.lastIndex = 0;
	while ((match = STREAM_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		exportedNames.add(name);
		imports.add('__stream');
		const streamOptions = _extractStreamOptions(source, name);
		if (dynamicStreams.has(name)) {
			// Dynamic topic: generate a function wrapper that passes args
			lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify(streamOptions)}, true);`);
		} else {
			lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify(streamOptions)});`);
		}
	}

	// Detect live.channel() exports -- treated as streams on the client
	/** @type {Set<string>} */
	const dynamicChannels = new Set();
	DYNAMIC_CHANNEL_RE.lastIndex = 0;
	while ((match = DYNAMIC_CHANNEL_RE.exec(source)) !== null) {
		dynamicChannels.add(match[1]);
	}

	CHANNEL_EXPORT_RE.lastIndex = 0;
	while ((match = CHANNEL_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__stream');
			const channelOpts = _extractChannelOptions(source, name);
			if (dynamicChannels.has(name)) {
				lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify(channelOpts)}, true);`);
			} else {
				lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify(channelOpts)});`);
			}
		}
	}

	// Detect guard
	GUARD_EXPORT_RE.lastIndex = 0;
	if (GUARD_EXPORT_RE.exec(source) !== null) {
		hasGuard = true;
	}

	// Detect live.binary() exports
	BINARY_EXPORT_RE.lastIndex = 0;
	while ((match = BINARY_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__binaryRpc');
			lines.push(`export const ${name} = __binaryRpc('${modulePath}/${name}');`);
		}
	}

	// Detect live.derived() exports (treated as streams on the client)
	DERIVED_EXPORT_RE.lastIndex = 0;
	while ((match = DERIVED_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__stream');
			// Derived streams use 'set' merge by default
			lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify({ merge: 'set', key: 'id' })});`);
		}
	}

	// Detect live.room() exports -- generates data stream + presence stream + cursor stream + actions
	ROOM_EXPORT_RE.lastIndex = 0;
	while ((match = ROOM_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__stream');
			imports.add('__rpc');
			// Room generates a namespace object with data, presence, cursors, and actions
			// Extract room config to determine which sub-streams exist
			const roomInfo = _extractRoomInfo(source, name);
			const roomLines = [];
			roomLines.push(`export const ${name} = {`);
			roomLines.push(`  data: __stream('${modulePath}/${name}/__data', ${JSON.stringify(roomInfo.dataOpts)}, true),`);
			if (roomInfo.hasPresence) {
				roomLines.push(`  presence: __stream('${modulePath}/${name}/__presence', ${JSON.stringify({ merge: 'presence', key: 'key' })}, true),`);
			}
			if (roomInfo.hasCursors) {
				roomLines.push(`  cursors: __stream('${modulePath}/${name}/__cursors', ${JSON.stringify({ merge: 'cursor', key: 'key' })}, true),`);
			}
			// Actions are RPCs
			for (const action of roomInfo.actions) {
				roomLines.push(`  ${action}: __rpc('${modulePath}/${name}/__action/${action}'),`);
			}
			roomLines.push(`};`);
			lines.push(roomLines.join('\n'));
		}
	}

	// Mark webhook exports as known (server-only, no client stub)
	WEBHOOK_EXPORT_RE.lastIndex = 0;
	while ((match = WEBHOOK_EXPORT_RE.exec(source)) !== null) {
		exportedNames.add(match[1]);
	}

	// Mark cron exports as known (they are server-only, no client stub needed)
	CRON_EXPORT_RE.lastIndex = 0;
	while ((match = CRON_EXPORT_RE.exec(source)) !== null) {
		exportedNames.add(match[1]);
	}

	// Mark effect exports as known (server-only, no client stub needed)
	EFFECT_EXPORT_RE.lastIndex = 0;
	while ((match = EFFECT_EXPORT_RE.exec(source)) !== null) {
		exportedNames.add(match[1]);
	}

	// Detect live.aggregate() exports (treated as streams on the client)
	AGGREGATE_EXPORT_RE.lastIndex = 0;
	while ((match = AGGREGATE_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__stream');
			lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify({ merge: 'set', key: 'id' })});`);
		}
	}

	// Dev warnings for non-live exports
	const allExportRe = /export\s+(?:const|function|let|var|class)\s+(\w+)/g;
	allExportRe.lastIndex = 0;
	while ((match = allExportRe.exec(source)) !== null) {
		const name = match[1];
		if (name === '_guard' || exportedNames.has(name)) continue;
		if (name.startsWith('_')) {
			// Reserved names starting with _ (except _guard)
			console.warn(
				`[svelte-realtime] ${dir}/${modulePath} exports '${name}' starting with _ -- reserved for internal use`
			);
			continue;
		}
		console.warn(
			`[svelte-realtime] ${dir}/${modulePath} exports '${name}' which is not wrapped in live() -- it won't be callable from the client. Did you forget live()?`
		);
	}

	if (exportedNames.size === 0 && !hasGuard) {
		console.warn(
			`[svelte-realtime] ${dir}/${modulePath} has no live() or live.stream() exports`
		);
	}

	const importLine = imports.size > 0
		? `import { ${[...imports].join(', ')} } from 'svelte-realtime/client';\n`
		: '';

	return importLine + lines.join('\n') + '\n';
}

/**
 * Extract stream options from source code.
 * @param {string} source
 * @param {string} name
 * @returns {{ merge?: string, key?: string, prepend?: boolean, max?: number }}
 */
function _extractStreamOptions(source, name) {
	// Find the live.stream() call for this export
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\(\\s*(['"\`])([^'"\`]+)\\1`,
		's'
	);
	const match = pattern.exec(source);

	/** @type {any} */
	const opts = { merge: 'crud', key: 'id' };

	if (!match) return opts;

	// Try to extract the options object (3rd argument)
	// Find the closing of live.stream( ... )
	const startIdx = /** @type {number} */ (match.index) + match[0].length;
	const rest = source.slice(startIdx);

	// Look for options object like { merge: 'crud', key: 'id', prepend: true }
	const optMatch = rest.match(/,\s*\{([^}]+)\}/);
	if (optMatch) {
		const optStr = optMatch[1];

		const mergeMatch = optStr.match(/merge\s*:\s*['"](\w+)['"]/);
		if (mergeMatch) opts.merge = mergeMatch[1];

		const keyMatch = optStr.match(/key\s*:\s*['"](\w+)['"]/);
		if (keyMatch) opts.key = keyMatch[1];

		const prependMatch = optStr.match(/prepend\s*:\s*(true|false)/);
		if (prependMatch) opts.prepend = prependMatch[1] === 'true';

		const maxMatch = optStr.match(/max\s*:\s*(\d+)/);
		if (maxMatch) opts.max = parseInt(maxMatch[1], 10);

		const replayMatch = optStr.match(/replay\s*:\s*(true|false|\{[^}]*\})/);
		if (replayMatch && replayMatch[1] !== 'false') opts.replay = true;

		const versionMatch = optStr.match(/version\s*:\s*(\d+)/);
		if (versionMatch) opts.version = parseInt(versionMatch[1], 10);
	}

	return opts;
}

/**
 * Extract channel options from source code.
 * @param {string} source
 * @param {string} name
 * @returns {{ merge?: string, key?: string, max?: number }}
 */
function _extractChannelOptions(source, name) {
	/** @type {any} */
	const opts = { merge: 'set', key: 'id' };

	// Look for the options object in live.channel(topic, { ... })
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.channel\\s*\\(`,
		's'
	);
	const match = pattern.exec(source);
	if (!match) return opts;

	const startIdx = match.index + match[0].length;
	const rest = source.slice(startIdx);

	const optMatch = rest.match(/,\s*\{([^}]+)\}/);
	if (optMatch) {
		const optStr = optMatch[1];
		const mergeMatch = optStr.match(/merge\s*:\s*['"](\w+)['"]/);
		if (mergeMatch) opts.merge = mergeMatch[1];
		const keyMatch = optStr.match(/key\s*:\s*['"](\w+)['"]/);
		if (keyMatch) opts.key = keyMatch[1];
		const maxMatch = optStr.match(/max\s*:\s*(\d+)/);
		if (maxMatch) opts.max = parseInt(maxMatch[1], 10);
	}

	return opts;
}

/**
 * Extract room configuration info from source code for client stub generation.
 * @param {string} source
 * @param {string} name
 * @returns {{ dataOpts: any, hasPresence: boolean, hasCursors: boolean, actions: string[] }}
 */
function _extractRoomInfo(source, name) {
	const info = { dataOpts: { merge: 'crud', key: 'id' }, hasPresence: false, hasCursors: false, actions: [] };

	// Find the start of live.room({ ... }) call
	const startPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.room\\s*\\(`
	);
	const startMatch = startPattern.exec(source);
	if (!startMatch) return info;

	// Extract the config object body using brace matching
	const afterOpen = source.slice(startMatch.index + startMatch[0].length);
	const body = _extractBraceContent(afterOpen);
	if (!body) return info;

	// Check for presence
	if (/presence\s*:/.test(body)) info.hasPresence = true;
	// Check for cursors
	if (/cursors\s*:/.test(body)) info.hasCursors = true;

	// Extract merge mode
	const mergeMatch = body.match(/merge\s*:\s*['"](\w+)['"]/);
	if (mergeMatch) info.dataOpts.merge = mergeMatch[1];

	// Extract key field
	const keyMatch = body.match(/key\s*:\s*['"](\w+)['"]/);
	if (keyMatch) info.dataOpts.key = keyMatch[1];

	// Extract action names from actions: { ... }
	const actionsIdx = body.search(/actions\s*:\s*\{/);
	if (actionsIdx !== -1) {
		const afterActions = body.slice(body.indexOf('{', actionsIdx));
		const actionsBody = _extractBraceContent(afterActions);
		if (actionsBody) {
			// Match property names: "name:" or "async name(" patterns
			const actionPattern = /(?:async\s+)?(\w+)\s*(?:\(|:)/g;
			let m;
			while ((m = actionPattern.exec(actionsBody)) !== null) {
				const actionName = m[1];
				if (actionName !== 'async') info.actions.push(actionName);
			}
		}
	}

	return info;
}

/**
 * Extract content between matching braces { ... } respecting nesting.
 * Input should start at or before the opening brace.
 * @param {string} str
 * @returns {string | null}
 */
function _extractBraceContent(str) {
	const start = str.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < str.length; i++) {
		if (str[i] === '{') depth++;
		else if (str[i] === '}') {
			depth--;
			if (depth === 0) return str.slice(start + 1, i);
		}
	}
	return null;
}

/**
 * Generate the registry module that imports all live functions.
 * @param {string} liveDir
 * @param {string} dir
 * @returns {string}
 */
function _generateRegistry(liveDir, dir) {
	if (!existsSync(liveDir)) return '// No live modules found\n';

	const files = _findLiveFiles(liveDir);
	const lines = [
		`import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate } from 'svelte-realtime/server';\n`
	];

	/** @type {Set<string>} */
	const seenTopics = new Set();
	let importIdx = 0;

	for (const filePath of files) {
		const rel = relative(liveDir, filePath).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
		const source = _readCached(filePath);
		const alias = `_m${importIdx++}`;
		const normalizedPath = filePath.split(sep).join(posix.sep);

		lines.push(`import * as ${alias} from '${normalizedPath}';`);

		// Register live() exports
		/** @type {Set<string>} */
		const registered = new Set();
		let match;
		LIVE_EXPORT_RE.lastIndex = 0;
		while ((match = LIVE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			registered.add(name);
			lines.push(`__register('${rel}/${name}', ${alias}.${name});`);
		}

		// Register live.validated() exports
		VALIDATED_EXPORT_RE.lastIndex = 0;
		while ((match = VALIDATED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${alias}.${name});`);
			}
		}

		// Register live.rateLimit() exports
		RATE_LIMIT_EXPORT_RE.lastIndex = 0;
		while ((match = RATE_LIMIT_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${alias}.${name});`);
			}
		}

		// Register live.stream() exports
		STREAM_EXPORT_RE.lastIndex = 0;
		while ((match = STREAM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			lines.push(`__register('${rel}/${name}', ${alias}.${name});`);

			// Check for duplicate stream topics
			const topicPattern = new RegExp(
				`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`
			);
			const topicMatch = topicPattern.exec(source);
			if (topicMatch) {
				const topic = topicMatch[1];
				if (topic.startsWith('__')) {
					console.error(
						`[svelte-realtime] ${dir}/${rel} uses reserved topic '${topic}' -- topics starting with __ are reserved for internal use`
					);
				}
				if (seenTopics.has(topic)) {
					console.error(
						`[svelte-realtime] Duplicate stream topic '${topic}' in ${dir}/${rel} -- each topic must be unique across all modules`
					);
				}
				seenTopics.add(topic);
			}
		}

		// Register guard
		GUARD_EXPORT_RE.lastIndex = 0;
		if (GUARD_EXPORT_RE.exec(source) !== null) {
			lines.push(`__registerGuard('${rel}', ${alias}._guard);`);
		}

		// Register live.binary() exports
		BINARY_EXPORT_RE.lastIndex = 0;
		while ((match = BINARY_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${alias}.${name});`);
			}
		}

		// Register cron jobs
		CRON_EXPORT_RE.lastIndex = 0;
		while ((match = CRON_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			lines.push(`__registerCron('${rel}/${name}', ${alias}.${name});`);
		}

		// Register live.derived() exports
		DERIVED_EXPORT_RE.lastIndex = 0;
		while ((match = DERIVED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${alias}.${name});`);
				lines.push(`__registerDerived('${rel}/${name}', ${alias}.${name});`);
			}
		}

		// Register live.room() exports -- register sub-streams and actions
		ROOM_EXPORT_RE.lastIndex = 0;
		while ((match = ROOM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				// Register the data stream
				lines.push(`if (${alias}.${name}.__dataStream) __register('${rel}/${name}/__data', ${alias}.${name}.__dataStream);`);
				// Register presence stream if present
				lines.push(`if (${alias}.${name}.__presenceStream) __register('${rel}/${name}/__presence', ${alias}.${name}.__presenceStream);`);
				// Register cursor stream if present
				lines.push(`if (${alias}.${name}.__cursorStream) __register('${rel}/${name}/__cursors', ${alias}.${name}.__cursorStream);`);
				// Register actions
				lines.push(`if (${alias}.${name}.__actions) { for (const [k, v] of Object.entries(${alias}.${name}.__actions)) __register('${rel}/${name}/__action/' + k, v); }`);
			}
		}

		// Webhook exports are server-only (no registration needed in client registry)
		WEBHOOK_EXPORT_RE.lastIndex = 0;
		while ((match = WEBHOOK_EXPORT_RE.exec(source)) !== null) {
			registered.add(match[1]);
		}

		// Register live.channel() exports (treated like streams)
		CHANNEL_EXPORT_RE.lastIndex = 0;
		while ((match = CHANNEL_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${alias}.${name});`);
			}
		}

		// Register live.effect() exports
		EFFECT_EXPORT_RE.lastIndex = 0;
		while ((match = EFFECT_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__registerEffect('${rel}/${name}', ${alias}.${name});`);
			}
		}

		// Register live.aggregate() exports
		AGGREGATE_EXPORT_RE.lastIndex = 0;
		while ((match = AGGREGATE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${alias}.${name});`);
				lines.push(`__registerAggregate('${rel}/${name}', ${alias}.${name});`);
			}
		}
	}

	return lines.join('\n') + '\n';
}

/**
 * Recursively find all .js/.ts files in the live directory.
 * @param {string} dir
 * @returns {string[]}
 */
function _findLiveFiles(dir) {
	/** @type {string[]} */
	const results = [];
	if (!existsSync(dir)) return results;

	for (const entry of readdirSync(dir)) {
		const full = resolve(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(..._findLiveFiles(full));
		} else if (/\.[jt]s$/.test(entry) && !entry.endsWith('.d.ts') && !entry.endsWith('.test.js') && !entry.endsWith('.test.ts')) {
			results.push(full);
		}
	}

	return results;
}

/**
 * Generate and write type declarations for all $live/ modules.
 * Creates `$types.d.ts` in the live directory with ambient module declarations.
 * @param {string} liveDir
 * @param {string} dir
 */
function _writeTypeDeclarations(liveDir, dir) {
	const content = _generateTypeDeclarations(liveDir, dir);
	if (content) {
		writeFileSync(resolve(liveDir, '$types.d.ts'), content);
	}
}

/**
 * Generate ambient module declarations for all $live/ modules.
 * For TS files, attempts to extract real parameter/return types.
 * For JS files, falls back to `any`.
 * @param {string} liveDir
 * @param {string} dir
 * @returns {string}
 */
function _generateTypeDeclarations(liveDir, dir) {
	if (!existsSync(liveDir)) return '';

	const files = _findLiveFiles(liveDir);
	if (files.length === 0) return '';

	const declarations = [
		'// Auto-generated by svelte-realtime — do not edit',
		'// Provides client-side types for $live/ imports',
		''
	];

	for (const filePath of files) {
		const rel = relative(liveDir, filePath).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
		const source = _readCached(filePath);
		const isTS = filePath.endsWith('.ts');

		/** @type {string[]} */
		const exports = [];
		let needsReadable = false;
		let needsRpcError = false;

		// Detect live() exports
		let match;
		LIVE_EXPORT_RE.lastIndex = 0;
		while ((match = LIVE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (isTS) {
				const sig = _extractFunctionSignature(source, name);
				exports.push(`  export const ${name}: ${sig};`);
			} else {
				exports.push(`  export const ${name}: (...args: any[]) => Promise<any>;`);
			}
		}

		// Detect live.validated() exports (same as live() for types)
		VALIDATED_EXPORT_RE.lastIndex = 0;
		while ((match = VALIDATED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			// Only add if not already detected by LIVE_EXPORT_RE
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				exports.push(`  export const ${name}: (...args: any[]) => Promise<any>;`);
			}
		}

		// Extract thrown LiveError codes for typed error unions
		const errorCodes = _extractErrorCodes(source);
		if (errorCodes.length > 0) {
			needsRpcError = true;
			const union = errorCodes.map(c => `'${c}'`).join(' | ');
			exports.push(`  export type ErrorCode = ${union};`);
		}

		// Detect live.stream() exports
		STREAM_EXPORT_RE.lastIndex = 0;
		while ((match = STREAM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			needsReadable = true;
			needsRpcError = true;
			if (isTS) {
				const returnType = _extractStreamReturnType(source, name);
				exports.push(`  export const ${name}: Readable<${returnType} | undefined | { error: RpcError }>;`);
			} else {
				exports.push(`  export const ${name}: Readable<any>;`);
			}
		}

		if (exports.length > 0) {
			declarations.push(`declare module '$live/${rel}' {`);
			if (needsReadable) {
				declarations.push("  import type { Readable } from 'svelte/store';");
			}
			if (needsRpcError) {
				declarations.push("  import type { RpcError } from 'svelte-realtime/client';");
			}
			if (needsReadable || needsRpcError) {
				declarations.push('');
			}
			declarations.push(...exports);
			declarations.push('}');
			declarations.push('');
		}
	}

	return declarations.join('\n');
}

/**
 * Extract thrown LiveError codes from source for typed error unions.
 * Scans for `throw new LiveError('CODE', ...)` patterns.
 * @param {string} source
 * @returns {string[]}
 */
function _extractErrorCodes(source) {
	const re = /throw\s+new\s+LiveError\s*\(\s*['"](\w+)['"]/g;
	/** @type {Set<string>} */
	const codes = new Set();
	let m;
	while ((m = re.exec(source)) !== null) {
		codes.add(m[1]);
	}
	return [...codes].sort();
}

/**
 * Extract client-side function signature from a TS source, stripping the ctx first param.
 * Falls back to `(...args: any[]) => Promise<any>` if parsing fails.
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function _extractFunctionSignature(source, name) {
	const fallback = '(...args: any[]) => Promise<any>';

	// Match: export const name = live(async (ctx: Type, param1: T1, param2: T2): ReturnType => {
	// or:    export const name = live(async (ctx, param1: T1) => {
	// Uses .+? for return type to handle nested generics like Promise<{ id: number }>
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\s*\\(\\s*(?:async\\s+)?` +
		`\\(([^)]*)\\)\\s*(?::\\s*(.+?))?\\s*=>`,
		's'
	);
	const match = pattern.exec(source);
	if (!match) return fallback;

	const paramsStr = match[1].trim();
	const returnType = match[2]?.trim() || 'Promise<any>';

	// Split params, drop the first one (ctx)
	const params = _splitParams(paramsStr);
	params.shift(); // remove ctx

	const clientParams = params.length > 0 ? params.join(', ') : '';
	const clientParamsStr = clientParams ? `(${clientParams})` : '()';

	// Normalize return type - ensure it's wrapped in Promise
	let normalizedReturn = returnType;
	if (!normalizedReturn.startsWith('Promise<')) {
		normalizedReturn = `Promise<${normalizedReturn}>`;
	}

	return `${clientParamsStr} => ${normalizedReturn}`;
}

/**
 * Extract the return type of a stream's initFn for type declarations.
 * Falls back to `any` if parsing fails.
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function _extractStreamReturnType(source, name) {
	// Match: export const name = live.stream('topic', async (ctx): Promise<Type[]> => {
	// Uses balanced angle bracket matching for nested generics
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\([^,]+,\\s*` +
		`(?:async\\s+)?\\([^)]*\\)\\s*(?::\\s*(.+?))?\\s*=>`,
		's'
	);
	const match = pattern.exec(source);
	if (!match || !match[1]) return 'any';

	const returnAnnotation = match[1].trim();
	// Unwrap Promise<T> to get T
	const promiseMatch = returnAnnotation.match(/^Promise\s*<\s*(.+)\s*>$/s);
	if (promiseMatch) return promiseMatch[1].trim();
	return returnAnnotation;
}

/**
 * Split a parameter string respecting nested generics and destructuring.
 * @param {string} str
 * @returns {string[]}
 */
function _splitParams(str) {
	if (!str.trim()) return [];
	const params = [];
	let depth = 0;
	let current = '';
	for (const ch of str) {
		if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth++;
		else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			params.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) params.push(current.trim());
	return params;
}

/**
 * Invalidate the registry virtual module, clear all server-side registrations,
 * and re-import the registry so handlers are updated. If the re-import fails
 * (e.g. syntax error), restores the previous handlers so the server keeps working.
 * @param {import('vite').ViteDevServer} server
 * @param {string} liveDir
 * @param {string} dir
 * @param {string} rel - Relative path of the changed file (for logging)
 */
async function _hmrReloadRegistry(server, liveDir, dir, rel) {
	// Invalidate the registry virtual module so Vite regenerates it
	const registryMod = server.moduleGraph.getModuleById(REGISTRY_ID);
	if (registryMod) {
		server.moduleGraph.invalidateModule(registryMod);
	}

	/** @type {any} */
	let serverMod;
	try {
		serverMod = await server.ssrLoadModule('svelte-realtime/server');
	} catch {
		console.error('[svelte-realtime] HMR failed: could not load svelte-realtime/server');
		return;
	}

	// Snapshot current state, then clear everything
	const snap = serverMod._prepareHmr();

	try {
		await server.ssrLoadModule('/@svelte-realtime-registry');
		console.log(`[svelte-realtime] Hot-reloaded: ${dir}/${rel}`);
	} catch (e) {
		// Re-import failed -- restore old handlers so the server keeps working
		serverMod._restoreHmr(snap);
		console.error(`[svelte-realtime] HMR failed for ${dir}/${rel}:`, /** @type {Error} */ (e).message);
		console.error('[svelte-realtime] Previous handlers restored -- fix the error and save again');
	}
}

/**
 * Directly load live modules in dev mode.
 * @param {import('vite').ViteDevServer} server
 * @param {string} liveDir
 * @param {string} dir
 */
async function _loadRegistryDirect(server, liveDir, dir) {
	let serverMod;
	try {
		serverMod = await server.ssrLoadModule('svelte-realtime/server');
	} catch {
		console.warn('[svelte-realtime] Could not load svelte-realtime/server for direct registration');
		return;
	}

	const { __register, __registerGuard, __registerDerived, __registerCron, __registerEffect, __registerAggregate } = serverMod;
	const files = _findLiveFiles(liveDir);

	for (const filePath of files) {
		try {
			const mod = await server.ssrLoadModule(filePath);
			const rel = relative(liveDir, filePath).replace(/\\/g, '/').replace(/\.[jt]s$/, '');

			for (const [name, fn] of Object.entries(mod)) {
				if (name === '_guard' && /** @type {any} */ (fn)?.__isGuard) {
					__registerGuard(rel, fn);
				} else if (/** @type {any} */ (fn)?.__isRoom) {
					// Room: register sub-streams and actions
					if (fn.__dataStream) __register(rel + '/' + name + '/__data', fn.__dataStream);
					if (fn.__presenceStream) __register(rel + '/' + name + '/__presence', fn.__presenceStream);
					if (fn.__cursorStream) __register(rel + '/' + name + '/__cursors', fn.__cursorStream);
					if (fn.__actions) {
						for (const [k, v] of Object.entries(fn.__actions)) {
							__register(rel + '/' + name + '/__action/' + k, v);
						}
					}
				} else if (/** @type {any} */ (fn)?.__isEffect) {
					__registerEffect(rel + '/' + name, fn);
				} else if (/** @type {any} */ (fn)?.__isAggregate) {
					__register(rel + '/' + name, fn);
					__registerAggregate(rel + '/' + name, fn);
				} else if (/** @type {any} */ (fn)?.__isDerived) {
					__register(rel + '/' + name, fn);
					__registerDerived(rel + '/' + name, fn);
				} else if (/** @type {any} */ (fn)?.__isCron) {
					__registerCron(rel + '/' + name, fn);
				} else if (/** @type {any} */ (fn)?.__isLive) {
					__register(rel + '/' + name, fn);
				}
			}
		} catch (err) {
			console.warn(`[svelte-realtime] Failed to load ${relative(liveDir, filePath)}:`, err);
		}
	}
}
