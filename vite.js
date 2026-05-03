// @ts-check
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
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
const DYNAMIC_DERIVED_RE = /export\s+const\s+(\w+)\s*=\s*live\.derived\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
const ROOM_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.room\s*\(/g;
const WEBHOOK_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.webhook\s*\(/g;
const CHANNEL_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.channel\s*\(/g;
const DYNAMIC_CHANNEL_RE = /export\s+const\s+(\w+)\s*=\s*live\.channel\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
const RATE_LIMIT_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.rateLimit\s*\(/g;
const EFFECT_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.effect\s*\(/g;
const AGGREGATE_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.aggregate\s*\(/g;

const _validSegmentReVite = /^[a-zA-Z0-9_]+$/;

/** @type {Set<string>} Track already-warned export names to avoid duplicate warnings */
const _warnedExports = new Set();

/**
 * Check if an export name is a valid RPC path segment. Warn once per name if not.
 * @param {string} name
 * @param {string} filePath
 * @returns {boolean}
 */
function _isValidExportName(name, filePath) {
	if (_validSegmentReVite.test(name)) return true;
	const warnKey = filePath + ':' + name;
	if (!_warnedExports.has(warnKey)) {
		_warnedExports.add(warnKey);
		console.warn(
			`[svelte-realtime] ${filePath}: export '${name}' contains characters not allowed in RPC paths (only a-z, A-Z, 0-9, _ are valid) -- skipped\n  See: https://svti.me/rpc`
		);
	}
	return false;
}

/**
 * Scan source for live exports with names that aren't valid path segments and warn about them.
 * @param {string} source
 * @param {string} filePath
 * @param {Set<string>} [alreadyHandled]
 */
function _warnUnsafeExports(source, filePath, alreadyHandled) {
	const re = /export\s+const\s+([\w$]+)\s*=\s*live[\s.(]/g;
	let m;
	while ((m = re.exec(source)) !== null) {
		const n = m[1];
		if (alreadyHandled && alreadyHandled.has(n)) continue;
		_isValidExportName(n, filePath);
	}
}

/**
 * Read a string literal (', ", or `) starting at position `start` in `s`.
 * The character at `start` must be the opening quote.
 * Returns the decoded content between the quotes with standard JS escape
 * sequences resolved (\n, \t, \r, \b, \f, \v, \0, \\, \', \", \`,
 * \xNN, \uXXXX, \u{XXXXX}, and line continuations).
 * For backtick strings with `${...}` interpolation, returns null and emits
 * a build warning so the user knows why defaults were used.
 * @param {string} s
 * @param {number} start
 * @returns {{ value: string, end: number } | null}
 */
function _readStringLiteral(s, start) {
	const q = s[start];
	if (q !== '\'' && q !== '"' && q !== '`') return null;
	let result = '';
	for (let j = start + 1; j < s.length; j++) {
		const ch = s[j];
		if (ch === '\\') {
			const next = s[j + 1];
			if (next === undefined) break; // trailing backslash
			// Line continuation: backslash followed by newline (skip both)
			if (next === '\n') { j++; continue; }
			if (next === '\r') { j++; if (s[j + 1] === '\n') j++; continue; }
			// Single-character escapes
			if (next === '\\') { result += '\\'; j++; }
			else if (next === '\'') { result += '\''; j++; }
			else if (next === '"') { result += '"'; j++; }
			else if (next === '`') { result += '`'; j++; }
			else if (next === 'n') { result += '\n'; j++; }
			else if (next === 't') { result += '\t'; j++; }
			else if (next === 'r') { result += '\r'; j++; }
			else if (next === 'b') { result += '\b'; j++; }
			else if (next === 'f') { result += '\f'; j++; }
			else if (next === 'v') { result += '\v'; j++; }
			else if (next === '0' && !/[0-9]/.test(s[j + 2] || '')) { result += '\0'; j++; }
			// \xNN -- two hex digits
			else if (next === 'x') {
				const hex = s.slice(j + 2, j + 4);
				if (/^[0-9a-fA-F]{2}$/.test(hex)) {
					result += String.fromCharCode(parseInt(hex, 16));
					j += 3;
				} else { result += next; j++; }
			}
			// \uXXXX -- four hex digits
			else if (next === 'u' && s[j + 2] !== '{') {
				const hex = s.slice(j + 2, j + 6);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					result += String.fromCharCode(parseInt(hex, 16));
					j += 5;
				} else { result += next; j++; }
			}
			// \u{XXXXX} -- unicode code point
			else if (next === 'u' && s[j + 2] === '{') {
				const close = s.indexOf('}', j + 3);
				if (close > j + 2) {
					const hex = s.slice(j + 3, close);
					if (/^[0-9a-fA-F]+$/.test(hex)) {
						result += String.fromCodePoint(parseInt(hex, 16));
						j = close;
					} else { result += next; j++; }
				} else { result += next; j++; }
			}
			else { result += next; j++; }
			continue;
		}
		if (ch === q) return { value: result, end: j };
		// For backtick strings, interpolation cannot be statically analyzed --
		// throw a build error so codegen never silently emits wrong defaults.
		if (q === '`' && ch === '$' && s[j + 1] === '{') {
			const snippet = s.slice(start, Math.min(start + 40, s.length)).replace(/\n/g, '\\n');
			throw new Error(
				`[svelte-realtime] Template literal with interpolation cannot be statically analyzed: ${snippet}... -- use a plain string ('...' or "...") instead\n  See: https://svti.me/vite`
			);
		}
		result += ch;
	}
	return null; // unterminated
}

/**
 * Shared syntax skipper for all JS/TS source scanners.
 * From position `i` in `s`, if the current character starts a string (including
 * template literals with `${...}` interpolation), regex literal, or comment,
 * returns the index of the last character consumed so the caller can resume at
 * `i + 1`. Returns -1 if the character at `i` is not a skippable construct.
 *
 * Template literals are handled with brace-depth tracking so `${expr}` inside
 * the template does not end the skip prematurely.
 *
 * @param {string} s
 * @param {number} i
 * @returns {number} New index (last char consumed), or -1 if nothing was skipped
 */
function _skipNonCode(s, i) {
	const ch = s[i];

	// Single / double quoted strings
	if (ch === '\'' || ch === '"') {
		for (let j = i + 1; j < s.length; j++) {
			if (s[j] === '\\') { j++; continue; }
			if (s[j] === ch) return j;
		}
		return s.length - 1;
	}

	// Template literals -- track ${...} interpolation depth
	if (ch === '`') {
		let tmplDepth = 0;
		for (let j = i + 1; j < s.length; j++) {
			if (s[j] === '\\') { j++; continue; }
			if (s[j] === '`' && tmplDepth === 0) return j;
			if (s[j] === '$' && s[j + 1] === '{') { tmplDepth++; j++; continue; }
			if (s[j] === '}' && tmplDepth > 0) { tmplDepth--; continue; }
		}
		return s.length - 1;
	}

	// Line comments
	if (ch === '/' && s[i + 1] === '/') {
		const nl = s.indexOf('\n', i + 2);
		return nl === -1 ? s.length - 1 : nl;
	}

	// Block comments
	if (ch === '/' && s[i + 1] === '*') {
		const end = s.indexOf('*/', i + 2);
		return end === -1 ? s.length - 1 : end + 1;
	}

	// Regex literals: / not preceded by an identifier char, ) or ]
	if (ch === '/' && s[i + 1] !== '/' && s[i + 1] !== '*') {
		const prev = i > 0 ? s[i - 1] : '\n';
		if (prev !== ')' && prev !== ']' && !/\w/.test(prev)) {
			for (let j = i + 1; j < s.length; j++) {
				if (s[j] === '\\') { j++; continue; }
				if (s[j] === '/') return j;
				if (s[j] === '\n') break; // malformed -- give up
			}
		}
	}

	return -1;
}

/** @type {Map<string, string>} Cache file contents to avoid redundant reads within a build cycle */
const _fileCache = new Map();

/** @type {Map<string, { content: string, code: string }>} Cache generated stubs keyed by file path, validated against source content */
const _codeCache = new Map();

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
 * Find the index of the closing `}` matching the `{` at `openIdx`. Tracks
 * string literals (skipping their contents) and line/block comments.
 * Returns -1 if no match. Used by the topics registry parser.
 * @param {string} s
 * @param {number} openIdx
 * @returns {number}
 */
/**
 * Given `s[i]` is a string-opening quote (', ", or `), return the index
 * of the matching closing quote/backtick. Tracks `${...}` interpolation
 * depth inside template literals so embedded braces don't terminate the
 * surrounding scope. Used by every lookahead that scans top-level
 * structure of a defineTopics call.
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function _skipStringContent(s, i) {
	const q = s[i];
	if (q === '\'' || q === '"') {
		let j = i + 1;
		while (j < s.length && s[j] !== q) {
			if (s[j] === '\\') j++;
			j++;
		}
		return j;
	}
	if (q === '`') {
		let j = i + 1;
		while (j < s.length && s[j] !== '`') {
			if (s[j] === '\\') { j += 2; continue; }
			if (s[j] === '$' && s[j + 1] === '{') {
				let d = 1;
				j += 2;
				while (j < s.length && d > 0) {
					if (s[j] === '{') d++;
					else if (s[j] === '}') { d--; if (d === 0) break; }
					j++;
				}
			}
			j++;
		}
		return j;
	}
	return i;
}

function _findMatchingBrace(s, openIdx) {
	let depth = 1;
	let i = openIdx + 1;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '/' && s[i + 1] === '/') {
			while (i < s.length && s[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && s[i + 1] === '*') {
			i += 2;
			while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') {
			i = _skipStringContent(s, i) + 1;
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}') { depth--; if (depth === 0) return i; }
		i++;
	}
	return -1;
}

/**
 * Parse a template literal starting at `start` (the backtick), substituting
 * `${expr}` interpolations with `{argN}` (where N is the index of `expr` in
 * `params`) or `{argX}` if the expression isn't a simple parameter reference.
 * Returns { pattern, end } where `end` is the index of the closing backtick.
 * Returns null on unterminated input.
 * @param {string} s
 * @param {number} start
 * @param {string[]} params
 * @returns {{ pattern: string, end: number } | null}
 */
function _extractTemplatePattern(s, start, params) {
	if (s[start] === '\'' || s[start] === '"') {
		const lit = _readStringLiteral(s, start);
		return lit ? { pattern: lit.value, end: lit.end } : null;
	}
	if (s[start] !== '`') return null;
	let result = '';
	let i = start + 1;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '`') return { pattern: result, end: i };
		if (ch === '\\') {
			const next = s[i + 1];
			if (next === 'n') result += '\n';
			else if (next === 't') result += '\t';
			else if (next === '\\') result += '\\';
			else if (next === '`') result += '`';
			else if (next === '$') result += '$';
			else if (next !== undefined) result += next;
			i += 2;
			continue;
		}
		if (ch === '$' && s[i + 1] === '{') {
			let depth = 1;
			let j = i + 2;
			while (j < s.length && depth > 0) {
				if (s[j] === '{') depth++;
				else if (s[j] === '}') { depth--; if (depth === 0) break; }
				j++;
			}
			if (depth !== 0) return null;
			const expr = s.slice(i + 2, j).trim();
			const idx = params.indexOf(expr);
			result += idx >= 0 ? '{arg' + idx + '}' : '{argX}';
			i = j + 1;
			continue;
		}
		result += ch;
		i++;
	}
	return null;
}

/**
 * Parse an arrow function value of a defineTopics entry, returning the
 * static template pattern of its return expression. Handles concise-body
 * arrows and single-return block bodies, with simple-string and template
 * literal returns. Returns null for shapes outside that envelope (the
 * registry just skips them; warnings only fire for confidently parsed
 * entries).
 * @param {string} body
 * @param {number} start
 * @returns {{ pattern: string, end: number } | null}
 */
function _parseArrowReturnTemplate(body, start) {
	let i = start;
	if (body.slice(i, i + 6) === 'async ') i += 6;
	while (i < body.length && /\s/.test(body[i])) i++;
	const params = [];
	if (body[i] === '(') {
		let depth = 1;
		const pStart = i + 1;
		let j = i + 1;
		while (j < body.length && depth > 0) {
			if (body[j] === '(') depth++;
			else if (body[j] === ')') { depth--; if (depth === 0) break; }
			j++;
		}
		if (depth !== 0) return null;
		const paramStr = body.slice(pStart, j).trim();
		if (paramStr) {
			for (const p of paramStr.split(',').map(s => s.trim())) {
				const m = p.match(/^([\w$]+)/);
				if (m) params.push(m[1]);
			}
		}
		i = j + 1;
	} else if (/[\w$]/.test(body[i])) {
		const pStart = i;
		while (i < body.length && /[\w$]/.test(body[i])) i++;
		params.push(body.slice(pStart, i));
	} else {
		return null;
	}
	while (i < body.length && /\s/.test(body[i])) i++;
	if (body.slice(i, i + 2) !== '=>') return null;
	i += 2;
	while (i < body.length && /\s/.test(body[i])) i++;
	let hasOuterParen = false;
	if (body[i] === '(') {
		hasOuterParen = true;
		i++;
		while (i < body.length && /\s/.test(body[i])) i++;
	}
	if (body[i] === '{') {
		const blockEnd = _findMatchingBrace(body, i);
		if (blockEnd < 0) return null;
		const blockBody = body.slice(i + 1, blockEnd);
		const retIdx = blockBody.search(/(?:^|\s)return\s+/);
		if (retIdx < 0) return null;
		const afterReturn = blockBody.indexOf('return', retIdx) + 6;
		let rs = afterReturn;
		while (rs < blockBody.length && /\s/.test(blockBody[rs])) rs++;
		if (blockBody[rs] !== '\'' && blockBody[rs] !== '"' && blockBody[rs] !== '`') return null;
		const lit = _extractTemplatePattern(blockBody, rs, params);
		if (!lit) return null;
		return { pattern: lit.pattern, end: blockEnd };
	}
	if (body[i] !== '\'' && body[i] !== '"' && body[i] !== '`') return null;
	const lit = _extractTemplatePattern(body, i, params);
	if (!lit) return null;
	let endIdx = lit.end;
	if (hasOuterParen) {
		let k = endIdx + 1;
		while (k < body.length && /\s/.test(body[k])) k++;
		if (body[k] === ')') endIdx = k;
	}
	return { pattern: lit.pattern, end: endIdx };
}

/**
 * Parse the body of a defineTopics({...}) call, returning an array of
 * `{ name, pattern }` entries for every entry that resolves to a static
 * pattern. Entries whose values are dynamic (function references,
 * spreads, etc.) are silently skipped.
 * @param {string} body
 * @returns {Array<{ name: string, pattern: string }>}
 */
function _parseTopicsEntries(body) {
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
function _extractDefineTopicsPatterns(source) {
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
function _findTopicsFiles(srcDir, liveDir) {
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
 * null when no `defineTopics` call exists anywhere -- callers use that
 * as the signal to skip the unregistered-topic warning entirely.
 * @param {string} srcDir
 * @param {string} liveDir
 * @returns {{ patterns: Array<{ name: string, pattern: string, regex: RegExp }> } | null}
 */
function _buildTopicsRegistry(srcDir, liveDir) {
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
function _topicIsRegistered(topic, registry) {
	if (!registry) return true;
	for (const p of registry.patterns) if (p.regex.test(topic)) return true;
	return false;
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
					this.error(`[svelte-realtime] Could not resolve $live/${modulePath} -- file not found in ${dir}/`);
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

				// Pre-warm virtual modules to eliminate cold-start waterfall
				try {
					const files = _findLiveFiles(liveDir);
					for (const file of files) {
						const rel = relative(liveDir, file).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
						server.warmupRequest(VIRTUAL_PREFIX + rel).catch(() => {});
					}
				} catch {}
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

	// Detect dynamic (function-returning) streams, channels, and derived
	for (const re of [DYNAMIC_STREAM_RE, DYNAMIC_CHANNEL_RE, DYNAMIC_DERIVED_RE]) {
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

	// Escape paths for safe embedding in generated code
	const safePath = JSON.stringify(normalized);
	const safeModulePath = (name) => JSON.stringify(modulePath + '/' + name);

	// If no store-like exports, simple re-export
	if (storeNames.length === 0) {
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

	// Detect live.stream() exports -- check for dynamic vs static topic
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
			lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify(streamOptions)}, true);`);
		} else {
			lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify(streamOptions)});`);
		}
	}

	// Detect live.channel() exports -- treated as streams on the client
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
			const isDynamic = _isDynamicExport(source, name, 'live\\.derived');
			if (isDynamic) {
				lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify({ merge: 'set', key: 'id' })}, true);`);
			} else {
				lines.push(`export const ${name} = __stream('${modulePath}/${name}', ${JSON.stringify({ merge: 'set', key: 'id' })});`);
			}
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
				`[svelte-realtime] ${dir}/${modulePath} exports '${name}' starting with _ -- reserved for internal use\n  See: https://svti.me/rpc`
			);
			continue;
		}
		console.warn(
			`[svelte-realtime] ${dir}/${modulePath} exports '${name}' which is not wrapped in live() -- it won't be callable from the client. Did you forget live()?\n  See: https://svti.me/rpc`
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
				`[svelte-realtime] ${dir}/${modulePath} has no live() or live.stream() exports`
			);
		}
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
function _extractLastOptions(s) {
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
			// Top-level ) -- this closes the live.stream() call
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
function _extractTopLevelBraceProp(body, keyName) {
	let depth = 0;
	const ID_CHAR = /[\w$]/;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];

		const skip = _skipNonCode(body, i);
		if (skip >= 0) {
			// At depth 0, a skipped quote might be a quoted key -- check before skipping
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
function _extractTopLevelKeys(body) {
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
						console.warn(`[svelte-realtime] Action name '${keyName}' contains characters not allowed in RPC paths -- skipped\n  See: https://svti.me/rooms`);
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
					console.warn(`[svelte-realtime] Action name '${m[1]}' contains characters not allowed in RPC paths (only a-z, A-Z, 0-9, _ are valid) -- skipped\n  See: https://svti.me/rooms`);
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
function _extractTopLevelStringProp(body, keyName) {
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
function _extractTopLevelRawValue(body, keyName) {
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
function _readTopLevelValue(body, start) {
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
function _extractStreamOptions(source, name) {
	/** @type {any} */
	const opts = { merge: 'crud', key: 'id' };

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

	return opts;
}

/**
 * Parse option properties from an object body string into an opts object.
 * Shared by stream, channel, and room option extraction.
 * Uses _extractTopLevelStringProp for robust quoted-key and non-word value support.
 * @param {Record<string, any>} opts
 * @param {string} optStr
 */
function _applyParsedOptions(opts, optStr) {
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
function _extractChannelOptions(source, name) {
	/** @type {any} */
	const opts = { merge: 'set', key: 'id' };

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

	// Extract action names from the top-level actions property
	const actionsBody = _extractTopLevelBraceProp(body, 'actions');
	if (actionsBody) {
		info.actions = _extractTopLevelKeys(actionsBody);
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

/**
 * Generate the registry module that imports all live functions.
 * @param {string} liveDir
 * @param {string} dir
 * @returns {string}
 */
function _generateRegistry(liveDir, dir, topicsRegistry) {
	if (!existsSync(liveDir)) return '// No live modules found\n';

	const files = _findLiveFiles(liveDir);
	const lines = [
		`import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate, __registerRoomActions } from 'svelte-realtime/server';`,
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
		LIVE_EXPORT_RE.lastIndex = 0;
		while ((match = LIVE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			registered.add(name);
			lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);
		}

		// Register live.validated() exports
		VALIDATED_EXPORT_RE.lastIndex = 0;
		while ((match = VALIDATED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);
			}
		}

		// Register live.rateLimit() exports
		RATE_LIMIT_EXPORT_RE.lastIndex = 0;
		while ((match = RATE_LIMIT_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);
			}
		}

		// Register live.stream() exports
		STREAM_EXPORT_RE.lastIndex = 0;
		while ((match = STREAM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);

			// Check for duplicate stream topics
			const topicPattern = new RegExp(
				`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`
			);
			const topicMatch = topicPattern.exec(source);
			if (topicMatch) {
				const topic = topicMatch[1];
				if (topic.startsWith('__')) {
					throw new Error(
						`[svelte-realtime] ${dir}/${rel} uses reserved topic '${topic}' -- topics starting with __ are reserved for internal use\n  See: https://svti.me/streams`
					);
				}
				if (seenTopics.has(topic)) {
					throw new Error(
						`[svelte-realtime] Duplicate stream topic '${topic}' in ${dir}/${rel} -- each topic must be unique across all modules\n  See: https://svti.me/streams`
					);
				}
				seenTopics.add(topic);
				_maybeWarnUnregistered(topic, rel, 'live.stream');
			}
		}

		// Register guard
		GUARD_EXPORT_RE.lastIndex = 0;
		if (GUARD_EXPORT_RE.exec(source) !== null) {
			lines.push(`__registerGuard('${rel}', ${_lazy('_guard')});`);
		}

		// Register live.binary() exports
		BINARY_EXPORT_RE.lastIndex = 0;
		while ((match = BINARY_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);
			}
		}

		// Register cron jobs
		CRON_EXPORT_RE.lastIndex = 0;
		while ((match = CRON_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			lines.push(`__registerCron('${rel}/${name}', ${_lazy(name)});`);
		}

		// Register live.derived() exports
		DERIVED_EXPORT_RE.lastIndex = 0;
		while ((match = DERIVED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);
				lines.push(`__registerDerived('${rel}/${name}', ${_lazy(name)});`);
			}
		}

		// Register live.room() exports -- register sub-streams and actions lazily
		ROOM_EXPORT_RE.lastIndex = 0;
		while ((match = ROOM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				const importPath = JSON.stringify(normalizedPath);
				// Register the data stream -- inherit file-level guard via explicit module path
				lines.push(`__register('${rel}/${name}/__data', __L(() => import(${importPath}).then(m => m.${name}.__dataStream)), '${rel}');`);
				// Register presence stream if present
				lines.push(`__register('${rel}/${name}/__presence', __L(() => import(${importPath}).then(m => m.${name}.__presenceStream)), '${rel}');`);
				// Register cursor stream if present
				lines.push(`__register('${rel}/${name}/__cursors', __L(() => import(${importPath}).then(m => m.${name}.__cursorStream)), '${rel}');`);
				// Register actions (deferred -- resolved on first RPC or cron tick)
				lines.push(`__registerRoomActions('${rel}/${name}', ${_lazy(name)});`);
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
				lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);
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
				lines.push(`__registerEffect('${rel}/${name}', ${_lazy(name)});`);
			}
		}

		// Register live.aggregate() exports
		AGGREGATE_EXPORT_RE.lastIndex = 0;
		while ((match = AGGREGATE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			if (!/^\w+$/.test(name)) continue;
			if (!registered.has(name)) {
				registered.add(name);
				lines.push(`__register('${rel}/${name}', ${_lazy(name)});`);
				lines.push(`__registerAggregate('${rel}/${name}', ${_lazy(name)});`);
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
 * Check that src/hooks.ws.{js,ts} exists and exports the `message` handler.
 * Warns at build/dev startup if the file is missing or misconfigured.
 * @param {string} root
 * @param {string} liveDir
 * @param {string} dir
 */
function _checkHooksFile(root, liveDir, dir) {
	const files = _findLiveFiles(liveDir);
	if (files.length === 0) return;

	const hooksPath = resolve(root, 'src/hooks.ws');
	const hooksJs = hooksPath + '.js';
	const hooksTs = hooksPath + '.ts';
	const found = existsSync(hooksJs) ? hooksJs : existsSync(hooksTs) ? hooksTs : null;

	if (!found) {
		console.warn(
			`[svelte-realtime] Found live modules in ${dir}/ but no src/hooks.ws.js -- ` +
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

	const hasMessage = /export\s*\{[^}]*\bmessage\b[^}]*\}\s*from\s+['"]svelte-realtime\/server['"]/.test(source)
		|| /export\s+(?:const|function|async\s+function)\s+message\b/.test(source);

	if (!hasMessage) {
		const name = found.endsWith('.ts') ? 'src/hooks.ws.ts' : 'src/hooks.ws.js';
		console.warn(
			`[svelte-realtime] ${name} exists but does not export a \`message\` handler -- ` +
			`WebSocket RPC calls from ${dir}/ will go unhandled.\n` +
			`  Add: export { message } from 'svelte-realtime/server';\n` +
			`  See: https://svti.me/hooks`
		);
	}
}

/**
 * Generate and write type declarations for all $live/ modules.
 * Creates `$types.d.ts` in the live directory with ambient module declarations.
 * @param {string} liveDir
 * @param {string} dir
 */
function _writeTypeDeclarations(liveDir, dir) {
	const typesPath = resolve(liveDir, '$types.d.ts');
	const content = _generateTypeDeclarations(liveDir, dir);
	if (content) {
		writeFileSync(typesPath, content);
	} else if (existsSync(typesPath)) {
		// Remove stale declarations when all live modules are deleted
		try { rmSync(typesPath); } catch {}
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
		'// Auto-generated by svelte-realtime -- do not edit',
		'// Provides client-side types for $live/ imports',
		''
	];

	for (const filePath of files) {
		const rel = relative(liveDir, filePath).replace(/\\/g, '/').replace(/\.[jt]s$/, '');
		const source = _readCached(filePath);
		const isTS = filePath.endsWith('.ts');

		/** @type {string[]} */
		const exports = [];
		/** @type {Set<string>} */
		const handledNames = new Set();
		let needsStreamStore = false;
		let needsRpcError = false;

		// Detect live() exports
		let match;
		LIVE_EXPORT_RE.lastIndex = 0;
		while ((match = LIVE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			if (isTS) {
				const sig = _extractFunctionSignature(source, name);
				exports.push(`  export const ${name}: ${sig};`);
			} else {
				exports.push(`  export const ${name}: (...args: any[]) => Promise<any>;`);
			}
		}

		// Detect live.validated() exports -- extract real types for TS
		VALIDATED_EXPORT_RE.lastIndex = 0;
		while ((match = VALIDATED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			// Only add if not already detected by LIVE_EXPORT_RE
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				if (isTS) {
					const sig = _extractFunctionSignatureFor(source, name, 'live\\.validated', 1);
					exports.push(`  export const ${name}: ${sig};`);
				} else {
					exports.push(`  export const ${name}: (...args: any[]) => Promise<any>;`);
				}
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
			handledNames.add(name);
			needsStreamStore = true;
			needsRpcError = true;
			const isDynamic = _isDynamicExport(source, name, 'live\\.stream');
			if (isTS) {
				const returnType = _extractStreamReturnType(source, name);
				const storeType = `StreamStore<${returnType} | undefined | { error: RpcError }>`;
				const loadSig = `{ load(platform: any, options?: { args?: any[]; user?: any }): Promise<${returnType}> }`;
				if (isDynamic) {
					const factoryParams = _extractDynamicFactoryParams(source, name, 'live\\.stream');
					exports.push(`  export const ${name}: (${factoryParams} => ${storeType}) & ${loadSig};`);
				} else {
					exports.push(`  export const ${name}: ${storeType} & ${loadSig};`);
				}
			} else {
				const loadSig = `{ load(platform: any, options?: { args?: any[]; user?: any }): Promise<any> }`;
				if (isDynamic) {
					exports.push(`  export const ${name}: ((...args: any[]) => StreamStore<any>) & ${loadSig};`);
				} else {
					exports.push(`  export const ${name}: StreamStore<any> & ${loadSig};`);
				}
			}
		}

		// Detect live.channel() exports (same shape as streams)
		CHANNEL_EXPORT_RE.lastIndex = 0;
		while ((match = CHANNEL_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				needsStreamStore = true;
				const isDynamic = _isDynamicExport(source, name, 'live\\.channel');
				const loadSig = `{ load(platform: any, options?: { args?: any[]; user?: any }): Promise<any> }`;
				if (isDynamic) {
					if (isTS) {
						const factoryParams = _extractDynamicFactoryParams(source, name, 'live\\.channel');
						exports.push(`  export const ${name}: (${factoryParams} => StreamStore<any>) & ${loadSig};`);
					} else {
						exports.push(`  export const ${name}: ((...args: any[]) => StreamStore<any>) & ${loadSig};`);
					}
				} else {
					exports.push(`  export const ${name}: StreamStore<any> & ${loadSig};`);
				}
			}
		}

		// Detect live.derived() exports (read-only stream, static or dynamic)
		DERIVED_EXPORT_RE.lastIndex = 0;
		while ((match = DERIVED_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				needsStreamStore = true;
				const isDynamic = _isDynamicExport(source, name, 'live\\.derived');
				const loadSig = `{ load(platform: any, options?: { args?: any[]; user?: any }): Promise<any> }`;
				if (isDynamic) {
					if (isTS) {
						const factoryParams = _extractDynamicFactoryParams(source, name, 'live\\.derived');
						exports.push(`  export const ${name}: (${factoryParams} => StreamStore<any>) & ${loadSig};`);
					} else {
						exports.push(`  export const ${name}: ((...args: any[]) => StreamStore<any>) & ${loadSig};`);
					}
				} else {
					exports.push(`  export const ${name}: StreamStore<any> & ${loadSig};`);
				}
			}
		}

		// Detect live.aggregate() exports (read-only stream)
		AGGREGATE_EXPORT_RE.lastIndex = 0;
		while ((match = AGGREGATE_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				needsStreamStore = true;
				exports.push(`  export const ${name}: StreamStore<any> & { load(platform: any, options?: { args?: any[]; user?: any }): Promise<any> };`);
			}
		}

		// Detect live.binary() exports
		BINARY_EXPORT_RE.lastIndex = 0;
		while ((match = BINARY_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				exports.push(`  export const ${name}: (buffer: ArrayBuffer | ArrayBufferView, ...args: any[]) => Promise<any>;`);
			}
		}

		// Detect live.rateLimit() exports -- extract real types for TS
		RATE_LIMIT_EXPORT_RE.lastIndex = 0;
		while ((match = RATE_LIMIT_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				if (isTS) {
					const sig = _extractFunctionSignatureFor(source, name, 'live\\.rateLimit', 1);
					exports.push(`  export const ${name}: ${sig};`);
				} else {
					exports.push(`  export const ${name}: (...args: any[]) => Promise<any>;`);
				}
			}
		}

		// Detect live.room() exports
		ROOM_EXPORT_RE.lastIndex = 0;
		while ((match = ROOM_EXPORT_RE.exec(source)) !== null) {
			const name = match[1];
			handledNames.add(name);
			if (!exports.some(e => e.includes(`export const ${name}:`))) {
				needsStreamStore = true;
				exports.push(`  export const ${name}: { data: (...args: any[]) => StreamStore<any>, presence?: (...args: any[]) => StreamStore<any>, cursors?: (...args: any[]) => StreamStore<any>, [action: string]: (...args: any[]) => Promise<any> | ((...args: any[]) => StreamStore<any>) };`);
			}
		}

		// Warn about exports with non-path-safe names (after all valid names collected)
		_warnUnsafeExports(source, `${dir}/${rel}`, handledNames);

		if (exports.length > 0) {
			declarations.push(`declare module '$live/${rel}' {`);
			if (needsStreamStore || needsRpcError) {
				const clientImports = [];
				if (needsStreamStore) clientImports.push('StreamStore');
				if (needsRpcError) clientImports.push('RpcError');
				declarations.push(`  import type { ${clientImports.join(', ')} } from 'svelte-realtime/client';`);
			}
			declarations.push(`  import type { Readable } from 'svelte/store';`);
			if (needsStreamStore || needsRpcError) {
				declarations.push('');
			}
			declarations.push(...exports);
			declarations.push(`  export const empty: Readable<undefined>;`);
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
	return _extractFunctionSignatureFor(source, name, 'live', 0);
}

/**
 * Shared signature extractor for live(), live.validated(), and live.rateLimit().
 * Finds the callback at the given argument position, handles both arrow functions
 * and function expressions, and extracts params + return type.
 * @param {string} source
 * @param {string} name
 * @param {string} liveCall - e.g. 'live', 'live\\.validated', 'live\\.rateLimit'
 * @param {number} callbackArgIndex - 0-based position of the callback argument
 * @returns {string}
 */
function _extractFunctionSignatureFor(source, name, liveCall, callbackArgIndex) {
	const fallback = '(...args: any[]) => Promise<any>';

	// Find: export const name = liveCall(
	const startPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*${liveCall}\\s*\\(`
	);
	const startMatch = startPattern.exec(source);
	if (!startMatch) return fallback;

	const afterOpen = startMatch.index + startMatch[0].length;
	const cbStart = _findNthArgStart(source, afterOpen, callbackArgIndex);
	if (cbStart < 0) return fallback;

	const sig = _parseCallbackSignature(source, cbStart);
	if (!sig) return fallback;

	const returnType = sig.returnType || 'Promise<any>';

	// Split params, drop the first one (ctx), strip default initializers
	const params = _splitParams(sig.paramsStr);
	params.shift(); // remove ctx
	const cleanParams = _stripParamDefaults(params);

	const clientParams = cleanParams.length > 0 ? cleanParams.join(', ') : '';
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
	// Find: export const name = live.stream(
	const startPattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*live\\.stream\\s*\\(`
	);
	const startMatch = startPattern.exec(source);
	if (!startMatch) return 'any';

	const afterOpen = startMatch.index + startMatch[0].length;

	// The init callback is the 2nd argument (after topic string or dynamic factory)
	const cbStart = _findNthArgStart(source, afterOpen, 1);
	if (cbStart < 0) return 'any';

	const sig = _parseCallbackSignature(source, cbStart);
	if (!sig || !sig.returnType) return 'any';

	const returnAnnotation = sig.returnType.trim();
	// Unwrap Promise<T> to get T
	const promiseMatch = returnAnnotation.match(/^Promise\s*<\s*(.+)\s*>$/s);
	if (promiseMatch) return promiseMatch[1].trim();
	return returnAnnotation;
}

/**
 * Find the next top-level comma in `source` starting from `start`,
 * respecting balanced parens/braces/brackets and skipping strings/comments/regex.
 * @param {string} source
 * @param {number} start
 * @returns {number} Index of the comma, or -1 if not found
 */
/**
 * Check whether a live.stream() or live.channel() export is dynamic
 * (first argument is a function expression or arrow function, not a string topic).
 * @param {string} source
 * @param {string} name
 * @param {string} apiName - e.g. 'live\\.stream', 'live\\.channel'
 * @returns {boolean}
 */
function _isDynamicExport(source, name, apiName) {
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*${apiName}\\s*\\(`
	);
	const m = pattern.exec(source);
	if (!m) return false;
	const afterOpen = m.index + m[0].length;
	return _isFirstArgFunction(source, afterOpen);
}

/**
 * Extract the client-facing parameter list from a dynamic stream/channel's
 * topic factory function. Drops the leading ctx param and returns a
 * parenthesized param string like `(roomId: string, page: number)`.
 * Falls back to `(...args: any[])` if parsing fails.
 * @param {string} source
 * @param {string} name
 * @param {string} apiName
 * @returns {string}
 */
/**
 * Check whether a parameter string looks like a ctx/context parameter.
 * Returns true if the param name (before : type annotation) is ctx, context,
 * or is typed with a known context type pattern.
 * @param {string} param - A single parameter string, e.g. 'ctx: Ctx', 'context', 'roomId: string'
 * @returns {boolean}
 */
/**
 * Strip default initializers from parameter strings for .d.ts output.
 * `count: number = 1` → `count?: number`
 * `label = 'x'` → `label?: any`
 * Params without defaults are returned unchanged.
 * @param {string[]} params
 * @returns {string[]}
 */
function _stripParamDefaults(params) {
	return params.map(p => {
		// Find top-level = (not inside <>, (), {}, [])
		let depth = 0;
		let eqIdx = -1;
		for (let i = 0; i < p.length; i++) {
			const ch = p[i];
			if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth++;
			else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth--;
			else if (ch === '=' && depth === 0 && p[i + 1] !== '>') {
				eqIdx = i;
				break;
			}
		}
		if (eqIdx < 0) return p; // no default

		const beforeEq = p.slice(0, eqIdx).trim();
		// Check if there's a type annotation
		const colonIdx = beforeEq.indexOf(':');
		if (colonIdx >= 0) {
			// Has type: `name: Type = val` → `name?: Type`
			const name = beforeEq.slice(0, colonIdx).trim();
			const type = beforeEq.slice(colonIdx + 1).trim();
			return `${name}?: ${type}`;
		}
		// No type: `name = val` → `name?: any`
		return `${beforeEq}?: any`;
	});
}

function _isCtxParam(param) {
	const trimmed = param.trim();
	// Destructured first param -- never auto-classify. We cannot distinguish
	// ctx destructuring from payload-object destructuring by property names.
	if (trimmed.startsWith('{')) return false;
	// Extract the bare name (strip type annotation, default value)
	const nameMatch = trimmed.match(/^([\w$]+)/);
	if (!nameMatch) return false;
	const name = nameMatch[1];
	if (name === 'ctx' || name === 'context' || name === '_ctx') return true;
	// Check if typed as a context-like type
	const typeMatch = trimmed.match(/:\s*(.+)/);
	if (typeMatch) {
		const type = typeMatch[1].trim();
		if (/^(?:Ctx|Context|RequestContext|ServerContext|LiveContext)\b/.test(type)) return true;
	}
	return false;
}

function _extractDynamicFactoryParams(source, name, apiName) {
	const fallback = '(...args: any[])';
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*${apiName}\\s*\\(`
	);
	const m = pattern.exec(source);
	if (!m) return fallback;
	const afterOpen = m.index + m[0].length;
	const argStart = _findNthArgStart(source, afterOpen, 0);
	if (argStart < 0) return fallback;
	const sig = _parseCallbackSignature(source, argStart);
	if (!sig) return fallback;
	const params = _splitParams(sig.paramsStr);
	// Destructured first param is ambiguous (could be ctx or a payload object).
	// Fall back to a safe generic signature instead of emitting a wrong one.
	if (params.length > 0 && params[0].trim().startsWith('{')) return fallback;
	// Only drop the first param if it looks like a ctx parameter.
	// The server uses arity-aware dispatch: if fn.length <= args.length,
	// the user omitted ctx and all params are client args.
	if (params.length > 0 && _isCtxParam(params[0])) {
		params.shift();
	}
	const cleanParams = _stripParamDefaults(params);
	return cleanParams.length > 0 ? `(${cleanParams.join(', ')})` : '()';
}

function _findTopLevelComma(source, start) {
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const skip = _skipNonCode(source, i);
		if (skip >= 0) { i = skip; continue; }
		const ch = source[i];
		if (ch === '(' || ch === '{' || ch === '[') depth++;
		else if (ch === ')' || ch === '}' || ch === ']') {
			if (depth === 0) return -1; // hit closing paren of live.stream()
			depth--;
		}
		else if (ch === ',' && depth === 0) return i;
	}
	return -1;
}

/**
 * Check whether the first top-level argument starting at `start` in `source`
 * is a function (arrow or function expression). Used to detect dynamic
 * streams/channels structurally instead of via regex.
 * @param {string} source
 * @param {number} start - Position right after the opening ( of the call
 * @returns {boolean}
 */
function _isFirstArgFunction(source, start) {
	// Skip whitespace
	let i = start;
	while (i < source.length && /\s/.test(source[i])) i++;
	// Check for: async? function, async? (, async? identifier =>
	const rest = source.slice(i);
	if (/^(?:async\s+)?function\b/.test(rest)) return true;
	if (/^(?:async\s+)?\(/.test(rest)) {
		// Could be arrow: (params) => ... or just grouped expression
		// Find balanced ) then check for =>
		const pMatch = rest.match(/^(?:async\s+)?\(/);
		if (!pMatch) return false;
		const pStart = i + pMatch[0].length - 1;
		let depth = 1;
		for (let j = pStart + 1; j < source.length; j++) {
			const skip = _skipNonCode(source, j);
			if (skip >= 0) { j = skip; continue; }
			if (source[j] === '(') depth++;
			else if (source[j] === ')') {
				depth--;
				if (depth === 0) {
					// Check for optional return type then => using balanced scanning
					let k = j + 1;
					while (k < source.length && /\s/.test(source[k])) k++;
					if (source[k] === '=' && source[k + 1] === '>') return true;
					if (source[k] === ':') {
						// Has return type -- scan for => at depth 0
						k++;
						let retDepth = 0;
						for (; k < source.length; k++) {
							const sk = _skipNonCode(source, k);
							if (sk >= 0) { k = sk; continue; }
							const c = source[k];
							if (c === '=' && source[k + 1] === '>') {
								if (retDepth === 0) return true;
								k++; continue; // skip > so it's not treated as angle-bracket close
							}
							if (c === '<' || c === '(' || c === '{' || c === '[') retDepth++;
							else if (c === '>' || c === ')' || c === '}' || c === ']') retDepth--;
						}
					}
					return false;
				}
			}
		}
		return false;
	}
	// Single-param arrow: identifier =>
	if (/^(?:async\s+)?[a-zA-Z_$][\w$]*\s*=>/.test(rest)) return true;
	return false;
}

/**
 * Parse a callback function (arrow or function expression) starting at `start`.
 * Returns the parameter string and return type annotation, or null on failure.
 * Handles: async? (params): RetType => body
 *          async? function name?(params): RetType { body }
 *          async? ident => body (single-param arrow)
 * @param {string} source
 * @param {number} start - Position of the first non-whitespace char of the callback
 * @returns {{ paramsStr: string, returnType: string | null } | null}
 */
function _parseCallbackSignature(source, start) {
	let i = start;
	while (i < source.length && /\s/.test(source[i])) i++;

	const rest = source.slice(i);

	// Skip async keyword if present
	let isAsync = false;
	if (rest.startsWith('async') && /\s/.test(rest[5])) {
		isAsync = true;
		i += 5;
		while (i < source.length && /\s/.test(source[i])) i++;
	}

	// function expression: function name?(params): RetType {
	if (source.slice(i).startsWith('function')) {
		i += 8; // skip 'function'
		while (i < source.length && /\s/.test(source[i])) i++;
		// Skip optional name
		if (/[\w$]/.test(source[i])) {
			while (i < source.length && /[\w$]/.test(source[i])) i++;
			while (i < source.length && /\s/.test(source[i])) i++;
		}
		if (source[i] !== '(') return null;
		const pStart = i;
		let depth = 1;
		let pEnd = -1;
		for (let j = pStart + 1; j < source.length; j++) {
			const skip = _skipNonCode(source, j);
			if (skip >= 0) { j = skip; continue; }
			if (source[j] === '(') depth++;
			else if (source[j] === ')') {
				depth--;
				if (depth === 0) { pEnd = j; break; }
			}
		}
		if (pEnd < 0) return null;
		const paramsStr = source.slice(pStart + 1, pEnd).trim();
		// Check for : ReturnType before the function body's opening {
		// Must use balanced scanning since the return type may contain { }
		// e.g. ): Promise<{ id: number }> {
		let afterIdx = pEnd + 1;
		while (afterIdx < source.length && /\s/.test(source[afterIdx])) afterIdx++;
		let retType = null;
		if (source[afterIdx] === ':') {
			afterIdx++; // skip ':'
			while (afterIdx < source.length && /\s/.test(source[afterIdx])) afterIdx++;
			// Scan for the body's opening { at depth 0
			let retStart = afterIdx;
			let braceDepth = 0;
			for (let j = afterIdx; j < source.length; j++) {
				const sk = _skipNonCode(source, j);
				if (sk >= 0) { j = sk; continue; }
				const c = source[j];
				// Skip => tokens so the > doesn't decrement depth
				if (c === '=' && source[j + 1] === '>') { j++; continue; }
				if (c === '<' || c === '(' || c === '[') braceDepth++;
				else if (c === '>' || c === ')' || c === ']') braceDepth--;
				else if (c === '{') {
					if (braceDepth === 0) {
						retType = source.slice(retStart, j).trim();
						break;
					}
					braceDepth++;
				} else if (c === '}') {
					braceDepth--;
				}
			}
		}
		return { paramsStr, returnType: retType };
	}

	// Single-param arrow: ident =>
	const singleMatch = source.slice(i).match(/^([a-zA-Z_$][\w$]*)\s*=>/);
	if (singleMatch) {
		return { paramsStr: singleMatch[1], returnType: null };
	}

	// Parenthesized arrow: (params): RetType =>
	if (source[i] !== '(') return null;
	const pStart = i;
	let depth = 1;
	let pEnd = -1;
	for (let j = pStart + 1; j < source.length; j++) {
		const skip = _skipNonCode(source, j);
		if (skip >= 0) { j = skip; continue; }
		if (source[j] === '(') depth++;
		else if (source[j] === ')') {
			depth--;
			if (depth === 0) { pEnd = j; break; }
		}
	}
	if (pEnd < 0) return null;
	const paramsStr = source.slice(pStart + 1, pEnd).trim();
	// After ), look for optional : ReturnType then =>
	// Must use balanced scanning since the return type can contain =>
	// e.g. ): Promise<{ fn: (x: number) => string }> =>
	let scanIdx = pEnd + 1;
	while (scanIdx < source.length && /\s/.test(source[scanIdx])) scanIdx++;
	let retType = null;
	if (source[scanIdx] === ':') {
		// Has return type annotation -- scan for => at depth 0
		scanIdx++; // skip ':'
		while (scanIdx < source.length && /\s/.test(source[scanIdx])) scanIdx++;
		const retStart = scanIdx;
		let retDepth = 0;
		for (let j = scanIdx; j < source.length; j++) {
			const sk = _skipNonCode(source, j);
			if (sk >= 0) { j = sk; continue; }
			const c = source[j];
			// Arrow token => : at depth 0 this ends the return type,
			// at depth > 0 skip both chars so > doesn't decrement depth
			if (c === '=' && source[j + 1] === '>') {
				if (retDepth === 0) {
					retType = source.slice(retStart, j).trim();
					break;
				}
				j++; // skip the > so it's not treated as angle-bracket close
				continue;
			}
			if (c === '<' || c === '(' || c === '{' || c === '[') retDepth++;
			else if (c === '>' || c === ')' || c === '}' || c === ']') retDepth--;
		}
		if (retType === null) return null; // no arrow found
	} else if (source[scanIdx] === '=' && source[scanIdx + 1] === '>') {
		// No return type, just =>
	} else {
		return null; // not an arrow function
	}
	return { paramsStr, returnType: retType };
}

/**
 * Find the start position of the Nth (0-based) top-level argument in a call,
 * starting from `start` (right after the opening paren).
 * Returns the index of the first non-whitespace character of that argument,
 * or -1 if there aren't enough arguments.
 * @param {string} source
 * @param {number} start
 * @param {number} n - 0-based argument index
 * @returns {number}
 */
function _findNthArgStart(source, start, n) {
	if (n === 0) {
		let i = start;
		while (i < source.length && /\s/.test(source[i])) i++;
		return i < source.length ? i : -1;
	}
	// Skip n commas at depth 0
	let commasFound = 0;
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const skip = _skipNonCode(source, i);
		if (skip >= 0) { i = skip; continue; }
		const ch = source[i];
		if (ch === '(' || ch === '{' || ch === '[') depth++;
		else if (ch === ')' || ch === '}' || ch === ']') {
			if (depth === 0) return -1;
			depth--;
		}
		else if (ch === ',' && depth === 0) {
			commasFound++;
			if (commasFound === n) {
				let j = i + 1;
				while (j < source.length && /\s/.test(source[j])) j++;
				return j < source.length ? j : -1;
			}
		}
	}
	return -1;
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
	let angleDepth = 0;
	let inType = false;
	let current = '';
	for (let i = 0; i < str.length; i++) {
		const skip = _skipNonCode(str, i);
		if (skip >= 0) {
			current += str.substring(i, skip + 1);
			i = skip;
			continue;
		}
		const ch = str[i];
		if (ch === '(' || ch === '{' || ch === '[') depth++;
		else if (ch === ')' || ch === '}' || ch === ']') depth--;
		// Track <> only inside type annotations (after : before = or ,)
		// to avoid treating comparison operators in default values as nesting
		if (ch === ':' && depth === 0 && angleDepth === 0) inType = true;
		if (ch === '=' && depth === 0 && angleDepth === 0 && str[i + 1] !== '>') inType = false;
		if (ch === '<' && inType) angleDepth++;
		else if (ch === '>' && angleDepth > 0) angleDepth--;
		if (ch === ',' && depth === 0 && angleDepth === 0) {
			params.push(current.trim());
			current = '';
			inType = false;
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
		console.error('[svelte-realtime] HMR failed: could not load svelte-realtime/server\n  See: https://svti.me/vite');
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
