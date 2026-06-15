// @ts-check
import { readFileSync } from 'fs';

/** @type {Set<string>} Track already-warned export names to avoid duplicate warnings */
export const _warnedExports = new Set();

/** @type {Map<string, string>} Cache file contents to avoid redundant reads within a build cycle */
export const _fileCache = new Map();

/** @type {Map<string, { content: string, code: string }>} Cache generated stubs keyed by file path, validated against source content */
export const _codeCache = new Map();

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
