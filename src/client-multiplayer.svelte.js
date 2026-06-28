// @ts-check
import { colorForKey } from './shared/color.js';

// One-shot dev warnings for crdt-selection misuse, keyed by message so each DISTINCT
// diagnostic surfaces once (the "bind a doc" hint and the "upgrade the adapter" hint
// are different problems; a single shared latch would mask whichever fires second).
const _warnedCrdtSelection = new Set();
function _warnCrdtSelection(msg) {
	if (_warnedCrdtSelection.has(msg)) return;
	_warnedCrdtSelection.add(msg);
	if (typeof console !== 'undefined' && console.warn) {
		console.warn('[svelte-realtime] ' + msg);
	}
}

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
 * The collaborative field surfaces - `typing`, `selections`, `locks` - are
 * projections of the same presence roster: a caller stamps fields onto its own
 * entry through the injected send callbacks, the presence merge layers them in,
 * and these views read them back. `reactions` is the bounded ring of recent
 * ephemeral emotes from the dedicated reactions stream.
 *
 * The views are `$derived` over `$state` snapshots of the injected stores, so a
 * store push followed by a reactive flush refreshes every view.
 */
export class MultiplayerRoom {
	#meSource;
	#presence = $state([]);
	#cursors = $state([]);
	#reactions = $state([]);
	#status = $state('idle');
	#move;
	#reportViewport;
	#setTyping;
	#setSelection;
	#selectionMode;
	#boundDoc = $state(null);
	#acquireLock;
	#releaseLock;
	#react;
	#unsubs = [];

	constructor(deps) {
		this.#meSource = deps.me;
		this.#move = deps.move;
		this.#reportViewport = deps.reportViewport || deps.move;
		this.#setTyping = deps.setTyping;
		this.#setSelection = deps.setSelection;
		// 'crdt' (live.doc-anchored) | 'offset' (raw) | null/undefined (no selections).
		this.#selectionMode = deps.selections || null;
		this.#acquireLock = deps.acquireLock;
		this.#releaseLock = deps.releaseLock;
		this.#react = deps.react;
		this.#unsubs.push(deps.presence.subscribe((v) => { this.#presence = v || []; }));
		this.#unsubs.push(deps.cursors.subscribe((v) => { this.#cursors = v || []; }));
		this.#unsubs.push(deps.status.subscribe((v) => { this.#status = v; }));
		if (deps.reactions) {
			this.#unsubs.push(deps.reactions.subscribe((v) => { this.#reactions = v || []; }));
		}
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

	// Field surfaces are projections of the same presence roster `others` reads:
	// a caller stamps fields onto its own roster entry through the send path, the
	// presence merge layers them onto the entry, and these views read them back.
	// They add no new store subscription - one derive pass over the roster the
	// room already aggregates.

	// The keys of remote collaborators currently flagged as typing.
	#typingDerived = $derived(
		dedupeByUser(this.#presence)
			.filter((p) => p.typing === true && (this.me == null || p.key !== this.me))
			.map((p) => p.key)
	);
	get typing() { return this.#typingDerived; }

	// Advisory lock holders, keyed by lock key. A roster entry carries a held key
	// as `lock:<key>` (truthy while held, cleared on release); the holder is the
	// entry's own user key. This collapses the roster into a { lockKey: holder }
	// map. A holder leaving drops its entry, so its locks recompute to absent on
	// the next push - no stale grant survives.
	#locksDerived = $derived(this.#deriveLocks(this.#presence));
	get locks() { return this.#locksDerived; }

	// Remote selections, keyed by user. Self is excluded so an app renders only
	// collaborators' ranges. In offset mode each value is the raw payload the holder
	// sent; in crdt mode each holder sent a doc-anchored position which is resolved
	// here, against the bound live.doc, to current `{ field, start, end }` offsets -
	// reactively, so a selection re-resolves onto the right characters as the document
	// is edited. A crdt entry that cannot resolve (no bound doc, deleted container,
	// stale anchor) is dropped rather than rendered wrong.
	#selectionsDerived = $derived(this.#deriveSelections(this.#presence));
	get selections() { return this.#selectionsDerived; }

	/** @param {Array<Record<string, any>>} roster */
	#deriveSelections(roster) {
		const entries = dedupeByUser(roster).filter(
			(p) => p.selection != null && (this.me == null || p.key !== this.me)
		);
		if (this.#selectionMode !== 'crdt') {
			return Object.fromEntries(entries.map((p) => [p.key, p.selection]));
		}
		const doc = this.#boundDoc;
		if (!doc || typeof doc.text !== 'function') return /** @type {Record<string, any>} */ ({});
		const out = /** @type {Record<string, any>} */ ({});
		for (const p of entries) {
			const sel = p.selection;
			if (!sel || typeof sel.field !== 'string' || !Array.isArray(sel.a)) continue;
			// Resolve each peer independently and defensively: a single corrupt anchor
			// (an older client, a mangled payload) must drop only ITS entry, never throw
			// out of the derived and take down every collaborator's selection.
			try {
				const t = doc.text(sel.field);
				if (!t || typeof t.resolveRange !== 'function') continue;
				const r = t.resolveRange(new Uint8Array(sel.a));
				if (r) out[p.key] = { field: sel.field, start: r.start, end: r.end };
			} catch {
				/* drop this peer's selection; keep the rest */
			}
		}
		return out;
	}

	// The bounded ring of recent reactions. The send stream caps and GCs old
	// taps, so an app renders the current window and lets entries fall off.
	get reactions() { return this.#reactions; }

	/** @param {Array<Record<string, any>>} roster */
	#deriveLocks(roster) {
		const out = /** @type {Record<string, any>} */ ({});
		for (const entry of dedupeByUser(roster)) {
			for (const field in entry) {
				if (field.startsWith('lock:') && entry[field] != null && entry[field] !== false) {
					out[field.slice(5)] = entry.key;
				}
			}
		}
		return out;
	}

	move(...args) { return this.#move ? this.#move(...args) : undefined; }
	reportViewport(...args) { return this.#reportViewport ? this.#reportViewport(...args) : undefined; }

	// Toggle the local typing flag. Publishes a `{ typing }` delta onto the
	// caller's presence entry so every collaborator's `typing` view updates.
	setTyping(on) {
		return this.#setTyping ? this.#setTyping({ typing: !!on }) : undefined;
	}

	// Bind this room's live.doc so `selections: 'crdt'` selections anchor to and
	// resolve against the shared document. Call once with the DocHandle for the same
	// document the selections index into; a no-op for an offset-mode room.
	bindDoc(doc) {
		this.#boundDoc = doc || null;
		return this;
	}

	// Publish the local selection range. `null` clears it.
	//  - offset mode: a plain `{ start, end, nodePath }` object, sent verbatim.
	//  - crdt mode: `{ field, start, end }` against a bound live.doc text container;
	//    the offsets are encoded into a position anchor that survives concurrent edits
	//    (sent as `{ field, a: number[] }`). Without a bound doc or a `field`, the send
	//    is dropped with a one-shot dev warning rather than emitting a raw offset peers
	//    on a crdt room cannot resolve.
	setSelection(selection) {
		if (!this.#setSelection) return undefined;
		if (selection == null) return this.#setSelection({ selection: null });
		if (this.#selectionMode === 'crdt') {
			const doc = this.#boundDoc;
			const field = selection.field;
			if (!doc || typeof doc.text !== 'function' || typeof field !== 'string') {
				_warnCrdtSelection('setSelection on a crdt-selection room needs a bound live.doc and a { field } - call room.bindDoc(doc) and pass { field, start, end }.');
				return undefined;
			}
			const t = doc.text(field);
			if (!t || typeof t.anchorRange !== 'function') {
				_warnCrdtSelection('crdt selections require svelte-adapter-uws >= 0.6.0-next.45 (the live.doc text facet must expose anchorRange).');
				return undefined;
			}
			const bytes = t.anchorRange(selection.start, selection.end);
			return this.#setSelection({ selection: { field, a: Array.from(bytes) } });
		}
		return this.#setSelection({ selection });
	}

	// Claim an advisory lock on a key: stamps `lock:<key>` on the caller's
	// presence entry, which the server keys by the caller's identity. Advisory
	// only - it announces intent, it does not block another claimant.
	acquireLock(lockKey) {
		if (!this.#acquireLock || lockKey == null) return undefined;
		return this.#acquireLock({ ['lock:' + lockKey]: true });
	}

	// Release an advisory lock: clears `lock:<key>` on the caller's entry.
	releaseLock(lockKey) {
		if (!this.#releaseLock || lockKey == null) return undefined;
		return this.#releaseLock({ ['lock:' + lockKey]: null });
	}

	// Emit an ephemeral reaction (an emote token at an optional point). Rides the
	// dedicated reactions stream, never the roster, so it is a one-off event.
	react(token, at) {
		if (!this.#react) return undefined;
		return at !== undefined ? this.#react(token, at) : this.#react(token);
	}

	destroy() {
		for (const off of this.#unsubs) off();
		this.#unsubs = [];
	}
}
