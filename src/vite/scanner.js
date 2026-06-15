// @ts-check
import { _validSegmentReVite } from './patterns.js';
import { _warnedExports } from './source-cache.js';

/**
 * Check if an export name is a valid RPC path segment. Warn once per name if not.
 * @param {string} name
 * @param {string} filePath
 * @returns {boolean}
 */
export function _isValidExportName(name, filePath) {
	if (_validSegmentReVite.test(name)) return true;
	const warnKey = filePath + ':' + name;
	if (!_warnedExports.has(warnKey)) {
		_warnedExports.add(warnKey);
		console.warn(
			`[svelte-realtime] ${filePath}: export '${name}' contains characters not allowed in RPC paths (only a-z, A-Z, 0-9, _ are valid) - skipped\n  See: https://svti.me/rpc`
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
export function _warnUnsafeExports(source, filePath, alreadyHandled) {
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
export function _readStringLiteral(s, start) {
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
			// \xNN - two hex digits
			else if (next === 'x') {
				const hex = s.slice(j + 2, j + 4);
				if (/^[0-9a-fA-F]{2}$/.test(hex)) {
					result += String.fromCharCode(parseInt(hex, 16));
					j += 3;
				} else { result += next; j++; }
			}
			// \uXXXX - four hex digits
			else if (next === 'u' && s[j + 2] !== '{') {
				const hex = s.slice(j + 2, j + 6);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					result += String.fromCharCode(parseInt(hex, 16));
					j += 5;
				} else { result += next; j++; }
			}
			// \u{XXXXX} - unicode code point
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
				`[svelte-realtime] Template literal with interpolation cannot be statically analyzed: ${snippet}... - use a plain string ('...' or "...") instead\n  See: https://svti.me/vite`
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
export function _skipNonCode(s, i) {
	const ch = s[i];

	// Single / double quoted strings
	if (ch === '\'' || ch === '"') {
		for (let j = i + 1; j < s.length; j++) {
			if (s[j] === '\\') { j++; continue; }
			if (s[j] === ch) return j;
		}
		return s.length - 1;
	}

	// Template literals - track ${...} interpolation depth
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
				if (s[j] === '\n') break; // malformed - give up
			}
		}
	}

	return -1;
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
export function _skipStringContent(s, i) {
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

export function _findMatchingBrace(s, openIdx) {
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
export function _extractTemplatePattern(s, start, params) {
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
export function _parseArrowReturnTemplate(body, start) {
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
