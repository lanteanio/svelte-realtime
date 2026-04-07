# Changelog

All notable changes to `svelte-realtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.8] - 2026-04-07

### Fixed

- `live()`, `live.stream()`, `live.channel()`, `live.binary()`, `live.rateLimit()`, `live.validated()`, `middleware()`, guards, rooms, pipes, and `compose()` now accept `LiveContext<UserData>` in callback signatures. Previously, annotating `ctx` as anything other than `LiveContext` (default `LiveContext<unknown>`) caused a TypeScript error due to contravariant parameter checking.
- Generated `$types.d.ts` declarations now use `StreamStore<T>` instead of `Readable<T>` for stream, channel, derived, and aggregate exports. This exposes `.hydrate()`, `.optimistic()`, `.loadMore()`, and other `StreamStore` methods in autocomplete and type checking.
- Generated `$types.d.ts` declarations now include a `.load()` method type on all stream-like exports, matching the runtime SSR stubs. `messages.load(platform)` in `+page.server.ts` no longer requires a type assertion.

## [0.4.7] - 2026-04-02

### Fixed

- Added missing type declarations for `unsubscribe`, `onError`, `live.metrics`, `live.breaker` in `server.d.ts` and `onDerived` in `client.d.ts`. These exports existed at runtime since 0.4.0 but were absent from the `.d.ts` files, causing "has no exported member" errors in TypeScript projects.

## [0.4.6] - 2026-03-22

### Changed

- Added docs site branding to README and replaced inline error URLs with svti.me short URLs across client, server, and vite plugin error messages.

## [0.4.5] - 2026-03-20

### Fixed

- Batched stream subscribes (multiple streams subscribing in the same microtask) now correctly receive their topic, merge strategy, and initial data. The batch response handler was resolving stream entries with `result.data` instead of the full response envelope, so the topic subscription was never created and initial data was lost.

## [0.4.4] - 2026-03-20

### Fixed

- Streams using `set` or `latest` merge strategies now receive live events after reconnection. Server-provided stream options (merge, key, prepend, max) were applied after the delta sync `unchanged` early return, so reconnecting clients kept the default `crud` merge and silently dropped events.

## [0.4.3] - 2026-03-20

### Fixed

- CLI scaffolder: fixed missing `package.json` file reference, added `--no-add-ons` and `--no-install` flags to `sv create` to prevent interactive prompts hanging under `stdio: pipe`, and updated stale vite config template.

## [0.4.2] - 2026-03-20

### Fixed

- CLI scaffolder: fixed failure on Windows where `sv create` prompted interactively and hung because `stdio: pipe` swallowed the prompts, causing the project directory to never be created.

## [0.4.1] - 2026-03-20

### Fixed

- Added missing `cli-utils.js` to package.json `files` array, fixing `npx svelte-realtime` failing with a module-not-found error.

---

## [0.4.0] - 2026-03-20

### Breaking Changes

#### Package

- **Peer dependency changed from `svelte-adapter-uws >=0.2.0` to `>=0.4.0`.** Core adapter must be upgraded first.
- **Version bumped from 0.1.9 to 0.4.0** to align with the adapter release.

#### Server Hooks

- **New `unsubscribe` hook must be exported from `hooks.ws.js`.** Previously only `message` and `close` were needed. Now export all three: `export { message, close, unsubscribe } from 'svelte-realtime/server';`. The `unsubscribe` hook fires in real time when a client drops a topic (adapter 0.4.0+). **Action:** add the `unsubscribe` export to your `hooks.ws.js`.
- **`close` hook signature changed.** Now receives `{ platform, subscriptions }` instead of `{ platform }`. The `subscriptions` parameter is the Set of topics still active at disconnect time. Existing code that destructures only `platform` is unaffected.
- **`close` hook only fires `onUnsubscribe` for topics still active at disconnect time.** Previously it fired for all topics tracked in an internal map. Now the `unsubscribe` hook handles real-time topic drops; `close` only handles remaining topics. There is no double-firing.

#### Room API

- **`live.room()` with actions now requires `topicArgs` config option.** Previously the room inferred the argument count from `topicFn.length`. Now you must explicitly set `topicArgs` to the number of room-identifying args (excluding `ctx`). **Action:** add `topicArgs: N` to your room config if you use actions.
- **`onLeave` callback signature changed.** Now receives `(ctx, topic)` instead of `(ctx)`. **Action:** update your `onLeave` handlers to accept the topic parameter.
- **`onJoin` now runs after `initFn` succeeds.** Previously `onJoin` ran before `initFn`. If `initFn` throws, `onJoin` is not called (prevents orphaned side effects).

#### Validation

- **`live.validated()` now rejects unrecognized schema types.** Previously it passed input through without validation and logged a dev warning. Now it returns an error. Only Zod (`.safeParse`) and Valibot (`._run`) are supported. **Action:** ensure you are using a supported validation library.

#### Error Handling

- **`onCronError()` is deprecated.** Use `onError()` instead. `onCronError` still works but delegates to the same handler. `onError` covers cron, effects, and derived stream errors.

#### Client

- **`__binaryRpc` now accepts `ArrayBuffer | ArrayBufferView`** instead of just `ArrayBuffer`. Not breaking for callers passing `ArrayBuffer`, but the type signature changed.
- **Stream reconnect backoff changed.** Old: fixed 50-200ms random delay. New: first two attempts use 20-100ms, then exponential backoff up to 5 minutes with jitter. Observable timing difference, not an API change.
- **`batch()` listener merged into the main RPC listener.** The separate `ensureBatchListener()` function was removed. Batch responses are now handled inside the main `__rpc` topic subscriber. No API change, but internal wiring is different.

### Added

#### CLI Scaffolding

- **`npx svelte-realtime my-app`** -- interactive project scaffolder. Creates a SvelteKit project with adapter, vite plugins, WebSocket hooks, and a working counter example.

#### Server API

- `ctx.batch(messages)` -- publish multiple messages in one call via `platform.batch()`.
- `live.metrics(registry)` -- opt-in Prometheus metrics for RPC calls, stream subscriptions, and cron executions.
- `live.breaker(options, fn)` -- circuit breaker wrapper. When open, returns a fallback value or throws `SERVICE_UNAVAILABLE`.
- `onError(handler)` -- global error handler for server-side errors (cron, effects, derived streams). Replaces `onCronError`.
- `unsubscribe` export from `svelte-realtime/server` -- ready-made unsubscribe hook for `hooks.ws.js`.
- Room `.hooks` property -- one-liner wiring: `export const { message, close, unsubscribe } = myRoom.hooks;`.

#### Client API

- `onDerived` re-exported from `svelte-adapter-uws/client` -- reactive derived topic subscription.
- `configure({ timeout })` -- configurable RPC timeout (default 30s).
- Terminal close code handling -- codes 1008, 4401, 4403 stop reconnection. After terminal close, all pending RPCs reject with `CONNECTION_CLOSED`, stream stores receive `{ error }`, and the offline queue is drained with errors.
- Device sleep detection -- if a timeout fires >90s after its scheduled time, assumes device was sleeping and rejects with `DISCONNECTED` instead of `TIMEOUT`.
- Microtask-batched stream subscribes -- multiple subscribe RPCs within one microtask are sent as a single batch frame.

#### Stream Enhancements

- Replay truncation handling -- when the replay extension sends `{ reqId, truncated: true }`, the client resets its sequence number and triggers a full refetch.
- Server-provided stream options (merge, key, prepend, max) are now applied BEFORE processing diffs/replay, ensuring the correct merge strategy is used from the start.
- `unchanged` response now drains buffered events after re-subscribing to the topic.
- Topic listener is attached BEFORE flipping `initialLoaded`, preventing events from being dropped during the window between server-side `ws.subscribe(topic)` and client-side listener setup.

#### Validation

- Reserved topic prefix `__` is now rejected at definition time for `live.stream()` and `live.channel()`.
- Async topic functions are rejected at definition time with a clear error message.
- Binary RPC header size validated (rejects >65535 bytes with `PAYLOAD_TOO_LARGE`).

#### Documentation (README)

- Quick start section with `npx svelte-realtime my-app`.
- `ctx.batch()` documentation and server-side batching example.
- Terminal close codes section.
- Prometheus metrics section.
- Circuit breaker section.
- Tauri and Capacitor integration guide.
- Room hooks shortcut documentation.
- Replay truncation handling documentation.

### Changed (Under the Hood)

#### Performance

- **Swap-remove for array deletions** in crud, presence, and cursor merge strategies. Replaces `Array.splice()` + index rewrite (O(n)) with O(1) swap-and-truncate. Applies to both client stores and benchmarks.
- **Double-buffer swap pattern** for RAF event batching. Reuses two pre-allocated arrays per frame instead of allocating new ones.
- **RAF dedup** for idempotent events (updated, update, join). Within a single frame, keeps only the last event per entity key.
- **Reusable binary frame buffer** for binary RPC calls. Grows by 2x to avoid frequent reallocation.
- **Ring buffer for devtools history** (O(1) insertion instead of array.shift).
- **O(1) stream cache eviction** using an evictable set instead of full cache scan.
- **Deferred stream cleanup via queueMicrotask** prevents thrashing on rapid unsubscribe+resubscribe cycles.
- **Overflow dedupe map** for stream cache -- active stores that exceed the main cache limit are tracked separately.
- Dedupe key encoding uses typed prefixes (`S`, `#`, `B`, `N`, `U`) to avoid ambiguity between types.
- `_dirty` flag skips store.set when merge produces no change (e.g. `set` merge with identical value).
- Cron field parser accepts field index for better error messages.
- `_copyStreamMeta()` consolidates metadata copying for `gate()`, `pipe()`, and wrappers.
- `_buildCtx()` factory ensures monomorphic V8 hidden class for ctx objects.
- `_propagateRateLimitPath()` walks wrapper chains (validated → rateLimit) to set path on nested wrappers.
- Rate limit identity uses stable per-connection guest IDs instead of `'anon'` for unauthenticated users.
- Rate limit hard cap only applies to new buckets -- existing identities always pass through.
- Stream history recording skips arrays >200 items to avoid excessive memory.
- Aggregate `__registerAggregate` hydrates snapshot asynchronously at registration time.

#### Reliability

- Stream subscription rollback (`_rollbackStreamSubscribe`) -- if `initFn` throws after `ws.subscribe(topic)`, the subscription is undone and `onUnsubscribe` fires.
- Per-socket stream ownership tracking (`_wsStreamOwners`) with refcounting replaces the old `_dynamicSubscriptions` WeakMap.
- Room presence uses per-topic+userId refcounting with grace period timers to handle multi-tab scenarios without phantom leaves.
- Reconnect attempts tracked per stream with exponential backoff (base 2.2, max 5min, 25% jitter). Reset on successful fetch.
- Vite plugin: `_warnUnsafeExports()` checks for export names with characters invalid in RPC paths.
- Vite plugin: improved stream option extraction with proper brace/bracket/string parsing.

---

## [0.1.9] and earlier

See [git history](../../commits/main) for changes prior to 0.4.0.
