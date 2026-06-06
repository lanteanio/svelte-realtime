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
	/** Outbound cursor-move send callback. */
	move?: (...args: any[]) => any;
	/** Outbound viewport-report send callback. Falls back to `move`. */
	reportViewport?: (...args: any[]) => any;
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
 * The `typing` / `locks` / `selections` / `reactions` field surfaces and their
 * methods are reserved and inert.
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
	/** Reserved field surface. Inert. */
	get typing(): any[];
	/** Reserved field surface. Inert. */
	get locks(): Record<string, any>;
	/** Reserved field surface. Inert. */
	get selections(): Record<string, any>;
	/** Reserved field surface. Inert. */
	get reactions(): any[];
	/** Forward a cursor move to the injected send callback. */
	move(...args: any[]): any;
	/** Forward a viewport report to the injected send callback. */
	reportViewport(...args: any[]): any;
	/** Reserved no-op. */
	react(...args: any[]): void;
	/** Reserved no-op. */
	setTyping(...args: any[]): void;
	/** Reserved no-op. */
	acquireLock(...args: any[]): void;
	/** Reserved no-op. */
	releaseLock(...args: any[]): void;
	/** Reserved no-op. */
	setSelection(...args: any[]): void;
	/** Unsubscribe from the injected stores. Call when the room unmounts. */
	destroy(): void;
}
