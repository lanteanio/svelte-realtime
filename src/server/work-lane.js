// @ts-check
import { setIntervalTimer, clearIntervalTimer, monotonicNow } from '../shared/runtime.js';
import { state } from './state.js';
import { _bgDone, _bgCount, _bgTotals, _bgChanged, _bgQueuedAt, _bgQueueWaiting, _bgQueueIdle } from './background-metrics.js';

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
// starting one costs a counter, not a timer.
//
// A released job keeps running: nothing can stop a handler. Released jobs
// count against a total of twice `maxConcurrent` jobs alive, so a lane whose
// jobs never settle stops starting jobs until one settles; its queue and then
// its overflow report that. An abandoned job that settles frees its place and
// changes nothing else.

/** Default limits for `live.effect`: high enough that a small app never meets them. */
export const EFFECT_MAX_CONCURRENT = 32;
export const EFFECT_MAX_QUEUED = 10000;
export const EFFECT_TIMEOUT_MS = 30000;
/**
 * Default limits for `live.webhooks.outbound`, per webhook. A delivery holds
 * its slot through its retries, so throughput is `maxConcurrent` divided by
 * the delivery time: 64 slots carry 128 events/s to an endpoint that answers
 * in 500 ms. Only the leader delivers when one is configured, so this is the
 * ceiling of the whole cluster.
 */
export const WEBHOOK_MAX_CONCURRENT = 64;
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
/** The shortest deadline: its ticks stay well above a timer's granularity. */
const _MIN_TIMEOUT_MS = 100;

/**
 * @typedef {object} WorkLane
 * @property {'effect' | 'webhook'} kind
 * @property {string} [id] - the owning registration path, for reports
 * @property {number} maxConcurrent
 * @property {number} maxQueued
 * @property {'reject' | 'coalesce'} overflow
 * @property {boolean} metered - false for framework-internal watchers kept out of the app's series
 * @property {{ inflight: number, queued: number }} totals - the counts the lane adds to: its kind's, or its own when not metered
 * @property {(a: any, b: any, c: any, d: any) => any} run - returns `LANE_FAILED` (or a promise of it) when the job failed
 * @property {((err: unknown) => void) | undefined} onError - hears a throw from `run` or the rejection of a promise it returned
 * @property {(lane: WorkLane, a: any, b: any, c: any, d: any) => void} [onReject]
 * @property {(lane: WorkLane, rejected: number) => void} [onOverflowEnded]
 * @property {(lane: WorkLane, released: number) => void} [onTimeout]
 * @property {number} timeoutMs - how long a pending job may hold its slot; Infinity for no limit
 * @property {number} active - jobs holding a slot
 * @property {number} abandoned - jobs released at their deadline that are still running
 * @property {number} limit - how many slots may be held now: maxConcurrent, or fewer while abandoned jobs fill the 2 x maxConcurrent alive total
 * @property {Array<(go: boolean) => void>} queue - waiting jobs, as the resolvers of their waits
 * @property {number[]} since - when each waiting job was queued (monotonic ms, 0 while metrics are off), aligned with `queue`
 * @property {number} head
 * @property {number} rejected - jobs rejected in the current overflow episode
 * @property {number} resumeDepth - the queue depth at or below which an overflow episode ends
 * @property {number} pending - running jobs that returned a promise, while timeoutMs is finite
 * @property {Int32Array | null} pendingByTick - `pending` split by start tick, indexed by tick % _TICK_RING
 * @property {number} tick
 * @property {number} releasedThrough - the newest start tick whose jobs were released
 * @property {any} ticker
 * @property {{ tick: number, ok: (v: unknown) => void, err: (e: unknown) => void } | null} shared - settlement handlers shared by untimed jobs of one tick
 */

/**
 * @param {'effect' | 'webhook'} kind
 * @param {{ maxConcurrent: number, maxQueued: number, overflow?: 'reject' | 'coalesce', metered?: boolean, timeoutMs?: number }} limits
 * @param {(a: any, b: any, c: any, d: any) => any} run - starts one job from its submitted arguments; a returned promise holds its slot until it settles. A result of `LANE_FAILED` counts the job as an error.
 * @param {{ onError?: (err: unknown) => void, onReject?: (lane: WorkLane, a: any, b: any, c: any, d: any) => void, onOverflowEnded?: (lane: WorkLane, rejected: number) => void, onTimeout?: (lane: WorkLane, released: number) => void }} [hooks]
 *   `onError` hears a throw from `run` or the rejection of a promise it
 *   returned (the job then counts as an error); `onReject` hears each rejected job (`lane.rejected` is 1 for the first of
 *   an overflow episode); `onOverflowEnded` hears when the episode ends, with
 *   its count of rejections; `onTimeout` hears each deadline tick that
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
		totals: limits.metered !== false ? _bgTotals(kind) : { inflight: 0, queued: 0 },
		run,
		onError: hooks.onError,
		onReject: hooks.onReject,
		onOverflowEnded: hooks.onOverflowEnded,
		onTimeout: hooks.onTimeout,
		timeoutMs: limits.timeoutMs ?? Infinity,
		active: 0,
		abandoned: 0,
		limit: limits.maxConcurrent,
		queue: [],
		since: [],
		head: 0,
		rejected: 0,
		resumeDepth: Math.floor(limits.maxQueued / 2),
		pending: 0,
		pendingByTick: null,
		tick: 0,
		releasedThrough: -1,
		ticker: null,
		shared: null
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
 * Validate a lane deadline option: an integer of milliseconds from
 * `_MIN_TIMEOUT_MS` to what a timer can hold, or `Infinity` for no deadline.
 * @param {string} where
 * @param {unknown} value
 */
export function _validateLaneTimeout(where, value) {
	if (value === undefined || value === Infinity) return;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < _MIN_TIMEOUT_MS || value > _MAX_TIMEOUT_MS) {
		throw new Error('[svelte-realtime] ' + where + ': timeoutMs must be an integer from ' + _MIN_TIMEOUT_MS + ' to ' + _MAX_TIMEOUT_MS + ' (or Infinity)');
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
	if (depth === 0 && lane.active < lane.limit) {
		lane.active++;
		lane.totals.inflight++;
		if (lane.metered) _bgChanged();
		_start(lane, a, b, c, d);
		return;
	}
	if (depth < lane.maxQueued) {
		_wait(lane, a, b, c, d);
		lane.totals.queued++;
		if (lane.metered) _bgChanged();
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
 * drops it (`false`). Waiting on a promise, rather than parking the job in a
 * plain entry, resumes the job in the async context of its publish (the
 * active trace, for one), not in that of the job whose settlement freed the
 * slot.
 * @param {WorkLane} lane
 * @param {any} a
 * @param {any} b
 * @param {any} c
 * @param {any} d
 */
function _wait(lane, a, b, c, d) {
	new Promise((resolve) => {
		lane.queue.push(resolve);
		lane.since.push(_bgQueuedAt());
	}).then((go) => { if (go) _start(lane, a, b, c, d); });
}

/**
 * @param {WorkLane} lane
 * @param {any} a
 * @param {any} b
 * @param {any} c
 * @param {any} d
 */
function _start(lane, a, b, c, d) {
	const startedAt = lane.metered && state.metricsInstruments ? monotonicNow() : 0;
	let result;
	/** @type {Promise<unknown> | null} */
	let promise = null;
	try {
		result = lane.run(a, b, c, d);
		// Promise.resolve returns a native promise as it is and turns any other
		// thenable into one, so a `then` that throws becomes a rejection and one
		// that calls back twice settles the job once.
		if (result && typeof result.then === 'function') promise = Promise.resolve(result);
	} catch (err) {
		_reportRejection(lane, err);
		result = LANE_FAILED;
	}
	if (promise) {
		const tick = lane.timeoutMs === Infinity ? -1 : _holdPending(lane);
		// An untimed job needs nothing of its own to settle, so jobs that start
		// in the same deadline tick share one pair of handlers and a pending job
		// allocates no closures.
		const h = startedAt ? _handlers(lane, tick, startedAt) : lane.shared && lane.shared.tick === tick ? lane.shared : (lane.shared = _handlers(lane, tick, 0));
		promise.then(h.ok, h.err);
	} else {
		_settle(lane, startedAt, result === LANE_FAILED ? 'error' : 'ok');
	}
}

/**
 * The settlement handlers of jobs that started in deadline tick `tick` (-1
 * when the lane has no deadline) at `startedAt` (0 when not timed).
 * @param {WorkLane} lane
 * @param {number} tick
 * @param {number} startedAt
 * @returns {{ tick: number, ok: (v: unknown) => void, err: (e: unknown) => void }}
 */
function _handlers(lane, tick, startedAt) {
	return {
		tick,
		ok: (v) => {
			if (tick < 0 || _releasePending(lane, tick)) _settle(lane, startedAt, v === LANE_FAILED ? 'error' : 'ok');
			else _abandonedSettled(lane);
		},
		err: (e) => {
			_reportRejection(lane, e);
			if (tick < 0 || _releasePending(lane, tick)) _settle(lane, startedAt, 'error');
			else _abandonedSettled(lane);
		}
	};
}

/**
 * Hand a job's failure to the lane's `onError`; a job released at its
 * deadline still reports how it failed.
 * @param {WorkLane} lane
 * @param {unknown} err
 */
function _reportRejection(lane, err) {
	if (lane.onError) {
		try { lane.onError(err); } catch {}
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
	if (lane.metered && state.metricsInstruments) _bgDone(lane.kind, startedAt, result);
	if (result === 'timeout') {
		// The handler runs on without its slot, so it stays in the running count.
		lane.abandoned++;
		_updateLimit(lane);
		lane.totals.inflight++;
	}
	if (lane.head < lane.queue.length && lane.active <= lane.limit) {
		// The slot passes straight to the next job.
		_dequeue(lane)(true);
		return;
	}
	lane.active--;
	lane.totals.inflight--;
	if (lane.metered) _bgChanged();
	if (lane.rejected) _overflowEnded(lane);
}

/**
 * An abandoned job settled: its place in the cap is free, and waiting jobs
 * may take the slots that frees.
 * @param {WorkLane} lane
 */
function _abandonedSettled(lane) {
	lane.abandoned--;
	_updateLimit(lane);
	lane.totals.inflight--;
	if (lane.metered) _bgChanged();
	while (lane.head < lane.queue.length && lane.active < lane.limit) {
		lane.active++;
		lane.totals.inflight++;
		_dequeue(lane)(true);
	}
}

/** @param {WorkLane} lane */
function _updateLimit(lane) {
	lane.limit = Math.max(0, Math.min(lane.maxConcurrent, 2 * lane.maxConcurrent - lane.abandoned));
}

/**
 * Take the job at the head of the queue.
 * @param {WorkLane} lane
 * @returns {(go: boolean) => void} its wait's resolver
 */
function _dequeue(lane) {
	const next = /** @type {(go: boolean) => void} */ (lane.queue[lane.head]);
	lane.queue[lane.head] = /** @type {any} */ (undefined);
	lane.since[lane.head++] = /** @type {any} */ (undefined);
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
	lane.totals.queued--;
	if (lane.metered) _bgChanged();
	if (lane.rejected && lane.queue.length - lane.head <= lane.resumeDepth) _overflowEnded(lane);
	return next;
}

/**
 * End an overflow episode. It ends once the queue is back to half its limit,
 * not at the first free place: a handler that only just keeps up would
 * otherwise start and end an episode, and report both, on every job.
 * @param {WorkLane} lane
 */
function _overflowEnded(lane) {
	const rejected = lane.rejected;
	lane.rejected = 0;
	if (lane.onOverflowEnded) {
		try { lane.onOverflowEnded(lane, rejected); } catch {}
	}
}
