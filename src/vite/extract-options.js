// @ts-check
import { _skipNonCode, _readStringLiteral } from './scanner.js';
import { _MULTIPLAYER_NAMESPACE_MEMBERS } from '../shared/multiplayer-members.js';

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
 * Advance from `i` past whitespace and comments.
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function _skipBlank(s, i) {
	while (i < s.length) {
		const ch = s[i];
		if (/\s/.test(ch)) { i++; continue; }
		if (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) { i = _skipNonCode(s, i) + 1; continue; }
		break;
	}
	return i;
}

/**
 * Find where the expression starting at `i` ends: the next comma outside any
 * bracket, string or comment, the bracket that closes the enclosing one, or
 * the end of `s`.
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function _expressionEnd(s, i) {
	let depth = 0;
	for (; i < s.length; i++) {
		const skip = _skipNonCode(s, i);
		if (skip >= 0) { i = skip; continue; }
		const ch = s[i];
		if (ch === '{' || ch === '(' || ch === '[') depth++;
		else if (ch === '}' || ch === ')' || ch === ']') { if (depth === 0) return i; depth--; }
		else if (ch === ',' && depth === 0) return i;
		else if (ch === '<') {
			const g = _typeSyntaxEnd(s, i);
			if (g > 0) i = g;
		}
	}
	return s.length;
}

/**
 * If the `<` at `i` opens TypeScript type arguments, type parameters or an
 * assertion (`Promise<Map<string, Item>>`, `fn<A, B>(`, `<K, V>(k: K) =>`,
 * `<Record<string, Fn>>{`), the index of its matching `>`; otherwise -1, as for
 * a comparison such as `i<10`. Outside their own brackets, which stay balanced,
 * type arguments hold no `:` other than a conditional type's `? :` (and so no
 * `??` or `?.`, which would pass for its `?`), so an object member's `name:`
 * or `'name':` ends the scan. Type arguments after a name are also followed by
 * what can follow a type - `(`, `=>`, a closing bracket, `,`, `;`, `|`, `&`,
 * `?`, `:`, `[`, `{` or the end - which a comparison's right side is not; an
 * `assertion` (a `<` where an expression starts) can be followed by anything.
 * @param {string} s
 * @param {number} i
 * @param {boolean} [assertion]
 * @returns {number}
 */
function _typeArgsEnd(s, i, assertion = false) {
	let angles = 0;
	let nest = 0;
	let conditionals = 0;
	for (let j = i; j < s.length; j++) {
		const skip = _skipNonCode(s, j);
		if (skip >= 0) { j = skip; continue; }
		const c = s[j];
		if (c === '=' && s[j + 1] === '>') { j++; continue; }
		if (c === '(' || c === '[' || c === '{') nest++;
		else if (c === ')' || c === ']' || c === '}') { if (nest === 0) return -1; nest--; }
		else if (nest > 0) continue;
		else if (c === '?') { if (s[j + 1] === '?' || s[j + 1] === '.') return -1; conditionals++; }
		else if (c === ':') { if (conditionals === 0) return -1; conditionals--; }
		else if (c === '<') angles++;
		else if (c === '>' && --angles === 0) {
			if (assertion) return j;
			const k = _skipBlank(s, j + 1);
			if (k >= s.length) return j;
			if (s[k] === '=') return s[k + 1] === '>' ? j : -1;
			return /[(),;\]|&?:[{}]/.test(s[k]) ? j : -1;
		}
	}
	return -1;
}

/** Words after which an expression starts, so a `<` there cannot be a comparison. */
const _EXPRESSION_AFTER_WORDS = new Set(['return', 'await', 'async', 'yield', 'function']);

/**
 * What can the `<` at `i` open? Directly after a name, type arguments
 * (`Map<string, Item>`) or a comparison (`i<10`), which `_typeArgsEnd` tells
 * apart: 'args'. Where an expression starts - after `(`, `[`, `{`, `,`, `:`,
 * `=`, `?`, a prefix `!`, `&`, `|`, `=>`, a keyword such as `async` or
 * `function`, or at the start - only an assertion or type parameters:
 * 'assertion'. After a spaced name (`a < b`) or a postfix `!` it compares: null.
 * @param {string} s
 * @param {number} i
 * @returns {'args' | 'assertion' | null}
 */
function _angleOpens(s, i) {
	if (i > 0 && /[\w$]/.test(s[i - 1])) return 'args';
	let k = i - 1;
	while (k >= 0 && /\s/.test(s[k])) k--;
	if (k < 0) return 'assertion';
	const p = s[k];
	if (p === '>') return s[k - 1] === '=' ? 'assertion' : null;
	if (p === '!') return k > 0 && /[\w$)\]]/.test(s[k - 1]) ? null : 'assertion';
	if ('([{,:=?&|'.includes(p)) return 'assertion';
	if (!/[\w$]/.test(p)) return null;
	let start = k;
	while (start > 0 && /[\w$]/.test(s[start - 1])) start--;
	return _EXPRESSION_AFTER_WORDS.has(s.slice(start, k + 1)) ? 'assertion' : null;
}

/**
 * The index of the `>` that ends the type syntax the `<` at `i` opens, or -1
 * when it opens none.
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function _typeSyntaxEnd(s, i) {
	const opens = _angleOpens(s, i);
	return opens === null ? -1 : _typeArgsEnd(s, i, opens === 'assertion');
}

/**
 * Read a property key at `i`: a quoted string (its raw content), an identifier
 * or a number. `word` is true for an identifier, the only key that can be
 * written as shorthand.
 * @param {string} s
 * @param {number} i
 * @returns {{ name: string, word: boolean, end: number } | null}
 */
function _readKey(s, i) {
	const ch = s[i];
	if (ch === '\'' || ch === '"') {
		for (let j = i + 1; j < s.length; j++) {
			if (s[j] === '\\') { j++; continue; }
			if (s[j] === ch) return { name: s.slice(i + 1, j), word: false, end: j + 1 };
		}
		return null;
	}
	if (ch === undefined || !/[\w$]/.test(ch)) return null;
	let j = i + 1;
	while (j < s.length && /[\w$]/.test(s[j])) j++;
	return { name: s.slice(i, j), word: !/^\d/.test(ch), end: j };
}

/**
 * @typedef {{ kind: 'prop', name: string, value: string | null, method: boolean, shorthand?: boolean }
 *   | { kind: 'spread', expr: string }
 *   | { kind: 'unknown' }} ObjectMember
 */

/**
 * Read one member of an object literal from its source text. `value` is the
 * source text after the colon; a shorthand `name` is `name: name`, so its value
 * is the identifier; a method's value is the method itself (`method: true`).
 * A computed key, or text that is not a member, is `unknown`: it may name any
 * key.
 * @param {string} text
 * @returns {ObjectMember}
 */
function _readMember(text) {
	let i = _skipBlank(text, 0);
	if (text.startsWith('...', i)) return { kind: 'spread', expr: text.slice(i + 3) };
	if (text[i] === '*') i = _skipBlank(text, i + 1);
	let key = _readKey(text, i);
	// `async name()`, `get name()`, `set name(v)` and `async *name()`: the word
	// is a modifier when another key follows it instead of `:`, `(` or the end.
	if (key && key.word && (key.name === 'async' || key.name === 'get' || key.name === 'set')) {
		let j = _skipBlank(text, key.end);
		if (text[j] === '*') j = _skipBlank(text, j + 1);
		const next = _readKey(text, j);
		if (next) key = next;
		else if (text[j] === '[') return { kind: 'unknown' };
	}
	if (!key) return { kind: 'unknown' };
	const j = _skipBlank(text, key.end);
	if (j >= text.length) return key.word ? { kind: 'prop', name: key.name, value: key.name, method: false, shorthand: true } : { kind: 'unknown' };
	if (text[j] === ':') return { kind: 'prop', name: key.name, value: text.slice(j + 1), method: false };
	if (text[j] === '(') return { kind: 'prop', name: key.name, value: null, method: true };
	// A generic method `name<T>(...)`; anything else after a `<` is not a member.
	if (text[j] === '<') {
		const g = _typeArgsEnd(text, j);
		if (g > 0 && text[_skipBlank(text, g + 1)] === '(') return { kind: 'prop', name: key.name, value: null, method: true };
	}
	return { kind: 'unknown' };
}

/**
 * Read the top-level members of an object literal body (the text between its
 * braces) in source order. Nested objects, calls and arrow bodies stay inside
 * the member whose value they are, so they never contribute keys.
 * @param {string} body
 * @returns {ObjectMember[]}
 */
function _readMembers(body) {
	/** @type {ObjectMember[]} */
	const members = [];
	let i = 0;
	while (i < body.length) {
		const end = _expressionEnd(body, i);
		const text = body.slice(i, end);
		if (_skipBlank(text, 0) < text.length) members.push(_readMember(text));
		i = end + 1;
	}
	return members;
}

/**
 * Keep the names that are valid RPC path segments; warn (outside production)
 * about each one that is not, since it gets no client stub.
 * @param {string[]} names
 * @param {string} what - 'Action' or 'Window', for the warning
 * @returns {string[]}
 */
function _pathSafeNames(names, what) {
	return names.filter((n) => {
		if (/^[a-zA-Z0-9_]+$/.test(n)) return true;
		if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
			console.warn(`[svelte-realtime] ${what} name '${n}' contains characters not allowed in RPC paths (only a-z, A-Z, 0-9, _ are valid) - skipped\n  See: https://svti.me/rooms`);
		}
		return false;
	});
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

// - Config objects ------------------------------------------------------------
//
// A room or multiplayer config decides which client members the stub carries,
// so the build reads it the way JavaScript evaluates it: members in source
// order with a later key replacing an earlier one, a shorthand `name` as
// `name: name`, an identifier read through the module-level declaration it
// names, and a spread of such an object contributing its members. A value the
// build cannot see (an import, a call, a parameter) is unknown; a spread it
// cannot follow, or a computed key, may declare any key and leaves the config
// open.

/** Words that look like identifiers but are values, not bindings. */
const _NOT_BINDINGS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);

/** The source text JavaScript treats as false when it is a whole value. */
const _FALSY_VALUES = new Set(['false', 'null', 'undefined', 'void 0', '0', '-0', '0n', 'NaN', '\'\'', '""', '``']);

/** How many identifiers or spreads the build follows before calling a value unknown. */
const _MAX_RESOLVE_DEPTH = 8;

/** A TypeScript `as` / `satisfies` clause, which ends the value it follows. */
const _TYPE_CLAUSE_RE = /\s+(?:as|satisfies)\s/y;

/** The same clause written straight after a closing bracket (`}as Cfg`). */
const _TYPE_CLAUSE_AFTER_RE = /(?:as|satisfies)\s/y;

/**
 * Reduce a value's source text to the expression itself: comments dropped and
 * a trailing TypeScript `as` / `satisfies` clause cut off.
 * @param {string} text
 * @returns {string}
 */
function _bareValue(text) {
	let out = '';
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const skip = _skipNonCode(text, i);
		if (skip >= 0) {
			const comment = text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*');
			out += comment ? ' ' : text.slice(i, skip + 1);
			i = skip;
			continue;
		}
		const ch = text[i];
		if (ch === '{' || ch === '(' || ch === '[') depth++;
		else if (ch === '}' || ch === ')' || ch === ']') {
			if (--depth === 0) {
				_TYPE_CLAUSE_AFTER_RE.lastIndex = i + 1;
				if (_TYPE_CLAUSE_AFTER_RE.test(text)) { out += ch; break; }
			}
		}
		else if (depth === 0 && /\s/.test(ch) && out.trim() !== '') {
			_TYPE_CLAUSE_RE.lastIndex = i;
			if (_TYPE_CLAUSE_RE.test(text)) break;
		}
		out += ch;
	}
	return out.trim();
}

/**
 * From just after a `const` declarator's name, find the `=` that starts its
 * initializer, past a TypeScript type annotation. Returns -1 when there is none.
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function _declaratorEquals(s, i) {
	i = _skipBlank(s, i);
	if (s[i] === '=') return s[i + 1] === '=' || s[i + 1] === '>' ? -1 : i;
	if (s[i] !== ':') return -1;
	let depth = 0;
	for (i++; i < s.length; i++) {
		const skip = _skipNonCode(s, i);
		if (skip >= 0) { i = skip; continue; }
		const ch = s[i];
		if (ch === '=' && s[i + 1] === '>') { i++; continue; }
		if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
		else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--;
		else if (depth === 0 && ch === '=') return i;
		else if (depth === 0 && ch === ';') return -1;
	}
	return -1;
}

/**
 * Find where a declaration's initializer starting at `start` ends: at a `;` or
 * `,` outside brackets (a `,` starts the next declarator), or at a line break
 * after which no operator continues the expression.
 * @param {string} s
 * @param {number} start
 * @returns {{ from: number, end: number }}
 */
function _initializerSpan(s, start) {
	const from = _skipBlank(s, start);
	let depth = 0;
	let i = from;
	/** @param {number} nl */
	const endsAt = (nl) => {
		const k = _skipBlank(s, nl + 1);
		return k >= s.length || /[A-Za-z_$@}]/.test(s[k]);
	};
	for (; i < s.length; i++) {
		const skip = _skipNonCode(s, i);
		if (skip >= 0) {
			// A line comment ends on the line break, which may end the statement.
			if (depth === 0 && s[skip] === '\n' && endsAt(skip)) { i = skip; break; }
			i = skip;
			continue;
		}
		const ch = s[i];
		if (ch === '{' || ch === '(' || ch === '[') depth++;
		else if (ch === '}' || ch === ')' || ch === ']') { if (depth === 0) break; depth--; }
		else if (depth === 0 && (ch === ';' || ch === ',')) break;
		else if (depth === 0 && ch === '\n' && endsAt(i)) break;
		else if (ch === '<') {
			const g = _typeSyntaxEnd(s, i);
			if (g > 0) i = g;
		}
	}
	return { from, end: i };
}

/** The module read last; every export of a module is read against the same source. */
let _bindingsSource = '';
/** Where each module-level const's initializer starts. @type {Map<string, number>} */
let _bindings = new Map();
/** The names the module mutates through a property, `delete` or `Object.assign`. @type {Set<string>} */
let _mutated = new Set();

/**
 * The initializer, as source text, of the module-level `const` declaration of
 * `name`; null when the build cannot know its value where the config reads it:
 * an import, a function, a destructuring, a `let` / `var` (which the module may
 * assign again), or an object the module changes after creating it. A
 * declaration inside a function or block is a different binding and is skipped.
 * @param {string} source
 * @param {string} name
 * @returns {string | null}
 */
function _moduleBinding(source, name) {
	if (source !== _bindingsSource) {
		_bindings = _indexBindings(source);
		_mutated = _mutatedNames(source);
		_bindingsSource = source;
	}
	const at = _bindings.get(name);
	if (at === undefined) return null;
	const span = _initializerSpan(source, at);
	const init = source.slice(span.from, span.end);
	// A write through `name.x` changes an object; a primitive const stays what it
	// is, whatever another scope's `name` gets written.
	if (_mutated.has(name) && !_PRIMITIVE_RE.test(_bareValue(init))) return null;
	return init;
}

/** A primitive literal, which no property write can change. */
const _PRIMITIVE_RE = /^(?:true|false|null|undefined|-?(?:\d[\w.]*|\.\d[\w]*)|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`)$/;

/**
 * The source with every string, template, regex and comment blanked to spaces
 * (line breaks kept), so a pattern run over it only sees code.
 * @param {string} source
 * @returns {string}
 */
function _codeOnly(source) {
	let out = '';
	let from = 0;
	for (let i = 0; i < source.length; i++) {
		const skip = _skipNonCode(source, i);
		if (skip < 0) continue;
		out += source.slice(from, i) + source.slice(i, skip + 1).replace(/[^\n]/g, ' ');
		from = skip + 1;
		i = skip;
	}
	return out + source.slice(from);
}

/** A name written through: `name.key = v`, `name[k] += v`, `name.n++`, `++name.n`, `delete name.key`, `Object.assign(name, ...)`. */
const _MUTATION_RE = new RegExp([
	String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\.\s*[\w$]+|\[[^\]\n]*\])+\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])`,
	String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\.\s*[\w$]+|\[[^\]\n]*\])+\s*(?:\+\+|--)`,
	String.raw`(?:\+\+|--)\s*([A-Za-z_$][\w$]*)\s*[.[]`,
	String.raw`\bdelete\s+([A-Za-z_$][\w$]*)\s*[.[]`,
	String.raw`\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\s*\.\s*(?:set|defineProperty|deleteProperty))\s*\(\s*([A-Za-z_$][\w$]*)(?![\w$])`
].join('|'), 'g');

/**
 * The names whose object the module changes after creating it.
 * @param {string} source
 * @returns {Set<string>}
 */
function _mutatedNames(source) {
	/** @type {Set<string>} */
	const names = new Set();
	const code = _codeOnly(source);
	_MUTATION_RE.lastIndex = 0;
	let m;
	while ((m = _MUTATION_RE.exec(code)) !== null) {
		const name = m[1] || m[2] || m[3] || m[4] || m[5];
		if (name) names.add(name);
	}
	return names;
}

/**
 * Map each module-level `const` declarator to where its initializer starts.
 * @param {string} source
 * @returns {Map<string, number>}
 */
function _indexBindings(source) {
	/** @type {Map<string, number>} */
	const found = new Map();
	let depth = 0;
	for (let i = 0; i < source.length; i++) {
		const skip = _skipNonCode(source, i);
		if (skip >= 0) { i = skip; continue; }
		const ch = source[i];
		if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
		if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }
		if (!/[A-Za-z_$]/.test(ch)) continue;
		let j = i + 1;
		while (j < source.length && /[\w$]/.test(source[j])) j++;
		if (depth === 0 && (i === 0 || !/[\w$.]/.test(source[i - 1]))) {
			if (source.slice(i, j) === 'const') {
				// `const a = 1, b = 2`: each declarator, until one the build cannot read.
				let k = j;
				for (;;) {
					const id = _readKey(source, _skipBlank(source, k));
					if (!id || !id.word) break;
					const eq = _declaratorEquals(source, id.end);
					if (eq < 0) break;
					if (!found.has(id.name)) found.set(id.name, eq + 1);
					const { end } = _initializerSpan(source, eq + 1);
					if (source[end] !== ',') break;
					k = end + 1;
				}
			}
		}
		i = j - 1;
	}
	return found;
}

/**
 * A value's expression, read through module-level declarations while it is a
 * bare identifier. Null when an identifier leads somewhere the build cannot read.
 * @param {string} source
 * @param {string} text
 * @param {number} depth
 * @returns {string | null}
 */
function _resolveValue(source, text, depth) {
	let v = _bareValue(text);
	for (let d = depth; /^[A-Za-z_$][\w$]*$/.test(v) && !_NOT_BINDINGS.has(v); d++) {
		if (d >= _MAX_RESOLVE_DEPTH) return null;
		const decl = _moduleBinding(source, v);
		if (decl === null) return null;
		v = _bareValue(decl);
	}
	return v;
}

/**
 * Strip what wraps an expression without changing the object it gives:
 * parentheses around the whole of it, a leading TypeScript `<Type>`
 * assertion and a leading `await`.
 * @param {string} v
 * @returns {string}
 */
function _unwrap(v) {
	for (;;) {
		if (/^await\s/.test(v)) { v = v.slice(5).trim(); continue; }
		if (v[0] === '(') {
			const end = _expressionEnd(v, 1);
			if (v[end] === ')' && end === v.length - 1) { v = v.slice(1, -1).trim(); continue; }
		} else if (v[0] === '<') {
			const g = _typeArgsEnd(v, 0, true);
			const rest = g > 0 ? v.slice(g + 1).trim() : '';
			if (rest !== '') { v = rest; continue; }
		}
		return v;
	}
}

/** The callee of a call: a name or a dotted path. */
const _CALLEE_RE = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/;

/**
 * If `v` starts with a call - a name or dotted path, optional type arguments,
 * then `(` - its callee and the index just after the `(`.
 * @param {string} v
 * @returns {{ callee: string, open: number } | null}
 */
function _callOpen(v) {
	const m = _CALLEE_RE.exec(v);
	if (!m) return null;
	let k = _skipBlank(v, m[0].length);
	if (v[k] === '<') {
		const g = _typeArgsEnd(v, k);
		if (g < 0) return null;
		k = _skipBlank(v, g + 1);
	}
	return v[k] === '(' ? { callee: m[0].replace(/\s/g, ''), open: k + 1 } : null;
}

/**
 * @typedef {{ body: string, open: boolean, guessed?: boolean, options?: boolean, bound?: boolean }} ObjectRead
 * `open` is set when the object may hold keys the build cannot see; `guessed`
 * when it is only the first object written in an expression (`_objectOf`);
 * `options` when it may not be the config at all but a wrapper's options - a
 * wrapper's argument or a guess; `bound` when it was read through a
 * module-level binding, which a function the module calls may have changed.
 */

/**
 * The object an expression evaluates to, read exactly: an object literal,
 * through parentheses, a TypeScript assertion, `await` and module-level
 * consts; `Object.freeze(obj)`; and `Object.assign(...)`, its arguments merged
 * in order. With `wrappers`, a call written out as `withDefaults(...)` and
 * given a single object (written in the call, a const, or another such call
 * written out) is read as that object and left open, since the wrapper may add
 * or drop keys. A call held in a const is not read as a wrapper: it may as well
 * build a schema or a client as a config. Null for anything else.
 * @param {string} source
 * @param {string} text
 * @param {number} depth
 * @param {boolean} wrappers
 * @returns {ObjectRead | null}
 */
function _exactObject(source, text, depth, wrappers) {
	const resolved = _resolveValue(source, text, depth);
	if (resolved === null || depth >= _MAX_RESOLVE_DEPTH) return null;
	const bound = resolved !== _bareValue(text);
	const read = _exactObjectOf(source, resolved, depth, wrappers && !bound);
	return read !== null && bound ? { ...read, bound } : read;
}

/**
 * `_exactObject` for an expression already read through its bindings.
 * @param {string} source
 * @param {string} resolved
 * @param {number} depth
 * @param {boolean} wrappers
 * @returns {ObjectRead | null}
 */
function _exactObjectOf(source, resolved, depth, wrappers) {
	const v = _unwrap(resolved);
	// `(config)`, `(base as Base)`: what was wrapped may itself need reading.
	if (v !== resolved) return _exactObject(source, v, depth + 1, wrappers);
	if (v[0] === '{') {
		const inner = _extractBraceContent(v);
		return inner !== null && inner.length === v.length - 2 ? { body: inner, open: false } : null;
	}
	const call = _callOpen(v);
	if (!call) return null;
	/** @type {string[]} */
	const args = [];
	let close = call.open;
	for (let i = close; ; i = close + 1) {
		close = _expressionEnd(v, i);
		if (_skipBlank(v, i) < close) args.push(v.slice(i, close));
		if (v[close] !== ',') break;
	}
	if (v[close] !== ')' || close !== v.length - 1) return null;
	if (call.callee === 'Object.assign') {
		/** @type {string[]} */
		const bodies = [];
		let open = false;
		let bound = false;
		let read = 0;
		for (const arg of args) {
			const o = _exactObject(source, arg, depth + 1, false);
			// An argument the build cannot read keeps its place as a member that
			// reads as unknown, so what it may override is known.
			if (o === null) { open = true; bodies.push('[0]: 0'); continue; }
			read++;
			bodies.push(o.body);
			if (o.open) open = true;
			if (o.bound) bound = true;
		}
		return read === 0 ? null : { body: bodies.join(',\n'), open, bound };
	}
	if (args.length !== 1) return null;
	if (call.callee === 'Object.freeze') return _exactObject(source, args[0], depth + 1, wrappers);
	if (!wrappers) return null;
	const o = _exactObject(source, args[0], depth + 1, true);
	return o === null ? null : { ...o, open: true, options: true };
}

/**
 * The object a config, its `actions` or its `windows` is set to. What
 * `_exactObject` cannot read - a call with several arguments, a curried or
 * chained call, a conditional, a function's result - is taken as the first
 * object literal written in the expression and marked `guessed`: only its
 * `name: value` and `name()` members count, so a destructuring pattern names
 * no key.
 * @param {string} source
 * @param {string} text
 * @returns {ObjectRead | null}
 */
function _objectOf(source, text) {
	const exact = _exactObject(source, text, 0, true);
	if (exact !== null) return exact;
	// The guess reads the expression as written: what a name holds is not
	// guessed into, as a const may hold a schema or a client as well as a config.
	const body = _firstWrittenBody(text);
	return body === null ? null : { body, open: true, guessed: true, options: true };
}

/**
 * The body of the first object literal written in `text` (strings and
 * comments skipped), or null.
 * @param {string} text
 * @returns {string | null}
 */
function _firstWrittenBody(text) {
	for (let i = 0; i < text.length; i++) {
		const skip = _skipNonCode(text, i);
		if (skip >= 0) { i = skip; continue; }
		if (text[i] === '{') return _extractBraceContent(text.slice(i));
	}
	return null;
}

/**
 * Does `name` name a function at module level: a function declaration, or a
 * const holding a function?
 * @param {string} source
 * @param {string} name
 * @returns {boolean}
 */
function _namesFunction(source, name) {
	const id = name.replace(/\$/g, '\\$');
	if (new RegExp(`(?:^|[;}\\n])[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*${id}[ \\t]*[(<]`).test(_codeOnly(source))) return true;
	const init = _moduleBinding(source, name);
	if (init === null) return false;
	const v = _bareValue(init);
	return /^(?:async\s+)?function\b/.test(v) || (/^(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/.test(v) && v.includes('=>'));
}

/**
 * @typedef {{ values: Map<string, string | null>, raw: Map<string, string | null>, direct: Set<string>, stable: Set<string>, open: boolean, indirect: boolean, options: boolean, lenient: boolean }} ConfigView
 * `values` maps each key the build can see to its value's expression (null when
 * the value is unknown), `raw` to the value as written; `direct` holds the keys
 * written in the object itself rather than spread into it; `stable` the keys no
 * part the build cannot read comes after, which could override them; `open` is
 * set when part of the object may declare keys the build cannot see;
 * `indirect` when keys came through a module-level binding or a spread, which a
 * function the module calls may have changed; `options` when the object may be
 * a wrapper's options rather than the config, and `lenient` when it is also
 * fully visible and reached through a binding (see `_configArgument`).
 */

/** The spread bodies read for the module read last, so a body spread many times is read once. */
let _spreadSource = '';
/** @type {Map<string, ConfigView>} */
const _spreadViews = new Map();

/**
 * Read an object body into a config view. A `guessed` body (see `_objectOf`)
 * gives only its `name: value` and `name()` members, with the values as
 * written; a spread or shorthand in it leaves the view open, and with
 * `functionShorthand` a shorthand naming a const function counts as a key.
 * @param {string} source - the whole module, for resolving identifiers
 * @param {string} body
 * @param {number} depth
 * @param {{ withValues?: boolean, guessed?: boolean, functionShorthand?: boolean }} [opts] - `withValues: false` reads the keys only (values stay null)
 * @returns {ConfigView}
 */
function _readConfig(source, body, depth, opts = {}) {
	const { withValues = true, guessed = false, functionShorthand = false } = opts;
	/** @type {ConfigView} */
	const view = { values: new Map(), raw: new Map(), direct: new Set(), stable: new Set(), open: false, indirect: false, options: false, lenient: false };
	const opaque = () => { view.open = true; view.stable.clear(); };
	if (depth > _MAX_RESOLVE_DEPTH) { opaque(); return view; }
	for (const m of _readMembers(body)) {
		if (guessed && m.kind === 'prop' && m.shorthand) {
			// A shorthand in a guess may be a destructured parameter: it names no
			// key, and can only override its own.
			view.open = true;
			view.stable.delete(m.name);
			if (functionShorthand && _namesFunction(source, m.name)) view.values.set(m.name, null);
			continue;
		}
		if (m.kind === 'unknown' || (guessed && m.kind === 'spread')) { opaque(); continue; }
		if (m.kind === 'spread') {
			view.indirect = true;
			const inner = _exactObject(source, m.expr, depth + 1, false);
			if (inner === null) { opaque(); continue; }
			if (_spreadSource !== source) { _spreadViews.clear(); _spreadSource = source; }
			const cacheKey = withValues + '\0' + inner.body;
			let spread = _spreadViews.get(cacheKey);
			if (spread === undefined) {
				spread = _readConfig(source, inner.body, depth + 1, { withValues });
				_spreadViews.set(cacheKey, spread);
			}
			if (spread.open) opaque();
			for (const [k, v] of spread.values) {
				view.values.set(k, v);
				view.raw.set(k, spread.raw.get(k) ?? null);
				view.direct.delete(k);
			}
			for (const k of spread.stable) view.stable.add(k);
			continue;
		}
		// A method is a function, which no flag treats as off.
		const text = /** @type {string} */ (m.value);
		view.raw.set(m.name, m.method ? null : text);
		view.direct.add(m.name);
		view.stable.add(m.name);
		if (!withValues || m.method) view.values.set(m.name, null);
		else view.values.set(m.name, guessed ? _bareValue(text) : _resolveValue(source, text, depth + 1));
	}
	return view;
}

/**
 * Read the config a `live.room(` / `live.multiplayer(` call is given: its
 * first argument, read by `_objectOf`. A config the build cannot see at all is
 * an empty, open view. A wrapper's argument or a guess that declares no
 * `topic` the build can see may be the wrapper's options rather than the
 * config: `options`, so only an `actions` written in it counts, and nothing it
 * names is followed. When such an object is also fully visible and reached
 * through a binding rather than written in the call, it is `lenient`: a
 * template value in it is unknown rather than a build error.
 * @param {string} source
 * @param {string} afterOpen - the source from just after the call's `(`
 * @returns {ConfigView}
 */
function _configArgument(source, afterOpen) {
	const i = _skipBlank(afterOpen, 0);
	const config = _objectOf(source, afterOpen.slice(i, _expressionEnd(afterOpen, i)));
	if (config === null) return { values: new Map(), raw: new Map(), direct: new Set(), stable: new Set(), open: true, indirect: false, options: false, lenient: false };
	const view = _readConfig(source, config.body, 0, { guessed: config.guessed });
	view.options = !!config.options && !view.values.has('topic');
	view.lenient = view.options && !view.open && !!config.bound;
	if (config.open) view.open = true;
	if (config.bound) view.indirect = true;
	return view;
}

/**
 * Is a config flag switched on? A key the view does not hold is off, and so is
 * one whose value is false in JavaScript (`cursors: false` spells out the
 * default, not the feature). Any other value - `true`, an object, an array, a
 * function, or a value the build cannot see - counts as on.
 * @param {ConfigView} view
 * @param {string} name
 * @returns {boolean}
 */
function _flagOn(view, name) {
	if (!view.values.has(name)) return false;
	const v = view.values.get(name);
	return v == null || !_FALSY_VALUES.has(v);
}

/**
 * Is a config flag set to a literal JavaScript treats as true (`true`, a
 * non-empty string, a non-zero number, an array or object literal)? Unlike
 * `_flagOn`, a value the build cannot evaluate does not count.
 * @param {ConfigView} view
 * @param {string} name
 * @returns {boolean}
 */
function _flagLiterallyOn(view, name) {
	const v = view.values.get(name);
	if (v == null || _FALSY_VALUES.has(v)) return false;
	return v === 'true' || v[0] === '[' || v[0] === '{' || /^(['"`]).+\1$/s.test(v) || /^-?(?:\d|\.\d)[\w.]*$/.test(v);
}

/**
 * The string a config key is set to, when its value is a plain string literal.
 * A template literal with `${...}` cannot be read and fails the build, as it
 * does when written in the call - unless the view is `lenient`, a wrapper's
 * possible options reached through a binding (see `_configArgument`).
 * @param {ConfigView} view
 * @param {string} name
 * @returns {string | null}
 */
function _stringValue(view, name) {
	const v = view.values.get(name);
	if (!v || (v[0] !== '\'' && v[0] !== '"' && v[0] !== '`')) return null;
	if (v[0] === '`' && v.includes('${') && view.lenient) return null;
	const lit = _readStringLiteral(v, 0);
	return lit && lit.end === v.length - 1 ? lit.value : null;
}

/**
 * The keys of the object a config key is set to (`actions`, `windows`), as far
 * as the build can see them. An object it holds exactly - a literal, a const,
 * `Object.freeze` / `Object.assign` - gives all its keys. Anything else, a call
 * among them, is read from the first object written in it: its `name:` and
 * `name()` members, and a shorthand naming a function in the module
 * (`withAudit({ save })`) - a call's argument may as well be its dependencies
 * (`crudActions({ db, table })`). In what may be a wrapper's
 * options (`view.options`), only a value written in the object itself counts,
 * and only that way: nothing it names is followed.
 * @param {string} source
 * @param {ConfigView} view
 * @param {string} name
 * @returns {string[]}
 */
function _objectKeys(source, view, name) {
	const v = view.raw.get(name);
	if (!v || (view.options && !view.direct.has(name))) return [];
	const exact = view.options ? null : _exactObject(source, v, 0, false);
	if (exact !== null) return [...(_readConfig(source, exact.body, 0, { withValues: false }).values.keys())];
	const body = _firstWrittenBody(v);
	return body === null ? [] : [...(_readConfig(source, body, 0, { withValues: false, guessed: true, functionShorthand: true }).values.keys())];
}

/**
 * Detect a windowed `live.aggregate(...)` export and return the window
 * names declared in its `windows: { ... }` option, or `null` if the
 * export has no windows (single-state form). The plugin treats the
 * presence/absence of windows as the discriminator between
 * "single-stream stub" and "namespace stub" client surfaces.
 *
 * The plugin parser only ever needs to know which windows exist, not their
 * type or duration. Window-spec validation (`type`, `durationMs`, `combine`
 * requirement, etc.) lives at module load time on the server side, where
 * the actual reducers and option objects are fully evaluated.
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
	const view = _readConfig(source, optionsBody, 0);
	const keys = _pathSafeNames(_objectKeys(source, view, 'windows'), 'Window').filter(k => /^[A-Za-z_$][\w$]*$/.test(k));
	return keys.length > 0 ? keys : null;
}

/**
 * Extract room configuration info from source code for client stub generation.
 * @param {string} source
 * @param {string} name
 * @returns {{ dataOpts: any, hasPresence: boolean, hasCursors: boolean, actions: string[], isEnumerable: boolean, hasOwner: boolean }}
 */
export function _extractRoomInfo(source, name) {
	/** @type {{ dataOpts: any, hasPresence: boolean, hasCursors: boolean, actions: string[], isEnumerable: boolean, hasOwner: boolean }} */
	const info = { dataOpts: { merge: 'crud' }, hasPresence: false, hasCursors: false, actions: [], isEnumerable: false, hasOwner: false };

	// Find the start of live.room({ ... }) call
	const startPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.room\\s*\\(`
	);
	const startMatch = startPattern.exec(source);
	if (!startMatch) return info;

	const view = _configArgument(source, source.slice(startMatch.index + startMatch[0].length));
	info.hasPresence = _flagOn(view, 'presence');
	info.hasCursors = _flagOn(view, 'cursors');
	// Room enumeration is opt-in via `enumerable: true` or a `meta` function.
	info.isEnumerable = _flagOn(view, 'enumerable') || _flagOn(view, 'meta');
	// Room ownership is opt-in via `owner: true`.
	info.hasOwner = _flagOn(view, 'owner');

	const mergeVal = _stringValue(view, 'merge');
	if (mergeVal) info.dataOpts.merge = mergeVal;

	const keyVal = _stringValue(view, 'key');
	if (keyVal) info.dataOpts.key = keyVal;
	if (info.dataOpts.merge === 'crud' && info.dataOpts.key === undefined) info.dataOpts.key = 'id';

	info.actions = _pathSafeNames(_objectKeys(source, view, 'actions'), 'Action');

	return info;
}

/**
 * Extract multiplayer config for client-stub generation. The config is
 * room-shaped (topic / init / presence / cursors / actions / merge / key), so
 * the room extractor supplies the data options and the presence / cursor /
 * action discriminators; the field-surface keys are read separately so a
 * future client surface can be told which surfaces were declared.
 *
 * `joins` says whether room() holds the data stream, which is what makes the
 * caller a member: membership matters in a room with presence or an owner, and
 * a config the build cannot fully see may declare either.
 * @param {string} source
 * @param {string} name
 * @returns {{ dataOpts: any, hasPresence: boolean, hasCursors: boolean, actions: string[], typing: boolean, hasLocks: boolean, reactions: boolean, selections: string | null, hasOwner: boolean, joins: boolean }}
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
		actions: /** @type {string[]} */ ([]),
		typing: false,
		hasLocks: false,
		reactions: false,
		selections: /** @type {string | null} */ (null),
		hasOwner: false,
		joins: false
	};
	if (!startMatch) return info;

	const view = _configArgument(source, source.slice(startMatch.index + startMatch[0].length));
	info.hasPresence = _flagOn(view, 'presence');
	info.hasCursors = _flagOn(view, 'cursors');
	info.typing = _flagOn(view, 'typing');
	info.hasLocks = _flagOn(view, 'locks');
	info.reactions = _flagOn(view, 'reactions');
	info.selections = _stringValue(view, 'selections') || null;
	info.hasOwner = _flagOn(view, 'owner');

	const mergeVal = _stringValue(view, 'merge');
	if (mergeVal) info.dataOpts.merge = mergeVal;
	const keyVal = _stringValue(view, 'key');
	if (keyVal) info.dataOpts.key = keyVal;

	// The server refuses an action named like a namespace member, so a name in
	// that set can only be a misreading; emitting it would replace the member.
	info.actions = _pathSafeNames(_objectKeys(source, view, 'actions'), 'Action').filter((a) => !_MULTIPLAYER_NAMESPACE_MEMBERS.has(a));

	// A presence field (typing / locks / selections) is stamped on a roster entry,
	// which only exists when presence is set, and the server refuses a field that
	// is on without a presence function when the module loads. Catch it at build
	// time when the field is set to a literal that is on in a config written out
	// in the call. Where the presence function may come from what the build
	// cannot see - an open config, or keys read through a binding or a spread a
	// function the module calls may have changed - such a field tells the build
	// presence is there, since a config that runs has it; the server's check at
	// load stands behind it. A field whose value the build cannot evaluate is
	// left to the server.
	// A field a later part the build cannot read may override is not counted.
	const fieldOn = ['typing', 'locks', 'selections'].some((k) => view.stable.has(k) && _flagLiterallyOn(view, k));
	if (fieldOn && !info.hasPresence && (view.open || view.indirect)) info.hasPresence = true;
	info.joins = info.hasPresence || info.hasOwner || view.open;
	if (fieldOn && !info.hasPresence) {
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
