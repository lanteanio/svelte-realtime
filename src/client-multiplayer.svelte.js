// @ts-check
import { untrack } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import { colorForKey } from './shared/color.js';

// One-shot dev warnings, keyed by message so each DISTINCT diagnostic surfaces
// once (the "bind a doc" hint and the "upgrade the adapter" hint are different
// problems; a single shared latch would mask whichever fires second).
const _warned = new Set();
function _warnOnce(msg) {
	if (_warned.has(msg)) return;
	_warned.add(msg);
	if (typeof console !== 'undefined' && console.warn) {
		console.warn('[svelte-realtime] ' + msg);
	}
}

/**
 * A tiny reactive holder for the local user's key. The generated namespace
 * owns one and the app sets it once with `namespace.identify(key)`; the
 * `MultiplayerRoom` reads it through `me` so calling `identify(key)` after the
 * room is created still lights up self-exclusion. Until set it is `null`, which
 * the room treats as "self unknown" (the full deduped roster, no crash). The key
 * may be a getter (`identify(() => data.userId)`), read wherever `me` is, so a
 * key that comes from props stays current.
 *
 * @param {string | null | (() => string | null | undefined)} [initial]
 */
export function localKeySource(initial) {
	let key = $state(initial ?? null);
	return {
		get value() { return typeof key === 'function' ? key() ?? null : key; },
		/** @param {string | null | undefined | (() => string | null | undefined)} next */
		set(next) { key = next ?? null; }
	};
}

/**
 * Whether two room-arg lists name the same room. `null` is no room.
 *
 * @param {any[] | null | undefined} a
 * @param {any[] | null | undefined} b
 */
function sameArgs(a, b) {
	if (a === b) return true;
	return !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

// Marks the binding of a getter that names no room.
const NO_ROOM = Symbol('no room');

/**
 * Whether an effect cleanup is running right now. Svelte refuses an effect
 * inside a cleanup with `effect_in_teardown`, even in a root of its own, while
 * module code and event handlers may create one; that is the only public sign,
 * and it holds for the cleanups Svelte runs with no effect active (an outro's
 * end, `unmount()`), which otherwise look like plain code.
 */
function inCleanup() {
	let refused = false;
	const stop = $effect.root(() => {
		try {
			$effect.pre(() => {});
		} catch (e) {
			if (!(e instanceof Error && e.message.includes('effect_in_teardown'))) throw e;
			refused = true;
		}
	});
	stop();
	return refused;
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
 *
 * The stores (and with them, for a joined room, the membership) are held for
 * the life of whatever built the room (a component's script, an `$effect`),
 * while anything reactive reads a view, and, for a room built outside Svelte's
 * reactivity, from construction until `destroy()`. A room built with a getter
 * for its args follows it from one room to the next, and is in no room while
 * the getter returns null or undefined.
 */
export class MultiplayerRoom {
	#meSource;
	#deps;
	#presence = $state([]);
	#cursors = $state([]);
	#reactions = $state([]);
	#owner = $state(null);
	#status = $state('idle');
	#selectionMode;
	#boundDoc = $state(null);
	#unsubs = [];
	#live = false;
	#pinned = false;
	#destroyed = false;
	#held = $state(false);
	#track;
	#bound;
	#args;
	#argsGetter = null;
	#followRoot = null;
	// The binding for a room the getter names before the view has moved there.
	#ahead = null;
	// The binding the last send resolved to, for #noSend's note.
	#via = null;
	// The getter's args, memoized so that a read changes only when the room
	// does (a prop object replaced with an equal one names the same room).
	#seen = null;
	#current = $derived.by(() => {
		const next = this.#readArgs();
		if (sameArgs(next, this.#seen)) return this.#seen;
		return (this.#seen = next);
	});

	constructor(deps) {
		this.#deps = deps;
		this.#meSource = deps.me;
		// 'crdt' (live.doc-anchored) | 'offset' (raw) | null/undefined (no selections).
		this.#selectionMode = deps.selections || null;
		// A generated room passes its room args with `bind`, which turns them
		// into that room's streams and send paths. A single function argument
		// is a getter to follow: board.room(() => boardId) switches rooms when
		// boardId changes, which keeps one room per component and the read of
		// a prop inside a closure.
		const args = deps.args;
		if (typeof deps.bind === 'function' && Array.isArray(args) && args.length === 1 && typeof args[0] === 'function') {
			this.#argsGetter = args[0];
		}
		this.#bind(this.#argsGetter ? untrack(() => this.#readArgs()) : args);
		// Readers are counted: the stores are subscribed while any effect or
		// template reads a view, and released a microtask after the last one
		// goes. Svelte runs this bookkeeping itself, so a view read in a
		// derived that is dropped, frozen or re-run keeps an honest count.
		this.#track = createSubscriber(() => {
			this.#start();
			return () => { if (!this.#pinned) this.#stop(); };
		});
		// Every subscription belongs to something that ends it, because Svelte
		// may run this constructor inside a derived it later throws away or
		// re-runs with old values, and a subscribe nothing releases is a join
		// that never leaves. What holds the room for the life of its builder (a
		// component, a derived, an effect) is this effect, which runs at once
		// and reads the room as one more reader. It
		// has no teardown on purpose: when a derived's last reader goes, Svelte
		// freezes the derived's effects by running their teardowns, and one
		// without a teardown keeps its reader, so a room stays joined for as
		// long as its component lives, rendered or not. Its child reports when
		// it ends (children are not frozen with a derived). While it lives the
		// views skip the per-read count, which it outlasts anyway; when it goes,
		// every view read re-runs and counts, so a room something still shows
		// stays subscribed. A second child follows the args getter.
		try {
			$effect.pre(() => {
				this.#track();
				$effect.pre(() => {
					this.#held = true;
					return () => { this.#held = false; };
				});
				// Once destroyed it stops reading the getter, which drops the tie.
				if (this.#argsGetter) $effect.pre(() => { if (!this.#destroyed) this.#follow(this.#current); });
			});
		} catch (e) {
			// Svelte refused the effect; its error code says why.
			const code = e instanceof Error ? e.message : '';
			if (code.includes('effect_orphan') && !inCleanup()) {
				// Outside Svelte's reactivity (module code, an event handler): the
				// caller owns the room until destroy(), getter and all.
				this.#pinned = true;
				this.#start();
				if (this.#argsGetter) {
					try {
						this.#followRoot = $effect.root(() => {
							$effect.pre(() => { this.#follow(this.#current); });
						});
					} catch (err) {
						this.#stop();
						throw err;
					}
				}
			} else if (!code.includes('effect_orphan') && !code.includes('effect_in_teardown') && !code.includes('effect_in_unowned_derived')) {
				throw e;
			}
			// Otherwise inside a cleanup (whether or not Svelte runs it inside an
			// effect), or a derived no effect owns (Svelte re-runs those freely):
			// only readers hold the room, so a room built there and thrown away
			// leaves nothing joined, and its sends still go out.
		}
	}

	// The room args the getter names, or null for no room.
	/** @returns {any[] | null} */
	#readArgs() {
		const v = /** @type {() => any} */ (this.#argsGetter)();
		if (v == null) return null;
		return Array.isArray(v) ? v : [v];
	}

	// The streams and send paths for a room's args; for no room, only what
	// every room shares (the local key, the connection status).
	/** @param {any[] | null | undefined} args */
	#binding(args) {
		const d = this.#deps;
		if (typeof d.bind !== 'function') return d;
		return args === null ? { ...d, [NO_ROOM]: true } : { ...d, ...d.bind(args || []) };
	}

	/** @param {any[] | null | undefined} args */
	#bind(args) {
		this.#args = args;
		this.#bound = this.#binding(args);
	}

	// Move to the room the getter now names: leave the old room's streams,
	// bind the new args, and subscribe again if the room was live. A store
	// hands its current value to a new subscriber at once, so the views show
	// the new room before anything renders; with no room there is no store
	// to do that, so the views are emptied here.
	/** @param {any[] | null} args */
	#follow(args) {
		if (this.#destroyed || sameArgs(args, this.#args)) return;
		untrack(() => {
			const live = this.#live;
			if (live) this.#stop();
			this.#ahead = null;
			this.#bind(args);
			if (args === null) {
				this.#presence = [];
				this.#cursors = [];
				this.#reactions = [];
				this.#owner = null;
			}
			if (live) this.#start();
		});
	}

	#start() {
		if (this.#live || this.#destroyed) return;
		this.#live = true;
		const deps = this.#bound;
		try {
			// No room (a getter that names none) has no roster or cursor streams.
			if (deps.presence) this.#unsubs.push(deps.presence.subscribe((v) => { this.#presence = v || []; }));
			if (deps.cursors) this.#unsubs.push(deps.cursors.subscribe((v) => { this.#cursors = v || []; }));
			this.#unsubs.push(deps.status.subscribe((v) => { this.#status = v; }));
			// The room's data stream: subscribing it is what makes the local user
			// a member others see (and a candidate for ownership). Its value is
			// the room's data, which this view does not read. A watch() view is
			// built without it and only observes. It shares the subscribe batch
			// with the presence stream above, which the server pairs the join with.
			if (deps.membership) {
				this.#unsubs.push(deps.membership.subscribe(() => {}));
			}
			if (deps.reactions) {
				this.#unsubs.push(deps.reactions.subscribe((v) => { this.#reactions = v || []; }));
			}
			if (deps.owner) {
				// The owner stream's value is { key, reason }; the view keeps the
				// key (stringified like every roster key, so isOwner compares cleanly).
				this.#unsubs.push(deps.owner.subscribe((v) => {
					this.#owner = v && v.key != null ? String(v.key) : null;
				}));
			}
		} catch (e) {
			// A store that throws must not leave the ones before it subscribed.
			this.#stop();
			throw e;
		}
	}

	#stop() {
		const unsubs = this.#unsubs;
		this.#unsubs = [];
		this.#live = false;
		for (const off of unsubs) off();
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
	get status() { if (!this.#held) this.#track(); return this.#status; }

	// The room's current owner key (null while unclaimed / vacated / not yet
	// loaded), and whether the local user holds the role. isOwner needs
	// identify(key) - with no local key it reads false, never a crash.
	get owner() { if (!this.#held) this.#track(); return this.#owner; }
	get isOwner() {
		if (!this.#held) this.#track();
		const me = this.me;
		return me != null && this.#owner != null && me === this.#owner;
	}

	#othersDerived = $derived(
		dedupeByUser(this.#presence)
			.filter((p) => this.me == null || p.key !== this.me)
			.map((p) => ({ ...p, color: colorForKey(p.key) }))
	);
	get others() { if (!this.#held) this.#track(); return this.#othersDerived; }

	#cursorsDerived = $derived(
		dedupeByUser(this.#cursors).map((c) => ({ ...c, color: colorForKey(c.key) }))
	);
	get cursors() { if (!this.#held) this.#track(); return this.#cursorsDerived; }

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
	get typing() { if (!this.#held) this.#track(); return this.#typingDerived; }

	// Advisory lock holders, keyed by lock key. A roster entry carries a held key
	// as `lock:<key>` (truthy while held, cleared on release); the holder is the
	// entry's own user key. This collapses the roster into a { lockKey: holder }
	// map. A holder leaving drops its entry, so its locks recompute to absent on
	// the next push - no stale grant survives.
	#locksDerived = $derived(this.#deriveLocks(this.#presence));
	get locks() { if (!this.#held) this.#track(); return this.#locksDerived; }

	// Remote selections, keyed by user. Self is excluded so an app renders only
	// collaborators' ranges. In offset mode each value is the raw payload the holder
	// sent; in crdt mode each holder sent a doc-anchored position which is resolved
	// here, against the bound live.doc, to current `{ field, start, end }` offsets -
	// reactively, so a selection re-resolves onto the right characters as the document
	// is edited. A crdt entry that cannot resolve (no bound doc, deleted container,
	// stale anchor) is dropped rather than rendered wrong.
	#selectionsDerived = $derived(this.#deriveSelections(this.#presence));
	get selections() { if (!this.#held) this.#track(); return this.#selectionsDerived; }

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
	get reactions() { if (!this.#held) this.#track(); return this.#reactions; }

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

	// A send method with nothing to send through: a watch() view, a field the
	// export does not declare, a getter that names no room, or a destroyed
	// room (which stays quiet).
	#noSend(method) {
		if (this.#destroyed) return undefined;
		if (this.#via && this.#via[NO_ROOM]) {
			_warnOnce(method + '() sends nothing while the room getter names no room.');
		} else {
			_warnOnce(method + '() sends nothing from this view: a watch() view never publishes, and a room(...) view publishes a field only when the export declares it.');
		}
		return undefined;
	}

	// The room a send goes to. Inside an effect it is the room the getter
	// names, even before the view has moved there, and the read ties the
	// effect to the room: when the room changes the effect re-runs and sends
	// to the new one. Anywhere else (an event handler, a cleanup) it is the
	// room the view is in at that moment; a cleanup that must reach the room
	// its effect acted in uses the methods here() returned in that effect.
	#resolve() {
		// A destroyed room sends nothing, and reading the getter would still
		// tie the caller to it.
		if (this.#destroyed) return this.#bound;
		if (this.#argsGetter && $effect.tracking()) {
			const args = this.#current;
			if (!sameArgs(args, this.#args)) {
				if (!this.#ahead || !sameArgs(args, this.#ahead.args)) {
					this.#ahead = { args, bound: this.#binding(args) };
				}
				return this.#ahead.bound;
			}
		}
		return this.#bound;
	}

	// The send callback for a method on a binding, or undefined (a destroyed
	// room sends nothing).
	/** @param {any} b @param {string} name */
	#path(b, name) {
		if (this.#destroyed) return undefined;
		this.#via = b;
		return name === 'reportViewport' ? (b.reportViewport || b.move) : b[name];
	}

	/** @param {any} b @param {'move' | 'reportViewport'} name @param {any[]} args */
	#cursor(b, name, args) {
		const send = this.#path(b, name);
		return send ? send(...args) : this.#noSend(name);
	}

	/** @param {any} b @param {any} on */
	#typing(b, on) {
		const send = this.#path(b, 'setTyping');
		return send ? send({ typing: !!on }) : this.#noSend('setTyping');
	}

	/** @param {any} b @param {any} selection */
	#selection(b, selection) {
		const send = this.#path(b, 'setSelection');
		if (!send) return this.#noSend('setSelection');
		if (selection == null) return send({ selection: null });
		if (this.#selectionMode === 'crdt') {
			const doc = this.#boundDoc;
			const field = selection.field;
			if (!doc || typeof doc.text !== 'function' || typeof field !== 'string') {
				_warnOnce('setSelection on a crdt-selection room needs a bound live.doc and a { field } - call room.bindDoc(doc) and pass { field, start, end }.');
				return undefined;
			}
			const t = doc.text(field);
			if (!t || typeof t.anchorRange !== 'function') {
				_warnOnce('crdt selections require svelte-adapter-uws >= 0.6.0-next.45 (the live.doc text facet must expose anchorRange).');
				return undefined;
			}
			const bytes = t.anchorRange(selection.start, selection.end);
			return send({ selection: { field, a: Array.from(bytes) } });
		}
		return send({ selection });
	}

	/** @param {any} b @param {'acquireLock' | 'releaseLock'} name @param {any} lockKey */
	#lock(b, name, lockKey) {
		const send = this.#path(b, name);
		if (!send) return this.#noSend(name);
		if (lockKey == null) return undefined;
		return send({ ['lock:' + lockKey]: name === 'acquireLock' ? true : null });
	}

	/** @param {any} b @param {any} token @param {any} at */
	#reaction(b, token, at) {
		const send = this.#path(b, 'react');
		if (!send) return this.#noSend('react');
		return at !== undefined ? send(token, at) : send(token);
	}

	// The send methods bound to the room the view names now. Take them in an
	// effect and use them in its cleanup: the cleanup reaches that room
	// whenever Svelte runs it (on a re-run, on unmount, after an outro, when
	// the view may already be in the next room). Taking them in an effect
	// ties the effect to the room, as a send does.
	here() {
		const b = this.#resolve();
		return {
			move: (...args) => this.#cursor(b, 'move', args),
			reportViewport: (...args) => this.#cursor(b, 'reportViewport', args),
			setTyping: (on) => this.#typing(b, on),
			setSelection: (selection) => this.#selection(b, selection),
			acquireLock: (lockKey) => this.#lock(b, 'acquireLock', lockKey),
			releaseLock: (lockKey) => this.#lock(b, 'releaseLock', lockKey),
			react: (token, at) => this.#reaction(b, token, at)
		};
	}

	move(...args) { return this.#cursor(this.#resolve(), 'move', args); }
	reportViewport(...args) { return this.#cursor(this.#resolve(), 'reportViewport', args); }

	// Toggle the local typing flag. Publishes a `{ typing }` delta onto the
	// caller's presence entry so every collaborator's `typing` view updates.
	setTyping(on) { return this.#typing(this.#resolve(), on); }

	// Bind this room's live.doc so `selections: 'crdt'` selections anchor to and
	// resolve against the shared document. Call it with the DocHandle for the
	// document the selections index into, and again with the next one when a room
	// that follows a getter moves; a no-op for an offset-mode room.
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
	setSelection(selection) { return this.#selection(this.#resolve(), selection); }

	// Claim an advisory lock on a key: stamps `lock:<key>` on the caller's
	// presence entry, which the server keys by the caller's identity. Advisory
	// only - it announces intent, it does not block another claimant.
	acquireLock(lockKey) { return this.#lock(this.#resolve(), 'acquireLock', lockKey); }

	// Release an advisory lock: clears `lock:<key>` on the caller's entry.
	releaseLock(lockKey) { return this.#lock(this.#resolve(), 'releaseLock', lockKey); }

	// Emit an ephemeral reaction (an emote token at an optional point). Rides the
	// dedicated reactions stream, never the roster, so it is a one-off event.
	react(token, at) { return this.#reaction(this.#resolve(), token, at); }

	// Release this view's streams now, whoever else holds the view, and stay
	// inert: no later reader subscribes again and the send methods become
	// no-ops, so a destroyed room never publishes onto a roster it has left.
	destroy() {
		this.#destroyed = true;
		this.#pinned = false;
		if (this.#followRoot) {
			this.#followRoot();
			this.#followRoot = null;
		}
		this.#stop();
	}
}
