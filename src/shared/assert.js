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
}
