// @ts-check
import { state } from './state.js';

// Bounded execution for work a publish schedules off its own path: effect
// handlers and outbound webhook deliveries. Each effect and each outbound
// webhook owns one lane. A lane runs at most `maxConcurrent` jobs and holds at
// most `maxQueued` more in FIFO order; a job past both limits overflows and is
// never started. Without a lane, a handler that stalls (a slow query, a hung
// HTTP endpoint) turns every later publish into one more pending promise and
// one more held payload, with no limit.
//
// A job is admitted in a microtask after its publish, exactly when it used to
// start, so the publish path pays one scheduled callback as before. A job that
// finishes synchronously gives its slot back at once; only work that is still
// pending holds a slot, so a burst of fast handlers never queues.

/** Default limits for `live.effect`: high enough that a small app never meets them. */
export const EFFECT_MAX_CONCURRENT = 32;
export const EFFECT_MAX_QUEUED = 10000;
/** Default limits for `live.webhooks.outbound`, per webhook. */
export const WEBHOOK_MAX_CONCURRENT = 8;
export const WEBHOOK_MAX_QUEUED = 10000;

/** Queue slots consumed at the front before the backing array is compacted. */
const _COMPACT_AT = 1024;

/**
 * Process-wide totals per kind, mirrored into the `live.metrics` gauges. The
 * label set is closed: `kind` is one of these keys and nothing else.
 */
const _totals = {
	derived: { inflight: 0, queued: 0 },
	effect: { inflight: 0, queued: 0 },
	webhook: { inflight: 0, queued: 0 }
};

/**
 * @typedef {object} WorkLane
 * @property {'effect' | 'webhook'} kind
 * @property {string} [id] - the owning registration path, for reports
 * @property {number} maxConcurrent
 * @property {number} maxQueued
 * @property {'reject' | 'coalesce'} overflow
 * @property {boolean} metered - false for framework-internal watchers kept out of the app's series
 * @property {(a: any, b: any, c: any, d: any) => any} run
 * @property {(lane: WorkLane, a: any, b: any, c: any, d: any) => void} [onReject]
 * @property {(lane: WorkLane, rejected: number) => void} [onDrained]
 * @property {number} active
 * @property {Array<(go: boolean) => void>} queue - waiting jobs, as the resolvers of their waits
 * @property {number} head
 * @property {number} rejected - jobs rejected since the queue last had room
 */

/**
 * @param {'effect' | 'webhook'} kind
 * @param {{ maxConcurrent: number, maxQueued: number, overflow?: 'reject' | 'coalesce', metered?: boolean }} limits
 * @param {(a: any, b: any, c: any, d: any) => any} run - starts one job from its submitted arguments; a returned promise holds its slot until it settles
 * @param {{ onReject?: (lane: WorkLane, a: any, b: any, c: any, d: any) => void, onDrained?: (lane: WorkLane, rejected: number) => void }} [hooks]
 *   `onReject` hears each rejected job (`lane.rejected` is 1 for the first of
 *   an overflow episode); `onDrained` hears when the queue has room again after
 *   rejections, with their count.
 * @returns {WorkLane}
 */
export function _createLane(kind, limits, run, hooks = {}) {
	return {
		kind,
		maxConcurrent: limits.maxConcurrent,
		maxQueued: limits.maxQueued,
		overflow: limits.overflow || 'reject',
		metered: limits.metered !== false,
		run,
		onReject: hooks.onReject,
		onDrained: hooks.onDrained,
		active: 0,
		queue: [],
		head: 0,
		rejected: 0
	};
}

/**
 * Validate a lane limit option. `Infinity` is the explicit opt-out.
 * @param {string} where
 * @param {string} name
 * @param {unknown} value
 * @param {number} min
 */
export function _validateLaneLimit(where, name, value, min) {
	if (value === undefined || value === Infinity) return;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
		throw new Error('[svelte-realtime] ' + where + ': ' + name + ' must be an integer >= ' + min + ' (or Infinity)');
	}
}

/**
 * Submit a job as up to four arguments for the lane's `run`, so the publish
 * path allocates nothing beyond the one scheduled callback. It is admitted in a
 * microtask, never on the caller's stack.
 * @param {WorkLane} lane
 * @param {any} a
 * @param {any} b
 * @param {any} c
 * @param {any} [d]
 */
export function _laneSubmit(lane, a, b, c, d) {
	Promise.resolve().then(() => _admit(lane, a, b, c, d));
}

/**
 * Start the job when a slot is free and nothing waits ahead of it, else queue
 * it, else apply the lane's overflow policy.
 * @param {WorkLane} lane
 * @param {any} a
 * @param {any} b
 * @param {any} c
 * @param {any} d
 */
function _admit(lane, a, b, c, d) {
	const depth = lane.queue.length - lane.head;
	if (depth === 0 && lane.active < lane.maxConcurrent) {
		lane.active++;
		_move(lane, 'inflight', 1);
		_start(lane, a, b, c, d);
		return;
	}
	if (depth < lane.maxQueued) {
		_wait(lane, a, b, c, d);
		_move(lane, 'queued', 1);
		return;
	}
	if (lane.overflow === 'coalesce' && depth > 0) {
		/** @type {(go: boolean) => void} */ (lane.queue.pop())(false);
		_wait(lane, a, b, c, d);
		_countOverflow(lane, 'coalesced');
		return;
	}
	lane.rejected++;
	_countOverflow(lane, 'rejected');
	if (lane.onReject) {
		try { lane.onReject(lane, a, b, c, d); } catch {}
	}
}

/**
 * Count one overflowed job under `result` in `svelte_realtime_background_total`.
 * @param {WorkLane} lane
 * @param {'rejected' | 'coalesced'} result
 */
function _countOverflow(lane, result) {
	if (!lane.metered) return;
	const mi = state.metricsInstruments;
	if (mi && mi.backgroundTotal) mi.backgroundTotal.inc({ kind: lane.kind, result });
}

/**
 * Hold a job in the queue until a slot passes to it (`true`) or a coalesce
 * drops it (`false`). Waiting in an async function, rather than parking the job
 * in a plain entry, resumes the job in the async context of its publish (the
 * active trace, for one), not in that of the job whose settlement freed the
 * slot.
 * @param {WorkLane} lane
 * @param {any} a
 * @param {any} b
 * @param {any} c
 * @param {any} d
 */
async function _wait(lane, a, b, c, d) {
	const go = await new Promise((resolve) => { lane.queue.push(resolve); });
	if (go) _start(lane, a, b, c, d);
}

/**
 * @param {WorkLane} lane
 * @param {any} a
 * @param {any} b
 * @param {any} c
 * @param {any} d
 */
function _start(lane, a, b, c, d) {
	let result;
	try {
		result = lane.run(a, b, c, d);
	} catch {
		// run() owns error reporting; a synchronous throw only frees the slot.
	}
	if (result && typeof result.then === 'function') {
		result.then(() => _settle(lane), () => _settle(lane));
	} else {
		_settle(lane);
	}
}

/** @param {WorkLane} lane */
function _settle(lane) {
	if (lane.head < lane.queue.length) {
		const next = lane.queue[lane.head];
		lane.queue[lane.head++] = undefined;
		if (lane.head === lane.queue.length) {
			lane.queue.length = 0;
			lane.head = 0;
		} else if (lane.head >= _COMPACT_AT && lane.head * 2 >= lane.queue.length) {
			lane.queue.splice(0, lane.head);
			lane.head = 0;
		}
		_move(lane, 'queued', -1);
		if (lane.rejected && lane.head === lane.queue.length) _drained(lane);
		// The slot passes straight to the next job.
		next(true);
		return;
	}
	lane.active--;
	_move(lane, 'inflight', -1);
	if (lane.rejected) _drained(lane);
}

/** @param {WorkLane} lane */
function _drained(lane) {
	const rejected = lane.rejected;
	lane.rejected = 0;
	if (lane.onDrained) {
		try { lane.onDrained(lane, rejected); } catch {}
	}
}

/**
 * @param {WorkLane} lane
 * @param {'inflight' | 'queued'} field
 * @param {number} delta
 */
function _move(lane, field, delta) {
	if (!lane.metered) return;
	_totals[lane.kind][field] += delta;
	_publishGauge(lane.kind, field);
}

/**
 * Track a derived recompute starting (`+1`) or settling (`-1`).
 * @param {number} delta
 */
export function _derivedInflight(delta) {
	_totals.derived.inflight += delta;
	_publishGauge('derived', 'inflight');
}

/**
 * @param {'derived' | 'effect' | 'webhook'} kind
 * @param {'inflight' | 'queued'} field
 */
function _publishGauge(kind, field) {
	const mi = state.metricsInstruments;
	if (!mi) return;
	const gauge = field === 'inflight' ? mi.backgroundInflight : mi.backgroundQueued;
	if (gauge && typeof gauge.set === 'function') gauge.set({ kind }, _totals[kind][field]);
}

/** Seed the gauges with the current totals when `live.metrics()` installs them. */
export function _publishLaneGauges() {
	for (const kind of /** @type {const} */ (['derived', 'effect', 'webhook'])) {
		_publishGauge(kind, 'inflight');
		if (kind !== 'derived') _publishGauge(kind, 'queued');
	}
}
