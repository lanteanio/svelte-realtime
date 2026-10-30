# Background work metrics

Work that runs off the request path reports through one schema, so a single dashboard shows whether it keeps up: how many items ran and how each ended, how long they took, how many are running, how many wait and for how long, and how often a retry policy ran out. svelte-realtime reports its own background work through `live.metrics(registry)`; the durable jobs and tasks of svelte-adapter-uws-extensions report under the same names, so both can share one registry and one dashboard.

The schema is exported as `BACKGROUND_METRICS` from `svelte-realtime/server`, and `live.metrics` registers exactly those descriptors.

## Series

| Metric | Type | Labels | Help |
|---|---|---|---|
| `svelte_realtime_background_total` | counter | `kind`, `result` | Background work items by kind and result |
| `svelte_realtime_background_duration_seconds` | histogram | `kind`, `result` | Background work item run time in seconds by kind and result |
| `svelte_realtime_background_inflight` | gauge | `kind` | Background work items running in this process |
| `svelte_realtime_background_queued` | gauge | `kind` | Background work items waiting to start |
| `svelte_realtime_background_oldest_age_seconds` | gauge | `kind` | Age in seconds of the oldest waiting background work item |
| `svelte_realtime_background_retries_exhausted_total` | counter | `kind` | Background work items that failed on the last attempt their retry policy allows |

The duration histogram uses the bucket bounds 0.001, 0.005, 0.025, 0.1, 0.25, 1, 2.5, 10, 30, 60, 300, 900, 3600 seconds, so a millisecond effect and an hour-long job land in the same series. It observes only items that finished (`ok`, `error`). An item that never started, or that was released at its deadline while still running (`timeout`), is counted, not timed.

The gauges are written with `set`, so the registry's gauge needs a `set(labels, value)` method (the extensions `createMetrics()` gauge has one). `inflight` and `queued` are written once per microtask in which they change. `oldest_age_seconds` is refreshed every second while anything waits and reads 0 when nothing does.

## Across processes

Every gauge describes the process that writes it. Add `inflight` and `queued` across processes (`sum by (kind)`) and take the largest `oldest_age_seconds` (`max by (kind)`). A queue held in shared storage, such as a durable job or task table or a durable dead-letter store, has one depth for the whole cluster, so only one process (the leader) writes its `queued` and `oldest_age_seconds`, and the same sum and maximum stay correct.

## `kind`

Each series of a kind has exactly one producer. A producer registers the whole schema but writes only its own series, so two producers never overwrite each other's gauges. Every kind has one producer for all of its series except `dlq`, whose depth and age come from whichever dead-letter store is configured.

| Kind | Producer | Item | Queue |
|---|---|---|---|
| `cron` | svelte-realtime | One `live.cron` tick | none |
| `alarm` | svelte-realtime | One `live.alarm` firing, timer or recovery poll | none |
| `poll` | svelte-realtime | One `live.poll` callback | none |
| `derived` | svelte-realtime | One `live.derived` recompute | none |
| `effect` | svelte-realtime | One `live.effect` call; a call released at its deadline stays in `inflight` until its handler settles | the effect's in-process queue |
| `webhook` | svelte-realtime | One outbound webhook delivery, all of its retries included | the webhook's in-process queue |
| `dlq` | svelte-realtime | One dead-lettered event replayed by `replayDeadLetter` or the admin route | the dead-letter store |
| `job` | svelte-adapter-uws-extensions | One durable job run | the job table |
| `task` | svelte-adapter-uws-extensions | One durable task attempt | the task table |

`queued` and `oldest_age_seconds` exist only for kinds with a queue. For `dlq`, svelte-realtime writes the count, the duration and `inflight` of replays, and samples `queued` and `oldest_age_seconds` from its built-in in-memory store; a durable dead-letter store from svelte-adapter-uws-extensions writes those two itself, and svelte-realtime then writes no `dlq` depth or age (it sets them to 0 once when its built-in store stops being the configured one).

## `result`

| Result | Meaning |
|---|---|
| `ok` | The item ran and succeeded. |
| `error` | The item ran and failed. |
| `timeout` | The item ran past its deadline and its slot was released. |
| `skipped` | The item was due but did not run: a cron tick while the previous run of that cron is still going, a tick or alarm before a platform is captured, an alarm past `misfireMs`, a dead-lettered event whose webhook is no longer registered. |
| `rejected` | The item arrived while its queue was full and was dropped. |
| `coalesced` | The item replaced the newest waiting item of its queue. |

`retries_exhausted_total` counts items whose last allowed attempt failed. An outbound webhook counts there when it made every attempt of its `retry.attempts` (default 3) and the last one failed; a delivery stopped earlier by the SSRF gate, the breaker, the retry budget or a non-retryable status is an `error` without exhaustion.

## Label bounds

`kind` and `result` take only the values above, and no other label exists. Topics, paths, tenants, users, webhook ids, queue names and payloads never become labels, so the number of series is fixed by the schema: at most 9 kinds by 6 results for the counter and the histogram, and 9 kinds for each gauge and the retry counter.

## Registering the schema in another package

A second producer registers the same six descriptors, every field identical (`name`, `help`, `labelNames`, and `buckets` for the histogram), and passes nothing else, so `maxSeries`, `allowNegative` and `maxBuckets` keep the registry's defaults; svelte-realtime registers them the same way. The extensions `createMetrics()` registry hands back the existing instrument for a repeated name only when all of these fields match, and throws when one differs, so a drifted descriptor fails at startup rather than splitting the series. The histogram declares 13 buckets, within that registry's default `maxBuckets` of 32. The descriptors are plain data:

```js
import { BACKGROUND_METRICS } from 'svelte-realtime/server';

const { total, duration } = BACKGROUND_METRICS;
const runs = registry.counter(total.name, total.help, [...total.labelNames]);
const times = registry.histogram(duration.name, duration.help, { labelNames: [...duration.labelNames], buckets: [...duration.buckets] });
runs.inc({ kind: 'job', result: 'ok' });
```

A package that cannot import svelte-realtime copies the descriptors verbatim; the values in this page are the contract.
