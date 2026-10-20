// @ts-check
import { relative } from 'path';
import { REGISTRY_ID, REGISTRY_PUBLIC_ID, SERVER_PUBLIC_ID } from './constants.js';
import { _findLiveFiles } from './codegen-registry.js';

/**
 * The SSR environment SvelteKit 3 loads routes and hooks from, or null for
 * SvelteKit 2. Kit 3 exposes its flattened options on the setup plugin
 * whether or not the configuration has an inline adapter, so the check does
 * not depend on the adapter's name.
 * @param {any} server
 * @returns {any}
 */
export function _serverEnvironment(server) {
	const modernKit = server.config?.plugins?.some((/** @type {any} */ plugin) =>
		plugin?.name === 'vite-plugin-sveltekit-setup' && plugin.api?.options?.paths
	);
	return modernKit ? server.environments?.ssr ?? null : null;
}

/**
 * Import a module into the server graph that SvelteKit and the WebSocket
 * hooks use.
 * @param {any} server
 * @param {string} id
 * @returns {Promise<any>}
 */
export function _loadServerModule(server, id) {
	const environment = _serverEnvironment(server);
	if (!environment) return server.ssrLoadModule(id);
	// Runner entry points are internalized. Import the runtime as a dependency
	// so HMR clears the same instance that the live registry and hooks use.
	return environment.runner.import(id === 'svelte-realtime/server' ? SERVER_PUBLIC_ID : id);
}

/**
 * @param {any} server
 * @returns {any}
 */
export function _serverModuleGraph(server) {
	return _serverEnvironment(server)?.moduleGraph ?? server.moduleGraph;
}

/**
 * Invalidate the registry virtual module, clear all server-side registrations,
 * and re-import the registry so handlers are updated. If the re-import fails
 * (e.g. syntax error), restores the previous handlers so the server keeps working.
 * Callers serialize reloads, so a clear and its re-import never interleave
 * with another reload.
 * @param {import('vite').ViteDevServer} server
 * @param {string} liveDir
 * @param {string} dir
 * @param {string} rel - Relative path of the changed file (for logging)
 * @returns {Promise<boolean>} Whether the new handlers were registered
 */
export async function _hmrReloadRegistry(server, liveDir, dir, rel) {
	// Invalidate the registry virtual module so Vite regenerates it
	const graph = _serverModuleGraph(server);
	const registryMod = graph.getModuleById(REGISTRY_ID);
	if (registryMod) {
		graph.invalidateModule(registryMod);
	}

	/** @type {any} */
	let serverMod;
	try {
		serverMod = await _loadServerModule(server, 'svelte-realtime/server');
	} catch {
		console.error('[svelte-realtime] HMR failed: could not load svelte-realtime/server\n  See: https://svti.me/vite');
		return false;
	}

	// Snapshot current state, then clear everything
	let snap;
	try {
		snap = serverMod._prepareHmr();
	} catch (error) {
		console.error('[svelte-realtime] HMR preparation failed:', error instanceof Error ? error.message : String(error));
		return false;
	}

	try {
		await _loadServerModule(server, REGISTRY_PUBLIC_ID);
		console.log(`[svelte-realtime] Hot-reloaded: ${dir}/${rel}`);
		return true;
	} catch (e) {
		// Re-import failed - restore old handlers so the server keeps working
		serverMod._restoreHmr(snap);
		console.error(`[svelte-realtime] HMR failed for ${dir}/${rel}:`, /** @type {Error} */ (e).message);
		console.error('[svelte-realtime] Previous handlers restored - fix the error and save again');
		return false;
	}
}

/**
 * Directly load live modules in dev mode.
 * @param {import('vite').ViteDevServer} server
 * @param {string} liveDir
 * @param {string} dir
 */
export async function _loadRegistryDirect(server, liveDir, dir) {
	let serverMod;
	try {
		serverMod = await _loadServerModule(server, 'svelte-realtime/server');
	} catch {
		console.warn('[svelte-realtime] Could not load svelte-realtime/server for direct registration');
		return;
	}

	const { __register, __registerGuard, __registerDerived, __registerCron, __registerEffect, __registerAggregate, __registerWebhookOut } = serverMod;
	const files = _findLiveFiles(liveDir);

	for (const filePath of files) {
		try {
			const mod = await _loadServerModule(server, filePath);
			const rel = relative(liveDir, filePath).replace(/\\/g, '/').replace(/\.[jt]s$/, '');

			for (const [name, fn] of Object.entries(mod)) {
				if (name === '_guard' && /** @type {any} */ (fn)?.__isGuard) {
					__registerGuard(rel, fn);
				} else if (/** @type {any} */ (fn)?.__isMultiplayer) {
					// A multiplayer export reuses the room sub-streams; register
					// them, the cursor and presence-field send handlers, the
					// reactions stream, and its scoped actions the same way a room
					// does.
					if (fn.__dataStream) __register(rel + '/' + name + '/__data', fn.__dataStream, rel);
					if (fn.__presenceStream) __register(rel + '/' + name + '/__presence', fn.__presenceStream, rel);
					if (fn.__ownerStream) __register(rel + '/' + name + '/__owner', fn.__ownerStream, rel);
					if (fn.__cursorStream) __register(rel + '/' + name + '/__cursors', fn.__cursorStream, rel);
					if (fn.__cursorMove) __register(rel + '/' + name + '/__cursor/move', fn.__cursorMove, rel);
					if (fn.__cursorReportViewport) __register(rel + '/' + name + '/__cursor/reportViewport', fn.__cursorReportViewport, rel);
					if (fn.__presenceUpdate) __register(rel + '/' + name + '/__presence/update', fn.__presenceUpdate, rel);
					if (fn.__reactionStream) __register(rel + '/' + name + '/__reactions', fn.__reactionStream, rel);
					if (fn.__reactionEmit) __register(rel + '/' + name + '/__reaction/emit', fn.__reactionEmit, rel);
					if (fn.__actions) {
						for (const [k, v] of Object.entries(fn.__actions)) {
							__register(rel + '/' + name + '/__action/' + k, v, rel);
						}
					}
				} else if (/** @type {any} */ (fn)?.__isSmooth) {
					// A smooth export carries its send handlers (command / sync / center,
					// plus shoot for a hitTest topic); the authoritative tick machinery
					// hangs off the handlers' first use, never off registration. Must
					// mirror the initial codegen registry (codegen-registry.js) or a hot
					// reload silently drops center/shoot until a full reload.
					if (fn.__smoothCommand) __register(rel + '/' + name + '/__smooth/command', fn.__smoothCommand, rel);
					if (fn.__smoothSync) __register(rel + '/' + name + '/__smooth/sync', fn.__smoothSync, rel);
					if (fn.__smoothCenter) __register(rel + '/' + name + '/__smooth/center', fn.__smoothCenter, rel);
					if (fn.__smoothShoot) __register(rel + '/' + name + '/__smooth/shoot', fn.__smoothShoot, rel);
				} else if (/** @type {any} */ (fn)?.__isDoc) {
					// A document export carries its three send handlers; the
					// replica authority hangs off the handlers' first use, and
					// the module-level records survive the hot reload so live
					// replicas keep their un-persisted edits.
					if (fn.__docSync) __register(rel + '/' + name + '/__doc/sync', fn.__docSync, rel);
					if (fn.__docUpdate) __register(rel + '/' + name + '/__doc/update', fn.__docUpdate, rel);
					if (fn.__docClose) __register(rel + '/' + name + '/__doc/close', fn.__docClose, rel);
				} else if (/** @type {any} */ (fn)?.__isRoom) {
					if (fn.__dataStream) __register(rel + '/' + name + '/__data', fn.__dataStream, rel);
					if (fn.__presenceStream) __register(rel + '/' + name + '/__presence', fn.__presenceStream, rel);
					if (fn.__ownerStream) __register(rel + '/' + name + '/__owner', fn.__ownerStream, rel);
					if (fn.__cursorStream) __register(rel + '/' + name + '/__cursors', fn.__cursorStream, rel);
					if (fn.__roomsStream) __register(rel + '/' + name + '/__rooms', fn.__roomsStream, rel);
					if (fn.__roomsSync) __register(rel + '/' + name + '/__roomsSync', fn.__roomsSync, rel);
					if (typeof fn.__setEnumId === 'function') fn.__setEnumId(rel + '/' + name);
					if (fn.__actions) {
						for (const [k, v] of Object.entries(fn.__actions)) {
							__register(rel + '/' + name + '/__action/' + k, v, rel);
						}
					}
				} else if (/** @type {any} */ (fn)?.__isEffect) {
					__registerEffect(rel + '/' + name, fn);
				} else if (/** @type {any} */ (fn)?.__isWebhookOut) {
					__registerWebhookOut(rel + '/' + name, fn);
				} else if (/** @type {any} */ (fn)?.__isAggregate) {
					if (/** @type {any} */ (fn).__windowStreams) {
						// Windowed: register the watcher under the export
						// path (the watcher fans events to all windows
						// internally) and one stream path per window.
						__registerAggregate(rel + '/' + name, fn);
						for (const [wn, winFn] of Object.entries(/** @type {any} */ (fn).__windowStreams)) {
							__register(rel + '/' + name + '/__window/' + wn, winFn, rel);
						}
					} else {
						__register(rel + '/' + name, fn);
						__registerAggregate(rel + '/' + name, fn);
					}
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
