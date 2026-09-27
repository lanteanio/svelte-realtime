import type { Readable } from 'svelte/store';

/** A roster entry: a user key plus the presence payload and a stamped color. */
export interface RosterEntry {
	key: string;
	color: string;
	[field: string]: any;
}

/** A cursor entry: a user key, position fields, and a stamped color. */
export interface CursorEntry {
	key: string;
	color: string;
	/** Id of the connection that published the sample; reserved, set by the server. */
	_p?: string;
	/** That connection's publish sequence number for the sample; reserved, set by the server. */
	_n?: number;
	[field: string]: any;
}

/** A user key, or a getter for one (read wherever `me` is, so it can come from props). */
export type LocalKey = string | null | undefined | (() => string | null | undefined);

/**
 * A reactive holder for the local user's key. The generated `live.multiplayer()`
 * namespace owns one; the app sets it once via `namespace.identify(key)` and the
 * `MultiplayerRoom` reads it through `me`. Until set it reads `null`.
 */
export interface LocalKeySource {
	readonly value: string | null;
	set(next: LocalKey): void;
}

/**
 * Create a reactive local-key holder. The generated namespace constructs one
 * per multiplayer export; an app rarely calls this directly.
 */
export function localKeySource(initial?: LocalKey): LocalKeySource;

/** Dependencies the generated namespace injects when it constructs a room. */
export interface MultiplayerRoomDeps {
	/** The local user's key, a reactive holder, or null/undefined when unknown. */
	me?: string | LocalKeySource | null;
	/**
	 * The room args the view was created with, used with `bind`. A single
	 * function is a getter the room follows: when it names another room, the
	 * room leaves the old one and joins the new one. It returns one arg, an
	 * array of args, or null / undefined for no room.
	 */
	args?: any[];
	/**
	 * Build the per-room deps (streams and send callbacks) for a list of room
	 * args. When given, it supplies the deps below that depend on the room.
	 */
	bind?: (args: any[]) => Partial<MultiplayerRoomDeps>;
	/** Presence sub-stream (the per-room factory store). Required unless `bind` supplies it. */
	presence?: Readable<any[]>;
	/** Cursor sub-stream (the per-room factory store). Required unless `bind` supplies it. */
	cursors?: Readable<any[]>;
	/** Connection-status store. */
	status: Readable<string>;
	/** The room's data stream. The room holds it for its lifetime, which is what makes the local user a member others see (and a candidate for ownership); its value is not read. Omitted for a view that only observes. */
	membership?: Readable<any>;
	/** Reactions sub-stream (the bounded ring of recent emotes), when enabled. */
	reactions?: Readable<any[]>;
	/** Owner sub-stream (the room's `{ key, reason }` owner value), when enabled. */
	owner?: Readable<{ key: string | null, reason: string | null } | undefined>;
	/** Outbound cursor-move send callback. */
	move?: (...args: any[]) => any;
	/** Outbound viewport-report send callback. Falls back to `move`. */
	reportViewport?: (...args: any[]) => any;
	/** Outbound presence-field send callback for typing toggles. */
	setTyping?: (...args: any[]) => any;
	/** Outbound presence-field send callback for selection ranges. */
	setSelection?: (...args: any[]) => any;
	/** Selection mode: `'crdt'` (live.doc-anchored) or `'offset'` (raw). */
	selections?: 'offset' | 'crdt';
	/** Outbound presence-field send callback for advisory lock acquisition. */
	acquireLock?: (...args: any[]) => any;
	/** Outbound presence-field send callback for advisory lock release. */
	releaseLock?: (...args: any[]) => any;
	/** Outbound reaction send callback. */
	react?: (...args: any[]) => any;
}

/**
 * The read surface of a `live.multiplayer()` room: what `namespace.watch(...)`
 * returns, and what `namespace.room(...)` extends with the send methods. The
 * views are reactive: they refresh when the underlying stores push.
 *
 * - `others`: the presence roster, deduped by user key (latest wins), each
 *   entry stamped with a deterministic color, excluding the local user when
 *   `me` is known. When `me` is unknown it is the full deduped roster.
 * - `cursors`: deduped by user key (latest wins) and colored. Self is not
 *   excluded so the local user can render its own cursor.
 * - `me`: the local user's key, or `null` when the app never supplied one.
 * - `status`: the connection-status passthrough.
 *
 * The `typing` / `locks` / `selections` views are reactive projections of the
 * presence roster; `reactions` is the bounded ring of recent ephemeral emotes.
 */
export interface MultiplayerView {
	/** The presence roster: deduped, colored, self-excluded when `me` is known. */
	readonly others: RosterEntry[];
	/** The cursor roster: deduped and colored (self not excluded). */
	readonly cursors: CursorEntry[];
	/** The local user's key, or `null` when unknown. */
	readonly me: string | null;
	/** The connection status. */
	readonly status: string;
	/** The user keys of remote collaborators currently flagged as typing. */
	readonly typing: string[];
	/** Advisory lock holders keyed by lock key: `{ lockKey: holderUserKey }`. */
	readonly locks: Record<string, any>;
	/**
	 * Remote selection ranges keyed by user (self excluded). In `offset` mode each
	 * value is the raw payload the holder sent. In `crdt` mode each value is resolved
	 * against the bound live.doc to `{ field, start, end }` current offsets and re-
	 * resolves reactively as the document is edited; an entry that cannot resolve is
	 * omitted.
	 */
	readonly selections: Record<string, any>;
	/** The bounded ring of recent reactions. */
	readonly reactions: any[];
	/** The room's current owner key, or `null` while unclaimed / vacated / not yet loaded. */
	readonly owner: string | null;
	/** Whether the local user holds the owner role. Needs `identify(key)`; reads `false` when `me` is unknown. */
	readonly isOwner: boolean;
	/**
	 * Bind this room's live.doc so `selections: 'crdt'` selections anchor to and
	 * resolve against the shared document (they survive concurrent edits). Call it
	 * with the `DocHandle` for the document the selections index into, and again with
	 * the next document when a room that follows a getter moves. A no-op for an
	 * offset-mode room. Returns `this` for chaining.
	 */
	bindDoc(doc: { text(name?: string): any }): this;
	/**
	 * Release the room's subscriptions now and keep it released: no later
	 * reader subscribes it again, and the send methods stop sending. The user
	 * leaves a joined room once nothing else on the page holds its data stream
	 * (others see it after the presence grace window). Not needed for a
	 * room built in a component's script, which is released when the component
	 * unmounts; call it for a room built outside Svelte's reactivity. Safe to
	 * call twice.
	 */
	destroy(): void;
}

export interface MultiplayerRoom extends MultiplayerView {}

/**
 * The send methods of a `MultiplayerRoom`, bound to one room: what
 * `room.here()` returns.
 */
export type MultiplayerSend = Pick<MultiplayerRoom, 'move' | 'reportViewport' | 'react' | 'setTyping' | 'acquireLock' | 'releaseLock' | 'setSelection'>;

/**
 * A joined `live.multiplayer()` room: the `MultiplayerView` surface plus the
 * methods that publish as the local user. Built with a `membership` dep, it
 * holds the room's data stream along with its other streams, which puts the
 * local user on everyone else's roster: for the life of the component or
 * `$effect` that built it, while anything reactive reads a view, or, when
 * built outside Svelte's reactivity, until `destroy()`. Built with an args
 * getter, it follows the getter from room to room, and is in no room while
 * the getter returns null or undefined.
 *
 * A send made in an effect goes to the room the getter names and ties the
 * effect to the room (it re-runs when the room changes); any other send goes
 * to the room the view is in at that moment.
 */
export class MultiplayerRoom {
	constructor(deps: MultiplayerRoomDeps);
	/**
	 * The send methods bound to the room the view names now. Take them in an
	 * effect and use them in its cleanup, which then reaches that room whenever
	 * Svelte runs it (on a re-run, on unmount, after an outro), even when the
	 * view has moved on. Taking them in an effect ties the effect to the room;
	 * taken outside one (an event handler, `onMount`, `untrack`) they are bound
	 * to the room the view is in at that moment, and nothing follows the getter.
	 */
	here(): MultiplayerSend;
	/** Forward a cursor move to the injected send callback. */
	move(...args: any[]): any;
	/** Forward a viewport report to the injected send callback. */
	reportViewport(...args: any[]): any;
	/** Emit an ephemeral reaction (a token at an optional point). */
	react(token: any, at?: any): any;
	/** Toggle the local typing flag, published onto the presence roster. */
	setTyping(on: boolean): any;
	/** Claim an advisory lock on a key (collaborative awareness, not exclusion). */
	acquireLock(lockKey: string): any;
	/** Release an advisory lock on a key. */
	releaseLock(lockKey: string): any;
	/**
	 * Publish the local selection range; pass `null` to clear it. In `offset` mode the
	 * value is sent verbatim (e.g. `{ start, end, nodePath }`). In `crdt` mode pass
	 * `{ field, start, end }` against a bound live.doc text container; the range is
	 * encoded as a position anchor that survives concurrent edits. Without a bound doc
	 * or a `field`, a crdt send is dropped with a one-shot dev warning.
	 */
	setSelection(selection: any): any;
}
