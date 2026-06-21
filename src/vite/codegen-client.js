// @ts-check
import { _readCached } from './source-cache.js';
import { _isDynamicExport } from './extract-types.js';
import { _extractStreamOptions, _extractChannelOptions, _extractAggregateWindows, _extractRoomInfo, _extractMultiplayerInfo } from './extract-options.js';
import { _warnUnsafeExports } from './scanner.js';
import { LIVE_EXPORT_RE, VALIDATED_EXPORT_RE, STREAM_EXPORT_RE, GUARD_EXPORT_RE, DYNAMIC_STREAM_RE, CRON_EXPORT_RE, BINARY_EXPORT_RE, UPLOAD_EXPORT_RE, DERIVED_EXPORT_RE, DYNAMIC_DERIVED_RE, ROOM_EXPORT_RE, MULTIPLAYER_EXPORT_RE, SMOOTH_EXPORT_RE, DOC_EXPORT_RE, WEBHOOK_EXPORT_RE, WEBHOOK_INBOUND_EXPORT_RE, WEBHOOK_OUTBOUND_EXPORT_RE, CHANNEL_EXPORT_RE, DYNAMIC_CHANNEL_RE, RATE_LIMIT_EXPORT_RE, EFFECT_EXPORT_RE, AGGREGATE_EXPORT_RE, FLAG_EXPORT_RE, LOCK_EXPORT_RE, PUBLIC_EXPORT_RE, PUBLIC_COMMENT_RE, IDEMPOTENT_EXPORT_RE, VOLATILE_EXPORT_RE } from './patterns.js';

/**
 * Generate client stubs for a live module.
 * @param {string} filePath
 * @param {string} modulePath
 * @param {string} dir
 * @returns {string}
 */
export function _generateClientStubs(filePath, modulePath, dir) {
	const source = _readCached(filePath);

	/** @type {string[]} */
	const lines = [];
	/** @type {Set<string>} */
	const imports = new Set();
	/** @type {Set<string>} */
	const exportedNames = new Set();
	/** @type {boolean} */
	let hasGuard = false;

	// Quote `modulePath/name` paths via JSON.stringify so an embedded `'`
	// or `"` in modulePath cannot break out of the generated single- /
	// double-quoted string literal in the client stub. modulePath is
	// derived from a filesystem walk and can contain quote characters on
	// platforms that allow them in filenames; routing through
	// JSON.stringify closes that path-injection break-out.
	/** @param {string} name */
	const safeModulePath = (name) => JSON.stringify(modulePath + '/' + name);

	// Detect live() exports
	let match;
	// Track whether any live.public() export is present in the module - used
	// alongside the `// realtime-allow-public` comment to suppress the
	// "no _guard" build-time warning.
	let hasPublicExport = false;
	PUBLIC_EXPORT_RE.lastIndex = 0;
	if (PUBLIC_EXPORT_RE.exec(source) !== null) {
		hasPublicExport = true;
	}
	const hasPublicComment = PUBLIC_COMMENT_RE.test(source);
	// live() and the wrappers that pass through unchanged on the client
	// (validated/lock/idempotent/rateLimit/public) all emit the same __rpc line.
	for (const re of [LIVE_EXPORT_RE, VALIDATED_EXPORT_RE, LOCK_EXPORT_RE, IDEMPOTENT_EXPORT_RE, RATE_LIMIT_EXPORT_RE, PUBLIC_EXPORT_RE, VOLATILE_EXPORT_RE]) {
		re.lastIndex = 0;
		while ((match = re.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (exportedNames.has(name)) continue;
			exportedNames.add(name);
			imports.add('__rpc');
			lines.push(`export const ${name} = __rpc(${safeModulePath(name)});`);
		}
	}

	// Detect live.stream() exports - check for dynamic vs static topic
	STREAM_EXPORT_RE.lastIndex = 0;
	while ((match = STREAM_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		exportedNames.add(name);
		imports.add('__stream');
		const streamOptions = _extractStreamOptions(source, name);
		const isDynamic = _isDynamicExport(source, name, 'live\\.stream');
		if (isDynamic) {
			// Dynamic topic: generate a function wrapper that passes args
			lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify(streamOptions)}, true);`);
		} else {
			lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify(streamOptions)});`);
		}
	}

	// Detect live.channel() exports - treated as streams on the client
	CHANNEL_EXPORT_RE.lastIndex = 0;
	while ((match = CHANNEL_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__stream');
			const channelOpts = _extractChannelOptions(source, name);
			const isDynamic = _isDynamicExport(source, name, 'live\\.channel');
			if (isDynamic) {
				lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify(channelOpts)}, true);`);
			} else {
				lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify(channelOpts)});`);
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
			lines.push(`export const ${name} = __binaryRpc(${safeModulePath(name)});`);
		}
	}

	// Detect live.upload() exports
	UPLOAD_EXPORT_RE.lastIndex = 0;
	while ((match = UPLOAD_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__upload');
			lines.push(`export const ${name} = __upload(${safeModulePath(name)});`);
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
			const isDynamic = _isDynamicExport(source, name, 'live\\.derived');
			if (isDynamic) {
				lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify({ merge: 'set' })}, true);`);
			} else {
				lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify({ merge: 'set' })});`);
			}
		}
	}

	// Smoothed-entity exports: the namespace carries the command/sync send
	// paths and a smooth(...) factory. The factory's trailing argument is the
	// app's runtime options object (apply, initial, knobs) - it is forwarded
	// verbatim into the channel, never serialized into the stub. The channel
	// itself comes from the adapter (the same package the client connection
	// already rides), and the rune view class from the svelte-realtime/smooth
	// subpath. Runs before the room/multiplayer loops and claims the name.
	let smoothRuntimeImported = false;
	SMOOTH_EXPORT_RE.lastIndex = 0;
	while ((match = SMOOTH_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__rpc');
			imports.add('status');
			if (!smoothRuntimeImported) {
				lines.push(`import { SmoothEntity } from 'svelte-realtime/smooth';`);
				lines.push(`import { createSmoothChannel } from 'svelte-adapter-uws/plugins/smooth/client';`);
				smoothRuntimeImported = true;
			}
			const smLines = [];
			smLines.push(`export const ${name} = {`);
			smLines.push(`  _command: __rpc(${JSON.stringify(modulePath + '/' + name + '/__smooth/command')}),`);
			smLines.push(`  _sync: __rpc(${JSON.stringify(modulePath + '/' + name + '/__smooth/sync')}),`);
			smLines.push(`  _center: __rpc(${JSON.stringify(modulePath + '/' + name + '/__smooth/center')}),`);
			smLines.push(`  _shoot: __rpc(${JSON.stringify(modulePath + '/' + name + '/__smooth/shoot')}),`);
			smLines.push(`  status: status,`);
			smLines.push(`  smooth(...args) {`);
			smLines.push(`    const opts = args.length > 0 ? args[args.length - 1] : undefined;`);
			smLines.push(`    const roomArgs = args.slice(0, -1);`);
			smLines.push(`    const channel = createSmoothChannel({ ...opts, transport: {`);
			smLines.push(`      sendCommand: (batch) => ${name}._command.fireAndForget(...roomArgs, batch),`);
			smLines.push(`      sendShoot: (payload) => ${name}._shoot.fireAndForget(...roomArgs, payload),`);
			smLines.push(`      sync: () => ${name}._sync(...roomArgs)`);
			smLines.push(`    } });`);
			// The area-of-interest center report rides its own volatile RPC, not the
			// channel transport: it is a server-side culling hint, orthogonal to the
			// prediction/reconciliation loop the channel runs.
			smLines.push(`    return new SmoothEntity(channel, status, (center) => ${name}._center.fireAndForget(...roomArgs, center));`);
			smLines.push(`  },`);
			smLines.push(`};`);
			lines.push(smLines.join('\n'));
		}
	}

	// CRDT document exports: the namespace carries the sync/update/close send
	// paths and a factory named after the kind (doc/map/array) that builds
	// the reactive replica view. Updates ride the reliable no-reply `.send()`
	// (a dropped edit would desync the document; a buffered one merely
	// arrives late); mounts of the same document share one channel through
	// the rune layer's reference-counted cache. Runs before the
	// room/multiplayer loops and claims the name.
	let docRuntimeImported = false;
	DOC_EXPORT_RE.lastIndex = 0;
	while ((match = DOC_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		const kind = match[2];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__rpc');
			imports.add('status');
			if (!docRuntimeImported) {
				lines.push(`import { _acquireDoc } from 'svelte-realtime/doc';`);
				lines.push(`import { createCrdtChannel } from 'svelte-adapter-uws/plugins/crdt/channel';`);
				docRuntimeImported = true;
			}
			const dLines = [];
			dLines.push(`export const ${name} = {`);
			dLines.push(`  _sync: __rpc(${JSON.stringify(modulePath + '/' + name + '/__doc/sync')}),`);
			dLines.push(`  _update: __rpc(${JSON.stringify(modulePath + '/' + name + '/__doc/update')}),`);
			dLines.push(`  _close: __rpc(${JSON.stringify(modulePath + '/' + name + '/__doc/close')}),`);
			dLines.push(`  status: status,`);
			dLines.push(`  ${kind}(...args) {`);
			dLines.push(`    return _acquireDoc(${JSON.stringify(modulePath + '/' + name)} + '\\u0000' + JSON.stringify(args), ${JSON.stringify(kind)}, () => createCrdtChannel({ transport: {`);
			dLines.push(`      sendUpdate: (bytes) => ${name}._update.send(...args, bytes),`);
			dLines.push(`      sync: (sv, mountId) => ${name}._sync(...args, sv, mountId),`);
			dLines.push(`      close: (mountId) => ${name}._close.send(...args, mountId)`);
			dLines.push(`    } }), status);`);
			dLines.push(`  },`);
			dLines.push(`};`);
			lines.push(dLines.join('\n'));
		}
	}

	// Detect live.multiplayer() exports - the room namespace plus the
	// aggregated connection status and the cursor move / reportViewport
	// methods. Runs before the room loop and marks the name so the room loop
	// (which guards on exportedNames) skips it - a single export is never
	// emitted twice.
	// Emit the rune-class import at most once per stub even when a module
	// declares several multiplayer exports, so the generated module never has a
	// duplicate import declaration.
	let mpRuntimeImported = false;
	MULTIPLAYER_EXPORT_RE.lastIndex = 0;
	while ((match = MULTIPLAYER_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__stream');
			imports.add('__rpc');
			imports.add('status');
			imports.add('__mpFields');
			const mpInfo = _extractMultiplayerInfo(source, name);
			// `others` / `cursors` / `me` aggregation needs the rune-class. It
			// composes the generated presence / cursor / status sub-streams, so
			// it is only constructed when a roster surface exists (presence or
			// cursors), a field surface (typing / selections / locks) is declared,
			// or reactions are enabled - all of which the room view hosts. The
			// class lives in a separate rune-aware subpath, not in
			// svelte-realtime/client, so its import is a standalone line.
			const hasField = mpInfo.typing || mpInfo.hasLocks || mpInfo.selections || mpInfo.reactions;
			const hasRoster = mpInfo.hasPresence || mpInfo.hasCursors || hasField;
			if (hasRoster) {
				if (!mpRuntimeImported) {
					lines.push(`import { MultiplayerRoom, localKeySource } from 'svelte-realtime/multiplayer';`);
					mpRuntimeImported = true;
				}
				lines.push(`const _${name}_me = localKeySource();`);
			}
			const mpLines = [];
			mpLines.push(`export const ${name} = {`);
			// Namespace-level field-surface fallback (empty views + safe no-op
			// methods) for code that reads board.typing without entering a room.
			// board.room(...) hosts the live surfaces; the members below add the
			// data / presence / cursor streams and the send-path RPCs.
			mpLines.push(`  ...__mpFields(),`);
			mpLines.push(`  data: __stream(${JSON.stringify(modulePath + '/' + name + '/__data')}, ${JSON.stringify(mpInfo.dataOpts)}, true),`);
			if (mpInfo.hasPresence) {
				mpLines.push(`  presence: __stream(${JSON.stringify(modulePath + '/' + name + '/__presence')}, ${JSON.stringify({ merge: 'presence' })}, true),`);
			}
			if (mpInfo.hasCursors) {
				mpLines.push(`  cursors: __stream(${JSON.stringify(modulePath + '/' + name + '/__cursors')}, ${JSON.stringify({ merge: 'cursor' })}, true),`);
			}
			// The presence-field send path (typing / selections / locks) and the
			// reactions stream are emitted only when the export declares a field
			// surface, so a multiplayer export with no fields is unchanged.
			const hasPresenceField = mpInfo.typing || mpInfo.hasLocks || mpInfo.selections;
			if (hasPresenceField) {
				mpLines.push(`  _setField: __rpc(${JSON.stringify(modulePath + '/' + name + '/__presence/update')}),`);
			}
			if (mpInfo.reactions) {
				mpLines.push(`  reactions: __stream(${JSON.stringify(modulePath + '/' + name + '/__reactions')}, ${JSON.stringify({ merge: 'latest' })}, true),`);
				mpLines.push(`  _emitReaction: __rpc(${JSON.stringify(modulePath + '/' + name + '/__reaction/emit')}),`);
			}
			mpLines.push(`  status: status,`);
			mpLines.push(`  move: __rpc(${JSON.stringify(modulePath + '/' + name + '/__cursor/move')}),`);
			mpLines.push(`  reportViewport: __rpc(${JSON.stringify(modulePath + '/' + name + '/__cursor/reportViewport')}),`);
			for (const action of mpInfo.actions) {
				mpLines.push(`  ${action}: __rpc(${JSON.stringify(modulePath + '/' + name + '/__action/' + action)}),`);
			}
			if (hasRoster) {
				// identify(key) names the local user once; me + self-exclusion
				// light up. room(...args) builds the aggregated reactive view
				// over the per-room presence / cursor sub-streams and forwards
				// the room args to each. The object is fully assigned before
				// room() can be called, so self-referencing ${name} is safe.
				// A roster surface may declare presence without cursors (or the
				// reverse); the missing sub-stream falls back to a store that
				// pushes an empty list once, so the room always has both stores
				// to compose without a dangling member reference.
				const emptyStore = `{ subscribe: (fn) => { fn([]); return () => {}; } }`;
				const presenceArg = mpInfo.hasPresence ? `${name}.presence(...args)` : emptyStore;
				const cursorsArg = mpInfo.hasCursors ? `${name}.cursors(...args)` : emptyStore;
				// The room composes the live field surfaces over the same presence
				// roster. Each send dep binds the room args, then the room layers in
				// the field-specific shape. typing / lock acquire / release are
				// awaitable (the ack surfaces an error); the selection drag is
				// fire-and-forget so a high-frequency drag drops under backpressure
				// rather than queueing. Reactions ride their own stream and emit.
				const roomDeps = [
					`me: _${name}_me`,
					`presence: ${presenceArg}`,
					`cursors: ${cursorsArg}`,
					`status: status`,
					`move: (...a) => ${name}.move(...args, ...a)`,
					`reportViewport: (...a) => ${name}.reportViewport(...args, ...a)`
				];
				if (hasPresenceField) {
					if (mpInfo.typing) {
						roomDeps.push(`setTyping: (...a) => ${name}._setField(...args, ...a)`);
					}
					if (mpInfo.selections) {
						roomDeps.push(`setSelection: (...a) => ${name}._setField.fireAndForget(...args, ...a)`);
					}
					if (mpInfo.hasLocks) {
						roomDeps.push(`acquireLock: (...a) => ${name}._setField(...args, ...a)`);
						roomDeps.push(`releaseLock: (...a) => ${name}._setField(...args, ...a)`);
					}
				}
				if (mpInfo.reactions) {
					roomDeps.push(`reactions: ${name}.reactions(...args)`);
					roomDeps.push(`react: (...a) => ${name}._emitReaction.fireAndForget(...args, ...a)`);
				}
				mpLines.push(`  identify(key) { _${name}_me.set(key); },`);
				mpLines.push(`  room(...args) { return new MultiplayerRoom({ ${roomDeps.join(', ')} }); },`);
			}
			mpLines.push(`};`);
			lines.push(mpLines.join('\n'));
		}
	}

	// Detect live.room() exports - generates data stream + presence stream + cursor stream + actions
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
			roomLines.push(`  data: __stream(${JSON.stringify(modulePath + '/' + name + '/__data')}, ${JSON.stringify(roomInfo.dataOpts)}, true),`);
			if (roomInfo.hasPresence) {
				roomLines.push(`  presence: __stream(${JSON.stringify(modulePath + '/' + name + '/__presence')}, ${JSON.stringify({ merge: 'presence' })}, true),`);
			}
			if (roomInfo.hasCursors) {
				roomLines.push(`  cursors: __stream(${JSON.stringify(modulePath + '/' + name + '/__cursors')}, ${JSON.stringify({ merge: 'cursor' })}, true),`);
			}
			// Actions are RPCs
			for (const action of roomInfo.actions) {
				roomLines.push(`  ${action}: __rpc(${JSON.stringify(modulePath + '/' + name + '/__action/' + action)}),`);
			}
			roomLines.push(`};`);
			lines.push(roomLines.join('\n'));
		}
	}

	// Mark webhook exports as known (server-only, no client stub). Covers the
	// flat live.webhook(), live.webhooks.inbound(), and live.webhooks.outbound().
	for (const re of [WEBHOOK_EXPORT_RE, WEBHOOK_INBOUND_EXPORT_RE, WEBHOOK_OUTBOUND_EXPORT_RE]) {
		re.lastIndex = 0;
		while ((match = re.exec(source)) !== null) {
			exportedNames.add(match[1]);
		}
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
			const windowKeys = _extractAggregateWindows(source, name);
			if (windowKeys && windowKeys.length > 0) {
				// Windowed: emit a namespace object with one __stream per
				// declared window. Each window gets its own path so the
				// server registers it independently and clients subscribe
				// to the per-window output topic.
				const aggLines = [];
				aggLines.push(`export const ${name} = {`);
				for (const wn of windowKeys) {
					const safeWn = JSON.stringify(wn);
					aggLines.push(`  ${safeWn}: __stream(${JSON.stringify(modulePath + '/' + name + '/__window/' + wn)}, ${JSON.stringify({ merge: 'set' })}),`);
				}
				aggLines.push(`};`);
				lines.push(aggLines.join('\n'));
			} else {
				lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify({ merge: 'set' })});`);
			}
		}
	}

	// Detect live.flag() exports (readable set-merge stream on the client)
	FLAG_EXPORT_RE.lastIndex = 0;
	while ((match = FLAG_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		if (!exportedNames.has(name)) {
			exportedNames.add(name);
			imports.add('__stream');
			lines.push(`export const ${name} = __stream(${safeModulePath(name)}, ${JSON.stringify({ merge: 'set' })});`);
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
				`[svelte-realtime] ${dir}/${modulePath} exports '${name}' starting with _ - reserved for internal use\n  See: https://svti.me/rpc`
			);
			continue;
		}
		console.warn(
			`[svelte-realtime] ${dir}/${modulePath} exports '${name}' which is not wrapped in live() - it won't be callable from the client. Did you forget live()?\n  See: https://svti.me/rpc`
		);
	}

	// Warn about exports with non-path-safe names
	_warnUnsafeExports(source, `${dir}/${modulePath}`, exportedNames);

	if (exportedNames.size === 0 && !hasGuard) {
		// Only warn "no live exports" if the file truly has none --
		// don't emit this when exports exist but were skipped due to invalid names
		// (those already got their own warning from _warnUnsafeExports).
		const hasAnyLiveExport = /export\s+const\s+[\w$]+\s*=\s*live[\s.(]/g.test(source);
		if (!hasAnyLiveExport) {
			console.warn(
				`[svelte-realtime] ${dir}/${modulePath} has no live() or live.stream() exports\n  See: https://svti.me/start`
			);
		}
	}

	// Build-time nudge: a module with live() exports but no `_guard`
	// is opting into the framework's default-allow posture (every
	// authenticated WS can invoke any registered handler). That is the
	// correct default for "Hello, world" but is a foot-gun for apps that
	// forget to add an auth gate.
	//
	// Suppression:
	//   - export at least one `live.public(...)` (per-export intent, recommended)
	//   - add `// realtime-allow-public` anywhere in the source (module-wide opt-out)
	//   - export `_guard = guard(...)` (the framework auth gate)
	//
	// The warning is a soft nudge, not a hard error - runtime semantics
	// are unchanged.
	if (exportedNames.size > 0 && !hasGuard && !hasPublicExport && !hasPublicComment) {
		console.warn(
			`[svelte-realtime] ${dir}/${modulePath} has live() / live.stream() exports but no _guard. ` +
			`Every authenticated WS can invoke any handler in this module. ` +
			`Add 'export const _guard = guard(...)' to gate access, ` +
			`mark individual handlers as 'live.public(...)' to declare them intentionally open, ` +
			`or add '// realtime-allow-public' to the file to suppress this warning.\n` +
			`  See: https://svti.me/guard`
		);
	}

	const importLine = imports.size > 0
		? `import { ${[...imports].join(', ')} } from 'svelte-realtime/client';\n`
		: '';

	const reexport = `export { empty } from 'svelte-realtime/client';\n`;

	// Self-accept HMR: when the source file changes, handleHotUpdate
	// invalidates this virtual module and Vite re-executes it. The accept
	// directive turns that re-execution into an HMR update instead of a
	// full page reload. `import.meta.hot` is undefined in production /
	// non-Vite contexts, so the conditional is dead code there and Vite
	// strips it from the production bundle.
	const hmrAccept = `if (import.meta.hot) import.meta.hot.accept();\n`;

	return importLine + reexport + lines.join('\n') + '\n' + hmrAccept;
}
