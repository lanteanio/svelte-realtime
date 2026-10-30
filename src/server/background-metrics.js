// @ts-check
import { monotonicNow, now, setIntervalTimer, clearIntervalTimer, microtask } from '../shared/runtime.js';
import { state } from './state.js';
import { _deadLetterStats } from './dead-letter.js';

// One RED/USE schema for every kind of background work: how many items ran and
// how each ended, how long they took, how many are running, how many wait and
// for how long, and how often a retry policy ran out. Labels are closed sets:
// `kind`, plus `result` on the count and the duration. Topics, paths, tenants,
// users, queue names and payloads never become labels, so the number of series
// is fixed by this file, never by traffic.

const _KINDS = /** @type {const} */ (['cron', 'alarm', 'poll', 'derived', 'effect', 'webhook', 'dlq', 'job', 'task']);
const _RESULTS = /** @type {const} */ (['ok', 'error', 'timeout', 'skipped', 'rejected', 'coalesced']);
const _KIND = Object.freeze(['kind']);
const _KIND_RESULT = Object.freeze(['kind', 'result']);

/**
 * The background work metric contract. Every producer registers these exact
 * descriptors (a registry that hands back the existing instrument for a
 * repeated name accepts a second producer only when every field matches) and
 * reports only its own kinds.
 */
export const BACKGROUND_METRICS = Object.freeze({
	kinds: Object.freeze([..._KINDS]),
	results: Object.freeze([..._RESULTS]),
	total: Object.freeze({ type: 'counter', name: 'svelte_realtime_background_total', help: 'Background work items by kind and result', labelNames: _KIND_RESULT }),
	duration: Object.freeze({
		type: 'histogram', name: 'svelte_realtime_background_duration_seconds', help: 'Background work item run time in seconds by kind and result', labelNames: _KIND_RESULT,
		buckets: Object.freeze([0.001, 0.005, 0.025, 0.1, 0.25, 1, 2.5, 10, 30, 60, 300, 900, 3600])
	}),
	inflight: Object.freeze({ type: 'gauge', name: 'svelte_realtime_background_inflight', help: 'Background work items running in this process', labelNames: _KIND }),
	queued: Object.freeze({ type: 'gauge', name: 'svelte_realtime_background_queued', help: 'Background work items waiting to start', labelNames: _KIND }),
	oldestAge: Object.freeze({ type: 'gauge', name: 'svelte_realtime_background_oldest_age_seconds', help: 'Age in seconds of the oldest waiting background work item', labelNames: _KIND }),
	retriesExhausted: Object.freeze({ type: 'counter', name: 'svelte_realtime_background_retries_exhausted_total', help: 'Background work items that failed on the last attempt their retry policy allows', labelNames: _KIND })
});

/** @typedef {'cron' | 'alarm' | 'poll' | 'derived' | 'effect' | 'webhook' | 'dlq'} OwnKind */

/**
 * Running and waiting counts of each kind this package runs. A work lane holds
 * its kind's object and counts on it directly.
 * @type {Record<OwnKind, { inflight: number, queued: number }>}
 */
const _totals = {
	cron: { inflight: 0, queued: 0 },
	alarm: { inflight: 0, queued: 0 },
	poll: { inflight: 0, queued: 0 },
	derived: { inflight: 0, queued: 0 },
	effect: { inflight: 0, queued: 0 },
	webhook: { inflight: 0, queued: 0 },
	dlq: { inflight: 0, queued: 0 }
};

/**
 * The running and waiting counts of `kind`, for a work lane to count on.
 * @param {OwnKind} kind
 */
export function _bgTotals(kind) {
	return _totals[kind];
}

/** One frozen label object per series, so recording allocates nothing. */
const _kindLabels = /** @type {Record<string, { kind: string }>} */ ({});
const _resultLabels = /** @type {Record<string, Record<string, { kind: string, result: string }>>} */ ({});
for (const kind of _KINDS) {
	_kindLabels[kind] = Object.freeze({ kind });
	_resultLabels[kind] = {};
	for (const result of _RESULTS) _resultLabels[kind][result] = Object.freeze({ kind, result });
}

/** How often the age gauges and the dead-letter depth are refreshed while work waits. */
const _SAMPLE_MS = 1000;

/**
 * Register the background series on `registry`, for `live.metrics`.
 * @param {any} registry
 */
export function _registerBackgroundMetrics(registry) {
	const s = BACKGROUND_METRICS;
	const plain = (/** @type {any} */ d) => ({ name: d.name, help: d.help, labelNames: [...d.labelNames] });
	return {
		backgroundTotal: registry.counter(plain(s.total)),
		backgroundDuration: registry.histogram({ ...plain(s.duration), buckets: [...s.duration.buckets] }),
		backgroundInflight: registry.gauge(plain(s.inflight)),
		backgroundQueued: registry.gauge(plain(s.queued)),
		backgroundOldestAge: registry.gauge(plain(s.oldestAge)),
		backgroundRetriesExhausted: registry.counter(plain(s.retriesExhausted))
	};
}

/**
 * The start time to pass to `_bgDone`: 0 while metrics are off, so work that
 * is not measured never reads the clock.
 */
export function _bgClock() {
	return state.metricsInstruments ? monotonicNow() : 0;
}

/**
 * Count one item that ran, and observe its run time when it was clocked.
 * @param {OwnKind} kind
 * @param {number} startedAt - from `_bgClock()`
 * @param {'ok' | 'error' | 'timeout'} result
 */
export function _bgDone(kind, startedAt, result) {
	const mi = state.metricsInstruments;
	if (!mi || !mi.backgroundTotal) return;
	const labels = _resultLabels[kind][result];
	mi.backgroundTotal.inc(labels);
	if (startedAt) mi.backgroundDuration.observe(labels, (monotonicNow() - startedAt) / 1000);
}

/**
 * Count one item that never ran.
 * @param {OwnKind} kind
 * @param {'skipped' | 'rejected' | 'coalesced'} result
 */
export function _bgCount(kind, result) {
	const mi = state.metricsInstruments;
	if (mi && mi.backgroundTotal) mi.backgroundTotal.inc(_resultLabels[kind][result]);
}

/** @param {OwnKind} kind */
export function _bgRetryExhausted(kind) {
	const mi = state.metricsInstruments;
	if (mi && mi.backgroundRetriesExhausted) mi.backgroundRetriesExhausted.inc(_kindLabels[kind]);
}

/**
 * Track work starting (`+1`) or settling (`-1`).
 * @param {OwnKind} kind
 * @param {number} delta
 */
export function _bgInflight(kind, delta) {
	_totals[kind].inflight += delta;
	if (state.metricsInstruments && !_flushPending) _scheduleFlush();
}

/**
 * Track work entering (`+1`) or leaving (`-1`) a queue.
 * @param {'effect' | 'webhook'} kind
 * @param {number} delta
 */
export function _bgQueued(kind, delta) {
	_totals[kind].queued += delta;
	if (state.metricsInstruments && !_flushPending) _scheduleFlush();
}

/** A work lane changed its kind's counts. */
export function _bgChanged() {
	if (state.metricsInstruments && !_flushPending) _scheduleFlush();
}

// The running and waiting gauges are written once per microtask, not on every
// change: a burst of effect calls moves the counts many times within one turn,
// and only the value a scrape can see matters.
let _flushPending = false;

function _scheduleFlush() {
	_flushPending = true;
	microtask(_flushGauges);
}

function _flushGauges() {
	_flushPending = false;
	const mi = state.metricsInstruments;
	if (!mi) return;
	const inflight = mi.backgroundInflight;
	if (inflight && typeof inflight.set === 'function') {
		for (const kind in _totals) inflight.set(_kindLabels[kind], _totals[/** @type {OwnKind} */ (kind)].inflight);
	}
	const queued = mi.backgroundQueued;
	if (queued && typeof queued.set === 'function') {
		queued.set(_kindLabels.effect, _totals.effect.queued);
		queued.set(_kindLabels.webhook, _totals.webhook.queued);
	}
}

/**
 * Queues holding waiting work: each has a `kind` and `since[head]`, the
 * monotonic time its oldest waiting item was queued (0 when that item was
 * queued while metrics were off).
 * @type {Set<{ kind: 'effect' | 'webhook', since: number[], head: number }>}
 */
const _waiting = new Set();
/** @type {any} */
let _sampler = null;
/** When `live.metrics` installed the current instruments (monotonic ms). */
let _installedAt = 0;

/** The queue time to record for a waiting item: 0 while metrics are off. */
export function _bgQueuedAt() {
	return state.metricsInstruments ? monotonicNow() : 0;
}

/**
 * A queue now holds waiting work.
 * @param {{ kind: 'effect' | 'webhook', since: number[], head: number }} queue
 */
export function _bgQueueWaiting(queue) {
	_waiting.add(queue);
	if (state.metricsInstruments && !_sampler) _startSampler();
}

/**
 * A queue is empty again.
 * @param {{ kind: 'effect' | 'webhook', since: number[], head: number }} queue
 */
export function _bgQueueIdle(queue) {
	if (_waiting.delete(queue) && state.metricsInstruments) _sample();
}

/** The dead-letter store gained or lost records. */
export function _bgDeadLetterChanged() {
	if (!state.metricsInstruments) return;
	if (_sampler) _sample();
	else _startSampler();
}

function _startSampler() {
	_sampler = setIntervalTimer(_sample, _SAMPLE_MS);
	if (_sampler && _sampler.unref) _sampler.unref();
	_sample();
}

/** Refresh the age gauges and the dead-letter depth; stop once nothing waits. */
function _sample() {
	const mi = state.metricsInstruments;
	const mono = monotonicNow();
	let effectAge = 0;
	let webhookAge = 0;
	for (const queue of _waiting) {
		const since = queue.since[queue.head];
		if (since === undefined) continue;
		const age = Math.max(0, mono - (since || _installedAt)) / 1000;
		if (queue.kind === 'effect') {
			if (age > effectAge) effectAge = age;
		} else if (age > webhookAge) webhookAge = age;
	}
	// The built-in dead-letter store is sampled here; a durable store reports
	// its own depth and age.
	const dlq = mi ? _deadLetterStats(state.webhookDeadLetter) : null;
	const ageGauge = mi?.backgroundOldestAge;
	if (ageGauge && typeof ageGauge.set === 'function') {
		ageGauge.set(_kindLabels.effect, effectAge);
		ageGauge.set(_kindLabels.webhook, webhookAge);
		if (dlq) ageGauge.set(_kindLabels.dlq, dlq.depth ? Math.max(0, now() - dlq.oldestAt) / 1000 : 0);
	}
	const queued = mi?.backgroundQueued;
	if (dlq && queued && typeof queued.set === 'function') queued.set(_kindLabels.dlq, dlq.depth);
	if (_sampler && (!mi || (_waiting.size === 0 && !(dlq && dlq.depth)))) {
		clearIntervalTimer(_sampler);
		_sampler = null;
	}
}

/** Write every gauge this package owns when `live.metrics()` installs them. */
export function _publishBackgroundGauges() {
	_installedAt = monotonicNow();
	_flushGauges();
	if (_sampler) {
		clearIntervalTimer(_sampler);
		_sampler = null;
	}
	_startSampler();
}
