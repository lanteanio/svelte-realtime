# Runtime error reference

This file is generated from the runtime-owned registry and a runtime source inventory. Do not edit it by hand.
The registry-backed messages below preserve the documented prefix and append their stable ID plus this package-local help route.

| Stable ID | Runtime code | Event | Message prefix |
|---|---|---|---|
| `REALTIME-ERR-INVALID-USER-ID` | `INVALID_USER_ID` | `ctx.signal.invalid-user-id` | `ctx.signal:` |
| `REALTIME-ERR-LIVE-RESOLVE` | - | `vite.live.resolve-failed` | `[svelte-realtime] Could not resolve $live/` |
| `REALTIME-ERR-UPLOAD-START-LIMIT` | `PAYLOAD_TOO_LARGE` | `upload.pending-size.exceeded` | `upload exceeds limit during start` |
| `REALTIME-ERR-UPLOAD-MAX-SIZE` | `PAYLOAD_TOO_LARGE` | `upload.max-size.exceeded` | `upload exceeds maxSize` |

<a id="realtime-err-invalid-user-id"></a>
## `REALTIME-ERR-INVALID-USER-ID`

- Runtime code: `INVALID_USER_ID`
- Event: `ctx.signal.invalid-user-id`
- Message prefix: `ctx.signal:`
- Cause: ctx.signal(userId, ...) received a value that is not a non-empty string of at most 256 characters, or it contains a control character, double quote, or backslash.
- Consequence: The signal is not published and the caller receives an INVALID_USER_ID LiveError.
- Automatic recovery: None; malformed identity input is not retried.
- Next action: Pass the canonical validated user ID used by enableSignals(). Do not retry the same malformed value.
- Runtime help: `docs/errors.md#realtime-err-invalid-user-id`
- Runtime sources: [`src/server/ctx.js`](../src/server/ctx.js)

<a id="realtime-err-live-resolve"></a>
## `REALTIME-ERR-LIVE-RESOLVE`

- Runtime code: none (build diagnostic)
- Event: `vite.live.resolve-failed`
- Message prefix: `[svelte-realtime] Could not resolve $live/`
- Cause: A $live/<module> virtual import has no matching JavaScript or TypeScript file under the configured live directory.
- Consequence: The requested virtual module cannot load, so development or the build stops at that import.
- Automatic recovery: Vite resolves the import again after the module graph changes or the command is rerun.
- Next action: Correct the import path, add the matching live module, or configure the live directory.
- Runtime help: `docs/errors.md#realtime-err-live-resolve`
- Runtime sources: [`src/vite/plugin.js`](../src/vite/plugin.js)

<a id="realtime-err-upload-start-limit"></a>
## `REALTIME-ERR-UPLOAD-START-LIMIT`

- Runtime code: `PAYLOAD_TOO_LARGE`
- Event: `upload.pending-size.exceeded`
- Message prefix: `upload exceeds limit during start`
- Cause: Upload bytes crossed the protected pending-phase cap before the endpoint handler and its options finished resolving.
- Consequence: The upload is aborted before its endpoint handler begins and returns PAYLOAD_TOO_LARGE.
- Automatic recovery: None; the aborted stream cannot be resumed.
- Next action: Reduce the initial or pending upload volume and retry with a new stream.
- Runtime help: `docs/errors.md#realtime-err-upload-start-limit`
- Runtime sources: [`src/server/upload.js`](../src/server/upload.js)

<a id="realtime-err-upload-max-size"></a>
## `REALTIME-ERR-UPLOAD-MAX-SIZE`

- Runtime code: `PAYLOAD_TOO_LARGE`
- Event: `upload.max-size.exceeded`
- Message prefix: `upload exceeds maxSize`
- Cause: The received upload bytes exceeded the maxSize configured by the resolved upload handler.
- Consequence: The upload is aborted and returns PAYLOAD_TOO_LARGE without invoking or completing the handler.
- Automatic recovery: None; the aborted stream cannot be resumed.
- Next action: Reduce the upload or deliberately raise the audited maxSize, then start a new upload.
- Runtime help: `docs/errors.md#realtime-err-upload-max-size`
- Runtime sources: [`src/server/upload.js`](../src/server/upload.js)

## Emitted error coverage

Coverage listing only: the scanner inventories direct LiveError constructors with literal codes, error reply objects, structured diagnostic events, and console warning/error prefixes in src/**/*.js. Comments and example declarations are excluded. It does not infer causes or safe recovery actions from strings.

Full cause, consequence, recovery and next-action guidance above covers 4 registered events (2 distinct runtime codes). The source inventory below currently finds 29 literal runtime codes and 111 operational event/prefix entries. A code appearing here does not mean every occurrence has full guidance.

Code anchors stay stable when messages change. Structured diagnostic IDs use the emitted event; legacy console IDs are derived from the literal prefix and change when that prefix changes. These coverage IDs are documentation anchors, not IDs appended to legacy runtime messages. Escaped \n and \r in the listing stand for actual newlines and carriage returns.

<a id="live-error-alarm-capacity"></a>
### <code>ALARM_CAPACITY</code>

- Searchable message prefixes: <code>[svelte-realtime] alarm registry reached its pending alarm limit</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="live-error-cancelled"></a>
### <code>CANCELLED</code>

- Searchable message prefixes: <code>upload cancelled</code>
- Owning sources: [src/server/upload.js](../src/server/upload.js)

<a id="live-error-connection-closed"></a>
### <code>CONNECTION_CLOSED</code>

- Searchable message prefixes: <code>WebSocket closed</code>; <code>WebSocket closed during document sync</code>; <code>WebSocket closed during smooth sync</code>
- Owning sources: [src/server/crdt.js](../src/server/crdt.js), [src/server/dispatch.js](../src/server/dispatch.js), [src/server/smooth.js](../src/server/smooth.js)

<a id="live-error-disconnected"></a>
### <code>DISCONNECTED</code>

- Searchable message prefixes: <code>WebSocket connection lost</code>; <code>connection closed</code>
- Owning sources: [src/server/upload.js](../src/server/upload.js), [src/testing.js](../src/testing.js)

<a id="live-error-forbidden"></a>
### <code>FORBIDDEN</code>

- Searchable message prefixes: <code>Authentication required</code>; <code>Derived scope changed; resubscribe to receive the current view</code>; <code>Room action '</code>; <code>Room membership is being erased</code>; <code>document read denied</code>; <code>document topic subscribe denied: </code>; <code>smooth topic subscribe denied: </code>
- Owning sources: [src/server/crdt.js](../src/server/crdt.js), [src/server/dispatch.js](../src/server/dispatch.js), [src/server/room.js](../src/server/room.js), [src/server/smooth.js](../src/server/smooth.js)

<a id="live-error-forget-incomplete"></a>
### <code>FORGET_INCOMPLETE</code>

- Searchable message prefixes: <code>Erasure is incomplete; resolve failed cleanup surfaces and retry</code>
- Owning sources: [src/server/forget.js](../src/server/forget.js)

<a id="live-error-forget-store-failed"></a>
### <code>FORGET_STORE_FAILED</code>

- Searchable message prefixes: <code>live.forget: durable store.purgeUser failed; the erasure is incomplete and must be retried</code>
- Owning sources: [src/server/forget.js](../src/server/forget.js)

<a id="live-error-idempotency-capacity"></a>
### <code>IDEMPOTENCY_CAPACITY</code>

- Searchable message prefixes: <code>The idempotency store is full; the handler has not run. Retry after capacity becomes available.</code>
- Owning sources: [src/server/idempotency.js](../src/server/idempotency.js)

<a id="live-error-idempotency-commit-unknown"></a>
### <code>IDEMPOTENCY_COMMIT_UNKNOWN</code>

- Searchable message prefixes: <code>the idempotency record could not be confirmed committed after the handler ran; the effect may have applied - reconcile before retrying rather than re-running</code>
- Owning sources: [src/server/idempotency.js](../src/server/idempotency.js)

<a id="live-error-idempotency-in-progress"></a>
### <code>IDEMPOTENCY_IN_PROGRESS</code>

- Searchable message prefixes: <code>The original request is still in progress; retry with the same idempotency key.</code>
- Owning sources: [src/server/idempotency.js](../src/server/idempotency.js)

<a id="live-error-idempotency-key-reused"></a>
### <code>IDEMPOTENCY_KEY_REUSED</code>

- Searchable message prefixes: <code>idempotency key reused with a different request payload; the same key must always carry the same request</code>
- Owning sources: [src/server/idempotency.js](../src/server/idempotency.js)

<a id="live-error-internal"></a>
### <code>INTERNAL</code>

- Searchable message prefixes: <code>document load failed for "</code>; <code>live.doc() failed to load the adapter CRDT plugin: </code>; <code>live.doc() requires svelte-adapter-uws 0.6.0-next.25 or newer (the CRDT replica plugin is missing from the installed adapter)</code>; <code>live.smooth() failed to load the adapter smooth plugin: </code>; <code>live.smooth() onTick requires svelte-adapter-uws 0.6.0-next.47 or newer (the installed adapter authority has no server-entity surface)</code>; <code>live.smooth() requires svelte-adapter-uws 0.6.0-next.24 or newer (the smooth plugin is missing from the installed adapter)</code>; <code>live.tenant(...).publish requires an active server platform; call it after the realtime server is wired (inside a handler use ctx.tenant(id).publish instead).</code>
- Owning sources: [src/server.js](../src/server.js), [src/server/crdt.js](../src/server/crdt.js), [src/server/smooth.js](../src/server/smooth.js)

<a id="live-error-internal-error"></a>
### <code>INTERNAL_ERROR</code>

- Searchable message prefixes: <code>Internal server error</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js), [src/server/upload.js](../src/server/upload.js)

<a id="live-error-invalid-arg"></a>
### <code>INVALID_ARG</code>

- Searchable message prefixes: <code>ctx.skip: key must be a string (got </code>; <code>ctx.skip: ms must be a positive finite number (got </code>
- Owning sources: [src/server/publish-helpers.js](../src/server/publish-helpers.js)

<a id="live-error-invalid-request"></a>
### <code>INVALID_REQUEST</code>

- Searchable message prefixes: <code>Batch exceeds maximum of </code>; <code>Each batch entry requires rpc and id</code>; <code>Invalid path</code>; <code>Not a binary endpoint</code>; <code>Not an upload endpoint</code>; <code>Reserved topic prefix</code>; <code>Topic function must return a string, got </code>; <code>args must be an array</code>; <code>idempotencyKey must be a string no longer than 256 characters</code>; <code>live.derived() scopeKey must return a string or finite number synchronously</code>; <code>live.forget(userId) requires a non-empty userId string</code>; <code>live.forget(userId, opts): opts must be an object</code>; <code>live.forget: </code>; <code>live.forget: cascade must be a boolean or an object ({ crdt?: string[] })</code>; <code>live.forget: cascade.crdt must be an array of non-empty document topic names</code>; <code>live.forget: hashKey must be a string or Uint8Array containing at least 32 bytes, or null</code>; <code>live.forget: onForget must be a function</code>; <code>streamId already active</code>
- Owning sources: [src/server.js](../src/server.js), [src/server/derived-topic.js](../src/server/derived-topic.js), [src/server/dispatch.js](../src/server/dispatch.js), [src/server/forget.js](../src/server/forget.js), [src/server/idempotency.js](../src/server/idempotency.js), [src/server/upload.js](../src/server/upload.js)

<a id="live-error-invalid-topic"></a>
### <code>INVALID_TOPIC</code>

- Searchable message prefixes: <code>ctx.publish() refuses '__'-prefixed topics; those are reserved for </code>; <code>tenant.publish() refuses '__'-prefixed topics (framework-internal channels).</code>
- Owning sources: [src/server/ctx.js](../src/server/ctx.js), [src/server/tenant.js](../src/server/tenant.js)

<a id="live-error-invalid-user-id"></a>
### <code>INVALID_USER_ID</code>

- Searchable message prefixes: <code>ctx.signal:</code>
- Owning sources: [src/server/ctx.js](../src/server/ctx.js)

<a id="live-error-lock-timeout"></a>
### <code>LOCK_TIMEOUT</code>

- Searchable message prefixes: dynamic (inspect the owning source).
- Owning sources: [src/server/idempotency.js](../src/server/idempotency.js)

<a id="live-error-not-found"></a>
### <code>NOT_FOUND</code>

- Searchable message prefixes: <code>Live function '</code>; <code>Not found</code>; <code>no active connection for </code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js), [src/server/push.js](../src/server/push.js)

<a id="live-error-overloaded"></a>
### <code>OVERLOADED</code>

- Searchable message prefixes: <code>Stream class '</code>; <code>pending-upload aggregate buffer cap exceeded; retry shortly</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js), [src/server/upload.js](../src/server/upload.js)

<a id="live-error-payload-too-large"></a>
### <code>PAYLOAD_TOO_LARGE</code>

- Searchable message prefixes: <code>Binary RPC header exceeds 65535 bytes</code>; <code>Binary payload exceeds size limit</code>; <code>upload exceeds maxSize</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js), [src/server/upload.js](../src/server/upload.js), [src/testing.js](../src/testing.js)

<a id="live-error-protocol-mismatch"></a>
### <code>PROTOCOL_MISMATCH</code>

- Searchable message prefixes: dynamic (inspect the owning source).
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="live-error-rate-limited"></a>
### <code>RATE_LIMITED</code>

- Searchable message prefixes: <code>Too many concurrent rate-limit identities</code>; <code>Too many requests</code>; <code>smooth re-sync rate exceeded (max </code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js), [src/server/rate-limit.js](../src/server/rate-limit.js), [src/server/smooth.js](../src/server/smooth.js)

<a id="live-error-service-unavailable"></a>
### <code>SERVICE_UNAVAILABLE</code>

- Searchable message prefixes: <code>Service is temporarily unavailable, try again shortly</code>
- Owning sources: [src/server/breaker.js](../src/server/breaker.js)

<a id="live-error-timeout"></a>
### <code>TIMEOUT</code>

- Searchable message prefixes: dynamic (inspect the owning source).
- Owning sources: [src/server/push.js](../src/server/push.js)

<a id="live-error-too-many-uploads"></a>
### <code>TOO_MANY_UPLOADS</code>

- Searchable message prefixes: <code>too many concurrent uploads</code>; <code>too many concurrent uploads on this session</code>; <code>too many uploads awaiting authorization on this session</code>
- Owning sources: [src/server/upload.js](../src/server/upload.js)

<a id="live-error-unauthenticated"></a>
### <code>UNAUTHENTICATED</code>

- Searchable message prefixes: <code>Authentication required</code>; <code>document read denied</code>; <code>document topic subscribe denied: </code>; <code>smooth topic subscribe denied: </code>
- Owning sources: [src/server/crdt.js](../src/server/crdt.js), [src/server/dispatch.js](../src/server/dispatch.js), [src/server/smooth.js](../src/server/smooth.js)

<a id="live-error-unavailable"></a>
### <code>UNAVAILABLE</code>

- Searchable message prefixes: <code>Server is shutting down</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js), [src/server/upload.js](../src/server/upload.js)

<a id="live-error-validation"></a>
### <code>VALIDATION</code>

- Searchable message prefixes: <code>[svelte-realtime] </code>; <code>[svelte-realtime] alarm tenant metadata must match its wire topic</code>; <code>[svelte-realtime] ctx.publish jitterMs must be a finite number of milliseconds in [0, 60000]</code>; <code>[svelte-realtime] ctx.setAlarm / ctx.getAlarm / ctx.deleteAlarm require a live.stream (or live.room) declared with an { alarm: { onAlarm } } config.</code>; <code>[svelte-realtime] ctx.setAlarm(at): at must be a finite epoch-ms number</code>; <code>[svelte-realtime] live.notify: event must be a non-empty string</code>; <code>[svelte-realtime] live.notify: target must be an object like { userId }</code>; <code>[svelte-realtime] live.push({ topic }): requires a captured platform with requestTopic (svelte-adapter-uws &gt;= 0.6.0-next.39). Wire `realtime({ ... }).init` from your hooks.ws.js init({ platform }) hook.</code>; <code>[svelte-realtime] live.push: event must be a non-empty string</code>; <code>[svelte-realtime] live.push: options must be an object</code>; <code>[svelte-realtime] live.push: options.timeoutMs must be a positive finite number. For fire-and-forget delivery, use `live.notify(target, event, data)` instead.</code>; <code>[svelte-realtime] live.push: target must be an object like { userId }</code>; <code>ctx.compensate requires a live.room with a history config: live.room({ history: { capture } })</code>; <code>ctx.compensate requires an eval function: ctx.compensate(commandTime, (state, meta) =&gt; ...)</code>; <code>live.tenant(id, config): </code>; <code>realtime({ tenant }) must be a function (user) =&gt; id &#124; null, or null to disable.</code>; <code>tenant id must be a non-empty string of [a-zA-Z0-9_-], at most </code>
- Owning sources: [src/server.js](../src/server.js), [src/server/alarm.js](../src/server/alarm.js), [src/server/ctx.js](../src/server/ctx.js), [src/server/dispatch.js](../src/server/dispatch.js), [src/server/history-compensation.js](../src/server/history-compensation.js), [src/server/push.js](../src/server/push.js), [src/server/room.js](../src/server/room.js), [src/server/tenant.js](../src/server/tenant.js)

## Operational prefix index

<a id="diagnostic-alarm.execution.failed"></a>
### <code>alarm.execution.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>An alarm handler failed; the scheduler remains active.</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-alarm.execution.retained"></a>
### <code>alarm.execution.retained</code>

- Kind: structured event
- Searchable message prefixes: <code>An alarm execution outcome could not be confirmed; inspect retained executions before retrying.</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-alarm.recovery.unresolved"></a>
### <code>alarm.recovery.unresolved</code>

- Kind: structured event
- Searchable message prefixes: <code>A durable alarm could not be resolved by this release and was retained.</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-breaker.open"></a>
### <code>breaker.open</code>

- Kind: structured event
- Searchable message prefixes: <code>A circuit breaker refused an operation.</code>
- Owning sources: [src/server/breaker.js](../src/server/breaker.js)

<a id="diagnostic-console-0274ff6d72692365"></a>
### <code>console-0274ff6d72692365</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.poll: polling is an anti-pattern in a push system - it burns work on unchanged data </code>
- Owning sources: [src/server/metrics.js](../src/server/metrics.js)

<a id="diagnostic-console-02ec5040c6f4f2c3"></a>
### <code>console-02ec5040c6f4f2c3</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.smooth() onTick threw; the tick continues without its remaining changes.</code>
- Owning sources: [src/server/smooth.js](../src/server/smooth.js)

<a id="diagnostic-console-0365d9d45ffb3afa"></a>
### <code>console-0365d9d45ffb3afa</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] volatile RPC '</code>
- Owning sources: [src/client/rpc.js](../src/client/rpc.js)

<a id="diagnostic-console-06e4b752d0cc0678"></a>
### <code>console-06e4b752d0cc0678</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configure({ url, auth }) is ignored once the connection has closed for good; reload the page to connect again.</code>
- Owning sources: [src/client/misc.js](../src/client/misc.js)

<a id="diagnostic-console-0746db52cc0430fe"></a>
### <code>console-0746db52cc0430fe</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] history capture threw; suppressing further capture errors for this room:</code>
- Owning sources: [src/server/room.js](../src/server/room.js)

<a id="diagnostic-console-0b23d8593070b306"></a>
### <code>console-0b23d8593070b306</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] a pendingMutations or uploading subscriber threw:</code>
- Owning sources: [src/client/offline.js](../src/client/offline.js)

<a id="diagnostic-console-11e05923113b502c"></a>
### <code>console-11e05923113b502c</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.multiplayer(): dropping a cursor sample, presence field or reaction from a connection that is not a member of the room.\n</code>
- Owning sources: [src/server/multiplayer.js](../src/server/multiplayer.js)

<a id="diagnostic-console-1233b1ca8d58f7a1"></a>
### <code>console-1233b1ca8d58f7a1</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] this client is running an outdated bundle (protocol v</code>
- Owning sources: [src/client/health.js](../src/client/health.js)

<a id="diagnostic-console-14ce29cbde69565d"></a>
### <code>console-14ce29cbde69565d</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] piiRedact factory topic pattern "</code>
- Owning sources: [src/server.js](../src/server.js)

<a id="diagnostic-console-1516b209b7578320"></a>
### <code>console-1516b209b7578320</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.derived() subscribed but _activateDerived(platform) was never called. Derived streams will not receive live updates.\n  Call _activateDerived(platform) in your WebSocket open hook.\n  See: https://svti.me/derived</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-console-15f40cc0857960ec"></a>
### <code>console-15f40cc0857960ec</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.notify: platform.request is not available; requires svelte-adapter-uws &gt;= 0.5.0-next.4. Notify dispatch silently no-op.\n  See: https://svti.me/migration</code>
- Owning sources: [src/server/push.js](../src/server/push.js)

<a id="diagnostic-console-1822cda756774727"></a>
### <code>console-1822cda756774727</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] shortCodes() called without a secret: using a per-process random key.\n</code>
- Owning sources: [src/server.js](../src/server.js)

<a id="diagnostic-console-1bbe42540d181bbf"></a>
### <code>console-1bbe42540d181bbf</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] presence-ref map reached MAX_PRESENCE_REF=</code>
- Owning sources: [src/server/room.js](../src/server/room.js)

<a id="diagnostic-console-1dc7889670e1e58f"></a>
### <code>console-1dc7889670e1e58f</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configureCron leader function threw; skipping tick:</code>
- Owning sources: [src/server/cron-engine.js](../src/server/cron-engine.js)

<a id="diagnostic-console-23356a071f573450"></a>
### <code>console-23356a071f573450</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] shutdown: cron scheduler stop threw (ignored):</code>
- Owning sources: [src/server/lifecycle.js](../src/server/lifecycle.js)

<a id="diagnostic-console-25b4ab0d77ce079a"></a>
### <code>console-25b4ab0d77ce079a</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] offline.beforeReplay threw, so the call is dropped as STALE, with the error as the cause of its rejection.</code>
- Owning sources: [src/client/misc.js](../src/client/misc.js)

<a id="diagnostic-console-29bd4ef4f2bc5e47"></a>
### <code>console-29bd4ef4f2bc5e47</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.room enumerable(ctx, room): this platform exposes no forEachSubscriber/send, so per-caller lobby deltas are dropped (snapshots still filter). Upgrade svelte-adapter-uws.\n  See: https://svti.me/rooms</code>
- Owning sources: [src/server/rooms-gate.js](../src/server/rooms-gate.js)

<a id="diagnostic-console-2b1cf037b0a0a405"></a>
### <code>console-2b1cf037b0a0a405</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configure({ upload: { frameSize: </code>
- Owning sources: [src/client/upload.js](../src/client/upload.js)

<a id="diagnostic-console-30eb2ca52b529920"></a>
### <code>console-30eb2ca52b529920</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] ctx.skip: gate map at capacity (</code>
- Owning sources: [src/server/publish-helpers.js](../src/server/publish-helpers.js)

<a id="diagnostic-console-3249efb3f4a23883"></a>
### <code>console-3249efb3f4a23883</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.aggregate '</code>
- Owning sources: [src/server/reactive.js](../src/server/reactive.js)

<a id="diagnostic-console-335f8041ee68bb78"></a>
### <code>console-335f8041ee68bb78</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime]</code>
- Owning sources: [src/cli.js](../src/cli.js)

<a id="diagnostic-console-37b6671f8ac29751"></a>
### <code>console-37b6671f8ac29751</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] HMR preparation failed:</code>
- Owning sources: [src/vite/hmr.js](../src/vite/hmr.js)

<a id="diagnostic-console-37edf855bed9cc35"></a>
### <code>console-37edf855bed9cc35</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] offline.beforeReplay returned a promise; it must answer synchronously, so the call is dropped as STALE.</code>
- Owning sources: [src/client/misc.js](../src/client/misc.js)

<a id="diagnostic-console-3ea1c89fa774ba20"></a>
### <code>console-3ea1c89fa774ba20</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] replay.publish('</code>
- Owning sources: [src/server/replay-routing.js](../src/server/replay-routing.js)

<a id="diagnostic-console-42d832659e8f57b3"></a>
### <code>console-42d832659e8f57b3</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] alarm store due() failed; skipping poll:</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-console-43e70f5bef41ad41"></a>
### <code>console-43e70f5bef41ad41</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Dynamic derived sourceFactory returned empty sources for topic '</code>
- Owning sources: [src/server/reactive.js](../src/server/reactive.js)

<a id="diagnostic-console-4421d68e14fcce05"></a>
### <code>console-4421d68e14fcce05</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Room action '</code>
- Owning sources: [src/server/room.js](../src/server/room.js)

<a id="diagnostic-console-46d9c5ae7816563e"></a>
### <code>console-46d9c5ae7816563e</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] .map() expects an array source; got </code>
- Owning sources: [src/client/stream.js](../src/client/stream.js)

<a id="diagnostic-console-4738ab81c4b7df0b"></a>
### <code>console-4738ab81c4b7df0b</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] offline persistence unavailable: the stored queue could not be read, so queued mutations stay in memory for this page (they will not survive a reload).</code>
- Owning sources: [src/client/offline.js](../src/client/offline.js)

<a id="diagnostic-console-493c4ae061156399"></a>
### <code>console-493c4ae061156399</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] HMR failed for </code>
- Owning sources: [src/vite/hmr.js](../src/vite/hmr.js)

<a id="diagnostic-console-49a24df4aa47fb93"></a>
### <code>console-49a24df4aa47fb93</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] push session registry reached MAX_PUSH_REGISTRY=</code>
- Owning sources: [src/server/push.js](../src/server/push.js)

<a id="diagnostic-console-4c964c84d15afe13"></a>
### <code>console-4c964c84d15afe13</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Registry reload failed:</code>
- Owning sources: [src/vite/plugin.js](../src/vite/plugin.js)

<a id="diagnostic-console-516af4d24765e7e0"></a>
### <code>console-516af4d24765e7e0</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Malformed upload control frame; dropping\n  See: https://svti.me/uploads</code>
- Owning sources: [src/server/upload.js](../src/server/upload.js)

<a id="diagnostic-console-519031c4c41d003f"></a>
### <code>console-519031c4c41d003f</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] createMessage({ platform: callback }) is redundant when `setBus(...)` is wired: </code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-console-5861c9238fa01b16"></a>
### <code>console-5861c9238fa01b16</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] offline.replay </code>
- Owning sources: [src/client/misc.js](../src/client/misc.js)

<a id="diagnostic-console-586fedf951585d8e"></a>
### <code>console-586fedf951585d8e</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.smooth() is running on a platform without the binary wire (publishWire/sendWire). </code>
- Owning sources: [src/server/smooth.js](../src/server/smooth.js)

<a id="diagnostic-console-5a5bfe7136073131"></a>
### <code>console-5a5bfe7136073131</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] hydrate('</code>
- Owning sources: [src/client/stream.js](../src/client/stream.js)

<a id="diagnostic-console-5b78bf44568a33cd"></a>
### <code>console-5b78bf44568a33cd</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.forget onForget hook threw (erasure already completed):</code>
- Owning sources: [src/server/forget.js](../src/server/forget.js)

<a id="diagnostic-console-62249ba994397115"></a>
### <code>console-62249ba994397115</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] ctx.debounce is deprecated -- rename to ctx.publishDebounced. </code>
- Owning sources: [src/server/ctx.js](../src/server/ctx.js)

<a id="diagnostic-console-62b975d3d07ddbbf"></a>
### <code>console-62b975d3d07ddbbf</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] multiplayer.</code>
- Owning sources: [src/client/rpc.js](../src/client/rpc.js)

<a id="diagnostic-console-651cda4ce579965f"></a>
### <code>console-651cda4ce579965f</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] onShutdown handler threw (ignored):</code>
- Owning sources: [src/server/lifecycle.js](../src/server/lifecycle.js)

<a id="diagnostic-console-691098df0803f33e"></a>
### <code>console-691098df0803f33e</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Malformed upload chunk frame; dropping\n  See: https://svti.me/uploads</code>
- Owning sources: [src/server/upload.js](../src/server/upload.js)

<a id="diagnostic-console-6c8ba92373647887"></a>
### <code>console-6c8ba92373647887</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Could not load svelte-realtime/server for direct registration</code>
- Owning sources: [src/vite/hmr.js](../src/vite/hmr.js)

<a id="diagnostic-console-6e6cc2afc2bf1be5"></a>
### <code>console-6e6cc2afc2bf1be5</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] upload '</code>
- Owning sources: [src/client/upload.js](../src/client/upload.js)

<a id="diagnostic-console-7392f5f0019904da"></a>
### <code>console-7392f5f0019904da</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] two </code>
- Owning sources: [src/server/crdt.js](../src/server/crdt.js)

<a id="diagnostic-console-7745ed6100cc9950"></a>
### <code>console-7745ed6100cc9950</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.access.owner() denied a connection whose identity lives in `</code>
- Owning sources: [src/server.js](../src/server.js)

<a id="diagnostic-console-849bc8d2f8b4e612"></a>
### <code>console-849bc8d2f8b4e612</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] ctx.</code>
- Owning sources: [src/server/publish-helpers.js](../src/server/publish-helpers.js)

<a id="diagnostic-console-84f6515fcb5d6e67"></a>
### <code>console-84f6515fcb5d6e67</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] session id is present but unusable (</code>
- Owning sources: [src/server/identity.js](../src/server/identity.js)

<a id="diagnostic-console-86bb3177b83ab2bb"></a>
### <code>console-86bb3177b83ab2bb</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configure({ upload: { chunkSize } }) is deprecated -- </code>
- Owning sources: [src/client/upload.js](../src/client/upload.js)

<a id="diagnostic-console-8d33a16463d3e3d5"></a>
### <code>console-8d33a16463d3e3d5</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Scaffolding requires Node 22.12 or newer; found </code>
- Owning sources: [src/cli.js](../src/cli.js)

<a id="diagnostic-console-8d46208763a20c24"></a>
### <code>console-8d46208763a20c24</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Topic '</code>
- Owning sources: [src/client/rpc.js](../src/client/rpc.js), [src/server/dev-warnings.js](../src/server/dev-warnings.js)

<a id="diagnostic-console-8dc7b08db6615b46"></a>
### <code>console-8dc7b08db6615b46</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Found live modules in </code>
- Owning sources: [src/vite/codegen-registry.js](../src/vite/codegen-registry.js)

<a id="diagnostic-console-91c8f3951c812ffb"></a>
### <code>console-91c8f3951c812ffb</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.forget announce-on-failure threw:</code>
- Owning sources: [src/server/forget.js](../src/server/forget.js)

<a id="diagnostic-console-95ba163d492eb177"></a>
### <code>console-95ba163d492eb177</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configureAlarm: the wired store has no due(nowMs); cross-restart alarm recovery is disabled.\n</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-console-962f29fe230dd488"></a>
### <code>console-962f29fe230dd488</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Previous handlers restored - fix the error and save again</code>
- Owning sources: [src/vite/hmr.js](../src/vite/hmr.js)

<a id="diagnostic-console-9858817c22756392"></a>
### <code>console-9858817c22756392</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] push registry reached MAX_PUSH_REGISTRY=</code>
- Owning sources: [src/server/push.js](../src/server/push.js)

<a id="diagnostic-console-a1e0ae32b3b7a768"></a>
### <code>console-a1e0ae32b3b7a768</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] this connection is protocol-incompatible (reason=</code>
- Owning sources: [src/client/health.js](../src/client/health.js)

<a id="diagnostic-console-a22d519a7f226ea9"></a>
### <code>console-a22d519a7f226ea9</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] recovered alarm for "</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-console-a49c0a20f6a9c9b1"></a>
### <code>console-a49c0a20f6a9c9b1</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configuration error found after lazy registration:\n</code>
- Owning sources: [src/server/lazy.js](../src/server/lazy.js)

<a id="diagnostic-console-a4c8d035e94c0b55"></a>
### <code>console-a4c8d035e94c0b55</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] topic-subscribers index reached TOPIC_WS_COUNTS_WARN_THRESHOLD=</code>
- Owning sources: [src/server.js](../src/server.js)

<a id="diagnostic-console-a558e6ae90c4f5fd"></a>
### <code>console-a558e6ae90c4f5fd</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Failed to load </code>
- Owning sources: [src/vite/hmr.js](../src/vite/hmr.js)

<a id="diagnostic-console-a8707e2bbfa50b9c"></a>
### <code>console-a8707e2bbfa50b9c</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.smooth() onTick world.ensure(</code>
- Owning sources: [src/server/smooth.js](../src/server/smooth.js)

<a id="diagnostic-console-a98871290804193a"></a>
### <code>console-a98871290804193a</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Failed to resolve lazy registration for '</code>
- Owning sources: [src/server/lazy.js](../src/server/lazy.js)

<a id="diagnostic-console-abe1841e9f718cd6"></a>
### <code>console-abe1841e9f718cd6</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.stream('</code>
- Owning sources: [src/server/replay-routing.js](../src/server/replay-routing.js)

<a id="diagnostic-console-acd0f1ca200684fa"></a>
### <code>console-acd0f1ca200684fa</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.notify({ topic }): no topicBroadcast or requestTopic available (requires svelte-adapter-uws &gt;= 0.6.0-next.39); broadcast silently no-op.</code>
- Owning sources: [src/server/push.js](../src/server/push.js)

<a id="diagnostic-console-addc8311bad3edf9"></a>
### <code>console-addc8311bad3edf9</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] ctx.throttle is deprecated -- rename to ctx.publishThrottled. </code>
- Owning sources: [src/server/ctx.js](../src/server/ctx.js)

<a id="diagnostic-console-b6a44fe589230eab"></a>
### <code>console-b6a44fe589230eab</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] stream </code>
- Owning sources: [src/client/stream.js](../src/client/stream.js)

<a id="diagnostic-console-b916433f3d6f9d51"></a>
### <code>console-b916433f3d6f9d51</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] </code>
- Owning sources: [src/client-multiplayer.svelte.js](../src/client-multiplayer.svelte.js), [src/client/connection.js](../src/client/connection.js), [src/client/misc.js](../src/client/misc.js), [src/server/crdt.js](../src/server/crdt.js), [src/vite/codegen-client.js](../src/vite/codegen-client.js), [src/vite/codegen-registry.js](../src/vite/codegen-registry.js), [src/vite/extract-options.js](../src/vite/extract-options.js), [src/vite/scanner.js](../src/vite/scanner.js)

<a id="diagnostic-console-bb7b7e0245add39b"></a>
### <code>console-bb7b7e0245add39b</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] offline.onReplayError threw; the error is ignored. Cause: </code>
- Owning sources: [src/client/offline.js](../src/client/offline.js)

<a id="diagnostic-console-bf7b7c187b539e56"></a>
### <code>console-bf7b7c187b539e56</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.multiplayer(): dropping a sticky presence field - </code>
- Owning sources: [src/server/multiplayer.js](../src/server/multiplayer.js)

<a id="diagnostic-console-c2c9c6bd910c9f27"></a>
### <code>console-c2c9c6bd910c9f27</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Plugin loaded but no live modules found in </code>
- Owning sources: [src/vite/plugin.js](../src/vite/plugin.js)

<a id="diagnostic-console-c9dd8bf0e9fca34c"></a>
### <code>console-c9dd8bf0e9fca34c</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] offline persistence </code>
- Owning sources: [src/client/offline-store.js](../src/client/offline-store.js)

<a id="diagnostic-console-cc1701951a9f46d1"></a>
### <code>console-cc1701951a9f46d1</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] RPC '</code>
- Owning sources: [src/client/rpc.js](../src/client/rpc.js)

<a id="diagnostic-console-d468d2e3224b4205"></a>
### <code>console-d468d2e3224b4205</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Unknown upload control type 0x</code>
- Owning sources: [src/server/upload.js](../src/server/upload.js)

<a id="diagnostic-console-d88ef0a30181e73c"></a>
### <code>console-d88ef0a30181e73c</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configureAlarm leader threw; skipping alarm poll:</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-console-df99584def0e6759"></a>
### <code>console-df99584def0e6759</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] configureCron({ leader }) was set without a `bus`. </code>
- Owning sources: [src/server/cron-engine.js](../src/server/cron-engine.js)

<a id="diagnostic-console-dffd59596aafec43"></a>
### <code>console-dffd59596aafec43</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] live.aggregate privacy.contributor returned null/undefined; </code>
- Owning sources: [src/server/differential-privacy.js](../src/server/differential-privacy.js)

<a id="diagnostic-console-e00961beb2955243"></a>
### <code>console-e00961beb2955243</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] alarm for "</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-console-e0f74ad4b2b8ade5"></a>
### <code>console-e0f74ad4b2b8ade5</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] offline.replay returned </code>
- Owning sources: [src/client/misc.js](../src/client/misc.js)

<a id="diagnostic-console-f5719a054dc009d6"></a>
### <code>console-f5719a054dc009d6</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] the stored offline upload checkpoint could not be read, so it is not updated for this page; the queue itself is stored as usual.</code>
- Owning sources: [src/client/offline.js](../src/client/offline.js)

<a id="diagnostic-console-f5fc1ae61f41dc5c"></a>
### <code>console-f5fc1ae61f41dc5c</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] Cron registered but no platform captured. Wire setCronPlatform(platform) from your hooks.ws.js init({ platform }) hook (svelte-adapter-uws &gt;= 0.5.0-next.15) or from your open(ws, platform) hook on older adapters.\n  See: https://svti.me/cron</code>
- Owning sources: [src/server/cron-engine.js](../src/server/cron-engine.js)

<a id="diagnostic-console-f5fc5a13136f6e36"></a>
### <code>console-f5fc5a13136f6e36</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] WebSocket opened then closed in </code>
- Owning sources: [src/client/connection.js](../src/client/connection.js)

<a id="diagnostic-console-f6febc75e4b0cb48"></a>
### <code>console-f6febc75e4b0cb48</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] a piiRedact factory topic has NO cluster-transient redaction coverage - </code>
- Owning sources: [src/server.js](../src/server.js)

<a id="diagnostic-console-f77e91c9de419373"></a>
### <code>console-f77e91c9de419373</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] coalesced two or more identical calls to '</code>
- Owning sources: [src/client/rpc.js](../src/client/rpc.js)

<a id="diagnostic-console-f80ca298a546b653"></a>
### <code>console-f80ca298a546b653</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] alarm fired but no platform captured. Wire setCronPlatform(platform) from your hooks.ws.js init({ platform }) hook.</code>
- Owning sources: [src/server/alarm.js](../src/server/alarm.js)

<a id="diagnostic-console-fd513f887587622a"></a>
### <code>console-fd513f887587622a</code>

- Kind: legacy console prefix
- Searchable message prefixes: <code>[svelte-realtime] HMR failed: could not load svelte-realtime/server\n  See: https://svti.me/vite</code>
- Owning sources: [src/vite/hmr.js](../src/vite/hmr.js)

<a id="diagnostic-cron.execution.failed"></a>
### <code>cron.execution.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>A cron handler failed; the scheduler remains active.</code>
- Owning sources: [src/server/cron-engine.js](../src/server/cron-engine.js)

<a id="diagnostic-direct-call.fallback.used"></a>
### <code>direct-call.fallback.used</code>

- Kind: structured event
- Searchable message prefixes: <code>A direct live-function call failed and returned its configured fallback.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-forget.incomplete"></a>
### <code>forget.incomplete</code>

- Kind: structured event
- Searchable message prefixes: <code>Erasure could not be confirmed for every configured surface; resolve the failed cleanup and retry.</code>
- Owning sources: [src/server/forget.js](../src/server/forget.js)

<a id="diagnostic-invariant.violated"></a>
### <code>invariant.violated</code>

- Kind: structured event
- Searchable message prefixes: dynamic (search the event ID).
- Owning sources: [src/shared/assert.js](../src/shared/assert.js)

<a id="diagnostic-operational.sink.failed"></a>
### <code>operational.sink.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>The configured operational event sink failed; console fallback was restored for this event.</code>
- Owning sources: [src/shared/diagnostic.js](../src/shared/diagnostic.js)

<a id="diagnostic-poll.tick.failed"></a>
### <code>poll.tick.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>A live.poll callback rejected; the interval remains active.</code>; <code>A live.poll callback threw; the interval remains active.</code>
- Owning sources: [src/server/metrics.js](../src/server/metrics.js)

<a id="diagnostic-reactive.derived.failed"></a>
### <code>reactive.derived.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>A derived stream recomputation failed; later source events may retry it.</code>
- Owning sources: [src/server/reactive.js](../src/server/reactive.js)

<a id="diagnostic-reactive.effect.failed"></a>
### <code>reactive.effect.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>A reactive effect handler failed.</code>
- Owning sources: [src/server/reactive.js](../src/server/reactive.js)

<a id="diagnostic-rpc.binary-header.parse-failed"></a>
### <code>rpc.binary-header.parse-failed</code>

- Kind: structured event
- Searchable message prefixes: <code>A binary RPC header could not be parsed.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-rpc.binary.execution-failed"></a>
### <code>rpc.binary.execution-failed</code>

- Kind: structured event
- Searchable message prefixes: <code>A binary RPC handler failed.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-rpc.execution.non-live-error"></a>
### <code>rpc.execution.non-live-error</code>

- Kind: structured event
- Searchable message prefixes: <code>An RPC handler threw a non-LiveError; raw errors are hidden from clients.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-rpc.path.not-found"></a>
### <code>rpc.path.not-found</code>

- Kind: structured event
- Searchable message prefixes: <code>An RPC call did not match a registered live function.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-rpc.response.large"></a>
### <code>rpc.response.large</code>

- Kind: structured event
- Searchable message prefixes: <code>An RPC response may exceed maxPayloadLength.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-rpc.response.undelivered"></a>
### <code>rpc.response.undelivered</code>

- Kind: structured event
- Searchable message prefixes: <code>An RPC response was not delivered.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-rpc.schema.migration-missing"></a>
### <code>rpc.schema.migration-missing</code>

- Kind: structured event
- Searchable message prefixes: <code>An RPC schema migration function is missing.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-rpc.volatile.unmarked"></a>
### <code>rpc.volatile.unmarked</code>

- Kind: structured event
- Searchable message prefixes: <code>A fire-and-forget call reached a handler that is not marked live.volatile(); errors will be silently dropped.</code>
- Owning sources: [src/server/dispatch.js](../src/server/dispatch.js)

<a id="diagnostic-shutdown.drain.completed"></a>
### <code>shutdown.drain.completed</code>

- Kind: structured event
- Searchable message prefixes: <code>Shutdown drain budget expired with tracked handlers still active.</code>; <code>Shutdown tracked handlers drained before teardown.</code>
- Owning sources: [src/server/lifecycle.js](../src/server/lifecycle.js)

<a id="diagnostic-shutdown.drain.timed-out"></a>
### <code>shutdown.drain.timed-out</code>

- Kind: structured event
- Searchable message prefixes: <code>Shutdown drain budget expired with tracked handlers still active.</code>; <code>Shutdown tracked handlers drained before teardown.</code>
- Owning sources: [src/server/lifecycle.js](../src/server/lifecycle.js)

<a id="diagnostic-upload.execution.failed"></a>
### <code>upload.execution.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>An upload handler failed; the client received an internal error.</code>
- Owning sources: [src/server/upload.js](../src/server/upload.js)

<a id="diagnostic-webhook.dead-letter.persist-failed"></a>
### <code>webhook.dead-letter.persist-failed</code>

- Kind: structured event
- Searchable message prefixes: <code>A failed webhook could not be persisted to the dead-letter store.</code>
- Owning sources: [src/server/webhook-out.js](../src/server/webhook-out.js)

<a id="diagnostic-webhook.delivery.failed"></a>
### <code>webhook.delivery.failed</code>

- Kind: structured event
- Searchable message prefixes: <code>An outbound webhook exhausted its delivery policy.</code>
- Owning sources: [src/server/webhook-out.js](../src/server/webhook-out.js)

## Dynamic emission sites

These sites have a computed code, event, or message prefix that the literal scanner cannot resolve. They remain visible here instead of being counted as full literal coverage. Wire forwarding and application-provided messages may vary at runtime.

- <code>src/hooks.js:57</code>
- <code>src/server.js:1909</code>
- <code>src/server.js:2884</code>
- <code>src/server/ctx.js:113</code>
- <code>src/server/dispatch.js:1263</code>
- <code>src/server/dispatch.js:1374</code>
- <code>src/server/dispatch.js:1613</code>
- <code>src/server/dispatch.js:1630</code>
- <code>src/server/dispatch.js:172</code>
- <code>src/server/dispatch.js:358</code>
- <code>src/server/dispatch.js:392</code>
- <code>src/server/dispatch.js:699</code>
- <code>src/server/dispatch.js:799</code>
- <code>src/server/dispatch.js:811</code>
- <code>src/server/dispatch.js:858</code>
- <code>src/server/idempotency.js:865</code>
- <code>src/server/push.js:699</code>
- <code>src/server/upload.js:281</code>
- <code>src/server/upload.js:386</code>
- <code>src/server/upload.js:388</code>
- <code>src/server/upload.js:715</code>
- <code>src/shared/assert.js:120</code>
- <code>src/shared/assert.js:75</code>
- <code>src/shared/diagnostic-format.js:40</code>
- <code>src/testing.js:590</code>
- <code>src/testing.js:700</code>
- <code>src/testing.js:775</code>
