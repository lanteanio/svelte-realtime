// @ts-check
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';

/**
 * The features whose client code is a Svelte 5 rune module, keyed by the
 * subpath the generated `$live/*` code imports it from, with the lowest
 * Svelte [major, minor] each one runs on.
 * @type {Readonly<Record<string, { feature: string, min: [number, number] }>>}
 */
const RUNE_SUBPATHS = Object.freeze({
	smooth: { feature: 'live.smooth', min: [5, 0] },
	doc: { feature: 'live.doc', min: [5, 0] },
	// The room view counts its readers with createSubscriber, new in 5.7.
	multiplayer: { feature: 'live.multiplayer with presence, cursors, an owner or a field surface', min: [5, 7] },
	rooms: { feature: 'an enumerable live.room (its rooms() lobby view)', min: [5, 0] }
});

const RUNE_IMPORT_RE = /from 'svelte-realtime\/(smooth|doc|multiplayer|rooms)'/g;

/**
 * The version of the Svelte the project installs, resolved from the project
 * root the way the app itself resolves it, or null when it cannot be resolved
 * (the check it feeds then stays out of the way).
 * @param {string} root
 * @returns {{ major: number, minor: number, version: string } | null}
 */
export function _installedSvelteVersion(root) {
	try {
		// Read, not require: the module cache would pin whichever install the
		// process resolved first.
		const pkgPath = createRequire(resolve(root, 'package.json')).resolve('svelte/package.json');
		const version = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version);
		const m = /^(\d+)(?:\.(\d+))?/.exec(version);
		if (!m) return null;
		return { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]), version };
	} catch {
		return null;
	}
}

/**
 * The build error for a generated client module that needs a rune module the
 * installed Svelte cannot run, or null. Without it the build fails inside the
 * package, on a Svelte or bundler error that names none of this.
 * @param {string} code generated `$live/*` client code
 * @param {string} modulePath the `$live/` path it was generated for
 * @param {{ major: number, minor: number, version: string } | null} svelte
 * @returns {string | null}
 */
export function _runeSubpathError(code, modulePath, svelte) {
	if (svelte === null) return null;
	// One module can import several rune features (a live.doc beside a
	// multiplayer room); the one needing the newest Svelte decides.
	let need = null;
	for (const m of code.matchAll(RUNE_IMPORT_RE)) {
		const sub = RUNE_SUBPATHS[m[1]];
		if (need === null || sub.min[0] > need.min[0] || (sub.min[0] === need.min[0] && sub.min[1] > need.min[1])) need = sub;
	}
	if (need === null) return null;
	const { feature, min } = need;
	if (svelte.major > min[0] || (svelte.major === min[0] && svelte.minor >= min[1])) return null;
	if (svelte.major < 5) {
		return '[svelte-realtime] $live/' + modulePath + ' uses ' + feature +
			', which is built on Svelte 5 runes, and this project installs Svelte ' + svelte.major + '.\n' +
			'  Upgrade to Svelte 5 to use it. Streams, RPCs and the $store syntax work on Svelte 4 as they are.';
	}
	return '[svelte-realtime] $live/' + modulePath + ' uses ' + feature +
		', which needs Svelte ' + min[0] + '.' + min[1] + ' or later, and this project installs Svelte ' + svelte.version + '.\n' +
		'  Upgrade Svelte to use it.';
}
