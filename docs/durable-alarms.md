# Durable alarm stores

`configureAlarm({ store })` connects per-room alarms to durable storage. The in-memory default needs no store; a durable store supports scheduling across process restarts and conditional claims across workers.

A durable store must implement this generation contract:

| Method | Contract |
| --- | --- |
| `nextGeneration(topic)` | Atomically reserve a strictly increasing positive decimal-string generation for the topic. Never reuse it, including after deletion or restart. Leave the current scheduled row unchanged. |
| `get(topic)` | Return `{ topic, at, meta, generation }` for the current schedule, or `null`. |
| `set(topic, at, meta, generation)` | Commit only the latest reserved generation, strictly newer than the retained committed/deleted watermark. Return `true` after durable commit; return `false` for an obsolete generation without modifying the row. Reject storage failures. |
| `delete(topic, generation)` | Atomically remove only a matching current generation and return whether it was removed. Resolve after commit. Retain allocation and committed watermarks so delayed writes cannot resurrect consumed schedules. |
| `due(nowMs)` | Optional: return due rows with their exact generations for restart recovery. |

All methods may return promises. Timers, recovery, and cancellation pass the observed generation to `delete`; a replacement cannot be consumed by an older timer or cancellation. Failed precise claims are retried without invoking the handler. Stores without `due` support live timers but cannot recover alarms after restart. Legacy topic-only stores are rejected by `configureAlarm`: upgrade the Redis/PostgreSQL implementation and migrate existing rows to generations together with the realtime release. A claimed alarm is consumed before `onAlarm` runs; callback side effects are not transactional with the claim.

## Ordering and recovery

The runtime serializes mutations for a room within a process. Across workers, `nextGeneration` defines the order of scheduling intents before asynchronous persistence. Reserving a newer generation prevents an older in-flight write from committing afterward. A failed newer write leaves the previously committed row intact; reservations do not cancel that row.

Keep both the allocation counter and the last committed generation after a row is cancelled or claimed. They are durable tombstones, not expiring schedule data. A repeated or delayed `set` for a consumed generation must return `false`, and a subsequent reservation must exceed every earlier generation.

Both precise timers and recovery pass the generation of the row they observed. The runtime never refreshes the generation merely to obtain a successful claim. A stale timer, stale recovery snapshot or cancellation therefore cannot consume a replacement. `deleteAlarm()` uses the locally acknowledged generation when present; after restart it reads the current row with `get` before conditionally deleting it.

`ctx.setAlarm()` and `ctx.deleteAlarm()` resolve only after the store acknowledges the mutation. A rejected or superseded schedule does not replace an acknowledged local timer. Storage claim failures do not run callbacks; precise timers retry their same generation, while recovery retries on a later poll. Graceful shutdown counts an active claim through callback completion before teardown.

## Migration

Upgrade every durable store implementation to the complete contract, including the generation fields returned by `get` and `due`. Assign existing scheduled rows valid generations and retain their resolver metadata. Keep allocation and committed watermarks at least as high as the assigned values. Legacy topic-only workers can delete arbitrary replacements, so do not run them concurrently with generation-aware workers against the same alarm namespace.

The Redis and PostgreSQL stores belong to `svelte-adapter-uws-extensions`. Deploy a compatible store release with the realtime release; `configureAlarm` rejects a store missing `nextGeneration` or `get` rather than guessing whether its deletes are conditional.
