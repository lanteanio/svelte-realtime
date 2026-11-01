// @ts-check
import { readFileSync } from 'fs';

/** @type {Set<string>} Track already-warned export names to avoid duplicate warnings */
export const _warnedExports = new Set();

/** @type {Map<string, string>} Cache file contents to avoid redundant reads within a build cycle */
export const _fileCache = new Map();

/** @type {Map<string, { content: string, code: string, reconcileIntervalMs?: number }>} Cache generated stubs keyed by file path, validated against source content */
export const _codeCache = new Map();

/**
 * Read a watcher addition that has no Vite change-context reader. Empty
 * writes get a bounded chance to finish; a deliberately empty file still
 * removes its exports, and a removed file contributes no cached source.
 * @param {string} filePath
 * @returns {Promise<string | undefined>}
 */
export async function _readChangedSource(filePath) {
	for (let attempt = 0; ; attempt++) {
		let source;
		try { source = readFileSync(filePath, 'utf8'); }
		catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
			throw error;
		}
		if (source || attempt === 10) return source;
		await new Promise(resolve => setTimeout(resolve, 10)); // determinism-allow: bounds an empty development-file write, outside the realtime runtime
	}
}

/**
 * Read a file with caching. Returns cached content if available.
 * @param {string} filePath
 * @returns {string}
 */
export function _readCached(filePath) {
	let content = _fileCache.get(filePath);
	if (content === undefined) {
		content = readFileSync(filePath, 'utf-8');
		_fileCache.set(filePath, content);
	}
	return content;
}
