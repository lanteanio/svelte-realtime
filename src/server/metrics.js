// @ts-check
import { monotonicNow } from '../shared/runtime.js';
import { wireAssertionMetrics } from '../shared/assert.js';
import { state } from './state.js';

/**
 * Record RPC metrics for any exit path. Call exactly once per RPC.
 * @param {string} path
 * @param {string} code - error code, or empty string for success
 * @param {number} startTime - from monotonicNow(), or 0 to skip duration
 */
export function _recordRpcMetrics(path, code, startTime) {
	if (!state.metricsInstruments) return;
	const status = code ? 'error' : 'ok';
	state.metricsInstruments.rpcCount.inc({ path, status });
	if (code) state.metricsInstruments.rpcErrors.inc({ path, code });
	if (startTime) state.metricsInstruments.rpcDuration.observe({ path }, (monotonicNow() - startTime) / 1000);
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
 * See the README "Prometheus metrics" section for a working example that
 * pairs this with `createMetrics()` from `svelte-adapter-uws-extensions/prometheus`.
 *
 * @param {any} registry - Object with counter, histogram, and gauge factories
 */
const _liveMetrics = function metrics(registry) {
	state.metricsInstruments = {
		rpcCount: registry.counter({ name: 'svelte_realtime_rpc_total', help: 'Total RPC calls', labelNames: ['path', 'status'] }),
		rpcDuration: registry.histogram({ name: 'svelte_realtime_rpc_duration_seconds', help: 'RPC call duration', labelNames: ['path'] }),
		rpcErrors: registry.counter({ name: 'svelte_realtime_rpc_errors_total', help: 'Total RPC errors', labelNames: ['path', 'code'] }),
		streamGauge: registry.gauge({ name: 'svelte_realtime_stream_subscriptions', help: 'Active stream subscriptions' }),
		cronCount: registry.counter({ name: 'svelte_realtime_cron_total', help: 'Total cron executions', labelNames: ['path', 'status'] }),
		cronErrors: registry.counter({ name: 'svelte_realtime_cron_errors_total', help: 'Total cron errors', labelNames: ['path'] }),
		assertions: registry.counter({ name: 'svelte_realtime_assertion_violations_total', help: 'Production-assertion violations by category', labelNames: ['category'] })
	};
	wireAssertionMetrics((category) => state.metricsInstruments.assertions.inc({ category }));
};
export function installMetrics(live) { live.metrics = _liveMetrics; }
