// @ts-check
// Per-connection latency tracker for server-rewind lag compensation.
//
// The server bounds how far back a shot may rewind to the latency it can MEASURE
// for that connection. The measurement must be tamper-resistant, and the only way
// to get that is to time a round trip the server fully controls: the server stamps
// an absolute `t` on every frame it sends (server-authored), the client echoes the
// latest `t` it has seen, and the server computes `roundTrip = now - ackT` - BOTH
// ends are server wall times the server itself produced/observed. The client only
// SELECTS which real, recent stamp to echo; it cannot fabricate a lower latency.
//
// This mirrors the QUIC RFC 9002 min_rtt insight - "network/scheduling jitter only
// ever ADDS to an honest one-way reading" - and applies it in BOTH directions:
//
//   - The MAXIMUM over recent samples is the favor-the-shooter reach: since delay
//     only adds, the recent max is the tightest UPPER bound on how far back this
//     honest player could legitimately need, so an honest player on a latency spike
//     or jittery link is never clamped short.
//   - The MINIMUM over recent samples is the un-inflatable-downward floor used as
//     the detection signal: a client cannot drive the min below physical reality,
//     only inflate it by genuine self-lag (which costs responsiveness and is the
//     lag-switch tell).
//
// Samples live in coarse time buckets (max/min taken over the last few), mirroring
// the client clock estimator's design, so the tracker follows drift instead of
// latching an ancient outlier. PURE with respect to time: every method takes the
// caller's wall reading, so it imports no clock and runs identically under the
// deterministic simulation harness. Fixed-size; nothing allocates after creation.

/**
 * @param {{ bucketMs?: number, buckets?: number }} [options]
 *   `bucketMs` x `buckets` is the sliding window the max/min are taken over
 *   (default 30s x 4, mirroring the client clock estimator).
 */
export function createRttTracker(options = {}) {
	const bucketMs = options.bucketMs === undefined ? 30000 : options.bucketMs;
	const bucketCount = options.buckets === undefined ? 4 : options.buckets;
	// Per-bucket max and min one-way uplink (ms). -Infinity / Infinity mark empty.
	const maxB = new Float64Array(bucketCount).fill(-Infinity);
	const minB = new Float64Array(bucketCount).fill(Infinity);
	let base = -1; // wall time the current bucket started, -1 = never
	let index = 0;

	/** Rotate buckets forward so `now` falls inside the current bucket. */
	function rotate(now) {
		if (base < 0) {
			base = now;
			return;
		}
		while (now - base >= bucketMs) {
			base += bucketMs;
			index = (index + 1) % bucketCount;
			maxB[index] = -Infinity;
			minB[index] = Infinity;
		}
	}

	return {
		/**
		 * Feed a one-way uplink sample (ms), measured server-side as
		 * `(now - ackT) / 2` where `ackT` is a server-authored stamp the client
		 * echoed. Cheap enough to call on every shot.
		 * @param {number} uplink one-way uplink estimate in ms
		 * @param {number} now wall ms at receipt (the rotation clock)
		 */
		sample(uplink, now) {
			if (typeof uplink !== 'number' || !Number.isFinite(uplink) || uplink < 0) return;
			if (typeof now !== 'number' || !Number.isFinite(now)) return;
			rotate(now);
			if (uplink > maxB[index]) maxB[index] = uplink;
			if (uplink < minB[index]) minB[index] = uplink;
		},

		/**
		 * The maximum recent uplink (the favor-the-shooter reach input), or null
		 * before the first sample.
		 * @returns {number | null}
		 */
		maxUplink() {
			let m = -Infinity;
			for (let i = 0; i < bucketCount; i++) if (maxB[i] > m) m = maxB[i];
			return m === -Infinity ? null : m;
		},

		/**
		 * The minimum recent uplink (the un-inflatable detection floor), or null
		 * before the first sample.
		 * @returns {number | null}
		 */
		minUplink() {
			let m = Infinity;
			for (let i = 0; i < bucketCount; i++) if (minB[i] < m) m = minB[i];
			return m === Infinity ? null : m;
		}
	};
}
