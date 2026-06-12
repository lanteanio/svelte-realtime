import type { Readable } from 'svelte/store';

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
	constructor(channel: any, status?: Readable<string>);
	/** The rendered local state: predicted, with corrections eased in. */
	readonly local: State;
	/** Remote entities, keyed by entity key, positions interpolated. */
	readonly remote: Map<string, State>;
	/** The connection status passthrough. */
	readonly status: string;
	/** True while prediction is killed pending recovery (also folds into
	 * the shared `health` store as 'degraded'). */
	readonly overflowed: boolean;
	/** The caller's own entity key, once the server announced it. */
	readonly self: string | null;
	/** Submit one command: instant locally, authoritative on the server.
	 * Returns the command id. */
	command(cmd: Command): number;
	/** The estimated server wall-clock time - the stamp for compensated
	 * action arguments. */
	now(): number;
	/** Re-request the authoritative catalog. */
	resync(): void;
	/** Stop the frame loop and release the channel. */
	destroy(): void;
}
