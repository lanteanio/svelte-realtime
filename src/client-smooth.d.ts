import type { Readable } from 'svelte/store';

/** One discrete event delivered to a {@link SmoothEntity.onEvent} handler. */
export interface SmoothEvent<Data = any> {
	/** The event type passed to `ctx.emitEvent(type, ...)`. */
	type: string;
	/** The correlation key: `<commandId>:<ordinal>` by default, or an explicit
	 * `opts.key`. The optimistic and authoritative copies of one event share it,
	 * so a handler that receives both can match them. */
	key: string;
	/** The payload passed to `ctx.emitEvent(type, data)`. */
	data: Data;
	/** The id of the command whose `apply` emitted the event. */
	id: number;
	/** `'local'` for the optimistic copy delivered when the command was issued;
	 * `'server'` for the authoritative broadcast. */
	origin: 'local' | 'server';
}

/**
 * The render freshness of a remote entity: `'live'` (position covered by real
 * samples), `'coasting'` (dead-reckoned past the newest sample, within the
 * extrapolation cap), or `'stale'` (extrapolation exhausted - frozen on stale
 * data). Read via {@link SmoothEntity.freshness} or off a `remote` state under
 * {@link SMOOTH_FRESHNESS}.
 */
export type SmoothFreshness = 'live' | 'coasting' | 'stale';

/**
 * Symbol key under which each remote frame state carries its {@link SmoothFreshness}.
 * A Symbol, so it never collides with an app field and stays invisible to JSON;
 * read `state[SMOOTH_FRESHNESS]` on a `remote` entry to dim or flag a coasted or
 * stalled entity. Absent on non-positional states.
 */
export const SMOOTH_FRESHNESS: unique symbol;

/**
 * Reactive view over one smoothed entity channel: instant local input
 * (predicted, server-reconciled) plus interpolated remote entities, read
 * through runes at display rate. Constructed by the generated `smooth(...)`
 * factory on a `live.smooth()` export; the app passes its shared `apply`
 * and starting state at the call site:
 *
 * ```svelte
 * <script>
 *   import { shape } from '$live/board';
 *   import { apply } from '$live/board.shared.js';
 *
 *   const view = shape.smooth(boardId, { apply, initial: { x: 0, y: 0 } });
 *   $effect(() => () => view.destroy());
 * </script>
 *
 * <Box x={view.local.x} y={view.local.y} />
 * {#each [...view.remote] as [key, s] (key)}
 *   <Box x={s.x} y={s.y} ghost />
 * {/each}
 * ```
 *
 * Requires Svelte 5 (the view is a rune class).
 */
export class SmoothEntity<State = any, Command = any> {
	constructor(channel: any, status?: Readable<string>, reportCenter?: (center: { x: number; y: number } | null) => void);
	/** The rendered local state: predicted, with corrections eased in. */
	readonly local: State;
	/** Remote entities, keyed by entity key, positions interpolated. Each
	 * positional state also carries its {@link SmoothFreshness} under the
	 * {@link SMOOTH_FRESHNESS} Symbol key. */
	readonly remote: Map<string, State>;
	/** The connection status passthrough: 'connecting' | 'open' | 'suspended' |
	 * 'disconnected' | 'failed' (idle before the first value). */
	readonly status: string;
	/** True while prediction is killed pending recovery (also folds into
	 * the shared `health` store as 'degraded'). */
	readonly overflowed: boolean;
	/** True while the remote world is stalled: no inbound authority frame past the
	 * channel's stall window while entities are tracked (a blackout on a still-open
	 * socket). Also folds into the shared `health` store as 'degraded'. */
	readonly stalled: boolean;
	/** The render freshness of remote entity `key` this frame, or `undefined` for
	 * an absent or non-positional entity. */
	freshness(key: string): SmoothFreshness | undefined;
	/** The caller's own entity key, once the server announced it. */
	readonly self: string | null;
	/** Submit one command: instant locally, authoritative on the server.
	 * Returns the command id. */
	command(cmd: Command): number;
	/** Fire a shot: a fire-and-forget, non-predicted command the server resolves
	 * against the rewound world (lag compensation on a `hitTest` topic). Unlike
	 * `command` it never enters the prediction ring - a shot owns no entity state -
	 * and its outcome arrives as a discrete `onEvent` (a hit), not a reconciliation.
	 * Inert on a topic declared without `hitTest`. */
	shoot(cmd: Command): void;
	/** The estimated server wall-clock time - the stamp for compensated
	 * action arguments. */
	now(): number;
	/** Re-request the authoritative catalog. */
	resync(): void;
	/** Report this view's area-of-interest center to the server (a spectator /
	 * free-cam whose view is not its own entity). Overrides the own-entity default
	 * until `clearCenter()`; an unchanged center is dropped. Inert on a topic
	 * declared without `interest`. */
	reportCenter(x: number, y: number): void;
	/** Drop a reported center, reverting culling to the own-entity default. */
	clearCenter(): void;
	/** Subscribe to the entity's discrete one-shot events (`ctx.emitEvent`):
	 * `origin:'local'` the frame the owner's command was issued, `origin:'server'`
	 * for the authoritative broadcast. Returns an unsubscribe. Events are not
	 * buffered - subscribe before the first command to catch its fires. */
	onEvent(handler: (event: SmoothEvent) => void): () => void;
	/** Stop the frame loop and release the channel. */
	destroy(): void;
}
