// @ts-check
// A monotonic clock derived from the wall clock, for server-rewind lag compensation.
//
// The lag-comp ring keys its records on time, and its rewind read assumes those
// timestamps never move backward (it scans for a bracketing pair and linearly
// interpolates between them). A server wall-clock STEP - an NTP correction or a VM
// live-migration that resumes with an earlier clock - feeds the ring a timestamp
// older than the newest it already holds. The forward-only discontinuity guard does
// not catch it (it watches for a forward GAP, not a backstep), so the bracket search
// degrades and a rewind spanning the step resolves against a garbage interpolation.
//
// This clock maps each wall reading onto a non-decreasing axis: forward (or equal)
// progress passes through 1:1, so in normal operation it IS the wall clock - the
// offset is zero and the ring behaves byte-identically - while a backstep is absorbed
// by holding the cursor, so the ring axis only ever advances. The accumulated offset
// (monotonic - wall) is the single server-side value the shoot handler adds to a
// client's wall-axis render-time to land it on the ring axis.
//
// PURE with respect to time: the caller passes each wall reading (from the runtime
// seam's wallEpoch), so this imports no clock and runs identically under the
// deterministic simulation harness. It is stateful and monotonic in CALL order:
// successive calls never return a smaller value.

/**
 * Create a monotonic clock. One per lag-compensation topic, advanced by both the
 * tick (recording the ring) and the shot handler (the rewind baseline), so the two
 * always read the same axis.
 */
export function createMonotonicClock() {
	let cursor = -Infinity; // the monotonic value; -Infinity = never read
	let lastWall = -Infinity;
	return {
		/**
		 * Map a wall reading onto the monotonic axis. A forward or equal wall passes
		 * through (advancing the cursor by the same delta); a backward wall is clamped
		 * to the held cursor. Never returns a smaller value than a prior call.
		 * @param {number} wall a wall-clock ms reading (from wallEpoch)
		 * @returns {number} the monotonic-axis value
		 */
		mono(wall) {
			if (cursor === -Infinity) {
				cursor = wall;
				lastWall = wall;
				return cursor;
			}
			const delta = wall - lastWall;
			if (delta > 0) cursor += delta; // forward progress passes through 1:1
			// delta <= 0 (a backstep, or no movement): hold the cursor - the axis never decreases.
			lastWall = wall;
			return cursor;
		},

		/**
		 * The accumulated wall->monotonic offset at the last reading (monotonic - wall),
		 * i.e. the total backstep absorbed. Zero in normal operation. The shot handler
		 * adds this to a client's wall-axis render-time to map it onto the ring axis.
		 * Reads without advancing.
		 * @returns {number}
		 */
		offset() {
			return cursor === -Infinity ? 0 : cursor - lastWall;
		},

		/** Reset to the never-read state (topic teardown / test isolation). */
		reset() {
			cursor = -Infinity;
			lastWall = -Infinity;
		}
	};
}
