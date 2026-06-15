// @ts-check
import { _skipNonCode, _readStringLiteral } from './scanner.js';

/**
 * Walk a string and extract the content of the last balanced `{ ... }` block
 * before a closing `)`. Returns the content between the braces, or null if
 * no balanced block is found.
 *
 * This handles nested braces inside init functions so we don't misparse
 * `live.stream(topic, async () => { wrap('x', { local: true }) }, { merge: 'set' })`
 * as `merge: undefined` due to the inner `{ local: true }` ending the match early.
 *
 * @param {string} s - Source text after the first argument of live.stream(
 * @returns {string | null}
 */
export function _extractLastOptions(s) {
	let braceDepth = 0;
	let parenDepth = 0;
	let lastOpenIdx = -1;
	let lastContent = null;

	for (let i = 0; i < s.length; i++) {
		const skip = _skipNonCode(s, i);
		if (skip >= 0) { i = skip; continue; }

		const ch = s[i];
		if (ch === '(') { parenDepth++; continue; }
		if (ch === ')') {
			if (parenDepth > 0) { parenDepth--; continue; }
			// Top-level ) - this closes the live.stream() call
			return lastContent;
		}
		if (ch === '{') {
			if (braceDepth === 0 && parenDepth === 0) lastOpenIdx = i;
			braceDepth++;
		} else if (ch === '}') {
			braceDepth--;
			if (braceDepth === 0 && parenDepth === 0 && lastOpenIdx >= 0) {
				lastContent = s.slice(lastOpenIdx + 1, i);
			}
		}
	}
	return lastContent;
}

/**
 * Extract the brace-delimited value of a top-level object property.
 * Returns the content between { } for `keyName: { ... }` or `'keyName': { ... }`.
 * @param {string} body
 * @param {string} keyName
 * @returns {string | null}
 */
export function _extractTopLevelBraceProp(body, keyName) {
	let depth = 0;
	const ID_CHAR = /[\w$]/;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];

		const skip = _skipNonCode(body, i);
		if (skip >= 0) {
			// At depth 0, a skipped quote might be a quoted key - check before skipping
			if (depth === 0 && (ch === '\'' || ch === '"')) {
				const rest = body.slice(i);
				const qm = rest.match(new RegExp(`^(['"])${keyName}\\1\\s*:\\s*`));
				if (qm) {
					const afterColon = body.slice(i + qm[0].length);
					return _extractBraceContent(afterColon);
				}
			}
			i = skip; continue;
		}

		if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
		if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }
		if (depth !== 0) continue;

		const rest = body.slice(i);
		const bare = rest.match(new RegExp(`^${keyName}\\s*:\\s*`));
		if (bare) {
			const afterColon = body.slice(i + bare[0].length);
			return _extractBraceContent(afterColon);
		}

		if (ID_CHAR.test(ch)) {
			while (i + 1 < body.length && ID_CHAR.test(body[i + 1])) i++;
		}
	}
	return null;
}

/**
 * Extract only top-level property keys from an object body string.
 * Tracks brace/paren/bracket depth so nested objects don't leak keys.
 * @param {string} body - Content between the outer { }
 * @returns {string[]}
 */
export function _extractTopLevelKeys(body) {
	const keys = [];
	let depth = 0;
	let i = 0;
	const ID_CHAR = /[\w$]/;

	while (i < body.length) {
		const ch = body[i];

		// At depth 0, check for quoted key before _skipNonCode consumes the string
		if (depth === 0 && (ch === '\'' || ch === '"')) {
			// Find the end of this simple string to check for key: pattern
			let closeIdx = -1;
			for (let j = i + 1; j < body.length; j++) {
				if (body[j] === '\\') { j++; continue; }
				if (body[j] === ch) { closeIdx = j; break; }
			}
			if (closeIdx > i) {
				const afterClose = body.slice(closeIdx + 1).match(/^\s*(?:\(|:)/);
				if (afterClose) {
					const keyName = body.slice(i + 1, closeIdx);
					if (/^[a-zA-Z0-9_]+$/.test(keyName)) {
						keys.push(keyName);
					} else if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
						console.warn(`[svelte-realtime] Action name '${keyName}' contains characters not allowed in RPC paths - skipped\n  See: https://svti.me/rooms`);
					}
					i = closeIdx + 1 + afterClose[0].length;
					// If the match ended with '(' (quoted method shorthand), track depth
					if (afterClose[0].trimStart() === '(') depth++;
					continue;
				}
			}
		}

		const skip = _skipNonCode(body, i);
		if (skip >= 0) { i = skip + 1; continue; }

		if (ch === '{' || ch === '(' || ch === '[') { depth++; i++; continue; }
		if (ch === '}' || ch === ')' || ch === ']') { depth--; i++; continue; }

		if (depth === 0) {
			// Bare identifier key (including $-prefixed): name: or async name(
			const rest = body.slice(i);
			const m = rest.match(/^(?:async\s+)?([\w$]+)\s*(?:\(|:)/);
			if (m && m[1] !== 'async') {
				if (/^[a-zA-Z0-9_]+$/.test(m[1])) {
					keys.push(m[1]);
				} else if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
					console.warn(`[svelte-realtime] Action name '${m[1]}' contains characters not allowed in RPC paths (only a-z, A-Z, 0-9, _ are valid) - skipped\n  See: https://svti.me/rooms`);
				}
				i += m[0].length;
				// If the match ended with '(' (method shorthand), account for the
				// consumed opening paren so the depth tracker stays correct.
				if (m[0][m[0].length - 1] === '(') depth++;
				continue;
			}
			if (ID_CHAR.test(ch)) {
				while (i < body.length && ID_CHAR.test(body[i])) i++;
				continue;
			}
		}

		i++;
	}

	return keys;
}

/**
 * Extract the string value of a top-level property from an object body.
 * Returns null if the key is not a top-level property or its value is not a string literal.
 * @param {string} body
 * @param {string} keyName
 * @returns {string | null}
 */
export function _extractTopLevelStringProp(body, keyName) {
	let depth = 0;
	const ID_CHAR = /[\w$]/;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];

		// At depth 0, check for quoted key before _skipNonCode consumes the string
		if (depth === 0 && (ch === '\'' || ch === '"' || ch === '`')) {
			const rest = body.slice(i);
			const qm = rest.match(new RegExp(`^(['"\`])${keyName}\\1\\s*:`));
			if (qm) {
				// Advance past the colon, skip whitespace, read string value
				const valStart = i + qm[0].length;
				const trimmed = body.slice(valStart).search(/\S/);
				if (trimmed >= 0) {
					const lit = _readStringLiteral(body, valStart + trimmed);
					if (lit) return lit.value;
				}
			}
		}

		const skip = _skipNonCode(body, i);
		if (skip >= 0) { i = skip; continue; }

		// Depth tracking
		if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
		if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }

		if (depth !== 0) continue;

		// Bare key: keyName:
		const rest = body.slice(i);
		const bare = rest.match(new RegExp(`^${keyName}\\s*:`));
		if (bare) {
			const valStart = i + bare[0].length;
			const trimmed = body.slice(valStart).search(/\S/);
			if (trimmed >= 0) {
				const lit = _readStringLiteral(body, valStart + trimmed);
				if (lit) return lit.value;
			}
		}

		// Skip whole word to avoid partial matches
		if (ID_CHAR.test(ch)) {
			while (i + 1 < body.length && ID_CHAR.test(body[i + 1])) i++;
		}
	}
	return null;
}

/**
 * Extract the raw value token of a top-level property from an object body.
 * Returns the trimmed text between the colon and the next comma/closing-brace at depth 0,
 * or null if the key is not found at the top level.
 * Useful for boolean, numeric, and simple object values where _extractTopLevelStringProp
 * (which only reads quoted strings) is too narrow.
 * @param {string} body
 * @param {string} keyName
 * @returns {string | null}
 */
export function _extractTopLevelRawValue(body, keyName) {
	let depth = 0;
	const ID_CHAR = /[\w$]/;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];

		// At depth 0, check for quoted key before _skipNonCode consumes the string
		if (depth === 0 && (ch === '\'' || ch === '"')) {
			const rest = body.slice(i);
			const qm = rest.match(new RegExp(`^(['"])${keyName}\\1\\s*:`));
			if (qm) {
				const valStart = i + qm[0].length;
				return _readTopLevelValue(body, valStart);
			}
		}

		const skip = _skipNonCode(body, i);
		if (skip >= 0) { i = skip; continue; }

		if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
		if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }

		if (depth !== 0) continue;

		// Bare key: keyName:
		const rest = body.slice(i);
		const bare = rest.match(new RegExp(`^${keyName}\\s*:`));
		if (bare) {
			const valStart = i + bare[0].length;
			return _readTopLevelValue(body, valStart);
		}

		if (ID_CHAR.test(ch)) {
			while (i + 1 < body.length && ID_CHAR.test(body[i + 1])) i++;
		}
	}
	return null;
}

/**
 * Read a single value expression starting at `start` in `body`, stopping at
 * the next top-level comma or closing brace/paren/bracket.
 * @param {string} body
 * @param {number} start
 * @returns {string}
 */
export function _readTopLevelValue(body, start) {
	let depth = 0;
	let end = body.length;
	for (let i = start; i < body.length; i++) {
		const skip = _skipNonCode(body, i);
		if (skip >= 0) { i = skip; continue; }

		const ch = body[i];
		if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
		if (ch === '}' || ch === ')' || ch === ']') {
			if (depth === 0) { end = i; break; }
			depth--;
			continue;
		}
		if (ch === ',' && depth === 0) { end = i; break; }
	}
	return body.slice(start, end).trim();
}

/**
 * Extract stream options from source code.
 * @param {string} source
 * @param {string} name
 * @returns {{ merge?: string, key?: string, prepend?: boolean, max?: number }}
 */
export function _extractStreamOptions(source, name) {
	/** @type {any} */
	const opts = { merge: 'crud' };

	// Try topic-string pattern first: live.stream('topic', ...)
	const topicPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\(\\s*(['"\`])([^'"\`]+)\\1`,
		's'
	);
	const topicMatch = topicPattern.exec(source);

	let rest;
	if (topicMatch) {
		rest = source.slice(topicMatch.index + topicMatch[0].length);
	} else {
		// Fallback for dynamic streams: live.stream((ctx) => ..., { opts })
		const openPattern = new RegExp(
			`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\(`
		);
		const openMatch = openPattern.exec(source);
		if (!openMatch) return opts;
		rest = source.slice(openMatch.index + openMatch[0].length);
	}

	// Find the options object by walking balanced braces from the last { ... }
	// before the closing ) of live.stream(). This handles nested objects
	// inside the init function body without false-matching on them.
	const optStr = _extractLastOptions(rest);
	if (optStr) {
		_applyParsedOptions(opts, optStr);
	}
	if (opts.merge === 'crud' && opts.key === undefined) opts.key = 'id';

	return opts;
}

/**
 * Extract the static declaration of a `live.flag(topic, initialValue)` export:
 * the required topic string literal, and the second argument's source text when
 * it is present. The topic is needed so the registry can install the flag's
 * refresh watcher eagerly (keyed by topic, before the flag module is imported).
 * The `initialArg` is the raw source of the second argument and is emitted only
 * when it is a statically safe literal (a string, number, boolean, or null) so
 * the value cell can be seeded at registry load; anything else is left for the
 * flag body to seed on first import. Returns null when the topic is not a plain
 * string literal (dynamic-topic flags are not supported by the codegen).
 * @param {string} source
 * @param {string} name
 * @returns {{ topic: string, initialArg: string | null } | null}
 */
export function _extractFlagDecl(source, name) {
	const openPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.flag\\s*\\(`
	);
	const openMatch = openPattern.exec(source);
	if (!openMatch) return null;
	let i = openMatch.index + openMatch[0].length;
	while (i < source.length && /\s/.test(source[i])) i++;
	if (source[i] !== '\'' && source[i] !== '"' && source[i] !== '`') return null;
	const topicLit = _readStringLiteral(source, i);
	if (!topicLit) return null;
	const topic = topicLit.value;
	i = topicLit.end + 1;
	while (i < source.length && /\s/.test(source[i])) i++;
	if (source[i] !== ',') return { topic, initialArg: null };
	i++;
	while (i < source.length && /\s/.test(source[i])) i++;
	// Read the second argument up to the next top-level `,` or the closing `)`.
	let depth = 0;
	const argStart = i;
	while (i < source.length) {
		const skipped = _skipNonCode(source, i);
		if (skipped >= 0) { i = skipped + 1; continue; }
		const c = source[i];
		if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
		else if (c === ',' && depth === 0) break;
		i++;
	}
	const rawArg = source.slice(argStart, i).trim();
	if (rawArg === '') return { topic, initialArg: null };
	// Only forward statically safe literals so the generated registry never
	// evaluates user expressions. String literals are re-quoted via the parsed
	// value; primitives pass through verbatim.
	if (rawArg[0] === '\'' || rawArg[0] === '"' || rawArg[0] === '`') {
		const lit = _readStringLiteral(rawArg, 0);
		if (lit && lit.end === rawArg.length - 1) return { topic, initialArg: JSON.stringify(lit.value) };
		return { topic, initialArg: null };
	}
	if (rawArg === 'true' || rawArg === 'false' || rawArg === 'null' || /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(rawArg)) {
		return { topic, initialArg: rawArg };
	}
	return { topic, initialArg: null };
}

/**
 * Parse option properties from an object body string into an opts object.
 * Shared by stream, channel, and room option extraction.
 * Uses _extractTopLevelStringProp for robust quoted-key and non-word value support.
 * @param {Record<string, any>} opts
 * @param {string} optStr
 */
export function _applyParsedOptions(opts, optStr) {
	const mergeVal = _extractTopLevelStringProp(optStr, 'merge');
	if (mergeVal) opts.merge = mergeVal;

	const keyVal = _extractTopLevelStringProp(optStr, 'key');
	if (keyVal) opts.key = keyVal;

	const prependVal = _extractTopLevelRawValue(optStr, 'prepend');
	if (prependVal === 'true') opts.prepend = true;
	else if (prependVal === 'false') opts.prepend = false;

	const maxVal = _extractTopLevelRawValue(optStr, 'max');
	if (maxVal && /^\d+$/.test(maxVal)) opts.max = parseInt(maxVal, 10);

	const replayVal = _extractTopLevelRawValue(optStr, 'replay');
	if (replayVal && replayVal !== 'false') opts.replay = true;

	const versionVal = _extractTopLevelRawValue(optStr, 'version');
	if (versionVal && /^\d+$/.test(versionVal)) opts.version = parseInt(versionVal, 10);
}

/**
 * Extract channel options from source code.
 * @param {string} source
 * @param {string} name
 * @returns {{ merge?: string, key?: string, max?: number }}
 */
export function _extractChannelOptions(source, name) {
	/** @type {any} */
	const opts = { merge: 'set' };

	// Look for the options object in live.channel(topic, { ... })
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.channel\\s*\\(`
	);
	const match = pattern.exec(source);
	if (!match) return opts;

	const startIdx = match.index + match[0].length;
	const rest = source.slice(startIdx);

	const optStr = _extractLastOptions(rest);
	if (optStr) {
		_applyParsedOptions(opts, optStr);
	}
	if (opts.merge === 'crud' && opts.key === undefined) opts.key = 'id';

	return opts;
}

/**
 * Extract room configuration info from source code for client stub generation.
 * @param {string} source
 * @param {string} name
 * @returns {{ dataOpts: any, hasPresence: boolean, hasCursors: boolean, actions: string[] }}
 */
/**
 * Detect a windowed `live.aggregate(...)` export and return the window
 * names declared in its `windows: { ... }` option, or `null` if the
 * export has no windows (single-state form). The plugin treats the
 * presence/absence of windows as the discriminator between
 * "single-stream stub" and "namespace stub" client surfaces.
 *
 * Reuses the same locate-options-block + top-level-keys pattern as
 * `_extractRoomInfo` - the plugin parser only ever needs to know which
 * windows exist, not their type or duration. Window-spec validation
 * (`type`, `durationMs`, `combine` requirement, etc.) lives at module
 * load time on the server side, where the actual reducers and option
 * objects are fully evaluated.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string[] | null}
 */
export function _extractAggregateWindows(source, name) {
	const startPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.aggregate\\s*\\(`
	);
	const startMatch = startPattern.exec(source);
	if (!startMatch) return null;
	const after = source.slice(startMatch.index + startMatch[0].length);
	const optionsBody = _extractLastOptions(after);
	if (!optionsBody) return null;
	const windowsBody = _extractTopLevelBraceProp(optionsBody, 'windows');
	if (!windowsBody) return null;
	const keys = _extractTopLevelKeys(windowsBody).filter(k => /^[A-Za-z_$][\w$]*$/.test(k));
	return keys.length > 0 ? keys : null;
}

export function _extractRoomInfo(source, name) {
	/** @type {{ dataOpts: any, hasPresence: boolean, hasCursors: boolean, actions: string[] }} */
	const info = { dataOpts: { merge: 'crud' }, hasPresence: false, hasCursors: false, actions: [] };

	// Find the start of live.room({ ... }) call
	const startPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.room\\s*\\(`
	);
	const startMatch = startPattern.exec(source);
	if (!startMatch) return info;

	const afterOpen = source.slice(startMatch.index + startMatch[0].length);
	const body = _extractBraceContent(afterOpen);
	if (!body) return info;

	const configKeys = new Set(_extractTopLevelKeys(body));
	info.hasPresence = configKeys.has('presence');
	info.hasCursors = configKeys.has('cursors');

	const mergeVal = _extractTopLevelStringProp(body, 'merge');
	if (mergeVal) info.dataOpts.merge = mergeVal;

	const keyVal = _extractTopLevelStringProp(body, 'key');
	if (keyVal) info.dataOpts.key = keyVal;
	if (info.dataOpts.merge === 'crud' && info.dataOpts.key === undefined) info.dataOpts.key = 'id';

	// Extract action names from the top-level actions property
	const actionsBody = _extractTopLevelBraceProp(body, 'actions');
	if (actionsBody) {
		info.actions = _extractTopLevelKeys(actionsBody);
	}

	return info;
}

/**
 * Extract multiplayer config for client-stub generation. The config is
 * room-shaped (topic / init / presence / cursors / actions / merge / key), so
 * the room extractor supplies the data options and the presence / cursor /
 * action discriminators; the field-surface keys are read separately so a
 * future client surface can be told which surfaces were declared.
 * @param {string} source
 * @param {string} name
 * @returns {{ dataOpts: any, hasPresence: boolean, hasCursors: boolean, actions: string[], typing: boolean, hasLocks: boolean, reactions: boolean, selections: string | null }}
 */
export function _extractMultiplayerInfo(source, name) {
	const startPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.multiplayer\\s*\\(`
	);
	const startMatch = startPattern.exec(source);

	const info = {
		dataOpts: { merge: 'crud', key: 'id' },
		hasPresence: false,
		hasCursors: false,
		actions: [],
		typing: false,
		hasLocks: false,
		reactions: false,
		selections: /** @type {string | null} */ (null)
	};
	if (!startMatch) return info;

	const afterOpen = source.slice(startMatch.index + startMatch[0].length);
	const body = _extractBraceContent(afterOpen);
	if (!body) return info;

	const configKeys = new Set(_extractTopLevelKeys(body));
	info.hasPresence = configKeys.has('presence');
	info.hasCursors = configKeys.has('cursors');
	info.typing = configKeys.has('typing');
	info.hasLocks = configKeys.has('locks');
	info.reactions = configKeys.has('reactions');
	info.selections = _extractTopLevelStringProp(body, 'selections') || null;

	const mergeVal = _extractTopLevelStringProp(body, 'merge');
	if (mergeVal) info.dataOpts.merge = mergeVal;
	const keyVal = _extractTopLevelStringProp(body, 'key');
	if (keyVal) info.dataOpts.key = keyVal;
	if (info.dataOpts.merge !== 'crud' && keyVal === undefined) delete info.dataOpts.key;

	const actionsBody = _extractTopLevelBraceProp(body, 'actions');
	if (actionsBody) info.actions = _extractTopLevelKeys(actionsBody);

	// A presence field (typing / locks / selections) is stamped on a roster entry,
	// which only exists when presence is set. Catch the missing presence at build
	// time so the dev never ships a field that publishes but never persists for a
	// late joiner. Reactions are exempt: they ride their own ephemeral stream.
	const declaresPresenceField = info.typing || info.hasLocks || !!info.selections;
	if (declaresPresenceField && !info.hasPresence) {
		throw new Error(
			`[svelte-realtime] ${name}: live.multiplayer() declares a presence field (typing / locks / selections) but has no presence function. Presence fields are stamped on a roster entry that only exists when presence is set, so add a presence function. Reactions do not require presence.\n  See: https://svti.me/multiplayer`
		);
	}

	return info;
}

/**
 * Extract content between matching braces { ... } respecting nesting.
 * Input should start at or before the opening brace.
 * @param {string} str
 * @returns {string | null}
 */
export function _extractBraceContent(str) {
	const start = str.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < str.length; i++) {
		const ch = str[i];

		const skip = _skipNonCode(str, i);
		if (skip >= 0) { i = skip; continue; }

		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return str.slice(start + 1, i);
		}
	}
	return null;
}
