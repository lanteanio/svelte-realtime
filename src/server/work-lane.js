// @ts-check
import { setIntervalTimer, clearIntervalTimer } from '../shared/runtime.js';
import { _bgClock, _bgDone, _bgCount, _bgInflight, _bgQueued, _bgQueuedAt, _bgQueueWaiting, _bgQueueIdle } from './background-metrics.js';

// Bounded execution for work a publish schedules off its own path: effect
// handlers and outbound webhook deliveries. Each effect and each outbound
// webhook owns one lane. A lane runs at most `maxConcurrent` jobs and holds at
// most `maxQueued` more in FIFO order; a job past both limits overflows and is
// never started. Without a lane, a handler that stalls (a slow query, a hung
// HTTP endpoint) turns every later publish into one more pending promise and
// one more held payload, with no limit.
//
// A job is admitted in a microtask after its publish, so the publish path pays
// one scheduled callback. A job that finishes synchronously gives its slot
// back at once; only work that is still pending holds a slot, so a burst of
// fast handlers never queues.
//
// A pending job holds its slot for at most the lane's `timeoutMs`. Instead of
// one timer per job, a lane that has pending jobs ticks four times per
// timeout; each job remembers the tick it started in, and a tick releases the
// slots of every job that started five or more ticks earlier. A job is so
// released between `timeoutMs` and 1.25 x `timeoutMs` after it started, and
// starting one costs a counter, not a timer. A released job that settles later
// changes nothing.

/** Default limits for `live.effect`: high enough that a small app never meets them. */
export const EFFECT_MAX_CONCURRENT = 32;
export const EFFECT_MAX_QUEUED = 10000;
export const EFFECT_TIMEOUT_MS = 30000;
/** Default limits for `live.webhooks.outbound`, per webhook. */
export const WEBHOOK_MAX_CONCURRENT = 8;
export const WEBHOOK_MAX_QUEUED = 10000;

/**
 * What a lane's `run` returns, or resolves to, for a job that failed after
 * reporting its own error. No value a handler returns can equal it.
 */
export const LANE_FAILED = Symbol('lane-failed');

/** Queue slots consumed at the front before the backing array is compacted. */
const _COMPACT_AT = 1024;

/** Deadline ticks per `timeoutMs`, and the tick age at which a pending job is released. */
const _TICKS_PER_TIMEOUT = 4;
const _EXPIRE_AFTER_TICKS = _TICKS_PER_TIMEOUT + 1;
/** Pending-job counts are kept per start tick in a ring this large (a power of two above the live span). */
const _TICK_RING = 8;
/** The largest delay a timer accepts. */
const _MAX_TIMEOUT_MS = 2147483647;

/**
 * @typedef {object} WorkLane
 * @property {'effect' | 'webhook'} kind
 * @property {string} [id] - the owning registration path, for reports
 * @property {number} maxConcurrent
 * @property {number} maxQueued
 * @property {'reject' | 'coalesce'} overflow
 * @property {boolean} metered - false for framework-internal watchers kept out of the app's series
 * @property {(a: any, b: any, c: any, d: any) => any} run - returns `LANE_FAILED` (or a promise of it) when the job failed
 * @property {(lane: WorkLane, a: any, b: any, c: any, d: any) => void} [onReject]
 * @property {(lane: WorkLane, rejected: number) => void} [onDrained]
 * @property {(lane: WorkLane, released: number) => void} [onTimeout]
 * @property {number} timeoutMs - how long a pending job may hold its slot; Infinity for no limit
 * @property {number} active
 * @property {Array<(go: boolean) => void>} queue - waiting jobs, as the resolvers of their waits
 * @property {number[]} since - when each waiting job was queued (monotonic ms, 0 while metrics are off), aligned with `queue`
 * @property {number} head
 * @property {number} rejected - jobs rejected since the queue last had room
 * @property {number} pending - running jobs that returned a promise, while timeoutMs is finite
 * @property {Int32Array | null} pendingByTick - `pending` split by start tick, indexed by tick % _TICK_RING
 * @property {number} tick
 * @property {number} releasedThrough - the newest start tick whose jobs were released
 * @property {any} ticker
 */

/**
 * @param {'effect' | 'webhook'} kind
 * @param {{ maxConcurrent: number, maxQueued: number, overflow?: 'reject' | 'coalesce', metered?: boolean, timeoutMs?: number }} limits
 * @param {(a: any, b: any, c: any, d: any) => any} run - starts one job from its submitted arguments; a returned promise holds its slot until it settles. A result of `LANE_FAILED` counts the job as an error.
 * @param {{ onReject?: (lane: WorkLane, a: any, b: any, c: any, d: any) => void, onDrained?: (lane: WorkLane, rejected: number) => void, onTimeout?: (lane: WorkLane, released: number) => void }} [hooks]
 *   `onReject` hears each rejected job (`lane.rejected` is 1 for the first of
 *   an overflow episode); `onDrained` hears when the queue has room again after
 *   rejections, with their count; `onTimeout` hears each deadline tick that
 *   released pending jobs, with their count.
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
		onTimeout: hooks.onTimeout,
		timeoutMs: limits.timeoutMs ?? Infinity,
		active: 0,
		queue: [],
		since: [],
		head: 0,
		rejected: 0,
		pending: 0,
		pendingByTick: null,
		tick: 0,
		releasedThrough: -1,
		ticker: null
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
 * Validate a lane deadline option: a positive integer of milliseconds a timer
 * can hold, or `Infinity` for no deadline.
 * @param {string} where
 * @param {unknown} value
 */
export function _validateLaneTimeout(where, value) {
	if (value === undefined || value === Infinity) return;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > _MAX_TIMEOUT_MS) {
		throw new Error('[svelte-realtime] ' + where + ': timeoutMs must be an integer from 1 to ' + _MAX_TIMEOUT_MS + ' (or Infinity)');
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
	_resolved.then(() => _admit(lane, a, b, c, d));
}

/** One settled promise to schedule admissions on, instead of a new one per job. */
const _resolved = Promise.resolve();

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
		if (depth === 0 && lane.metered) _bgQueueWaiting(lane);
		return;
	}
	if (lane.overflow === 'coalesce' && depth > 0) {
		/** @type {(go: boolean) => void} */ (lane.queue.pop())(false);
		lane.since.pop();
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
	if (lane.metered) _bgCount(lane.kind, result);
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
	const go = await new Promise((resolve) => {
		lane.queue.push(resolve);
		lane.since.push(_bgQueuedAt());
	});
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
	const startedAt = lane.metered ? _bgClock() : 0;
	let result;
	try {
		result = lane.run(a, b, c, d);
	} catch {
		// run() owns error reporting; a synchronous throw only frees the slot.
		result = LANE_FAILED;
	}
	if (result && typeof result.then === 'function') {
		if (lane.timeoutMs === Infinity) {
			result.then((v) => _settle(lane, startedAt, v === LANE_FAILED ? 'error' : 'ok'), () => _settle(lane, startedAt, 'error'));
			return;
		}
		const tick = _holdPending(lane);
		result.then(
			(v) => { if (_releasePending(lane, tick)) _settle(lane, startedAt, v === LANE_FAILED ? 'error' : 'ok'); },
			() => { if (_releasePending(lane, tick)) _settle(lane, startedAt, 'error'); }
		);
	} else {
		_settle(lane, startedAt, result === LANE_FAILED ? 'error' : 'ok');
	}
}

/**
 * Count a pending job against the current deadline tick, starting the ticker
 * when the lane has none.
 * @param {WorkLane} lane
 * @returns {number} the job's start tick
 */
function _holdPending(lane) {
	const ring = lane.pendingByTick || (lane.pendingByTick = new Int32Array(_TICK_RING));
	ring[lane.tick & (_TICK_RING - 1)]++;
	lane.pending++;
	if (!lane.ticker) {
		lane.ticker = setIntervalTimer(() => _deadlineTick(lane), lane.timeoutMs / _TICKS_PER_TIMEOUT);
		if (lane.ticker && lane.ticker.unref) lane.ticker.unref();
	}
	return lane.tick;
}

/**
 * A pending job settled. False when its slot was already released at its
 * deadline, so the settlement must change nothing.
 * @param {WorkLane} lane
 * @param {number} tick
 */
function _releasePending(lane, tick) {
	if (tick <= lane.releasedThrough) return false;
	/** @type {Int32Array} */ (lane.pendingByTick)[tick & (_TICK_RING - 1)]--;
	lane.pending--;
	return true;
}

/**
 * Advance the lane's deadline tick and release the slots of pending jobs past
 * their deadline. The ticker stops once nothing is pending.
 * @param {WorkLane} lane
 */
function _deadlineTick(lane) {
	const tick = ++lane.tick;
	const ring = /** @type {Int32Array} */ (lane.pendingByTick);
	let released = 0;
	for (let t = lane.releasedThrough + 1; t <= tick - _EXPIRE_AFTER_TICKS; t++) {
		released += ring[t & (_TICK_RING - 1)];
		ring[t & (_TICK_RING - 1)] = 0;
		lane.releasedThrough = t;
	}
	if (released) {
		lane.pending -= released;
		for (let i = 0; i < released; i++) _settle(lane, 0, 'timeout');
		if (lane.onTimeout) {
			try { lane.onTimeout(lane, released); } catch {}
		}
	}
	if (lane.pending === 0) {
		clearIntervalTimer(lane.ticker);
		lane.ticker = null;
	}
}

/**
 * @param {WorkLane} lane
 * @param {number} startedAt - 0 for a job that was not timed
 * @param {'ok' | 'error' | 'timeout'} result
 */
function _settle(lane, startedAt, result) {
	if (lane.metered) _bgDone(lane.kind, startedAt, result);
	if (lane.head < lane.queue.length) {
		const next = lane.queue[lane.head];
		lane.queue[lane.head] = undefined;
		lane.since[lane.head++] = undefined;
		if (lane.head === lane.queue.length) {
			lane.queue.length = 0;
			lane.since.length = 0;
			lane.head = 0;
			if (lane.metered) _bgQueueIdle(lane);
		} else if (lane.head >= _COMPACT_AT && lane.head * 2 >= lane.queue.length) {
			lane.queue.splice(0, lane.head);
			lane.since.splice(0, lane.head);
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
	if (field === 'inflight') _bgInflight(lane.kind, delta);
	else _bgQueued(lane.kind, delta);
}
