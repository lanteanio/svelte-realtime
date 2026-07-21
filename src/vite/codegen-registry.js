// @ts-check
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, relative, sep, posix } from 'path';
import { _readCached } from './source-cache.js';
import { _readStringLiteral, _skipStringContent, _findMatchingBrace, _extractTemplatePattern, _parseArrowReturnTemplate, _warnUnsafeExports } from './scanner.js';
import { _extractAggregateWindows, _extractFlagDecl } from './extract-options.js';
import { LIVE_EXPORT_RE, VALIDATED_EXPORT_RE, STREAM_EXPORT_RE, GUARD_EXPORT_RE, DYNAMIC_STREAM_RE, CRON_EXPORT_RE, BINARY_EXPORT_RE, UPLOAD_EXPORT_RE, DERIVED_EXPORT_RE, DYNAMIC_DERIVED_RE, ROOM_EXPORT_RE, MULTIPLAYER_EXPORT_RE, SMOOTH_EXPORT_RE, DOC_EXPORT_RE, WEBHOOK_EXPORT_RE, WEBHOOK_INBOUND_EXPORT_RE, WEBHOOK_OUTBOUND_EXPORT_RE, CHANNEL_EXPORT_RE, DYNAMIC_CHANNEL_RE, RATE_LIMIT_EXPORT_RE, EFFECT_EXPORT_RE, AGGREGATE_EXPORT_RE, FLAG_EXPORT_RE, LOCK_EXPORT_RE, PUBLIC_EXPORT_RE, PUBLIC_COMMENT_RE, IDEMPOTENT_EXPORT_RE, VOLATILE_EXPORT_RE } from './patterns.js';

/**
 * Parse the body of a defineTopics({...}) call, returning an array of
 * `{ name, pattern }` entries for every entry that resolves to a static
 * pattern. Entries whose values are dynamic (function references,
 * spreads, etc.) are silently skipped.
 * @param {string} body
 * @returns {Array<{ name: string, pattern: string }>}
 */
export function _parseTopicsEntries(body) {
	const entries = [];
	let i = 0;
	while (i < body.length) {
		while (i < body.length && /[\s,]/.test(body[i])) i++;
		if (i >= body.length) break;
		if (body[i] === '/' && body[i + 1] === '/') {
			while (i < body.length && body[i] !== '\n') i++;
			continue;
		}
		if (body[i] === '/' && body[i + 1] === '*') {
			i += 2;
			while (i < body.length - 1 && !(body[i] === '*' && body[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		let name = null;
		if (/[a-zA-Z_$]/.test(body[i])) {
			const start = i;
			while (i < body.length && /[\w$]/.test(body[i])) i++;
			name = body.slice(start, i);
		} else if (body[i] === '\'' || body[i] === '"') {
			const lit = _readStringLiteral(body, i);
			if (!lit) { i++; continue; }
			name = lit.value;
			i = lit.end + 1;
		} else {
			i++;
			continue;
		}
		while (i < body.length && /\s/.test(body[i])) i++;
		if (body[i] !== ':') {
			while (i < body.length && body[i] !== ',' && body[i] !== '\n') i++;
			continue;
		}
		i++;
		while (i < body.length && /\s/.test(body[i])) i++;
		if (!name || !/^[a-zA-Z_$][\w$]*$/.test(name) || name === '__patterns' || name === '__definedTopics') {
			let depth = 0;
			while (i < body.length) {
				const c = body[i];
				if (c === '\'' || c === '"' || c === '`') { i = _skipStringContent(body, i) + 1; continue; }
				if (c === '{' || c === '(' || c === '[') depth++;
				else if (c === '}' || c === ')' || c === ']') { depth--; if (depth < 0) break; }
				else if (c === ',' && depth === 0) break;
				i++;
			}
			continue;
		}
		let parsed = null;
		if (body[i] === '\'' || body[i] === '"' || body[i] === '`') {
			const lit = _extractTemplatePattern(body, i, []);
			if (lit) {
				parsed = lit;
				i = lit.end + 1;
			}
		} else {
			parsed = _parseArrowReturnTemplate(body, i);
			if (parsed) i = parsed.end + 1;
		}
		if (parsed) {
			entries.push({ name, pattern: parsed.pattern });
		} else {
			let depth = 0;
			while (i < body.length) {
				const c = body[i];
				if (c === '\'' || c === '"' || c === '`') { i = _skipStringContent(body, i) + 1; continue; }
				if (c === '{' || c === '(' || c === '[') depth++;
				else if (c === '}' || c === ')' || c === ']') { depth--; if (depth < 0) break; }
				else if (c === ',' && depth === 0) break;
				i++;
			}
		}
	}
	return entries;
}

/**
 * Find every `defineTopics({...})` call in `source` and return the union
 * of their parsed entries.
 * @param {string} source
 * @returns {Array<{ name: string, pattern: string }>}
 */
export function _extractDefineTopicsPatterns(source) {
	const all = [];
	let from = 0;
	while (from < source.length) {
		const callIdx = source.indexOf('defineTopics(', from);
		if (callIdx < 0) break;
		const openIdx = source.indexOf('{', callIdx + 13);
		if (openIdx < 0) break;
		const before = source.slice(callIdx + 13, openIdx);
		if (!/^\s*$/.test(before)) { from = callIdx + 13; continue; }
		const closeIdx = _findMatchingBrace(source, openIdx);
		if (closeIdx < 0) break;
		const body = source.slice(openIdx + 1, closeIdx);
		all.push(..._parseTopicsEntries(body));
		from = closeIdx + 1;
	}
	return all;
}

/**
 * Walk `srcDir` recursively (skipping node_modules, the live dir, and
 * dotted entries) and return paths of `.js`/`.ts` files that contain a
 * `defineTopics(` call.
 * @param {string} srcDir
 * @param {string} liveDir
 * @returns {string[]}
 */
export function _findTopicsFiles(srcDir, liveDir) {
	const results = [];
	if (!existsSync(srcDir)) return results;
	const liveResolved = liveDir;
	function walk(dir) {
		let entries;
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (name.startsWith('.') || name === 'node_modules') continue;
			const full = resolve(dir, name);
			if (full === liveResolved) continue;
			let s;
			try { s = statSync(full); } catch { continue; }
			if (s.isDirectory()) { walk(full); continue; }
			if (!/\.[jt]s$/.test(name) || name.endsWith('.d.ts') || name.endsWith('.test.js') || name.endsWith('.test.ts')) continue;
			let content;
			try { content = readFileSync(full, 'utf-8'); } catch { continue; }
			if (content.includes('defineTopics(')) results.push(full);
		}
	}
	walk(srcDir);
	return results;
}

/**
 * Build the topics registry for the project: walk `srcDir` for files
 * that call `defineTopics(...)`, parse each call, and return the union
 * of patterns as both raw strings and pre-compiled regexes. Returns
 * null when no `defineTopics` call exists anywhere - callers use that
 * as the signal to skip the unregistered-topic warning entirely.
 * @param {string} srcDir
 * @param {string} liveDir
 * @returns {{ patterns: Array<{ name: string, pattern: string, regex: RegExp }> } | null}
 */
export function _buildTopicsRegistry(srcDir, liveDir) {
	const files = _findTopicsFiles(srcDir, liveDir);
	if (files.length === 0) return null;
	const seen = new Set();
	const patterns = [];
	for (const f of files) {
		let src;
		try { src = readFileSync(f, 'utf-8'); } catch { continue; }
		const entries = _extractDefineTopicsPatterns(src);
		for (const e of entries) {
			const key = e.name + '\0' + e.pattern;
			if (seen.has(key)) continue;
			seen.add(key);
			const escaped = e.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{arg\w+\\\}/g, '.+');
			patterns.push({ name: e.name, pattern: e.pattern, regex: new RegExp('^' + escaped + '$') });
		}
	}
	return { patterns };
}

/**
 * @param {string} topic
 * @param {{ patterns: Array<{ regex: RegExp }> } | null} registry
 * @returns {boolean}
 */
export function _topicIsRegistered(topic, registry) {
	if (!registry) return true;
	for (const p of registry.patterns) if (p.regex.test(topic)) return true;
	return false;
}

/**
 * Resolve a module path to a real file.
 * @param {string} liveDir
 * @param {string} modulePath
 * @returns {string | null}
 */
export function _resolveFile(liveDir, modulePath) {
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
 * Generate the registry module that imports all live functions.
 * @param {string} liveDir
 * @param {string} dir
 * @returns {string}
 */
export function _generateRegistry(liveDir, dir, topicsRegistry) {
	if (!existsSync(liveDir)) return '// No live modules found\n';

	const files = _findLiveFiles(liveDir);
	const lines = [
		`import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate, __registerRoomActions, __registerFlag, __registerWebhookOut } from 'svelte-realtime/server';`,
		`const __L = fn => (fn.__lazy = true, fn);\n`
	];

	/** @type {Set<string>} */
	const seenTopics = new Set();
	/** @type {Set<string>} Track already-warned (file:topic) pairs to avoid duplicates */
	const warnedUnregistered = new Set();
	/**
	 * @param {string} topic
	 * @param {string} relPath
	 * @param {string} apiName
	 */
	const _maybeWarnUnregistered = (topic, relPath, apiName) => {
		if (!topicsRegistry) return;
		if (_topicIsRegistered(topic, topicsRegistry)) return;
		const k = relPath + '\0' + topic;
		if (warnedUnregistered.has(k)) return;
		warnedUnregistered.add(k);
		console.warn(
			`[svelte-realtime] ${dir}/${relPath}: ${apiName} topic '${topic}' is not in your TOPICS registry. ` +
			`Either add it to defineTopics({...}) or call TOPICS.<name>(...) instead of passing a string literal.\n` +
			`  See: https://svti.me/topics`
		);
	};

	for (const filePath of files) {
		const rel = relative(liveDir, filePath).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
		const source = _readCached(filePath);
		const normalizedPath = filePath.split(sep).join(posix.sep);

		const _importPath = JSON.stringify(normalizedPath);
		/** @param {string} name */
		const _lazy = (name) => `__L(() => import(${_importPath}).then(m => m.${name}))`;

		// Register live() exports
		/** @type {Set<string>} */
		const registered = new Set();
		let match;
		// live() and the wrappers that share the plain __register line
		// (validated/lock/idempotent/rateLimit/volatile).
		for (const re of [LIVE_EXPORT_RE, VALIDATED_EXPORT_RE, LOCK_EXPORT_RE, IDEMPOTENT_EXPORT_RE, RATE_LIMIT_EXPORT_RE, VOLATILE_EXPORT_RE]) {
			re.lastIndex = 0;
			while ((match = re.exec(source)) !== null) {
				const name = match[1];
				if (!/^\w+$/.test(name)) continue;
				if (registered.has(name)) continue;
				registered.add(name);
				lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Register live.stream() exports
		STREAM_EXPORT_RE.lastIndex = 0;
		while ((match = STREAM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);

			// Check for duplicate stream topics
			const topicPattern = new RegExp(
				`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`
			);
			const topicMatch = topicPattern.exec(source);
			if (topicMatch) {
				const topic = topicMatch[1];
				if (topic.startsWith('__')) {
					throw new Error(
						`[svelte-realtime] ${dir}/${rel} uses reserved topic '${topic}' - topics starting with __ are reserved for internal use\n  See: https://svti.me/streams`
					);
				}
				if (seenTopics.has(topic)) {
					throw new Error(
						`[svelte-realtime] Duplicate stream topic '${topic}' in ${dir}/${rel} - each topic must be unique across all modules\n  See: https://svti.me/streams`
					);
				}
				seenTopics.add(topic);
				_maybeWarnUnregistered(topic, rel, 'live.stream');
			}
		}

		// Register guard
		GUARD_EXPORT_RE.lastIndex = 0;
		if (GUARD_EXPORT_RE.exec(source) !== null) {
			lines.push(`__registerGuard(${JSON.stringify(rel)}, ${_lazy('_guard')});`);
		}

		// Register live.binary() exports
		BINARY_EXPORT_RE.lastIndex = 0;
		while ((match = BINARY_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Register live.upload() exports
		UPLOAD_EXPORT_RE.lastIndex = 0;
		while ((match = UPLOAD_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Register cron jobs
		CRON_EXPORT_RE.lastIndex = 0;
		while ((match = CRON_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			lines.push(`__registerCron(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
		}

		// Register live.derived() exports
		DERIVED_EXPORT_RE.lastIndex = 0;
		while ((match = DERIVED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
				lines.push(`__registerDerived(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Register live.smooth() exports - the command and sync send paths
		// resolve lazily to the export's attached handlers.
		SMOOTH_EXPORT_RE.lastIndex = 0;
		while ((match = SMOOTH_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				const importPath = JSON.stringify(normalizedPath);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__smooth/command')}, __L(() => import(${importPath}).then(m => m.${name}.__smoothCommand)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__smooth/sync')}, __L(() => import(${importPath}).then(m => m.${name}.__smoothSync)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__smooth/center')}, __L(() => import(${importPath}).then(m => m.${name}.__smoothCenter)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__smooth/shoot')}, __L(() => import(${importPath}).then(m => m.${name}.__smoothShoot)), ${JSON.stringify(rel)});`);
			}
		}

		// Register CRDT document exports - the sync, update, and close send
		// paths resolve lazily to the export's attached handlers.
		DOC_EXPORT_RE.lastIndex = 0;
		while ((match = DOC_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				const importPath = JSON.stringify(normalizedPath);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__doc/sync')}, __L(() => import(${importPath}).then(m => m.${name}.__docSync)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__doc/update')}, __L(() => import(${importPath}).then(m => m.${name}.__docUpdate)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__doc/close')}, __L(() => import(${importPath}).then(m => m.${name}.__docClose)), ${JSON.stringify(rel)});`);
			}
		}

		// Register live.multiplayer() exports - a multiplayer export reuses the
		// room sub-streams at runtime, so it registers the same
		// __data/__presence/__cursors paths plus its scoped actions lazily.
		// Running before the room loop and marking the name means the room loop
		// (which guards on registered) skips it - never double-registered.
		MULTIPLAYER_EXPORT_RE.lastIndex = 0;
		while ((match = MULTIPLAYER_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				const importPath = JSON.stringify(normalizedPath);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__data')}, __L(() => import(${importPath}).then(m => m.${name}.__dataStream)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__presence')}, __L(() => import(${importPath}).then(m => m.${name}.__presenceStream)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__owner')}, __L(() => import(${importPath}).then(m => m.${name}.__ownerStream)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__cursors')}, __L(() => import(${importPath}).then(m => m.${name}.__cursorStream)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__cursor/move')}, __L(() => import(${importPath}).then(m => m.${name}.__cursorMove)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__cursor/reportViewport')}, __L(() => import(${importPath}).then(m => m.${name}.__cursorReportViewport)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__presence/update')}, __L(() => import(${importPath}).then(m => m.${name}.__presenceUpdate)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__reactions')}, __L(() => import(${importPath}).then(m => m.${name}.__reactionStream)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__reaction/emit')}, __L(() => import(${importPath}).then(m => m.${name}.__reactionEmit)), ${JSON.stringify(rel)});`);
				lines.push(`__registerRoomActions(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Register live.room() exports - register sub-streams and actions lazily
		ROOM_EXPORT_RE.lastIndex = 0;
		while ((match = ROOM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				const importPath = JSON.stringify(normalizedPath);
				// Register the data stream - inherit file-level guard via explicit module path
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__data')}, __L(() => import(${importPath}).then(m => m.${name}.__dataStream)), ${JSON.stringify(rel)});`);
				// Register presence stream if present
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__presence')}, __L(() => import(${importPath}).then(m => m.${name}.__presenceStream)), ${JSON.stringify(rel)});`);
				// Register owner stream if present
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__owner')}, __L(() => import(${importPath}).then(m => m.${name}.__ownerStream)), ${JSON.stringify(rel)});`);
				// Register cursor stream if present
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__cursors')}, __L(() => import(${importPath}).then(m => m.${name}.__cursorStream)), ${JSON.stringify(rel)});`);
				// Register the enumeration stream + one-shot snapshot if the room opted
				// in (resolves to undefined and is never subscribed for a plain room).
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__rooms')}, __L(() => import(${importPath}).then(m => m.${name}.__roomsStream)), ${JSON.stringify(rel)});`);
				lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__roomsSync')}, __L(() => import(${importPath}).then(m => m.${name}.__roomsSync)), ${JSON.stringify(rel)});`);
				// Register actions (deferred - resolved on first RPC or cron tick)
				lines.push(`__registerRoomActions(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Inbound webhooks (flat live.webhook + live.webhooks.inbound) are
		// server-only manual handlers: no client stub AND no server-side
		// registration (the app calls handler.handle(req) itself).
		for (const re of [WEBHOOK_EXPORT_RE, WEBHOOK_INBOUND_EXPORT_RE]) {
			re.lastIndex = 0;
			while ((match = re.exec(source)) !== null) {
				registered.add(match[1]);
			}
		}

		// Outbound webhooks ARE registered server-side (they watch source topics
		// and fire on publish, like effects); still no client stub.
		WEBHOOK_OUTBOUND_EXPORT_RE.lastIndex = 0;
		while ((match = WEBHOOK_OUTBOUND_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__registerWebhookOut(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Register live.channel() exports (treated like streams)
		CHANNEL_EXPORT_RE.lastIndex = 0;
		while ((match = CHANNEL_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
			const channelTopicPattern = new RegExp(
				`export\\s+const\\s+${name}\\s*=\\s*live\\.channel\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`
			);
			const channelTopicMatch = channelTopicPattern.exec(source);
			if (channelTopicMatch) {
				_maybeWarnUnregistered(channelTopicMatch[1], rel, 'live.channel');
			}
		}

		// Register live.effect() exports
		EFFECT_EXPORT_RE.lastIndex = 0;
		while ((match = EFFECT_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__registerEffect(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
			}
		}

		// Register live.aggregate() exports
		AGGREGATE_EXPORT_RE.lastIndex = 0;
		while ((match = AGGREGATE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				const windowKeys = _extractAggregateWindows(source, name);
				if (windowKeys && windowKeys.length > 0) {
					// Windowed: register the watcher under the export's path
					// (the watcher fans events to all windows on event); then
					// register one stream path per window so clients can
					// subscribe to per-window output topics. The per-window
					// stream functions live on the root export as
					// `__windowStreams[windowName]`.
					const importPath = JSON.stringify(normalizedPath);
					lines.push(`__registerAggregate(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
					for (const wn of windowKeys) {
						lines.push(`__register(${JSON.stringify(rel + '/' + name + '/__window/' + wn)}, __L(() => import(${importPath}).then(m => m.${name}.__windowStreams[${JSON.stringify(wn)}])), ${JSON.stringify(rel)});`);
					}
				} else {
					lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
					lines.push(`__registerAggregate(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
				}
			}
		}

		// Register live.flag() exports. The stream registration stays lazy (the
		// flag module is imported on first subscribe), but the refresh watcher
		// is installed eagerly via __registerFlag at registry-module load - the
		// same lifecycle that activates live.effect watchers - so a server-side
		// .get() reflects cluster-latest sets from boot without waiting for the
		// flag module's first local import.
		FLAG_EXPORT_RE.lastIndex = 0;
		while ((match = FLAG_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register(${JSON.stringify(rel + '/' + name)}, ${_lazy(name)});`);
				const decl = _extractFlagDecl(source, name);
				if (decl) {
					const initArg = decl.initialArg === null ? '' : `, ${decl.initialArg}`;
					lines.push(`__registerFlag(${JSON.stringify(decl.topic)}${initArg});`);
				}
			}
		}

		// Warn about exports with non-path-safe names (pass registered to avoid
		// double-warning for names already handled above)
		_warnUnsafeExports(source, `${dir}/${rel}`, registered);
	}

	return lines.join('\n') + '\n';
}

/**
 * Recursively find all .js/.ts files in the live directory.
 * @param {string} dir
 * @returns {string[]}
 */
export function _findLiveFiles(dir) {
	/** @type {string[]} */
	const results = [];
	if (!existsSync(dir)) return results;

	for (const entry of readdirSync(dir)) {
		const full = resolve(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(..._findLiveFiles(full));
		} else if (/\.[jt]s$/.test(entry) && !entry.endsWith('.d.ts') && !entry.endsWith('.test.js') && !entry.endsWith('.test.ts') && !/\.shared\.[jt]s$/.test(entry)) {
			results.push(full);
		}
	}

	return results;
}

/**
 * Check that src/hooks.ws.{js,ts,mjs} exists and exports the `message` handler.
 * Warns at build/dev startup if the file is missing or misconfigured.
 * @param {string} root
 * @param {string} liveDir
 * @param {string} dir
 */
export function _checkHooksFile(root, liveDir, dir) {
	const files = _findLiveFiles(liveDir);
	if (files.length === 0) return;

	const hooksPath = resolve(root, 'src/hooks.ws');
	// Match the extension set the adapter discovers (js, ts, mjs) so a project
	// using hooks.ws.mjs is not falsely told its hooks file is missing.
	const found = ['.js', '.ts', '.mjs']
		.map((ext) => hooksPath + ext)
		.find((p) => existsSync(p)) || null;

	if (!found) {
		console.warn(
			`[svelte-realtime] Found live modules in ${dir}/ but no src/hooks.ws.js - ` +
			`WebSocket RPC will not work without it.\n` +
			`  Create src/hooks.ws.js with at minimum:\n` +
			`    export { message } from 'svelte-realtime/server';\n` +
			`    export function upgrade() { return {}; }\n` +
			`  See: https://svti.me/hooks`
		);
		return;
	}

	let source;
	try { source = readFileSync(found, 'utf-8'); } catch { return; }

	// Recognise every way a hooks file can export `message`:
	//   - direct re-export:    export { message } from 'svelte-realtime/server'
	//   - import-then-export:  import { message } from '...'; export { message }
	//     (the scaffold and e2e fixture both use this two-statement form)
	//   - local declaration:   export const/function message = ...
	// The specifier-list regex covers the first two without needing a `from`
	// clause; a leading `from` (the direct re-export) still satisfies it.
	const hasMessage = /export\s*\{[^}]*\bmessage\b[^}]*\}/.test(source)
		|| /export\s+(?:const|function|async\s+function)\s+message\b/.test(source);

	if (!hasMessage) {
		const name = 'src/hooks.ws' + (found.match(/\.(?:js|ts|mjs)$/)?.[0] || '.js');
		console.warn(
			`[svelte-realtime] ${name} exists but does not export a \`message\` handler - ` +
			`WebSocket RPC calls from ${dir}/ will go unhandled.\n` +
			`  Add: export { message } from 'svelte-realtime/server';\n` +
			`  See: https://svti.me/hooks`
		);
	}
}
