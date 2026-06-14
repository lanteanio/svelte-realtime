// @ts-check
import { LiveError } from './live-error.js';
import { _IS_DEV } from './env.js';

// - Room action history (lag compensation) ----------------------------------

const _HISTORY_MAX_ENTRIES = 300;
const _HISTORY_MAX_AGE_MS = 2000;
const _HISTORY_MAX_TOPICS = 100;

/**
 * Validate and normalize a room's `history` config. The capture function is
 * the app's snapshot of its own authoritative state - the framework never
 * guesses at state shape; it only owns the ring mechanics around what the
 * app hands it.
 *
 * @param {any} history
 * @returns {{ capture: Function, maxEntries: number, maxAgeMs: number, maxTopics: number }}
 */
export function _resolveHistoryConfig(history) {
	if (!history || typeof history !== 'object' || typeof history.capture !== 'function') {
		throw new Error(
			`[svelte-realtime] live.room() history requires a capture function: history: { capture: (...roomArgs) => state }\n  See: https://svti.me/rooms`
		);
	}
	const maxEntries = history.maxEntries ?? _HISTORY_MAX_ENTRIES;
	if (!Number.isInteger(maxEntries) || maxEntries < 1) {
		throw new Error(`[svelte-realtime] live.room() history.maxEntries must be a positive integer, got ${history.maxEntries}\n  See: https://svti.me/rooms`);
	}
	const maxAgeMs = history.maxAgeMs ?? _HISTORY_MAX_AGE_MS;
	if (typeof maxAgeMs !== 'number' || !(maxAgeMs > 0)) {
		throw new Error(`[svelte-realtime] live.room() history.maxAgeMs must be a positive number, got ${history.maxAgeMs}\n  See: https://svti.me/rooms`);
	}
	const maxTopics = history.maxTopics ?? _HISTORY_MAX_TOPICS;
	if (!Number.isInteger(maxTopics) || maxTopics < 1) {
		throw new Error(`[svelte-realtime] live.room() history.maxTopics must be a positive integer, got ${history.maxTopics}\n  See: https://svti.me/rooms`);
	}
	return { capture: history.capture, maxEntries, maxAgeMs, maxTopics };
}

/**
 * Cycle-safe recursive freeze for dev-mode snapshots, so a handler that
 * mutates historical state throws at the mutation site instead of silently
 * corrupting the ring. Plain objects and arrays only - Map/Set contents
 * cannot be frozen by Object.freeze and are the capture contract's
 * responsibility (documented: capture returns plain data). Depth-capped so
 * client-shaped payloads an app stored into its state cannot recurse the
 * dev process into a stack overflow.
 *
 * @param {any} value
 * @param {Set<any>} seen
 * @param {number} depth
 */
function _deepFreeze(value, seen, depth) {
	if (value === null || typeof value !== 'object' || seen.has(value)) return value;
	seen.add(value);
	Object.freeze(value);
	if (depth >= 64) return value;
	for (const key of Object.keys(value)) _deepFreeze(value[key], seen, depth + 1);
	return value;
}

/** @param {any} state */
export function _freezeSnapshot(state) {
	if (state === null || typeof state !== 'object') return state;
	// A thenable here means an async capture: the ring would record a frozen
	// pending Promise and every evaluation would silently read garbage.
	// Checked at the state boundary (catches any promise-returning function,
	// not just async syntax) and loud by design.
	if (typeof state.then === 'function') {
		throw new Error(
			`[svelte-realtime] history capture must return state synchronously; it returned a thenable. Snapshot your in-memory authoritative state directly.\n  See: https://svti.me/rooms`
		);
	}
	if (_IS_DEV) return _deepFreeze(state, new Set(), 0);
	return Object.freeze(state);
}

/**
 * Per-room store of bounded per-topic history rings. Same shape as the replay
 * plugin's in-memory ring: fixed-size buffer with modular indices, topics
 * LRU-capped so a burst of parameterized room ids cannot grow memory without
 * bound. Entry times come from the exact wall clock (`wallEpoch`), never the
 * 1s-cached `now()` - rewind windows are sub-second.
 *
 * @param {{ maxEntries: number, maxAgeMs: number, maxTopics: number }} cfg
 */
export function _createHistoryStore(cfg) {
	/** @type {Map<string, { buf: Array<{ time: number, state: any } | undefined>, start: number, len: number }>} */
	const topics = new Map();
	/** @type {Map<string, null>} insertion-ordered LRU; first key is coldest */
	const topicOrder = new Map();

	/** @param {string} topic */
	function getRing(topic) {
		let ring = topics.get(topic);
		if (!ring) {
			if (topics.size >= cfg.maxTopics) {
				const lru = topicOrder.keys().next().value;
				if (lru !== undefined) {
					topics.delete(lru);
					topicOrder.delete(lru);
				}
			}
			ring = { buf: new Array(cfg.maxEntries), start: 0, len: 0 };
			topics.set(topic, ring);
		} else {
			topicOrder.delete(topic);
		}
		topicOrder.set(topic, null);
		return ring;
	}

	return {
		/**
		 * Append a snapshot, lazily evicting entries past the age window. One
		 * write per successful room action; never timer-driven.
		 *
		 * @param {string} topic
		 * @param {any} state
		 * @param {number} time
		 */
		record(topic, state, time) {
			const ring = getRing(topic);
			// The binary search below requires non-decreasing entry times, and
			// the wall clock can step backwards (NTP correction). Clamping a
			// new entry to at least the newest recorded time keeps the ring
			// sorted at the cost of one compare against the tail.
			if (ring.len > 0) {
				const newest = ring.buf[(ring.start + ring.len - 1) % cfg.maxEntries];
				if (newest !== undefined && newest.time > time) time = newest.time;
			}
			while (ring.len > 0) {
				const oldest = ring.buf[ring.start];
				if (oldest !== undefined && oldest.time >= time - cfg.maxAgeMs) break;
				ring.buf[ring.start] = undefined;
				ring.start = (ring.start + 1) % cfg.maxEntries;
				ring.len--;
			}
			const idx = (ring.start + ring.len) % cfg.maxEntries;
			ring.buf[idx] = { time, state };
			if (ring.len < cfg.maxEntries) ring.len++;
			else ring.start = (ring.start + 1) % cfg.maxEntries;
		},

		/**
		 * Newest entry recorded at or before `commandTime`, still inside the
		 * age window as of `t`. Null when the ring cannot serve the rewind -
		 * the caller fails safe to current state (a rewind past the window
		 * must never resolve to the oldest marker, or stale commands would
		 * evaluate against ancient state).
		 *
		 * @param {string} topic
		 * @param {number} commandTime
		 * @param {number} t
		 * @returns {{ time: number, state: any } | null}
		 */
		lookup(topic, commandTime, t) {
			const ring = topics.get(topic);
			if (!ring || ring.len === 0) return null;
			topicOrder.delete(topic);
			topicOrder.set(topic, null);
			let lo = 0;
			let hi = ring.len - 1;
			let found = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				const e = /** @type {{ time: number, state: any }} */ (ring.buf[(ring.start + mid) % cfg.maxEntries]);
				if (e.time <= commandTime) {
					found = mid;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			if (found < 0) return null;
			const entry = /** @type {{ time: number, state: any }} */ (ring.buf[(ring.start + found) % cfg.maxEntries]);
			if (entry.time < t - cfg.maxAgeMs) return null;
			return entry;
		}
	};
}

/**
 * Default `ctx.compensate` outside a history-enabled room action: a clear
 * error beats a silent no-rewind evaluation. Room actions on a room with a
 * `history` config shadow this with the live implementation, the same way
 * they shadow `ctx.publish`.
 */
export async function _compensateUnavailable() {
	throw new LiveError(
		'VALIDATION',
		'ctx.compensate requires a live.room with a history config: live.room({ history: { capture } })'
	);
}
