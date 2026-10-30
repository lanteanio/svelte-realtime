# Erasure jobs

A failed or interrupted erasure must not be forgotten, so `configureForget({ jobs: true })` (in-memory) or `configureForget({ jobs: store })` (a `ForgetJobStore` that survives restarts) records every `live.forget` as a job. The intent is recorded before any surface is touched - if that write fails the call rejects with `FORGET_JOB_FAILED` and erases nothing - and the outcome afterwards. With a job store configured, `tenantId` is required.

The job reference (`res.job`, `details.job` on a rejection, the `job` attribute of `forget.incomplete`) is 32 hex characters of SHA-256 over `[tenantId, userId]`, or HMAC-SHA-256 with the configured `hashKey`, so the same user and tenant always reuse one job and neither logs nor listings carry the user id.

`listForgetJobs({ status, limit })` lists jobs with their status (`pending`, `failed`, `completed`), attempt count, timestamps and last failure code and surfaces. `resumeForgetJobs({ id, limit, onForget })` runs failed jobs and pending jobs whose process died part-way again, with their stored tenant and cascade. Run it at startup and on a schedule. A job holds the raw user id only until it completes.
