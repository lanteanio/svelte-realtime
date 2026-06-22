/** One active room in a lobby view. */
export interface RoomEntry<Meta = any> {
	/** The room-identifying args (e.g. `[gameId]`), as the topic function received them. */
	args: any[];
	/** Live subscriber count (connections subscribed to the room on this instance). */
	count: number;
	/** The value the export's `meta(args)` returned when the room opened, or `undefined`. */
	meta: Meta;
}

/**
 * Live view of a `live.room` export's ACTIVE rooms - the backing for a lobby
 * browser. Subscribe through the generated `game.rooms()`; reads through Svelte 5
 * runes (the view is a rune class, so it requires Svelte 5). The server keeps it
 * current as rooms open (first subscriber), fill/empty (count), and close (last
 * subscriber leaves).
 */
export class RoomsList<Meta = any> {
	constructor(deps: {
		stream: { subscribe: (fn: (v: any) => void) => () => void };
		status?: { subscribe: (fn: (v: string) => void) => () => void };
		list?: (...args: any[]) => Promise<any>;
	});
	/** Reactive map of active rooms, keyed by room args (the single arg when there is one, else joined). */
	readonly rooms: Map<string, RoomEntry<Meta>>;
	/** The connection-status passthrough. */
	readonly status: string;
	/** One-shot snapshot of the active rooms without opening a live subscription. */
	list(): Promise<Array<RoomEntry<Meta>>>;
	/** Stop the live subscription. Call from the component's cleanup. */
	destroy(): void;
}
