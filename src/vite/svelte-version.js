// @ts-check
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';

/**
 * The features whose client code is a Svelte 5 rune module, keyed by the
 * subpath the generated `$live/*` code imports it from.
 * @type {Readonly<Record<string, string>>}
 */
const RUNE_SUBPATHS = Object.freeze({
	smooth: 'live.smooth',
	doc: 'live.doc',
	multiplayer: 'live.multiplayer with presence, cursors, an owner or a field surface',
	rooms: 'an enumerable live.room (its rooms() lobby view)'
});

const RUNE_IMPORT_RE = /from 'svelte-realtime\/(smooth|doc|multiplayer|rooms)'/;

/**
 * The major version of the Svelte the project installs, resolved from the
 * project root the way the app itself resolves it, or null when it cannot be
 * resolved (the check it feeds then stays out of the way).
 * @param {string} root
 * @returns {number | null}
 */
export function _installedSvelteMajor(root) {
	try {
		// Read, not require: the module cache would pin whichever install the
		// process resolved first.
		const pkgPath = createRequire(resolve(root, 'package.json')).resolve('svelte/package.json');
		const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
		const major = parseInt(String(version), 10);
		return Number.isFinite(major) ? major : null;
	} catch {
		return null;
	}
}

/**
 * The build error for a generated client module that needs a rune module the
 * installed Svelte cannot run, or null. Without it a Svelte 4 project fails
 * inside the package, on a Svelte error that names none of this.
 * @param {string} code generated `$live/*` client code
 * @param {string} modulePath the `$live/` path it was generated for
 * @param {number | null} svelteMajor
 * @returns {string | null}
 */
export function _runeSubpathError(code, modulePath, svelteMajor) {
	if (svelteMajor === null || svelteMajor >= 5) return null;
	const m = RUNE_IMPORT_RE.exec(code);
	if (!m) return null;
	return '[svelte-realtime] $live/' + modulePath + ' uses ' + RUNE_SUBPATHS[m[1]] +
		', which is built on Svelte 5 runes, and this project installs Svelte ' + svelteMajor + '.\n' +
		'  Upgrade to Svelte 5 to use it. Streams, RPCs and the $store syntax work on Svelte 4 as they are.';
}
