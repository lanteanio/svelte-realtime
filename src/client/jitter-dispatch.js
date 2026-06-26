// @ts-check
//
// Client-side de-herd dispatch (the receive half of `publish(..., { jitterMs })`).
// A live frame stamped with a jitter window `j` is handed to the stream after a
// LOCAL random delay in [0, j), so N clients ramp their reaction (retry / refetch /
// re-render) instead of all firing at t+0. The random offset is rolled PER CLIENT -
// the wire carries the window, not a server-rolled value - so the receivers
// genuinely spread rather than deferring in lockstep. FIFO-safe: while a deferral
// is pending, later frames are held behind it in arrival order so a deferred frame
// is never overtaken, and the hold queue is bounded so a flood cannot grow it
// without limit.

import { randomFloat, setTimer, clearTimer } from '../client-runtime.js';

/** Upper bound on the honored window, matching the server-side ceiling. */
const JITTER_MAX = 60000;
/** Bound on the hold-behind queue; an overflow flushes immediately instead. */
const QUEUE_CAP = 1024;

/**
 * Create a per-stream de-herd dispatcher. `apply` dispatches a frame to the stream
 * immediately; the returned `dispatch` defers it when it carries a `j` window.
 *
 * @param {(envelope: any) => void} apply
 * @returns {{ dispatch: (envelope: any) => void, clear: () => void }}
 */
export function createJitterDispatch(apply) {
	/** @type {any} */ let timer = null;
	/** @type {any[] | null} */ let queue = null;

	function flush() {
		// Clear the handle in case flush was triggered early (queue overflow) rather
		// than by the timer firing - a no-op clear on an already-fired handle.
		if (timer !== null) { clearTimer(timer); timer = null; }
		const q = queue;
		queue = null;
		if (q) for (let i = 0; i < q.length; i++) apply(q[i]);
	}

	/** @param {any} envelope */
	function dispatch(envelope) {
		if (timer !== null) {
			// A deferral is in flight: hold this frame behind it (FIFO) so a deferred
			// frame is never overtaken. Overflow -> stop holding: flush + dispatch now.
			if (/** @type {any[]} */ (queue).length >= QUEUE_CAP) { flush(); apply(envelope); return; }
			/** @type {any[]} */ (queue).push(envelope);
			return;
		}
		const j = envelope.j;
		if (typeof j === 'number' && j > 0) {
			const delay = randomFloat() * (j > JITTER_MAX ? JITTER_MAX : j);
			queue = [envelope];
			timer = setTimer(flush, delay);
		} else {
			apply(envelope);
		}
	}

	/** Drop a pending deferral (teardown / refetch): the held frames are stale. */
	function clear() {
		if (timer !== null) { clearTimer(timer); timer = null; }
		queue = null;
	}

	return { dispatch, clear };
}
