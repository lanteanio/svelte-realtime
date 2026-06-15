// @ts-check
import { _skipNonCode } from './scanner.js';

/**
 * Extract thrown LiveError codes from source for typed error unions.
 * Scans for `throw new LiveError('CODE', ...)` patterns.
 * @param {string} source
 * @returns {string[]}
 */
export function _extractErrorCodes(source) {
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
export function _extractFunctionSignature(source, name) {
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
export function _extractFunctionSignatureFor(source, name, liveCall, callbackArgIndex) {
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
export function _extractStreamReturnType(source, name) {
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
 * Check whether a live.stream() / live.channel() / live.derived() export
 * needs a dynamic-factory client stub.
 *
 * String-topic form (`live.stream('items', ...)`) is always static.
 *
 * Function-topic form is classified by the topic-fn's arity, mirroring the
 * server's `_callTopicFn` arity dispatch so the plugin and runtime agree:
 *
 *  - `() => topic`                  - static (no ctx, no client args)
 *  - `(ctx) => topic(ctx.user.id)`  - static (topic derived purely from
 *                                      authenticated ctx; secure-by-
 *                                      construction since the client has
 *                                      no input that could be tampered
 *                                      with to reach another user's data)
 *  - `(ctx, roomId) => topic(roomId)`  - dynamic factory (1 client arg)
 *  - `(roomId) => topic(roomId)`    - dynamic factory (server interprets
 *                                      single non-ctx param as omitted
 *                                      ctx + 1 client arg)
 *  - `({ user }) => topic(user.id)` - dynamic (destructured first param
 *                                      is ambiguous: could be ctx or
 *                                      payload; safest is to assume
 *                                      payload and emit the factory
 *                                      shape, matching the existing
 *                                      fallback in
 *                                      _extractDynamicFactoryParams)
 *
 * Ctx detection uses `_isCtxParam` - the same check that
 * `_extractDynamicFactoryParams` uses to decide whether to drop the first
 * param. Sharing that check keeps the dynamic/static decision consistent
 * with the param-extraction step.
 *
 * @param {string} source
 * @param {string} name
 * @param {string} apiName - e.g. 'live\\.stream', 'live\\.channel'
 * @returns {boolean}
 */
export function _isDynamicExport(source, name, apiName) {
	const pattern = new RegExp(
		`export\\s+const\\s+${name}\\s*=\\s*${apiName}\\s*\\(`
	);
	const m = pattern.exec(source);
	if (!m) return false;
	const afterOpen = m.index + m[0].length;
	if (!_isFirstArgFunction(source, afterOpen)) return false;

	// Function-form first arg. Arity-classify to distinguish a topic
	// derived purely from ctx (static) from a factory taking client args.
	const argStart = _findNthArgStart(source, afterOpen, 0);
	if (argStart < 0) return true;
	const sig = _parseCallbackSignature(source, argStart);
	if (!sig) return true;
	const params = _splitParams(sig.paramsStr);
	if (params.length === 0) return false;
	if (params.length === 1 && _isCtxParam(params[0])) return false;
	return true;
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
 * `count: number = 1` -> `count?: number`
 * `label = 'x'` -> `label?: any`
 * Params without defaults are returned unchanged.
 * @param {string[]} params
 * @returns {string[]}
 */
export function _stripParamDefaults(params) {
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
			// Has type: `name: Type = val` -> `name?: Type`
			const name = beforeEq.slice(0, colonIdx).trim();
			const type = beforeEq.slice(colonIdx + 1).trim();
			return `${name}?: ${type}`;
		}
		// No type: `name = val` -> `name?: any`
		return `${beforeEq}?: any`;
	});
}

export function _isCtxParam(param) {
	const trimmed = param.trim();
	// Destructured first param - never auto-classify. We cannot distinguish
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

export function _extractDynamicFactoryParams(source, name, apiName) {
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

export function _findTopLevelComma(source, start) {
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
export function _isFirstArgFunction(source, start) {
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
						// Has return type - scan for => at depth 0
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
export function _parseCallbackSignature(source, start) {
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
		// Has return type annotation - scan for => at depth 0
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
export function _findNthArgStart(source, start, n) {
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
export function _splitParams(str) {
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
