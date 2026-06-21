// @ts-check
import { sep, posix } from 'path';
import { _readCached } from './source-cache.js';
import { _isDynamicExport } from './extract-types.js';
import { _extractAggregateWindows, _extractRoomInfo, _extractMultiplayerInfo } from './extract-options.js';
import { LIVE_EXPORT_RE, VALIDATED_EXPORT_RE, STREAM_EXPORT_RE, GUARD_EXPORT_RE, DYNAMIC_STREAM_RE, CRON_EXPORT_RE, BINARY_EXPORT_RE, UPLOAD_EXPORT_RE, DERIVED_EXPORT_RE, DYNAMIC_DERIVED_RE, ROOM_EXPORT_RE, MULTIPLAYER_EXPORT_RE, SMOOTH_EXPORT_RE, DOC_EXPORT_RE, WEBHOOK_EXPORT_RE, WEBHOOK_INBOUND_EXPORT_RE, WEBHOOK_OUTBOUND_EXPORT_RE, CHANNEL_EXPORT_RE, DYNAMIC_CHANNEL_RE, RATE_LIMIT_EXPORT_RE, EFFECT_EXPORT_RE, AGGREGATE_EXPORT_RE, FLAG_EXPORT_RE, LOCK_EXPORT_RE, PUBLIC_EXPORT_RE, PUBLIC_COMMENT_RE, IDEMPOTENT_EXPORT_RE, VOLATILE_EXPORT_RE } from './patterns.js';

/**
 * Generate SSR stubs for a live module.
 * Re-exports everything from the real module, and adds .load() wrappers for streams.
 * @param {string} filePath
 * @param {string} modulePath
 * @returns {string}
 */
export function _generateSsrStubs(filePath, modulePath) {
	const normalized = filePath.split(sep).join(posix.sep);
	const source = _readCached(filePath);

	/** @type {string[]} */
	const storeNames = [];
	/** @type {Set<string>} */
	const dynamicNames = new Set();
	/** @type {Array<{ name: string, info: ReturnType<typeof _extractRoomInfo> }>} */
	const rooms = [];
	/** @type {Array<{ name: string, windows: string[] }>} */
	const windowedAggregates = [];
	let match;

	// Collect stream-like exports and classify each as dynamic-factory or
	// static-readable. This MUST agree with the client-side stub generation
	// (which uses `_isDynamicExport` for the same decision) - otherwise the
	// SSR stub emits a factory while the client stub emits a readable, the
	// page is compiled against the static client shape, and `$storeName`
	// during SSR calls `factory.subscribe(...)` which crashes with
	// "store.subscribe is not a function". One classifier, both call sites.
	// Aggregates with `windows: { ... }` are split out into a separate set --
	// they need a namespace stub (one readable per window), not the
	// single-readable shape that single-state aggregates take.
	const _streamApiByRe = [
		[STREAM_EXPORT_RE, 'live\\.stream'],
		[CHANNEL_EXPORT_RE, 'live\\.channel'],
		[DERIVED_EXPORT_RE, 'live\\.derived']
	];
	for (const [re, apiName] of _streamApiByRe) {
		re.lastIndex = 0;
		while ((match = re.exec(source)) !== null) {
			const name = match[1];
			storeNames.push(name);
			if (_isDynamicExport(source, name, apiName)) dynamicNames.add(name);
		}
	}
	AGGREGATE_EXPORT_RE.lastIndex = 0;
	while ((match = AGGREGATE_EXPORT_RE.exec(source)) !== null) {
		const aggName = match[1];
		const windowKeys = _extractAggregateWindows(source, aggName);
		if (windowKeys && windowKeys.length > 0) {
			windowedAggregates.push({ name: aggName, windows: windowKeys });
		} else {
			storeNames.push(aggName);
		}
	}

	// Collect live.room() exports - the SSR stub exposes a namespace object
	// whose data/presence/cursors are always-undefined readables (factory-shaped
	// when the topic is dynamic) and whose actions are no-op stubs returning
	// undefined. Without these, SSR rendering of pages that call `board.data(id)`
	// crashes because the source module's `board` export is the server-side
	// roomExport (with __dataStream / __presenceStream) and lacks `data`.
	ROOM_EXPORT_RE.lastIndex = 0;
	while ((match = ROOM_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		rooms.push({ name, info: _extractRoomInfo(source, name) });
	}

	// Collect live.multiplayer() exports - the SSR stub mirrors the room
	// namespace (factory-shaped sub-streams, no-op actions) plus the empty
	// collaborative views and no-op cursor methods, so a page that renders
	// `board.status` / `board.move(...)` during SSR does not crash.
	/** @type {Array<{ name: string, info: ReturnType<typeof _extractMultiplayerInfo> }>} */
	const multiplayers = [];
	MULTIPLAYER_EXPORT_RE.lastIndex = 0;
	while ((match = MULTIPLAYER_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		multiplayers.push({ name, info: _extractMultiplayerInfo(source, name) });
	}

	// Collect live.smooth() exports - the SSR stub renders an inert predicted
	// view (the runtime options arrive at the factory call, so `local` echoes
	// the caller's own initial state) and no-op send methods, so a page that
	// constructs the view during SSR does not crash before hydration.
	/** @type {string[]} */
	const smooths = [];
	SMOOTH_EXPORT_RE.lastIndex = 0;
	while ((match = SMOOTH_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		smooths.push(name);
	}

	// Collect CRDT document exports - the SSR stub renders an inert empty
	// replica view (empty containers, no-op writes), so a page that
	// constructs the store during SSR does not crash before hydration.
	/** @type {Array<{ name: string, kind: string }>} */
	const docs = [];
	DOC_EXPORT_RE.lastIndex = 0;
	while ((match = DOC_EXPORT_RE.exec(source)) !== null) {
		const name = match[1];
		if (!/^\w+$/.test(name)) continue;
		docs.push({ name, kind: match[2] });
	}

	// Escape paths for safe embedding in generated code
	const safePath = JSON.stringify(normalized);
	const safeModulePath = (name) => JSON.stringify(modulePath + '/' + name);

	// If no store-like / room / multiplayer / smooth / doc / windowed-aggregate exports, simple re-export
	if (storeNames.length === 0 && rooms.length === 0 && multiplayers.length === 0 && smooths.length === 0 && docs.length === 0 && windowedAggregates.length === 0) {
		return `export * from ${safePath};\n`;
	}

	// Re-export non-stream exports, wrap store-like exports in readable() for SSR $ prefix support
	const lines = [
		`import { readable } from 'svelte/store';`,
		`import { __directCall } from 'svelte-realtime/server';`,
		`export * from ${safePath};`
	];

	for (const name of storeNames) {
		if (dynamicNames.has(name)) {
			// Dynamic stream: factory returns a readable with .hydrate() for SSR rendering
			lines.push(`const _${name} = (...args) => { const s = readable(undefined); s.hydrate = (d) => readable(d); return s; };`);
			lines.push(`_${name}.load = (platform, options) => __directCall(${safeModulePath(name)}, options?.args || [], platform, options);`);
			lines.push(`export { _${name} as ${name} };`);
		} else {
			// Static stream: readable with .hydrate() for SSR rendering
			lines.push(`const _${name} = readable(undefined);`);
			lines.push(`_${name}.hydrate = (d) => readable(d);`);
			lines.push(`_${name}.load = (platform, options) => __directCall(${safeModulePath(name)}, options?.args || [], platform, options);`);
			lines.push(`export { _${name} as ${name} };`);
		}
	}

	for (const { name, windows } of windowedAggregates) {
		// Windowed aggregate namespace: each window is a static readable
		// (the per-window output topic delivers one publish per window per
		// event/boundary/slide, so factory-shaped is not needed). The
		// `.load(platform)` direct-call path resolves to the per-window
		// path so SSR can hydrate a specific window's initial state.
		const memberDecls = [];
		for (const wn of windows) {
			memberDecls.push(`const _${name}_${wn} = readable(undefined);`);
			memberDecls.push(`_${name}_${wn}.hydrate = (d) => readable(d);`);
			memberDecls.push(`_${name}_${wn}.load = (platform, options) => __directCall(${JSON.stringify(modulePath + '/' + name + '/__window/' + wn)}, options?.args || [], platform, options);`);
		}
		lines.push(...memberDecls);
		const ns = windows.map(wn => `${JSON.stringify(wn)}: _${name}_${wn}`).join(', ');
		lines.push(`const _${name} = { ${ns} };`);
		lines.push(`export { _${name} as ${name} };`);
	}

	for (const { name, info } of rooms) {
		// Room namespace: always factory-shaped sub-streams (rooms are
		// per-instance dynamic by design; the topic function takes the
		// boardId-equivalent argument). Actions are no-op promise-returning
		// stubs that resolve with undefined; they are never called during
		// SSR (action handlers fire post-hydration on user interaction).
		lines.push(`const _${name}_data = (...args) => { const s = readable(undefined); s.hydrate = (d) => readable(d); return s; };`);
		lines.push(`_${name}_data.load = (platform, options) => __directCall(${JSON.stringify(modulePath + '/' + name + '/__data')}, options?.args || [], platform, options);`);
		const subFactories = [`data: _${name}_data`];
		if (info.hasPresence) {
			lines.push(`const _${name}_presence = (...args) => readable(undefined);`);
			subFactories.push(`presence: _${name}_presence`);
		}
		if (info.hasCursors) {
			lines.push(`const _${name}_cursors = (...args) => readable(undefined);`);
			subFactories.push(`cursors: _${name}_cursors`);
		}
		for (const action of info.actions) {
			subFactories.push(`${action}: () => Promise.resolve(undefined)`);
		}
		lines.push(`const _${name} = { ${subFactories.join(', ')} };`);
		lines.push(`export { _${name} as ${name} };`);
	}

	for (const { name, info } of multiplayers) {
		// Multiplayer namespace: the same factory-shaped sub-streams a room
		// uses, plus an empty connection-status readable and no-op cursor
		// methods. The client factory replaces all of this on hydration.
		lines.push(`const _${name}_data = (...args) => { const s = readable(undefined); s.hydrate = (d) => readable(d); return s; };`);
		lines.push(`_${name}_data.load = (platform, options) => __directCall(${JSON.stringify(modulePath + '/' + name + '/__data')}, options?.args || [], platform, options);`);
		const mpFactories = [`data: _${name}_data`];
		if (info.hasPresence) {
			lines.push(`const _${name}_presence = (...args) => readable(undefined);`);
			mpFactories.push(`presence: _${name}_presence`);
		}
		if (info.hasCursors) {
			lines.push(`const _${name}_cursors = (...args) => readable(undefined);`);
			mpFactories.push(`cursors: _${name}_cursors`);
		}
		mpFactories.push(`status: readable('connecting')`);
		mpFactories.push(`move: () => {}`);
		mpFactories.push(`reportViewport: () => {}`);
		// Field-surface members rendered as their empty server-side state before
		// hydration (live values arrive on the client once the room subscribes).
		mpFactories.push(`typing: []`);
		mpFactories.push(`locks: {}`);
		mpFactories.push(`selections: {}`);
		mpFactories.push(`reactions: []`);
		mpFactories.push(`setTyping: () => {}`);
		mpFactories.push(`acquireLock: () => {}`);
		mpFactories.push(`releaseLock: () => {}`);
		mpFactories.push(`setSelection: () => {}`);
		mpFactories.push(`react: () => {}`);
		// identify(...) and room(...) render their empty collaborative state on
		// the server so a page that names self or reads the aggregated roster
		// during SSR does not crash before hydration. No rune import on the
		// server: room() returns a plain object, not a MultiplayerRoom. The gate
		// mirrors the client room-view gate exactly (presence, cursors, OR any
		// field surface) so a field-only export renders room() on both sides and
		// never throws board.room-is-not-a-function during SSR.
		const ssrHasField = info.typing || info.hasLocks || info.selections || info.reactions;
		if (info.hasPresence || info.hasCursors || ssrHasField) {
			mpFactories.push(`identify: () => {}`);
			mpFactories.push(`room: () => ({ others: [], cursors: [], me: null, status: 'connecting', typing: [], locks: {}, selections: {}, reactions: [], move: () => {}, reportViewport: () => {}, setTyping: () => {}, acquireLock: () => {}, releaseLock: () => {}, setSelection: () => {}, react: () => {}, destroy: () => {} })`);
		}
		for (const action of info.actions) {
			mpFactories.push(`${action}: () => Promise.resolve(undefined)`);
		}
		lines.push(`const _${name} = { ${mpFactories.join(', ')} };`);
		lines.push(`export { _${name} as ${name} };`);
	}

	for (const name of smooths) {
		// Smooth namespace: no-op send paths and a factory returning the
		// view's empty server-side shape. `local` echoes the caller's own
		// initial (the trailing factory argument carries it at runtime), so
		// SSR markup renders the entity at its starting state and the client
		// factory replaces everything on hydration.
		lines.push(`const _${name} = { _command: () => Promise.resolve(undefined), _sync: () => Promise.resolve(undefined), status: readable('connecting'), smooth: (...args) => { const o = args.length > 0 ? args[args.length - 1] : undefined; return { local: o && typeof o === 'object' ? o.initial : undefined, remote: new Map(), status: 'connecting', overflowed: false, self: null, command: () => 0, shoot: () => {}, now: () => 0, resync: () => {}, onEvent: () => () => {}, destroy: () => {} }; } };`);
		lines.push(`export { _${name} as ${name} };`);
	}

	if (docs.length > 0) {
		// Inert empty replica views for SSR: empty containers, no-op writes,
		// shared lifecycle fields. The client factory replaces everything on
		// hydration; markup renders the document at its empty starting state.
		lines.push(`const __ssrDocBase = () => ({ readOnly: false, synced: false, degraded: false, access: null, status: 'connecting', resync: () => {}, destroy: () => {} });`);
		lines.push(`const __ssrDocMap = () => ({ ...__ssrDocBase(), get: () => undefined, has: () => false, size: 0, keys: () => [][Symbol.iterator](), values: () => [][Symbol.iterator](), entries: () => [][Symbol.iterator](), toJSON: () => ({}), set: () => {}, delete: () => {}, clear: () => {} });`);
		lines.push(`const __ssrDocArray = () => ({ ...__ssrDocBase(), at: () => undefined, length: 0, toArray: () => [], toJSON: () => [], push: () => {}, insert: () => {}, delete: () => {} });`);
		lines.push(`const __ssrDocText = () => ({ ...__ssrDocBase(), toString: () => '', value: '', length: 0, insert: () => {}, delete: () => {} });`);
		lines.push(`const __ssrDocHandle = () => ({ ...__ssrDocBase(), map: () => __ssrDocMap(), array: () => __ssrDocArray(), text: () => __ssrDocText(), transact: () => {} });`);
	}
	for (const { name, kind } of docs) {
		const factory = kind === 'doc' ? '__ssrDocHandle' : kind === 'map' ? '__ssrDocMap' : '__ssrDocArray';
		lines.push(`const _${name} = { _sync: () => Promise.resolve(undefined), _update: () => {}, _close: () => {}, status: readable('connecting'), ${kind}: () => ${factory}() };`);
		lines.push(`export { _${name} as ${name} };`);
	}

	return lines.join('\n') + '\n';
}
