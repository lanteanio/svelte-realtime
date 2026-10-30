# Metrics reference

`live.metrics(registry)` registers the series below; the README [Prometheus metrics](../README.md#prometheus-metrics) section shows the setup with the `createMetrics()` registry from `svelte-adapter-uws-extensions/prometheus`.

## Registered metrics

- `svelte_realtime_rpc_total` - RPC call count by path and status
- `svelte_realtime_rpc_duration_seconds` - RPC latency by path, with explicit fractional-second buckets from 1 ms through 10 s
- `svelte_realtime_rpc_errors_total` - RPC errors by path and code, including calls refused before they run (`UNAVAILABLE` during a shutdown drain, `PROTOCOL_MISMATCH`, upload admission limits, `OVERLOADED` from [RPC admission](rpc-admission.md)), which also count in `svelte_realtime_rpc_total`
- `svelte_realtime_rpc_overloaded_total` - calls [RPC admission](rpc-admission.md) refused, by registered `path`, `reason` (`concurrency_limit`, `queue_full`) and `scope` (`connection`, `route`, `global`); the same calls count in `svelte_realtime_rpc_errors_total` with code `OVERLOADED`
- `svelte_realtime_rpc_inflight` - RPC calls of each registered `path` running in this worker, from admission until the handler settles
- `svelte_realtime_rpc_queued` - RPC calls of each registered `path` waiting in this worker's admission queue. Both admission gauges are sampled once a second and written with `set` only when a value changed, so the registry's gauge needs a `set(labels, value)` method (the extensions `createMetrics()` gauge has one)
- `svelte_realtime_upload_limits_total` - upload starts and chunks refused by a limit, by `limit`: `session`, `user`, `process`, `tenant`, `process_bytes` or `tenant_bytes` (no user or tenant ids)
- `svelte_realtime_idempotency_capacity_total` - in-process `live.idempotent` admissions at a capacity limit, by `outcome`: `replaced` (a caller at its own share gave up its oldest result) or `rejected` (`IDEMPOTENCY_CAPACITY`); no caller ids
- `svelte_realtime_rpc_delivery_total` - final text/binary RPC reply attempts by bounded `path` and `outcome`: `delivered` (accepted without pressure, not a client acknowledgement), `backpressure` (buffered or dropped), `closed`, or `exception`. Batch replies count each call; an oversized batch rejection counts once under `__batch__`; early stream attaches, uploads, direct calls and fire-and-forget calls are excluded. Execution success remains independent of delivery.
- `svelte_realtime_stream_subscriptions` - active stream subscription gauge
- `svelte_realtime_cron_total` - cron execution count by path and status
- `svelte_realtime_cron_errors_total` - cron errors by path
- `svelte_realtime_assertion_violations_total` - production-assertion violations by category (see [Production assertions](../README.md#production-assertions))
- `svelte_realtime_webhook_dead_letter_failures_total` - failed webhook deliveries the dead-letter store could not persist (see [Dead-letter queue](../README.md#dead-letter-queue))
- `svelte_realtime_background_*` - cron, alarm, poll, derived, effect, outbound webhook and dead-letter work, one bounded schema described in [Background work metrics](background-metrics.md)

## Cohort-stratified metrics - never trust the aggregate

An aggregate p99 that looks healthy can hide a cohort - old devices, cellular links, a far region - that is entirely broken, because the fast majority drowns it in the quantile. Pass a `cohort` classifier and every RPC execution series carries the caller's cohort label:

```js
live.metrics(registry, {
  // Classified ONCE per connection from whatever your upgrade hook stashed
  // on the connection's user data. Keep the cardinality SMALL.
  cohort: (userData) => `${userData.deviceClass}-${userData.netClass}` // 'desktop-fast', 'mobile-3g', ...
});
```

Distinct labels are bounded at 16 (overflow folds into `'other'`; a pre-identification guard path or a throwing classifier reads `'unknown'`). The unlabeled aggregate stays derivable by summing - dashboard the per-cohort series first and the aggregate as context, not the other way around.

## Per-subsystem performance budgets

Declare how long a subsystem is ALLOWED to take, measure what it ACTUALLY takes, and let the dashboard render budget vs actual over time - the drift is the early warning, the exceeded counter is the alert:

```js
const tickBudget = live.perfBudget('tick', 8); // 8ms per game tick

// Per iteration - either wrap:
tickBudget.measure(() => runTick());
// ...or record a duration you already have:
tickBudget.track(elapsedMs);
```

Emits `svelte_realtime_perf_budget_seconds` (gauge - the declaration), `svelte_realtime_perf_actual_seconds` (histogram), and `svelte_realtime_perf_budget_exceeded_total` (counter), all labeled by `subsystem`. Requires `live.metrics()` first.

## Pause-aware lifeline `/metrics`

A `/metrics` handler that serializes the registry inline competes with whatever is melting the event loop - exactly when you need the numbers most, the scrape adds work or stalls. The lifeline decouples them: the registry is pre-serialized on a background interval into an in-memory snapshot, and the admin route serves THAT string in O(1):

```js
live.metrics(registry, { lifeline: true }); // or { lifeline: { intervalMs: 5000 } }
```

`GET <adminPath>/metrics` (behind the same fail-closed `realtime({ admin })` auth gate as `/dlq` and `/introspect`) answers with the snapshot; its age rides the `x-snapshot-age-ms` header, so the scraper can tell a fresh read from a wedged renderer. Requires a registry with `serialize()` - the extensions `createMetrics()` qualifies. The plain `app.get('/metrics', metrics.handler)` mount remains fine for normal operation; the lifeline is the degraded-day path.
