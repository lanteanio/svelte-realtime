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
	[field: string]: any;
}

/**
 * A reactive holder for the local user's key. The generated `live.multiplayer()`
 * namespace owns one; the app sets it once via `namespace.identify(key)` and the
 * `MultiplayerRoom` reads it through `me`. Until set it reads `null`.
 */
export interface LocalKeySource {
	readonly value: string | null;
	set(next: string | null | undefined): void;
}

/**
 * Create a reactive local-key holder. The generated namespace constructs one
 * per multiplayer export; an app rarely calls this directly.
 */
export function localKeySource(initial?: string | null): LocalKeySource;

/** Dependencies the generated namespace injects when it constructs a room. */
export interface MultiplayerRoomDeps {
	/** The local user's key, a reactive holder, or null/undefined when unknown. */
	me?: string | LocalKeySource | null;
	/** Presence sub-stream (the per-room factory store). */
	presence: Readable<any[]>;
	/** Cursor sub-stream (the per-room factory store). */
	cursors: Readable<any[]>;
	/** Connection-status store. */
	status: Readable<string>;
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
 * Live roster aggregation for a `live.multiplayer()` room. Composes the
 * generated presence / cursor / status stores into the public surface an app
 * renders. The aggregated views are reactive: they refresh when the underlying
 * stores push.
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
 * presence roster, driven by the field-send methods; `reactions` is the bounded
 * ring of recent ephemeral emotes.
 */
export class MultiplayerRoom {
	constructor(deps: MultiplayerRoomDeps);
	/** The presence roster: deduped, colored, self-excluded when `me` is known. */
	get others(): RosterEntry[];
	/** The cursor roster: deduped and colored (self not excluded). */
	get cursors(): CursorEntry[];
	/** The local user's key, or `null` when unknown. */
	get me(): string | null;
	/** The connection status. */
	get status(): string;
	/** The user keys of remote collaborators currently flagged as typing. */
	get typing(): string[];
	/** Advisory lock holders keyed by lock key: `{ lockKey: holderUserKey }`. */
	get locks(): Record<string, any>;
	/**
	 * Remote selection ranges keyed by user (self excluded). In `offset` mode each
	 * value is the raw payload the holder sent. In `crdt` mode each value is resolved
	 * against the bound live.doc to `{ field, start, end }` current offsets and re-
	 * resolves reactively as the document is edited; an entry that cannot resolve is
	 * omitted.
	 */
	get selections(): Record<string, any>;
	/** The bounded ring of recent reactions. */
	get reactions(): any[];
	/** The room's current owner key, or `null` while unclaimed / vacated / not yet loaded. */
	get owner(): string | null;
	/** Whether the local user holds the owner role. Needs `identify(key)`; reads `false` when `me` is unknown. */
	get isOwner(): boolean;
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
	 * Bind this room's live.doc so `selections: 'crdt'` selections anchor to and
	 * resolve against the shared document (they survive concurrent edits). Call once
	 * with the `DocHandle` for the same document the selections index into. A no-op for
	 * an offset-mode room. Returns `this` for chaining.
	 */
	bindDoc(doc: { text(name?: string): any }): this;
	/**
	 * Publish the local selection range; pass `null` to clear it. In `offset` mode the
	 * value is sent verbatim (e.g. `{ start, end, nodePath }`). In `crdt` mode pass
	 * `{ field, start, end }` against a bound live.doc text container; the range is
	 * encoded as a position anchor that survives concurrent edits. Without a bound doc
	 * or a `field`, a crdt send is dropped with a one-shot dev warning.
	 */
	setSelection(selection: any): any;
	/** Unsubscribe from the injected stores. Call when the room unmounts. */
	destroy(): void;
}
