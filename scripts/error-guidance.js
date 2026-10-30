// Operator guidance for docs/errors.md. Build-time only: nothing in src imports
// this module, so the guidance adds no bytes to the runtime or the client.
//
// The generator fails until every runtime code and every failure event the
// runtime emits has an entry here, and refuses entries for codes or events the
// runtime no longer emits. Fields are plain ASCII prose.

/** @typedef {{ cause: string, consequence: string, automaticRecovery: string, nextAction: string }} Guidance */

/** @type {Readonly<Record<string, Readonly<Guidance>>>} */
export const CODE_GUIDANCE = Object.freeze({
	ALARM_CAPACITY: Object.freeze({
		cause: 'A `ctx.setAlarm(at)` call needs a new alarm slot while this process already holds its limit of 100,000 pending or reserved alarms. Rescheduling a room that already has an alarm does not count against the limit.',
		consequence: 'The promise returned by `ctx.setAlarm` rejects with an ALARM_CAPACITY LiveError. No new alarm is scheduled, and alarms that were already acknowledged stay in place.',
		automaticRecovery: 'None. The refused schedule is not retried.',
		nextAction: 'Await `ctx.setAlarm` and handle the rejection. Delete alarms for rooms that no longer need them, or spread rooms over more instances, then schedule again.'
	}),
	CANCELLED: Object.freeze({
		cause: 'The client called `cancel()` on an upload handle or aborted its signal, or the server received the client\'s cancel frame for an upload that is still running.',
		consequence: 'On the client, the upload promise rejects with RpcError CANCELLED. On the server, the handler\'s upload iterator and signal abort with a CANCELLED LiveError, and buffered chunks are dropped.',
		automaticRecovery: 'None. A cancelled upload stream cannot be resumed.',
		nextAction: 'Treat it as a deliberate stop. Release any partial state in the handler when its signal aborts. To send the data again, start a new upload.'
	}),
	CONNECTION_CLOSED: Object.freeze({
		cause: 'The client connection closed for good: an explicit close, a terminal close code, a failed auth preflight, or no reconnect attempts left. On the server, the socket closed while a subscribe, document sync or smooth sync was still running.',
		consequence: 'Pending and new RPCs, uploads, `loadMore()` calls and stream subscribes reject with RpcError CONNECTION_CLOSED. Streams keep their data but switch to the error state. Server syncs throw a LiveError and release what they held.',
		automaticRecovery: 'None. Nothing reconnects after the connection closes for good, and `configure({ url, auth })` is ignored from then on.',
		nextAction: 'Show the user that the connection is offline. Find out why it closed (auth, close code, retry budget), fix that, then call the adapter `connect()` explicitly to open a new connection.'
	}),
	DISCONNECTED: Object.freeze({
		cause: 'The socket dropped or was replaced while a request was in flight, or a request outlived its timeout by a margin that points to device sleep. On the server, the client socket closed during an upload.',
		consequence: 'Sent RPCs and uploads reject with RpcError DISCONNECTED. A stream shows the error. On the server, the upload handler\'s iterator and signal abort with a DISCONNECTED LiveError, and no reply is sent.',
		automaticRecovery: 'The adapter reconnects, streams subscribe again with backoff, and unsent calls keep waiting. Offline-queue replays stay queued. Other RPCs and uploads are not retried.',
		nextAction: 'Retry calls that are safe to repeat, ideally with an idempotency key, or enable the offline queue. Start uploads again from the beginning. Check the network or proxy if this happens often.'
	}),
	FLOW_BACKPRESSURE: Object.freeze({
		cause: 'An upload chunk arrives larger than the receive credit the server granted, so the client sent more than the flow-control window allows.',
		consequence: 'The server aborts the upload and answers FLOW_BACKPRESSURE; the handler\'s iterator and signal abort with the same code, so the upload does not complete.',
		automaticRecovery: 'None. The aborted upload stream cannot be resumed.',
		nextAction: 'Use the shipped client, which waits for credit before sending. A custom or outdated client must follow the credit-mode framing in docs/upload-wire.md, then start a new upload.'
	}),
	FORBIDDEN: Object.freeze({
		cause: 'An authenticated caller fails an access check: a guard, `live.access` predicate, stream filter, subscribe hook, document or smooth read gate, or an owner-only room action. It also covers revoked stream access, a changed derived scope, and room membership being erased.',
		consequence: 'The RPC or stream rejects with RpcError FORBIDDEN, and server code receives a LiveError. The stream\'s `error` store is set and the subscription is released. Anonymous callers get UNAUTHENTICATED instead.',
		automaticRecovery: 'None. A denied stream or call is not retried.',
		nextAction: 'Check the caller\'s permissions and the access rule. After a scope or access change, subscribe again. A message ending in `subscribe denied: RATE_LIMITED` means the adapter rate-limited the topic subscribe; retry later.'
	}),
	FORGET_INCOMPLETE: Object.freeze({
		cause: '`live.forget(userId)` tried every erasure surface, but at least one in-memory or named-document cleanup failed.',
		consequence: '`live.forget` rejects with a FORGET_INCOMPLETE LiveError, a `forget.incomplete` event names the failed surfaces, and `onForget` does not run. The surfaces that succeeded stay erased.',
		automaticRecovery: 'None. The erasure is not retried by itself. With a job store the job is recorded as failed under the reference in `details.job`.',
		nextAction: 'Find the failing surface from the `forget.incomplete` event, fix it, and call `live.forget` again with the same arguments, or `resumeForgetJobs()` with a job store. It is safe to repeat.'
	}),
	FORGET_JOB_FAILED: Object.freeze({
		cause: 'The erasure job store wired with `configureForget({ jobs })` throws or rejects when `live.forget` records the job before erasing, or when `listForgetJobs` or `resumeForgetJobs` reads it.',
		consequence: 'From `live.forget` nothing was erased: the job is recorded before any surface is touched, so the call rejects with a FORGET_JOB_FAILED LiveError carrying the job reference in `details.job`. A listing or resume rejects without running anything.',
		automaticRecovery: 'None. The erasure does not start without its job record.',
		nextAction: 'Fix the job store (connectivity, permissions, schema), then call `live.forget` or `resumeForgetJobs()` again.'
	}),
	FORGET_STORE_FAILED: Object.freeze({
		cause: 'The durable erasure store wired with `configureForget({ store })` threw from `purgeUser` during `live.forget(userId)`.',
		consequence: '`live.forget` rejects with a FORGET_STORE_FAILED LiveError and the erasure is incomplete. Owner successions the store already committed are still announced, and a `forget.incomplete` event names the durable surface.',
		automaticRecovery: 'None. The durable purge is not retried by itself. With a job store the job is recorded as failed under the reference in `details.job`.',
		nextAction: 'Fix the store (connectivity, permissions, schema), then call `live.forget` again, or `resumeForgetJobs()` with a job store. A repeat call only reprocesses the rooms that failed.'
	}),
	IDEMPOTENCY_CAPACITY: Object.freeze({
		cause: 'A `live.idempotent` call brings a new key while the default in-process store is full: 10,000 running and cached entries overall. With a tenant resolver configured, each tenant and the unscoped bucket are also capped at 1,000 and the last 1,000 slots are kept for small tenants; without one, unscoped callers may use the whole store.',
		consequence: 'The call rejects with an IDEMPOTENCY_CAPACITY LiveError (RpcError on the client) and the handler does not run. Cached results for keys already stored can still be returned.',
		automaticRecovery: 'Offline-queue replays pause and try again about one second later. Other callers are not retried, and slots free up as entries expire.',
		nextAction: 'Retry with the same key and payload after a short backoff. Under sustained load, shorten the TTL or configure a durable idempotency store.'
	}),
	IDEMPOTENCY_COMMIT_UNKNOWN: Object.freeze({
		cause: 'The handler wrapped by `live.idempotent` finished successfully, but the store\'s `commit` threw, so the runtime cannot tell whether the result was recorded.',
		consequence: 'The call rejects with an IDEMPOTENCY_COMMIT_UNKNOWN LiveError carrying the store error as its cause. The handler\'s side effect may already have happened, and the slot is left for the store to resolve.',
		automaticRecovery: 'None. The slot is kept on purpose so that a retry cannot run the effect a second time.',
		nextAction: 'Check whether the effect happened before you retry. Investigate the store failure. A retry with the same key returns the cached result if the commit actually landed.'
	}),
	IDEMPOTENCY_IN_PROGRESS: Object.freeze({
		cause: 'A call arrives with an idempotency key that a durable store still lists as pending for an earlier request, and that request does not finish within five seconds of polling.',
		consequence: 'The call rejects with an IDEMPOTENCY_IN_PROGRESS LiveError (RpcError on the client). The original request keeps running and is not cancelled.',
		automaticRecovery: 'Offline-queue replays pause and try again about one second later. Other callers are not retried.',
		nextAction: 'Retry with the same key and payload after a short backoff. If it keeps happening, look for slow handlers or pending entries that never clear in the store.'
	}),
	IDEMPOTENCY_KEY_REUSED: Object.freeze({
		cause: 'An idempotency key that already has a cached result arrives with request arguments whose fingerprint differs from the original call.',
		consequence: 'The call rejects with an IDEMPOTENCY_KEY_REUSED LiveError (RpcError on the client). The handler does not run, and the earlier cached result is not returned.',
		automaticRecovery: 'None.',
		nextAction: 'Use a new idempotency key for each distinct request, and resend exactly the same payload when you retry one. Check any `keyFrom` function for keys that collide.'
	}),
	INTERNAL: Object.freeze({
		cause: 'A server capability is missing or failed: the adapter lacks the CRDT or smooth plugin or a required feature, the plugin failed to load, a document load failed, or `live.tenant(...).publish` ran before the server platform was wired.',
		consequence: 'The `live.doc`, `live.smooth` or tenant publish call throws an INTERNAL LiveError, and the client receives it as RpcError INTERNAL. The document or smooth topic does not attach.',
		automaticRecovery: 'A failed plugin load is attempted again on the next call. Version and wiring errors persist until the deployment changes.',
		nextAction: 'Upgrade svelte-adapter-uws to the version named in the message, check the document storage backend, or publish only after the realtime server is wired. Inside handlers, use `ctx.tenant(id).publish`.'
	}),
	INTERNAL_ERROR: Object.freeze({
		cause: 'An RPC, binary RPC or upload handler throws something that is not a LiveError.',
		consequence: 'The client receives RpcError INTERNAL_ERROR with the message \'Internal server error\'. The original error is hidden from the client, passed to `onError` and reported in an operational event.',
		automaticRecovery: 'None.',
		nextAction: 'Find the operational event or `onError` log for the path and fix the handler. Throw a LiveError with a specific code for failures the client is expected to handle.'
	}),
	INVALID_ARG: Object.freeze({
		cause: '`ctx.skip(key, ms)` received a key that is not a string, or an `ms` value that is not a positive finite number.',
		consequence: '`ctx.skip` throws an INVALID_ARG LiveError, which fails the current handler unless it catches the error.',
		automaticRecovery: 'None.',
		nextAction: 'Pass a string key and a positive number of milliseconds to `ctx.skip`.'
	}),
	INVALID_REQUEST: Object.freeze({
		cause: 'A request is malformed or uses an API the wrong way: a bad path, args that are not an array, an oversized batch, a reserved topic, a stream that is called instead of subscribed, args that cannot be encoded, or bad `live.forget`, `persistKey` or `idempotencyKey` arguments.',
		consequence: 'The call is refused before the handler runs. The client receives RpcError INVALID_REQUEST, and server APIs throw a LiveError. Uploads with a bad header, an out-of-order chunk or an invalid server credit are aborted.',
		automaticRecovery: 'None, except that an upload sent to a server without receiver credits is sent once more in the older framing.',
		nextAction: 'Fix the call according to the message. Keep batches within the limit, pass JSON-encodable arrays as args, subscribe to streams, and avoid reserved topic prefixes. Do not resend the same request unchanged.'
	}),
	INVALID_TOPIC: Object.freeze({
		cause: 'A ctx publish helper or `tenant.publish()` receives a topic that starts with \'__\', which is reserved for the framework, or a connection without a tenant publishes to a topic with the tenant prefix.',
		consequence: 'The publish throws an INVALID_TOPIC LiveError and nothing is broadcast.',
		automaticRecovery: 'None.',
		nextAction: 'Rename the topic. For an intentional cross-tenant publish, use `ctx.tenant(id).publish(...)`. Use `platform.publish(...)` only for deliberate system channels.'
	}),
	INVALID_USER_ID: Object.freeze({
		cause: '`ctx.signal(userId, ...)` received a value that is not a non-empty string of at most 256 characters, or that contains a control character, double quote or backslash.',
		consequence: 'The signal is not published, and the caller receives an INVALID_USER_ID LiveError whose message carries the stable ID REALTIME-ERR-INVALID-USER-ID.',
		automaticRecovery: 'None. Malformed identity input is not retried.',
		nextAction: 'Pass the canonical validated user ID that `enableSignals()` uses. Do not retry with the same malformed value.'
	}),
	LOAD_MORE_ERROR: Object.freeze({
		cause: 'A stream\'s `loadMore()` request fails with an error that is not an RpcError.',
		consequence: 'The `loadMore()` promise rejects with RpcError LOAD_MORE_ERROR. Rows already loaded stay in place, and the stream can request the next page again.',
		automaticRecovery: 'None. The failed page is not requested again automatically.',
		nextAction: 'Catch the rejection and call `loadMore()` again when the user retries. If it keeps happening, check the server-side pagination handler.'
	}),
	LOCK_CLEARED: Object.freeze({
		cause: 'The default in-process lock was reset through `_resetLock()` while callers were still waiting to acquire it.',
		consequence: 'Every queued `live.lock` caller rejects with a LOCK_CLEARED LiveError without running its handler. A handler that already holds the lock keeps running.',
		automaticRecovery: 'None.',
		nextAction: 'Use `_resetLock()` only for test isolation, between tests and never while requests are in flight. In application code, retry the call if it is safe to repeat.'
	}),
	LOCK_EXECUTION_TIMEOUT: Object.freeze({
		cause: 'A `live.lock` handler configured with `maxExecutionMs` runs past that deadline.',
		consequence: 'The caller rejects with a LOCK_EXECUTION_TIMEOUT LiveError and `ctx.lockSignal` is aborted. The lock stays held until the handler actually finishes, so waiters behind it keep waiting.',
		automaticRecovery: 'None. The handler is signalled but not killed.',
		nextAction: 'Make the handler watch `ctx.lockSignal` and stop when it aborts. Speed up the work, or raise `maxExecutionMs` if the deadline is too tight. Check whether the effect happened before retrying.'
	}),
	LOCK_QUEUE_FULL: Object.freeze({
		cause: 'A `live.lock` key already has `maxWaitersPerKey` callers queued (1,000 by default) when another caller arrives.',
		consequence: 'The new caller rejects with a LOCK_QUEUE_FULL LiveError and its handler does not run. Callers already queued keep their place.',
		automaticRecovery: 'None.',
		nextAction: 'Retry with backoff. Reduce contention on hot keys, shorten the time the lock is held, or set `maxWaitMs` so waiters give up sooner.'
	}),
	LOCK_TIMEOUT: Object.freeze({
		cause: 'A caller queued behind a `live.lock` key does not get the lock within the configured `maxWaitMs`. A custom Lock that throws its own LOCK_TIMEOUT is rewrapped the same way.',
		consequence: 'The waiting call rejects with a LOCK_TIMEOUT LiveError and its handler never runs. Its `key` and `maxWaitMs` fields exist only on the server; the client receives an RpcError with the code and message. The current holder and later waiters continue undisturbed.',
		automaticRecovery: 'None. The call is not retried and other waiters keep their queue order.',
		nextAction: 'Find out why the lock is held so long, or raise `maxWaitMs`. Retry the call after a delay and watch the lock wait-timeout metric.'
	}),
	NOT_FOUND: Object.freeze({
		cause: 'An RPC, stream, binary or upload names a path with no registered live function, a server-side direct call names an unknown function, or `live.push` finds no active connection for the target userId or sessionId.',
		consequence: 'The client gets an error reply that becomes an RpcError, or the server caller gets a LiveError. With `realtime({ maskNotFound })` the wire reply becomes UNAUTHENTICATED or FORBIDDEN instead.',
		automaticRecovery: 'None. Unknown-path calls are counted in metrics under one bounded label and are not retried.',
		nextAction: 'Check that the client bundle and server deploy the same live modules and exports. For `live.push`, retry once the user reconnects, or use `live.notify` for best-effort delivery.'
	}),
	OFFLINE_CLEARED: Object.freeze({
		cause: '`clearOffline()` is called for the active offline namespace while queued or replaying mutations are still waiting to settle.',
		consequence: 'Every outstanding queued mutation promise in that namespace rejects with an OFFLINE_CLEARED RpcError. Its stored rows are deleted and the queue starts empty.',
		automaticRecovery: 'None. Cleared mutations are never sent.',
		nextAction: 'Expected during logout or data erasure. Stop accepting edits and await `clearOffline()` before switching accounts. Treat the rejections as intentional, not as failures to report.'
	}),
	OFFLINE_CLEAR_FAILED: Object.freeze({
		cause: '`clearOffline()` cannot fully erase the stored offline queue or checkpoint, because a storage operation fails or rows still remain after deletion.',
		consequence: 'The promise from `clearOffline()` rejects with an OFFLINE_CLEAR_FAILED RpcError with the storage error as `cause`. Waiting callers are still rejected, but stored data may remain on the device.',
		automaticRecovery: 'None. The erasure is not retried automatically.',
		nextAction: 'Inspect `cause` and the browser storage state, then call `clearOffline()` again. Do not report erasure as complete until it resolves.'
	}),
	OFFLINE_SCOPE_CHANGED: Object.freeze({
		cause: '`configure({ offline })` changes the persistence store or `persistKey`, or rebuilds a scope whose stored queue could not be read, while mutations are queued.',
		consequence: 'Every outstanding mutation promise in the previous scope rejects with an OFFLINE_SCOPE_CHANGED RpcError. Rows already stored stay under their own key and are not deleted.',
		automaticRecovery: 'None for the rejected callers. Stored rows are restored only if that same store and `persistKey` are configured again.',
		nextAction: 'Settle or clear the queue before switching identity or storage. Treat these rejections as expected during an account or storage switch.'
	}),
	OVERLOADED: Object.freeze({
		cause: 'A new subscribe to a stream with `classOfService` is shed under a matching `live.admission()` pressure rule, or the pending-upload aggregate byte cap is exceeded while uploads wait for authorization.',
		consequence: 'The subscribe gets an error reply and the stream store goes to its error state with an RpcError. A new upload is refused, or a pending one fails, before its handler completes. Existing subscribers are unaffected.',
		automaticRecovery: 'None for uploads. A shed stream subscribes again only after the next reconnect while it still has subscribers.',
		nextAction: 'Investigate the pressure source (`platform.pressure.reason`) or upload volume. Let clients retry after a short backoff and check the admission class rules.'
	}),
	PAYLOAD_TOO_LARGE: Object.freeze({
		cause: 'Binary RPC headers or upload arguments exceed 65535 bytes or leave no room in the frame, a binary payload exceeds `live.binary` `maxSize` (default 10 MiB), or upload bytes exceed `maxSize` or the pending-phase cap.',
		consequence: 'Client-side checks reject with an RpcError and nothing is sent. Server-side checks abort the call or upload before the handler completes and reply with PAYLOAD_TOO_LARGE.',
		automaticRecovery: 'None. An aborted upload stream cannot be resumed.',
		nextAction: 'Shrink the arguments or payload, or split it. Raise `maxSize` only deliberately, then start a new call or upload.'
	}),
	PROTOCOL_MISMATCH: Object.freeze({
		cause: 'The server has a `protocolVersion` range policy with `onMismatch: \'reject\'`, and the connection advertises a version outside the range, omits it, or changes it mid-connection.',
		consequence: 'RPC, batch and binary calls are refused before application code with an RpcError carrying `protocol` detail. Untyped custom envelopes are dropped. A one-time notice sets `health` to `incompatible`.',
		automaticRecovery: 'None. The incompatible state is sticky for the connection and session.',
		nextAction: 'Reload the client to get a bundle inside the supported range. Operators should keep `minimum` and `current` covering deployed bundles, using `notify` while rolling out.'
	}),
	QUEUE_FULL: Object.freeze({
		cause: 'Queuing an offline mutation pushes the offline queue past `offline.maxQueue` (default 100), so the oldest queued mutation is evicted.',
		consequence: 'The evicted mutation is never sent. Its promise rejects with a QUEUE_FULL RpcError and `offline.onReplayError` is notified with the dropped call.',
		automaticRecovery: 'None. The dropped mutation is not re-queued.',
		nextAction: 'Raise `offline.maxQueue` if long offline periods are expected, coalesce repeated edits, and handle `onReplayError` to tell the user what was lost.'
	}),
	RATE_LIMITED: Object.freeze({
		cause: 'A `live.rateLimit` or registry `rateLimits` bucket is exhausted, the limiter reaches its cap on tracked identities, or a smooth client re-syncs more often than its per-identity window allows.',
		consequence: 'The call is refused before the handler runs. Client and direct-call errors carry `retryAfter` in milliseconds when the limiter supplied it.',
		automaticRecovery: 'None. Buckets refill as their window passes, but refused calls are not retried.',
		nextAction: 'Wait for `retryAfter` before retrying when present. If legitimate traffic is refused, tune points and window or look for clients calling in a loop.'
	}),
	SERVICE_UNAVAILABLE: Object.freeze({
		cause: 'A function wrapped with `live.breaker` is called while its circuit breaker is open and no `fallback` is configured.',
		consequence: 'The call throws a SERVICE_UNAVAILABLE LiveError without running the wrapped function, and the client receives an RpcError. A `breaker.open` operational event is emitted once per open period.',
		automaticRecovery: 'None in this library. Calls pass again once the breaker itself closes on its own reset schedule.',
		nextAction: 'Check the dependency named in the `breaker.open` event. Consider a `fallback` for degraded responses, and retry after a delay.'
	}),
	SOURCE_ERROR: Object.freeze({
		cause: 'The upload source fails while being read on the client, for example a Blob read error or a ReadableStream that errors, with no server response yet.',
		consequence: 'The upload handle rejects with a SOURCE_ERROR RpcError carrying the original error message. A cancel frame is sent so the server discards the partial upload.',
		automaticRecovery: 'None. The upload is not retried.',
		nextAction: 'Check the file or stream source the app passed in, then start a new upload. Show the user that the file could not be read.'
	}),
	STALE: Object.freeze({
		cause: 'During offline replay a queued mutation is older than `offline.maxAge` or its retention, is refused by `beforeReplay` or the `replay` function, or has arguments that cannot be serialized.',
		consequence: 'The mutation is dropped without being sent. Its promise rejects with a STALE RpcError, sometimes with a `cause`, and `offline.onReplayError` is notified.',
		automaticRecovery: 'None. Dropped mutations are not re-queued.',
		nextAction: 'Check `maxAge`, retention, `beforeReplay` and `replay` logic. Make `beforeReplay` synchronous and non-throwing, and surface dropped edits to the user via `onReplayError`.'
	}),
	STREAM_ERROR: Object.freeze({
		cause: 'A stream subscribe fails with an error that is not already an RpcError, or `attach()` sees the stream fail with no recorded error.',
		consequence: 'The stream store enters its error state with a STREAM_ERROR RpcError. Any pending `attach()` rejects with it and later `attach()` calls reject immediately.',
		automaticRecovery: 'The stream subscribes again after the next reconnect while it still has subscribers. Otherwise nothing retries.',
		nextAction: 'Inspect the error message and server logs for the subscribe. Fix the cause, then `detach()` and `attach()` or resubscribe.'
	}),
	TIMEOUT: Object.freeze({
		cause: 'No reply arrives within the timeout for an RPC, batch, binary RPC, stream subscribe, `loadMore` or upload (default 30s via `configure({ timeout })`). On the server, a `live.push` recipient does not answer within `timeoutMs`.',
		consequence: 'The call rejects with an RpcError, or a LiveError for `live.push`. A timed-out upload sends a cancel frame. The server may still have run the request.',
		automaticRecovery: 'None for RPCs, uploads or pushes. A timed-out stream subscribes again after the next reconnect. An offline replay that times out is dropped and reported.',
		nextAction: 'Check server handler latency and connection health, and raise the timeout if the work is legitimately slow. Make non-idempotent calls safe to retry with an idempotency key.'
	}),
	TOO_MANY_UPLOADS: Object.freeze({
		cause: 'A new upload exceeds the per-session limit of uploads awaiting authorization, or the endpoint\'s `maxConcurrentPerSession` or `maxConcurrentTotal` limit.',
		consequence: 'The upload is refused before its handler runs. The client upload handle rejects with a TOO_MANY_UPLOADS RpcError.',
		automaticRecovery: 'None. The refused upload is not queued or retried.',
		nextAction: 'Limit concurrent uploads in the client and wait for active ones to finish. Raise the endpoint concurrency options if the load is legitimate.'
	}),
	UNAUTHENTICATED: Object.freeze({
		cause: 'A guard (`{ authenticated: true }` or a guard that throws a plain error) rejects a connection without an authenticated identity, a document or smooth topic subscribe is denied as unauthenticated, or `maskNotFound` masks an unknown path.',
		consequence: 'The call or subscribe is refused before application code. The caller receives an UNAUTHENTICATED RpcError or LiveError, and streams enter their error state.',
		automaticRecovery: 'None. Calls are not retried after sign-in.',
		nextAction: 'Sign the user in and reconnect so the connection carries an identity with `id`, `user_id` or `userId`. Check the guard and the auth wiring in the upgrade hook.'
	}),
	UNAVAILABLE: Object.freeze({
		cause: 'The server is draining for graceful shutdown, so it rejects new RPC, binary, upload and server-side direct calls.',
		consequence: 'The new call gets an error reply (RpcError on the client), or a server-side direct call throws a LiveError unless a `fallback` is configured. Work already in flight continues.',
		automaticRecovery: 'None for the rejected call. The client reconnects in the normal way once the draining server closes the socket.',
		nextAction: 'Retry after reconnecting to a healthy instance. Pass a `fallback` for direct calls so pages render degraded during deploys.'
	}),
	UNKNOWN: Object.freeze({
		cause: 'An RPC, batch, stream or upload error reply arrives with no `code` field, for example from an incompatible server or a custom handler that writes raw replies.',
		consequence: 'The pending call rejects with an UNKNOWN RpcError using the reply\'s `error` text, or the message `Unknown error` or `Upload failed`. Only the reply\'s `params` and `details` are carried onto the error, plus `issues` on a single RPC; other reply fields are not.',
		automaticRecovery: 'None.',
		nextAction: 'Inspect the raw reply frame in the browser network panel and check the server version. Make sure every error reply includes a code, by throwing a LiveError in handlers.'
	}),
	VALIDATION: Object.freeze({
		cause: 'Arguments fail a `live.validated` or stream-args schema, or a server API is misused: invalid `live.push` or `live.notify` targets or options, alarm, tenant, `ctx.publish` jitter, `ctx.compensate` or `live.breaker` configuration.',
		consequence: 'A VALIDATION LiveError is thrown. Inside a handler it reaches the client as an RpcError with the message and, for schema failures, `issues`. At registration it fails at load time.',
		automaticRecovery: 'None.',
		nextAction: 'For schema failures, fix the input using `issues`. For other messages, correct the server code or configuration the message names and redeploy.'
	})
});

/** @type {Readonly<Record<string, Readonly<Guidance>>>} */
export const EVENT_GUIDANCE = Object.freeze({
	'alarm.execution.failed': Object.freeze({
		cause: 'A room\'s `onAlarm` handler throws or rejects, or the alarm fires with no platform captured. The event is logged after `onError` observers run.',
		consequence: 'That alarm\'s work did not finish, and anything it would have published is missing. With a durable store the execution is kept and marked failed. An in-memory alarm is used up.',
		automaticRecovery: 'None for this alarm. It is not retried, and a durable failed execution waits for an explicit `requeue`. Other alarms and the scheduler keep running.',
		nextAction: 'Fix the handler error shown by your `onError` observer. For durable alarms, check the execution with `getExecution` or `executions`, then call `requeue` with a new `at`, or `complete` to discard it. Make retried effects idempotent with `ctx.alarm.idempotencyKey`.'
	}),
	'alarm.execution.retained': Object.freeze({
		cause: 'After a durable alarm ran, the store\'s `complete` or `fail` call rejected, so the outcome was not recorded.',
		consequence: 'The record may still show as claimed, or a completion may have committed without being acknowledged. The handler may or may not have finished; the `outcome` attribute says whether it succeeded.',
		automaticRecovery: 'None. The callback never runs again on its own, and abandoned claims do not expire.',
		nextAction: 'Fix the store problem. Look up the execution with `getExecution` and check the application side effects. Then call `complete` to discard it, or `requeue` with `allowAbandoned: true` once you have confirmed its worker stopped.'
	}),
	'alarm.recovery.unresolved': Object.freeze({
		cause: 'The recovery poll finds a due durable alarm whose stored id or path matches no registered `onAlarm` handler in this release, or whose id matches more than one handler.',
		consequence: 'The alarm does not run. Its row is kept in the store unclaimed, so no data is lost, but the scheduled work is delayed until a compatible release handles it.',
		automaticRecovery: 'Each later poll skips the row again. It runs automatically once a release that resolves it handles the poll. The event is logged once per id or path.',
		nextAction: 'Restore or rename the stream that declares this alarm id, remove the duplicate id, or roll back to a compatible release. Check the `alarmId`, `path` and `reason` attributes.'
	}),
	'breaker.open': Object.freeze({
		cause: 'A `live.breaker` wrapper finds its breaker open: `guard()` throws `CircuitBrokenError`, or `isOpen()` returns true. This is logged once per open period.',
		consequence: 'The wrapped operation is not run. The caller gets the configured `fallback`, or a SERVICE_UNAVAILABLE error when no fallback is set.',
		automaticRecovery: 'The breaker library decides when to let calls through again. The first call that passes resets the report, so the next open period is logged again.',
		nextAction: 'Investigate the failing dependency behind the breaker named in the `name` attribute. Check that the fallback is acceptable for users while the breaker stays open.'
	}),
	'cron.execution.failed': Object.freeze({
		cause: 'A cron handler throws or rejects during a matching tick, or publishing its return value fails.',
		consequence: 'That tick\'s run is lost and its result is not published. The cron error metrics increase.',
		automaticRecovery: 'None for the failed tick, which is not retried. The job runs again at its next matching slot, and other jobs are not affected.',
		nextAction: 'Fix the handler error recorded under `path` and `error`. If a missed run matters, make the job catch up on its next run or trigger the work manually.'
	}),
	'delivery-authorization.replaced': Object.freeze({
		cause: 'The hooks of a second `realtime()` call, with a different `authorizeDelivery` function or options, run on a worker that already has an active delivery policy.',
		consequence: 'The newer policy decides every frame from then on. The replaced policy is retired for good, and its hooks are refused from then on.',
		automaticRecovery: 'The takeover happens on its own and needs no reinstall. This is expected after a dev reload of `hooks.ws`.',
		nextAction: 'In production, make sure only one `realtime()` call with `authorizeDelivery` has its hooks mounted per worker. In development after a hook reload, no action is needed.'
	}),
	'delivery-authorization.stale': Object.freeze({
		cause: 'A hook from a `realtime()` call whose delivery policy a newer policy has retired runs again. This is logged once per platform.',
		consequence: 'Each connection reaching such a hook is closed with code 1011 and is not served. For a retired call, `init` throws.',
		automaticRecovery: 'None for the retired call, which never takes back over. Clients served by the active policy are not affected, and closed clients can reconnect.',
		nextAction: 'Remove the stale `realtime()` hooks so that only the active call\'s hooks are exported, or restart the server.'
	}),
	'delivery-authorization.unavailable': Object.freeze({
		cause: 'A hook tries to install the configured `authorizeDelivery` policy and fails, typically because the adapter has no `platform.authorizeDelivery` or because `deliveryAuthorizationOptions` differ from the installed ones. This is logged once per platform.',
		consequence: 'The connection is closed with code 1011 before realtime serves it. No unchecked frames are delivered.',
		automaticRecovery: 'Every later hook tries the install again, but a lasting cause keeps closing connections.',
		nextAction: 'Upgrade svelte-adapter-uws to a release that provides `platform.authorizeDelivery`, or remove `authorizeDelivery`. If the options changed, restart the server. Check the `error` attribute.'
	}),
	'delivery-authorization.unguarded': Object.freeze({
		cause: 'Neither `init` nor `open` from the `realtime()` call ran first, so a `message`, `unsubscribe` or `close` hook installed the delivery policy. This is logged once per platform.',
		consequence: 'That connection was open before any policy existed and may already have received unchecked frames. It is still served, and every frame after the install is checked.',
		automaticRecovery: 'The policy stays installed and is applied to all later frames. Frames sent before the install are not checked afterwards.',
		nextAction: 'Export `init` (or at least `open`) from the same `realtime()` call that configures `authorizeDelivery`.'
	}),
	'direct-call.fallback.used': Object.freeze({
		cause: 'A server-side direct call to a live function, such as a `.load()` from SSR, throws during the guard, validation, loader or filter, and the call was given a `fallback` option.',
		consequence: 'The caller gets the configured fallback instead of real data, so the rendered page shows placeholder content for that stream. The original error is not rethrown.',
		automaticRecovery: 'None for this call. The next direct call runs the function again from the start.',
		nextAction: 'Fix the error reported in the `error` attribute for `path`. Make sure the fallback value renders sensibly. Use `onError` if you need the raw error.'
	}),
	'forget.incomplete': Object.freeze({
		cause: '`live.forget` attempted every erasure surface and at least one in-memory surface, named document or the durable store failed. The surfaces are listed in `failedSurfaces`.',
		consequence: 'The user\'s data may still exist on the listed surfaces. The call rejects with FORGET_INCOMPLETE, or FORGET_STORE_FAILED when the durable store failed. `onForget` does not run.',
		automaticRecovery: 'None. The erasure is not retried automatically, although owner changes the store already committed are still announced. With a job store the `job` attribute names the job recorded as failed.',
		nextAction: 'Fix the failing surface: a missing dead-letter `purgeUser`, a missing aggregate reset policy, or a store outage. Then call `live.forget` again with the same user and tenant, or `resumeForgetJobs()` with a job store.'
	}),
	'forget.job-unrecorded': Object.freeze({
		cause: 'An erasure run finished, completed or failed, but the job store wired with `configureForget({ jobs })` threw or rejected when its outcome was recorded. The `job` attribute is the job reference and `outcome` the result that was not recorded.',
		consequence: 'The erasure result returned to the caller is accurate, but the job stays unfinished in the store and still holds the user id until a later run completes it.',
		automaticRecovery: 'None. The job is run again by the next `resumeForgetJobs()` call, which repeats the idempotent cascade.',
		nextAction: 'Fix the job store, then call `resumeForgetJobs()` so the job reaches a recorded outcome.'
	}),
	'forget.owner-succession-unannounced': Object.freeze({
		cause: 'The erasure store reports room owner changes caused by the erasure, but there is no erasure platform and no captured server platform to publish them through.',
		consequence: 'The owner changes are committed in the store, but subscribers on the rooms\' owner topics are not told about the new owner and may keep showing the erased owner. The erasure itself is not affected.',
		automaticRecovery: 'None. Running the erasure again does not re-announce these changes, because the store already committed them.',
		nextAction: 'Configure `configureForget({ platform })`, or initialize the server before running erasures, for example on a separate erasure runner. Have affected clients reload the rooms; the `count` attribute says how many changes went unannounced.'
	}),
	'invariant.violated': Object.freeze({
		cause: 'An internal runtime consistency check fails. Severity warn marks a recoverable violation; fatal marks state that could deliver messages to the wrong place. The message is the category name.',
		consequence: 'Warn: the violation is counted and processing continues. Fatal: on the server the worker exits with code 78 once the current callback finishes, and its connections drop.',
		automaticRecovery: 'Warn: none needed, processing continues. Fatal: none within the process; recovery depends on the process supervisor restarting the worker.',
		nextAction: 'Restart a worker that exited with code 78. Record the category, its context and the `svelte_realtime_assertion_violations_total` metric, and report them to the maintainers with the versions you run.'
	}),
	'operational.sink.failed': Object.freeze({
		cause: 'The sink installed with `setOperationalEventSink` throws or rejects while handling an operational event.',
		consequence: 'The original event is written to the console instead, so it is not lost, but it does not reach your logger or collector.',
		automaticRecovery: 'The sink stays installed, and every later event is sent to it again. Console fallback applies only to events that fail.',
		nextAction: 'Fix the sink so it never throws or rejects. Check the `originalSource` and `originalEvent` attributes to find the events your collector missed.'
	}),
	'poll.tick.failed': Object.freeze({
		cause: 'A `live.poll` callback throws, or the promise it returns rejects, on one interval tick.',
		consequence: 'The work of that tick is lost and anything it would have published is missing for that interval.',
		automaticRecovery: 'The interval stays active and calls the callback again at the next tick.',
		nextAction: 'Fix the callback error shown in the `error` attribute. If the data source supports it, replace polling with `live.stream` and `invalidateOn`, `live.derived` or `live.alarm`.'
	}),
	'reactive.derived.failed': Object.freeze({
		cause: 'Recomputing a `live.derived` stream throws after a source event, in its compute function, its middleware or while publishing the result.',
		consequence: 'No new value is published for the `topic`. Subscribers keep the last value they received, which may now be out of date.',
		automaticRecovery: 'If another source event arrived during the failed run, it recomputes immediately. Otherwise the next source event triggers a recompute.',
		nextAction: 'Fix the compute error reported in the `error` attribute. Check that the source streams return data in the shape the derived function expects.'
	}),
	'rpc.module.load-failed': Object.freeze({
		cause: 'Loading the live module behind a called path threw, for example a syntax error saved in development or a module whose top level throws. A path whose handler is already loaded serves the call directly and never reaches this event.',
		consequence: 'The call is answered INTERNAL_ERROR with a generic message; the load error stays on the server in the `error` attribute. Each distinct error message is reported once per path while fewer than 256 paths and messages are tracked; past that bound every failure is reported.',
		automaticRecovery: 'The entry stays lazy, so the next call loads the module again. In development a saved fix loads on that next call. In production Node caches the failed import, so every later call fails the same way until the process restarts.',
		nextAction: 'Fix the module named by the `path` attribute using the `error` attribute. In development, save the corrected file; in production, deploy the fix and restart the process.'
	}),
	'reactive.effect.failed': Object.freeze({
		cause: 'A `live.effect` handler throws or rejects while running for a publish on one of its watched source topics.',
		consequence: 'The side effect for that publish did not complete. The publish itself and delivery to subscribers are not affected. The global `onError` handler, if set, receives the error with path \'effect\'.',
		automaticRecovery: 'None for the failed event; it is not retried. The effect stays registered and runs again on the next publish to its source topic.',
		nextAction: 'Fix the effect handler using the `error` attribute. Make the effect idempotent or add your own retry if a missed run matters. Effects run on every replica, so leader-gate side effects that must run once.'
	}),
	'rpc.binary-header.parse-failed': Object.freeze({
		cause: 'A frame starting with the binary RPC marker has a header that is not valid JSON or cannot be decoded. Emitted only in development (`NODE_ENV` not \'production\').',
		consequence: 'The frame is not treated as an RPC and gets no RPC response. It falls through to custom message handling such as `onUnhandled`, and the calling client waits until its RPC timeout rejects with TIMEOUT.',
		automaticRecovery: 'None. The frame is not retried or answered.',
		nextAction: 'Check the client that sends binary calls. Use the shipped client or match its wire framing exactly; a hand-built or mismatched client is the usual cause.'
	}),
	'rpc.binary.execution-failed': Object.freeze({
		cause: 'A `live.binary` handler, its guard, `beforeExecute`, or a middleware throws something that is not a LiveError.',
		consequence: 'The call fails. The client gets INTERNAL_ERROR with a generic message and the request id; the raw error is hidden from the client. The `onError` option, if set, receives the error.',
		automaticRecovery: 'None. The call is not retried by the server.',
		nextAction: 'Use the logged path, requestId and error to fix the handler. Throw a LiveError with a specific code for expected failures so clients get a meaningful code.'
	}),
	'rpc.execution.failed-after-answer': Object.freeze({
		cause: 'A middleware answered an RPC before the handler chain finished (it returned an envelope or threw without waiting for `next()`), and the chain failed later.',
		consequence: 'The client already has the middleware\'s answer and never sees this failure. Work the handler did before failing may be partly applied. The `onError` option is not called for this failure.',
		automaticRecovery: 'None. Shutdown drain tracks the still-running chain until it settles; the failure is reported only through this event.',
		nextAction: 'Make middleware await `next()` before answering, or make the handler safe to stop part-way. Look into the error name and code logged with the path.'
	}),
	'rpc.execution.non-live-error': Object.freeze({
		cause: 'A text, batch or stream RPC handler, guard, or middleware throws something that is not a LiveError.',
		consequence: 'The call fails with INTERNAL_ERROR and a generic message plus the request id; the raw error stays on the server. A stream subscribe made by that call is rolled back.',
		automaticRecovery: 'None on the server. The `onError` option, if set, receives the error. Retrying is up to the client.',
		nextAction: 'Use the path, requestId and error to fix the bug. Throw a LiveError with a specific code for expected failures such as validation or missing records.'
	}),
	'rpc.middleware.next-after-answer': Object.freeze({
		cause: 'A middleware calls `next()` after the RPC already has an answer, for example from a timer or after returning its own envelope.',
		consequence: 'The rest of the chain does not run: inner middleware, guard and handler are skipped for that late call, and that `next()` returns a rejected promise. The client keeps the answer it already got.',
		automaticRecovery: 'None needed. The late `next()` is refused so the handler cannot run twice or after the answer.',
		nextAction: 'Fix the middleware at the logged path so it calls `next()` once, before deciding the answer, and does not defer it.'
	}),
	'rpc.path.not-found': Object.freeze({
		cause: 'A text, batch, binary or upload call names a path with no registered live function. Emitted only in development.',
		consequence: 'The call is refused with NOT_FOUND, or with FORBIDDEN or UNAUTHENTICATED under `maskNotFound`. Metrics record it under a bounded unknown label.',
		automaticRecovery: 'None. The call is answered with the refusal and not retried.',
		nextAction: 'Check that the client and server builds match and that the module exporting the function is registered. Look for typos in the path or a renamed export.'
	}),
	'rpc.response.large': Object.freeze({
		cause: 'An RPC response carries an array of more than 5000 items or a string longer than 800000 characters. This is a development-only size estimate.',
		consequence: 'The response is still sent unchanged; this check does not block or trim it. A payload that large risks exceeding the configured `maxPayloadLength` and slows clients.',
		automaticRecovery: 'None needed; the warning does not change delivery.',
		nextAction: 'Paginate, stream, or trim the response. If it is legitimately large, raise the adapter `maxPayloadLength` on purpose.'
	}),
	'rpc.response.undelivered': Object.freeze({
		cause: 'Sending an RPC response hits backpressure, or the send throws because the socket closed mid-call. Emitted only in development.',
		consequence: 'On backpressure the response is buffered and may arrive late. If the socket closed, the client does not get it and its call rejects on disconnect or timeout. Delivery metrics record the outcome.',
		automaticRecovery: 'None for this response. Buffered data drains when the socket allows; a closed socket\'s response is discarded.',
		nextAction: 'Usually a normal disconnect during a call. If it is frequent, check for slow consumers, oversized responses, and the backpressure and delivery metrics.'
	}),
	'rpc.schema.migration-missing': Object.freeze({
		cause: 'A versioned response is migrated from an older client schema version, and no migration function exists for one version step. Emitted only in development.',
		consequence: 'That step is skipped; the data goes through unchanged for it and later steps still run. The client may get data in a shape its version does not expect.',
		automaticRecovery: 'None. The missing step is skipped every time.',
		nextAction: 'Add a migration function for each version step from the oldest supported client version to the current one. The logged fromVersion and toVersion name the gap.'
	}),
	'rpc.volatile.unmarked': Object.freeze({
		cause: 'A fire-and-forget call (no id, from `fireAndForget`) reaches a handler not wrapped in `live.volatile()`. Emitted only in development, once per path, for a bounded number of paths.',
		consequence: 'The handler still runs with the full chain, but no response is sent. Its return value and any error never reach the client; server-side failure events still fire.',
		automaticRecovery: 'None. Later fire-and-forget calls to the same path run the same way without another warning.',
		nextAction: 'Wrap the handler in `live.volatile()` if fire-and-forget is intended. Otherwise change the client to a normal call so it gets the result and errors.'
	}),
	'shutdown.drain.timed-out': Object.freeze({
		cause: 'During graceful shutdown, tracked in-flight work (RPCs and other tracked handlers) is still running when the drain budget ends: the largest `onShutdown` `drainMs`, default 5000 ms.',
		consequence: 'Teardown goes ahead with work still running; `remaining` gives the count. Those calls may be cut off and their responses lost. New calls have already been refused with UNAVAILABLE.',
		automaticRecovery: 'None. `onShutdown` handlers still run and receive the drain outcome; the adapter `SHUTDOWN_TIMEOUT` is the hard cap.',
		nextAction: 'Find long-running handlers, or raise `drainMs` while keeping it below the adapter shutdown timeout. Make interrupted work safe to retry, for example with `live.idempotent`.'
	}),
	'upload.execution.failed': Object.freeze({
		cause: 'A `live.upload` handler, its guard, `beforeExecute`, or a middleware throws something that is not a LiveError, including a middleware that returns without calling `next()` or a failure envelope.',
		consequence: 'The upload fails. The client gets INTERNAL_ERROR with a generic message, queued chunk bytes are released, and the upload stream is aborted. The `onError` option, if set, receives the error.',
		automaticRecovery: 'None. The upload is not resumed or retried by the server.',
		nextAction: 'Fix the handler or middleware at the logged path. Throw a LiveError with a specific code for expected refusals; the client must retry the upload itself.'
	}),
	'upload.middleware.next-after-answer': Object.freeze({
		cause: 'A middleware calls `next()` after the server already answered the upload. It is not emitted when the client ended the upload by cancelling.',
		consequence: 'The rest of the chain does not run: inner middleware, guard and handler are skipped for that late call, and that `next()` returns a rejected promise. The client keeps the answer it already got.',
		automaticRecovery: 'None needed. The late `next()` is refused so the handler cannot run after the answer.',
		nextAction: 'Fix the middleware at the logged path so it calls `next()` once, before deciding the answer, and does not defer it.'
	}),
	'webhook.dead-letter.persist-failed': Object.freeze({
		cause: 'An outbound webhook delivery has already failed, and the configured dead-letter store throws or rejects on every attempt to add the failed record, or reports a key conflict.',
		consequence: 'The record was the only replay copy, so this webhook event is lost for good. The `svelte_realtime_webhook_dead_letter_failures_total` counter goes up.',
		automaticRecovery: 'A keyed write is repeated twice, after 100 ms and 500 ms, before this event fires; the key keeps a write that landed without a reply from being stored twice. Content JSON cannot encode is written once, and a key conflict is not repeated.',
		nextAction: 'Check the dead-letter store backend (connection, capacity, permissions). Alert on the failure counter. Rebuild lost events from your own source data if they matter.'
	}),
	'webhook.delivery.failed': Object.freeze({
		cause: 'An outbound webhook uses up its delivery policy (retries, budget, or open breaker), or is blocked by the SSRF gate, a payload limit, or a redirect.',
		consequence: 'The event did not reach the endpoint. `onFailure`, or the global `onError` if there is none, is called. With the dead-letter queue enabled the event is kept; otherwise it is dropped.',
		automaticRecovery: 'None after this point. Dead-lettered events stay until replayed through `replayDeadLetter()` or the admin plane.',
		nextAction: 'Check endpoint health and the logged error and attempts. Once it recovers, replay with `replayDeadLetter()`. Enable `webhooks: { deadLetter: true }` if events must not be lost.'
	})
});
