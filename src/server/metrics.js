// @ts-check
import { monotonicNow, setIntervalTimer, clearIntervalTimer } from '../shared/runtime.js';
import { wireAssertionMetrics } from '../shared/assert.js';
import { state } from './state.js';
import { _IS_DEV } from './env.js';

/**
 * Per-connection cohort cache: classify each socket ONCE (device/network/geo
 * class is a property of the client, not of any single call) and reuse the
 * label on every metric it produces. WeakMap so a closed socket drops its
 * entry with the socket.
 * @type {WeakMap<object, string>}
 */
const _cohortByWs = new WeakMap();

/** Distinct cohort labels seen, bounded so a buggy classifier cannot explode series cardinality. */
const _cohortSeen = new Set();
const _MAX_COHORTS = 16;

// Label-LENGTH bounds - a backstop, NOT the cardinality fix. The cardinality
// fold (collapsing an unregistered, client-controlled path to `__unknown__` and
// a malformed request to `__invalid__`) MUST happen at each emit site where
// registration is known - the RPC dispatch and the upload handler - because only
// there can a registered path be told from an attacker's arbitrary one. A short
// unregistered path folded here would still be one series per value, so a new
// emit site that forwards a raw client path must fold it before calling this.
// What this choke point guarantees is label SIZE: a non-string or over-length
// path/code can never bloat a label or slip through as a distinct long series.
// A registered rpc path is well under 96 chars and a framework/app error code
// well under 64; anything longer folds to a sentinel.
const _MAX_METRIC_PATH_LEN = 96;
const _MAX_METRIC_CODE_LEN = 64;

/** @param {any} p @returns {string} the path label, folded to a bounded sentinel when non-string or over-length */
function _metricPath(p) {
	if (typeof p !== 'string') return '__unknown__';
	return p.length <= _MAX_METRIC_PATH_LEN ? p : '__toolong__';
}

/** @param {string} c @returns {string} the code label, folded to a bounded sentinel when over-length */
function _metricCode(c) {
	return c.length <= _MAX_METRIC_CODE_LEN ? c : '__toolong__';
}

/**
 * Resolve the cohort label for a socket through the configured classifier.
 * `'unknown'` when no socket is in scope (guard paths that reject before a
 * connection is identified) or the classifier misbehaves; `'other'` once the
 * distinct-label bound is hit.
 * @param {any} ws
 * @returns {string}
 */
function _cohortOf(ws) {
	const mi = state.metricsInstruments;
	if (!ws || !mi || !mi.cohortFn) return 'unknown';
	let cohort = _cohortByWs.get(ws);
	if (cohort !== undefined) return cohort;
	try {
		const raw = mi.cohortFn(typeof ws.getUserData === 'function' ? ws.getUserData() : undefined);
		cohort = typeof raw === 'string' && raw.length > 0 && raw.length <= 32 ? raw : 'unknown';
	} catch {
		cohort = 'unknown';
	}
	if (!_cohortSeen.has(cohort)) {
		if (_cohortSeen.size >= _MAX_COHORTS) cohort = 'other';
		else _cohortSeen.add(cohort);
	}
	_cohortByWs.set(ws, cohort);
	return cohort;
}

/**
 * Record RPC metrics for any exit path. Call exactly once per RPC. When the
 * app configured a cohort classifier, every series carries the caller's
 * cohort label - never trust the aggregate: a p99 that looks healthy can hide
 * a cohort (old devices, cellular links, a far region) that is entirely
 * broken, because the fast majority drowns it. The unlabeled aggregate
 * remains derivable by summing.
 * @param {string} path
 * @param {string} code - error code, or empty string for success
 * @param {number} startTime - from monotonicNow(), or 0 to skip duration
 * @param {any} [ws] - the calling socket, for the cohort label (guard paths that reject pre-identification omit it)
 */
export function _recordRpcMetrics(path, code, startTime, ws) {
	const mi = state.metricsInstruments;
	if (!mi) return;
	// Bound both label values so no path/code can inflate series cardinality.
	path = _metricPath(path);
	if (code) code = _metricCode(code);
	const status = code ? 'error' : 'ok';
	if (mi.cohortFn) {
		const cohort = _cohortOf(ws);
		mi.rpcCount.inc({ path, status, cohort });
		if (code) mi.rpcErrors.inc({ path, code, cohort });
		if (startTime) mi.rpcDuration.observe({ path, cohort }, (monotonicNow() - startTime) / 1000);
		return;
	}
	mi.rpcCount.inc({ path, status });
	if (code) mi.rpcErrors.inc({ path, code });
	if (startTime) mi.rpcDuration.observe({ path }, (monotonicNow() - startTime) / 1000);
}

/**
 * Opt-in Prometheus metrics integration. Instruments RPC calls, stream
 * subscriptions, and cron executions. Zero overhead if never called.
 *
 * Call once at server start (e.g. the top of `src/hooks.ws.{js,ts}`).
 *
 * The registry is any object exposing:
 *   counter({ name, help, labelNames }) -> { inc(labels?) }
 *   histogram({ name, help, labelNames }) -> { observe(labels, valueSeconds) }
 *   gauge({ name, help }) -> { inc(), dec() }
 *
 * Options:
 * - `cohort(userData) => string`: stratify the RPC series by client cohort
 *   (device class, network class, region - whatever your upgrade hook stashed
 *   on the connection's user data). Small cardinality REQUIRED: distinct
 *   labels are bounded at 16 (overflow folds into 'other'), classify once per
 *   connection. Never trust the aggregate - a healthy-looking p99 can hide a
 *   cohort that is entirely broken.
 * - `lifeline: true | { intervalMs }`: pause-aware scrape path. The registry
 *   output is pre-serialized on a background interval (default 5s, unref'd)
 *   into an in-memory snapshot, and the admin route `GET <adminPath>/metrics`
 *   serves THAT string - a scrape costs O(1) at request time, so it keeps
 *   answering (with a stamped snapshot age) while the process is melting
 *   under load instead of adding serialization work to the overloaded loop.
 *   Requires a registry with `serialize()` (the extensions `createMetrics()`
 *   has one) and the `realtime({ admin })` route for auth.
 *
 * See the README "Prometheus metrics" section for a working example that
 * pairs this with `createMetrics()` from `svelte-adapter-uws-extensions/prometheus`.
 *
 * @param {any} registry - Object with counter, histogram, and gauge factories
 * @param {{ cohort?: (userData: any) => string, lifeline?: boolean | { intervalMs?: number } }} [options]
 */
const _liveMetrics = function metrics(registry, options = {}) {
	if (options.cohort !== undefined && typeof options.cohort !== 'function') {
		throw new Error('[svelte-realtime] live.metrics: cohort must be a function (userData) => string');
	}
	const cohortFn = options.cohort || null;
	const rpcLabels = cohortFn ? ['path', 'status', 'cohort'] : ['path', 'status'];
	state.metricsInstruments = {
		registry,
		cohortFn,
		rpcCount: registry.counter({ name: 'svelte_realtime_rpc_total', help: 'Total RPC calls', labelNames: rpcLabels }),
		rpcDuration: registry.histogram({ name: 'svelte_realtime_rpc_duration_seconds', help: 'RPC call duration', labelNames: cohortFn ? ['path', 'cohort'] : ['path'] }),
		rpcErrors: registry.counter({ name: 'svelte_realtime_rpc_errors_total', help: 'Total RPC errors', labelNames: cohortFn ? ['path', 'code', 'cohort'] : ['path', 'code'] }),
		streamGauge: registry.gauge({ name: 'svelte_realtime_stream_subscriptions', help: 'Active stream subscriptions' }),
		cronCount: registry.counter({ name: 'svelte_realtime_cron_total', help: 'Total cron executions', labelNames: ['path', 'status'] }),
		cronErrors: registry.counter({ name: 'svelte_realtime_cron_errors_total', help: 'Total cron errors', labelNames: ['path'] }),
		assertions: registry.counter({ name: 'svelte_realtime_assertion_violations_total', help: 'Production-assertion violations by category', labelNames: ['category'] })
	};
	wireAssertionMetrics((category) => state.metricsInstruments.assertions.inc({ category }));

	if (options.lifeline) {
		if (typeof registry.serialize !== 'function') {
			throw new Error('[svelte-realtime] live.metrics: the lifeline option requires a registry with serialize() (e.g. createMetrics() from svelte-adapter-uws-extensions/prometheus)');
		}
		const intervalMs = (typeof options.lifeline === 'object' && options.lifeline.intervalMs) || 5000;
		if (!Number.isFinite(intervalMs) || intervalMs < 100) {
			throw new Error('[svelte-realtime] live.metrics: lifeline.intervalMs must be a number >= 100');
		}
		state.metricsLifeline = { text: null, at: 0 };
		let rendering = false;
		const render = async () => {
			if (rendering) return;
			rendering = true;
			try {
				const text = await registry.serialize();
				state.metricsLifeline = { text: String(text), at: monotonicNow() };
			} catch { /* keep the last good snapshot */ } finally {
				rendering = false;
			}
		};
		void render();
		const timer = setIntervalTimer(render, intervalMs);
		if (timer && timer.unref) timer.unref();
	}
};

/**
 * Per-subsystem performance budget with drift tracking: declare how long a
 * subsystem is ALLOWED to take, measure what it ACTUALLY takes, and let the
 * dashboards render budget vs actual over time (the drift is the early
 * warning; the `exceeded` counter is the alert). Requires `live.metrics()`
 * to have been installed first.
 *
 * Emits, labeled by `subsystem`:
 * - `svelte_realtime_perf_budget_seconds` (gauge): the declared budget.
 * - `svelte_realtime_perf_actual_seconds` (histogram): observed durations.
 * - `svelte_realtime_perf_budget_exceeded_total` (counter): observations over budget.
 *
 * @param {string} subsystem - small-cardinality name ('tick', 'render', 'db')
 * @param {number} budgetMs
 * @returns {{ track(ms: number): void, measure<T>(fn: () => T): T }}
 */
const _livePerfBudget = function perfBudget(subsystem, budgetMs) {
	if (typeof subsystem !== 'string' || subsystem.length === 0 || subsystem.length > 64) {
		throw new Error('[svelte-realtime] live.perfBudget: subsystem must be a non-empty string (<= 64 chars)');
	}
	if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs) || budgetMs <= 0) {
		throw new Error('[svelte-realtime] live.perfBudget: budgetMs must be a positive number');
	}
	const mi = state.metricsInstruments;
	if (!mi || !mi.registry) {
		throw new Error('[svelte-realtime] live.perfBudget requires live.metrics(registry) to be installed first');
	}
	if (!mi.budgetGauge) {
		mi.budgetGauge = mi.registry.gauge({ name: 'svelte_realtime_perf_budget_seconds', help: 'Declared per-subsystem performance budget', labelNames: ['subsystem'] });
		mi.budgetActual = mi.registry.histogram({ name: 'svelte_realtime_perf_actual_seconds', help: 'Observed per-subsystem duration', labelNames: ['subsystem'] });
		mi.budgetExceeded = mi.registry.counter({ name: 'svelte_realtime_perf_budget_exceeded_total', help: 'Observations over the declared budget', labelNames: ['subsystem'] });
	}
	// The budget gauge needs a settable gauge (the extensions registry has
	// one); a minimal inc/dec-only registry still gets actual + exceeded.
	if (typeof mi.budgetGauge.set === 'function') mi.budgetGauge.set({ subsystem }, budgetMs / 1000);

	function track(ms) {
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
		mi.budgetActual.observe({ subsystem }, ms / 1000);
		if (ms > budgetMs) mi.budgetExceeded.inc({ subsystem });
	}

	return {
		track,
		measure(fn) {
			const start = monotonicNow();
			const out = fn();
			if (out && typeof (/** @type {any} */ (out).then) === 'function') {
				return /** @type {any} */ (out).then(
					(/** @type {any} */ v) => { track(monotonicNow() - start); return v; },
					(/** @type {any} */ err) => { track(monotonicNow() - start); throw err; }
				);
			}
			track(monotonicNow() - start);
			return out;
		}
	};
};

let _pollWarned = false;

/**
 * Push, not poll. This helper IS a polling loop (`fn` every `intervalMs`,
 * stop via the returned function) - but reaching for it earns a one-time dev
 * nudge toward the push-shaped primitive that almost always fits better:
 * `live.stream` with `invalidateOn` (re-run a loader when a topic publishes),
 * `live.derived` (recompute on source publishes), or `live.alarm` (scheduled
 * per-room work). Polling burns CPU/DB on unchanged data and adds latency up
 * to a full interval; a publish costs nothing until something actually
 * changes. Production builds skip the warning.
 *
 * @param {() => void | Promise<void>} fn
 * @param {number} intervalMs
 * @returns {() => void} stop
 */
const _livePoll = function poll(fn, intervalMs) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.poll: fn must be a function');
	}
	if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 1) {
		throw new Error('[svelte-realtime] live.poll: intervalMs must be a positive number (ms)');
	}
	if (_IS_DEV && !_pollWarned) {
		_pollWarned = true;
		console.warn(
			'[svelte-realtime] live.poll: polling is an anti-pattern in a push system - it burns work on unchanged data ' +
			'and adds up to a full interval of latency. Prefer live.stream with invalidateOn (loader re-runs when a topic ' +
			'publishes), live.derived (recompute on source publishes), or live.alarm (scheduled per-room work). ' +
			'This warning fires once per process.\n  See: https://svti.me/derived'
		);
	}
	const timer = setIntervalTimer(() => {
		try {
			const out = fn();
			if (out && typeof (/** @type {any} */ (out).catch) === 'function') /** @type {any} */ (out).catch(() => {});
		} catch { /* a throwing tick must not kill the interval */ }
	}, intervalMs);
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearIntervalTimer(timer);
	};
};

export function installMetrics(live) {
	live.metrics = _liveMetrics;
	live.perfBudget = _livePerfBudget;
	live.poll = _livePoll;
}
