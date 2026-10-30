# Erasure jobs

A failed or interrupted erasure must not be forgotten, so `configureForget({ jobs: true })` (in-memory) or `configureForget({ jobs: store })` (a `ForgetJobStore` that survives restarts) records every `live.forget` as a job. The intent is recorded before any surface is touched - if that write fails the call rejects with `FORGET_JOB_FAILED` and erases nothing - and the outcome afterwards. With a job store configured, `tenantId` is required.

Every call is its own job under a random UUID. Workers that erase the same user at once (aggregates are per worker) each record their own outcome, so one worker's failure is never hidden by another's success, and the reference reveals nothing about the user. The reference is `res.job` on success, the non-enumerable `job` property of a rejection (never part of `details`, so an error rethrown to a client does not carry it), and the `job` attribute of `forget.incomplete`.

`listForgetJobs({ status, limit })` lists jobs with their status (`pending`, `failed`, `completed`), attempt count, timestamps and last failure code and surfaces. `resumeForgetJobs({ id, limit, onForget })` runs failed jobs and pending jobs whose process died part-way again, with their stored tenant and cascade. Run it at startup and on a schedule. A job holds the raw user id only until it completes.
