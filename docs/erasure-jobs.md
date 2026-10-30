# Erasure jobs

A failed or interrupted erasure must not be forgotten, so `configureForget({ jobs: true })` (in-memory) or `configureForget({ jobs: store })` (a `ForgetJobStore` that survives restarts) records every `live.forget` as a job. The intent is recorded before any surface is touched - if that write fails the call rejects with `FORGET_JOB_FAILED` and erases nothing - and the outcome afterwards. With a job store configured, `tenantId` is required.

Every call is its own job under a random UUID, so the reference reveals nothing about the user. The reference is `res.job` on success, the non-enumerable `job` property of a rejection (never part of `details`, so an error rethrown to a client does not carry it), and the `job` attribute of `forget.incomplete`.

## Processes and steps

An erasure has two kinds of steps:

- **In-memory steps** - push, presence, rate limits, idempotency, smooth state, live aggregates, named CRDT documents, and the built-in in-memory dead-letter store. Their data lives in one process. A job's in-memory steps are those of the process that called `live.forget`, the job's owner, and only the owner runs them.
- **Shared steps** - the durable store (`configureForget({ store })`) and a dead-letter store other than the built-in one. Their data is shared, so any process can finish them.

In a cluster, each process's in-memory state is erased by a `live.forget` on that process: call it on every worker, as for aggregates. Each call is its own job, owned by its process, and one worker's failure is never hidden by another's success.

A process with a job store reports that it is alive every 10 seconds; a process that has not reported for 30 seconds is gone. When a job's owner is alive, it finishes its own in-memory steps when it resumes its jobs, while any process may finish the shared steps. When the owner is gone, its in-memory state went with it: its open in-memory steps no longer need doing, and the job completes once the shared steps are done, wherever they run. An in-memory step that the owner finished is never run again, even when the store did not record it in time, so a dropped document or reset aggregate that holds new data by now is left alone.

## Listing and resuming

`listForgetJobs({ status, limit })` lists jobs with their owner (`processId`), status (`pending`, `failed`, `exhausted`, `completed`, `abandoned`), attempt count, timestamps, `retryAt`, total rows removed and last failure code and surfaces. A job holds the raw user id only until it completes.

`resumeForgetJobs({ id, limit, onForget })` runs unfinished jobs this process has work in. Run it at startup and on a schedule on every process. Without `id` it takes the jobs that are due, earliest due first:

- a failed job once its `retryAt` has passed. The delay doubles with each attempt, from one second up to an hour, so a job that keeps failing yields to jobs that can finish instead of taking every resume;
- a pending job whose run never recorded an outcome (its process died, or the store was unreachable) once no live run holds it.

With `id` it runs that job whatever its retry time. A run first claims the job, so a job a run of another live process holds reports `skipped`, and two processes never run one job together. A run reports `waiting` when it did its part and only a live owner's in-memory steps remain; the owner then finds the job due at once. The stored `cascade` is replayed only in a shape `live.forget` accepts; a damaged record fails with `INVALID_REQUEST` and stays listed as a failed job.

## Jobs that cannot finish

A job that fails on 24 runs stops running by itself: it becomes `exhausted`, stays listed with its last error, and `forget.job-exhausted` reports it. Exhausted jobs no longer count against the in-memory store's capacity. Fix the cause and run it with `resumeForgetJobs({ id })`, or give it up with `abandonForgetJob(id)`, which marks it `abandoned` and drops its user id. A job a live run is working on is not abandoned. A shared step whose store has since been removed from the configuration fails on every run until the store is configured again or the job is abandoned.

## Time bounds

Every store call a run waits on - `begin` or `claim`, each in-memory surface, the durable store and the outcome write - can be bounded with `configureForget({ timeoutMs })`, with or without a job store; without it (the default) an erasure waits as long as the store takes. A call that does not answer in time fails its surface, so a hung store cannot hold `live.forget` forever and does not keep the other surfaces from running. A durable purge that commits after its timeout still announces the owner changes it reports. The call itself keeps running in the store, so every surface must tolerate a late finish.

## In-memory store

`createForgetJobStore({ max })` holds at most `max` jobs (default 10000). A new job makes room by dropping the oldest job that will not run by itself again: completed or abandoned first, then exhausted ones, which were reported when they stopped. A pending or failed job is never dropped: while every held job is one, `live.forget` rejects with `FORGET_JOB_FAILED` before erasing anything, so no erasure goes unrecorded. Resume the open jobs to make room. The store lives in one process and does not survive a restart.

## Store contract

A store that must survive restarts implements these methods, each atomic per job `id`; every method may return a promise. Times are the wall-clock values realtime passes, so processes need clocks that agree to well within the 30-second liveness window.

A process is alive while the latest `aliveUntil` it reported - through `beat`, `begin` or `claim` - is later than the `at` of the question. A job's lease belongs to one run of one process and holds while that process is alive. Process P may claim an unfinished job when no run of another live process holds it and P has work there: an open shared step, its own job, or the job of an owner that is gone.

| Method | Contract |
| --- | --- |
| `beat({ processId, at, aliveUntil })` | Record the process as alive until `aliveUntil`. |
| `begin({ id, runId, processId, aliveUntil, userIdHash, tenantId, userId, cascade, shared, local, at })` | Record the process as alive, then create a `pending` job with `attempts: 1` and `rowsAffected: 0`, owned by `processId`, with open steps `shared` and `local`, whose run `runId` holds the lease. Durable before it resolves. Reject when `id` exists. |
| `claim({ id, runId, processId, aliveUntil, at })` | Record the process as alive. If it may claim the job, give the lease to `runId`, set `pending`, increment `attempts`, set `updatedAt`, and resolve `{ userId, userIdHash, tenantId, cascade, attempts, owner, ownerAlive, shared, local }`. Otherwise resolve `null` and change nothing. A failed job is claimable before its `retryAt`. |
| `complete({ id, runId, at, rowsAffected })` | Only when `runId` holds the lease: set `completed`, `completedAt` and `updatedAt`, add `rowsAffected`, clear `error`, release the lease, delete `userId`, `cascade` and the step lists, resolve `true`. Otherwise resolve `false`. |
| `fail({ id, runId, at, code, failedSurfaces, sharedDone, localDone, rowsAffected, retryAt, exhausted })` | Only when `runId` holds the lease: set `failed` (or `exhausted`, never due again but still claimable), `error: { code, failedSurfaces }`, `updatedAt` and `retryAt`, remove `sharedDone` from the open shared steps and `localDone` from the open in-memory steps, add `rowsAffected`, release the lease, keep `userId` and `cascade`, resolve `true`. Otherwise resolve `false`. |
| `abandon({ id, at, runId })` | When the job is pending, failed or exhausted and no run of a live process holds it (or `runId` does): set `abandoned`, release the lease, delete `userId`, `cascade` and the step lists, resolve `true`. Otherwise resolve `false`. An abandoned job is never claimed. |
| `list({ status, limit })` | Jobs oldest `createdAt` first, optionally one status, at most `limit`, without `userId`, `cascade` or step lists. |
| `due({ at, limit, processId })` | Pending or failed jobs `processId` may claim at `at` whose due time has come - a failed job's `retryAt`, a pending job's creation - earliest due first, then `createdAt`; at most `limit`. |

In PostgreSQL the liveness reports are a table of `(process_id, alive_until)`, and `claim` is one `UPDATE ... WHERE id = $id AND status <> 'completed' AND (lease_run_id IS NULL OR lease_process_id = $processId OR <lease process not alive>) AND (cardinality(shared) > 0 OR owner = $processId OR <owner not alive>) RETURNING ...`; `complete` and `fail` add `AND lease_run_id = $runId`. In Redis each method is one script over the job hash, a due sorted set and a hash of liveness times.

An outcome a store does not record (it throws, times out, or answers `false` because the run no longer holds the lease) leaves the job unfinished and emits `forget.job-unrecorded`; the job is due again once no live run holds it.
