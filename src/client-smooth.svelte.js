// @ts-check
import { _setSmoothDegraded } from './client.js';
import { _devtoolsSmoothRegister } from './client/devtools-instrument.js';

/**
 * The adapter tags each remote frame state with its render freshness under this
 * Symbol key - `'live'` (position covered by real samples), `'coasting'`
 * (dead-reckoned within the extrapolation cap), or `'stale'` (frozen past it).
 * `Symbol.for` so a duplicated adapter module instance still resolves the one
 * key; reconstructed here rather than imported to keep this rune free of an
 * adapter import. Re-exported so a renderer can read `state[SMOOTH_FRESHNESS]`
 * off a `remote` entry directly (or use {@link SmoothEntity#freshness}).
 */
export const SMOOTH_FRESHNESS = Symbol.for('svelte-adapter-uws.smooth.freshness');

/**
 * Reactive view over one smoothed entity channel.
 *
 * The channel (constructed by the generated `smooth(...)` factory with the
 * app's shared `apply` and the generated send paths) runs prediction for the
 * local entity and render-in-the-past interpolation for remote entities on
 * its own frame loop; this class is the thin rune surface a component reads:
 * `local` is the rendered local state (instant input response, server
 * reconciled), `remote` maps entity keys to interpolated remote states, both
 * refreshed at display rate while anything moves and at rest otherwise.
 *
 * `command(cmd)` submits one input sample: applied locally on the same
 * frame, transmitted on the next flush, corrected by the server's
 * acknowledgement when they disagree - the server is always the authority.
 * `now()` is the estimated server clock, the right stamp for compensated
 * action arguments so the whole view runs on one time axis.
 *
 * Two failure surfaces feed the shared `health` store (both read 'degraded'
 * until recovery): `overflowed` (the un-acked command window overflowed - the
 * server stopped acknowledging the local entity) and `stalled` (no inbound
 * authority frame past the channel's stall window - the remote world went quiet
 * on a still-open socket). Per remote entity, `freshness(key)` reports whether
 * its rendered position is live, coasting, or stale.
 *
 * Teardown is explicit: `destroy()` stops the frame loop and releases the
 * channel's subscriptions - call it from the component's cleanup.
 */
export class SmoothEntity {
	#channel;
	// local and remote hold RAW state: the channel replaces both wholesale on
	// every frame (it never mutates them in place), so reassignment is the
	// only signal a consumer needs - and a deep $state proxy here would be
	// actively harmful. Reading a nested object through the proxy returns a
	// fresh proxy wrapper, which breaks any app that compares state internals
	// by reference (a frozen record looked up in an identity-keyed Map stops
	// matching), and lazily proxying a large entity state on the render path
	// costs allocations every frame for reactivity nothing consumes.
	#local = $state.raw();
	#remote = $state.raw(new Map());
	#status = $state('idle');
	#overflowed = $state(false);
	#stalled = $state(false);
	#unsubs = [];
	#healthFlagged = false;
	#eventHandlers = new Set();
	#reportCenter;
	#lastCenterX;
	#lastCenterY;
	#pendingCenterResend = false;

	/**
	 * @param {any} channel - a smooth channel (the adapter's
	 *   `createSmoothChannel` result); the generated factory constructs it.
	 * @param {{ subscribe: (fn: (v: string) => void) => () => void }} [status]
	 *   the connection-status store the view mirrors.
	 * @param {(center: { x: number, y: number } | null) => void} [reportCenter]
	 *   sends an area-of-interest center to the server (the generated factory
	 *   wires it to the topic's `smooth-center` RPC); absent on a topic without
	 *   `interest`, where `reportCenter`/`clearCenter` are inert.
	 */
	constructor(channel, status, reportCenter) {
		this.#channel = channel;
		this.#reportCenter = typeof reportCenter === 'function' ? reportCenter : null;
		this.#local = channel.predicted;
		channel.onFrame((local, remote) => {
			this.#local = local;
			this.#remote = remote;
			// Re-establish a reported area-of-interest center after a (re)connect: the
			// server resets per-topic interest state when the prior connection closed,
			// so a free-cam center set once would otherwise be lost (and the client
			// de-dupe would mask an identical re-report). Done on the first frame after
			// the (re)connect - frame delivery means the resync has landed, so the
			// re-report reaches a live record rather than racing it.
			if (this.#pendingCenterResend && this.#reportCenter !== null && this.#lastCenterX !== undefined) {
				this.#pendingCenterResend = false;
				this.#reportCenter({ x: this.#lastCenterX, y: this.#lastCenterY });
			}
		});
		channel.onOverflow((overflowed) => {
			this.#overflowed = overflowed;
			this.#updateHealth();
		});
		// Frame-arrival stall (adapter next.59+): the remote world went quiet on a
		// still-open socket, which overflow never sees (that watches the local
		// command window). Guarded so an older adapter without onStall degrades to
		// stalled:false rather than throwing.
		if (typeof channel.onStall === 'function') {
			channel.onStall((stalled) => {
				this.#stalled = stalled;
				this.#updateHealth();
			});
		}
		// The channel delivers events to a single consumer; this view owns that
		// consumer and fans out to its subscribers. Snapshot per fire so a
		// handler that (un)subscribes mid-dispatch does not perturb it.
		channel.onEvent((e) => {
			const handlers = [...this.#eventHandlers];
			for (let i = 0; i < handlers.length; i++) handlers[i](e);
		});
		if (status) {
			this.#unsubs.push(status.subscribe((s) => {
				// A transition INTO 'open' from a fresh (re)connect means the server
				// dropped the prior connection's per-topic interest state, so a center
				// set once must be re-sent (flagged here, consumed on the next frame).
				// The adapter status store emits 'open', never 'connected' (the earlier
				// vocabulary was a dead branch that never fired). A 'suspended' -> 'open'
				// refocus is excluded: the socket survived, so the server never reset
				// interest (mirrors the adapter's soft resume) - re-sending would be a
				// redundant RPC on every tab switch.
				if (
					s === 'open' &&
					this.#status !== 'open' &&
					this.#status !== 'suspended' &&
					this.#lastCenterX !== undefined
				) {
					this.#pendingCenterResend = true;
				}
				this.#status = s;
			}));
		}
		// Expose this channel's telemetry to the devtools "smooth" tab (dev only -
		// the register is a no-op in production). The accessor optional-chains
		// `stats()` so an older adapter degrades to "telemetry unavailable" rather
		// than throwing. The unregister rides #unsubs, so destroy() drops it before
		// tearing the channel down.
		this.#unsubs.push(_devtoolsSmoothRegister(() => this.#channel.stats?.()));
	}

	/** Fold overflow OR stall into the shared degraded-health flag, transitioning
	 * `_setSmoothDegraded` only on a change (both are health inputs). */
	#updateHealth() {
		const degraded = this.#overflowed || this.#stalled;
		if (degraded !== this.#healthFlagged) {
			this.#healthFlagged = degraded;
			_setSmoothDegraded(degraded);
		}
	}

	/** The rendered local state: predicted, with corrections eased in. */
	get local() {
		return this.#local;
	}

	/** Remote entities, keyed by entity key, positions interpolated. */
	get remote() {
		return this.#remote;
	}

	/**
	 * The render freshness of remote entity `key` this frame: `'live'`,
	 * `'coasting'` (dead-reckoned within the extrapolation cap), or `'stale'`
	 * (frozen on stale data). `undefined` for an absent or non-positional entity.
	 * The same tag rides each `remote` state under {@link SMOOTH_FRESHNESS}.
	 * @param {string} key
	 * @returns {'live' | 'coasting' | 'stale' | undefined}
	 */
	freshness(key) {
		const s = this.#remote.get(key);
		return s == null ? undefined : s[SMOOTH_FRESHNESS];
	}

	/** The connection status passthrough. */
	get status() {
		return this.#status;
	}

	/** True while prediction is killed pending recovery. */
	get overflowed() {
		return this.#overflowed;
	}

	/** True while the remote world is stalled: no inbound authority frame past the
	 * channel's stall window while remote entities are tracked (a blackout on a
	 * still-open socket). Also folds into the shared `health` store as 'degraded',
	 * alongside `overflowed`. */
	get stalled() {
		return this.#stalled;
	}

	/** The caller's own entity key, once the server announced it. */
	get self() {
		return this.#channel.self;
	}

	/**
	 * Submit one command: instant locally, authoritative on the server.
	 * @param {any} cmd
	 * @returns {number} the command id
	 */
	command(cmd) {
		return this.#channel.command(cmd);
	}

	/** The estimated server wall-clock time - the stamp for compensated
	 * action arguments. */
	now() {
		return this.#channel.now();
	}

	/** Re-request the authoritative catalog. */
	resync() {
		this.#channel.resync();
	}

	/**
	 * Fire a shot: a fire-and-forget, non-predicted command the server resolves
	 * against the rewound world (lag compensation). Unlike `command`, it does not
	 * enter the prediction ring - a shot owns no entity state to predict - and its
	 * outcome arrives as a discrete `onEvent` (a hit), not a reconciliation. Inert
	 * on a topic declared without `hitTest`.
	 * @param {any} cmd
	 */
	shoot(cmd) {
		this.#channel.shoot(cmd);
	}

	/**
	 * Report this view's area-of-interest center to the server - the point its
	 * culling should be measured from when the camera is not the player's own
	 * entity (a spectator, a free-cam, a zoomed-out overview). Overrides the
	 * server's own-entity default until `clearCenter()`. Call it when the camera
	 * moves, not every frame; an unchanged center is dropped. Inert on a topic
	 * declared without `interest`.
	 * @param {number} x @param {number} y
	 */
	reportCenter(x, y) {
		if (this.#reportCenter === null) return;
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
		if (x === this.#lastCenterX && y === this.#lastCenterY) return;
		this.#lastCenterX = x;
		this.#lastCenterY = y;
		this.#reportCenter({ x, y });
	}

	/** Drop a reported center, reverting culling to the server's own-entity default. */
	clearCenter() {
		if (this.#reportCenter === null) return;
		if (this.#lastCenterX === undefined && this.#lastCenterY === undefined) return; // already cleared
		this.#lastCenterX = undefined;
		this.#lastCenterY = undefined;
		this.#reportCenter(null);
	}

	/**
	 * Subscribe to the entity's discrete one-shot events (`ctx.emitEvent` in the
	 * shared `apply`). A handler fires with `origin:'local'` the frame the
	 * owner's command was issued (the optimistic copy) and `origin:'server'` for
	 * the authoritative broadcast - other authors' events, and this owner's own
	 * `toAuthor`/`global` confirmations, which share the correlation key with the
	 * local copy. Returns an unsubscribe. Events are not buffered: subscribe
	 * before the first command to catch its fires.
	 * @param {(event: { type: string, key: string, data: any, id: number, origin: 'local' | 'server' }) => void} handler
	 * @returns {() => void}
	 */
	onEvent(handler) {
		this.#eventHandlers.add(handler);
		return () => this.#eventHandlers.delete(handler);
	}

	destroy() {
		for (const off of this.#unsubs) off();
		this.#unsubs = [];
		if (this.#healthFlagged) {
			this.#healthFlagged = false;
			_setSmoothDegraded(false);
		}
		this.#eventHandlers.clear();
		this.#channel.destroy();
	}
}
