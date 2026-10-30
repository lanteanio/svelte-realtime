# Erasure jobs

A failed or interrupted erasure must not be forgotten, so `configureForget({ jobs: true })` (in-memory) or `configureForget({ jobs: store })` (a `ForgetJobStore` that survives restarts) records every `live.forget` as a job. The intent is recorded before any surface is touched - if that write fails the call rejects with `FORGET_JOB_FAILED` and erases nothing - and the outcome afterwards. With a job store configured, `tenantId` is required.

Every call is its own job under a random UUID. Workers that erase the same user at once (aggregates are per worker) each record their own outcome, so one worker's failure is never hidden by another's success, and the reference reveals nothing about the user. The reference is `res.job` on success, the non-enumerable `job` property of a rejection (never part of `details`, so an error rethrown to a client does not carry it), and the `job` attribute of `forget.incomplete`.

A run erases the in-memory state of the process it runs in and the durable store; a resumed run does the same in the process that resumes it. In-memory state of a process that has exited is gone with it.

## Listing and resuming

`listForgetJobs({ status, limit })` lists jobs with their status (`pending`, `failed`, `completed`), attempt count, timestamps, `retryAt` and last failure code and surfaces. A job holds the raw user id only until it completes.

`resumeForgetJobs({ id, limit, onForget })` runs unfinished jobs again with their stored tenant and cascade. Run it at startup and on a schedule. Without `id` it takes the jobs that are due, longest due first:

- a failed job once its `retryAt` has passed. The delay doubles with each attempt, from one second up to an hour, so a job that keeps failing yields to jobs that can finish instead of taking every resume;
- a pending job whose run never recorded an outcome (its process died, or the store was unreachable) once that run's lease has ended.

With `id` it runs that job whatever its retry time. Each run first claims the job's lease, so a job another run holds - in this process or any other - reports `skipped`, and two replicas resuming at once never run the same job together.

A resumed run leaves out the surfaces an earlier run of the job already finished and runs only the rest. That matters for the surfaces that are not repeatable without harm: a named CRDT document dropped by the first run may be in use again, and an aggregate reset by it may hold other users' data by now. The stored `cascade` is replayed only in a shape `live.forget` accepts; a damaged record fails with `INVALID_REQUEST` and stays listed as a failed job.

## Time bounds

Every store call a run waits on - `begin` or `claim`, each in-memory surface, the durable store and the outcome write - is bounded by `configureForget({ timeoutMs })` (default 30 seconds), with or without a job store. A call that does not answer in time fails its surface, so a hung store cannot hold `live.forget` forever and does not keep the other surfaces from running. The call itself keeps running in the store, so every surface must tolerate a late finish; a timed-out `begin` may still create the job, which then falls due when its lease ends.

A lease lasts the number of bounded waits in one run plus one, times `timeoutMs`. A live run therefore records its outcome while it still holds the lease, and only a run whose process died lets its job fall due.

## In-memory store

`createForgetJobStore({ max })` holds at most `max` jobs (default 10000). A new job makes room by dropping the oldest completed job. An unfinished job is never dropped: while every held job is unfinished, `live.forget` rejects with `FORGET_JOB_FAILED` before erasing anything, so no erasure goes unrecorded. Resume the unfinished jobs to make room. The store does not survive a restart.

## Store contract

A store that must survive restarts implements these methods, each atomic per job `id`; every method may return a promise. Times are the wall-clock values realtime passes, so replicas need clocks that agree to well within the lease.

| Method | Contract |
| --- | --- |
| `begin({ id, runId, userIdHash, tenantId, userId, cascade, at, leaseUntil })` | Create a `pending` job with `attempts: 1` whose lease `runId` holds until `leaseUntil`. Durable before it resolves. Reject when `id` exists. |
| `claim({ id, runId, at, leaseUntil })` | If the job is unfinished and no other run's lease is still running at `at`, give the lease to `runId` until `leaseUntil`, set `pending`, increment `attempts`, set `updatedAt`, and resolve `{ userId, userIdHash, tenantId, cascade, attempts, doneSurfaces }`. Otherwise resolve `null` and change nothing. A failed job is claimable before its `retryAt`. |
| `complete({ id, runId, at, rowsAffected, surfaces })` | Only when `runId` holds the lease: set `completed`, `completedAt`, `updatedAt` and `rowsAffected`, clear `error`, release the lease, delete `userId`, `cascade` and the finished surfaces, resolve `true`. Otherwise resolve `false`. |
| `fail({ id, runId, at, code, failedSurfaces, doneSurfaces, retryAt })` | Only when `runId` holds the lease: set `failed`, `error: { code, failedSurfaces }`, `updatedAt` and `retryAt`, add `doneSurfaces` to the set `claim` returns, release the lease, keep `userId` and `cascade`, resolve `true`. Otherwise resolve `false`. |
| `list({ status, limit })` | Jobs oldest `createdAt` first, optionally one status, at most `limit`, without `userId` or `cascade`. |
| `due({ at, limit })` | Unfinished jobs claimable at `at` - failed with `retryAt <= at`, pending with the lease ended - ordered by the time each became due, then `createdAt`; at most `limit`. |

A single `due_at` column (or sorted-set score) holds the lease end while a run holds the job and `retryAt` after a failure, so `due` is one range read. In PostgreSQL `claim` is `UPDATE ... SET lease_run_id = $runId, due_at = $leaseUntil, attempts = attempts + 1 WHERE id = $id AND status <> 'completed' AND (lease_run_id IS NULL OR due_at <= $at) RETURNING ...`, and `complete`/`fail` add `AND lease_run_id = $runId`; in Redis each method is one script over the job hash and the due sorted set.

An outcome a store does not record (it throws, times out, or answers `false` because the run no longer holds the lease) leaves the job unfinished and emits `forget.job-unrecorded`; the job becomes due again when the lease ends.
