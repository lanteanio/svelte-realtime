// @ts-check
import { _setSmoothDegraded } from './client.js';

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
 * Prediction loss (the server stops acknowledging long enough that the
 * un-acked command window overflows) surfaces twice: `overflowed` on this
 * view, and the shared `health` store reads 'degraded' until recovery.
 *
 * Teardown is explicit: `destroy()` stops the frame loop and releases the
 * channel's subscriptions - call it from the component's cleanup.
 */
export class SmoothEntity {
	#channel;
	#local = $state();
	#remote = $state(new Map());
	#status = $state('idle');
	#overflowed = $state(false);
	#unsubs = [];
	#healthFlagged = false;

	/**
	 * @param {any} channel - a smooth channel (the adapter's
	 *   `createSmoothChannel` result); the generated factory constructs it.
	 * @param {{ subscribe: (fn: (v: string) => void) => () => void }} [status]
	 *   the connection-status store the view mirrors.
	 */
	constructor(channel, status) {
		this.#channel = channel;
		this.#local = channel.predicted;
		channel.onFrame((local, remote) => {
			this.#local = local;
			this.#remote = remote;
		});
		channel.onOverflow((overflowed) => {
			this.#overflowed = overflowed;
			if (overflowed !== this.#healthFlagged) {
				this.#healthFlagged = overflowed;
				_setSmoothDegraded(overflowed);
			}
		});
		if (status) {
			this.#unsubs.push(status.subscribe((s) => {
				this.#status = s;
			}));
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

	/** The connection status passthrough. */
	get status() {
		return this.#status;
	}

	/** True while prediction is killed pending recovery. */
	get overflowed() {
		return this.#overflowed;
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

	destroy() {
		for (const off of this.#unsubs) off();
		this.#unsubs = [];
		if (this.#healthFlagged) {
			this.#healthFlagged = false;
			_setSmoothDegraded(false);
		}
		this.#channel.destroy();
	}
}
