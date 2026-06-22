// @ts-check

/**
 * A stable per-room key for the lobby Map: the single room arg (a gameId) when
 * the room takes exactly one, the joined args when it takes several, else the
 * wire topic. Each rendered value keeps the raw `args` so an app addresses a
 * room however it declared it.
 * @param {{ topic?: string, args?: any[] }} e
 * @returns {string}
 */
function _roomKey(e) {
	const args = Array.isArray(e.args) ? e.args : [];
	if (args.length === 1) return String(args[0]);
	if (args.length > 1) return args.map(String).join(':');
	return /** @type {string} */ (e.topic);
}

/**
 * Normalize a wire entry to the public `{ args, count, meta }` shape.
 * @param {{ args?: any[], count?: number, meta?: any }} e
 */
function _roomEntry(e) {
	return {
		args: Array.isArray(e.args) ? e.args : [],
		count: typeof e.count === 'number' ? e.count : 0,
		meta: e.meta
	};
}

/**
 * Project the enumeration stream's flat entry list into a Map keyed by room
 * args. The server keys the stream by wire topic (unique), so a malformed entry
 * with neither a topic nor args is dropped rather than collapsing onto a shared
 * key.
 * @param {Array<{ topic?: string, args?: any[], count?: number, meta?: any }>} entries
 */
function _roomsMap(entries) {
	const m = new Map();
	for (const e of entries) {
		if (e && (e.topic !== undefined || Array.isArray(e.args))) m.set(_roomKey(e), _roomEntry(e));
	}
	return m;
}

/**
 * Live view of a `live.room` export's ACTIVE rooms - the backing for a lobby
 * browser. Subscribes to the export's enumeration stream and projects its
 * entries into a reactive Map keyed by the room's identifying args, each value
 * `{ args, count, meta }`. The server feeds the stream as topics gain their
 * first subscriber (a room opens), gain/lose subscribers (the live count moves),
 * and lose their last (the room closes), so the view always reflects the open
 * rooms and their current player counts.
 *
 * Mirrors `MultiplayerRoom`: subscribe in the constructor into `$state`, expose
 * a `$derived` view, collect unsubscribes for `destroy()`. Requires Svelte 5
 * (the view is a rune class).
 */
export class RoomsList {
	#entries = $state([]);
	#status = $state('idle');
	#list;
	#unsubs = [];

	/**
	 * @param {{
	 *   stream: { subscribe: (fn: (v: any) => void) => () => void },
	 *   status?: { subscribe: (fn: (v: string) => void) => () => void },
	 *   list?: (...args: any[]) => Promise<any>
	 * }} deps - `stream` is the export's enumeration stream (a crud store keyed by
	 *   topic), `status` the optional connection-status passthrough, `list` the
	 *   one-shot snapshot RPC.
	 */
	constructor(deps) {
		this.#list = typeof deps.list === 'function' ? deps.list : null;
		this.#unsubs.push(deps.stream.subscribe((v) => { this.#entries = Array.isArray(v) ? v : []; }));
		if (deps.status) this.#unsubs.push(deps.status.subscribe((v) => { this.#status = v; }));
	}

	/** Reactive `Map<roomKey, { args, count, meta }>` of the active rooms. */
	#roomsDerived = $derived(_roomsMap(this.#entries));
	get rooms() { return this.#roomsDerived; }

	/** The connection-status passthrough. */
	get status() { return this.#status; }

	/**
	 * One-shot snapshot of the active rooms WITHOUT opening a live subscription -
	 * the same `{ args, count, meta }` entries `rooms` holds. Resolves to an
	 * array (empty when enumeration is unavailable).
	 * @returns {Promise<Array<{ args: any[], count: number, meta: any }>>}
	 */
	async list() {
		if (this.#list === null) return [];
		const snap = await this.#list();
		return Array.isArray(snap) ? snap.map(_roomEntry) : [];
	}

	/** Stop the live subscription. Call from the component's cleanup. */
	destroy() {
		for (const off of this.#unsubs) off();
		this.#unsubs = [];
	}
}
