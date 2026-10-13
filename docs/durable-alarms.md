# Durable alarm stores

`configureAlarm({ store })` connects per-room alarms to durable storage. The in-memory default needs no store; a durable store supports scheduling across process restarts and conditional claims across workers.

A durable store must implement this generation contract:

| Method | Contract |
| --- | --- |
| `nextGeneration(topic)` | Atomically reserve a strictly increasing positive decimal-string generation for the topic. Never reuse it, including after deletion or restart. Leave the current scheduled row unchanged. |
| `get(topic)` | Return `{ topic, at, meta, generation }` for the current schedule, or `null`. Read acknowledged writes: cancellation deletes the generation this returns. |
| `set(topic, at, meta, generation)` | Commit only the latest reserved generation, strictly newer than the retained committed/deleted watermark. Return `true` after durable commit; return `false` for an obsolete generation without modifying the row. Reject storage failures. |
| `delete(topic, generation)` | Atomically remove only a matching current generation and return whether it was removed. Resolve after commit. Retain allocation and committed watermarks so delayed writes cannot resurrect consumed schedules. |
| `due(nowMs)` | Optional: return due rows with their exact generations for restart recovery. |

All methods may return promises. Timers and recovery pass the observed generation to `claim`; cancellation passes it to `delete`; a replacement cannot be consumed by an older timer or cancellation. Failed precise claims are retried without invoking the handler. Stores without `due` support live timers but cannot recover alarms after restart or dispatch explicitly requeued executions. Legacy topic-only stores are rejected by `configureAlarm`: upgrade the Redis/PostgreSQL implementation and migrate existing rows to generations together with the realtime release. A claim retains an execution before `onAlarm` runs; successful completion removes that execution. Callback side effects are not transactional with completion, so retries require application idempotency.

## Ordering and recovery

The runtime serializes mutations for a room within a process. Across workers, `nextGeneration` defines the order of scheduling intents before asynchronous persistence. Reserving a newer generation prevents an older in-flight write from committing afterward. A failed newer write leaves the previously committed row intact; reservations do not cancel that row.

Keep both the allocation counter and the last committed generation after a row is cancelled or claimed. They are durable tombstones, not expiring schedule data. A repeated or delayed `set` for a consumed generation must return `false`, and a subsequent reservation must exceed every earlier generation.

Both precise timers and recovery pass the generation of the row they observed. The runtime never refreshes the generation merely to obtain a successful claim. A stale timer, stale recovery snapshot or cancellation therefore cannot consume a replacement. `deleteAlarm()` reads the current durable row with `get` before conditionally deleting it, even when this worker has an older local timer. A replacement committed after that read survives the conditional delete.

`ctx.setAlarm()` and `ctx.deleteAlarm()` resolve only after the store acknowledges the mutation. A rejected or superseded schedule does not replace an acknowledged local timer. Storage claim failures do not run callbacks; precise timers retry their same generation, while recovery retries on a later poll. Graceful shutdown counts an active claim through callback completion and persisted outcome before teardown.

## Migration

Always await `ctx.setAlarm(at)` and `ctx.deleteAlarm()`, or return their promises from the handler. Handle failures with `try`/`catch` or a promise rejection handler: old fire-and-forget calls can now produce an unhandled rejection when storage or capacity refuses a mutation. The default in-memory capacity limit also rejects with `ALARM_CAPACITY`; a fulfilled schedule acknowledges timer installation.

Upgrade every durable store implementation to the complete contract, including the generation fields returned by `get` and `due`. Assign existing scheduled rows valid generations and retain their resolver metadata. Keep allocation and committed watermarks at least as high as the assigned values. Legacy topic-only workers can delete arbitrary replacements, so do not run them concurrently with generation-aware workers against the same alarm namespace.

The Redis and PostgreSQL stores belong to `svelte-adapter-uws-extensions`. Deploy a compatible store release with the realtime release; `configureAlarm` rejects a store missing `nextGeneration` or `get` rather than guessing whether its deletes are conditional.

## Retained executions and explicit retry

A scheduled row and a retained execution are separate records. `claim(topic, generation)` atomically moves the matching schedule into execution storage and returns `{ attempt }`, starting at one. It returns `null` when another worker already claimed or replaced the schedule. A newly scheduled generation can coexist with the earlier execution without either overwriting the other. If execution storage reaches its configured capacity, claiming must reject and leave the scheduled row intact; unresolved executions must never be evicted to make room.

`complete(topic, generation, attempt)` removes only that exact retained attempt after a successful callback, or a deliberate misfire skip. `fail(topic, generation, attempt, { errorClass: 'handler', failedAt })` marks it failed while retaining the original resolver metadata and deadline. Both resolve a boolean after durable commit and return `false` for an obsolete attempt. A failure to record the outcome leaves the existing claim available for inspection unless completion already committed and only its acknowledgement was lost. Raw exception text and callback payloads are not persisted in execution failure metadata.

`getExecution(topic, generation)` returns a retained execution or `null`. `executions({ limit, after })` returns `{ items, next }`, ordered lexically by topic then generation. The exclusive `after` and returned `next` cursors are `{ topic, generation }`; `next` is null at the end. The default page contains at most 100 entries and the maximum is 1000. Each execution contains the original alarm row plus `attempt`, `status` (`claimed` or `failed`), `claimedAt`, `failedAt` (null before failure), and `errorClass` (null or `handler`). Restrict these operator APIs to trusted administrators; wire topics and resolver metadata include tenant scope.

Retry is explicit. `requeue(topic, generation, attempt, { at })` atomically moves a failed execution back to the schedule at the requested epoch-ms time, preserving its generation. It returns `false` without changing either record if the attempt no longer matches, a scheduled row already exists, or any newer generation has been reserved. A retry's next claim increments the attempt. A `claimed` record left after a crash or an uncertain completion requires `{ at, allowAbandoned: true }`; first confirm its previous worker has stopped and inspect application effects. There is no automatic lease expiry or automatic replay of abandoned callbacks. A successful `requeue` writes a schedule only; it does not arm a local timer. Dispatch requires `due(nowMs)` and an enabled recovery poll, on the elected leader when configured. Once due, the row runs on a subsequent eligible poll at the configured `pollMs` cadence (default 15000 ms), subject to callback/store delays and misfire policy. Without `due`, a successful requeue remains stored but does not execute.

`ctx.alarm.generation` and `ctx.alarm.idempotencyKey` identify durable work across attempts. The key is `JSON.stringify([wireTopic, generation])`; scope effect deduplication to this store's namespace. `ctx.alarm.attempt` starts at one. In-memory alarms expose null generation/key and attempt one. Use the stable key with an application transaction or an external service's idempotency facility before enabling retries. A process can stop after committing an effect and before acknowledging completion, so callback execution and external effects are not exactly once.

Deploy stores implementing `claim`, `complete`, `fail`, `getExecution`, `executions`, and `requeue` together with the runtime. Existing scheduled rows need the generation migration above; retained attempts require durable storage and must survive store/process restarts. Cancellation removes scheduled work only; it does not erase a running or failed execution. After inspecting an execution and intentionally discarding its work, an operator may call `complete` with its exact generation and attempt to remove the retained record.
