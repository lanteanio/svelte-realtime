// @ts-check
import { colorForKey } from './shared/color.js';

/**
 * A tiny reactive holder for the local user's key. The generated namespace
 * owns one and the app sets it once with `namespace.identify(key)`; the
 * `MultiplayerRoom` reads it through `me` so calling `identify(key)` after the
 * room is created still lights up self-exclusion. Until set it is `null`, which
 * the room treats as "self unknown" (the full deduped roster, no crash).
 *
 * @param {string | null} [initial]
 */
export function localKeySource(initial) {
	let key = $state(initial ?? null);
	return {
		get value() { return key; },
		/** @param {string | null | undefined} next */
		set(next) { key = next ?? null; }
	};
}

/**
 * Dedupe a roster list by user key, keeping the latest entry per key. Entries
 * without a key are dropped (they cannot be addressed or colored).
 *
 * @param {Array<{ key?: string }> | null | undefined} list
 * @returns {Array<any>}
 */
function dedupeByUser(list) {
	const seen = new Map();
	for (const item of list || []) {
		if (item && item.key != null) seen.set(item.key, item);
	}
	return [...seen.values()];
}

/**
 * Live roster aggregation for a `live.multiplayer()` room. Composes the
 * generated presence / cursor / status stores into the public surface an app
 * renders: `others` (the presence roster, deduped by user key, each entry
 * stamped with a deterministic color, excluding the local user when known),
 * `cursors` (deduped + colored), `me` (the local user key, or `null` when the
 * app never supplied one), and `status` (the connection-status passthrough).
 *
 * When `me` is unknown the surface degrades gracefully: `others` is the full
 * deduped roster (no self-exclusion) and `me` reads `null`, never a crash.
 *
 * `me` is supplied either as a plain key or as a reactive holder (the
 * `localKeySource` the generated namespace owns). Reading it through a getter
 * means `identify(key)` called after the room is constructed updates self-
 * exclusion live.
 *
 * The views are `$derived` over `$state` snapshots of the injected stores, so a
 * store push followed by a reactive flush refreshes every view.
 */
export class MultiplayerRoom {
	#meSource;
	#presence = $state([]);
	#cursors = $state([]);
	#status = $state('idle');
	#move;
	#reportViewport;
	#unsubs = [];

	constructor(deps) {
		this.#meSource = deps.me;
		this.#move = deps.move;
		this.#reportViewport = deps.reportViewport || deps.move;
		this.#unsubs.push(deps.presence.subscribe((v) => { this.#presence = v || []; }));
		this.#unsubs.push(deps.cursors.subscribe((v) => { this.#cursors = v || []; }));
		this.#unsubs.push(deps.status.subscribe((v) => { this.#status = v; }));
	}

	// Reads the reactive holder when one was injected (so identify(key) after
	// construction lights up self-exclusion), else the plain value, else null.
	get me() {
		const m = this.#meSource;
		const raw = (m && typeof m === 'object' && 'value' in m) ? m.value : m;
		// The server stamps every presence/cursor key as String(id), so coerce
		// the local key the same way - a numeric identify(42) still self-excludes
		// against the stored "42" instead of silently showing the local user.
		return raw == null ? null : String(raw);
	}
	get status() { return this.#status; }

	#othersDerived = $derived(
		dedupeByUser(this.#presence)
			.filter((p) => this.me == null || p.key !== this.me)
			.map((p) => ({ ...p, color: colorForKey(p.key) }))
	);
	get others() { return this.#othersDerived; }

	#cursorsDerived = $derived(
		dedupeByUser(this.#cursors).map((c) => ({ ...c, color: colorForKey(c.key) }))
	);
	get cursors() { return this.#cursorsDerived; }

	// Stubbed field surfaces: present so the API shape is stable, inert until
	// the client-to-server presence-field send path lands.
	get typing() { return []; }
	get locks() { return {}; }
	get selections() { return {}; }
	get reactions() { return []; }

	move(...args) { return this.#move ? this.#move(...args) : undefined; }
	reportViewport(...args) { return this.#reportViewport ? this.#reportViewport(...args) : undefined; }

	react() {}
	setTyping() {}
	acquireLock() {}
	releaseLock() {}
	setSelection() {}

	destroy() {
		for (const off of this.#unsubs) off();
		this.#unsubs = [];
	}
}
