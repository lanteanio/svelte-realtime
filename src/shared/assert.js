// @ts-check

/**
 * Production-safe invariant check shared by `server.js` and `client.js`.
 *
 * Mirrors the adapter / extensions assert shape from 0.5.0-next.8.
 * Categories use the `realtime/` prefix so the Prometheus counter
 * `svelte_realtime_assertion_violations_total{category}` does not collide
 * with the adapter's `extensions_assertion_violations_total{category}`.
 *
 * Behavior:
 *   - On violation: increments the per-category counter on the module-level
 *     Map, fires the optional metrics hook bound via `wireAssertionMetrics`,
 *     and logs a structured `[realtime/assert] {...}` line.
 *   - In test mode (VITEST or NODE_ENV=test) the assert THROWS so vitest
 *     surfaces the failure as a test error.
 *   - In production it does NOT throw - a thrown exception inside a publish
 *     hot-path microtask or a subscribe callback could leave a half-applied
 *     bookkeeping update or a corrupted index. Counter + log give us
 *     observability without the corruption risk.
 *
 * @module svelte-realtime/shared/assert
 */

const _IS_TEST_MODE = !!(typeof process !== 'undefined' && process && process.env && (process.env.VITEST || process.env.NODE_ENV === 'test'));

/** @type {Map<string, number>} Per-category violation counts; survives the lifetime of the process. */
const counters = new Map();

/** @type {((category: string) => void) | null} */
let onViolation = null;

// Process exit code for a hard-tier invariant violation. Matches the adapter's
// FATAL_EXIT_CODE so one supervisor restart policy can tell crash-on-bad-state
// (78) apart from crash-on-bad-config (1) and a graceful shutdown (0), no matter
// which layer raised it.
const FATAL_EXIT_CODE = 78;

// Injectable termination sink for the hard tier. Defaults to the real process
// exit, guarded so a browser bundle (no `process`) degrades a client-side fatal
// to a log + counter increment instead of throwing a ReferenceError. A test or
// simulation harness swaps this via setFatalSink to capture the exit code
// instead of dying.
let fatalSink = { exit: (code) => { if (typeof process !== 'undefined' && typeof process.exit === 'function') process.exit(code); } };

// Per-call test-mode probe for the hard tier. `assert` keeps its module-load
// snapshot (its behaviour is unchanged), but `fatal` re-reads the env each call
// so a test can exercise the production deferred-exit branch (and reach an
// installed capturing sink) by flipping the env without re-importing the module.
// Computed property access keeps the read genuinely dynamic: a consumer's
// bundler cannot statically inline `process.env.NODE_ENV` and freeze the probe.
function _isTestModeNow() {
	if (typeof process === 'undefined' || !process || !process.env) return false;
	return !!(process.env['VITEST'] || process.env['NODE_ENV'] === 'test');
}

/**
 * Production-safe invariant check.
 *
 * @param {boolean} cond - The condition that should hold. Falsy = violation.
 * @param {string} category - Stable category string for the metric label,
 *   prefixed with `realtime/`. Convention: `realtime/<module>.<invariant>`.
 * @param {Record<string, unknown>} [context] - Serialisable extra context
 *   for the structured log entry. Caller responsibility to omit PII.
 */
export function assert(cond, category, context) {
	if (cond) return;
	counters.set(category, (counters.get(category) || 0) + 1);
	if (onViolation) {
		try { onViolation(category); } catch { /* hook best-effort */ }
	}
	const payload = JSON.stringify(context === undefined ? { category } : { category, context });
	console.error('[realtime/assert] ' + payload);
	if (_IS_TEST_MODE) {
		throw new Error('realtime assertion failed: ' + category + ' ' + payload);
	}
}

/**
 * Hard-tier invariant check, for genuinely unrecoverable server state where
 * continuing risks silent misdelivery (e.g. the forward and reverse
 * subscription indexes have diverged). On violation it records the SAME
 * per-category counter and fires the SAME metrics hook as `assert` (one
 * namespace; the severity rides the structured log as `severity: 'fatal'`),
 * logs a `[realtime/fatal]` line, and then:
 *   - In test mode (VITEST or NODE_ENV=test) it THROWS so vitest surfaces the
 *     failure as a test error.
 *   - In production it schedules a DEFERRED worker termination (exit code 78)
 *     once the current callback frame unwinds. The exit is deferred via a
 *     microtask, never raised synchronously inside a publish/subscribe handler
 *     the adapter invoked from a uWS C++ callback (a sync exit there risks the
 *     same binding-state corruption `assert` avoids by not throwing).
 *   - On a client (no `process`) it degrades to the log + counter only.
 *
 * The exit is routed through an injectable sink (`setFatalSink`) so a test or
 * portability mirror can supply its own backing without killing the runner.
 *
 * @param {boolean} cond - The condition that should hold. Falsy = violation.
 * @param {string} category - Stable category string for the metric label,
 *   prefixed with `realtime/`. Convention: `realtime/<module>.<invariant>`.
 * @param {Record<string, unknown>} [context] - Serialisable extra context
 *   for the structured log entry. Caller responsibility to omit PII.
 */
export function fatal(cond, category, context) {
	if (cond) return;
	counters.set(category, (counters.get(category) || 0) + 1);
	if (onViolation) {
		try { onViolation(category); } catch { /* hook best-effort */ }
	}
	const payload = JSON.stringify(context === undefined ? { category, severity: 'fatal' } : { category, context, severity: 'fatal' });
	console.error('[realtime/fatal] ' + payload);
	if (_isTestModeNow()) {
		throw new Error('realtime fatal: ' + category + ' ' + payload);
	}
	// Deferred termination: the counter, hook, and log above have already
	// recorded the violation. Promise-scheduled so the microtask ordering stays
	// deterministic and no raw timer primitive is introduced into the seam.
	Promise.resolve().then(() => fatalSink.exit(FATAL_EXIT_CODE));
}

/**
 * Install a custom hard-tier termination sink. A test uses this to assert the
 * exit was scheduled without killing the runner; a portability mirror uses it
 * to supply its own backing. Never call this from production code.
 *
 * @param {{ exit(code: number): void }} sink
 */
export function setFatalSink(sink) {
	if (!sink || typeof sink.exit !== 'function') {
		throw new Error('setFatalSink: sink must expose an exit(code) function');
	}
	fatalSink = sink;
}

/**
 * Restore the default termination sink (guarded `process.exit`). Test / sim
 * teardown.
 */
export function resetFatalSink() {
	fatalSink = { exit: (code) => { if (typeof process !== 'undefined' && typeof process.exit === 'function') process.exit(code); } };
}

/**
 * Read the live counter Map. Useful for ops dashboards or tests that want
 * to verify a category was hit without relying on log scraping.
 *
 * @returns {Map<string, number>}
 */
export function getAssertionCounters() {
	return counters;
}

/**
 * Bind a hook fired on every violation alongside the in-memory counter
 * (e.g. server.js wires its Prometheus counter through this). Calling twice
 * replaces the binding. Pass `null` to unwire.
 *
 * @param {((category: string) => void) | null} hook
 */
export function wireAssertionMetrics(hook) {
	onViolation = hook;
}

/**
 * Reset the assertion counters and unwire the metrics hook. Tests only.
 * @internal
 */
export function _resetAssertCounters() {
	counters.clear();
	onViolation = null;
	resetFatalSink();
}
