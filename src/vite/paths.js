// @ts-check
import { sep } from 'path';

/**
 * Return `file` spelled under `dir` when it lies inside `dir`, otherwise null.
 * Windows paths compare case-insensitively, so a path Vite reports with a
 * differently cased drive letter still maps onto the spelling used for imports.
 * A directory that already ends in the separator (a drive root such as `C:\`)
 * is not given a second one.
 * @param {string} dir
 * @param {string} file
 * @param {string} [separator]
 * @returns {string | null}
 */
export function _respellUnder(dir, file, separator = sep) {
	const prefix = dir.endsWith(separator) ? dir : dir + separator;
	if (file.startsWith(prefix)) return file;
	if (process.platform === 'win32' && file.toLowerCase().startsWith(prefix.toLowerCase())) {
		return prefix + file.slice(prefix.length);
	}
	return null;
}

/**
 * Keep svelte-realtime imports as bare specifiers in a server build, without
 * replacing a user's external list or predicate.
 * @param {{ external?: any }} options
 */
export function _externalizeRealtime(options) {
	const external = options.external;
	const realtime = /^svelte-realtime(\/.*)?$/;
	if (typeof external === 'function') {
		options.external = function (/** @type {string} */ id, /** @type {any[]} */ ...args) {
			return realtime.test(id) || external.call(this, id, ...args);
		};
	} else {
		options.external = [...(Array.isArray(external) ? external : external ? [external] : []), realtime];
	}
}
