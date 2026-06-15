// @ts-check
import { relative } from 'path';
import { REGISTRY_ID } from './constants.js';
import { _findLiveFiles } from './codegen-registry.js';

/**
 * Invalidate the registry virtual module, clear all server-side registrations,
 * and re-import the registry so handlers are updated. If the re-import fails
 * (e.g. syntax error), restores the previous handlers so the server keeps working.
 * @param {import('vite').ViteDevServer} server
 * @param {string} liveDir
 * @param {string} dir
 * @param {string} rel - Relative path of the changed file (for logging)
 */
export async function _hmrReloadRegistry(server, liveDir, dir, rel) {
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
		console.error('[svelte-realtime] HMR failed: could not load svelte-realtime/server\n  See: https://svti.me/vite');
		return;
	}

	// Snapshot current state, then clear everything
	const snap = serverMod._prepareHmr();

	try {
		await server.ssrLoadModule('/@svelte-realtime-registry');
		console.log(`[svelte-realtime] Hot-reloaded: ${dir}/${rel}`);
	} catch (e) {
		// Re-import failed - restore old handlers so the server keeps working
		serverMod._restoreHmr(snap);
		console.error(`[svelte-realtime] HMR failed for ${dir}/${rel}:`, /** @type {Error} */ (e).message);
		console.error('[svelte-realtime] Previous handlers restored - fix the error and save again');
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
		serverMod = await server.ssrLoadModule('svelte-realtime/server');
	} catch {
		console.warn('[svelte-realtime] Could not load svelte-realtime/server for direct registration');
		return;
	}

	const { __register, __registerGuard, __registerDerived, __registerCron, __registerEffect, __registerAggregate, __registerWebhookOut } = serverMod;
	const files = _findLiveFiles(liveDir);

	for (const filePath of files) {
		try {
			const mod = await server.ssrLoadModule(filePath);
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
					// A smooth export carries only its two send handlers; the
					// authoritative tick machinery hangs off the handlers'
					// first use, never off registration.
					if (fn.__smoothCommand) __register(rel + '/' + name + '/__smooth/command', fn.__smoothCommand, rel);
					if (fn.__smoothSync) __register(rel + '/' + name + '/__smooth/sync', fn.__smoothSync, rel);
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
					if (fn.__cursorStream) __register(rel + '/' + name + '/__cursors', fn.__cursorStream, rel);
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
